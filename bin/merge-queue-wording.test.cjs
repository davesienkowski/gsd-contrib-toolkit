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
 *   2. the fix PR skeleton in core-contribution/reference.md carries upstream's `## Self-test report`
 *      json block (quick 261021-rud, after 76e1d4dc7 landed it in fix.md), the live policy's rules, the
 *      fill-after-the-last-push procedure, the P5d gate and the Reviewed-or-maintainer note;
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

// Quick 261021-rud: the upstream fix template gained the section (76e1d4dc7, #5612/#5614), checked by the
// advisory scripts/self-test-report-policy.cjs. The skeleton now mirrors upstream's json block, and the
// prose around it states the policy's rules and when to fill and re-fill the block.

/** The first fenced json block after `from` in `text`, as raw text. */
function jsonBlockAfter(text, from) {
  const open = text.indexOf('```json\n', from);
  assert.ok(open >= 0, 'a ```json fence follows');
  const body = open + '```json\n'.length;
  const close = text.indexOf('\n```', body);
  assert.ok(close > body, 'the json fence closes');
  return text.slice(body, close);
}

test('rud: the fix PR skeleton carries upstream\'s Self-test report json block, between Runtimes tested and Checklist', () => {
  const ref = read('skills/core-contribution/reference.md');
  const start = ref.indexOf('## Fix PR body skeleton');
  assert.ok(start >= 0, 'fix PR skeleton section present');
  const section = sectionAt(ref, start);
  const at = section.indexOf('## Self-test report');
  assert.ok(at >= 0, 'skeleton has a ## Self-test report heading');
  assert.ok(section.indexOf('### Runtimes tested') < at, 'after ### Runtimes tested, as upstream places it');
  assert.ok(at < section.indexOf('## Checklist'), 'before ## Checklist, as upstream places it');
  const report = JSON.parse(jsonBlockAfter(section, at));
  assert.deepEqual(Object.keys(report), [
    'schema', 'head_sha', 'tool', 'failing_first', 'commands', 'full_suite', 'environment', 'output_excerpt',
  ], 'the eight upstream keys, in upstream order');
  assert.equal(report.schema, 1);
  assert.ok(['gsd-test', 'npm-test', 'manual'].includes(report.tool), report.tool);
  // Passing values where upstream ships failing defaults, so a filled copy is not red by construction.
  assert.equal(report.failing_first.fails_on_base, true);
  assert.equal(report.failing_first.passes_on_head, true);
  assert.equal(report.full_suite.result, 'passed');
  assert.equal(report.full_suite.failed, 0);
  // What only the author can know stays a whole <...> placeholder, which the live check rejects unfilled.
  const ph = /^<[^<>]*>$/;
  for (const [name, v] of [
    ['head_sha', report.head_sha],
    ['failing_first.test', report.failing_first.test],
    ['environment.os', report.environment.os],
    ['environment.node', report.environment.node],
    ['output_excerpt', report.output_excerpt],
  ]) assert.match(String(v), ph, `${name} is an unfilled placeholder`);
  // The bullet shape and the not-landed note are gone.
  assert.doesNotMatch(section, /^- Failing test: /m, 'the old bullet list is gone');
  assert.doesNotMatch(ref, /has no such section/, 'the not-landed note is gone from reference.md');
  assert.doesNotMatch(ref, /had not gained the section/, 'the not-landed note is gone from reference.md');
});

test('rud: reference.md states the live policy rules, who must file it, and when to fill and re-fill it', () => {
  const ref = read('skills/core-contribution/reference.md');
  const section = sectionAt(ref, ref.indexOf('## Fix PR body skeleton')).replace(/\s+/g, ' ');
  for (const s of [
    'scripts/self-test-report-policy.cjs', '76e1d4dc7', 'advisory',
    // which PRs count, and that Dave is not exempt
    '`fix/`', '.github/MAINTAINERS', 'trek-e', 'not exempt', '[bot]',
    // validity rules
    '`gsd-test`', '`npm-test`', '`manual`', 'not_applicable_reason', '2000 characters', '`passed` at least 1',
    // fill after the last push, bound to the head, refill after any push
    'after the last push', 'git rev-parse HEAD', 'headRefOid', 'fail_stale_sha', 'Never swap only the sha',
    'gh pr edit', '# pass',
    // local run of the LIVE policy from a base copy
    'git archive origin/next', 'PR_BODY_FILE', 'HEAD_SHA', 'MAINTAINERS_FILE', 'ok_report',
  ]) assert.ok(section.includes(s), `Fix PR skeleton section names ${s}`);
  assert.match(section, /declaration, not proof/, 'not_applicable_reason is a declaration, not proof');
  assert.match(section, /not a full suite/, 'P3d relevant suites are not a full suite');
});

test('rud: SKILL.md gates the report with P5d, drops the not-landed note, and explains Reviewed or maintainer', () => {
  const skill = read('skills/core-contribution/SKILL.md');
  assert.doesNotMatch(skill, /had not gained the section/, 'the not-landed note is gone from SKILL.md');
  assert.match(skill, /^\[ \] P5d .*self-test-report-policy\.cjs.*\[GATE: ok_report/m, 'P5d runs the live policy as a gate');
  const p6 = skill.slice(skill.indexOf('### Phase 6'), skill.indexOf('### Phase 7')).replace(/\s+/g, ' ');
  for (const s of [
    'Reviewed or maintainer', 'write access', 'current head', 'fail_no_approval', 'fail_stale_approval_only',
    'Bots never count', 'expected', 'advisory', 'not among the 7', 'next-queue', 'evaluate',
  ]) assert.ok(p6.includes(s), `Phase 6 names ${s}`);
  assert.match(p6, /re-reads? red after (a|any|every) (new )?push/i, 'approval is head-bound: a push re-reds it');
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
  assert.match(rr, /never `--admin` in any mode/i);
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

// --- round-2 gate notes N1 and N2 (re-review step 13, the maintainer's own Update branch) ---

/** re-review.md step 13 (the Merge gate), up to step 14. */
function step13() {
  const rr = read('skills/maintainer-review-sweep/re-review.md');
  const start = rr.indexOf('13. **Merge gate.**');
  const end = rr.indexOf('14. **', start);
  assert.ok(start >= 0 && end > start, 'step 13 found before step 14');
  return rr.slice(start, end);
}

test('N1: step 13 records the head before Update branch and aborts only on an unexpected head change', () => {
  const s = step13();
  assert.doesNotMatch(s, /if its head SHA differs from step 1's, abort and restart\)/, 'the unconditional abort is gone');
  assert.match(s, /`H0`/, 'names the head recorded before Update branch');
  assert.match(s, /`H1`/, 'names the head after Update branch');
  assert.ok(s.indexOf('`H0`') < s.indexOf('gh pr update-branch <n> --repo <owner>/<repo>'), 'H0 is recorded before update-branch runs');
  assert.match(s, /exactly one new commit/, 'expects exactly one new commit');
  assert.match(s, /gh api repos\/<owner>\/<repo>\/commits\/<H1> --jq '\[\.parents\[\]\.sha\]'/, 'checks the parents of the new head');
  assert.match(s, /CI on `H1`/, 're-verifies checks on the new head');
  assert.match(s, /--match-head-commit <H1>/, 'the merge is pinned to the verified head');
  assert.match(s, /unexpected head change: abort and restart/, 'aborts only on an unexpected head change');
});

test('N2: step 13 states that BEHIND can be stale and that approval dismissal by Update branch is not verified', () => {
  const s = step13();
  assert.match(s, /behind_by=0/, 'BEHIND can read while behind_by=0');
  assert.match(s, /PR branch already up-to-date/, 'names what gh prints for a stale BEHIND');
  assert.match(s, /dismisses an existing approval is not verified/, 'does not claim either way about dismissal');
  assert.match(s, /do not assume either way/);
});

// --- nits gate BLOCK on N1 (2026-10-21): the parent shape is contributor-controlled metadata
// (Kerckhoffs), so step 13.3 must also check the content: H1's tree equals a clean merge of its parents.

test('N1 content: step 13 requires H1 tree to equal the clean merge of its two parents, conflict or mismatch aborts', () => {
  const s = step13();
  assert.match(s, /git merge-tree --write-tree <H0> <base-parent>/, 'recomputes the clean merge of the parents');
  assert.match(s, /git rev-parse '<H1>\^\{tree\}'/, 'compares against the tree of H1');
  assert.match(s, /exits non-zero on a conflict/, 'a conflict is named');
  assert.match(s, /a conflict or a tree mismatch is an unexpected head change/, 'both abort');
  assert.match(s, /git 2\.38/, 'names the git version merge-tree --write-tree needs');
  assert.match(s, /git worktree add --detach/, 'gives the temporary-worktree fallback');
  assert.match(s, /git fetch /, 'fetches the commits before checking them locally');
  assert.ok(s.indexOf('merge-tree --write-tree') < s.indexOf('Re-verify on the new head'), 'the content check is in 13.3, before CI is read');
});
