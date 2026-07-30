'use strict';

/**
 * hooks/lib/failclosed.cjs — the fail-closed enforcement harness (HARD-01).
 *
 * This module is THE single enforcement decision point. Every Wave 2-4 gate wraps its
 * policy logic in `runGate(gateFn, ctx)` so that the HARD-01 invariant is inherited,
 * not re-implemented (and therefore not accidentally fail-OPEN):
 *
 *   - gateFn returns a decision (deny|allow|ask)     → that decision is honored
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
 * sets the process exit semantics). The decision helpers (deny/allow/ask) are pure.
 *
 * `ask` (added 260729-p3f) is a THIRD severity for advisory signals that are real but not
 * precise enough to block on — the harness prompts instead of denying. It is only ever
 * produced by an explicit `ask()` return; it is NOT reachable from an error, an empty
 * decision, or an unrecognized decision value, all of which still DENY.
 *
 * @module hooks/lib/failclosed
 */

const override = require('./override.cjs');
// OBS-02 (Half B): the gate-verdict recorder. Required here because runGate is the single
// chokepoint every wired gate returns through. verdict-log is TOTAL (it cannot throw) and
// side-effect-free on require.
const { recordVerdict } = require('./verdict-log.cjs');

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
 * Build an ASK (advisory) decision: the harness PROMPTS the user rather than blocking.
 *
 * This is the severity for a signal that is real but not precise enough to be a deny.
 * Introduced for ENF-11's citation-overlap advisory (quick task 260729-p3f), whose MEASURED
 * recall is 2/9 at ~0.048 prompts per issue filed — useful, but nowhere near precise enough
 * to block on. A deny at that precision is the failure mode L3 already records: one gate's
 * misfire takes the whole suite offline.
 *
 * `ask` is NOT part of the fail-closed ladder. It must only ever be RETURNED deliberately by
 * a gate that has decided the signal is advisory. A thrown error, an empty decision, or any
 * unrecognized decision value still resolves to DENY (see `emit` and `runGate`) — teaching
 * the harness this third value does not soften that floor.
 *
 * @param {string} reason human-readable reason surfaced to the user in the prompt.
 * @returns {{permissionDecision: 'ask', permissionDecisionReason: string}}
 */
function ask(reason) {
  return {
    permissionDecision: 'ask',
    permissionDecisionReason: String(reason == null ? 'confirmation requested' : reason),
  };
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
  // EXACTLY three recognized decisions. 'allow' and 'ask' must each match the literal;
  // EVERYTHING else — absent, empty, misspelled ('ASK', 'asks'), or an unknown future value
  // — collapses to 'deny'. That default is the fail-closed floor (HARD-01) and is asserted
  // byte-for-byte in failclosed.test.cjs; do not relax it to a permissive check.
  const raw = d.permissionDecision;
  const resolved = raw === 'allow' ? 'allow' : raw === 'ask' ? 'ask' : 'deny';
  const envelope = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: resolved,
    },
  };
  if (resolved === 'deny') {
    envelope.hookSpecificOutput.permissionDecisionReason =
      d.permissionDecisionReason || 'denied';
  } else if (resolved === 'ask') {
    // An ask with no reason is a bare, unexplainable prompt — give the user something.
    envelope.hookSpecificOutput.permissionDecisionReason =
      d.permissionDecisionReason || 'confirmation requested';
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
 * @param {string} [ctx.stdin] OBS-02: the raw harness payload, used ONLY to read
 *   `session_id`/`tool_use_id`/`tool_name` for the verdict log. Optional — absent, the record
 *   still writes with null ids. Never logged verbatim.
 * @param {{checkOverride: Function, writeReceipt: Function}} [ctx.overrideImpl]
 *   injectable seam for the override module (defaults to the real ./override.cjs) so
 *   tests stay deterministic and filesystem-free.
 * @param {Object} [ctx.verdictLogDeps] OBS-02 test seam forwarded to `recordVerdict`.
 * @returns {{permissionDecision: string, permissionDecisionReason?: string}}
 */
function runGate(gateFn, ctx = {}) {
  const startedAt = Date.now();
  const result = runGateInner(gateFn, ctx);
  // ── OBS-02 (Half B) ────────────────────────────────────────────────────────────────────────
  // The ONLY instrumentation point for all 15 wired gates, at zero new process spawns.
  //
  // This shape is chosen so three of the four non-negotiables hold STRUCTURALLY rather than by
  // discipline: the call cannot run before the decision (it is sequenced after), cannot alter it
  // (`result` is already bound and is returned unmodified), and cannot throw out of runGate (the
  // catch here, plus recordVerdict being total internally — belt AND braces, because this is the
  // file whose blast radius is every gate). A measurement failure must never become an
  // enforcement failure.
  //
  // Do NOT "simplify" this by inlining the log into the return paths of runGateInner: that would
  // put a mutable call site in front of each decision and reintroduce exactly the risk this
  // wrapper removes.
  // `recordVerdict` is itself total, so this catch is the SECOND layer. It is not decoration: a
  // future edit to verdict-log (or a require-time swap) could reintroduce a throw, and the cost of
  // being wrong here is all 15 gates going offline. `ctx.recordVerdictImpl` exists so this outer
  // guard is actually TESTABLE — mutation-testing showed that without an injectable recorder,
  // deleting this try/catch failed zero tests, i.e. the guarantee was asserted but not proven.
  const record = ctx.recordVerdictImpl || recordVerdict;
  try {
    record(ctx, result, Date.now() - startedAt, ctx.verdictLogDeps);
  } catch (_) {
    /* best-effort: a verdict that cannot be logged is dropped, never escalated */
  }
  return result;
}

/**
 * The unchanged fail-closed decision path (HARD-01). Split out of `runGate` by OBS-02 purely so
 * the verdict log can wrap a single computed result; not one line of its logic changed.
 *
 * @param {() => {permissionDecision: string, permissionDecisionReason?: string}} gateFn
 * @param {Object} ctx
 * @returns {{permissionDecision: string, permissionDecisionReason?: string}}
 */
function runGateInner(gateFn, ctx = {}) {
  const ovr = ctx.overrideImpl || override;
  try {
    const decision = gateFn();
    // A gate that RETURNS a decision (allow OR deny) made a real policy choice.
    // The override rescues ERRORS only — it never flips an intentional policy deny,
    // and a clean allow needs no receipt.
    if (decision && decision.permissionDecision === 'deny') {
      return deny(decision.permissionDecisionReason);
    }
    // An ASK is likewise a real policy choice (an advisory prompt), so it passes through
    // rather than falling into the `allow()` default below — otherwise a gate's advisory
    // would be silently discarded here and never reach the user. Like a deny, it is NOT an
    // error, so the override does not flip it and no receipt is written.
    if (decision && decision.permissionDecision === 'ask') {
      return ask(decision.permissionDecisionReason);
    }
    // HARD-05: only an EXPLICIT `allow` allows. This used to be a bare `return allow()`, i.e. the
    // fall-through for ANY value that was not deny/ask — `undefined`, `null`, `{}`, a misspelled
    // `'ALLOW'`. A gate whose code path fell off the end (a future refactor, a stray early
    // `return;`) therefore produced a SILENT ALLOW at the one place this design promises cannot
    // fail open. `emit()` already collapses such values to deny, but runGate converted them into a
    // well-formed `allow()` FIRST, so emit's floor never saw them — the second layer was
    // unreachable for exactly the inputs it existed to catch.
    //
    // Narrows-not-weakens: every gate already returns allow()/deny()/ask(), so no legitimate path
    // changes (proven by the full suite staying green across all 15 gates).
    if (decision && decision.permissionDecision === 'allow') {
      return allow();
    }
    return deny(
      'gate returned a malformed decision (' +
        (decision && typeof decision === 'object'
          ? 'permissionDecision=' + JSON.stringify(decision.permissionDecision)
          : typeof decision) +
        ') — only an explicit `allow` allows; failing closed (HARD-05)'
    );
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
  ask,
  emit,
  runGate,
  FailClosed,
  safeCommand,
};
