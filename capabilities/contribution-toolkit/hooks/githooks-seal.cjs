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
const { classifyAction } = require('./lib/classify.cjs');
const { hasFlag } = require('./lib/flags.cjs');
const { runGate, readHookInput, deny, allow, emit, FailClosed, safeCommand } = require('./lib/failclosed.cjs');
const { resolveRootForCommand } = require('./lib/resolve.cjs');

// FailClosed/safeCommand: shared IN-03 helpers from failclosed.cjs.

const SEALED_ACTIONS = new Set(['commit', 'push']);
const REQUIRED_HOOKS_PATH = '.githooks';
const NO_VERIFY_FLAGS = ['--no-verify', '-n'];

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

  // (1) ENF-12 — the REAL --no-verify / -n flag (structured argv, never -m message text).
  if (hasFlag(parsed, NO_VERIFY_FLAGS)) {
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
