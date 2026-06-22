'use strict';

/**
 * hooks/lib/failclosed.cjs — the fail-closed enforcement harness (HARD-01).
 *
 * This module is THE single enforcement decision point. Every Wave 2-4 gate wraps its
 * policy logic in `runGate(gateFn, ctx)` so that the HARD-01 invariant is inherited,
 * not re-implemented (and therefore not accidentally fail-OPEN):
 *
 *   - gateFn returns a decision (deny|allow)         → that decision is honored
 *   - gateFn THROWS (missing/again-shaped live script, parse failure, unauth gh, ANY
 *     error)                                          → FAIL CLOSED: deny
 *       …UNLESS checkOverride(worktreeRoot).override   → allow + writeReceipt (HARD-03)
 *
 * There is NO code path in which a thrown error yields a silent allow. The ONLY escape
 * from a fail-closed deny is a deliberate, LOGGED override (GSD_CONTRIB_OVERRIDE=<reason>).
 * An honored override on a CLEAN allow is a no-op — a receipt is written ONLY when the
 * override is what flipped an error from deny → allow (so the audit trail records real
 * bypasses, not every benign command).
 *
 * `readHookInput` treats malformed stdin as an error (it throws): the caller runs it
 * inside its gateFn, so the throw lands in runGate's catch → deny. It NEVER guesses an
 * allow on unparseable input.
 *
 * `emit` is the only impure function (it writes the harness decision JSON to stdout and
 * sets the process exit semantics). The decision helpers (deny/allow) are pure.
 *
 * @module hooks/lib/failclosed
 */

const override = require('./override.cjs');

/**
 * IN-03: the single shared fail-closed error type. A typed Error so a gate's runGate
 * catch turns any `throw new FailClosed(msg)` into a fail-closed DENY (HARD-01). Every
 * gate imports THIS class instead of re-declaring its own — a future change propagates
 * to all gates. There is no `instanceof FailClosed` dependency anywhere (gates throw it
 * and runGate reads only err.message), so one shared identity is behavior-identical.
 */
class FailClosed extends Error {}

/**
 * IN-03: the single shared best-effort command extractor. Parses the PreToolUse stdin
 * envelope and returns `tool_input.command`, or '' on ANY malformed input — it NEVER
 * throws (a gate uses it for non-decision-bearing context like the command string in a
 * receipt). Distinct from readHookInput, which throws so the gate fails closed.
 *
 * @param {string} stdinString raw JSON from the harness on stdin
 * @returns {string} the command, or '' when absent/unparseable
 */
function safeCommand(stdinString) {
  try {
    const o = JSON.parse(stdinString);
    return (o && o.tool_input && o.tool_input.command) || '';
  } catch (_) {
    return '';
  }
}

/**
 * Parse the PreToolUse hook payload from a stdin string.
 *
 * @param {string} stdinString raw JSON from the harness on stdin
 * @returns {{tool_name?: string, tool_input?: {command?: string, file_path?: string}}}
 * @throws {Error} on non-string input, invalid JSON, or a non-object payload — the
 *   caller's runGate turns this into a fail-closed DENY (never a guessed allow).
 */
function readHookInput(stdinString) {
  if (typeof stdinString !== 'string') {
    throw new TypeError('readHookInput: expected a string from stdin');
  }
  const parsed = JSON.parse(stdinString); // throws on malformed JSON → deny
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError('readHookInput: PreToolUse payload must be a JSON object');
  }
  return parsed;
}

/**
 * Build a DENY decision.
 * @param {string} reason human-readable reason surfaced to the harness/user.
 * @returns {{permissionDecision: 'deny', permissionDecisionReason: string}}
 */
function deny(reason) {
  return {
    permissionDecision: 'deny',
    permissionDecisionReason: String(reason == null ? 'denied' : reason),
  };
}

/**
 * Build an ALLOW (no-op) decision that lets the tool proceed.
 * @returns {{permissionDecision: 'allow'}}
 */
function allow() {
  return { permissionDecision: 'allow' };
}

/**
 * Write the harness PreToolUse decision JSON to stdout and exit.
 *
 * Emits the documented PreToolUse contract envelope:
 *   { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision, permissionDecisionReason? } }
 *
 * A deny is a real decision the harness must honor; we exit 0 with the JSON on stdout so
 * the harness reads the structured decision (a non-zero exit would be treated as a hook
 * error, not a clean deny). The decision lives in the JSON, not the exit code.
 *
 * @param {{permissionDecision: string, permissionDecisionReason?: string}} decision
 */
function emit(decision) {
  const d = decision && typeof decision === 'object' ? decision : deny('empty decision');
  const envelope = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: d.permissionDecision === 'allow' ? 'allow' : 'deny',
    },
  };
  if (envelope.hookSpecificOutput.permissionDecision === 'deny') {
    envelope.hookSpecificOutput.permissionDecisionReason =
      d.permissionDecisionReason || 'denied';
  }
  process.stdout.write(JSON.stringify(envelope) + '\n');
  // Exit 0: the decision is conveyed by the JSON, not the exit status.
  if (typeof process.exitCode !== 'number') {
    process.exitCode = 0;
  }
}

/**
 * Run a gate function under the fail-closed harness (HARD-01).
 *
 * @param {() => {permissionDecision: string, permissionDecisionReason?: string}} gateFn
 *   the gate's policy logic. Returning a decision honors it; THROWING fails closed.
 * @param {Object} ctx
 * @param {string} [ctx.worktreeRoot] the gsd-core worktree root (for the override receipt).
 * @param {string} [ctx.command] the command being gated (recorded in a receipt).
 * @param {string} [ctx.action] the action being overridden (recorded in a receipt).
 * @param {{checkOverride: Function, writeReceipt: Function}} [ctx.overrideImpl]
 *   injectable seam for the override module (defaults to the real ./override.cjs) so
 *   tests stay deterministic and filesystem-free.
 * @returns {{permissionDecision: string, permissionDecisionReason?: string}}
 */
function runGate(gateFn, ctx = {}) {
  const ovr = ctx.overrideImpl || override;
  try {
    const decision = gateFn();
    // A gate that RETURNS a decision (allow OR deny) made a real policy choice.
    // The override rescues ERRORS only — it never flips an intentional policy deny,
    // and a clean allow needs no receipt.
    if (decision && decision.permissionDecision === 'deny') {
      return deny(decision.permissionDecisionReason);
    }
    return allow();
  } catch (err) {
    // FAIL CLOSED. The only escape is a deliberate, logged override (HARD-03).
    const reason =
      (err && err.message) || 'enforcement gate failed (fail-closed deny)';
    let check = { override: false };
    try {
      check = ovr.checkOverride(ctx.worktreeRoot);
    } catch (_) {
      // If even the override check throws, we stay denied — fail closed.
      check = { override: false };
    }
    if (check && check.override) {
      try {
        ovr.writeReceipt(ctx.worktreeRoot, {
          reason: check.reason,
          command: ctx.command,
          action: ctx.action,
        });
      } catch (_) {
        // A receipt-write failure must NOT silently drop the audit AND allow.
        // If we cannot log the bypass, we cannot honor it → fail closed.
        return deny(
          'override present but its receipt could not be written — denying (fail closed)'
        );
      }
      return allow();
    }
    return deny(reason);
  }
}

module.exports = {
  readHookInput,
  deny,
  allow,
  emit,
  runGate,
  FailClosed,
  safeCommand,
};
