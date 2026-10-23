'use strict';

/**
 * bin/base-conflicts.test.cjs - HERMETIC test of the read-only conflicts-vs-base tool (`bin/base-conflicts.cjs`,
 * quick 261023-2u4 CONTEXT D3).
 *
 * What this pins, on real scratch git repos built by the test's own git: clean, base == head and
 * head-descends-from-base read clean with the right ahead/behind; one file changed on both sides is one
 * conflict with the commits on each side (10 shown, then "+K more"); paths print in byte order whatever order
 * git emits them in; a missing base ref prints the fetch for Dave and never fetches; unrelated histories
 * exit 1; the trial merge leaves `git count-objects -v` unchanged (and a plain merge-tree, the negative
 * control, does not); the temp object dir is removed after every run; the git runner refuses every write verb
 * before spawning; --pr goes through the shared stub gh with exactly one GET.
 *
 * @module bin/base-conflicts.test
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const bc = require('./base-conflicts.cjs');

const SCRIPT = path.join(__dirname, 'base-conflicts.cjs');
const GH_STUB = path.join(__dirname, 'fixtures', 'pr-status-gh-stub.cjs');
const FOOT = '  (read-only: the trial merge wrote only to a temp object dir, now removed; nothing fetched, checked out or written)';

/** The test's own git (never the tool's runner): hooks off, a fixed identity, no signing. */
function git(dir, ...args) {
  const r = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', '-C', dir, ...args], {
    encoding: 'utf8',
    env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/.test(k))),
  });
  if (r.status !== 0) throw new Error(`test git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function scratch(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A repo on branch next with a.txt and b.txt committed. */
function repo(t) {
  const dir = scratch(t, 'base-conflicts-repo-');
  git(dir, 'init', '-q', '-b', 'next');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'b\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'base');
  return dir;
}

function commit(dir, file, content, msg) {
  fs.writeFileSync(path.join(dir, file), content);
  git(dir, 'add', file);
  git(dir, 'commit', '-qm', msg);
  return git(dir, 'rev-parse', '--short', 'HEAD');
}

/** next and feat both change a.txt (one conflict); returns the short shas of each side's commit. */
function conflictRepo(t) {
  const dir = repo(t);
  git(dir, 'checkout', '-qb', 'feat');
  const h = commit(dir, 'a.txt', 'feat\n', 'feat edits a');
  git(dir, 'checkout', '-q', 'next');
  const b = commit(dir, 'a.txt', 'next\n', 'next edits a');
  return { dir, h, b };
}

/** Run the CLI in-process with the real git runner wrapped to record every argv. */
function run(argv, deps = {}) {
  let stdout = '';
  let stderr = '';
  const calls = [];
  const inner = deps.git || bc.defaultGit;
  const status = bc.runCli(argv, {
    ...deps,
    git: (args, cwd, env) => {
      calls.push(args);
      return inner(args, cwd, env);
    },
    stdout: { write: (s) => (stdout += s) },
    stderr: { write: (s) => (stderr += s) },
  });
  return { status, stdout, stderr, calls };
}

function looseCount(dir) {
  const m = /^count: (\d+)$/m.exec(git(dir, 'count-objects', '-v'));
  return Number(m[1]);
}

test('base-conflicts: a clean merge exits 0 with ahead and behind and no path lines', (t) => {
  const dir = repo(t);
  git(dir, 'checkout', '-qb', 'feat');
  commit(dir, 'a.txt', 'feat\n', 'feat edits a');
  git(dir, 'checkout', '-q', 'next');
  commit(dir, 'b.txt', 'next\n', 'next edits b');
  const r = run(['--cwd', dir, '--base', 'next', '--head', 'feat']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const lines = r.stdout.trimEnd().split('\n');
  assert.equal(lines[0], `base: next ${git(dir, 'rev-parse', 'next')}`);
  assert.equal(lines[1], `head: feat ${git(dir, 'rev-parse', 'feat')}`);
  assert.equal(lines[2], `  merge base: ${git(dir, 'rev-parse', 'next~1').slice(0, 9)}; ahead 1, behind 1`);
  assert.deepEqual(lines.slice(3), ['  clean', FOOT]);
});

test('base-conflicts: base == head and a head that descends from the base read clean (ahead/behind not swapped)', (t) => {
  const dir = repo(t);
  const same = run(['--cwd', dir, '--base', 'next', '--head', 'next']);
  assert.equal(same.status, 0, same.stdout);
  assert.match(same.stdout, /^ {2}merge base: [0-9a-f]{9}; ahead 0, behind 0$/m);
  assert.match(same.stdout, /^ {2}clean$/m);
  git(dir, 'checkout', '-qb', 'feat');
  commit(dir, 'a.txt', 'one\n', 'one');
  commit(dir, 'b.txt', 'two\n', 'two');
  const desc = run(['--cwd', dir, '--base', 'next', '--head', 'feat']);
  assert.equal(desc.status, 0, desc.stdout);
  assert.match(desc.stdout, /^ {2}merge base: [0-9a-f]{9}; ahead 2, behind 0$/m);
  assert.ok(!/^ {4}\S/m.test(desc.stdout), 'no path lines');
});

test('base-conflicts: one file changed on both sides prints conflicts: 1, the path and each side\'s commit, exit 3', (t) => {
  const { dir, h, b } = conflictRepo(t);
  const r = run(['--cwd', dir, '--base', 'next', '--head', 'feat']);
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.deepEqual(r.stdout.trimEnd().split('\n').slice(3), ['  conflicts: 1', '    a.txt', `      head side: ${h} feat edits a`, `      base side: ${b} next edits a`, FOOT]);
  assert.ok(r.calls.every((c) => c[0] !== 'merge-tree' || c.includes('-z')), 'merge-tree runs with -z (R7)');
});

test('base-conflicts: a side with 12 commits on the path prints 10 and "+2 more" (count from rev-list --count)', (t) => {
  const { dir } = conflictRepo(t);
  git(dir, 'checkout', '-q', 'feat');
  for (let i = 1; i <= 11; i += 1) commit(dir, 'a.txt', `feat ${i}\n`, `feat round ${i}`);
  const r = run(['--cwd', dir, '--base', 'next', '--head', 'feat']);
  assert.equal(r.status, 3, r.stdout);
  const head = r.stdout.split('\n').filter((l) => l.startsWith('      head side: '));
  assert.equal(head.length, 11);
  assert.match(head[0], /^ {6}head side: [0-9a-f]{7,} feat round 11$/, 'git log order, newest first');
  assert.equal(head[10], '      head side: +2 more');
  assert.ok(r.calls.some((c) => c[0] === 'rev-list' && c[1] === '--count'), 'the total comes from rev-list --count');
});

test('base-conflicts: conflicting paths print in byte order whatever order git emits them in', (t) => {
  const dir = repo(t);
  fs.writeFileSync(path.join(dir, 'B.txt'), 'B\n');
  git(dir, 'add', 'B.txt');
  git(dir, 'commit', '-qm', 'add B');
  git(dir, 'checkout', '-qb', 'feat');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'fa\n');
  fs.writeFileSync(path.join(dir, 'B.txt'), 'fB\n');
  git(dir, 'commit', '-qam', 'feat both');
  git(dir, 'checkout', '-q', 'next');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'na\n');
  fs.writeFileSync(path.join(dir, 'B.txt'), 'nB\n');
  git(dir, 'commit', '-qam', 'next both');
  const real = run(['--cwd', dir, '--base', 'next', '--head', 'feat']);
  const paths = (s) => s.split('\n').filter((l) => /^ {4}\S/.test(l));
  assert.deepEqual(paths(real.stdout), ['    B.txt', '    a.txt']);
  // the same repo with merge-tree's path list reversed: still byte order
  const reversed = run(['--cwd', dir, '--base', 'next', '--head', 'feat'], {
    git: (args, cwd, env) => {
      const r = bc.defaultGit(args, cwd, env);
      if (args[0] !== 'merge-tree') return r;
      const [tree, ...rest] = r.stdout.split('\0');
      return { ...r, stdout: [tree, ...rest.filter(Boolean).reverse(), ''].join('\0') };
    },
  });
  assert.deepEqual(paths(reversed.stdout), ['    B.txt', '    a.txt']);
  assert.deepEqual(bc.parseMergeTree(`t\0z\0a\0z\0`).paths, ['a', 'z']);
});

test('base-conflicts: a missing base ref prints the fetch for Dave, exits 1 and runs no fetch', (t) => {
  const dir = repo(t);
  const r = run(['--cwd', dir]);
  assert.equal(r.status, 1, r.stdout);
  assert.deepEqual(r.stdout.trimEnd().split('\n'), ['  ERROR: the base ref origin/next is not found in this checkout', '  first: git fetch origin next', '  (base-conflicts never fetches)']);
  assert.ok(!r.calls.some((c) => c[0] === 'fetch'), JSON.stringify(r.calls));
  assert.ok(r.calls.every((c) => ['rev-parse'].includes(c[0])), 'only rev-parse reads ran');
});

test('base-conflicts: two refs with no merge base exit 1 with the git error', (t) => {
  const dir = repo(t);
  git(dir, 'checkout', '-q', '--orphan', 'orph');
  git(dir, 'commit', '-qm', 'orphan');
  const r = run(['--cwd', dir, '--base', 'next', '--head', 'orph']);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /^ {2}ERROR: no merge base: git merge-base exited 1: no common ancestor \(unrelated histories\)$/m);
  assert.ok(!r.calls.some((c) => c[0] === 'merge-tree'));
});

test('base-conflicts: a --base, --head or --pr value that is not usable exits 2 with no git call', (t) => {
  for (const args of [['--base', '-x'], ['--head', '--upload-pack=x'], ['--base'], ['--head', 'a b'], ['--pr', '12a'], ['--pr', '0'], ['--repo', 'o/r'], ['--bogus']]) {
    const r = run(args, { gh: () => assert.fail('no gh call') });
    assert.equal(r.status, 2, `${JSON.stringify(args)}: exit 2`);
    assert.match(r.stderr, /^usage: base-conflicts /m);
    assert.equal(r.calls.length, 0, `${JSON.stringify(args)}: no git call`);
  }
  const help = run(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^usage: base-conflicts /);
});

test('base-conflicts safety: the default git runner throws before spawning for every write verb and any other verb', () => {
  const nowhere = path.join(os.tmpdir(), 'base-conflicts-no-such-dir');
  for (const args of [
    ['push', 'origin', 'HEAD'],
    ['fetch', 'origin'],
    ['checkout', 'next'],
    ['update-ref', 'refs/heads/x', 'HEAD'],
    ['remote', 'add', 'x', 'https://github.com/o/r.git'],
    ['remote', 'get-url', 'origin'],
    ['remote', '-v', 'extra'],
    ['merge', 'next'],
    ['rebase', 'next'],
    ['config', 'x', 'y'],
    ['gc'],
  ]) {
    assert.throws(() => bc.defaultGit(args, nowhere), /base-conflicts refuses git/, args.join(' '));
  }
  assert.throws(() => bc.defaultGit(['log'], nowhere, { GIT_DIR: '/x' }), /refuses to set GIT_DIR/);
  assert.deepEqual([...bc.GIT_READ_VERBS].sort(), ['log', 'merge-base', 'merge-tree', 'rev-list', 'rev-parse']);
});

test('base-conflicts object store: two runs are byte-identical and leave count-objects unchanged; a plain merge-tree grows it', (t) => {
  const { dir } = conflictRepo(t);
  const tmpRoot = scratch(t, 'base-conflicts-tmproot-');
  const before = looseCount(dir);
  const a = spawnSync(process.execPath, [SCRIPT, '--cwd', dir, '--base', 'next', '--head', 'feat'], { encoding: 'utf8' });
  const b = spawnSync(process.execPath, [SCRIPT, '--cwd', dir, '--base', 'next', '--head', 'feat'], { encoding: 'utf8' });
  assert.equal(a.status, 3, a.stdout + a.stderr);
  assert.equal(a.stdout, b.stdout);
  assert.equal(looseCount(dir), before, 'the trial merge wrote nothing to the repo object store');
  // the injected temp root is empty after a conflict run, a clean run and a failing run
  assert.equal(run(['--cwd', dir, '--base', 'next', '--head', 'feat'], { tmpdir: tmpRoot }).status, 3);
  assert.equal(run(['--cwd', dir, '--base', 'next', '--head', 'next'], { tmpdir: tmpRoot }).status, 0);
  const failing = run(['--cwd', dir, '--base', 'next', '--head', 'feat'], {
    tmpdir: tmpRoot,
    git: (args, cwd, env) => (args[0] === 'merge-tree' ? { status: 128, stdout: '', stderr: 'fatal: boom\n' } : bc.defaultGit(args, cwd, env)),
  });
  assert.equal(failing.status, 1);
  assert.match(failing.stdout, /^ {2}ERROR: git merge-tree failed: fatal: boom$/m);
  assert.deepEqual(fs.readdirSync(tmpRoot), [], 'every temp object dir was removed');
  assert.equal(looseCount(dir), before);
  // negative control: the same merge-tree without the object-dir env writes into the repo
  spawnSync('git', ['-C', dir, 'merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', 'next', 'feat'], { encoding: 'utf8' });
  assert.ok(looseCount(dir) > before, 'a plain merge-tree grows the object count (the check can fail)');
});

test('base-conflicts: a git without merge-tree --write-tree is named, with the version it needs', (t) => {
  const { dir } = conflictRepo(t);
  const r = run(['--cwd', dir, '--base', 'next', '--head', 'feat'], {
    git: (args, cwd, env) => (args[0] === 'merge-tree' ? { status: 129, stdout: '', stderr: "error: unknown option `write-tree'\nusage: git merge-tree\n" } : bc.defaultGit(args, cwd, env)),
  });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^ {2}ERROR: git merge-tree failed: error: unknown option `write-tree'; base-conflicts needs git 2\.38 or later \(merge-tree --write-tree\)$/m);
});

/** --pr through the shared stub gh on PATH; the tool runs as a child process with the real git. */
function runPr(t, dir, args, pull) {
  const sd = scratch(t, 'base-conflicts-gh-');
  const bin = path.join(sd, 'bin');
  const fx = path.join(sd, 'fx');
  fs.mkdirSync(bin);
  fs.mkdirSync(fx);
  fs.copyFileSync(GH_STUB, path.join(bin, 'gh'));
  fs.chmodSync(path.join(bin, 'gh'), 0o755);
  fs.writeFileSync(path.join(fx, 'pull.json'), JSON.stringify({ provenance: { source: 'synthetic' }, view: { number: pull.number }, pull }));
  const log = path.join(sd, 'gh.log');
  fs.writeFileSync(log, '');
  const r = spawnSync(process.execPath, [SCRIPT, '--cwd', dir, ...args], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, { PATH: bin + path.delimiter + process.env.PATH, PR_STATUS_STUB_FIXTURES: fx, PR_STATUS_STUB_LOG: log }),
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, log: fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) };
}

test('base-conflicts --pr: the base defaults to <remote>/<base.ref> for the remote naming the repo; head and base mismatches warn; one gh GET', (t) => {
  const { dir } = conflictRepo(t);
  git(dir, 'remote', 'add', 'fork', 'https://github.com/someone/gsd-core.git');
  git(dir, 'remote', 'add', 'upstream', 'https://github.com/Open-GSD/gsd-core.git');
  git(dir, 'update-ref', 'refs/remotes/upstream/next', git(dir, 'rev-parse', 'next'));
  git(dir, 'checkout', '-q', 'feat');
  const pull = { number: 5192, base: { ref: 'next' }, head: { sha: 'f'.repeat(40), ref: 'fix/x' } };
  const r = runPr(t, dir, ['--repo', 'open-gsd/gsd-core', '--pr', '5192'], pull);
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.match(r.stdout, /^pr: open-gsd\/gsd-core#5192 base next head f{9}$/m);
  assert.match(r.stdout, new RegExp(`^base: upstream/next ${git(dir, 'rev-parse', 'next')}$`, 'm'));
  assert.match(r.stdout, /^ {2}warning: the head HEAD \([0-9a-f]{9}\) is not the PR's head f{9}: the answer is for the local head$/m);
  assert.deepEqual(r.log.map((l) => JSON.parse(l)), [['api', 'repos/open-gsd/gsd-core/pulls/5192']]);
  assert.ok(!r.log.some((l) => l.startsWith('REFUSED')));
  // an explicit base on another branch warns
  git(dir, 'update-ref', 'refs/remotes/upstream/main', git(dir, 'rev-parse', 'next'));
  const other = runPr(t, dir, ['--repo', 'open-gsd/gsd-core', '--pr', '5192', '--base', 'upstream/main'], pull);
  assert.match(other.stdout, /^ {2}warning: the base ref upstream\/main names branch main, but the PR's base is next$/m);
  // the head matching the PR prints no head warning
  const match = runPr(t, dir, ['--repo', 'open-gsd/gsd-core', '--pr', '5192'], { ...pull, head: { sha: git(dir, 'rev-parse', 'feat') } });
  assert.ok(!/warning: the head/.test(match.stdout), match.stdout);
});

test('base-conflicts --pr: no remote naming the repo exits 1 naming it; a remote named with a leading - is never passed to git', (t) => {
  const dir = repo(t);
  git(dir, 'remote', 'add', 'fork', 'https://github.com/someone/gsd-core.git');
  const pull = { number: 5192, base: { ref: 'next' }, head: { sha: 'f'.repeat(40) } };
  const r = runPr(t, dir, ['--repo', 'open-gsd/gsd-core', '--pr', '5192'], pull);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^ {2}ERROR: no local remote's fetch URL names open-gsd\/gsd-core; pass --base <remote>\/next$/m);
  // a hostile remote name from `git remote -v` (injected runner) is skipped, never used as a ref or argument
  const calls = [];
  const fake = (args, cwd, env) => {
    calls.push(args);
    if (args[0] === 'remote') return { status: 0, stdout: '-evil\thttps://github.com/open-gsd/gsd-core.git (fetch)\n', stderr: '' };
    return bc.defaultGit(args, cwd, env);
  };
  let out = '';
  const status = bc.runCli(['--cwd', dir, '--pr', '5192'], { gh: () => pull, git: fake, stdout: { write: (s) => (out += s) }, stderr: { write: () => {} } });
  assert.equal(status, 1, out);
  assert.ok(!calls.flat().some((a) => String(a).includes('-evil')), JSON.stringify(calls));
});

test('base-conflicts --json carries base, head, mergeBase, ahead, behind, clean, conflicts and warnings', (t) => {
  const { dir, h, b } = conflictRepo(t);
  const r = run(['--json', '--cwd', dir, '--base', 'next', '--head', 'feat']);
  assert.equal(r.status, 3);
  const d = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(d).sort(), ['ahead', 'base', 'behind', 'clean', 'conflicts', 'head', 'mergeBase', 'pr', 'warnings']);
  assert.equal(d.base.sha, git(dir, 'rev-parse', 'next'));
  assert.equal(d.clean, false);
  assert.deepEqual(d.conflicts, [{ path: 'a.txt', listed: true, head: [`${h} feat edits a`], headMore: 0, base: [`${b} next edits a`], baseMore: 0 }]);
  assert.deepEqual(d.warnings, []);
});
