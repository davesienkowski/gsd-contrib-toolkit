'use strict';

/**
 * bin/build-capability.test.cjs — HERMETIC node:test for the bundle generator (CAP-02).
 *
 * Drives buildCapability / checkBundleFresh through their INJECTABLE seams (sourceHooksDir,
 * bundleHooksDir, manifestPath, snippetPath) against fixtures materialized in os.mkdtemp dirs —
 * the REAL capabilities/contribution-toolkit/ is NEVER mutated by this test. Assertions are on the returned
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

const {
  buildCapability,
  checkBundleFresh,
  confineUnder,
  readDeclaredSkillSet,
  plannedSkillFiles,
  readDisclosedCommandSet,
  plannedCommandFiles,
  SEMVER_RE,
} = require('./build-capability.cjs');

// ── Fixture helpers ──────────────────────────────────────────────────────────

/**
 * Build a disposable fixture: a canonical source hooks/ tree (a few gate scripts + a lib/ subtree),
 * a canonical skills/ tree (one dir per declared stem with a SKILL.md + a supporting file), a
 * settings.snippet.json wiring those gate basenames, a bundle dir, and a manifest to stamp whose
 * skills[] names the fixture stems. Returns the seam paths to drive buildCapability /
 * checkBundleFresh. The REAL capabilities/contribution-toolkit/ is NEVER touched.
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

  // A canonical skills/ source tree — one dir per declared stem, each with a SKILL.md + a supporting
  // file. The set is DATA-DRIVEN: the manifest skills[] names these stems (changing it changes the
  // bundled set). A caller can declare a stem with NO source dir (over.skipSkillSourceFor) to drive
  // the missing-source LOUD-throw case.
  const skillStems = over.skillStems || ['skill-one', 'skill-two'];
  const sourceSkillsDir = path.join(dir, 'skills');
  const skipSource = new Set(over.skipSkillSourceFor || []);
  for (const stem of skillStems) {
    if (skipSource.has(stem)) continue; // declared but source dir intentionally absent
    const stemDir = path.join(sourceSkillsDir, stem);
    fs.mkdirSync(stemDir, { recursive: true });
    fs.writeFileSync(path.join(stemDir, 'SKILL.md'), `# canonical ${stem}\nbody for ${stem}\n`);
    fs.writeFileSync(path.join(stemDir, 'support.md'), `support doc for ${stem}\n`);
  }

  // A canonical commands/ source tree — FLAT `gsd-*.md` files (one per disclosed command), UNLIKE
  // skills' per-stem directory subtree. The set is DATA-DRIVEN from DISK: readDisclosedCommandSet
  // reads commands/gsd-*.md, so adding/renaming a fixture command changes the bundled set. A caller can
  // declare a command STEM with NO source file (over.skipCommandSourceFor) to drive the missing-source
  // LOUD-throw case — that stem is exposed via `commandStems`/`commandSet` so a test can inject it
  // through the buildCapability/checkBundleFresh `commandSet` seam (the disk-derived set would not
  // include a file that was never written).
  const commandStems = over.commandStems || ['gsd-one', 'gsd-two'];
  const sourceCommandsDir = path.join(dir, 'commands');
  fs.mkdirSync(sourceCommandsDir, { recursive: true });
  const skipCommandSource = new Set(over.skipCommandSourceFor || []);
  for (const stem of commandStems) {
    if (skipCommandSource.has(stem)) continue; // declared but source .md intentionally absent
    fs.writeFileSync(path.join(sourceCommandsDir, stem + '.md'), `# canonical ${stem}\nbody for ${stem}\n`);
  }
  // Plant a non-matching file to prove the /^gsd-.*\.md$/ filter excludes it from the disclosed set.
  fs.writeFileSync(path.join(sourceCommandsDir, '.gitkeep'), '');
  fs.writeFileSync(path.join(sourceCommandsDir, 'README.md'), '# not a gsd command\n');

  // A manifest to stamp — skills[] declares the fixture stems (data-driven source for the bundle).
  const manifestPath = path.join(dir, 'capability.json');
  const manifest = Object.assign(
    { id: 'contribution-toolkit', role: 'feature', version: '2.3.4', title: 'Fixture', skills: skillStems.slice() },
    over.manifest || {}
  );
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  const bundleHooksDir = path.join(dir, 'bundle', 'hooks');
  const bundleSkillsDir = path.join(dir, 'bundle', 'skills');
  const bundleCommandsDir = path.join(dir, 'bundle', 'commands');

  return {
    dir,
    sourceHooksDir,
    sourceSkillsDir,
    sourceCommandsDir,
    snippetPath,
    manifestPath,
    bundleHooksDir,
    bundleSkillsDir,
    bundleCommandsDir,
    skillStems,
    commandStems,
    // The full declared command set (including any skipped stem) — for the missing-source seam.
    commandSet: commandStems.slice().sort(),
  };
}

/** The full seam set to drive build/check against a fixture (all three trees). */
function seams(fx) {
  return {
    sourceHooksDir: fx.sourceHooksDir,
    bundleHooksDir: fx.bundleHooksDir,
    sourceSkillsDir: fx.sourceSkillsDir,
    bundleSkillsDir: fx.bundleSkillsDir,
    sourceCommandsDir: fx.sourceCommandsDir,
    bundleCommandsDir: fx.bundleCommandsDir,
    manifestPath: fx.manifestPath,
    snippetPath: fx.snippetPath,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

// The fixture ships 4 planned hook files (2 gate scripts + lib/helper.cjs + lib/helper.test.cjs),
// 4 planned skill files (2 stems × {SKILL.md, support.md}), and 2 planned command files (flat
// gsd-one.md + gsd-two.md) = 10 planned files total. The non-matching README.md / .gitkeep planted in
// commands/ are NOT in the disclosed set (the /^gsd-.*\.md$/ filter excludes them).
const FIXTURE_HOOK_FILES = 4;
const FIXTURE_SKILL_FILES = 4;
const FIXTURE_COMMAND_FILES = 2;
const FIXTURE_TOTAL_FILES = FIXTURE_HOOK_FILES + FIXTURE_SKILL_FILES + FIXTURE_COMMAND_FILES;

test('build-then-check: buildCapability() then checkBundleFresh() reports fresh', () => {
  const fx = makeFixture();
  const built = buildCapability(seams(fx));
  assert.equal(built.files.length, FIXTURE_TOTAL_FILES);
  assert.ok(built.files.includes('gate-a.cjs'));
  assert.ok(built.files.includes('lib/helper.cjs'));
  assert.ok(built.files.includes('skills/skill-one/SKILL.md'));

  const check = checkBundleFresh(seams(fx));
  assert.equal(check.fresh, true);
  assert.deepEqual(check.staleFiles, []);
  assert.equal(check.checked, FIXTURE_TOTAL_FILES);

  // Hermetic: a bundled file is byte-identical to its canonical source.
  const src = fs.readFileSync(path.join(fx.sourceHooksDir, 'gate-a.cjs'));
  const bundled = fs.readFileSync(path.join(fx.bundleHooksDir, 'gate-a.cjs'));
  assert.ok(src.equals(bundled));
});

test('mutated-bundle: corrupting one bundled file makes checkBundleFresh() not-fresh, naming it', () => {
  const fx = makeFixture();
  buildCapability(seams(fx));

  // Corrupt one bundled file (drift vs source).
  fs.appendFileSync(path.join(fx.bundleHooksDir, 'gate-b.cjs'), '\n// drift\n');

  const check = checkBundleFresh(seams(fx));
  assert.equal(check.fresh, false);
  const named = check.staleFiles.find((s) => s.path === 'gate-b.cjs');
  assert.ok(named, 'the mutated file is named in staleFiles');
  assert.match(named.reason, /differs/);
});

test('WR-04 extra-file: a file planted in the bundle dir (not in the planned set) makes it not-fresh', () => {
  const fx = makeFixture();
  buildCapability(seams(fx));

  // Plant an UNDECLARED file in the bundle dir (e.g. a malicious extra hook script). The old
  // one-sided check (planned-set present+identical only) was blind to this; WR-04 must flag it.
  fs.writeFileSync(path.join(fx.bundleHooksDir, 'evil-extra.cjs'), '// planted, not in planned set\n');
  fs.writeFileSync(path.join(fx.bundleHooksDir, 'lib', 'evil-nested.cjs'), '// planted in lib/\n');

  const check = checkBundleFresh(seams(fx));
  assert.equal(check.fresh, false, 'an augmented bundle is NEVER reported fresh (WR-04)');
  const topExtra = check.staleFiles.find((s) => s.path === 'evil-extra.cjs');
  const libExtra = check.staleFiles.find((s) => s.path === 'lib/evil-nested.cjs');
  assert.ok(topExtra, 'the top-level extra file is named in staleFiles');
  assert.ok(libExtra, 'the nested extra file is named in staleFiles');
  assert.match(topExtra.reason, /extra file in bundle/);
});

test('WR-04 no-regression: a bundle containing EXACTLY the planned set is still fresh', () => {
  const fx = makeFixture();
  buildCapability(seams(fx));
  const check = checkBundleFresh(seams(fx));
  assert.equal(check.fresh, true, 'a bundle with no extra files stays fresh — the extra-file check is symmetric, not paranoid');
  assert.deepEqual(check.staleFiles, []);
});

test('missing-bundle: with no bundle present, checkBundleFresh() reports not-fresh (all stale)', () => {
  const fx = makeFixture();
  // Never build — the bundle dir does not exist.
  const check = checkBundleFresh(seams(fx));
  assert.equal(check.fresh, false);
  assert.equal(check.staleFiles.length, FIXTURE_TOTAL_FILES);
  for (const s of check.staleFiles) assert.match(s.reason, /missing from bundle/);
});

test('version-stamp: after buildCapability(), the written manifest version is a semver', () => {
  const fx = makeFixture();
  buildCapability(seams(fx));
  const stamped = JSON.parse(fs.readFileSync(fx.manifestPath, 'utf8'));
  assert.match(stamped.version, SEMVER_RE);
  // The stamp preserves every other field (parse->set->write of the existing manifest).
  assert.equal(stamped.id, 'contribution-toolkit');
  assert.equal(stamped.role, 'feature');
  assert.deepEqual(stamped.skills, fx.skillStems);

  // An explicit version arg is honored and validated.
  const built2 = buildCapability(Object.assign({}, seams(fx), { version: '9.8.7' }));
  assert.equal(built2.version, '9.8.7');
  assert.equal(JSON.parse(fs.readFileSync(fx.manifestPath, 'utf8')).version, '9.8.7');
});

test('missing-source: a canonical source file absent at build is a LOUD throw (no partial bundle)', () => {
  const fx = makeFixture();
  // Remove one wired canonical source AFTER the snippet still references it.
  fs.rmSync(path.join(fx.sourceHooksDir, 'gate-a.cjs'));
  assert.throws(() => buildCapability(seams(fx)), /missing canonical source/);
  // No partial bundle was written (the build threw before any copy of EITHER tree).
  assert.equal(fs.existsSync(fx.bundleHooksDir), false);
  assert.equal(fs.existsSync(fx.bundleSkillsDir), false,
    'skills bundle dir must also be absent — the throw must precede ALL mkdirSync calls');
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

// ── Skills bundling (CAP-09) ───────────────────────────────────────────────────

test('skills data-driven set: readDeclaredSkillSet returns skills[] verbatim; changing skills[] changes the set', () => {
  const fx = makeFixture();
  // The fixture manifest declares the fixture stems — readDeclaredSkillSet returns them sorted/unique.
  assert.deepEqual(readDeclaredSkillSet({ manifestPath: fx.manifestPath }), ['skill-one', 'skill-two']);

  // Rewrite the manifest skills[] — the returned set FOLLOWS the declaration (proves NOT hardcoded).
  const m = JSON.parse(fs.readFileSync(fx.manifestPath, 'utf8'));
  m.skills = ['only-this-one', 'only-this-one']; // dup collapses
  fs.writeFileSync(fx.manifestPath, JSON.stringify(m, null, 2));
  assert.deepEqual(readDeclaredSkillSet({ manifestPath: fx.manifestPath }), ['only-this-one']);

  // A non-array / absent skills field is tolerated (returns []).
  m.skills = undefined;
  fs.writeFileSync(fx.manifestPath, JSON.stringify(m, null, 2));
  assert.deepEqual(readDeclaredSkillSet({ manifestPath: fx.manifestPath }), []);
});

test('skills verbatim copy: build copies every declared skill file byte-identical under skills/<stem>/', () => {
  const fx = makeFixture();
  buildCapability(seams(fx));
  for (const stem of fx.skillStems) {
    for (const name of ['SKILL.md', 'support.md']) {
      const src = path.join(fx.sourceSkillsDir, stem, name);
      const bundled = path.join(fx.bundleSkillsDir, stem, name);
      assert.ok(fs.existsSync(bundled), `${stem}/${name} exists in the bundle skills tree`);
      assert.ok(fs.readFileSync(src).equals(fs.readFileSync(bundled)), `${stem}/${name} is byte-identical`);
    }
  }
});

test('skills in --check parity (fresh): a clean build is fresh and checked counts the skill files', () => {
  const fx = makeFixture();
  buildCapability(seams(fx));
  const check = checkBundleFresh(seams(fx));
  assert.equal(check.fresh, true);
  assert.deepEqual(check.staleFiles, []);
  // checked covers BOTH trees (4 hooks + 4 skills).
  assert.equal(check.checked, FIXTURE_TOTAL_FILES);
});

test('skills-drift stale: corrupting a bundled skill file => not-fresh, naming the skills/ path "differs"', () => {
  const fx = makeFixture();
  buildCapability(seams(fx));
  fs.appendFileSync(path.join(fx.bundleSkillsDir, 'skill-one', 'SKILL.md'), '\ndrift\n');

  const check = checkBundleFresh(seams(fx));
  assert.equal(check.fresh, false);
  const named = check.staleFiles.find((s) => s.path === 'skills/skill-one/SKILL.md');
  assert.ok(named, 'the corrupted bundled skill file is named with a skills/ prefix');
  assert.match(named.reason, /differs from canonical source/);
});

test('skills-drift missing: deleting a bundled skill file => not-fresh, naming it "missing from bundle"', () => {
  const fx = makeFixture();
  buildCapability(seams(fx));
  fs.rmSync(path.join(fx.bundleSkillsDir, 'skill-two', 'support.md'));

  const check = checkBundleFresh(seams(fx));
  assert.equal(check.fresh, false);
  const named = check.staleFiles.find((s) => s.path === 'skills/skill-two/support.md');
  assert.ok(named, 'the deleted bundled skill file is named with a skills/ prefix');
  assert.match(named.reason, /missing from bundle/);
});

test('skills-drift extra: planting an undeclared file under bundle skills/ => not-fresh, naming it "extra"', () => {
  const fx = makeFixture();
  buildCapability(seams(fx));
  // Plant an undeclared file under the bundle skills tree (e.g. a stray skill file).
  fs.writeFileSync(path.join(fx.bundleSkillsDir, 'skill-one', 'PLANTED.md'), 'not in the planned set\n');

  const check = checkBundleFresh(seams(fx));
  assert.equal(check.fresh, false, 'an augmented skills tree is NEVER reported fresh (WR-04 symmetry)');
  const named = check.staleFiles.find((s) => s.path === 'skills/skill-one/PLANTED.md');
  assert.ok(named, 'the planted skill file is named with a skills/ prefix');
  assert.match(named.reason, /extra file in bundle/);
});

test('skills missing-source: a declared skill with no source dir is a LOUD throw (no partial bundle)', () => {
  // skill-two is DECLARED in skills[] but its canonical source dir is intentionally absent.
  const fx = makeFixture({ skipSkillSourceFor: ['skill-two'] });
  assert.throws(() => buildCapability(seams(fx)), /missing canonical skill source dir/);
  assert.throws(() => buildCapability(seams(fx)), /skills\/skill-two/);
  // No partial bundle was written (the build threw before any copy of EITHER tree).
  assert.equal(fs.existsSync(fx.bundleHooksDir), false);
  assert.equal(fs.existsSync(fx.bundleSkillsDir), false);
});

test('skills confinement: a skill file resolving outside the bundle skills root is rejected before any write', () => {
  const fx = makeFixture();
  // A traversal stem/file is rejected by confineUnder before any write (mirrors the hooks guard).
  assert.throws(() => confineUnder(fx.bundleSkillsDir, '../escape/SKILL.md'), /outside the bundle root/);
  assert.throws(() => confineUnder(fx.bundleSkillsDir, '/etc/evil/SKILL.md'), /outside the bundle root/);
  assert.throws(() => confineUnder(fx.bundleSkillsDir, 'stem/..'), /outside the bundle root/);
  // A normal nested skill path resolves under the skills root.
  const ok = confineUnder(fx.bundleSkillsDir, 'skill-one/SKILL.md');
  assert.ok(ok.startsWith(path.resolve(fx.bundleSkillsDir)));
});

test('WR-01 traversal-stem: a stem with path separators or absolute path in manifest.skills[] throws before any read', () => {
  const fx = makeFixture();
  const traversalStems = ['../../etc', '../other', '/etc/passwd', 'a/b', 'a\\b'];
  for (const badStem of traversalStems) {
    // plannedSkillFiles must throw LOUD before touching the filesystem for any traversal stem.
    assert.throws(
      () => plannedSkillFiles({ sourceSkillsDir: fx.sourceSkillsDir, skillSet: [badStem] }),
      /refusing to read skill source for unsafe stem name/,
      `expected throw for traversal stem ${JSON.stringify(badStem)}`
    );
    // buildCapability must also throw (it calls plannedSkillFiles internally).
    const m = JSON.parse(fs.readFileSync(fx.manifestPath, 'utf8'));
    m.skills = [badStem];
    fs.writeFileSync(fx.manifestPath, JSON.stringify(m, null, 2));
    assert.throws(
      () => buildCapability(seams(fx)),
      /refusing to read skill source for unsafe stem name/,
      `buildCapability must throw for traversal stem ${JSON.stringify(badStem)}`
    );
  }
  // A plain single-segment stem (no traversal) must still work.
  const { files } = plannedSkillFiles({ sourceSkillsDir: fx.sourceSkillsDir, skillSet: ['skill-one'] });
  assert.ok(files.length > 0, 'a safe stem enumerates its skill files normally');
});

// ── Commands bundling (CAP-10) ──────────────────────────────────────────────────
// Commands are FLAT `<stem>.md` files (one per disclosed command), DATA-DRIVEN from the disclosed
// command set on DISK (commands/gsd-*.md) — unlike skills' per-stem directory subtree (declared in the
// manifest skills[]). The cases below MIRROR the skills cases for parity.

test('commands data-driven set: readDisclosedCommandSet returns commands/gsd-*.md stems; adding/removing a file changes the set', () => {
  const fx = makeFixture();
  // The fixture discloses gsd-one.md + gsd-two.md (README.md / .gitkeep are excluded by the filter).
  assert.deepEqual(readDisclosedCommandSet({ commandsDir: fx.sourceCommandsDir }), ['gsd-one', 'gsd-two']);

  // Add a disclosed command on disk — the returned set FOLLOWS the disk (proves NOT hardcoded).
  fs.writeFileSync(path.join(fx.sourceCommandsDir, 'gsd-three.md'), '# gsd-three\n');
  assert.deepEqual(readDisclosedCommandSet({ commandsDir: fx.sourceCommandsDir }), ['gsd-one', 'gsd-three', 'gsd-two']);

  // Remove one — the set shrinks. A non-gsd-*.md file (README.md) is never disclosed.
  fs.rmSync(path.join(fx.sourceCommandsDir, 'gsd-one.md'));
  assert.deepEqual(readDisclosedCommandSet({ commandsDir: fx.sourceCommandsDir }), ['gsd-three', 'gsd-two']);
});

test('commands missing-dir: readDisclosedCommandSet on an unreadable commands dir throws LOUD (never silent zero)', () => {
  const fx = makeFixture();
  assert.throws(
    () => readDisclosedCommandSet({ commandsDir: path.join(fx.dir, 'does-not-exist') }),
    /ENOENT|no such file/i,
    'a missing commands dir is a LOUD throw, never a silent empty set'
  );
});

test('commands verbatim copy: build copies every disclosed command .md byte-identical under commands/', () => {
  const fx = makeFixture();
  const built = buildCapability(seams(fx));
  assert.equal(built.files.length, FIXTURE_TOTAL_FILES);
  assert.ok(built.files.includes('commands/gsd-one.md'));
  assert.ok(built.files.includes('commands/gsd-two.md'));
  for (const stem of fx.commandStems) {
    const src = path.join(fx.sourceCommandsDir, stem + '.md');
    const bundled = path.join(fx.bundleCommandsDir, stem + '.md');
    assert.ok(fs.existsSync(bundled), `${stem}.md exists in the bundle commands tree`);
    assert.ok(fs.readFileSync(src).equals(fs.readFileSync(bundled)), `${stem}.md is byte-identical`);
  }
  // The non-matching planted files are NEVER copied into the bundle.
  assert.equal(fs.existsSync(path.join(fx.bundleCommandsDir, 'README.md')), false);
  assert.equal(fs.existsSync(path.join(fx.bundleCommandsDir, '.gitkeep')), false);
});

test('commands in --check parity (fresh): a clean build is fresh and checked counts the command files', () => {
  const fx = makeFixture();
  buildCapability(seams(fx));
  const check = checkBundleFresh(seams(fx));
  assert.equal(check.fresh, true);
  assert.deepEqual(check.staleFiles, []);
  // checked covers ALL THREE trees (4 hooks + 4 skills + 2 commands).
  assert.equal(check.checked, FIXTURE_TOTAL_FILES);
});

test('commands-drift stale: corrupting a bundled command .md => not-fresh, naming the commands/ path "differs"', () => {
  const fx = makeFixture();
  buildCapability(seams(fx));
  fs.appendFileSync(path.join(fx.bundleCommandsDir, 'gsd-one.md'), '\ndrift\n');

  const check = checkBundleFresh(seams(fx));
  assert.equal(check.fresh, false);
  const named = check.staleFiles.find((s) => s.path === 'commands/gsd-one.md');
  assert.ok(named, 'the corrupted bundled command file is named with a commands/ prefix');
  assert.match(named.reason, /differs from canonical source/);
});

test('commands-drift missing: deleting a bundled command .md => not-fresh, naming it "missing from bundle"', () => {
  const fx = makeFixture();
  buildCapability(seams(fx));
  fs.rmSync(path.join(fx.bundleCommandsDir, 'gsd-two.md'));

  const check = checkBundleFresh(seams(fx));
  assert.equal(check.fresh, false);
  const named = check.staleFiles.find((s) => s.path === 'commands/gsd-two.md');
  assert.ok(named, 'the deleted bundled command file is named with a commands/ prefix');
  assert.match(named.reason, /missing from bundle/);
});

test('commands-drift extra: planting an undeclared gsd-*.md under bundle commands/ => not-fresh, naming it "extra"', () => {
  const fx = makeFixture();
  buildCapability(seams(fx));
  // Plant an undeclared command file under the bundle commands tree (the WR-04 augmented-bundle case).
  fs.writeFileSync(path.join(fx.bundleCommandsDir, 'gsd-planted.md'), 'not in the planned set\n');

  const check = checkBundleFresh(seams(fx));
  assert.equal(check.fresh, false, 'an augmented commands tree is NEVER reported fresh (WR-04 symmetry)');
  const named = check.staleFiles.find((s) => s.path === 'commands/gsd-planted.md');
  assert.ok(named, 'the planted command file is named with a commands/ prefix');
  assert.match(named.reason, /extra file in bundle/);
});

test('commands missing-source: a disclosed command with no source .md is a LOUD throw (no partial bundle)', () => {
  // gsd-two is DECLARED in the command set but its canonical source .md is intentionally absent. The
  // disk-derived set would not include it, so inject the full set via the commandSet seam to prove the
  // build fails LOUD (no partial bundle) when a declared command's source is missing.
  const fx = makeFixture({ skipCommandSourceFor: ['gsd-two'] });
  const withSet = Object.assign({}, seams(fx), { commandSet: fx.commandSet });
  assert.throws(() => buildCapability(withSet), /missing canonical command source/);
  assert.throws(() => buildCapability(withSet), /commands\/gsd-two\.md/);
  // No partial bundle was written (the build threw before any copy of ANY tree).
  assert.equal(fs.existsSync(fx.bundleHooksDir), false);
  assert.equal(fs.existsSync(fx.bundleSkillsDir), false);
  assert.equal(fs.existsSync(fx.bundleCommandsDir), false,
    'commands bundle dir must also be absent — the throw must precede ALL mkdirSync calls');
});

test('commands WR-01 traversal-stem: a command stem with path separators or absolute path throws before any read', () => {
  const fx = makeFixture();
  const traversalStems = ['../../etc', '../other', '/etc/passwd', 'a/b', 'a\\b'];
  for (const badStem of traversalStems) {
    assert.throws(
      () => plannedCommandFiles({ sourceCommandsDir: fx.sourceCommandsDir, commandSet: [badStem] }),
      /refusing to read command source for unsafe stem name/,
      `expected throw for traversal stem ${JSON.stringify(badStem)}`
    );
    // buildCapability must also throw (it calls plannedCommandFiles internally) when the bad stem is
    // injected through the commandSet seam.
    assert.throws(
      () => buildCapability(Object.assign({}, seams(fx), { commandSet: [badStem] })),
      /refusing to read command source for unsafe stem name/,
      `buildCapability must throw for traversal stem ${JSON.stringify(badStem)}`
    );
  }
  // A plain single-segment stem (no traversal) must still work.
  const { files } = plannedCommandFiles({ sourceCommandsDir: fx.sourceCommandsDir, commandSet: ['gsd-one'] });
  assert.deepEqual(files, ['gsd-one.md'], 'a safe stem maps to a flat <stem>.md entry');
});

test('commands confinement: a command file resolving outside the bundle commands root is rejected before any write', () => {
  const fx = makeFixture();
  assert.throws(() => confineUnder(fx.bundleCommandsDir, '../escape.md'), /outside the bundle root/);
  assert.throws(() => confineUnder(fx.bundleCommandsDir, '/etc/evil.md'), /outside the bundle root/);
  assert.throws(() => confineUnder(fx.bundleCommandsDir, 'sub/..'), /outside the bundle root/);
  // A normal flat command path resolves under the commands root.
  const ok = confineUnder(fx.bundleCommandsDir, 'gsd-one.md');
  assert.ok(ok.startsWith(path.resolve(fx.bundleCommandsDir)));
});
