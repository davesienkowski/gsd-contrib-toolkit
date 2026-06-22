'use strict';

/**
 * hooks/integration-proof.test.cjs — INTEGRATION proofs (TEST-01 / TEST-02).
 *
 * The hermetic unit suite (hooks/*.test.cjs, 315 cases) proves each gate's POLICY LOGIC
 * through an injectable seam. It does NOT prove the stdin->stdout->exit WIRING of the real
 * entrypoint (`node hooks/<name>.cjs`). A hook could pass every unit test and still mis-wire
 * its `main()` — emit nothing, crash, or drop the decision.
 *
 * This file closes that gap: it SPAWNS the real entrypoint via hooks/lib/proof-harness.cjs,
 * feeds crafted stdin, and CAPTURES the emitted permissionDecision — proving deny-on-bad and
 * allow-on-clean end-to-end for every wired gate, plus the two advisory hooks.
 *
 * THE LOAD-BEARING INVARIANT (asserted explicitly below): a hook that crashes (non-zero exit)
 * or emits empty/unparseable stdout is an INCONCLUSIVE FAIL — NEVER coerced to 'allow'. A
 * mis-classifier that read a crash as "allow" would manufacture a FALSE proof.
 *
 * Task 1 (this section): the classify invariants — pure, no spawn needed.
 * Task 2 (added later): the per-hook deny+allow proofs — real spawn.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyDecision } = require('./lib/proof-harness.cjs');

// ── Task 1: classifyDecision invariants (the security core) ────────────────────

// A well-formed deny envelope (what every PreToolUse gate emits on a deny, exit 0).
const DENY_LINE = JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: 'blocked',
  },
});
// A well-formed allow envelope (exit 0).
const ALLOW_LINE = JSON.stringify({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
});

test('classify: well-formed deny + exit 0 → {decision:"deny", conclusive:true}', () => {
  const r = classifyDecision(DENY_LINE, 0);
  assert.equal(r.decision, 'deny');
  assert.equal(r.conclusive, true);
});

test('classify: well-formed allow + exit 0 → {decision:"allow", conclusive:true}', () => {
  const r = classifyDecision(ALLOW_LINE, 0);
  assert.equal(r.decision, 'allow');
  assert.equal(r.conclusive, true);
});

test('SECURITY: non-zero exit → conclusive:false REGARDLESS of stdout (crash != allow)', () => {
  // Even if a crashing hook happened to print a valid allow line, a non-zero exit is a
  // crash — it is INCONCLUSIVE, never honored as an allow.
  const r = classifyDecision(ALLOW_LINE, 1);
  assert.equal(r.conclusive, false);
  assert.notEqual(r.decision, 'allow');
});

test('SECURITY: non-zero exit with a deny line → conclusive:false (still inconclusive)', () => {
  const r = classifyDecision(DENY_LINE, 1);
  assert.equal(r.conclusive, false);
});

test('SECURITY: empty stdout + exit 0 → {decision:null, conclusive:false} (NEVER allow)', () => {
  const r = classifyDecision('', 0);
  assert.equal(r.decision, null);
  assert.equal(r.conclusive, false);
});

test('SECURITY: unparseable stdout + exit 0 → conclusive:false (NEVER coerced to allow)', () => {
  const r = classifyDecision('this is not json', 0);
  assert.equal(r.decision, null);
  assert.equal(r.conclusive, false);
});

test('SECURITY: valid JSON but no permissionDecision → conclusive:false', () => {
  const r = classifyDecision(JSON.stringify({ hookSpecificOutput: { additionalContext: 'x' } }), 0);
  assert.equal(r.decision, null);
  assert.equal(r.conclusive, false);
});

test('SECURITY: a permissionDecision that is neither deny nor allow → conclusive:false', () => {
  const weird = JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'maybe' },
  });
  const r = classifyDecision(weird, 0);
  assert.equal(r.decision, null);
  assert.equal(r.conclusive, false);
});

test('classify: trailing whitespace / extra newline around the JSON line is tolerated', () => {
  const r = classifyDecision('\n  ' + DENY_LINE + '  \n', 0);
  assert.equal(r.decision, 'deny');
  assert.equal(r.conclusive, true);
});
