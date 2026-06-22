#!/usr/bin/env node
'use strict';

/**
 * hooks/policy-invariants.cjs — PreToolUse(Bash) POLICY-02 mechanizable-invariants gate.
 *
 * On a `git commit` (or `gh pr create`), this gate runs the genuinely-MECHANIZABLE
 * ADR/policy invariants as gate calls against the LIVE gsd-core worktree and DENIES if
 * any fails. The four checks are gsd-core's own npm scripts — called, never reimplemented:
 *
 *   - lint:docs            → scripts/lint-docs-required.cjs  (changeset ↔ docs pairing)
 *   - lint:ci              → the chained CI lint suite (eslint, skill-deps, contract, …)
 *   - check:alias-drift    → scripts/check-alias-drift.cjs
 *   - check:identity-drift → scripts/lint-package-identity-drift.cjs
 *
 * SCOPE (red-team H-D): POLICY-02 is ONLY this mechanizable set. The semantic CONTEXT.md
 * predicates are AWARENESS (POLICY-03), NOT deterministic enforcement — this gate must
 * NOT scan CONTEXT.md. The POLICY_CHECKS table is the whole policy surface here.
 *
 * HARD-01: every path runs inside runGate, so an npm/node/infra failure (not a lint
 * failure — e.g. node missing, the worktree unresolvable, a check runner throwing) FAILS
 * CLOSED (deny), escapable only by a deliberate, logged GSD_CONTRIB_OVERRIDE. A non-commit
 * /non-pr-create command is allowed without running anything (lint:ci is heavy).
 *
 * @module hooks/policy-invariants
 */

const { parseCommand } = require('./lib/argv.cjs');
const { classifyAction } = require('./lib/classify.cjs');
const { runGate, readHookInput, deny, allow, emit, FailClosed, safeCommand } = require('./lib/failclosed.cjs');
const { resolveGsdCoreRoot, commandStartDir, ScriptResolveError } = require('./lib/resolve.cjs');

// FailClosed/safeCommand: shared IN-03 helpers from failclosed.cjs.

/**
 * The four MECHANIZABLE POLICY-02 invariants, each a LIVE gsd-core npm script.
 * `name` is the npm script name (used in deny reasons + as the run identifier); this
 * table is the entire POLICY-02 surface — deliberately NO CONTEXT.md predicate (H-D).
 */
const POLICY_CHECKS = Object.freeze([
  Object.freeze({ name: 'lint:docs', describe: 'changeset ↔ docs pairing (lint-docs-required.cjs)' }),
  Object.freeze({ name: 'lint:ci', describe: 'the chained CI lint suite' }),
  Object.freeze({ name: 'check:alias-drift', describe: 'alias drift (check-alias-drift.cjs)' }),
  Object.freeze({ name: 'check:identity-drift', describe: 'package identity drift (lint-package-identity-drift.cjs)' }),
]);

/** Actions that trigger the POLICY-02 invariants. */
const TRIGGER_ACTIONS = new Set(['commit', 'pr-create']);

/** Max characters of a failed check's output kept in the deny reason. */
const TAIL_LIMIT = 600;

/**
 * Run the POLICY_CHECKS as LIVE gsd-core npm scripts in the gsd-core worktree, with NO
 * shell (execFileSync of `npm run <name>`). Returns one result per check. A nonzero exit
 * is a lint FAILURE (ok:false). A spawn/infra error (npm/node missing) is re-thrown so
 * runGate fails closed (HARD-01) — it is NOT silently treated as a passing check.
 *
 * @param {string} root absolute gsd-core worktree root.
 * @param {ReadonlyArray<{name:string}>} checks
 * @returns {Array<{name:string, ok:boolean, code:number, tail:string}>}
 */
function runChecksLive(root, checks) {
  const { execFileSync } = require('node:child_process');
  return checks.map((check) => {
    try {
      execFileSync('npm', ['run', '--silent', check.name], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      });
      return { name: check.name, ok: true, code: 0, tail: '' };
    } catch (err) {
      // execFileSync throws on a nonzero exit AND on a spawn failure. Distinguish:
      // a spawn failure (ENOENT / npm missing) has no numeric `status` → infra error,
      // re-throw so runGate fails closed. A nonzero `status` is a real lint failure.
      if (err && typeof err.status === 'number') {
        const out = (err.stdout || '') + (err.stderr || '');
        return { name: check.name, ok: false, code: err.status, tail: tailOf(out) };
      }
      // No numeric status → could not even run the check (infra). Fail closed.
      throw new FailClosed(
        'could not run `npm run ' + check.name + '` in the gsd-core worktree (' +
          ((err && err.message) || 'spawn failure') + ') — failing closed (HARD-01)'
      );
    }
  });
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
 * @param {(root:string, checks:ReadonlyArray)=>Array} deps.runChecks the per-check runner.
 * @returns {{permissionDecision:string, permissionDecisionReason?:string}}
 */
function gate(stdinString, deps) {
  const input = readHookInput(stdinString);
  const command = (input.tool_input && input.tool_input.command) || '';

  const parsed = parseCommand(command);
  if (!parsed.ok) throw new FailClosed('unparseable command: ' + parsed.reason);

  const action = classifyAction(parsed);
  // A non-commit / non-pr-create command is out of scope — allow without running the
  // (heavy) checks. We do NOT fail-closed on action.failClosed here: an unclassifiable
  // mutating github call is the filing gates' concern (03-03), not the policy gate's;
  // this gate only ADDS the mechanizable invariants on commit/pr-create.
  if (!TRIGGER_ACTIONS.has(action.action)) return allow();

  const results = deps.runChecks(deps.gsdCoreRoot, POLICY_CHECKS); // may throw → fail closed
  const failed = (results || []).filter((r) => r && r.ok === false);
  if (failed.length === 0) return allow();

  const detail = failed
    .map((f) => '`' + f.name + '` (exit ' + f.code + ')' + (f.tail ? ':\n' + f.tail : ''))
    .join('\n\n');

  return deny(
    'Blocked by the LIVE gsd-core mechanizable policy invariants (POLICY-02). ' +
      'The following check(s) failed — fix them before filing:\n\n' +
      detail
  );
}

/**
 * Injectable entry seam. Builds runGate ctx and defaults the gsd-core root + the live
 * check runner from the real environment when not injected.
 *
 * @param {string} stdinString raw PreToolUse JSON
 * @param {Object} [deps]
 * @returns {{permissionDecision:string, permissionDecisionReason?:string}}
 */
function runPolicyGate(stdinString, deps = {}) {
  const ctx = {
    command: safeCommand(stdinString),
    action: 'policy-invariants',
    worktreeRoot: deps.worktreeRoot,
    overrideImpl: deps.overrideImpl,
  };

  return runGate(() => {
    const resolved = Object.assign({}, deps);
    if (!resolved.gsdCoreRoot) {
      try {
        resolved.gsdCoreRoot = resolveGsdCoreRoot(commandStartDir(parseCommand(ctx.command), process.cwd()));
      } catch (err) {
        // The command does not run in a gsd-core checkout (e.g. a commit in another
        // repo). It is not a gsd-core contribution, so this gate has nothing to add —
        // allow it. (A BROKEN gsd-core checkout still fails closed: the root resolves,
        // then requireLiveScript/runChecks throws — preserved below.)
        if (err instanceof ScriptResolveError) return allow();
        throw err;
      }
    }
    ctx.worktreeRoot = ctx.worktreeRoot || resolved.gsdCoreRoot;
    if (!resolved.runChecks) {
      resolved.runChecks = runChecksLive;
    }
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
    emit(runPolicyGate(buf));
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  runPolicyGate,
  gate,
  runChecksLive,
  POLICY_CHECKS,
  TRIGGER_ACTIONS,
};
