'use strict';

/**
 * node:test for hooks/lib/resolve.cjs (HARD-02 resolver half).
 *
 * Proven here:
 *   - resolveGsdCoreRoot walks up from a nested cwd to the ancestor with the gsd-core
 *     sentinel layout (scripts/ + gsd-core/bin/lib/) and returns it
 *   - a startDir with no sentinel ancestor → throws ScriptResolveError
 *   - requireLiveScript loads a present module's exports
 *   - a missing script → ScriptResolveError carrying the attempted path + root (NO
 *     vendored fallback — a missing live script must fail closed, never reimplement)
 *   - it loads the REAL live gsd-core scripts when present (issue-version-gate / pr-target-policy)
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const res = require('./resolve.cjs');

/**
 * Build a fixture tree shaped like a gsd-core checkout:
 *   <root>/scripts/probe.cjs
 *   <root>/gsd-core/bin/lib/.keep
 *   <root>/a/b/c/   (a nested cwd to resolve up from)
 */
function makeFixtureRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-core-fixture-'));
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'gsd-core', 'bin', 'lib'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'scripts', 'probe.cjs'),
    "module.exports = { ping: () => 'pong', VALUE: 42 };\n"
  );
  fs.mkdirSync(path.join(root, 'a', 'b', 'c'), { recursive: true });
  return root;
}

test('resolveGsdCoreRoot: finds the root from a nested cwd via the sentinel layout', () => {
  const root = makeFixtureRoot();
  const nested = path.join(root, 'a', 'b', 'c');
  const resolved = res.resolveGsdCoreRoot(nested);
  assert.strictEqual(fs.realpathSync(resolved), fs.realpathSync(root));
});

test('resolveGsdCoreRoot: returns the root itself when startDir IS the root', () => {
  const root = makeFixtureRoot();
  assert.strictEqual(fs.realpathSync(res.resolveGsdCoreRoot(root)), fs.realpathSync(root));
});

test('resolveGsdCoreRoot: a dir with only scripts/ (no gsd-core/bin/lib) does NOT match', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'half-'));
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  assert.throws(() => res.resolveGsdCoreRoot(root), res.ScriptResolveError);
});

test('resolveGsdCoreRoot: no sentinel ancestor → throws ScriptResolveError', () => {
  const lonely = fs.mkdtempSync(path.join(os.tmpdir(), 'no-sentinel-'));
  assert.throws(() => res.resolveGsdCoreRoot(lonely), res.ScriptResolveError);
});

test('requireLiveScript: loads a present module exports', () => {
  const root = makeFixtureRoot();
  const mod = res.requireLiveScript(root, 'scripts/probe.cjs');
  assert.strictEqual(typeof mod.ping, 'function');
  assert.strictEqual(mod.ping(), 'pong');
  assert.strictEqual(mod.VALUE, 42);
});

test('requireLiveScript: a missing script throws a typed ScriptResolveError with path+root', () => {
  const root = makeFixtureRoot();
  let thrown;
  try {
    res.requireLiveScript(root, 'scripts/does-not-exist.cjs');
  } catch (e) {
    thrown = e;
  }
  assert.ok(thrown instanceof res.ScriptResolveError, 'must be a typed ScriptResolveError');
  assert.strictEqual(thrown.root, root);
  assert.match(thrown.attemptedPath, /does-not-exist\.cjs$/);
});

test('requireLiveScript: NEVER falls back to a vendored copy — a missing live script is an error', () => {
  const root = makeFixtureRoot();
  // There is no local reimplementation to silently return; it must throw.
  assert.throws(
    () => res.requireLiveScript(root, 'scripts/issue-version-gate.cjs'),
    res.ScriptResolveError
  );
});

test('requireLiveScript: a module that throws at require-time → ScriptResolveError (→ fail closed)', () => {
  const root = makeFixtureRoot();
  fs.writeFileSync(
    path.join(root, 'scripts', 'boom.cjs'),
    "throw new Error('module init failed');\n"
  );
  assert.throws(() => res.requireLiveScript(root, 'scripts/boom.cjs'), res.ScriptResolveError);
});

// --- Integration against the REAL gsd-core checkout when present ---
const REAL_GSD_CORE = '/home/dave/repos/gsd-core';
const hasRealCore =
  fs.existsSync(path.join(REAL_GSD_CORE, 'scripts')) &&
  fs.existsSync(path.join(REAL_GSD_CORE, 'gsd-core', 'bin', 'lib'));

test('real gsd-core: resolves the root and require()s the LIVE issue-version-gate / pr-target-policy', { skip: !hasRealCore }, () => {
  const root = res.resolveGsdCoreRoot(path.join(REAL_GSD_CORE, 'scripts'));
  assert.strictEqual(fs.realpathSync(root), fs.realpathSync(REAL_GSD_CORE));

  const versionGate = res.requireLiveScript(root, 'scripts/issue-version-gate.cjs');
  assert.strictEqual(typeof versionGate.evaluateVersionGate, 'function');

  const prTarget = res.requireLiveScript(root, 'scripts/pr-target-policy.cjs');
  assert.strictEqual(typeof prTarget.classifyPrTarget, 'function');
  // Shape-check a RETURN (what the doctor in 03-06 will do on fixtures).
  const decision = prTarget.classifyPrTarget('next', 'anything');
  assert.strictEqual(decision.decision, 'allowed');
});
