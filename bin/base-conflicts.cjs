#!/usr/bin/env node
'use strict';

/**
 * bin/base-conflicts.cjs - which files of a branch conflict with the base, and which commits on each side
 * touched them (read-only).
 *
 * Why: the 2026-10-23 sweep of open-gsd/gsd-core#5192 found the conflicting files by hand (gsd-core-notes
 * sweep-2026-10-23/pr-5192-scriptable.md item 4, quick 261023-2u4 CONTEXT D3): a trial merge, the conflicting
 * paths, then a log per path on each side. This prints that answer. It NEVER fetches, checks out, merges,
 * rebases or writes a ref, the index or a worktree: a missing base ref is reported with the fetch command
 * for Dave to run.
 *
 *   node bin/base-conflicts.cjs [--json] [--offline] [--cwd <checkout>] [--base <ref>] [--head <ref>] [--repo owner/name --pr <n>]
 *
 * CONTRACT - read-only. Git reads, all as `git -C <cwd>` (default: the process cwd):
 *   1. git rev-parse --path-format=absolute --git-common-dir      (where the repo's objects live)
 *   2. git rev-parse --verify --quiet <ref>^{commit}               (base and head, each resolved ONCE to a sha;
 *      every later read uses the shas, so a ref moved by a fetch during the run is not seen; R7)
 *   3. git merge-base <base sha> <head sha>
 *   4. git rev-list --left-right --count <base sha>...<head sha>  (left = only on the base = behind, right =
 *      only on the head = ahead)
 *   5. git merge-tree --write-tree --name-only --no-messages -z <base sha> <head sha>   with
 *      GIT_OBJECT_DIRECTORY=<a fresh temp dir> and GIT_ALTERNATE_OBJECT_DIRECTORIES=<common dir>/objects, so
 *      the merge's new objects go to the temp dir (removed afterwards). git writes no new object to the repo's
 *      store, but may refresh the mtime of objects the repo already holds (utime only, no content change; round 3
 *      review F1). Refs, the index and the worktree are untouched. -z reads a path with a quote, backslash, newline or non-ASCII byte verbatim (R7)
 *   6. per conflicting path (the first 50) and side: git log -n 10 --format=%h %s <merge base>..<side sha> --
 *      <path>, and git rev-list --count <merge base>..<side sha> -- <path> for "+K more"
 *   7. git remote -v (exact form), with --pr and no --base, and for the base-tip check below
 *   8. git ls-remote <remote> refs/heads/<branch>   (exact form; reads the remote, changes no local ref) when the
 *      base ref is <remote>/<branch> for a configured remote and --offline is not given: the remote's tip is
 *      compared with the local base sha, and a local base that is not the remote tip is named with the fetch
 *      for Dave (the conflict answer is for the local base). --offline skips it. (round 3 review: a stale
 *      local origin/next read "clean" with no hint that next had moved)
 * plus, only with --pr, ONE gh read: gh api "repos/R/pulls/N" (REST GET: base.ref and head.sha), to default the
 * base to <remote>/<base.ref> for the first remote (in `git remote -v` order) whose fetch URL names R, and to
 * warn when the head is not the PR's head sha or the base ref names another branch.
 * The default git runner allows only rev-parse, merge-base, merge-tree, log, rev-list, the exact argv
 * `remote -v` and `ls-remote <remote> refs/heads/<branch>` (no name starting with -), and throws before
 * spawning for anything else. It drops GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE,
 * GIT_COMMON_DIR, GIT_OBJECT_DIRECTORY and GIT_ALTERNATE_OBJECT_DIRECTORIES from the inherited env (so -C
 * decides the repo), and sets GIT_TERMINAL_PROMPT=0, GIT_LITERAL_PATHSPECS=1 (a path is never pathspec
 * magic) and GIT_NO_LAZY_FETCH=1 (no on-demand blob fetch in a partial clone; git 2.44+, so on older git
 * "never fetches" holds in a full clone only). A --base or --head value or a remote name starting with - never reaches git. No gh write verb, no
 * `gh api -X/--method/-f/-F/--input`, no `gh api graphql`. Node built-ins only; argv arrays, no shell.
 *
 * Exit: 0 clean, 3 conflicts, 1 a read failed / a ref is missing / no remote names the repo, 2 usage.
 *
 * @module bin/base-conflicts
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');

const { parseRemotes, parseRemoteUrl } = require('./push-target.cjs');
const { clean, firstErrorLine } = require('./pr-status.cjs');

const DEFAULT_REPO = 'open-gsd/gsd-core';
const DEFAULT_BASE = 'origin/next';
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const REF_PATTERN = /^[A-Za-z0-9._\/@{}^~-]+$/; // a ref, sha or rev expression; never a leading - (checked apart)
const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._\/-]*$/; // the push-target rule: no leading -
const BRANCH_PATTERN = /^[A-Za-z0-9._\/-]+$/;
const GIT_READ_VERBS = new Set(['rev-parse', 'merge-base', 'merge-tree', 'log', 'rev-list']);
const SCRUBBED_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES'];
const ALLOWED_EXTRA_ENV = new Set(['GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']);
const MAX_COMMITS = 10; // per path and side
const MAX_PATHS_WITH_COMMITS = 50; // per-path commit lists for the first 50 paths only (T-2u4-06)
const MAX_BUFFER = 64 * 1024 * 1024;
const USAGE =
  'usage: base-conflicts [--json] [--offline] [--cwd <checkout>] [--base <ref>] [--head <ref>] [--repo owner/name --pr <n>]  (default base ' +
  DEFAULT_BASE +
  ', or <remote>/<PR base> with --pr; default head HEAD; default repo ' +
  DEFAULT_REPO +
  ')';

function defaultGh(args) {
  const out = execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
  return JSON.parse(out);
}

/**
 * Default git runner: the read verbs only (and `remote -v` exactly), argv array, no shell; throws BEFORE
 * spawning for anything else. extraEnv may set only the two object-directory variables (the merge-tree read).
 *
 * @returns {{status: number, stdout: string, stderr: string}}
 */
/** The env of every git call: the inherited env minus the repo-redirecting variables, plus the safety settings. */
function gitEnv(extraEnv) {
  const env = Object.assign({}, process.env);
  for (const k of SCRUBBED_ENV) delete env[k];
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_LITERAL_PATHSPECS = '1';
  // In a partial (promisor) clone, merge-tree, log and rev-list would fetch missing blobs on demand; this turns
  // that off (git 2.44 and later honour it; older git ignores it), so "never fetches" holds there too (review F2).
  env.GIT_NO_LAZY_FETCH = '1';
  for (const [k, v] of Object.entries(extraEnv || {})) {
    if (!ALLOWED_EXTRA_ENV.has(k)) throw new Error(`base-conflicts refuses to set ${k} for git`);
    env[k] = String(v);
  }
  return env;
}

function defaultGit(args, cwd, extraEnv) {
  const list = Array.isArray(args) ? args.map(String) : [];
  const remoteList = list.length === 2 && list[0] === 'remote' && list[1] === '-v';
  const lsRemote = list.length === 3 && list[0] === 'ls-remote' && REMOTE_NAME.test(list[1]) && /^refs\/heads\/[A-Za-z0-9._\/][A-Za-z0-9._\/-]*$/.test(list[2]) && !list[2].slice('refs/heads/'.length).startsWith('-');
  if (!remoteList && !lsRemote && !GIT_READ_VERBS.has(list[0])) throw new Error(`base-conflicts refuses git ${list.slice(0, 2).join(' ')}: read verbs only`);
  const env = gitEnv(extraEnv);
  const r = spawnSync('git', ['-C', String(cwd), ...list], { encoding: 'utf8', timeout: 120000, maxBuffer: MAX_BUFFER, env });
  if (r.error) throw r.error;
  return { status: r.status, stdout: String(r.stdout || ''), stderr: String(r.stderr || '') };
}

/** Byte-order comparison of two paths (git's order), independent of the order git emitted them in. */
function byteOrder(a, b) {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** Parse `merge-tree --name-only -z` stdout: the tree oid, then NUL-terminated paths (de-duplicated, sorted). */
function parseMergeTree(stdout) {
  const parts = String(stdout || '').split('\0');
  const tree = parts.shift() || '';
  const paths = [...new Set(parts.filter((p) => p !== ''))].sort(byteOrder);
  return { tree, paths };
}

/** `remote/branch` -> the fetch command for Dave; a ref with no / -> null. */
function fetchHint(ref) {
  const at = String(ref).indexOf('/');
  if (at <= 0) return null;
  const remote = ref.slice(0, at);
  const branch = ref.slice(at + 1);
  if (!REMOTE_NAME.test(remote) || !BRANCH_PATTERN.test(branch) || branch.startsWith('-')) return null;
  return `git fetch ${remote} ${branch}`;
}

/** Parse argv into options, { help } or { usageError }. */
function parseArgs(argv) {
  const o = { json: false, offline: false, cwd: null, base: null, head: null, repo: DEFAULT_REPO, repoGiven: false, pr: null };
  const list = Array.isArray(argv) ? argv.map(String) : [];
  if (list.some((a) => a === '--help' || a === '-h')) return { help: true };
  for (let i = 0; i < list.length; i += 1) {
    const a = list[i];
    const value = (name) => (a === name ? list[++i] : a.slice(name.length + 1));
    if (a === '--json') o.json = true;
    else if (a === '--offline') o.offline = true;
    else if (a === '--cwd' || a.startsWith('--cwd=')) {
      const v = value('--cwd');
      if (v == null || v === '') return { usageError: 'bad --cwd value' };
      o.cwd = v;
    } else if (a === '--base' || a.startsWith('--base=') || a === '--head' || a.startsWith('--head=')) {
      const name = a.startsWith('--base') ? '--base' : '--head';
      const v = value(name);
      if (v == null || v.startsWith('-') || !REF_PATTERN.test(v)) return { usageError: `bad ${name} value: ${clean(v)}` };
      o[name.slice(2)] = v;
    } else if (a === '--repo' || a.startsWith('--repo=')) {
      const v = value('--repo');
      if (v == null || !REPO_PATTERN.test(v)) return { usageError: `bad --repo value: ${clean(v)}` };
      o.repo = v;
      o.repoGiven = true;
    } else if (a === '--pr' || a.startsWith('--pr=')) {
      const v = value('--pr');
      if (v == null || !/^[0-9]+$/.test(v) || v.replace(/^0+/, '') === '') return { usageError: `bad --pr value (digits, 1 or more): ${clean(v)}` };
      o.pr = v.replace(/^0+/, '');
    } else return { usageError: `unknown argument: ${clean(a)}` };
  }
  if (o.repoGiven && o.pr == null) return { usageError: '--repo needs --pr' };
  return o;
}

/**
 * Resolve the conflicts of head against base. Throws on a failed read; returns { missing } for a base or
 * head ref that does not resolve.
 *
 * @param {object} o parseArgs result
 * @param {string} cwd
 * @param {{gh?: Function, git?: Function, tmpdir?: string}} [deps] gh(args) -> parsed JSON; git(args, cwd, extraEnv) ->
 *   { status, stdout, stderr }; tmpdir = the root the temp object dir is made under (default os.tmpdir())
 */
function resolve(o, cwd, deps = {}) {
  const gh = deps.gh || defaultGh;
  const git = deps.git || defaultGit;
  const must = (args, extraEnv) => {
    const r = git(args, cwd, extraEnv);
    if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${firstErrorLine({ stderr: r.stderr, message: 'exit ' + r.status })}`);
    return r.stdout;
  };
  const warnings = [];
  let pr = null;
  let baseRef = o.base;
  let hint = null;
  if (o.pr != null) {
    const pull = gh(['api', `repos/${o.repo}/pulls/${o.pr}`]);
    if (!pull || typeof pull !== 'object' || Array.isArray(pull)) throw new Error('pull reply is not an object');
    const prBase = String((pull.base && pull.base.ref) || '');
    pr = { repo: o.repo, number: Number(o.pr), base: prBase, head: String((pull.head && pull.head.sha) || '') };
    if (!BRANCH_PATTERN.test(prBase) || prBase.startsWith('-')) throw new Error(`PR base branch not usable: ${prBase}`);
    if (!baseRef) {
      const want = o.repo.toLowerCase();
      const remote = parseRemotes(must(['remote', '-v'])).find((r) => REMOTE_NAME.test(r.name) && parseRemoteUrl(r.url) === want);
      if (!remote) return { pr, error: `no local remote's fetch URL names ${o.repo}; pass --base <remote>/${prBase}` };
      baseRef = `${remote.name}/${prBase}`;
      hint = `git fetch ${remote.name} ${prBase}`;
    } else {
      const at = baseRef.indexOf('/');
      const branch = at > 0 ? baseRef.slice(at + 1) : baseRef;
      if (branch !== prBase) warnings.push(`the base ref ${baseRef} names branch ${branch}, but the PR's base is ${prBase}`);
    }
  }
  baseRef = baseRef || DEFAULT_BASE;
  const headRef = o.head || 'HEAD';
  const common = must(['rev-parse', '--path-format=absolute', '--git-common-dir']).trim();
  const sha = (ref) => {
    const r = git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd);
    const s = String(r.stdout || '').trim();
    return r.status === 0 && /^[0-9a-f]{40}$/.test(s) ? s : null;
  };
  const baseSha = sha(baseRef);
  if (!baseSha) return { pr, warnings, missing: { which: 'base', ref: baseRef, first: hint || fetchHint(baseRef) } };
  const headSha = sha(headRef);
  if (!headSha) return { pr, warnings, base: { ref: baseRef, sha: baseSha }, missing: { which: 'head', ref: headRef, first: null } };
  const baseTip = checkBaseTip(baseRef, baseSha, o.offline, must, git, cwd);
  if (baseTip.checked && baseTip.gone) warnings.push(`the remote ${baseTip.remote} has no branch ${baseTip.branch}: this answer is for the local base ${baseRef}`);
  else if (baseTip.checked && !baseTip.current) {
    warnings.push(`the local base ${baseRef} (${baseSha.slice(0, 9)}) is not the remote tip ${baseTip.tip.slice(0, 9)}: this answer is for the local base; first: git fetch ${baseTip.remote} ${baseTip.branch}`);
  }
  if (pr && pr.head && lower(pr.head) !== headSha) warnings.push(`the head ${headRef} (${headSha.slice(0, 9)}) is not the PR's head ${pr.head.slice(0, 9)}: the answer is for the local head`);
  const out = { pr, warnings, base: { ref: baseRef, sha: baseSha }, baseTip, head: { ref: headRef, sha: headSha } };
  const mbRun = git(['merge-base', baseSha, headSha], cwd);
  const mergeBase = String(mbRun.stdout || '').trim();
  if (mbRun.status !== 0 || !/^[0-9a-f]{40}$/.test(mergeBase)) {
    const why = String(mbRun.stderr || '').trim() ? firstErrorLine({ stderr: mbRun.stderr }) : `git merge-base exited ${mbRun.status}: no common ancestor (unrelated histories)`;
    return { ...out, error: `no merge base: ${why}` };
  }
  const counts = must(['rev-list', '--left-right', '--count', `${baseSha}...${headSha}`]).trim().split(/\s+/).map(Number);
  if (counts.length !== 2 || !counts.every(Number.isInteger)) throw new Error('rev-list --left-right --count reply is not two counts');
  const [behind, ahead] = counts;
  // The trial merge writes its new objects only to a per-run temp object dir (the repo's store is read as an
  // alternate); git may still refresh the mtime of objects the repo already holds (review F1).
  const tmp = fs.mkdtempSync(path.join(deps.tmpdir || os.tmpdir(), 'base-conflicts-'));
  let mt;
  try {
    mt = git(['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', baseSha, headSha], cwd, {
      GIT_OBJECT_DIRECTORY: tmp,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(common, 'objects'),
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  if (mt.status !== 0 && mt.status !== 1) {
    const line = firstErrorLine({ stderr: mt.stderr, message: 'exit ' + mt.status });
    const needs = /unknown option/i.test(line) ? '; base-conflicts needs git 2.38 or later (merge-tree --write-tree)' : '';
    return { ...out, mergeBase, ahead, behind, error: `git merge-tree failed: ${line}${needs}` };
  }
  const { paths } = parseMergeTree(mt.stdout);
  if (mt.status === 1 && paths.length === 0) throw new Error('git merge-tree reported a conflict but listed no path');
  const side = (to, p) => {
    const lines = must(['log', '-n', String(MAX_COMMITS), '--format=%h %s', `${mergeBase}..${to}`, '--', p]).split('\n').filter(Boolean);
    const total = Number(must(['rev-list', '--count', `${mergeBase}..${to}`, '--', p]).trim());
    return { commits: lines, more: Number.isInteger(total) && total > lines.length ? total - lines.length : 0 };
  };
  const conflicts = paths.map((p, i) => {
    if (i >= MAX_PATHS_WITH_COMMITS) return { path: p, listed: false };
    const h = side(headSha, p);
    const b = side(baseSha, p);
    return { path: p, listed: true, head: h.commits, headMore: h.more, base: b.commits, baseMore: b.more };
  });
  return { ...out, mergeBase, ahead, behind, clean: mt.status === 0, conflicts };
}

/**
 * The base-tip check (round 3 review): for a base ref <remote>/<branch> of a configured remote, read the remote's
 * branch tip with `git ls-remote` (no fetch, no local ref change) and compare it with the local base sha.
 * Returns { checked: false, reason } when not applicable or --offline, { checked: false, error } when ls-remote
 * fails, else { checked: true, remote, branch, tip, current } (gone: true when the remote has no such branch).
 */
function checkBaseTip(baseRef, baseSha, offline, must, git, cwd) {
  const at = String(baseRef).indexOf('/');
  const remote = at > 0 ? baseRef.slice(0, at) : '';
  const branch = at > 0 ? baseRef.slice(at + 1) : '';
  const notRemote = { checked: false, reason: `${baseRef} is not <remote>/<branch> of a configured remote` };
  if (!REMOTE_NAME.test(remote) || !BRANCH_PATTERN.test(branch) || branch.startsWith('-')) return notRemote;
  if (offline) return { checked: false, reason: '--offline' };
  if (!parseRemotes(must(['remote', '-v'])).some((r) => r.name === remote)) return notRemote;
  const r = git(['ls-remote', remote, `refs/heads/${branch}`], cwd);
  if (r.status !== 0) return { checked: false, error: `git ls-remote failed: ${firstErrorLine({ stderr: r.stderr, message: 'exit ' + r.status })}` };
  const line = String(r.stdout || '').split('\n').find((l) => l.endsWith(`\trefs/heads/${branch}`));
  if (!line) return { checked: true, remote, branch, tip: null, current: false, gone: true };
  const tip = line.split('\t')[0].trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(tip)) return { checked: false, error: 'git ls-remote reply has no sha' };
  return { checked: true, remote, branch, tip, current: tip === baseSha };
}

function lower(s) {
  return String(s == null ? '' : s).toLowerCase();
}

function formatText(d) {
  const lines = [];
  if (d.pr) lines.push(`pr: ${clean(d.pr.repo)}#${clean(d.pr.number)} base ${clean(d.pr.base)} head ${clean(String(d.pr.head).slice(0, 9) || '-')}`);
  if (d.base) lines.push(`base: ${clean(d.base.ref)} ${clean(d.base.sha)}`);
  if (d.head) lines.push(`head: ${clean(d.head.ref)} ${clean(d.head.sha)}`);
  const bt = d.baseTip;
  if (bt && bt.checked && bt.current) lines.push(`  base tip: ${clean(bt.remote)} ${clean(bt.branch)} ${clean(bt.tip.slice(0, 9))} (the local base is the remote tip)`);
  else if (bt && bt.error) lines.push(`  base tip: unknown (${clean(bt.error)})`);
  else if (bt && bt.reason === '--offline') lines.push('  base tip: not checked (--offline)');
  for (const w of d.warnings || []) lines.push(`  warning: ${clean(w)}`);
  if (d.missing) {
    lines.push(`  ERROR: the ${d.missing.which} ref ${clean(d.missing.ref)} is not found in this checkout`);
    if (d.missing.first) lines.push(`  first: ${clean(d.missing.first)}`);
    else if (d.missing.which === 'base') lines.push('  (no remote/branch shape to name a fetch for: check the ref name)');
    lines.push('  (base-conflicts never fetches)');
    return lines.join('\n');
  }
  if (d.error) {
    lines.push(`  ERROR: ${clean(d.error)}`);
    return lines.join('\n');
  }
  lines.push(`  merge base: ${clean(d.mergeBase.slice(0, 9))}; ahead ${d.ahead}, behind ${d.behind}`);
  if (d.clean) lines.push('  clean');
  else {
    lines.push(`  conflicts: ${d.conflicts.length}`);
    const sideLines = (label, commits, more) => {
      if (!commits.length) lines.push(`      ${label} side: none`);
      for (const c of commits) lines.push(`      ${label} side: ${clean(c)}`);
      if (more) lines.push(`      ${label} side: +${more} more`);
    };
    for (const c of d.conflicts) {
      lines.push(`    ${clean(c.path)}`);
      if (!c.listed) continue;
      sideLines('head', c.head, c.headMore);
      sideLines('base', c.base, c.baseMore);
    }
    const unlisted = d.conflicts.filter((c) => !c.listed).length;
    if (unlisted) lines.push(`  (per-path commits listed for the first ${MAX_PATHS_WITH_COMMITS} paths; ${unlisted} path(s) listed without commits)`);
  }
  lines.push('  (read-only: no new object, ref, index or worktree change; the trial merge wrote new objects only to a temp object dir, now removed, and may have refreshed the mtime of objects the repo already holds; nothing fetched)');
  return lines.join('\n');
}

/**
 * CLI entry. Returns the exit code: 0 clean, 3 conflicts, 1 a read failed or a ref is missing, 2 usage.
 *
 * @param {string[]} argv
 * @param {{gh?: Function, git?: Function, tmpdir?: string, cwd?: string, stdout?: {write: Function}, stderr?: {write: Function}}} [deps]
 */
function runCli(argv, deps = {}) {
  const out = deps.stdout || process.stdout;
  const errOut = deps.stderr || process.stderr;
  const o = parseArgs(argv);
  if (o.help) {
    out.write(USAGE + '\n');
    return 0;
  }
  if (o.usageError) {
    errOut.write(`base-conflicts: ${o.usageError}\n${USAGE}\n`);
    return 2;
  }
  const cwd = o.cwd || deps.cwd || process.cwd();
  let d;
  try {
    d = resolve(o, cwd, deps);
  } catch (err) {
    d = { error: firstErrorLine(err) };
  }
  if (o.json) out.write(JSON.stringify(d, null, 2).replace(/[\u007f-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')) + '\n');
  else out.write(formatText(d) + '\n');
  if (d.missing || d.error) return 1;
  return d.clean ? 0 : 3;
}

module.exports = { GIT_READ_VERBS, defaultGit, gitEnv, fetchHint, formatText, parseArgs, parseMergeTree, resolve, runCli };

if (require.main === module) process.exitCode = runCli(process.argv.slice(2));
