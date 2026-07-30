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
 * Build injectable deps for `sync`.
 *
 * THREE payload roots exist since D-11, and a test must be able to set them independently:
 *   • the RAW clone            `<tmp>/gsd-core`
 *   • the installer PROJECTION `<tmp>/.enf21-projection/cfg/gsd-core`  (D-11)
 *   • the live RUNTIME         (anywhere outside the tmpdir)
 *
 * `digests: {clone, projection, runtime}` sets them. `runtime` may be an ARRAY, consumed by
 * index as REAL installs complete — `[before, after]` expresses "the reinstall changed it".
 * A projection install (it carries `--config-dir`) never advances that index.
 */
function syncDeps(over = {}) {
  const state = {
    exec: [],
    rm: [],
    stamps: [],
    logs: [],
    mkdtemp: 0,
    mkdirs: [],
  };
  const d = over.digests || {};
  const cloneDigest = d.clone || DIGEST;
  const runtimeSeq = Array.isArray(d.runtime) ? d.runtime : [d.runtime || DIGEST];
  let realInstalls = 0;

  const payloadDigest = (root) => {
    const s = String(root);
    if (s.startsWith(TMP)) return cloneDigest;
    return runtimeSeq[Math.min(realInstalls, runtimeSeq.length - 1)];
  };

  // D-13: the post-install check is the payload INVENTORY, not bytes. `inventory` is
  // {clone, runtime}; equal lists ⇒ confirmed. Default: identical.
  const inv = over.inventory || {};
  const payloadInventory = (root) => {
    const s = String(root);
    const dflt = ['workflows/a.md', 'references/b.md'];
    return s.startsWith(TMP) ? (inv.clone || dflt) : (inv.runtime || inv.clone || dflt);
  };

  const deps = Object.assign(
    {
      runtimeRoot: '/home/u/.claude/gsd-core',
      oracle: Object.assign({}, oracle, {
        fetchTipLive: () => (over.tip === undefined ? TIP : over.tip),
        payloadDigest,
        payloadInventory,
        runtimeDigest: () => DIGEST,
        writeStamp: (s) => { state.stamps.push(s); return '/s/runtime-stamp.json'; },
      }, over.oracle || {}),
      execFileSync: (file, args) => {
        state.exec.push({ file, args });
        if (file === 'git' && args[0] === '-C' && args[2] === 'rev-parse') {
          return (over.cloneHead === undefined ? TIP : over.cloneHead) + '\n';
        }
        // A REAL install (no --config-dir) is what can change the runtime payload; the D-11
        // projection install writes only into its sandbox and must not advance the sequence.
        if (args.some((a) => String(a).includes('install.js')) && !args.includes('--config-dir')) {
          realInstalls += 1;
        }
        return '';
      },
      mkdtempSync: () => { state.mkdtemp += 1; return TMP; },
      mkdirSync: (p, o) => { state.mkdirs.push({ path: p, opts: o }); },
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
  const { deps, state } = syncDeps({ digests: { clone: DIGEST, runtime: DIGEST } });
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
  // Raw clone ≠ runtime AND projection ≠ runtime ⇒ real drift. The reinstall moves the runtime
  // onto the projection digest, so the post-install re-verify matches.
  const STALE = 'sha256:' + '1'.repeat(64);
  const { deps, state } = syncDeps({
    digests: { clone: DIGEST, projection: DIGEST, runtime: [STALE, DIGEST] },
  });
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
  const STALE = 'sha256:' + '1'.repeat(64);
  const { deps, state } = syncDeps({
    digests: { clone: DIGEST, projection: DIGEST, runtime: [STALE, DIGEST] },
  });
  const calls = [];
  let real = 0;
  deps.execFileSync = (file, args, opts) => {
    calls.push({ file, args, opts });
    state.exec.push({ file, args });
    if (file === 'git' && args[0] === '-C' && args[2] === 'rev-parse') return TIP + '\n';
    if (args.some((a) => String(a).includes('install.js')) && !args.includes('--config-dir')) real += 1;
    return '';
  };
  // Re-point the digest stub at this test's own install counter.
  const projRe = /\.enf21-projection/;
  deps.oracle.payloadDigest = (root) => {
    const s = String(root);
    if (projRe.test(s)) return DIGEST;
    if (s.startsWith(TMP)) return DIGEST;
    return real === 0 ? STALE : DIGEST;
  };
  cli.sync(deps);
  const ci = calls.find(isNpmCi);
  assert.strictEqual(ci.opts.cwd, TMP);
  assert.strictEqual(ci.opts.timeout, 600000);
  // The REAL install — the projection install is the one carrying --config-dir.
  const inst = calls.find((c) => isInstall(c) && !c.args.includes('--config-dir'));
  assert.strictEqual(inst.file, process.execPath);
  assert.deepStrictEqual(inst.args, [path.join(TMP, 'bin', 'install.js'), '--claude']);
  assert.strictEqual(inst.opts.timeout, 300000);
});

test('sync SLOW PATH: a post-install INVENTORY mismatch aborts non-zero, NO stamp (T-0ov-06)', () => {
  const STALE = 'sha256:' + '1'.repeat(64);
  const { deps, state } = syncDeps({
    digests: { clone: DIGEST, runtime: [STALE, STALE] },
    inventory: { clone: ['workflows/a.md', 'workflows/b.md'], runtime: ['workflows/a.md'] },
  });
  const r = cli.sync(deps);
  assert.notStrictEqual(r.code, 0);
  assert.strictEqual(r.reason, 'post-install-mismatch');
  assert.strictEqual(state.stamps.length, 0, 'never stamp an install we could not confirm');
  assert.strictEqual(state.rm.length, 1, 'the tmpdir is still removed on the failure path');
});

test('sync SLOW PATH: the abort NAMES the missing files and rules the transforms out', () => {
  // D-13: the inventory is invariant under BOTH installer transforms, so a mismatch here cannot
  // be blamed on them — the message must say so and point at the actual wrong file set.
  const STALE = 'sha256:' + '1'.repeat(64);
  const { deps, state } = syncDeps({
    digests: { clone: DIGEST, runtime: [STALE, STALE] },
    inventory: { clone: ['workflows/a.md', 'workflows/b.md'], runtime: ['workflows/a.md'] },
  });
  cli.sync(deps);
  const out = state.logs.join('\n');
  assert.match(out, /invariant under both known installer transforms/i);
  assert.match(out, /workflows\/b\.md/, 'the missing file is named');
  assert.match(out, /Do not work around it by hand-writing/i, 'still forbids forging the stamp');
  assert.match(out, /CTK-ADR-0007/);
});

test('sync D-13: a matching inventory CONFIRMS the install even when the DIGEST differs', () => {
  // This is the whole point: the config-dir bake guarantees the digest differs, so keying the
  // confirmation on bytes made a correct install unconfirmable.
  const STALE = 'sha256:' + '1'.repeat(64);
  const { deps, state } = syncDeps({
    digests: { clone: DIGEST, runtime: [STALE, STALE] },
    inventory: { clone: ['workflows/a.md', 'references/b.md'] },
  });
  const r = cli.sync(deps);
  assert.strictEqual(r.code, 0);
  assert.strictEqual(state.stamps[0].mode, 'installed');
  assert.strictEqual(state.stamps[0].engine_verified, true);
});

test('sync D-13: no sandboxed projection install is attempted any more (it was unsound)', () => {
  const STALE = 'sha256:' + '1'.repeat(64);
  const { deps, state } = syncDeps({ digests: { clone: DIGEST, runtime: [STALE, STALE] } });
  cli.sync(deps);
  const proj = state.exec.find((c) => isInstall(c) && c.args.includes('--config-dir'));
  assert.strictEqual(proj, undefined,
    'a sandboxed projection can never match a real install — it must not be run');
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
    return '';
  };
  const r = cli.sync(deps);
  assert.notStrictEqual(r.code, 0);
  assert.strictEqual(state.stamps.length, 0);
  assert.strictEqual(state.rm.length, 1, 'the tmpdir must be removed on the failure path too');
});

test('sync: an unresolvable upstream tip aborts BEFORE creating a tmpdir', () => {
  const { deps, state } = syncDeps({
    oracle: { fetchTipLive: () => { throw new Error('offline'); } },
  });
  const r = cli.sync(deps);
  assert.strictEqual(r.code, 2);
  assert.strictEqual(state.mkdtemp, 0, 'an outage must cost nothing');
  assert.strictEqual(state.stamps.length, 0);
});

// ─────────── D-12 (corrected): NEVER auto-collapse a symlinked runtime root ───────────
//
// An earlier revision set GSD_ALLOW_SYMLINKED_DEST=1 automatically once it had verified the link
// stayed inside the install root. That was proven wrong DESTRUCTIVELY: the install replaced the
// symlink with a real directory and the active sibling kept the old payload. Collapsing a
// deliberate layout is the user's call; this tool aborts and explains.

function linkDeps(over = {}) {
  return {
    lstatSync: over.lstatSync || (() => ({ isSymbolicLink: () => true })),
    realpathSync: over.realpathSync || (() => '/home/u/.claude/gsd-core-next-edge'),
    env: over.env || {},
  };
}

test('symlinkPreflight: a symlinked runtime root BLOCKS, even when contained in the install root', () => {
  const logs = [];
  const r = cli.symlinkPreflight('/home/u/.claude/gsd-core', (l) => logs.push(String(l)), linkDeps());
  assert.strictEqual(r.blocked, true, 'containment is NOT sufficient — the layout is what matters');
  assert.match(logs.join('\n'), /SYMLINK/);
  assert.match(logs.join('\n'), /GSD_ALLOW_SYMLINKED_DEST=1/, 'it names the deliberate opt-out');
});

test('symlinkPreflight: the tool never sets the flag itself — only the user\'s own env unblocks', () => {
  const r = cli.symlinkPreflight('/home/u/.claude/gsd-core', () => {},
    linkDeps({ env: { GSD_ALLOW_SYMLINKED_DEST: '1' } }));
  assert.strictEqual(r.blocked, false, 'an explicit user opt-in is honored');
});

test('symlinkPreflight: a REAL directory proceeds normally', () => {
  const r = cli.symlinkPreflight('/home/u/.claude/gsd-core', () => {},
    linkDeps({ lstatSync: () => ({ isSymbolicLink: () => false }) }));
  assert.strictEqual(r.blocked, false);
});

test('symlinkPreflight: an ABSENT runtime root does not throw and does not block', () => {
  const r = cli.symlinkPreflight('/home/u/.claude/gsd-core', () => {},
    linkDeps({ lstatSync: () => { throw new Error('ENOENT'); } }));
  assert.strictEqual(r.blocked, false);
});

test('sync: a symlinked runtime root aborts BEFORE npm ci or install.js, with NO stamp', () => {
  const STALE = 'sha256:' + '1'.repeat(64);
  const { deps, state } = syncDeps({ digests: { clone: DIGEST, runtime: [STALE, STALE] } });
  deps.lstatSync = () => ({ isSymbolicLink: () => true });
  deps.realpathSync = () => '/home/u/.claude/gsd-core-next-edge';
  deps.env = {};
  const r = cli.sync(deps);
  assert.strictEqual(r.reason, 'symlinked-runtime-root');
  assert.notStrictEqual(r.code, 0);
  assert.ok(!ran(state, isNpmCi), 'it must abort before the expensive work');
  assert.ok(!ran(state, isInstall), 'and before writing anything');
  assert.strictEqual(state.stamps.length, 0);
  assert.strictEqual(state.rm.length, 1, 'the tmpdir is still cleaned up');
});
