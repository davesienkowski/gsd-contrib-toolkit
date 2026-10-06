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
 *     a bare `open-gsd/gsd-core.git` origin (default branch `next`; the path makes `remote get-url
 *     origin` parse as open-gsd/gsd-core, which arms the gate: 37-REVIEW MA-01), clone A (the gsd-core-shaped checkout, parked
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
    isSymbolicRef: 0,
    nextInProgress: 0,
    originUrl: 0,
    currentBranch: 0,
    readBaseRef: 0,
    readBaseRefArgs: [],
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
    // 37-REVIEW MA-01: the raw `remote get-url origin` (`over.originUrl`, default the gsd-core URL).
    originUrl: () => {
      calls.originUrl += 1;
      return Object.prototype.hasOwnProperty.call(over, 'originUrl') ? over.originUrl : 'https://github.com/open-gsd/gsd-core.git';
    },
    // 37-REVIEW BL-02: worktrees mid-rebase / mid-bisect of next (`over.inProgress`, default none).
    nextInProgress: () => {
      calls.nextInProgress += 1;
      return over.inProgress || [];
    },
    // 37-REVIEW BL-01: is refs/heads/next a symbolic ref (`over.symbolic`, default false)?
    isSymbolicRef: () => {
      calls.isSymbolicRef += 1;
      return over.symbolic === true;
    },
    casUpdateRef: (...args) => {
      calls.casUpdateRef += 1;
      calls.casArgs.push(args);
      return over.casOk !== false;
    },
    // 37-05: the effective worktree.baseRef for an EnterWorktree cut (`over.baseRef`, default fresh).
    readBaseRef: (...args) => {
      calls.readBaseRef += 1;
      calls.readBaseRefArgs.push(args);
      calls.order.push('readBaseRef');
      return Object.prototype.hasOwnProperty.call(over, 'baseRef') ? over.baseRef : 'fresh';
    },
    overrideImpl: {
      checkOverride: () => ({ override: false }),
      writeReceipt: () => {},
    },
  };
  const rest = Object.assign({}, over);
  for (const k of ['refs', 'ancestor', 'held', 'casOk', 'branch', 'baseRef', 'symbolic', 'inProgress', 'originUrl']) delete rest[k];
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
  // The origin path ends in open-gsd/gsd-core.git so the gate's MA-01 arming check (origin parses
  // as open-gsd/gsd-core) passes for a local bare repo; no network is ever used.
  const origin = path.join(root, 'open-gsd', 'gsd-core.git');
  fs.mkdirSync(path.dirname(origin), { recursive: true });
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
  // 37-04: every seam also receives its time slice as a trailing argument; the CAS operands are the first four.
  assert.deepStrictEqual(calls.casArgs[0].slice(0, 4), [FAKE_CWD, 'refs/heads/next', SHA_REMOTE, SHA_LOCAL]);
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

// 37-04 (planned, CTK-ADR-0007): a missing origin/next after a successful fetch is an unobtainable
// upstream, so it ASKS. It was a FailClosed deny stub in 37-01..03; it never moves next either way.
test('ENF-25 tracer: a missing origin/next after the fetch asks (37-04) and never moves next', () => {
  const { deps, calls } = scenario({ refs: { 'refs/remotes/origin/next': null } });
  const d = runWorktreeFreshBaseGate(input('git worktree add p next'), deps);
  assert.strictEqual(d.permissionDecision, 'ask');
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

// 37-04 (closes 37-02 deferred item 1, environment half): the hook process itself inherits GIT_DIR,
// so the real cut would run in B while the gate could only see A. That cut is unattributable: the
// constant uncertain deny, and NEITHER repo's next moves (37-01 asserted allow + A moved).
test('ENF-25 tracer e2e: an inherited GIT_DIR makes a trunk cut unattributable -> uncertain deny; neither A nor B moves', () => {
  const fx = makeFixture();
  const saved = process.env.GIT_DIR;
  try {
    fx.advanceOrigin();
    const bNextBefore = refOf(fx.B, 'refs/heads/next');
    process.env.GIT_DIR = path.join(fx.B, '.git');
    let r;
    try {
      r = spawnIn(fx.A, 'git worktree add -b feat ' + path.join(fx.root, 'wt') + ' next');
    } finally {
      if (saved === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = saved;
    }
    assert.strictEqual(r.decision, 'deny', r.reason);
    assert.match(r.reason, /cannot attribute/);
    assert.ok(!r.reason.includes('/'), 'the constant, path-free uncertain reason: ' + r.reason);
    assert.strictEqual(refOf(fx.A, 'refs/heads/next'), fx.initial, 'A next not moved');
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

// ───────────────────────── 37-03 WTREE-02: compare-and-swap edges ─────────────────────────
//
// A refused CAS (local next moved between the gate's read and its write) is a POLICY deny with the
// fix, attempted ONCE. The exported default seams are proven on real repos: a wrong old value
// leaves refs/heads/next untouched, the right one moves it with an ENF-25 reflog entry, and a
// repeat run finds next equal and makes no second move.

const gateModule = require('./worktree-fresh-base.cjs');

/** The exported default-seam factory, asserted (not destructured) so a missing export is a row failure. */
function defaultSeams() {
  assert.strictEqual(typeof gateModule.createDefaultSeams, 'function', 'worktree-fresh-base must export createDefaultSeams()');
  return gateModule.createDefaultSeams({ env: process.env });
}

/** Fixture A (parked on work unless park:false) with origin advanced and fetched by SETUP: next = L, origin/next = R. */
function fetchedFixture(opts) {
  const fx = makeFixture(opts);
  const R = fx.advanceOrigin();
  git(fx.A, 'fetch', '-q', 'origin', 'next');
  assert.strictEqual(refOf(fx.A, 'refs/remotes/origin/next'), R, 'setup: origin/next fetched');
  return { fx, L: fx.initial, R };
}

test('ENF-25 WTREE-02: a refused CAS is a policy deny naming the change and the fix, attempted exactly once', () => {
  const { deps, calls } = scenario({ casOk: false });
  const d = runWorktreeFreshBaseGate(input('git worktree add -b feat p next'), deps);
  assert.strictEqual(d.permissionDecision, 'deny');
  const why = d.permissionDecisionReason;
  assert.match(why, /ENF-25/);
  assert.match(why, /changed while the gate ran/);
  assert.match(why, /re-issue/i);
  assert.ok(why.includes('git worktree add -b <branch> <path> origin/next'), why);
  assert.ok(!DESTRUCTIVE.test(why), 'no destructive suggestion: ' + why);
  assert.strictEqual(calls.casUpdateRef, 1, 'no second update-ref attempt in the same call');
});

test('ENF-25 WTREE-02: the refused-CAS deny is NOT override-escapable (zero receipts)', () => {
  const o = yesOverride();
  const { deps, calls } = scenario({ casOk: false, overrideImpl: o.overrideImpl });
  const d = runWorktreeFreshBaseGate(input('git worktree add p next'), deps);
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.strictEqual(o.receipts.length, 0);
  assert.strictEqual(calls.casUpdateRef, 1);
});

test('ENF-25 WTREE-02: local next equal to origin/next allows with ZERO CAS calls', () => {
  const { deps, calls } = scenario({ refs: { 'refs/heads/next': SHA_REMOTE } });
  const d = runWorktreeFreshBaseGate(input('git worktree add -b feat p next'), deps);
  assert.strictEqual(d.permissionDecision, 'allow');
  assert.strictEqual(calls.casUpdateRef, 0);
});

test('ENF-25 WTREE-02: a CAS seam that THROWS FailClosed stays override-escapable (allow + one receipt)', () => {
  const o = yesOverride();
  const { deps } = scenario({
    overrideImpl: o.overrideImpl,
    casUpdateRef: () => {
      throw new FailClosed('ENF-25 test: update-ref could not run');
    },
  });
  const d = runWorktreeFreshBaseGate(input('git worktree add p next'), deps);
  assert.strictEqual(d.permissionDecision, 'allow');
  assert.strictEqual(o.receipts.length, 1);
});

test('ENF-25 WTREE-02: default casUpdateRef with a WRONG old value returns false and leaves refs/heads/next byte-identical', () => {
  const { fx, L, R } = fetchedFixture();
  try {
    const seams = defaultSeams();
    const before = fs.readFileSync(path.join(fx.A, '.git', 'refs', 'heads', 'next'), 'utf8');
    assert.strictEqual(seams.casUpdateRef(fx.A, 'refs/heads/next', R, '0'.repeat(39) + '1'), false);
    assert.strictEqual(refOf(fx.A, 'refs/heads/next'), L);
    assert.strictEqual(fs.readFileSync(path.join(fx.A, '.git', 'refs', 'heads', 'next'), 'utf8'), before);
  } finally {
    fx.dispose();
  }
});

test('ENF-25 WTREE-02: default casUpdateRef with the RIGHT old value returns true and writes an ENF-25 reflog entry', () => {
  const { fx, L, R } = fetchedFixture();
  try {
    const seams = defaultSeams();
    assert.strictEqual(seams.casUpdateRef(fx.A, 'refs/heads/next', R, L), true);
    assert.strictEqual(refOf(fx.A, 'refs/heads/next'), R);
    const first = git(fx.A, 'reflog', 'show', '--format=%gs', 'refs/heads/next').split('\n')[0];
    assert.match(first, /ENF-25/);
  } finally {
    fx.dispose();
  }
});

test('ENF-25 WTREE-02: default worktreesHolding returns the main tree for a clone on next', () => {
  const fx = makeFixture({ park: false });
  try {
    assert.deepStrictEqual(defaultSeams().worktreesHolding(fx.A, 'refs/heads/next'), [fs.realpathSync(fx.A)]);
  } finally {
    fx.dispose();
  }
});

test('ENF-25 WTREE-02: default worktreesHolding returns [] for a clone parked on work', () => {
  const fx = makeFixture();
  try {
    assert.deepStrictEqual(defaultSeams().worktreesHolding(fx.A, 'refs/heads/next'), []);
  } finally {
    fx.dispose();
  }
});

test('ENF-25 WTREE-02: default isAncestor is true for a real ancestor pair and false for its reverse', () => {
  const { fx, L, R } = fetchedFixture();
  try {
    const seams = defaultSeams();
    assert.strictEqual(seams.isAncestor(fx.A, L, R), true);
    assert.strictEqual(seams.isAncestor(fx.A, R, L), false);
  } finally {
    fx.dispose();
  }
});

test('ENF-25 WTREE-02: default currentBranch reads next, work and a detached HEAD (null), even with a tag named next', () => {
  const fx = makeFixture({ park: false });
  try {
    const seams = defaultSeams();
    git(fx.A, 'tag', 'next');
    assert.strictEqual(seams.currentBranch(fx.A), 'next', 'a tag named next must not turn the branch into heads/next');
    git(fx.A, 'switch', '-q', '-c', 'work');
    assert.strictEqual(seams.currentBranch(fx.A), 'work');
    git(fx.A, 'switch', '-q', '--detach');
    assert.strictEqual(seams.currentBranch(fx.A), null);
  } finally {
    fx.dispose();
  }
});

test('ENF-25 WTREE-02: e2e idempotency: the trunk cut run twice allows both times and next has exactly ONE ENF-25 reflog entry', () => {
  const fx = makeFixture();
  try {
    const tip = fx.advanceOrigin();
    const cmd = 'git worktree add -b f ' + path.join(fx.root, 'wt') + ' next';
    assert.strictEqual(spawnIn(fx.A, cmd).decision, 'allow');
    assert.strictEqual(spawnIn(fx.A, cmd).decision, 'allow');
    assert.strictEqual(refOf(fx.A, 'refs/heads/next'), tip);
    const lines = git(fx.A, 'reflog', 'show', '--format=%gs', 'refs/heads/next').split('\n');
    assert.strictEqual(lines.filter((l) => /ENF-25/.test(l)).length, 1, JSON.stringify(lines));
  } finally {
    fx.dispose();
  }
});

// ───────────────────────── 37-04 WTREE-04: an unobtainable origin asks ─────────────────────────
//
// CTK-ADR-0007 / Addendum 5: the fetch seam throws FetchUnavailable (NOT a FailClosed) and a catch
// around the fetch call ALONE turns it into `ask`. Every other throw still denies through runGate.
// The ask reason names ENF-25, the (redacted) failure, that this is a network limit, the manual
// `git -C <dir> fetch origin next`, and ends with the ASK_LIMIT_NOTE honesty sentence.

/** A gate-module export, asserted (not destructured) so a missing export fails one row, not the file. */
function exp(name) {
  assert.ok(gateModule[name] !== undefined, 'worktree-fresh-base must export ' + name);
  return gateModule[name];
}

function unavailable(msg) {
  return () => {
    throw new gateModule.FetchUnavailable(msg);
  };
}

const ASK_NOT_BLOCKING = /\bblock(s|ed|ing)?\b/i;

const FETCH_TABLE = [
  { name: 'exit 0 is ok', res: { status: 0, stderr: '' }, state: 'ok' },
  { name: 'exit 124 (coreutils timed out) is unavailable (timeout)', res: { status: 124, stderr: '' }, state: 'unavailable', detail: /timed out/ },
  { name: 'exit 137 (killed after the grace) is unavailable (timeout)', res: { status: 137, stderr: '' }, state: 'unavailable', detail: /timed out/ },
  {
    name: 'spawnSync ETIMEDOUT with SIGKILL (the belt) is unavailable (timeout)',
    res: { status: null, signal: 'SIGKILL', error: { code: 'ETIMEDOUT' } },
    state: 'unavailable',
    detail: /timed out|did not finish/,
  },
  { name: 'a SIGTERM with no exit status is unavailable', res: { status: null, signal: 'SIGTERM' }, state: 'unavailable' },
  {
    name: 'exit 128 with a credentialed URL is unavailable and the credentials are redacted',
    res: { status: 128, stderr: "fatal: unable to access 'https://u:s3cr3t@h.example/r.git/': x\n" },
    state: 'unavailable',
    check: (detail) => {
      assert.ok(detail.includes('https://***@h.example'), detail);
      assert.ok(!detail.includes('s3cr3t'), detail);
    },
  },
  { name: 'exit 1 with an empty stderr is unavailable', res: { status: 1, stderr: '' }, state: 'unavailable' },
  { name: 'spawn ENOENT (no coreutils timeout: the fetch cannot be bounded) is error', res: { status: null, error: { code: 'ENOENT' } }, state: 'error' },
  { name: 'exit 125 (timeout itself failed) is error', res: { status: 125, stderr: '' }, state: 'error' },
  { name: 'exit 126 (git not executable) is error', res: { status: 126, stderr: '' }, state: 'error' },
  { name: 'exit 127 (git not found) is error', res: { status: 127, stderr: '' }, state: 'error' },
  { name: 'spawn EACCES is error', res: { status: null, error: { code: 'EACCES' } }, state: 'error' },
  {
    name: 'a 500-char stderr line is capped at 200 characters',
    res: { status: 128, stderr: '\n' + 'x'.repeat(500) + '\nsecond line\n' },
    state: 'unavailable',
    check: (detail) => {
      assert.ok(detail.length <= 200, 'detail length ' + detail.length);
      assert.ok(!detail.includes('second line'), 'first non-empty line only: ' + detail);
    },
  },
];

for (const row of FETCH_TABLE) {
  test('ENF-25 WTREE-04: classifyFetchResult: ' + row.name, () => {
    const out = exp('classifyFetchResult')(row.res);
    assert.strictEqual(out.state, row.state, JSON.stringify(out));
    if (row.detail) assert.match(String(out.detail), row.detail);
    if (row.check) row.check(String(out.detail));
  });
}

test('ENF-25 WTREE-04: a fetch that throws FetchUnavailable asks when the last-fetched origin/next cannot decide (behind, unheld); never a CAS', () => {
  const { deps, calls } = scenario({ fetchOrigin: unavailable('`git fetch origin next` timed out after 15 s') });
  const d = runWorktreeFreshBaseGate(input('git worktree add -b feat p next'), deps);
  assert.strictEqual(d.permissionDecision, 'ask', JSON.stringify(d));
  const why = d.permissionDecisionReason;
  assert.match(why, /ENF-25/);
  assert.match(why, /timed out after 15 s/);
  assert.match(why, /git -C .* fetch origin next/);
  assert.match(why, /network/i);
  assert.match(why, /not a policy decision/i);
  assert.match(why, /dangerously-skip-permissions/);
  // 37-REVIEW MI-01: the local evidence is read (it might prove a held or diverged next), but a
  // move is never made on unrefreshed data.
  assert.strictEqual(calls.revParse, 2);
  assert.strictEqual(calls.casUpdateRef, 0);
});

test('ENF-25 WTREE-04: the ask reason names the target root in the manual fetch and re-issue, and ends with ASK_LIMIT_NOTE', () => {
  const { deps } = scenario({ fetchOrigin: unavailable('x') });
  const d = runWorktreeFreshBaseGate(input('git worktree add p next'), deps);
  const why = d.permissionDecisionReason;
  assert.ok(why.includes('git -C ' + FAKE_CWD + ' fetch origin next'), why);
  assert.match(why, /re-issue/i);
  assert.ok(why.endsWith(exp('ASK_LIMIT_NOTE')), why);
});

test('ENF-25 WTREE-04: the ask reason never describes itself as blocking', () => {
  const { deps } = scenario({ fetchOrigin: unavailable('`git fetch origin next` failed (exit 128)') });
  const d = runWorktreeFreshBaseGate(input('git worktree add p next'), deps);
  assert.strictEqual(d.permissionDecision, 'ask');
  assert.ok(!ASK_NOT_BLOCKING.test(d.permissionDecisionReason), d.permissionDecisionReason);
});

test('ENF-25 WTREE-04: ASK_LIMIT_NOTE is the same sentence as runtime-drift (test-side require only)', () => {
  assert.strictEqual(exp('ASK_LIMIT_NOTE'), require('./runtime-drift.cjs').ASK_LIMIT_NOTE);
});

test('ENF-25 WTREE-04: credentials in a FetchUnavailable message are redacted in the ask reason', () => {
  const { deps } = scenario({
    fetchOrigin: unavailable("`git fetch origin next` failed: fatal: unable to access 'https://user:s3cr3t@example.invalid/r.git/'"),
  });
  const d = runWorktreeFreshBaseGate(input('git worktree add p next'), deps);
  assert.strictEqual(d.permissionDecision, 'ask');
  assert.ok(d.permissionDecisionReason.includes('https://***@example.invalid'), d.permissionDecisionReason);
  assert.ok(!d.permissionDecisionReason.includes('s3cr3t'), d.permissionDecisionReason);
});

test('ENF-25 WTREE-04: fetch ok but origin/next missing asks, naming origin/next missing after the fetch', () => {
  const { deps, calls } = scenario({ refs: { 'refs/remotes/origin/next': null } });
  const d = runWorktreeFreshBaseGate(input('git worktree add -b feat p next'), deps);
  assert.strictEqual(d.permissionDecision, 'ask', JSON.stringify(d));
  assert.match(d.permissionDecisionReason, /origin\/next/);
  assert.match(d.permissionDecisionReason, /after the fetch/);
  assert.match(d.permissionDecisionReason, /dangerously-skip-permissions/);
  assert.strictEqual(calls.isAncestor, 0);
  assert.strictEqual(calls.casUpdateRef, 0);
});

test('ENF-25 WTREE-04: a remote base (`origin/next`) with an unobtainable origin asks', () => {
  const { deps } = scenario({ fetchOrigin: unavailable('x') });
  const d = runWorktreeFreshBaseGate(input('git worktree add -b feat p origin/next'), deps);
  assert.strictEqual(d.permissionDecision, 'ask');
});

test('ENF-25 WTREE-04: a HEAD base on `next` with an unobtainable origin asks after reading the branch', () => {
  const { deps, calls } = scenario({ branch: 'next', fetchOrigin: unavailable('x') });
  const d = runWorktreeFreshBaseGate(input('git worktree add -b feat p'), deps);
  assert.strictEqual(d.permissionDecision, 'ask');
  assert.strictEqual(calls.currentBranch, 1);
  assert.strictEqual(calls.casUpdateRef, 0);
});

test('ENF-25 WTREE-04: a fetch seam throwing FailClosed denies (nothing leaks into ask)', () => {
  const { deps } = scenario({
    fetchOrigin: () => {
      throw new FailClosed('ENF-25 test: timeout binary missing');
    },
  });
  const d = runWorktreeFreshBaseGate(input('git worktree add p next'), deps);
  assert.strictEqual(d.permissionDecision, 'deny');
});

test('ENF-25 WTREE-04: a fetch seam throwing a plain Error denies (nothing leaks into ask)', () => {
  const { deps } = scenario({
    fetchOrigin: () => {
      throw new Error('surprise');
    },
  });
  const d = runWorktreeFreshBaseGate(input('git worktree add p next'), deps);
  assert.strictEqual(d.permissionDecision, 'deny');
});

test('ENF-25 WTREE-04: a FetchUnavailable from a seam OTHER than the fetch denies (the catch wraps the fetch alone)', () => {
  const { deps } = scenario({
    revParse: () => {
      throw new gateModule.FetchUnavailable('not from the fetch');
    },
  });
  const d = runWorktreeFreshBaseGate(input('git worktree add p next'), deps);
  assert.strictEqual(d.permissionDecision, 'deny');
});

test('ENF-25 WTREE-04: revParse throwing FailClosed after a good fetch denies', () => {
  const { deps, calls } = scenario({
    revParse: () => {
      throw new FailClosed('ENF-25 test: rev-parse failed');
    },
  });
  const d = runWorktreeFreshBaseGate(input('git worktree add p next'), deps);
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.strictEqual(calls.fetchOrigin, 1);
});

test('ENF-25 WTREE-04: an ask from cut 1 and a policy deny from cut 2 (another root) -> deny', () => {
  const { deps } = scenario({
    resolveTreeRoot: (dir) => dir,
    held: ['/r2'],
    fetchOrigin: (dir) => {
      if (dir === '/r1') throw new gateModule.FetchUnavailable('timed out');
    },
  });
  const d = runWorktreeFreshBaseGate(input('git -C /r1 worktree add -b a p next && git -C /r2 worktree add -b b q next'), deps);
  assert.strictEqual(d.permissionDecision, 'deny', JSON.stringify(d));
  assert.match(d.permissionDecisionReason, /merge --ff-only/);
});

test('ENF-25 WTREE-04: an ask from cut 1 and a THROW from cut 2 (another root) -> deny', () => {
  const { deps } = scenario({
    resolveTreeRoot: (dir) => dir,
    fetchOrigin: (dir) => {
      if (dir === '/r1') throw new gateModule.FetchUnavailable('timed out');
      throw new FailClosed('ENF-25 test: second root broken');
    },
  });
  const d = runWorktreeFreshBaseGate(input('git -C /r1 worktree add -b a p next && git -C /r2 worktree add -b b q next'), deps);
  assert.strictEqual(d.permissionDecision, 'deny', JSON.stringify(d));
});

test('ENF-25 WTREE-04: asks only -> ask, and a failed fetch is NOT retried for a second cut of the same root', () => {
  const { deps, calls } = scenario({
    fetchOrigin: () => {
      calls.fetchOrigin += 1;
      throw new gateModule.FetchUnavailable('timed out');
    },
  });
  const d = runWorktreeFreshBaseGate(input('git worktree add -b a p next && git worktree add -b b q origin/next'), deps);
  assert.strictEqual(d.permissionDecision, 'ask');
  assert.strictEqual(calls.fetchOrigin, 1, 'one fetch attempt per root per gate call');
});

test('ENF-25 WTREE-04: the ask is a returned decision, not a throw: an override that says yes writes zero receipts', () => {
  const o = yesOverride();
  const { deps } = scenario({ fetchOrigin: unavailable('timed out'), overrideImpl: o.overrideImpl });
  const d = runWorktreeFreshBaseGate(input('git worktree add p next'), deps);
  assert.strictEqual(d.permissionDecision, 'ask');
  assert.strictEqual(o.receipts.length, 0);
});

// ── 37-02 deferred item 1 (environment half), closed in 37-04 as a recorded deviation ──
// The HOOK process's own environment carrying GIT_DIR / GIT_WORK_TREE / GIT_COMMON_DIR means the
// real cut runs in a repository the gate cannot see (its own git calls scrub them). A trunk-naming
// cut is then unattributable: the constant uncertain deny, thrown (override-escapable), zero work.

test('ENF-25 targeting: hook env GIT_DIR makes a trunk cut uncertain -> the constant deny, ZERO resolve and fetch', () => {
  const { deps, calls } = scenario({ hookEnv: { GIT_DIR: '/x/.git' } });
  const d = runWorktreeFreshBaseGate(input('git worktree add p next'), deps);
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /cannot attribute/);
  assert.ok(!d.permissionDecisionReason.includes('/'), d.permissionDecisionReason);
  assert.strictEqual(calls.resolveTreeRoot, 0);
  assert.strictEqual(calls.fetchOrigin, 0);
});

test('ENF-25 targeting: hook env GIT_WORK_TREE makes a HEAD-base cut uncertain -> deny, ZERO currentBranch', () => {
  const { deps, calls } = scenario({ hookEnv: { GIT_WORK_TREE: '/x' }, branch: 'next' });
  const d = runWorktreeFreshBaseGate(input('git worktree add -b f p'), deps);
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /cannot attribute/);
  assert.strictEqual(calls.currentBranch, 0);
});

test('ENF-25 targeting: hook env GIT_COMMON_DIR makes a remote-base cut uncertain -> deny', () => {
  const { deps } = scenario({ hookEnv: { GIT_COMMON_DIR: '/x' } });
  const d = runWorktreeFreshBaseGate(input('git worktree add -b f p origin/next'), deps);
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /cannot attribute/);
});

test('ENF-25 targeting: the hook-env uncertain deny is THROWN (override-escapable, one receipt)', () => {
  const o = yesOverride();
  const { deps } = scenario({ hookEnv: { GIT_DIR: '/x/.git' }, overrideImpl: o.overrideImpl });
  const d = runWorktreeFreshBaseGate(input('git worktree add p next'), deps);
  assert.strictEqual(d.permissionDecision, 'allow');
  assert.strictEqual(o.receipts.length, 1);
});

test('ENF-25 targeting: hook env GIT_DIR does not touch `git status` or a non-trunk cut (allow, ZERO work)', () => {
  for (const cmd of ['git status', 'git worktree add -b f p feature', 'git worktree add --orphan -b o p']) {
    const { deps, calls } = scenario({ hookEnv: { GIT_DIR: '/x/.git' } });
    const d = runWorktreeFreshBaseGate(input(cmd), deps);
    assert.strictEqual(d.permissionDecision, 'allow', cmd);
    assert.strictEqual(calls.resolveTreeRoot, 0, cmd);
    assert.strictEqual(calls.fetchOrigin, 0, cmd);
  }
});

test('ENF-25 targeting: GIT_INDEX_FILE alone in the hook env does not redirect the repository (allow)', () => {
  const { deps, calls } = scenario({ hookEnv: { GIT_INDEX_FILE: '/x/index' } });
  const d = runWorktreeFreshBaseGate(input('git worktree add -b f p next'), deps);
  assert.strictEqual(d.permissionDecision, 'allow');
  assert.strictEqual(calls.fetchOrigin, 1);
});

// ───────────────────────── 37-04 WTREE-01: non-trunk cuts never fetch ─────────────────────────

const NO_FETCH = [
  ['base `feature`', 'git worktree add -b x p feature', {}],
  ['a 40-hex sha base', 'git worktree add -b x p ' + 'c'.repeat(40), {}],
  ['base `upstream/next`', 'git worktree add -b x p upstream/next', {}],
  ['base `next~1`', 'git worktree add -b x p next~1', {}],
  ['base `NEXT` (case matters)', 'git worktree add -b x p NEXT', {}],
  ['`--orphan` (no base)', 'git worktree add --orphan -b o p', {}],
  ['HEAD base while on branch `work`', 'git worktree add -b f p', { branch: 'work' }],
];
const ONE_FETCH = [
  ['base `next`', 'git worktree add -b x p next', {}],
  ['base `refs/heads/next`', 'git worktree add -b x p refs/heads/next', {}],
  ['base `origin/next`', 'git worktree add -b x p origin/next', {}],
  ['base `refs/remotes/origin/next`', 'git worktree add -b x p refs/remotes/origin/next', {}],
  ['HEAD base (omitted) while on `next`', 'git worktree add -b f p', { branch: 'next', held: [] }],
  ['the `../next` convenience form (branch named after the path)', 'git worktree add ../next', {}],
];

for (const [name, cmd, over] of NO_FETCH) {
  test('ENF-25 no-fetch: ' + name + ' makes ZERO fetch calls', () => {
    const { deps, calls } = scenario(over);
    const d = runWorktreeFreshBaseGate(input(cmd), deps);
    assert.strictEqual(d.permissionDecision, 'allow');
    assert.strictEqual(calls.fetchOrigin, 0);
  });
}

for (const [name, cmd, over] of ONE_FETCH) {
  test('ENF-25 no-fetch: ' + name + ' makes exactly ONE fetch call', () => {
    const { deps, calls } = scenario(over);
    runWorktreeFreshBaseGate(input(cmd), deps);
    assert.strictEqual(calls.fetchOrigin, 1);
  });
}

// ───────────────────────── 37-04 bound: one GATE_BUDGET_MS per gate call ─────────────────────────
//
// The 36-REVIEW m-06 per-call deadline (hooks/gsd-test-clean-tree.cjs, 658442a), mirrored, not
// imported. Every subprocess draws on ONE deadline; a non-fetch git call gets
// min(GIT_TIMEOUT_MS, remaining), the fetch belt min(FETCH_BELT_MS, remaining).

test('ENF-25 bound: FETCH_BELT_MS + MAX_GIT_CALLS_PER_ROOT * GIT_TIMEOUT_MS <= GATE_BUDGET_MS, and GATE_BUDGET_MS + 3 s <= 60 s', () => {
  // 37-REVIEW TIME BUDGET: 9 non-fetch calls on the worst path (symbolic-ref HEAD, remote get-url,
  // symbolic-ref -q refs/heads/next, rev-parse x2, merge-base, worktree list, rev-parse
  // --git-common-dir, update-ref) -> 20 s + 9 x 3 s = 47 s <= 50 s, and 50 s + 3 s <= 60 s.
  const belt = exp('FETCH_BELT_MS');
  const max = exp('MAX_GIT_CALLS_PER_ROOT');
  const git1 = exp('GIT_TIMEOUT_MS');
  const budget = exp('GATE_BUDGET_MS');
  assert.strictEqual(max, 9);
  assert.strictEqual(budget, 50000);
  assert.strictEqual(exp('HOOK_TIMEOUT_S'), 60);
  assert.ok(belt + max * git1 <= budget, belt + ' + ' + max + ' * ' + git1 + ' > ' + budget);
  assert.ok(budget + 3000 <= exp('HOOK_TIMEOUT_S') * 1000);
});

/** Every non-fetch git process the default seams would spawn (MA-01: `remote get-url` is the originUrl seam). */
function gitProcesses(calls) {
  return calls.currentBranch + calls.revParse + calls.isAncestor + calls.worktreesHolding + calls.casUpdateRef + calls.originUrl +
    calls.isSymbolicRef + calls.nextInProgress;
}

const WORST = [
  ['local next behind and unheld (CAS)', 'git worktree add -b f p next', {}],
  ['local next diverged', 'git worktree add -b f p next', { ancestor: DIVERGED }],
  ['HEAD on next, behind and (counted as) unheld', 'git worktree add -b f p', { branch: 'next' }],
  ['HEAD on next, diverged', 'git worktree add -b f p', { branch: 'next', ancestor: DIVERGED }],
  ['remote base', 'git worktree add -b f p origin/next', {}],
];
for (const [name, cmd, over] of WORST) {
  test('ENF-25 bound: worst path "' + name + '" spawns <= MAX_GIT_CALLS_PER_ROOT non-fetch git processes', () => {
    const { deps, calls } = scenario(over);
    runWorktreeFreshBaseGate(input(cmd), deps);
    assert.ok(gitProcesses(calls) <= exp('MAX_GIT_CALLS_PER_ROOT'), name + ': ' + gitProcesses(calls));
  });
}

test('ENF-25 bound: the clock past the budget before a git call -> thrown deny naming the ENF-25 budget', () => {
  let t = 1000;
  const spent = 1000 + exp('GATE_BUDGET_MS') - 10; // the fetch spends almost the whole budget
  const { deps, calls } = scenario({
    now: () => t,
    fetchOrigin: () => {
      calls.fetchOrigin += 1;
      t = spent;
    },
  });
  const d = runWorktreeFreshBaseGate(input('git worktree add -b f p next'), deps);
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /ENF-25/);
  assert.match(d.permissionDecisionReason, /budget/);
  assert.strictEqual(calls.revParse, 0);
  assert.strictEqual(calls.casUpdateRef, 0);
});

test('ENF-25 bound: the budget deny is override-escapable (allow + one receipt)', () => {
  let t = 0;
  const spent = exp('GATE_BUDGET_MS'); // read OUTSIDE the seam: a missing export must fail, not throw into runGate
  const o = yesOverride();
  const { deps } = scenario({
    now: () => t,
    overrideImpl: o.overrideImpl,
    fetchOrigin: () => {
      t = spent;
    },
  });
  const d = runWorktreeFreshBaseGate(input('git worktree add -b f p next'), deps);
  assert.strictEqual(d.permissionDecision, 'allow');
  assert.strictEqual(o.receipts.length, 1);
});

test('ENF-25 bound: the fetch belt is FETCH_BELT_MS with the full budget left', () => {
  const belts = [];
  const { deps } = scenario({ now: () => 0, fetchOrigin: (dir, belt) => belts.push(belt) });
  runWorktreeFreshBaseGate(input('git worktree add -b f p next'), deps);
  assert.deepStrictEqual(belts, [exp('FETCH_BELT_MS')]);
});

test('ENF-25 bound: the fetch belt is min(FETCH_BELT_MS, remaining) after a slow branch read, and a FetchUnavailable after it asks', () => {
  let t = 0;
  const belts = [];
  const { deps } = scenario({
    now: () => t,
    currentBranch: () => {
      t = 30000;
      return 'next';
    },
    fetchOrigin: (dir, belt) => {
      belts.push(belt);
      throw new gateModule.FetchUnavailable('`git fetch origin next` timed out');
    },
  });
  const d = runWorktreeFreshBaseGate(input('git worktree add -b f p'), deps);
  assert.deepStrictEqual(belts, [exp('GATE_BUDGET_MS') - 30000]);
  assert.strictEqual(d.permissionDecision, 'ask');
});

test('ENF-25 bound: a non-fetch git call gets min(GIT_TIMEOUT_MS, remaining)', () => {
  let t = 0;
  const slices = [];
  const spent = exp('GATE_BUDGET_MS') - 1500;
  const { deps } = scenario({
    now: () => t,
    fetchOrigin: () => {
      t = spent;
    },
    revParse: (dir, ref, ms) => {
      slices.push(ms);
      return ref === 'refs/remotes/origin/next' ? SHA_REMOTE : SHA_REMOTE;
    },
  });
  runWorktreeFreshBaseGate(input('git worktree add -b f p next'), deps);
  assert.deepStrictEqual(slices, [1500, 1500]);
});

// ───────────────────────── 37-04 WTREE-04 seam: the hardened default fetch ─────────────────────────
//
// createDefaultSeams({env, spawnSync}) with a RECORDING spawnSync: `git remote get-url origin` first
// (exit 2 = no such remote -> FetchUnavailable; any other failure -> FailClosed), then exactly
// `timeout -k 2 15 git -C <abs dir> fetch --quiet --no-auto-maintenance origin next` with a 20 s
// SIGKILL belt, a scrubbed env and GIT_TERMINAL_PROMPT=0. Nothing spawns for a relative dir.

/** A recording spawnSync: `answers(cmd, args)` returns the fake result for each call. */
function recSpawn(answers) {
  const calls = [];
  const fn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return Object.assign({ status: 0, signal: null, stdout: '', stderr: '' }, answers ? answers(cmd, args) : {});
  };
  fn.calls = calls;
  return fn;
}

function seamsWith(rec, extra) {
  return gateModule.createDefaultSeams(Object.assign({ env: { GIT_DIR: '/x', PATH: process.env.PATH }, spawnSync: rec }, extra || {}));
}

const isGetUrl = (cmd, args) => cmd === 'git' && args.join(' ') === 'remote get-url origin';
const isFetch = (cmd) => cmd === 'timeout';

test('ENF-25 WTREE-04 seam: the default fetch runs ONLY the bounded fetch (MA-01 hoisted `remote get-url` out) with the exact argv, belt and scrubbed env', () => {
  const rec = recSpawn();
  seamsWith(rec).fetchOrigin('/abs/dir');
  assert.strictEqual(rec.calls.length, 1, JSON.stringify(rec.calls.map((c) => [c.cmd, c.args])));
  const [f] = rec.calls;
  assert.strictEqual(f.cmd, 'timeout');
  // MA-02: --no-tags and a fully qualified, forced refspec, so origin/next is always the remote BRANCH.
  assert.deepStrictEqual(f.args, ['-k', '2', '15', 'git', '-C', '/abs/dir', 'fetch', '--quiet', '--no-auto-maintenance',
    '--no-tags', 'origin', '+refs/heads/next:refs/remotes/origin/next']);
  assert.strictEqual(f.opts.timeout, 20000);
  assert.strictEqual(f.opts.killSignal, 'SIGKILL');
  assert.strictEqual(f.opts.env.GIT_DIR, undefined);
  assert.strictEqual(f.opts.env.GIT_TERMINAL_PROMPT, '0');
  assert.strictEqual(f.opts.shell, undefined);
});

test('ENF-25 MA-01 seam: default originUrl runs `remote get-url origin` (scrubbed, bounded) and returns the trimmed URL', () => {
  const rec = recSpawn((cmd, args) => (isGetUrl(cmd, args) ? { stdout: 'https://github.com/open-gsd/gsd-core.git\n' } : {}));
  assert.strictEqual(seamsWith(rec).originUrl('/abs/dir'), 'https://github.com/open-gsd/gsd-core.git');
  assert.strictEqual(rec.calls.length, 1);
  const g = rec.calls[0];
  assert.ok(isGetUrl(g.cmd, g.args), JSON.stringify([g.cmd, g.args]));
  assert.strictEqual(g.opts.cwd, '/abs/dir');
  assert.strictEqual(g.opts.timeout, gateModule.GIT_TIMEOUT_MS);
  assert.strictEqual(g.opts.env.GIT_DIR, undefined);
});

test('ENF-25 MA-01 seam: default originUrl exit 2 (no such remote) -> null', () => {
  const rec = recSpawn((cmd, args) => (isGetUrl(cmd, args) ? { status: 2, stderr: 'error: No such remote \'origin\'\n' } : {}));
  assert.strictEqual(seamsWith(rec).originUrl('/abs/dir'), null);
});

test('ENF-25 MA-01 seam: default originUrl exit 128 (unexpected) -> FailClosed', () => {
  const rec = recSpawn((cmd, args) => (isGetUrl(cmd, args) ? { status: 128, stderr: 'fatal: not a git repository\n' } : {}));
  assert.throws(() => seamsWith(rec).originUrl('/abs/dir'), (err) => err instanceof FailClosed);
});

test('ENF-25 WTREE-04 seam: a relative fetch dir -> FailClosed with ZERO spawns', () => {
  const rec = recSpawn();
  assert.throws(() => seamsWith(rec).fetchOrigin('rel/dir'), (err) => err instanceof FailClosed);
  assert.strictEqual(rec.calls.length, 0);
});

test('ENF-25 WTREE-04 seam: the fetch exiting 124 -> FetchUnavailable naming the timeout', () => {
  const rec = recSpawn((cmd) => (isFetch(cmd) ? { status: 124 } : {}));
  assert.throws(
    () => seamsWith(rec).fetchOrigin('/abs/dir'),
    (err) => err instanceof gateModule.FetchUnavailable && /timed out/.test(err.message)
  );
});

test('ENF-25 WTREE-04 seam: coreutils `timeout` missing (spawn ENOENT) -> FailClosed naming `timeout`, never FetchUnavailable', () => {
  const rec = recSpawn((cmd) => (isFetch(cmd) ? { status: null, error: Object.assign(new Error('spawn timeout ENOENT'), { code: 'ENOENT' }) } : {}));
  assert.throws(
    () => seamsWith(rec).fetchOrigin('/abs/dir'),
    (err) => err instanceof FailClosed && /`timeout`/.test(err.message)
  );
});

test('ENF-25 WTREE-04 seam: the fetch exiting 126 -> FailClosed', () => {
  const rec = recSpawn((cmd) => (isFetch(cmd) ? { status: 126 } : {}));
  assert.throws(() => seamsWith(rec).fetchOrigin('/abs/dir'), (err) => err instanceof FailClosed);
});

test('ENF-25 WTREE-04 seam: a credentialed fetch stderr reaches the FetchUnavailable message redacted', () => {
  const rec = recSpawn((cmd) =>
    isFetch(cmd) ? { status: 128, stderr: "fatal: unable to access 'https://user:s3cr3t@example.invalid/r.git/': Could not resolve host\n" } : {}
  );
  assert.throws(
    () => seamsWith(rec).fetchOrigin('/abs/dir'),
    (err) => err instanceof gateModule.FetchUnavailable && err.message.includes('https://***@example.invalid') && !err.message.includes('s3cr3t')
  );
});

test('ENF-25 WTREE-04 seam: a reduced belt also shortens the coreutils duration so git is killed before the belt', () => {
  const rec = recSpawn();
  seamsWith(rec, { budget: (cap) => Math.min(cap, 9000) }).fetchOrigin('/abs/dir');
  const f = rec.calls.find((c) => isFetch(c.cmd));
  assert.strictEqual(f.opts.timeout, 9000);
  const duration = Number(f.args[2]);
  const killAfter = Number(f.args[1]);
  assert.ok(duration >= 1 && (duration + killAfter) * 1000 < 9000, JSON.stringify(f.args));
});

// ───────────────────────── 37-04 WTREE-04 e2e: spawned ask on real fixtures ─────────────────────────
//
// proof-harness spawnHook treats `ask` as inconclusive, so these rows spawn the hook directly with
// an absolute process.execPath and parse stdout (36-04 precedent). No network: an unreachable origin
// is a nonexistent local path; timeouts and remote stderr come from a fake `timeout` on a PATH that
// holds ONLY a temp bin dir (plus a `git` symlink to the real git).

const childProcess = require('node:child_process');

function spawnRaw(dir, command, env) {
  const r = childProcess.spawnSync(process.execPath, [HOOK], {
    input: input(command),
    cwd: dir,
    env: env || process.env,
    encoding: 'utf8',
  });
  assert.strictEqual(r.status, 0, 'hook exit ' + r.status + ' ' + r.stderr);
  const out = JSON.parse(r.stdout).hookSpecificOutput;
  return { decision: out.permissionDecision, reason: out.permissionDecisionReason || '' };
}

function realGit() {
  for (const d of String(process.env.PATH || '').split(path.delimiter)) {
    if (!d) continue;
    const p = path.join(d, 'git');
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      // keep looking
    }
  }
  throw new Error('no git on PATH');
}

/** A temp bin dir holding `git` (symlink to the real git) and, when `timeoutScript`, a fake `timeout`. */
function fakeBin(timeoutScript) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'wtfb-bin-'));
  fs.symlinkSync(realGit(), path.join(bin, 'git'));
  if (timeoutScript !== null) {
    fs.writeFileSync(path.join(bin, 'timeout'), timeoutScript);
    fs.chmodSync(path.join(bin, 'timeout'), 0o755);
  }
  return bin;
}

function envWithPath(bin) {
  return Object.assign({}, process.env, { PATH: bin });
}

const CUT = (fx) => 'git worktree add -b feat ' + path.join(fx.root, 'wt') + ' next';

test('ENF-25 WTREE-04 e2e: origin URL is a nonexistent path -> ask; refs/heads/next unchanged', () => {
  const fx = makeFixture();
  try {
    fx.advanceOrigin();
    git(fx.A, 'remote', 'set-url', 'origin', path.join(fx.root, 'nope', 'open-gsd', 'gsd-core.git'));
    const r = spawnRaw(fx.A, CUT(fx));
    assert.strictEqual(r.decision, 'ask', r.reason);
    assert.match(r.reason, /ENF-25/);
    assert.match(r.reason, /fetch origin next/);
    assert.match(r.reason, /dangerously-skip-permissions/);
    assert.strictEqual(refOf(fx.A, 'refs/heads/next'), fx.initial);
  } finally {
    fx.dispose();
  }
});

test('ENF-25 MA-01 e2e: no `origin` remote -> not an open-gsd/gsd-core clone: allow with no fetch; refs/heads/next unchanged', () => {
  const fx = makeFixture();
  try {
    git(fx.A, 'remote', 'remove', 'origin');
    const r = spawnRaw(fx.A, CUT(fx));
    assert.strictEqual(r.decision, 'allow', r.reason);
    assert.strictEqual(refOf(fx.A, 'refs/heads/next'), fx.initial);
  } finally {
    fx.dispose();
  }
});

test('ENF-25 WTREE-04 e2e: a fake `timeout` exiting 124 -> ask naming a timeout; refs/heads/next unchanged', () => {
  const fx = makeFixture();
  const bin = fakeBin('#!/bin/sh\nexit 124\n');
  try {
    fx.advanceOrigin();
    const r = spawnRaw(fx.A, CUT(fx), envWithPath(bin));
    assert.strictEqual(r.decision, 'ask', r.reason);
    assert.match(r.reason, /timed out/);
    assert.strictEqual(refOf(fx.A, 'refs/heads/next'), fx.initial);
  } finally {
    fx.dispose();
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test('ENF-25 WTREE-04 e2e: a fake `timeout` printing a credentialed URL and exiting 128 -> ask with the credentials redacted', () => {
  const fx = makeFixture();
  const bin = fakeBin(
    "#!/bin/sh\necho \"fatal: unable to access 'https://user:s3cr3t@example.invalid/r.git/': Could not resolve host\" >&2\nexit 128\n"
  );
  try {
    const r = spawnRaw(fx.A, CUT(fx), envWithPath(bin));
    assert.strictEqual(r.decision, 'ask', r.reason);
    assert.ok(r.reason.includes('***@example.invalid'), r.reason);
    assert.ok(!r.reason.includes('s3cr3t'), r.reason);
    assert.strictEqual(refOf(fx.A, 'refs/heads/next'), fx.initial);
  } finally {
    fx.dispose();
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test('ENF-25 WTREE-04 e2e: a concurrent git holding the origin/next ref lock -> ask; next and origin/next unchanged', () => {
  const fx = makeFixture();
  try {
    fx.advanceOrigin();
    const remoteBefore = refOf(fx.A, 'refs/remotes/origin/next');
    const lock = path.join(fx.A, '.git', 'refs', 'remotes', 'origin', 'next.lock');
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, '');
    const r = spawnRaw(fx.A, CUT(fx));
    assert.strictEqual(r.decision, 'ask', r.reason);
    assert.strictEqual(refOf(fx.A, 'refs/heads/next'), fx.initial);
    assert.strictEqual(refOf(fx.A, 'refs/remotes/origin/next'), remoteBefore);
  } finally {
    fx.dispose();
  }
});

test('ENF-25 WTREE-04 e2e: no coreutils `timeout` on PATH -> DENY (the fetch cannot be bounded), not ask; next unchanged', () => {
  const fx = makeFixture();
  const bin = fakeBin(null);
  try {
    fx.advanceOrigin();
    const r = spawnRaw(fx.A, CUT(fx), envWithPath(bin));
    assert.strictEqual(r.decision, 'deny', r.reason);
    assert.match(r.reason, /`timeout`/);
    assert.strictEqual(refOf(fx.A, 'refs/heads/next'), fx.initial);
  } finally {
    fx.dispose();
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

// ───────────────────────── 37-05 WTREE-01: the worktree.baseRef cascade ─────────────────────────
//
// Addendum 4: mirror gsd-core's resolveEffectiveBaseRef precedence — <root>/.claude/settings.local.json,
// then <root>/.claude/settings.json, then <homedir>/.claude/settings.json (skipped when it is the
// same file as layer 2). A layer counts only when `worktree` is a non-array object with a string
// `baseRef`; the effective value is `head` only for the exact string 'head', else `fresh`.

const BR_ROOT = path.join(path.sep, 'r');
const BR_HOME = path.join(path.sep, 'h');
const L1 = path.join(BR_ROOT, '.claude', 'settings.local.json');
const L2 = path.join(BR_ROOT, '.claude', 'settings.json');
const L3 = path.join(BR_HOME, '.claude', 'settings.json');
const HEAD_JSON = '{"worktree":{"baseRef":"head"}}';
const FRESH_JSON = '{"worktree":{"baseRef":"fresh"}}';

/** An injected settings reader over a path -> text table, recording every path it is asked for. */
function tableReader(table) {
  const asked = [];
  const read = (p) => {
    asked.push(p);
    return Object.prototype.hasOwnProperty.call(table, p) ? table[p] : null;
  };
  return { read, asked };
}

const BASEREF_TABLE = [
  ['only layer 1 (settings.local.json) says head -> head', { [L1]: HEAD_JSON }, 'head'],
  ['only layer 2 (project settings.json) says head -> head', { [L2]: HEAD_JSON }, 'head'],
  ['only layer 3 (user settings.json) says head -> head', { [L3]: HEAD_JSON }, 'head'],
  ['layer 1 fresh beats layer 3 head -> fresh', { [L1]: FRESH_JSON, [L3]: HEAD_JSON }, 'fresh'],
  ['layer 2 fresh beats layer 3 head -> fresh', { [L2]: FRESH_JSON, [L3]: HEAD_JSON }, 'fresh'],
  ['layer 1 malformed JSON contributes nothing; layer 2 head -> head', { [L1]: '{bad', [L2]: HEAD_JSON }, 'head'],
  ['layer 1 `worktree` is an array (ignored); layer 3 head -> head', { [L1]: '{"worktree":["head"]}', [L3]: HEAD_JSON }, 'head'],
  ['layer 1 baseRef is a number (falls through); layer 3 head -> head', { [L1]: '{"worktree":{"baseRef":1}}', [L3]: HEAD_JSON }, 'head'],
  ['layer 1 baseRef is a number and nothing else -> fresh', { [L1]: '{"worktree":{"baseRef":1}}' }, 'fresh'],
  ['layer 1 `worktree` null / without baseRef falls through; layer 2 head -> head', { [L1]: '{"worktree":null}', [L2]: '{"worktree":{}}', [L3]: HEAD_JSON }, 'head'],
  ['a top-level JSON array or `null` contributes nothing -> fresh', { [L1]: '["head"]', [L2]: 'null' }, 'fresh'],
  ['all three layers absent -> fresh (the default)', {}, 'fresh'],
  ['`HEAD` (uppercase) is not head -> fresh', { [L1]: '{"worktree":{"baseRef":"HEAD"}}' }, 'fresh'],
  ['an unknown string (`bogus`) wins the layer but is not head -> fresh', { [L1]: '{"worktree":{"baseRef":"bogus"}}', [L3]: HEAD_JSON }, 'fresh'],
];

for (const [name, table, want] of BASEREF_TABLE) {
  test('ENF-25 baseRef: ' + name, () => {
    const readBaseRef = exp('readBaseRef');
    const { read } = tableReader(table);
    assert.strictEqual(readBaseRef(BR_ROOT, BR_HOME, read), want);
  });
}

test('ENF-25 baseRef: the reader is asked for exactly the three layers, in order, and nothing else', () => {
  const readBaseRef = exp('readBaseRef');
  const { read, asked } = tableReader({});
  assert.strictEqual(readBaseRef(BR_ROOT, BR_HOME, read), 'fresh');
  assert.deepStrictEqual(asked, [L1, L2, L3]);
});

test('ENF-25 baseRef: the first layer that answers stops the cascade (layer 1 head -> layers 2 and 3 not read)', () => {
  const readBaseRef = exp('readBaseRef');
  const { read, asked } = tableReader({ [L1]: HEAD_JSON });
  assert.strictEqual(readBaseRef(BR_ROOT, BR_HOME, read), 'head');
  assert.deepStrictEqual(asked, [L1]);
});

test('ENF-25 baseRef: homedir equal to root -> layer 3 (the same file as layer 2) is not read', () => {
  const readBaseRef = exp('readBaseRef');
  const { read, asked } = tableReader({});
  assert.strictEqual(readBaseRef(BR_ROOT, BR_ROOT + path.sep, read), 'fresh');
  assert.deepStrictEqual(asked, [L1, L2], 'two reads, not three');
});

test('ENF-25 baseRef: MAX_SETTINGS_BYTES is 1 MiB', () => {
  assert.strictEqual(exp('MAX_SETTINGS_BYTES'), 1048576);
});

/** A temp project root + temp homedir, each with a `.claude` dir; the caller writes the layers. */
function settingsDirs() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wtfb-set-'));
  const root = path.join(base, 'root');
  const home = path.join(base, 'home');
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  return { root, home, dispose: () => fs.rmSync(base, { recursive: true, force: true }) };
}

test('ENF-25 baseRef: default reader, a small regular settings.local.json saying head -> head (positive control)', () => {
  const readBaseRef = exp('readBaseRef');
  const d = settingsDirs();
  try {
    fs.writeFileSync(path.join(d.root, '.claude', 'settings.local.json'), HEAD_JSON);
    assert.strictEqual(readBaseRef(d.root, d.home), 'head');
  } finally {
    d.dispose();
  }
});

test('ENF-25 baseRef: default reader, a regular file over MAX_SETTINGS_BYTES is ignored (layer 3 head is not reached past it -> it falls through)', () => {
  const readBaseRef = exp('readBaseRef');
  const max = exp('MAX_SETTINGS_BYTES');
  const d = settingsDirs();
  try {
    // Valid JSON saying head, padded past the cap: ignored, so the cascade falls through to layer 2 fresh.
    fs.writeFileSync(path.join(d.root, '.claude', 'settings.local.json'), HEAD_JSON + ' '.repeat(max));
    fs.writeFileSync(path.join(d.root, '.claude', 'settings.json'), FRESH_JSON);
    fs.writeFileSync(path.join(d.home, '.claude', 'settings.json'), HEAD_JSON);
    assert.strictEqual(readBaseRef(d.root, d.home), 'fresh');
    // And alone (no other layer) it yields the default.
    fs.rmSync(path.join(d.root, '.claude', 'settings.json'));
    fs.rmSync(path.join(d.home, '.claude', 'settings.json'));
    assert.strictEqual(readBaseRef(d.root, d.home), 'fresh');
  } finally {
    d.dispose();
  }
});

test('ENF-25 baseRef: default reader, a directory at the settings path is ignored (falls through to layer 2 head)', () => {
  const readBaseRef = exp('readBaseRef');
  const d = settingsDirs();
  try {
    fs.mkdirSync(path.join(d.root, '.claude', 'settings.local.json'));
    fs.writeFileSync(path.join(d.root, '.claude', 'settings.json'), HEAD_JSON);
    assert.strictEqual(readBaseRef(d.root, d.home), 'head');
  } finally {
    d.dispose();
  }
});

test('ENF-25 baseRef: default reader, missing files are ignored (only layer 3 present says head -> head; none -> fresh)', () => {
  const readBaseRef = exp('readBaseRef');
  const d = settingsDirs();
  try {
    assert.strictEqual(readBaseRef(d.root, d.home), 'fresh');
    fs.writeFileSync(path.join(d.home, '.claude', 'settings.json'), HEAD_JSON);
    assert.strictEqual(readBaseRef(d.root, d.home), 'head');
  } finally {
    d.dispose();
  }
});

test('ENF-25 baseRef: default reader never writes: the temp settings dirs are byte-identical after a read', () => {
  const readBaseRef = exp('readBaseRef');
  const d = settingsDirs();
  try {
    fs.writeFileSync(path.join(d.root, '.claude', 'settings.local.json'), '{bad');
    const before = [d.root, d.home].map((x) => fs.readdirSync(path.join(x, '.claude')).join(','));
    readBaseRef(d.root, d.home);
    const after = [d.root, d.home].map((x) => fs.readdirSync(path.join(x, '.claude')).join(','));
    assert.deepStrictEqual(after, before);
    assert.strictEqual(fs.readFileSync(path.join(d.root, '.claude', 'settings.local.json'), 'utf8'), '{bad');
  } finally {
    d.dispose();
  }
});

// ───────────────────────── 37-05 WTREE-01: the EnterWorktree surface (unit) ─────────────────────────
//
// `path` (non-empty string) enters an existing worktree: no cut, zero work. Every other shape is a
// cut on a new branch (spec-less probe: unknown / empty shapes are treated as a cut, the conservative
// reading): the repo is the hook cwd, the base comes from worktree.baseRef (fresh -> origin/next,
// head -> current HEAD), judged by the same freshness rules as a Bash cut.

/** An EnterWorktree payload; `toolInput === OMIT` drops the tool_input key entirely. */
const OMIT = Symbol('omit');
function ewInput(toolInput) {
  const o = { tool_name: 'EnterWorktree' };
  if (toolInput !== OMIT) o.tool_input = toolInput;
  return JSON.stringify(o);
}

test('ENF-25 EnterWorktree: `path` given (enter an existing worktree) allows with ZERO resolve, readBaseRef, fetch and git calls', () => {
  const { deps, calls } = scenario({ baseRef: 'head', branch: 'next' });
  const d = runWorktreeFreshBaseGate(ewInput({ path: '/w/wt' }), deps);
  assert.strictEqual(d.permissionDecision, 'allow');
  assert.strictEqual(calls.resolveTreeRoot, 0);
  assert.strictEqual(calls.readBaseRef, 0);
  assert.strictEqual(calls.fetchOrigin, 0);
  assert.strictEqual(calls.currentBranch + calls.revParse + calls.isAncestor + calls.worktreesHolding + calls.casUpdateRef, 0);
});

test('ENF-25 EnterWorktree: a `command` field riding on an EnterWorktree `path` payload is NOT scanned as Bash (allow, zero work)', () => {
  const { deps, calls } = scenario();
  const d = runWorktreeFreshBaseGate(ewInput({ path: '/w/wt', command: 'git worktree add p next' }), deps);
  assert.strictEqual(d.permissionDecision, 'allow');
  assert.strictEqual(calls.resolveTreeRoot + calls.readBaseRef + calls.fetchOrigin, 0);
});

const EW_CUT_SHAPES = [
  ['`name` given', { name: 'x' }],
  ['`name` absent (`{}`)', {}],
  ['`tool_input` missing', OMIT],
  ['`tool_input` null', null],
  ['`path` empty string', { path: '' }],
  ['`path` non-string (42)', { path: 42 }],
];

for (const [name, ti] of EW_CUT_SHAPES) {
  test('ENF-25 EnterWorktree: ' + name + ' is a cut -> resolveTreeRoot(cwd) once, readBaseRef once (root, homedir)', () => {
    const { deps, calls } = scenario();
    const d = runWorktreeFreshBaseGate(ewInput(ti), deps);
    assert.strictEqual(d.permissionDecision, 'allow');
    assert.strictEqual(calls.resolveTreeRoot, 1);
    assert.deepStrictEqual(calls.dirs, [FAKE_CWD], 'the repo is the hook cwd');
    assert.strictEqual(calls.readBaseRef, 1);
    assert.deepStrictEqual(calls.readBaseRefArgs[0].slice(0, 2), [FAKE_CWD, path.join(path.sep, 'h')]);
  });
}

test('ENF-25 EnterWorktree: not a gsd-core checkout (resolveTreeRoot null) -> allow, readBaseRef 0, fetch 0', () => {
  const { deps, calls } = scenario({ resolveTreeRoot: () => { calls.resolveTreeRoot += 1; return null; } });
  const d = runWorktreeFreshBaseGate(ewInput({ name: 'x' }), deps);
  assert.strictEqual(d.permissionDecision, 'allow');
  // Distinguishes the 37-04 gate (which did no work at all): the root lookup must have run.
  assert.strictEqual(calls.resolveTreeRoot, 1);
  assert.strictEqual(calls.readBaseRef, 0);
  assert.strictEqual(calls.fetchOrigin, 0);
});

test('ENF-25 EnterWorktree: fresh -> fetch once, allow, local next untouched (casUpdateRef 0)', () => {
  const { deps, calls } = scenario({ baseRef: 'fresh', branch: 'next' });
  const d = runWorktreeFreshBaseGate(ewInput({ name: 'x' }), deps);
  assert.strictEqual(d.permissionDecision, 'allow');
  assert.strictEqual(calls.fetchOrigin, 1);
  assert.deepStrictEqual(calls.fetchDirs, [FAKE_CWD]);
  assert.strictEqual(calls.casUpdateRef, 0);
  assert.strictEqual(calls.currentBranch, 0, 'fresh does not depend on the current branch');
  assert.deepStrictEqual(calls.order.slice(0, 2), ['readBaseRef', 'fetchOrigin']);
});

test('ENF-25 EnterWorktree: fresh with an unobtainable origin (FetchUnavailable) -> ask naming ENF-25', () => {
  const { deps, calls } = scenario({ baseRef: 'fresh', fetchOrigin: unavailable('unreachable') });
  const d = runWorktreeFreshBaseGate(ewInput({ name: 'x' }), deps);
  assert.strictEqual(d.permissionDecision, 'ask');
  assert.match(d.permissionDecisionReason, /ENF-25/);
  assert.match(d.permissionDecisionReason, /dangerously-skip-permissions/);
  assert.strictEqual(calls.casUpdateRef, 0);
});

test('ENF-25 EnterWorktree: fresh, fetch ok but origin/next missing -> ask', () => {
  const { deps } = scenario({ baseRef: 'fresh', refs: { 'refs/remotes/origin/next': null } });
  const d = runWorktreeFreshBaseGate(ewInput({ name: 'x' }), deps);
  assert.strictEqual(d.permissionDecision, 'ask');
  assert.match(d.permissionDecisionReason, /origin\/next does not resolve/);
});

test('ENF-25 EnterWorktree: an unrecognised readBaseRef result is treated as fresh (fetch once, allow)', () => {
  const { deps, calls } = scenario({ baseRef: undefined });
  const d = runWorktreeFreshBaseGate(ewInput({ name: 'x' }), deps);
  assert.strictEqual(d.permissionDecision, 'allow');
  assert.strictEqual(calls.fetchOrigin, 1);
  assert.strictEqual(calls.currentBranch, 0);
});

test('ENF-25 EnterWorktree: head + current branch `work` -> allow, fetch 0', () => {
  const { deps, calls } = scenario({ baseRef: 'head', branch: 'work' });
  const d = runWorktreeFreshBaseGate(ewInput({ name: 'x' }), deps);
  assert.strictEqual(d.permissionDecision, 'allow');
  assert.strictEqual(calls.currentBranch, 1);
  assert.strictEqual(calls.fetchOrigin, 0);
});

test('ENF-25 EnterWorktree: head + detached HEAD -> allow, fetch 0', () => {
  const { deps, calls } = scenario({ baseRef: 'head', branch: null });
  const d = runWorktreeFreshBaseGate(ewInput({ name: 'x' }), deps);
  assert.strictEqual(d.permissionDecision, 'allow');
  // Distinguishes the 37-04 gate (which did no work at all): the branch read must have run.
  assert.strictEqual(calls.currentBranch, 1);
  assert.strictEqual(calls.fetchOrigin, 0);
});

test('ENF-25 EnterWorktree: head + `next` behind origin/next, held by the root -> POLICY deny with `git -C <root> merge --ff-only origin/next`', () => {
  const { deps, calls } = scenario({ baseRef: 'head', branch: 'next', held: [FAKE_CWD] });
  const d = runWorktreeFreshBaseGate(ewInput({ name: 'x' }), deps);
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.ok(d.permissionDecisionReason.includes('git -C ' + FAKE_CWD + ' merge --ff-only origin/next'), d.permissionDecisionReason);
  assert.strictEqual(calls.fetchOrigin, 1);
  assert.strictEqual(calls.casUpdateRef, 0);
});

test('ENF-25 EnterWorktree: the head-on-next deny is NOT override-escapable (zero receipts)', () => {
  const o = yesOverride();
  const { deps } = scenario({ baseRef: 'head', branch: 'next', held: [FAKE_CWD], overrideImpl: o.overrideImpl });
  const d = runWorktreeFreshBaseGate(ewInput({ name: 'x' }), deps);
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.strictEqual(o.receipts.length, 0);
});

test('ENF-25 EnterWorktree: head + `next` equal to origin/next -> allow, no CAS', () => {
  const { deps, calls } = scenario({ baseRef: 'head', branch: 'next', refs: { 'refs/heads/next': SHA_REMOTE } });
  const d = runWorktreeFreshBaseGate(ewInput({ name: 'x' }), deps);
  assert.strictEqual(d.permissionDecision, 'allow');
  assert.strictEqual(calls.fetchOrigin, 1);
  assert.strictEqual(calls.casUpdateRef, 0);
});

test('ENF-25 EnterWorktree: head + `next` diverged from origin/next -> deny naming the divergence', () => {
  const { deps } = scenario({ baseRef: 'head', branch: 'next', ancestor: DIVERGED });
  const d = runWorktreeFreshBaseGate(ewInput({ name: 'x' }), deps);
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /diverged/);
});

test('ENF-25 EnterWorktree: a hook env carrying GIT_DIR makes a cut unattributable -> the constant uncertain deny, ZERO resolve and fetch', () => {
  const { deps, calls } = scenario({ hookEnv: { GIT_DIR: '/x/.git' } });
  const d = runWorktreeFreshBaseGate(ewInput({ name: 'x' }), deps);
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /cannot attribute/);
  assert.strictEqual(calls.resolveTreeRoot + calls.readBaseRef + calls.fetchOrigin, 0);
});

test('ENF-25 EnterWorktree: a hook env carrying GIT_DIR does not touch a `path` entry (allow, zero work)', () => {
  const { deps, calls } = scenario({ hookEnv: { GIT_DIR: '/x/.git' } });
  const d = runWorktreeFreshBaseGate(ewInput({ path: '/w/wt' }), deps);
  assert.strictEqual(d.permissionDecision, 'allow');
  assert.strictEqual(calls.resolveTreeRoot + calls.readBaseRef + calls.fetchOrigin, 0);
});

test('ENF-25 EnterWorktree: a readBaseRef that THROWS fails closed (deny via runGate)', () => {
  const { deps } = scenario({ readBaseRef: () => { throw new Error('boom'); } });
  const d = runWorktreeFreshBaseGate(ewInput({ name: 'x' }), deps);
  assert.strictEqual(d.permissionDecision, 'deny');
});

// ───────────────────────── 37-05 WTREE-01: EnterWorktree e2e (spawned hook, real fixture) ─────────────────────────
//
// The mode is pinned with a project `.claude/settings.local.json` written into clone A (layer 1),
// and the spawned hook runs with HOME = a temp dir whose user settings.json says the OPPOSITE mode,
// so the user's real ~/.claude/settings.json is unreachable by construction and every row also
// proves layer 1 beats layer 3. spawnSync directly (spawnHook treats ask as inconclusive).

/** Write `{"worktree":{"baseRef":mode}}` to <dir>/.claude/<file> (temp fixtures only). */
function pinBaseRef(dir, mode, file) {
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', file || 'settings.local.json'), JSON.stringify({ worktree: { baseRef: mode } }));
}

/** Spawn the real hook with an EnterWorktree payload from `dir`, HOME = a temp dir saying `homeMode`. */
function spawnEnterWorktree(dir, toolInput, homeMode) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wtfb-home-'));
  try {
    if (homeMode) pinBaseRef(home, homeMode, 'settings.json');
    const r = childProcess.spawnSync(process.execPath, [HOOK], {
      input: ewInput(toolInput),
      cwd: dir,
      env: Object.assign({}, process.env, { HOME: home }),
      encoding: 'utf8',
    });
    assert.strictEqual(r.status, 0, 'hook exit ' + r.status + ' ' + r.stderr);
    const out = JSON.parse(r.stdout).hookSpecificOutput;
    return { decision: out.permissionDecision, reason: out.permissionDecisionReason || '' };
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('ENF-25 EnterWorktree e2e: fresh pinned, A on work, origin advanced, `name` -> allow; origin/next fetched to the tip, local next unchanged', () => {
  const fx = makeFixture();
  try {
    pinBaseRef(fx.A, 'fresh');
    const tip = fx.advanceOrigin();
    const r = spawnEnterWorktree(fx.A, { name: 'x' }, 'head');
    assert.strictEqual(r.decision, 'allow', r.reason);
    assert.strictEqual(refOf(fx.A, 'refs/remotes/origin/next'), tip, 'the gate fetch must advance origin/next');
    assert.strictEqual(refOf(fx.A, 'refs/heads/next'), fx.initial, 'a fresh cut never touches local next');
  } finally {
    fx.dispose();
  }
});

test('ENF-25 EnterWorktree e2e: head pinned, A on next, origin advanced -> deny naming A and `merge --ff-only origin/next`; next unchanged', () => {
  const fx = makeFixture({ park: false });
  try {
    pinBaseRef(fx.A, 'head');
    const tip = fx.advanceOrigin();
    const r = spawnEnterWorktree(fx.A, { name: 'x' }, 'fresh');
    assert.strictEqual(r.decision, 'deny', r.reason);
    assert.ok(r.reason.includes('git -C ' + fs.realpathSync(fx.A) + ' merge --ff-only origin/next'), r.reason);
    assert.strictEqual(refOf(fx.A, 'refs/heads/next'), fx.initial, 'a checked-out next is never moved');
    assert.strictEqual(refOf(fx.A, 'refs/remotes/origin/next'), tip, 'the fetch ran');
  } finally {
    fx.dispose();
  }
});

test('ENF-25 EnterWorktree e2e: head pinned, A on work, origin advanced -> allow; origin/next unchanged (no fetch)', () => {
  const fx = makeFixture();
  try {
    pinBaseRef(fx.A, 'head');
    fx.advanceOrigin();
    const r = spawnEnterWorktree(fx.A, { name: 'x' }, 'fresh');
    assert.strictEqual(r.decision, 'allow', r.reason);
    assert.strictEqual(refOf(fx.A, 'refs/remotes/origin/next'), fx.initial, 'a HEAD base off next does not fetch');
    assert.strictEqual(refOf(fx.A, 'refs/heads/next'), fx.initial);
  } finally {
    fx.dispose();
  }
});

test('ENF-25 EnterWorktree e2e: `path` (enter an existing worktree) from A, origin advanced -> allow; origin/next unchanged', () => {
  const fx = makeFixture();
  try {
    pinBaseRef(fx.A, 'fresh');
    fx.advanceOrigin();
    const r = spawnEnterWorktree(fx.A, { path: path.join(fx.root, 'wt') }, 'fresh');
    assert.strictEqual(r.decision, 'allow', r.reason);
    assert.strictEqual(refOf(fx.A, 'refs/remotes/origin/next'), fx.initial, 'entering a worktree does no work');
    assert.strictEqual(refOf(fx.A, 'refs/heads/next'), fx.initial);
  } finally {
    fx.dispose();
  }
});

test('ENF-25 EnterWorktree e2e: fresh pinned in a plain clone with no gsd-core sentinel -> allow; origin/next unchanged', () => {
  const fx = makeFixture({ sentinel: false });
  try {
    for (let d = fx.A; ; d = path.dirname(d)) {
      assert.strictEqual(hasSentinel(d), false, 'unexpected gsd-core sentinel at ' + d);
      if (path.dirname(d) === d) break;
    }
    pinBaseRef(fx.A, 'fresh');
    fx.advanceOrigin();
    const r = spawnEnterWorktree(fx.A, { name: 'x' }, 'fresh');
    assert.strictEqual(r.decision, 'allow', r.reason);
    assert.strictEqual(refOf(fx.A, 'refs/remotes/origin/next'), fx.initial);
    assert.strictEqual(refOf(fx.A, 'refs/heads/next'), fx.initial);
  } finally {
    fx.dispose();
  }
});

test('ENF-25 EnterWorktree e2e: fresh pinned, A\'s origin is a nonexistent path -> ask naming ENF-25 and its limit; next unchanged', () => {
  const fx = makeFixture();
  try {
    pinBaseRef(fx.A, 'fresh');
    fx.advanceOrigin();
    git(fx.A, 'remote', 'set-url', 'origin', path.join(fx.root, 'nope', 'open-gsd', 'gsd-core.git'));
    const r = spawnEnterWorktree(fx.A, { name: 'x' }, 'head');
    assert.strictEqual(r.decision, 'ask', r.reason);
    assert.match(r.reason, /ENF-25/);
    assert.match(r.reason, /dangerously-skip-permissions/);
    assert.strictEqual(refOf(fx.A, 'refs/heads/next'), fx.initial);
    assert.strictEqual(refOf(fx.A, 'refs/remotes/origin/next'), fx.initial);
  } finally {
    fx.dispose();
  }
});

// ───────────────────────── 37-REVIEW fixes ─────────────────────────
//
// One block per 37-REVIEW finding. Real-git rows use the temp bare-origin + clone fixture only.

/** `git status --porcelain` of a tree, trimmed ('' = clean). */
function porcelain(dir) {
  return git(dir, 'status', '--porcelain').trim();
}

// ── BL-01: a symbolic refs/heads/next is never read through or moved ──

test('ENF-25 BL-01: a symbolic refs/heads/next denies (thrown, constant reason) with ZERO fetch and ZERO CAS', () => {
  const { deps, calls } = scenario({ symbolic: true });
  const d = runWorktreeFreshBaseGate(input('git worktree add -b f p next'), deps);
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /ENF-25/);
  assert.match(d.permissionDecisionReason, /symbolic ref/);
  assert.strictEqual(calls.isSymbolicRef, 1);
  assert.strictEqual(calls.fetchOrigin, 0);
  assert.strictEqual(calls.casUpdateRef, 0);
});

test('ENF-25 BL-01: the symbolic-next deny is THROWN (override-escapable, one receipt) and still moves nothing', () => {
  const o = yesOverride();
  const { deps, calls } = scenario({ symbolic: true, overrideImpl: o.overrideImpl });
  const d = runWorktreeFreshBaseGate(input('git worktree add -b f p next'), deps);
  assert.strictEqual(d.permissionDecision, 'allow');
  assert.strictEqual(o.receipts.length, 1);
  assert.strictEqual(calls.casUpdateRef, 0);
});

test('ENF-25 BL-01: a HEAD base on `next` checks the symref too; a remote base never asks for it', () => {
  const head = scenario({ symbolic: true, branch: 'next' });
  assert.strictEqual(runWorktreeFreshBaseGate(input('git worktree add -b f p'), head.deps).permissionDecision, 'deny');
  assert.strictEqual(head.calls.casUpdateRef, 0);
  const remote = scenario({ symbolic: true });
  assert.strictEqual(runWorktreeFreshBaseGate(input('git worktree add -b f p origin/next'), remote.deps).permissionDecision, 'allow');
  assert.strictEqual(remote.calls.isSymbolicRef, 0);
});

test('ENF-25 BL-01 seam: default isSymbolicRef is false for a plain next and true for next -> work', () => {
  const fx = makeFixture();
  try {
    const seams = defaultSeams();
    assert.strictEqual(seams.isSymbolicRef(fx.A, 'refs/heads/next'), false);
    git(fx.A, 'update-ref', '-d', 'refs/heads/next');
    git(fx.A, 'symbolic-ref', 'refs/heads/next', 'refs/heads/work');
    assert.strictEqual(seams.isSymbolicRef(fx.A, 'refs/heads/next'), true);
  } finally {
    fx.dispose();
  }
});

test('ENF-25 BL-01 / NI-03 seam: default casUpdateRef passes --no-deref and --create-reflog before the ref', () => {
  const rec = recSpawn();
  seamsWith(rec).casUpdateRef('/abs/dir', 'refs/heads/next', SHA_REMOTE, SHA_LOCAL);
  assert.strictEqual(rec.calls.length, 1);
  const args = rec.calls[0].args;
  assert.strictEqual(args[0], 'update-ref');
  assert.ok(args.includes('--no-deref'), JSON.stringify(args));
  assert.ok(args.includes('--create-reflog'), JSON.stringify(args));
  assert.deepStrictEqual(args.slice(-3), ['refs/heads/next', SHA_REMOTE, SHA_LOCAL]);
});

test('ENF-25 NI-03: with core.logAllRefUpdates=false and no next reflog, the CAS still records an ENF-25 reflog entry', () => {
  const { fx, L, R } = fetchedFixture();
  try {
    git(fx.A, 'config', 'core.logAllRefUpdates', 'false');
    fs.rmSync(path.join(fx.A, '.git', 'logs', 'refs', 'heads', 'next'), { force: true });
    assert.strictEqual(defaultSeams().casUpdateRef(fx.A, 'refs/heads/next', R, L), true);
    const first = git(fx.A, 'reflog', 'show', '--format=%gs', 'refs/heads/next').split('\n')[0];
    assert.match(first, /ENF-25/);
  } finally {
    fx.dispose();
  }
});

test('ENF-25 BL-01 e2e (fx1): next is a symref to the CHECKED-OUT work -> deny; work unmoved, tree clean', () => {
  const fx = makeFixture();
  try {
    fx.advanceOrigin();
    git(fx.A, 'update-ref', '-d', 'refs/heads/next');
    git(fx.A, 'symbolic-ref', 'refs/heads/next', 'refs/heads/work');
    const work = refOf(fx.A, 'refs/heads/work');
    const r = spawnIn(fx.A, 'git worktree add -b f ' + path.join(fx.root, 'x') + ' next');
    assert.strictEqual(r.decision, 'deny', r.reason);
    assert.match(r.reason, /symbolic ref/);
    assert.strictEqual(refOf(fx.A, 'refs/heads/work'), work, 'the checked-out branch must not move');
    assert.strictEqual(porcelain(fx.A), '', 'the checked-out tree must stay clean');
    assert.strictEqual(git(fx.A, 'symbolic-ref', 'refs/heads/next').trim(), 'refs/heads/work');
  } finally {
    fx.dispose();
  }
});

// ── BL-02: a next being rebased or bisected in ANY worktree is held (git's own branch -f rule) ──

test('ENF-25 BL-02: next behind and mid-rebase in /w/W -> POLICY deny naming /w/W and rebase, ZERO CAS, zero receipts', () => {
  const o = yesOverride();
  const { deps, calls } = scenario({ inProgress: [{ path: '/w/W', op: 'rebase' }], overrideImpl: o.overrideImpl });
  const d = runWorktreeFreshBaseGate(input('git worktree add -b f p next'), deps);
  assert.strictEqual(d.permissionDecision, 'deny');
  const why = d.permissionDecisionReason;
  assert.match(why, /ENF-25/);
  assert.ok(why.includes('/w/W'), why);
  assert.match(why, /rebas/);
  assert.match(why, /rebase --continue|rebase --abort/);
  assert.ok(why.includes('git worktree add -b <branch> <path> origin/next'), why);
  assert.ok(!DESTRUCTIVE.test(why), why);
  assert.strictEqual(calls.casUpdateRef, 0);
  assert.strictEqual(o.receipts.length, 0, 'a returned policy deny writes no receipt');
});

test('ENF-25 BL-02: next behind and mid-bisect -> deny naming bisect reset', () => {
  const { deps, calls } = scenario({ inProgress: [{ path: '/w/B', op: 'bisect' }] });
  const d = runWorktreeFreshBaseGate(input('git worktree add -b f p next'), deps);
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /bisect reset/);
  assert.strictEqual(calls.casUpdateRef, 0);
});

test('ENF-25 BL-02: the in-progress check runs only on the move path (not for equal, ahead, held or remote)', () => {
  for (const over of [
    { refs: { 'refs/heads/next': SHA_REMOTE } },
    { ancestor: AHEAD },
    { held: ['/w/main'] },
  ]) {
    const { deps, calls } = scenario(over);
    runWorktreeFreshBaseGate(input('git worktree add -b f p next'), deps);
    assert.strictEqual(calls.nextInProgress, 0, JSON.stringify(over));
  }
  const { deps, calls } = scenario();
  runWorktreeFreshBaseGate(input('git worktree add -b f p origin/next'), deps);
  assert.strictEqual(calls.nextInProgress, 0);
});

/**
 * Fixture A on work with FOUR commits on next (origin advanced three times and next fast-forwarded
 * by setup, so a bisect has a midpoint to detach at) and a linked worktree W on next; origin is then
 * advanced again by the caller so local next is a strict ancestor of the remote tip.
 */
function twoCommitFixtureWithW() {
  const fx = makeFixture();
  fx.advanceOrigin();
  fx.advanceOrigin();
  fx.advanceOrigin();
  git(fx.A, 'fetch', '-q', 'origin', 'next');
  git(fx.A, 'update-ref', 'refs/heads/next', 'refs/remotes/origin/next');
  const W = path.join(fx.root, 'W');
  git(fx.A, 'worktree', 'add', '-q', W, 'next');
  return { fx, W, next: refOf(fx.A, 'refs/heads/next') };
}

function gitIn(dir, ...args) {
  return execFileSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...args], {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: Object.assign({}, process.env, { GIT_EDITOR: 'true' }),
  });
}

/** Stop an interactive rebase of next in W at a `break` before its first pick (HEAD detached). */
function startRebaseBreak(W) {
  try {
    gitIn(W, '-c', "sequence.editor=sed -i '1i break'", 'rebase', '-q', '-i', 'HEAD~1');
  } catch (err) {
    // `break` stops the rebase with exit 0 on most gits; tolerate a non-zero stop.
  }
  assert.ok(fs.existsSync(path.join(git(W, 'rev-parse', '--absolute-git-dir').trim(), 'rebase-merge', 'head-name')),
    'setup: W is mid-rebase');
}

test('ENF-25 BL-02 seam: default nextInProgress finds a linked worktree mid-rebase of next (porcelain shows it detached)', () => {
  const { fx, W } = twoCommitFixtureWithW();
  try {
    startRebaseBreak(W);
    const seams = defaultSeams();
    assert.deepStrictEqual(seams.worktreesHolding(fx.A, 'refs/heads/next'), [], 'precondition: porcelain misses it');
    assert.deepStrictEqual(seams.nextInProgress(fx.A, 'refs/heads/next'), [{ path: fs.realpathSync(W), op: 'rebase' }]);
  } finally {
    fx.dispose();
  }
});

test('ENF-25 BL-02 seam: default nextInProgress finds a linked worktree bisecting from next', () => {
  const { fx, W } = twoCommitFixtureWithW();
  try {
    gitIn(W, 'bisect', 'start', 'HEAD', 'HEAD~3');
    assert.deepStrictEqual(defaultSeams().nextInProgress(fx.A, 'refs/heads/next'), [{ path: fs.realpathSync(W), op: 'bisect' }]);
  } finally {
    fx.dispose();
  }
});

test('ENF-25 BL-02 seam: rebase-apply/head-name and rebase-merge/update-refs in the MAIN git dir count; nothing -> []', () => {
  const fx = makeFixture();
  try {
    const seams = defaultSeams();
    assert.deepStrictEqual(seams.nextInProgress(fx.A, 'refs/heads/next'), []);
    const gd = path.join(fx.A, '.git');
    fs.mkdirSync(path.join(gd, 'rebase-apply'));
    fs.writeFileSync(path.join(gd, 'rebase-apply', 'head-name'), 'refs/heads/next\n');
    assert.deepStrictEqual(seams.nextInProgress(fx.A, 'refs/heads/next'), [{ path: fs.realpathSync(fx.A), op: 'rebase' }]);
    fs.rmSync(path.join(gd, 'rebase-apply'), { recursive: true });
    fs.mkdirSync(path.join(gd, 'rebase-merge'));
    fs.writeFileSync(path.join(gd, 'rebase-merge', 'head-name'), 'refs/heads/work\n');
    fs.writeFileSync(path.join(gd, 'rebase-merge', 'update-refs'), 'refs/heads/next\n' + 'a'.repeat(40) + '\n' + 'b'.repeat(40) + '\n');
    assert.deepStrictEqual(seams.nextInProgress(fx.A, 'refs/heads/next'), [{ path: fs.realpathSync(fx.A), op: 'rebase' }]);
  } finally {
    fx.dispose();
  }
});

test('ENF-25 BL-02 e2e (fx2): next mid-rebase in linked worktree W, origin advanced -> deny naming W; next unchanged; rebase --continue lands', () => {
  const { fx, W, next } = twoCommitFixtureWithW();
  try {
    startRebaseBreak(W);
    fx.advanceOrigin();
    const r = spawnIn(fx.A, 'git worktree add -b f ' + path.join(fx.root, 'x') + ' next');
    assert.strictEqual(r.decision, 'deny', r.reason);
    assert.ok(r.reason.includes(fs.realpathSync(W)), r.reason);
    assert.strictEqual(refOf(fx.A, 'refs/heads/next'), next, 'next must not move under the rebase');
    gitIn(W, 'rebase', '--continue');
    assert.strictEqual(git(W, 'symbolic-ref', 'HEAD').trim(), 'refs/heads/next', 'the rebase lands back on next');
  } finally {
    fx.dispose();
  }
});

test('ENF-25 BL-02 e2e (fx2c): next mid-bisect in W, origin advanced -> deny; next unchanged', () => {
  const { fx, W, next } = twoCommitFixtureWithW();
  try {
    gitIn(W, 'bisect', 'start', 'HEAD', 'HEAD~3');
    fx.advanceOrigin();
    const r = spawnIn(fx.A, 'git worktree add -b f ' + path.join(fx.root, 'x') + ' next');
    assert.strictEqual(r.decision, 'deny', r.reason);
    assert.match(r.reason, /bisect/);
    assert.strictEqual(refOf(fx.A, 'refs/heads/next'), next);
  } finally {
    fx.dispose();
  }
});

// ── MA-01: arm (fetch / move) only when origin parses as open-gsd/gsd-core ──

for (const url of ['https://github.com/davesienkowski/gsd-core-experiments.git', 'git@github.com:someone/gsd-core.git', '/srv/other-origin.git', null]) {
  test('ENF-25 MA-01: origin ' + JSON.stringify(url) + ' is not open-gsd/gsd-core -> allow with ZERO fetch, symref, rev-parse and CAS', () => {
    const { deps, calls } = scenario({ originUrl: url });
    const d = runWorktreeFreshBaseGate(input('git worktree add -b f p next'), deps);
    assert.strictEqual(d.permissionDecision, 'allow');
    assert.strictEqual(calls.originUrl, 1);
    assert.strictEqual(calls.fetchOrigin, 0);
    assert.strictEqual(calls.isSymbolicRef, 0);
    assert.strictEqual(calls.revParse, 0);
    assert.strictEqual(calls.casUpdateRef, 0);
  });
}

for (const url of ['https://github.com/open-gsd/gsd-core.git', 'git@github.com:open-gsd/gsd-core.git', 'ssh://git@github.com/Open-GSD/gsd-core', '/tmp/x/open-gsd/gsd-core.git']) {
  test('ENF-25 MA-01: origin ' + url + ' arms the gate (fetch once, CAS once)', () => {
    const { deps, calls } = scenario({ originUrl: url });
    assert.strictEqual(runWorktreeFreshBaseGate(input('git worktree add -b f p next'), deps).permissionDecision, 'allow');
    assert.strictEqual(calls.fetchOrigin, 1);
    assert.strictEqual(calls.casUpdateRef, 1);
  });
}

test('ENF-25 MA-01: the origin check runs once per root, and after the HEAD-branch read (HEAD on work: ZERO originUrl)', () => {
  const two = scenario();
  runWorktreeFreshBaseGate(input('git worktree add -b a p next && git worktree add -b b q origin/next'), two.deps);
  assert.strictEqual(two.calls.originUrl, 1);
  const head = scenario({ branch: 'work' });
  runWorktreeFreshBaseGate(input('git worktree add -b f p'), head.deps);
  assert.strictEqual(head.calls.originUrl, 0);
});

test('ENF-25 MA-01: an EnterWorktree cut in a non-gsd-core origin allows with ZERO fetch', () => {
  const { deps, calls } = scenario({ originUrl: 'https://example.invalid/other/repo.git' });
  const d = runWorktreeFreshBaseGate(JSON.stringify({ tool_name: 'EnterWorktree', tool_input: { name: 'x' } }), deps);
  assert.strictEqual(d.permissionDecision, 'allow');
  assert.strictEqual(calls.fetchOrigin, 0);
});

test('ENF-25 MA-01 e2e (fx4): a sentinel vendored inside a NON-gsd-core repo -> allow; that repo is neither fetched nor moved', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wtfb-fx4-'));
  try {
    const origin = path.join(root, 'other-origin.git');
    const other = path.join(root, 'other');
    const writer = path.join(root, 'writer');
    git(root, '-c', 'init.defaultBranch=next', 'init', '-q', '--bare', origin);
    git(root, 'clone', '-q', origin, other);
    git(other, 'symbolic-ref', 'HEAD', 'refs/heads/next');
    const vendored = path.join(other, 'vendor', 'gsdc');
    fs.mkdirSync(path.join(vendored, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(vendored, 'gsd-core', 'bin', 'lib'), { recursive: true });
    fs.writeFileSync(path.join(vendored, 'scripts', 'pr-target-policy.cjs'), '');
    fs.writeFileSync(path.join(vendored, 'gsd-core', 'bin', 'lib', '.keep'), '');
    fs.writeFileSync(path.join(other, 'f.txt'), '1\n');
    const before = commitAll(other, 'init');
    git(other, 'push', '-q', 'origin', 'next');
    git(other, 'switch', '-q', '-c', 'work');
    git(root, 'clone', '-q', origin, writer);
    fs.writeFileSync(path.join(writer, 'f.txt'), '2\n');
    commitAll(writer, 'upstream');
    git(writer, 'push', '-q', 'origin', 'next');
    assert.ok(hasSentinel(vendored), 'setup: the vendored dir carries the gsd-core sentinel');

    const r = spawnIn(vendored, 'git worktree add -b f ' + path.join(root, 'x') + ' next');
    assert.strictEqual(r.decision, 'allow', r.reason);
    assert.strictEqual(refOf(other, 'refs/heads/next'), before, 'a non-gsd-core next must not move');
    assert.strictEqual(refOf(other, 'refs/remotes/origin/next'), before, 'a non-gsd-core origin must not be fetched');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── MA-02: an explicit refspec, so a narrowed remote.origin.fetch or a tag named next cannot leave origin/next stale ──

test('ENF-25 MA-02: FETCH_ARGV is the frozen explicit-refspec argv', () => {
  assert.deepStrictEqual([...exp('FETCH_ARGV')],
    ['fetch', '--quiet', '--no-auto-maintenance', '--no-tags', 'origin', '+refs/heads/next:refs/remotes/origin/next']);
  assert.ok(Object.isFrozen(exp('FETCH_ARGV')));
});

test('ENF-25 MA-02 e2e (fx7): a narrowed remote.origin.fetch still refreshes origin/next; the remote base and next both end current', () => {
  const fx = makeFixture();
  try {
    git(fx.A, 'config', 'remote.origin.fetch', '+refs/heads/main:refs/remotes/origin/main');
    const tip = fx.advanceOrigin();
    const r1 = spawnIn(fx.A, 'git worktree add -b f ' + path.join(fx.root, 'x') + ' origin/next');
    assert.strictEqual(r1.decision, 'allow', r1.reason);
    assert.strictEqual(refOf(fx.A, 'refs/remotes/origin/next'), tip, 'origin/next must be the remote tip, not the stale value');
    const r2 = spawnIn(fx.A, 'git worktree add -b g ' + path.join(fx.root, 'y') + ' next');
    assert.strictEqual(r2.decision, 'allow', r2.reason);
    assert.strictEqual(refOf(fx.A, 'refs/heads/next'), tip);
  } finally {
    fx.dispose();
  }
});

test('ENF-25 MA-02 e2e (fx7b): a TAG named next on origin does not shadow the branch; origin/next becomes the branch tip', () => {
  const fx = makeFixture();
  try {
    git(fx.B, 'tag', 'next');
    git(fx.B, 'push', '-q', 'origin', 'refs/tags/next');
    // advanceOrigin's `push origin next` is ambiguous once the tag exists: push the branch by full name.
    fs.writeFileSync(path.join(fx.B, 'tracked.txt'), 'upstream past the tag\n');
    const tip = commitAll(fx.B, 'upstream past the tag');
    git(fx.B, 'push', '-q', 'origin', 'refs/heads/next:refs/heads/next');
    const r = spawnIn(fx.A, 'git worktree add -b f ' + path.join(fx.root, 'x') + ' origin/next');
    assert.strictEqual(r.decision, 'allow', r.reason);
    assert.strictEqual(refOf(fx.A, 'refs/remotes/origin/next'), tip);
    assert.strictEqual(git(fx.A, 'tag', '--list', 'next').trim(), '', '--no-tags: the gate fetches no tag');
  } finally {
    fx.dispose();
  }
});

// ── MI-01: an unobtainable origin still denies when the LAST-FETCHED origin/next proves a held or diverged next ──

test('ENF-25 MI-01: fetch fails, existing origin/next proves next behind and HELD -> POLICY deny (not ask), naming the refresh failure; zero receipts', () => {
  const o = yesOverride();
  const { deps, calls } = scenario({ fetchOrigin: unavailable('`git fetch origin next` timed out after 15 s'), held: ['/w/main'], overrideImpl: o.overrideImpl });
  const d = runWorktreeFreshBaseGate(input('git worktree add -b f p next'), deps);
  assert.strictEqual(d.permissionDecision, 'deny', JSON.stringify(d));
  const why = d.permissionDecisionReason;
  assert.ok(why.includes('git -C /w/main merge --ff-only origin/next'), why);
  assert.match(why, /could not refresh/);
  assert.match(why, /timed out after 15 s/);
  assert.ok(!/just fetched/.test(why), 'a stale-evidence deny must not claim a fresh fetch: ' + why);
  assert.strictEqual(calls.casUpdateRef, 0);
  assert.strictEqual(o.receipts.length, 0);
});

test('ENF-25 MI-01: fetch fails, next behind and mid-rebase -> deny', () => {
  const { deps, calls } = scenario({ fetchOrigin: unavailable('x'), inProgress: [{ path: '/w/W', op: 'rebase' }] });
  const d = runWorktreeFreshBaseGate(input('git worktree add -b f p next'), deps);
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /could not refresh/);
  assert.strictEqual(calls.casUpdateRef, 0);
});

test('ENF-25 MI-01: fetch fails, next diverged from the last-fetched origin/next -> deny naming the divergence', () => {
  const { deps } = scenario({ fetchOrigin: unavailable('x'), ancestor: DIVERGED });
  const d = runWorktreeFreshBaseGate(input('git worktree add -b f p next'), deps);
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /diverged/);
  assert.match(d.permissionDecisionReason, /could not refresh/);
});

for (const [name, over] of [
  ['next equal to the last-fetched origin/next', { refs: { 'refs/heads/next': SHA_REMOTE } }],
  ['next AHEAD of the last-fetched origin/next', { ancestor: AHEAD }],
  ['no last-fetched origin/next at all', { refs: { 'refs/remotes/origin/next': null } }],
]) {
  test('ENF-25 MI-01: fetch fails and ' + name + ' -> ask (the local evidence cannot decide); no CAS', () => {
    const { deps, calls } = scenario(Object.assign({ fetchOrigin: unavailable('x'), held: ['/w/main'] }, over));
    const d = runWorktreeFreshBaseGate(input('git worktree add -b f p next'), deps);
    assert.strictEqual(d.permissionDecision, 'ask', JSON.stringify(d));
    assert.strictEqual(calls.casUpdateRef, 0);
  });
}

test('ENF-25 MI-01: fetch fails with a REMOTE base -> ask with ZERO rev-parse (nothing local can prove the remote current)', () => {
  const { deps, calls } = scenario({ fetchOrigin: unavailable('x'), held: ['/w/main'] });
  const d = runWorktreeFreshBaseGate(input('git worktree add -b f p origin/next'), deps);
  assert.strictEqual(d.permissionDecision, 'ask');
  assert.strictEqual(calls.revParse, 0);
});

test('ENF-25 MI-01 e2e (fx10): A on next behind its last-fetched origin/next, origin now unreachable -> DENY (not ask); next unchanged', () => {
  const { fx, L } = fetchedFixture({ park: false });
  try {
    git(fx.A, 'remote', 'set-url', 'origin', path.join(fx.root, 'nope', 'open-gsd', 'gsd-core.git'));
    const r = spawnIn(fx.A, 'git worktree add -b f ' + path.join(fx.root, 'x'));
    assert.strictEqual(r.decision, 'deny', r.reason);
    assert.match(r.reason, /could not refresh/);
    assert.ok(r.reason.includes('merge --ff-only origin/next'), r.reason);
    assert.strictEqual(refOf(fx.A, 'refs/heads/next'), L);
  } finally {
    fx.dispose();
  }
});
