'use strict';

/**
 * hooks/lib/worktree-add-detect.cjs — the pure `git [globals] worktree add` detector behind the
 * ENF-25 worktree fresh-base gate (hooks/worktree-fresh-base.cjs).
 *
 * Pure: no fs, no child_process, no env reads; never throws on a string.
 *
 * ── Entry shape (FINAL from 37-01; later plans fill parsing, they never reshape entries) ──
 *   { kind:'cut', seg, segIndex, prefixes, viaDashC, depth, gitChdirs, path, base, baseKind,
 *     newBranch }
 *   { kind:'uncertain', reason }
 *
 *   seg        the parsed argv segment (argv.parseCommand shape, with `nextOp`)
 *   segIndex   its index among the scanned segments
 *   prefixes   parse-shaped `{ok:true, segments}` objects holding the segments that ran BEFORE
 *              this one, folded by gsd-test-detect's exported `startDirFor` (follows `cd`)
 *   viaDashC   / depth   whether / how deep the cut sits inside a `bash -c` payload
 *   gitChdirs  the git GLOBAL `-C <dir>` values, in order (applied after the start dir)
 *   path       the new worktree's path (first positional after `add`)
 *   base       the commit-ish (second positional), or null when omitted
 *   baseKind   'remote' | 'local' | 'head' | 'other' | 'none' ('none' = `--orphan`, 37-02)
 *   newBranch  the `-b`/`-B` value, or null
 *
 * ── 37-01 tracer form ──
 * TOP-LEVEL segments only; an unparseable command yields []. 37-02 replaces the walk with the
 * shared one (groups, `bash -c`, quote mask, wrappers, uncertain grading) and the `add` option
 * walk with the full one (attached forms, clusters, `--`, `--orphan`, `--detach`).
 *
 * Why the detector reads `-C` itself: `resolve.commandStartDir` only follows `-C` when
 * `tokens[0] === 'git'`, so an env-prefixed or wrapped git (`FOO=1 git -C /a ...`,
 * `sudo git -C /a ...`) would silently stay at the base dir. The `-C` values are therefore
 * collected from the tokens AFTER the resolved program index.
 *
 * @module hooks/lib/worktree-add-detect
 */

const path = require('node:path');
const { parseCommand } = require('./argv.cjs');
const { resolveProgram } = require('./classify.cjs');

/** `worktree` then whitespace then `add`, as whole words (37-02 uncertain grading). */
const WORKTREE_ADD_WORD = /\bworktree\s+add\b/;

/** git GLOBAL options that consume the following token as their value (`-C` is collected). */
const GIT_GLOBAL_VALUE_OPTS = new Set([
  '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix', '--config-env',
]);

/** `worktree add` options that consume the following token. */
const ADD_VALUE_OPTS = new Set(['-b', '-B', '--reason']);

const LOCAL_TRUNK = new Set(['next', 'refs/heads/next', 'heads/next']);
const REMOTE_TRUNK = new Set(['origin/next', 'refs/remotes/origin/next', 'remotes/origin/next']);
const HEAD_FORMS = new Set(['HEAD', '@']);

/**
 * Classify a `worktree add` base by exact, case-sensitive string equality (no normalisation:
 * `NEXT`, `next~1`, `upstream/next` and a sha are all 'other').
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

/**
 * Index of the `git` program token: the first token whose basename is `git` and at which
 * resolveProgram over the prefix resolves to git (so `sudo -u git git ...` picks the second).
 * Tracer-local; 37-02 replaces it with the shared walk's program index.
 */
function gitIndex(tokens) {
  for (let i = 0; i < tokens.length; i++) {
    if (path.basename(String(tokens[i])) !== 'git') continue;
    if (resolveProgram({ tokens: tokens.slice(0, i + 1) }).prog === 'git') return i;
  }
  return -1;
}

const isDash = (t) => typeof t === 'string' && t.length > 1 && t.startsWith('-');

/**
 * Parse one segment as `git [globals] worktree add [opts] <path> [<base>]`, or null.
 */
function parseCut(tokens) {
  const g = gitIndex(tokens);
  if (g === -1) return null;
  const gitChdirs = [];
  let k = g + 1;
  // git GLOBAL options, up to the verb.
  while (k < tokens.length) {
    const t = tokens[k];
    if (t === '-C') {
      if (typeof tokens[k + 1] === 'string') gitChdirs.push(tokens[k + 1]);
      k += 2;
      continue;
    }
    if (GIT_GLOBAL_VALUE_OPTS.has(t)) { k += 2; continue; }
    if (isDash(t)) { k += 1; continue; }
    break;
  }
  if (tokens[k] !== 'worktree') return null;
  k += 1;
  while (k < tokens.length && isDash(tokens[k])) k += 1;
  if (tokens[k] !== 'add') return null;
  k += 1;

  // `worktree add` options and positionals (tracer walk).
  let newBranch = null;
  const positionals = [];
  while (k < tokens.length) {
    const t = tokens[k];
    if (ADD_VALUE_OPTS.has(t)) {
      if ((t === '-b' || t === '-B') && typeof tokens[k + 1] === 'string') newBranch = tokens[k + 1];
      k += 2;
      continue;
    }
    if (isDash(t)) { k += 1; continue; }
    positionals.push(t);
    k += 1;
  }
  if (positionals.length === 0) return null; // git rejects it; nothing to protect
  const base = positionals.length > 1 ? positionals[1] : null;
  return { gitChdirs, path: positionals[0], base, baseKind: classifyBase(base), newBranch };
}

/**
 * Every `git worktree add` in a command, in command order.
 *
 * @param {string} command
 * @returns {Object[]} entries (see the module header for the shape)
 */
function findWorktreeAdds(command) {
  if (typeof command !== 'string' || command.length === 0) return [];
  let parsed;
  try {
    parsed = parseCommand(command);
  } catch (_) {
    return [];
  }
  if (!parsed || parsed.ok !== true || !Array.isArray(parsed.segments)) return [];
  const segments = parsed.segments;
  const out = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (!seg || !Array.isArray(seg.tokens)) continue;
    const r = resolveProgram(seg);
    if (r.ambiguous || r.prog !== 'git') continue;
    const cut = parseCut(seg.tokens);
    if (!cut) continue;
    out.push({
      kind: 'cut',
      seg,
      segIndex: i,
      prefixes: [{ ok: true, segments: segments.slice(0, i) }],
      viaDashC: false,
      depth: 0,
      gitChdirs: cut.gitChdirs,
      path: cut.path,
      base: cut.base,
      baseKind: cut.baseKind,
      newBranch: cut.newBranch,
    });
  }
  return out;
}

module.exports = { findWorktreeAdds, classifyBase, WORKTREE_ADD_WORD };
