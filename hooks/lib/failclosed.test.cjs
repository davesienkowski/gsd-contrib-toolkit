'use strict';

/**
 * node:test for hooks/lib/failclosed.cjs (HARD-01 fail-closed harness).
 *
 * Invariants proven here:
 *   (a) gateFn THROWS + no override            → decision is DENY (fail closed)
 *   (b) gateFn THROWS + GSD_CONTRIB_OVERRIDE    → decision is ALLOW + writeReceipt called
 *   (c) gateFn returns allow cleanly           → ALLOW, NO receipt (override is a no-op)
 *   (d) malformed stdin → readHookInput throws  → runGate catch → DENY
 *
 * The override module is consulted via an injectable seam (`overrideImpl`) so the
 * test is deterministic and does not touch the real filesystem.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const fc = require('./failclosed.cjs');

// A deterministic stub for the override module boundary.
function makeOverrideStub({ override = false, reason } = {}) {
  const calls = { checkOverride: 0, writeReceipt: [] };
  const impl = {
    checkOverride(worktreeRoot) {
      calls.checkOverride += 1;
      return override ? { override: true, reason } : { override: false };
    },
    writeReceipt(worktreeRoot, record) {
      calls.writeReceipt.push({ worktreeRoot, record });
    },
  };
  return { impl, calls };
}

test('readHookInput parses a valid PreToolUse stdin payload', () => {
  const input = fc.readHookInput(
    JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'gh issue create' } })
  );
  assert.strictEqual(input.tool_name, 'Bash');
  assert.strictEqual(input.tool_input.command, 'gh issue create');
});

test('readHookInput throws on malformed JSON (caller turns it into a deny)', () => {
  assert.throws(() => fc.readHookInput('{ not json'), /./);
});

test('readHookInput throws on a non-object payload', () => {
  assert.throws(() => fc.readHookInput('null'));
  assert.throws(() => fc.readHookInput('42'));
  assert.throws(() => fc.readHookInput('"a string"'));
});

test('deny() returns a deny decision carrying the reason', () => {
  const d = fc.deny('broken issue body');
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.strictEqual(d.permissionDecisionReason, 'broken issue body');
});

test('allow() returns an allow decision', () => {
  const d = fc.allow();
  assert.strictEqual(d.permissionDecision, 'allow');
});

test('(a) gateFn throws + NO override → DENY (fail closed)', () => {
  const { impl, calls } = makeOverrideStub({ override: false });
  const decision = fc.runGate(
    () => {
      throw new Error('missing live script');
    },
    { worktreeRoot: '/tmp/wt-a', command: 'gh issue create', action: 'issue-create', overrideImpl: impl }
  );
  assert.strictEqual(decision.permissionDecision, 'deny');
  assert.match(decision.permissionDecisionReason, /missing live script|fail/i);
  assert.strictEqual(calls.writeReceipt.length, 0, 'no override → no receipt');
});

test('(b) gateFn throws + valid override → ALLOW + writeReceipt called', () => {
  const { impl, calls } = makeOverrideStub({ override: true, reason: 'transient gh outage' });
  const decision = fc.runGate(
    () => {
      throw new Error('gh not authenticated');
    },
    { worktreeRoot: '/tmp/wt-b', command: 'gh pr create', action: 'pr-create', overrideImpl: impl }
  );
  assert.strictEqual(decision.permissionDecision, 'allow');
  assert.strictEqual(calls.writeReceipt.length, 1, 'override flipped a deny → must log a receipt');
  const { worktreeRoot, record } = calls.writeReceipt[0];
  assert.strictEqual(worktreeRoot, '/tmp/wt-b');
  assert.strictEqual(record.reason, 'transient gh outage');
  assert.strictEqual(record.action, 'pr-create');
  assert.strictEqual(record.command, 'gh pr create');
});

test('(c) gateFn returns allow cleanly → ALLOW, NO receipt (override not consulted as a flip)', () => {
  const { impl, calls } = makeOverrideStub({ override: true, reason: 'should-not-matter' });
  const decision = fc.runGate(() => fc.allow(), {
    worktreeRoot: '/tmp/wt-c',
    command: 'gh issue list',
    action: 'other',
    overrideImpl: impl,
  });
  assert.strictEqual(decision.permissionDecision, 'allow');
  assert.strictEqual(calls.writeReceipt.length, 0, 'a clean allow must NOT write a receipt');
});

test('(c2) gateFn returns deny cleanly → DENY is honored (not flipped by override)', () => {
  // A gate that DECIDES deny (not an error) is a real policy decision — the override
  // only rescues ERRORS (fail-closed), never overrides an intentional policy deny.
  const { impl, calls } = makeOverrideStub({ override: true, reason: 'reason' });
  const decision = fc.runGate(() => fc.deny('broken body'), {
    worktreeRoot: '/tmp/wt-c2',
    command: 'gh issue create',
    action: 'issue-create',
    overrideImpl: impl,
  });
  assert.strictEqual(decision.permissionDecision, 'deny');
  assert.strictEqual(calls.writeReceipt.length, 0);
});

test('(d) malformed stdin → runGate(...readHookInput) → DENY', () => {
  const { impl, calls } = makeOverrideStub({ override: false });
  const decision = fc.runGate(
    () => {
      // Simulate a gate whose first act is to parse stdin, which throws.
      fc.readHookInput('{ not json');
      return fc.allow();
    },
    { worktreeRoot: '/tmp/wt-d', command: '<malformed>', action: 'unknown', overrideImpl: impl }
  );
  assert.strictEqual(decision.permissionDecision, 'deny');
  assert.strictEqual(calls.writeReceipt.length, 0);
});

test('runGate falls back to the real override module when no overrideImpl injected', () => {
  // With no GSD_CONTRIB_OVERRIDE set, a thrown gate must deny via the real module.
  const saved = process.env.GSD_CONTRIB_OVERRIDE;
  delete process.env.GSD_CONTRIB_OVERRIDE;
  try {
    const decision = fc.runGate(
      () => {
        throw new Error('boom');
      },
      { worktreeRoot: '/tmp/wt-real', command: 'x', action: 'unknown' }
    );
    assert.strictEqual(decision.permissionDecision, 'deny');
  } finally {
    if (saved === undefined) delete process.env.GSD_CONTRIB_OVERRIDE;
    else process.env.GSD_CONTRIB_OVERRIDE = saved;
  }
});

// ---- IN-03: shared FailClosed + safeCommand (hoisted from the gates) ----

test('FailClosed is an Error subclass, throwable, and preserves its message', () => {
  assert.strictEqual(typeof fc.FailClosed, 'function');
  const e = new fc.FailClosed('boom');
  assert.ok(e instanceof Error, 'FailClosed must be instanceof Error');
  assert.ok(e instanceof fc.FailClosed);
  assert.strictEqual(e.message, 'boom');
  assert.throws(
    () => {
      throw new fc.FailClosed('thrown');
    },
    (err) => err instanceof Error && err.message === 'thrown'
  );
});

test('safeCommand returns the parsed tool_input.command for valid stdin', () => {
  const cmd = fc.safeCommand(
    JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'gh pr create' } })
  );
  assert.strictEqual(cmd, 'gh pr create');
});

test('safeCommand returns empty string on malformed stdin (never throws)', () => {
  assert.strictEqual(fc.safeCommand('}{ not json'), '');
  assert.strictEqual(fc.safeCommand(''), '');
  assert.strictEqual(fc.safeCommand(undefined), '');
});

test('safeCommand returns empty string when tool_input.command is absent', () => {
  assert.strictEqual(fc.safeCommand(JSON.stringify({ tool_name: 'Bash' })), '');
  assert.strictEqual(
    fc.safeCommand(JSON.stringify({ tool_name: 'Bash', tool_input: {} })),
    ''
  );
});
