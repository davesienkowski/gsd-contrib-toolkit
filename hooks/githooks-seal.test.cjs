'use strict';

/**
 * node:test for hooks/githooks-seal.cjs (ENF-12 --no-verify flag-not-text +
 * ENF-13 core.hooksPath=.githooks, HARD-01/04 fail-closed).
 *
 * Two kinds of test. The rows driven via the injectable runGithooksGate(stdinString, deps)
 * seam inject the worktree's core.hooksPath value and the worktree root, so they read no real
 * git config and no filesystem. The ENF-13 dispatcher rows at the end of the file (quick
 * 261103-uqe) are real git: real env keys, real directories, the hook as a spawned process.
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
const { spawn, spawnSync } = require('node:child_process');

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

// --- ENF-13 typed scan and deny texts (quick 261103-uqe, Task 2) --------------------
// Each rule family below is proved both ways: rows that deny and false-deny controls that allow.
// Every row runs through the spawned hook, in the plain state (effective .githooks) and behind the
// fixture dispatcher. The row-per-form port of the whole shape bank, with each row's real effect, is at
// the end of this file.

/** A dir named githooks-dispatch whose pre-commit is the given text; the rest has the right shape. */
function buildLookAlike(parent, preCommit) {
  const dir = path.join(parent, 'githooks-dispatch');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, '_delegate.sh'), DISPATCH_DELEGATE);
  writeExecutable(path.join(dir, 'pre-commit'), preCommit);
  writeExecutable(path.join(dir, 'pre-push'), DISPATCH_STUB);
  return dir;
}

/** The env for a real commit in a fixture: a fixed identity and no signing prompt. */
function realGitEnv(env) {
  return Object.assign({}, env, {
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@example.invalid',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@example.invalid',
  });
}

/** Run the row in real bash: did the repo hook's marker appear, and did a commit land. */
function realEffect(repo, env, command) {
  const marker = path.join(repo, REPO_HOOK_MARKER);
  fs.rmSync(marker, { force: true });
  const count = () => fixtureGit(repo, 'rev-list', '--count', 'HEAD').trim();
  const before = count();
  const r = spawnSync('bash', ['-c', command], { cwd: repo, env, encoding: 'utf8', timeout: 20000 });
  return { hookRan: fs.existsSync(marker), committed: count() !== before, stderr: r.stderr };
}

const ENF13_K = 'core.hooksPath';
const ADVICE_REMOVE = /Remove it from the command\./;
const ADVICE_LITERAL = /Spell the option out in the command\./;
const ADVICE_OWN_CALL = /Run that command in its own Bash call\./;
const VALVE_NAME = /GSD_CONTRIB_OVERRIDE/;
const TEXT_A_UNSET =
  'This worktree\'s `core.hooksPath` is UNSET, so the repo\'s `.githooks` gates (pre-commit / pre-push) ' +
  'are silently INERT. Set it before committing/pushing: `git config core.hooksPath .githooks`. (ENF-13)';

/** The two states every typed row runs in: effective .githooks, and the dispatcher in force. */
function typedStates(t) {
  const fx = buildFixtureRepo(t);
  return {
    fx,
    states: [
      ['plain', childEnv()],
      ['dispatcher', childEnv({ dispatcher: buildDispatcher(fx.root) })],
    ],
  };
}

function assertTypedDeny(row, states, cwd) {
  const [command, advice] = row;
  for (const [name, env] of states) {
    const d = runHook(cwd, env, command);
    assert.strictEqual(d.decision, 'deny', `${name}: ${JSON.stringify(command)} should deny`);
    assert.match(d.reason, /\(ENF-13\)$/, `${name}: ${command}`);
    assert.match(d.reason, /`git config core\.hooksPath \.githooks` is not the fix/, `${name}: ${command}`);
    assert.match(d.reason, advice, `${name}: ${command}: ${d.reason}`);
    assert.doesNotMatch(d.reason, /INERT/, `${name}: ${command}`);
    assert.doesNotMatch(d.reason, VALVE_NAME, `${name}: ${command}`);
  }
}

function assertTypedAllow(command, states, cwd) {
  for (const [name, env] of states) {
    const d = runHook(cwd, env, command);
    assert.strictEqual(d.decision, 'allow', `${name}: ${JSON.stringify(command)}: ${d.reason}`);
  }
}

test('typed family -c and --config-env naming the key: deny, in any spelling and position', (t) => {
  const { fx, states } = typedStates(t);
  for (const command of [
    `git -c ${ENF13_K}=/dev/null commit -m x`,
    `git --no-pager -c ${ENF13_K}=/dev/null commit -m x`,
    `git -C . -c ${ENF13_K}=/dev/null commit -m x`,
    `git --shallow-file /dev/null -c ${ENF13_K}=/dev/null commit -m x`,
    `git --attr-source HEAD -c ${ENF13_K}=/dev/null commit -m x`,
    'git -c CORE.HOOKSPATH=/dev/null commit -m x',
    `git -c ${ENF13_K} commit -m x`,
    `git -c ${ENF13_K}= commit -m x`,
    `git -c ${ENF13_K}=.githooks -c ${ENF13_K}=/dev/null commit -m x`,
    `git -c ${ENF13_K}=/dev/null -c ${ENF13_K}=.githooks commit -m x`,
    `git --config-env=${ENF13_K}=HOME commit -m x`,
    `git --config-env ${ENF13_K}=HOME commit -m x`,
    `git -c ${ENF13_K}=/dev/null push origin x`,
    `command git -c ${ENF13_K}=/dev/null commit -m x`,
    `true | git -c ${ENF13_K}=/dev/null commit -m x`,
    `git status; git -c ${ENF13_K}=/dev/null commit -m x`,
  ]) {
    assertTypedDeny([command, ADVICE_REMOVE], states, fx.repo);
  }
});

test('typed family -c and --config-env, false-deny controls: allow', (t) => {
  const { fx, states } = typedStates(t);
  for (const command of [
    `git -c ${ENF13_K}=.githooks commit -m x`,
    'git -c user.name=x commit -m x',
    'git -c commit.gpgsign=false commit -m x',
    `git -c${ENF13_K}=/dev/null commit -m x`,
    'git commit -c HEAD -m x',
    'git commit -m x -c',
    `git push -c ${ENF13_K}=/dev/null`,
    `git -c ${ENF13_K}=/dev/null status`,
    `git --config-env ${ENF13_K}=HOME status`,
    `git -c ${ENF13_K}=/dev/null status; git commit -m x`,
  ]) {
    assertTypedAllow(command, states, fx.repo);
  }
});

test('typed family include.path and includeIf: deny; a look-alike key: allow', (t) => {
  const { fx, states } = typedStates(t);
  for (const command of [
    'git -c include.path=/tmp/x commit -m x',
    'git -c INCLUDE.PATH=/tmp/x commit -m x',
    "git -c 'includeIf.gitdir:/**.path=/tmp/x' commit -m x",
    'git --config-env=include.path=HOME commit -m x',
    'git --config-env include.path=HOME commit -m x',
  ]) {
    assertTypedDeny([command, ADVICE_REMOVE], states, fx.repo);
  }
  for (const command of ['git -c include.pathx=/tmp/x commit -m x', 'git -c includeif.x.other=y commit -m x']) {
    assertTypedAllow(command, states, fx.repo);
  }
});

test('typed family a key or token the gate cannot read: deny; the exempt value positions: allow', (t) => {
  const { fx, states } = typedStates(t);
  for (const command of [
    `git -c $'${ENF13_K}=/dev/null' commit -m x`,
    "git -c $'core.hooks\\x50ath=/dev/null' commit -m x",
    'git -c $K=/dev/null commit -m x',
    'git -c "$K=/dev/null" commit -m x',
    'git -c core.hooks$(echo Path)=/dev/null commit -m x',
    'git $O commit -m x',
    `git {-c,${ENF13_K}=/dev/null} commit -m x`,
  ]) {
    assertTypedDeny([command, ADVICE_LITERAL], states, fx.repo);
  }
  for (const command of [
    'WT=.; git -C "$WT" commit -m x',
    'git -C "$(pwd)" commit -m x',
    'git -C . commit -m x',
    'git -C . push origin x',
    'N=x; git --namespace=$N commit -m x',
    'git commit -m "$M"',
    'git log "$X"; git commit -m x',
    "git -c 'url.git@x:.insteadOf=y' push origin x",
    'N=x; git -c user.name=$N commit -m x',
    'V=HOME; git --config-env user.name=$V commit -m x',
  ]) {
    assertTypedAllow(command, states, fx.repo);
  }
});

test('typed family repo options and assignments: deny; a neighbor and other env names: allow', (t) => {
  const { fx, states } = typedStates(t);
  for (const command of [
    'git --git-dir=/tmp/x --work-tree=. commit -m x',
    'git --git-dir /tmp/x commit -m x',
    'git --work-tree=/tmp/x commit -m x',
    'GIT_DIR=/tmp/x git commit -m x',
    'GIT_WORK_TREE=/tmp/x git commit -m x',
    'GIT_COMMON_DIR=/tmp/x git commit -m x',
    'env GIT_DIR=/tmp/x git commit -m x',
  ]) {
    assertTypedDeny([command, ADVICE_REMOVE], states, fx.repo);
  }
  for (const command of [
    'git --git-dir=.git status; git commit -m x',
    'GIT_CONFIG_GLOBAL=/dev/null git commit -m x',
    'GIT_CONFIG_SYSTEM=/dev/null git commit -m x',
  ]) {
    assertTypedAllow(command, states, fx.repo);
  }
});

test('typed family env key names: deny beside a sealed segment; text and other names: allow', (t) => {
  const { fx, states } = typedStates(t);
  for (const command of [
    'GIT_CONFIG_VALUE_0=/dev/null git commit -m x',
    'env GIT_CONFIG_VALUE_0=/dev/null git commit -m x',
    'env --chdir=. GIT_CONFIG_VALUE_0=/dev/null git commit -m x',
    'export GIT_CONFIG_VALUE_0=/dev/null; git commit -m x',
    'export GIT_CONFIG_COUNT=0; git commit -m x',
    'declare -gx GIT_CONFIG_PARAMETERS=x; git commit -m x',
    'printf -v GIT_CONFIG_KEY_0 x; git commit -m x',
    'n=0; export GIT_CONFIG_VALUE_$n=/dev/null; git commit -m x',
    'n=VALUE_0; export GIT_CONFIG_${n}=/dev/null; git commit -m x',
    'GIT_CONFIG_VALUE_0=/dev/null\nexport GIT_CONFIG_VALUE_0\ngit commit -m x',
  ]) {
    assertTypedDeny([command, ADVICE_OWN_CALL], states, fx.repo);
  }
  for (const command of [
    'git commit -m "GIT_CONFIG_VALUE_0=v"',
    'git commit -m "line1\nGIT_CONFIG_VALUE_0=v"',
    'cd .\ngit commit -m "GIT_CONFIG_VALUE_0=v"',
    'MY_GIT_CONFIG_COUNT=1 git commit -m x',
    'GIT_CONFIG_COUNTER=1 git commit -m x',
    'echo GIT_CONFIG_VALUE_0=v',
    'export GIT_CONFIG_COUNT=0',
    'unset GIT_CONFIG_COUNT; git commit -m x',
    'env -u GIT_CONFIG_COUNT git commit -m x',
    'echo GIT_CONFIG_VALUE_0=v && git commit -m x',
  ]) {
    assertTypedAllow(command, states, fx.repo);
  }
});

test('typed family config writes beside a commit: deny; reads and the advised fix: allow', (t) => {
  const { fx, states } = typedStates(t);
  for (const command of [
    `git config ${ENF13_K} /dev/null && git commit -m x; git config ${ENF13_K} .githooks`,
    `git config --unset ${ENF13_K} && git commit -m x`,
    `git config --unset-all ${ENF13_K} && git commit -m x`,
    `git config unset ${ENF13_K} && git commit -m x`,
    `git config set ${ENF13_K} /dev/null && git commit -m x`,
    `git -c x.y=z config ${ENF13_K} /dev/null && git commit -m x`,
    `git config --show-scope ${ENF13_K} /dev/null && git commit -m x`,
    'git config include.path /tmp/x && git commit -m x',
    "git config 'includeIf.gitdir:/x.path' /tmp/x && git commit -m x",
    `git config ${ENF13_K} 2>/dev/null /dev/null && git commit -m x`,
    `git config ${ENF13_K} > /tmp/out /dev/null && git commit -m x`,
  ]) {
    assertTypedDeny([command, ADVICE_OWN_CALL], states, fx.repo);
  }
  for (const command of [
    `git config ${ENF13_K} .githooks && git commit -m x`,
    `git config --get ${ENF13_K} && git commit -m x`,
    `git config --get=x ${ENF13_K} y && git commit -m x`,
    'git config --list --show-scope && git commit -m x',
    `git config -l && git commit -m x`,
    `git config ${ENF13_K} && git commit -m x`,
    `git config get ${ENF13_K}; git commit -m x`,
    'git config user.name x && git commit -m x',
    `git config ${ENF13_K} /dev/null`,
  ]) {
    assertTypedAllow(command, states, fx.repo);
  }
});

test('typed scan reads the newline split: a neighbor line never widens, and an override line denies', (t) => {
  const { fx, states } = typedStates(t);
  for (const command of [
    `cd .\ngit -c ${ENF13_K}=/dev/null commit -m x`,
    `git status\ngit -c ${ENF13_K}=/dev/null push origin x`,
  ]) {
    assertTypedDeny([command, ADVICE_REMOVE], states, fx.repo);
  }
  for (const command of [
    'git log "$X"\ngit commit -m x',
    `git -c ${ENF13_K}=/dev/null status\ngit commit -m x`,
    'f=x\ngit add "$f"\ngit commit -m x',
    'WT=.\ncd "$WT"\ngit commit -m x',
    `git commit -m "line1\ngit -c ${ENF13_K}=/dev/null commit"`,
  ]) {
    assertTypedAllow(command, states, fx.repo);
  }
});

test('A-2: a continuation newline in a token does not hide a form from the scan', (t) => {
  const { fx, states } = typedStates(t);
  for (const command of [
    `git \\\n-c ${ENF13_K}=/dev/null commit -m x`,
    `git -c ${ENF13_K}=/dev/null \\\ncommit -m x`,
    `git \\\n  -c ${ENF13_K}=/dev/null \\\n  commit -m x`,
  ]) {
    assertTypedDeny([command, ADVICE_REMOVE], states, fx.repo);
  }
  for (const command of ['git \\\n  commit -m x', 'git commit \\\n  --allow-empty \\\n  -m x', 'git log \\\n\ngit commit -m y']) {
    assertTypedAllow(command, states, fx.repo);
  }
});

test('A-3: heredoc bodies never reach the scan, in any chain; real forms around them still deny', (t) => {
  const { fx, states } = typedStates(t);
  const key = 'GIT_CONFIG_COUNT';
  for (const command of [
    "git commit -q -F- <<'EOF' && git log --oneline -3\nfix(x): one commit\nEOF",
    "git commit -q -F- <<'EOF' && git log --oneline -3\nfix(x): one thing\nEOF",
    "git commit -q -F- <<'EOF' && git push origin x\nfix(x): one thing\nEOF",
    "git commit -q -F- <<'EOF' && git push origin x\nfix(x): do not push yet\nEOF",
    `git commit -q -F- <<'EOF' && echo done\nfix: name ${key}\nEOF`,
    `git commit -q -F- <<'EOF' 2>&1 | tail -3\nfix: name ${key}\nEOF`,
    "cat > m.txt <<'EOF' && git commit -F m.txt\nfix(x): one commit\nEOF",
    `cat > m.txt <<'EOF'\nfix(x): one commit ${key}\nEOF\ngit commit -F m.txt`,
    `git commit -q -F- <<'EOF'\nfix(x): one commit ${key}\nEOF`,
    `git commit -F - <<'EOF'\n-c ${ENF13_K}=x commit\nGIT_CONFIG_VALUE_0=z\nEOF`,
    `git commit -m "$(cat <<'EOF'\nfix commit push $X -c ${ENF13_K}=y GIT_CONFIG_VALUE_0=z\n\nmore commit\nEOF\n)"`,
    `git commit -F- <<-EOF\n\tbody ${key}\n\tEOF\ngit log -1`,
    `cat <<A <<B && git commit -m x\nfirst ${key}\nA\nsecond $X\nB`,
    `cat <<EOF\n${key}=1\nEOF`,
    '<<EOF\nbody\nEOF',
  ]) {
    assertTypedAllow(command, states, fx.repo);
  }
  for (const [command, advice] of [
    [`cat > /dev/null <<'EOF'\nbody\nEOF\ngit -c ${ENF13_K}=/dev/null commit -m x`, ADVICE_REMOVE],
    [`git -c ${ENF13_K}=/dev/null commit -F- <<'EOF' && git log\nbody\nEOF`, ADVICE_REMOVE],
    [`cat <<'EOF'\nbody\nEOF\nexport ${key}=0; git commit -m x`, ADVICE_OWN_CALL],
    [`git commit -F- <<EOF\nbody\nEOF\ngit --git-dir=/tmp/x commit -m y`, ADVICE_REMOVE],
    [`git config ${ENF13_K} /dev/null <<EOF && git commit -m x\nbody\nEOF`, ADVICE_OWN_CALL],
    // A here-string has no body: the line after it is a command, and the scan reads it.
    [`cat <<< x\ngit -c ${ENF13_K}=/dev/null commit -m y`, ADVICE_REMOVE],
  ]) {
    assertTypedDeny([command, advice], states, fx.repo);
  }
});

test('A-3: the mask leaves a command with no heredoc byte-identical and removes operator and body', () => {
  const { maskShellText: maskHeredocBodies } = require('./githooks-seal.cjs');
  for (const command of [
    'git commit -m x',
    'git commit -m "a << b"',
    "git commit -m 'a <<EOF'",
    'echo a\\<\\<EOF',
  ]) {
    assert.strictEqual(maskHeredocBodies(command), command);
  }
  assert.strictEqual(maskHeredocBodies("cat <<'E' && x\nbody\nE\nnext"), 'cat  && x\nnext');
  assert.strictEqual(maskHeredocBodies('cat <<E\nno terminator\nnext'), 'cat \n');
  assert.strictEqual(maskHeredocBodies('cat <<E'), 'cat ');
  assert.strictEqual(maskHeredocBodies('cat a <<< b; git log\ngit status'), 'cat a     b; git log\ngit status');
});

test('A-4: a comment token stops the scan, and a redirect is not a config value', (t) => {
  const { fx, states } = typedStates(t);
  for (const command of [
    'R=origin;REF=x; git push "$R" "HEAD:$REF"   # a plain fast-forward push',
    'f=msg.txt; git add "$f"  # then commit',
    'M=x; git commit --allow-empty -m "$M"  # commit and push',
    'X=HEAD; git log -1 "$X"  # last commit',
    `git config ${ENF13_K} 2>/dev/null; git commit --allow-empty -m x`,
    `git config ${ENF13_K} 2>&1 && git commit --allow-empty -m x`,
    `git config ${ENF13_K}   # expect .githooks\ngit commit --allow-empty -m x`,
    `git config ${ENF13_K} >/dev/null && git commit --allow-empty -m x`,
    `git config ${ENF13_K} </dev/null && git commit --allow-empty -m x`,
    `git config ${ENF13_K} > /dev/null && git commit --allow-empty -m x`,
    '# GIT_CONFIG_VALUE_0\ngit commit --allow-empty -m x',
    'git commit --allow-empty -m x # GIT_CONFIG_COUNT',
    'git status # GIT_CONFIG_COUNT\ngit commit --allow-empty -m x',
    `git status # git -c ${ENF13_K}=/dev/null commit\ngit commit --allow-empty -m x`,
    `echo x # git config ${ENF13_K} /dev/null\ngit commit --allow-empty -m x`,
  ]) {
    assertTypedAllow(command, states, fx.repo);
  }
  for (const [command, advice] of [
    [`git -c ${ENF13_K}=/dev/null commit -m x # a comment`, ADVICE_REMOVE],
    [`git -C "#dir" -c ${ENF13_K}=/dev/null commit -m x`, ADVICE_REMOVE],
    [`git -c "#x=y" -c ${ENF13_K}=/dev/null commit -m x`, ADVICE_LITERAL],
    ['export GIT_CONFIG_COUNT=0 # note\ngit commit -m x', ADVICE_OWN_CALL],
  ]) {
    assertTypedDeny([command, advice], states, fx.repo);
  }
});

test('A-4: the commit rows really run the repo hook behind the fixture dispatcher', (t) => {
  const fx = buildFixtureRepo(t);
  const env = realGitEnv(childEnv({ dispatcher: buildDispatcher(fx.root) }));
  for (const command of [
    'M=x; git commit --allow-empty -m "$M"  # commit and push',
    `git config ${ENF13_K} 2>/dev/null; git commit --allow-empty -m x`,
    `git config ${ENF13_K} 2>&1 && git commit --allow-empty -m x`,
    `git config ${ENF13_K}   # expect .githooks\ngit commit --allow-empty -m x`,
  ]) {
    const effect = realEffect(fx.repo, env, command);
    assert.strictEqual(effect.hookRan, true, `${command}: ${effect.stderr}`);
    assert.strictEqual(effect.committed, false, command);
  }
});

test('typed rows read nothing: an injected read is not called, and ENF-12 keeps its text first', () => {
  for (const command of [
    `git -c ${ENF13_K}=/dev/null commit -m x`,
    `git --config-env ${ENF13_K}=HOME commit -m x`,
    'git $O commit -m x',
    'export GIT_CONFIG_COUNT=0; git commit -m x',
  ]) {
    let reads = 0;
    const d = runGithooksGate(input(command), deps({ readHooksPath: () => { reads += 1; return '.githooks'; } }));
    assert.strictEqual(d.permissionDecision, 'deny', command);
    assert.strictEqual(reads, 0, command);
  }
  const d = runGithooksGate(input(`git -c ${ENF13_K}=/dev/null commit --no-verify -m x`), deps());
  assert.match(d.permissionDecisionReason, /\(ENF-12\)$/);
});

test('a typed form outside any gsd-core checkout stays allowed', (t) => {
  const dir = scratchDir(t, 'githooks-seal-noroot-');
  fixtureGit(dir, 'init', '-q');
  for (const command of [`git -c ${ENF13_K}=/dev/null commit -m x`, `git --config-env ${ENF13_K}=HOME commit -m x`]) {
    assert.strictEqual(runHook(dir, childEnv(), command).decision, 'allow', command);
  }
});

// A-1: spellings ENF-12's exact lookup misses. They skip the hook, so behind the dispatcher they deny;
// in the plain state they stay allowed as they are today, so the dispatcher allow is the only verdict
// this rule can change.
const A1_COMMIT_HITS = [
  'git commit --allow-empty -qnm x',
  'git commit --allow-empty -anm x',
  'git commit --allow-empty -qanm x',
  'git commit --allow-empty -qn -m x',
  'git commit --allow-empty -vn -m x',
  'git commit --allow-empty --no-veri -m x',
  'git commit --allow-empty --no-verif -m x',
  'git commit --allow-empty -m x \\\n--no-verify',
  'git commit --allow-empty -m x \\\n-n',
  'git commit --allow-empty -m "#1" --no-veri',
  'git commit --allow-empty --message "#1" --no-veri',
];

test('A-1: spellings ENF-12 misses deny behind the dispatcher with no canary run, and stay allowed plain', (t) => {
  const fx = buildFixtureRepo(t);
  const sentinel = path.join(fx.root, 'canary-sentinel');
  const lookAlike = buildLookAlike(fx.root, `#!/bin/sh\n: > '${sentinel}'\nexit 37\n`);
  const behind = childEnv({ dispatcher: lookAlike });
  const plain = childEnv();
  for (const command of [...A1_COMMIT_HITS, 'git push --no-veri origin x', 'git push --no-verif origin x']) {
    const d = runHook(fx.repo, behind, command);
    assert.strictEqual(d.decision, 'deny', JSON.stringify(command));
    assert.match(d.reason, /\(ENF-13\)$/, command);
    assert.match(d.reason, /Remove it and let the local gates run\./, command);
    assert.doesNotMatch(d.reason, VALVE_NAME, command);
    assert.strictEqual(fs.existsSync(sentinel), false, `${command} ran the canary`);
    assert.strictEqual(runHook(fx.repo, plain, command).decision, 'allow', `plain: ${command}`);
  }
});

test('A-1: real git skips the hook for each hit form behind the fixture dispatcher', (t) => {
  const fx = buildFixtureRepo(t);
  const env = realGitEnv(childEnv({ dispatcher: buildDispatcher(fx.root) }));
  for (const command of A1_COMMIT_HITS) {
    const effect = realEffect(fx.repo, env, command);
    assert.strictEqual(effect.hookRan, false, command);
    assert.strictEqual(effect.committed, true, `${command}: ${effect.stderr}`);
  }
  const bare = path.join(fx.root, 'remote.git');
  fixtureGit(fx.root, 'init', '-q', '--bare', bare);
  fixtureGit(fx.repo, 'remote', 'add', 'origin', bare);
  writeExecutable(path.join(fx.repo, '.githooks', 'pre-push'), FIXTURE_REPO_HOOK);
  const skipped = realEffect(fx.repo, env, 'git push --no-veri origin HEAD:refs/heads/a1');
  assert.strictEqual(skipped.hookRan, false);
  assert.match(fixtureGit(bare, 'for-each-ref'), /refs\/heads\/a1/);
  const blocked = realEffect(fx.repo, env, 'git push origin HEAD:refs/heads/a2');
  assert.strictEqual(blocked.hookRan, true);
  assert.doesNotMatch(fixtureGit(bare, 'for-each-ref'), /refs\/heads\/a2/);
});

test('A-1, false-deny controls: allow behind the dispatcher and plain, and the hook does run', (t) => {
  const { fx, states } = typedStates(t);
  const hookRuns = [
    'git commit --allow-empty -am "x"',
    'git commit --allow-empty -mn',
    'git commit --allow-empty -Fn',
    'git commit --allow-empty -qSn -m x',
    'git commit --allow-empty --no-verbose -m x',
  ];
  for (const command of [
    ...hookRuns,
    'git commit -m -anm',
    'git commit -am -qn',
    'git commit -m "--no-veri"',
    'git commit -m x # -anm',
    'git commit -m x # --no-veri',
    'git commit --no-ver -m x',
    'git commit -m x -- -qn',
    'git commit -uno -m x',
    'git push -q origin x',
    'git push --no-ver origin x',
  ]) {
    assertTypedAllow(command, states, fx.repo);
  }
  const env = realGitEnv(states[1][1]);
  fs.writeFileSync(path.join(fx.repo, 'n'), 'msg\n');
  for (const command of hookRuns) {
    const effect = realEffect(fx.repo, env, command);
    assert.strictEqual(effect.hookRan, true, `${command}: ${effect.stderr}`);
    assert.strictEqual(effect.committed, false, command);
  }
});

// --- One deny text per branch ---------------------------------------------------------

function assertPlainDenyText(reason, label) {
  assert.match(reason, /^[\x20-\x7e]*$/, `${label}: plain ASCII on one line`);
  assert.match(reason, /\(ENF-13\)$/, label);
  assert.doesNotMatch(reason, VALVE_NAME, label);
}

test('text A: a repo-scope value is the only state that says INERT, and it prints the value or UNSET', (t) => {
  const unset = buildFixtureRepo(t, null);
  const a = runHook(unset.repo, childEnv(), 'git commit -m x');
  assert.strictEqual(a.reason, TEXT_A_UNSET);

  const husky = buildFixtureRepo(t, '.husky');
  const b = runHook(husky.repo, childEnv(), 'git commit -m x');
  assert.strictEqual(b.decision, 'deny');
  assert.match(b.reason, /`\.husky`, so the repo's `\.githooks` gates .* silently INERT/);

  for (const [value, shown] of [['".githooks "', '`.githooks `'], ['.GITHOOKS', '`.GITHOOKS`']]) {
    const fx = buildFixtureRepo(t, value);
    const c = runHook(fx.repo, childEnv(), 'git commit -m x');
    assert.strictEqual(c.decision, 'deny', value);
    assert.ok(c.reason.includes(shown), c.reason);
    assert.match(c.reason, /INERT/);
    assertPlainDenyText(c.reason, value);
  }
});

test('text A: repo-scope and include-sourced values naming a look-alike deny and never run it', (t) => {
  const fx = buildFixtureRepo(t, null);
  const sentinel = path.join(fx.root, 'sentinel');
  const lookAlike = buildLookAlike(fx.root, `#!/bin/sh\n: > '${sentinel}'\nexit 37\n`);
  const included = path.join(fx.root, 'inc.cfg');
  fs.writeFileSync(included, `[core]\n\thooksPath = ${lookAlike}\n`);
  fs.appendFileSync(path.join(fx.repo, '.git', 'config'), `[include]\n\tpath = ${included}\n`);
  const d = runHook(fx.repo, childEnv(), 'git commit -m x');
  assert.strictEqual(d.decision, 'deny');
  assert.match(d.reason, /INERT/);
  assert.strictEqual(fs.existsSync(sentinel), false);
});

test('text B: dispatcher shape with the repo value wrong or unset names both, gives the working fix, runs nothing', (t) => {
  for (const [repoValue, shown] of [[null, 'UNSET'], ['.husky', '`.husky`']]) {
    const fx = buildFixtureRepo(t, repoValue);
    const sentinel = path.join(fx.root, 'sentinel');
    const lookAlike = buildLookAlike(fx.root, `#!/bin/sh\n: > '${sentinel}'\nexit 37\n`);
    const d = runHook(fx.repo, childEnv({ dispatcher: lookAlike }), 'git commit -m x');
    assert.strictEqual(d.decision, 'deny');
    assert.ok(d.reason.includes(lookAlike), d.reason);
    assert.ok(d.reason.includes(`that value is ${shown}`), d.reason);
    assert.ok(d.reason.includes('`git config core.hooksPath .githooks` in this worktree writes the value the delegate reads'), d.reason);
    assert.match(d.reason, /The effective value stays the dispatcher/);
    assert.match(d.reason, /a human runs it in their own terminal/);
    assert.doesNotMatch(d.reason, /INERT/);
    assertPlainDenyText(d.reason, shown);
    assert.strictEqual(fs.existsSync(sentinel), false, 'text B states no canary ran');
  }
});

test('text C, shape failure: says git config cannot fix it, prints the value or UNSET, runs nothing', (t) => {
  const fx = buildFixtureRepo(t);
  const elsewhere = path.join(fx.root, 'not-the-name');
  const sentinel = path.join(fx.root, 'sentinel');
  fs.mkdirSync(elsewhere);
  writeExecutable(path.join(elsewhere, 'pre-commit'), `#!/bin/sh\n: > '${sentinel}'\nexit 37\n`);
  writeExecutable(path.join(elsewhere, 'pre-push'), DISPATCH_STUB);
  fs.writeFileSync(path.join(elsewhere, '_delegate.sh'), DISPATCH_DELEGATE);
  for (const [value, shown, why] of [
    ['/dev/null', '`/dev/null`', /basename is not githooks-dispatch/],
    ['relative/githooks-dispatch', '`relative/githooks-dispatch`', /not an absolute path/],
    ['', 'UNSET', /no value/],
    [elsewhere, '`' + elsewhere + '`', /basename is not githooks-dispatch/],
    [path.join(fx.root, 'githooks-dispatch'), '`' + path.join(fx.root, 'githooks-dispatch') + '`', /ENOENT/],
  ]) {
    const d = runHook(fx.repo, childEnv({ dispatcher: value }), 'git commit -m x');
    assert.strictEqual(d.decision, 'deny', value);
    assert.ok(d.reason.includes(`The effective \`core.hooksPath\` is ${shown}`), d.reason);
    assert.ok(d.reason.includes('so `git config core.hooksPath .githooks` cannot fix it'), d.reason);
    assert.match(d.reason, /Remove the override\./);
    assert.match(d.reason, why);
    assert.doesNotMatch(d.reason, /INERT/);
    assert.doesNotMatch(d.reason, /\bempty\b/, value);
    assert.doesNotMatch(d.reason, /canary/, `${value}: a shape failure ran no canary`);
    assertPlainDenyText(d.reason, value);
    assert.strictEqual(fs.existsSync(sentinel), false, value);
  }
});

test('text C, canary failure: reports the marker and the exit or signal, and names a noexec TMPDIR', (t) => {
  const fx = buildFixtureRepo(t);
  const delegateExit0 = '#!/bin/sh\nexit 0\n';
  const runsHookExit0 = '#!/bin/sh\n.githooks/pre-commit\nexit 0\n';
  const exit37NoHook = '#!/bin/sh\nexit 37\n';
  for (const [body, result] of [
    [delegateExit0, 'marker no, exit 0'],
    [runsHookExit0, 'marker yes, exit 0'],
    [exit37NoHook, 'marker no, exit 37'],
  ]) {
    const parent = fs.mkdtempSync(path.join(fx.root, 'stub-'));
    const d = runHook(fx.repo, childEnv({ dispatcher: buildLookAlike(parent, body) }), 'git commit -m x');
    assert.strictEqual(d.decision, 'deny', body);
    assert.ok(d.reason.includes(`did not pass the delegation canary (${result})`), d.reason);
    assert.ok(d.reason.includes('so `git config core.hooksPath .githooks` cannot fix it'), d.reason);
    assert.match(d.reason, /A noexec TMPDIR makes the canary fail\./);
    assert.doesNotMatch(d.reason, /INERT/);
    assertPlainDenyText(d.reason, body);
  }
});

test('scope branch: a hook-env value that voiding cannot move gets text C, and its file never runs', (t) => {
  const fx = buildFixtureRepo(t);
  const sentinel = path.join(fx.root, 'sentinel');
  const lookAlike = buildLookAlike(fx.root, `#!/bin/sh\n: > '${sentinel}'\nexit 37\n`);
  const env = childEnv();
  env.GIT_CONFIG_PARAMETERS = `'${ENF13_K}=${lookAlike}'`;
  const d = runHook(fx.repo, env, 'git commit -m x');
  assert.strictEqual(d.decision, 'deny');
  assert.ok(d.reason.includes('so `git config core.hooksPath .githooks` cannot fix it'), d.reason);
  assert.doesNotMatch(d.reason, /INERT/);
  assertPlainDenyText(d.reason, 'parameters');
  assert.strictEqual(fs.existsSync(sentinel), false);

  const unset = buildFixtureRepo(t, null);
  const empty = runHook(unset.repo, childEnv({ dispatcher: '' }), 'git commit -m x');
  assert.strictEqual(empty.decision, 'deny');
  assert.ok(empty.reason.includes('The effective `core.hooksPath` is UNSET'), empty.reason);
  assert.ok(empty.reason.includes('cannot fix it'), empty.reason);
  assert.doesNotMatch(empty.reason, /INERT/);
});

test('scope branch: readHooksPathScopeLive returns the scope, or null when unset', (t) => {
  const { readHooksPathScopeLive } = require('./githooks-seal.cjs');
  const fx = buildFixtureRepo(t);
  assert.strictEqual(readHooksPathScopeLive(fx.repo, childEnv()), 'local');
  assert.strictEqual(readHooksPathScopeLive(fx.repo, childEnv({ dispatcher: '/x' })), 'command');
  const unset = buildFixtureRepo(t, null);
  assert.strictEqual(readHooksPathScopeLive(unset.repo, childEnv()), null);
  const bad = childEnv();
  bad.GIT_CONFIG_COUNT = 'nope';
  assert.throws(() => readHooksPathScopeLive(fx.repo, bad));
});

test('scope branch: a failed scope read is text C naming the failure, and the override cannot lift it', () => {
  let receipts = 0;
  const d = runGithooksGate(
    input('git commit -m x'),
    deps({
      readHooksPath: () => '/x/value',
      readRepoHooksPath: () => '/x/value',
      readHooksPathScope: () => {
        throw new Error('scope read boom');
      },
      overrideImpl: {
        checkOverride: () => ({ override: true, reason: 'pin' }),
        writeReceipt: () => {
          receipts += 1;
        },
      },
    })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /scope read boom/);
  assert.match(d.permissionDecisionReason, /cannot fix it/);
  assert.strictEqual(receipts, 0);
  for (const [scope, inert] of [['local', true], ['global', true], [null, true], ['command', false]]) {
    const r = runGithooksGate(
      input('git commit -m x'),
      deps({ readHooksPath: () => '/x/value', readRepoHooksPath: () => '/x/value', readHooksPathScope: () => scope })
    );
    assert.strictEqual(/INERT/.test(r.permissionDecisionReason), inert, String(scope));
  }
});

test('every authored deny text is plain ASCII and names no override valve', (t) => {
  const fx = buildFixtureRepo(t);
  const behind = childEnv({ dispatcher: buildDispatcher(fx.root) });
  for (const command of [
    `git -c ${ENF13_K}=/dev/null commit -m x`,
    'git $O commit -m x',
    'export GIT_CONFIG_COUNT=0; git commit -m x',
    `git config ${ENF13_K} /dev/null && git commit -m x`,
    'git --git-dir=/tmp/x commit -m x',
    'GIT_DIR=/tmp/x git commit -m x',
    'git commit --no-veri -m x',
  ]) {
    assertPlainDenyText(runHook(fx.repo, behind, command).reason, command);
  }
});

// --- The shape bank, one row per form, with each row's real effect (quick 261103-uqe) -------------
// Verdicts run in a small pool: the hook only reads the fixture, so it can run in parallel. Real
// effects run one at a time, since they land commits and write config in the one fixture.

/** runHook without blocking the pool. A crash or a missing verdict still never reads as an allow. */
function runHookAsync(cwd, env, command) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SEAL_HOOK], { cwd, env });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
    });
    child.stderr.on('data', (chunk) => {
      err += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`hook exited ${code}: ${err}`));
      try {
        const verdict = JSON.parse(out).hookSpecificOutput;
        return resolve({ decision: verdict.permissionDecision, reason: verdict.permissionDecisionReason });
      } catch (parseError) {
        return reject(parseError);
      }
    });
    child.stdin.end(input(command));
  });
}

async function inPool(items, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runner = async () => {
    while (next < items.length) {
      const at = next;
      next += 1;
      results[at] = await worker(items[at]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, Math.max(2, os.availableParallelism())) }, runner));
  return results;
}

/** Where HEAD points, read from disk: no spawn, so a row's effect costs only the row. */
function headOf(repo) {
  const git = path.join(repo, '.git');
  const head = fs.readFileSync(path.join(git, 'HEAD'), 'utf8').trim();
  return head.startsWith('ref: ') ? fs.readFileSync(path.join(git, head.slice(5)), 'utf8').trim() : head;
}

/** A fixture for the whole bank: a checkout, a second repo, an empty dir, an include file, a dispatcher. */
function buildBankFixture(t) {
  const fx = buildFixtureRepo(t);
  const other = path.join(fx.root, 'other');
  const emptyDir = path.join(fx.root, 'emptyw');
  fs.mkdirSync(other);
  fs.mkdirSync(emptyDir);
  fixtureGit(other, 'init', '-q');
  fixtureGit(other, 'commit', '-q', '--allow-empty', '-m', 'setup');
  fs.appendFileSync(path.join(other, '.git', 'config'), '[core]\n\thooksPath = /dev/null\n');
  const evil = path.join(fx.root, 'evil.cfg');
  fs.writeFileSync(evil, '[core]\n\thooksPath = /dev/null\n');
  const dispatcher = buildDispatcher(fx.root);
  return {
    ...fx,
    other,
    emptyDir,
    evil,
    dispatcher,
    plain: childEnv(),
    behind: childEnv({ dispatcher }),
    config: fs.readFileSync(path.join(fx.repo, '.git', 'config')),
  };
}

const EFFECT_BYPASS = 'committed, no hook';
const EFFECT_HOOK = 'hook ran, no commit';
const EFFECT_NONE = 'no commit, no hook';
const EFFECT_OTHER = 'landed in the other repo, no hook';
const ENF12_TEXT = /\(ENF-12\)$/;

/** Run a row in real bash behind the dispatcher, then put the fixture's config back. */
function bankEffect(fx, command) {
  const marker = path.join(fx.repo, REPO_HOOK_MARKER);
  fs.rmSync(marker, { force: true });
  const repoBefore = headOf(fx.repo);
  const otherBefore = headOf(fx.other);
  spawnSync('bash', ['-c', command], { cwd: fx.repo, env: realGitEnv(fx.behind), encoding: 'utf8', timeout: 20000 });
  const hookRan = fs.existsSync(marker);
  const landed = headOf(fx.repo) !== repoBefore;
  const landedOther = headOf(fx.other) !== otherBefore;
  fs.writeFileSync(path.join(fx.repo, '.git', 'config'), fx.config);
  if (hookRan) return landed ? 'hook ran AND a commit landed' : EFFECT_HOOK;
  if (landed) return EFFECT_BYPASS;
  return landedOther ? EFFECT_OTHER : EFFECT_NONE;
}

/**
 * Every D and N row of the shape bank. An effect of null is not run or not asserted:
 * sudo and gh reach outside the fixture; `git config set` is a real write only from git 2.46; env -i
 * drops the fixture's identity and no-system keys, so the host decides. A commit row's measured
 * effect is why its deny is not a guess, and an accepted false deny's effect is the hook running.
 */
function bankRows({ evil, other, emptyDir }) {
  const K = ENF13_K;
  const PK = 'GIT_CONFIG_PARAMETERS';
  const CK = 'GIT_CONFIG_COUNT';
  const VK = 'GIT_CONFIG_VALUE_0';
  const C = 'commit --allow-empty -m x';
  const D = (advice, name, command, effect) => ({ want: 'deny', advice, name, command, effect });
  const N = (name, command, effect) => ({ want: 'allow', name, command, effect });
  const R = ADVICE_REMOVE;
  const L = ADVICE_LITERAL;
  const O = ADVICE_OWN_CALL;
  return [
    D(R, 'control -c', `git -c ${K}=/dev/null ${C}`, EFFECT_BYPASS),
    D(R, 'include -c', `git -c include.path=${evil} ${C}`, EFFECT_BYPASS),
    D(R, 'include CASE', `git -c INCLUDE.PATH=${evil} ${C}`, EFFECT_BYPASS),
    D(R, 'includeIf', `git -c 'includeIf.gitdir:/**.path=${evil}' ${C}`, EFFECT_BYPASS),
    D(R, 'include config-env=', `EV=${evil} git --config-env=include.path=EV ${C}`, EFFECT_BYPASS),
    D(R, 'include config-env sp', `EV=${evil} git --config-env include.path=EV ${C}`, EFFECT_BYPASS),
    D(R, 'shallow-file hides', `git --shallow-file /dev/null -c ${K}=/dev/null ${C}`, EFFECT_BYPASS),
    D(R, 'attr-source hides', `git --attr-source HEAD -c ${K}=/dev/null ${C}`, EFFECT_BYPASS),
    D(L, 'var key', `K=${K}; git -c $K=/dev/null ${C}`, EFFECT_BYPASS),
    D(L, 'opts var', `O="-c ${K}=/dev/null"; git $O ${C}`, EFFECT_BYPASS),
    D(L, 'brace', `git {-c,${K}=/dev/null} ${C}`, EFFECT_BYPASS),
    D(L, 'ansi-c', `git -c $'${K}=/dev/null' ${C}`, EFFECT_BYPASS),
    D(L, 'ansi-c hex', `git -c $'core.hooks\\x50ath=/dev/null' ${C}`, EFFECT_BYPASS),
    D(R, 'partial quote', `git -c "core.hooks"Path=/dev/null ${C}`, EFFECT_BYPASS),
    D(L, 'partial subst', `git -c core.hooks$(echo Path)=/dev/null ${C}`, EFFECT_BYPASS),
    D(R, 'backslash', `git -c core.hooks\\Path=/dev/null ${C}`, EFFECT_BYPASS),
    D(O, 'printf -v', `printf -v ${PK} "'${K}=/dev/null'"; export ${PK}; git ${C}`, EFFECT_BYPASS),
    D(O, 'read', `read ${PK} <<< "'${K}=/dev/null'"; export ${PK}; git ${C}`, EFFECT_BYPASS),
    D(O, 'export +=', `export ${VK}+=-nope; git ${C}`, EFFECT_BYPASS),
    D(O, 'for', `for ${VK} in /dev/null; do export ${VK}; git ${C}; done`, EFFECT_BYPASS),
    D(O, 'bare export', `${VK}=/dev/null; export ${VK}; git ${C}`, EFFECT_BYPASS),
    D(O, 'export --', `export -- ${VK}=/dev/null; git ${C}`, EFFECT_BYPASS),
    D(O, 'declare -gx', `declare -gx ${VK}=/dev/null; git ${C}`, EFFECT_BYPASS),
    D(O, 'env --chdir', `env --chdir=. ${VK}=/dev/null git ${C}`, EFFECT_BYPASS),
    D(O, 'built key', `n=0; export GIT_CONFIG_VALUE_$n=/dev/null; git ${C}`, EFFECT_BYPASS),
    D(O, 'built key brace', `n=VALUE_0; export GIT_CONFIG_\${n}=/dev/null; git ${C}`, EFFECT_BYPASS),
    D(R, 'pipe', `true | git -c ${K}=/dev/null ${C}`, EFFECT_BYPASS),
    D(R, 'exec', `exec git -c ${K}=/dev/null ${C}`, EFFECT_BYPASS),
    D(R, 'stdbuf', `stdbuf -o0 git -c ${K}=/dev/null ${C}`, EFFECT_BYPASS),
    D(R, 'timeout', `timeout 9 git -c ${K}=/dev/null ${C}`, EFFECT_BYPASS),
    D(R, 'env -C', `env -C . git -c ${K}=/dev/null ${C}`, EFFECT_BYPASS),
    D(R, 'git-dir other', `git --git-dir=${other}/.git --work-tree=. ${C}`, EFFECT_OTHER),
    D(R, 'git-dir sp', `git --git-dir ${other}/.git --work-tree . ${C}`, EFFECT_OTHER),
    D(R, 'GIT_DIR', `GIT_DIR=${other}/.git GIT_WORK_TREE=. git ${C}`, EFFECT_OTHER),
    D(R, 'GIT_COMMON_DIR', `GIT_COMMON_DIR=${other}/.git git ${C}`, EFFECT_NONE),
    D(R, 'work-tree empty', `git --work-tree=${emptyDir} ${C}`, EFFECT_BYPASS),
    D(R, 'GIT_WORK_TREE empty', `GIT_WORK_TREE=${emptyDir} git ${C}`, EFFECT_BYPASS),
    D(O, 'chain write restore', `git config ${K} /dev/null && git ${C}; git config ${K} .githooks`, EFFECT_BYPASS),
    D(O, 'chain unset', `git config --unset ${K} && git ${C}; git config ${K} .githooks`, EFFECT_BYPASS),
    D(O, 'chain -c x config', `git -c x.y=z config ${K} /dev/null && git ${C}; git config ${K} .githooks`, EFFECT_BYPASS),
    D(O, 'chain include write', `git config include.path ${evil} && git ${C}; git config --unset include.path`, EFFECT_BYPASS),
    D(R, 'after --no-pager', `git --no-pager -c ${K}=/dev/null ${C}`, EFFECT_BYPASS),
    D(R, 'after -p', `git -p -c ${K}=/dev/null ${C} | cat`, EFFECT_BYPASS),
    D(R, 'after -C', `git -C . -c ${K}=/dev/null ${C}`, EFFECT_BYPASS),
    D(R, 'CASE key', `git -c CORE.HOOKSPATH=/dev/null ${C}`, EFFECT_BYPASS),
    D(R, '-c k no value', `git -c ${K} ${C}`, EFFECT_NONE),
    D(R, '-c k= empty', `git -c ${K}= ${C}`, EFFECT_BYPASS),
    D(R, 'repeat good then bad', `git -c ${K}=.githooks -c ${K}=/dev/null ${C}`, EFFECT_BYPASS),
    D(R, 'repeat bad then good', `git -c ${K}=/dev/null -c ${K}=.githooks ${C}`, EFFECT_HOOK),
    D(R, '--config-env=', `git --config-env=${K}=HOME ${C}`, EFFECT_BYPASS),
    D(R, '--config-env sp', `git --config-env ${K}=HOME ${C}`, EFFECT_BYPASS),
    D(L, 'quoted var key', `K=${K}; git -c "$K=/dev/null" ${C}`, EFFECT_BYPASS),
    D(R, 'command', `command git -c ${K}=/dev/null ${C}`, EFFECT_BYPASS),
    D(R, 'env', `env git -c ${K}=/dev/null ${C}`, EFFECT_BYPASS),
    // The wrapper's own -n reads as the flag to ENF-12, so these two get its text, not this rule's.
    D(ENF12_TEXT, 'sudo -n', `sudo -n git -c ${K}=/dev/null ${C}`, null),
    D(ENF12_TEXT, 'nice -n', `nice -n 5 git -c ${K}=/dev/null ${C}`, EFFECT_BYPASS),
    D(R, 'sudo', `sudo git -c ${K}=/dev/null ${C}`, null),
    D(R, 'nice', `nice git -c ${K}=/dev/null ${C}`, EFFECT_BYPASS),
    D(R, 'abs path', `/usr/bin/git -c ${K}=/dev/null ${C}`, fs.existsSync('/usr/bin/git') ? EFFECT_BYPASS : null),
    D(O, 'leading key', `${VK}=/dev/null git ${C}`, EFFECT_BYPASS),
    D(O, 'env key', `env ${VK}=/dev/null git ${C}`, EFFECT_BYPASS),
    D(O, 'env -i key', `env -i PATH="$PATH" ${CK}=1 GIT_CONFIG_KEY_0=${K} ${VK}=/dev/null git ${C}`, null),
    D(O, 'export key', `export ${VK}=/dev/null; git ${C}`, EFFECT_BYPASS),
    D(O, 'typeset -x', `typeset -x ${VK}=/dev/null; git ${C}`, EFFECT_BYPASS),
    D(O, 'readonly', `export ${VK}; readonly ${VK}=/dev/null; git ${C}`, EFFECT_BYPASS),
    D(R, 'env GIT_DIR', `env GIT_DIR=${other}/.git GIT_WORK_TREE=. git ${C}`, EFFECT_OTHER),
    D(O, 'config set', `git config set ${K} /dev/null && git ${C}`, null),
    D(O, 'config --show-scope write', `git config --show-scope ${K} /dev/null && git ${C}; git config ${K} .githooks`, EFFECT_BYPASS),
    D(R, '-c log grep (accepted false deny)', `git -c ${K}=/dev/null log --grep commit`, EFFECT_NONE),
    D(O, 'newline key line', `${VK}=/dev/null\nexport ${VK}\ngit ${C}`, EFFECT_BYPASS),
    D(R, 'newline override', `cd .\ngit -c ${K}=/dev/null ${C}`, EFFECT_BYPASS),
    // AMENDMENT-1 A-7: the bank wanted this reported. The split tokens reach the region, so it denies.
    D(R, 'subst -C word split', `git -C $(echo . -c ${K}=/dev/null) ${C}`, EFFECT_BYPASS),

    N('-C dir push', 'git -C . push origin x', EFFECT_NONE),
    N('trailing push -c', `git push -c ${K}=/dev/null`, EFFECT_NONE),
    N('config get', `git config get ${K}; git ${C}`, EFFECT_HOOK),
    N('SYSTEM', `GIT_CONFIG_SYSTEM=${evil} git ${C}`, EFFECT_HOOK),
    N('MY_ prefix', `MY_${CK}=1 git ${C}`, EFFECT_HOOK),
    N('COUNTER', `${CK}ER=1 git ${C}`, EFFECT_HOOK),
    N('show HEAD:commit', `git -c ${K}=/dev/null show HEAD:commit >/dev/null 2>&1; git ${C}`, EFFECT_HOOK),
    N('plain', `git ${C}`, EFFECT_HOOK),
    N('attached -c', `git -c${K}=/dev/null ${C}`, EFFECT_NONE),
    N('sub -c', `git commit -c HEAD --allow-empty -m x`, EFFECT_NONE),
    N('k=.githooks', `git -c ${K}=.githooks ${C}`, EFFECT_HOOK),
    N('user.name', `git -c user.name=x ${C}`, EFFECT_HOOK),
    N('gpgsign', `git -c commit.gpgsign=false ${C}`, EFFECT_HOOK),
    N('-C $WT', `WT=.; git -C "$WT" ${C}`, EFFECT_HOOK),
    N('-C subst', `git -C "$(pwd)" ${C}`, EFFECT_HOOK),
    N('-C dir', `git -C . ${C}`, EFFECT_HOOK),
    N('namespace=$N', `N=x; git --namespace=$N ${C}`, EFFECT_HOOK),
    N('GLOBAL', `GIT_CONFIG_GLOBAL=${evil} git ${C}`, EFFECT_HOOK),
    N('message text -c', `git commit --allow-empty -m "-c ${K}=/dev/null"`, EFFECT_HOOK),
    N('message key', `git commit --allow-empty -m "${VK}=v"`, EFFECT_HOOK),
    N('message expansion', `M=x; git commit --allow-empty -m "$M"`, EFFECT_HOOK),
    N('heredoc message', `git commit --allow-empty -m "$(cat <<'EOF'\nfix commit push $X -c ${K}=y ${VK}=z\n\nmore commit\nEOF\n)"`, EFFECT_HOOK),
    N('heredoc -F', `git commit --allow-empty -F - <<'EOF'\n-c ${K}=x commit\n${VK}=z\nEOF`, EFFECT_HOOK),
    N('heredoc cat before', `cat > /dev/null <<'EOF'\n${VK}=1\nEOF\ngit ${C}`, EFFECT_HOOK),
    N('newline message key', `cd .\ngit commit --allow-empty -m "${VK}=v"`, EFFECT_HOOK),
    N('multiline message key', `git commit --allow-empty -m "line1\n${VK}=v"`, EFFECT_HOOK),
    N('multiline message git -c', `git commit --allow-empty -m "line1\ngit -c ${K}=/dev/null commit"`, EFFECT_HOOK),
    N('newline add then commit', `f=x\ngit add "$f" 2>/dev/null\ngit ${C}`, EFFECT_HOOK),
    N('newline expansion neighbor', `git log -1 "$X" >/dev/null 2>&1\ngit ${C}`, EFFECT_HOOK),
    N('newline -c neighbor', `git -c ${K}=/dev/null status >/dev/null\ngit ${C}`, EFFECT_HOOK),
    N('newline cd "$WT"', `WT=.\ncd "$WT"\ngit ${C}`, EFFECT_HOOK),
    // AMENDMENT-1 A-4: the scan stops at a comment token. The bank's older want was a false deny.
    N('comment naming key (A-4)', `# ${VK}\ngit ${C}`, EFFECT_HOOK),
    N('config read --get', `git config --get ${K} && git ${C}`, EFFECT_HOOK),
    N('config read --list', `git config --list --show-scope >/dev/null && git ${C}`, EFFECT_HOOK),
    N('config bare key read', `git config ${K} && git ${C}`, EFFECT_HOOK),
    N('config advised fix', `git config ${K} .githooks && git ${C}`, EFFECT_HOOK),
    N('neighbor -c status', `git -c ${K}=/dev/null status >/dev/null; git ${C}`, EFFECT_HOOK),
    N('neighbor --git-dir', `git --git-dir=.git status >/dev/null; git ${C}`, EFFECT_HOOK),
    N('neighbor expansion', `git log -1 "$X" >/dev/null 2>&1; git ${C}`, EFFECT_HOOK),
    N('trailing -c on commit', 'git commit --allow-empty -m x -c', EFFECT_NONE),
    // Quick 261104-ov8: these denied as accepted false denies under CTK-ADR-0015; CTK-ADR-0016 allows them.
    N('env -u', `env -u ${CK} git ${C}`, EFFECT_HOOK),
    N('unset', `unset ${CK}; git ${C}`, EFFECT_HOOK),
    N('echo key', `echo ${VK}=v && git ${C}`, EFFECT_HOOK),
    N('grep key', `grep ${VK} /dev/null; git ${C}`, EFFECT_HOOK),
    N('-c user.name=$N', `N=x; git -c user.name=$N ${C}`, EFFECT_HOOK),
    N('config-env value expansion', `V=HOME; git --config-env user.name=$V ${C}`, EFFECT_HOOK),
    N('url at', `git -c 'url.git@x:.insteadOf=y' push origin x`, EFFECT_NONE),
    N('http header', `T=x; git -c "http.extraHeader=A: $T" push origin x`, EFFECT_NONE),
    N('msg then push', `M=x; git commit --allow-empty -m "$M" -m push`, EFFECT_HOOK),
    N('push commit', `R=origin; git push "$R" commit`, EFFECT_NONE),
    N('add commit', `f=x; git add "$f" commit`, EFFECT_NONE),
    N('diff commit', `A=HEAD; git diff "$A" -- commit`, EFFECT_NONE),
    N('log push', `R=HEAD; git log "$R" -- push`, EFFECT_NONE),
    N('gh body', `gh pr comment 1 --body "${CK} x" && git push origin x`, null),
  ];
}

/** Each row's verdict in both states and, one at a time, its real effect. Returns what differs. */
async function bankMismatches(fx, rows) {
  const plain = await inPool(rows, (row) => runHookAsync(fx.repo, fx.plain, row.command));
  const behind = await inPool(rows, (row) => runHookAsync(fx.repo, fx.behind, row.command));
  const wrong = [];
  rows.forEach((row, at) => {
    for (const [state, verdict] of [['plain', plain[at]], ['dispatcher', behind[at]]]) {
      if (verdict.decision !== row.want) {
        wrong.push(`${row.name}, ${state}: ${verdict.decision}, want ${row.want}: ${verdict.reason || ''}`);
      } else if (row.want === 'deny' && row.advice === ENF12_TEXT) {
        if (!ENF12_TEXT.test(verdict.reason)) wrong.push(`${row.name}, ${state} text: ${verdict.reason}`);
      } else if (row.want === 'deny') {
        const texts = [/\(ENF-13\)$/, /`git config core\.hooksPath \.githooks` is not the fix/, row.advice];
        if (!texts.every((text) => text.test(verdict.reason))) wrong.push(`${row.name}, ${state} text: ${verdict.reason}`);
        if (/INERT/.test(verdict.reason) || VALVE_NAME.test(verdict.reason)) wrong.push(`${row.name}, ${state} text: ${verdict.reason}`);
      }
    }
    if (row.effect !== null) {
      const effect = bankEffect(fx, row.command);
      if (effect !== row.effect) wrong.push(`${row.name}, real effect: ${effect}, want ${row.effect}`);
    }
  });
  return wrong;
}

test('shape bank, deny rows: each denies in both states, with its advice, and its real effect is as measured', async (t) => {
  const fx = buildBankFixture(t);
  assert.deepStrictEqual(await bankMismatches(fx, bankRows(fx).filter((row) => row.want === 'deny')), []);
});

test('shape bank, not-a-deny rows: each allows in both states, and its real effect is as measured', async (t) => {
  const fx = buildBankFixture(t);
  assert.deepStrictEqual(await bankMismatches(fx, bankRows(fx).filter((row) => row.want === 'allow')), []);
});

// --- Quick 261104-ov8: rows for the mask, the views, the region and the key rule. ---------------

/** The row helpers of the ov8 groups: K, VK, CK, C and O as the review files write them, G a whole commit. */
function ov8Words() {
  const K = ENF13_K;
  const C = 'commit --allow-empty -m x';
  const D = (advice, command, effect) => ({ want: 'deny', advice, name: command, command, effect });
  const N = (command, effect) => ({ want: 'allow', name: command, command, effect });
  return {
    K,
    C,
    D,
    N,
    VK: 'GIT_CONFIG_VALUE_0',
    CK: 'GIT_CONFIG_COUNT',
    O: `-c ${K}=/dev/null`,
    G: `git ${C}`,
    message: (line) => `git commit --allow-empty -m "$(cat <<'EOF'\n${line}\nEOF\n)"`,
  };
}

test('ov8 enf12: the real flag keeps its text on commit and push, chained and wrapped; a neighbor and a message do not read as it', async (t) => {
  const fx = buildBankFixture(t);
  const { D, N, G } = ov8Words();
  assert.deepStrictEqual(await bankMismatches(fx, [
    D(ENF12_TEXT, 'git commit --no-verify --allow-empty -m x', EFFECT_BYPASS),
    D(ENF12_TEXT, 'git commit -n --allow-empty -m x', EFFECT_BYPASS),
    D(ENF12_TEXT, 'git push --no-verify origin x', null),
    D(ENF12_TEXT, 'git push -n origin x', null),
    D(ENF12_TEXT, 'git status && git commit --no-verify --allow-empty -m x', EFFECT_BYPASS),
    D(ENF12_TEXT, 'git status; git commit -n --allow-empty -m x', EFFECT_BYPASS),
    D(ENF12_TEXT, `${G} && git push --no-verify origin x`, null),
    D(ENF12_TEXT, `nice -n 5 ${G}`, EFFECT_HOOK),
    N(`grep -n x /dev/null; ${G}`, EFFECT_HOOK),
    N(`tail -n 1 /dev/null; ${G}`, EFFECT_HOOK),
    N('git commit --allow-empty -m "never --no-verify"', EFFECT_HOOK),
  ]), []);
});

test('ov8 mask: a comment goes only when its line holds no delimiter and no ${ is open; continuations leave nothing', async (t) => {
  const fx = buildBankFixture(t);
  const { K, C, D, N, VK, CK, O, G, message } = ov8Words();
  const R = ADVICE_REMOVE;
  const OWN = ADVICE_OWN_CALL;
  assert.deepStrictEqual(await bankMismatches(fx, [
    // The mask's flat quote state differs from bash here: a hash it would call a comment is text to bash.
    D(R, `echo "$(echo "a #b")"; git ${O} ${C}`, EFFECT_BYPASS),
    D(R, `echo "\${x:-"a #b"}"; git ${O} ${C}`, EFFECT_BYPASS),
    D(OWN, `x="$(printf "%s" "a #b")"; ${VK}=/dev/null; ${G}`, EFFECT_BYPASS),
    D(R, `echo $'a\\' #b'; echo \\'; git ${O} ${C}`, EFFECT_BYPASS),
    D(R, `(( 1 #2 )); git ${O} ${C}`, EFFECT_BYPASS),
    // The closing } is on the next line, so the text rule alone would hide the override.
    D(R, `git -C \${y:-. --namespace #x ${O} ${C}\n}`, EFFECT_BYPASS),
    D(R, `mkdir -p "#b"\ngit -C \${y:- #b ${O} ${C}\n}\nrmdir "#b"`, EFFECT_BYPASS),
    D(R, `echo \${x:- #y}; git ${O} ${C}`, EFFECT_BYPASS),
    // A heredoc message holding a quote and a hash: no refusal, the hook runs.
    N(message('fix "issue #12 ok" again'), EFFECT_HOOK),
    N(message('see "a" and "b #2"'), EFFECT_HOOK),
    N(message('- rename "foo #1" to "bar"'), EFFECT_HOOK),
    N(message('closes #12'), EFFECT_HOOK),
    // A text that masks to nothing is no hit and no refusal.
    N('# git commit -m x', EFFECT_NONE),
    N('# then git push origin x', EFFECT_NONE),
    N('# just a note', EFFECT_NONE),
    // A comment operator is no operator, so the next line is read.
    D(R, `# <<EOF\ngit ${O} ${C}`, EFFECT_BYPASS),
    D(R, `# x \\\ngit ${O} ${C}`, EFFECT_BYPASS),
    // The top-level refusal keeps one real input; bash exits 2 on it.
    D(OWN, "# <<EOF\nit's\nEOF\ngit commit -m x", EFFECT_NONE),
    N("# <<EOF\nit's\nEOF\ngit status", EFFECT_NONE),
    N("# it's\necho 'y\ngit commit -m x", EFFECT_NONE),
    // A hash touching a word is not a comment.
    D(R, `git -c user.name=a\\ #b ${O} ${C}`, EFFECT_BYPASS),
    D(R, `git -c user.name="a"#b ${O} ${C}`, EFFECT_BYPASS),
    // A quoted hash is a value, wherever it sits.
    D(R, `git > "#x" ${O} ${C}; rm -f "#x"`, EFFECT_BYPASS),
    D(OWN, `git config > "#x" ${K} /dev/null && ${G}; rm -f "#x"`, EFFECT_BYPASS),
    D(R, `git --shallow-file "#x" ${O} ${C}`, EFFECT_BYPASS),
    N('git commit --allow-empty -m "#1 fix"', EFFECT_HOOK),
    N('git -C "#dir" commit --allow-empty -m x', EFFECT_NONE),
    // A comment that goes with its text, and PA-1's rows, which D5 would have denied.
    N(`${G} # then push`, EFFECT_HOOK),
    N(`# ${VK}\n${G}`, EFFECT_HOOK),
    N(`git status # ${CK}\n${G}`, EFFECT_HOOK),
    N(`echo ok # note; ${G}`, EFFECT_NONE),
    N('git status # note; git push origin x', EFFECT_NONE),
    N('git\ncommit --allow-empty -m x', EFFECT_NONE),
    // Between a read and a commit: a blank line, a comment line, a continuation then a blank line.
    N(`git status\n\n${G}`, EFFECT_HOOK),
    N(`git status\n# note\n${G}`, EFFECT_HOOK),
    N(`git status \\\n\n${G}`, EFFECT_HOOK),
    N(`git add a \\\n\n${G}`, EFFECT_HOOK),
    N(`git log \\\n\n${G}`, EFFECT_HOOK),
    // A non-ASCII character moves no state.
    N('git commit --allow-empty -m "café #1" # café note', EFFECT_HOOK),
    D(R, `echo "café" # café note\ngit ${O} ${C}`, EFFECT_BYPASS),
    D(R, `git -c user.name=café ${O} ${C}`, EFFECT_BYPASS),
    // Accepted false denies, CTK-ADR-0016: a kept comment reads as tokens. The hook runs on each.
    D(OWN, `# ${VK} (see notes)\n${G}`, EFFECT_HOOK),
    D(OWN, `export FOO=1 # ${VK} (note)\n${G}`, EFFECT_HOOK),
    D(OWN, `cd . # ${CK} is (not) set\n${G}`, EFFECT_HOOK),
    // Denies as at base, and bash runs nothing past the hash: a kept comment, not a removed false deny.
    D(R, `echo ok # note; git ${O} ${C}`, EFFECT_NONE),
  ]), []);
});

test('ov8 views: an override in a compound form or a literal payload denies; the same forms with none allow', async (t) => {
  const fx = buildBankFixture(t);
  const { K, C, D, N, O, G } = ov8Words();
  const R = ADVICE_REMOVE;
  const OWN = ADVICE_OWN_CALL;
  assert.deepStrictEqual(await bankMismatches(fx, [
    D(R, `( git ${O} ${C} )`, EFFECT_BYPASS),
    D(R, `(git ${O} ${C})`, EFFECT_BYPASS),
    D(R, `{ git ${O} ${C}; }`, EFFECT_BYPASS),
    D(R, `if true; then git ${O} ${C}; fi`, EFFECT_BYPASS),
    D(R, `if git ${O} ${C}; then :; fi`, EFFECT_BYPASS),
    D(R, `for i in 1; do git ${O} ${C}; done`, EFFECT_BYPASS),
    D(R, `n=0; while [ $n -lt 1 ]; do git ${O} ${C}; n=1; done`, EFFECT_BYPASS),
    D(R, `time git ${O} ${C}`, EFFECT_BYPASS),
    D(R, `! git ${O} ${C}`, EFFECT_BYPASS),
    D(R, `echo $(git ${O} ${C})`, EFFECT_BYPASS),
    D(R, `x=$(git ${O} ${C})`, EFFECT_BYPASS),
    D(R, `echo \`git ${O} ${C}\``, EFFECT_BYPASS),
    D(R, `nohup git ${O} ${C} >/dev/null 2>&1`, EFFECT_BYPASS),
    D(R, `true | xargs git ${O} ${C}`, EFFECT_BYPASS),
    D(R, `setsid -w git ${O} ${C}`, EFFECT_BYPASS),
    D(R, `case x in x) git ${O} ${C};; esac`, EFFECT_BYPASS),
    D(R, `f() { git ${O} ${C}; }; f`, EFFECT_BYPASS),
    D(R, `2>/dev/null git ${O} ${C}`, EFFECT_BYPASS),
    D(R, `</dev/null git ${O} ${C}`, EFFECT_BYPASS),
    D(R, `git ${O} commit>/dev/null --allow-empty -m x`, EFFECT_BYPASS),
    D(R, `( git $X ${O} ${C} )`, EFFECT_BYPASS),
    D(R, `env "#a=b" git ${O} ${C}`, EFFECT_BYPASS),
    D(R, `git submodule foreach git ${O} commit`, EFFECT_NONE),
    // A located git carries the repo assignment and the config write rules too.
    D(R, `( GIT_DIR=/nonexistent git ${C} )`, EFFECT_NONE),
    D(R, `(GIT_DIR=/nonexistent git ${C})`, EFFECT_NONE),
    D(R, `builtin command git ${O} ${C}`, EFFECT_BYPASS),
    D(R, `(bash -c 'git ${O} ${C}')`, EFFECT_BYPASS),
    D(OWN, `( git config ${K} /dev/null; ${G} )`, EFFECT_BYPASS),
    // Payloads, read to depth 3.
    D(R, `bash -c 'git ${O} ${C}'`, EFFECT_BYPASS),
    D(R, `sh -c 'git ${O} ${C}'`, EFFECT_BYPASS),
    D(R, `/bin/sh -c 'git ${O} ${C}'`, EFFECT_BYPASS),
    D(R, `bash -lc 'git ${O} ${C}'`, EFFECT_BYPASS),
    D(R, `bash -ce 'git ${O} ${C}'`, EFFECT_BYPASS),
    D(R, `bash -c -- 'git ${O} ${C}'`, EFFECT_BYPASS),
    D(R, `bash --norc -c 'git ${O} ${C}'`, EFFECT_BYPASS),
    D(R, `eval 'git ${O} ${C}'`, EFFECT_BYPASS),
    D(R, `eval git ${O} ${C}`, EFFECT_BYPASS),
    D(R, `eval eval eval git ${O} ${C}`, EFFECT_BYPASS),
    D(R, `eval eval eval eval eval git ${O} ${C}`, EFFECT_BYPASS),
    // Past the bound, with no typed form to see: refused, no throw.
    D(OWN, `eval eval eval eval eval ${G}`, EFFECT_HOOK),
    N(`bash -c '# git commit'`, EFFECT_NONE),
    N('eval "# git push"', EFFECT_NONE),
    N(`bash -c '${G}'`, EFFECT_HOOK),
    N(`bash -c 'cd . && git status'`, EFFECT_NONE),
    N(`eval "$(ssh-agent)"; ${G}`, null),
    // Compound forms with no override.
    N(`time ${G}`, EFFECT_HOOK),
    N(`( cd . && ${G} )`, EFFECT_HOOK),
    N(`{ ${G}; }`, EFFECT_HOOK),
    N(`if ${G}; then :; fi`, EFFECT_HOOK),
    N(`cd . && ${G}`, EFFECT_HOOK),
    N(`git status; git diff --stat; git log -n 1 | head -1; ${G}`, EFFECT_HOOK),
    N(`git -C "$(git rev-parse --show-toplevel)" ${C}`, EFFECT_HOOK),
    N(`git commit --allow-empty -F - <<'EOF'\nfix: one commit\nEOF`, EFFECT_HOOK),
    N(`for f in git commit; do :; done; ${G}`, EFFECT_HOOK),
    N('grep -c git commit', EFFECT_NONE),
    N('command -v git', EFFECT_NONE),
    N('gh pr comment 1 --body "run git commit -c x"', null),
    // The spelling rule reads a resolved git only.
    N(`echo git commit -n; ${G}`, EFFECT_HOOK),
    // Accepted false denies, CTK-ADR-0016: text only, a located git beside a sealed segment. The hook runs.
    D(R, `echo git ${O} commit; ${G}`, EFFECT_HOOK),
    // The verdict does not depend on the order of forms in a chain.
    D(R, `git ${O} ${C}; git status`, EFFECT_BYPASS),
    D(R, `git status; git ${O} ${C}`, EFFECT_BYPASS),
  ]), []);
});

test('ov8 region: the named rules read the whole region, the generic rule stops at the subcommand, and no value is read for syntax', async (t) => {
  const fx = buildBankFixture(t);
  const { K, C, D, N, CK, O, G } = ov8Words();
  const R = ADVICE_REMOVE;
  const L = ADVICE_LITERAL;
  const rows = [
    // A shifted walk or an unbalanced value cannot open a named form.
    D(R, `git --namespace ">x" ${O} ${C}`, EFFECT_BYPASS),
    D(R, `git --namespace ">" ${O} ${C}`, EFFECT_BYPASS),
    D(R, `git --namespace <(true) ${O} ${C}`, EFFECT_BYPASS),
    D(R, `git --namespace <(echo a b) ${O} ${C}`, EFFECT_BYPASS),
    D(R, `git > /dev/null ${O} ${C}`, EFFECT_BYPASS),
    D(R, `git 2>/dev/null ${O} ${C}`, EFFECT_BYPASS),
    D(R, `git <<< x ${O} ${C}`, EFFECT_BYPASS),
    D(R, `X=.; git -C \${X:-. foo} ${O} ${C}`, EFFECT_BYPASS),
    D(R, `N=x; git -c user.name=\${N:-a b} ${O} ${C}`, EFFECT_BYPASS),
    D(R, `N=x; git --namespace=\${N:-a b} ${O} ${C}`, EFFECT_BYPASS),
    D(R, `git -C \`echo . ${O}\` ${C}`, EFFECT_BYPASS),
    D(R, `git -C $(echo . ${O}) ${C}`, EFFECT_BYPASS),
    D(R, `git -c user.name=$(echo x ${O}) ${C}`, EFFECT_BYPASS),
    D(R, `git --namespace "(" --config-env=${K}=HOME ${C}`, EFFECT_BYPASS),
    D(R, `git --namespace "(" --git-dir=.git ${C}`, EFFECT_HOOK),
    D(R, `git "" ${O} ${C}`, EFFECT_NONE),
    // An accepted false deny, CTK-ADR-0016: a kept comment reads as tokens, to the last sealing word. The hook runs.
    D(R, `${G} # see (git ${O} commit)`, EFFECT_HOOK),
    // The comment stays while the ${ is open, and the named rule reads past the option that shifted the walk.
    D(R, `git \${y:- --namespace #x ${O} ${C}\n}`, EFFECT_BYPASS),
    D(R, `git \${y:- --attr-source #x ${O} ${C}\n}`, EFFECT_BYPASS),
    // The named rules keep the sealing word wide.
    D(R, `git ${O} stash push`, EFFECT_NONE),
    D(R, `git ${O} subtree push`, null),
    D(R, `git ${O} log --grep commit`, EFFECT_NONE),
    D(R, `V=/dev/null; git -c ${K}="$V" ${C}`, EFFECT_BYPASS),
    // A key the gate cannot read: a glob, a non-ASCII byte. A glob matching a file names the key.
    D(L, `touch ./${K}=; git -c core.hooks* ${C}; rm -f ./${K}=`, EFFECT_BYPASS),
    D(L, 'git -c café.x=y commit --allow-empty -m x', EFFECT_NONE),
    // The generic rule still reads git's own option list, up to and including the subcommand word.
    D(L, `O="${O}"; git $O ${C}`, EFFECT_BYPASS),
    D(L, `git {-c,${K}=/dev/null} ${C}`, EFFECT_BYPASS),
    // Reads after the subcommand: Minor 5.
    N('B=HEAD; git log "$B"..HEAD --grep commit', EFFECT_NONE),
    N('B=HEAD; git log "$B"..HEAD -- commit', EFFECT_NONE),
    N('S=HEAD; git show "$S" -- commit', EFFECT_NONE),
    N('A=HEAD; git diff "$A" "$A" -- commit', EFFECT_NONE),
    N('X=HEAD; git rev-parse "$X" commit', EFFECT_NONE),
    N('X=nobranch; git branch -D "$X" commit', EFFECT_NONE),
    N('X=HEAD; git checkout "$X" -- commit', EFFECT_NONE),
    N('f=x; git add "$f" commit', EFFECT_NONE),
    N('git tag -a v1 -m "$(echo x)" commit; git tag -d v1', EFFECT_NONE),
    N('R=origin; git push "$R" commit', EFFECT_NONE),
    N('M=x; git commit --allow-empty -m "$M" -m commit', EFFECT_HOOK),
    N('M=x; git commit --allow-empty -m "$M" -m push', EFFECT_HOOK),
    // Values: Minor 5 and Minor 4. The two forms the deny text names allow and work.
    N(`N=x; git -c user.name="$N" ${C}`, EFFECT_HOOK),
    N(`N=x; git -c user.name=$N ${C}`, EFFECT_HOOK),
    N(`V=HOME; git --config-env user.name=$V ${C}`, EFFECT_HOOK),
    N(`HDR=x git --config-env=http.extraHeader=HDR ${C}`, EFFECT_HOOK),
    N(`I=x; git -c core.sshCommand="ssh -i $I" ${C}`, EFFECT_HOOK),
    N('T=x; git -c "http.extraHeader=Authorization: Bearer $T" push origin x', EFFECT_NONE),
    N(`git -c "http.extraHeader=Authorization: Bearer abc" ${C}`, EFFECT_HOOK),
    N('git -c url.git@github.com:.insteadOf=https://github.com/ push origin x', EFFECT_NONE),
    N(`git -C $(git rev-parse --show-toplevel) ${C}`, EFFECT_HOOK),
    N(`git -C \`git rev-parse --show-toplevel\` ${C}`, EFFECT_HOOK),
    N(`git -c user.name=x -C "$PWD" ${C}`, EFFECT_HOOK),
    N(`git -c user.name=${CK} ${C}`, EFFECT_HOOK),
    N(`git status --short; ${G}`, EFFECT_HOOK),
  ];
  assert.deepStrictEqual(await bankMismatches(fx, rows), []);
  // No deny text tells a reader to write a value out, and the advice names both forms with the right use.
  for (const row of rows.filter((r) => r.want === 'deny')) {
    const { reason } = await runHookAsync(fx.repo, fx.behind, row.command);
    assert.doesNotMatch(reason, /literally/, row.command);
  }
  const { reason } = await runHookAsync(fx.repo, fx.behind, 'git $O commit -m x');
  assert.match(reason, /secret config value goes through `--config-env=<key>=<ENVVAR>`/);
  assert.match(reason, /`-c <key>="\$VALUE"` is for a value that is not secret/);
  assert.match(reason, /^[\x20-\x7e]*$/);
});

test('ov8 fix round: a split value is no walk stop, a compound message is no key name, payload options are skipped', async (t) => {
  const fx = buildBankFixture(t);
  const { K, C, D, N, VK, O, G, message } = ov8Words();
  assert.deepStrictEqual(await bankMismatches(fx, [
    // A value the parser split must not end git's option list early: classifyAction reads this as other.
    D(ADVICE_LITERAL, 'git -c user.name=$(echo a) commit --no-verify --allow-empty -m x', EFFECT_BYPASS),
    D(ADVICE_LITERAL, 'git -c user.name=$(echo a) commit -n --allow-empty -m x', EFFECT_BYPASS),
    D(ADVICE_LITERAL, `git -c user.name=$(echo a) ${C}`, EFFECT_HOOK),
    D(ADVICE_LITERAL, `git --config-env user.name=$(echo a) ${C}`, null),
    D(ADVICE_LITERAL, `git --config-env=user.name=$(echo a) ${C}`, null),
    D(ADVICE_LITERAL, `O='${O}'; git -c user.name=$(echo a) $O ${C}`, EFFECT_BYPASS),
    N(`git -c user.name="$(echo a)" ${C}`, EFFECT_HOOK),
    N(`git -c user.name=$(echo a) status`, null),
    N(`git -C $(git rev-parse --show-toplevel) ${C}`, EFFECT_HOOK),
    // A message is read after the last sealing word, in a compound form too.
    N(`( git commit --allow-empty -m "doc: ${VK} named" )`, EFFECT_HOOK),
    N(`{ git commit --allow-empty -m "doc: ${VK} named"; }`, EFFECT_HOOK),
    N(`if true; then git commit --allow-empty -m "doc: ${VK} named"; fi`, EFFECT_HOOK),
    N(`time git commit --allow-empty -m "doc: ${VK} named"`, EFFECT_HOOK),
    N(`( ${message(`body names ${VK} and ${K}`)} )`, EFFECT_HOOK),
    D(ADVICE_REMOVE, `( ${VK}=/dev/null ${G} )`, EFFECT_BYPASS),
    // A shell's options after -c are not its text.
    D(ADVICE_REMOVE, `bash -c -e 'git ${O} ${C}'`, EFFECT_BYPASS),
    D(ADVICE_REMOVE, `bash -c -x 'git ${O} ${C}'`, EFFECT_BYPASS),
    D(ADVICE_REMOVE, `bash -c -- 'git ${O} ${C}'`, EFFECT_BYPASS),
    N(`bash -c -e '${G}'`, EFFECT_HOOK),
    // A key name on the git segment itself still denies alone in a call, so the advice is to remove it.
    D(ADVICE_REMOVE, `${VK}=/dev/null ${G}`, EFFECT_BYPASS),
    D(ADVICE_REMOVE, 'git -c user.name=$((GIT_CONFIG_VALUE_0=1)) commit --allow-empty -m x', EFFECT_BYPASS),
  ]), []);
});

test('ov8 fix round: a long paren run in a token stays a linear read of the sealing word', () => {
  const started = Date.now();
  const parens = ')'.repeat(50000);
  const parsed = require('./lib/argv.cjs').parseCommandForGates(`git status "${parens}\n"`);
  const hit = require('./githooks-seal.cjs').typedHooksPathOverride(parsed);
  assert.strictEqual(hit, null);
  assert.ok(Date.now() - started < 400, 'the scan of one token took ' + (Date.now() - started) + ' ms');
});

test('ov8 keys: an env key name denies unless a listed reader or an unset holds it plainly', async (t) => {
  const fx = buildBankFixture(t);
  const { K, C, D, N, VK, CK, G } = ov8Words();
  const OWN = ADVICE_OWN_CALL;
  assert.deepStrictEqual(await bankMismatches(fx, [
    // Setters no list names, and assignments run from text.
    D(OWN, `let ${VK}=1; ${G}`, EFFECT_BYPASS),
    D(OWN, `(( ${VK} = 1 )); ${G}`, EFFECT_BYPASS),
    D(OWN, `getopts a ${VK}; ${G}`, EFFECT_BYPASS),
    D(OWN, `exec {${VK}}>/dev/null; ${G}`, EFFECT_BYPASS),
    D(OWN, `source <(echo ${VK}=/dev/null); ${G}`, EFFECT_BYPASS),
    D(OWN, `. /dev/stdin <<< ${VK}=/dev/null; ${G}`, EFFECT_BYPASS),
    D(OWN, `eval "$(echo ${VK}=/dev/null)"; ${G}`, EFFECT_BYPASS),
    D(OWN, `eval $(echo ${VK}=/dev/null); ${G}`, EFFECT_BYPASS),
    D(OWN, `>/dev/null ${VK}=/dev/null; ${G}`, EFFECT_BYPASS),
    D(OWN, `2>/dev/null ${VK}=/dev/null; ${G}`, EFFECT_BYPASS),
    D(OWN, `a=(1 2) ${VK}=/dev/null; ${G}`, EFFECT_BYPASS),
    D(OWN, `x=$(echo a) ${VK}=/dev/null; ${G}`, EFFECT_BYPASS),
    D(OWN, `x=$(echo a b) ${VK}=/dev/null; ${G}`, EFFECT_BYPASS),
    D(OWN, `function f { ${VK}=/dev/null; }; f; ${G}`, EFFECT_BYPASS),
    D(OWN, `f () { ${VK}=/dev/null; }; f; ${G}`, EFFECT_BYPASS),
    // The word git in a non-git segment does not turn the names around it inert.
    D(OWN, `printf -v ${VK} git; ${G}`, EFFECT_BYPASS),
    D(OWN, `for ${VK} in git; do :; done; ${G}`, EFFECT_BYPASS),
    D(OWN, `read ${VK} <<< git; ${G}`, EFFECT_BYPASS),
    D(OWN, `export git ${VK}=/dev/null; ${G}`, EFFECT_BYPASS),
    D(OWN, `declare git ${VK}=/dev/null; ${G}`, EFFECT_BYPASS),
    D(OWN, `( ${VK}=/dev/null ${G} )`, EFFECT_BYPASS),
    D(OWN, `${VK}+=-nope ${G}`, EFFECT_BYPASS),
    // A listed program whose segment holds shell syntax or a redirect keeps denying.
    D(OWN, `echo $((${VK}=1)); ${G}`, EFFECT_BYPASS),
    D(OWN, `echo "$((${VK}=1))"; ${G}`, EFFECT_BYPASS),
    D(OWN, `cat $((${VK}=1)) 2>/dev/null; ${G}`, EFFECT_BYPASS),
    D(OWN, `ls $((${VK}=1)) 2>/dev/null; ${G}`, EFFECT_BYPASS),
    D(OWN, `echo \${a[${VK}=1]}; ${G}`, EFFECT_BYPASS),
    D(OWN, `echo $(( ${VK} = 1 )); ${G}`, EFFECT_BYPASS),
    D(OWN, `echo $(( ${VK}=1 )); ${G}`, EFFECT_BYPASS),
    D(OWN, `cat $(( ${VK} = 1 )) 2>/dev/null; ${G}`, EFFECT_BYPASS),
    D(OWN, `echo \${a[ ${VK} = 1 ]}; ${G}`, EFFECT_BYPASS),
    D(OWN, `echo $[ ${VK} = 1 ]; ${G}`, EFFECT_BYPASS),
    D(OWN, `echo () { ${VK}=/dev/null; }; echo; ${G}`, EFFECT_BYPASS),
    D(OWN, `grep () { ${VK}=/dev/null; }; grep; ${G}`, EFFECT_BYPASS),
    D(OWN, `cat () { ${VK}=/dev/null; }\ncat\n${G}`, EFFECT_BYPASS),
    D(OWN, `echo ${VK}=/dev/null > ./f; . ./f; rm -f ./f; ${G}`, EFFECT_BYPASS),
    D(OWN, `echo ${VK}=/dev/null>./f; . ./f; rm -f ./f; ${G}`, EFFECT_BYPASS),
    // Before a listed program the token is an assignment, and is not the listed program's word.
    D(OWN, `${VK}=/dev/null echo x; ${G}`, EFFECT_HOOK),
    // Accepted false denies, CTK-ADR-0016: a listed reader beside syntax or a redirect. The hook runs.
    D(OWN, `D=/dev/null; grep ${VK} "$D"; ${G}`, EFFECT_HOOK),
    D(OWN, `grep ${VK} /dev/null > /dev/null; ${G}`, EFFECT_HOOK),
    // A key name beside shell syntax in a sealed git's region: the arithmetic runs before git starts.
    D(OWN, `git -c user.name=$((${VK}=1)) ${C}`, EFFECT_BYPASS),
    D(OWN, `git -c user.name="$((${VK}=1))" ${C}`, EFFECT_BYPASS),
    D(OWN, `git -c user.name=\${a[${VK}=1]} ${C}`, EFFECT_BYPASS),
    D(OWN, `git --config-env user.name=$((${VK}=1)) ${C}`, EFFECT_NONE),
    D(OWN, `git --namespace=$((${VK}=1)) ${C}`, EFFECT_BYPASS),
    D(OWN, `git -C \${a[${VK}=1]}. ${C}`, EFFECT_BYPASS),
    D(OWN, `git -c user.name=$(( ${VK} = 1 )) ${C}`, EFFECT_BYPASS),
    // Before a resolved git, a name holds only as the plain value of an unset.
    D(OWN, `env --split-string="${VK}=/dev/null" ${G}`, EFFECT_BYPASS),
    D(OWN, `env -S "a=1 ${VK}=/dev/null" ${G}`, EFFECT_BYPASS),
    D(OWN, `env -S"${VK}=/dev/null" ${G}`, EFFECT_BYPASS),
    D(OWN, `env -u \${a[${VK}=1]}x ${G}`, EFFECT_BYPASS),
    // An attached short option holds the name too. The ruling names only the separate unset forms as inert, so this one denies, and the hook runs.
    D(OWN, `env -u${CK} ${G}`, EFFECT_HOOK),
    // A config write's key position: a glob that matches a file names the key.
    D(OWN, `touch ./${K}; git config core.hooks* /dev/null && ${G}; rm -f ./${K}`, EFFECT_BYPASS),
    D(OWN, `touch ./${K}; git config core.hooks?ath /dev/null && ${G}; rm -f ./${K}`, EFFECT_BYPASS),
    D(OWN, `touch ./${K}; git config core.hooks[P]ath /dev/null && ${G}; rm -f ./${K}`, EFFECT_BYPASS),
    // That rule reads git's subcommand, not the word config anywhere.
    N(`git add config *.md && ${G}`, EFFECT_NONE),
    N('git commit --allow-empty config -m "fix: why?"', EFFECT_NONE),
    N('git commit --allow-empty config -m "[chore] bump"', EFFECT_NONE),
    N('git commit --allow-empty -m config -m "what changed?"', EFFECT_HOOK),
    N(`git log --oneline -- config '*.md'; ${G}`, EFFECT_HOOK),
    N(`git diff config '*.md'; ${G}`, EFFECT_HOOK),
    N(`ls git config x*; ${G}`, EFFECT_HOOK),
    N(`git config --get-regexp 'core.*'; ${G}`, EFFECT_HOOK),
    // Reads, unsets and text: Minor 5.
    N(`grep -rn ${CK} . | head -3; ${G}`, EFFECT_HOOK),
    N(`echo ${CK} x; ${G}`, EFFECT_HOOK),
    N(`echo ${VK}=v; ${G}`, EFFECT_HOOK),
    N(`grep ${VK} /dev/null; ${G}`, EFFECT_HOOK),
    N(`unset ${CK}; ${G}`, EFFECT_HOOK),
    N(`unset ${VK} ${CK}; ${G}`, EFFECT_HOOK),
    N(`unset ${VK}; ${G}`, EFFECT_NONE),
    N(`env -u ${CK} ${G}`, EFFECT_HOOK),
    N(`env --unset=${CK} ${G}`, EFFECT_HOOK),
    N(`env --unset ${CK} ${G}`, EFFECT_HOOK),
    N(`gh pr comment 1 --body "${CK} x" && git push origin x`, null),
    N(`git commit --allow-empty -m "note ${CK}"`, EFFECT_HOOK),
    N(`git commit --allow-empty -m "$(cat <<'EOF'\nnote ${VK} $X\nEOF\n)"`, EFFECT_HOOK),
    N(`M=x; git commit --allow-empty -m "$M" -m "${VK}"`, EFFECT_HOOK),
  ]), []);
});

/**
 * Reported, not closed: each row runs through the spawned hook and real bash, and the output is the
 * measured list. Nothing is asserted about these rows: this records what the gate does not catch, and
 * passing here says nothing about any of them. State the verdict and effect from this output, not from
 * this source.
 */
function reportedRows(fx, second, plantedExecPath) {
  const K = ENF13_K;
  const VK = 'GIT_CONFIG_VALUE_0';
  const C = 'commit --allow-empty -m x';
  const O = `-c ${K}=/dev/null`;
  const row = (name, command, extra = {}) => ({ name, command, ...extra });
  return [
    // The shape bank's R rows.
    row('--shallow-file then --no-verify (ENF-12 other gap)', `git --shallow-file /dev/null commit --no-verify --allow-empty -m x`),
    row('--config-env other then --no-verify (ENF-12 other gap)', `git --config-env user.name=HOME commit --no-verify --allow-empty -m x`),
    row('unquoted -C word split', `WT=". ${O}"; git -C $WT ${C}`),
    row('--namespace word split', `N="x ${O}"; git --namespace $N ${C}`),
    row('export GIT_DIR', `export GIT_DIR=${fx.other}/.git; git ${C}`),
    row('leading K+=v', `${VK}+=-nope git ${C}`),
    row('env -S', `env -S 'git ${O} ${C}'`),
    row('git alias', `git -c alias.z='!git ${O} ${C}' z`),
    row('script file', `printf '#!/bin/sh\\ngit ${O} ${C}\\n' > ${fx.root}/s.sh; sh ${fx.root}/s.sh`),
    // AMENDMENT-1 A-5, a second gsd-core checkout reached through a variable: the gate reads the cwd's tree.
    row('second checkout, git -C "$Q" commit', `Q=${second.repo}; git -C "$Q" ${C}`),
    row('second checkout, cd "$Q" && git commit', `Q=${second.repo}; cd "$Q" && git ${C}`),
    // A-5, env set by shell constructs the scan cannot read.
    row('export GIT_WORK_TREE=x', `export GIT_WORK_TREE=${fx.emptyDir}; git ${C}`),
    row('GIT_WORK_TREE=x; export', `GIT_WORK_TREE=${fx.emptyDir}; export GIT_WORK_TREE; git ${C}`),
    row('GIT_WORK_TREE=x, newline export', `GIT_WORK_TREE=${fx.emptyDir}\nexport GIT_WORK_TREE\ngit ${C}`),
    row('split-prefix built name, ${a}_VALUE_0', `a=GIT_CONFIG; export \${a}_VALUE_0=/dev/null; git ${C}`),
    row('split-prefix built name, ${a}_CONFIG_VALUE_0', `a=GIT; export \${a}_CONFIG_VALUE_0=/dev/null; git ${C}`),
    row('split-prefix built name, $(printf)', `export $(printf 'GIT_%s' CONFIG_VALUE_0)=/dev/null; git ${C}`),
    row('--namespace=$N word split', `N="x ${O}"; git --namespace=$N ${C}`),
    row('--exec-path=$X word split', `X="$(git --exec-path) ${O}"; git --exec-path=$X ${C}`),
    // A-5, repo config changed by anything other than a git config write the scan reads.
    row('git config $K write', `K=${K}; git config $K /dev/null && git ${C}; git config ${K} .githooks`),
    row('git config --remove-section core', `git config --remove-section core && git ${C}; git config ${K} .githooks`),
    row('git config --rename-section core', `git config --rename-section core x && git ${C}`),
    row('append to .git/config', `printf '[core]\\n\\thooksPath=/dev/null\\n' >> .git/config; git ${C}`),
    row('sed -i on .git/config', `sed -i 's/hooksPath = .githooks/hooksPath = \\/dev\\/null/' .git/config; git ${C}`),
    // A-5, hooks removed from disk.
    row('chmod -x the repo hook', `chmod -x .githooks/pre-commit; git ${C}`),
    row('mv .githooks away', `mv .githooks moved-hooks; git ${C}`),
    // A-5, W4's shapes.
    row('variable subcommand', `S=commit; git ${O} $S --allow-empty -m x`),
    row("ANSI-C subcommand", `git ${O} $'commit' --allow-empty -m x`),
    row('newline in an unquoted $(', `git ${O} $(\n) ${C}`),
    row('git 2>/dev/null commit --no-verify', `git 2>/dev/null commit --no-verify --allow-empty -m x`),
    row('G=git; $G', `G=git; $G ${O} ${C}`),
    row('$(command -v git)', `$(command -v git) ${O} ${C}`),
    row('help.autocorrect', `git ${O} -c help.autocorrect=immediate comit --allow-empty -m x`),
    row('commit-tree plus update-ref', `T=$(git rev-parse 'HEAD^{tree}'); N=$(git commit-tree -m x -p HEAD $T); git update-ref HEAD $N`),
    row('quote mask, ANSI-C', `echo $'a\\'b'; git ${O} ${C}; echo \\'`),
    row('heredoc mask, arithmetic', `echo $((1<<X))\ngit ${O} ${C}\nX`),
    // A-5 W2: an accepted dispatcher's own fail-open is inherited. Measured against the fixture delegate here.
    row('planted git on GIT_EXEC_PATH, behind the fixture dispatcher', `GIT_EXEC_PATH=${plantedExecPath} git ${C}`),
    row('planted git on GIT_EXEC_PATH, no dispatcher', `GIT_EXEC_PATH=${plantedExecPath} git ${C}`, { state: 'plain' }),
    row('--exec-path planted git, behind the fixture dispatcher', `git --exec-path=${plantedExecPath} ${C}`),
    // AMENDMENT-1 A-2 and the parser gaps: a continuation before a segment, a here-string before a line.
    row('true && continuation, -c override (closed)', `true && \\\n git ${O} ${C}`),
    row('true ; continuation, -c override (closed)', `true ; \\\ngit ${O} ${C}`),
    row('true && continuation, --no-verify (parser gap)', `true && \\\n git commit --no-verify --allow-empty -m x`),
    row('here-string, newline, -c override (closed)', `cat <<< x\ngit ${O} ${C}`),
    row('here-string, newline, --no-verify (parser gap)', `cat <<< x\ngit commit --no-verify --allow-empty -m x`),
    row('continuation then blank line, -c override', `echo x \\\n\ngit ${O} ${C}`),
    // A-1 narrow: the plain state keeps today's allow; deny everywhere is the wide-rule follow-up.
    row('A-1 narrow, plain: continuation --no-verify', `git commit --allow-empty -m x \\\n--no-verify`, { state: 'plain' }),
    row('A-1 narrow, plain: -qnm cluster', 'git commit --allow-empty -qnm x', { state: 'plain' }),
    row('A-1 narrow, plain: --no-veri', 'git commit --allow-empty --no-veri -m x', { state: 'plain' }),
    // ENF-12 reads a wrapper's own -n as the flag: a false deny it already had, unchanged here.
    row('nice -n 5 git commit (ENF-12 false deny)', `nice -n 5 git ${C}`),
    // Quick 261104-ov8, CTK-ADR-0016's open rows.
    row('quoted substitution', `echo "$(git ${O} ${C})"`),
    row('alias holding the option', `git -c alias.ci='${O} commit' ci --allow-empty -m x`),
    row('variable payload, eval', `P='git ${O} ${C}'; eval "$P"`),
    row('variable payload, bash -c', `P='git ${O} ${C}'; bash -c "$P"`),
    row('( git $OPTS commit )', `OPTS="${O}"; ( git $OPTS ${C} )`),
    row('glob as a whole option', `git * ${C}`),
    row('compound, no typed form, --no-verify', '( git commit --no-verify --allow-empty -m x )'),
    row('compound, no typed form, -n', 'time git commit -n --allow-empty -m x'),
    row('compound config glob write', `touch ./${K}; ( git config core.hooks* /dev/null; git ${C} ); rm -f ./${K}`),
    row('-c value word split', `N="x ${O}"; git -c user.name=$N ${C}`),
    row('--shallow-file $X word split', `X="/nonexistent ${O}"; git --shallow-file $X ${C}`),
    row('here-string then $O', `O="${O}"; git <<< x $O ${C}`),
    row('here-string then brace', `git <<< x {-c,${K}=/dev/null} ${C}`),
    row('redirect-shaped value then brace', `git --namespace ">x" {-c,${K}=/dev/null} ${C}`),
    row('redirect-shaped value then $O', `O="${O}"; git --namespace ">x" $O ${C}`),
    row('process substitution value then $O', `O="${O}"; git --namespace <(echo a b) $O ${C}`),
    row('redirect-shaped attr-source then $O', `O="${O}"; git --attr-source "<x" $O ${C}`),
    row('kept comment, heredoc operator', `# (x) <<EOF\ngit ${O} ${C}`),
    row('kept comment, quote', `# don't\ngit ${O} ${C} # don't`),
    row('kept comment, quote, key', `true # it's\n${VK}=/dev/null; git ${C} # it's`),
    row('nested quote over a newline', `echo "$(echo "a #b\nc"; git ${O} ${C}; echo "d")"`),
    row('-m value after the sealing word, arithmetic', `git commit --allow-empty -m $((${VK}=1))`),
    row('non-sealed git segment, arithmetic', `git log -1 $((${VK}=1)) >/dev/null 2>&1; git ${C}`),
    // Runs nothing: gh would reach outside the fixture.
    row('gh pr create x && git commit --no-verify', 'gh pr create x && git commit --no-verify -m x', { noExec: true }),
    // From outside any gsd-core checkout: no root resolves, so the literal -C target is not read.
    row('--attr-source hides -C from outside a checkout', `git --attr-source HEAD -C ${fx.repo} ${O} ${C}`, { cwd: fx.emptyDir }),
  ];
}

test('reported rows, not closed: the measured list, asserting nothing about any row', async (t) => {
  const fx = buildBankFixture(t);
  const second = buildFixtureRepo(t, null);
  const planted = path.join(fx.root, 'planted-exec-path');
  writeExecutable(path.join(planted, 'git'), '#!/bin/sh\nexit 1\n');
  const rows = reportedRows(fx, second, planted);
  const stateEnv = (row) => (row.state === 'plain' ? fx.plain : fx.behind);
  const verdicts = await inPool(rows, (row) => runHookAsync(row.cwd || fx.repo, stateEnv(row), row.command));
  const marker = path.join(fx.repo, REPO_HOOK_MARKER);
  const secondMarker = path.join(second.repo, REPO_HOOK_MARKER);
  const configFile = path.join(fx.repo, '.git', 'config');
  rows.forEach((row, at) => {
    let effect = 'not run';
    if (!row.noExec) {
      const before = [fx.repo, fx.other, second.repo].map(headOf);
      spawnSync('bash', ['-c', row.command], {
        cwd: row.cwd || fx.repo,
        env: realGitEnv(stateEnv(row)),
        encoding: 'utf8',
        timeout: 20000,
      });
      const after = [fx.repo, fx.other, second.repo].map(headOf);
      if (fs.existsSync(marker) || fs.existsSync(secondMarker)) effect = 'hook ran';
      else if (after[0] !== before[0]) effect = 'COMMITTED-NO-HOOK';
      else if (after[1] !== before[1]) effect = 'COMMITTED-NO-HOOK in the other repo';
      else if (after[2] !== before[2]) effect = 'COMMITTED-NO-HOOK in the second checkout';
      else effect = 'no commit';
      // These rows write config and move hooks, so each one starts from the same fixture.
      fs.rmSync(marker, { force: true });
      fs.rmSync(secondMarker, { force: true });
      fs.rmSync(path.join(fx.repo, '.githooks'), { recursive: true, force: true });
      fs.rmSync(path.join(fx.repo, 'moved-hooks'), { recursive: true, force: true });
      addCheckoutLayout(fx.repo);
      fs.writeFileSync(configFile, fx.config);
    }
    t.diagnostic(`reported | ${row.name} | ${row.state === 'plain' ? 'plain' : 'dispatcher'} | hook=${verdicts[at].decision} | ${effect}`);
  });
});

test('second checkout named literally: the gate reads the target, so an unset repo value there denies', (t) => {
  const fx = buildBankFixture(t);
  const second = buildFixtureRepo(t, null);
  const d = runHook(fx.repo, fx.behind, `git -C ${second.repo} commit --allow-empty -m x`);
  assert.strictEqual(d.decision, 'deny');
  assert.ok(d.reason.includes('that value is UNSET'), d.reason);
});

// --- Row 3: a dir named githooks-dispatch that is not one -----------------------------------------

/** The stub that would mark a canary run: exit 37 with a marker file, if anything ever executes it. */
function sentinelStub(sentinel) {
  return `#!/bin/sh\n: > '${sentinel}'\n: > canary-ran\nexit 37\n`;
}

/** A look-alike with one thing wrong, each on its own. `why` is what the shape check must name. */
function brokenLookAlikes(parent, sentinel) {
  const each = (label, breakIt) => {
    const dir = buildLookAlike(fs.mkdtempSync(path.join(parent, `${label}-`)), sentinelStub(sentinel));
    breakIt(dir);
    return dir;
  };
  const inDir = (dir, name) => path.join(dir, name);
  return [
    ['empty dir', /ENOENT/, each('empty', (dir) => {
      for (const name of fs.readdirSync(dir)) fs.rmSync(inDir(dir, name));
    })],
    ['pre-push missing', /ENOENT/, each('nopush', (dir) => fs.rmSync(inDir(dir, 'pre-push')))],
    ['pre-commit missing', /ENOENT/, each('nocommit', (dir) => fs.rmSync(inDir(dir, 'pre-commit')))],
    ['_delegate.sh missing', /ENOENT/, each('nodelegate', (dir) => fs.rmSync(inDir(dir, '_delegate.sh')))],
    ['pre-commit not executable', /pre-commit is not executable/, each('commit644', (dir) => fs.chmodSync(inDir(dir, 'pre-commit'), 0o644))],
    ['pre-push not executable', /pre-push is not executable/, each('push644', (dir) => fs.chmodSync(inDir(dir, 'pre-push'), 0o644))],
    ['_delegate.sh a directory', /_delegate\.sh is not a regular file/, each('delegatedir', (dir) => {
      fs.rmSync(inDir(dir, '_delegate.sh'));
      fs.mkdirSync(inDir(dir, '_delegate.sh'));
    })],
    ['pre-push a directory', /pre-push is not a regular file/, each('pushdir', (dir) => {
      fs.rmSync(inDir(dir, 'pre-push'));
      fs.mkdirSync(inDir(dir, 'pre-push'));
    })],
    ['_delegate.sh a symlink loop', /ELOOP/, each('loop', (dir) => {
      fs.rmSync(inDir(dir, '_delegate.sh'));
      fs.symlinkSync('_delegate.sh', inDir(dir, '_delegate.sh'));
    })],
  ];
}

test('dispatcherShape: why names the failing sub-check, each on its own, and a sound dir passes', (t) => {
  const { dispatcherShape } = require('./githooks-seal.cjs');
  const root = scratchDir(t, 'githooks-seal-shape-');
  const sentinel = path.join(root, 'sentinel');
  assert.deepStrictEqual(dispatcherShape(buildDispatcher(root)), { genuine: true, why: 'shape matches' });
  for (const [label, why, dir] of brokenLookAlikes(root, sentinel)) {
    const shape = dispatcherShape(dir);
    assert.strictEqual(shape.genuine, false, label);
    assert.match(shape.why, why, label);
  }
  const asFile = path.join(fs.mkdtempSync(path.join(root, 'file-')), 'githooks-dispatch');
  fs.writeFileSync(asFile, '');
  for (const [value, why] of [
    [null, 'no value'],
    ['', 'no value'],
    [undefined, 'no value'],
    ['githooks-dispatch', 'not an absolute path'],
    ['relative/githooks-dispatch', 'not an absolute path'],
    ['/dev/null', 'basename is not githooks-dispatch'],
    [path.join(root, 'githooks-dispatchx'), 'basename is not githooks-dispatch'],
    [asFile, 'not a directory'],
  ]) {
    assert.deepStrictEqual(dispatcherShape(value), { genuine: false, why }, String(value));
  }
  assert.strictEqual(fs.existsSync(sentinel), false, 'a shape check executes nothing');
});

test('row 3: a mode 000 dir named githooks-dispatch is EACCES, a deny, and nothing runs', { skip: process.getuid && process.getuid() === 0 ? 'root ignores file modes' : false }, (t) => {
  const { dispatcherShape } = require('./githooks-seal.cjs');
  const fx = buildFixtureRepo(t);
  const sentinel = path.join(fx.root, 'sentinel');
  const dir = buildLookAlike(fx.root, sentinelStub(sentinel));
  fs.chmodSync(dir, 0o000);
  try {
    assert.deepStrictEqual(dispatcherShape(dir), { genuine: false, why: 'EACCES' });
    const d = runHook(fx.repo, childEnv({ dispatcher: dir }), 'git commit -m x');
    assert.strictEqual(d.decision, 'deny');
    assert.match(d.reason, /EACCES/);
    assert.doesNotMatch(d.reason, /canary/);
    assert.strictEqual(fs.existsSync(sentinel), false);
  } finally {
    fs.chmodSync(dir, 0o755);
  }
});

test('row 3: each broken look-alike denies with text C through the hook, no canary, the file never runs', async (t) => {
  const fx = buildFixtureRepo(t);
  const sentinel = path.join(fx.root, 'sentinel');
  const rows = brokenLookAlikes(fx.root, sentinel);
  const verdicts = await inPool(rows, ([, , dir]) => runHookAsync(fx.repo, childEnv({ dispatcher: dir }), 'git commit -m x'));
  rows.forEach(([label, why], at) => {
    const d = verdicts[at];
    assert.strictEqual(d.decision, 'deny', label);
    assert.match(d.reason, why, label);
    assert.ok(d.reason.includes('so `git config core.hooksPath .githooks` cannot fix it'), d.reason);
    assert.doesNotMatch(d.reason, /canary/, `${label}: a shape failure ran no canary`);
    assert.doesNotMatch(d.reason, /INERT/, label);
    assertPlainDenyText(d.reason, label);
  });
  assert.strictEqual(fs.existsSync(sentinel), false);
});

/** The override stub that would lift a thrown fault, and the count of what it lifted. */
function overrideStub() {
  const seen = { receipts: 0 };
  return {
    seen,
    overrideImpl: {
      checkOverride: () => ({ override: true, reason: 'pin' }),
      writeReceipt: () => {
        seen.receipts += 1;
      },
    },
  };
}

test('every returned deny stays a deny with an override stub set, zero receipts', (t) => {
  const fx = buildFixtureRepo(t);
  const sentinel = path.join(fx.root, 'sentinel');
  const value = buildDispatcher(fx.root);
  const failed = () => ({ passed: false, marker: false, status: 0, signal: null, error: null });
  const injected = (over) => ({ worktreeRoot: fx.repo, readRepoHooksPath: () => '.githooks', passesCanary: failed, ...over });
  const rows = [
    ['ENF-12', 'git commit --no-verify -m x', injected({ readHooksPath: () => '.githooks' }), /\(ENF-12\)$/],
    ['text A', 'git commit -m x', { worktreeRoot: fx.repo, readHooksPath: () => '.husky' }, /INERT/],
    ['text A, unset', 'git commit -m x', { worktreeRoot: fx.repo, readHooksPath: () => null }, /UNSET/],
    ['text B', 'git commit -m x', injected({ readHooksPath: () => value, readRepoHooksPath: () => '.husky' }), /that value is `\.husky`/],
    ['text C, canary', 'git commit -m x', injected({ readHooksPath: () => value }), /did not pass the delegation canary/],
    ['text C, no canary wired', 'git commit -m x', { worktreeRoot: fx.repo, readHooksPath: () => value, readRepoHooksPath: () => '.githooks' }, /no canary ran/],
    ['text C, a true that is not the result', 'git commit -m x', injected({ readHooksPath: () => value, passesCanary: () => true }), /did not pass/],
    ['text C, scope', 'git commit -m x', { worktreeRoot: fx.repo, readHooksPath: () => '/v', readRepoHooksPath: () => '/v', readHooksPathScope: () => 'command' }, /Voiding the env count key/],
    ['text D, override', `git -c ${ENF13_K}=/dev/null commit -m x`, injected({ readHooksPath: () => '.githooks' }), /Remove it from the command/],
    ['text D, A-1', 'git commit --no-veri -m x', injected({ readHooksPath: () => value }), /hook-skipping spelling/],
  ];
  for (const [badValue, why] of [
    ['/dev/null', /basename/],
    ['relative/githooks-dispatch', /not an absolute path/],
    [path.join(fx.root, 'none', 'githooks-dispatch'), /ENOENT/],
    ...brokenLookAlikes(fx.root, sentinel).map(([, shapeWhy, dir]) => [dir, shapeWhy]),
  ]) {
    rows.push([`text C, shape ${badValue}`, 'git commit -m x', injected({ readHooksPath: () => badValue }), why]);
  }
  for (const [label, command, base, text] of rows) {
    const { seen, overrideImpl } = overrideStub();
    const d = runGithooksGate(input(command), { ...base, overrideImpl });
    assert.strictEqual(d.permissionDecision, 'deny', label);
    assert.match(d.permissionDecisionReason, text, label);
    assert.strictEqual(seen.receipts, 0, label);
  }
  assert.strictEqual(fs.existsSync(sentinel), false);
});

test('row 3: a real canary that ran and failed is a deny the override stub cannot lift', (t) => {
  const { runDispatcherCanary } = require('./githooks-seal.cjs');
  const fx = buildFixtureRepo(t);
  const env = childEnv();
  for (const body of ['#!/bin/sh\nexit 0\n', '#!/bin/sh\n.githooks/pre-commit\nexit 0\n', '#!/bin/sh\nexit 37\n']) {
    const dir = buildLookAlike(fs.mkdtempSync(path.join(fx.root, 'stub-')), body);
    const { seen, overrideImpl } = overrideStub();
    const d = runGithooksGate(input('git commit -m x'), {
      worktreeRoot: fx.repo,
      readHooksPath: () => dir,
      readRepoHooksPath: () => '.githooks',
      passesCanary: (value) => runDispatcherCanary(value, { env }),
      overrideImpl,
    });
    assert.strictEqual(d.permissionDecision, 'deny', body);
    assert.match(d.permissionDecisionReason, /did not pass the delegation canary/, body);
    assert.strictEqual(seen.receipts, 0, body);
  }
});

test('row 3: a hanging stub and a TERM-trapping stub are killed at the bound, and the deny reports the signal', (t) => {
  const { runDispatcherCanary } = require('./githooks-seal.cjs');
  const fx = buildFixtureRepo(t);
  const env = childEnv();
  const timeoutMs = 400;
  // `sleep` outlasts the assert on purpose: only a SIGKILL returns before it ends. Plain sleep dies to
  // TERM as well, so only the trapping stub can tell the kill signal apart.
  for (const [label, body] of [
    ['hanging', '#!/bin/sh\nexec sleep 4\n'],
    ['traps TERM', "#!/bin/sh\ntrap '' TERM\nsleep 4\n"],
  ]) {
    const dir = buildLookAlike(fs.mkdtempSync(path.join(fx.root, 'stub-')), body);
    const started = Date.now();
    const result = runDispatcherCanary(dir, { env, timeoutMs });
    const elapsed = Date.now() - started;
    assert.strictEqual(result.passed, false, label);
    assert.strictEqual(result.marker, false, label);
    assert.strictEqual(result.signal, 'SIGKILL', label);
    assert.ok(elapsed < timeoutMs + 2000, `${label}: returned in ${elapsed} ms`);
    const { seen, overrideImpl } = overrideStub();
    const d = runGithooksGate(input('git commit -m x'), {
      worktreeRoot: fx.repo,
      readHooksPath: () => dir,
      readRepoHooksPath: () => '.githooks',
      passesCanary: () => result,
      overrideImpl,
    });
    assert.match(d.permissionDecisionReason, /marker no, signal SIGKILL/, label);
    assert.strictEqual(seen.receipts, 0, label);
  }
  // A spawn that never started reports its error code, not a status.
  const noStart = runGithooksGate(input('git commit -m x'), {
    worktreeRoot: fx.repo,
    readHooksPath: () => buildDispatcher(fs.mkdtempSync(path.join(fx.root, 'ok-'))),
    readRepoHooksPath: () => '.githooks',
    passesCanary: () => ({ passed: false, marker: false, status: null, signal: null, error: 'EACCES' }),
  });
  assert.match(noStart.permissionDecisionReason, /marker no, error EACCES/);
});

// --- A-1 placement: the deny comes after the shape and repo-value checks, and before the canary ------

test('A-1 placement: a shape failure and a wrong repo value keep their own text for a spelling ENF-12 misses', (t) => {
  const command = 'git commit --no-veri -m x';
  const fx = buildFixtureRepo(t);
  const atNull = runHook(fx.repo, childEnv({ dispatcher: '/dev/null' }), command);
  assert.strictEqual(atNull.decision, 'deny');
  assert.match(atNull.reason, /does not have a hooks dispatcher's shape/);
  assert.doesNotMatch(atNull.reason, /hook-skipping/);
  const husky = buildFixtureRepo(t, '.husky');
  const behindHusky = runHook(husky.repo, childEnv({ dispatcher: buildDispatcher(husky.root) }), command);
  assert.strictEqual(behindHusky.decision, 'deny');
  assert.match(behindHusky.reason, /that value is `\.husky`/);
  assert.doesNotMatch(behindHusky.reason, /hook-skipping/);
});

// --- Row 4: a read or a setup that cannot run denies, and only a logged override rescues that ---------

test('row 4: a bad count key, a missing TMPDIR and an empty PATH each deny through the spawned hook', async (t) => {
  const fx = buildFixtureRepo(t);
  const dispatcher = buildDispatcher(fx.root);
  const badCount = childEnv({ dispatcher });
  badCount.GIT_CONFIG_COUNT = 'nope';
  const noTmp = childEnv({ dispatcher, tmpdir: path.join(fx.root, 'no-such-dir') });
  const noPath = childEnv({ dispatcher });
  noPath.PATH = '';
  const rows = [
    ['invalid count key', badCount, /exit 128/],
    ['TMPDIR missing', noTmp, /could not set up the delegation canary/],
    ['PATH empty', noPath, /could not read core\.hooksPath/],
  ];
  const verdicts = await inPool(rows, ([, env]) => runHookAsync(fx.repo, env, 'git commit -m x'));
  rows.forEach(([label, , why], at) => {
    assert.strictEqual(verdicts[at].decision, 'deny', label);
    assert.match(verdicts[at].reason, why, label);
  });
});

test('row 4: a thrown read denies, and a logged override lifts only that, with a receipt', (t) => {
  const fx = buildFixtureRepo(t);
  const value = buildDispatcher(fx.root);
  const boom = () => {
    throw new Error('read boom');
  };
  const throwers = [
    ['effective read', { readHooksPath: boom }],
    ['voided read', { readHooksPath: () => value, readRepoHooksPath: boom }],
    ['canary setup', { readHooksPath: () => value, readRepoHooksPath: () => '.githooks', passesCanary: boom }],
  ];
  for (const [label, throwing] of throwers) {
    const closed = runGithooksGate(input('git commit -m x'), {
      worktreeRoot: fx.repo,
      ...throwing,
      overrideImpl: { checkOverride: () => ({ override: false }), writeReceipt: () => {} },
    });
    assert.strictEqual(closed.permissionDecision, 'deny', label);
    assert.match(closed.permissionDecisionReason, /read boom/, label);
    const { seen, overrideImpl } = overrideStub();
    const lifted = runGithooksGate(input('git commit -m x'), { worktreeRoot: fx.repo, ...throwing, overrideImpl });
    assert.strictEqual(lifted.permissionDecision, 'allow', label);
    assert.strictEqual(seen.receipts, 1, label);
  }
});

// --- The scope rows and the chain's regressions ---------------------------------------------------

test('scope: global-scope and direct repo-scope values naming a look-alike deny with text A and never run it', (t) => {
  const fx = buildFixtureRepo(t, null);
  const sentinel = path.join(fx.root, 'sentinel');
  const lookAlike = buildLookAlike(fx.root, sentinelStub(sentinel));
  const globalConfig = path.join(fx.root, 'global.cfg');
  fs.writeFileSync(globalConfig, `[core]\n\thooksPath = ${lookAlike}\n`);
  const globalEnv = childEnv();
  globalEnv.GIT_CONFIG_GLOBAL = globalConfig;
  const fromGlobal = runHook(fx.repo, globalEnv, 'git commit -m x');
  assert.strictEqual(fromGlobal.decision, 'deny');
  assert.ok(fromGlobal.reason.includes(lookAlike), fromGlobal.reason);
  assert.match(fromGlobal.reason, /INERT/);

  fs.appendFileSync(path.join(fx.repo, '.git', 'config'), `[core]\n\thooksPath = ${lookAlike}\n`);
  const fromRepo = runHook(fx.repo, childEnv(), 'git commit -m x');
  assert.strictEqual(fromRepo.decision, 'deny');
  assert.ok(fromRepo.reason.includes(lookAlike), fromRepo.reason);
  assert.match(fromRepo.reason, /INERT/);
  assert.strictEqual(fs.existsSync(sentinel), false);
});

test('scope: a worktree-scope value over repo .githooks denies, plain and behind the dispatcher', (t) => {
  const fx = buildFixtureRepo(t);
  const dispatcher = buildDispatcher(fx.root);
  fs.appendFileSync(path.join(fx.repo, '.git', 'config'), '[extensions]\n\tworktreeConfig = true\n');
  fs.writeFileSync(path.join(fx.repo, '.git', 'config.worktree'), '[core]\n\thooksPath = .husky\n');
  const plain = runHook(fx.repo, childEnv(), 'git commit -m x');
  assert.strictEqual(plain.decision, 'deny');
  assert.match(plain.reason, /`\.husky`, so the repo's `\.githooks` gates .* INERT/);
  const behind = runHook(fx.repo, childEnv({ dispatcher }), 'git commit -m x');
  assert.strictEqual(behind.decision, 'deny');
  assert.match(behind.reason, /that value is `\.husky`/);
  // Text A's advice does not move a worktree-scope value. Measured here, and it still denies.
  const git = (...args) => spawnSync('git', args, { cwd: fx.repo, env: hostFreeEnv(), encoding: 'utf8' });
  assert.strictEqual(git('config', ENF13_K, '.githooks').status, 0);
  t.diagnostic(`reported | worktree-scope value after the advised write | plain | ${git('config', '--show-scope', '--get', ENF13_K).stdout.trim()}`);
  assert.strictEqual(runHook(fx.repo, childEnv(), 'git commit -m x').decision, 'deny');
});

test('scope: the voided read is compared exactly, so `.githooks ` behind the dispatcher denies with text B', (t) => {
  const fx = buildFixtureRepo(t, '".githooks "');
  const d = runHook(fx.repo, childEnv({ dispatcher: buildDispatcher(fx.root) }), 'git commit -m x');
  assert.strictEqual(d.decision, 'deny');
  assert.ok(d.reason.includes('that value is `.githooks `'), d.reason);
});

test('git init in the canary runs nothing from the value: only pre-commit runs, once, in the canary repo', (t) => {
  const { runDispatcherCanary } = require('./githooks-seal.cjs');
  const root = scratchDir(t, 'githooks-seal-init-');
  const sentinel = path.join(root, 'ran');
  const record = (next) => `#!/bin/sh\necho "$(basename "$0") $PWD" >> '${sentinel}'\n${next}\n`;
  const dir = buildLookAlike(root, record('.githooks/pre-commit'));
  // Under the value git itself would look for these. The fixture's git init must not reach them.
  for (const name of ['post-checkout', 'post-commit', 'post-index-change', 'reference-transaction', 'post-rewrite', 'pre-auto-gc']) {
    writeExecutable(path.join(dir, name), record('exit 0'));
  }
  const result = runDispatcherCanary(dir, { env: childEnv({ dispatcher: dir }) });
  assert.strictEqual(result.passed, true, JSON.stringify(result));
  const lines = fs.readFileSync(sentinel, 'utf8').trim().split('\n');
  assert.strictEqual(lines.length, 1, lines.join('\n'));
  assert.match(lines[0], /^pre-commit .*githooks-seal-canary-/);
});

test('the canary drops what a git hook env would point elsewhere: its own repo is used, and another repo is untouched', (t) => {
  const { runDispatcherCanary } = require('./githooks-seal.cjs');
  const fx = buildBankFixture(t);
  const env = childEnv();
  env.GIT_DIR = path.join(fx.other, '.git');
  env.GIT_WORK_TREE = fx.other;
  env.GIT_COMMON_DIR = path.join(fx.other, '.git');
  env.GIT_INDEX_FILE = path.join(fx.other, '.git', 'index');
  const configFile = path.join(fx.other, '.git', 'config');
  const before = fs.readFileSync(configFile);
  const result = runDispatcherCanary(fx.dispatcher, { env });
  assert.strictEqual(result.passed, true, JSON.stringify(result));
  assert.ok(fs.readFileSync(configFile).equals(before), 'the canary wrote into the other repo');
});

test('ENF-12 text is byte-identical to the text this fix found', () => {
  const d = runGithooksGate(input('git commit --no-verify -m x'), deps());
  assert.strictEqual(
    d.permissionDecisionReason,
    '`--no-verify` / `-n` bypasses the repo\'s `.githooks` gates (pre-commit / pre-push). ' +
      'Remove it and let the local gates run. ' +
      '`GSD_CONTRIB_OVERRIDE` does not lift this deny: this gate honors it only for a thrown gate ' +
      'error. Turning the toolkit off is a human operator\'s decision, not a way past this deny: ' +
      '`node bin/contrib-capability.cjs off --reason "<why>"`, run from the toolkit checkout, strips ' +
      'the toolkit\'s gates from that gsd-core checkout and writes a receipt. (ENF-12)'
  );
});

test('RES-01: a non-sealed command with no typed hit pays no filesystem walk before its allow', (t) => {
  // The verdict log's own file checks come after the decision and are not a walk.
  const logDir = process.env.GSD_CONTRIB_LOG_DIR;
  const seen = [];
  for (const name of ['statSync', 'lstatSync', 'existsSync', 'realpathSync', 'readdirSync']) {
    const real = fs[name];
    fs[name] = function spied(target, ...rest) {
      if (!String(target).startsWith(logDir)) seen.push(`${name} ${target}`);
      return real.call(this, target, ...rest);
    };
    t.after(() => {
      fs[name] = real;
    });
  }
  const noOverride = { checkOverride: () => ({ override: false }), writeReceipt: () => {} };
  for (const command of ['git status', 'ls -la', 'git log --oneline -3 && git diff', `git -c ${ENF13_K}=/dev/null status`]) {
    const d = runGithooksGate(input(command), { overrideImpl: noOverride });
    assert.strictEqual(d.permissionDecision, 'allow', command);
  }
  assert.deepStrictEqual(seen, []);
  // The spy does see a walk: a sealed command resolves its root.
  runGithooksGate(input('git commit -m x'), { overrideImpl: noOverride });
  assert.ok(seen.length > 0, 'a sealed command should walk');
});

test('A-2, the refusal is scoped: a text that does not parse with no sealed segment in it stays allowed', (t) => {
  const { fx, states } = typedStates(t);
  for (const command of ["# <<EOF\nit's\nEOF\ngit status", 'git log \\\n\ngit status', 'echo x \\\n\necho y']) {
    assertTypedAllow(command, states, fx.repo);
  }
});
