#!/usr/bin/env node
'use strict';

/**
 * hooks/binlib-edit.cjs — PreToolUse(Write|Edit) generated-file gate
 * (ENF-03, ADR-457, HARD-01/03 fail-closed, BINLIB-01..04).
 *
 * The #1 zero-source bounce in a gsd-core contribution is editing a GENERATED
 * `bin/lib/*.cjs` artifact instead of its `src/*.ts` source (PROJECT.md, ADR-457):
 * the hand-edit is silently overwritten by the next `build:lib`, so the change looks
 * applied but evaporates. This gate makes that physically impossible. Not every
 * `bin/lib/*.cjs` is generated, though: gsd-core also TRACKS a handful of hand-written
 * `bin/lib/*.cjs` with no `src/` twin (e.g. `capability-validator.cjs`), and generated
 * output is gitignored PER FILE. So the decision runs in two stages.
 *
 * STAGE 1 — candidate filter (pure, cheap). Segment-accuracy (threat T-03-04-SUBSTR /
 * edge-probe EP-1 class): the match is NOT a naive `includes('bin/lib')` substring. A `bin`
 * PATH SEGMENT must be immediately followed by a `lib` SEGMENT, immediately followed by a
 * `*.cjs` LEAF that is the direct child of that `lib`. So:
 *   - `.../bin/lib/decisions.cjs`            → CANDIDATE (segment pair + .cjs leaf)
 *   - `.../packages/x/bin/lib/foo.cjs`       → CANDIDATE (any depth)
 *   - `src/bin-lib-notes.md`                 → ALLOW (substring, not a segment pair)
 *   - `src/mybin/libfoo.cjs`                 → ALLOW (bin/lib split across one segment)
 *   - `.../bin/lib/README.md`                → ALLOW (segment pair but leaf is not .cjs)
 *   - `.../bin/lib/sub/nested.cjs`           → ALLOW (.cjs is not a direct lib child)
 *   - `.../lib/bin/x.cjs`                     → ALLOW (wrong order: must be bin then lib)
 * The filter runs on the RAW file_path and on the RESOLVED absolute path (T-35-05), so a
 * dot-segment path such as `bin/lib/../lib/x.cjs` or `bin/lib/./x.cjs` still becomes a
 * candidate. Normalization cannot un-match a raw candidate (its last three segments hold no
 * `.`/`..`), so this is a strict superset. A non-candidate is ALLOWED without running git.
 *
 * STAGE 2 — discriminator: `git check-ignore -q -- <abs>` (argv array, no shell, `--` before
 * the path), run with cwd = the target's own directory so the answer comes from the repo or
 * worktree that actually holds the file. Plain check-ignore (no --no-index): a TRACKED file is
 * reported not-ignored even when a pattern matches it — tracked means hand-written.
 *   - exit 0 (ignored → generated)                         → DENY, ADR-457 reason unchanged
 *   - exit 1 (tracked, or untracked and not ignored)       → ALLOW
 *   - anything else: spawn error, git missing, timeout or null status, exit 128 (not a git
 *     work tree), directory absent, or an injected seam value other than 'not-ignored'
 *                                                          → DENY, ADR-457 reason + a
 *     "could not be determined" note (HARD-01, BINLIB-03). Returned as a policy deny, exactly
 *     like the pre-v2.8 deny-all behavior, so GSD_CONTRIB_OVERRIDE (thrown errors only) cannot
 *     flip it.
 * The probe is capped at CHECK_IGNORE_TIMEOUT_MS = 3000 ms, well under this gate's 10 s hook
 * timeout in settings.snippet.json, so a hung git resolves to the undecidable deny. It is
 * read-only (no index lock), so concurrent or interrupted invocations cannot mutate a repo.
 *
 * ENV SCRUB (T-35-02): the probe runs with GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE and
 * GIT_COMMON_DIR removed. Measured 2026-10-05: an inherited GIT_INDEX_FILE pointing at an
 * alternate index with the emitted file force-added makes check-ignore exit 1 — a fail-open.
 *
 * DIVERGENCE (recorded): the discriminator idea comes from Trek-e's
 * `emitted-cjs-read-guard.cjs`, which fails OPEN when git cannot answer. This gate fails
 * CLOSED per CTK-ADR-0001 §Decision.2: an unanswerable probe never becomes an allow.
 *
 * ACCEPTED RESIDUAL (flagged assumption A-01, threat T-35-07): "hand-written" means tracked or
 * not ignored. A newly generated .cjs whose per-file .gitignore line has not been added yet is
 * ALLOWED, as is a generated file force-added to the index or un-ignored by a .gitignore edit.
 * Each of those routes leaves a visible .gitignore or index change in the contribution diff.
 *
 * HARD-01/03: the whole decision runs inside runGate, so a malformed payload, an absent
 * or non-string `file_path`, or any thrown error FAILS CLOSED (deny) — escapable only by
 * a deliberate, logged GSD_CONTRIB_OVERRIDE.
 *
 * TOOL_NAME SELF-FILTER (defense-in-depth layer 2): this gate governs ONLY `Write` and `Edit`.
 * The canonical `settings.snippet.json`/manifest matcher scopes it to `Write|Edit`, but if it is
 * ever installed CATCH-ALL (no matcher), it also receives `Bash`/`Read`/etc. payloads that
 * legitimately carry no `file_path`. Those must short-circuit to ALLOW *before* the file_path
 * check — otherwise every Bash call trips the Write/Edit HARD-01 fail-closed and blocks all work.
 * The HARD-01 fail-closed is UNWEAKENED for the tools this gate actually governs: a Write/Edit
 * with an absent/non-string file_path still DENIES.
 *
 * @module hooks/binlib-edit
 */

const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runGate, readHookInput, deny, allow, emit, FailClosed } = require('./lib/failclosed.cjs');

// FailClosed: shared IN-03 helper from failclosed.cjs (binlib-edit has no safeCommand —
// it uses safeFilePath; Write/Edit gates read file_path, not command).

/**
 * Upper bound for the `git check-ignore` probe. The settings.snippet.json hook timeout for
 * this gate is 10 s; the probe is capped well under it so a hung git resolves to a deny
 * instead of the harness killing the hook.
 */
const CHECK_IGNORE_TIMEOUT_MS = 3000;

/**
 * Inherited variables that redirect git to a different repository, work tree or index. Any of
 * them could make the probe answer for something other than the file's own repository (an
 * alternate GIT_INDEX_FILE with the emitted file force-added turns exit 0 into exit 1), so the
 * probe never sees them (T-35-02).
 */
const REPO_REDIRECT_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR'];

/**
 * A shallow copy of env with exactly the REPO_REDIRECT_ENV keys removed. Every other variable,
 * including other GIT_* config such as GIT_CONFIG_GLOBAL, is kept.
 *
 * @param {Object} env
 * @returns {Object}
 */
function probeEnv(env) {
  const out = Object.assign({}, env);
  for (const k of REPO_REDIRECT_ENV) delete out[k];
  return out;
}

/**
 * Split a path into its segments, tolerant of either separator (the harness may hand us a
 * POSIX or a Windows-ish path). Empty segments (from leading/trailing/double separators)
 * are dropped so a trailing slash cannot smuggle a fake leaf.
 *
 * @param {string} filePath
 * @returns {string[]}
 */
function pathSegments(filePath) {
  return String(filePath)
    .split(/[\\/]+/)
    .filter((s) => s.length > 0);
}

/**
 * Is this file_path a generated `**\/bin/lib/*.cjs` artifact, by SEGMENT-accurate match?
 *
 * Requires a `bin` segment immediately followed by a `lib` segment, with the `*.cjs` leaf
 * as the DIRECT child of that `lib` (i.e. exactly one segment after `lib`, and it is the
 * final segment, and it ends in `.cjs`). Never a naive substring test.
 *
 * @param {string} filePath
 * @returns {boolean}
 */
function isGeneratedBinLib(filePath) {
  const segs = pathSegments(filePath);
  // Need at least bin / lib / leaf, with the leaf as the LAST segment.
  if (segs.length < 3) return false;
  const leafIdx = segs.length - 1;
  // bin and lib must be the two segments immediately preceding the leaf.
  if (segs[leafIdx - 2] !== 'bin') return false;
  if (segs[leafIdx - 1] !== 'lib') return false;
  const leaf = segs[leafIdx];
  return typeof leaf === 'string' && leaf.toLowerCase().endsWith('.cjs');
}

/**
 * The ENF-03 / ADR-457 deny reason — point the author at the `src/*.cts` source.
 *
 * @param {string} filePath
 * @returns {string}
 */
function binLibDenyReason(filePath) {
  return (
    'This file is a GENERATED artifact (`' +
    filePath +
    '`). Editing a `bin/lib/*.cjs` by hand is overwritten by the next `build:lib` ' +
    '(ADR-457: generated CJS has a single source). Edit the `src/*.ts` source instead, ' +
    'then run `build:lib` to regenerate. (ENF-03)'
  );
}

/**
 * The BINLIB-03 deny reason for a candidate whose generated/hand-written status could not be
 * determined: the full ADR-457 reason, unchanged, with an explanatory note appended.
 *
 * @param {string} filePath
 * @returns {string}
 */
function binLibUndecidableReason(filePath) {
  return (
    binLibDenyReason(filePath) +
    ' Whether it is generated or hand-written could not be determined (git check-ignore gave ' +
    'no answer: directory absent, not a git work tree, git missing or erroring, or timed out), ' +
    'so it is treated as generated (fail-closed, HARD-01 / BINLIB-03).'
  );
}

/**
 * Resolve the Write/Edit target to an absolute, normalized path. An absolute file_path is
 * normalized as-is; a relative one is resolved against the payload `cwd`, falling back to
 * process.cwd() when the payload carries none.
 *
 * @param {string} filePath
 * @param {string} [payloadCwd]
 * @returns {string}
 */
function resolveTargetPath(filePath, payloadCwd) {
  if (path.isAbsolute(filePath)) return path.resolve(filePath);
  const base = typeof payloadCwd === 'string' && payloadCwd.length > 0 ? payloadCwd : process.cwd();
  return path.resolve(base, filePath);
}

/**
 * Map a `git check-ignore -q` spawnSync result to a verdict. Exit 0 = ignored (generated),
 * exit 1 = not ignored (tracked, or untracked and not ignored: hand-written). Everything else
 * (spawn error, null status from a timeout/signal, 128 "not a git repository", any other
 * code) is 'unknown'.
 *
 * @param {{error?:Error, status?:(number|null)}} result
 * @returns {'ignored'|'not-ignored'|'unknown'}
 */
function classifyCheckIgnore(result) {
  if (!result || result.error) return 'unknown';
  if (result.status === 0) return 'ignored';
  if (result.status === 1) return 'not-ignored';
  return 'unknown';
}

/**
 * The default probe: `git check-ignore -q -- <abs>` run from the target's own directory, so
 * the answer comes from the repository (or worktree) that actually holds the file. argv array,
 * never a shell string; `--` before the path. Plain check-ignore (no --no-index), so a TRACKED
 * file reports not-ignored even when a pattern matches it. Read-only: takes no index lock.
 * Runs with the repo-redirecting variables scrubbed (probeEnv).
 *
 * @param {string} absPath
 * @returns {'ignored'|'not-ignored'|'unknown'}
 */
function checkIgnoreLive(absPath) {
  try {
    const result = spawnSync('git', ['check-ignore', '-q', '--', absPath], {
      cwd: path.dirname(absPath),
      timeout: CHECK_IGNORE_TIMEOUT_MS,
      encoding: 'utf8',
      env: probeEnv(process.env),
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    return classifyCheckIgnore(result);
  } catch (_) {
    return 'unknown';
  }
}

/**
 * The pure gate decision over a PreToolUse(Write|Edit) payload.
 *
 * @param {string} stdinString raw PreToolUse JSON
 * @param {Object} [deps]
 * @param {(absPath:string) => string} [deps.checkIgnore] probe seam (default checkIgnoreLive)
 * @returns {{permissionDecision:string, permissionDecisionReason?:string}}
 */
function gate(stdinString, deps = {}) {
  const input = readHookInput(stdinString); // throws on malformed JSON → fail closed

  // SELF-FILTER (defense-in-depth): this gate governs ONLY Write|Edit. Any other tool (Bash,
  // Read, …) has no bin/lib file_path to evaluate — short-circuit to ALLOW before the file_path
  // check so a catch-all install can never trip the Write/Edit HARD-01 on a Bash payload.
  const toolName = input.tool_name;
  if (toolName !== 'Write' && toolName !== 'Edit') {
    return allow();
  }

  const toolInput = input.tool_input || {};
  const filePath = toolInput.file_path;

  // An Edit/Write with no observable file_path cannot be evaluated — fail closed (HARD-01).
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new FailClosed(
      'PreToolUse(Write|Edit) carried no string file_path — failing closed (HARD-01)'
    );
  }

  // Stage 1: the segment matcher picks candidates, on the raw AND the resolved path (T-35-05).
  // A non-candidate never reaches git.
  const abs = resolveTargetPath(filePath, input.cwd);
  if (!isGeneratedBinLib(filePath) && !isGeneratedBinLib(abs)) {
    return allow();
  }

  // Stage 2: git decides. Only the exact verdict 'not-ignored' (tracked, or untracked and not
  // ignored = hand-written) allows. 'ignored' is the unchanged ADR-457 deny; every other answer
  // is undecidable and denies with the note (HARD-01, BINLIB-03).
  const checkIgnore = deps.checkIgnore || checkIgnoreLive;
  const verdict = checkIgnore(abs);
  if (verdict === 'not-ignored') {
    return allow();
  }
  if (verdict === 'ignored') {
    return deny(binLibDenyReason(filePath));
  }
  return deny(binLibUndecidableReason(filePath));
}

/**
 * Injectable entry seam. Mirrors the other gates: deps carry the worktreeRoot + override
 * impl so runGate can record/honor a logged override, and the unit suite stays hermetic.
 *
 * @param {string} stdinString raw PreToolUse JSON
 * @param {Object} [deps]
 * @param {string} [deps.worktreeRoot]
 * @param {{checkOverride:Function, writeReceipt:Function}} [deps.overrideImpl]
 * @param {(absPath:string) => ('ignored'|'not-ignored'|'unknown')} [deps.checkIgnore]
 *   generated-vs-hand-written probe (default checkIgnoreLive: `git check-ignore -q -- <abs>`).
 *   Only the exact string 'not-ignored' allows; any other value, or a throw, denies.
 * @returns {{permissionDecision:string, permissionDecisionReason?:string}}
 */
function runBinlibGate(stdinString, deps = {}) {
  const ctx = {
    command: safeFilePath(stdinString),
    action: 'binlib-edit',
    // OBS-02: read ONLY for session/tool ids in the verdict log; never logged verbatim.
    stdin: stdinString,
    worktreeRoot: deps.worktreeRoot,
    overrideImpl: deps.overrideImpl,
  };
  return runGate(() => gate(stdinString, deps), ctx);
}

/**
 * Best-effort extract of the file_path for the override receipt (never throws).
 *
 * @param {string} stdinString
 * @returns {string}
 */
function safeFilePath(stdinString) {
  try {
    const o = JSON.parse(stdinString);
    const fp = o && o.tool_input && o.tool_input.file_path;
    return typeof fp === 'string' ? fp : '';
  } catch (_) {
    return '';
  }
}

function main() {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => {
    buf += c;
  });
  process.stdin.on('end', () => {
    emit(runBinlibGate(buf));
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  runBinlibGate,
  gate,
  isGeneratedBinLib,
  binLibDenyReason,
  pathSegments,
  resolveTargetPath,
  classifyCheckIgnore,
  checkIgnoreLive,
  probeEnv,
  binLibUndecidableReason,
  CHECK_IGNORE_TIMEOUT_MS,
  REPO_REDIRECT_ENV,
};
