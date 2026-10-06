'use strict';

/**
 * node:test for hooks/gsd-test-viability.cjs — the ENF-24 gsd-test viability gate.
 *
 * A gsd-test dispatch from a gsd-core checkout proceeds only when its config file exists
 * (GTEST-04), the named `--bench` is configured in it (GTEST-05) and the local Docker daemon
 * answers a bounded `docker info` probe (GTEST-06).
 *
 * Isolation (hard rules):
 *   • unit rows inject `readConfig`, `env`, `homedir`, `resolveTreeRoot` and `dockerProbe` with
 *     call counters — no row reads the real ~/.config/gsd-test, and the RES-01 short-circuit is
 *     asserted by COUNT, not timing;
 *   • no row ever reaches the real `docker` binary: the probe is injected, the spawn seam is a
 *     recording fake, and spawned e2e children get a PATH holding ONLY a temp dir. The whole file
 *     is run under a node-only PATH in the plan's verify step.
 */

// A stray override would flip a thrown-path deny to allow in the spawned rows.
delete process.env.GSD_CONTRIB_OVERRIDE;

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const viability = require('./gsd-test-viability.cjs');
const { runGsdTestViabilityGate, parseBenches } = viability;
const { FailClosed } = require('./lib/failclosed.cjs');

const ROOT = path.join(path.sep, 'w');
const HOME = path.join(path.sep, 'h');
const DEFAULT_CONFIG_PATH = path.join(HOME, '.config', 'gsd-test', 'config.toml');

const CONFIG_LOCAL = '[[benches]]\nname = "wsl-local"\nhost = "local"\n';

function input(command) {
  return JSON.stringify({ tool_name: 'Bash', tool_input: { command } });
}

/**
 * Injected deps + a counter on every impure seam. The DEFAULT world: every dir is inside the
 * gsd-core checkout ROOT, the config holds one bench `wsl-local` with host "local", and Docker
 * answers. Each row overrides only what it is about.
 */
function scenario(over = {}) {
  const calls = { resolveTreeRoot: 0, dirs: [], readConfig: 0, paths: [], dockerProbe: 0, writeReceipt: 0 };
  const config = Object.prototype.hasOwnProperty.call(over, 'config') ? over.config : CONFIG_LOCAL;
  const probe = over.probe || { state: 'ok', detail: '' };
  const override = over.override === true;
  const base = {
    cwd: ROOT,
    env: {},
    homedir: HOME,
    resolveTreeRoot: (dir) => {
      calls.resolveTreeRoot += 1;
      calls.dirs.push(dir);
      return ROOT;
    },
    readConfig: (p) => {
      calls.readConfig += 1;
      calls.paths.push(p);
      return config;
    },
    dockerProbe: () => {
      calls.dockerProbe += 1;
      return probe;
    },
    overrideImpl: {
      checkOverride: () => (override ? { override: true, reason: 'test override' } : { override: false }),
      writeReceipt: () => {
        calls.writeReceipt += 1;
      },
    },
  };
  const rest = Object.assign({}, over);
  delete rest.config;
  delete rest.probe;
  delete rest.override;
  return { deps: Object.assign(base, rest), calls };
}

function run(command, over) {
  const { deps, calls } = scenario(over);
  const d = runGsdTestViabilityGate(input(command), deps);
  return { d, calls, reason: d.permissionDecisionReason || '' };
}

// ───────────────────────── parseBenches (GTEST-05 reader) ─────────────────────────

test('ENF-24 GTEST-05: parseBenches reads two [[benches]] blocks (names and hosts)', () => {
  const b = parseBenches('[[benches]]\nname = "a"\nhost = "local"\n\n[[benches]]\nname = "b"\nhost = "ssh://x"\n');
  assert.deepStrictEqual(b, [{ name: 'a', host: 'local' }, { name: 'b', host: 'ssh://x' }]);
});

test('ENF-24 GTEST-05: parseBenches reads single-quoted values', () => {
  assert.deepStrictEqual(parseBenches("[[benches]]\nname = 'sq'\nhost = 'local'\n"), [{ name: 'sq', host: 'local' }]);
});

test('ENF-24 GTEST-05: parseBenches strips an inline # comment after a value, keeps # inside quotes', () => {
  const b = parseBenches('[[benches]] # first\nname = "a # b" # trailing\nhost = "local"   # x\n');
  assert.deepStrictEqual(b, [{ name: 'a # b', host: 'local' }]);
});

test('ENF-24 GTEST-05: parseBenches handles CRLF line endings', () => {
  assert.deepStrictEqual(parseBenches('[[benches]]\r\nname = "crlf"\r\nhost = "local"\r\n'), [{ name: 'crlf', host: 'local' }]);
});

test('ENF-24 GTEST-05: parseBenches strips a leading BOM', () => {
  assert.deepStrictEqual(parseBenches('﻿[[benches]]\nname = "bom"\n'), [{ name: 'bom', host: null }]);
});

test('ENF-24 GTEST-05: parseBenches ignores `name =` outside [[benches]] blocks (the [other] decoy)', () => {
  const b = parseBenches('name = "top"\n[[benches]]\nname = "real"\nhost = "local"\n[other]\nname = "decoy"\n');
  assert.deepStrictEqual(b, [{ name: 'real', host: 'local' }]);
});

test('ENF-24 GTEST-05: parseBenches drops a [[benches]] block with no name; skips blank and comment lines', () => {
  const b = parseBenches('# top comment\n\n[[benches]]\nhost = "local"\n\n[[benches]]\n  # indented comment\nname = "named"\n');
  assert.deepStrictEqual(b, [{ name: 'named', host: null }]);
});

test('ENF-24 GTEST-05: parseBenches reads backslash escapes inside double quotes', () => {
  assert.deepStrictEqual(parseBenches('[[benches]]\nname = "q\\"x"\n'), [{ name: 'q"x', host: null }]);
});

test('ENF-24 GTEST-05: parseBenches of empty text is []', () => {
  assert.deepStrictEqual(parseBenches(''), []);
});

// ───────────────────────── config path resolution (GTEST-04) ─────────────────────────

test('ENF-24 GTEST-04: no --config, env {} -> reads <homedir>/.config/gsd-test/config.toml', () => {
  const { d, calls } = run('gsd-test');
  assert.strictEqual(d.permissionDecision, 'allow');
  assert.deepStrictEqual(calls.paths, [DEFAULT_CONFIG_PATH]);
});

test('ENF-24 GTEST-04: XDG_CONFIG_HOME=/x (absolute) -> reads /x/gsd-test/config.toml', () => {
  const { calls } = run('gsd-test', { env: { XDG_CONFIG_HOME: '/x' } });
  assert.deepStrictEqual(calls.paths, [path.join('/x', 'gsd-test', 'config.toml')]);
});

test('ENF-24 GTEST-04: XDG_CONFIG_HOME=rel (not absolute) -> the homedir default', () => {
  const { calls } = run('gsd-test', { env: { XDG_CONFIG_HOME: 'rel' } });
  assert.deepStrictEqual(calls.paths, [DEFAULT_CONFIG_PATH]);
});

test('ENF-24 GTEST-04: `--config ~/c.toml` -> /h/c.toml', () => {
  const { calls } = run('gsd-test --config ~/c.toml');
  assert.deepStrictEqual(calls.paths, [path.join(HOME, 'c.toml')]);
});

test('ENF-24 GTEST-04: `-config=$HOME/c.toml` with env HOME=/e -> /e/c.toml', () => {
  const { calls } = run('gsd-test -config=$HOME/c.toml', { env: { HOME: '/e' } });
  assert.deepStrictEqual(calls.paths, [path.join('/e', 'c.toml')]);
});

test('ENF-24 GTEST-04: `cd /w/a && gsd-test --config ./c.toml` -> /w/a/c.toml (relative to the start dir)', () => {
  const { calls } = run('cd /w/a && gsd-test --config ./c.toml');
  assert.deepStrictEqual(calls.paths, [path.join('/w', 'a', 'c.toml')]);
});

test('ENF-24 GTEST-04: `gsd-test --head $(git rev-parse HEAD) --config ~/c.toml` -> /h/c.toml (checker item 2)', () => {
  const { calls } = run('gsd-test --head $(git rev-parse HEAD) --config ~/c.toml');
  assert.deepStrictEqual(calls.paths, [path.join(HOME, 'c.toml')]);
});

test('ENF-24 GTEST-04: an empty `--config=` is the default path (Go reads an empty value; gsd-test falls back)', () => {
  const { calls } = run('gsd-test --config=');
  assert.deepStrictEqual(calls.paths, [DEFAULT_CONFIG_PATH]);
});

test('ENF-24 GTEST-04 handoff: `cd "$HOME/w/a" && gsd-test --config ./c.toml` with HOME=/e -> /e/w/a/c.toml', () => {
  const { calls } = run('cd "$HOME/w/a" && gsd-test --config ./c.toml', { env: { HOME: '/e' } });
  assert.deepStrictEqual(calls.paths, [path.join('/e', 'w', 'a', 'c.toml')]);
});

test('ENF-24 GTEST-04 handoff: `cd "$X" && gsd-test` DENIES (unresolvable start dir, thrown) with ZERO resolve/read/probe calls', () => {
  const { d, calls, reason } = run('cd "$X" && gsd-test');
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(reason, /ENF-24/);
  assert.strictEqual(calls.resolveTreeRoot, 0);
  assert.strictEqual(calls.readConfig, 0);
  assert.strictEqual(calls.dockerProbe, 0);
});

// ───────────────────────── GTEST-04: config missing ─────────────────────────

test('ENF-24 GTEST-04: config missing (readConfig null) DENIES naming the checked path and the restore fix; zero probes', () => {
  const { d, calls, reason } = run('gsd-test -bench wsl-local', { config: null });
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(reason, /ENF-24/);
  assert.ok(reason.includes(DEFAULT_CONFIG_PATH), 'the reason names the checked path');
  assert.match(reason, /restore/i);
  assert.match(reason, /--config/);
  assert.doesNotMatch(reason, /\btouch\b|create an? (empty|new) config/i, 'never tells the user to hand-invent a config');
  assert.strictEqual(calls.dockerProbe, 0);
});

test('ENF-24 GTEST-04: readConfig throwing FailClosed DENIES (thrown); zero probes', () => {
  const { d, calls, reason } = run('gsd-test', {
    readConfig: () => {
      throw new FailClosed('ENF-24 config unreadable');
    },
  });
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(reason, /config unreadable/);
  assert.strictEqual(calls.dockerProbe, 0);
});

test('ENF-24 GTEST-04: the missing-config POLICY deny is NOT override-escapable (Addendum 4)', () => {
  const { d, calls } = run('gsd-test', { config: null, override: true });
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.strictEqual(calls.writeReceipt, 0);
});

test('ENF-24 GTEST-04: the THROWN readConfig deny IS override-escapable (allow + one receipt)', () => {
  const { d, calls } = run('gsd-test', {
    override: true,
    readConfig: () => {
      throw new FailClosed('ENF-24 config unreadable');
    },
  });
  assert.strictEqual(d.permissionDecision, 'allow');
  assert.strictEqual(calls.writeReceipt, 1);
});

/** Default readConfig against a temp home (never the real ~/.config). */
function withTempHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gtest-via-home-'));
  try {
    fs.mkdirSync(path.join(home, '.config', 'gsd-test'), { recursive: true });
    return fn(home, path.join(home, '.config', 'gsd-test', 'config.toml'));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function runDefaultReader(home) {
  const { deps, calls } = scenario({ homedir: home, env: {} });
  delete deps.readConfig;
  const d = runGsdTestViabilityGate(input('gsd-test'), deps);
  return { d, calls, reason: d.permissionDecisionReason || '' };
}

test('ENF-24 GTEST-04 edge: default reader, config path is a DIRECTORY -> DENY (thrown FailClosed)', () => {
  withTempHome((home, cfg) => {
    fs.mkdirSync(cfg);
    const { d, calls, reason } = runDefaultReader(home);
    assert.strictEqual(d.permissionDecision, 'deny');
    assert.match(reason, /ENF-24/);
    assert.match(reason, /regular file/);
    assert.strictEqual(calls.dockerProbe, 0);
  });
});

test('ENF-24 GTEST-04 edge: default reader, config larger than 1 MiB -> DENY (thrown FailClosed)', () => {
  withTempHome((home, cfg) => {
    fs.writeFileSync(cfg, Buffer.alloc(1024 * 1024 + 1, 0x20));
    const { d, reason } = runDefaultReader(home);
    assert.strictEqual(d.permissionDecision, 'deny');
    assert.match(reason, /1 MiB/);
  });
});

test('ENF-24 GTEST-04 edge: default reader, config absent (ENOENT) -> the missing-config POLICY deny', () => {
  withTempHome((home, cfg) => {
    const { d, reason } = runDefaultReader(home);
    assert.strictEqual(d.permissionDecision, 'deny');
    assert.ok(reason.includes(cfg), 'names the checked path');
    assert.match(reason, /restore/i);
  });
});

test('ENF-24 GTEST-04 edge: default reader, a real config file with the bench is read and ALLOWS', () => {
  withTempHome((home, cfg) => {
    fs.writeFileSync(cfg, CONFIG_LOCAL);
    const { deps } = scenario({ homedir: home, env: {} });
    delete deps.readConfig;
    const d = runGsdTestViabilityGate(input('gsd-test -bench wsl-local'), deps);
    assert.strictEqual(d.permissionDecision, 'allow');
  });
});

// ───────────────────────── GTEST-05: bench present ─────────────────────────

test('ENF-24 GTEST-05: `-bench nope` with [wsl-local] DENIES listing wsl-local; zero probes', () => {
  const { d, calls, reason } = run('gsd-test -bench nope');
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(reason, /ENF-24/);
  assert.match(reason, /nope/);
  assert.match(reason, /wsl-local/);
  assert.ok(reason.includes(DEFAULT_CONFIG_PATH), 'names the config path');
  assert.strictEqual(calls.dockerProbe, 0);
});

test('ENF-24 GTEST-05: `--bench=wsl-local` passes the bench check', () => {
  const { d } = run('gsd-test --bench=wsl-local');
  assert.strictEqual(d.permissionDecision, 'allow');
});

test('ENF-24 GTEST-05: `gsd-test --base next --head $(git rev-parse HEAD) --bench nope` DENIES (checker item 2)', () => {
  const { d, calls, reason } = run('gsd-test --base next --head $(git rev-parse HEAD) --bench nope');
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(reason, /wsl-local/);
  assert.strictEqual(calls.dockerProbe, 0);
});

test('ENF-24 GTEST-05: no benches configured + `-bench x` DENIES listing <none>', () => {
  const { d, calls, reason } = run('gsd-test -bench x', { config: '# empty config\n' });
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(reason, /<none>/);
  assert.strictEqual(calls.dockerProbe, 0);
});

test('ENF-24 GTEST-05: 25 configured names -> at most 20 listed', () => {
  let cfg = '';
  for (let i = 1; i <= 25; i += 1) cfg += `[[benches]]\nname = "bench-${String(i).padStart(2, '0')}"\nhost = "local"\n`;
  const { d, calls, reason } = run('gsd-test -bench nope', { config: cfg });
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(reason, /bench-20/);
  assert.doesNotMatch(reason, /bench-21/);
  assert.match(reason, /5 more/);
  assert.strictEqual(calls.dockerProbe, 0);
});

test('ENF-24 GTEST-05: a 100-char configured name is truncated to 64 chars in the reason', () => {
  const long = 'q'.repeat(100);
  const { d, reason } = run('gsd-test -bench nope', { config: `[[benches]]\nname = "${long}"\n` });
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.ok(reason.includes('q'.repeat(64)), 'the first 64 chars are listed');
  assert.ok(!reason.includes('q'.repeat(65)), 'never more than 64');
});

test('ENF-24 GTEST-05 privacy: the bench deny echoes bench NAMES only, never hosts/users/other values', () => {
  const cfg =
    'token = "tok-SECRET-123"\n[[benches]]\nname = "remote1"\nhost = "ssh://secret-user@bench1.example"\n' +
    'user = "secret-user"\n[auth]\npassword = "hunter2"\n';
  const { d, reason } = run('gsd-test -bench nope', { config: cfg });
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(reason, /remote1/);
  assert.doesNotMatch(reason, /secret-user|bench1\.example|tok-SECRET|hunter2|ssh:/);
});

test('ENF-24 GTEST-05: an empty `--bench=` names no bench (the bench check is skipped)', () => {
  const { d } = run('gsd-test --bench=', { config: '' });
  assert.strictEqual(d.permissionDecision, 'allow');
});

// ───────────────────────── uncertain / ask ─────────────────────────

test('ENF-24 GTEST-04 ask: `--config $CFG` (unresolvable) ASKS with the honesty note and ZERO reads', () => {
  const { d, calls, reason } = run('gsd-test --config $CFG');
  assert.strictEqual(d.permissionDecision, 'ask');
  assert.match(reason, /ENF-24/);
  assert.match(reason, /dangerously-skip-permissions/);
  assert.strictEqual(calls.readConfig, 0);
  assert.strictEqual(calls.dockerProbe, 0);
});

test('ENF-24 GTEST-05 ask: `-bench "$B"` (unresolvable) ASKS with the honesty note', () => {
  const { d, reason } = run('gsd-test -bench "$B"');
  assert.strictEqual(d.permissionDecision, 'ask');
  assert.match(reason, /ENF-24/);
  assert.match(reason, /dangerously-skip-permissions/);
});

test('ENF-24 GTEST-05: `gsd-test --head $(cd x; git rev-parse HEAD) --bench wsl-local` DENIES (detector uncertain) with ZERO resolves', () => {
  const { d, calls, reason } = run('gsd-test --head $(cd x; git rev-parse HEAD) --bench wsl-local');
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(reason, /ENF-24/);
  assert.strictEqual(calls.resolveTreeRoot, 0);
  assert.strictEqual(calls.readConfig, 0);
});

test('ENF-24 GTEST-05: detector uncertain (`gsd-test --bench "x`) DENIES with ZERO resolves', () => {
  const { d, calls } = run('gsd-test --bench "x');
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.strictEqual(calls.resolveTreeRoot, 0);
});

test('ENF-24 GTEST-05: `gsd-test $EXTRA` (expansion in flag position) DENIES with ZERO resolves', () => {
  const { d, calls } = run('gsd-test $EXTRA');
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.strictEqual(calls.resolveTreeRoot, 0);
});

test('ENF-24 GTEST-04: an unresolvable `-source $S` DENIES (thrown) with ZERO resolves', () => {
  const { d, calls } = run('gsd-test -source $S');
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.strictEqual(calls.resolveTreeRoot, 0);
});

// ───────────────────────── arming / cost (RES-01) ─────────────────────────

for (const cmd of ['git status', 'gsd-test --version', 'gsd-test -probe-benches']) {
  test(`ENF-24 GTEST-04: \`${cmd}\` ALLOWS with ZERO resolve/read/probe calls (RES-01)`, () => {
    const { d, calls } = run(cmd);
    assert.strictEqual(d.permissionDecision, 'allow');
    assert.strictEqual(calls.resolveTreeRoot, 0);
    assert.strictEqual(calls.readConfig, 0);
    assert.strictEqual(calls.dockerProbe, 0);
  });
}

test('ENF-24 GTEST-04: an out-of-tree dispatch (resolveTreeRoot null) ALLOWS with ZERO reads and probes', () => {
  const { d, calls } = run('gsd-test -bench nope', { resolveTreeRoot: () => null, config: null });
  assert.strictEqual(d.permissionDecision, 'allow');
  assert.strictEqual(calls.readConfig, 0);
  assert.strictEqual(calls.dockerProbe, 0);
});
