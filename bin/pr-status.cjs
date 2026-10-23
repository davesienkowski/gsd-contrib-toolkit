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
 *   node bin/pr-status.cjs [--json] [--overlap] [--repo owner/name] <n...>
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
 * plus, once per repo and base branch per run (cached, quick 261021-n2m, CTK-ADR-0012), the merge-queue
 * reads, all REST GETs:
 *   4. gh api --paginate --slurp "repos/R/rules/branches/<base>?per_page=100"   (ACTIVE rules only;
 *      a merge_queue entry here means the queue is enforcing; evaluate and disabled rules are not returned)
 *   5. gh api --paginate --slurp "repos/R/rulesets?includes_parents=true&per_page=100"   (only when 4 has
 *      no merge_queue)
 *   6. gh api "repos/R/rulesets/<id>" for each branch ruleset in evaluate mode (the list carries no rules)
 *   7. gh api "repos/R" only when an evaluate merge_queue ruleset targets ~DEFAULT_BRANCH
 * plus, only when the reviews hold a DISMISSED review (quick 261022-w9m), one more REST GET per PR:
 *   8. gh api --paginate --slurp "repos/R/issues/N/timeline?per_page=100"   (review_dismissed events carry
 *      the actor, the time and dismissal_message, which the reviews listing does not)
 * and, only with --overlap (quick 261022-w9m), three more REST GETs per PR:
 *   9. gh api --paginate --slurp "repos/R/pulls/N/files?per_page=100"   (the PR's files; GitHub lists at
 *      most 3000, so a 3000-file list also makes the overlap a lower bound)
 *  10. gh api "repos/R/compare/<base>...<head sha>"   (behind_by and the merge base)
 *  11. gh api "repos/R/compare/<merge base>...<base>"   (files the base changed since the merge base; GitHub
 *      lists at most 300, so a 300-file list makes the overlap a lower bound); skipped when behind_by is 0
 * A failed timeline or overlap read is named on its own line and never fails the PR block or the exit code.
 * Any queue read that fails makes the mode `unknown` with the error named; it never fails the PR block
 * or the exit code (fail open to informational). Known limit: a queue configured through classic branch
 * protection rather than a ruleset is not visible to these reads.
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
 *     no check fails or is pending and mergeStateStatus is not DIRTY; otherwise the blockers are named
 *     and the ball goes to the author (failing checks, DIRTY), else the requested reviewers, else the
 *     maintainer (approval on an older commit, checks pending). BEHIND is NEVER a blocker (CTK-ADR-0012):
 *     with an active merge queue the PR is tested on top of the entries ahead of it, and without one the
 *     base requires up-to-date branches (GitHub reports BEHIND only then), so the maintainer runs Update
 *     branch at merge time: the ready line carries "maintainer: Update branch at merge time; never --admin"
 *     and a BEHIND note explains it. When the queue is active the ready line says it enters the queue.
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
const USAGE = 'usage: pr-status [--json] [--overlap] [--repo owner/name] <pr-number...>  (default repo ' + DEFAULT_REPO + ')';
const FOOTER =
  'Snapshot is point-in-time (three separate gh reads per PR, and separate merge-queue reads per base branch; ' +
  'plus a timeline read when a review was dismissed, and files and compare reads with --overlap); re-run before any write. ' +
  'A change request answered without a new commit (retitle, comment) still reads as author owes unless ' +
  'the reviewer was re-requested: check the timeline.';
const MAX_BUFFER = 64 * 1024 * 1024; // review listings carry full bodies; 1 MiB (the default) is not enough
const UNKNOWN_RETRY_MS = 2000;
const MERGE_CAVEAT = 'Update branch at merge time; never --admin';
const COMPARE_FILE_CAP = 300; // GitHub's compare endpoint lists at most 300 files
const PR_FILE_CAP = 3000; // GitHub's pulls/N/files lists at most 3000 files
const BRANCH_PATTERN = /^[A-Za-z0-9._/-]+$/;
const MAX_MESSAGE = 300; // a dismissal message is printed on one line, cut at this length

/** The read-only argv arrays for one PR (view, reviews, checks, and the timeline read only for a dismissed review). */
function ghArgs(number, repo) {
  return {
    view: ['pr', 'view', String(number), '--repo', repo, '--json', VIEW_FIELDS],
    reviews: ['api', '--paginate', '--slurp', `repos/${repo}/pulls/${number}/reviews?per_page=100`],
    checks: ['pr', 'checks', String(number), '--repo', repo, '--json', CHECK_FIELDS],
    timeline: ['api', '--paginate', '--slurp', `repos/${repo}/issues/${number}/timeline?per_page=100`],
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
  // The dismissal message lives only on the timeline's review_dismissed event: read it only when needed.
  let timeline = null;
  let timelineError = null;
  if (reviews.some((r) => r && r.state === 'DISMISSED')) {
    try {
      timeline = pagesToArray(gh(args.timeline), 'timeline');
    } catch (err) {
      timelineError = firstErrorLine(err);
    }
  }
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
  return { view, reviews, checks: Array.isArray(checks) ? checks : [], timeline, timelineError };
}

/**
 * Read the PR's files and the base branch's movement since the merge base (REST GETs only), for --overlap.
 * Any failure yields { error }: fail open to informational, never a thrown PR error and never "none".
 *
 * @param {string} repo owner/name
 * @param {{number: (string|number), baseRefName: string, headRefOid: string}} view
 * @param {{gh?: Function}} [deps]
 * @returns {object} { base, behindBy, aheadBy, mergeBase, baseCommits, baseFiles, truncated, prFiles, overlap } or { base, error }
 */
function fetchOverlap(repo, view, deps = {}) {
  const gh = deps.gh || defaultGh;
  const v = view || {};
  const base = String(v.baseRefName || '');
  const head = String(v.headRefOid || '');
  try {
    if (!BRANCH_PATTERN.test(base)) throw new Error(`base branch name not usable in a compare path: ${base}`);
    if (!/^[0-9a-f]{40}$/.test(head)) throw new Error('no 40-hex head SHA in the PR view');
    const prFiles = pagesToArray(gh(['api', '--paginate', '--slurp', `repos/${repo}/pulls/${v.number}/files?per_page=100`]), 'pulls files');
    const cmp = gh(['api', `repos/${repo}/compare/${base}...${head}`]) || {};
    const mergeBase = String((cmp.merge_base_commit && cmp.merge_base_commit.sha) || '');
    if (!/^[0-9a-f]{40}$/.test(mergeBase)) throw new Error('compare reply has no merge base');
    const behindBy = Number(cmp.behind_by);
    if (!Number.isInteger(behindBy) || behindBy < 0) throw new Error('compare reply has no behind_by');
    let baseFiles = [];
    let baseCommits = 0;
    if (behindBy > 0) {
      const moved = gh(['api', `repos/${repo}/compare/${mergeBase}...${base}`]) || {};
      if (!Array.isArray(moved.files)) throw new Error('base compare reply has no files list');
      baseFiles = moved.files;
      baseCommits = Number(moved.total_commits) || behindBy;
    }
    return deriveOverlap({ base, behindBy, aheadBy: Number(cmp.ahead_by) || 0, mergeBase, baseCommits, prFiles, baseFiles });
  } catch (err) {
    return { base, error: firstErrorLine(err) };
  }
}

/** Every path a compare/pulls file entry names (its filename, plus previous_filename for a rename). */
function filePaths(files) {
  const out = new Set();
  for (const f of Array.isArray(files) ? files : []) {
    if (f && f.filename) out.add(String(f.filename));
    if (f && f.previous_filename) out.add(String(f.previous_filename));
  }
  return out;
}

/**
 * Pure overlap verdict: the PR paths the base also changed since the merge base, sorted.
 *
 * @returns {{base: string, behindBy: number, aheadBy: number, mergeBase: string, baseCommits: number, baseFiles: number, truncated: boolean, prFiles: number, overlap: string[]}}
 */
function deriveOverlap({ base, behindBy, aheadBy, mergeBase, baseCommits, prFiles, baseFiles }) {
  const pr = filePaths(prFiles);
  const moved = filePaths(baseFiles);
  const overlap = [...pr].filter((p) => moved.has(p)).sort();
  const listed = Array.isArray(baseFiles) ? baseFiles.length : 0;
  const prTruncated = (Array.isArray(prFiles) ? prFiles.length : 0) >= PR_FILE_CAP;
  return {
    base,
    behindBy,
    aheadBy,
    mergeBase,
    baseCommits,
    baseFiles: listed,
    truncated: listed >= COMPARE_FILE_CAP || prTruncated,
    baseTruncated: listed >= COMPARE_FILE_CAP,
    prTruncated,
    prFiles: Array.isArray(prFiles) ? prFiles.length : 0,
    overlap,
  };
}

/**
 * Pure dismissal list: every DISMISSED review (bots and the author included, since a dismissal is a fact
 * about the review, not a verdict), in submitted_at order (stable), joined to its timeline
 * review_dismissed event by review id. timeline null = not read (timelineError names why).
 */
function deriveDismissals(reviews, timeline, timelineError) {
  const flat = (Array.isArray(reviews) ? reviews : []).flat();
  const dismissed = flat
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => r && r.state === 'DISMISSED' && r.user && r.user.login);
  dismissed.sort((a, b) => {
    const ta = String(a.r.submitted_at || '');
    const tb = String(b.r.submitted_at || '');
    return ta < tb ? -1 : ta > tb ? 1 : a.i - b.i;
  });
  const events = new Map();
  for (const e of Array.isArray(timeline) ? timeline : []) {
    const dr = e && e.event === 'review_dismissed' && e.dismissed_review;
    if (dr && dr.review_id != null) events.set(String(dr.review_id), e);
  }
  return dismissed.map(({ r }) => {
    const e = r.id == null ? null : events.get(String(r.id));
    const dr = e ? e.dismissed_review : null;
    return {
      login: String(r.user.login),
      reviewId: r.id == null ? null : String(r.id),
      commitId: String(r.commit_id || ''),
      submittedAt: String(r.submitted_at || ''),
      originalState: dr && dr.state ? String(dr.state).toUpperCase() : null,
      actor: e && e.actor && e.actor.login ? String(e.actor.login) : null,
      dismissedAt: e && e.created_at ? String(e.created_at) : null,
      message: dr && dr.dismissal_message != null ? String(dr.dismissal_message) : null,
      found: Boolean(e),
      readError: timeline == null ? timelineError || 'timeline not read' : null,
    };
  });
}

/**
 * Flatten a --paginate --slurp result (an array of pages, each an array) into one array. Any other shape
 * THROWS, so fetchQueue reports mode unknown instead of silently reading an odd reply as "no queue"
 * (Postel: liberal in what is accepted, but never quietly).
 */
function pagesToArray(pages, what) {
  if (!Array.isArray(pages) || !pages.every((p) => Array.isArray(p))) {
    throw new Error(`${what} reply is not an array of pages`);
  }
  return pages.flat();
}

function hasMergeQueue(rules) {
  return (Array.isArray(rules) ? rules : []).some((r) => r && r.type === 'merge_queue');
}

/** fnmatch-style ref pattern to a RegExp: ** crosses slashes, * and ? do not; a bare name means refs/heads/<name>. */
function refPatternRe(pattern) {
  const full = pattern.startsWith('refs/') ? pattern : 'refs/heads/' + pattern;
  let re = '';
  for (let i = 0; i < full.length; i += 1) {
    const c = full[i];
    if (c === '*' && full[i + 1] === '*') {
      re += '.*';
      i += 1;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}

/** Does one ref_name pattern cover refs/heads/<base>? */
function refMatches(pattern, base, defaultBranch) {
  const p = String(pattern || '');
  if (p === '~ALL') return true;
  if (p === '~DEFAULT_BRANCH') return defaultBranch != null && base === String(defaultBranch);
  if (!p) return false;
  return refPatternRe(p).test('refs/heads/' + base);
}

/** A ruleset's ref_name conditions cover the base: some include matches and no exclude does (exclude wins). */
function rulesetCovers(ruleset, base, defaultBranch) {
  const ref = ruleset && ruleset.conditions && ruleset.conditions.ref_name;
  if (!ref) return true;
  const include = Array.isArray(ref.include) ? ref.include : [];
  const exclude = Array.isArray(ref.exclude) ? ref.exclude : [];
  return include.some((p) => refMatches(p, base, defaultBranch)) && !exclude.some((p) => refMatches(p, base, defaultBranch));
}

/**
 * Pure merge-queue verdict for one base branch.
 *
 * @param {{base: string, rules: object[], details: object[], defaultBranch: (string|null)}} input
 *   rules = the ACTIVE rules for the base (rules/branches); details = the full evaluate-mode branch rulesets
 * @returns {{base: string, mode: 'active'|'evaluate'|'absent', ruleset: (string|null)}}
 */
function deriveQueue({ base, rules, details, defaultBranch }) {
  const active = Array.isArray(rules) ? rules : [];
  // No up-to-date flag here: these reads see rulesets only, and classic branch protection (what enforces
  // up-to-date on open-gsd next today) is invisible to them, so a flag would read false while the rule is
  // enforced. The BEHIND caveat keys on mergeStateStatus itself (CTK-ADR-0012; strictUpToDate removed
  // after the round-2 gate, note N4).
  const mq = active.find((r) => r && r.type === 'merge_queue');
  if (mq) return { base, mode: 'active', ruleset: mq.ruleset_id == null ? null : String(mq.ruleset_id) };
  const evaluating = (Array.isArray(details) ? details : []).find(
    (d) => d && d.target === 'branch' && d.enforcement === 'evaluate' && hasMergeQueue(d.rules) && rulesetCovers(d, base, defaultBranch)
  );
  if (evaluating) return { base, mode: 'evaluate', ruleset: String(evaluating.name || evaluating.id) };
  return { base, mode: 'absent', ruleset: null };
}

/**
 * Read the merge-queue mode of one base branch (REST GETs only). Any failure, or no base, yields mode
 * unknown with the error named: fail open to informational, never a thrown PR error.
 *
 * @param {string} repo owner/name
 * @param {string} base base branch name
 * @param {{gh?: Function}} [deps]
 * @returns {{base: string, mode: string, ruleset?: (string|null), error?: string}}
 */
function fetchQueue(repo, base, deps = {}) {
  const gh = deps.gh || defaultGh;
  const b = String(base || '');
  if (!b) return { base: '', mode: 'unknown', error: 'no base branch in the PR view' };
  try {
    const rules = pagesToArray(gh(['api', '--paginate', '--slurp', `repos/${repo}/rules/branches/${encodeURIComponent(b)}?per_page=100`]), 'rules/branches');
    if (hasMergeQueue(rules)) return deriveQueue({ base: b, rules, details: [], defaultBranch: null });
    const list = pagesToArray(gh(['api', '--paginate', '--slurp', `repos/${repo}/rulesets?includes_parents=true&per_page=100`]), 'rulesets');
    const candidates = list.filter((r) => r && r.target === 'branch' && r.enforcement === 'evaluate' && /^[0-9]+$/.test(String(r.id)));
    const details = candidates.map((r) => gh(['api', `repos/${repo}/rulesets/${String(r.id)}`]));
    const needsDefault = details.some(
      (d) => d && hasMergeQueue(d.rules) && ((d.conditions && d.conditions.ref_name && d.conditions.ref_name.include) || []).includes('~DEFAULT_BRANCH')
    );
    const defaultBranch = needsDefault ? (gh(['api', `repos/${repo}`]) || {}).default_branch || null : null;
    return deriveQueue({ base: b, rules, details, defaultBranch });
  } catch (err) {
    return { base: b, mode: 'unknown', error: firstErrorLine(err) };
  }
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
 * @param {{view: object, reviews: object[], checks: object[], queue?: object}} input reviews may be flat or
 *   page-nested; queue is a fetchQueue/deriveQueue result for the PR's base (absent input = not read)
 * @returns {object} snapshot with checks summary, reviewers, requested, queue and ball
 */
function derive({ view, reviews, checks, queue, timeline, timelineError, overlap }) {
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

  const q = queue || null; // null = not read (library callers); the CLI always reads it
  const ball = decideBall(v, latest, req, head, checkSummary, q);

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
    queue: q,
    ball,
    reviewDecision: v.reviewDecision == null ? null : String(v.reviewDecision),
    decisionNote: decisionNote(v.reviewDecision, latest),
    dismissals: deriveDismissals(reviews, timeline === undefined ? null : timeline, timelineError || null),
    overlap: overlap || null, // null = --overlap not given
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
  return Object.assign({ owner, login: null, reRequested: null, reason: '', ready: false, blockers: [], mergeCaveat: null }, fields);
}

function decideBall(v, latest, req, head, checks, queue) {
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
    // BEHIND is deliberately absent (CTK-ADR-0012): it is reported as an informational note instead.
    if (blockers.length === 0) {
      const active = Boolean(queue && queue.mode === 'active');
      // GitHub reports BEHIND only when the base requires up-to-date branches (CTK-ADR-0012), so without an
      // active queue the merge needs an Update branch first: the maintainer's step, never the author's.
      const mergeCaveat = !active && v.mergeStateStatus === 'BEHIND' ? MERGE_CAVEAT : null;
      return ballOf('maintainer', { ready: true, reason: 'ready for maintainer', entersQueue: active, mergeCaveat });
    }
    const authorOwes = checks.counts.fail > 0 || v.mergeStateStatus === 'DIRTY';
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
    const base = '  ball: MAINTAINER ready (approved on the head, no change request, no pending requests, checks green, not DIRTY';
    if (b.entersQueue) return `${base}; enters the merge queue on ${clean(d.queue.base)})`;
    return b.mergeCaveat ? `${base}; maintainer: ${b.mergeCaveat})` : `${base})`;
  }
  if (b.owner === 'maintainer' && b.blockers.length) return `  ball: MAINTAINER not ready ${blocked()}`;
  if (b.owner === 'maintainer') return `  ball: MAINTAINER re-approval needed (latest review by ${clean(b.login)} was dismissed; no review requested)`;
  if (b.owner === 'none') return '  ball: none (no change request, approval or pending review request)';
  return null; // n/a: draft or not OPEN prints its state and no ball
}

/** One line per dismissed review: who, which review, who dismissed it, when, and the message. */
function dismissalLine(x) {
  const what = `${clean(x.login)} ${x.originalState ? clean(x.originalState) + ' ' : ''}review ${clean(x.reviewId || '?')} on ${clean(short(x.commitId, 7))}`;
  if (x.readError) return `  dismissed: ${what}; message unknown (timeline read failed: ${clean(x.readError)})`;
  if (!x.found) return `  dismissed: ${what}; message unknown (no review_dismissed event for this review on the timeline)`;
  let msg = clean(String(x.message == null ? '' : x.message).replace(/\s+/g, ' ').trim());
  if (msg.length > MAX_MESSAGE) msg = msg.slice(0, MAX_MESSAGE) + '...';
  return `  dismissed: ${what} by ${clean(x.actor || '?')} ${clean(x.dismissedAt || '?')}: "${msg || '(empty message)'}"`;
}

/** The --overlap line(s): how far the base moved since the merge base and which PR files it also changed. */
function overlapLines(o) {
  if (o.error) return [`  overlap: unknown (read failed: ${clean(o.error)})`];
  const head = `  overlap: ${clean(o.base)} is ${o.behindBy} commit(s) past the merge base ${clean(short(o.mergeBase, 9))}`;
  if (o.behindBy === 0) return [`${head}; overlapping files: none (the base has not moved)`];
  const cut = ' (list truncated by GitHub)';
  const files = `${o.baseFiles} base file(s) changed${o.baseTruncated ? cut : ''}, ${o.prFiles} PR file(s)${o.prTruncated ? cut : ''}`;
  if (o.overlap.length === 0 && o.truncated) {
    return [`${head}; ${files}; overlapping files: none among the listed base files, unknown beyond them (truncated)`];
  }
  if (o.overlap.length === 0) return [`${head}; ${files}; overlapping files: none`];
  const label = o.truncated ? `at least ${o.overlap.length} (truncated)` : String(o.overlap.length);
  return [`${head}; ${files}; overlapping files: ${label}`, ...o.overlap.map((p) => `    ${clean(p)}`)];
}

/** The per-PR queue line: the base branch's merge-queue mode as read this run. */
function queueLine(q) {
  const base = clean(q.base) || '-';
  if (q.mode === 'active') return `  queue: ${base} active (merge_queue rule in ruleset ${clean(q.ruleset) || '?'})`;
  if (q.mode === 'evaluate') return `  queue: ${base} evaluate (merge_queue rule in ruleset ${clean(q.ruleset) || '?'}, not enforcing)`;
  if (q.mode === 'absent') return `  queue: ${base} none (no merge_queue rule applies to the base branch)`;
  return `  queue: ${base} unknown (queue read failed: ${clean(q.error) || 'unknown error'}; BEHIND treated as informational)`;
}

/**
 * The BEHIND note; its wording follows the queue mode. GitHub reports BEHIND only when the base requires
 * up-to-date branches (open-gsd next: classic protection, enforcement_level non_admins), so BEHIND is never
 * author work, and without an active queue the maintainer runs Update branch at merge time (CTK-ADR-0012).
 */
function behindNote(q) {
  const base = (q && clean(q.base)) || 'the base branch';
  if (q && q.mode === 'active') {
    return `  note: BEHIND is informational: the merge queue on ${base} tests the PR on top of the entries ahead of it; nobody rebases or runs Update branch for BEHIND, and never --admin`;
  }
  const why = !q ? ' (mode not read)' : q.mode === 'unknown' ? ' (mode unknown: read failed)' : '';
  return `  note: BEHIND is not author work: GitHub reports BEHIND only when ${base} requires up-to-date branches, so with no active merge queue${why} the maintainer runs Update branch at merge time (one fresh CI run) and never --admin; the author does not rebase for BEHIND`;
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
  if (d.queue) lines.push(queueLine(d.queue));
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
  for (const x of d.dismissals || []) lines.push(dismissalLine(x));
  lines.push(`  requested: ${d.requested.length ? d.requested.map(clean).join(', ') : 'none'}`);
  const bl = ballLine(d);
  if (bl) lines.push(bl);
  if (d.mergeStateStatus === 'BEHIND') lines.push(behindNote(d.queue));
  if (d.decisionNote) lines.push(`  note: ${clean(d.decisionNote)}`);
  if (d.overlap) lines.push(...overlapLines(d.overlap));
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
  let overlap = false;
  let repo = DEFAULT_REPO;
  const numbers = [];
  const list = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < list.length; i += 1) {
    const a = String(list[i]);
    if (a === '--json') json = true;
    else if (a === '--overlap') overlap = true;
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
  return { json, overlap, repo, numbers };
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
  const queues = new Map(); // base branch -> fetchQueue result, one set of queue reads per repo and base
  const results = args.numbers.map((n) => {
    try {
      const pr = fetchPr(n, args.repo, deps);
      const base = String((pr.view && pr.view.baseRefName) || '');
      if (!queues.has(base)) queues.set(base, fetchQueue(args.repo, base, deps));
      const overlap = args.overlap ? fetchOverlap(args.repo, pr.view, deps) : null;
      return { repo: args.repo, ...derive({ ...pr, queue: queues.get(base), overlap }) };
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

module.exports = { ballLineOf: ballLine, clean, derive, deriveDismissals, deriveOverlap, deriveQueue, fetchOverlap, fetchPr, fetchQueue, firstErrorLine, formatText, runCli };

if (require.main === module) process.exitCode = runCli(process.argv.slice(2));
