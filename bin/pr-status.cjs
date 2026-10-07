#!/usr/bin/env node
'use strict';

/**
 * bin/pr-status.cjs — read-only PR snapshot and ball-in-court for the maintainer review sweep.
 *
 * Why: the sweep (skills/maintainer-review-sweep) re-derived PR state and ball-in-court by hand from
 * prose ("re-fetch live state"), which is where stale-snapshot and wrong-ball mistakes came from
 * (collab audit 2026-10-07 rec 8; dev-env quick 261007-fnu). This prints that snapshot per PR:
 * head SHA, mergeable + mergeStateStatus, the current checks, every reviewer's latest state with the
 * commit it was on, the requested reviewers and one ball line.
 *
 *   node bin/pr-status.cjs [--json] [--repo owner/name] <n...>
 *
 * Text output is plain ASCII (every GitHub-sourced string has C0 controls and DEL dropped and any
 * other non-ASCII character replaced by ?), PR blocks print in argv order and end with one footer:
 * the three reads per PR are not atomic, so the snapshot is point-in-time. `--json` prints an array
 * of derive() results (each with `repo`) in the same order. Every block header names the repo it read
 * (`owner/name#N`), so a sweep of another repo cannot silently read open-gsd/gsd-core. A PR whose read
 * fails prints `owner/name#N ERROR: <first stderr line>` and the exit code is 1; usage errors (including
 * PR number 0) exit 2; leading zeros are dropped before any gh call. mergeable UNKNOWN (GitHub still
 * computing) is re-read once after 2 s.
 *
 * CONTRACT — READ-ONLY gh only. Per PR three reads (four when mergeable is UNKNOWN: the view is read
 * twice), every one carrying the repo:
 *   1. gh pr view N --repo R --json <twelve fields>
 *   2. gh api --paginate --slurp "repos/R/pulls/N/reviews?per_page=100"   (REST GET; carries commit_id)
 *   3. gh pr checks N --repo R --json name,state,bucket,workflow,completedAt,link
 * No mutating verb (pr edit/review/merge/comment/close/ready), no `gh api -X/--method/-f/-F`, and no
 * `gh api graphql` (hooks/review-artifact.cjs gates GraphQL). statusCheckRollup is NOT used: it keeps
 * superseded runs, while `gh pr checks --json` returns the current run per check.
 *
 * BALL RULE: each reviewer's latest review by submitted_at (stable, so an equal timestamp keeps the
 * API order and the later-listed review wins), ignoring COMMENTED and PENDING reviews, the PR author
 * and bots. A DISMISSED review stays that reviewer's latest state but counts as no verdict.
 *   - The newest CHANGES_REQUESTED decides first. Its commit_id equal to headRefOid (exact 40-hex
 *     string) -> the author owes changes, unless that reviewer is back in reviewRequests (re-requested
 *     without a new commit) -> the reviewer owes. Any other commit -> that reviewer owes a re-review,
 *     flagged NOT RE-REQUESTED when absent from reviewRequests (login compared case-insensitively); when
 *     any team is requested membership cannot be resolved, so the flag is dropped and the team named.
 *   - An approval is MAINTAINER ready only when one approval is on the head, nobody is still requested,
 *     no check fails or is pending and mergeStateStatus is not DIRTY or BEHIND; otherwise the blockers
 *     are named and the ball goes to the author (failing checks, DIRTY, BEHIND), else the requested
 *     reviewers, else the maintainer (approval on an older commit, checks pending).
 *   - Only dismissed reviews and nobody requested -> maintainer, re-approval needed. Pending requests
 *     -> reviewer. Else none. A draft or non-OPEN PR gets no ball.
 * reviewDecision is a cross-check: when GitHub's value disagrees with this reading a note line says so.
 *
 * No shell: execFileSync with argv arrays; PR numbers are validated as digits. Node built-ins only.
 *
 * @module bin/pr-status
 */

const { execFileSync } = require('node:child_process');

const DEFAULT_REPO = 'open-gsd/gsd-core';
const VIEW_FIELDS =
  'number,state,isDraft,author,headRefOid,baseRefName,mergeable,mergeStateStatus,reviewDecision,reviewRequests,commits,updatedAt';
const CHECK_FIELDS = 'name,state,bucket,workflow,completedAt,link';
const BUCKETS = Object.freeze(['pass', 'fail', 'pending', 'skipping', 'cancel']);
const IGNORED_REVIEW_STATES = new Set(['COMMENTED', 'PENDING']);
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const USAGE = 'usage: pr-status [--json] [--repo owner/name] <pr-number...>  (default repo ' + DEFAULT_REPO + ')';
const FOOTER =
  'Snapshot is point-in-time (three separate gh reads per PR); re-run before any write. ' +
  'A change request answered without a new commit (retitle, comment) still reads as author owes unless ' +
  'the reviewer was re-requested: check the timeline.';
const MAX_BUFFER = 64 * 1024 * 1024; // review listings carry full bodies; 1 MiB (the default) is not enough
const UNKNOWN_RETRY_MS = 2000;

/** The three read-only argv arrays for one PR. */
function ghArgs(number, repo) {
  return {
    view: ['pr', 'view', String(number), '--repo', repo, '--json', VIEW_FIELDS],
    reviews: ['api', '--paginate', '--slurp', `repos/${repo}/pulls/${number}/reviews?per_page=100`],
    checks: ['pr', 'checks', String(number), '--repo', repo, '--json', CHECK_FIELDS],
  };
}

/** Default gh runner: no shell, stdout parsed as JSON; a non-zero exit throws the execFileSync error. */
function defaultGh(args) {
  const out = execFileSync('gh', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60000,
    maxBuffer: MAX_BUFFER,
  });
  return JSON.parse(out);
}

/** Default sleep: a synchronous wait, so the CLI stays a plain synchronous program. */
function defaultSleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Parse a string as a JSON array, or return null. */
function jsonArrayOrNull(text) {
  try {
    const v = JSON.parse(String(text || ''));
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * Read one PR through three read-only gh calls.
 *
 * @param {string|number} number PR number (digits)
 * @param {string} repo owner/name
 * @param {{gh?: Function, sleep?: Function}} [deps] injectable gh(args) runner returning parsed JSON, and sleep(ms)
 * @returns {{view: object, reviews: object[], checks: object[]}}
 */
function fetchPr(number, repo, deps = {}) {
  const gh = deps.gh || defaultGh;
  const args = ghArgs(number, repo);
  const sleep = deps.sleep || defaultSleep;
  let view = gh(args.view);
  if (view && view.mergeable === 'UNKNOWN') {
    // GitHub computes mergeability lazily after a push; one re-read, then report what it says.
    sleep(UNKNOWN_RETRY_MS);
    view = gh(args.view);
  }
  const pages = gh(args.reviews);
  const reviews = Array.isArray(pages) ? pages.flat() : [];
  let checks;
  try {
    checks = gh(args.checks);
  } catch (err) {
    // Some gh versions exit 1 (a check failed) or 8 (checks pending) even with --json; the JSON
    // array on stdout is still the answer, never an error.
    const arr = err && (err.status === 1 || err.status === 8) ? jsonArrayOrNull(err.stdout) : null;
    if (arr) checks = arr;
    else if (err && /no checks reported/i.test(String(err.stderr || ''))) checks = [];
    else throw err;
  }
  return { view, reviews, checks: Array.isArray(checks) ? checks : [] };
}

function lower(s) {
  return String(s == null ? '' : s).toLowerCase();
}

function isTeam(r) {
  return Boolean(r) && (r.__typename === 'Team' || (!r.login && Boolean(r.slug || r.name)));
}

/** A review request as { kind: 'user'|'team', name } (a team by slug, else name, else login). */
function requestEntry(r) {
  if (!r) return null;
  if (isTeam(r)) {
    const name = r.slug || r.name || r.login || '';
    return name ? { kind: 'team', name: String(name) } : null;
  }
  return r.login ? { kind: 'user', name: String(r.login) } : null;
}

function summarizeChecks(checks) {
  const counts = { pass: 0, fail: 0, pending: 0, skipping: 0, cancel: 0 };
  const failing = [];
  const pending = [];
  for (const c of checks || []) {
    const b = c && c.bucket;
    if (Object.prototype.hasOwnProperty.call(counts, b)) counts[b] += 1;
    if (b === 'fail') failing.push(String(c.name));
    if (b === 'pending') pending.push(String(c.name));
  }
  failing.sort();
  pending.sort();
  return { total: (checks || []).length, counts, failing, pending };
}

/**
 * Pure verdict over the three reads.
 *
 * @param {{view: object, reviews: object[], checks: object[]}} input reviews may be flat or page-nested
 * @returns {object} snapshot with checks summary, reviewers, requested and ball
 */
function derive({ view, reviews, checks }) {
  const v = view || {};
  const head = String(v.headRefOid || '');
  const authorLogin = lower(v.author && v.author.login);
  const commits = Array.isArray(v.commits) ? v.commits : [];
  const last = commits.length ? commits[commits.length - 1] : null;
  const entries = (Array.isArray(v.reviewRequests) ? v.reviewRequests : []).map(requestEntry).filter(Boolean);
  const requested = entries.map((e) => (e.kind === 'team' ? `team ${e.name}` : e.name));
  const req = {
    users: new Set(entries.filter((e) => e.kind === 'user').map((e) => lower(e.name))),
    teams: entries.filter((e) => e.kind === 'team').map((e) => e.name),
    all: requested,
  };
  const checkSummary = summarizeChecks(checks);

  const flat = (Array.isArray(reviews) ? reviews : []).flat();
  const counted = flat
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => r && r.user && r.user.login)
    .filter(({ r }) => r.user.type !== 'Bot')
    .filter(({ r }) => lower(r.user.login) !== authorLogin)
    .filter(({ r }) => !IGNORED_REVIEW_STATES.has(r.state));
  // Stable sort by submitted_at: equal timestamps keep API order, so the later-listed review wins.
  counted.sort((a, b) => {
    const ta = String(a.r.submitted_at || '');
    const tb = String(b.r.submitted_at || '');
    if (ta < tb) return -1;
    if (ta > tb) return 1;
    return a.i - b.i;
  });
  const latest = new Map(); // lowercased login -> { review, order }
  counted.forEach(({ r }, order) => latest.set(lower(r.user.login), { r, order }));

  const reviewers = [...latest.values()]
    .map(({ r }) => ({
      login: String(r.user.login),
      state: String(r.state),
      commitId: String(r.commit_id || ''),
      submittedAt: String(r.submitted_at || ''),
      onHead: String(r.commit_id || '') === head && head !== '',
    }))
    .sort((a, b) => (a.login < b.login ? -1 : a.login > b.login ? 1 : 0));

  const ball = decideBall(v, latest, req, head, checkSummary);

  return {
    number: v.number,
    state: v.state,
    isDraft: Boolean(v.isDraft),
    head,
    base: v.baseRefName,
    mergeable: v.mergeable,
    mergeStateStatus: v.mergeStateStatus,
    lastCommit: last
      ? { oid: String(last.oid || ''), committedDate: String(last.committedDate || ''), headline: String(last.messageHeadline || '') }
      : null,
    checks: checkSummary,
    reviewers,
    requested,
    ball,
    reviewDecision: v.reviewDecision == null ? null : String(v.reviewDecision),
    decisionNote: decisionNote(v.reviewDecision, latest),
  };
}

/** GitHub's reviewDecision versus this reading; a note string when they disagree, else null. */
function decisionNote(reviewDecision, latest) {
  const decision = String(reviewDecision || '');
  if (!decision) return null;
  const states = [...latest.values()].map((e) => e.r.state);
  const reading = states.includes('CHANGES_REQUESTED') ? 'CHANGES_REQUESTED' : states.includes('APPROVED') ? 'APPROVED' : 'REVIEW_REQUIRED';
  return decision === reading ? null : `GitHub reviewDecision is ${decision}; pr-status reads ${reading}`;
}

function ballOf(owner, fields) {
  return Object.assign({ owner, login: null, reRequested: null, reason: '', ready: false, blockers: [] }, fields);
}

function decideBall(v, latest, req, head, checks) {
  if (v.state !== 'OPEN') return ballOf('n/a', { reason: `state ${v.state}` });
  if (v.isDraft) return ballOf('n/a', { reason: 'draft' });
  const entries = [...latest.values()];

  let newestCr = null;
  for (const entry of entries) {
    if (entry.r.state !== 'CHANGES_REQUESTED') continue;
    if (!newestCr || entry.order > newestCr.order) newestCr = entry;
  }
  if (newestCr) {
    const login = String(newestCr.r.user.login);
    const byLogin = req.users.has(lower(login));
    if (head !== '' && String(newestCr.r.commit_id || '') === head) {
      if (byLogin) return ballOf('reviewer', { login, reRequested: true, reason: 're-requested without a new commit' });
      return ballOf('author', { login, reason: 'newest change request is on the head' });
    }
    const reRequested = byLogin ? true : req.teams.length ? 'unknown' : false;
    return ballOf('reviewer', { login, reRequested, reason: 'the head moved after the change request' });
  }

  const approvals = entries.filter((e) => e.r.state === 'APPROVED');
  if (approvals.length) {
    const blockers = [];
    if (!approvals.some((e) => head !== '' && String(e.r.commit_id || '') === head)) blockers.push('approval on an older commit');
    if (req.all.length) blockers.push(`review requests pending (${req.all.join(', ')})`);
    if (checks.counts.fail > 0) blockers.push('checks failing');
    if (checks.counts.pending > 0) blockers.push('checks pending');
    if (v.mergeStateStatus === 'DIRTY') blockers.push('DIRTY (merge conflicts)');
    if (v.mergeStateStatus === 'BEHIND') blockers.push('BEHIND (base moved)');
    if (blockers.length === 0) return ballOf('maintainer', { ready: true, reason: 'ready for maintainer' });
    const authorOwes = checks.counts.fail > 0 || v.mergeStateStatus === 'DIRTY' || v.mergeStateStatus === 'BEHIND';
    const owner = authorOwes ? 'author' : req.all.length ? 'reviewer' : 'maintainer';
    return ballOf(owner, { blockers, reason: 'approved but blocked' });
  }

  const dismissed = entries.filter((e) => e.r.state === 'DISMISSED');
  if (req.all.length) return ballOf('reviewer', { reRequested: true, reason: 'requests pending' });
  if (dismissed.length) {
    const login = String(dismissed.sort((a, b) => b.order - a.order)[0].r.user.login);
    return ballOf('maintainer', { login, reason: 're-approval needed (review dismissed)' });
  }
  return ballOf('none', { reason: 'no change request, approval or review request' });
}

/** ASCII-only rendering of a GitHub-sourced string: drop C0 controls and DEL, other non-ASCII -> ?. */
function clean(s) {
  return String(s == null ? '' : s)
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/[^\x20-\x7e]/g, '?');
}

function short(sha, n) {
  return String(sha || '').slice(0, n) || '-';
}

function ballLine(d) {
  const b = d.ball;
  const blocked = () => `(approved but blocked: ${b.blockers.map(clean).join(', ')})`;
  if (b.owner === 'author' && b.blockers.length) return `  ball: AUTHOR owes fixes ${blocked()}`;
  if (b.owner === 'author') return `  ball: AUTHOR owes changes (newest CHANGES_REQUESTED by ${clean(b.login)} is on the head)`;
  if (b.owner === 'reviewer' && b.blockers.length) return `  ball: REVIEWER owes a review ${blocked()}`;
  if (b.owner === 'reviewer' && b.login && b.reason === 're-requested without a new commit') {
    return `  ball: REVIEWER ${clean(b.login)} owes a re-review (re-requested without a new commit)`;
  }
  if (b.owner === 'reviewer' && b.login) {
    const base = `  ball: REVIEWER ${clean(b.login)} owes a re-review (the head moved after the change request)`;
    if (b.reRequested === 'unknown') return `${base}; team requested: ${d.requested.filter((r) => r.startsWith('team ')).map((r) => clean(r.slice(5))).join(', ')}`;
    return base + (b.reRequested ? '' : ' NOT RE-REQUESTED');
  }
  if (b.owner === 'reviewer') return `  ball: REVIEWER owes a first review (requests pending: ${d.requested.map(clean).join(', ')})`;
  if (b.owner === 'maintainer' && b.ready) {
    return '  ball: MAINTAINER ready (approved on the head, no change request, no pending requests, checks green, not DIRTY or BEHIND)';
  }
  if (b.owner === 'maintainer' && b.blockers.length) return `  ball: MAINTAINER not ready ${blocked()}`;
  if (b.owner === 'maintainer') return `  ball: MAINTAINER re-approval needed (latest review by ${clean(b.login)} was dismissed; no review requested)`;
  if (b.owner === 'none') return '  ball: none (no change request, approval or pending review request)';
  return null; // n/a: draft or not OPEN prints its state and no ball
}

/**
 * Render one derive() result as ASCII text lines (no trailing newline).
 *
 * @param {object} d derive() result
 * @returns {string}
 */
function formatText(d) {
  const lines = [];
  const draft = d.isDraft ? ' DRAFT' : '';
  const repo = d.repo ? clean(d.repo) : '';
  lines.push(`${repo}#${clean(d.number)} ${clean(d.state)}${draft} head ${clean(short(d.head, 12))} base ${clean(d.base)}`);
  if (d.lastCommit) {
    const lc = d.lastCommit;
    lines.push(`  last commit: ${clean(short(lc.oid, 7))} ${clean(lc.committedDate)} ${clean(lc.headline)}`);
  }
  lines.push(`  merge: ${clean(d.mergeable)} / ${clean(d.mergeStateStatus)}`);
  const c = d.checks;
  if (c.total === 0) {
    lines.push('  checks: none');
  } else {
    lines.push(`  checks: ${c.total} total: ` + BUCKETS.map((b) => `${b} ${c.counts[b]}`).join(', '));
    if (c.failing.length) lines.push(`    failing: ${c.failing.map(clean).join(', ')}`);
    if (c.pending.length) lines.push(`    pending: ${c.pending.map(clean).join(', ')}`);
  }
  if (d.reviewers.length === 0) lines.push('  review: none');
  for (const r of d.reviewers) {
    const where = r.onHead ? 'head' : 'older commit';
    lines.push(`  review: ${clean(r.login)} ${clean(r.state)} on ${clean(short(r.commitId, 7))} (${where}) ${clean(r.submittedAt)}`);
  }
  lines.push(`  requested: ${d.requested.length ? d.requested.map(clean).join(', ') : 'none'}`);
  const bl = ballLine(d);
  if (bl) lines.push(bl);
  if (d.decisionNote) lines.push(`  note: ${clean(d.decisionNote)}`);
  return lines.join('\n');
}

/** First non-empty line of a gh failure (its stderr, else the error message). */
function firstErrorLine(err) {
  const text = String((err && err.stderr) || '').trim() || String((err && err.message) || err || 'unknown error');
  return text.split('\n').map((l) => l.trim()).find(Boolean) || 'unknown error';
}

/** Parse argv into { json, repo, numbers } or { usageError }. */
function parseArgs(argv) {
  let json = false;
  let repo = DEFAULT_REPO;
  const numbers = [];
  const list = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < list.length; i += 1) {
    const a = String(list[i]);
    if (a === '--json') json = true;
    else if (a === '--repo' || a.startsWith('--repo=')) {
      const value = a === '--repo' ? list[++i] : a.slice('--repo='.length);
      if (value == null || !REPO_PATTERN.test(String(value))) return { usageError: `bad --repo value: ${clean(value)}` };
      repo = String(value);
    } else if (/^[0-9]+$/.test(a)) {
      const n = a.replace(/^0+/, '');
      if (n === '') return { usageError: `PR number must be 1 or more: ${a}` };
      numbers.push(n);
    }
    else return { usageError: `not a PR number or flag: ${clean(a)}` };
  }
  if (numbers.length === 0) return { usageError: 'no PR number given' };
  return { json, repo, numbers };
}

/**
 * CLI entry. Returns the exit code: 0 ok, 1 when any PR read failed, 2 usage.
 *
 * @param {string[]} argv
 * @param {{gh?: Function, sleep?: Function, stdout?: {write: Function}, stderr?: {write: Function}}} [deps]
 * @returns {number}
 */
function runCli(argv, deps = {}) {
  const out = deps.stdout || process.stdout;
  const errOut = deps.stderr || process.stderr;
  const args = parseArgs(argv);
  if (args.usageError) {
    errOut.write(`pr-status: ${args.usageError}\n${USAGE}\n`);
    return 2;
  }
  let failed = false;
  const results = args.numbers.map((n) => {
    try {
      return { repo: args.repo, ...derive(fetchPr(n, args.repo, deps)) };
    } catch (err) {
      failed = true;
      return { repo: args.repo, number: Number(n), error: firstErrorLine(err) };
    }
  });
  if (args.json) {
    // ASCII on the wire too: non-ASCII characters become \uXXXX escapes (JSON.parse restores them).
    const ascii = JSON.stringify(results, null, 2).replace(/[\u007f-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
    out.write(ascii + '\n');
  } else {
    const blocks = results.map((d) => (d.error ? `${clean(d.repo)}#${clean(d.number)} ERROR: ${clean(d.error)}` : formatText(d)));
    out.write(blocks.join('\n\n') + '\n\n' + FOOTER + '\n');
  }
  return failed ? 1 : 0;
}

module.exports = { derive, fetchPr, formatText, runCli };

if (require.main === module) process.exitCode = runCli(process.argv.slice(2));
