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

const { runPrGate, evaluateCiResult } = require('./gh-pr-create.cjs');

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
      // ENF-18 Tier-2: inject the head SHA + a GREEN check-runs read so all the
      // pre-existing template/base/link/branch tests stay green (they are not perturbed
      // by the additional CI-result condition). Individual tests override readCheckRuns
      // to exercise the not-green / tests-did-not-run / throwing cases.
      headSha: 'abc1234',
      readCheckRuns: () => ({
        headSha: 'abc1234',
        testsRan: true,
        allRequiredGreen: true,
        conclusions: [{ name: 'Tests', status: 'completed', conclusion: 'success' }],
      }),
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

// ---- ENF-18 Tier-2: CI-check-run-green condition ----------------------------------

// A green / not-green readCheckRuns stub factory.
function ci(over = {}) {
  return Object.assign(
    {
      headSha: 'abc1234',
      testsRan: true,
      allRequiredGreen: true,
      conclusions: [{ name: 'Tests', status: 'completed', conclusion: 'success' }],
    },
    over
  );
}

test('ENF-18: green check-runs (Tests ran + all success) → allow', () => {
  const d = runPrGate(
    input(`gh pr create --base next --title x --body "${escapeNl(GOOD_PR_BODY)}"`),
    deps({ readCheckRuns: () => ci() })
  );
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

test('ENF-18: a not-green conclusion (failure) → DENY naming the CI check-run + head SHA', () => {
  const d = runPrGate(
    input(`gh pr create --base next --title x --body "${escapeNl(GOOD_PR_BODY)}"`),
    deps({
      readCheckRuns: () =>
        ci({
          allRequiredGreen: false,
          conclusions: [{ name: 'Tests', status: 'completed', conclusion: 'failure' }],
        }),
    })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /check.?run|CI|head/i);
});

test('ENF-18: Tests did NOT run on the head SHA (changeset-only, #1532) → DENY', () => {
  const d = runPrGate(
    input(`gh pr create --base next --title x --body "${escapeNl(GOOD_PR_BODY)}"`),
    deps({
      readCheckRuns: () => ci({ testsRan: false, allRequiredGreen: false, conclusions: [] }),
    })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /head|Tests|check.?run/i);
});

test('ENF-18: a throwing readCheckRuns (gh unauth / unparseable) → FAIL CLOSED deny (HARD-01)', () => {
  const d = runPrGate(
    input(`gh pr create --base next --title x --body "${escapeNl(GOOD_PR_BODY)}"`),
    deps({
      readCheckRuns: () => {
        throw new Error('gh: not authenticated');
      },
    })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
});

test('ENF-18: the four existing checks gate FIRST — bad template denies before the CI read runs', () => {
  let ciCalled = false;
  const d = runPrGate(input('gh pr create --base next --title x --body ""'), deps({
    readCheckRuns: () => {
      ciCalled = true;
      return ci();
    },
  }));
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /template/i);
  assert.strictEqual(ciCalled, false, 'CI read must not run until the four checks pass');
});

test('ENF-18 synonym: gh api POST pulls, green CI → allow', () => {
  const cmd = `gh api -X POST repos/o/r/pulls -f title=x -f base=next -f body='${escapeSingle(GOOD_PR_BODY)}'`;
  const d = runPrGate(input(cmd), deps({ readCheckRuns: () => ci() }));
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

test('ENF-18 synonym: gh api POST pulls, not-green CI → DENY', () => {
  const cmd = `gh api -X POST repos/o/r/pulls -f title=x -f base=next -f body='${escapeSingle(GOOD_PR_BODY)}'`;
  const d = runPrGate(
    input(cmd),
    deps({
      readCheckRuns: () =>
        ci({ allRequiredGreen: false, conclusions: [{ name: 'Tests', status: 'completed', conclusion: 'failure' }] }),
    })
  );
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
  assert.match(d.permissionDecisionReason, /check.?run|CI|head/i);
});

test('ENF-18 synonym: curl POST pulls, green CI → allow', () => {
  const payload = JSON.stringify({ title: 'x', base: 'next', body: GOOD_PR_BODY });
  const cmd = `curl -X POST https://api.github.com/repos/o/r/pulls -d '${payload.replace(/'/g, "'\\''")}'`;
  const d = runPrGate(input(cmd), deps({ readCheckRuns: () => ci() }));
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

test('ENF-18 synonym: curl POST pulls, not-green CI → DENY', () => {
  const payload = JSON.stringify({ title: 'x', base: 'next', body: GOOD_PR_BODY });
  const cmd = `curl -X POST https://api.github.com/repos/o/r/pulls -d '${payload.replace(/'/g, "'\\''")}'`;
  const d = runPrGate(
    input(cmd),
    deps({
      readCheckRuns: () =>
        ci({ allRequiredGreen: false, conclusions: [{ name: 'Tests', status: 'completed', conclusion: 'failure' }] }),
    })
  );
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
  assert.match(d.permissionDecisionReason, /check.?run|CI|head/i);
});

test('ENF-18 unit: evaluateCiResult is green ONLY for testsRan + allRequiredGreen', () => {
  assert.strictEqual(evaluateCiResult(ci()).green, true);
  // not-green variants
  assert.strictEqual(evaluateCiResult(ci({ testsRan: false })).green, false);
  assert.strictEqual(evaluateCiResult(ci({ allRequiredGreen: false })).green, false);
  assert.strictEqual(evaluateCiResult(ci({ testsRan: false, allRequiredGreen: false })).green, false);
  // absent / malformed inputs are NOT green (fail-closed shape)
  assert.strictEqual(evaluateCiResult(null).green, false);
  assert.strictEqual(evaluateCiResult(undefined).green, false);
  assert.strictEqual(evaluateCiResult({}).green, false);
});

// ── WR-04: --fill / --fill-first / --web denied for un-observability (NOT template) ──
// The body these forms produce is not observable to a PreToolUse hook, so the command STAYS
// DENIED (fail-closed) — but with a precise un-observability reason, distinct from the ENF-02
// template-content denial, telling the user to provide --body / --body-file.
const FILL_RE = /fill|web|cannot observe|--body/i;

test('WR-04: gh pr create --fill → DENY with un-observability reason (not template)', () => {
  const d = runPrGate(input('gh pr create --fill --base next --head fix/123-x'), deps());
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
  assert.match(d.permissionDecisionReason, FILL_RE);
  // It is NOT the ENF-02 template-policy denial (which cites ENF-02 / the LIVE policy);
  // the un-observability reason names --fill/--web and the cannot-observe remedy instead.
  assert.doesNotMatch(d.permissionDecisionReason, /ENF-02|LIVE pr-template-policy/i);
  assert.match(d.permissionDecisionReason, /--fill|observe/i);
});

test('WR-04: gh pr create --fill-first → DENY with the same un-observability reason', () => {
  const d = runPrGate(input('gh pr create --fill-first --base next --head fix/123-x'), deps());
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
  assert.match(d.permissionDecisionReason, FILL_RE);
  assert.match(d.permissionDecisionReason, /observe/i);
});

test('WR-04: gh pr create --web → DENY with the un-observability reason', () => {
  const d = runPrGate(input('gh pr create --web --base next --head fix/123-x'), deps());
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
  assert.match(d.permissionDecisionReason, FILL_RE);
  assert.match(d.permissionDecisionReason, /observe/i);
});

test('WR-04 no-regression: a body-bearing command that fails the template STILL denies for template', () => {
  const d = runPrGate(
    input('gh pr create --base next --title x --body "just some prose, no template"'),
    deps()
  );
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /template/i);
  // The new --fill branch did NOT steal a body-bearing command.
  assert.doesNotMatch(d.permissionDecisionReason, /--fill|--web|cannot observe/i);
});

test('WR-04 no-regression: a fully-valid --body PR still ALLOWS', () => {
  const d = runPrGate(
    input(`gh pr create --base next --title x --body "${escapeNl(GOOD_PR_BODY)}"`),
    deps()
  );
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

// Helpers. A real `gh pr create --body "..."` command carries REAL newlines inside the
// double-quoted token (the harness passes the literal command string). argv preserves
// real newlines verbatim; only escapes a backslash. So the native double-quoted body
// uses real newlines (we just guard embedded double-quotes).
function escapeNl(s) {
  return s.replace(/"/g, '\\"');
}
// The single-quoted gh-api `-f body='...'` route is exercised with the `\n` sentinel
// form (argv keeps the literal backslash-n inside single quotes; the gate's
// normalizeBody turns it back into real newlines) — covering BOTH body encodings.
function escapeSingle(s) {
  return s.replace(/\n/g, '\\n').replace(/'/g, "'\\''");
}
