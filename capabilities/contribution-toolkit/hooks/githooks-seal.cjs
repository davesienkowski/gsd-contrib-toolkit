#!/usr/bin/env node
'use strict';

/**
 * hooks/githooks-seal.cjs — PreToolUse(Bash) .githooks seal
 * (ENF-12 --no-verify flag-not-text + ENF-13 core.hooksPath=.githooks, HARD-01/04).
 *
 * Sealing the repo's own `.githooks` layer is higher-ROI than net-new gates (red-team
 * "what held up"): a fresh gsd-core worktree leaves `core.hooksPath` UNSET, so the repo's
 * pre-commit/pre-push gates are silently INERT — a contributor commits/pushes red without
 * ever running a single local gate. And `git commit --no-verify` / `-n` skips the hooks
 * even when they ARE wired. This gate denies both:
 *
 *   ENF-12 — a commit/push carrying the REAL `--no-verify` / `-n` argv flag → DENY.
 *            Crucially this consults the STRUCTURED flag space (hooks/lib/flags.hasFlag),
 *            never the raw command string and never the `-m` message value: so
 *            `git commit -m "never use --no-verify"` is NOT denied for the flag (the
 *            EP-3 false-positive boundary, threat T-03-04-FP — a false deny here gets the
 *            toolkit disabled). --no-verify is distinct from the GSD_CONTRIB_OVERRIDE
 *            escape valve (HARD-03): the override is a logged reason, not a hook-skip.
 *
 *   ENF-13 — a commit/push whose worktree git config `core.hooksPath` !== `.githooks`
 *            → DENY (threat T-03-04-INERT), with the exact fix command. The value is read
 *            from the LIVE git config of the resolved gsd-core worktree (not a global, not
 *            a vendored guess).
 *
 * Scope: only `commit` / `push` actions are gated; every other command (git reads, non-git)
 * passes through as a no-op allow, so the seal never over-blocks. HARD-01/04: the whole
 * decision runs inside runGate, so an unparseable command or a config-read failure FAILS
 * CLOSED (deny) — escapable only by a deliberate, logged GSD_CONTRIB_OVERRIDE.
 *
 * @module hooks/githooks-seal
 */

const { parseCommand } = require('./lib/argv.cjs');
const { classifyAction, isNonGovernedCommand } = require('./lib/classify.cjs');
const { hasFlag } = require('./lib/flags.cjs');
const { runGate, readHookInput, deny, allow, emit, FailClosed, safeCommand } = require('./lib/failclosed.cjs');
const { resolveRootForCommand } = require('./lib/resolve.cjs');

// FailClosed/safeCommand: shared IN-03 helpers from failclosed.cjs.

const SEALED_ACTIONS = new Set(['commit', 'push']);
const REQUIRED_HOOKS_PATH = '.githooks';
const NO_VERIFY_FLAGS = ['--no-verify', '-n'];

/**
 * The chained segments that ARE the sealed git action (commit/push).
 *
 * ENF-12 must consult ONLY these. `hasFlag` reports a flag's presence across the WHOLE
 * command's flag space, so scanning `parsed` directly makes any neighbor in the chain
 * that legitimately carries `-n` — `grep -n`, `sed -n`, `tail -n`, `sort -n` — read as a
 * `git commit -n`. Those are ubiquitous next to a commit, so the gate denied a large class
 * of correct commands.
 *
 * This is the SAME false-positive class the flag-not-text rule (EP-3) already closed, on a
 * second axis: that one was flag-vs-message-TEXT, this one is my-segment-vs-a-NEIGHBOR's.
 * Both end in the trust-eroding false deny that gets the toolkit switched off (red-team
 * H-B), which is the failure mode this module's own docstring calls load-bearing.
 *
 * Narrowing here must not weaken the seal, so this returns EVERY sealed segment rather
 * than the first: `git commit -m x && git push --no-verify` must still deny on the push.
 * (classify.findActionSegment is unsuitable — it returns one segment and falls back to
 * segs[0], which can be a non-git neighbor.) Mirrors the segment fan-out shape of
 * classify.hasGovernedSegment.
 *
 * PURE: reads only argv/classify output.
 *
 * @param {Object} parsed result of argv.parseCommand
 * @returns {Object[]} the segments classifying to a SEALED_ACTIONS action (possibly empty)
 */
function sealedSegments(parsed) {
  const segs = Array.isArray(parsed.segments) && parsed.segments.length > 0
    ? parsed.segments
    : [parsed];
  return segs.filter((seg) => {
    const r = classifyAction({ ok: true, segments: [seg] });
    return r && SEALED_ACTIONS.has(r.action);
  });
}

/**
 * The pure gate decision with the impure git-config read injected.
 *
 * @param {string} stdinString raw PreToolUse JSON
 * @param {Object} deps
 * @param {() => (string|null)} deps.readHooksPath reads core.hooksPath for the resolved
 *   gsd-core worktree (returns the trimmed value or null). MAY THROW → fail closed.
 * @returns {{permissionDecision:string, permissionDecisionReason?:string}}
 */
function gate(stdinString, deps) {
  const input = readHookInput(stdinString);
  const command = (input.tool_input && input.tool_input.command) || '';

  const parsed = parseCommand(command);
  if (!parsed.ok) throw new FailClosed('unparseable command: ' + parsed.reason);

  const action = classifyAction(parsed);
  // Only commit/push are sealed. Anything else (git reads, non-git) → no-op allow.
  if (!action || !SEALED_ACTIONS.has(action.action)) return allow();

  // (1) ENF-12 — the REAL --no-verify / -n flag (structured argv, never -m message text)
  // and never a CHAINED NEIGHBOUR's flag: scoped to the sealed git segment(s) only.
  const sealed = sealedSegments(parsed);
  if (sealed.some((seg) => hasFlag({ ok: true, segments: [seg] }, NO_VERIFY_FLAGS))) {
    return deny(
      '`--no-verify` / `-n` bypasses the repo\'s `.githooks` gates (pre-commit / pre-push). ' +
        'Remove it and let the local gates run. If a bypass is TRULY necessary, use a ' +
        'logged `GSD_CONTRIB_OVERRIDE=<reason>` (which writes a receipt) — that is the ' +
        'sanctioned, accountable escape, distinct from silently skipping the hooks. (ENF-12)'
    );
  }

  // (2) ENF-13 — core.hooksPath must be .githooks or the repo's own gates are inert.
  const hooksPathRaw = deps.readHooksPath(); // may throw → fail closed (HARD-01)
  const hooksPath = typeof hooksPathRaw === 'string' ? hooksPathRaw.trim() : '';
  if (hooksPath !== REQUIRED_HOOKS_PATH) {
    return deny(
      'This worktree\'s `core.hooksPath` is ' +
        (hooksPath ? '`' + hooksPath + '`' : 'UNSET') +
        ', so the repo\'s `.githooks` gates (pre-commit / pre-push) are silently INERT. ' +
        'Set it before committing/pushing: `git config core.hooksPath .githooks`. (ENF-13)'
    );
  }

  return allow();
}

/**
 * Injectable entry seam. Defaults readHooksPath to a live read of `core.hooksPath` from
 * the RESOLVED gsd-core worktree's git config (that worktree, not a global).
 *
 * @param {string} stdinString raw PreToolUse JSON
 * @param {Object} [deps]
 * @param {() => (string|null)} [deps.readHooksPath]
 * @param {string} [deps.worktreeRoot]
 * @param {{checkOverride:Function, writeReceipt:Function}} [deps.overrideImpl]
 * @returns {{permissionDecision:string, permissionDecisionReason?:string}}
 */
function runGithooksGate(stdinString, deps = {}) {
  const ctx = {
    command: safeCommand(stdinString),
    action: 'githooks-seal',
    worktreeRoot: deps.worktreeRoot,
    overrideImpl: deps.overrideImpl,
  };

  return runGate(() => {
    // RES-01 (D-07 uniformity): classify the governed action FIRST (pure parse→classify,
    // no filesystem) and short-circuit a confidently non-governed command to allow() BEFORE
    // resolveRootForCommand walks the tree — a non-commit/non-push command no longer pays a
    // filesystem walk. The governed set is SEALED_ACTIONS (commit/push); isNonGovernedCommand
    // narrows-not-weakens: unparseable/failClosed/commit/push fall through to the unchanged
    // resolve→gate path below (a governed commit/push still runs the ENF-12/ENF-13 seal).
    if (isNonGovernedCommand(parseCommand(ctx.command), SEALED_ACTIONS)) return allow();

    const resolved = Object.assign({}, deps);
    if (!resolved.readHooksPath) {
      const root = resolved.worktreeRoot || resolveRootForCommand(ctx.command, process.cwd());
      if (!root) return allow();
      ctx.worktreeRoot = ctx.worktreeRoot || root;
      resolved.readHooksPath = () => readHooksPathLive(root);
    }
    return gate(stdinString, resolved);
  }, ctx);
}

/**
 * Live read of `git config --get core.hooksPath` for a specific worktree. Returns the
 * trimmed value, or null when the key is unset. THROWS on a real git failure (not the
 * "unset" exit code 1) so runGate fails closed (HARD-01).
 *
 * @param {string} root absolute gsd-core worktree root
 * @returns {string|null}
 */
function readHooksPathLive(root) {
  const { spawnSync } = require('node:child_process');
  const res = spawnSync('git', ['-C', root, 'config', '--get', 'core.hooksPath'], {
    encoding: 'utf8',
  });
  if (res.error) {
    throw new FailClosed('could not read core.hooksPath: ' + res.error.message);
  }
  // git config --get exits 1 when the key is simply not set — that is "unset", not an error.
  if (res.status === 1) return null;
  if (res.status !== 0) {
    throw new FailClosed(
      'git config --get core.hooksPath failed (exit ' + res.status + '): ' + (res.stderr || '')
    );
  }
  const out = String(res.stdout || '').trim();
  return out.length > 0 ? out : null;
}


function main() {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => {
    buf += c;
  });
  process.stdin.on('end', () => {
    emit(runGithooksGate(buf));
  });
}

if (require.main === module) {
  main();
}

module.exports = { runGithooksGate, gate, readHooksPathLive, REQUIRED_HOOKS_PATH, NO_VERIFY_FLAGS };
