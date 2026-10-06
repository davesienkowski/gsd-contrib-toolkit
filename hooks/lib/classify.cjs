'use strict';

/**
 * hooks/lib/classify.cjs — gh/git action classifier with synonym-route coverage
 * (ENF-15 / edge-probe EP-1).
 *
 * The threat: a gate that only matches `gh issue create` is theatre, because the
 * SAME mutation reaches GitHub via `gh api -X POST repos/.../issues` or `curl` to
 * api.github.com. A synonym route that maps to action:'other' silently bypasses
 * every gate. So this classifier recognizes the native verbs AND their REST
 * equivalents, returning the SAME action with a `route` tag — and, critically,
 * returns `failClosed:true` for any mutating (POST/PATCH/PUT) call to a github
 * issues|pulls endpoint that it CANNOT confidently map to a specific create/edit.
 *
 * It consumes the STRUCTURED parse from argv.cjs (it never re-tokenizes the raw
 * string — that would re-introduce the EP-2 parse-bypass). A parse that already
 * failed closed ({ok:false}) propagates straight to failClosed.
 *
 * Read-only / unrelated commands (`gh repo view`, `git status`, GET requests,
 * non-github hosts) return action:'other' WITHOUT failClosed, so gates do not
 * over-block — a false-positive deny erodes trust and gets the toolkit disabled
 * (red-team H-B).
 *
 * ENF-20 extends the vocabulary from the six AUTHORING actions to the five
 * ADJUDICATING ones — pr-review, pr-merge, issue-close, issue-comment, pr-comment —
 * closing the enforcement inversion where the side with more authority (approving,
 * dismissing, closing, merging: outward-facing and effectively irreversible) carried
 * no classification at all and so no gate could reach it. Same ENF-15 rigour applies:
 * native verb AND REST synonym, or the gate is theatre. Two invariants govern that
 * extension and are asserted in the tests:
 *   (a) the six legacy actions classify byte-identically — enforced structurally by
 *       classifyAction's two-pass aggregation, not by test luck;
 *   (b) no existing gate starts firing on a new action — every gate keys on an explicit
 *       action-name set, and the two vocabularies are disjoint.
 *
 * ENF-22 (260731-ih5) adds ONE more verb on the same terms: `git merge`, whose OUTCOME is
 * a commit even though the verb is not `git commit` — the general lesson recorded in
 * SEED-enf16-misses-git-merge-implicit-commit ("a gate keyed to a command name covers that
 * verb, not the outcome"). It lives in its OWN vocabulary tier and required a THIRD
 * aggregation pass; see classifyAction for why folding it into either existing set would
 * have disarmed a wired gate.
 *
 * Pure: no I/O, no process.env.
 *
 * @module hooks/lib/classify
 */

const path = require('node:path'); // CR-03: basename-normalize the program
// Contract dependency (parseCommand output shape). 261006-jsm: parseCommand also re-parses an
// eval or shell -c payload in the verdict-route recovery (argv's own primitive, never a raw grep).
const { parseCommand, classifyTokens } = require('./argv.cjs');

const MUTATING_METHODS = new Set(['POST', 'PATCH', 'PUT']);
const GITHUB_API_HOSTS = new Set(['api.github.com']);

// ---------------------------------------------------------------------------
// ENF-20: the ACTION VOCABULARY, split into the two generations.
//
// LEGACY_MUTATION_ACTIONS are the six AUTHORING actions this classifier has always
// recognized. REVIEW_SIDE_ACTIONS are the five ADJUDICATING actions ENF-20 adds —
// approving, merging, closing, commenting: outward-facing, effectively irreversible,
// and until now every one of them classified as action:'other' (a silent allow at
// every gate wired before this extension).
//
// The split is not documentation — it is LOAD-BEARING in classifyAction's two-pass
// aggregation (see there). Keeping the sets disjoint is what makes the six legacy
// actions' classification provably byte-identical after this extension.
// ---------------------------------------------------------------------------
const LEGACY_MUTATION_ACTIONS = Object.freeze(new Set([
  'commit', 'push', 'issue-create', 'issue-edit', 'pr-create', 'pr-edit',
]));

const REVIEW_SIDE_ACTIONS = Object.freeze(new Set([
  'pr-review', 'pr-merge', 'issue-close', 'issue-comment', 'pr-comment',
]));

// ENF-22 (quick task 260731-ih5, origin SEED-enf16-misses-git-merge-implicit-commit):
// the LOCAL-MERGE action — a git verb whose OUTCOME is a commit even though the verb is
// not `git commit`. A cleanly-mergeable `git merge <ref>` commits ITSELF, so ENF-16 was
// never consulted and git's generated subject reached a gsd-core PR branch live on
// 2026-07-31. Adding the verb here is what makes the outcome gateable at all: a segment
// classified `other` is unreachable by every gate.
//
// It is its OWN tier, deliberately not folded into either set above:
//   - not LEGACY: a legacy membership would let a merge win PASS 1 and displace a real
//     `commit`/`push` in a chain, changing six wired gates' existing classifications;
//   - not REVIEW-SIDE: a review-side membership would let `git merge x && gh pr merge 1`
//     collapse to `merge` and disarm ENF-20's review-artifact gate (T-ih5-01).
// See classifyAction's FOUR-PASS aggregation for why the separate tier is load-bearing.
const MERGE_SIDE_ACTIONS = Object.freeze(new Set(['merge']));

// ENF-20 disambiguation contract. GitHub posts a PR *conversation* comment to the
// ISSUES endpoint (POST /repos/{o}/{r}/issues/{n}/comments) — the pulls endpoint is
// only for inline REVIEW comments — and issue/PR numbers share ONE namespace. So
// `/issues/42/comments` cannot be resolved to "issue 42" vs "PR 42" without a network
// lookup, and this module is PURE by contract. The classifier therefore reports what
// the command NAMES (pulls → pr-comment, issues → issue-comment) and hands the
// ambiguity to the gate as this explicit pair: a gate governing PR comments MUST
// govern BOTH names, or `gh api POST /issues/<pr#>/comments` is a one-line bypass.
const PR_COMMENT_EQUIVALENT_ACTIONS = Object.freeze(['pr-comment', 'issue-comment']);

// CR-03: wrapper builtins that PRECEDE the real program (`command git …`,
// `env git …`, `sudo git …`). We advance past the wrapper (and any wrapper flags)
// to the wrapped program. Toolkit-OWNED rule (no LIVE shared classifier exists to
// delegate to; repoint per #1549 if gsd-core extracts one).
// CF-08: extended with timeout/stdbuf/ionice — all common value-flag-carrying
// wrappers that would otherwise disguise a wrapped git/gh (CF-REVIEW CR-02).
const WRAPPER_BUILTINS = new Set([
  'command', 'env', 'exec', 'sudo', 'nice', 'timeout', 'stdbuf', 'ionice',
]);

// CF-08 (← CR-02): per-wrapper allow-list of value-taking flags — those that consume
// the FOLLOWING token as their value. The CF-04 wrapper loop skipped any '-'-prefixed
// token but never its value token, so a value flag resolved the wrapped program to the
// flag's VALUE (`sudo -u user git` → 'user', `nice -n 10 git` → '10', `env -u VAR git`
// → 'VAR'), letting wrapped git/gh slip ENF-06/07 containment + ENF-15 classification.
// Keyed by wrapper name so `sudo -n` (boolean) and `nice -n <N>` (value) stay distinct.
// D-06 primary fix; D-07 fail-closed fallback covers any value flag NOT enumerated here
// (an unrecognized flag is skipped as boolean, and if that leaves no program the caller
// fails closed on the `ambiguous` signal). Attached forms (`--unset=VAR`, `-uuser`)
// carry their own value and need no separate-token skip. Toolkit-OWNED (CR-02).
const WRAPPER_VALUE_FLAGS = Object.freeze({
  sudo: new Set(['-u', '-g', '-U', '-C', '-h', '-p', '-r', '-t']),
  nice: new Set(['-n', '--adjustment']),
  env: new Set(['-u', '--unset', '-C', '-S']),
  stdbuf: new Set(['-i', '-o', '-e']),
  ionice: new Set(['-c', '-n']),
  timeout: new Set(['-s', '--signal', '-k', '--kill-after']),
});

// CR-01: git GLOBAL options that take a VALUE (the following token). When skipping
// the global-option run to find the verb, these consume one extra token. Boolean
// globals (--no-pager, --paginate, -p, --bare, …) consume no value. Short value
// options: -C <path>, -c <kv>. The verb is the first non-flag token NOT consumed as
// one of these values. Toolkit-OWNED (CR-01).
const GIT_GLOBAL_VALUE_LONG = new Set(['git-dir', 'work-tree', 'namespace', 'super-prefix']);
const GIT_GLOBAL_VALUE_SHORT = new Set(['C', 'c']);

/**
 * CR-01/CR-03: resolve the effective program (basename, past wrapper builtins) and
 * the ordered NON-FLAG argument tokens (verb candidates) for a segment, reading ONLY
 * the structured token list from argv (never re-tokenizing the raw string — that
 * would re-introduce the EP-2 bypass).
 *
 * For git, value-taking global options (`-C <path>`, `-c <kv>`, `--git-dir <d>`, …)
 * have their value token skipped so it is not mistaken for the verb. For a wrapper
 * builtin (`command`/`env`/`sudo`/…) the wrapped program is read from the first
 * non-flag token after the wrapper and basenamed.
 *
 * CF-08 (← CR-02): a value-taking WRAPPER flag (`sudo -u user`, `nice -n 10`, `env -u
 * VAR`) consumes BOTH the flag AND its separate value token per WRAPPER_VALUE_FLAGS, so
 * the wrapped program is no longer mis-resolved to the flag's value. When a value flag
 * consumes the token stream such that NO wrapped program remains (`env -S '<packed
 * command>'`, `sudo -u` at end), the result carries `ambiguous:true` so callers fail
 * closed (D-07) rather than trust a leftover value token as the program.
 *
 * @param {Object} seg structured segment from argv.parseCommand
 * @returns {{prog:string, args:string[], wrapped:boolean, ambiguous:boolean}}
 */
function resolveProgram(seg) {
  const tokens = Array.isArray(seg.tokens) ? seg.tokens : [];

  // Find the program index = first token that is not a leading env-assignment.
  // (argv already strips env assignments from seg.program, but seg.tokens is the
  // full argv; walk it so wrapper/global handling sees the real argv order.)
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i += 1;

  let prog = path.basename(tokens[i] || '');
  let wrapped = false;
  let ambiguous = false;

  // Advance past wrapper builtins (and their flags) to the wrapped program.
  // Guard against runaway loops with a small bound.
  let guard = 0;
  while (WRAPPER_BUILTINS.has(prog) && guard < 8) {
    wrapped = true;
    guard += 1;
    const wrapperName = prog; // the wrapper we are advancing past this iteration
    const valueFlags = WRAPPER_VALUE_FLAGS[wrapperName] || null;
    i += 1;
    // Skip wrapper flags. CF-08: a value-taking wrapper flag given as a SEPARATE token
    // consumes BOTH the flag AND its value; the CF-04 boolean-only skip left the value
    // as the next non-flag token, so the program resolved to it (CR-02). Attached forms
    // (`--unset=VAR`, `-uuser`) carry their own value and are skipped as a single token.
    let sawValueFlag = false;
    while (i < tokens.length && tokens[i].startsWith('-') && tokens[i] !== '-') {
      const flag = tokens[i];
      const attachedLong = flag.startsWith('--') && flag.includes('=');
      i += 1;
      if (!attachedLong && valueFlags && valueFlags.has(flag)) {
        // Value-taking wrapper flag as a SEPARATE token → also consume its value token.
        if (i >= tokens.length) {
          // The flag has no value token at all (`sudo -u` at end) → no program → fail
          // closed (D-07).
          ambiguous = true;
          break;
        }
        i += 1; // consume the value token
        sawValueFlag = true;
      }
    }
    // `timeout` takes a leading positional DURATION (`timeout 10 git push`) before the
    // wrapped command; consume it so the duration is not read as the program (CF-08).
    if (wrapperName === 'timeout' && i < tokens.length &&
        !tokens[i].startsWith('-') && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) {
      i += 1;
    }
    // Skip env-assignment tokens that FOLLOW the wrapper (e.g. `env FOO=bar git …`,
    // `sudo BAR=1 git …`). The leading-assignment skip above only covers the
    // no-wrapper `VAR=val cmd` form; without this a wrapped-with-assignment command
    // would resolve to the `VAR=val` token as its program and evade classification
    // (CF-04). The wrapped program is the first non-assignment, non-flag token.
    while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i += 1;
    prog = path.basename(tokens[i] || '');
    // D-07: a value-taking wrapper flag consumed the stream such that NO program token
    // remains — cannot confidently resolve → fail closed. A BARE wrapper with no program
    // and no value flag (`env` used to print the environment) is NOT ambiguous: it stays
    // a non-git no-op (narrows-not-weakens — do not over-block).
    if (prog === '' && sawValueFlag) ambiguous = true;
    if (ambiguous) break;
  }

  // Collect the ordered non-flag argument tokens AFTER the (wrapped) program,
  // skipping git global-option values so the verb is not shadowed.
  const args = [];
  const isGit = prog === 'git';
  const nextIsFlag = (k) => {
    const n = tokens[k];
    return n !== undefined && n.startsWith('-') && n.length > 1 && n !== '-';
  };
  for (let j = i + 1; j < tokens.length; j += 1) {
    const tok = tokens[j];
    if (tok.startsWith('--') && tok.length > 2) {
      const body = tok.slice(2);
      const eq = body.indexOf('=');
      const name = eq === -1 ? body : body.slice(0, eq);
      if (eq === -1) {
        // For git, ONLY the known value-taking globals consume the next token —
        // boolean globals (--no-pager, --paginate, --bare, …) must NOT eat the verb.
        // For gh (and other programs), a long flag without `=` consumes the next
        // non-flag token as its value (e.g. `gh --repo o/r pr create`), mirroring
        // argv's own long-flag value rule so the verb is not shadowed.
        if (isGit) {
          if (GIT_GLOBAL_VALUE_LONG.has(name) && !nextIsFlag(j + 1)) j += 1;
        } else if (!nextIsFlag(j + 1)) {
          j += 1;
        }
      }
      continue;
    }
    if (tok.startsWith('-') && tok.length > 1 && tok !== '-') {
      const body = tok.slice(1);
      // short option; consume a value for git -C/-c when given as a SEPARATE token
      // (`-C /path`) — for the attached form (`-cuser.name=x`) there is no separate
      // value token to skip.
      if (isGit && body.length === 1 && GIT_GLOBAL_VALUE_SHORT.has(body) && !nextIsFlag(j + 1)) {
        j += 1; // consume the value token
      }
      continue;
    }
    args.push(tok);
  }

  return { prog, args, wrapped, ambiguous };
}

const FAIL_CLOSED = Object.freeze({ action: 'unknown', failClosed: true });
const OTHER = Object.freeze({ action: 'other' });

/**
 * Extract the HTTP method for a gh-api / curl segment from its parsed flags.
 * Recognizes `-X`/`--method` (long flag) and bundled `-XPOST` short forms.
 * Returns an UPPERCASE method string, or null if none stated explicitly.
 *
 * @param {Object} seg structured segment from argv.parseCommand
 * @returns {string|null}
 */
function explicitMethod(seg) {
  const flags = seg.flags || {};
  const shortFlags = seg.shortFlags || {};

  // long: --method POST  (argv records as flags.method)
  if (typeof flags.method === 'string') {
    return flags.method.toUpperCase();
  }
  // short: -X POST  → shortFlags.X === 'POST'
  //        -XPOST   → shortFlags.X === 'POST' (bundled value-attached)
  if (typeof shortFlags.X === 'string') {
    return shortFlags.X.toUpperCase();
  }
  return null;
}

/**
 * Decide whether a curl/gh-api call carries a request body that implies a write,
 * i.e. `-d`/`--data`/`-f`/`--field` present. Used to infer POST when no explicit
 * method is given (curl defaults to POST when -d is present; gh api defaults to
 * POST when -f/-F fields are present).
 *
 * @param {Object} seg
 * @returns {boolean}
 */
function hasWriteBody(seg) {
  const flags = seg.flags || {};
  const shortFlags = seg.shortFlags || {};
  // CR-04: a PR/issue opened via `gh api … --raw-field body=x` or `curl …
  // --data-raw/--data-binary/--data-urlencode` carries a write body but used a long
  // flag the original set missed → no inferred POST → silent allow. Cover the full
  // curl --data-* family and the gh api --field/--raw-field synonyms (toolkit-OWNED).
  return (
    'data' in flags ||
    'data-raw' in flags ||
    'data-binary' in flags ||
    'data-urlencode' in flags ||
    'data-ascii' in flags ||
    'field' in flags ||
    'raw-field' in flags ||
    'd' in shortFlags ||
    'f' in shortFlags ||
    'F' in shortFlags
  );
}

/**
 * From a `repos/OWNER/REPO/<resource>[/N]` path, decide the GitHub resource kind.
 * Returns { resource:'issues'|'pulls', member:boolean } or null if the path is
 * not a clean issues|pulls collection/member endpoint.
 *
 * Accepts an optional leading slash and an optional leading `repos/` segment.
 *
 * @param {string} path
 * @returns {{resource:string, member:boolean}|null}
 */
function classifyGithubPath(path) {
  if (typeof path !== 'string' || path.length === 0) return null;

  // Strip protocol+host if a full URL was given.
  let p = path;
  const schemeIdx = p.indexOf('://');
  if (schemeIdx !== -1) {
    const afterScheme = p.slice(schemeIdx + 3);
    const slash = afterScheme.indexOf('/');
    p = slash === -1 ? '' : afterScheme.slice(slash);
  }

  // Drop query string / fragment.
  p = p.split('?')[0].split('#')[0];

  // Normalize leading slash and optional repos/ prefix.
  const parts = p.split('/').filter((s) => s.length > 0);
  if (parts.length === 0) return null;

  let idx = 0;
  if (parts[idx] === 'repos') idx += 1;

  // Expect OWNER / REPO / resource [ / N [ / <sub-resource…> ] ]
  // parts[idx] = owner, parts[idx+1] = repo, parts[idx+2] = resource
  const owner = parts[idx];
  const repo = parts[idx + 1];
  const resource = parts[idx + 2];
  const rest = parts.slice(idx + 3); // member id + any trailing sub-resource segments

  if (!owner || !repo || !resource) return null;
  if (resource !== 'issues' && resource !== 'pulls') return null;

  // Collection endpoint: exactly OWNER/REPO/resource (no further segments) — the
  // create surface (POST here = issue/PR create).
  if (rest.length === 0) {
    return { resource, member: false };
  }

  // Member endpoints require a NUMERIC id. A non-numeric "member" (issues/weird/…)
  // is an unmappable path — return null so the mutating-github guard fails closed
  // (EP-1: an unclassifiable mutating synonym MUST deny, never fall through).
  if (!/^\d+$/.test(rest[0])) return null;

  // Bare member: OWNER/REPO/resource/N — the governed body/title edit surface
  // (PATCH/PUT here = issue/PR edit).
  if (rest.length === 1) {
    return { resource, member: true };
  }

  // Member SUB-resource: OWNER/REPO/resource/N/<labels|assignees|requested_reviewers|…>.
  // Most of these are benign metadata mutations — NOT a create (collection POST) and
  // NOT a body/title edit (bare-member PATCH) — so they pass through as 'other' rather
  // than fail closed (G1). The numeric-member check above keeps genuinely-unmappable
  // paths (non-numeric member) failing closed.
  //
  // ENF-20 adds `subPath` (additive): the ordered sub-resource segments after the
  // numeric member id, so classifyRestSegment can recognize the REVIEW-SIDE
  // sub-resources (`reviews`, `merge`, `comments`) that are anything but benign. Every
  // other subPath keeps the pre-ENF-20 'other' outcome untouched.
  return { resource, member: true, sub: true, subPath: rest.slice(1) };
}

/**
 * Pull the API target path/URL out of a gh-api or curl segment. For `gh api` it is
 * the first positional that looks like a repos/api path. For `curl` it is the
 * positional URL containing a host.
 *
 * @param {Object} seg
 * @param {boolean} isCurl
 * @returns {string|null}
 */
function extractTarget(seg, isCurl) {
  const positionals = seg.positionals || [];
  const subAsPositional = seg.subcommands || [];
  // gh api: the path may have been captured as a subcommand (no leading dash) or
  // positional depending on flag ordering. Consider both, plus flag VALUES that
  // were swallowed (e.g. curl -X POST <url> -d x → url is a positional).
  const candidates = [...subAsPositional, ...positionals];

  if (isCurl) {
    // Find a candidate that contains a host (has '://' or starts with a domain).
    for (const c of candidates) {
      if (c.includes('://') || c.includes('api.github.com')) return c;
    }
    // Some curl invocations put the URL as a flag value; scan flag values too.
    for (const v of Object.values(seg.flags || {})) {
      if (typeof v === 'string' && (v.includes('://') || v.includes('api.github.com'))) {
        return v;
      }
    }
    return null;
  }

  // gh api: target is the first candidate that is not the literal 'api' subcommand.
  for (const c of candidates) {
    if (c === 'api') continue;
    if (c.includes('/') || c === 'repos') return c;
  }
  // Also consider a path captured as a flag value edge case.
  return null;
}

/**
 * Classify a single parsed segment by its DIRECT form (the pre-261006-jsm classifier, unchanged).
 * Returns a result object or null when the segment is not itself a recognized action. Callers go
 * through classifySegment, which adds the verdict-route recovery on the null path only.
 *
 * @param {Object} seg
 * @returns {{action:string, route?:string, failClosed?:boolean}|null}
 */
function classifySegmentDirect(seg) {
  if (!seg || typeof seg !== 'object') return null;

  // CR-01/CR-03: resolve the effective program (basename, past wrapper builtins)
  // and the ordered non-flag verb candidates (past git global options). Reading the
  // STRUCTURED token list only — never re-tokenizing the raw string (EP-2).
  const { prog, args, wrapped, ambiguous } = resolveProgram(seg);

  // CF-08 (D-07): a wrapped form whose value-taking flag left NO resolvable program
  // (`env -S '<packed cmd>'`) is an unclassifiable-mutating case — fail closed (ENF-15),
  // never a silent `other`. A containment boundary must not trust a leftover value token.
  if (ambiguous) return FAIL_CLOSED;

  // ---- git ----
  if (prog === 'git') {
    // CR-01: the verb may be in positionals (global flag seen) or shadowed by a
    // boolean global's swallowed "value" — resolveProgram's `args` is the
    // global-option-stripped verb stream, so the verb is args[0].
    const verb = args[0];
    if (verb === 'commit') return { action: 'commit' };
    if (verb === 'push') return { action: 'push' };
    // ENF-22: `git merge` — a verb whose OUTCOME is a commit. PURE VERB classification
    // only: whether THIS invocation will actually create a commit depends on flags
    // (`--no-commit`, `--squash`, `--ff-only`, a missing ref), and flag semantics belong
    // to the gate (git-commit-convention.cjs), never to this module. Routing through
    // resolveProgram gives the same bypass-form coverage `commit` has for free:
    // `sudo git merge`, `/usr/bin/git merge`, `GIT_DIR=/x git merge`, `git -C /tmp merge`.
    if (verb === 'merge') return { action: 'merge' };
    return null; // git status, git add, … → other
  }

  // ---- gh ----
  if (prog === 'gh') {
    const area = args[0]; // issue | pr | api | repo | …
    const verb = args[1]; // create | edit | view | …

    if (area === 'issue' || area === 'pr') {
      if (verb === 'create') {
        return { action: area === 'issue' ? 'issue-create' : 'pr-create', route: 'native' };
      }
      if (verb === 'edit') {
        return { action: area === 'issue' ? 'issue-edit' : 'pr-edit', route: 'native' };
      }
      // ENF-20: the review-side (adjudicating) verbs. Additive — every verb NOT
      // listed here still falls through to `other` exactly as before.
      if (area === 'pr' && verb === 'review') return { action: 'pr-review', route: 'native' };
      if (area === 'pr' && verb === 'merge') return { action: 'pr-merge', route: 'native' };
      if (area === 'issue' && verb === 'close') return { action: 'issue-close', route: 'native' };
      if (verb === 'comment') {
        // `gh pr comment` names the PR; `gh issue comment` names the issue. See
        // PR_COMMENT_EQUIVALENT_ACTIONS for why these stay two actions, not one.
        return { action: area === 'issue' ? 'issue-comment' : 'pr-comment', route: 'native' };
      }
      // NOT in ENF-20's five (deliberately, so the boundary is explicit): `gh pr close`,
      // `gh issue reopen`, `gh pr ready`, `gh pr review-request`. They stay `other`.
      return null; // gh issue view / list → other
    }

    if (area === 'api') {
      return classifyRestSegment(seg, 'gh-api', false);
    }

    // CR-03 conservatism: if a wrapper preceded gh but the gh verb is unmappable to
    // a recognized area, do NOT silently fall through to other for a MUTATING form.
    // gh repo view / auth status carry no mutating body, so they stay other below.
    return null; // gh repo view, gh auth status … → other
  }

  // ---- curl ----
  if (prog === 'curl') {
    return classifyRestSegment(seg, 'curl', true);
  }

  // CR-03 conservatism: an UNRECOGNIZED wrapper around something we could not map to
  // git/gh/curl. A wrapper with NO git/gh underneath (e.g. `command ls`) is a plain
  // unrelated command → other. Only fail closed when a wrapped form is plausibly a
  // mutating git/gh call we failed to resolve — here `prog` is neither git/gh/curl,
  // so there is no mutating github surface to protect; stay other (no over-block).
  if (wrapped) return null;

  return null;
}

// ---------------------------------------------------------------------------
// 261006-jsm: ENF-20 VERDICT-ROUTE RECOVERY (CONTEXT D1, D3, D4)
//
// A `gh pr review` verdict can be issued through a form whose direct classification is `other`
// (a wrapper the shared walk deliberately does not peel, CONTEXT D1 and the 36-02a lock), which
// let it skip ENF-20's R8a memtrace check. The recovery below runs ONLY where the direct
// classifier returned null and may return ONLY a `pr-review` result carrying `recovered: true`:
//
//   { action: 'pr-review', route: 'recovered', recovered: true, via, verdictSegments: [seg, ...] }
//
// One exception, authorized by the review fix round (CR-02 / WR-04): a TOP-LEVEL REST comment
// POST whose body is an attached or bundled field (`gh api .../issues/42/comments -fbody=CLEAR`,
// `curl -sd ... .../issues/42/comments`) recovers as `issue-comment` / `pr-comment` with
// `recovered: true` and its outer segment as the verdict segment. Only the review-artifact gate
// governs the comment actions, the result sits in PASS 4 like every recovered result, and it never
// fails closed. A wrapped comment stays discarded below (combineRecovered keeps only pr-review).
//
// `verdictSegments` are the inner segments the review-artifact gate must run (re-parsed from the
// static payload text with argv.parseCommand, never a raw-string grep, EP-2). An opaque form the
// recovery cannot read is UNCERTAIN (D6) and the gate grades it `ask` with no PR lookup:
//
//   { action: 'pr-review', route: 'recovered', recovered: true, uncertain: true, via, verdictSegments: [] }
//
// A GraphQL query read from a file or stdin (Task 3b, orchestrator B1) is UNRESOLVED, and the gate
// holds the MJ-02 ask with no PR lookup:
//
//   { action: 'pr-review', route: 'graphql', recovered: true, unresolved: true, via: 'graphql-file-query', verdictSegments: [] }
//
// A collection that holds verdict segments AND an uncertain inner keeps the segments and adds
// `uncertain: true` plus `uncertainVia` (the code naming the opaque inner form); an unresolved
// inner adds `unresolved: true` plus `unresolvedVia` the same way. Any other inner
// result (push, pr-merge, failClosed, null) is discarded, so the segment stays `other` exactly as
// before (D1). classifyAction's PASS 4 keeps every existing chain classification unchanged (D2).
//
// Recovery state, passed down explicitly (no module-level mutable state):
//   depth          payload re-parses so far (eval, shell -c); bounded by RECOVERY_MAX_DEPTH
//   peels          transparent prefixes stripped at this depth; bounded by MAX_PREFIX_PEELS
//   inShellString  true inside an eval or shell -c payload
// ---------------------------------------------------------------------------

/** Payload re-parses (eval, shell -c) allowed before a payload is treated as opaque (D3). */
const RECOVERY_MAX_DEPTH = 4;

/** Transparent prefixes (subshell, nohup, time, ...) stripped at one depth before the bound. */
const MAX_PREFIX_PEELS = 8;

/**
 * Stable `via` code -> FIXED ASCII description of the form, for gate messages. A description is
 * never built from command text, so a gate reason can never echo a payload, a path or a body.
 */
const VERDICT_ROUTE_FORMS = Object.freeze({
  'shell-c': 'a review command inside a bash or sh -c command string',
  subshell: 'a review command inside a ( ... ) subshell',
  'brace-group': 'a review command inside a { ...; } brace group',
  negation: 'a review command behind a ! pipeline negation',
  nohup: 'a review command run through nohup',
  setsid: 'a review command run through setsid',
  time: 'a review command run through time',
  eval: 'a review command inside an eval payload',
  builtin: 'a review command run through the builtin prefix',
  'gh-repo-flag': 'a gh pr review command with -R or --repo before the review verb',
  'expansion-program': 'a command whose program name is built by shell expansion next to a review hint',
  'opaque-payload': 'an eval or shell -c payload whose command word is a shell expansion',
  'unparseable-payload': 'an eval or shell -c payload the gate cannot parse',
  'depth-bound': 'an eval or shell -c payload nested deeper than the gate reads',
  'prefix-bound': 'a review command behind more stacked wrappers than the gate reads',
  xargs: 'a review command run through xargs',
  'xargs-unknown-option': 'an xargs command with an option the gate cannot read',
  'gh-api-attached-field': 'a gh api review post whose fields are attached to the flag (-fevent=...)',
  'gh-api-input': 'a gh api review post whose body is read with --input',
  'gh-api-bundled-field': 'a gh api request whose field flag is bundled behind -i (-if, -iFevent=...)',
  'curl-bundled-flag': 'a curl request whose body or method flag is bundled with other short flags (-sd, -sX POST)',
  graphql: 'a GraphQL review mutation (submitPullRequestReview or addPullRequestReview)',
  'graphql-file-query': 'a GraphQL query read from a file or stdin, which may be a review mutation',
});

/**
 * CONTEXT D7 (A), approved by the coordinator as written: inside an eval or shell -c payload, a
 * command word built by expansion (`eval "$CMD"`, `bash -c "$CMD"`) is an UNCERTAIN verdict route
 * with NO review hint required, because eval re-reads the expansion's output as a whole command
 * line, so the verb and the flags are hidden too. Measured 2026-10-06: 17 / 47,642 Bash calls
 * (0.04%) in ~/.claude/projects transcripts. Flipping this to true makes (A) require a review hint
 * like the top-level form (B) does.
 */
const OPAQUE_SHELL_PAYLOAD_NEEDS_HINT = false;

/**
 * Lone prefix tokens the recovery strips from the visible argv (Task 2a, D4): the reserved words
 * that open a subshell, a brace group and a negated pipeline. A `(` attached to the first word
 * is the subshell too (`(gh pr review 42 -a)`).
 */
const RECOVERY_PREFIX_WORDS = Object.freeze({ '(': 'subshell', '{': 'brace-group', '!': 'negation' });

/** GNU time long options that take a value (RESEARCH section 6); matched by unique prefix. */
const TIME_VALUE_LONG = Object.freeze(['format', 'output']);

// GNU xargs (findutils 4.9.0) options, RESEARCH section 4 (probed): short letters with no value,
// with a REQUIRED value (the rest of the token if non-empty, else the next token), and with an
// OPTIONAL value that may only be attached (a separate token is already the command).
const XARGS_SHORT_NO_VALUE = new Set(['0', 'o', 'p', 'r', 't', 'x']);
const XARGS_SHORT_REQUIRED = new Set(['a', 'd', 'E', 'I', 'L', 'n', 'P', 's']);
const XARGS_SHORT_OPTIONAL = new Set(['i', 'e', 'l']);
/** GNU xargs long options by value class; resolved by exact name, else by unique prefix. */
const XARGS_LONG = Object.freeze({
  'arg-file': 'required',
  delimiter: 'required',
  'max-args': 'required',
  'max-procs': 'required',
  'max-chars': 'required',
  'process-slot-var': 'required',
  replace: 'optional',
  eof: 'optional',
  'max-lines': 'optional',
  null: 'none',
  'open-tty': 'none',
  interactive: 'none',
  'no-run-if-empty': 'none',
  verbose: 'none',
  exit: 'none',
  'show-limits': 'none',
  help: 'none',
  version: 'none',
});

/** Shells whose `-c` command string the recovery re-parses (RESEARCH section 5). */
const RECOVERY_SHELLS = new Set(['bash', 'sh', 'dash', 'zsh', 'ksh']);

const ROOT_RECOVERY_STATE = Object.freeze({ depth: 0, peels: 0, inShellString: false });

/**
 * Classify a single parsed segment. Returns a result object or null when the segment is not
 * itself a recognized action (caller treats null as 'other'). The direct classifier answers
 * first; only a null answer reaches the verdict-route recovery, so no non-null result (and no
 * `ambiguous` FAIL_CLOSED) is ever replaced.
 *
 * @param {Object} seg
 * @param {{depth:number, peels:number, inShellString:boolean}} [state] internal recovery state
 * @returns {{action:string, route?:string, failClosed?:boolean, recovered?:boolean}|null}
 */
function classifySegment(seg, state) {
  const direct = classifySegmentDirect(seg);
  if (direct !== null) return direct;
  return recoverVerdictRoute(seg, state || ROOT_RECOVERY_STATE);
}

/**
 * The verdict-route recovery: null, or a recovered `pr-review` result (or, for a top-level REST
 * comment POST with an attached or bundled body field, a recovered comment action). Pure.
 *
 * Prefilter first: the program (resolved past env assignments and WRAPPER_BUILTINS by the shared
 * resolveProgram) must be a recovery trigger, so an ordinary command pays one resolveProgram.
 *
 * @param {Object} seg
 * @param {{depth:number, peels:number, inShellString:boolean}} state
 * @returns {Object|null}
 */
function recoverVerdictRoute(seg, state) {
  if (!seg || typeof seg !== 'object' || !Array.isArray(seg.tokens)) return null;
  const { prog, args } = resolveProgram(seg);
  if (RECOVERY_SHELLS.has(prog)) return recoverShellCommandString(seg, prog, state);

  const tokens = seg.tokens;
  const at = programTokenIndex(tokens, prog);
  if (at === -1) return null;
  const word = tokens[at];
  const after = tokens.slice(at + 1);

  // Task 2a transparent prefixes: each strip removes ONE prefix from the same visible argv.
  if (Object.prototype.hasOwnProperty.call(RECOVERY_PREFIX_WORDS, word)) {
    const rest = word === '(' ? withoutClosingParen(after) : after;
    return recoverStripped(rest, RECOVERY_PREFIX_WORDS[word], state);
  }
  if (word.length > 1 && word[0] === '(') {
    return recoverStripped(withoutClosingParen([word.slice(1), ...after]), 'subshell', state);
  }
  // Task 3: `gh api` review posts the frozen hasWriteBody does not read (an attached field, a bare
  // --input) and GraphQL review mutations.
  if (prog === 'gh' && args[0] === 'api') return recoverGhApi(seg);
  // Task 2c: gh with -R / --repo before the area or between `pr` and the verb (the direct walk
  // reads -R's value as the area or verb, so it returned null).
  if (prog === 'gh') return recoverGhRepoFlag(seg, after);
  // Task 2b: eval re-reads its arguments, joined with one space, as a command line (a payload).
  // Review fix round CR-04: a leading `--` ends eval's (empty) option list and is not payload.
  if (prog === 'eval') return recoverPayload((after[0] === '--' ? after.slice(1) : after).join(' '), 'eval', state);
  // Review fix round CR-04: `builtin [--] NAME ARGS` runs the shell builtin NAME (`builtin eval`,
  // `builtin command ...`), so in the recovery only it is a transparent prefix (WRAPPER_BUILTINS is
  // unchanged, D1). A non-builtin NAME fails in bash, so peeling it can only over-gate.
  if (prog === 'builtin') return recoverStripped(after[0] === '--' ? after.slice(1) : after, 'builtin', state);
  if (prog === 'nohup') return recoverStripped(after[0] === '--' ? after.slice(1) : after, 'nohup', state);
  if (prog === 'setsid') return recoverStripped(afterSetsidOptions(after), 'setsid', state);
  if (prog === 'time') return recoverStripped(afterTimeOptions(after), 'time', state);
  if (prog === 'xargs') return recoverXargs(after, state);
  // Task 3b: a curl POST to the GitHub GraphQL endpoint. Review fix round CR-02: a REST curl whose
  // body or method flag is bundled (`-sd`, `-sX POST`), which the direct classifier reads as GET.
  if (prog === 'curl') return recoverGraphql(seg) || recoverCurlRestPost(seg);
  // Task 2d: a program word built by expansion (`$(echo gh)`, `$GH`, a backtick), keyed on the
  // token as argv produced it (argv drops the quotes of `"$CHROME"`).
  if (word.length > 0 && (word[0] === '$' || word[0] === '`')) return recoverExpansionProgram(tokens, state);
  return null;
}

/**
 * Is a review hint visible among `tokens`? True for a `review` token, `--approve`,
 * `--request-changes`, a `/pulls/<n>/reviews` path, or the GraphQL review mutation names
 * `submitPullRequestReview` / `addPullRequestReview` (case-sensitive whole identifiers). `-a`
 * alone is deliberately not a hint (it is too common to scope an ask). Pure.
 *
 * @param {string[]} tokens
 * @returns {boolean}
 */
function hasReviewHint(tokens) {
  if (!Array.isArray(tokens)) return false;
  return tokens.some((t) => typeof t === 'string' && (
    t === 'review' || t === '--approve' || t === '--request-changes' ||
    /\/pulls\/\d+\/reviews(?:$|[/?])/.test(t) ||
    /\b(?:submitPullRequestReview|addPullRequestReview)\b/.test(t)
  ));
}

/**
 * An UNCERTAIN verdict route (D6): a pr-review the gate grades `ask` without a PR lookup. `via`
 * names the opaque form; there is no verdict segment to gate.
 *
 * @param {string} via a VERDICT_ROUTE_FORMS code
 * @returns {Object}
 */
function uncertainRoute(via) {
  return { action: 'pr-review', route: 'recovered', recovered: true, uncertain: true, via, verdictSegments: [] };
}

/**
 * A program word built by expansion (D7). Inside an eval or shell -c payload it is uncertain with
 * no hint (A) unless OPAQUE_SHELL_PAYLOAD_NEEDS_HINT; anywhere else it is uncertain only when a
 * review hint is visible (B), else null (1,509 / 47,642 Bash calls start with an expansion, so a
 * hint-free ask would fire on about one call in 30). Residual: `$X 42 -a` stays other.
 *
 * @param {string[]} tokens the segment tokens
 * @param {{depth:number, peels:number, inShellString:boolean}} state
 * @returns {Object|null}
 */
function recoverExpansionProgram(tokens, state) {
  if (state.inShellString && (!OPAQUE_SHELL_PAYLOAD_NEEDS_HINT || hasReviewHint(tokens))) {
    return uncertainRoute('opaque-payload');
  }
  return hasReviewHint(tokens) ? uncertainRoute('expansion-program') : null;
}

/**
 * Index of the first token at or after `i` that is not a gh `-R <v>`, `-R<v>`, `--repo <v>` or
 * `--repo=<v>` spelling (a separate value token is skipped with its flag).
 *
 * @param {string[]} tokens
 * @param {number} i
 * @returns {number}
 */
function skipGhRepoFlags(tokens, i) {
  let k = i;
  while (k < tokens.length) {
    const t = tokens[k];
    if (t === '-R' || t === '--repo') k += 2;
    else if ((t.length > 2 && t.startsWith('-R')) || t.startsWith('--repo=')) k += 1;
    else break;
  }
  return k;
}

/**
 * Recover `gh -R o/r pr review ...` and `gh pr -R o/r review ...` (RESEARCH section 2: -R is a
 * persistent flag of the `pr` group, accepted before the area and between `pr` and the verb).
 * The outer segment is the verdict segment (D3): repoSpecOf reads its -R value and prSelector
 * reads its selector across the flag. Any other area or verb returns null (D1): a wrapped
 * `gh -R o/r pr merge` stays other (recorded residual).
 *
 * @param {Object} seg
 * @param {string[]} after the tokens after `gh`
 * @returns {Object|null}
 */
function recoverGhRepoFlag(seg, after) {
  const area = skipGhRepoFlags(after, 0);
  if (after[area] !== 'pr') return null;
  const verb = skipGhRepoFlags(after, area + 1);
  if (after[verb] !== 'review') return null;
  return { action: 'pr-review', route: 'recovered', recovered: true, via: 'gh-repo-flag', verdictSegments: [seg] };
}

/**
 * Recover a `gh api` verdict route the direct classifier returned null for (Task 3, CONTEXT D4).
 *
 * @param {Object} seg
 * @returns {Object|null}
 */
function recoverGhApi(seg) {
  return recoverGraphql(seg) || recoverRestReviewPost(seg);
}

/** The GraphQL review mutations (case-sensitive, whole identifiers; CONTEXT D4). */
const GRAPHQL_REVIEW_MUTATION_RE = /\b(submitPullRequestReview|addPullRequestReview)\b/;

/** curl request-body flags; every one but --data-raw reads a file or stdin for an `@` value. */
const CURL_BODY_FLAGS = Object.freeze(['-d', '--data', '--data-binary', '--data-ascii', '--data-urlencode', '--json', '--data-raw']);

/**
 * Is this segment a request to the GitHub GraphQL endpoint? `gh api graphql` or `gh api /graphql`
 * (the endpoint is the first subcommand or positional after `api`; a query string or trailing slash
 * is ignored), `gh api https://api.github.com/graphql` (review fix round CR-03), or curl whose URL
 * host is api.github.com and whose path is `/graphql`. Returns 'gh', 'curl' or null.
 *
 * @param {Object} seg
 * @returns {'gh'|'curl'|null}
 */
function graphqlTarget(seg) {
  const { prog, args } = resolveProgram(seg);
  if (prog === 'gh') {
    if (args[0] !== 'api') return null;
    const candidates = [...(seg.subcommands || []), ...(seg.positionals || [])];
    const at = candidates.indexOf('api');
    const endpoint = at === -1 ? undefined : candidates[at + 1];
    if (typeof endpoint !== 'string') return null;
    // Review fix round CR-03: gh also takes a full URL (it sends the same POST to its path) and a
    // query string or a trailing slash on the endpoint; the curl branch's host + path rule applies.
    if (endpoint.indexOf('://') !== -1) return graphqlUrlPath(endpoint) === '/graphql' ? 'gh' : null;
    const bare = endpoint.split('?')[0].split('#')[0].replace(/\/+$/, '');
    return bare === 'graphql' || bare === '/graphql' ? 'gh' : null;
  }
  if (prog === 'curl') {
    const target = curlUrl(seg);
    return target && graphqlUrlPath(target) === '/graphql' ? 'curl' : null;
  }
  return null;
}

/**
 * The path of an api.github.com URL with its query, fragment and trailing slashes dropped, or null
 * for any other host. Shared by the gh full-URL endpoint (review fix round CR-03) and curl.
 *
 * @param {string} url
 * @returns {string|null}
 */
function graphqlUrlPath(url) {
  if (hostOf(url) !== 'api.github.com') return null;
  const scheme = url.indexOf('://');
  const rest = scheme === -1 ? url : url.slice(scheme + 3);
  const slash = rest.indexOf('/');
  return slash === -1 ? '' : rest.slice(slash).split('?')[0].split('#')[0].replace(/\/+$/, '');
}

/**
 * gh api's boolean short flags (gh 2.95 `gh api --help`): only `-i` (`--include`). `-p`
 * (`--preview`), `-q`, `-t`, `-H` and `-X` take a value, so a letter after them is that value.
 */
const GH_API_FIELD_TOKEN_RE = /^-(i*)([fF])([\s\S]*)$/;

/**
 * A gh api field-flag token (review fix round CR-02, recovery only; hasWriteBody is frozen, D1):
 * `-f` / `-F` alone, attached (`-fname=v`, `-f=name=v`) or bundled behind `-i` (`-if`,
 * `-iFname=v`). Returns `{ typed, bundled, attached }`: `typed` for `F`, `bundled` when `-i`
 * precedes the letter, `attached` the field body written on the token (one leading `=` dropped,
 * pflag's `-f=value`) or null when the body is the NEXT token. Null for any other token. Pure.
 *
 * @param {string} t
 * @returns {{typed:boolean, bundled:boolean, attached:(string|null)}|null}
 */
function ghFieldToken(t) {
  if (typeof t !== 'string') return null;
  const m = GH_API_FIELD_TOKEN_RE.exec(t);
  if (!m) return null;
  const rest = m[3].startsWith('=') ? m[3].slice(1) : m[3];
  return { typed: m[2] === 'F', bundled: m[1].length > 0, attached: m[3].length > 0 ? rest : null };
}

/**
 * curl's boolean short flags that may bundle in front of `-d` or `-X` (`-sd`, `-sSLd`, `-sX`). `-G`
 * (send the data as a GET query) and `-I` (HEAD) are deliberately absent: behind them `-d` is not a
 * POST body, so such a bundle is not read.
 */
const CURL_BUNDLE_SHORTS = 'sSLkvifgN';

/**
 * A curl short-flag token for `letter` (`d` body, `X` method), alone, attached (`-dBODY`, `-XPOST`)
 * or bundled behind curl boolean shorts (`-sd`, `-sSdBODY`, `-sX`) (review fix round CR-02, recovery
 * only; explicitMethod and hasWriteBody are frozen, D1). Returns `{ bundled, attached }`: `attached`
 * the value written on the token, or null when the value is the NEXT token. Null for any other token,
 * including a letter after a value-taking short (`-Xd` is method `d`). Pure.
 *
 * @param {string} t
 * @param {'d'|'X'} letter
 * @returns {{bundled:boolean, attached:(string|null)}|null}
 */
function curlShortToken(t, letter) {
  if (typeof t !== 'string' || t.length < 2 || t[0] !== '-' || t[1] === '-') return null;
  let k = 1;
  while (k < t.length && CURL_BUNDLE_SHORTS.indexOf(t[k]) !== -1 && t[k] !== letter) k += 1;
  if (t[k] !== letter) return null;
  const rest = t.slice(k + 1);
  return { bundled: k > 1, attached: rest.length > 0 ? rest : null };
}

/**
 * The URL of a curl segment: the first token that starts with an http(s) scheme, else
 * extractTarget's host scan (a JSON body naming a URL is never taken over a real URL token).
 *
 * @param {Object} seg
 * @returns {string|null}
 */
function curlUrl(seg) {
  const tokens = Array.isArray(seg.tokens) ? seg.tokens : [];
  const url = tokens.find((t) => typeof t === 'string' && /^https?:\/\//i.test(t));
  return url || extractTarget(seg, true);
}

/**
 * The `name=value` fields of a gh api segment, read from the TOKENS (repeated `-f` flags overwrite
 * each other in the parsed flag map): `-f` / `--raw-field` (raw string) and `-F` / `--field`
 * (typed: an `@` value is read from a file or stdin), as a separate value token, attached
 * (`-fquery=...`, `-f=query=...`), bundled behind -i (`-if query=...`, `-iFquery=...`, review fix
 * round CR-02) or long with `=` (`--field=query=...`).
 *
 * @param {string[]} tokens
 * @returns {Array<{name:string, value:string, typed:boolean}>}
 */
function ghApiFields(tokens) {
  const out = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    let typed = null;
    let body;
    const short = ghFieldToken(t);
    if (t === '--raw-field' || t === '--field') {
      typed = t === '--field';
      body = tokens[i + 1];
      i += 1;
    } else if (short) {
      // `-f` / `-F`, attached (`-fquery=...`, `-f=query=...`) or bundled behind -i (CR-02).
      typed = short.typed;
      if (short.attached === null) {
        body = tokens[i + 1];
        i += 1;
      } else {
        body = short.attached;
      }
    } else {
      const long = /^--(raw-field|field)=([\s\S]*)$/.exec(t);
      if (long) {
        typed = long[1] === 'field';
        body = long[2];
      }
    }
    if (typed === null || typeof body !== 'string') continue;
    const eq = body.indexOf('=');
    if (eq <= 0) continue;
    out.push({ name: body.slice(0, eq), value: body.slice(eq + 1), typed });
  }
  return out;
}

/**
 * The GraphQL review mutation a segment sends, if any (Task 3b, CONTEXT D4). Pure.
 *
 * Returns null when the segment is not a request to the GitHub GraphQL endpoint (graphqlTarget).
 * Otherwise `{ mutation, queryText, fileSourced, variables, fields }`:
 *   queryText    every `query` field value (gh sends the LAST of repeated fields, so none is
 *                skipped; joined with a newline) or the inline JSON body's `query` (curl), or null
 *   mutation     `submitPullRequestReview` / `addPullRequestReview` when the query text names one
 *                as a case-sensitive whole identifier, else null
 *   fileSourced  true when the query may come from a file or stdin: gh `-F query=@...` /
 *                `--field query=@...` (including `@-`), gh `--input <f|->`, or a curl body flag
 *                other than --data-raw whose value starts with `@`. `-f query=@x` is NOT
 *                file-sourced: gh sends the literal text.
 *   variables    name -> value for every non-query gh field, or the curl JSON body's `variables`
 *                object (values as JSON gives them), for the gate's event-variable read
 *   fields       every gh field in token order (`{name, value, typed}`, repeats kept), so the gate
 *                can read every value of a repeated variable and gh's bracket paths
 *                (`input[event]=...`); [] for curl
 *
 * @param {Object} seg
 * @returns {{mutation:(string|null), queryText:(string|null), fileSourced:boolean, variables:Object, fields:Array<{name:string, value:string, typed:boolean}>}|null}
 */
function graphqlReviewMutation(seg) {
  if (!seg || typeof seg !== 'object' || !Array.isArray(seg.tokens)) return null;
  const target = graphqlTarget(seg);
  if (target === null) return null;
  const tokens = seg.tokens.filter((t) => typeof t === 'string');
  let queryText = null;
  let fileSourced = false;
  const variables = {};
  let fields = [];
  if (target === 'gh') {
    fields = ghApiFields(tokens);
    const queries = [];
    for (const f of fields) {
      if (f.name === 'query') {
        if (f.typed && f.value.startsWith('@')) fileSourced = true;
        else queries.push(f.value);
      } else if (!Object.prototype.hasOwnProperty.call(variables, f.name)) {
        variables[f.name] = f.value;
      }
    }
    if (queries.length > 0) queryText = queries.join('\n');
    if (tokens.some((t) => t === '--input' || t.startsWith('--input='))) fileSourced = true;
  } else {
    for (let i = 0; i < tokens.length; i += 1) {
      const t = tokens[i];
      let flag = null;
      let val;
      const long = /^(--[A-Za-z][A-Za-z0-9-]*)=([\s\S]*)$/.exec(t);
      if (CURL_BODY_FLAGS.indexOf(t) !== -1) {
        flag = t;
        val = tokens[i + 1];
        i += 1;
      } else if (long && CURL_BODY_FLAGS.indexOf(long[1]) !== -1) {
        flag = long[1];
        val = long[2];
      } else {
        // `-dBODY` attached, or bundled behind curl boolean shorts (`-sd BODY`, `-sSdBODY`, CR-02).
        const d = curlShortToken(t, 'd');
        if (d) {
          flag = '-d';
          if (d.attached === null) {
            val = tokens[i + 1];
            i += 1;
          } else {
            val = d.attached;
          }
        }
      }
      if (flag === null || typeof val !== 'string') continue;
      if (flag !== '--data-raw' && val.startsWith('@')) {
        fileSourced = true;
        continue;
      }
      if (!/^\s*\{/.test(val)) continue;
      let o;
      try {
        o = JSON.parse(val);
      } catch (_) {
        continue;
      }
      if (o && typeof o === 'object') {
        if (typeof o.query === 'string' && queryText === null) queryText = o.query;
        if (o.variables && typeof o.variables === 'object') Object.assign(variables, o.variables);
      }
    }
  }
  const m = queryText === null ? null : GRAPHQL_REVIEW_MUTATION_RE.exec(queryText);
  return { mutation: m ? m[1] : null, queryText, fileSourced, variables, fields, target };
}

/**
 * Recover a GraphQL verdict route (Task 3b, CONTEXT D4, orchestrator B1). A visible review mutation
 * is a recovered pr-review (route graphql), the outer segment its verdict segment; the gate reads
 * its event from the query text or a variable. A query read from a file or stdin with no visible
 * mutation is UNRESOLVED: no verdict segment, no review hint required (0 genuine such calls in
 * 48,055 Bash calls, 31 `gh api graphql` calls in total, 2026-10-06), and the gate asks without a
 * PR lookup because the request names no PR. An explicit non-mutating method returns null.
 *
 * @param {Object} seg
 * @returns {Object|null}
 */
function recoverGraphql(seg) {
  const g = graphqlReviewMutation(seg);
  if (g === null) return null;
  const method = explicitMethod(seg) || (g.target === 'curl' ? curlBundledMethod(seg) : null);
  if (method !== null && !MUTATING_METHODS.has(method)) return null;
  if (g.mutation !== null) {
    return { action: 'pr-review', route: 'graphql', recovered: true, via: 'graphql', verdictSegments: [seg] };
  }
  if (g.fileSourced) {
    return {
      action: 'pr-review', route: 'graphql', recovered: true, unresolved: true, via: 'graphql-file-query', verdictSegments: [],
    };
  }
  return null;
}

/**
 * The recovered action of a REST member sub-resource POST (review fix round CR-02): `reviews` ->
 * pr-review, `issues/<n>/comments` -> issue-comment, `pulls/<n>/comments` -> pr-comment; every
 * other target (a merge, labels, a collection create) -> null, so it stays other (D1).
 *
 * @param {string|null} target
 * @returns {string|null}
 */
function restRecoveredAction(target) {
  const kind = classifyGithubPath(target || '');
  if (!kind || kind.sub !== true || !Array.isArray(kind.subPath)) return null;
  const head = kind.subPath[0];
  if (kind.resource === 'pulls' && head === 'reviews') return 'pr-review';
  if (head === 'comments' && kind.subPath.length === 1) return kind.resource === 'pulls' ? 'pr-comment' : 'issue-comment';
  return null;
}

/**
 * A `gh api` POST with no explicit method whose body the frozen hasWriteBody does not read
 * (RESEARCH section 1: gh api defaults to POST when a field or --input is present): a field
 * ATTACHED to its flag (`-fevent=APPROVE`, `-Fevent=APPROVE`, via gh-api-attached-field), a field
 * flag bundled behind -i (`-if event=APPROVE`, `-iFevent=APPROVE`, via gh-api-bundled-field, review
 * fix round CR-02), or `--input` (via gh-api-input). argv records these as shortFlags{fevent},
 * shortFlags{i:'f'} or flags.input, so the direct classifier saw no write and returned null. The
 * outer segment is the verdict segment: the gate's fieldCandidates recovers the bare field, and
 * unresolvedVerdictForm already asks on --input.
 *
 * Targets: `.../pulls/<n>/reviews[/...]` -> pr-review; `.../issues/<n>/comments` and
 * `.../pulls/<n>/comments` -> issue-comment / pr-comment, for a field-carried body only (review fix
 * round WR-04: the comment actions are governed by the review-artifact gate alone, and it governs a
 * comment only when its body carries `CLEAR` or the re-review header). An explicit method returns
 * null: a mutating one already classified directly, a GET is a read. Any other target returns null
 * (D1: an attached-field `gh api .../issues -ftitle=x` create stays other, a recorded residual).
 *
 * @param {Object} seg
 * @returns {Object|null}
 */
function recoverRestReviewPost(seg) {
  if (explicitMethod(seg) !== null) return null;
  const action = restRecoveredAction(extractTarget(seg, false));
  if (action === null) return null;
  const tokens = seg.tokens.filter((t) => typeof t === 'string');
  let via = null;
  const field = tokens.map(ghFieldToken).find((f) => f !== null);
  if (field) via = field.bundled ? 'gh-api-bundled-field' : 'gh-api-attached-field';
  else if (action === 'pr-review' && tokens.some((t) => t === '--input' || t.startsWith('--input='))) via = 'gh-api-input';
  if (via === null) return null;
  return { action, route: 'gh-api', recovered: true, via, verdictSegments: [seg] };
}

/**
 * The HTTP method a curl segment names through a BUNDLED `-X` (`-sX POST`, `-sXPOST`), upper-cased,
 * or null when it names none that way (review fix round CR-02; explicitMethod reads the unbundled
 * forms and is frozen, D1).
 *
 * @param {Object} seg
 * @returns {string|null}
 */
function curlBundledMethod(seg) {
  const tokens = Array.isArray(seg.tokens) ? seg.tokens : [];
  for (let i = 0; i < tokens.length; i += 1) {
    const x = curlShortToken(tokens[i], 'X');
    if (!x || !x.bundled) continue;
    const v = x.attached === null ? tokens[i + 1] : x.attached;
    return typeof v === 'string' && v.length > 0 ? v.toUpperCase() : null;
  }
  return null;
}

/**
 * A curl REST POST the direct classifier read as GET because its body or method flag is bundled
 * with curl boolean shorts (`curl -sd '{"event":"APPROVE"}' .../pulls/42/reviews`, `-sSd`,
 * `-sX POST`) (review fix round CR-02 + WR-04). Recovered only when a bundle is present (an
 * unbundled curl write already classified directly) and the URL host is api.github.com; the method
 * is the explicit or bundled `-X`, else POST when a `-d` body is present. Targets as
 * restRecoveredAction: a review (route curl, via curl-bundled-flag) or a PR/issue comment; anything
 * else (a merge, labels, a GET) stays other. The outer segment is the verdict segment.
 *
 * @param {Object} seg
 * @returns {Object|null}
 */
function recoverCurlRestPost(seg) {
  const tokens = Array.isArray(seg.tokens) ? seg.tokens.filter((t) => typeof t === 'string') : [];
  let bundled = false;
  let body = false;
  for (const t of tokens) {
    const d = curlShortToken(t, 'd');
    if (d) {
      body = true;
      if (d.bundled) bundled = true;
    }
    const x = curlShortToken(t, 'X');
    if (x && x.bundled) bundled = true;
  }
  if (!bundled) return null;
  let method = explicitMethod(seg) || curlBundledMethod(seg);
  if (method === null) method = body ? 'POST' : 'GET';
  if (!MUTATING_METHODS.has(method)) return null;
  const url = curlUrl(seg);
  if (!url || hostOf(url) !== 'api.github.com') return null;
  const action = restRecoveredAction(url);
  if (action === null) return null;
  return { action, route: 'curl', recovered: true, via: 'curl-bundled-flag', verdictSegments: [seg] };
}

/**
 * Remove ONE closing `)` of a subshell: the last token when it is `)`, else a `)` attached to the
 * end of the last token (`-a)`).
 *
 * @param {string[]} tokens
 * @returns {string[]}
 */
function withoutClosingParen(tokens) {
  if (tokens.length === 0) return tokens;
  const out = tokens.slice();
  const last = out[out.length - 1];
  if (last === ')') out.pop();
  else if (last.endsWith(')')) out[out.length - 1] = last.slice(0, -1);
  return out;
}

/**
 * The tokens after setsid's options: util-linux setsid options are all boolean (`-c`, `-f`, `-w`,
 * bundles such as `-fw`, and their long forms); `--` ends them (RESEARCH section 6).
 *
 * @param {string[]} after
 * @returns {string[]}
 */
function afterSetsidOptions(after) {
  let i = 0;
  while (i < after.length && after[i].length > 1 && after[i][0] === '-') {
    i += 1;
    if (after[i - 1] === '--') break;
  }
  return after.slice(i);
}

/**
 * The tokens after `time`'s options, for both the bash keyword (`-p`, `--`) and GNU time
 * (RESEARCH section 6): `-f` / `-o` take a value given separately or attached (`-fFMT`, also at
 * the end of a bundle such as `-pf FMT`); `--format` / `--output` (unique prefixes accepted) take
 * the next token unless written with `=`; every other option takes no value; `--` ends options.
 *
 * @param {string[]} after
 * @returns {string[]}
 */
function afterTimeOptions(after) {
  let i = 0;
  while (i < after.length) {
    const t = after[i];
    if (t === '--') {
      i += 1;
      break;
    }
    if (t.startsWith('--') && t.length > 2) {
      const body = t.slice(2);
      const eq = body.indexOf('=');
      const takesNext = eq === -1 && TIME_VALUE_LONG.some((n) => n.startsWith(body));
      i += takesNext ? 2 : 1;
      continue;
    }
    if (t.length > 1 && t[0] === '-') {
      let width = 1;
      for (let k = 1; k < t.length; k += 1) {
        if (t[k] === 'f' || t[k] === 'o') {
          if (k === t.length - 1) width = 2; // the value is the next token
          break; // the rest of the bundle is the value
        }
      }
      i += width;
      continue;
    }
    break;
  }
  return after.slice(i);
}

/**
 * The value class of an xargs long option name: exact match first, else a unique prefix (GNU
 * getopt_long). Null for an unknown or ambiguous name.
 *
 * @param {string} name
 * @returns {'required'|'optional'|'none'|null}
 */
function xargsLongKind(name) {
  if (Object.prototype.hasOwnProperty.call(XARGS_LONG, name)) return XARGS_LONG[name];
  if (name.length === 0) return null;
  const hits = Object.keys(XARGS_LONG).filter((n) => n.startsWith(name));
  return hits.length === 1 ? XARGS_LONG[hits[0]] : null;
}

/**
 * The command argv xargs runs, after its options (RESEARCH section 4): short bundles walk letter
 * by letter until a value letter; a required-value letter takes the rest of the token, else the
 * next token; an optional-value letter takes only the rest of the token; a long option takes the
 * next token only when it is required-value and written without `=`; `--` ends options; the
 * command is the first non-option token. `{ unknown: true }` for an option the table does not
 * know (or an ambiguous long prefix), whose value class, and so the command, cannot be located.
 *
 * @param {string[]} after the tokens after `xargs`
 * @returns {{command:string[]}|{unknown:true}}
 */
function xargsCommand(after) {
  let i = 0;
  while (i < after.length) {
    const t = after[i];
    if (t === '--') {
      i += 1;
      break;
    }
    if (t.startsWith('--') && t.length > 2) {
      const body = t.slice(2);
      const eq = body.indexOf('=');
      const kind = xargsLongKind(eq === -1 ? body : body.slice(0, eq));
      if (kind === null) return { unknown: true };
      i += kind === 'required' && eq === -1 ? 2 : 1;
      continue;
    }
    if (t.length > 1 && t[0] === '-') {
      let width = 1;
      for (let k = 1; k < t.length; k += 1) {
        const c = t[k];
        if (XARGS_SHORT_NO_VALUE.has(c)) continue;
        if (XARGS_SHORT_OPTIONAL.has(c)) break; // its value, if any, is the rest of this token
        if (XARGS_SHORT_REQUIRED.has(c)) {
          if (k === t.length - 1) width = 2; // the value is the next token
          break;
        }
        return { unknown: true };
      }
      i += width;
      continue;
    }
    break;
  }
  return { command: after.slice(i) };
}

/**
 * Recover an xargs-run review verdict (Task 2e): xargs runs its command argv directly, so this is
 * a prefix strip (`peels + 1`), not a payload re-parse. An unknown or ambiguous option is
 * uncertain only when a review hint is visible, else null. Bare `xargs` (no command) is null.
 *
 * @param {string[]} after the tokens after `xargs`
 * @param {{depth:number, peels:number, inShellString:boolean}} state
 * @returns {Object|null}
 */
function recoverXargs(after, state) {
  const parsed = xargsCommand(after);
  if (parsed.unknown === true) return hasReviewHint(after) ? uncertainRoute('xargs-unknown-option') : null;
  return recoverStripped(parsed.command, 'xargs', state);
}

/**
 * Re-classify the tokens left after stripping one transparent prefix (`peels + 1`, same depth,
 * same inShellString). The tokens are rebuilt into a segment with argv's own classifyTokens, so
 * stacked prefixes and WRAPPER_BUILTINS (`sudo nohup`, `nohup sudo`) resolve through the shared
 * resolveProgram. Only an inner pr-review is kept (D1). A bare wrapper returns null.
 *
 * @param {string[]} rest
 * @param {string} via a VERDICT_ROUTE_FORMS code
 * @param {{depth:number, peels:number, inShellString:boolean}} state
 * @returns {Object|null}
 */
function recoverStripped(rest, via, state) {
  if (rest.length === 0) return null;
  // Past the prefix bound (W3): uncertain only with a visible review hint. A prefix hides no token,
  // so a hint-free remainder can reach a verdict only through an expansion-named program, which
  // D7 (B) already scopes to a hint; asking here would add noise with no additional catch.
  if (state.peels >= MAX_PREFIX_PEELS) return hasReviewHint(rest) ? uncertainRoute('prefix-bound') : null;
  const innerSeg = classifyTokens(rest);
  const inner = classifySegment(innerSeg, {
    depth: state.depth,
    peels: state.peels + 1,
    inShellString: state.inShellString,
  });
  return combineRecovered(via, [{ r: inner, seg: innerSeg }]);
}

/**
 * Combine the inner classifications of one recovery level into this level's recovered route.
 * Each item is an inner result `r` and the inner segment `seg` it classified. Only a pr-review is
 * kept (D1). A native inner pr-review makes its segment a verdict segment; a recovered inner
 * contributes its own verdict segments. When no verdict segment is collected, the first inner
 * route with none (an uncertain or unresolved route) passes through unchanged, so it keeps the
 * code that names it; otherwise null. A collection that also holds an uncertain inner keeps its
 * verdict segments and adds `uncertain: true` with `uncertainVia`, so the gate both gates the
 * segments and holds the uncertain ask (Task 2d); likewise an unresolved inner (a file-sourced
 * GraphQL query) adds `unresolved: true` with `unresolvedVia`, and the gate holds the MJ-02 ask
 * (Task 3b).
 *
 * @param {string} via a VERDICT_ROUTE_FORMS code for this level
 * @param {Array<{r:Object|null, seg:Object}>} items
 * @returns {Object|null}
 */
function combineRecovered(via, items) {
  const verdictSegments = [];
  let opaque = null;
  let uncertainVia = null;
  let unresolvedVia = null;
  for (const { r, seg } of items) {
    if (!r || r.action !== 'pr-review') continue; // D1: every other inner result is discarded
    if (r.recovered !== true) {
      verdictSegments.push(seg);
      continue;
    }
    verdictSegments.push(...r.verdictSegments);
    if (r.verdictSegments.length === 0 && opaque === null) opaque = r;
    if (r.uncertain === true && uncertainVia === null) uncertainVia = r.uncertainVia || r.via;
    if (r.unresolved === true && unresolvedVia === null) unresolvedVia = r.unresolvedVia || r.via;
  }
  if (verdictSegments.length === 0) return opaque === null ? null : { ...opaque };
  const out = { action: 'pr-review', route: 'recovered', recovered: true, via, verdictSegments };
  if (uncertainVia !== null) {
    out.uncertain = true;
    out.uncertainVia = uncertainVia;
  }
  if (unresolvedVia !== null) {
    out.unresolved = true;
    out.unresolvedVia = unresolvedVia;
  }
  return out;
}

/**
 * Index of the token that IS the resolved program: the first token whose basename equals `prog`
 * and whose prefix resolves to it (the gsd-test-detect.programIndex rule; that module cannot be
 * required here, it requires this one).
 *
 * @param {string[]} tokens
 * @param {string} prog
 * @returns {number} -1 when not found
 */
function programTokenIndex(tokens, prog) {
  let fallback = -1;
  for (let i = 0; i < tokens.length; i += 1) {
    if (path.basename(tokens[i]) !== prog) continue;
    if (fallback === -1) fallback = i;
    if (resolveProgram({ tokens: tokens.slice(0, i + 1) }).prog === prog) return i;
  }
  return fallback;
}

/**
 * The `-c` command string of a shell invocation, from the tokens AFTER the shell (RESEARCH
 * section 5): a short bundle starting `-` or `+` that contains `c` sets -c (`-lc`, `-ec`, `+c`);
 * each `o` / `O` letter in a bundle consumes the NEXT token as its value; `--rcfile` and
 * `--init-file` consume the next token; other long options take no value; `--` or a lone `-`
 * ends options. With -c set the command string is the first non-option operand (tokens after it
 * are positionals). Returns undefined with no -c (a script file, `bash -s`, a heredoc-fed shell)
 * or with -c and no operand.
 *
 * @param {string[]} after
 * @returns {string|undefined}
 */
function shellCommandString(after) {
  let dashC = false;
  let i = 0;
  while (i < after.length) {
    const t = after[i];
    if (t === '--' || t === '-') {
      i += 1;
      break;
    }
    if ((t[0] === '-' || t[0] === '+') && t.length > 1 && t[1] !== t[0]) {
      const letters = t.slice(1);
      if (letters.includes('c')) dashC = true;
      let consumed = 0;
      for (const letter of letters) {
        if (letter === 'o' || letter === 'O') consumed += 1;
      }
      i += 1 + consumed;
      continue;
    }
    if (t.startsWith('--')) {
      i += t === '--rcfile' || t === '--init-file' ? 2 : 1;
      continue;
    }
    break;
  }
  return dashC ? after[i] : undefined;
}

/**
 * Recover a `bash|sh|dash|zsh|ksh -c STRING` verdict route.
 *
 * @param {Object} seg
 * @param {string} prog
 * @param {{depth:number, peels:number, inShellString:boolean}} state
 * @returns {Object|null}
 */
function recoverShellCommandString(seg, prog, state) {
  const at = programTokenIndex(seg.tokens, prog);
  if (at === -1) return null;
  const payload = shellCommandString(seg.tokens.slice(at + 1));
  if (typeof payload !== 'string') return null;
  return recoverPayload(payload, 'shell-c', state);
}

/**
 * Re-parse a payload (a shell -c command string or an eval argument line) with argv.parseCommand and collect EVERY inner
 * pr-review segment, in order (D3), so a leading `--comment` cannot hide a later approve.
 *
 * @param {string} payload
 * @param {string} via a VERDICT_ROUTE_FORMS code
 * @param {{depth:number, peels:number, inShellString:boolean}} state
 * @returns {Object|null}
 */
function recoverPayload(payload, via, state) {
  // An empty or whitespace payload runs nothing: not a route, and not an unparseable payload.
  if (payload.trim().length === 0) return null;
  const depth = state.depth + 1;
  // Past the depth bound: uncertain with NO review hint (D3 literal).
  if (depth > RECOVERY_MAX_DEPTH) return uncertainRoute('depth-bound');
  const inner = parseCommand(payload);
  // A non-empty payload argv cannot parse: uncertain with no review hint (D3, D7 A).
  if (!inner || inner.ok !== true) return uncertainRoute('unparseable-payload');
  const innerState = { depth, peels: 0, inShellString: true };
  return combineRecovered(
    via,
    inner.segments.map((innerSeg) => ({ r: classifySegment(innerSeg, innerState), seg: innerSeg }))
  );
}

/**
 * ENF-20: map a mutating github MEMBER SUB-RESOURCE to a review-side action.
 *
 * Pre-ENF-20 every member sub-resource returned 'other' (G1) because the only governed
 * surfaces were create (collection POST) and body/title edit (bare-member PATCH). But
 * three sub-resources are the REST synonyms of the most authoritative actions there are:
 *
 *   pulls/{n}/reviews[/{id}/events|/{id}/dismissals]  → pr-review
 *       (POST reviews = submit a review; POST reviews/{id}/events = submit a PENDING
 *        review — the actual approve; PUT reviews/{id}/dismissals = dismiss someone
 *        else's review. All three are the same authority, so all three classify alike.)
 *   pulls/{n}/merge                                    → pr-merge  (PUT canonical, POST accepted)
 *   pulls/{n}/comments                                 → pr-comment (inline review comments)
 *   issues/{n}/comments                                → issue-comment (also the PR
 *        conversation-comment route — see PR_COMMENT_EQUIVALENT_ACTIONS)
 *
 * Returns null for EVERY other sub-resource (labels, assignees, requested_reviewers,
 * …), which preserves the G1 'other' outcome byte-for-byte. The caller has already
 * established the method is mutating and the member id is numeric.
 *
 * @param {{resource:string, subPath?:string[]}} kind classifyGithubPath result (sub form)
 * @param {'gh-api'|'curl'} route
 * @returns {{action:string, route:string}|null}
 */
function classifyReviewSideSubResource(kind, route) {
  const sub = Array.isArray(kind.subPath) ? kind.subPath : [];
  const head = sub[0];
  if (!head) return null;

  if (kind.resource === 'pulls') {
    if (head === 'reviews') return { action: 'pr-review', route };
    // Only the bare `pulls/{n}/merge` endpoint — a deeper path under it is not a merge.
    if (head === 'merge' && sub.length === 1) return { action: 'pr-merge', route };
    if (head === 'comments') return { action: 'pr-comment', route };
    return null;
  }
  if (kind.resource === 'issues') {
    if (head === 'comments') return { action: 'issue-comment', route };
    return null;
  }
  return null;
}

// ENF-20: field/body shapes that mark a bare-member PATCH/PUT as a pure CLOSE rather
// than a body/title edit. Matched against the segment's TOKENS *and* its parsed flag
// values, because gh accepts `-f state=closed`, `--field state=closed`,
// `--raw-field state=closed`, `-F state=closed`, `--field=state=closed` and the bundled
// `-fstate=closed` (whose value only survives in shortFlags), while curl sends a JSON
// body (`-d '{"state":"closed"}'`) or a urlencoded pair. Repeated `-f` flags overwrite
// each other in the parsed flag map, so the TOKEN list is the resilient source and both
// are scanned.
const STATE_CLOSED_FIELD = /^state=closed$/i;
const STATE_CLOSED_JSON = /"state"\s*:\s*"closed"/i;
const TITLE_OR_BODY_FIELD = /^(?:title|body)=/i;
const TITLE_OR_BODY_JSON = /"(?:title|body)"\s*:/i;

// A field given in ATTACHED form carries the flag on the same token, so the bare
// `name=value` shape has to be recovered before matching: `-fstate=closed` (gh's bundled
// short field) and `--field=state=closed` (attached long field). argv records the bundled
// short form as shortFlags{fstate:'closed'} — the `=` split happens before the single-letter
// check — so neither the raw token nor the parsed value is a bare `state=closed`. Stripping
// exactly ONE leading dash+letter (gh/curl field flags are all single-letter: -f -F -d)
// recovers it without swallowing the field name itself.
const ATTACHED_SHORT_FIELD = /^-[A-Za-z](.+)$/;
const ATTACHED_LONG_FIELD = /^--[A-Za-z][A-Za-z0-9-]*=(.+)$/;

/**
 * ENF-20: is this bare-member mutation a PURE close (state→closed with no title/body
 * change)?
 *
 * THE PRECEDENCE RULE — EDIT WINS. `PATCH /repos/{o}/{r}/issues/{n}` with
 * `state=closed` is the REST synonym of `gh issue close`, and it is the ONE input class
 * whose action MOVES in ENF-20 (issue-edit → issue-close). That move has a cost: the
 * gh-edit gate governs exactly {issue-edit, pr-edit}, so anything diverted away from
 * issue-edit stops being edit-gated. To keep the diversion as narrow as the truth
 * allows, a PATCH that ALSO carries a title/body field is still a body/title edit and
 * keeps classifying as issue-edit — gh-edit keeps firing on it, unchanged. Only a PATCH
 * whose sole substantive effect is the state change becomes issue-close.
 *
 * `state=open` (a reopen) is NOT a close and returns false — reopening is out of the
 * five actions T1 adds.
 *
 * @param {Object} seg structured segment from argv.parseCommand
 * @returns {boolean}
 */
function isPureStateClose(seg) {
  const candidates = [];
  const add = (v) => {
    if (typeof v !== 'string' || v.length === 0) return;
    candidates.push(v);
    // Also consider the ATTACHED-form field recovered from the token.
    const short = ATTACHED_SHORT_FIELD.exec(v);
    if (short) candidates.push(short[1]);
    const long = ATTACHED_LONG_FIELD.exec(v);
    if (long) candidates.push(long[1]);
  };
  if (Array.isArray(seg.tokens)) seg.tokens.forEach(add);
  for (const v of Object.values(seg.flags || {})) add(v);
  for (const v of Object.values(seg.shortFlags || {})) add(v);

  let sawClose = false;
  for (const c of candidates) {
    if (TITLE_OR_BODY_FIELD.test(c) || TITLE_OR_BODY_JSON.test(c)) {
      return false; // an edit is present → EDIT WINS, stay issue-edit
    }
    if (STATE_CLOSED_FIELD.test(c) || STATE_CLOSED_JSON.test(c)) sawClose = true;
  }
  return sawClose;
}

/**
 * Shared REST-synonym classifier for `gh api` and `curl`. Determines whether the
 * call is a mutating request to a github issues|pulls endpoint and maps it to the
 * concrete create/edit action — or fails closed if it is mutating-to-github but
 * unmappable.
 *
 * @param {Object} seg
 * @param {'gh-api'|'curl'} route
 * @param {boolean} isCurl
 * @returns {{action:string, route?:string, failClosed?:boolean}|null}
 */
function classifyRestSegment(seg, route, isCurl) {
  const target = extractTarget(seg, isCurl);

  // For curl, an out-of-scope host is simply 'other' (we only gate github).
  if (isCurl) {
    if (!target) return null;
    const host = hostOf(target);
    if (!host || !GITHUB_API_HOSTS.has(host)) return null;
  }

  let method = explicitMethod(seg);
  if (!method && hasWriteBody(seg)) {
    method = 'POST'; // -d (curl) / -f (gh api) imply a POST when unspecified
  }

  // No mutating method ⇒ read-only ⇒ other (allow). This includes explicit GET.
  if (!method || !MUTATING_METHODS.has(method)) {
    return null;
  }

  // Mutating request. It must target a github issues|pulls endpoint to be in scope.
  const kind = classifyGithubPath(target || '');

  if (!kind) {
    // Mutating call to a github API host but the path is not a clean issues|pulls
    // endpoint we can map. For curl we already know host is github. For gh api the
    // host is implicitly github. This is the EP-1 fail-closed case: an unclassifiable
    // mutating synonym MUST deny, never fall through to allow.
    if (isMutatingGithub(seg, target, isCurl)) {
      return FAIL_CLOSED;
    }
    return null;
  }

  // Member sub-resource. ENF-20 first tries the REVIEW-SIDE map (reviews / merge /
  // comments — the adjudicating synonyms); everything else (labels / assignees /
  // requested_reviewers / …) is benign metadata that stays 'other', never failClosed (G1).
  if (kind.sub) {
    const reviewSide = classifyReviewSideSubResource(kind, route);
    if (reviewSide) return reviewSide;
    return null;
  }

  const isPatchOrPut = method === 'PATCH' || method === 'PUT';
  if (kind.resource === 'issues') {
    // ENF-20: a bare-member PATCH/PUT whose only substantive field is state=closed is
    // the REST synonym of `gh issue close`. EDIT WINS when title/body is also present
    // (see isPureStateClose) so gh-edit's coverage is not narrowed beyond the truth.
    if (kind.member && isPatchOrPut && isPureStateClose(seg)) {
      return { action: 'issue-close', route };
    }
    if (kind.member && isPatchOrPut) return { action: 'issue-edit', route };
    if (!kind.member && method === 'POST') return { action: 'issue-create', route };
    return FAIL_CLOSED; // mutating-but-mismatched (e.g. POST to member) → deny
  }
  // pulls
  if (kind.member && isPatchOrPut) return { action: 'pr-edit', route };
  if (!kind.member && method === 'POST') return { action: 'pr-create', route };
  return FAIL_CLOSED;
}

/**
 * Whether a segment is a mutating request to a github issues|pulls path (used to
 * decide if an unmappable target should fail closed vs. be ignored). For gh api,
 * any target containing issues|pulls under repos counts. For curl the host check
 * happened upstream.
 *
 * @param {Object} seg
 * @param {string|null} target
 * @param {boolean} isCurl
 * @returns {boolean}
 */
function isMutatingGithub(seg, target, isCurl) {
  const t = target || '';
  const touchesIssuesOrPulls = /(^|\/)(issues|pulls)(\/|$)/.test(t);
  if (isCurl) {
    // host already confirmed github upstream
    return touchesIssuesOrPulls;
  }
  // gh api → implicitly github; require the path to reference issues|pulls so we
  // do not fail-closed on unrelated mutating gh api calls (e.g. labels), which are
  // out of THIS gate's scope and should pass through as 'other'.
  return touchesIssuesOrPulls;
}

/**
 * Extract the host from a URL-ish string. Returns lowercase host or null.
 *
 * @param {string} url
 * @returns {string|null}
 */
function hostOf(url) {
  if (typeof url !== 'string') return null;
  const schemeIdx = url.indexOf('://');
  let rest = schemeIdx === -1 ? url : url.slice(schemeIdx + 3);
  // host ends at first / ? # or end
  rest = rest.split('/')[0].split('?')[0].split('#')[0];
  // strip userinfo and port
  const at = rest.indexOf('@');
  if (at !== -1) rest = rest.slice(at + 1);
  const colon = rest.indexOf(':');
  if (colon !== -1) rest = rest.slice(0, colon);
  return rest.length > 0 ? rest.toLowerCase() : null;
}

/**
 * Classify a parsed command (output of argv.parseCommand) into an action.
 *
 * @param {Object} parsed result of parseCommand
 * @returns {{action:string, route?:string, failClosed?:boolean}}
 *   - native: { action:'issue-create'|'pr-create'|'issue-edit'|'pr-edit'|'commit'|'push', route?:'native' }
 *   - synonym: same action with route:'gh-api'|'curl'
 *   - unclassifiable mutating github synonym OR failed parse: { action:'unknown', failClosed:true }
 *   - everything else (read-only / unrelated): { action:'other' }
 */
function classifyAction(parsed) {
  // Fail-closed on a missing or failed-parse input — the parser already decided
  // it could not be trusted, so the classifier must deny, not guess.
  if (!parsed || typeof parsed !== 'object' || parsed.ok !== true) {
    return { ...FAIL_CLOSED };
  }

  const segments = Array.isArray(parsed.segments) && parsed.segments.length > 0
    ? parsed.segments
    : [parsed];

  // ENF-20 / ENF-22 / 261006-jsm FOUR-PASS AGGREGATION - the mechanism that makes the six legacy
  // actions' classification byte-identical BY CONSTRUCTION rather than by luck.
  //
  // classifyAction returns ONE result for a whole chain, and six wired gates read that
  // single result directly (issue-dedupe, freshness, git-commit-convention,
  // policy-invariants, lint-ci-marker, protocol-artifact). Before ENF-20 the only
  // actionable results were the six legacy actions + failClosed, so a chain always
  // collapsed to its FIRST legacy-actionable segment. If a new review-side action could
  // win that aggregation, then `gh issue comment … && gh issue create …` would collapse
  // to 'issue-comment' and issue-dedupe / protocol-artifact would ALLOW a create they
  // deny today: the classifier extension would have MANUFACTURED A BYPASS in six gates.
  //
  // So: PASS 1 considers only failClosed + LEGACY_MUTATION_ACTIONS — reproducing the old
  // result exactly whenever one exists. PASS 2 returns a review-side action only when
  // pass 1 found nothing, i.e. exactly where the old code returned 'other'. Pass 2's
  // results are therefore a strict subset of the old 'other' outcomes: no pre-existing
  // classification can change.
  //
  // ENF-22 ADDS PASS 3, AND THE REASON IS THE SAME HAZARD ONE TIER DOWN. PASS 2 used to
  // return the first non-null result of ANY kind. The new `merge` action is non-null, so
  // under the old shape `git merge x && gh pr merge 1` would collapse to 'merge' — and
  // review-artifact, which governs {pr-review, pr-merge, pr-comment, issue-comment}, would
  // short-circuit to allow on a PR MERGE it blocks today. That is the identical
  // MANUFACTURED-A-BYPASS failure described above, so it gets the identical structural
  // answer: PASS 2 is NARROWED to an explicit REVIEW_SIDE_ACTIONS test, and PASS 3 returns
  // the first remaining non-null result (today: only MERGE_SIDE_ACTIONS).
  //
  // BYTE-IDENTITY ARGUMENT for the narrowing (the same argument ENF-20 used for PASS 1/2):
  // every non-null classifySegment result that exists today is in LEGACY_MUTATION_ACTIONS
  // ∪ REVIEW_SIDE_ACTIONS ∪ {FAIL_CLOSED}. PASS 1 already claims the legacy and failClosed
  // members, so every result PASS 2 could previously have returned is review-side —
  // restricting it to REVIEW_SIDE_ACTIONS changes NOTHING that exists. PASS 3 is therefore
  // reachable only where the old code returned 'other', which makes `merge` a strict
  // subset of the old 'other' outcomes exactly as review-side was.
  //
  // CONSEQUENCE FOR CALLERS (T3 / ENF-22): a gate governing a review-side OR merge action
  // must trigger on hasGovernedSegment(parsed, ['pr-merge']) / (parsed, ['merge']) — the
  // CF-05 all-segments chokepoint — NOT on classifyAction(parsed).action, which by design
  // still reports the legacy action for a chain like `gh pr merge … && git push` or
  // `git merge … && git push`.
  //
  // 261006-jsm ADDS PASS 4 FOR RECOVERED VERDICT ROUTES (CONTEXT D1, D2). classifySegment runs
  // recoverVerdictRoute ONLY where its direct logic returned null, and a recovered result is
  // ONLY ever action 'pr-review' with `recovered: true` (a `gh pr review` hidden inside a wrapper
  // such as `bash -c "..."`). PASS 1, 2 and 3 skip every recovered result, and PASS 4 returns the
  // first one. BYTE-IDENTITY ARGUMENT: a recovered result exists only for a segment that was null
  // before this change, so PASS 1-3 see exactly the non-null results they saw before, and PASS 4
  // is reachable only where the old aggregate was 'other'. Without the PASS 2 skip,
  // `bash -c "gh pr review 1 -a" && gh pr merge 1` would collapse to the recovered pr-review
  // (pr-review IS review-side) instead of the pr-merge it classifies as today: the same
  // displacement hazard ENF-22 closed one tier down.
  const results = [];
  for (const seg of segments) {
    results.push(classifySegment(seg));
  }

  // PASS 1 — legacy actions + failClosed (byte-identical to pre-ENF-20 behaviour).
  for (const res of results) {
    if (res === null || res.recovered === true) continue;
    if (res.failClosed === true || LEGACY_MUTATION_ACTIONS.has(res.action)) {
      return { ...res };
    }
  }

  // PASS 2 — review-side actions (ENF-20). Only reachable where the pre-ENF-20 code
  // returned 'other', so this can never displace an existing classification. The explicit
  // REVIEW_SIDE_ACTIONS test (ENF-22) is what stops a merge segment from winning here and
  // disarming review-artifact; do NOT relax it back to "first non-null of any kind".
  for (const res of results) {
    if (res === null || res.recovered === true) continue;
    if (REVIEW_SIDE_ACTIONS.has(res.action)) {
      return { ...res };
    }
  }

  // PASS 3 — everything else actionable (ENF-22: `merge`). Reachable only when no legacy,
  // failClosed, or review-side segment exists — i.e. exactly where the pre-ENF-22 code
  // returned 'other'.
  for (const res of results) {
    if (res === null || res.recovered === true) continue;
    return { ...res };
  }

  // PASS 4 - recovered verdict routes (261006-jsm). Reachable only when PASS 1-3 found nothing,
  // i.e. exactly where the pre-261006-jsm code returned 'other'.
  for (const res of results) {
    if (res !== null && res.recovered === true) {
      return { ...res };
    }
  }

  // No segment classified as actionable ⇒ read-only / unrelated ⇒ other (allow).
  return { ...OTHER };
}

/**
 * IN-03: the single shared, ACTION-PARAMETERIZED segment finder (hoisted from the 4
 * gates that previously each hardcoded their own target action). Returns the first
 * segment in a chain that classifyAction maps to `targetAction`, else segs[0] (the
 * original fallback). The previously-divergent matched-action is now the `targetAction`
 * parameter, so each caller passes its own ('pr-create' / 'issue-create' / 'commit')
 * and selection stays byte-preserved.
 *
 * @param {Object} parsed argv.parseCommand result (ok:true)
 * @param {string} targetAction the action the caller is gating ('pr-create' | 'issue-create' | 'commit' | …)
 * @returns {Object} the matching segment, or segs[0] when none matches
 */
function findActionSegment(parsed, targetAction) {
  const segs = Array.isArray(parsed.segments) && parsed.segments.length > 0
    ? parsed.segments
    : [parsed];
  for (const seg of segs) {
    const r = classifyAction({ ok: true, segments: [seg] });
    if (r && r.action === targetAction) return seg;
  }
  return segs[0];
}

/**
 * CF-05: the PURE any-governed-segment predicate — the multi-segment analog of CHD-02's
 * all-segments detectGit. classifyAction returns only the FIRST actionable segment, so a
 * chain like `git commit -m x && git push` collapses to `commit` and a governed push in a
 * LATER segment escapes any first-segment trigger. hasGovernedSegment instead scans EVERY
 * segment and returns true the moment ANY segment classifies to one of governedActions.
 *
 * This is the shared chokepoint both push-governing gates trigger on (scan-gate's ENF-09
 * scans, lint-ci-marker's ENF-05/17 marker + test:affected) and the narrows-not-weakens
 * basis for isNonGovernedCommand: allow-short-circuit ONLY when NO segment is governed.
 *
 * Declared as a hoisted function so isNonGovernedCommand (defined below) can call it
 * regardless of source order. PURE: reads only argv/classify (no filesystem).
 *
 * @param {Object} parsed result of argv.parseCommand
 * @param {string[]|Set<string>} governedActions action names this gate governs
 * @returns {boolean} true iff ANY chained segment classifies to a governed action;
 *   false for a non-ok / absent parse or a chain with no governed segment.
 */
function hasGovernedSegment(parsed, governedActions) {
  // A non-ok / absent parse is not "governed" here — the caller's own fail-closed path
  // (HARD-04) owns the unparseable case; this predicate only reports governed presence.
  if (!parsed || typeof parsed !== 'object' || parsed.ok !== true) {
    return false;
  }

  // Normalize governedActions to a Set for O(1) membership (mirror isNonGovernedCommand).
  const governed = governedActions instanceof Set
    ? governedActions
    : new Set(Array.isArray(governedActions) ? governedActions : []);

  // Same segment fan-out shape as findActionSegment: classify each segment in isolation
  // (single-segment parse) and report the first governed hit.
  const segs = Array.isArray(parsed.segments) && parsed.segments.length > 0
    ? parsed.segments
    : [parsed];
  for (const seg of segs) {
    const r = classifyAction({ ok: true, segments: [seg] });
    if (r && governed.has(r.action)) return true;
  }
  return false;
}

/**
 * CF-07 (← CR-01): the PURE any-failClosed-segment predicate — the ENF-15 analog of
 * hasGovernedSegment. classifyAction returns only the FIRST actionable segment, so a
 * failClosed synonym (an unclassifiable mutating github call) placed AFTER a benign
 * actionable segment (`gh pr create <valid> && gh api -X POST repos/.../issues/weird`)
 * is masked from a gate's `if (action.failClosed)` guard and slips ENF-15.
 * hasFailClosedSegment instead scans EVERY segment and returns true the moment ANY
 * segment classifies failClosed — so the create/edit gates run it FIRST (before the
 * governed check, D-03) and a failClosed segment ANYWHERE in the chain still fails
 * closed regardless of position.
 *
 * This NEVER introduces a new allow — it only REPORTS failClosed presence; the caller
 * owns the throw. A non-ok / absent parse is not "failClosed" here — the caller's own
 * !parsed.ok fail-closed path (HARD-04) owns the unparseable case.
 *
 * Declared as a hoisted function so callers can reference it regardless of source order.
 * PURE: reads only argv/classify (no filesystem).
 *
 * @param {Object} parsed result of argv.parseCommand
 * @returns {boolean} true iff ANY chained segment classifies failClosed; false for a
 *   non-ok / absent parse or a chain with no failClosed segment.
 */
function hasFailClosedSegment(parsed) {
  // A non-ok / absent parse is not "failClosed" here — the caller's own fail-closed path
  // (HARD-04) owns the unparseable case; this predicate only reports failClosed presence.
  if (!parsed || typeof parsed !== 'object' || parsed.ok !== true) {
    return false;
  }

  // Same segment fan-out shape as hasGovernedSegment / findActionSegment: classify each
  // segment in isolation (single-segment parse) and report the first failClosed hit.
  const segs = Array.isArray(parsed.segments) && parsed.segments.length > 0
    ? parsed.segments
    : [parsed];
  for (const seg of segs) {
    const r = classifyAction({ ok: true, segments: [seg] });
    if (r && r.failClosed === true) return true;
  }
  return false;
}

/**
 * RES-01: the single-source, PURE action-first guard. Tells a Bash gate whether a
 * command is CONFIDENTLY a non-governed action, so the gate may short-circuit to
 * allow() BEFORE it ever resolves/requires its LIVE policy script (which narrows the
 * fail-closed blast radius: a missing LIVE script can no longer collateral-deny an
 * unrelated `ls`/`grep`/`git status`).
 *
 * Returns `true` ONLY when ALL of these hold:
 *   1. `parsed && parsed.ok === true`      — a confident parse (HARD-04: !ok → false)
 *   2. `classifyAction(parsed).failClosed !== true` — not an unclassifiable mutating
 *      github synonym (ENF-15: failClosed → false)
 *   3. NO chained segment is governed (CF-05: `hasGovernedSegment(parsed, governedActions)`
 *      is false — a governed action anywhere in the chain, even hidden after a benign
 *      first segment like `git commit`, keeps the caller on its resolve→gate path)
 *
 * In EVERY other case it returns `false`, so the caller falls through to its existing
 * resolve→requireLiveScript→gate path — preserving HARD-04, ENF-15, and HARD-02
 * (governed action + missing LIVE script → still DENY).
 *
 * PURE: reads only argv/classify (no fs / no path resolve / no require of a script).
 * This purity is exactly what lets a gate run it BEFORE any filesystem resolve (D-01).
 * Does NOT mutate classifyAction.
 *
 * @param {Object} parsed          result of argv.parseCommand
 * @param {string[]|Set<string>} governedActions action names this gate governs
 *   (array or Set — e.g. ['issue-create'] or new Set(['issue-edit','pr-edit']))
 * @returns {boolean} true iff the command is confidently non-governed (safe to allow)
 */
function isNonGovernedCommand(parsed, governedActions) {
  // 1. Confident parse only — an unparseable/failed parse must fall through to the
  //    caller's fail-closed path (HARD-04), never be treated as "non-governed".
  if (!parsed || typeof parsed !== 'object' || parsed.ok !== true) {
    return false;
  }

  // 2. Classify the action (pure parse→classify, no filesystem). A failClosed result
  //    (unclassifiable mutating github synonym) must fall through too (ENF-15).
  const action = classifyAction(parsed);
  if (!action || action.failClosed === true) {
    return false;
  }

  // 3. Governed action ANYWHERE in the chain → do NOT short-circuit (HARD-02: let it
  //    resolve + require the LIVE script + deny on missing). CF-05: hasGovernedSegment
  //    scans ALL segments, so a governed push hidden after a benign `git commit` no longer
  //    collapses to a non-governed first segment. This is strictly MORE conservative than
  //    the prior first-segment `!governed.has(action.action)` (a subset of its `true`
  //    results), so it can never introduce a NEW allow — narrows-not-weakens is preserved
  //    for every caller (the four RES-01 create gates + the two push gates).
  return !hasGovernedSegment(parsed, governedActions);
}

module.exports = {
  classifyAction,
  findActionSegment,
  isNonGovernedCommand,
  // CF-05: exported so the push-governing gates (scan-gate, lint-ci-marker) trigger on ANY
  // governed segment in a chain — `git commit && git push` reaches the push logic.
  hasGovernedSegment,
  // CF-07: exported so the create/edit gates (gh-pr-create, gh-edit, gh-issue-create) scan
  // ALL segments for a failClosed synonym (ENF-15) — a trailing `gh api -X POST .../weird`
  // after a benign actionable segment still fails closed regardless of position (D-03).
  hasFailClosedSegment,
  // exported for cross-gate reuse (CF-04): containment.detectGit normalizes each
  // segment's program via resolveProgram so wrapped git (`sudo/command/env git`)
  // resolves to `git` — do NOT re-implement wrapper stripping in the gate.
  resolveProgram,
  // ENF-20: the action vocabulary, exported so a gate declares its governed set by
  // NAME rather than re-typing string literals, and so the legacy/review-side split
  // (which classifyAction's two-pass aggregation depends on) is assertable in tests.
  LEGACY_MUTATION_ACTIONS,
  REVIEW_SIDE_ACTIONS,
  // ENF-22: the merge-side (third-tier) vocabulary, exported on the same convention so
  // git-commit-convention.cjs declares its governed merge action by NAME, and so the
  // three-way disjointness the aggregation depends on stays assertable in tests.
  MERGE_SIDE_ACTIONS,
  // ENF-20: a gate governing PR comments MUST govern BOTH names — GitHub posts PR
  // conversation comments to the ISSUES endpoint and the numbering namespace is shared,
  // so `gh api POST /issues/<pr#>/comments` is otherwise a one-line bypass.
  PR_COMMENT_EQUIVALENT_ACTIONS,
  // exported for unit-level reuse / testing
  classifyGithubPath,
  hostOf,
  // 261006-jsm: the verdict-route recovery bounds and the fixed form descriptions the
  // review-artifact gate names in its messages.
  RECOVERY_MAX_DEPTH,
  MAX_PREFIX_PEELS,
  VERDICT_ROUTE_FORMS,
  // 261006-jsm Task 2d: the D7 (A) switch and the review-hint predicate that scopes the asks.
  OPAQUE_SHELL_PAYLOAD_NEEDS_HINT,
  hasReviewHint,
  // 261006-jsm Task 3b: the GraphQL review-mutation reader the review-artifact gate uses to read
  // a mutation's event.
  graphqlReviewMutation,
  // 261006-jsm review fix round CR-02: the bundle-aware gh field and curl short-flag token readers
  // the review-artifact gate's fieldCandidates and unresolvedVerdictForm share (one rule, no drift).
  ghFieldToken,
  curlShortToken,
};
