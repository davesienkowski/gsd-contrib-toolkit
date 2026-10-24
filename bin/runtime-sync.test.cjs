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

// quick 261017-w1i (CTK-ADR-0011): the managed gsd-core hook set under ~/.claude/hooks.
const HDIGEST = 'sha256:' + 'e'.repeat(64);
const HOOKS_ROOT = '/home/u/.claude/hooks';
const DIST_ROOT = path.join(TMP, 'hooks', 'dist');
const HOOK_FILES = Object.freeze(['gsd-a.js', 'lib/b.sh']);
/** The fixed clock: the install starts at NOW_MS; once install.js has run the clock reads +60 s. */
const NOW_MS = Date.parse('2026-07-30T00:00:00.000Z');

function stampAt(sha, digest) {
  return {
    schema: oracle.STAMP_SCHEMA,
    sha,
    runtime_digest: digest,
    mode: 'payload-verified',
    engine_verified: false,
    installed_at: '2026-07-30T00:00:00.000Z',
    source: oracle.UPSTREAM_URL + '#' + oracle.UPSTREAM_REF,
    hooks_files: HOOK_FILES.slice(),
    hooks_digest: HDIGEST,
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

  // quick 261017-w1i: `hooks: {dist, installed}` sets the managed-hook digests. `installed` may be
  // an ARRAY indexed by real installs, like `runtime`. Default: both HDIGEST (the fast path holds).
  const h = over.hooks || {};
  const distHooksDigest = h.dist || HDIGEST;
  const installedHooksSeq = Array.isArray(h.installed) ? h.installed : [h.installed || HDIGEST];
  const hooksDigest = (root) => {
    const s = String(root);
    if (s.startsWith(TMP)) return distHooksDigest;
    return installedHooksSeq[Math.min(realInstalls, installedHooksSeq.length - 1)];
  };
  // `distInventory` overrides what hooksInventory reports for <tmp>/hooks/dist; an array of arrays
  // is consumed one per call (the fast path's early build, then the slow path's).
  const distInv = over.distInventory;
  let inventoryCalls = 0;
  const hooksInventory = (root) => {
    const s = String(root);
    if (!s.startsWith(TMP)) return [];
    const i = inventoryCalls;
    inventoryCalls += 1;
    if (distInv === undefined) return HOOK_FILES.slice();
    if (Array.isArray(distInv) && distInv.length > 0 && Array.isArray(distInv[0])) {
      return distInv[Math.min(i, distInv.length - 1)].slice();
    }
    return distInv.slice();
  };
  // `buildThrows: 'early' | 'late' | 'both' | true` makes a `npm run build:hooks` call throw. The
  // EARLY build is the one before npm ci; the LATE one runs after it.
  const buildThrows = over.buildThrows;
  // `mtimes` maps a managed relpath to its mtimeMs (ctimeMs then equals it), to
  // `{mtimeMs, ctimeMs}` to set the two apart, or to 'throw' for a stat failure. Default: the file
  // was written just after the install started (NOW_MS + 1).
  const mtimes = over.mtimes || {};

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
        hooksInventory,
        hooksDigest,
        writeStamp: (s) => { state.stamps.push(s); return '/s/runtime-stamp.json'; },
      }, over.oracle || {}),
      hooksRoot: HOOKS_ROOT,
      statSync: (p) => {
        const rel = path.relative(HOOKS_ROOT, String(p)).split(path.sep).join('/');
        const m = Object.prototype.hasOwnProperty.call(mtimes, rel) ? mtimes[rel] : NOW_MS + 1;
        if (m === 'throw') {
          const e = new Error('ENOENT: no such file or directory, stat ' + p);
          e.code = 'ENOENT';
          throw e;
        }
        const t = (m && typeof m === 'object') ? m : { mtimeMs: m, ctimeMs: m };
        return { isFile: () => true, isDirectory: () => false, mtimeMs: t.mtimeMs, ctimeMs: t.ctimeMs };
      },
      // Keyed off state.exec, so a test that swaps execFileSync but still records into state.exec
      // keeps a clock that moves once install.js has run.
      nowMs: () => (state.exec.some(isInstall) ? NOW_MS + 60000 : NOW_MS),
      execFileSync: (file, args) => {
        state.exec.push({ file, args });
        if (file === 'git' && args[0] === '-C' && args[2] === 'rev-parse') {
          return (over.cloneHead === undefined ? TIP : over.cloneHead) + '\n';
        }
        if (isBuildHooks({ file, args })) {
          const early = !state.exec.some(isNpmCi);
          if (buildThrows === true || buildThrows === 'both' ||
              (buildThrows === 'early' && early) || (buildThrows === 'late' && !early)) {
            throw new Error('build-hooks: simulated failure\nsecond line');
          }
          return '';
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
const isBuildHooks = (c) => c.file === 'npm' && c.args[0] === 'run' && c.args[1] === 'build:hooks';
const isInstall = (c) => c.args.some((a) => String(a).includes('install.js'));
const isClone = (c) => c.file === 'git' && c.args[0] === 'clone';

// ───────────────────────────── check ─────────────────────────────

function checkDeps(over = {}) {
  const state = { stamps: [], logs: [], hooksRoots: [] };
  const deps = {
    runtimeRoot: '/home/u/.claude/gsd-core',
    oracle: Object.assign({}, oracle, {
      runtimeDigest: () => DIGEST,
      // Stubbed so the real helper never reads /home/u/.claude/hooks; records the root it was given.
      hooksDigestForStamp: (stamp, root) => {
        state.hooksRoots.push(root);
        return stamp && Array.isArray(stamp.hooks_files) ? HDIGEST : null;
      },
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
  assert.match(out, /CTK-ADR-0007 §Decision\.7\./, 'cites the live Decision 7, which keeps the hand-writing prohibition');
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

// ───────────── quick 261017-w1i (CTK-ADR-0011): sync builds and confirms the managed hooks ─────────────
//
// Measured defect: the slow path ran `npm ci` (whose `prepare` is build:lib only) then install.js,
// and install.js copies hooks only when the gitignored hooks/dist exists, so it silently kept the
// OLD ~/.claude/hooks/* and the stamp still read fresh. Every new export is touched INSIDE a test
// body, so a missing export fails its own test and never crashes this file.

const STALE = 'sha256:' + '1'.repeat(64);
const OLD_HOOKS = 'sha256:' + '3'.repeat(64);

/** Wrap deps.execFileSync to also record each call's opts, index-aligned with state.exec. */
function recordOpts(deps) {
  const opts = [];
  const inner = deps.execFileSync;
  deps.execFileSync = (file, args, o) => { opts.push(o); return inner(file, args, o); };
  return opts;
}
const idxAll = (state, pred) => state.exec.map((c, i) => (pred(c) ? i : -1)).filter((i) => i >= 0);

test('w1i: sync SLOW PATH: npm ci, then npm run build:hooks (cwd the clone, bounded), then install.js', () => {
  const { deps, state } = syncDeps({ digests: { clone: DIGEST, runtime: [STALE, DIGEST] } });
  const opts = recordOpts(deps);
  const r = cli.sync(deps);
  assert.strictEqual(r.code, 0, state.logs.join('\n'));
  assert.ok(Number.isFinite(cli.BUILD_HOOKS_TIMEOUT_MS) && cli.BUILD_HOOKS_TIMEOUT_MS > 0, 'BUILD_HOOKS_TIMEOUT_MS is exported');
  const ci = state.exec.findIndex(isNpmCi);
  const builds = idxAll(state, isBuildHooks);
  const inst = state.exec.findIndex(isInstall);
  assert.ok(builds.length >= 1, 'npm run build:hooks must run');
  const last = builds[builds.length - 1];
  assert.ok(ci >= 0 && ci < last, 'build:hooks runs AFTER npm ci');
  assert.ok(last < inst, 'build:hooks runs BEFORE install.js');
  assert.strictEqual(state.exec[last].file, 'npm');
  assert.deepStrictEqual(state.exec[last].args, ['run', 'build:hooks']);
  assert.strictEqual(opts[last].cwd, TMP);
  assert.strictEqual(opts[last].timeout, cli.BUILD_HOOKS_TIMEOUT_MS);
  assert.notStrictEqual(opts[last].shell, true);
});

test('w1i: sync SLOW PATH: a failing build:hooks aborts hooks-build-failed, no install.js, no stamp, tmpdir removed', () => {
  const { deps, state } = syncDeps({ digests: { clone: DIGEST, runtime: [STALE, DIGEST] }, buildThrows: 'both' });
  const r = cli.sync(deps);
  assert.notStrictEqual(r.code, 0);
  assert.strictEqual(r.reason, 'hooks-build-failed');
  assert.ok(!ran(state, isInstall), 'install.js must not run over an unbuilt hooks/dist');
  assert.strictEqual(state.stamps.length, 0);
  assert.strictEqual(state.rm.length, 1);
  const out = state.logs.join('\n');
  assert.match(out, /ENF-21 sync ABORTED/);
  assert.ok(out.includes('npm run build:hooks'), out);
  assert.ok(out.includes('simulated failure'), 'the first line of the error is shown');
  assert.match(out, /no stamp/i);
});

test('w1i: a failing build:hooks abort quotes the first non-empty stderr line (npm puts the reason there)', () => {
  // execFileSync's err.message keeps only "Command failed: npm run build:hooks" on its first line;
  // npm's reason, e.g. a renamed upstream script, is on err.stderr. The abort must say why.
  const { deps, state } = syncDeps({ digests: { clone: DIGEST, runtime: [STALE, DIGEST] } });
  const inner = deps.execFileSync;
  deps.execFileSync = (file, args, o) => {
    if (isBuildHooks({ file, args })) {
      state.exec.push({ file, args });
      const e = new Error('Command failed: npm run build:hooks\nnpm error Missing script: "build:hooks"');
      e.status = 1;
      e.stderr = '\n  \nnpm error Missing script: "build:hooks"\nnpm error\nnpm error To see a list of scripts, run:\n';
      throw e;
    }
    return inner(file, args, o);
  };
  const r = cli.sync(deps);
  assert.strictEqual(r.reason, 'hooks-build-failed');
  assert.ok(!ran(state, isInstall));
  assert.strictEqual(state.stamps.length, 0);
  const out = state.logs.join('\n');
  assert.ok(out.includes('Command failed: npm run build:hooks'), out);
  assert.ok(out.includes('stderr: npm error Missing script: "build:hooks"'), out);
  assert.ok(!out.includes('To see a list of scripts'), 'only the first non-empty stderr line is quoted');
});

test('w1i: firstStderrLine is bounded, strips control characters, and is empty without stderr', () => {
  assert.strictEqual(typeof cli.firstStderrLine, 'function');
  assert.ok(Number.isInteger(cli.STDERR_LINE_MAX) && cli.STDERR_LINE_MAX > 0);
  assert.strictEqual(cli.firstStderrLine(new Error('no stderr here')), '');
  assert.strictEqual(cli.firstStderrLine({ stderr: '' }), '');
  assert.strictEqual(cli.firstStderrLine({ stderr: Buffer.from('\nboom\n') }), 'boom');
  assert.strictEqual(cli.firstStderrLine({ stderr: '\u001b[31mred\u001b[0m\n' }), '[31mred[0m');
  const long = cli.firstStderrLine({ stderr: 'x'.repeat(cli.STDERR_LINE_MAX * 3) });
  assert.strictEqual(long, 'x'.repeat(cli.STDERR_LINE_MAX) + '...');
});

test('w1i: sync SLOW PATH: an empty hooks/dist aborts hooks-dist-empty, no install.js, no stamp, tmpdir removed', () => {
  const { deps, state } = syncDeps({ digests: { clone: DIGEST, runtime: [STALE, DIGEST] }, distInventory: [] });
  const r = cli.sync(deps);
  assert.notStrictEqual(r.code, 0);
  assert.strictEqual(r.reason, 'hooks-dist-empty');
  assert.ok(!ran(state, isInstall));
  assert.strictEqual(state.stamps.length, 0);
  assert.strictEqual(state.rm.length, 1);
  assert.ok(state.logs.join('\n').includes('hooks/dist'), state.logs.join('\n'));
});

test('w1i: a hooks/dist name the stamp cannot carry aborts hooks-dist-unsafe-name BEFORE install.js, no stamp, tmpdir removed', () => {
  for (const bad of ['bad\\name.js', 'ctl\u0001.js', 'a/b/c.js']) {
    const { deps, state } = syncDeps({
      digests: { clone: DIGEST, runtime: [STALE, DIGEST] },
      distInventory: ['gsd-a.js', bad],
    });
    const r = cli.sync(deps);
    assert.strictEqual(r.reason, 'hooks-dist-unsafe-name', JSON.stringify(bad) + '\n' + state.logs.join('\n'));
    assert.notStrictEqual(r.code, 0);
    assert.ok(ran(state, isBuildHooks));
    assert.ok(!ran(state, isInstall), 'install.js must not run');
    assert.strictEqual(state.stamps.length, 0);
    assert.strictEqual(state.rm.length, 1);
    assert.ok(state.logs.join('\n').includes(JSON.stringify(bad)), 'the bad name is shown, escaped');
    assert.ok(!state.logs.join('\n').includes('"gsd-a.js"'), 'a safe name is not listed as unsafe');
  }
});

test('w1i: payload equal and an unsafe early-dist name falls through the fast path, then aborts hooks-dist-unsafe-name', () => {
  const { deps, state } = syncDeps({ distInventory: ['gsd-a.js', 'bad\\name.js'] });
  const r = cli.sync(deps);
  assert.strictEqual(r.reason, 'hooks-dist-unsafe-name', state.logs.join('\n'));
  assert.ok(!ran(state, isInstall));
  assert.strictEqual(state.stamps.length, 0);
});

test('w1i: post-install: a managed hook whose stat throws aborts post-install-hooks-mismatch, naming it, no stamp', () => {
  const { deps, state } = syncDeps({ digests: { clone: DIGEST, runtime: [STALE, DIGEST] }, mtimes: { 'lib/b.sh': 'throw' } });
  const r = cli.sync(deps);
  assert.notStrictEqual(r.code, 0);
  assert.strictEqual(r.reason, 'post-install-hooks-mismatch');
  assert.strictEqual(state.stamps.length, 0);
  assert.strictEqual(state.rm.length, 1);
  const out = state.logs.join('\n');
  assert.ok(out.includes('lib/b.sh'), out);
  assert.match(out, /CTK-ADR-0011/);
  assert.match(out, /Do not work around it by hand-writing/i);
});

test('w1i: post-install: a managed hook one ms older than install start minus the slack is stale, no stamp', () => {
  assert.ok(Number.isFinite(cli.HOOK_MTIME_SLACK_MS) && cli.HOOK_MTIME_SLACK_MS > 0, 'HOOK_MTIME_SLACK_MS is exported');
  const { deps, state } = syncDeps({
    digests: { clone: DIGEST, runtime: [STALE, DIGEST] },
    mtimes: { 'gsd-a.js': NOW_MS - cli.HOOK_MTIME_SLACK_MS - 1 },
  });
  const r = cli.sync(deps);
  assert.strictEqual(r.reason, 'post-install-hooks-mismatch');
  assert.notStrictEqual(r.code, 0);
  assert.strictEqual(state.stamps.length, 0);
  assert.ok(state.logs.join('\n').includes('gsd-a.js'));
});

test('w1i: post-install: a managed hook exactly at install start minus the slack counts as written by this install', () => {
  assert.ok(Number.isFinite(cli.HOOK_MTIME_SLACK_MS) && cli.HOOK_MTIME_SLACK_MS > 0, 'HOOK_MTIME_SLACK_MS is exported');
  const { deps, state } = syncDeps({
    digests: { clone: DIGEST, runtime: [STALE, DIGEST] },
    mtimes: { 'gsd-a.js': NOW_MS - cli.HOOK_MTIME_SLACK_MS, 'lib/b.sh': NOW_MS - cli.HOOK_MTIME_SLACK_MS },
  });
  const r = cli.sync(deps);
  assert.strictEqual(r.code, 0, state.logs.join('\n'));
  assert.strictEqual(state.stamps.length, 1);
  assert.strictEqual(state.stamps[0].mode, 'installed');
  assert.deepStrictEqual(state.stamps[0].hooks_files, HOOK_FILES.slice());
});

test('w1i: post-install: an OLD mtime with a FRESH ctime counts as written (a copy that preserved the source mtime)', () => {
  // install.js copies non-.js/.cjs/.sh hooks with copyFileSync; where a copy carries the source's
  // mtime over, only ctime (set by the kernel on the write) shows this install wrote the file.
  const old = NOW_MS - cli.HOOK_MTIME_SLACK_MS - 3600000;
  const { deps, state } = syncDeps({
    digests: { clone: DIGEST, runtime: [STALE, DIGEST] },
    mtimes: { 'lib/b.sh': { mtimeMs: old, ctimeMs: NOW_MS + 5 } },
  });
  const r = cli.sync(deps);
  assert.strictEqual(r.code, 0, state.logs.join('\n'));
  assert.strictEqual(state.stamps.length, 1);
  assert.strictEqual(state.stamps[0].mode, 'installed');
});

test('w1i: post-install: an OLD mtime AND an OLD ctime is stale, post-install-hooks-mismatch, no stamp', () => {
  const old = NOW_MS - cli.HOOK_MTIME_SLACK_MS - 3600000;
  const { deps, state } = syncDeps({
    digests: { clone: DIGEST, runtime: [STALE, DIGEST] },
    mtimes: { 'lib/b.sh': { mtimeMs: old, ctimeMs: old + 1 } },
  });
  const r = cli.sync(deps);
  assert.strictEqual(r.reason, 'post-install-hooks-mismatch');
  assert.notStrictEqual(r.code, 0);
  assert.strictEqual(state.stamps.length, 0);
  assert.strictEqual(state.rm.length, 1);
  assert.ok(state.logs.join('\n').includes('lib/b.sh'));
});

test('w1i: verifyHooksWritten ignores a non-finite timestamp instead of letting it poison the max', () => {
  const since = NOW_MS;
  const statOf = (t) => ({ statSync: () => Object.assign({ isFile: () => true }, t) });
  // a fresh mtime with no ctime field (NaN) is still written; a fresh ctime with no mtime too
  assert.deepStrictEqual(cli.verifyHooksWritten('/h', ['a.js'], since, statOf({ mtimeMs: since + 1 })), { missing: [], stale: [] });
  assert.deepStrictEqual(cli.verifyHooksWritten('/h', ['a.js'], since, statOf({ ctimeMs: since + 1 })), { missing: [], stale: [] });
  // neither timestamp usable is stale, never written
  assert.deepStrictEqual(cli.verifyHooksWritten('/h', ['a.js'], since, statOf({})), { missing: [], stale: ['a.js'] });
  assert.deepStrictEqual(cli.verifyHooksWritten('/h', ['a.js'], since, statOf({ mtimeMs: NaN, ctimeMs: Infinity })), { missing: [], stale: ['a.js'] });
});

test('w1i: verifyHooksWritten rejects a write time ahead of the clock (a future-dated stale hook is not "written")', () => {
  const now = NOW_MS;
  const since = now - 1000;
  const year2031 = Date.UTC(2031, 0, 1);
  const statOf = (t) => ({ statSync: () => Object.assign({ isFile: () => true }, t), nowMs: () => now });
  // future mtime, old ctime: the review's repro. Must be stale, not written.
  assert.deepStrictEqual(cli.verifyHooksWritten('/h', ['a.js'], since, statOf({ mtimeMs: year2031, ctimeMs: since - 600000 })), { missing: [], stale: ['a.js'] });
  // future ctime alone is stale too
  assert.deepStrictEqual(cli.verifyHooksWritten('/h', ['a.js'], since, statOf({ ctimeMs: year2031 })), { missing: [], stale: ['a.js'] });
  // within the skew slack ahead of the clock is still written
  assert.deepStrictEqual(cli.verifyHooksWritten('/h', ['a.js'], since, statOf({ mtimeMs: now + cli.HOOK_MTIME_SLACK_MS - 1 })), { missing: [], stale: [] });
  assert.deepStrictEqual(cli.verifyHooksWritten('/h', ['a.js'], since, statOf({ mtimeMs: now + cli.HOOK_MTIME_SLACK_MS + 1 })), { missing: [], stale: ['a.js'] });
});

test('w1i: the install start is captured BEFORE install.js (the clock moves +60 s once it has run)', () => {
  // Default mtimes are NOW_MS + 1. A start captured after install.js reads NOW_MS + 60000, so every
  // managed file would look stale and the sync would abort.
  const { deps, state } = syncDeps({ digests: { clone: DIGEST, runtime: [STALE, DIGEST] } });
  let clockReads = 0;
  const inner = deps.nowMs;
  deps.nowMs = () => { clockReads += 1; return inner(); };
  const r = cli.sync(deps);
  assert.strictEqual(r.code, 0, state.logs.join('\n'));
  assert.ok(clockReads >= 1, 'the install-start clock is read');
  assert.strictEqual(state.stamps[0].mode, 'installed');
  assert.deepStrictEqual(state.stamps[0].hooks_files, HOOK_FILES.slice());
});

test('w1i: the slow-path stamp binds the dist inventory and the POST-install hooks digest, and passes the real validateStamp', () => {
  const NEW_HOOKS = 'sha256:' + '4'.repeat(64);
  const DIST = 'sha256:' + '5'.repeat(64);
  const inv = ['a.cjs', 'gsd-x.js', 'lib/y.sh'];
  const { deps, state } = syncDeps({
    digests: { clone: DIGEST, runtime: [STALE, DIGEST] },
    hooks: { dist: DIST, installed: [OLD_HOOKS, NEW_HOOKS] },
    distInventory: inv,
  });
  const r = cli.sync(deps);
  assert.strictEqual(r.code, 0, state.logs.join('\n'));
  const s = state.stamps[0];
  assert.deepStrictEqual(s.hooks_files, inv);
  assert.strictEqual(s.hooks_digest, NEW_HOOKS, 'measured after install, never the dist or pre-install digest');
  assert.strictEqual(s.schema, oracle.STAMP_SCHEMA);
  assert.doesNotThrow(() => oracle.validateStamp(s, 'w1i test'));
});

test('w1i: FAST PATH: build:hooks runs exactly once, no npm ci, no install.js, and the stamp carries the hook fields', () => {
  // UNREACHABLE PREMISE with the real installer: this mock makes the built hooks/dist digest equal
  // the installed one, but install.js replaces `{{GSD_VERSION}}` in every .js/.cjs/.sh hook it writes
  // (28 of the 30 top-level gsd-core hook sources carry it at 030e7ca20) and hooks/dist keeps the
  // placeholder, so on a real install the two digests never match and sync always reinstalls
  // (CTK-ADR-0011 Decision 7). This tests the branch's logic only; it is no evidence that sync is
  // cheap when current. Removing or replacing the fast path is a follow-up.
  const { deps, state } = syncDeps();
  const opts = recordOpts(deps);
  const r = cli.sync(deps);
  assert.strictEqual(r.code, 0, state.logs.join('\n'));
  const builds = idxAll(state, isBuildHooks);
  assert.strictEqual(builds.length, 1, 'the early build runs once');
  assert.strictEqual(opts[builds[0]].cwd, TMP);
  assert.ok(!ran(state, isNpmCi));
  assert.ok(!ran(state, isInstall));
  assert.strictEqual(state.stamps.length, 1);
  assert.strictEqual(state.stamps[0].mode, 'payload-verified');
  assert.strictEqual(state.stamps[0].engine_verified, false);
  assert.deepStrictEqual(state.stamps[0].hooks_files, HOOK_FILES.slice());
  assert.strictEqual(state.stamps[0].hooks_digest, HDIGEST);
});

test('w1i: payload equal but an installed hook differs from hooks/dist -> npm ci, build:hooks twice, install.js, stamp installed', () => {
  const { deps, state } = syncDeps({ hooks: { dist: HDIGEST, installed: [OLD_HOOKS, HDIGEST] } });
  const r = cli.sync(deps);
  assert.strictEqual(r.code, 0, state.logs.join('\n'));
  const builds = idxAll(state, isBuildHooks);
  const ci = state.exec.findIndex(isNpmCi);
  const inst = state.exec.findIndex(isInstall);
  assert.strictEqual(builds.length, 2, 'early, then after npm ci');
  assert.ok(builds[0] < ci && ci < builds[1] && builds[1] < inst, JSON.stringify(state.exec.map((c) => c.args[0])));
  assert.strictEqual(state.stamps.length, 1);
  assert.strictEqual(state.stamps[0].mode, 'installed');
  assert.strictEqual(state.stamps[0].engine_verified, true);
  assert.strictEqual(state.stamps[0].hooks_digest, HDIGEST);
});

test('w1i: an early build that throws while the later one succeeds still reinstalls and stamps installed', () => {
  const { deps, state } = syncDeps({ buildThrows: 'early' });
  const r = cli.sync(deps);
  assert.strictEqual(r.code, 0, state.logs.join('\n'));
  assert.ok(ran(state, isNpmCi), 'an inconclusive fast path falls through to the slow path');
  assert.ok(ran(state, isInstall));
  assert.strictEqual(state.stamps[0].mode, 'installed');
  assert.match(state.logs.join('\n'), /inconclusive/i);
});

test('w1i: payload equal and BOTH builds throwing gives hooks-build-failed, no install.js, no stamp', () => {
  const { deps, state } = syncDeps({ buildThrows: 'both' });
  const r = cli.sync(deps);
  assert.strictEqual(r.reason, 'hooks-build-failed');
  assert.notStrictEqual(r.code, 0);
  assert.ok(ran(state, isNpmCi));
  assert.ok(!ran(state, isInstall));
  assert.strictEqual(state.stamps.length, 0);
  assert.strictEqual(state.rm.length, 1);
});

test('w1i: payload equal with an empty early dist reaches npm ci, then aborts hooks-dist-empty', () => {
  const { deps, state } = syncDeps({ distInventory: [[], []] });
  const r = cli.sync(deps);
  assert.strictEqual(r.reason, 'hooks-dist-empty');
  assert.ok(ran(state, isNpmCi), 'an empty early dist is inconclusive, not an abort');
  assert.ok(!ran(state, isInstall));
  assert.strictEqual(state.stamps.length, 0);
});

test('w1i: payload equal, hooks different and a symlinked runtime root -> symlinked-runtime-root, no npm ci, no install.js, no stamp (D-12)', () => {
  const { deps, state } = syncDeps({ hooks: { dist: HDIGEST, installed: [OLD_HOOKS, HDIGEST] } });
  deps.lstatSync = () => ({ isSymbolicLink: () => true });
  deps.realpathSync = () => '/home/u/.claude/gsd-core-next-edge';
  deps.env = {};
  const r = cli.sync(deps);
  assert.strictEqual(r.reason, 'symlinked-runtime-root');
  assert.notStrictEqual(r.code, 0);
  assert.ok(!ran(state, isNpmCi));
  assert.ok(!ran(state, isInstall));
  assert.strictEqual(state.stamps.length, 0);
  assert.strictEqual(state.rm.length, 1);
});

test('w1i: two consecutive sync runs each write one stamp with deepEqual hooks_files and the same hooks_digest', () => {
  const { deps, state } = syncDeps({
    digests: { clone: DIGEST, runtime: [STALE, DIGEST] },
    hooks: { dist: HDIGEST, installed: [OLD_HOOKS, HDIGEST] },
  });
  const r1 = cli.sync(deps);
  assert.strictEqual(r1.code, 0, state.logs.join('\n'));
  assert.strictEqual(state.stamps.length, 1);
  const r2 = cli.sync(deps);
  assert.strictEqual(r2.code, 0, state.logs.join('\n'));
  assert.strictEqual(state.stamps.length, 2);
  const [a, b] = state.stamps;
  assert.deepStrictEqual(a.hooks_files, HOOK_FILES.slice());
  assert.deepStrictEqual(a.hooks_files, b.hooks_files);
  assert.strictEqual(a.hooks_digest, HDIGEST);
  assert.strictEqual(a.hooks_digest, b.hooks_digest);
});

test('w1i guard: an install.js that throws (a timeout kill) aborts non-zero, no stamp, tmpdir removed', () => {
  const { deps, state } = syncDeps({ digests: { clone: DIGEST, runtime: [STALE, DIGEST] } });
  const inner = deps.execFileSync;
  deps.execFileSync = (file, args, o) => {
    if (args.some((a) => String(a).includes('install.js'))) {
      state.exec.push({ file, args });
      const e = new Error('spawnSync node ETIMEDOUT');
      e.code = 'ETIMEDOUT';
      throw e;
    }
    return inner(file, args, o);
  };
  const r = cli.sync(deps);
  assert.notStrictEqual(r.code, 0);
  assert.strictEqual(state.stamps.length, 0);
  assert.strictEqual(state.rm.length, 1);
});

function hooklessStamp() {
  const s = stampAt(TIP, DIGEST);
  delete s.hooks_files;
  delete s.hooks_digest;
  return s;
}

test('w1i: check over a hook-less stamp returns code 1, verdict unverified (predates hook coverage), writes nothing, twice', () => {
  const { deps, state } = checkDeps({ oracle: { readStamp: () => hooklessStamp() } });
  for (let i = 0; i < 2; i++) {
    const r = cli.check(deps);
    assert.strictEqual(r.code, 1);
    assert.strictEqual(r.verdict, 'unverified');
    assert.match(r.reason, /predates hook coverage/);
  }
  assert.strictEqual(state.stamps.length, 0, 'check must be read-only');
  assert.ok(state.logs.join('\n').includes(oracle.REMEDIATION_COMMAND));
});

test('w1i: check over a managed-hooks digest mismatch returns code 1 naming ~/.claude/hooks', () => {
  const { deps, state } = checkDeps({ oracle: { hooksDigestForStamp: () => OLD_HOOKS } });
  const r = cli.check(deps);
  assert.strictEqual(r.code, 1);
  assert.strictEqual(r.verdict, 'unverified');
  assert.ok(r.reason.includes('~/.claude/hooks'), r.reason);
  assert.strictEqual(state.stamps.length, 0);
});

test('w1i: check measures the hooks under deps.hooksRoot, defaulting to oracle.HOOKS_ROOT', () => {
  const a = checkDeps();
  a.deps.hooksRoot = '/x/hooks';
  assert.strictEqual(cli.check(a.deps).code, 0);
  assert.deepStrictEqual(a.state.hooksRoots, ['/x/hooks']);
  const b = checkDeps();
  assert.strictEqual(cli.check(b.deps).code, 0);
  assert.strictEqual(typeof oracle.HOOKS_ROOT, 'string');
  assert.deepStrictEqual(b.state.hooksRoots, [oracle.HOOKS_ROOT]);
});

test('w1i: verifyHooksWritten over a real temp dir reports {missing, stale}; a directory at a listed path is missing; a backdated mtime with a fresh ctime is written', (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  assert.strictEqual(typeof cli.verifyHooksWritten, 'function');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w1i-verify-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'lib'));
  fs.writeFileSync(path.join(root, 'gsd-a.js'), 'a');
  fs.writeFileSync(path.join(root, 'lib', 'b.sh'), 'b');
  fs.mkdirSync(path.join(root, 'dir.js'));
  const since = Date.now() - 1000;
  // Backdate lib/b.sh's mtime the way a mtime-preserving copy would. The kernel still sets its
  // ctime to now, so it counts as written by this install (CTK-ADR-0011 Decision 3).
  const old = (since - cli.HOOK_MTIME_SLACK_MS - 10000) / 1000;
  fs.utimesSync(path.join(root, 'lib', 'b.sh'), old, old);
  const bst = fs.statSync(path.join(root, 'lib', 'b.sh'));
  assert.ok(bst.mtimeMs < since - cli.HOOK_MTIME_SLACK_MS && bst.ctimeMs >= since - cli.HOOK_MTIME_SLACK_MS,
    'premise: utimes backdates mtime, not ctime (mtime ' + bst.mtimeMs + ', ctime ' + bst.ctimeMs + ')');
  const r = cli.verifyHooksWritten(root, ['dir.js', 'gone.js', 'gsd-a.js', 'lib/b.sh'], since);
  assert.deepStrictEqual(r, { missing: ['dir.js', 'gone.js'], stale: [] });
  // A real stale case: an install start after both of the file's timestamps (plus the slack).
  const future = Date.now() + cli.HOOK_MTIME_SLACK_MS + 60000;
  assert.deepStrictEqual(cli.verifyHooksWritten(root, ['gsd-a.js', 'lib/b.sh'], future), { missing: [], stale: ['gsd-a.js', 'lib/b.sh'] });
  assert.deepStrictEqual(cli.verifyHooksWritten(root, ['gsd-a.js'], since), { missing: [], stale: [] });
});
