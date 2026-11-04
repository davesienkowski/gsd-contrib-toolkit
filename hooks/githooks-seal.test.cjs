'use strict';

/**
 * node:test for hooks/githooks-seal.cjs (ENF-12 --no-verify flag-not-text +
 * ENF-13 core.hooksPath=.githooks, HARD-01/04 fail-closed).
 *
 * Driven via the injectable runGithooksGate(stdinString, deps) seam: the worktree's
 * git config core.hooksPath value (and the worktree root) are INJECTED, so the unit
 * suite is hermetic (no real git config reads, no filesystem).
 *
 * Coverage (plan <behavior>):
 *   - real --no-verify / -n flag on commit|push → DENY (ENF-12)
 *   - the literal "--no-verify" inside a -m MESSAGE → NOT denied for the flag (EP-3)
 *   - hooksPath unset / != .githooks → DENY (ENF-13) with the fix command
 *   - clean commit/push (no flag, hooksPath=.githooks) → ALLOW
 *   - non-git / git-read (status, log) → ALLOW (no-op)
 *   - unparseable command → fail-closed DENY (HARD-04)
 *   - a config-read throw → fail-closed DENY (HARD-01), override-escapable (HARD-03)
 */

require('./lib/test-isolate.cjs').isolateToolLog(); // never the real ~/.gsd-contrib tool log (quick 261024-po0)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { runGithooksGate } = require('./githooks-seal.cjs');

function input(command) {
  return JSON.stringify({ tool_name: 'Bash', tool_input: { command } });
}

// Default deps: a clean worktree whose core.hooksPath IS .githooks, no override.
function deps(over = {}) {
  return Object.assign(
    {
      worktreeRoot: '/tmp/wt',
      readHooksPath: () => '.githooks',
      overrideImpl: { checkOverride: () => ({ override: false }), writeReceipt: () => {} },
    },
    over
  );
}

test('git commit --no-verify -m "x" → deny (ENF-12 real flag)', () => {
  const d = runGithooksGate(input('git commit --no-verify -m "x"'), deps());
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /no-verify/);
});

test('git push --no-verify → deny (ENF-12)', () => {
  const d = runGithooksGate(input('git push --no-verify'), deps());
  assert.strictEqual(d.permissionDecision, 'deny');
});

test('git commit -n -m x → deny (ENF-12 short alias)', () => {
  const d = runGithooksGate(input('git commit -n -m x'), deps());
  assert.strictEqual(d.permissionDecision, 'deny');
});

test('git commit -m "remember: never use --no-verify" → NOT denied for the flag (EP-3)', () => {
  // hooksPath=.githooks so the ONLY thing that could deny is the (absent) flag.
  const d = runGithooksGate(
    input('git commit -m "remember: never use --no-verify"'),
    deps()
  );
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

test('git commit (clean) but hooksPath unset → deny (ENF-13) with the fix command', () => {
  const d = runGithooksGate(input('git commit -m x'), deps({ readHooksPath: () => null }));
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /hooksPath/);
  assert.match(d.permissionDecisionReason, /\.githooks/);
});

test('git push but hooksPath is a WRONG value → deny (ENF-13)', () => {
  const d = runGithooksGate(input('git push'), deps({ readHooksPath: () => '.husky' }));
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /hooksPath/);
});

test('git commit -m x with hooksPath=.githooks and no flag → allow', () => {
  const d = runGithooksGate(input('git commit -m x'), deps());
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

test('git push with hooksPath=.githooks and no flag → allow', () => {
  const d = runGithooksGate(input('git push origin fix/12'), deps());
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

test('hooksPath with surrounding whitespace (.githooks\\n) → allow (trimmed)', () => {
  const d = runGithooksGate(input('git commit -m x'), deps({ readHooksPath: () => '.githooks\n' }));
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

test('non-git command (ls) → allow (no-op)', () => {
  const d = runGithooksGate(input('ls -la'), deps({ readHooksPath: () => null }));
  assert.strictEqual(d.permissionDecision, 'allow');
});

test('git status (read) → allow (no-op, not commit/push)', () => {
  const d = runGithooksGate(input('git status'), deps({ readHooksPath: () => null }));
  assert.strictEqual(d.permissionDecision, 'allow');
});

test('git log (read) → allow (no-op)', () => {
  const d = runGithooksGate(input('git log --oneline'), deps({ readHooksPath: () => null }));
  assert.strictEqual(d.permissionDecision, 'allow');
});

test('--no-verify flag is checked BEFORE hooksPath (deny even if hooksPath ok)', () => {
  const d = runGithooksGate(input('git commit --no-verify -m x'), deps());
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /no-verify/);
});

test('unparseable command → fail-closed deny (HARD-04)', () => {
  const d = runGithooksGate(input('git commit -m "unterminated'), deps());
  assert.strictEqual(d.permissionDecision, 'deny');
});

test('malformed stdin JSON → fail-closed deny (HARD-01)', () => {
  const d = runGithooksGate('{not json', deps());
  assert.strictEqual(d.permissionDecision, 'deny');
});

test('a config-read throw on a commit → fail-closed deny (HARD-01)', () => {
  const d = runGithooksGate(
    input('git commit -m x'),
    deps({
      readHooksPath: () => {
        throw new Error('git config unavailable');
      },
    })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
});

test('a config-read throw WITH a logged override → allow (HARD-03)', () => {
  const d = runGithooksGate(
    input('git commit -m x'),
    deps({
      readHooksPath: () => {
        throw new Error('git config unavailable');
      },
      overrideImpl: {
        checkOverride: () => ({ override: true, reason: 'transient git config failure' }),
        writeReceipt: () => '/tmp/wt/.gsd-contrib/override-receipts.log',
      },
    })
  );
  assert.strictEqual(d.permissionDecision, 'allow');
});

test('a chained commit hiding --no-verify (git add . && git commit --no-verify) → deny', () => {
  const d = runGithooksGate(input('git add . && git commit --no-verify -m x'), deps());
  assert.strictEqual(d.permissionDecision, 'deny');
});

// --- ENF-12 segment scoping (EP-3 sibling: my-segment vs a neighbor's) -------------
// The flag-not-text rule already stopped `-m "…--no-verify…"` from matching. The same
// false-positive class survived on a second axis: a NEIGHBOR segment in the chain that
// legitimately carries `-n`. `grep -n` / `sed -n` / `tail -n` / `sort -n` are ubiquitous
// next to a commit, and denying them is exactly the trust-eroding false deny (red-team
// H-B) that gets the toolkit switched off.

test('a commit chained with grep -n → allow (the -n belongs to grep, not git)', () => {
  const d = runGithooksGate(input('git commit -m x && grep -n foo bar.txt'), deps());
  assert.strictEqual(d.permissionDecision, 'allow');
});

test('a commit chained with sed -n → allow', () => {
  const d = runGithooksGate(input("git commit -m x && sed -n '1,5p' file.txt"), deps());
  assert.strictEqual(d.permissionDecision, 'allow');
});

test('a commit chained with tail -n / sort -n → allow', () => {
  assert.strictEqual(
    runGithooksGate(input('git commit -m x && tail -n 5 log.txt'), deps()).permissionDecision,
    'allow'
  );
  assert.strictEqual(
    runGithooksGate(input('git commit -m x && sort -n nums.txt'), deps()).permissionDecision,
    'allow'
  );
});

test('a neighbor -n BEFORE the commit → allow (position must not matter)', () => {
  const d = runGithooksGate(input('grep -n foo bar.txt && git commit -m x'), deps());
  assert.strictEqual(d.permissionDecision, 'allow');
});

test('git commit --amend --no-edit → allow (--no-edit is not --no-verify)', () => {
  const d = runGithooksGate(input('git commit --amend --no-edit'), deps());
  assert.strictEqual(d.permissionDecision, 'allow');
});

// Narrowing the scan must NOT weaken the seal: the real flag still denies wherever the
// sealed segment sits in the chain, and a benign neighbor must not launder it.
test('scoping does not weaken: real -n on the commit, beside a benign grep -n → deny', () => {
  const d = runGithooksGate(input('grep -n foo bar.txt && git commit -n -m x'), deps());
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /no-verify/);
});

test('scoping does not weaken: --no-verify on a LATER push segment → deny', () => {
  const d = runGithooksGate(input('git commit -m x && git push --no-verify'), deps());
  assert.strictEqual(d.permissionDecision, 'deny');
});

// quick-261007-tz0 F10 (locked decision): githooks-seal is a hook-bypass control, not an
// upstream-contribution control, so it keeps arming on a push to a fork or the backup remote and
// never looks the push target up.
test('F10 guard: githooks-seal stays armed on a fork push (--no-verify and an unset hooksPath) -> deny, zero lookups', () => {
  const calls = { dirs: 0, lookups: 0 };
  const lookups = {
    segmentDirs: () => {
      calls.dirs += 1;
      return ['/tmp/wt'];
    },
    resolvePushUrls: () => {
      calls.lookups += 1;
      return ['https://github.com/davesienkowski/gsd-core-sandbox.git'];
    },
  };
  const a = runGithooksGate(input('git push --no-verify backup fix/x'), deps(lookups));
  assert.strictEqual(a.permissionDecision, 'deny');
  assert.match(a.permissionDecisionReason, /no-verify/);
  const b = runGithooksGate(input('git push backup fix/x'), deps(Object.assign({ readHooksPath: () => '' }, lookups)));
  assert.strictEqual(b.permissionDecision, 'deny');
  assert.strictEqual(calls.dirs, 0);
  assert.strictEqual(calls.lookups, 0);
});

// --- ENF-13 behind a session hooks dispatcher (quick 261103-uqe) --------------------
// Real git, real env keys, real directories, the hook as a spawned process. The private
// dispatcher's bytes are not vendored: the fixture delegate keeps only the path the allow
// depends on, and passing a delegation canary is all the gate asks of it.

// path.join(__dirname, ...) so a mutation proof can run this test on a copy of hooks/.
const SEAL_HOOK = path.join(__dirname, 'githooks-seal.cjs');
const CANARY_PREFIX = 'githooks-seal-canary-';
const REPO_HOOK_MARKER = 'repo-hook-ran';

const DISPATCH_STUB = '#!/bin/sh\nexec sh "$(dirname "$0")/_delegate.sh" "$(basename "$0")" "$@"\n';
const DISPATCH_DELEGATE = [
  '#!/bin/sh',
  'name=${1:-}',
  '[ "$#" -gt 0 ] && shift',
  'self=$(cd -P "$(dirname "$0")" 2>/dev/null && pwd -P) || exit 0',
  'hooks=$( (unset GIT_CONFIG_COUNT; git rev-parse --path-format=absolute --git-path hooks) 2>/dev/null) || exit 0',
  'real=$(cd -P "$hooks" 2>/dev/null && pwd -P) || exit 0',
  '[ "$real" = "$self" ] && exit 0',
  'target="$real/$name"',
  'if [ -f "$target" ] && [ -x "$target" ]; then exec "$target" "$@"; fi',
  'exit 0',
  '',
].join('\n');
const FIXTURE_REPO_HOOK = `#!/bin/sh\n: > ${REPO_HOOK_MARKER}\nexit 1\n`;

function scratchDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** process.env with the host's git keys and the override valve gone, and no host git config. */
function hostFreeEnv() {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !/^GIT_/.test(k) && k !== 'GSD_CONTRIB_OVERRIDE')
  );
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = '/dev/null';
  return env;
}

/** The env a hook or a real git sees: the dispatcher in force through the real keys, when asked. */
function childEnv({ dispatcher, tmpdir } = {}) {
  const env = hostFreeEnv();
  if (dispatcher !== undefined) {
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = 'core.hooksPath';
    env.GIT_CONFIG_VALUE_0 = dispatcher;
  }
  if (tmpdir !== undefined) env.TMPDIR = tmpdir;
  return env;
}

/** The fixture's own git, never the code under test: hooks off, a fixed identity, no signing. */
function fixtureGit(dir, ...args) {
  const r = spawnSync(
    'git',
    ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', '-C', dir, ...args],
    { encoding: 'utf8', env: hostFreeEnv() }
  );
  if (r.status !== 0) throw new Error(`fixture git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

function writeExecutable(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  fs.chmodSync(file, 0o755);
}

/** The sentinel layout resolve.cjs hasSentinel needs, and the repo hook that marks and fails. */
function addCheckoutLayout(dir) {
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'gsd-core', 'bin', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'scripts', 'pr-target-policy.cjs'), '');
  writeExecutable(path.join(dir, '.githooks', 'pre-commit'), FIXTURE_REPO_HOOK);
}

/** A checkout under a scratch root: setup commit first, the repo value appended with fs after it. */
function buildFixtureRepo(t, repoValue = '.githooks') {
  const root = scratchDir(t, 'githooks-seal-fixture-');
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  fixtureGit(repo, 'init', '-q');
  fixtureGit(repo, 'commit', '-q', '--allow-empty', '-m', 'setup');
  addCheckoutLayout(repo);
  if (repoValue !== null) {
    fs.appendFileSync(path.join(repo, '.git', 'config'), `[core]\n\thooksPath = ${repoValue}\n`);
  }
  return { root, repo };
}

/** A linked worktree beside the fixture repo. Untracked files do not propagate, so add them again. */
function addLinkedWorktree({ root, repo }) {
  const wt = path.join(root, 'linked');
  fixtureGit(repo, 'worktree', 'add', '-q', '-b', 'linked-branch', wt);
  addCheckoutLayout(wt);
  return wt;
}

/** A dir named githooks-dispatch: the stub and the minimal faithful delegate, modes as in real use. */
function buildDispatcher(parent) {
  const dir = path.join(parent, 'githooks-dispatch');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, '_delegate.sh'), DISPATCH_DELEGATE);
  fs.chmodSync(path.join(dir, '_delegate.sh'), 0o644);
  writeExecutable(path.join(dir, 'pre-commit'), DISPATCH_STUB);
  writeExecutable(path.join(dir, 'pre-push'), DISPATCH_STUB);
  return dir;
}

/** Spawn the hook on PreToolUse JSON. A crash or a missing verdict never reads as an allow. */
function runHook(cwd, env, command) {
  const r = spawnSync(process.execPath, [SEAL_HOOK], { cwd, env, input: input(command), encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `hook exited ${r.status}: ${r.stderr}`);
  const out = JSON.parse(r.stdout).hookSpecificOutput;
  return { decision: out.permissionDecision, reason: out.permissionDecisionReason };
}

test('dispatcher in force, repo value .githooks: the hook allows a commit and a push', (t) => {
  const fx = buildFixtureRepo(t);
  const env = childEnv({ dispatcher: buildDispatcher(fx.root) });
  for (const command of ['git commit -m x', 'git push origin x']) {
    const d = runHook(fx.repo, env, command);
    assert.strictEqual(d.decision, 'allow', `${command}: ${d.reason}`);
  }
});

test('dispatcher in force, repo value .githooks, cwd in a linked worktree: the hook allows', (t) => {
  const fx = buildFixtureRepo(t);
  const wt = addLinkedWorktree(fx);
  const env = childEnv({ dispatcher: buildDispatcher(fx.root) });
  for (const command of ['git commit -m x', 'git push origin x']) {
    const d = runHook(wt, env, command);
    assert.strictEqual(d.decision, 'allow', `${command}: ${d.reason}`);
  }
});

// A second signal on the fixture, not on the hook: this passes with or without the fix, and
// says the state the allow tests stand in really runs the repo hook and its failure blocks.
test('fixture validity: behind the fixture dispatcher a real git commit runs the repo hook and is blocked', (t) => {
  const fx = buildFixtureRepo(t);
  const env = childEnv({ dispatcher: buildDispatcher(fx.root) });
  const r = spawnSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'x'],
    { cwd: fx.repo, env, encoding: 'utf8' }
  );
  assert.notStrictEqual(r.status, 0, `commit should be blocked: ${r.stdout}${r.stderr}`);
  assert.ok(fs.existsSync(path.join(fx.repo, REPO_HOOK_MARKER)), 'the repo hook should have run');
});

test('two allow runs on one state: same verdict, no canary dir left, repo config bytes unchanged, repo hook not run', (t) => {
  const fx = buildFixtureRepo(t);
  const tmpdir = scratchDir(t, 'githooks-seal-tmpdir-');
  const env = childEnv({ dispatcher: buildDispatcher(fx.root), tmpdir });
  const configFile = path.join(fx.repo, '.git', 'config');
  const before = fs.readFileSync(configFile);
  const leftovers = () => fs.readdirSync(tmpdir).filter((name) => name.startsWith(CANARY_PREFIX));
  for (const run of ['first', 'second']) {
    const d = runHook(fx.repo, env, 'git commit -m x');
    assert.strictEqual(d.decision, 'allow', `${run} run: ${d.reason}`);
    assert.deepStrictEqual(leftovers(), [], `${run} run left a canary dir`);
    assert.ok(fs.readFileSync(configFile).equals(before), `${run} run changed the repo config`);
    assert.ok(!fs.existsSync(path.join(fx.repo, REPO_HOOK_MARKER)), `${run} run ran the repo hook`);
  }
});
