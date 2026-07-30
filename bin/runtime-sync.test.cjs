'use strict';

/**
 * node:test for bin/runtime-sync.cjs — the ENF-21 remediation CLI.
 *
 * HERMETIC: every impure seam (`execFileSync`, `mkdtempSync`, `rmSync`, the oracle module, the
 * clock, the logger) is injected, so no case clones anything, runs `npm ci`, touches the network,
 * or writes to `~/.claude`. What is proven here is the CONTRACT the plan's D-08/D-09 fix:
 *
 *   • `check` is READ-ONLY — it never writes a stamp, on either verdict;
 *   • `sync`'s FAST PATH (the clone's payload already equals the runtime's) performs NO `npm ci`
 *     and NO `install.js`, and records `mode:'payload-verified', engine_verified:false` — because
 *     it compared the PAYLOAD, not the built engine (D-09);
 *   • the SLOW path runs `npm ci` THEN `install.js`, RE-verifies afterwards, and only then
 *     records `mode:'installed', engine_verified:true`;
 *   • an `ls-remote`↔clone race (clone HEAD ≠ the resolved tip) ABORTS without stamping;
 *   • a post-install re-verify mismatch ABORTS without stamping — never stamp an install we
 *     could not confirm (T-0ov-06);
 *   • the tmpdir is removed on BOTH the success and the failure path.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const cli = require('./runtime-sync.cjs');
const oracle = require('../hooks/lib/runtime-stamp.cjs');

const TIP = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const DIGEST = 'sha256:' + 'f'.repeat(64);
const TMP = '/tmp/gsd-runtime-sync-test';

function stampAt(sha, digest) {
  return {
    schema: oracle.STAMP_SCHEMA,
    sha,
    runtime_digest: digest,
    mode: 'payload-verified',
    engine_verified: false,
    installed_at: '2026-07-30T00:00:00.000Z',
    source: oracle.UPSTREAM_URL + '#' + oracle.UPSTREAM_REF,
  };
}

/**
 * Build injectable deps for `sync`. `payloads` is the sequence of [cloneDigest, runtimeDigest]
 * pairs `payloadDigest` should yield, consumed one pair per comparison — so a test can say
 * "differs, then matches after the install" without stubbing call sites individually.
 */
function syncDeps(over = {}) {
  const state = {
    exec: [],
    rm: [],
    stamps: [],
    logs: [],
    mkdtemp: 0,
  };
  const payloads = over.payloads || [[DIGEST, DIGEST]];
  let compareIdx = 0;
  const payloadDigest = (root) => {
    const pair = payloads[Math.min(compareIdx, payloads.length - 1)];
    // The RUNTIME root is the one that is not under the tmpdir.
    const isClone = String(root).startsWith(TMP);
    const value = isClone ? pair[0] : pair[1];
    if (!isClone) compareIdx += 1; // one comparison consumes one pair (runtime side is second)
    return value;
  };

  const deps = Object.assign(
    {
      runtimeRoot: '/home/u/.claude/gsd-core',
      oracle: Object.assign({}, oracle, {
        fetchTipLive: () => (over.tip === undefined ? TIP : over.tip),
        payloadDigest,
        runtimeDigest: () => DIGEST,
        writeStamp: (s) => { state.stamps.push(s); return '/s/runtime-stamp.json'; },
      }, over.oracle || {}),
      execFileSync: (file, args) => {
        state.exec.push({ file, args });
        if (file === 'git' && args[0] === '-C' && args[2] === 'rev-parse') {
          return (over.cloneHead === undefined ? TIP : over.cloneHead) + '\n';
        }
        return '';
      },
      mkdtempSync: () => { state.mkdtemp += 1; return TMP; },
      rmSync: (p, o) => state.rm.push({ path: p, opts: o }),
      log: (line) => state.logs.push(String(line)),
      now: () => '2026-07-30T00:00:00.000Z',
    },
    over.deps || {}
  );
  return { deps, state };
}

function ran(state, pred) {
  return state.exec.some(pred);
}
const isNpmCi = (c) => c.file === 'npm' && c.args[0] === 'ci';
const isInstall = (c) => c.args.some((a) => String(a).includes('install.js'));
const isClone = (c) => c.file === 'git' && c.args[0] === 'clone';

// ───────────────────────────── check ─────────────────────────────

function checkDeps(over = {}) {
  const state = { stamps: [], logs: [] };
  const deps = {
    runtimeRoot: '/home/u/.claude/gsd-core',
    oracle: Object.assign({}, oracle, {
      runtimeDigest: () => DIGEST,
      readStamp: () => stampAt(TIP, DIGEST),
      upstreamTip: () => ({ sha: TIP, source: 'live', ageMs: 0 }),
      writeStamp: (s) => { state.stamps.push(s); },
      writeCacheLive: () => { state.stamps.push('cache'); },
    }, over.oracle || {}),
    log: (l) => state.logs.push(String(l)),
  };
  return { deps, state };
}

test('check: a FRESH oracle exits 0, prints the verdict, and writes NOTHING', () => {
  const { deps, state } = checkDeps();
  const r = cli.check(deps);
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.verdict, 'fresh');
  assert.strictEqual(state.stamps.length, 0, 'check must be read-only');
  assert.ok(state.logs.join('\n').includes('fresh'));
});

test('check: a DRIFTED oracle exits 1, names the sync command, and writes NOTHING', () => {
  const { deps, state } = checkDeps({
    oracle: { upstreamTip: () => ({ sha: OTHER, source: 'live', ageMs: 0 }) },
  });
  const r = cli.check(deps);
  assert.strictEqual(r.code, 1);
  assert.strictEqual(r.verdict, 'drifted');
  assert.strictEqual(state.stamps.length, 0, 'check must be read-only');
  assert.ok(state.logs.join('\n').includes(oracle.REMEDIATION_COMMAND));
});

test('check: an UNSTAMPED runtime exits 1 and names the sync command', () => {
  const { deps, state } = checkDeps({ oracle: { readStamp: () => null } });
  const r = cli.check(deps);
  assert.strictEqual(r.code, 1);
  assert.strictEqual(r.verdict, 'unstamped');
  assert.ok(state.logs.join('\n').includes(oracle.REMEDIATION_COMMAND));
});

test('check: an unobtainable upstream tip exits 2 (distinct from a drift verdict)', () => {
  const { deps, state } = checkDeps({
    oracle: { upstreamTip: () => { throw new oracle.UpstreamUnavailable('offline'); } },
  });
  const r = cli.check(deps);
  assert.strictEqual(r.code, 2);
  assert.strictEqual(r.verdict, 'unknown');
  assert.strictEqual(state.stamps.length, 0);
});

// ───────────────────────────── sync: the fast path (D-09) ─────────────────────────────

test('sync FAST PATH: payload already equal → NO npm ci, NO install.js, stamp payload-verified', () => {
  const { deps, state } = syncDeps({ payloads: [[DIGEST, DIGEST]] });
  const r = cli.sync(deps);
  assert.strictEqual(r.code, 0);
  assert.ok(ran(state, isClone), 'it still clones to obtain the comparison payload');
  assert.ok(!ran(state, isNpmCi), '`npm ci` must NOT run on the fast path');
  assert.ok(!ran(state, isInstall), '`install.js` must NOT run on the fast path');
  assert.strictEqual(state.stamps.length, 1);
  assert.strictEqual(state.stamps[0].mode, 'payload-verified');
  assert.strictEqual(state.stamps[0].engine_verified, false);
  assert.strictEqual(state.stamps[0].sha, TIP);
  assert.strictEqual(state.stamps[0].runtime_digest, DIGEST);
  assert.strictEqual(state.stamps[0].schema, oracle.STAMP_SCHEMA);
});

test('sync FAST PATH: the tmpdir is removed on the SUCCESS path', () => {
  const { deps, state } = syncDeps();
  cli.sync(deps);
  assert.strictEqual(state.rm.length, 1);
  assert.strictEqual(state.rm[0].path, TMP);
  assert.deepStrictEqual(state.rm[0].opts, { recursive: true, force: true });
});

// ───────────────────────────── sync: the reinstall path ─────────────────────────────

test('sync SLOW PATH: payload differs → npm ci THEN install.js, re-verified, stamp installed', () => {
  // first comparison differs; the post-install re-verify matches.
  const { deps, state } = syncDeps({ payloads: [[DIGEST, 'sha256:' + '1'.repeat(64)], [DIGEST, DIGEST]] });
  const r = cli.sync(deps);
  assert.strictEqual(r.code, 0);
  const ciIdx = state.exec.findIndex(isNpmCi);
  const instIdx = state.exec.findIndex(isInstall);
  assert.ok(ciIdx >= 0, '`npm ci` must run');
  assert.ok(instIdx >= 0, '`install.js` must run');
  assert.ok(ciIdx < instIdx, '`npm ci` must run BEFORE install.js (it produces the built bin/lib)');
  assert.strictEqual(state.stamps.length, 1);
  assert.strictEqual(state.stamps[0].mode, 'installed');
  assert.strictEqual(state.stamps[0].engine_verified, true);
});

test('sync SLOW PATH: npm ci runs in the CLONE with a bounded timeout, install.js runs via node', () => {
  const { deps, state } = syncDeps({ payloads: [[DIGEST, 'sha256:' + '1'.repeat(64)], [DIGEST, DIGEST]] });
  const calls = [];
  deps.execFileSync = (file, args, opts) => {
    calls.push({ file, args, opts });
    state.exec.push({ file, args });
    if (file === 'git' && args[0] === '-C' && args[2] === 'rev-parse') return TIP + '\n';
    return '';
  };
  cli.sync(deps);
  const ci = calls.find(isNpmCi);
  assert.strictEqual(ci.opts.cwd, TMP);
  assert.strictEqual(ci.opts.timeout, 600000);
  const inst = calls.find(isInstall);
  assert.strictEqual(inst.file, process.execPath);
  assert.deepStrictEqual(inst.args, [path.join(TMP, 'bin', 'install.js'), '--claude']);
  assert.strictEqual(inst.opts.timeout, 300000);
});

test('sync SLOW PATH: a post-install re-verify MISMATCH aborts non-zero with NO stamp (T-0ov-06)', () => {
  const bad = 'sha256:' + '1'.repeat(64);
  const { deps, state } = syncDeps({ payloads: [[DIGEST, bad], [DIGEST, bad]] });
  const r = cli.sync(deps);
  assert.notStrictEqual(r.code, 0);
  assert.strictEqual(state.stamps.length, 0, 'never stamp an install we could not confirm');
  assert.strictEqual(state.rm.length, 1, 'the tmpdir is still removed on the failure path');
});

// ───────────────────────────── sync: the race guard ─────────────────────────────

test('sync: clone HEAD ≠ the ls-remote tip → ABORT non-zero, no stamp, tmpdir removed', () => {
  const { deps, state } = syncDeps({ cloneHead: OTHER });
  const r = cli.sync(deps);
  assert.notStrictEqual(r.code, 0);
  assert.strictEqual(state.stamps.length, 0);
  assert.ok(!ran(state, isNpmCi), 'the race guard fires BEFORE any install work');
  assert.strictEqual(state.rm.length, 1);
  assert.ok(state.logs.join('\n').toLowerCase().includes('race') ||
    state.logs.join('\n').includes(OTHER.slice(0, 8)));
});

test('sync: an exploding clone still removes the tmpdir (finally, not a happy-path cleanup)', () => {
  const { deps, state } = syncDeps();
  deps.execFileSync = (file, args) => {
    state.exec.push({ file, args });
    if (file === 'git' && args[0] === 'clone') throw new Error('network down');
    return TIP + '\n';
  };
  const r = cli.sync(deps);
  assert.notStrictEqual(r.code, 0);
  assert.strictEqual(state.stamps.length, 0);
  assert.strictEqual(state.rm.length, 1);
});

test('sync: an unreachable upstream aborts BEFORE any tmpdir is created', () => {
  const { deps, state } = syncDeps({
    oracle: { fetchTipLive: () => { throw new oracle.UpstreamUnavailable('offline'); } },
  });
  const r = cli.sync(deps);
  assert.notStrictEqual(r.code, 0);
  assert.strictEqual(state.mkdtemp, 0);
  assert.strictEqual(state.rm.length, 0);
  assert.strictEqual(state.stamps.length, 0);
});

test('sync: the clone is shallow, branch-pinned to `next`, and reads the UPSTREAM_URL constant', () => {
  const { deps, state } = syncDeps();
  cli.sync(deps);
  const clone = state.exec.find(isClone);
  assert.deepStrictEqual(clone.args, [
    'clone', '--depth', '1', '--branch', oracle.UPSTREAM_REF, oracle.UPSTREAM_URL, TMP,
  ]);
});

test('sync NEVER touches the local gsd-core clone (no path outside the tmpdir is written)', () => {
  const { deps, state } = syncDeps({ payloads: [[DIGEST, 'sha256:' + '1'.repeat(64)], [DIGEST, DIGEST]] });
  cli.sync(deps);
  for (const call of state.exec) {
    const joined = call.args.join(' ');
    assert.ok(
      !/repos\/gsd-core/.test(joined),
      'no exec call may reference the local /home/dave/repos/gsd-core clone: ' + joined
    );
  }
});

// ───────────────────────────── main / argv ─────────────────────────────

test('main: dispatches `check` and `sync`, and rejects anything else with usage', () => {
  const logs = [];
  const stub = { log: (l) => logs.push(String(l)) };
  let checked = 0;
  let synced = 0;
  const deps = Object.assign({}, stub, {
    checkImpl: () => { checked += 1; return { code: 0, verdict: 'fresh' }; },
    syncImpl: () => { synced += 1; return { code: 0 }; },
  });
  assert.strictEqual(cli.main(['check'], deps), 0);
  assert.strictEqual(checked, 1);
  assert.strictEqual(cli.main(['sync'], deps), 0);
  assert.strictEqual(synced, 1);
  const bad = cli.main(['frobnicate'], deps);
  assert.notStrictEqual(bad, 0);
  assert.ok(logs.join('\n').includes('check'), 'usage names the subcommands');
  assert.ok(logs.join('\n').includes('sync'));
});

test('main: no subcommand prints usage and exits non-zero (no implicit mutation)', () => {
  const logs = [];
  let synced = 0;
  const code = cli.main([], { log: (l) => logs.push(String(l)), syncImpl: () => { synced += 1; return { code: 0 }; } });
  assert.notStrictEqual(code, 0);
  assert.strictEqual(synced, 0, 'a bare invocation must never default to the mutating subcommand');
});
