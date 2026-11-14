'use strict';

/**
 * bin/pr-update-write-contract.test.cjs - the contract between bin/pr-update.cjs's five outward writes and the dev-env
 * PermissionRequest hook that will rebuild them (quick 261113-wk1, QT-1 of the review-convergence design E).
 *
 * The fixture bin/fixtures/pr-update-write-shapes.json is plain data with hand-written emitted text. This test pins:
 *   - buildWrite(shape, fields) reproduces the fixture's argv and text byte for byte;
 *   - `bash -c 'printf "%s\n" <text>'` yields the fixture argv, one line per word (the shq serializer claim);
 *   - each closed field class refuses a value outside it, and an unknown shape, a missing or an extra field is refused.
 *
 * @module bin/pr-update-write-contract.test
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { buildWrite } = require('./pr-update.cjs');
const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'pr-update-write-shapes.json'), 'utf8'));

const five = ['fork_push', 'selftest_put', 'pr_edit_body', 'pr_comment', 'reviewers_post'];
const clone = (x) => JSON.parse(JSON.stringify(x));

test('the fixture holds exactly the five shapes', () => {
  assert.deepEqual(FIXTURE.shapes.map((s) => s.shape), five);
});

for (const s of FIXTURE.shapes) {
  test(`${s.shape}: buildWrite reproduces the fixture argv and text`, () => {
    const w = buildWrite(s.shape, clone(s.fields), FIXTURE.workDir);
    assert.deepEqual(w.argv, s.argv);
    assert.equal(w.text, s.text);
    assert.equal(w.shape, s.shape);
    assert.deepEqual(w.fields, s.fields);
  });

  test(`${s.shape}: bash printf over the emitted text builds the intended argv`, () => {
    const r = spawnSync('bash', ['-c', `printf "%s\\n" ${s.text}`], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    // No argv word here contains a newline, so one output line is one argv word.
    assert.deepEqual(r.stdout.split('\n').slice(0, -1), s.argv);
  });
}

test('the printf claim bites: a quote or expansion in a free-text word stays one literal word', () => {
  const f = clone(FIXTURE.shapes.find((x) => x.shape === 'selftest_put').fields);
  const w = buildWrite('selftest_put', f, FIXTURE.workDir);
  const r = spawnSync('bash', ['-c', `printf "%s\\n" ${w.text}`], { encoding: 'utf8' });
  assert.ok(r.stdout.includes('message=selftest: run gsd-core 012345678 (PR 5871)\n'));
});

for (const row of FIXTURE.refusals) {
  test(`refuses ${row.shape} ${row.field} (${row.why})`, () => {
    const base = clone(FIXTURE.shapes.find((x) => x.shape === row.shape).fields);
    const bad = { ...base, ...clone(row.set) };
    // A StepFail (the step's refusal), naming the field; a TypeError from a missing function must not pass.
    assert.throws(() => buildWrite(row.shape, bad, FIXTURE.workDir), (e) => e.constructor.name === 'StepFail' && e.message.includes(row.field));
  });
}

test('refuses an unknown shape', () => {
  assert.throws(() => buildWrite('no_such_shape', {}, FIXTURE.workDir), /unknown shape/);
});

test('refuses a missing field', () => {
  const f = clone(FIXTURE.shapes.find((x) => x.shape === 'pr_comment').fields);
  delete f.bodyFile;
  assert.throws(() => buildWrite('pr_comment', f, FIXTURE.workDir), /bodyFile/);
});

test('refuses an extra field', () => {
  const f = { ...clone(FIXTURE.shapes.find((x) => x.shape === 'pr_comment').fields), flag: '--web' };
  assert.throws(() => buildWrite('pr_comment', f, FIXTURE.workDir), /flag/);
});

test('refuses a work dir outside the path class', () => {
  const s = FIXTURE.shapes.find((x) => x.shape === 'pr_comment');
  assert.throws(() => buildWrite('pr_comment', clone(s.fields), '/home/x y/work'), /workDir/);
});
