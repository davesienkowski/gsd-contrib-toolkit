#!/usr/bin/env node
'use strict';

/**
 * bin/self-test.cjs — the toolkit's OWN dog-food self-test (TEST-04 / red-team H-G).
 *
 * One command (`node bin/self-test.cjs`) packages TWO checks so a syntax-broken or
 * behaviorally-broken hook is caught BEFORE it can fail-closed-brick the workflow:
 *
 *   1. node --check over EVERY hooks/**.cjs + bin/**.cjs — the honest JS analog of
 *      "shellcheck every hook". A syntax-broken .cjs (including a *.test.cjs — a broken
 *      test file is also a brick) flips ok:false (T-05-04-MISSFILE: the walk includes lib/
 *      and *.test.cjs so no brick-prone file is skipped).
 *   2. the existing node:test suite as the hook test harness — nonzero status => fail.
 *      The repo-wide `node --test` already DISCOVERS every *.test.cjs, so the install/toggle
 *      lifecycle proof (bin/contrib-capability.test.cjs, CAP-07) runs as part of this suite. To
 *      make that coverage EXPLICIT (so a missing/renamed test file is CAUGHT, not silently un-run),
 *      runSelfTest also enumerates the load-bearing test files (COVERED_TESTS) and flips ok:false
 *      if any is absent — and the CLI NAMES them, so the install/toggle surface is visible at runtime.
 *
 * Exit code is 0 ONLY when node --check is clean, the enumerated load-bearing test files
 * are present, AND the test suite is green. Every subprocess verdict derives strictly from
 * status===0 (T-05-04-SWALLOW: a non-zero status can never be swallowed).
 *
 * Pure node builtins (node:fs, node:child_process) — installs NOTHING (T-05-04-SC).
 * Mirrors doctor.cjs's runCli/exit pattern and lint-ci-stamp.cjs's execFileSync discipline.
 * Modifies NO hook.
 *
 * @module bin/self-test
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const SCAN_DIRS = ['hooks', 'bin'];

/**
 * Load-bearing test files the suite MUST run, each with a human-readable name of the surface it
 * covers. `node --test` discovers *.test.cjs by glob, so a renamed/deleted test would silently
 * vanish from the run (a green suite that no longer proves what it claims). Enumerating them here
 * — and flipping ok:false when one is absent — makes the coverage EXPLICIT and the install/toggle
 * lifecycle proof a NAMED, fail-loud part of the self-test (CONTEXT: "self-test.cjs integrates the
 * new checks"). Repo-relative POSIX paths.
 */
const COVERED_TESTS = Object.freeze([
  { path: 'bin/contrib-capability.test.cjs', covers: 'capability install/off/on/remove lifecycle (CAP-07, disposable sandbox)' },
  { path: 'bin/install-delivers-skills.test.cjs', covers: 'CAP-09 LOCAL install delivers both skills to the install root, overlay-expected form' },
  { path: 'bin/install-delivers-commands.test.cjs', covers: 'CAP-10 LOCAL install delivers the 5 commands to the runtime commands dir + remove reclaims them; manifest has no commands[] array' },
  { path: 'bin/self-test.test.cjs', covers: 'the self-test runner itself (hermetic verdict math)' },
  { path: 'bin/verify-capability.test.cjs', covers: 'CAP-11 tri-surface declared==shipped parity (bundle-sourced, bidirectional, 6-cell deliberate-mismatch matrix)' },
  { path: 'bin/offramp-presence.test.cjs', covers: 'FLOW-01 Recovery Offramp present + consistent across the 3 canonical surfaces and their 3 bundled copies (both paths named + fail-closed/advisory no-bypass disclaimer + byte-parity)' },
  { path: 'bin/advisory-banner-presence.test.cjs', covers: 'RUN-02 advisory-degradation banner present + byte-parity across canonical + bundled skills, never "unbypassable", + driver Claude-only enforcement honesty line' },
  { path: 'hooks/fault-injection.test.cjs', covers: 'HARD-01/HARD-02 fault injection (fail-closed deny + shape drift)', mustExecute: true },
]);

/**
 * Recursively list every *.cjs (relative to repoRoot) under hooks/ and bin/. Includes lib/
 * and *.test.cjs deliberately — a broken test or lib file bricks the workflow too.
 *
 * @param {string} repoRoot absolute repo root.
 * @returns {string[]} repo-relative POSIX paths, sorted for deterministic output.
 */
function listCjsFiles(repoRoot) {
  const out = [];
  for (const dir of SCAN_DIRS) {
    const abs = path.join(repoRoot, dir);
    if (!fs.existsSync(abs)) continue;
    walk(abs);
  }
  out.sort();
  return out;

  function walk(absDir) {
    for (const ent of fs.readdirSync(absDir, { withFileTypes: true })) {
      const full = path.join(absDir, ent.name);
      if (ent.isDirectory()) {
        walk(full);
      } else if (ent.isFile() && ent.name.endsWith('.cjs')) {
        out.push(path.relative(repoRoot, full).split(path.sep).join('/'));
      }
    }
  }
}

/**
 * node --check every discovered *.cjs. ok iff zero failures.
 *
 * @param {object} deps
 * @param {string} deps.repoRoot
 * @param {() => string[]} [deps.listFiles] injectable file lister (defaults to the real walk).
 * @param {(cmd:string, args:string[], opts?:object) => {status:number, stderr?:string}} [deps.spawn]
 * @returns {{ok:boolean, total:number, failures:{path:string, stderr:string}[]}}
 */
function nodeCheckAll(deps) {
  const repoRoot = deps.repoRoot;
  const listFiles = deps.listFiles || (() => listCjsFiles(repoRoot));
  const spawn = deps.spawn || ((cmd, args, opts) => spawnSync(cmd, args, opts));

  const files = listFiles();
  const failures = [];
  for (const rel of files) {
    const abs = path.isAbsolute(rel) ? rel : path.join(repoRoot, rel);
    const r = spawn(process.execPath, ['--check', abs], { encoding: 'utf8' });
    if (!r || r.status !== 0) {
      failures.push({ path: rel, stderr: (r && r.stderr) || '' });
    }
  }
  return { ok: failures.length === 0, total: files.length, failures };
}

/**
 * Verify each load-bearing, NAMED test file (COVERED_TESTS) is present on disk. `node --test`
 * discovers tests by glob, so a renamed/deleted file silently drops out of the run; this makes the
 * coverage EXPLICIT — a missing enumerated test flips ok:false so a vanished proof is caught, not
 * silently un-run. (The repo-wide `node --test` still EXECUTES them; this is the presence guard.)
 *
 * @param {object} deps
 * @param {string} deps.repoRoot
 * @param {Array<{path:string, covers:string}>} [deps.covered] injectable enumeration (defaults to COVERED_TESTS).
 * @param {(p:string) => boolean} [deps.exists] injectable existence check (defaults to fs.existsSync).
 * @returns {{ok:boolean, present:{path:string, covers:string}[], missing:{path:string, covers:string}[]}}
 */
function coveredTestsCheck(deps) {
  const repoRoot = deps.repoRoot;
  const covered = deps.covered || COVERED_TESTS;
  const exists = deps.exists || ((p) => fs.existsSync(p));
  const present = [];
  const missing = [];
  for (const entry of covered) {
    const abs = path.isAbsolute(entry.path) ? entry.path : path.join(repoRoot, entry.path);
    (exists(abs) ? present : missing).push(entry);
  }
  return { ok: missing.length === 0, present, missing };
}

/**
 * Parse the TAP summary counters `node --test` prints at the end of a run.
 *
 * @param {string} stdout captured run output.
 * @returns {{pass:number, fail:number, skipped:number}|null} null when no counters are parseable.
 */
function parseTapCounts(stdout) {
  const s = String(stdout || '');
  const read = (label) => {
    const m = s.match(new RegExp('^#\\s*' + label + '\\s+(\\d+)\\s*$', 'm'));
    return m ? Number(m[1]) : null;
  };
  const pass = read('pass');
  const fail = read('fail');
  const skipped = read('skipped');
  if (pass === null && fail === null && skipped === null) return null;
  return { pass: pass || 0, fail: fail || 0, skipped: skipped || 0 };
}

/**
 * EXEC-01 — prove the load-bearing tests actually EXECUTED, not merely that they exist.
 *
 * `coveredTestsCheck` above answers "is the file still on disk?". That is not the same question as
 * "did its cases run?", and the gap was live: `hooks/fault-injection.test.cjs` gates its 8
 * HARD-01/HARD-02 cases on a reachable gsd-core checkout and SKIPS them otherwise. `node --test`
 * exits 0 on an all-skipped file, and `runTestSuite` reads only that exit status (it inherits
 * stdio, so it never sees the counts). Measured from the toolkit root on 2026-07-30: 8 tests,
 * 0 pass, 8 skipped — and the CLI printed "Self-test PASSED". The toolkit's own honest-green
 * ritual was reporting success over a proof that had not run.
 *
 * So: re-run each `mustExecute` entry with CAPTURED stdout and require that it executed at least
 * one case and skipped none. Only `mustExecute` entries are probed, so the extra cost is one
 * short spawn (~60ms), not a second full suite.
 *
 * Fail-loud by construction: unparseable output, a missing spawn result, or zero executed cases
 * are ALL "unproven". Nothing here can turn an absent proof into a pass.
 *
 * @param {object} deps
 * @param {string} deps.repoRoot
 * @param {Array<{path:string, covers:string, mustExecute?:boolean}>} [deps.covered]
 * @param {(cmd:string, args:string[], opts?:object) => {status:number, stdout?:string}} [deps.spawn]
 * @returns {{ok:boolean, executed:Array<object>, unproven:Array<object>}}
 */
function executedTestsCheck(deps) {
  const repoRoot = deps.repoRoot;
  const covered = deps.covered || COVERED_TESTS;
  const spawn = deps.spawn || ((cmd, args, opts) => spawnSync(cmd, args, opts));
  const probeCwd = deps.probeCwd || process.cwd();

  const executed = [];
  const unproven = [];

  for (const entry of covered) {
    if (!entry.mustExecute) continue;
    const abs = path.isAbsolute(entry.path) ? entry.path : path.join(repoRoot, entry.path);
    // Probe with the INVOKER's cwd, not repoRoot. fault-injection.test.cjs resolves its gsd-core
    // source via resolveGsdCoreRoot(process.cwd()), which walks UP from cwd — and the toolkit and
    // gsd-core are siblings, so a probe rooted at repoRoot can never reach one. `node --test` is
    // given an ABSOLUTE file path here, so discovery does not depend on cwd (unlike runTestSuite's
    // repo-wide run, which must stay rooted at repoRoot to discover the suite at all).
    // This mirrors hooks/doctor.cjs's documented usage: run it from inside a gsd-core checkout.
    const r = spawn(process.execPath, ['--test', abs], { encoding: 'utf8', cwd: probeCwd });
    const counts = r ? parseTapCounts(r.stdout) : null;

    if (!counts) {
      unproven.push({ ...entry, reason: 'no parseable TAP counters — the run produced no proof' });
      continue;
    }
    if (counts.pass === 0 && counts.fail === 0) {
      unproven.push({ ...entry, ...counts, reason: 'ZERO cases executed (' + counts.skipped + ' skipped)' });
      continue;
    }
    if (counts.skipped > 0) {
      unproven.push({ ...entry, ...counts, reason: counts.skipped + ' case(s) SKIPPED — partially unproven' });
      continue;
    }
    executed.push({ ...entry, ...counts });
  }

  return { ok: unproven.length === 0, executed, unproven };
}

/**
 * Run the existing node:test suite as the self-test core. nonzero status => fail.
 *
 * @param {object} deps
 * @param {string} deps.repoRoot
 * @param {(cmd:string, args:string[], opts?:object) => {status:number}} [deps.spawn]
 * @returns {{ok:boolean, status:number}}
 */
function runTestSuite(deps) {
  const repoRoot = deps.repoRoot;
  const spawn = deps.spawn || ((cmd, args, opts) => spawnSync(cmd, args, opts));
  const r = spawn(process.execPath, ['--test'], { stdio: 'inherit', cwd: repoRoot });
  return { ok: !!r && r.status === 0, status: r ? r.status : 1 };
}

/**
 * Compose all two checks. ok === (nodeCheckAll.ok && coveredTests.ok && testSuite.ok). All
 * impure deps are injectable for hermetic tests.
 *
 * @param {object} [deps]
 * @param {string} [deps.repoRoot]
 * @param {() => string[]} [deps.listFiles]
 * @param {(cmd:string, args:string[], opts?:object) => any} [deps.spawn]
 * @param {Array<{path:string, covers:string}>} [deps.covered]
 * @param {(p:string) => boolean} [deps.exists]
 * @returns {{ok:boolean, nodeCheck:object, coveredTests:object, testSuite:object}}
 */
function runSelfTest(deps = {}) {
  const repoRoot = deps.repoRoot || REPO_ROOT;
  const { listFiles, spawn, covered, exists } = deps;

  const nodeCheck = nodeCheckAll({ repoRoot, listFiles, spawn });
  const coveredTests = coveredTestsCheck({ repoRoot, covered, exists });
  const executedTests = executedTestsCheck({ repoRoot, covered, spawn, probeCwd: deps.probeCwd });
  const testSuite = runTestSuite({ repoRoot, spawn });

  const ok = nodeCheck.ok && coveredTests.ok && executedTests.ok && testSuite.ok;
  return { ok, nodeCheck, coveredTests, executedTests, testSuite };
}

/**
 * CLI: run the self-test against THIS repo, print human PASS/FAIL lines, exit 0 iff ok.
 *
 * @param {object} [deps] same seams as runSelfTest (for testing the CLI half if needed).
 * @returns {number} process exit code.
 */
function runCli(deps = {}) {
  const repoRoot = deps.repoRoot || REPO_ROOT;
  const result = runSelfTest(Object.assign({ repoRoot }, deps));

  process.stdout.write('gsd-contrib self-test — the toolkit eats its own dog food\n');
  process.stdout.write('  root: ' + repoRoot + '\n\n');

  // 1. node --check sweep.
  const nc = result.nodeCheck;
  if (nc.ok) {
    process.stdout.write('  [PASS] node --check — ' + nc.total + ' .cjs file(s) under hooks/ + bin/ parse clean\n');
  } else {
    process.stdout.write('  [FAIL] node --check — ' + nc.failures.length + ' of ' + nc.total + ' file(s) failed:\n');
    for (const f of nc.failures) {
      process.stdout.write('         ' + f.path + '\n');
      if (f.stderr) process.stdout.write('           ' + String(f.stderr).trim().split('\n')[0] + '\n');
    }
  }

  // 2. named load-bearing test coverage (the install/toggle lifecycle proof is surfaced by name).
  const ct = result.coveredTests;
  if (ct.ok) {
    process.stdout.write('  [PASS] covered tests — ' + ct.present.length + ' load-bearing test file(s) present:\n');
    for (const e of ct.present) {
      process.stdout.write('         ' + e.path + ' — ' + e.covers + '\n');
    }
  } else {
    process.stdout.write('  [FAIL] covered tests — ' + ct.missing.length + ' load-bearing test file(s) MISSING (silently un-run):\n');
    for (const e of ct.missing) {
      process.stdout.write('         ' + e.path + ' — ' + e.covers + '\n');
    }
  }

  // 2b. EXEC-01 — the named load-bearing proofs actually EXECUTED (not merely present on disk).
  const et = result.executedTests;
  if (et.ok) {
    process.stdout.write('  [PASS] executed proofs — ' + et.executed.length + ' load-bearing proof(s) actually ran:\n');
    for (const e of et.executed) {
      process.stdout.write('         ' + e.path + ' — ' + e.pass + ' case(s) executed, 0 skipped\n');
    }
  } else {
    process.stdout.write('  [FAIL] executed proofs — ' + et.unproven.length + ' load-bearing proof(s) did NOT run:\n');
    for (const e of et.unproven) {
      process.stdout.write('         ' + e.path + ' — ' + e.reason + '\n');
      process.stdout.write('           covers: ' + e.covers + '\n');
    }
    process.stdout.write(
      '         A skipped proof is not a passing proof. hooks/fault-injection.test.cjs needs a\n' +
      '         reachable gsd-core checkout — run the self-test with cwd inside one.\n'
    );
  }

  // 3. node:test harness verdict (the suite already streamed its own output via inherited stdio).
  const ts = result.testSuite;
  process.stdout.write('  [' + (ts.ok ? 'PASS' : 'FAIL') + '] node --test — hook test suite ' + (ts.ok ? 'green' : 'RED (exit ' + ts.status + ')') + '\n');

  process.stdout.write('\n');
  if (result.ok) {
    process.stdout.write('Self-test PASSED — node --check clean, covered tests present AND executed, suite green.\n');
  } else {
    process.stdout.write('Self-test FAILED — fix the toolkit before a broken hook can fail-closed-brick the workflow.\n');
  }
  return result.ok ? 0 : 1;
}

// `node --test` discovers files matching `*-test.cjs` — which MATCHES this file's own name. Without
// the NODE_TEST_CONTEXT guard the runner executes bin/self-test.cjs as if it were a test, so the
// self-test recursively runs a whole second self-test (including a nested full `node --test`) inside
// its own suite. That recursion was always wasteful — it roughly doubled suite runtime and nested
// the CLI's report inside its own output — and it became a hard failure once EXEC-01 made a
// non-executing proof fail: the nested run inherits the runner's cwd and so can never reach a
// gsd-core checkout, guaranteeing exit 1. Node sets NODE_TEST_CONTEXT only under the test runner,
// so this runs the CLI exactly when a human/CI invokes the file directly.
if (require.main === module && !process.env.NODE_TEST_CONTEXT) {
  process.exit(runCli());
}

module.exports = { runSelfTest, nodeCheckAll, coveredTestsCheck, executedTestsCheck, parseTapCounts, runTestSuite, runCli, listCjsFiles, COVERED_TESTS };
