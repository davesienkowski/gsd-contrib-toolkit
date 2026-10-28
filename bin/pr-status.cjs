#!/usr/bin/env node
'use strict';

/**
 * bin/pr-status.cjs — read-only PR snapshot and ball-in-court for the maintainer review sweep.
 *
 * Why: the sweep (skills/maintainer-review-sweep) re-derived PR state and ball-in-court by hand from
 * prose ("re-fetch live state"), which is where stale-snapshot and wrong-ball mistakes came from
 * (collab audit 2026-10-07 rec 8; a dev-environment quick task, 261007-fnu). This prints that snapshot per PR:
 * head SHA, mergeable + mergeStateStatus, the current checks, every reviewer's latest state with the
 * commit it was on, the requested reviewers and one ball line.
 *
 *   node bin/pr-status.cjs [--json] [--overlap] [--cr [--reviewer <login>]] [--body] [--repo owner/name] <n...>
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
 *   1. gh pr view N --repo R --json <sixteen fields>
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
 * and, only with --cr (quick 261023-2u4), the timeline read above (once per PR, shared with the dismissed path)
 * plus, when a change request was chosen, one more REST GET per PR:
 *  12. gh api --paginate --slurp "repos/R/pulls/N/reviews/<id>/comments?per_page=100"   (the chosen review's
 *      inline comments)
 * and, only with --body (same quick), the timeline read above plus one more read per PR, after 12:
 *  13. gh pr view N --repo R --json body,baseRefOid,changedFiles   (a separate view, so a push between the two
 *      views can move the head: the body lines name the head they compared against)
 * and, only when a gsd-core CI check is on the PR (quick 261028-owj; CTK-ADR-0012 fail-open, CTK-ADR-0001 LIVE reuse),
 * the policy reads, all REST GETs, each cached per repo (and base or sha) per run:
 *  14. gh api "repos/R/actions/workflows/<TESTS_WORKFLOW_FILE>/runs?branch=<base>&event=push&per_page=5"   (only when
 *      "Required tests" or "Base branch health" fails; mirrors the fetcher in gsd-core scripts/ci-next-health.cjs
 *      main(), source sha 65638993a: when the newest run has run_attempt > 1 the previous attempt is read too)
 *  15. gh api "repos/R/actions/runs/<id>/attempts/<n>"   (that previous attempt)
 *  16. gh api "repos/R/contents/.github/MAINTAINERS?ref=<baseRefOid>"   (when "Reviewed or maintainer" is present, or
 *      "Self-test report" is present with --body; the ref is the base branch name when the view has no baseRefOid)
 *  17. gh api "repos/R/collaborators/<login>/permission"   (each approving reviewer, only when the author is not
 *      listed in MAINTAINERS)
 * The verdicts come from the LIVE gsd-core scripts (scripts/ci-next-health.cjs classifyBaseRuns,
 * reviewed-or-maintainer-policy.cjs, self-test-report-policy.cjs) loaded through hooks/lib/resolve.cjs; no rule is
 * copied here. An unresolvable checkout, a failed read or incomplete input prints `unknown (<why>)` for that verdict.
 * A failed timeline, overlap, inline-comments, body or policy read is named on its own line and never fails the PR
 * block or the exit code.
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
 *   - Failing checks are split (CI CHECKS below) before they block: only author-side failures make the author owe;
 *     a red base is base-side, a red Reviewed or maintainer is reviewer-side, a red Self-test report is advisory.
 *   - Only dismissed reviews and nobody requested -> maintainer, re-approval needed. Pending requests
 *     -> reviewer. Else none. A draft or non-OPEN PR gets no ball.
 * CI CHECKS (quick 261028-owj): "Required tests" red counts as base health, not this PR, only when "Base branch
 * health" itself fails and no other job of workflow Tests fails (otherwise it stays author work); "Base branch
 * health" red is base-side (the base owner waits for a fix-forward, or fix-next when this PR is the fix);
 * "Reviewed or maintainer" red is reviewer-side; "Self-test report" red is advisory (every result of that policy
 * is advisory; fail_suite_not_passed is printed as such) and never blocks the ready line.
 * reviewDecision is a cross-check: when GitHub's value disagrees with this reading a note line says so.
 *
 * No shell: execFileSync with argv arrays; PR numbers are validated as digits. Node built-ins only.
 *
 * @module bin/pr-status
 */

const { execFileSync } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_REPO = 'open-gsd/gsd-core';
const VIEW_FIELDS =
  'number,state,isDraft,author,headRefOid,baseRefName,mergeable,mergeStateStatus,reviewDecision,reviewRequests,commits,updatedAt,headRefName,title,labels,baseRefOid';
const CHECK_FIELDS = 'name,state,bucket,workflow,completedAt,link';
const BODY_FIELDS = 'body,baseRefOid,changedFiles'; // the --body view (quick 261023-2u4), read apart from VIEW_FIELDS
const BUCKETS = Object.freeze(['pass', 'fail', 'pending', 'skipping', 'cancel']);
const IGNORED_REVIEW_STATES = new Set(['COMMENTED', 'PENDING']);
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const USAGE =
  'usage: pr-status [--json] [--overlap] [--cr [--reviewer <login>]] [--body] [--repo owner/name] <pr-number...>  (default repo ' +
  DEFAULT_REPO +
  '; policy lines for the gsd-core CI checks Required tests, Base branch health, Reviewed or maintainer and Self-test report print on their own when those checks are on the PR; the Self-test verdict needs --body)';
const FOOTER =
  'Snapshot is point-in-time (three separate gh reads per PR, and separate merge-queue reads per base branch; ' +
  'plus a timeline read when a review was dismissed, and files and compare reads with --overlap); re-run before any write. ' +
  'A change request answered without a new commit (retitle, comment) still reads as author owes unless ' +
  'the reviewer was re-requested: check the timeline.';
// R8: printed after FOOTER (which stays byte-identical) only when --cr or --body added reads.
const CR_FOOTER =
  "With --cr or --body: the timeline, the chosen change request's inline comments and the body view are further separate reads, so the head can move between them; re-run before any write.";
// 261028-owj: printed after FOOTER (which stays byte-identical) only when a block consulted the policy scripts.
const POLICY_FOOTER =
  'Policy lines (policies, base, reviewed-or-maintainer, self-test): the workflow-run, MAINTAINERS and collaborator-permission reads are further separate reads, ' +
  'and the verdicts are those of the LIVE gsd-core scripts at the checkout named on the policies line, which can differ from the CI that ran; re-run before any write.';
const MAX_BUFFER = 64 * 1024 * 1024; // review listings carry full bodies; 1 MiB (the default) is not enough
const UNKNOWN_RETRY_MS = 2000;
const MERGE_CAVEAT = 'Update branch at merge time; never --admin';
const COMPARE_FILE_CAP = 300; // GitHub's compare endpoint lists at most 300 files
const PR_FILE_CAP = 3000; // GitHub's pulls/N/files lists at most 3000 files
const BRANCH_PATTERN = /^[A-Za-z0-9._/-]+$/;
const CHECK_REQUIRED = 'Required tests';
const CHECK_BASE_HEALTH = 'Base branch health';
const CHECK_REVIEWED = 'Reviewed or maintainer';
const CHECK_SELF_TEST = 'Self-test report';
const TESTS_WORKFLOW_NAME = 'Tests'; // the workflow name `gh pr checks` reports for the two Tests-workflow checks above
const LOGIN_PATH_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/; // the login check of the upstream reviewed-or-maintainer workflow
const SUITE_ADVISORY = 'advisory; the full suite did not pass with 0 failures, e.g. a known environment failure';
const NEEDS_BODY = 'run with --body for the reason';
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
 * Read one PR through three read-only gh calls (plus the timeline when a review is DISMISSED or options ask).
 *
 * @param {string|number} number PR number (digits)
 * @param {string} repo owner/name
 * @param {{gh?: Function, sleep?: Function}} [deps] injectable gh(args) runner returning parsed JSON, and sleep(ms)
 * @param {{timeline?: boolean}} [options] timeline: read the timeline even with no DISMISSED review (--cr, --body);
 *   omitted (bin/issue-status.cjs) keeps the dismissed-only read
 * @returns {{view: object, reviews: object[], checks: object[]}}
 */
function fetchPr(number, repo, deps = {}, options = {}) {
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
  if ((options && options.timeline) || reviews.some((r) => r && r.state === 'DISMISSED')) {
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
  // reviewsShapeOk: false when the reviews reply was not an array of pages (the policies then read unknown).
  return { view, reviews, reviewsShapeOk: Array.isArray(pages), checks: Array.isArray(checks) ? checks : [], timeline, timelineError };
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

/**
 * --cr: read the chosen change request's inline comments (one REST GET, only when a review was chosen) and
 * derive the --cr verdict. A failed read is named, never a thrown PR error (CONTEXT D1 f).
 *
 * @param {string|number} number PR number (digits)
 * @param {string} repo owner/name
 * @param {{view: object, reviews: object[], timeline: (object[]|null), timelineError: (string|null)}} pr fetchPr result
 * @param {string|null} reviewer --reviewer login, or null
 * @param {{gh?: Function}} [deps]
 * @returns {object} deriveCr result
 */
function fetchCr(number, repo, pr, reviewer, deps = {}) {
  const gh = deps.gh || defaultGh;
  const { chosen } = chooseCr(pr.view, pr.reviews, reviewer);
  let comments = null;
  let commentsError = null;
  if (chosen) {
    try {
      if (!/^[0-9]+$/.test(String(chosen.id))) throw new Error(`review id not usable in a path: ${chosen.id}`);
      comments = pagesToArray(gh(['api', '--paginate', '--slurp', `repos/${repo}/pulls/${number}/reviews/${chosen.id}/comments?per_page=100`]), 'review comments');
    } catch (err) {
      commentsError = firstErrorLine(err);
    }
  }
  return deriveCr({ view: pr.view, reviews: pr.reviews, timeline: pr.timeline, timelineError: pr.timelineError, comments, commentsError, reviewer });
}

/**
 * --body: one more read-only view (body, baseRefOid, changedFiles) and the --body verdict. A failed read is
 * named, never a thrown PR error (CONTEXT D2 f).
 *
 * @param {object} [sink] when given, receives { bodyView, bodyError } (the raw read) for fetchPolicies
 * @returns {object} deriveBody result, or { error }
 */
function fetchBody(number, repo, pr, deps = {}, sink = null) {
  const gh = deps.gh || defaultGh;
  let bodyView = null;
  let bodyError = null;
  try {
    bodyView = gh(['pr', 'view', String(number), '--repo', repo, '--json', BODY_FIELDS]);
    if (!bodyView || typeof bodyView !== 'object') throw new Error('body view reply is not an object');
  } catch (err) {
    bodyView = null;
    bodyError = firstErrorLine(err);
  }
  // The Self-test policy needs the body text itself, which deriveBody does not keep: hand it to the caller.
  if (sink) Object.assign(sink, { bodyView, bodyError });
  return deriveBody({ view: pr.view, reviews: pr.reviews, timeline: pr.timeline, timelineError: pr.timelineError, bodyView, bodyError });
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

/**
 * Split the failing checks by whose work they are (quick 261028-owj). The names are the gsd-core CI checks as
 * `gh pr checks` reports them. "Required tests" counts as base health only when "Base branch health" itself
 * fails and no other job of workflow Tests fails; otherwise it stays author work (a shard failure is the PR's).
 *
 * @returns {{groups: {author: string[], base: string[], reviewer: string[], advisory: string[]}, requiredRed: boolean,
 *   baseHealthRed: boolean, otherTests: string[], attributed: boolean}}
 */
function partitionChecks(checks) {
  const failing = (Array.isArray(checks) ? checks : []).filter((c) => c && c.bucket === 'fail');
  const names = (list) => [...new Set(list.map((c) => String(c.name)))].sort();
  const has = (n) => failing.some((c) => c.name === n);
  const requiredRed = has(CHECK_REQUIRED);
  const baseHealthRed = has(CHECK_BASE_HEALTH);
  const otherTests = names(failing.filter((c) => c.workflow === TESTS_WORKFLOW_NAME && c.name !== CHECK_REQUIRED && c.name !== CHECK_BASE_HEALTH));
  const attributed = requiredRed && baseHealthRed && otherTests.length === 0;
  const pick = (test) => names(failing.filter((c) => test(String(c.name))));
  const groups = {
    base: pick((n) => n === CHECK_BASE_HEALTH || (n === CHECK_REQUIRED && attributed)),
    reviewer: pick((n) => n === CHECK_REVIEWED),
    advisory: pick((n) => n === CHECK_SELF_TEST),
    author: pick((n) => ![CHECK_BASE_HEALTH, CHECK_REVIEWED, CHECK_SELF_TEST].includes(n) && !(n === CHECK_REQUIRED && attributed)),
  };
  return { groups, requiredRed, baseHealthRed, otherTests, attributed };
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
  return { total: (checks || []).length, counts, failing, pending, ...partitionChecks(checks) };
}

/**
 * Pure verdict over the three reads.
 *
 * @param {{view: object, reviews: object[], checks: object[], queue?: object, policies?: object}} input reviews may be
 *   flat or page-nested; queue is a fetchQueue/deriveQueue result for the PR's base (absent input = not read);
 *   policies is a fetchPolicies result (absent = not read; the ball never depends on it, only on the check names)
 * @returns {object} snapshot with checks summary, reviewers, requested, queue and ball
 */
function derive({ view, reviews, checks, queue, timeline, timelineError, overlap, cr, body, policies }) {
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
  const ball = decideBall(v, latest, req, head, checkSummary, q, policies || null);

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
    cr: cr || null, // null = --cr not given (a deriveCr result otherwise)
    body: body || null, // null = --body not given (a deriveBody result otherwise)
    policies: policies || null, // null = no gsd-core CI check consulted (a fetchPolicies result otherwise)
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

/**
 * The blocker text for a red Base branch health (or base-attributed Required tests) check, from the live base
 * verdict when one was read (review MJ-01): the check name alone cannot say whether the base is still red.
 */
function baseBlocker(branch, base) {
  const b = branch || 'the base';
  if (!base) return `Base branch health check red (live base not read)`;
  if (base.status === 'green') return `Base branch health check red but the live base ${b} is green now: re-run the check (maintainer)`;
  if (base.status === 'red' && base.fixNext === 'present') return `base ${b} red; fix-next present: re-run the Base branch health check or re-queue (maintainer)`;
  if (base.status === 'red') return `base ${b} red: wait for a fix-forward, or fix-next if this PR is the fix`;
  return `Base branch health check red (live base ${b} unknown)`;
}

/** The blocker text for a red Reviewed or maintainer check, from the live verdict when one was read (review MJ-01). */
function reviewedBlocker(reviewed) {
  if (reviewed && reviewed.status === 'green') return `Reviewed or maintainer check red but the live verdict is green (${reviewed.reason}): re-run the check (maintainer)`;
  if (reviewed && reviewed.status === 'red') return `Reviewed or maintainer red (${reviewed.reason}, reviewer-side)`;
  if (reviewed) return 'Reviewed or maintainer red (live verdict unknown, reviewer-side)';
  return 'Reviewed or maintainer red (reviewer-side)';
}

function decideBall(v, latest, req, head, checks, queue, policies) {
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
    // Without a groups split (a hand-built summary) every failing check is author work, as before 261028-owj.
    const g = checks.groups || { author: checks.counts.fail > 0 ? ['?'] : [], base: [], reviewer: [], advisory: [] };
    if (!approvals.some((e) => head !== '' && String(e.r.commit_id || '') === head)) blockers.push('approval on an older commit');
    if (req.all.length) blockers.push(`review requests pending (${req.all.join(', ')})`);
    if (g.author.length) blockers.push('checks failing');
    const pol = policies || {};
    if (g.base.length) blockers.push(baseBlocker(v.baseRefName, pol.base));
    if (g.reviewer.length) blockers.push(reviewedBlocker(pol.reviewed));
    if (checks.counts.pending > 0) blockers.push('checks pending');
    if (v.mergeStateStatus === 'DIRTY') blockers.push('DIRTY (merge conflicts)');
    // BEHIND is deliberately absent (CTK-ADR-0012): it is reported as an informational note instead.
    if (blockers.length === 0) {
      const active = Boolean(queue && queue.mode === 'active');
      // GitHub reports BEHIND only when the base requires up-to-date branches (CTK-ADR-0012), so without an
      // active queue the merge needs an Update branch first: the maintainer's step, never the author's.
      const mergeCaveat = !active && v.mergeStateStatus === 'BEHIND' ? MERGE_CAVEAT : null;
      // A red Self-test report is advisory: it never blocks, and the ready line names it instead of saying "green".
      return ballOf('maintainer', { ready: true, reason: 'ready for maintainer', entersQueue: active, mergeCaveat, advisory: g.advisory });
    }
    const authorOwes = g.author.length > 0 || v.mergeStateStatus === 'DIRTY';
    // A stale red Reviewed or maintainer check beside a live green verdict owes no review, only a re-run.
    const reviewOwed = g.reviewer.length > 0 && !(pol.reviewed && pol.reviewed.status === 'green');
    const owner = authorOwes ? 'author' : req.all.length || reviewOwed ? 'reviewer' : 'maintainer';
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
    const advisory = Array.isArray(b.advisory) && b.advisory.length ? b.advisory.map((n) => advisoryText(n, d.policies)).join('; ') : null;
    const green = advisory ? `no blocking check red (advisory red: ${advisory})` : 'checks green';
    const base = `  ball: MAINTAINER ready (approved on the head, no change request, no pending requests, ${green}, not DIRTY`;
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
  lines.push(...policyLines(d.policies));
  const bl = ballLine(d);
  if (bl) lines.push(bl);
  if (d.mergeStateStatus === 'BEHIND') lines.push(behindNote(d.queue));
  if (d.decisionNote) lines.push(`  note: ${clean(d.decisionNote)}`);
  if (d.overlap) lines.push(...overlapLines(d.overlap));
  if (d.cr) lines.push(...crLines(d.cr));
  if (d.body) lines.push(...bodyLines(d.body));
  return lines.join('\n');
}

// ---- --cr (quick 261023-2u4, CONTEXT D1): the latest change request, its checklist, activity, re-request ----

const SEVERITIES = Object.freeze(['Blocker', 'Major', 'Minor', 'Nit']);
const MAX_ITEM = 200; // a checklist item prints cut at this length, after cleaning
const MAX_INLINE = 120; // an inline comment prints cut at this length, after cleaning
const LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/; // R3: a GitHub login

function severityName(word) {
  const w = lower(word).replace(/s$/, '');
  return SEVERITIES.find((s) => lower(s) === w) || null;
}

/** Stable sort by submitted_at: equal timestamps keep API order, so the later-listed review wins (the ball's rule). */
function bySubmitted(list) {
  return list
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      const ta = String(a.r.submitted_at || '');
      const tb = String(b.r.submitted_at || '');
      return ta < tb ? -1 : ta > tb ? 1 : a.i - b.i;
    })
    .map(({ r }) => r);
}

/** Reviews by non-bot users other than the PR author, any state, flattened and in submitted_at order. */
function humanReviews(view, reviews) {
  const author = lower(view && view.author && view.author.login);
  const flat = (Array.isArray(reviews) ? reviews : []).flat();
  return bySubmitted(flat.filter((r) => r && r.user && r.user.login && r.user.type !== 'Bot' && lower(r.user.login) !== author));
}

/**
 * D1 a: the chosen change request = the newest CHANGES_REQUESTED review by a non-bot non-author user (only
 * `reviewer` when given), and the DISMISSED reviews by the same users that are newer than it.
 *
 * @returns {{chosen: (object|null), newerDismissed: object[]}}
 */
function chooseCr(view, reviews, reviewer) {
  const pool = humanReviews(view, reviews).filter((r) => !reviewer || lower(r.user.login) === lower(reviewer));
  let at = -1;
  pool.forEach((r, i) => {
    if (r.state === 'CHANGES_REQUESTED') at = i;
  });
  if (at < 0) return { chosen: null, newerDismissed: [] };
  return { chosen: pool[at], newerDismissed: pool.slice(at + 1).filter((r) => r.state === 'DISMISSED') };
}

const COUNT_RE = /\b(\d+)\s+(blocker|major|minor|nit)s?\b|\b(blocker|major|minor|nit)s?\s+(\d+)\b/gi;

/**
 * R1: the verdict counts of one line = its severity counts (`<n> <Severity>` or `<Severity> <n>`) in order, up
 * to, not including, the first count whose severity already appeared on the line. Null unless two or more.
 */
function lineCounts(line) {
  const seen = new Set();
  const group = [];
  for (const m of String(line).matchAll(COUNT_RE)) {
    const sev = severityName(m[2] || m[3]);
    if (seen.has(sev)) break;
    seen.add(sev);
    group.push({ sev, n: Number(m[1] != null ? m[1] : m[4]), start: m.index, end: m.index + m[0].length });
  }
  if (group.length < 2) return null;
  return { sum: group.reduce((a, g) => a + g.n, 0), text: line.slice(group[0].start, group[group.length - 1].end) };
}

/** A line that is only a severity word (bold or not, as a heading or not, optional plural and colon). */
function severityLabel(line) {
  const m = /^(?:#{1,6}[ \t]+)?(?:\*\*)?[ \t]*(blocker|major|minor|nit)s?[ \t]*:?[ \t]*(?:\*\*)?[ \t]*:?[ \t]*$/i.exec(line);
  return m ? severityName(m[1]) : null;
}

/**
 * D1 b: the findings checklist, structural only. The Findings section runs from the first heading
 * /^#{1,6}\s+Findings\b/i to the next heading of the same or a higher level (a heading that is only a severity
 * word is a severity label, not a section end); fenced code is skipped. An item is a column-0 line starting
 * `N. `, `- `, `* ` or a bold `**<Severity> <n>` label; indented lines are detail. Severity = the item's own
 * bold label, else the last severity label line seen. The item count is cross-checked against the verdict
 * counts (R1, last qualifying line of the whole body): unequal -> unparsed, never a guessed list.
 *
 * @param {string} body review body
 * @returns {{status: 'matched'|'nocounts'|'unparsed'|'none', reason?: string, items: {severity: (string|null), text: string}[], structural: number, verdict: ({sum: number, text: string}|null)}}
 */
function parseChecklist(body) {
  const lines = String(body == null ? '' : body).split(/\r?\n/);
  let verdict = null;
  for (const line of lines) verdict = lineCounts(line) || verdict;
  const start = lines.findIndex((l) => /^#{1,6}\s+Findings\b/i.test(l));
  if (start < 0) return { status: 'none', reason: 'no Findings heading', items: [], structural: 0, verdict };
  const level = /^(#+)/.exec(lines[start])[1].length;
  const items = [];
  let severity = null;
  let fence = null;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    const f = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && /^\s*[`~]+\s*$/.test(line)) fence = null;
      continue;
    }
    if (f) {
      fence = f[1];
      continue;
    }
    const label = severityLabel(line);
    if (label) {
      severity = label;
      continue;
    }
    const h = /^(#{1,6})\s/.exec(line);
    if (h && h[1].length <= level) break;
    if (!/^(?:\d+\.\s|[-*]\s|\*\*(?:blocker|major|minor|nit)s?\s+\d)/i.test(line)) continue;
    const own = /^(?:\d+\.\s+|[-*]\s+)?\*\*(blocker|major|minor|nit)s?\b/i.exec(line);
    items.push({ severity: own ? severityName(own[1]) : severity, text: line.trim() });
  }
  // R2: a Findings section with no recognised item (5471174433 uses M1/m1 prefixes) is none; the grammar is not widened.
  if (items.length === 0) return { status: 'none', reason: 'the Findings section holds no recognised items', items, structural: 0, verdict };
  if (!verdict) return { status: 'nocounts', items, structural: items.length, verdict };
  if (verdict.sum !== items.length) return { status: 'unparsed', items: [], structural: items.length, verdict };
  return { status: 'matched', items, structural: items.length, verdict };
}

/** R5: a timeline event's own time (reviewed: submitted_at; committed: committer.date, else author.date; else created_at). */
function eventTime(e) {
  if (!e) return '';
  if (e.event === 'reviewed') return String(e.submitted_at || '');
  if (e.event === 'committed') return String((e.committer && e.committer.date) || (e.author && e.author.date) || '');
  return String(e.created_at || '');
}

function eventActor(e) {
  return String((e && e.actor && e.actor.login) || (e && e.user && e.user.login) || '?');
}

/** The requested user's login, or `team <slug|name>`, of a review_requested / review_request_removed event. */
function requestTarget(e) {
  if (e && e.requested_reviewer && e.requested_reviewer.login) return { kind: 'user', name: String(e.requested_reviewer.login) };
  const t = e && e.requested_team;
  if (t && (t.slug || t.name)) return { kind: 'team', name: String(t.slug || t.name) };
  return { kind: 'user', name: '?' };
}

/**
 * D1 d: the timeline events strictly later than `since`, in timeline order, one entry each; a contiguous run
 * of committed events is one entry. Other event types are dropped.
 */
function deriveActivity(timeline, since) {
  const out = [];
  for (const e of Array.isArray(timeline) ? timeline : []) {
    if (!e || !(eventTime(e) > String(since || ''))) continue;
    if (e.event === 'committed') {
      const prev = out[out.length - 1];
      if (prev && prev.kind === 'commits') {
        prev.count += 1;
        prev.last = String(e.sha || '');
      } else out.push({ kind: 'commits', count: 1, last: String(e.sha || '') });
    } else if (e.event === 'reviewed') {
      out.push({ kind: 'reviewed', login: eventActor(e), state: String(e.state || '').toUpperCase(), id: e.id == null ? '?' : String(e.id), commit: String(e.commit_id || '') });
    } else if (e.event === 'commented') {
      out.push({ kind: 'commented', login: eventActor(e), time: eventTime(e), url: String(e.html_url || '') });
    } else if (e.event === 'head_ref_force_pushed') {
      out.push({ kind: 'force-pushed', actor: eventActor(e), commit: String(e.commit_id || '') });
    } else if (e.event === 'review_requested' || e.event === 'review_request_removed') {
      const t = requestTarget(e);
      out.push({ kind: e.event === 'review_requested' ? 'requested' : 'request-removed', actor: eventActor(e), target: t.kind === 'team' ? `team ${t.name}` : t.name });
    } else if (e.event === 'review_dismissed') {
      const id = e.dismissed_review && e.dismissed_review.review_id;
      out.push({ kind: 'dismissed', actor: eventActor(e), id: id == null ? '?' : String(id) });
    }
  }
  return out;
}

/**
 * D1 e: one entry per non-bot non-author user who submitted any review, sorted by login: requested now (with
 * the last review_requested event), or what ended the last request (the first review by that login submitted
 * strictly later, or a later review_request_removed, whichever comes first), and whether a re-request is
 * needed (not requested, newest review on a commit other than the head, latest counted state
 * CHANGES_REQUESTED or DISMISSED). R4: a requested team makes that flag unknown.
 */
function deriveRerequests(view, reviews, timeline) {
  const v = view || {};
  const head = String(v.headRefOid || '');
  const entries = (Array.isArray(v.reviewRequests) ? v.reviewRequests : []).map(requestEntry).filter(Boolean);
  const users = new Set(entries.filter((e) => e.kind === 'user').map((e) => lower(e.name)));
  const teams = entries.filter((e) => e.kind === 'team').map((e) => e.name);
  const human = humanReviews(v, reviews);
  const byLogin = new Map();
  for (const r of human) {
    const k = lower(r.user.login);
    if (!byLogin.has(k)) byLogin.set(k, { login: String(r.user.login), reviews: [] });
    byLogin.get(k).reviews.push(r);
  }
  const events = Array.isArray(timeline) ? timeline : [];
  const out = [];
  for (const [k, x] of byLogin) {
    const reqs = events.filter((e) => e && e.event === 'review_requested' && requestTarget(e).kind === 'user' && lower(requestTarget(e).name) === k);
    const lastReq = reqs.length ? reqs[reqs.length - 1] : null;
    const request = lastReq ? { time: eventTime(lastReq), actor: eventActor(lastReq) } : null;
    const entry = { login: x.login, requested: users.has(k), request, ending: null, needed: false, team: null };
    if (!entry.requested) {
      if (!lastReq) entry.ending = { kind: 'never' };
      else {
        const consumed = x.reviews.find((r) => String(r.submitted_at || '') > request.time);
        const removed = events.find(
          (e) => e && e.event === 'review_request_removed' && requestTarget(e).kind === 'user' && lower(requestTarget(e).name) === k && eventTime(e) > request.time
        );
        const ct = consumed ? String(consumed.submitted_at) : null;
        const rt = removed ? eventTime(removed) : null;
        if (consumed && (!removed || ct <= rt)) entry.ending = { kind: 'consumed', id: consumed.id == null ? '?' : String(consumed.id), state: String(consumed.state || ''), time: ct };
        else if (removed) entry.ending = { kind: 'removed', actor: eventActor(removed), time: rt };
        else entry.ending = { kind: 'open' };
      }
      const newest = x.reviews[x.reviews.length - 1];
      const counted = x.reviews.filter((r) => !IGNORED_REVIEW_STATES.has(r.state));
      const latest = counted.length ? counted[counted.length - 1].state : null;
      const flag = String(newest.commit_id || '') !== head && (latest === 'CHANGES_REQUESTED' || latest === 'DISMISSED');
      if (flag && teams.length) entry.team = teams.join(', ');
      else entry.needed = flag;
    }
    out.push(entry);
  }
  return out.sort((a, b) => (lower(a.login) < lower(b.login) ? -1 : lower(a.login) > lower(b.login) ? 1 : 0));
}

/**
 * Pure --cr verdict over the reads (D1). comments = the chosen review's inline comments (null = not read).
 *
 * @returns {object} { reviewer, chosen, notes, checklist, inline, inlineError, activity, rerequest, timelineError }
 */
function deriveCr({ view, reviews, timeline, timelineError, comments, commentsError, reviewer }) {
  const v = view || {};
  const head = String(v.headRefOid || '');
  const { chosen, newerDismissed } = chooseCr(v, reviews, reviewer || null);
  const tl = Array.isArray(timeline) ? timeline : null;
  const out = {
    reviewer: reviewer || null,
    chosen: null,
    notes: [],
    checklist: null,
    inline: null,
    inlineError: null,
    activity: null,
    rerequest: tl ? deriveRerequests(v, reviews, tl) : null,
    timelineError: tl ? null : timelineError || 'timeline not read',
  };
  if (!chosen) return out;
  out.chosen = {
    id: chosen.id == null ? '?' : String(chosen.id),
    login: String(chosen.user.login),
    commitId: String(chosen.commit_id || ''),
    onHead: head !== '' && String(chosen.commit_id || '') === head,
    submittedAt: String(chosen.submitted_at || ''),
    url: String(chosen.html_url || ''),
  };
  for (const r of newerDismissed) {
    const e = (tl || []).find((x) => x && x.event === 'review_dismissed' && x.dismissed_review && String(x.dismissed_review.review_id) === String(r.id));
    if (e && lower(e.dismissed_review.state) === 'changes_requested') {
      out.notes.push({ id: String(r.id), login: String(r.user.login), actor: eventActor(e), time: eventTime(e) });
    }
  }
  out.checklist = parseChecklist(chosen.body);
  if (Array.isArray(comments)) {
    out.inline = comments.map((c) => ({
      path: String((c && c.path) || '?'),
      line: c && c.line != null ? String(c.line) : c && c.original_line != null ? String(c.original_line) : '?',
      body: String((c && c.body) || ''),
    }));
  } else out.inlineError = commentsError || 'inline comments not read';
  if (tl) out.activity = deriveActivity(tl, out.chosen.submittedAt);
  return out;
}

function cut(s, n) {
  return s.length > n ? s.slice(0, n) : s;
}

function activityLine(a) {
  if (a.kind === 'commits') return `  activity: ${a.count} commit(s) pushed, last ${clean(short(a.last, 7))}`;
  if (a.kind === 'reviewed') return `  activity: reviewed ${clean(a.login)} ${clean(a.state)} review ${clean(a.id)} on ${clean(short(a.commit, 7))}`;
  if (a.kind === 'commented') return `  activity: commented ${clean(a.login)} ${clean(a.time)} ${clean(a.url)}`;
  if (a.kind === 'force-pushed') return `  activity: force-pushed by ${clean(a.actor)} to ${clean(short(a.commit, 7))}`;
  if (a.kind === 'requested') return `  activity: review requested by ${clean(a.actor)} -> ${clean(a.target)}`;
  if (a.kind === 'request-removed') return `  activity: review request removed by ${clean(a.actor)} -> ${clean(a.target)}`;
  return `  activity: review ${clean(a.id)} dismissed by ${clean(a.actor)}`;
}

function rerequestLine(x) {
  if (x.requested) {
    const since = x.request ? `since ${clean(x.request.time)} by ${clean(x.request.actor)}` : 'no review_requested event on the timeline';
    return `  rerequest: ${clean(x.login)} requested now (${since})`;
  }
  const req = x.request ? `the ${clean(x.request.time)} request by ${clean(x.request.actor)}` : '';
  const e = x.ending;
  let ending;
  if (e.kind === 'never') ending = 'never requested on the timeline';
  else if (e.kind === 'consumed') ending = `${req} was consumed by review ${clean(e.id)} (${clean(e.state)}) at ${clean(e.time)}`;
  else if (e.kind === 'removed') ending = `${req} was removed by ${clean(e.actor)} at ${clean(e.time)}`;
  else ending = `${req} has no consuming review or removal on the timeline`;
  const flag = x.needed ? ' RE-REQUEST NEEDED' : x.team ? ` re-request unknown (team ${clean(x.team)} requested; membership not resolved)` : '';
  return `  rerequest: ${clean(x.login)} not requested; ${ending}${flag}`;
}

/** The --cr lines of one PR block. */
function crLines(cr) {
  const lines = [];
  if (!cr.chosen) {
    lines.push(`  cr: none (no CHANGES_REQUESTED review by a non-bot non-author user${cr.reviewer ? ' named ' + clean(cr.reviewer) : ''})`);
  } else {
    const c = cr.chosen;
    lines.push(`  cr: review ${clean(c.id)} by ${clean(c.login)} on ${clean(short(c.commitId, 7))} (${c.onHead ? 'head' : 'older commit'}) ${clean(c.submittedAt)} ${clean(c.url)}`);
    for (const n of cr.notes) {
      lines.push(`  cr: note: newer review ${clean(n.id)} by ${clean(n.login)} was dismissed by ${clean(n.actor)} ${clean(n.time)} (originally CHANGES_REQUESTED); not counted`);
    }
    const k = cr.checklist;
    const url = clean(c.url);
    if (k.status === 'none') lines.push(`  checklist: none (${clean(k.reason)}); read the review ${url}`);
    else if (k.status === 'unparsed') lines.push(`  checklist: unparsed (${k.structural} structural items, the verdict counts ${k.verdict.sum}); read the review ${url}`);
    else {
      const why = k.status === 'matched' ? `matches the verdict counts ${clean(k.verdict.text)}` : 'no verdict counts to cross-check';
      lines.push(`  checklist (${k.items.length} items; ${why})`);
      for (const it of k.items) lines.push(`    [ ] ${it.severity || '?'} ${cut(clean(it.text), MAX_ITEM)}`);
    }
    if (cr.inline == null) lines.push(`  cr: inline unknown (read failed: ${clean(cr.inlineError)})`);
    else if (cr.inline.length === 0) lines.push('  inline: none');
    else for (const i of cr.inline) lines.push(`  inline: ${clean(i.path)}:${clean(i.line)} ${cut(clean(i.body.replace(/\s+/g, ' ').trim()), MAX_INLINE)}`);
  }
  if (cr.rerequest == null) {
    lines.push(`  cr: activity and rerequest unknown (read failed: ${clean(cr.timelineError)})`);
    return lines;
  }
  if (cr.chosen) {
    if (cr.activity.length === 0) lines.push('  activity: none since the change request');
    else lines.push(...cr.activity.map(activityLine));
  }
  if (cr.rerequest.length === 0) lines.push('  rerequest: none (no review by a non-bot non-author user)');
  else lines.push(...cr.rerequest.map(rerequestLine));
  return lines;
}

// ---- --body (quick 261023-2u4, CONTEXT D2): body sha classes, Self-test report binding, files-changed ----

const SHA_CLASSES = Object.freeze(['head', 'base', 'pr commit', 'former head', 'earlier commit', 'ambiguous', 'unresolved']);
const HEX_TOKEN_RE = /\b[0-9a-fA-F]{7,40}\b/g; // \b on both sides: a hex run longer than 40 is no token
const FILES_CHANGED_RE = /\b(\d+)\s+(?:files?\s+changed|changed\s+files?)\b/gi;
const SELF_TEST_TITLE = 'self-test report';
const SYNTAX_LINE_MAX = 1000; // a longer line is never heading or fence syntax (bounded work on hostile text)

/**
 * D2 a: every sha the PR knows, each with ONE class, the first that applies in the order head, base, pr commit,
 * former head, earlier commit. base is the base sha GitHub last recorded for the PR (baseRefOid), not the live
 * base tip. Former heads = force-pushed head commits and review commits; earlier commits = committed events.
 *
 * @returns {Map<string, string>} lowercased 40-hex sha -> class
 */
function knownShas({ view, reviews, timeline, baseRefOid }) {
  const v = view || {};
  const known = new Map();
  const add = (sha, cls) => {
    const s = lower(sha);
    if (/^[0-9a-f]{7,40}$/.test(s) && !known.has(s)) known.set(s, cls);
  };
  add(v.headRefOid, 'head');
  add(baseRefOid, 'base');
  for (const c of Array.isArray(v.commits) ? v.commits : []) add(c && c.oid, 'pr commit');
  const tl = Array.isArray(timeline) ? timeline : [];
  for (const e of tl) if (e && e.event === 'head_ref_force_pushed') add(e.commit_id, 'former head');
  for (const r of (Array.isArray(reviews) ? reviews : []).flat()) add(r && r.commit_id, 'former head');
  for (const e of tl) if (e && e.event === 'committed') add(e.sha, 'earlier commit');
  return known;
}

/**
 * D2 b-c: the hex tokens of a body (7 to 40 hex characters, case-insensitive, compared lowercased), de-duplicated
 * by (token, line), in body order, each classified by prefix match: one known sha -> its class, two or more
 * distinct -> ambiguous, none -> unresolved when it holds a letter a-f, and an all-digit token that matches
 * nothing is ignored (review and comment ids are all digits).
 *
 * @returns {{counts: object, tokens: {line: number, token: string, cls: string}[]}}
 */
function classifyBodyShas(body, known) {
  const counts = Object.fromEntries(SHA_CLASSES.map((c) => [c, 0]));
  const tokens = [];
  const shas = [...known.keys()];
  String(body == null ? '' : body)
    .split(/\r?\n/)
    .forEach((text, i) => {
      const seen = new Set();
      for (const m of text.matchAll(HEX_TOKEN_RE)) {
        const token = m[0].toLowerCase();
        if (seen.has(token)) continue;
        seen.add(token);
        const hits = shas.filter((s) => s.startsWith(token));
        let cls;
        if (hits.length === 1) cls = known.get(hits[0]);
        else if (hits.length > 1) cls = 'ambiguous';
        else if (/[a-f]/.test(token)) cls = 'unresolved';
        else continue;
        counts[cls] += 1;
        tokens.push({ line: i + 1, token, cls });
      }
    });
  return { counts, tokens };
}

/** ATX heading -> { level, text } (text with ** removed, trimmed, lowercased), parsed without a backtracking regex. */
function headingOf(line) {
  const t = line.trim();
  let level = 0;
  while (level < t.length && t[level] === '#') level += 1;
  if (level < 1 || level > 6 || level >= t.length || !/\s/.test(t[level])) return null;
  let text = t.slice(level).trim();
  let end = text.length;
  while (end > 0 && text[end - 1] === '#') end -= 1;
  if (end < text.length && (end === 0 || /\s/.test(text[end - 1]))) text = text.slice(0, end).trimEnd();
  return { level, text: text.replace(/\*\*/g, '').trim().toLowerCase() };
}

/**
 * R6: the Self-test report json block, by the rule of upstream gsd-core scripts/self-test-report-policy.cjs
 * (extractReport, read 2026-10-23 from origin/next; reimplemented here, not copied): any heading level whose
 * text, with ** removed, trimmed and lowercased, is "self-test report"; the section ends at the next heading
 * of the same or a higher level; fence-aware (a # line inside a fence is no heading; a fence's first info word
 * names its language); HTML comments outside fences are skipped; the first COMPLETE json block wins.
 *
 * @returns {string|null} the block's text, or null when the section or a complete block is absent
 */
function selfTestBlock(body) {
  let fence = null; // { ch, len, capture }
  let inComment = false;
  let level = 0;
  let captured = [];
  for (const full of String(body == null ? '' : body).split(/\r?\n/)) {
    const line = full.length > SYNTAX_LINE_MAX ? full.slice(0, SYNTAX_LINE_MAX) : full;
    if (!fence) {
      if (inComment) {
        if (line.includes('-->')) inComment = false;
        continue;
      }
      const at = line.indexOf('<!--');
      if (at !== -1 && line.indexOf('-->', at + 4) === -1) {
        inComment = true;
        continue;
      }
      const open = /^\s*(`{3,}|~{3,})\s*([^\s`]*)(?:\s.*)?$/.exec(line);
      if (open) {
        fence = { ch: open[1][0], len: open[1].length, capture: level > 0 && open[2].toLowerCase() === 'json' };
        captured = [];
        continue;
      }
      const h = headingOf(line);
      if (h) {
        if (level === 0 && h.text === SELF_TEST_TITLE) level = h.level;
        else if (level > 0 && h.level <= level) return null;
      }
      continue;
    }
    const close = /^\s*(`{3,}|~{3,})\s*$/.exec(line);
    if (close && close[1][0] === fence.ch && close[1].length >= fence.len) {
      if (fence.capture) return captured.join('\n');
      fence = null;
      continue;
    }
    if (fence.capture) captured.push(full);
  }
  return null;
}

/**
 * D2 d: the Self-test report's binding to the head: bound (head_sha equals the head, case-insensitive), stale
 * (another head_sha), none (no section or no complete json block), unparsable (the block is not JSON), or
 * no-head-sha (JSON without a string head_sha).
 */
function selfTestBinding(body, head) {
  const block = selfTestBlock(body);
  if (block == null) return { status: 'none' };
  let report;
  try {
    report = JSON.parse(block);
  } catch {
    return { status: 'unparsable' };
  }
  const sha = report && typeof report === 'object' && typeof report.head_sha === 'string' ? report.head_sha : null;
  if (sha == null) return { status: 'no-head-sha' };
  if (lower(sha) === lower(head) && head !== '') return { status: 'bound', headSha: sha };
  return { status: 'stale', headSha: sha };
}

/** D2 e: the `<n> files changed` / `<n> changed files` phrases (singular too) that disagree with changedFiles. */
function filesChangedMismatches(body, changedFiles) {
  const out = [];
  if (!Number.isInteger(changedFiles)) return out;
  String(body == null ? '' : body)
    .split(/\r?\n/)
    .forEach((text, i) => {
      for (const m of text.matchAll(FILES_CHANGED_RE)) {
        if (Number(m[1]) !== changedFiles) out.push({ line: i + 1, phrase: m[0], n: Number(m[1]) });
      }
    });
  return out;
}

/**
 * Pure --body verdict (D2). bodyView = the `gh pr view --json body,baseRefOid,changedFiles` reply (null = the
 * read failed, bodyError names why).
 */
function deriveBody({ view, reviews, timeline, timelineError, bodyView, bodyError }) {
  if (!bodyView) return { error: bodyError || 'body not read' };
  const v = view || {};
  const head = String(v.headRefOid || '');
  const body = String(bodyView.body == null ? '' : bodyView.body);
  const known = knownShas({ view: v, reviews, timeline, baseRefOid: bodyView.baseRefOid });
  const { counts, tokens } = classifyBodyShas(body, known);
  const changedFiles = Number.isInteger(bodyView.changedFiles) ? bodyView.changedFiles : null;
  return {
    head,
    base: String(bodyView.baseRefOid || ''),
    counts,
    tokens,
    selfTest: selfTestBinding(body, head),
    changedFiles,
    filesChanged: filesChangedMismatches(body, changedFiles),
    timelineError: Array.isArray(timeline) ? null : timelineError || 'timeline not read',
  };
}

/** The --body lines of one PR block. */
function bodyLines(b) {
  if (b.error) return [`  body: unknown (read failed: ${clean(b.error)})`];
  const lines = [];
  const counts = SHA_CLASSES.map((c) => `${b.counts[c]} ${c}`).join(', ');
  lines.push(
    `  body: shas ${counts} (compared against head ${clean(short(b.head, 9))}; base is the base sha GitHub last recorded for the PR, not the live base tip)`
  );
  // review F6: say outright when the body never names the current head (a body written for an earlier head)
  if (b.counts.head === 0) lines.push(`  body: no token names the head ${clean(short(b.head, 9))}`);
  for (const t of b.tokens) {
    if (t.cls === 'head' || t.cls === 'base') continue;
    const check = t.cls === 'unresolved' ? ' (may be an older base or an unrelated commit: check)' : '';
    lines.push(`    L${t.line} ${clean(t.token)} ${t.cls}${check}`);
  }
  if (b.timelineError) {
    lines.push(`  body: timeline unknown (read failed: ${clean(b.timelineError)}); former heads come from the reviews only and earlier commits are not known`);
  }
  const s = b.selfTest;
  if (s.status === 'bound') lines.push('  body: Self-test report bound to the head');
  else if (s.status === 'stale') lines.push(`  body: Self-test report STALE (head_sha ${clean(s.headSha)}, head ${clean(b.head)})`);
  else if (s.status === 'unparsable') lines.push('  body: Self-test report unparsable JSON');
  else if (s.status === 'no-head-sha') lines.push('  body: Self-test report has no head_sha string');
  else lines.push('  body: Self-test report none');
  lines.push(`  body: counts checked: files-changed phrases only (changedFiles ${b.changedFiles == null ? 'unknown' : b.changedFiles})`);
  for (const m of b.filesChanged) lines.push(`    L${m.line} "${clean(m.phrase)}" says ${m.n}`);
  return lines;
}

// ---- gsd-core CI checks (quick 261028-owj, CTK-ADR-0012): base health, reviewed-or-maintainer, self-test ----
//
// The verdicts are the LIVE gsd-core scripts' (CTK-ADR-0001: no vendored fallback, no copied rule). Everything
// here is reading (REST GETs through `gh api`), shaping the input those scripts take, and printing what they
// answer. Any failed read or incomplete input makes that verdict `unknown (<why>)`; nothing here throws into
// the PR block or changes the exit code (fail open to informational).

const LIVE_SCRIPTS = Object.freeze({
  ci: 'scripts/ci-next-health.cjs',
  reviewed: 'scripts/reviewed-or-maintainer-policy.cjs',
  selfTest: 'scripts/self-test-report-policy.cjs',
});

function newPolicyCache() {
  return { sources: null, base: new Map(), maintainers: new Map(), permissions: new Map() };
}

/** Best-effort `git rev-parse HEAD` of the checkout the policies came from ('' when unreadable). */
function checkoutHead(root) {
  try {
    const out = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim();
    return /^[0-9a-f]{40}$/.test(out) ? out : '';
  } catch {
    return '';
  }
}

/**
 * The three LIVE policy modules, loaded once per run. deps.policies (tests) injects them; deps.policyRoot names
 * the only root to try; otherwise GSD_CORE_ROOT, ~/repos/gsd-core, ~/gsd-core in that order (never the cwd: review MJ-02)
 * (each through resolveGsdCoreRoot, so the sentinel layout applies). A throw anywhere is the one `error` that
 * makes every verdict unknown.
 *
 * @returns {{ok: true, root: string, head: string, ci: object, reviewed: object, selfTest: object} | {ok: false, error: string}}
 */
function loadPolicySources(deps, cache) {
  if (cache.sources) return cache.sources;
  let result;
  try {
    if (deps.policies) {
      const p = deps.policies;
      result = { ok: true, root: String(p.root || '(injected)'), head: String(p.head || ''), ci: p.ciNextHealth, reviewed: p.reviewedOrMaintainer, selfTest: p.selfTestReport };
    } else {
      const { resolveGsdCoreRoot, requireLiveScript } = require('../hooks/lib/resolve.cjs');
      const home = os.homedir();
      // Never the cwd (review MJ-02): run from a worktree of a PR head, the PR's own edited policy would judge
      // the PR with the user's gh token. Upstream CI checks the scripts out at the BASE sha for the same reason.
      // A relative GSD_CORE_ROOT would resolve against the cwd, so only an absolute one counts (refute pass C3).
      const envRoot = process.env.GSD_CORE_ROOT && path.isAbsolute(process.env.GSD_CORE_ROOT) ? process.env.GSD_CORE_ROOT : null;
      const candidates = deps.policyRoot ? [deps.policyRoot] : [envRoot, path.join(home, 'repos', 'gsd-core'), path.join(home, 'gsd-core')].filter(Boolean);
      let root = null;
      for (const c of candidates) {
        try {
          root = resolveGsdCoreRoot(c);
          break;
        } catch {
          // try the next candidate
        }
      }
      if (!root) throw new Error(`no gsd-core checkout resolvable (tried ${candidates.join(', ')})`);
      result = {
        ok: true,
        root,
        head: checkoutHead(root),
        ci: requireLiveScript(root, LIVE_SCRIPTS.ci),
        reviewed: requireLiveScript(root, LIVE_SCRIPTS.reviewed),
        selfTest: requireLiveScript(root, LIVE_SCRIPTS.selfTest),
      };
    }
  } catch (err) {
    result = { ok: false, error: firstErrorLine(err) };
  }
  cache.sources = result;
  return result;
}

function needFunctions(mod, names, what) {
  for (const n of names) if (!mod || typeof mod[n] !== 'function') throw new Error(`${what} does not export ${n}`);
}

/** fix-next on the PR: present, absent, or unknown (the view carries no labels list, as old captures do not). */
function fixNextState(view, label) {
  if (!view || !Array.isArray(view.labels) || typeof label !== 'string') return 'unknown';
  return view.labels.some((l) => (l && typeof l === 'object' ? l.name : l) === label) ? 'present' : 'absent';
}

/**
 * The base branch's Tests health, through the LIVE classifyBaseRuns (sync). The read mirrors the fetcher in
 * gsd-core scripts/ci-next-health.cjs main() (source sha 65638993a): newest push-event runs of the Tests workflow
 * file on the base, and when the newest run has run_attempt > 1 its previous attempt's conclusion is attached (an
 * unreadable attempt reads 'unknown', as upstream does). Cached per repo and base for the run.
 */
function readBaseHealth(repo, branch, deps, cache, src) {
  const key = `${repo}\0${branch}`;
  if (cache.base.has(key)) return cache.base.get(key);
  const gh = deps.gh || defaultGh;
  let out;
  try {
    if (!BRANCH_PATTERN.test(branch)) throw new Error(`base branch name not usable in a path: ${branch}`);
    needFunctions(src.ci, ['classifyBaseRuns'], 'ci-next-health.cjs');
    if (typeof src.ci.TESTS_WORKFLOW_FILE !== 'string') throw new Error('ci-next-health.cjs does not export TESTS_WORKFLOW_FILE');
    let payload;
    try {
      payload = gh(['api', `repos/${repo}/actions/workflows/${src.ci.TESTS_WORKFLOW_FILE}/runs?branch=${encodeURIComponent(branch)}&event=push&per_page=5`]);
    } catch (err) {
      throw new Error(`workflow runs read failed: ${firstErrorLine(err)}`);
    }
    const newest = payload && Array.isArray(payload.workflow_runs) ? payload.workflow_runs[0] : undefined;
    // classifyBaseRuns ignores the field on a completed run, so read the attempt whenever run_attempt > 1
    // (its in-flight test is not exported).
    if (newest && Number(newest.run_attempt) > 1) {
      try {
        const prev = gh(['api', `repos/${repo}/actions/runs/${encodeURIComponent(String(newest.id))}/attempts/${Number(newest.run_attempt) - 1}`]);
        newest.previous_attempt_conclusion = prev && typeof prev.conclusion === 'string' ? prev.conclusion : 'unknown';
      } catch (err) {
        // Upstream CI reads a failed attempt read as not-success (RED, fail closed: it is a gate). pr-status is a
        // report (CTK-ADR-0012 Decision 3): a verdict resting on a read that failed is unknown (refute pass C4).
        throw new Error(`previous attempt read failed: ${firstErrorLine(err)}`);
      }
    }
    const c = src.ci.classifyBaseRuns(payload);
    const V = src.ci.VERDICT || {};
    const run = c && c.run
      ? { sha: String(c.run.head_sha || ''), conclusion: c.run.conclusion == null ? null : String(c.run.conclusion), status: String(c.run.status || ''), attempt: Number(c.run.run_attempt) || null, url: String(c.run.html_url || '') }
      : null;
    if (c && c.verdict === V.RED) out = { status: 'red', reason: String(c.reason), run };
    else if (c && c.verdict === V.CLEAN) out = { status: 'green', reason: String(c.reason), run };
    else out = { status: 'unknown', error: `Tests health indeterminate (${c && c.reason})` };
  } catch (err) {
    out = { status: 'unknown', error: firstErrorLine(err) };
  }
  cache.base.set(key, out);
  return out;
}

function baseVerdict(repo, v, part, deps, cache, src) {
  const branch = String(v.baseRefName || '');
  const facts = {
    branch,
    requiredRed: part.requiredRed,
    baseHealthRed: part.baseHealthRed,
    attributed: part.attributed,
    othersFailing: part.otherTests,
    fixNext: src.ok ? fixNextState(v, src.ci && src.ci.BYPASS_LABEL) : 'unknown',
  };
  if (!src.ok) return { ...facts, status: 'unknown', error: `policy scripts unavailable: ${src.error}` };
  return { ...facts, ...readBaseHealth(repo, branch, deps, cache, src) };
}

/** The base branch's .github/MAINTAINERS text at the base sha (the branch name when the view has no baseRefOid), cached. */
function readMaintainers(repo, v, deps, cache) {
  const sha = /^[0-9a-f]{40}$/i.test(String(v.baseRefOid || '')) ? String(v.baseRefOid) : '';
  const ref = sha || String(v.baseRefName || '');
  const key = `${repo}\0${ref}`;
  if (!cache.maintainers.has(key)) {
    const gh = deps.gh || defaultGh;
    let out;
    try {
      if (!BRANCH_PATTERN.test(ref)) throw new Error(`no usable base ref in the PR view: ${ref}`);
      const reply = gh(['api', `repos/${repo}/contents/.github/MAINTAINERS?ref=${encodeURIComponent(ref)}`]);
      if (!reply || reply.encoding !== 'base64' || typeof reply.content !== 'string') throw new Error('contents reply is not a base64 file');
      out = { text: Buffer.from(reply.content, 'base64').toString('utf8'), refKind: sha ? 'sha' : 'branch', ref };
    } catch (err) {
      out = { error: `MAINTAINERS read failed: ${firstErrorLine(err)}` };
    }
    cache.maintainers.set(key, out);
  }
  return cache.maintainers.get(key);
}

/** One collaborator's role_name (cached per repo and login); throws when the read fails or has no role_name. */
function readRole(repo, login, deps, cache) {
  const key = `${repo}\0${login.toLowerCase()}`;
  if (!cache.permissions.has(key)) {
    const gh = deps.gh || defaultGh;
    let out;
    try {
      const reply = gh(['api', `repos/${repo}/collaborators/${encodeURIComponent(login)}/permission`]);
      if (!reply || typeof reply.role_name !== 'string') throw new Error('permission reply has no role_name');
      out = { role: reply.role_name };
    } catch (err) {
      out = { error: `permission read failed for ${login}: ${firstErrorLine(err)}` };
    }
    cache.permissions.set(key, out);
  }
  const got = cache.permissions.get(key);
  if (got.error) throw new Error(got.error);
  return got.role;
}

/** Fail-closed shaping of what evaluateReviewed takes; reviewed-or-maintainer.yml is the workflow it mirrors. */
function reviewedVerdict(repo, pr, deps, cache, src) {
  if (!src.ok) return { status: 'unknown', error: `policy scripts unavailable: ${src.error}` };
  const v = pr.view || {};
  try {
    needFunctions(src.reviewed, ['parseMaintainers', 'evaluateReviewed'], 'reviewed-or-maintainer-policy.cjs');
    const author = String((v.author && v.author.login) || '');
    const head = String(v.headRefOid || '');
    if (!author || !/^[0-9a-f]{40}$/i.test(head)) throw new Error('the view lacks the author login or a 40-hex head sha');
    // A reviews reply of another shape was flattened to [] by fetchPr: never a definite verdict from it (refute pass C4).
    if (pr.reviewsShapeOk === false) throw new Error('the reviews reply was not an array of pages');
    const m = readMaintainers(repo, v, deps, cache);
    if (m.error) throw new Error(m.error);
    const parsed = src.reviewed.parseMaintainers(m.text);
    const maintainers = parsed.ok ? parsed.logins : new Set();
    const flat = (Array.isArray(pr.reviews) ? pr.reviews : []).flat().filter((r) => r && r.user && r.user.login);
    // The workflow reads the permission of every login with an APPROVED review; the author and bots never
    // count (the policy skips them), and a maintainer author needs no approver, so those reads are skipped.
    const authorIsMaintainer = maintainers.has(author.toLowerCase());
    const byLogin = (a, b) => (lower(a) < lower(b) ? -1 : lower(a) > lower(b) ? 1 : 0);
    const candidates = authorIsMaintainer
      ? []
      : [
          ...new Set(
            flat
              .filter((r) => r.state === 'APPROVED' && r.user.type !== 'Bot' && LOGIN_PATH_PATTERN.test(String(r.user.login)) && lower(r.user.login) !== lower(author))
              .map((r) => String(r.user.login))
          ),
        ].sort(byLogin);
    const roles = {};
    for (const login of candidates) roles[login.toLowerCase()] = readRole(repo, login, deps, cache);
    // reviewsComplete is true for the reason the workflow states: `gh api --paginate --slurp` returns every page or throws.
    const input = { authorLogin: author, maintainers, reviews: flat, roles, headSha: head, reviewsComplete: true };
    const res = src.reviewed.evaluateReviewed(input);
    let approver = null;
    if (res.ok && !authorIsMaintainer) {
      // Which approver satisfied it: ask the same policy about each candidate alone (no rule is re-derived here).
      approver =
        candidates.find((login) => {
          const lc = login.toLowerCase();
          return src.reviewed.evaluateReviewed({ ...input, reviews: flat.filter((r) => lower(r.user.login) === lc), roles: { [lc]: roles[lc] } }).ok;
        }) || null;
    }
    return { status: res.ok ? 'green' : 'red', reason: String(res.reason), approver, maintainersRef: m.refKind === 'branch' ? m.ref : null };
  } catch (err) {
    return { status: 'unknown', error: firstErrorLine(err) };
  }
}

function selfTestVerdict(repo, pr, opts, deps, cache, src) {
  if (!src.ok) return { status: 'unknown', error: `policy scripts unavailable: ${src.error}` };
  const v = pr.view || {};
  try {
    needFunctions(src.selfTest, ['evaluateSelfTestReport'], 'self-test-report-policy.cjs');
    needFunctions(src.reviewed, ['parseMaintainers'], 'reviewed-or-maintainer-policy.cjs');
    // Without a string headRefName and title the policy would read the PR as "not a fix" and answer ok_not_a_fix.
    if (typeof v.headRefName !== 'string' || typeof v.title !== 'string') throw new Error('the view lacks headRefName/title, so a fix PR cannot be told from another');
    const author = String((v.author && v.author.login) || '');
    const head = String(v.headRefOid || '');
    if (!author || !/^[0-9a-f]{40}$/i.test(head)) throw new Error('the view lacks the author login or a 40-hex head sha');
    const bodyView = opts && opts.bodyView;
    if (!bodyView || typeof bodyView.body !== 'string') throw new Error(`body not read${opts && opts.bodyError ? `: ${opts.bodyError}` : ''}`);
    const m = readMaintainers(repo, v, deps, cache);
    if (m.error) throw new Error(m.error);
    const parsed = src.reviewed.parseMaintainers(m.text);
    const res = src.selfTest.evaluateSelfTestReport({
      body: bodyView.body,
      headRef: v.headRefName,
      title: v.title,
      authorLogin: author,
      headSha: head,
      maintainers: parsed.ok ? parsed.logins : new Set(),
    });
    return { status: res.ok ? 'green' : 'red', reason: String(res.reason), problem: Array.isArray(res.problems) && res.problems.length ? String(res.problems[0]) : null };
  } catch (err) {
    return { status: 'unknown', error: firstErrorLine(err) };
  }
}

/**
 * The three gsd-core CI-check verdicts of one PR (null when no such check is on it). Reads are gated to
 * relevance: workflow runs only when Required tests or Base branch health fails; MAINTAINERS and permissions
 * only when Reviewed or maintainer is present, or Self-test report is present with --body (the only time its
 * verdict is computed; without --body a red one says to run with --body). Never throws.
 *
 * @param {string} repo owner/name
 * @param {{view: object, reviews: object[], checks: object[]}} pr fetchPr result
 * @param {{body?: boolean, bodyView?: (object|null), bodyError?: (string|null)}} opts
 * @param {{gh?: Function, policies?: object, policyRoot?: string}} [deps] deps.policies injects the three modules
 *   ({ciNextHealth, reviewedOrMaintainer, selfTestReport, root?, head?}); deps.policyRoot names the only root tried
 * @param {object} [cache] newPolicyCache(), shared across the PRs of one run
 * @returns {{source: (object|null), base: (object|null), reviewed: (object|null), selfTest: (object|null)}|null}
 */
function fetchPolicies(repo, pr, opts, deps = {}, cache = newPolicyCache()) {
  const checks = Array.isArray(pr && pr.checks) ? pr.checks : [];
  const v = (pr && pr.view) || {};
  const part = partitionChecks(checks);
  const present = (n) => checks.some((c) => c && c.name === n);
  const wantBase = part.requiredRed || part.baseHealthRed;
  const wantReviewed = present(CHECK_REVIEWED);
  const selfRed = part.groups.advisory.length > 0;
  const wantSelf = present(CHECK_SELF_TEST) && Boolean(opts && opts.body);
  if (!wantBase && !wantReviewed && !wantSelf && !selfRed) return null;
  const out = { source: null, base: null, reviewed: null, selfTest: null };
  if (selfRed && !wantSelf) out.selfTest = { status: 'red', reason: null, needsBody: true };
  if (!wantBase && !wantReviewed && !wantSelf) return out;
  try {
    const src = loadPolicySources(deps, cache);
    out.source = src.ok ? { status: 'live', root: src.root, head: src.head } : { status: 'unknown', error: src.error };
    if (wantBase) out.base = baseVerdict(repo, v, part, deps, cache, src);
    if (wantReviewed) out.reviewed = reviewedVerdict(repo, pr, deps, cache, src);
    if (wantSelf) out.selfTest = selfTestVerdict(repo, pr, opts, deps, cache, src);
  } catch (err) {
    out.source = out.source || { status: 'unknown', error: firstErrorLine(err) };
  }
  return out;
}

/** What the ready line says about an advisory-red check: its policy reason, or why there is none. */
function advisoryText(name, policies) {
  const st = policies && policies.selfTest;
  if (name === CHECK_SELF_TEST && st && st.reason) return `${name} ${st.reason}`;
  if (name === CHECK_SELF_TEST && st && st.status === 'unknown') return `${name} (verdict unknown)`;
  // No policies read at all (bin/issue-status.cjs reuses derive): name the check, never a flag that caller lacks.
  if (!policies) return name;
  return `${name} (${NEEDS_BODY})`;
}

function baseLine(b) {
  const br = clean(b.branch) || '-';
  let head;
  if (b.status === 'unknown') head = `${br} unknown (${clean(b.error) || 'unknown error'})`;
  else {
    const state = b.status === 'red' ? 'RED' : 'green now';
    const run = b.run
      ? ` (Tests run on ${clean(short(b.run.sha, 12))}, conclusion ${clean(b.run.conclusion || b.run.status || 'unknown')}, reason ${clean(b.reason)})${b.run.url ? ' ' + clean(b.run.url) : ''}`
      : ` (no Tests push run found on ${br}, reason ${clean(b.reason)})`;
    head = `${br} ${state}${run}`;
  }
  let note = null;
  if (b.requiredRed && b.attributed) {
    note = 'Required tests red is base health, not this PR';
    if (b.status === 'green') note += ', but the live base is green now: re-run the check';
  } else if (b.requiredRed && b.othersFailing.length) {
    // Only "not only" when Base branch health is itself red; with it passing the base is no part of the red.
    note = b.baseHealthRed
      ? `Required tests red is not only base health: also failing ${b.othersFailing.map(clean).join(', ')}`
      : `Required tests red is not base health (the Base branch health check passed): also failing ${b.othersFailing.map(clean).join(', ')}`;
  }
  else if (b.requiredRed) note = 'Required tests red is not attributed to base health (the Base branch health check is not failing)';
  else if (b.baseHealthRed && b.status === 'green') note = 'Base branch health red is from an earlier run: the live base is green now, re-run the check';
  else if (b.baseHealthRed) note = 'Base branch health red is the base, not this PR';
  return `  base: ${head}${note ? `; ${note}` : ''} (fix-next: ${clean(b.fixNext)})`;
}

const REVIEWED_WHY = Object.freeze({
  fail_no_approval: 'no current-head approval from a write-access reviewer; author not in MAINTAINERS',
  fail_stale_approval_only: 'a write-access approval exists but not on the current head; author not in MAINTAINERS',
});

function reviewedLine(r) {
  if (r.status === 'unknown') return `  reviewed-or-maintainer: unknown (${clean(r.error) || 'unknown error'})`;
  const ref = r.maintainersRef ? `; MAINTAINERS read at branch ${clean(r.maintainersRef)}, the view has no base sha` : '';
  if (r.status === 'green') return `  reviewed-or-maintainer: green (${clean(r.reason)}${r.approver ? ' by ' + clean(r.approver) : ''})${ref}`;
  const why = REVIEWED_WHY[r.reason] ? `: ${REVIEWED_WHY[r.reason]}` : '';
  return `  reviewed-or-maintainer: red (${clean(r.reason)}${why}); reviewer-side, not author work${ref}`;
}

function selfTestLine(s) {
  if (s.status === 'unknown') return `  self-test: unknown (${clean(s.error) || 'unknown error'})`;
  if (s.needsBody) return `  self-test: red (${NEEDS_BODY})`;
  if (s.status === 'green') return `  self-test: green (${clean(s.reason)})`;
  if (s.reason === 'fail_suite_not_passed') return `  self-test: red (fail_suite_not_passed: ${SUITE_ADVISORY})`;
  const problem = s.problem ? cut(clean(String(s.problem).replace(/\s+/g, ' ').trim()), MAX_MESSAGE) : '';
  return `  self-test: red (${clean(s.reason)}${problem ? ': ' + problem : ''})`;
}

/** The policies / base / reviewed-or-maintainer / self-test lines of one PR block (empty when none was consulted). */
/** A path under the home dir printed as ~/..., so a pasted snapshot does not carry the user's home path (review NT-03). */
function tildeHome(p) {
  const home = os.homedir();
  const s = String(p == null ? '' : p);
  return home && (s === home || s.startsWith(home + path.sep)) ? '~' + s.slice(home.length) : s;
}

function policyLines(p) {
  const lines = [];
  if (!p) return lines;
  if (p.source) {
    lines.push(
      p.source.status === 'live'
        ? `  policies: LIVE gsd-core scripts at ${clean(tildeHome(p.source.root))} HEAD ${p.source.head ? clean(short(p.source.head, 9)) : 'unknown'}`
        : `  policies: unknown (${clean(p.source.error) || 'unknown error'})`
    );
  }
  if (p.base) lines.push(baseLine(p.base));
  if (p.reviewed) lines.push(reviewedLine(p.reviewed));
  if (p.selfTest) lines.push(selfTestLine(p.selfTest));
  return lines;
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
  let cr = false;
  let body = false;
  let reviewer = null;
  let repo = DEFAULT_REPO;
  const numbers = [];
  const list = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < list.length; i += 1) {
    const a = String(list[i]);
    if (a === '--json') json = true;
    else if (a === '--overlap') overlap = true;
    else if (a === '--cr') cr = true;
    else if (a === '--body') body = true;
    else if (a === '--reviewer' || a.startsWith('--reviewer=')) {
      const value = a === '--reviewer' ? list[++i] : a.slice('--reviewer='.length);
      if (value == null || !LOGIN_PATTERN.test(String(value))) return { usageError: `bad --reviewer value (not a GitHub login): ${clean(value)}` };
      reviewer = String(value);
    }
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
  if (reviewer != null && !cr) return { usageError: '--reviewer needs --cr' };
  return { json, overlap, cr, body, reviewer, repo, numbers };
}

/**
 * CLI entry. Returns the exit code: 0 ok, 1 when any PR read failed, 2 usage.
 *
 * @param {string[]} argv
 * @param {{gh?: Function, sleep?: Function, stdout?: {write: Function}, stderr?: {write: Function}, policies?: object, policyRoot?: string}} [deps]
 *   policies injects the three gsd-core policy modules (tests); policyRoot names the only gsd-core root to load them from
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
  const policyCache = newPolicyCache(); // policy modules, base runs, MAINTAINERS and permissions: once per run
  const results = args.numbers.map((n) => {
    try {
      const pr = fetchPr(n, args.repo, deps, { timeline: args.cr || args.body });
      const base = String((pr.view && pr.view.baseRefName) || '');
      if (!queues.has(base)) queues.set(base, fetchQueue(args.repo, base, deps));
      const overlap = args.overlap ? fetchOverlap(args.repo, pr.view, deps) : null;
      const cr = args.cr ? fetchCr(n, args.repo, pr, args.reviewer, deps) : null;
      const bodySink = {};
      const body = args.body ? fetchBody(n, args.repo, pr, deps, bodySink) : null;
      const policies = fetchPolicies(args.repo, pr, { body: args.body, bodyView: bodySink.bodyView, bodyError: bodySink.bodyError }, deps, policyCache);
      return { repo: args.repo, ...derive({ ...pr, queue: queues.get(base), overlap, cr, body, policies }) };
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
    const consulted = results.some((d) => d.policies && d.policies.source);
    out.write(blocks.join('\n\n') + '\n\n' + FOOTER + '\n' + (args.cr || args.body ? CR_FOOTER + '\n' : '') + (consulted ? POLICY_FOOTER + '\n' : ''));
  }
  return failed ? 1 : 0;
}

module.exports = {
  ballLineOf: ballLine,
  bodyLines,
  chooseCr,
  classifyBodyShas,
  clean,
  crLines,
  derive,
  deriveActivity,
  deriveBody,
  deriveCr,
  deriveDismissals,
  deriveOverlap,
  deriveQueue,
  deriveRerequests,
  fetchBody,
  fetchCr,
  fetchOverlap,
  fetchPolicies,
  fetchPr,
  fetchQueue,
  firstErrorLine,
  formatText,
  knownShas,
  parseChecklist,
  partitionChecks,
  policyLines,
  runCli,
  selfTestBinding,
  selfTestBlock,
};

if (require.main === module) process.exitCode = runCli(process.argv.slice(2));
