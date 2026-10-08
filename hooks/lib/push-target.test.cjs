'use strict';

/**
 * node:test for hooks/lib/push-target.cjs (quick-261007-rni F9, Revision 1).
 *
 * Proven here:
 *   - pushRepositoryArg: the git push option walk returns the repository (first positional, else
 *     the last --repo), none, or indeterminate for every option form the plan's walk table names;
 *   - classifyPushTarget: the four-way rule (a: upstream -> gsd-core, b: every URL another repo
 *     and no redirect channel -> other, c: unresolvable / indeterminate / redirected -> null plus
 *     a phrase, d: no repository -> null with no phrase), with lookup and dir call counts;
 *   - resolvePushUrlsLive against a hermetic real git repo (global and system config isolated).
 *
 * Every classifyPushTarget input is built the way the gate builds it: parseCommandForGates on the
 * whole command, then the segment the shared classifier names `push`.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const pt = require('./push-target.cjs');
const { parseCommandForGates } = require('./argv.cjs');
const { classifyAction } = require('./classify.cjs');

const FORK = 'https://github.com/davesienkowski/gsd-core-experiments.git';
const FORK_SCP = 'git@github.com:davesienkowski/gsd-core-experiments.git';
const UPSTREAM = 'https://github.com/open-gsd/gsd-core.git';
const TOOLKIT = 'https://github.com/davesienkowski/gsd-contrib-toolkit.git';
const PD4 = /an unresolvable push target is treated as `open-gsd\/gsd-core`/;

/** Parse a whole command and return {parsed, seg} for its (last) push segment. */
function pushOf(cmd) {
  const parsed = parseCommandForGates(cmd);
  assert.ok(parsed.ok, 'fixture must parse: ' + cmd);
  let seg = null;
  for (const s of parsed.segments) {
    if (classifyAction({ ok: true, segments: [s] }).action === 'push') seg = s;
  }
  assert.ok(seg, 'fixture must contain a push segment: ' + cmd);
  return { parsed, seg };
}

/**
 * Injected io with call counts. `dirs` is the segmentDirs result (or a function that throws);
 * `lookup(dir, name)` returns URLs or throws.
 */
function makeIo({ dirs = ['/r'], lookup = () => [FORK] } = {}) {
  const log = { dirs: 0, lookups: [] };
  const io = {
    segmentDirs: () => {
      log.dirs += 1;
      return typeof dirs === 'function' ? dirs() : dirs;
    },
    resolvePushUrls: (dir, name) => {
      log.lookups.push([dir, name]);
      return lookup(dir, name);
    },
  };
  return { io, log };
}

function classify(cmd, ioOpts) {
  const { parsed, seg } = pushOf(cmd);
  const { io, log } = makeIo(ioOpts);
  return { r: pt.classifyPushTarget(seg, parsed, io), log };
}

function assertUnresolved(r, label) {
  assert.strictEqual(r.target, null, label + ': target must be null (rule c)');
  assert.ok(typeof r.unresolved === 'string' && r.unresolved.length > 0, label + ': rule c carries a phrase');
}

// ─────────────────────────── the option walk ───────────────────────────

const REPO_ROWS = [
  ['git push -u backup x', 'backup'],
  ['git push -fu backup x', 'backup'],
  ['git push -o ci.skip backup x', 'backup'],
  ['git push -oci.skip backup x', 'backup'],
  ['git push --push-option=ci.skip backup x', 'backup'],
  ['git push --push-option ci.skip backup x', 'backup'],
  ['git push --recurse-submodules=check backup x', 'backup'],
  ['git push --no-recurse-submodules backup x', 'backup'],
  ['git push --force-with-lease backup x', 'backup'],
  ['git push --force-with-lease=main:abc backup x', 'backup'],
  ['git push --signed backup x', 'backup'],
  ['git push --no-verify backup x', 'backup'],
  ['git push -- backup x', 'backup'],
  ['sudo -u u git -C /d push backup x', 'backup'],
  ['git -C /d --no-pager push backup x', 'backup'],
  ['git push --repo=a --repo=backup', 'backup'],
  ['git push --repo=backup x', 'x'],
  ['git push --repo backup', 'backup'],
  ['git push --repo=', ''],
];
for (const [cmd, want] of REPO_ROWS) {
  test('push-target: walk `' + cmd + '` -> repository ' + JSON.stringify(want), () => {
    assert.deepStrictEqual(pt.pushRepositoryArg(pushOf(cmd).seg), { kind: 'repo', value: want });
  });
}

for (const cmd of ['git push', 'git push -u', 'git push --tags', 'git push --repo=backup --no-repo']) {
  test('push-target: walk `' + cmd + '` -> none (no repository)', () => {
    assert.deepStrictEqual(pt.pushRepositoryArg(pushOf(cmd).seg), { kind: 'none' });
  });
}

for (const cmd of [
  'git push --recurse-submodules check backup x',
  'git push --push-opt x backup y',
  'git push --recurse=check backup y',
  'git push -ua main',
  'git push --receive-pack x backup y',
  'git push --receive-pack=x backup y',
  'git push --exec=x backup y',
  'git -c k=v push backup y',
  'git --git-dir=/x push backup y',
  'git --work-tree=/x push backup y',
  'git push -z backup y',
  'git push --frobnicate backup y',
  'git push --tags=x backup y',
  'git push -o',
]) {
  test('push-target: walk `' + cmd + '` -> indeterminate', () => {
    const r = pt.pushRepositoryArg(pushOf(cmd).seg);
    assert.strictEqual(r.kind, 'indeterminate', cmd + ' -> ' + JSON.stringify(r));
    assert.ok(typeof r.reason === 'string' && r.reason.length > 0);
  });
}

test('push-target: PUSH_URL_TIMEOUT_MS is 3000', () => {
  assert.strictEqual(pt.PUSH_URL_TIMEOUT_MS, 3000);
});

// ─────────────────────────── rule c: unresolvable -> null plus a phrase ───────────────────────────

test('push-target: a lookup that prints no URL -> rule c', () => {
  const { r } = classify('git push backup x', { lookup: () => [] });
  assertUnresolved(r, 'empty URL list');
});

test('push-target: an empty --repo= value -> rule c with no lookup', () => {
  const { r, log } = classify('git push --repo=', {});
  assertUnresolved(r, 'empty value');
  assert.strictEqual(log.lookups.length, 0);
  assert.strictEqual(log.dirs, 0);
});

test('push-target: a null or empty candidate-dir list -> rule c with no lookup', () => {
  for (const dirs of [null, []]) {
    const { r, log } = classify('git push backup x', { dirs });
    assertUnresolved(r, JSON.stringify(dirs));
    assert.strictEqual(log.lookups.length, 0);
  }
});

test('push-target: a throwing segmentDirs -> rule c', () => {
  const { r } = classify('git push backup x', { dirs: () => { throw new Error('boom'); } });
  assertUnresolved(r, 'throwing segmentDirs');
});

test('push-target: a throwing lookup (no such remote, timeout kill) -> rule c naming the remote', () => {
  const { r } = classify('git push nosuchremote x', { lookup: () => { throw new Error("error: No such remote 'nosuchremote'"); } });
  assertUnresolved(r, 'throwing lookup');
  assert.match(r.unresolved, /nosuchremote/);
});

test('push-target: an unparseable looked-up URL -> rule c', () => {
  const { r } = classify('git push backup x', { lookup: () => ['not a url'] });
  assertUnresolved(r, 'unparseable URL');
});

test('push-target: an indeterminate walk -> rule c with no lookup', () => {
  const { r, log } = classify('git push --push-opt x backup y', {});
  assertUnresolved(r, 'indeterminate');
  assert.strictEqual(log.lookups.length, 0);
});

test('push-target: no repository -> rule d (target null, no phrase), no dir or lookup call', () => {
  for (const cmd of ['git push', 'git push -u', 'git push --tags']) {
    const { r, log } = classify(cmd, {});
    assert.deepStrictEqual(r, { target: null, unresolved: null }, cmd);
    assert.strictEqual(log.dirs, 0);
    assert.strictEqual(log.lookups.length, 0);
  }
});

for (const cmd of ['git push $R y', 'git push a`b`c y', 'git push -- -x y']) {
  test('push-target: `' + cmd + '` -> rule c without any lookup (expansion or dash token)', () => {
    const { r, log } = classify(cmd, {});
    assertUnresolved(r, cmd);
    assert.strictEqual(log.dirs, 0);
    assert.strictEqual(log.lookups.length, 0);
  });
}

test('push-target: the literal `~` -> rule c (does not name an owner/repo)', () => {
  const { r, log } = classify('git push ~ x', {});
  assertUnresolved(r, '~');
  assert.strictEqual(log.lookups.length, 0);
});

// ─────────────────────────── rule a: upstream arms ───────────────────────────

test('push-target: an upstream URL in position 2 of 2 -> gsd-core', () => {
  const { r } = classify('git push origin x', { lookup: () => [FORK, UPSTREAM] });
  assert.deepStrictEqual(r, { target: 'gsd-core', unresolved: null });
});

test('push-target: an upstream URL in dir 2 of 2 wins even when dir 1 lookup threw', () => {
  const { r, log } = classify('git push origin x', {
    dirs: ['/a', '/b'],
    lookup: (dir) => { if (dir === '/a') throw new Error('No such remote'); return [UPSTREAM]; },
  });
  assert.deepStrictEqual(r, { target: 'gsd-core', unresolved: null });
  assert.deepStrictEqual(log.lookups, [['/a', 'origin'], ['/b', 'origin']]);
});

for (const lit of ['https://github.com/Open-GSD/GSD-Core.git', 'git@github.com:OPEN-GSD/gsd-core.git']) {
  test('push-target: case-variant upstream literal `' + lit + '` -> gsd-core with no lookup', () => {
    const { r, log } = classify('git push ' + lit + ' x', {});
    assert.deepStrictEqual(r, { target: 'gsd-core', unresolved: null });
    assert.strictEqual(log.dirs, 0);
    assert.strictEqual(log.lookups.length, 0);
  });
}

test('push-target: upstream plus a redirect form still -> gsd-core (rule a only adds arming)', () => {
  const { r } = classify('GIT_TRACE=1 git push origin y', { lookup: () => [UPSTREAM] });
  assert.deepStrictEqual(r, { target: 'gsd-core', unresolved: null });
});

test('push-target: a remote name is passed to the lookup byte-for-byte (no case-folding)', () => {
  const { log } = classify('git push BackUp x', {});
  assert.deepStrictEqual(log.lookups, [['/r', 'BackUp']]);
});

// ─────────────────────────── rule b: every URL another repo ───────────────────────────

test('push-target: every URL a fork in two dirs -> other, both dirs looked up', () => {
  const { r, log } = classify('git push backup x', { dirs: ['/a', '/b'], lookup: () => [FORK, TOOLKIT] });
  assert.deepStrictEqual(r, { target: 'other', unresolved: null });
  assert.deepStrictEqual(log.lookups, [['/a', 'backup'], ['/b', 'backup']]);
});

for (const lit of ['~/repos/gsd-core', 'file:///tmp/x/gsd-core', FORK_SCP]) {
  test('push-target: literal `' + lit + '` -> other with no dir resolution and no lookup', () => {
    const { r, log } = classify('git push ' + lit + ' x', {});
    assert.deepStrictEqual(r, { target: 'other', unresolved: null });
    assert.strictEqual(log.dirs, 0);
    assert.strictEqual(log.lookups.length, 0);
  });
}

for (const cmd of [
  'git remote -v && git push backup y',
  'git remote get-url backup && git push backup y',
  'git config --get remote.backup.url && git push backup y',
  'git config --list && git push backup y',
]) {
  test('push-target: read-only twin `' + cmd + '` is not a redirect -> other', () => {
    const { r } = classify(cmd, {});
    assert.deepStrictEqual(r, { target: 'other', unresolved: null });
  });
}

// ─────────────────────────── PD-3 redirect channels never classify other ───────────────────────────

for (const cmd of [
  'GIT_CONFIG_PARAMETERS=x git push backup y',
  'env GIT_DIR=/x git push backup y',
  'export GIT_CONFIG_GLOBAL=/x && git push backup y',
  'declare GIT_SSH_COMMAND=x && git push backup y',
  'git remote set-url backup ' + UPSTREAM + ' && git push backup y',
  'git remote add up ' + UPSTREAM + ' && git push backup y',
  'git remote rename a backup && git push backup y',
  'git remote remove a && git push backup y',
  'git remote rm a && git push backup y',
  'git config remote.backup.pushurl ' + UPSTREAM + ' && git push backup y',
  'source ./env.sh && git push backup y',
  '. ./env.sh && git push backup y',
  'eval x && git push backup y',
  'git() { :; } && git push backup y',
  'function git { :; } && git push backup y',
  'cat .git/config && git push backup y',
  'cat ~/.gitconfig && git push backup y',
]) {
  test('push-target: redirect form `' + cmd + '` with a clean fork lookup -> rule c', () => {
    const { r } = classify(cmd, {});
    assertUnresolved(r, cmd);
  });
}

test('push-target: pushRedirectReason is null for a plain push and names the channel otherwise', () => {
  assert.strictEqual(pt.pushRedirectReason(parseCommandForGates('git status && git push backup x')), null);
  const why = pt.pushRedirectReason(parseCommandForGates('GIT_DIR=/x git push backup y'));
  assert.ok(typeof why === 'string' && why.length > 0);
});

test('push-target: the unresolved phrase is capped (300 chars) and the target token too (120)', () => {
  const long = 'r'.repeat(500);
  const { r } = classify('git push ' + long + ' x', { lookup: () => { throw new Error('e'.repeat(1000)); } });
  assertUnresolved(r, 'long');
  assert.ok(r.unresolved.length <= 300, 'phrase length ' + r.unresolved.length);
  assert.ok(!r.unresolved.includes('r'.repeat(121)), 'the target token is capped at 120');
});

test('push-target: classifyPushTarget never throws; an internal throw is rule c', () => {
  const r = pt.classifyPushTarget({ tokens: null }, { ok: true, segments: [] }, {});
  assertUnresolved(r, 'malformed seg');
});

// ─────────────────────────── hermetic real-git lookup ───────────────────────────

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
}

test('push-target: resolvePushUrlsLive against a hermetic real repo (pushurl, --all, pushInsteadOf)', () => {
  const KEYS = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_DIR', 'GIT_WORK_TREE', 'HOME'];
  const saved = {};
  for (const k of KEYS) saved[k] = Object.prototype.hasOwnProperty.call(process.env, k) ? process.env[k] : undefined;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'f9-push-target-'));
  try {
    process.env.GIT_CONFIG_GLOBAL = '/dev/null';
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    process.env.HOME = tmp;
    delete process.env.GIT_DIR;
    delete process.env.GIT_WORK_TREE;
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    git(repo, 'init', '-q');
    git(repo, 'remote', 'add', 'backup', FORK);
    git(repo, 'remote', 'add', 'split', UPSTREAM);
    git(repo, 'config', 'remote.split.pushurl', FORK);
    git(repo, 'remote', 'add', 'multi', FORK);
    git(repo, 'config', 'remote.multi.pushurl', FORK);
    git(repo, 'config', '--add', 'remote.multi.pushurl', UPSTREAM);
    git(repo, 'config', 'url.https://github.com/open-gsd/.pushInsteadOf', 'https://example.invalid/og/');
    git(repo, 'remote', 'add', 'rewr', 'https://example.invalid/og/gsd-core.git');

    assert.deepStrictEqual(pt.resolvePushUrlsLive(repo, 'backup'), [FORK]);
    assert.deepStrictEqual(pt.resolvePushUrlsLive(repo, 'split'), [FORK]);
    assert.deepStrictEqual(pt.resolvePushUrlsLive(repo, 'multi'), [FORK, UPSTREAM]);
    assert.deepStrictEqual(pt.resolvePushUrlsLive(repo, 'rewr'), [UPSTREAM]);
    assert.throws(() => pt.resolvePushUrlsLive(repo, 'nosuch'));
    assert.throws(() => pt.resolvePushUrlsLive(path.join(tmp, 'does-not-exist'), 'backup'));

    const live = { segmentDirs: () => [repo], resolvePushUrls: pt.resolvePushUrlsLive };
    const want = { backup: 'other', split: 'other', multi: 'gsd-core', rewr: 'gsd-core' };
    for (const name of Object.keys(want)) {
      const { parsed, seg } = pushOf('git push ' + name + ' x');
      assert.deepStrictEqual(pt.classifyPushTarget(seg, parsed, live), { target: want[name], unresolved: null }, name);
    }
    const { parsed, seg } = pushOf('git push nosuch x');
    assertUnresolved(pt.classifyPushTarget(seg, parsed, live), 'nosuch');
  } finally {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
