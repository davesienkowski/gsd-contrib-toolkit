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

// quick 261024-po0 (CTK-ADR-0013): the classified config-dir descriptors the stubbed oracle returns.
const CONTRIB_CFG = '/home/u/.claude-contrib';
const CONTRIB_STATE = '/home/u/.gsd-contrib/config-dirs/0123456789abcdef';
function contribDesc(cfg = CONTRIB_CFG, stateDir = CONTRIB_STATE) {
  return {
    kind: 'contrib', fromEnv: true, value: cfg, configDir: cfg,
    runtimeRoot: path.join(cfg, 'gsd-core'), hooksRoot: path.join(cfg, 'hooks'), stateDir,
    runtimeLabel: path.join(cfg, 'gsd-core'), hooksLabel: path.join(cfg, 'hooks'), reason: '',
  };
}
function dailyDesc() {
  return {
    kind: 'daily', fromEnv: false, value: undefined, configDir: '/home/u/.claude',
    runtimeRoot: '/home/u/.claude/gsd-core', hooksRoot: '/home/u/.claude/hooks', stateDir: '/home/u/.gsd-contrib',
    runtimeLabel: '~/.claude/gsd-core', hooksLabel: '~/.claude/hooks',
    reason: 'CLAUDE_CONFIG_DIR is unset, so the session uses the daily ~/.claude',
  };
}
function invalidDesc(value = 'rel/x') {
  return {
    kind: 'invalid', fromEnv: true, value, configDir: null, runtimeRoot: null, hooksRoot: null, stateDir: null,
    runtimeLabel: null, hooksLabel: null,
    reason: 'CLAUDE_CONFIG_DIR=' + JSON.stringify(value) + ' is not an absolute path',
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
        // po0: the default world is a contribution session (the only kind sync may install into).
        classifyConfigDir: () => contribDesc(),
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
        // po0: every install.js call is a real install (the D-11 projection is gone, and the real
        // install now carries --config-dir <cfg>), so each one advances the sequence.
        if (args.some((a) => String(a).includes('install.js'))) {
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
      // po0: the default check world is the daily dir (tilde labels), so the existing pins hold.
      classifyConfigDir: () => dailyDesc(),
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

test('po0: sync SLOW PATH: npm ci runs in the CLONE, install.js runs via node with --claude --global --config-dir <cfg> and CLAUDE_CONFIG_DIR=<cfg>', () => {
  const STALE = 'sha256:' + '1'.repeat(64);
  const { deps, state } = syncDeps({
    digests: { clone: DIGEST, runtime: [STALE, DIGEST] },
  });
  const calls = [];
  let real = 0;
  deps.execFileSync = (file, args, opts) => {
    calls.push({ file, args, opts });
    state.exec.push({ file, args });
    if (file === 'git' && args[0] === '-C' && args[2] === 'rev-parse') return TIP + '\n';
    if (args.some((a) => String(a).includes('install.js'))) real += 1;
    return '';
  };
  // Re-point the digest stub at this test's own install counter.
  deps.oracle.payloadDigest = (root) => {
    const s = String(root);
    if (s.startsWith(TMP)) return DIGEST;
    return real === 0 ? STALE : DIGEST;
  };
  const r = cli.sync(deps);
  assert.strictEqual(r.code, 0, state.logs.join('\n'));
  const ci = calls.find(isNpmCi);
  assert.strictEqual(ci.opts.cwd, TMP);
  assert.strictEqual(ci.opts.timeout, 600000);
  const installs = calls.filter(isInstall);
  assert.strictEqual(installs.length, 1, 'exactly one install.js call');
  const inst = installs[0];
  assert.strictEqual(inst.file, process.execPath);
  assert.deepStrictEqual(inst.args,
    [path.join(TMP, 'bin', 'install.js'), '--claude', '--global', '--config-dir', CONTRIB_CFG]);
  assert.ok(inst.opts.env && inst.opts.env.CLAUDE_CONFIG_DIR === CONTRIB_CFG,
    'the child env carries the same config dir as the flag');
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

test('po0: sync D-13: exactly one install.js call, whose --config-dir is the classified config dir, never a sandbox under the clone tmpdir', () => {
  const STALE = 'sha256:' + '1'.repeat(64);
  const { deps, state } = syncDeps({ digests: { clone: DIGEST, runtime: [STALE, STALE] } });
  cli.sync(deps);
  const installs = state.exec.filter(isInstall);
  assert.strictEqual(installs.length, 1, 'a sandboxed projection install must not be run (it was unsound)');
  const i = installs[0].args.indexOf('--config-dir');
  assert.ok(i >= 0, 'the real install names its config dir explicitly');
  const cfg = installs[0].args[i + 1];
  assert.strictEqual(cfg, CONTRIB_CFG);
  assert.ok(!String(cfg).startsWith(TMP), 'the config dir is not a projection sandbox inside the clone tmpdir');
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

test('po0: check measures the hooks under deps.hooksRoot, defaulting to the classified descriptor\'s hooks root', () => {
  const a = checkDeps();
  a.deps.hooksRoot = '/x/hooks';
  assert.strictEqual(cli.check(a.deps).code, 0);
  assert.deepStrictEqual(a.state.hooksRoots, ['/x/hooks']);
  const b = checkDeps();
  assert.strictEqual(cli.check(b.deps).code, 0);
  assert.deepStrictEqual(b.state.hooksRoots, ['/home/u/.claude/hooks']);
  const c = checkDeps({ oracle: { classifyConfigDir: () => contribDesc() } });
  delete c.deps.runtimeRoot;
  assert.strictEqual(cli.check(c.deps).code, 0);
  assert.deepStrictEqual(c.state.hooksRoots, [path.join(CONTRIB_CFG, 'hooks')]);
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

// ------------- quick 261024-po0 (CTK-ADR-0013): sync refuses the daily install; where; check -------------
//
// Every new export (where) is touched only inside a test body. Cases that use the REAL classifier
// pass `deps.env` and `deps.homedir` explicitly, so the runner's own CLAUDE_CONFIG_DIR never leaks in.

const po0Fs = require('node:fs');
const po0Os = require('node:os');
const po0Crypto = require('node:crypto');

function po0Key(cfg) {
  return po0Crypto.createHash('sha256').update(path.resolve(cfg)).digest('hex').slice(0, 16);
}

/** A real temp HOME for the real-classifier cases, removed after the test. */
function po0Home(t) {
  const root = po0Fs.mkdtempSync(path.join(po0Os.tmpdir(), 'po0-sync-'));
  t.after(() => po0Fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  po0Fs.mkdirSync(home);
  return { root, home };
}

function po0AssertRefused(r, state, reason) {
  assert.strictEqual(r.code, 3, state.logs.join('\n'));
  assert.strictEqual(r.reason, reason);
  assert.deepStrictEqual(state.exec, [], 'no execFileSync call at all: the ls-remote tip lookup never ran');
  assert.strictEqual(state.mkdtemp, 0, 'no tmpdir was created');
  assert.strictEqual(state.stamps.length, 0, 'no stamp was written');
}

for (const [label, desc, reason] of [
  ['daily', dailyDesc(), 'refused-daily-config-dir'],
  ['invalid', invalidDesc('rel/x'), 'refused-invalid-config-dir'],
]) {
  test('po0: sync with a ' + label + ' config dir (stubbed classifier) refuses with code 3 before any exec, tmpdir or stamp, printing the hint', () => {
    const { deps, state } = syncDeps({ oracle: { classifyConfigDir: () => desc } });
    const r = cli.sync(deps);
    po0AssertRefused(r, state, reason);
    const out = state.logs.join('\n');
    assert.match(out, /ENF-21 sync REFUSED:/);
    assert.ok(out.includes('CLAUDE_CONFIG_DIR='), out);
    assert.ok(out.includes('$HOME/.claude-contrib'), out);
    assert.ok(out.includes('CLAUDE_CODE_SUBPROCESS_ENV_SCRUB'), out);
    assert.ok(out.includes(oracle.CONTRIB_SESSION_HINT), 'the single-source hint is quoted verbatim');
  });
}

test('po0: sync with the REAL classifier refuses the daily dir: variable unset, the explicit daily path, and a real symlink to it', (t) => {
  const { root, home } = po0Home(t);
  const daily = path.join(home, '.claude');
  po0Fs.mkdirSync(daily);
  const link = path.join(root, 'daily-link');
  po0Fs.symlinkSync(daily, link);
  for (const env of [{}, { CLAUDE_CONFIG_DIR: daily }, { CLAUDE_CONFIG_DIR: link }]) {
    const { deps, state } = syncDeps({ oracle: { classifyConfigDir: oracle.classifyConfigDir } });
    deps.env = env;
    deps.homedir = home;
    const r = cli.sync(deps);
    po0AssertRefused(r, state, 'refused-daily-config-dir');
  }
  assert.deepStrictEqual(po0Fs.readdirSync(home), ['.claude'], 'the refused runs wrote nothing under HOME');
});

test('po0: sync with the REAL classifier refuses an invalid CLAUDE_CONFIG_DIR', (t) => {
  const { home } = po0Home(t);
  for (const value of ['', 'rel/x', '~/x']) {
    const { deps, state } = syncDeps({ oracle: { classifyConfigDir: oracle.classifyConfigDir } });
    deps.env = { CLAUDE_CONFIG_DIR: value };
    deps.homedir = home;
    po0AssertRefused(cli.sync(deps), state, 'refused-invalid-config-dir');
  }
});

test('po0: sync with the REAL classifier and a contribution dir reaches install.js with that dir and stamps into its per-dir state', (t) => {
  const { root, home } = po0Home(t);
  const cfg = path.join(root, 'contrib');
  const STALE = 'sha256:' + '1'.repeat(64);
  const seen = [];
  const { deps, state } = syncDeps({
    digests: { clone: DIGEST, runtime: [STALE, DIGEST] },
    oracle: {
      classifyConfigDir: oracle.classifyConfigDir,
      writeStamp: (s, o) => { state.stamps.push(s); seen.push(o); return o && o.stampPath; },
    },
  });
  deps.env = { CLAUDE_CONFIG_DIR: cfg };
  deps.homedir = home;
  const r = cli.sync(deps);
  assert.strictEqual(r.code, 0, state.logs.join('\n'));
  const inst = state.exec.filter(isInstall);
  assert.strictEqual(inst.length, 1);
  assert.deepStrictEqual(inst[0].args, [path.join(TMP, 'bin', 'install.js'), '--claude', '--global', '--config-dir', cfg]);
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].stampPath,
    path.join(home, '.gsd-contrib', 'config-dirs', po0Key(cfg), 'runtime-stamp.json'),
    'the stamp lands in the contribution dir\'s own state dir, the one where reports');
});

test('po0: sync passes stampPath = <descriptor stateDir>/runtime-stamp.json to writeStamp (stubbed classifier)', () => {
  const STALE = 'sha256:' + '1'.repeat(64);
  const seen = [];
  const { deps, state } = syncDeps({
    digests: { clone: DIGEST, runtime: [STALE, DIGEST] },
    oracle: { writeStamp: (s, o) => { state.stamps.push(s); seen.push(o); return '/s'; } },
  });
  const r = cli.sync(deps);
  assert.strictEqual(r.code, 0, state.logs.join('\n'));
  assert.strictEqual(seen.length, 1);
  assert.ok(seen[0] && seen[0].stampPath === path.join(CONTRIB_STATE, 'runtime-stamp.json'), JSON.stringify(seen[0]));
});

function po0WhereDeps(desc) {
  const state = { logs: [], writes: [] };
  const deps = {
    oracle: {
      classifyConfigDir: () => desc,
      writeStamp: () => { state.writes.push('stamp'); },
      writeCacheLive: () => { state.writes.push('cache'); },
    },
    log: (l) => state.logs.push(String(l)),
  };
  return { deps, state };
}

test('po0: where for a contribution dir exits 0 and prints the config dir, classification, runtime root, hooks root and state dir', () => {
  const { deps, state } = po0WhereDeps(contribDesc());
  const r = cli.where(deps);
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.kind, 'contrib');
  const out = state.logs.join('\n');
  assert.match(out, /config dir: \/home\/u\/\.claude-contrib/);
  assert.match(out, /classification: contrib/);
  assert.ok(out.includes('runtime root: ' + path.join(CONTRIB_CFG, 'gsd-core')), out);
  assert.ok(out.includes('hooks root: ' + path.join(CONTRIB_CFG, 'hooks')), out);
  assert.ok(out.includes('state dir: ' + CONTRIB_STATE), out);
  assert.ok(!out.includes(oracle.CONTRIB_SESSION_HINT), 'no hint for a contribution dir');
  assert.deepStrictEqual(state.writes, [], 'where writes nothing');
});

for (const [label, desc] of [['daily', dailyDesc()], ['invalid', invalidDesc('~/x')]]) {
  test('po0: where for a ' + label + ' config dir exits 3 with the reason and the hint, writing nothing', () => {
    const { deps, state } = po0WhereDeps(desc);
    const r = cli.where(deps);
    assert.strictEqual(r.code, 3);
    assert.strictEqual(r.kind, label);
    const out = state.logs.join('\n');
    assert.match(out, new RegExp('classification: ' + label));
    assert.ok(out.includes(desc.reason), out);
    assert.ok(out.includes(oracle.CONTRIB_SESSION_HINT), out);
    if (label === 'invalid') assert.match(out, /runtime root: \(none\)/);
    assert.deepStrictEqual(state.writes, []);
  });
}

test('po0: check with an invalid config dir returns 3 before measuring anything', () => {
  const boom = (n) => () => { throw new Error(n + ' must not be called for an invalid config dir'); };
  const { deps, state } = checkDeps({
    oracle: {
      classifyConfigDir: () => invalidDesc('rel/x'),
      runtimeDigest: boom('runtimeDigest'),
      readStamp: boom('readStamp'),
      hooksDigestForStamp: boom('hooksDigestForStamp'),
      upstreamTip: boom('upstreamTip'),
    },
  });
  const r = cli.check(deps);
  assert.strictEqual(r.code, 3);
  assert.strictEqual(r.verdict, 'invalid-config-dir');
  const out = state.logs.join('\n');
  assert.ok(out.includes(invalidDesc('rel/x').reason), out);
  assert.ok(out.includes(oracle.CONTRIB_SESSION_HINT), out);
});

test('po0: check on the daily dir appends the hint after a non-fresh verdict and after an unknown one, never after fresh', () => {
  const drift = checkDeps({ oracle: { upstreamTip: () => ({ sha: OTHER, source: 'live', ageMs: 0 }) } });
  assert.strictEqual(cli.check(drift.deps).code, 1);
  assert.ok(drift.state.logs.join('\n').includes(oracle.CONTRIB_SESSION_HINT));
  const unknown = checkDeps({ oracle: { upstreamTip: () => { throw new oracle.UpstreamUnavailable('offline'); } } });
  assert.strictEqual(cli.check(unknown.deps).code, 2);
  assert.ok(unknown.state.logs.join('\n').includes(oracle.CONTRIB_SESSION_HINT));
  const fresh = checkDeps();
  assert.strictEqual(cli.check(fresh.deps).code, 0);
  assert.ok(!fresh.state.logs.join('\n').includes(oracle.CONTRIB_SESSION_HINT));
});

test('po0: check for a contribution dir names its absolute roots and carries no hint', () => {
  const rt = checkDeps({ oracle: { classifyConfigDir: () => contribDesc(), runtimeDigest: () => 'sha256:' + '0'.repeat(64) } });
  delete rt.deps.runtimeRoot;
  const r = cli.check(rt.deps);
  assert.strictEqual(r.code, 1);
  assert.ok(r.reason.includes(path.join(CONTRIB_CFG, 'gsd-core')), r.reason);
  assert.ok(!rt.state.logs.join('\n').includes(oracle.CONTRIB_SESSION_HINT));
  const hk = checkDeps({ oracle: { classifyConfigDir: () => contribDesc(), hooksDigestForStamp: () => 'sha256:' + '3'.repeat(64) } });
  delete hk.deps.runtimeRoot;
  const r2 = cli.check(hk.deps);
  assert.strictEqual(r2.code, 1);
  assert.ok(r2.reason.includes(path.join(CONTRIB_CFG, 'hooks')), r2.reason);
  assert.ok(!r2.reason.includes('~/.claude/hooks'), r2.reason);
});

test('po0: check reads the stamp and the tip cache from the descriptor\'s state dir', () => {
  const seen = {};
  const { deps } = checkDeps({
    oracle: {
      classifyConfigDir: () => contribDesc(),
      readStamp: (o) => { seen.stamp = o; return stampAt(TIP, DIGEST); },
      upstreamTip: (o) => { seen.tip = o; return { sha: TIP, source: 'live', ageMs: 0 }; },
    },
  });
  assert.strictEqual(cli.check(deps).code, 0);
  assert.strictEqual(seen.stamp && seen.stamp.stampPath, path.join(CONTRIB_STATE, 'runtime-stamp.json'));
  assert.strictEqual(seen.tip && seen.tip.cachePath, path.join(CONTRIB_STATE, 'upstream-tip-cache.json'));
});

test('po0: main dispatches where, and a bare invocation prints USAGE naming check|sync|where and exit 3, returning 2', () => {
  const { deps } = po0WhereDeps(contribDesc());
  assert.strictEqual(cli.main(['where'], deps), 0);
  const d3 = po0WhereDeps(dailyDesc());
  assert.strictEqual(cli.main(['where'], d3.deps), 3);
  const logs = [];
  assert.strictEqual(cli.main([], { log: (l) => logs.push(String(l)) }), 2);
  const out = logs.join('\n');
  assert.ok(out.includes('<check|sync|where>'), out);
  assert.match(out, /\b3\b/);
  assert.match(out, /refuses/i);
});

/** Spawn the real CLI with an env built from scratch over a scratch HOME. */
function po0Spawn(verb, home, extra = {}) {
  const { spawnSync } = require('node:child_process');
  const env = Object.assign({
    PATH: process.env.PATH || '',
    HOME: home,
    HTTPS_PROXY: 'http://127.0.0.1:9',
    https_proxy: 'http://127.0.0.1:9',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
  }, extra);
  return spawnSync(process.execPath, [path.join(__dirname, 'runtime-sync.cjs'), verb], { env, encoding: 'utf8', timeout: 30000 });
}

test('po0: spawned `where` over a scratch HOME exits 3 with CLAUDE_CONFIG_DIR unset, 0 naming <cfg>/gsd-core for an absolute contribution dir', (t) => {
  const { root, home } = po0Home(t);
  const unset = po0Spawn('where', home);
  assert.strictEqual(unset.status, 3, unset.stdout + unset.stderr);
  assert.ok(unset.stdout.includes('CLAUDE_CONFIG_DIR='), unset.stdout);
  const cfg = path.join(root, 'contrib');
  const ok = po0Spawn('where', home, { CLAUDE_CONFIG_DIR: cfg });
  assert.strictEqual(ok.status, 0, ok.stdout + ok.stderr);
  assert.ok(ok.stdout.includes(path.join(cfg, 'gsd-core')), ok.stdout);
  assert.deepStrictEqual(po0Fs.readdirSync(home), [], 'where wrote nothing under HOME');
});

test('po0: spawned `sync` over a scratch HOME with CLAUDE_CONFIG_DIR unset exits 3, clones nothing and leaves HOME empty', (t) => {
  const { home } = po0Home(t);
  const r = po0Spawn('sync', home);
  assert.strictEqual(r.status, 3, r.stdout + r.stderr);
  assert.ok(!r.stdout.includes('Cloning'), r.stdout);
  assert.deepStrictEqual(po0Fs.readdirSync(home), [], 'the refused sync wrote nothing under HOME');
});

// quick 261024-po0 round 2 (review WR-04): install.js's symlinked-destination guard must not be
// disabled by an inherited opt-in, so the child env drops it (and the agents-dir redirect).
test('po0 r2: sync strips GSD_ALLOW_SYMLINKED_DEST and GSD_AGENTS_DIR from the install.js child env', () => {
  const STALE = 'sha256:' + '1'.repeat(64);
  const { deps, state } = syncDeps({ digests: { clone: DIGEST, runtime: [STALE, DIGEST] } });
  deps.env = { PATH: process.env.PATH, CLAUDE_CONFIG_DIR: CONTRIB_CFG, GSD_ALLOW_SYMLINKED_DEST: '1', GSD_AGENTS_DIR: '/home/u/.claude/agents', KEEP_ME: 'x' };
  const calls = [];
  let real = 0;
  deps.execFileSync = (file, args, opts) => {
    calls.push({ file, args, opts });
    state.exec.push({ file, args });
    if (file === 'git' && args[0] === '-C' && args[2] === 'rev-parse') return TIP + '\n';
    if (args.some((a) => String(a).includes('install.js'))) real += 1;
    return '';
  };
  deps.oracle.payloadDigest = (root) => (String(root).startsWith(TMP) ? DIGEST : (real === 0 ? STALE : DIGEST));
  const r = cli.sync(deps);
  assert.strictEqual(r.code, 0, state.logs.join('\n'));
  const inst = calls.filter(isInstall)[0];
  assert.ok(inst, 'install.js ran');
  assert.ok(!('GSD_ALLOW_SYMLINKED_DEST' in inst.opts.env), 'GSD_ALLOW_SYMLINKED_DEST must not reach install.js');
  assert.ok(!('GSD_AGENTS_DIR' in inst.opts.env), 'GSD_AGENTS_DIR must not reach install.js');
  assert.strictEqual(inst.opts.env.KEEP_ME, 'x', 'the rest of the env is forwarded');
  assert.strictEqual(inst.opts.env.CLAUDE_CONFIG_DIR, CONTRIB_CFG);
});
