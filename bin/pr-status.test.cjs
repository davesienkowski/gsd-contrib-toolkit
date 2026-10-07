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
