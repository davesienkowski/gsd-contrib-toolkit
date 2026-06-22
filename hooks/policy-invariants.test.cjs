'use strict';

/**
 * node:test for hooks/policy-invariants.cjs — the POLICY-02 mechanizable-invariants gate.
 *
 * Driven through the injectable runPolicyGate(input, deps) seam so the unit suite is
 * hermetic: the per-check runner (which in production execFile's the LIVE gsd-core npm
 * scripts) is injected, so a test NEVER actually runs the heavy `lint:ci` suite.
 *
 * Covered:
 *   - non-commit/non-pr command → allow (no checks run)
 *   - git commit, all four checks green → allow
 *   - a failing lint:docs → deny naming lint:docs + an output tail
 *   - a failing lint:ci → deny naming lint:ci
 *   - a failing check:alias-drift → deny naming it
 *   - a failing check:identity-drift → deny naming it
 *   - an infra throw inside the runner → fail-closed deny (HARD-01)
 *   - the exact four POLICY-02 scripts are the ONLY ones run (H-D: no CONTEXT.md predicate)
 *   - gh pr create is gated identically to git commit
 */

const test = require('node:test');
const assert = require('node:assert');

const { runPolicyGate, POLICY_CHECKS } = require('./policy-invariants.cjs');

function input(command) {
  return JSON.stringify({ tool_name: 'Bash', tool_input: { command } });
}

// A runChecks stub: returns a result per script. `fails` maps a script-name → tail string;
// any script NOT in `fails` is reported green. Records which scripts were run.
function stubRunner(fails = {}, ran = []) {
  return (root, scripts) => {
    return scripts.map((s) => {
      ran.push(s.name);
      if (Object.prototype.hasOwnProperty.call(fails, s.name)) {
        return { name: s.name, ok: false, code: 1, tail: fails[s.name] };
      }
      return { name: s.name, ok: true, code: 0, tail: '' };
    });
  };
}

function deps(over = {}) {
  return Object.assign(
    {
      worktreeRoot: '/tmp/wt',
      gsdCoreRoot: '/tmp/wt',
      runChecks: stubRunner(),
      overrideImpl: { checkOverride: () => ({ override: false }), writeReceipt: () => {} },
    },
    over
  );
}

test('non-commit/non-pr command (gh repo view) → allow, no checks run', () => {
  const ran = [];
  const d = runPolicyGate(input('gh repo view o/r'), deps({ runChecks: stubRunner({}, ran) }));
  assert.strictEqual(d.permissionDecision, 'allow');
  assert.deepStrictEqual(ran, []);
});

test('git commit, all four checks green → allow', () => {
  const ran = [];
  const d = runPolicyGate(input('git commit -m wip'), deps({ runChecks: stubRunner({}, ran) }));
  assert.strictEqual(d.permissionDecision, 'allow');
  // exactly the four mechanizable POLICY-02 checks ran
  assert.deepStrictEqual(
    ran.sort(),
    ['check:alias-drift', 'check:identity-drift', 'lint:ci', 'lint:docs'].sort()
  );
});

test('failing lint:docs → deny naming lint:docs and a tail', () => {
  const d = runPolicyGate(
    input('git commit -m wip'),
    deps({ runChecks: stubRunner({ 'lint:docs': 'changeset missing docs pairing' }) })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /lint:docs/);
  assert.match(d.permissionDecisionReason, /changeset missing docs pairing/);
});

test('failing lint:ci → deny naming lint:ci', () => {
  const d = runPolicyGate(
    input('git commit -m wip'),
    deps({ runChecks: stubRunner({ 'lint:ci': 'eslint error in scripts/x.cjs' }) })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /lint:ci/);
});

test('failing check:alias-drift → deny naming it', () => {
  const d = runPolicyGate(
    input('git commit -m wip'),
    deps({ runChecks: stubRunner({ 'check:alias-drift': 'alias drift detected' }) })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /alias-drift/);
});

test('failing check:identity-drift → deny naming it', () => {
  const d = runPolicyGate(
    input('git commit -m wip'),
    deps({ runChecks: stubRunner({ 'check:identity-drift': 'package identity drift' }) })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /identity-drift/);
});

test('multiple failures → deny naming all failed invariants', () => {
  const d = runPolicyGate(
    input('git commit -m wip'),
    deps({
      runChecks: stubRunner({ 'lint:docs': 'a', 'check:alias-drift': 'b' }),
    })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /lint:docs/);
  assert.match(d.permissionDecisionReason, /alias-drift/);
});

test('an infra throw inside the runner → fail-closed deny (HARD-01)', () => {
  const d = runPolicyGate(
    input('git commit -m wip'),
    deps({
      runChecks: () => {
        throw new Error('node: command not found');
      },
    })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /node: command not found/);
});

test('a logged override flips a fail-closed infra error → allow', () => {
  let receipt = null;
  const d = runPolicyGate(
    input('git commit -m wip'),
    deps({
      runChecks: () => {
        throw new Error('infra boom');
      },
      overrideImpl: {
        checkOverride: () => ({ override: true, reason: 'CI down, manual lint passed' }),
        writeReceipt: (root, rec) => {
          receipt = rec;
        },
      },
    })
  );
  assert.strictEqual(d.permissionDecision, 'allow');
  assert.ok(receipt, 'an honored override writes a receipt');
});

test('gh pr create is gated identically to git commit', () => {
  const ran = [];
  const d = runPolicyGate(
    input('gh pr create --base next --title x --body y'),
    deps({ runChecks: stubRunner({}, ran) })
  );
  assert.strictEqual(d.permissionDecision, 'allow');
  assert.strictEqual(ran.length, 4);
});

test('POLICY_CHECKS is EXACTLY the four mechanizable scripts (H-D: no CONTEXT.md predicate)', () => {
  const names = POLICY_CHECKS.map((c) => c.name).sort();
  assert.deepStrictEqual(
    names,
    ['check:alias-drift', 'check:identity-drift', 'lint:ci', 'lint:docs'].sort()
  );
  // No check should reference CONTEXT.md scanning (that is POLICY-03, red-team H-D).
  for (const c of POLICY_CHECKS) {
    assert.doesNotMatch(JSON.stringify(c), /CONTEXT\.md/i);
  }
});

test('an unparseable command fails closed (deny)', () => {
  const d = runPolicyGate(
    JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git commit -m "unterminated' } }),
    deps()
  );
  assert.strictEqual(d.permissionDecision, 'deny');
});
