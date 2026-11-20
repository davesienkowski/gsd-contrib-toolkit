'use strict';

/**
 * node:test for hooks/binlib-edit.cjs (ENF-03 generated-file Edit/Write gate, ADR-457).
 *
 * Driven via the injectable runBinlibGate(stdinString, deps) seam: the override impl is
 * injected so the unit suite is hermetic (no filesystem / no env reads).
 *
 * Coverage (plan <behavior>):
 *   - a `**\/bin/lib/**\/*.cjs` Edit/Write (top-level AND nested) → DENY, reason names src/*.cts + ADR-457
 *   - a `src/*.cts` source path → ALLOW (the correct file to edit)
 *   - a `bin/lib` SUBSTRING that is not a path SEGMENT (e.g. src/bin-lib-notes.md) → ALLOW
 *   - a doc/test/non-bin-lib file → ALLOW
 *   - a bin/lib path whose leaf is NOT .cjs (e.g. bin/lib/README.md) → ALLOW (segment+leaf accurate)
 *   - missing/absent file_path → fail-closed DENY (HARD-01)
 *
 * Real-git coverage (Phase 35, BINLIB-01..04) uses makeFixtureRepo(): a real temporary git repo
 * holding a TRACKED hand-written bin/lib/capability-validator.cjs and a per-file GITIGNORED
 * (emitted) bin/lib/emitted.cjs, exercised through the default git check-ignore probe:
 *   - BINLIB-01: tracked or untracked-not-ignored bin/lib/*.cjs → ALLOW (in-process + spawned)
 *   - BINLIB-02: ignored bin/lib/*.cjs → DENY, reason byte-identical to binLibDenyReason
 *   - BINLIB-03: undecidable (dir absent, not a work tree, git missing, git hang, odd seam
 *     values) → DENY, ADR-457 reason + "could not be determined" note
 *   - BINLIB-04: the tracked-file ALLOW was recorded RED against the pre-fix gate
 *   - T-35-02 env redirect, T-35-03 argv metacharacters, T-35-05 dot segments
 *   - 35-02 review fixes: MJ-01 redirected repository discovery (nested `git init`, planted
 *     `gitdir:` files in lib/ or bin/, repo-local core.worktree) → undecidable DENY; MJ-02 any
 *     .cjs at any depth below bin/lib is a candidate (ignored nested → DENY, tracked nested
 *     vendor → ALLOW); MN-01 inherited pathspec-mode / ceiling env cannot false-deny; MN-03
 *     case-insensitive bin/lib segments; NT-03 the reason names src/*.cts; NT-04 symlink guards
 */

require('./lib/test-isolate.cjs').isolateToolLog(); // never the real ~/.gsd-contrib tool log (quick 261024-po0)
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { runBinlibGate, binLibDenyReason, REPO_REDIRECT_ENV } = require('./binlib-edit.cjs');

function input(filePath, toolName = 'Edit', cwd) {
  const tool_input = filePath === undefined ? {} : { file_path: filePath };
  const payload = { tool_name: toolName, tool_input };
  if (cwd !== undefined) payload.cwd = cwd;
  return JSON.stringify(payload);
}

// --- real temporary git repo fixture (BINLIB-01..04) ---------------------------------------
// Fixture git runs with the same variables the hook's probe scrubs (REPO_REDIRECT_ENV: repo
// redirects, pathspec modes, ceiling) removed and the host config shut out, so neither the
// developer's GIT_DIR/GIT_INDEX_FILE/GIT_*_PATHSPECS nor ~/.gitconfig can shape the fixture.
const FIXTURE_GIT_ENV = (() => {
  const env = Object.assign({}, process.env);
  for (const k of REPO_REDIRECT_ENV) delete env[k];
  env.GIT_CONFIG_GLOBAL = '/dev/null';
  env.GIT_CONFIG_NOSYSTEM = '1';
  return env;
})();

// MN-02: the HOOK deliberately honors the user's real global git config (a global excludes file
// is part of what git itself treats as ignored), so the tests isolate it instead: the probe runs
// in-process (it reads process.env) or as a spawned hook, and both see these two overrides.
const ISOLATED_GIT_CONFIG = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

/**
 * Run fn with the host's global and system git config shut out of process.env, restoring the
 * previous values in finally. node:test runs this file's synchronous tests one at a time, so the
 * mutation cannot leak into a concurrent test.
 */
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

/** runBinlibGate through the DEFAULT (real git) probe, isolated from host git config. */
function realGate(stdin, over = {}) {
  return withIsolatedGitConfig(() => runBinlibGate(stdin, deps(over)));
}

function fixtureGit(cwd, argv, env = FIXTURE_GIT_ENV) {
  const r = spawnSync('git', argv, { cwd, env, encoding: 'utf8' });
  if (r.error || r.status !== 0) {
    throw new Error(
      'fixture git ' + argv.join(' ') + ' failed (status ' + r.status + '): ' +
        ((r.error && r.error.message) || r.stderr || '')
    );
  }
  return r;
}

/**
 * A real git repo shaped like gsd-core: a TRACKED hand-written bin/lib/capability-validator.cjs
 * and a GITIGNORED (emitted) bin/lib/emitted.cjs, ignored by a per-file .gitignore line
 * (gsd-core .gitignore:203 style). It also carries the nested shapes gsd-core really has (MJ-02):
 * a GITIGNORED bin/lib/observability/emitted-nested.cjs and a TRACKED vendor file
 * bin/lib/vendor/js-yaml.cjs. Callers MUST cleanup() in a finally block.
 */
function makeFixtureRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'binlib-git-'));
  try {
    const binDir = path.join(root, 'gsd-core', 'bin');
    const libDir = path.join(binDir, 'lib');
    fixtureGit(root, ['init', '-q']);
    fs.writeFileSync(
      path.join(root, '.gitignore'),
      '/gsd-core/bin/lib/emitted.cjs\n/gsd-core/bin/lib/observability/emitted-nested.cjs\n'
    );
    fs.mkdirSync(path.join(libDir, 'observability'), { recursive: true });
    fs.mkdirSync(path.join(libDir, 'vendor'), { recursive: true });
    const tracked = path.join(libDir, 'capability-validator.cjs');
    const ignored = path.join(libDir, 'emitted.cjs');
    const nestedIgnored = path.join(libDir, 'observability', 'emitted-nested.cjs');
    const nestedTracked = path.join(libDir, 'vendor', 'js-yaml.cjs');
    fs.writeFileSync(tracked, "'use strict';\nmodule.exports = { handWritten: true };\n");
    fs.writeFileSync(ignored, "'use strict';\nmodule.exports = { emitted: true };\n");
    fs.writeFileSync(nestedIgnored, "'use strict';\nmodule.exports = { emitted: 'nested' };\n");
    fs.writeFileSync(nestedTracked, "'use strict';\nmodule.exports = { vendor: true };\n");
    fixtureGit(root, [
      'add',
      '.gitignore',
      'gsd-core/bin/lib/capability-validator.cjs',
      'gsd-core/bin/lib/vendor/js-yaml.cjs',
    ]);
    fixtureGit(root, [
      '-c', 'user.name=binlib-test',
      '-c', 'user.email=binlib-test@example.invalid',
      '-c', 'commit.gpgsign=false',
      'commit', '-q', '-m', 'fixture',
    ]);
    return {
      root,
      binDir,
      libDir,
      tracked,
      ignored,
      nestedIgnored,
      nestedTracked,
      cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
    };
  } catch (err) {
    fs.rmSync(root, { recursive: true, force: true });
    throw err;
  }
}

function deps(over = {}) {
  return Object.assign(
    {
      worktreeRoot: '/tmp/wt',
      overrideImpl: { checkOverride: () => ({ override: false }), writeReceipt: () => {} },
    },
    over
  );
}

test('top-level bin/lib/*.cjs Edit → deny, reason names src/*.cts + ADR-457 (NT-03)', () => {
  const d = realGate(input('/home/x/gsd-core/bin/lib/decisions.cjs'));
  assert.strictEqual(d.permissionDecision, 'deny');
  // NT-03 (35-02): gsd-core's src/ tree is `.cts` (measured 2026-10-05: 240 `.cts`, 0 `.ts` in
  // src/). CONFLICT-02 (phase 06) chose `.ts` when no src/ tree existed yet; the live tree now
  // settles it, so the reason names `src/*.cts`.
  assert.match(d.permissionDecisionReason, /`src\/\*\.cts`/);
  assert.doesNotMatch(d.permissionDecisionReason, /src\/\*\.ts\b/);
  assert.match(d.permissionDecisionReason, /457/);
});

test('nested .../packages/x/bin/lib/foo.cjs Edit → deny (glob matches any depth)', () => {
  const d = realGate(input('/repo/packages/x/bin/lib/foo.cjs'));
  assert.strictEqual(d.permissionDecision, 'deny');
});

test('relative bin/lib/*.cjs path → deny (no leading slash)', () => {
  // Hermetic: the payload cwd is a path that does not exist, so the resolved target's directory
  // is absent and the git probe is undecidable → deny (BINLIB-03), independent of where the
  // suite runs.
  const ghostCwd = path.join(os.tmpdir(), 'binlib-ghost-cwd-' + process.pid + '-does-not-exist');
  const d = realGate(input('bin/lib/state.cjs', 'Edit', ghostCwd));
  assert.strictEqual(d.permissionDecision, 'deny');
});

test('Write (not just Edit) to bin/lib/*.cjs → deny', () => {
  const d = realGate(input('/g/gsd-core/bin/lib/x.cjs', 'Write'));
  assert.strictEqual(d.permissionDecision, 'deny');
});

test('src/*.cts source path → allow (the correct file to edit)', () => {
  const d = realGate(input('/home/x/gsd-core/sdk/src/query/decisions.cts'));
  assert.strictEqual(d.permissionDecision, 'allow');
});

test('src/bin-lib-notes.md (bin-lib substring, not a bin/lib segment pair) → allow', () => {
  const d = realGate(input('/repo/src/bin-lib-notes.md'));
  assert.strictEqual(d.permissionDecision, 'allow');
});

test('a path containing "bin/lib" only as substring within one segment → allow', () => {
  const d = realGate(input('/repo/src/mybin/libfoo.cjs'));
  assert.strictEqual(d.permissionDecision, 'allow');
});

test('bin/lib/README.md (segment pair but leaf is not .cjs) → allow', () => {
  const d = realGate(input('/g/gsd-core/bin/lib/README.md'));
  assert.strictEqual(d.permissionDecision, 'allow');
});

test('MJ-02: bin/lib/sub/nested.cjs is a candidate; this path does not exist, so it is undecidable → deny with the note', () => {
  const fp = '/g/gsd-core/bin/lib/sub/nested.cjs';
  const d = realGate(input(fp));
  assertUndecidableDeny(d.permissionDecision, d.permissionDecisionReason, fp);
});

test('a doc file → allow', () => {
  const d = realGate(input('/repo/docs/guide.md'));
  assert.strictEqual(d.permissionDecision, 'allow');
});

test('a test file → allow', () => {
  const d = realGate(input('/repo/hooks/foo.test.cjs'));
  assert.strictEqual(d.permissionDecision, 'allow');
});

test('lib before bin (lib/bin/x.cjs — wrong order) → allow (segment order is bin then lib)', () => {
  const d = realGate(input('/g/gsd-core/lib/bin/x.cjs'));
  assert.strictEqual(d.permissionDecision, 'allow');
});

test('missing file_path → fail-closed deny (HARD-01)', () => {
  // HARD-01 is preserved for the tools this gate governs (Write/Edit): a Write/Edit that
  // carries no file_path cannot be evaluated → fail closed. `input(undefined)` defaults to
  // tool_name:'Edit', so this stays a DENY even after the non-Write/Edit self-filter lands.
  const d = realGate(input(undefined));
  assert.strictEqual(d.permissionDecision, 'deny');
});

test('non-string file_path → fail-closed deny (HARD-01)', () => {
  const stdin = JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: 123 } });
  const d = realGate(stdin);
  assert.strictEqual(d.permissionDecision, 'deny');
});

// --- tool_name self-filter (defense-in-depth layer 2) --------------------------------------
// This gate governs only Write|Edit. When installed CATCH-ALL (no manifest matcher) it also
// receives Bash/other payloads that legitimately carry no file_path — those MUST short-circuit
// to ALLOW, never trip the Write/Edit HARD-01 fail-closed (the root cause of every-Bash-deny).

test('tool_name:"Bash" payload (command, no file_path) → allow (self-filter, not HARD-01 deny)', () => {
  const stdin = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git status' } });
  const d = realGate(stdin);
  assert.strictEqual(d.permissionDecision, 'allow');
});

test('non-Write/Edit tool (Read) with no file_path → allow (self-filter)', () => {
  const stdin = JSON.stringify({ tool_name: 'Read', tool_input: {} });
  const d = realGate(stdin);
  assert.strictEqual(d.permissionDecision, 'allow');
});

test('absent tool_name with no file_path → allow (self-filter, this gate does not govern it)', () => {
  const stdin = JSON.stringify({ tool_input: {} });
  const d = realGate(stdin);
  assert.strictEqual(d.permissionDecision, 'allow');
});

test('tool_name:"Bash" whose command mentions a bin/lib/*.cjs path → allow (Bash is not governed here)', () => {
  const stdin = JSON.stringify({
    tool_name: 'Bash',
    tool_input: { command: 'node bin/lib/decisions.cjs' },
  });
  const d = realGate(stdin);
  assert.strictEqual(d.permissionDecision, 'allow');
});

test('malformed stdin JSON → fail-closed deny (HARD-01)', () => {
  const d = realGate('{not json');
  assert.strictEqual(d.permissionDecision, 'deny');
});

test('fail-closed deny is override-escapable (HARD-03)', () => {
  const over = {
    overrideImpl: {
      checkOverride: () => ({ override: true, reason: 'rebuilding generated file by hand' }),
      writeReceipt: () => {},
    },
  };
  const d = runBinlibGate(input(undefined), deps(over));
  assert.strictEqual(d.permissionDecision, 'allow');
});

test('BINLIB-02: an ACTIVE override cannot flip the policy deny of an ignored (generated) file', () => {
  const over = {
    checkIgnore: () => 'ignored',
    overrideImpl: {
      checkOverride: () => ({ override: true, reason: 'rebuilding generated file by hand' }),
      writeReceipt: () => {},
    },
  };
  const d = runBinlibGate(input('/repo/gsd-core/bin/lib/emitted.cjs'), deps(over));
  assert.strictEqual(d.permissionDecision, 'deny');
});

test('BINLIB-03: an ACTIVE override cannot flip the undecidable deny', () => {
  const over = {
    checkIgnore: () => 'unknown',
    overrideImpl: {
      checkOverride: () => ({ override: true, reason: 'rebuilding generated file by hand' }),
      writeReceipt: () => {},
    },
  };
  const d = runBinlibGate(input('/repo/gsd-core/bin/lib/emitted.cjs'), deps(over));
  assert.strictEqual(d.permissionDecision, 'deny');
});

// --- BINLIB-01..04: real-git discriminator (tracked = hand-written, ignored = generated) -----

test('BINLIB-01/BINLIB-04: Edit of a TRACKED hand-written bin/lib/capability-validator.cjs in a real git repo → allow', () => {
  const fx = makeFixtureRepo();
  try {
    const d = realGate(input(fx.tracked, 'Edit', fx.root));
    assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
  } finally {
    fx.cleanup();
  }
});

/** Byte snapshot of everything a mutating git call could touch: all of .git/ plus the worktree. */
function snapshotRepo(root) {
  const out = {};
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(root, p)] = fs.readFileSync(p).toString('base64');
    }
  };
  walk(root);
  return out;
}

test('BINLIB-04: the gate is read-only — .git/ (index, refs, HEAD, config) and the worktree are byte-unchanged', () => {
  const fx = makeFixtureRepo();
  try {
    const before = snapshotRepo(fx.root);
    for (const fp of [fx.tracked, fx.ignored, fx.nestedIgnored, fx.nestedTracked]) {
      for (const tool of ['Edit', 'Write']) realGate(input(fp, tool, fx.root));
    }
    assert.deepStrictEqual(snapshotRepo(fx.root), before);
  } finally {
    fx.cleanup();
  }
});

test('BINLIB-01: Write of the tracked hand-written bin/lib/*.cjs → allow', () => {
  const fx = makeFixtureRepo();
  try {
    const d = realGate(input(fx.tracked, 'Write', fx.root));
    assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
  } finally {
    fx.cleanup();
  }
});

test('BINLIB-02: Edit of a GITIGNORED (emitted) bin/lib/*.cjs → deny with the byte-identical ADR-457 reason', () => {
  const fx = makeFixtureRepo();
  try {
    const d = realGate(input(fx.ignored, 'Edit', fx.root));
    assert.strictEqual(d.permissionDecision, 'deny');
    assert.strictEqual(d.permissionDecisionReason, binLibDenyReason(fx.ignored));
  } finally {
    fx.cleanup();
  }
});

test('BINLIB-01 end-to-end: spawned binlib-edit entrypoint allows the tracked file', () => {
  const fx = makeFixtureRepo();
  try {
    const r = spawnHookWithEnv(input(fx.tracked, 'Edit', fx.root), { cwd: fx.root });
    assert.strictEqual(r.decision, 'allow', r.reason);
  } finally {
    fx.cleanup();
  }
});

// --- BINLIB-01/03 + T-35-0x: undecidable fail-closed matrix and probe hardening ------------

const UNDECIDABLE = /could not be determined/;

/**
 * Spawn the real hook entrypoint with a CUSTOM env (proof-harness spawnHook always passes
 * process.env). `env` overrides are layered on a copy of process.env plus the host-git-config
 * isolation (MN-02); the verdict-log kill switch keeps these runs out of the user's real verdict
 * log (it never changes a decision).
 */
function spawnHookWithEnv(stdin, { cwd, env = {} } = {}) {
  const fullEnv = Object.assign(
    {},
    process.env,
    ISOLATED_GIT_CONFIG,
    { GSD_CONTRIB_NO_VERDICT_LOG: '1' },
    env
  );
  const started = Date.now();
  const r = spawnSync(process.execPath, [path.join(__dirname, 'binlib-edit.cjs')], {
    input: stdin,
    encoding: 'utf8',
    cwd,
    env: fullEnv,
  });
  const ms = Date.now() - started;
  assert.strictEqual(r.error, undefined, r.error && r.error.message);
  assert.strictEqual(r.status, 0, 'hook exited ' + r.status + ': ' + r.stderr);
  const out = JSON.parse(r.stdout).hookSpecificOutput;
  return { decision: out.permissionDecision, reason: out.permissionDecisionReason, ms };
}

function assertUndecidableDeny(decision, reason, filePath) {
  assert.strictEqual(decision, 'deny');
  assert.ok(
    reason.startsWith(binLibDenyReason(filePath)),
    'undecidable reason must keep the full ADR-457 reason as its prefix: ' + reason
  );
  assert.match(reason, UNDECIDABLE);
  assert.match(reason, /`src\/\*\.cts`/);
}

test('BINLIB-01: a brand-new, untracked, not-ignored bin/lib/*.cjs → allow (gsd-core ignores per file)', () => {
  const fx = makeFixtureRepo();
  try {
    const fresh = path.join(fx.libDir, 'brand-new.cjs');
    fs.writeFileSync(fresh, "'use strict';\n");
    const d = realGate(input(fresh, 'Write', fx.root));
    assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
  } finally {
    fx.cleanup();
  }
});

test('BINLIB-03: candidate under an ABSENT directory → deny with the undecidable note', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'binlib-absent-'));
  try {
    const fp = path.join(base, 'does-not-exist', 'gsd-core', 'bin', 'lib', 'x.cjs');
    const d = realGate(input(fp, 'Edit', base));
    assertUndecidableDeny(d.permissionDecision, d.permissionDecisionReason, fp);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('BINLIB-03: candidate in an existing directory that is NOT a git work tree (exit 128) → deny with the note', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'binlib-norepo-'));
  try {
    const libDir = path.join(base, 'bin', 'lib');
    fs.mkdirSync(libDir, { recursive: true });
    const fp = path.join(libDir, 'x.cjs');
    fs.writeFileSync(fp, "'use strict';\n");
    const d = realGate(input(fp, 'Edit', base));
    assertUndecidableDeny(d.permissionDecision, d.permissionDecisionReason, fp);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('BINLIB-03: NO fixed git (fixedGit null; quick 261120-28y re-point, PATH no longer decides) → spawned hook denies even the TRACKED file, with the note', () => {
  const fx = makeFixtureRepo();
  const pre = writePreload('null');
  try {
    const r = spawnPreloaded(input(fx.tracked, 'Edit', fx.root), { cwd: fx.root, preload: pre });
    assert.deepStrictEqual(preloadSpawns(pre), [], 'nothing is spawned without a fixed git');
    assertUndecidableDeny(r.decision, r.reason, fx.tracked);
  } finally {
    pre.cleanup();
    fx.cleanup();
  }
});

test('BINLIB-03: the fixed git HANGS past the probe timeout (quick 261120-28y re-point) → spawned hook denies the TRACKED file, with the note, under 10 s', () => {
  const { CHECK_IGNORE_TIMEOUT_MS } = require('./binlib-edit.cjs');
  const fx = makeFixtureRepo();
  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'binlib-hang-'));
  try {
    // The probe PATH is the shim's own dir and /bin/sh may be dash (no sleep builtin), so the shim writes a
    // started mark with the echo builtin and execs an absolute sleep (R1 W-01). exec is required: a grandchild
    // sleep holding the stderr pipe would keep spawnSync waiting past its timeout.
    const sleepBin = ['/bin/sleep', '/usr/bin/sleep'].find((p) => fs.existsSync(p));
    assert.ok(sleepBin, 'an absolute sleep must exist at /bin/sleep or /usr/bin/sleep');
    const started = path.join(shimDir, 'started');
    const shim = path.join(shimDir, 'git');
    fs.writeFileSync(shim, '#!/bin/sh\necho started >> ' + JSON.stringify(started) + '\nexec ' + JSON.stringify(sleepBin) + ' 30\n');
    fs.chmodSync(shim, 0o755);
    const pre = writePreload(shim);
    try {
      const r = spawnPreloaded(input(fx.tracked, 'Edit', fx.root), { cwd: fx.root, preload: pre });
      assert.deepStrictEqual(preloadSpawns(pre), [shim], 'the hanging fixed git was spawned once');
      assert.ok(fs.existsSync(started), 'the shim started, so the hang really happened');
      assertUndecidableDeny(r.decision, r.reason, fx.tracked);
      assert.ok(r.ms < 10000, 'hook took ' + r.ms + ' ms (must stay under the 10 s hook timeout)');
      assert.ok(r.ms >= CHECK_IGNORE_TIMEOUT_MS - 200, 'hook took ' + r.ms + ' ms: the probe must have waited out its deadline');
    } finally {
      pre.cleanup();
    }
  } finally {
    fs.rmSync(shimDir, { recursive: true, force: true });
    fx.cleanup();
  }
});

test('BINLIB-03: injected checkIgnore seam — only the exact string not-ignored allows', () => {
  const fp = '/g/gsd-core/bin/lib/seam.cjs';
  for (const v of ['unknown', 'IGNORED', '', undefined, 'not-ignored ', 'allow']) {
    const d = runBinlibGate(input(fp), deps({ checkIgnore: () => v }));
    assertUndecidableDeny(d.permissionDecision, d.permissionDecisionReason, fp);
  }
  const thrown = runBinlibGate(
    input(fp),
    deps({
      checkIgnore: () => {
        throw new Error('probe exploded');
      },
    })
  );
  assert.strictEqual(thrown.permissionDecision, 'deny');
  const ignored = runBinlibGate(input(fp), deps({ checkIgnore: () => 'ignored' }));
  assert.strictEqual(ignored.permissionDecision, 'deny');
  assert.strictEqual(ignored.permissionDecisionReason, binLibDenyReason(fp));
  const ok = runBinlibGate(input(fp), deps({ checkIgnore: () => 'not-ignored' }));
  assert.strictEqual(ok.permissionDecision, 'allow');
});

test('BINLIB-03: classifyCheckIgnore maps only exit 0/1; every other result is unknown', () => {
  const { classifyCheckIgnore } = require('./binlib-edit.cjs');
  const timeout = Object.assign(new Error('spawnSync git ETIMEDOUT'), { code: 'ETIMEDOUT' });
  const enoent = Object.assign(new Error('spawnSync git ENOENT'), { code: 'ENOENT' });
  assert.strictEqual(classifyCheckIgnore({ status: 0 }), 'ignored');
  assert.strictEqual(classifyCheckIgnore({ status: 1 }), 'not-ignored');
  assert.strictEqual(classifyCheckIgnore({ status: null, signal: 'SIGTERM', error: timeout }), 'unknown');
  assert.strictEqual(classifyCheckIgnore({ status: null, signal: 'SIGTERM' }), 'unknown');
  assert.strictEqual(classifyCheckIgnore({ error: enoent }), 'unknown');
  assert.strictEqual(classifyCheckIgnore({ status: 128 }), 'unknown');
  assert.strictEqual(classifyCheckIgnore({ status: 2 }), 'unknown');
  assert.strictEqual(classifyCheckIgnore({ status: 0, error: enoent }), 'unknown');
});

test('BINLIB-01: a non-candidate (sdk/src/query/decisions.cts) is allowed without ever probing git', () => {
  let calls = 0;
  const d = runBinlibGate(
    input('/g/gsd-core/sdk/src/query/decisions.cts'),
    deps({
      checkIgnore: () => {
        calls += 1;
        return 'ignored';
      },
    })
  );
  assert.strictEqual(d.permissionDecision, 'allow');
  assert.strictEqual(calls, 0);
});

test('T-35-02: an inherited GIT_INDEX_FILE that force-adds the emitted file cannot turn its deny into an allow', () => {
  const fx = makeFixtureRepo();
  try {
    const altIndex = path.join(fx.root, '.git', 'binlib-alt-index');
    fixtureGit(
      fx.root,
      ['add', '-f', 'gsd-core/bin/lib/emitted.cjs'],
      Object.assign({}, FIXTURE_GIT_ENV, { GIT_INDEX_FILE: altIndex })
    );
    const r = spawnHookWithEnv(input(fx.ignored, 'Edit', fx.root), {
      cwd: fx.root,
      env: { GIT_INDEX_FILE: altIndex },
    });
    assert.strictEqual(r.decision, 'deny', 'GIT_INDEX_FILE redirect opened a bypass');
    assert.strictEqual(r.reason, binLibDenyReason(fx.ignored));
  } finally {
    fx.cleanup();
  }
});

test('T-35-05: dot-segment path <libDir>/../lib/emitted.cjs still reaches git and denies', () => {
  const fx = makeFixtureRepo();
  try {
    const fp = fx.libDir + '/../lib/emitted.cjs';
    const d = realGate(input(fp, 'Edit', fx.root));
    assert.strictEqual(d.permissionDecision, 'deny');
  } finally {
    fx.cleanup();
  }
});

test('T-35-05: dot-segment path <libDir>/./emitted.cjs still reaches git and denies', () => {
  const fx = makeFixtureRepo();
  try {
    const fp = fx.libDir + '/./emitted.cjs';
    const d = realGate(input(fp, 'Edit', fx.root));
    assert.strictEqual(d.permissionDecision, 'deny');
  } finally {
    fx.cleanup();
  }
});

function findNamed(dir, name) {
  const hits = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.name === name) hits.push(p);
    if (e.isDirectory()) hits.push(...findNamed(p, name));
  }
  return hits;
}

test('T-35-03: shell metacharacters in the leaf reach git as one argv element and execute nothing', () => {
  const fx = makeFixtureRepo();
  try {
    const fp = path.join(fx.libDir, '$(touch PWNED).cjs');
    const d = realGate(input(fp, 'Write', fx.root));
    // The verdict is not the point (MN-02): only that git answered without a shell running.
    assert.ok(['allow', 'deny'].includes(d.permissionDecision), d.permissionDecision);
    assert.deepStrictEqual(findNamed(fx.root, 'PWNED'), []);
  } finally {
    fx.cleanup();
  }
});

// --- 35-02 review fixes -----------------------------------------------------------------------

/** git check-ignore exactly as the pre-fix probe ran it (cwd = the file's dir), isolated. */
function rawCheckIgnore(absPath) {
  return spawnSync('git', ['check-ignore', '-q', '--', absPath], {
    cwd: path.dirname(absPath),
    env: FIXTURE_GIT_ENV,
    encoding: 'utf8',
  }).status;
}

function assertRedirectDenied(fx, target, label) {
  // Precondition: the route really is a bypass of the bare check-ignore probe (exit 1, "not
  // ignored"), not a 128 that would deny for an unrelated reason.
  assert.strictEqual(rawCheckIgnore(target), 1, label + ': route must make raw check-ignore exit 1');
  const d = realGate(input(target, 'Edit', fx.root));
  assertUndecidableDeny(d.permissionDecision, d.permissionDecisionReason, target);
}

test('MJ-01: a nested `git init` in bin/lib cannot redirect discovery into an allow (undecidable deny)', () => {
  const fx = makeFixtureRepo();
  try {
    fixtureGit(fx.libDir, ['init', '-q']);
    assertRedirectDenied(fx, fx.ignored, 'nested git init in lib');
  } finally {
    fx.cleanup();
  }
});

function makeFakeGitDir() {
  const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'binlib-fake-'));
  fixtureGit(fake, ['init', '-q']);
  return fake;
}

test('MJ-01: a planted `gitdir:` file at bin/lib/.git cannot redirect discovery into an allow', () => {
  const fx = makeFixtureRepo();
  const fake = makeFakeGitDir();
  try {
    fs.writeFileSync(path.join(fx.libDir, '.git'), 'gitdir: ' + path.join(fake, '.git') + '\n');
    assertRedirectDenied(fx, fx.ignored, 'gitdir file in lib');
  } finally {
    fs.rmSync(fake, { recursive: true, force: true });
    fx.cleanup();
  }
});

test('MJ-01: a planted `gitdir:` file one level up at bin/.git cannot redirect discovery into an allow', () => {
  const fx = makeFixtureRepo();
  const fake = makeFakeGitDir();
  try {
    fs.writeFileSync(path.join(fx.binDir, '.git'), 'gitdir: ' + path.join(fake, '.git') + '\n');
    assertRedirectDenied(fx, fx.ignored, 'gitdir file in bin');
  } finally {
    fs.rmSync(fake, { recursive: true, force: true });
    fx.cleanup();
  }
});

test('MJ-01: a repo-local core.worktree re-rooting the work tree cannot turn the emitted deny into an allow', () => {
  const fx = makeFixtureRepo();
  try {
    fixtureGit(fx.root, ['config', 'core.worktree', path.join(fx.root, 'gsd-core')]);
    assertRedirectDenied(fx, fx.ignored, 'core.worktree');
  } finally {
    fx.cleanup();
  }
});

test('MJ-01: a nested `git init` deeper in bin/lib (observability/) cannot redirect a nested candidate', () => {
  const fx = makeFixtureRepo();
  try {
    fixtureGit(path.dirname(fx.nestedIgnored), ['init', '-q']);
    assertRedirectDenied(fx, fx.nestedIgnored, 'nested git init in lib/observability');
  } finally {
    fx.cleanup();
  }
});

test('MJ-01: the untouched fixture still allows the tracked file and denies the emitted one (no false deny)', () => {
  const fx = makeFixtureRepo();
  try {
    assert.strictEqual(realGate(input(fx.tracked, 'Edit', fx.root)).permissionDecision, 'allow');
    const d = realGate(input(fx.ignored, 'Edit', fx.root));
    assert.strictEqual(d.permissionDecisionReason, binLibDenyReason(fx.ignored));
  } finally {
    fx.cleanup();
  }
});

test('MJ-02: a GITIGNORED nested bin/lib/observability/*.cjs (emitted) → deny with the ADR-457 reason', () => {
  const fx = makeFixtureRepo();
  try {
    const d = realGate(input(fx.nestedIgnored, 'Edit', fx.root));
    assert.strictEqual(d.permissionDecision, 'deny');
    assert.strictEqual(d.permissionDecisionReason, binLibDenyReason(fx.nestedIgnored));
  } finally {
    fx.cleanup();
  }
});

test('MJ-02: a TRACKED nested vendor file bin/lib/vendor/js-yaml.cjs → allow (git decides, not depth)', () => {
  const fx = makeFixtureRepo();
  try {
    const d = realGate(input(fx.nestedTracked, 'Edit', fx.root));
    assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
  } finally {
    fx.cleanup();
  }
});

test('MJ-02/MN-03: candidate matching is any depth below bin/lib and case-insensitive on bin and lib', () => {
  const { isGeneratedBinLib } = require('./binlib-edit.cjs');
  for (const p of [
    '/g/gsd-core/bin/lib/x.cjs',
    '/g/gsd-core/bin/lib/observability/logger.cjs',
    '/g/gsd-core/bin/lib/a/b/c.CJS',
    '/g/gsd-core/BIN/Lib/active-workstream-store.cjs',
    'C:\\g\\gsd-core\\Bin\\LIB\\sub\\x.cjs',
  ]) {
    assert.strictEqual(isGeneratedBinLib(p), true, p);
  }
  for (const p of [
    '/g/gsd-core/bin/lib/README.md',
    '/g/gsd-core/bin/lib',
    '/g/gsd-core/bin/lib.cjs',
    '/g/gsd-core/lib/bin/x.cjs',
    '/g/gsd-core/bin/x/lib/y.cjs',
    '/repo/src/mybin/libfoo.cjs',
  ]) {
    assert.strictEqual(isGeneratedBinLib(p), false, p);
  }
});

test('MN-03: a case-variant BIN/Lib path reaches the probe (case-insensitive filesystems alias it)', () => {
  let calls = 0;
  const fp = '/g/gsd-core/BIN/Lib/active-workstream-store.cjs';
  const d = runBinlibGate(
    input(fp),
    deps({
      checkIgnore: () => {
        calls += 1;
        return 'ignored';
      },
    })
  );
  assert.strictEqual(calls, 1);
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.strictEqual(d.permissionDecisionReason, binLibDenyReason(fp));
});

for (const [k, v] of [
  ['GIT_GLOB_PATHSPECS', '1'],
  ['GIT_NOGLOB_PATHSPECS', '1'],
  ['GIT_ICASE_PATHSPECS', '1'],
  ['GIT_LITERAL_PATHSPECS', '1'],
  ['GIT_CEILING_DIRECTORIES', null],
]) {
  test('MN-01: an inherited ' + k + ' cannot false-deny the tracked file or open the emitted one', () => {
    const fx = makeFixtureRepo();
    try {
      const env = { [k]: v === null ? fx.root : v };
      const ok = spawnHookWithEnv(input(fx.tracked, 'Edit', fx.root), { cwd: fx.root, env });
      assert.strictEqual(ok.decision, 'allow', k + ': ' + ok.reason);
      const no = spawnHookWithEnv(input(fx.ignored, 'Edit', fx.root), { cwd: fx.root, env });
      assert.strictEqual(no.decision, 'deny');
      assert.strictEqual(no.reason, binLibDenyReason(fx.ignored), k);
    } finally {
      fx.cleanup();
    }
  });
}

test('NT-04: through a symlinked repo ROOT the verdict is normal (tracked allow, emitted deny)', () => {
  const fx = makeFixtureRepo();
  const linkBase = fs.mkdtempSync(path.join(os.tmpdir(), 'binlib-link-'));
  try {
    const link = path.join(linkBase, 'repolink');
    fs.symlinkSync(fx.root, link, 'dir');
    const rel = (p) => path.join(link, path.relative(fx.root, p));
    const t = realGate(input(rel(fx.tracked), 'Edit', link));
    assert.strictEqual(t.permissionDecision, 'allow', t.permissionDecisionReason);
    const e = realGate(input(rel(fx.ignored), 'Edit', link));
    assert.strictEqual(e.permissionDecision, 'deny');
    assert.strictEqual(e.permissionDecisionReason, binLibDenyReason(rel(fx.ignored)));
  } finally {
    fs.rmSync(linkBase, { recursive: true, force: true });
    fx.cleanup();
  }
});

test('NT-04: through an in-worktree symlinked alias of bin/lib the emitted file is denied', () => {
  const fx = makeFixtureRepo();
  try {
    const aliasBin = path.join(fx.root, 'alias', 'bin');
    fs.mkdirSync(aliasBin, { recursive: true });
    fs.symlinkSync(path.join('..', '..', 'gsd-core', 'bin', 'lib'), path.join(aliasBin, 'lib'), 'dir');
    const d = realGate(input(path.join(aliasBin, 'lib', 'emitted.cjs'), 'Edit', fx.root));
    assert.strictEqual(d.permissionDecision, 'deny');
  } finally {
    fx.cleanup();
  }
});

test('MJ-01: binDirOf picks the OUTERMOST bin of a bin/lib pair; isStrictAncestor is strict', () => {
  const { binDirOf, isStrictAncestor } = require('./binlib-edit.cjs');
  assert.strictEqual(binDirOf('/r/gsd-core/bin/lib/x.cjs'), '/r/gsd-core/bin');
  assert.strictEqual(binDirOf('/r/gsd-core/bin/lib/obs/x.cjs'), '/r/gsd-core/bin');
  assert.strictEqual(binDirOf('/r/BIN/Lib/x.cjs'), '/r/BIN');
  assert.strictEqual(binDirOf('/a/bin/lib/b/bin/lib/x.cjs'), '/a/bin');
  assert.strictEqual(binDirOf('/r/gsd-core/bin/x.cjs'), null);
  assert.strictEqual(isStrictAncestor('/r', '/r/gsd-core/bin'), true);
  assert.strictEqual(isStrictAncestor('/r/gsd-core/bin', '/r/gsd-core/bin'), false);
  assert.strictEqual(isStrictAncestor('/r/gsd-core/bin/lib', '/r/gsd-core/bin'), false);
  assert.strictEqual(isStrictAncestor('/elsewhere', '/r/gsd-core/bin'), false);
  assert.strictEqual(isStrictAncestor('/r/..gsd', '/r/..gsd/bin'), true);
  assert.strictEqual(isStrictAncestor('', '/r/gsd-core/bin'), false);
});

// --- MJ-01 variant: a repository boundary ABOVE bin, nested inside an enclosing repo ---------

function commitAll(cwd) {
  fixtureGit(cwd, [
    '-c', 'user.name=binlib-test',
    '-c', 'user.email=binlib-test@example.invalid',
    '-c', 'commit.gpgsign=false',
    'commit', '-q', '--allow-empty', '-m', 'wt',
  ]);
}

test('MJ-01 variant: a planted `gitdir:` file at <repo>/gsd-core/.git (above bin) pointing at a crafted repo → deny', () => {
  const fx = makeFixtureRepo();
  const fake = makeFakeGitDir();
  try {
    fs.writeFileSync(path.join(fx.root, 'gsd-core', '.git'), 'gitdir: ' + path.join(fake, '.git') + '\n');
    assertRedirectDenied(fx, fx.ignored, 'gitdir file above bin');
  } finally {
    fs.rmSync(fake, { recursive: true, force: true });
    fx.cleanup();
  }
});

test('MJ-01 variant: a `gitdir:` file above bin borrowing a REAL worktree of the enclosing repo that does not point back → deny', () => {
  const fx = makeFixtureRepo();
  try {
    const w = path.join(fx.root, '.claude', 'worktrees', 'w');
    fixtureGit(fx.root, ['worktree', 'add', '-q', '--detach', w]);
    fs.writeFileSync(
      path.join(fx.root, 'gsd-core', '.git'),
      'gitdir: ' + path.join(fx.root, '.git', 'worktrees', 'w') + '\n'
    );
    assertRedirectDenied(fx, fx.ignored, 'borrowed worktree gitdir above bin');
  } finally {
    fx.cleanup();
  }
});

test('MJ-01 variant: an independent `git init` at <repo>/gsd-core (above bin) → deny', () => {
  const fx = makeFixtureRepo();
  try {
    fixtureGit(path.join(fx.root, 'gsd-core'), ['init', '-q']);
    assertRedirectDenied(fx, fx.ignored, 'independent nested repo above bin');
  } finally {
    fx.cleanup();
  }
});

test('MJ-01 variant: a real linked worktree INSIDE the repo (<repo>/.claude/worktrees/w) keeps normal verdicts', () => {
  const fx = makeFixtureRepo();
  try {
    const w = path.join(fx.root, '.claude', 'worktrees', 'w');
    fixtureGit(fx.root, ['worktree', 'add', '-q', '--detach', w]);
    const wLib = path.join(w, 'gsd-core', 'bin', 'lib');
    const wEmitted = path.join(wLib, 'emitted.cjs');
    fs.writeFileSync(wEmitted, "'use strict';\n");
    const t = realGate(input(path.join(wLib, 'capability-validator.cjs'), 'Edit', w));
    assert.strictEqual(t.permissionDecision, 'allow', t.permissionDecisionReason);
    const e = realGate(input(wEmitted, 'Edit', w));
    assert.strictEqual(e.permissionDecision, 'deny');
    assert.strictEqual(e.permissionDecisionReason, binLibDenyReason(wEmitted));
  } finally {
    fx.cleanup();
  }
});

test('MJ-01 variant: a linked worktree OUTSIDE the repo (Orca workspaces layout) keeps normal verdicts', () => {
  const fx = makeFixtureRepo();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'binlib-orca-'));
  try {
    const w = path.join(ws, 'workspaces', 'gsd-core', 'W1');
    fixtureGit(fx.root, ['worktree', 'add', '-q', '--detach', w]);
    const wLib = path.join(w, 'gsd-core', 'bin', 'lib');
    const wEmitted = path.join(wLib, 'emitted.cjs');
    fs.writeFileSync(wEmitted, "'use strict';\n");
    const t = realGate(input(path.join(wLib, 'capability-validator.cjs'), 'Edit', w));
    assert.strictEqual(t.permissionDecision, 'allow', t.permissionDecisionReason);
    const e = realGate(input(wEmitted, 'Edit', w));
    assert.strictEqual(e.permissionDecisionReason, binLibDenyReason(wEmitted));
  } finally {
    fixtureGit(fx.root, ['worktree', 'prune']);
    fs.rmSync(ws, { recursive: true, force: true });
    fx.cleanup();
  }
});

test('MJ-01 variant: a harness worktree nested in an OUTSIDE linked worktree (<orca-wt>/.claude/worktrees/x) keeps normal verdicts', () => {
  const fx = makeFixtureRepo();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'binlib-orca-'));
  try {
    const outer = path.join(ws, 'W1');
    fixtureGit(fx.root, ['worktree', 'add', '-q', '--detach', outer]);
    commitAll(outer);
    const inner = path.join(outer, '.claude', 'worktrees', 'x');
    fixtureGit(outer, ['worktree', 'add', '-q', '--detach', inner]);
    const lib = path.join(inner, 'gsd-core', 'bin', 'lib');
    const emitted = path.join(lib, 'emitted.cjs');
    fs.writeFileSync(emitted, "'use strict';\n");
    const t = realGate(input(path.join(lib, 'capability-validator.cjs'), 'Edit', inner));
    assert.strictEqual(t.permissionDecision, 'allow', t.permissionDecisionReason);
    const e = realGate(input(emitted, 'Edit', inner));
    assert.strictEqual(e.permissionDecisionReason, binLibDenyReason(emitted));
  } finally {
    fixtureGit(fx.root, ['worktree', 'prune']);
    fs.rmSync(ws, { recursive: true, force: true });
    fx.cleanup();
  }
});

// --- quick 261120-28y: binlib-edit's own probe spawns only the fixed git, hardened ---------
// DESIGN.md ## RED rows required, ## Amendment 1 (D8, corrected D7) and ## Amendment 2 (W-01 default-branch PATH
// row). Every row title carries the tag "28y". Helpers below are function declarations with names no earlier
// top-level declaration uses (R1 I2 N-02), and they read no module-level constant of this section, so a row
// earlier in the file can call them. Preloads live only in temp dirs with every value baked in (D3: no seam).

/** The listed git on this host (hooks/lib/hardened-git.cjs), or null. Rows needing a real answer skip on null. */
function listedGit28() {
  const hg = require('./lib/hardened-git.cjs');
  return hg.resolveGitPath(hg.GIT_CANDIDATES);
}
const NO_LISTED_GIT_28 = 'no git at any fixed candidate path on this host (binlib-edit then denies every candidate)';

/**
 * Write a --require preload into a fresh temp dir. It appends "loaded" to its record file, patches the
 * hardened-git module object's fixedGit when asked (mode 'keep', 'null', 'win32' or an absolute path), and
 * wraps child_process.spawnSync so each call appends "spawn <file>" before delegating. It reads no env value.
 */
function writePreload(mode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'binlib-28y-preload-'));
  const record = path.join(dir, 'record.txt');
  const preload = path.join(dir, 'preload.cjs');
  const hg = path.join(__dirname, 'lib', 'hardened-git.cjs');
  fs.writeFileSync(
    preload,
    [
      "'use strict';",
      "const fs = require('node:fs');",
      "const cp = require('node:child_process');",
      'const RECORD = ' + JSON.stringify(record) + ';',
      'const MODE = ' + JSON.stringify(mode) + ';',
      'const hg = require(' + JSON.stringify(hg) + ');',
      "fs.appendFileSync(RECORD, 'loaded\\n');",
      "if (MODE === 'null') hg.fixedGit = () => null;",
      "else if (MODE === 'win32') hg.fixedGit = () => hg.resolveGitPath(hg.gitCandidates('win32'));",
      "else if (MODE !== 'keep') hg.fixedGit = () => MODE;",
      'const original = cp.spawnSync;',
      'cp.spawnSync = function (file, ...rest) {',
      "  fs.appendFileSync(RECORD, 'spawn ' + String(file) + '\\n');",
      '  return original.call(this, file, ...rest);',
      '};',
      '',
    ].join('\n')
  );
  return {
    dir,
    preload,
    lines: () => (fs.existsSync(record) ? fs.readFileSync(record, 'utf8').split('\n').filter(Boolean) : []),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/** spawnHookWithEnv with NODE_OPTIONS --require <preload> layered on env (spawnHookWithEnv itself unchanged). */
function spawnPreloaded(stdin, { cwd, env = {}, preload }) {
  return spawnHookWithEnv(stdin, {
    cwd,
    env: Object.assign({}, env, { NODE_OPTIONS: '--require ' + JSON.stringify(preload.preload) }),
  });
}

/** The preload's record: asserts it loaded (A4) and returns the spawned files. */
function preloadSpawns(preload) {
  const lines = preload.lines();
  assert.ok(lines.includes('loaded'), 'the preload must have loaded: ' + JSON.stringify(lines));
  return lines.filter((l) => l.startsWith('spawn ')).map((l) => l.slice('spawn '.length));
}

/** Run fn with process.env.PATH set to value, restored afterwards (model: emitted-cjs-read.test.cjs withPath). */
function withPath28(value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'PATH');
  const saved = process.env.PATH;
  process.env.PATH = value;
  try {
    return fn();
  } finally {
    if (had) process.env.PATH = saved;
    else delete process.env.PATH;
  }
}

/** An executable `git` in dir that appends "ran <args>" to mark and exits 1. */
function markingGit(dir, mark) {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, 'git');
  fs.writeFileSync(p, '#!/bin/sh\necho "ran $*" >> ' + JSON.stringify(mark) + '\nexit 1\n');
  fs.chmodSync(p, 0o755);
  return p;
}

function markText(mark) {
  return fs.existsSync(mark) ? fs.readFileSync(mark, 'utf8') : '';
}

/**
 * An executable `git` in dir that logs, per spawn, its PATH, the lazy-fetch keys and every env-injected config
 * pair to log, then execs the listed git by absolute path. Shell builtins only (echo, printf, test, eval, exec),
 * because under the hardened probe its PATH is its own directory.
 */
function envLoggingGit(dir, log, realGit) {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, 'git');
  const L = JSON.stringify(log);
  fs.writeFileSync(
    p,
    [
      '#!/bin/sh',
      'echo BEGIN >> ' + L,
      'printf "PATH=%s\\n" "$PATH" >> ' + L,
      'printf "ALLOW=%s\\n" "${GIT_ALLOW_PROTOCOL-<unset>}" >> ' + L,
      'printf "NOLAZY=%s\\n" "${GIT_NO_LAZY_FETCH-<unset>}" >> ' + L,
      'printf "COUNT=%s\\n" "${GIT_CONFIG_COUNT-<unset>}" >> ' + L,
      'i=0',
      'while [ "$i" -lt "${GIT_CONFIG_COUNT:-0}" ]; do',
      '  eval "k=\\${GIT_CONFIG_KEY_$i-}; v=\\${GIT_CONFIG_VALUE_$i-}"',
      '  printf "PAIR=%s=%s\\n" "$k" "$v" >> ' + L,
      '  i=$((i + 1))',
      'done',
      'printf "PARAMS=%s\\n" "${GIT_CONFIG_PARAMETERS-<unset>}" >> ' + L,
      'exec ' + JSON.stringify(realGit) + ' "$@"',
      '',
    ].join('\n')
  );
  fs.chmodSync(p, 0o755);
  return p;
}

/** Parse envLoggingGit's log into one record per spawn. */
function readEnvLog(log) {
  if (!fs.existsSync(log)) return [];
  const spawns = [];
  for (const line of fs.readFileSync(log, 'utf8').split('\n')) {
    if (line === 'BEGIN') spawns.push({ pairs: [] });
    else if (spawns.length === 0 || line === '') continue;
    else {
      const cur = spawns[spawns.length - 1];
      const eq = line.indexOf('=');
      const key = line.slice(0, eq);
      const value = line.slice(eq + 1);
      if (key === 'PAIR') {
        const e2 = value.indexOf('=');
        cur.pairs.push([value.slice(0, e2), value.slice(e2 + 1)]);
      } else cur[key] = value;
    }
  }
  return spawns;
}

/** Assert every logged spawn saw the hardened env: lazy-fetch keys, PATH = wrapperDir, injected pairs last. */
function assertHardenedSpawnEnv(spawns, wrapperDir) {
  const hg = require('./lib/hardened-git.cjs');
  assert.ok(spawns.length >= 1, 'the wrapper must have been spawned at least once');
  for (const s of spawns) {
    assert.strictEqual(s.ALLOW, hg.NO_PROTOCOL, 'GIT_ALLOW_PROTOCOL names no transport');
    assert.strictEqual(s.NOLAZY, '1', 'GIT_NO_LAZY_FETCH=1');
    assert.strictEqual(s.PATH, wrapperDir, 'the spawned PATH is exactly the git directory');
    assert.strictEqual(String(s.pairs.length), s.COUNT, 'every counted pair was logged');
    assert.deepStrictEqual(
      s.pairs.slice(-2),
      [['core.fsmonitor', 'false'], ['safe.bareRepository', 'explicit']],
      'the injected pairs are the last two env-injected config pairs'
    );
    assert.ok(
      s.PARAMS.endsWith("'core.fsmonitor=false' 'safe.bareRepository=explicit'"),
      'the -c parameter list ends with the injected pairs: ' + s.PARAMS
    );
  }
}

function commit28(cwd, message) {
  fixtureGit(cwd, [
    '-c', 'user.name=binlib-test',
    '-c', 'user.email=binlib-test@example.invalid',
    '-c', 'commit.gpgsign=false',
    'commit', '-q', '-m', message,
  ]);
}

/**
 * A partial-clone fixture whose skip-worktree gsd-core/bin/.gitignore (rule lib/foo.cjs) blob is missing, with a
 * planted transport program that appends to mark and exits 1 (REVIEW-R3 CR-02; ported from
 * hooks/emitted-cjs-read.test.cjs armLazyFetch and r3-probes/p6-lazyfetch.cjs). layout 'root': git init at the
 * root; 'archive': the root .git is a FILE naming a gitdir shipped inside the tree. transport 'uploadpack'
 * (remote.origin.uploadpack, local URL) or 'ssh' (core.sshCommand, ssh:// URL). rootRule (default true) adds
 * a root .gitignore line /gsd-core/bin/lib/foo.cjs, a locally present rule; rootRule false leaves the missing blob
 * as the only rule (the blob-only layout, root layout only). Callers MUST cleanup() in finally.
 */
function makeLazyFixture(layout, transport, { rootRule = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'binlib-28y-lazy-'));
  try {
    const libDir = path.join(root, 'gsd-core', 'bin', 'lib');
    fs.mkdirSync(libDir, { recursive: true });
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    const target = path.join(libDir, 'foo.cjs');
    fs.writeFileSync(target, "'use strict';\n");
    fs.writeFileSync(path.join(root, 'src', 'foo.cts'), 'export {};\n');
    fs.writeFileSync(path.join(root, '.gitignore'), rootRule ? '/gsd-core/bin/lib/foo.cjs\n' : '');
    let gitdir;
    if (layout === 'archive') {
      gitdir = path.join(root, 'vendor-gitdir');
      fixtureGit(root, ['init', '-q', '--separate-git-dir', gitdir]);
      fixtureGit(root, ['add', '-A']);
    } else {
      gitdir = path.join(root, '.git');
      fixtureGit(root, ['init', '-q']);
      fixtureGit(root, ['add', '--', '.gitignore', 'src/foo.cts']);
    }
    commit28(root, 'fixture');
    const ig = 'gsd-core/bin/.gitignore';
    fs.writeFileSync(path.join(root, ig), 'lib/foo.cjs\n');
    fixtureGit(root, ['add', '-f', '--', ig]);
    commit28(root, 'ig');
    const oid = fixtureGit(root, ['rev-parse', ':' + ig]).stdout.trim();
    fixtureGit(root, ['update-index', '--skip-worktree', '--', ig]);
    fs.unlinkSync(path.join(root, ig));
    fs.unlinkSync(path.join(gitdir, 'objects', oid.slice(0, 2), oid.slice(2)));
    const mark = path.join(root, 'MARK');
    const prog = path.join(gitdir, transport === 'ssh' ? 'ssh.sh' : 'up.sh');
    fs.writeFileSync(prog, '#!/bin/sh\necho "' + transport + ' $*" >> ' + JSON.stringify(mark) + '\nexit 1\n');
    fs.chmodSync(prog, 0o755);
    fixtureGit(root, ['config', 'core.repositoryformatversion', '1']);
    fixtureGit(root, ['config', 'extensions.partialClone', 'origin']);
    fixtureGit(root, ['config', 'remote.origin.promisor', 'true']);
    fixtureGit(root, ['config', 'protocol.file.allow', 'always']);
    if (transport === 'ssh') {
      fixtureGit(root, ['config', 'remote.origin.url', 'ssh://example.invalid/x.git']);
      fixtureGit(root, ['config', 'core.sshCommand', prog]);
    } else {
      fixtureGit(root, ['config', 'remote.origin.url', gitdir]);
      fixtureGit(root, ['config', 'remote.origin.uploadpack', prog]);
    }
    return { root, libDir, target, gitdir, oid, mark, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
  } catch (err) {
    fs.rmSync(root, { recursive: true, force: true });
    throw err;
  }
}

/** Raw PATH git check-ignore from the target's directory, the way the 57bcc77 probe ran it (control rows). */
function rawCheckIgnore28(target, extraEnv = {}) {
  return spawnSync('git', ['check-ignore', '-q', '--', target], {
    cwd: path.dirname(target),
    env: Object.assign({}, FIXTURE_GIT_ENV, extraEnv),
    encoding: 'utf8',
  });
}

/** Is object oid present locally? Checked with lazy fetch off, so the check itself cannot fetch it. */
function objectPresent28(root, oid) {
  return spawnSync('git', ['cat-file', '-e', oid], {
    cwd: root,
    env: Object.assign({}, FIXTURE_GIT_ENV, { GIT_NO_LAZY_FETCH: '1' }),
    encoding: 'utf8',
  }).status === 0;
}

/**
 * R1 PLAN-REVIEW B-01 state (ported from probes/r1-measure3.cjs): the only rule gsd-core/bin/.gitignore =
 * lib/foo.cjs is committed, a bare server clone serves it (allowAnySHA1InWant, allowFilter), then the client makes
 * the rule skip-worktree, deletes its work-tree file and loose blob and becomes a partial clone of that honest
 * server. No planted program. Callers MUST cleanup() in finally.
 */
function makeHonestRemoteFixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'binlib-28y-honest-'));
  try {
    const root = path.join(base, 'client');
    const libDir = path.join(root, 'gsd-core', 'bin', 'lib');
    fs.mkdirSync(libDir, { recursive: true });
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    const target = path.join(libDir, 'foo.cjs');
    fs.writeFileSync(target, "'use strict';\n");
    fs.writeFileSync(path.join(root, 'src', 'foo.cts'), 'export {};\n');
    const ig = 'gsd-core/bin/.gitignore';
    fs.writeFileSync(path.join(root, ig), 'lib/foo.cjs\n');
    fixtureGit(root, ['init', '-q']);
    fixtureGit(root, ['add', '-f', '--', ig, 'src/foo.cts']);
    commit28(root, 'ig');
    const server = path.join(base, 'server.git');
    fixtureGit(base, ['clone', '-q', '--bare', root, server]);
    fixtureGit(server, ['config', 'uploadpack.allowAnySHA1InWant', 'true']);
    fixtureGit(server, ['config', 'uploadpack.allowFilter', 'true']);
    const oid = fixtureGit(root, ['rev-parse', ':' + ig]).stdout.trim();
    fixtureGit(root, ['update-index', '--skip-worktree', '--', ig]);
    fs.unlinkSync(path.join(root, ig));
    fs.unlinkSync(path.join(root, '.git', 'objects', oid.slice(0, 2), oid.slice(2)));
    fixtureGit(root, ['config', 'core.repositoryformatversion', '1']);
    fixtureGit(root, ['config', 'extensions.partialClone', 'origin']);
    fixtureGit(root, ['config', 'remote.origin.promisor', 'true']);
    fixtureGit(root, ['config', 'remote.origin.url', server]);
    fixtureGit(root, ['config', 'protocol.file.allow', 'always']);
    return { root, libDir, target, oid, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
  } catch (err) {
    fs.rmSync(base, { recursive: true, force: true });
    throw err;
  }
}

// CR-02 (REVIEW-R3): 2 layouts x 2 transports; each row has its own raw-git control (non-vacuous).
for (const layout of ['root', 'archive']) {
  for (const transport of ['uploadpack', 'ssh']) {
    test('28y CR-02: ' + layout + ' layout, ' + transport + ': a lazy fetch never runs the planted program on an Edit, and the ignored target denies', (t) => {
      const fx = makeLazyFixture(layout, transport);
      try {
        const ctl = rawCheckIgnore28(fx.target);
        t.diagnostic('control raw git check-ignore exit=' + ctl.status + ' (' + layout + ', ' + transport + ')');
        assert.ok(fs.existsSync(fx.mark), 'control: raw git lazily fetches and runs the planted program (exit ' + ctl.status + ')');
        fs.rmSync(fx.mark);
        const r = spawnHookWithEnv(input(fx.target, 'Edit', fx.root), { cwd: fx.root });
        assert.strictEqual(markText(fx.mark), '', 'the planted program must not run through the hook');
        assert.strictEqual(r.decision, 'deny', r.reason);
        assert.ok(r.reason.startsWith(binLibDenyReason(fx.target)), r.reason);
        t.diagnostic('hook reason undecidable=' + UNDECIDABLE.test(r.reason));
      } finally {
        fx.cleanup();
      }
    });
  }
}

// CR-01 POSIX analog (REVIEW-R3 CR-01, SECURITY-AUDIT-R1 LOW-01, REVIEW-R3 IN-01): a PATH entry that resolves to the
// target's own bin/lib, which holds an executable git, never reaches the probe; the listed git answers.
for (const [label, entry] of [
  ['an empty PATH entry', () => ''],
  ['a "." PATH entry', () => '.'],
  ['an absolute PATH entry naming the target bin/lib', (fx) => fx.libDir],
]) {
  test('28y CR-01: ' + label + ' cannot run a planted git beside the target; the tracked file is allowed', (t) => {
    const lg = listedGit28();
    if (!lg) return t.skip(NO_LISTED_GIT_28);
    const fx = makeFixtureRepo();
    const mark = path.join(fx.root, 'PLANTED-MARK');
    try {
      markingGit(fx.libDir, mark);
      const r = spawnHookWithEnv(input(fx.tracked, 'Edit', fx.root), {
        cwd: fx.root,
        env: { PATH: entry(fx) + path.delimiter + path.dirname(lg) },
      });
      assert.strictEqual(markText(mark), '', 'the planted git must not run');
      assert.strictEqual(r.decision, 'allow', r.reason);
    } finally {
      fx.cleanup();
    }
  });
}

test('28y spawn record: every git the spawned hook runs is an absolute GIT_CANDIDATES entry, never the bare name', (t) => {
  if (!listedGit28()) return t.skip(NO_LISTED_GIT_28);
  const { GIT_CANDIDATES } = require('./lib/hardened-git.cjs');
  const fx = makeFixtureRepo();
  const pre = writePreload('keep');
  try {
    const r = spawnPreloaded(input(fx.ignored, 'Edit', fx.root), { cwd: fx.root, preload: pre });
    const files = preloadSpawns(pre);
    assert.ok(files.length >= 1, 'the probe spawned git');
    for (const f of files) {
      assert.ok(path.isAbsolute(f) && GIT_CANDIDATES.includes(f), 'spawned file ' + JSON.stringify(f) + ' must be a listed absolute git');
    }
    assert.strictEqual(r.decision, 'deny');
    assert.strictEqual(r.reason, binLibDenyReason(fx.ignored));
  } finally {
    pre.cleanup();
    fx.cleanup();
  }
});

test('28y no candidate: with fixedGit resolving gitCandidates(win32) nothing is spawned and even the tracked file is the undecidable deny', () => {
  const fx = makeFixtureRepo();
  const pre = writePreload('win32');
  try {
    const r = spawnPreloaded(input(fx.tracked, 'Edit', fx.root), { cwd: fx.root, preload: pre });
    assert.deepStrictEqual(preloadSpawns(pre), [], 'no git may be spawned without a fixed git');
    assertUndecidableDeny(r.decision, r.reason, fx.tracked);
  } finally {
    pre.cleanup();
    fx.cleanup();
  }
});

test('28y IN-01: checkIgnoreLive with an own gitPath key holding undefined answers unknown and spawns no PATH git', () => {
  const { checkIgnoreLive } = require('./binlib-edit.cjs');
  const fx = makeFixtureRepo();
  const planted = fs.mkdtempSync(path.join(os.tmpdir(), 'binlib-28y-pathgit-'));
  const mark = path.join(planted, 'mark');
  try {
    markingGit(planted, mark);
    const verdict = withPath28(planted + path.delimiter + process.env.PATH,
      () => withIsolatedGitConfig(() => checkIgnoreLive(fx.ignored, { gitPath: undefined })));
    assert.strictEqual(markText(mark), '', 'the planted PATH git must not run');
    assert.strictEqual(verdict, 'unknown');
  } finally {
    fs.rmSync(planted, { recursive: true, force: true });
    fx.cleanup();
  }
});

test('28y IN-01: checkIgnoreLive with no options spawns the fixed git, not a planted PATH git, and answers ignored', (t) => {
  if (!listedGit28()) return t.skip(NO_LISTED_GIT_28);
  const { checkIgnoreLive } = require('./binlib-edit.cjs');
  const fx = makeFixtureRepo();
  const planted = fs.mkdtempSync(path.join(os.tmpdir(), 'binlib-28y-pathgit-'));
  const mark = path.join(planted, 'mark');
  try {
    markingGit(planted, mark);
    const verdict = withPath28(planted + path.delimiter + process.env.PATH,
      () => withIsolatedGitConfig(() => checkIgnoreLive(fx.ignored)));
    assert.strictEqual(markText(mark), '', 'the planted PATH git must not run');
    assert.strictEqual(verdict, 'ignored');
  } finally {
    fs.rmSync(planted, { recursive: true, force: true });
    fx.cleanup();
  }
});

test('28y D6b: a PATH that names no git no longer decides; the listed git allows the tracked file', (t) => {
  if (!listedGit28()) return t.skip(NO_LISTED_GIT_28);
  const fx = makeFixtureRepo();
  const emptyBin = fs.mkdtempSync(path.join(os.tmpdir(), 'binlib-28y-nogit-'));
  try {
    const r = spawnHookWithEnv(input(fx.tracked, 'Edit', fx.root), { cwd: fx.root, env: { PATH: emptyBin } });
    assert.strictEqual(r.decision, 'allow', r.reason);
  } finally {
    fs.rmSync(emptyBin, { recursive: true, force: true });
    fx.cleanup();
  }
});

test('28y env record: checkIgnoreLive with an absolute gitPath spawns it with the hardened env and leaves process.env unchanged', (t) => {
  const lg = listedGit28();
  if (!lg) return t.skip(NO_LISTED_GIT_28);
  const { checkIgnoreLive } = require('./binlib-edit.cjs');
  const fx = makeFixtureRepo();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'binlib-28y-envlog-'));
  const log = path.join(dir, 'env.log');
  try {
    const wrapperDir = path.join(dir, 'bin');
    const wrapper = envLoggingGit(wrapperDir, log, lg);
    const verdict = withIsolatedGitConfig(() => {
      const before = Object.assign({}, process.env);
      const v = checkIgnoreLive(fx.ignored, { gitPath: wrapper });
      assert.deepStrictEqual(Object.assign({}, process.env), before, 'process.env must not change');
      return v;
    });
    assertHardenedSpawnEnv(readEnvLog(log), wrapperDir);
    assert.strictEqual(verdict, 'ignored');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fx.cleanup();
  }
});

test('28y env record, default branch: the gate\'s own call (no options) spawns fixedGit with PATH = its directory and the hardened env (R1 I2 W-01)', (t) => {
  const lg = listedGit28();
  if (!lg) return t.skip(NO_LISTED_GIT_28);
  const fx = makeFixtureRepo();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'binlib-28y-envlog-'));
  const log = path.join(dir, 'env.log');
  const wrapperDir = path.join(dir, 'bin');
  const wrapper = envLoggingGit(wrapperDir, log, lg);
  const pre = writePreload(wrapper);
  try {
    const r = spawnPreloaded(input(fx.ignored, 'Edit', fx.root), { cwd: fx.root, preload: pre });
    preloadSpawns(pre);
    assertHardenedSpawnEnv(readEnvLog(log), wrapperDir);
    assert.strictEqual(r.decision, 'deny');
    assert.strictEqual(r.reason, binLibDenyReason(fx.ignored));
  } finally {
    pre.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
    fx.cleanup();
  }
});

test('28y D8 honest remote: a blob-only partial clone served by an honest remote is the undecidable deny with no fetch', () => {
  const fx = makeHonestRemoteFixture();
  try {
    assert.strictEqual(objectPresent28(fx.root, fx.oid), false, 'precondition: the rule blob is missing locally');
    const r = spawnHookWithEnv(input(fx.target, 'Edit', fx.root), { cwd: fx.root });
    assertUndecidableDeny(r.decision, r.reason, fx.target);
    assert.strictEqual(objectPresent28(fx.root, fx.oid), false, 'the hook must not fetch the missing blob');
  } finally {
    fx.cleanup();
  }
});

test('28y D7 corrected: a blob-only partial clone with a failing planted remote is the undecidable deny and runs nothing', (t) => {
  const fx = makeLazyFixture('root', 'uploadpack', { rootRule: false });
  try {
    const ctl = rawCheckIgnore28(fx.target);
    t.diagnostic('control raw git check-ignore exit=' + ctl.status);
    assert.ok(fs.existsSync(fx.mark), 'control: raw git lazily fetches and runs the planted uploadpack');
    fs.rmSync(fx.mark);
    const r = spawnHookWithEnv(input(fx.target, 'Edit', fx.root), { cwd: fx.root });
    assert.strictEqual(markText(fx.mark), '', 'the planted program must not run through the hook');
    assertUndecidableDeny(r.decision, r.reason, fx.target);
  } finally {
    fx.cleanup();
  }
});

test('28y fsmonitor: a core.fsmonitor command in the fixture .git/config never runs on an Edit of the emitted or the tracked file', (t) => {
  if (!listedGit28()) return t.skip(NO_LISTED_GIT_28);
  const fx = makeFixtureRepo();
  const mark = path.join(fx.root, 'FSMONITOR-MARK');
  try {
    fixtureGit(fx.root, ['config', 'core.fsmonitor', 'echo own >> ' + JSON.stringify(mark) + ' #']);
    rawCheckIgnore28(fx.ignored);
    assert.ok(fs.existsSync(mark), 'control: raw git runs the repository fsmonitor command');
    fs.rmSync(mark);
    const e = spawnHookWithEnv(input(fx.ignored, 'Edit', fx.root), { cwd: fx.root });
    assert.strictEqual(markText(mark), '', 'the fsmonitor command must not run on the emitted Edit');
    assert.strictEqual(e.decision, 'deny');
    assert.strictEqual(e.reason, binLibDenyReason(fx.ignored));
    const k = spawnHookWithEnv(input(fx.tracked, 'Edit', fx.root), { cwd: fx.root });
    assert.strictEqual(markText(mark), '', 'the fsmonitor command must not run on the tracked Edit');
    assert.strictEqual(k.decision, 'allow', k.reason);
  } finally {
    fx.cleanup();
  }
});

test('28y fsmonitor: an inherited -c core.fsmonitor command never runs on an Edit of the tracked file', (t) => {
  if (!listedGit28()) return t.skip(NO_LISTED_GIT_28);
  const fx = makeFixtureRepo();
  const mark = path.join(fx.root, 'FSMONITOR-ENV-MARK');
  try {
    const params = { GIT_CONFIG_PARAMETERS: "'core.fsmonitor=echo env >> " + JSON.stringify(mark) + " #'" };
    rawCheckIgnore28(fx.tracked, params);
    assert.ok(fs.existsSync(mark), 'control: raw git runs the inherited -c fsmonitor command');
    fs.rmSync(mark);
    const r = spawnHookWithEnv(input(fx.tracked, 'Edit', fx.root), { cwd: fx.root, env: params });
    assert.strictEqual(markText(mark), '', 'the inherited -c fsmonitor command must not run');
    assert.strictEqual(r.decision, 'allow', r.reason);
  } finally {
    fx.cleanup();
  }
});

// D9 (R1 I2 W-03, DESIGN Amendment 2): a GREEN-phase guard row, not RED (at 57bcc77 the allow already holds).
test('28y-guard D9: an inherited GIT_TRACE=1 or GIT_TRACE2=1 keeps the tracked-file allow (trace output is not a D8 non-answer)', (t) => {
  if (!listedGit28()) return t.skip(NO_LISTED_GIT_28);
  const fx = makeFixtureRepo();
  try {
    for (const env of [{ GIT_TRACE: '1' }, { GIT_TRACE2: '1' }]) {
      const r = spawnHookWithEnv(input(fx.tracked, 'Edit', fx.root), { cwd: fx.root, env });
      assert.strictEqual(r.decision, 'allow', JSON.stringify(env) + ': ' + r.reason);
    }
  } finally {
    fx.cleanup();
  }
});

// --- quick 261120-28y fix round 2 (FIX-PLAN-R2 as amended by its R1 dispositions): rows tagged "28y-r2" ---------
// Round-1 security review CR-02 (replace refs), WR-02 (inherited exec path), WR-03 (trace2 targets in git config),
// IN-01 (the single-file git config variable). Appended only; every helper below is a new function declaration whose
// name no earlier top-level declaration uses (PLAN-REVIEW-R2 W-04, R2-I2 N-02).

/** The env keys the round-2 wrapper records for every spawn. */
function r2EnvKeys() {
  return ['GIT_NO_REPLACE_OBJECTS', 'GIT_TRACE2', 'GIT_TRACE2_EVENT', 'GIT_TRACE2_PERF', 'GIT_EXEC_PATH', 'GIT_CONFIG'];
}

/**
 * An executable `git` in dir that appends, per spawn, "BEGIN" and one KEY=value line for each r2EnvKeys() key
 * (value "<unset>" when the key is absent) to log, then execs realGit by absolute path. Shell builtins only.
 */
function envRecordR2(dir, log, realGit) {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, 'git');
  const L = JSON.stringify(log);
  const lines = ['#!/bin/sh', 'echo BEGIN >> ' + L];
  for (const k of r2EnvKeys()) lines.push('printf "' + k + '=%s\\n" "${' + k + '-<unset>}" >> ' + L);
  lines.push('exec ' + JSON.stringify(realGit) + ' "$@"', '');
  fs.writeFileSync(p, lines.join('\n'));
  fs.chmodSync(p, 0o755);
  return p;
}

/** envRecordR2's log as one { KEY: value } record per spawn. */
function readEnvR2(log) {
  if (!fs.existsSync(log)) return [];
  const spawns = [];
  for (const line of fs.readFileSync(log, 'utf8').split('\n')) {
    if (line === 'BEGIN') spawns.push({});
    else if (line !== '' && spawns.length > 0) {
      const eq = line.indexOf('=');
      spawns[spawns.length - 1][line.slice(0, eq)] = line.slice(eq + 1);
    }
  }
  return spawns;
}

/** Every recorded spawn refuses replace objects, has trace2 off, and carries no exec path or single-file config. */
function assertR2SpawnEnv(spawns) {
  assert.ok(spawns.length >= 1, 'the recording wrapper must have been spawned at least once');
  for (const s of spawns) {
    assert.strictEqual(s.GIT_NO_REPLACE_OBJECTS, '1', 'GIT_NO_REPLACE_OBJECTS=1 (CR-02): ' + JSON.stringify(s));
    assert.strictEqual(s.GIT_TRACE2, '0', 'GIT_TRACE2=0 (WR-03): ' + JSON.stringify(s));
    assert.strictEqual(s.GIT_TRACE2_EVENT, '0', 'GIT_TRACE2_EVENT=0 (WR-03): ' + JSON.stringify(s));
    assert.strictEqual(s.GIT_TRACE2_PERF, '0', 'GIT_TRACE2_PERF=0 (WR-03): ' + JSON.stringify(s));
    assert.strictEqual(s.GIT_EXEC_PATH, '<unset>', 'an inherited exec path is dropped (WR-02): ' + JSON.stringify(s));
    assert.strictEqual(s.GIT_CONFIG, '<unset>', 'an inherited single-file git config is dropped (IN-01): ' + JSON.stringify(s));
  }
}

/** The listed git's own exec path, so an inherited value that names it leaves every verdict as it was. */
function execPathR2(lg) {
  const r = spawnSync(lg, ['--exec-path'], { env: FIXTURE_GIT_ENV, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, 'git --exec-path: ' + r.stderr);
  return r.stdout.trim();
}

/** Run fn with the given keys set in process.env (the in-process probes read it), restored afterwards. */
function withEnvR2(over, fn) {
  const saved = {};
  for (const k of Object.keys(over)) {
    saved[k] = Object.prototype.hasOwnProperty.call(process.env, k) ? process.env[k] : undefined;
    process.env[k] = over[k];
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

/**
 * REVIEW CR-02 block F4: the only rule for gsd-core/bin/lib/gen.cjs lives in a committed gsd-core/bin/.gitignore
 * whose index entry is skip-worktree and whose work-tree file is absent; a replace ref swaps its blob for a rule-less
 * blob. Nothing is missing from the object store. Callers MUST cleanup() in finally.
 */
function makeReplaceFixtureR2() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'binlib-28y-r2-replace-'));
  try {
    const libDir = path.join(root, 'gsd-core', 'bin', 'lib');
    fs.mkdirSync(libDir, { recursive: true });
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    const target = path.join(libDir, 'gen.cjs');
    fs.writeFileSync(target, "'use strict';\n");
    fs.writeFileSync(path.join(root, 'src', 'gen.cts'), 'export {};\n');
    const ig = 'gsd-core/bin/.gitignore';
    fs.writeFileSync(path.join(root, ig), 'lib/gen.cjs\n');
    fixtureGit(root, ['init', '-q']);
    fixtureGit(root, ['add', '--', ig, 'src/gen.cts']);
    commit28(root, 'rule');
    const ruleOid = fixtureGit(root, ['rev-parse', ':' + ig]).stdout.trim();
    fixtureGit(root, ['update-index', '--skip-worktree', '--', ig]);
    fs.unlinkSync(path.join(root, ig));
    const noRule = path.join(root, '.git', 'r2-no-rule.txt');
    fs.writeFileSync(noRule, '# no rule\n');
    const noRuleOid = fixtureGit(root, ['hash-object', '-w', '--', noRule]).stdout.trim();
    fixtureGit(root, ['replace', ruleOid, noRuleOid]);
    return { root, libDir, target, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
  } catch (err) {
    fs.rmSync(root, { recursive: true, force: true });
    throw err;
  }
}

test('28y-r2 replace (CR-02, D6h): a replace ref that swaps the skip-worktree rule blob no longer un-ignores the generated file: Edit denied, Read-guard probe ignored', (t) => {
  if (!listedGit28()) return t.skip(NO_LISTED_GIT_28);
  const fx = makeReplaceFixtureR2();
  try {
    const ctl = rawCheckIgnore28(fx.target);
    assert.strictEqual(ctl.status, 1, 'control: raw git follows the replace ref and reports not ignored');
    assert.strictEqual(ctl.stderr, '', 'control: with empty stderr, so D8 alone cannot catch it');
    const real = rawCheckIgnore28(fx.target, { GIT_NO_REPLACE_OBJECTS: '1' });
    assert.strictEqual(real.status, 0, 'control: the real rule blob ignores the target');
    const r = spawnHookWithEnv(input(fx.target, 'Edit', fx.root), { cwd: fx.root });
    assert.strictEqual(r.decision, 'deny', r.reason);
    assert.strictEqual(r.reason, binLibDenyReason(fx.target));
    const { checkIgnorePinned } = require('./emitted-cjs-read.cjs');
    assert.strictEqual(withIsolatedGitConfig(() => checkIgnorePinned(fx.target)), 'ignored', 'the Read guard probe answers ignored too');
  } finally {
    fx.cleanup();
  }
});

test('28y-r2 trace2 config (WR-03, D6i): trace2 targets on stderr in the global git config keep the tracked file allowed and the emitted file plainly denied', (t) => {
  if (!listedGit28()) return t.skip(NO_LISTED_GIT_28);
  const fx = makeFixtureRepo();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'binlib-28y-r2-trace2-'));
  try {
    const cfg = path.join(dir, 'gitconfig');
    fs.writeFileSync(cfg, '[trace2]\n\tnormalTarget = 2\n\teventTarget = 2\n\tperfTarget = 2\n');
    const env = { GIT_CONFIG_GLOBAL: cfg };
    const ctl = rawCheckIgnore28(fx.tracked, env);
    assert.strictEqual(ctl.status, 1, 'control: raw git answers not ignored for the tracked file');
    assert.ok(ctl.stderr.length > 0, 'control: the config trace2 targets write to stderr');
    const k = spawnHookWithEnv(input(fx.tracked, 'Edit', fx.root), { cwd: fx.root, env });
    assert.strictEqual(k.decision, 'allow', k.reason);
    const e = spawnHookWithEnv(input(fx.ignored, 'Edit', fx.root), { cwd: fx.root, env });
    assert.strictEqual(e.decision, 'deny');
    assert.strictEqual(e.reason, binLibDenyReason(fx.ignored));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fx.cleanup();
  }
});

test('28y-r2 D6k (IN-01): an inherited single-file git config no longer blinds the core.worktree pin (undecidable deny, Read-guard probe unknown) or makes git refuse (tracked file allowed)', (t) => {
  if (!listedGit28()) return t.skip(NO_LISTED_GIT_28);
  const fx = makeFixtureRepo();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'binlib-28y-r2-single-'));
  try {
    const malformed = path.join(dir, 'malformed.cfg');
    fs.writeFileSync(malformed, '[core\n');
    const m = spawnHookWithEnv(input(fx.tracked, 'Edit', fx.root), { cwd: fx.root, env: { GIT_CONFIG: malformed } });
    assert.strictEqual(m.decision, 'allow', 'a malformed inherited single-file config no longer makes the pin probe refuse: ' + m.reason);

    fixtureGit(fx.root, ['config', 'core.worktree', path.dirname(fx.root)]);
    const ctl = spawnHookWithEnv(input(fx.ignored, 'Edit', fx.root), { cwd: fx.root });
    assertUndecidableDeny(ctl.decision, ctl.reason, fx.ignored);
    const r = spawnHookWithEnv(input(fx.ignored, 'Edit', fx.root), { cwd: fx.root, env: { GIT_CONFIG: '/dev/null' } });
    assertUndecidableDeny(r.decision, r.reason, fx.ignored);
    const { checkIgnorePinned } = require('./emitted-cjs-read.cjs');
    const v = withEnvR2({ GIT_CONFIG: '/dev/null' }, () => withIsolatedGitConfig(() => checkIgnorePinned(fx.ignored)));
    assert.strictEqual(v, 'unknown', 'the Read-guard probe sees the core.worktree pin fail (silent pass)');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fx.cleanup();
  }
});

test('28y-r2 env record, default branch (WR-02, IN-01, CR-02, WR-03): the gate\'s own call spawns git with replace objects refused, trace2 off, and no inherited exec path or single-file config', (t) => {
  const lg = listedGit28();
  if (!lg) return t.skip(NO_LISTED_GIT_28);
  const fx = makeFixtureRepo();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'binlib-28y-r2-envrec-'));
  const log = path.join(dir, 'env.log');
  const wrapper = envRecordR2(path.join(dir, 'bin'), log, lg);
  const pre = writePreload(wrapper);
  try {
    const r = spawnPreloaded(input(fx.ignored, 'Edit', fx.root), {
      cwd: fx.root,
      preload: pre,
      env: { GIT_EXEC_PATH: execPathR2(lg), GIT_CONFIG: '/dev/null' },
    });
    preloadSpawns(pre);
    assertR2SpawnEnv(readEnvR2(log));
    assert.strictEqual(r.decision, 'deny');
    assert.strictEqual(r.reason, binLibDenyReason(fx.ignored));
  } finally {
    pre.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
    fx.cleanup();
  }
});
