#!/usr/bin/env node
'use strict';

/**
 * hooks/review-artifact.cjs — PreToolUse(Bash) ENF-20 review-side artifact gate
 * (CTK-ADR-0004, HARD-01 fail-closed, HARD-04 robust-parse, ENF-15 synonym coverage).
 *
 * THE INVERSION THIS CLOSES. `full-system-map.md:156-162` measured the toolkit and found
 * **13 blocking gates across 19 ENF codes on the AUTHORING side, and zero across the 23
 * ADJUDICATING steps.** The side with less authority (proposing a change a maintainer must
 * still approve) carried all the enforcement; the side with more authority — approving,
 * dismissing, merging, all outward-facing and effectively irreversible — carried none.
 *
 * A hook cannot evaluate judgement, and this gate does not try. It mechanizes the FOUR
 * re-review steps that are pure artifact-EXISTENCE checks (`full-system-map.md:169-174`):
 *
 *   step 8  -> `gh pr review`   two orthogonal isolated passes (`/code-review` AND
 *                               `/security-review`) recorded for THIS head oid.
 *   step 10 -> a CLEAR verdict  the exogenous self-check, required before any CLEAR/Approve.
 *   step 13 -> `gh pr merge`    the `merge=#n` token, green CI conclusions, and a CI re-fetch
 *                               that POST-DATES the last analysis artifact.
 *   step 1  -> a re-review post the treadmill guard: no second round on an unchanged head oid.
 *
 * ONE ENGINE (CTK-ADR-0004 §Decision.1). This is not a second gate system. It reuses
 * `lib/argv` (HARD-04 robust parse), `lib/classify` (ENF-15 synonym coverage, extended by
 * ENF-20/T1 with the five review-side actions), `lib/failclosed` (HARD-01 and the ONE
 * `GSD_CONTRIB_OVERRIDE` receipt channel), `lib/resolve`, `lib/scaffold` (T2) — and it
 * reuses ENF-19's OWN assertion predicates (`checkAssertion`/`readPath`/`isNonEmpty` from
 * `protocol-artifact.cjs`) rather than reimplementing them, so there is exactly one
 * predicate vocabulary, one override env var, one receipt log and one failure posture.
 *
 * ARMING (CTK-ADR-0004 §Decision.3) — BY CONTEXT, never a manual arm file, because a manual
 * arm is itself an unobservable step and so simply would not be performed. The arm here is
 * NOT the branch (ENF-19's arm): a maintainer re-reviews someone else's PR from `next`. The
 * arm is *the command being a review-side verb against a pull request*. Ordinary local work
 * — `git status`, `git commit`, `gh pr create`, `gh pr diff`, an ordinary issue comment —
 * never classifies to a governed action and is therefore untouched, with no lookup, no
 * scaffold and no deny.
 *
 * KEYED TO PR NUMBER + HEAD OID. An artifact keyed to the PR number alone would be satisfied
 * by a stale review of an older push — the exact staleness bug ENF-05 solved by keying its
 * marker to `git write-tree`, and that ENF-19 mirrors for the gsd-test matrix. So the payload
 * area is `.gsd/contrib/pr-<n>-<oid12>/` (`.gsd` is gitignored in gsd-core, so review
 * artifacts can never enter a PR), and each artifact ALSO records its own `head_oid`, which
 * is checked against the live one — that second check is what catches a file copied forward
 * from the previous push into the new directory.
 *
 * SCAFFOLD OBLIGATIONS, NEVER EVIDENCE. On a MISSING artifact this gate denies AND writes a
 * skeleton (T2 `writeScaffoldIfAbsent`), naming the exact path it wrote. That removes the
 * "I do not know the required shape" friction and removes nothing else: every substantive
 * field arrives as an unfilled `<<<FILL:…>>>` sentinel, and `hasUnfilledPlaceholders` runs on
 * the RAW artifact text as a PRECONDITION before any shape assertion is trusted. That
 * ordering is mandatory, not stylistic — a placeholder string is `nonEmpty`, so the shape
 * assertions alone would pass an untouched skeleton, which is precisely the inversion this
 * gate exists to prevent.
 *
 * HONESTY (CTK-ADR-0004 §Consequences, load-bearing). This checks artifact SHAPE, not
 * honesty. An agent can still author a conforming artifact from its own head; the `merge=#n`
 * token in particular is an ATTESTATION (the human's invocation token is not visible at
 * PreToolUse), checked only for consistency with the PR being merged. The gate converts
 * skipping from free-and-silent into deliberate-and-recorded. It must never be described as
 * closing that gap. The treadmill check is the one rung higher — it reads GitHub's own review
 * list rather than a self-report (trust ladder: attestation < artifact < independent
 * verification).
 *
 * @module hooks/review-artifact
 */

const fs = require('node:fs');
const path = require('node:path');

const { parseCommand } = require('./lib/argv.cjs');
const {
  classifyAction,
  hasGovernedSegment,
  hasFailClosedSegment,
  isNonGovernedCommand,
  PR_COMMENT_EQUIVALENT_ACTIONS,
} = require('./lib/classify.cjs');
const { runGate, readHookInput, deny, allow, emit, FailClosed, safeCommand } = require('./lib/failclosed.cjs');
const { resolveRootForCommand } = require('./lib/resolve.cjs');
const { hasUnfilledPlaceholders, writeScaffoldIfAbsent } = require('./lib/scaffold.cjs');
// ONE ENGINE (CTK-ADR-0004 §Decision.1): ENF-19's assertion predicates are REUSED, not
// re-implemented. A second copy of `nonEmpty`/`equals`/`in`/`every` would be a second gate
// runtime that could drift from the first — and the whole reason ENF-20 is cheap is that
// ENF-19 already proved this vocabulary.
const { checkAssertion, readPath, isNonEmpty } = require('./protocol-artifact.cjs');

/**
 * Actions this gate governs. `pr-comment` AND `issue-comment` are both present deliberately:
 * GitHub posts a PR *conversation* comment to the ISSUES endpoint and issue/PR numbers share
 * one namespace, so a gate that governed only `pr-comment` would leave
 * `gh api -X POST …/issues/<pr#>/comments` as a one-line bypass
 * (`classify.PR_COMMENT_EQUIVALENT_ACTIONS` records this contract). The cost — that ordinary
 * ISSUE comments now reach this gate — is paid back by `resolveIsPullRequest`, a real lookup
 * the gate is allowed to make and the pure classifier is not.
 *
 * NOT governed, deliberately: `issue-close`. None of the four mechanizable re-review steps
 * concerns closing an issue, and inventing a fifth obligation would put an entry in the frozen
 * table that no declared step backs. Recorded as a known gap in the summary.
 */
const GOVERNED_ACTIONS = Object.freeze(new Set(['pr-review', 'pr-merge', ...PR_COMMENT_EQUIVALENT_ACTIONS]));

/** The two comment actions, which are governed CONDITIONALLY (only for a verdict post). */
const COMMENT_ACTIONS = Object.freeze(new Set(PR_COMMENT_EQUIVALENT_ACTIONS));

/** Where a PR's review artifacts live, relative to the worktree root. `.gsd` is gitignored. */
const ARTIFACT_DIR = '.gsd/contrib';

/** Characters of the head oid used in the directory key. 12 is git's own abbrev comfort zone. */
const OID_KEY_LENGTH = 12;

/** Shortest abbreviation an artifact may record as its `head_oid` and still be checkable. */
const OID_MIN_LENGTH = 7;

/**
 * The verdict vocabulary (re-review step 11). `CLEAR` is matched CASE-SENSITIVELY and
 * word-bounded so ordinary prose ("that makes the intent clear") cannot trip step 10, while
 * both `CLEAR` and `CLEAR · merge-blocked: …` do — step 10 is required before ANY clear
 * verdict, and the merge-blocked form is still a clear verdict.
 */
const CLEAR_VERDICT_RE = /\bCLEAR\b/;

/**
 * The re-review post's own header (`## Re-Review — PR #<n> · **<verdict>**`, the HARD template
 * in `skills/maintainer-review-sweep/re-review.md`). This is what identifies a post as one of
 * OUR re-review rounds — used both to decide whether a comment is governed at all and to count
 * prior rounds for the treadmill guard without needing to resolve the acting login.
 */
const REVIEW_POST_RE = /(^|\n)[ \t]{0,3}#{1,4}[ \t]*Re-?review\b/i;

/**
 * How many re-review rounds may already exist AT THE SAME head oid before a further post is
 * refused. 1 == "deny a second re-review post on an unchanged HEAD OID"
 * (`full-system-map.md:172`). The sweep skill's own stop condition is phrased at >=2 rounds;
 * the map is the normative spec for ENF-20 and is the stricter of the two, so the constant is
 * named and frozen here rather than buried in a comparison — re-calibrating it is one token.
 */
const TREADMILL_MAX_POSTS_PER_OID = 1;

/** CI conclusions that count as green for the step-13 merge gate. */
const CI_GREEN_CONCLUSIONS = Object.freeze(['success', 'skipped', 'neutral']);

/**
 * The severity scale re-review.md actually uses — Blocker/Major/Minor/Nit, plus the equivalent
 * High/Medium/Low some reviews use on the same defect. A finding with an off-menu severity is a
 * shape failure: the point of the tier is that a real defect cannot be quietly down-ranked.
 */
const FINDING_SEVERITIES = Object.freeze([
  'Blocker', 'Major', 'Minor', 'Nit', 'High', 'Medium', 'Low',
]);

/** The native `gh <area> <verb>` verbs whose positional argument names the PR/issue. */
const NATIVE_TARGET_VERBS = Object.freeze(new Set(['review', 'merge', 'comment', 'close', 'view']));

// ── the frozen contract ─────────────────────────────────────────────────────

/**
 * The ENF-20 contract: a frozen table IN CODE, beside ENF-19's `GATES` and for the same
 * reason (CTK-ADR-0004 §Decision.2) — a `.review-gate.json` at the root of gsd-core would be
 * an untracked file in every worktree of a repo the toolkit does not own, and a POLICY-02
 * commit hazard.
 *
 * Ordered CHEAPEST FIRST: the three disk-backed artifact checks, then the merge record, then
 * the treadmill guard, which is the only entry that costs a network round trip. The first
 * unmet requirement denies.
 *
 * Fields:
 *   id       stable name used in every denial and in the tests.
 *   step     the re-review step number it mechanizes (surfaced in the denial).
 *   on       the classified actions it applies to.
 *   when     'always' | 'clear-verdict' | 'review-post' — see `gateApplies`.
 *   file     the artifact, relative to the PR+oid directory (absent for a live-only check).
 *   spec     the T2 scaffold spec. Every substantive field is an OBLIGATION; a spec may
 *            never carry a `value`/`default` (T2's `validateSpec` refuses it).
 *   assert   ENF-19 assertions, evaluated by the SHARED `checkAssertion`.
 *   requires other gate ids whose artifacts must exist first (the merge record's re-fetch
 *            recency is meaningless without the analysis artifacts it must post-date).
 *   verify   an extra live/derived check, dispatched by name.
 */
const GATES = Object.freeze([
  Object.freeze({
    id: 'R8-code',
    step: 8,
    on: Object.freeze(['pr-review']),
    when: 'always',
    file: 'R8-code-review.json',
    what: 'the `/code-review` correctness+standards pass over this head oid',
    spec: Object.freeze({
      title: 'R8-code-review.json',
      step: 're-review step 8 — correctness+standards pass (`/code-review`), CI.GATE.orthogonal-review-required',
      what: 'the correctness+standards pass, run as its OWN isolated pass (never blended with security)',
      constants: Object.freeze({ schema: 1, pass: 'code-review' }),
      fields: Object.freeze([
        Object.freeze({ path: 'head_oid',
          observed: 'the PR HEAD OID you reviewed — `gh pr view <n> --json headRefOid -q .headRefOid`' }),
        Object.freeze({ path: 'command',
          observed: 'the command you actually ran (`/code-review` on the delta, or `gh pr diff <n>` for a fork you cannot fetch)' }),
        Object.freeze({ path: 'verdict',
          observed: 'the pass verdict line as you wrote it, e.g. `PASS — no correctness findings on the change itself`' }),
        Object.freeze({ path: 'findings.0.severity',
          observed: 'Blocker | Major | Minor | Nit (or High | Medium | Low) — DELETE this whole findings entry if the pass found nothing' }),
        Object.freeze({ path: 'findings.0.path',
          observed: 'the `path:line` the finding sits on — a finding with no location is not reviewable' }),
        Object.freeze({ path: 'findings.0.summary',
          observed: 'one sentence naming the defect (not the symptom)' }),
      ]),
    }),
    assert: Object.freeze([
      Object.freeze({ path: 'pass', equals: 'code-review',
        else: 'This artifact must record the `code-review` pass. The security pass is a SEPARATE ' +
          'file — two orthogonal isolated passes, never one blended pass.' }),
      Object.freeze({ path: 'command', nonEmpty: true,
        else: 'Record the command you actually ran for the pass.' }),
      Object.freeze({ path: 'verdict', nonEmpty: true,
        else: 'Record the pass verdict line, even when it is a clean `PASS`.' }),
      Object.freeze({ path: 'findings', every: Object.freeze({ path: 'severity', in: FINDING_SEVERITIES }),
        else: 'Every finding needs a `severity` of ' + FINDING_SEVERITIES.join(' | ') +
          '. Do not down-rank a real defect to avoid a Request-changes.' }),
      Object.freeze({ path: 'findings', every: Object.freeze({ path: 'path', nonEmpty: true }),
        else: 'Every finding needs the `path:line` it sits on.' }),
    ]),
  }),

  Object.freeze({
    id: 'R8-security',
    step: 8,
    on: Object.freeze(['pr-review']),
    when: 'always',
    file: 'R8-security-review.json',
    what: 'the `/security-review` pass over this head oid',
    spec: Object.freeze({
      title: 'R8-security-review.json',
      step: 're-review step 8 — security pass (`/security-review`), CI.GATE.orthogonal-review-required',
      what: 'the security pass, run as its OWN isolated pass — an explicit Security verdict is required even when it is `PASS — no code surface`',
      constants: Object.freeze({ schema: 1, pass: 'security-review' }),
      fields: Object.freeze([
        Object.freeze({ path: 'head_oid',
          observed: 'the PR HEAD OID you reviewed — `gh pr view <n> --json headRefOid -q .headRefOid`' }),
        Object.freeze({ path: 'command',
          observed: 'the command you actually ran (`/security-review`, or `gsd-security-auditor` when the PR is security-labelled or touches the ADR-857/1244 trust model)' }),
        Object.freeze({ path: 'verdict',
          observed: 'the Security verdict line as you wrote it — `PASS — no code surface` is a real verdict and must be stated, not omitted' }),
        Object.freeze({ path: 'findings.0.severity',
          observed: 'Blocker | Major | Minor | Nit (or High | Medium | Low) — DELETE this whole findings entry if the pass found nothing' }),
        Object.freeze({ path: 'findings.0.path',
          observed: 'the `path:line` the finding sits on' }),
        Object.freeze({ path: 'findings.0.summary',
          observed: 'one sentence naming the exposure' }),
      ]),
    }),
    assert: Object.freeze([
      Object.freeze({ path: 'pass', equals: 'security-review',
        else: 'This artifact must record the `security-review` pass — the second of the two ' +
          'orthogonal isolated passes.' }),
      Object.freeze({ path: 'command', nonEmpty: true,
        else: 'Record the command you actually ran for the security pass.' }),
      Object.freeze({ path: 'verdict', nonEmpty: true,
        else: 'State the Security verdict explicitly, even when it is `PASS — no code surface`.' }),
      Object.freeze({ path: 'findings', every: Object.freeze({ path: 'severity', in: FINDING_SEVERITIES }),
        else: 'Every finding needs a `severity` of ' + FINDING_SEVERITIES.join(' | ') + '.' }),
      Object.freeze({ path: 'findings', every: Object.freeze({ path: 'path', nonEmpty: true }),
        else: 'Every finding needs the `path:line` it sits on.' }),
    ]),
  }),

  Object.freeze({
    id: 'R10',
    step: 10,
    on: Object.freeze(['pr-review', ...PR_COMMENT_EQUIVALENT_ACTIONS]),
    when: 'clear-verdict',
    file: 'R10-exogenous.json',
    what: 'the exogenous self-check that a CLEAR/Approve verdict requires',
    spec: Object.freeze({
      title: 'R10-exogenous.json',
      step: 're-review step 10 — exogenous self-check (REQUIRED before any CLEAR/Approve verdict)',
      what: 'a FRESH reviewer subagent\'s independent judgement, plus your trust-but-verify of the subagent itself',
      constants: Object.freeze({ schema: 1 }),
      fields: Object.freeze([
        Object.freeze({ path: 'head_oid',
          observed: 'the PR HEAD OID the exogenous pass ran against' }),
        Object.freeze({ path: 'reviewer',
          observed: 'the fresh subagent you dispatched, e.g. `feature-dev:code-reviewer`' }),
        Object.freeze({ path: 'withheld_verdict',
          observed: 'true — it was given the diff + the blocking findings + the governing ADRs and NOT your verdict. An agent ratifying your conclusion is the failure mode, not the safeguard.' }),
        Object.freeze({ path: 'conclusion',
          observed: 'its overall conclusion IN ITS WORDS, not your paraphrase' }),
        Object.freeze({ path: 'independent_judgement.0.finding',
          observed: 'the blocking finding it judged — DELETE this entry if there were no blocking findings' }),
        Object.freeze({ path: 'independent_judgement.0.judgement',
          observed: 'resolved | unresolved, as IT judged it (then compare to your own map; any discrepancy → do not post a clear verdict)' }),
        Object.freeze({ path: 'primary_source_checks.0.claim',
          observed: 'the subagent claim you went and verified — it is the audit subject, not the validator' }),
        Object.freeze({ path: 'primary_source_checks.0.quote',
          observed: 'the QUOTED primary source you confirmed it against — the actual diff line or the CI assertion. Agent confidence is not evidence.' }),
      ]),
    }),
    assert: Object.freeze([
      Object.freeze({ path: 'reviewer', nonEmpty: true,
        else: 'Name the fresh subagent you dispatched for the exogenous pass.' }),
      Object.freeze({ path: 'withheld_verdict', equals: true,
        else: 'The exogenous reviewer must NOT have been given your verdict — that makes it a ' +
          'ratifier, not an independent check. Re-run it with the diff + blocking findings + ADRs only.' }),
      Object.freeze({ path: 'conclusion', nonEmpty: true,
        else: 'Record the subagent\'s own conclusion, in its words.' }),
      Object.freeze({ path: 'independent_judgement',
        every: Object.freeze({ path: 'judgement', nonEmpty: true }),
        else: 'Every judged finding needs the subagent\'s `judgement`.' }),
      Object.freeze({ path: 'primary_source_checks',
        every: Object.freeze({ path: 'quote', nonEmpty: true }),
        else: 'Every verified claim needs the QUOTED primary source (diff line / CI assertion). ' +
          'trust-but-verify: the reviewer is the audit subject, not the validator.' }),
    ]),
  }),

  Object.freeze({
    id: 'R13',
    step: 13,
    on: Object.freeze(['pr-merge']),
    when: 'always',
    file: 'R13-merge.json',
    what: 'the merge record: the `merge=#n` authorization, green CI conclusions, and the ' +
      'CI re-fetch that post-dates your analysis',
    requires: Object.freeze(['R8-code', 'R8-security', 'R10']),
    spec: Object.freeze({
      title: 'R13-merge.json',
      step: 're-review step 13 — merge gate',
      what: 'the preconditions that must ALL hold at merge time, re-fetched immediately before merging',
      constants: Object.freeze({ schema: 1 }),
      fields: Object.freeze([
        Object.freeze({ path: 'head_oid',
          observed: 'the PR HEAD OID you are merging — re-fetch it; long analysis goes stale' }),
        Object.freeze({ path: 'authorization',
          observed: 'the merge token from the HUMAN invocation, verbatim: `merge=#<n>`. Merge authority is held without it.' }),
        Object.freeze({ path: 'verdict',
          observed: 'CLEAR — and only plain `CLEAR` merges. `CLEAR · merge-blocked: …` does NOT.' }),
        Object.freeze({ path: 'ci_refetched_at',
          observed: 'the ISO-8601 instant you RE-FETCHED CI conclusions, which must be AFTER your last analysis step' }),
        Object.freeze({ path: 'ci_conclusions.0.name',
          observed: 'the required check\'s name as GitHub reports it' }),
        Object.freeze({ path: 'ci_conclusions.0.conclusion',
          observed: 'its REAL conclusion (' + CI_GREEN_CONCLUSIONS.join(' | ') + ' to merge) — never a pending or inferred one' }),
      ]),
    }),
    assert: Object.freeze([
      Object.freeze({ path: 'authorization', nonEmpty: true,
        else: 'Record the `merge=#<n>` token the human invocation carried. No token → merge ' +
          'authority is HELD: print the exact merge command and stop.' }),
      Object.freeze({ path: 'verdict', equals: 'CLEAR',
        else: 'Only a plain `CLEAR` verdict merges. `CLEAR · merge-blocked: …` means the code is ' +
          'clear but the merge is not — hand it back, do not merge it.' }),
      Object.freeze({ path: 'ci_refetched_at', nonEmpty: true,
        else: 'Record WHEN you re-fetched the CI conclusions (ISO-8601).' }),
      Object.freeze({ path: 'ci_conclusions', nonEmpty: true,
        else: 'Record the required checks and their REAL conclusions. A merge with no recorded ' +
          'check is not evidence of a green matrix.' }),
      Object.freeze({ path: 'ci_conclusions', every: Object.freeze({ path: 'name', nonEmpty: true }),
        else: 'Every recorded check needs its `name`.' }),
      Object.freeze({ path: 'ci_conclusions',
        every: Object.freeze({ path: 'conclusion', in: CI_GREEN_CONCLUSIONS }),
        else: 'Every required check must have a real `conclusion` of ' +
          CI_GREEN_CONCLUSIONS.join(' | ') + '. A failing or still-pending check is a merge ' +
          'blocker — never finalize a merge on partial CI.' }),
    ]),
    verify: 'merge-preconditions',
  }),

  Object.freeze({
    id: 'R1',
    step: 1,
    on: Object.freeze(['pr-review', ...PR_COMMENT_EQUIVALENT_ACTIONS]),
    when: 'review-post',
    what: 'the treadmill guard — no second re-review round on an unchanged head oid',
    // No artifact: this one is checked against GitHub's OWN review list, which is a rung
    // above a self-reported file on the trust ladder. Last in the table because it is the
    // only entry that costs a network round trip.
    verify: 'treadmill',
  }),
]);

/** id -> gate, for `requires` resolution. */
const GATES_BY_ID = Object.freeze(
  GATES.reduce((acc, g) => {
    acc[g.id] = g;
    return acc;
  }, Object.create(null))
);

// ── keying ──────────────────────────────────────────────────────────────────

/**
 * A hex object id, lowercased, or null when the value is not one. Returning null (rather
 * than sanitizing) is deliberate: a key we cannot trust must fail closed, never degrade into
 * a path segment. This is also the path-traversal guard for the directory key.
 *
 * @param {*} oid
 * @returns {string|null}
 */
function normalizeOid(oid) {
  const s = String(oid === undefined || oid === null ? '' : oid).trim().toLowerCase();
  if (!/^[0-9a-f]+$/.test(s)) return null;
  if (s.length < OID_MIN_LENGTH) return null;
  return s;
}

/**
 * The artifact directory slug for a PR at a head oid — ONE safe path segment.
 *
 * Keying on the PR number ALONE is the staleness bug: a review of an older push would satisfy
 * a gate for a push it never saw. Mirrors ENF-05's `git write-tree` keying.
 *
 * @param {number|string} prNumber
 * @param {string} headOid
 * @returns {string}
 */
function reviewSlug(prNumber, headOid) {
  const n = String(prNumber).replace(/[^0-9]/g, '');
  const oid = normalizeOid(headOid);
  if (!n) throw new FailClosed('ENF-20: cannot key review artifacts without a PR number');
  if (!oid) {
    throw new FailClosed(
      'ENF-20: `' + String(headOid) + '` is not a usable head oid, so the review artifacts ' +
        'cannot be keyed to this push. Failing closed rather than keying against a guess.'
    );
  }
  return 'pr-' + n + '-' + oid.slice(0, OID_KEY_LENGTH);
}

// ── command reading (pure) ──────────────────────────────────────────────────

/**
 * Every string that could carry a `name=value` field or a JSON body on a segment: the raw
 * TOKENS (resilient to repeated `-f` flags overwriting each other in the parsed map) plus the
 * parsed flag values, plus the ATTACHED forms recovered from either. Mirrors the approach
 * `classify.isPureStateClose` already takes for `state=closed`.
 *
 * @param {Object} seg structured segment from argv.parseCommand
 * @returns {string[]}
 */
function fieldCandidates(seg) {
  const out = [];
  const add = (v) => {
    if (typeof v !== 'string' || v.length === 0) return;
    out.push(v);
    const short = /^-[A-Za-z](.+)$/.exec(v);
    if (short) out.push(short[1]);
    const long = /^--[A-Za-z][A-Za-z0-9-]*=(.+)$/.exec(v);
    if (long) out.push(long[1]);
  };
  if (Array.isArray(seg.tokens)) seg.tokens.forEach(add);
  for (const v of Object.values(seg.flags || {})) add(v);
  for (const v of Object.values(seg.shortFlags || {})) add(v);
  return out;
}

/**
 * Is this a native `gh <pr|issue> …` segment (as opposed to `gh api` / `curl`)? Used to read
 * `-F` as `--body-file` (its meaning for `gh pr comment`) without misreading it as `gh api`'s
 * typed-field flag.
 *
 * @param {Object} seg
 * @returns {boolean}
 */
function isNativeGhSegment(seg) {
  const subs = Array.isArray(seg.subcommands) ? seg.subcommands : [];
  const tokens = Array.isArray(seg.tokens) ? seg.tokens : [];
  return subs.indexOf('pr') !== -1 || subs.indexOf('issue') !== -1 ||
    tokens.indexOf('pr') !== -1 || tokens.indexOf('issue') !== -1;
}

/**
 * The post's BODY text, across every shape that carries one: `--body`/`-b`, a `body=` field
 * (`gh api -f body=…`, including the attached and bundled forms), a JSON request body
 * (`curl -d '{"body":"…"}'`), and `--body-file`/`-F <path>`, which is READ (and therefore may
 * throw → fail closed: a body we cannot read cannot be checked for a verdict).
 *
 * @param {Object} seg
 * @param {Object} deps
 * @param {(p:string)=>string} [deps.readBodyFile] MAY THROW.
 * @returns {string} the joined body text, or '' when the command carries none.
 */
function bodyText(seg, deps = {}) {
  const parts = [];
  const flags = seg.flags || {};
  const shortFlags = seg.shortFlags || {};

  if (typeof flags.body === 'string') parts.push(flags.body);
  if (typeof shortFlags.b === 'string') parts.push(shortFlags.b);

  for (const c of fieldCandidates(seg)) {
    const field = /^body=([\s\S]*)$/.exec(c);
    if (field) parts.push(field[1]);
    if (/^\s*[{[]/.test(c)) {
      try {
        const o = JSON.parse(c);
        if (o && typeof o.body === 'string') parts.push(o.body);
      } catch (_) {
        // Not JSON — nothing to read. A malformed body is not this gate's concern.
      }
    }
  }

  let bodyFile = typeof flags['body-file'] === 'string' ? flags['body-file'] : null;
  if (!bodyFile && isNativeGhSegment(seg) && typeof shortFlags.F === 'string') {
    bodyFile = shortFlags.F;
  }
  if (bodyFile && typeof deps.readBodyFile === 'function') {
    parts.push(deps.readBodyFile(bodyFile)); // may throw → fail closed
  }

  return parts.join('\n');
}

/**
 * Is this review submission an APPROVE? `--approve` natively, `event=APPROVE` over REST.
 * An approve IS a CLEAR verdict (re-review step 12 maps `CLEAR` → Approve), so it is the most
 * robust step-10 trigger available — far more so than parsing prose.
 *
 * @param {Object} seg
 * @returns {boolean}
 */
function isApproveEvent(seg) {
  const flags = seg.flags || {};
  if (Object.prototype.hasOwnProperty.call(flags, 'approve')) return true;
  for (const c of fieldCandidates(seg)) {
    if (/^event=APPROVE$/i.test(c)) return true;
    if (/"event"\s*:\s*"APPROVE"/i.test(c)) return true;
  }
  return false;
}

/**
 * Is this a help invocation? `gh pr review --help` classifies as `pr-review` (the classifier
 * reads the verb, not the intent), and denying a help request would be a pure false positive —
 * the failure mode that gets a toolkit switched off. Reads only the STRUCTURED flag space, so
 * `--body "see --help"` does NOT match (EP-3).
 *
 * @param {Object} seg
 * @returns {boolean}
 */
function isHelpInvocation(seg) {
  const flags = seg.flags || {};
  const shortFlags = seg.shortFlags || {};
  return (
    Object.prototype.hasOwnProperty.call(flags, 'help') ||
    Object.prototype.hasOwnProperty.call(shortFlags, 'h')
  );
}

/**
 * The `--repo OWNER/REPO` spec if the command names one, else null (gh then resolves the repo
 * from the working directory).
 *
 * @param {Object} seg
 * @returns {string|null}
 */
function repoSpecOf(seg) {
  const flags = seg.flags || {};
  const shortFlags = seg.shortFlags || {};
  const v = typeof flags.repo === 'string' ? flags.repo : (typeof shortFlags.R === 'string' ? shortFlags.R : null);
  if (!v) return null;
  return /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(v) ? v : null;
}

/**
 * The PR/issue selector this segment names, read from the RAW TOKEN list rather than the
 * parsed flag map. That is deliberate: argv cannot know that `--approve` is boolean, so in
 * `gh pr review --approve 42` the number is recorded as the FLAG'S VALUE and disappears from
 * the positionals. The token scan sees it either way.
 *
 * DOCUMENTED LIMIT: a numeric flag VALUE placed before the PR number (`gh pr review --body 12
 * 42`) would be read as the selector. Nobody writes a bare-numeric review body, and the
 * failure direction is safe — a mis-keyed PR resolves to a different artifact directory, so
 * the gate DENIES rather than allowing. A branch-name selector (`gh pr review my-branch`)
 * returns null and the live resolver falls back to the current branch's PR.
 *
 * @param {Object} seg
 * @returns {string|null} the PR/issue number as a string, or null.
 */
function prSelector(seg) {
  const tokens = Array.isArray(seg.tokens) ? seg.tokens : [];

  // REST route: the numeric member of an issues|pulls path.
  for (const t of tokens) {
    const m = /(?:^|\/)(?:issues|pulls)\/(\d+)(?:\/|$|\?)/.exec(t);
    if (m) return m[1];
  }

  // Native route: the first number after the `<pr|issue> <verb>` pair.
  for (let i = 1; i < tokens.length; i += 1) {
    const prev = tokens[i - 1];
    if ((prev !== 'pr' && prev !== 'issue') || !NATIVE_TARGET_VERBS.has(tokens[i])) continue;
    for (let j = i + 1; j < tokens.length; j += 1) {
      const t = tokens[j];
      if (/^\d+$/.test(t)) return t;
      const u = /\/(?:pull|pulls|issues)\/(\d+)/.exec(t);
      if (u) return u[1];
    }
    break;
  }

  return null;
}

/**
 * The field names still carrying an unfilled sentinel, so a denial can point at the LINES
 * rather than at the file. Mirrors ENF-19's habit of naming the failing index.
 *
 * @param {string} text raw artifact text
 * @returns {string[]}
 */
function unfilledFields(text) {
  if (typeof text !== 'string') return [];
  const names = [];
  const re = /<{1,3}FILL:?([A-Za-z0-9_.-]*)/g;
  let m = re.exec(text);
  while (m !== null) {
    const name = m[1] || '(unnamed)';
    if (names.indexOf(name) === -1) names.push(name);
    m = re.exec(text);
  }
  return names;
}

// ── denial rendering ────────────────────────────────────────────────────────

/** The one-line reminder every ENF-20 denial carries. */
const OVERRIDE_NOTE =
  'Write the artifact and continue — do not stop and ask. Deliberate bypass: a logged ' +
  '`GSD_CONTRIB_OVERRIDE=<reason>`. (CTK-ADR-0004, ENF-20)';

/**
 * The denial for a MISSING artifact — the one case that also SCAFFOLDS. Names the exact path
 * written and says plainly that the placeholders need OBSERVED values.
 *
 * @param {Object} g the gate entry
 * @param {string} rel repo-relative artifact path
 * @param {{written:boolean, path:string, reason?:string, error?:string}} res writeScaffold result
 * @param {string|null} because the id of the gate that REQUIRED this artifact, if not `g` itself
 * @returns {string}
 */
function missingText(g, rel, res, because) {
  const head =
    'ENF-20 ' + g.id + ' (re-review step ' + g.step + ') — this action requires ' + g.what +
    ', and `' + rel + '` does not exist.' +
    (because ? ' It is required by the step-' + GATES_BY_ID[because].step + ' ' + because + ' gate.' : '');

  const wrote = res && res.written
    ? 'A SKELETON HAS BEEN WRITTEN FOR YOU at `' + rel + '`.'
    : res && (res.reason === 'exists' || res.reason === 'race')
      ? 'A skeleton is already present at `' + rel + '`.'
      : 'A skeleton could NOT be written at `' + rel + '` (' +
        ((res && (res.error || res.reason)) || 'unknown') + ') — create it by hand.';

  return (
    head + '\n\n' + wrote + '\n\n' +
    'Every `<<<FILL:…>>>` placeholder in it must be replaced with an OBSERVED value — what you ' +
    'actually ran and what it actually printed, not what you expected. The scaffold supplies the ' +
    'OBLIGATION, never the evidence: this gate keeps denying while any placeholder remains.\n\n' +
    OVERRIDE_NOTE
  );
}

/**
 * The denial for an artifact that EXISTS but does not yet vouch for the step.
 *
 * @param {Object} g
 * @param {string} rel
 * @param {string} problem what is wrong, in instruction form
 * @returns {string}
 */
function shortfallText(g, rel, problem) {
  return (
    'ENF-20 ' + g.id + ' (re-review step ' + g.step + ') — `' + rel + '` does not yet record ' +
    g.what + '.\n' + problem + '\n\n' + OVERRIDE_NOTE
  );
}

/**
 * The denial for a live/derived check that has no artifact of its own.
 *
 * @param {Object} g
 * @param {string} problem
 * @returns {string}
 */
function liveText(g, problem) {
  return 'ENF-20 ' + g.id + ' (re-review step ' + g.step + ') — ' + problem + '\n\n' + OVERRIDE_NOTE;
}

// ── artifact checking ───────────────────────────────────────────────────────

/**
 * Parse an artifact's raw text. A malformed artifact THROWS (fail closed): a contract that
 * silently fails to load is indistinguishable from having no gate at all.
 *
 * @param {string} rel
 * @param {string} text
 * @returns {*}
 */
function parseArtifact(rel, text) {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new FailClosed(
      '`' + rel + '` is not valid JSON (' + ((err && err.message) || 'parse failure') +
        '). Fix the artifact — a malformed one cannot vouch for anything.'
    );
  }
}

/**
 * Require one artifact: present, FILLED, well-shaped, and keyed to THIS head oid.
 *
 * Order is load-bearing:
 *   1. absent            → scaffold + deny (the friction fix)
 *   2. placeholders left → deny. THIS RUNS BEFORE ANY SHAPE ASSERTION, because a placeholder
 *      string is `nonEmpty`: measured against ENF-19's P2, five of its six shape assertions
 *      PASS on a completely unfilled scaffold. Trusting shape first would ship exactly the
 *      inversion ENF-20 exists to prevent.
 *   3. malformed JSON    → fail closed
 *   4. shape assertions  → deny (ENF-19's shared predicates)
 *   5. head_oid          → deny. The directory key already scopes by oid; this catches a file
 *      COPIED forward from the previous push into the new directory.
 *
 * @param {Object} g the gate whose artifact this is
 * @param {Object} ctx {dir, headOid, …}
 * @param {Object} deps
 * @param {string|null} [because] the id of the gate that required it (for the denial text)
 * @returns {{permissionDecision:string, permissionDecisionReason?:string}|null} a deny, or null
 */
function requireArtifact(g, ctx, deps, because = null) {
  const rel = ctx.dir + '/' + g.file;

  if (!deps.artifactExists(rel)) {
    const res = deps.writeScaffold(rel, g.spec);
    return deny(missingText(g, rel, res, because));
  }

  const text = deps.readArtifactText(rel); // may throw → fail closed

  if (hasUnfilledPlaceholders(text)) {
    const fields = unfilledFields(text);
    return deny(
      shortfallText(
        g,
        rel,
        'It still carries unfilled placeholder(s): ' +
          (fields.length ? fields.map((f) => '`' + f + '`').join(', ') : '(the file is empty)') +
          '. Replace each one with an OBSERVED value. A scaffold cannot satisfy the gate that ' +
          'wrote it — that is the whole point of it being a scaffold.'
      )
    );
  }

  const doc = parseArtifact(rel, text);

  for (const a of g.assert) {
    const problem = checkAssertion(doc, a); // shared ENF-19 predicate (throws on a contract bug)
    if (problem !== null) return deny(shortfallText(g, rel, problem));
  }

  const claimed = normalizeOid(readPath(doc, 'head_oid'));
  if (!claimed || !ctx.headOid.startsWith(claimed)) {
    return deny(
      shortfallText(
        g,
        rel,
        'Its `head_oid` is `' + String(readPath(doc, 'head_oid')) + '`, but PR #' + ctx.number +
          ' now heads at `' + ctx.headOid.slice(0, OID_KEY_LENGTH) + '`. A review of an older ' +
          'push does not vouch for this one — re-run the step against the current HEAD and ' +
          'record the oid you actually saw.'
      )
    );
  }

  return null;
}

/**
 * Step 13's derived preconditions, beyond the shape assertions:
 *   - the `merge=#n` token must name THIS pull request. An `authorization` that names another
 *     PR is a copied merge record, which is exactly how a token-gated merge gets bypassed.
 *   - the CI re-fetch must POST-DATE the newest analysis artifact. Step 13 exists because long
 *     analysis (test runs, the exogenous subagent) goes stale; a re-fetch recorded BEFORE the
 *     analysis finished is not a re-fetch at all. Same staleness discipline as ENF-19's
 *     `generated_at < headAt` matrix check.
 *
 * @param {Object} g
 * @param {Object} ctx
 * @param {Object} deps
 * @returns {Object|null}
 */
function verifyMergePreconditions(g, ctx, deps) {
  const rel = ctx.dir + '/' + g.file;
  const doc = parseArtifact(rel, deps.readArtifactText(rel));

  const auth = String(readPath(doc, 'authorization') || '');
  const wanted = new RegExp('merge\\s*=\\s*#?' + ctx.number + '(?![0-9])');
  if (!wanted.test(auth)) {
    return deny(
      shortfallText(
        g,
        rel,
        'Its `authorization` is `' + auth + '`, which does not carry the `merge=#' + ctx.number +
          '` token for the PR being merged. Merge authority is HELD without that token: print ' +
          'the exact merge command and stop.'
      )
    );
  }

  const refetched = Date.parse(String(readPath(doc, 'ci_refetched_at') || ''));
  if (!Number.isFinite(refetched)) {
    return deny(
      shortfallText(g, rel, 'Its `ci_refetched_at` is not a parseable ISO-8601 instant.')
    );
  }

  let newest = -Infinity;
  let newestRel = null;
  for (const id of g.requires || []) {
    const dep = GATES_BY_ID[id];
    if (!dep || !dep.file) continue;
    const depRel = ctx.dir + '/' + dep.file;
    if (!deps.artifactExists(depRel)) continue;
    const at = deps.artifactMtimeMs(depRel);
    if (Number.isFinite(at) && at > newest) {
      newest = at;
      newestRel = depRel;
    }
  }

  if (newestRel !== null && refetched < newest) {
    return deny(
      shortfallText(
        g,
        rel,
        'You recorded the CI re-fetch at `' + new Date(refetched).toISOString() + '`, but `' +
          newestRel + '` was written at `' + new Date(newest).toISOString() +
          '` — AFTER it. Step 13 exists because long analysis goes stale: re-fetch the HEAD oid, ' +
          'the reviews and the CI conclusions immediately BEFORE merging, then record that instant.'
      )
    );
  }

  return null;
}

/**
 * Step 1's treadmill guard, checked against GitHub's OWN review list rather than a
 * self-report — a rung above an artifact on the trust ladder.
 *
 * Counts prior rounds by the re-review post's own template header, not by author login: that
 * identifies OUR rounds specifically, needs no second lookup, and leaves another maintainer's
 * ordinary review at the same oid alone (denying on someone else's review would be a false
 * positive).
 *
 * DOCUMENTED LIMIT: only formal REVIEWS are counted. A round smuggled out as a standalone
 * comment is invisible here — but re-review.md step 12 forbids that channel anyway
 * ("do NOT also post a standalone comment").
 *
 * @param {Object} g
 * @param {Object} ctx
 * @param {Object} deps
 * @returns {Object|null}
 */
function verifyTreadmill(g, ctx, deps) {
  const reviews = deps.readPostedReviews(ctx.number, ctx.repoSpec); // may throw → fail closed
  const list = Array.isArray(reviews) ? reviews : [];

  const priorRounds = list.filter((r) => {
    if (!r || typeof r !== 'object') return false;
    const oid = normalizeOid(r.commit_id);
    if (!oid || !ctx.headOid.startsWith(oid)) return false;
    return REVIEW_POST_RE.test(String(r.body || ''));
  });

  if (priorRounds.length < TREADMILL_MAX_POSTS_PER_OID) return null;

  return deny(
    liveText(
      g,
      priorRounds.length + ' re-review round(s) have ALREADY been posted on PR #' + ctx.number +
        ' at head oid `' + ctx.headOid.slice(0, OID_KEY_LENGTH) + '`, and HEAD has not moved ' +
        'since. Posting again re-reviews the same code, trips dismiss-stale-on-push, and is how ' +
        'the loop starts. Escalate to a HUMAN maintainer instead, or wait for a new substantive ' +
        'push (a rebase or a merge commit is not one).'
    )
  );
}

// ── the gate ────────────────────────────────────────────────────────────────

/**
 * Does this gate entry apply to this post?
 *
 * @param {Object} g
 * @param {string} action
 * @param {{approve:boolean, clear:boolean, reviewPost:boolean}} post
 * @returns {boolean}
 */
function gateApplies(g, action, post) {
  switch (g.when) {
    case 'always':
      return true;
    // Step 10 is required before ANY CLEAR/Approve verdict — `--approve` (or REST
    // event=APPROVE) is the machine-readable form, a `CLEAR` token in the body the prose one.
    case 'clear-verdict':
      return post.approve || post.clear;
    // Step 1 concerns POSTING a round. A formal `gh pr review` submission always is one; a
    // comment only when it carries the re-review header or a verdict.
    case 'review-post':
      return action === 'pr-review' || post.reviewPost || post.clear;
    default:
      throw new FailClosed('ENF-20 contract bug: gate ' + g.id + ' has an unknown `when`');
  }
}

/**
 * Run one governed segment through the table. Returns a deny decision, or null to continue.
 *
 * @param {Object} seg
 * @param {string} action
 * @param {Object} deps
 * @returns {Object|null}
 */
function gateSegment(seg, action, deps) {
  // A help request is not an adjudicating act. `gh pr review --help` classifies as pr-review
  // because the classifier reads the verb; denying it would be a pure false positive.
  if (isHelpInvocation(seg)) return null;

  const body = bodyText(seg, deps); // may throw (unreadable --body-file) → fail closed
  const post = {
    approve: isApproveEvent(seg),
    clear: CLEAR_VERDICT_RE.test(body),
    reviewPost: REVIEW_POST_RE.test(body),
  };

  // A comment is governed ONLY when it carries a verdict or a re-review header. "thanks,
  // rebased" is not an adjudication, and gating it would cost a network lookup on every
  // comment for no enforcement value.
  if (COMMENT_ACTIONS.has(action) && !(post.clear || post.reviewPost)) return null;

  const applicable = GATES.filter((g) => g.on.indexOf(action) !== -1 && gateApplies(g, action, post));
  if (applicable.length === 0) return null;

  const repoSpec = repoSpecOf(seg);
  const selector = prSelector(seg);

  // PR-vs-ISSUE. The issues endpoint is BOTH the issue-comment route and GitHub's PR
  // *conversation*-comment route, and the numbering namespace is shared, so the pure
  // classifier cannot disambiguate. The gate CAN: it is allowed I/O. Resolving here is what
  // lets ENF-20 govern `gh api POST …/issues/<pr#>/comments` without denying ordinary issue
  // comments (classify.PR_COMMENT_EQUIVALENT_ACTIONS records the contract).
  if (action === 'issue-comment') {
    if (!selector) {
      throw new FailClosed(
        'ENF-20: this comment carries a re-review verdict but names no issue/PR number, so ' +
          'whether it is a PR conversation comment cannot be resolved. Failing closed.'
      );
    }
    if (!deps.resolveIsPullRequest(selector, repoSpec)) return null; // an ordinary issue
  }

  const pr = deps.resolvePr(selector, repoSpec); // may throw → fail closed
  const number = String((pr && pr.number) !== undefined ? pr.number : '').replace(/[^0-9]/g, '');
  const headOid = normalizeOid(pr && pr.headOid);
  if (!number || !headOid) {
    throw new FailClosed(
      'ENF-20: could not resolve PR number + head oid for this command (got ' +
        JSON.stringify(pr) + '). The review artifacts cannot be keyed to this push, so the ' +
        'gate fails closed rather than keying against a guess.'
    );
  }

  const ctx = {
    dir: ARTIFACT_DIR + '/' + reviewSlug(number, headOid),
    number,
    headOid,
    repoSpec,
  };

  for (const g of applicable) {
    // Companion artifacts first: the merge record's re-fetch recency is meaningless without
    // the analysis artifacts it must post-date.
    for (const id of g.requires || []) {
      const dep = GATES_BY_ID[id];
      if (!dep || !dep.file) continue;
      const d = requireArtifact(dep, ctx, deps, g.id);
      if (d) return d;
    }

    if (g.file) {
      const d = requireArtifact(g, ctx, deps);
      if (d) return d;
    }

    if (g.verify === 'merge-preconditions') {
      const d = verifyMergePreconditions(g, ctx, deps);
      if (d) return d;
    } else if (g.verify === 'treadmill') {
      const d = verifyTreadmill(g, ctx, deps);
      if (d) return d;
    } else if (g.verify !== undefined) {
      throw new FailClosed('ENF-20 contract bug: gate ' + g.id + ' names an unknown `verify`');
    }
  }

  return null;
}

/**
 * The pure gate decision, with every impure read injected.
 *
 * @param {string} stdinString raw PreToolUse JSON
 * @param {Object} deps
 * @param {(selector:string|null, repoSpec:string|null) => {number:number|string, headOid:string}} deps.resolvePr MAY THROW.
 * @param {(selector:string, repoSpec:string|null) => boolean} deps.resolveIsPullRequest MAY THROW.
 * @param {(rel:string) => boolean} deps.artifactExists
 * @param {(rel:string) => string} deps.readArtifactText RAW text. MAY THROW.
 * @param {(rel:string) => number} deps.artifactMtimeMs epoch ms.
 * @param {(rel:string, spec:Object) => Object} deps.writeScaffold never overwrites.
 * @param {(pr:string, repoSpec:string|null) => Object[]} deps.readPostedReviews MAY THROW.
 * @param {(p:string) => string} deps.readBodyFile MAY THROW.
 * @returns {{permissionDecision:string, permissionDecisionReason?:string}}
 */
function gate(stdinString, deps) {
  const input = readHookInput(stdinString);
  const command = (input.tool_input && input.tool_input.command) || '';

  const parsed = parseCommand(command);
  if (!parsed.ok) throw new FailClosed('unparseable command: ' + parsed.reason);

  // ENF-15 / CF-07: a failClosed synonym ANYWHERE in the chain fails closed, regardless of
  // position — an unclassifiable mutating GitHub call must never read as "not a review".
  if (hasFailClosedSegment(parsed)) {
    throw new FailClosed(
      'unclassifiable mutating GitHub command — ENF-20 cannot tell which review artifact it needs'
    );
  }

  // CF-05 / T1 carry-forward: trigger on hasGovernedSegment, NEVER on
  // classifyAction(parsed).action. classifyAction aggregates ONE verdict per command CHAIN and
  // LEGACY actions deliberately win that aggregation, so `git commit -m x && gh pr merge 42`
  // reports `commit` — gating on the aggregate would miss the merge entirely and hand out a
  // one-line bypass.
  if (!hasGovernedSegment(parsed, GOVERNED_ACTIONS)) return allow();

  const segs = Array.isArray(parsed.segments) && parsed.segments.length > 0 ? parsed.segments : [parsed];
  for (const seg of segs) {
    const r = classifyAction({ ok: true, segments: [seg] });
    if (!r || !GOVERNED_ACTIONS.has(r.action)) continue;
    const decision = gateSegment(seg, r.action, deps);
    if (decision) return decision; // the first unmet requirement denies
  }

  return allow();
}

/**
 * Injectable entry seam. Defaults every reader to a live read bound to the resolved gsd-core
 * worktree.
 *
 * @param {string} stdinString raw PreToolUse JSON
 * @param {Object} [deps]
 * @returns {{permissionDecision:string, permissionDecisionReason?:string}}
 */
function runReviewArtifactGate(stdinString, deps = {}) {
  const ctx = {
    command: safeCommand(stdinString),
    action: 'review-artifact',
    // OBS-02: read ONLY for session/tool ids in the verdict log; never logged verbatim.
    stdin: stdinString,
    worktreeRoot: deps.worktreeRoot,
    overrideImpl: deps.overrideImpl,
  };

  return runGate(() => {
    // RES-01 (D-07 uniformity): short-circuit a confidently non-governed command BEFORE any
    // filesystem walk. Unparseable / failClosed / governed commands fall through unchanged.
    if (isNonGovernedCommand(parseCommand(ctx.command), GOVERNED_ACTIONS)) return allow();

    const resolved = Object.assign({}, deps);
    const needsRoot =
      !resolved.resolvePr || !resolved.resolveIsPullRequest || !resolved.artifactExists ||
      !resolved.readArtifactText || !resolved.artifactMtimeMs || !resolved.writeScaffold ||
      !resolved.readPostedReviews;

    if (needsRoot) {
      const root = resolved.worktreeRoot || resolveRootForCommand(ctx.command, process.cwd());
      if (!root) return allow(); // not a gsd-core worktree → not this gate's concern
      ctx.worktreeRoot = ctx.worktreeRoot || root;
      if (!resolved.resolvePr) {
        resolved.resolvePr = (sel, repo) => resolvePrLive(root, sel, repo);
      }
      if (!resolved.resolveIsPullRequest) {
        resolved.resolveIsPullRequest = (sel, repo) => resolveIsPullRequestLive(root, sel, repo);
      }
      if (!resolved.artifactExists) {
        resolved.artifactExists = (rel) => fs.existsSync(path.join(root, rel));
      }
      if (!resolved.readArtifactText) {
        resolved.readArtifactText = (rel) => readTextLive(path.join(root, rel), rel);
      }
      if (!resolved.artifactMtimeMs) {
        resolved.artifactMtimeMs = (rel) => mtimeMsLive(path.join(root, rel));
      }
      if (!resolved.writeScaffold) {
        resolved.writeScaffold = (rel, spec) => writeScaffoldIfAbsent(path.join(root, rel), spec);
      }
      if (!resolved.readPostedReviews) {
        resolved.readPostedReviews = (pr, repo) => readPostedReviewsLive(root, pr, repo);
      }
    }
    if (!resolved.readBodyFile) resolved.readBodyFile = readBodyFileLive;

    return gate(stdinString, resolved);
  }, ctx);
}

// ── live readers ────────────────────────────────────────────────────────────

/**
 * Run `gh` in the worktree and return its stdout. THROWS on any failure so the gate fails
 * closed (HARD-01) — an unauthenticated or offline `gh` must never read as "no review exists".
 *
 * @param {string} root
 * @param {string[]} args
 * @returns {string}
 */
function ghLive(root, args) {
  const { execFileSync } = require('node:child_process');
  try {
    return execFileSync('gh', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
  } catch (err) {
    const tail = String((err && (err.stderr || err.message)) || 'gh failure').trim().slice(-400);
    throw new FailClosed('`gh ' + args.join(' ') + '` failed: ' + tail);
  }
}

/** The api path prefix for a repo, using gh's own `{owner}/{repo}` placeholders by default. */
function repoApiPrefix(repoSpec) {
  return 'repos/' + (repoSpec || '{owner}/{repo}');
}

/**
 * Resolve a PR's number and head oid. `gh pr view` accepts a number, a URL, a branch, or
 * nothing at all (the current branch's PR) — so this ONE call covers every selector shape.
 *
 * @param {string} root
 * @param {string|null} selector
 * @param {string|null} repoSpec
 * @returns {{number:number, headOid:string}}
 */
function resolvePrLive(root, selector, repoSpec) {
  const args = ['pr', 'view'];
  if (selector) args.push(String(selector));
  if (repoSpec) args.push('--repo', repoSpec);
  args.push('--json', 'number,headRefOid');
  const out = ghLive(root, args);
  let parsed;
  try {
    parsed = JSON.parse(out);
  } catch (err) {
    throw new FailClosed('could not parse `gh pr view --json number,headRefOid` output');
  }
  return { number: parsed.number, headOid: parsed.headRefOid };
}

/**
 * Is this number a PULL REQUEST? Reads the issues endpoint's `pull_request` link, which is
 * exactly how GitHub itself distinguishes the two across their shared numbering namespace.
 *
 * @param {string} root
 * @param {string|number} selector
 * @param {string|null} repoSpec
 * @returns {boolean}
 */
function resolveIsPullRequestLive(root, selector, repoSpec) {
  const n = String(selector).replace(/[^0-9]/g, '');
  if (!n) throw new FailClosed('ENF-20: no issue/PR number to resolve');
  const out = ghLive(root, [
    'api',
    repoApiPrefix(repoSpec) + '/issues/' + n,
    '--jq',
    '.pull_request.url // ""',
  ]);
  return String(out).trim().length > 0;
}

/**
 * The PR's posted reviews, as `{commit_id, state, body}`. `--paginate` with a `--jq` filter
 * emits one JSON object per line per page, which is the version-portable way to get every
 * page without depending on a newer `--slurp`.
 *
 * @param {string} root
 * @param {string|number} pr
 * @param {string|null} repoSpec
 * @returns {Array<{commit_id:string, state:string, body:string}>}
 */
function readPostedReviewsLive(root, pr, repoSpec) {
  const n = String(pr).replace(/[^0-9]/g, '');
  if (!n) throw new FailClosed('ENF-20: no PR number for the treadmill check');
  const out = ghLive(root, [
    'api',
    '--paginate',
    repoApiPrefix(repoSpec) + '/pulls/' + n + '/reviews',
    '--jq',
    '.[] | {commit_id: .commit_id, state: .state, body: .body} | @json',
  ]);
  const reviews = [];
  for (const line of String(out).split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      reviews.push(JSON.parse(s));
    } catch (_) {
      throw new FailClosed(
        'could not parse the posted-review list for PR #' + n + ' — refusing to guess whether ' +
          'a re-review round already exists at this head oid.'
      );
    }
  }
  return reviews;
}

/**
 * Read an artifact's raw text. THROWS when unreadable (fail closed).
 *
 * @param {string} abs
 * @param {string} rel
 * @returns {string}
 */
function readTextLive(abs, rel) {
  try {
    return fs.readFileSync(abs, 'utf8');
  } catch (err) {
    throw new FailClosed('could not read `' + rel + '`: ' + ((err && err.message) || 'read failure'));
  }
}

/**
 * An artifact's mtime in epoch ms, or -Infinity when unreadable (the recency check then has
 * nothing to compare against, which is a WEAKER check but never a false deny).
 *
 * @param {string} abs
 * @returns {number}
 */
function mtimeMsLive(abs) {
  try {
    return fs.statSync(abs).mtimeMs;
  } catch (_) {
    return -Infinity;
  }
}

/**
 * Read a `--body-file`. THROWS when unreadable: a body we cannot read cannot be checked for a
 * verdict, and guessing "no verdict" would silently skip step 10.
 *
 * @param {string} p
 * @returns {string}
 */
function readBodyFileLive(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (err) {
    throw new FailClosed(
      'could not read the body file `' + String(p) + '` (' +
        ((err && err.message) || 'read failure') +
        '), so this post cannot be checked for a CLEAR verdict.'
    );
  }
}

function main() {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => {
    buf += c;
  });
  process.stdin.on('end', () => {
    emit(runReviewArtifactGate(buf));
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  runReviewArtifactGate,
  gate,
  gateSegment,
  gateApplies,
  requireArtifact,
  verifyMergePreconditions,
  verifyTreadmill,
  parseArtifact,
  reviewSlug,
  normalizeOid,
  prSelector,
  repoSpecOf,
  bodyText,
  fieldCandidates,
  isApproveEvent,
  isHelpInvocation,
  isNativeGhSegment,
  unfilledFields,
  missingText,
  shortfallText,
  liveText,
  ghLive,
  resolvePrLive,
  resolveIsPullRequestLive,
  readPostedReviewsLive,
  readTextLive,
  mtimeMsLive,
  readBodyFileLive,
  repoApiPrefix,
  GATES,
  GATES_BY_ID,
  GOVERNED_ACTIONS,
  COMMENT_ACTIONS,
  ARTIFACT_DIR,
  OID_KEY_LENGTH,
  OID_MIN_LENGTH,
  CLEAR_VERDICT_RE,
  REVIEW_POST_RE,
  TREADMILL_MAX_POSTS_PER_OID,
  CI_GREEN_CONCLUSIONS,
  FINDING_SEVERITIES,
  // isNonEmpty is re-exported so a caller/test can see that ENF-20 shares ENF-19's
  // predicate vocabulary rather than carrying a second copy of it (CTK-ADR-0004 §Decision.1).
  isNonEmpty,
};
