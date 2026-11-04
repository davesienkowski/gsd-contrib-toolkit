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

// --- ENF-13 typed scan and deny texts (quick 261103-uqe, Task 2) --------------------
// Each rule family below is proved both ways: rows that deny and false-deny controls that allow.
// Every row runs through the spawned hook, in the plain state (effective .githooks) and behind the
// fixture dispatcher. The per-form port of the whole families table is a later step of this task.

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
const ADVICE_LITERAL = /Write the value out literally\./;
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
    "git -c 'url.git@x:.insteadOf=y' push origin x",
    'git $O commit -m x',
    `git {-c,${ENF13_K}=/dev/null} commit -m x`,
    'N=x; git -c user.name=$N commit -m x',
    'V=HOME; git --config-env user.name=$V commit -m x',
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
    'unset GIT_CONFIG_COUNT; git commit -m x',
    'env -u GIT_CONFIG_COUNT git commit -m x',
    'echo GIT_CONFIG_VALUE_0=v && git commit -m x',
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
  // A continuation then a blank line: the newline split fails on it, so the scan cannot read it.
  assertTypedDeny(['git log \\\n\ngit commit -m y', ADVICE_OWN_CALL], states, fx.repo);
  for (const command of [
    `git \\\n-c ${ENF13_K}=/dev/null commit -m x`,
    `git -c ${ENF13_K}=/dev/null \\\ncommit -m x`,
    `git \\\n  -c ${ENF13_K}=/dev/null \\\n  commit -m x`,
  ]) {
    assertTypedDeny([command, ADVICE_REMOVE], states, fx.repo);
  }
  for (const command of ['git \\\n  commit -m x', 'git commit \\\n  --allow-empty \\\n  -m x']) {
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
  const { maskHeredocBodies } = require('./githooks-seal.cjs');
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
