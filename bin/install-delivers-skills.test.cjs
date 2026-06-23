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
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { requireLiveScript } = require('../hooks/lib/resolve.cjs');

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
