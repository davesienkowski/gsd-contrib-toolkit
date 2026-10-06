'use strict';

/**
 * node:test for W5 (quick 261006-jts): a FIFO, a symlink to a FIFO, a symlink to /dev/zero or a
 * directory planted on a gate's hot path must not hang the PreToolUse hook past its harness
 * timeout (the harness treats a timed-out hook as ALLOW, gap backlog #2a). Every case SPAWNS the
 * real hook entrypoint with a wall-clock bound:
 *
 *   - the child is SIGKILLed at KILL_MS, so a hang is a failure, never a pass;
 *   - a green run must exit 0 with res.signal null, the expected permissionDecision, and (where the
 *     path decides at once) an elapsed time under GREEN_MS.
 *
 * Paths: P1 runtime-stamp.json read, P2 upstream-tip-cache.json read, P3 the same cache write
 * (all ENF-21, hooks/runtime-drift.cjs), P4 the override receipt append (hooks/containment.cjs,
 * both the origin override and the runGate thrown-path override), P5 the ENF-19 artifact read
 * (hooks/protocol-artifact.cjs).
 *
 * Isolation (D-06): every child gets an env built FROM SCRATCH (never a spread of process.env)
 * with a temp HOME, a temp GSD_CONTRIB_STATE_DIR, a temp GSD_CONTRIB_LOG_DIR and a neutral git
 * config, so no run reads or writes the user's real ~/.gsd-contrib, its tool log, or
 * ~/.claude/gsd-core. Every fixture lives under os.tmpdir() and is removed after its test.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

// The test process itself never writes the real tool log either.
process.env.GSD_CONTRIB_LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'w5-self-log-'));
process.on('exit', () => fs.rmSync(process.env.GSD_CONTRIB_LOG_DIR, { recursive: true, force: true }));

// -------------------------------------------------------------------- shared helpers

/** A hung hook is SIGKILLed here. */
const KILL_MS = 3000;
/** A path that decides at once must decide within this. */
const GREEN_MS = 2000;

/** True when this platform has named pipes and `mkfifo`. */
function hasMkfifo() {
  if (process.platform === 'win32') return false;
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'w5-fifo-probe-'));
  try {
    execFileSync('mkfifo', [path.join(d, 'p')], { stdio: 'ignore' });
    return true;
  } catch (_) {
    return false;
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
}

const NO_FIFO = !hasMkfifo() && 'no mkfifo on this platform';
const NO_DEVZERO = (process.platform === 'win32' || !fs.existsSync('/dev/zero')) && 'no /dev/zero on this platform';

/** A fresh temp dir, removed after test `t`. */
function tmp(t, prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'w5-' + prefix + '-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

/** The four plantings, with a label and a platform skip each. */
const PLANTINGS = [
  { kind: 'fifo', label: 'a FIFO', skip: NO_FIFO },
  { kind: 'fifo-link', label: 'a symlink to a FIFO', skip: NO_FIFO },
  { kind: 'devzero-link', label: 'a symlink to /dev/zero', skip: NO_DEVZERO },
  { kind: 'dir', label: 'a directory', skip: false },
];
const planting = (kind) => PLANTINGS.find((p) => p.kind === kind);

/**
 * Replace `file` with a planting of `kind`. Returns the symlink target for the link kinds (so
 * assertPlanted can re-check it), else null.
 */
function plant(t, kind, file) {
  fs.rmSync(file, { recursive: true, force: true });
  if (kind === 'fifo') {
    execFileSync('mkfifo', [file]);
    return null;
  }
  if (kind === 'fifo-link') {
    const target = path.join(tmp(t, 'fifo-target'), 'p');
    execFileSync('mkfifo', [target]);
    fs.symlinkSync(target, file);
    return target;
  }
  if (kind === 'devzero-link') {
    fs.symlinkSync('/dev/zero', file);
    return '/dev/zero';
  }
  if (kind === 'dir') {
    fs.mkdirSync(file);
    return null;
  }
  throw new Error('unknown planting ' + kind);
}

/** The planting is still exactly what was planted after the hook ran. */
function assertPlanted(kind, file, target) {
  const st = fs.lstatSync(file);
  if (kind === 'fifo') {
    assert.ok(st.isFIFO(), file + ' is no longer a FIFO');
  } else if (kind === 'fifo-link' || kind === 'devzero-link') {
    assert.ok(st.isSymbolicLink(), file + ' is no longer a symlink');
    assert.strictEqual(fs.readlinkSync(file), target);
    if (kind === 'fifo-link') assert.ok(fs.lstatSync(target).isFIFO(), target + ' is no longer a FIFO');
  } else if (kind === 'dir') {
    assert.ok(st.isDirectory(), file + ' is no longer a directory');
  }
}

/** Spawn a real hook entrypoint on one Bash command, SIGKILLed at KILL_MS, timed. */
function spawnBounded(hookFile, { cwd, env, command }) {
  const t0 = Date.now();
  const res = spawnSync(process.execPath, [path.join(__dirname, hookFile)], {
    input: JSON.stringify({
      hook_event_name: 'PreToolUse',
      session_id: 'w5-test',
      tool_name: 'Bash',
      tool_input: { command },
    }),
    encoding: 'utf8',
    cwd,
    env,
    timeout: KILL_MS,
    killSignal: 'SIGKILL',
  });
  const elapsed = Date.now() - t0;
  let hso = null;
  if (res.status === 0 && res.signal === null) {
    const lines = String(res.stdout || '').trim().split('\n');
    hso = JSON.parse(lines[lines.length - 1]).hookSpecificOutput;
  }
  return { res, elapsed, hso };
}

/**
 * The hook decided `decision` (reason matching `re` when given), was never killed, and, unless
 * `bounded` is false, decided under GREEN_MS. Emits the timing as a TAP diagnostic.
 */
function assertDecided(t, out, decision, re, { bounded = true } = {}) {
  assert.strictEqual(
    out.res.signal,
    null,
    'killed by ' + out.res.signal + ' after ' + out.elapsed + ' ms (bound ' + KILL_MS + ' ms)'
  );
  assert.strictEqual(out.res.status, 0, 'exit ' + out.res.status + ': ' + out.res.stderr);
  if (bounded) assert.ok(out.elapsed < GREEN_MS, 'decided in ' + out.elapsed + ' ms (green bound ' + GREEN_MS + ' ms)');
  assert.ok(out.hso, 'no hookSpecificOutput on stdout: ' + out.res.stdout);
  assert.strictEqual(out.hso.permissionDecision, decision, out.hso.permissionDecisionReason);
  if (re) assert.match(out.hso.permissionDecisionReason, re);
  t.diagnostic('decided ' + decision + ' in ' + out.elapsed + ' ms');
}

/** A child env built from scratch: nothing (GSD_CONTRIB_OVERRIDE, XDG_STATE_HOME ...) leaks in. */
function baseEnv({ home, state, log, pathPrefix, extra }) {
  const env = {
    PATH: pathPrefix ? pathPrefix + path.delimiter + (process.env.PATH || '') : process.env.PATH || '',
    HOME: home,
    GSD_CONTRIB_STATE_DIR: state,
    GSD_CONTRIB_LOG_DIR: log,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
  };
  return Object.assign(env, extra || {});
}

/** A fresh temp HOME, state dir and log dir for one test. */
function freshDirs(t) {
  return { home: tmp(t, 'home'), state: tmp(t, 'state'), log: tmp(t, 'log') };
}

/** The gsd-core sentinel layout resolve.cjs hasSentinel looks for. */
function sentinelRoot(dir) {
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'scripts', 'issue-dedupe.cjs'), '');
  fs.mkdirSync(path.join(dir, 'gsd-core', 'bin', 'lib'), { recursive: true });
  return dir;
}

/** A git repo on `branch` with one empty commit (an unborn HEAD fails rev-parse), and an origin. */
function gitRepo(root, branch, origin, home) {
  const env = { PATH: process.env.PATH || '', HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  const git = (args) => execFileSync('git', args, { cwd: root, env, stdio: 'ignore' });
  git(['init', '-q', '-b', branch]);
  git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init']);
  if (origin) git(['remote', 'add', 'origin', origin]);
}

// -------------------------------------------------------------------- P5: ENF-19 artifact read

const P5_BRANCH = 'fix/1234-slug';
const P5_REL = '.gsd/contrib/fix-1234-slug/P1-repro.json';
const P5_CMD = 'gh issue create --title t --body b';
const P5_COULD_NOT_READ = /could not read `\.gsd\/contrib\/fix-1234-slug\/P1-repro\.json`/;
const P5_NOT_REGULAR = /could not read `\.gsd\/contrib\/fix-1234-slug\/P1-repro\.json`: not a regular file/;
const P5_OVER_CAP = /could not read `\.gsd\/contrib\/fix-1234-slug\/P1-repro\.json`: larger than the 1048576-byte read cap/;

/** A P1 artifact that passes the P1 gate (ASCII-only, modeled on P1_OK in protocol-artifact.test.cjs). */
const P1_VALID = {
  schema: 1,
  mechanism: 'resolveModelInternal falls through to the budget tier when the catalog key is absent',
  reproduced: true,
  source_files: ['src/core.cts:412'],
  evidence: [{ command: 'node -e "..."', observed: 'budget\n' }],
};

/** A sentinel git root on the contribution branch with the artifact dir created. */
function p5Fixture(t) {
  const dirs = freshDirs(t);
  const root = sentinelRoot(tmp(t, 'p5-root'));
  gitRepo(root, P5_BRANCH, null, dirs.home);
  fs.mkdirSync(path.dirname(path.join(root, P5_REL)), { recursive: true });
  return { root, file: path.join(root, P5_REL), env: baseEnv(dirs) };
}

const runP5 = (fx) => spawnBounded('protocol-artifact.cjs', { cwd: fx.root, env: fx.env, command: P5_CMD });

for (const kind of ['fifo', 'fifo-link', 'devzero-link']) {
  const p = planting(kind);
  test('W5 P5: ' + p.label + ' at P1-repro.json -> ENF-19 denies (not a regular file) within the bound, no hang', { skip: p.skip }, (t) => {
    const fx = p5Fixture(t);
    const target = plant(t, kind, fx.file);
    assertDecided(t, runP5(fx), 'deny', P5_NOT_REGULAR);
    assertPlanted(kind, fx.file, target);
  });
}

test('W5 P5: a valid-JSON P1 artifact over the 1 MiB read cap -> ENF-19 denies naming the read cap', (t) => {
  const fx = p5Fixture(t);
  const base = JSON.stringify(P1_VALID).length;
  const want = 1024 * 1024 + 1024;
  const big = Object.assign({}, P1_VALID, { mechanism: P1_VALID.mechanism + ' ' + 'x'.repeat(want - base - 1) });
  const text = JSON.stringify(big);
  assert.strictEqual(text.length, want);
  fs.writeFileSync(fx.file, text);
  assertDecided(t, runP5(fx), 'deny', P5_OVER_CAP);
});

test('W5 P5 guard: a directory at P1-repro.json -> ENF-19 denies (could not read) within the bound', (t) => {
  const fx = p5Fixture(t);
  plant(t, 'dir', fx.file);
  assertDecided(t, runP5(fx), 'deny', P5_COULD_NOT_READ);
  assertPlanted('dir', fx.file, null);
});

test('W5 P5 guard: a valid regular P1 artifact is still read (it passes P1 and stops at a later gate)', (t) => {
  const fx = p5Fixture(t);
  fs.writeFileSync(fx.file, JSON.stringify(P1_VALID, null, 2) + '\n');
  const out = runP5(fx);
  // It reaches later gates (STEP-ZERO writes a scaffold), so no GREEN_MS bound here.
  assertDecided(t, out, 'deny', null, { bounded: false });
  assert.ok(!/could not read/.test(out.hso.permissionDecisionReason), out.hso.permissionDecisionReason);
  assert.ok(!/not a regular file/.test(out.hso.permissionDecisionReason), out.hso.permissionDecisionReason);
});

// -------------------------------------------------------------------- ENF-21 fixtures (P1-P3)

const rs = require('./lib/runtime-stamp.cjs');

/** The tip the `tip` git stub reports. */
const TIP = 'a'.repeat(40);
/** ENF-21 arms on a pure-argv upstream target from a cwd with no gsd-core sentinel. */
const ENF21_CMD = 'gh pr create --repo open-gsd/gsd-core --title t --body b';

/**
 * A tiny fake installed runtime under `<home>/.claude/gsd-core` (the hook computes RUNTIME_ROOT
 * from its own HOME at module load; runtimeDigest fails closed on a missing root).
 */
function fakeRuntime(home) {
  const root = path.join(home, '.claude', 'gsd-core');
  fs.mkdirSync(path.join(root, 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(root, 'workflows', 'a.md'), 'w5 fake runtime\n');
  return root;
}

/**
 * A stub `git` first on PATH so `ls-remote` never reaches the network. `offline`: every call
 * fails (the tip is unobtainable, so the gate asks). `tip`: `ls-remote` prints TIP for next.
 */
function stubGit(binDir, mode) {
  const body =
    mode === 'tip'
      ? '#!/bin/sh\nif [ "$1" = "ls-remote" ]; then printf \'%s\\trefs/heads/next\\n\' ' + TIP + '; exit 0; fi\n' +
        'echo "stub git: unexpected $*" >&2\nexit 97\n'
      : '#!/bin/sh\necho "stub git: offline ($*)" >&2\nexit 128\n';
  fs.writeFileSync(path.join(binDir, 'git'), body, { mode: 0o755 });
  return binDir;
}

/** A valid stamp at TIP whose digest matches the fake runtime, written in the TEST process. */
function freshStamp(home, state) {
  const digest = rs.runtimeDigest(path.join(home, '.claude', 'gsd-core'));
  rs.writeStamp(rs.buildStamp({ sha: TIP, runtimeDigest: digest, mode: 'payload-verified', engineVerified: false }), {
    stampPath: path.join(state, rs.STAMP_FILENAME),
  });
}

/** Temp HOME with a fake runtime, temp state/log, a git stub of `mode`, and a sentinel-free cwd. */
function enf21Fixture(t, mode) {
  const dirs = freshDirs(t);
  fakeRuntime(dirs.home);
  const bin = stubGit(tmp(t, 'bin'), mode);
  return {
    home: dirs.home,
    state: dirs.state,
    cwd: tmp(t, 'cwd'),
    stamp: path.join(dirs.state, rs.STAMP_FILENAME),
    cache: path.join(dirs.state, rs.CACHE_FILENAME),
    env: baseEnv(Object.assign({ pathPrefix: bin }, dirs)),
  };
}

const runEnf21 = (fx) => spawnBounded('runtime-drift.cjs', { cwd: fx.cwd, env: fx.env, command: ENF21_CMD });

const ENF21_ASK = /ENF-21 could not verify/;

// -------------------------------------------------------------------- P1: runtime-stamp.json read

const P1_UNREADABLE = /runtime stamp at .*runtime-stamp\.json exists but could not be read/;
const P1_NOT_REGULAR = /runtime stamp at .*runtime-stamp\.json exists but could not be read \(not a regular file/;

test('W5 P1 guard: offline, no stamp, no cache -> ENF-21 arms and asks (the spawned gate is live)', (t) => {
  const fx = enf21Fixture(t, 'offline');
  assertDecided(t, runEnf21(fx), 'ask', ENF21_ASK);
});

for (const kind of ['fifo', 'fifo-link', 'devzero-link']) {
  const p = planting(kind);
  test('W5 P1: ' + p.label + ' at runtime-stamp.json -> ENF-21 denies (not a regular file) within the bound, no hang', { skip: p.skip }, (t) => {
    const fx = enf21Fixture(t, 'offline');
    const target = plant(t, kind, fx.stamp);
    assertDecided(t, runEnf21(fx), 'deny', P1_NOT_REGULAR);
    assertPlanted(kind, fx.stamp, target);
  });
}

test('W5 P1 guard: a directory at runtime-stamp.json -> ENF-21 denies (could not be read) within the bound', (t) => {
  const fx = enf21Fixture(t, 'offline');
  plant(t, 'dir', fx.stamp);
  assertDecided(t, runEnf21(fx), 'deny', P1_UNREADABLE);
  assertPlanted('dir', fx.stamp, null);
});

// -------------------------------------------------------------------- P2: upstream-tip-cache.json read

const P2_MISS = /no cached tip is available/;

// The OFFLINE stub, so the cache write never runs: a hang here is the READ (research pitfall 3).
for (const p of PLANTINGS) {
  const guard = p.kind === 'dir';
  test('W5 P2' + (guard ? ' guard' : '') + ': ' + p.label + ' at upstream-tip-cache.json (offline) -> a cache miss, ENF-21 asks within the bound', { skip: p.skip }, (t) => {
    const fx = enf21Fixture(t, 'offline');
    const target = plant(t, p.kind, fx.cache);
    const out = runEnf21(fx);
    assertDecided(t, out, 'ask', ENF21_ASK);
    assert.match(out.hso.permissionDecisionReason, P2_MISS);
    assertPlanted(p.kind, fx.cache, target);
  });
}
