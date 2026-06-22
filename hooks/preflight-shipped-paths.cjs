#!/usr/bin/env node
'use strict';

/**
 * hooks/preflight-shipped-paths.cjs — ALIGN-04 registration-surface companion check.
 *
 * ADVISORY, MODEL-DRIVEN companion (the `ci-preflight` loop invokes it) — NOT a blocking
 * PreToolUse gate. It returns NO allow/deny permission verdict and is NOT registered in
 * settings.snippet.json. Its job is to SURFACE (loudly) whether the working diff touches
 * paths that ship in the npm tarball / gate CI, so the model knows to run the
 * `lint-ci-stamp` + scan loop before pushing.
 *
 * It calls the LIVE gsd-core `scripts/diff-touches-shipped-paths.cjs` — using its EXPORTED
 * predicates (loadShipPrefixes / isShipped / isPushBlocking / isCiGating) so it can report
 * WHICH paths are shipped (the script's own main() is exit-code-only). It NEVER reimplements
 * the ship-prefix logic (HARD-02): a missing or broken LIVE script surfaces a LOUD error
 * (returned + written to stderr), never a silent "clean" result. For an advisory companion
 * there is no permission to decide, so it fails LOUD rather than fail-closed-deny.
 *
 * The classification mirrors the LIVE script's decision order exactly (the predicates ARE
 * the live ones): a diff that touches ONLY `.github/workflows/*` is push-blocking and the
 * LIVE classifier treats it as NOT shipped (unpickable, #2980); package.json + `files`
 * entries are shipped; `tests/*` are CI-gating and counted shipped (#3621).
 *
 * @module hooks/preflight-shipped-paths
 */

const path = require('node:path');
const { resolveGsdCoreRoot, requireLiveScript } = require('./lib/resolve.cjs');

const LIVE_SCRIPT_REL = 'scripts/diff-touches-shipped-paths.cjs';

/**
 * Default diff source: the union of staged + unstaged changed paths in the gsd-core
 * worktree, via `git diff --name-only` (no shell). Mirrors what the LIVE script expects
 * piped on stdin (a newline-separated path list).
 *
 * @param {string} root absolute gsd-core worktree root.
 * @returns {string[]} changed paths (deduped).
 */
function defaultGetDiffPaths(root) {
  const { execFileSync } = require('node:child_process');
  const read = (args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8' })
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  const staged = read(['diff', '--name-only', '--cached']);
  const unstaged = read(['diff', '--name-only']);
  return Array.from(new Set([...staged, ...unstaged]));
}

/**
 * Default LIVE-script loader: require() the LIVE diff-touches-shipped-paths.cjs and return
 * its exported predicate set. Any failure throws (ScriptResolveError) → surfaced as a loud
 * error, never a vendored fallback (HARD-02).
 *
 * @param {string} root absolute gsd-core worktree root.
 * @returns {{loadShipPrefixes:Function, isShipped:Function, isPushBlocking:Function, isCiGating:Function}}
 */
function defaultLoadLiveScript(root) {
  return requireLiveScript(root, LIVE_SCRIPT_REL);
}

/**
 * Classify a diff against the LIVE ship-prefix predicates and surface the shipped paths.
 *
 * Decision order mirrors the LIVE script: a diff whose ONLY relevant paths are
 * `.github/workflows/*` is push-blocking → not shipped. Otherwise package.json + `files`
 * prefixes (isShipped) and `tests/*` (isCiGating) are the shipped surface.
 *
 * @param {string[]} diffPaths
 * @param {{loadShipPrefixes:Function, isShipped:Function, isCiGating:Function, isPushBlocking:Function}} live
 * @returns {{touchesShipped:boolean, paths:string[]}}
 */
function classify(diffPaths, live) {
  const shipPrefixes = live.loadShipPrefixes(path.join('package.json'));
  // #2980 wins: if every relevant path is a push-blocking workflow edit, the LIVE
  // classifier returns NOT shipped. Match that by excluding push-blocking-only diffs.
  const onlyPushBlocking =
    diffPaths.length > 0 && diffPaths.every((p) => live.isPushBlocking(p));
  if (onlyPushBlocking) {
    return { touchesShipped: false, paths: [] };
  }
  const shipped = diffPaths.filter(
    (p) => !live.isPushBlocking(p) && (live.isShipped(p, shipPrefixes) || live.isCiGating(p))
  );
  return { touchesShipped: shipped.length > 0, paths: shipped };
}

/**
 * The advisory preflight. Obtains the changed-path list and classifies it with the LIVE
 * predicates. On ANY failure (diff read or LIVE-script load) it returns an explicit
 * `error` string and does NOT report `touchesShipped:false` — the model is never falsely
 * told a diff is clean.
 *
 * @param {Object} [deps]
 * @param {string} [deps.gsdCoreRoot] absolute gsd-core root (default: resolved from cwd).
 * @param {(root:string)=>string[]} [deps.getDiffPaths] the diff-path source.
 * @param {(root:string)=>object} [deps.loadLiveScript] the LIVE-script loader.
 * @returns {{touchesShipped:(boolean|null), paths:string[], error?:string}}
 */
function runPreflight(deps = {}) {
  let root = deps.gsdCoreRoot;
  try {
    if (!root) root = resolveGsdCoreRoot(process.cwd());
  } catch (err) {
    return { touchesShipped: null, paths: [], error: 'could not resolve gsd-core root: ' + (err && err.message) };
  }

  const getDiffPaths = deps.getDiffPaths || defaultGetDiffPaths;
  const loadLiveScript = deps.loadLiveScript || defaultLoadLiveScript;

  let diffPaths;
  try {
    diffPaths = getDiffPaths(root);
  } catch (err) {
    return { touchesShipped: null, paths: [], error: 'could not read the diff path list: ' + (err && err.message) };
  }

  let live;
  try {
    live = loadLiveScript(root);
  } catch (err) {
    return { touchesShipped: null, paths: [], error: (err && err.message) || 'LIVE diff-touches-shipped-paths.cjs failed to load' };
  }

  try {
    return classify(diffPaths, live);
  } catch (err) {
    return { touchesShipped: null, paths: [], error: 'classification against the LIVE predicates failed: ' + (err && err.message) };
  }
}

/**
 * Human-readable surface for the `ci-preflight` loop. Prints to stdout when the diff
 * touches shipped paths, and to stderr (loud) when classification errored.
 *
 * @param {Object} [deps] forwarded to runPreflight (for tests).
 * @returns {{touchesShipped:(boolean|null), paths:string[], error?:string}}
 */
function main(deps = {}) {
  const r = runPreflight(deps);
  if (r.error) {
    process.stderr.write(
      '⚠ preflight-shipped-paths: could NOT classify the diff (advisory fails LOUD, not clean): ' +
        r.error +
        '\n'
    );
    return r;
  }
  if (r.touchesShipped) {
    process.stdout.write(
      '⚠ this diff touches shipped paths:\n  ' +
        r.paths.join('\n  ') +
        '\n  → run `ci-preflight` + `bin/lint-ci-stamp.cjs` (npm run lint:ci then stamp) before pushing.\n'
    );
  } else {
    process.stdout.write('✓ preflight: this diff touches no shipped paths.\n');
  }
  return r;
}

if (require.main === module) {
  main();
}

module.exports = { runPreflight, classify, main };
