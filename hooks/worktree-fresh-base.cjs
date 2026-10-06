#!/usr/bin/env node
'use strict';

/**
 * hooks/worktree-fresh-base.cjs — PreToolUse ENF-25 worktree fresh-base gate.
 *
 * A worktree cut from a stale trunk inherits code that was already rewritten upstream (Trek-e
 * incident 2026-09-10: the main checkout's `next` sat 53 commits behind origin/next and every
 * worktree cut from it was stale). Before a gsd-core worktree is cut from the trunk, this gate
 * refreshes `origin/next` with a bounded fetch and fast-forwards a stale local `next` by
 * compare-and-swap, so `git worktree add ... next` gets the current trunk.
 *
 * This is the FIRST toolkit gate that MUTATES refs: the fetch updates remote-tracking refs and
 * the CAS `update-ref` moves `refs/heads/next`. Every other gate only reads. The precedent and its
 * constraints (fast-forward only, ancestor-proven, compare-and-swap, never a checked-out branch,
 * never a reset, bounded time) are recorded in CTK-ADR-0009, authored in 37-08.
 *
 * ── ORDER (load-bearing) ────────────────────────────────────────────────────────────────
 *   1. read the harness payload (malformed JSON throws -> fail-closed deny); command =
 *      `tool_input.command` or '' (EnterWorktree arrives in 37-05);
 *   2. the detector (hooks/lib/worktree-add-detect.cjs): no entry -> allow, BEFORE any resolve,
 *      fs, git or network work (RES-01). An `uncertain` entry throws FailClosed (HARD-01);
 *   3. per cut, in command order: a base that does not name the trunk ('other', 'none') is
 *      skipped with no I/O (no fetch on non-trunk cuts); the target dir = the cut's start dir
 *      (gsd-test-detect `startDirFor`, follows `cd`; unresolvable -> FailClosed) with the git
 *      `-C` values folded on; not a gsd-core checkout -> skipped;
 *   4. freshness, once per root: bounded fetch of origin next; `origin/next` must resolve. A
 *      `origin/next` base is then current -> allow. A local `next` base: equal -> allow; a strict
 *      ancestor held by no worktree -> CAS `update-ref refs/heads/next <remote> <local>` -> allow;
 *   5. first deny wins; otherwise allow.
 *
 * 37-01 tracer slice — KNOWN STUBS (unregistered hook): a HEAD base, a held next and a diverged
 * next allow (37-03 fills the denies); a failed CAS and a missing origin/next are thrown (37-03 /
 * 37-04 refine them); an unreachable origin throws FetchUnavailable, which denies until 37-04
 * maps it to `ask` (CTK-ADR-0007).
 *
 * A returned deny is a POLICY deny: GSD_CONTRIB_OVERRIDE rescues THROWN errors only and never
 * flips it. Every git call is a spawnSync argv array (never a shell) with a bounded timeout and an
 * env stripped of GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE / GIT_COMMON_DIR (an inherited redirect
 * would aim the mutation at another repo). The base token never reaches git: classification is
 * pure string matching, and only shas that pass SHA_RE are passed to merge-base / update-ref.
 *
 * Not registered in settings.snippet.json until 37-06 (until then it is not wired and not bundled).
 *
 * @module hooks/worktree-fresh-base
 */

const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runGate, readHookInput, allow, emit, safeCommand, FailClosed } = require('./lib/failclosed.cjs');
const { resolveGsdCoreRoot, ScriptResolveError } = require('./lib/resolve.cjs');
const { startDirFor } = require('./lib/gsd-test-detect.cjs');
const { findWorktreeAdds } = require('./lib/worktree-add-detect.cjs');

/** The fetch argv after `git -C <root>`: literal, frozen; `--no-auto-maintenance` = no gc here. */
const FETCH_ARGV = Object.freeze(['fetch', '--quiet', '--no-auto-maintenance', 'origin', 'next']);
/** coreutils `timeout` duration and kill-after grace for the fetch. */
const FETCH_TIMEOUT_S = 15;
const FETCH_KILL_AFTER_S = 2;
/** spawnSync's own belt around the coreutils timeout (SIGKILL). */
const FETCH_BELT_MS = 20000;
/** Per local git call (rev-parse, merge-base, worktree list, update-ref). */
const GIT_TIMEOUT_MS = 3000;

const NEXT_REF = 'refs/heads/next';
const ORIGIN_NEXT_REF = 'refs/remotes/origin/next';
const REFLOG_MESSAGE = 'ENF-25 worktree-fresh-base: fast-forward next to origin/next';

/** A full object name: SHA-1 (40) or SHA-256 (64) hex. */
const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Inherited variables that would redirect a git call away from the target repo. */
const GIT_REDIRECT_VARS = Object.freeze(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']);

/**
 * The upstream could not be fetched (spawn error, timeout, non-zero exit). Deliberately NOT a
 * FailClosed: 37-04 catches exactly this class and maps it to `ask` (CTK-ADR-0007 — an
 * unobtainable upstream is a network limit, not a policy decision). In the tracer it propagates
 * and runGate denies.
 */
class FetchUnavailable extends Error {
  constructor(message) {
    super(message);
    this.name = 'FetchUnavailable';
  }
}

/**
 * The pure gate decision with every impure dep injected.
 *
 * @param {string} stdinString raw PreToolUse JSON
 * @param {Object} deps
 * @param {string} deps.cwd the hook's working directory
 * @param {Object} deps.env environment for static `cd` target expansion
 * @param {string} deps.homedir home directory for `~` expansion
 * @param {(dir:string)=>(string|null)} deps.resolveTreeRoot gsd-core root, or null
 * @param {(root:string)=>void} deps.fetchOrigin bounded fetch; throws FetchUnavailable
 * @param {(root:string, ref:string)=>(string|null)} deps.revParse commit sha or null
 * @param {(root:string, a:string, b:string)=>boolean} deps.isAncestor
 * @param {(root:string, ref:string)=>string[]} deps.worktreesHolding worktree paths holding ref
 * @param {(root:string, ref:string, newSha:string, oldSha:string)=>boolean} deps.casUpdateRef
 * @returns {{permissionDecision:string, permissionDecisionReason?:string}}
 */
function gate(stdinString, deps) {
  const input = readHookInput(stdinString);
  const command = (input && input.tool_input && typeof input.tool_input.command === 'string')
    ? input.tool_input.command
    : '';

  // (2) RES-01: the detector is the first short-circuit — nothing below runs for `git status`.
  const entries = findWorktreeAdds(command);
  if (entries.length === 0) return allow();

  const uncertain = entries.find((e) => e.kind === 'uncertain');
  if (uncertain) {
    throw new FailClosed(
      'ENF-25 worktree fresh-base gate cannot attribute this `git worktree add` command (' +
        uncertain.reason +
        ') — failing closed. Re-run it as a plain `git worktree add <path> <base>` with literal values.'
    );
  }

  // (5) Verdict cache per root (and base kind) within this gate call; first deny wins.
  const verdicts = new Map();
  const fetched = new Set();
  for (const e of entries) {
    if (e.kind !== 'cut') continue;
    // (3) No fetch, resolve or git work for a base that does not name the trunk.
    if (e.baseKind === 'other' || e.baseKind === 'none') continue;

    const start = startDirFor(e, deps.cwd, { env: deps.env, homedir: deps.homedir });
    if (start === null) {
      throw new FailClosed(
        'ENF-25 worktree fresh-base gate cannot resolve the target repository statically (an earlier ' +
          '`cd` target is a shell expansion, `~user` or `-`) — failing closed. Pass a literal path.'
      );
    }
    const dir = e.gitChdirs.reduce((acc, c) => path.resolve(acc, c), start);
    const root = deps.resolveTreeRoot(dir);
    if (root === null || root === undefined) continue;

    const key = root + '\u0000' + e.baseKind;
    if (!verdicts.has(key)) verdicts.set(key, checkCut(e, root, deps, fetched));
    const decision = verdicts.get(key);
    if (decision) return decision;
  }
  return allow();
}

/**
 * Freshness for one trunk-naming cut in one gsd-core root: a deny decision, or null (passes).
 */
function checkCut(e, root, deps, fetched) {
  // 37-03 fills the HEAD-on-next case.
  if (e.baseKind === 'head') return null;

  if (!fetched.has(root)) {
    deps.fetchOrigin(root);
    fetched.add(root);
  }
  const remote = deps.revParse(root, ORIGIN_NEXT_REF);
  if (remote === null || remote === undefined) {
    // 37-04 turns this into ask.
    throw new FailClosed(
      'ENF-25 worktree fresh-base gate: origin/next does not resolve after the fetch — failing closed. ' +
        'Check the `origin` remote, then run `git fetch origin next`.'
    );
  }
  if (e.baseKind === 'remote') return null; // the fetch made it current

  const local = deps.revParse(root, NEXT_REF);
  if (local === null || local === undefined || local === remote) return null;

  if (deps.isAncestor(root, local, remote) && deps.worktreesHolding(root, NEXT_REF).length === 0) {
    if (deps.casUpdateRef(root, NEXT_REF, remote, local)) return null;
    // 37-03 makes this a policy deny with the fix.
    throw new FailClosed(
      'ENF-25 worktree fresh-base gate: local next moved while it was being fast-forwarded to ' +
        'origin/next (compare-and-swap refused) — failing closed. Re-run the command.'
    );
  }
  // KNOWN STUB (37-01 tracer, unregistered): stale-and-held or diverged next allows; 37-03 denies.
  return null;
}

/** A copy of process.env without the variables that would redirect git to another repo. */
function gitEnv(extra) {
  const env = Object.assign({}, process.env, extra || {});
  for (const k of GIT_REDIRECT_VARS) delete env[k];
  return env;
}

/** One bounded local git call; a spawn error or timeout fails closed naming the operation. */
function runGit(dir, args, op) {
  const r = spawnSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: GIT_TIMEOUT_MS,
    env: gitEnv(),
  });
  if (r.error) {
    throw new FailClosed(
      'ENF-25 worktree fresh-base gate: git ' + op + ' could not run (' + (r.error.code || r.error.message) +
        ') — failing closed.'
    );
  }
  return r;
}

function unexpected(op, r) {
  return new FailClosed(
    'ENF-25 worktree fresh-base gate: git ' + op + ' failed (exit ' + r.status + (r.signal ? ', ' + r.signal : '') +
      ') — failing closed.'
  );
}

function requireSha(op, sha) {
  if (typeof sha !== 'string' || !SHA_RE.test(sha)) {
    throw new FailClosed('ENF-25 worktree fresh-base gate: git ' + op + ' was given a non-sha — failing closed.');
  }
}

/** status 0 + a full sha -> the sha; status 1 -> null; anything else -> FailClosed. */
function defaultRevParse(dir, ref) {
  const r = runGit(dir, ['rev-parse', '--verify', '--quiet', '--end-of-options', ref + '^{commit}'], 'rev-parse');
  if (r.status === 0) {
    const sha = String(r.stdout || '').trim();
    if (SHA_RE.test(sha)) return sha;
    throw new FailClosed('ENF-25 worktree fresh-base gate: git rev-parse returned a non-sha — failing closed.');
  }
  if (r.status === 1) return null;
  throw unexpected('rev-parse', r);
}

/** exit 0 -> true, 1 -> false, else FailClosed. */
function defaultIsAncestor(dir, a, b) {
  requireSha('merge-base', a);
  requireSha('merge-base', b);
  const r = runGit(dir, ['merge-base', '--is-ancestor', a, b], 'merge-base');
  if (r.status === 0) return true;
  if (r.status === 1) return false;
  throw unexpected('merge-base', r);
}

/** The `worktree <path>` of every porcelain block carrying the exact line `branch <ref>`. */
function defaultWorktreesHolding(dir, ref) {
  const r = runGit(dir, ['worktree', 'list', '--porcelain'], 'worktree list');
  if (r.status !== 0) throw unexpected('worktree list', r);
  const holders = [];
  for (const block of String(r.stdout || '').split(/\r?\n\s*\r?\n/)) {
    const lines = block.split(/\r?\n/);
    if (!lines.includes('branch ' + ref)) continue;
    const wt = lines.find((l) => l.startsWith('worktree '));
    holders.push(wt ? wt.slice('worktree '.length) : '');
  }
  return holders;
}

/** Compare-and-swap ref move: exit 0 -> true, any other exit -> false; spawn error -> FailClosed. */
function defaultCasUpdateRef(dir, ref, newSha, oldSha) {
  requireSha('update-ref', newSha);
  requireSha('update-ref', oldSha);
  const r = runGit(dir, ['update-ref', '-m', REFLOG_MESSAGE, ref, newSha, oldSha], 'update-ref');
  return r.status === 0;
}

/**
 * `timeout -k 2 15 git -C <dir> fetch --quiet --no-auto-maintenance origin next`, argv only.
 * Success returns; anything else throws FetchUnavailable with a short reason (never the remote's
 * raw stderr).
 */
function defaultFetchOrigin(dir) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) {
    throw new FailClosed('ENF-25 worktree fresh-base gate: fetch target is not an absolute path — failing closed.');
  }
  const r = spawnSync(
    'timeout',
    ['-k', String(FETCH_KILL_AFTER_S), String(FETCH_TIMEOUT_S), 'git', '-C', dir, ...FETCH_ARGV],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: FETCH_BELT_MS,
      killSignal: 'SIGKILL',
      env: gitEnv({ GIT_TERMINAL_PROMPT: '0' }),
    }
  );
  if (r.error) {
    const code = r.error.code || r.error.message;
    throw new FetchUnavailable(
      code === 'ETIMEDOUT'
        ? '`git fetch origin next` did not finish within ' + FETCH_BELT_MS / 1000 + ' s'
        : '`git fetch origin next` could not run (' + code + ')'
    );
  }
  if (r.status === 0) return;
  if (r.status === 124 || r.status === 137 || r.signal) {
    throw new FetchUnavailable('`git fetch origin next` timed out after ' + FETCH_TIMEOUT_S + ' s');
  }
  throw new FetchUnavailable('`git fetch origin next` failed (exit ' + r.status + ')');
}

/**
 * Injectable entry seam. Defaults the real impls INSIDE the runGate callback so a throwing
 * default fails closed rather than escaping the harness.
 *
 * @param {string} stdinString raw PreToolUse JSON
 * @param {Object} [deps]
 * @returns {{permissionDecision:string, permissionDecisionReason?:string}}
 */
function runWorktreeFreshBaseGate(stdinString, deps = {}) {
  const ctx = {
    command: safeCommand(stdinString),
    action: 'worktree-fresh-base',
    // OBS-02: read ONLY for session/tool ids in the verdict log; never logged verbatim.
    stdin: stdinString,
    worktreeRoot: deps.worktreeRoot,
    overrideImpl: deps.overrideImpl,
  };

  return runGate(() => {
    const resolved = Object.assign({}, deps);
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
    if (!resolved.fetchOrigin) resolved.fetchOrigin = defaultFetchOrigin;
    if (!resolved.revParse) resolved.revParse = defaultRevParse;
    if (!resolved.isAncestor) resolved.isAncestor = defaultIsAncestor;
    if (!resolved.worktreesHolding) resolved.worktreesHolding = defaultWorktreesHolding;
    if (!resolved.casUpdateRef) resolved.casUpdateRef = defaultCasUpdateRef;
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
    emit(runWorktreeFreshBaseGate(buf));
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  runWorktreeFreshBaseGate,
  gate,
  FetchUnavailable,
  FETCH_ARGV,
  FETCH_TIMEOUT_S,
  FETCH_KILL_AFTER_S,
  FETCH_BELT_MS,
  GIT_TIMEOUT_MS,
};
