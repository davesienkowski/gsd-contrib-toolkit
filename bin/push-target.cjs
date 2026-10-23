#!/usr/bin/env node
'use strict';

/**
 * bin/push-target.cjs - which local remote a PR's head lives on, and the push command for it (read-only).
 *
 * Why: CTK-ADR-0012 says a fix for a PR is pushed to the PR's head.repo, not to whatever the branch
 * tracks. The 2026-10-23 sweep resolved that by hand (gsd-core-notes sweep-2026-10-23/pr-5119.md row
 * "push-target resolve", pr-5192-scriptable.md item 3): read head.repo, find the remote whose URL names
 * it, read that remote's branch tip, decide fast-forward or not. This prints that answer and the push
 * command. It NEVER pushes: the push is an outward action for Dave.
 *
 *   node bin/push-target.cjs [--json] [--repo owner/name] [--cwd <git checkout>] <pr-number>
 *
 * CONTRACT - read-only. One gh read and at most four git reads, all in --cwd (default: the process cwd):
 *   1. gh api "repos/R/pulls/N"                       (REST GET: head.repo.full_name, head.ref, head.sha)
 *   2. git -C <cwd> remote -v                          (fetch URLs only)
 *   3. git -C <cwd> ls-remote <remote> refs/heads/<ref>   (reads the remote; no fetch, no local ref change)
 *   4. git -C <cwd> rev-parse HEAD, and git -C <cwd> rev-parse --abbrev-ref HEAD (the local branch name)
 *   5. git -C <cwd> merge-base --is-ancestor <remote tip> HEAD   (only when the tips differ)
 * The git runner refuses any other git verb, so push, fetch and remote add are unreachable. No gh write
 * verb, no `gh api -X/--method/-f/-F/--input`, no `gh api graphql`.
 *
 * Remote matching: a remote matches when its fetch URL, parsed as https://, http://, ssh://, git:// or
 * scp-style user@host:path on host github.com (or www.github.com), names head.repo.full_name, compared
 * case-insensitively with any trailing .git or / dropped. An ssh host alias (Host github-work in
 * ~/.ssh/config) does not match: the output then lists every remote so the agent can choose by hand.
 * Several matches -> the first in `git remote -v` order, the others listed.
 *
 * Verdict (local HEAD vs the remote tip read now):
 *   up to date | fast-forward -> plain push    | branch not on remote -> plain push (creates it)
 *   not a fast-forward        -> git push --force-with-lease=<ref>:<remote tip> <remote> HEAD:<ref>
 *   unknown (the remote tip is not in the local objects) -> both commands, and "fetch it first"
 * When the local branch name differs from head.ref (another branch, or a detached HEAD) a note says so:
 * the printed command pushes HEAD, so check that HEAD is the PR's work before running it, above all a lease.
 * A bare --force is never printed. The lease pins the tip read at run time, so a push made by anyone
 * after this read makes git refuse the forced push instead of overwriting it.
 *
 * Exit: 0 resolved, 1 a read failed / no matching remote / head repository deleted, 2 usage.
 *
 * @module bin/push-target
 */

const { spawnSync, execFileSync } = require('node:child_process');

const { clean, firstErrorLine } = require('./pr-status.cjs');

const DEFAULT_REPO = 'open-gsd/gsd-core';
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const GIT_READ_VERBS = new Set(['remote', 'ls-remote', 'rev-parse', 'merge-base']);
const USAGE = 'usage: push-target [--json] [--repo owner/name] [--cwd <git checkout>] <pr-number>  (default repo ' + DEFAULT_REPO + ')';

function defaultGh(args) {
  const out = execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
  return JSON.parse(out);
}

/** Default git runner: read verbs only, argv array, no shell; returns { status, stdout, stderr }. */
function defaultGit(args, cwd) {
  if (!GIT_READ_VERBS.has(args[0])) throw new Error(`push-target refuses git ${args[0]}: read verbs only`);
  if (args[0] === 'remote' && !(args.length === 2 && args[1] === '-v')) throw new Error('push-target runs only git remote -v');
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 60000, env: Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: '0' }) });
  if (r.error) throw r.error;
  return { status: r.status, stdout: String(r.stdout || ''), stderr: String(r.stderr || '') };
}

/**
 * owner/name (lowercased) that a GitHub remote URL names, or null when it is not a github.com URL.
 *
 * @param {string} url
 * @returns {(string|null)}
 */
function parseRemoteUrl(url) {
  const u = String(url || '').trim();
  let host;
  let p;
  let m;
  if ((m = /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(u))) [host, p] = [m[1], m[2]];
  else if ((m = /^(?:[^@/:]+@)?([^/:]+):(?!\/)(.+)$/.exec(u))) [host, p] = [m[1], m[2]];
  else return null;
  if (!/^(www\.)?github\.com$/i.test(host)) return null;
  const parts = p.replace(/\/+$/, '').replace(/\.git$/i, '').split('/').filter(Boolean);
  if (parts.length !== 2) return null;
  return `${parts[0]}/${parts[1]}`.toLowerCase();
}

/** Parse `git remote -v` into [{ name, url }] for fetch lines, in order. */
function parseRemotes(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const m = /^(\S+)\s+(\S+)\s+\(fetch\)\s*$/.exec(line);
    if (m && !out.some((r) => r.name === m[1])) out.push({ name: m[1], url: m[2] });
  }
  return out;
}

/** The remote tip from `git ls-remote <remote> refs/heads/<ref>` output, or null when the branch is absent. */
function parseLsRemote(text, ref) {
  for (const line of String(text || '').split('\n')) {
    const m = /^([0-9a-f]{40})\s+(\S+)$/.exec(line.trim());
    if (m && m[2] === `refs/heads/${ref}`) return m[1];
  }
  return null;
}

function q(s) {
  // The ref and remote name come from GitHub and git config: quote anything outside a safe set.
  return /^[A-Za-z0-9._\/:=@+-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * Pure verdict.
 *
 * @param {{pr: object, remotes: {name: string, url: string}[], remoteTip: (string|null), localHead: string, ancestor: (boolean|null)}} input
 *   ancestor = remote tip is an ancestor of HEAD (null = unknown: the tip is not in the local objects)
 */
function derive({ pr, remotes, remoteTip, localHead, ancestor, localBranch }) {
  const head = (pr && pr.head) || {};
  const headRepo = head.repo && head.repo.full_name ? String(head.repo.full_name) : null;
  const ref = String(head.ref || '');
  const base = {
    number: pr && pr.number,
    state: String((pr && pr.state) || '').toUpperCase(),
    headRepo,
    ref,
    githubHead: String(head.sha || ''),
    maintainerCanModify: pr && pr.maintainer_can_modify != null ? Boolean(pr.maintainer_can_modify) : null,
  };
  if (!headRepo) return { ...base, ok: false, error: 'head repository deleted (head.repo is null): nothing to push to' };
  const matches = (remotes || []).filter((r) => parseRemoteUrl(r.url) === headRepo.toLowerCase());
  if (!matches.length) {
    return { ...base, ok: false, error: `no local remote names ${headRepo}`, remotes: remotes || [] };
  }
  const remote = matches[0];
  let verdict;
  if (!remoteTip) verdict = 'branch not on remote';
  else if (remoteTip === localHead) verdict = 'up to date';
  else if (ancestor === true) verdict = 'fast-forward';
  else if (ancestor === false) verdict = 'not a fast-forward';
  else verdict = 'unknown';
  const plain = `git push ${q(remote.name)} HEAD:${q(ref)}`;
  const lease = remoteTip ? `git push --force-with-lease=${q(ref)}:${remoteTip} ${q(remote.name)} HEAD:${q(ref)}` : null;
  let commands;
  if (verdict === 'not a fast-forward') commands = [lease];
  else if (verdict === 'unknown') commands = [plain, lease];
  else commands = [plain];
  return {
    ...base,
    ok: true,
    remote: remote.name,
    remoteUrl: remote.url,
    alternatives: matches.slice(1).map((r) => r.name),
    remoteTip,
    localHead,
    verdict,
    githubHeadMatchesRemote: remoteTip ? remoteTip === base.githubHead : null,
    localBranch: localBranch == null ? null : String(localBranch),
    branchMatches: localBranch == null ? null : String(localBranch) === ref,
    commands,
  };
}

function short(sha) {
  return String(sha || '').slice(0, 9) || '-';
}

function formatText(d) {
  const lines = [];
  lines.push(`${clean(d.repo)}#${clean(d.number)} ${clean(d.state)} head ${clean(d.headRepo || '(deleted)')}:${clean(d.ref)} (GitHub head ${clean(short(d.githubHead))})`);
  if (!d.ok) {
    lines.push(`  ERROR: ${clean(d.error)}`);
    if (d.remotes) for (const r of d.remotes) lines.push(`  remote: ${clean(r.name)} ${clean(r.url)}`);
    return lines.join('\n');
  }
  lines.push(`  remote: ${clean(d.remote)} (${clean(d.remoteUrl)})${d.alternatives.length ? `; also names it: ${d.alternatives.map(clean).join(', ')}` : ''}`);
  if (d.maintainerCanModify === false) lines.push('  note: maintainer_can_modify is false (only the head repo owner can push)');
  if (d.state && d.state !== 'OPEN') lines.push(`  note: the PR is ${clean(d.state)}`);
  const tip = d.remoteTip ? short(d.remoteTip) : '(branch absent)';
  lines.push(`  remote tip: ${clean(tip)}; local HEAD: ${clean(short(d.localHead))}; ${clean(d.verdict)}`);
  if (d.githubHeadMatchesRemote === false) lines.push(`  note: GitHub's PR head ${clean(short(d.githubHead))} differs from the remote tip (a push GitHub has not processed yet, or another remote)`);
  if (d.branchMatches === false) lines.push(`  note: the local branch is ${clean(d.localBranch)}, not ${clean(d.ref)}: the command pushes HEAD, so confirm HEAD is this PR's work first`);
  if (d.verdict === 'unknown') lines.push(`  note: the remote tip is not in the local objects; run git fetch ${clean(d.remote)} ${clean(d.ref)} and re-run before choosing`);
  for (const c of d.commands) lines.push(`  push: ${clean(c)}`);
  lines.push('  (printed only; push-target never pushes)');
  return lines.join('\n');
}

function parseArgs(argv) {
  let json = false;
  let repo = DEFAULT_REPO;
  let cwd = null;
  const numbers = [];
  const list = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < list.length; i += 1) {
    const a = String(list[i]);
    if (a === '--json') json = true;
    else if (a === '--repo' || a.startsWith('--repo=')) {
      const v = a === '--repo' ? list[++i] : a.slice(7);
      if (v == null || !REPO_PATTERN.test(String(v))) return { usageError: `bad --repo value: ${clean(v)}` };
      repo = String(v);
    } else if (a === '--cwd' || a.startsWith('--cwd=')) {
      const v = a === '--cwd' ? list[++i] : a.slice(6);
      if (v == null || String(v) === '') return { usageError: 'bad --cwd value' };
      cwd = String(v);
    } else if (/^[0-9]+$/.test(a)) {
      const n = a.replace(/^0+/, '');
      if (n === '') return { usageError: `PR number must be 1 or more: ${a}` };
      numbers.push(n);
    } else return { usageError: `not a PR number or flag: ${clean(a)}` };
  }
  if (numbers.length !== 1) return { usageError: numbers.length ? 'exactly one PR number' : 'no PR number given' };
  return { json, repo, cwd, number: numbers[0] };
}

/**
 * Resolve one PR. Throws on a failed read (the CLI reports it).
 *
 * @param {{gh?: Function, git?: Function}} [deps] gh(args) -> parsed JSON; git(args, cwd) -> { status, stdout, stderr }
 */
function resolve(number, repo, cwd, deps = {}) {
  const gh = deps.gh || defaultGh;
  const git = deps.git || defaultGit;
  const pr = gh(['api', `repos/${repo}/pulls/${number}`]);
  if (!pr || typeof pr !== 'object' || Array.isArray(pr)) throw new Error('pull reply is not an object');
  const must = (args) => {
    const r = git(args, cwd);
    if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${firstErrorLine({ stderr: r.stderr }) || 'exit ' + r.status}`);
    return r.stdout;
  };
  const remotes = parseRemotes(must(['remote', '-v']));
  const ref = String((pr.head && pr.head.ref) || '');
  const headRepo = pr.head && pr.head.repo && pr.head.repo.full_name;
  const match = headRepo ? remotes.find((r) => parseRemoteUrl(r.url) === String(headRepo).toLowerCase()) : null;
  let remoteTip = null;
  let localHead = '';
  let ancestor = null;
  let localBranch = null;
  if (match) {
    if (!/^[A-Za-z0-9._\/-]+$/.test(ref) || ref.startsWith('-')) throw new Error(`head ref not usable: ${ref}`);
    remoteTip = parseLsRemote(must(['ls-remote', match.name, `refs/heads/${ref}`]), ref);
    localHead = must(['rev-parse', 'HEAD']).trim();
    localBranch = must(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    if (remoteTip && remoteTip !== localHead) {
      const r = git(['merge-base', '--is-ancestor', remoteTip, 'HEAD'], cwd);
      ancestor = r.status === 0 ? true : r.status === 1 ? false : null; // 128: the tip is not in the local objects
    }
  }
  return derive({ pr, remotes, remoteTip, localHead, ancestor, localBranch });
}

function runCli(argv, deps = {}) {
  const out = deps.stdout || process.stdout;
  const errOut = deps.stderr || process.stderr;
  const args = parseArgs(argv);
  if (args.usageError) {
    errOut.write(`push-target: ${args.usageError}\n${USAGE}\n`);
    return 2;
  }
  const cwd = args.cwd || deps.cwd || process.cwd();
  let d;
  try {
    d = { repo: args.repo, cwd, ...resolve(args.number, args.repo, cwd, deps) };
  } catch (err) {
    d = { repo: args.repo, cwd, number: Number(args.number), ok: false, error: firstErrorLine(err) };
  }
  if (args.json) out.write(JSON.stringify(d, null, 2).replace(/[\u007f-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')) + '\n');
  else out.write((d.headRepo !== undefined ? formatText(d) : `${clean(d.repo)}#${clean(d.number)} ERROR: ${clean(d.error)}`) + '\n');
  return d.ok ? 0 : 1;
}

module.exports = { defaultGit, derive, parseLsRemote, parseRemotes, parseRemoteUrl, resolve, runCli, GIT_READ_VERBS };

if (require.main === module) process.exitCode = runCli(process.argv.slice(2));
