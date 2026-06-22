'use strict';

/**
 * node:test for hooks/lib/doctor.cjs — the HARD-02 / red-team H-E SHAPE-checking doctor.
 *
 * The doctor must assert each referenced LIVE script's exported function EXISTS and returns
 * its expected OUTPUT SHAPE on a known fixture — NOT existence alone. These tests use a
 * FIXTURE root (a tmpdir with stub `scripts/*.cjs` modules) so they never touch the real
 * gsd-core: a stub that returns the correct shape → pass; a stub MISSING the export → fail;
 * a stub whose export returns a DRIFTED shape → fail.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runDoctor, SHAPE_CHECKS } = require('./doctor.cjs');

/**
 * Build a fixture gsd-core-ish root: a tmpdir/scripts dir with one stub module per
 * SHAPE_CHECKS entry. `overrides[script]` is a JS source string for that stub's module;
 * scripts not overridden get a CORRECT-shape stub.
 */
function makeFixtureRoot(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-fix-'));
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });

  // Default correct-shape stub bodies keyed by export name.
  const correct = {
    evaluateVersionGate: "module.exports = { evaluateVersionGate: () => ({ action: 'close', reason: 'missing-version' }) };",
    classifyPrTarget: "module.exports = { classifyPrTarget: () => ({ decision: 'allowed' }) };",
    evaluatePrTemplate: "module.exports = { evaluatePrTemplate: () => ({ valid: false, action: 'warn' }) };",
    scoreCandidates: "module.exports = { scoreCandidates: () => ([{ number: 5, title: 'x', score: 1 }]) };",
    // affected-tests-lib: the entry checks the PURE resolveRunPlan shape AND that the non-pure
    // runAffectedTests gate-dependency is still an exported function (assertShape's 2nd arg).
    resolveRunPlan:
      "module.exports = { resolveRunPlan: () => ({ mode: 'suite', suite: 'unit' }), runAffectedTests: () => undefined };",
  };

  for (const entry of SHAPE_CHECKS) {
    const abs = path.join(root, entry.script);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const src =
      Object.prototype.hasOwnProperty.call(overrides, entry.script)
        ? overrides[entry.script]
        : correct[entry.exportName];
    fs.writeFileSync(abs, src);
  }
  return root;
}

function cleanup(root) {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch (_) {
    /* ignore */
  }
}

test('SHAPE_CHECKS covers every LIVE script the toolkit calls (>=4), each with a shape assertion', () => {
  assert.ok(Array.isArray(SHAPE_CHECKS));
  assert.ok(SHAPE_CHECKS.length >= 4);
  for (const c of SHAPE_CHECKS) {
    assert.strictEqual(typeof c.script, 'string');
    assert.strictEqual(typeof c.exportName, 'string');
    assert.ok('fixtureInput' in c);
    assert.strictEqual(typeof c.assertShape, 'function');
    assert.strictEqual(typeof c.describe, 'string');
  }
});

test('all stubs correct shape → report ok:true, every result ok', () => {
  const root = makeFixtureRoot();
  try {
    const report = runDoctor(root);
    assert.strictEqual(report.ok, true);
    assert.strictEqual(report.results.length, SHAPE_CHECKS.length);
    for (const r of report.results) {
      assert.strictEqual(r.ok, true, r.script + ' should be ok: ' + r.detail);
    }
  } finally {
    cleanup(root);
  }
});

test('a missing file → that result fails (ScriptResolveError), report ok:false', () => {
  const root = makeFixtureRoot();
  // delete one stub script on disk
  const victim = SHAPE_CHECKS[0];
  fs.rmSync(path.join(root, victim.script));
  try {
    const report = runDoctor(root);
    assert.strictEqual(report.ok, false);
    const r = report.results.find((x) => x.script === victim.script);
    assert.strictEqual(r.ok, false);
    assert.match(r.detail, /not found|ScriptResolveError|missing/i);
  } finally {
    cleanup(root);
  }
});

test('a present file MISSING the export → fails (not a pass)', () => {
  const victim = SHAPE_CHECKS[0];
  const root = makeFixtureRoot({ [victim.script]: 'module.exports = { somethingElse: 1 };' });
  try {
    const report = runDoctor(root);
    assert.strictEqual(report.ok, false);
    const r = report.results.find((x) => x.script === victim.script);
    assert.strictEqual(r.ok, false);
    assert.match(r.detail, /export|function/i);
  } finally {
    cleanup(root);
  }
});

test('a present export that is NOT a function → fails', () => {
  const victim = SHAPE_CHECKS[0];
  const root = makeFixtureRoot({
    [victim.script]: 'module.exports = { ' + victim.exportName + ': 42 };',
  });
  try {
    const report = runDoctor(root);
    assert.strictEqual(report.ok, false);
    const r = report.results.find((x) => x.script === victim.script);
    assert.strictEqual(r.ok, false);
    assert.match(r.detail, /function/i);
  } finally {
    cleanup(root);
  }
});

test('a DRIFTED return shape → fails (this is the H-E fix: shape, not existence)', () => {
  // evaluateVersionGate that no longer returns {action} — it returns a bare string.
  const vg = SHAPE_CHECKS.find((c) => c.exportName === 'evaluateVersionGate');
  const root = makeFixtureRoot({
    [vg.script]: "module.exports = { evaluateVersionGate: () => 'closed' };",
  });
  try {
    const report = runDoctor(root);
    assert.strictEqual(report.ok, false);
    const r = report.results.find((x) => x.script === vg.script);
    assert.strictEqual(r.ok, false);
    assert.match(r.detail, /shape|drift/i);
  } finally {
    cleanup(root);
  }
});

test('a DRIFTED scoreCandidates (empty array where a match is expected) → fails', () => {
  const sc = SHAPE_CHECKS.find((c) => c.exportName === 'scoreCandidates');
  const root = makeFixtureRoot({
    [sc.script]: 'module.exports = { scoreCandidates: () => [] };',
  });
  try {
    const report = runDoctor(root);
    assert.strictEqual(report.ok, false);
    const r = report.results.find((x) => x.script === sc.script);
    assert.strictEqual(r.ok, false);
  } finally {
    cleanup(root);
  }
});

test('affected-tests-lib: a module whose runAffectedTests gate-dependency vanished → fails (H-E)', () => {
  // resolveRunPlan still returns a valid shape, but runAffectedTests (the actual ENF-17 push
  // gate dependency) is gone — a gsd-core refactor must surface as a doctor FAIL, not a silent
  // fail-closed brick on the next push.
  const at = SHAPE_CHECKS.find((c) => c.script === 'scripts/affected-tests-lib.cjs');
  assert.ok(at, 'affected-tests-lib shape check must be registered');
  const root = makeFixtureRoot({
    [at.script]: "module.exports = { resolveRunPlan: () => ({ mode: 'suite', suite: 'unit' }) };",
  });
  try {
    const report = runDoctor(root);
    assert.strictEqual(report.ok, false);
    const r = report.results.find((x) => x.script === at.script);
    assert.strictEqual(r.ok, false);
    assert.match(r.detail, /shape|drift|function/i);
  } finally {
    cleanup(root);
  }
});

test('runDoctor NEVER throws on a missing/broken script — it reports (so the CLI can exit 1 cleanly)', () => {
  const root = makeFixtureRoot({ [SHAPE_CHECKS[0].script]: 'throw new Error("load boom");' });
  try {
    let report;
    assert.doesNotThrow(() => {
      report = runDoctor(root);
    });
    assert.strictEqual(report.ok, false);
  } finally {
    cleanup(root);
  }
});
