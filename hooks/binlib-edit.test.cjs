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

test('BINLIB-03: git MISSING from PATH → spawned hook denies even the TRACKED file, with the note', () => {
  const fx = makeFixtureRepo();
  const emptyBin = fs.mkdtempSync(path.join(os.tmpdir(), 'binlib-nogit-'));
  try {
    const r = spawnHookWithEnv(input(fx.tracked, 'Edit', fx.root), {
      cwd: fx.root,
      env: { PATH: emptyBin },
    });
    assertUndecidableDeny(r.decision, r.reason, fx.tracked);
  } finally {
    fs.rmSync(emptyBin, { recursive: true, force: true });
    fx.cleanup();
  }
});

test('BINLIB-03: git HANGS past the probe timeout → spawned hook denies the TRACKED file, with the note, under 10 s', () => {
  const fx = makeFixtureRepo();
  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'binlib-hang-'));
  try {
    const shim = path.join(shimDir, 'git');
    // exec is required: a grandchild sleep holding the stderr pipe would keep spawnSync
    // waiting past its timeout.
    fs.writeFileSync(shim, '#!/bin/sh\nexec sleep 30\n');
    fs.chmodSync(shim, 0o755);
    const r = spawnHookWithEnv(input(fx.tracked, 'Edit', fx.root), {
      cwd: fx.root,
      env: { PATH: shimDir + path.delimiter + process.env.PATH },
    });
    assertUndecidableDeny(r.decision, r.reason, fx.tracked);
    assert.ok(r.ms < 10000, 'hook took ' + r.ms + ' ms (must stay under the 10 s hook timeout)');
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
