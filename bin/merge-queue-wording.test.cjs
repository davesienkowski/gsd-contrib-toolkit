'use strict';

/**
 * bin/merge-queue-wording.test.cjs - pins the merge-queue convention change (quick 261021-n2m,
 * CTK-ADR-0012) in the shipped skills, commands and guides.
 *
 * Why: open-gsd/gsd-core announced a GitHub merge queue on `next` (trek-e, 2026-10-21). The toolkit's
 * prose taught the rebase treadmill: an "approved+rebase" cost tier, BEHIND as a merge blocker, a
 * "needs rebase if BEHIND" label rule and a post-rebase hand-off. A later edit that restores any of
 * that, or drops the new authoring rules, should fail here rather than drift back silently.
 *
 * What this pins (canonical sources under skills/, commands/, docs/guides/; the bundle copies are
 * pinned byte-identical to these by bin/pr-status-prohibitions.test.cjs Q2 and the build check):
 *   1. the retired phrasings are gone: "approved+rebase", "not DIRTY or BEHIND", "needs rebase` if
 *      BEHIND" and the "Post-rebase handoff" step;
 *   2. the fix PR skeleton in core-contribution/reference.md carries a `## Self-test report` section
 *      with the five announced items, marked advisory;
 *   3. the no-push-after-approval rule and the rebase-only-for-DIRTY rule are in the contribution skill;
 *   4. the head.repo push-target rule is wherever the toolkit composes a push to an existing PR
 *      (reference.md, re-review.md, the sweep's authoring hand-off and the gsd-submit command);
 *   5. the sweep reads the live queue mode from pr-status rather than assuming it.
 *
 * @module bin/merge-queue-wording.test
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function walk(rel) {
  const out = [];
  for (const e of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
    const r = path.join(rel, e.name);
    if (e.isDirectory()) out.push(...walk(r));
    else if (e.name.endsWith('.md')) out.push(r);
  }
  return out;
}

/** The text from `start` to the next level-2 heading that sits OUTSIDE a code fence (the skeleton's own
 * headings are inside one). */
function sectionAt(text, start) {
  const lines = text.slice(start).split('\n');
  let fenced = false;
  for (let i = 1; i < lines.length; i += 1) {
    if (/^```/.test(lines[i])) fenced = !fenced;
    else if (!fenced && /^## /.test(lines[i])) return lines.slice(0, i).join('\n');
  }
  return lines.join('\n');
}

const SURFACES = [...walk('skills'), ...walk('commands'), ...walk('docs/guides')];

test('n2m wording: the retired rebase-treadmill phrasings are gone from skills, commands and guides', () => {
  assert.ok(SURFACES.length >= 10, `non-vacuous: ${SURFACES.length} files`);
  const banned = [
    /approved\+rebase/,
    /not DIRTY or BEHIND/,
    /needs rebase`? if BEHIND/,
    /Post-rebase handoff/,
    /rebased \(not BEHIND/,
  ];
  for (const rel of SURFACES) {
    const text = read(rel);
    for (const re of banned) assert.ok(!re.test(text), `${rel} still matches ${re}`);
  }
});

test('n2m wording: the fix PR skeleton carries an advisory Self-test report with the five announced items', () => {
  const ref = read('skills/core-contribution/reference.md');
  const start = ref.indexOf('## Fix PR body skeleton');
  assert.ok(start >= 0, 'fix PR skeleton section present');
  const section = sectionAt(ref, start);
  const at = section.indexOf('## Self-test report');
  assert.ok(at >= 0, 'skeleton has a ## Self-test report heading');
  const block = section.slice(at, at + 1200);
  for (const item of ['Failing test', 'Fails before the fix', 'Passes after the fix', 'Command', 'OS', 'Node']) {
    assert.ok(block.includes(item), `Self-test report names ${item}`);
  }
  assert.match(section, /Self-test report[\s\S]*advisory/i, 'the section is marked advisory');
  assert.match(section, /PULL_REQUEST_TEMPLATE\/fix\.md/, 'it says where to re-check the upstream template');
});

test('n2m wording: the contribution skill forbids a push after approval and a rebase for BEHIND alone', () => {
  const skill = read('skills/core-contribution/SKILL.md');
  assert.match(skill, /After approval, do not push unless a change is needed/);
  assert.match(skill, /Do not rebase or update the branch because `next` moved/);
  assert.match(skill, /Rebase only for a DIRTY conflict or when a needed change/);
  assert.match(skill, /Self-test report/);
});

test('n2m wording: every place that composes a push to an existing PR derives the remote from head.repo', () => {
  for (const rel of [
    'skills/core-contribution/reference.md',
    'skills/maintainer-review-sweep/re-review.md',
    'skills/maintainer-review-sweep/SKILL.md',
    'commands/gsd-submit.md',
  ]) {
    const text = read(rel);
    assert.match(text, /head\.repo/, `${rel} names head.repo`);
    assert.match(text, /tracking remote/, `${rel} says the tracking remote is not the authority`);
  }
  const ref = read('skills/core-contribution/reference.md');
  assert.match(ref, /gh api repos\/open-gsd\/gsd-core\/pulls\/<n> --jq '\.head\.repo\.full_name, \.head\.ref, \.head\.sha'/);
  assert.match(ref, /--force-with-lease=<head\.ref>:<head\.sha>/);
});

test('n2m wording: the sweep reads the live queue mode from pr-status and never blocks on BEHIND', () => {
  const skill = read('skills/maintainer-review-sweep/SKILL.md');
  const rr = read('skills/maintainer-review-sweep/re-review.md');
  assert.match(skill, /`queue:` line/);
  assert.match(skill, /BEHIND is never a blocker/);
  assert.match(rr, /`queue:` line/);
  assert.match(rr, /BEHIND is never a merge-blocked reason/);
  assert.match(read('commands/gsd-review-sweep.md'), /BEHIND is informational/);
  assert.match(read('skills/maintainer-review-sweep/labels.md'), /Never add `needs rebase` for BEHIND/);
});

// --- adversarial-gate fixes: next has classic protection that enforces up-to-date for non-admins ---

test('n2m gate fix: no surface claims the squash merge needs no update or that branch protection is evaluate-only', () => {
  const banned = [
    /squash merge does not need/,
    /branch protection is evaluate-mode/,
    /in evaluate mode means CI is not gated/,
    /merge as before/,
    /the sole `CLEAR/,
  ];
  for (const rel of SURFACES) {
    const text = read(rel);
    for (const re of banned) assert.ok(!re.test(text), `${rel} still matches ${re}`);
  }
});

test('n2m gate fix: the maintainer updates a BEHIND branch at merge time, and --admin is never used in any mode', () => {
  const rr = read('skills/maintainer-review-sweep/re-review.md');
  assert.match(rr, /never `--admin` in any mode/);
  assert.match(rr, /gh pr update-branch <n> --repo <owner>\/<repo>/);
  for (const rel of [
    'skills/maintainer-review-sweep/re-review.md',
    'skills/maintainer-review-sweep/SKILL.md',
    'skills/core-contribution/SKILL.md',
    'skills/core-contribution/reference.md',
    'commands/gsd-review-sweep.md',
  ]) {
    assert.match(read(rel), /Update branch at merge time/, `${rel} names the maintainer's Update branch at merge time`);
  }
  assert.match(read('skills/maintainer-review-sweep/SKILL.md'), /enforcement_level/, 'step 7 says how to read classic protection');
});
