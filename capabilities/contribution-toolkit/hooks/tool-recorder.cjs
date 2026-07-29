#!/usr/bin/env node
'use strict';

/**
 * hooks/tool-recorder.cjs — OBS-01, the executed-call recorder
 * (PostToolUse + PostToolUseFailure; D1–D6 of .planning/notes/2026-07-29-L2-observability-design.md).
 *
 * ── WHAT THIS IS ────────────────────────────────────────────────────────────────────────
 * Every other hook in this suite ENFORCES. This one OBSERVES and nothing else. It appends one
 * classified metadata line per COMPLETED tool call so that "which gate has ever mattered?" can
 * eventually be answered from evidence instead of from memory.
 *
 * It is named OBS-01, NOT ENF-20, and that is load-bearing: `ENF` means enforcement, and a
 * recorder enforces nothing. Nothing may appear in the ENF sequence that cannot deny. (ENF-20 is
 * separately reserved for the review-side artifact gates — CONTINUE-HERE.md:127.)
 *
 * ── WHAT IT CAN AND CANNOT SEE (state this before quoting any number off the log) ────────
 *   - `PostToolUse` fires ONLY when a tool call SUCCEEDS.
 *   - Failures fire a SEPARATE event, `PostToolUseFailure`, carrying `error` + `is_interrupt`
 *     INSTEAD of `tool_response`.
 *   - NEITHER fires for a call a PreToolUse gate DENIED — the tool never ran, so there is no
 *     "post" to observe.
 *
 * So this log is the DENOMINATOR (calls that ran, split by outcome) and is STRUCTURALLY BLIND to
 * the numerator (calls a gate blocked). It is necessary but NOT sufficient to answer "which gate
 * ever denied anything real" — that needs the separate verdict instrumentation inside
 * `hooks/lib/failclosed.cjs` (Half B), which is deliberately not attempted here.
 *
 * ── WHY IT DOES NOT USE runGate()/emit() FROM hooks/lib/failclosed.cjs (D3) ──────────────
 * Two independent reasons, both disqualifying:
 *
 *   1. FAIL-CLOSED IS THE WRONG POSTURE HERE. `runGate` converts any throw into a DENY. There is
 *      no decision to fail closed on: the tool has ALREADY executed. A PostToolUse hook cannot
 *      block, un-execute, or halt anything. This is the ONE hook in the suite where FAIL-OPEN is
 *      correct — a serialization bug must cost a dropped record, never a disrupted turn. Do not
 *      "fix" this into consistency with the fourteen fail-closed gates.
 *   2. emit() HARDCODES `hookEventName: 'PreToolUse'` in its envelope (failclosed.cjs:114-118),
 *      so it cannot address a PostToolUse envelope at all.
 *
 * Therefore: emit NOTHING on stdout, exit 0 ALWAYS, and wrap the whole body in a total try/catch
 * that swallows everything. Never exit 2 — for these events a non-zero exit only surfaces stderr
 * to the model, which is noise with no benefit.
 *
 * ── WHAT IS RECORDED, AND WHAT MUST NEVER BE (D2) ───────────────────────────────────────
 * `tool_input` is hostile to naive logging: `Write` carries the ENTIRE file content in
 * `tool_input.content`; `Bash` carries RAW command lines that routinely contain tokens and
 * secrets; `tool_response` carries full command output. Creating a high-volume secret-bearing log
 * as a side effect of a measurement exercise would be a worse liability than the gap it closes.
 *
 *   RECORDED: ts, session_id, tool_use_id, tool_name, outcome, duration_ms, cwd,
 *             + for Bash ONLY: the CLASSIFIED action (via hooks/lib/classify.cjs) and a boolean
 *               `governed`, + for a failure ONLY: a short redacted `error_kind`.
 *   NEVER:    tool_input.content, tool_response, any raw command string, any error message body.
 *
 * The raw command is read ONLY to hand to the shared classifier and is never retained. Asserted,
 * not assumed — see hooks/tool-recorder.test.cjs.
 *
 * ── STORAGE (D1, D4) ────────────────────────────────────────────────────────────────────
 * Writes to `~/.gsd-contrib/tool-log.jsonl` (override the DIRECTORY with GSD_CONTRIB_LOG_DIR) —
 * a USER-level path, deliberately NOT the per-worktree `.gsd-contrib/` receipt convention. GSD
 * worktree isolation creates and DELETES worktrees routinely (`worktree.cleanup-wave` removes them
 * on every phase/quick task), so a per-worktree log would be destroyed by ordinary cleanup,
 * silently destroying exactly the 30-day dataset this exists to accumulate. A recorder whose data
 * evaporates is worse than no recorder, because it looks like it is working.
 *
 * Records are kept WELL under 4096 bytes so POSIX guarantees the O_APPEND write is atomic against
 * concurrent hook processes, and the log rotates once at 50 MB rather than growing unbounded.
 *
 * ── KILL SWITCH (D6) ────────────────────────────────────────────────────────────────────
 * `GSD_CONTRIB_RECORD=off` disables recording. This is NOT `GSD_CONTRIB_OVERRIDE` — that valve
 * rescues THROWN gate errors and must not be overloaded here.
 *
 * @module hooks/tool-recorder
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseCommand } = require('./lib/argv.cjs');
const { classifyAction } = require('./lib/classify.cjs');

/** Default log directory (D1). `GSD_CONTRIB_LOG_DIR` overrides the DIRECTORY, not the filename. */
const LOG_DIRNAME = '.gsd-contrib';
/** The append target. */
const LOG_FILENAME = 'tool-log.jsonl';
/** The single rotation slot — overwritten each time, so growth is bounded at 2 files (D4). */
const ROTATED_FILENAME = 'tool-log.1.jsonl';
/** Rotate once past this size (D4). */
const MAX_LOG_BYTES = 50 * 1024 * 1024;

/**
 * POSIX guarantees an O_APPEND write is atomic only below PIPE_BUF/page-size limits; 4096 is the
 * conservative floor every implementation honours. Records are capped WELL under it so concurrent
 * hook processes cannot interleave a line (D4).
 */
const MAX_RECORD_BYTES = 2048;

/**
 * Per-field character caps. Bounded BEFORE serialization so no single field can push a record past
 * MAX_RECORD_BYTES, and so a pathological `tool_name`/`cwd` cannot smuggle bulk into the log.
 */
const LIMITS = Object.freeze({
  session_id: 64,
  tool_use_id: 64,
  tool_name: 64,
  cwd: 512,
  action: 32,
  error_kind: 80,
});

/**
 * The actions this toolkit's gates govern, as classified by hooks/lib/classify.cjs. `governed` is
 * the boolean L1 will actually group by: it separates "a Bash call the enforcement layer could
 * conceivably have blocked" from the overwhelming majority (`ls`, `grep`, `node --test`) it never
 * looks at. Kept as a union of the wired gates' own GOVERNED_ACTIONS sets.
 */
const GOVERNED_ACTIONS = Object.freeze(
  new Set(['issue-create', 'pr-create', 'issue-edit', 'pr-edit', 'commit', 'push'])
);

/**
 * Redact + bound one string field. Strips control characters (which would otherwise expand ~6x
 * under JSON escaping and could inject newlines into a LINE-delimited log), collapses whitespace,
 * and truncates. Returns null for anything absent or empty.
 *
 * @param {*} v
 * @param {number} max
 * @returns {string|null}
 */
function clean(v, max) {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') return null;
  const s = String(v)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length === 0) return null;
  return s.slice(0, max);
}

/**
 * Reduce a failure payload's `error` to a SHORT, redacted kind — never a message body (D2).
 *
 * Strategy, in order of preference:
 *   1. a structured `code`/`name` string on an error object (`ENOENT`, `TypeError`) — the ideal
 *      case: already a class, carries no free text;
 *   2. otherwise the FIRST TOKEN of the first line of the message. An error message's first word
 *      is essentially always class-ish ("Error:", "ENOENT:", "bash:", "Command"); secrets live in
 *      the body, not the leading token.
 *
 * The chosen token is then REFUSED (→ null) if it looks like a path, a URL, an assignment, an
 * address, or a long opaque blob — i.e. anything that could be a leaked secret or identifying
 * path. A dropped error_kind is strictly better than a leaked one.
 *
 * @param {*} err the payload's `error` field, whatever shape it arrives in
 * @returns {string|null}
 */
function errorKind(err) {
  if (err === null || err === undefined) return null;

  if (typeof err === 'object' && !Array.isArray(err)) {
    for (const key of ['code', 'name', 'type']) {
      const v = clean(err[key], LIMITS.error_kind);
      if (v && !looksSensitive(v)) return v;
    }
    const msg = clean(err.message, LIMITS.error_kind * 4);
    return msg ? firstSafeToken(msg) : null;
  }

  const s = clean(err, LIMITS.error_kind * 4);
  return s ? firstSafeToken(s) : null;
}

/**
 * The first whitespace-delimited token of a cleaned string, stripped of trailing punctuation, or
 * null when that token looks sensitive.
 *
 * @param {string} s
 * @returns {string|null}
 */
function firstSafeToken(s) {
  const tok = String(s).split(' ')[0].replace(/[.,;:]+$/, '');
  if (!tok) return null;
  if (looksSensitive(tok)) return null;
  return tok.slice(0, LIMITS.error_kind);
}

/**
 * Does this token look like a path, URL, assignment, address, or opaque blob? Deliberately
 * OVER-broad: a false refusal costs one null field; a false accept costs a secret in a log.
 *
 * @param {string} tok
 * @returns {boolean}
 */
function looksSensitive(tok) {
  const t = String(tok);
  if (t.includes('/') || t.includes('\\')) return true; // path or URL
  if (t.includes('=') || t.includes('@')) return true; // assignment / address
  if (/[A-Za-z0-9_-]{20,}/.test(t)) return true; // opaque blob / token
  return false;
}

/**
 * Classify a Bash command WITHOUT retaining it (D2). The raw string reaches the shared classifier
 * and nothing else; only the resulting action name and the `governed` boolean survive this
 * function. A classifier throw degrades to `action: null` — an observation-only hook must never
 * turn a parse edge case into a visible failure.
 *
 * (classify.cjs also exports findActionSegment, which picks WHICH segment of a chain matched. That
 * is a gate concern — a recorder only needs the action name, so classifyAction alone is used.)
 *
 * @param {string} command
 * @returns {{action: (string|null), governed: boolean}}
 */
function classifyCommand(command) {
  try {
    const parsed = parseCommand(String(command));
    const res = classifyAction(parsed);
    const action = clean(res && res.action, LIMITS.action);
    return { action, governed: action !== null && GOVERNED_ACTIONS.has(action) };
  } catch (_) {
    return { action: null, governed: false };
  }
}

/**
 * Read the event name from either the snake_case field the harness documents (`hook_event_name`)
 * or the camelCase spelling used in emitted envelopes, then fall back to SHAPE: `PostToolUse`
 * carries `tool_response`, `PostToolUseFailure` carries `error` instead. Shape inference exists so
 * a field rename upstream degrades to "still recording" rather than "silently recording nothing".
 *
 * @param {Object} input parsed payload
 * @returns {'ok'|'fail'|null} null when the payload is not a recognisable post-tool event.
 */
function outcomeOf(input) {
  const evt = input.hook_event_name || input.hookEventName;
  if (evt === 'PostToolUse') return 'ok';
  if (evt === 'PostToolUseFailure') return 'fail';
  if (typeof evt === 'string' && evt.length > 0) return null; // some OTHER event — not ours
  if (Object.prototype.hasOwnProperty.call(input, 'error')) return 'fail';
  if (Object.prototype.hasOwnProperty.call(input, 'tool_response')) return 'ok';
  return null;
}

/**
 * THE PURE CORE. Turn a raw stdin payload into the record to append — or null when there is
 * nothing to record. Every impure read is injected, so the unit suite is hermetic (no filesystem,
 * no clock, no real environment).
 *
 * NEVER THROWS on hostile input: an unparseable payload returns null. That is the fail-open proof
 * — the caller has nothing to catch because there is nothing to fail.
 *
 * @param {string} stdinString raw PostToolUse / PostToolUseFailure JSON
 * @param {Object} [deps]
 * @param {Object} [deps.env] environment (default process.env) — read for the D6 kill switch.
 * @param {() => string} [deps.now] ISO-8601 timestamp source (default the real clock).
 * @param {() => string} [deps.cwd] fallback cwd when the payload omits one (default process.cwd).
 * @returns {Object|null} the record, or null when skipped (disabled / malformed / not our event).
 */
function recordToolCall(stdinString, deps = {}) {
  const env = deps.env || process.env;

  // D6 kill switch — checked FIRST so a disabled recorder does no parsing at all.
  if (String(env.GSD_CONTRIB_RECORD || '').trim().toLowerCase() === 'off') return null;

  let input;
  try {
    input = JSON.parse(String(stdinString));
  } catch (_) {
    return null; // malformed stdin → drop the record, never a throw (D3)
  }
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return null;

  const outcome = outcomeOf(input);
  if (outcome === null) return null;

  const now = deps.now || (() => new Date().toISOString());
  const cwdOf = deps.cwd || (() => process.cwd());

  const duration = input.duration_ms !== undefined ? input.duration_ms : input.durationMs;

  const record = {
    ts: clean(now(), 40),
    session_id: clean(input.session_id, LIMITS.session_id),
    tool_use_id: clean(input.tool_use_id, LIMITS.tool_use_id),
    tool_name: clean(input.tool_name, LIMITS.tool_name),
    outcome,
    duration_ms: Number.isFinite(duration) ? Math.round(duration) : null,
    cwd: clean(input.cwd !== undefined ? input.cwd : cwdOf(), LIMITS.cwd),
  };

  // Bash ONLY: the classified action + the governed boolean. The command itself is NEVER stored.
  if (record.tool_name === 'Bash') {
    const cmd = input.tool_input && input.tool_input.command;
    const { action, governed } = classifyCommand(typeof cmd === 'string' ? cmd : '');
    record.action = action;
    record.governed = governed;
  }

  // Failures ONLY: a short, redacted KIND — never the message body (D2).
  if (outcome === 'fail') {
    record.error_kind = errorKind(input.error);
  }

  return record;
}

/**
 * Serialize a record to its JSONL line, ENFORCING the atomic-append size bound (D4). A record that
 * still exceeds MAX_RECORD_BYTES after the per-field caps is DROPPED (null) rather than written
 * un-bounded: a torn line in a concurrent append corrupts the neighbouring record too, so a
 * missing observation is strictly cheaper than a corrupt one.
 *
 * @param {Object|null} record
 * @returns {string|null} the line (with trailing newline), or null when there is nothing to write.
 */
function serializeRecord(record) {
  if (!record || typeof record !== 'object') return null;
  let line;
  try {
    line = JSON.stringify(record) + '\n';
  } catch (_) {
    return null;
  }
  if (Buffer.byteLength(line, 'utf8') > MAX_RECORD_BYTES) return null;
  return line;
}

/**
 * Resolve the log directory (D1): `GSD_CONTRIB_LOG_DIR` when set and non-blank, else
 * `~/.gsd-contrib`.
 *
 * @param {Object} [env]
 * @returns {string}
 */
function resolveLogDir(env = process.env) {
  const override = env.GSD_CONTRIB_LOG_DIR;
  if (typeof override === 'string' && override.trim().length > 0) return override.trim();
  return path.join(os.homedir(), LOG_DIRNAME);
}

/**
 * Append one line, rotating once past MAX_LOG_BYTES (D4). Best-effort throughout: if the directory
 * cannot be created, or the append fails, the record is DROPPED SILENTLY. There is no failure mode
 * here worth surfacing to a user mid-turn.
 *
 * @param {string} line
 * @param {Object} [deps]
 * @param {Object} [deps.env]
 * @param {Object} [deps.fsImpl] injectable fs seam (mkdirSync/statSync/renameSync/appendFileSync).
 * @returns {string|null} the absolute path written, or null when nothing was written.
 */
function appendRecord(line, deps = {}) {
  if (typeof line !== 'string' || line.length === 0) return null;
  const env = deps.env || process.env;
  const impl = deps.fsImpl || fs;
  const dir = resolveLogDir(env);
  const file = path.join(dir, LOG_FILENAME);

  try {
    impl.mkdirSync(dir, { recursive: true });
  } catch (_) {
    return null; // cannot create the log dir → drop the record silently (D4)
  }

  // Rotate ONCE, overwriting any previous rotation, so the on-disk footprint is bounded at two
  // files. An unreadable/absent log is simply "not yet big enough".
  try {
    const st = impl.statSync(file);
    if (st && st.size > MAX_LOG_BYTES) {
      impl.renameSync(file, path.join(dir, ROTATED_FILENAME));
    }
  } catch (_) {
    /* no existing log, or an unreadable stat — nothing to rotate */
  }

  try {
    impl.appendFileSync(file, line, { encoding: 'utf8' });
  } catch (_) {
    return null;
  }
  return file;
}

/**
 * Read stdin, record, append. TOTAL try/catch, ZERO stdout, ALWAYS exit 0 (D3).
 */
function main() {
  try {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('error', () => { process.exitCode = 0; });
    process.stdin.on('data', (c) => {
      buf += c;
    });
    process.stdin.on('end', () => {
      try {
        appendRecord(serializeRecord(recordToolCall(buf)));
      } catch (_) {
        /* observation must never disrupt a turn */
      }
      process.exitCode = 0;
    });
  } catch (_) {
    /* observation must never disrupt a turn */
  }
  process.exitCode = 0;
}

if (require.main === module) {
  main();
}

module.exports = {
  recordToolCall,
  serializeRecord,
  appendRecord,
  resolveLogDir,
  classifyCommand,
  errorKind,
  firstSafeToken,
  looksSensitive,
  outcomeOf,
  clean,
  GOVERNED_ACTIONS,
  LIMITS,
  MAX_RECORD_BYTES,
  MAX_LOG_BYTES,
  LOG_FILENAME,
  ROTATED_FILENAME,
  LOG_DIRNAME,
};
