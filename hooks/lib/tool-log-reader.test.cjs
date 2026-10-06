'use strict';

/**
 * node:test for hooks/lib/tool-log-reader.cjs — the bounded, session-scoped reader of
 * tool-recorder's log that ENF-20's R8a-memtrace obligation reads as evidence.
 *
 * Hermetic: every test makes its OWN mkdtemp dir and passes an explicit env
 * `{GSD_CONTRIB_LOG_DIR: dir}`; process.env is never read and the real ~/.gsd-contrib log is
 * never touched. This file is bundled and also runs from capabilities/, so it reads no
 * repo-relative file.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readSessionRecords, sessionNeedle } = require('./tool-log-reader.cjs');

const LOG = 'tool-log.jsonl';

function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlr-38-01-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A recorder-shaped row (tool-recorder recordToolCall keys). */
function rec(sessionId, toolName, outcome = 'ok', over = {}) {
  return Object.assign(
    {
      ts: '2026-10-06T00:00:00.000Z',
      session_id: sessionId,
      tool_use_id: 'toolu_x',
      tool_name: toolName,
      outcome,
      duration_ms: 5,
      cwd: '/tmp/wt',
    },
    over
  );
}

function writeLog(dir, lines) {
  fs.writeFileSync(path.join(dir, LOG), lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
}

test('38-01 reader: own-session ok rows are returned, projected to exactly {tool_name, outcome}', () => {
  const dir = tmpDir();
  writeLog(dir, [
    rec('sess-own', 'mcp__memtrace__get_impact'),
    rec('sess-own', 'Bash', 'ok', { action: null, governed: false }),
    rec('sess-own', 'Read', 'fail', { error_kind: 'ENOENT' }),
  ]);
  const r = readSessionRecords('sess-own', { env: { GSD_CONTRIB_LOG_DIR: dir } });
  assert.strictEqual(r.complete, true, JSON.stringify(r.problems));
  assert.strictEqual(r.recorderOff, false);
  assert.deepStrictEqual(r.records, [
    { tool_name: 'mcp__memtrace__get_impact', outcome: 'ok' },
    { tool_name: 'Bash', outcome: 'ok' },
    { tool_name: 'Read', outcome: 'fail' },
  ]);
  for (const x of r.records) assert.deepStrictEqual(Object.keys(x).sort(), ['outcome', 'tool_name']);
});

test('38-01 reader: rows of another session are excluded', () => {
  const dir = tmpDir();
  writeLog(dir, [
    rec('sess-other', 'mcp__memtrace__get_impact'),
    rec('sess-own-2', 'Bash'),
    // a session id that CONTAINS the queried one must not match either
    rec('sess-own-2-suffix', 'mcp__memtrace__get_symbol_context'),
  ]);
  const r = readSessionRecords('sess-own-2', { env: { GSD_CONTRIB_LOG_DIR: dir } });
  assert.deepStrictEqual(r.records, [{ tool_name: 'Bash', outcome: 'ok' }]);
});

test('38-01 reader: a row carrying `source` (gate verdict shape) with the same session id is excluded', () => {
  const dir = tmpDir();
  writeLog(dir, [
    // outcome:'ok' as well, so ONLY the `source` key can be what excludes it
    rec('sess-src', 'mcp__memtrace__get_impact', 'ok', {
      source: 'pretooluse-gate',
      gate: 'review-artifact',
      decision: 'allow',
    }),
    rec('sess-src', 'mcp__memtrace__recall_decision'),
  ]);
  const r = readSessionRecords('sess-src', { env: { GSD_CONTRIB_LOG_DIR: dir } });
  assert.deepStrictEqual(r.records, [{ tool_name: 'mcp__memtrace__recall_decision', outcome: 'ok' }]);
});

test('38-01 reader: a malformed line containing the session needle is skipped without throwing', () => {
  const dir = tmpDir();
  writeLog(dir, [
    '{' + sessionNeedle('sess-bad') + ',"tool_name":"mcp__memtrace__get_impact","outcome":"ok"',
    'not json ' + sessionNeedle('sess-bad'),
    rec('sess-bad', 'mcp__memtrace__get_symbol_context'),
  ]);
  let r;
  assert.doesNotThrow(() => {
    r = readSessionRecords('sess-bad', { env: { GSD_CONTRIB_LOG_DIR: dir } });
  });
  assert.deepStrictEqual(r.records, [{ tool_name: 'mcp__memtrace__get_symbol_context', outcome: 'ok' }]);
});

test('38-01 reader: an absent log dir/file returns complete:false naming tool-log.jsonl, never throws', () => {
  const dir = tmpDir();
  const missingDir = path.join(dir, 'does-not-exist');
  for (const d of [dir, missingDir]) {
    let r;
    assert.doesNotThrow(() => {
      r = readSessionRecords('sess-x', { env: { GSD_CONTRIB_LOG_DIR: d } });
    });
    assert.strictEqual(r.complete, false);
    assert.strictEqual(r.recorderOff, false);
    assert.deepStrictEqual(r.records, []);
    assert.strictEqual(r.problems.length, 1);
    assert.match(r.problems[0], /tool-log\.jsonl/);
    assert.ok(!r.problems[0].includes(d), 'a problem carries a basename, never a path');
  }
});

// ── 38-02: the complete reader ──────────────────────────────────────────────
//
// Fixture lines are produced by tool-recorder's OWN recordToolCall + serializeRecord (and
// appendRecord where the live write path matters), so the reader is proven against the real
// writer format, not a hand-written shape. Every test passes an explicit env; none reads
// process.env or the real ~/.gsd-contrib log.

const readerModule = require('./tool-log-reader.cjs');
const {
  recordToolCall,
  serializeRecord,
  appendRecord,
  MAX_LOG_BYTES,
  MAX_RECORD_BYTES,
} = require('../tool-recorder.cjs');

const ROTATED = 'tool-log.1.jsonl';

function tmpDir2() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlr-38-02-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** One recorder line (with trailing newline) for a PostToolUse of `toolName` in `sessionId`. */
function recLine(sessionId, toolName, over = {}) {
  const payload = Object.assign(
    {
      hook_event_name: 'PostToolUse',
      session_id: sessionId,
      tool_use_id: 'toolu_38_02',
      tool_name: toolName,
      tool_input: {},
      tool_response: {},
      cwd: '/tmp/wt',
    },
    over
  );
  const line = serializeRecord(recordToolCall(JSON.stringify(payload), { env: {} }));
  assert.ok(line, 'the recorder produced a line for ' + toolName);
  return line;
}

function writeFile(dir, name, lines) {
  fs.writeFileSync(path.join(dir, name), lines.join(''));
}

/** An fs seam that records the basename of every openSync, then delegates to the real fs. */
function spyFs(over = {}) {
  const opened = [];
  const impl = Object.assign({}, fs, {
    openSync: (p, flags) => {
      opened.push(path.basename(p));
      return fs.openSync(p, flags);
    },
  }, over);
  impl.opened = opened;
  return impl;
}

test('38-02 reader: GSD_CONTRIB_RECORD=off -> {recorderOff:true, complete:false, records:[]} and no file is opened', () => {
  const dir = tmpDir2();
  writeFile(dir, LOG, [recLine('sess-off', 'mcp__memtrace__get_impact')]);
  const spy = spyFs();
  const r = readerModule.readSessionRecords('sess-off', {
    env: { GSD_CONTRIB_LOG_DIR: dir, GSD_CONTRIB_RECORD: 'off' },
    fsImpl: spy,
  });
  assert.strictEqual(r.recorderOff, true);
  assert.strictEqual(r.complete, false);
  assert.deepStrictEqual(r.records, []);
  assert.deepStrictEqual(spy.opened, [], 'a disabled recorder means no filesystem read at all');
});

test('38-02 reader: a 65-char payload session id stored through the recorder is found by the same 65-char id', () => {
  const dir = tmpDir2();
  const id = 'S'.repeat(65);
  const env = { GSD_CONTRIB_LOG_DIR: dir };
  assert.ok(appendRecord(recLine(id, 'mcp__memtrace__get_impact'), { env }), 'appendRecord wrote the live log');
  const r = readerModule.readSessionRecords(id, { env });
  assert.deepStrictEqual(r.records, [{ tool_name: 'mcp__memtrace__get_impact', outcome: 'ok' }]);
  assert.strictEqual(r.complete, true, JSON.stringify(r.problems));
});

test('38-02 reader: a payload id containing a newline, stored cleaned by the recorder, is found by the original id', () => {
  const dir = tmpDir2();
  const id = 'sess\nnewline';
  const env = { GSD_CONTRIB_LOG_DIR: dir };
  assert.ok(appendRecord(recLine(id, 'mcp__memtrace__get_symbol_context'), { env }));
  const r = readerModule.readSessionRecords(id, { env });
  assert.deepStrictEqual(r.records, [{ tool_name: 'mcp__memtrace__get_symbol_context', outcome: 'ok' }]);
});

for (const [label, id] of [["''", ''], ["'   '", '   '], ['null', null], ['42', 42]]) {
  test('38-02 reader: session id ' + label + ' -> complete:false, problem `no session id`, no file opened', () => {
    const dir = tmpDir2();
    writeFile(dir, LOG, [recLine('   ', 'Bash'), recLine('42', 'Bash')]);
    const spy = spyFs();
    const r = readerModule.readSessionRecords(id, { env: { GSD_CONTRIB_LOG_DIR: dir }, fsImpl: spy });
    assert.strictEqual(r.complete, false);
    assert.deepStrictEqual(r.records, []);
    assert.deepStrictEqual(r.problems, ['no session id']);
    assert.deepStrictEqual(spy.opened, []);
  });
}

test('38-02 reader: rows only in tool-log.1.jsonl are found and complete is true', () => {
  const dir = tmpDir2();
  writeFile(dir, ROTATED, [recLine('sess-rot', 'mcp__memtrace__get_impact'), recLine('sess-other', 'Bash')]);
  const r = readerModule.readSessionRecords('sess-rot', { env: { GSD_CONTRIB_LOG_DIR: dir } });
  assert.deepStrictEqual(r.records, [{ tool_name: 'mcp__memtrace__get_impact', outcome: 'ok' }]);
  assert.strictEqual(r.complete, true, JSON.stringify(r.problems));
  assert.deepStrictEqual(r.problems, []);
});

test('38-02 reader: rows in both files are returned as the union (a row present in both appears from both)', () => {
  const dir = tmpDir2();
  const shared = recLine('sess-u', 'mcp__memtrace__recall_decision');
  writeFile(dir, LOG, [recLine('sess-u', 'mcp__memtrace__get_impact'), shared]);
  writeFile(dir, ROTATED, [shared, recLine('sess-u', 'mcp__memtrace__get_symbol_context')]);
  const r = readerModule.readSessionRecords('sess-u', { env: { GSD_CONTRIB_LOG_DIR: dir } });
  assert.deepStrictEqual(r.records, [
    { tool_name: 'mcp__memtrace__get_impact', outcome: 'ok' },
    { tool_name: 'mcp__memtrace__recall_decision', outcome: 'ok' },
    { tool_name: 'mcp__memtrace__recall_decision', outcome: 'ok' },
    { tool_name: 'mcp__memtrace__get_symbol_context', outcome: 'ok' },
  ]);
  assert.strictEqual(r.complete, true, JSON.stringify(r.problems));
});

test('38-02 reader: neither file present -> complete:false, the problem names tool-log.jsonl and tool-log.1.jsonl', () => {
  const dir = tmpDir2();
  const r = readerModule.readSessionRecords('sess-none', { env: { GSD_CONTRIB_LOG_DIR: dir } });
  assert.strictEqual(r.complete, false);
  assert.deepStrictEqual(r.records, []);
  assert.deepStrictEqual(r.problems, ['log absent: tool-log.jsonl, tool-log.1.jsonl']);
});

test('38-02 reader: tool-log.jsonl is opened before tool-log.1.jsonl (live first can only double-read)', () => {
  const dir = tmpDir2();
  writeFile(dir, LOG, [recLine('sess-o', 'Bash')]);
  writeFile(dir, ROTATED, [recLine('sess-o', 'Read')]);
  const spy = spyFs();
  readerModule.readSessionRecords('sess-o', { env: { GSD_CONTRIB_LOG_DIR: dir }, fsImpl: spy });
  assert.deepStrictEqual(spy.opened, [LOG, ROTATED]);
});

test('38-02 reader: chunkBytes 7 returns the same records as the default chunk size (multi-byte cwd, both files)', () => {
  const dir = tmpDir2();
  const live = [];
  const rotated = [];
  let want = 0;
  for (let i = 0; i < 30; i += 1) {
    const sid = i % 3 === 0 ? 'sess-other' : 'sess-chunk';
    if (sid === 'sess-chunk') want += 1;
    const line = recLine(sid, i % 2 ? 'mcp__memtrace__get_impact' : 'Bash', {
      cwd: '/tmp/wt/ünïcødé-日本語-' + '€'.repeat(i % 5) + '/' + i,
    });
    (i < 15 ? live : rotated).push(line);
  }
  writeFile(dir, LOG, live);
  writeFile(dir, ROTATED, rotated);
  const env = { GSD_CONTRIB_LOG_DIR: dir };
  const small = readerModule.readSessionRecords('sess-chunk', { env, chunkBytes: 7 });
  const dflt = readerModule.readSessionRecords('sess-chunk', { env });
  assert.strictEqual(dflt.records.length, want, 'every own row across both files is found');
  assert.deepStrictEqual(small.records, dflt.records);
  assert.strictEqual(small.complete, true, JSON.stringify(small.problems));
});

test('38-02 reader: a torn final line (no newline, partial JSON with the needle) is skipped; earlier rows are returned', () => {
  const dir = tmpDir2();
  const torn = '{"ts":"2026-10-06T00:00:00.000Z",' + readerModule.sessionNeedle('sess-t') + ',"tool_name":"mcp__memtrace__get_imp';
  writeFile(dir, LOG, [recLine('sess-t', 'mcp__memtrace__get_symbol_context'), torn]);
  let r;
  assert.doesNotThrow(() => {
    r = readerModule.readSessionRecords('sess-t', { env: { GSD_CONTRIB_LOG_DIR: dir } });
  });
  assert.deepStrictEqual(r.records, [{ tool_name: 'mcp__memtrace__get_symbol_context', outcome: 'ok' }]);
});

test("38-02 reader: a query for 'sess-A' excludes rows of 'sess-AB' and 'xsess-A'", () => {
  const dir = tmpDir2();
  writeFile(dir, LOG, [
    recLine('sess-AB', 'mcp__memtrace__get_impact'),
    recLine('xsess-A', 'mcp__memtrace__get_symbol_context'),
    recLine('sess-A', 'Bash'),
  ]);
  const r = readerModule.readSessionRecords('sess-A', { env: { GSD_CONTRIB_LOG_DIR: dir } });
  assert.deepStrictEqual(r.records, [{ tool_name: 'Bash', outcome: 'ok' }]);
});

test('38-02 reader: a crafted line with two session_id keys whose last value is another session is excluded', () => {
  const dir = tmpDir2();
  const crafted =
    '{' + readerModule.sessionNeedle('sess-A') + ',"tool_name":"mcp__memtrace__get_impact","outcome":"ok",' +
    readerModule.sessionNeedle('sess-Z') + '}\n';
  writeFile(dir, LOG, [crafted, recLine('sess-A', 'Read')]);
  const r = readerModule.readSessionRecords('sess-A', { env: { GSD_CONTRIB_LOG_DIR: dir } });
  assert.deepStrictEqual(r.records, [{ tool_name: 'Read', outcome: 'ok' }]);
});

test('38-02 reader: a file over maxScanBytes is not scanned at all (no partial tail); the other file still is', () => {
  const dir = tmpDir2();
  writeFile(dir, LOG, [recLine('sess-cap', 'mcp__memtrace__get_impact')]);
  const big = [];
  for (let i = 0; i < 20; i += 1) big.push(recLine('sess-cap', 'mcp__memtrace__get_symbol_context'));
  writeFile(dir, ROTATED, big);
  const liveSize = fs.statSync(path.join(dir, LOG)).size;
  const rotSize = fs.statSync(path.join(dir, ROTATED)).size;
  assert.ok(rotSize > liveSize);
  const r = readerModule.readSessionRecords('sess-cap', {
    env: { GSD_CONTRIB_LOG_DIR: dir },
    maxScanBytes: liveSize + 1,
  });
  assert.deepStrictEqual(r.records, [{ tool_name: 'mcp__memtrace__get_impact', outcome: 'ok' }]);
  assert.strictEqual(r.complete, false);
  assert.strictEqual(r.problems.length, 1, JSON.stringify(r.problems));
  assert.match(r.problems[0], /tool-log\.1\.jsonl/);
  assert.match(r.problems[0], /scan cap/);
});

test('38-02 reader: an injected now() past budgetMs after the first chunk -> complete:false, `read budget exceeded`, no throw', () => {
  const dir = tmpDir2();
  const lines = [];
  for (let i = 0; i < 10; i += 1) lines.push(recLine('sess-b', 'Bash'));
  writeFile(dir, LOG, lines);
  let calls = 0;
  const now = () => (calls++ === 0 ? 1000 : 1000 + 10 * 60 * 1000);
  let r;
  assert.doesNotThrow(() => {
    r = readerModule.readSessionRecords('sess-b', {
      env: { GSD_CONTRIB_LOG_DIR: dir },
      chunkBytes: 64,
      now,
      budgetMs: 5000,
    });
  });
  assert.strictEqual(r.complete, false);
  assert.ok(r.problems.includes('read budget exceeded'), JSON.stringify(r.problems));
  assert.ok(r.records.length < lines.length, 'the scan stopped early');
});

test('38-02 reader: openSync EACCES on tool-log.1.jsonl only -> the live rows, complete:false, `unreadable tool-log.1.jsonl: EACCES`', () => {
  const dir = tmpDir2();
  writeFile(dir, LOG, [recLine('sess-e', 'mcp__memtrace__get_impact')]);
  writeFile(dir, ROTATED, [recLine('sess-e', 'mcp__memtrace__get_symbol_context')]);
  const spy = spyFs();
  const realOpen = spy.openSync;
  spy.openSync = (p, flags) => {
    if (path.basename(p) === ROTATED) {
      const e = new Error('permission denied, open ' + p);
      e.code = 'EACCES';
      throw e;
    }
    return realOpen(p, flags);
  };
  const r = readerModule.readSessionRecords('sess-e', { env: { GSD_CONTRIB_LOG_DIR: dir }, fsImpl: spy });
  assert.deepStrictEqual(r.records, [{ tool_name: 'mcp__memtrace__get_impact', outcome: 'ok' }]);
  assert.strictEqual(r.complete, false);
  assert.deepStrictEqual(r.problems, ['unreadable tool-log.1.jsonl: EACCES']);
});

test('38-02 reader: MAX_SCAN_BYTES > MAX_LOG_BYTES + MAX_RECORD_BYTES; READ_BUDGET_MS a positive integer; SCAN_CHUNK_BYTES >= MAX_RECORD_BYTES', () => {
  assert.strictEqual(typeof readerModule.MAX_SCAN_BYTES, 'number');
  assert.ok(readerModule.MAX_SCAN_BYTES > MAX_LOG_BYTES + MAX_RECORD_BYTES);
  assert.ok(Number.isInteger(readerModule.READ_BUDGET_MS) && readerModule.READ_BUDGET_MS > 0);
  assert.ok(readerModule.SCAN_CHUNK_BYTES >= MAX_RECORD_BYTES);
});

test('38-02 reader: an fsImpl whose every method throws a non-Error value -> complete:false, never throws', () => {
  const dir = tmpDir2();
  const thrower = () => {
    throw 'boom'; // eslint-disable-line no-throw-literal
  };
  const impl = { openSync: thrower, fstatSync: thrower, readSync: thrower, closeSync: thrower, existsSync: thrower, statSync: thrower };
  let r;
  assert.doesNotThrow(() => {
    r = readerModule.readSessionRecords('sess-n', { env: { GSD_CONTRIB_LOG_DIR: dir }, fsImpl: impl });
  });
  assert.strictEqual(r.complete, false);
  assert.deepStrictEqual(r.records, []);
  assert.deepStrictEqual(r.problems, ['unreadable tool-log.jsonl: error', 'unreadable tool-log.1.jsonl: error']);
});
