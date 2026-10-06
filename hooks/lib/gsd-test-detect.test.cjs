'use strict';

/**
 * node:test for hooks/lib/gsd-test-detect.cjs — the shared gsd-test dispatch detector (GTEST-01,
 * GTEST-03).
 *
 * One test per dispatch variant, per non-dispatch, per pipe / pipefail row, per walker form
 * (including the checker-item-2 substitution and uncertain rows), per uncertain-input row and per
 * path-helper row. Every call goes through a guard that asserts the export exists first, so a
 * missing export fails at the assertion level (RED evidence), never as a TypeError.
 *
 * Pure: no fs, no child_process, no real gsd-test, no Docker.
 */

const test = require('node:test');
const assert = require('node:assert');

const det = require('./gsd-test-detect.cjs');

// ───────────────────────── guarded accessors ─────────────────────────

function exported(name) {
  assert.strictEqual(typeof det[name], 'function', `gsd-test-detect must export ${name}()`);
  return det[name];
}

/** All entries (dispatch + uncertain) for a command. */
function entries(cmd) {
  const r = exported('findGsdTestDispatches')(cmd);
  assert.ok(Array.isArray(r), 'findGsdTestDispatches must return an array');
  return r;
}

/** Exactly one entry, of kind dispatch. */
function oneDispatch(cmd) {
  const e = entries(cmd);
  assert.strictEqual(e.length, 1, `expected one entry for ${JSON.stringify(cmd)}, got ${JSON.stringify(e.map((x) => x.kind))}`);
  assert.strictEqual(e[0].kind, 'dispatch', `expected a dispatch for ${JSON.stringify(cmd)}, got ${JSON.stringify(e[0])}`);
  return e[0];
}

/** Exactly one entry, of kind uncertain. */
function oneUncertain(cmd) {
  const e = entries(cmd);
  assert.strictEqual(e.length, 1, `expected one entry for ${JSON.stringify(cmd)}, got ${e.length}`);
  assert.strictEqual(e[0].kind, 'uncertain', `expected uncertain for ${JSON.stringify(cmd)}, got ${e[0].kind}`);
  assert.strictEqual(typeof e[0].reason, 'string');
  assert.ok(e[0].reason.length > 0);
  return e[0];
}

function walk(tokens) {
  return exported('walkGoFlags')(tokens);
}

// ───────────────────────── GTEST-01: dispatch variants ─────────────────────────

const VARIANTS = [
  // [label, command, extra assertions]
  ['plain', 'gsd-test'],
  ['chained after cd (&&)', 'cd x && gsd-test'],
  ['chained after ;', 'true; gsd-test'],
  ['chained after ||', 'false || gsd-test'],
  ['followed by && (not piped)', 'gsd-test && echo ok'],
  ['env-prefixed', 'FOO=1 gsd-test'],
  ['sudo', 'sudo gsd-test'],
  ['sudo -u dave', 'sudo -u dave gsd-test'],
  ['command', 'command gsd-test'],
  ['env', 'env gsd-test'],
  ['env BAR=1', 'env BAR=1 gsd-test'],
  ['nice -n 5', 'nice -n 5 gsd-test'],
  ['timeout 600', 'timeout 600 gsd-test'],
  ['exec', 'exec gsd-test'],
  ['time (detector-local peel)', 'time gsd-test'],
  ['time -p (detector-local peel)', 'time -p gsd-test'],
  ['FOO=1 nohup sudo (stacked)', 'FOO=1 nohup sudo gsd-test'],
  ['absolute path', '/home/dave/.local/bin/gsd-test'],
  ['relative path', './gsd-test'],
  ['quoted program', '"gsd-test" -head HEAD', (d) => assert.strictEqual(d.flags.head, 'HEAD')],
  ['bash -c', 'bash -c "gsd-test -head HEAD"', (d) => {
    assert.strictEqual(d.viaDashC, true);
    assert.strictEqual(d.flags.head, 'HEAD');
  }],
  ['sh -c', "sh -c 'gsd-test'", (d) => assert.strictEqual(d.viaDashC, true)],
  ['bash -lc', 'bash -lc "gsd-test"', (d) => assert.strictEqual(d.viaDashC, true)],
  ['nested bash -c depth 2', `bash -c "bash -c 'gsd-test'"`, (d) => {
    assert.strictEqual(d.viaDashC, true);
    assert.strictEqual(d.depth, 2);
  }],
  ['subshell group', '(gsd-test -head HEAD)', (d) => assert.strictEqual(d.flags.head, 'HEAD')],
  ['brace group', '{ gsd-test; }'],
  ['after |& (leading & residue stripped)', 'foo |& gsd-test', (d) => assert.strictEqual(d.pipeMasked, false)],
  ['lone ! negation', '! gsd-test'],
  ['if/then body (Rule 2 keyword drop)', 'if true; then gsd-test; fi'],
  ['for/do body (Rule 2 keyword drop)', 'for f in a; do gsd-test; done'],
];

for (const [label, cmd, extra] of VARIANTS) {
  test(`GTEST-01: dispatch variant — ${label}: ${cmd}`, () => {
    const d = oneDispatch(cmd);
    assert.strictEqual(d.kind, 'dispatch');
    if (extra) extra(d);
  });
}

test('GTEST-01: nohup background form is a dispatch with head HEAD, background, not masked', () => {
  const d = oneDispatch('nohup gsd-test --head HEAD > log 2>&1 &');
  assert.strictEqual(d.background, true);
  assert.strictEqual(d.flags.head, 'HEAD');
  assert.strictEqual(d.pipeMasked, false);
  assert.deepStrictEqual(d.args, []);
});

test('GTEST-01: a lone & ends the dispatch’s arguments (`gsd-test --head HEAD & wait`)', () => {
  const d = oneDispatch('gsd-test --head HEAD & wait');
  assert.strictEqual(d.background, true);
  assert.strictEqual(d.flags.head, 'HEAD');
  assert.deepStrictEqual(d.args, []);
});

test('GTEST-01: an attached trailing & is background (`gsd-test --head x 2>&1&`)', () => {
  const d = oneDispatch('gsd-test --head x 2>&1&');
  assert.strictEqual(d.background, true);
  assert.strictEqual(d.flags.head, 'x');
});

test('GTEST-01: a dispatch entry carries the full documented shape', () => {
  const d = oneDispatch('cd sub && gsd-test -base next -head HEAD | tail');
  for (const k of ['seg', 'segIndex', 'args', 'flags', 'unresolved', 'informational', 'background',
    'pipedOut', 'pipefail', 'pipeMasked', 'viaDashC', 'depth', 'prefixes']) {
    assert.ok(k in d, `dispatch entry missing ${k}`);
  }
  assert.strictEqual(d.segIndex, 1);
  assert.ok(d.unresolved instanceof Set);
  assert.strictEqual(d.viaDashC, false);
  assert.strictEqual(d.depth, 0);
  assert.strictEqual(d.prefixes.length, 1);
  assert.strictEqual(d.prefixes[0].ok, true);
  assert.strictEqual(d.prefixes[0].segments.length, 1);
  assert.strictEqual(d.prefixes[0].segments[0].program, 'cd');
});

test('GTEST-01: two dispatches in one command -> two entries, first masked, second not', () => {
  const e = entries('gsd-test -head origin/next | tail; gsd-test -head HEAD');
  assert.strictEqual(e.length, 2);
  assert.ok(e.every((x) => x.kind === 'dispatch'));
  assert.strictEqual(e[0].flags.head, 'origin/next');
  assert.strictEqual(e[0].pipeMasked, true);
  assert.strictEqual(e[1].flags.head, 'HEAD');
  assert.strictEqual(e[1].pipeMasked, false);
});

test('GTEST-01: five stacked nohup wrappers exceed the peel bound -> uncertain (fail closed)', () => {
  oneUncertain('nohup nohup nohup nohup nohup gsd-test');
});

// ───────────────────────── GTEST-01: non-dispatches ─────────────────────────

const NON_DISPATCHES = [
  'echo gsd-test',
  'echo "gsd-test | tail"',
  'git commit -m "gsd-test --head HEAD | tail"',
  'which gsd-test',
  'rg gsd-test .',
  'gsd-test-other --head HEAD',
  'cat <<EOF\ngsd-test | tail\nEOF',
  'gsd‑test -head HEAD',
  'git status',
  'ls gsd-test-clean-tree.cjs',
];

for (const cmd of NON_DISPATCHES) {
  test(`GTEST-01: non-dispatch yields no entry — ${JSON.stringify(cmd)}`, () => {
    assert.deepStrictEqual(entries(cmd), []);
  });
}

// ───────────────────────── GTEST-03: pipe attribution ─────────────────────────

const PIPE_MASKED_TRUE = [
  'gsd-test | tail',
  'gsd-test |& tee log',
  '(gsd-test -head HEAD) | tail',
  '{ gsd-test; } 2>&1 | tail',
  '(gsd-test; echo done) | tail',
  '(cd x && gsd-test) | tail',
  'gsd-test --head $(git rev-parse HEAD) | tail',
  'gsd-test |',
  '"gsd-test" -head HEAD | tail',
  'bash -c "gsd-test" | tail',
  'if true; then gsd-test | tail; fi',
  '(gsd-test && echo ok) | tail',
];

for (const cmd of PIPE_MASKED_TRUE) {
  test(`GTEST-03 pipe: masked — ${cmd}`, () => {
    const d = oneDispatch(cmd);
    assert.strictEqual(d.pipeMasked, true);
  });
}

const PIPE_MASKED_FALSE = [
  'git show | grep x; gsd-test',
  'gsd-test || true',
  '(gsd-test) ; foo | bar',
  'gsd-test ｜ tail',
  "gsd-test '|' tail",
  '(gsd-test; foo | bar)',
  'gsd-test; echo done | cat',
];

for (const cmd of PIPE_MASKED_FALSE) {
  test(`GTEST-03 pipe: not masked — ${cmd}`, () => {
    const d = oneDispatch(cmd);
    assert.strictEqual(d.pipeMasked, false);
    assert.strictEqual(d.pipedOut, false);
  });
}

test('GTEST-03 pipe: a plain piped dispatch reports pipedOut true and pipefail false', () => {
  const d = oneDispatch('gsd-test | tail');
  assert.strictEqual(d.pipedOut, true);
  assert.strictEqual(d.pipefail, false);
});

test('GTEST-03 pipe: bare gsd-test is a dispatch, not piped', () => {
  const d = oneDispatch('gsd-test');
  assert.strictEqual(d.pipedOut, false);
  assert.strictEqual(d.pipeMasked, false);
});

// ───────────────────────── GTEST-03: pipefail ─────────────────────────

const PIPEFAIL_UNMASKED = [
  'set -o pipefail; gsd-test | tail',
  'set -euo pipefail && gsd-test | tail',
  'set -e -o pipefail; gsd-test | tail',
  'bash -c "set -o pipefail; gsd-test | tail"',
  'bash -o pipefail -c "gsd-test | tail"',
  'set -o pipefail; (gsd-test | tail)',
];

for (const cmd of PIPEFAIL_UNMASKED) {
  test(`GTEST-03 pipefail: unmasks — ${cmd}`, () => {
    const d = oneDispatch(cmd);
    assert.strictEqual(d.pipedOut, true);
    assert.strictEqual(d.pipefail, true);
    assert.strictEqual(d.pipeMasked, false);
  });
}

const PIPEFAIL_STILL_MASKED = [
  'gsd-test | tail; set -o pipefail',
  'set -o pipefail; set +o pipefail; gsd-test | tail',
  'echo pipefail; gsd-test | tail',
  'set -o pipefail; bash -c "gsd-test | tail"',
  '(set -o pipefail); gsd-test | tail',
];

for (const cmd of PIPEFAIL_STILL_MASKED) {
  test(`GTEST-03 pipefail: still masked — ${cmd}`, () => {
    const d = oneDispatch(cmd);
    assert.strictEqual(d.pipeMasked, true);
  });
}

// ───────────────────────── Addendum 1: Go-flag walker ─────────────────────────

for (const form of [['-head', 'HEAD'], ['--head', 'HEAD'], ['-head=HEAD'], ['--head=HEAD']]) {
  test(`GTEST-01 walker: ${form.join(' ')} gives head HEAD`, () => {
    const w = walk(form);
    assert.strictEqual(w.flags.head, 'HEAD');
    assert.strictEqual(w.uncertainReason, null);
  });
}

test('GTEST-01 walker: redirects before a flag are skipped (`> log 2>&1 --head x`)', () => {
  const d = oneDispatch('gsd-test > log 2>&1 --head x');
  assert.strictEqual(d.flags.head, 'x');
});

test('GTEST-01 walker: a literal positional stops flag parsing (`--quiet run --head x` is classic)', () => {
  // v1.8.0 dispatches a subcommand only on args[0]; after a flag, `run` is a classic positional.
  const d = oneDispatch('gsd-test --quiet run --head x');
  assert.strictEqual(d.subcommand, null);
  assert.strictEqual(d.flags.head, undefined);
  assert.deepStrictEqual(d.args, ['run', '--head', 'x']);
});

// ─────────────── M-01 (36-REVIEW): v1.8.0 subcommands on args[0] ───────────────

test('GTEST-01 M-01: a classic dispatch carries subcommand null', () => {
  assert.strictEqual(oneDispatch('gsd-test --head HEAD').subcommand, null);
});

test('GTEST-01 M-01: `gsd-test run --config /x/missing.toml` reads the run flagset (flags after the subcommand)', () => {
  const d = oneDispatch('gsd-test run --config /x/missing.toml');
  assert.strictEqual(d.subcommand, 'run');
  assert.strictEqual(d.flags.config, '/x/missing.toml');
  assert.deepStrictEqual(d.args, []);
});

test('GTEST-01 M-01: `gsd-test run --target windows --async tests/a.test.cjs` reads run values, booleans and patterns', () => {
  const d = oneDispatch('gsd-test run --target windows --async tests/a.test.cjs');
  assert.strictEqual(d.flags.target, 'windows');
  assert.strictEqual(d.flags.async, true);
  assert.deepStrictEqual(d.args, ['tests/a.test.cjs']);
});

test('GTEST-01 M-01: a redirect before the subcommand is removed by the shell (`gsd-test >log run`)', () => {
  assert.strictEqual(oneDispatch('gsd-test > log run').subcommand, 'run');
});

test('GTEST-01 M-01: `gsd-test submit --execute --spec-file s.json --config c.toml`', () => {
  const d = oneDispatch('gsd-test submit --execute --spec-file s.json --config c.toml');
  assert.strictEqual(d.subcommand, 'submit');
  assert.strictEqual(d.flags.execute, true);
  assert.strictEqual(d.flags['spec-file'], 's.json');
  assert.strictEqual(d.flags.config, 'c.toml');
});

for (const sub of ['wait', 'status']) {
  test(`GTEST-01 M-01: \`gsd-test ${sub} 20261005-abc\` is a ${sub} entry carrying the run id`, () => {
    const d = oneDispatch(`gsd-test ${sub} 20261005-abc`);
    assert.strictEqual(d.subcommand, sub);
    assert.deepStrictEqual(d.args, ['20261005-abc']);
  });
  test(`GTEST-01 M-01: \`gsd-test ${sub} "$RUN_ID" | tail\` is a dispatch (an expanded run id is not uncertain)`, () => {
    const d = oneDispatch(`gsd-test ${sub} "$RUN_ID" | tail`);
    assert.strictEqual(d.subcommand, sub);
    assert.strictEqual(d.pipeMasked, true);
  });
}

test('GTEST-01 M-01: `gsd-test install-agent-hooks --claude --global` is an install-agent-hooks entry', () => {
  const d = oneDispatch('gsd-test install-agent-hooks --claude --global');
  assert.strictEqual(d.subcommand, 'install-agent-hooks');
});

test('GTEST-01 M-01: `gsd-test run $EXTRA` is uncertain (an expansion may carry run flags)', () => {
  oneUncertain('gsd-test run $EXTRA');
});

test('GTEST-01 M-01: `gsd-test run -h` is informational (ErrHelp, no run)', () => {
  assert.strictEqual(oneDispatch('gsd-test run -h').informational, true);
});

test('GTEST-01 M-01: `gsd-test run --head x` reads --head as an unknown run flag, never as the classic --head', () => {
  const d = oneDispatch('gsd-test run --head x');
  assert.strictEqual(d.subcommand, 'run');
  assert.notStrictEqual(d.flags.head, 'x');
});

test('GTEST-01 walker: `--` ends flag parsing (`-- --head x`)', () => {
  const d = oneDispatch('gsd-test -- --head x');
  assert.strictEqual(d.flags.head, undefined);
  assert.deepStrictEqual(d.args, ['--head', 'x']);
});

test('GTEST-01 walker: a lone `-` is a positional', () => {
  const w = walk(['-', '--head', 'x']);
  assert.strictEqual(w.flags.head, undefined);
  assert.deepStrictEqual(w.positionals, ['-', '--head', 'x']);
});

test('GTEST-01 walker: -version=false is not informational', () => {
  const d = oneDispatch('gsd-test -version=false');
  assert.strictEqual(d.flags.version, false);
  assert.strictEqual(d.informational, false);
});

test('GTEST-01 walker: -h is informational', () => {
  assert.strictEqual(oneDispatch('gsd-test -h').informational, true);
});

test('GTEST-01 walker: -head HEAD is not informational', () => {
  const d = oneDispatch('gsd-test -head HEAD');
  assert.strictEqual(d.informational, false);
  assert.strictEqual(d.flags.head, 'HEAD');
});

for (const flag of ['--version', '-version', '--help', '-help']) {
  test(`GTEST-01 walker: ${flag} is informational`, () => {
    assert.strictEqual(oneDispatch(`gsd-test ${flag}`).informational, true);
  });
}

// B-01 (36-REVIEW): v1.8.0 `--probe-benches` probes reachability DURING config.Load and then runs
// the full suite (cmd/gsd-test/main.go: only --version returns before runner.Run). It is a run.
for (const flag of ['--probe-benches', '-probe-benches', '--probe-benches=true']) {
  test(`GTEST-01 walker (B-01): ${flag} is NOT informational — it runs the suite`, () => {
    const d = oneDispatch(`gsd-test ${flag} --head HEAD`);
    assert.strictEqual(d.informational, false);
    assert.strictEqual(d.flags.head, 'HEAD');
  });
}

test('GTEST-01 walker (B-01): INFORMATIONAL_FLAGS no longer carries probe-benches', () => {
  assert.strictEqual(det.INFORMATIONAL_FLAGS.has('probe-benches'), false);
});

test('GTEST-01 walker: -bench "$B" records bench as unresolved', () => {
  const d = oneDispatch('gsd-test -bench "$B"');
  assert.ok(d.unresolved.has('bench'));
  assert.strictEqual(d.flags.bench, '$B');
});

test('GTEST-01 walker: every value flag is read in all four forms', () => {
  for (const f of ['base', 'bench', 'config', 'exclude', 'head', 'node', 'scratch', 'source', 'targets']) {
    for (const toks of [[`-${f}`, 'v'], [`--${f}`, 'v'], [`-${f}=v`], [`--${f}=v`]]) {
      const w = walk(toks);
      assert.strictEqual(w.flags[f], 'v', `${toks.join(' ')}`);
    }
  }
});

test('GTEST-01 walker: a boolean does not consume the next token (`-quiet -head x`)', () => {
  const w = walk(['-quiet', '-head', 'x']);
  assert.strictEqual(w.flags.quiet, true);
  assert.strictEqual(w.flags.head, 'x');
});

test('GTEST-01 walker: a value flag takes the next token unconditionally (`-head -bench`)', () => {
  const w = walk(['-head', '-bench']);
  assert.strictEqual(w.flags.head, '-bench');
  assert.strictEqual(w.flags.bench, undefined);
});

test('GTEST-01 walker: a value flag with no value is uncertain (Go exits 2; fail closed)', () => {
  const w = walk(['--bench']);
  assert.strictEqual(typeof w.uncertainReason, 'string');
});

test('GTEST-01 walker: never throws on odd input', () => {
  // Called directly (a throw fails the row); assert.doesNotThrow makes node's TAP reporter emit
  // a malformed YAML diag block, which the RED-evidence classifier rejects.
  const a = walk([]);
  assert.deepStrictEqual(a.positionals, []);
  const b = walk(['---x', '=', '-=', '--=v']);
  assert.ok(b && typeof b === 'object');
});

// ─────────────── checker item 2: flags after a command substitution ───────────────

test('GTEST-01 walker-substitution: --base next --head $(git rev-parse HEAD) --bench wsl-local', () => {
  const d = oneDispatch('gsd-test --base next --head $(git rev-parse HEAD) --bench wsl-local');
  assert.strictEqual(d.flags.base, 'next');
  assert.strictEqual(d.flags.head, '$(git rev-parse HEAD)');
  assert.ok(d.unresolved.has('head'));
  assert.strictEqual(d.flags.bench, 'wsl-local');
  assert.ok(!d.unresolved.has('bench'));
});

test('GTEST-01 walker-substitution: quoted --head "$(git rev-parse HEAD)" --bench wsl-local', () => {
  const d = oneDispatch('gsd-test --head "$(git rev-parse HEAD)" --bench wsl-local');
  assert.ok(d.unresolved.has('head'));
  assert.strictEqual(d.flags.bench, 'wsl-local');
});

test('GTEST-01 walker-substitution: attached -head=$(git rev-parse HEAD) -bench wsl-local', () => {
  const d = oneDispatch('gsd-test -head=$(git rev-parse HEAD) -bench wsl-local');
  assert.ok(d.unresolved.has('head'));
  assert.strictEqual(d.flags.bench, 'wsl-local');
});

test('GTEST-01 walker-substitution: -source and -config after a substitution', () => {
  const d = oneDispatch('gsd-test --head $(git rev-parse HEAD) -source ../x -config c.toml');
  assert.strictEqual(d.flags.source, '../x');
  assert.strictEqual(d.flags.config, 'c.toml');
});

test('GTEST-01 walker-substitution: nested substitution $(git rev-parse $(echo HEAD))', () => {
  const d = oneDispatch('gsd-test --head $(git rev-parse $(echo HEAD)) --bench b');
  assert.strictEqual(d.flags.bench, 'b');
  assert.ok(d.unresolved.has('head'));
});

test('GTEST-01 walker-substitution: backtick substitution', () => {
  const d = oneDispatch('gsd-test --head `git rev-parse HEAD` --bench b');
  assert.strictEqual(d.flags.bench, 'b');
  assert.ok(d.unresolved.has('head'));
});

test('GTEST-01 walker-substitution: inside a piped subshell group', () => {
  const d = oneDispatch('(gsd-test --head $(git rev-parse HEAD) --bench b) | tail');
  assert.strictEqual(d.flags.bench, 'b');
  assert.strictEqual(d.pipeMasked, true);
});

test('GTEST-01 walker-substitution: piped, ungrouped', () => {
  const d = oneDispatch('gsd-test --head $(git rev-parse HEAD) --bench b | tail');
  assert.strictEqual(d.flags.bench, 'b');
  assert.strictEqual(d.pipeMasked, true);
});

// ─────────────── checker item 2: unattributable argument lists ───────────────

const WALKER_UNCERTAIN = [
  'gsd-test --head $(cd x; git rev-parse HEAD) --bench b',
  'gsd-test --head $(git rev-parse HEAD',
  'gsd-test $EXTRA --head x',
  'gsd-test --head x "$@"',
  'gsd-test -$F x',
];

for (const cmd of WALKER_UNCERTAIN) {
  test(`GTEST-01 walker-uncertain: ${cmd}`, () => {
    const e = entries(cmd);
    assert.ok(e.length >= 1, 'must not be silently skipped');
    assert.strictEqual(e[0].kind, 'uncertain');
    assert.ok(!e.some((x) => x.kind === 'dispatch'), 'an unattributable dispatch is never a dispatch entry');
  });
}

// ─────────────── HARD-01: uncertain entries via the word regex ───────────────

const UNCERTAIN_INPUTS = [
  'gsd-test --bench "x',
  '/home/dave/.local/bin/gsd-test --bench "x',
  "env -S 'gsd-test --head HEAD'",
  `bash -c "bash -c 'bash -c gsd-test'"`,
  `bash -c 'gsd-test --head "x'`,
];

for (const cmd of UNCERTAIN_INPUTS) {
  test(`GTEST-01 uncertain: ${cmd}`, () => {
    oneUncertain(cmd);
  });
}

for (const cmd of ['gsd-test-other --bench "x', 'cat gsd-test-clean-tree.cjs "x', 'echo "x']) {
  test(`GTEST-01 uncertain: no entry for an unparseable command that does not name gsd-test — ${cmd}`, () => {
    assert.deepStrictEqual(entries(cmd), []);
  });
}

test('GTEST-01: GSD_TEST_WORD is the exported word test', () => {
  assert.ok(det.GSD_TEST_WORD instanceof RegExp, 'GSD_TEST_WORD must be exported');
  assert.strictEqual(det.GSD_TEST_WORD.test('a gsd-test b'), true);
  assert.strictEqual(det.GSD_TEST_WORD.test('/bin/gsd-test'), true);
  assert.strictEqual(det.GSD_TEST_WORD.test('gsd-test-other'), false);
  assert.strictEqual(det.GSD_TEST_WORD.test('my-gsd-test'), false);
  assert.strictEqual(det.MAX_DASH_C_DEPTH, 2);
  assert.ok(det.INFORMATIONAL_FLAGS instanceof Set || Array.isArray(det.INFORMATIONAL_FLAGS));
});

// ───────────────────────── edge: empty input ─────────────────────────

for (const [label, v] of [['empty string', ''], ['whitespace', '   '], ['null', null], ['undefined', undefined]]) {
  test(`GTEST-03 edge: ${label} yields no entries`, () => {
    assert.deepStrictEqual(entries(v), []);
  });
}

// ───────────────────────── findGsdTestDispatch (singular) ─────────────────────────

test('GTEST-01: findGsdTestDispatch returns the first dispatch entry, never an uncertain one', () => {
  const one = exported('findGsdTestDispatch');
  assert.strictEqual(one('gsd-test --bench "x'), null);
  assert.strictEqual(one('gsd-test $EXTRA'), null);
  const d = one('gsd-test $EXTRA; gsd-test -head HEAD');
  assert.ok(d);
  assert.strictEqual(d.kind, 'dispatch');
  assert.strictEqual(d.flags.head, 'HEAD');
});

test('GTEST-01: findGsdTestDispatch returns null for a non-dispatch', () => {
  assert.strictEqual(exported('findGsdTestDispatch')('echo gsd-test'), null);
});

// ───────────────────────── path helpers ─────────────────────────

test('GTEST-01 helper: expandStatic expands ~/', () => {
  assert.strictEqual(exported('expandStatic')('~/x', { env: {}, homedir: '/h' }), '/h/x');
});

test('GTEST-01 helper: expandStatic expands $HOME from env', () => {
  assert.strictEqual(exported('expandStatic')('$HOME/x', { env: { HOME: '/e' }, homedir: '/h' }), '/e/x');
});

test('GTEST-01 helper: expandStatic expands ${XDG_CONFIG_HOME}', () => {
  assert.strictEqual(
    exported('expandStatic')('${XDG_CONFIG_HOME}/g', { env: { XDG_CONFIG_HOME: '/c' }, homedir: '/h' }),
    '/c/g'
  );
});

test('GTEST-01 helper: expandStatic returns null for an unknown variable', () => {
  assert.strictEqual(exported('expandStatic')('$FOO/x', { env: {}, homedir: '/h' }), null);
});

test('GTEST-01 helper: expandStatic returns null for an unset XDG_CONFIG_HOME and for ~user', () => {
  const ex = exported('expandStatic');
  assert.strictEqual(ex('$XDG_CONFIG_HOME/g', { env: {}, homedir: '/h' }), null);
  assert.strictEqual(ex('~bob/x', { env: {}, homedir: '/h' }), null);
  assert.strictEqual(ex('plain/rel', { env: {}, homedir: '/h' }), 'plain/rel');
});

const START_DIRS = [
  ['cd sub && gsd-test', '/r/sub'],
  ['gsd-test; cd /tmp', '/r'],
  ['git -C /o status; gsd-test', '/r'],
  ['(cd x && gsd-test)', '/r/x'],
  ['(cd x); gsd-test', '/r'],
  ['{ cd x; }; gsd-test', '/r/x'],
  ['cd a && bash -c "cd b && gsd-test"', '/r/a/b'],
];

for (const [cmd, want] of START_DIRS) {
  test(`GTEST-01 helper: startDirFor(${cmd}) from /r is ${want}`, () => {
    const d = oneDispatch(cmd);
    assert.strictEqual(exported('startDirFor')(d, '/r'), want);
  });
}

test('GTEST-01 helper: treeDirFor resolves -source against the start dir', () => {
  const d = oneDispatch('gsd-test -source ../other');
  assert.strictEqual(exported('treeDirFor')(d, '/r/sub', { env: {}, homedir: '/h' }), '/r/other');
});

test('GTEST-01 helper: treeDirFor with -source $X is null', () => {
  const d = oneDispatch('gsd-test -source $X');
  assert.strictEqual(exported('treeDirFor')(d, '/r/sub', { env: {}, homedir: '/h' }), null);
});

test('GTEST-01 helper: treeDirFor without -source is the start dir', () => {
  const d = oneDispatch('cd sub && gsd-test');
  assert.strictEqual(exported('treeDirFor')(d, '/r', { env: {}, homedir: '/h' }), '/r/sub');
});

// ─────────────── cross-check: classify's NEW_ACTION_COMMANDS are not dispatches ───────────────

// Re-declared from hooks/lib/classify.test.cjs (invariant (b)): none of the review-side gh
// commands may yield a detector entry.
const NEW_ACTION_COMMANDS = [
  'gh pr review 42 --approve',
  'gh pr merge 42 --squash',
  'gh issue close 42',
  'gh issue comment 42 --body x',
  'gh pr comment 42 --body x',
  'gh api -X POST repos/o/r/pulls/42/reviews -f event=APPROVE',
  'gh api -X PUT repos/o/r/pulls/42/merge',
  'gh api -X POST repos/o/r/issues/42/comments -f body=x',
  'gh api -X PATCH repos/o/r/issues/42 -f state=closed',
];

test('GTEST-01: no classify NEW_ACTION_COMMANDS entry yields a detector entry', () => {
  for (const cmd of NEW_ACTION_COMMANDS) {
    assert.deepStrictEqual(entries(cmd), [], cmd);
  }
});

// ─────────────── 36-03 handoff fixes: quoted parentheses and unresolvable cd targets ───────────────
//
// argv removes quotes, so a `(` / `)` inside quoted text used to count as a group character.
// Only UNQUOTED (and unescaped) parentheses/braces may affect grouping, as argv tokenizes them.
// A double-quoted `$(...)` whose naive close leaves the substitution open (nested quotes) cannot
// be attributed exactly and is graded uncertain when the command names gsd-test.

test('GTEST-03 quoted-paren: `gsd-test --bench "a(b" | tail` is pipe-masked (a quoted paren must not hide the pipe)', () => {
  const d = oneDispatch('gsd-test --bench "a(b" | tail');
  assert.strictEqual(d.flags.bench, 'a(b');
  assert.strictEqual(d.pipedOut, true);
  assert.strictEqual(d.pipeMasked, true);
});

test("GTEST-03 quoted-paren: `gsd-test --bench 'a(b' | tail` is pipe-masked (single quotes)", () => {
  assert.strictEqual(oneDispatch("gsd-test --bench 'a(b' | tail").pipeMasked, true);
});

test('GTEST-03 quoted-paren: `gsd-test --bench \\( | tail` is pipe-masked (an escaped paren is literal)', () => {
  assert.strictEqual(oneDispatch('gsd-test --bench \\( | tail').pipeMasked, true);
});

test('GTEST-03 quoted-paren: `gsd-test --head "x)"` keeps the quoted `)` in the head value', () => {
  assert.strictEqual(oneDispatch('gsd-test --head "x)"').flags.head, 'x)');
});

test('GTEST-03 quoted-paren: `(gsd-test --bench "a)") | tail` — the real group still closes and the pipe still masks', () => {
  const d = oneDispatch('(gsd-test --bench "a)") | tail');
  assert.strictEqual(d.flags.bench, 'a)');
  assert.strictEqual(d.pipeMasked, true);
});

test('GTEST-01 quoted-paren: startDirFor(echo "("; cd x; echo ")"; gsd-test) from /r is /r/x', () => {
  const d = oneDispatch('echo "("; cd x; echo ")"; gsd-test');
  assert.strictEqual(exported('startDirFor')(d, '/r'), '/r/x');
});

test("GTEST-01 quoted-paren: startDirFor(echo '{'; cd x; echo ')'; gsd-test) from /r is /r/x", () => {
  const d = oneDispatch("echo '{'; cd x; echo ')'; gsd-test");
  assert.strictEqual(exported('startDirFor')(d, '/r'), '/r/x');
});

test('GTEST-03 quoted-paren: a balanced double-quoted $(...) head stays exact: masked, bench read, head unresolved', () => {
  const d = oneDispatch('gsd-test --head "$(git rev-parse HEAD)" --bench b | tail');
  assert.strictEqual(d.flags.bench, 'b');
  assert.ok(d.unresolved.has('head'));
  assert.strictEqual(d.pipeMasked, true);
});

test('GTEST-01 quoted-paren: nested quotes inside a double-quoted $(...) next to a paren are uncertain', () => {
  oneUncertain('gsd-test --bench "$(echo "(")" | tail');
});

test('GTEST-01 quoted-paren: a heredoc commit message mentioning gsd-test with an unbalanced paren yields no entry', () => {
  const cmd = 'git commit -m "$(cat <<\'EOF\'\nfix gsd-test (x\nEOF\n)"';
  assert.deepStrictEqual(entries(cmd), []);
});

test('GTEST-01 quoted-paren: nested quotes in a command that never names gsd-test yield no entry', () => {
  assert.deepStrictEqual(entries('echo "$(echo "(")"; ls'), []);
});

const UNRESOLVED_CD = [
  ['cd "$X" && gsd-test', null],
  ['cd `pwd`/x && gsd-test', null],
  ['cd ~bob && gsd-test', null],
  ['cd a && bash -c "cd \\$Y && gsd-test"', null],
  ['(cd "$X"); gsd-test', '/r'],
  ['gsd-test; cd "$X"', '/r'],
];
for (const [cmd, want] of UNRESOLVED_CD) {
  test(`GTEST-01 cd-expansion: startDirFor(${cmd}) from /r is ${want}`, () => {
    const d = oneDispatch(cmd);
    assert.strictEqual(exported('startDirFor')(d, '/r', { env: {}, homedir: '/h' }), want);
  });
}

test('GTEST-01 cd-expansion: `cd $HOME/r && gsd-test` expands statically from the injected env', () => {
  const d = oneDispatch('cd $HOME/r && gsd-test');
  assert.strictEqual(exported('startDirFor')(d, '/w', { env: { HOME: '/h' }, homedir: '/h' }), '/h/r');
});

test('GTEST-01 cd-expansion: `cd "${HOME}/r" && gsd-test -source sub` resolves the tree at /h/r/sub', () => {
  const d = oneDispatch('cd "${HOME}/r" && gsd-test -source sub');
  assert.strictEqual(exported('treeDirFor')(d, '/w', { env: { HOME: '/h' }, homedir: '/h' }), '/h/r/sub');
});

test('GTEST-01 cd-expansion: treeDirFor(cd "$X" && gsd-test) is null (unresolved start dir)', () => {
  const d = oneDispatch('cd "$X" && gsd-test');
  assert.strictEqual(exported('treeDirFor')(d, '/r', { env: {}, homedir: '/h' }), null);
});

// Regression locks added after GREEN (same fix family; they passed on the first run after it).
test('GTEST-03 quoted-paren: `gsd-test --bench "{" | tail` is pipe-masked (a quoted lone brace is not a group)', () => {
  assert.strictEqual(oneDispatch('gsd-test --bench "{" | tail').pipeMasked, true);
});

test('GTEST-01 cd-expansion: `cd - && gsd-test` is an unresolved start dir ($OLDPWD)', () => {
  const d = oneDispatch('cd - && gsd-test');
  assert.strictEqual(exported('startDirFor')(d, '/r', { env: {}, homedir: '/h' }), null);
});

test('GTEST-01 cd-expansion: `cd ~/r && gsd-test` uses the injected homedir', () => {
  const d = oneDispatch('cd ~/r && gsd-test');
  assert.strictEqual(exported('startDirFor')(d, '/w', { env: {}, homedir: '/h' }), '/h/r');
});

test('GTEST-01 cd-expansion: `{ cd "$X"; }; gsd-test` is unresolved (a brace group cd persists)', () => {
  const d = oneDispatch('{ cd "$X"; }; gsd-test');
  assert.strictEqual(exported('startDirFor')(d, '/r', { env: {}, homedir: '/h' }), null);
});

// ─────────────── M-02 (36-REVIEW): `cd` options are skipped before the target ───────────────

const CD_OPTION_ROWS = [
  ['cd -P /g/core && gsd-test', '/g/core'],
  ['cd -L /g/core && gsd-test', '/g/core'],
  ['cd -- /g/core && gsd-test', '/g/core'],
  ['cd -P -- /g/core && gsd-test', '/g/core'],
  ['cd -Pe /g/core && gsd-test', '/g/core'],
  ['cd -P -e /g/core && gsd-test', '/g/core'],
  ['cd -@ /g/core && gsd-test', '/g/core'],
  ['cd -P sub && gsd-test', '/elsewhere/sub'],
  ['cd -x /g/core && gsd-test', null],
  ['cd -- - && gsd-test', null],
];
for (const [cmd, want] of CD_OPTION_ROWS) {
  test(`GTEST-01 M-02: startDirFor(${cmd}) from /elsewhere is ${want}`, () => {
    const d = oneDispatch(cmd);
    assert.strictEqual(exported('startDirFor')(d, '/elsewhere', { env: {}, homedir: '/h' }), want);
  });
}

// N-05 (36-REVIEW): a bare `cd` goes to $HOME.
test('GTEST-01 N-05: `cd && gsd-test` starts in the injected homedir', () => {
  const d = oneDispatch('cd && gsd-test');
  assert.strictEqual(exported('startDirFor')(d, '/elsewhere', { env: {}, homedir: '/h' }), '/h');
});

test('GTEST-01 N-05: `cd; gsd-test` prefers the env HOME over the homedir', () => {
  const d = oneDispatch('cd; gsd-test');
  assert.strictEqual(exported('startDirFor')(d, '/elsewhere', { env: { HOME: '/e' }, homedir: '/h' }), '/e');
});

test('GTEST-01 N-05: `cd -P; gsd-test` with no known home is unresolved (null)', () => {
  const d = oneDispatch('cd -P; gsd-test');
  assert.strictEqual(exported('startDirFor')(d, '/elsewhere', { env: {} }), null);
});

// ─────────────── M-03 (36-REVIEW): `env -C` / `env --chdir` and `sudo -D` / `sudo --chdir` ───────────────

const CHDIR_ROWS = [
  ['env -C /g/core gsd-test | tail', '/g/core'],
  ['env --chdir=/g/core gsd-test | tail', '/g/core'],
  ['env --chdir /g/core gsd-test | tail', '/g/core'],
  ['env -C/g/core gsd-test', '/g/core'],
  ['env -iC /g/core gsd-test', '/g/core'],
  ['env -C sub FOO=1 gsd-test', '/elsewhere/sub'],
  ['cd /a && env -C b gsd-test', '/a/b'],
  ['sudo -D /g/core gsd-test | tail', '/g/core'],
  ['sudo --chdir=/g/core gsd-test', '/g/core'],
  ['sudo --chdir /g/core gsd-test', '/g/core'],
  ['sudo -u dave -D /g/core gsd-test', '/g/core'],
  ['nice -n 5 sudo -D /g/core gsd-test', '/g/core'],
  ['env -C /a sudo -D b gsd-test', '/a/b'],
  ['sudo -D /g/core bash -c "gsd-test | tail"', '/g/core'],
  ['env -C "$X" gsd-test', null],
  ['env -C ~bob gsd-test', null],
];
for (const [cmd, want] of CHDIR_ROWS) {
  test(`GTEST-01 M-03: startDirFor(${cmd}) from /elsewhere is ${want}`, () => {
    const d = oneDispatch(cmd);
    assert.strictEqual(exported('startDirFor')(d, '/elsewhere', { env: {}, homedir: '/h' }), want);
  });
}

test('GTEST-01 M-03: `sudo -D /g/core gsd-test --head HEAD | tail` is a piped dispatch with its flags read', () => {
  const d = oneDispatch('sudo -D /g/core gsd-test --head HEAD | tail');
  assert.strictEqual(d.flags.head, 'HEAD');
  assert.strictEqual(d.pipeMasked, true);
});

test('GTEST-01 M-03: the reverse case — `env -C /tmp gsd-test` from /g/core starts in /tmp', () => {
  const d = oneDispatch('env -C /tmp gsd-test');
  assert.strictEqual(exported('startDirFor')(d, '/g/core', { env: {}, homedir: '/h' }), '/tmp');
});

test('GTEST-01 M-03: `echo env -C /x gsd-test` is not a dispatch (env is not in wrapper position)', () => {
  assert.deepStrictEqual(entries('echo env -C /x gsd-test'), []);
});
