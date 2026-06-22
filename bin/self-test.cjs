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
 *
 * Exit code is 0 ONLY when node --check is clean, shellcheck passed-or-skipped-with-note,
 * AND the test suite is green. Every subprocess verdict derives strictly from status===0
 * (T-05-04-SWALLOW: a non-zero status can never be swallowed).
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
 * @returns {{ok:boolean, nodeCheck:object, shellcheck:object, testSuite:object}}
 */
function runSelfTest(deps = {}) {
  const repoRoot = deps.repoRoot || REPO_ROOT;
  const { listFiles, spawn, exec } = deps;

  const nodeCheck = nodeCheckAll({ repoRoot, listFiles, spawn });
  const shellcheck = tryShellcheck(path.join(repoRoot, INSTALL_SH), { exec });
  const testSuite = runTestSuite({ repoRoot, spawn });

  const ok = nodeCheck.ok && shellcheck.ok && testSuite.ok;
  return { ok, nodeCheck, shellcheck, testSuite };
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

  // 3. node:test harness verdict (the suite already streamed its own output via inherited stdio).
  const ts = result.testSuite;
  process.stdout.write('  [' + (ts.ok ? 'PASS' : 'FAIL') + '] node --test — hook test suite ' + (ts.ok ? 'green' : 'RED (exit ' + ts.status + ')') + '\n');

  process.stdout.write('\n');
  if (result.ok) {
    process.stdout.write('Self-test PASSED — node --check clean, shellcheck passed-or-skipped-with-note, suite green.\n');
  } else {
    process.stdout.write('Self-test FAILED — fix the toolkit before a broken hook can fail-closed-brick the workflow.\n');
  }
  return result.ok ? 0 : 1;
}

if (require.main === module) {
  process.exit(runCli());
}

module.exports = { runSelfTest, nodeCheckAll, tryShellcheck, runTestSuite, runCli, listCjsFiles, SHELLCHECK_SKIP_NOTE };
