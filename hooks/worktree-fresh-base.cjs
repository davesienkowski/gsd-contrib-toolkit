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
 *   1. read the harness payload (malformed JSON throws -> fail-closed deny). An `EnterWorktree`
 *      payload (37-05) takes its own branch and never reaches the Bash detector: a non-empty string
 *      `tool_input.path` enters an existing worktree -> allow with zero work; every other shape is a
 *      cut on a new branch (unknown shapes are treated as a cut, the conservative reading) -> the
 *      hook-env redirect check below, then root = resolveTreeRoot(cwd) (null -> allow), then ONE
 *      synthetic cut whose base kind comes from the effective `worktree.baseRef` (readBaseRef:
 *      `fresh` -> origin/next, `head` -> the current HEAD), judged by the same checkCut as step 4.
 *      Otherwise command = `tool_input.command` or '';
 *   2. the detector (hooks/lib/worktree-add-detect.cjs): no entry -> allow, BEFORE any resolve,
 *      fs, git or network work (RES-01). An `uncertain` entry throws FailClosed (HARD-01). So does
 *      a trunk-naming cut while the HOOK's own environment carries GIT_DIR / GIT_WORK_TREE /
 *      GIT_COMMON_DIR (37-04): the real cut would run in a repository the gate cannot see;
 *   3. per cut, in command order: a base that does not name the trunk ('other', 'none') is
 *      skipped with no I/O (no fetch on non-trunk cuts); the target dir = the cut's start dir
 *      (gsd-test-detect `startDirFor`: `cd`, `env -C`, `sudo -D`) with each git `-C` statically
 *      expanded and folded on (37-02; either unresolvable -> FailClosed before any I/O); not a
 *      gsd-core checkout -> skipped;
 *   4. freshness, once per root: a HEAD base (omitted, `HEAD`, `@`) is the trunk only when the
 *      tree's current branch is `next` (read BEFORE any fetch; otherwise skipped with no fetch).
 *      Then a bounded fetch of origin next; `origin/next` must resolve. A `origin/next` base is then
 *      current -> allow. A local `next` base (or HEAD on next): equal -> allow; a strict ancestor
 *      held by a worktree -> POLICY deny with `git -C <holder> merge --ff-only origin/next`; held
 *      by none -> CAS `update-ref refs/heads/next <remote> <local>` -> allow; AHEAD (origin/next is
 *      an ancestor of local next; flagged planner refinement, CTK-ADR-0009) -> allow, nothing
 *      moved; diverged (neither is an ancestor) -> POLICY deny naming the divergence; a refused
 *      CAS (next moved between read and write) -> POLICY deny with the fix, ONE attempt only;
 *   5. first deny wins; an `ask` is held until every cut is checked (a later deny or throw still
 *      wins); otherwise allow.
 *
 * UNOBTAINABLE ORIGIN -> ASK (37-04, CTK-ADR-0007): the fetch seam throws FetchUnavailable (not a
 * FailClosed) when origin cannot be fetched: timeout, unreachable remote, auth failure, a held ref
 * lock (no `origin` remote is not armed at all: MA-01). A try/catch around the fetch call ALONE maps exactly that class to
 * `ask`; origin/next missing after a good fetch asks too. Every other throw denies through
 * runGate. An ask degrades to an allow under --dangerously-skip-permissions (ASK_LIMIT_NOTE, stated
 * in the reason). A failed fetch is not retried for a second cut of the same root in one call.
 *
 * TIME BOUND (37-04, the 36-REVIEW m-06 per-call deadline mirrored from gsd-test-clean-tree): one
 * GATE_BUDGET_MS deadline per gate call is shared by every subprocess. A non-fetch git call gets
 * min(GIT_TIMEOUT_MS, remaining), the fetch belt min(FETCH_BELT_MS, remaining); with less than
 * MIN_CALL_MS left the gate throws FailClosed (deny, override-escapable). One trunk cut spawns at
 * most MAX_GIT_CALLS_PER_ROOT non-fetch git processes, so FETCH_BELT_MS + MAX * GIT_TIMEOUT_MS fits
 * the budget, and the budget plus 3 s fits the HOOK_TIMEOUT_S (60 s) hook timeout (asserted by tests).
 *
 * ARMING (37-REVIEW MA-01): a sentinel root is acted on only when `git remote get-url origin` there
 * parses as open-gsd/gsd-core (resolve.repoSpecTargetsGsdCore: owner and repo, case-folded, any
 * host). Anything else, including no `origin`, is out of scope: allow with no fetch.
 *
 * The gate's own git argv is limited to: remote get-url origin, fetch (via coreutils timeout),
 * rev-parse, symbolic-ref, merge-base --is-ancestor, worktree list --porcelain and update-ref
 * --no-deref --create-reflog. The
 * fix commands it names in deny and ask reasons are text for the operator; the gate never runs them.
 *
 * A returned deny is a POLICY deny: GSD_CONTRIB_OVERRIDE rescues THROWN errors only and never
 * flips it. Every git call is a spawnSync argv array (never a shell) with a bounded timeout and an
 * env stripped of GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE / GIT_COMMON_DIR (an inherited redirect
 * would aim the mutation at another repo). The base token never reaches git: classification is
 * pure string matching, and only shas that pass SHA_RE are passed to merge-base / update-ref.
 *
 * The settings reader (37-05) only reads: three fixed layers, a regular-file check, a 1 MiB cap,
 * JSON.parse in a try, one key. It never writes and never reads any other path.
 *
 * Not registered in settings.snippet.json until 37-06 (until then it is not wired and not bundled).
 *
 * @module hooks/worktree-fresh-base
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const { runGate, readHookInput, allow, ask, deny, emit, safeCommand, FailClosed } = require('./lib/failclosed.cjs');
const { resolveGsdCoreRoot, ScriptResolveError, repoSpecTargetsGsdCore } = require('./lib/resolve.cjs');
const { startDirFor, expandStatic } = require('./lib/gsd-test-detect.cjs');
const { findWorktreeAdds } = require('./lib/worktree-add-detect.cjs');

/**
 * The fetch argv after `git -C <root>`: literal, frozen; `--no-auto-maintenance` = no gc here.
 * 37-REVIEW MA-02: a fully qualified, forced refspec, so `refs/remotes/origin/next` is ALWAYS the
 * remote BRANCH (a narrowed `remote.origin.fetch` would otherwise leave it stale, and a tag named
 * `next` on origin would win the DWIM of a bare `next`); `--no-tags` fetches no tags at all.
 */
const FETCH_ARGV = Object.freeze([
  'fetch', '--quiet', '--no-auto-maintenance', '--no-tags', 'origin', '+refs/heads/next:refs/remotes/origin/next',
]);
/** coreutils `timeout` duration and kill-after grace for the fetch. */
const FETCH_TIMEOUT_S = 15;
const FETCH_KILL_AFTER_S = 2;
/** spawnSync's own belt around the coreutils timeout (SIGKILL). */
const FETCH_BELT_MS = 20000;
/** Per local git call (rev-parse, merge-base, worktree list, update-ref). */
const GIT_TIMEOUT_MS = 3000;
/** One deadline per gate call shared by every subprocess (36-REVIEW m-06 pattern). */
const GATE_BUDGET_MS = 50000;
/**
 * The settings.snippet.json timeout of both ENF-25 registrations, in seconds. GATE_BUDGET_MS plus
 * 3 s of headroom (node start-up, the verdict write) must fit it, and it equals the harness default
 * the capability install falls back to (that install writes no timeout: 37-REVIEW NI-07).
 */
const HOOK_TIMEOUT_S = 60;
/** Below this many ms left before a call, the gate fails closed instead of starting it. */
const MIN_CALL_MS = 100;
/**
 * Worst case non-fetch git processes for ONE trunk cut in one root (37-REVIEW TIME BUDGET):
 * symbolic-ref HEAD (HEAD base), remote get-url origin (the arming check), symbolic-ref -q
 * refs/heads/next (BL-01), rev-parse x2, merge-base, worktree list, rev-parse --git-common-dir
 * (BL-02), update-ref. FETCH_BELT_MS + 9 x GIT_TIMEOUT_MS = 47 s <= GATE_BUDGET_MS.
 */
const MAX_GIT_CALLS_PER_ROOT = 9;
/** The fetch detail that reaches a reason is cut to this many characters. */
const DETAIL_MAX = 200;
/** A settings layer larger than this (1 MiB) contributes nothing to the worktree.baseRef cascade. */
const MAX_SETTINGS_BYTES = 1024 * 1024;

const NEXT_REF = 'refs/heads/next';
const ORIGIN_NEXT_REF = 'refs/remotes/origin/next';
const REFLOG_MESSAGE = 'ENF-25 worktree-fresh-base: fast-forward next to origin/next';

/** A full object name: SHA-1 (40) or SHA-256 (64) hex. */
const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** The constant, path-free reason for an unattributable cut (HARD-01). */
const UNCERTAIN_REASON =
  'ENF-25 worktree fresh-base gate cannot attribute this `git worktree add` command (its repository or ' +
  'base is not statically known) — failing closed. Re-run it as a plain command with literal paths and base.';

/**
 * The constant reason for a symbolic `refs/heads/next` (37-REVIEW BL-01). rev-parse and update-ref
 * would read and write THROUGH the symref, so the CAS could move whatever branch it points at,
 * including a checked-out one. The gate cannot attribute such a trunk: thrown, override-escapable.
 */
const SYMREF_REASON =
  'ENF-25 worktree fresh-base gate: refs/heads/next in this repository is a symbolic ref, so the gate ' +
  'will not read or move it (a move would land on the branch it points at) — failing closed. Make ' +
  '`next` a plain branch, or base the worktree on the remote ref:\n' +
  '  git worktree add -b <branch> <path> origin/next';

/** Inherited variables that would redirect a git call away from the target repo. */
const GIT_REDIRECT_VARS = Object.freeze(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']);

/**
 * Hook-process variables that make the REAL cut run in a repository other than the one the gate
 * derives from cwd / cd / -C (37-02 deferred item 1, environment half). GIT_INDEX_FILE only swaps
 * the index, not the refs a cut is based on, so it is not here.
 */
const HOOK_REDIRECT_VARS = Object.freeze(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR']);

/** Base kinds that name (or may name) the trunk; only these do I/O. */
const TRUNK_KINDS = new Set(['local', 'remote', 'head']);

/**
 * The honesty clause that ends every `ask` reason. The SAME sentence as runtime-drift's
 * (asserted equal by a test; no runtime require of another hook module).
 */
const ASK_LIMIT_NOTE =
  'Note: an `ask` degrades to an ALLOW under `--dangerously-skip-permissions` — the same ' +
  'accepted limit ENF-11\'s advisory carries.';

/**
 * The upstream could not be fetched (timeout, unreachable remote, auth failure, a held ref lock, a
 * remote with no `next`). Deliberately NOT a FailClosed: the gate catches exactly this class around the
 * fetch call and maps it to `ask` (CTK-ADR-0007 — an unobtainable upstream is a network limit, not
 * a policy decision). A fetch that cannot be BOUNDED (no coreutils `timeout`) is a FailClosed.
 */
class FetchUnavailable extends Error {
  constructor(message) {
    super(message);
    this.name = 'FetchUnavailable';
  }
}

/**
 * The m-06 per-call deadline: `budget(capMs)` returns min(capMs, remaining) for the next
 * subprocess, or throws FailClosed once less than MIN_CALL_MS remains. One per gate call.
 *
 * @param {()=>number} now clock in ms
 * @returns {(capMs:number)=>number}
 */
function makeBudget(now) {
  const clock = typeof now === 'function' ? now : Date.now;
  const deadline = clock() + GATE_BUDGET_MS;
  return (capMs) => {
    const remaining = deadline - clock();
    if (remaining < MIN_CALL_MS) {
      throw new FailClosed(
        'ENF-25 worktree fresh-base gate spent its ' + GATE_BUDGET_MS / 1000 + ' s time budget for this ' +
          'command before finishing its git checks — failing closed. Run each `git worktree add` as its ' +
          'own command, or re-run it.'
      );
    }
    return Math.min(capMs, remaining);
  };
}

/** `scheme://user:secret@host` -> `scheme://***@host`, everywhere in `s`. */
function redactUrlCredentials(s) {
  return String(s).replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\/@\s]+@/g, '$1***@');
}

/** Redacted, control-character-free, capped text for a reason (credentials removed BEFORE the cap). */
function cleanDetail(s, max) {
  return redactUrlCredentials(s)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim()
    .slice(0, max || DETAIL_MAX);
}

/** The first non-empty stderr line, redacted and capped at DETAIL_MAX, or ''. */
function firstStderrLine(stderr) {
  for (const line of String(stderr || '').split(/\r?\n/)) {
    if (line.trim() !== '') return cleanDetail(line, DETAIL_MAX);
  }
  return '';
}

/**
 * Pure grading of the bounded fetch's spawnSync result.
 *
 *   ok          exit 0
 *   unavailable exit 124 / 137 (coreutils timed out / killed after the grace), a spawnSync
 *               ETIMEDOUT (the belt), a signal with no status, any other non-zero git exit
 *               (unreachable remote, auth failure, a concurrent fetch holding the ref lock) -> ask
 *   error       spawn ENOENT (no coreutils `timeout`: the fetch cannot be bounded), any other
 *               spawn error, exit 125 / 126 / 127 (timeout could not run git) -> FailClosed
 *
 * @param {{status?:(number|null), signal?:(string|null), error?:{code?:string}, stderr?:string}} res
 * @returns {{state:('ok'|'unavailable'|'error'), detail:string}}
 */
function classifyFetchResult(res) {
  const r = res || {};
  if (r.error) {
    const code = String(r.error.code || r.error.message || 'unknown error');
    if (code === 'ETIMEDOUT') {
      return { state: 'unavailable', detail: 'timed out (stopped by the gate\'s time limit)' };
    }
    if (code === 'ENOENT') {
      return { state: 'error', detail: 'coreutils `timeout` was not found (ENOENT), so the fetch cannot be bounded' };
    }
    return { state: 'error', detail: 'the bounded fetch could not be started (' + cleanDetail(code, 40) + ')' };
  }
  if (r.status === 0) return { state: 'ok', detail: '' };
  if (r.status === 125 || r.status === 126 || r.status === 127) {
    return { state: 'error', detail: 'coreutils `timeout` could not run git (exit ' + r.status + ')' };
  }
  if (r.status === 124 || r.status === 137) {
    return { state: 'unavailable', detail: 'timed out after ' + FETCH_TIMEOUT_S + ' s' };
  }
  if (r.status === null || r.status === undefined) {
    if (r.signal) return { state: 'unavailable', detail: 'was stopped by ' + cleanDetail(r.signal, 20) };
    return { state: 'error', detail: 'ended with no exit status' };
  }
  const line = firstStderrLine(r.stderr);
  return { state: 'unavailable', detail: line || 'exit ' + r.status };
}

/**
 * The `ask` for an unobtainable origin. Names ENF-25, the (redacted) failure, that this is a
 * network limit and not a policy decision, the manual fetch, and ends with ASK_LIMIT_NOTE.
 */
function fetchUnavailableReason(root, message) {
  return (
    'ENF-25 worktree fresh-base gate could not refresh origin/next before this worktree cut: ' +
    (cleanDetail(message, 300) || 'origin is unobtainable') + '. ' +
    'This is a NETWORK limit, not a policy decision: the gate cannot tell whether local `next` is current, ' +
    'so a worktree cut now may start from a stale trunk. To check it deterministically once origin is ' +
    'reachable, run\n\n  git -C ' + shellWord(root) + ' fetch origin next\n\nthen re-issue your command.\n\n' +
    ASK_LIMIT_NOTE
  );
}

/** The `ask` for a fetch that succeeded but left no origin/next (MA-02: the refspec always maps it). */
function originNextMissingReason(root) {
  return (
    'ENF-25 worktree fresh-base gate: origin/next does not resolve after the fetch of origin\'s ' +
    '`refs/heads/next` into it succeeded (something removed or replaced it), so the gate cannot tell ' +
    'whether local `next` is current. This is a remote-configuration and network limit, not a policy ' +
    'decision. Check the `origin` remote, run\n\n  git -C ' + shellWord(root) + ' fetch origin next\n\n' +
    'then re-issue your command.\n\n' + ASK_LIMIT_NOTE
  );
}

/**
 * The default settings-layer reader: the file's text, or null when it is missing, not a regular
 * file, larger than MAX_SETTINGS_BYTES, or unreadable (any error). Read-only: stat + readFileSync,
 * the text is only ever JSON.parse'd by readBaseRef, never required or evaluated.
 *
 * @param {string} p absolute settings path
 * @returns {string|null}
 */
function defaultReadSettings(p) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile() || st.size > MAX_SETTINGS_BYTES) return null;
    const text = fs.readFileSync(p, 'utf8');
    // The file may have grown between the stat and the read.
    return Buffer.byteLength(text, 'utf8') > MAX_SETTINGS_BYTES ? null : text;
  } catch {
    return null;
  }
}

/**
 * The effective `worktree.baseRef` for an EnterWorktree cut (Addendum 4; the shape of gsd-core's
 * resolveEffectiveBaseRef, mirrored, not required). Layers, first answer wins:
 *   1. <root>/.claude/settings.local.json
 *   2. <root>/.claude/settings.json
 *   3. <homedir>/.claude/settings.json — skipped when it is the same file as layer 2.
 * A layer answers only when its JSON parses and `worktree` is a non-array object with a string
 * `baseRef`; an absent, unreadable, non-regular, oversized or unparseable layer contributes nothing.
 * The result is 'head' only for the exact string 'head', otherwise 'fresh' (the harness default).
 * No other path is ever read, and nothing is written.
 *
 * @param {string} root the gsd-core tree root
 * @param {string} homedir the user's home directory
 * @param {(p:string)=>(string|null)} [readSettings] text of a layer, or null (default: the real fs)
 * @returns {'head'|'fresh'}
 */
function readBaseRef(root, homedir, readSettings) {
  const read = typeof readSettings === 'function' ? readSettings : defaultReadSettings;
  const project = path.join(String(root), '.claude', 'settings.json');
  const layers = [path.join(String(root), '.claude', 'settings.local.json'), project];
  if (typeof homedir === 'string' && homedir !== '') {
    const user = path.join(homedir, '.claude', 'settings.json');
    if (path.resolve(user) !== path.resolve(project)) layers.push(user);
  }
  for (const p of layers) {
    const text = read(p);
    if (typeof text !== 'string') continue;
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    const wt = parsed && typeof parsed === 'object' ? parsed.worktree : undefined;
    if (!wt || typeof wt !== 'object' || Array.isArray(wt)) continue;
    if (typeof wt.baseRef !== 'string') continue;
    return wt.baseRef === 'head' ? 'head' : 'fresh';
  }
  return 'fresh';
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
 * @param {(root:string)=>(string|null)} deps.originUrl `remote get-url origin`, or null (no origin)
 * @param {(root:string)=>void} deps.fetchOrigin bounded fetch; throws FetchUnavailable
 * @param {(root:string)=>(string|null)} deps.currentBranch branch name, or null when detached
 * @param {(root:string, ref:string)=>(string|null)} deps.revParse commit sha or null
 * @param {(root:string, a:string, b:string)=>boolean} deps.isAncestor
 * @param {(root:string, ref:string)=>string[]} deps.worktreesHolding worktree paths holding ref
 * @param {(root:string, ref:string)=>boolean} deps.isSymbolicRef true when `ref` is a symbolic ref
 * @param {(root:string, ref:string)=>{path:string, op:string}[]} deps.nextInProgress worktrees
 *   mid-rebase / mid-bisect of `ref` (op 'rebase' | 'bisect')
 * @param {(root:string, ref:string, newSha:string, oldSha:string)=>boolean} deps.casUpdateRef
 *   Every seam also receives its time slice in ms as a trailing argument (the fetch: its belt).
 * @param {(root:string, homedir:string)=>string} deps.readBaseRef the effective worktree.baseRef
 *   for an EnterWorktree cut ('head' -> HEAD base; anything else -> the origin/next base)
 * @param {Object} [deps.hookEnv] the hook process's own environment (default process.env)
 * @param {()=>number} [deps.now] clock for the per-call deadline (default Date.now)
 * @param {(capMs:number)=>number} [deps.budget] a shared deadline (default: a new one from `now`)
 * @returns {{permissionDecision:string, permissionDecisionReason?:string}}
 */
function gate(stdinString, deps) {
  const input = readHookInput(stdinString);
  if (input && input.tool_name === 'EnterWorktree') return enterWorktree(input, deps);
  const command = (input && input.tool_input && typeof input.tool_input.command === 'string')
    ? input.tool_input.command
    : '';

  // (2) RES-01: the detector is the first short-circuit — nothing below runs for `git status`.
  const entries = findWorktreeAdds(command);
  if (entries.length === 0) return allow();

  // HARD-01: an unattributable trunk-cut mention fails closed (thrown, so override-escapable with
  // a receipt). The reason is a constant: the detector's detail can carry command text or paths.
  if (entries.some((e) => e.kind === 'uncertain')) throw new FailClosed(UNCERTAIN_REASON);

  // 37-02 deferred item 1 (environment half): a redirect inherited by the HOOK process means the
  // real cut runs in a repository the gate cannot see (its own git calls scrub these variables).
  // Only a trunk-naming cut matters; nothing else here does I/O either.
  if (
    hookRedirected(deps) &&
    entries.some((e) => e.kind === 'cut' && TRUNK_KINDS.has(e.baseKind))
  ) {
    throw new FailClosed(UNCERTAIN_REASON);
  }

  const ctx = checkContext(deps);

  // (5) Verdict cache per root (and base kind) within this gate call; first deny wins, an ask is
  // held so a later deny (or throw) still wins.
  const verdicts = new Map();
  let pendingAsk = null;
  for (const e of entries) {
    if (e.kind !== 'cut') continue;
    // (3) No fetch, resolve or git work for a base that does not name the trunk.
    if (!TRUNK_KINDS.has(e.baseKind)) continue;

    const dir = targetDir(e, deps);
    const root = deps.resolveTreeRoot(dir);
    if (root === null || root === undefined) continue;

    const key = root + '\u0000' + e.baseKind;
    if (!verdicts.has(key)) verdicts.set(key, checkCut(e, root, ctx));
    const decision = verdicts.get(key);
    if (!decision) continue;
    if (decision.permissionDecision === 'ask') {
      if (!pendingAsk) pendingAsk = decision;
      continue;
    }
    return decision;
  }
  return pendingAsk || allow();
}

/** True when the HOOK process's own environment carries a repository redirect (HOOK_REDIRECT_VARS). */
function hookRedirected(deps) {
  const hookEnv = deps.hookEnv || process.env;
  return HOOK_REDIRECT_VARS.some((k) => typeof hookEnv[k] === 'string');
}

/** The per-gate-call state checkCut needs: one deadline and one fetch per root. */
function checkContext(deps) {
  return {
    deps,
    budget: typeof deps.budget === 'function' ? deps.budget : makeBudget(deps.now),
    // root -> null (fetched) or the ask decision (origin unobtainable): one fetch per root per call.
    fetchState: new Map(),
    // root -> whether its origin parses as open-gsd/gsd-core (MA-01): one `remote get-url` per root.
    armed: new Map(),
  };
}

/**
 * The EnterWorktree surface (37-05, CONTEXT §Trigger surfaces, v2.8-LOCKED-CONTEXT schema).
 *
 *   `path` a non-empty string -> enters an existing worktree, no cut: allow with zero work.
 *   anything else (`name`, `{}`, a missing / null tool_input, an empty or non-string `path`) -> a
 *   cut on a new branch in the hook cwd's repository. The harness takes its base from
 *   `worktree.baseRef` (no base parameter exists), so the gate reads the same setting:
 *   'head' -> a HEAD base (the trunk only when the current branch is `next`), anything else ->
 *   the origin/next base (fetched, local next untouched). A forged setting changes the harness's
 *   own base the same way, so it cannot steer the check away from the base actually used.
 *
 * The hook-env redirect check applies as for a Bash trunk cut: the harness's own `git worktree add`
 * inherits the same environment, so a GIT_DIR there would cut in a repository the gate cannot see.
 */
function enterWorktree(input, deps) {
  const ti = input.tool_input;
  if (ti && typeof ti === 'object' && typeof ti.path === 'string' && ti.path !== '') return allow();

  if (hookRedirected(deps)) throw new FailClosed(UNCERTAIN_REASON);

  const root = deps.resolveTreeRoot(deps.cwd);
  if (root === null || root === undefined) return allow();

  const mode = deps.readBaseRef(root, deps.homedir);
  const cut = { kind: 'cut', baseKind: mode === 'head' ? 'head' : 'remote' };
  return checkCut(cut, root, checkContext(deps)) || allow();
}

/**
 * The directory a cut runs git in: the start dir (shared walk: `cd` prefixes and the `env -C` /
 * `sudo -D` wrapper chdirs, statically expanded), then each git `-C` in order — `''` is a no-op
 * as in git, anything else is statically expanded (`~`, a leading `$HOME`) and resolved against
 * the running dir. Throws FailClosed when either cannot be resolved statically, BEFORE any resolve,
 * fetch or git call: `<cwd>/$X` is never a safe guess (it is usually not a gsd-core root, so the
 * cut would silently allow on a stale trunk).
 */
function targetDir(e, deps) {
  const ctx = { env: deps.env, homedir: deps.homedir };
  const start = startDirFor(e, deps.cwd, ctx);
  if (start === null) {
    throw new FailClosed(
      'ENF-25 worktree fresh-base gate cannot resolve the target repository statically (an earlier ' +
        '`cd`, `env -C` or `sudo -D` target is a shell expansion, `~user` or `-`) — failing closed. ' +
        'Pass a literal path.'
    );
  }
  let running = start;
  for (const c of e.gitChdirs) {
    if (c === '') continue;
    const expanded = expandStatic(c, ctx);
    if (expanded === null) {
      throw new FailClosed(
        'ENF-25 worktree fresh-base gate cannot resolve a `git -C` directory statically (a shell ' +
          'expansion or `~user`) — failing closed. Pass a literal path to -C.'
      );
    }
    running = path.resolve(running, expanded);
  }
  return running;
}

/** Short sha for reason text. */
function short(sha) {
  return String(sha).slice(0, 10);
}

/** A path as a shell word: bare when it has only safe characters, else single-quoted. */
function shellWord(p) {
  const s = String(p);
  if (/^[A-Za-z0-9_\/.,:@%+=-]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/** The origin/next-based alternative every policy deny offers (already current after the fetch). */
const ORIGIN_ALTERNATIVE = '  git worktree add -b <branch> <path> origin/next';

/**
 * POLICY deny: local next is a strict ancestor of origin/next but checked out in a worktree, so the
 * gate will not move it. The fix fast-forwards it in the holder tree (`merge --ff-only` refuses
 * rather than rewrites when the holder has conflicting changes).
 */
function heldReason(holders, local, remote) {
  const listed = holders.slice(0, 3).map((h) => (h === '' ? '<unknown worktree>' : h));
  const more = holders.length > 3 ? ' (and ' + (holders.length - 3) + ' more)' : '';
  const first = holders[0] ? shellWord(holders[0]) : '<the worktree holding next>';
  return (
    'ENF-25 worktree fresh-base gate: local `next` (' + short(local) + ') is behind origin/next (' +
    short(remote) + ', just fetched by this gate) and is checked out in ' + listed.join(', ') + more +
    ', so the gate will not move it. A worktree cut from it now would start from a stale trunk.\n' +
    'Fast-forward the checked-out trunk first, then re-issue your command:\n' +
    '  git -C ' + first + ' merge --ff-only origin/next\n' +
    'If that working tree has uncommitted changes, park them first with `git stash push -m <msg>` ' +
    '(recoverable), then fast-forward.\n' +
    'Or base the worktree on the remote ref, which is already current:\n' +
    ORIGIN_ALTERNATIVE
  );
}

/**
 * POLICY deny (37-REVIEW BL-02): local next is behind origin/next and no worktree has it checked out,
 * but a worktree is in the middle of a rebase or bisect that started from it (HEAD is detached there,
 * so `worktree list` shows no `branch` line). git's own `branch -f next` refuses the same move
 * (find_shared_symref reads the rebase head-name files and BISECT_START), so the gate does too.
 */
function inProgressReason(entries, local, remote) {
  const listed = entries.slice(0, 3).map((x) => (x.path === '' ? '<unknown worktree>' : x.path) + ' (' +
    (x.op === 'bisect' ? 'bisecting' : 'rebasing') + ')');
  const more = entries.length > 3 ? ' (and ' + (entries.length - 3) + ' more)' : '';
  const first = entries[0] && entries[0].path ? shellWord(entries[0].path) : '<the worktree>';
  const fix = entries[0] && entries[0].op === 'bisect'
    ? '  git -C ' + first + ' bisect reset\n'
    : '  git -C ' + first + ' rebase --continue    (or: rebase --abort)\n';
  return (
    'ENF-25 worktree fresh-base gate: local `next` (' + short(local) + ') is behind origin/next (' +
    short(remote) + ', just fetched by this gate), but a rebase or bisect of `next` is in progress in ' +
    listed.join(', ') + more + ', so the gate will not move it (git itself refuses to move a branch in ' +
    'that state). Finish or abort that operation first, then re-issue your command:\n' + fix +
    'Or base the worktree on the remote ref, which is already current:\n' +
    ORIGIN_ALTERNATIVE
  );
}

/** POLICY deny: neither sha contains the other. Names the divergence; suggests nothing that rewrites. */
function divergedReason(local, remote) {
  return (
    'ENF-25 worktree fresh-base gate: local `next` (' + short(local) + ') and origin/next (' + short(remote) +
    ', just fetched by this gate) have diverged: neither contains the other, so local next cannot be ' +
    'fast-forwarded and a worktree cut from it would not start from the current trunk. Leave local next ' +
    'as it is and base the worktree on the remote ref instead:\n' +
    ORIGIN_ALTERNATIVE
  );
}

/**
 * POLICY deny: the compare-and-swap fast-forward was refused because local next changed between the
 * gate's read and its write (another process moved it). Nothing was changed by the gate.
 */
function casLostReason(local, remote) {
  return (
    'ENF-25 worktree fresh-base gate: local `next` changed while the gate ran (it was ' + short(local) +
    ' when read), so the compare-and-swap fast-forward to origin/next (' + short(remote) +
    ') was refused and not retried; the gate changed nothing. Re-issue your command so the gate ' +
    're-reads next, or base the worktree on the remote ref, which is already current:\n' +
    ORIGIN_ALTERNATIVE
  );
}

/**
 * Freshness for one trunk-naming cut in one gsd-core root: a deny decision, or null (passes).
 *
 *   head   -> the trunk only when the tree's current branch is `next` (read BEFORE any fetch);
 *             otherwise null with no fetch. On `next` it is judged as a local `next` base.
 *   remote -> current after the fetch.
 *   local  -> equal: null. Strict ancestor: held by a worktree -> deny(held), else CAS. origin/next
 *             an ancestor of local (AHEAD, flagged planner refinement, CTK-ADR-0009): null, nothing
 *             moved. Neither: deny(diverged).
 */
function checkCut(e, root, ctx) {
  const { deps, budget, fetchState, armed } = ctx;
  const git = () => budget(GIT_TIMEOUT_MS);
  let kind = e.baseKind;
  if (kind === 'head') {
    if (deps.currentBranch(root, git()) !== 'next') return null;
    kind = 'local';
  }
  // MA-01: the sentinel layout only nominates a root. The gate fetches and moves refs only in a
  // clone whose `origin` parses as open-gsd/gsd-core; any other repository (a vendored sentinel, a
  // fork-only clone, no `origin`) is out of scope: allow with no fetch.
  if (!armed.has(root)) armed.set(root, repoSpecTargetsGsdCore(deps.originUrl(root, git()) || ''));
  if (!armed.get(root)) return null;
  // BL-01: a symbolic next is refused BEFORE any fetch, read or write of it.
  if (kind === 'local' && deps.isSymbolicRef(root, NEXT_REF, git())) throw new FailClosed(SYMREF_REASON);

  if (!fetchState.has(root)) {
    const belt = budget(FETCH_BELT_MS);
    // NARROW catch (Addendum 5): it wraps the fetch call alone, and only the FetchUnavailable
    // class becomes `ask`. A FailClosed (the fetch cannot be bounded), a plain Error, or any
    // throw from another seam reaches runGate and denies.
    try {
      deps.fetchOrigin(root, belt);
      fetchState.set(root, null);
    } catch (err) {
      if (!(err instanceof FetchUnavailable)) throw err;
      fetchState.set(root, ask(fetchUnavailableReason(root, err.message)));
    }
  }
  const unobtainable = fetchState.get(root);
  if (unobtainable) return unobtainable; // nothing below runs: no rev-parse, merge-base or CAS

  const remote = deps.revParse(root, ORIGIN_NEXT_REF, git());
  if (remote === null || remote === undefined) return ask(originNextMissingReason(root));
  if (kind === 'remote') return null; // the fetch made it current

  const local = deps.revParse(root, NEXT_REF, git());
  if (local === null || local === undefined || local === remote) return null;

  if (deps.isAncestor(root, local, remote, git())) {
    const holders = deps.worktreesHolding(root, NEXT_REF, git());
    if (holders.length > 0) return deny(heldReason(holders, local, remote));
    // BL-02: a rebase or bisect of next in any worktree holds it too (git's branch -f rule).
    const busy = deps.nextInProgress(root, NEXT_REF, git());
    if (busy.length > 0) return deny(inProgressReason(busy, local, remote));
    // ONE compare-and-swap attempt. Refused = next moved since it was read: a POLICY deny, never a
    // retry (a retry would act on a value this call did not prove is an ancestor).
    if (deps.casUpdateRef(root, NEXT_REF, remote, local, git())) return null;
    return deny(casLostReason(local, remote));
  }
  if (deps.isAncestor(root, remote, local, git())) return null; // ahead: not stale, nothing to move
  return deny(divergedReason(local, remote));
}

/** fs errors that mean "this state file / dir is absent". */
const ABSENT_CODES = new Set(['ENOENT', 'ENOTDIR']);

function stateReadFailed(p, err) {
  return new FailClosed(
    'ENF-25 worktree fresh-base gate: could not read git state file ' + path.basename(p) + ' (' +
      String((err && err.code) || 'error') + ') — failing closed rather than moving next.'
  );
}

/** A small git state file's text, or null when it is absent; any other error fails closed. */
function readOrNull(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (err) {
    if (err && ABSENT_CODES.has(err.code)) return null;
    throw stateReadFailed(p, err);
  }
}

/** A directory's entry names (sorted), or [] when it is absent; any other error fails closed. */
function readDirOrEmpty(p) {
  try {
    return fs.readdirSync(p).sort();
  } catch (err) {
    if (err && ABSENT_CODES.has(err.code)) return [];
    throw stateReadFailed(p, err);
  }
}

/** realpath of p, or p itself when it cannot be resolved (a label only). */
function realOr(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/** A copy of `base` (plus `extra`) without the variables that would redirect git to another repo. */
function gitEnv(base, extra) {
  const env = Object.assign({}, base, extra || {});
  for (const k of GIT_REDIRECT_VARS) delete env[k];
  return env;
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

/**
 * The real git seams, built on a scrubbed copy of `env` (default process.env): GIT_DIR,
 * GIT_WORK_TREE, GIT_INDEX_FILE and GIT_COMMON_DIR removed, argv only (never a shell), every local
 * call bounded by min(GIT_TIMEOUT_MS, the slice the gate passed, the shared `budget`), the fetch
 * bounded by coreutils `timeout` plus a SIGKILL belt drawn from the same deadline, and SHA_RE
 * checked before merge-base and update-ref. Nothing is spawned until a seam is called.
 *
 * @param {{env?: Object, spawnSync?: Function, budget?: (capMs:number)=>number}} [opts]
 *   `spawnSync` defaults to child_process.spawnSync; `budget` is the gate call's shared deadline
 *   (absent: each call gets its full cap).
 * @returns {{originUrl: Function, fetchOrigin: Function, revParse: Function, currentBranch: Function, isSymbolicRef: Function,
 *   isAncestor: Function, worktreesHolding: Function, nextInProgress: Function, casUpdateRef: Function}}
 */
function createDefaultSeams({ env, spawnSync, budget } = {}) {
  const base = env || process.env;
  const spawn = typeof spawnSync === 'function' ? spawnSync : childProcess.spawnSync;

  /** min(cap, the slice the gate passed, the shared deadline); the deadline throws when spent. */
  function slice(cap, given) {
    let ms = cap;
    if (Number.isFinite(given)) ms = Math.min(ms, given);
    if (typeof budget === 'function') ms = Math.min(ms, budget(cap));
    return ms;
  }

  /** One bounded local git call; a spawn error or timeout fails closed naming the operation. */
  function runGit(dir, args, op, given) {
    const r = spawn('git', args, {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: slice(GIT_TIMEOUT_MS, given),
      env: gitEnv(base),
    });
    if (r.error) {
      throw new FailClosed(
        'ENF-25 worktree fresh-base gate: git ' + op + ' could not run (' + (r.error.code || r.error.message) +
          ') — failing closed.'
      );
    }
    return r;
  }

  /** status 0 + a full sha -> the sha; status 1 -> null; anything else -> FailClosed. */
  function revParse(dir, ref, ms) {
    const r = runGit(dir, ['rev-parse', '--verify', '--quiet', '--end-of-options', ref + '^{commit}'], 'rev-parse', ms);
    if (r.status === 0) {
      const sha = String(r.stdout || '').trim();
      if (SHA_RE.test(sha)) return sha;
      throw new FailClosed('ENF-25 worktree fresh-base gate: git rev-parse returned a non-sha — failing closed.');
    }
    if (r.status === 1) return null;
    throw unexpected('rev-parse', r);
  }

  /**
   * The tree's current branch name, or null when HEAD is detached. Reads the FULL ref
   * (`symbolic-ref --quiet HEAD`) and strips `refs/heads/` itself: `--short` prints the shortest
   * unambiguous name, so a tag named `next` would turn the branch into `heads/next` and the
   * HEAD-on-next check would silently allow. exit 0 -> name (a non-branch symref is returned
   * whole), 1 -> null, else FailClosed.
   */
  function currentBranch(dir, ms) {
    const r = runGit(dir, ['symbolic-ref', '--quiet', 'HEAD'], 'symbolic-ref', ms);
    if (r.status === 0) {
      const ref = String(r.stdout || '').trim();
      return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
    }
    if (r.status === 1) return null;
    throw unexpected('symbolic-ref', r);
  }

  /**
   * BL-01: `git symbolic-ref -q <ref>`: exit 0 (a symbolic ref) -> true, 1 (not a symbolic ref,
   * or missing) -> false, else FailClosed. A git call, not a file read: packed-refs and reftable
   * mean the ref need not be a loose file.
   */
  function isSymbolicRef(dir, ref, ms) {
    const r = runGit(dir, ['symbolic-ref', '-q', '--', ref], 'symbolic-ref', ms);
    if (r.status === 0) return true;
    if (r.status === 1) return false;
    throw unexpected('symbolic-ref', r);
  }

  /** exit 0 -> true, 1 -> false, else FailClosed. */
  function isAncestor(dir, a, b, ms) {
    requireSha('merge-base', a);
    requireSha('merge-base', b);
    const r = runGit(dir, ['merge-base', '--is-ancestor', a, b], 'merge-base', ms);
    if (r.status === 0) return true;
    if (r.status === 1) return false;
    throw unexpected('merge-base', r);
  }

  /** The `worktree <path>` of every porcelain block carrying the exact line `branch <ref>`. */
  function worktreesHolding(dir, ref, ms) {
    const r = runGit(dir, ['worktree', 'list', '--porcelain'], 'worktree list', ms);
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

  /**
   * BL-02: every worktree whose git dir records a rebase or bisect of `ref` — the states in which
   * git's own find_shared_symref treats the branch as checked out although HEAD is detached (so the
   * porcelain has no `branch` line). One git call (`rev-parse --git-common-dir`); the state files are
   * plain reads in the common dir (the main worktree) and in each `worktrees/<id>/` admin dir:
   *   rebase-merge/head-name, rebase-apply/head-name  == ref                      -> rebase
   *   rebase-merge/update-refs                         a line == ref (--update-refs) -> rebase
   *   BISECT_START                                     == ref or its short name     -> bisect
   * A missing file is "not in progress"; any other read error fails closed (when unsure, do not move).
   *
   * @returns {{path:string, op:'rebase'|'bisect'}[]}
   */
  function nextInProgress(dir, ref, ms) {
    const r = runGit(dir, ['rev-parse', '--git-common-dir'], 'rev-parse --git-common-dir', ms);
    const out = String(r.stdout || '').trim();
    if (r.status !== 0 || out === '') throw unexpected('rev-parse --git-common-dir', r);
    const common = path.resolve(dir, out);
    const shortName = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;

    const admins = [{ gitdir: common, wt: path.basename(common) === '.git' ? path.dirname(common) : common }];
    for (const id of readDirOrEmpty(path.join(common, 'worktrees'))) {
      const admin = path.join(common, 'worktrees', id);
      const link = readOrNull(path.join(admin, 'gitdir'));
      admins.push({ gitdir: admin, wt: link ? path.dirname(path.resolve(admin, link.trim())) : '' });
    }

    const found = [];
    for (const a of admins) {
      const headNames = ['rebase-merge/head-name', 'rebase-apply/head-name'].map((f) => readOrNull(path.join(a.gitdir, f)));
      const updateRefs = readOrNull(path.join(a.gitdir, 'rebase-merge', 'update-refs'));
      const rebasing = headNames.some((t) => t !== null && t.trim() === ref) ||
        (updateRefs !== null && updateRefs.split(/\r?\n/).some((l) => l.trim() === ref));
      const bisectStart = readOrNull(path.join(a.gitdir, 'BISECT_START'));
      const bisecting = bisectStart !== null && (bisectStart.trim() === ref || bisectStart.trim() === shortName);
      if (!rebasing && !bisecting) continue;
      found.push({ path: a.wt === '' ? '' : realOr(a.wt), op: rebasing ? 'rebase' : 'bisect' });
    }
    return found;
  }

  /**
   * Compare-and-swap ref move: exit 0 -> true, any other exit -> false (the ref did not hold
   * `oldSha`, so git's ref transaction left it untouched); spawn error -> FailClosed.
   * `--no-deref` (BL-01): never write through a symbolic ref. `--create-reflog` (NI-03): the move
   * is recorded even with core.logAllRefUpdates=false and no existing reflog for the ref.
   */
  function casUpdateRef(dir, ref, newSha, oldSha, ms) {
    requireSha('update-ref', newSha);
    requireSha('update-ref', oldSha);
    const r = runGit(
      dir,
      ['update-ref', '--no-deref', '--create-reflog', '-m', REFLOG_MESSAGE, ref, newSha, oldSha],
      'update-ref',
      ms
    );
    return r.status === 0;
  }

  /**
   * MA-01: `git remote get-url origin`: exit 0 -> the trimmed URL, exit 2 (no such remote) -> null,
   * anything else -> FailClosed. The caller only parses it (repoSpecTargetsGsdCore); it is never
   * passed to another command.
   */
  function originUrl(dir, ms) {
    const r = runGit(dir, ['remote', 'get-url', 'origin'], 'remote get-url', ms);
    if (r.status === 0) return String(r.stdout || '').trim();
    if (r.status === 2) return null;
    throw unexpected('remote get-url', r);
  }

  /**
   * The bounded fetch, hardened (37-04). Absolute dir only (else FailClosed, nothing spawned). Then
   * (the `remote get-url` that used to run first is the originUrl seam since 37-REVIEW MA-01):
   *   1. `timeout -k 2 <s> git -C <dir> <FETCH_ARGV>` (MA-02 explicit refspec), argv only,
   *      with a SIGKILL belt of min(FETCH_BELT_MS, the gate's slice, the shared deadline), the
   *      scrubbed env plus GIT_TERMINAL_PROMPT=0, stdin ignored. <s> is FETCH_TIMEOUT_S, shortened
   *      when the belt is reduced so coreutils kills git before the belt kills `timeout` (a belt
   *      kill reaps only `timeout` and would orphan a git holding the ref lock);
   *   2. classifyFetchResult: ok returns, unavailable throws FetchUnavailable (redacted detail),
   *      error throws FailClosed (no coreutils `timeout` means the fetch cannot be bounded).
   */
  function fetchOrigin(dir, beltMs) {
    if (typeof dir !== 'string' || !path.isAbsolute(dir)) {
      throw new FailClosed('ENF-25 worktree fresh-base gate: fetch target is not an absolute path — failing closed.');
    }
    const belt = slice(FETCH_BELT_MS, beltMs);
    const seconds = Math.max(1, Math.min(FETCH_TIMEOUT_S, Math.floor(belt / 1000) - FETCH_KILL_AFTER_S - 1));
    const r = spawn(
      'timeout',
      ['-k', String(FETCH_KILL_AFTER_S), String(seconds), 'git', '-C', dir, ...FETCH_ARGV],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: belt,
        killSignal: 'SIGKILL',
        env: gitEnv(base, { GIT_TERMINAL_PROMPT: '0' }),
      }
    );
    const graded = classifyFetchResult(r);
    if (graded.state === 'ok') return;
    if (graded.state === 'unavailable') {
      const what = r.status === 124 || r.status === 137 ? 'timed out after ' + seconds + ' s' : graded.detail;
      throw new FetchUnavailable('`git fetch origin next` failed: ' + what);
    }
    throw new FailClosed('ENF-25 worktree fresh-base gate: ' + graded.detail + ' — failing closed.');
  }

  return { originUrl, fetchOrigin, revParse, currentBranch, isSymbolicRef, isAncestor, worktreesHolding, nextInProgress, casUpdateRef };
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
    // The hook's own environment, read for an inherited repository redirect (HOOK_REDIRECT_VARS).
    if (!resolved.hookEnv) resolved.hookEnv = process.env;
    // The effective worktree.baseRef for an EnterWorktree cut, read from the real settings layers.
    if (!resolved.readBaseRef) resolved.readBaseRef = (root, homedir) => readBaseRef(root, homedir);
    // ONE deadline for this gate call, shared by the gate's slices and the default seams.
    if (typeof resolved.budget !== 'function') resolved.budget = makeBudget(resolved.now);
    // The real seams spawn git with the HOOK's environment (scrubbed), not `deps.env`, which only
    // feeds static `cd` / `-C` expansion. Injected seams win.
    const defaults = createDefaultSeams({ env: process.env, budget: resolved.budget });
    for (const k of Object.keys(defaults)) {
      if (!resolved[k]) resolved[k] = defaults[k];
    }
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
  createDefaultSeams,
  classifyFetchResult,
  readBaseRef,
  FetchUnavailable,
  ASK_LIMIT_NOTE,
  MAX_SETTINGS_BYTES,
  FETCH_ARGV,
  FETCH_TIMEOUT_S,
  FETCH_KILL_AFTER_S,
  FETCH_BELT_MS,
  GIT_TIMEOUT_MS,
  GATE_BUDGET_MS,
  HOOK_TIMEOUT_S,
  MIN_CALL_MS,
  MAX_GIT_CALLS_PER_ROOT,
};
