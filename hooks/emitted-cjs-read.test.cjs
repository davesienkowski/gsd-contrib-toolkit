'use strict';

/**
 * hooks/emitted-cjs-read.test.cjs - node:test for the emitted-cjs READ guard (ENF-26, quick 261119-szk).
 *
 * The guard denies a Read of a gsd-core `gsd-core/bin/lib/**\/*.cjs` only when BOTH signals hold: the
 * `src/**\/*.cts` twin is a regular file AND git reports the file ignored. Every other path is a SILENT
 * pass: runReadGuard returns null, and the spawned hook exits 0 with EMPTY stdout (an explicit
 * `permissionDecision: "allow"` would skip Claude Code's permission prompt; R1 B-01).
 *
 * Fixtures are real temp git repos shaped like gsd-core (the sentinel: scripts/ + gsd-core/bin/lib/ + one
 * identity script). Fixture git and the in-process probe run with the host's global and system git config
 * shut out (35-REVIEW MN-02). The verdict log is redirected (isolateToolLog) and, for spawned hooks,
 * switched off (GSD_CONTRIB_NO_VERDICT_LOG).
 */

require('./lib/test-isolate.cjs').isolateToolLog(); // never the real ~/.gsd-contrib tool log
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { runReadGuard } = require('./emitted-cjs-read.cjs');

const HOOK = path.join(__dirname, 'emitted-cjs-read.cjs');
const ISOLATED_GIT_CONFIG = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const REDIRECT_KEYS = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_GLOB_PATHSPECS',
  'GIT_NOGLOB_PATHSPECS', 'GIT_ICASE_PATHSPECS', 'GIT_LITERAL_PATHSPECS', 'GIT_CEILING_DIRECTORIES',
];
const FIXTURE_GIT_ENV = (() => {
  const env = Object.assign({}, process.env, ISOLATED_GIT_CONFIG);
  for (const k of REDIRECT_KEYS) delete env[k];
  return env;
})();

/** Run fn with the host git config shut out of process.env (the in-process probe reads process.env). */
function withIsolatedGitConfig(fn) {
  const saved = {};
  for (const k of Object.keys(ISOLATED_GIT_CONFIG)) {
    saved[k] = Object.prototype.hasOwnProperty.call(process.env, k) ? process.env[k] : undefined;
    process.env[k] = ISOLATED_GIT_CONFIG[k];
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

function fixtureGit(cwd, argv) {
  const r = spawnSync('git', argv, { cwd, env: FIXTURE_GIT_ENV, encoding: 'utf8' });
  if (r.error || r.status !== 0) {
    throw new Error('fixture git ' + argv.join(' ') + ' failed: ' + ((r.error && r.error.message) || r.stderr));
  }
}

function write(root, rel, body = '// fixture\n') {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  return p;
}

const EMITTED = [
  'gsd-core/bin/lib/foo.cjs',
  'gsd-core/bin/lib/observability/x.cjs',
  'gsd-core/bin/lib/dir.cjs',
  'gsd-core/bin/lib/..x.cjs',
  'gsd-core/bin/lib/nottwin.cjs',
];

/**
 * A gsd-core-shaped checkout. Ignored (emitted): foo, observability/x, dir, ..x, nottwin. Tracked
 * (hand-written): hand.cjs (WITH a src twin, the migration case) and vendor/js-yaml.cjs (only a .d.cts
 * sibling). src/dir.cts is a DIRECTORY. nottwin.cjs has no twin. node_modules/pkg/bin/lib/foo.cjs sits
 * outside the checkout's own gsd-core/bin/lib. alias.cjs is a symlink inside the checkout naming foo.cjs.
 */
function makeCheckout(base) {
  const root = path.join(base, 'checkout');
  fs.mkdirSync(root, { recursive: true });
  fixtureGit(root, ['init', '-q']);
  write(root, 'scripts/issue-dedupe.cjs');
  for (const rel of EMITTED) write(root, rel);
  write(root, 'gsd-core/bin/lib/hand.cjs');
  write(root, 'gsd-core/bin/lib/vendor/js-yaml.cjs');
  write(root, 'gsd-core/bin/lib/README.md');
  write(root, 'src/foo.cts');
  write(root, 'src/hand.cts');
  write(root, 'src/observability/x.cts');
  write(root, 'src/vendor/js-yaml.d.cts');
  write(root, 'src/..x.cts');
  fs.mkdirSync(path.join(root, 'src', 'dir.cts'), { recursive: true });
  write(root, 'node_modules/pkg/bin/lib/foo.cjs');
  write(root, '.gitignore', EMITTED.map((r) => '/' + r).join('\n') + '\n/node_modules/\n');
  fixtureGit(root, ['add', '--', '.gitignore', 'gsd-core/bin/lib/hand.cjs', 'gsd-core/bin/lib/vendor/js-yaml.cjs']);
  fs.symlinkSync(path.join(root, 'gsd-core', 'bin', 'lib', 'foo.cjs'), path.join(root, 'alias.cjs'));
  return root;
}

/** A bin/lib + src twin tree with NO gsd-core sentinel (no scripts/ identity script). */
function makeNoSentinel(base) {
  const root = path.join(base, 'nosentinel');
  fs.mkdirSync(root, { recursive: true });
  fixtureGit(root, ['init', '-q']);
  write(root, 'gsd-core/bin/lib/foo.cjs');
  write(root, 'src/foo.cts');
  write(root, '.gitignore', '/gsd-core/bin/lib/foo.cjs\n');
  return root;
}

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'emitted-cjs-read-'));
const ROOT = makeCheckout(BASE);
const NOSENTINEL = makeNoSentinel(BASE);
const OUTSIDE = path.join(BASE, 'outside');
fs.mkdirSync(OUTSIDE);
fs.symlinkSync(path.join(ROOT, 'gsd-core', 'bin', 'lib', 'foo.cjs'), path.join(OUTSIDE, 'out.cjs'));
test.after(() => fs.rmSync(BASE, { recursive: true, force: true }));

const lib = (rel) => path.join(ROOT, 'gsd-core', 'bin', 'lib', rel);

function payload(filePath, toolName = 'Read', cwd) {
  const tool_input = filePath === undefined ? {} : { file_path: filePath };
  const p = { tool_name: toolName, tool_input };
  if (cwd !== undefined) p.cwd = cwd;
  return JSON.stringify(p);
}

function guard(stdin, deps) {
  return withIsolatedGitConfig(() => runReadGuard(stdin, deps));
}

function assertDeny(result, ...needles) {
  assert.ok(result && typeof result === 'object', 'expected a deny object, got ' + JSON.stringify(result));
  assert.strictEqual(result.permissionDecision, 'deny');
  for (const n of needles) {
    assert.ok(result.permissionDecisionReason.includes(n), 'reason should include ' + JSON.stringify(n) + ': ' + result.permissionDecisionReason);
  }
}

function assertSilent(result) {
  assert.strictEqual(result, null, 'expected a silent pass (null), got ' + JSON.stringify(result));
}

// ---------------------------------------------------------------- deny: both signals hold

test('deny: a top-level emitted file with a src twin, reason names the absolute twin and the Bash route', () => {
  assertDeny(guard(payload(lib('foo.cjs'))), path.join(ROOT, 'src', 'foo.cts'), 'Bash');
});

test('deny: an emitted file in a subdirectory (35-REVIEW MJ-02 class)', () => {
  assertDeny(guard(payload(lib('observability/x.cjs'))), path.join(ROOT, 'src', 'observability', 'x.cts'));
});

test('deny: a relative file_path resolves against the payload cwd and the reason names the relative twin', () => {
  const r = guard(payload('gsd-core/bin/lib/foo.cjs', 'Read', ROOT));
  assertDeny(r, 'src/foo.cts');
  assert.ok(!r.permissionDecisionReason.includes(path.join(ROOT, 'src', 'foo.cts')), r.permissionDecisionReason);
});

test('deny: a dot-segment path that normalizes into bin/lib', () => {
  assertDeny(guard(payload(path.join(ROOT, 'gsd-core', 'bin', 'lib') + '/../lib/foo.cjs')), 'src/foo.cts');
});

test('deny: a leaf named ..x.cjs with a twin (a ".." prefix test would have let it through; R1 N-01)', () => {
  assertDeny(guard(payload(lib('..x.cjs'))), path.join('src', '..x.cts'));
});

test('deny: a symlink inside the checkout but outside bin/lib that names an emitted file', () => {
  assertDeny(guard(payload(path.join(ROOT, 'alias.cjs'))), 'src/foo.cts');
});

test('deny: a symlink OUTSIDE any checkout that names an emitted file (35-REVIEW NT-02 example)', () => {
  assertDeny(guard(payload(path.join(OUTSIDE, 'out.cjs'))), 'src/foo.cts');
});

// ---------------------------------------------------------------- silent pass: a signal is missing

test('silent: a TRACKED hand-written file with a src twin (migration in progress; git exits 1)', () => {
  assertSilent(guard(payload(lib('hand.cjs'))));
});

test('silent: a tracked vendor file whose only src sibling is a .d.cts', () => {
  assertSilent(guard(payload(lib('vendor/js-yaml.cjs'))));
});

test('silent: an ignored file with NO twin', () => {
  assertSilent(guard(payload(lib('nottwin.cjs'))));
});

test('silent: the twin path is a directory, not a regular file', () => {
  assertSilent(guard(payload(lib('dir.cjs'))));
});

test('silent: a bin/lib tree elsewhere in the checkout (node_modules)', () => {
  assertSilent(guard(payload(path.join(ROOT, 'node_modules', 'pkg', 'bin', 'lib', 'foo.cjs'))));
});

test('silent: a bin/lib + src twin in a directory with no gsd-core sentinel', () => {
  assertSilent(guard(payload(path.join(NOSENTINEL, 'gsd-core', 'bin', 'lib', 'foo.cjs'))));
});

test('silent: non-candidates (the .cts source itself, a non-.cjs leaf in bin/lib)', () => {
  assertSilent(guard(payload(path.join(ROOT, 'src', 'foo.cts'))));
  assertSilent(guard(payload(lib('README.md'))));
});

test('mixed-case alias: deny where this filesystem folds case, silent where it does not', () => {
  const alias = path.join(ROOT, 'GSD-CORE', 'BIN', 'LIB', 'foo.cjs');
  const r = guard(payload(alias));
  if (fs.existsSync(alias)) assertDeny(r, 'foo.cts');
  else assertSilent(r);
});

test('silent: every tool other than Read, even naming an emitted file (catch-all install, 260630-v1h)', () => {
  for (const tool of ['Write', 'Edit', 'Bash', 'Grep', 'NotebookEdit']) {
    assertSilent(guard(payload(lib('foo.cjs'), tool)));
  }
});

// ---------------------------------------------------------------- fail open: undecidable or error

test('fail open: git answers other than "ignored" pass silently (not-ignored, unknown, a throw)', () => {
  for (const checkIgnore of [() => 'not-ignored', () => 'unknown', () => { throw new Error('boom'); }]) {
    assertSilent(guard(payload(lib('foo.cjs')), { checkIgnore }));
  }
});

test('fail open: a resolver that throws passes silently', () => {
  assertSilent(guard(payload(lib('foo.cjs')), { resolveRoot: () => { throw new Error('no root'); } }));
});

test('fail open: malformed payloads pass silently', () => {
  for (const stdin of ['', 'null', '[]', '{', 'not json', '42', JSON.stringify({ tool_name: 'Read' })]) {
    assertSilent(guard(stdin));
  }
  for (const fp of ['', null, 7, {}, []]) {
    assertSilent(guard(JSON.stringify({ tool_name: 'Read', tool_input: { file_path: fp } })));
  }
});

test('only an object whose permissionDecision is exactly "deny" denies (R1 W-08)', () => {
  for (const result of [undefined, null, {}, 'deny', { permissionDecision: 'ALLOW' }, { permissionDecision: 'allow' }, { permissionDecision: 'ask', permissionDecisionReason: 'x' }]) {
    assertSilent(guard(payload(lib('foo.cjs')), { gateImpl: () => result }));
  }
  assertDeny(guard(payload(lib('foo.cjs')), { gateImpl: () => ({ permissionDecision: 'deny', permissionDecisionReason: 'r' }) }), 'r');
});

// ---------------------------------------------------------------- the real entrypoint

function spawnHook(stdin) {
  const env = Object.assign({}, process.env, ISOLATED_GIT_CONFIG, { GSD_CONTRIB_NO_VERDICT_LOG: '1' });
  return spawnSync(process.execPath, [HOOK], { input: stdin, env, encoding: 'utf8', timeout: 15000 });
}

test('entrypoint: a deny is one PreToolUse deny envelope on stdout, exit 0', () => {
  const r = spawnHook(payload(lib('foo.cjs')));
  assert.strictEqual(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.strictEqual(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.strictEqual(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.ok(out.hookSpecificOutput.permissionDecisionReason.includes('src/foo.cts'));
});

test('entrypoint: a silent pass writes NOTHING to stdout, exit 0 (never an explicit allow; R1 B-01)', () => {
  for (const stdin of [payload(lib('hand.cjs')), payload(lib('foo.cjs'), 'Write'), '\u0000ÿ garbage {', '']) {
    const r = spawnHook(stdin);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.stdout, '', 'stdout must be empty for a silent pass: ' + JSON.stringify(r.stdout));
  }
});

// ---------------------------------------------------------------- live gsd-core (read-only)

test('live: ~/repos/gsd-core emitted state.cjs denies, hand-written capability-validator.cjs passes', (t) => {
  const live = path.join(os.homedir(), 'repos', 'gsd-core');
  const premise = (() => {
    try {
      if (!fs.statSync(path.join(live, 'src', 'state.cts')).isFile()) return 'src/state.cts is not a file';
      const ig = spawnSync('git', ['check-ignore', '-q', '--', 'gsd-core/bin/lib/state.cjs'], { cwd: live, env: FIXTURE_GIT_ENV });
      if (ig.status !== 0) return 'gsd-core/bin/lib/state.cjs is not reported ignored';
      if (!fs.existsSync(path.join(live, 'gsd-core', 'bin', 'lib', 'capability-validator.cjs'))) return 'capability-validator.cjs absent';
      if (fs.existsSync(path.join(live, 'src', 'capability-validator.cts'))) return 'capability-validator.cjs now has a twin';
      return null;
    } catch (err) {
      return 'no readable gsd-core clone: ' + err.code;
    }
  })();
  if (premise) {
    t.skip('live premise failed: ' + premise);
    return;
  }
  assertDeny(guard(payload(path.join(live, 'gsd-core', 'bin', 'lib', 'state.cjs'))), path.join(live, 'src', 'state.cts'));
  assertSilent(guard(payload(path.join(live, 'gsd-core', 'bin', 'lib', 'capability-validator.cjs'))));
});

// ---------------------------------------------------------------- probe env hardening (fix round 2)

test('probeEnvChanges: injects core.fsmonitor=false and safe.bareRepository=explicit after inherited entries', () => {
  const { probeEnvChanges } = require('./emitted-cjs-read.cjs');
  const fresh = probeEnvChanges({ PATH: '/usr/bin' });
  assert.deepStrictEqual(
    [fresh.GIT_CONFIG_COUNT, fresh.GIT_CONFIG_KEY_0, fresh.GIT_CONFIG_VALUE_0, fresh.GIT_CONFIG_KEY_1, fresh.GIT_CONFIG_VALUE_1],
    ['2', 'core.fsmonitor', 'false', 'safe.bareRepository', 'explicit']
  );
  const inherited = probeEnvChanges({ PATH: '/usr/bin', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'x' });
  assert.strictEqual(inherited.GIT_CONFIG_COUNT, '3');
  assert.strictEqual(inherited.GIT_CONFIG_KEY_1, 'core.fsmonitor');
  assert.strictEqual(inherited.GIT_CONFIG_KEY_2, 'safe.bareRepository');
  assert.ok(!('GIT_CONFIG_KEY_0' in inherited), 'an inherited entry is kept, not overwritten');
  const bogus = probeEnvChanges({ PATH: '/usr/bin', GIT_CONFIG_COUNT: '-1x' });
  assert.strictEqual(bogus.GIT_CONFIG_COUNT, '2');
  assert.strictEqual(bogus.GIT_CONFIG_KEY_0, 'core.fsmonitor');
});

test('probeEnvChanges: PATH keeps only absolute entries (no empty, no relative)', () => {
  const { probeEnvChanges } = require('./emitted-cjs-read.cjs');
  assert.strictEqual(probeEnvChanges({ PATH: ':/usr/bin:.:bin:/bin:' }).PATH, '/usr/bin:/bin');
  assert.strictEqual(probeEnvChanges({}).PATH, '');
});

test('a guarded Read leaves process.env exactly as it found it', () => {
  const before = JSON.stringify(Object.entries(process.env).sort());
  assertDeny(guard(payload(lib('foo.cjs'))), 'src/foo.cts');
  assertSilent(guard(payload(lib('hand.cjs'))));
  assert.strictEqual(JSON.stringify(Object.entries(process.env).sort()), before);
});

// ---------------------------------------------------------------- the real git probe (fix round 2)
// SECURITY-REVIEW HIGH-01 / LOW-01 and REVIEW WR-01 / WR-02: these rows run the DEFAULT probe (no injected
// checkIgnore), so the probe's own error handling, env scrub and repository pinning are under test.

/** Spawn the real hook with extra env (the host git config shut out, the verdict log off). */
function spawnHookEnv(stdin, extra) {
  const env = Object.assign({}, process.env, ISOLATED_GIT_CONFIG, { GSD_CONTRIB_NO_VERDICT_LOG: '1' }, extra || {});
  return spawnSync(process.execPath, [HOOK], { input: stdin, env, encoding: 'utf8', timeout: 15000 });
}

/** A gsd-core-shaped tree (sentinel + bin/lib/foo.cjs + src/foo.cts) with or without `git init`. */
function plainTree(name, { init = true } = {}) {
  const root = path.join(BASE, name);
  fs.mkdirSync(root, { recursive: true });
  if (init) fixtureGit(root, ['init', '-q']);
  write(root, 'scripts/issue-dedupe.cjs');
  write(root, 'gsd-core/bin/lib/foo.cjs');
  write(root, 'src/foo.cts');
  write(root, '.gitignore', '/gsd-core/bin/lib/foo.cjs\n');
  return root;
}

test('real probe: a tree that is not a git work tree passes silently (git exits 128)', () => {
  const root = plainTree('nogit', { init: false });
  assertSilent(guard(payload(path.join(root, 'gsd-core', 'bin', 'lib', 'foo.cjs'))));
});

test('real probe: git absent from PATH passes silently, exit 0, empty stdout', () => {
  const r = spawnHookEnv(payload(lib('foo.cjs')), { PATH: path.join(BASE, 'no-such-bin') });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout, '');
});

test('real probe: an inherited GIT_DIR naming another repository is scrubbed and the emitted file still denies', () => {
  const other = plainTree('other-repo');
  const r = spawnHookEnv(payload(lib('foo.cjs')), { GIT_DIR: path.join(other, '.git') });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny');
});

test('real probe: a nested repository in bin/lib that ignores a TRACKED hand-written file does not deny it (REVIEW WR-02)', () => {
  const root = plainTree('nested');
  write(root, 'gsd-core/bin/lib/hand.cjs');
  write(root, 'src/hand.cts');
  fixtureGit(root, ['add', '--', '.gitignore', 'gsd-core/bin/lib/hand.cjs']);
  const nested = path.join(root, 'gsd-core', 'bin', 'lib');
  fixtureGit(nested, ['init', '-q']);
  write(root, 'gsd-core/bin/lib/.gitignore', 'hand.cjs\n');
  assertSilent(guard(payload(path.join(nested, 'hand.cjs'))));
});

test('real probe: a COMMITTED bare-shaped dir with core.fsmonitor never runs its command on a Read (SECURITY-REVIEW HIGH-01)', () => {
  const up = plainTree('bare-up');
  const sub = path.join(up, 'gsd-core', 'bin', 'lib', 'sub');
  write(up, 'gsd-core/bin/lib/sub/objects/keep', '');
  write(up, 'gsd-core/bin/lib/sub/refs/keep', '');
  write(up, 'gsd-core/bin/lib/sub/HEAD', 'ref: refs/heads/main\n');
  write(up, 'gsd-core/bin/lib/sub/config',
    '[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tworktree = .\n' +
    '\tfsmonitor = "sh -c \\"echo ran >> $EMITTED_READ_MARK\\" #"\n');
  write(up, 'src/sub/a.cts');
  const idx = spawnSync('git', ['--git-dir', sub, '--work-tree', sub, 'update-index', '--add', '--cacheinfo',
    '100644,e69de29bb2d1d6434b8b29ae775a8c2e48c5391d,x'], { env: FIXTURE_GIT_ENV, encoding: 'utf8' });
  assert.strictEqual(idx.status, 0, 'fixture index: ' + idx.stderr);
  write(up, '.gitignore', '');
  fixtureGit(up, ['add', '-A']);
  fixtureGit(up, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'fixture']);
  const clone = path.join(BASE, 'bare-clone');
  fixtureGit(BASE, ['clone', '-q', up, clone]);
  const mark = path.join(BASE, 'bare-mark');
  const r = spawnHookEnv(payload(path.join(clone, 'gsd-core', 'bin', 'lib', 'sub', 'a.cjs')), { EMITTED_READ_MARK: mark });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout, '', 'a pinned probe answers unknown here: a silent pass');
  assert.ok(!fs.existsSync(mark), 'the planted core.fsmonitor command must not run: ' + (fs.existsSync(mark) && fs.readFileSync(mark, 'utf8')));
});

test('real probe: a core.fsmonitor command in the checkout\'s own .git/config, or inherited through the -c env, never runs (PLAN-REVIEW-R2 W-01, W-02)', () => {
  const root = plainTree('own-fsmonitor');
  const mark = path.join(BASE, 'own-fsmonitor-mark');
  fixtureGit(root, ['config', 'core.fsmonitor', 'sh -c "echo own >> $EMITTED_READ_MARK" #']);
  fixtureGit(root, ['add', '--', '.gitignore', 'src/foo.cts']);
  const target = payload(path.join(root, 'gsd-core', 'bin', 'lib', 'foo.cjs'));
  const r = spawnHookEnv(target, { EMITTED_READ_MARK: mark });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny', 'a pinned real repo still answers');
  assert.ok(!fs.existsSync(mark), 'the repository-configured fsmonitor command must not run');
  fixtureGit(root, ['config', '--unset', 'core.fsmonitor']);
  const r2 = spawnHookEnv(target, {
    EMITTED_READ_MARK: mark,
    GIT_CONFIG_PARAMETERS: "'core.fsmonitor=sh -c \"echo env >> $EMITTED_READ_MARK\" #'",
  });
  assert.strictEqual(r2.status, 0, r2.stderr);
  assert.ok(!fs.existsSync(mark), 'an inherited -c fsmonitor command must not run: ' + (fs.existsSync(mark) && fs.readFileSync(mark, 'utf8')));
});

test('probeEnvChanges: the injected pairs are appended to an inherited GIT_CONFIG_PARAMETERS', () => {
  const { probeEnvChanges } = require('./emitted-cjs-read.cjs');
  assert.strictEqual(probeEnvChanges({}).GIT_CONFIG_PARAMETERS, "'core.fsmonitor=false' 'safe.bareRepository=explicit'");
  assert.strictEqual(
    probeEnvChanges({ GIT_CONFIG_PARAMETERS: "'core.fsmonitor=evil'" }).GIT_CONFIG_PARAMETERS,
    "'core.fsmonitor=evil' 'core.fsmonitor=false' 'safe.bareRepository=explicit'"
  );
});

test('real probe: an empty PATH entry cannot run a committed executable named git beside the target (SECURITY-REVIEW LOW-01)', () => {
  const root = plainTree('planted-git');
  const mark = path.join(BASE, 'planted-git-mark');
  write(root, 'gsd-core/bin/lib/git', '#!/bin/sh\necho planted >> "$EMITTED_READ_MARK"\nexit 0\n');
  fs.chmodSync(path.join(root, 'gsd-core', 'bin', 'lib', 'git'), 0o755);
  const r = spawnHookEnv(payload(path.join(root, 'gsd-core', 'bin', 'lib', 'foo.cjs')),
    { PATH: ':' + process.env.PATH, EMITTED_READ_MARK: mark });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(mark), 'the planted git must not run');
  assert.strictEqual(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny', 'the real git still answers');
});
