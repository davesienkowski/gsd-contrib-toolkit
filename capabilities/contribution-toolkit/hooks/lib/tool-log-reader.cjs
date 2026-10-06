'use strict';

/**
 * hooks/lib/tool-log-reader.cjs — the bounded, session-scoped reader of tool-recorder's log
 * (OBS-01, hooks/tool-recorder.cjs) that ENF-20's R8a-memtrace obligation (re-review step 8a)
 * reads as evidence.
 *
 * ── WHAT IT RETURNS ─────────────────────────────────────────────────────────────────────
 * `readSessionRecords(sessionId, opts)` → `{recorderOff, complete, records, problems}`:
 *   - `recorderOff`: true when tool-recorder's own kill switch (`isRecorderOff`, imported — the
 *     switch has ONE definition) says recording is disabled. Nothing is read in that case.
 *   - `records`: one `{tool_name, outcome}` per RECORDER row of THIS session, from every file that
 *     was scanned (also from the readable part of a file that later failed). Nothing else from a
 *     row survives (no cwd, no ts, no ids): the gate needs to know which tools RAN, and a
 *     decision reason must never echo log content.
 *   - `complete`: true only when there are no problems AND at least one file was scanned. A caller
 *     must treat "no evidence found" in an incomplete read as cannot-observe, not did-not-run;
 *     evidence that WAS found is real regardless.
 *   - `problems`: short strings carrying BASENAMES, error CODES and fixed words only — never a
 *     path or a message body.
 *
 * ── HOW A ROW COUNTS (T-38-01 / T-38-02 / T-38-08) ──────────────────────────────────────
 * The query id is normalized with tool-recorder's OWN `clean()` and `LIMITS.session_id`, so it
 * equals what the recorder stored for the same payload id (a 65-char id is truncated to 64, a
 * newline becomes a space). The byte needle `"session_id":<JSON id>` is a SPEED prefilter only.
 * A row counts only after the whole line JSON.parses, its `session_id` STRICTLY equals the
 * normalized id (so `sess-AB` / `xsess-A` never match `sess-A`, and a duplicate-key line is
 * judged by the LAST key JSON.parse keeps), it has NO `source` key (gate verdict rows written by
 * hooks/lib/verdict-log.cjs into the same file never count), its `tool_name` is a string, and its
 * `outcome` is `ok` or `fail`. A malformed or torn line is skipped, never thrown.
 *
 * ── WHICH FILES, IN WHICH ORDER ─────────────────────────────────────────────────────────
 * `tool-log.jsonl` FIRST, then the single rotated slot `tool-log.1.jsonl`. appendRecord renames
 * live → .1 and then appends to a fresh live file, so reading live first can only double-read a
 * row that moved between the two reads, never miss one; the caller compares SETS, so a row seen
 * twice is harmless. An absent file is skipped; both absent is the problem
 * `log absent: tool-log.jsonl, tool-log.1.jsonl`.
 *
 * ── BOUNDS (T-38-06) ────────────────────────────────────────────────────────────────────
 *   - Each file is read in SCAN_CHUNK_BYTES chunks up to a size snapshot taken once at open, so
 *     concurrent appends after the snapshot are not chased.
 *   - A file larger than MAX_SCAN_BYTES is NOT scanned at all (problem `<basename> exceeds the
 *     scan cap …`). No partial tail is read: a truncated window could miss evidence that exists
 *     and turn cannot-observe into a false deny.
 *   - A time budget (READ_BUDGET_MS, injectable `now`/`budgetMs`) is checked after every chunk
 *     while work remains; exceeding it stops the scan with `read budget exceeded`.
 *
 * TOTAL: never throws. The environment is read ONLY through `opts.env` (default process.env).
 *
 * @module hooks/lib/tool-log-reader
 */

const fs = require('node:fs');
const path = require('node:path');

// ONE definition each: the reader finds the log where the recorder writes it, normalizes ids the
// way the recorder stores them, and honours the recorder's own kill switch.
const {
  isRecorderOff,
  clean,
  LIMITS,
  resolveLogDir,
  LOG_FILENAME,
  ROTATED_FILENAME,
} = require('../tool-recorder.cjs');

/** Read granularity for the needle scan (1 MiB; at least one whole record). */
const SCAN_CHUNK_BYTES = 1024 * 1024;

/**
 * A file larger than this is not scanned (64 MiB). The recorder rotates once past MAX_LOG_BYTES
 * (50 MiB), so a healthy file is at most MAX_LOG_BYTES + one record; anything far beyond that is
 * not a log this reader was built for.
 */
const MAX_SCAN_BYTES = 64 * 1024 * 1024;

/**
 * Wall-clock budget for one read across both files (10 s). Three budgets fit inside the
 * review-artifact hook's 60 s timeout in settings.snippet.json (asserted in
 * hooks/review-artifact.test.cjs).
 */
const READ_BUDGET_MS = 10000;

// MAX_SCAN_BYTES > MAX_LOG_BYTES + MAX_RECORD_BYTES and SCAN_CHUNK_BYTES >= MAX_RECORD_BYTES are
// asserted in tool-log-reader.test.cjs, NOT thrown here: a throw at require time would crash
// review-artifact.cjs before runGate, and a crashed PreToolUse hook is not a deny.

const NEWLINE = 0x0a;

/**
 * The byte needle a recorder row for `id` contains, exactly as JSON.stringify emits it.
 *
 * @param {string} id an already-normalized session id
 * @returns {string}
 */
function sessionNeedle(id) {
  return '"session_id":' + JSON.stringify(id);
}

/**
 * Normalize a payload session id the way tool-recorder stores it: tool-recorder's own
 * `clean(id, LIMITS.session_id)`. Null for a non-string, empty or whitespace-only id.
 *
 * @param {*} id
 * @returns {string|null}
 */
function normalizeSessionId(id) {
  if (typeof id !== 'string') return null;
  return clean(id, LIMITS.session_id);
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
 * An error's CODE only (never its message, which can carry a path); `error` when there is none.
 *
 * @param {*} err
 * @returns {string}
 */
function codeOf(err) {
  const code = err !== null && typeof err === 'object' ? err.code : undefined;
  return typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? code : 'error';
}

/**
 * Scan one file. Pushes own-session rows into `out` as they are found (so a file that fails
 * mid-read still contributes what was read). Returns 'absent' | 'scanned' | 'problem' | 'budget'.
 *
 * @param {string} file
 * @param {Object} s scan state {impl, needle, id, chunkBytes, maxScanBytes, overBudget, out, problems}
 * @returns {string}
 */
function scanFile(file, s) {
  const base = path.basename(file);
  let fd;
  try {
    fd = s.impl.openSync(file, 'r');
  } catch (err) {
    if (codeOf(err) === 'ENOENT') return 'absent';
    s.problems.push('unreadable ' + base + ': ' + codeOf(err));
    return 'problem';
  }

  try {
    const size = s.impl.fstatSync(fd).size; // snapshot once; later appends are not chased
    if (!(typeof size === 'number' && size >= 0)) {
      s.problems.push('unreadable ' + base + ': error');
      return 'problem';
    }
    if (size > s.maxScanBytes) {
      s.problems.push(base + ' exceeds the scan cap (' + s.maxScanBytes + ' bytes); not scanned');
      return 'problem';
    }
    let carry = Buffer.alloc(0);
    let pos = 0;
    while (pos < size) {
      const want = Math.min(s.chunkBytes, size - pos);
      const chunk = Buffer.alloc(want);
      const n = s.impl.readSync(fd, chunk, 0, want, pos);
      if (!n) break; // truncated under us: stop at what we have
      pos += n;
      const buf = carry.length ? Buffer.concat([carry, chunk.subarray(0, n)]) : chunk.subarray(0, n);
      const lastNl = buf.lastIndexOf(NEWLINE);
      if (lastNl === -1) {
        carry = buf; // no complete line yet
      } else {
        scanRegion(buf, lastNl, s.needle, s.id, s.out);
        carry = buf.subarray(lastNl + 1);
      }
      // Budget: checked after every chunk while work remains in this file.
      if (pos < size && s.overBudget()) {
        s.problems.push('read budget exceeded');
        return 'budget';
      }
    }
    // A final line without a trailing newline (e.g. an append in flight): parse it; a torn
    // write fails JSON.parse and is skipped.
    if (carry.length) scanRegion(carry, carry.length, s.needle, s.id, s.out);
    return 'scanned';
  } catch (err) {
    s.problems.push('unreadable ' + base + ': ' + codeOf(err));
    return 'problem';
  } finally {
    try {
      s.impl.closeSync(fd);
    } catch (_) {
      /* closing a read fd cannot change the result */
    }
  }
}

/**
 * Read every recorder row of `sessionId` from the live log and its rotated slot, projected to
 * `{tool_name, outcome}`.
 *
 * @param {*} sessionId the PreToolUse payload's session id (normalized here)
 * @param {Object} [opts]
 * @param {Object} [opts.env] environment (default process.env): the recorder kill switch and
 *   GSD_CONTRIB_LOG_DIR are read from it, through tool-recorder's own helpers
 * @param {Object} [opts.fsImpl] fs seam (openSync/fstatSync/readSync/closeSync)
 * @param {number} [opts.chunkBytes] scan chunk size (default SCAN_CHUNK_BYTES)
 * @param {number} [opts.maxScanBytes] per-file cap (default MAX_SCAN_BYTES)
 * @param {() => number} [opts.now] clock in ms (default Date.now)
 * @param {number} [opts.budgetMs] wall-clock budget (default READ_BUDGET_MS)
 * @returns {{recorderOff:boolean, complete:boolean, records:Array<{tool_name:string, outcome:string}>, problems:string[]}}
 */
function readSessionRecords(sessionId, opts = {}) {
  const result = { recorderOff: false, complete: false, records: [], problems: [] };
  try {
    const o = opts !== null && typeof opts === 'object' ? opts : {};
    const env = o.env || process.env;

    // (1) The recorder is off: there is nothing to read, and nothing is opened.
    if (isRecorderOff(env)) {
      result.recorderOff = true;
      result.problems.push('recorder off');
      return result;
    }

    // (2) Normalize the query exactly as the writer normalized the stored id.
    const id = normalizeSessionId(sessionId);
    if (id === null) {
      result.problems.push('no session id');
      return result;
    }

    const impl = o.fsImpl || fs;
    const chunkBytes = Number.isInteger(o.chunkBytes) && o.chunkBytes > 0 ? o.chunkBytes : SCAN_CHUNK_BYTES;
    const maxScanBytes =
      Number.isInteger(o.maxScanBytes) && o.maxScanBytes > 0 ? o.maxScanBytes : MAX_SCAN_BYTES;
    const now = typeof o.now === 'function' ? o.now : Date.now;
    const budgetMs = Number.isFinite(o.budgetMs) && o.budgetMs >= 0 ? o.budgetMs : READ_BUDGET_MS;
    const start = Number(now());

    const s = {
      impl,
      id,
      needle: Buffer.from(sessionNeedle(id), 'utf8'),
      chunkBytes,
      maxScanBytes,
      overBudget: () => Number(now()) - start > budgetMs,
      out: result.records,
      problems: result.problems,
    };

    // (3) Live first, then the rotated slot.
    const dir = resolveLogDir(env);
    const files = [LOG_FILENAME, ROTATED_FILENAME];
    let scanned = 0;
    let absent = 0;
    for (let i = 0; i < files.length; i += 1) {
      if (i > 0 && s.overBudget()) {
        result.problems.push('read budget exceeded');
        break;
      }
      const status = scanFile(path.join(dir, files[i]), s);
      if (status === 'scanned') scanned += 1;
      else if (status === 'absent') absent += 1;
      else if (status === 'budget') break;
    }
    if (absent === files.length) result.problems.push('log absent: ' + files.join(', '));

    result.complete = result.problems.length === 0 && scanned > 0;
  } catch (err) {
    result.complete = false;
    result.problems.push('unreadable ' + LOG_FILENAME + ': ' + codeOf(err));
  }
  return result;
}

module.exports = {
  readSessionRecords,
  normalizeSessionId,
  sessionNeedle,
  SCAN_CHUNK_BYTES,
  MAX_SCAN_BYTES,
  READ_BUDGET_MS,
};
