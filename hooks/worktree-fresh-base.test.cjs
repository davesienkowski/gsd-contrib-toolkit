'use strict';

/**
 * node:test for hooks/worktree-fresh-base.cjs — the ENF-25 worktree fresh-base gate.
 *
 * 37-01 tracer slice: a `git worktree add ... next` from a gsd-core-shaped clone whose origin
 * moved ahead triggers the gate's OWN bounded fetch and a proven-ancestor compare-and-swap
 * fast-forward of local `next`, then allows.
 *
 *   • unit rows drive `runWorktreeFreshBaseGate(stdin, deps)` with every impure seam injected and
 *     counted, so RES-01 (no worktree add -> zero resolve/fetch/git) and "no fetch on a non-trunk
 *     base" are asserted by COUNT;
 *   • e2e rows spawn the REAL entrypoint through proof-harness spawnHook inside a REAL fixture:
 *     a bare `origin.git` (default branch `next`), clone A (the gsd-core-shaped checkout, parked
 *     on `work`) and clone B (pushes one new commit to origin/next). Setup never fetches in A: the
 *     gate's own fetch is what must move A's origin/next. Temp dirs only, global/system git
 *     config disabled, never a real checkout.
 */

// Real-git hygiene (hard rule): these would redirect both the setup git calls and the spawned
// hook's git, or let the user's global config (hooks, signing) leak into the temp repos. A stray
// GSD_CONTRIB_OVERRIDE would flip a thrown-path row to allow.
for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_CEILING_DIRECTORIES', 'GIT_COMMON_DIR', 'GSD_CONTRIB_OVERRIDE']) {
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

// runGate records every verdict (OBS-02). Point the log at a per-file temp dir so this suite never
// appends synthetic verdicts to the real verdict log; spawned hooks inherit it through process.env.
process.env.GSD_CONTRIB_LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wtfb-vlog-'));
process.on('exit', () => fs.rmSync(process.env.GSD_CONTRIB_LOG_DIR, { recursive: true, force: true }));

const { runWorktreeFreshBaseGate } = require('./worktree-fresh-base.cjs');
const { FailClosed } = require('./lib/failclosed.cjs');
const { hasSentinel } = require('./lib/resolve.cjs');
const { spawnHook } = require('./lib/proof-harness.cjs');

const HOOK = path.join(__dirname, 'worktree-fresh-base.cjs');
const FAKE_CWD = path.join(path.sep, 'fake', 'gsd-core');
const SHA_LOCAL = 'a'.repeat(40);
const SHA_REMOTE = 'b'.repeat(40);

function input(command) {
  return JSON.stringify({ tool_name: 'Bash', tool_input: { command } });
}

/**
 * Injected deps + a counter on every impure seam. The DEFAULT world: a gsd-core tree whose local
 * `next` (SHA_LOCAL) is a strict ancestor of `origin/next` (SHA_REMOTE), held by no worktree, and
 * a CAS that succeeds. Each row overrides only what it is about.
 */
function scenario(over = {}) {
  const calls = {
    resolveTreeRoot: 0,
    dirs: [],
    fetchOrigin: 0,
    fetchDirs: [],
    revParse: 0,
    isAncestor: 0,
    worktreesHolding: 0,
    casUpdateRef: 0,
    casArgs: [],
  };
  const refs = Object.assign(
    { 'refs/remotes/origin/next': SHA_REMOTE, 'refs/heads/next': SHA_LOCAL },
    over.refs || {}
  );
  const base = {
    cwd: FAKE_CWD,
    env: {},
    homedir: path.join(path.sep, 'h'),
    resolveTreeRoot: (dir) => {
      calls.resolveTreeRoot += 1;
      calls.dirs.push(dir);
      return FAKE_CWD;
    },
    fetchOrigin: (dir) => {
      calls.fetchOrigin += 1;
      calls.fetchDirs.push(dir);
    },
    revParse: (dir, ref) => {
      calls.revParse += 1;
      return Object.prototype.hasOwnProperty.call(refs, ref) ? refs[ref] : null;
    },
    isAncestor: () => {
      calls.isAncestor += 1;
      return over.ancestor !== false;
    },
    worktreesHolding: () => {
      calls.worktreesHolding += 1;
      return over.held || [];
    },
    casUpdateRef: (...args) => {
      calls.casUpdateRef += 1;
      calls.casArgs.push(args);
      return over.casOk !== false;
    },
    overrideImpl: {
      checkOverride: () => ({ override: false }),
      writeReceipt: () => {},
    },
  };
  const rest = Object.assign({}, over);
  for (const k of ['refs', 'ancestor', 'held', 'casOk']) delete rest[k];
  return { deps: Object.assign(base, rest), calls };
}

// ───────────────────────── real-git fixture ─────────────────────────

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

function refOf(dir, ref) {
  return git(dir, 'rev-parse', '--verify', '--quiet', ref).trim();
}

/**
 * A bare origin (default branch `next`), clone A (the checkout under test, carrying the gsd-core
 * sentinel layout when `sentinel`, parked on `work` so `next` is not checked out) and clone B
 * (the "upstream moved" writer). A's refs/remotes/origin/next is set by A's own push; setup never
 * fetches in A afterwards.
 */
function makeFixture({ sentinel = true, park = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wtfb-fx-'));
  const origin = path.join(root, 'origin.git');
  const A = path.join(root, 'A');
  const B = path.join(root, 'B');
  git(root, '-c', 'init.defaultBranch=next', 'init', '-q', '--bare', origin);
  git(root, 'clone', '-q', origin, A);
  git(A, 'symbolic-ref', 'HEAD', 'refs/heads/next');
  if (sentinel) {
    fs.mkdirSync(path.join(A, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(A, 'gsd-core', 'bin', 'lib'), { recursive: true });
    fs.writeFileSync(path.join(A, 'scripts', 'issue-dedupe.cjs'), '');
    fs.writeFileSync(path.join(A, 'gsd-core', 'bin', 'lib', '.keep'), '');
  }
  fs.writeFileSync(path.join(A, 'tracked.txt'), 'one\n');
  const initial = commitAll(A, 'init');
  git(A, 'push', '-q', 'origin', 'next');
  if (park) git(A, 'switch', '-q', '-c', 'work');
  git(root, 'clone', '-q', origin, B);

  let n = 0;
  function advanceOrigin() {
    n += 1;
    fs.writeFileSync(path.join(B, 'tracked.txt'), 'upstream ' + n + '\n');
    const sha = commitAll(B, 'upstream ' + n);
    git(B, 'push', '-q', 'origin', 'next');
    return sha;
  }
  return {
    root,
    origin,
    A,
    B,
    initial,
    advanceOrigin,
    dispose: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function spawnIn(dir, command) {
  const r = spawnHook(HOOK, { stdin: input(command), cwd: dir });
  assert.strictEqual(r.conclusive, true, r.reason + ' ' + r.rawStderr);
  const emitted = JSON.parse(r.rawStdout).hookSpecificOutput;
  return { decision: r.decision, reason: emitted.permissionDecisionReason || '' };
}

// ───────────────────────── gate (injected deps) ─────────────────────────

test('ENF-25 tracer: a trunk cut of a stale, unheld local next fetches once and CAS fast-forwards it', () => {
  const { deps, calls } = scenario();
  const d = runWorktreeFreshBaseGate(input('git worktree add -b feat p next'), deps);
  assert.strictEqual(d.permissionDecision, 'allow');
  assert.strictEqual(calls.fetchOrigin, 1);
  assert.strictEqual(calls.casUpdateRef, 1);
  assert.deepStrictEqual(calls.casArgs[0], [FAKE_CWD, 'refs/heads/next', SHA_REMOTE, SHA_LOCAL]);
});

test('ENF-25 tracer: RES-01 `git status` allows with ZERO resolve, fetch and git calls', () => {
  const { deps, calls } = scenario();
  const d = runWorktreeFreshBaseGate(input('git status'), deps);
  assert.strictEqual(d.permissionDecision, 'allow');
  assert.strictEqual(calls.resolveTreeRoot, 0);
  assert.strictEqual(calls.fetchOrigin, 0);
  assert.strictEqual(calls.revParse, 0);
  assert.strictEqual(calls.casUpdateRef, 0);
});

test('ENF-25 tracer: a non-trunk base (`feature`) allows with ZERO fetch and ZERO resolve', () => {
  const { deps, calls } = scenario();
  const d = runWorktreeFreshBaseGate(input('git worktree add -b x p feature'), deps);
  assert.strictEqual(d.permissionDecision, 'allow');
  assert.strictEqual(calls.fetchOrigin, 0);
  assert.strictEqual(calls.resolveTreeRoot, 0);
});

test('ENF-25 tracer: a target dir that is not a gsd-core checkout allows with ZERO fetch', () => {
  const { deps, calls } = scenario({
    resolveTreeRoot: () => null,
  });
  const d = runWorktreeFreshBaseGate(input('git worktree add -b feat p next'), deps);
  assert.strictEqual(d.permissionDecision, 'allow');
  assert.strictEqual(calls.fetchOrigin, 0);
});

test('ENF-25 tracer: a `-C` target dir is resolved against the start dir before the root lookup', () => {
  const { deps, calls } = scenario();
  runWorktreeFreshBaseGate(input('git -C sub worktree add p next'), deps);
  assert.deepStrictEqual(calls.dirs, [path.join(FAKE_CWD, 'sub')]);
});

test('ENF-25 tracer: base `origin/next` fetches and allows without touching local next', () => {
  const { deps, calls } = scenario();
  const d = runWorktreeFreshBaseGate(input('git worktree add -b feat p origin/next'), deps);
  assert.strictEqual(d.permissionDecision, 'allow');
  assert.strictEqual(calls.fetchOrigin, 1);
  assert.strictEqual(calls.casUpdateRef, 0);
});

test('ENF-25 tracer: local next already equal to origin/next allows with no CAS', () => {
  const { deps, calls } = scenario({ refs: { 'refs/heads/next': SHA_REMOTE } });
  const d = runWorktreeFreshBaseGate(input('git worktree add p next'), deps);
  assert.strictEqual(d.permissionDecision, 'allow');
  assert.strictEqual(calls.casUpdateRef, 0);
});

test('ENF-25 tracer: a diverged next (not an ancestor) is NEVER moved', () => {
  const { deps, calls } = scenario({ ancestor: false });
  runWorktreeFreshBaseGate(input('git worktree add p next'), deps);
  assert.strictEqual(calls.casUpdateRef, 0);
});

test('ENF-25 tracer: a next held by a worktree is NEVER moved', () => {
  const { deps, calls } = scenario({ held: ['/somewhere'] });
  runWorktreeFreshBaseGate(input('git worktree add p next'), deps);
  assert.strictEqual(calls.casUpdateRef, 0);
});

test('ENF-25 tracer: a failed CAS (ref moved under us) fails closed -> deny', () => {
  const { deps } = scenario({ casOk: false });
  const d = runWorktreeFreshBaseGate(input('git worktree add p next'), deps);
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /ENF-25/);
});

test('ENF-25 tracer: a missing origin/next after the fetch fails closed -> deny', () => {
  const { deps, calls } = scenario({ refs: { 'refs/remotes/origin/next': null } });
  const d = runWorktreeFreshBaseGate(input('git worktree add p next'), deps);
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.strictEqual(calls.casUpdateRef, 0);
});

test('ENF-25 tracer: a thrown FailClosed from a seam denies (runGate ladder)', () => {
  const { deps } = scenario({
    fetchOrigin: () => {
      throw new FailClosed('ENF-25 test seam failure');
    },
  });
  const d = runWorktreeFreshBaseGate(input('git worktree add p next'), deps);
  assert.strictEqual(d.permissionDecision, 'deny');
});

// ───────────────────────── e2e (spawned hook, real fixture) ─────────────────────────

test('ENF-25 tracer e2e: a stale, unheld next is fetched and fast-forwarded before `git worktree add ... next`', () => {
  const fx = makeFixture();
  try {
    const tip = fx.advanceOrigin();
    assert.strictEqual(refOf(fx.A, 'refs/heads/next'), fx.initial, 'precondition: A next is stale');
    assert.strictEqual(refOf(fx.A, 'refs/remotes/origin/next'), fx.initial, 'precondition: A origin/next is stale');
    const r = spawnIn(fx.A, 'git worktree add -b feat ' + path.join(fx.root, 'wt') + ' next');
    assert.strictEqual(r.decision, 'allow', r.reason);
    assert.strictEqual(refOf(fx.A, 'refs/heads/next'), tip, 'local next must be fast-forwarded to the origin tip');
    assert.strictEqual(refOf(fx.A, 'refs/remotes/origin/next'), tip, 'the gate fetch must advance origin/next');
    const gs = git(fx.A, 'reflog', 'show', '-1', '--format=%gs', 'refs/heads/next').trim();
    assert.match(gs, /ENF-25/, 'the CAS move is recorded in the reflog');
    assert.strictEqual(git(fx.A, 'symbolic-ref', 'HEAD').trim(), 'refs/heads/work', 'A stays on work');
  } finally {
    fx.dispose();
  }
});

test('ENF-25 tracer e2e: `git status` in A allows and does not fetch', () => {
  const fx = makeFixture();
  try {
    fx.advanceOrigin();
    const r = spawnIn(fx.A, 'git status');
    assert.strictEqual(r.decision, 'allow', r.reason);
    assert.strictEqual(refOf(fx.A, 'refs/remotes/origin/next'), fx.initial);
    assert.strictEqual(refOf(fx.A, 'refs/heads/next'), fx.initial);
  } finally {
    fx.dispose();
  }
});

test('ENF-25 tracer e2e: a non-trunk base (`feature`) allows and does not fetch', () => {
  const fx = makeFixture();
  try {
    fx.advanceOrigin();
    const r = spawnIn(fx.A, 'git worktree add -b x ' + path.join(fx.root, 'wt') + ' feature');
    assert.strictEqual(r.decision, 'allow', r.reason);
    assert.strictEqual(refOf(fx.A, 'refs/remotes/origin/next'), fx.initial);
    assert.strictEqual(refOf(fx.A, 'refs/heads/next'), fx.initial);
  } finally {
    fx.dispose();
  }
});

test('ENF-25 tracer e2e: a plain clone with no gsd-core sentinel allows a trunk cut and does not fetch', () => {
  const fx = makeFixture({ sentinel: false });
  try {
    fx.advanceOrigin();
    // The clone and every ancestor up to / must lack the sentinel, or this row proves nothing.
    for (let d = fx.A; ; d = path.dirname(d)) {
      assert.strictEqual(hasSentinel(d), false, 'unexpected gsd-core sentinel at ' + d);
      if (path.dirname(d) === d) break;
    }
    const r = spawnIn(fx.A, 'git worktree add -b feat ' + path.join(fx.root, 'wt') + ' next');
    assert.strictEqual(r.decision, 'allow', r.reason);
    assert.strictEqual(refOf(fx.A, 'refs/remotes/origin/next'), fx.initial);
    assert.strictEqual(refOf(fx.A, 'refs/heads/next'), fx.initial);
  } finally {
    fx.dispose();
  }
});

test('ENF-25 tracer e2e: an inherited GIT_DIR cannot aim the fetch or the CAS at another repo', () => {
  const fx = makeFixture();
  const saved = process.env.GIT_DIR;
  try {
    const tip = fx.advanceOrigin();
    const bNextBefore = refOf(fx.B, 'refs/heads/next');
    process.env.GIT_DIR = path.join(fx.B, '.git');
    let r;
    try {
      r = spawnIn(fx.A, 'git worktree add -b feat ' + path.join(fx.root, 'wt') + ' next');
    } finally {
      if (saved === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = saved;
    }
    assert.strictEqual(r.decision, 'allow', r.reason);
    assert.strictEqual(refOf(fx.A, 'refs/heads/next'), tip, 'the gate acted on A, the target repo');
    assert.strictEqual(refOf(fx.B, 'refs/heads/next'), bNextBefore, 'B was not touched');
  } finally {
    fx.dispose();
  }
});

test('ENF-25 tracer e2e: a stale next CHECKED OUT in A is never moved (real worktree-list parse)', () => {
  const fx = makeFixture({ park: false });
  try {
    const tip = fx.advanceOrigin();
    assert.strictEqual(git(fx.A, 'symbolic-ref', 'HEAD').trim(), 'refs/heads/next', 'precondition: A holds next');
    // The decision is 37-03's (held deny); this row locks only that the held check reads real
    // `worktree list --porcelain` output and blocks the CAS.
    spawnIn(fx.A, 'git worktree add -b feat ' + path.join(fx.root, 'wt') + ' next');
    assert.strictEqual(refOf(fx.A, 'refs/remotes/origin/next'), tip, 'the fetch ran');
    assert.strictEqual(refOf(fx.A, 'refs/heads/next'), fx.initial, 'a checked-out next must not move');
  } finally {
    fx.dispose();
  }
});
