'use strict';

/**
 * bin/pr-status.test.cjs — HERMETIC test of the read-only PR snapshot (`bin/pr-status.cjs`).
 *
 * Why: the review sweep used to re-derive PR state and ball-in-court by hand from prose ("re-fetch
 * live state"), which is where stale-snapshot and wrong-ball mistakes came from. pr-status turns that
 * into one read-only command, so its verdict math and its read-only contract both need a pin.
 *
 * What this pins:
 *   - derive() over trimmed gh JSON captured from real open-gsd/gsd-core PRs: the ball recorded BY HAND
 *     in each fixture's `provenance.expected` (author, or reviewer with login + reRequested).
 *   - end to end through a stub `gh` placed first on PATH: the CLI prints the head SHA and the ball
 *     line, and the stub's argv log holds only the three read calls (pr view, api GET of the reviews
 *     with --paginate --slurp, pr checks), both `pr` calls carrying --repo. The stub REFUSES (exit 99)
 *     any other verb and any -X / --method / -f / -F / --input / graphql argument, and the test
 *     asserts it refused nothing.
 *
 * No network, no real gh: fixtures live in bin/fixtures/pr-status/, each with a provenance block
 * (captured PR and time, or synthetic base plus edit) and the gh exit status it reproduces.
 *
 * @module bin/pr-status.test
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const prStatus = require('./pr-status.cjs');

const SCRIPT = path.join(__dirname, 'pr-status.cjs');
const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'pr-status');

function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, name), 'utf8'));
}

// Compare only the hand-recorded keys of provenance.expected (owner, login, reRequested).
function assertBall(ball, expected, label) {
  for (const key of Object.keys(expected)) {
    assert.deepEqual(ball[key], expected[key], `${label}: ball.${key}`);
  }
}

// The stub gh: serves fixtures by PR number, logs argv, refuses anything that is not a known read.
const STUB_SOURCE = `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const argv = process.argv.slice(2);
const log = process.env.PR_STATUS_STUB_LOG;
const record = (line) => { if (log) fs.appendFileSync(log, line + '\\n'); };
record(JSON.stringify(argv));
const refuse = (why) => { record('REFUSED ' + why + ' ' + JSON.stringify(argv)); process.stderr.write('stub gh refused: ' + why + '\\n'); process.exit(99); };
const BAD = new Set(['-X', '--method', '-f', '-F', '--field', '--raw-field', '--input']);
for (const a of argv) {
  if (BAD.has(a) || /^(-X|--method=|--field=|--raw-field=|--input=)/.test(a) || /graphql/i.test(a)) refuse('mutating-or-graphql-arg');
}
const fixtures = new Map();
for (const f of fs.readdirSync(process.env.PR_STATUS_STUB_FIXTURES)) {
  if (!f.endsWith('.json')) continue;
  const fx = JSON.parse(fs.readFileSync(path.join(process.env.PR_STATUS_STUB_FIXTURES, f), 'utf8'));
  if (fx && fx.view && fx.view.number != null) fixtures.set(String(fx.view.number), fx);
}
const notFound = (n) => { process.stderr.write('GraphQL: Could not resolve to a PullRequest with the number of ' + n + '. (repository.pullRequest)\\n'); process.exit(1); };
if (argv[0] === 'pr' && (argv[1] === 'view' || argv[1] === 'checks')) {
  const n = argv[2];
  const fx = fixtures.get(n);
  if (!fx) notFound(n);
  if (argv[1] === 'view') { process.stdout.write(JSON.stringify(fx.view) + '\\n'); process.exit(0); }
  const prov = fx.provenance || {};
  if (prov.checksStderr) process.stderr.write(prov.checksStderr + '\\n');
  if (fx.checks != null) process.stdout.write(JSON.stringify(fx.checks) + '\\n');
  process.exit(prov.checksExit || 0);
}
if (argv[0] === 'api') {
  const m = /^repos\\/[^/]+\\/[^/]+\\/pulls\\/(\\d+)\\/reviews(\\?.*)?$/.exec(argv.find((a) => a.startsWith('repos/')) || '');
  if (!m) refuse('unknown-api-path');
  const fx = fixtures.get(m[1]);
  if (!fx) { process.stderr.write('gh: Not Found (HTTP 404)\\n'); process.exit(1); }
  process.stdout.write(JSON.stringify(fx.reviews) + '\\n');
  process.exit(0);
}
refuse('unknown-verb');
`;

function makeStub(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-status-stub-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const gh = path.join(bin, 'gh');
  fs.writeFileSync(gh, STUB_SOURCE, { mode: 0o755 });
  fs.chmodSync(gh, 0o755);
  const logFile = path.join(dir, 'argv.log');
  fs.writeFileSync(logFile, '');
  return { bin, logFile };
}

/** Run the CLI through the stub; returns { status, stdout, stderr, log }. Never throws on exit != 0. */
function runThroughStub(t, args, opts = {}) {
  const stub = opts.stub || makeStub(t);
  const env = Object.assign({}, process.env, {
    PATH: stub.bin + path.delimiter + process.env.PATH,
    PR_STATUS_STUB_FIXTURES: opts.fixturesDir || FIXTURES_DIR,
    PR_STATUS_STUB_LOG: stub.logFile,
  });
  let status = 0;
  let stdout;
  let stderr = '';
  try {
    stdout = execFileSync(process.execPath, [SCRIPT, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    status = err.status;
    stdout = err.stdout;
    stderr = err.stderr;
  }
  const log = fs.readFileSync(stub.logFile, 'utf8').split('\n').filter(Boolean);
  return { status, stdout, stderr, log };
}

test('derive: change request on the head commit puts the ball on the author (captured fixture)', () => {
  const fx = loadFixture('cr-captured.json');
  const d = prStatus.derive({ view: fx.view, reviews: fx.reviews, checks: fx.checks });
  assertBall(d.ball, fx.provenance.expected, 'cr-captured');
});

test('end to end: one captured change-requested PR through a stub gh that sees only three reads', (t) => {
  const fx = loadFixture('cr-captured.json');
  const n = String(fx.view.number);
  const r = runThroughStub(t, [n]);
  assert.equal(r.status, 0, `exit status (stderr: ${r.stderr})`);
  assert.match(r.stdout, new RegExp(`^#${n} OPEN head ${fx.view.headRefOid.slice(0, 12)} base `, 'm'));
  assert.match(r.stdout, /^ {2}merge: /m);
  assert.match(r.stdout, /^ {2}checks: /m);
  assert.match(r.stdout, /^ {2}review: trek-e CHANGES_REQUESTED on [0-9a-f]{7} \(head\) /m);
  assert.match(r.stdout, /^ {2}requested: /m);
  assert.match(r.stdout, /^ {2}ball: AUTHOR owes changes \(newest CHANGES_REQUESTED by trek-e is on the head\)$/m);

  assert.ok(!r.log.some((l) => l.startsWith('REFUSED')), `stub refused a call: ${r.log.join(' | ')}`);
  const calls = r.log.map((l) => JSON.parse(l));
  assert.equal(calls.length, 3, `exactly three gh calls, got ${JSON.stringify(calls)}`);
  const [view, api, checks] = calls;
  assert.deepEqual(view.slice(0, 3), ['pr', 'view', n]);
  assert.equal(view[view.indexOf('--repo') + 1], 'open-gsd/gsd-core');
  assert.equal(api[0], 'api');
  assert.ok(api.includes('--paginate') && api.includes('--slurp'), 'reviews read paginates and slurps');
  assert.ok(api.includes(`repos/open-gsd/gsd-core/pulls/${n}/reviews?per_page=100`), 'reviews path embeds the repo');
  assert.deepEqual(checks.slice(0, 3), ['pr', 'checks', n]);
  assert.equal(checks[checks.indexOf('--repo') + 1], 'open-gsd/gsd-core');
});

// --- Task 2: every scenario, --json, --repo, usage, ERROR, UNKNOWN re-read, sanitizing, footer ---

const ALL_FIXTURES = fs.readdirSync(FIXTURES_DIR).filter((f) => f.endsWith('.json')).sort();
const FOOTER_START = 'Snapshot is point-in-time (three separate gh reads per PR); re-run before any write.';

function isPrintableAscii(s) {
  return /^[\t\n\x20-\x7e]*$/.test(s);
}

test('fixtures: every file records its source, edits, gh checks exit status and a hand-derived ball', () => {
  assert.ok(ALL_FIXTURES.length >= 20, `expected the scenario set, got ${ALL_FIXTURES.length}`);
  for (const f of ALL_FIXTURES) {
    const p = loadFixture(f).provenance;
    assert.ok(p && /^(captured open-gsd\/gsd-core#\d+ \S+Z|synthetic from \S+\.json)$/.test(p.source), `${f}: provenance.source`);
    assert.equal(typeof p.edits, 'string', `${f}: provenance.edits`);
    assert.ok(Number.isInteger(p.checksExit), `${f}: provenance.checksExit`);
    assert.ok(p.expected && typeof p.expected.owner === 'string', `${f}: provenance.expected.owner`);
  }
});

test('derive: every fixture yields the ball recorded by hand in its provenance', () => {
  for (const f of ALL_FIXTURES) {
    const fx = loadFixture(f);
    const d = prStatus.derive({ view: fx.view, reviews: fx.reviews, checks: fx.checks || [] });
    assertBall(d.ball, fx.provenance.expected, f);
    if (fx.provenance.expectedReviewers) {
      assert.deepEqual(d.reviewers.map((r) => r.login), fx.provenance.expectedReviewers, `${f}: reviewers`);
    }
  }
});

test('derive: two open change requests are both listed, sorted by login, and the newest decides', () => {
  const fx = loadFixture('two-crs-captured.json');
  const d = prStatus.derive(fx);
  assert.deepEqual(d.reviewers.map((r) => [r.login, r.state, r.onHead]), [
    ['davesienkowski', 'CHANGES_REQUESTED', false],
    ['trek-e', 'CHANGES_REQUESTED', true],
  ]);
  assert.equal(d.ball.owner, 'author');
  assert.equal(d.ball.login, 'trek-e');
});

test('derive: head and review commits compare as exact strings (a 12-char prefix is not the head)', () => {
  const fx = loadFixture('cr-captured.json');
  const reviews = fx.reviews.map((page) => page.map((r) => Object.assign({}, r, { commit_id: r.commit_id.slice(0, 12) })));
  const d = prStatus.derive({ view: fx.view, reviews, checks: fx.checks });
  assert.equal(d.ball.owner, 'reviewer');
});

test('derive: checks count in the fixed bucket order with failing and pending names', () => {
  const fail = prStatus.derive(loadFixture('failing-checks-captured.json')).checks;
  assert.deepEqual(Object.keys(fail.counts), ['pass', 'fail', 'pending', 'skipping', 'cancel']);
  assert.deepEqual(fail.counts, { pass: 36, fail: 2, pending: 0, skipping: 3, cancel: 0 });
  assert.equal(fail.total, 41);
  assert.equal(fail.failing.length, 2);
  const pend = prStatus.derive(loadFixture('pending-checks-exit8.json')).checks;
  assert.equal(pend.counts.pending, 2);
  assert.equal(pend.pending.length, 2);
});

test('end to end: every scenario prints in argv order, footer once, ASCII only, no ERROR, nothing refused', (t) => {
  const numbers = ALL_FIXTURES.map((f) => String(loadFixture(f).view.number)).filter((n) => n !== '900017');
  const r = runThroughStub(t, numbers);
  assert.equal(r.status, 0, `exit status (stderr: ${r.stderr})`);
  assert.ok(!/ERROR/.test(r.stdout), 'no ERROR block for failing, pending or absent checks');
  assert.ok(!r.log.some((l) => l.startsWith('REFUSED')), `stub refused a call: ${r.log.filter((l) => l.startsWith('REFUSED')).join(' | ')}`);
  const heads = [...r.stdout.matchAll(/^#(\d+) /gm)].map((m) => m[1]);
  assert.deepEqual(heads, numbers, 'PR blocks print in the order the numbers were given');
  assert.equal(r.stdout.split(FOOTER_START).length - 1, 1, 'footer appears exactly once');
  assert.ok(isPrintableAscii(r.stdout), 'text output is printable ASCII');
  for (const call of r.log.map((l) => JSON.parse(l))) {
    if (call[0] === 'pr') assert.equal(call[call.indexOf('--repo') + 1], 'open-gsd/gsd-core', `--repo on ${call.join(' ')}`);
    else assert.match(call.find((a) => a.startsWith('repos/')), /^repos\/open-gsd\/gsd-core\/pulls\/\d+\/reviews\?per_page=100$/);
  }
});

test('end to end: failing checks print a summary and a ball line whether gh exits 0, 1 or 8', (t) => {
  for (const [f, re] of [
    ['failing-checks-captured.json', /checks: 41 total: pass 36, fail 2, pending 0, skipping 3, cancel 0/],
    ['failing-checks-exit1.json', /checks: 41 total: pass 36, fail 2, pending 0, skipping 3, cancel 0/],
    ['pending-checks-exit8.json', /checks: 41 total: pass 36, fail 0, pending 2, skipping 3, cancel 0/],
  ]) {
    const fx = loadFixture(f);
    const r = runThroughStub(t, [String(fx.view.number)]);
    assert.equal(r.status, 0, `${f}: exit (stderr: ${r.stderr})`);
    assert.match(r.stdout, re, f);
    assert.match(r.stdout, /^ {2}ball: /m, `${f}: ball line`);
    assert.ok(!/ERROR/.test(r.stdout), `${f}: no ERROR`);
  }
});

test('end to end: no checks prints checks: none (empty array, or gh "no checks reported")', (t) => {
  for (const f of ['no-checks.json', 'no-checks-reported.json']) {
    const r = runThroughStub(t, [String(loadFixture(f).view.number)]);
    assert.equal(r.status, 0, `${f}: exit (stderr: ${r.stderr})`);
    assert.match(r.stdout, /^ {2}checks: none$/m, f);
  }
});

test('end to end: ball lines for reviewer, NOT RE-REQUESTED, maintainer, pending requests, none, draft and merged', (t) => {
  const cases = [
    ['reviewer-rerequested-captured.json', /^ {2}ball: REVIEWER trek-e owes a re-review \(the head moved after the change request\)$/m],
    ['not-rerequested.json', /^ {2}ball: REVIEWER trek-e owes a re-review \(the head moved after the change request\) NOT RE-REQUESTED$/m],
    ['approved.json', /^ {2}ball: MAINTAINER \(ready for maintainer/m],
    ['no-reviews-requested.json', /^ {2}ball: REVIEWER owes a first review \(requests pending: /m],
    ['dismissed-cr.json', /^ {2}ball: REVIEWER owes a first review \(requests pending: /m],
    ['no-reviews-no-requests.json', /^ {2}ball: none /m],
  ];
  for (const [f, re] of cases) {
    const r = runThroughStub(t, [String(loadFixture(f).view.number)]);
    assert.equal(r.status, 0, f);
    assert.match(r.stdout, re, f);
  }
  for (const [f, re] of [['draft.json', /^#900006 OPEN DRAFT head /m], ['merged.json', /^#900007 MERGED head /m]]) {
    const r = runThroughStub(t, [String(loadFixture(f).view.number)]);
    assert.equal(r.status, 0, f);
    assert.match(r.stdout, re, f);
    assert.ok(!/ball:/.test(r.stdout), `${f}: no ball line`);
  }
});

test('end to end: --json prints a JSON array of derive() results in argv order, reviewers sorted by login', (t) => {
  const r = runThroughStub(t, ['--json', '5079', '5235']);
  assert.equal(r.status, 0, r.stderr);
  const arr = JSON.parse(r.stdout);
  assert.ok(Array.isArray(arr));
  assert.deepEqual(arr.map((d) => d.number), [5079, 5235]);
  assert.deepEqual(arr[0].reviewers.map((x) => x.login), ['davesienkowski', 'trek-e']);
  assert.deepEqual(arr[0], prStatus.derive(loadFixture('two-crs-captured.json')));
});

test('end to end: --repo passes through to every gh call', (t) => {
  const r = runThroughStub(t, ['--repo', 'other-org/other.repo', '5235']);
  assert.equal(r.status, 0, r.stderr);
  const calls = r.log.map((l) => JSON.parse(l));
  assert.equal(calls.length, 3);
  for (const call of calls) {
    if (call[0] === 'pr') assert.equal(call[call.indexOf('--repo') + 1], 'other-org/other.repo');
    else assert.ok(call.includes('repos/other-org/other.repo/pulls/5235/reviews?per_page=100'));
  }
});

test('usage: no number, a non-digit number or a malformed --repo exits 2 with a usage line and calls no gh', (t) => {
  for (const args of [[], ['12a'], ['--repo', 'not a repo', '5235'], ['--repo', 'noslash', '5235'], ['--repo'], ['--bogus', '5235']]) {
    const r = runThroughStub(t, args);
    assert.equal(r.status, 2, `${JSON.stringify(args)}: exit 2`);
    assert.match(r.stderr, /usage: pr-status /, `${JSON.stringify(args)}: usage line`);
    assert.equal(r.log.length, 0, `${JSON.stringify(args)}: no gh call`);
  }
});

test('end to end: a PR whose read fails prints an ERROR block, the others still print, exit 1', (t) => {
  const r = runThroughStub(t, ['5235', '999999', '5234']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^#999999 ERROR: GraphQL: Could not resolve to a PullRequest with the number of 999999\./m);
  assert.match(r.stdout, /^#5235 OPEN /m);
  assert.match(r.stdout, /^#5234 OPEN /m);
  const json = runThroughStub(t, ['--json', '999999', '5235']);
  assert.equal(json.status, 1);
  const arr = JSON.parse(json.stdout);
  assert.equal(arr[0].number, 999999);
  assert.match(arr[0].error, /Could not resolve/);
  assert.equal(arr[1].number, 5235);
});

test('fetchPr: mergeable UNKNOWN re-reads the view once after sleep(2000); still UNKNOWN stays UNKNOWN', () => {
  const fx = loadFixture('mergeable-unknown.json');
  const calls = [];
  const sleeps = [];
  const gh = (args) => {
    calls.push(args.slice(0, 2).join(' '));
    if (args[0] === 'pr' && args[1] === 'view') return fx.view;
    if (args[0] === 'api') return fx.reviews;
    return fx.checks;
  };
  const got = prStatus.fetchPr('900017', 'open-gsd/gsd-core', { gh, sleep: (ms) => sleeps.push(ms) });
  assert.deepEqual(calls, ['pr view', 'pr view', 'api --paginate', 'pr checks']);
  assert.deepEqual(sleeps, [2000]);
  assert.equal(prStatus.derive(got).mergeable, 'UNKNOWN');

  let n = 0;
  const gh2 = (args) => {
    if (args[0] === 'pr' && args[1] === 'view') return Object.assign({}, fx.view, { mergeable: n++ === 0 ? 'UNKNOWN' : 'MERGEABLE' });
    if (args[0] === 'api') return fx.reviews;
    return fx.checks;
  };
  assert.equal(prStatus.derive(prStatus.fetchPr('900017', 'open-gsd/gsd-core', { gh: gh2, sleep: () => {} })).mergeable, 'MERGEABLE');
});

test('formatText: ESC sequences and non-ASCII from GitHub strings print with controls removed and ? for non-ASCII', () => {
  const text = prStatus.formatText(prStatus.derive(loadFixture('hostile-strings.json')));
  assert.ok(isPrintableAscii(text), 'ASCII only');
  assert.ok(!text.includes('\u001b'), 'no ESC');
  assert.match(text, /\[31mRequired tests\[0m/);
  assert.match(text, /fix: caf\? \? headline/);
});

test('determinism: two runs against the same stubbed state print byte-identical output; no mutating verb logged', (t) => {
  const stub = makeStub(t);
  const args = ['5079', '5153', '5234', '5235', '900001', '900018'];
  const a = runThroughStub(t, args, { stub });
  const b = runThroughStub(t, args, { stub });
  assert.equal(a.status, 0, a.stderr);
  assert.equal(a.stdout, b.stdout);
  for (const l of b.log) {
    assert.ok(!l.startsWith('REFUSED'), l);
    const call = JSON.parse(l);
    assert.ok(['pr view', 'pr checks'].includes(call.slice(0, 2).join(' ')) || call[0] === 'api', `read-only verb: ${l}`);
  }
});
