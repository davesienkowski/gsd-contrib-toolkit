'use strict';

/**
 * hooks/lib/hardened-git.cjs - the hardened git lookup for hook probes (quick 261119-szk fix round 4, option B;
 * REVIEW-R3 CR-01, CR-02, IN-01).
 *
 * One place that decides WHICH git a hook spawns and WITH WHAT environment, so a repository a hook reads from
 * cannot choose the executable or make git run a program:
 *   - gitCandidates / GIT_CANDIDATES / resolveGitPath / fixedGit: git is spawned only by an absolute path from a
 *     fixed list (never a PATH or cwd lookup; none on win32, where callers then do not spawn and fail open).
 *   - probeEnvChanges / withHardenedProbeEnv: core.fsmonitor=false and safe.bareRepository=explicit injected
 *     through the environment config, GIT_ALLOW_PROTOCOL naming no transport, GIT_NO_LAZY_FETCH=1, and PATH set
 *     to the fixed git's own directory.
 * Used by hooks/emitted-cjs-read.cjs. binlib-edit's own Write|Edit probe does NOT use it yet (a deferred Tier A
 * follow-up adopts it); this module changes nothing about binlib-edit.
 *
 * Pure apart from the stat/access calls in resolveGitPath and the process.env swap in withHardenedProbeEnv
 * (restored in a finally block).
 *
 * @module hooks/lib/hardened-git
 */

const fs = require('node:fs');
const path = require('node:path');

/**
 * Git config injected through the environment for every probe spawn (command-line scope, so a repository's
 * own config cannot override it). core.fsmonitor=false stops a repository-configured fsmonitor command;
 * safe.bareRepository=explicit stops git from adopting a committed bare-shaped directory as the repository
 * (SECURITY-REVIEW HIGH-01, quick 261119-szk). Measured on git 2.43: each one alone stops the planted command.
 */
const INJECTED_GIT_CONFIG = Object.freeze([
  ['core.fsmonitor', 'false'],
  ['safe.bareRepository', 'explicit'],
]);

/**
 * The fixed git executables the probe may spawn (fix round 4, option B; REVIEW-R3 CR-01, IN-01). git is never
 * looked up through PATH or the cwd: libuv searches the spawn cwd (the Read target's bin/lib) before PATH for a bare
 * name on native Windows (src/win/process.c search_path, source-read), and a PATH entry can point into the checkout.
 * POSIX: root-owned system locations plus Homebrew's prefix on Apple silicon. win32: none, so the guard never spawns
 * git there and never denies (fail open; not measured on Windows).
 *
 * @param {string} platform a process.platform value
 * @returns {string[]}
 */
function gitCandidates(platform) {
  if (platform === 'win32') return [];
  return ['/usr/bin/git', '/usr/local/bin/git', '/bin/git', '/opt/homebrew/bin/git'];
}

const GIT_CANDIDATES = Object.freeze(gitCandidates(process.platform));

/**
 * The first candidate that is an absolute path to a regular file with an execute bit (following a symlink, as the
 * system git often is one), else null. Nothing here reads PATH, the cwd or any env value.
 *
 * @param {string[]} candidates
 * @returns {string|null}
 */
function resolveGitPath(candidates) {
  for (const c of candidates) {
    if (typeof c !== 'string' || !path.isAbsolute(c)) continue;
    try {
      if (!fs.statSync(c).isFile()) continue;
      fs.accessSync(c, fs.constants.X_OK);
      return c;
    } catch (_) {
      /* absent or not executable: try the next */
    }
  }
  return null;
}

/** The resolved fixed git for this hook process (one process serves one Read), memoized on first use. */
let resolvedGit;
function fixedGit() {
  if (resolvedGit === undefined) resolvedGit = resolveGitPath(GIT_CANDIDATES);
  return resolvedGit;
}

/** A GIT_ALLOW_PROTOCOL value that matches no transport, so git never fetches (REVIEW-R3 CR-02). */
const NO_PROTOCOL = 'emitted-cjs-read-none';

/**
 * The env changes for one probe: the injected config appended after any inherited GIT_CONFIG_COUNT entries
 * (a count that is not a plain non-negative integer is replaced; git rejects such a count anyway); no transport
 * and no lazy fetch (REVIEW-R3 CR-02: a partial clone missing a skip-worktree .gitignore blob otherwise fetches
 * and runs a repository-configured uploadpack or sshCommand; GIT_ALLOW_PROTOCOL names no protocol, which holds on
 * any git and outranks a repository protocol.<t>.allow, and GIT_NO_LAZY_FETCH=1 covers git builds with the
 * CVE-2024-32465 fix); and, when gitPath is given, PATH set to exactly the fixed git's directory, so no inherited
 * PATH entry (one pointing into the checkout, an empty or relative one) reaches a program git looks up. git still
 * prepends its exec path (GIT_EXEC_PATH when inherited), which is outside a checkout's control (PLAN-REVIEW-R4
 * N-01). Round 4; it replaces the round-3 absolute-entry filter.
 *
 * @param {Object} env
 * @param {string} [gitPath] the absolute fixed git
 * @returns {Object} key -> new value
 */
function probeEnvChanges(env, gitPath) {
  const changes = {};
  const raw = env.GIT_CONFIG_COUNT;
  let n = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : 0;
  for (const [key, value] of INJECTED_GIT_CONFIG) {
    changes['GIT_CONFIG_KEY_' + n] = key;
    changes['GIT_CONFIG_VALUE_' + n] = value;
    n += 1;
  }
  changes.GIT_CONFIG_COUNT = String(n);
  // GIT_CONFIG_PARAMETERS (what `git -c` exports to child processes) is read after the COUNT entries, so an
  // inherited `core.fsmonitor=<cmd>` there would win; the injected pairs are appended to it as well, and the
  // last occurrence wins inside it (PLAN-REVIEW-R2 W-01). A malformed inherited value makes git refuse to run,
  // which is a silent pass.
  const inheritedParams = typeof env.GIT_CONFIG_PARAMETERS === 'string' ? env.GIT_CONFIG_PARAMETERS.trim() : '';
  const injectedParams = INJECTED_GIT_CONFIG.map(([key, value]) => "'" + key + '=' + value + "'").join(' ');
  changes.GIT_CONFIG_PARAMETERS = inheritedParams ? inheritedParams + ' ' + injectedParams : injectedParams;
  changes.GIT_ALLOW_PROTOCOL = NO_PROTOCOL;
  changes.GIT_NO_LAZY_FETCH = '1';
  if (typeof gitPath === 'string' && path.isAbsolute(gitPath)) changes.PATH = path.dirname(gitPath);
  return changes;
}

/**
 * Run fn with probeEnvChanges applied to process.env, restoring every changed key afterwards (binlib-edit's
 * probe reads process.env through its probeEnv, so this is how the hardening reaches its spawns without
 * editing binlib-edit). fn is synchronous.
 *
 * @param {() => *} fn
 * @param {string} [gitPath] the absolute fixed git (sets the probe PATH to its directory)
 * @returns {*}
 */
function withHardenedProbeEnv(fn, gitPath) {
  const changes = probeEnvChanges(process.env, gitPath);
  const saved = {};
  for (const k of Object.keys(changes)) {
    saved[k] = Object.prototype.hasOwnProperty.call(process.env, k) ? process.env[k] : undefined;
    process.env[k] = changes[k];
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

module.exports = {
  INJECTED_GIT_CONFIG,
  NO_PROTOCOL,
  GIT_CANDIDATES,
  gitCandidates,
  resolveGitPath,
  fixedGit,
  probeEnvChanges,
  withHardenedProbeEnv,
};
