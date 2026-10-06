'use strict';

/**
 * node:test for hooks/gsd-test-clean-tree.cjs — the ENF-23 gsd-test clean-tree gate.
 *
 * 36-01 tracer slice: the pipe deny (GTEST-03) wired end to end — argv `nextOp` -> the shared
 * detector (hooks/lib/gsd-test-detect.cjs) -> the gate -> the emitted decision.
 *
 *   • unit rows drive `runGsdTestCleanTreeGate(stdin, deps)` with an injected `resolveTreeRoot`
 *     and a call counter, so the RES-01 short-circuit (no dispatch -> zero resolves) is asserted
 *     by COUNT, not by timing (Addendum 2);
 *   • tracer rows spawn the REAL entrypoint through proof-harness spawnHook from a temp dir that
 *     carries the gsd-core sentinel layout (scripts/issue-dedupe.cjs + gsd-core/bin/lib/), so the
 *     emitted JSON decision is what the harness would actually see. No real gsd-test, no Docker.
 *
 * 36-03 (GTEST-02): the dirty-tree deny. Unit rows inject `gitStatus` / `resolveRef` with call
 * counters; the e2e rows spawn the real entrypoint inside REAL temporary git repositories (temp
 * dirs only, global/system git config disabled, never ~/repos/gsd-core).
 */

// Real-git hygiene (hard rule): these would redirect both the setup git calls and the spawned
// hook's git, or let the user's global config (hooks, signing) leak into the temp repos. The
// override variable is removed too: the spawned hook uses the REAL override module, and a stray
// GSD_CONTRIB_OVERRIDE would flip the thrown-path e2e row to allow.
for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_CEILING_DIRECTORIES', 'GSD_CONTRIB_OVERRIDE']) {
  delete process.env[k];
}
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// 36-REVIEW m-07: runGate records every verdict (OBS-02). Point the log at a per-file temp dir so
// this suite never appends synthetic verdicts to the real ~/.gsd-contrib/tool-log.jsonl that
// bin/verdict-stats.cjs reads; spawned hooks inherit it through process.env.
process.env.GSD_CONTRIB_LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gtest-ct-vlog-'));
process.on('exit', () => fs.rmSync(process.env.GSD_CONTRIB_LOG_DIR, { recursive: true, force: true }));

const cleanTree = require('./gsd-test-clean-tree.cjs');
const { runGsdTestCleanTreeGate, PIPE_REASON } = cleanTree;
const { FailClosed } = require('./lib/failclosed.cjs');
const { findGsdTestDispatch } = require('./lib/gsd-test-detect.cjs');
const { spawnHook } = require('./lib/proof-harness.cjs');

const HOOK = path.join(__dirname, 'gsd-test-clean-tree.cjs');
const PIPED = 'gsd-test -base next -head origin/next | tail';
const UNPIPED = 'gsd-test -base next -head origin/next';
const FAKE_CWD = path.join(path.sep, 'fake', 'gsd-core');

function input(command) {
  return JSON.stringify({ tool_name: 'Bash', tool_input: { command } });
}

const SHA_HEAD = 'a'.repeat(40);
const SHA_OTHER = 'b'.repeat(40);
const DIRTY_ONE = ' M gsd-core/bin/lib/core.cjs\n';

/**
 * Injected deps + a counter on every impure seam. The DEFAULT world is a CLEAN gsd-core tree
 * (gitStatus ''), HEAD at SHA_HEAD, and `origin/next` at SHA_OTHER; each test overrides only what
 * it is about. `refs` maps a ref to its sha (missing -> null, an unknown ref).
 */
function scenario(over = {}) {
  const calls = { resolveTreeRoot: 0, dirs: [], gitStatus: 0, resolveRef: 0, refs: [], writeReceipt: 0 };
  const refs = Object.assign({ HEAD: SHA_HEAD, 'origin/next': SHA_OTHER }, over.refs || {});
  const porcelain = typeof over.porcelain === 'string' ? over.porcelain : '';
  const override = over.override === true;
  const base = {
    cwd: FAKE_CWD,
    env: {},
    homedir: path.join(path.sep, 'h'),
    resolveTreeRoot: (dir) => {
      calls.resolveTreeRoot += 1;
      calls.dirs.push(dir);
      return FAKE_CWD;
    },
    gitStatus: () => {
      calls.gitStatus += 1;
      return porcelain;
    },
    resolveRef: (root, ref) => {
      calls.resolveRef += 1;
      calls.refs.push(ref);
      return Object.prototype.hasOwnProperty.call(refs, ref) ? refs[ref] : null;
    },
    overrideImpl: {
      checkOverride: () => (override ? { override: true, reason: 'test override' } : { override: false }),
      writeReceipt: () => {
        calls.writeReceipt += 1;
      },
    },
  };
  const rest = Object.assign({}, over);
  delete rest.refs;
  delete rest.porcelain;
  delete rest.override;
  return { deps: Object.assign(base, rest), calls };
}

/** A REAL temporary git repo with the gsd-core sentinel layout and one commit. */
function git(dir, ...args) {
  return execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
}

function commitAll(dir, msg) {
  git(dir, 'add', '-A');
  git(
    dir,
    '-c', 'user.email=t@example.invalid',
    '-c', 'user.name=t',
    '-c', 'commit.gpgsign=false',
    'commit', '-q', '--no-verify', '-m', msg
  );
  return git(dir, 'rev-parse', 'HEAD').trim();
}

function makeGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gtest-ct-'));
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'gsd-core', 'bin', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'scripts', 'issue-dedupe.cjs'), '');
  fs.writeFileSync(path.join(dir, 'tracked.txt'), 'one\n');
  git(dir, '-c', 'init.defaultBranch=main', 'init', '-q');
  const sha = commitAll(dir, 'init');
  return { dir, sha };
}

function spawnIn(dir, command) {
  const r = spawnHook(HOOK, { stdin: input(command), cwd: dir });
  assert.strictEqual(r.conclusive, true, r.reason + ' ' + r.rawStderr);
  const emitted = JSON.parse(r.rawStdout).hookSpecificOutput;
  return { decision: r.decision, reason: emitted.permissionDecisionReason || '' };
}

/** A temp dir holding the gsd-core sentinel layout; removed in the caller's finally. */
function makeSentinelDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gtest-tracer-'));
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'gsd-core', 'bin', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'scripts', 'issue-dedupe.cjs'), '');
  return dir;
}

// ───────────────────────── detector (tracer form) ─────────────────────────

test('ENF-23 GTEST-03: the detector reports a piped plain dispatch as pipedOut + pipeMasked', () => {
  const d = findGsdTestDispatch(PIPED);
  assert.ok(d, 'a plain gsd-test dispatch must be detected');
  assert.strictEqual(d.kind, 'dispatch');
  assert.strictEqual(d.pipedOut, true);
  assert.strictEqual(d.pipeMasked, true);
});

test('ENF-23 GTEST-03: the detector returns null for a non-dispatch (`git status`)', () => {
  assert.strictEqual(findGsdTestDispatch('git status'), null);
});

// ───────────────────────── gate (injected deps) ─────────────────────────

test('ENF-23 GTEST-03: a piped dispatch from a gsd-core tree DENIES naming ENF-23, pipefail and a redirect', () => {
  const { deps, calls } = scenario();
  const d = runGsdTestCleanTreeGate(input(PIPED), deps);
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /ENF-23/);
  assert.match(d.permissionDecisionReason, /pipefail/);
  assert.match(d.permissionDecisionReason, /> \S+ 2>&1/, 'must name a redirect-to-file alternative');
  assert.strictEqual(calls.resolveTreeRoot, 1);
});

test('ENF-23 GTEST-03: the same dispatch UNPIPED allows (the tracer slice gates the pipe only)', () => {
  const { deps } = scenario();
  const d = runGsdTestCleanTreeGate(input(UNPIPED), deps);
  assert.strictEqual(d.permissionDecision, 'allow');
});

test('ENF-23 GTEST-03: `git status` allows with ZERO resolveTreeRoot calls (RES-01, Addendum 2)', () => {
  const { deps, calls } = scenario();
  const d = runGsdTestCleanTreeGate(input('git status'), deps);
  assert.strictEqual(d.permissionDecision, 'allow');
  assert.strictEqual(calls.resolveTreeRoot, 0, 'the detector short-circuit runs before any resolve');
});

test('ENF-23 GTEST-03: a piped dispatch whose tree is not a gsd-core checkout ALLOWS', () => {
  const { deps } = scenario({ resolveTreeRoot: () => null });
  const d = runGsdTestCleanTreeGate(input(PIPED), deps);
  assert.strictEqual(d.permissionDecision, 'allow');
});

test('ENF-23 GTEST-03: the tree is resolved from the command start dir (`cd sub && ...`)', () => {
  const { deps, calls } = scenario();
  const d = runGsdTestCleanTreeGate(input('cd sub && ' + PIPED), deps);
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.deepStrictEqual(calls.dirs, [path.resolve(FAKE_CWD, 'sub')]);
});

test('ENF-23 GTEST-03: PIPE_REASON is byte-stable (no cwd, home path or sha)', () => {
  assert.strictEqual(typeof PIPE_REASON, 'string');
  assert.match(PIPE_REASON, /ENF-23/);
  assert.ok(!PIPE_REASON.includes(process.cwd()), 'no cwd');
  assert.ok(!PIPE_REASON.includes(os.homedir()), 'no home path');
  assert.ok(!/[0-9a-f]{40}/.test(PIPE_REASON), 'no sha');
});

// ───────────────────────── tracer: the real entrypoint, spawned ─────────────────────────

test('ENF-23 GTEST-03 tracer: the spawned entrypoint DENIES a piped dispatch from a gsd-core-shaped dir', () => {
  const dir = makeSentinelDir();
  try {
    const r = spawnHook(HOOK, { stdin: input(PIPED), cwd: dir });
    assert.strictEqual(r.conclusive, true, r.reason + ' ' + r.rawStderr);
    assert.strictEqual(r.decision, 'deny', r.reason);
    const emitted = JSON.parse(r.rawStdout).hookSpecificOutput;
    assert.strictEqual(emitted.permissionDecisionReason, PIPE_REASON);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ENF-23 GTEST-03 tracer: the spawned entrypoint ALLOWS `git status` from a gsd-core-shaped dir', () => {
  const dir = makeSentinelDir();
  try {
    const r = spawnHook(HOOK, { stdin: input('git status'), cwd: dir });
    assert.strictEqual(r.conclusive, true, r.reason + ' ' + r.rawStderr);
    assert.strictEqual(r.decision, 'allow', r.reason);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ───────────────────────── 36-03 Task 1: GTEST-02 dirty-tree deny (injected deps) ─────────────────────────

test('ENF-23 GTEST-02: GIT_TIMEOUT_MS is exported and is 5000', () => {
  assert.strictEqual(cleanTree.GIT_TIMEOUT_MS, 5000);
});

test('ENF-23 GTEST-02: dirty tree + --head omitted DENIES with the ref-based reason, the fix and the dirty path', () => {
  const { deps } = scenario({ porcelain: DIRTY_ONE });
  const d = runGsdTestCleanTreeGate(input('gsd-test -base next'), deps);
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /ENF-23/);
  assert.match(d.permissionDecisionReason, /ref-based/);
  assert.match(d.permissionDecisionReason, /commit/);
  assert.ok(d.permissionDecisionReason.includes('gsd-core/bin/lib/core.cjs'), 'lists the dirty path');
  assert.ok(!/GSD_CONTRIB_OVERRIDE|override/i.test(d.permissionDecisionReason), 'policy deny names no override escape');
});

for (const cmd of ['gsd-test --head HEAD', 'gsd-test -head=HEAD', 'gsd-test --head @', 'gsd-test --head=']) {
  test(`ENF-23 GTEST-02: dirty tree + \`${cmd}\` (the working HEAD) DENIES without a git ref lookup`, () => {
    const { deps, calls } = scenario({ porcelain: DIRTY_ONE });
    const d = runGsdTestCleanTreeGate(input(cmd), deps);
    assert.strictEqual(d.permissionDecision, 'deny');
    assert.match(d.permissionDecisionReason, /ENF-23/);
    assert.strictEqual(calls.resolveRef, 0, 'HEAD / @ / empty need no rev-parse');
  });
}

test('ENF-23 GTEST-02: dirty tree + --head <HEAD sha> DENIES (the sha resolves to HEAD)', () => {
  const { deps } = scenario({ porcelain: DIRTY_ONE, refs: { [SHA_HEAD]: SHA_HEAD } });
  const d = runGsdTestCleanTreeGate(input('gsd-test --base next --head ' + SHA_HEAD), deps);
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /ENF-23/);
});

test('ENF-23 GTEST-02: dirty tree + --head fix/branch resolving to the HEAD sha DENIES', () => {
  const { deps } = scenario({ porcelain: DIRTY_ONE, refs: { 'fix/branch': SHA_HEAD } });
  const d = runGsdTestCleanTreeGate(input('gsd-test -head fix/branch'), deps);
  assert.strictEqual(d.permissionDecision, 'deny');
});

test('ENF-23 GTEST-02: dirty tree + --head origin/next (a different commit) ALLOWS — a deliberate ref-vs-ref run', () => {
  const { deps, calls } = scenario({ porcelain: DIRTY_ONE });
  const d = runGsdTestCleanTreeGate(input('gsd-test --base next --head origin/next'), deps);
  assert.strictEqual(d.permissionDecision, 'allow');
  assert.ok(calls.refs.includes('origin/next'), 'the explicit ref is resolved and compared');
});

test('ENF-23 GTEST-02: dirty tree + --head nosuchref (does not resolve) ALLOWS', () => {
  const { deps } = scenario({ porcelain: DIRTY_ONE });
  const d = runGsdTestCleanTreeGate(input('gsd-test --head nosuchref'), deps);
  assert.strictEqual(d.permissionDecision, 'allow');
});

test('ENF-23 GTEST-02: clean tree + --head omitted ALLOWS with exactly one gitStatus and zero resolveRef calls', () => {
  const { deps, calls } = scenario();
  const d = runGsdTestCleanTreeGate(input('gsd-test -base next'), deps);
  assert.strictEqual(d.permissionDecision, 'allow');
  assert.strictEqual(calls.gitStatus, 1);
  assert.strictEqual(calls.resolveRef, 0);
});

test('ENF-23 GTEST-02: 12 dirty paths -> the reason lists exactly 10 and says (and 2 more)', () => {
  const lines = [];
  for (let i = 1; i <= 12; i++) lines.push(' M file-' + String(i).padStart(2, '0') + '.cjs');
  const { deps } = scenario({ porcelain: lines.join('\n') + '\n' });
  const d = runGsdTestCleanTreeGate(input('gsd-test'), deps);
  assert.strictEqual(d.permissionDecision, 'deny');
  const listed = lines.filter((l) => d.permissionDecisionReason.includes(l.trim()));
  assert.strictEqual(listed.length, 10, 'exactly 10 of the 12 paths are listed');
  assert.ok(!d.permissionDecisionReason.includes('file-11.cjs'), 'the 11th path is not listed');
  assert.match(d.permissionDecisionReason, /\(and 2 more\)/);
});

test('ENF-23 GTEST-02: a git failure (gitStatus throws FailClosed) DENIES carrying the git reason (HARD-01)', () => {
  const { deps } = scenario({
    gitStatus: () => {
      throw new FailClosed('ENF-23 could not read the work-tree status: fatal: not a git repository');
    },
  });
  const d = runGsdTestCleanTreeGate(input('gsd-test'), deps);
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /not a git repository/);
});

test('ENF-23 GTEST-02: the THROWN git-failure deny IS override-escapable (allow + one receipt)', () => {
  const { deps, calls } = scenario({
    override: true,
    gitStatus: () => {
      throw new FailClosed('ENF-23 could not read the work-tree status: timeout');
    },
  });
  const d = runGsdTestCleanTreeGate(input('gsd-test'), deps);
  assert.strictEqual(d.permissionDecision, 'allow');
  assert.strictEqual(calls.writeReceipt, 1, 'the override writes exactly one receipt');
});

test('ENF-23 GTEST-02: a dirty-tree POLICY deny is NOT override-escapable (Addendum 4)', () => {
  const { deps, calls } = scenario({ override: true, porcelain: DIRTY_ONE });
  const d = runGsdTestCleanTreeGate(input('gsd-test --head HEAD'), deps);
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /ENF-23/);
  assert.strictEqual(calls.writeReceipt, 0, 'no receipt: a policy deny is never overridden');
});

test('ENF-23 GTEST-02: a pipe-masked dispatch with a dirty tree DENIES with PIPE_REASON before any git call', () => {
  const { deps, calls } = scenario({ porcelain: DIRTY_ONE });
  const d = runGsdTestCleanTreeGate(input('gsd-test --head HEAD | tail -40'), deps);
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.strictEqual(d.permissionDecisionReason, PIPE_REASON);
  assert.strictEqual(calls.gitStatus, 0, 'the pipe deny needs no git');
});

// ───────────────────────── 36-03 Task 1: GTEST-02 e2e on REAL temporary git repos ─────────────────────────

test('ENF-23 GTEST-02 e2e: a committed clean tree + `gsd-test -base next -head HEAD` ALLOWS', () => {
  const { dir } = makeGitRepo();
  try {
    assert.strictEqual(spawnIn(dir, 'gsd-test -base next -head HEAD').decision, 'allow');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ENF-23 GTEST-02 e2e: a modified tracked file DENIES and the reason lists that file', () => {
  const { dir } = makeGitRepo();
  try {
    fs.writeFileSync(path.join(dir, 'tracked.txt'), 'two\n');
    const r = spawnIn(dir, 'gsd-test -base next -head HEAD');
    assert.strictEqual(r.decision, 'deny', r.reason);
    assert.match(r.reason, /ENF-23/);
    assert.ok(r.reason.includes('tracked.txt'), r.reason);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ENF-23 GTEST-02 e2e: a staged-but-uncommitted tracked change DENIES', () => {
  const { dir } = makeGitRepo();
  try {
    fs.writeFileSync(path.join(dir, 'tracked.txt'), 'staged\n');
    git(dir, 'add', 'tracked.txt');
    const r = spawnIn(dir, 'gsd-test');
    assert.strictEqual(r.decision, 'deny', r.reason);
    assert.ok(r.reason.includes('tracked.txt'), r.reason);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ENF-23 GTEST-02 e2e: an untracked-only new file ALLOWS (--untracked-files=no)', () => {
  const { dir } = makeGitRepo();
  try {
    fs.writeFileSync(path.join(dir, 'scratch-notes.txt'), 'untracked\n');
    assert.strictEqual(spawnIn(dir, 'gsd-test -head HEAD').decision, 'allow');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ENF-23 GTEST-02 e2e: two commits, dirty tree, `--head <first commit sha>` ALLOWS (ref-vs-ref)', () => {
  const { dir, sha: first } = makeGitRepo();
  try {
    fs.writeFileSync(path.join(dir, 'tracked.txt'), 'second\n');
    commitAll(dir, 'second');
    fs.writeFileSync(path.join(dir, 'tracked.txt'), 'dirty\n');
    assert.strictEqual(spawnIn(dir, 'gsd-test --base next --head ' + first).decision, 'allow');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ENF-23 GTEST-02 e2e: dirty tree + `--head <current HEAD sha>` DENIES (the sha is the working HEAD)', () => {
  const { dir, sha } = makeGitRepo();
  try {
    fs.writeFileSync(path.join(dir, 'tracked.txt'), 'dirty\n');
    assert.strictEqual(spawnIn(dir, 'gsd-test --head ' + sha).decision, 'deny');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ENF-23 GTEST-02 e2e: a sentinel dir WITHOUT `git init` DENIES (git failure fails closed)', () => {
  const dir = makeSentinelDir();
  try {
    const r = spawnIn(dir, 'gsd-test -head HEAD');
    assert.strictEqual(r.decision, 'deny', r.reason);
    assert.match(r.reason, /ENF-23/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ───────────────────────── 36-03 Task 2: ENF-23 hardening ─────────────────────────

/** Total git invocations (status + ref lookups). */
function gitCalls(calls) {
  return calls.gitStatus + calls.resolveRef;
}

test('ENF-23 hardening: dirty + `--head $(git rev-parse HEAD)` DENIES, asks for a literal ref, zero resolveRef calls', () => {
  const { deps, calls } = scenario({ porcelain: DIRTY_ONE });
  const d = runGsdTestCleanTreeGate(input('gsd-test --base next --head $(git rev-parse HEAD)'), deps);
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /ENF-23/);
  assert.match(d.permissionDecisionReason, /literal sha or ref/);
  assert.strictEqual(calls.resolveRef, 0, 'an expansion value is never passed to git');
});

test('ENF-23 hardening: dirty + `--head "$SHA"` DENIES (unresolved), zero resolveRef calls', () => {
  const { deps, calls } = scenario({ porcelain: DIRTY_ONE });
  const d = runGsdTestCleanTreeGate(input('gsd-test --head "$SHA"'), deps);
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.strictEqual(calls.resolveRef, 0);
});

test('ENF-23 hardening (checker item 2): flags after a $(...) head are honoured — -source ../core from /w/sub resolves /w/core and DENIES', () => {
  const { deps, calls } = scenario({ porcelain: DIRTY_ONE, cwd: '/w/sub' });
  const d = runGsdTestCleanTreeGate(
    input('gsd-test --base next --head $(git rev-parse HEAD) -source ../core'),
    deps
  );
  assert.deepStrictEqual(calls.dirs, [path.resolve('/w/core')]);
  assert.strictEqual(d.permissionDecision, 'deny');
});

const TREE_ROWS = [
  ['gsd-test -source ../core', '/w/sub', '/w/core'],
  ['cd /w/a && gsd-test', '/w/sub', '/w/a'],
  ['gsd-test; cd /tmp', '/w/sub', '/w/sub'],
  ['git -C /w/other status && gsd-test', '/w/sub', '/w/sub'],
];
for (const [cmd, cwd, want] of TREE_ROWS) {
  test(`ENF-23 hardening: \`${cmd}\` from ${cwd} resolves the tree at ${want}`, () => {
    const { deps, calls } = scenario({ cwd });
    runGsdTestCleanTreeGate(input(cmd), deps);
    assert.deepStrictEqual(calls.dirs, [path.resolve(want)]);
  });
}

test('ENF-23 hardening: `gsd-test -source $X` DENIES (thrown: cannot resolve) with ZERO resolveTreeRoot calls', () => {
  const { deps, calls } = scenario();
  const d = runGsdTestCleanTreeGate(input('gsd-test -source $X'), deps);
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /ENF-23/);
  assert.match(d.permissionDecisionReason, /literal path/);
  assert.strictEqual(calls.resolveTreeRoot, 0);
  assert.strictEqual(gitCalls(calls), 0);
});

test('ENF-23 hardening: the unresolvable -source deny is THROWN (override-escapable with a receipt)', () => {
  const { deps, calls } = scenario({ override: true });
  const d = runGsdTestCleanTreeGate(input('gsd-test -source $X'), deps);
  assert.strictEqual(d.permissionDecision, 'allow');
  assert.strictEqual(calls.writeReceipt, 1);
});

const UNCERTAIN_ROWS = [
  'gsd-test --head "x',
  "env -S 'gsd-test --head HEAD'",
  `bash -c "bash -c 'bash -c gsd-test'"`,
  'gsd-test $EXTRA --head x',
  'gsd-test --head $(cd x; git rev-parse HEAD) --bench b',
];
for (const cmd of UNCERTAIN_ROWS) {
  test(`ENF-23 hardening: uncertain \`${cmd}\` DENIES (HARD-01) with ZERO resolve/git calls`, () => {
    const { deps, calls } = scenario();
    const d = runGsdTestCleanTreeGate(input(cmd), deps);
    assert.strictEqual(d.permissionDecision, 'deny');
    assert.match(d.permissionDecisionReason, /ENF-23/);
    assert.strictEqual(calls.resolveTreeRoot, 0, 'the uncertain throw precedes any resolve');
    assert.strictEqual(gitCalls(calls), 0);
  });
}

for (const cmd of ['echo "x', 'cat gsd-test-clean-tree.cjs "x']) {
  test(`ENF-23 hardening: an unparseable command WITHOUT the gsd-test word (\`${cmd}\`) ALLOWS with zero calls`, () => {
    const { deps, calls } = scenario();
    const d = runGsdTestCleanTreeGate(input(cmd), deps);
    assert.strictEqual(d.permissionDecision, 'allow');
    assert.strictEqual(calls.resolveTreeRoot + gitCalls(calls), 0);
  });
}

for (const cmd of ['gsd-test --version', 'gsd-test -h', 'gsd-test --help | head']) {
  test(`ENF-23 hardening: informational \`${cmd}\` ALLOWS with zero resolveTreeRoot/gitStatus/resolveRef calls`, () => {
    const { deps, calls } = scenario({ porcelain: DIRTY_ONE });
    const d = runGsdTestCleanTreeGate(input(cmd), deps);
    assert.strictEqual(d.permissionDecision, 'allow');
    assert.strictEqual(calls.resolveTreeRoot, 0);
    assert.strictEqual(gitCalls(calls), 0);
  });
}

for (const cmd of ['git status', 'npm test', 'gh pr review 9 --approve', 'echo gsd-test', 'git commit -m "gsd-test | tail"']) {
  test(`ENF-23 hardening: non-dispatch \`${cmd}\` ALLOWS with zero calls (RES-01)`, () => {
    const { deps, calls } = scenario({ porcelain: DIRTY_ONE });
    const d = runGsdTestCleanTreeGate(input(cmd), deps);
    assert.strictEqual(d.permissionDecision, 'allow');
    assert.strictEqual(calls.resolveTreeRoot, 0);
    assert.strictEqual(gitCalls(calls), 0);
  });
}

// B-01 (36-REVIEW): `--probe-benches` runs the full suite in v1.8.0, so both traps apply to it.
test('ENF-23 B-01: `gsd-test --probe-benches --head HEAD 2>&1 | tail -20` DENIES with PIPE_REASON', () => {
  const { deps } = scenario({ porcelain: DIRTY_ONE });
  const d = runGsdTestCleanTreeGate(input('gsd-test --probe-benches --head HEAD 2>&1 | tail -20'), deps);
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.strictEqual(d.permissionDecisionReason, PIPE_REASON);
});

test('ENF-23 B-01: dirty tree + unpiped `gsd-test --probe-benches` DENIES with the dirty-tree reason', () => {
  const { deps, calls } = scenario({ porcelain: DIRTY_ONE });
  const d = runGsdTestCleanTreeGate(input('gsd-test --probe-benches'), deps);
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /ref-based/);
  assert.strictEqual(calls.gitStatus, 1);
});

test('ENF-23 hardening: multi-dispatch `gsd-test -head origin/next; gsd-test` (dirty) DENIES — the second tests HEAD', () => {
  const { deps, calls } = scenario({ porcelain: DIRTY_ONE });
  const d = runGsdTestCleanTreeGate(input('gsd-test -head origin/next; gsd-test'), deps);
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /ref-based/);
  assert.strictEqual(calls.gitStatus, 1, 'the porcelain is cached per root within one gate call');
});

test('ENF-23 hardening: multi-dispatch `gsd-test --version && gsd-test -head HEAD | tail` (dirty) DENIES on the pipe', () => {
  const { deps } = scenario({ porcelain: DIRTY_ONE });
  const d = runGsdTestCleanTreeGate(input('gsd-test --version && gsd-test -head HEAD | tail'), deps);
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.strictEqual(d.permissionDecisionReason, PIPE_REASON);
});

test('ENF-23 hardening: an out-of-tree piped dispatch (resolveTreeRoot null) ALLOWS with zero gitStatus calls', () => {
  const { deps, calls } = scenario({ porcelain: DIRTY_ONE, resolveTreeRoot: () => null });
  const d = runGsdTestCleanTreeGate(input('gsd-test -head HEAD | tail'), deps);
  assert.strictEqual(d.permissionDecision, 'allow');
  assert.strictEqual(gitCalls(calls), 0);
});

test('ENF-23 hardening: `bash -c "gsd-test -head HEAD"` (dirty) DENIES — a -c payload dispatch is evaluated like any other', () => {
  const { deps } = scenario({ porcelain: DIRTY_ONE });
  const d = runGsdTestCleanTreeGate(input('bash -c "gsd-test -head HEAD"'), deps);
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /ENF-23/);
});

test('ENF-23 hardening e2e: `--head=--output=<tmp>/pwn` on a real dirty repo ALLOWS (unknown ref) and creates no file', () => {
  const { dir } = makeGitRepo();
  const pwn = path.join(dir, 'pwn');
  try {
    fs.writeFileSync(path.join(dir, 'tracked.txt'), 'dirty\n');
    const r = spawnIn(dir, 'gsd-test --head=--output=' + pwn);
    assert.strictEqual(r.decision, 'allow', r.reason);
    assert.strictEqual(fs.existsSync(pwn), false, 'an option-shaped --head must be inert');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ENF-23 hardening e2e: dirty real repo + `--head $(git rev-parse HEAD)` DENIES asking for a literal ref', () => {
  const { dir } = makeGitRepo();
  try {
    fs.writeFileSync(path.join(dir, 'tracked.txt'), 'dirty\n');
    const r = spawnIn(dir, 'gsd-test --base next --head $(git rev-parse HEAD) --bench wsl-local');
    assert.strictEqual(r.decision, 'deny', r.reason);
    assert.match(r.reason, /literal sha or ref/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─────────────── 36-03 handoff fixes (detector residuals from 36-02), at the gate ───────────────

test('ENF-23 handoff: `cd "$X" && gsd-test` DENIES (unresolved start dir, thrown) with ZERO resolve/git calls', () => {
  const { deps, calls } = scenario();
  const d = runGsdTestCleanTreeGate(input('cd "$X" && gsd-test'), deps);
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /ENF-23/);
  assert.match(d.permissionDecisionReason, /literal path/);
  assert.strictEqual(calls.resolveTreeRoot, 0, 'never trusts <cwd>/$X');
  assert.strictEqual(gitCalls(calls), 0);
});

test('ENF-23 handoff: `cd "$HOME/w/a" && gsd-test` resolves the tree from the injected HOME', () => {
  const { deps, calls } = scenario({ env: { HOME: '/h' } });
  runGsdTestCleanTreeGate(input('cd "$HOME/w/a" && gsd-test'), deps);
  assert.deepStrictEqual(calls.dirs, [path.resolve('/h/w/a')]);
});

test('ENF-23 handoff: `echo "("; cd /w/a; echo ")"; gsd-test` resolves the tree at /w/a (quoted parens do not group)', () => {
  const { deps, calls } = scenario({ cwd: '/w/sub' });
  runGsdTestCleanTreeGate(input('echo "("; cd /w/a; echo ")"; gsd-test'), deps);
  assert.deepStrictEqual(calls.dirs, [path.resolve('/w/a')]);
});

test('ENF-23 handoff: `gsd-test --bench "a(b" | tail` DENIES with PIPE_REASON (a quoted paren must not hide the pipe)', () => {
  const { deps, calls } = scenario();
  const d = runGsdTestCleanTreeGate(input('gsd-test --bench "a(b" | tail'), deps);
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.strictEqual(d.permissionDecisionReason, PIPE_REASON);
  assert.strictEqual(calls.gitStatus, 0);
});

test('ENF-23 handoff: nested quotes `gsd-test --bench "$(echo "(")" | tail` DENIES (uncertain) with ZERO calls', () => {
  const { deps, calls } = scenario();
  const d = runGsdTestCleanTreeGate(input('gsd-test --bench "$(echo "(")" | tail'), deps);
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.strictEqual(calls.resolveTreeRoot + gitCalls(calls), 0);
});

test('ENF-23 handoff e2e: on a real clean repo `gsd-test --bench "a(b" | tail` DENIES with PIPE_REASON', () => {
  const { dir } = makeGitRepo();
  try {
    const r = spawnIn(dir, 'gsd-test --bench "a(b" | tail');
    assert.strictEqual(r.decision, 'deny', r.reason);
    assert.strictEqual(r.reason, PIPE_REASON);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─────────────── M-01 (36-REVIEW): per-subcommand applicability + empty --base ───────────────
//
// v1.8.0 (cmd/gsd-test/main.go run()): `run` copies the WORKING tree (repoRoot + no base ->
// worktree.Prepare runs the repo as-is), so the dirty-tree trap does not apply; its exit code is
// the verdict, so the pipe trap does. `wait <id>` renders the verdict (pipe only). `submit` and
// `status` / `install-agent-hooks` are not ENF-23's concern.

test('ENF-23 M-01: dirty tree + `gsd-test run` ALLOWS (run tests the working tree) with ZERO git calls', () => {
  const { deps, calls } = scenario({ porcelain: DIRTY_ONE });
  const d = runGsdTestCleanTreeGate(input('gsd-test run'), deps);
  assert.strictEqual(d.permissionDecision, 'allow');
  assert.strictEqual(gitCalls(calls), 0);
});

test('ENF-23 M-01: `gsd-test run tests/x.test.cjs | tail` DENIES with PIPE_REASON', () => {
  const { deps } = scenario();
  const d = runGsdTestCleanTreeGate(input('gsd-test run tests/x.test.cjs | tail'), deps);
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.strictEqual(d.permissionDecisionReason, PIPE_REASON);
});

test('ENF-23 M-01: dirty tree + `gsd-test wait 20261005-abc` ALLOWS; piped it DENIES with PIPE_REASON', () => {
  const a = scenario({ porcelain: DIRTY_ONE });
  assert.strictEqual(runGsdTestCleanTreeGate(input('gsd-test wait 20261005-abc'), a.deps).permissionDecision, 'allow');
  assert.strictEqual(gitCalls(a.calls), 0);
  const b = scenario({ porcelain: DIRTY_ONE });
  const d = runGsdTestCleanTreeGate(input('gsd-test wait 20261005-abc | tail'), b.deps);
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.strictEqual(d.permissionDecisionReason, PIPE_REASON);
});

for (const cmd of [
  'gsd-test status 20261005-abc',
  'gsd-test status 20261005-abc | tail',
  'gsd-test install-agent-hooks',
  'gsd-test submit --execute --spec-file s.json | tail',
]) {
  test(`ENF-23 M-01: dirty tree + \`${cmd}\` ALLOWS with ZERO resolve/git calls (not governed by ENF-23)`, () => {
    const { deps, calls } = scenario({ porcelain: DIRTY_ONE });
    const d = runGsdTestCleanTreeGate(input(cmd), deps);
    assert.strictEqual(d.permissionDecision, 'allow');
    assert.strictEqual(calls.resolveTreeRoot + gitCalls(calls), 0);
  });
}

test('ENF-23 M-01: dirty tree + `gsd-test --base= --head HEAD` ALLOWS (an empty base runs the working tree as-is)', () => {
  const { deps } = scenario({ porcelain: DIRTY_ONE });
  assert.strictEqual(runGsdTestCleanTreeGate(input('gsd-test --base= --head HEAD'), deps).permissionDecision, 'allow');
});

test('ENF-23 M-01: `gsd-test --base= | tail` still DENIES with PIPE_REASON', () => {
  const { deps } = scenario({ porcelain: DIRTY_ONE });
  const d = runGsdTestCleanTreeGate(input('gsd-test --base= | tail'), deps);
  assert.strictEqual(d.permissionDecisionReason, PIPE_REASON);
});

test('ENF-23 M-01: dirty tree + `gsd-test --base "$B"` DENIES (an expanded base may be non-empty: fail closed)', () => {
  const { deps } = scenario({ porcelain: DIRTY_ONE });
  assert.strictEqual(runGsdTestCleanTreeGate(input('gsd-test --base "$B"'), deps).permissionDecision, 'deny');
});

// ─────────────── M-02 (36-REVIEW): `cd` options from a non-gsd-core session cwd ───────────────

/** Only /g/core (and below) is a gsd-core checkout; the session cwd is /elsewhere. */
function elsewhere(over = {}) {
  return scenario(Object.assign({
    cwd: '/elsewhere',
    resolveTreeRoot: (dir) => (dir === '/g/core' || dir.startsWith('/g/core/') ? '/g/core' : null),
  }, over));
}

for (const cmd of ['cd -P /g/core && gsd-test | tail', 'cd -- /g/core && gsd-test | tail', 'cd -P -- /g/core && gsd-test | tail']) {
  test(`ENF-23 M-02: \`${cmd}\` from /elsewhere DENIES with PIPE_REASON (the cd target is /g/core)`, () => {
    const { deps } = elsewhere();
    const d = runGsdTestCleanTreeGate(input(cmd), deps);
    assert.strictEqual(d.permissionDecision, 'deny');
    assert.strictEqual(d.permissionDecisionReason, PIPE_REASON);
  });
}

test('ENF-23 M-02: `cd -L /g/core && gsd-test` (dirty) from /elsewhere DENIES with the dirty reason', () => {
  const { deps } = elsewhere({ porcelain: DIRTY_ONE });
  const d = runGsdTestCleanTreeGate(input('cd -L /g/core && gsd-test'), deps);
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /ref-based/);
});

test('ENF-23 M-02: an unknown `cd` option fails closed and the reason names cd options', () => {
  const { deps, calls } = elsewhere();
  const d = runGsdTestCleanTreeGate(input('cd -x /g/core && gsd-test'), deps);
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /option/);
  assert.strictEqual(calls.resolveTreeRoot, 0);
});

// ─────────────── M-03 (36-REVIEW): env -C / sudo -D move the start dir ───────────────

for (const cmd of [
  'env -C /g/core gsd-test | tail',
  'env --chdir=/g/core gsd-test | tail',
  'env --chdir /g/core gsd-test | tail',
  'sudo -D /g/core gsd-test | tail',
  'sudo --chdir=/g/core gsd-test | tail',
]) {
  test(`ENF-23 M-03: \`${cmd}\` from /elsewhere DENIES with PIPE_REASON`, () => {
    const { deps } = elsewhere();
    const d = runGsdTestCleanTreeGate(input(cmd), deps);
    assert.strictEqual(d.permissionDecision, 'deny');
    assert.strictEqual(d.permissionDecisionReason, PIPE_REASON);
  });
}

test('ENF-23 M-03: `env -C /tmp gsd-test` from a gsd-core cwd checks /tmp, not the session tree', () => {
  const { deps, calls } = scenario({ porcelain: DIRTY_ONE, resolveTreeRoot: (dir) => { calls.dirs.push(dir); return null; } });
  const d = runGsdTestCleanTreeGate(input('env -C /tmp gsd-test'), deps);
  assert.strictEqual(d.permissionDecision, 'allow');
  assert.deepStrictEqual(calls.dirs, ['/tmp']);
});

test('ENF-23 M-03: `env -C "$X" gsd-test` fails closed (unresolvable start dir)', () => {
  const { deps, calls } = scenario();
  const d = runGsdTestCleanTreeGate(input('env -C "$X" gsd-test'), deps);
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.strictEqual(calls.resolveTreeRoot, 0);
});

// ─────────────── M-04 (36-REVIEW): eval ───────────────

test("ENF-23 M-04: `eval 'gsd-test --head HEAD | tail -5'` DENIES with PIPE_REASON", () => {
  const { deps } = scenario({ porcelain: DIRTY_ONE });
  const d = runGsdTestCleanTreeGate(input("eval 'gsd-test --head HEAD | tail -5'"), deps);
  assert.strictEqual(d.permissionDecisionReason, PIPE_REASON);
});

test('ENF-23 M-04: dirty tree + `eval gsd-test --head HEAD` DENIES with the dirty reason', () => {
  const { deps } = scenario({ porcelain: DIRTY_ONE });
  const d = runGsdTestCleanTreeGate(input('eval gsd-test --head HEAD'), deps);
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /ref-based/);
});

// ─────────────── M-05 (36-REVIEW): lookups ───────────────

for (const cmd of ['command -v gsd-test && gsd-test --version', 'command -V gsd-test', 'type gsd-test']) {
  test(`ENF-23 M-05: dirty tree + \`${cmd}\` ALLOWS with ZERO resolve/git calls`, () => {
    const { deps, calls } = scenario({ porcelain: DIRTY_ONE });
    const d = runGsdTestCleanTreeGate(input(cmd), deps);
    assert.strictEqual(d.permissionDecision, 'allow');
    assert.strictEqual(calls.resolveTreeRoot + gitCalls(calls), 0);
  });
}

// ─────────────── m-01 (36-REVIEW): a policy deny is never override-escapable via an uncertain neighbour ───────────────

for (const cmd of ['gsd-test | tail; gsd-test $X', 'gsd-test $X; gsd-test | tail', 'gsd-test -source $X; gsd-test | tail']) {
  test(`ENF-23 m-01: override set + \`${cmd}\` still DENIES with PIPE_REASON and writes no receipt`, () => {
    const { deps, calls } = scenario({ override: true });
    const d = runGsdTestCleanTreeGate(input(cmd), deps);
    assert.strictEqual(d.permissionDecision, 'deny');
    assert.strictEqual(d.permissionDecisionReason, PIPE_REASON);
    assert.strictEqual(calls.writeReceipt, 0);
  });
}

test('ENF-23 m-01: override set + dirty `gsd-test $X; gsd-test --head HEAD` DENIES with the dirty reason, no receipt', () => {
  const { deps, calls } = scenario({ override: true, porcelain: DIRTY_ONE });
  const d = runGsdTestCleanTreeGate(input('gsd-test $X; gsd-test --head HEAD'), deps);
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /ref-based/);
  assert.strictEqual(calls.writeReceipt, 0);
});

test('ENF-23 m-01: without a policy deny, an uncertain entry beside a clean dispatch still DENIES (thrown)', () => {
  const { deps } = scenario();
  const d = runGsdTestCleanTreeGate(input('gsd-test $X; gsd-test --head HEAD'), deps);
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /cannot attribute/);
});

test('ENF-23 m-02: `SHA=$(git rev-parse HEAD) gsd-test --head HEAD | tail` DENIES with PIPE_REASON', () => {
  const { deps } = scenario();
  const d = runGsdTestCleanTreeGate(input('SHA=$(git rev-parse HEAD) gsd-test --head HEAD | tail'), deps);
  assert.strictEqual(d.permissionDecisionReason, PIPE_REASON);
});

// ─────────────── m-06 (36-REVIEW): one shared deadline per gate call; refs cached ───────────────

/** A fake clock every git seam advances by `cost` ms; records the timeout each call was given. */
function clocked(over = {}, cost = 5000) {
  let t = 0;
  const timeouts = [];
  const sc = scenario(Object.assign({}, over, { now: () => t }));
  const status = sc.deps.gitStatus;
  const ref = sc.deps.resolveRef;
  sc.deps.gitStatus = (root, timeoutMs) => { timeouts.push(timeoutMs); t += cost; return status(root); };
  sc.deps.resolveRef = (root, r, timeoutMs) => { timeouts.push(timeoutMs); t += cost; return ref(root, r); };
  return Object.assign(sc, { timeouts, elapsed: () => t });
}

test('m-06: every git call is given at most GIT_TIMEOUT_MS and at most the remaining budget', () => {
  const c = clocked({ porcelain: DIRTY_ONE }, 4000);
  runGsdTestCleanTreeGate(input('gsd-test --head origin/next'), c.deps);
  assert.deepStrictEqual(c.timeouts, [5000, 5000, 5000]);
  assert.strictEqual(cleanTree.GATE_BUDGET_MS, 15000);
});

test('m-06: `--head a; --head b; --head c` in ONE dirty tree stops at the budget and DENIES (thrown), never overruns', () => {
  const c = clocked({ porcelain: DIRTY_ONE, refs: { a: 'c'.repeat(40), b: 'd'.repeat(40), c: 'e'.repeat(40) } });
  const d = runGsdTestCleanTreeGate(input('gsd-test --head a; gsd-test --head b; gsd-test --head c'), c.deps);
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /budget/);
  assert.ok(c.elapsed() <= cleanTree.GATE_BUDGET_MS, `spent ${c.elapsed()} ms`);
  for (const ms of c.timeouts) assert.ok(ms > 0 && ms <= 5000);
});

test('m-06: the same literal --head twice resolves it once (cached per root and ref)', () => {
  const { deps, calls } = scenario({ porcelain: DIRTY_ONE });
  runGsdTestCleanTreeGate(input('gsd-test --head origin/next; gsd-test --head origin/next'), deps);
  assert.deepStrictEqual(calls.refs, ['HEAD', 'origin/next']);
});

// ─────────────── m-07 (36-REVIEW): the verdict log is isolated in a temp dir ───────────────

test('m-07: this file points GSD_CONTRIB_LOG_DIR at its own temp dir, and the gate verdict lands there', () => {
  const dir = process.env.GSD_CONTRIB_LOG_DIR || '';
  assert.ok(path.basename(dir).startsWith('gtest-ct-vlog-'), 'GSD_CONTRIB_LOG_DIR is this file\'s mkdtemp dir, not ~/.gsd-contrib: ' + dir);
  runGsdTestCleanTreeGate(input(PIPED), scenario().deps);
  assert.ok(fs.existsSync(path.join(dir, 'tool-log.jsonl')), 'the verdict was recorded in the temp dir');
});

// ───────────────────────── 36-03a prohibition lock: the gate never mutates the repo ─────────────────────────

/**
 * Run `fn` with child_process.execFileSync/spawnSync/execSync/spawn/execFile wrapped so every git
 * argv is recorded, against a FRESH copy of the gate module (its destructured child_process
 * bindings are captured at require time). Everything is restored afterwards.
 */
function withGitSpy(fn) {
  const cp = require('node:child_process');
  const names = ['execFileSync', 'spawnSync', 'execSync', 'spawn', 'execFile'];
  const orig = {};
  const seen = [];
  const gatePath = require.resolve('./gsd-test-clean-tree.cjs');
  const cached = require.cache[gatePath];
  for (const n of names) {
    orig[n] = cp[n];
    cp[n] = function (...a) {
      if (n === 'execSync') seen.push({ via: n, file: 'sh', args: [String(a[0])] });
      else seen.push({ via: n, file: a[0], args: Array.isArray(a[1]) ? a[1] : [] });
      return orig[n].apply(this, a);
    };
  }
  delete require.cache[gatePath];
  try {
    const fresh = require('./gsd-test-clean-tree.cjs');
    fn(fresh);
  } finally {
    for (const n of names) cp[n] = orig[n];
    if (cached) require.cache[gatePath] = cached;
    else delete require.cache[gatePath];
  }
  return seen;
}

/** Real-git deps: only the tree root is injected, so gitStatus/resolveRef are the REAL defaults. */
function realGitDeps(dir) {
  return {
    cwd: dir,
    env: process.env,
    resolveTreeRoot: () => dir,
    overrideImpl: { checkOverride: () => ({ override: false }), writeReceipt: () => {} },
  };
}

test('ENF-23 36-03a lock: every real git call is read-only (status/rev-parse) and every status carries --no-optional-locks', () => {
  const { dir } = makeGitRepo();
  try {
    fs.writeFileSync(path.join(dir, 'tracked.txt'), 'dirty\n');
    const seen = withGitSpy((fresh) => {
      // dirty + a named-ref head (main): exercises both the status and the ref-resolution defaults
      fresh.runGsdTestCleanTreeGate(input('gsd-test -base next -head main'), realGitDeps(dir));
      fresh.runGsdTestCleanTreeGate(input('gsd-test'), realGitDeps(dir));
    });
    const gitCallsSeen = seen.filter((c) => path.basename(String(c.file)) === 'git');
    assert.ok(gitCallsSeen.length >= 2, 'the spy must have observed real git calls: ' + JSON.stringify(seen));
    assert.strictEqual(seen.filter((c) => c.via === 'execSync').length, 0, 'no shell string is ever run');
    for (const c of gitCallsSeen) {
      const sub = c.args.find((a) => !a.startsWith('-'));
      assert.ok(['status', 'rev-parse'].includes(sub), 'only read-only subcommands: ' + JSON.stringify(c.args));
      if (sub === 'status') {
        assert.ok(c.args.includes('--no-optional-locks'), 'status must not take the optional index lock: ' + JSON.stringify(c.args));
        assert.ok(c.args.indexOf('--no-optional-locks') < c.args.indexOf('status'), '--no-optional-locks is a global option, before the subcommand');
      }
    }
    assert.ok(gitCallsSeen.some((c) => c.args.includes('status')), 'a status call was made');
    assert.ok(gitCallsSeen.some((c) => c.args.includes('rev-parse')), 'a rev-parse call was made');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Byte snapshot of the repo's index, HEAD, packed-refs and every file under .git/refs. */
function repoSnapshot(dir) {
  const gitDir = path.join(dir, '.git');
  const snap = {};
  const take = (rel) => {
    const f = path.join(gitDir, rel);
    snap[rel] = fs.existsSync(f) ? fs.readFileSync(f).toString('hex') : null;
  };
  for (const rel of ['index', 'HEAD', 'packed-refs']) take(rel);
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(gitDir, rel), { withFileTypes: true })) {
      const r = path.join(rel, e.name);
      if (e.isDirectory()) walk(r);
      else take(r);
    }
  };
  walk('refs');
  return snap;
}

test('ENF-23 36-03a lock e2e: .git/index and refs are byte-unchanged after a dirty-tree DENY and a clean ALLOW', () => {
  const { dir } = makeGitRepo();
  try {
    // Make the index STAT-STALE but content-clean (same bytes, newer mtime): a plain `git status`
    // would then refresh and REWRITE .git/index, while `--no-optional-locks` must not.
    const stale = path.join(dir, 'tracked.txt');
    const future = new Date(Date.now() + 60000);
    fs.utimesSync(stale, future, future);
    // clean ALLOW
    const before = repoSnapshot(dir);
    assert.ok(before.index, 'fixture has an index');
    assert.strictEqual(spawnIn(dir, 'gsd-test -base next -head HEAD').decision, 'allow');
    assert.deepStrictEqual(repoSnapshot(dir), before, 'a clean allow must not touch index or refs');
    // dirty DENY
    const other = path.join(dir, 'scripts', 'issue-dedupe.cjs');
    fs.utimesSync(other, future, future); // a second stat-stale clean entry
    fs.writeFileSync(path.join(dir, 'tracked.txt'), 'two\n');
    const before2 = repoSnapshot(dir);
    const r = spawnIn(dir, 'gsd-test -base next -head HEAD');
    assert.strictEqual(r.decision, 'deny', r.reason);
    assert.deepStrictEqual(repoSnapshot(dir), before2, 'a dirty deny must not touch index or refs');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
