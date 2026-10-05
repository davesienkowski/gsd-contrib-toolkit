#!/usr/bin/env node
'use strict';

/**
 * hooks/binlib-edit.cjs — PreToolUse(Write|Edit) generated-file gate
 * (ENF-03, ADR-457, HARD-01/03 fail-closed, BINLIB-01..04).
 *
 * The #1 zero-source bounce in a gsd-core contribution is editing a GENERATED
 * `bin/lib/*.cjs` artifact instead of its `src/*.cts` source (PROJECT.md, ADR-457):
 * the hand-edit is silently overwritten by the next `build:lib`, so the change looks
 * applied but evaporates. This gate makes that physically impossible. Not every
 * `bin/lib/*.cjs` is generated, though: gsd-core also TRACKS a handful of hand-written
 * `bin/lib/*.cjs` with no `src/` twin (e.g. `capability-validator.cjs`), and generated
 * output is gitignored PER FILE. So the decision runs in two stages.
 *
 * STAGE 1 — candidate filter (pure, cheap). Segment-accuracy (threat T-03-04-SUBSTR /
 * edge-probe EP-1 class): the match is NOT a naive `includes('bin/lib')` substring. A `bin`
 * PATH SEGMENT must be immediately followed by a `lib` SEGMENT (both compared case-insensitively,
 * like the `.cjs` leaf, because a case-insensitive filesystem aliases `BIN/Lib` to `bin/lib`,
 * MN-03), and the `*.cjs` LEAF must sit anywhere BELOW that `lib` (MJ-02: gsd-core emits
 * generated CJS into `bin/lib/observability/`, `bin/lib/installer-migrations/`, … and tracks
 * hand-written vendor files in `bin/lib/vendor/`; git, not depth, tells them apart). So:
 *   - `.../bin/lib/decisions.cjs`            → CANDIDATE (segment pair + .cjs leaf)
 *   - `.../packages/x/bin/lib/foo.cjs`       → CANDIDATE (any depth above the pair)
 *   - `.../bin/lib/sub/nested.cjs`           → CANDIDATE (any depth below the pair)
 *   - `.../BIN/Lib/x.CJS`                    → CANDIDATE (case-insensitive)
 *   - `src/bin-lib-notes.md`                 → ALLOW (substring, not a segment pair)
 *   - `src/mybin/libfoo.cjs`                 → ALLOW (bin/lib split across one segment)
 *   - `.../bin/lib/README.md`                → ALLOW (segment pair but leaf is not .cjs)
 *   - `.../bin/x/lib/y.cjs`                  → ALLOW (bin and lib are not adjacent)
 *   - `.../lib/bin/x.cjs`                     → ALLOW (wrong order: must be bin then lib)
 * The filter runs on the RAW file_path and on the RESOLVED absolute path (T-35-05), so a
 * dot-segment path such as `bin/lib/../lib/x.cjs` or `bin/lib/./x.cjs` still becomes a
 * candidate. A raw-only candidate whose `..` segments resolve out of bin/lib has no bin/lib
 * ancestor to check in Stage 2 and is denied as undecidable. A non-candidate is ALLOWED without
 * running git.
 *
 * STAGE 2 — discriminator: `git check-ignore -q -- <abs>` (argv array, no shell, `--` before
 * the path), run with cwd = the target's own directory. Plain check-ignore (no --no-index): a
 * TRACKED file is reported not-ignored even when a pattern matches it — tracked means
 * hand-written.
 *
 * REPOSITORY PINNING (MJ-01, 35-02). check-ignore answers for whatever repository git DISCOVERS
 * from the target's directory, and in-repo state that never shows in `git status` can move that
 * discovery to a repository that does not ignore the emitted file: a nested `git init` in
 * bin/lib, a planted `gitdir:` file at bin/lib/.git or bin/.git, or a repo-local core.worktree
 * that re-roots the work tree so the root-anchored per-file .gitignore line no longer matches.
 * Each of those turned exit 0 into exit 1 (an allow). So before check-ignore runs, with `bin` =
 * the outermost `bin` directory of a bin/lib pair above the target:
 *   - a `.git` entry (file, directory or link) in any directory from the target's directory up
 *     to and including `bin`                                         → undecidable
 *   - `git rev-parse --show-toplevel` (same cwd, same scrubbed env) is not a STRICT ancestor of
 *     realpath(`bin`) (equal to it, inside it, or unrelated)         → undecidable
 *   - TOP (that toplevel) is NESTED: some directory strictly above TOP holds a `.git` entry
 *     (the nearest one is A), and TOP is not a genuine linked worktree of A's repository. Genuine
 *     means TOP/.git is a FILE whose `gitdir:` realpath is <A's common git dir>/worktrees/<name>,
 *     and that worktrees/<name>/gitdir file points back to realpath(TOP/.git). A's common git
 *     dir is A/.git when it is a directory. When A is itself a linked worktree (A/.git is a
 *     file), it is the dir that file's `gitdir:` names, or that dir's `commondir`. This covers
 *     harness worktrees under <repo>/.claude/worktrees/ and under an Orca worktree. An
 *     independent nested repo (TOP/.git a directory) or any other gitdir file at or above `bin`
 *     inside an enclosing repo                                       → undecidable
 *     (MJ-01 variant: a `gitdir:` file or `git init` at <repo>/gsd-core, one level above `bin`)
 *   - `git config --get core.worktree` (same cwd and env) is set, or gives any answer other than
 *     "unset" (exit 1)                                               → undecidable
 * realpath(`bin`) is compared because git realpaths the toplevel; a repository reached through
 * a symlinked root therefore keeps its normal verdict.
 *
 *   - exit 0 (ignored → generated)                         → DENY, ADR-457 reason unchanged
 *   - exit 1 (tracked, or untracked and not ignored)       → ALLOW
 *   - anything else: spawn error, git missing, timeout or null status, exit 128 (not a git
 *     work tree), directory absent, a repository-pinning failure above, or an injected seam
 *     value other than 'not-ignored'                       → DENY, ADR-457 reason + a
 *     "could not be determined" note (HARD-01, BINLIB-03). Returned as a policy deny, exactly
 *     like the pre-v2.8 deny-all behavior, so GSD_CONTRIB_OVERRIDE (thrown errors only) cannot
 *     flip it.
 * All git spawns share ONE deadline of CHECK_IGNORE_TIMEOUT_MS = 3000 ms, well under this gate's
 * 10 s hook timeout in settings.snippet.json, so a hung git resolves to the undecidable deny and
 * the first non-answer stops the remaining probes. Every probe is read-only (no index lock), so
 * concurrent or interrupted invocations cannot mutate a repo.
 *
 * ENV SCRUB (T-35-02, MN-01): the probe runs with GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE and
 * GIT_COMMON_DIR removed. Measured 2026-10-05: an inherited GIT_INDEX_FILE pointing at an
 * alternate index with the emitted file force-added makes check-ignore exit 1, a fail-open.
 * GIT_GLOB_PATHSPECS, GIT_NOGLOB_PATHSPECS, GIT_ICASE_PATHSPECS, GIT_LITERAL_PATHSPECS and
 * GIT_CEILING_DIRECTORIES are removed too. Measured 2026-10-05 (git 2.43): each pathspec mode
 * makes check-ignore exit 128 ("pathspec magic not supported by this command"), and a ceiling
 * at or above the repo root stops discovery (exit 128). Either way every candidate was
 * false-denied, including tracked hand-written files.
 *
 * DIVERGENCE (recorded): the discriminator idea comes from Trek-e's
 * `emitted-cjs-read-guard.cjs`, which fails OPEN when git cannot answer. This gate fails
 * CLOSED per CTK-ADR-0001 §Decision.2: an unanswerable probe never becomes an allow.
 *
 * ACCEPTED RESIDUAL (flagged assumption A-01, threat T-35-07): "hand-written" means tracked or
 * not ignored. A newly generated .cjs whose per-file .gitignore line has not been added yet is
 * ALLOWED, as is a generated file force-added to the index or un-ignored by a .gitignore edit.
 * Each of those routes leaves a visible .gitignore or index change in the contribution diff.
 * The verdict still depends on git's repository discovery. The pinning checks above close the
 * known invisible routes into a different repository (nested repo, `gitdir:` file, core.worktree)
 * at or below `bin`, and, inside an enclosing repository, above it too. Not covered: hand-crafting
 * a fake linked-worktree entry inside the enclosing repo's own `.git/worktrees/` (git refuses
 * `worktree add` on the non-empty package dir, so this needs direct writes under `.git/`), and a
 * repository whose OUTERMOST boundary is planted above the real one. A `.git` entry is not itself a candidate, so the Write that plants one is
 * allowed, but the Edit of the emitted file that follows is denied. Not covered (pre-existing):
 * a symlink OUTSIDE bin/lib that names an emitted file (e.g. `/tmp/x.cjs -> …/bin/lib/e.cjs` or
 * `bin/lib2 -> lib`) is never a candidate, and Bash writes are outside this gate's Write/Edit
 * scope.
 *
 * HARD-01/03: the whole decision runs inside runGate, so a malformed payload, an absent
 * or non-string `file_path`, or any thrown error FAILS CLOSED (deny) — escapable only by
 * a deliberate, logged GSD_CONTRIB_OVERRIDE.
 *
 * TOOL_NAME SELF-FILTER (defense-in-depth layer 2): this gate governs ONLY `Write` and `Edit`.
 * The canonical `settings.snippet.json`/manifest matcher scopes it to `Write|Edit`, but if it is
 * ever installed CATCH-ALL (no matcher), it also receives `Bash`/`Read`/etc. payloads that
 * legitimately carry no `file_path`. Those must short-circuit to ALLOW *before* the file_path
 * check — otherwise every Bash call trips the Write/Edit HARD-01 fail-closed and blocks all work.
 * The HARD-01 fail-closed is UNWEAKENED for the tools this gate actually governs: a Write/Edit
 * with an absent/non-string file_path still DENIES.
 *
 * @module hooks/binlib-edit
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runGate, readHookInput, deny, allow, emit, FailClosed } = require('./lib/failclosed.cjs');

// FailClosed: shared IN-03 helper from failclosed.cjs (binlib-edit has no safeCommand —
// it uses safeFilePath; Write/Edit gates read file_path, not command).

/**
 * Upper bound for the `git check-ignore` probe. The settings.snippet.json hook timeout for
 * this gate is 10 s; the probe is capped well under it so a hung git resolves to a deny
 * instead of the harness killing the hook.
 */
const CHECK_IGNORE_TIMEOUT_MS = 3000;

/**
 * Inherited variables the probe never sees. The first four redirect git to a different
 * repository, work tree or index, which could make the probe answer for something other than the
 * file's own repository (an alternate GIT_INDEX_FILE with the emitted file force-added turns
 * exit 0 into exit 1; T-35-02). The rest change how git reads the path or finds the repository:
 * the four pathspec modes make check-ignore exit 128, and GIT_CEILING_DIRECTORIES can stop
 * discovery before the repo root. Either way every candidate would be false-denied (MN-01).
 */
const REPO_REDIRECT_ENV = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_GLOB_PATHSPECS',
  'GIT_NOGLOB_PATHSPECS',
  'GIT_ICASE_PATHSPECS',
  'GIT_LITERAL_PATHSPECS',
  'GIT_CEILING_DIRECTORIES',
];

/**
 * A shallow copy of env with exactly the REPO_REDIRECT_ENV keys removed. Every other variable,
 * including other GIT_* config such as GIT_CONFIG_GLOBAL, is kept.
 *
 * @param {Object} env
 * @returns {Object}
 */
function probeEnv(env) {
  const out = Object.assign({}, env);
  for (const k of REPO_REDIRECT_ENV) delete out[k];
  return out;
}

/**
 * Split a path into its segments, tolerant of either separator (the harness may hand us a
 * POSIX or a Windows-ish path). Empty segments (from leading/trailing/double separators)
 * are dropped so a trailing slash cannot smuggle a fake leaf.
 *
 * @param {string} filePath
 * @returns {string[]}
 */
function pathSegments(filePath) {
  return String(filePath)
    .split(/[\\/]+/)
    .filter((s) => s.length > 0);
}

/**
 * Is this file_path a candidate generated `**\/bin/lib/**\/*.cjs` artifact, by SEGMENT-accurate
 * match?
 *
 * Requires a `bin` segment immediately followed by a `lib` segment (case-insensitive, MN-03),
 * with a `*.cjs` leaf (case-insensitive) as the LAST segment somewhere below that `lib` (MJ-02).
 * Never a naive substring test.
 *
 * @param {string} filePath
 * @returns {boolean}
 */
function isGeneratedBinLib(filePath) {
  const segs = pathSegments(filePath);
  // Need at least bin / lib / leaf, with the leaf as the LAST segment.
  if (segs.length < 3) return false;
  const leaf = segs[segs.length - 1];
  if (typeof leaf !== 'string' || !leaf.toLowerCase().endsWith('.cjs')) return false;
  // A bin/lib pair with at least the leaf after it (i + 2 <= last index).
  for (let i = 0; i + 2 < segs.length; i++) {
    if (segs[i].toLowerCase() === 'bin' && segs[i + 1].toLowerCase() === 'lib') return true;
  }
  return false;
}

/**
 * The ENF-03 / ADR-457 deny reason — point the author at the `src/*.cts` source.
 *
 * @param {string} filePath
 * @returns {string}
 */
function binLibDenyReason(filePath) {
  return (
    'This file is a GENERATED artifact (`' +
    filePath +
    '`). Editing a `bin/lib/*.cjs` by hand is overwritten by the next `build:lib` ' +
    '(ADR-457: generated CJS has a single source). Edit the `src/*.cts` source instead, ' +
    'then run `build:lib` to regenerate. (ENF-03)'
  );
}

/**
 * The BINLIB-03 deny reason for a candidate whose generated/hand-written status could not be
 * determined: the full ADR-457 reason, unchanged, with an explanatory note appended.
 *
 * @param {string} filePath
 * @returns {string}
 */
function binLibUndecidableReason(filePath) {
  return (
    binLibDenyReason(filePath) +
    ' Whether it is generated or hand-written could not be determined (git check-ignore gave ' +
    'no answer: directory absent, not a git work tree, a nested or redirected repository at or ' +
    'below bin/, git missing or erroring, or timed out), so it is treated as generated ' +
    '(fail-closed, HARD-01 / BINLIB-03).'
  );
}

/**
 * Resolve the Write/Edit target to an absolute, normalized path. An absolute file_path is
 * normalized as-is; a relative one is resolved against the payload `cwd`, falling back to
 * process.cwd() when the payload carries none.
 *
 * @param {string} filePath
 * @param {string} [payloadCwd]
 * @returns {string}
 */
function resolveTargetPath(filePath, payloadCwd) {
  if (path.isAbsolute(filePath)) return path.resolve(filePath);
  const base = typeof payloadCwd === 'string' && payloadCwd.length > 0 ? payloadCwd : process.cwd();
  return path.resolve(base, filePath);
}

/**
 * Map a `git check-ignore -q` spawnSync result to a verdict. Exit 0 = ignored (generated),
 * exit 1 = not ignored (tracked, or untracked and not ignored: hand-written). Everything else
 * (spawn error, null status from a timeout/signal, 128 "not a git repository", any other
 * code) is 'unknown'.
 *
 * @param {{error?:Error, status?:(number|null)}} result
 * @returns {'ignored'|'not-ignored'|'unknown'}
 */
function classifyCheckIgnore(result) {
  if (!result || result.error) return 'unknown';
  if (result.status === 0) return 'ignored';
  if (result.status === 1) return 'not-ignored';
  return 'unknown';
}

/**
 * The OUTERMOST ancestor directory of absPath named `bin` (case-insensitive) whose child on the
 * path is named `lib`, with absPath somewhere below that `lib`. null when there is none (a
 * raw-only candidate whose `..` segments resolved out of bin/lib).
 *
 * @param {string} absPath
 * @returns {string|null}
 */
function binDirOf(absPath) {
  let found = null;
  let child = path.dirname(absPath);
  let parent = path.dirname(child);
  while (parent !== child) {
    if (
      path.basename(parent).toLowerCase() === 'bin' &&
      path.basename(child).toLowerCase() === 'lib'
    ) {
      found = parent;
    }
    child = parent;
    parent = path.dirname(parent);
  }
  return found;
}

/**
 * Does any directory from startDir up to and including stopDir hold a `.git` entry of any type
 * (MJ-01)? Any lstat error other than "absent" counts as present (fail-closed). Reaching the
 * filesystem root without meeting stopDir also counts as present.
 *
 * @param {string} startDir
 * @param {string} stopDir
 * @returns {boolean}
 */
function hasGitEntryUpTo(startDir, stopDir) {
  let d = startDir;
  for (;;) {
    try {
      fs.lstatSync(path.join(d, '.git'));
      return true;
    } catch (err) {
      if (!err || (err.code !== 'ENOENT' && err.code !== 'ENOTDIR')) return true;
    }
    if (d === stopDir) return false;
    const up = path.dirname(d);
    if (up === d) return true;
    d = up;
  }
}

/**
 * Does `p` exist as an entry of any type? Any lstat error other than "absent" counts as present
 * (fail-closed).
 *
 * @param {string} p
 * @returns {boolean}
 */
function entryExists(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch (err) {
    return !err || (err.code !== 'ENOENT' && err.code !== 'ENOTDIR');
  }
}

/**
 * The nearest directory STRICTLY above `dir` that holds a `.git` entry, or null.
 *
 * @param {string} dir
 * @returns {string|null}
 */
function nearestEnclosingRepo(dir) {
  let d = path.dirname(dir);
  for (;;) {
    if (entryExists(path.join(d, '.git'))) return d;
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
}

/**
 * The directory named by a `.git` file's `gitdir:` line, resolved against the file's directory.
 * Throws when the file has no such line.
 *
 * @param {string} gitFile
 * @returns {string}
 */
function readGitdirFile(gitFile) {
  const m = /^gitdir:[ \t]*(.+?)[ \t]*$/m.exec(fs.readFileSync(gitFile, 'utf8'));
  if (!m) throw new Error('no gitdir line in ' + gitFile);
  return path.resolve(path.dirname(gitFile), m[1]);
}

/**
 * realpath of repository A's common git dir: A/.git when it is a directory; for a linked
 * worktree (A/.git a file), its gitdir's `commondir`, else the gitdir itself.
 *
 * @param {string} repoDir
 * @returns {string}
 */
function commonGitDirOf(repoDir) {
  const dotGit = path.join(repoDir, '.git');
  if (fs.lstatSync(dotGit).isDirectory()) return fs.realpathSync(dotGit);
  const gitdir = readGitdirFile(dotGit);
  const commondirFile = path.join(gitdir, 'commondir');
  if (entryExists(commondirFile)) {
    const rel = fs.readFileSync(commondirFile, 'utf8').trim();
    return fs.realpathSync(path.resolve(gitdir, rel));
  }
  return fs.realpathSync(gitdir);
}

/**
 * MJ-01 variant: is the discovered toplevel `top` safe with respect to enclosing repositories?
 * True when no directory strictly above `top` holds a `.git` entry, or when `top` is a genuine
 * linked worktree of the nearest enclosing repository A. Genuine means top/.git is a file whose
 * gitdir realpath is <A common dir>/worktrees/<name>, and that entry's `gitdir` file points back
 * to realpath(top/.git). Anything else, including any error, is false (fail-closed).
 *
 * @param {string} top
 * @returns {boolean}
 */
function enclosingRepoAllows(top) {
  try {
    const enclosing = nearestEnclosingRepo(top);
    if (enclosing === null) return true;
    const topGit = path.join(top, '.git');
    if (!fs.lstatSync(topGit).isFile()) return false;
    const gitdir = fs.realpathSync(readGitdirFile(topGit));
    if (path.dirname(gitdir) !== path.join(commonGitDirOf(enclosing), 'worktrees')) return false;
    const back = fs.readFileSync(path.join(gitdir, 'gitdir'), 'utf8').trim();
    return fs.realpathSync(path.resolve(gitdir, back)) === fs.realpathSync(topGit);
  } catch (_) {
    return false;
  }
}

/**
 * Is `ancestor` a STRICT ancestor directory of `descendant`?
 *
 * @param {string} ancestor
 * @param {string} descendant
 * @returns {boolean}
 */
function isStrictAncestor(ancestor, descendant) {
  if (typeof ancestor !== 'string' || ancestor.length === 0) return false;
  const rel = path.relative(ancestor, descendant);
  return (
    rel.length > 0 && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel)
  );
}

/**
 * One read-only git spawn against the shared deadline. null when the deadline has passed.
 *
 * @param {string[]} argv
 * @param {string} cwd
 * @param {Object} env
 * @param {number} deadline epoch ms
 * @returns {Object|null} spawnSync result
 */
function runGitProbe(argv, cwd, env, deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return null;
  return spawnSync('git', argv, {
    cwd,
    timeout: remaining,
    encoding: 'utf8',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * The default probe. It first PINS the repository (MJ-01): no `.git` entry between the target's
 * directory and the bin/lib pair's `bin`, a discovered toplevel that is a strict ancestor of
 * realpath(`bin`) and is not nested inside an enclosing repository unless it is a genuine linked
 * worktree of it (enclosingRepoAllows), and no core.worktree. Only then does it run `git check-ignore -q -- <abs>`
 * from the target's own directory. argv arrays, never a shell string; `--` before the path.
 * Plain check-ignore (no --no-index), so a TRACKED file reports not-ignored even when a pattern
 * matches it. Read-only: takes no index lock. Every spawn runs with the repo-redirecting
 * variables scrubbed (probeEnv) and against one shared CHECK_IGNORE_TIMEOUT_MS deadline; the
 * first non-answer returns 'unknown' without running the rest.
 *
 * @param {string} absPath
 * @returns {'ignored'|'not-ignored'|'unknown'}
 */
function checkIgnoreLive(absPath) {
  try {
    const deadline = Date.now() + CHECK_IGNORE_TIMEOUT_MS;
    const cwd = path.dirname(absPath);
    const env = probeEnv(process.env);

    const binDir = binDirOf(absPath);
    if (binDir === null) return 'unknown';
    if (hasGitEntryUpTo(cwd, binDir)) return 'unknown';
    const realBin = fs.realpathSync(binDir);

    const top = runGitProbe(['rev-parse', '--show-toplevel'], cwd, env, deadline);
    if (!top || top.error || top.status !== 0) return 'unknown';
    const toplevel = String(top.stdout).replace(/\r?\n$/, '');
    if (!isStrictAncestor(toplevel, realBin)) return 'unknown';
    if (!enclosingRepoAllows(toplevel)) return 'unknown';

    const worktree = runGitProbe(['config', '--get', 'core.worktree'], cwd, env, deadline);
    if (!worktree || worktree.error || worktree.status !== 1) return 'unknown';

    const result = runGitProbe(['check-ignore', '-q', '--', absPath], cwd, env, deadline);
    if (!result) return 'unknown';
    return classifyCheckIgnore(result);
  } catch (_) {
    return 'unknown';
  }
}

/**
 * The pure gate decision over a PreToolUse(Write|Edit) payload.
 *
 * @param {string} stdinString raw PreToolUse JSON
 * @param {Object} [deps]
 * @param {(absPath:string) => string} [deps.checkIgnore] probe seam (default checkIgnoreLive)
 * @returns {{permissionDecision:string, permissionDecisionReason?:string}}
 */
function gate(stdinString, deps = {}) {
  const input = readHookInput(stdinString); // throws on malformed JSON → fail closed

  // SELF-FILTER (defense-in-depth): this gate governs ONLY Write|Edit. Any other tool (Bash,
  // Read, …) has no bin/lib file_path to evaluate — short-circuit to ALLOW before the file_path
  // check so a catch-all install can never trip the Write/Edit HARD-01 on a Bash payload.
  const toolName = input.tool_name;
  if (toolName !== 'Write' && toolName !== 'Edit') {
    return allow();
  }

  const toolInput = input.tool_input || {};
  const filePath = toolInput.file_path;

  // An Edit/Write with no observable file_path cannot be evaluated — fail closed (HARD-01).
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new FailClosed(
      'PreToolUse(Write|Edit) carried no string file_path — failing closed (HARD-01)'
    );
  }

  // Stage 1: the segment matcher picks candidates, on the raw AND the resolved path (T-35-05).
  // A non-candidate never reaches git.
  const abs = resolveTargetPath(filePath, input.cwd);
  if (!isGeneratedBinLib(filePath) && !isGeneratedBinLib(abs)) {
    return allow();
  }

  // Stage 2: git decides. Only the exact verdict 'not-ignored' (tracked, or untracked and not
  // ignored = hand-written) allows. 'ignored' is the unchanged ADR-457 deny; every other answer
  // is undecidable and denies with the note (HARD-01, BINLIB-03).
  const checkIgnore = deps.checkIgnore || checkIgnoreLive;
  const verdict = checkIgnore(abs);
  if (verdict === 'not-ignored') {
    return allow();
  }
  if (verdict === 'ignored') {
    return deny(binLibDenyReason(filePath));
  }
  return deny(binLibUndecidableReason(filePath));
}

/**
 * Injectable entry seam. Mirrors the other gates: deps carry the worktreeRoot + override
 * impl so runGate can record/honor a logged override, and the unit suite stays hermetic.
 *
 * @param {string} stdinString raw PreToolUse JSON
 * @param {Object} [deps]
 * @param {string} [deps.worktreeRoot]
 * @param {{checkOverride:Function, writeReceipt:Function}} [deps.overrideImpl]
 * @param {(absPath:string) => ('ignored'|'not-ignored'|'unknown')} [deps.checkIgnore]
 *   generated-vs-hand-written probe (default checkIgnoreLive: `git check-ignore -q -- <abs>`).
 *   Only the exact string 'not-ignored' allows; any other value, or a throw, denies.
 * @returns {{permissionDecision:string, permissionDecisionReason?:string}}
 */
function runBinlibGate(stdinString, deps = {}) {
  const ctx = {
    command: safeFilePath(stdinString),
    action: 'binlib-edit',
    // OBS-02: read ONLY for session/tool ids in the verdict log; never logged verbatim.
    stdin: stdinString,
    worktreeRoot: deps.worktreeRoot,
    overrideImpl: deps.overrideImpl,
  };
  return runGate(() => gate(stdinString, deps), ctx);
}

/**
 * Best-effort extract of the file_path for the override receipt (never throws).
 *
 * @param {string} stdinString
 * @returns {string}
 */
function safeFilePath(stdinString) {
  try {
    const o = JSON.parse(stdinString);
    const fp = o && o.tool_input && o.tool_input.file_path;
    return typeof fp === 'string' ? fp : '';
  } catch (_) {
    return '';
  }
}

function main() {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => {
    buf += c;
  });
  process.stdin.on('end', () => {
    emit(runBinlibGate(buf));
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  runBinlibGate,
  gate,
  isGeneratedBinLib,
  binLibDenyReason,
  pathSegments,
  resolveTargetPath,
  classifyCheckIgnore,
  checkIgnoreLive,
  binDirOf,
  hasGitEntryUpTo,
  isStrictAncestor,
  enclosingRepoAllows,
  probeEnv,
  binLibUndecidableReason,
  CHECK_IGNORE_TIMEOUT_MS,
  REPO_REDIRECT_ENV,
};
