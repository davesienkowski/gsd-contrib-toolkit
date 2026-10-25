'use strict';

/**
 * bin/gsd-refresh.test.cjs - bin/gsd-refresh treats runtime-sync's refusal as a refusal
 * (quick 261024-po0, L11, CTK-ADR-0013).
 *
 * Since Task 1, `runtime-sync.cjs sync` refuses the daily ~/.claude install (or an invalid
 * CLAUDE_CONFIG_DIR) with exit 3 and `where` reports the same classification. gsd-refresh must:
 *   - run `where` before its confirmation and snapshot; exit 3 there ends the refresh with exit 4,
 *     a refused message naming ~/.gsd/local-mods/gsd-refresh.sh, no snapshot and no sync call
 *     (snapshot also prunes old snapshots, so snapshotting first would not be side-effect free);
 *   - map a sync exit 3 to exit 4 with the refused message, not "may be partial, roll back";
 *   - keep a sync exit 1 as exit 2 with the roll-back text (preserved behavior).
 *
 * SAFETY (the 2026-10-24 INCIDENT lesson: a red test against the old code overwrote a real state
 * file): every spawn runs with an env built from scratch, every path the script can write (HOME,
 * CLAUDE_CONFIG_DIR, GSD_LOCAL_MODS, GSD_REFRESH_SNAPSHOTS, the stub runtime-sync and its log) is
 * asserted BEFORE the spawn to resolve under the scratch root and outside the real ~/.claude,
 * ~/.gsd and ~/.gsd-contrib, and the stub runtime-sync is asserted to exist so the script can never
 * fall back to its default runtime-sync path. The old script runs the whole pipeline at red (it
 * never calls `where`), which is why the pre-assert is load-bearing.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, 'gsd-refresh');

// The four re-apply scripts bin/gsd-refresh preflights (REAPPLY=(...) in the script).
const REAPPLY = [
  'grant-memtrace-to-agents.sh',
  'remove-mempalace.sh',
  'j2-dispatch-event-schema-version.sh',
  'install-planning-track-hooks.sh',
];

function realHomeRoots() {
  const h = os.userInfo().homedir;
  return [path.join(h, '.claude'), path.join(h, '.gsd'), path.join(h, '.gsd-contrib')];
}

function inside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function makeScratch(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'po0-gsd-refresh-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const cfg = path.join(root, 'cfg');
  const mods = path.join(root, 'mods');
  const snaps = path.join(root, 'snaps');
  const stub = path.join(root, 'stub', 'runtime-sync.cjs');
  const log = path.join(root, 'stub', 'calls.log');
  for (const d of [home, path.join(cfg, 'gsd-core'), mods, snaps, path.dirname(stub)]) fs.mkdirSync(d, { recursive: true });
  // Every local-mods stub logs its own name, so a test can prove which ran.
  fs.writeFileSync(path.join(mods, 'audit-local-mods.sh'), '#!/usr/bin/env bash\necho "mod:audit-local-mods.sh" >> "$STUB_LOG"\necho "MODIFIED 12"\necho "MISSING 3"\n');
  for (const s of REAPPLY) fs.writeFileSync(path.join(mods, s), '#!/usr/bin/env bash\necho "mod:' + s + '" >> "$STUB_LOG"\nexit 0\n');
  fs.writeFileSync(
    stub,
    "'use strict';\n" +
      "const fs = require('fs');\n" +
      "const verb = process.argv[2] || '';\n" +
      "fs.appendFileSync(process.env.STUB_LOG, verb + '\\n');\n" +
      "console.log('stub runtime-sync ' + verb);\n" +
      "process.exit(Number(process.env['STUB_' + verb.toUpperCase() + '_CODE'] || 0));\n"
  );
  return { root, home, cfg, mods, snaps, stub, log };
}

function runRefresh(sc, codes) {
  const env = {
    PATH: process.env.PATH,
    HOME: sc.home,
    CLAUDE_CONFIG_DIR: sc.cfg,
    GSD_LOCAL_MODS: sc.mods,
    GSD_RUNTIME_SYNC: sc.stub,
    GSD_REFRESH_SNAPSHOTS: sc.snaps,
    STUB_LOG: sc.log,
    ...codes,
  };
  // Pre-assert BEFORE the spawn: every writable path is under the scratch root and outside the
  // real home's config/state dirs, and the stub exists (no fallback to the default runtime-sync).
  for (const key of ['HOME', 'CLAUDE_CONFIG_DIR', 'GSD_LOCAL_MODS', 'GSD_RUNTIME_SYNC', 'GSD_REFRESH_SNAPSHOTS', 'STUB_LOG']) {
    const p = path.resolve(env[key]);
    assert.ok(path.isAbsolute(env[key]), key + ' must be absolute: ' + env[key]);
    assert.ok(inside(p, sc.root) && p !== sc.root, key + ' must resolve under the scratch root ' + sc.root + ': ' + p);
    for (const real of realHomeRoots()) assert.ok(!inside(p, real), key + ' must not resolve inside ' + real + ': ' + p);
  }
  assert.ok(fs.statSync(sc.stub).isFile(), 'the stub runtime-sync must exist at GSD_RUNTIME_SYNC');
  const r = spawnSync('bash', [SCRIPT, '--yes'], { env, input: '', encoding: 'utf8', timeout: 60000 });
  const out = (r.stdout || '') + (r.stderr || '');
  const calls = fs.existsSync(sc.log) ? fs.readFileSync(sc.log, 'utf8') : '';
  // Round 2: snapshots live under a per-config-dir key, so count snap-* dirs at any depth.
  const snapDirs = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) if (e.isDirectory()) { if (e.name.startsWith('snap-')) snapDirs.push(e.name); else walk(path.join(d, e.name)); } };
  walk(sc.snaps);
  return { status: r.status, out, calls, snapDirs, error: r.error };
}

test('po0: where exit 3 ends the refresh with exit 4 and the refused text before any snapshot or sync', (t) => {
  const sc = makeScratch(t);
  const r = runRefresh(sc, { STUB_WHERE_CODE: '3' });
  assert.ifError(r.error);
  assert.strictEqual(r.status, 4, 'exit 4 expected; output:\n' + r.out);
  assert.ok(r.out.includes('refused'), 'output must name the refusal:\n' + r.out);
  assert.ok(r.out.includes('~/.gsd/local-mods/gsd-refresh.sh'), 'output must name the daily install maintainer:\n' + r.out);
  assert.strictEqual(r.calls, 'where\n', 'runtime-sync must be called exactly once, with where');
  assert.deepStrictEqual(r.snapDirs, [], 'no snapshot may be taken on a refused run');
});

test('po0: where 0 then sync exit 3 exits 4 with the refused text, not the partial-install text', (t) => {
  const sc = makeScratch(t);
  const r = runRefresh(sc, { STUB_WHERE_CODE: '0', STUB_SYNC_CODE: '3' });
  assert.ifError(r.error);
  assert.strictEqual(r.status, 4, 'exit 4 expected; output:\n' + r.out);
  assert.ok(r.out.includes('refused'), 'output must name the refusal:\n' + r.out);
  assert.ok(r.out.includes('~/.gsd/local-mods/gsd-refresh.sh'), 'output must name the daily install maintainer:\n' + r.out);
  assert.ok(!r.out.includes('may be partial'), 'a refused sync installed nothing; no partial-install text:\n' + r.out);
  assert.ok(!r.out.includes('Roll back with'), 'a refused sync needs no roll-back:\n' + r.out);
});

test('po0 guard: where 0 then sync exit 1 still exits 2 with the roll-back text', (t) => {
  const sc = makeScratch(t);
  const r = runRefresh(sc, { STUB_WHERE_CODE: '0', STUB_SYNC_CODE: '1' });
  assert.ifError(r.error);
  assert.strictEqual(r.status, 2, 'exit 2 expected; output:\n' + r.out);
  assert.ok(r.out.includes('sync FAILED'), 'output must say sync FAILED:\n' + r.out);
  assert.ok(r.out.includes('Roll back with'), 'output must carry the roll-back command:\n' + r.out);
});

test('po0: a contribution dir (where 0, sync 0) is refreshed WITHOUT re-applying local mods or the mod-baseline audit', (t) => {
  // CTK-ADR-0013: a contribution config dir must stay pristine, so the local mods that the daily
  // install carries are never re-applied there; the snapshot and roll-back still work.
  const sc = makeScratch(t);
  const r = runRefresh(sc, { STUB_WHERE_CODE: '0', STUB_SYNC_CODE: '0' });
  assert.ifError(r.error);
  assert.strictEqual(r.status, 0, 'exit 0 expected; output:\n' + r.out);
  assert.strictEqual(r.calls, 'where\nsync\n', 'only runtime-sync where and sync may run; calls:\n' + r.calls);
  assert.ok(!r.calls.includes('mod:'), 'no local-mods script may run in a contribution dir; calls:\n' + r.calls);
  assert.strictEqual(r.snapDirs.length, 1, 'the pre-sync snapshot is still taken');
  assert.ok(r.out.includes('not re-applied'), 'output must say the local mods are not re-applied:\n' + r.out);
});

// ------------- quick 261024-po0 round 2 (review CR-01): every writing mode classifies first -------------
//
// `--rollback` used to restore the newest snapshot in a SHARED snapshot root into whatever $CFG was,
// with no classification: from a daily session it replaced ~/.claude/{gsd-core,agents,skills,hooks}
// with a pristine contribution copy. Same scratch discipline as above: every writable path is
// pre-asserted under the scratch root before the spawn.

function runMode(sc, args, codes, cfg) {
  const env = {
    PATH: process.env.PATH,
    HOME: sc.home,
    CLAUDE_CONFIG_DIR: cfg || sc.cfg,
    GSD_LOCAL_MODS: sc.mods,
    GSD_RUNTIME_SYNC: sc.stub,
    GSD_REFRESH_SNAPSHOTS: sc.snaps,
    STUB_LOG: sc.log,
    ...codes,
  };
  for (const key of ['HOME', 'CLAUDE_CONFIG_DIR', 'GSD_LOCAL_MODS', 'GSD_RUNTIME_SYNC', 'GSD_REFRESH_SNAPSHOTS', 'STUB_LOG']) {
    const p = path.resolve(env[key]);
    assert.ok(path.isAbsolute(env[key]), key + ' must be absolute: ' + env[key]);
    assert.ok(inside(p, sc.root) && p !== sc.root, key + ' must resolve under the scratch root ' + sc.root + ': ' + p);
    for (const real of realHomeRoots()) assert.ok(!inside(p, real), key + ' must not resolve inside ' + real + ': ' + p);
  }
  assert.ok(fs.statSync(sc.stub).isFile(), 'the stub runtime-sync must exist at GSD_RUNTIME_SYNC');
  const r = spawnSync('bash', [SCRIPT, ...args], { env, input: '', encoding: 'utf8', timeout: 60000 });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || ''), error: r.error };
}

/** Every file under `dir` (relative path -> content), for before/after comparison. */
function tree(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = fs.readFileSync(p, 'utf8');
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

/** All snap-* dirs anywhere under the snapshot root (flat or per config dir). */
function allSnaps(snaps) {
  return Object.keys(tree(snaps)).filter((f) => f.endsWith('.snapshot-meta')).map((f) => path.dirname(f)).sort();
}

test('po0 r2: --rollback in the daily dir (where 3) exits 4, restores nothing and writes nothing (CR-01)', (t) => {
  const sc = makeScratch(t);
  fs.writeFileSync(path.join(sc.cfg, 'gsd-core', 'modded.md'), 'local mod\n');
  // A snapshot in the flat layout the old script reads: a pristine contribution copy.
  const snap = path.join(sc.snaps, 'snap-20261024-000000');
  fs.mkdirSync(path.join(snap, 'gsd-core'), { recursive: true });
  fs.writeFileSync(path.join(snap, 'gsd-core', 'pristine.md'), 'pristine\n');
  fs.writeFileSync(path.join(snap, '.snapshot-meta'), 'created=2026-10-24T00:00:00\n');
  const before = { cfg: tree(sc.cfg), snaps: tree(sc.snaps) };
  for (const args of [['--rollback', '--yes'], ['--rollback', '--yes', 'snap-20261024-000000']]) {
    const r = runMode(sc, args, { STUB_WHERE_CODE: '3' });
    assert.ifError(r.error);
    assert.strictEqual(r.status, 4, args.join(' ') + ': exit 4 expected; output:\n' + r.out);
    assert.ok(r.out.includes('refused'), 'output must name the refusal:\n' + r.out);
    assert.deepStrictEqual(tree(sc.cfg), before.cfg, 'the config dir must be untouched (no restore, no sentinel)');
    assert.deepStrictEqual(tree(sc.snaps), before.snaps, 'the snapshots must be untouched');
  }
});

test('po0 r2: --rollback in a contribution dir restores only a snapshot taken of THAT dir (CR-01)', (t) => {
  const sc = makeScratch(t);
  const cfgB = path.join(sc.root, 'cfgB');
  fs.mkdirSync(path.join(cfgB, 'gsd-core'), { recursive: true });
  fs.writeFileSync(path.join(sc.cfg, 'gsd-core', 'a.md'), 'A1\n');
  fs.writeFileSync(path.join(cfgB, 'gsd-core', 'b.md'), 'B1\n');
  // Snapshot dir A through a refresh (where 0, sync 0).
  const ref = runMode(sc, ['--yes'], { STUB_WHERE_CODE: '0', STUB_SYNC_CODE: '0' });
  assert.strictEqual(ref.status, 0, ref.out);
  const snapsA = allSnaps(sc.snaps);
  assert.strictEqual(snapsA.length, 1, 'one snapshot of A');
  const meta = fs.readFileSync(path.join(sc.snaps, snapsA[0], '.snapshot-meta'), 'utf8');
  assert.ok(meta.includes('config_dir=' + sc.cfg), 'the snapshot records its config dir:\n' + meta);
  // From B, neither the latest nor A's named snapshot may be restored.
  const beforeB = tree(cfgB);
  const latestB = runMode(sc, ['--rollback', '--yes'], { STUB_WHERE_CODE: '0' }, cfgB);
  assert.notStrictEqual(latestB.status, 0, 'no snapshot of B exists; output:\n' + latestB.out);
  const namedB = runMode(sc, ['--rollback', '--yes', path.basename(snapsA[0])], { STUB_WHERE_CODE: '0' }, cfgB);
  assert.notStrictEqual(namedB.status, 0, 'A\'s snapshot must not restore into B; output:\n' + namedB.out);
  assert.deepStrictEqual(tree(cfgB), beforeB, 'B must be untouched');
  // A path-traversal id is refused too.
  const trav = runMode(sc, ['--rollback', '--yes', '../' + path.basename(snapsA[0])], { STUB_WHERE_CODE: '0' }, cfgB);
  assert.notStrictEqual(trav.status, 0, trav.out);
  assert.deepStrictEqual(tree(cfgB), beforeB, 'B must be untouched after a traversal id');
  // From A, the rollback restores A.
  fs.writeFileSync(path.join(sc.cfg, 'gsd-core', 'a.md'), 'A2-broken\n');
  const backA = runMode(sc, ['--rollback', '--yes'], { STUB_WHERE_CODE: '0' });
  assert.strictEqual(backA.status, 0, backA.out);
  assert.strictEqual(fs.readFileSync(path.join(sc.cfg, 'gsd-core', 'a.md'), 'utf8'), 'A1\n', 'A restored from its own snapshot');
});

test('po0 r2: snapshot pruning stays within one config dir (CR-01)', (t) => {
  const sc = makeScratch(t);
  const cfgB = path.join(sc.root, 'cfgB');
  fs.mkdirSync(path.join(cfgB, 'gsd-core'), { recursive: true });
  const keep1 = { STUB_WHERE_CODE: '0', STUB_SYNC_CODE: '0', GSD_REFRESH_KEEP: '1' };
  assert.strictEqual(runMode(sc, ['--yes'], keep1, cfgB).status, 0);
  const snapB = allSnaps(sc.snaps);
  assert.strictEqual(snapB.length, 1);
  assert.strictEqual(runMode(sc, ['--yes'], keep1).status, 0);
  assert.strictEqual(runMode(sc, ['--yes'], keep1).status, 0);
  const all = allSnaps(sc.snaps);
  assert.ok(all.includes(snapB[0]), 'B\'s snapshot survives A\'s pruning; left: ' + all.join(', '));
  assert.strictEqual(all.length, 2, 'A keeps 1, B keeps 1; left: ' + all.join(', '));
});

test('po0 r2: rebaseline is retired: it exits non-zero and writes no baseline file (CR-01: check every writing mode)', (t) => {
  const sc = makeScratch(t);
  for (const where of ['0', '3']) {
    const r = runMode(sc, ['rebaseline'], { STUB_WHERE_CODE: where });
    assert.ifError(r.error);
    assert.notStrictEqual(r.status, 0, 'rebaseline must not succeed; output:\n' + r.out);
    assert.ok(r.out.includes('retired'), r.out);
    assert.ok(!fs.existsSync(path.join(sc.mods, '.gsd-refresh-baseline')), 'no baseline file may be written');
  }
});

test('po0 r2 guard: with the REAL runtime-sync where, --rollback from a scratch daily dir exits 4 and restores nothing', (t) => {
  // End to end through the real classifier (read-only `where`). HOME is the scratch home and
  // CLAUDE_CONFIG_DIR is that home's .claude, so the real classifier reads it as daily.
  const sc = makeScratch(t);
  const daily = path.join(sc.home, '.claude');
  fs.mkdirSync(path.join(daily, 'gsd-core'), { recursive: true });
  fs.writeFileSync(path.join(daily, 'gsd-core', 'modded.md'), 'local mod\n');
  const key = require('node:crypto').createHash('sha256').update(fs.realpathSync(daily)).digest('hex').slice(0, 16);
  const snap = path.join(sc.snaps, key, 'snap-20261024-000000');
  fs.mkdirSync(path.join(snap, 'gsd-core'), { recursive: true });
  fs.writeFileSync(path.join(snap, 'gsd-core', 'pristine.md'), 'pristine\n');
  fs.writeFileSync(path.join(snap, '.snapshot-meta'), 'config_dir=' + fs.realpathSync(daily) + '\n');
  const env = { PATH: process.env.PATH, HOME: sc.home, CLAUDE_CONFIG_DIR: daily, GSD_LOCAL_MODS: sc.mods,
    GSD_RUNTIME_SYNC: path.join(__dirname, 'runtime-sync.cjs'), GSD_REFRESH_SNAPSHOTS: sc.snaps };
  for (const key2 of ['HOME', 'CLAUDE_CONFIG_DIR', 'GSD_LOCAL_MODS', 'GSD_REFRESH_SNAPSHOTS']) {
    assert.ok(inside(path.resolve(env[key2]), sc.root), key2 + ' must be under the scratch root');
  }
  const before = { cfg: tree(daily), snaps: tree(sc.snaps) };
  const r = spawnSync('bash', [SCRIPT, '--rollback', '--yes'], { env, input: '', encoding: 'utf8', timeout: 60000 });
  const out = (r.stdout || '') + (r.stderr || '');
  assert.strictEqual(r.status, 4, out);
  assert.match(out, /classification: daily/);
  assert.deepStrictEqual(tree(daily), before.cfg, 'the daily dir is untouched');
  assert.deepStrictEqual(tree(sc.snaps), before.snaps, 'the snapshots are untouched');
});

// ------------- quick 261024-po0 round 2b (fresh review WR-02, WR-03) -------------

test('po0 r2b: a snapshot that cannot be written stops the refresh before sync (WR-02)', (t) => {
  const sc = makeScratch(t);
  fs.chmodSync(sc.snaps, 0o500);
  let r;
  try {
    r = runMode(sc, ['--yes'], { STUB_WHERE_CODE: '0', STUB_SYNC_CODE: '0' });
  } finally {
    fs.chmodSync(sc.snaps, 0o700); // before the scratch cleanup, which runs first among the after hooks
  }
  assert.notStrictEqual(r.status, 0, 'an unwritable snapshot must fail the refresh; output:\n' + r.out);
  const calls = fs.existsSync(sc.log) ? fs.readFileSync(sc.log, 'utf8') : '';
  assert.ok(!calls.includes('sync'), 'sync must not run without a snapshot; calls:\n' + calls);
  assert.ok(!r.out.includes('Refresh complete'), r.out);
});

test('po0 r2b: a snapshot root with a space still lists and rolls back the latest snapshot (WR-03)', (t) => {
  const sc = makeScratch(t);
  const spaced = path.join(sc.root, 'snap root');
  fs.mkdirSync(spaced);
  const sc2 = Object.assign({}, sc, { snaps: spaced });
  fs.writeFileSync(path.join(sc.cfg, 'gsd-core', 'a.md'), 'A1\n');
  assert.strictEqual(runMode(sc2, ['--yes'], { STUB_WHERE_CODE: '0', STUB_SYNC_CODE: '0' }).status, 0);
  const list = runMode(sc2, ['--list'], {});
  assert.match(list.out, /snap-\d{8}-\d{6}/, 'the snapshot is listed:\n' + list.out);
  fs.writeFileSync(path.join(sc.cfg, 'gsd-core', 'a.md'), 'A2\n');
  const back = runMode(sc2, ['--rollback', '--yes'], { STUB_WHERE_CODE: '0' });
  assert.strictEqual(back.status, 0, back.out);
  assert.strictEqual(fs.readFileSync(path.join(sc.cfg, 'gsd-core', 'a.md'), 'utf8'), 'A1\n');
});
