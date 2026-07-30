'use strict';

/**
 * bin/self-test.test.cjs — HERMETIC test of the toolkit's OWN dog-food self-test runner.
 *
 * The runner (`bin/self-test.cjs`) packages TWO checks into one command:
 *   1. `node --check` over every hooks/**.cjs + bin/**.cjs (the JS analog of shellcheck).
 *   2. the existing node:test suite as the hook test harness.
 *
 * THIS test does NOT spawn real children. It injects deterministic spawn stubs through the
 * runner's seams so the verdict math is proven offline:
 *   (a) clean run                       => ok:true
 *   (d) one node --check failure        => ok:false
 *   (e) a failing test suite            => ok:false
 *   (f) a missing covered test file     => ok:false
 *
 * @module bin/self-test.test
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { runSelfTest, nodeCheckAll, coveredTestsCheck, executedTestsCheck, runTestSuite } = require('./self-test.cjs');

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

// A fixed file list so the walk is deterministic for nodeCheckAll-driven cases.
const FAKE_FILES = ['hooks/a.cjs', 'hooks/lib/b.cjs', 'bin/c.cjs'];

function baseDeps(over = {}) {
  return Object.assign(
    {
      repoRoot: '/repo',
      listFiles: () => FAKE_FILES.slice(),
      spawn: makeSpawn({}),
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

// --- executedTestsCheck unit (EXEC-01) ------------------------------------
//
// The defect this closes: COVERED_TESTS already NAMES hooks/fault-injection.test.cjs as covering
// HARD-01/HARD-02, but coveredTestsCheck only asserted the file EXISTS, and runTestSuite reads
// only the suite exit status (stdio:'inherit', so it cannot see counts). `node --test` exits 0
// when every case SKIPS. Measured 2026-07-30 from the toolkit root: 8 tests, 0 pass, 8 skipped —
// and the CLI printed "Self-test PASSED". A green that proves nothing read as a green.

/**
 * A spawn stub whose `--test <file>` runs emit a TAP summary tail.
 *
 * The file is located by scanning for the first NON-FLAG argv entry rather than by index:
 * executedTestsCheck pins `--test-reporter=tap` (Node 24 defaults to the `spec` reporter even on a
 * pipe), so the path is no longer at a fixed position and an index-based stub would silently stop
 * matching — a stub that quietly stops asserting is worse than one that breaks.
 */
function makeExecSpawn(tapByFile) {
  return function spawn(_cmd, args) {
    if (args.includes('--test')) {
      const file = args.find((a) => !a.startsWith('--'));
      const tap = tapByFile[file];
      if (!tap) return { status: 0, stdout: '# pass 3\n# fail 0\n# skipped 0\n' };
      return { status: tap.status === undefined ? 0 : tap.status, stdout: tap.stdout };
    }
    return { status: 0 };
  };
}

const MUST = [{ path: 'hooks/fault-injection.test.cjs', covers: 'HARD-01/HARD-02', mustExecute: true }];

test('executedTestsCheck: ok:false when a mustExecute proof SKIPPED every case (the 2026-07-30 defect)', () => {
  const r = executedTestsCheck({
    repoRoot: '/repo',
    covered: MUST,
    spawn: makeExecSpawn({
      '/repo/hooks/fault-injection.test.cjs': { stdout: '# tests 8\n# pass 0\n# fail 0\n# skipped 8\n' },
    }),
  });
  assert.equal(r.ok, false, 'zero executed cases must NOT read as success');
  assert.equal(r.unproven.length, 1);
  assert.match(r.unproven[0].path, /fault-injection/);
});

test('executedTestsCheck: ok:false when a mustExecute proof ran but skipped SOME cases', () => {
  const r = executedTestsCheck({
    repoRoot: '/repo',
    covered: MUST,
    spawn: makeExecSpawn({
      '/repo/hooks/fault-injection.test.cjs': { stdout: '# tests 8\n# pass 6\n# fail 0\n# skipped 2\n' },
    }),
  });
  assert.equal(r.ok, false, 'a partially-skipped load-bearing proof is still unproven');
});

test('executedTestsCheck: ok:true when every case actually executed', () => {
  const r = executedTestsCheck({
    repoRoot: '/repo',
    covered: MUST,
    spawn: makeExecSpawn({
      '/repo/hooks/fault-injection.test.cjs': { stdout: '# tests 8\n# pass 8\n# fail 0\n# skipped 0\n' },
    }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.unproven.length, 0);
  assert.equal(r.executed[0].pass, 8);
});

test('executedTestsCheck: entries WITHOUT mustExecute are not probed (no extra spawns)', () => {
  const spawned = [];
  const r = executedTestsCheck({
    repoRoot: '/repo',
    covered: [{ path: 'bin/self-test.test.cjs', covers: 'x' }],
    spawn: (_c, args) => {
      spawned.push(args.join(' '));
      return { status: 0, stdout: '# pass 1\n# fail 0\n# skipped 0\n' };
    },
  });
  assert.equal(r.ok, true);
  assert.deepEqual(spawned, [], 'only mustExecute entries are re-run');
});

test('executedTestsCheck: unparseable TAP output is treated as UNPROVEN, never as pass', () => {
  const r = executedTestsCheck({
    repoRoot: '/repo',
    covered: MUST,
    spawn: makeExecSpawn({ '/repo/hooks/fault-injection.test.cjs': { stdout: 'total garbage' } }),
  });
  assert.equal(r.ok, false, 'no parseable counts means no proof — fail loud');
});

test('runSelfTest: an all-skipped mustExecute proof flips overall ok:false', () => {
  const r = runSelfTest(
    baseDeps({
      covered: MUST,
      spawn: (cmd, args) => {
        if (args[0] === '--check') return { status: 0, stderr: '' };
        if (args.includes('--test') && args.some((a) => !a.startsWith('--'))) {
          return { status: 0, stdout: '# tests 8\n# pass 0\n# fail 0\n# skipped 8\n' };
        }
        return { status: 0 };
      },
    })
  );
  assert.equal(r.executedTests.ok, false);
  assert.equal(r.ok, false, 'self-test must NOT report PASSED over zero executed load-bearing cases');
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

test('(a) clean run => ok:true', () => {
  const r = runSelfTest(baseDeps());
  assert.equal(r.ok, true);
  assert.equal(r.nodeCheck.ok, true);
  assert.equal(r.testSuite.ok, true);
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
