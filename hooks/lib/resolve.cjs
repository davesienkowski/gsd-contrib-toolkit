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
const path = require('node:path');

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
 * Does this directory have the gsd-core sentinel layout (scripts/ + gsd-core/bin/lib/)?
 * @param {string} dir
 * @returns {boolean}
 */
function hasSentinel(dir) {
  try {
    return (
      fs.statSync(path.join(dir, 'scripts')).isDirectory() &&
      fs.statSync(path.join(dir, 'gsd-core', 'bin', 'lib')).isDirectory()
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
};
