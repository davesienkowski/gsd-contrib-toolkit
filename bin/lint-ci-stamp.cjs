#!/usr/bin/env node
'use strict';

/**
 * bin/lint-ci-stamp.cjs — the toolkit-OWNED WRITER half of the ENF-05 marker mechanism.
 *
 * Runs `npm run lint:ci` in the resolved gsd-core root and, ONLY on exit 0, atomically
 * stamps a marker keyed to the current `git write-tree` SHA. The Wave-2 gate (plan 04-02) is
 * READ-ONLY — this CLI is the only WRITER. ENF-05 splits responsibility so the gate stays
 * fast/side-effect-free while the heavy lint:ci runs here (also what `ci-preflight`, plan
 * 04-04, drives).
 *
 * Critical invariants:
 *   - NO marker is written unless lint:ci exited 0. A lint FAILURE (numeric exit) and an
 *     INFRA failure (npm/node missing — no numeric status) are BOTH treated as "not green":
 *     no marker, nonzero exit. A missing-npm run can NEVER be mistaken for a pass
 *     (T-04-01-FALSEPASS).
 *   - The marker write is ATOMIC: write a temp file then `renameSync` (POSIX-atomic), so the
 *     gate never half-reads a torn marker (T-04-01-TORN / EP-5). No read-modify-write.
 *   - The marker path is resolved via `git rev-parse --git-path` (in marker.cjs), so linked
 *     worktrees get their OWN git dir — never a hardcoded `.git/...`.
 *   - All child processes use execFileSync with argv arrays — never `{shell:true}`, never
 *     string-interpolated (T-04-01-INJ / HARD-04).
 *
 * This is a CLI, NOT a hook: it does NOT read stdin JSON, does NOT emit permissionDecision,
 * and is NOT wired into settings.snippet.json.
 *
 * @module bin/lint-ci-stamp
 */

const fs = require('node:fs');
const path = require('node:path');

const marker = require('../hooks/lib/marker.cjs');
const { resolveGsdCoreRoot } = require('../hooks/lib/resolve.cjs');

/**
 * The default LIVE lint:ci runner: `npm run --silent lint:ci` via execFileSync. Mirrors the
 * policy-invariants infra-vs-lint split — a numeric `status` is a lint FAILURE (ran, failed);
 * no numeric status is an INFRA failure (npm/node could not start) and is RE-THROWN so the
 * caller treats it distinctly from a passing run.
 *
 * @param {string} root absolute gsd-core worktree root.
 * @returns {{ok: boolean, code: number, tail: string}} on a run (pass or lint-fail).
 * @throws {Error} on an infra failure (no numeric status) — npm/node missing.
 */
function runLintCiLive(root) {
  const { execFileSync } = require('node:child_process');
  try {
    execFileSync('npm', ['run', '--silent', 'lint:ci'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    return { ok: true, code: 0, tail: '' };
  } catch (err) {
    if (err && typeof err.status === 'number') {
      const out = (err.stdout || '') + (err.stderr || '');
      return { ok: false, code: err.status, tail: tailOf(out) };
    }
    // No numeric status → npm/node could not even start → infra failure. Re-throw so the
    // caller surfaces it distinctly (and writes NO marker).
    throw err;
  }
}

const TAIL_LIMIT = 600;
/**
 * Keep the last TAIL_LIMIT characters of lint output (the actionable tail).
 * @param {string} out
 * @returns {string}
 */
function tailOf(out) {
  const s = String(out || '').trim();
  if (s.length <= TAIL_LIMIT) return s;
  return '…' + s.slice(s.length - TAIL_LIMIT);
}

/**
 * The default ATOMIC marker writer: write a temp file then rename (POSIX-atomic, no torn
 * read). The `mkdirSync({recursive:true})` pre-creates the marker dir (copied from
 * override.cjs's no-race discipline). The marker content is the tree SHA (a human-readable
 * sentinel; presence is what matters).
 *
 * @param {string} markerPath absolute marker path (from resolveMarkerPath).
 * @param {string} treeSha the tree SHA stamped into the marker body.
 */
function writeMarkerAtomic(markerPath, treeSha) {
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  const tmp = markerPath + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, treeSha + '\n', { encoding: 'utf8' });
  fs.renameSync(tmp, markerPath);
}

/**
 * Run lint:ci then, ONLY on green, atomically stamp the tree-SHA marker. All impure deps are
 * injectable for hermetic tests.
 *
 * @param {object} [deps]
 * @param {string} [deps.root] gsd-core root; defaults to resolveGsdCoreRoot(process.cwd()).
 * @param {() => {ok:boolean, code:number, tail:string}} [deps.runLintCi]
 * @param {() => string} [deps.readTreeSha]
 * @param {(sha:string) => string} [deps.resolveMarkerPath]
 * @param {(markerPath:string, treeSha:string) => void} [deps.writeMarker]
 * @returns {{ok:true, markerPath:string, treeSha:string} | {ok:false, error?:string, code?:number, tail?:string}}
 */
function runStamp(deps = {}) {
  const root = deps.root || resolveGsdCoreRoot(process.cwd());
  const runLintCi = deps.runLintCi || (() => runLintCiLive(root));
  const readTreeSha = deps.readTreeSha || (() => marker.readTreeShaLive(root));
  const resolveMarkerPath = deps.resolveMarkerPath || ((sha) => marker.resolveMarkerPathLive(root, sha));
  const writeMarker = deps.writeMarker || writeMarkerAtomic;

  // 1. Run lint:ci. An infra failure (no numeric status) throws → surface as {ok:false}.
  let lint;
  try {
    lint = runLintCi();
  } catch (err) {
    return { ok: false, error: 'lint:ci could not run (' + ((err && err.message) || 'infra failure') + ')' };
  }

  // 2. ONLY stamp when lint:ci exited 0. A lint failure → NO marker.
  if (!lint || !lint.ok) {
    return {
      ok: false,
      code: lint ? lint.code : undefined,
      tail: lint ? lint.tail : '',
      error: 'lint:ci failed (exit ' + (lint ? lint.code : '?') + ')' + (lint && lint.tail ? ':\n' + lint.tail : ''),
    };
  }

  // 3. Green → derive the tree SHA, resolve the marker path, write atomically.
  const treeSha = readTreeSha();
  const markerPath = resolveMarkerPath(treeSha);
  writeMarker(markerPath, treeSha);
  return { ok: true, markerPath, treeSha };
}

/**
 * CLI entry: stamp on green (exit 0, print the SHA + path to stdout); on red/infra print the
 * failure to stderr and exit 1.
 */
function main() {
  const result = runStamp();
  if (result.ok) {
    process.stdout.write(
      'lint:ci green — stamped marker for tree ' + result.treeSha + '\n' + result.markerPath + '\n'
    );
    process.exit(0);
  }
  process.stderr.write(
    'lint-ci-stamp: NOT stamped — ' + (result.error || 'lint:ci did not pass') + '\n'
  );
  process.exit(1);
}

if (require.main === module) {
  main();
}

module.exports = { runStamp, main, runLintCiLive, writeMarkerAtomic, tailOf };
