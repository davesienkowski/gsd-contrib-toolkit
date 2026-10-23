'use strict';

/**
 * bin/gsd-plan-track.test.cjs - pins how gsd-plan-track chooses the planning remote URL.
 *
 * The planning repo holds private .planning history, so the URL decides where that history is
 * sent. The script carries NO built-in URL: precedence is GSD_PLAN_REMOTE (non-empty), then
 * `git config gsd.planRemote`, then refuse. Every case runs the real script under bash in a
 * sandbox: a fresh HOME, an isolated global git config (GIT_CONFIG_GLOBAL, no system config),
 * a temp GSD_PLAN_GITDIR and a temp code checkout (GSD_PLAN_WORKTREE) that ignores .planning/.
 * Nothing touches the user's real planning repo, git config or network: the push case answers
 * "n" at the confirmation prompt, so no transport is ever opened.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, 'gsd-plan-track');
const ENV_URL = 'https://example.invalid/env.git';
const CONFIG_URL = 'https://example.invalid/config.git';

/** Build a sandbox. `configRemote` (optional) is written to the isolated global git config. */
function sandbox(configRemote) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-plan-track-'));
  const home = path.join(tmp, 'home');
  fs.mkdirSync(home);
  const gitconfig = path.join(tmp, 'gitconfig');
  fs.writeFileSync(gitconfig, configRemote ? `[gsd]\n\tplanRemote = ${configRemote}\n` : '');
  const gitdir = path.join(tmp, 'planning.git');
  const checkout = path.join(tmp, 'checkout');
  fs.mkdirSync(path.join(checkout, '.planning'), { recursive: true });
  fs.writeFileSync(path.join(checkout, '.gitignore'), '.planning/\n');
  fs.writeFileSync(path.join(checkout, '.planning', 'STATE.md'), '# state\n');
  // Built from scratch: nothing from the caller's environment except PATH.
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    GIT_CONFIG_GLOBAL: gitconfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    TMPDIR: tmp,
    GSD_PLAN_GITDIR: gitdir,
    GSD_PLAN_WORKTREE: checkout,
  };
  execFileSync('git', ['init', '-q', checkout], { env, cwd: tmp });
  const run = (args, extraEnv = {}, input) => spawnSync('bash', [SCRIPT, ...args], {
    env: { ...env, ...extraEnv },
    cwd: tmp,
    input: input === undefined ? '' : input,
    encoding: 'utf8',
  });
  const storedUrl = () => execFileSync('git', ['--git-dir', gitdir, 'remote', 'get-url', 'planning'],
    { env, cwd: tmp, encoding: 'utf8' }).replace(/\n$/, '');
  const cleanup = () => fs.rmSync(tmp, { recursive: true, force: true });
  return { tmp, gitdir, run, storedUrl, cleanup };
}

test('init with neither GSD_PLAN_REMOTE nor gsd.planRemote refuses and creates nothing', () => {
  const sb = sandbox();
  try {
    const r = sb.run(['init']);
    assert.equal(r.status, 1, `init must exit 1 (stdout: ${r.stdout} stderr: ${r.stderr})`);
    // An earlier guard also exits 1, so the message is what proves this refusal.
    assert.match(r.stderr, /GSD_PLAN_REMOTE/, `stderr names GSD_PLAN_REMOTE: ${r.stderr}`);
    assert.match(r.stderr, /gsd\.planRemote/, `stderr names gsd.planRemote: ${r.stderr}`);
    assert.equal(fs.existsSync(sb.gitdir), false, 'the planning git-dir must not be created');
  } finally {
    sb.cleanup();
  }
});

test('init stores GSD_PLAN_REMOTE byte-for-byte', () => {
  const sb = sandbox();
  try {
    const r = sb.run(['init'], { GSD_PLAN_REMOTE: ENV_URL });
    assert.equal(r.status, 0, `init exits 0 (stdout: ${r.stdout} stderr: ${r.stderr})`);
    assert.equal(sb.storedUrl(), ENV_URL);
  } finally {
    sb.cleanup();
  }
});

test('init stores git config gsd.planRemote when GSD_PLAN_REMOTE is unset', () => {
  const sb = sandbox(CONFIG_URL);
  try {
    const r = sb.run(['init']);
    assert.equal(r.status, 0, `init exits 0 (stdout: ${r.stdout} stderr: ${r.stderr})`);
    assert.equal(sb.storedUrl(), CONFIG_URL);
  } finally {
    sb.cleanup();
  }
});

test('GSD_PLAN_REMOTE wins over git config gsd.planRemote', () => {
  const sb = sandbox(CONFIG_URL);
  try {
    const r = sb.run(['init'], { GSD_PLAN_REMOTE: ENV_URL });
    assert.equal(r.status, 0, `init exits 0 (stdout: ${r.stdout} stderr: ${r.stderr})`);
    assert.equal(sb.storedUrl(), ENV_URL);
  } finally {
    sb.cleanup();
  }
});

test('an empty GSD_PLAN_REMOTE counts as unset and falls through to gsd.planRemote', () => {
  const sb = sandbox(CONFIG_URL);
  try {
    const r = sb.run(['init'], { GSD_PLAN_REMOTE: '' });
    assert.equal(r.status, 0, `init exits 0 (stdout: ${r.stdout} stderr: ${r.stderr})`);
    assert.equal(sb.storedUrl(), CONFIG_URL);
  } finally {
    sb.cleanup();
  }
});

test('the push confirmation names the stored remote, not a built-in URL', () => {
  const sb = sandbox();
  try {
    const init = sb.run(['init'], { GSD_PLAN_REMOTE: ENV_URL });
    assert.equal(init.status, 0, `init exits 0 (stdout: ${init.stdout} stderr: ${init.stderr})`);
    // GSD_PLAN_REMOTE is unset here and no config key exists: only the stored remote can name it.
    const r = sb.run(['push'], {}, 'n\n');
    assert.equal(r.status, 1, `answering n aborts with exit 1 (stdout: ${r.stdout} stderr: ${r.stderr})`);
    assert.ok(r.stdout.includes(ENV_URL), `the warning names the stored remote: ${r.stdout}`);
    assert.match(r.stdout, /Aborted\./);
  } finally {
    sb.cleanup();
  }
});
