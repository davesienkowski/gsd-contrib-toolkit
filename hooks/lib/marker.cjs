'use strict';

/**
 * hooks/lib/marker.cjs — the shared tree-SHA `lint:ci`-green marker CONTRACT (ENF-05).
 *
 * This is the single source of truth that BOTH halves of the ENF-05 mechanism import so
 * they cannot disagree:
 *
 *   - the WRITER  (bin/lint-ci-stamp.cjs) — runs `npm run lint:ci`, and on exit 0 stamps a
 *                                           marker keyed to the current `git write-tree` SHA.
 *   - the READER  (the Wave-2 gate, plan 04-02) — re-derives the SHA and asserts the marker
 *                                           exists (and the tree is clean) before allowing a push/PR.
 *
 * Keying the marker to `git write-tree` means ANY tree change yields a DIFFERENT marker
 * path — a stale marker can never vouch for new content (T-04-01-FORGE). The marker path is
 * always resolved via `git rev-parse --git-path` so linked worktrees get their OWN git dir
 * — NEVER a hardcoded `.git/...` (worktree-safe).
 *
 * This module is a PURE-ish building block: the only I/O is via injected runners (default to
 * a thin execFileSync wrapper, tests inject a fake). It does NOT import runGate/deny/allow —
 * it is a contract, not a gate. Each live reader THROWS a local `FailClosed` on any runner
 * error so the gate's runGate turns it into a fail-closed deny (HARD-01).
 *
 * @module hooks/lib/marker
 */

const path = require('node:path');
// IN-03: FailClosed is the single shared type from failclosed.cjs. marker is a contract
// (not a gate) but its live readers throw FailClosed; we IMPORT and RE-EXPORT it so
// lint-ci-marker.cjs's `require('./lib/marker.cjs').FailClosed` import is unchanged.
// Acyclic: marker -> failclosed -> override; failclosed never requires marker.
const { FailClosed } = require('./failclosed.cjs');

/**
 * The frozen marker subdirectory (relative to the git dir). Shared by the writer and the
 * gate so they agree on WHERE the marker lives. The full path is
 * `<git-dir>/gsd-contrib/lint-ci-green/<tree-sha>`.
 */
const MARKER_SUBDIR = 'gsd-contrib/lint-ci-green';

/**
 * The default LIVE git runner: a thin wrapper over execFileSync with the standard options
 * block (copied from containment.cjs). Tests inject a fake instead of touching real git.
 *
 * @param {string} root absolute gsd-core worktree root (cwd for the git invocation).
 * @returns {(file: string, args: string[]) => string} a runner returning trimmed-able stdout.
 */
function defaultRunner(root) {
  const { execFileSync } = require('node:child_process');
  return (file, args) =>
    execFileSync(file, args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
}

/**
 * Read the current STAGED tree SHA via `git write-tree`. This is the marker KEY.
 *
 * Unlike `git config --get core.hooksPath`, `git write-tree` exits 0 on success — there is
 * no exit-1-means-unset special case. Any failure → FailClosed (fail closed).
 *
 * @param {string} root absolute gsd-core worktree root.
 * @param {(file: string, args: string[]) => string} [runner] injected for tests.
 * @returns {string} the trimmed tree SHA.
 * @throws {FailClosed} when the git runner errors / exits nonzero.
 */
function readTreeShaLive(root, runner) {
  const run = runner || defaultRunner(root);
  try {
    return String(run('git', ['write-tree'])).trim();
  } catch (err) {
    throw new FailClosed(
      'could not read the tree SHA via `git write-tree` in the gsd-core worktree (' +
        ((err && err.message) || 'git failure') + ') — failing closed (HARD-01)'
    );
  }
}

/**
 * Read the working-tree status via `git status --porcelain`. Returns the raw (possibly
 * empty) string — '' means a clean tree. A dirty tree invalidates the marker even when the
 * SHA matches, because `git write-tree` keys to the STAGED content (the gate enforces this).
 *
 * @param {string} root absolute gsd-core worktree root.
 * @param {(file: string, args: string[]) => string} [runner] injected for tests.
 * @returns {string} the raw porcelain status ('' = clean).
 * @throws {FailClosed} when the git runner errors.
 */
function readWorkingTreeStatusLive(root, runner) {
  const run = runner || defaultRunner(root);
  try {
    return String(run('git', ['status', '--porcelain']));
  } catch (err) {
    throw new FailClosed(
      'could not read the working-tree status via `git status --porcelain` (' +
        ((err && err.message) || 'git failure') + ') — failing closed (HARD-01)'
    );
  }
}

/**
 * Resolve the absolute marker path for a tree SHA via `git rev-parse --git-path`. Using
 * --git-path (NOT a hardcoded `.git/...`) means a linked worktree gets its OWN git dir, so
 * two worktrees sharing one gsd-core never collide on the marker.
 *
 * `--git-path` may return a RELATIVE path (when in a linked worktree) — resolve it against
 * `root` so callers always get an absolute path.
 *
 * @param {string} root absolute gsd-core worktree root.
 * @param {string} treeSha the `git write-tree` SHA (the marker key).
 * @param {(file: string, args: string[]) => string} [runner] injected for tests.
 * @returns {string} the absolute marker path.
 * @throws {FailClosed} when the git runner errors (could-not-resolve → fail closed).
 */
function resolveMarkerPathLive(root, treeSha, runner) {
  const run = runner || defaultRunner(root);
  try {
    const out = String(run('git', ['rev-parse', '--git-path', MARKER_SUBDIR + '/' + treeSha])).trim();
    return path.resolve(root, out);
  } catch (err) {
    throw new FailClosed(
      'could not resolve the marker path via `git rev-parse --git-path` (' +
        ((err && err.message) || 'git failure') + ') — failing closed (HARD-01)'
    );
  }
}

/**
 * Does the marker file exist? A sentinel presence check — the marker's PRESENCE is the proof
 * lint:ci was green for this tree.
 *
 * @param {string} markerPath absolute marker path (from resolveMarkerPathLive).
 * @param {{existsSync: (p: string) => boolean}} [fsImpl] injected for tests.
 * @returns {boolean} true iff the marker file exists.
 */
function markerExistsLive(markerPath, fsImpl) {
  const impl = fsImpl || require('node:fs');
  return impl.existsSync(markerPath);
}

module.exports = {
  MARKER_SUBDIR,
  FailClosed,
  readTreeShaLive,
  readWorkingTreeStatusLive,
  resolveMarkerPathLive,
  markerExistsLive,
};
