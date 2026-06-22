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

require('./argv.cjs'); // contract dependency (parseCommand output shape)

const MUTATING_METHODS = new Set(['POST', 'PATCH', 'PUT']);
const GITHUB_API_HOSTS = new Set(['api.github.com']);

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
  return (
    'data' in flags ||
    'field' in flags ||
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
  const program = seg.program;
  const sub = seg.subcommands || [];

  // ---- git ----
  if (program === 'git') {
    if (sub[0] === 'commit') return { action: 'commit' };
    if (sub[0] === 'push') return { action: 'push' };
    return null; // git status, git add, … → other
  }

  // ---- gh ----
  if (program === 'gh') {
    const area = sub[0]; // issue | pr | api | repo | …
    const verb = sub[1]; // create | edit | view | …

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

    return null; // gh repo view, gh auth status … → other
  }

  // ---- curl ----
  if (program === 'curl') {
    return classifyRestSegment(seg, 'curl', true);
  }

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

module.exports = {
  classifyAction,
  // exported for unit-level reuse / testing
  classifyGithubPath,
  hostOf,
};
