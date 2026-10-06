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
