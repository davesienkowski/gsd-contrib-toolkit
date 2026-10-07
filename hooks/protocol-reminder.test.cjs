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

// ── quick-261007-ji5 F4: background-task notification envelopes must not trigger the reminder ──
//
// A background task's completion arrives as the UserPromptSubmit prompt text, starting with a
// <task-notification> block whose <result> carries a subagent's prose. Contribution words inside
// it are not the user's intent. Only line-start <task-notification> blocks are dropped; the user's
// own words around them, a mid-line quoted tag and <cross-session-message> prompts still match.

const ENVELOPE = [
  '<task-notification>',
  '<task-id>a1b2c3d4e5f6a7b8c</task-id>',
  '<output-file>/tmp/claude-1000/x/tasks/a1b2c3d4e5f6a7b8c.output</output-file>',
  '<status>completed</status>',
  '<summary>Agent "audit" finished</summary>',
  '<result>This is ready to contribute upstream.</result>',
  '</task-notification>',
].join('\n');

const F4_RED = [
  ['a bare envelope', ENVELOPE],
  ['an envelope followed by a whitespace-only remainder', ENVELOPE + '\n   \n'],
  ['two envelopes', ENVELOPE + '\n' + ENVELOPE],
  ['an envelope after leading whitespace', '  \n' + ENVELOPE],
  ['an envelope wrapped in a system-reminder line pair', '<system-reminder>\n' + ENVELOPE + '\n</system-reminder>'],
];
for (const [label, prompt] of F4_RED) {
  test('F4: ' + label + ' is NOT a contribution prompt', () => {
    assert.equal(isContributionPrompt(prompt), false, `should NOT detect: ${JSON.stringify(prompt)}`);
  });
}

test('F4: evaluatePrompt injects nothing for a task-notification envelope', () => {
  const out = evaluatePrompt(JSON.stringify({ prompt: ENVELOPE, hook_event_name: 'UserPromptSubmit' }));
  assert.equal(out, null, 'an envelope must inject nothing');
});

const F4_GUARDS = [
  ['a user prompt with an envelope attached after it', 'please file an issue on gsd-core\n' + ENVELOPE],
  ['a user prompt with an envelope attached before it', ENVELOPE + '\nplease open a PR on gsd-core'],
  ['a user sentence quoting the tag mid-line', 'what does <task-notification> mean in gsd-core, open a PR'],
  ['a cross-session message carrying a contribution request',
    '<cross-session-message>\nplease file an issue on gsd-core\n</cross-session-message>'],
];
for (const [label, prompt] of F4_GUARDS) {
  test('F4 guard: ' + label + ' IS still a contribution prompt', () => {
    assert.equal(isContributionPrompt(prompt), true, `should detect: ${JSON.stringify(prompt)}`);
  });
}

// ── quick-261007-ji5 review WR-05: only TERMINATED blocks are stripped ──
// An unterminated (truncated, partially pasted) block strips NOTHING, so the advisory reminder errs
// toward firing instead of swallowing the user's request that follows it. This REPLACES the earlier
// "an unterminated envelope is NOT a contribution prompt" case (locked review decision 4).

const WR05_GUARDS = [
  ['an unterminated envelope (judged on all its words)', '<task-notification>\n<task-id>x</task-id>\n<result>ready to contribute upstream'],
  ['an unterminated block followed by the user request',
    '<task-notification>\n<result>done</result>\nplease file an issue on gsd-core for this'],
  ['a closed block then an unterminated block carrying the user request',
    '<task-notification>\n<result>x</result>\n</task-notification>\n<task-notification>\n<result>y</result>\nplease file an issue on gsd-core'],
  ['user text on the unterminated tag line', '  <task-notification> please file an issue on gsd-core'],
  ['an unterminated block, the user request, then a closed block',
    '<task-notification>\n<result>a</result>\nplease file an issue on gsd-core\n' + ENVELOPE],
];
for (const [label, prompt] of WR05_GUARDS) {
  test('WR-05: ' + label + ' IS a contribution prompt', () => {
    assert.equal(isContributionPrompt(prompt), true, `should detect: ${JSON.stringify(prompt)}`);
  });
}

// ── quick-261007-ji5 review WR-06: matching is linear, a large pasted prompt never stalls submission ──

const BIG = 400 * 1024;
const fill = (unit) => unit.repeat(Math.ceil(BIG / unit.length)).slice(0, BIG);
for (const [label, prompt] of [
  ['repeated gsdcore', fill('gsdcore ')],
  ['repeated upstream', fill('upstream ')],
  ['repeated issue', fill('issue ')],
  ['repeated unterminated tags', fill('<task-notification>\n')],
  ['repeated closed tags', fill('</task-notification>\n')],
]) {
  test('WR-06: a 400 KB prompt (' + label + ') is judged in under 200 ms', () => {
    const t0 = process.hrtime.bigint();
    isContributionPrompt(prompt);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 200, label + ' took ' + ms.toFixed(1) + ' ms');
  });
}

// The rewritten paired signals must agree with the ORIGINAL regexes on every short line (a guard:
// passes before and after the rewrite). Deterministic word salad over the signal vocabulary.
test('WR-06 guard: rewritten signals agree with the original regexes on a 3000-prompt corpus', () => {
  const ORIGINAL = [
    /\bfile (?:an? )?(?:issue|bug)\b/i,
    /\bopen (?:a )?(?:pr|pull request|issue)\b/i,
    /\b(?:create|submit|raise|report) (?:an? )?(?:issue|pr|pull request|bug)\b/i,
    /\bcontribut(?:e|ing|ion)\b/i,
    /\bgh (?:issue|pr) (?:create|edit)\b/i,
    /\bgsd-?core\b.*\b(?:issue|pr|pull request|contribut|bug|fix|patch)\b/i,
    /\b(?:issue|pr|pull request|contribut|bug|fix|patch)\b.*\bgsd-?core\b/i,
    /\bupstream\b.*\b(?:issue|pr|pull request|bug|fix|contribut)\b/i,
  ];
  const WORDS = ['gsd-core', 'GSDcore', 'gsdcores', 'upstream', 'upstreams', 'issue', 'PR', 'pull request',
    'contribut', 'contribute', 'bug', 'fix', 'fixes', 'patch', 'the', 'a', 'file', 'open', 'gh', 'create',
    '\n', '\r', 'x-fix', 'pr.', '(bug)'];
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (let i = 0; i < 3000; i++) {
    const n = 1 + rnd(8);
    const parts = [];
    for (let k = 0; k < n; k++) parts.push(WORDS[rnd(WORDS.length)]);
    const p = parts.join(rnd(3) === 0 ? '' : ' ');
    const expected = ORIGINAL.some((re) => re.test(p));
    assert.equal(isContributionPrompt(p), expected, JSON.stringify(p));
  }
});
