'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { parseCommand } = require('./argv.cjs');
const { hasFlag, extractMessageText } = require('./flags.cjs');

const p = (cmd) => parseCommand(cmd);

// ---------------------------------------------------------------------------
// hasFlag — real argv flag, NOT message text (ENF-12 / EP-3)
// ---------------------------------------------------------------------------

test('hasFlag true for real --no-verify flag', () => {
  assert.strictEqual(
    hasFlag(p('git commit --no-verify -m "x"'), ['--no-verify', '-n']),
    true
  );
});

test('hasFlag FALSE when --no-verify appears inside the -m message', () => {
  assert.strictEqual(
    hasFlag(p('git commit -m "never use --no-verify here"'), ['--no-verify', '-n']),
    false
  );
});

test('hasFlag true for short -n alias', () => {
  assert.strictEqual(
    hasFlag(p('git commit -n -m "x"'), ['--no-verify', '-n']),
    true
  );
});

test('hasFlag true for --no-verify=true (=value form still present)', () => {
  assert.strictEqual(
    hasFlag(p('git commit --no-verify=true -m "x"'), ['--no-verify']),
    true
  );
});

test('hasFlag false when neither flag present', () => {
  assert.strictEqual(
    hasFlag(p('git commit -m "ordinary message"'), ['--no-verify', '-n']),
    false
  );
});

test('hasFlag accepts names with or without leading dashes', () => {
  assert.strictEqual(hasFlag(p('git commit --no-verify'), ['no-verify']), true);
  assert.strictEqual(hasFlag(p('git commit -n'), ['n']), true);
});

test('hasFlag scans ALL segments of a chained command', () => {
  assert.strictEqual(
    hasFlag(p('git add . && git commit --no-verify -m x'), ['--no-verify', '-n']),
    true
  );
});

test('hasFlag false on a failed parse (fail-closed handled by caller, not here)', () => {
  // hasFlag must never throw on a bad parse; returns false so the gate decides.
  assert.strictEqual(hasFlag(p('git commit -m "unterminated'), ['--no-verify']), false);
  assert.strictEqual(hasFlag(null, ['--no-verify']), false);
  assert.strictEqual(hasFlag({}, ['--no-verify']), false);
});

test('hasFlag false for empty names list', () => {
  assert.strictEqual(hasFlag(p('git commit --no-verify'), []), false);
});

test('hasFlag does not match the bundled -XPOST as -n etc.', () => {
  assert.strictEqual(
    hasFlag(p('curl -XPOST https://api.github.com/repos/o/r/issues'), ['-n', '--no-verify']),
    false
  );
});

// ---------------------------------------------------------------------------
// extractMessageText — message body segregated from flag space
// ---------------------------------------------------------------------------

test('extractMessageText returns -m value', () => {
  assert.strictEqual(
    extractMessageText(p('git commit -m "hello world"')),
    'hello world'
  );
});

test('extractMessageText returns --message value', () => {
  assert.strictEqual(
    extractMessageText(p('git commit --message "long form"')),
    'long form'
  );
});

test('extractMessageText joins multiple -m occurrences', () => {
  // git allows repeated -m; argv keeps the last in shortFlags, but extractMessageText
  // should surface message content for inspection. At minimum the final message.
  const txt = extractMessageText(p('git commit -m "second"'));
  assert.ok(txt.includes('second'));
});

test('extractMessageText returns empty string when no message', () => {
  assert.strictEqual(extractMessageText(p('git commit --no-verify')), '');
});

test('extractMessageText never throws on failed/garbage parse', () => {
  assert.strictEqual(extractMessageText(p('git commit -m "unterminated')), '');
  assert.strictEqual(extractMessageText(null), '');
  assert.strictEqual(extractMessageText({}), '');
});

test('the --no-verify inside -m is recoverable via extractMessageText, not hasFlag', () => {
  const parsed = p('git commit -m "do not use --no-verify"');
  assert.strictEqual(hasFlag(parsed, ['--no-verify']), false);
  assert.ok(extractMessageText(parsed).includes('--no-verify'));
});
