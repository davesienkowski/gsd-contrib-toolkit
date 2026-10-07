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
 *   node bin/pr-status.cjs <n...>
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
const USAGE = 'usage: pr-status <pr-number...>';

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
 * @param {{gh?: Function}} [deps] injectable gh(args) runner returning parsed JSON
 * @returns {{view: object, reviews: object[], checks: object[]}}
 */
function fetchPr(number, repo, deps = {}) {
  const gh = deps.gh || defaultGh;
  const args = ghArgs(number, repo);
  const view = gh(args.view);
  const pages = gh(args.reviews);
  const reviews = Array.isArray(pages) ? pages.flat() : [];
  let checks;
  try {
    checks = gh(args.checks);
  } catch (err) {
    // Some gh versions exit 1 (a check failed) or 8 (checks pending) even with --json; the JSON
    // array on stdout is still the answer, never an error.
    const arr = err && (err.status === 1 || err.status === 8) ? jsonArrayOrNull(err.stdout) : null;
    if (!arr) throw err;
    checks = arr;
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

function short(sha, n) {
  return String(sha || '').slice(0, n) || '-';
}

function ballLine(d) {
  const b = d.ball;
  if (b.owner === 'author') return `  ball: AUTHOR owes changes (newest CHANGES_REQUESTED by ${b.login} is on the head)`;
  if (b.owner === 'reviewer' && b.login) {
    return `  ball: REVIEWER ${b.login} owes a re-review (the head moved after the change request)` +
      (b.reRequested ? '' : ' NOT RE-REQUESTED');
  }
  if (b.owner === 'reviewer') return `  ball: REVIEWER owes a first review (requests pending: ${d.requested.join(', ')})`;
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
  lines.push(`#${d.number} ${d.state}${draft} head ${short(d.head, 12)} base ${d.base}`);
  if (d.lastCommit) {
    lines.push(`  last commit: ${short(d.lastCommit.oid, 7)} ${d.lastCommit.committedDate} ${d.lastCommit.headline}`);
  }
  lines.push(`  merge: ${d.mergeable} / ${d.mergeStateStatus}`);
  const c = d.checks;
  if (c.total === 0) {
    lines.push('  checks: none');
  } else {
    lines.push(`  checks: ${c.total} total: ` + BUCKETS.map((b) => `${b} ${c.counts[b]}`).join(', '));
    if (c.failing.length) lines.push(`    failing: ${c.failing.join(', ')}`);
    if (c.pending.length) lines.push(`    pending: ${c.pending.join(', ')}`);
  }
  if (d.reviewers.length === 0) lines.push('  review: none');
  for (const r of d.reviewers) {
    lines.push(`  review: ${r.login} ${r.state} on ${short(r.commitId, 7)} (${r.onHead ? 'head' : 'older commit'}) ${r.submittedAt}`);
  }
  lines.push(`  requested: ${d.requested.length ? d.requested.join(', ') : 'none'}`);
  const bl = ballLine(d);
  if (bl) lines.push(bl);
  return lines.join('\n');
}

/**
 * CLI entry. Returns the exit code (0 ok, 2 usage).
 *
 * @param {string[]} argv
 * @param {{gh?: Function, stdout?: {write: Function}, stderr?: {write: Function}}} [deps]
 * @returns {number}
 */
function runCli(argv, deps = {}) {
  const out = deps.stdout || process.stdout;
  const err = deps.stderr || process.stderr;
  const numbers = [];
  for (const a of argv || []) {
    if (!/^[0-9]+$/.test(a)) {
      err.write(`pr-status: not a PR number: ${a}\n${USAGE}\n`);
      return 2;
    }
    numbers.push(a);
  }
  if (numbers.length === 0) {
    err.write(USAGE + '\n');
    return 2;
  }
  const blocks = numbers.map((n) => formatText(derive(fetchPr(n, DEFAULT_REPO, deps))));
  out.write(blocks.join('\n\n') + '\n');
  return 0;
}

module.exports = { derive, fetchPr, formatText, runCli };

if (require.main === module) process.exitCode = runCli(process.argv.slice(2));
