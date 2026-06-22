'use strict';

/**
 * bin/release-preflight.test.cjs — HERMETIC test of the OWN-02 release pre-flight runner.
 *
 * The runner (`bin/release-preflight.cjs`) runs the FOUR LIVE gsd-core release scripts in a
 * NON-MUTATING capacity, aggregates EVERY result (no fail-fast — D-06), and exits nonzero on
 * any failure, failing LOUD on a missing/unloadable LIVE script (HARD-02).
 *
 * THIS test spawns NO real children and require()s NO real gsd-core script. It injects
 * deterministic seams (gsdCoreRoot, spawnNode, loadLiveScript, readFile) so every <behavior>
 * is proven offline:
 *   (1) all four run even when an earlier one fails — no fail-fast; all four in results; ok:false.
 *   (2) ok:true ONLY when every result is ok; any single FAIL => ok:false and runCli returns 1.
 *   (3) a LIVE loader/spawn throw => that result is FAIL with an explicit detail; aggregate FAIL,
 *       never a silent skip or false green (LOUD on miss).
 *   (4) sync-manifest-versions is invoked with '--check'; sync-next-version uses the PURE
 *       predicate (no mutating main()/syncViaPr/applyVersion/--in-place invoked).
 *
 * @module bin/release-preflight.test
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  runReleasePreflight,
  runCli,
  checkNpmIntegrity,
  checkManifestVersions,
  checkNextVersion,
  SCRIPTS,
} = require('./release-preflight.cjs');

const ROOT = '/fake/gsd-core';
const GOOD_PKG = JSON.stringify({ version: '1.2.3' });

// --- Seam factories -------------------------------------------------------

/**
 * A spawnNode stub keyed by the script basename. Records every (scriptAbs, args) call so the
 * test can assert which flags were passed. Returns { status } verdicts.
 * @param {{integrity?:number, manifest?:number}} statuses
 * @param {Array} [calls] sink for invocation records
 */
function makeSpawnNode(statuses, calls) {
  return function spawnNode(scriptAbs, args, _root) {
    if (calls) calls.push({ scriptAbs, args: args.slice() });
    let status = 0;
    if (scriptAbs.endsWith('check-npm-integrity.cjs')) status = statuses.integrity ?? 0;
    else if (scriptAbs.endsWith('sync-manifest-versions.cjs')) status = statuses.manifest ?? 0;
    return { status, stdout: '', stderr: status === 0 ? '' : 'drift line' };
  };
}

/**
 * A loadLiveScript stub. Returns a fake smoke module (runSmoke + SMOKE) and a fake
 * next-version module (pure predicates) — never any mutating function. Records any mutating
 * call so the test can prove none were invoked.
 * @param {{smokeCode?:string, nextVersion?:string, throwOn?:string}} cfg
 * @param {Array} [mutating] sink — pushed to if a mutating fn is ever touched
 */
function makeLoad(cfg, mutating) {
  const okCode = 'ok';
  return function loadLiveScript(_root, rel) {
    if (cfg.throwOn && rel.endsWith(cfg.throwOn)) {
      const e = new Error('ScriptResolveError: live script not found: ' + rel);
      e.name = 'ScriptResolveError';
      throw e;
    }
    if (rel.endsWith('release-tarball-smoke.cjs')) {
      return {
        SMOKE: { OK: okCode },
        runSmoke(opts) {
          // Guard: the pre-flight MUST pass dryRun:true (non-mutating).
          if (!opts || opts.dryRun !== true) {
            throw new Error('runSmoke called WITHOUT dryRun:true — would mutate (forbidden)');
          }
          return { code: cfg.smokeCode || okCode, details: { dryRun: true } };
        },
      };
    }
    if (rel.endsWith('sync-next-version.cjs')) {
      return {
        versionFromPackageJson(text) {
          return JSON.parse(text).version;
        },
        isReleaseVersion(v) {
          return /^[0-9]+\.[0-9]+\.[0-9]+(-(rc|beta)\.[0-9]+)?$/.test(v);
        },
        // Mutating fns present on the real module — if the pre-flight EVER calls one,
        // record it so the test fails. The pre-flight must never touch these.
        applyVersion() {
          if (mutating) mutating.push('applyVersion');
        },
        syncViaPr() {
          if (mutating) mutating.push('syncViaPr');
        },
        main() {
          if (mutating) mutating.push('main');
        },
      };
    }
    throw new Error('unexpected requireLiveScript: ' + rel);
  };
}

function baseDeps(over = {}) {
  return Object.assign(
    {
      gsdCoreRoot: ROOT,
      spawnNode: makeSpawnNode({}),
      loadLiveScript: makeLoad({}),
      readFile: () => GOOD_PKG,
      existsFile: () => true, // the fake root has no real files; assert the spawn scripts "exist"
    },
    over
  );
}

// --- (1) no fail-fast: all four run even when an earlier one fails --------

test('(1) all four checks run even when the FIRST fails — no fail-fast', () => {
  // integrity exits 1 (drift) — earlier failure must NOT abort the rest.
  const r = runReleasePreflight(baseDeps({ spawnNode: makeSpawnNode({ integrity: 1 }) }));
  assert.equal(r.results.length, 4, 'all four results present despite an early failure');
  const scripts = r.results.map((x) => x.script);
  assert.deepEqual(
    scripts,
    [SCRIPTS.npmIntegrity, SCRIPTS.tarballSmoke, SCRIPTS.manifestVersions, SCRIPTS.nextVersion],
    'every LIVE script appears in the aggregate'
  );
  assert.equal(r.ok, false, 'aggregate is FAIL when any single check fails');
  assert.equal(r.results[0].ok, false, 'the failing integrity check is recorded FAIL');
  assert.equal(r.results[1].ok, true, 'later checks still ran and passed');
});

// --- (2) ok:true only when every result ok; any FAIL => exit 1 ------------

test('(2a) all green => ok:true and runCli returns 0', () => {
  const r = runReleasePreflight(baseDeps());
  assert.equal(r.ok, true);
  assert.ok(r.results.every((x) => x.ok));
  assert.equal(runCli(baseDeps()), 0);
});

test('(2b) a single manifest-drift FAIL => ok:false and runCli returns 1', () => {
  const deps = baseDeps({ spawnNode: makeSpawnNode({ manifest: 1 }) });
  const r = runReleasePreflight(deps);
  assert.equal(r.ok, false);
  const manifest = r.results.find((x) => x.script === SCRIPTS.manifestVersions);
  assert.equal(manifest.ok, false);
  assert.equal(runCli(baseDeps({ spawnNode: makeSpawnNode({ manifest: 1 }) })), 1);
});

test('(2c) a non-release package version => next-version FAIL => ok:false', () => {
  const r = runReleasePreflight(baseDeps({ readFile: () => JSON.stringify({ version: '1.3.1-dev.0' }) }));
  assert.equal(r.ok, false);
  const nv = r.results.find((x) => x.script === SCRIPTS.nextVersion);
  assert.equal(nv.ok, false);
  assert.match(nv.detail, /NOT a release version/);
});

// --- (3) LOUD on miss: a thrown LIVE loader => explicit FAIL, never silent --

test('(3a) a thrown LIVE loader (smoke) => that result is FAIL with explicit detail, aggregate FAIL', () => {
  const r = runReleasePreflight(baseDeps({ loadLiveScript: makeLoad({ throwOn: 'release-tarball-smoke.cjs' }) }));
  assert.equal(r.results.length, 4, 'still four results — never an omitted/silent skip');
  const smoke = r.results.find((x) => x.script === SCRIPTS.tarballSmoke);
  assert.equal(smoke.ok, false);
  assert.match(smoke.detail, /LOUD failure/);
  assert.equal(r.ok, false, 'aggregate FAIL — never a false green on a missing LIVE script');
});

test('(3b) a missing gsd-core root => LOUD aggregate error, runCli returns 1, never a green', () => {
  const r = runReleasePreflight({
    resolveRoot: () => {
      throw new Error('no gsd-core sentinel layout found');
    },
  });
  assert.equal(r.ok, false);
  assert.deepEqual(r.results, []);
  assert.match(r.error, /could not resolve gsd-core root/);
  assert.equal(runCli({ resolveRoot: () => { throw new Error('no gsd-core sentinel'); } }), 1);
});

test('(3c) smoke shape drift (no runSmoke export) => FAIL, not a crash or false green', () => {
  const load = (_root, rel) => {
    if (rel.endsWith('release-tarball-smoke.cjs')) return {}; // no runSmoke
    return makeLoad({})(_root, rel);
  };
  const r = runReleasePreflight(baseDeps({ loadLiveScript: load }));
  const smoke = r.results.find((x) => x.script === SCRIPTS.tarballSmoke);
  assert.equal(smoke.ok, false);
  assert.match(smoke.detail, /no runSmoke export|shape drift/);
  assert.equal(r.ok, false);
});

// --- (4) non-mutating invocation discipline ------------------------------

test('(4a) sync-manifest-versions is invoked with --check (never the mutating default)', () => {
  const calls = [];
  runReleasePreflight(baseDeps({ spawnNode: makeSpawnNode({}, calls) }));
  const manifestCall = calls.find((c) => c.scriptAbs.endsWith('sync-manifest-versions.cjs'));
  assert.ok(manifestCall, 'sync-manifest-versions was invoked');
  assert.ok(manifestCall.args.includes('--check'), 'the --check flag is present (non-mutating drift report)');
  // And it must NOT carry any mutating flag.
  assert.ok(!manifestCall.args.includes('--stage'), 'no mutating --stage flag');
});

test('(4b) sync-next-version uses the PURE predicate — no mutating fn is ever invoked', () => {
  const mutating = [];
  const r = runReleasePreflight(baseDeps({ loadLiveScript: makeLoad({}, mutating) }));
  assert.deepEqual(mutating, [], 'no applyVersion/syncViaPr/main was ever called');
  const nv = r.results.find((x) => x.script === SCRIPTS.nextVersion);
  assert.equal(nv.ok, true);
  assert.match(nv.detail, /valid release version/);
});

test('(4c) the tarball smoke is run dryRun:true — runSmoke throws if dryRun is omitted (proven by the stub guard)', () => {
  // The makeLoad stub throws if runSmoke is called without dryRun:true; a passing result proves
  // the pre-flight passed dryRun:true (non-mutating).
  const r = runReleasePreflight(baseDeps());
  const smoke = r.results.find((x) => x.script === SCRIPTS.tarballSmoke);
  assert.equal(smoke.ok, true);
  assert.match(smoke.detail, /non-mutating/);
});

// --- per-check unit coverage (explicit seams) ----------------------------

test('checkNpmIntegrity: exit 2 (tool error) => FAIL with detail', () => {
  const r = checkNpmIntegrity(ROOT, {
    existsFile: () => true,
    spawnNode: () => ({ status: 2, stdout: '', stderr: 'package-lock.json not found' }),
  });
  assert.equal(r.ok, false);
  assert.match(r.detail, /tool error \(exit 2\)/);
});

test('checkNpmIntegrity: a genuinely missing LIVE script => LOUD FAIL (never a false green)', () => {
  const r = checkNpmIntegrity(ROOT, {
    existsFile: () => false, // script absent at the resolved root
    spawnNode: () => {
      throw new Error('spawnNode should not be reached when the script is missing');
    },
  });
  assert.equal(r.ok, false);
  assert.match(r.detail, /LOUD failure: LIVE script not found/);
});

test('checkManifestVersions: a genuinely missing LIVE script => LOUD FAIL', () => {
  const r = checkManifestVersions(ROOT, {
    existsFile: () => false,
    spawnNode: () => {
      throw new Error('unreached');
    },
  });
  assert.equal(r.ok, false);
  assert.match(r.detail, /LOUD failure: LIVE script not found/);
});

test('checkNextVersion: pure predicate FAIL on a dev version via injected readFile', () => {
  const r = checkNextVersion(ROOT, {
    loadLiveScript: makeLoad({}),
    readFile: () => JSON.stringify({ version: '2.0.0-dev.1' }),
  });
  assert.equal(r.ok, false);
  assert.match(r.detail, /NOT a release version/);
});

test('checkNextVersion: pure predicate PASS on an rc version', () => {
  const r = checkNextVersion(ROOT, {
    loadLiveScript: makeLoad({}),
    readFile: () => JSON.stringify({ version: '2.0.0-rc.1' }),
  });
  assert.equal(r.ok, true);
});
