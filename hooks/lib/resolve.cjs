'use strict';

/**
 * hooks/lib/resolve.cjs — the live-script resolver (HARD-02 resolver half).
 *
 * The whole anti-bypass thesis depends on the gates calling gsd-core's LIVE policy
 * scripts — NEVER a vendored reimplementation. A reimplemented copy silently drifts from
 * upstream policy (stale policy = false confidence); calling the live script means a
 * gsd-core refactor that changes a script's shape surfaces as a fail-closed DENY (via
 * runGate's catch — HARD-01), not a silent miss.
 *
 *   resolveGsdCoreRoot(startDir)  → walk up from startDir to the first ancestor that has
 *                                   BOTH `scripts/` and `gsd-core/bin/lib/` (the gsd-core
 *                                   sentinel layout). Returns that absolute path, or
 *                                   throws ScriptResolveError.
 *   requireLiveScript(root, rel)  → require() the live module at <root>/<rel>; ANY failure
 *                                   (missing file, require-time throw) → ScriptResolveError
 *                                   carrying the attempted path + root, so the doctor
 *                                   (03-06) can report it and runGate can fail closed.
 *
 * There is deliberately NO fallback to a bundled/vendored script: a missing live script
 * is an ERROR that fails closed, never a silent local reimplementation (HARD-02).
 *
 * @module hooks/lib/resolve
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseCommand } = require('./argv.cjs');

/**
 * A typed error so runGate's catch fails closed and the doctor (03-06) can pattern-match
 * it. Carries the attempted path + resolved root for diagnostics.
 */
class ScriptResolveError extends Error {
  /**
   * @param {string} message
   * @param {{root?: string, attemptedPath?: string, cause?: Error}} [details]
   */
  constructor(message, details = {}) {
    super(message);
    this.name = 'ScriptResolveError';
    this.root = details.root;
    this.attemptedPath = details.attemptedPath;
    if (details.cause) this.cause = details.cause;
  }
}

/**
 * LIVE gsd-core policy-script BASENAMES that positively identify a real gsd-core checkout
 * (RES-02). The `~/.claude` runtime INSTALL root also carries `scripts/` +
 * `gsd-core/bin/lib/` (the install creates both), so those two directory checks alone
 * false-match it as a checkout — every Bash command run from under `~/.claude` then
 * false-resolves there. This identity set adds a third, positive signal: at least ONE of
 * these live policy scripts must exist under `<dir>/scripts/`.
 *
 * Re-declared locally rather than imported from `hooks/lib/sandbox.cjs` SANDBOX_SCRIPTS —
 * sandbox.cjs requires resolve.cjs, so importing back here would create a require cycle.
 *
 * This is a DISJUNCTION (see hasSentinel: `.some`, not `.every`) — load-bearing per D-05:
 * keying on ANY-one-of-many, not the single script a given gate happens to need, means an
 * upstream rename of one script does NOT false-negative a real checkout. A real checkout
 * missing one identity script still resolves as a checkout, so its governed action still
 * reaches requireLiveScript and still fails closed there (HARD-02 preserved, not weakened).
 */
const GSD_CORE_IDENTITY_SCRIPTS = Object.freeze([
  'issue-version-gate.cjs',
  'pr-target-policy.cjs',
  'pr-template-policy.cjs',
  'issue-dedupe.cjs',
]);

/**
 * Does this directory have the gsd-core sentinel layout (scripts/ + gsd-core/bin/lib/ +
 * at least one live gsd-core policy script under scripts/ — the RES-02 identity signal)?
 *
 * Pure and cheap: fs.existsSync/statSync only, never require()s a resolved script — the
 * identity probe must not execute anything during sentinel detection (see the threat
 * register's Tampering disposition).
 *
 * @param {string} dir
 * @returns {boolean}
 */
function hasSentinel(dir) {
  try {
    return (
      fs.statSync(path.join(dir, 'scripts')).isDirectory() &&
      fs.statSync(path.join(dir, 'gsd-core', 'bin', 'lib')).isDirectory() &&
      GSD_CORE_IDENTITY_SCRIPTS.some((basename) =>
        fs.existsSync(path.join(dir, 'scripts', basename))
      )
    );
  } catch (_) {
    return false;
  }
}

/**
 * Resolve the gsd-core repo root by walking parent directories from `startDir` until the
 * sentinel layout is found.
 *
 * @param {string} [startDir] defaults to process.cwd() (the hook's cwd at call site).
 * @returns {string} absolute path to the gsd-core root.
 * @throws {ScriptResolveError} when no ancestor has the sentinel layout.
 */
function resolveGsdCoreRoot(startDir) {
  let dir;
  try {
    dir = path.resolve(startDir == null ? process.cwd() : String(startDir));
  } catch (err) {
    throw new ScriptResolveError('resolveGsdCoreRoot: invalid startDir', { cause: err });
  }

  // Walk up to the filesystem root.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (hasSentinel(dir)) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }

  throw new ScriptResolveError(
    'resolveGsdCoreRoot: no gsd-core sentinel layout (scripts/ + gsd-core/bin/lib/) found from ' +
      (startDir == null ? process.cwd() : String(startDir)),
    { attemptedPath: startDir == null ? process.cwd() : String(startDir) }
  );
}

// A leading `$HOME` or `${HOME}` followed by `/` or end of token (quick-261007-ji5 F3). Same shape
// as the `$HOME` matcher in gsd-test-detect.cjs, COPIED rather than imported because
// gsd-test-detect.cjs requires this module (a circular require). Case-sensitive and anchored:
// `$HOMEX`, `$home`, `${HOME:-x}`, `${HOME}x`, `$FOO` and a mid-path `/a/$HOME/b` never match.
const HOME_VAR_RE = /^(?:\$HOME|\$\{HOME\})(?=\/|$)/;

/**
 * Expand a leading `~` / `~/...`, and a leading `$HOME` / `${HOME}` (followed by `/` or end), to
 * the user's home directory. The shell expands both before exec, but a parsed positional retains
 * the literal text, so the resolver must expand it too.
 *
 * The `$HOME` branch reads os.homedir() (the HOOK process HOME) at call time, with no cache. The
 * argv tokenizer drops quotes, so `'$HOME/x'` (single-quoted, which a shell would NOT expand) also
 * expands: an accepted over-expansion, since a literal directory named `$HOME` essentially never
 * exists. Every other variable, default form (`${HOME:-x}`) or substitution stays literal: a guessed
 * expansion could resolve a gsd-core command to a non-gsd-core root and switch its gates off
 * (fail-open under CTK-ADR-0001). Pass `{ homeVar: false }` to skip the `$HOME` branch (the caller
 * does so when the command may reassign HOME); the `~` branch is unaffected by it.
 * @param {string} p
 * @param {{homeVar?: boolean}} [opts]
 * @returns {string}
 */
function expandHome(p, opts) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  if (!(opts && opts.homeVar === false)) {
    const m = HOME_VAR_RE.exec(p);
    if (m) return path.join(os.homedir(), p.slice(m[0].length));
  }
  return p;
}

// Programs that can assign a variable named by a later (possibly indirect) token, or run code that
// can: `export $X=/y` assigns HOME when X=HOME, with no HOME-shaped token in its own segment.
const HOME_REASSIGNING_PROGRAMS = new Set([
  'export', 'declare', 'typeset', 'printf', 'read', 'local', 'readonly', 'source', '.', 'eval',
]);

/**
 * True when a parsed command may reassign HOME before its `cd` / `git -C` runs (quick-261007-ji5
 * F3). Used ONLY by commandStartDir's single best-guess cwd, which keeps a `$HOME` target literal
 * then. This is NOT the gates' fail-closed mechanism: every gate resolves through
 * resolveGsdCoreRootForCommand (the candidate union below), which considers the expanded AND the
 * prior/start directories, so neither interpretation can switch a gate off (review WR-01).
 * @param {{ok:boolean, segments:Array}} parsed
 * @returns {boolean}
 */
function commandMayReassignHome(parsed) {
  if (!parsed || !Array.isArray(parsed.segments)) return false;
  for (const seg of parsed.segments) {
    if (!seg) continue;
    if (HOME_REASSIGNING_PROGRAMS.has(seg.program)) return true;
    const tokens = Array.isArray(seg.tokens) ? seg.tokens : [];
    for (const raw of tokens) {
      const tok = String(raw);
      if (tok === 'HOME' || tok.startsWith('HOME=') || /\$\{HOME:?=/.test(tok)) return true;
    }
  }
  return false;
}

/**
 * Derive the effective working directory a parsed command runs in, by walking its
 * `cd <dir>` segments left-to-right from `baseCwd`.
 *
 * A PreToolUse hook's process.cwd() is the SESSION's cwd, not the worktree a
 * `cd <worktree> && git ...` command actually targets. Resolving the gsd-core root
 * from process.cwd() therefore inspects the wrong tree (e.g. lints the session repo
 * instead of the worktree being committed). Following the command's own `cd` lands
 * the resolver on the tree the git/gh/npm invocation will run in.
 *
 * @param {{ok?:boolean, segments?:Array}} parsed result of parseCommand(command)
 * @param {string} [baseCwd] defaults to process.cwd()
 * @returns {string} absolute effective cwd
 */
// git GLOBAL options (before the subcommand) that CONSUME the following token as their value.
// The pre-subcommand scan in gitGlobalChdirs must skip these so their value is not mistaken for
// the subcommand (which would stop the scan early and miss a later `-C`). `-C` is handled
// separately below — it IS the chdir.
const GIT_GLOBAL_VALUE_OPTS = Object.freeze([
  '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix', '--config-env',
]);

/**
 * Directories named by git's GLOBAL `-C <dir>` option(s) — the ones that appear BEFORE the
 * subcommand. git applies multiple `-C` cumulatively, so they are returned in order.
 *
 * A SUBCOMMAND-level `-C` (`git log -C` / `git blame -C` copy detection, `git commit -C <commit>`
 * reuse-message) is NOT a chdir and is deliberately excluded: the scan stops at the first bare
 * (non-option) token, which is the subcommand. `seg.shortFlags.C` cannot be used for this — the
 * parser collapses a global and a subcommand `-C` into the same key (`git log -C 50` → C:"50"),
 * so a subcommand `-C` would false-resolve as a chdir. Structured tokens only (HARD-04-safe).
 *
 * @param {{program?:string, tokens?:Array}} seg
 * @returns {string[]}
 */
function gitGlobalChdirs(seg) {
  const tokens = Array.isArray(seg && seg.tokens) ? seg.tokens : [];
  if (tokens[0] !== 'git') return [];
  const dirs = [];
  let i = 1;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (typeof tok !== 'string') break;
    if (tok === '-C') {
      const v = tokens[i + 1];
      if (typeof v === 'string' && v.length > 0) dirs.push(v);
      i += 2;
      continue;
    }
    if (GIT_GLOBAL_VALUE_OPTS.includes(tok)) { i += 2; continue; } // global opt + its value token
    if (tok.startsWith('--') && tok.includes('=')) { i += 1; continue; } // --opt=value (attached)
    if (tok.startsWith('-') && tok.length > 1) { i += 1; continue; } // any other -flag / short cluster
    break; // first bare token = the subcommand → stop
  }
  return dirs;
}

// Following `git -C <dir>` is the DEFAULT: a gate resolves the tree the git command actually runs
// in, so a `git -C <other-repo> push` from a gsd-core session cwd is not mis-gated against the
// session's tree. The whole push-gate family (runtime-drift/ENF-21, lint-ci-marker/ENF-05,
// containment/ENF-07, protocol-artifact, githooks-seal, policy-invariants, review-artifact,
// scan-gate) wants this, and gh commands have no `-C` so it is inert for the gh gates.
//
// The ONE opt-OUT is `{followGitC:false}`: the ENF-16 commit-convention gate DELIBERATELY
// over-denies `git -C <path> commit -m "<bad msg>"` (CR-01 anti-bypass — a bad-message commit must
// not escape via a global opt), so it must keep resolving the session cwd, not the `-C` target.
//
// quick-261007-ji5 review: commandStartDir is a SINGLE best guess (every cd succeeds, `cd` is the
// builtin). The gates no longer decide on it; they use resolveGsdCoreRootForCommand. Its remaining
// caller is gsd-test-detect.cjs (which pre-expands `$HOME` itself), so its behaviour is unchanged.
function commandStartDir(parsed, baseCwd, opts) {
  const followGitC = !(opts && opts.followGitC === false);
  let cwd = path.resolve(baseCwd == null ? process.cwd() : String(baseCwd));
  if (!parsed || parsed.ok !== true || !Array.isArray(parsed.segments)) return cwd;
  // F3: a command that may reassign HOME keeps `$HOME` literal (today's gated resolution).
  const homeOpts = { homeVar: !commandMayReassignHome(parsed) };
  for (const seg of parsed.segments) {
    if (!seg) continue;
    if (seg.program === 'cd') {
      // `cd <dir>` — persistent for all later segments. Prefer the classified positional; fall
      // back to the raw second token for robustness.
      const target =
        (Array.isArray(seg.positionals) && seg.positionals[0]) ||
        (Array.isArray(seg.tokens) && seg.tokens[1]) ||
        '';
      if (target) cwd = path.resolve(cwd, expandHome(String(target), homeOpts));
      continue;
    }
    if (followGitC && seg.program === 'git') {
      // `git -C <dir>` changes the tree the git invocation runs in — follow it exactly as `cd`,
      // or a `git -C <other-repo> push` from a gsd-core session cwd false-resolves to the session
      // tree and gates a non-gsd-core push (the ENF-21 false positive this fixes).
      for (const dir of gitGlobalChdirs(seg)) {
        cwd = path.resolve(cwd, expandHome(String(dir), homeOpts));
      }
    }
  }
  return cwd;
}

// ── Candidate-union resolution (quick-261007-ji5 review WR-01..WR-04, WR-07) ─────────────────
//
// A gate must not bet on ONE reading of a command's cwd. commandCandidateDirs returns EVERY
// directory a `git` / `gh` segment can plausibly run in, and resolveGsdCoreRootForCommand treats
// the command as gsd-core when ANY of them is a gsd-core checkout (fail-closed, CTK-ADR-0001).
// That makes `$HOME` expansion safe to do unconditionally: a wrong expansion can only ADD a
// candidate, never remove the one that gates.
//
// Candidates per relevant segment j (program `git` or `gh`, past `NAME=v`, `(`, `{`, `!` and
// wrapper words; when there is none, the state after the last segment):
//   - each `cd` / `pushd` / `builtin cd` / `command cd` target before j, resolved from every
//     current candidate, with `$HOME` / `${HOME}` / `~` expanded against every possible HOME. The
//     LITERAL form (`<cwd>/$HOME/...`, the single-quoted case) is kept only when that directory
//     really exists: otherwise that `cd` fails, and a failed cd is handled by the next rule;
//   - the prior candidates, kept, whenever that cd can fail or be bypassed before j: an operator
//     between them that is not `&&` (`;`, `||`, `|`, a lone `&`, a newline), a subshell `(cd ...`,
//     or a `cd` / `pushd` / `popd` function defined in the command;
//   - every directory seen so far, for `cd -`, `popd` and argument-less `pushd`;
//   - for `git`, its global `-C` targets applied to j only (shell semantics: `-C` never persists);
//   - when the command may reassign HOME (a token naming HOME such as `HOME=v`, `h=HOME`,
//     `read HOME`, `${HOME:=v}`, or an opaque `source` / `.` / `eval`): the start cwd, plus `/`
//     (an unset HOME) and each assigned value as extra possible HOMEs, plus any absolute-path
//     token as a possible HOME (covers `readarray -t $h <<< /dir`).
//   - when the command defines a cd function: every absolute or HOME-prefixed path token too.
// Residuals (recorded): an indirection that never spells HOME (`h=HO; h+=ME; unset $h`), a script
// run by name that changes directory, an alias, and a literal `$HOME` directory created by the
// same command. A symlinked HOME with `..` in a `-C` path (IN-04) is not modelled.

const CD_PROGRAMS = new Set(['cd', 'pushd']);
const CD_FLAG_RE = /^-[LPe@]+$/;
const WRAPPER_WORDS = new Set(['sudo', 'env', 'command', 'builtin', 'exec', 'nohup', 'time', 'nice', 'timeout']);
const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;
const OPAQUE_PROGRAMS = new Set(['source', '.', 'eval']);

/** The effective program of a segment past `(`, `{`, `!`, `NAME=v` and wrapper words. */
function effectiveProgram(seg) {
  const tokens = Array.isArray(seg && seg.tokens) ? seg.tokens.map(String) : [];
  let subshell = false;
  let i = 0;
  while (i < tokens.length) {
    let t = tokens[i];
    if (t.startsWith('(')) {
      subshell = true;
      t = t.replace(/^\(+/, '');
      if (t === '') { i += 1; continue; }
      tokens[i] = t;
    }
    if (t === '{' || t === '!' || ASSIGNMENT_RE.test(t)) { i += 1; continue; }
    if (WRAPPER_WORDS.has(t)) {
      i += 1;
      while (i < tokens.length && (tokens[i].startsWith('-') || /^\d+(?:\.\d+)?[smhd]?$/.test(tokens[i]) || ASSIGNMENT_RE.test(tokens[i]))) i += 1;
      continue;
    }
    break;
  }
  return { program: tokens[i] || '', rest: tokens.slice(i), subshell };
}

/**
 * True when the shared classifier names an action for this segment (anything but 'other'). The
 * segment is re-classified from its tokens with a subshell `(` / `)` stripped, so `git push)` in
 * `(cd x && git push)` is still seen as a push. Fail-closed: a classifier error counts as governable.
 */
function segmentIsGovernable(s) {
  try {
    const { classifyAction } = require('./classify.cjs');
    const { classifyTokens } = require('./argv.cjs');
    const toks = s.allTokens.map((t) => t.replace(/^\(+/, '').replace(/\)+$/, '')).filter((t) => t !== '');
    if (toks.length === 0) return false;
    const r = classifyAction({ ok: true, segments: [classifyTokens(toks)] });
    return !(r && r.action === 'other');
  } catch (_) {
    return true;
  }
}

/** A cd/pushd target: the first argument that is not a flag, `--` or a redirection; or null. */
function cdTarget(rest) {
  for (let k = 1; k < rest.length; k++) {
    const t = rest[k];
    if (t === '--' || CD_FLAG_RE.test(t)) continue;
    if (/^\d*[<>]/.test(t) || t === '&>' || t.startsWith('&>')) { if (/^\d*[<>]+&?$/.test(t)) k += 1; continue; }
    return t.replace(/\)+$/, '');
  }
  return null;
}

/** True when any token names HOME as a variable being (possibly) assigned, or the command is opaque. */
function commandMayReassignHomeVar(segs) {
  for (const s of segs) {
    if (OPAQUE_PROGRAMS.has(s.program)) return true;
    for (const t of s.allTokens) {
      if (/(^|=)HOME(\+?=|$)/.test(t) || /\$\{HOME:?=/.test(t)) return true;
    }
  }
  return false;
}

/** True when the command defines a cd / pushd / popd shell function. */
function definesCdFunction(segs) {
  for (const s of segs) {
    const t = s.allTokens;
    for (let k = 0; k < t.length; k++) {
      if (/^(?:cd|pushd|popd)\(\)/.test(t[k])) return true;
      if (t[k] === 'function' && /^(?:cd|pushd|popd)(?:\(\))?$/.test(t[k + 1] || '')) return true;
    }
  }
  return false;
}

/** Absolute-path tokens (also after `NAME=` or a redirection operator). */
function absolutePathTokens(segs) {
  const out = [];
  for (const s of segs) {
    for (const t of s.allTokens) {
      const m = /^(?:[A-Za-z_][A-Za-z0-9_]*\+?=|\d*[<>]+)?(\/.*)$/.exec(t);
      if (m) out.push(m[1].replace(/[;)]+$/, ''));
    }
  }
  return out;
}

/**
 * The interpretations of a cd / -C target: [{p, mustExist}]. `$HOME`, `${HOME}` and `~` expand
 * against every possible HOME; their literal form is kept but only counts when it exists.
 */
function targetInterpretations(t, homes) {
  const m = HOME_VAR_RE.exec(t);
  let rest = null;
  if (m) rest = t.slice(m[0].length);
  else if (t === '~') rest = '';
  else if (t.startsWith('~/')) rest = t.slice(1);
  if (rest === null) return [{ p: t, mustExist: false }];
  const out = homes.map((h) => ({ p: path.join(h, rest), mustExist: false }));
  out.push({ p: t, mustExist: true });
  return out;
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch (_) {
    return false;
  }
}

function pushUnique(list, items) {
  for (const it of items) if (!list.includes(it)) list.push(it);
  return list;
}

/** Resolve target interpretations from every current candidate. */
function applyTarget(cands, t, homes) {
  const out = [];
  for (const c of cands) {
    for (const it of targetInterpretations(t, homes)) {
      const abs = path.resolve(c, it.p);
      if (it.mustExist && !isDir(abs)) continue;
      pushUnique(out, [abs]);
    }
  }
  return out;
}

/**
 * Every directory a raw command's git / gh segments can plausibly run in (see the block comment
 * above). The first entry is the intended target; retained prior directories come after.
 * @param {string} command raw tool_input.command
 * @param {string} [baseCwd] the hook's process.cwd()
 * @param {{followGitC?: boolean}} [opts]
 * @returns {string[]} absolute directories, never empty
 */
function commandCandidateDirs(command, baseCwd, opts) {
  const followGitC = !(opts && opts.followGitC === false);
  const base = path.resolve(baseCwd == null ? process.cwd() : String(baseCwd));
  let parsed = parseCommand(command, { cwdSeparators: true });
  if (!parsed || parsed.ok !== true) parsed = parseCommand(command);
  if (!parsed || parsed.ok !== true || !Array.isArray(parsed.segments)) return [base];

  const segs = parsed.segments.map((seg) => {
    const e = effectiveProgram(seg);
    return Object.assign(e, {
      nextOp: seg.nextOp == null ? null : seg.nextOp,
      allTokens: Array.isArray(seg.tokens) ? seg.tokens.map(String) : [],
    });
  });

  const reassign = commandMayReassignHomeVar(segs);
  const cdFunction = definesCdFunction(segs);
  const homes = [os.homedir()];
  if (reassign) {
    pushUnique(homes, ['/']);
    for (const s of segs) {
      for (const t of s.allTokens) {
        const m = /^HOME\+?=(.+)$/.exec(t);
        if (m) pushUnique(homes, [path.resolve(base, m[1])]);
      }
    }
    pushUnique(homes, absolutePathTokens(segs));
  }

  // Relevant segments: git / gh segments the shared classifier names an action for (the only ones
  // a gate can govern), so a read-only `git log` / `git status` in the session cwd does not gate a
  // commit or push that runs elsewhere. None of those -> every git / gh segment; none at all ->
  // the end state. classify.cjs is required lazily (it does not require this module).
  const gitOrGh = [];
  segs.forEach((s, j) => { if (s.program === 'git' || s.program === 'gh') gitOrGh.push(j); });
  let relevant = gitOrGh.filter((j) => segmentIsGovernable(segs[j]));
  if (relevant.length === 0) relevant = gitOrGh;
  if (relevant.length === 0) relevant = [segs.length];

  const out = [];
  for (const j of relevant) {
    let cands = [base];
    const seen = [base];
    for (let i = 0; i < j; i++) {
      const s = segs[i];
      if (!CD_PROGRAMS.has(s.program) && s.program !== 'popd') continue;
      let bypass = cdFunction || s.subshell;
      // The operators between the cd and segment j; the end of the command (null) is not one.
      for (let k = i; k < j && !bypass; k++) if (segs[k].nextOp !== '&&' && segs[k].nextOp !== null) bypass = true;
      const t = s.program === 'popd' ? '-' : cdTarget(s.rest);
      let next;
      if (t === '-' || (s.program === 'pushd' && t === null)) {
        next = pushUnique(cands.slice(), seen);
      } else {
        next = t === null ? applyTarget(cands, '~', homes) : applyTarget(cands, t, homes);
        if (bypass || next.length === 0) pushUnique(next, cands);
      }
      cands = next;
      pushUnique(seen, cands);
    }
    if (j < segs.length && followGitC && segs[j].program === 'git') {
      for (const d of gitGlobalChdirs({ tokens: segs[j].rest })) {
        const moved = applyTarget(cands, String(d), homes);
        if (moved.length > 0) cands = moved;
      }
    }
    pushUnique(out, cands);
  }
  if (reassign) pushUnique(out, [base]);
  if (cdFunction) {
    for (const t of new Set(absolutePathTokens(segs).concat(
      [].concat(...segs.map((s) => s.allTokens)).filter((x) => HOME_VAR_RE.test(x) || x === '~' || x.startsWith('~/'))
    ))) {
      for (const it of targetInterpretations(t.replace(/[;)]+$/, ''), homes)) {
        if (!it.mustExist) pushUnique(out, [path.resolve(base, it.p)]);
      }
    }
  }
  return out;
}

/**
 * The gsd-core root a raw command can run in: the first candidate (commandCandidateDirs) whose
 * sentinel walk finds a gsd-core checkout. Throws ScriptResolveError when NO candidate is one, so
 * it is a drop-in for `resolveGsdCoreRoot(commandStartDir(parseCommand(cmd), cwd, opts))`.
 * @param {string} command raw tool_input.command
 * @param {string} [baseCwd]
 * @param {{followGitC?: boolean}} [opts]
 * @returns {string}
 * @throws {ScriptResolveError}
 */
function resolveGsdCoreRootForCommand(command, baseCwd, opts) {
  const cands = commandCandidateDirs(command, baseCwd, opts);
  for (const dir of cands) {
    try {
      return resolveGsdCoreRoot(dir);
    } catch (err) {
      if (!(err instanceof ScriptResolveError)) throw err;
    }
  }
  throw new ScriptResolveError(
    'resolveGsdCoreRootForCommand: no candidate directory of the command is a gsd-core checkout (' +
      cands.join(', ') + ')',
    { attemptedPath: cands[0] }
  );
}

/**
 * Resolve the gsd-core root a raw command can run in, or null when none of its candidate
 * directories (commandCandidateDirs) is a gsd-core checkout.
 *
 * Returns null on a clean "no gsd-core here" miss (ScriptResolveError) so a gate can ALLOW
 * commands that don't target gsd-core (a commit in another repo is not a gsd-core contribution).
 * Any other error propagates.
 *
 * @param {string} command raw tool_input.command
 * @param {string} [baseCwd] the hook's process.cwd()
 * @param {{followGitC?: boolean}} [opts]
 * @returns {string|null} absolute gsd-core root, or null if no candidate is one
 */
function resolveRootForCommand(command, baseCwd, opts) {
  try {
    return resolveGsdCoreRootForCommand(command, baseCwd, opts);
  } catch (err) {
    if (err instanceof ScriptResolveError) return null;
    throw err;
  }
}

// The UPSTREAM repo every contribution gate governs. A personal fork (`dave/gsd-core-fork`,
// `dave/gsd-core`) is NOT this target — only owner===open-gsd AND repo===gsd-core.
const GSD_CORE_OWNER = 'open-gsd';
const GSD_CORE_REPO = 'gsd-core';

// ─────────────────────── the branch-naming policy (ONE definition) ───────────────────────
//
// Mirrors `.github/workflows/branch-naming.yml` on `origin/next` — the AUTHORITATIVE upstream
// policy. Read it before editing this list; a drift here is a false deny or an enforcement hole.
//
// Two gates consumed this and had drifted APART, each also wrong against upstream:
//   • `gh-pr-create.cjs` allowed only `fix|docs|feat` AND additionally demanded an issue number
//     (`/^(fix|docs|feat)\/\d+-/`). Upstream requires NEITHER — it denied `hotfix/`, `perf/`,
//     `refactor/`, `test/`, `release/`, `ci/`, `revert/` and every no-issue-number branch that
//     upstream accepts.
//   • `protocol-artifact.cjs` armed on `fix|feat|enh|docs|chore|perf|refactor` — inventing `enh/`
//     (absent upstream) while MISSING `hotfix|test|release|ci|revert`, so the whole contribution
//     artifact family silently did not arm on those branches.
//
// Upstream emits `core.warning` and does NOT fail the job; the toolkit deliberately keeps a DENY
// (a warning is not a gate). What is NOT ours to invent is the branch SET — that is upstream's.
const UPSTREAM_BRANCH_PREFIXES = Object.freeze([
  'feat/', 'fix/', 'hotfix/', 'docs/', 'chore/',
  'refactor/', 'test/', 'release/', 'ci/', 'perf/', 'revert/',
]);

// Branches upstream exempts outright: the long-lived trunks, bot branches, and GSD/Claude
// auto-created branches. `branch-naming.yml` returns early for each of these.
const BRANCH_EXEMPT_EXACT = Object.freeze(['main', 'next', 'develop']);
const BRANCH_EXEMPT_PREFIXES = Object.freeze(['dependabot/', 'renovate/', 'gsd/', 'claude/']);

/**
 * Does `branch` satisfy the upstream branch-naming convention?
 *
 * Exempt branches answer TRUE — upstream returns before its prefix test, so treating them as
 * violations would deny work upstream never objects to. A detached HEAD or an unreadable branch
 * is the CALLER's problem: pass a non-empty string or handle the false yourself.
 *
 * @param {string} branch the branch NAME (no `refs/heads/` prefix)
 * @returns {boolean}
 */
function isConventionalBranch(branch) {
  const b = String(branch || '');
  if (!b) return false;
  if (BRANCH_EXEMPT_EXACT.includes(b)) return true;
  if (BRANCH_EXEMPT_PREFIXES.some((p) => b.startsWith(p))) return true;
  return UPSTREAM_BRANCH_PREFIXES.some((p) => b.startsWith(p));
}

/**
 * Is `branch` a CONTRIBUTION branch — one the artifact protocol should arm on?
 *
 * This is `isConventionalBranch` MINUS the exemptions: `next` is conventional but is not a
 * contribution branch, and arming the protocol family on it would be nonsense.
 *
 * @param {string} branch the branch NAME
 * @returns {boolean}
 */
function isContribBranch(branch) {
  const b = String(branch || '');
  if (!b) return false;
  if (BRANCH_EXEMPT_EXACT.includes(b)) return false;
  if (BRANCH_EXEMPT_PREFIXES.some((p) => b.startsWith(p))) return false;
  return UPSTREAM_BRANCH_PREFIXES.some((p) => b.startsWith(p));
}

// A GitHub-safe owner/repo segment: alnum, dot, dash, underscore. Anything else
// (a stray `:`, whitespace, a second path separator that survived normalization) means
// the input did NOT resolve to an enumerated owner/repo → null (fail-closed signal).
const OWNER_REPO_SEG = /^[A-Za-z0-9._-]+$/;

/**
 * parseOwnerRepo — the SINGLE owner/repo normalizer (CHD-01, WR-03: fix the class, not the
 * instance). It DELIBERATELY ENUMERATES the accepted input forms (Postel-inversion, binding
 * [Postel + Leaky Abstractions]): a containment-boundary parser must fail CLOSED on a form
 * it does not recognize — never silently treat an un-enumerated target as a non-match.
 *
 * Enumerated forms:
 *   - `gh:owner/repo`                       (gh CLI shorthand scheme → host github.com)
 *   - `https://host[:port]/owner/repo[.git]`  (http/https, optional user@, optional :port)
 *   - `ssh://git@host[:port]/owner/repo[.git]` (any scheme:// form, user@ + host stripped)
 *   - `git@host:owner/repo[.git]`           (scp-style ssh; host before the `:`)
 *   - `host/owner/repo` or bare `owner/repo`  (LAST two path segments are owner/repo)
 *   - GH_HOST-qualified enterprise hosts (`ghe.example.com/...`) — host retained.
 *
 * Returns `{ owner, repo, host }` with owner/repo/host LOWER-cased (GitHub routes
 * owner/repo case-insensitively — CR-01), or `null` when the input does not resolve to an
 * enumerated form / >=2 path segments / GitHub-safe owner+repo. Pure (string in,
 * object|null out); operates on already-structured argv values (HARD-04-safe — never a
 * raw-command regex).
 *
 * @param {*} urlOrSpec
 * @returns {{owner:string, repo:string, host:string}|null}
 */
function parseOwnerRepo(urlOrSpec) {
  if (typeof urlOrSpec !== 'string') return null;
  const raw = urlOrSpec.trim();
  if (raw.length === 0) return null;

  let host = null;
  let rest = raw;

  if (/^gh:/i.test(rest)) {
    // gh CLI shorthand `gh:owner/repo` → github.com.
    host = 'github.com';
    rest = rest.slice(3);
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(rest)) {
    // scheme:// form (https, http, ssh, git, …): strip scheme, optional user@, then the
    // host[:port] up to the first slash.
    rest = rest.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
    rest = rest.replace(/^[^@/]+@/, ''); // strip user@ (before any path slash)
    const slash = rest.indexOf('/');
    if (slash === -1) return null; // host with no path → not an owner/repo
    host = rest.slice(0, slash).replace(/:\d+$/, '').toLowerCase(); // strip :port
    rest = rest.slice(slash + 1);
  } else if (/^[^@/\s]+@[^@:/\s]+:/.test(rest)) {
    // scp-style ssh `git@host:owner/repo` → host is between `@` and `:`.
    rest = rest.replace(/^[^@]+@/, ''); // strip user@
    const colon = rest.indexOf(':');
    host = rest.slice(0, colon).replace(/:\d+$/, '').toLowerCase();
    rest = rest.slice(colon + 1);
  }
  // else: bare `owner/repo` or `host/owner/repo` — host stays the github.com default.

  rest = rest.replace(/^\/+/, '').replace(/\.git$/i, '');
  const segs = rest.split('/').filter((x) => x.length > 0);
  if (segs.length < 2) return null;
  const owner = segs[segs.length - 2];
  const repo = segs[segs.length - 1];
  if (!OWNER_REPO_SEG.test(owner) || !OWNER_REPO_SEG.test(repo)) return null;
  return {
    owner: owner.toLowerCase(),
    repo: repo.toLowerCase(),
    host: (host || 'github.com').toLowerCase(),
  };
}

/**
 * Does an explicit `-R/--repo` VALUE name the upstream open-gsd/gsd-core repo? Routes
 * through the unified parseOwnerRepo normalizer (CR-01 case-fold) — so a fork
 * (`dave/gsd-core-fork`) or a wrong-owner same-name repo (`dave/gsd-core`) does NOT match,
 * but a case-variant `Open-GSD/GSD-Core` DOES.
 *
 * @param {*} value the flag value (only strings can match)
 * @returns {boolean}
 */
function repoSpecTargetsGsdCore(value) {
  const r = parseOwnerRepo(value);
  return !!r && r.owner === GSD_CORE_OWNER && r.repo === GSD_CORE_REPO;
}

/**
 * Does a single token name the upstream gsd-core repo via a REST path — a gh-api path
 * positional (`repos/open-gsd/gsd-core/...`) or a curl URL token
 * (`https://api.github.com[:port]/repos/open-gsd/gsd-core/...`)? The token is normalized
 * (scheme + `api.github.com` host WITH an optional `:port` — closing the `:443` slip —
 * + leading slash stripped); the leading `repos/` prefix is REQUIRED (a non-`repos/` path
 * does not match), and the FIRST two segments after it are resolved via parseOwnerRepo so
 * only the upstream owner/repo pair counts (case-folded).
 *
 * @param {*} token
 * @returns {boolean}
 */
function tokenTargetsGsdCoreApi(token) {
  if (typeof token !== 'string' || token.length === 0) return false;
  let s = token.trim();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, ''); // strip scheme
  s = s.replace(/^api\.github\.com(?::\d+)?/i, ''); // strip REST host + optional :port (close :443 slip)
  s = s.replace(/^\/+/, ''); // strip leading slashes
  const m = /^repos\/(.+)$/i.exec(s); // the `repos/` prefix is required
  if (!m) return false;
  const after = m[1].split('/').filter((x) => x.length > 0);
  if (after.length < 2) return false;
  const r = parseOwnerRepo(after[0] + '/' + after[1]); // owner/repo are the FIRST two segments after repos/
  return !!r && r.owner === GSD_CORE_OWNER && r.repo === GSD_CORE_REPO;
}

/**
 * The `owner/repo` a gh-api / curl REST token names (`repos/<owner>/<repo>/...`), or null.
 * @param {string} token
 * @returns {{owner:string, repo:string}|null}
 */
function tokenApiRepo(token) {
  if (typeof token !== 'string' || token.length === 0) return null;
  let s = token.trim();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  s = s.replace(/^api\.github\.com(?::\d+)?/i, '');
  s = s.replace(/^\/+/, '');
  const m = /^repos\/(.+)$/i.exec(s);
  if (!m) return null;
  const after = m[1].split('/').filter((x) => x.length > 0);
  if (after.length < 2) return null;
  return parseOwnerRepo(after[0] + '/' + after[1]);
}

/**
 * Per-SEGMENT explicit repo target (quick-261007-ji5 F8): 'gsd-core' when an explicit spec
 * (`--repo` / `-R` / a leading `GH_REPO=`) or a gh-api / curl `repos/<owner>/<repo>` token names
 * open-gsd/gsd-core, or an explicit spec is unparseable (fail-closed); 'other' when every explicit
 * target parses and names some other repo; null when the segment names no explicit target (the
 * caller then falls back to the cwd). Structured argv only, like commandTargetsGsdCore.
 * @param {Object} seg one parsed segment
 * @returns {'gsd-core'|'other'|null}
 */
function segmentRepoTarget(seg) {
  if (!seg || typeof seg !== 'object') return null;
  const flags = seg.flags || {};
  const shortFlags = seg.shortFlags || {};
  const tokens = Array.isArray(seg.tokens) ? seg.tokens : [];
  const targets = [];
  const specs = [];
  if (typeof flags.repo === 'string') specs.push(flags.repo);
  if (typeof shortFlags.R === 'string') specs.push(shortFlags.R);
  for (const tok of tokens) {
    if (typeof tok !== 'string') break;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(tok);
    if (!m) break;
    if (m[1] === 'GH_REPO') specs.push(m[2]);
  }
  for (const spec of specs) {
    const r = parseOwnerRepo(spec);
    if (!r) return 'gsd-core'; // explicit but unparseable → fail-closed
    targets.push(r);
  }
  for (const tok of tokens) {
    const r = tokenApiRepo(tok);
    if (r) targets.push(r);
  }
  if (targets.length === 0) return null;
  return targets.some((r) => r.owner === GSD_CORE_OWNER && r.repo === GSD_CORE_REPO) ? 'gsd-core' : 'other';
}

/**
 * Pure discriminator: does a PARSED command explicitly target the UPSTREAM
 * open-gsd/gsd-core repo, regardless of the command's cwd?
 *
 * This is the ROB-01 seam used by the gh gates: an out-of-tree command (one whose
 * effective cwd resolves to no gsd-core sentinel, so resolveRootForCommand → null)
 * passes through (ALLOW) ONLY when it does NOT target upstream gsd-core. A command that
 * DOES target it (via `-R/--repo open-gsd/gsd-core`, a gh-api `repos/open-gsd/gsd-core`
 * path, or a curl `api.github.com/repos/open-gsd/gsd-core` URL) is a real contribution
 * action the toolkit cannot verify without a local checkout → the caller fails it closed
 * (HARD-02 — never reach for a possibly-stale runtime root).
 *
 * Reads STRUCTURED argv only (parsed.segments flags/shortFlags/tokens) — never a
 * raw-string re-parse (HARD-04). It is THREE-way (binding [Postel + Leaky Abstractions]):
 *   - NO repo-spec intent (no -R/--repo, no GH_REPO token, no upstream api/curl token)
 *     → false (ROB-01 passthrough preserved — a clearly-non-upstream command passes through).
 *   - an explicit repo-spec (flags.repo / shortFlags.R / a leading GH_REPO=… env token)
 *     that parses as open-gsd/gsd-core, OR a gh-api/curl `repos/open-gsd/gsd-core` token
 *     → true (targeting → DENY).
 *   - an explicit repo-spec that parseOwnerRepo CANNOT resolve (GitHub-ish but unparseable)
 *     → true (fail-closed targeting — an un-enumerated explicit target is a containment
 *     bypass, never a silent non-upstream ALLOW; the Postel-inversion).
 *   - an explicit repo-spec that parses as a clearly-non-upstream fork → that source is NOT
 *     targeting (a fork must still passthrough — no false-deny).
 *
 * The GH_REPO/GH_HOST env target is read from the LEADING `NAME=VALUE` tokens argv keeps in
 * seg.tokens (CR-02): argv normalizes a leading env-assignment OUT of seg.program but RETAINS
 * it as a leading seg.tokens entry — so an ordinary `--flag=value` or a post-program
 * `-f title=x` field is never mistaken for an env assignment.
 *
 * @param {{ok?:boolean, segments?:Array}} parsed result of parseCommand(command)
 * @returns {boolean}
 */
function commandTargetsGsdCore(parsed) {
  if (!parsed || parsed.ok !== true || !Array.isArray(parsed.segments)) return false;
  for (const seg of parsed.segments) {
    if (!seg) continue;
    const flags = seg.flags || {};
    const shortFlags = seg.shortFlags || {};
    const tokens = Array.isArray(seg.tokens) ? seg.tokens : [];

    // Collect every EXPLICIT repo-spec source for this segment:
    //   gh native --repo <v> / --repo=<v> / -R <v> / -R<v>, and a leading GH_REPO=… env token.
    const explicitSpecs = [];
    if (typeof flags.repo === 'string') explicitSpecs.push(flags.repo);
    if (typeof shortFlags.R === 'string') explicitSpecs.push(shortFlags.R);

    // Scan the LEADING run of `NAME=VALUE` env-assignment tokens (they precede the program
    // per argv's normalization). Stop at the first non-assignment token (the program) so a
    // post-program `title=x` / `--flag=value` is never read as an env assignment.
    for (const tok of tokens) {
      if (typeof tok !== 'string') break;
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(tok);
      if (!m) break; // first non-assignment token = the program → stop scanning
      if (m[1] === 'GH_REPO') explicitSpecs.push(m[2]);
      // GH_HOST is recognized as part of the env-target shape but the gate keys on
      // owner/repo (host is advisory), so its value does not itself drive classification.
    }

    // Three-way over each explicit repo-spec source.
    for (const spec of explicitSpecs) {
      const r = parseOwnerRepo(spec);
      if (r) {
        if (r.owner === GSD_CORE_OWNER && r.repo === GSD_CORE_REPO) return true; // upstream → DENY
        // else: parses as a clearly-non-upstream fork → not targeting via this source (continue).
      } else {
        // explicit spec present but unparseable (GitHub-ish but unparseable) → fail-closed.
        return true;
      }
    }

    // gh-api path positional / curl api.github.com URL token (upstream match).
    for (const tok of tokens) {
      if (tokenTargetsGsdCoreApi(tok)) return true;
    }
  }
  return false;
}

/**
 * require() a LIVE gsd-core script by its path relative to the gsd-core root.
 *
 * NEVER falls back to a vendored copy: a missing or broken live script throws a typed
 * ScriptResolveError so the caller (runGate) fails closed (HARD-01) and the doctor can
 * report exactly what was attempted (HARD-02 / H-E shape check).
 *
 * @param {string} root absolute gsd-core root (from resolveGsdCoreRoot).
 * @param {string} relPath e.g. 'scripts/pr-target-policy.cjs'.
 * @returns {object} the live module's exports.
 * @throws {ScriptResolveError} on a missing file or a require-time throw.
 */
function requireLiveScript(root, relPath) {
  if (typeof root !== 'string' || root.length === 0) {
    throw new ScriptResolveError('requireLiveScript: root is required', { root, attemptedPath: relPath });
  }
  if (typeof relPath !== 'string' || relPath.length === 0) {
    throw new ScriptResolveError('requireLiveScript: relPath is required', { root, attemptedPath: relPath });
  }

  const abs = path.resolve(root, relPath);

  // Existence check first → a missing live script is an explicit, diagnosable error
  // (NOT a MODULE_NOT_FOUND that could be confused with a dependency miss, and NEVER a
  // silent vendored fallback).
  if (!fs.existsSync(abs)) {
    throw new ScriptResolveError(
      'requireLiveScript: live script not found (no vendored fallback — fail closed): ' + abs,
      { root, attemptedPath: abs }
    );
  }

  try {
    // Bust any require cache entry so a hot-swapped live script is re-read each gate run
    // (the doctor and gates want the CURRENT live shape, not a stale cached copy).
    delete require.cache[abs];
    return require(abs);
  } catch (err) {
    throw new ScriptResolveError(
      'requireLiveScript: live script failed to load: ' + abs + ' (' + (err && err.message) + ')',
      { root, attemptedPath: abs, cause: err }
    );
  }
}

module.exports = {
  ScriptResolveError,
  resolveGsdCoreRoot,
  requireLiveScript,
  hasSentinel,
  GSD_CORE_IDENTITY_SCRIPTS,
  commandStartDir,
  commandCandidateDirs,
  expandHome,
  resolveGsdCoreRootForCommand,
  resolveRootForCommand,
  commandTargetsGsdCore,
  segmentRepoTarget,
  // ENF-21: exported so `runtime-stamp.cjs` builds the upstream `ls-remote` URL from the SAME
  // owner/repo every gate already adjudicates against, rather than introducing a second source of
  // truth for "which repo is upstream". They were module-private until 260730-0ov.
  GSD_CORE_OWNER,
  GSD_CORE_REPO,
  UPSTREAM_BRANCH_PREFIXES,
  BRANCH_EXEMPT_EXACT,
  BRANCH_EXEMPT_PREFIXES,
  isConventionalBranch,
  isContribBranch,
  parseOwnerRepo,
  repoSpecTargetsGsdCore,
  tokenTargetsGsdCoreApi,
};
