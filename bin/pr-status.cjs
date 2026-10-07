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
 * of derive() results in the same order. A PR whose read fails prints `#N ERROR: <first stderr line>`
 * and the exit code is 1; usage errors exit 2. mergeable UNKNOWN (GitHub still computing) is re-read
 * once after 2 s.
 *
 * CONTRACT — READ-ONLY gh only. Per PR exactly three reads, every one carrying the repo:
 *   1. gh pr view N --repo R --json <twelve fields>
 *   2. gh api --paginate --slurp "repos/R/pulls/N/reviews?per_page=100"   (REST GET; carries commit_id)
 *   3. gh pr checks N --repo R --json name,state,bucket,workflow,completedAt,link
 * No mutating verb (pr edit/review/merge/comment/close/ready), no `gh api -X/--method/-f/-F`, and no
 * `gh api graphql` (hooks/review-artifact.cjs gates GraphQL). statusCheckRollup is NOT used: it keeps
 * superseded runs, while `gh pr checks --json` returns the current run per check.
 *
 * BALL RULE: each reviewer's latest review by submitted_at (stable, so an equal timestamp keeps the
 * API order and the later-listed review wins), ignoring COMMENTED and PENDING reviews, the PR author
 * and bots. The newest CHANGES_REQUESTED among those decides: its commit_id equal to headRefOid (exact
 * 40-hex string) -> the author owes changes; any other commit -> that reviewer owes a re-review,
 * flagged NOT RE-REQUESTED when they are absent from reviewRequests (login compared case-insensitively,
 * a team request by slug). No change request: an approval -> maintainer; pending requests -> reviewer;
 * else none. A draft or non-OPEN PR gets no ball.
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
  'A change request answered without a new commit (retitle, comment) still reads as author owes: check the timeline.';
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
  const out = execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
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

function requestName(r) {
  if (!r) return '';
  return r.login || r.slug || r.name || '';
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
  const requested = (Array.isArray(v.reviewRequests) ? v.reviewRequests : []).map(requestName).filter(Boolean);
  const requestedLower = new Set(requested.map(lower));

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

  const ball = decideBall(v, latest, requested, requestedLower, head);

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
    checks: summarizeChecks(checks),
    reviewers,
    requested,
    ball,
  };
}

function decideBall(v, latest, requested, requestedLower, head) {
  if (v.state !== 'OPEN') return { owner: 'n/a', login: null, reRequested: null, reason: `state ${v.state}` };
  if (v.isDraft) return { owner: 'n/a', login: null, reRequested: null, reason: 'draft' };

  let newestCr = null;
  for (const entry of latest.values()) {
    if (entry.r.state !== 'CHANGES_REQUESTED') continue;
    if (!newestCr || entry.order > newestCr.order) newestCr = entry;
  }
  if (newestCr) {
    const login = String(newestCr.r.user.login);
    if (head !== '' && String(newestCr.r.commit_id || '') === head) {
      return { owner: 'author', login, reRequested: null, reason: 'newest change request is on the head' };
    }
    return {
      owner: 'reviewer',
      login,
      reRequested: requestedLower.has(lower(login)),
      reason: 'the head moved after the change request',
    };
  }
  const approvers = [...latest.values()].filter((e) => e.r.state === 'APPROVED').map((e) => String(e.r.user.login)).sort();
  if (approvers.length) return { owner: 'maintainer', login: null, reRequested: null, reason: 'ready for maintainer' };
  if (requested.length) return { owner: 'reviewer', login: null, reRequested: true, reason: 'requests pending' };
  return { owner: 'none', login: null, reRequested: null, reason: 'no change request, approval or review request' };
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
  if (b.owner === 'author') return `  ball: AUTHOR owes changes (newest CHANGES_REQUESTED by ${clean(b.login)} is on the head)`;
  if (b.owner === 'reviewer' && b.login) {
    return `  ball: REVIEWER ${clean(b.login)} owes a re-review (the head moved after the change request)` +
      (b.reRequested ? '' : ' NOT RE-REQUESTED');
  }
  if (b.owner === 'reviewer') return `  ball: REVIEWER owes a first review (requests pending: ${d.requested.map(clean).join(', ')})`;
  if (b.owner === 'maintainer') return '  ball: MAINTAINER (ready for maintainer: approved, no open change request)';
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
  lines.push(`#${clean(d.number)} ${clean(d.state)}${draft} head ${clean(short(d.head, 12))} base ${clean(d.base)}`);
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
    } else if (/^[0-9]+$/.test(a)) numbers.push(a);
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
      return derive(fetchPr(n, args.repo, deps));
    } catch (err) {
      failed = true;
      return { number: Number(n), error: firstErrorLine(err) };
    }
  });
  if (args.json) {
    // ASCII on the wire too: non-ASCII characters become \uXXXX escapes (JSON.parse restores them).
    const ascii = JSON.stringify(results, null, 2).replace(/[\u007f-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
    out.write(ascii + '\n');
  } else {
    const blocks = results.map((d) => (d.error ? `#${clean(d.number)} ERROR: ${clean(d.error)}` : formatText(d)));
    out.write(blocks.join('\n\n') + '\n\n' + FOOTER + '\n');
  }
  return failed ? 1 : 0;
}

module.exports = { derive, fetchPr, formatText, runCli };

if (require.main === module) process.exitCode = runCli(process.argv.slice(2));
