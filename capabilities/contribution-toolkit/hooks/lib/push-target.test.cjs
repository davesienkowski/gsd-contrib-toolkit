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
function makeIo({ dirs = ['/r'], lookup = () => [FORK], rewrites = () => [], command, budget } = {}) {
  const log = { dirs: 0, lookups: [], rewrites: [] };
  const io = {
    // F9 R2 (item 1): the raw command text the allowlist reads.
    command,
    segmentDirs: () => {
      log.dirs += 1;
      return typeof dirs === 'function' ? dirs() : dirs;
    },
    resolvePushUrls: (dir, name, ms) => {
      log.lookups.push([dir, name]);
      return lookup(dir, name, ms);
    },
    // F9 R2 (item 5): url.<base>.insteadOf / pushInsteadOf lines in the push dir.
    urlRewrites: (dir, ms) => {
      log.rewrites.push(dir);
      return rewrites(dir, ms);
    },
  };
  if (budget) io.budget = budget;
  return { io, log };
}

function classify(cmd, ioOpts) {
  const { parsed, seg } = pushOf(cmd);
  const { io, log } = makeIo(Object.assign({ command: cmd }, ioOpts));
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
  // F9 R2 (item 5): a literal target now resolves its dir once, for the url rewrite check.
  test('F9 R2: literal `' + lit + '` -> other with no remote lookup and one rewrite check in its dir', () => {
    const { r, log } = classify('git push ' + lit + ' x', {});
    assert.deepStrictEqual(r, { target: 'other', unresolved: null });
    assert.strictEqual(log.dirs, 1);
    assert.deepStrictEqual(log.rewrites, ['/r']);
    assert.strictEqual(log.lookups.length, 0);
  });
}

for (const cmd of [
  'git remote -v && git push backup y',
  'git remote get-url backup && git push backup y',
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

    // F9 R2 (item 1): the io carries the raw command the allowlist reads.
    const live = (command) => ({ command, segmentDirs: () => [repo], resolvePushUrls: pt.resolvePushUrlsLive });
    const want = { backup: 'other', split: 'other', multi: 'gsd-core', rewr: 'gsd-core' };
    for (const name of Object.keys(want)) {
      const cmd = 'git push ' + name + ' x';
      const { parsed, seg } = pushOf(cmd);
      assert.deepStrictEqual(pt.classifyPushTarget(seg, parsed, live(cmd)), { target: want[name], unresolved: null }, name);
    }
    const { parsed, seg } = pushOf('git push nosuch x');
    assertUnresolved(pt.classifyPushTarget(seg, parsed, live('git push nosuch x')), 'nosuch');
  } finally {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ───────────── quick-261007-rni F9 R2: rule (b) is an allowlist; bounded lookups (CONTEXT Revision 2) ─────────────
//
// `F9 R2: ` fails before the R2 fix and passes after; `F9 R2 guard: ` passes both.

test('F9 R2: LOOKUP_BUDGET_MS is 5000 and MAX_PUSH_DIRS is 3 (item 6)', () => {
  assert.strictEqual(pt.LOOKUP_BUDGET_MS, 5000);
  assert.strictEqual(pt.MAX_PUSH_DIRS, 3);
});

for (const cmd of [
  'git config --get remote.backup.url && git push backup y',
  'git config --list && git push backup y',
]) {
  test('F9 R2: `' + cmd + '` -> rule c (item 3: git config is not an allowlisted subcommand)', () => {
    assertUnresolved(classify(cmd, {}).r, cmd);
  });
}

// item 1-3: the allowlist itself.
for (const cmd of [
  'git push backup fix/x',
  'git push backup fix/x 2>&1 | tail -5',
  'cd ~/repos/gsd-core && git push backup x',
  'git -C ~/repos/gsd-core push backup x',
  'git status && git push backup x',
  'pwd && ls -la && echo hi && printf "%s" x && true && sleep 1 && git push backup x',
  'pushd /tmp && git push backup x && popd',
  'git log --oneline -3 && git diff --stat && git show HEAD && git rev-parse HEAD && git push backup x',
  'git branch -vv && git branch --show-current && git fetch backup && git ls-remote backup && git push backup x',
  'git remote && git remote -v && git remote get-url --push backup && git remote show backup && git push backup x',
  'git push backup x 2>&1 | grep -v hint | head -5 | wc -l',
  'git push backup x | cat',
]) {
  test('F9 R2: ruleBAllowlistReason accepts `' + cmd + '`', () => {
    assert.strictEqual(pt.ruleBAllowlistReason(cmd, parseCommandForGates(cmd)), null);
  });
}

for (const cmd of [
  'git push backup x && (git push origin main)',
  'git push backup x && { git push origin main; }',
  'git push backup x && bash -c "git push origin main"',
  'git push backup x && xargs git push origin < /dev/null',
  'FOO=1 git push backup x',
  'env -i git push backup x',
  'sudo -u u git push backup x',
  'export HOME=/tmp/e && git push backup x',
  'printf -v GIT_DIR %s /x && git push backup x',
  'set -e && git push backup x',
  'read x && git push backup x',
  'git config remote.backup.pushurl x && git push backup x',
  'git remote set-url backup x && git push backup x',
  'git remote add up x && git push backup x',
  'node -e x && git push backup x',
  'eval x && git push backup x',
  'tail -5 && git push backup x',
  'cat .git/config && git push backup x',
  'git push backup x | tee out',
  'git push backup x | grep -f pat.txt',
  'git push backup x | wc -l file',
  'git status\ngit push backup x',
  'cd $HOME && git push backup x',
  'git push backup x > out',
  'git push backup x 2>&1>out',
  'git push backup x \\\n --force',
  'git stash && git push backup x',
  'git -c x=y status && git push backup x',
  'git --git-dir=/x status && git push backup x',
  'git fetch --upload-pack=x . && git push backup x',
  'git fetch --upload=x . && git push backup x',
  'git ls-remote -u x . && git push backup x',
  'git ls-remote --exec=x . && git push backup x',
  'git diff --output=x && git push backup x',
  'git log --outp=x && git push backup x',
  'git branch -D x && git push backup x',
  'git branch new && git push backup x',
  'git remote prune backup && git push backup x',
  '/usr/bin/git push backup x',
  'command git push backup x',
]) {
  test('F9 R2: ruleBAllowlistReason rejects `' + cmd.replace(/\n/g, '\\n') + '`', () => {
    const parsed = parseCommandForGates(cmd);
    const why = parsed.ok ? pt.ruleBAllowlistReason(cmd, parsed) : 'unparseable';
    assert.ok(typeof why === 'string' && why.length > 0, cmd + ' -> ' + JSON.stringify(why));
  });
}

test('F9 R2: ruleBAllowlistReason fails closed on a missing command text or a malformed parse', () => {
  assert.ok(typeof pt.ruleBAllowlistReason(undefined, parseCommandForGates('git push backup x')) === 'string');
  assert.ok(typeof pt.ruleBAllowlistReason('git push backup x', { ok: true, segments: null }) === 'string');
  assert.ok(typeof pt.ruleBAllowlistReason('git push backup x', { ok: true, segments: [{ tokens: [] }] }) === 'string');
});

test('F9 R2: classifyPushTarget with no io.command is rule c, never rule b (item 1 fails closed)', () => {
  const { parsed, seg } = pushOf('git push backup x');
  const { io } = makeIo({});
  assertUnresolved(pt.classifyPushTarget(seg, parsed, io), 'no command');
});

// item 4: --receive-pack / --exec anywhere, any abbreviation; post-positional dash tokens.
for (const cmd of [
  'git push backup x --receive-pack=foo',
  'git push backup x --exec=foo',
  'git push backup x --receive=foo',
  'git push backup x --rec=foo',
  'git push backup x --exe=foo',
  'git push backup x --e=foo',
  'git push backup x --frobnicate',
  'git push backup x -o ci.skip',
  'git push backup x --push-option=ci.skip',
  'git push backup x -z',
  'git push backup x --repo=other',
  'git push --porcelain backup x --receive-pack=y',
]) {
  test('F9 R2: `' + cmd + '` -> rule c (item 4)', () => {
    assertUnresolved(classify(cmd, {}).r, cmd);
  });
}

for (const cmd of [
  'git push backup x --force',
  'git push backup x -f',
  'git push backup x -fu',
  'git push backup x --force-with-lease',
  'git push backup x --force-with-lease=main:abc',
  'git push backup x --no-verify',
  'git push backup x y z',
  'git push backup -- x',
]) {
  test('F9 R2 guard: `' + cmd + '` -> other (known boolean or refspec after the positional)', () => {
    assert.deepStrictEqual(classify(cmd, {}).r, { target: 'other', unresolved: null });
  });
}

// item 5: literal URL targets need an empty url-rewrite list.
test('F9 R2: a literal fork URL with a url rewrite configured -> rule c, no remote lookup', () => {
  const { r, log } = classify('git push ' + FORK + ' x', { rewrites: () => ['url.' + UPSTREAM + '.pushinsteadof ' + FORK] });
  assertUnresolved(r, 'rewrite');
  assert.strictEqual(log.lookups.length, 0);
});

test('F9 R2: a literal fork URL whose rewrite check throws or returns a non-array -> rule c', () => {
  assertUnresolved(classify('git push ' + FORK + ' x', { rewrites: () => { throw new Error('fatal'); } }).r, 'throw');
  assertUnresolved(classify('git push ' + FORK + ' x', { rewrites: () => null }).r, 'null');
});

test('F9 R2: a literal fork URL whose dir list is empty -> rule c', () => {
  assertUnresolved(classify('git push ' + FORK + ' x', { dirs: [] }).r, 'no dir');
});

test('F9 R2 guard: a literal upstream URL arms (rule a) without a rewrite check', () => {
  const { r, log } = classify('git push ' + UPSTREAM + ' x', { rewrites: () => { throw new Error('must not run'); } });
  assert.deepStrictEqual(r, { target: 'gsd-core', unresolved: null });
  assert.strictEqual(log.rewrites.length, 0);
});

// item 7 through the literal path.
for (const lit of [
  'https://github.com/open-gsd/gsd-core.git/',
  'git@github.com:open-gsd/gsd-core.git/',
  'ssh://git@github.com/open-gsd/gsd-core.git/',
  'https://github.com/open-gsd/gsd-core.git//',
]) {
  test('F9 R2: literal `' + lit + '` -> gsd-core (trailing slashes normalize)', () => {
    assert.deepStrictEqual(classify('git push ' + lit + ' x', {}).r, { target: 'gsd-core', unresolved: null });
  });
}

for (const lit of [
  'https://github.com/open-gsd/gsd-core/../gsd-core',
  'https://github.com/open-gsd/gsd-core/./',
  'https://github.com/open-gsd/gsd-core/x/..',
  // F9 R3 (item 4, REVIEW-R2 CR-02) FLIPPED `https://github.com/open-gsd//gsd-core` out of this
  // list: `//` now collapses, so it is rule a (see the F9 R3 block).
]) {
  test('F9 R2: literal `' + lit + '` -> rule c (dot or encoded segment)', () => {
    assertUnresolved(classify('git push ' + lit + ' x', {}).r, lit);
  });
}

for (const u of [UPSTREAM + '/', 'git@github.com:open-gsd/gsd-core.git/', UPSTREAM + '//']) {
  test('F9 R2: a looked-up URL `' + u + '` -> gsd-core (rule a)', () => {
    assert.deepStrictEqual(classify('git push backup x', { lookup: () => [u] }).r, { target: 'gsd-core', unresolved: null });
  });
}

for (const u of ['https://github.com/open-gsd/gsd-core/x/..', 'https://github.com/open-gsd/gsd-core/.']) {
  test('F9 R2: a looked-up URL `' + u + '` -> rule c', () => {
    assertUnresolved(classify('git push backup x', { lookup: () => [u] }).r, u);
  });
}

test('F9 R2 guard: literal `https://github.com/open-gsd/gsd%2Dcore` -> rule c (encoded segment)', () => {
  assertUnresolved(classify('git push https://github.com/open-gsd/gsd%2Dcore x', {}).r, '%2D');
});

// item 6: the budget and the dir cap.
test('F9 R2: more than MAX_PUSH_DIRS candidate dirs -> rule c with no lookup', () => {
  const { r, log } = classify('git push backup x', { dirs: ['/a', '/b', '/c', '/d'] });
  assertUnresolved(r, '4 dirs');
  assert.strictEqual(log.lookups.length, 0);
});

test('F9 R2: one budget across lookups; each call gets min(3000, remaining); exhausted -> rule c', () => {
  let clock = 0;
  const budget = pt.createLookupBudget(() => clock);
  const seen = [];
  const lookup = (dir, name, ms) => { seen.push(ms); clock += 2000; return [FORK]; };
  const r1 = classify('git push backup x', { dirs: ['/a', '/b'], lookup, budget }).r;
  assert.deepStrictEqual(r1, { target: 'other', unresolved: null });
  const r2 = classify('git push backup y', { dirs: ['/a'], lookup, budget }).r;
  assertUnresolved(r2, 'third lookup over budget');
  assert.deepStrictEqual(seen, [3000, 3000, 1000]);
  const r3 = classify('git push backup z', { lookup, budget }).r;
  assertUnresolved(r3, 'no budget left');
  assert.deepStrictEqual(seen, [3000, 3000, 1000], 'no call once the budget is spent');
});

test('F9 R2: the rewrite check of a literal target draws on the same budget', () => {
  let clock = 0;
  const budget = pt.createLookupBudget(() => clock);
  const seen = [];
  const rewrites = (dir, ms) => { seen.push(ms); clock += 5000; return []; };
  assertUnresolved(classify('git push ' + FORK + ' x', { rewrites, budget }).r, 'rewrite over budget');
  assert.deepStrictEqual(seen, [3000]);
});

// item 8: backticks never reach the phrase raw.
test('F9 R2: a backtick in an echoed token or a lookup error is escaped in the phrase', () => {
  const r1 = classify('git push a`b`c y', {}).r;
  assertUnresolved(r1, 'token');
  assert.ok(r1.unresolved.includes("a'b'c") && !r1.unresolved.includes('a`b`c'), r1.unresolved);
  const r2 = classify('git push nosuch y', { lookup: () => { throw new Error('bad `thing` here'); } }).r;
  assertUnresolved(r2, 'stderr');
  assert.ok(r2.unresolved.includes("'thing'") && !r2.unresolved.includes('`thing`'), r2.unresolved);
});

// item 5: the live rewrite reader against a hermetic real repo.
test('F9 R2: urlRewritesLive: no rewrite -> [] (git exits 1), a pushInsteadOf -> its line, not a dir -> throws', () => {
  const KEYS = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_DIR', 'GIT_WORK_TREE', 'HOME'];
  const saved = {};
  for (const k of KEYS) saved[k] = Object.prototype.hasOwnProperty.call(process.env, k) ? process.env[k] : undefined;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'f9r2-rewrites-'));
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
    assert.deepStrictEqual(pt.urlRewritesLive(repo), []);
    assert.deepStrictEqual(pt.urlRewritesLive(repo, 1500), []);
    git(repo, 'config', 'url.' + UPSTREAM + '.pushInsteadOf', FORK);
    const lines = pt.urlRewritesLive(repo);
    assert.strictEqual(lines.length, 1);
    assert.match(lines[0], /^url\./);
    assert.throws(() => pt.urlRewritesLive(path.join(tmp, 'does-not-exist')));

    const cmd = 'git push ' + FORK + ' x';
    const { parsed, seg } = pushOf(cmd);
    const live = { command: cmd, segmentDirs: () => [repo], resolvePushUrls: pt.resolvePushUrlsLive, urlRewrites: pt.urlRewritesLive };
    assertUnresolved(pt.classifyPushTarget(seg, parsed, live), 'live rewrite');
  } finally {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ── quick-261007-tz0 F10: narrowToArmingPushes (lint-ci-marker and protocol-artifact consumers) ──
// `F10: ` cases fail before the helper exists and pass after. The real-classifier cases use only
// single-push commands plus the hidden-push pin; every other case injects io.classifyPushTarget so
// it asserts the helper's narrowing contract, not the hardened rule-(b) allowlist.

/** Counted lookup world: segmentDirs -> ['/tmp/wt']; resolvePushUrls -> map[name] or throws. */
function f10World(map = {}) {
  const calls = { dirs: 0, lookups: [], rewrites: 0 };
  return {
    calls,
    segmentDirs: () => {
      calls.dirs += 1;
      return ['/tmp/wt'];
    },
    resolvePushUrls: (dir, name) => {
      calls.lookups.push([dir, name]);
      if (Object.prototype.hasOwnProperty.call(map, name)) return map[name];
      throw new Error('No such remote ' + name);
    },
    urlRewrites: () => {
      calls.rewrites += 1;
      return [];
    },
  };
}

/** The repository token of a push segment (the token after `push`), for stub classifiers. */
function remoteOf(seg) {
  const t = seg.tokens.map(String);
  return t[t.indexOf('push') + 1];
}

/** A stub classifier keyed on the push's remote token; records every segment it sees. */
function stubClassifier(byRemote, seen = []) {
  return (seg) => {
    seen.push(seg);
    const target = Object.prototype.hasOwnProperty.call(byRemote, remoteOf(seg)) ? byRemote[remoteOf(seg)] : null;
    return { target, unresolved: null };
  };
}

function narrow(cmd, io) {
  const parsed = parseCommandForGates(cmd);
  assert.ok(parsed.ok, 'fixture must parse: ' + cmd);
  return { parsed, out: pt.narrowToArmingPushes(cmd, parsed, io) };
}

test('F10: real classifier, `git push origin x` with an upstream lookup -> the same object, empty false', () => {
  const w = f10World({ origin: [UPSTREAM] });
  const { parsed, out } = narrow('git push origin x', w);
  assert.strictEqual(out.parsed, parsed);
  assert.strictEqual(out.empty, false);
  assert.deepStrictEqual(w.calls.lookups, [['/tmp/wt', 'origin']]);
});

test('F10: real classifier, a throwing lookup (rule c) -> the same object, empty false', () => {
  const w = f10World({});
  const { parsed, out } = narrow('git push typo x', w);
  assert.strictEqual(out.parsed, parsed);
  assert.strictEqual(out.empty, false);
  assert.strictEqual(w.calls.lookups.length, 1);
});

test('F10: real classifier, a bare `git push` (rule d) -> the same object, zero segmentDirs and lookup calls', () => {
  const w = f10World({ origin: [FORK] });
  const { parsed, out } = narrow('git push', w);
  assert.strictEqual(out.parsed, parsed);
  assert.strictEqual(out.empty, false);
  assert.strictEqual(w.calls.dirs, 0);
  assert.strictEqual(w.calls.lookups.length, 0);
});

test('F10: real classifier, `git push backup fix/x` with a fork lookup -> empty true, exactly one lookup', () => {
  const w = f10World({ backup: [FORK] });
  const { out } = narrow('git push backup fix/x', w);
  assert.strictEqual(out.empty, true);
  assert.deepStrictEqual(w.calls.lookups, [['/tmp/wt', 'backup']]);
});

test('F10: real classifier, hidden-push pin `git push backup x && bash -c "git push origin main"` -> the same object', () => {
  const w = f10World({ backup: [FORK], origin: [FORK] });
  const { parsed, out } = narrow('git push backup x && bash -c "git push origin main"', w);
  assert.strictEqual(out.parsed, parsed);
  assert.strictEqual(out.empty, false);
});

test('F10: missing or partial io -> the same object, empty false, zero calls', () => {
  const w = f10World({ backup: [FORK] });
  const seen = [];
  const classifyPushTarget = stubClassifier({ backup: 'other' }, seen);
  for (const io of [
    undefined,
    {},
    { segmentDirs: w.segmentDirs, classifyPushTarget },
    { resolvePushUrls: w.resolvePushUrls, classifyPushTarget },
  ]) {
    const { parsed, out } = narrow('git push backup fix/x', io);
    assert.strictEqual(out.parsed, parsed);
    assert.strictEqual(out.empty, false);
  }
  assert.strictEqual(w.calls.dirs, 0);
  assert.strictEqual(w.calls.lookups.length, 0);
  assert.strictEqual(seen.length, 0);
});

test('F10: `git status && ls` (no push segment) -> the same object, zero calls even with a classifier saying other', () => {
  const w = f10World({ backup: [FORK] });
  const seen = [];
  const io = Object.assign({}, w, { classifyPushTarget: () => { seen.push(1); return { target: 'other', unresolved: null }; } });
  const { parsed, out } = narrow('git status && ls', io);
  assert.strictEqual(out.parsed, parsed);
  assert.strictEqual(out.empty, false);
  assert.strictEqual(seen.length, 0);
  assert.strictEqual(w.calls.dirs, 0);
  assert.strictEqual(w.calls.lookups.length, 0);
});

test('F10: dropping segment 0 of `git push backup x && gh pr create` rebuilds the top-level fields from the kept segment', () => {
  const w = f10World({});
  const io = Object.assign({}, w, { classifyPushTarget: stubClassifier({ backup: 'other' }) });
  const { parsed, out } = narrow('git push backup x && gh pr create --title t --body b', io);
  assert.strictEqual(out.empty, false);
  assert.notStrictEqual(out.parsed, parsed);
  const kept = parsed.segments[1];
  assert.strictEqual(out.parsed.segments.length, 1);
  assert.strictEqual(out.parsed.segments[0], kept);
  assert.strictEqual(out.parsed.program, 'gh');
  for (const k of ['program', 'subcommands', 'flags', 'shortFlags', 'positionals', 'tokens']) {
    assert.deepStrictEqual(out.parsed[k], kept[k], k);
  }
  assert.strictEqual(out.parsed.raw, parsed.raw);
  assert.strictEqual(classifyAction(out.parsed).action, 'pr-create');
});

test('F10: kept segments keep their order and nextOp; the first kept one supplies program', () => {
  const io = Object.assign({}, f10World({}), { classifyPushTarget: stubClassifier({ backup: 'other' }) });
  const { parsed, out } = narrow('git push backup x && git status && gh pr create --title t --body b', io);
  assert.strictEqual(out.empty, false);
  assert.strictEqual(out.parsed.segments.length, 2);
  assert.strictEqual(out.parsed.segments[0], parsed.segments[1]);
  assert.strictEqual(out.parsed.segments[1], parsed.segments[2]);
  assert.strictEqual(out.parsed.segments[0].nextOp, parsed.segments[1].nextOp);
  assert.strictEqual(out.parsed.program, 'git');
  assert.deepStrictEqual(out.parsed.tokens, parsed.segments[1].tokens);
});

test('F10: newline-split alt push segment is dropped by identity; the joined segment stays; altSegments recomputed', () => {
  const seen = [];
  const io = Object.assign({}, f10World({}), { classifyPushTarget: stubClassifier({ backup: 'other' }, seen) });
  const { parsed, out } = narrow('echo hi\ngit push backup x', io);
  assert.strictEqual(parsed.altSegments, 2, 'fixture shape: two appended alt segments');
  assert.strictEqual(parsed.segments.length, 3, 'fixture shape: joined + two alt segments');
  assert.strictEqual(out.empty, false);
  assert.strictEqual(out.parsed.segments.length, 2);
  assert.strictEqual(out.parsed.segments[0], parsed.segments[0]);
  assert.strictEqual(out.parsed.segments[1], parsed.segments[1]);
  assert.strictEqual(out.parsed.altSegments, 1);
  assert.strictEqual(seen.length, 1, 'only the alt push segment is a push candidate');
  assert.strictEqual(seen[0], parsed.segments[2], 'the segment reaches the classifier unchanged');
});

test('F10: two token-identical fork pushes are both dropped (identity, not re-serialised tokens)', () => {
  const seen = [];
  const io = Object.assign({}, f10World({}), { classifyPushTarget: stubClassifier({ backup: 'other' }, seen) });
  const { parsed, out } = narrow('git push backup x && git push backup x', io);
  assert.strictEqual(out.empty, true);
  assert.strictEqual(seen.length, 2);
  assert.strictEqual(seen[0], parsed.segments[0]);
  assert.strictEqual(seen[1], parsed.segments[1]);
});

test('F10: a classifier answering gsd-core or null keeps the push -> the same object', () => {
  for (const target of ['gsd-core', null]) {
    const io = Object.assign({}, f10World({}), { classifyPushTarget: stubClassifier({ backup: target }) });
    const { parsed, out } = narrow('git push backup x', io);
    assert.strictEqual(out.parsed, parsed, String(target));
    assert.strictEqual(out.empty, false, String(target));
  }
});

test('F10: twice on the same command and deps -> equal results, equal lookup counts, input not mutated', () => {
  const cmd = 'git push backup x && git status && git push origin y';
  const w = f10World({ backup: [FORK], origin: [UPSTREAM] });
  const parsed = parseCommandForGates(cmd);
  const snapshot = JSON.parse(JSON.stringify(parsed));
  const a = pt.narrowToArmingPushes(cmd, parsed, w);
  const n1 = w.calls.lookups.length;
  const b = pt.narrowToArmingPushes(cmd, parsed, w);
  const n2 = w.calls.lookups.length - n1;
  assert.deepStrictEqual(a, b);
  assert.strictEqual(n1, n2);
  assert.ok(n1 > 0);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(parsed)), snapshot);
  assert.strictEqual(a.empty, false);
  assert.strictEqual(a.parsed.segments.length, 2, 'the fork push is dropped; status and the upstream push are kept');
});

test('F10: a throwing classifier or a throwing segmentDirs -> the same object, empty false, no throw', () => {
  const thrower = Object.assign({}, f10World({}), {
    classifyPushTarget: () => { throw new Error('boom'); },
  });
  const r1 = narrow('git push backup x', thrower);
  assert.strictEqual(r1.out.parsed, r1.parsed);
  assert.strictEqual(r1.out.empty, false);
  const dirsThrow = {
    segmentDirs: () => { throw new Error('no dir'); },
    resolvePushUrls: () => [FORK],
    urlRewrites: () => [],
  };
  const r2 = narrow('git push backup x', dirsThrow);
  assert.strictEqual(r2.out.parsed, r2.parsed);
  assert.strictEqual(r2.out.empty, false);
});

// ───────────── quick-261007-rni F9 R3: hardening round 3 (REVIEW-R2, ADVERSARIAL-R2) ─────────────
//
// Naming: `F9 R3: ` fails before the R3 fix and passes after; `F9 R3 guard: ` passes both.

// ── item 1 (CR-01, ADVERSARIAL-R2 A): GitHub rename aliases of open-gsd/gsd-core are upstream ──
const ALIAS_OPEN = 'https://github.com/open-gsd/get-shit-done-redux';
const ALIAS_REDUX = 'https://github.com/GSD-redux/get-shit-done-redux.git';
for (const cmd of [
  'git push ' + ALIAS_OPEN + ' fix/x',
  'git push ' + ALIAS_OPEN + '.git next',
  'git push https://github.com/OPEN-GSD/GET-SHIT-DONE-REDUX next',
  'git push ' + ALIAS_REDUX + ' fix/x 2>&1 | tail -5',
  'git push git@github.com:open-gsd/get-shit-done-redux.git fix/x',
  'git push git@github.com:GSD-redux/get-shit-done-redux.git fix/x',
  'git push ssh://git@github.com/gsd-redux/get-shit-done-redux.git fix/x',
  'git -C /r push ' + ALIAS_OPEN + ' x',
]) {
  test('F9 R3: literal alias `' + cmd + '` -> gsd-core (rule a), no lookup', () => {
    const { r, log } = classify(cmd, { rewrites: () => { throw new Error('must not run'); } });
    assert.deepStrictEqual(r, { target: 'gsd-core', unresolved: null });
    assert.strictEqual(log.lookups.length, 0);
  });
}

for (const u of [ALIAS_REDUX, ALIAS_OPEN + '.git', 'git@github.com:open-gsd/get-shit-done-redux.git']) {
  test('F9 R3: named remote `legacy` resolving to the alias `' + u + '` -> gsd-core (rule a)', () => {
    const r = classify('git push legacy fix/x', { lookup: () => [u] }).r;
    assert.deepStrictEqual(r, { target: 'gsd-core', unresolved: null });
  });
}

test('F9 R3: an alias among several pushurls of one remote -> gsd-core', () => {
  assert.deepStrictEqual(classify('git push backup x', { lookup: () => [FORK, ALIAS_REDUX] }).r, { target: 'gsd-core', unresolved: null });
});

// ── item 1: any other repo under the open-gsd org can never earn rule b (an in-org rename) ──
for (const cmd of ['git push https://github.com/open-gsd/gsd-test-runner.git x', 'git push git@github.com:open-gsd/some-new-name.git x']) {
  test('F9 R3: literal open-gsd org URL `' + cmd + '` -> rule c (never other)', () => {
    const r = classify(cmd, {}).r;
    assertUnresolved(r, cmd);
    assert.match(r.unresolved, /open-gsd/);
  });
}

test('F9 R3: a named remote resolving into the open-gsd org -> rule c (never other)', () => {
  const r = classify('git push origin x', { lookup: () => ['https://github.com/open-gsd/gsd-test-runner.git'] }).r;
  assertUnresolved(r, 'org remote');
  assert.match(r.unresolved, /open-gsd/);
});

test('F9 R3 guard: a same-name repo under another owner (davesienkowski/gsd-core) is still other', () => {
  assert.deepStrictEqual(classify('git push fork x', { lookup: () => ['https://github.com/davesienkowski/gsd-core.git'] }).r, { target: 'other', unresolved: null });
});

// ── item 4 (CR-02): `//` and `%` userinfo reach upstream, so they are rule a ──
for (const lit of [
  'https://github.com/open-gsd//gsd-core',
  'https://github.com/open-gsd//gsd-core.git',
  'https://u%2Dx@github.com/open-gsd/gsd-core.git',
]) {
  test('F9 R3: literal `' + lit + '` -> gsd-core (rule a)', () => {
    assert.deepStrictEqual(classify('git push ' + lit + ' x', {}).r, { target: 'gsd-core', unresolved: null });
  });
}

test('F9 R3: a looked-up `//` upstream URL -> gsd-core (rule a)', () => {
  assert.deepStrictEqual(classify('git push backup x', { lookup: () => ['https://github.com/open-gsd//gsd-core.git'] }).r, { target: 'gsd-core', unresolved: null });
});

// ── item 5 (WR-02): a dir the hook cannot see (OLDPWD, the inherited dir stack) never earns rule b ──
for (const cmd of [
  'cd - && git push backup x',
  'cd -- - && git push backup x',
  'cd -P - && git push backup x',
  'popd && git push backup x',
  'popd +1 && git push backup x',
  'pushd && git push backup x',
  'pushd +1 && git push backup x',
  'pushd -1 && git push backup x',
  'pushd -n /tmp && git push backup x',
  'pushd - && git push backup x',
]) {
  test('F9 R3: ruleBAllowlistReason rejects `' + cmd + '` (a cd target outside the command text)', () => {
    const why = pt.ruleBAllowlistReason(cmd, parseCommandForGates(cmd));
    assert.ok(typeof why === 'string' && why.length > 0, cmd + ' -> ' + JSON.stringify(why));
    assertUnresolved(classify(cmd, {}).r, cmd);
  });
}

for (const cmd of ['cd /tmp && git push backup x', 'cd && git push backup x', 'pushd /tmp && git push backup x && popd', 'git push backup x && cd -']) {
  test('F9 R3 guard: ruleBAllowlistReason accepts `' + cmd + '` (every cd target before the push is visible)', () => {
    assert.strictEqual(pt.ruleBAllowlistReason(cmd, parseCommandForGates(cmd)), null);
  });
}

// ── item 2: a segmentDirs throw (pushSegmentDirs' physical check) is rule c with its phrase ──
test('F9 R3 guard: a segmentDirs throw naming a symlink divergence is rule c and carries the reason', () => {
  const r = classify('git -C lnk/.. push backup x', { dirs: () => { throw new Error('lnk/.. resolves through a symlink'); } }).r;
  assertUnresolved(r, 'symlink');
  assert.match(r.unresolved, /symlink/);
});

// ── IN-02: a monotonic default clock, and a SIGKILL on timeout ──
test('F9 R3: createLookupBudget() defaults to the monotonic performance.now clock', () => {
  const before = performance.now();
  const b = pt.createLookupBudget();
  const after = performance.now();
  assert.ok(b.deadline >= before + pt.LOOKUP_BUDGET_MS && b.deadline <= after + pt.LOOKUP_BUDGET_MS, String(b.deadline));
});

test('F9 R3: the live lookups kill a git that ignores SIGTERM at their timeout (SIGKILL)', () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'f9r3-sigterm-'));
  // A `git` that ignores SIGTERM and exits on its own after about 6 s (no runaway process).
  fs.writeFileSync(path.join(bin, 'git'), "#!/bin/sh\ntrap '' TERM\nn=0\nwhile [ $n -lt 60 ]; do sleep 0.1; n=$((n+1)); done\n", { mode: 0o755 });
  const savedPath = process.env.PATH;
  process.env.PATH = bin + path.delimiter + savedPath;
  try {
    for (const run of [() => pt.resolvePushUrlsLive(bin, 'backup', 300), () => pt.urlRewritesLive(bin, 300)]) {
      const t0 = Date.now();
      assert.throws(run);
      const spent = Date.now() - t0;
      assert.ok(spent < 2500, 'a 300 ms lookup must end near its timeout, took ' + spent + ' ms');
    }
  } finally {
    process.env.PATH = savedPath;
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

// ── positive pins (item 3): the plain forms still earn rule b ──
for (const cmd of ['git push backup fix/x', 'git push backup fix/x 2>&1 | tail -5', 'git -C /r push backup x']) {
  test('F9 R3 guard: pin `' + cmd + '` with a fork lookup -> other', () => {
    assert.deepStrictEqual(classify(cmd, {}).r, { target: 'other', unresolved: null });
  });
}
