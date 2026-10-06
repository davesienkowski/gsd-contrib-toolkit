'use strict';

/**
 * node:test for hooks/lib/worktree-add-detect.cjs — the pure `git [globals] worktree add`
 * detector behind ENF-25 (hooks/worktree-fresh-base.cjs).
 *
 * 37-01 tracer form: top-level segments only, the git global walk (`-C` collected, value globals
 * skipped), the `worktree add` tail walk (`-b`/`-B`/`--reason` consume a value), and the
 * trunk-naming base classification. The entry shape asserted here is FINAL: 37-02 fills parsing
 * (groups, `bash -c`, wrappers, uncertain grading, attached option forms) without reshaping it.
 */

const test = require('node:test');
const assert = require('node:assert');

const { findWorktreeAdds, classifyBase, WORKTREE_ADD_WORD } = require('./worktree-add-detect.cjs');

const ENTRY_KEYS = [
  'base', 'baseKind', 'depth', 'gitChdirs', 'kind', 'newBranch', 'path', 'prefixes', 'seg', 'segIndex', 'viaDashC',
];

function only(command) {
  const e = findWorktreeAdds(command);
  assert.strictEqual(e.length, 1, 'exactly one entry for ' + JSON.stringify(command) + ', got ' + JSON.stringify(e));
  return e[0];
}

test('WTREE-01 detect: `git worktree add p next` is a cut of local next with no -C', () => {
  const e = only('git worktree add p next');
  assert.strictEqual(e.kind, 'cut');
  assert.strictEqual(e.path, 'p');
  assert.strictEqual(e.base, 'next');
  assert.strictEqual(e.baseKind, 'local');
  assert.deepStrictEqual(e.gitChdirs, []);
  assert.strictEqual(e.newBranch, null);
});

test('WTREE-01 detect: the entry carries the FINAL shape (later plans never reshape it)', () => {
  const e = only('git worktree add p next');
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
  const e = only('git worktree add -b feat p origin/next');
  assert.strictEqual(e.baseKind, 'remote');
  assert.strictEqual(e.base, 'origin/next');
  assert.strictEqual(e.newBranch, 'feat');
  assert.strictEqual(e.path, 'p');
});

test('WTREE-01 detect: `git worktree add p` (no base) -> base null, baseKind head', () => {
  const e = only('git worktree add p');
  assert.strictEqual(e.base, null);
  assert.strictEqual(e.baseKind, 'head');
  assert.strictEqual(e.path, 'p');
});

test('WTREE-01 detect: `git worktree add p feature` -> baseKind other', () => {
  const e = only('git worktree add p feature');
  assert.strictEqual(e.base, 'feature');
  assert.strictEqual(e.baseKind, 'other');
});

test('WTREE-01 detect: `git -C /a worktree add p next` collects the global -C value', () => {
  const e = only('git -C /a worktree add p next');
  assert.deepStrictEqual(e.gitChdirs, ['/a']);
  assert.strictEqual(e.baseKind, 'local');
});

test('WTREE-01 detect: `-B` and `--reason` consume their value tokens', () => {
  const e = only('git worktree add --reason why -B topic p next');
  assert.strictEqual(e.newBranch, 'topic');
  assert.strictEqual(e.path, 'p');
  assert.strictEqual(e.base, 'next');
});

test('WTREE-01 detect: an earlier `cd` segment is carried as a prefix for the start-dir helper', () => {
  const e = only('cd /x && git worktree add p next');
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
  assert.ok(WORKTREE_ADD_WORD.test('git worktree   add p'));
  assert.ok(!WORKTREE_ADD_WORD.test('git worktreeadd p'));
  assert.ok(!WORKTREE_ADD_WORD.test('git worktree adder p'));
});
