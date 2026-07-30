'use strict';

/**
 * bin/convention-drift.test.cjs — HERMETIC test of the CONV-01 replicated-convention detector.
 *
 * The load-bearing property is NOT "it says in sync against today's gsd-core" — that is trivially
 * true and would still be true if every comparison were stubbed out. What must be proven is that
 * it DETECTS each drift class, and that an unreadable/unrecognisable source FAILS rather than
 * quietly reporting sync. Every check is driven through injected fixtures.
 *
 * @module bin/convention-drift.test
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const cd = require('./convention-drift.cjs');

// A minimal stand-in for the upstream branch-naming workflow's inline github-script body.
function liveWorkflow({ prefixes = ['feat/', 'fix/'], exact = ['main', 'next'], startsWith = ['gsd/'], warn = true } = {}) {
  return [
    'const validPrefixes = [',
    prefixes.map((p) => "  '" + p + "',").join('\n'),
    '];',
    "const alwaysValid = [" + exact.map((e) => "'" + e + "'").join(', ') + '];',
    ...startsWith.map((p) => "if (branch.startsWith('" + p + "')) return;"),
    warn ? 'core.warning(`nope`);' : 'core.setFailed(`nope`);',
  ].join('\n');
}

const LOCAL = {
  UPSTREAM_BRANCH_PREFIXES: ['feat/', 'fix/'],
  BRANCH_EXEMPT_EXACT: ['main', 'next'],
  BRANCH_EXEMPT_PREFIXES: ['gsd/'],
};

const byCheck = (results, name) => results.find((r) => r.check === name);

// --- extractArrayLiteral ----------------------------------------------------

test('extractArrayLiteral: pulls a JS array literal out of the YAML-embedded script', () => {
  assert.deepEqual(cd.extractArrayLiteral(liveWorkflow(), 'validPrefixes'), ['feat/', 'fix/']);
});

test('extractArrayLiteral: returns null when the literal is absent (never a guessed [])', () => {
  assert.equal(cd.extractArrayLiteral('nothing here', 'validPrefixes'), null);
});

// --- drift DETECTION (the load-bearing cases) -------------------------------

test('DETECTS a prefix added upstream that the toolkit does not know about', () => {
  const r = cd.checkBranchReplicas('/fake', {
    readFile: () => liveWorkflow({ prefixes: ['feat/', 'fix/', 'perf/'] }),
    localConstants: LOCAL,
  });
  const c = byCheck(r, 'branch prefixes');
  assert.equal(c.ok, false);
  assert.match(c.detail, /only upstream: perf\//);
});

test('DETECTS a prefix the toolkit still accepts but upstream dropped (over-permissive replica)', () => {
  const r = cd.checkBranchReplicas('/fake', {
    readFile: () => liveWorkflow({ prefixes: ['feat/'] }),
    localConstants: LOCAL,
  });
  const c = byCheck(r, 'branch prefixes');
  assert.equal(c.ok, false);
  assert.match(c.detail, /only in toolkit: fix\//);
});

test('DETECTS exact-exemption drift', () => {
  const r = cd.checkBranchReplicas('/fake', {
    readFile: () => liveWorkflow({ exact: ['main'] }),
    localConstants: LOCAL,
  });
  assert.equal(byCheck(r, 'branch exempt (exact)').ok, false);
});

test('DETECTS a prefix-exemption the toolkit honors but upstream removed', () => {
  const r = cd.checkBranchReplicas('/fake', {
    readFile: () => liveWorkflow({ startsWith: [] }),
    localConstants: LOCAL,
  });
  const c = byCheck(r, 'branch exempt (prefix)');
  assert.equal(c.ok, false);
  assert.match(c.detail, /gsd\//);
});

test('DETECTS a severity change upstream (warn -> fail) as a NOTE demanding a deliberate decision', () => {
  const r = cd.checkBranchReplicas('/fake', {
    readFile: () => liveWorkflow({ warn: false }),
    localConstants: LOCAL,
  });
  const c = byCheck(r, 'branch severity');
  assert.match(c.detail, /no longer uses core\.warning|deliberately/i);
});

test('DETECTS a renamed POLICY-02 npm script (would fail-close every governed commit)', () => {
  const r = cd.checkPolicyScriptNames('/fake', {
    readFile: () => JSON.stringify({ scripts: { 'lint:ci': 'x' } }),
    policyChecks: [{ name: 'lint:ci' }, { name: 'check:alias-drift' }],
  });
  assert.equal(r.ok, false);
  assert.match(r.detail, /check:alias-drift/);
  assert.match(r.detail, /fail closed/i);
});

// --- unreadable/unrecognisable sources must FAIL, never pass ----------------

test('an unreadable workflow FAILS — a replica that cannot be compared is never "in sync"', () => {
  const r = cd.checkBranchReplicas('/fake', {
    readFile: () => { throw new Error('ENOENT'); },
    localConstants: LOCAL,
  });
  assert.equal(r.length, 1);
  assert.equal(r[0].ok, false);
  assert.match(r[0].detail, /NEVER reported in sync/);
});

test('a RESTRUCTURED workflow (literal gone) FAILS rather than reporting sync', () => {
  const r = cd.checkBranchReplicas('/fake', {
    readFile: () => 'the policy moved somewhere else entirely',
    localConstants: LOCAL,
  });
  assert.equal(byCheck(r, 'branch prefixes').ok, false);
  assert.match(byCheck(r, 'branch prefixes').detail, /restructured/);
});

test('an unreadable package.json FAILS the POLICY-02 check', () => {
  const r = cd.checkPolicyScriptNames('/fake', {
    readFile: () => { throw new Error('ENOENT'); },
  });
  assert.equal(r.ok, false);
  assert.match(r.detail, /LOUD failure/);
});

// --- in-sync + aggregate ----------------------------------------------------

test('reports in sync when the replicas genuinely match', () => {
  const r = cd.checkBranchReplicas('/fake', { readFile: () => liveWorkflow(), localConstants: LOCAL });
  for (const c of r) assert.equal(c.ok, true, c.check + ': ' + c.detail);
});

test('version rot is a NOTE, not a failure (nothing consumes the version yet)', () => {
  const r = cd.checkVersionRot({
    readFile: () => JSON.stringify({ version: '2.1.3' }),
    listTags: () => ['v2.6', 'v2.7'],
  });
  assert.equal(r.ok, true);
  assert.equal(r.note, true);
  assert.match(r.detail, /predates the latest tag v2\.7/);
  assert.match(r.detail, /--version/);
});

test('version matching the latest tag is a clean PASS with no note', () => {
  const r = cd.checkVersionRot({
    readFile: () => JSON.stringify({ version: '2.7' }),
    listTags: () => ['v2.6', 'v2.7'],
  });
  assert.equal(r.ok, true);
  assert.notEqual(r.note, true);
});

test('an unresolvable gsd-core root is a LOUD aggregate failure, never a false green', () => {
  const r = cd.runConventionDrift({
    resolveRoot: () => { throw new Error('no sentinel'); },
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /could not resolve/);
});

test('aggregate: NO fail-fast — a failing early check does not hide later ones', () => {
  const r = cd.runConventionDrift({
    gsdCoreRoot: '/fake',
    readFile: (p) => {
      if (String(p).endsWith('package.json')) return JSON.stringify({ scripts: {} });
      return liveWorkflow({ prefixes: ['totally/', 'different/'] });
    },
    localConstants: LOCAL,
    listTags: () => [],
  });
  assert.equal(r.ok, false);
  assert.ok(r.results.length >= 5, 'every check still ran, got ' + r.results.length);
  assert.equal(byCheck(r.results, 'branch prefixes').ok, false);
  assert.equal(byCheck(r.results, 'POLICY-02 script names').ok, false);
});
