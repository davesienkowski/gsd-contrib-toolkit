'use strict';

/**
 * node:test for hooks/issue-dedupe.cjs (ENF-11 / HARD-01 / HARD-04).
 *
 * Drives the gate through the injectable runDedupeGate(input, deps) seam so the LIVE
 * scoreCandidates export and the open-issue fetch can be injected — no real `gh`, no
 * network, no gsd-core checkout required for the unit suite. The LIVE scorer stub is the
 * REAL scripts/issue-dedupe.cjs module (we exercise the real similarity math, only the
 * issue FETCH is mocked).
 */

const test = require('node:test');
const assert = require('node:assert');

const { runDedupeGate } = require('./issue-dedupe.cjs');

// The REAL live scorer — we never reimplement the similarity logic; we call it.
const liveScorer = require('/home/dave/repos/gsd-core/scripts/issue-dedupe.cjs');

// Build a PreToolUse stdin payload for a Bash command.
function input(command) {
  return JSON.stringify({ tool_name: 'Bash', tool_input: { command } });
}

// Default deps: real live scorer, an injected fetch, no override.
function deps(over = {}) {
  return Object.assign(
    {
      liveScorer,
      fetchOpenIssues: () => [],
      worktreeRoot: '/tmp/wt',
      overrideImpl: { checkOverride: () => ({ override: false }), writeReceipt: () => {} },
    },
    over
  );
}

// A set of open issues that includes a near-duplicate of the new title below.
const OPEN_ISSUES = [
  { number: 12, title: 'race condition in two-window mode' },
  { number: 34, title: 'docs typo in README' },
];

test('non-issue-create command (gh repo view) → allow (no-op)', () => {
  const d = runDedupeGate(input('gh repo view octocat/hello'), deps());
  assert.strictEqual(d.permissionDecision, 'allow');
});

test('git status → allow (no-op)', () => {
  const d = runDedupeGate(input('git status'), deps());
  assert.strictEqual(d.permissionDecision, 'allow');
});

test('novel title with no candidate >= threshold → allow', () => {
  const d = runDedupeGate(
    input('gh issue create --title "completely unrelated new subject area" --body x'),
    deps({ fetchOpenIssues: () => OPEN_ISSUES })
  );
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

test('high-similarity open issue → DENY naming the duplicate #N (ENF-11)', () => {
  const d = runDedupeGate(
    input('gh issue create --title "race condition in two-window mode" --body x'),
    deps({ fetchOpenIssues: () => OPEN_ISSUES })
  );
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
  assert.match(d.permissionDecisionReason, /#12/);
});

test('gh api POST issues synonym near-duplicate → DENY (ENF-15 inherited)', () => {
  const cmd =
    "gh api -X POST repos/o/r/issues -f title='race condition in two-window mode' -f body=x";
  const d = runDedupeGate(input(cmd), deps({ fetchOpenIssues: () => OPEN_ISSUES }));
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
  assert.match(d.permissionDecisionReason, /#12/);
});

test('issue-list fetch failing (unauth gh / network) → FAIL CLOSED deny (HARD-01)', () => {
  const d = runDedupeGate(
    input('gh issue create --title "race condition in two-window mode" --body x'),
    deps({
      fetchOpenIssues: () => {
        throw new Error('gh: not authenticated');
      },
    })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /fetch|authenticated|fail.closed|dedupe/i);
});

test('a fetch failure WITH a logged override → allow (HARD-03)', () => {
  const d = runDedupeGate(
    input('gh issue create --title "race condition in two-window mode" --body x'),
    deps({
      fetchOpenIssues: () => {
        throw new Error('gh: not authenticated');
      },
      overrideImpl: {
        checkOverride: () => ({ override: true, reason: 'transient gh outage' }),
        writeReceipt: () => '/tmp/wt/.gsd-contrib/override-receipts.log',
      },
    })
  );
  assert.strictEqual(d.permissionDecision, 'allow');
});

test('issue with no resolvable title → allow (nothing to dedupe against)', () => {
  // gh issue create with no --title: interactive form; the hook cannot score, allow
  // (this is not a fail-closed case — there is no asserted title to be a duplicate of).
  const d = runDedupeGate(
    input('gh issue create --body x'),
    deps({ fetchOpenIssues: () => OPEN_ISSUES })
  );
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

test('unparseable command (unbalanced quote) → FAIL CLOSED deny (HARD-04)', () => {
  const d = runDedupeGate(input('gh issue create --title "unterminated'), deps());
  assert.strictEqual(d.permissionDecision, 'deny');
});

test('malformed stdin JSON → FAIL CLOSED deny (HARD-01)', () => {
  const d = runDedupeGate('{not json', deps());
  assert.strictEqual(d.permissionDecision, 'deny');
});

test('a thrown live scorer (reshaped script) → FAIL CLOSED deny (HARD-01)', () => {
  const d = runDedupeGate(
    input('gh issue create --title "race condition in two-window mode" --body x'),
    deps({
      fetchOpenIssues: () => OPEN_ISSUES,
      liveScorer: {
        scoreCandidates() {
          throw new Error('live script reshaped');
        },
      },
    })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
});

// --- RES-01: action-first short-circuit fires BEFORE the LIVE-script resolve ---
const denyingOverride = {
  overrideImpl: { checkOverride: () => ({ override: false }), writeReceipt: () => {} },
};

// D-09(b), HARD-02: a GOVERNED issue-create whose LIVE dedupe scorer is genuinely
// missing (worktreeRoot present but lacking scripts/issue-dedupe.cjs, no liveScorer
// injected) STILL DENIES — requireLiveScript throws → fail closed. This is the
// direction the short-circuit must NOT weaken.
test('RES-01/HARD-02: governed issue-create with a MISSING live scorer → DENY', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dedupe-noscript-gov-'));
  const d = runDedupeGate(
    input('gh issue create --title "some new subject" --body x'),
    Object.assign({ worktreeRoot: root }, denyingOverride)
  );
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
});

// D-09(a): a NON-governed command against the SAME missing-scorer root must ALLOW —
// proving the classify-first guard short-circuits before requireLiveScript is reached.
test('RES-01: non-governed (git status) with a MISSING live scorer → ALLOW (short-circuit before resolve)', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dedupe-noscript-nongov-'));
  const d = runDedupeGate(
    input('git status'),
    Object.assign({ worktreeRoot: root }, denyingOverride)
  );
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});
