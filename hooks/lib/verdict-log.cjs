'use strict';

/**
 * hooks/lib/verdict-log.cjs — OBS-02, the gate-verdict recorder (Half B).
 *
 * Half A (`hooks/tool-recorder.cjs`, OBS-01) records calls that RAN, on PostToolUse. It is
 * structurally blind to the one population that matters most here: `tool-recorder.cjs:21` notes
 * that neither PostToolUse nor PostToolUseFailure fires for a call a PreToolUse gate DENIED — the
 * tool never ran, so there is no "post" to observe. Half A therefore yields the denominator and
 * can never yield the numerator. This module is the numerator: every gate's real allow/deny/ask
 * verdict, plus how long the gate itself took.
 *
 * It is called from ONE place — `runGate` in `failclosed.cjs` — so a single ~10-line wrapper
 * instruments all 15 wired gates at **zero new process spawns**. (The obvious alternative,
 * registering a recorder on `PreToolUse` with matcher `*`, would spawn a subprocess on every tool
 * call in every session and would still have to infer denies by absence — ambiguous between a
 * toolkit deny, a declined permission prompt, and an unrelated hook.)
 *
 * ── THE HAZARD IS L3 LOOKING BACK AT US ───────────────────────────────────────────────────────
 * `failclosed.cjs` is precisely the file whose blast radius is the whole suite. Instrumentation
 * that could itself fail closed would BE the defect it is meant to measure — one component's
 * misfire taking all fifteen gates offline. So, non-negotiably:
 *
 *   1. NEVER THROWS. `recordVerdict` is a total function: every path is inside a try/catch that
 *      swallows everything, including filesystem and serialization errors and hostile getters.
 *   2. NEVER ALTERS THE DECISION. It receives the already-computed decision by value and returns
 *      only a log path or null. The caller ignores the return.
 *   3. BEST-EFFORT. A failed or dropped write returns null rather than escalating.
 *   4. KILL SWITCH. `GSD_CONTRIB_NO_VERDICT_LOG` (any non-blank value) disables recording without
 *      touching a line of gate logic.
 *
 * ── WHAT MUST NOT BE RECORDED ─────────────────────────────────────────────────────────────────
 * `tool_input` is tool-shaped and hostile to naive logging: `Write` carries the ENTIRE file in
 * `tool_input.content`, `Bash` carries raw command lines that routinely contain tokens and paths,
 * and `tool_response` carries full command output. Recording those verbatim would create a
 * high-volume secret-bearing log as a side effect of a measurement exercise — a worse liability
 * than the gap it closes. So the record carries the CLASSIFIED action only (via `classify.cjs`,
 * which already knows how to reduce a command to a governed action name) and never the command
 * itself. `verdict-log.test.cjs` pins this by asserting a planted token never appears.
 *
 * NAMING: `OBS-`, deliberately not `ENF-`. A recorder enforces nothing, and nothing may enter the
 * enforcement register that cannot deny.
 *
 * @module hooks/lib/verdict-log
 */

const { appendRecord } = require('../tool-recorder.cjs');
const { parseCommand } = require('./argv.cjs');
const { classifyAction } = require('./classify.cjs');

/** Env var that turns recording off entirely. Any non-blank value disables. */
const KILL_SWITCH = 'GSD_CONTRIB_NO_VERDICT_LOG';

/**
 * Is recording disabled? Opt-OUT: absent or blank means enabled, so the instrument is on by
 * default and a deliberate act is required to blind it.
 *
 * @param {Object} [env]
 * @returns {boolean}
 */
function isDisabled(env = process.env) {
  const v = env && env[KILL_SWITCH];
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * Best-effort parse of the harness payload. Returns {} on anything unparseable or non-object —
 * a missing id is recorded as null, never as a throw.
 *
 * @param {string} [stdinString]
 * @returns {Object}
 */
function safePayload(stdinString) {
  try {
    const o = JSON.parse(stdinString);
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  } catch (_) {
    return {};
  }
}

/**
 * Reduce a command to its governed action NAME via the shared classifier — never the command.
 * Returns null when it cannot be classified (unparseable, absent, or a classifier throw).
 *
 * @param {string} [command]
 * @returns {string|null}
 */
function classifiedAction(command) {
  try {
    if (typeof command !== 'string' || command.length === 0) return null;
    const parsed = parseCommand(command);
    if (!parsed || !parsed.ok) return null;
    const a = classifyAction(parsed);
    return (a && a.action) || null;
  } catch (_) {
    return null;
  }
}

/**
 * Normalize a decision to exactly one of allow|deny|ask.
 *
 * Mirrors `emit()`'s fail-closed default byte-for-byte: 'allow' and 'ask' must each match the
 * literal, and EVERYTHING else — absent, empty, misspelled, or an unknown future value —
 * collapses to 'deny'. The log must not read more permissive than the harness acted.
 *
 * @param {Object} [decision]
 * @returns {'allow'|'deny'|'ask'}
 */
function decisionOf(decision) {
  const raw = decision && typeof decision === 'object' ? decision.permissionDecision : undefined;
  return raw === 'allow' ? 'allow' : raw === 'ask' ? 'ask' : 'deny';
}

/**
 * Build the record. Pure — no I/O, no env read. Exported so the shape is testable without a writer.
 *
 * @param {Object} ctx the runGate ctx ({action, command, stdin}).
 * @param {Object} decision the already-computed decision.
 * @param {number} durationMs how long the gate itself took.
 * @returns {Object} the record.
 */
function buildRecord(ctx, decision, durationMs) {
  const c = ctx && typeof ctx === 'object' ? ctx : {};
  const payload = safePayload(c.stdin);
  return {
    ts: new Date().toISOString(),
    source: 'pretooluse-gate',
    gate: typeof c.action === 'string' ? c.action : null,
    session_id: typeof payload.session_id === 'string' ? payload.session_id : null,
    tool_use_id: typeof payload.tool_use_id === 'string' ? payload.tool_use_id : null,
    tool_name: typeof payload.tool_name === 'string' ? payload.tool_name : null,
    action: classifiedAction(c.command),
    decision: decisionOf(decision),
    duration_ms: typeof durationMs === 'number' && isFinite(durationMs) ? durationMs : null,
    cwd: safeCwd(),
  };
}

/**
 * process.cwd() can throw (deleted working directory). Never let that reach the caller.
 * @returns {string|null}
 */
function safeCwd() {
  try {
    return process.cwd();
  } catch (_) {
    return null;
  }
}

/**
 * Record one gate verdict. TOTAL — this function cannot throw, by construction.
 *
 * @param {Object} ctx the runGate ctx.
 * @param {Object} decision the already-computed decision (never mutated, never inspected for
 *   anything but its `permissionDecision`).
 * @param {number} durationMs
 * @param {Object} [deps]
 * @param {Object} [deps.env] injectable env (kill-switch read).
 * @param {(line: string, deps?: Object) => (string|null)} [deps.writer] injectable append seam;
 *   defaults to tool-recorder's `appendRecord` (shared rotation + silent-drop, so this module
 *   duplicates none of it).
 * @returns {string|null} the log path written, or null when disabled/dropped/failed.
 */
function recordVerdict(ctx, decision, durationMs, deps = {}) {
  try {
    const env = deps.env || process.env;
    if (isDisabled(env)) return null;
    const writer = deps.writer || appendRecord;
    const line = JSON.stringify(buildRecord(ctx, decision, durationMs)) + '\n';
    return writer(line, deps) || null;
  } catch (_) {
    // Swallow EVERYTHING: fs errors, serialization errors, hostile getters, a writer that throws.
    // A measurement failure must never become an enforcement failure (constraint 1).
    return null;
  }
}

module.exports = {
  recordVerdict,
  buildRecord,
  isDisabled,
  decisionOf,
  classifiedAction,
  KILL_SWITCH,
};
