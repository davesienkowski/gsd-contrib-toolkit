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
    currentBranch: 0,
    order: [],
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
      calls.order.push('fetchOrigin');
    },
    currentBranch: () => {
      calls.currentBranch += 1;
      calls.order.push('currentBranch');
      return Object.prototype.hasOwnProperty.call(over, 'branch') ? over.branch : 'work';
    },
    revParse: (dir, ref) => {
      calls.revParse += 1;
      return Object.prototype.hasOwnProperty.call(refs, ref) ? refs[ref] : null;
    },
    // `ancestor` may be a boolean (direction-blind, the 37-01 rows) or a function (a, b) => bool.
    isAncestor: (dir, a, b) => {
      calls.isAncestor += 1;
      if (typeof over.ancestor === 'function') return over.ancestor(a, b);
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
  for (const k of ['refs', 'ancestor', 'held', 'casOk', 'branch']) delete rest[k];
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

// ───────────────────────── 37-02 targeting (injected deps) ─────────────────────────
//
// The target repo is the start dir (shared walk: `cd`, `env -C`, `sudo -D`, statically expanded)
// with each git `-C` applied in order, each statically expanded (`~`, leading `$HOME`) and resolved
// against the running dir. An unexpandable start dir or `-C` fails closed BEFORE any resolve,
// fetch or git call; `-C ""` is a no-op as in git.

test('ENF-25 targeting: `cd "$X" && git worktree add p next` (X unset) denies with ZERO resolve and fetch', () => {
  const { deps, calls } = scenario({ env: {} });
  const d = runWorktreeFreshBaseGate(input('cd "$X" && git worktree add p next'), deps);
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /ENF-25/);
  assert.strictEqual(calls.resolveTreeRoot, 0);
  assert.strictEqual(calls.fetchOrigin, 0);
});

test('ENF-25 targeting: `env -C "$X" git worktree add p next` (wrapper chdir unresolvable) denies with ZERO resolve', () => {
  const { deps, calls } = scenario({ env: {} });
  const d = runWorktreeFreshBaseGate(input('env -C "$X" git worktree add p next'), deps);
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.strictEqual(calls.resolveTreeRoot, 0);
  assert.strictEqual(calls.fetchOrigin, 0);
});

test('ENF-25 targeting: `git -C "$Y" worktree add p next` denies naming -C, with ZERO resolve and fetch', () => {
  const { deps, calls } = scenario({ env: {} });
  const d = runWorktreeFreshBaseGate(input('git -C "$Y" worktree add p next'), deps);
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /ENF-25/);
  assert.match(d.permissionDecisionReason, /-C/);
  assert.strictEqual(calls.resolveTreeRoot, 0);
  assert.strictEqual(calls.fetchOrigin, 0);
});

test('ENF-25 targeting: `git -C ~/r worktree add p next` with homedir /h resolves /h/r', () => {
  const { deps, calls } = scenario({ env: {}, homedir: '/h' });
  runWorktreeFreshBaseGate(input('git -C ~/r worktree add p next'), deps);
  assert.deepStrictEqual(calls.dirs, ['/h/r']);
});

test('ENF-25 targeting: `git -C "$HOME/r" worktree add p next` expands HOME from the env', () => {
  const { deps, calls } = scenario({ env: { HOME: '/h2' }, homedir: '/h' });
  runWorktreeFreshBaseGate(input('git -C "$HOME/r" worktree add p next'), deps);
  assert.deepStrictEqual(calls.dirs, ['/h2/r']);
});

test('ENF-25 targeting: `git -C "" worktree add p next` from /w targets /w (an empty -C is a no-op)', () => {
  const { deps, calls } = scenario({ cwd: '/w' });
  runWorktreeFreshBaseGate(input('git -C "" worktree add p next'), deps);
  assert.deepStrictEqual(calls.dirs, ['/w']);
});

test('ENF-25 targeting: `cd /w2 && git -C r worktree add p next` resolves /w2/r', () => {
  const { deps, calls } = scenario();
  runWorktreeFreshBaseGate(input('cd /w2 && git -C r worktree add p next'), deps);
  assert.deepStrictEqual(calls.dirs, ['/w2/r']);
});

test('ENF-25 targeting: wrapped forms target the -C dir (`FOO=1 git -C /a`, `sudo git -C /a`, `timeout 5 git -C rel`)', () => {
  for (const [cmd, want] of [
    ['FOO=1 git -C /a worktree add p next', '/a'],
    ['sudo git -C /a worktree add p next', '/a'],
    ['timeout 5 git -C rel worktree add p next', path.join(FAKE_CWD, 'rel')],
    ['sudo -D /s git worktree add p next', '/s'],
    ['bash -c "cd /b && git worktree add p next"', '/b'],
  ]) {
    const { deps, calls } = scenario();
    runWorktreeFreshBaseGate(input(cmd), deps);
    assert.deepStrictEqual(calls.dirs, [want], cmd);
  }
});

test('ENF-25 targeting: `git worktree add "x` denies naming ENF-25, path-free, with ZERO resolve', () => {
  const { deps, calls } = scenario();
  const d = runWorktreeFreshBaseGate(input('git worktree add "x'), deps);
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /ENF-25/);
  assert.ok(!d.permissionDecisionReason.includes('/'), 'no path in the reason: ' + d.permissionDecisionReason);
  assert.strictEqual(calls.resolveTreeRoot, 0);
  assert.strictEqual(calls.fetchOrigin, 0);
});

test('ENF-25 targeting: every uncertain cut denies with the SAME constant reason (no detector detail, no path)', () => {
  const reasons = new Set();
  for (const cmd of [
    'git worktree add "x',
    'git --git-dir=/x/y worktree add p next',
    'GIT_DIR=/x/y git worktree add p next',
    'git worktree add p $B',
  ]) {
    const { deps, calls } = scenario();
    const d = runWorktreeFreshBaseGate(input(cmd), deps);
    assert.strictEqual(d.permissionDecision, 'deny', cmd);
    assert.ok(!d.permissionDecisionReason.includes('/'), cmd + ': ' + d.permissionDecisionReason);
    assert.strictEqual(calls.resolveTreeRoot, 0, cmd);
    reasons.add(d.permissionDecisionReason);
  }
  assert.strictEqual(reasons.size, 1, 'one constant reason, got ' + JSON.stringify([...reasons]));
});

test('ENF-25 targeting: the uncertain deny is THROWN (override-escapable) and writes exactly one receipt', () => {
  const receipts = [];
  const { deps } = scenario({
    overrideImpl: {
      checkOverride: () => ({ override: true, reason: 'test override' }),
      writeReceipt: (_root, rec) => receipts.push(rec),
    },
  });
  const d = runWorktreeFreshBaseGate(input('git worktree add "x'), deps);
  assert.strictEqual(d.permissionDecision, 'allow');
  assert.strictEqual(receipts.length, 1);
  assert.strictEqual(receipts[0].action, 'worktree-fresh-base');
});

test('ENF-25 targeting: two trunk cuts of the same root fetch ONCE (per-root cache)', () => {
  const { deps, calls } = scenario();
  const d = runWorktreeFreshBaseGate(input('git worktree add -b a p next; git worktree add -b b q next'), deps);
  assert.strictEqual(d.permissionDecision, 'allow');
  assert.strictEqual(calls.fetchOrigin, 1);
});

// ───────────────────────── 37-02 targeting e2e (spawned hook, real fixture) ─────────────────────────

function plainCwd() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wtfb-cwd-'));
  for (let x = d; ; x = path.dirname(x)) {
    assert.strictEqual(hasSentinel(x), false, 'unexpected gsd-core sentinel at ' + x);
    if (path.dirname(x) === x) break;
  }
  return d;
}

for (const form of ['cd', '-C', 'env-prefixed -C']) {
  test(`ENF-25 targeting e2e: from a non-gsd-core cwd, the ${form} form fast-forwards A's stale next`, () => {
    const fx = makeFixture();
    const cwd = plainCwd();
    try {
      const tip = fx.advanceOrigin();
      const wt = path.join(fx.root, 'wt');
      const cmd = {
        cd: `cd ${fx.A} && git worktree add -b f ${wt} next`,
        '-C': `git -C ${fx.A} worktree add -b f ${wt} next`,
        'env-prefixed -C': `FOO=1 git -C ${fx.A} worktree add -b f ${wt} next`,
      }[form];
      const r = spawnIn(cwd, cmd);
      assert.strictEqual(r.decision, 'allow', r.reason);
      assert.strictEqual(refOf(fx.A, 'refs/heads/next'), tip, 'A next fast-forwarded to the origin tip');
    } finally {
      fx.dispose();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
}

test('ENF-25 targeting e2e: `git worktree add "x` from A denies naming ENF-25 and does not fetch', () => {
  const fx = makeFixture();
  try {
    fx.advanceOrigin();
    const r = spawnIn(fx.A, 'git worktree add "x');
    assert.strictEqual(r.decision, 'deny');
    assert.match(r.reason, /ENF-25/);
    assert.strictEqual(refOf(fx.A, 'refs/remotes/origin/next'), fx.initial);
  } finally {
    fx.dispose();
  }
});

test('ENF-25 targeting e2e: a heredoc body mentioning `git worktree add p next` allows and does not fetch', () => {
  const fx = makeFixture();
  try {
    fx.advanceOrigin();
    const r = spawnIn(fx.A, "cat <<'EOF' > notes.md\ngit worktree add p next\nEOF");
    assert.strictEqual(r.decision, 'allow', r.reason);
    assert.strictEqual(refOf(fx.A, 'refs/remotes/origin/next'), fx.initial, 'origin/next unchanged');
  } finally {
    fx.dispose();
  }
});

// ───────────────────────── 37-03 WTREE-03: stale next that cannot be fast-forwarded ─────────────────────────
//
// After the gate's fetch: local next equal -> allow; a strict ancestor held by a worktree -> POLICY
// deny with `git -C <holder> merge --ff-only origin/next`; neither an ancestor of the other
// (diverged) -> POLICY deny naming the divergence; origin/next an ancestor of local next (AHEAD,
// flagged planner refinement, CTK-ADR-0009) -> allow, nothing moved. A HEAD base is the trunk only
// when the target tree's current branch is `next` (read BEFORE any fetch). Policy denies are
// RETURNED, so GSD_CONTRIB_OVERRIDE cannot flip them and no receipt is written.

/** Text a deny reason must never suggest (T-37-14). */
const DESTRUCTIVE = /reset|--force|branch -f|update-ref|push -f/;
const L10 = SHA_LOCAL.slice(0, 10);
const R10 = SHA_REMOTE.slice(0, 10);
/** isAncestor answers for the AHEAD world: origin/next is an ancestor of local next, not the reverse. */
const AHEAD = (a, b) => a === SHA_REMOTE && b === SHA_LOCAL;
/** Neither is an ancestor of the other. */
const DIVERGED = () => false;

/** An override seam that says YES, with a counted writeReceipt. */
function yesOverride() {
  const receipts = [];
  return {
    receipts,
    overrideImpl: {
      checkOverride: () => ({ override: true, reason: 'test override' }),
      writeReceipt: (_root, rec) => receipts.push(rec),
    },
  };
}

test('ENF-25 WTREE-03: a stale next held by /w/main denies with the exact merge --ff-only fix, stash note and origin/next alternative', () => {
  const { deps, calls } = scenario({ held: ['/w/main'] });
  const d = runWorktreeFreshBaseGate(input('git worktree add -b feat p next'), deps);
  assert.strictEqual(d.permissionDecision, 'deny');
  const why = d.permissionDecisionReason;
  assert.match(why, /ENF-25/);
  assert.ok(why.includes('git -C /w/main merge --ff-only origin/next'), why);
  assert.ok(why.includes('git worktree add -b <branch> <path> origin/next'), why);
  assert.ok(why.includes('git stash push -m'), why);
  assert.ok(why.includes(L10) && why.includes(R10), 'both short shas: ' + why);
  assert.ok(!DESTRUCTIVE.test(why), 'no destructive suggestion: ' + why);
  assert.ok(!/GSD_CONTRIB_OVERRIDE|STALE_OK/.test(why), 'a policy deny names no escape: ' + why);
  assert.strictEqual(calls.casUpdateRef, 0);
});

test('ENF-25 WTREE-03: a held next lists up to 3 holder paths and quotes one with a space', () => {
  const { deps } = scenario({ held: ['/w/my tree', '/w/b', '/w/c', '/w/d'] });
  const d = runWorktreeFreshBaseGate(input('git worktree add p next'), deps);
  assert.strictEqual(d.permissionDecision, 'deny');
  const why = d.permissionDecisionReason;
  assert.ok(why.includes("git -C '/w/my tree' merge --ff-only origin/next"), why);
  assert.ok(why.includes('/w/b') && why.includes('/w/c'), why);
  assert.ok(!why.includes('/w/d'), 'at most 3 holders listed: ' + why);
});

test('ENF-25 WTREE-03: a diverged next denies naming both short shas and the origin/next alternative, nothing destructive', () => {
  const { deps, calls } = scenario({ ancestor: DIVERGED });
  const d = runWorktreeFreshBaseGate(input('git worktree add -b feat p next'), deps);
  assert.strictEqual(d.permissionDecision, 'deny');
  const why = d.permissionDecisionReason;
  assert.match(why, /ENF-25/);
  assert.match(why, /diverged/);
  assert.ok(why.includes(L10) && why.includes(R10), 'both short shas: ' + why);
  assert.ok(why.includes('git worktree add -b <branch> <path> origin/next'), why);
  assert.ok(!DESTRUCTIVE.test(why), 'no destructive suggestion: ' + why);
  assert.strictEqual(calls.casUpdateRef, 0);
  assert.strictEqual(calls.isAncestor, 2, 'ancestry is checked in both directions');
});

test('ENF-25 WTREE-03: a next AHEAD of origin/next (planner refinement) allows and moves nothing', () => {
  const { deps, calls } = scenario({ ancestor: AHEAD });
  const d = runWorktreeFreshBaseGate(input('git worktree add -b feat p next'), deps);
  assert.strictEqual(d.permissionDecision, 'allow');
  assert.strictEqual(calls.casUpdateRef, 0);
  assert.strictEqual(calls.worktreesHolding, 0, 'ahead needs no holder check');
});

test('ENF-25 WTREE-03: HEAD base on branch `work` allows with ZERO fetch', () => {
  const { deps, calls } = scenario({ branch: 'work' });
  const d = runWorktreeFreshBaseGate(input('git worktree add -b f p'), deps);
  assert.strictEqual(d.permissionDecision, 'allow');
  assert.strictEqual(calls.fetchOrigin, 0);
  assert.strictEqual(calls.casUpdateRef, 0);
});

test('ENF-25 WTREE-03: HEAD base on a detached HEAD allows with ZERO fetch', () => {
  const { deps, calls } = scenario({ branch: null });
  const d = runWorktreeFreshBaseGate(input('git worktree add -b f p HEAD'), deps);
  assert.strictEqual(d.permissionDecision, 'allow');
  assert.strictEqual(calls.fetchOrigin, 0);
});

test('ENF-25 WTREE-03: HEAD base on `next`, behind and held by its own tree, denies with `git -C <dir> merge --ff-only origin/next`', () => {
  const { deps, calls } = scenario({ branch: 'next', held: [FAKE_CWD] });
  const d = runWorktreeFreshBaseGate(input('git worktree add -b f p'), deps);
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.ok(d.permissionDecisionReason.includes('git -C ' + FAKE_CWD + ' merge --ff-only origin/next'), d.permissionDecisionReason);
  assert.strictEqual(calls.casUpdateRef, 0);
  assert.deepStrictEqual(calls.order.slice(0, 2), ['currentBranch', 'fetchOrigin'], 'the branch is read BEFORE the fetch');
});

test('ENF-25 WTREE-03: HEAD base `@` on `next` equal to origin/next allows with no CAS', () => {
  const { deps, calls } = scenario({ branch: 'next', held: [FAKE_CWD], refs: { 'refs/heads/next': SHA_REMOTE } });
  const d = runWorktreeFreshBaseGate(input('git worktree add -b f p @'), deps);
  assert.strictEqual(d.permissionDecision, 'allow');
  assert.strictEqual(calls.fetchOrigin, 1);
  assert.strictEqual(calls.casUpdateRef, 0);
});

test('ENF-25 WTREE-03: HEAD base on `next`, diverged, denies naming the divergence', () => {
  const { deps } = scenario({ branch: 'next', held: [FAKE_CWD], ancestor: DIVERGED });
  const d = runWorktreeFreshBaseGate(input('git worktree add -b f p HEAD'), deps);
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /diverged/);
});

test('ENF-25 WTREE-03: the held deny is NOT override-escapable (zero receipts)', () => {
  const o = yesOverride();
  const { deps } = scenario({ held: ['/w/main'], overrideImpl: o.overrideImpl });
  const d = runWorktreeFreshBaseGate(input('git worktree add p next'), deps);
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.strictEqual(o.receipts.length, 0);
});

test('ENF-25 WTREE-03: the diverged deny is NOT override-escapable (zero receipts)', () => {
  const o = yesOverride();
  const { deps } = scenario({ ancestor: DIVERGED, overrideImpl: o.overrideImpl });
  const d = runWorktreeFreshBaseGate(input('git worktree add p next'), deps);
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.strictEqual(o.receipts.length, 0);
});

test('ENF-25 WTREE-03: the HEAD-on-next deny is NOT override-escapable (zero receipts)', () => {
  const o = yesOverride();
  const { deps } = scenario({ branch: 'next', held: [FAKE_CWD], overrideImpl: o.overrideImpl });
  const d = runWorktreeFreshBaseGate(input('git worktree add -b f p'), deps);
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.strictEqual(o.receipts.length, 0);
});

test('ENF-25 WTREE-03: two cuts, the first allowing and the second held, deny (a deny beats an earlier allow)', () => {
  const { deps } = scenario({ held: ['/w/main'] });
  const d = runWorktreeFreshBaseGate(input('git worktree add -b a p origin/next && git worktree add -b b q next'), deps);
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.ok(d.permissionDecisionReason.includes('git -C /w/main merge --ff-only origin/next'));
});

// ───────────────────────── 37-03 WTREE-03 e2e (spawned hook, real fixture) ─────────────────────────

/** Commit on A's local `next` without leaving `work` checked out at the end (diverged / ahead setup). */
function commitOnLocalNext(fx) {
  git(fx.A, 'switch', '-q', 'next');
  fs.writeFileSync(path.join(fx.A, 'local.txt'), 'local work on next\n');
  const sha = commitAll(fx.A, 'local next');
  git(fx.A, 'switch', '-q', 'work');
  assert.strictEqual(git(fx.A, 'symbolic-ref', 'HEAD').trim(), 'refs/heads/work', 'setup: A parked on work');
  return sha;
}

test('ENF-25 WTREE-03: e2e: A on next, origin advanced -> deny naming A and merge --ff-only; next unchanged, origin/next fetched', () => {
  const fx = makeFixture({ park: false });
  try {
    const tip = fx.advanceOrigin();
    const r = spawnIn(fx.A, 'git worktree add -b f ' + path.join(fx.root, 'wt') + ' next');
    assert.strictEqual(r.decision, 'deny', r.reason);
    assert.ok(r.reason.includes('git -C ' + fs.realpathSync(fx.A) + ' merge --ff-only origin/next'), r.reason);
    assert.strictEqual(refOf(fx.A, 'refs/heads/next'), fx.initial, 'a checked-out next is never moved');
    assert.strictEqual(refOf(fx.A, 'refs/remotes/origin/next'), tip, 'the fetch ran');
  } finally {
    fx.dispose();
  }
});

test('ENF-25 WTREE-03: e2e: A on work, next held by a linked worktree <tmp>/lt -> deny naming <tmp>/lt; next unchanged', () => {
  const fx = makeFixture();
  try {
    const lt = path.join(fx.root, 'lt');
    git(fx.A, 'worktree', 'add', '-q', lt, 'next');
    fx.advanceOrigin();
    const r = spawnIn(fx.A, 'git worktree add -b f ' + path.join(fx.root, 'wt') + ' next');
    assert.strictEqual(r.decision, 'deny', r.reason);
    assert.ok(r.reason.includes('git -C ' + fs.realpathSync(lt) + ' merge --ff-only origin/next'), r.reason);
    assert.strictEqual(refOf(fx.A, 'refs/heads/next'), fx.initial);
  } finally {
    fx.dispose();
  }
});

test('ENF-25 WTREE-03: e2e: A on work, local next and origin/next diverged -> deny naming the divergence; next unchanged', () => {
  const fx = makeFixture();
  try {
    const localSha = commitOnLocalNext(fx);
    fx.advanceOrigin();
    const r = spawnIn(fx.A, 'git worktree add -b f ' + path.join(fx.root, 'wt') + ' next');
    assert.strictEqual(r.decision, 'deny', r.reason);
    assert.match(r.reason, /diverged/);
    assert.ok(!DESTRUCTIVE.test(r.reason), r.reason);
    assert.strictEqual(refOf(fx.A, 'refs/heads/next'), localSha);
  } finally {
    fx.dispose();
  }
});

test('ENF-25 WTREE-03: e2e: A on work, local next AHEAD of an unmoved origin -> allow; next unchanged', () => {
  const fx = makeFixture();
  try {
    const localSha = commitOnLocalNext(fx);
    const r = spawnIn(fx.A, 'git worktree add -b f ' + path.join(fx.root, 'wt') + ' next');
    assert.strictEqual(r.decision, 'allow', r.reason);
    assert.strictEqual(refOf(fx.A, 'refs/heads/next'), localSha);
  } finally {
    fx.dispose();
  }
});

test('ENF-25 WTREE-03: e2e: A on next, origin advanced, base omitted -> deny with merge --ff-only origin/next', () => {
  const fx = makeFixture({ park: false });
  try {
    fx.advanceOrigin();
    const r = spawnIn(fx.A, 'git worktree add -b f ' + path.join(fx.root, 'wt'));
    assert.strictEqual(r.decision, 'deny', r.reason);
    assert.ok(r.reason.includes('git -C ' + fs.realpathSync(fx.A) + ' merge --ff-only origin/next'), r.reason);
    assert.strictEqual(refOf(fx.A, 'refs/heads/next'), fx.initial);
  } finally {
    fx.dispose();
  }
});

test('ENF-25 WTREE-03: e2e: A on work, origin advanced, base omitted -> allow and no fetch', () => {
  const fx = makeFixture();
  try {
    fx.advanceOrigin();
    const r = spawnIn(fx.A, 'git worktree add -b f ' + path.join(fx.root, 'wt'));
    assert.strictEqual(r.decision, 'allow', r.reason);
    assert.strictEqual(refOf(fx.A, 'refs/remotes/origin/next'), fx.initial, 'no fetch for a HEAD base off next');
  } finally {
    fx.dispose();
  }
});
