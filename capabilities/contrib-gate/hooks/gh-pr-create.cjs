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
const { classifyAction, findActionSegment } = require('./lib/classify.cjs');
const { runGate, readHookInput, deny, allow, emit, FailClosed, safeCommand } = require('./lib/failclosed.cjs');
const { resolveRootForCommand, requireLiveScript } = require('./lib/resolve.cjs');

// FailClosed/safeCommand: shared IN-03 helpers from failclosed.cjs.

// Toolkit-OWNED policies (replicated from gsd-core CI workflows — H-A). Documented as
// ours; the deny reasons name them as the toolkit's own.
const LINKED_ISSUE_RE = /\b(?:Fixes|Closes|Resolves)\s+#\d+\b/i;
const BRANCH_NAME_RE = /^(fix|docs|feat)\/\d+-/;

const OWNED_NOTE =
  'This is the toolkit’s own check — a gsd-core CI-workflow policy ' +
  '(require-issue-link / branch-naming) replicated locally, not a callable repo script (ENF-10/H-A).';

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
 * The pure PR gate decision with all impure deps injected.
 *
 * @param {string} stdinString raw PreToolUse JSON
 * @param {Object} deps
 * @param {{evaluatePrTemplate:Function}} deps.liveTemplate LIVE pr-template-policy export
 * @param {{classifyPrTarget:Function}} deps.liveTarget LIVE pr-target-policy export
 * @param {string} deps.branch current head branch name
 * @param {string[]} [deps.changedFiles] changed files (for the template tooling carve-out)
 * @param {string} [deps.authorAssociation] e.g. 'OWNER'
 * @param {(p:string)=>(string|null)} deps.readBodyFile
 * @param {(headSha:string)=>{headSha:string,testsRan:boolean,allRequiredGreen:boolean,conclusions:Array}} deps.readCheckRuns
 *   ENF-18 injectable read of the head SHA's AUTHORITATIVE check-runs (throws → fail-closed)
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
  const head = deps.branch;

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

  // (5) ENF-18 Tier-2 — TOOLKIT-OWNED read of the AUTHORITATIVE CI result for the head
  // SHA. The four checks above gate FIRST and unchanged; this is an ADDITIONAL condition
  // on the pr-create path. We resolve the head SHA from the SAME worktree root the gate
  // already used (deps.root / deps.worktreeRoot), then read its check-runs. A throw from
  // resolveHeadSha or readCheckRuns (gh unauth, spawn fail, unparseable JSON, missing
  // SHA) propagates to runGate → fail-closed deny (HARD-01). readCheckRuns reads the REAL
  // check-runs (commits/<sha>/check-runs), NOT the evaluate-mode ruleset rollup.
  const headSha =
    typeof deps.headSha === 'string' && deps.headSha
      ? deps.headSha
      : resolveHeadSha(deps.root || deps.worktreeRoot);
  const checkRuns = deps.readCheckRuns(headSha); // may throw → fail-closed deny
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
    const resolved = Object.assign({}, deps);
    // Resolve the root from the command's OWN cwd (it may `cd` into a worktree), not the
    // session cwd. null = the command does not target a gsd-core checkout → allow. The
    // head branch is read from that same root so a cross-repo session reads the worktree's
    // branch, not the session repo's.
    let root = resolved.worktreeRoot || null;
    if (!root && (!resolved.liveTemplate || !resolved.liveTarget || !resolved.branch)) {
      root = resolveRootForCommand(ctx.command, process.cwd());
      if (!root) return allow();
    }
    ctx.worktreeRoot = ctx.worktreeRoot || root;
    if (!resolved.liveTemplate) {
      resolved.liveTemplate = requireLiveScript(root, 'scripts/pr-template-policy.cjs');
    }
    if (!resolved.liveTarget) {
      resolved.liveTarget = requireLiveScript(root, 'scripts/pr-target-policy.cjs');
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
      resolved.readCheckRuns = (headSha) => defaultReadCheckRuns(resolved.root, headSha);
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
function defaultReadCheckRuns(root, headSha) {
  const { execFileSync } = require('node:child_process');
  if (typeof headSha !== 'string' || !headSha) {
    throw new FailClosed('ENF-18: no head SHA to read check-runs for — failing closed');
  }
  const opts = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };
  if (root) opts.cwd = root;

  // Derive owner/repo from the worktree's origin remote (array arg → no shell).
  let slug;
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
 * Parse owner/repo from a git remote URL (https or ssh form). Returns {owner,repo} or
 * null. Strips a trailing `.git`.
 * @param {string} url
 * @returns {{owner:string, repo:string}|null}
 */
function ownerRepoFromRemote(url) {
  if (typeof url !== 'string' || !url) return null;
  let s = url.trim();
  // ssh: git@github.com:owner/repo(.git)
  const sshMatch = /^[^@]+@[^:]+:(.+)$/.exec(s);
  if (sshMatch) {
    s = sshMatch[1];
  } else {
    // https://github.com/owner/repo(.git) — strip scheme + host.
    const schemeIdx = s.indexOf('://');
    if (schemeIdx !== -1) {
      const after = s.slice(schemeIdx + 3);
      const slash = after.indexOf('/');
      s = slash === -1 ? '' : after.slice(slash + 1);
    }
  }
  s = s.replace(/\.git$/i, '');
  const parts = s.split('/').filter((p) => p.length > 0);
  if (parts.length < 2) return null;
  const owner = parts[parts.length - 2];
  const repo = parts[parts.length - 1];
  // IN-02: owner/repo are interpolated into the `gh api repos/<owner>/<repo>/...` path. The call
  // uses execFileSync with an array arg (no shell) today, so this is hardening — validate both
  // against a conservative safe-character set so a future shell-based refactor cannot become
  // injectable, and an odd remote fails CLOSED (return null → caller throws FailClosed → deny).
  const SAFE = /^[A-Za-z0-9._-]+$/;
  if (!SAFE.test(owner) || !SAFE.test(repo)) return null;
  return { owner, repo };
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
  normalizeBody,
  evaluateCiResult,
  resolveHeadSha,
  normalizeCheckRuns,
  ownerRepoFromRemote,
  LINKED_ISSUE_RE,
  BRANCH_NAME_RE,
};
