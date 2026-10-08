'use strict';

/**
 * hooks/lib/push-target.cjs — where does a `git push` segment push TO? (quick-261007-rni F9,
 * Revision 1). Built for the ENF-21 runtime-drift gate (hooks/runtime-drift.cjs step 5) and for
 * reuse by the other push gates (the F10 follow-up).
 *
 * Pure, except resolvePushUrlsLive (one bounded `git remote get-url` subprocess). No module-level
 * mutable state: every call recomputes, so two hook invocations never share a cached answer.
 *
 * ── WHY ──
 * Before F9, ENF-21 armed a push whenever the command ran in a gsd-core checkout, so
 * `git push backup fix/x` (backup = a personal fork) was blocked as a push to open-gsd/gsd-core.
 * It also read gh's `--repo` / `GH_REPO` / `repos/<o>/<r>` targets off a git push, which let
 * `GH_REPO=other/x git push origin y` through. A git push's target is its REPOSITORY argument:
 * the first non-option positional after `push`, else the last `--repo` value (git: a positional
 * beats `--repo`). That argument is a remote NAME or a URL / path, never a gh owner/repo spec.
 *
 * ── THE FOUR-WAY RULE (per governed push segment) ──
 *   (a) an explicit upstream match — a literal URL, or ANY URL a named remote resolves to, parses
 *       to open-gsd/gsd-core — returns 'gsd-core': the gate arms from ANY directory (D-07 / F8).
 *   (b) every URL in every candidate dir parses to another owner/repo, and the command has no
 *       push-redirect channel — returns 'other': this segment does not arm.
 *   (c) anything short of a positive resolution — a lookup that throws, times out or prints
 *       nothing, an unparseable URL, an undeterminable dir, an unrecognised option, a
 *       `$` / backtick / dash-leading token, or a redirect channel — returns null plus an
 *       `unresolved` phrase. The gate then applies the UNCHANGED pre-F9 rule (arm only when the
 *       command resolves to a gsd-core root or commandTargetsGsdCore), so it never becomes an
 *       allow on its own (CTK-ADR-0001 fail-closed) and never widens arming into another repo.
 *   (d) no repository argument (`git push`, `git push -u`, `git push --tags`) — null, no phrase:
 *       the pre-F9 rule, unchanged. branch.<b>.pushRemote / remote.pushDefault are not resolved.
 *
 * ── PUSH-REDIRECT CHANNELS (PD-3) ──
 * The hook looks the remote up BEFORE the command runs, so a command that can change where the
 * push goes can never earn rule (b): git globals other than `-C` and a boolean allowlist (`-c`,
 * `--git-dir`, `--work-tree`, `--config-env`, ...); `--receive-pack` / `--exec`; and, anywhere in
 * the command, a `GIT_*` assignment, `source` / `.` / `eval`, a shell function named git, a
 * mutating `git remote` / `git config`, or a git config file token. Any `-c` and any config-file
 * token count (accepted non-narrowing; narrow in F10 if it bites).
 *
 * Residuals (recorded): git applies pushInsteadOf to a LITERAL URL target and no plumbing exposes
 * that rewrite (T-261007-rni-07); the lookup runs with the hook's env, not the command shell's
 * (T-261007-rni-08); an scp-like `host:path` with no user is treated as a name (rule c).
 *
 * CTK-ADR-0001 (fail closed), CTK-ADR-0007 D-07 (ENF-21 arming; refined, not amended).
 */

const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { resolveProgram } = require('./classify.cjs');
const { parseOwnerRepo, GSD_CORE_OWNER, GSD_CORE_REPO } = require('./resolve.cjs');

/** PD-5: the bound on one `git remote get-url` call (same budget as worktree-fresh-base's local git). */
const PUSH_URL_TIMEOUT_MS = 3000;

/** Caps on the deny-text phrase (PD-4). */
const PHRASE_MAX = 300;
const TOKEN_MAX = 120;

/** git GLOBAL booleans that cannot redirect a push (PD-3a). Any other global dash token is indeterminate. */
const GIT_GLOBAL_SAFE_BOOLEANS = Object.freeze(new Set([
  '-p', '--paginate', '-P', '--no-pager', '--no-replace-objects', '--no-optional-locks',
  '--literal-pathspecs', '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs',
  '--no-advice', '--no-lazy-fetch',
]));

/** git 2.43 `git push -h` long booleans (full names only; git's prefix abbreviations are NOT accepted). */
const PUSH_LONG_BOOLEANS = Object.freeze(new Set([
  'verbose', 'quiet', 'all', 'branches', 'mirror', 'delete', 'tags', 'dry-run', 'porcelain', 'force',
  'force-if-includes', 'thin', 'set-upstream', 'progress', 'prune', 'verify', 'follow-tags', 'atomic',
  'ipv4', 'ipv6', 'force-with-lease', 'signed',
]));

/** Booleans that also accept an `=`-attached optional value. */
const PUSH_LONG_OPTIONAL_ATTACHED = Object.freeze(new Set(['force-with-lease', 'signed']));

/** Long options that take a value. */
const PUSH_LONG_VALUES = Object.freeze(new Set(['repo', 'push-option', 'recurse-submodules', 'receive-pack', 'exec']));

/** Push options that change what runs on the other end: never trusted to disarm (PD-3b). */
const PUSH_REDIRECT_OPTIONS = Object.freeze(new Set(['receive-pack', 'exec']));

/** Short booleans (`-v -q -d -n -f -u -4 -6`); `-o` is the one short value option. */
const PUSH_SHORT_BOOLEANS = Object.freeze(new Set(['v', 'q', 'd', 'n', 'f', 'u', '4', '6']));

const GIT_ASSIGNMENT_RE = /^GIT_[A-Za-z0-9_]*\+?=/;
const OPAQUE_PROGRAMS = Object.freeze(new Set(['source', '.', 'eval']));
const MUTATING_REMOTE_VERBS = Object.freeze(new Set(['add', 'rename', 'remove', 'rm', 'set-url']));
const CONFIG_READ_FLAGS = Object.freeze(new Set(['--get', '--get-all', '--get-regexp', '--get-urlmatch', '-l', '--list']));
const CONFIG_FILE_RE = /gitconfig|git\/config/i;
const SCP_RE = /^[^@/\s]+@[^@:/\s]+:/;

function cap(s, n) {
  const str = String(s);
  return str.length > n ? str.slice(0, n - 3) + '...' : str;
}

function indeterminate(reason) {
  return { kind: 'indeterminate', reason };
}

/**
 * The repository argument of one `git push` segment.
 * @param {{tokens?: Array}} seg a parseCommandForGates segment
 * @returns {{kind:'none'} | {kind:'repo', value:string} | {kind:'indeterminate', reason:string}}
 */
function pushRepositoryArg(seg) {
  const tokens = Array.isArray(seg && seg.tokens) ? seg.tokens.map(String) : [];
  const rp = resolveProgram({ tokens });
  if (rp.ambiguous) return indeterminate('the program of the push could not be resolved');
  const progTok = tokens[rp.index];
  if (typeof progTok !== 'string' || path.basename(progTok) !== 'git') {
    return indeterminate('the git program of the push could not be located');
  }

  let i = rp.index + 1;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === '-C') {
      if (i + 1 >= tokens.length) return indeterminate('`git -C` has no directory');
      i += 2;
      continue;
    }
    if (GIT_GLOBAL_SAFE_BOOLEANS.has(t)) { i += 1; continue; }
    if (t.startsWith('-')) return indeterminate('the git option `' + cap(t, TOKEN_MAX) + '` can redirect the push');
    break;
  }
  if (tokens[i] !== 'push') return indeterminate('the push verb could not be located');
  i += 1;

  let repoOpt = null;
  const end = () => (repoOpt !== null ? { kind: 'repo', value: repoOpt } : { kind: 'none' });
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === '--') {
      return i + 1 < tokens.length ? { kind: 'repo', value: tokens[i + 1] } : end();
    }
    if (t.startsWith('--')) {
      const body = t.slice(2);
      const eq = body.indexOf('=');
      const name = eq === -1 ? body : body.slice(0, eq);
      const shown = '`' + cap(t, TOKEN_MAX) + '`';
      if (eq !== -1) {
        if (name === 'repo') { repoOpt = body.slice(eq + 1); i += 1; continue; }
        if (name === 'push-option' || name === 'recurse-submodules') { i += 1; continue; }
        if (PUSH_REDIRECT_OPTIONS.has(name)) return indeterminate('the push option ' + shown + ' can redirect the push');
        if (PUSH_LONG_OPTIONAL_ATTACHED.has(name)) { i += 1; continue; }
        return indeterminate('the push option ' + shown + ' is not recognised');
      }
      if (name.startsWith('no-')) {
        const base = name.slice(3);
        if (PUSH_LONG_BOOLEANS.has(base) || PUSH_LONG_VALUES.has(base)) {
          if (base === 'repo') repoOpt = null;
          i += 1;
          continue;
        }
        return indeterminate('the push option ' + shown + ' is not recognised');
      }
      if (name === 'recurse-submodules') {
        return indeterminate('a bare `--recurse-submodules` may consume the next token');
      }
      if (PUSH_LONG_BOOLEANS.has(name)) { i += 1; continue; }
      if (name === 'repo' || name === 'push-option') {
        if (i + 1 >= tokens.length) return indeterminate('the push option ' + shown + ' has no value');
        if (name === 'repo') repoOpt = tokens[i + 1];
        i += 2;
        continue;
      }
      if (PUSH_REDIRECT_OPTIONS.has(name)) return indeterminate('the push option ' + shown + ' can redirect the push');
      return indeterminate('the push option ' + shown + ' is not recognised');
    }
    if (t.startsWith('-') && t.length > 1) {
      let consumedNext = false;
      for (let k = 1; k < t.length; k++) {
        const c = t[k];
        if (PUSH_SHORT_BOOLEANS.has(c)) continue;
        if (c === 'o') {
          if (k + 1 >= t.length) {
            if (i + 1 >= tokens.length) return indeterminate('the push option `-o` has no value');
            consumedNext = true;
          }
          break;
        }
        return indeterminate('the push option `' + cap(t, TOKEN_MAX) + '` is not recognised');
      }
      i += consumedNext ? 2 : 1;
      continue;
    }
    return { kind: 'repo', value: t }; // a lone `-` or any bare token is the positional
  }
  return end();
}

/**
 * PD-3c: a command-level channel that can change where a push goes after the hook looked the
 * remote up. Scans every segment of the command.
 * @param {{segments?: Array}} parsed
 * @returns {string|null} a short reason, or null
 */
function pushRedirectReason(parsed) {
  const segs = parsed && Array.isArray(parsed.segments) ? parsed.segments : [];
  for (const seg of segs) {
    const tokens = Array.isArray(seg && seg.tokens) ? seg.tokens.map(String) : [];
    for (let k = 0; k < tokens.length; k++) {
      const t = tokens[k];
      if (GIT_ASSIGNMENT_RE.test(t)) return 'the command sets `' + cap(t.split('=')[0], TOKEN_MAX) + '`';
      if (t.startsWith('git()')) return 'the command defines a shell function named git';
      if (t === 'function' && /^git(?:\(\))?$/.test(tokens[k + 1] || '')) return 'the command defines a shell function named git';
      if (CONFIG_FILE_RE.test(t)) return 'the command names a git config file (`' + cap(t, TOKEN_MAX) + '`)';
    }
    const rp = resolveProgram({ tokens });
    if (OPAQUE_PROGRAMS.has(rp.prog)) return 'the command runs `' + rp.prog + '`, which can change git config';
    if (rp.prog === 'git') {
      const verb = rp.args[0];
      if (verb === 'remote' && MUTATING_REMOTE_VERBS.has(rp.args[1])) return 'the command rewrites a remote (`git remote ' + rp.args[1] + '`)';
      if (verb === 'config' && !tokens.some((x) => CONFIG_READ_FLAGS.has(x)) && rp.args[1] !== 'get' && rp.args[1] !== 'list') {
        return 'the command writes git config (`git config`)';
      }
    }
  }
  return null;
}

/** A literal URL / scp / path target, parsed directly (no lookup). */
function isLiteralPushTarget(value) {
  const v = String(value);
  return v.includes('://') || SCP_RE.test(v) || v.startsWith('/') || v.startsWith('./') ||
    v.startsWith('../') || v.startsWith('~');
}

function isUpstream(p) {
  return !!p && p.owner === GSD_CORE_OWNER && p.repo === GSD_CORE_REPO;
}

function unresolved(phrase) {
  return { target: null, unresolved: cap(phrase, PHRASE_MAX) };
}

function errLine(err) {
  const stderr = err && err.stderr ? String(err.stderr).trim() : '';
  const msg = stderr || (err && err.message ? String(err.message) : String(err));
  return cap(msg.split(/\r?\n/).find((l) => l.trim() !== '') || 'unknown error', 120);
}

function classifyInner(seg, parsed, io) {
  const arg = pushRepositoryArg(seg);
  if (arg.kind === 'none') return { target: null, unresolved: null };
  if (arg.kind === 'indeterminate') return unresolved(arg.reason);
  const value = arg.value;
  const shown = '`' + cap(value, TOKEN_MAX) + '`';
  if (value === '') return unresolved('the push repository argument is empty');
  if (value.startsWith('-')) return unresolved('the push repository ' + shown + ' starts with a dash');
  if (/[$`]/.test(value)) return unresolved('the push repository ' + shown + ' is a shell expansion');

  if (isLiteralPushTarget(value)) {
    const p = parseOwnerRepo(value);
    if (isUpstream(p)) return { target: 'gsd-core', unresolved: null };
    if (!p) return unresolved('the push URL ' + shown + ' does not name an owner/repo');
    const why = pushRedirectReason(parsed);
    if (why) return unresolved(why + ', so the push to ' + shown + ' may be redirected');
    return { target: 'other', unresolved: null };
  }

  let dirs;
  try {
    dirs = io.segmentDirs();
  } catch (err) {
    return unresolved('the directory of the push to ' + shown + ' could not be determined (' + errLine(err) + ')');
  }
  if (!Array.isArray(dirs) || dirs.length === 0) {
    return unresolved('the directory of the push to ' + shown + ' could not be determined');
  }

  let failure = null;
  for (const dir of dirs) {
    let urls;
    try {
      urls = io.resolvePushUrls(dir, value);
    } catch (err) {
      if (failure === null) failure = 'the push remote ' + shown + ' could not be resolved (' + errLine(err) + ')';
      continue;
    }
    if (!Array.isArray(urls) || urls.length === 0) {
      if (failure === null) failure = 'the push remote ' + shown + ' resolved to no URL';
      continue;
    }
    for (const u of urls) {
      const p = parseOwnerRepo(u);
      if (isUpstream(p)) return { target: 'gsd-core', unresolved: null };
      if (!p && failure === null) failure = 'the push remote ' + shown + ' resolved to an unparseable URL';
    }
  }
  if (failure !== null) return unresolved(failure);
  const why = pushRedirectReason(parsed);
  if (why) return unresolved(why + ', so the push to ' + shown + ' may be redirected');
  return { target: 'other', unresolved: null };
}

/**
 * The four-way classification of one governed push segment. Never throws: an internal throw is
 * rule (c).
 * @param {Object} seg a parseCommandForGates segment classified `push`
 * @param {{segments?: Array}} parsed the whole parsed command (for redirect channels)
 * @param {{segmentDirs: ()=>(string[]|null), resolvePushUrls: (dir:string, name:string)=>string[]}} io
 * @returns {{target: ('gsd-core'|'other'|null), unresolved: (string|null)}}
 */
function classifyPushTarget(seg, parsed, io) {
  try {
    return classifyInner(seg, parsed, io || {});
  } catch (err) {
    return unresolved('the push target could not be classified (' + errLine(err) + ')');
  }
}

/**
 * Every push URL of remote `name` as git itself resolves it in `dir` (pushurl, pushInsteadOf and
 * insteadOf applied; `--all` because git pushes to every pushurl). argv array, no shell, bounded.
 * @param {string} dir
 * @param {string} name
 * @returns {string[]} non-empty list of URLs
 * @throws on a non-zero exit, a timeout kill, or empty output
 */
function resolvePushUrlsLive(dir, name) {
  const out = execFileSync('git', ['-C', String(dir), 'remote', 'get-url', '--push', '--all', String(name)], {
    encoding: 'utf8',
    timeout: PUSH_URL_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  const urls = String(out).split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '');
  if (urls.length === 0) throw new Error('git remote get-url printed no URL for `' + cap(name, TOKEN_MAX) + '`');
  return urls;
}

module.exports = {
  PUSH_URL_TIMEOUT_MS,
  pushRepositoryArg,
  pushRedirectReason,
  isLiteralPushTarget,
  classifyPushTarget,
  resolvePushUrlsLive,
};
