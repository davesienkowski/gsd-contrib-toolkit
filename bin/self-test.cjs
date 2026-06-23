#!/usr/bin/env node
'use strict';

/**
 * bin/self-test.cjs — the toolkit's OWN dog-food self-test (TEST-04 / red-team H-G).
 *
 * One command (`node bin/self-test.cjs`) packages THREE checks so a syntax-broken or
 * behaviorally-broken hook is caught BEFORE it can fail-closed-brick the workflow:
 *
 *   1. node --check over EVERY hooks/**.cjs + bin/**.cjs — the honest JS analog of
 *      "shellcheck every hook". A syntax-broken .cjs (including a *.test.cjs — a broken
 *      test file is also a brick) flips ok:false (T-05-04-MISSFILE: the walk includes lib/
 *      and *.test.cjs so no brick-prone file is skipped).
 *   2. shellcheck install.sh GATED on shellcheck availability. PRESENT => run + gate;
 *      ABSENT (ENOENT) => SKIP with an EXPLICIT recorded note that is PRINTED to stdout —
 *      never a silent pass, never a hard failure (T-05-04-SILENTPASS / TEST-04 honesty).
 *      shellcheck is absent in THIS env, so this is the path that executes here.
 *   3. the existing node:test suite as the hook test harness — nonzero status => fail.
 *      The repo-wide `node --test` already DISCOVERS every *.test.cjs, so the install/toggle
 *      lifecycle proof (bin/contrib-capability.test.cjs, CAP-07) runs as part of this suite. To
 *      make that coverage EXPLICIT (so a missing/renamed test file is CAUGHT, not silently un-run),
 *      runSelfTest also enumerates the load-bearing test files (COVERED_TESTS) and flips ok:false
 *      if any is absent — and the CLI NAMES them, so the install/toggle surface is visible at runtime.
 *
 * Exit code is 0 ONLY when node --check is clean, shellcheck passed-or-skipped-with-note,
 * the enumerated load-bearing test files are present, AND the test suite is green. Every
 * subprocess verdict derives strictly from status===0 (T-05-04-SWALLOW: a non-zero status can
 * never be swallowed).
 *
 * Pure node builtins (node:fs, node:child_process) — installs NOTHING (T-05-04-SC).
 * Mirrors doctor.cjs's runCli/exit pattern and lint-ci-stamp.cjs's execFileSync discipline.
 * Modifies NO hook.
 *
 * @module bin/self-test
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const SCAN_DIRS = ['hooks', 'bin'];
const INSTALL_SH = 'install.sh';
const SHELLCHECK_SKIP_NOTE = 'shellcheck not installed — skipped (env limitation; runnable in CI)';

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
  { path: 'hooks/fault-injection.test.cjs', covers: 'HARD-01/HARD-02 fault injection (fail-closed deny + shape drift)' },
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
 * Run shellcheck against a script, GATED on shellcheck being installed. ENOENT => skip with
 * the explicit env-limitation note (ok:true, ran:false). A real (non-ENOENT) failure =>
 * ok:false. Mirrors lint-ci-stamp's infra-vs-failure discipline applied to shellcheck.
 *
 * @param {string} scriptPath absolute or repo-relative path to the shell script.
 * @param {object} [deps]
 * @param {(cmd:string, args:string[], opts?:object) => string} [deps.exec] injectable exec.
 * @returns {{ok:boolean, ran:boolean, note?:string, stderr?:string}}
 */
function tryShellcheck(scriptPath, deps = {}) {
  const exec = deps.exec || ((cmd, args, opts) => execFileSync(cmd, args, opts));
  try {
    exec('shellcheck', [scriptPath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, ran: true };
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { ok: true, ran: false, note: SHELLCHECK_SKIP_NOTE };
    }
    return { ok: false, ran: true, stderr: (err && (err.stderr || err.message)) || String(err) };
  }
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
 * Compose all three checks. ok === (nodeCheckAll.ok && shellcheck.ok && testSuite.ok). A
 * shellcheck ENOENT skip still counts ok:true but its note is carried in the result (and
 * printed by the CLI). All impure deps are injectable for hermetic tests.
 *
 * @param {object} [deps]
 * @param {string} [deps.repoRoot]
 * @param {() => string[]} [deps.listFiles]
 * @param {(cmd:string, args:string[], opts?:object) => any} [deps.spawn]
 * @param {(cmd:string, args:string[], opts?:object) => string} [deps.exec]
 * @param {Array<{path:string, covers:string}>} [deps.covered]
 * @param {(p:string) => boolean} [deps.exists]
 * @returns {{ok:boolean, nodeCheck:object, shellcheck:object, coveredTests:object, testSuite:object}}
 */
function runSelfTest(deps = {}) {
  const repoRoot = deps.repoRoot || REPO_ROOT;
  const { listFiles, spawn, exec, covered, exists } = deps;

  const nodeCheck = nodeCheckAll({ repoRoot, listFiles, spawn });
  const shellcheck = tryShellcheck(path.join(repoRoot, INSTALL_SH), { exec });
  const coveredTests = coveredTestsCheck({ repoRoot, covered, exists });
  const testSuite = runTestSuite({ repoRoot, spawn });

  const ok = nodeCheck.ok && shellcheck.ok && coveredTests.ok && testSuite.ok;
  return { ok, nodeCheck, shellcheck, coveredTests, testSuite };
}

/**
 * CLI: run the self-test against THIS repo, print human PASS/FAIL/SKIP lines (the shellcheck
 * SKIP note is surfaced so the env limitation is honest at runtime), exit 0 iff ok.
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

  // 2. shellcheck install.sh (gated — skip-with-note is honest, not a silent pass).
  const sc = result.shellcheck;
  if (sc.ran && sc.ok) {
    process.stdout.write('  [PASS] shellcheck ' + INSTALL_SH + ' — clean\n');
  } else if (!sc.ran) {
    process.stdout.write('  [SKIP] shellcheck ' + INSTALL_SH + ' — ' + sc.note + '\n');
    process.stdout.write('         (install.sh shellcheck is UNVERIFIED here; runnable in CI/dev — not reported green.)\n');
  } else {
    process.stdout.write('  [FAIL] shellcheck ' + INSTALL_SH + ' — found issues:\n');
    if (sc.stderr) process.stdout.write('         ' + String(sc.stderr).trim() + '\n');
  }

  // 3. named load-bearing test coverage (the install/toggle lifecycle proof is surfaced by name).
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

  // 4. node:test harness verdict (the suite already streamed its own output via inherited stdio).
  const ts = result.testSuite;
  process.stdout.write('  [' + (ts.ok ? 'PASS' : 'FAIL') + '] node --test — hook test suite ' + (ts.ok ? 'green' : 'RED (exit ' + ts.status + ')') + '\n');

  process.stdout.write('\n');
  if (result.ok) {
    process.stdout.write('Self-test PASSED — node --check clean, shellcheck passed-or-skipped-with-note, covered tests present, suite green.\n');
  } else {
    process.stdout.write('Self-test FAILED — fix the toolkit before a broken hook can fail-closed-brick the workflow.\n');
  }
  return result.ok ? 0 : 1;
}

if (require.main === module) {
  process.exit(runCli());
}

module.exports = { runSelfTest, nodeCheckAll, tryShellcheck, coveredTestsCheck, runTestSuite, runCli, listCjsFiles, SHELLCHECK_SKIP_NOTE, COVERED_TESTS };
