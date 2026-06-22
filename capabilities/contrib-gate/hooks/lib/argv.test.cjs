'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { tokenize, parseCommand } = require('./argv.cjs');

// ---------------------------------------------------------------------------
// tokenize: POSIX-aware shell tokenizer
// ---------------------------------------------------------------------------

test('tokenize splits on unquoted whitespace', () => {
  assert.deepStrictEqual(tokenize('gh issue create'), ['gh', 'issue', 'create']);
});

test('tokenize preserves double-quoted whitespace as one token', () => {
  assert.deepStrictEqual(tokenize('git commit -m "a b c"'), [
    'git',
    'commit',
    '-m',
    'a b c',
  ]);
});

test('tokenize preserves single-quoted whitespace as one token', () => {
  assert.deepStrictEqual(tokenize("git commit -m 'a b c'"), [
    'git',
    'commit',
    '-m',
    'a b c',
  ]);
});

test('tokenize honours backslash escape outside quotes', () => {
  assert.deepStrictEqual(tokenize('echo a\\ b'), ['echo', 'a b']);
});

test('tokenize keeps single quotes literal inside double quotes', () => {
  assert.deepStrictEqual(tokenize('echo "it\'s"'), ['echo', "it's"]);
});

test('tokenize joins adjacent quoted+unquoted into one token', () => {
  assert.deepStrictEqual(tokenize('--body="inline value"'), [
    '--body=inline value',
  ]);
});

test('tokenize throws on unbalanced double quote', () => {
  assert.throws(() => tokenize('git commit -m "oops'));
});

test('tokenize throws on unbalanced single quote', () => {
  assert.throws(() => tokenize("git commit -m 'oops"));
});

test('tokenize throws on dangling trailing escape', () => {
  assert.throws(() => tokenize('echo foo\\'));
});

// ---------------------------------------------------------------------------
// parseCommand: structured parse
// ---------------------------------------------------------------------------

test('parseCommand parses program/subcommands/flags', () => {
  const p = parseCommand('gh issue create --title "x" --body-file body.md');
  assert.strictEqual(p.ok, true);
  assert.strictEqual(p.program, 'gh');
  assert.deepStrictEqual(p.subcommands, ['issue', 'create']);
  assert.strictEqual(p.flags.title, 'x');
  assert.strictEqual(p.flags['body-file'], 'body.md');
});

test('parseCommand: reordered flags yield identical flag maps', () => {
  const a = parseCommand('gh pr create --base next --title x');
  const b = parseCommand('gh pr create --title x --base next');
  assert.strictEqual(a.ok, true);
  assert.strictEqual(b.ok, true);
  assert.deepStrictEqual(a.flags, b.flags);
});

test('parseCommand: --body-file - records stdin sentinel (not missing body)', () => {
  const p = parseCommand('gh issue create --title x --body-file -');
  assert.strictEqual(p.ok, true);
  assert.strictEqual(p.flags['body-file'], '-');
});

test('parseCommand: --body=inline equals-form parses to flags.body', () => {
  const p = parseCommand('gh issue create --body=inline');
  assert.strictEqual(p.ok, true);
  assert.strictEqual(p.flags.body, 'inline');
});

test('parseCommand: --body inline space-form parses to flags.body', () => {
  const p = parseCommand('gh issue create --body inline');
  assert.strictEqual(p.ok, true);
  assert.strictEqual(p.flags.body, 'inline');
});

test('parseCommand: short flag -t x captured as shortFlags.t', () => {
  const p = parseCommand('gh issue create -t x');
  assert.strictEqual(p.ok, true);
  assert.strictEqual(p.shortFlags.t, 'x');
});

test('parseCommand: -m "msg" captured with quoted value', () => {
  const p = parseCommand('git commit -m "my message"');
  assert.strictEqual(p.ok, true);
  assert.strictEqual(p.shortFlags.m, 'my message');
});

test('parseCommand: unknown short flag retained, not dropped', () => {
  const p = parseCommand('curl -XPOST https://api.github.com/repos/o/r/issues');
  assert.strictEqual(p.ok, true);
  // -XPOST should be retained somewhere recoverable
  assert.ok('X' in p.shortFlags || p.raw.includes('-XPOST'));
});

// --------------------------- FAIL CLOSED ----------------------------------

test('parseCommand FAILS CLOSED on unbalanced quote (no throw, ok:false)', () => {
  const p = parseCommand('gh issue create --title "unterminated');
  assert.strictEqual(p.ok, false);
  assert.ok(typeof p.reason === 'string' && p.reason.length > 0);
});

test('parseCommand FAILS CLOSED on null byte', () => {
  const p = parseCommand('gh issue create --title x' + String.fromCharCode(0) + 'evil');
  assert.strictEqual(p.ok, false);
  assert.ok(typeof p.reason === 'string' && p.reason.length > 0);
});

test('parseCommand FAILS CLOSED on empty command', () => {
  const p = parseCommand('');
  assert.strictEqual(p.ok, false);
});

test('parseCommand FAILS CLOSED on whitespace-only command', () => {
  const p = parseCommand('   \t  ');
  assert.strictEqual(p.ok, false);
});

test('parseCommand FAILS CLOSED on null/undefined input (never throws)', () => {
  assert.strictEqual(parseCommand(null).ok, false);
  assert.strictEqual(parseCommand(undefined).ok, false);
  assert.strictEqual(parseCommand(42).ok, false);
});

// --------------------------- segments -------------------------------------

test('parseCommand splits ;-chained commands into segments, each parsed', () => {
  const p = parseCommand('gh issue create --title a ; gh pr create --title b');
  assert.strictEqual(p.ok, true);
  assert.strictEqual(p.segments.length, 2);
  assert.deepStrictEqual(p.segments[0].subcommands, ['issue', 'create']);
  assert.deepStrictEqual(p.segments[1].subcommands, ['pr', 'create']);
});

test('parseCommand splits && and || chained commands', () => {
  const p = parseCommand('git add . && git commit -m x || echo fail');
  assert.strictEqual(p.ok, true);
  assert.strictEqual(p.segments.length, 3);
});

test('parseCommand splits on unquoted pipe', () => {
  const p = parseCommand('cat x | gh pr create --title y');
  assert.strictEqual(p.ok, true);
  assert.strictEqual(p.segments.length, 2);
  assert.deepStrictEqual(p.segments[1].subcommands, ['pr', 'create']);
});

test('parseCommand does NOT split on quoted separators', () => {
  const p = parseCommand('git commit -m "a ; b && c | d"');
  assert.strictEqual(p.ok, true);
  assert.strictEqual(p.segments.length, 1);
  assert.strictEqual(p.shortFlags.m, 'a ; b && c | d');
});

test('parseCommand: top-level fields mirror first segment', () => {
  const p = parseCommand('gh issue create --title a ; gh pr create --title b');
  assert.strictEqual(p.program, 'gh');
  assert.deepStrictEqual(p.subcommands, ['issue', 'create']);
});

// ---------------------------------------------------------------------------
// Heredoc handling (G3)
//
// A bare heredoc body is opaque shell input, NOT command syntax. Previously the
// tokenizer walked the body char-by-char: an apostrophe in prose tripped the
// unbalanced-quote guard → ok:false → fail-closed → a legit `gh pr create
// --body-file - <<EOF` was over-blocked; and `;`/`&&`/`|` in the body wrongly
// split segments. parseCommand must treat the heredoc body (next line → terminator
// line) as opaque in both splitSegments and tokenize.
// ---------------------------------------------------------------------------

test('heredoc body with an apostrophe does NOT unbalance quotes (ok:true) [G3]', () => {
  const p = parseCommand("gh pr create --body-file - <<EOF\nit's a fix\nEOF");
  assert.strictEqual(p.ok, true, p.reason);
  assert.strictEqual(p.program, 'gh');
  assert.deepStrictEqual(p.subcommands, ['pr', 'create']);
});

test('heredoc body with ; && | does NOT split into extra segments [G3]', () => {
  const p = parseCommand('gh issue create --body-file - <<EOF\na; b && c | d\nEOF');
  assert.strictEqual(p.ok, true, p.reason);
  assert.strictEqual(p.segments.length, 1);
  assert.deepStrictEqual(p.segments[0].subcommands, ['issue', 'create']);
});

test('quoted heredoc delimiter <<\'EOF\' is recognized [G3]', () => {
  const p = parseCommand("gh pr create --body-file - <<'EOF'\nliteral $stuff and it's fine\nEOF");
  assert.strictEqual(p.ok, true, p.reason);
  assert.deepStrictEqual(p.subcommands, ['pr', 'create']);
});

test('double-quoted heredoc delimiter <<"EOF" is recognized [G3]', () => {
  const p = parseCommand('gh pr create --body-file - <<"EOF"\nbody; with & metachars\nEOF');
  assert.strictEqual(p.ok, true, p.reason);
  assert.deepStrictEqual(p.subcommands, ['pr', 'create']);
});

test('<<-EOF strips leading tabs on the terminator line [G3]', () => {
  const p = parseCommand('gh issue create --body-file - <<-EOF\n\tindented body; ok\n\tEOF');
  assert.strictEqual(p.ok, true, p.reason);
  assert.strictEqual(p.segments.length, 1);
  assert.deepStrictEqual(p.segments[0].subcommands, ['issue', 'create']);
});

test('heredoc body running to end-of-string (no trailing newline) parses [G3]', () => {
  const p = parseCommand('gh pr create --body-file - <<EOF\nline one\nline two; still body\nEOF\n');
  assert.strictEqual(p.ok, true, p.reason);
  assert.strictEqual(p.segments.length, 1);
});

test('a real pipe AFTER the heredoc terminator still splits [G3]', () => {
  // `cat <<EOF ... EOF` then `| gh pr create` on the line after the terminator.
  const p = parseCommand('cat <<EOF\nbody; text\nEOF\n| gh pr create --title x');
  assert.strictEqual(p.ok, true, p.reason);
  assert.strictEqual(p.segments.length, 2);
  assert.deepStrictEqual(p.segments[1].subcommands, ['pr', 'create']);
});

test('single < redirection is NOT treated as a heredoc [G3 guard]', () => {
  const p = parseCommand('gh pr create --title x < file.txt');
  assert.strictEqual(p.ok, true, p.reason);
  assert.strictEqual(p.segments.length, 1);
  assert.deepStrictEqual(p.subcommands, ['pr', 'create']);
});

// ---------------------------------------------------------------------------
// Leading env-assignment stripping (CR-02)
//
// A shell env-assignment prefix (`GIT_DIR=/x git commit …`, `A=1 B=2 git push …`)
// pushed the program out of reach: classifyTokens read `tokens[0]` ('GIT_DIR=/x')
// as the program, so the verb never surfaced → action:'other' → silent allow of a
// gated mutation. classifyTokens must drop the LEADING run of `NAME=VALUE` tokens
// before reading the program, while keeping `seg.tokens` the full raw argv (HARD-04).
// ---------------------------------------------------------------------------

test('env-prefix: GIT_DIR=/x git commit → program git, subcommand commit [CR-02]', () => {
  const p = parseCommand('GIT_DIR=/x git commit -m bad');
  assert.strictEqual(p.ok, true, p.reason);
  assert.strictEqual(p.program, 'git');
  assert.strictEqual(p.subcommands[0], 'commit');
});

test('env-prefix: multiple leading assignments all stripped [CR-02]', () => {
  const p = parseCommand('A=1 B=2 git push origin main');
  assert.strictEqual(p.ok, true, p.reason);
  assert.strictEqual(p.program, 'git');
  assert.strictEqual(p.subcommands[0], 'push');
});

test('env-prefix control: no-env command is unchanged [CR-02]', () => {
  const p = parseCommand('git commit -m ok');
  assert.strictEqual(p.ok, true, p.reason);
  assert.strictEqual(p.program, 'git');
  assert.strictEqual(p.subcommands[0], 'commit');
});

test('env-prefix guard: a NON-leading key=val token is NOT stripped [CR-02]', () => {
  // The `=`-bearing token follows the program, so it is a positional, not an
  // env-assignment prefix — the program must still be the first real token.
  const p = parseCommand('git -c user.name=x commit -m y');
  assert.strictEqual(p.ok, true, p.reason);
  assert.strictEqual(p.program, 'git');
});

test('env-prefix: seg.tokens retains the FULL argv incl. assignments [CR-02 / HARD-04]', () => {
  const p = parseCommand('GIT_DIR=/x git commit -m bad');
  assert.strictEqual(p.ok, true, p.reason);
  assert.strictEqual(p.tokens[0], 'GIT_DIR=/x');
  assert.strictEqual(p.tokens[1], 'git');
});

test('env-prefix: an env-ONLY command neither throws nor becomes a gated program [CR-02]', () => {
  const p = parseCommand('FOO=bar');
  // Must not throw; program resolves to '' (no real program after the assignments).
  assert.strictEqual(p.ok, true, p.reason);
  assert.strictEqual(p.program, '');
  assert.deepStrictEqual(p.subcommands, []);
});
