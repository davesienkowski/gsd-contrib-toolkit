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
  fs.writeFileSync(path.join(mods, 'audit-local-mods.sh'), '#!/usr/bin/env bash\necho "MODIFIED 12"\necho "MISSING 3"\n');
  for (const s of REAPPLY) fs.writeFileSync(path.join(mods, s), '#!/usr/bin/env bash\nexit 0\n');
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
  const snapDirs = fs.readdirSync(sc.snaps).filter((n) => n.startsWith('snap-'));
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
