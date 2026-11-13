'use strict';

/**
 * bin/pr-status-excerpt.test.cjs - quick 261113-wb1: the --body excerpt-in-run-log check (PROPOSAL item 2)
 * and the upstream CHANGES_REQUESTED round count (item 5) of bin/pr-status.cjs.
 *
 * Hermetic: runCli gets an in-memory `gh` (JSON reads) and `ghText` (the run log text read); no network.
 *
 * @module bin/pr-status-excerpt.test
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');

const prStatus = require('./pr-status.cjs');

const HEAD = 'a'.repeat(40);
const RUN = 'https://github.com/davesienkowski/gsd-core-experiments/actions/runs/42744528257';
const LOG = [
  'selftest\tRun npm test\t2026-11-13T01:00:00.0000000Z # tests 5171',
  'selftest\tRun npm test\t2026-11-13T01:00:00.0000000Z # pass 5171',
  'selftest\tRun npm test\t2026-11-13T01:00:00.0000000Z # fail 0',
  '',
].join('\n');

function body({ excerpt = '# pass 5171\n# tests 5171', url = RUN, section = true } = {}) {
  if (!section) return 'Fixes #1\n';
  const report = { schema: 1, head_sha: HEAD, tool: 'npm-test', output_excerpt: excerpt };
  return `Fixes #1\n\n## Self-test report\n\n${url ? `Run: ${url}\n\n` : ''}\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\`\n`;
}

function review(id, login, state, assoc, extra = {}) {
  return { id, user: { login, type: 'User' }, state, author_association: assoc, submitted_at: `2026-11-1${id % 10}T00:00:00Z`, commit_id: HEAD, body: '', ...extra };
}

/** Run the CLI in process; returns { status, stdout, calls, textCalls }. */
function run(args, { bodyText = body(), reviews = [], timeline = [], log = LOG, logError = null } = {}) {
  const calls = [];
  const textCalls = [];
  const gh = (a) => {
    calls.push(a);
    if (a[0] === 'pr' && a[1] === 'view') {
      if (a[a.indexOf('--json') + 1].startsWith('body')) return { body: bodyText, baseRefOid: 'b'.repeat(40), changedFiles: 1 };
      return { number: 7, state: 'OPEN', isDraft: false, author: { login: 'me' }, headRefOid: HEAD, baseRefName: 'next', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: null, reviewRequests: [], commits: [], headRefName: 'fix/x', title: 'fix: x' };
    }
    if (a[0] === 'pr' && a[1] === 'checks') return [];
    if (a[0] === 'api' && /\/reviews\?/.test(a.join(' '))) return [reviews];
    if (a[0] === 'api' && /\/timeline\?/.test(a.join(' '))) return [timeline];
    throw new Error('stub: unexpected read ' + a.join(' '));
  };
  const ghText = (a) => {
    textCalls.push(a);
    if (logError) throw new Error(logError);
    return log;
  };
  let stdout = '';
  const status = prStatus.runCli(args, { gh, ghText, sleep: () => {}, stdout: { write: (x) => { stdout += x; } }, stderr: { write: () => {} } });
  return { status, stdout, calls, textCalls };
}

const json = (args, opts) => JSON.parse(run(['--json', ...args], opts).stdout)[0];

// ---- item 2 ----

test('excerpt: every line found in the run log -> ok, and the log is read through the text seam with run view --log', () => {
  const r = run(['--body', '7']);
  assert.match(r.stdout, /^ {2}body: excerpt in run log: ok \(2 counted lines; run davesienkowski\/gsd-core-experiments, its head sha not compared with the PR head\)$/m);
  assert.deepEqual(r.textCalls, [['run', 'view', '42744528257', '--repo', 'davesienkowski/gsd-core-experiments', '--log']]);
  assert.equal(r.status, 0);
});

test('excerpt: one altered character (hyphen for an em dash) -> not in run log, naming the first missing line', () => {
  const r = run(['--body', '7'], { bodyText: body({ excerpt: '# pass 5171\n# fail 0 - ok' }), log: LOG.replace('# fail 0', '# fail 0 — ok') });
  assert.match(r.stdout, /^ {2}body: excerpt not in run log: line 2 "# fail 0 - ok" \(first missing of 2 counted; not found in the log gh returned.*\)$/m);
  assert.equal(r.status, 0);
});

test('excerpt: no run URL in the Self-test section -> "no run URL" and no log read', () => {
  const r = run(['--body', '7'], { bodyText: body({ url: '' }) });
  assert.match(r.stdout, /^ {2}body: no run URL$/m);
  assert.equal(r.textCalls.length, 0);
});

test('excerpt: a URL that is not a github.com actions run (or has a non-digit id) is no run URL', () => {
  for (const url of ['https://example.com/davesienkowski/x/actions/runs/1', 'https://github.com/a/b/actions/runs/12x', 'https://github.com/a/b/pull/1']) {
    const r = run(['--body', '7'], { bodyText: body({ url }) });
    assert.match(r.stdout, /^ {2}body: no run URL$/m, url);
    assert.equal(r.textCalls.length, 0, url);
  }
});

test('excerpt: no Self-test section prints no excerpt line and reads no log', () => {
  const r = run(['--body', '7'], { bodyText: body({ section: false }) });
  assert.doesNotMatch(r.stdout, /excerpt|no run URL/);
  assert.equal(r.textCalls.length, 0);
});

test('excerpt: an unreadable run log is named, never thrown, exit code unchanged', () => {
  const r = run(['--body', '7'], { logError: 'HTTP 404: Not Found' });
  assert.match(r.stdout, /^ {2}body: excerpt not checked: run log unread \(HTTP 404: Not Found\)$/m);
  assert.equal(r.status, 0);
});

test('excerpt: blank excerpt lines and CRLF are tolerated; --json carries the status object', () => {
  const j = json(['--body', '7'], { bodyText: body({ excerpt: '# pass 5171\n\n# tests 5171\r\n' }), log: LOG.replace(/\n/g, '\r\n') });
  assert.equal(j.body.excerpt.status, 'ok');
  assert.equal(j.body.excerpt.lines, 2);
  assert.equal(j.body.excerpt.runUrl, RUN);
  const bad = json(['--body', '7'], { bodyText: body({ excerpt: 'never printed' }) });
  assert.equal(bad.body.excerpt.status, 'missing');
  assert.equal(bad.body.excerpt.missingLine, 1);
});

test('excerpt: without --body no run view and no text read is made', () => {
  const r = run(['7']);
  assert.equal(r.textCalls.length, 0);
  assert.ok(!r.calls.some((c) => c.includes('run')));
});

test('excerpt: the default text reader passes maxBuffer 64 MiB (261109-suo convention) and does not JSON.parse', () => {
  const orig = childProcess.execFileSync;
  let seen = null;
  childProcess.execFileSync = (cmd, args, opts) => {
    seen = { cmd, args, opts };
    return 'plain text, not json\n';
  };
  try {
    delete require.cache[require.resolve('./pr-status.cjs')];
    const fresh = require('./pr-status.cjs');
    let stdout = '';
    const gh = (a) => {
      if (a[0] === 'pr' && a[1] === 'view') return a[a.indexOf('--json') + 1].startsWith('body') ? { body: body(), baseRefOid: 'b'.repeat(40), changedFiles: 1 } : { number: 7, state: 'OPEN', author: { login: 'me' }, headRefOid: HEAD, baseRefName: 'next', reviewRequests: [], commits: [], headRefName: 'f', title: 't' };
      if (a[0] === 'pr') return [];
      return [[]];
    };
    fresh.runCli(['--body', '7'], { gh, sleep: () => {}, stdout: { write: (x) => { stdout += x; } }, stderr: { write: () => {} } });
    assert.equal(seen.cmd, 'gh');
    assert.deepEqual(seen.args, ['run', 'view', '42744528257', '--repo', 'davesienkowski/gsd-core-experiments', '--log']);
    assert.equal(seen.opts.maxBuffer, 64 * 1024 * 1024);
    assert.match(stdout, /excerpt not in run log/);
  } finally {
    childProcess.execFileSync = orig;
    delete require.cache[require.resolve('./pr-status.cjs')];
  }
});

// ---- item 5 ----

const CR = (id, login, assoc) => review(id, login, 'CHANGES_REQUESTED', assoc);

test('rounds: counts CHANGES_REQUESTED reviews by OWNER, MEMBER and COLLABORATOR only', () => {
  const reviews = [
    CR(1, 'trek-e', 'MEMBER'),
    CR(2, 'trek-e', 'MEMBER'), // two from one reviewer = two rounds
    CR(3, 'someone', 'CONTRIBUTOR'), // not a maintainer
    CR(4, 'drive-by', 'NONE'),
    CR(5, 'me', 'OWNER'), // the PR author
    { ...CR(6, 'bot', 'MEMBER'), user: { login: 'bot', type: 'Bot' } },
    review(7, 'trek-e', 'APPROVED', 'MEMBER'),
    review(8, 'trek-e', 'COMMENTED', 'MEMBER'),
    CR(9, 'owner', 'OWNER'),
    CR(10, 'collab', 'COLLABORATOR'),
  ];
  const r = run(['7'], { reviews });
  assert.match(r.stdout, /^ {2}upstream CR rounds: 4$/m);
  assert.equal(json(['7'], { reviews }).upstreamCr.rounds, 4);
});

test('rounds: zero rounds prints no line (existing output stays byte-identical) but --json has the object', () => {
  const reviews = [review(1, 'trek-e', 'APPROVED', 'MEMBER')];
  assert.doesNotMatch(run(['7'], { reviews }).stdout, /upstream CR rounds|same band/);
  const u = json(['7'], { reviews }).upstreamCr;
  assert.equal(u.rounds, 0);
  assert.equal(u.band.label, 'ABSTAIN');
});

test('rounds: a DISMISSED review counts when the timeline shows it was CHANGES_REQUESTED; without the timeline it is a floor', () => {
  const dismissed = review(3, 'trek-e', 'DISMISSED', 'MEMBER');
  const timeline = [{ event: 'review_dismissed', dismissed_review: { review_id: 3, state: 'changes_requested' }, actor: { login: 'me' }, created_at: '2026-11-13T00:00:00Z' }];
  const reviews = [CR(1, 'trek-e', 'MEMBER'), dismissed];
  assert.match(run(['7'], { reviews, timeline }).stdout, /^ {2}upstream CR rounds: 2$/m);
  const none = [{ event: 'review_dismissed', dismissed_review: { review_id: 3, state: 'approved' }, actor: { login: 'me' }, created_at: '2026-11-13T00:00:00Z' }];
  assert.match(run(['7'], { reviews, timeline: none }).stdout, /^ {2}upstream CR rounds: 1$/m);
});

test('band: fewer than 3 rounds prints no band line; 3 or more prints ABSTAIN with the reason and the last three review ids', () => {
  const two = [CR(1, 'trek-e', 'MEMBER'), CR(2, 'trek-e', 'MEMBER')];
  assert.doesNotMatch(run(['7'], { reviews: two }).stdout, /same band/);
  const four = [...two, CR(3, 'trek-e', 'MEMBER'), CR(4, 'trek-e', 'MEMBER')];
  const r = run(['7'], { reviews: four });
  assert.match(r.stdout, /^ {2}upstream CR rounds: 4$/m);
  assert.match(r.stdout, /^ {2}same band: ABSTAIN \(.+\); last 3 reviews 2, 3, 4$/m);
  const u = json(['7'], { reviews: four }).upstreamCr;
  assert.deepEqual(u.lastThree, [2, 3, 4]);
  assert.match(u.band.reason, /failure/);
});

test('excerpt: a run URL with /attempts/N reads that attempt (--attempt N)', () => {
  const r = run(['--body', '7'], { bodyText: body({ url: RUN + '/attempts/2' }) });
  assert.deepEqual(r.textCalls[0], ['run', 'view', '42744528257', '--repo', 'davesienkowski/gsd-core-experiments', '--attempt', '2', '--log']);
  assert.match(r.stdout, /excerpt in run log: ok/);
});

test('excerpt: lines under 8 non-space characters do not count; an excerpt of only such lines is not checked, never ok', () => {
  const only = run(['--body', '7'], { bodyText: body({ excerpt: '0\nok\nexit 0' }) });
  assert.match(only.stdout, /^ {2}body: excerpt not checked: no output_excerpt string, or no line of at least 8 non-space characters/m);
  assert.doesNotMatch(only.stdout, /excerpt in run log: ok/);
  const mixed = json(['--body', '7'], { bodyText: body({ excerpt: 'ok\n# pass 5171' }) });
  assert.equal(mixed.body.excerpt.lines, 1);
});

test('rounds: timeline reviewed events duplicating the reviews payload do not change the count', () => {
  const reviews = [CR(1, 'trek-e', 'COLLABORATOR'), CR(2, 'trek-e', 'COLLABORATOR')];
  const timeline = reviews.map((r) => ({ event: 'reviewed', id: r.id, state: 'changes_requested', user: r.user }));
  assert.equal(json(['7'], { reviews, timeline }).upstreamCr.rounds, 2);
});

test('rounds: a captured fixture with author_association merged in prints the rounds line (the real API shape)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'pr-status', 'cr-5192-captured.json'), 'utf8'));
  const reviews = fx.reviews.map((page) => page.map((r) => ({ ...r, author_association: 'COLLABORATOR' })));
  const n = reviews.flat().filter((r) => r.state === 'CHANGES_REQUESTED' && r.user.login.toLowerCase() !== String(fx.view.author.login).toLowerCase() && r.user.type !== 'Bot').length;
  assert.ok(n > 0, 'fixture has change requests');
  const r = run(['7'], { reviews: reviews.flat() });
  assert.match(r.stdout, new RegExp(`^ {2}upstream CR rounds: ${n}$`, 'm'));
});
