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
  extractLinkedIssues,
  defaultReadIssueLabels,
  defaultReadChangedFiles,
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

// PORTABILITY (2026-07-30): these LIVE requires were hardcoded to `/home/dave/repos/gsd-core/...`,
// so this file only ever loaded on one machine — CI surfaced it as `Cannot find module` on the
// first run. Resolve the checkout the way the rest of the toolkit does (GSD_CORE_ROOT, then
// ~/repos/gsd-core, then ~/gsd-core) and SKIP the whole LIVE-backed file when none is reachable.
// Skipping is the honest option: fabricating a stand-in for a LIVE gsd-core script would make this
// suite assert against a fiction (the same reason fault-injection.test.cjs refuses to fake a
// sentinel layout). CI's `compat` job sets GSD_CORE_ROOT so these RUN for real there.
const os = require('node:os');
const path = require('node:path');
const { resolveGsdCoreRoot } = require('./lib/resolve.cjs');

function liveGsdCoreRootOrNull() {
  const candidates = [
    process.env.GSD_CORE_ROOT,
    path.join(os.homedir(), 'repos', 'gsd-core'),
    path.join(os.homedir(), 'gsd-core'),
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      return resolveGsdCoreRoot(c);
    } catch (_) {
      /* try the next candidate */
    }
  }
  return null;
}

const LIVE_ROOT = liveGsdCoreRootOrNull();
if (!LIVE_ROOT) {
  test('LIVE-backed suite (gh-pr-create.test.cjs)', {
    skip:
      'no gsd-core checkout reachable via GSD_CORE_ROOT / ~/repos/gsd-core / ~/gsd-core — ' +
      'LIVE-backed cases SKIPPED (never fabricate a stand-in for a LIVE script)',
  }, () => {});
  return;
}
const liveScript = (rel) => require(path.join(LIVE_ROOT, rel));

const liveTemplate = liveScript('scripts/pr-template-policy.cjs');
const liveTarget = liveScript('scripts/pr-target-policy.cjs');
// CF-01: the LIVE conventional-title matcher (evaluatePrTitle) injected into every test so the
// title gate is exercised hermetically — the SAME single-source script the production runPrGate
// resolves via requireLiveScript (D-01/D-06/HARD-02: never a forked regex).
const liveTitle = liveScript('scripts/release-notes/conventional-title.cjs');
// CF-03: the LIVE docs-required lint (evaluateLint / readFragmentsFromDisk) injected into every
// test so the docs-required mirror is exercised against the REAL upstream verdict — the SAME
// single-source script production resolves via requireLiveScript (D-01/D-06/HARD-02: never forked).
const liveDocsLint = liveScript('scripts/lint-docs-required.cjs');
// CF-09: the LIVE changeset lint (presence), injected alongside the docs lint (pairing) so the
// unit suite exercises the REAL upstream verdict for both.
const liveChangesetLint = liveScript('scripts/changeset/lint.cjs');
// CF-10: the LIVE capability-manifest validators — the SAME script bin/verify-capability.cjs
// reuses, so the unit suite exercises the real upstream schema rather than a stub.
const liveCapRegistry = liveScript('scripts/gen-capability-registry.cjs');

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
      liveTitle, // CF-01: the LIVE conventional-title matcher (evaluatePrTitle)
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
      // CF-02: default to an APPROVED linked issue so pre-existing enhancement/feature title
      // tests (e.g. feat(#39)!: x) stay green — they are not perturbed by the new approval-label
      // condition. CF-02 tests inject `readIssueLabels: () => []` (or a throwing stub) to
      // exercise the deny / fail-closed paths.
      readIssueLabels: () => ['approved-feature', 'approved-enhancement'],
      // CF-03: default to the LIVE docs-required lint + an EMPTY changed-file list so the
      // pre-existing tests (no changeset fragments touched) resolve to OK_NO_TRIGGERING_FRAGMENTS
      // → allow — unperturbed by the new docs-required condition. CF-03 tests override
      // `worktreeRoot` (a temp .changeset/ root) + `readChangedFiles` to exercise the deny paths.
      liveDocsLint,
      liveChangesetLint,
      liveCapRegistry,
      readChangedFiles: () => [],
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
    input(`gh pr create --base next --title "fix(#12): x" --body "${escapeNl(GOOD_PR_BODY)}"`),
    deps()
  );
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

test('missing/empty body → template invalid → DENY (ENF-02)', () => {
  const d = runPrGate(input('gh pr create --base next --title "fix(#12): x" --body ""'), deps());
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /template/i);
});

test('wrong-template body → DENY (ENF-02)', () => {
  const d = runPrGate(
    input('gh pr create --base next --title "fix(#12): x" --body "just some prose, no template"'),
    deps()
  );
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /template/i);
});

test('base main from a non-allowed head → classifyPrTarget blocked → DENY (ENF-10)', () => {
  const d = runPrGate(
    input(`gh pr create --base main --title "fix(#12): x" --body "${escapeNl(GOOD_PR_BODY)}"`),
    deps({ branch: 'fix/12-the-thing' })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /base|target|main/i);
});

test('unusual base → DENY (conservative contribution stance)', () => {
  const d = runPrGate(
    input(`gh pr create --base some-random-branch --title "fix(#12): x" --body "${escapeNl(GOOD_PR_BODY)}"`),
    deps()
  );
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /base|target|unusual/i);
});

test('body lacks Fixes #N (toolkit-owned link check) → DENY, worded as ours', () => {
  const d = runPrGate(
    input(`gh pr create --base next --title "fix(#12): x" --body "${escapeNl(NO_LINK_BODY)}"`),
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
    input(`gh pr create --base next --title "fix(#12): x" --body "${escapeNl(body)}"`),
    deps()
  );
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

test('branch with a non-conventional prefix → DENY, worded as ours', () => {
  const d = runPrGate(
    input(`gh pr create --base next --title "fix(#12): x" --body "${escapeNl(GOOD_PR_BODY)}"`),
    deps({ branch: 'my-random-branch' })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /branch/i);
  assert.match(d.permissionDecisionReason, /toolkit|our own|replicat/i);
});

test('gh api POST pulls synonym, bad template → DENY (ENF-15)', () => {
  const cmd = `gh api -X POST repos/o/r/pulls -f title='fix(#12): x' -f body='no template here' -f base=next`;
  const d = runPrGate(input(cmd), deps());
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
});

test('gh api POST pulls synonym, full clean → allow (ENF-15)', () => {
  const cmd = `gh api -X POST repos/o/r/pulls -f title='fix(#12): x' -f base=next -f body='${escapeSingle(GOOD_PR_BODY)}'`;
  const d = runPrGate(input(cmd), deps());
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

// ---- CF-07 (← CR-01): chain-aware pr-create gate --------------------------------------
// The gate must decide gate/no-gate from ANY governed segment (hasGovernedSegment), not the
// FIRST actionable segment (classifyAction). Pre-CF-07 these RED cases collapse the chain to
// `commit` / a benign pr-create and ALLOW; after the fix the pr-create gate is REACHED (and a
// trailing failClosed synonym is unmasked), while non-governed chains still ALLOW.

test('CF-07: git commit && gh pr create (non-conforming title) → REACHES gate → DENY (CF-01)', () => {
  const d = runPrGate(
    input(`git commit -m x && gh pr create --base next --title "fix(core): x" --body "${escapeNl(GOOD_PR_BODY)}"`),
    deps()
  );
  // pre-CF-07: collapses to `commit` → allow. Post-CF-07: gate reached, CF-01 denies the
  // missing-issue-ref title (`fix(core)` has no `#N`).
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
  assert.match(d.permissionDecisionReason, /title|conventional|CF-01/i);
});

test('CF-07: gh pr create <valid> && gh api POST issues/weird → DENY (trailing failClosed, ENF-15)', () => {
  const cmd =
    `gh pr create --base next --title "fix(#12): x" --body "${escapeNl(GOOD_PR_BODY)}"` +
    ` && gh api -X POST repos/open-gsd/gsd-core/issues/weird`;
  const d = runPrGate(input(cmd), deps());
  // pre-CF-07: classifyAction returns pr-create first, masking the trailing unclassifiable
  // mutating synonym → allow. Post-CF-07: hasFailClosedSegment scans all segments FIRST → deny.
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
});

test('CF-07 narrows-not-weakens: git status && ls → allow (no governed segment)', () => {
  const d = runPrGate(input('git status && ls'), deps());
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

test('CF-07 narrows-not-weakens: echo hi && gh repo view o/r → allow (no governed segment)', () => {
  const d = runPrGate(input('echo hi && gh repo view o/r'), deps());
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

test('CF-07: bare gh pr create <valid> (single segment) → allow (decision unchanged)', () => {
  const d = runPrGate(
    input(`gh pr create --base next --title "fix(#12): x" --body "${escapeNl(GOOD_PR_BODY)}"`),
    deps()
  );
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
    input(`gh pr create --base next --title "fix(#12): x" --body "${escapeNl(GOOD_PR_BODY)}"`),
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
    input(`gh pr create --base next --title "fix(#12): x" --body "${escapeNl(GOOD_PR_BODY)}"`),
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
    input(`gh pr create --base next --title "fix(#12): x" --body "${escapeNl(GOOD_PR_BODY)}"`),
    deps({ listPrsForHead: () => EXISTING_PR, readCheckRuns: () => ci() })
  );
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

test('ENF-18: a not-green conclusion (failure) → DENY naming the CI check-run + head SHA', () => {
  const d = runPrGate(
    input(`gh pr create --base next --title "fix(#12): x" --body "${escapeNl(GOOD_PR_BODY)}"`),
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
    input(`gh pr create --base next --title "fix(#12): x" --body "${escapeNl(GOOD_PR_BODY)}"`),
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
    input(`gh pr create --base next --title "fix(#12): x" --body "${escapeNl(GOOD_PR_BODY)}"`),
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
  const d = runPrGate(input('gh pr create --base next --title "fix(#12): x" --body ""'), deps({
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
  const cmd = `gh api -X POST repos/o/r/pulls -f title='fix(#12): x' -f base=next -f body='${escapeSingle(GOOD_PR_BODY)}'`;
  const d = runPrGate(input(cmd), deps({ listPrsForHead: () => EXISTING_PR, readCheckRuns: () => ci() }));
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

test('ENF-18 synonym: gh api POST pulls, not-green CI → DENY', () => {
  const cmd = `gh api -X POST repos/o/r/pulls -f title='fix(#12): x' -f base=next -f body='${escapeSingle(GOOD_PR_BODY)}'`;
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
  const payload = JSON.stringify({ title: 'fix(#12): x', base: 'next', body: GOOD_PR_BODY });
  const cmd = `curl -X POST https://api.github.com/repos/o/r/pulls -d '${payload.replace(/'/g, "'\\''")}'`;
  const d = runPrGate(input(cmd), deps({ listPrsForHead: () => EXISTING_PR, readCheckRuns: () => ci() }));
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

test('ENF-18 synonym: curl POST pulls, not-green CI → DENY', () => {
  const payload = JSON.stringify({ title: 'fix(#12): x', base: 'next', body: GOOD_PR_BODY });
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
    input('gh pr create --base next --title "fix(#12): x" --body "just some prose, no template"'),
    deps()
  );
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /template/i);
  // The new --fill branch did NOT steal a body-bearing command.
  assert.doesNotMatch(d.permissionDecisionReason, /--fill|--web|cannot observe/i);
});

test('WR-04 no-regression: a fully-valid --body PR still ALLOWS', () => {
  const d = runPrGate(
    input(`gh pr create --base next --title "fix(#12): x" --body "${escapeNl(GOOD_PR_BODY)}"`),
    deps()
  );
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

// ── IN-01: the ENF-18 CI deny reason states the all-runs-must-conclude-success stance ──
test('IN-01: ENF-18 deny reason prominently states EVERY check-run must conclude success', () => {
  const d = runPrGate(
    input(`gh pr create --base next --title "fix(#12): x" --body "${escapeNl(GOOD_PR_BODY)}"`),
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
    input('cd /tmp && gh pr create -R open-gsd/gsd-core --base next --title "fix(#12): x" --body "b"'),
    robDenyingOverride
  );
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
  assert.match(d.permissionDecisionReason, /open-gsd\/gsd-core|checkout|verify/i);
});

test('ROB-01: out-of-tree pr create -R to a FORK (dave/gsd-core-fork) → ALLOW (no false deny)', () => {
  const d = runPrGate(
    input('cd /tmp && gh pr create -R dave/gsd-core-fork --base next --title "fix(#12): x" --body "b"'),
    robDenyingOverride
  );
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

// --- RES-01: action-first short-circuit fires BEFORE resolveExplicitTarget + resolve ---
// D-09(a): a NON-governed command against a worktreeRoot whose LIVE pr-template/pr-target
// policies are missing (no liveTemplate/liveTarget injected) must ALLOW — proving the
// classify-first guard short-circuits before requireLiveScript is ever reached.
test('RES-01: non-governed command (git status) with a MISSING live-policy root → ALLOW (short-circuit before resolve)', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-noscript-nongov-'));
  const d = runPrGate(
    input('git status'),
    Object.assign({ worktreeRoot: root }, robDenyingOverride)
  );
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

// D-09(b), HARD-02: the SAME missing-policy root with a GOVERNED pr-create STILL DENIES —
// requireLiveScript throws → fail closed. Opposite verdict, same root, decided purely by
// whether the action is governed. Proves the short-circuit does not weaken HARD-02.
test('RES-01/HARD-02: governed pr-create with a MISSING live-policy root → DENY', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-noscript-gov-'));
  const d = runPrGate(
    input(`gh pr create --base next --title "fix(#12): x" --body "${escapeNl(GOOD_PR_BODY)}"`),
    Object.assign({ worktreeRoot: root }, robDenyingOverride)
  );
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
});

// Correctness improvement: a non-pr-create command carrying an odd -R must NOT be
// spuriously fail-closed by resolveExplicitTarget (the guard sits ABOVE it). `gh issue
// list -R <unparseable>` is non-governed by the pr gate → ALLOW despite the -R.
test('RES-01: non-governed command with an odd -R is NOT fail-closed by explicit-target extraction', () => {
  const d = runPrGate(input('gh issue list -R not a valid repo spec'), robDenyingOverride);
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
    input(`gh pr create --base next --title "fix(#12): x" --body "${escapeNl(GOOD_PR_BODY)}"`),
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
    input(`gh pr create --base next --title "fix(#12): x" --body "${escapeNl(GOOD_PR_BODY)}"`),
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
    input(`gh pr create --base next --title "fix(#12): x" --body "${escapeNl(GOOD_PR_BODY)}"`),
    deps({ listPrsForHead: () => EXISTING_PR, readCheckRuns: () => ci() })
  );
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

test('ROB-02: an unreadable listPrsForHead (gh unauth, throws) → FAIL CLOSED deny (HARD-01)', () => {
  const d = runPrGate(
    input(`gh pr create --base next --title "fix(#12): x" --body "${escapeNl(GOOD_PR_BODY)}"`),
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
    input(`gh pr create --base next --title "fix(#12): x" --body "${escapeNl(NO_LINK_BODY)}"`),
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
    input(`gh pr create --base main --title "fix(#12): x" --body "${escapeNl(GOOD_PR_BODY)}"`),
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
    input(`gh pr create --base next --title "fix(#12): x" --body "${escapeNl(GOOD_PR_BODY)}"`),
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
    input(`gh pr create -R open-gsd/gsd-core --base next --title "fix(#12): x" --body "${escapeNl(GOOD_PR_BODY)}"`),
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
    input(`gh pr create -R Open-GSD/GSD-Core --base next --title "fix(#12): x" --body "${escapeNl(GOOD_PR_BODY)}"`),
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
    input(`GH_REPO=open-gsd/gsd-core gh pr create --base next --title "fix(#12): x" --body "${escapeNl(GOOD_PR_BODY)}"`),
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
    input(`gh pr create --base next --title "fix(#12): x" --body "${escapeNl(GOOD_PR_BODY)}"`),
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
    input(`gh pr create -R weird::garbage --base next --title "fix(#12): x" --body "${escapeNl(GOOD_PR_BODY)}"`),
    // Were the explicit target ignored, the empty open-PR list would be a first-create ALLOW;
    // the unparseable explicit target must instead fail closed (no silent origin-fallback ALLOW).
    deps({ listPrsForHead: () => [] })
  );
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
});

// ── CHD-03 Task 2: the resolved --head drives ENF-10 + listPrsForHead + CI read ──
// A `--head`/`-H` PR must be gated on the branch it actually opens FROM (CR-04). The bare
// `--head red-ci` branch feeds ENF-10 / listPrsForHead / the head-SHA CI read; an `owner:branch`
// cross-repo head reads its check-runs from the HEAD owner's repo; an unresolvable head denies.

test('CHD-03: `-H <conforming>` with an existing red-CI PR on that branch → DENY (CI gate on the --head branch; Goodhart)', () => {
  let listBranch = 'UNSET';
  const d = runPrGate(
    input(`gh pr create -H fix/99-red --base next --title "fix(#12): x" --body "${escapeNl(GOOD_PR_BODY)}"`),
    deps({
      branch: 'fix/12-the-thing', // the CURRENT branch — must NOT be what the gate evaluates
      listPrsForHead: (branch) => { listBranch = branch; return EXISTING_PR; },
      readCheckRuns: () =>
        ci({ allRequiredGreen: false, conclusions: [{ name: 'Tests', status: 'completed', conclusion: 'failure' }] }),
    })
  );
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
  assert.match(d.permissionDecisionReason, /check.?run|CI|head/i);
  // GOODHART: the decision fired on the RESOLVED --head branch, not the current branch.
  assert.strictEqual(listBranch, 'fix/99-red');
  assert.notStrictEqual(listBranch, 'fix/12-the-thing');
});

test('CHD-03: `-H <conforming>` first-create (empty PR list) → ALLOW; listPrsForHead keyed on the --head branch', () => {
  let listBranch = 'UNSET';
  const d = runPrGate(
    input(`gh pr create -H fix/77-x --base next --title "fix(#12): x" --body "${escapeNl(GOOD_PR_BODY)}"`),
    deps({
      branch: 'fix/12-the-thing',
      listPrsForHead: (branch) => { listBranch = branch; return []; }, // first create on the --head branch
      readCheckRuns: () => { throw new Error('must be SKIPPED on a first create'); },
    })
  );
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
  assert.strictEqual(listBranch, 'fix/77-x');
});

test('CHD-03: `-H bad_branch_name` → DENY via ENF-10 branch-name on the --head branch (not the current branch)', () => {
  const d = runPrGate(
    input(`gh pr create -H bad_branch_name --base next --title "fix(#12): x" --body "${escapeNl(GOOD_PR_BODY)}"`),
    deps({ branch: 'fix/12-the-thing' }) // current branch IS conforming — the deny must come from --head
  );
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
  assert.match(d.permissionDecisionReason, /branch/i);
  assert.match(d.permissionDecisionReason, /bad_branch_name/);
  assert.match(d.permissionDecisionReason, /toolkit|our own|replicat/i);
});

test('CHD-03: an unresolvable `--head` (CI read for the resolved head throws) → FAIL CLOSED deny', () => {
  const d = runPrGate(
    input(`gh pr create -H fix/55-x --base next --title "fix(#12): x" --body "${escapeNl(GOOD_PR_BODY)}"`),
    deps({
      branch: 'fix/12-the-thing',
      listPrsForHead: () => EXISTING_PR,
      readCheckRuns: () => { throw new Error('gh: cannot resolve head SHA for fix/55-x'); },
    })
  );
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
});

test('CHD-03: `--head owner:branch` → branch-name uses the branch portion; check-runs read the HEAD owner repo; PR-list reads the base repo', () => {
  let listBranch = 'UNSET'; let listTarget = 'UNSET'; let ciTarget = 'UNSET';
  const d = runPrGate(
    input(`gh pr create -R open-gsd/gsd-core --head dave:fix/3-y --base next --title "fix(#12): x" --body "${escapeNl(GOOD_PR_BODY)}"`),
    deps({
      branch: 'fix/12-the-thing',
      listPrsForHead: (branch, target) => { listBranch = branch; listTarget = target; return EXISTING_PR; },
      readCheckRuns: (sha, target) => { ciTarget = target; return ci(); }, // green
    })
  );
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
  // branch-name / listPrsForHead evaluate the BRANCH portion (fix/3-y matches fix/<n>-…).
  assert.strictEqual(listBranch, 'fix/3-y');
  // the OPEN-PR list reads the BASE repo (where the PR opens).
  assert.deepStrictEqual(listTarget, { owner: 'open-gsd', repo: 'gsd-core' });
  // the check-runs read the HEAD owner's repo (dave's fork; same repo name as the base).
  assert.deepStrictEqual(ciTarget, { owner: 'dave', repo: 'gsd-core' });
});

test('CHD-03: `--head owner:branch` with a red check-run in the HEAD owner repo → DENY (head repo CI)', () => {
  let ciTarget = 'UNSET';
  const d = runPrGate(
    input(`gh pr create -R open-gsd/gsd-core --head dave:fix/3-y --base next --title "fix(#12): x" --body "${escapeNl(GOOD_PR_BODY)}"`),
    deps({
      branch: 'fix/12-the-thing',
      listPrsForHead: () => EXISTING_PR,
      readCheckRuns: (sha, target) => {
        ciTarget = target;
        return ci({ allRequiredGreen: false, conclusions: [{ name: 'Tests', status: 'completed', conclusion: 'failure' }] });
      },
    })
  );
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
  assert.match(d.permissionDecisionReason, /check.?run|CI|head/i);
  assert.deepStrictEqual(ciTarget, { owner: 'dave', repo: 'gsd-core' });
});

// ── CHD-03 Task 1: route-scoped --head/-H resolver (resolveHead) ────────────────
// `-H` is ALSO gh's HTTP-header flag (the hook's own `gh api -H 'Accept: …'`, and the
// user's gh-api/curl routes), so the head lookup is scoped to the NATIVE `gh pr create`
// route ONLY. On the gh-api / curl routes the head travels via `-f head=` / JSON, never `-H`.

test('CHD-03 resolveHead: native `-H <branch>` → the branch', () => {
  const { seg, route } = headCtx('gh pr create -H fix/99-red --base next --title "fix(#12): x" --body b');
  assert.strictEqual(route, 'native');
  assert.strictEqual(resolveHead(seg, route), 'fix/99-red');
});

test('CHD-03 resolveHead: native `-Hfix/99-red` (value-attached) → the branch', () => {
  const { seg, route } = headCtx('gh pr create -Hfix/99-red --base next --title "fix(#12): x" --body b');
  assert.strictEqual(resolveHead(seg, route), 'fix/99-red');
});

test('CHD-03 resolveHead: native `--head=<branch>` → the branch', () => {
  const { seg, route } = headCtx('gh pr create --head=feat/9-x --base next --title "fix(#12): x" --body b');
  assert.strictEqual(resolveHead(seg, route), 'feat/9-x');
});

test('CHD-03 resolveHead: native `--head <branch>` (space) → the branch', () => {
  const { seg, route } = headCtx('gh pr create --head fix/12-y --base next --title "fix(#12): x" --body b');
  assert.strictEqual(resolveHead(seg, route), 'fix/12-y');
});

test('CHD-03 resolveHead: native `--head <owner:branch>` → the raw owner:branch form', () => {
  const { seg, route } = headCtx('gh pr create --head dave:fix/3-y --base next --title "fix(#12): x" --body b');
  assert.strictEqual(resolveHead(seg, route), 'dave:fix/3-y');
});

test('CHD-03 resolveHead: native with NO --head/-H → null (gate falls back to deps.branch)', () => {
  const { seg, route } = headCtx('gh pr create --base next --title "fix(#12): x" --body b');
  assert.strictEqual(resolveHead(seg, route), null);
});

test('CHD-03 resolveHead: gh-api `-H Accept: …` is NOT read as head (route-scoping) → null', () => {
  const { seg, route } = headCtx(
    `gh api -X POST repos/o/r/pulls -H 'Accept: application/vnd.github+json' -f base=next -f title='fix(#12): x'`
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

// ── CF-01: the LIVE conventional-title PR-title gate ────────────────────────────
// A `gh pr create` whose --title is not `<type>(#<issue>): summary` is DENIED before the PR
// opens, by calling gsd-core's LIVE evaluatePrTitle (never a forked regex — D-01/D-06/HARD-02).
// The check sits BETWEEN the ENF-10 base check and the toolkit-owned linked-issue check; a
// conforming title passes through and the gate reaches its existing checks (allow on a
// first-create). gsd-core's pr-title-validator.yml is WARN_ONLY:false, so this surfaces the
// required-check failure BEFORE the PR is opened (#1549).

test('CF-01: conforming native title fix(#12): x → allow (reaches the existing checks)', () => {
  const d = runPrGate(
    input(`gh pr create --base next --title "fix(#12): x" --body "${escapeNl(GOOD_PR_BODY)}"`),
    deps()
  );
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

test('CF-01: conforming breaking-change title feat(#39)!: x → allow', () => {
  const d = runPrGate(
    input(`gh pr create --base next --title 'feat(#39)!: x' --body "${escapeNl(GOOD_PR_BODY)}"`),
    deps()
  );
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

test('CF-01: missing issue ref fix(core): x → DENY with the LIVE conventional-title format text', () => {
  const d = runPrGate(
    input(`gh pr create --base next --title 'fix(core): x' --body "${escapeNl(GOOD_PR_BODY)}"`),
    deps()
  );
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
  // The message came from the LIVE evaluatePrTitle (its REQUIRED_FORMAT_MESSAGE), not a fork.
  assert.match(d.permissionDecisionReason, /type\(#<issue>\)|issue ref/i);
  assert.match(d.permissionDecisionReason, /CF-01/);
});

test('CF-01: leading tag [security] fix(#12): x → DENY (bad-prefix) with the LIVE format text', () => {
  const d = runPrGate(
    input(`gh pr create --base next --title '[security] fix(#12): x' --body "${escapeNl(GOOD_PR_BODY)}"`),
    deps()
  );
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
  assert.match(d.permissionDecisionReason, /type\(#<issue>\)|leading tag/i);
  assert.match(d.permissionDecisionReason, /CF-01/);
});

test('CF-01: empty/absent native title → DENY with a "provide --title" unobservable message', () => {
  const d = runPrGate(
    input(`gh pr create --base next --body "${escapeNl(GOOD_PR_BODY)}"`),
    deps()
  );
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
  assert.match(d.permissionDecisionReason, /--title|-t\b|not observable|explicit/i);
  assert.match(d.permissionDecisionReason, /CF-01/);
});

test('CF-01 gh-api route: -f title=conforming → allow; -f title=bad → DENY', () => {
  const good = `gh api -X POST repos/o/r/pulls -f title='fix(#12): x' -f base=next -f body='${escapeSingle(GOOD_PR_BODY)}'`;
  assert.strictEqual(runPrGate(input(good), deps()).permissionDecision, 'allow');
  const bad = `gh api -X POST repos/o/r/pulls -f title='fix(core): x' -f base=next -f body='${escapeSingle(GOOD_PR_BODY)}'`;
  const d = runPrGate(input(bad), deps());
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
  assert.match(d.permissionDecisionReason, /CF-01/);
});

// D-05 regression fixture: keep BOTH a denying non-conforming title AND an allowing conforming
// title in the committed suite so a future regression that weakens the gate is caught.
test('CF-01 regression (D-05): non-conforming title denies, conforming title allows', () => {
  const bad = runPrGate(
    input(`gh pr create --base next --title 'nope' --body "${escapeNl(GOOD_PR_BODY)}"`),
    deps()
  );
  assert.strictEqual(bad.permissionDecision, 'deny', bad.permissionDecisionReason);
  const good = runPrGate(
    input(`gh pr create --base next --title 'fix(#12): roadmap rollback' --body "${escapeNl(GOOD_PR_BODY)}"`),
    deps()
  );
  assert.strictEqual(good.permissionDecision, 'allow', good.permissionDecisionReason);
});

// CF-01 fail-closed (HARD-02): a gsd-core-targeting create whose LIVE conventional-title script
// cannot load fails CLOSED — the same requireLiveScript discipline as the template/target scripts.
// Inject working liveTemplate/liveTarget/branch but NOT liveTitle, with a root that lacks the
// script, so the deny provably comes from the unresolvable title script (not template/target).
test('CF-01/HARD-02: governed pr-create with a missing LIVE conventional-title script → DENY (fail closed)', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-notitle-'));
  const d = runPrGate(
    input(`gh pr create --base next --title "fix(#12): x" --body "${escapeNl(GOOD_PR_BODY)}"`),
    {
      worktreeRoot: root,
      liveTemplate,
      liveTarget,
      branch: 'fix/12-the-thing',
      // liveTitle deliberately NOT injected → requireLiveScript(root, conventional-title) throws.
      overrideImpl: { checkOverride: () => ({ override: false }), writeReceipt: () => {} },
    }
  );
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
});

// ── CF-02: the approval-ordering pre-check (auto-close-unsolicited-prs, replicated H-A) ──
// For a Feature/Enhancement bucket (LIVE classifyBucket — D-01 reuse, never a forked
// discriminator), the PR's linked issue must carry a maintainer-applied
// approved-feature/approved-enhancement label, else DENY before the PR opens (pre-empting the
// CI auto-close). Fix-bucket PRs are UNAFFECTED (D-04); an unreadable label read fails closed
// (D-04). The label reader is INJECTED for hermeticity — no real network.

// A GOOD_PR_BODY variant whose linked issue is `ref` instead of #12.
function bodyLinking(ref) {
  return GOOD_PR_BODY.replace('Fixes #12', 'Fixes #' + ref);
}

test('CF-02: feat PR (Feature) whose linked issue lacks an approval label → DENY (toolkit-owned)', () => {
  const d = runPrGate(
    input(`gh pr create --base next --title 'feat(#39)!: x' --body "${escapeNl(bodyLinking(39))}"`),
    deps({ readIssueLabels: () => [] })
  );
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
  // H-A: phrased as the toolkit's OWN check (replicated from the CI workflow), naming the labels.
  assert.match(d.permissionDecisionReason, /toolkit|our own|replicat/i);
  assert.match(d.permissionDecisionReason, /approved-feature|approved-enhancement/);
});

test('CF-02: enhance PR (Enhancement) whose linked issue lacks approval → DENY', () => {
  const d = runPrGate(
    input(`gh pr create --base next --title 'enhance(#1549): x' --body "${escapeNl(bodyLinking(1549))}"`),
    deps({ readIssueLabels: () => [] })
  );
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
  assert.match(d.permissionDecisionReason, /approved-feature|approved-enhancement/);
});

test('CF-02: feat PR whose linked issue carries approved-feature → allow', () => {
  const d = runPrGate(
    input(`gh pr create --base next --title 'feat(#39): x' --body "${escapeNl(bodyLinking(39))}"`),
    deps({ readIssueLabels: (n) => (n === 39 ? ['approved-feature'] : []) })
  );
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

test('CF-02: enhance PR whose linked issue carries approved-enhancement → allow', () => {
  const d = runPrGate(
    input(`gh pr create --base next --title 'enhance(#1549): x' --body "${escapeNl(bodyLinking(1549))}"`),
    deps({ readIssueLabels: (n) => (n === 1549 ? ['approved-enhancement'] : []) })
  );
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

test('CF-02: fix PR (Fix bucket) with an unapproved linked issue → ALLOW (unaffected, D-04)', () => {
  let read = false;
  const d = runPrGate(
    input(`gh pr create --base next --title 'fix(#12): x' --body "${escapeNl(GOOD_PR_BODY)}"`),
    deps({ readIssueLabels: () => { read = true; return []; } })
  );
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
  assert.strictEqual(read, false, 'the approval-label read must be SKIPPED for a fix-bucket PR');
});

test('CF-02: an unreadable label read (throws) for a feat PR → FAIL CLOSED deny (D-04)', () => {
  const d = runPrGate(
    input(`gh pr create --base next --title 'feat(#39): x' --body "${escapeNl(bodyLinking(39))}"`),
    deps({ readIssueLabels: () => { throw new Error('gh: not authenticated'); } })
  );
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
});

test('CF-02: two linked issues, only one carries an approval label → allow (any-approved)', () => {
  const body = bodyLinking(39).replace('Fixes #39', 'Fixes #39, Closes #40');
  const d = runPrGate(
    input(`gh pr create --base next --title 'feat(#39): x' --body "${escapeNl(body)}"`),
    deps({ readIssueLabels: (n) => (n === 40 ? ['approved-enhancement'] : []) })
  );
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

// D-05 regression fixture: keep BOTH an unapproved-enh deny AND an approved-enh allow committed
// so a future regression that weakens the CF-02 gate is caught.
test('CF-02 regression (D-05): an unapproved enhancement denies AND an approved enhancement allows', () => {
  const denied = runPrGate(
    input(`gh pr create --base next --title 'enhance(#1549): add x' --body "${escapeNl(bodyLinking(1549))}"`),
    deps({ readIssueLabels: () => [] })
  );
  assert.strictEqual(denied.permissionDecision, 'deny', denied.permissionDecisionReason);
  const allowed = runPrGate(
    input(`gh pr create --base next --title 'enhance(#1549): add x' --body "${escapeNl(bodyLinking(1549))}"`),
    deps({ readIssueLabels: () => ['approved-enhancement'] })
  );
  assert.strictEqual(allowed.permissionDecision, 'allow', allowed.permissionDecisionReason);
});

// extractLinkedIssues — the same-repo closing-keyword number extraction (mirrors the LIVE
// workflow's ref semantics).
test('CF-02 extractLinkedIssues: bare #N with a closing keyword; dedups; ignores code fences', () => {
  assert.deepStrictEqual(extractLinkedIssues('Fixes #12 and Closes #12 and Resolves #34'), [12, 34]);
  assert.deepStrictEqual(extractLinkedIssues('```\nFixes #99\n```\nFixes #7'), [7]);
  assert.deepStrictEqual(extractLinkedIssues('a bare #55 with no keyword is ignored'), []);
  assert.deepStrictEqual(extractLinkedIssues('no refs here'), []);
});

test('CF-02 extractLinkedIssues: cross-repo / URL refs count ONLY for the target repo (T-30-02-01)', () => {
  const tr = { owner: 'open-gsd', repo: 'gsd-core' };
  assert.deepStrictEqual(extractLinkedIssues('Fixes open-gsd/gsd-core#5', tr), [5]);
  assert.deepStrictEqual(
    extractLinkedIssues('Closes https://github.com/open-gsd/gsd-core/issues/8', tr),
    [8]
  );
  assert.deepStrictEqual(extractLinkedIssues('Fixes other/repo#5', tr), []);
  // No target repo → cross-repo refs cannot be confirmed same-repo → excluded (bare #N still counts).
  assert.deepStrictEqual(extractLinkedIssues('Fixes other/repo#5 and Closes #9'), [9]);
});

test('CF-02 extractLinkedIssues: caps the read fan-out at 20 (DoS bound, T-30-02-03)', () => {
  const body = Array.from({ length: 30 }, (_, i) => 'Fixes #' + (i + 1)).join('\n');
  assert.strictEqual(extractLinkedIssues(body).length, 20);
});

// defaultReadIssueLabels — the default gh-api reader's input hardening (T-30-02-02): a
// non-positive-integer issue number is rejected BEFORE any spawn, so a crafted number cannot be
// interpolated into the gh api path.
test('CF-02: defaultReadIssueLabels rejects a non-positive-integer issue number before any spawn (T-30-02-02)', () => {
  assert.throws(() => defaultReadIssueLabels('/tmp', 'not-a-number', { owner: 'o', repo: 'r' }));
  assert.throws(() => defaultReadIssueLabels('/tmp', 0, { owner: 'o', repo: 'r' }));
  assert.throws(() => defaultReadIssueLabels('/tmp', -3, { owner: 'o', repo: 'r' }));
  assert.throws(() => defaultReadIssueLabels('/tmp', 1.5, { owner: 'o', repo: 'r' }));
});

// Task 2: the default reader is WIRED in runPrGate. With NO injected readIssueLabels, an
// enh/feat gsd-core-targeting create whose label read is unreadable fails closed (deny). Here a
// non-git temp root makes the default reader's origin resolution throw → runGate fail-closed
// deny; liveTitle/template/target are injected so the deny provably comes from the label read.
test('CF-02 Task 2: with NO injected readIssueLabels, an unreadable label read fails closed (deny)', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-cf02-labels-'));
  const d = runPrGate(
    input(`gh pr create --base next --title 'feat(#12): x' --body "${escapeNl(GOOD_PR_BODY)}"`),
    {
      worktreeRoot: root,
      liveTemplate,
      liveTarget,
      liveTitle,
      branch: 'fix/12-the-thing',
      changedFiles: ['src/index.cts'],
      authorAssociation: 'OWNER',
      // CF-03: inject the LIVE docs lint + an empty diff so the setup-phase requireLiveScript for
      // lint-docs-required does NOT throw on this non-gsd-core temp root — keeping the deny
      // provably from the label read (CF-02 runs BEFORE the CF-03 docs check).
      liveDocsLint,
      liveChangesetLint,
      liveCapRegistry,
      readChangedFiles: () => [],
      // readIssueLabels intentionally NOT injected → defaultReadIssueLabels runs.
      overrideImpl: { checkOverride: () => ({ override: false }), writeReceipt: () => {} },
    }
  );
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
});

// ── CF-03: the docs-required mirror (LIVE lint-docs-required reuse — D-01/D-06/HARD-02) ──
// gsd-core's docs-required.yml fails a PR whose changeset introduces Added/Changed/Deprecated/
// Removed behavior without a docs/ change. The toolkit REUSES the LIVE evaluateLint +
// readFragmentsFromDisk exports (never a forked policy) over the PR's changed files (read via an
// injected readChangedFiles, defaulting to `git diff --name-only origin/<base>...HEAD`). Pre-PR,
// labels are passed as [] (the maintainer-applied `no-docs` label cannot be self-applied at open);
// the per-fragment `<!-- docs-exempt: reason -->` opt-out is still honored via the LIVE parse.
// CF-03's require-issue-link half is ALREADY covered by the existing LINKED_ISSUE_RE check (no new
// code). The label read is hermetic: readChangedFiles is injected and the LIVE lint runs against a
// temp .changeset/ root the test controls.

// Build a temp root carrying the given fixture files, returning its absolute path.
function changesetRoot(files) {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-cf03-'));
  fs.mkdirSync(path.join(root, '.changeset'), { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

// A well-formed changeset fragment of the given type (parse.cjs needs `type:` + `pr:` + a body).
function fragment(type, body) {
  return `---\ntype: ${type}\npr: 100\n---\n${body}\n`;
}

const CF03_CREATE = `gh pr create --base next --title 'fix(#12): x' --body "${escapeNl(GOOD_PR_BODY)}"`;

test('CF-03: an Added changeset with NO docs/ change → DENY (FAIL_DOCS_MISSING)', () => {
  const root = changesetRoot({ '.changeset/x.md': fragment('Added', 'a new capability') });
  const d = runPrGate(
    input(CF03_CREATE),
    deps({ worktreeRoot: root, readChangedFiles: () => ['.changeset/x.md'] })
  );
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
  assert.match(d.permissionDecisionReason, /fail_docs_missing/i);
  // mirrors docs-required.yml (#3213) and names the triggering fragment.
  assert.match(d.permissionDecisionReason, /docs-required|#3213/i);
  assert.match(d.permissionDecisionReason, /\.changeset\/x\.md/);
});

test('CF-03: an Added changeset WITH a docs/ change → allow (OK_DOCS_UPDATED)', () => {
  const root = changesetRoot({ '.changeset/x.md': fragment('Added', 'a new capability') });
  const d = runPrGate(
    input(CF03_CREATE),
    deps({ worktreeRoot: root, readChangedFiles: () => ['.changeset/x.md', 'docs/foo.md'] })
  );
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

test('CF-03: a Fixed changeset with no docs → allow (non-triggering type)', () => {
  const root = changesetRoot({ '.changeset/x.md': fragment('Fixed', 'a bug fix') });
  const d = runPrGate(
    input(CF03_CREATE),
    deps({ worktreeRoot: root, readChangedFiles: () => ['.changeset/x.md'] })
  );
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

test('CF-03: a Security changeset with no docs → allow (non-triggering type)', () => {
  const root = changesetRoot({ '.changeset/x.md': fragment('Security', 'a vuln fix') });
  const d = runPrGate(
    input(CF03_CREATE),
    deps({ worktreeRoot: root, readChangedFiles: () => ['.changeset/x.md'] })
  );
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

test('CF-03: a malformed .changeset/*.md fragment → DENY (FAIL_MALFORMED_FRAGMENT)', () => {
  const root = changesetRoot({ '.changeset/x.md': 'this fragment has no frontmatter at all' });
  const d = runPrGate(
    input(CF03_CREATE),
    deps({ worktreeRoot: root, readChangedFiles: () => ['.changeset/x.md'] })
  );
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
  assert.match(d.permissionDecisionReason, /fail_malformed_fragment/i);
});

test('CF-03: no changeset fragments at all → allow (OK_NO_TRIGGERING_FRAGMENTS)', () => {
  const root = changesetRoot({});
  // Fixture narrowed to NON-user-facing paths when CF-09 landed. It previously used
  // ['src/index.cts', 'README.md'] — but `src/` IS user-facing to gsd-core's LIVE changeset lint
  // (verified: evaluateLint(['src/index.cts']) -> fail_missing_fragment), so that PR would have
  // been bounced by upstream `changeset-required.yml` anyway. The old fixture encoded a scenario
  // upstream rejects; CF-09 now catches it locally, which is the whole point. Kept non-user-facing
  // here so this test isolates the CF-03 (docs PAIRING) concern it was written for.
  const d = runPrGate(
    input(CF03_CREATE),
    deps({ worktreeRoot: root, readChangedFiles: () => ['README.md'] })
  );
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

// ─── CF-09: changeset PRESENCE (distinct from CF-03's changeset->docs PAIRING) ───────────────
// gsd-core's changeset-required.yml has NO author exemption, so for a CODEOWNER a missing
// fragment lands as pure CI whiplash. These drive the REAL upstream evaluateLint.

test('CF-09: user-facing change with NO .changeset fragment → deny naming the live verdict', () => {
  const root = changesetRoot({});
  const d = runPrGate(
    input(CF03_CREATE),
    deps({ worktreeRoot: root, readChangedFiles: () => ['src/index.cts'] })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /CF-09/);
  assert.match(d.permissionDecisionReason, /fail_missing_fragment/);
  assert.match(d.permissionDecisionReason, /npm run changeset/, 'the deny must be actionable');
});

test('CF-09: a present .changeset fragment allows (presence satisfied)', () => {
  const root = changesetRoot({});
  const d = runPrGate(
    input(CF03_CREATE),
    deps({
      worktreeRoot: root,
      readChangedFiles: () => ['src/index.cts', '.changeset/some-fix.md'],
    })
  );
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

test('CF-09: a NON-user-facing-only change needs no fragment (no over-blocking)', () => {
  const root = changesetRoot({});
  for (const files of [['README.md'], ['docs/guide.md'], []]) {
    const d = runPrGate(
      input(CF03_CREATE),
      deps({ worktreeRoot: root, readChangedFiles: () => files })
    );
    assert.strictEqual(d.permissionDecision, 'allow', JSON.stringify(files) + ': ' + d.permissionDecisionReason);
  }
});

test('CF-09: a THROW from the live changeset lint fails closed (HARD-01)', () => {
  const root = changesetRoot({});
  const d = runPrGate(
    input(CF03_CREATE),
    deps({
      worktreeRoot: root,
      readChangedFiles: () => ['src/index.cts'],
      liveChangesetLint: { evaluateLint: () => { throw new Error('live lint exploded'); } },
    })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
});

test('CF-03: readChangedFiles THROWS (diff unavailable) → FAIL CLOSED deny (HARD-01)', () => {
  const root = changesetRoot({});
  const d = runPrGate(
    input(CF03_CREATE),
    deps({
      worktreeRoot: root,
      readChangedFiles: () => { throw new Error('git: no upstream ref origin/next'); },
    })
  );
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
});

test('CF-03: a per-fragment `<!-- docs-exempt: reason -->` allows even with labels:[] pre-PR', () => {
  const root = changesetRoot({
    '.changeset/x.md': fragment('Added', 'a new capability\n\n<!-- docs-exempt: internal-only refactor -->'),
  });
  const d = runPrGate(
    input(CF03_CREATE),
    deps({ worktreeRoot: root, readChangedFiles: () => ['.changeset/x.md'] })
  );
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

// D-05 regression fixture: keep BOTH a docs-missing deny AND a docs-updated allow committed so a
// future regression that weakens the CF-03 docs gate is caught.
test('CF-03 regression (D-05): an Added-no-docs denies AND an Added-with-docs allows', () => {
  const root = changesetRoot({ '.changeset/x.md': fragment('Changed', 'changed behavior') });
  const denied = runPrGate(
    input(CF03_CREATE),
    deps({ worktreeRoot: root, readChangedFiles: () => ['.changeset/x.md'] })
  );
  assert.strictEqual(denied.permissionDecision, 'deny', denied.permissionDecisionReason);
  const allowed = runPrGate(
    input(CF03_CREATE),
    deps({ worktreeRoot: root, readChangedFiles: () => ['.changeset/x.md', 'docs/api.md'] })
  );
  assert.strictEqual(allowed.permissionDecision, 'allow', allowed.permissionDecisionReason);
});

// Task 2: the default reader is WIRED in runPrGate. With NO injected readChangedFiles, a
// gsd-core-targeting create whose PR diff is unreadable (defaultReadChangedFiles runs a `git diff`
// on a non-git temp root → throws) fails closed. liveDocsLint is injected so the setup-phase
// requireLiveScript does not mask the diff-read throw.
test('CF-03 Task 2: with NO injected readChangedFiles, an unreadable diff fails closed (deny)', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-cf03-diff-'));
  const d = runPrGate(
    input(CF03_CREATE),
    {
      worktreeRoot: root,
      liveTemplate,
      liveTarget,
      liveTitle,
      liveDocsLint,
      liveChangesetLint,
      liveCapRegistry,
      branch: 'fix/12-the-thing',
      changedFiles: ['src/index.cts'],
      authorAssociation: 'OWNER',
      readIssueLabels: () => ['approved-feature'],
      // readChangedFiles intentionally NOT injected → defaultReadChangedFiles runs (git diff on a
      // non-git temp root throws → fail closed).
      overrideImpl: { checkOverride: () => ({ override: false }), writeReceipt: () => {} },
    }
  );
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
});

// defaultReadChangedFiles input hardening: a non-git root (or missing origin/<base>) makes the
// underlying `git diff` throw → the reader fails closed (an unreadable diff source denies).
test('CF-03: defaultReadChangedFiles throws on an unreadable diff source (fail-closed)', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-cf03-drc-'));
  assert.throws(() => defaultReadChangedFiles(root, 'next'));
  // an absent/empty base cannot form a diff spec → fail closed before any spawn.
  assert.throws(() => defaultReadChangedFiles(root, ''));
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

// ── the shared upstream branch policy (was: a 3-prefix + issue-number local copy) ──
//
// `gh-pr-create` used to enforce /^(fix|docs|feat)\/\d+-/ — only 3 of upstream's 11 prefixes,
// plus an issue-number requirement upstream never makes. Every branch below is valid per
// `.github/workflows/branch-naming.yml` and was being DENIED locally.

for (const head of ['hotfix/2801-x', 'perf/2801-x', 'refactor/2801-x', 'test/2801-x',
  'release/1.9.0', 'ci/2801-x', 'revert/2801-x', 'chore/2801-x']) {
  test('branch policy: `' + head + '` is valid upstream → must NOT be denied for its name', () => {
    const d = runPrGate(
      input(`gh pr create --base next --title "fix(#12): x" --body "${escapeNl(GOOD_PR_BODY)}"`),
      deps({ branch: head })
    );
    if (d.permissionDecision === 'deny') {
      assert.doesNotMatch(d.permissionDecisionReason, /conventional prefixes/i,
        head + ' must not be rejected by the branch-name check');
    }
  });
}

test('branch policy: upstream requires no issue number — `fix/typo-in-readme` passes the name check', () => {
  const d = runPrGate(
    input(`gh pr create --base next --title "fix(#12): x" --body "${escapeNl(GOOD_PR_BODY)}"`),
    deps({ branch: 'fix/typo-in-readme' })
  );
  if (d.permissionDecision === 'deny') {
    assert.doesNotMatch(d.permissionDecisionReason, /conventional prefixes/i);
  }
});

test('branch policy: the deny reason NAMES the accepted prefixes (actionable, not just "bad")', () => {
  const d = runPrGate(
    input(`gh pr create --base next --title "fix(#12): x" --body "${escapeNl(GOOD_PR_BODY)}"`),
    deps({ branch: 'wip/whatever' })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /hotfix\//, 'the reason lists the valid prefixes');
});

// ─── WR-01: approval labels are read from the CANONICAL UPSTREAM, never the command's target ──
//
// CF-02 asks "does a linked issue carry a MAINTAINER-applied approved-* label?". The labels were
// read from `deps.targetRepo` — whatever the command's `-R`/`--repo` named, falling back to the
// worktree origin. Both are contributor-controlled: a fork can carry a SELF-applied
// `approved-feature`, and the gate would have accepted it as maintainer approval. The label only
// means what CF-02 claims when it is read from open-gsd/gsd-core.

test('WR-01: approval labels are read from open-gsd/gsd-core, NOT the command -R target', () => {
  const seen = [];
  runPrGate(
    input(`gh pr create -R attacker/gsd-core --base next --title 'feat(#39): x' --body "${escapeNl(bodyLinking(39))}"`),
    deps({
      targetRepo: { owner: 'attacker', repo: 'gsd-core' },
      readIssueLabels: (n, repo) => { seen.push(repo); return ['approved-feature']; },
    })
  );
  assert.ok(seen.length > 0, 'the approval read must actually happen');
  for (const repo of seen) {
    assert.strictEqual(repo.owner, 'open-gsd', 'approval must be read from canonical upstream');
    assert.strictEqual(repo.repo, 'gsd-core');
  }
});

test('WR-01: a fork that self-applies approved-* cannot satisfy CF-02', () => {
  const d = runPrGate(
    input(`gh pr create -R attacker/gsd-core --base next --title 'feat(#39): x' --body "${escapeNl(bodyLinking(39))}"`),
    deps({
      targetRepo: { owner: 'attacker', repo: 'gsd-core' },
      // The fork says approved; upstream does not. Only the upstream answer may count.
      readIssueLabels: (n, repo) =>
        repo && repo.owner === 'open-gsd' ? [] : ['approved-feature', 'approved-enhancement'],
    })
  );
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
  assert.match(d.permissionDecisionReason, /approved-feature|approved-enhancement/);
});

test('WR-01 no-regression: a genuine upstream approval still allows', () => {
  const d = runPrGate(
    input(`gh pr create --base next --title 'feat(#39): x' --body "${escapeNl(bodyLinking(39))}"`),
    deps({ readIssueLabels: (n, repo) => (repo && repo.owner === 'open-gsd' ? ['approved-feature'] : []) })
  );
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

// ─── CF-10: capability-manifest conformance ─────────────────────────────────────────────────
//
// gsd-core is descriptor-first (ADR-857/1016/1239): extending behaviour at one of "the 12"
// extension points ships as a CAPABILITY, not a scattered core patch. The toolkit already ROUTES
// toward `capability-candidate` and REVIEWS the boundary — but every gate was core-patch-shaped,
// so the one contribution shape gsd-core most wants was the shape nothing validated.
//
// These drive the REAL LIVE validators (the same script bin/verify-capability.cjs reuses), so a
// schema change upstream surfaces here rather than in a forked copy.

// A genuinely conformant descriptor, DERIVED from the toolkit's own shipped manifest (which the
// LIVE validator accepts) rather than hand-written. A hand-written "valid" fixture failed on first
// run — the real schema also requires tier/requires/runtimeCompat/skills/agents/config/steps/
// contributions/gates — which is precisely why deriving from a known-good descriptor beats guessing
// at the shape a live validator will accept.
const VALID_MANIFEST = (() => {
  const real = JSON.parse(
    require('node:fs').readFileSync(
      require('node:path').join(__dirname, '..', 'capabilities', 'contribution-toolkit', 'capability.json'),
      'utf8'
    )
  );
  real.id = 'demo-cap';
  return JSON.stringify(real);
})();

function capDeps(files, contents, over = {}) {
  return deps(
    Object.assign(
      {
        readChangedFiles: () => files,
        readRepoFile: (root, rel) => {
          if (!(rel in contents)) throw new Error('ENOENT: ' + rel);
          return contents[rel];
        },
      },
      over
    )
  );
}

test('CF-10: a PR changing a NONCONFORMANT capability.json is denied, naming the live errors', () => {
  const bad = JSON.stringify({ id: 'demo-cap', role: 'not-a-role', version: '1.0.0' });
  const d = runPrGate(
    input(`gh pr create --base next --title 'feat(#39): x' --body "${escapeNl(bodyLinking(39))}"`),
    capDeps(
      ['capabilities/demo-cap/capability.json', '.changeset/x.md'],
      { 'capabilities/demo-cap/capability.json': bad }
    )
  );
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
  assert.match(d.permissionDecisionReason, /CF-10/);
  assert.match(d.permissionDecisionReason, /role must be one of/);
});

test('CF-10: id-vs-FOLDER disagreement is caught (a descriptor copied to the wrong dir)', () => {
  const d = runPrGate(
    input(`gh pr create --base next --title 'feat(#39): x' --body "${escapeNl(bodyLinking(39))}"`),
    capDeps(
      ['capabilities/wrong-folder/capability.json', '.changeset/x.md'],
      { 'capabilities/wrong-folder/capability.json': VALID_MANIFEST }
    )
  );
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /must equal the folder name/);
});

test('CF-10: an UNPARSEABLE descriptor denies — malformed is a problem, not a reason to skip', () => {
  const d = runPrGate(
    input(`gh pr create --base next --title 'feat(#39): x' --body "${escapeNl(bodyLinking(39))}"`),
    capDeps(
      ['capabilities/demo-cap/capability.json', '.changeset/x.md'],
      { 'capabilities/demo-cap/capability.json': '{ not json' }
    )
  );
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /cannot parse/);
});

test('CF-10: an UNREADABLE descriptor denies rather than silently passing', () => {
  const d = runPrGate(
    input(`gh pr create --base next --title 'feat(#39): x' --body "${escapeNl(bodyLinking(39))}"`),
    capDeps(['capabilities/demo-cap/capability.json', '.changeset/x.md'], {})
  );
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /cannot parse|ENOENT/);
});

test('CF-10: a CONFORMANT descriptor allows (no over-blocking of real capability work)', () => {
  const d = runPrGate(
    input(`gh pr create --base next --title 'feat(#39): x' --body "${escapeNl(bodyLinking(39))}"`),
    capDeps(
      ['capabilities/demo-cap/capability.json', '.changeset/x.md'],
      { 'capabilities/demo-cap/capability.json': VALID_MANIFEST }
    )
  );
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

test('CF-10: a core-patch PR touching NO descriptor is unaffected (the reader is never called)', () => {
  let called = 0;
  const d = runPrGate(
    input(`gh pr create --base next --title 'feat(#39): x' --body "${escapeNl(bodyLinking(39))}"`),
    deps({
      readChangedFiles: () => ['src/index.cts', '.changeset/x.md'],
      readRepoFile: () => { called += 1; return '{}'; },
    })
  );
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
  assert.strictEqual(called, 0, 'a non-capability PR must not read descriptors at all');
});

test('CF-10: EVERY changed descriptor is reported, not just the first (no fail-fast)', () => {
  const bad = JSON.stringify({ id: 'a', role: 'nope' });
  const d = runPrGate(
    input(`gh pr create --base next --title 'feat(#39): x' --body "${escapeNl(bodyLinking(39))}"`),
    capDeps(
      ['capabilities/a/capability.json', 'capabilities/b/capability.json', '.changeset/x.md'],
      {
        'capabilities/a/capability.json': bad,
        'capabilities/b/capability.json': '{ also broken',
      }
    )
  );
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /capabilities\/a\/capability\.json/);
  assert.match(d.permissionDecisionReason, /capabilities\/b\/capability\.json/);
});

test('CF-10: a THROW from the live validator fails closed (HARD-01)', () => {
  const d = runPrGate(
    input(`gh pr create --base next --title 'feat(#39): x' --body "${escapeNl(bodyLinking(39))}"`),
    capDeps(
      ['capabilities/demo-cap/capability.json', '.changeset/x.md'],
      { 'capabilities/demo-cap/capability.json': VALID_MANIFEST },
      { liveCapRegistry: { validateCapability: () => { throw new Error('validator exploded'); } } }
    )
  );
  assert.strictEqual(d.permissionDecision, 'deny');
});
