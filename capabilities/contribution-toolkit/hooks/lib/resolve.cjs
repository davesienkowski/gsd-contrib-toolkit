'use strict';

/**
 * hooks/lib/resolve.cjs — the live-script resolver (HARD-02 resolver half).
 *
 * The whole anti-bypass thesis depends on the gates calling gsd-core's LIVE policy
 * scripts — NEVER a vendored reimplementation. A reimplemented copy silently drifts from
 * upstream policy (stale policy = false confidence); calling the live script means a
 * gsd-core refactor that changes a script's shape surfaces as a fail-closed DENY (via
 * runGate's catch — HARD-01), not a silent miss.
 *
 *   resolveGsdCoreRoot(startDir)  → walk up from startDir to the first ancestor that has
 *                                   BOTH `scripts/` and `gsd-core/bin/lib/` (the gsd-core
 *                                   sentinel layout). Returns that absolute path, or
 *                                   throws ScriptResolveError.
 *   requireLiveScript(root, rel)  → require() the live module at <root>/<rel>; ANY failure
 *                                   (missing file, require-time throw) → ScriptResolveError
 *                                   carrying the attempted path + root, so the doctor
 *                                   (03-06) can report it and runGate can fail closed.
 *
 * There is deliberately NO fallback to a bundled/vendored script: a missing live script
 * is an ERROR that fails closed, never a silent local reimplementation (HARD-02).
 *
 * @module hooks/lib/resolve
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseCommand } = require('./argv.cjs');

/**
 * A typed error so runGate's catch fails closed and the doctor (03-06) can pattern-match
 * it. Carries the attempted path + resolved root for diagnostics.
 */
class ScriptResolveError extends Error {
  /**
   * @param {string} message
   * @param {{root?: string, attemptedPath?: string, cause?: Error}} [details]
   */
  constructor(message, details = {}) {
    super(message);
    this.name = 'ScriptResolveError';
    this.root = details.root;
    this.attemptedPath = details.attemptedPath;
    if (details.cause) this.cause = details.cause;
  }
}

/**
 * LIVE gsd-core policy-script BASENAMES that positively identify a real gsd-core checkout
 * (RES-02). The `~/.claude` runtime INSTALL root also carries `scripts/` +
 * `gsd-core/bin/lib/` (the install creates both), so those two directory checks alone
 * false-match it as a checkout — every Bash command run from under `~/.claude` then
 * false-resolves there. This identity set adds a third, positive signal: at least ONE of
 * these live policy scripts must exist under `<dir>/scripts/`.
 *
 * Re-declared locally rather than imported from `hooks/lib/sandbox.cjs` SANDBOX_SCRIPTS —
 * sandbox.cjs requires resolve.cjs, so importing back here would create a require cycle.
 *
 * This is a DISJUNCTION (see hasSentinel: `.some`, not `.every`) — load-bearing per D-05:
 * keying on ANY-one-of-many, not the single script a given gate happens to need, means an
 * upstream rename of one script does NOT false-negative a real checkout. A real checkout
 * missing one identity script still resolves as a checkout, so its governed action still
 * reaches requireLiveScript and still fails closed there (HARD-02 preserved, not weakened).
 */
const GSD_CORE_IDENTITY_SCRIPTS = Object.freeze([
  'issue-version-gate.cjs',
  'pr-target-policy.cjs',
  'pr-template-policy.cjs',
  'issue-dedupe.cjs',
]);

/**
 * Does this directory have the gsd-core sentinel layout (scripts/ + gsd-core/bin/lib/ +
 * at least one live gsd-core policy script under scripts/ — the RES-02 identity signal)?
 *
 * Pure and cheap: fs.existsSync/statSync only, never require()s a resolved script — the
 * identity probe must not execute anything during sentinel detection (see the threat
 * register's Tampering disposition).
 *
 * @param {string} dir
 * @returns {boolean}
 */
function hasSentinel(dir) {
  try {
    return (
      fs.statSync(path.join(dir, 'scripts')).isDirectory() &&
      fs.statSync(path.join(dir, 'gsd-core', 'bin', 'lib')).isDirectory() &&
      GSD_CORE_IDENTITY_SCRIPTS.some((basename) =>
        fs.existsSync(path.join(dir, 'scripts', basename))
      )
    );
  } catch (_) {
    return false;
  }
}

/**
 * Resolve the gsd-core repo root by walking parent directories from `startDir` until the
 * sentinel layout is found.
 *
 * @param {string} [startDir] defaults to process.cwd() (the hook's cwd at call site).
 * @returns {string} absolute path to the gsd-core root.
 * @throws {ScriptResolveError} when no ancestor has the sentinel layout.
 */
function resolveGsdCoreRoot(startDir) {
  let dir;
  try {
    dir = path.resolve(startDir == null ? process.cwd() : String(startDir));
  } catch (err) {
    throw new ScriptResolveError('resolveGsdCoreRoot: invalid startDir', { cause: err });
  }

  // Walk up to the filesystem root.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (hasSentinel(dir)) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }

  throw new ScriptResolveError(
    'resolveGsdCoreRoot: no gsd-core sentinel layout (scripts/ + gsd-core/bin/lib/) found from ' +
      (startDir == null ? process.cwd() : String(startDir)),
    { attemptedPath: startDir == null ? process.cwd() : String(startDir) }
  );
}

/**
 * Expand a leading `~` / `~/...` to the user's home directory. The shell expands
 * `~` before exec, but a parsed positional retains the literal `~`, so the resolver
 * must expand it too.
 * @param {string} p
 * @returns {string}
 */
function expandHome(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * Derive the effective working directory a parsed command runs in, by walking its
 * `cd <dir>` segments left-to-right from `baseCwd`.
 *
 * A PreToolUse hook's process.cwd() is the SESSION's cwd, not the worktree a
 * `cd <worktree> && git ...` command actually targets. Resolving the gsd-core root
 * from process.cwd() therefore inspects the wrong tree (e.g. lints the session repo
 * instead of the worktree being committed). Following the command's own `cd` lands
 * the resolver on the tree the git/gh/npm invocation will run in.
 *
 * @param {{ok?:boolean, segments?:Array}} parsed result of parseCommand(command)
 * @param {string} [baseCwd] defaults to process.cwd()
 * @returns {string} absolute effective cwd
 */
function commandStartDir(parsed, baseCwd) {
  let cwd = path.resolve(baseCwd == null ? process.cwd() : String(baseCwd));
  if (!parsed || parsed.ok !== true || !Array.isArray(parsed.segments)) return cwd;
  for (const seg of parsed.segments) {
    if (!seg || seg.program !== 'cd') continue;
    // `cd <dir>` — take the first non-flag argument. Prefer the classified
    // positional; fall back to the raw second token for robustness.
    const target =
      (Array.isArray(seg.positionals) && seg.positionals[0]) ||
      (Array.isArray(seg.tokens) && seg.tokens[1]) ||
      '';
    if (target) cwd = path.resolve(cwd, expandHome(String(target)));
  }
  return cwd;
}

/**
 * Resolve the gsd-core root a raw command will actually run in, or null if that cwd is
 * not a gsd-core checkout.
 *
 * Combines the command's effective cwd (commandStartDir — follows `cd`) with the sentinel
 * walk (resolveGsdCoreRoot). Returns null on a clean "no gsd-core here" miss
 * (ScriptResolveError) so a gate can ALLOW commands that don't target gsd-core (a commit
 * in another repo is not a gsd-core contribution). Any other error propagates.
 *
 * @param {string} command raw tool_input.command
 * @param {string} [baseCwd] the hook's process.cwd()
 * @returns {string|null} absolute gsd-core root, or null if the command's cwd is not one
 */
function resolveRootForCommand(command, baseCwd) {
  try {
    return resolveGsdCoreRoot(commandStartDir(parseCommand(command), baseCwd));
  } catch (err) {
    if (err instanceof ScriptResolveError) return null;
    throw err;
  }
}

// The UPSTREAM repo every contribution gate governs. A personal fork (`dave/gsd-core-fork`,
// `dave/gsd-core`) is NOT this target — only owner===open-gsd AND repo===gsd-core.
const GSD_CORE_OWNER = 'open-gsd';
const GSD_CORE_REPO = 'gsd-core';

// A GitHub-safe owner/repo segment: alnum, dot, dash, underscore. Anything else
// (a stray `:`, whitespace, a second path separator that survived normalization) means
// the input did NOT resolve to an enumerated owner/repo → null (fail-closed signal).
const OWNER_REPO_SEG = /^[A-Za-z0-9._-]+$/;

/**
 * parseOwnerRepo — the SINGLE owner/repo normalizer (CHD-01, WR-03: fix the class, not the
 * instance). It DELIBERATELY ENUMERATES the accepted input forms (Postel-inversion, binding
 * [Postel + Leaky Abstractions]): a containment-boundary parser must fail CLOSED on a form
 * it does not recognize — never silently treat an un-enumerated target as a non-match.
 *
 * Enumerated forms:
 *   - `gh:owner/repo`                       (gh CLI shorthand scheme → host github.com)
 *   - `https://host[:port]/owner/repo[.git]`  (http/https, optional user@, optional :port)
 *   - `ssh://git@host[:port]/owner/repo[.git]` (any scheme:// form, user@ + host stripped)
 *   - `git@host:owner/repo[.git]`           (scp-style ssh; host before the `:`)
 *   - `host/owner/repo` or bare `owner/repo`  (LAST two path segments are owner/repo)
 *   - GH_HOST-qualified enterprise hosts (`ghe.example.com/...`) — host retained.
 *
 * Returns `{ owner, repo, host }` with owner/repo/host LOWER-cased (GitHub routes
 * owner/repo case-insensitively — CR-01), or `null` when the input does not resolve to an
 * enumerated form / >=2 path segments / GitHub-safe owner+repo. Pure (string in,
 * object|null out); operates on already-structured argv values (HARD-04-safe — never a
 * raw-command regex).
 *
 * @param {*} urlOrSpec
 * @returns {{owner:string, repo:string, host:string}|null}
 */
function parseOwnerRepo(urlOrSpec) {
  if (typeof urlOrSpec !== 'string') return null;
  const raw = urlOrSpec.trim();
  if (raw.length === 0) return null;

  let host = null;
  let rest = raw;

  if (/^gh:/i.test(rest)) {
    // gh CLI shorthand `gh:owner/repo` → github.com.
    host = 'github.com';
    rest = rest.slice(3);
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(rest)) {
    // scheme:// form (https, http, ssh, git, …): strip scheme, optional user@, then the
    // host[:port] up to the first slash.
    rest = rest.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
    rest = rest.replace(/^[^@/]+@/, ''); // strip user@ (before any path slash)
    const slash = rest.indexOf('/');
    if (slash === -1) return null; // host with no path → not an owner/repo
    host = rest.slice(0, slash).replace(/:\d+$/, '').toLowerCase(); // strip :port
    rest = rest.slice(slash + 1);
  } else if (/^[^@/\s]+@[^@:/\s]+:/.test(rest)) {
    // scp-style ssh `git@host:owner/repo` → host is between `@` and `:`.
    rest = rest.replace(/^[^@]+@/, ''); // strip user@
    const colon = rest.indexOf(':');
    host = rest.slice(0, colon).replace(/:\d+$/, '').toLowerCase();
    rest = rest.slice(colon + 1);
  }
  // else: bare `owner/repo` or `host/owner/repo` — host stays the github.com default.

  rest = rest.replace(/^\/+/, '').replace(/\.git$/i, '');
  const segs = rest.split('/').filter((x) => x.length > 0);
  if (segs.length < 2) return null;
  const owner = segs[segs.length - 2];
  const repo = segs[segs.length - 1];
  if (!OWNER_REPO_SEG.test(owner) || !OWNER_REPO_SEG.test(repo)) return null;
  return {
    owner: owner.toLowerCase(),
    repo: repo.toLowerCase(),
    host: (host || 'github.com').toLowerCase(),
  };
}

/**
 * Does an explicit `-R/--repo` VALUE name the upstream open-gsd/gsd-core repo? Routes
 * through the unified parseOwnerRepo normalizer (CR-01 case-fold) — so a fork
 * (`dave/gsd-core-fork`) or a wrong-owner same-name repo (`dave/gsd-core`) does NOT match,
 * but a case-variant `Open-GSD/GSD-Core` DOES.
 *
 * @param {*} value the flag value (only strings can match)
 * @returns {boolean}
 */
function repoSpecTargetsGsdCore(value) {
  const r = parseOwnerRepo(value);
  return !!r && r.owner === GSD_CORE_OWNER && r.repo === GSD_CORE_REPO;
}

/**
 * Does a single token name the upstream gsd-core repo via a REST path — a gh-api path
 * positional (`repos/open-gsd/gsd-core/...`) or a curl URL token
 * (`https://api.github.com[:port]/repos/open-gsd/gsd-core/...`)? The token is normalized
 * (scheme + `api.github.com` host WITH an optional `:port` — closing the `:443` slip —
 * + leading slash stripped); the leading `repos/` prefix is REQUIRED (a non-`repos/` path
 * does not match), and the FIRST two segments after it are resolved via parseOwnerRepo so
 * only the upstream owner/repo pair counts (case-folded).
 *
 * @param {*} token
 * @returns {boolean}
 */
function tokenTargetsGsdCoreApi(token) {
  if (typeof token !== 'string' || token.length === 0) return false;
  let s = token.trim();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, ''); // strip scheme
  s = s.replace(/^api\.github\.com(?::\d+)?/i, ''); // strip REST host + optional :port (close :443 slip)
  s = s.replace(/^\/+/, ''); // strip leading slashes
  const m = /^repos\/(.+)$/i.exec(s); // the `repos/` prefix is required
  if (!m) return false;
  const after = m[1].split('/').filter((x) => x.length > 0);
  if (after.length < 2) return false;
  const r = parseOwnerRepo(after[0] + '/' + after[1]); // owner/repo are the FIRST two segments after repos/
  return !!r && r.owner === GSD_CORE_OWNER && r.repo === GSD_CORE_REPO;
}

/**
 * Pure discriminator: does a PARSED command explicitly target the UPSTREAM
 * open-gsd/gsd-core repo, regardless of the command's cwd?
 *
 * This is the ROB-01 seam used by the gh gates: an out-of-tree command (one whose
 * effective cwd resolves to no gsd-core sentinel, so resolveRootForCommand → null)
 * passes through (ALLOW) ONLY when it does NOT target upstream gsd-core. A command that
 * DOES target it (via `-R/--repo open-gsd/gsd-core`, a gh-api `repos/open-gsd/gsd-core`
 * path, or a curl `api.github.com/repos/open-gsd/gsd-core` URL) is a real contribution
 * action the toolkit cannot verify without a local checkout → the caller fails it closed
 * (HARD-02 — never reach for a possibly-stale runtime root).
 *
 * Reads STRUCTURED argv only (parsed.segments flags/shortFlags/tokens) — never a
 * raw-string re-parse (HARD-04). It is THREE-way (binding [Postel + Leaky Abstractions]):
 *   - NO repo-spec intent (no -R/--repo, no GH_REPO token, no upstream api/curl token)
 *     → false (ROB-01 passthrough preserved — a clearly-non-upstream command passes through).
 *   - an explicit repo-spec (flags.repo / shortFlags.R / a leading GH_REPO=… env token)
 *     that parses as open-gsd/gsd-core, OR a gh-api/curl `repos/open-gsd/gsd-core` token
 *     → true (targeting → DENY).
 *   - an explicit repo-spec that parseOwnerRepo CANNOT resolve (GitHub-ish but unparseable)
 *     → true (fail-closed targeting — an un-enumerated explicit target is a containment
 *     bypass, never a silent non-upstream ALLOW; the Postel-inversion).
 *   - an explicit repo-spec that parses as a clearly-non-upstream fork → that source is NOT
 *     targeting (a fork must still passthrough — no false-deny).
 *
 * The GH_REPO/GH_HOST env target is read from the LEADING `NAME=VALUE` tokens argv keeps in
 * seg.tokens (CR-02): argv normalizes a leading env-assignment OUT of seg.program but RETAINS
 * it as a leading seg.tokens entry — so an ordinary `--flag=value` or a post-program
 * `-f title=x` field is never mistaken for an env assignment.
 *
 * @param {{ok?:boolean, segments?:Array}} parsed result of parseCommand(command)
 * @returns {boolean}
 */
function commandTargetsGsdCore(parsed) {
  if (!parsed || parsed.ok !== true || !Array.isArray(parsed.segments)) return false;
  for (const seg of parsed.segments) {
    if (!seg) continue;
    const flags = seg.flags || {};
    const shortFlags = seg.shortFlags || {};
    const tokens = Array.isArray(seg.tokens) ? seg.tokens : [];

    // Collect every EXPLICIT repo-spec source for this segment:
    //   gh native --repo <v> / --repo=<v> / -R <v> / -R<v>, and a leading GH_REPO=… env token.
    const explicitSpecs = [];
    if (typeof flags.repo === 'string') explicitSpecs.push(flags.repo);
    if (typeof shortFlags.R === 'string') explicitSpecs.push(shortFlags.R);

    // Scan the LEADING run of `NAME=VALUE` env-assignment tokens (they precede the program
    // per argv's normalization). Stop at the first non-assignment token (the program) so a
    // post-program `title=x` / `--flag=value` is never read as an env assignment.
    for (const tok of tokens) {
      if (typeof tok !== 'string') break;
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(tok);
      if (!m) break; // first non-assignment token = the program → stop scanning
      if (m[1] === 'GH_REPO') explicitSpecs.push(m[2]);
      // GH_HOST is recognized as part of the env-target shape but the gate keys on
      // owner/repo (host is advisory), so its value does not itself drive classification.
    }

    // Three-way over each explicit repo-spec source.
    for (const spec of explicitSpecs) {
      const r = parseOwnerRepo(spec);
      if (r) {
        if (r.owner === GSD_CORE_OWNER && r.repo === GSD_CORE_REPO) return true; // upstream → DENY
        // else: parses as a clearly-non-upstream fork → not targeting via this source (continue).
      } else {
        // explicit spec present but unparseable (GitHub-ish but unparseable) → fail-closed.
        return true;
      }
    }

    // gh-api path positional / curl api.github.com URL token (upstream match).
    for (const tok of tokens) {
      if (tokenTargetsGsdCoreApi(tok)) return true;
    }
  }
  return false;
}

/**
 * require() a LIVE gsd-core script by its path relative to the gsd-core root.
 *
 * NEVER falls back to a vendored copy: a missing or broken live script throws a typed
 * ScriptResolveError so the caller (runGate) fails closed (HARD-01) and the doctor can
 * report exactly what was attempted (HARD-02 / H-E shape check).
 *
 * @param {string} root absolute gsd-core root (from resolveGsdCoreRoot).
 * @param {string} relPath e.g. 'scripts/pr-target-policy.cjs'.
 * @returns {object} the live module's exports.
 * @throws {ScriptResolveError} on a missing file or a require-time throw.
 */
function requireLiveScript(root, relPath) {
  if (typeof root !== 'string' || root.length === 0) {
    throw new ScriptResolveError('requireLiveScript: root is required', { root, attemptedPath: relPath });
  }
  if (typeof relPath !== 'string' || relPath.length === 0) {
    throw new ScriptResolveError('requireLiveScript: relPath is required', { root, attemptedPath: relPath });
  }

  const abs = path.resolve(root, relPath);

  // Existence check first → a missing live script is an explicit, diagnosable error
  // (NOT a MODULE_NOT_FOUND that could be confused with a dependency miss, and NEVER a
  // silent vendored fallback).
  if (!fs.existsSync(abs)) {
    throw new ScriptResolveError(
      'requireLiveScript: live script not found (no vendored fallback — fail closed): ' + abs,
      { root, attemptedPath: abs }
    );
  }

  try {
    // Bust any require cache entry so a hot-swapped live script is re-read each gate run
    // (the doctor and gates want the CURRENT live shape, not a stale cached copy).
    delete require.cache[abs];
    return require(abs);
  } catch (err) {
    throw new ScriptResolveError(
      'requireLiveScript: live script failed to load: ' + abs + ' (' + (err && err.message) + ')',
      { root, attemptedPath: abs, cause: err }
    );
  }
}

module.exports = {
  ScriptResolveError,
  resolveGsdCoreRoot,
  requireLiveScript,
  hasSentinel,
  GSD_CORE_IDENTITY_SCRIPTS,
  commandStartDir,
  expandHome,
  resolveRootForCommand,
  commandTargetsGsdCore,
  // ENF-21: exported so `runtime-stamp.cjs` builds the upstream `ls-remote` URL from the SAME
  // owner/repo every gate already adjudicates against, rather than introducing a second source of
  // truth for "which repo is upstream". They were module-private until 260730-0ov.
  GSD_CORE_OWNER,
  GSD_CORE_REPO,
  parseOwnerRepo,
  repoSpecTargetsGsdCore,
  tokenTargetsGsdCoreApi,
};
