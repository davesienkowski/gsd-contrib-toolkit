'use strict';

/**
 * bin/advisory-banner-presence.test.cjs — the RUN-02 advisory-degradation banner presence/parity proof.
 *
 * Phase 22 (RUN-02) adds a static, copy-convert-surviving advisory-degradation SECTION to BOTH canonical
 * skills' SKILL.md (core-contribution + maintainer-review-sweep): "PreToolUse enforcement is a Claude
 * Code harness feature. On non-Claude runtimes (Codex, OpenCode, …) this toolkit runs advisory-only — the
 * gates are not enforced; treat its guidance as advice, not a hard block." Because it is STATIC SKILL.md
 * content it survives the native copy-convert into non-Claude dialects, so a non-Claude install surfaces it
 * to the agent/user. This is the load-bearing honesty banner for cross-runtime delivery.
 *
 * This test asserts the advisory section is PRESENT in all FOUR SKILL.md surfaces — the 2 CANONICAL skills
 * under the repo root AND their 2 BUNDLED copies under capabilities/contribution-toolkit/skills/ — so a
 * remote/native install reproduces the local advisory experience, and so the banner cannot silently drop
 * from any surface. For each of the 4 copies it asserts:
 *   - the case-sensitive heading marker "Advisory-only on non-Claude runtimes" is present;
 *   - the body cue "advisory-only" is present (case-insensitive);
 *   - a Claude-scoping cue is present (case-insensitive "Claude" AND "PreToolUse") so the section honestly
 *     scopes enforcement to the Claude harness feature;
 *   - the advisory SECTION does NOT contain "unbypassable" (case-insensitive) — the load-bearing honesty
 *     guard. (Scoped to the advisory section, NOT the whole file: the contribution skill legitimately
 *     uses "unbypassable" elsewhere to describe the gsd-core fail-closed deny / POLICY-02 floor — those
 *     describe the gate, not this capability, and do not trip verify-capability's isOversold regex.)
 * It then asserts each BUNDLED SKILL.md is BYTE-IDENTICAL to its canonical source — an in-test parity guard
 * (mirroring offramp-presence's byte-parity assertion) proving the advisory section survives the bundle
 * regen unchanged, the precondition for it surviving copy-convert to non-Claude runtimes.
 *
 * It ALSO asserts the SECONDARY Claude-side driver honesty line: runInstall / runOn / runStatus each push
 * a line stating the PreToolUse enforcement applies on Claude only / advisory-only elsewhere. That part
 * runs the driver lifecycle on a DISPOSABLE mkdtemp sandbox (exactly as bin/contrib-capability.test.cjs
 * does) and SKIPs-with-note when no live gsd-core checkout is reachable — never mutating the real
 * ~/.claude or gsd-core state, never fabricating a sentinel layout.
 *
 * HEADER-PROSE SELF-INVALIDATION NOTE: this file's own header mentions the asserted tokens (including
 * "unbypassable"), so the test deliberately reads the SURFACE files (never itself) — there is no
 * grep-count gate over this file.
 *
 * Pure node:test/node:fs over in-repo surfaces + a disposable mkdtemp sandbox for the driver lifecycle —
 * no network, no package install, no real-state mutation.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const BUNDLE_DIR = path.join(REPO_ROOT, 'capabilities', 'contribution-toolkit');

// The two skill SKILL.md surfaces, as repo-relative paths so BOTH the canonical root and the bundle
// root are checked from the same list.
const SKILL_SURFACES = Object.freeze([
  'skills/core-contribution/SKILL.md',
  'skills/maintainer-review-sweep/SKILL.md',
]);

// The exact heading marker (case-sensitive) so the banner heading is stable across all surfaces.
const HEADING_MARKER = 'Advisory-only on non-Claude runtimes';

/**
 * Extract JUST the advisory-degradation section body — from the `## Advisory-only on non-Claude runtimes`
 * heading up to (but not including) the next top-level `## ` heading. The `! unbypassable` honesty guard
 * is scoped to THIS section, not the whole file: the contribution skill legitimately uses "unbypassable"
 * elsewhere to describe the gsd-core fail-closed deny / POLICY-02 floor (those describe the GATE, not
 * THIS capability — they do not trip verify-capability's isOversold regex).
 */
function extractAdvisorySection(body) {
  const lines = body.split('\n');
  const start = lines.findIndex((l) => l.startsWith('## ') && l.includes(HEADING_MARKER));
  if (start === -1) return '';
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith('## ')) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

function assertAdvisoryPresent(label, body) {
  assert.ok(
    body.includes('## ' + HEADING_MARKER),
    label + ' must contain the case-sensitive heading marker "## ' + HEADING_MARKER + '"'
  );

  const section = extractAdvisorySection(body);
  const sectionLower = section.toLowerCase();

  assert.ok(
    sectionLower.includes('advisory-only'),
    label + ' advisory section must carry the advisory-only body cue (the toolkit runs advisory-only off-Claude)'
  );
  assert.ok(
    sectionLower.includes('claude') && sectionLower.includes('pretooluse'),
    label + ' advisory section must carry the Claude/PreToolUse scoping cue (enforcement is a Claude harness feature)'
  );
  assert.ok(
    !sectionLower.includes('unbypassable'),
    label + ' advisory section must NEVER claim "unbypassable" (the load-bearing honesty guard)'
  );
}

for (const rel of SKILL_SURFACES) {
  test('Advisory banner present + byte-identical in canonical + bundled: ' + rel, () => {
    const canonicalPath = path.join(REPO_ROOT, rel);
    const bundledPath = path.join(BUNDLE_DIR, rel);

    const canonical = fs.readFileSync(canonicalPath);
    const bundled = fs.readFileSync(bundledPath);

    assertAdvisoryPresent('canonical ' + rel, canonical.toString('utf8'));
    assertAdvisoryPresent('bundled capabilities/contribution-toolkit/' + rel, bundled.toString('utf8'));

    assert.ok(
      canonical.equals(bundled),
      'the bundled copy of ' + rel + ' must be BYTE-IDENTICAL to its canonical source ' +
        '(byte-parity is the precondition for the advisory banner surviving copy-convert to non-Claude runtimes)'
    );
  });
}

// ───────────────────────── the secondary Claude-side driver honesty line ─────────────────────────
//
// Run the driver lifecycle on a DISPOSABLE mkdtemp sandbox (sentinel layout so resolveGsdCoreRoot(root)
// === root; LIVE engine lib symlinked read-only; every WRITE confined to the sandbox via injected
// liveRoot/consentHome/commandsDir/skillsDir). SKIP-with-note when no live gsd-core checkout is reachable
// — never fabricate a fake sentinel layout, never mutate real ~/.claude or gsd-core state.

const drv = require('./contrib-capability.cjs');
const { resolveGsdCoreRoot } = require('../hooks/lib/resolve.cjs');

const SETTINGS_REL = path.join('.claude', 'settings.json');
const ENGINE_LIB_REL = path.join('gsd-core', 'bin', 'lib');

const SOURCE_ROOT = drv.resolveGsdCoreCwd() || null;
const SKIP_NOTE =
  'no real gsd-core source reachable (set GSD_CORE_ROOT, or use ~/repos/gsd-core | ~/gsd-core) — ' +
  'driver honesty-line lifecycle SKIPPED (env limitation; never fabricate a fake sentinel layout)';
const SKIP = SOURCE_ROOT ? false : SKIP_NOTE;

/**
 * Build a DISPOSABLE mkdtemp sandbox that resolves to itself as a gsd-core root, symlinks the LIVE engine
 * lib (read-only), and pre-seeds a writable settings.json + .planning/config.json so the lifecycle writes
 * target the sandbox. Mirrors makeCapSandbox in bin/contrib-capability.test.cjs (kept minimal here — the
 * helpers are module-local there, so this file carries its own tiny copy rather than coupling the suites).
 */
function makeBannerSandbox(sourceRoot) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-banner-'));
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'gsd-core', 'bin'), { recursive: true });
  // Post-RES-02, hasSentinel additionally requires a LIVE gsd-core identity script under scripts/
  // (D-05: a faithful checkout fixture still resolves) — an empty stub suffices (existence-only probe).
  fs.writeFileSync(path.join(root, 'scripts', 'issue-version-gate.cjs'), '// gsd-core identity stub (RES-02 sentinel)\n', 'utf8');
  fs.symlinkSync(path.join(sourceRoot, ENGINE_LIB_REL), path.join(root, ENGINE_LIB_REL), 'dir');

  const settingsPath = path.join(root, SETTINGS_REL);
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(
    settingsPath,
    JSON.stringify(
      {
        hooks: {
          PreToolUse: [
            {
              matcher: 'Bash',
              _userOwned: true,
              hooks: [{ type: 'command', command: 'echo pre-existing-user-hook' }],
            },
          ],
        },
      },
      null,
      2
    ) + '\n',
    'utf8'
  );

  fs.mkdirSync(path.join(root, '.planning'), { recursive: true });
  fs.writeFileSync(path.join(root, '.planning', 'config.json'), JSON.stringify({}, null, 2) + '\n', 'utf8');

  const gsdHome = path.join(root, '.gsdhome');
  fs.mkdirSync(gsdHome, { recursive: true });
  const commandsDir = path.join(root, '.claude-runtime', 'commands');
  const skillsDir = path.join(root, '.claude-runtime', 'skills');

  function dispose() {
    fs.rmSync(root, { recursive: true, force: true });
  }
  return { root, gsdHome, commandsDir, skillsDir, dispose };
}

function sandboxOpts(sb) {
  return { liveRoot: sb.root, consentHome: sb.gsdHome, commandsDir: sb.commandsDir, skillsDir: sb.skillsDir };
}

// The honesty-line cue: a line that mentions enforcement applies on Claude only AND that it runs
// advisory-only elsewhere — case-insensitive over the returned lines[].
function hasHonestyLine(lines) {
  return lines.some((l) => {
    const lower = String(l).toLowerCase();
    return lower.includes('claude') && lower.includes('advisory-only');
  });
}

test('driver honesty line present in install/on/status output', { skip: SKIP }, () => {
  const sb = makeBannerSandbox(SOURCE_ROOT);
  try {
    assert.strictEqual(
      resolveGsdCoreRoot(sb.root),
      sb.root,
      'the sandbox must resolve to itself as a gsd-core root, not walk up to the real checkout'
    );

    const opts = sandboxOpts(sb);

    const install = drv.runInstall(opts);
    assert.ok(
      hasHonestyLine(install.lines),
      'runInstall output must carry the Claude-only-enforcement / advisory-only honesty line'
    );

    const on = drv.runOn(opts);
    assert.ok(
      hasHonestyLine(on.lines),
      'runOn output must carry the Claude-only-enforcement / advisory-only honesty line'
    );

    const status = drv.runStatus(opts);
    assert.ok(
      hasHonestyLine(status.lines),
      'runStatus output must carry the Claude-only-enforcement / advisory-only honesty line'
    );

    // The honesty line must NEVER over-claim "unbypassable" in any builder's output.
    for (const out of [install, on, status]) {
      for (const l of out.lines) {
        assert.ok(
          !String(l).toLowerCase().includes('unbypassable'),
          'driver output line must NEVER claim "unbypassable": ' + l
        );
      }
    }
  } finally {
    sb.dispose();
  }
});
