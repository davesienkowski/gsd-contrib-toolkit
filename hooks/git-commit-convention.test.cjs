'use strict';

/**
 * node:test for hooks/git-commit-convention.cjs (ENF-16 / HARD-01 / HARD-04).
 *
 * Drives the gate through the injectable runCommitConventionGate(input, deps) seam so the
 * worktree root, the override check, and the message-file reader can be injected — no
 * filesystem walk, no real gsd-core checkout required for the unit suite. Passing
 * worktreeRoot short-circuits the gsd-core root resolution so no filesystem walk occurs.
 */

const test = require('node:test');
const assert = require('node:assert');

const { runCommitConventionGate } = require('./git-commit-convention.cjs');

// Build a PreToolUse stdin payload for a Bash command.
function input(command) {
  return JSON.stringify({ tool_name: 'Bash', tool_input: { command } });
}

// Default deps: hermetic — injected worktree root (no fs walk), no override, no file reads.
function deps(over = {}) {
  return Object.assign(
    {
      worktreeRoot: '/tmp/wt',
      overrideImpl: { checkOverride: () => ({ override: false }), writeReceipt: () => {} },
      readMessageFile: () => {
        throw new Error('no file read expected');
      },
    },
    over
  );
}

// ---- ALLOW: correctly-shaped recognized-type prefixes ----

test('git commit -m "fix(core): handle null" → ALLOW (type + (scope))', () => {
  const d = runCommitConventionGate(input('git commit -m "fix(core): handle null"'), deps());
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

test('git commit -m "feat!: breaking change" → ALLOW (type + !)', () => {
  const d = runCommitConventionGate(input('git commit -m "feat!: breaking change"'), deps());
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

test('git commit -m "fix: tidy" → ALLOW (type + :)', () => {
  const d = runCommitConventionGate(input('git commit -m "fix: tidy"'), deps());
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

test('git commit -m "docs: update" → ALLOW (correctly-shaped docs prefix)', () => {
  const d = runCommitConventionGate(input('git commit -m "docs: update"'), deps());
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

// ---- DENY: obviously-malformed prefix shapes ----

test('git commit -m "docs fix thing" → DENY (recognized type, no separator)', () => {
  const d = runCommitConventionGate(input('git commit -m "docs fix thing"'), deps());
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /prefix|convention|toolkit/i);
});

test('git commit -m "wip" → DENY (no recognized type at all)', () => {
  const d = runCommitConventionGate(input('git commit -m "wip"'), deps());
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /prefix|convention|toolkit/i);
});

test('git commit -m "update stuff" → DENY (no recognized type at all)', () => {
  const d = runCommitConventionGate(input('git commit -m "update stuff"'), deps());
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /prefix|convention|toolkit/i);
});

// ---- multi -m: the FIRST -m is the subject line ----

test('git commit -m "fix: x" -m "docs body" → ALLOW (first -m is the judged subject)', () => {
  const d = runCommitConventionGate(input('git commit -m "fix: x" -m "some body paragraph"'), deps());
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

test('git commit -m "wip" -m "fix: later" → DENY (first -m subject is malformed)', () => {
  const d = runCommitConventionGate(input('git commit -m "wip" -m "fix: later"'), deps());
  assert.strictEqual(d.permissionDecision, 'deny');
});

// ---- --message= inline form ----

test('git commit --message="feat: thing" → ALLOW', () => {
  const d = runCommitConventionGate(input('git commit --message="feat: thing"'), deps());
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

// ---- message-less commit (interactive editor) ----

test('git commit (no -m, no -F) → ALLOW (no asserted message to judge)', () => {
  const d = runCommitConventionGate(input('git commit'), deps());
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

test('git commit --amend (no message) → ALLOW (no asserted message)', () => {
  const d = runCommitConventionGate(input('git commit --amend'), deps());
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

// ---- -F <path>: read from disk and judge the first line ----

test('git commit -F /tmp/msg with a good prefix on disk → ALLOW', () => {
  const d = runCommitConventionGate(
    input('git commit -F /tmp/msg'),
    deps({ readMessageFile: (p) => (p === '/tmp/msg' ? 'fix: from a file\n\nbody' : null) })
  );
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

test('git commit -F /tmp/msg with a bad prefix on disk → DENY', () => {
  const d = runCommitConventionGate(
    input('git commit -F /tmp/msg'),
    deps({ readMessageFile: (p) => (p === '/tmp/msg' ? 'wip from a file' : null) })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
});

// ---- fail-closed paths (HARD-01 / HARD-04) ----

test('git commit -F - (stdin) the hook cannot observe → FAIL CLOSED deny (HARD-04)', () => {
  const d = runCommitConventionGate(input('git commit -F -'), deps());
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /stdin|cannot|fail.?closed|unparse/i);
});

test('git commit -m "unterminated (unbalanced quote) → FAIL CLOSED deny (HARD-04)', () => {
  const d = runCommitConventionGate(input('git commit -m "unterminated'), deps());
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /stdin|cannot|fail.?closed|unparse/i);
});

test('malformed stdin JSON → FAIL CLOSED deny (HARD-01)', () => {
  const d = runCommitConventionGate('{not json', deps());
  assert.strictEqual(d.permissionDecision, 'deny');
});

test('a thrown injected readMessageFile on the -F path → FAIL CLOSED deny (HARD-01)', () => {
  const d = runCommitConventionGate(
    input('git commit -F /tmp/msg'),
    deps({
      readMessageFile: () => {
        throw new Error('disk read blew up');
      },
    })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
});

test('fail-closed deny WITH a logged override → allow (HARD-03)', () => {
  const d = runCommitConventionGate(
    input('git commit -F -'),
    deps({
      overrideImpl: {
        checkOverride: () => ({ override: true, reason: 'known-good rebase fixup' }),
        writeReceipt: () => '/tmp/wt/.gsd-contrib/override-receipts.log',
      },
    })
  );
  assert.strictEqual(d.permissionDecision, 'allow');
});

// ---- non-commit actions pass through as a no-op allow ----

test('git status → ALLOW (no-op)', () => {
  const d = runCommitConventionGate(input('git status'), deps());
  assert.strictEqual(d.permissionDecision, 'allow');
});

test('git push origin HEAD → ALLOW (no-op)', () => {
  const d = runCommitConventionGate(input('git push origin HEAD'), deps());
  assert.strictEqual(d.permissionDecision, 'allow');
});

test('gh pr create … → ALLOW (no-op, not a commit)', () => {
  const d = runCommitConventionGate(input('gh pr create --title x --body y'), deps());
  assert.strictEqual(d.permissionDecision, 'allow');
});
