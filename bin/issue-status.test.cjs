'use strict';

/**
 * bin/issue-status.test.cjs - HERMETIC test of the read-only issue thread snapshot (`bin/issue-status.cjs`).
 *
 * What this pins (quick 261022-w9m):
 *   - derive() over issues and timelines captured from open-gsd/gsd-core (#5120, #4649 on 2026-10-23):
 *     the ball recorded by hand in the sweep notes (5120: trek-e owes a reply; 4649: forfrossen owes one).
 *   - the ball rule's edges: equal timestamps keep timeline order, @mentions in code or quotes do not
 *     count, logins compare case-insensitively, bots are not human comments, a PR number gets no ball.
 *   - end to end through the shared stub gh (bin/fixtures/pr-status-gh-stub.cjs): the argv log holds
 *     only GET reads, `pr view` for each linked same-repo PR, and pr-status's reads for an open one;
 *     the stub REFUSES any write verb or GraphQL and the test asserts it refused nothing.
 *
 * @module bin/issue-status.test
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const issueStatus = require('./issue-status.cjs');

const SCRIPT = path.join(__dirname, 'issue-status.cjs');
const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'issue-status');
const STUB_FILE = path.join(__dirname, 'fixtures', 'pr-status-gh-stub.cjs');

function load(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, name), 'utf8'));
}

/** A fixtures dir holding the captured fixtures plus the given synthetic ones. */
function fixturesWith(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-status-fx-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const f of fs.readdirSync(FIXTURES_DIR)) fs.copyFileSync(path.join(FIXTURES_DIR, f), path.join(dir, f));
  for (const [name, body] of Object.entries(extra)) fs.writeFileSync(path.join(dir, name), JSON.stringify(body));
  return dir;
}

function run(t, args, fixturesDir = FIXTURES_DIR) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-status-stub-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'bin'));
  fs.copyFileSync(STUB_FILE, path.join(dir, 'bin', 'gh'));
  fs.chmodSync(path.join(dir, 'bin', 'gh'), 0o755);
  const logFile = path.join(dir, 'argv.log');
  fs.writeFileSync(logFile, '');
  const env = Object.assign({}, process.env, {
    PATH: path.join(dir, 'bin') + path.delimiter + process.env.PATH,
    PR_STATUS_STUB_FIXTURES: fixturesDir,
    PR_STATUS_STUB_LOG: logFile,
  });
  delete env.PR_STATUS_STUB_QUEUE;
  const res = spawnSync(process.execPath, [SCRIPT, ...args], { env, encoding: 'utf8' });
  const { status, stdout, stderr } = res;
  const log = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean);
  return { status, stdout, stderr, log };
}

function noRefusals(r) {
  assert.ok(!r.log.some((l) => l.startsWith('REFUSED')), `stub refused: ${r.log.filter((l) => l.startsWith('REFUSED')).join(' | ')}`);
}

const ISSUE = (over = {}) => Object.assign({ number: 900100, title: 't', state: 'open', user: { login: 'Dave', type: 'User' }, labels: [], assignees: [], html_url: 'https://github.com/o/r/issues/900100' }, over);
const C = (login, at, body, extra = {}) => Object.assign({ event: 'commented', user: { login, type: 'User' }, created_at: at, body, author_association: 'COLLABORATOR', html_url: 'u' }, extra);

// --- captured threads: the hand-recorded balls from the 2026-10-23 sweep ---

test('captured #5120: the author asked trek-e last and trek-e has not answered, so trek-e owes the reply', () => {
  const d = issueStatus.derive(load('issue-5120-captured.json'));
  assert.equal(d.ball.owner, 'mentioned');
  assert.deepEqual(d.ball.logins, ['trek-e']);
  assert.equal(d.lastNonAuthor.login, 'trek-e');
  assert.equal(d.authorReplied, true);
  assert.deepEqual(d.linkedPrs.map((p) => p.number), [5119]);
});

test('captured #4649: forfrossen owes the reply; both cross-referencing PRs are listed once, ascending', () => {
  const d = issueStatus.derive(load('issue-4649-captured.json'));
  assert.equal(d.ball.owner, 'mentioned');
  assert.deepEqual(d.ball.logins, ['forfrossen']);
  assert.deepEqual(d.linkedPrs.map((p) => p.number), [4955, 5079]);
});

// --- the ball rule's edges ---

test('adjacency: equal created_at keeps timeline order, and a reply counts only when it comes later', () => {
  const same = '2026-10-01T00:00:00Z';
  // author first, then the maintainer, same second: the author has NOT replied after it
  let d = issueStatus.derive({ issue: ISSUE(), timeline: [C('Dave', same, 'hi'), C('trek-e', same, 'q?')] });
  assert.equal(d.authorReplied, false);
  assert.equal(d.ball.owner, 'author');
  // maintainer first, then the author, same second: replied
  d = issueStatus.derive({ issue: ISSUE(), timeline: [C('trek-e', same, 'q?'), C('Dave', same, 'answer @trek-e')] });
  assert.equal(d.authorReplied, true);
  assert.deepEqual(d.ball.logins, ['trek-e']);
  // the mentioned login comments in the same second but listed before the author's comment: not an answer
  d = issueStatus.derive({ issue: ISSUE(), timeline: [C('trek-e', same, 'x'), C('Dave', same, '@trek-e ping')] });
  assert.equal(d.ball.owner, 'mentioned');
  // listed after: answered, and the newest comment is then trek-e's, so the author owes
  d = issueStatus.derive({ issue: ISSUE(), timeline: [C('Dave', same, '@trek-e ping'), C('trek-e', same, 'x')] });
  assert.equal(d.ball.owner, 'author');
});

test('empty: no comments reads maintainers; a closed issue and a PR number get no ball', () => {
  let d = issueStatus.derive({ issue: ISSUE(), timeline: [] });
  assert.equal(d.ball.owner, 'maintainers');
  assert.match(issueStatus.formatText(d), /^ {2}comments: none$/m);
  d = issueStatus.derive({ issue: ISSUE({ state: 'closed' }), timeline: [C('trek-e', 't', 'x')] });
  assert.equal(d.ball.owner, 'n/a');
  d = issueStatus.derive({ issue: ISSUE({ pull_request: { url: 'x' } }), timeline: [] });
  assert.equal(d.ball.owner, 'n/a');
  assert.equal(issueStatus.formatText({ repo: 'o/r', ...d }), 'o/r#900100 is a pull request, use pr-status');
});

test('encoding: logins compare case-insensitively; mentions in code, inline code and quotes do not count', () => {
  assert.deepEqual(issueStatus.mentionsIn('see `@a` and\n```\n@b\n```\n> @c said\n@D and @e/team and x@f.com and (@g)'), ['d', 'g']);
  const d = issueStatus.derive({ issue: ISSUE(), timeline: [C('dave', 't1', 'question for @Trek-E'), C('TREK-E', 't0', 'old')] });
  assert.equal(d.lastNonAuthor.login, 'TREK-E');
  assert.equal(d.ball.owner, 'mentioned', 'the author (lower case) is still the author');
  assert.deepEqual(d.ball.logins, ['trek-e']);
  // the author mentioning themself is not a question to anyone
  const self = issueStatus.derive({ issue: ISSUE(), timeline: [C('Dave', 't1', 'note to @dave')] });
  assert.equal(self.ball.owner, 'maintainers');
});

test('encoding: hostile GitHub strings print ASCII-only (controls dropped, non-ASCII as ?)', () => {
  const d = issueStatus.derive({ issue: ISSUE({ title: 'a\u001b[31mred\u00e9' }), timeline: [C('trek-e', 't', 'caf\u00e9 \u0007bell')] });
  const text = issueStatus.formatText({ repo: 'o/r', ...d });
  assert.ok(/^[\x0a\x20-\x7e]*$/.test(text), text);
  assert.ok(text.includes('"a[31mred?"'), text);
});

test('bots: a bot comment is counted but never decides the ball', () => {
  const d = issueStatus.derive({
    issue: ISSUE(),
    timeline: [C('trek-e', 't1', 'q?'), C('github-actions[bot]', 't2', 'auto'), C('dependabot', 't3', 'x', { user: { login: 'dependabot', type: 'Bot' } })],
  });
  assert.deepEqual(d.comments, { human: 1, bot: 2 });
  assert.equal(d.ball.owner, 'author');
});

test('ordering: timeline order is irrelevant once times differ; linked PRs dedupe and sort ascending', () => {
  const xref = (n, state = 'open') => ({ event: 'cross-referenced', source: { issue: { number: n, title: `pr ${n}`, state, repository: { full_name: 'o/r' }, pull_request: { merged_at: null } } } });
  const d = issueStatus.derive({
    issue: ISSUE(),
    timeline: [C('Dave', '2026-10-02T00:00:00Z', 'later'), xref(7), C('trek-e', '2026-10-01T00:00:00Z', 'earlier'), xref(3), xref(7), { event: 'cross-referenced', source: { issue: { number: 5, state: 'open', repository: { full_name: 'o/r' } } } }],
  });
  assert.equal(d.newest.login, 'Dave');
  assert.equal(d.authorReplied, true);
  assert.deepEqual(d.linkedPrs.map((p) => p.number), [3, 7], 'an issue cross-reference (no pull_request) is not a PR');
});

// --- end to end through the stub gh ---

test('end to end: #5120 prints the ball, reads only GETs, and gives the open linked PR its pr-status ball', (t) => {
  const r = run(t, ['5120']);
  assert.equal(r.status, 0, r.stderr);
  noRefusals(r);
  assert.match(r.stdout, /^open-gsd\/gsd-core#5120 OPEN author davesienkowski /m);
  assert.match(r.stdout, /^ {2}ball: MENTIONED trek-e owe\(s\) a reply /m);
  assert.match(r.stdout, /^ {2}pr: #5119 OPEN references \(does not close\) /m);
  assert.match(r.stdout, /^ {4}head 1830f52109c5; ball: /m);
  assert.ok(r.stdout.trimEnd().endsWith('assignees are printed for you to weigh.'), 'footer');
  const calls = r.log.map((l) => JSON.parse(l));
  assert.deepEqual(calls[0], ['api', 'repos/open-gsd/gsd-core/issues/5120']);
  assert.deepEqual(calls[1], ['api', '--paginate', '--slurp', 'repos/open-gsd/gsd-core/issues/5120/timeline?per_page=100']);
  assert.deepEqual(calls[2], ['pr', 'view', '5119', '--repo', 'open-gsd/gsd-core', '--json', 'number,state,title,mergedAt,closedAt,closingIssuesReferences']);
  assert.deepEqual(calls[3].slice(0, 3), ['pr', 'view', '5119'], 'pr-status read of the open PR');
});

test('end to end: closed linked PRs get one pr view each and no pr-status read; closes comes from closingIssuesReferences', (t) => {
  const r = run(t, ['4649']);
  assert.equal(r.status, 0, r.stderr);
  noRefusals(r);
  assert.match(r.stdout, /^ {2}pr: #4955 CLOSED would have closed this issue \(closed unmerged\) /m);
  assert.match(r.stdout, /^ {2}pr: #5079 CLOSED would have closed this issue \(closed unmerged\) /m);
  const prCalls = r.log.map((l) => JSON.parse(l)).filter((c) => c[0] === 'pr');
  assert.equal(prCalls.length, 2);
  assert.ok(!r.log.some((l) => l.includes('/reviews')), 'no pr-status read for a closed PR');
});

test('end to end: --author lists the open issues of that login, ascending, and --no-prs skips every PR read', (t) => {
  const r = run(t, ['--author', 'davesienkowski', '--no-prs']);
  assert.equal(r.status, 0, r.stderr);
  noRefusals(r);
  const heads = [...r.stdout.matchAll(/^open-gsd\/gsd-core#(\d+) /gm)].map((m) => m[1]);
  assert.deepEqual(heads, ['4649', '5120']);
  const calls = r.log.map((l) => JSON.parse(l));
  assert.deepEqual(calls[0], ['issue', 'list', '--repo', 'open-gsd/gsd-core', '--author', 'davesienkowski', '--state', 'open', '--json', 'number', '--limit', '50']);
  assert.ok(!calls.some((c) => c[0] === 'pr'), 'no pr read with --no-prs');
  assert.match(r.stdout, /references \(closing not read: --no-prs\)/);
});

test('empty: an author with no open issues prints no open issues and exits 0; --json prints []', (t) => {
  let r = run(t, ['--author', 'nobody-here']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^open-gsd\/gsd-core: no open issues by nobody-here$/m);
  r = run(t, ['--json', '--author', 'nobody-here']);
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout), []);
  assert.match(r.stderr, /no open issues by nobody-here/);
});

test('end to end: a number that is a PR prints use pr-status and reads no timeline', (t) => {
  const dir = fixturesWith(t, { 'is-pr.json': { provenance: { source: 'synthetic', edits: 'issue with pull_request' }, issue: ISSUE({ number: 900101, pull_request: { url: 'x' } }) } });
  const r = run(t, ['900101'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^open-gsd\/gsd-core#900101 is a pull request, use pr-status$/m);
  assert.equal(r.log.length, 1);
});

test('errors: a missing issue prints an ERROR block and exits 1 while the others still print; a failed pr view names closing unknown', (t) => {
  const dir = fixturesWith(t, {
    'pr-missing-ref.json': {
      provenance: { source: 'synthetic', edits: 'issue cross-referenced by a PR with no fixture' },
      issue: ISSUE({ number: 900102 }),
      timeline: [{ event: 'cross-referenced', source: { issue: { number: 900999, state: 'open', title: 'gone', repository: { full_name: 'open-gsd/gsd-core' }, pull_request: { merged_at: null } } } }],
    },
  });
  const r = run(t, ['999999', '900102'], dir);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^open-gsd\/gsd-core#999999 ERROR: gh: Not Found \(HTTP 404\)$/m);
  assert.match(r.stdout, /^ {2}pr: #900999 OPEN references \(closing: unknown, read failed: /m);
  noRefusals(r);
});

test('usage: no number, a bad --repo, a bad --author, a bad --limit and number 0 exit 2 with no gh call', (t) => {
  for (const args of [[], ['--repo', 'nope', '1'], ['--author', 'a b'], ['--author', 'x', '--limit', '0'], ['--limit', '501', '--author', 'x'], ['0'], ['1', 'x']]) {
    const r = run(t, args);
    assert.equal(r.status, 2, JSON.stringify(args));
    assert.equal(r.log.length, 0, JSON.stringify(args));
    assert.match(r.stderr, /usage: issue-status/);
  }
});

test('repo: --repo reaches every read and is named in every header', (t) => {
  const r = run(t, ['--repo', 'other/repo', '--no-prs', '5120']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^other\/repo#5120 /m);
  for (const c of r.log.map((l) => JSON.parse(l))) assert.ok(c.some((a) => a.includes('other/repo')), c.join(' '));
});

test('ordering: issue blocks print in argv order, a repeated number prints once', (t) => {
  const r = run(t, ['--no-prs', '5120', '4649', '5120']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual([...r.stdout.matchAll(/^open-gsd\/gsd-core#(\d+) /gm)].map((m) => m[1]), ['5120', '4649']);
});

test('idempotency: two runs print byte-identical output and log the same reads', (t) => {
  const a = run(t, ['5120', '4649']);
  const b = run(t, ['5120', '4649']);
  assert.equal(a.stdout, b.stdout);
  assert.deepEqual(a.log, b.log);
  noRefusals(a);
});

// --- round 2 (independent review, Major 3): a non-author comment's @mentions decide the ball ---

/** The captured #4649 thread as it stood at time `cut` (events after it dropped). */
function cut4649(cut) {
  const fx = load('issue-4649-captured.json');
  return { issue: fx.issue, timeline: fx.timeline.filter((e) => !e.created_at || e.created_at <= cut) };
}

test('round 2 replay #4649 at 2026-10-02T17:00Z: forfrossen (assignee) asked @trek-e last, so trek-e owes, not the author', () => {
  const d = issueStatus.derive(cut4649('2026-10-02T17:00:00Z'));
  assert.equal(d.newest.login, 'forfrossen');
  assert.equal(d.ball.owner, 'mentioned');
  assert.deepEqual(d.ball.logins, ['trek-e']);
});

test('round 2 replay #4649 at 2026-10-02T23:45Z: trek-e answered @forfrossen last, so forfrossen owes, not the author', () => {
  const d = issueStatus.derive(cut4649('2026-10-02T23:45:00Z'));
  assert.equal(d.newest.login, 'trek-e');
  assert.equal(d.ball.owner, 'mentioned');
  assert.deepEqual(d.ball.logins, ['forfrossen']);
});

test('round 2: a non-author comment that mentions nobody, only itself, or only the author puts the ball on the author', () => {
  for (const body of ['plain question?', 'as @trek-e I think', 'ping @dave']) {
    const d = issueStatus.derive({ issue: ISSUE(), timeline: [C('trek-e', 't1', body)] });
    assert.equal(d.ball.owner, 'author', body);
  }
  // mentions the author and someone else: both are named
  const d = issueStatus.derive({ issue: ISSUE(), timeline: [C('trek-e', 't1', '@Dave and @alice please')] });
  assert.equal(d.ball.owner, 'mentioned');
  assert.deepEqual(d.ball.logins, ['dave', 'alice']);
});

test('round 2: a later comment from the mentioned login clears it; bots never answer or ask', () => {
  let d = issueStatus.derive({ issue: ISSUE(), timeline: [C('trek-e', 't1', '@alice can you check'), C('github-actions[bot]', 't2', '@trek-e auto')] });
  assert.deepEqual(d.ball.logins, ['alice'], 'the bot comment is ignored');
  d = issueStatus.derive({ issue: ISSUE(), timeline: [C('trek-e', 't1', '@alice can you check'), C('alice', 't2', 'done')] });
  assert.equal(d.ball.owner, 'author', 'alice answered; her comment mentions nobody');
});

test('round 2: the assignee does not move the ball on its own', () => {
  const d = issueStatus.derive({ issue: ISSUE({ assignees: [{ login: 'forfrossen' }] }), timeline: [C('trek-e', 't1', 'approved')] });
  assert.equal(d.ball.owner, 'author');
});

test('round 2 (nits): an @mention inside an HTML comment does not count; --limit without --author and --help', (t) => {
  assert.deepEqual(issueStatus.mentionsIn('<!-- @hidden -->\nhi @shown'), ['shown']);
  let r = run(t, ['--limit', '5', '1']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--limit needs --author/);
  r = run(t, ['--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^usage: issue-status /m);
  assert.equal(r.log.length, 0);
});

test('round 2 (minor): closes wording follows the PR state: open closes, merged closed, closed unmerged would have closed', (t) => {
  const fx = (n, state, mergedAt) => ({ provenance: { source: 'synthetic', edits: 'pr view only' }, view: { number: n, state, title: `pr ${n}`, mergedAt, closedAt: null, closingIssuesReferences: [{ number: 900103 }] }, reviews: [], checks: [] });
  const xref = (n) => ({ event: 'cross-referenced', source: { issue: { number: n, state: 'closed', title: 'x', repository: { full_name: 'open-gsd/gsd-core' }, pull_request: { merged_at: null } } } });
  const dir = fixturesWith(t, {
    'i.json': { provenance: { source: 'synthetic', edits: 'issue with three closing PRs' }, issue: ISSUE({ number: 900103 }), timeline: [xref(900201), xref(900202)] },
    'm.json': fx(900201, 'MERGED', '2026-10-01T00:00:00Z'),
    'c.json': fx(900202, 'CLOSED', null),
  });
  const r = run(t, ['900103'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^ {2}pr: #900201 MERGED merged closed this issue /m);
  assert.match(r.stdout, /^ {2}pr: #900202 CLOSED would have closed this issue \(closed unmerged\) /m);
});
