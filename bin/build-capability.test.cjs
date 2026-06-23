'use strict';

/**
 * bin/build-capability.test.cjs — HERMETIC node:test for the bundle generator (CAP-02).
 *
 * Drives buildCapability / checkBundleFresh through their INJECTABLE seams (sourceHooksDir,
 * bundleHooksDir, manifestPath, snippetPath) against fixtures materialized in os.mkdtemp dirs —
 * the REAL capabilities/contribution-gate/ is NEVER mutated by this test. Assertions are on the returned
 * {fresh, staleFiles} / {files, version} shapes, never on process.exit (mirrors
 * bin/verify-capability.test.cjs + hooks/fault-injection.test.cjs disposable-sandbox style).
 *
 * Covers:
 *   1. build-then-check — after buildCapability() into a temp bundle, checkBundleFresh() is fresh.
 *   2. mutated-bundle   — corrupting one bundled file => not fresh, naming the file.
 *   3. missing-bundle   — no bundle present => not fresh (stale), every planned file missing.
 *   4. version-stamp    — after buildCapability(), the written manifest version is a semver.
 *   5. missing-source   — a canonical source file absent at build => LOUD throw (no partial bundle).
 *   6. confinement      — a wired script basename that escapes the bundle root is rejected.
 *
 * `bin/self-test.cjs` already runs `node --test` over the repo, which AUTO-DISCOVERS this file — no
 * new test wiring is added.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildCapability, checkBundleFresh, confineUnder, SEMVER_RE } = require('./build-capability.cjs');

// ── Fixture helpers ──────────────────────────────────────────────────────────

/**
 * Build a disposable fixture: a canonical source hooks/ tree (a few gate scripts + a lib/ subtree),
 * a settings.snippet.json wiring those gate basenames, a bundle dir, and a manifest to stamp.
 * Returns the seam paths to drive buildCapability / checkBundleFresh.
 */
function makeFixture(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-build-cap-'));
  const sourceHooksDir = path.join(dir, 'hooks');
  const libDir = path.join(sourceHooksDir, 'lib');
  fs.mkdirSync(libDir, { recursive: true });

  // Canonical gate scripts (the wired set) + a lib/ tree.
  const scripts = over.scripts || ['gate-a.cjs', 'gate-b.cjs'];
  for (const s of scripts) {
    fs.writeFileSync(path.join(sourceHooksDir, s), `// canonical ${s}\nmodule.exports = '${s}';\n`);
  }
  fs.writeFileSync(path.join(libDir, 'helper.cjs'), "// canonical lib helper\nmodule.exports = 'helper';\n");
  fs.writeFileSync(path.join(libDir, 'helper.test.cjs'), "// canonical lib test\n");

  // A settings.snippet.json wiring those gate basenames under hooks/.
  const snippetPath = path.join(dir, 'settings.snippet.json');
  const commands = scripts.map((s) => ({
    type: 'command',
    command: `"/usr/bin/node" "/abs/repo/hooks/${s}"`,
  }));
  fs.writeFileSync(
    snippetPath,
    JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: commands }] } }, null, 2)
  );

  // A manifest to stamp.
  const manifestPath = path.join(dir, 'capability.json');
  const manifest = Object.assign(
    { id: 'contribution-gate', role: 'feature', version: '2.3.4', title: 'Fixture', skills: ['x'] },
    over.manifest || {}
  );
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  const bundleHooksDir = path.join(dir, 'bundle', 'hooks');

  return { dir, sourceHooksDir, snippetPath, manifestPath, bundleHooksDir };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('build-then-check: buildCapability() then checkBundleFresh() reports fresh', () => {
  const fx = makeFixture();
  const built = buildCapability({
    sourceHooksDir: fx.sourceHooksDir,
    bundleHooksDir: fx.bundleHooksDir,
    manifestPath: fx.manifestPath,
    snippetPath: fx.snippetPath,
  });
  // wired scripts (2) + lib/ tree (2) = 4 planned files.
  assert.equal(built.files.length, 4);
  assert.ok(built.files.includes('gate-a.cjs'));
  assert.ok(built.files.includes('lib/helper.cjs'));

  const check = checkBundleFresh({
    sourceHooksDir: fx.sourceHooksDir,
    bundleHooksDir: fx.bundleHooksDir,
    snippetPath: fx.snippetPath,
  });
  assert.equal(check.fresh, true);
  assert.deepEqual(check.staleFiles, []);
  assert.equal(check.checked, 4);

  // Hermetic: a bundled file is byte-identical to its canonical source.
  const src = fs.readFileSync(path.join(fx.sourceHooksDir, 'gate-a.cjs'));
  const bundled = fs.readFileSync(path.join(fx.bundleHooksDir, 'gate-a.cjs'));
  assert.ok(src.equals(bundled));
});

test('mutated-bundle: corrupting one bundled file makes checkBundleFresh() not-fresh, naming it', () => {
  const fx = makeFixture();
  buildCapability({
    sourceHooksDir: fx.sourceHooksDir,
    bundleHooksDir: fx.bundleHooksDir,
    manifestPath: fx.manifestPath,
    snippetPath: fx.snippetPath,
  });

  // Corrupt one bundled file (drift vs source).
  fs.appendFileSync(path.join(fx.bundleHooksDir, 'gate-b.cjs'), '\n// drift\n');

  const check = checkBundleFresh({
    sourceHooksDir: fx.sourceHooksDir,
    bundleHooksDir: fx.bundleHooksDir,
    snippetPath: fx.snippetPath,
  });
  assert.equal(check.fresh, false);
  const named = check.staleFiles.find((s) => s.path === 'gate-b.cjs');
  assert.ok(named, 'the mutated file is named in staleFiles');
  assert.match(named.reason, /differs/);
});

test('WR-04 extra-file: a file planted in the bundle dir (not in the planned set) makes it not-fresh', () => {
  const fx = makeFixture();
  buildCapability({
    sourceHooksDir: fx.sourceHooksDir,
    bundleHooksDir: fx.bundleHooksDir,
    manifestPath: fx.manifestPath,
    snippetPath: fx.snippetPath,
  });

  // Plant an UNDECLARED file in the bundle dir (e.g. a malicious extra hook script). The old
  // one-sided check (planned-set present+identical only) was blind to this; WR-04 must flag it.
  fs.writeFileSync(path.join(fx.bundleHooksDir, 'evil-extra.cjs'), '// planted, not in planned set\n');
  fs.writeFileSync(path.join(fx.bundleHooksDir, 'lib', 'evil-nested.cjs'), '// planted in lib/\n');

  const check = checkBundleFresh({
    sourceHooksDir: fx.sourceHooksDir,
    bundleHooksDir: fx.bundleHooksDir,
    snippetPath: fx.snippetPath,
  });
  assert.equal(check.fresh, false, 'an augmented bundle is NEVER reported fresh (WR-04)');
  const topExtra = check.staleFiles.find((s) => s.path === 'evil-extra.cjs');
  const libExtra = check.staleFiles.find((s) => s.path === 'lib/evil-nested.cjs');
  assert.ok(topExtra, 'the top-level extra file is named in staleFiles');
  assert.ok(libExtra, 'the nested extra file is named in staleFiles');
  assert.match(topExtra.reason, /extra file in bundle/);
});

test('WR-04 no-regression: a bundle containing EXACTLY the planned set is still fresh', () => {
  const fx = makeFixture();
  buildCapability({
    sourceHooksDir: fx.sourceHooksDir,
    bundleHooksDir: fx.bundleHooksDir,
    manifestPath: fx.manifestPath,
    snippetPath: fx.snippetPath,
  });
  const check = checkBundleFresh({
    sourceHooksDir: fx.sourceHooksDir,
    bundleHooksDir: fx.bundleHooksDir,
    snippetPath: fx.snippetPath,
  });
  assert.equal(check.fresh, true, 'a bundle with no extra files stays fresh — the extra-file check is symmetric, not paranoid');
  assert.deepEqual(check.staleFiles, []);
});

test('missing-bundle: with no bundle present, checkBundleFresh() reports not-fresh (all stale)', () => {
  const fx = makeFixture();
  // Never build — the bundle dir does not exist.
  const check = checkBundleFresh({
    sourceHooksDir: fx.sourceHooksDir,
    bundleHooksDir: fx.bundleHooksDir,
    snippetPath: fx.snippetPath,
  });
  assert.equal(check.fresh, false);
  assert.equal(check.staleFiles.length, 4);
  for (const s of check.staleFiles) assert.match(s.reason, /missing from bundle/);
});

test('version-stamp: after buildCapability(), the written manifest version is a semver', () => {
  const fx = makeFixture();
  buildCapability({
    sourceHooksDir: fx.sourceHooksDir,
    bundleHooksDir: fx.bundleHooksDir,
    manifestPath: fx.manifestPath,
    snippetPath: fx.snippetPath,
  });
  const stamped = JSON.parse(fs.readFileSync(fx.manifestPath, 'utf8'));
  assert.match(stamped.version, SEMVER_RE);
  // The stamp preserves every other field (parse->set->write of the existing manifest).
  assert.equal(stamped.id, 'contribution-gate');
  assert.equal(stamped.role, 'feature');
  assert.deepEqual(stamped.skills, ['x']);

  // An explicit version arg is honored and validated.
  const built2 = buildCapability({
    sourceHooksDir: fx.sourceHooksDir,
    bundleHooksDir: fx.bundleHooksDir,
    manifestPath: fx.manifestPath,
    snippetPath: fx.snippetPath,
    version: '9.8.7',
  });
  assert.equal(built2.version, '9.8.7');
  assert.equal(JSON.parse(fs.readFileSync(fx.manifestPath, 'utf8')).version, '9.8.7');
});

test('missing-source: a canonical source file absent at build is a LOUD throw (no partial bundle)', () => {
  const fx = makeFixture();
  // Remove one wired canonical source AFTER the snippet still references it.
  fs.rmSync(path.join(fx.sourceHooksDir, 'gate-a.cjs'));
  assert.throws(
    () =>
      buildCapability({
        sourceHooksDir: fx.sourceHooksDir,
        bundleHooksDir: fx.bundleHooksDir,
        manifestPath: fx.manifestPath,
        snippetPath: fx.snippetPath,
      }),
    /missing canonical source/
  );
  // No partial bundle was written (the build threw before any copy).
  assert.equal(fs.existsSync(fx.bundleHooksDir), false);
});

test('confinement: a target escaping the bundle root is rejected before any write', () => {
  const fx = makeFixture();
  assert.throws(() => confineUnder(fx.bundleHooksDir, '../escape.cjs'), /outside the bundle root/);
  assert.throws(() => confineUnder(fx.bundleHooksDir, '/etc/passwd'), /outside the bundle root/);
  // WR-01: the root itself is NOT a valid target — '', '.', and any rel resolving to the root are
  // rejected (the contract is "strictly UNDER root", never the directory itself).
  assert.throws(() => confineUnder(fx.bundleHooksDir, ''), /outside the bundle root/);
  assert.throws(() => confineUnder(fx.bundleHooksDir, '.'), /outside the bundle root/);
  assert.throws(() => confineUnder(fx.bundleHooksDir, 'lib/..'), /outside the bundle root/);
  // A normal relative path resolves under the root.
  const ok = confineUnder(fx.bundleHooksDir, 'lib/helper.cjs');
  assert.ok(ok.startsWith(path.resolve(fx.bundleHooksDir)));
});
