'use strict';

/**
 * node:test for hooks/lint-ci-marker.cjs — the ENF-05 tree-SHA `lint:ci`-green marker
 * READ gate (push + pr-create), HARD-01/03/04 fail-closed.
 *
 * Driven via the injectable runLintCiMarkerGate(stdinString, deps) seam: the tree SHA,
 * the working-tree status, and the marker-existence check are all INJECTED, so the unit
 * suite is hermetic (no real git, no real filesystem).
 *
 * Coverage (plan <behavior> — every 04-PATTERNS.md scenario + the ENF-17 Tier-1 dimension):
 *   - git push with a valid marker + clean tree + green affected tier → allow
 *   - git push with NO marker → deny; reason names `lint-ci-stamp` + cites the Tier-1 contract
 *   - git push with a DIRTY tree → deny (EP-4), even though the marker exists
 *   - gh pr create with a valid marker → allow (same gate, pr-create trigger; NO affected tier)
 *   - gh pr create with NO marker → deny
 *   - marker for a DIFFERENT tree SHA → deny (amend/rebase invalidation)
 *   - a non-push / non-pr-create command → allow (no-op)
 *   - readTreeSha throws → fail-closed deny (HARD-01)
 *   - ENF-17: runAffectedTier THROWS (red affected suite) → fail-closed deny (HARD-01)
 *   - ENF-17: runAffectedTier runs ONLY on push (pr-create with a green marker never calls it)
 *   - fail-closed WITH a logged override → allow (HARD-03)
 *   - unparseable command → fail-closed deny (HARD-04)
 *   - malformed stdin JSON → fail-closed deny
 *   - an ENF-15 REST synonym (gh api POST .../pulls) with NO marker → deny
 */

const test = require('node:test');
const assert = require('node:assert');

const { runLintCiMarkerGate, gate, TRIGGER_ACTIONS } = require('./lint-ci-marker.cjs');

function input(command) {
  return JSON.stringify({ tool_name: 'Bash', tool_input: { command } });
}

// Default deps: a clean worktree, a marker present for the current staged tree SHA, a GREEN
// affected tier (runAffectedTier returns without throwing), no override. Tests override
// individual readers per scenario. Injecting runAffectedTier keeps the unit suite hermetic —
// it never requires the LIVE affected-tests-lib or runs a real suite.
function deps(over = {}) {
  return Object.assign(
    {
      worktreeRoot: '/tmp/wt',
      readTreeSha: () => 'abc123',
      readWorkingTreeStatus: () => '', // clean
      readMarkerExists: (_root, _sha) => true, // marker present for the current SHA
      runAffectedTier: (_root) => undefined, // green: returns, does not throw (LIVE contract)
      overrideImpl: { checkOverride: () => ({ override: false }), writeReceipt: () => {} },
    },
    over
  );
}

// ---- TRIGGER_ACTIONS constant ----

test('TRIGGER_ACTIONS = push + pr-create only', () => {
  assert.ok(TRIGGER_ACTIONS instanceof Set);
  assert.ok(TRIGGER_ACTIONS.has('push'));
  assert.ok(TRIGGER_ACTIONS.has('pr-create'));
  assert.ok(!TRIGGER_ACTIONS.has('commit'));
  assert.ok(!TRIGGER_ACTIONS.has('issue-create'));
});

// ---- allow path (marker fresh, tree clean) ----

test('git push with a valid marker + clean tree → allow', () => {
  const d = runLintCiMarkerGate(input('git push origin main'), deps());
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

test('gh pr create with a valid marker → allow (same gate, pr-create trigger)', () => {
  const d = runLintCiMarkerGate(
    input('gh pr create --title x --body y'),
    deps()
  );
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

// ---- no-marker deny (the headline ENF-05 SC1) ----

test('git push with NO marker → deny; reason names lint-ci-stamp + ENF-05', () => {
  const d = runLintCiMarkerGate(
    input('git push origin main'),
    deps({ readMarkerExists: () => false })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /lint-ci-stamp/);
  assert.match(d.permissionDecisionReason, /ENF-05/);
});

test('gh pr create with NO marker → deny', () => {
  const d = runLintCiMarkerGate(
    input('gh pr create --title x --body y'),
    deps({ readMarkerExists: () => false })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /lint-ci-stamp/);
  assert.match(d.permissionDecisionReason, /ENF-05/);
});

// ---- dirty-tree deny (EP-4) — denies even with a marker present ----

test('git push with a DIRTY tree → deny (EP-4) even though the marker exists', () => {
  const d = runLintCiMarkerGate(
    input('git push origin main'),
    deps({
      readWorkingTreeStatus: () => ' M hooks/x.cjs\n', // dirty
      readMarkerExists: () => true, // a marker for the STAGED SHA exists, yet we still deny
    })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /dirty|working tree/i);
  assert.match(d.permissionDecisionReason, /ENF-05/);
});

// ---- ENF-17 Tier-1 test:affected dimension (push trigger only) ----

test('ENF-17: push with green marker + green affected tier → allow', () => {
  const d = runLintCiMarkerGate(
    input('git push origin main'),
    deps({ runAffectedTier: () => undefined }) // green affected suite
  );
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

test('ENF-17: push with a RED affected tier (runAffectedTier throws) → fail-closed deny (HARD-01)', () => {
  const d = runLintCiMarkerGate(
    input('git push origin main'),
    deps({
      runAffectedTier: () => {
        throw new Error('affected suite FAILED: tests/unit/x.test.cjs');
      },
    })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /affected|tier|fail.?closed/i);
});

test('ENF-17: a missing LIVE affected-tests-lib (runAffectedTier throws ScriptResolveError) → fail-closed deny', () => {
  const d = runLintCiMarkerGate(
    input('git push origin main'),
    deps({
      runAffectedTier: () => {
        throw new Error('requireLiveScript: live script not found: scripts/affected-tests-lib.cjs');
      },
    })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
});

test('ENF-17: runAffectedTier runs ONLY on push — pr-create with a green marker never calls it', () => {
  let called = false;
  const d = runLintCiMarkerGate(
    input('gh pr create --title x --body y'),
    deps({
      runAffectedTier: () => {
        called = true;
        throw new Error('must not be called on pr-create');
      },
    })
  );
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
  assert.strictEqual(called, false, 'runAffectedTier must not run on the pr-create path (Tier-2 is plan 07-03)');
});

test('ENF-17: the affected tier runs AFTER the marker check — no marker denies before runAffectedTier', () => {
  let called = false;
  const d = runLintCiMarkerGate(
    input('git push origin main'),
    deps({
      readMarkerExists: () => false,
      runAffectedTier: () => {
        called = true;
        throw new Error('runAffectedTier must not run when the marker is absent');
      },
    })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /lint-ci-stamp/);
  assert.strictEqual(called, false, 'the fast marker check must short-circuit before the affected tier (T-07-02-PERF)');
});

// ---- stale marker after amend/rebase: a DIFFERENT tree SHA has no marker ----

test('marker for a DIFFERENT tree SHA → deny (amend/rebase invalidation)', () => {
  // The live tree SHA is the NEW one; the marker keyed to the old SHA does not exist
  // for this SHA, so readMarkerExists(root, currentSha) returns false.
  const d = runLintCiMarkerGate(
    input('git push origin main'),
    deps({
      readTreeSha: () => 'newsha999',
      readMarkerExists: (_root, sha) => sha === 'abc123', // only the OLD sha was stamped
    })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /lint-ci-stamp/);
});

// ---- non-trigger commands → no-op allow ----

test('git status (non-push) → allow (no-op)', () => {
  const d = runLintCiMarkerGate(input('git status'), deps({ readMarkerExists: () => false }));
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

test('gh repo view (non-trigger) → allow (no-op)', () => {
  const d = runLintCiMarkerGate(input('gh repo view'), deps({ readMarkerExists: () => false }));
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

test('git commit (non-push, non-pr-create) → allow (no-op)', () => {
  const d = runLintCiMarkerGate(input('git commit -m x'), deps({ readMarkerExists: () => false }));
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

// ---- ENF-15 REST synonym routes through the SAME gate (no bypass) ----

test('ENF-15 synonym gh api POST .../pulls with NO marker → deny (synonym does not bypass)', () => {
  const d = runLintCiMarkerGate(
    input('gh api -X POST repos/open-gsd/gsd-core/pulls -f title=x'),
    deps({ readMarkerExists: () => false })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /lint-ci-stamp/);
});

// ---- fail-closed paths (HARD-01/04) ----

test('readTreeSha throws → fail-closed deny (HARD-01)', () => {
  const d = runLintCiMarkerGate(
    input('git push'),
    deps({
      readTreeSha: () => {
        throw new Error('git write-tree unavailable');
      },
    })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
});

test('readWorkingTreeStatus throws → fail-closed deny (HARD-01)', () => {
  const d = runLintCiMarkerGate(
    input('git push'),
    deps({
      readWorkingTreeStatus: () => {
        throw new Error('git status unavailable');
      },
    })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
});

test('unparseable command (unbalanced quote) → fail-closed deny (HARD-04)', () => {
  const d = runLintCiMarkerGate(input('git push "unterminated'), deps());
  assert.strictEqual(d.permissionDecision, 'deny');
});

test('malformed stdin JSON → fail-closed deny', () => {
  const d = runLintCiMarkerGate('{not valid json', deps());
  assert.strictEqual(d.permissionDecision, 'deny');
});

test('an unmappable mutating github synonym fails closed → deny', () => {
  // gh api POST to a github issues|pulls path that classify cannot map → failClosed → deny.
  const d = runLintCiMarkerGate(
    input('gh api -X POST repos/o/r/pulls/comments/issues'),
    deps()
  );
  assert.strictEqual(d.permissionDecision, 'deny');
});

// ---- override escape (HARD-03) ----

test('infra throw WITH a logged override → allow (HARD-03)', () => {
  const d = runLintCiMarkerGate(
    input('git push'),
    deps({
      readTreeSha: () => {
        throw new Error('git unavailable');
      },
      overrideImpl: {
        checkOverride: () => ({ override: true, reason: 'transient git failure' }),
        writeReceipt: () => '/tmp/wt/.gsd-contrib/override-receipts.log',
      },
    })
  );
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

// ---- the pure gate fn is directly callable (read-only, deps fully injected) ----

test('pure gate() denies a no-marker push without touching real git', () => {
  const d = gate(input('git push'), {
    readTreeSha: () => 'sha',
    readWorkingTreeStatus: () => '',
    readMarkerExists: () => false,
  });
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /lint-ci-stamp/);
});
