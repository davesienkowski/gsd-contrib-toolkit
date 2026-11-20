#!/usr/bin/env node
'use strict';

/**
 * hooks/emitted-cjs-read.cjs - PreToolUse(Read) emitted-cjs read guard (ENF-26, quick 261119-szk,
 * CTK-ADR-0017 Proposed).
 *
 * WHAT IT DOES. gsd-core compiles `src/**\/*.cts` to gitignored `gsd-core/bin/lib/**\/*.cjs` (ADR-457;
 * tsconfig.build.json: rootDir src, outDir gsd-core/bin/lib). Reading the emitted copy puts tsc output
 * into context instead of the authored source. This hook denies a Read of such a file and names the
 * `.cts` twin to read instead. It steers context; it does not block a contribution outcome.
 *
 * WHEN IT DENIES. Only when BOTH signals hold for the Read target:
 *   (a) the twin `<root>/src/<rel minus .cjs>.cts` is a regular file, where <root> is the gsd-core
 *       checkout hooks/lib/resolve.cjs `resolveGsdCoreRoot` finds above the target and <rel> is the
 *       target's path below <root>/gsd-core/bin/lib (compared as realpaths), and
 *   (b) git reports the target ignored (generated), through binlib-edit's repository-PINNED
 *       `checkIgnoreLive` (no `.git` entry between the target and bin/, a toplevel strictly above bin/
 *       and not nested in another repository unless a genuine linked worktree, no core.worktree, env
 *       scrubbed), run with core.fsmonitor=false and safe.bareRepository=explicit injected through the
 *       environment, and with PATH cut to its absolute entries (an unset PATH stays unset; a PATH with
 *       no absolute entry becomes one absolute directory that does not exist, never an empty PATH,
 *       which libuv would search as the cwd). A Read can therefore not make git adopt a committed
 *       bare-shaped directory or run a repository-configured fsmonitor command, nor find an executable
 *       named git in the target's directory through an empty or relative PATH entry (security review
 *       HIGH-01, LOW-01, re-review LOW-R2-01). A pinning refusal is a silent pass. A TRACKED hand-written bin/lib file stays readable even when a twin
 *       exists (a module being ported), matching binlib-edit, which allows editing that file.
 * At gsd-core 36e60c09f the two signals agree on every bin/lib .cjs file (287 with a twin, all
 * ignored; 13 without, none ignored). That is a file count, not a measured rate over Reads.
 *
 * SILENT PASS, NEVER AN EXPLICIT ALLOW. Every other path writes NOTHING to stdout and exits 0. An
 * explicit `permissionDecision: "allow"` would skip Claude Code's permission prompt; silence leaves the
 * Read to the normal permission flow. So the entrypoint never uses failclosed.cjs `emit()` (which maps
 * a malformed decision to deny) or `runGate` (which fails closed): only an object whose
 * permissionDecision is exactly 'deny' produces output.
 *
 * FAILS OPEN. A malformed payload, a missing file_path, no gsd-core root, a filesystem error, a git
 * error, a git timeout (binlib-edit's one 3000 ms deadline), a pinning refusal, a load-time throw of
 * a required module (requires are lazy, inside the try) and any other throw are a silent pass. A hook
 * Claude Code cancels at its own timeout does not block the Read either (hooks reference: a timed-out
 * PreToolUse command hook continues through the normal permission flow). This is the scoped exception
 * CTK-ADR-0017 records to CTK-ADR-0001 Decision 2 and CTK-ADR-0005 Decision 4.
 *
 * COVERS ONLY THE READ TOOL. Not covered: Grep, Glob, NotebookRead, Bash (`cat`, `sed -n`, `head`), a
 * Read through a hard link to an emitted file, and a case alias of the bin/lib path on a filesystem
 * whose realpath does not canonicalise case. Reading the emitted output on purpose (a stack-trace
 * line: gsd-core builds with sourceMap false, so a trace line number exists only in the emitted file)
 * goes through Bash; the deny reason says so. GSD_CONTRIB_OVERRIDE does not apply: it rescues thrown
 * errors in runGate gates, and this hook throws nothing out.
 *
 * KNOWN FALSE DENIES. A Read meant to see the emitted code itself (the trace case above), and an
 * untracked hand-written file with a twin that the user's global excludes file ignores. Both cost one
 * Bash call. Not a false deny: a nested repository at or below bin/ (the pinning refuses it, a pass).
 *
 * KNOWN SILENT PASSES from the pinning (fail-open direction): a gsd-core checkout nested inside an
 * unrelated repository (not a linked worktree of it), a repository with core.worktree set, and a
 * `.git` entry between the target and bin/ all pass silently; the emitted file is then readable. So
 * do a committed bare-shaped directory under bin/lib (the pinning or safe.bareRepository refuses it),
 * a malformed inherited git -c environment (git refuses to run) and a PATH with no absolute entry
 * (git is not found).
 *
 * READ-ONLY. It stats files, realpaths paths and runs binlib-edit's read-only git probes (rev-parse,
 * config --get, check-ignore; no index lock). Its one write is the best-effort verdict-log line on a
 * deny (hooks/lib/verdict-log.cjs, total). It changes process.env only for the duration of the probe
 * call and restores it.
 *
 * @module hooks/emitted-cjs-read
 */

const fs = require('node:fs');
const path = require('node:path');

/**
 * realpath of p; for a missing leaf, realpath of its directory joined with the leaf; null when neither
 * resolves.
 *
 * @param {string} p absolute path
 * @returns {string|null}
 */
function tryRealpath(p) {
  try {
    return fs.realpathSync.native(p);
  } catch (_) {
    try {
      return path.join(fs.realpathSync.native(path.dirname(p)), path.basename(p));
    } catch (__) {
      return null;
    }
  }
}

/**
 * Git config injected through the environment for every probe spawn (command-line scope, so a repository's
 * own config cannot override it). core.fsmonitor=false stops a repository-configured fsmonitor command;
 * safe.bareRepository=explicit stops git from adopting a committed bare-shaped directory as the repository
 * (SECURITY-REVIEW HIGH-01, quick 261119-szk). Measured on git 2.43: each one alone stops the planted command.
 */
const INJECTED_GIT_CONFIG = Object.freeze([
  ['core.fsmonitor', 'false'],
  ['safe.bareRepository', 'explicit'],
]);

/** The probe's PATH when the inherited PATH has no absolute entry: absolute, and never created. */
const NO_ABSOLUTE_PATH = '/nonexistent/emitted-cjs-read-no-absolute-path';

/**
 * The env changes for one probe: the injected config appended after any inherited GIT_CONFIG_COUNT entries
 * (a count that is not a plain non-negative integer is replaced; git rejects such a count anyway), and a PATH
 * rule so `git` is never looked up in the target's directory (SECURITY-REVIEW LOW-01, REVIEW-R2 LOW-R2-01):
 * an unset PATH is not touched, a set PATH keeps only its absolute entries, and a set PATH with none becomes
 * NO_ABSOLUTE_PATH.
 *
 * @param {Object} env
 * @returns {Object} key -> new value
 */
function probeEnvChanges(env) {
  const changes = {};
  const raw = env.GIT_CONFIG_COUNT;
  let n = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : 0;
  for (const [key, value] of INJECTED_GIT_CONFIG) {
    changes['GIT_CONFIG_KEY_' + n] = key;
    changes['GIT_CONFIG_VALUE_' + n] = value;
    n += 1;
  }
  changes.GIT_CONFIG_COUNT = String(n);
  // GIT_CONFIG_PARAMETERS (what `git -c` exports to child processes) is read after the COUNT entries, so an
  // inherited `core.fsmonitor=<cmd>` there would win; the injected pairs are appended to it as well, and the
  // last occurrence wins inside it (PLAN-REVIEW-R2 W-01). A malformed inherited value makes git refuse to run,
  // which is a silent pass.
  const inheritedParams = typeof env.GIT_CONFIG_PARAMETERS === 'string' ? env.GIT_CONFIG_PARAMETERS.trim() : '';
  const injectedParams = INJECTED_GIT_CONFIG.map(([key, value]) => "'" + key + '=' + value + "'").join(' ');
  changes.GIT_CONFIG_PARAMETERS = inheritedParams ? inheritedParams + ' ' + injectedParams : injectedParams;
  // PATH: never empty. libuv searches the cwd (the Read target's directory) for an empty PATH, so an unset
  // PATH stays unset (Node's default lookup, as before this hardening) and a PATH with no absolute entry
  // becomes one absolute directory that does not exist, so git is not found: a silent pass (REVIEW-R2
  // LOW-R2-01).
  if (typeof env.PATH === 'string') {
    const absolute = env.PATH.split(path.delimiter).filter((e) => e.length > 0 && path.isAbsolute(e));
    changes.PATH = absolute.length > 0 ? absolute.join(path.delimiter) : NO_ABSOLUTE_PATH;
  }
  return changes;
}

/**
 * Run fn with probeEnvChanges applied to process.env, restoring every changed key afterwards (binlib-edit's
 * probe reads process.env through its probeEnv, so this is how the hardening reaches its spawns without
 * editing binlib-edit). fn is synchronous.
 *
 * @param {() => *} fn
 * @returns {*}
 */
function withHardenedProbeEnv(fn) {
  const changes = probeEnvChanges(process.env);
  const saved = {};
  for (const k of Object.keys(changes)) {
    saved[k] = Object.prototype.hasOwnProperty.call(process.env, k) ? process.env[k] : undefined;
    process.env[k] = changes[k];
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

/**
 * The default probe: binlib-edit's repository-PINNED `checkIgnoreLive` (no `.git` entry between the target
 * and bin/, a discovered toplevel strictly above bin/ and not nested in another repository unless a genuine
 * linked worktree, no core.worktree, env scrubbed, one 3000 ms deadline), run under withHardenedProbeEnv.
 * 'ignored' only when git answers exit 0 for a pinned repository; every other answer is a silent pass.
 *
 * @param {string} absPath
 * @returns {'ignored'|'not-ignored'|'unknown'}
 */
function checkIgnorePinned(absPath) {
  const { checkIgnoreLive } = require('./binlib-edit.cjs');
  return withHardenedProbeEnv(() => checkIgnoreLive(absPath));
}

/**
 * The deny reason: name the twin and the Bash route for a deliberate read of the emitted output.
 *
 * @param {string} filePath the file_path as the Read carried it
 * @param {string} twinShown the twin path, absolute or relative to the payload cwd
 * @returns {string}
 */
function readDenyReason(filePath, twinShown) {
  return (
    '`' + filePath + '` is (or will be) tsc output of `' + twinShown + '` (gsd-core ADR-457: gsd-core/bin/lib/**/*.cjs ' +
    'is emitted from src/**/*.cts). Read the source `' + twinShown + '` instead. To read the emitted ' +
    'output itself (for example a stack-trace line number: gsd-core emits no source maps), read it ' +
    'through Bash (sed -n or cat); this guard covers only the Read tool. (ENF-26, fail-open read guard)'
  );
}

/**
 * The decision over a PreToolUse payload: a deny object, or null for a silent pass. May throw; the
 * caller (runReadGuard) turns any throw into a silent pass.
 *
 * @param {string} stdinString raw PreToolUse JSON
 * @param {Object} [deps]
 * @param {(startDir:string) => string} [deps.resolveRoot] default resolveGsdCoreRoot
 * @param {(absPath:string) => string} [deps.checkIgnore] default checkIgnorePinned
 * @returns {{permissionDecision:'deny', permissionDecisionReason:string}|null}
 */
function gate(stdinString, deps = {}) {
  const input = JSON.parse(stdinString);
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return null;
  if (input.tool_name !== 'Read') return null;
  const toolInput = input.tool_input;
  const filePath = toolInput && typeof toolInput === 'object' ? toolInput.file_path : undefined;
  if (typeof filePath !== 'string' || filePath.length === 0) return null;

  const base = typeof input.cwd === 'string' && input.cwd.length > 0 ? input.cwd : process.cwd();
  const abs = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(base, filePath);
  const real = tryRealpath(abs);

  // Stage 1: binlib-edit's segment-accurate candidate filter on every form of the path.
  const { isGeneratedBinLib, isStrictAncestor } = require('./binlib-edit.cjs');
  if (!isGeneratedBinLib(filePath) && !isGeneratedBinLib(abs) && !(real && isGeneratedBinLib(real))) {
    return null;
  }
  const target = real || abs;

  // Stage 2: the gsd-core checkout above the (real) target; the target must sit below its bin/lib.
  const resolveRoot = deps.resolveRoot || require('./lib/resolve.cjs').resolveGsdCoreRoot;
  const root = resolveRoot(path.dirname(target));
  const libReal = tryRealpath(path.join(root, 'gsd-core', 'bin', 'lib'));
  if (!libReal || !isStrictAncestor(libReal, target)) return null;
  const rel = path.relative(libReal, target);
  if (!rel.toLowerCase().endsWith('.cjs')) return null;

  // Signal (a): the src twin is a regular file.
  const twin = path.join(root, 'src', rel.slice(0, -4) + '.cts');
  if (!fs.statSync(twin, { throwIfNoEntry: false })?.isFile()) return null;

  // Signal (b): git reports the target ignored (generated).
  const checkIgnore = deps.checkIgnore || checkIgnorePinned;
  if (checkIgnore(target) !== 'ignored') return null;

  const twinShown = path.isAbsolute(filePath) ? twin : path.relative(base, twin);
  return { permissionDecision: 'deny', permissionDecisionReason: readDenyReason(filePath, twinShown) };
}

/**
 * The entry seam: a deny object only for a result whose permissionDecision is exactly 'deny' with a
 * non-empty string reason; null (a silent pass) for every other result and for any throw.
 *
 * @param {string} stdinString
 * @param {Object} [deps] gate deps, plus deps.gateImpl (test seam replacing gate)
 * @returns {{permissionDecision:'deny', permissionDecisionReason:string}|null}
 */
function runReadGuard(stdinString, deps = {}) {
  const startedAt = Date.now();
  let result;
  try {
    result = (deps.gateImpl || gate)(stdinString, deps);
  } catch (_) {
    return null;
  }
  if (
    !result ||
    typeof result !== 'object' ||
    result.permissionDecision !== 'deny' ||
    typeof result.permissionDecisionReason !== 'string' ||
    result.permissionDecisionReason.length === 0
  ) {
    return null;
  }
  const decision = { permissionDecision: 'deny', permissionDecisionReason: result.permissionDecisionReason };
  try {
    require('./lib/verdict-log.cjs').recordVerdict(
      { action: 'emitted-cjs-read', stdin: stdinString },
      decision,
      Date.now() - startedAt
    );
  } catch (_) {
    /* best effort: a verdict that cannot be logged is dropped */
  }
  return decision;
}

function main() {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => {
    buf += c;
  });
  process.stdin.on('error', () => {
    process.exitCode = 0;
  });
  process.stdin.on('end', () => {
    let decision = null;
    try {
      decision = runReadGuard(buf);
    } catch (_) {
      decision = null;
    }
    if (decision) {
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: decision.permissionDecisionReason,
          },
        }) + '\n'
      );
    }
    process.exitCode = 0;
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  gate,
  runReadGuard,
  checkIgnorePinned,
  probeEnvChanges,
  readDenyReason,
  tryRealpath,
  INJECTED_GIT_CONFIG,
};
