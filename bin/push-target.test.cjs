'use strict';

/**
 * bin/push-target.test.cjs - HERMETIC test of the push-target resolver (`bin/push-target.cjs`, quick 261022-w9m).
 *
 * What this pins: remote URL parsing (https, ssh, scp, .git, trailing slash, case, look-alike repos);
 * the verdict (up to date, fast-forward, not a fast-forward, branch absent, unknown ancestry) and the
 * printed command (a lease, never a bare --force); the error exits (no matching remote, deleted head
 * repo); and, end to end through a stub gh and a stub git on PATH, that only read verbs run: the stub
 * git refuses anything but remote -v, ls-remote, rev-parse and merge-base, and the stub gh refuses
 * every write verb and GraphQL.
 *
 * @module bin/push-target.test
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const pt = require('./push-target.cjs');

const SCRIPT = path.join(__dirname, 'push-target.cjs');
const GH_STUB = path.join(__dirname, 'fixtures', 'pr-status-gh-stub.cjs');

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const PULL = (over = {}) =>
  Object.assign({ number: 5119, state: 'open', maintainer_can_modify: true, head: { repo: { full_name: 'davesienkowski/gsd-core' }, ref: 'feat/5104-x', sha: A } }, over);
const REMOTES = [
  { name: 'backup', url: 'https://github.com/davesienkowski/gsd-core-sandbox.git', pushUrls: ['https://github.com/davesienkowski/gsd-core-sandbox.git'] },
  { name: 'fork', url: 'https://github.com/davesienkowski/gsd-core.git', pushUrls: ['https://github.com/davesienkowski/gsd-core.git'] },
  { name: 'origin', url: 'https://github.com/open-gsd/gsd-core.git', pushUrls: ['https://github.com/open-gsd/gsd-core.git'] },
];

test('parseRemoteUrl: https, ssh and scp forms, .git, trailing slash and case all name the same repo', () => {
  for (const u of [
    'https://github.com/DaveSienkowski/gsd-core.git',
    'https://github.com/davesienkowski/gsd-core',
    'https://github.com/davesienkowski/gsd-core/',
    'http://user@github.com/davesienkowski/gsd-core.git',
    'ssh://git@github.com/davesienkowski/gsd-core.git',
    'ssh://git@github.com:22/davesienkowski/gsd-core',
    'git@github.com:davesienkowski/gsd-core.git',
    'git@github.com:davesienkowski/gsd-core',
    'git://github.com/davesienkowski/gsd-core.git',
  ]) {
    assert.equal(pt.parseRemoteUrl(u), 'davesienkowski/gsd-core', u);
  }
  // look-alikes and non-GitHub hosts do not match
  assert.equal(pt.parseRemoteUrl('https://github.com/davesienkowski/gsd-core-sandbox.git'), 'davesienkowski/gsd-core-sandbox');
  assert.equal(pt.parseRemoteUrl('https://gitlab.com/davesienkowski/gsd-core.git'), null);
  assert.equal(pt.parseRemoteUrl('git@github-work:davesienkowski/gsd-core.git'), null, 'an ssh host alias is not resolved');
  assert.equal(pt.parseRemoteUrl('/home/user/repos/gsd-core'), null);
  assert.equal(pt.parseRemoteUrl('https://github.com/davesienkowski/gsd-core/extra'), null);
});

test('parseRemotes and parseLsRemote read fetch lines and the exact branch ref only', () => {
  const r = pt.parseRemotes('fork\thttps://x/a/b.git (fetch)\nfork\thttps://x/a/b.git (push)\norigin\tgit@github.com:o/r (fetch)\n');
  assert.deepEqual(r, [{ name: 'fork', url: 'https://x/a/b.git' }, { name: 'origin', url: 'git@github.com:o/r' }]);
  assert.equal(pt.parseLsRemote(`${A}\trefs/heads/feat/x\n`, 'feat/x'), A);
  assert.equal(pt.parseLsRemote(`${A}\trefs/heads/feat/x-2\n`, 'feat/x'), null);
  assert.equal(pt.parseLsRemote('', 'feat/x'), null);
});

test('verdict: equal tips are up to date and a descendant HEAD is a fast-forward, both with a plain push', () => {
  let d = pt.derive({ pr: PULL(), remotes: REMOTES, remoteTip: A, localHead: A, ancestor: null });
  assert.equal(d.remote, 'fork');
  assert.equal(d.verdict, 'up to date');
  assert.deepEqual(d.commands, ['git push fork HEAD:feat/5104-x']);
  d = pt.derive({ pr: PULL(), remotes: REMOTES, remoteTip: A, localHead: B, ancestor: true });
  assert.equal(d.verdict, 'fast-forward');
  assert.deepEqual(d.commands, ['git push fork HEAD:feat/5104-x']);
});

test('verdict: not a fast-forward prints a lease pinned to the tip read now, never a bare --force', () => {
  const d = pt.derive({ pr: PULL(), remotes: REMOTES, remoteTip: A, localHead: B, ancestor: false });
  assert.equal(d.verdict, 'not a fast-forward');
  assert.deepEqual(d.commands, [`git push --force-with-lease=feat/5104-x:${A} fork HEAD:feat/5104-x`]);
  for (const c of d.commands) assert.ok(!/--force(\s|$)/.test(c));
});

test('round 2 (Major 2): unknown ancestry prints the fetch step and a plain push only, never a lease', () => {
  const d = pt.derive({ pr: PULL(), remotes: REMOTES, remoteTip: A, localHead: B, ancestor: null });
  assert.equal(d.verdict, 'unknown');
  assert.deepEqual(d.commands, ['git push fork HEAD:feat/5104-x']);
  assert.deepEqual(d.firstSteps, ['git fetch fork feat/5104-x']);
  for (const c of [...d.commands, ...d.firstSteps]) assert.ok(!c.includes('--force'), c);
  const text = pt.formatText({ repo: 'open-gsd/gsd-core', ...d });
  assert.match(text, /^ {2}first: git fetch fork feat\/5104-x$/m);
  assert.match(text, /^ {2}warning: the remote has commits this checkout has not fetched; /m);
  assert.ok(!text.includes('--force-with-lease'), text);
});

test('empty: branch absent on the remote is a plain push; no matching remote and a deleted head repo are errors', () => {
  let d = pt.derive({ pr: PULL(), remotes: REMOTES, remoteTip: null, localHead: B, ancestor: null });
  assert.equal(d.verdict, 'branch not on remote');
  assert.deepEqual(d.commands, ['git push fork HEAD:feat/5104-x']);
  d = pt.derive({ pr: PULL(), remotes: [REMOTES[0], REMOTES[2]], remoteTip: null, localHead: '', ancestor: null });
  assert.equal(d.ok, false);
  assert.match(d.error, /no local remote names davesienkowski\/gsd-core/);
  d = pt.derive({ pr: PULL({ head: { repo: null, ref: 'x', sha: A } }), remotes: REMOTES, remoteTip: null, localHead: '', ancestor: null });
  assert.equal(d.ok, false);
  assert.match(d.error, /head repository deleted/);
});

test('ordering: two remotes naming head.repo pick the first in git remote -v order and list the other', () => {
  const d = pt.derive({ pr: PULL(), remotes: [...REMOTES, { name: 'fork2', url: 'git@github.com:davesienkowski/gsd-core.git', pushUrls: ['git@github.com:davesienkowski/gsd-core.git'] }], remoteTip: A, localHead: A, ancestor: null });
  assert.equal(d.remote, 'fork');
  assert.deepEqual(d.alternatives, ['fork2']);
});

test('round 2 (Major 1): a remote whose push URL names another repo is rejected with the reason; a clean one is used', () => {
  const bad = { name: 'fork', url: 'https://github.com/davesienkowski/gsd-core.git', pushUrls: ['https://github.com/open-gsd/gsd-core.git'] };
  let d = pt.derive({ pr: PULL(), remotes: [bad], remoteTip: null, localHead: '', ancestor: null });
  assert.equal(d.ok, false);
  assert.match(d.error, /no usable remote for davesienkowski\/gsd-core/);
  assert.deepEqual(d.rejected, [{ name: 'fork', reason: 'push URL https://github.com/open-gsd/gsd-core.git names open-gsd/gsd-core, not davesienkowski/gsd-core' }]);
  // every push URL must name head.repo: one good and one bad push URL still rejects
  d = pt.derive({ pr: PULL(), remotes: [{ ...bad, pushUrls: ['git@github.com:davesienkowski/gsd-core.git', 'https://github.com/open-gsd/gsd-core.git'] }], remoteTip: null, localHead: '', ancestor: null });
  assert.equal(d.ok, false);
  // a second remote with matching fetch and push URLs is chosen, and the rejection is still reported
  const good = { name: 'fork2', url: 'git@github.com:davesienkowski/gsd-core.git', pushUrls: ['git@github.com:davesienkowski/gsd-core.git'] };
  d = pt.derive({ pr: PULL(), remotes: [bad, good], remoteTip: A, localHead: A, ancestor: null });
  assert.equal(d.ok, true);
  assert.equal(d.remote, 'fork2');
  assert.equal(d.rejected.length, 1);
  assert.match(pt.formatText({ repo: 'o/r', ...d }), /^ {2}rejected: fork \(push URL https:\/\/github\.com\/open-gsd\/gsd-core\.git names open-gsd\/gsd-core, not davesienkowski\/gsd-core\)$/m);
  // no push URL read at all is a rejection too (fail closed)
  d = pt.derive({ pr: PULL(), remotes: [{ ...bad, pushUrls: [] }], remoteTip: null, localHead: '', ancestor: null });
  assert.equal(d.ok, false);
});

test('round 2 (Major 1): a scratch repo with fetch URL on the fork and pushurl on open-gsd is rejected, using real git', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'push-target-repo-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const g = (...a) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  g('init', '-q');
  g('remote', 'add', 'fork', 'https://github.com/davesienkowski/gsd-core.git');
  g('config', 'remote.fork.pushurl', 'https://github.com/open-gsd/gsd-core.git');
  const calls = [];
  const git = (args, cwd) => {
    calls.push(args);
    if (args[0] === 'ls-remote' || args[0] === 'merge-base') throw new Error('no network read expected for a rejected remote');
    return pt.defaultGit(args, cwd);
  };
  const d = pt.resolve('5119', 'open-gsd/gsd-core', dir, { gh: () => PULL(), git });
  assert.equal(d.ok, false, JSON.stringify(d));
  assert.match(d.rejected[0].reason, /push URL https:\/\/github\.com\/open-gsd\/gsd-core\.git names open-gsd\/gsd-core/);
  assert.deepEqual(calls[1], ['remote', 'get-url', '--push', '--all', 'fork']);
});

test('round 2 (nit): a remote name starting with - is never used, so it cannot reach git as an option', () => {
  const d = pt.derive({ pr: PULL(), remotes: [{ name: '--upload-pack=./x.sh', url: 'https://github.com/davesienkowski/gsd-core.git', pushUrls: ['https://github.com/davesienkowski/gsd-core.git'] }], remoteTip: null, localHead: '', ancestor: null });
  assert.equal(d.ok, false);
  assert.match(d.rejected[0].reason, /starts with -/);
  assert.throws(() => pt.defaultGit(['remote', 'get-url', '--push', '--all', '--upload-pack=x'], '/nowhere'), /refuses/);
});

test('round 2 (nit): --help prints the usage and exits 0 with no call', (t) => {
  const r = runCli(t, ['--help'], { pull: PULL(), gitScript: GIT_OK });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^usage: push-target /m);
  assert.equal(r.ghLog.length + r.gitLog.length, 0);
});

test('safety: the default git runner refuses every verb but the four reads, and remote anything but -v', () => {
  const git = require('./push-target.cjs');
  assert.deepEqual([...git.GIT_READ_VERBS].sort(), ['ls-remote', 'merge-base', 'remote', 'rev-parse']);
  // drive resolve with a recording git to show the exact reads, then the real runner's refusals
  const calls = [];
  const fakeGit = (args) => {
    calls.push(args);
    if (args[0] === 'remote' && args[1] === 'get-url') return { status: 0, stdout: 'https://github.com/davesienkowski/gsd-core.git\n', stderr: '' };
    if (args[0] === 'remote') return { status: 0, stdout: 'fork\thttps://github.com/davesienkowski/gsd-core.git (fetch)\n', stderr: '' };
    if (args[0] === 'ls-remote') return { status: 0, stdout: `${A}\trefs/heads/feat/5104-x\n`, stderr: '' };
    if (args[0] === 'rev-parse') return { status: 0, stdout: (args[1] === '--abbrev-ref' ? 'feat/5104-x' : B) + '\n', stderr: '' };
    if (args[0] === 'merge-base') return { status: 128, stdout: '', stderr: 'fatal: Not a valid commit name' };
    throw new Error('unexpected ' + args.join(' '));
  };
  const d = pt.resolve('5119', 'open-gsd/gsd-core', '/nowhere', { gh: () => PULL(), git: fakeGit });
  assert.equal(d.verdict, 'unknown');
  assert.deepEqual(calls, [['remote', '-v'], ['remote', 'get-url', '--push', '--all', 'fork'], ['ls-remote', 'fork', 'refs/heads/feat/5104-x'], ['rev-parse', 'HEAD'], ['rev-parse', '--abbrev-ref', 'HEAD'], ['merge-base', '--is-ancestor', A, 'HEAD']]);
  assert.equal(d.branchMatches, true);
});

function runCli(t, args, { pull, gitScript }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'push-target-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  const fx = path.join(dir, 'fx');
  fs.mkdirSync(bin);
  fs.mkdirSync(fx);
  fs.copyFileSync(GH_STUB, path.join(bin, 'gh'));
  fs.chmodSync(path.join(bin, 'gh'), 0o755);
  if (pull) fs.writeFileSync(path.join(fx, 'pull.json'), JSON.stringify({ provenance: { source: 'synthetic' }, view: { number: pull.number }, pull }));
  const gitLog = path.join(dir, 'git.log');
  // stub git: logs argv, answers the four reads from GIT_STUB_JSON, refuses (exit 99) anything else
  fs.writeFileSync(
    path.join(bin, 'git'),
    `#!/usr/bin/env node
const fs = require('fs');
let a = process.argv.slice(2);
if (a[0] === '-C') a = a.slice(2);
fs.appendFileSync(${JSON.stringify(gitLog)}, JSON.stringify(a) + '\\n');
const s = ${JSON.stringify(gitScript)};
const key = a[0] === 'remote' && a[1] === '-v' ? 'remote' : a[0] === 'remote' && a[1] === 'get-url' ? 'pushurl:' + a[4] : a[0] === 'rev-parse' && a[1] === '--abbrev-ref' ? 'branch' : a[0];
if (!['remote', 'ls-remote', 'rev-parse', 'merge-base'].includes(a[0]) || !(key in s)) { fs.appendFileSync(${JSON.stringify(gitLog)}, 'REFUSED ' + JSON.stringify(a) + '\\n'); process.exitCode = 99; }
else { const [code, out] = s[key]; process.stdout.write(out); process.exitCode = code; }
`
  );
  fs.chmodSync(path.join(bin, 'git'), 0o755);
  const ghLog = path.join(dir, 'gh.log');
  fs.writeFileSync(ghLog, '');
  fs.writeFileSync(gitLog, '');
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    cwd: dir,
    env: Object.assign({}, process.env, { PATH: bin + path.delimiter + process.env.PATH, PR_STATUS_STUB_FIXTURES: fx, PR_STATUS_STUB_LOG: ghLog }),
  });
  return {
    status: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    ghLog: fs.readFileSync(ghLog, 'utf8').split('\n').filter(Boolean),
    gitLog: fs.readFileSync(gitLog, 'utf8').split('\n').filter(Boolean),
  };
}

const GIT_OK = {
  remote: [0, 'origin\thttps://github.com/open-gsd/gsd-core.git (fetch)\nfork\thttps://github.com/davesienkowski/gsd-core.git (fetch)\n'],
  'pushurl:fork': [0, 'https://github.com/davesienkowski/gsd-core.git\n'],
  'ls-remote': [0, `${A}\trefs/heads/feat/5104-x\n`],
  'rev-parse': [0, B + '\n'],
  branch: [0, 'feat/5104-x\n'],
  'merge-base': [0, ''],
};

test('end to end: one gh GET and the four git reads print the remote, the verdict and the push command', (t) => {
  const r = runCli(t, ['5119'], { pull: PULL(), gitScript: GIT_OK });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /^open-gsd\/gsd-core#5119 OPEN head davesienkowski\/gsd-core:feat\/5104-x \(GitHub head a{9}\)$/m);
  assert.match(r.stdout, /^ {2}remote: fork \(https:\/\/github\.com\/davesienkowski\/gsd-core\.git\)$/m);
  assert.match(r.stdout, /^ {2}remote tip: a{9}; local HEAD: b{9}; fast-forward$/m);
  assert.match(r.stdout, /^ {2}push: git push fork HEAD:feat\/5104-x$/m);
  assert.deepEqual(r.ghLog.map((l) => JSON.parse(l)), [['api', 'repos/open-gsd/gsd-core/pulls/5119']]);
  assert.ok(!r.gitLog.some((l) => l.startsWith('REFUSED')), r.gitLog.join(' | '));
  assert.deepEqual(r.gitLog.map((l) => JSON.parse(l)[0]), ['remote', 'remote', 'ls-remote', 'rev-parse', 'rev-parse', 'merge-base']);
  assert.ok(!/local branch is/.test(r.stdout), 'no branch note when the branch matches');
});

test('end to end: a local branch other than head.ref (or a detached HEAD) prints a note before the command', (t) => {
  for (const name of ['main', 'HEAD']) {
    const r = runCli(t, ['5119'], { pull: PULL(), gitScript: { ...GIT_OK, branch: [0, name + '\n'], 'merge-base': [1, ''] } });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`^ {2}note: the local branch is ${name}, not feat/5104-x: the command pushes HEAD, so confirm HEAD is this PR's work first$`, 'm'));
  }
});

test('end to end: no matching remote exits 1 and lists the remotes; a bad --repo or two numbers exit 2 with no call', (t) => {
  let r = runCli(t, ['5119'], { pull: PULL({ head: { repo: { full_name: 'someone/else' }, ref: 'x', sha: A } }), gitScript: GIT_OK });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /ERROR: no local remote names someone\/else/);
  assert.match(r.stdout, /^ {2}remote: fork https:\/\/github\.com\/davesienkowski\/gsd-core\.git$/m);
  for (const args of [['--repo', 'bad', '1'], ['1', '2'], []]) {
    r = runCli(t, args, { pull: PULL(), gitScript: GIT_OK });
    assert.equal(r.status, 2, JSON.stringify(args));
    assert.equal(r.ghLog.length + r.gitLog.length, 0);
  }
});

test('end to end: a PR the gh read cannot find exits 1 with the gh error and runs no git', (t) => {
  const r = runCli(t, ['5119'], { pull: null, gitScript: GIT_OK });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^open-gsd\/gsd-core#5119 ERROR: gh: Not Found \(HTTP 404\)$/m);
  assert.equal(r.gitLog.length, 0);
});

test('end to end: --json carries the verdict and commands', (t) => {
  const r = runCli(t, ['--json', '5119'], { pull: PULL(), gitScript: { ...GIT_OK, 'merge-base': [1, ''] } });
  assert.equal(r.status, 0, r.stderr);
  const d = JSON.parse(r.stdout);
  assert.equal(d.verdict, 'not a fast-forward');
  assert.deepEqual(d.commands, [`git push --force-with-lease=feat/5104-x:${A} fork HEAD:feat/5104-x`]);
});

test('safety: the real git runner throws before spawning for push, fetch, remote add and any other non-read verb', () => {
  for (const args of [['push', 'fork', 'HEAD:x'], ['fetch', 'fork'], ['remote', 'add', 'x', 'y'], ['remote', 'set-url', 'x', 'y'], ['update-ref', 'x', 'y'], ['config', 'x']]) {
    assert.throws(() => pt.defaultGit(args, '/nonexistent-dir'), /push-target (refuses git|runs only git remote -v)/, args.join(' '));
  }
});
