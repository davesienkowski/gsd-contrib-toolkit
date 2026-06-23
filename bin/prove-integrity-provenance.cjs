#!/usr/bin/env node
'use strict';

/**
 * bin/prove-integrity-provenance.cjs — re-runnable, SANDBOXED proof of the
 * ADR-1244 capability-trust INTEGRITY guarantee for our contribution-toolkit bundle.
 *
 * WHAT THIS PROVES (the previously-UNTESTED `--integrity`-gated install path):
 *   POSITIVE   — a `gsd-tools capability install npm:<dir> --integrity sha512-<base64>`
 *                with the engine-derived digest SUCCEEDS (status: installed).
 *   NEGATIVE   — the same install with a WRONG --integrity is REFUSED: non-zero exit +
 *                an "Integrity mismatch" error, verified over the .tgz bytes BEFORE staging.
 *   FAIL-CLOSED — after the refusal the sandbox holds NO contribution-toolkit install
 *                (no promoted dir, no ledger entry): the mismatch throws inside the
 *                resolver try/finally that rmSync's the extract dir, before promote.
 *
 * SOURCE KIND: the `npm:` route over a LOCAL directory (`npm:<abs-dir>`). A bare local
 * path routes to kind `local`, and resolveLocal THROWS "integrity pinning is not supported
 * for local sources" — so a local .tgz/path CANNOT carry --integrity. `npm pack
 * --ignore-scripts <dir>` produces a .tgz whose BYTES are what verifyIntegrity checks; no
 * network server is needed and the route is fully sandbox-safe.
 *
 * DIGEST DERIVATION: the engine's recorded integrity is read back from a FIRST
 * no-`--integrity` install's ledger (same sha512-over-.tgz-bytes domain). We never
 * blind-`sha512sum` the .tgz (npm pack output is not byte-reproducible by hand), so the
 * positive test passes for the RIGHT reason.
 *
 * SANDBOX SAFETY (HARD GATE): every install runs with GSD_HOME set to a scratch dir under
 * os.tmpdir(), asserted (under tmpdir, not under homedir, not ~/.gsd|~/.claude) BEFORE any
 * install. The real ~/.gsd and ~/.claude are never written. Each install uses a FRESH
 * GSD_HOME sub-dir to avoid duplicate-install interference. Exit 0 only if POSITIVE
 * succeeded AND NEGATIVE was refused AND fail-closed held; else exit 1 (or 2 for setup).
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const GSD_TOOLS = '/home/dave/repos/gsd-core/gsd-core/bin/gsd-tools.cjs';
const ENGINE_LIB = '/home/dave/repos/gsd-core/gsd-core/bin/lib/capability-source.cjs';
const CAP_ID = 'contribution-toolkit';
// Resolve the capabilities source dir relative to THIS script (repo root = bin/..) so the
// recipe works in the worktree now and in main after merge.
const REPO_ROOT = path.resolve(__dirname, '..');
const CAP_SRC_DIR = path.join(REPO_ROOT, 'capabilities', CAP_ID);

function log(msg) { process.stdout.write(msg + '\n'); }

// ---------------------------------------------------------------------------
// Setup gates: engine binary + compiled lib must exist (rebuild if stale).
// ---------------------------------------------------------------------------
function assertEngineReady() {
  if (!fs.existsSync(GSD_TOOLS)) {
    log(`SETUP-FAIL: gsd-tools binary not found at ${GSD_TOOLS}`);
    log('  Rebuild: cd /home/dave/repos/gsd-core && npm run build:lib');
    process.exit(2);
  }
  if (!fs.existsSync(ENGINE_LIB)) {
    log(`SETUP-FAIL: compiled engine lib not found at ${ENGINE_LIB}`);
    log('  Rebuild: cd /home/dave/repos/gsd-core && npm run build:lib');
    process.exit(2);
  }
  if (!fs.existsSync(path.join(CAP_SRC_DIR, 'capability.json'))) {
    log(`SETUP-FAIL: capability source not found at ${CAP_SRC_DIR}`);
    process.exit(2);
  }
}

// ---------------------------------------------------------------------------
// Sandbox: scratch root under os.tmpdir(); per-install fresh GSD_HOME sub-dir.
// ---------------------------------------------------------------------------
function assertSandboxSafe(gsdHome) {
  const tmp = fs.realpathSync(os.tmpdir());
  const home = fs.realpathSync(os.homedir());
  const real = fs.realpathSync(gsdHome);
  if (!gsdHome) throw new Error('SANDBOX VIOLATION: GSD_HOME is empty');
  if (!(real === tmp || real.startsWith(tmp + path.sep))) {
    throw new Error(`SANDBOX VIOLATION: GSD_HOME (${real}) is not under os.tmpdir() (${tmp})`);
  }
  if (real === home || real.startsWith(home + path.sep)) {
    throw new Error(`SANDBOX VIOLATION: GSD_HOME (${real}) is under os.homedir() (${home})`);
  }
  if (real.endsWith(`${path.sep}.gsd`) || real.endsWith(`${path.sep}.claude`)) {
    throw new Error(`SANDBOX VIOLATION: GSD_HOME (${real}) resolves to a ~/.gsd or ~/.claude path`);
  }
}

function runInstall(gsdHome, projectCwd, spec, extraArgs) {
  assertSandboxSafe(gsdHome); // belt-and-braces: re-assert before EVERY spawn
  const env = { ...process.env, GSD_HOME: gsdHome };
  const args = [GSD_TOOLS, 'capability', 'install', spec, '--scope', 'global', '--yes', '--raw', ...extraArgs];
  const r = spawnSync('node', args, { env, cwd: projectCwd, encoding: 'utf8', timeout: 180000 });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function ledgerPath(gsdHome) {
  // global scope: runtimeDir = GSD_HOME; ledger = <runtimeDir>/.gsd-capabilities.json
  return path.join(gsdHome, '.gsd-capabilities.json');
}
function installRoot(gsdHome) {
  // global install root = <runtimeDir>/.gsd/capabilities/<id>/
  return path.join(gsdHome, '.gsd', 'capabilities', CAP_ID);
}

function readLedgerIntegrity(gsdHome) {
  const lp = ledgerPath(gsdHome);
  if (!fs.existsSync(lp)) return null;
  const led = JSON.parse(fs.readFileSync(lp, 'utf8'));
  const entry = led && led.entries && led.entries[CAP_ID];
  return entry ? entry.integrity : null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  assertEngineReady();

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nv5-integrity-'));
  let positiveOK = false, negativeRefused = false, failClosedHeld = false;
  const report = {};

  const cleanup = () => { try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* best-effort */ } };

  try {
    // --- Stage a temp copy of the capability so the real working copy is untouched, and
    //     ensure it has a minimal package.json for `npm pack` (name from id, version from manifest).
    const stagedDir = path.join(scratch, 'staged-cap');
    fs.cpSync(CAP_SRC_DIR, stagedDir, { recursive: true });
    const manifest = JSON.parse(fs.readFileSync(path.join(stagedDir, 'capability.json'), 'utf8'));
    const pkgJsonPath = path.join(stagedDir, 'package.json');
    if (!fs.existsSync(pkgJsonPath)) {
      fs.writeFileSync(pkgJsonPath, JSON.stringify({
        name: manifest.id || CAP_ID,
        version: manifest.version || '0.0.0',
        private: true,
      }, null, 2) + '\n');
    }
    const spec = `npm:${stagedDir}`;
    const projectCwd = path.join(scratch, 'project');
    fs.mkdirSync(projectCwd, { recursive: true });

    // --- DERIVE the engine digest: install #1 WITHOUT --integrity in a fresh GSD_HOME, read
    //     the recorded sha512 back from the ledger. Same byte domain => positive test is honest.
    const homeDerive = path.join(scratch, 'gsdhome-derive');
    fs.mkdirSync(homeDerive, { recursive: true });
    const rDerive = runInstall(homeDerive, projectCwd, spec, []);
    if (rDerive.status !== 0) {
      throw new Error(`derive install failed (exit ${rDerive.status}): ${rDerive.stderr || rDerive.stdout}`);
    }
    const deriveJson = JSON.parse(rDerive.stdout);
    if (deriveJson.status !== 'installed') {
      throw new Error(`derive install did not report installed: ${rDerive.stdout}`);
    }
    const digest = readLedgerIntegrity(homeDerive);
    if (!digest || !/^sha512-.+/.test(digest)) {
      throw new Error(`could not read engine-recorded sha512 integrity from ledger; got: ${digest}`);
    }
    report.digest = digest;
    log(`DIGEST: engine-derived ${digest.slice(0, 24)}… (read back from ledger, not blind sha512sum)`);

    // --- POSITIVE: install #2 in a FRESH GSD_HOME WITH the matching --integrity.
    const homePos = path.join(scratch, 'gsdhome-positive');
    fs.mkdirSync(homePos, { recursive: true });
    const rPos = runInstall(homePos, projectCwd, spec, ['--integrity', digest]);
    const posJson = (() => { try { return JSON.parse(rPos.stdout); } catch { return null; } })();
    if (rPos.status === 0 && posJson && posJson.status === 'installed') {
      positiveOK = true;
      report.positive = { exit: rPos.status, json: posJson };
      log(`POSITIVE: installed (exit 0) id=${posJson.id} version=${posJson.version} scope=${posJson.scope}`);
    } else {
      report.positive = { exit: rPos.status, stdout: rPos.stdout, stderr: rPos.stderr };
      log(`POSITIVE: FAILED (exit ${rPos.status}) — ${rPos.stderr || rPos.stdout}`);
    }

    // --- NEGATIVE: install #3 in a FRESH GSD_HOME with a DELIBERATELY WRONG --integrity
    //     (mutate one base64 char of the derived digest). Same verifyIntegrity throw path.
    const homeNeg = path.join(scratch, 'gsdhome-negative');
    fs.mkdirSync(homeNeg, { recursive: true });
    const body = digest.slice('sha512-'.length);
    const firstChar = body[0];
    const swapped = firstChar === 'A' ? 'B' : 'A'; // deterministic single-char mutation
    const wrongDigest = `sha512-${swapped}${body.slice(1)}`;
    const rNeg = runInstall(homeNeg, projectCwd, spec, ['--integrity', wrongDigest]);
    const negOut = `${rNeg.stdout}\n${rNeg.stderr}`;
    const sawMismatch = /Integrity mismatch|Unsupported integrity algorithm/i.test(negOut);
    if (rNeg.status !== 0 && sawMismatch) {
      negativeRefused = true;
      const m = negOut.match(/Integrity mismatch:[^\n]*/i) || negOut.match(/Unsupported integrity algorithm[^\n]*/i);
      report.negative = { exit: rNeg.status, error: m ? m[0] : negOut.trim().slice(0, 300) };
      log(`NEGATIVE: refused (exit ${rNeg.status}) — ${report.negative.error}`);
    } else {
      report.negative = { exit: rNeg.status, stdout: rNeg.stdout, stderr: rNeg.stderr };
      log(`NEGATIVE: NOT REFUSED as expected (exit ${rNeg.status}) — ${negOut.trim().slice(0, 300)}`);
    }

    // --- FAIL-CLOSED: after the refusal, the negative sandbox must hold NO promoted install
    //     and NO ledger entry for our id.
    const negRootExists = fs.existsSync(installRoot(homeNeg));
    const negLedgerIntegrity = readLedgerIntegrity(homeNeg);
    if (!negRootExists && !negLedgerIntegrity) {
      failClosedHeld = true;
      report.failClosed = { installRootExists: false, ledgerEntry: null };
      log('FAIL-CLOSED: clean (no promoted contribution-toolkit dir, no ledger entry in the negative sandbox)');
    } else {
      report.failClosed = { installRootExists: negRootExists, ledgerEntry: negLedgerIntegrity };
      log(`FAIL-CLOSED: VIOLATED — installRootExists=${negRootExists} ledgerEntry=${negLedgerIntegrity}`);
    }

    // --- Confirm the real homes were never the GSD_HOME we used.
    log(`SANDBOX: all installs ran with GSD_HOME under ${os.tmpdir()} (real ~/.gsd & ~/.claude untouched)`);
  } finally {
    cleanup();
  }

  const allGreen = positiveOK && negativeRefused && failClosedHeld;
  log('');
  log(`SUMMARY: POSITIVE=${positiveOK ? 'pass' : 'FAIL'} NEGATIVE=${negativeRefused ? 'refused' : 'FAIL'} FAIL-CLOSED=${failClosedHeld ? 'clean' : 'FAIL'} => ${allGreen ? 'ALL GREEN' : 'RED'}`);
  process.exit(allGreen ? 0 : 1);
}

main();
