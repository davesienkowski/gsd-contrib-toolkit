'use strict';

/**
 * bin/ruleset-drift.test.cjs — HERMETIC test of the OWN-03 ruleset-drift advisory CLI.
 *
 * The doer (`bin/ruleset-drift.cjs`) reads the DECLARED ruleset state from
 * `<root>/.github/rulesets/*.json` (fs) and the LIVE state via `gh api repos/<repo>/rulesets`
 * (+ per-id detail for `rules`), diffs them by name on `enforcement` + the `rules` type set,
 * reports drift READ-ONLY by default, and runs the LIVE remediation shell scripts only behind
 * an explicit `--apply` (D-05/D-08). A failed declared OR live read surfaces a LOUD explicit
 * `error` — never a false "no drift" (HARD-02).
 *
 * THIS test injects deterministic seams (gsdCoreRoot, readDeclared, fetchLive, apply) so every
 * <behavior> is proven offline — NO real gh, NO real fs, NO real gsd-core, NO real shell:
 *   (1) declared vs live differ on enforcement / a missing ruleset / an extra ruleset / a
 *       differing rules set => non-empty drift naming each mismatch (name + field + declared/live).
 *   (2) declared and live match => empty drift, in-sync, runCli returns 0.
 *   (3) the declared read OR the live read throws => explicit `error`, NO empty-drift/in-sync,
 *       runCli returns 1 (LOUD on miss).
 *   (4) default invocation (no --apply) NEVER calls the apply seam; with --apply the named
 *       LIVE remediation is invoked exactly once.
 *
 * @module bin/ruleset-drift.test
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  runRulesetDrift,
  runCli,
  diffRulesets,
  buildRemediation,
} = require('./ruleset-drift.cjs');

const ROOT = '/fake/gsd-core';

// --- Fixtures -------------------------------------------------------------

// A declared ruleset set: name, enforcement, target, rules (type list).
function declaredOk() {
  return [
    { name: 'main-protection', target: 'branch', enforcement: 'evaluate', rules: ['deletion', 'non_fast_forward', 'pull_request'] },
    { name: 'tag-immutability', target: 'tag', enforcement: 'evaluate', rules: ['update', 'deletion'] },
  ];
}

// A live ruleset set mirroring declaredOk (in sync).
function liveInSync() {
  return [
    { name: 'main-protection', target: 'branch', enforcement: 'evaluate', rules: ['deletion', 'non_fast_forward', 'pull_request'] },
    { name: 'tag-immutability', target: 'tag', enforcement: 'evaluate', rules: ['update', 'deletion'] },
  ];
}

function baseDeps(over = {}) {
  return Object.assign(
    {
      gsdCoreRoot: ROOT,
      readDeclared: () => declaredOk(),
      fetchLive: () => liveInSync(),
      apply: false,
    },
    over
  );
}

// --- (1) drift detection --------------------------------------------------

test('(1a) an enforcement mismatch is surfaced as a drift row naming declared vs live', () => {
  const live = liveInSync();
  live[0].enforcement = 'disabled'; // main-protection drifted: declared evaluate, live disabled
  const r = runRulesetDrift(baseDeps({ fetchLive: () => live }));
  assert.equal(r.error, undefined, 'no error on a clean read');
  assert.ok(Array.isArray(r.drift) && r.drift.length > 0, 'drift is non-empty');
  const row = r.drift.find((d) => d.name === 'main-protection' && d.field === 'enforcement');
  assert.ok(row, 'an enforcement drift row for main-protection exists');
  assert.equal(row.declared, 'evaluate');
  assert.equal(row.live, 'disabled');
  assert.equal(r.inSync, false);
});

test('(1b) a declared ruleset missing from live is surfaced (declared-only)', () => {
  const live = [liveInSync()[0]]; // tag-immutability missing live
  const r = runRulesetDrift(baseDeps({ fetchLive: () => live }));
  const row = r.drift.find((d) => d.name === 'tag-immutability' && d.field === 'presence');
  assert.ok(row, 'a presence drift row for the declared-only ruleset exists');
  assert.equal(row.live, null, 'live side is null (absent)');
  assert.match(String(row.declared), /declared/i);
});

test('(1c) a live ruleset not declared is surfaced (live-only)', () => {
  const live = liveInSync().concat([{ name: 'rogue', target: 'branch', enforcement: 'active', rules: [] }]);
  const r = runRulesetDrift(baseDeps({ fetchLive: () => live }));
  const row = r.drift.find((d) => d.name === 'rogue' && d.field === 'presence');
  assert.ok(row, 'a presence drift row for the live-only ruleset exists');
  assert.equal(row.declared, null, 'declared side is null (undeclared)');
});

test('(1d) a differing rules set is surfaced', () => {
  const live = liveInSync();
  live[1].rules = ['update']; // tag-immutability lost the deletion rule
  const r = runRulesetDrift(baseDeps({ fetchLive: () => live }));
  const row = r.drift.find((d) => d.name === 'tag-immutability' && d.field === 'rules');
  assert.ok(row, 'a rules drift row for tag-immutability exists');
  assert.match(String(row.declared), /deletion/, 'declared rules listed');
});

// --- (2) in sync ----------------------------------------------------------

test('(2) declared == live => empty drift, inSync true, runCli returns 0', () => {
  const r = runRulesetDrift(baseDeps());
  assert.equal(r.error, undefined);
  assert.deepEqual(r.drift, []);
  assert.equal(r.inSync, true);
  let exit;
  const out = [];
  exit = runCli(baseDeps({ write: (s) => out.push(s) }));
  assert.equal(exit, 0, 'in-sync exits 0');
});

// --- (3) LOUD on miss -----------------------------------------------------

test('(3a) a thrown DECLARED read => explicit error, no empty-drift/in-sync, runCli returns 1', () => {
  const deps = baseDeps({
    readDeclared: () => {
      throw new Error('ENOENT: .github/rulesets/ missing');
    },
  });
  const r = runRulesetDrift(deps);
  assert.match(r.error, /declared/i, 'error names the declared read');
  assert.notEqual(r.inSync, true, 'never reports in-sync on a failed read');
  assert.equal(r.drift, undefined, 'no drift array on a LOUD miss');
  const exit = runCli(Object.assign({}, deps, { writeErr: () => {} }));
  assert.equal(exit, 1, 'LOUD miss exits 1');
});

test('(3b) a thrown LIVE read (gh api) => explicit error, never a false no-drift, runCli returns 1', () => {
  const deps = baseDeps({
    fetchLive: () => {
      throw new Error('gh: not authenticated');
    },
  });
  const r = runRulesetDrift(deps);
  assert.match(r.error, /live|gh api/i, 'error names the live read');
  assert.notEqual(r.inSync, true);
  const exit = runCli(Object.assign({}, deps, { writeErr: () => {} }));
  assert.equal(exit, 1);
});

test('(3c) an unresolvable gsd-core root => LOUD error, runCli returns 1, never a green', () => {
  const r = runRulesetDrift({
    resolveRoot: () => {
      throw new Error('no gsd-core sentinel layout found');
    },
  });
  assert.match(r.error, /could not resolve gsd-core root/);
  assert.notEqual(r.inSync, true);
  assert.equal(
    runCli({ resolveRoot: () => { throw new Error('no sentinel'); }, writeErr: () => {} }),
    1
  );
});

// --- (4) read-only by default; --apply guard ------------------------------

test('(4a) default invocation (no --apply) NEVER calls the apply seam', () => {
  const applyCalls = [];
  const live = liveInSync();
  live[0].enforcement = 'disabled'; // there IS drift — but no apply without the flag
  runRulesetDrift(baseDeps({ fetchLive: () => live, apply: false, applyRemediation: (...a) => applyCalls.push(a) }));
  assert.deepEqual(applyCalls, [], 'the apply seam was never invoked without --apply');
});

test('(4b) with --apply the named LIVE remediation is invoked', () => {
  const applyCalls = [];
  const live = liveInSync();
  live[0].enforcement = 'disabled';
  const r = runRulesetDrift(baseDeps({ fetchLive: () => live, apply: true, applyRemediation: (...a) => applyCalls.push(a) }));
  assert.equal(applyCalls.length, 1, 'the apply seam fired exactly once with --apply');
  assert.equal(r.applied, true);
});

test('(4c) --apply on an in-sync repo does NOT invoke remediation (nothing to apply)', () => {
  const applyCalls = [];
  const r = runRulesetDrift(baseDeps({ apply: true, applyRemediation: (...a) => applyCalls.push(a) }));
  assert.deepEqual(applyCalls, [], 'no remediation when there is no drift');
  assert.equal(r.applied, false);
});

// --- pure helper coverage -------------------------------------------------

test('diffRulesets: pure diff over enforcement + presence + rules', () => {
  const declared = [
    { name: 'a', enforcement: 'active', rules: ['x', 'y'] },
    { name: 'b', enforcement: 'evaluate', rules: ['z'] },
  ];
  const live = [
    { name: 'a', enforcement: 'disabled', rules: ['x', 'y'] }, // enforcement drift
    { name: 'c', enforcement: 'active', rules: [] }, // live-only; b declared-only
  ];
  const drift = diffRulesets(declared, live);
  assert.ok(drift.some((d) => d.name === 'a' && d.field === 'enforcement'));
  assert.ok(drift.some((d) => d.name === 'b' && d.field === 'presence' && d.live === null));
  assert.ok(drift.some((d) => d.name === 'c' && d.field === 'presence' && d.declared === null));
});

test('buildRemediation: surfaces the named LIVE remediation command strings', () => {
  const cmds = buildRemediation();
  const joined = cmds.join('\n');
  assert.match(joined, /sync-rulesets\.sh/);
  assert.match(joined, /setup-branch-protection\.sh/);
});
