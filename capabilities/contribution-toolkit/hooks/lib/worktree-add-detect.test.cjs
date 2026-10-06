'use strict';

/**
 * node:test for hooks/lib/worktree-add-detect.cjs — the pure `git [globals] worktree add`
 * detector behind ENF-25 (hooks/worktree-fresh-base.cjs).
 *
 * 37-01 rows (`WTREE-01 detect:`) lock the FINAL entry shape and the base table. 37-02 rows run the
 * detector on the SHARED segment walk of hooks/lib/gsd-test-detect.cjs (groups, quote mask,
 * wrapper / nohup / time peel, `bash -c` and `eval` recursion, `cd` / `env -C` / `sudo -D` start
 * dirs) and add the full `worktree add` option walk and the uncertain grading:
 *
 *   WTREE-01 variant:   every command shape that cuts a worktree, with its start dir and -C values
 *   WTREE-01 option:    parseWorktreeAddArgs over the `add` tail
 *   WTREE-01 encoding:  exact, case-sensitive base matching on the argv-unquoted token
 *   WTREE-01 non-cut:   mentions that are not a cut -> no entry
 *   WTREE-01 uncertain: unattributable cuts -> {kind:'uncertain'}; each has a twin without the words
 *   WTREE-01 parity:    the generic walk with no matcher IS the gsd-test detector
 *
 * Every call goes through an export guard, so a missing export fails as an assertion.
 * Pure: no fs, no child_process.
 */

const test = require('node:test');
const assert = require('node:assert');

const det = require('./worktree-add-detect.cjs');
const gtd = require('./gsd-test-detect.cjs');

function exported(mod, name, label) {
  assert.strictEqual(typeof mod[name], 'function', `${label} must export ${name}()`);
  return mod[name];
}

function findWorktreeAdds(cmd) {
  const r = exported(det, 'findWorktreeAdds', 'worktree-add-detect')(cmd);
  assert.ok(Array.isArray(r), 'findWorktreeAdds must return an array');
  return r;
}

function classifyBase(base) {
  return exported(det, 'classifyBase', 'worktree-add-detect')(base);
}

function parseWorktreeAddArgs(tail) {
  return exported(det, 'parseWorktreeAddArgs', 'worktree-add-detect')(tail);
}

function startDir(entry, cwd) {
  return exported(gtd, 'startDirFor', 'gsd-test-detect')(entry, cwd, { env: {}, homedir: '/h' });
}

const ENTRY_KEYS = [
  'base', 'baseKind', 'depth', 'gitChdirs', 'kind', 'newBranch', 'path', 'prefixes', 'seg', 'segIndex', 'viaDashC',
];

function only(command) {
  const e = findWorktreeAdds(command);
  assert.strictEqual(e.length, 1, 'exactly one entry for ' + JSON.stringify(command) + ', got ' + JSON.stringify(e.map((x) => x.kind)));
  return e[0];
}

function oneCut(command) {
  const e = only(command);
  assert.strictEqual(e.kind, 'cut', 'expected a cut for ' + JSON.stringify(command) + ', got ' + JSON.stringify(e));
  return e;
}

function oneUncertain(command) {
  const e = only(command);
  assert.strictEqual(e.kind, 'uncertain', 'expected uncertain for ' + JSON.stringify(command) + ', got ' + e.kind);
  assert.strictEqual(typeof e.reason, 'string');
  assert.ok(e.reason.length > 0);
  return e;
}

// ───────────────────────── 37-01 shape and base locks ─────────────────────────

test('WTREE-01 detect: `git worktree add p next` is a cut of local next with no -C', () => {
  const e = oneCut('git worktree add p next');
  assert.strictEqual(e.path, 'p');
  assert.strictEqual(e.base, 'next');
  assert.strictEqual(e.baseKind, 'local');
  assert.deepStrictEqual(e.gitChdirs, []);
  assert.strictEqual(e.newBranch, null);
});

test('WTREE-01 detect: the entry carries the FINAL shape (later plans never reshape it)', () => {
  const e = oneCut('git worktree add p next');
  assert.deepStrictEqual(Object.keys(e).sort(), ENTRY_KEYS);
  assert.strictEqual(e.segIndex, 0);
  assert.strictEqual(e.viaDashC, false);
  assert.strictEqual(e.depth, 0);
  assert.ok(Array.isArray(e.seg.tokens), 'seg is a parsed segment');
  assert.ok(Array.isArray(e.prefixes) && e.prefixes.length === 1, 'one parse-shaped prefix');
  assert.strictEqual(e.prefixes[0].ok, true);
  assert.deepStrictEqual(e.prefixes[0].segments, []);
});

test('WTREE-01 detect: `git worktree add -b feat p origin/next` -> remote base, newBranch feat', () => {
  const e = oneCut('git worktree add -b feat p origin/next');
  assert.strictEqual(e.baseKind, 'remote');
  assert.strictEqual(e.base, 'origin/next');
  assert.strictEqual(e.newBranch, 'feat');
  assert.strictEqual(e.path, 'p');
});

test('WTREE-01 detect: `git worktree add p` (no base) -> base null, baseKind head', () => {
  const e = oneCut('git worktree add p');
  assert.strictEqual(e.base, null);
  assert.strictEqual(e.baseKind, 'head');
  assert.strictEqual(e.path, 'p');
});

test('WTREE-01 detect: `git worktree add p feature` -> baseKind other', () => {
  const e = oneCut('git worktree add p feature');
  assert.strictEqual(e.base, 'feature');
  assert.strictEqual(e.baseKind, 'other');
});

test('WTREE-01 detect: `git -C /a worktree add p next` collects the global -C value', () => {
  const e = oneCut('git -C /a worktree add p next');
  assert.deepStrictEqual(e.gitChdirs, ['/a']);
  assert.strictEqual(e.baseKind, 'local');
});

test('WTREE-01 detect: `-B` and `--reason` consume their value tokens', () => {
  const e = oneCut('git worktree add --reason why -B topic p next');
  assert.strictEqual(e.newBranch, 'topic');
  assert.strictEqual(e.path, 'p');
  assert.strictEqual(e.base, 'next');
});

test('WTREE-01 detect: an earlier `cd` segment is carried as a prefix for the start-dir helper', () => {
  const e = oneCut('cd /x && git worktree add p next');
  assert.strictEqual(e.segIndex, 1);
  assert.strictEqual(e.prefixes[0].segments.length, 1);
  assert.strictEqual(e.prefixes[0].segments[0].program, 'cd');
});

for (const cmd of ['git status', 'echo git worktree add p next', '']) {
  test('WTREE-01 detect: ' + JSON.stringify(cmd) + ' -> no entry', () => {
    assert.deepStrictEqual(findWorktreeAdds(cmd), []);
  });
}

const BASE_TABLE = [
  ['next', 'local'],
  ['refs/heads/next', 'local'],
  ['heads/next', 'local'],
  ['origin/next', 'remote'],
  ['refs/remotes/origin/next', 'remote'],
  ['remotes/origin/next', 'remote'],
  ['HEAD', 'head'],
  ['@', 'head'],
  [null, 'head'],
  ['NEXT', 'other'],
  ['Next', 'other'],
  ['next~1', 'other'],
  ['upstream/next', 'other'],
  ['0123456789abcdef0123456789abcdef01234567', 'other'],
];

for (const [base, kind] of BASE_TABLE) {
  test('WTREE-01 detect: classifyBase(' + JSON.stringify(base) + ') === ' + JSON.stringify(kind), () => {
    assert.strictEqual(classifyBase(base), kind);
  });
}

test('WTREE-01 detect: WORKTREE_ADD_WORD matches `worktree add` as whole words only', () => {
  assert.ok(det.WORKTREE_ADD_WORD instanceof RegExp, 'WORKTREE_ADD_WORD must be exported');
  assert.ok(det.WORKTREE_ADD_WORD.test('git worktree   add p'));
  assert.ok(!det.WORKTREE_ADD_WORD.test('git worktreeadd p'));
  assert.ok(!det.WORKTREE_ADD_WORD.test('git worktree adder p'));
});

// ───────────────────────── 37-02 variants on the shared walk ─────────────────────────
//
// [command, start dir from cwd '/w', gitChdirs, extra assertions]. Every row is a cut of local
// `next` at path `p`.

const VARIANTS = [
  ['cd /r && git worktree add p next', '/r', []],
  ['(cd /r && git worktree add p next)', '/r', []],
  ['{ cd /r; git worktree add p next; }', '/r', []],
  ['git -C /r worktree add p next', '/w', ['/r']],
  ['cd /w && git -C r worktree add p next', '/w', ['r']],
  ['FOO=1 git -C /r worktree add p next', '/w', ['/r']],
  ['sudo git -C /r worktree add p next', '/w', ['/r']],
  ['env X=1 git worktree add p next', '/w', []],
  ['timeout 5 git worktree add p next', '/w', []],
  ['nohup git worktree add p next', '/w', []],
  ['bash -c "git worktree add p next"', '/w', [], (e) => {
    assert.strictEqual(e.viaDashC, true);
    assert.strictEqual(e.depth, 1);
  }],
  ["bash -lc 'cd /r && git worktree add p next'", '/r', [], (e) => assert.strictEqual(e.viaDashC, true)],
  ['git fetch && git worktree add p next', '/w', [], (e) => assert.strictEqual(e.segIndex, 1)],
  // Start-dir forms the shared walk supports at execution time (36-REVIEW M-03 / M-04).
  ['env -C /r git worktree add p next', '/r', []],
  ['sudo -D /r git worktree add p next', '/r', []],
  ['eval "git worktree add p next"', '/w', [], (e) => assert.strictEqual(e.depth, 1)],
  // Shell structure the walk already handles.
  ['git -C /r -c core.x=1 worktree add p next', '/w', ['/r']],
  ['git -C /a -C b worktree add p next', '/w', ['/a', 'b']],
  ['git worktree add p next 2>/dev/null', '/w', []],
  ['git worktree add -b x p next > log 2>&1 &', '/w', [], (e) => assert.strictEqual(e.newBranch, 'x')],
  ['if true; then git worktree add p next; fi', '/w', []],
  ['echo "(" && cd /r && git worktree add p next', '/r', []],
  // Found during 37-02 implementation: a redirect may sit before the verb.
  ['git 2>/dev/null worktree add p next', '/w', []],
];

for (const [cmd, wantStart, wantChdirs, extra] of VARIANTS) {
  test(`WTREE-01 variant: ${cmd}`, () => {
    const e = oneCut(cmd);
    assert.strictEqual(e.path, 'p');
    assert.strictEqual(e.base, 'next');
    assert.strictEqual(e.baseKind, 'local');
    assert.deepStrictEqual(e.gitChdirs, wantChdirs);
    assert.strictEqual(startDir(e, '/w'), wantStart);
    if (extra) extra(e);
  });
}

test('WTREE-01 variant: a subshell cd is discarded — `(cd /r && git worktree add p next); git worktree add q next`', () => {
  const e = findWorktreeAdds('(cd /r && git worktree add p next); git worktree add q next');
  assert.strictEqual(e.length, 2);
  assert.ok(e.every((x) => x.kind === 'cut'));
  assert.strictEqual(e[0].path, 'p');
  assert.strictEqual(startDir(e[0], '/w'), '/r');
  assert.strictEqual(e[1].path, 'q');
  assert.strictEqual(startDir(e[1], '/w'), '/w');
});

test('WTREE-01 variant: a brace-group cd persists — `{ cd /r; }; git worktree add q next`', () => {
  const e = oneCut('{ cd /r; }; git worktree add q next');
  assert.strictEqual(startDir(e, '/w'), '/r');
});

test('WTREE-01 variant: an unresolvable cd target gives a null start dir — `cd "$X" && git worktree add p next`', () => {
  const e = oneCut('cd "$X" && git worktree add p next');
  assert.strictEqual(startDir(e, '/w'), null);
});

test('WTREE-01 variant: `git -C "" worktree add p next` keeps the empty -C value (a no-op in git)', () => {
  assert.deepStrictEqual(oneCut('git -C "" worktree add p next').gitChdirs, ['']);
});

test('WTREE-01 variant: `git -C "$Y" worktree add p next` carries the unexpanded -C value for the gate', () => {
  assert.deepStrictEqual(oneCut('git -C "$Y" worktree add p next').gitChdirs, ['$Y']);
});

// ───────────────────────── option walk (parseWorktreeAddArgs) ─────────────────────────
//
// [tail, path, base, newBranch, baseKind]

const OPTIONS = [
  ['-b feat p next', 'p', 'next', 'feat', 'local'],
  ['-bfeat p next', 'p', 'next', 'feat', 'local'],
  ['-fb feat p next', 'p', 'next', 'feat', 'local'],
  ['-fbfeat p next', 'p', 'next', 'feat', 'local'],
  ['-B feat p next', 'p', 'next', 'feat', 'local'],
  ['--reason r --lock p', 'p', null, null, 'head'],
  ['--reason=r p next', 'p', 'next', null, 'local'],
  ['-- -p next', '-p', 'next', null, 'local'],
  ['--orphan -b o p', 'p', null, 'o', 'none'],
  ['--detach p', 'p', null, null, 'head'],
  ['-d p', 'p', null, null, 'head'],
  ['-f --checkout --track --guess-remote -q p origin/next', 'p', 'origin/next', null, 'remote'],
  ['--no-checkout --no-track --no-guess-remote --relative-paths p next', 'p', 'next', null, 'local'],
  ['--reas r p next', 'p', 'next', null, 'local'],
  ['--orph -b o p', 'p', null, 'o', 'none'],
  ['--force -B x p origin/next', 'p', 'origin/next', 'x', 'remote'],
  ['p next 2>&1', 'p', 'next', null, 'local'],
  ['p next > /dev/null', 'p', 'next', null, 'local'],
];

for (const [tail, wantPath, wantBase, wantBranch, wantKind] of OPTIONS) {
  test(`WTREE-01 option: add ${tail}`, () => {
    const r = parseWorktreeAddArgs(tail.split(' '));
    assert.strictEqual(r.uncertainReason, null, 'not uncertain: ' + r.uncertainReason);
    assert.strictEqual(r.path, wantPath);
    assert.strictEqual(r.base, wantBase);
    assert.strictEqual(r.newBranch, wantBranch);
    assert.strictEqual(r.baseKind, wantKind);
  });
}

test('WTREE-01 option: no positional -> path null (git rejects it; nothing to protect)', () => {
  const r = parseWorktreeAddArgs(['-b', 'x']);
  assert.strictEqual(r.path, null);
});

test('WTREE-01 option: a lone & ends the arguments (`p next & q`)', () => {
  const r = parseWorktreeAddArgs(['p', 'next', '&', 'q']);
  assert.strictEqual(r.path, 'p');
  assert.strictEqual(r.base, 'next');
});

// PLANNER ADDITION (CTK-ADR-0009): with the base omitted and no -b/-B/--detach/--orphan, git
// checks out the branch named after basename(path) — the existing `next`.
const PLANNER = [
  ['git worktree add ../next', 'local'],
  ['git worktree add -b x ../next', 'head'],
  ['git worktree add --detach ../next', 'head'],
  ['git worktree add /tmp/wt/next', 'local'],
  ['git worktree add ../nextish', 'head'],
];

for (const [cmd, kind] of PLANNER) {
  test(`WTREE-01 option (planner addition): ${cmd} -> ${kind}`, () => {
    const e = oneCut(cmd);
    assert.strictEqual(e.base, null);
    assert.strictEqual(e.baseKind, kind);
  });
}

// ───────────────────────── encoding ─────────────────────────

test('WTREE-01 encoding: a quoted "next" is the argv-unquoted token -> local', () => {
  assert.strictEqual(oneCut('git worktree add p "next"').baseKind, 'local');
});

for (const base of ['NEXT', 'Next', 'next~1', 'upstream/next', 'nеxt']) {
  test(`WTREE-01 encoding: base ${JSON.stringify(base)} is other (exact, case-sensitive)`, () => {
    const e = oneCut('git worktree add p ' + base);
    assert.strictEqual(e.base, base);
    assert.strictEqual(e.baseKind, 'other');
  });
}

// ───────────────────────── non-cuts ─────────────────────────

const NON_CUTS = [
  '',
  '   ',
  'git worktree add',
  'git worktree add -b x',
  'git worktree list',
  'echo git worktree add p next',
  'git commit -m "git worktree add p next"',
  "cat <<'EOF' > notes.md\ngit worktree add p next\nEOF",
  "grep 'worktree add' f",
  'git log --grep "worktree add p next"',
  'command -v git && git status',
  // Found during 37-02 implementation: the walk's generic lookup exclusion covers git too.
  'command -v git worktree add p next',
];

for (const cmd of NON_CUTS) {
  test(`WTREE-01 non-cut: ${JSON.stringify(cmd)} -> no entry`, () => {
    assert.deepStrictEqual(findWorktreeAdds(cmd), []);
  });
}

for (const v of [null, undefined, 42]) {
  test(`WTREE-01 non-cut: non-string ${String(v)} -> no entry`, () => {
    assert.deepStrictEqual(findWorktreeAdds(v), []);
  });
}

// ───────────────────────── uncertain (HARD-01) and their twins ─────────────────────────
//
// [uncertain command, twin without the words (no entry)]

const UNCERTAIN = [
  ['git worktree add "x', 'git status "x'],
  ['git worktree add p $B', 'git log p $B'],
  ['git worktree add p "$(git rev-parse origin/next)"', 'git log p "$(git rev-parse origin/next)"'],
  ['git worktree add "$WT"', 'git log "$WT"'],
  ['git worktree add p `git rev-parse origin/next`', 'git log p `git rev-parse origin/next`'],
  ['git worktree add $OPTS p next', 'git log $OPTS p next'],
  ['git worktree add -$F p next', 'git log -$F p next'],
  ['git --git-dir=/x worktree add p next', 'git --git-dir=/x status'],
  ['git --git-dir /x worktree add p next', 'git --git-dir /x status'],
  ['git --work-tree /x worktree add p next', 'git --work-tree /x status'],
  ['git --work-tree=/x worktree add p next', 'git --work-tree=/x status'],
  ['GIT_DIR=/x git worktree add p next', 'GIT_DIR=/x git status'],
  ['GIT_WORK_TREE=/x git worktree add p next', 'GIT_WORK_TREE=/x git status'],
  ['env GIT_COMMON_DIR=/x git worktree add p next', 'env GIT_COMMON_DIR=/x git status'],
  [
    `bash -c "bash -c 'bash -c \\"git worktree add p next\\"'"`,
    `bash -c "bash -c 'bash -c \\"git status\\"'"`,
  ],
  ["eval 'git worktree add \"x'", "eval 'git status \"x'"],
  // Found during 37-02 implementation: an expansion before the verb may be options or the verb.
  ['git $G worktree add p next', 'git $G status'],
];

for (const [cmd, twin] of UNCERTAIN) {
  test(`WTREE-01 uncertain: ${cmd}`, () => {
    oneUncertain(cmd);
  });
  test(`WTREE-01 uncertain twin (no words, no entry): ${twin}`, () => {
    assert.deepStrictEqual(findWorktreeAdds(twin), []);
  });
}

test('WTREE-01 uncertain: a path with an expansion is fine when the base is literal (`"$WT" next`)', () => {
  const e = oneCut('git worktree add "$WT" next');
  assert.strictEqual(e.path, '$WT');
  assert.strictEqual(e.baseKind, 'local');
});

test('WTREE-01 uncertain: a -b value with an expansion is fine (`-b "$B" p next`)', () => {
  const e = oneCut('git worktree add -b "$B" p next');
  assert.strictEqual(e.newBranch, '$B');
  assert.strictEqual(e.baseKind, 'local');
});

// ───────────────────────── parity: the default matcher is gsd-test ─────────────────────────
//
// The generic walk called with no matcher must be the gsd-test detector, entry for entry. (The
// byte-level parity against PLAN_BASE's gsd-test-detect.cjs is a one-off script recorded in
// 37-02-SUMMARY.md: the comparison copy may not exist at commit time.)

const PARITY = [
  'gsd-test',
  'cd x && gsd-test',
  'FOO=1 nohup sudo gsd-test',
  'bash -c "gsd-test -head HEAD"',
  `bash -c "bash -c 'gsd-test'"`,
  '(gsd-test -head HEAD) | tail',
  '{ gsd-test; } 2>&1 | tail',
  'gsd-test -head origin/next | tail; gsd-test -head HEAD',
  'nohup gsd-test --head HEAD > log 2>&1 &',
  'set -o pipefail; gsd-test | tail',
  'gsd-test --bench "x',
  'gsd-test $EXTRA --head x',
  "env -S 'gsd-test --head HEAD'",
  `bash -c "bash -c 'bash -c gsd-test'"`,
  'gsd-test run --config /x/missing.toml',
  'sudo -D /g/core gsd-test --head HEAD | tail',
  "eval 'gsd-test --head HEAD | tail -5'",
  'command -v gsd-test && gsd-test --version',
  'SHA=$(git rev-parse HEAD) gsd-test --head HEAD | tail',
  'echo "(" ; cd x; echo ")"; gsd-test',
];

for (const cmd of PARITY) {
  test(`WTREE-01 parity: findProgramEntries(${cmd}) with no matcher === findGsdTestDispatches`, () => {
    const generic = exported(gtd, 'findProgramEntries', 'gsd-test-detect');
    assert.deepStrictEqual(generic(cmd), gtd.findGsdTestDispatches(cmd));
  });
}
