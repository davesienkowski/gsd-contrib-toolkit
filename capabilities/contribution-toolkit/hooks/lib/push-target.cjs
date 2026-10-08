'use strict';

/**
 * hooks/lib/push-target.cjs — where does a `git push` segment push TO? (quick-261007-rni F9,
 * Revisions 1 and 2). Built for the ENF-21 runtime-drift gate (hooks/runtime-drift.cjs step 5),
 * which calls classifyPushTarget directly because its rule (a) arms from any dir. F10
 * (quick-261007-tz0) reuses it through narrowToArmingPushes in lint-ci-marker (ENF-05/17) and
 * protocol-artifact (ENF-19): a push that provably goes to another owner/repo does not arm them.
 * Locked split: scan-gate (ENF-09) and githooks-seal (ENF-12/13) are leak and hook-bypass controls
 * and deliberately keep arming on every push from a gsd-core cwd; containment resolves its own
 * remote.
 *
 * Pure, except resolvePushUrlsLive and urlRewritesLive (one bounded local `git` subprocess each).
 * No module-level mutable state: the lookup budget is an object the caller creates per hook
 * invocation, and every call recomputes, so two hook invocations never share a cached answer.
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
 *   (b) every URL in every candidate dir parses to another owner/repo AND the whole command passes
 *       the rule-(b) ALLOWLIST below — returns 'other': this segment does not arm. Rule (b) is the
 *       only way this module produces an allow on its own, so it is a list of known-good forms,
 *       not a list of known-bad channels (Revision 2, review CR-02..04).
 *   (c) anything short of a positive resolution — a lookup that throws, times out or prints
 *       nothing, an unparseable URL, an undeterminable dir, an unrecognised option, a
 *       `$` / backtick / dash-leading token, or a redirect channel — returns null plus an
 *       `unresolved` phrase. The gate then applies the UNCHANGED pre-F9 rule (arm only when the
 *       command resolves to a gsd-core root or commandTargetsGsdCore), so it never becomes an
 *       allow on its own (CTK-ADR-0001 fail-closed) and never widens arming into another repo.
 *   (d) no repository argument (`git push`, `git push -u`, `git push --tags`) — null, no phrase:
 *       the pre-F9 rule, unchanged. branch.<b>.pushRemote / remote.pushDefault are not resolved.
 *
 * ── THE RULE-(b) ALLOWLIST (Revision 2) ──
 * The hook looks the push target up BEFORE the command runs, so any part of the command that can
 * run code, write a file or change the environment could move the push after the lookup. A push
 * classifies 'other' only when ALL of these hold; any failure is rule (c), never an allow:
 *   1. the raw command text has none of  ( ) { } ` $ < > \  or a newline, except the exact
 *      token `2>&1` (no subshell, group, expansion, redirection, heredoc or continuation);
 *   2. no segment starts with an environment assignment, and none runs env / export / declare /
 *      typeset / readonly / local / set / unset / read, or sudo / su / doas / runuser;
 *   3. every segment's program (its FIRST token: no wrapper) is cd / pushd / popd / pwd / true /
 *      echo / printf (no -v) / ls / sleep; or tail / head / grep / wc / cat with no file argument,
 *      only as a pipe consumer; or `git` (globals: only -C and the safe booleans) running push,
 *      status, log, diff, show or rev-parse (no --output), branch (list forms), fetch (no
 *      --upload-pack), ls-remote (no --upload-pack / -u / --exec) or remote (bare, -v, get-url,
 *      show). Anything else (git config, git remote set-url, bash -c, node, xargs, tee, eval, an
 *      alias-like git subcommand) is rule (c);
 *   4. no `--receive-pack` / `--exec` anywhere in the push segment, in any abbreviation git
 *      accepts, and every dash token after the repository positional is a known boolean;
 *   5. a LITERAL URL target also needs `git -C <dir> config --get-regexp ^url\.` to print nothing
 *      in every candidate dir (no insteadOf / pushInsteadOf rewrite; named remotes are resolved
 *      by `remote get-url --push`, which already applies them);
 *   6. every local lookup fits ONE budget per hook invocation (LOOKUP_BUDGET_MS total, each call
 *      min(PUSH_URL_TIMEOUT_MS, remaining)), and a push has at most MAX_PUSH_DIRS candidate dirs.
 * Rule (a) is checked first: an upstream URL arms whether or not the command passes the list.
 *
 * ── PUSH-REDIRECT CHANNELS (PD-3, Revision 1; kept as a second layer under the allowlist) ──
 * The hook looks the remote up BEFORE the command runs, so a command that can change where the
 * push goes can never earn rule (b): git globals other than `-C` and a boolean allowlist (`-c`,
 * `--git-dir`, `--work-tree`, `--config-env`, ...); `--receive-pack` / `--exec`; and, anywhere in
 * the command, a `GIT_*` assignment, `source` / `.` / `eval`, a shell function named git, a
 * mutating `git remote` / `git config`, or a git config file token. Any `-c` and any config-file
 * token count (accepted non-narrowing; narrow in F10 if it bites).
 *
 * Residuals (recorded): the lookup runs with the hook's env, not the command shell's
 * (T-261007-rni-08; item 2 removes the in-command half); config, hooks or a FIFO planted by an
 * EARLIER Bash call that the lookups cannot see (item 5 covers url rewrites only); an scp-like
 * `host:path` with no user is treated as a name (rule c).
 *
 * CTK-ADR-0001 (fail closed), CTK-ADR-0007 D-07 (ENF-21 arming; refined, not amended).
 */

const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { resolveProgram, classifyAction } = require('./classify.cjs');
const { parseOwnerRepo, GSD_CORE_OWNER, GSD_CORE_REPO } = require('./resolve.cjs');

/** PD-5: the bound on one `git remote get-url` call (same budget as worktree-fresh-base's local git). */
const PUSH_URL_TIMEOUT_MS = 3000;

/** R2 item 6: the TOTAL budget for every local lookup of one hook invocation, and the dir cap. */
const LOOKUP_BUDGET_MS = 5000;
const MAX_PUSH_DIRS = 3;

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

// ── R2 rule-(b) allowlist tables (item 1-3) ──
/** Item 1: shell metacharacters that can hide a command, a write or an expansion. */
const RAW_FORBIDDEN_RE = /[(){}`$<>\\\n\r]/;
/** The one redirection rule (b) tolerates: the exact token `2>&1`. */
const DUP_STDERR_RE = /(^|[ \t])2>&1(?=[ \t]|$)/g;
const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;
const ENV_PROGRAMS = Object.freeze(new Set(['env', 'export', 'declare', 'typeset', 'readonly', 'local', 'set', 'unset', 'read']));
const PRIVILEGE_PROGRAMS = Object.freeze(new Set(['sudo', 'su', 'doas', 'runuser']));
const INERT_PROGRAMS = Object.freeze(new Set(['cd', 'pushd', 'popd', 'pwd', 'true', 'echo', 'printf', 'ls', 'sleep']));
const PIPE_CONSUMERS = Object.freeze(new Set(['tail', 'head', 'grep', 'wc', 'cat']));
const GIT_READ_SUBCOMMANDS = Object.freeze(new Set(['status', 'log', 'diff', 'show', 'rev-parse']));
const BRANCH_LIST_LONGS = Object.freeze(new Set(['--list', '--all', '--remotes', '--verbose', '--show-current', '--no-color', '--color', '--no-abbrev']));
const HEAD_TAIL_LONGS = Object.freeze(new Set(['--quiet', '--silent', '--verbose']));
const WC_LONGS = Object.freeze(new Set(['--lines', '--words', '--bytes', '--chars', '--max-line-length']));
const GREP_LONGS = Object.freeze(new Set([
  '--ignore-case', '--invert-match', '--count', '--line-number', '--extended-regexp', '--fixed-strings',
  '--basic-regexp', '--word-regexp', '--line-regexp', '--quiet', '--silent', '--only-matching', '--color',
  '--no-filename', '--with-filename',
]));

/** Item 8 (WR-02): an echoed token never carries a raw backtick into the Markdown deny text. */
function esc(s) {
  return String(s).replace(/`/g, "'");
}

function cap(s, n) {
  const str = String(s);
  return str.length > n ? str.slice(0, n - 3) + '...' : str;
}

/** A command token quoted for a phrase: backticks escaped, capped at TOKEN_MAX. */
function shown(t) {
  return '`' + cap(esc(t), TOKEN_MAX) + '`';
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
  const r = walkPush(seg);
  if (r.kind === 'repo') return { kind: 'repo', value: r.value };
  return r;
}

/** pushRepositoryArg plus where the positional sits (`index`; null when the value came from --repo). */
function walkPush(seg) {
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
    if (t.startsWith('-')) return indeterminate('the git option ' + shown(t) + ' can redirect the push');
    break;
  }
  if (tokens[i] !== 'push') return indeterminate('the push verb could not be located');
  i += 1;

  let repoOpt = null;
  const end = () => (repoOpt !== null ? { kind: 'repo', value: repoOpt, index: null } : { kind: 'none' });
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === '--') {
      return i + 1 < tokens.length ? { kind: 'repo', value: tokens[i + 1], index: i + 1 } : end();
    }
    if (t.startsWith('--')) {
      const body = t.slice(2);
      const eq = body.indexOf('=');
      const name = eq === -1 ? body : body.slice(0, eq);
      const opt = shown(t);
      if (eq !== -1) {
        if (name === 'repo') { repoOpt = body.slice(eq + 1); i += 1; continue; }
        if (name === 'push-option' || name === 'recurse-submodules') { i += 1; continue; }
        if (PUSH_REDIRECT_OPTIONS.has(name)) return indeterminate('the push option ' + opt + ' can redirect the push');
        if (PUSH_LONG_OPTIONAL_ATTACHED.has(name)) { i += 1; continue; }
        return indeterminate('the push option ' + opt + ' is not recognised');
      }
      if (name.startsWith('no-')) {
        const base = name.slice(3);
        if (PUSH_LONG_BOOLEANS.has(base) || PUSH_LONG_VALUES.has(base)) {
          if (base === 'repo') repoOpt = null;
          i += 1;
          continue;
        }
        return indeterminate('the push option ' + opt + ' is not recognised');
      }
      if (name === 'recurse-submodules') {
        return indeterminate('a bare `--recurse-submodules` may consume the next token');
      }
      if (PUSH_LONG_BOOLEANS.has(name)) { i += 1; continue; }
      if (name === 'repo' || name === 'push-option') {
        if (i + 1 >= tokens.length) return indeterminate('the push option ' + opt + ' has no value');
        if (name === 'repo') repoOpt = tokens[i + 1];
        i += 2;
        continue;
      }
      if (PUSH_REDIRECT_OPTIONS.has(name)) return indeterminate('the push option ' + opt + ' can redirect the push');
      return indeterminate('the push option ' + opt + ' is not recognised');
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
        return indeterminate('the push option ' + shown(t) + ' is not recognised');
      }
      i += consumedNext ? 2 : 1;
      continue;
    }
    return { kind: 'repo', value: t, index: i }; // a lone `-` or any bare token is the positional
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
      if (GIT_ASSIGNMENT_RE.test(t)) return 'the command sets ' + shown(t.split('=')[0]);
      if (t.startsWith('git()')) return 'the command defines a shell function named git';
      if (t === 'function' && /^git(?:\(\))?$/.test(tokens[k + 1] || '')) return 'the command defines a shell function named git';
      if (CONFIG_FILE_RE.test(t)) return 'the command names a git config file (' + shown(t) + ')';
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

/** Is long option token `t` a (possibly abbreviated) `--receive-pack` / `--exec`? (item 4) */
function isRedirectOptionToken(t) {
  const m = /^--([^=]+)/.exec(String(t));
  if (!m) return false;
  return 'receive-pack'.startsWith(m[1]) || 'exec'.startsWith(m[1]);
}

/**
 * Item 4: a push segment's own option hazards. ANY `--receive-pack` / `--exec` spelling anywhere
 * in the segment; after the repository positional, every dash token must be a known boolean.
 * @param {{tokens?: Array}} seg
 * @returns {string|null}
 */
function pushOptionReason(seg) {
  const tokens = Array.isArray(seg && seg.tokens) ? seg.tokens.map(String) : [];
  for (const t of tokens) {
    if (isRedirectOptionToken(t)) return 'the push option ' + shown(t) + ' can redirect the push';
  }
  const w = walkPush(seg);
  if (w.kind !== 'repo' || w.index === null || w.index === undefined) return null;
  for (let k = w.index + 1; k < tokens.length; k++) {
    const t = tokens[k];
    if (t === '--') return null; // the rest are refspecs
    if (t.startsWith('--')) {
      const body = t.slice(2);
      const eq = body.indexOf('=');
      const name = eq === -1 ? body : body.slice(0, eq);
      if (eq !== -1 && PUSH_LONG_OPTIONAL_ATTACHED.has(name)) continue;
      if (eq === -1 && PUSH_LONG_BOOLEANS.has(name)) continue;
      if (eq === -1 && name.startsWith('no-') && PUSH_LONG_BOOLEANS.has(name.slice(3))) continue;
      return 'the push option ' + shown(t) + ' after the repository is not a known boolean';
    }
    if (t.startsWith('-') && t.length > 1) {
      if ([...t.slice(1)].every((c) => PUSH_SHORT_BOOLEANS.has(c))) continue;
      return 'the push option ' + shown(t) + ' after the repository is not a known boolean';
    }
  }
  return null;
}

/** Long option name of `t` is a non-empty prefix of `full` (git accepts unique abbreviations). */
function abbreviates(t, full) {
  const m = /^--([^=]+)/.exec(String(t));
  return !!m && full.startsWith(m[1]);
}

/** Item 3: why a `git` segment (first token `git`) is not an allowlisted form, or null. */
function gitSegmentReason(tokens) {
  let i = 1;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === '-C') {
      if (i + 1 >= tokens.length) return '`git -C` has no directory';
      i += 2;
      continue;
    }
    if (GIT_GLOBAL_SAFE_BOOLEANS.has(t)) { i += 1; continue; }
    if (t.startsWith('-')) return 'the git option ' + shown(t) + ' is not on the rule-(b) allowlist';
    break;
  }
  const sub = tokens[i];
  const args = tokens.slice(i + 1);
  const notListed = () => 'the command runs ' + shown('git ' + (sub === undefined ? '' : sub)) + ', which is not on the rule-(b) allowlist';
  if (sub === undefined) return notListed();
  if (sub === 'push') return pushOptionReason({ tokens });
  if (GIT_READ_SUBCOMMANDS.has(sub)) {
    const bad = args.find((a) => abbreviates(a, 'output'));
    return bad ? 'the command writes a file (' + shown('git ' + sub + ' ' + bad) + ')' : null;
  }
  if (sub === 'fetch' || sub === 'ls-remote') {
    const bad = args.find((a) => abbreviates(a, 'upload-pack') || abbreviates(a, 'exec') ||
      (sub === 'ls-remote' && /^-[^-]*u/.test(a)));
    return bad ? 'the command runs a remote helper command (' + shown('git ' + sub + ' ' + bad) + ')' : null;
  }
  if (sub === 'branch') {
    const listing = args.some((a) => a === '--list' || /^-[arv]*l[arvl]*$/.test(a));
    for (const a of args) {
      if (/^-[arvl]+$/.test(a) || BRANCH_LIST_LONGS.has(a) || /^--color=/.test(a)) continue;
      if (!a.startsWith('-') && listing) continue; // a --list pattern
      return 'the command runs ' + shown('git branch ' + a) + ', which is not a list form';
    }
    return null;
  }
  if (sub === 'remote') {
    let k = 0;
    while (k < args.length && (args[k] === '-v' || args[k] === '--verbose')) k += 1;
    const verb = args[k];
    const rest = args.slice(k + 1);
    if (verb === undefined) return null;
    if (verb === 'get-url' && rest.every((a) => a === '--push' || a === '--all' || !a.startsWith('-'))) return null;
    if (verb === 'show' && rest.every((a) => a === '-n' || !a.startsWith('-'))) return null;
    return 'the command runs ' + shown('git remote ' + verb) + ', which is not a read-only form';
  }
  return notListed();
}

/** Item 3: why a pipe consumer may read a file (or does something else), or null. */
function consumerReason(prog, args) {
  const bad = (a) => 'the pipe consumer ' + shown(prog + ' ' + a) + ' is not on the rule-(b) allowlist';
  if (prog === 'tail' || prog === 'head') {
    for (let k = 0; k < args.length; k++) {
      const a = args[k];
      if (/^-\d+$/.test(a) || /^-[nc][+-]?\d+$/.test(a) || /^-[qv]$/.test(a) || HEAD_TAIL_LONGS.has(a)) continue;
      if (/^--(?:lines|bytes)=[+-]?\d+$/.test(a)) continue;
      if (/^-[nc]$/.test(a) && /^[+-]?\d+$/.test(args[k + 1] || '')) { k += 1; continue; }
      return bad(a);
    }
    return null;
  }
  if (prog === 'wc') {
    for (const a of args) if (!/^-[lwcmL]+$/.test(a) && !WC_LONGS.has(a)) return bad(a);
    return null;
  }
  if (prog === 'cat') {
    for (const a of args) if (a !== '-' && !/^-[AbeEnstTuv]+$/.test(a)) return bad(a);
    return null;
  }
  // grep: options, -e PAT / --regexp=PAT, -A/-B/-C N, and the one pattern positional.
  let explicit = false;
  let positionals = 0;
  let endOpts = false;
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (!endOpts && a === '--') { endOpts = true; continue; }
    if (!endOpts && a.startsWith('-') && a.length > 1) {
      if (/^-[ivcnEFGwxqosHhaz]+$/.test(a) || GREP_LONGS.has(a) || /^--color=/.test(a)) continue;
      if (/^--regexp=/.test(a)) { explicit = true; continue; }
      if (/^-[ABC]\d+$/.test(a)) continue;
      if (/^-[ABC]$/.test(a) && /^\d+$/.test(args[k + 1] || '')) { k += 1; continue; }
      if (a === '-e' && k + 1 < args.length) { explicit = true; k += 1; continue; }
      return bad(a);
    }
    positionals += 1;
  }
  if (positionals > (explicit ? 0 : 1)) return 'the pipe consumer ' + shown('grep') + ' names a file';
  return null;
}

/**
 * R2 items 1-3: why this command may NOT earn rule (b), or null when every part of it is a
 * known-good form. Pure; reads the raw text (item 1) and the parsed segments (items 2-3).
 * @param {string} command raw tool_input.command
 * @param {{segments?: Array}} parsed parseCommandForGates(command)
 * @returns {string|null}
 */
function ruleBAllowlistReason(command, parsed) {
  if (typeof command !== 'string') return 'the raw command text is unavailable';
  const m = RAW_FORBIDDEN_RE.exec(command.replace(DUP_STDERR_RE, '$1'));
  if (m) return 'the command contains the shell metacharacter ' + JSON.stringify(esc(m[0]));
  const segs = parsed && Array.isArray(parsed.segments) ? parsed.segments : null;
  if (!segs || segs.length === 0) return 'the command segments are unavailable';
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const tokens = Array.isArray(seg && seg.tokens) ? seg.tokens.map(String) : [];
    if (tokens.length === 0) return 'the command has an empty segment';
    const prog = tokens[0];
    const args = tokens.slice(1);
    if (ENV_ASSIGNMENT_RE.test(prog)) return 'the command sets ' + shown(prog.split('=')[0]);
    if (ENV_PROGRAMS.has(prog)) return 'the command changes shell state with ' + shown(prog);
    if (PRIVILEGE_PROGRAMS.has(prog)) return 'the command runs ' + shown(prog) + ', which changes HOME and git config';
    if (INERT_PROGRAMS.has(prog)) {
      if (prog === 'printf' && args.some((a) => a.startsWith('-v'))) return 'the command sets a variable with ' + shown('printf -v');
      continue;
    }
    if (PIPE_CONSUMERS.has(prog)) {
      const piped = i > 0 && segs[i - 1] && segs[i - 1].nextOp === '|';
      if (!piped) return 'the command runs ' + shown(prog) + ' outside a pipe';
      const why = consumerReason(prog, args);
      if (why) return why;
      continue;
    }
    if (prog === 'git') {
      const why = gitSegmentReason(tokens);
      if (why) return why;
      continue;
    }
    return 'the command runs ' + shown(prog) + ', which is not on the rule-(b) allowlist';
  }
  return null;
}

/** Every reason this push may not earn rule (b) (PD-3 channels, the allowlist, its own options). */
function ruleBReason(seg, parsed, io) {
  return pushRedirectReason(parsed) || ruleBAllowlistReason(io.command, parsed) || pushOptionReason(seg);
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
  return cap(esc(msg.split(/\r?\n/).find((l) => l.trim() !== '') || 'unknown error'), 120);
}

/**
 * Item 6: one lookup budget per hook invocation. The caller creates it once and passes it in
 * `io.budget`, so several push segments share LOOKUP_BUDGET_MS. Not module state.
 * @param {()=>number} [now] clock (ms); defaults to Date.now
 * @returns {{now: ()=>number, deadline: number}}
 */
function createLookupBudget(now) {
  const clock = typeof now === 'function' ? now : Date.now;
  return { now: clock, deadline: Number(clock()) + LOOKUP_BUDGET_MS };
}

/**
 * Run one bounded lookup inside the budget: the call gets min(PUSH_URL_TIMEOUT_MS, remaining);
 * no budget left, a throw, or a return after its own timeout or after the deadline is a failure.
 */
function budgeted(budget, fn) {
  const spent = 'the push-target lookups ran out of their ' + LOOKUP_BUDGET_MS + ' ms budget';
  const start = Number(budget.now());
  const remaining = budget.deadline - start;
  if (!(remaining > 0)) return { ok: false, why: spent };
  const ms = Math.max(1, Math.min(PUSH_URL_TIMEOUT_MS, Math.floor(remaining)));
  let value;
  try {
    value = fn(ms);
  } catch (err) {
    return { ok: false, err };
  }
  const end = Number(budget.now());
  if (!(end - start <= ms) || !(end <= budget.deadline)) return { ok: false, why: spent };
  return { ok: true, value };
}

/** The candidate dirs of this push, capped (item 6); a string is the rule-c phrase. */
function pushDirs(io, shownValue) {
  let dirs;
  try {
    dirs = io.segmentDirs();
  } catch (err) {
    return 'the directory of the push to ' + shownValue + ' could not be determined (' + errLine(err) + ')';
  }
  if (!Array.isArray(dirs) || dirs.length === 0) return 'the directory of the push to ' + shownValue + ' could not be determined';
  if (dirs.length > MAX_PUSH_DIRS) {
    return 'the push to ' + shownValue + ' has ' + dirs.length + ' candidate directories (more than ' + MAX_PUSH_DIRS + ')';
  }
  return dirs;
}

function classifyInner(seg, parsed, io) {
  const arg = pushRepositoryArg(seg);
  if (arg.kind === 'none') return { target: null, unresolved: null };
  if (arg.kind === 'indeterminate') return unresolved(arg.reason);
  const value = arg.value;
  const sv = shown(value);
  if (value === '') return unresolved('the push repository argument is empty');
  if (value.startsWith('-')) return unresolved('the push repository ' + sv + ' starts with a dash');
  if (/[$`]/.test(value)) return unresolved('the push repository ' + sv + ' is a shell expansion');
  const budget = io.budget && typeof io.budget.now === 'function' ? io.budget : createLookupBudget();

  if (isLiteralPushTarget(value)) {
    const p = parseOwnerRepo(value);
    if (isUpstream(p)) return { target: 'gsd-core', unresolved: null };
    if (!p) return unresolved('the push URL ' + sv + ' does not name an owner/repo');
    const why = ruleBReason(seg, parsed, io);
    if (why) return unresolved(why + ', so the push to ' + sv + ' may be redirected');
    // Item 5: git applies url.<base>.insteadOf / pushInsteadOf to a literal URL at push time.
    const dirs = pushDirs(io, sv);
    if (typeof dirs === 'string') return unresolved(dirs);
    if (typeof io.urlRewrites !== 'function') return unresolved('the url rewrite config for ' + sv + ' could not be read');
    for (const dir of dirs) {
      const r = budgeted(budget, (ms) => io.urlRewrites(dir, ms));
      if (!r.ok) return unresolved(r.why || 'the url rewrite config for ' + sv + ' could not be read (' + errLine(r.err) + ')');
      if (!Array.isArray(r.value)) return unresolved('the url rewrite config for ' + sv + ' could not be read');
      if (r.value.length > 0) {
        return unresolved('a url.<base>.insteadOf / pushInsteadOf rewrite is configured (' + shown(r.value[0]) + '), so the push to ' + sv + ' may be redirected');
      }
    }
    return { target: 'other', unresolved: null };
  }

  const dirs = pushDirs(io, sv);
  if (typeof dirs === 'string') return unresolved(dirs);

  let failure = null;
  for (const dir of dirs) {
    const r = budgeted(budget, (ms) => io.resolvePushUrls(dir, value, ms));
    if (!r.ok) {
      if (failure === null) failure = r.why || 'the push remote ' + sv + ' could not be resolved (' + errLine(r.err) + ')';
      if (r.why) break; // the budget is spent: no further lookup can run
      continue;
    }
    const urls = r.value;
    if (!Array.isArray(urls) || urls.length === 0) {
      if (failure === null) failure = 'the push remote ' + sv + ' resolved to no URL';
      continue;
    }
    for (const u of urls) {
      const p = parseOwnerRepo(u);
      if (isUpstream(p)) return { target: 'gsd-core', unresolved: null };
      if (!p && failure === null) failure = 'the push remote ' + sv + ' resolved to an unparseable URL';
    }
  }
  if (failure !== null) return unresolved(failure);
  const why = ruleBReason(seg, parsed, io);
  if (why) return unresolved(why + ', so the push to ' + sv + ' may be redirected');
  return { target: 'other', unresolved: null };
}

/**
 * The four-way classification of one governed push segment. Never throws: an internal throw is
 * rule (c).
 * @param {Object} seg a parseCommandForGates segment classified `push`
 * @param {{segments?: Array}} parsed the whole parsed command (for redirect channels)
 * @param {{command: string, segmentDirs: ()=>(string[]|null),
 *   resolvePushUrls: (dir:string, name:string, timeoutMs:number)=>string[],
 *   urlRewrites: (dir:string, timeoutMs:number)=>string[],
 *   budget?: {now: ()=>number, deadline: number}}} io
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
 * F10 (quick-261007-tz0): the parse a contribution-contract push gate should arm on. Drops ONLY the
 * push segments that classifyPushTarget proves go to another owner/repo (rule b, 'other'); every
 * other segment (commit, pr-create, issue-create, a push that is 'gsd-core' or null) is kept.
 *
 * - Nothing dropped, missing lookup deps, a non-ok parse or no segments: `{ parsed, empty: false }`
 *   with the SAME input object, so rules a, c and d arm byte-for-byte as before F10.
 * - Every segment dropped: `{ parsed, empty: true }`. The caller allows; it must never hand an empty
 *   `segments` array to classifyAction, which would reclassify the top-level tokens.
 * - Some dropped: a NEW object with the kept segments (same objects, original order), the top-level
 *   program / subcommands / flags / shortFlags / positionals / tokens taken from the first kept
 *   segment, `raw` unchanged and `altSegments` recounted over the kept appended tail.
 * - Any throw (an injected dep or an internal fault) returns the input unchanged: toward arming,
 *   never toward allow (CTK-ADR-0001). No module-level state; one lookup budget per call.
 *
 * The per-segment io is built exactly as runtime-drift.cjs step 5 builds it (command, segmentDirs
 * bound to the segment, resolvePushUrls, urlRewrites, one shared budget). `io.classifyPushTarget`
 * is a test seam; it defaults to this module's classifyPushTarget.
 *
 * @param {string} command raw tool_input.command
 * @param {{ok:boolean, segments?:Array}} parsed parseCommandForGates(command)
 * @param {{segmentDirs: (command:string, seg:Object)=>(string[]|null),
 *   resolvePushUrls: (dir:string, name:string, timeoutMs:number)=>string[],
 *   urlRewrites?: (dir:string, timeoutMs:number)=>string[], now?: ()=>number,
 *   classifyPushTarget?: Function}} io
 * @returns {{parsed: Object, empty: boolean}}
 */
function narrowToArmingPushes(command, parsed, io) {
  const unchanged = { parsed, empty: false };
  try {
    if (!io || typeof io.segmentDirs !== 'function' || typeof io.resolvePushUrls !== 'function') return unchanged;
    if (!parsed || parsed.ok !== true || !Array.isArray(parsed.segments) || parsed.segments.length === 0) {
      return unchanged;
    }
    const classify = typeof io.classifyPushTarget === 'function' ? io.classifyPushTarget : classifyPushTarget;
    const segs = parsed.segments;
    const altCount = Number.isInteger(parsed.altSegments) && parsed.altSegments > 0 ? parsed.altSegments : 0;
    const altStart = segs.length - altCount;
    let budget = null;
    const kept = [];
    let keptAlt = 0;
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      if (classifyAction({ ok: true, segments: [seg] }).action === 'push') {
        if (budget === null) budget = createLookupBudget(io.now);
        const r = classify(seg, parsed, {
          command,
          segmentDirs: () => io.segmentDirs(command, seg),
          resolvePushUrls: io.resolvePushUrls,
          urlRewrites: io.urlRewrites,
          budget,
        });
        if (r && r.target === 'other') continue;
      }
      kept.push(seg);
      if (i >= altStart) keptAlt += 1;
    }
    if (kept.length === segs.length) return unchanged;
    if (kept.length === 0) return { parsed, empty: true };
    const first = kept[0];
    const narrowed = Object.assign({}, parsed, {
      segments: kept,
      program: first.program,
      subcommands: first.subcommands,
      flags: first.flags,
      shortFlags: first.shortFlags,
      positionals: first.positionals,
      tokens: first.tokens,
    });
    if (keptAlt > 0) narrowed.altSegments = keptAlt;
    else delete narrowed.altSegments;
    return { parsed: narrowed, empty: false };
  } catch (_err) {
    return unchanged;
  }
}

function boundedTimeout(ms) {
  const n = Number(ms);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), PUSH_URL_TIMEOUT_MS) : PUSH_URL_TIMEOUT_MS;
}

/**
 * Every push URL of remote `name` as git itself resolves it in `dir` (pushurl, pushInsteadOf and
 * insteadOf applied; `--all` because git pushes to every pushurl). argv array, no shell, bounded.
 * @param {string} dir
 * @param {string} name
 * @param {number} [timeoutMs] the caller's budget share (capped at PUSH_URL_TIMEOUT_MS)
 * @returns {string[]} non-empty list of URLs
 * @throws on a non-zero exit, a timeout kill, or empty output
 */
function resolvePushUrlsLive(dir, name, timeoutMs) {
  const out = execFileSync('git', ['-C', String(dir), 'remote', 'get-url', '--push', '--all', String(name)], {
    encoding: 'utf8',
    timeout: boundedTimeout(timeoutMs),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  const urls = String(out).split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '');
  if (urls.length === 0) throw new Error('git remote get-url printed no URL for ' + shown(name));
  return urls;
}

/**
 * Item 5: every `url.<base>.insteadOf` / `pushInsteadOf` line git would apply in `dir` (all
 * config scopes). `git config --get-regexp` exits 1 with no output when nothing matches: that is
 * "no rewrite" ([]). Any other failure (not a dir, a timeout kill) throws.
 * @param {string} dir
 * @param {number} [timeoutMs]
 * @returns {string[]}
 */
function urlRewritesLive(dir, timeoutMs) {
  let out;
  try {
    out = execFileSync('git', ['-C', String(dir), 'config', '--get-regexp', '^url\\.'], {
      encoding: 'utf8',
      timeout: boundedTimeout(timeoutMs),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
  } catch (err) {
    if (err && err.status === 1 && !err.signal && String(err.stdout || '').trim() === '' && String(err.stderr || '').trim() === '') return [];
    throw err;
  }
  return String(out).split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '');
}

module.exports = {
  PUSH_URL_TIMEOUT_MS,
  LOOKUP_BUDGET_MS,
  MAX_PUSH_DIRS,
  pushRepositoryArg,
  pushRedirectReason,
  pushOptionReason,
  ruleBAllowlistReason,
  isLiteralPushTarget,
  createLookupBudget,
  classifyPushTarget,
  narrowToArmingPushes,
  resolvePushUrlsLive,
  urlRewritesLive,
};
