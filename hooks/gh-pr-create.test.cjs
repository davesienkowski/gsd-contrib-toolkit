'use strict';

/**
 * node:test for hooks/gh-pr-create.cjs (ENF-02 template + ENF-10 base-via-live +
 * toolkit-owned Fixes #N & branch-name + ENF-15 synonym + HARD-01/04 fail-closed).
 *
 * Driven through the injectable runPrGate(input, deps) seam: the LIVE pr-template /
 * pr-target exports, the current branch, and the override check are all injected so
 * the unit suite is hermetic.
 */

const test = require('node:test');
const assert = require('node:assert');

const { runPrGate } = require('./gh-pr-create.cjs');

const liveTemplate = require('/home/dave/repos/gsd-core/scripts/pr-template-policy.cjs');
const liveTarget = require('/home/dave/repos/gsd-core/scripts/pr-target-policy.cjs');

function input(command) {
  return JSON.stringify({ tool_name: 'Bash', tool_input: { command } });
}

// A complete, valid `fix` PR-template body (all required headings) WITH a Fixes #N.
const GOOD_PR_BODY = [
  '## Fix PR',
  '',
  '## Linked Issue',
  'Fixes #12',
  '',
  '## What was broken',
  'the thing',
  '',
  '## What this fix does',
  'fixes the thing',
  '',
  '## Testing',
  'node --test',
  '',
  '## Checklist',
  '- [x] tests',
].join('\n');

// Same valid template but WITHOUT a Fixes/Closes #N line.
const NO_LINK_BODY = GOOD_PR_BODY.replace('Fixes #12', 'see the issue');

function deps(over = {}) {
  return Object.assign(
    {
      liveTemplate,
      liveTarget,
      branch: 'fix/12-the-thing',
      changedFiles: ['src/index.cts'], // non-tooling so template IS enforced
      authorAssociation: 'OWNER',
      worktreeRoot: '/tmp/wt',
      overrideImpl: { checkOverride: () => ({ override: false }), writeReceipt: () => {} },
    },
    over
  );
}

test('non-pr command (gh repo view) → allow', () => {
  const d = runPrGate(input('gh repo view o/r'), deps());
  assert.strictEqual(d.permissionDecision, 'allow');
});

test('clean templated PR to next, Fixes #N, conforming branch → allow', () => {
  const d = runPrGate(
    input(`gh pr create --base next --title x --body "${escapeNl(GOOD_PR_BODY)}"`),
    deps()
  );
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

test('missing/empty body → template invalid → DENY (ENF-02)', () => {
  const d = runPrGate(input('gh pr create --base next --title x --body ""'), deps());
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /template/i);
});

test('wrong-template body → DENY (ENF-02)', () => {
  const d = runPrGate(
    input('gh pr create --base next --title x --body "just some prose, no template"'),
    deps()
  );
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /template/i);
});

test('base main from a non-allowed head → classifyPrTarget blocked → DENY (ENF-10)', () => {
  const d = runPrGate(
    input(`gh pr create --base main --title x --body "${escapeNl(GOOD_PR_BODY)}"`),
    deps({ branch: 'fix/12-the-thing' })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /base|target|main/i);
});

test('unusual base → DENY (conservative contribution stance)', () => {
  const d = runPrGate(
    input(`gh pr create --base some-random-branch --title x --body "${escapeNl(GOOD_PR_BODY)}"`),
    deps()
  );
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /base|target|unusual/i);
});

test('body lacks Fixes #N (toolkit-owned link check) → DENY, worded as ours', () => {
  const d = runPrGate(
    input(`gh pr create --base next --title x --body "${escapeNl(NO_LINK_BODY)}"`),
    deps()
  );
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /Fixes|Closes|linked.issue/i);
  // H-A: phrased as the toolkit's OWN check, not "the repo's script".
  assert.match(d.permissionDecisionReason, /toolkit|our own|replicat/i);
});

test('Closes #N is also accepted as a link', () => {
  const body = GOOD_PR_BODY.replace('Fixes #12', 'Closes #34');
  const d = runPrGate(
    input(`gh pr create --base next --title x --body "${escapeNl(body)}"`),
    deps()
  );
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

test('branch not matching fix|docs|feat/<n>- (toolkit-owned) → DENY, worded as ours', () => {
  const d = runPrGate(
    input(`gh pr create --base next --title x --body "${escapeNl(GOOD_PR_BODY)}"`),
    deps({ branch: 'my-random-branch' })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /branch/i);
  assert.match(d.permissionDecisionReason, /toolkit|our own|replicat/i);
});

test('gh api POST pulls synonym, bad template → DENY (ENF-15)', () => {
  const cmd = `gh api -X POST repos/o/r/pulls -f title=x -f body='no template here' -f base=next`;
  const d = runPrGate(input(cmd), deps());
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
});

test('gh api POST pulls synonym, full clean → allow (ENF-15)', () => {
  const cmd = `gh api -X POST repos/o/r/pulls -f title=x -f base=next -f body='${escapeSingle(GOOD_PR_BODY)}'`;
  const d = runPrGate(input(cmd), deps());
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

test('unparseable command → FAIL CLOSED deny (HARD-04)', () => {
  const d = runPrGate(input('gh pr create --base next --body "unterminated'), deps());
  assert.strictEqual(d.permissionDecision, 'deny');
});

test('--body-file - (stdin) → FAIL CLOSED deny (HARD-04)', () => {
  const d = runPrGate(input('gh pr create --base next --body-file -'), deps());
  assert.strictEqual(d.permissionDecision, 'deny');
});

test('a thrown live target (reshaped script) → FAIL CLOSED deny (HARD-01)', () => {
  const d = runPrGate(
    input(`gh pr create --base next --title x --body "${escapeNl(GOOD_PR_BODY)}"`),
    deps({
      liveTarget: {
        classifyPrTarget() {
          throw new Error('reshaped');
        },
      },
    })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
});

test('a thrown live target WITH a logged override → allow (HARD-03)', () => {
  const d = runPrGate(
    input(`gh pr create --base next --title x --body "${escapeNl(GOOD_PR_BODY)}"`),
    deps({
      liveTarget: {
        classifyPrTarget() {
          throw new Error('reshaped');
        },
      },
      overrideImpl: {
        checkOverride: () => ({ override: true, reason: 'transient' }),
        writeReceipt: () => '/tmp/wt/.gsd-contrib/override-receipts.log',
      },
    })
  );
  assert.strictEqual(d.permissionDecision, 'allow');
});

// Helpers: encode newlines so the body survives as a single double-quoted shell token.
// argv keeps literal backslash-n; the gate normalizes \n → newline before policy eval.
function escapeNl(s) {
  return s.replace(/\n/g, '\\n').replace(/"/g, '\\"');
}
function escapeSingle(s) {
  // inside single quotes we keep newlines as \n sentinels too (gate normalizes)
  return s.replace(/\n/g, '\\n').replace(/'/g, "'\\''");
}
