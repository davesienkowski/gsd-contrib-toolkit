'use strict';

/**
 * hooks/protocol-reminder.test.cjs — node:test for the ENF-08 UserPromptSubmit reminder.
 *
 * This hook is the ONE advisory / fail-OPEN layer (HARD-01's automation clause): it is NOT
 * an enforcement gate. It injects the P0–P6 contribution-protocol reminder ONLY when the
 * prompt looks like a gsd-core contribution; otherwise it stays silent. Critically, on ANY
 * internal error it FAILS OPEN — emits nothing, never blocks the prompt.
 *
 * What we assert:
 *   - a contribution-shaped prompt → output enumerates P0..P6 (the six protocol steps)
 *   - an unrelated prompt → NO output (no injection)
 *   - malformed input → NO output + clean exit (fail-open; never throws, never blocks)
 *   - the pure builder never returns a deny/permissionDecision (it is not an enforcement gate)
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const mod = require('./protocol-reminder.cjs');
const { isContributionPrompt, buildReminder, evaluatePrompt } = mod;

test('a contribution-shaped prompt is detected', () => {
  const prompts = [
    'file an issue on gsd-core for this parser bug',
    'open a PR to fix the version gate',
    'help me contribute to gsd-core',
    'run gh issue create for this',
    'submit a bug report upstream',
    'gh pr create a fix for #123',
  ];
  for (const p of prompts) {
    assert.equal(isContributionPrompt(p), true, `should detect: ${p}`);
  }
});

test('an unrelated prompt is NOT detected', () => {
  const prompts = [
    'refactor this function to be cleaner',
    'what does this regex do?',
    'add a test for the date formatter',
    'explain the architecture of this module',
    '',
    null,
    undefined,
  ];
  for (const p of prompts) {
    assert.equal(isContributionPrompt(p), false, `should NOT detect: ${JSON.stringify(p)}`);
  }
});

test('the reminder enumerates P0 through P6', () => {
  const text = buildReminder();
  for (const step of ['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6']) {
    assert.ok(text.includes(step), `reminder must mention ${step}`);
  }
  // It is a reminder, never a decision/deny.
  assert.ok(!/permissionDecision/.test(text), 'reminder text must not carry a permissionDecision');
});

test('evaluatePrompt: contribution prompt → additionalContext carrying P0..P6', () => {
  const out = evaluatePrompt(
    JSON.stringify({ prompt: 'please file an issue on gsd-core', hook_event_name: 'UserPromptSubmit' })
  );
  assert.ok(out, 'should return an output envelope');
  const ctx = out.hookSpecificOutput && out.hookSpecificOutput.additionalContext;
  assert.ok(ctx, 'should inject additionalContext');
  for (const step of ['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6']) {
    assert.ok(ctx.includes(step), `injected context must mention ${step}`);
  }
  // Never an enforcement decision.
  assert.ok(!('permissionDecision' in (out.hookSpecificOutput || {})),
    'reminder must never emit a permissionDecision');
});

test('evaluatePrompt: unrelated prompt → no injection (null)', () => {
  const out = evaluatePrompt(
    JSON.stringify({ prompt: 'refactor this function', hook_event_name: 'UserPromptSubmit' })
  );
  assert.equal(out, null, 'unrelated prompt should inject nothing');
});

test('evaluatePrompt FAILS OPEN on malformed input → null, never throws', () => {
  const bad = ['not json at all', '{ broken', '', '[]', 'null', '12', JSON.stringify({ no: 'prompt' })];
  for (const b of bad) {
    let out;
    assert.doesNotThrow(() => {
      out = evaluatePrompt(b);
    }, `must not throw on: ${JSON.stringify(b)}`);
    assert.equal(out, null, `malformed input must inject nothing: ${JSON.stringify(b)}`);
  }
});

test('evaluatePrompt FAILS OPEN on non-string input → null, never throws', () => {
  for (const b of [null, undefined, 42, {}, []]) {
    let out;
    assert.doesNotThrow(() => {
      out = evaluatePrompt(b);
    });
    assert.equal(out, null);
  }
});
