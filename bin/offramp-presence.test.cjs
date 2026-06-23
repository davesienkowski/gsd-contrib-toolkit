'use strict';

/**
 * bin/offramp-presence.test.cjs — the FLOW-01 Recovery Offramp presence/consistency proof.
 *
 * Phase 19 adds a model-driven "Recovery Offramp" to the three contribution surfaces (the
 * gsd-core-contribution skill + the gsd-submit and gsd-review-sweep commands): on a contribution-gate
 * DENY (or a skill-surfaced real blocking issue) the contributor is offered two tracked recovery paths —
 * fix inline with /gsd-quick, or route through the GSD pipeline (/gsd-debug, or
 * /gsd-discuss-phase -> /gsd-plan-phase -> /gsd-execute-phase) — instead of a bare dead-stop. The deny
 * stays fail-closed/unbypassable and the offramp is ADVISORY: it NEVER suggests bypassing the gate or
 * abusing GSD_CONTRIB_OVERRIDE to dodge a real failure.
 *
 * This test asserts the offramp is PRESENT and CONSISTENT across all SIX copies — the 3 CANONICAL
 * surfaces under the repo root AND their 3 BUNDLED copies under capabilities/contribution-toolkit/ —
 * so a remote install reproduces the local offramp experience, and so the offramp's load-bearing
 * no-bypass disclaimer cannot silently drop from any surface.
 *
 * For each of the 6 copies it asserts:
 *   - the case-sensitive marker "Recovery Offramp" is present;
 *   - the inline path /gsd-quick is named;
 *   - a pipeline path is named (at least one of /gsd-debug, /gsd-discuss-phase, /gsd-plan-phase,
 *     /gsd-execute-phase);
 *   - a fail-closed/advisory cue is present (case-insensitive "fail-closed" OR "advisory");
 *   - the no-bypass cue is present (case-insensitive "GSD_CONTRIB_OVERRIDE" OR a "never ... bypass"
 *     phrasing) — this is the T-19-01 social-engineering-bypass mitigation.
 * It then asserts each BUNDLED copy is BYTE-IDENTICAL to its canonical source — an in-test parity guard
 * against a hand-edited or stale bundle (build --check covers it too; this makes the parity a named,
 * self-test-tracked invariant).
 *
 * HEADER-PROSE SELF-INVALIDATION NOTE: this file's own header mentions the asserted tokens, so the test
 * deliberately reads the SURFACE files (never itself) — there is no grep-count gate over this file.
 *
 * Pure node:test/node:fs over in-repo surfaces — no network, no mutation, no package install.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const BUNDLE_DIR = path.join(REPO_ROOT, 'capabilities', 'contribution-toolkit');

// The three contribution surfaces, as repo-relative paths so BOTH the canonical root and the bundle
// root are checked from the same list.
const SURFACES = Object.freeze([
  'skills/gsd-core-contribution/SKILL.md',
  'commands/gsd-submit.md',
  'commands/gsd-review-sweep.md',
]);

const PIPELINE_PATHS = ['/gsd-debug', '/gsd-discuss-phase', '/gsd-plan-phase', '/gsd-execute-phase'];

function assertOfframpPresent(label, body) {
  const lower = body.toLowerCase();

  assert.ok(
    body.includes('Recovery Offramp'),
    label + ' must contain the case-sensitive marker "Recovery Offramp"'
  );
  assert.ok(
    body.includes('/gsd-quick'),
    label + ' must name the inline recovery path /gsd-quick'
  );
  assert.ok(
    PIPELINE_PATHS.some((p) => body.includes(p)),
    label + ' must name at least one pipeline recovery path (' + PIPELINE_PATHS.join(', ') + ')'
  );
  assert.ok(
    lower.includes('fail-closed') || lower.includes('advisory'),
    label + ' must carry a fail-closed/advisory cue (the deny stays load-bearing; the offramp is advisory)'
  );
  assert.ok(
    lower.includes('gsd_contrib_override') || /never\b[\s\S]{0,80}\bbypass/.test(lower),
    label + ' must carry the no-bypass cue (T-19-01): name GSD_CONTRIB_OVERRIDE or state it NEVER bypasses the gate'
  );
}

for (const rel of SURFACES) {
  test('Recovery Offramp present + consistent in canonical + bundled: ' + rel, () => {
    const canonicalPath = path.join(REPO_ROOT, rel);
    const bundledPath = path.join(BUNDLE_DIR, rel);

    const canonical = fs.readFileSync(canonicalPath);
    const bundled = fs.readFileSync(bundledPath);

    assertOfframpPresent('canonical ' + rel, canonical.toString('utf8'));
    assertOfframpPresent('bundled capabilities/contribution-toolkit/' + rel, bundled.toString('utf8'));

    assert.ok(
      canonical.equals(bundled),
      'the bundled copy of ' + rel + ' must be BYTE-IDENTICAL to its canonical source ' +
        '(a stale or hand-edited bundle would drift the shipped offramp from canonical)'
    );
  });
}
