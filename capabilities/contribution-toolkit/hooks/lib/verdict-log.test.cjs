'use strict';

/**
 * hooks/lib/verdict-log.test.cjs — HERMETIC test of the OBS-02 gate-verdict recorder.
 *
 * Every impure seam (env, the fs writer) is injected, so nothing here touches a real log. The
 * cases below pin the four NON-NEGOTIABLE constraints from
 * `.planning/notes/2026-07-29-L2-observability-design.md`, because this module is called from
 * `failclosed.cjs` — the one file whose blast radius is all 15 gates:
 *
 *   1. it can NEVER throw (fs, serialization, malformed ctx — anything);
 *   2. it NEVER alters the decision it is handed;
 *   3. a failed write is dropped silently (best-effort);
 *   4. a kill switch disables it without touching gate logic.
 *
 * Plus the privacy constraint: the raw command / file content / tool_response must NEVER reach the
 * record. A secret-bearing log created as a side effect of a measurement exercise would be worse
 * than the gap it closes.
 *
 * @module hooks/lib/verdict-log.test
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { recordVerdict, buildRecord, isDisabled } = require('./verdict-log.cjs');

/** A writer stub that captures the line instead of touching disk. */
function captureWriter() {
  const lines = [];
  const fn = (line) => {
    lines.push(line);
    return '/fake/tool-log.jsonl';
  };
  fn.lines = lines;
  return fn;
}

const CTX = (over = {}) =>
  Object.assign(
    {
      action: 'gh-pr-create',
      command: 'gh pr create --title "fix: x" --body "SECRET-TOKEN-abc123"',
      stdin: JSON.stringify({
        session_id: 'sess-1',
        tool_use_id: 'toolu_9',
        tool_name: 'Bash',
        tool_input: { command: 'gh pr create --title "fix: x" --body "SECRET-TOKEN-abc123"' },
      }),
    },
    over
  );

const DENY = { permissionDecision: 'deny', permissionDecisionReason: 'nope' };
const ALLOW = { permissionDecision: 'allow' };
const ASK = { permissionDecision: 'ask', permissionDecisionReason: 'confirm?' };

// --- the record itself ------------------------------------------------------

test('buildRecord: captures gate, ids, classified action, decision, duration', () => {
  const r = buildRecord(CTX(), DENY, 1234);
  assert.equal(r.source, 'pretooluse-gate');
  assert.equal(r.gate, 'gh-pr-create');
  assert.equal(r.session_id, 'sess-1');
  assert.equal(r.tool_use_id, 'toolu_9');
  assert.equal(r.tool_name, 'Bash');
  assert.equal(r.action, 'pr-create', 'the CLASSIFIED action, via classify.cjs');
  assert.equal(r.decision, 'deny');
  assert.equal(r.duration_ms, 1234);
  assert.equal(typeof r.ts, 'string');
});

test('PRIVACY: the raw command never reaches the record, in any field', () => {
  const line = JSON.stringify(buildRecord(CTX(), DENY, 5));
  assert.ok(!line.includes('SECRET-TOKEN-abc123'), 'a body/token must never be logged');
  assert.ok(!line.includes('--title'), 'no raw argv');
  assert.ok(!/"command"/.test(line), 'no `command` field at all');
});

test('PRIVACY: Write/Edit content and tool_response are never logged', () => {
  const ctx = CTX({
    action: 'binlib-edit',
    command: '/repo/gsd-core/bin/lib/x.cjs',
    stdin: JSON.stringify({
      session_id: 's',
      tool_name: 'Write',
      tool_input: { file_path: '/repo/x.cjs', content: 'ENTIRE-FILE-BODY' },
      tool_response: { stdout: 'COMMAND-OUTPUT' },
    }),
  });
  const line = JSON.stringify(buildRecord(ctx, DENY, 1));
  assert.ok(!line.includes('ENTIRE-FILE-BODY'));
  assert.ok(!line.includes('COMMAND-OUTPUT'));
});

test('all three decisions are recorded distinctly', () => {
  assert.equal(buildRecord(CTX(), ALLOW, 1).decision, 'allow');
  assert.equal(buildRecord(CTX(), DENY, 1).decision, 'deny');
  assert.equal(buildRecord(CTX(), ASK, 1).decision, 'ask');
});

test('a missing/!unparseable ctx.stdin yields null ids, never a throw', () => {
  for (const bad of [undefined, '', 'not json', '[]', 'null']) {
    const r = buildRecord(CTX({ stdin: bad }), DENY, 1);
    assert.equal(r.session_id, null);
    assert.equal(r.tool_use_id, null);
    assert.equal(r.decision, 'deny', 'the decision still records');
  }
});

test('an unrecognized decision shape records as `deny` (mirrors emit()\'s fail-closed default)', () => {
  assert.equal(buildRecord(CTX(), undefined, 1).decision, 'deny');
  assert.equal(buildRecord(CTX(), {}, 1).decision, 'deny');
  assert.equal(buildRecord(CTX(), { permissionDecision: 'ALLOW' }, 1).decision, 'deny');
});

// --- the four non-negotiables ----------------------------------------------

test('KILL SWITCH: GSD_CONTRIB_NO_VERDICT_LOG disables it and writes nothing', () => {
  const w = captureWriter();
  const out = recordVerdict(CTX(), DENY, 1, { env: { GSD_CONTRIB_NO_VERDICT_LOG: '1' }, writer: w });
  assert.equal(out, null);
  assert.deepEqual(w.lines, [], 'nothing written when disabled');
});

test('KILL SWITCH: absent/blank means ENABLED (opt-out, not opt-in)', () => {
  const w = captureWriter();
  assert.equal(isDisabled({}), false);
  assert.equal(isDisabled({ GSD_CONTRIB_NO_VERDICT_LOG: '' }), false);
  recordVerdict(CTX(), DENY, 1, { env: {}, writer: w });
  assert.equal(w.lines.length, 1);
});

test('NEVER THROWS: a writer that throws is swallowed and returns null', () => {
  const boom = () => {
    throw new Error('disk on fire');
  };
  assert.doesNotThrow(() => recordVerdict(CTX(), DENY, 1, { env: {}, writer: boom }));
  assert.equal(recordVerdict(CTX(), DENY, 1, { env: {}, writer: boom }), null);
});

test('NEVER THROWS: a hostile ctx (getter that throws, circular) is swallowed', () => {
  const hostile = {};
  Object.defineProperty(hostile, 'action', {
    get() {
      throw new Error('hostile getter');
    },
    enumerable: true,
  });
  assert.doesNotThrow(() => recordVerdict(hostile, DENY, 1, { env: {}, writer: captureWriter() }));

  const circular = CTX();
  circular.self = circular;
  assert.doesNotThrow(() => recordVerdict(circular, DENY, 1, { env: {}, writer: captureWriter() }));
});

test('BEST-EFFORT: a writer returning null (drop) is not an error', () => {
  assert.equal(recordVerdict(CTX(), DENY, 1, { env: {}, writer: () => null }), null);
});

test('the written line is exactly one newline-terminated JSON record', () => {
  const w = captureWriter();
  recordVerdict(CTX(), ALLOW, 7, { env: {}, writer: w });
  assert.equal(w.lines.length, 1);
  assert.ok(w.lines[0].endsWith('\n'));
  const parsed = JSON.parse(w.lines[0]);
  assert.equal(parsed.decision, 'allow');
  assert.equal(parsed.duration_ms, 7);
});
