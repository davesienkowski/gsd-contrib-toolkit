'use strict';

/**
 * hooks/lib/tool-log-reader.cjs — the bounded, session-scoped reader of tool-recorder's log
 * (OBS-01, hooks/tool-recorder.cjs) that ENF-20's R8a-memtrace obligation (re-review step 8a)
 * reads as evidence.
 *
 * ── WHAT IT RETURNS ─────────────────────────────────────────────────────────────────────
 * `readSessionRecords(sessionId, opts)` → `{recorderOff, complete, records, problems}`:
 *   - `records`: one `{tool_name, outcome}` per RECORDER row of THIS session. Nothing else from
 *     a row survives (no cwd, no ts, no ids): the gate needs to know which tools RAN, and a
 *     decision reason must never echo log content.
 *   - `complete`: false when the log could not be fully read (absent, unreadable). A caller must
 *     treat "no evidence found" in an incomplete read as cannot-observe, not did-not-run.
 *   - `problems`: short strings naming a BASENAME and an error CODE only — never a path or a
 *     message body.
 *   - `recorderOff`: reserved for the recorder kill switch (38-02); always false in this form.
 *
 * ── HOW A ROW COUNTS (T-38-01 / T-38-02) ────────────────────────────────────────────────
 * The byte needle `"session_id":<JSON id>` is a SPEED prefilter only — it matches exactly how
 * tool-recorder's `JSON.stringify` emitted the key. A row counts only after the whole line
 * JSON.parses, its `session_id` STRICTLY equals the query, it has NO `source` key (gate verdict
 * rows written by hooks/lib/verdict-log.cjs into the same file never count), its `tool_name` is a
 * string, and its `outcome` is `ok` or `fail`. A malformed or torn line is skipped, never thrown.
 *
 * ── BOUNDS ──────────────────────────────────────────────────────────────────────────────
 * The live file is read in SCAN_CHUNK_BYTES chunks up to a size snapshot taken once at open, so
 * concurrent appends after the snapshot are not chased. Tracer form: the rotated slot
 * (`tool-log.1.jsonl`), byte caps and a time budget arrive in 38-02 without reshaping the result.
 *
 * TOTAL: never throws. The environment is read ONLY through `opts.env` (default process.env).
 *
 * @module hooks/lib/tool-log-reader
 */

const fs = require('node:fs');
const path = require('node:path');

// ONE path resolution: the reader finds the log exactly where the recorder writes it.
const { resolveLogDir, LOG_FILENAME } = require('../tool-recorder.cjs');

/** Read granularity for the needle scan (1 MiB). */
const SCAN_CHUNK_BYTES = 1024 * 1024;

const NEWLINE = 0x0a;

/**
 * The byte needle a recorder row for `id` contains, exactly as JSON.stringify emits it.
 *
 * @param {string} id
 * @returns {string}
 */
function sessionNeedle(id) {
  return '"session_id":' + JSON.stringify(id);
}

/**
 * Parse one candidate line and project it, or return null when it must not count.
 *
 * @param {Buffer} buf
 * @param {number} start
 * @param {number} end exclusive
 * @param {string} id
 * @returns {{tool_name:string, outcome:string}|null}
 */
function projectLine(buf, start, end, id) {
  let rec;
  try {
    rec = JSON.parse(buf.toString('utf8', start, end));
  } catch (_) {
    return null; // malformed / torn line → skip, never throw
  }
  if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) return null;
  if (rec.session_id !== id) return null;
  if (rec.source !== undefined) return null; // a gate verdict row, not a recorded tool call
  if (typeof rec.tool_name !== 'string') return null;
  if (rec.outcome !== 'ok' && rec.outcome !== 'fail') return null;
  return { tool_name: rec.tool_name, outcome: rec.outcome };
}

/**
 * Scan `buf[0, regionEnd)` (which ends on a line boundary, or at EOF) for needle hits and push
 * each enclosing line's projection. Each line is considered at most once.
 *
 * @param {Buffer} buf
 * @param {number} regionEnd
 * @param {Buffer} needle
 * @param {string} id
 * @param {Array} out
 */
function scanRegion(buf, regionEnd, needle, id, out) {
  let from = 0;
  while (from < regionEnd) {
    const hit = buf.indexOf(needle, from);
    if (hit === -1 || hit >= regionEnd) return;
    const lineStart = buf.lastIndexOf(NEWLINE, hit) + 1;
    let lineEnd = buf.indexOf(NEWLINE, hit);
    if (lineEnd === -1 || lineEnd > regionEnd) lineEnd = regionEnd;
    const r = projectLine(buf, lineStart, lineEnd, id);
    if (r) out.push(r);
    from = lineEnd + 1; // resume AFTER the line so it cannot be counted twice
  }
}

/**
 * Read every recorder row of `sessionId`, projected to `{tool_name, outcome}`.
 *
 * @param {string} sessionId the PreToolUse payload's session id
 * @param {Object} [opts]
 * @param {Object} [opts.env] environment (default process.env) — only GSD_CONTRIB_LOG_DIR is read
 * @param {Object} [opts.fsImpl] fs seam (openSync/fstatSync/readSync/closeSync)
 * @param {number} [opts.chunkBytes] scan chunk size (default SCAN_CHUNK_BYTES)
 * @returns {{recorderOff:boolean, complete:boolean, records:Array<{tool_name:string, outcome:string}>, problems:string[]}}
 */
function readSessionRecords(sessionId, opts = {}) {
  const result = { recorderOff: false, complete: true, records: [], problems: [] };
  try {
    const env = opts.env || process.env;
    const impl = opts.fsImpl || fs;
    const chunkBytes =
      Number.isInteger(opts.chunkBytes) && opts.chunkBytes > 0 ? opts.chunkBytes : SCAN_CHUNK_BYTES;

    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      result.complete = false;
      result.problems.push('no session id to scope ' + LOG_FILENAME);
      return result;
    }

    const file = path.join(resolveLogDir(env), LOG_FILENAME);
    const needle = Buffer.from(sessionNeedle(sessionId), 'utf8');

    let fd;
    try {
      fd = impl.openSync(file, 'r');
    } catch (err) {
      result.complete = false;
      result.problems.push(
        err && err.code === 'ENOENT'
          ? 'log absent: ' + LOG_FILENAME
          : 'unreadable ' + LOG_FILENAME + ': ' + codeOf(err)
      );
      return result;
    }

    try {
      const size = impl.fstatSync(fd).size; // snapshot once; later appends are not chased
      let carry = Buffer.alloc(0);
      let pos = 0;
      while (pos < size) {
        const want = Math.min(chunkBytes, size - pos);
        const chunk = Buffer.alloc(want);
        const n = impl.readSync(fd, chunk, 0, want, pos);
        if (!n) break; // truncated under us: stop at what we have
        pos += n;
        const buf = carry.length ? Buffer.concat([carry, chunk.subarray(0, n)]) : chunk.subarray(0, n);
        const lastNl = buf.lastIndexOf(NEWLINE);
        if (lastNl === -1) {
          carry = buf; // no complete line yet
          continue;
        }
        scanRegion(buf, lastNl, needle, sessionId, result.records);
        carry = buf.subarray(lastNl + 1);
      }
      // A final line without a trailing newline (e.g. an append in flight): parse it; a torn
      // write fails JSON.parse and is skipped.
      if (carry.length) scanRegion(carry, carry.length, needle, sessionId, result.records);
    } finally {
      try {
        impl.closeSync(fd);
      } catch (_) {
        /* closing a read fd cannot change the result */
      }
    }
  } catch (err) {
    result.complete = false;
    result.problems.push('unreadable ' + LOG_FILENAME + ': ' + codeOf(err));
  }
  return result;
}

/**
 * An error's CODE only (never its message, which can carry a path).
 *
 * @param {*} err
 * @returns {string}
 */
function codeOf(err) {
  return err && typeof err.code === 'string' && /^[A-Z0-9_]{1,32}$/.test(err.code) ? err.code : 'EUNKNOWN';
}

module.exports = { readSessionRecords, sessionNeedle, SCAN_CHUNK_BYTES };
