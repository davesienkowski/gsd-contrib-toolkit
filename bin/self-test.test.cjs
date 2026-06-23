'use strict';

/**
 * bin/self-test.test.cjs — HERMETIC test of the toolkit's OWN dog-food self-test runner.
 *
 * The runner (`bin/self-test.cjs`) packages THREE checks into one command:
 *   1. `node --check` over every hooks/**.cjs + bin/**.cjs (the JS analog of shellcheck).
 *   2. `shellcheck install.sh` GATED on shellcheck availability (skip-with-note when ENOENT).
 *   3. the existing node:test suite as the hook test harness.
 *
 * THIS test does NOT spawn real children. It injects deterministic spawn/exec stubs through the
 * runner's seams so the verdict math is proven offline:
 *   (a) clean run + shellcheck PRESENT  => ok:true
 *   (b) shellcheck ENOENT               => ok:true AND the env-limitation note is carried + printed
 *   (c) shellcheck real (non-ENOENT) failure => ok:false
 *   (d) one node --check failure        => ok:false
 *   (e) a failing test suite            => ok:false
 *
 * The note assertion (b) is the TEST-04 honesty guard (T-05-04-SILENTPASS): an absent shellcheck
 * can NEVER be a silent green — the skip MUST be visible.
 *
 * @module bin/self-test.test
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { runSelfTest, nodeCheckAll, tryShellcheck, coveredTestsCheck, runTestSuite } = require('./self-test.cjs');

const NOTE = 'shellcheck not installed — skipped (env limitation; runnable in CI)';

// --- Stub factories -------------------------------------------------------

/**
 * A spawn stub that routes by argv: `--check <file>` and `--test ...` get separate verdicts.
 * @param {{check?: (file:string)=>{status:number, stderr?:string}, test?: ()=>{status:number}}} cfg
 */
function makeSpawn(cfg) {
  return function spawn(_cmd, args) {
    if (args[0] === '--check') {
      const file = args[1];
      const r = (cfg.check ? cfg.check(file) : { status: 0 });
      return { status: r.status, stderr: r.stderr || '' };
    }
    if (args[0] === '--test') {
      const r = (cfg.test ? cfg.test() : { status: 0 });
      return { status: r.status };
    }
    return { status: 0 };
  };
}

/**
 * An exec stub for shellcheck: 'ok' => returns; 'enoent' => throws ENOENT; 'fail' => throws status.
 * @param {'ok'|'enoent'|'fail'} mode
 */
function makeExec(mode) {
  return function exec() {
    if (mode === 'ok') return '';
    if (mode === 'enoent') {
      const e = new Error('spawn shellcheck ENOENT');
      e.code = 'ENOENT';
      throw e;
    }
    // real shellcheck failure: ran, found problems → numeric status, no ENOENT.
    const e = new Error('shellcheck found issues');
    e.status = 1;
    e.stderr = 'install.sh:1:1: warning: SC2086';
    throw e;
  };
}

// A fixed file list so the walk is deterministic for nodeCheckAll-driven cases.
const FAKE_FILES = ['hooks/a.cjs', 'hooks/lib/b.cjs', 'bin/c.cjs'];

function baseDeps(over = {}) {
  return Object.assign(
    {
      repoRoot: '/repo',
      listFiles: () => FAKE_FILES.slice(),
      spawn: makeSpawn({}),
      exec: makeExec('ok'),
      // Deterministic covered-tests presence (hermetic — the real files live under the real repo, not
      // the fake /repo). Default: all enumerated test files present, so the composition math is clean.
      covered: [{ path: 'bin/contrib-capability.test.cjs', covers: 'lifecycle' }],
      exists: () => true,
    },
    over
  );
}

// --- nodeCheckAll unit ----------------------------------------------------

test('nodeCheckAll: ok:true when every file passes --check', () => {
  const r = nodeCheckAll({
    repoRoot: '/repo',
    listFiles: () => FAKE_FILES.slice(),
    spawn: makeSpawn({}),
  });
  assert.equal(r.ok, true);
  assert.equal(r.failures.length, 0);
});

test('nodeCheckAll: ok:false and records the failing file', () => {
  const r = nodeCheckAll({
    repoRoot: '/repo',
    listFiles: () => FAKE_FILES.slice(),
    spawn: makeSpawn({ check: (f) => (f.endsWith('b.cjs') ? { status: 1, stderr: 'SyntaxError' } : { status: 0 }) }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.failures.length, 1);
  assert.match(r.failures[0].path, /b\.cjs$/);
});

// --- tryShellcheck unit ---------------------------------------------------

test('tryShellcheck: present + clean => ok:true, ran:true', () => {
  const r = tryShellcheck('install.sh', { exec: makeExec('ok') });
  assert.deepEqual({ ok: r.ok, ran: r.ran }, { ok: true, ran: true });
});

test('tryShellcheck: ENOENT => ok:true, ran:false, with the env-limitation note', () => {
  const r = tryShellcheck('install.sh', { exec: makeExec('enoent') });
  assert.equal(r.ok, true);
  assert.equal(r.ran, false);
  assert.equal(r.note, NOTE);
});

test('tryShellcheck: real (non-ENOENT) failure => ok:false, ran:true', () => {
  const r = tryShellcheck('install.sh', { exec: makeExec('fail') });
  assert.equal(r.ok, false);
  assert.equal(r.ran, true);
});

// --- runTestSuite unit ----------------------------------------------------

test('runTestSuite: ok:true on status 0', () => {
  const r = runTestSuite({ repoRoot: '/repo', spawn: makeSpawn({ test: () => ({ status: 0 }) }) });
  assert.equal(r.ok, true);
});

test('runTestSuite: ok:false on nonzero status', () => {
  const r = runTestSuite({ repoRoot: '/repo', spawn: makeSpawn({ test: () => ({ status: 1 }) }) });
  assert.equal(r.ok, false);
});

// --- coveredTestsCheck unit -----------------------------------------------

test('coveredTestsCheck: ok:true when every enumerated test file is present', () => {
  const r = coveredTestsCheck({
    repoRoot: '/repo',
    covered: [{ path: 'bin/contrib-capability.test.cjs', covers: 'lifecycle' }],
    exists: () => true,
  });
  assert.equal(r.ok, true);
  assert.equal(r.missing.length, 0);
  assert.equal(r.present.length, 1);
});

test('coveredTestsCheck: ok:false and records the missing file (a vanished proof is caught, not silently un-run)', () => {
  const r = coveredTestsCheck({
    repoRoot: '/repo',
    covered: [
      { path: 'bin/contrib-capability.test.cjs', covers: 'lifecycle' },
      { path: 'bin/self-test.test.cjs', covers: 'runner' },
    ],
    exists: (p) => !p.endsWith('contrib-capability.test.cjs'),
  });
  assert.equal(r.ok, false);
  assert.equal(r.missing.length, 1);
  assert.match(r.missing[0].path, /contrib-capability\.test\.cjs$/);
});

// --- runSelfTest composition (cases a–e) ----------------------------------

test('(a) clean run + shellcheck present => ok:true', () => {
  const r = runSelfTest(baseDeps());
  assert.equal(r.ok, true);
  assert.equal(r.nodeCheck.ok, true);
  assert.equal(r.shellcheck.ok, true);
  assert.equal(r.testSuite.ok, true);
});

test('(b) shellcheck ENOENT => ok:true AND note carried (honest skip, not silent pass)', () => {
  const r = runSelfTest(baseDeps({ exec: makeExec('enoent') }));
  assert.equal(r.ok, true);
  assert.equal(r.shellcheck.ran, false);
  assert.equal(r.shellcheck.note, NOTE);
});

test('(c) non-ENOENT shellcheck failure => ok:false', () => {
  const r = runSelfTest(baseDeps({ exec: makeExec('fail') }));
  assert.equal(r.ok, false);
  assert.equal(r.shellcheck.ok, false);
});

test('(d) one node --check failure => ok:false', () => {
  const r = runSelfTest(
    baseDeps({
      spawn: makeSpawn({ check: (f) => (f.endsWith('c.cjs') ? { status: 1, stderr: 'SyntaxError' } : { status: 0 }) }),
    })
  );
  assert.equal(r.ok, false);
  assert.equal(r.nodeCheck.ok, false);
});

test('(e) failing test suite => ok:false', () => {
  const r = runSelfTest(baseDeps({ spawn: makeSpawn({ test: () => ({ status: 1 }) }) }));
  assert.equal(r.ok, false);
  assert.equal(r.testSuite.ok, false);
});

test('(f) a missing covered (enumerated) test file => ok:false (named coverage is fail-loud)', () => {
  const r = runSelfTest(
    baseDeps({
      covered: [{ path: 'bin/contrib-capability.test.cjs', covers: 'lifecycle' }],
      exists: () => false,
    })
  );
  assert.equal(r.ok, false);
  assert.equal(r.coveredTests.ok, false);
  assert.equal(r.coveredTests.missing.length, 1);
});
