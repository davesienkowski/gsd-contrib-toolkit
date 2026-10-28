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
const QUEUE_DIR = path.join(__dirname, 'fixtures', 'pr-status-queue');

function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, name), 'utf8'));
}

// Compare only the hand-recorded keys of provenance.expected (owner, login, reRequested).
function assertBall(ball, expected, label) {
  for (const key of Object.keys(expected)) {
    assert.deepEqual(ball[key], expected[key], `${label}: ball.${key}`);
  }
}

// The stub gh (serves fixtures by PR number, logs argv, refuses anything that is not a known read).
const STUB_FILE = path.join(FIXTURES_DIR, '..', 'pr-status-gh-stub.cjs');

function makeStub(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-status-stub-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const gh = path.join(bin, 'gh');
  fs.copyFileSync(STUB_FILE, gh);
  fs.chmodSync(gh, 0o755);
  const logFile = path.join(dir, 'argv.log');
  fs.writeFileSync(logFile, '');
  return { bin, logFile, home: dir };
}

/** Run the CLI through the stub; returns { status, stdout, stderr, log }. Never throws on exit != 0. */
function runThroughStub(t, args, opts = {}) {
  const stub = opts.stub || makeStub(t);
  const env = Object.assign({}, process.env, {
    PATH: stub.bin + path.delimiter + process.env.PATH,
    PR_STATUS_STUB_FIXTURES: opts.fixturesDir || FIXTURES_DIR,
    PR_STATUS_STUB_LOG: stub.logFile,
    // 261028-owj: no gsd-core checkout resolves unless a test names one (GSD_CORE_ROOT), so a run never
    // reads the real ~/repos/gsd-core and prints the same policies line on every machine.
    HOME: stub.home,
  }, opts.env || {});
  if (!(opts.env && opts.env.GSD_CORE_ROOT)) delete env.GSD_CORE_ROOT;
  if (opts.queue) env.PR_STATUS_STUB_QUEUE = path.join(QUEUE_DIR, opts.queue);
  else delete env.PR_STATUS_STUB_QUEUE;
  let status = 0;
  let stdout;
  let stderr = '';
  try {
    stdout = execFileSync(process.execPath, [opts.script || SCRIPT, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
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
  assert.match(r.stdout, new RegExp(`^open-gsd/gsd-core#${n} OPEN head ${fx.view.headRefOid.slice(0, 12)} base `, 'm'));
  assert.match(r.stdout, /^ {2}merge: /m);
  assert.match(r.stdout, /^ {2}checks: /m);
  assert.match(r.stdout, /^ {2}review: trek-e CHANGES_REQUESTED on [0-9a-f]{7} \(head\) /m);
  assert.match(r.stdout, /^ {2}requested: /m);
  assert.match(r.stdout, /^ {2}ball: AUTHOR owes changes \(newest CHANGES_REQUESTED by trek-e is on the head\)$/m);

  assert.ok(!r.log.some((l) => l.startsWith('REFUSED')), `stub refused a call: ${r.log.join(' | ')}`);
  const calls = r.log.map((l) => JSON.parse(l));
  // 261021-n2m: three per-PR reads, then the base branch's merge-queue reads (an empty repo: the active
  // rules GET and the rulesets list GET, no detail reads).
  assert.equal(calls.length, 5, `three PR reads plus two queue reads, got ${JSON.stringify(calls)}`);
  const [view, api, checks, rules, rulesets] = calls;
  assert.deepEqual(rules, ['api', '--paginate', '--slurp', 'repos/open-gsd/gsd-core/rules/branches/next?per_page=100']);
  assert.deepEqual(rulesets, ['api', '--paginate', '--slurp', 'repos/open-gsd/gsd-core/rulesets?includes_parents=true&per_page=100']);
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
const FOOTER_START = 'Snapshot is point-in-time (three separate gh reads per PR, and separate merge-queue reads per base branch; plus a timeline read when a review was dismissed, and files and compare reads with --overlap); re-run before any write.';

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
  const heads = [...r.stdout.matchAll(/^open-gsd\/gsd-core#(\d+) /gm)].map((m) => m[1]);
  assert.deepEqual(heads, numbers, 'PR blocks print in the order the numbers were given');
  assert.equal(r.stdout.split(FOOTER_START).length - 1, 1, 'footer appears exactly once');
  assert.ok(isPrintableAscii(r.stdout), 'text output is printable ASCII');
  for (const call of r.log.map((l) => JSON.parse(l))) {
    if (call[0] === 'pr') assert.equal(call[call.indexOf('--repo') + 1], 'open-gsd/gsd-core', `--repo on ${call.join(' ')}`);
    else assert.match(call.find((a) => a.startsWith('repos/')), /^repos\/open-gsd\/gsd-core\/(pulls\/\d+\/reviews\?per_page=100|issues\/\d+\/timeline\?per_page=100|rules\/branches\/next\?per_page=100|rulesets\?includes_parents=true&per_page=100)$/);
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
    ['approved.json', /^ {2}ball: REVIEWER owes a review \(approved but blocked: review requests pending \(Solvely-Colin, jeremymcs, davesienkowski\)\)$/m],
    ['no-reviews-requested.json', /^ {2}ball: REVIEWER owes a first review \(requests pending: /m],
    ['dismissed-cr.json', /^ {2}ball: REVIEWER owes a first review \(requests pending: /m],
    ['no-reviews-no-requests.json', /^ {2}ball: none /m],
  ];
  for (const [f, re] of cases) {
    const r = runThroughStub(t, [String(loadFixture(f).view.number)]);
    assert.equal(r.status, 0, f);
    assert.match(r.stdout, re, f);
  }
  for (const [f, re] of [['draft.json', /^open-gsd\/gsd-core#900006 OPEN DRAFT head /m], ['merged.json', /^open-gsd\/gsd-core#900007 MERGED head /m]]) {
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
  assert.equal(arr[0].queue.mode, 'absent', 'an empty stub repo reads as no merge queue');
  assert.deepEqual(arr[0], { repo: 'open-gsd/gsd-core', ...prStatus.derive({ ...loadFixture('two-crs-captured.json'), queue: arr[0].queue }) });
});

test('end to end: --repo passes through to every gh call', (t) => {
  const r = runThroughStub(t, ['--repo', 'other-org/other.repo', '5235']);
  assert.equal(r.status, 0, r.stderr);
  const calls = r.log.map((l) => JSON.parse(l));
  assert.equal(calls.length, 5);
  for (const call of calls) {
    if (call[0] === 'pr') assert.equal(call[call.indexOf('--repo') + 1], 'other-org/other.repo');
    else assert.ok(call.some((a) => a.startsWith('repos/other-org/other.repo/')), `queue and review reads carry the repo: ${call.join(' ')}`);
  }
  assert.ok(calls.some((c) => c.includes('repos/other-org/other.repo/pulls/5235/reviews?per_page=100')));
  assert.match(r.stdout, /^other-org\/other\.repo#5235 OPEN head /m, 'the header names the repo it read');
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
  assert.match(r.stdout, /^open-gsd\/gsd-core#999999 ERROR: GraphQL: Could not resolve to a PullRequest with the number of 999999\./m);
  assert.match(r.stdout, /^open-gsd\/gsd-core#5235 OPEN /m);
  assert.match(r.stdout, /^open-gsd\/gsd-core#5234 OPEN /m);
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

test('end to end: --json output is ASCII too (non-ASCII escaped, round-trips through JSON.parse)', (t) => {
  const r = runThroughStub(t, ['--json', '900018']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(isPrintableAscii(r.stdout), 'ASCII only');
  assert.equal(JSON.parse(r.stdout)[0].lastCommit.headline, 'fix: café — headline');
});

// --- review fixes (261007-fnu REVIEW.md WR-01..WR-06, IN-02) ---

test('WR-01: a reviews payload over 1 MiB still prints a snapshot (execFileSync maxBuffer raised)', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-status-big-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fx = loadFixture('cr-captured.json');
  fx.reviews = [[Object.assign({ body: 'x'.repeat(2 * 1024 * 1024) }, fx.reviews[0][0])]];
  fs.writeFileSync(path.join(dir, 'big.json'), JSON.stringify(fx));
  const r = runThroughStub(t, ['5235'], { fixturesDir: dir });
  assert.equal(r.status, 0, `exit (stdout: ${String(r.stdout).slice(0, 200)})`);
  assert.match(r.stdout, /^ {2}ball: AUTHOR owes changes/m);
});

test('WR-02: every pr-status invocation in the sweep skill passes --repo explicitly', () => {
  const dir = path.join(__dirname, '..', 'skills', 'maintainer-review-sweep');
  let seen = 0;
  for (const f of ['SKILL.md', 're-review.md']) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of text.matchAll(/`(?:node \S*\/)?(?:bin\/)?pr-status(?:\.cjs)? [^`]*`/g)) {
      seen += 1;
      assert.match(m[0], /--repo <owner>\/<repo>/, `${f}: ${m[0]}`);
    }
  }
  assert.ok(seen >= 3, `expected the intro, step 1 and step 13 invocations, saw ${seen}`);
});

test('WR-03: MAINTAINER ready only with an approval on the head, no requests, green checks and a clean merge state', () => {
  for (const f of ['approved-ready.json', 'approved-older-commit.json', 'approved-requests-pending.json',
    'approved-checks-failing.json', 'approved-checks-pending.json', 'approved-dirty.json', 'approved.json']) {
    const fx = loadFixture(f);
    assertBall(prStatus.derive(fx).ball, fx.provenance.expected, f);
  }
});

test('WR-03: ball lines name what blocks an approved PR', (t) => {
  const cases = [
    ['approved-ready.json', /^ {2}ball: MAINTAINER ready \(approved on the head, no change request, no pending requests, checks green, not DIRTY\)$/m],
    ['approved-older-commit.json', /^ {2}ball: MAINTAINER not ready \(approved but blocked: approval on an older commit\)$/m],
    ['approved-requests-pending.json', /^ {2}ball: REVIEWER owes a review \(approved but blocked: review requests pending \(Solvely-Colin, jeremymcs, davesienkowski\)\)$/m],
    ['approved-checks-failing.json', /^ {2}ball: AUTHOR owes fixes \(approved but blocked: checks failing\)$/m],
    ['approved-checks-pending.json', /^ {2}ball: MAINTAINER not ready \(approved but blocked: checks pending\)$/m],
    ['approved-dirty.json', /^ {2}ball: AUTHOR owes fixes \(approved but blocked: DIRTY \(merge conflicts\)\)$/m],
  ];
  for (const [f, re] of cases) {
    const r = runThroughStub(t, [String(loadFixture(f).view.number)]);
    assert.equal(r.status, 0, `${f}: ${r.stderr}`);
    assert.match(r.stdout, re, f);
  }
});

test('WR-03: a reviewDecision that disagrees with the reading prints a cross-check note; agreement prints none', (t) => {
  const mismatch = runThroughStub(t, ['900026']);
  assert.match(mismatch.stdout, /^ {2}note: GitHub reviewDecision is REVIEW_REQUIRED; pr-status reads APPROVED$/m);
  const agree = runThroughStub(t, ['900020', '5235']);
  assert.ok(!/note: GitHub reviewDecision/.test(agree.stdout), agree.stdout);
});

test('WR-04: a dismissed latest review with nobody requested puts the ball on the maintainer for re-approval', (t) => {
  const fx = loadFixture('dismissed-no-requests.json');
  assertBall(prStatus.derive(fx).ball, fx.provenance.expected, 'dismissed-no-requests');
  const r = runThroughStub(t, ['900027']);
  assert.match(r.stdout, /^ {2}ball: MAINTAINER re-approval needed \(latest review by trek-e was dismissed; no review requested\)$/m);
});

test('WR-05: the change-request reviewer back in the review requests owes a re-review (re-requested without a new commit)', (t) => {
  const fx = loadFixture('cr-head-rerequested.json');
  assertBall(prStatus.derive(fx).ball, fx.provenance.expected, 'cr-head-rerequested');
  const r = runThroughStub(t, ['900028']);
  assert.match(r.stdout, /^ {2}ball: REVIEWER trek-e owes a re-review \(re-requested without a new commit\)$/m);
});

test('WR-06: a team request (slug or name shape) counts as requested and drops NOT RE-REQUESTED', (t) => {
  for (const [f, team] of [['team-request.json', 'maintainers'], ['team-request-name.json', 'Maintainers']]) {
    const fx = loadFixture(f);
    const d = prStatus.derive(fx);
    assertBall(d.ball, fx.provenance.expected, f);
    assert.deepEqual(d.requested, [`team ${team}`], `${f}: requested`);
    const r = runThroughStub(t, [String(fx.view.number)]);
    assert.match(r.stdout, new RegExp(`^ {2}ball: REVIEWER trek-e owes a re-review \\(the head moved after the change request\\); team requested: ${team}$`, 'm'), f);
    assert.ok(!/NOT RE-REQUESTED/.test(r.stdout), `${f}: no NOT RE-REQUESTED flag`);
  }
});

test('IN-02: PR number 0 is a usage error; leading zeros are normalised before any gh call', (t) => {
  for (const args of [['0'], ['000']]) {
    const r = runThroughStub(t, args);
    assert.equal(r.status, 2, JSON.stringify(args));
    assert.equal(r.log.length, 0);
  }
  const r = runThroughStub(t, ['05235']);
  assert.equal(r.status, 0, r.stderr);
  const calls = r.log.map((l) => JSON.parse(l));
  assert.deepEqual(calls[0].slice(0, 3), ['pr', 'view', '5235']);
  assert.ok(calls[1].includes('repos/open-gsd/gsd-core/pulls/5235/reviews?per_page=100'));
  assert.match(r.stdout, /^open-gsd\/gsd-core#5235 OPEN /m);
});

// --- quick 261021-n2m (CTK-ADR-0012): merge-queue awareness; BEHIND is never a blocker ---

const QUEUE_FIXTURES = ['active.json', 'evaluate.json', 'absent.json', 'rules-read-failure.json'];

function loadQueue(name) {
  return JSON.parse(fs.readFileSync(path.join(QUEUE_DIR, name), 'utf8'));
}

/** The pure deriveQueue input a queue fixture describes for base `next`. */
function queueInput(q, base = 'next') {
  const details = (q.rulesets || [])
    .filter((r) => r.target === 'branch' && r.enforcement === 'evaluate')
    .map((r) => q.rulesetDetails[r.id])
    .filter(Boolean);
  return { base, rules: (q.rulesBranches && q.rulesBranches[base]) || [], details, defaultBranch: q.repo.default_branch };
}

/** A gh runner over one queue fixture that records each call (the per-PR reads are not served). */
function queueGh(q, calls) {
  return (args) => {
    calls.push(args.join(' '));
    const p = args.find((a) => a.startsWith('repos/')).split('?')[0];
    const fail = (kind) => {
      if (q.fail && q.fail[kind]) throw Object.assign(new Error('gh failed'), { status: 1, stderr: q.fail[kind] });
    };
    let m;
    if ((m = /\/rules\/branches\/(.+)$/.exec(p))) { fail('rules'); return [(q.rulesBranches || {})[decodeURIComponent(m[1])] || []]; }
    if (/\/rulesets$/.test(p)) { fail('rulesets'); return [q.rulesets || []]; }
    if ((m = /\/rulesets\/(\d+)$/.exec(p))) { fail('ruleset'); return q.rulesetDetails[m[1]]; }
    fail('repo');
    return q.repo;
  };
}

/** approved-ready.json with its merge state set to BEHIND, as a PR fixture dir for the stub. */
function behindReadyDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-status-behind-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fx = loadFixture('approved-ready.json');
  fx.view.mergeStateStatus = 'BEHIND';
  fs.writeFileSync(path.join(dir, 'behind-ready.json'), JSON.stringify(fx));
  return { dir, fx };
}

test('n2m queue fixtures: each records its source, its edits and the hand-derived mode', () => {
  for (const f of QUEUE_FIXTURES) {
    const p = loadQueue(f).provenance;
    assert.ok(p && /^(captured open-gsd\/gsd-core rulesets \S+Z|synthetic from \S+\.json)$/.test(p.source), `${f}: provenance.source`);
    assert.equal(typeof p.edits, 'string', `${f}: provenance.edits`);
    assert.ok(['active', 'evaluate', 'absent', 'unknown'].includes(p.expected.mode), `${f}: provenance.expected.mode`);
  }
});

test('n2m deriveQueue: each queue fixture yields its recorded mode (absent is the live 2026-10-21 capture)', () => {
  for (const f of QUEUE_FIXTURES.filter((x) => x !== 'rules-read-failure.json')) {
    const q = loadQueue(f);
    const got = prStatus.deriveQueue(queueInput(q));
    assert.equal(got.mode, q.provenance.expected.mode, `${f}: mode`);
    assert.equal(got.base, 'next', `${f}: base`);
  }
});

test('n2m adjacency: an active merge_queue rule beats an evaluate one, and a matching exclude beats a matching include', () => {
  const active = loadQueue('active.json');
  const evaluate = loadQueue('evaluate.json');
  const both = { ...queueInput(evaluate), rules: active.rulesBranches.next };
  assert.equal(prStatus.deriveQueue(both).mode, 'active');

  const mq = { type: 'merge_queue', parameters: { merge_method: 'SQUASH' } };
  const ruleset = (include, exclude) => ({ id: 7, name: 'q', target: 'branch', enforcement: 'evaluate', conditions: { ref_name: { include, exclude } }, rules: [mq] });
  const derive = (rs, base = 'next') => prStatus.deriveQueue({ base, rules: [], details: [rs], defaultBranch: 'next' }).mode;
  assert.equal(derive(ruleset(['~ALL'], ['refs/heads/next'])), 'absent', 'exclude wins');
  assert.equal(derive(ruleset(['~ALL'], []), 'next'), 'evaluate');
  assert.equal(derive(ruleset(['~DEFAULT_BRANCH'], []), 'next'), 'evaluate');
  assert.equal(derive(ruleset(['~DEFAULT_BRANCH'], []), 'main'), 'absent', '~DEFAULT_BRANCH covers only the default branch');
  assert.equal(derive(ruleset(['refs/heads/release/**'], []), 'release/1.2/rc'), 'evaluate', '** crosses slashes');
  assert.equal(derive(ruleset(['refs/heads/release/*'], []), 'release/1.2/rc'), 'absent', '* stops at a slash');
  assert.equal(derive(ruleset(['next'], []), 'next'), 'evaluate', 'a bare name means refs/heads/<name>');
  assert.equal(derive({ ...ruleset(['~ALL'], []), rules: [{ type: 'deletion' }] }), 'absent', 'no merge_queue rule');
});

test('n2m empty: no active rules and no rulesets reads as absent with no detail reads; no base reads nothing', () => {
  const calls = [];
  const empty = { repo: { default_branch: 'next' }, rulesBranches: {}, rulesets: [], rulesetDetails: {} };
  const got = prStatus.fetchQueue('open-gsd/gsd-core', 'next', { gh: queueGh(empty, calls) });
  assert.equal(got.mode, 'absent');
  assert.equal(calls.length, 2, `rules GET and rulesets GET only: ${calls.join(' | ')}`);

  const none = [];
  const noBase = prStatus.fetchQueue('open-gsd/gsd-core', '', { gh: queueGh(empty, none) });
  assert.equal(noBase.mode, 'unknown');
  assert.match(noBase.error, /no base branch/);
  assert.equal(none.length, 0, 'no queue read without a base branch');
});

test('n2m fetchQueue: active stops after the rules read; evaluate reads only the evaluate branch rulesets', () => {
  const a = [];
  assert.equal(prStatus.fetchQueue('open-gsd/gsd-core', 'next', { gh: queueGh(loadQueue('active.json'), a) }).mode, 'active');
  assert.equal(a.length, 1, a.join(' | '));
  const e = [];
  assert.equal(prStatus.fetchQueue('open-gsd/gsd-core', 'next', { gh: queueGh(loadQueue('evaluate.json'), e) }).mode, 'evaluate');
  assert.ok(e.some((c) => c.includes('rulesets/16752567')) && e.some((c) => c.includes('rulesets/16752568')), e.join(' | '));
  assert.ok(!e.some((c) => c.includes('rulesets/16752570')), 'the tag ruleset is never read');
  for (const c of [...a, ...e]) assert.ok(!/ -X | -f | -F |graphql/.test(` ${c} `), `read-only REST: ${c}`);
});

test('n2m failure: a failed queue read is mode unknown with the error named, never absent or active', () => {
  const got = prStatus.fetchQueue('open-gsd/gsd-core', 'next', { gh: queueGh(loadQueue('rules-read-failure.json'), []) });
  assert.equal(got.mode, 'unknown');
  assert.match(got.error, /HTTP 403/);
});

test('n2m BEHIND is never a blocker: approved, green and BEHIND reads MAINTAINER ready in every queue mode', () => {
  const fx = loadFixture('approved-ready.json');
  fx.view.mergeStateStatus = 'BEHIND';
  for (const f of QUEUE_FIXTURES) {
    const q = loadQueue(f);
    const queue = f === 'rules-read-failure.json' ? { base: 'next', mode: 'unknown', error: 'gh: x (HTTP 403)' } : prStatus.deriveQueue(queueInput(q));
    const d = prStatus.derive({ ...fx, queue });
    assert.equal(d.ball.owner, 'maintainer', `${f}: owner`);
    assert.equal(d.ball.ready, true, `${f}: ready`);
    assert.deepEqual(d.ball.blockers, [], `${f}: no blockers`);
  }
  // A failing check on a BEHIND PR still puts the ball on the author, for the failing check only.
  const failing = loadFixture('approved-checks-failing.json');
  failing.view.mergeStateStatus = 'BEHIND';
  const d = prStatus.derive({ ...failing, queue: { base: 'next', mode: 'absent' } });
  assert.deepEqual(d.ball.blockers, ['checks failing']);
});

test('n2m end to end: queue line, ready line and BEHIND note per mode; a failed queue read still exits 0', (t) => {
  const { dir, fx } = behindReadyDir(t);
  const n = String(fx.view.number);
  const cases = [
    ['active.json', /^ {2}queue: next active \(merge_queue rule in ruleset 16752567\)$/m,
      /^ {2}ball: MAINTAINER ready \(approved on the head, no change request, no pending requests, checks green, not DIRTY; enters the merge queue on next\)$/m,
      /^ {2}note: BEHIND is informational: the merge queue on next tests the PR on top of the entries ahead of it; nobody rebases or runs Update branch for BEHIND, and never --admin$/m],
    ['evaluate.json', /^ {2}queue: next evaluate \(merge_queue rule in ruleset main-protection, not enforcing\)$/m,
      /^ {2}ball: MAINTAINER ready \(approved on the head, no change request, no pending requests, checks green, not DIRTY; maintainer: Update branch at merge time; never --admin\)$/m,
      /^ {2}note: BEHIND is not author work: GitHub reports BEHIND only when next requires up-to-date branches, so with no active merge queue the maintainer runs Update branch at merge time \(one fresh CI run\) and never --admin; the author does not rebase for BEHIND$/m],
    ['absent.json', /^ {2}queue: next none \(no merge_queue rule applies to the base branch\)$/m,
      /^ {2}ball: MAINTAINER ready \(approved on the head, no change request, no pending requests, checks green, not DIRTY; maintainer: Update branch at merge time; never --admin\)$/m,
      /^ {2}note: BEHIND is not author work: GitHub reports BEHIND only when next requires up-to-date branches, so with no active merge queue the maintainer runs Update branch at merge time \(one fresh CI run\) and never --admin; the author does not rebase for BEHIND$/m],
    ['rules-read-failure.json', /^ {2}queue: next unknown \(queue read failed: gh: Resource not accessible by integration \(HTTP 403\); BEHIND treated as informational\)$/m,
      /^ {2}ball: MAINTAINER ready \(approved on the head, no change request, no pending requests, checks green, not DIRTY; maintainer: Update branch at merge time; never --admin\)$/m,
      /^ {2}note: BEHIND is not author work: GitHub reports BEHIND only when next requires up-to-date branches, so with no active merge queue \(mode unknown: read failed\) the maintainer runs Update branch at merge time \(one fresh CI run\) and never --admin; the author does not rebase for BEHIND$/m],
  ];
  for (const [q, queueRe, readyRe, noteRe] of cases) {
    const r = runThroughStub(t, [n], { fixturesDir: dir, queue: q });
    assert.equal(r.status, 0, `${q}: exit (stderr: ${r.stderr})`);
    assert.match(r.stdout, queueRe, `${q}: queue line`);
    assert.match(r.stdout, readyRe, `${q}: ready line`);
    assert.match(r.stdout, noteRe, `${q}: BEHIND note`);
    assert.ok(isPrintableAscii(r.stdout), `${q}: ASCII`);
    assert.ok(!r.log.some((l) => l.startsWith('REFUSED')), `${q}: nothing refused`);
  }
  // No BEHIND, no note.
  const clean = runThroughStub(t, ['900020'], { queue: 'absent.json' });
  assert.ok(!/note: BEHIND/.test(clean.stdout), clean.stdout);
});

test('n2m ordering: PRs sharing a repo and base share one set of queue reads and still print in argv order', (t) => {
  const r = runThroughStub(t, ['5235', '900020', '5079'], { queue: 'absent.json' });
  assert.equal(r.status, 0, r.stderr);
  const rulesReads = r.log.filter((l) => l.includes('/rules/branches/next'));
  assert.equal(rulesReads.length, 1, `one rules read for base next: ${rulesReads.join(' | ')}`);
  const heads = [...r.stdout.matchAll(/^open-gsd\/gsd-core#(\d+) /gm)].map((m) => m[1]);
  assert.deepEqual(heads, ['5235', '900020', '5079']);
});

test('n2m idempotency: two runs over each queue fixture print byte-identical output', (t) => {
  for (const q of QUEUE_FIXTURES) {
    const a = runThroughStub(t, ['900020', '5235'], { queue: q });
    const b = runThroughStub(t, ['900020', '5235'], { queue: q });
    assert.equal(a.status, 0, `${q}: ${a.stderr}`);
    assert.equal(a.stdout, b.stdout, q);
  }
});

test('n2m footer: the snapshot names the separate merge-queue reads, so a queue switched on mid-run is caught by re-running', (t) => {
  const r = runThroughStub(t, ['900020'], { queue: 'absent.json' });
  assert.ok(r.stdout.includes(FOOTER_START), r.stdout);
});

test('n2m --json: each result carries the queue object read for its base', (t) => {
  const r = runThroughStub(t, ['--json', '900020'], { queue: 'evaluate.json' });
  assert.equal(r.status, 0, r.stderr);
  const [d] = JSON.parse(r.stdout);
  assert.equal(d.queue.mode, 'evaluate');
  assert.equal(d.queue.base, 'next');
  assert.equal(d.queue.ruleset, 'main-protection');
});

// --- 261021-n2m adversarial-gate fixes: BEHIND proves up-to-date is enforced; non-array queue replies ---

test('n2m gate fix: BEHIND with no active queue is a maintainer caveat (Update branch, never --admin), never author work', () => {
  const fx = loadFixture('approved-ready.json');
  fx.view.mergeStateStatus = 'BEHIND';
  for (const mode of ['absent', 'evaluate', 'unknown']) {
    const d = prStatus.derive({ ...fx, queue: { base: 'next', mode, error: mode === 'unknown' ? 'x' : undefined } });
    assert.equal(d.ball.owner, 'maintainer', mode);
    assert.equal(d.ball.ready, true, mode);
    assert.deepEqual(d.ball.blockers, [], mode);
    assert.equal(d.ball.mergeCaveat, 'Update branch at merge time; never --admin', mode);
  }
  const active = prStatus.derive({ ...fx, queue: { base: 'next', mode: 'active', ruleset: '1' } });
  assert.equal(active.ball.mergeCaveat, null, 'the active queue handles BEHIND');
  const clean = prStatus.derive({ ...loadFixture('approved-ready.json'), queue: { base: 'next', mode: 'absent' } });
  assert.equal(clean.ball.mergeCaveat, null, 'no caveat when not BEHIND');
  // A BEHIND PR that is not ready still names only its real blockers, and the author is not made to owe BEHIND.
  const pending = loadFixture('approved-requests-pending.json');
  pending.view.mergeStateStatus = 'BEHIND';
  const p = prStatus.derive({ ...pending, queue: { base: 'next', mode: 'absent' } });
  assert.notEqual(p.ball.owner, 'author');
  assert.ok(!p.ball.blockers.some((b) => /BEHIND/.test(b)), JSON.stringify(p.ball.blockers));
});

test('n2m gate fix (Postel): a queue reply that is not an array of pages is mode unknown, never none', () => {
  const shapes = [{ message: 'odd' }, [{ message: 'odd' }], 'text', null];
  for (const bad of shapes) {
    for (const which of ['rules', 'rulesets']) {
      const gh = (args) => {
        const p = args.find((a) => a.startsWith('repos/'));
        if (/\/rules\/branches\//.test(p)) return which === 'rules' ? bad : [[]];
        if (/\/rulesets\?/.test(p)) return bad;
        throw new Error('unexpected read ' + p);
      };
      const got = prStatus.fetchQueue('open-gsd/gsd-core', 'next', { gh });
      assert.equal(got.mode, 'unknown', `${which} reply ${JSON.stringify(bad)}`);
      assert.match(got.error, /not an array/, `${which} reply ${JSON.stringify(bad)}`);
    }
  }
});

// --- round-2 gate note N4: queue.strictUpToDate is removed, not kept as a deprecated field ---
// It read only ACTIVE rulesets, so on open-gsd next it said false while classic protection enforced
// up-to-date for non-admins; nothing keyed on it (no consumer found via the paths searched; see
// CTK-ADR-0012 Consequences). A deliberate key set keeps the --json queue shape a decision, not drift.

test('N4: deriveQueue returns exactly base, mode and ruleset (no strictUpToDate) for every queue fixture', () => {
  for (const f of QUEUE_FIXTURES.filter((x) => x !== 'rules-read-failure.json')) {
    const got = prStatus.deriveQueue(queueInput(loadQueue(f)));
    assert.deepEqual(Object.keys(got).sort(), ['base', 'mode', 'ruleset'], `${f}: ${JSON.stringify(got)}`);
  }
});

test('N4: no queue fixture records an expected strictUpToDate', () => {
  for (const f of QUEUE_FIXTURES) {
    assert.ok(!('strictUpToDate' in loadQueue(f).provenance.expected), `${f}: provenance.expected.strictUpToDate`);
  }
});

test('N4: the --json queue object carries no strictUpToDate key in any mode', (t) => {
  for (const q of ['active.json', 'evaluate.json', 'absent.json']) {
    const r = runThroughStub(t, ['--json', '900020'], { queue: q });
    assert.equal(r.status, 0, `${q}: ${r.stderr}`);
    const [d] = JSON.parse(r.stdout);
    assert.ok(d.queue && typeof d.queue.mode === 'string', `${q}: queue object present`);
    assert.ok(!('strictUpToDate' in d.queue), `${q}: ${JSON.stringify(d.queue)}`);
  }
});

test('N4 (nits gate): the --json queue object in unknown mode is exactly base, mode and error', (t) => {
  const r = runThroughStub(t, ['--json', '900020'], { queue: 'rules-read-failure.json' });
  assert.equal(r.status, 0, r.stderr);
  const [d] = JSON.parse(r.stdout);
  assert.equal(d.queue.mode, 'unknown', JSON.stringify(d.queue));
  assert.deepEqual(Object.keys(d.queue).sort(), ['base', 'error', 'mode'], JSON.stringify(d.queue));
  assert.equal(typeof d.queue.error, 'string');
});

// --- quick 261022-w9m: dismissal messages from the timeline, and the opt-in --overlap reads ---

test('w9m dismissed: each DISMISSED review prints a dismissed line with its timeline message, in submitted_at order', (t) => {
  const r = runThroughStub(t, ['900040']);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.split('\n').filter((l) => l.startsWith('  dismissed: '));
  assert.deepEqual(lines, [
    '  dismissed: alice review 900040003 on 22fccc0; message unknown (no review_dismissed event for this review on the timeline)',
    '  dismissed: trek-e CHANGES_REQUESTED review 900040002 on 22fccc0 by trek-e 2026-10-23T00:55:59Z: "Withdrawn: review produced outside the required /review-open-prs procedure; run is being restarted."',
  ]);
  const timelineReads = r.log.filter((l) => l.includes('/issues/900040/timeline'));
  assert.equal(timelineReads.length, 1, 'one timeline read');
  assert.ok(!r.log.some((l) => l.startsWith('REFUSED')), r.log.join(' | '));
});

test('w9m dismissed: a PR with no DISMISSED review makes no timeline read and prints no dismissed line', (t) => {
  const r = runThroughStub(t, ['5235', '900020']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.log.some((l) => l.includes('/timeline')), r.log.join(' | '));
  assert.ok(!/^ {2}dismissed: /m.test(r.stdout));
});

test('w9m dismissed: a failed timeline read names the failure on the dismissed line and never fails the PR', (t) => {
  const r = runThroughStub(t, ['900041']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^ {2}dismissed: trek-e review 900040002 on 22fccc0; message unknown \(timeline read failed: gh: Server Error \(HTTP 502\)\)$/m);
  assert.match(r.stdout, /^ {2}ball: MAINTAINER re-approval needed/m);
});

test('w9m dismissed: --json carries the dismissals with the message, actor and time', (t) => {
  const r = runThroughStub(t, ['--json', '900040']);
  const [d] = JSON.parse(r.stdout);
  assert.equal(d.dismissals.length, 2);
  assert.deepEqual(
    { ...d.dismissals[1] },
    {
      login: 'trek-e',
      reviewId: '900040002',
      commitId: '22fccc0e5c6dc2d0a6ca14416737aa53e9a25690',
      submittedAt: '2026-10-23T00:50:25Z',
      originalState: 'CHANGES_REQUESTED',
      actor: 'trek-e',
      dismissedAt: '2026-10-23T00:55:59Z',
      message: 'Withdrawn: review produced outside the required /review-open-prs procedure; run is being restarted.',
      found: true,
      readError: null,
    }
  );
  assert.equal(d.overlap, null, 'overlap is null without --overlap');
});

test('w9m dismissed: a long or multi-line message prints on one line, cut at 300 characters', () => {
  const [x] = prStatus.deriveDismissals(
    [{ id: 1, user: { login: 'a' }, state: 'DISMISSED', submitted_at: 't', commit_id: 'c' }],
    [{ event: 'review_dismissed', actor: { login: 'b' }, created_at: 'u', dismissed_review: { state: 'approved', review_id: 1, dismissal_message: 'line one\n\nline two ' + 'x'.repeat(400) } }],
    null
  );
  const d = { number: 1, state: 'OPEN', head: '', checks: { total: 0, counts: {}, failing: [], pending: [] }, reviewers: [], requested: [], ball: { owner: 'none', blockers: [] }, dismissals: [x] };
  const line = prStatus.formatText(d).split('\n').find((l) => l.startsWith('  dismissed: '));
  assert.ok(line.includes('"line one line two xxx'), line);
  assert.ok(line.endsWith('..."'), line);
});

test('w9m overlap: --overlap on the 5119 capture prints behind 13, 95 base files, 2 PR files and no overlap', (t) => {
  const r = runThroughStub(t, ['--overlap', '900042']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^ {2}overlap: next is 13 commit\(s\) past the merge base 26387bc83; 95 base file\(s\) changed, 2 PR file\(s\); overlapping files: none$/m);
  const calls = r.log.map((l) => JSON.parse(l));
  const paths = calls.filter((c) => c[0] === 'api').map((c) => c.find((a) => a.startsWith('repos/')));
  assert.ok(paths.includes('repos/open-gsd/gsd-core/pulls/900042/files?per_page=100'), paths.join(' '));
  assert.ok(paths.includes('repos/open-gsd/gsd-core/compare/next...1830f52109c5f3875b5709a8b0d9140cee7ee23f'), paths.join(' '));
  assert.ok(paths.includes('repos/open-gsd/gsd-core/compare/26387bc83d9ddc6cbea04946ff0fe5871e8830d0...next'), paths.join(' '));
  assert.ok(!r.log.some((l) => l.startsWith('REFUSED')), r.log.join(' | '));
});

test('w9m overlap: without --overlap no files or compare read is made', (t) => {
  const r = runThroughStub(t, ['900042']);
  assert.ok(!r.log.some((l) => l.includes('/compare/') || l.includes('/files')), r.log.join(' | '));
  assert.ok(!/^ {2}overlap: /m.test(r.stdout));
});

const HEX = (c) => c.repeat(40);

function overlapGh(map) {
  return (args) => {
    const p = args.find((a) => a.startsWith('repos/'));
    if (!(p in map)) throw Object.assign(new Error('not found'), { stderr: 'gh: Not Found (HTTP 404)' });
    if (map[p] instanceof Error) throw map[p];
    return map[p];
  };
}

test('w9m overlap: a base that has not moved reads behind 0 and none, with no base compare read', () => {
  const calls = [];
  const gh = overlapGh({
    'repos/o/r/pulls/7/files?per_page=100': [[{ filename: 'a.js' }]],
    [`repos/o/r/compare/next...${HEX('a')}`]: { behind_by: 0, ahead_by: 1, merge_base_commit: { sha: HEX('b') } },
  });
  const o = prStatus.fetchOverlap('o/r', { number: 7, baseRefName: 'next', headRefOid: HEX('a') }, { gh: (a) => (calls.push(a), gh(a)) });
  assert.equal(o.behindBy, 0);
  assert.deepEqual(o.overlap, []);
  assert.equal(calls.length, 2);
  const d = { number: 7, state: 'OPEN', head: '', checks: { total: 0, counts: {}, failing: [], pending: [] }, reviewers: [], requested: [], ball: { owner: 'none', blockers: [] }, overlap: o };
  assert.match(prStatus.formatText(d), /overlap: next is 0 commit\(s\) past the merge base bbbbbbbbb; overlapping files: none \(the base has not moved\)/);
});

test('w9m overlap: overlapping files (renames on either side included) print sorted, and a 300-file base list is a lower bound', () => {
  const base = Array.from({ length: 298 }, (_, i) => ({ filename: `f${i}.js` }));
  base.push({ filename: 'z.js' }, { filename: 'new.js', previous_filename: 'm.js' });
  const gh = overlapGh({
    'repos/o/r/pulls/7/files?per_page=100': [[{ filename: 'z.js' }, { filename: 'm.js' }, { filename: 'other.js' }]],
    [`repos/o/r/compare/next...${HEX('a')}`]: { behind_by: 4, ahead_by: 1, merge_base_commit: { sha: HEX('b') } },
    [`repos/o/r/compare/${HEX('b')}...next`]: { total_commits: 4, files: base },
  });
  const o = prStatus.fetchOverlap('o/r', { number: 7, baseRefName: 'next', headRefOid: HEX('a') }, { gh });
  assert.deepEqual(o.overlap, ['m.js', 'z.js']);
  assert.equal(o.truncated, true);
  const d = { number: 7, state: 'OPEN', head: '', checks: { total: 0, counts: {}, failing: [], pending: [] }, reviewers: [], requested: [], ball: { owner: 'none', blockers: [] }, overlap: o };
  const text = prStatus.formatText(d);
  assert.match(text, /overlapping files: at least 2 \(truncated\)\n {4}m\.js\n {4}z\.js/);
  // the same truncated list with no overlap is unknown beyond the listed files, never a plain none
  const o2 = prStatus.deriveOverlap({ base: 'next', behindBy: 4, aheadBy: 1, mergeBase: HEX('b'), baseCommits: 4, prFiles: [{ filename: 'q.js' }], baseFiles: base });
  const t2 = prStatus.formatText({ ...d, overlap: o2 });
  assert.match(t2, /overlapping files: none among the listed base files, unknown beyond them \(truncated\)/);
  assert.ok(!/overlapping files: none$/m.test(t2));
});

test('w9m overlap: a failed compare read prints overlap unknown with the error, never none, and exit stays 0', (t) => {
  const o = prStatus.fetchOverlap('o/r', { number: 7, baseRefName: 'next', headRefOid: HEX('a') }, { gh: overlapGh({ 'repos/o/r/pulls/7/files?per_page=100': [[]] }) });
  assert.deepEqual(o, { base: 'next', error: 'gh: Not Found (HTTP 404)' });
  const bad = prStatus.fetchOverlap('o/r', { number: 7, baseRefName: 'next;rm', headRefOid: HEX('a') }, { gh: () => assert.fail('no read for a bad base name') });
  assert.match(bad.error, /base branch name not usable/);
  const r = runThroughStub(t, ['--overlap', '5235']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^ {2}overlap: unknown \(read failed: /m);
});

test('w9m overlap: a PR file list at the GitHub 3000-file cap marks the overlap truncated', () => {
  const pr = Array.from({ length: 3000 }, (_, i) => ({ filename: `p${i}.js` }));
  const o = prStatus.deriveOverlap({ base: 'next', behindBy: 1, aheadBy: 1, mergeBase: 'b'.repeat(40), baseCommits: 1, prFiles: pr, baseFiles: [{ filename: 'other.js' }] });
  assert.equal(o.truncated, true);
  assert.equal(o.prTruncated, true);
});

// --- quick 261023-2u4: pr-status --cr (the latest change request's checklist, the activity since it, the re-request trace) ---

const CR_FOOTER =
  "With --cr or --body: the timeline, the chosen change request's inline comments and the body view are further separate reads, so the head can move between them; re-run before any write.";

/** The lines of one PR block that start with one of the --cr prefixes, in print order. */
function crBlock(stdout) {
  return stdout.split('\n').filter((l) => /^ {2}(cr|checklist|inline|activity|rerequest)\b/.test(l) || l.startsWith('    [ ] '));
}

function noRefusal(r) {
  assert.ok(!r.log.some((l) => l.startsWith('REFUSED')), `stub refused a call: ${r.log.filter((l) => l.startsWith('REFUSED')).join(' | ')}`);
}

/** The review body of one captured review, from the 5119/5192 fixtures. */
function capturedBody(id) {
  for (const f of ['cr-5119-captured.json', 'cr-5192-captured.json']) {
    const r = loadFixture(f).reviews.flat().find((x) => String(x.id) === String(id));
    if (r) return r.body;
  }
  throw new Error(`no captured review ${id}`);
}

test('2u4 cr: the 5119 capture chooses 5608091717, notes the dismissed 5622671659, prints 4 matching items, the activity since it and RE-REQUEST NEEDED', (t) => {
  const r = runThroughStub(t, ['--cr', '900043']);
  assert.equal(r.status, 0, r.stderr);
  noRefusal(r);
  const url = 'https://github.com/open-gsd/gsd-core/pull/5119';
  const lines = crBlock(r.stdout);
  const items = lines.filter((l) => l.startsWith('    [ ] '));
  assert.deepEqual(items.map((l) => l.split(' ').slice(4, 8).join(' ')), ['[ ] Minor 1.', '[ ] Nit 2.', '[ ] Nit 3.', '[ ] Nit 4.']);
  assert.ok(items[0].startsWith('    [ ] Minor 1. (adversarial, reproduced; severity is judgment) '), items[0]);
  assert.equal(items[0].length, '    [ ] Minor '.length + 200, 'an item is cut to 200 characters after cleaning');
  assert.equal(items[3], '    [ ] Nit 4. Carried Nit 5 (ADR-4629 guard-table refs `:606,564`): author declined; see Follow-ups.');
  assert.deepEqual(
    lines.filter((l) => !l.startsWith('    [ ] ')),
    [
      `  cr: review 5608091717 by trek-e on 8cea5f8 (older commit) 2026-10-22T01:07:53Z ${url}#pullrequestreview-5608091717`,
      '  cr: note: newer review 5622671659 by trek-e was dismissed by trek-e 2026-10-23T00:55:59Z (originally CHANGES_REQUESTED); not counted',
      '  checklist (4 items; matches the verdict counts 0 Blocker, 0 Major, 1 Minor, 3 Nit)',
      '  inline: none',
      '  activity: 25 commit(s) pushed, last 1830f52',
      '  activity: force-pushed by davesienkowski to 1830f52',
      `  activity: commented davesienkowski 2026-10-22T14:44:22Z ${url}#issuecomment-6343575001`,
      '  activity: review requested by davesienkowski -> trek-e',
      '  activity: reviewed trek-e DISMISSED review 5622671659 on 1830f52',
      '  activity: review 5622671659 dismissed by trek-e',
      '  activity: 1 commit(s) pushed, last f2aedc2',
      `  activity: commented davesienkowski 2026-10-23T04:46:54Z ${url}#issuecomment-6357609343`,
      '  rerequest: trek-e not requested; the 2026-10-22T14:44:36Z request by davesienkowski was consumed by review 5622671659 (DISMISSED) at 2026-10-23T00:50:25Z RE-REQUEST NEEDED',
    ]
  );
  // The default block is unchanged around the --cr lines, and the R8 footer line follows the default footer.
  assert.match(r.stdout, /^ {2}ball: REVIEWER owes a first review \(requests pending: Solvely-Colin, jeremymcs\)$/m);
  assert.ok(r.stdout.endsWith(FOOTER_START + ' A change request answered without a new commit (retitle, comment) still reads as author owes unless the reviewer was re-requested: check the timeline.\n' + CR_FOOTER + '\n'), r.stdout.slice(-600));
  const calls = r.log.map((l) => JSON.parse(l));
  assert.equal(calls.filter((c) => c.includes('repos/open-gsd/gsd-core/issues/900043/timeline?per_page=100')).length, 1, 'one timeline read');
  assert.deepEqual(
    calls.filter((c) => c.some((a) => /\/comments/.test(a))),
    [['api', '--paginate', '--slurp', 'repos/open-gsd/gsd-core/pulls/900043/reviews/5608091717/comments?per_page=100']],
    'one inline-comments read, for the chosen review'
  );
  assert.ok(!calls.some((c) => c.includes('body,baseRefOid,changedFiles')), 'no body view without --body');
});

test('2u4 cr: the 5192 capture chooses 5563209291 with 13 items matching "Blocker 0, Major 1, Minor 7, Nit 5" and trek-e requested now', (t) => {
  const r = runThroughStub(t, ['--cr', '900044']);
  assert.equal(r.status, 0, r.stderr);
  noRefusal(r);
  const lines = crBlock(r.stdout);
  assert.equal(lines[0], '  cr: review 5563209291 by trek-e on 35bf07e (older commit) 2026-10-18T13:37:59Z https://github.com/open-gsd/gsd-core/pull/5192#pullrequestreview-5563209291');
  assert.equal(lines[1], '  checklist (13 items; matches the verdict counts Blocker 0, Major 1, Minor 7, Nit 5)');
  const sev = lines.filter((l) => l.startsWith('    [ ] ')).map((l) => l.split(' ')[6]);
  assert.deepEqual(sev, ['Major', ...Array(7).fill('Minor'), ...Array(5).fill('Nit')]);
  assert.ok(lines.every(isPrintableAscii), 'the em dash in the bold labels prints as ?');
  assert.ok(lines.includes('  activity: 27 commit(s) pushed, last aff15ba'), lines.join('\n'));
  assert.equal(lines[lines.length - 1], '  rerequest: trek-e requested now (since 2026-10-23T04:47:18Z by davesienkowski)');
});

test('2u4 cr parser: the captured bodies give 6, 13, none (no heading), unparsed 7 vs 5, none (no items) and 6 with no counts', () => {
  const p = (id) => prStatus.parseChecklist(capturedBody(id));
  const a = p(5436531471);
  assert.equal(a.status, 'matched');
  assert.equal(a.items.length, 6);
  assert.deepEqual(a.items.map((i) => i.severity), ['Minor', 'Minor', 'Minor', 'Nit', 'Nit', 'Nit']);
  assert.equal(a.verdict.text, '0 Blocker, 0 Major, 3 Minor, 3 Nit');
  const b = p(5477738387);
  assert.equal(b.status, 'matched');
  assert.equal(b.items.length, 13, 'bold **Major 1 ...** labels are items');
  assert.deepEqual(b.items.map((i) => i.severity), ['Major', ...Array(6).fill('Minor'), ...Array(6).fill('Nit')]);
  assert.equal(b.verdict.text, 'Blocker 0, Major 1, Minor 6, Nit 6');
  const c = p(5512635344);
  assert.equal(c.status, 'none');
  assert.equal(c.reason, 'no Findings heading');
  const d = p(5563197184);
  assert.equal(d.status, 'unparsed');
  assert.equal(d.structural, 7);
  assert.equal(d.verdict.sum, 5);
  assert.deepEqual(d.items, [], 'an unparsed checklist lists no items');
  const e = p(5471174433);
  assert.equal(e.status, 'none');
  assert.equal(e.reason, 'the Findings section holds no recognised items', 'R2: M1/m1 prefixes are not item markers');
  const f = p(5471157051);
  assert.equal(f.status, 'nocounts', 'R1: a line naming only "Minor 1" twice is no verdict');
  assert.equal(f.items.length, 6);
});

test('2u4 cr parser: R1 stops a line\'s count group at a repeated severity; severity words match case-insensitively with an optional plural', () => {
  const body = [
    '## FINDINGS',
    '**MINORS**',
    '- a',
    '  - detail, indented, not an item',
    '```',
    '- inside a fence, not an item',
    '```',
    '### nits',
    '* b',
    '#### Notes',
    '- c, a lower heading stays in the section',
    '## Next',
    '- d, after the section',
    'Verdict: 1 minor, 2 NITS. The open items are Minor 1 and Nit 2 and Minor 3.',
  ].join('\n');
  const k = prStatus.parseChecklist(body);
  assert.equal(k.status, 'matched', JSON.stringify(k));
  assert.deepEqual(k.items.map((i) => [i.severity, i.text]), [['Minor', '- a'], ['Nit', '* b'], ['Nit', '- c, a lower heading stays in the section']]);
  assert.equal(k.verdict.sum, 3);
  assert.equal(k.verdict.text, '1 minor, 2 NITS');
  const mismatch = prStatus.parseChecklist('### Findings\n1. one\n2. two\n\nChanges requested (0 Blocker, 0 Major, 1 Minor, 0 Nit).');
  assert.equal(mismatch.status, 'unparsed');
  assert.deepEqual([mismatch.structural, mismatch.verdict.sum], [2, 1]);
});

test('2u4 cr: the choice is stable on equal times (later-listed wins), excludes a Bot and the author; inline lines; activity strictly after; team wording', (t) => {
  const r = runThroughStub(t, ['--cr', '900045']);
  assert.equal(r.status, 0, r.stderr);
  noRefusal(r);
  const lines = crBlock(r.stdout);
  assert.deepEqual(lines, [
    '  cr: review 900045003 by bob on 5d5d045 (older commit) 2026-10-21T10:00:00Z https://github.com/open-gsd/gsd-core/pull/900045#pullrequestreview-900045003',
    '  checklist (2 items; matches the verdict counts 0 Blocker, 0 Major, 1 Minor, 1 Nit)',
    '    [ ] Minor 1. first minor finding',
    '    [ ] Nit 2. a nit',
    '  inline: bin/a.cjs:12 outdated anchor second line',
    '  inline: bin/b.cjs:7 [31mred[0m caf? ' + 'y'.repeat(120 - '[31mred[0m caf? '.length),
    '  activity: 1 commit(s) pushed, last 5c5c045',
    '  activity: force-pushed by davesienkowski to 5a5a045',
    '  activity: review requested by davesienkowski -> team core-maintainers',
    '  activity: reviewed dependabot[bot] CHANGES_REQUESTED review 900045004 on 5a5a045',
    '  activity: commented davesienkowski 2026-10-22T10:30:00Z https://github.com/open-gsd/gsd-core/pull/900045#issuecomment-900045901',
    '  activity: reviewed davesienkowski CHANGES_REQUESTED review 900045005 on 5a5a045',
    '  rerequest: alice not requested; never requested on the timeline re-request unknown (team core-maintainers requested; membership not resolved)',
    '  rerequest: bob not requested; the 2026-10-19T09:00:01Z request by davesienkowski was consumed by review 900045003 (CHANGES_REQUESTED) at 2026-10-21T10:00:00Z re-request unknown (team core-maintainers requested; membership not resolved)',
    '  rerequest: trek-e not requested; the 2026-10-20T12:00:00Z request by davesienkowski was removed by davesienkowski at 2026-10-20T13:00:00Z re-request unknown (team core-maintainers requested; membership not resolved)',
  ]);
  assert.ok(!r.stdout.includes('\u001b'), 'no ESC reaches the terminal');
  assert.equal(r.log.filter((l) => l.includes('/reviews/900045003/comments')).length, 1);
});

test('2u4 cr: no change request prints cr: none, makes no inline read and still prints the re-request lines', (t) => {
  const r = runThroughStub(t, ['--cr', '900046']);
  assert.equal(r.status, 0, r.stderr);
  noRefusal(r);
  assert.deepEqual(crBlock(r.stdout), [
    '  cr: none (no CHANGES_REQUESTED review by a non-bot non-author user)',
    '  rerequest: alice not requested; the 2026-10-20T10:00:00Z request by davesienkowski was consumed by review 900046001 (APPROVED) at 2026-10-21T10:00:00Z',
    '  rerequest: trek-e requested now (since 2026-10-21T12:00:00Z by davesienkowski)',
  ]);
  assert.ok(!r.log.some((l) => l.includes('/comments')), r.log.join(' | '));
});

test('2u4 cr: --reviewer limits the choice (login compared case-insensitively); a reviewer with no change request reads cr: none', (t) => {
  const none = runThroughStub(t, ['--cr', '--reviewer', 'alice', '900043']);
  assert.equal(none.status, 0, none.stderr);
  noRefusal(none);
  assert.equal(crBlock(none.stdout)[0], '  cr: none (no CHANGES_REQUESTED review by a non-bot non-author user named alice)');
  assert.ok(!none.log.some((l) => l.includes('/comments')));
  assert.match(none.stdout, /^ {2}rerequest: trek-e not requested; .* RE-REQUEST NEEDED$/m);
  const upper = runThroughStub(t, ['--cr', '--reviewer', 'TREK-E', '900043']);
  noRefusal(upper);
  assert.equal(crBlock(upper.stdout)[0].slice(0, 40), '  cr: review 5608091717 by trek-e on 8ce');
  const alice = runThroughStub(t, ['--cr', '--reviewer', 'alice', '900045']);
  noRefusal(alice);
  assert.match(alice.stdout, /^ {2}cr: review 900045002 by alice /m, 'alice CR is chosen when only alice counts');
});

test('2u4 cr usage: --reviewer without --cr, or a value that is not a GitHub login, exits 2 with no gh call', (t) => {
  for (const args of [['--reviewer', 'trek-e', '900043'], ['--cr', '--reviewer', 'not a login', '900043'], ['--cr', '--reviewer', '-x', '900043'], ['--cr', '--reviewer', 'a'.repeat(40), '900043'], ['--cr', '900043', '--reviewer']]) {
    const r = runThroughStub(t, args);
    assert.equal(r.status, 2, `${JSON.stringify(args)}: exit 2`);
    assert.match(r.stderr, /usage: pr-status /);
    assert.equal(r.log.length, 0, `${JSON.stringify(args)}: no gh call`);
  }
});

test('2u4 cr: failed timeline and inline reads print unknown lines and the exit code stays 0', (t) => {
  const r = runThroughStub(t, ['--cr', '900047']);
  assert.equal(r.status, 0, r.stderr);
  noRefusal(r);
  assert.deepEqual(crBlock(r.stdout), [
    '  cr: review 900047001 by trek-e on 5a5a047 (older commit) 2026-10-21T10:00:00Z https://github.com/open-gsd/gsd-core/pull/900047#pullrequestreview-900047001',
    '  checklist (2 items; matches the verdict counts 0 Blocker, 0 Major, 1 Minor, 1 Nit)',
    '    [ ] Minor 1. first minor finding',
    '    [ ] Nit 2. a nit',
    '  cr: inline unknown (read failed: gh: Server Error (HTTP 503))',
    '  cr: activity and rerequest unknown (read failed: gh: Server Error (HTTP 502))',
  ]);
  assert.match(r.stdout, /^ {2}ball: REVIEWER trek-e owes a re-review/m, 'the PR block still prints');
});

test('2u4 cr: a change request with no Findings heading prints checklist: none with the url, and no activity reads none', (t) => {
  const r = runThroughStub(t, ['--cr', '900049']);
  assert.equal(r.status, 0, r.stderr);
  noRefusal(r);
  const url = 'https://github.com/open-gsd/gsd-core/pull/900049#pullrequestreview-900049001';
  assert.deepEqual(crBlock(r.stdout), [
    `  cr: review 900049001 by trek-e on 5a5a049 (head) 2026-10-21T10:00:00Z ${url}`,
    `  checklist: none (no Findings heading); read the review ${url}`,
    '  inline: none',
    '  activity: none since the change request',
    '  rerequest: trek-e not requested; never requested on the timeline',
  ]);
});

test('2u4 cr: --json carries cr (null without the flag) with the chosen review, the checklist, inline, activity and rerequest', (t) => {
  const offRun = runThroughStub(t, ['--json', '900043']);
  noRefusal(offRun);
  const off = JSON.parse(offRun.stdout)[0];
  assert.equal(off.cr, null);
  const onRun = runThroughStub(t, ['--json', '--cr', '900043']);
  noRefusal(onRun);
  const [d] = JSON.parse(onRun.stdout);
  assert.equal(d.cr.chosen.id, '5608091717');
  assert.equal(d.cr.chosen.onHead, false);
  assert.equal(d.cr.checklist.status, 'matched');
  assert.equal(d.cr.checklist.items.length, 4);
  assert.deepEqual(d.cr.inline, []);
  assert.deepEqual(d.cr.activity[0], { kind: 'commits', count: 25, last: '1830f52109c5f3875b5709a8b0d9140cee7ee23f' });
  assert.equal(d.cr.rerequest.length, 1);
  assert.equal(d.cr.rerequest[0].needed, true);
  assert.equal(d.cr.notes[0].id, '5622671659');
});

test('2u4 cr: without --cr and --body, no fixture triggers an inline-comments or body read, and the footer has no R8 line', (t) => {
  const numbers = ALL_FIXTURES.map((f) => String(loadFixture(f).view.number)).filter((n) => n !== '900017');
  const r = runThroughStub(t, numbers);
  assert.equal(r.status, 0, r.stderr);
  noRefusal(r);
  assert.ok(!r.log.some((l) => l.includes('/comments') || l.includes('body,baseRefOid,changedFiles')), r.log.filter((l) => l.includes('comments')).join(' | '));
  assert.ok(!r.stdout.includes(CR_FOOTER));
  assert.ok(!/^ {2}(cr|checklist|inline|activity|rerequest)\b/m.test(r.stdout));
});

// --- quick 261023-2u4: pr-status --body (body sha classes, the Self-test report binding, files-changed phrases) ---

const BODY_TAIL = '(compared against head %s; base is the base sha GitHub last recorded for the PR, not the live base tip)';

function bodyBlock(stdout) {
  return stdout.split('\n').filter((l) => /^ {2}body: /.test(l) || /^ {4}L\d+ /.test(l));
}

test('2u4 body: the 5192 capture reports the Self-test report bound to the head and one unresolved token', (t) => {
  const r = runThroughStub(t, ['--body', '900044']);
  assert.equal(r.status, 0, r.stderr);
  noRefusal(r);
  assert.deepEqual(bodyBlock(r.stdout), [
    '  body: shas 8 head, 8 base, 0 pr commit, 0 former head, 0 earlier commit, 0 ambiguous, 1 unresolved ' + BODY_TAIL.replace('%s', 'aff15bafb'),
    '    L44 067a4d1c6c unresolved (may be an older base or an unrelated commit: check)',
    '  body: Self-test report bound to the head',
    '  body: counts checked: files-changed phrases only (changedFiles 22)',
  ]);
  assert.ok(r.stdout.endsWith(CR_FOOTER + '\n'), 'the R8 footer line follows the default footer');
  const views = r.log.map((l) => JSON.parse(l)).filter((c) => c[0] === 'pr' && c[1] === 'view');
  assert.deepEqual(views[1], ['pr', 'view', '900044', '--repo', 'open-gsd/gsd-core', '--json', 'body,baseRefOid,changedFiles']);
  assert.equal(r.log.filter((l) => l.includes('/issues/900044/timeline')).length, 1, '--body reads the timeline once');
  assert.ok(!r.log.some((l) => l.includes('/comments')), 'no inline read without --cr');
});

test('2u4 body: the 5119 capture has no Self-test report; 1830f5210 reads pr commit (not former head), two former heads, five unresolved', (t) => {
  const r = runThroughStub(t, ['--body', '900043']);
  assert.equal(r.status, 0, r.stderr);
  noRefusal(r);
  const check = ' unresolved (may be an older base or an unrelated commit: check)';
  assert.deepEqual(bodyBlock(r.stdout), [
    '  body: shas 0 head, 0 base, 1 pr commit, 2 former head, 0 earlier commit, 0 ambiguous, 5 unresolved ' + BODY_TAIL.replace('%s', 'f2aedc2d1'),
    '  body: no token names the head f2aedc2d1',
    '    L19 a1c7bc74b' + check,
    '    L35 62549bf24' + check,
    '    L55 472cfb257 former head',
    '    L55 755bf26f0' + check,
    '    L112 8cea5f843 former head',
    '    L112 812ddb5fe' + check,
    '    L121 1830f5210 pr commit',
    '    L121 26387bc83' + check,
    '  body: Self-test report none',
    '  body: counts checked: files-changed phrases only (changedFiles 2)',
  ]);
});

test('2u4 body: every token class, uppercase and duplicate tokens, ignored runs, a comment-hidden block, STALE and a files-changed mismatch', (t) => {
  const r = runThroughStub(t, ['--body', '900048']);
  assert.equal(r.status, 0, r.stderr);
  noRefusal(r);
  const head = 'aaaa048' + '0'.repeat(33);
  assert.deepEqual(bodyBlock(r.stdout), [
    '  body: shas 2 head, 1 base, 3 pr commit, 3 former head, 1 earlier commit, 1 ambiguous, 1 unresolved ' + BODY_TAIL.replace('%s', 'aaaa04800'),
    '    L2 cccc04800 pr commit',
    '    L2 cccc048 pr commit',
    '    L3 dddd048 ambiguous',
    '    L3 eeee048 former head',
    '    L3 ffff048000 former head',
    '    L3 abab0480 earlier commit',
    '    L4 deadbee unresolved (may be an older base or an unrelated commit: check)',
    '    L4 cccc04800 pr commit',
    '    L14 eeee048000000000000000000000000000000000 former head',
    `  body: Self-test report STALE (head_sha EEEE048000000000000000000000000000000000, head ${head})`,
    '  body: counts checked: files-changed phrases only (changedFiles 2)',
    '    L5 "3 files changed" says 3',
  ]);
  assert.ok(!/1234567890|a{41}/.test(bodyBlock(r.stdout).join('\n')), 'an all-digit token and a 41-hex run are not tokens');
});

test('2u4 body: an empty body is all zero with Self-test none; a json block that is not JSON reads unparsable', (t) => {
  const empty = runThroughStub(t, ['--body', '900046']);
  noRefusal(empty);
  assert.deepEqual(bodyBlock(empty.stdout), [
    '  body: shas 0 head, 0 base, 0 pr commit, 0 former head, 0 earlier commit, 0 ambiguous, 0 unresolved ' + BODY_TAIL.replace('%s', '5a5a04600'),
    '  body: no token names the head 5a5a04600',
    '  body: Self-test report none',
    '  body: counts checked: files-changed phrases only (changedFiles 1)',
  ]);
  const bad = runThroughStub(t, ['--body', '900049']);
  noRefusal(bad);
  assert.ok(bodyBlock(bad.stdout).includes('  body: Self-test report unparsable JSON'), bad.stdout);
});

test('2u4 body: failed timeline, inline and body reads print three unknown lines and the exit code stays 0', (t) => {
  const r = runThroughStub(t, ['--cr', '--body', '900047']);
  assert.equal(r.status, 0, r.stderr);
  noRefusal(r);
  const unknown = r.stdout.split('\n').filter((l) => /unknown \(read failed: /.test(l));
  assert.deepEqual(unknown, [
    '  cr: inline unknown (read failed: gh: Server Error (HTTP 503))',
    '  cr: activity and rerequest unknown (read failed: gh: Server Error (HTTP 502))',
    '  body: unknown (read failed: gh: Server Error (HTTP 504))',
  ]);
});

test('2u4 body: a body read that succeeds while the timeline read fails says which classes could not be known', () => {
  const fx = loadFixture('body-classes-synthetic.json');
  const b = prStatus.deriveBody({ view: fx.view, reviews: fx.reviews, timeline: null, timelineError: 'gh: boom', bodyView: fx.bodyView });
  const lines = prStatus.bodyLines(b);
  assert.ok(lines.includes('  body: timeline unknown (read failed: gh: boom); former heads come from the reviews only and earlier commits are not known'), lines.join('\n'));
  assert.equal(b.counts['earlier commit'], 0);
});

test('2u4 body: a sha known in several roles takes the first class in the order head, base, pr commit, former head, earlier commit', () => {
  const h = 'a'.repeat(40);
  const c = 'c'.repeat(40);
  const known = prStatus.knownShas({
    view: { headRefOid: h.toUpperCase(), commits: [{ oid: c }, { oid: h }] },
    reviews: [[{ commit_id: c }]],
    timeline: [{ event: 'head_ref_force_pushed', commit_id: h }, { event: 'committed', sha: c }],
    baseRefOid: 'b'.repeat(40),
  });
  assert.equal(known.get(h), 'head');
  assert.equal(known.get(c), 'pr commit');
  assert.equal(known.get('b'.repeat(40)), 'base');
  const { tokens } = prStatus.classifyBodyShas(`x ${'A'.repeat(9)} ${'c'.repeat(7)}\n${'c'.repeat(7)} ${'c'.repeat(7)} 9999999`, known);
  assert.deepEqual(tokens, [
    { line: 1, token: 'aaaaaaaaa', cls: 'head' },
    { line: 1, token: 'ccccccc', cls: 'pr commit' },
    { line: 2, token: 'ccccccc', cls: 'pr commit' },
  ]);
});

test('2u4 body: the Self-test extraction follows upstream (heading of any level, ** removed, fence-aware, comments skipped, first complete block)', () => {
  const H = 'f'.repeat(40);
  const st = (body) => prStatus.selfTestBinding(body, H).status;
  assert.equal(st('no heading\n```json\n{"head_sha":"' + H + '"}\n```'), 'none');
  assert.equal(st('## Self-test report\n```json\n{"head_sha":"' + H + '"}'), 'none', 'an unclosed block is not complete');
  assert.equal(st('## Self-test report\ntext\n## Next\n```json\n{"head_sha":"' + H + '"}\n```'), 'none', 'the section ends at a same-level heading');
  assert.equal(st('## Self-test report\n### Detail\n```json title="r"\n{"head_sha":"' + H.toUpperCase() + '"}\n```'), 'bound', 'a deeper heading stays in the section; head_sha compares case-insensitively');
  assert.equal(st('### **Self-test Report** ###\n```sh\n# not a heading\n```\n```json\n{"head_sha":"' + H + '"}\n```'), 'bound', 'bold, closing hashes, a # inside a non-json fence');
  assert.equal(st('## Self-test report\n<!--\n```json\n{"head_sha":"' + H + '"}\n```\n-->\n'), 'none', 'a block inside an HTML comment is skipped');
  assert.equal(st('## Self-test report\n```json\n{"schema":1}\n```'), 'no-head-sha');
  assert.deepEqual(prStatus.selfTestBinding('## Self-test report\n~~~json\n{"head_sha":"abc"}\n~~~', H), { status: 'stale', headSha: 'abc' });
});

test('2u4 body: --json carries body (null without the flag) with counts, tokens, selfTest and the files-changed mismatches', (t) => {
  const offRun = runThroughStub(t, ['--json', '900048']);
  noRefusal(offRun);
  assert.equal(JSON.parse(offRun.stdout)[0].body, null);
  const onRun = runThroughStub(t, ['--json', '--body', '900048']);
  noRefusal(onRun);
  const [d] = JSON.parse(onRun.stdout);
  assert.equal(d.body.counts.ambiguous, 1);
  assert.equal(d.body.selfTest.status, 'stale');
  assert.equal(d.body.changedFiles, 2);
  assert.deepEqual(d.body.filesChanged, [{ line: 5, phrase: '3 files changed', n: 3 }]);
});

test('2u4 reads: --cr --body on 900043 makes exactly one timeline read, one inline read for 5608091717 and one body view', (t) => {
  const r = runThroughStub(t, ['--cr', '--body', '900043']);
  assert.equal(r.status, 0, r.stderr);
  noRefusal(r);
  const calls = r.log.map((l) => JSON.parse(l));
  assert.equal(calls.filter((c) => c.some((a) => a.includes('/timeline'))).length, 1);
  assert.deepEqual(calls.filter((c) => c.some((a) => a.includes('/comments'))), [['api', '--paginate', '--slurp', 'repos/open-gsd/gsd-core/pulls/900043/reviews/5608091717/comments?per_page=100']]);
  assert.equal(calls.filter((c) => c.includes('body,baseRefOid,changedFiles')).length, 1);
  assert.equal(r.stdout.split(CR_FOOTER).length - 1, 1, 'the R8 line prints once');
});

test('2u4 idempotency: two runs with --cr --body print byte-identical output and log the same GET reads, none refused', (t) => {
  const args = ['--cr', '--body', '900043', '900044', '900045', '900048'];
  const a = runThroughStub(t, args);
  const b = runThroughStub(t, args);
  assert.equal(a.status, 0, a.stderr);
  assert.equal(a.stdout, b.stdout);
  assert.deepEqual(a.log, b.log);
  noRefusal(a);
  for (const l of a.log) {
    const call = JSON.parse(l);
    assert.ok(['pr view', 'pr checks'].includes(call.slice(0, 2).join(' ')) || call[0] === 'api', `read-only verb: ${l}`);
  }
});

test('2u4 rerequest: a review consumes a request only when submitted strictly later than the request (equal time does not)', () => {
  const view = { headRefOid: 'h'.repeat(40), author: { login: 'author' }, reviewRequests: [] };
  const req = { event: 'review_requested', created_at: '2026-10-21T10:00:00Z', actor: { login: 'author' }, requested_reviewer: { login: 'trek-e' } };
  const review = (t) => [[{ id: 1, user: { login: 'trek-e', type: 'User' }, state: 'CHANGES_REQUESTED', submitted_at: t, commit_id: 'c'.repeat(40) }]];
  const [same] = prStatus.deriveRerequests(view, review('2026-10-21T10:00:00Z'), [req]);
  assert.equal(same.ending.kind, 'open', 'a review at the request time does not consume it');
  const [later] = prStatus.deriveRerequests(view, review('2026-10-21T10:00:01Z'), [req]);
  assert.deepEqual(later.ending, { kind: 'consumed', id: '1', state: 'CHANGES_REQUESTED', time: '2026-10-21T10:00:01Z' });
  assert.equal(later.needed, true);
});

// --- quick 261028-owj: pr-status models three gsd-core CI checks (base health, reviewed or maintainer, self-test) ---
//
// Verdict tests inject the policy modules (deps.policies) so they run on any machine; the fakes below only
// have the exported shape of the live scripts (enough to drive pr-status's wiring and rendering). Two tests
// read the LIVE gsd-core scripts (the selfTestBlock parity check and the fixture verdicts) and skip, with a
// named reason, when no checkout resolves.

const CI_HEAD = 'b7c0ffee00000000000000000000000000000001';
const CI_BASE_SHA = 'ba5e000000000000000000000000000000000abc';
const CI_RUN_SHA = 'dead00000000000000000000000000000000beef';

function fakePolicies(over = {}) {
  const calls = { classify: [], reviewed: [], selfTest: [] };
  const ci = {
    VERDICT: { CLEAN: 'CLEAN', RED: 'RED', BYPASSED: 'BYPASSED', SKIPPED_NOT_APPLICABLE: 'SKIPPED_NOT_APPLICABLE', INDETERMINATE: 'INDETERMINATE' },
    BYPASS_LABEL: 'fix-next',
    TESTS_WORKFLOW_FILE: 'test.yml',
    classifyBaseRuns(payload) {
      calls.classify.push(JSON.parse(JSON.stringify(payload)));
      const runs = payload && payload.workflow_runs;
      if (!Array.isArray(runs)) return { verdict: 'INDETERMINATE', run: null, reason: 'malformed-payload' };
      if (runs.length === 0) return { verdict: 'CLEAN', run: null, reason: 'resolved' };
      const n = runs[0];
      if (n.status !== 'completed') {
        const prior = n.previous_attempt_conclusion;
        if (typeof prior === 'string' && prior !== 'success') return { verdict: 'RED', run: n, reason: 'rerun-in-flight-after-failure' };
        return { verdict: 'CLEAN', run: n, reason: 'newest-in-flight' };
      }
      return { verdict: n.conclusion === 'success' ? 'CLEAN' : 'RED', run: n, reason: 'resolved' };
    },
  };
  const reviewed = {
    REASON: {},
    APPROVER_ROLES: new Set(['write', 'maintain', 'admin']),
    parseMaintainers(text) {
      const logins = new Set(String(text).split(/\r?\n/).map((l) => l.replace(/#.*$/, '').trim().toLowerCase()).filter(Boolean));
      return { ok: logins.size > 0, logins, invalid: [] };
    },
    evaluateReviewed(input) {
      calls.reviewed.push(input);
      const author = input.authorLogin.toLowerCase();
      if (input.maintainers.has(author)) return { ok: true, reason: 'ok_maintainer_author' };
      const standing = new Map();
      for (const r of input.reviews) standing.set(r.user.login.toLowerCase(), r);
      let stale = false;
      for (const [login, r] of standing) {
        if (login === author || r.state !== 'APPROVED') continue;
        if (!['write', 'maintain', 'admin'].includes(input.roles[login])) continue;
        if (r.commit_id === input.headSha) return { ok: true, reason: 'ok_approved' };
        stale = true;
      }
      return { ok: false, reason: stale ? 'fail_stale_approval_only' : 'fail_no_approval' };
    },
  };
  const selfTest = {
    REASON: {},
    evaluateSelfTestReport(input) {
      calls.selfTest.push(input);
      return over.selfTest ? over.selfTest(input) : { ok: true, reason: 'ok_report', problems: [] };
    },
  };
  return { ciNextHealth: ci, reviewedOrMaintainer: reviewed, selfTestReport: selfTest, root: '/fake/gsd-core', head: 'f'.repeat(40), calls };
}

/**
 * Run runCli IN PROCESS (deps.policies injected) with the stub gh first on PATH. The stub and its env are
 * the same ones the process tests use; the environment is restored before returning.
 */
function runInProc(t, args, opts = {}) {
  const stub = makeStub(t);
  const keys = ['PATH', 'PR_STATUS_STUB_FIXTURES', 'PR_STATUS_STUB_LOG', 'PR_STATUS_STUB_QUEUE', 'HOME', 'GSD_CORE_ROOT'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  process.env.PATH = stub.bin + path.delimiter + process.env.PATH;
  process.env.PR_STATUS_STUB_FIXTURES = FIXTURES_DIR;
  process.env.PR_STATUS_STUB_LOG = stub.logFile;
  process.env.HOME = stub.home;
  delete process.env.GSD_CORE_ROOT;
  if (opts.queue) process.env.PR_STATUS_STUB_QUEUE = path.join(QUEUE_DIR, opts.queue);
  else delete process.env.PR_STATUS_STUB_QUEUE;
  let stdout = '';
  let stderr = '';
  let status;
  try {
    status = prStatus.runCli(args, {
      stdout: { write: (x) => { stdout += x; } },
      stderr: { write: (x) => { stderr += x; } },
      sleep: () => {},
      policies: opts.policies,
      policyRoot: opts.policyRoot,
    });
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
  const log = fs.readFileSync(stub.logFile, 'utf8').split('\n').filter(Boolean);
  return { status, stdout, stderr, log };
}

const calls = (r) => r.log.map((l) => JSON.parse(l));
const apiPaths = (r, re) => calls(r).filter((c) => c[0] === 'api').map((c) => c.find((a) => a.startsWith('repos/'))).filter((p) => re.test(p));

test('owj base: a red base with no fix-next is not author work; the base line names the red run sha', (t) => {
  const pol = fakePolicies();
  const r = runInProc(t, ['900061'], { queue: 'ci-base-red.json', policies: pol });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^ {2}policies: LIVE gsd-core scripts at \/fake\/gsd-core HEAD fffffffff$/m);
  assert.match(
    r.stdout,
    new RegExp(`^ {2}base: next RED \\(Tests run on ${CI_RUN_SHA.slice(0, 12)}, conclusion failure, reason resolved\\) https://github\\.com/open-gsd/gsd-core/actions/runs/880001; Required tests red is base health, not this PR \\(fix-next: absent\\)$`, 'm')
  );
  assert.doesNotMatch(r.stdout, /ball: AUTHOR/, 'a red base is never author work');
  assert.match(r.stdout, /^ {2}ball: MAINTAINER not ready \(approved but blocked: base next red: wait for a fix-forward, or fix-next if this PR is the fix\)$/m);
  assert.ok(!r.log.some((l) => l.startsWith('REFUSED')), r.log.join(' | '));
  assert.deepEqual(apiPaths(r, /actions\/workflows/), [`repos/open-gsd/gsd-core/actions/workflows/test.yml/runs?branch=next&event=push&per_page=5`]);
  for (const c of calls(r)) assert.ok(!c.some((a) => /^(-X|--method|-f|-F|--field|--input)/.test(a)) && !c.some((a) => /graphql/i.test(a)), `read-only: ${c.join(' ')}`);
});

test('owj base: --json carries the policies verdicts and the ball is the maintainer', (t) => {
  const r = runInProc(t, ['--json', '900061'], { queue: 'ci-base-red.json', policies: fakePolicies() });
  const d = JSON.parse(r.stdout)[0];
  assert.equal(d.ball.owner, 'maintainer');
  assert.equal(d.policies.base.status, 'red');
  assert.equal(d.policies.base.fixNext, 'absent');
  assert.equal(d.policies.base.run.sha, CI_RUN_SHA);
  assert.equal(d.policies.source.root, '/fake/gsd-core');
});

test('owj base: the fix-next label is named present; Required tests red stays author-side when Base branch health passes', (t) => {
  const r = runInProc(t, ['900062'], { queue: 'ci-base-red.json', policies: fakePolicies() });
  assert.match(r.stdout, /^ {2}base: next RED .*\(fix-next: present\)$/m);
  assert.match(r.stdout, /^ {2}ball: AUTHOR owes fixes \(approved but blocked: checks failing\)$/m);
});

test('owj base: Required tests red with another Tests job also red stays author-side and names the job', (t) => {
  const r = runInProc(t, ['900063'], { queue: 'ci-base-red.json', policies: fakePolicies() });
  assert.match(r.stdout, /^ {2}base: next RED .*; Required tests red is not only base health: also failing test \(windows-latest, 24, shard 2\/3\) \(fix-next: absent\)$/m);
  assert.match(r.stdout, /^ {2}ball: AUTHOR owes fixes /m);
});

test('owj base: a green live base is said so; a captured fixture without labels reads fix-next unknown', (t) => {
  const green = runInProc(t, ['900061'], { queue: 'ci-base-green.json', policies: fakePolicies() });
  assert.match(green.stdout, /^ {2}base: next green now /m);
  const old = runInProc(t, ['5153'], { policies: fakePolicies() });
  assert.match(old.stdout, /^ {2}base: next green now .*\(fix-next: unknown\)$/m, 'a view without labels is unknown, never absent');
});

test('owj base: an in-flight re-run reads the previous attempt and hands it to classifyBaseRuns', (t) => {
  const pol = fakePolicies();
  const r = runInProc(t, ['900061'], { queue: 'ci-base-rerun.json', policies: pol });
  assert.deepEqual(apiPaths(r, /attempts/), ['repos/open-gsd/gsd-core/actions/runs/880001/attempts/1']);
  assert.equal(pol.calls.classify[0].workflow_runs[0].previous_attempt_conclusion, 'failure');
  assert.match(r.stdout, /^ {2}base: next RED \(Tests run on dead00000000, conclusion in_progress, reason rerun-in-flight-after-failure\)/m);
});

test('owj base: a failed runs read is unknown with the error named, the PR block and exit code unaffected', (t) => {
  const bad = runInProc(t, ['900061'], { queue: 'ci-runs-fail.json', policies: fakePolicies() });
  assert.equal(bad.status, 0, bad.stderr);
  assert.match(bad.stdout, /^ {2}base: next unknown \(.*runs read failed.*\)/m);
});

test('owj base: the base runs are read once per repo and base across PRs', (t) => {
  const r = runInProc(t, ['900061', '900063'], { queue: 'ci-base-red.json', policies: fakePolicies() });
  assert.equal(apiPaths(r, /actions\/workflows/).length, 1);
});

test('owj reviewed: an author listed in MAINTAINERS is ok_maintainer_author with no permission read; MAINTAINERS is read at the base sha', (t) => {
  const r = runInProc(t, ['900064'], { queue: 'ci-policies.json', policies: fakePolicies() });
  assert.match(r.stdout, /^ {2}reviewed-or-maintainer: green \(ok_maintainer_author\)$/m);
  assert.deepEqual(apiPaths(r, /collaborators/), []);
  assert.deepEqual(apiPaths(r, /contents/), [`repos/open-gsd/gsd-core/contents/.github/MAINTAINERS?ref=${CI_BASE_SHA}`]);
});

test('owj reviewed: a current-head approval by a write user is ok_approved by that login; the policy gets complete input', (t) => {
  const pol = fakePolicies();
  const r = runInProc(t, ['900065'], { queue: 'ci-policies.json', policies: pol });
  assert.match(r.stdout, /^ {2}reviewed-or-maintainer: green \(ok_approved by alice\)$/m);
  assert.deepEqual(apiPaths(r, /collaborators/), ['repos/open-gsd/gsd-core/collaborators/alice/permission']);
  const input = pol.calls.reviewed[0];
  assert.equal(input.authorLogin, 'contrib-a');
  assert.equal(input.headSha, CI_HEAD);
  assert.equal(input.reviewsComplete, true);
  assert.deepEqual(input.roles, { alice: 'write' });
  assert.deepEqual([...input.maintainers], ['maint-m']);
  assert.equal(input.reviews.length, 1);
});

test('owj reviewed: an approval on an older commit is red fail_stale_approval_only, labelled reviewer-side, never author work', (t) => {
  const r = runInProc(t, ['900066'], { queue: 'ci-policies.json', policies: fakePolicies() });
  assert.match(r.stdout, /^ {2}reviewed-or-maintainer: red \(fail_stale_approval_only: .*\); reviewer-side, not author work$/m);
  assert.doesNotMatch(r.stdout, /ball: AUTHOR/);
  assert.match(r.stdout, /^ {2}ball: REVIEWER owes a review \(approved but blocked: approval on an older commit, Reviewed or maintainer red \(reviewer-side\)\)$/m);
});

test('owj reviewed: a failed permission read makes the verdict unknown and the policy is not called with partial roles', (t) => {
  const pol = fakePolicies();
  const r = runInProc(t, ['900065'], { queue: 'ci-permission-fail.json', policies: pol });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^ {2}reviewed-or-maintainer: unknown \(.*alice.*HTTP 403.*\)$/m);
  assert.equal(pol.calls.reviewed.length, 0);
});

test('owj reviewed: an unreadable MAINTAINERS file is unknown, not the policy reason', (t) => {
  const pol = fakePolicies();
  const r = runInProc(t, ['900065'], { policies: pol });
  assert.match(r.stdout, /^ {2}reviewed-or-maintainer: unknown \(MAINTAINERS read failed: .*\)$/m);
  assert.equal(pol.calls.reviewed.length, 0);
});

test('owj reviewed: MAINTAINERS and permissions are read once per repo across PRs', (t) => {
  const r = runInProc(t, ['900065', '900066'], { queue: 'ci-policies.json', policies: fakePolicies() });
  assert.equal(apiPaths(r, /contents/).length, 1);
  assert.equal(apiPaths(r, /collaborators/).length, 1);
});

test('owj self-test: fail_suite_not_passed is printed as advisory (never a defect) and the PR stays MAINTAINER ready', (t) => {
  const pol = fakePolicies({ selfTest: () => ({ ok: false, reason: 'fail_suite_not_passed', problems: ['the full suite must have passed'] }) });
  const r = runInProc(t, ['--body', '900067'], { queue: 'ci-policies.json', policies: pol });
  assert.match(r.stdout, /^ {2}self-test: red \(fail_suite_not_passed: advisory; the full suite did not pass with 0 failures, e\.g\. a known environment failure\)$/m);
  assert.doesNotMatch(r.stdout, /defect/i);
  assert.match(r.stdout, /^ {2}ball: MAINTAINER ready \(.*advisory red: Self-test report fail_suite_not_passed.*\)$/m);
  assert.doesNotMatch(r.stdout, /ball:.*checks green/, 'a ready line must not claim every check is green');
  const input = pol.calls.selfTest[0];
  assert.equal(input.headRef, 'fix/synthetic');
  assert.equal(input.title, 'fix: synthetic change');
  assert.equal(input.authorLogin, 'contrib-a');
  assert.equal(input.headSha, CI_HEAD);
  assert.deepEqual([...input.maintainers], ['maint-m']);
  assert.match(input.body, /## Self-test report/);
});

test('owj self-test: ok_report is green; fail_stale_sha and fail_malformed_json print the policy reason and its first problem', (t) => {
  const bodyOf = (n) => JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, n), 'utf8')).bodyView.body;
  const pol = fakePolicies({
    selfTest: (input) => {
      if (input.body === bodyOf('ci-selftest-ok.json')) return { ok: true, reason: 'ok_report', problems: [] };
      if (input.body === bodyOf('ci-selftest-stale.json')) return { ok: false, reason: 'fail_stale_sha', problems: ['head_sha is not the PR current head'] };
      return { ok: false, reason: 'fail_malformed_json', problems: ['the report is not valid JSON: Unexpected end'] };
    },
  });
  const r = runInProc(t, ['--body', '900068', '900069', '900070'], { queue: 'ci-policies.json', policies: pol });
  assert.match(r.stdout, /^ {2}self-test: green \(ok_report\)$/m);
  assert.match(r.stdout, /^ {2}self-test: red \(fail_stale_sha: head_sha is not the PR current head\)$/m);
  assert.match(r.stdout, /^ {2}self-test: red \(fail_malformed_json: the report is not valid JSON: Unexpected end\)$/m);
});

test('owj self-test: without --body a red Self-test report says to run with --body and the policy is not called', (t) => {
  const pol = fakePolicies();
  const r = runInProc(t, ['900067'], { queue: 'ci-policies.json', policies: pol });
  assert.match(r.stdout, /^ {2}self-test: red \(run with --body for the reason\)$/m);
  assert.match(r.stdout, /^ {2}ball: MAINTAINER ready \(.*advisory red: Self-test report \(run with --body for the reason\).*\)$/m);
  assert.equal(pol.calls.selfTest.length, 0);
});

test('owj self-test: a view without headRefName/title reads unknown, never ok_not_a_fix', (t) => {
  const stripped = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-status-owj-'));
  t.after(() => fs.rmSync(stripped, { recursive: true, force: true }));
  const fx = loadFixture('ci-selftest-suite-failed.json');
  delete fx.view.headRefName;
  delete fx.view.title;
  fs.writeFileSync(path.join(stripped, 'x.json'), JSON.stringify(fx));
  // runInProc pins FIXTURES_DIR, so the alternate fixtures dir goes through the process runner, with the
  // LIVE scripts when a checkout resolves (the in-process fakes cannot be injected there).
  const root = liveRoot();
  if (!root) return t.skip('no gsd-core checkout resolvable (set GSD_CORE_ROOT or clone ~/repos/gsd-core)');
  const r = runThroughStub(t, ['--body', '900067'], { fixturesDir: stripped, queue: 'ci-policies.json', env: { GSD_CORE_ROOT: root } });
  assert.match(r.stdout, /^ {2}self-test: unknown \(.*headRefName.*\)$/m);
  assert.doesNotMatch(r.stdout, /ok_not_a_fix/);
});

test('owj policies: no resolvable gsd-core checkout prints policies unknown, every verdict unknown, exit 0, ball unchanged', (t) => {
  const r = runThroughStub(t, ['--body', '900061', '900065'], { queue: 'ci-policies.json' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^ {2}policies: unknown \(.*\)$/m);
  assert.match(r.stdout, /^ {2}base: next unknown \(/m);
  assert.match(r.stdout, /^ {2}reviewed-or-maintainer: unknown \(/m);
  assert.doesNotMatch(r.stdout, /ball: AUTHOR/);
  assert.ok(/^[\t\n\x20-\x7e]*$/.test(r.stdout), 'ASCII even for a loader error message');
  assert.ok(!r.log.some((l) => l.startsWith('REFUSED')));
  assert.equal(r.log.map((l) => JSON.parse(l)).filter((c) => c[0] === 'api' && c.some((a) => /actions|contents|collaborators/.test(a))).length, 0, 'no policy read without a loaded policy');
});

test('owj policies: a PR with none of the four checks prints no policies lines and makes no policy read', (t) => {
  const r = runInProc(t, ['5235'], { policies: fakePolicies() });
  assert.doesNotMatch(r.stdout, /policies:|base:|reviewed-or-maintainer:|self-test:/);
  assert.equal(apiPaths(r, /actions|contents|collaborators/).length, 0);
});

test('owj policies: the footer names the policy reads only when a block consulted them', (t) => {
  const withPolicies = runInProc(t, ['900061'], { queue: 'ci-base-red.json', policies: fakePolicies() });
  assert.match(withPolicies.stdout, /Policy lines \(/);
  assert.ok(withPolicies.stdout.includes(FOOTER_START), 'the main footer is unchanged');
  const without = runInProc(t, ['5235'], { policies: fakePolicies() });
  assert.doesNotMatch(without.stdout, /Policy lines \(/);
});

// --- selfTestBlock versus the LIVE extractReport (drift check) ---

function liveRoot() {
  const { resolveGsdCoreRoot } = require('../hooks/lib/resolve.cjs');
  const candidates = [process.env.GSD_CORE_ROOT, path.join(os.homedir(), 'repos', 'gsd-core')].filter(Boolean);
  for (const c of candidates) {
    try {
      return resolveGsdCoreRoot(c);
    } catch {
      // try the next candidate
    }
  }
  return null;
}

test('owj parity: selfTestBlock equals the LIVE extractReport over every fixture body and synthetic bodies', (t) => {
  const root = liveRoot();
  if (!root) return t.skip('no gsd-core checkout resolvable (set GSD_CORE_ROOT or clone ~/repos/gsd-core)');
  const { requireLiveScript } = require('../hooks/lib/resolve.cjs');
  const live = requireLiveScript(root, 'scripts/self-test-report-policy.cjs');
  const fence = '`'.repeat(3);
  const synthetic = [
    '',
    'no section at all',
    `## Self-test report\n\n${fence}json\n{"a":1}\n${fence}\n`,
    `### Self-test report\n${fence}json\n{"a":1}\n${fence}\n`,
    `## **Self-test report**\n${fence}JSON title="x"\n{"a":1}\n${fence}\n`,
    `## Self-test report\n\n${fence}text\nnot json\n${fence}\n\n${fence}json\n{"b":2}\n${fence}\n`,
    `## Self-test report\n\n<!--\n${fence}json\n{"hidden":1}\n${fence}\n-->\n${fence}json\n{"shown":1}\n${fence}\n`,
    `## Self-test report\n\n## Other\n\n${fence}json\n{"late":1}\n${fence}\n`,
    `## Self-test report\n\n${fence}json\n# not a heading\n{"c":3}\n${fence}\n`,
    `## Self-test report\r\n\r\n${fence}json\r\n{"crlf":1}\r\n${fence}\r\n`,
    `## Self-test report\n\n${fence}json\n{"unterminated":1}\n`,
    `~~~json\n{"before":1}\n~~~\n## Self-test report\n\n~~~json\n{"tilde":1}\n~~~\n`,
    `## Self-test report\n\n${fence}${fence.slice(0, 1)}json\n{"four":1}\n${fence}${fence.slice(0, 1)}\n`,
    `# Self-test report #\n${fence}json\n{"closed-heading":1}\n${fence}\n`,
    `## Self-test report\n\n${' '.repeat(2000)}${fence}json\n{"wide":1}\n${fence}\n`,
  ];
  const bodies = [...synthetic];
  for (const f of ALL_FIXTURES) {
    const fx = loadFixture(f);
    if (fx.bodyView && typeof fx.bodyView.body === 'string') bodies.push(fx.bodyView.body);
  }
  assert.ok(bodies.length > synthetic.length, 'the fixtures contribute bodies (non-vacuous)');
  assert.ok(bodies.some((b) => live.extractReport(b).found), 'at least one body holds a report the live script finds (non-vacuous)');
  assert.ok(bodies.some((b) => !live.extractReport(b).found), 'at least one body holds none');
  for (const b of bodies) {
    const r = live.extractReport(b);
    assert.equal(prStatus.selfTestBlock(b), r.found ? r.json : null, `body: ${JSON.stringify(b.slice(0, 80))}`);
  }
});

test('owj live: the LIVE gsd-core scripts give the hand-derived verdicts on the owj fixtures', (t) => {
  const root = liveRoot();
  if (!root) return t.skip('no gsd-core checkout resolvable (set GSD_CORE_ROOT or clone ~/repos/gsd-core)');
  const r = runInProc(t, ['--json', '--body', '900061', '900064', '900065', '900066', '900067', '900068', '900069', '900070'], { queue: 'ci-policies.json', policyRoot: root });
  assert.equal(r.status, 0, r.stderr);
  const by = Object.fromEntries(JSON.parse(r.stdout).map((d) => [d.number, d]));
  assert.equal(by[900061].policies.source.status, 'live');
  assert.equal(by[900061].policies.base.status, 'green', 'ci-policies.json holds no baseRuns, so the live base reads clean');
  assert.equal(by[900064].policies.reviewed.reason, 'ok_maintainer_author');
  assert.equal(by[900065].policies.reviewed.reason, 'ok_approved');
  assert.equal(by[900065].policies.reviewed.approver, 'alice');
  assert.equal(by[900066].policies.reviewed.reason, 'fail_stale_approval_only');
  assert.equal(by[900067].policies.selfTest.reason, 'fail_suite_not_passed');
  assert.equal(by[900068].policies.selfTest.reason, 'ok_report');
  assert.equal(by[900069].policies.selfTest.reason, 'fail_stale_sha');
  assert.equal(by[900070].policies.selfTest.reason, 'fail_malformed_json');
});
