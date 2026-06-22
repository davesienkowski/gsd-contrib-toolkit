#!/usr/bin/env node
'use strict';

/**
 * hooks/freshness.cjs — PreToolUse(Bash) generated-file staleness gate
 * (ENF-14, HARD-01 fail-closed, HARD-04 robust-parse). Pairs with ENF-03 (the bin/lib edit
 * gate): ENF-03 stops you EDITING the generated artifact directly; this gate stops you
 * COMMITTING a STALE generated `bin/lib/*.generated.cjs` when you legitimately changed its
 * `src/*.ts` but never re-ran `build:lib` (the #1532-class hidden-staleness failure).
 *
 * On a `git commit`, read the staged file list in the resolved gsd-core worktree. For each
 * staged file that matches a governed src/generated glob, run the matching LIVE gsd-core
 * `npm run check:<name>-fresh` (the same check the repo's own .githooks/pre-commit runs) and
 * DENY on any non-zero — naming the stale artifact and the `npm run build:lib` fix.
 *
 * The src→generated→check mapping below is a faithful MIRROR of gsd-core's
 * .githooks/pre-commit (the authoritative source). It is a toolkit-owned REPLICATION of the
 * pre-commit's gating logic (which globs trigger which check) — documented as ours per the
 * H-A decision — but the CHECK ITSELF is the LIVE gsd-core npm script, never reimplemented:
 * staleness detection is delegated to `check:<name>-fresh`, not recomputed here.
 *
 * Architecture (inherited from Waves 1-2):
 *   - argv.parseCommand        → robust parse, fail-closed on unparseable (HARD-04)
 *   - classify.classifyAction  → only action:'commit' triggers (the checks are heavy)
 *   - resolve.resolveGsdCoreRoot→ the worktree whose index + npm scripts we read/run
 *   - failclosed.runGate       → an npm/git/infra failure DENIES (HARD-01); a lint failure
 *                                is a normal deny; only a logged override allows past either
 *
 * @module hooks/freshness
 */

const { parseCommand } = require('./lib/argv.cjs');
const { classifyAction } = require('./lib/classify.cjs');
const { runGate, readHookInput, deny, allow, emit, FailClosed, safeCommand } = require('./lib/failclosed.cjs');
const { resolveGsdCoreRoot, commandStartDir, ScriptResolveError } = require('./lib/resolve.cjs');

// FailClosed/safeCommand: shared IN-03 helpers from failclosed.cjs.

/**
 * The freshness-check family, MIRRORING gsd-core/.githooks/pre-commit. Each entry maps a
 * LIVE `npm run <name>` to the staged-path patterns that trigger it (the same `grep -E`
 * alternations the pre-commit uses, expressed as anchored RegExps). The CHECK is the LIVE
 * script; only the GLOB→check routing is replicated here (documented toolkit-owned, H-A).
 *
 * Order mirrors the pre-commit for diff-friendliness; routing is order-independent.
 */
const FRESHNESS_CHECKS = Object.freeze([
  Object.freeze({
    name: 'check:alias-drift',
    patterns: [
      /^sdk\/src\/query\/command-manifest\./,
      /^sdk\/src\/query\/command-aliases\.generated\.ts$/,
      /^gsd-core\/bin\/lib\/command-aliases\.cjs$/,
      /^sdk\/scripts\/gen-command-aliases\.ts$/,
    ],
  }),
  Object.freeze({
    name: 'check:state-document-fresh',
    patterns: [
      /^sdk\/src\/query\/state-document\./,
      /^gsd-core\/bin\/lib\/state-document\.generated\.cjs$/,
      /^sdk\/scripts\/gen-state-document\.ts$/,
      /^sdk\/scripts\/check-state-document-fresh\.mjs$/,
    ],
  }),
  Object.freeze({
    name: 'check:configuration-fresh',
    patterns: [
      /^sdk\/src\/configuration\//,
      /^sdk\/shared\/config-(defaults|schema)\.manifest\.json$/,
      /^gsd-core\/bin\/lib\/configuration\.generated\.cjs$/,
      /^sdk\/scripts\/gen-configuration\.mjs$/,
    ],
  }),
  Object.freeze({
    name: 'check:workstream-inventory-builder-fresh',
    patterns: [
      /^sdk\/src\/workstream-inventory\//,
      /^gsd-core\/bin\/lib\/workstream-inventory-builder\.generated\.cjs$/,
      /^sdk\/scripts\/gen-workstream-inventory-builder\.mjs$/,
      /^sdk\/scripts\/check-workstream-inventory-builder-fresh\.mjs$/,
    ],
  }),
  Object.freeze({
    name: 'check:project-root-fresh',
    patterns: [
      /^sdk\/src\/project-root\//,
      /^gsd-core\/bin\/lib\/project-root\.generated\.cjs$/,
      /^sdk\/scripts\/gen-project-root\.mjs$/,
      /^sdk\/scripts\/check-project-root-fresh\.mjs$/,
    ],
  }),
  Object.freeze({
    name: 'check:plan-scan-fresh',
    patterns: [
      /^sdk\/src\/query\/plan-scan\.ts$/,
      /^gsd-core\/bin\/lib\/plan-scan\.generated\.cjs$/,
      /^sdk\/scripts\/gen-plan-scan\.mjs$/,
      /^sdk\/scripts\/check-plan-scan-fresh\.mjs$/,
    ],
  }),
  Object.freeze({
    name: 'check:secrets-fresh',
    patterns: [
      /^sdk\/src\/query\/secrets\.ts$/,
      /^gsd-core\/bin\/lib\/secrets\.generated\.cjs$/,
      /^sdk\/scripts\/gen-secrets\.mjs$/,
      /^sdk\/scripts\/check-secrets-fresh\.mjs$/,
    ],
  }),
  Object.freeze({
    name: 'check:schema-detect-fresh',
    patterns: [
      /^sdk\/src\/query\/schema-detect\.ts$/,
      /^gsd-core\/bin\/lib\/schema-detect\.generated\.cjs$/,
      /^sdk\/scripts\/gen-schema-detect\.mjs$/,
      /^sdk\/scripts\/check-schema-detect-fresh\.mjs$/,
    ],
  }),
  Object.freeze({
    name: 'check:decisions-fresh',
    patterns: [
      /^sdk\/src\/query\/decisions\.ts$/,
      /^gsd-core\/bin\/lib\/decisions\.generated\.cjs$/,
      /^sdk\/scripts\/gen-decisions\.mjs$/,
      /^sdk\/scripts\/check-decisions-fresh\.mjs$/,
    ],
  }),
  Object.freeze({
    name: 'check:workstream-name-policy-fresh',
    patterns: [
      /^sdk\/src\/workstream-name-policy\.ts$/,
      /^gsd-core\/bin\/lib\/workstream-name-policy\.generated\.cjs$/,
      /^sdk\/scripts\/gen-workstream-name-policy\.mjs$/,
      /^sdk\/scripts\/check-workstream-name-policy-fresh\.mjs$/,
    ],
  }),
]);

/** Max characters of a failed check's output kept in the deny reason. */
const TAIL_LIMIT = 600;

/**
 * Which freshness checks does this staged-file set trigger? Mirrors the pre-commit's
 * per-check `git diff --cached --name-only | grep -Eq <glob>` gate: a check runs iff ANY
 * staged path matches ANY of its patterns. Returns the matched check NAMES, de-duplicated,
 * in FRESHNESS_CHECKS order.
 *
 * @param {string[]} staged staged file paths (repo-relative)
 * @returns {string[]}
 */
function matchedChecks(staged) {
  const files = Array.isArray(staged) ? staged : [];
  const names = [];
  for (const check of FRESHNESS_CHECKS) {
    const hit = files.some((f) => typeof f === 'string' && check.patterns.some((re) => re.test(f)));
    if (hit) names.push(check.name);
  }
  return names;
}

/**
 * Default LIVE staged-file reader: `git diff --cached --name-only` in the gsd-core worktree,
 * via execFileSync (no shell). THROWS on failure so the gate fails closed (HARD-01).
 *
 * @param {string} root gsd-core worktree root
 * @returns {string[]}
 */
function stagedFilesLive(root) {
  const { execFileSync } = require('node:child_process');
  let out;
  try {
    out = execFileSync('git', ['diff', '--cached', '--name-only'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
  } catch (err) {
    throw new FailClosed(
      'could not read the staged file list (`git diff --cached --name-only`) in the gsd-core ' +
        'worktree (' + ((err && err.message) || 'git failure') + ') — failing closed (HARD-01)'
    );
  }
  return out.split('\n').map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * Default LIVE per-check runner: `npm run --silent <name>` in the gsd-core worktree, via
 * execFileSync (no shell). A non-zero exit is a staleness FAILURE (ok:false). A spawn/infra
 * error (npm missing, script undefined) THROWS so the gate fails closed (HARD-01) — a check
 * we cannot run is never silently treated as passing.
 *
 * @param {string} root gsd-core worktree root
 * @param {string} name the npm script name (e.g. 'check:decisions-fresh')
 * @returns {{name:string, ok:boolean, code:number, tail:string}}
 */
function runCheckLive(root, name) {
  const { execFileSync } = require('node:child_process');
  try {
    execFileSync('npm', ['run', '--silent', name], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    return { name, ok: true, code: 0, tail: '' };
  } catch (err) {
    if (err && typeof err.status === 'number') {
      const out = (err.stdout || '') + (err.stderr || '');
      return { name, ok: false, code: err.status, tail: tailOf(out) };
    }
    throw new FailClosed(
      'could not run `npm run ' + name + '` in the gsd-core worktree (' +
        ((err && err.message) || 'spawn failure') + ') — failing closed (HARD-01)'
    );
  }
}

/**
 * Keep the last TAIL_LIMIT characters of a check's output (the actionable tail).
 * @param {string} out
 * @returns {string}
 */
function tailOf(out) {
  const s = String(out || '').trim();
  if (s.length <= TAIL_LIMIT) return s;
  return '…' + s.slice(s.length - TAIL_LIMIT);
}

/**
 * The pure gate decision with all impure deps injected.
 *
 * @param {string} stdinString raw PreToolUse JSON
 * @param {Object} deps
 * @param {string} deps.gsdCoreRoot the gsd-core worktree root.
 * @param {(root:string)=>string[]} deps.stagedFiles staged-file reader (may throw → fail closed).
 * @param {(root:string, name:string)=>{name,ok,code,tail}} deps.runCheck per-check runner
 *   (may throw → fail closed).
 * @returns {{permissionDecision:string, permissionDecisionReason?:string}}
 */
function gate(stdinString, deps) {
  const input = readHookInput(stdinString);
  const command = (input.tool_input && input.tool_input.command) || '';

  const parsed = parseCommand(command);
  if (!parsed.ok) throw new FailClosed('unparseable command: ' + parsed.reason);

  const action = classifyAction(parsed);
  // Only `git commit` triggers — the checks are heavy and ENF-14 is a commit-time gate.
  // (We do NOT fail-closed on action.failClosed: an unclassifiable github call is the
  // filing gates' concern, not the freshness gate's.)
  if (action.action !== 'commit') return allow();

  const staged = deps.stagedFiles(deps.gsdCoreRoot); // may throw → fail closed
  const names = matchedChecks(staged);
  if (names.length === 0) return allow(); // no governed src/generated pair staged

  const failed = [];
  for (const name of names) {
    const result = deps.runCheck(deps.gsdCoreRoot, name); // may throw → fail closed
    if (result && result.ok === false) failed.push(result);
  }
  if (failed.length === 0) return allow();

  const detail = failed
    .map((f) => '`npm run ' + f.name + '` (exit ' + f.code + ')' + (f.tail ? ':\n' + f.tail : ''))
    .join('\n\n');

  return deny(
    'Blocked by the LIVE gsd-core generated-file freshness checks (ENF-14): a generated ' +
      '`bin/lib/*.generated.cjs` is STALE relative to its staged `src/*`. Pairs with ENF-03 — ' +
      'edit the SRC, then rebuild and restage:\n\n' +
      '  npm run build:lib && git add -u\n\n' +
      'Failing check(s):\n\n' + detail
  );
}

/**
 * Injectable entry seam. Builds runGate ctx and defaults the gsd-core root + the live staged
 * reader + the live check runner from the real environment when not injected.
 *
 * @param {string} stdinString raw PreToolUse JSON
 * @param {Object} [deps]
 * @returns {{permissionDecision:string, permissionDecisionReason?:string}}
 */
function runFreshnessGate(stdinString, deps = {}) {
  const ctx = {
    command: safeCommand(stdinString),
    action: 'freshness',
    worktreeRoot: deps.worktreeRoot,
    overrideImpl: deps.overrideImpl,
  };

  return runGate(() => {
    const resolved = Object.assign({}, deps);
    if (!resolved.gsdCoreRoot) {
      try {
        resolved.gsdCoreRoot = resolveGsdCoreRoot(commandStartDir(parseCommand(ctx.command), process.cwd()));
      } catch (err) {
        // Not a gsd-core checkout (e.g. a commit in another repo) → not this gate's
        // concern; allow. A broken gsd-core checkout still fails closed downstream.
        if (err instanceof ScriptResolveError) return allow();
        throw err;
      }
    }
    ctx.worktreeRoot = ctx.worktreeRoot || resolved.gsdCoreRoot;
    if (!resolved.stagedFiles) resolved.stagedFiles = stagedFilesLive;
    if (!resolved.runCheck) resolved.runCheck = runCheckLive;
    return gate(stdinString, resolved);
  }, ctx);
}


function main() {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => {
    buf += c;
  });
  process.stdin.on('end', () => {
    emit(runFreshnessGate(buf));
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  runFreshnessGate,
  gate,
  matchedChecks,
  stagedFilesLive,
  runCheckLive,
  FRESHNESS_CHECKS,
};
