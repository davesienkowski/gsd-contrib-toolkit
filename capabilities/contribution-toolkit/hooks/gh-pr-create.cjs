#!/usr/bin/env node
'use strict';

/**
 * hooks/gh-pr-create.cjs — PreToolUse(Bash) PR filing gate.
 *
 * Enforces, at the PreToolUse boundary, the four things a contribution PR must satisfy
 * BEFORE it is opened — closing the broken-PR failure class the toolkit exists for:
 *
 *   (1) ENF-02  Template: the PR body must pass gsd-core's LIVE pr-template-policy.cjs
 *               (`evaluatePrTemplate(body, authorAssociation, changedFiles) -> {valid}`).
 *   (2) ENF-10  Base: the target branch must be `allowed` per gsd-core's LIVE
 *               pr-target-policy.cjs (`classifyPrTarget(base, head) -> {decision}`).
 *               'blocked' and (conservatively) 'unusual' both DENY.
 *   (3) ENF-10  Linked issue — TOOLKIT-OWNED: the body must carry `Fixes #N` / `Closes #N`.
 *   (4) ENF-10  Branch name — TOOLKIT-OWNED: the head branch must match
 *               `^(fix|docs|feat)/\d+-`.
 *   (5) ENF-18  CI check-runs (Tier-2) — TOOLKIT-OWNED READ: the LIVE check-runs for the
 *               head SHA must show Tests ACTUALLY ran on THIS sha AND every required
 *               check-run concluded `success`. Read via `gh api
 *               repos/<owner>/<repo>/commits/<sha>/check-runs` (the AUTHORITATIVE CI
 *               result), NOT the evaluate-mode branch-protection ruleset rollup which can
 *               show green while Tests are red (#1532/#1543). Fail-closed (deny) when the
 *               result is absent / not-green / unreadable / Tests did not run on the head
 *               SHA. This is the ci-tiering seed's Tier-2: the cross-platform matrix only
 *               runs on GitHub, so the gate confirms the REAL conclusion at the point it
 *               matters (pr-create). There is NO callable LIVE gsd-core script that
 *               governs reading check-runs — the toolkit OWNS this read of the runner's
 *               verdict (NOT a HARD-02 reimplementation: no policy to reimplement).
 *
 * IMPORTANT (red-team H-A): only the base check is a callable LIVE gsd-core script.
 * The linked-issue and branch-name policies live in gsd-core CI WORKFLOWS
 * (`require-issue-link`, `branch-naming`) — NOT callable scripts. Per HARD-02 we may
 * not pretend to "call the repo's script" for them, so the toolkit OWNS those two
 * checks, replicates the CI-workflow policy locally, and DOCUMENTS them as ours (with
 * the attendant drift risk accepted, T-03-03-OWN). The deny reasons are worded
 * accordingly — "the toolkit's own … check (a gsd-core CI-workflow policy replicated
 * here)" — never "the repo's script".
 *
 * ENF-15: the `gh api -X POST repos/.../pulls` and `curl` POST synonyms classify to the
 * same `pr-create` action and are gated identically. HARD-01/04: every path runs inside
 * runGate so an unparseable command, an unobservable stdin body, a missing/reshaped live
 * script, or an unauth gh all FAIL CLOSED (deny) — escapable only by a logged override.
 *
 * @module hooks/gh-pr-create
 */

const path = require('node:path');
const { parseCommand } = require('./lib/argv.cjs');
const { classifyAction, findActionSegment, isNonGovernedCommand } = require('./lib/classify.cjs');
const { runGate, readHookInput, deny, allow, emit, FailClosed, safeCommand } = require('./lib/failclosed.cjs');
const { resolveRootForCommand, requireLiveScript, commandTargetsGsdCore, parseOwnerRepo } = require('./lib/resolve.cjs');

// FailClosed/safeCommand: shared IN-03 helpers from failclosed.cjs.

// Toolkit-OWNED policies (replicated from gsd-core CI workflows — H-A). Documented as
// ours; the deny reasons name them as the toolkit's own.
const LINKED_ISSUE_RE = /\b(?:Fixes|Closes|Resolves)\s+#\d+\b/i;
const BRANCH_NAME_RE = /^(fix|docs|feat)\/\d+-/;

const OWNED_NOTE =
  'This is the toolkit’s own check — a gsd-core CI-workflow policy ' +
  '(require-issue-link / branch-naming) replicated locally, not a callable repo script (ENF-10/H-A).';

// CF-02 (H-A) — the toolkit-OWNED approval-ordering policy, replicated from gsd-core's
// auto-close-unsolicited-prs.yml. A maintainer-applied approval label must live on a linked
// issue for an enhancement/feature PR to open; only users with triage/write can apply labels,
// so requiring one defeats a forged / self-opened "approval" issue. `confirmed-bug` (the fix
// path) is deliberately NOT in this set — fix-bucket PRs are UNAFFECTED (D-04): the LIVE
// enh/feat discriminator is classifyBucket (D-01 reuse), and the residual fix-PR case is still
// caught server-side by the LIVE workflow (D-06: a NEW check, no existing deny surface weakened).
const APPROVAL_LABELS = ['approved-feature', 'approved-enhancement'];

// Bound the number of linked-issue label reads (mirrors the LIVE workflow's MAX_ISSUE_CHECKS)
// so a body stuffed with hundreds of `#N` refs cannot fan out into unbounded gh api calls
// (T-30-02-03 DoS).
const MAX_ISSUE_CHECKS = 20;

// Closing-keyword linked-issue ref matcher (mirrors auto-close-unsolicited-prs.yml): bare
// `#N`, `owner/repo#N`, and `github.com/owner/repo/issues/N`. The cross-repo / URL forms are
// honored ONLY when owner/repo === the target repo (T-30-02-01: a body cannot cite an
// "approved" issue in a DIFFERENT repo to fake approval).
const LINKED_ISSUE_REF_RE =
  /\b(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?)\b[\s:]*(?:#(\d+)|([\w.-]+)\/([\w.-]+)#(\d+)|https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/issues\/(\d+))/gi;

const APPROVAL_OWNED_NOTE =
  'This is the toolkit’s own check — a gsd-core CI-workflow policy ' +
  '(auto-close-unsolicited-prs) replicated locally, not a callable repo script: an ' +
  'enhancement/feature PR must link an issue carrying a maintainer-applied ' +
  '`approved-enhancement` / `approved-feature` label before it can open (CF-02 / D-02 / D-04 / D-06).';

// ENF-18 Tier-2: which check-run name(s) carry the authoritative Tests verdict. A
// changeset-only commit can skip Tests (#1532) — so "Tests ran" is asserted on the head
// SHA's OWN check-runs, never inferred from a rollup.
const TESTS_CHECK_RE = /\btests?\b/i;

// A check-run conclusion is GREEN only when it is exactly 'success'. Anything else —
// 'failure', 'neutral', 'skipped', 'cancelled', 'timed_out', 'action_required',
// 'stale', null (still in_progress / not concluded) — is NOT green (#1532/#1543).
const GREEN_CONCLUSION = 'success';

/**
 * Pure ENF-18 Tier-2 decision over a NORMALIZED check-runs object for the head SHA.
 *
 * Green ONLY when Tests actually ran on THIS head SHA (testsRan === true) AND every
 * required check-run concluded `success` (allRequiredGreen === true). A missing flag,
 * an empty check-runs set (changeset-only commit that skipped Tests — the #1532 gotcha),
 * a not-`success` conclusion, or a stale conclusion from an earlier SHA → NOT green.
 *
 * @param {{headSha?:string, testsRan?:boolean, allRequiredGreen?:boolean, conclusions?:Array}} checkRuns
 * @returns {{green:boolean, reason:string}}
 */
function evaluateCiResult(checkRuns) {
  if (!checkRuns || typeof checkRuns !== 'object') {
    return { green: false, reason: 'no CI check-runs object for the head SHA' };
  }
  if (checkRuns.testsRan !== true) {
    return {
      green: false,
      reason:
        'Tests did NOT run on the head SHA' +
        (checkRuns.headSha ? ' ' + checkRuns.headSha : '') +
        ' (an empty / changeset-only check-runs set — a stale-rollup guard, #1532)',
    };
  }
  if (checkRuns.allRequiredGreen !== true) {
    return {
      green: false,
      reason:
        'a required CI check-run for the head SHA' +
        (checkRuns.headSha ? ' ' + checkRuns.headSha : '') +
        ' is not green (only `success` counts; failure/neutral/skipped/in_progress do not)',
    };
  }
  return { green: true, reason: 'Tests ran and all required check-runs concluded success' };
}

/**
 * Normalize a `\n` sentinel (the shell-token form of a multi-line body) into real
 * newlines so the LIVE template policy — which splits on real newlines to find
 * headings — sees the intended structure. Real embedded newlines pass through.
 *
 * @param {string} s
 * @returns {string}
 */
function normalizeBody(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\\r/g, '\n');
}


/**
 * Walk a segment's structured tokens pulling gh-api `-f/-F/--field key=value` pairs.
 * @param {Object} seg
 * @param {(key:string, value:string)=>void} cb
 */
function scanFieldPairs(seg, cb) {
  const tokens = seg.tokens || [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    let kv = null;
    if (t === '-f' || t === '-F' || t === '--field' || t === '--raw-field') {
      kv = tokens[i + 1];
    } else if (t.startsWith('-f') && t.length > 2) {
      kv = t.slice(2);
    } else if (t.startsWith('--field=')) {
      kv = t.slice('--field='.length);
    } else if (t.startsWith('--raw-field=')) {
      kv = t.slice('--raw-field='.length);
    }
    if (typeof kv !== 'string') continue;
    const eq = kv.indexOf('=');
    if (eq === -1) continue;
    cb(kv.slice(0, eq), kv.slice(eq + 1));
  }
}

/**
 * Resolve the PR BODY across native / gh-api / curl routes. Throws FailClosed when the
 * body is read from a stdin the hook cannot observe (HARD-04).
 *
 * @param {Object} seg
 * @param {string} route
 * @param {(p:string)=>(string|null)} readBodyFile
 * @returns {string}
 */
function resolveBody(seg, route, readBodyFile) {
  const flags = seg.flags || {};

  if (route === 'native') {
    if (typeof flags.body === 'string') return normalizeBody(flags.body);
    const bf = flags['body-file'];
    if (typeof bf === 'string') {
      if (bf === '-') {
        throw new FailClosed(
          'PR body is read from stdin (--body-file -), which a PreToolUse hook cannot ' +
            'observe — failing closed (HARD-04): cannot confirm the PR template'
        );
      }
      const content = readBodyFile(bf);
      if (typeof content !== 'string') {
        throw new FailClosed('could not read --body-file ' + bf + ' — failing closed');
      }
      return content;
    }
    return '';
  }

  if (route === 'gh-api') {
    let body = null;
    let stdinSentinel = false;
    scanFieldPairs(seg, (k, v) => {
      if (k !== 'body') return;
      if (v.startsWith('@')) {
        const src = v.slice(1);
        if (src === '-') stdinSentinel = true;
        else {
          const content = readBodyFile(src);
          body = typeof content === 'string' ? content : null;
        }
      } else {
        body = normalizeBody(v);
      }
    });
    if (stdinSentinel) {
      throw new FailClosed('gh api PR body is read from stdin (-F body=@-) — failing closed (HARD-04)');
    }
    return typeof body === 'string' ? body : '';
  }

  // curl
  const shortFlags = seg.shortFlags || {};
  let payload = typeof flags.data === 'string' ? flags.data : shortFlags.d;
  if (payload === '@-' || payload === '-') {
    throw new FailClosed('curl PR body is read from stdin (-d @-) — failing closed (HARD-04)');
  }
  if (typeof payload === 'string') {
    const body = jsonField(payload, 'body');
    return body == null ? normalizeBody(payload) : normalizeBody(body);
  }
  return '';
}

/**
 * Resolve the target BASE branch across routes. Native: --base/-B. gh-api: -f base=.
 * curl: JSON "base". Returns null when unresolved (caller treats conservatively).
 *
 * @param {Object} seg
 * @param {string} route
 * @returns {string|null}
 */
function resolveBase(seg, route) {
  const flags = seg.flags || {};
  const shortFlags = seg.shortFlags || {};
  if (route === 'native') {
    if (typeof flags.base === 'string') return flags.base;
    if (typeof shortFlags.B === 'string') return shortFlags.B;
    return null;
  }
  if (route === 'gh-api') {
    let base = null;
    scanFieldPairs(seg, (k, v) => {
      if (k === 'base') base = v;
    });
    return base;
  }
  // curl
  const payload = typeof flags.data === 'string' ? flags.data : shortFlags.d;
  if (typeof payload === 'string') return jsonField(payload, 'base');
  return null;
}

/**
 * CF-01: resolve the PR TITLE across native / gh-api / curl routes (mirrors hooks/issue-dedupe.cjs
 * resolveTitle). Native reads `--title`/`-t`; gh-api reads the `-f title=` / `--field title=` pair
 * via the file's existing scanFieldPairs; curl reads the JSON `title` from the -d/--data payload
 * via jsonField. Returns '' when no title is asserted — the caller denies an UNOBSERVABLE title
 * (a PreToolUse hook cannot confirm a convention it cannot read, HARD-04), never a silent allow.
 *
 * @param {Object} seg
 * @param {string} route 'native' | 'gh-api' | 'curl'
 * @returns {string}
 */
function resolveTitle(seg, route) {
  const flags = (seg && seg.flags) || {};
  const shortFlags = (seg && seg.shortFlags) || {};

  if (route === 'native') {
    if (typeof flags.title === 'string') return flags.title;
    if (typeof shortFlags.t === 'string') return shortFlags.t;
    return '';
  }

  if (route === 'gh-api') {
    let title = '';
    scanFieldPairs(seg, (k, v) => {
      if (k === 'title') title = v;
    });
    return title;
  }

  // curl: the title travels inside the JSON -d/--data payload.
  const payload = typeof flags.data === 'string' ? flags.data : shortFlags.d;
  if (typeof payload === 'string') {
    const fromJson = jsonField(payload, 'title');
    if (fromJson != null) return fromJson;
  }
  return '';
}

/**
 * Resolve the HEAD branch the PR actually opens FROM across routes — honoring an explicit
 * `--head`/`-H <branch>` (incl. the cross-repo `owner:branch` form) when present, else null
 * so the caller falls back to the current branch (deps.branch).
 *
 * SUBTLE PARSING CONSTRAINT (binding, verified 2026-06-26): `-H` is ALSO gh's HTTP-header
 * flag — the hook's own `gh api -H 'Accept: …'` and the user's gh-api/curl routes carry an
 * HTTP header in `-H`, NEVER the head. So `-H` is read as the head ONLY on the NATIVE
 * `gh pr create` route. On gh-api the head travels via `-f head=`; on curl via the JSON
 * "head" field. Reading `-H` as head on those routes would mistake `Accept: …` for a branch.
 *
 * @param {Object} seg
 * @param {string} route 'native' | 'gh-api' | 'curl'
 * @returns {string|null} the raw head string (possibly `owner:branch`), or null when absent
 */
function resolveHead(seg, route) {
  const flags = (seg && seg.flags) || {};
  const shortFlags = (seg && seg.shortFlags) || {};
  if (route === 'native') {
    // `--head v` / `--head=v` → flags.head; `-H v` / `-Hv` → shortFlags.H. NATIVE route only.
    if (typeof flags.head === 'string') return flags.head;
    if (typeof shortFlags.H === 'string') return shortFlags.H;
    return null;
  }
  if (route === 'gh-api') {
    // The head is an `-f head=` / `--field head=` PAIR here — NEVER `-H` (that is the
    // `Accept:` HTTP header on this route). Reading `-H` as head would be the spoof.
    let head = null;
    scanFieldPairs(seg, (k, v) => {
      if (k === 'head') head = v;
    });
    return head;
  }
  // curl: head travels in the JSON payload, never `-H` (an HTTP header here too).
  const payload = typeof flags.data === 'string' ? flags.data : shortFlags.d;
  if (typeof payload === 'string') return jsonField(payload, 'head');
  return null;
}

/**
 * Split a raw head value into `{ headOwner, headBranch }`. The cross-repo `--head owner:branch`
 * form carries a fork OWNER before the `:`; a bare branch has no owner. Git branch names cannot
 * contain `:`, so a `:` reliably marks the owner/branch boundary (only the FIRST `:` is the
 * separator). A leading/trailing-empty colon form is treated as a bare branch (headOwner null).
 *
 * @param {string} rawHead
 * @returns {{headOwner:string|null, headBranch:string}}
 */
function splitHead(rawHead) {
  if (typeof rawHead !== 'string') return { headOwner: null, headBranch: rawHead };
  const colon = rawHead.indexOf(':');
  if (colon === -1) return { headOwner: null, headBranch: rawHead };
  const owner = rawHead.slice(0, colon);
  const branch = rawHead.slice(colon + 1);
  if (owner.length === 0 || branch.length === 0) return { headOwner: null, headBranch: rawHead };
  return { headOwner: owner, headBranch: branch };
}

/**
 * Best-effort extract a string field from a JSON-ish payload. Prefers JSON.parse.
 * @param {string} payload
 * @param {string} key
 * @returns {string|null}
 */
function jsonField(payload, key) {
  if (typeof payload !== 'string') return null;
  try {
    const obj = JSON.parse(payload);
    if (obj && typeof obj === 'object' && typeof obj[key] === 'string') return obj[key];
  } catch (_) {
    /* fall through */
  }
  const re = new RegExp('"' + key + '"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"');
  const m = re.exec(payload);
  if (!m) return null;
  return m[1]
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

/**
 * CF-02: collect the SAME-REPO issue numbers a PR body links with a GitHub closing keyword
 * (Closes/Fixes/Resolves), mirroring auto-close-unsolicited-prs.yml's ref semantics. Fenced /
 * inline code is stripped first so a documented example (e.g. a template's `Closes #123`) does
 * not count as a link. Bare `#N` always counts; the `owner/repo#N` and
 * `github.com/owner/repo/issues/N` cross-repo / URL forms count ONLY when owner/repo === the
 * target repo (T-30-02-01 — an approving label must live on an issue in THIS repo). The result
 * is a de-duplicated array of positive integers, capped at MAX_ISSUE_CHECKS (T-30-02-03 DoS).
 *
 * @param {string} body the PR body.
 * @param {{owner?:string, repo?:string}} [targetRepo] the repo the PR targets (for cross-repo
 *   ref matching); when absent, only bare `#N` refs are collected.
 * @returns {number[]} de-duplicated linked issue numbers, capped at 20.
 */
function extractLinkedIssues(body, targetRepo) {
  if (typeof body !== 'string' || !body) return [];
  const scan = body.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '');
  const owner = targetRepo && targetRepo.owner ? String(targetRepo.owner).toLowerCase() : null;
  const repo = targetRepo && targetRepo.repo ? String(targetRepo.repo).toLowerCase() : null;
  const seen = new Set();
  const numbers = [];
  const add = (raw) => {
    const num = Number(raw);
    if (!Number.isInteger(num) || num <= 0 || seen.has(num)) return;
    seen.add(num);
    numbers.push(num);
  };
  for (const m of scan.matchAll(LINKED_ISSUE_REF_RE)) {
    if (m[1]) {
      add(m[1]);
    } else if (owner && repo && m[2] && m[3] && m[2].toLowerCase() === owner && m[3].toLowerCase() === repo) {
      add(m[4]);
    } else if (owner && repo && m[5] && m[6] && m[5].toLowerCase() === owner && m[6].toLowerCase() === repo) {
      add(m[7]);
    }
  }
  return numbers.slice(0, MAX_ISSUE_CHECKS);
}

/**
 * The pure PR gate decision with all impure deps injected.
 *
 * @param {string} stdinString raw PreToolUse JSON
 * @param {Object} deps
 * @param {{evaluatePrTemplate:Function}} deps.liveTemplate LIVE pr-template-policy export
 * @param {{classifyPrTarget:Function}} deps.liveTarget LIVE pr-target-policy export
 * @param {{evaluatePrTitle:Function}} deps.liveTitle LIVE conventional-title export (CF-01)
 * @param {string} deps.branch current head branch name
 * @param {string[]} [deps.changedFiles] changed files (for the template tooling carve-out)
 * @param {string} [deps.authorAssociation] e.g. 'OWNER'
 * @param {(p:string)=>(string|null)} deps.readBodyFile
 * @param {(headSha:string)=>{headSha:string,testsRan:boolean,allRequiredGreen:boolean,conclusions:Array}} deps.readCheckRuns
 *   ENF-18 injectable read of the head SHA's AUTHORITATIVE check-runs (throws → fail-closed)
 * @param {(branch:string)=>Array} deps.listPrsForHead
 *   ROB-02 injectable read of the OPEN PRs for the head branch (empty → first create → CI-green
 *   relaxed; non-empty → existing PR → check-run gate engages; throws → fail-closed)
 * @param {(number:number, targetRepo:{owner:string,repo:string})=>string[]} deps.readIssueLabels
 *   CF-02 injectable read of a linked issue's label names (throws → fail-closed deny for enh/feat)
 * @param {{evaluateLint:Function, readFragmentsFromDisk:Function}} deps.liveDocsLint
 *   CF-03 LIVE lint-docs-required export (call, never fork — D-01/D-06); missing script → deny
 * @param {(root:string, base:string)=>string[]} deps.readChangedFiles
 *   CF-03 injectable read of the PR's changed files (default `git diff --name-only
 *   origin/<base>...HEAD`); a throw → fail-closed deny (HARD-01: an unreadable diff denies)
 * @param {{owner:string,repo:string}|null} [deps.targetRepo] the command's explicit -R/GH_REPO target
 * @param {string} [deps.headSha] inject the head SHA directly (else resolved from deps.root)
 * @param {string} [deps.root] worktree root the ENF-18 head-SHA resolution reads from
 * @returns {{permissionDecision:string, permissionDecisionReason?:string}}
 */
function gate(stdinString, deps) {
  const input = readHookInput(stdinString);
  const command = (input.tool_input && input.tool_input.command) || '';

  const parsed = parseCommand(command);
  if (!parsed.ok) throw new FailClosed('unparseable command: ' + parsed.reason);

  const action = classifyAction(parsed);
  if (action.failClosed) {
    throw new FailClosed('unclassifiable mutating github call — failing closed (ENF-15)');
  }
  if (action.action !== 'pr-create') return allow();

  const seg = findActionSegment(parsed, 'pr-create');
  const route = action.route || 'native';

  // (0) WR-04 — un-observable body. `gh pr create --fill` / `--fill-first` auto-populates the
  // body from commit messages, and `--web` opens the browser editor; in all three the body the
  // hook sees (resolveBody → '') is NOT the body GitHub will use, so the ENF-02 template policy
  // would deny with a misleading template-mismatch reason. This stays a fail-closed DENY (the
  // hook genuinely cannot observe the resulting body) but with a PRECISE reason directing the
  // user to the real remedy. Detect by KEY PRESENCE, not truthy value: argv may capture a
  // following non-flag token as the flag's value, so `seg.flags['fill']` could be a string.
  // gh-api/curl routes have no --fill/--web, so this branch is native-only.
  if (route === 'native') {
    const segFlags = seg.flags || {};
    if ('fill' in segFlags || 'fill-first' in segFlags || 'web' in segFlags) {
      return deny(
        'PR body is generated by --fill / --fill-first or opened in --web, which a PreToolUse ' +
          'hook cannot observe — provide --body / --body-file <file> so the typed PR template can ' +
          'be confirmed before the PR is opened.'
      );
    }
  }

  const body = resolveBody(seg, route, deps.readBodyFile); // may throw FailClosed
  const base = resolveBase(seg, route);
  // CHD-03: honor an explicit `--head`/`-H <branch>` (route-scoped to native) so EVERY
  // head-dependent check below evaluates the branch the PR actually opens FROM — falling back
  // to deps.branch ONLY when no `--head` is given (the no-head path is byte-for-byte unchanged).
  // Split the cross-repo `owner:branch` form: the BRANCH portion drives the ENF-10 base/branch
  // policies + the ROB-02 listPrsForHead; the OWNER (when present) resolves the head's OWN repo
  // for the head-SHA + check-runs read (the CI lives in the head fork, not the base/origin).
  const rawHead = resolveHead(seg, route) || deps.branch;
  const { headOwner, headBranch } = splitHead(rawHead);
  const head = headBranch; // every head-dependent check evaluates the branch portion

  // (1) ENF-02 — LIVE template policy (call, never reimplement).
  const tmpl = deps.liveTemplate.evaluatePrTemplate(
    body,
    deps.authorAssociation || 'OWNER',
    deps.changedFiles
  );
  if (!tmpl || tmpl.valid !== true) {
    return deny(
      'PR blocked by the LIVE pr-template-policy (ENF-02): ' +
        ((tmpl && tmpl.reason) || 'PR body does not match a typed PR template') +
        '. Use a fix / enhancement / feature template.'
    );
  }

  // (2) ENF-10 — LIVE base policy (call, never reimplement). Conservative: only
  // 'allowed' passes; 'blocked' and 'unusual' deny.
  if (base == null || base === '') {
    throw new FailClosed(
      'could not resolve the PR base branch — failing closed (HARD-04): cannot confirm the target is allowed'
    );
  }
  const target = deps.liveTarget.classifyPrTarget(base, head);
  if (!target || target.decision !== 'allowed') {
    return deny(
      'PR base `' +
        base +
        '` is ' +
        ((target && target.decision) || 'not allowed') +
        ' per the LIVE pr-target-policy (ENF-10). Contributions target `next`.'
    );
  }

  // (CF-01) LIVE conventional-title check — CALL gsd-core's LIVE evaluatePrTitle, NEVER a forked
  // regex (D-01/D-06/HARD-02). Sits BETWEEN the ENF-10 base check and the toolkit-owned
  // linked-issue check. gsd-core's pr-title-validator.yml is WARN_ONLY:false, so a `(<area>)`-only
  // or leading-tag title fails the REQUIRED check on the cut; this surfaces that failure BEFORE
  // the PR is opened (#1549). An empty/unobservable title cannot be confirmed → deny asking for an
  // explicit --title (HARD-04). A non-conforming title denies with the LIVE matcher's OWN message.
  const title = resolveTitle(seg, route);
  if (typeof title !== 'string' || title.trim() === '') {
    return deny(
      'PR title is not observable (no --title/-t was given), so the required ' +
        '`<type>(#<issue>): summary` convention cannot be confirmed — provide an explicit ' +
        '--title/-t (CF-01 — gsd-core LIVE conventional-title / #1549; ' +
        'pr-title-validator.yml is WARN_ONLY:false).'
    );
  }
  const titleRes = deps.liveTitle.evaluatePrTitle({ title });
  if (!titleRes || titleRes.valid !== true) {
    return deny(
      (titleRes && titleRes.message ? titleRes.message : 'PR title is not conventional') +
        ' (CF-01 — gsd-core LIVE conventional-title / #1549; ' +
        'pr-title-validator.yml is WARN_ONLY:false).'
    );
  }

  // (3) ENF-10 — TOOLKIT-OWNED linked-issue check (H-A).
  if (!LINKED_ISSUE_RE.test(body)) {
    return deny(
      'PR body is missing a linked issue (e.g. `Fixes #123` / `Closes #123`). ' +
        OWNED_NOTE
    );
  }

  // (4) ENF-10 — TOOLKIT-OWNED branch-name check (H-A).
  if (typeof head !== 'string' || !BRANCH_NAME_RE.test(head)) {
    return deny(
      'Head branch `' +
        String(head) +
        '` does not match the required `fix|docs|feat/<issue#>-slug` form. ' +
        OWNED_NOTE
    );
  }

  // (CF-02) Approval-ordering pre-check — TOOLKIT-OWNED (H-A), replicated from gsd-core's
  // auto-close-unsolicited-prs.yml (which closes an enh/feat PR at open time when its linked
  // issue lacks an approval label). We surface that DENY BEFORE the PR opens. The enh/feat
  // discriminator is the LIVE classifyBucket (D-01 reuse — reusing the SAME title resolved for
  // CF-01, never a forked regex). Fix-bucket PRs are UNAFFECTED (D-04): they fall through. For a
  // Feature/Enhancement, at least one linked issue must carry a maintainer-applied
  // `approved-feature` / `approved-enhancement` label; the labels are read via the injected
  // deps.readIssueLabels(number, targetRepo) — a throw propagates to runGate → fail-closed deny
  // (HARD-01), so an unreadable label set can never be presented as "approved" (D-04). This adds
  // a NEW toolkit check and weakens no existing deny surface (D-06).
  const bucket = deps.liveTitle.classifyBucket(title);
  if (bucket !== 'Fix') {
    const issues = extractLinkedIssues(body, deps.targetRepo);
    let approved = false;
    for (const number of issues) {
      const labels = deps.readIssueLabels(number, deps.targetRepo); // may throw → fail-closed deny
      if (Array.isArray(labels) && labels.some((l) => APPROVAL_LABELS.includes(l))) {
        approved = true;
        break;
      }
    }
    if (!approved) {
      return deny(
        'This ' +
          bucket.toLowerCase() +
          ' PR cannot open: its linked issue does not carry a maintainer-applied ' +
          '`approved-feature` / `approved-enhancement` label, so gsd-core would auto-close it at ' +
          'open time (CF-02). ' +
          APPROVAL_OWNED_NOTE
      );
    }
  }

  // (CF-03) docs-required mirror — REUSE gsd-core's LIVE lint-docs-required (evaluateLint +
  // readFragmentsFromDisk), NEVER a forked policy (D-01/D-06/HARD-02). gsd-core's
  // docs-required.yml (#3213) fails a PR whose changeset introduces new/changed/removed behavior
  // (`.changeset/*.md` fragments of type Added/Changed/Deprecated/Removed) without a corresponding
  // `docs/` change; we surface that DENY BEFORE the push. The require-issue-link HALF of CF-03 is
  // ALREADY satisfied by the toolkit-owned LINKED_ISSUE_RE check above (#3) — no new code for it.
  //
  // We read the PR's changed files via the injected deps.readChangedFiles(root, base) (default:
  // `git diff --name-only origin/<base>...HEAD`) — a throw propagates to runGate → fail-closed
  // deny (HARD-01: an unreadable diff cannot confirm docs). The LIVE readFragmentsFromDisk parses
  // each touched `.changeset/*.md` from the SAME resolved worktree root, then the LIVE evaluateLint
  // renders the verdict. labels:[] pre-PR — the `no-docs` opt-out is a maintainer-applied LABEL a
  // contributor cannot self-apply before the PR exists (documented narrowing, T-30-03-04); the
  // per-fragment `<!-- docs-exempt: reason -->` opt-out is STILL honored via the LIVE parse. A
  // non-ok verdict (FAIL_DOCS_MISSING / FAIL_MALFORMED_FRAGMENT — the latter fails closed,
  // T-30-03-02) DENIES with the LIVE verdict.reason + triggering fragment paths.
  const changedFiles = deps.readChangedFiles(deps.root, base); // throw → fail-closed deny (HARD-01)
  const { fragments, malformed } = deps.liveDocsLint.readFragmentsFromDisk(changedFiles, deps.root);
  const docsVerdict = deps.liveDocsLint.evaluateLint({ changedFiles, fragments, labels: [], malformed });
  if (!docsVerdict || docsVerdict.ok !== true) {
    const trig =
      Array.isArray(docsVerdict && docsVerdict.triggering) && docsVerdict.triggering.length
        ? ' (triggering: ' + docsVerdict.triggering.join(', ') + ')'
        : '';
    return deny(
      'PR blocked by the LIVE docs-required lint (CF-03 — mirrors gsd-core `docs-required.yml` ' +
        '#3213): ' +
        ((docsVerdict && docsVerdict.reason) || 'docs-required verdict not ok') +
        trig +
        '. An Added/Changed/Deprecated/Removed changeset needs a corresponding `docs/` change or a ' +
        'per-fragment `<!-- docs-exempt: <reason> -->` marker (fix the fragment frontmatter if it ' +
        'is malformed). This CALLS gsd-core’s LIVE lint (evaluateLint), never a forked policy ' +
        '(D-01/D-06/HARD-02).'
    );
  }

  // (5) ENF-18 Tier-2 — TOOLKIT-OWNED read of the AUTHORITATIVE CI result for the head
  // SHA. The four checks above gate FIRST and unchanged; this is an ADDITIONAL condition
  // on the pr-create path. We resolve the head SHA from the SAME worktree root the gate
  // already used (deps.root / deps.worktreeRoot), then read its check-runs. A throw from
  // resolveHeadSha or readCheckRuns (gh unauth, spawn fail, unparseable JSON, missing
  // SHA) propagates to runGate → fail-closed deny (HARD-01). readCheckRuns reads the REAL
  // check-runs (commits/<sha>/check-runs), NOT the evaluate-mode ruleset rollup.
  //
  // ROB-02 first-create relaxation: gsd-core's CI runs on `pull_request` (and pushes to
  // next/main/release/hotfix), so a green check-run precondition is UNSATISFIABLE before the
  // PR exists — the first `gh pr create` was blocked every time during the live #1154 → PR
  // #1738 run. BEFORE resolving the head SHA, consult an injectable listPrsForHead(head) for
  // the head branch: an EMPTY open-PR list means no PR exists yet → CI cannot have run → SKIP
  // the check-run gate and fall through to ALLOW (preconditions 0-4 having already passed —
  // ONLY the CI-green step is relaxed). A NON-EMPTY list means an open PR exists → run the
  // UNCHANGED check-run gate below (a concluded non-`success` conclusion STILL DENIES — the
  // green-gate is preserved for re-creates / existing-PR head SHAs). If listPrsForHead THROWS
  // (gh unauth / unreadable), it propagates to runGate → fail-closed deny (HARD-01), mirroring
  // the readCheckRuns throw discipline. The discriminator is "no OPEN PR for the head branch"
  // (`--state open`), NOT "zero check-runs on the head SHA" — a post-PR branch can transiently
  // have zero queued runs and must not be able to masquerade as a first create.
  // WR-01: thread the command's EXPLICIT -R/GH_REPO target ({owner,repo}|null, resolved ONCE in
  // runPrGate from the same parsed command the gate sees) into BOTH readers, so the repo they
  // read the open-PR list / check-runs FROM is provably the repo the command targets — not the
  // worktree origin unconditionally. null → the default readers fall back to origin (unchanged).
  const openPrs = deps.listPrsForHead(head, deps.targetRepo); // may throw → fail-closed deny (HARD-01)
  if (Array.isArray(openPrs) && openPrs.length === 0) {
    return allow(); // first create — no open PR yet, CI cannot have run; CI-green step relaxed
  }

  // CHD-03: resolve the head's REPO + SHA. For an `owner:branch` cross-repo head the CI lives
  // in the HEAD owner's fork (same repo NAME as the base, different owner), NOT the base/origin —
  // so the check-runs read targets that repo (reusing the WR-01 single-source reader plumbing:
  // the head's repo is threaded into readCheckRuns exactly like an explicit -R target). A
  // cross-repo head SHA cannot be read from the local worktree, so it is resolved from the head's
  // repo; an unresolvable head (gh read throws) propagates → runGate fail-closed deny (HARD-01).
  // When headOwner is null (no --head, or a bare same-repo branch) the LOCAL resolveHeadSha(root)
  // + the WR-01 deps.targetRepo path are UNCHANGED.
  const headRepo = headOwner
    ? resolveHeadRepo(headOwner, deps.targetRepo, deps.root || deps.worktreeRoot)
    : null;
  const readTarget = headRepo || deps.targetRepo;
  const headSha =
    typeof deps.headSha === 'string' && deps.headSha
      ? deps.headSha
      : headOwner
        ? resolveCrossRepoHeadSha(deps.root || deps.worktreeRoot, headRepo, headBranch)
        : resolveHeadSha(deps.root || deps.worktreeRoot);
  const checkRuns = deps.readCheckRuns(headSha, readTarget); // may throw → fail-closed deny
  const ci = evaluateCiResult(checkRuns);
  if (!ci.green) {
    return deny(
      'PR blocked (ENF-18 / Tier-2): ' +
        ci.reason +
        '. ENF-18 stance: EVERY check-run on the head SHA must conclude exactly `success` — this ' +
        'toolkit treats all runs as required and does NOT consult branch-protection ' +
        'required_status_checks. ' +
        'The cross-platform matrix runs on GitHub, so a contribution cannot open a PR ' +
        'until the LIVE CI check-runs for the head SHA ' +
        (headSha ? '(' + headSha + ') ' : '') +
        'show Tests genuinely ran and concluded success. This reads the authoritative CI ' +
        'result, not the evaluate-mode branch-protection ruleset rollup (#1532).'
    );
  }

  return allow();
}

/**
 * Injectable entry seam. Builds runGate ctx and defaults the LIVE script deps + the
 * current branch from the real environment when not injected.
 *
 * @param {string} stdinString raw PreToolUse JSON
 * @param {Object} [deps]
 * @returns {{permissionDecision:string, permissionDecisionReason?:string}}
 */
function runPrGate(stdinString, deps = {}) {
  const ctx = {
    command: safeCommand(stdinString),
    action: 'pr-create',
    worktreeRoot: deps.worktreeRoot,
    overrideImpl: deps.overrideImpl,
  };

  return runGate(() => {
    // RES-01 action-first short-circuit: classify the governed action (pure
    // parse→classify, NO filesystem) at the VERY TOP — ABOVE resolveExplicitTarget — so a
    // confidently non-governed command allows without loading any LIVE pr-template/pr-target
    // policy AND without being subjected to the -R/--repo extraction (a non-pr-create command
    // carrying an odd -R must not be spuriously fail-closed by explicit-target resolution — a
    // correctness improvement, not just a cost saving). Governed pr-create (HARD-02),
    // unparseable (HARD-04), and ENF-15 synonyms all return false here and fall through
    // unchanged to the resolve+gate path below.
    if (isNonGovernedCommand(parseCommand(ctx.command), ['pr-create'])) {
      return allow();
    }

    const resolved = Object.assign({}, deps);
    // WR-01: resolve the command's EXPLICIT -R/--repo/GH_REPO target ONCE from the parsed command
    // (the SAME extraction the gate's targeting decision uses — single source so the reader repo
    // cannot diverge from the gate's targeting repo). null = no explicit target → the readers fall
    // back to the worktree origin (unchanged). An explicit target that parseOwnerRepo cannot
    // resolve THROWS FailClosed here → runGate fail-closed deny (no silent origin-fallback ALLOW).
    if (resolved.targetRepo === undefined) {
      resolved.targetRepo = resolveExplicitTarget(parseCommand(ctx.command));
    }
    // Resolve the root from the command's OWN cwd (it may `cd` into a worktree), not the
    // session cwd. null = the command does not target a gsd-core checkout → allow. The
    // head branch is read from that same root so a cross-repo session reads the worktree's
    // branch, not the session repo's.
    let root = resolved.worktreeRoot || null;
    if (!root && (!resolved.liveTemplate || !resolved.liveTarget || !resolved.liveTitle || !resolved.liveDocsLint || !resolved.branch)) {
      root = resolveRootForCommand(ctx.command, process.cwd());
      if (!root) {
        // ROB-01 locked discriminator (same seam as gh-issue-create): an out-of-tree command
        // (null root) passes through (ALLOW) ONLY when it does NOT target upstream
        // open-gsd/gsd-core. A -R/--repo / gh-api / curl command that targets it is a real PR
        // action we cannot verify without a checkout → fail closed (HARD-02). NOTE: this is the
        // runPrGate null-root seam ONLY; the ENF-18 first-create / check-run logic in gate() is
        // owned by ROB-02 (plan 25-02) and is deliberately untouched here.
        if (commandTargetsGsdCore(parseCommand(ctx.command))) {
          throw new FailClosed(
            'out-of-tree command targets upstream open-gsd/gsd-core (-R/--repo / gh-api / curl) ' +
              'but no local gsd-core checkout is reachable from its cwd — cannot load the LIVE ' +
              'pr-template / pr-target policy to verify it (HARD-02: no runtime-root fallback) → ' +
              'failing closed.'
          );
        }
        return allow();
      }
    }
    ctx.worktreeRoot = ctx.worktreeRoot || root;
    if (!resolved.liveTemplate) {
      resolved.liveTemplate = requireLiveScript(root, 'scripts/pr-template-policy.cjs');
    }
    if (!resolved.liveTarget) {
      resolved.liveTarget = requireLiveScript(root, 'scripts/pr-target-policy.cjs');
    }
    if (!resolved.liveTitle) {
      // CF-01: load gsd-core's LIVE conventional-title matcher the SAME way as the template/target
      // policies. A missing/reshaped script throws ScriptResolveError → runGate fail-closed deny
      // (HARD-02) for a gsd-core-targeting create — no vendored fallback, no forked regex (D-06).
      resolved.liveTitle = requireLiveScript(root, 'scripts/release-notes/conventional-title.cjs');
    }
    if (!resolved.liveDocsLint) {
      // CF-03: load gsd-core's LIVE docs-required lint the SAME way as the other policies. A
      // missing/reshaped script throws ScriptResolveError → runGate fail-closed deny (HARD-02)
      // for a gsd-core-targeting create — no vendored fallback, no forked lint (D-01/D-06).
      resolved.liveDocsLint = requireLiveScript(root, 'scripts/lint-docs-required.cjs');
    }
    if (!resolved.branch) {
      resolved.branch = currentBranch(root);
    }
    // Hand the resolved root to gate() so the ENF-18 head-SHA resolution reads the SAME
    // worktree the four checks above used (not the session cwd).
    if (!resolved.root) {
      resolved.root = root || resolved.worktreeRoot;
    }
    if (!resolved.readCheckRuns) {
      resolved.readCheckRuns = (headSha, targetRepo) => defaultReadCheckRuns(resolved.root, headSha, targetRepo);
    }
    if (!resolved.listPrsForHead) {
      // ROB-02: default first-create detector — list the OPEN PRs for the head branch from the
      // SAME worktree root the rest of the gate uses. An empty array → first create (CI-green
      // relaxed); a non-empty array → existing PR (check-run gate engages). Any spawn/parse/auth
      // failure THROWS FailClosed (an unauth gh DENIES, never relaxes) — mirrors readCheckRuns.
      // WR-01: when an explicit -R/GH_REPO target is present it reads from THAT repo, not origin.
      resolved.listPrsForHead = (branch, targetRepo) => defaultListPrsForHead(resolved.root, branch, targetRepo);
    }
    if (!resolved.readIssueLabels) {
      // CF-02: default the linked-issue label reader from the SAME resolved root + WR-01 explicit
      // target the rest of the gate uses. A throw (invalid number / unauth gh / unparseable JSON /
      // no origin) fails closed → an enh/feat PR whose approval cannot be confirmed DENIES (D-04),
      // never a silent allow. liveTitle (CF-01) is already wired above and reused for classifyBucket.
      resolved.readIssueLabels = (n, tr) => defaultReadIssueLabels(resolved.root, n, tr);
    }
    if (!resolved.readChangedFiles) {
      // CF-03: default the PR-diff reader from the SAME resolved root the rest of the gate uses.
      // A throw (not a git repo / missing origin/<base>) fails closed → a create whose docs
      // coverage cannot be confirmed DENIES (HARD-01), never a silent allow. liveDocsLint is
      // wired above and reused for readFragmentsFromDisk + evaluateLint.
      resolved.readChangedFiles = (root, base) => defaultReadChangedFiles(root, base);
    }
    if (!resolved.readBodyFile) {
      const fs = require('node:fs');
      resolved.readBodyFile = (p) => {
        try {
          return fs.readFileSync(path.resolve(p), 'utf8');
        } catch (_) {
          return null;
        }
      };
    }
    return gate(stdinString, resolved);
  }, ctx);
}

/**
 * Read the current git branch from HEAD. Throws (→ fail closed) if it cannot be read,
 * because a PR gate that cannot determine the head branch cannot enforce ENF-10.
 * @returns {string}
 */
function currentBranch(root) {
  const { execFileSync } = require('node:child_process');
  const opts = { encoding: 'utf8' };
  if (root) opts.cwd = root; // read the branch of the worktree the command targets
  const out = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], opts);
  return out.trim();
}

/**
 * Resolve the head commit SHA from the worktree HEAD via execFile no-shell. Mirrors the
 * currentBranch(root) cwd discipline so a cross-repo session reads the worktree's HEAD,
 * not the session repo's. Throws (→ runGate fail-closed deny, HARD-01) if HEAD cannot be
 * read — a PR gate that cannot determine the head SHA cannot enforce ENF-18.
 *
 * @param {string} [root] absolute worktree root the command targets.
 * @returns {string} the 40-char head commit SHA.
 */
function resolveHeadSha(root) {
  const { execFileSync } = require('node:child_process');
  const opts = { encoding: 'utf8' };
  if (root) opts.cwd = root;
  const out = execFileSync('git', ['rev-parse', 'HEAD'], opts);
  const sha = out.trim();
  if (!/^[0-9a-f]{7,64}$/i.test(sha)) {
    throw new FailClosed(
      'could not resolve a valid head SHA from HEAD (got `' + sha + '`) — failing closed (ENF-18)'
    );
  }
  return sha;
}

/**
 * CHD-03: resolve the REPO the cross-repo `owner:branch` head lives in. gh's `owner:branch`
 * keeps the SAME repo NAME as the base — only the OWNER differs — so the head repo is
 * `{ owner: headOwner, repo: <base repo name> }`. The base repo name comes from the command's
 * EXPLICIT -R/GH_REPO target when present (the WR-01 single source), else the worktree origin.
 * The owner/repo are re-validated against the IN-02 SAFE-character set (they are interpolated
 * into the `gh api repos/<owner>/<repo>/...` path) so an odd value fails CLOSED (deny), never a
 * silent wrong-repo read.
 *
 * @param {string} headOwner the fork owner before the `:` in `owner:branch`.
 * @param {{owner:string,repo:string}|null} targetRepo the explicit -R target, or null.
 * @param {string} [root] worktree root (cwd for the origin read when no explicit target).
 * @returns {{owner:string, repo:string}}
 */
function resolveHeadRepo(headOwner, targetRepo, root) {
  let repoName = targetRepo && targetRepo.repo ? targetRepo.repo : null;
  if (!repoName) {
    const { execFileSync } = require('node:child_process');
    const opts = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };
    if (root) opts.cwd = root;
    let url;
    try {
      url = execFileSync('git', ['remote', 'get-url', 'origin'], opts).trim();
    } catch (err) {
      throw new FailClosed(
        'CHD-03: could not resolve the head repo NAME from the worktree origin for an ' +
          '`owner:branch` --head (' + ((err && err.message) || 'git failure') +
          ') — failing closed (an unresolvable --head denies).'
      );
    }
    const slug = ownerRepoFromRemote(url);
    if (!slug) {
      throw new FailClosed(
        'CHD-03: could not parse the head repo name from the worktree origin remote — failing closed.'
      );
    }
    repoName = slug.repo;
  }
  const SAFE = /^[A-Za-z0-9._-]+$/;
  const owner = String(headOwner).toLowerCase();
  const repo = String(repoName).toLowerCase();
  if (!SAFE.test(owner) || !SAFE.test(repo)) {
    throw new FailClosed(
      'CHD-03: the `owner:branch` head owner/repo (`' + owner + '/' + repo + '`) contains an ' +
        'unsafe character — failing closed (no wrong-repo CI read).'
    );
  }
  return { owner, repo };
}

/**
 * CHD-03: resolve the SHA of a cross-repo `owner:branch` head from the HEAD's repo. The local
 * worktree HEAD is NOT this branch (the user is on a different branch / fork), so the SHA is read
 * remotely via `gh api repos/<owner>/<repo>/commits/<branch>` (the ref form GitHub resolves to a
 * commit). The branch is a FIXED argv element (no shell) so it cannot inject. ANY spawn/parse/auth
 * failure THROWS FailClosed so runGate fails closed (HARD-01) — an unresolvable `--head` DENIES.
 *
 * @param {string} root worktree root (cwd for the `gh` read).
 * @param {{owner:string,repo:string}} headRepo the head's repo.
 * @param {string} headBranch the branch portion of `owner:branch`.
 * @returns {string} the resolved head commit SHA.
 */
function resolveCrossRepoHeadSha(root, headRepo, headBranch) {
  const { execFileSync } = require('node:child_process');
  if (!headRepo || !headRepo.owner || !headRepo.repo) {
    throw new FailClosed('CHD-03: no head repo to resolve the cross-repo head SHA — failing closed.');
  }
  if (typeof headBranch !== 'string' || !headBranch) {
    throw new FailClosed('CHD-03: no head branch to resolve the cross-repo head SHA — failing closed.');
  }
  const opts = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };
  if (root) opts.cwd = root;
  let raw;
  try {
    raw = execFileSync(
      'gh',
      [
        'api',
        '-H', 'Accept: application/vnd.github+json',
        'repos/' + headRepo.owner + '/' + headRepo.repo + '/commits/' + headBranch,
      ],
      opts
    );
  } catch (err) {
    throw new FailClosed(
      'CHD-03: could not resolve the head SHA for cross-repo head `' + headRepo.owner + ':' +
        headBranch + '` via `gh api` (' + ((err && err.message) || 'gh failure / unauthenticated') +
        ') — failing closed (HARD-01: an unresolvable --head denies).'
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new FailClosed(
      'CHD-03: the cross-repo head commit response for `' + headRepo.owner + ':' + headBranch +
        '` was not parseable JSON — failing closed (HARD-01).'
    );
  }
  const sha = parsed && typeof parsed.sha === 'string' ? parsed.sha : null;
  if (!sha || !/^[0-9a-f]{7,64}$/i.test(sha)) {
    throw new FailClosed(
      'CHD-03: the cross-repo head commit for `' + headRepo.owner + ':' + headBranch +
        '` had no valid sha — failing closed (HARD-01).'
    );
  }
  return sha;
}

/**
 * Default ENF-18 reader of the AUTHORITATIVE CI result for the head SHA.
 *
 * Reads the REAL check-runs via `gh api repos/<owner>/<repo>/commits/<sha>/check-runs`
 * (NOT the evaluate-mode branch-protection ruleset rollup, which can show green while
 * Tests are red — #1532). The owner/repo are derived from the resolved worktree's
 * `origin` remote so the SHA + repo are fixed array args to execFile (no shell, no
 * injection — T-07-03-INJECT). ANY spawn/parse/auth error THROWS so runGate fails closed
 * (HARD-01); an unauthenticated `gh` denies, never allows.
 *
 * Normalizes to `{ headSha, testsRan, allRequiredGreen, conclusions }`:
 *   - testsRan: at least one check-run whose name matches /tests?/i exists for THIS sha.
 *   - allRequiredGreen: every check-run for this sha concluded exactly `success`
 *     (no failure/neutral/skipped/in_progress/null), AND the Tests check-run(s) are green.
 *
 * @param {string} root absolute worktree root (for owner/repo + cwd).
 * @param {string} headSha the resolved head commit SHA.
 * @returns {{headSha:string, testsRan:boolean, allRequiredGreen:boolean, conclusions:Array}}
 */
function defaultReadCheckRuns(root, headSha, targetRepo) {
  const { execFileSync } = require('node:child_process');
  if (typeof headSha !== 'string' || !headSha) {
    throw new FailClosed('ENF-18: no head SHA to read check-runs for — failing closed');
  }
  const opts = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };
  if (root) opts.cwd = root;

  // Resolve owner/repo. WR-01: when the command carries an EXPLICIT -R/GH_REPO target, read the
  // check-runs from THAT repo (the repo the command targets), not the worktree origin — so an
  // upstream red commit cannot hide behind a fork origin. The target's owner/repo were already
  // SAFE-char-validated by parseOwnerRepo (case-folded). Otherwise derive owner/repo from the
  // worktree's origin remote (array arg → no shell — unchanged).
  let slug;
  if (targetRepo && targetRepo.owner && targetRepo.repo) {
    slug = { owner: targetRepo.owner, repo: targetRepo.repo };
  } else {
    try {
      const url = execFileSync('git', ['remote', 'get-url', 'origin'], opts).trim();
      slug = ownerRepoFromRemote(url);
    } catch (err) {
      throw new FailClosed(
        'ENF-18: could not resolve owner/repo from the worktree origin remote (' +
          ((err && err.message) || 'git failure') + ') — failing closed (HARD-01)'
      );
    }
    if (!slug) {
      throw new FailClosed('ENF-18: could not parse owner/repo from origin remote — failing closed');
    }
  }

  // Read the AUTHORITATIVE check-runs for THIS sha. gh exits nonzero on unauth / API
  // failure → execFileSync throws → fail closed (an unauth gh DENIES, never allows).
  let raw;
  try {
    raw = execFileSync(
      'gh',
      [
        'api',
        '-H', 'Accept: application/vnd.github+json',
        'repos/' + slug.owner + '/' + slug.repo + '/commits/' + headSha + '/check-runs',
      ],
      opts
    );
  } catch (err) {
    throw new FailClosed(
      'ENF-18: could not read the LIVE check-runs for ' + headSha +
        ' via `gh api` (' + ((err && err.message) || 'gh failure / unauthenticated') +
        ') — failing closed (HARD-01). An unauthenticated gh never allows a PR.'
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new FailClosed(
      'ENF-18: check-runs response for ' + headSha + ' was not parseable JSON — failing closed (HARD-01)'
    );
  }

  const runs = Array.isArray(parsed && parsed.check_runs) ? parsed.check_runs : null;
  if (!runs) {
    throw new FailClosed(
      'ENF-18: check-runs response for ' + headSha + ' had no check_runs array — failing closed (HARD-01)'
    );
  }

  return normalizeCheckRuns(headSha, runs);
}

/**
 * Normalize a raw GitHub `check_runs` array into the ENF-18 decision shape.
 * @param {string} headSha
 * @param {Array<{name?:string, status?:string, conclusion?:string}>} runs
 * @returns {{headSha:string, testsRan:boolean, allRequiredGreen:boolean, conclusions:Array}}
 */
function normalizeCheckRuns(headSha, runs) {
  const conclusions = runs.map((r) => ({
    name: (r && r.name) || '',
    status: (r && r.status) || '',
    conclusion: r && r.conclusion != null ? r.conclusion : null,
  }));
  const testRuns = conclusions.filter((c) => TESTS_CHECK_RE.test(c.name));
  // testsRan: a Tests check-run exists AND it actually completed on THIS sha (status
  // 'completed' — not queued/in_progress). A changeset-only commit that skipped Tests
  // yields zero test runs → testsRan false → deny (#1532).
  const testsRan =
    testRuns.length > 0 && testRuns.every((c) => c.status === 'completed');
  // allRequiredGreen: every check-run for this sha concluded exactly success.
  const allRequiredGreen =
    conclusions.length > 0 && conclusions.every((c) => c.conclusion === GREEN_CONCLUSION);
  return { headSha, testsRan, allRequiredGreen, conclusions };
}

/**
 * CF-02 default reader of a linked issue's LABEL NAMES via `gh api
 * repos/<owner>/<repo>/issues/<number>` (mirrors defaultReadCheckRuns). The `number` is
 * validated as a POSITIVE INTEGER before use (T-30-02-02: a crafted number cannot be
 * interpolated into the path), and owner/repo are resolved from the command's EXPLICIT
 * -R/GH_REPO target (WR-01 single source) when present, else the worktree origin remote
 * (SAFE-char-validated, case-folded via ownerRepoFromRemote). The path components are FIXED
 * array args to execFile (no shell). ANY spawn/parse/auth failure THROWS FailClosed so an
 * unauthenticated `gh` DENIES an enh/feat PR (never a silent allow — D-04 fail-closed).
 *
 * @param {string} root absolute worktree root (for owner/repo resolution + cwd).
 * @param {number} number the linked issue number.
 * @param {{owner:string,repo:string}} [targetRepo] the explicit -R/GH_REPO target, or null.
 * @returns {string[]} the issue's label names.
 */
function defaultReadIssueLabels(root, number, targetRepo) {
  const { execFileSync } = require('node:child_process');
  if (typeof number !== 'number' || !Number.isInteger(number) || number <= 0) {
    throw new FailClosed(
      'CF-02: a linked issue number to read labels for must be a positive integer (got `' +
        String(number) + '`) — failing closed (no path injection).'
    );
  }
  const opts = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };
  if (root) opts.cwd = root;

  // Resolve owner/repo. WR-01: prefer the command's explicit target (already SAFE-char-validated
  // + case-folded by parseOwnerRepo); else derive from the worktree origin remote.
  let slug;
  if (targetRepo && targetRepo.owner && targetRepo.repo) {
    slug = { owner: targetRepo.owner, repo: targetRepo.repo };
  } else {
    try {
      const url = execFileSync('git', ['remote', 'get-url', 'origin'], opts).trim();
      slug = ownerRepoFromRemote(url);
    } catch (err) {
      throw new FailClosed(
        'CF-02: could not resolve owner/repo from the worktree origin remote (' +
          ((err && err.message) || 'git failure') + ') — failing closed (an unreadable label ' +
          'source denies an enh/feat PR).'
      );
    }
    if (!slug) {
      throw new FailClosed('CF-02: could not parse owner/repo from origin remote — failing closed.');
    }
  }

  let raw;
  try {
    raw = execFileSync(
      'gh',
      [
        'api',
        '-H', 'Accept: application/vnd.github+json',
        'repos/' + slug.owner + '/' + slug.repo + '/issues/' + number,
      ],
      opts
    );
  } catch (err) {
    throw new FailClosed(
      'CF-02: could not read labels for issue #' + number + ' via `gh api` (' +
        ((err && err.message) || 'gh failure / unauthenticated') +
        ') — failing closed (an unauthenticated gh never approves an enh/feat PR).'
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new FailClosed(
      'CF-02: the issue #' + number + ' response was not parseable JSON — failing closed.'
    );
  }
  const labels = Array.isArray(parsed && parsed.labels) ? parsed.labels : [];
  return labels
    .map((l) => (typeof l === 'string' ? l : l && l.name))
    .filter((n) => typeof n === 'string');
}

/**
 * CF-03 default reader of the PR's changed files — `git diff --name-only origin/<base>...HEAD`
 * via execFileSync (array args, no shell, cwd = the resolved worktree root), mirroring the LIVE
 * lint-docs-required CLI's own diff form. The `base` is a FIXED argv element (interpolated only
 * into the ref-spec `origin/<base>...HEAD`, which git's own ref-name validator rejects if it
 * carries metacharacters — no shell to inject into). Splits on newlines and drops empties. An
 * absent/empty base cannot form a diff spec → THROW before any spawn. ANY spawn failure (not a
 * git repo, missing origin/<base>) THROWS FailClosed so runGate fails closed (HARD-01): an
 * unreadable diff cannot confirm docs-required, so it DENIES (fetch origin/<base> first).
 *
 * @param {string} root absolute worktree root (cwd for the `git diff`).
 * @param {string} base the PR base branch name.
 * @returns {string[]} the changed file paths (possibly empty).
 */
function defaultReadChangedFiles(root, base) {
  const { execFileSync } = require('node:child_process');
  if (typeof base !== 'string' || !base) {
    throw new FailClosed(
      'CF-03: no base branch to compute the PR diff against — failing closed (cannot confirm ' +
        'docs-required without the diff).'
    );
  }
  const opts = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };
  if (root) opts.cwd = root;
  let raw;
  try {
    raw = execFileSync('git', ['diff', '--name-only', 'origin/' + base + '...HEAD'], opts);
  } catch (err) {
    throw new FailClosed(
      'CF-03: could not compute the PR diff `git diff --name-only origin/' + base + '...HEAD` (' +
        ((err && err.message) || 'git failure') + ') — failing closed (fetch origin/' + base +
        ' first; an unreadable diff cannot confirm the docs-required lint).'
    );
  }
  return raw.split('\n').filter(Boolean);
}

/**
 * ROB-02 default first-create detector: list the OPEN PRs for the head branch.
 *
 * Reads `gh pr list --head <branch> --json number --state open` via execFileSync (no shell,
 * array args, cwd = the resolved worktree root) so the branch is a fixed argv element — never
 * interpolated into a shell string (T-25-02-04 injection). Returns the parsed JSON array (empty
 * → no open PR → first create). ANY spawn/parse/auth/shape failure THROWS FailClosed so runGate
 * fails closed (HARD-01) — an unauthenticated `gh` DENIES, it never relaxes the CI-green gate.
 *
 * @param {string} root absolute worktree root (cwd for the `gh` read).
 * @param {string} branch the head branch name.
 * @param {{owner:string,repo:string}} [targetRepo] WR-01: when present, list the OPEN PRs from
 *   this explicitly-targeted repo (via `-R owner/repo`) instead of the worktree origin — so an
 *   upstream open PR cannot hide behind a fork origin and masquerade as a first create.
 * @returns {Array} the open PRs for the head branch (possibly empty).
 */
function defaultListPrsForHead(root, branch, targetRepo) {
  const { execFileSync } = require('node:child_process');
  if (typeof branch !== 'string' || !branch) {
    throw new FailClosed('ROB-02: no head branch to list open PRs for — failing closed (HARD-01)');
  }
  const opts = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };
  if (root) opts.cwd = root;

  // gh exits nonzero on unauth / API failure → execFileSync throws → fail closed. The branch
  // (and the WR-01 `-R owner/repo`) are fixed array elements (no shell), so a crafted branch
  // name cannot inject (T-25-02-04). The target's owner/repo were SAFE-char-validated upstream.
  const args = ['pr', 'list', '--head', branch, '--json', 'number', '--state', 'open'];
  if (targetRepo && targetRepo.owner && targetRepo.repo) {
    args.push('-R', targetRepo.owner + '/' + targetRepo.repo);
  }
  let raw;
  try {
    raw = execFileSync('gh', args, opts);
  } catch (err) {
    throw new FailClosed(
      'ROB-02: could not read the open PRs for head branch `' + branch + '` via `gh pr list` (' +
        ((err && err.message) || 'gh failure / unauthenticated') +
        ') — failing closed (HARD-01). An unauthenticated gh never relaxes the CI-green gate.'
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new FailClosed(
      'ROB-02: the `gh pr list` response for head branch `' + branch +
        '` was not parseable JSON — failing closed (HARD-01)'
    );
  }
  if (!Array.isArray(parsed)) {
    throw new FailClosed(
      'ROB-02: `gh pr list --json number` did not return an array for head branch `' + branch +
        '` — failing closed (HARD-01)'
    );
  }
  return parsed;
}

/**
 * Parse owner/repo from a git remote URL (https or ssh form). Routes the parse through the
 * unified parseOwnerRepo normalizer (CHD-01 / WR-03 — case-fold + port-strip + `.git`/scheme/
 * user normalization), then RE-APPLIES the IN-02 SAFE-character validation so the existing
 * security fail-closed is preserved verbatim. Returns {owner,repo} (LOWER-cased — parseOwnerRepo
 * normalizes case; GitHub routes owner/repo case-insensitively so the `gh api
 * repos/<owner>/<repo>/...` path is unaffected) or null. Keeps the {owner,repo}|null shape the
 * defaultReadCheckRuns consumer depends on (Hyrum preserved).
 * @param {string} url
 * @returns {{owner:string, repo:string}|null}
 */
function ownerRepoFromRemote(url) {
  const r = parseOwnerRepo(url);
  if (!r) return null;
  // IN-02: owner/repo are interpolated into the `gh api repos/<owner>/<repo>/...` path. The call
  // uses execFileSync with an array arg (no shell) today, so this is hardening — validate both
  // against a conservative safe-character set so a future shell-based refactor cannot become
  // injectable, and an odd remote fails CLOSED (return null → caller throws FailClosed → deny).
  const SAFE = /^[A-Za-z0-9._-]+$/;
  if (!SAFE.test(r.owner) || !SAFE.test(r.repo)) return null;
  return { owner: r.owner, repo: r.repo };
}

/**
 * WR-01: resolve the command's EXPLICIT owner/repo target from the parsed argv — `gh`'s native
 * `--repo`/`-R` flag or a leading `GH_REPO=<spec>` env-assignment token — via the unified
 * parseOwnerRepo normalizer. This is the SAME extraction shape commandTargetsGsdCore uses for the
 * gate's targeting decision, so the repo the ENF-18 readers read FROM cannot diverge from the repo
 * the gate classifies (the seed's single-source anti-divergence requirement — confirmed in ONE
 * place).
 *
 * Three outcomes (mirroring CHD-01's three-way):
 *   - no explicit -R/--repo/GH_REPO present → null (the readers fall back to the worktree origin,
 *     unchanged — preserves every existing ENF-18 / ROB-02 test).
 *   - an explicit target that parseOwnerRepo resolves → {owner, repo} (case-folded; the readers
 *     read THAT repo).
 *   - an explicit target present but un-enumerable by parseOwnerRepo → THROW FailClosed (deny);
 *     a GitHub-ish-but-unparseable explicit target is a containment bypass, never a silent
 *     origin-fallback ALLOW.
 *
 * The GH_REPO env token is read from the LEADING `NAME=VALUE` run of seg.tokens (stopping at the
 * program) exactly like commandTargetsGsdCore — so a post-program `-f title=x` field is never
 * mistaken for an env assignment (HARD-04).
 *
 * @param {{ok?:boolean, segments?:Array}} parsed result of parseCommand(command)
 * @returns {{owner:string, repo:string}|null}
 */
function resolveExplicitTarget(parsed) {
  if (!parsed || parsed.ok !== true || !Array.isArray(parsed.segments)) return null;
  let spec = null;
  for (const seg of parsed.segments) {
    if (!seg) continue;
    const flags = seg.flags || {};
    const shortFlags = seg.shortFlags || {};
    if (typeof flags.repo === 'string') { spec = flags.repo; break; }
    if (typeof shortFlags.R === 'string') { spec = shortFlags.R; break; }
    const tokens = Array.isArray(seg.tokens) ? seg.tokens : [];
    for (const tok of tokens) {
      if (typeof tok !== 'string') break;
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(tok);
      if (!m) break; // first non-assignment token = the program → stop scanning
      if (m[1] === 'GH_REPO') { spec = m[2]; break; }
    }
    if (spec != null) break;
  }
  if (spec == null) return null; // no explicit target → origin fallback (unchanged)
  const r = parseOwnerRepo(spec);
  if (!r) {
    throw new FailClosed(
      'WR-01: an explicit -R/--repo/GH_REPO target (`' + spec + '`) was given but could not be ' +
        'resolved to an owner/repo by the enumerated forms — failing closed (no silent ' +
        'origin-fallback ALLOW; a GitHub-ish-but-unparseable explicit target is a containment bypass).'
    );
  }
  return { owner: r.owner, repo: r.repo };
}


function main() {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => {
    buf += c;
  });
  process.stdin.on('end', () => {
    emit(runPrGate(buf));
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  runPrGate,
  gate,
  resolveBody,
  resolveBase,
  resolveTitle,
  resolveHead,
  splitHead,
  resolveHeadRepo,
  extractLinkedIssues,
  normalizeBody,
  evaluateCiResult,
  resolveHeadSha,
  normalizeCheckRuns,
  defaultReadIssueLabels,
  defaultReadChangedFiles,
  ownerRepoFromRemote,
  resolveExplicitTarget,
  LINKED_ISSUE_RE,
  BRANCH_NAME_RE,
};
