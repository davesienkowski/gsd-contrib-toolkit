'use strict';

/**
 * bin/skills-projection-shape.test.cjs — the RUN-01 skills[] projection-SHAPE / REACHABILITY proof.
 *
 * RUN-01 (Phase 22) resolves that cross-runtime skill delivery to non-Claude runtimes (Codex,
 * OpenCode, …) is the NATIVE framework's job: stock `gsd capability install` projects the bundle's
 * declared `skills[]` contribution through the LIVE copy-convert pipeline into each runtime's dialect.
 * We REUSE that pipeline — we do NOT fork or reimplement copy-convert (Reuse-LIVE).
 *
 * This test proves the bundle manifest declares `skills[]` in the PROJECTION-SHAPED form that the
 * native copy-convert pipeline consumes — an array of plain single-segment stems, each backed by a
 * real bundle `skills/<stem>/SKILL.md` artifact the pipeline can materialize. That is the precondition
 * for native cross-runtime skill delivery: if the declared contribution is well-shaped and every stem
 * maps to a materializable artifact, non-Claude skill delivery is REACHABLE through the LIVE engine
 * with no fork.
 *
 * SCOPE: this is a SHAPE/REACHABILITY proof, NOT:
 *   - a re-test of byte-parity between canonical and bundle (build --check / verify-capability own that);
 *   - a re-implementation or test of copy-convert itself (Reuse-LIVE — the LIVE framework owns it).
 * It reads only IN-REPO bundle files — no live gsd-core checkout, no network, no mutation, no install.
 *
 * The stem-safety assertion mirrors the WR-01 guard in build-capability.cjs (plannedSkillFiles):
 * a stem containing '/', '\', '..', or an absolute path would steer materialization at an arbitrary
 * path, so a projection-shaped contribution must carry only safe single-segment stems.
 *
 * HEADER-PROSE SELF-INVALIDATION NOTE: this file's own header names the asserted tokens, so the test
 * reads the BUNDLE manifest (never itself) — there is no grep-count gate over this file.
 *
 * Pure node:test/node:fs over in-repo bundle surfaces.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const BUNDLE_DIR = path.join(REPO_ROOT, 'capabilities', 'contribution-toolkit');
const MANIFEST_PATH = path.join(BUNDLE_DIR, 'capability.json');
const BUNDLE_SKILLS_DIR = path.join(BUNDLE_DIR, 'skills');

// The known declared skills — a silent drop of either must fail loud.
const KNOWN_STEMS = Object.freeze(['core-contribution', 'maintainer-review-sweep']);

function readManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
}

// Mirrors build-capability.cjs WR-01: a projection-shaped stem must be a plain single-segment name.
function isUnsafeStem(stem) {
  return stem.includes('/') || stem.includes('\\') || stem.includes('..') || path.isAbsolute(stem);
}

test('skills[] is a non-empty array of strings (projection-shaped contribution)', () => {
  const manifest = readManifest();
  assert.ok(
    Array.isArray(manifest.skills),
    'manifest.skills must be an ARRAY (the projection-shaped contribution the native copy-convert consumes)'
  );
  assert.ok(
    manifest.skills.length > 0,
    'manifest.skills must be NON-EMPTY (no declared skills ⇒ nothing for the native pipeline to project)'
  );
  for (const stem of manifest.skills) {
    assert.strictEqual(
      typeof stem,
      'string',
      'every skills[] entry must be a STRING stem (an array of stems, not prose/objects), got: ' +
        JSON.stringify(stem)
    );
    assert.ok(stem.length > 0, 'skills[] must not contain an empty stem');
  }
});

test('every declared stem is a safe single-segment name (WR-01 mirror)', () => {
  const manifest = readManifest();
  for (const stem of manifest.skills) {
    assert.ok(
      !isUnsafeStem(stem),
      'declared skill stem must be a plain single-segment name (no "/", "\\", "..", or absolute path) ' +
        'so the copy-convert pipeline materializes it at a safe path — rejected: ' + JSON.stringify(stem)
    );
  }
});

test('every declared stem maps to a real bundle skills/<stem>/SKILL.md', () => {
  const manifest = readManifest();
  for (const stem of manifest.skills) {
    const skillMd = path.join(BUNDLE_SKILLS_DIR, stem, 'SKILL.md');
    assert.ok(
      fs.existsSync(skillMd) && fs.statSync(skillMd).isFile(),
      'declared stem "' + stem + '" must have a real bundle artifact at ' +
        'capabilities/contribution-toolkit/skills/' + stem + '/SKILL.md ' +
        '(the file the native copy-convert actually projects to non-Claude runtimes)'
    );
  }
});

test('both known stems are present (a silent drop of a declared skill fails loud)', () => {
  const manifest = readManifest();
  for (const known of KNOWN_STEMS) {
    assert.ok(
      manifest.skills.includes(known),
      'expected known skill stem "' + known + '" to be declared in manifest.skills'
    );
  }
});
