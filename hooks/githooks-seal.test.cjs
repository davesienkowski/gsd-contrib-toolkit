'use strict';

/**
 * node:test for hooks/githooks-seal.cjs (ENF-12 --no-verify flag-not-text +
 * ENF-13 core.hooksPath=.githooks, HARD-01/04 fail-closed).
 *
 * Driven via the injectable runGithooksGate(stdinString, deps) seam: the worktree's
 * git config core.hooksPath value (and the worktree root) are INJECTED, so the unit
 * suite is hermetic (no real git config reads, no filesystem).
 *
 * Coverage (plan <behavior>):
 *   - real --no-verify / -n flag on commit|push → DENY (ENF-12)
 *   - the literal "--no-verify" inside a -m MESSAGE → NOT denied for the flag (EP-3)
 *   - hooksPath unset / != .githooks → DENY (ENF-13) with the fix command
 *   - clean commit/push (no flag, hooksPath=.githooks) → ALLOW
 *   - non-git / git-read (status, log) → ALLOW (no-op)
 *   - unparseable command → fail-closed DENY (HARD-04)
 *   - a config-read throw → fail-closed DENY (HARD-01), override-escapable (HARD-03)
 */

const test = require('node:test');
const assert = require('node:assert');

const { runGithooksGate } = require('./githooks-seal.cjs');

function input(command) {
  return JSON.stringify({ tool_name: 'Bash', tool_input: { command } });
}

// Default deps: a clean worktree whose core.hooksPath IS .githooks, no override.
function deps(over = {}) {
  return Object.assign(
    {
      worktreeRoot: '/tmp/wt',
      readHooksPath: () => '.githooks',
      overrideImpl: { checkOverride: () => ({ override: false }), writeReceipt: () => {} },
    },
    over
  );
}

test('git commit --no-verify -m "x" → deny (ENF-12 real flag)', () => {
  const d = runGithooksGate(input('git commit --no-verify -m "x"'), deps());
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /no-verify/);
});

test('git push --no-verify → deny (ENF-12)', () => {
  const d = runGithooksGate(input('git push --no-verify'), deps());
  assert.strictEqual(d.permissionDecision, 'deny');
});

test('git commit -n -m x → deny (ENF-12 short alias)', () => {
  const d = runGithooksGate(input('git commit -n -m x'), deps());
  assert.strictEqual(d.permissionDecision, 'deny');
});

test('git commit -m "remember: never use --no-verify" → NOT denied for the flag (EP-3)', () => {
  // hooksPath=.githooks so the ONLY thing that could deny is the (absent) flag.
  const d = runGithooksGate(
    input('git commit -m "remember: never use --no-verify"'),
    deps()
  );
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

test('git commit (clean) but hooksPath unset → deny (ENF-13) with the fix command', () => {
  const d = runGithooksGate(input('git commit -m x'), deps({ readHooksPath: () => null }));
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /hooksPath/);
  assert.match(d.permissionDecisionReason, /\.githooks/);
});

test('git push but hooksPath is a WRONG value → deny (ENF-13)', () => {
  const d = runGithooksGate(input('git push'), deps({ readHooksPath: () => '.husky' }));
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /hooksPath/);
});

test('git commit -m x with hooksPath=.githooks and no flag → allow', () => {
  const d = runGithooksGate(input('git commit -m x'), deps());
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

test('git push with hooksPath=.githooks and no flag → allow', () => {
  const d = runGithooksGate(input('git push origin fix/12'), deps());
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

test('hooksPath with surrounding whitespace (.githooks\\n) → allow (trimmed)', () => {
  const d = runGithooksGate(input('git commit -m x'), deps({ readHooksPath: () => '.githooks\n' }));
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

test('non-git command (ls) → allow (no-op)', () => {
  const d = runGithooksGate(input('ls -la'), deps({ readHooksPath: () => null }));
  assert.strictEqual(d.permissionDecision, 'allow');
});

test('git status (read) → allow (no-op, not commit/push)', () => {
  const d = runGithooksGate(input('git status'), deps({ readHooksPath: () => null }));
  assert.strictEqual(d.permissionDecision, 'allow');
});

test('git log (read) → allow (no-op)', () => {
  const d = runGithooksGate(input('git log --oneline'), deps({ readHooksPath: () => null }));
  assert.strictEqual(d.permissionDecision, 'allow');
});

test('--no-verify flag is checked BEFORE hooksPath (deny even if hooksPath ok)', () => {
  const d = runGithooksGate(input('git commit --no-verify -m x'), deps());
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /no-verify/);
});

test('unparseable command → fail-closed deny (HARD-04)', () => {
  const d = runGithooksGate(input('git commit -m "unterminated'), deps());
  assert.strictEqual(d.permissionDecision, 'deny');
});

test('malformed stdin JSON → fail-closed deny (HARD-01)', () => {
  const d = runGithooksGate('{not json', deps());
  assert.strictEqual(d.permissionDecision, 'deny');
});

test('a config-read throw on a commit → fail-closed deny (HARD-01)', () => {
  const d = runGithooksGate(
    input('git commit -m x'),
    deps({
      readHooksPath: () => {
        throw new Error('git config unavailable');
      },
    })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
});

test('a config-read throw WITH a logged override → allow (HARD-03)', () => {
  const d = runGithooksGate(
    input('git commit -m x'),
    deps({
      readHooksPath: () => {
        throw new Error('git config unavailable');
      },
      overrideImpl: {
        checkOverride: () => ({ override: true, reason: 'transient git config failure' }),
        writeReceipt: () => '/tmp/wt/.gsd-contrib/override-receipts.log',
      },
    })
  );
  assert.strictEqual(d.permissionDecision, 'allow');
});

test('a chained commit hiding --no-verify (git add . && git commit --no-verify) → deny', () => {
  const d = runGithooksGate(input('git add . && git commit --no-verify -m x'), deps());
  assert.strictEqual(d.permissionDecision, 'deny');
});

// --- ENF-12 segment scoping (EP-3 sibling: my-segment vs a neighbor's) -------------
// The flag-not-text rule already stopped `-m "…--no-verify…"` from matching. The same
// false-positive class survived on a second axis: a NEIGHBOR segment in the chain that
// legitimately carries `-n`. `grep -n` / `sed -n` / `tail -n` / `sort -n` are ubiquitous
// next to a commit, and denying them is exactly the trust-eroding false deny (red-team
// H-B) that gets the toolkit switched off.

test('a commit chained with grep -n → allow (the -n belongs to grep, not git)', () => {
  const d = runGithooksGate(input('git commit -m x && grep -n foo bar.txt'), deps());
  assert.strictEqual(d.permissionDecision, 'allow');
});

test('a commit chained with sed -n → allow', () => {
  const d = runGithooksGate(input("git commit -m x && sed -n '1,5p' file.txt"), deps());
  assert.strictEqual(d.permissionDecision, 'allow');
});

test('a commit chained with tail -n / sort -n → allow', () => {
  assert.strictEqual(
    runGithooksGate(input('git commit -m x && tail -n 5 log.txt'), deps()).permissionDecision,
    'allow'
  );
  assert.strictEqual(
    runGithooksGate(input('git commit -m x && sort -n nums.txt'), deps()).permissionDecision,
    'allow'
  );
});

test('a neighbor -n BEFORE the commit → allow (position must not matter)', () => {
  const d = runGithooksGate(input('grep -n foo bar.txt && git commit -m x'), deps());
  assert.strictEqual(d.permissionDecision, 'allow');
});

test('git commit --amend --no-edit → allow (--no-edit is not --no-verify)', () => {
  const d = runGithooksGate(input('git commit --amend --no-edit'), deps());
  assert.strictEqual(d.permissionDecision, 'allow');
});

// Narrowing the scan must NOT weaken the seal: the real flag still denies wherever the
// sealed segment sits in the chain, and a benign neighbor must not launder it.
test('scoping does not weaken: real -n on the commit, beside a benign grep -n → deny', () => {
  const d = runGithooksGate(input('grep -n foo bar.txt && git commit -n -m x'), deps());
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /no-verify/);
});

test('scoping does not weaken: --no-verify on a LATER push segment → deny', () => {
  const d = runGithooksGate(input('git commit -m x && git push --no-verify'), deps());
  assert.strictEqual(d.permissionDecision, 'deny');
});
