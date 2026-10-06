'use strict';

/**
 * hooks/lib/worktree-add-detect.cjs — the pure `git [globals] worktree add` detector behind the
 * ENF-25 worktree fresh-base gate (hooks/worktree-fresh-base.cjs).
 *
 * Pure: no fs, no child_process, no env reads; never throws on a string.
 *
 * ── One walk, two detectors (37-02, 37-CONTEXT Addendum 2) ──
 * This module is a PROGRAM MATCHER on the shared segment walk of hooks/lib/gsd-test-detect.cjs
 * (`findProgramEntries`). The walk owns parsing and every shell rule: groups and subshells, the
 * quote mask, env assignments and wrapper builtins, the nohup / time peel, `bash -c` and `eval`
 * recursion with its depth bound, `cd` / `env -C` / `sudo -D` start dirs, `command -v` lookups,
 * and the HARD-01 uncertain grading of unattributable input. This file only turns one resolved
 * `git` segment into an entry, so the worktree gate sees exactly the command shapes the gsd-test
 * gates see. There is no second walk here.
 *
 * ── Entry shape (FINAL from 37-01) ──
 *   { kind:'cut', seg, segIndex, prefixes, viaDashC, depth, gitChdirs, path, base, baseKind,
 *     newBranch }
 *   { kind:'uncertain', reason }
 *
 *   seg        the segment (argv.parseCommand shape, with `nextOp`; wrapper chdir options removed)
 *   segIndex   its index among the scanned segments of its (sub)command
 *   prefixes   parse-shaped `{ok:true, segments}` objects that ran before it, folded by
 *              gsd-test-detect's `startDirFor` (follows `cd`, `env -C`, `sudo -D`)
 *   viaDashC   / depth   whether / how deep the cut sits inside a `bash -c` or `eval` payload
 *   gitChdirs  the git GLOBAL `-C <dir>` values, in order, unexpanded (the gate expands them)
 *   path       the new worktree's path (first positional after `add`)
 *   base       the commit-ish (second positional), or null when omitted
 *   baseKind   'remote' | 'local' | 'head' | 'other' | 'none' ('none' = `--orphan`)
 *   newBranch  the `-b`/`-B` value, or null
 *
 * `-C` is read from the tokens AFTER the resolved git program index, so `FOO=1 git -C /a`,
 * `sudo git -C /a` and `timeout 5 git -C rel` target the -C dir (resolve.commandStartDir only
 * follows `-C` when `tokens[0] === 'git'`).
 *
 * ── Uncertain (HARD-01: the gate fails closed) ──
 * A cut whose repository or base cannot be attributed statically: `--git-dir` / `--work-tree`,
 * a `GIT_DIR=` / `GIT_WORK_TREE=` / `GIT_COMMON_DIR=` assignment before git, a shell expansion in
 * the base slot, in an omitted-base path, in an option, or among more than two positionals; plus
 * everything the walk itself grades (unparseable, ambiguous wrapper, over-deep `-c`) when the
 * command mentions WORKTREE_ADD_WORD; plus (37-REVIEW MA-03) a HEAD-kind cut after an earlier
 * `git checkout` / `git switch` anywhere in the same command.
 *
 * @module hooks/lib/worktree-add-detect
 */

const path = require('node:path');
const { findProgramEntries, REDIRECT, hasExpansion } = require('./gsd-test-detect.cjs');

/** `worktree` then whitespace then `add`, as whole words (the walk's uncertain word test). */
const WORKTREE_ADD_WORD = /\bworktree\s+add\b/;

/** git GLOBAL options that consume the following token (`-C` is collected separately). */
const GIT_GLOBAL_VALUE_OPTS = new Set(['-c', '--namespace', '--exec-path', '--super-prefix', '--config-env']);

/** git GLOBAL options that point git at another repository: the target cannot be attributed. */
const GIT_REPO_OPTS = new Set(['--git-dir', '--work-tree']);

/** Assignments before git that point it at another repository. */
const GIT_REPO_ASSIGNMENT = /^(GIT_DIR|GIT_WORK_TREE|GIT_COMMON_DIR)=/;

/**
 * `git worktree add` options (builtin/worktree.c add_options; parse-options semantics: long
 * options take a unique-prefix abbreviation and a `--no-` negation, short options cluster, a
 * value option takes the rest of its cluster or the next token unconditionally).
 */
const ADD_LONG = Object.freeze({
  force: 'bool',
  detach: 'bool',
  checkout: 'bool',
  lock: 'bool',
  reason: 'value',
  quiet: 'bool',
  track: 'bool',
  'guess-remote': 'bool',
  orphan: 'bool',
  'relative-paths': 'bool',
});
const ADD_SHORT_VALUE = new Set(['b', 'B']);
const ADD_SHORT_BOOL = Object.freeze({ f: 'force', d: 'detach', q: 'quiet' });

const LOCAL_TRUNK = new Set(['next', 'refs/heads/next', 'heads/next']);
const REMOTE_TRUNK = new Set(['origin/next', 'refs/remotes/origin/next', 'remotes/origin/next']);
const HEAD_FORMS = new Set(['HEAD', '@']);

/**
 * Classify a `worktree add` base by exact, case-sensitive string equality (no normalisation:
 * `NEXT`, `next~1`, `upstream/next`, a look-alike and a sha are all 'other').
 *
 * @param {string|null|undefined} base
 * @returns {'remote'|'local'|'head'|'other'}
 */
function classifyBase(base) {
  if (base === null || base === undefined) return 'head';
  if (typeof base !== 'string') return 'other';
  if (HEAD_FORMS.has(base)) return 'head';
  if (LOCAL_TRUNK.has(base)) return 'local';
  if (REMOTE_TRUNK.has(base)) return 'remote';
  return 'other';
}

/** Index just past a redirect at `k` (an operator-only token consumes its target), or -1. */
function redirectEnd(toks, k) {
  const m = REDIRECT.exec(toks[k]);
  if (!m) return -1;
  return m[2] === '' ? k + 2 : k + 1;
}

/**
 * A long `worktree add` option name (after `--`, before any `=`) resolved the way parse-options
 * does: exact, `no-<exact>`, else a unique prefix of a name or of its `no-` form.
 *
 * @returns {{name:string, neg:boolean}|null} null when unknown or ambiguous (git rejects it)
 */
function resolveLong(name) {
  if (Object.prototype.hasOwnProperty.call(ADD_LONG, name)) return { name, neg: false };
  if (name.startsWith('no-') && Object.prototype.hasOwnProperty.call(ADD_LONG, name.slice(3))) {
    return { name: name.slice(3), neg: true };
  }
  const hits = [];
  for (const L of Object.keys(ADD_LONG)) {
    if (L.startsWith(name)) hits.push({ name: L, neg: false });
    if (name.startsWith('no-') && name.length > 3 && L.startsWith(name.slice(3))) hits.push({ name: L, neg: true });
  }
  return hits.length === 1 ? hits[0] : null;
}

/**
 * Walk the tokens after `worktree add`: options, then `<path> [<commit-ish>]`. Redirects are
 * removed (the shell strips them before git sees argv); a lone `&` ends the command.
 *
 * baseKind: `--orphan` -> 'none'; a base -> classifyBase(base); no base with `-b`/`-B`/`--detach`
 * -> 'head'; no base and none of those -> 'local' when basename(path) is `next` (git then checks
 * out the existing branch `next`; PLANNER ADDITION, CTK-ADR-0009), else 'head'.
 *
 * @param {string[]} tail
 * @returns {{path:(string|null), base:(string|null), newBranch:(string|null), detach:boolean,
 *   orphan:boolean, baseKind:string, uncertainReason:(string|null)}}
 */
function parseWorktreeAddArgs(tail) {
  const toks = Array.isArray(tail) ? tail.filter((t) => typeof t === 'string') : [];
  let newBranch = null;
  let detach = false;
  let orphan = false;
  let uncertainReason = null;
  const positionals = [];
  const set = (name, on) => {
    if (name === 'detach') detach = on;
    if (name === 'orphan') orphan = on;
  };

  let k = 0;
  let optionsDone = false;
  while (k < toks.length) {
    const r = redirectEnd(toks, k);
    if (r !== -1) { k = r; continue; }
    const t = toks[k];
    if (t === '&') break;
    if (!optionsDone && t === '--') { optionsDone = true; k += 1; continue; }

    if (optionsDone || !t.startsWith('-') || t === '-') {
      positionals.push(t);
      k += 1;
      continue;
    }

    if (t.startsWith('--')) {
      const eq = t.indexOf('=');
      const name = eq === -1 ? t.slice(2) : t.slice(2, eq);
      if (hasExpansion(name)) { uncertainReason = 'shell expansion in a worktree add option'; break; }
      const opt = resolveLong(name);
      if (opt && ADD_LONG[opt.name] === 'value' && !opt.neg) {
        k += eq === -1 ? 2 : 1; // `--reason r` / `--reason=r`
        continue;
      }
      if (opt) set(opt.name, !opt.neg);
      k += 1; // a boolean, or an unknown / ambiguous option git rejects
      continue;
    }

    // A short cluster: booleans, then at most one value letter taking the rest or the next token.
    if (hasExpansion(t)) { uncertainReason = 'shell expansion in a worktree add option'; break; }
    let consumedNext = false;
    for (let c = 1; c < t.length; c++) {
      const L = t[c];
      if (ADD_SHORT_VALUE.has(L)) {
        const rest = t.slice(c + 1);
        if (rest !== '') {
          newBranch = rest;
        } else {
          newBranch = typeof toks[k + 1] === 'string' ? toks[k + 1] : null;
          consumedNext = true;
        }
        break;
      }
      if (Object.prototype.hasOwnProperty.call(ADD_SHORT_BOOL, L)) set(ADD_SHORT_BOOL[L], true);
    }
    k += consumedNext ? 2 : 1;
  }

  const p = positionals.length > 0 ? positionals[0] : null;
  const base = positionals.length > 1 ? positionals[1] : null;

  if (!uncertainReason && positionals.length > 2 && positionals.some(hasExpansion)) {
    uncertainReason = 'shell expansion among the worktree add positionals';
  }
  if (!uncertainReason && base !== null && hasExpansion(base)) {
    uncertainReason = 'shell expansion in the worktree add base';
  }

  let baseKind;
  if (orphan) baseKind = 'none';
  else if (base !== null) baseKind = classifyBase(base);
  else if (newBranch !== null || detach) baseKind = 'head';
  else if (p !== null && hasExpansion(p)) {
    baseKind = 'head';
    if (!uncertainReason) uncertainReason = 'shell expansion in a worktree add path that names the branch';
  } else if (p !== null && path.posix.basename(p) === 'next') baseKind = 'local';
  else baseKind = 'head';

  return { path: p, base, newBranch, detach, orphan, baseKind, uncertainReason };
}

/** git verbs that change HEAD (37-REVIEW MA-03): a HEAD-kind cut after one is unattributable. */
const HEAD_CHANGING_VERBS = new Set(['checkout', 'switch']);

/**
 * The shared walk's per-segment hook for a resolved `git` program.
 *
 * `state` (37-REVIEW MA-03) is per findWorktreeAdds call: the walk visits segments in command order
 * (a `bash -c` / `eval` payload inline, a subshell too), so `state.switched` is true for every cut
 * AFTER a `git checkout` / `git switch` (any arguments, any repository: conservative) anywhere
 * earlier in the same command. A HEAD-kind cut (omitted base, `HEAD`, `@`) then reads a HEAD the
 * gate cannot see at hook time -> uncertain.
 *
 * @param {Object} ctx the walk's segment context (toks, idx, segIndex, depth, seg(), prefixes())
 * @param {{switched:boolean}} [state] per-call state (default: a fresh, never-switched one)
 * @returns {Object[]} [] (not a cut), [cut] or [uncertain]
 */
function worktreeAddSegment(ctx, state) {
  const st = state || { switched: false };
  const toks = ctx.toks;
  const uncertain = (reason) => [{ kind: 'uncertain', reason }];

  // git GLOBAL options, up to the verb.
  const gitChdirs = [];
  let redirected = toks.slice(0, ctx.idx).some((t) => GIT_REPO_ASSIGNMENT.test(t));
  let expandedGlobal = false;
  let k = ctx.idx + 1;
  while (k < toks.length) {
    const r = redirectEnd(toks, k);
    if (r !== -1) { k = r; continue; }
    const t = toks[k];
    if (t === '-C') {
      if (typeof toks[k + 1] === 'string') gitChdirs.push(toks[k + 1]);
      k += 2;
      continue;
    }
    const eq = t.indexOf('=');
    const name = t.startsWith('--') && eq !== -1 ? t.slice(0, eq) : t;
    if (GIT_REPO_OPTS.has(name)) {
      redirected = true;
      k += eq === -1 ? 2 : 1;
      continue;
    }
    if (GIT_GLOBAL_VALUE_OPTS.has(t)) { k += 2; continue; }
    if (t.length > 1 && t.startsWith('-')) {
      if (hasExpansion(t)) expandedGlobal = true;
      k += 1;
      continue;
    }
    if (hasExpansion(t)) {
      // `git $G worktree add ...`: the expansion may be options or the verb itself.
      expandedGlobal = true;
      k += 1;
      continue;
    }
    break;
  }

  if (HEAD_CHANGING_VERBS.has(toks[k])) {
    st.switched = true;
    return [];
  }
  if (toks[k] !== 'worktree') {
    return expandedGlobal && WORKTREE_ADD_WORD.test(toks.slice(k).join(' '))
      ? uncertain('shell expansion before a git worktree add verb')
      : [];
  }
  k += 1;
  for (let r = redirectEnd(toks, k); r !== -1; r = redirectEnd(toks, k)) k = r;
  if (toks[k] !== 'add') return [];

  const a = parseWorktreeAddArgs(toks.slice(k + 1));
  if (a.path === null && !a.uncertainReason) return []; // git rejects it; nothing to protect
  if (expandedGlobal) return uncertain('shell expansion among the git global options');
  if (redirected) return uncertain('git is pointed at another repository (--git-dir, --work-tree or GIT_DIR)');
  if (a.uncertainReason) return uncertain(a.uncertainReason);
  if (a.baseKind === 'head' && st.switched) {
    return uncertain('an earlier git checkout / switch in the same command changes HEAD before this cut');
  }

  return [{
    kind: 'cut',
    seg: ctx.seg(),
    segIndex: ctx.segIndex,
    prefixes: ctx.prefixes(),
    viaDashC: ctx.depth > 0,
    depth: ctx.depth,
    gitChdirs,
    path: a.path,
    base: a.base,
    baseKind: a.baseKind,
    newBranch: a.newBranch,
  }];
}

/**
 * The program matcher for the shared walk. Its `segment` carries no checkout state (MA-03), so
 * findWorktreeAdds builds a per-call copy whose `segment` shares one state object.
 */
const WORKTREE_ADD_MATCHER = Object.freeze({
  label: 'git worktree add',
  word: WORKTREE_ADD_WORD,
  programs: new Set(['git']),
  segment: (ctx) => worktreeAddSegment(ctx),
});

/**
 * Every `git worktree add` (cut or uncertain) in a command, in command order.
 *
 * @param {string} command
 * @returns {Object[]} entries (see the module header for the shape)
 */
function findWorktreeAdds(command) {
  if (typeof command !== 'string') return [];
  const state = { switched: false };
  const matcher = Object.assign({}, WORKTREE_ADD_MATCHER, { segment: (ctx) => worktreeAddSegment(ctx, state) });
  return findProgramEntries(command, matcher);
}

module.exports = {
  findWorktreeAdds,
  parseWorktreeAddArgs,
  classifyBase,
  WORKTREE_ADD_WORD,
  WORKTREE_ADD_MATCHER,
};
