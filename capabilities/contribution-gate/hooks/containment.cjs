#!/usr/bin/env node
'use strict';

/**
 * hooks/containment.cjs — PreToolUse(Bash) containment-safety gate, BOTH halves
 * (ENF-06 containment A + ENF-07 containment B / HARD-01 fail-closed / HARD-04 robust-parse).
 *
 * The PROJECT containment constraint: nothing private (the toolkit, `.planning/`) ever leaks
 * INTO the gsd-core repo or UP to the upstream `open-gsd/gsd-core`. `origin` in the gsd-core
 * checkout IS https://github.com/open-gsd/gsd-core.git, so a push to it from a
 * non-contribution branch is exactly the leak to prevent. Two surfaced safety hooks:
 *
 *   A (ENF-06): on `git add` / `git commit` in gsd-core, DENY if any path being staged is a
 *               `.planning/` path or a toolkit artifact (settings.snippet.json, install.sh,
 *               hooks/, README/skills/commands from the toolkit). These have no business in
 *               the gsd-core tree.
 *   B (ENF-07): on `git push`, DENY if the target remote resolves to upstream
 *               `open-gsd/gsd-core` AND the current branch is not a contribution branch
 *               (`^(fix|docs|feat)/`). Even a contribution branch pushed to the UPSTREAM
 *               origin is denied — contribution goes via a FORK per the PROJECT privacy
 *               constraint; the reason directs the push to the fork.
 *
 * This is the toolkit-OWNED containment check: no LIVE gsd-core script governs "is this path
 * a toolkit artifact" or "is this remote upstream", so the logic lives here (documented as
 * ours, H-A). It uses git INDEX / REMOTE reads (execFileSync, no shell) — never re-parsing
 * the raw command string for paths (HARD-04: we read the structured argv + the git index).
 *
 * Architecture (inherited from Waves 1-2):
 *   - argv.parseCommand   → robust parse, fail-closed on unparseable (HARD-04)
 *   - resolve.resolveGsdCoreRoot → the worktree whose index/remotes we inspect
 *   - failclosed.runGate  → an unreadable remote / git failure DENIES (HARD-01); a real
 *                           containment hit is a normal deny; only a logged override allows
 *
 * @module hooks/containment
 */

const { parseCommand } = require('./lib/argv.cjs');
const { runGate, readHookInput, deny, allow, emit, FailClosed, safeCommand } = require('./lib/failclosed.cjs');
const { resolveGsdCoreRoot, commandStartDir, ScriptResolveError } = require('./lib/resolve.cjs');

// FailClosed/safeCommand: shared IN-03 helpers from failclosed.cjs.

/**
 * Toolkit-artifact / .planning patterns (containment A). A staged path matching ANY of these
 * has no business in the gsd-core tree. Anchored to path segments so a legitimate gsd-core
 * file that merely CONTAINS one of these words is not over-matched.
 */
const TOOLKIT_PATTERNS = Object.freeze([
  /(^|\/)\.planning(\/|$)/, // the planning dir anywhere in the path
  /(^|\/)settings\.snippet\.json$/, // the hooks settings snippet
  /(^|\/)install\.sh$/, // the toolkit installer
  /(^|\/)hooks\/[^/]+\.cjs$/, // toolkit hook scripts (bin/lib/*.cjs is gsd-core's own — excluded below)
  /(^|\/)\.gsd-contrib(\/|$)/, // the per-worktree override-receipt dir
]);

/**
 * gsd-core's OWN generated files live under `gsd-core/bin/lib/*.cjs`; do not let the broad
 * `hooks/*.cjs` toolkit pattern misfire on a path like `gsd-core/bin/lib/x.cjs` (it would
 * not match `hooks/` anyway, but guard explicitly against a `.../hooks/` inside gsd-core that
 * is legitimately gsd-core's — there is none today, but keep the predicate honest).
 */
const GSD_CORE_OWN = Object.freeze([
  /(^|\/)gsd-core\/bin\/lib\//,
]);

/**
 * Is this staged path a toolkit / .planning artifact that must NOT enter gsd-core (ENF-06)?
 *
 * @param {string} p repo-relative path
 * @returns {boolean}
 */
function isToolkitArtifact(p) {
  if (typeof p !== 'string' || p.length === 0) return false;
  if (GSD_CORE_OWN.some((re) => re.test(p))) return false;
  return TOOLKIT_PATTERNS.some((re) => re.test(p));
}

/**
 * Does this remote URL point at the UPSTREAM open-gsd/gsd-core (ENF-07)? Recognizes both
 * https and ssh forms; the owner MUST be `open-gsd` and the repo `gsd-core` — a personal
 * fork (`dave/gsd-core-fork`, `dave/gsd-core`) is NOT upstream.
 *
 * @param {string} url
 * @returns {boolean}
 */
function isUpstreamRemote(url) {
  if (typeof url !== 'string' || url.length === 0) return false;
  // Normalize: strip scheme/user, unify ':' (ssh) and '/' separators after the host.
  let s = url.trim();
  s = s.replace(/^[a-z]+:\/\//i, ''); // https:// , ssh://
  s = s.replace(/^[^@]+@/, ''); // git@
  // Now host[:/]owner/repo(.git)? — split host from the path on the first ':' or '/'.
  const m = /^([^:/]+)[:/](.+)$/.exec(s);
  if (!m) return false;
  let pathPart = m[2].replace(/\.git$/i, '');
  const segs = pathPart.split('/').filter((x) => x.length > 0);
  if (segs.length < 2) return false;
  const owner = segs[segs.length - 2];
  const repo = segs[segs.length - 1];
  return owner === 'open-gsd' && repo === 'gsd-core';
}

/**
 * Is `branch` a contribution branch (`^(fix|docs|feat)/…`)? Anything else (main, master,
 * arbitrary) is not.
 *
 * @param {string} branch
 * @returns {boolean}
 */
function isContributionBranch(branch) {
  if (typeof branch !== 'string') return false;
  return /^(fix|docs|feat)\//.test(branch.trim());
}

/**
 * Detect the git action + its relevant args from a parsed segment. argv records the
 * non-dash args after the subcommand as further `subcommands` entries, so for `git push
 * origin main` → subcommands = ['push','origin','main']; for `git add .planning/x sdk/y` →
 * ['add','.planning/x','sdk/y'].
 *
 * @param {Object} parsed argv.parseCommand result (ok:true)
 * @returns {{kind:'add'|'commit'|'push'|'other', args:string[]}}
 */
function detectGit(parsed) {
  const segs = Array.isArray(parsed.segments) && parsed.segments.length > 0
    ? parsed.segments
    : [parsed];
  for (const seg of segs) {
    if (seg.program !== 'git') continue;
    const sub = seg.subcommands || [];
    const verb = sub[0];
    if (verb === 'add') return { kind: 'add', args: sub.slice(1), seg };
    if (verb === 'commit') return { kind: 'commit', args: sub.slice(1), seg };
    if (verb === 'push') return { kind: 'push', args: sub.slice(1), seg };
  }
  return { kind: 'other', args: [], seg: segs[0] };
}

/**
 * The explicit path positionals of a `git add` (the non-flag subcommand tail). A bare
 * `git add .` / `git add -A` / `git add -u` has no specific path → return [] so the caller
 * falls back to the cached set.
 *
 * @param {string[]} args the subcommand tail after `add`
 * @returns {string[]} explicit path operands (excluding `.`/flags/pathspec-magic)
 */
function explicitAddPaths(args) {
  const paths = [];
  for (const a of args || []) {
    if (typeof a !== 'string' || a.length === 0) continue;
    if (a.startsWith('-')) continue; // a flag (argv puts flags in seg.flags, but be safe)
    if (a === '.') continue; // "everything" → fall back to the cached set
    paths.push(a);
  }
  return paths;
}

/**
 * Default LIVE staged/cached path reader: `git diff --cached --name-only` in the gsd-core
 * worktree (execFileSync, no shell). THROWS → fail closed (HARD-01).
 *
 * @param {string} root
 * @returns {string[]}
 */
function stagedPathsLive(root) {
  const { execFileSync } = require('node:child_process');
  let out;
  try {
    out = execFileSync('git', ['diff', '--cached', '--name-only'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
  } catch (err) {
    throw new FailClosed(
      'could not read the staged file list in the gsd-core worktree (' +
        ((err && err.message) || 'git failure') + ') — failing closed (HARD-01)'
    );
  }
  return out.split('\n').map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * Default LIVE remote-URL resolver: `git remote get-url <remote>` (execFileSync, no shell).
 * THROWS → fail closed (HARD-01).
 *
 * @param {string} root
 * @param {string} remote
 * @returns {string}
 */
function remoteUrlLive(root, remote) {
  const { execFileSync } = require('node:child_process');
  try {
    return execFileSync('git', ['remote', 'get-url', remote], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    }).trim();
  } catch (err) {
    throw new FailClosed(
      'could not resolve the remote URL for `' + remote + '` (' +
        ((err && err.message) || 'git failure') + ') — failing closed (HARD-01)'
    );
  }
}

/**
 * Default LIVE current-branch resolver: `git rev-parse --abbrev-ref HEAD` (no shell).
 * THROWS → fail closed (HARD-01).
 *
 * @param {string} root
 * @returns {string}
 */
function currentBranchLive(root) {
  const { execFileSync } = require('node:child_process');
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    }).trim();
  } catch (err) {
    throw new FailClosed(
      'could not resolve the current branch (' + ((err && err.message) || 'git failure') +
        ') — failing closed (HARD-01)'
    );
  }
}

/**
 * git push options that consume a SEPARATE following token as their value. We must
 * skip that value when locating the <repository> positional. Everything else —
 * crucially `-u` / `--set-upstream`, plus `-f`/`--force`, `--tags`, `--all`,
 * `--delete`/`-d`, `--force-with-lease` (boolean or `=`-attached) — is boolean here.
 */
const PUSH_VALUE_FLAGS = Object.freeze(
  new Set(['--repo', '-o', '--push-option', '--receive-pack', '--exec'])
);

/**
 * The remote a `git push` targets: the first positional (the <repository>) after
 * `push`, else `origin`.
 *
 * Reads the RAW segment tokens, NOT the generic argv classification: argv treats a
 * lone short flag like `-u` as taking the next token as its value, so `git push -u
 * origin main` would swallow `origin` as `-u`'s "value" and leave the remote absent
 * from the subcommand tail — causing a fork push to be mis-checked against `origin`
 * (ENF-07 false deny). git push's `-u`/`--set-upstream` is boolean, so we scan the
 * push tail ourselves, skipping only the small set of options that truly take a
 * separate-token value (G2).
 *
 * @param {Object} seg argv segment for the `git push …` command (must expose tokens)
 * @returns {string}
 */
function pushRemote(seg) {
  const tokens = seg && Array.isArray(seg.tokens) ? seg.tokens : [];
  const pushIdx = tokens.indexOf('push');
  if (pushIdx === -1) return 'origin';

  for (let i = pushIdx + 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (typeof t !== 'string' || t.length === 0) continue;
    if (t.startsWith('-') && t !== '-') {
      // `--flag=value` carries its own value; a bare value-flag consumes the next
      // token. Either way the value is NOT the remote, so skip accordingly.
      const base = t.split('=')[0];
      if (!t.includes('=') && PUSH_VALUE_FLAGS.has(base)) i += 1;
      continue;
    }
    return t; // first non-flag token after `push` = <repository>
  }
  return 'origin';
}

/**
 * The pure gate decision with all impure deps injected.
 *
 * @param {string} stdinString raw PreToolUse JSON
 * @param {Object} deps
 * @param {string} deps.gsdCoreRoot worktree root
 * @param {(root:string)=>string[]} deps.stagedPaths cached-set reader (A fallback)
 * @param {(root:string, remote:string)=>string} deps.remoteUrl remote URL resolver (B)
 * @param {(root:string)=>string} deps.currentBranch branch resolver (B)
 * @returns {{permissionDecision:string, permissionDecisionReason?:string}}
 */
function gate(stdinString, deps) {
  const input = readHookInput(stdinString);
  const command = (input.tool_input && input.tool_input.command) || '';

  const parsed = parseCommand(command);
  if (!parsed.ok) throw new FailClosed('unparseable command: ' + parsed.reason);

  const git = detectGit(parsed);
  if (git.kind === 'other') return allow(); // not add/commit/push → no-op

  // ---- Containment A: git add / git commit ----
  if (git.kind === 'add' || git.kind === 'commit') {
    let paths;
    if (git.kind === 'add') {
      const explicit = explicitAddPaths(git.args);
      // Explicit path operands are evaluated directly; a bare `git add .`/`-A`/`-u` has no
      // operand → fall back to what would actually be staged (the cached set).
      paths = explicit.length > 0 ? explicit : deps.stagedPaths(deps.gsdCoreRoot);
    } else {
      // bare commit → the cached set is what is about to be committed.
      paths = deps.stagedPaths(deps.gsdCoreRoot);
    }
    const offenders = (paths || []).filter(isToolkitArtifact);
    if (offenders.length > 0) {
      return deny(
        'Containment breach blocked (ENF-06): these toolkit / `.planning` artifacts must ' +
          'NOT enter the gsd-core repo:\n' +
          offenders.map((p) => '  - ' + p).join('\n') + '\n' +
          'They belong in the private gsd-contrib-toolkit repo only. Unstage them ' +
          '(`git restore --staged <path>`) before committing.'
      );
    }
    return allow();
  }

  // ---- Containment B: git push ----
  const remote = pushRemote(git.seg);
  const url = deps.remoteUrl(deps.gsdCoreRoot, remote); // may throw → fail closed
  if (!isUpstreamRemote(url)) {
    return allow(); // pushing to a fork / non-upstream remote is fine
  }
  // Target IS upstream open-gsd/gsd-core. Per PROJECT privacy, contribution goes via a FORK,
  // so ANY direct push to the upstream origin is denied — even from a contribution branch.
  const branch = deps.currentBranch(deps.gsdCoreRoot); // may throw → fail closed
  const branchNote = isContributionBranch(branch)
    ? 'Even though `' + branch + '` is a contribution branch, contribution goes via a FORK — '
    : 'Branch `' + branch + '` is not a contribution branch, and ';
  return deny(
    'Containment breach blocked (ENF-07): `' + remote + '` resolves to the UPSTREAM ' +
      'open-gsd/gsd-core. ' + branchNote + 'pushing private work to upstream leaks it. ' +
      'Push to your FORK remote instead (e.g. `git push fork ' + branch + '`), then open a ' +
      'PR from the fork. Override with GSD_CONTRIB_OVERRIDE="<reason>" only if you are a ' +
      'maintainer deliberately pushing upstream (logged).'
  );
}

/**
 * Injectable entry seam. Builds runGate ctx and defaults the gsd-core root + the live git
 * index / remote readers from the real environment when not injected.
 *
 * @param {string} stdinString raw PreToolUse JSON
 * @param {Object} [deps]
 * @returns {{permissionDecision:string, permissionDecisionReason?:string}}
 */
function runContainmentGate(stdinString, deps = {}) {
  const ctx = {
    command: safeCommand(stdinString),
    action: 'containment',
    worktreeRoot: deps.worktreeRoot,
    overrideImpl: deps.overrideImpl,
  };

  return runGate(() => {
    const resolved = Object.assign({}, deps);
    if (!resolved.gsdCoreRoot) {
      try {
        resolved.gsdCoreRoot = resolveGsdCoreRoot(commandStartDir(parseCommand(ctx.command), process.cwd()));
      } catch (err) {
        // Not a gsd-core checkout (e.g. a commit in another repo) → not this gate's
        // concern; allow. A broken gsd-core checkout still fails closed downstream.
        if (err instanceof ScriptResolveError) return allow();
        throw err;
      }
    }
    ctx.worktreeRoot = ctx.worktreeRoot || resolved.gsdCoreRoot;
    if (!resolved.stagedPaths) resolved.stagedPaths = stagedPathsLive;
    if (!resolved.remoteUrl) resolved.remoteUrl = remoteUrlLive;
    if (!resolved.currentBranch) resolved.currentBranch = currentBranchLive;
    return gate(stdinString, resolved);
  }, ctx);
}


function main() {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => {
    buf += c;
  });
  process.stdin.on('end', () => {
    emit(runContainmentGate(buf));
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  runContainmentGate,
  gate,
  isToolkitArtifact,
  isUpstreamRemote,
  isContributionBranch,
  detectGit,
  pushRemote,
  explicitAddPaths,
  stagedPathsLive,
  remoteUrlLive,
  currentBranchLive,
};
