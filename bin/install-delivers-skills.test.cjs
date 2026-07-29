'use strict';

/**
 * bin/install-delivers-skills.test.cjs — the CAP-09 empirical LOCAL-install proof.
 *
 * This is the verifier-reach=spec-reach proof for "the bundle actually DELIVERS its declared skills
 * on install". It drives the SAME LIVE gsd-core staging/promote path a real `capability install`
 * drives (HARD-02 — never a reimplementation): the LIVE `resolveCapabilitySource` local adapter,
 * loaded via requireLiveScript (LOUD-on-miss), against the REAL in-repo bundle dir
 * (capabilities/contribution-toolkit) as a `local:` source, with a DISPOSABLE mkdtemp sandbox as the
 * install gsdHome. It then ASSERTS the on-disk materialized result at the install root is the
 * overlay-expected form:
 *
 *   <sandbox>/.gsd/capabilities/contribution-toolkit/skills/<stem>/SKILL.md  (byte-identical to
 *   the canonical skills/<stem>/SKILL.md), plus the co-located capability.json whose skills[] names
 *   both stems — the loader's read point (capability-loader capDir/capability.json).
 *
 * WHY EMPIRICAL, NOT ASSERTED: the point is to prove the LIVE writer (copyDirRecursive verbatim →
 * renameSync to finalDir) actually lands the bundle skills/ tree at the install root — not that our
 * generator wrote them into the bundle (build-capability.test.cjs already proves that). So the
 * assertions are on the materialized files, never on a mocked return.
 *
 * LOCAL + DISPOSABLE (privacy: publish is Phase 20): the source is a LOCAL path, the install root is
 * a mkdtemp sandbox, and NOTHING is written outside the sandbox. There is no network/push path.
 *
 * REACHABILITY: when no LIVE gsd-core checkout is reachable (GSD_CORE_ROOT, ~/repos/gsd-core,
 * ~/gsd-core), the case SKIPs-with-note — never a false green when the engine is unreachable
 * (mirrors contrib-capability.test.cjs SKIP behavior). A renamed/absent LIVE export FAILS the proof
 * (requireLiveScript throws ScriptResolveError) — never a vendored fallback.
 *
 * ENGINES GATE: the running host package.json version is a prerelease (1.6.0-rc.*) which does NOT
 * satisfy the manifest's engines.gsd ">=1.6.0" under strict semver. This proof targets SKILLS
 * DELIVERY, not the engines gate, so it passes skipEnginesGate:true (the documented opt — the LIVE
 * structural/cross-capability validation still runs in full).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * 21-03 ADDENDUM — the DRIVER's dir-symlink delivery + both safeties (UNCONDITIONAL) + e2e:
 *
 * The LIVE-source-adapter test above proves the STAGING materialization (the bundle skills/ tree
 * lands at the install root via copyDirRecursive→rename). The blocks BELOW prove the DRIVER's
 * runtime delivery — the directory-symlink form that `on`/`install` lay down at the live skills dir:
 *
 *   • DELIVERY + RECLAIM (UNCONDITIONAL) — drives drv.deliverBundledSkills / removeBundledSkills
 *     directly (pure node:fs over the BUNDLE — no LIVE gsd-core checkout needed, mirrors the command
 *     proof's unconditional half). Asserts each stem materializes as a DIRECTORY symlink resolving
 *     INTO the bundle with a byte-identical SKILL.md; a pre-seeded REAL skill dir is NEVER clobbered
 *     by deliver (DriverError) NOR reclaimed by removeBundledSkills (T-17-02-CLOBBER /
 *     T-17-02-OVERREMOVE on a DIRECTORY symlink); removeBundledSkills reclaims EXACTLY the 2 bundle
 *     dir-symlinks and the bundle's real skills/<stem>/SKILL.md still exists (the LINK was unlinked,
 *     never recursed into).
 *
 *   • END-TO-END (SKIP-on-unreachable) — drives the full runInstall→runRemove against a disposable
 *     sandbox gsd-core checkout, proving the 2 skills land ALONGSIDE the 5 commands + 14 hooks via the
 *     SAME composed LIVE engine, and runRemove reclaims the skill links. SKIPs-with-note when no LIVE
 *     gsd-core checkout is reachable (never a false green).
 *
 * DISPOSABLE: every write below targets a mkdtemp sandbox skillsDir (injected), NOTHING touches the
 * real ~/.claude/skills, and each test cleans up in a finally{} (T-12-03-LEAK).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const drv = require('./contrib-capability.cjs');
const { requireLiveScript, resolveGsdCoreRoot } = require('../hooks/lib/resolve.cjs');

const CAP_ID = 'contribution-toolkit';
const REPO_ROOT = path.resolve(__dirname, '..');
const BUNDLE_DIR = path.join(REPO_ROOT, 'capabilities', CAP_ID);
const CANONICAL_SKILLS_DIR = path.join(REPO_ROOT, 'skills');
// The two declared stems whose SKILL.md must materialize at the install root, named explicitly so a
// silently-dropped skill is caught (the overlay-expected form is asserted per-stem).
const EXPECTED_STEMS = ['gsd-core-contribution', 'maintainer-review-sweep'];

/**
 * Resolve the LIVE gsd-core checkout the SAME way the driver does: GSD_CORE_ROOT, then
 * ~/repos/gsd-core, then ~/gsd-core — by the sentinel layout (scripts/ + gsd-core/bin/lib/). Returns
 * an absolute root or null. When null, the case SKIPs-with-note (never fabricate).
 */
function resolveLiveRootOrNull() {
  const hasSentinel = (dir) => {
    try {
      return (
        fs.statSync(path.join(dir, 'scripts')).isDirectory() &&
        fs.statSync(path.join(dir, 'gsd-core', 'bin', 'lib')).isDirectory()
      );
    } catch (_) {
      return false;
    }
  };
  const candidates = [
    process.env.GSD_CORE_ROOT,
    path.join(os.homedir(), 'repos', 'gsd-core'),
    path.join(os.homedir(), 'gsd-core'),
  ].filter(Boolean);
  for (const c of candidates) {
    if (hasSentinel(c)) return c;
  }
  return null;
}

const LIVE_ROOT = resolveLiveRootOrNull();
const SKIP_NOTE =
  'no LIVE gsd-core checkout reachable (set GSD_CORE_ROOT, or use ~/repos/gsd-core | ~/gsd-core) — ' +
  'install-delivers-skills SKIPPED (env limitation; never a false green when the engine is unreachable)';
const SKIP = LIVE_ROOT ? false : SKIP_NOTE;

test(
  'LOCAL install delivers both skills to <sandbox>/.gsd/capabilities/contribution-toolkit/skills/<stem>/SKILL.md (overlay-expected form)',
  { skip: SKIP },
  async () => {
    // Load the LIVE capability-source engine — reuse-LIVE, LOUD-on-miss (a renamed/absent export
    // throws ScriptResolveError and FAILS the proof; never a vendored reimplementation).
    const capSource = requireLiveScript(LIVE_ROOT, 'gsd-core/bin/lib/capability-source.cjs');
    assert.strictEqual(
      typeof capSource.resolveCapabilitySource,
      'function',
      'LIVE capability-source must export resolveCapabilitySource (the install staging/promote entrypoint)'
    );

    // A disposable mkdtemp sandbox as the install gsdHome — finalDir resolves to
    // <sandbox>/.gsd/capabilities/contribution-toolkit. NOTHING is written outside this sandbox.
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-install-skills-'));
    try {
      // Drive the LIVE local adapter against the REAL in-repo bundle dir as a `local:` source (an
      // absolute path is auto-detected as kind 'local' by parseSpec). promote:true => copy + promote
      // the whole bundle (verbatim copyDirRecursive incl. skills/<stem>/**) to the install root.
      // skipEnginesGate:true — this proof targets skills delivery, not the prerelease engines gate.
      const result = await capSource.resolveCapabilitySource(BUNDLE_DIR, {
        gsdHome: sandbox,
        promote: true,
        skipEnginesGate: true,
      });

      const installRoot = path.join(sandbox, '.gsd', 'capabilities', CAP_ID);
      assert.strictEqual(
        path.resolve(result.stagedDir),
        path.resolve(installRoot),
        'promote:true must land the bundle at <sandbox>/.gsd/capabilities/contribution-toolkit (finalDir)'
      );

      // The co-located manifest the overlay loader reads (capDir/capability.json) must exist and its
      // skills[] must name BOTH stems — so the declaration resolves against the delivered files.
      const installedManifestPath = path.join(installRoot, 'capability.json');
      assert.ok(
        fs.existsSync(installedManifestPath),
        'the co-located capability.json must exist at the install root (loader read point)'
      );
      const installedManifest = JSON.parse(fs.readFileSync(installedManifestPath, 'utf8'));
      assert.ok(Array.isArray(installedManifest.skills), 'installed manifest skills[] must be an array');
      for (const stem of EXPECTED_STEMS) {
        assert.ok(
          installedManifest.skills.includes(stem),
          `installed manifest skills[] must declare "${stem}" (so the overlay resolves it to the delivered files)`
        );
      }

      // The overlay-expected materialized form: each stem's SKILL.md exists at the install root AND
      // is byte-identical to its canonical source. Assert on the ON-DISK result (the LIVE writer's
      // delivery), not a mocked return.
      for (const stem of EXPECTED_STEMS) {
        const installedSkill = path.join(installRoot, 'skills', stem, 'SKILL.md');
        const canonicalSkill = path.join(CANONICAL_SKILLS_DIR, stem, 'SKILL.md');
        assert.ok(
          fs.existsSync(installedSkill),
          `${stem}/SKILL.md must materialize at <installRoot>/skills/${stem}/SKILL.md (overlay-expected form)`
        );
        assert.ok(
          fs.readFileSync(installedSkill).equals(fs.readFileSync(canonicalSkill)),
          `installed ${stem}/SKILL.md must be byte-identical to the canonical skills/${stem}/SKILL.md`
        );
      }
    } finally {
      // Clean up the sandbox — no temp residue (T-12-03-LEAK).
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  }
);

// ──────────────────── DRIVER dir-symlink DELIVERY + RECLAIM + both safeties (unconditional) ────────────────────
//
// Drives the REAL drv.deliverBundledSkills / removeBundledSkills (pure node:fs over the BUNDLE — no
// LIVE gsd-core checkout needed), so this load-bearing half runs ALWAYS. Asserts on the ON-DISK
// materialized DIRECTORY symlinks, never a mocked return — the runtime form `on`/`install` lay down.

test('DRIVER delivers both skills as bundle DIRECTORY symlinks (byte-identical SKILL.md) + reclaims exactly them; real dir survives both', () => {
  // Data-driven: the asserted set IS the bundle's on-disk skill-stem set (a dropped skill is caught
  // here AND by the explicit EXPECTED_STEMS cross-check below).
  const names = drv.bundledSkillNames(BUNDLE_DIR);
  assert.deepStrictEqual(
    names.slice().sort(),
    EXPECTED_STEMS.slice().sort(),
    'the bundle skills/ dir must ship EXACTLY the 2 declared skill stems (a dropped/extra skill would ' +
      'mean a remote install does NOT reproduce the local skill experience)'
  );

  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-driver-skills-'));
  try {
    const skillsDir = path.join(sandbox, '.claude', 'skills');

    // A pre-seeded REAL (non-symlink) skill DIR that must SURVIVE deliver (never clobbered) and
    // removeBundledSkills (never reclaimed) — T-17-02-CLOBBER / T-17-02-OVERREMOVE on a DIRECTORY
    // symlink target. It occupies one of the bundle stem positions so deliver collides with it.
    const realStem = EXPECTED_STEMS[0];
    const realKeepDir = path.join(skillsDir, realStem);
    fs.mkdirSync(realKeepDir, { recursive: true });
    const realKeepBytes = '# a real user-authored skill — must never be clobbered or reclaimed\n';
    fs.writeFileSync(path.join(realKeepDir, 'SKILL.md'), realKeepBytes, 'utf8');

    // ── DELIVER (collision case) ── a real dir at a bundle-stem target must make deliver FAIL LOUD
    // rather than clobber it (mirrors the command clobber-safety on a DIRECTORY symlink).
    assert.throws(
      () => drv.deliverBundledSkills({ bundleDir: BUNDLE_DIR, skillsDir }),
      (err) => err instanceof drv.DriverError && /refusing to overwrite/i.test(err.message),
      'deliver must refuse to clobber a real dir at a skill target (T-17-02-CLOBBER on a directory symlink)'
    );
    assert.strictEqual(
      fs.lstatSync(realKeepDir).isSymbolicLink(),
      false,
      'the pre-seeded REAL skill dir must NOT have become a symlink after the refused deliver'
    );
    assert.strictEqual(
      fs.readFileSync(path.join(realKeepDir, 'SKILL.md'), 'utf8'),
      realKeepBytes,
      'the pre-seeded REAL skill SKILL.md bytes must be intact after the refused deliver'
    );

    // Clear the collision and deliver cleanly into a fresh sandbox skillsDir — assert the dir-symlink
    // form (lstat().isSymbolicLink(), readlink → bundle, statSync follows to a dir with byte-identical
    // SKILL.md).
    fs.rmSync(skillsDir, { recursive: true, force: true });
    const delivered = drv.deliverBundledSkills({ bundleDir: BUNDLE_DIR, skillsDir });
    assert.strictEqual(delivered.names.length, EXPECTED_STEMS.length, 'deliver must materialize exactly the 2 bundled skills');

    for (const stem of EXPECTED_STEMS) {
      const target = path.join(skillsDir, stem);
      const absSource = path.join(BUNDLE_DIR, 'skills', stem);
      const canonicalSkill = path.join(CANONICAL_SKILLS_DIR, stem, 'SKILL.md');

      const st = fs.lstatSync(target);
      assert.ok(
        st.isSymbolicLink(),
        stem + ' must materialize as a DIRECTORY SYMLINK at <sandbox>/.claude/skills/' + stem +
          ' (local-parity form, mirrors install.sh ln -sfn — not a copy)'
      );
      assert.strictEqual(
        fs.readlinkSync(target),
        absSource,
        stem + ' symlink must resolve INTO the bundle (<BUNDLE>/skills/' + stem +
          ') — a remote-installed bundle is self-sufficient (T-17-02-REPOSOURCE)'
      );
      assert.ok(fs.statSync(target).isDirectory(), stem + ' followed symlink must be a directory');
      const linkedSkill = path.join(target, 'SKILL.md');
      assert.ok(fs.existsSync(linkedSkill), stem + '/SKILL.md must be reachable through the dir symlink');
      assert.ok(
        fs.readFileSync(linkedSkill).equals(fs.readFileSync(canonicalSkill)),
        'delivered ' + stem + '/SKILL.md must be byte-identical to the canonical skills/' + stem + '/SKILL.md'
      );
    }

    // ── RECLAIM ── reclaim reclaims EXACTLY the 2 bundle dir-symlinks; the bundle's real SKILL.md
    // survives (the LINK was unlinked, never recursed into).
    const reclaimed = drv.removeBundledSkills({ bundleDir: BUNDLE_DIR, skillsDir });
    assert.strictEqual(
      reclaimed.removed,
      EXPECTED_STEMS.length,
      'removeBundledSkills must reclaim EXACTLY the 2 delivered skill links (only dir-symlinks into our bundle)'
    );
    for (const stem of EXPECTED_STEMS) {
      assert.ok(!fs.existsSync(path.join(skillsDir, stem)), stem + ' link must be reclaimed by removeBundledSkills');
      // CRITICAL: the unlink removed the LINK only — the bundle's real SKILL.md still exists.
      assert.ok(
        fs.existsSync(path.join(BUNDLE_DIR, 'skills', stem, 'SKILL.md')),
        stem + ' bundle SKILL.md must SURVIVE reclaim (the link was unlinked, never recursed into / deleted)'
      );
    }
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test('removeBundledSkills leaves a pre-seeded REAL skill dir at a target untouched (T-17-02-OVERREMOVE on a directory symlink)', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-driver-skills-overremove-'));
  try {
    const skillsDir = path.join(sandbox, '.claude', 'skills');
    const stem = EXPECTED_STEMS[0];
    const realTarget = path.join(skillsDir, stem);
    fs.mkdirSync(realTarget, { recursive: true });
    const REAL_BODY = '# a real skill dir at a bundle-stem target — remove must leave it\n';
    fs.writeFileSync(path.join(realTarget, 'SKILL.md'), REAL_BODY, 'utf8');

    const rm = drv.removeBundledSkills({ bundleDir: BUNDLE_DIR, skillsDir });
    assert.strictEqual(rm.removed, 0, 'removeBundledSkills must reclaim NOTHING (a real dir is not ours)');
    assert.strictEqual(fs.existsSync(realTarget), true, 'the real skill dir must SURVIVE remove (T-17-02-OVERREMOVE)');
    assert.strictEqual(fs.lstatSync(realTarget).isSymbolicLink(), false, 'the real skill dir must NOT have become a symlink');
    assert.strictEqual(fs.readFileSync(path.join(realTarget, 'SKILL.md'), 'utf8'), REAL_BODY, 'the real SKILL.md must be byte-intact after remove');
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

// ──────────────────────────── END-TO-END runInstall→runRemove (SKIP-on-unreachable) ────────────────────────────
//
// Drives the FULL runInstall→runRemove against a disposable sandbox gsd-core checkout, proving the 2
// skills land ALONGSIDE the 5 commands + 16 wired hook entries via the SAME composed LIVE engine, and runRemove
// reclaims the skill links. SKIPs-with-note when no LIVE gsd-core checkout is reachable.

const ENGINE_LIB_REL = path.join('gsd-core', 'bin', 'lib');
const SETTINGS_REL = path.join('.claude', 'settings.json');
const E2E_SOURCE_ROOT = drv.resolveGsdCoreCwd() || null;
const E2E_SKIP_NOTE =
  'no LIVE gsd-core checkout reachable (set GSD_CORE_ROOT, or use ~/repos/gsd-core | ~/gsd-core) — ' +
  'the end-to-end runInstall/runRemove skill-delivery half SKIPPED (env limitation; never a false ' +
  'green when the engine is unreachable; the direct dir-symlink delivery + safety cases still run)';
const E2E_SKIP = E2E_SOURCE_ROOT ? false : E2E_SKIP_NOTE;

/**
 * Build a DISPOSABLE mkdtemp sandbox that resolves to itself as a gsd-core root (sentinel layout),
 * SYMLINKS the LIVE engine lib (read-only require), pre-seeds a writable settings.json + config.json,
 * a sandbox GSD_HOME (consent/ledger), and sandbox CLAUDE_DIR commands + skills dirs — so EVERY
 * driver write is confined to the sandbox and NOTHING touches the real gsd-core / ~/.claude.
 */
function makeE2ESandbox(sourceRoot) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-e2e-skills-'));
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'gsd-core', 'bin'), { recursive: true });
  // Post-RES-02, hasSentinel additionally requires a LIVE gsd-core identity script under scripts/
  // (D-05: a faithful checkout fixture still resolves) — an empty stub suffices (existence-only probe).
  fs.writeFileSync(path.join(root, 'scripts', 'issue-version-gate.cjs'), '// gsd-core identity stub (RES-02 sentinel)\n', 'utf8');
  fs.symlinkSync(path.join(sourceRoot, ENGINE_LIB_REL), path.join(root, ENGINE_LIB_REL), 'dir');

  const settingsPath = path.join(root, SETTINGS_REL);
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify({}, null, 2) + '\n', 'utf8');
  fs.mkdirSync(path.join(root, '.planning'), { recursive: true });
  fs.writeFileSync(path.join(root, '.planning', 'config.json'), JSON.stringify({}, null, 2) + '\n', 'utf8');

  const gsdHome = path.join(root, '.gsdhome');
  fs.mkdirSync(gsdHome, { recursive: true });
  const commandsDir = path.join(root, '.claude-runtime', 'commands');
  const skillsDir = path.join(root, '.claude-runtime', 'skills');

  function dispose() {
    fs.rmSync(root, { recursive: true, force: true });
  }
  return { root, gsdHome, commandsDir, skillsDir, settingsPath, dispose };
}

test(
  'end-to-end: runInstall delivers the 2 skills (alongside the 5 commands + 16 wired hook entries) + runRemove reclaims the skill links',
  { skip: E2E_SKIP },
  () => {
    const sb = makeE2ESandbox(E2E_SOURCE_ROOT);
    try {
      // Sanity: the sandbox resolves to ITSELF (never walks up to the real checkout) — TOCTOU guard.
      assert.strictEqual(resolveGsdCoreRoot(sb.root), sb.root, 'sandbox must resolve to itself as a gsd-core root');

      const opts = { liveRoot: sb.root, consentHome: sb.gsdHome, commandsDir: sb.commandsDir, skillsDir: sb.skillsDir };

      // runInstall composes the LIVE consent/ledger/shared-edit install THEN delivers commands + skills.
      const installed = drv.runInstall(opts);
      assert.ok(
        installed.deliveredSkills && installed.deliveredSkills.names.length === EXPECTED_STEMS.length,
        'runInstall must deliver the 2 skills alongside the LIVE consent/ledger/shared-edit install'
      );

      // ON-DISK: the 2 skills materialized at the runtime skills dir as bundle DIRECTORY symlinks.
      for (const stem of EXPECTED_STEMS) {
        const target = path.join(sb.skillsDir, stem);
        const st = fs.lstatSync(target);
        assert.ok(st.isSymbolicLink(), 'runInstall must materialize ' + stem + ' as a dir symlink in the runtime skills dir');
        assert.strictEqual(
          fs.readlinkSync(target),
          path.join(BUNDLE_DIR, 'skills', stem),
          stem + ' must resolve into the bundle (self-sufficient remote install)'
        );
        assert.ok(fs.existsSync(path.join(target, 'SKILL.md')), stem + '/SKILL.md reachable through the dir symlink');
      }

      // Co-existence proof: the 2 skills land ALONGSIDE the 16 marker-tagged hook entries + the 5 commands.
      const settings = JSON.parse(fs.readFileSync(path.join(sb.root, SETTINGS_REL), 'utf8'));
      const taggedHooks = Object.keys(settings.hooks || {}).reduce((n, ev) => {
        return n + (Array.isArray(settings.hooks[ev]) ? settings.hooks[ev].filter((e) => e && e._gsdCapability === CAP_ID).length : 0);
      }, 0);
      assert.strictEqual(taggedHooks, 16, 'the 2 skills must land ALONGSIDE the 16 marker-tagged hook entries (full local-parity install)');
      for (const base of ['gsd-submit', 'gsd-review-sweep', 'gsd-triage-assist', 'gsd-release-preflight', 'gsd-ruleset-drift']) {
        assert.ok(fs.existsSync(path.join(sb.commandsDir, base + '.md')), 'the 2 skills must land ALONGSIDE the 5 commands (' + base + '.md present)');
      }

      // runRemove reclaims the 2 skill links (accountable — under the LIVE remove receipt).
      const removed = drv.runRemove(Object.assign({ reason: '21-03 end-to-end skill-reclaim proof' }, opts));
      assert.ok(
        removed.reclaimedSkills && removed.reclaimedSkills.removed === EXPECTED_STEMS.length,
        'runRemove must reclaim EXACTLY the 2 delivered skill links'
      );
      for (const stem of EXPECTED_STEMS) {
        assert.ok(!fs.existsSync(path.join(sb.skillsDir, stem)), stem + ' must be reclaimed by runRemove');
      }
    } finally {
      sb.dispose();
    }
  }
);
