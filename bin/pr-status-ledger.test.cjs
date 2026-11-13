'use strict';

/**
 * bin/pr-status-ledger.test.cjs - quick 261113-wg1: pr-status prints the pr-update ledger's pending bundle (read only).
 *
 * Hermetic: runCli gets an in-memory `gh`, and the ledger dir is a temp dir (deps.ledgerDir); no network, no live ledger.
 *
 * @module bin/pr-status-ledger.test
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const prStatus = require('./pr-status.cjs');
const { ledgerFileName } = require('./pr-update.cjs');

const REPO = 'open-gsd/gsd-core';
const HEAD = 'a'.repeat(40);
const STEPS = ['publish branch', 'dispatch self-test', 'body pending', 'run green', 'body final', 're-review comment', 're-request reviewers', 'postcondition'];

function ledger(doneUpTo, extra = {}) {
  return { v: 1, repo: REPO, pr: 5871, head: HEAD, steps: STEPS.map((name, i) => ({ id: i + 1, name, state: i < doneUpTo ? 'done' : 'pending', at: null, emittedAt: null, note: null })), ...extra };
}

function fixtureDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pr-status-ledger-'));
}

function run(args, ledgerDir, repoStub) {
  const gh = (a) => {
    if (a[0] === 'pr' && a[1] === 'view') return { number: Number(a[2]), state: 'OPEN', isDraft: false, author: { login: 'me' }, headRefOid: HEAD, baseRefName: 'next', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: null, reviewRequests: [], commits: [], headRefName: 'fix/x', title: 'fix: x' };
    if (a[0] === 'pr' && a[1] === 'checks') return [];
    if (a[0] === 'api' && /\/reviews\?/.test(a.join(' '))) return [[]];
    throw new Error('stub: unexpected read ' + a.join(' '));
  };
  let stdout = '';
  const status = prStatus.runCli(args, { gh, sleep: () => {}, ledgerDir, stdout: { write: (x) => { stdout += x; } }, stderr: { write: () => {} } });
  return { status, stdout };
}

const bundle = (dir) => JSON.parse(run(['--json', '5871'], dir).stdout)[0].bundle;
const put = (dir, body) => fs.writeFileSync(path.join(dir, `${ledgerFileName(REPO, 5871)}.jsonl`), typeof body === 'string' ? body : JSON.stringify(body) + '\n');

test('a ledger with pending steps prints pr-update\'s own pending line and a --json field', () => {
  const dir = fixtureDir();
  put(dir, ledger(2));
  const r = run(['5871'], dir);
  assert.match(r.stdout, /^ {2}bundle pending: open-gsd\/gsd-core#5871 steps 3-8$/m);
  const b = bundle(dir);
  assert.equal(b.status, 'pending');
  assert.equal(b.line, 'bundle pending: open-gsd/gsd-core#5871 steps 3-8');
  assert.deepEqual(b.pending, [3, 4, 5, 6, 7, 8]);
});

test('a finished ledger reads complete, not pending', () => {
  const dir = fixtureDir();
  put(dir, ledger(8));
  assert.equal(bundle(dir).status, 'complete');
  assert.doesNotMatch(run(['5871'], dir).stdout, /bundle pending/);
});

test('a missing ledger is reported as no ledger, never as "no bundle pending"', () => {
  const dir = fixtureDir();
  assert.equal(bundle(dir).status, 'no-ledger');
  const text = run(['5871'], dir).stdout;
  assert.match(text, /^ {2}bundle: no ledger \(looked for .*\)$/m);
  assert.doesNotMatch(text, /no bundle pending|bundle pending/);
  assert.equal(bundle(path.join(dir, 'absent-subdir')).status, 'no-ledger'); // the dir itself missing is the same fact
});

test('a corrupt ledger (not JSON, wrong shape, another PR) is reported as corrupt, never as no bundle', () => {
  for (const body of ['{not json\n', JSON.stringify({ v: 9, repo: REPO, pr: 5871, steps: [] }) + '\n', ledger(2, { pr: 5000 }), ledger(2, { repo: 'a/b' })]) {
    const dir = fixtureDir();
    put(dir, body);
    assert.equal(bundle(dir).status, 'corrupt', JSON.stringify(body).slice(0, 40));
    const text = run(['5871'], dir).stdout;
    assert.match(text, /^ {2}bundle ledger corrupt: /m);
    assert.doesNotMatch(text, /no ledger|no bundle pending|bundle pending/);
  }
});

test('an unreadable ledger (the path is a directory) is reported as unreadable', () => {
  const dir = fixtureDir();
  fs.mkdirSync(path.join(dir, `${ledgerFileName(REPO, 5871)}.jsonl`));
  assert.equal(bundle(dir).status, 'unreadable');
  assert.match(run(['5871'], dir).stdout, /^ {2}bundle ledger unreadable: /m);
});

test('reads only: the ledger bytes and the directory listing are unchanged after a run', () => {
  const dir = fixtureDir();
  put(dir, ledger(2));
  const file = path.join(dir, `${ledgerFileName(REPO, 5871)}.jsonl`);
  const before = [fs.readFileSync(file, 'utf8'), fs.readdirSync(dir).join(','), fs.statSync(file).mtimeMs];
  run(['5871'], dir);
  run(['--json', '5871'], dir);
  assert.deepEqual([fs.readFileSync(file, 'utf8'), fs.readdirSync(dir).join(','), fs.statSync(file).mtimeMs], before);
});

// ---- quick 261113-wg1 independent review ----

const LEDGER_FILE = (dir) => path.join(dir, `${ledgerFileName(REPO, 5871)}.jsonl`);

test('WR-02: a mixed-case --repo writes and reads the same lowercase ledger file', () => {
  assert.equal(ledgerFileName('Open-GSD/GSD-Core', 5871), ledgerFileName('open-gsd/gsd-core', 5871));
  const dir = fixtureDir();
  fs.writeFileSync(path.join(dir, 'open-gsd__gsd-core__5871.jsonl'), JSON.stringify(ledger(2)) + '\n');
  const r = run(['--repo', 'Open-GSD/gsd-core', '5871'], dir);
  assert.match(r.stdout, /bundle pending: open-gsd\/gsd-core#5871 steps 3-8/);
  assert.doesNotMatch(r.stdout, /no ledger/);
});

test('WR-02: the no-ledger line names the path it looked for', () => {
  const dir = fixtureDir();
  const text = run(['5871'], dir).stdout;
  assert.ok(text.includes(LEDGER_FILE(dir)), text);
});

test('WR-02: --ledger-dir is honoured, and beats $PR_UPDATE_LEDGER_DIR', () => {
  const dir = fixtureDir();
  const other = fixtureDir();
  put(dir, ledger(2));
  const saved = process.env.PR_UPDATE_LEDGER_DIR;
  process.env.PR_UPDATE_LEDGER_DIR = other;
  try {
    const r = run(['--ledger-dir', dir, '5871'], undefined);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /bundle pending: open-gsd\/gsd-core#5871 steps 3-8/);
    assert.match(run(['--ledger-dir=' + dir, '5871'], undefined).stdout, /bundle pending/);
  } finally {
    if (saved === undefined) delete process.env.PR_UPDATE_LEDGER_DIR;
    else process.env.PR_UPDATE_LEDGER_DIR = saved;
  }
});

function assertUnreadable(dir, why) {
  const r = run(['5871'], dir);
  assert.equal(r.status, 0);
  assert.doesNotMatch(r.stdout, /ERROR|no ledger|bundle pending/);
  assert.match(r.stdout, new RegExp(`^ {2}bundle ledger unreadable: ${why}`, 'm'));
  assert.equal(bundle(dir).status, 'unreadable');
}

test('IN-01: a ledger over 1 MiB is unreadable, not read', () => {
  const dir = fixtureDir();
  fs.writeFileSync(LEDGER_FILE(dir), 'x'.repeat(2 * 1024 * 1024));
  assertUnreadable(dir, 'ledger over 1 MiB');
});

test('IN-01: a dangling symlink ledger is unreadable (dangling link), not no ledger', () => {
  const dir = fixtureDir();
  fs.symlinkSync(path.join(dir, 'nowhere'), LEDGER_FILE(dir));
  assertUnreadable(dir, 'dangling link');
});

test('IN-01: a FIFO ledger is unreadable and the read does not block', () => {
  const dir = fixtureDir();
  const fifo = LEDGER_FILE(dir);
  require('node:child_process').execFileSync('mkfifo', [fifo]);
  const writer = spawn('sh', ['-c', 'echo x > "$1"', 'sh', fifo], { stdio: 'ignore' });
  try {
    assertUnreadable(dir, '');
  } finally {
    writer.kill();
    try { fs.writeSync(fs.openSync(fifo, 'r+'), ''); } catch { /* unblock a stuck writer */ }
  }
});
