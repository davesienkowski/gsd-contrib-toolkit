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

const {
  runPrGate,
  evaluateCiResult,
  ownerRepoFromRemote,
  resolveHead,
} = require('./gh-pr-create.cjs');
const { parseCommand: _parseCmd } = require('./lib/argv.cjs');
const { classifyAction: _classifyAction, findActionSegment: _findActionSegment } = require('./lib/classify.cjs');

// CHD-03 helper: derive the (seg, route) the gate sees from a raw command, so the
// route-scoped resolveHead can be unit-tested in isolation.
function headCtx(command) {
  const parsed = _parseCmd(command);
  const action = _classifyAction(parsed);
  const seg = _findActionSegment(parsed, 'pr-create');
  return { seg, route: action.route || 'native' };
}

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

// ROB-02: a non-empty open-PR list for the head branch. Injecting this engages the
// UNCHANGED ENF-18 check-run gate (the green-gate is preserved for an existing-PR head
// SHA). The default deps() below lists NO open PR (a first create), so any test that
// must exercise the check-run gate injects `listPrsForHead: () => EXISTING_PR`.
const EXISTING_PR = [{ number: 1738 }];

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
      // ROB-02: default to the FIRST-create path — no open PR for the head branch. gsd-core
      // CI runs on `pull_request`, so a green check-run precondition is UNSATISFIABLE before
      // the PR exists; the first create relaxes ONLY the CI-green step. Tests that exercise
      // the existing-PR check-run gate inject `listPrsForHead: () => EXISTING_PR`.
      listPrsForHead: () => [],
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
// NOTE (ROB-02): the check-run gate now only engages for an EXISTING-PR head branch, so
// every test below injects `listPrsForHead: () => EXISTING_PR` to exercise it. The
// first-create relaxation (empty open-PR list) is covered in the ROB-02 block further down.

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
    deps({ listPrsForHead: () => EXISTING_PR, readCheckRuns: () => ci() })
  );
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

test('ENF-18: a not-green conclusion (failure) → DENY naming the CI check-run + head SHA', () => {
  const d = runPrGate(
    input(`gh pr create --base next --title x --body "${escapeNl(GOOD_PR_BODY)}"`),
    deps({
      listPrsForHead: () => EXISTING_PR,
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
      listPrsForHead: () => EXISTING_PR,
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
      listPrsForHead: () => EXISTING_PR,
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
    listPrsForHead: () => EXISTING_PR,
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
  const d = runPrGate(input(cmd), deps({ listPrsForHead: () => EXISTING_PR, readCheckRuns: () => ci() }));
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

test('ENF-18 synonym: gh api POST pulls, not-green CI → DENY', () => {
  const cmd = `gh api -X POST repos/o/r/pulls -f title=x -f base=next -f body='${escapeSingle(GOOD_PR_BODY)}'`;
  const d = runPrGate(
    input(cmd),
    deps({
      listPrsForHead: () => EXISTING_PR,
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
  const d = runPrGate(input(cmd), deps({ listPrsForHead: () => EXISTING_PR, readCheckRuns: () => ci() }));
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

test('ENF-18 synonym: curl POST pulls, not-green CI → DENY', () => {
  const payload = JSON.stringify({ title: 'x', base: 'next', body: GOOD_PR_BODY });
  const cmd = `curl -X POST https://api.github.com/repos/o/r/pulls -d '${payload.replace(/'/g, "'\\''")}'`;
  const d = runPrGate(
    input(cmd),
    deps({
      listPrsForHead: () => EXISTING_PR,
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

// ── IN-01: the ENF-18 CI deny reason states the all-runs-must-conclude-success stance ──
test('IN-01: ENF-18 deny reason prominently states EVERY check-run must conclude success', () => {
  const d = runPrGate(
    input(`gh pr create --base next --title x --body "${escapeNl(GOOD_PR_BODY)}"`),
    deps({
      listPrsForHead: () => EXISTING_PR,
      readCheckRuns: () =>
        ci({ allRequiredGreen: false, conclusions: [{ name: 'Tests', status: 'completed', conclusion: 'failure' }] }),
    })
  );
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
  assert.match(d.permissionDecisionReason, /every check-run.*success/i);
  // The stance is explicit that it does NOT use branch-protection required_status_checks.
  assert.match(d.permissionDecisionReason, /required_status_checks|does NOT consult/i);
});

// ── IN-02: ownerRepoFromRemote validates owner/repo and fails closed on unsafe chars ──
test('IN-02: ownerRepoFromRemote parses a valid ssh remote', () => {
  assert.deepStrictEqual(
    ownerRepoFromRemote('git@github.com:open-gsd/gsd-core.git'),
    { owner: 'open-gsd', repo: 'gsd-core' }
  );
});

test('IN-02: ownerRepoFromRemote parses a valid https remote', () => {
  assert.deepStrictEqual(
    ownerRepoFromRemote('https://github.com/open-gsd/gsd-core.git'),
    { owner: 'open-gsd', repo: 'gsd-core' }
  );
});

test('IN-02: ownerRepoFromRemote returns null (fail closed) on an unsafe owner/repo char', () => {
  assert.strictEqual(ownerRepoFromRemote('https://github.com/o;rm/r$x.git'), null);
  assert.strictEqual(ownerRepoFromRemote('https://github.com/o;rm/r.git'), null);
});

// CHD-01 (T-26-02-03 / Gall step 3): ownerRepoFromRemote routes through parseOwnerRepo —
// case-folds consistently with the unified normalizer, preserves the SAFE-char fail-closed.
test('CHD-01: ownerRepoFromRemote case-folds owner/repo consistently with parseOwnerRepo', () => {
  assert.deepStrictEqual(
    ownerRepoFromRemote('https://github.com/Open-GSD/GSD-Core'),
    { owner: 'open-gsd', repo: 'gsd-core' }
  );
  assert.deepStrictEqual(
    ownerRepoFromRemote('git@github.com:Open-GSD/GSD-Core.git'),
    { owner: 'open-gsd', repo: 'gsd-core' }
  );
});

test('CHD-01: ownerRepoFromRemote keeps the {owner,repo}|null shape; null on a single-segment / garbage remote', () => {
  assert.deepStrictEqual(
    ownerRepoFromRemote('https://github.com/dave/fork.git'),
    { owner: 'dave', repo: 'fork' }
  );
  assert.strictEqual(ownerRepoFromRemote('weird::garbage'), null);
  assert.strictEqual(ownerRepoFromRemote('https://github.com/single'), null);
});

// --- ROB-01: out-of-tree passthrough seam (null root) + the -R/--repo hole ---
// Deterministic denying override so the fail-closed case stays hermetic.
const robDenyingOverride = {
  overrideImpl: { checkOverride: () => ({ override: false }), writeReceipt: () => {} },
};

test('ROB-01: out-of-tree, NON-targeting command (cd /tmp && gh pr list) → ALLOW (passthrough)', () => {
  // No worktreeRoot / liveTemplate / liveTarget / branch injected → the real resolver runs;
  // cd /tmp has no gsd-core sentinel → null root → non-targeting → passthrough ALLOW.
  const d = runPrGate(input('cd /tmp && gh pr list'), robDenyingOverride);
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

test('ROB-01: out-of-tree pr create targeting open-gsd/gsd-core via -R → DENY (fail-closed)', () => {
  const d = runPrGate(
    input('cd /tmp && gh pr create -R open-gsd/gsd-core --base next --title x --body "b"'),
    robDenyingOverride
  );
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
  assert.match(d.permissionDecisionReason, /open-gsd\/gsd-core|checkout|verify/i);
});

test('ROB-01: out-of-tree pr create -R to a FORK (dave/gsd-core-fork) → ALLOW (no false deny)', () => {
  const d = runPrGate(
    input('cd /tmp && gh pr create -R dave/gsd-core-fork --base next --title x --body "b"'),
    robDenyingOverride
  );
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

// --- ROB-02: first `gh pr create` relaxation (no open PR for the head branch) ---
// gsd-core's test.yml runs CI on `pull_request`, so a green check-run precondition is
// UNSATISFIABLE before the PR exists — the first create was blocked every time during the
// live #1154 → PR #1738 run and had to be routed through the `!` channel. The FIRST create
// (empty open-PR list) relaxes ONLY the CI-green step; every OTHER ENF-18 precondition still
// applies, and the green-gate is preserved for an existing-PR head SHA.

test('ROB-02: first create (empty open-PR list) + otherwise-valid PR → ALLOW (CI read SKIPPED)', () => {
  const d = runPrGate(
    input(`gh pr create --base next --title x --body "${escapeNl(GOOD_PR_BODY)}"`),
    deps({
      listPrsForHead: () => [], // no open PR for the head branch → first create
      // Prove the relaxation actually SKIPS the check-run read: were it consulted this would
      // throw → fail-closed deny. An ALLOW proves the CI-green step was skipped on first create.
      readCheckRuns: () => {
        throw new Error('ROB-02: the check-run read must be SKIPPED on a first create');
      },
    })
  );
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

test('ROB-02: existing PR + a failure check-run → DENY (green-gate intact)', () => {
  const d = runPrGate(
    input(`gh pr create --base next --title x --body "${escapeNl(GOOD_PR_BODY)}"`),
    deps({
      listPrsForHead: () => EXISTING_PR, // an open PR exists → run the unchanged ENF-18 gate
      readCheckRuns: () =>
        ci({
          allRequiredGreen: false,
          conclusions: [{ name: 'Tests', status: 'completed', conclusion: 'failure' }],
        }),
    })
  );
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
  assert.match(d.permissionDecisionReason, /check.?run|CI|head/i);
});

test('ROB-02: existing PR + green check-runs → ALLOW (unchanged existing-PR behavior)', () => {
  const d = runPrGate(
    input(`gh pr create --base next --title x --body "${escapeNl(GOOD_PR_BODY)}"`),
    deps({ listPrsForHead: () => EXISTING_PR, readCheckRuns: () => ci() })
  );
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

test('ROB-02: an unreadable listPrsForHead (gh unauth, throws) → FAIL CLOSED deny (HARD-01)', () => {
  const d = runPrGate(
    input(`gh pr create --base next --title x --body "${escapeNl(GOOD_PR_BODY)}"`),
    deps({
      listPrsForHead: () => {
        throw new Error('gh: not authenticated');
      },
      // readCheckRuns stays green by default — the deny must come from the unreadable PR-list
      // read, proving the fail-closed is the listPrsForHead throw path (mirrors readCheckRuns).
    })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
});

test('ROB-02: first create still DENIES a non-CI precondition (missing Fixes #N)', () => {
  const d = runPrGate(
    input(`gh pr create --base next --title x --body "${escapeNl(NO_LINK_BODY)}"`),
    deps({
      listPrsForHead: () => [], // first create — but the link precondition still applies
      // Prove it is the link check (step 3, BEFORE ENF-18) that denies: a thrown CI read would
      // also deny, but for the wrong reason. ALLOW-of-the-relaxation must NOT swallow this.
      readCheckRuns: () => {
        throw new Error('ROB-02: the link precondition must deny before any CI read');
      },
    })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /Fixes|Closes|linked.issue/i);
});

test('ROB-02: first create still DENIES a disallowed base (ENF-10) before the relaxation', () => {
  const d = runPrGate(
    input(`gh pr create --base main --title x --body "${escapeNl(GOOD_PR_BODY)}"`),
    deps({
      listPrsForHead: () => [],
      readCheckRuns: () => {
        throw new Error('ROB-02: the base precondition must deny before any CI read');
      },
    })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /base|target|main/i);
});

test('ROB-02: first create still DENIES a bad branch name (toolkit-owned) before the relaxation', () => {
  const d = runPrGate(
    input(`gh pr create --base next --title x --body "${escapeNl(GOOD_PR_BODY)}"`),
    deps({
      branch: 'my-random-branch',
      listPrsForHead: () => [],
      readCheckRuns: () => {
        throw new Error('ROB-02: the branch-name precondition must deny before any CI read');
      },
    })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /branch/i);
});

// --- WR-01: the ENF-18 readers honor the command's explicit -R/GH_REPO target ---
// When the command names an explicit upstream target while the worktree origin is a fork, the
// readers (listPrsForHead / readCheckRuns) must read PRs/check-runs from the UPSTREAM repo — so
// an upstream red PR can no longer hide behind a fork origin. The readers receive the resolved
// {owner,repo} as a second argument (single-source: the same explicit target the gate derives).

test('WR-01: -R upstream target while origin is a fork → readers read upstream; red PR → DENY', () => {
  let listTarget; let ciTarget;
  const d = runPrGate(
    input(`gh pr create -R open-gsd/gsd-core --base next --title x --body "${escapeNl(GOOD_PR_BODY)}"`),
    deps({
      listPrsForHead: (head, target) => {
        listTarget = target;
        return EXISTING_PR; // an OPEN PR exists upstream → engages the (unchanged) check-run gate
      },
      readCheckRuns: (sha, target) => {
        ciTarget = target;
        return ci({ allRequiredGreen: false, conclusions: [{ name: 'Tests', status: 'completed', conclusion: 'failure' }] });
      },
    })
  );
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
  assert.match(d.permissionDecisionReason, /check.?run|CI|head/i);
  // BOTH readers were handed the explicit upstream target (not the worktree origin).
  assert.deepStrictEqual(listTarget, { owner: 'open-gsd', repo: 'gsd-core' });
  assert.deepStrictEqual(ciTarget, { owner: 'open-gsd', repo: 'gsd-core' });
});

test('WR-01: case-variant -R Open-GSD/GSD-Core target → readers read the case-folded upstream', () => {
  let listTarget;
  const d = runPrGate(
    input(`gh pr create -R Open-GSD/GSD-Core --base next --title x --body "${escapeNl(GOOD_PR_BODY)}"`),
    deps({
      listPrsForHead: (head, target) => { listTarget = target; return []; }, // first create
      readCheckRuns: () => ci(),
    })
  );
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
  assert.deepStrictEqual(listTarget, { owner: 'open-gsd', repo: 'gsd-core' });
});

test('WR-01: GH_REPO=open-gsd/gsd-core env target → readers read upstream', () => {
  let listTarget;
  const d = runPrGate(
    input(`GH_REPO=open-gsd/gsd-core gh pr create --base next --title x --body "${escapeNl(GOOD_PR_BODY)}"`),
    deps({
      listPrsForHead: (head, target) => { listTarget = target; return []; },
      readCheckRuns: () => ci(),
    })
  );
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
  assert.deepStrictEqual(listTarget, { owner: 'open-gsd', repo: 'gsd-core' });
});

test('WR-01: NO explicit -R/GH_REPO target → readers fall back to origin (target is null)', () => {
  let listTarget = 'UNSET'; let ciTarget = 'UNSET';
  const d = runPrGate(
    input(`gh pr create --base next --title x --body "${escapeNl(GOOD_PR_BODY)}"`),
    deps({
      listPrsForHead: (head, target) => { listTarget = target; return EXISTING_PR; },
      readCheckRuns: (sha, target) => { ciTarget = target; return ci(); },
    })
  );
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
  assert.strictEqual(listTarget, null);
  assert.strictEqual(ciTarget, null);
});

test('WR-01: an explicit -R target unparseable by the enumerated forms → FAIL CLOSED deny', () => {
  const d = runPrGate(
    input(`gh pr create -R weird::garbage --base next --title x --body "${escapeNl(GOOD_PR_BODY)}"`),
    // Were the explicit target ignored, the empty open-PR list would be a first-create ALLOW;
    // the unparseable explicit target must instead fail closed (no silent origin-fallback ALLOW).
    deps({ listPrsForHead: () => [] })
  );
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
});

// ── CHD-03 Task 1: route-scoped --head/-H resolver (resolveHead) ────────────────
// `-H` is ALSO gh's HTTP-header flag (the hook's own `gh api -H 'Accept: …'`, and the
// user's gh-api/curl routes), so the head lookup is scoped to the NATIVE `gh pr create`
// route ONLY. On the gh-api / curl routes the head travels via `-f head=` / JSON, never `-H`.

test('CHD-03 resolveHead: native `-H <branch>` → the branch', () => {
  const { seg, route } = headCtx('gh pr create -H fix/99-red --base next --title x --body b');
  assert.strictEqual(route, 'native');
  assert.strictEqual(resolveHead(seg, route), 'fix/99-red');
});

test('CHD-03 resolveHead: native `-Hfix/99-red` (value-attached) → the branch', () => {
  const { seg, route } = headCtx('gh pr create -Hfix/99-red --base next --title x --body b');
  assert.strictEqual(resolveHead(seg, route), 'fix/99-red');
});

test('CHD-03 resolveHead: native `--head=<branch>` → the branch', () => {
  const { seg, route } = headCtx('gh pr create --head=feat/9-x --base next --title x --body b');
  assert.strictEqual(resolveHead(seg, route), 'feat/9-x');
});

test('CHD-03 resolveHead: native `--head <branch>` (space) → the branch', () => {
  const { seg, route } = headCtx('gh pr create --head fix/12-y --base next --title x --body b');
  assert.strictEqual(resolveHead(seg, route), 'fix/12-y');
});

test('CHD-03 resolveHead: native `--head <owner:branch>` → the raw owner:branch form', () => {
  const { seg, route } = headCtx('gh pr create --head dave:fix/3-y --base next --title x --body b');
  assert.strictEqual(resolveHead(seg, route), 'dave:fix/3-y');
});

test('CHD-03 resolveHead: native with NO --head/-H → null (gate falls back to deps.branch)', () => {
  const { seg, route } = headCtx('gh pr create --base next --title x --body b');
  assert.strictEqual(resolveHead(seg, route), null);
});

test('CHD-03 resolveHead: gh-api `-H Accept: …` is NOT read as head (route-scoping) → null', () => {
  const { seg, route } = headCtx(
    `gh api -X POST repos/o/r/pulls -H 'Accept: application/vnd.github+json' -f base=next -f title=x`
  );
  assert.strictEqual(route, 'gh-api');
  assert.strictEqual(resolveHead(seg, route), null);
});

test('CHD-03 resolveHead: gh-api reads `-f head=` when present', () => {
  const { seg, route } = headCtx('gh api -X POST repos/o/r/pulls -f head=feat/7-x -f base=next');
  assert.strictEqual(route, 'gh-api');
  assert.strictEqual(resolveHead(seg, route), 'feat/7-x');
});

test('CHD-03 resolveHead: curl reads JSON "head", ignores `-H` header', () => {
  const payload = JSON.stringify({ head: 'feat/8-x', base: 'next', body: 'b' });
  const { seg, route } = headCtx(
    `curl -X POST https://api.github.com/repos/o/r/pulls -H 'Accept: application/vnd.github+json' -d '${payload}'`
  );
  assert.strictEqual(route, 'curl');
  assert.strictEqual(resolveHead(seg, route), 'feat/8-x');
});

test('CHD-03 resolveHead: curl with NO head field → null', () => {
  const payload = JSON.stringify({ base: 'next', body: 'b' });
  const { seg, route } = headCtx(
    `curl -X POST https://api.github.com/repos/o/r/pulls -d '${payload}'`
  );
  assert.strictEqual(resolveHead(seg, route), null);
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
