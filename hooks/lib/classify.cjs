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
 * Pure: no I/O, no process.env.
 *
 * @module hooks/lib/classify
 */

const path = require('node:path'); // CR-03: basename-normalize the program
require('./argv.cjs'); // contract dependency (parseCommand output shape)

const MUTATING_METHODS = new Set(['POST', 'PATCH', 'PUT']);
const GITHUB_API_HOSTS = new Set(['api.github.com']);

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
  // These are benign metadata mutations — NOT a create (collection POST) and NOT a
  // body/title edit (bare-member PATCH). Governing covers create + body/title only,
  // so a sub-resource mutation is out of this gate's scope and must pass through as
  // 'other' rather than fail closed (G1). The numeric-member check above keeps
  // genuinely-unmappable paths (non-numeric member) failing closed.
  return { resource, member: true, sub: true };
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
 * Classify a single parsed segment. Returns a result object or null when the
 * segment is not itself a recognized action (caller treats null as 'other').
 *
 * @param {Object} seg
 * @returns {{action:string, route?:string, failClosed?:boolean}|null}
 */
function classifySegment(seg) {
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

  // Member sub-resource (labels / assignees / requested_reviewers / …): benign
  // metadata, out of this gate's scope (create + body/title edit only). Allow as
  // 'other' — never fail closed (G1).
  if (kind.sub) return null;

  const isPatchOrPut = method === 'PATCH' || method === 'PUT';
  if (kind.resource === 'issues') {
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

  for (const seg of segments) {
    const res = classifySegment(seg);
    if (res === null) {
      // A non-actionable segment (read-only / unrelated) — keep scanning the chain.
      continue;
    }
    // Any actionable (or fail-closed) segment classifies the whole command — a
    // mutation hidden in a chain must not be diluted by a benign neighbor.
    return { ...res };
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
  // exported for cross-gate reuse (CF-04): containment.detectGit normalizes each
  // segment's program via resolveProgram so wrapped git (`sudo/command/env git`)
  // resolves to `git` — do NOT re-implement wrapper stripping in the gate.
  resolveProgram,
  // exported for unit-level reuse / testing
  classifyGithubPath,
  hostOf,
};
