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

// ---- ENF-11 advisory severity: emit() must learn 'ask' WITHOUT weakening fail-closed ----
//
// Context (quick task 260729-p3f / C1): the citation-overlap advisory ships at
// `permissionDecision:'ask'` because its MEASURED recall is 2/9 at 0.048 fires per filing —
// far too noisy to be a deny. Before this change `emit()` collapsed EVERY non-'allow'
// decision to 'deny', so an 'ask' silently became the exact hard block the measurement
// rules out. The change is purely ADDITIVE: 'ask' passes through, and everything that is
// neither 'allow' nor 'ask' STILL denies.
//
// These byte-exact envelope literals were captured from the PRE-change module. They are the
// regression fence: if a future edit to emit() perturbs the allow/deny wire format by even
// one character, these fail.
const ENVELOPE_ALLOW =
  '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}\n';
const ENVELOPE_DENY_REASON =
  '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"r"}}\n';
const ENVELOPE_DENY_DEFAULT =
  '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"denied"}}\n';
const ENVELOPE_DENY_EMPTY =
  '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"empty decision"}}\n';

/**
 * Capture exactly what emit() writes to stdout, byte for byte.
 * @param {*} decision
 * @returns {string}
 */
function captureEmit(decision) {
  const realWrite = process.stdout.write.bind(process.stdout);
  const savedExitCode = process.exitCode;
  let out = '';
  process.stdout.write = (chunk) => {
    out += chunk;
    return true;
  };
  try {
    fc.emit(decision);
  } finally {
    process.stdout.write = realWrite;
    process.exitCode = savedExitCode;
  }
  return out;
}

test('ask() returns an ask decision carrying the reason', () => {
  const d = fc.ask('two shared rare code citations with #2774');
  assert.strictEqual(d.permissionDecision, 'ask');
  assert.strictEqual(d.permissionDecisionReason, 'two shared rare code citations with #2774');
});

test('ask() defaults its reason rather than emitting undefined', () => {
  const d = fc.ask();
  assert.strictEqual(d.permissionDecision, 'ask');
  assert.strictEqual(typeof d.permissionDecisionReason, 'string');
  assert.ok(d.permissionDecisionReason.length > 0);
});

test('emit(ask) round-trips as permissionDecision:ask WITH its reason (not collapsed to deny)', () => {
  const out = captureEmit(fc.ask('shares 2 rare paths with #2774'));
  const parsed = JSON.parse(out);
  assert.strictEqual(parsed.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.strictEqual(parsed.hookSpecificOutput.permissionDecision, 'ask');
  assert.strictEqual(
    parsed.hookSpecificOutput.permissionDecisionReason,
    'shares 2 rare paths with #2774'
  );
});

test('emit(allow) envelope is BYTE-IDENTICAL to the pre-change format', () => {
  assert.strictEqual(captureEmit(fc.allow()), ENVELOPE_ALLOW);
});

test('emit(deny) envelope is BYTE-IDENTICAL to the pre-change format', () => {
  assert.strictEqual(captureEmit(fc.deny('r')), ENVELOPE_DENY_REASON);
  assert.strictEqual(captureEmit(fc.deny()), ENVELOPE_DENY_DEFAULT);
});

test('emit() fail-closed default is UNCHANGED: null/undefined/{}/garbage/unknown ALL deny', () => {
  // The fail-closed floor. Teaching emit() one new decision value must not open a hole for
  // an empty, malformed, or unrecognized decision — each of these still denies, byte-exactly.
  assert.strictEqual(captureEmit(null), ENVELOPE_DENY_EMPTY, 'emit(null)');
  assert.strictEqual(captureEmit(undefined), ENVELOPE_DENY_EMPTY, 'emit(undefined)');
  assert.strictEqual(captureEmit('garbage'), ENVELOPE_DENY_EMPTY, "emit('garbage')");
  assert.strictEqual(captureEmit({}), ENVELOPE_DENY_DEFAULT, 'emit({})');
  assert.strictEqual(
    captureEmit({ permissionDecision: 'wat' }),
    ENVELOPE_DENY_DEFAULT,
    "emit({permissionDecision:'wat'})"
  );
  // Near-misses on the new literal must NOT sneak through as an ask.
  assert.strictEqual(captureEmit({ permissionDecision: 'ASK' }), ENVELOPE_DENY_DEFAULT, 'ASK');
  assert.strictEqual(captureEmit({ permissionDecision: ' ask' }), ENVELOPE_DENY_DEFAULT, '" ask"');
  assert.strictEqual(captureEmit({ permissionDecision: 'asks' }), ENVELOPE_DENY_DEFAULT, 'asks');
});

test('runGate passes a returned ask THROUGH (it is a real policy choice, not an error)', () => {
  // Without this, gate() returning an ask would be collapsed to ALLOW by runGate's
  // `return allow()` fallthrough and the advisory would never reach the user.
  const { impl, calls } = makeOverrideStub({ override: true, reason: 'should-not-matter' });
  const decision = fc.runGate(() => fc.ask('shares 2 rare paths with #2774'), {
    worktreeRoot: '/tmp/wt-ask',
    command: 'gh issue create --title x',
    action: 'issue-create',
    overrideImpl: impl,
  });
  assert.strictEqual(decision.permissionDecision, 'ask');
  assert.match(decision.permissionDecisionReason, /#2774/);
  // An ask is not an error, so the override must not flip it and no receipt is written.
  assert.strictEqual(calls.writeReceipt.length, 0, 'an ask must NOT write an override receipt');
});

test('runGate still DENIES on a throw even though ask now exists (HARD-01 unweakened)', () => {
  const { impl } = makeOverrideStub({ override: false });
  const decision = fc.runGate(
    () => {
      throw new Error('gh not authenticated');
    },
    { worktreeRoot: '/tmp/wt-ask-throw', action: 'issue-create', overrideImpl: impl }
  );
  assert.strictEqual(decision.permissionDecision, 'deny');
});

// ─── OBS-02 (Half B): the verdict-log wrapper must be unable to affect enforcement ───────────
//
// runGate now wraps the (unchanged) fail-closed path so every gate's verdict is recorded at one
// chokepoint. These pin the four non-negotiables AT THE runGate LEVEL — verdict-log.test.cjs pins
// them inside the recorder; these prove the wiring cannot betray them either. failclosed.cjs is
// the file whose blast radius is all 15 gates, so "the instrumentation is safe" is not something
// to take on trust.

const NOOP_OVERRIDE = { checkOverride: () => ({ override: false }), writeReceipt: () => {} };

function captureVerdict() {
  const seen = [];
  return {
    seen,
    deps: { env: {}, writer: (line) => { seen.push(JSON.parse(line)); return '/fake'; } },
  };
}

test('OBS-02: an allow is returned UNCHANGED and recorded', () => {
  const cap = captureVerdict();
  const out = fc.runGate(() => fc.allow(), {
    action: 'probe-allow',
    command: 'ls -la',
    overrideImpl: NOOP_OVERRIDE,
    verdictLogDeps: cap.deps,
  });
  assert.strictEqual(out.permissionDecision, 'allow');
  assert.strictEqual(cap.seen.length, 1);
  assert.strictEqual(cap.seen[0].decision, 'allow');
  assert.strictEqual(cap.seen[0].gate, 'probe-allow');
  assert.strictEqual(typeof cap.seen[0].duration_ms, 'number');
});

test('OBS-02: a fail-closed DENY from a THROW is recorded as deny (the previously invisible event)', () => {
  const cap = captureVerdict();
  const out = fc.runGate(() => { throw new Error('live script missing'); }, {
    action: 'probe-throw',
    command: 'gh pr create --title x',
    overrideImpl: NOOP_OVERRIDE,
    verdictLogDeps: cap.deps,
  });
  assert.strictEqual(out.permissionDecision, 'deny');
  assert.strictEqual(cap.seen[0].decision, 'deny');
  // The whole point of Half B: PostToolUse never fires for this call, so before OBS-02 this
  // event left no trace anywhere.
  assert.strictEqual(cap.seen[0].gate, 'probe-throw');
});

test('OBS-02: a recorder that THROWS cannot break the gate (enforcement > measurement)', () => {
  const boom = { env: {}, writer: () => { throw new Error('log disk on fire'); } };
  let out;
  assert.doesNotThrow(() => {
    out = fc.runGate(() => fc.deny('real policy deny'), {
      action: 'probe-boom',
      overrideImpl: NOOP_OVERRIDE,
      verdictLogDeps: boom,
    });
  });
  assert.strictEqual(out.permissionDecision, 'deny');
  assert.match(out.permissionDecisionReason, /real policy deny/);
});

test('OBS-02: the recorder cannot MUTATE the decision it is handed', () => {
  const mutating = {
    env: {},
    writer: () => '/fake',
  };
  const out = fc.runGate(() => fc.deny('untouched'), {
    action: 'probe-mutate',
    overrideImpl: NOOP_OVERRIDE,
    verdictLogDeps: mutating,
  });
  assert.strictEqual(out.permissionDecision, 'deny');
  assert.strictEqual(out.permissionDecisionReason, 'untouched');
});

test('OBS-02: the kill switch silences recording without changing any verdict', () => {
  const cap = captureVerdict();
  cap.deps.env = { GSD_CONTRIB_NO_VERDICT_LOG: '1' };
  const out = fc.runGate(() => fc.deny('still denied'), {
    action: 'probe-off',
    overrideImpl: NOOP_OVERRIDE,
    verdictLogDeps: cap.deps,
  });
  assert.strictEqual(out.permissionDecision, 'deny', 'gate logic is untouched by the switch');
  assert.deepStrictEqual(cap.seen, [], 'nothing recorded');
});

test('OBS-02: ctx.stdin supplies session/tool ids; the raw command is NEVER recorded', () => {
  const cap = captureVerdict();
  fc.runGate(() => fc.deny('x'), {
    action: 'probe-ids',
    command: 'gh pr create --body "TOKEN-shhh"',
    stdin: JSON.stringify({ session_id: 's1', tool_use_id: 't1', tool_name: 'Bash' }),
    overrideImpl: NOOP_OVERRIDE,
    verdictLogDeps: cap.deps,
  });
  const rec = cap.seen[0];
  assert.strictEqual(rec.session_id, 's1');
  assert.strictEqual(rec.tool_use_id, 't1');
  assert.strictEqual(rec.tool_name, 'Bash');
  assert.strictEqual(rec.action, 'pr-create', 'classified action only');
  assert.ok(!JSON.stringify(rec).includes('TOKEN-shhh'), 'the command body must never be logged');
});

test('OBS-02: the OUTER guard holds even if the recorder itself throws (mutation-proven)', () => {
  // recordVerdict is total, so a throwing WRITER only exercises its internal guard. Injecting a
  // throwing RECORDER is the only way to prove runGate's own try/catch is load-bearing —
  // mutation-testing showed that without this case, deleting that catch failed zero tests.
  let out;
  assert.doesNotThrow(() => {
    out = fc.runGate(() => fc.deny('policy deny survives'), {
      action: 'probe-outer-guard',
      overrideImpl: NOOP_OVERRIDE,
      recordVerdictImpl: () => {
        throw new Error('recorder itself exploded');
      },
    });
  });
  assert.strictEqual(out.permissionDecision, 'deny');
  assert.strictEqual(out.permissionDecisionReason, 'policy deny survives');
});
