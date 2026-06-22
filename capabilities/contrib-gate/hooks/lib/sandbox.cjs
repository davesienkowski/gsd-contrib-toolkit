'use strict';

/**
 * hooks/lib/sandbox.cjs — the DISPOSABLE fault-injection sandbox (TEST-01 / TEST-02).
 *
 * The HARD-01/HARD-02 properties are proven on INJECTED faults: a referenced LIVE gsd-core
 * script is renamed/removed (→ the gate must fail closed), or a script's return shape is
 * drifted (→ the doctor must report ok:false by SHAPE). Doing that on the real ~/repos/gsd-core
 * checkout would corrupt the user's working copy — so every mutation happens on a TEMP copy of
 * the sentinel layout built by `makeSandbox`, torn down in the test's finally.
 *
 * THE LOAD-BEARING SECURITY INVARIANT:
 *   makeSandbox writes ONLY under fs.mkdtempSync(os.tmpdir()+'/gsd-fault-'). Every mutator
 *   (removeScript / driftScriptShape) path-resolve-guards its `rel` argument: a `../` escape or
 *   an absolute path that resolves outside the sandbox root is REJECTED (throws), so a mutator
 *   can never touch the real checkout or anything else on disk. The fault-injection test
 *   additionally snapshots the real source bytes before/after to PROVE the real checkout is
 *   never written.
 *
 * The sandbox reproduces the EXACT sentinel layout that hooks/lib/resolve.cjs hasSentinel()
 * requires — `<root>/scripts/` and `<root>/gsd-core/bin/lib/` — so resolveGsdCoreRoot(<root>)
 * returns the sandbox itself and the spawned gate / runDoctor resolve the SANDBOX scripts, not
 * the real checkout (the TOCTOU mitigation: the sandbox out-resolves the real tree).
 *
 * @module hooks/lib/sandbox
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resolveGsdCoreRoot } = require('./resolve.cjs');

/**
 * The LIVE scripts the toolkit gates + doctor call (the four SHAPE_CHECKS scripts), each path
 * relative to the gsd-core root. The sandbox copies exactly these from the real checkout.
 * (issue-version-gate additionally requires gsd-core/bin/lib/package-identity.cjs, copied as a
 * transitive dependency below.)
 */
const SANDBOX_SCRIPTS = Object.freeze([
  'scripts/issue-version-gate.cjs',
  'scripts/pr-target-policy.cjs',
  'scripts/pr-template-policy.cjs',
  'scripts/issue-dedupe.cjs',
]);

/**
 * Transitive requires (outside scripts/) that a copied script needs to load. issue-version-gate
 * requires `../gsd-core/bin/lib/package-identity.cjs`; without it requireLiveScript would throw
 * for a DEPENDENCY miss, muddying a clean-sandbox proof.
 */
const SANDBOX_TRANSITIVE = Object.freeze(['gsd-core/bin/lib/package-identity.cjs']);

/**
 * Resolve `rel` against `root` and assert it stays strictly inside the sandbox. Rejects `../`
 * escapes and absolute paths that resolve elsewhere (the path-escape / elevation mitigation).
 *
 * @param {string} root absolute sandbox root.
 * @param {string} rel a path relative to the sandbox root.
 * @returns {string} the safe absolute path under root.
 * @throws {Error} when rel escapes the sandbox root.
 */
function safeJoin(root, rel) {
  if (typeof root !== 'string' || root.length === 0) {
    throw new Error('sandbox: root is required');
  }
  if (typeof rel !== 'string' || rel.length === 0) {
    throw new Error('sandbox: rel is required');
  }
  const base = path.resolve(root);
  const abs = path.resolve(base, rel);
  // Containment with a boundary (base + sep), not a bare prefix (which would allow a sibling
  // dir sharing the prefix). The root itself is not a valid script target.
  if (abs !== base && !abs.startsWith(base + path.sep)) {
    throw new Error('sandbox: path escapes the sandbox root (rejected): ' + rel + ' -> ' + abs);
  }
  if (abs === base) {
    throw new Error('sandbox: rel must name a file inside the sandbox, not the root itself: ' + rel);
  }
  return abs;
}

/**
 * Copy a single file, creating its parent dir. Source-read only; the destination is always
 * inside the sandbox (callers pass an already-safeJoin'd dest).
 */
function copyInto(srcAbs, destAbs) {
  fs.mkdirSync(path.dirname(destAbs), { recursive: true });
  fs.copyFileSync(srcAbs, destAbs);
}

/**
 * Build a disposable sandbox: a temp dir with the gsd-core sentinel layout, the four SHAPE
 * scripts (+ their transitive lib dep) copied from the real checkout.
 *
 * @param {Object} [opts]
 * @param {string} [opts.sourceRoot] the real gsd-core root to copy from (default:
 *   resolveGsdCoreRoot(process.cwd())).
 * @returns {{root:string, sourceRoot:string, dispose:Function}}
 */
function makeSandbox(opts = {}) {
  const sourceRoot = opts.sourceRoot || resolveGsdCoreRoot(process.cwd());

  // Every write lands under this temp root — the security boundary.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-fault-'));

  // Reproduce the sentinel layout (scripts/ + gsd-core/bin/lib/) so resolveGsdCoreRoot(root)
  // === root and the real checkout is never reached.
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'gsd-core', 'bin', 'lib'), { recursive: true });

  // Copy the LIVE shape-checked scripts + their transitive lib dep from the real checkout.
  for (const rel of [...SANDBOX_SCRIPTS, ...SANDBOX_TRANSITIVE]) {
    const srcAbs = path.join(sourceRoot, rel);
    const destAbs = safeJoin(root, rel);
    copyInto(srcAbs, destAbs);
  }

  let disposed = false;
  function dispose() {
    if (disposed) return;
    disposed = true;
    fs.rmSync(root, { recursive: true, force: true });
  }

  return { root, sourceRoot, dispose };
}

/**
 * Remove (delete) a referenced LIVE script in the sandbox so requireLiveScript throws a
 * ScriptResolveError there → the affected gate fails closed (HARD-01).
 *
 * @param {string} root sandbox root.
 * @param {string} relScript e.g. 'scripts/pr-target-policy.cjs'.
 */
function removeScript(root, relScript) {
  const abs = safeJoin(root, relScript);
  fs.rmSync(abs, { force: true });
}

/**
 * Overwrite a sandbox script with a stub whose named export returns a deliberately WRONG shape
 * (a value the doctor's assertShape rejects) — the file STILL EXISTS, so a green existence
 * check would pass while the doctor must catch the SHAPE drift (HARD-02).
 *
 * @param {string} root sandbox root.
 * @param {string} relScript e.g. 'scripts/pr-target-policy.cjs'.
 * @param {string} exportName the export to drift, e.g. 'classifyPrTarget'.
 */
function driftScriptShape(root, relScript, exportName) {
  const abs = safeJoin(root, relScript);
  if (typeof exportName !== 'string' || exportName.length === 0) {
    throw new Error('sandbox: exportName is required to drift a shape');
  }
  // The stub keeps the export NAME and TYPE (a function) but returns a shape the doctor's
  // assertShape rejects — proving the doctor checks the RETURN SHAPE, not mere presence.
  const stub =
    "'use strict';\n" +
    '// DRIFTED stub written by the fault-injection sandbox — returns a deliberately wrong shape.\n' +
    'module.exports = { ' +
    JSON.stringify(exportName) +
    ': function () { return { __drifted__: true }; } };\n';
  fs.writeFileSync(abs, stub, 'utf8');
}

module.exports = {
  makeSandbox,
  removeScript,
  driftScriptShape,
  SANDBOX_SCRIPTS,
  safeJoin,
};
