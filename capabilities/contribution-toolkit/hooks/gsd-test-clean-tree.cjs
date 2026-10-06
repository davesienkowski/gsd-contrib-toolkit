#!/usr/bin/env node
'use strict';

/**
 * hooks/gsd-test-clean-tree.cjs — PreToolUse(Bash) ENF-23 gsd-test clean-tree gate.
 *
 * gsd-test dispatches a ref-based Docker test run. Two of trek-e's documented traps turn such a
 * run into a FALSE GREEN, and this gate denies both at dispatch time:
 *
 *   trap 2 (GTEST-03) — the dispatch's output is PIPED (`gsd-test ... | tail`). A pipeline exits
 *            with its LAST command's status, so a failed run reads as exit 0.
 *   trap 1 (GTEST-02) — the working tree has uncommitted TRACKED changes while the run tests the
 *            working HEAD. gsd-test resolves `--head` to a commit and tests that commit, so the
 *            edits are never tested and a pass is a false green about code that did not change.
 *
 * ── ORDER (load-bearing) ────────────────────────────────────────────────────────────────
 *   1. read the harness payload (malformed JSON throws -> fail-closed deny);
 *   2. the shared detector (hooks/lib/gsd-test-detect.cjs): no entry -> allow, BEFORE any
 *      resolve, git or fs work (RES-01; 36-CONTEXT Addendum 2 — `isNonGovernedCommand` is
 *      deliberately NOT used, gsd-test is not a classifyAction action);
 *   3. any `uncertain` entry -> throw FailClosed (HARD-01), still before any I/O;
 *   4. informational dispatches (`--version`, `-h`, `--probe-benches`) are dropped; none left
 *      -> allow;
 *   5. per dispatch, in command order (first deny wins):
 *        a. tree = `-source` resolved against the dispatch's start dir, else that start dir;
 *           unresolvable -> throw FailClosed;
 *        b. not a gsd-core checkout -> this dispatch contributes allow (ROB-01 precedent);
 *        c. pipe masked -> deny(PIPE_REASON), before any git call (GTEST-03);
 *        d. `git status --porcelain --untracked-files=no`; clean -> next dispatch;
 *        e. the run tests the working HEAD -> deny(dirty reason) (GTEST-02).
 *
 * A returned deny is a POLICY deny: GSD_CONTRIB_OVERRIDE rescues THROWN errors only and never
 * flips it (Addendum 4), so every deny reason names the real fix. A git failure (not a repo,
 * timeout) is thrown as FailClosed, which IS override-escapable with a logged receipt.
 *
 * The gate only READS the repository: `status` with --no-optional-locks (no index refresh
 * write) and `rev-parse`. It never stashes, commits, resets, checks out or fetches. Every git
 * call is an argv array with a bounded timeout; a `--head` value reaches git only as one argv
 * element after `--end-of-options`, suffixed `^{commit}` (T-36-10).
 *
 * Registered in settings.snippet.json by 36-05 (until then it is not wired and not bundled).
 *
 * @module hooks/gsd-test-clean-tree
 */

const os = require('node:os');
const { execFileSync, spawnSync } = require('node:child_process');
const { runGate, readHookInput, deny, allow, emit, safeCommand, FailClosed } = require('./lib/failclosed.cjs');
const { resolveGsdCoreRoot, ScriptResolveError } = require('./lib/resolve.cjs');
const { findGsdTestDispatches, treeDirFor } = require('./lib/gsd-test-detect.cjs');

/** Per-git-call timeout. The harness hook budget is 20 s; a hung git must not eat it. */
const GIT_TIMEOUT_MS = 5000;

/** At most this many dirty paths are listed in the deny reason. */
const MAX_DIRTY_LISTED = 10;

/** A full object name: SHA-1 (40) or SHA-256 (64) hex. */
const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * The pipe-deny reason. A module CONSTANT with no cwd, path, sha or timestamp: it becomes a
 * committed byte-stable proof fixture in 36-05.
 */
const PIPE_REASON =
  'Blocked by the ENF-23 gsd-test clean-tree gate: this gsd-test dispatch is piped into another ' +
  'command. A shell pipeline exits with the status of its LAST command, so a failed gsd-test run ' +
  'piped into `tail`/`tee`/`grep` reads as exit 0 — a false green.\n\n' +
  'Re-run it one of these ways:\n' +
  '  1. run it unpiped: `gsd-test ...` on its own;\n' +
  '  2. prefix the pipeline with `set -o pipefail;` so the pipeline fails when gsd-test fails;\n' +
  '  3. redirect to a file and read the log after: `gsd-test ... > gsd-test.log 2>&1`, then ' +
  'inspect `gsd-test.log` and the exit status.';

/** Non-empty porcelain lines. */
function porcelainLines(porcelain) {
  return String(porcelain == null ? '' : porcelain)
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l.trim().length > 0);
}

/**
 * The dirty-tree deny reason (GTEST-02). Names the real fix only — no override or env-var
 * escape (Addendum 4).
 *
 * @param {string[]} lines porcelain lines (non-empty)
 * @param {boolean} expansionHead the `--head` value was a shell expansion
 * @returns {string}
 */
function dirtyReason(lines, expansionHead) {
  const shown = lines.slice(0, MAX_DIRTY_LISTED);
  const more = lines.length - shown.length;
  let r =
    'Blocked by the ENF-23 gsd-test clean-tree gate: the working tree has uncommitted tracked ' +
    'changes and this run tests the working HEAD. gsd-test is ref-based: it resolves `--head` to ' +
    'a commit and tests THAT commit, so your uncommitted edits are never tested and a pass is a ' +
    'false green about code you did not change.\n\n' +
    'Fix: commit (or stash) the changes, then re-run gsd-test. For a deliberate ref-vs-ref run, ' +
    'pass an explicit other ref with `--head <ref>`.';
  if (expansionHead) {
    r +=
      '\n\nThe `--head` value is a shell expansion, which cannot be shown to name a commit other ' +
      'than HEAD; pass a literal sha or ref instead.';
  }
  r += '\n\nUncommitted tracked changes:\n' + shown.map((l) => '  ' + l).join('\n');
  if (more > 0) r += '\n  (and ' + more + ' more)';
  return r;
}

/**
 * Whether the dispatch tests the working HEAD. Literal `HEAD`, `@`, an omitted or empty `--head`
 * need no git call. An expansion value is treated as the working HEAD (conservative; trek-e's
 * own trap text names `--head $(git rev-parse HEAD)`) and is never passed to git. Any other
 * literal is compared by commit sha; an unresolvable HEAD sha is treated as the working HEAD.
 *
 * @returns {{working:boolean, expansion:boolean}}
 */
function testsWorkingHead(d, root, deps, cache) {
  const head = d.flags ? d.flags.head : undefined;
  if (head === undefined || head === true || head === '' || head === 'HEAD' || head === '@') {
    return { working: true, expansion: false };
  }
  if (d.unresolved && d.unresolved.has('head')) return { working: true, expansion: true };
  if (typeof head !== 'string') return { working: true, expansion: false };

  if (!cache.headSha.has(root)) cache.headSha.set(root, deps.resolveRef(root, 'HEAD'));
  const headSha = cache.headSha.get(root);
  if (headSha === null || headSha === undefined) return { working: true, expansion: false };
  const sha = deps.resolveRef(root, head);
  return { working: sha !== null && sha !== undefined && sha === headSha, expansion: false };
}

/**
 * The pure gate decision with every impure dep injected.
 *
 * @param {string} stdinString raw PreToolUse JSON
 * @param {Object} deps
 * @param {string} deps.cwd the hook's working directory (the command's base cwd)
 * @param {Object} deps.env environment for static `-source` expansion
 * @param {string} deps.homedir home directory for `~` expansion
 * @param {(dir:string)=>(string|null)} deps.resolveTreeRoot gsd-core root for a dir, or null
 * @param {(root:string)=>string} deps.gitStatus porcelain status (throws FailClosed on failure)
 * @param {(root:string, ref:string)=>(string|null)} deps.resolveRef commit sha, null if unknown
 * @returns {{permissionDecision:string, permissionDecisionReason?:string}}
 */
function gate(stdinString, deps) {
  const input = readHookInput(stdinString);
  const command = (input.tool_input && input.tool_input.command) || '';

  // (2) RES-01: the detector is the first short-circuit — nothing below runs for `git status`.
  const entries = findGsdTestDispatches(command);
  if (entries.length === 0) return allow();

  // (3) HARD-01: an unattributable gsd-test mention fails closed before any I/O.
  const uncertain = entries.find((e) => e.kind === 'uncertain');
  if (uncertain) {
    throw new FailClosed(
      'ENF-23 gsd-test clean-tree gate cannot attribute this gsd-test command (' +
        uncertain.reason +
        ') — failing closed. Re-run it as a plain `gsd-test` invocation with literal flag values.'
    );
  }

  // (4) Informational invocations only print; they test nothing.
  const dispatches = entries.filter((e) => e.kind === 'dispatch' && !e.informational);
  if (dispatches.length === 0) return allow();

  const cache = { porcelain: new Map(), headSha: new Map() };
  for (const d of dispatches) {
    // (5a) Which tree.
    const treeDir = treeDirFor(d, deps.cwd, { env: deps.env, homedir: deps.homedir });
    if (treeDir === null) {
      throw new FailClosed(
        'ENF-23 gsd-test clean-tree gate cannot resolve the tested tree statically (a `-source` ' +
          'value or an earlier `cd` target is a shell expansion, `~user` or `-`) — failing closed. ' +
          'Pass a literal path.'
      );
    }

    // (5b) Out-of-tree passthrough.
    const root = deps.resolveTreeRoot(treeDir);
    if (root === null) continue;

    // (5c) Trap 2: a piped dispatch masks the exit code, whatever it tests.
    if (d.pipeMasked) return deny(PIPE_REASON);

    // (5d) Dirtiness of tracked files.
    if (!cache.porcelain.has(root)) cache.porcelain.set(root, porcelainLines(deps.gitStatus(root)));
    const lines = cache.porcelain.get(root);
    if (lines.length === 0) continue;

    // (5e) Trap 1: dirty + the run tests the working HEAD.
    const w = testsWorkingHead(d, root, deps, cache);
    if (w.working) return deny(dirtyReason(lines, w.expansion));
  }

  return allow();
}

/** Real `git status`: tracked changes only; any failure fails closed (HARD-01). */
function defaultGitStatus(root) {
  try {
    return execFileSync('git', ['--no-optional-locks', 'status', '--porcelain', '--untracked-files=no'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: GIT_TIMEOUT_MS,
      env: process.env,
    });
  } catch (err) {
    const detail = (err && err.stderr && String(err.stderr).trim()) || (err && err.message) || 'unknown error';
    throw new FailClosed('ENF-23 could not read the work-tree status of ' + root + ' (' + detail + ') — failing closed.');
  }
}

/**
 * Real ref resolution. status 0 + a sha -> the sha; status 1 (unknown ref, including an
 * option-shaped value) -> null; anything else -> FailClosed.
 */
function defaultResolveRef(root, ref) {
  const r = spawnSync('git', ['rev-parse', '--verify', '--quiet', '--end-of-options', ref + '^{commit}'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: GIT_TIMEOUT_MS,
    env: process.env,
  });
  if (r.error) {
    throw new FailClosed('ENF-23 could not resolve a ref in ' + root + ' (' + r.error.message + ') — failing closed.');
  }
  if (r.status === 0) {
    const sha = String(r.stdout || '').trim();
    if (SHA_RE.test(sha)) return sha;
    throw new FailClosed('ENF-23 got a non-sha from git rev-parse in ' + root + ' — failing closed.');
  }
  if (r.status === 1) return null;
  const detail = String(r.stderr || '').trim() || 'exit ' + r.status + (r.signal ? ' (' + r.signal + ')' : '');
  throw new FailClosed('ENF-23 could not resolve a ref in ' + root + ' (' + detail + ') — failing closed.');
}

/**
 * Injectable entry seam. Defaults the real impls INSIDE the runGate callback so a throwing
 * default fails closed rather than escaping the harness.
 *
 * @param {string} stdinString raw PreToolUse JSON
 * @param {Object} [deps]
 * @returns {{permissionDecision:string, permissionDecisionReason?:string}}
 */
function runGsdTestCleanTreeGate(stdinString, deps = {}) {
  const ctx = {
    command: safeCommand(stdinString),
    action: 'gsd-test-clean-tree',
    // OBS-02: read ONLY for session/tool ids in the verdict log; never logged verbatim.
    stdin: stdinString,
    worktreeRoot: deps.worktreeRoot,
    overrideImpl: deps.overrideImpl,
  };

  return runGate(() => {
    const resolved = Object.assign({}, deps);
    // Addendum 6: the hook's cwd is process.cwd(), as every other Bash gate.
    if (!resolved.cwd) resolved.cwd = process.cwd();
    if (!resolved.env) resolved.env = process.env;
    if (!resolved.homedir) resolved.homedir = os.homedir();
    if (!resolved.resolveTreeRoot) {
      resolved.resolveTreeRoot = (dir) => {
        try {
          return resolveGsdCoreRoot(dir);
        } catch (err) {
          // Not a gsd-core checkout: not this gate's concern. Anything else fails closed.
          if (err instanceof ScriptResolveError) return null;
          throw err;
        }
      };
    }
    if (!resolved.gitStatus) resolved.gitStatus = defaultGitStatus;
    if (!resolved.resolveRef) resolved.resolveRef = defaultResolveRef;
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
    emit(runGsdTestCleanTreeGate(buf));
  });
}

if (require.main === module) {
  main();
}

module.exports = { runGsdTestCleanTreeGate, gate, PIPE_REASON, GIT_TIMEOUT_MS };
