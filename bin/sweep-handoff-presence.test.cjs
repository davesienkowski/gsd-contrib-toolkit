'use strict';

/**
 * bin/sweep-handoff-presence.test.cjs — the D-01/D-02/D-03 "Authoring hand-off" seam proof.
 *
 * The toolkit's two skills are complementary halves: `maintainer-review-sweep` ADJUDICATES others'
 * work, `gsd-core-contribution` AUTHORS your own. Each declares the other out of scope, but until
 * this seam existed neither declared what happens at the MOMENT the sweep stops adjudicating and
 * starts authoring — writing a fix triage surfaced, pushing a correction to a stalled PR, filing a
 * follow-up issue. That fell through the gap and got done ad-hoc, outside the gated P0–P6 pipeline.
 *
 * The seam has three parts, and this test asserts all three are PRESENT and CONSISTENT:
 *   1. a ROUTING RULE on the sweep side (skill + command surfaces) pointing at /gsd-submit;
 *   2. a named HAND-OFF PACKET enumerating what crosses, so the contribution path's P0/P1 does not
 *      re-derive from scratch;
 *   3. a REVERSE LINK on the contribution side acknowledging sweep-originated entry.
 *
 * HONESTY INVARIANT (D-03, threat T-u5q-05): the routing rule is MODEL-DRIVEN/ADVISORY and adds no
 * hook. The hard floor is the pre-existing fail-closed ENF-21 PreToolUse deny. The advisory cue and
 * the not-new-enforcement cue are therefore asserted INSIDE the hand-off section on every surface —
 * not merely somewhere in the file — so the caveat cannot silently drop from the very block that
 * would otherwise read as permission.
 *
 * SECTION-SCOPED, DELIBERATELY: every content assertion below runs against the extracted hand-off
 * SECTION, never the whole file. Both sweep surfaces already say "advisory", "fail-closed", "RT0",
 * "not run", "ball-in-court" and "scope fence" elsewhere for unrelated reasons, so a whole-file
 * substring check would be green before the section was written — the vacuous/pass-always trap this
 * repo's own review skill calls out. Scoping is what makes these assertions load-bearing.
 *
 * ELEVATION-OF-PRIVILEGE INVARIANT (threat T-u5q-01): the reverse link must NOT weaken the gate it
 * sits beside. Test 9 asserts the P1 checklist line and its `[GATE: reproduced, else WITHDRAW]`
 * condition survive VERBATIM. That is a PRESERVATION assertion — it is green from the start by
 * design, and it is green because the existing text was not edited, not because anything new was
 * added. If it ever goes red, inherited sweep evidence has been allowed to stand in for a live
 * reproduction, which is exactly the failure this seam must never enable.
 *
 * Each bundled copy is finally asserted BYTE-IDENTICAL to its canonical source, so a remote install
 * reproduces the seam and a hand-edited or stale bundle fails here as a named invariant rather than
 * only via `build-capability --check`.
 *
 * HEADER-PROSE SELF-INVALIDATION NOTE: this file's own header mentions the asserted tokens, so the
 * test deliberately reads the SURFACE files (never itself) — there is no grep-count gate over it.
 *
 * Pure node:test/node:fs over in-repo surfaces — no network, no mutation, no package install.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const BUNDLE_DIR = path.join(REPO_ROOT, 'capabilities', 'contribution-toolkit');

// The case-sensitive marker that opens the seam on every surface.
const MARKER = 'Authoring hand-off';

// Bounded window for surfaces that carry the hand-off as a paragraph rather than a `## ` section
// (the command surface has no subsequent `## ` heading to bound against). Bounded on purpose —
// an unbounded [\s\S]* would re-admit the whole-file vacuity this test exists to avoid.
const MAX_SECTION_CHARS = 2400;

// The sweep surfaces carrying the routing rule (D-02: both the skill AND the command layer, because
// the command fires at invocation BEFORE the skill loads).
const SWEEP_SURFACES = Object.freeze([
  'skills/maintainer-review-sweep/SKILL.md',
  'commands/gsd-review-sweep.md',
]);

// The surface that must enumerate the full packet (the command layer deliberately stays short — it
// points at this one).
const PACKET_SURFACE = 'skills/maintainer-review-sweep/SKILL.md';

// The receiving half of the seam — the contribution skill, which must acknowledge sweep-originated
// entry WITHOUT weakening the gate that entry passes through.
const CONTRIBUTION_SURFACE = 'skills/gsd-core-contribution/SKILL.md';

// The P1 gate text that must survive VERBATIM (threat T-u5q-01). Both fragments are pre-existing;
// see the preservation note on the test below.
const P1_GATE_CONDITION = '[GATE: reproduced, else WITHDRAW]';
const P1_LIVE_REPRO = 'reproduce the mechanism live';

// The six hand-off packet anchors (D-01). Case-insensitive; asserted inside the section only.
const PACKET_ANCHORS = Object.freeze([
  { label: 'the issue/PR number cue', re: /#\s*numbers?\b/i },
  { label: 'the "not run" honesty-of-evidence cue', re: /not run/i },
  { label: 'the quoted-ADR/design-record cue', re: /quote/i },
  { label: 'the RT0 runtime-freshness verdict', re: /\bRT0\b/i },
  { label: 'the ball-in-court finding', re: /ball-in-court/i },
  { label: 'the scope fence', re: /scope fence/i },
]);

/**
 * Extract the hand-off section: from the section's OWN opening to the next `## ` heading, or to a
 * bounded character budget when no such heading follows.
 *
 * The opening is resolved by preference — the `## ` heading form (the skill surface), then the
 * bolded lead-in form (the command surface), and only then a bare marker hit. That ordering is
 * load-bearing: cross-references elsewhere in the file link to this section by its own name, so a
 * naive first-hit would anchor the window on a link's label and read the wrong block.
 */
function resolveSectionStart(body) {
  const headingIdx = body.indexOf('## ' + MARKER);
  if (headingIdx !== -1) return headingIdx;

  const boldIdx = body.indexOf('**' + MARKER);
  if (boldIdx !== -1) return boldIdx;

  return body.indexOf(MARKER);
}

function extractHandoffSection(label, body) {
  assert.ok(
    body.includes(MARKER),
    label + ' must contain the case-sensitive marker "' + MARKER + '"'
  );

  const rest = body.slice(resolveSectionStart(body));
  const nextHeading = rest.indexOf('\n## ');
  const end = nextHeading === -1 ? MAX_SECTION_CHARS : Math.min(nextHeading, MAX_SECTION_CHARS);
  return rest.slice(0, end);
}

function assertHandoffPresent(label, body, { requirePacket }) {
  const section = extractHandoffSection(label, body);
  const lower = section.toLowerCase();

  // Test 2 — the destination is named.
  assert.ok(
    section.includes('/gsd-submit'),
    label + ' hand-off section must name the destination /gsd-submit (route to the gated pipeline, ' +
      'not to a bare gh issue create)'
  );

  // Test 3 — the advisory cue (D-03): this is model-driven routing, not enforcement.
  assert.ok(
    lower.includes('model-driven') || lower.includes('advisory'),
    label + ' hand-off section must carry the model-driven/advisory cue — the routing rule is not ' +
      'enforcement and must never read as if it were'
  );

  // Test 4 — the not-new-enforcement cue: the hard floor is the pre-existing fail-closed deny.
  assert.ok(
    lower.includes('fail-closed') || /never\b[\s\S]{0,120}\bbypass/.test(lower),
    label + ' hand-off section must name the fail-closed floor (or state it NEVER bypasses the gate) ' +
      '— the ENF-21 deny is what actually stops a broken submission, not this rule'
  );

  // Test 5 — the packet is enumerated (skill surface only).
  if (requirePacket) {
    for (const anchor of PACKET_ANCHORS) {
      assert.ok(
        anchor.re.test(section),
        label + ' hand-off section must enumerate ' + anchor.label + ' as part of the packet ' +
          '(so the contribution path\'s P0/P1 does not re-derive it from scratch)'
      );
    }
  }
}

for (const rel of SWEEP_SURFACES) {
  test('Authoring hand-off routing rule present + consistent in canonical + bundled: ' + rel, () => {
    const canonicalPath = path.join(REPO_ROOT, rel);
    const bundledPath = path.join(BUNDLE_DIR, rel);

    const canonical = fs.readFileSync(canonicalPath);
    const bundled = fs.readFileSync(bundledPath);

    const requirePacket = rel === PACKET_SURFACE;

    assertHandoffPresent('canonical ' + rel, canonical.toString('utf8'), { requirePacket });
    assertHandoffPresent(
      'bundled capabilities/contribution-toolkit/' + rel,
      bundled.toString('utf8'),
      { requirePacket }
    );

    // Test 6 — byte-identity, as a named invariant.
    assert.ok(
      canonical.equals(bundled),
      'the bundled copy of ' + rel + ' must be BYTE-IDENTICAL to its canonical source ' +
        '(a stale or hand-edited bundle would ship a different routing rule than the reviewed one)'
    );
  });
}

/**
 * The receiving half: the contribution skill acknowledges a sweep-originated entrant, and does so
 * WITHOUT weakening P1. Both halves of that sentence are asserted here.
 */
function assertReverseLinkPresent(label, body) {
  const section = extractHandoffSection(label, body);
  const sectionLower = section.toLowerCase();

  // Test 7 — the reverse link names the other half of the seam, in an arriving-from-a-sweep context.
  assert.ok(
    section.includes('maintainer-review-sweep'),
    label + ' hand-off section must name `maintainer-review-sweep` — the entrant needs to recognise ' +
      'which path they arrived from'
  );
  assert.ok(
    sectionLower.includes('sweep'),
    label + ' hand-off section must frame this as arriving FROM a sweep'
  );

  // Test 8 — the not-a-substitute cue: inherited evidence is an INPUT to P1, never a replacement.
  // Asserted inside the section (not merely somewhere in the file) so the boundary sits with the
  // prose that would otherwise read as permission to skip P1.
  assert.ok(
    /never a substitute|not a substitute/i.test(section),
    label + ' hand-off section must state that inherited sweep evidence is NEVER A SUBSTITUTE for ' +
      'P1 — it narrows what you must reproduce, it never discharges the obligation to reproduce it'
  );
}

test(
  'reverse link present + P1 gate preserved in canonical + bundled: ' + CONTRIBUTION_SURFACE,
  () => {
    const canonicalPath = path.join(REPO_ROOT, CONTRIBUTION_SURFACE);
    const bundledPath = path.join(BUNDLE_DIR, CONTRIBUTION_SURFACE);

    const canonical = fs.readFileSync(canonicalPath);
    const bundled = fs.readFileSync(bundledPath);

    const canonicalText = canonical.toString('utf8');

    assertReverseLinkPresent('canonical ' + CONTRIBUTION_SURFACE, canonicalText);
    assertReverseLinkPresent(
      'bundled capabilities/contribution-toolkit/' + CONTRIBUTION_SURFACE,
      bundled.toString('utf8')
    );

    // Test 9 — PRESERVATION ASSERTION, not a new requirement. This text pre-dates the seam and was
    // deliberately NOT edited; the assertion is green from the start precisely because the reverse
    // link sits BESIDE the gate rather than inside it. It goes red only if a future edit softens P1
    // into something inherited sweep evidence could satisfy — the elevation-of-privilege failure
    // (T-u5q-01) this whole seam must never enable.
    assert.ok(
      canonicalText.includes(P1_GATE_CONDITION),
      CONTRIBUTION_SURFACE + ' must still carry the verbatim P1 gate condition "' +
        P1_GATE_CONDITION + '" — the reverse link must not weaken it'
    );

    const p1Line = canonicalText
      .split('\n')
      .find((line) => line.includes('P1') && line.includes(P1_GATE_CONDITION));
    assert.ok(
      p1Line && p1Line.includes(P1_LIVE_REPRO),
      'the P1 checklist line must still require you to "' + P1_LIVE_REPRO +
        '" — inherited evidence is an input to that reproduction, never a replacement for it'
    );

    // Test 10 — byte-identity.
    assert.ok(
      canonical.equals(bundled),
      'the bundled copy of ' + CONTRIBUTION_SURFACE + ' must be BYTE-IDENTICAL to its canonical source'
    );
  }
);
