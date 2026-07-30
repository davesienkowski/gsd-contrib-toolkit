'use strict';

/**
 * bin/verdict-stats.test.cjs — HERMETIC test of the OBS-03 verdict census.
 *
 * Injected fixtures throughout — nothing reads the real log. The properties that matter:
 * "never observed" is reported by ABSENCE against the derived gate set (not merely omitted),
 * unparseable lines are COUNTED rather than silently dropped, and PostToolUse records from the
 * same file are excluded so the two streams are never conflated.
 *
 * @module bin/verdict-stats.test
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const vs = require('./verdict-stats.cjs');

const rec = (o) => JSON.stringify(Object.assign({ source: 'pretooluse-gate', ts: '2026-07-30T00:00:00.000Z' }, o));

test('discoverGateActions: derives names from the hook sources, not a hand-list', () => {
  const g = vs.discoverGateActions();
  assert.ok(g.length >= 15, 'expected the full wired set, got ' + g.length);
  for (const expected of ['containment', 'pr-create', 'binlib-edit', 'scan-gate']) {
    assert.ok(g.includes(expected), 'missing ' + expected);
  }
});

test('discoverGateActions: an unreadable hooks dir yields [] rather than throwing', () => {
  assert.deepEqual(vs.discoverGateActions({ readDir: () => { throw new Error('ENOENT'); } }), []);
});

test('readVerdicts: counts unparseable lines instead of hiding them', () => {
  const r = vs.readVerdicts({
    logDir: '/fake',
    exists: () => true,
    readFile: () => [rec({ gate: 'a', decision: 'deny' }), '{not json', ''].join('\n'),
  });
  assert.equal(r.records.length, 2, 'two files are globbed, each contributing one good record');
  assert.equal(r.skipped, 2);
});

test('readVerdicts: PostToolUse records in the same file are EXCLUDED (streams not conflated)', () => {
  const r = vs.readVerdicts({
    logDir: '/fake',
    exists: (p) => p.endsWith('tool-log.jsonl'),
    readFile: () => [rec({ gate: 'a', decision: 'deny' }), JSON.stringify({ tool_name: 'Bash', governed: false })].join('\n'),
  });
  assert.equal(r.records.length, 1);
  assert.equal(r.records[0].gate, 'a');
});

test('buildCensus: tallies allow/deny/ask per gate and tracks the slowest', () => {
  const c = vs.buildCensus(
    [
      { gate: 'g1', decision: 'deny', duration_ms: 5, ts: '2026-07-30T01:00:00Z', session_id: 's' },
      { gate: 'g1', decision: 'allow', duration_ms: 90, ts: '2026-07-30T02:00:00Z', session_id: 's' },
      { gate: 'g1', decision: 'ask', duration_ms: 1, ts: '2026-07-30T03:00:00Z', session_id: 't' },
    ],
    ['g1']
  );
  const row = c.perGate.find((r) => r.gate === 'g1');
  assert.deepEqual([row.allow, row.deny, row.ask], [1, 1, 1]);
  assert.equal(row.maxMs, 90);
  assert.equal(c.sessions, 2);
  assert.equal(c.window.from, '2026-07-30T01:00:00Z');
  assert.equal(c.window.to, '2026-07-30T03:00:00Z');
});

test('buildCensus: a gate with NO records is present with zeros — never-fired is reported, not omitted', () => {
  const c = vs.buildCensus([{ gate: 'fired', decision: 'deny' }], ['fired', 'never-fired']);
  const n = c.perGate.find((r) => r.gate === 'never-fired');
  assert.ok(n, 'the unfired gate must still appear in the census');
  assert.equal(n.total, 0);
});

test('buildCensus: an unrecognized decision counts as deny (mirrors the fail-closed floor)', () => {
  const c = vs.buildCensus([{ gate: 'g', decision: 'ALLOW' }, { gate: 'g', decision: undefined }], ['g']);
  const row = c.perGate.find((r) => r.gate === 'g');
  assert.equal(row.deny, 2);
  assert.equal(row.allow, 0);
});

test('buildCensus: a gate seen in the log but not in the known set is still counted', () => {
  const c = vs.buildCensus([{ gate: 'surprise', decision: 'deny' }], ['known']);
  assert.ok(c.perGate.find((r) => r.gate === 'surprise'));
});

test('runCli: no log present is information, not a failure (exit 0)', () => {
  const out = [];
  const orig = process.stdout.write;
  process.stdout.write = (s) => { out.push(s); return true; };
  let code;
  try {
    code = vs.runCli({ logDir: '/fake', exists: () => false });
  } finally {
    process.stdout.write = orig;
  }
  assert.equal(code, 0);
  assert.match(out.join(''), /no verdict log found/);
});
