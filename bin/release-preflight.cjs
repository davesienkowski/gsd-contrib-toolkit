#!/usr/bin/env node
'use strict';

/**
 * bin/release-preflight.cjs — the OWN-02 release/publish pre-flight (advisory CLI).
 *
 * ADVISORY, MAINTAINER-INVOKED doer — NOT a PreToolUse deny gate. It returns NO
 * `permissionDecision` / allow / deny verdict and is NOT registered in
 * settings.snippet.json. It is the `bin/` doer the thin `/gsd-release-preflight`
 * command runs (D-01/D-02), modelled on bin/self-test.cjs + hooks/doctor.cjs's
 * run-all/aggregate/exit-nonzero shape.
 *
 * It runs the FOUR LIVE gsd-core release scripts in a NON-MUTATING check/dry-run
 * capacity, aggregates EVERY result (NO fail-fast — D-06), and exits nonzero if any
 * failed, so the maintainer sees the full blocker picture before a release is cut:
 *
 *   1. check-npm-integrity.cjs  — READ-ONLY lockfile integrity (exit 0=clean/1=drift/
 *      2=tool-error). Spawned via execFileSync('node', [scriptPath], {cwd:root}); ok
 *      iff exit 0.
 *   2. release-tarball-smoke.cjs — require()d via the LIVE resolver and called as
 *      runSmoke({ dryRun:true }) (validate input only — NEVER touches the working tree
 *      or installs anything); ok iff code === SMOKE.OK.
 *   3. sync-manifest-versions.cjs — native `--check` mode ONLY (report drift, exit 1, NO
 *      write). The `--check` flag is MANDATORY — the default mode WRITES manifests.
 *   4. sync-next-version.cjs — its PURE exported predicates ONLY:
 *      isReleaseVersion(versionFromPackageJson(pkgText)). NEVER its mutating
 *      main()/syncViaPr/applyVersion/--in-place (those open a PR / write the tree).
 *
 * HARD-02 LOUD-on-miss: every check is wrapped so a thrown ScriptResolveError (missing/
 * unloadable LIVE script) or a nonzero spawn becomes an explicit FAIL result with a
 * detail — NEVER an omitted/silent-skip result and NEVER a false green/all-passed.
 *
 * Pure node builtins (node:fs, node:path, node:child_process) + the LIVE resolver —
 * installs NOTHING. Modifies NO hook; touches settings.snippet.json NOT AT ALL.
 *
 * @module bin/release-preflight
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { resolveGsdCoreRoot, requireLiveScript } = require('../hooks/lib/resolve.cjs');

const SCRIPTS = Object.freeze({
  npmIntegrity: 'scripts/check-npm-integrity.cjs',
  tarballSmoke: 'scripts/release-tarball-smoke.cjs',
  manifestVersions: 'scripts/sync-manifest-versions.cjs',
  nextVersion: 'scripts/sync-next-version.cjs',
});

/**
 * Default no-shell spawn seam: run `node <scriptPath> [args...]` in the gsd-core root.
 * Returns { status, stdout, stderr } mirroring spawnSync's shape so a nonzero exit is a
 * verdict, never a throw. execFileSync throws on nonzero, so we normalize here.
 *
 * @param {string} scriptAbs absolute path to the LIVE .cjs script.
 * @param {string[]} args explicit argv array (NO shell, NO interpolation).
 * @param {string} root gsd-core root (cwd for the child).
 * @returns {{status:number, stdout:string, stderr:string}}
 */
function defaultSpawnNode(scriptAbs, args, root) {
  try {
    const stdout = execFileSync(process.execPath, [scriptAbs, ...args], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout: stdout || '', stderr: '' };
  } catch (err) {
    // execFileSync throws on nonzero exit OR on spawn failure (ENOENT etc.).
    // A numeric status is a real exit code (a verdict). No status => spawn failure.
    if (err && typeof err.status === 'number') {
      return { status: err.status, stdout: String(err.stdout || ''), stderr: String(err.stderr || '') };
    }
    throw err; // genuine spawn failure — caller's try/catch turns it into a LOUD FAIL.
  }
}

/**
 * CHECK 1 — check-npm-integrity.cjs (READ-ONLY). ok iff exit 0; exit 1=drift, 2=tool-error.
 *
 * @param {string} root gsd-core root.
 * @param {object} [deps]
 * @param {(scriptAbs:string,args:string[],root:string)=>{status:number,stdout:string,stderr:string}} [deps.spawnNode]
 * @returns {{script:string, ok:boolean, detail:string}}
 */
function checkNpmIntegrity(root, deps = {}) {
  const spawnNode = deps.spawnNode || defaultSpawnNode;
  const existsFile = deps.existsFile || ((p) => fs.existsSync(p));
  const scriptAbs = path.join(root, SCRIPTS.npmIntegrity);
  try {
    if (!existsFile(scriptAbs)) {
      throw new Error('LIVE script not found (no vendored fallback — fail closed): ' + scriptAbs);
    }
    const r = spawnNode(scriptAbs, [], root);
    if (r.status === 0) {
      return { script: SCRIPTS.npmIntegrity, ok: true, detail: 'lockfile integrity clean (exit 0)' };
    }
    const why = r.status === 1 ? 'integrity drift' : 'tool error';
    const tail = (r.stderr || r.stdout || '').trim().split('\n').slice(-1)[0] || '';
    return { script: SCRIPTS.npmIntegrity, ok: false, detail: why + ' (exit ' + r.status + ')' + (tail ? ' :: ' + tail : '') };
  } catch (err) {
    return { script: SCRIPTS.npmIntegrity, ok: false, detail: 'LOUD failure: ' + ((err && err.message) || String(err)) };
  }
}

/**
 * CHECK 2 — release-tarball-smoke.cjs runSmoke({ dryRun:true }) (validate input only,
 * NEVER installs / never touches the tree). ok iff code === SMOKE.OK.
 *
 * @param {string} root gsd-core root.
 * @param {object} [deps]
 * @param {(root:string,rel:string)=>object} [deps.loadLiveScript] injectable LIVE loader.
 * @returns {{script:string, ok:boolean, detail:string}}
 */
function checkTarballSmoke(root, deps = {}) {
  const loadLiveScript = deps.loadLiveScript || ((r, rel) => requireLiveScript(r, rel));
  const readFile = deps.readFile || ((p) => fs.readFileSync(p, 'utf8'));
  try {
    const mod = loadLiveScript(root, SCRIPTS.tarballSmoke);
    if (!mod || typeof mod.runSmoke !== 'function') {
      throw new Error('LIVE release-tarball-smoke.cjs has no runSmoke export (shape drift)');
    }
    const okCode = (mod.SMOKE && mod.SMOKE.OK) || 'ok';
    // dryRun:true → validate input only; returns { code, details }. expectedVersion is
    // read from the LIVE package.json so the dry-run validates the real release version.
    const pkgText = readFile(path.join(root, 'package.json'));
    const expectedVersion = JSON.parse(pkgText).version;
    const res = mod.runSmoke({ dryRun: true, expectedVersion, tarballPath: '', installPrefix: '' });
    if (res && res.code === okCode) {
      return { script: SCRIPTS.tarballSmoke, ok: true, detail: 'dry-run smoke ok (code=' + okCode + ', non-mutating)' };
    }
    return { script: SCRIPTS.tarballSmoke, ok: false, detail: 'dry-run smoke failed (code=' + (res && res.code) + ')' };
  } catch (err) {
    return { script: SCRIPTS.tarballSmoke, ok: false, detail: 'LOUD failure: ' + ((err && err.message) || String(err)) };
  }
}

/**
 * CHECK 3 — sync-manifest-versions.cjs --check (drift report, NO write). The `--check`
 * flag is MANDATORY — without it the script WRITES manifests (mutation). ok iff exit 0.
 *
 * @param {string} root gsd-core root.
 * @param {object} [deps]
 * @param {(scriptAbs:string,args:string[],root:string)=>{status:number,stdout:string,stderr:string}} [deps.spawnNode]
 * @returns {{script:string, ok:boolean, detail:string}}
 */
function checkManifestVersions(root, deps = {}) {
  const spawnNode = deps.spawnNode || defaultSpawnNode;
  const existsFile = deps.existsFile || ((p) => fs.existsSync(p));
  const scriptAbs = path.join(root, SCRIPTS.manifestVersions);
  try {
    if (!existsFile(scriptAbs)) {
      throw new Error('LIVE script not found (no vendored fallback — fail closed): ' + scriptAbs);
    }
    // '--check' is non-negotiable: the default mode mutates manifests (T-08-02-MUT).
    const r = spawnNode(scriptAbs, ['--check'], root);
    if (r.status === 0) {
      return { script: SCRIPTS.manifestVersions, ok: true, detail: 'manifests in sync (--check, exit 0)' };
    }
    const tail = (r.stderr || r.stdout || '').trim().split('\n').slice(-1)[0] || '';
    return { script: SCRIPTS.manifestVersions, ok: false, detail: 'manifest version drift (--check, exit ' + r.status + ')' + (tail ? ' :: ' + tail : '') };
  } catch (err) {
    return { script: SCRIPTS.manifestVersions, ok: false, detail: 'LOUD failure: ' + ((err && err.message) || String(err)) };
  }
}

/**
 * CHECK 4 — sync-next-version.cjs PURE predicates ONLY: assert the current package.json
 * version is a valid release version via isReleaseVersion(versionFromPackageJson(text)).
 * NEVER calls the mutating main()/syncViaPr/applyVersion/--in-place (T-08-02-MUT).
 *
 * @param {string} root gsd-core root.
 * @param {object} [deps]
 * @param {(root:string,rel:string)=>object} [deps.loadLiveScript] injectable LIVE loader.
 * @param {(p:string)=>string} [deps.readFile] injectable package.json reader.
 * @returns {{script:string, ok:boolean, detail:string}}
 */
function checkNextVersion(root, deps = {}) {
  const loadLiveScript = deps.loadLiveScript || ((r, rel) => requireLiveScript(r, rel));
  const readFile = deps.readFile || ((p) => fs.readFileSync(p, 'utf8'));
  try {
    const mod = loadLiveScript(root, SCRIPTS.nextVersion);
    if (!mod || typeof mod.versionFromPackageJson !== 'function' || typeof mod.isReleaseVersion !== 'function') {
      throw new Error('LIVE sync-next-version.cjs missing pure predicate exports (shape drift)');
    }
    const pkgText = readFile(path.join(root, 'package.json'));
    const version = mod.versionFromPackageJson(pkgText);
    if (mod.isReleaseVersion(version)) {
      return { script: SCRIPTS.nextVersion, ok: true, detail: 'package.json version ' + version + ' is a valid release version (pure predicate)' };
    }
    return { script: SCRIPTS.nextVersion, ok: false, detail: 'package.json version ' + version + ' is NOT a release version (pure predicate)' };
  } catch (err) {
    return { script: SCRIPTS.nextVersion, ok: false, detail: 'LOUD failure: ' + ((err && err.message) || String(err)) };
  }
}

/**
 * Run ALL FOUR checks unconditionally (NO fail-fast — D-06), aggregate every result, and
 * set ok = results.every(r => r.ok). A resolve miss on the gsd-core root surfaces LOUD as
 * a single aggregate failure (never a false all-passed).
 *
 * @param {object} [deps]
 * @param {string} [deps.gsdCoreRoot] pre-resolved root (skip the cwd walk; for tests).
 * @param {(startDir:string)=>string} [deps.resolveRoot] injectable resolver.
 * @param {(scriptAbs:string,args:string[],root:string)=>object} [deps.spawnNode]
 * @param {(root:string,rel:string)=>object} [deps.loadLiveScript]
 * @param {(p:string)=>string} [deps.readFile]
 * @returns {{ok:boolean, results:{script:string, ok:boolean, detail:string}[], error?:string}}
 */
function runReleasePreflight(deps = {}) {
  let root = deps.gsdCoreRoot;
  if (!root) {
    const resolveRoot = deps.resolveRoot || ((d) => resolveGsdCoreRoot(d));
    try {
      root = resolveRoot(process.cwd());
    } catch (err) {
      // A root miss is a LOUD aggregate failure — never a false green.
      return {
        ok: false,
        results: [],
        error: 'could not resolve gsd-core root (run from inside a gsd-core checkout): ' + ((err && err.message) || String(err)),
      };
    }
  }

  // Run all four UNCONDITIONALLY — no early return on a failing earlier check (D-06).
  const results = [
    checkNpmIntegrity(root, deps),
    checkTarballSmoke(root, deps),
    checkManifestVersions(root, deps),
    checkNextVersion(root, deps),
  ];

  const ok = results.every((r) => r.ok);
  return { ok, results };
}

/**
 * CLI: run the pre-flight, print a header + one [PASS]/[FAIL] line per script with detail
 * (mirroring hooks/doctor.cjs's print loop) + a final summary. Returns 0 iff every check
 * passed, 1 otherwise. A root-resolve miss prints LOUD to stderr and returns 1.
 *
 * @param {object} [deps] same seams as runReleasePreflight.
 * @returns {number} process exit code.
 */
function runCli(deps = {}) {
  const report = runReleasePreflight(deps);

  process.stdout.write('gsd-contrib release pre-flight — LIVE gsd-core release-script check (advisory, non-mutating)\n');

  if (report.error) {
    process.stderr.write('  [FAIL] release pre-flight could NOT run (advisory fails LOUD, not green): ' + report.error + '\n');
    return 1;
  }

  for (const r of report.results) {
    const mark = r.ok ? 'PASS' : 'FAIL';
    process.stdout.write('  [' + mark + '] ' + r.script + '\n');
    process.stdout.write('         ' + r.detail + '\n');
  }
  process.stdout.write('\n');

  if (report.ok) {
    process.stdout.write('All ' + report.results.length + ' LIVE release checks passed — clear to cut a release.\n');
  } else {
    const failed = report.results.filter((r) => !r.ok).length;
    process.stdout.write(
      failed + ' of ' + report.results.length + ' release check(s) FAILED — resolve every blocker before cutting a release.\n'
    );
  }
  return report.ok ? 0 : 1;
}

if (require.main === module) {
  process.exit(runCli());
}

module.exports = {
  runReleasePreflight,
  runCli,
  checkNpmIntegrity,
  checkTarballSmoke,
  checkManifestVersions,
  checkNextVersion,
  defaultSpawnNode,
  SCRIPTS,
};
