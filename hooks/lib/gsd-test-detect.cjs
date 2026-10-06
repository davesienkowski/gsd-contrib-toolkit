'use strict';

/**
 * hooks/lib/gsd-test-detect.cjs — the shared gsd-test dispatch detector (GTEST-01, GTEST-03).
 *
 * ONE pure predicate both gsd-test dispatch gates (ENF-23 clean-tree, ENF-24 viability) call
 * FIRST: no entry -> the gate allows before any filesystem, git or docker work (RES-01
 * action-first ordering; 36-CONTEXT Addendum 2 — `isNonGovernedCommand` cannot serve, because
 * gsd-test is deliberately NOT a classifyAction action: a new action could displace a merge or
 * review-side action in a chained command and disarm ENF-20, the ENF-22 lesson).
 *
 * Built on the EXISTING parsers only: `argv.parseCommand` for the command and, recursively, for
 * each `bash -c` payload (heredoc bodies are already opaque there; no new stripping code), and
 * `classify.resolveProgram` for env assignments, wrapper builtins and the program basename.
 *
 * `nohup` and `time` are NOT classify WRAPPER_BUILTINS (verified 2026-10-05: `nohup gsd-test`
 * resolves to program `nohup`). They are peeled HERE, detector-locally, by re-running
 * resolveProgram on the token tail; classify.cjs stays byte-unchanged, because widening its
 * wrapper set would reclassify every existing gate's input.
 *
 * Entries (findGsdTestDispatches):
 *   { kind: 'uncertain', reason }  — the command names gsd-test but cannot be attributed
 *                                    (unparseable, ambiguous wrapper, over-deep `-c`,
 *                                    unbalanced substitution, shell expansion in flag
 *                                    position). Gates fail closed on it (HARD-01).
 *   { kind: 'dispatch', subcommand, seg, segIndex, args, flags, unresolved, informational,
 *     background, pipedOut, pipefail, pipeMasked, viaDashC, depth, prefixes }
 *   `subcommand` is null for the classic path, else one of SUBCOMMANDS (36-REVIEW M-01); each
 *   gate decides which subcommands it governs.
 *
 * The segment walk is SHARED (37-02, 37-CONTEXT Addendum 2): `findProgramEntries(command,
 * matcher)` runs it with a program matcher that supplies the uncertain word test and the
 * per-segment hook; GSD_TEST_MATCHER (the pre-37-02 gsd-test branch, moved verbatim) is the
 * default, and `findGsdTestDispatches` is the walk with that matcher. hooks/lib/worktree-add-detect
 * is the second matcher. Grouping, the quote mask, wrapper / nohup / time peel, start dirs,
 * `command -v` lookups and the `bash -c` / `eval` recursion stay in the walk, for every matcher.
 *
 * Pure: no fs, no child_process, no env reads (env and homedir are always passed in). Never
 * executes the command it classifies. Never throws on a string input.
 *
 * @module hooks/lib/gsd-test-detect
 */

const path = require('node:path');
const { parseCommand, classifyTokens, parseHeredocOperator, findHeredocBodyEnd } = require('./argv.cjs');
const { resolveProgram } = require('./classify.cjs');
const { commandStartDir } = require('./resolve.cjs');

/** HARD-01 word test for uncertain input: gsd-test as a whole word, not gsd-test-other. */
const GSD_TEST_WORD = /(^|[^\w-])gsd-test(?![\w-])/;

/** `bash -c "bash -c '...'"` is depth 2; a payload deeper than this is graded uncertain. */
const MAX_DASH_C_DEPTH = 2;

/** Bound on the detector-local nohup/time peel (T-36-08). */
const MAX_PEELS = 4;

/** gsd-test v1.8.0 `--help`: flags that take a value (Addendum 1). */
const VALUE_FLAGS = new Set([
  'base', 'bench', 'config', 'exclude', 'head', 'node', 'scratch', 'source', 'targets',
]);

/** gsd-test v1.8.0 `--help`: boolean flags (Addendum 1). */
const BOOLEAN_FLAGS = new Set([
  'json-events', 'probe-benches', 'quiet', 'verbose', 'version', 'help', 'h',
]);

/**
 * A dispatch carrying any of these (truthy) only prints information; both gates pass it.
 * `probe-benches` is NOT here (36-REVIEW B-01): v1.8.0 probes bench reachability during
 * config.Load and then runs the full suite — only `--version` returns before runner.Run.
 */
const INFORMATIONAL_FLAGS = new Set(['version', 'help', 'h']);

/** The classic (no-subcommand) flagset: `parseFlags` in v1.8.0 cmd/gsd-test/main.go. */
const CLASSIC_FLAGSET = Object.freeze({ value: VALUE_FLAGS, bool: BOOLEAN_FLAGS });

/**
 * v1.8.0 subcommands (36-REVIEW M-01). `run()` dispatches on `args[0]` ONLY, before any flag
 * parsing, so `gsd-test --quiet run` is the classic path with a positional. Each walked
 * subcommand has its own Go flagset (main.go runRun / runSubmit / runInstallHooks); `wait` and
 * `status` take a bare run id (no flagset), so their arguments are collected as positionals and an
 * expanded run id is NOT uncertain. `__run-worker` (internal, spawned by gsd-test itself) is
 * deliberately absent: it falls to the classic path, which over-governs it (fail-safe).
 */
const SUBCOMMANDS = Object.freeze({
  run: { value: new Set(['target', 'config', 'estimate-ms']), bool: new Set(['async', 'keep', 'help', 'h']) },
  submit: { value: new Set(['spec-file', 'config']), bool: new Set(['execute', 'help', 'h']) },
  'install-agent-hooks': { positionalOnly: true },
  wait: { positionalOnly: true },
  status: { positionalOnly: true },
});

/** Go's flag package reads these boolean values as false. */
const GO_FALSE = new Set(['false', '0', 'f', 'F', 'FALSE', 'False']);

/** Shells whose `-c` payload is re-parsed through parseCommand. */
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);

/**
 * Leading lone tokens that are not the program: group openers, the `|&` residue, negation,
 * and the compound-command keywords whose body follows on the same segment (`then gsd-test`,
 * `do gsd-test`). Rule 2 hardening: argv splits `if x; then gsd-test | tail; fi` into a
 * `then gsd-test` segment, which would otherwise resolve to program `then`.
 */
const LEADING_NOISE = new Set(['(', '{', '&', '!', 'then', 'do', 'else', 'if', 'elif', 'while', 'until']);

/**
 * Shell redirect token: optional fd digits, the operator, then an optional attached target.
 * An operator-only token consumes the following token as its target.
 */
const REDIRECT = /^\d*(&>>|&>|>>|>&|>\||<<<|<<|<&|<>|>|<)([\s\S]*)$/;

/** True when a string carries a parameter / command expansion the detector cannot resolve. */
function hasExpansion(s) {
  return typeof s === 'string' && (s.includes('$') || s.includes('`'));
}

function countChar(s, ch) {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s[i] === ch) n += 1;
  return n;
}

/** Paren balance and backtick parity of a (possibly multi-token) substitution value. */
function substitutionOpen(value) {
  return countChar(value, '(') - countChar(value, ')') > 0 || countChar(value, '`') % 2 === 1;
}

/**
 * The Go-flag walker (Addendum 1; checker item 2) over the raw tokens AFTER the gsd-test
 * program token. Go's flag package accepts `-f v`, `--f v`, `-f=v`, `--f=v`; a value flag takes
 * the next token unconditionally; parsing stops at `--` and at the first non-flag argument.
 *
 * Substitution attribution: a value that opens `$(` or a backtick consumes the following tokens
 * until balanced, so flags after `--head $(git rev-parse HEAD)` are still read. When the tokens
 * run out first, or a token in flag/positional position (or a flag NAME) carries `$` or a
 * backtick, the list cannot be attributed and `uncertainReason` is set (gates fail closed).
 *
 * @param {string[]} tokens
 * @returns {{flags:Object, unresolved:Set<string>, positionals:string[], background:boolean,
 *   uncertainReason:(string|null)}}
 */
function walkGoFlags(tokens, flagset) {
  const fset = flagset && flagset.value && flagset.bool ? flagset : CLASSIC_FLAGSET;
  const toks = Array.isArray(tokens) ? tokens.filter((t) => typeof t === 'string') : [];
  const flags = {};
  const unresolved = new Set();
  const positionals = [];
  let background = false;
  let uncertainReason = null;

  /** Index just past a redirect at `k` (operator-only consumes its target), or -1. */
  const redirectEnd = (k) => {
    const m = REDIRECT.exec(toks[k]);
    if (!m) return -1;
    return m[2] === '' ? k + 2 : k + 1;
  };

  /** Collect the remaining tokens (minus redirects; a lone & ends the command) as positionals. */
  const collectRest = (k) => {
    while (k < toks.length) {
      const r = redirectEnd(k);
      if (r !== -1) { k = r; continue; }
      if (toks[k] === '&') { background = true; break; }
      positionals.push(toks[k]);
      k += 1;
    }
  };

  let i = 0;
  while (i < toks.length) {
    const t = toks[i];

    const r = redirectEnd(i);
    if (r !== -1) { i = r; continue; }

    if (t === '&') {
      // A lone `&` backgrounds the dispatch; anything after it is another command.
      background = true;
      break;
    }

    if (t === '--') {
      collectRest(i + 1);
      break;
    }

    const isFlag = t.startsWith('-') && t !== '-';
    if (!isFlag) {
      if (hasExpansion(t)) {
        // `gsd-test $EXTRA --head x`, `"$@"`: the shell may expand this into any flags.
        uncertainReason = 'unresolvable shell expansion in gsd-test arguments';
        break;
      }
      collectRest(i); // first literal positional: Go stops flag parsing here
      break;
    }

    const body = t.startsWith('--') ? t.slice(2) : t.slice(1);
    const eq = body.indexOf('=');
    const name = eq === -1 ? body : body.slice(0, eq);
    if (hasExpansion(name)) {
      uncertainReason = 'unresolvable shell expansion in gsd-test arguments';
      break;
    }

    if (fset.value.has(name)) {
      let value;
      if (eq !== -1) {
        value = body.slice(eq + 1);
        i += 1;
      } else {
        let j = i + 1;
        // The shell removes redirects before Go sees argv, so the value is the next
        // non-redirect token.
        for (let rr = redirectEnd(j); rr !== -1; rr = redirectEnd(j)) j = rr;
        if (j >= toks.length || toks[j] === '&') {
          // Go exits 2 ("flag needs an argument"); grade it uncertain rather than absent.
          uncertainReason = `missing value for the -${name} flag`;
          break;
        }
        value = toks[j];
        i = j + 1;
      }
      if (value.includes('$(') || value.includes('`')) {
        while (substitutionOpen(value)) {
          if (i >= toks.length) {
            uncertainReason = `unbalanced command substitution in the -${name} value`;
            break;
          }
          value += ' ' + toks[i];
          i += 1;
        }
        if (uncertainReason) break;
      }
      flags[name] = value;
      if (hasExpansion(value)) unresolved.add(name);
      continue;
    }

    // Boolean (known or unknown — Go would reject an unknown flag; it is recorded, never
    // used to attribute a later token).
    if (eq === -1) {
      flags[name] = true;
    } else {
      const v = body.slice(eq + 1);
      flags[name] = fset.bool.has(name) ? !GO_FALSE.has(v) : v;
    }
    i += 1;
  }

  return { flags, unresolved, positionals, background, uncertainReason };
}

/**
 * The positional-only walk for `wait` / `status` / `install-agent-hooks` arguments: redirects
 * dropped, a lone `&` backgrounds, everything else is a positional. Never uncertain — these
 * entries are governed (if at all) only by the pipe attribution, which does not read arguments.
 */
function walkPositionals(tokens) {
  const toks = Array.isArray(tokens) ? tokens.filter((t) => typeof t === 'string') : [];
  const positionals = [];
  let background = false;
  for (let k = 0; k < toks.length; ) {
    const m = REDIRECT.exec(toks[k]);
    if (m) { k += m[2] === '' ? 2 : 1; continue; }
    if (toks[k] === '&') { background = true; break; }
    positionals.push(toks[k]);
    k += 1;
  }
  return { flags: {}, unresolved: new Set(), positionals, background, uncertainReason: null };
}

/**
 * The v1.8.0 subcommand at `args[0]` (the first token after the program once the shell has
 * removed redirects), or null for the classic path. Returns the remaining tokens with the
 * subcommand word removed (redirects kept; the walkers skip them).
 *
 * @param {string[]} after tokens after the gsd-test program token
 * @returns {{name:(string|null), rest:string[]}}
 */
function leadingSubcommand(after) {
  let k = 0;
  while (k < after.length) {
    const m = REDIRECT.exec(after[k]);
    if (!m) break;
    k += m[2] === '' ? 2 : 1;
  }
  const word = after[k];
  if (typeof word === 'string' && Object.prototype.hasOwnProperty.call(SUBCOMMANDS, word)) {
    return { name: word, rest: after.slice(0, k).concat(after.slice(k + 1)) };
  }
  return { name: null, rest: after };
}

/** Whether a walked dispatch only prints information (help / version) and runs nothing. */
function isInformational(flags, subcommand) {
  for (const f of INFORMATIONAL_FLAGS) {
    if (subcommand !== null && f === 'version') continue; // not a subcommand flag
    // N-03: no gsd-test flagset defines h/help, so Go's flag package returns ErrHelp for them
    // before reading any value: `-h=0` prints usage and runs nothing.
    if ((f === 'h' || f === 'help') && flags[f] !== undefined) return true;
    if (flags[f] !== undefined && flags[f] !== false) return true;
  }
  return false;
}

/**
 * Quoted / escaped structural characters are replaced 1:1 by these placeholders in the quote
 * MASK, so a masked token has exactly the length of its real token and index-based slicing
 * stays aligned. Only the mask is used for grouping decisions; the real tokens are returned.
 */
const MASK_CHARS = { '(': '\u0001', ')': '\u0002', '{': '\u0003', '}': '\u0004', '&': '\u0005' };

function maskChar(ch) {
  return Object.prototype.hasOwnProperty.call(MASK_CHARS, ch) ? MASK_CHARS[ch] : ch;
}

/**
 * The quote mask of a raw command (36-03 handoff 2). argv removes quotes, so `echo "("` yields
 * a bare `(` token that used to count as a group opener. This walk mirrors
 * argv.splitSegmentsWithOps' quote / escape / heredoc state machine character for character and
 * replaces every quoted or escaped `( ) { } &` with a placeholder, so parsing the masked string
 * yields tokens aligned 1:1 with the real ones in which only UNQUOTED structure survives — the
 * quote view argv itself uses.
 *
 * Exactness limit: argv (like this walk) does not model a double quote nested inside a
 * double-quoted `$(...)` (`"$(echo "(")"`). When a double-quoted region closes while a `$(` or a
 * backtick opened inside it is still open, the following unquoted span may really be quoted; a
 * paren or brace in that span makes the grouping unattributable and sets `ambiguous` (the
 * scanner then grades the command uncertain if it names gsd-test).
 *
 * @param {string} str
 * @returns {{masked:string, ambiguous:boolean}}
 */
function maskQuoted(str) {
  let out = '';
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  let region = null; // the current double-quoted region: {sub, bal, ticks}
  let nested = false; // a double-quoted region closed with a substitution still open
  let ambiguous = false;
  const pending = [];

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (escaped) {
      out += maskChar(ch);
      escaped = false;
      continue;
    }
    if (ch === '\\' && !inSingle) {
      out += ch;
      escaped = true;
      continue;
    }
    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
        out += ch;
      } else {
        out += maskChar(ch);
      }
      continue;
    }
    if (inDouble) {
      if (ch === '"') {
        inDouble = false;
        out += ch;
        nested = (region.sub && region.bal > 0) || region.ticks % 2 === 1;
        continue;
      }
      if (ch === '(') {
        region.bal += 1;
        if (str[i - 1] === '$') region.sub = true;
      } else if (ch === ')') {
        region.bal -= 1;
      } else if (ch === '`') {
        region.ticks += 1;
      }
      out += maskChar(ch);
      continue;
    }

    // Unquoted context — the same check order as splitSegmentsWithOps.
    const hd = parseHeredocOperator(str, i);
    if (hd) {
      out += str.slice(i, hd.end);
      pending.push({ delim: hd.delim, dash: hd.dash });
      i = hd.end - 1;
      continue;
    }
    if (ch === "'") {
      out += ch;
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      out += ch;
      inDouble = true;
      region = { sub: false, bal: 0, ticks: 0 };
      nested = false;
      continue;
    }
    if (ch === '\n' && pending.length > 0) {
      out += ch;
      let bodyStart = i + 1;
      for (const h of pending) bodyStart = findHeredocBodyEnd(str, bodyStart, h.delim, h.dash);
      pending.length = 0;
      out += str.slice(i + 1, bodyStart); // bodies are opaque (never tokens): copied verbatim
      i = bodyStart - 1;
      continue;
    }
    if (nested && (ch === '(' || ch === ')' || ch === '{' || ch === '}')) ambiguous = true;
    out += ch;
  }
  return { masked: out, ambiguous };
}

/**
 * Per-segment masked tokens for a parsed command, aligned 1:1 (segment count, token count and
 * token length) with `parsed.segments[i].tokens`.
 *
 * @returns {{tokens:(string[][]|null), ambiguous:boolean}} tokens null when the mask cannot be
 *   aligned (treated as ambiguous by the caller)
 */
function maskedSegmentTokens(parsed) {
  if (!parsed || typeof parsed.raw !== 'string') return { tokens: null, ambiguous: true };
  const m = maskQuoted(parsed.raw);
  const mp = parseCommand(m.masked);
  if (!mp.ok || mp.segments.length !== parsed.segments.length) return { tokens: null, ambiguous: true };
  const out = [];
  for (let i = 0; i < parsed.segments.length; i++) {
    const real = parsed.segments[i].tokens;
    const mask = mp.segments[i].tokens;
    if (real.length !== mask.length) return { tokens: null, ambiguous: true };
    for (let k = 0; k < real.length; k++) {
      if (real[k].length !== mask[k].length) return { tokens: null, ambiguous: true };
    }
    out.push(mask);
  }
  return { tokens: out, ambiguous: m.ambiguous };
}

/**
 * Normalise one segment's raw tokens for program resolution (Addendum 3): drop leading lone
 * noise tokens, strip leading `(`/`{`/`&` characters from the first token, move an attached
 * trailing `&` to its own token, and strip group closers from the LAST token by paren balance
 * (so `$(git rev-parse HEAD))` keeps the substitution's own `)`).
 *
 * @param {string[]} raw
 * @returns {{tokens:string[], openers:string[], post:number}} `openers` are the group types
 *   opened before the program ('sub' | 'brace'); `post` is the net paren/brace depth change of
 *   the rest of the segment (negative when it closes groups).
 */
function normalizeSegment(raw, rawMask) {
  const tokens = Array.isArray(raw) ? raw.filter((t) => typeof t === 'string') : [];
  // Every structural DECISION reads the quote mask `m` (36-03 handoff 2: only unquoted ( ) { } &
  // count); every edit is applied identically to the real tokens `t` and to `m`, which stay
  // aligned because the mask is a 1:1 character substitution. Without a usable mask the real
  // tokens are their own mask (the pre-36-03 behaviour).
  const aligned =
    Array.isArray(rawMask) &&
    rawMask.length === tokens.length &&
    rawMask.every((x, k) => typeof x === 'string' && x.length === tokens[k].length);
  const openers = [];
  let t = tokens.slice();
  let m = aligned ? rawMask.slice() : tokens.slice();

  for (let guard = 0; guard < 64 && t.length > 0; guard++) {
    const first = m[0];
    if (LEADING_NOISE.has(first)) {
      if (first === '(') openers.push('sub');
      if (first === '{') openers.push('brace');
      t.shift();
      m.shift();
      continue;
    }
    const lead = /^[({&]+/.exec(first);
    if (lead) {
      for (const ch of lead[0]) {
        if (ch === '(') openers.push('sub');
        if (ch === '{') openers.push('brace');
      }
      const n = lead[0].length;
      if (n === first.length) { t.shift(); m.shift(); continue; }
      t[0] = t[0].slice(n);
      m[0] = m[0].slice(n);
    }
    break;
  }

  // Depth change of the remaining tokens, counted before any trailing strip.
  let post = 0;
  for (const tok of m) {
    if (tok === '{') { post += 1; continue; }
    if (tok === '}') { post -= 1; continue; }
    post += countChar(tok, '(') - countChar(tok, ')');
  }

  // Attached trailing `&` (`2>&1&`, `HEAD&`) -> background token.
  if (t.length > 0) {
    const last = m[m.length - 1];
    if (last.length > 1 && last.endsWith('&') && !/[<>]&$/.test(last) && !last.endsWith('&&')) {
      t[t.length - 1] = t[t.length - 1].slice(0, -1);
      m[m.length - 1] = last.slice(0, -1);
      t.push('&');
      m.push('&');
    }
  }

  // Strip group closers by balance from the last non-`&` token.
  let opens = 0;
  let closes = 0;
  for (const tok of m) { opens += countChar(tok, '('); closes += countChar(tok, ')'); }
  const bgTail = m.length > 0 && m[m.length - 1] === '&';
  let li = bgTail ? m.length - 2 : m.length - 1;
  while (li >= 0 && closes > opens && m[li].endsWith(')')) {
    t[li] = t[li].slice(0, -1);
    m[li] = m[li].slice(0, -1);
    closes -= 1;
    if (m[li] === '') { t.splice(li, 1); m.splice(li, 1); li -= 1; }
  }

  return { tokens: t, openers, post };
}

/**
 * Index of the program token `prog` in `tokens`: the first token whose basename is `prog` and
 * at which resolveProgram over the prefix resolves to it (so `sudo -u bash bash -c` picks the
 * second `bash`). Falls back to the first basename match.
 */
function programIndex(tokens, prog) {
  let fallback = -1;
  for (let i = 0; i < tokens.length; i++) {
    if (path.basename(tokens[i]) !== prog) continue;
    if (fallback === -1) fallback = i;
    if (resolveProgram({ tokens: tokens.slice(0, i + 1) }).prog === prog) return i;
  }
  return fallback;
}

/**
 * resolveProgram plus the detector-local nohup/time peel, bounded to MAX_PEELS.
 *
 * @param {string[]} tokens normalised segment tokens
 * @returns {{prog:string, idx:number, ambiguous:boolean}}
 */
function resolveSegmentProgram(tokens) {
  let offset = 0;
  for (let peel = 0; peel <= MAX_PEELS; peel++) {
    const sub = tokens.slice(offset);
    const r = resolveProgram({ tokens: sub });
    if (r.ambiguous) return { prog: r.prog, idx: -1, ambiguous: true };
    if (r.prog !== 'nohup' && r.prog !== 'time') {
      const idx = programIndex(sub, r.prog);
      return { prog: r.prog, idx: idx === -1 ? -1 : offset + idx, ambiguous: false };
    }
    if (peel === MAX_PEELS) break; // still a nohup/time after the bound -> cannot resolve
    const at = programIndex(sub, r.prog);
    if (at === -1) return { prog: r.prog, idx: -1, ambiguous: false };
    let next = at + 1;
    if (r.prog === 'time') while (sub[next] === '-p') next += 1;
    if (sub[next] === '--') next += 1;
    if (next >= sub.length) return { prog: r.prog, idx: -1, ambiguous: false }; // bare nohup/time
    offset += next;
  }
  return { prog: '', idx: -1, ambiguous: true };
}

/**
 * Rejoin assignment tokens whose value opens a command substitution argv split on whitespace
 * (`SHA=$(git rev-parse HEAD)` arrives as `SHA=$(git`, `rev-parse`, `HEAD)`), so the program slot
 * is not mistaken for a word inside the substitution. null when the substitution never closes.
 */
function joinAssignmentSubstitutions(tokens) {
  const out = [];
  for (let k = 0; k < tokens.length; k++) {
    let t = tokens[k];
    const a = /^[A-Za-z_][A-Za-z0-9_]*=/.exec(t);
    if (a && (t.includes('$(') || t.includes('`'))) {
      while (substitutionOpen(t)) {
        if (k + 1 >= tokens.length) return null;
        k += 1;
        t += ' ' + tokens[k];
      }
    }
    out.push(t);
  }
  return out;
}

/**
 * The working-directory options of the `env` and `sudo` wrappers (36-REVIEW M-03): `env -C <dir>`
 * / `--chdir[=]<dir>` and `sudo -D <dir>` / `--chdir[=]<dir>`. `value` lists each wrapper's OTHER
 * value-taking options (short letters and long names), so a cluster or a value is never misread
 * as the chdir. The short letters mirror classify.WRAPPER_VALUE_FLAGS (classify.cjs is unchanged).
 */
const CHDIR_WRAPPERS = Object.freeze({
  env: { chdir: 'C', short: new Set(['u', 'S']), long: new Set(['unset', 'split-string']) },
  sudo: {
    chdir: 'D',
    short: new Set(['u', 'g', 'U', 'C', 'h', 'p', 'r', 't']),
    long: new Set(['user', 'group', 'other-user', 'close-from', 'host', 'prompt', 'role', 'type', 'command-timeout']),
  },
});

/** A program-slot sentinel no real token can equal (a NUL is never in an argv token). */
const SLOT_PROBE = '\u0000gsd-test-slot';

/**
 * Strip the chdir options of every `env` / `sudo` wrapper that sits in WRAPPER position (the
 * token is where resolveSegmentProgram would look for the program), recording each directory in
 * order. Without this, classify.resolveProgram reads `sudo -D /x gsd-test` as program `x` (its
 * sudo value set has no `-D`) and `env --chdir /x gsd-test` as program `x`, hiding the dispatch,
 * and `env -C /x gsd-test` resolves but the directory change was lost (M-03).
 *
 * @param {string[]} tokens normalised segment tokens
 * @returns {{tokens:string[], chdirs:(string|null)[]}} `null` marks a chdir option whose value
 *   is missing (unresolvable)
 */
function stripChdirOptions(tokens) {
  let toks = tokens.slice();
  const chdirs = [];
  for (let i = 0; i < toks.length; i++) {
    const spec = CHDIR_WRAPPERS[path.basename(toks[i])];
    if (!spec) continue;
    const slot = resolveSegmentProgram(toks.slice(0, i).concat([SLOT_PROBE]));
    if (slot.ambiguous || slot.prog !== SLOT_PROBE || slot.idx !== i) continue;

    let k = i + 1;
    while (k < toks.length && toks[k].startsWith('-') && toks[k] !== '-') {
      const t = toks[k];
      if (t === '--') break;
      if (t.startsWith('--')) {
        const eq = t.indexOf('=');
        const name = eq === -1 ? t.slice(2) : t.slice(2, eq);
        if (name === 'chdir') {
          if (eq !== -1) {
            chdirs.push(t.slice(eq + 1));
            toks.splice(k, 1);
          } else {
            chdirs.push(k + 1 < toks.length ? toks[k + 1] : null);
            toks.splice(k, 2);
          }
          continue;
        }
        k += eq === -1 && spec.long.has(name) ? 2 : 1;
        continue;
      }
      // A short cluster: booleans, then at most one value letter (its value is the rest of the
      // token, or the next token).
      let consumedNext = false;
      let stripped = false;
      for (let c = 1; c < t.length; c++) {
        const L = t[c];
        if (L === spec.chdir) {
          const rest = t.slice(c + 1);
          const head = t.slice(0, c);
          if (rest !== '') {
            chdirs.push(rest);
          } else {
            chdirs.push(k + 1 < toks.length ? toks[k + 1] : null);
            if (k + 1 < toks.length) toks.splice(k + 1, 1);
          }
          if (head === '-') toks.splice(k, 1);
          else { toks[k] = head; k += 1; }
          stripped = true;
          break;
        }
        if (spec.short.has(L)) {
          consumedNext = c === t.length - 1;
          break;
        }
      }
      if (stripped) continue;
      k += consumedNext ? 2 : 1;
    }
  }
  return { tokens: toks, chdirs };
}

/** Synthetic `cd` prefixes for wrapper chdirs, folded by startDirFor after the real prefixes. */
function chdirPrefixes(chdirs) {
  return chdirs.map((dir) => ({
    ok: true,
    segments: [
      dir === null
        ? { program: 'cd', tokens: ['cd'], positionals: [], unresolvable: true }
        : { program: 'cd', tokens: ['cd', '--', dir], positionals: [dir] },
    ],
  }));
}

/**
 * Whether a resolved gsd-test program is only LOOKED UP (36-REVIEW M-05): a `command` wrapper
 * before it carries `-v` or `-V` (alone or clustered: `-pv`), which prints where gsd-test is and
 * runs nothing. classify.resolveProgram skips `-v` as a boolean wrapper flag, so without this the
 * standard "is it installed?" check drew a non-overridable policy deny. `type`, `hash` and
 * `which` resolve to themselves and never reach here.
 */
function isCommandLookup(toks, idx) {
  for (let k = 0; k < idx; k++) {
    if (path.basename(toks[k]) !== 'command') continue;
    for (let j = k + 1; j < idx && /^-[A-Za-z]+$/.test(toks[j]); j++) {
      if (/[vV]/.test(toks[j])) return true;
    }
  }
  return false;
}

/**
 * The environment variables whose value changes what ENF-24 checks (36-REVIEW m-02): the config
 * path (HOME, XDG_CONFIG_HOME — v1.8.0 config.go defaultConfigPath) and the daemon the Docker
 * probe reaches (DOCKER_HOST, DOCKER_CONTEXT).
 */
const WATCHED_ENV = Object.freeze(['HOME', 'XDG_CONFIG_HOME', 'DOCKER_HOST', 'DOCKER_CONTEXT']);

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/;

/**
 * Environment operations a dispatch's OWN segment applies to the gsd-test process, read from the
 * tokens before the program: leading / post-wrapper `NAME=value`, `env -u NAME` / `--unset`,
 * `env -i` / `-` / `--ignore-environment` (clear), and `sudo` (opaque: its env_reset policy is
 * not knowable here). Only WATCHED_ENV names are recorded.
 *
 * @returns {Object[]} ops: {op:'set', name, value} | {op:'unset', name} | {op:'clear'} | {op:'opaque'}
 */
function ownEnvOps(toks, idx) {
  const ops = [];
  let inEnv = false;
  for (let k = 0; k < idx; k++) {
    const t = toks[k];
    const a = ASSIGNMENT.exec(t);
    if (a) {
      if (WATCHED_ENV.includes(a[1])) ops.push({ op: 'set', name: a[1], value: a[2] });
      continue;
    }
    const base = path.basename(t);
    if (base === 'env') { inEnv = true; continue; }
    if (base === 'sudo') { ops.push({ op: 'opaque' }); inEnv = false; continue; }
    if (inEnv && (t === '-' || t === '-i' || t === '--ignore-environment')) { ops.push({ op: 'clear' }); continue; }
    if (inEnv && t.startsWith('--unset')) {
      const name = t.startsWith('--unset=') ? t.slice(8) : toks[k + 1];
      if (!t.startsWith('--unset=')) k += 1;
      if (WATCHED_ENV.includes(name)) ops.push({ op: 'unset', name });
      continue;
    }
    if (inEnv && /^-[A-Za-z]+/.test(t) && !t.startsWith('--')) {
      for (let c = 1; c < t.length; c++) {
        if (t[c] === 'i') ops.push({ op: 'clear' });
        if (t[c] === 'u' || t[c] === 'S') {
          const value = c + 1 < t.length ? t.slice(c + 1) : toks[k + 1];
          if (c + 1 >= t.length) k += 1;
          if (t[c] === 'u' && WATCHED_ENV.includes(value)) ops.push({ op: 'unset', name: value });
          break;
        }
      }
      continue;
    }
    inEnv = false;
  }
  return ops;
}

/**
 * Environment operations a PREFIX segment leaves in the shell for later segments: `export
 * NAME=v`, `declare -x` / `typeset -x NAME=v` (exported), `unset NAME`, `export -n NAME`
 * (opaque for that name), and a bare `NAME=v` segment (a shell variable, exported only if it
 * already was). Only WATCHED_ENV names are recorded.
 */
function prefixEnvOps(seg) {
  const toks = seg && Array.isArray(seg.tokens) ? seg.tokens : [];
  let k = 0;
  const ops = [];
  while (k < toks.length && ASSIGNMENT.test(toks[k])) k += 1;
  if (k === toks.length) {
    for (const t of toks) {
      const a = ASSIGNMENT.exec(t);
      if (WATCHED_ENV.includes(a[1])) ops.push({ op: 'shellset', name: a[1], value: a[2] });
    }
    return ops;
  }
  const prog = path.basename(toks[k]);
  const rest = toks.slice(k + 1);
  if (prog === 'export' || ((prog === 'declare' || prog === 'typeset') && rest.some((t) => /^-[A-Za-z]*x/.test(t)))) {
    const unexport = prog === 'export' && rest.some((t) => /^-[A-Za-z]*n/.test(t));
    for (const t of rest) {
      if (t.startsWith('-')) continue;
      const a = ASSIGNMENT.exec(t);
      const name = a ? a[1] : t;
      if (!WATCHED_ENV.includes(name)) continue;
      if (unexport) ops.push({ op: 'opaque-name', name });
      else if (a) ops.push({ op: 'set', name, value: a[2] });
    }
  } else if (prog === 'unset') {
    if (rest.some((t) => /^-[A-Za-z]*f/.test(t))) return ops; // functions
    for (const t of rest) if (WATCHED_ENV.includes(t)) ops.push({ op: 'unset', name: t });
  }
  return ops;
}

/**
 * The environment a dispatch's gsd-test process sees, and the shell environment its flag values
 * were expanded in (36-REVIEW m-02). Folds the persisting prefix segments (export / unset /
 * declare -x / bare assignment) over `baseEnv`, then the dispatch's own prefix (`NAME=v
 * gsd-test`, `env -u`, `env -i`, sudo). A value carrying an expansion expandStatic cannot resolve
 * makes that name UNRESOLVED (the gate asks rather than guess). Pure.
 *
 * @param {Object} d a `kind:'dispatch'` entry
 * @param {Object} baseEnv the hook's environment
 * @param {string} [homedir]
 * @returns {{shell:{env:Object, unresolved:Set<string>}, child:{env:Object, unresolved:Set<string>, changed:Set<string>}}}
 */
function dispatchEnv(d, baseEnv, homedir) {
  const pick = (e) => {
    const o = {};
    for (const n of WATCHED_ENV) if (e && typeof e[n] === 'string') o[n] = e[n];
    return o;
  };
  const shell = { env: pick(baseEnv), unresolved: new Set() };
  const child = { env: pick(baseEnv), unresolved: new Set(), changed: new Set() };
  const valueOf = (raw) => expandStatic(raw, { env: shell.env, homedir: shell.unresolved.has('HOME') ? undefined : homedir });

  const prefixes = d && Array.isArray(d.prefixes) ? d.prefixes : [];
  for (const p of prefixes) {
    const segs = p && Array.isArray(p.segments) ? p.segments : [];
    for (const seg of segs) {
      for (const op of prefixEnvOps(seg)) {
        if (op.op === 'unset') {
          for (const t of [shell, child]) { delete t.env[op.name]; t.unresolved.delete(op.name); }
          child.changed.add(op.name);
        } else if (op.op === 'opaque-name') {
          child.unresolved.add(op.name);
          child.changed.add(op.name);
        } else {
          const exported = op.op === 'set' || Object.prototype.hasOwnProperty.call(child.env, op.name) || child.unresolved.has(op.name);
          const v = valueOf(op.value);
          const targets = exported ? [shell, child] : [shell];
          for (const t of targets) {
            if (v === null) { delete t.env[op.name]; t.unresolved.add(op.name); }
            else { t.env[op.name] = v; t.unresolved.delete(op.name); }
          }
          if (exported) child.changed.add(op.name);
        }
      }
    }
  }

  for (const op of Array.isArray(d && d.envOps) ? d.envOps : []) {
    if (op.op === 'clear') {
      child.env = {};
      child.unresolved.clear();
      for (const n of WATCHED_ENV) child.changed.add(n);
    } else if (op.op === 'opaque') {
      for (const n of WATCHED_ENV) { delete child.env[n]; child.unresolved.add(n); child.changed.add(n); }
    } else if (op.op === 'unset') {
      delete child.env[op.name];
      child.unresolved.delete(op.name);
      child.changed.add(op.name);
    } else if (op.op === 'set') {
      // `NAME=v cmd`: the value is expanded in the SHELL's environment, before the prefix applies.
      const v = valueOf(op.value);
      if (v === null) { delete child.env[op.name]; child.unresolved.add(op.name); }
      else { child.env[op.name] = v; child.unresolved.delete(op.name); }
      child.changed.add(op.name);
    }
  }
  return { shell, child };
}

/**
 * Walk a shell's options (`bash -o pipefail -lc '<payload>'`).
 *
 * @param {string[]} after tokens after the shell program token
 * @returns {{dashC:boolean, payload:(string|undefined), shellPipefail:boolean}}
 */
function readShellOptions(after) {
  let dashC = false;
  let shellPipefail = false;
  let i = 0;
  while (i < after.length) {
    const t = after[i];
    if (t === '--') { i += 1; break; }
    if ((t.startsWith('-') || t.startsWith('+')) && t.length > 1 && !t.startsWith('--') && !t.startsWith('++')) {
      const on = t[0] === '-';
      const letters = t.slice(1);
      if (letters.includes('c')) dashC = true;
      let consumed = 0;
      for (const L of letters) {
        if (L === 'o' || L === 'O') {
          const v = after[i + 1 + consumed];
          if (L === 'o' && v === 'pipefail') shellPipefail = on;
          consumed += 1;
        }
      }
      i += 1 + consumed;
      continue;
    }
    if (t.startsWith('--')) { i += 1; continue; } // --login, --norc, ...
    break;
  }
  return { dashC, payload: dashC ? after[i] : undefined, shellPipefail };
}

/**
 * Pipefail state change for a `set` segment, token-based only: a token beginning with a
 * single `-` (or `+`) that contains `o`, followed by the token `pipefail`.
 *
 * @returns {boolean|null} true / false when the segment turns pipefail on / off, else null
 */
function setPipefailChange(tokens, idx) {
  let change = null;
  for (let k = idx + 1; k < tokens.length - 1; k++) {
    const t = tokens[k];
    if (t === '--') break; // N-02: `set -- -o pipefail` sets positional parameters
    if (!/^[-+][^-+]/.test(t) || !t.slice(1).includes('o')) continue;
    if (tokens[k + 1] === 'pipefail') change = t[0] === '-';
  }
  return change;
}

/**
 * Group-aware pipe attribution (GTEST-03). Walks forward from the dispatch's segment through
 * the depth profile: separators inside a deeper construct (`$( ... )`) are skipped; at the
 * dispatch's level only its own statement's operator counts; when a group containing the
 * dispatch closes, the closing segment's operator decides for the whole group.
 */
function attributePipe(segments, profile, index) {
  let level = profile[index].level;
  let inStatement = true;
  for (let k = index; k < segments.length; k++) {
    const after = profile[k].after;
    const toks = segments[k].tokens || [];
    // N-01: argv splits the noclobber redirect `>|` on its `|`; a segment ending in a bare `>`
    // operator before a `|` is that redirect, and the statement continues in the next segment.
    if (segments[k].nextOp === '|' && /^\d*>$/.test(toks[toks.length - 1] || '')) continue;
    const op = segments[k].nextOp;
    if (after > level) continue;
    if (after === level) {
      if (inStatement && op === '|') return true;
      if (op !== '|') inStatement = false;
      if (!inStatement && level <= 0) return false;
      continue;
    }
    // A group containing the dispatch closed: the group as a whole is now the statement.
    level = after;
    if (op === '|') return true;
    inStatement = false;
    if (level <= 0) return false;
  }
  return false;
}

/** Build a parseCommand-shaped segment from normalised tokens. */
function toSeg(tokens, nextOp) {
  const seg = classifyTokens(tokens.slice());
  seg.nextOp = nextOp === undefined ? null : nextOp;
  return seg;
}

/**
 * Scan one parsed command (top level or a `-c` payload).
 *
 * @param {{ok:true, segments:Object[]}} parsed
 * @param {{depth:number, inheritedPipefail:boolean, outerMasked:boolean, prefixes:Object[],
 *   matcher:Object}} st  (`matcher` is inherited by the bash -c / eval recursion)
 * @returns {Object[]} entries
 */
function scanParsed(parsed, st) {
  const segments = parsed.segments;
  const out = [];
  const m = st.matcher || GSD_TEST_MATCHER;

  // Pass 0 (36-03 handoff 2): the quote mask. Nested quotes inside a double-quoted `$(...)`
  // next to a paren cannot be attributed exactly -> uncertain when the command names gsd-test.
  const mask = maskedSegmentTokens(parsed);
  if (mask.ambiguous) {
    const words = segments.map((s) => s.tokens.join(' ')).join(' ');
    if (m.word.test(String(parsed.raw || '')) || m.word.test(words)) {
      return [{ kind: 'uncertain', reason: 'nested quotes inside a double-quoted substitution make grouping unattributable' }];
    }
  }

  // Pass 1: normalise and compute the depth profile (relative; may dip below 0 on a stray `)`).
  const norm = segments.map((s, i) => normalizeSegment(s.tokens, mask.tokens ? mask.tokens[i] : null));
  const profile = [];
  let depth = 0;
  for (const n of norm) {
    const level = depth + n.openers.length;
    const after = level + n.post;
    profile.push({ before: depth, level, after });
    depth = after;
  }

  // Pass 2: classify each segment. Frames track which `cd` prefixes persist to a later segment:
  // a closed `( ... )` subshell discards its segments; a closed `{ ...; }` keeps them.
  const frames = [{ type: 'top', segs: [] }];
  const prefixNow = () => ({ ok: true, segments: [].concat(...frames.map((f) => f.segs)) });
  let runningPipefail = false;

  for (let i = 0; i < segments.length; i++) {
    const n = norm[i];
    for (const type of n.openers) frames.push({ type, segs: [] });

    if (n.tokens.length > 0) {
      // m-02 follow-on: rejoin `NAME=$(a b)` assignment values argv split on spaces.
      const joined = joinAssignmentSubstitutions(n.tokens);
      if (joined === null) {
        if (m.word.test(n.tokens.join(' '))) {
          out.push({ kind: 'uncertain', reason: `unbalanced command substitution in an assignment before ${m.label}` });
        }
      }
      // M-03: `env -C <dir>` / `sudo -D <dir>` change the directory of THIS segment only.
      const cd = stripChdirOptions(joined === null ? [] : joined);
      const toks = cd.tokens;
      const here = () => st.prefixes.concat([prefixNow()], chdirPrefixes(cd.chdirs));
      const r = resolveSegmentProgram(toks);
      const pipefail = runningPipefail || st.inheritedPipefail;

      if (r.ambiguous) {
        if (m.word.test(toks.join(' '))) {
          out.push({ kind: 'uncertain', reason: `ambiguous wrapper around a ${m.label} mention` });
        }
      } else if (r.idx !== -1 && m.programs.has(r.prog) && isCommandLookup(toks, r.idx)) {
        // M-05: `command -v <program>` — a lookup, not a run (generic: every matcher inherits it).
      } else if (r.idx !== -1 && m.programs.has(r.prog)) {
        // The matcher's per-segment hook (37-02 Addendum 2): everything above and below this
        // branch — grouping, quote mask, wrapper / nohup / time peel, start dirs, recursion — is
        // the shared walk; only the turning of one resolved segment into entries is per program.
        const seg = segments[i];
        const hit = m.segment({
          toks,
          idx: r.idx,
          segIndex: i,
          nextOp: seg.nextOp,
          depth: st.depth,
          pipefail,
          outerMasked: st.outerMasked,
          pipedOut: () => attributePipe(segments, profile, i),
          seg: () => toSeg(toks, seg.nextOp),
          prefixes: here,
        });
        if (Array.isArray(hit)) for (const e of hit) out.push(e);
      } else if (SHELLS.has(r.prog) && r.idx !== -1) {
        const opt = readShellOptions(toks.slice(r.idx + 1));
        if (opt.dashC && typeof opt.payload === 'string') {
          if (st.depth + 1 > MAX_DASH_C_DEPTH) {
            if (m.word.test(opt.payload)) {
              out.push({ kind: 'uncertain', reason: `bash -c payload nested deeper than ${MAX_DASH_C_DEPTH}` });
            }
          } else {
            const pipedOut = attributePipe(segments, profile, i);
            const inner = scanCommand(opt.payload, {
              depth: st.depth + 1,
              inheritedPipefail: opt.shellPipefail,
              outerMasked: (pipedOut && !pipefail) || st.outerMasked,
              prefixes: here(),
              matcher: m,
            });
            for (const e of inner) out.push(e);
          }
        }
      } else if (r.prog === 'eval' && r.idx !== -1) {
        // M-04 (36-REVIEW): `eval` joins its arguments with spaces and runs the result as a
        // command — the bash -c recursion, sharing its depth bound. argv already removed one
        // quoting layer, which is exactly what eval's own parse sees.
        const payload = toks.slice(r.idx + 1).join(' ');
        if (st.depth + 1 > MAX_DASH_C_DEPTH) {
          if (m.word.test(payload)) {
            out.push({ kind: 'uncertain', reason: `eval payload nested deeper than ${MAX_DASH_C_DEPTH}` });
          }
        } else {
          const pipedOut = attributePipe(segments, profile, i);
          const inner = scanCommand(payload, {
            depth: st.depth + 1,
            inheritedPipefail: pipefail,
            outerMasked: (pipedOut && !pipefail) || st.outerMasked,
            prefixes: here(),
            matcher: m,
          }, 'eval');
          for (const e of inner) out.push(e);
        }
      } else if (r.prog === 'set' && r.idx !== -1 && profile[i].level <= 0) {
        // Only a top-level `set` persists; one inside `( ... )` does not reach later segments
        // (a `{ ...; }` one does, but ignoring it only ever keeps a pipe masked: fail-safe).
        const change = setPipefailChange(toks, r.idx);
        // N-02: after `&&` / `||` the `set` may not run; only a pipefail OFF is then assumed.
        const conditional = i > 0 && (segments[i - 1].nextOp === '&&' || segments[i - 1].nextOp === '||');
        if (change === false || (change === true && !conditional)) runningPipefail = change;
      }
    }

    // Record this segment as a prefix candidate for later segments, then apply its closers.
    frames[frames.length - 1].segs.push(toSeg(n.tokens, segments[i].nextOp));
    if (n.post > 0) {
      for (let k = 0; k < n.post; k++) frames.push({ type: 'sub', segs: [] });
    } else {
      for (let k = 0; k < -n.post && frames.length > 1; k++) {
        const f = frames.pop();
        if (f.type === 'brace') frames[frames.length - 1].segs.push(...f.segs);
      }
    }
  }

  return out;
}

/**
 * Parse a payload through the existing parser and scan it (the `bash -c` and `eval` recursion).
 * An unparseable payload that names gsd-test is uncertain (HARD-01).
 */
function scanCommand(payload, st, label) {
  if (typeof payload !== 'string' || payload.trim().length === 0) return [];
  const m = st.matcher || GSD_TEST_MATCHER;
  const parsed = parseCommand(payload);
  if (!parsed.ok) {
    return m.word.test(payload)
      ? [{ kind: 'uncertain', reason: `unparseable ${label || 'bash -c'} payload names ${m.label} (${parsed.reason})` }]
      : [];
  }
  return scanParsed(parsed, st).map((e) => (e.kind !== 'uncertain' ? Object.assign(e, { viaDashC: true }) : e));
}

/**
 * The gsd-test program matcher (37-02 Addendum 2): the per-segment branch the walk ran before the
 * walk was parametrized, moved verbatim. It is the DEFAULT matcher, so every gsd-test caller keeps
 * its exact behaviour.
 *
 * @param {Object} ctx see scanParsed (toks, idx, segIndex, depth, pipefail, outerMasked,
 *   pipedOut(), seg(), prefixes())
 * @returns {Object[]} entries
 */
function gsdTestSegment(ctx) {
  const toks = ctx.toks;
  const sub = leadingSubcommand(toks.slice(ctx.idx + 1));
  const spec = sub.name === null ? CLASSIC_FLAGSET : SUBCOMMANDS[sub.name];
  const w = spec.positionalOnly ? walkPositionals(sub.rest) : walkGoFlags(sub.rest, spec);
  if (w.uncertainReason) return [{ kind: 'uncertain', reason: w.uncertainReason }];
  const pipedOut = ctx.pipedOut();
  const informational = isInformational(w.flags, sub.name);
  return [{
    kind: 'dispatch',
    subcommand: sub.name,
    envOps: ownEnvOps(toks, ctx.idx),
    seg: ctx.seg(),
    segIndex: ctx.segIndex,
    args: w.positionals,
    flags: w.flags,
    unresolved: w.unresolved,
    informational,
    background: w.background,
    pipedOut,
    pipefail: ctx.pipefail,
    pipeMasked: (pipedOut && !ctx.pipefail) || ctx.outerMasked,
    viaDashC: ctx.depth > 0,
    depth: ctx.depth,
    prefixes: ctx.prefixes(),
  }];
}

/**
 * A program matcher for the shared walk:
 *   label     the program name used in uncertain reasons
 *   word      the HARD-01 word test: a command the walk cannot attribute (unparseable, ambiguous
 *             wrapper, over-deep `-c` / eval, ambiguous quoting) is graded uncertain only when
 *             this matches it
 *   programs  the resolved program basenames the matcher claims (never a shell, `eval` or
 *             `set`: those are the walk's own recursion and pipefail branches)
 *   segment   (ctx) => entries for one claimed segment ([] = not an entry)
 */
const GSD_TEST_MATCHER = Object.freeze({
  label: 'gsd-test',
  word: GSD_TEST_WORD,
  programs: new Set(['gsd-test']),
  segment: gsdTestSegment,
});

function validMatcher(m) {
  return Boolean(
    m &&
      typeof m.label === 'string' &&
      m.word instanceof RegExp &&
      m.programs instanceof Set &&
      typeof m.segment === 'function' &&
      ![...m.programs].some((p) => SHELLS.has(p) || p === 'eval' || p === 'set')
  );
}

/**
 * The generic segment walk (37-02 Addendum 2): every entry (and every uncertain mention) a
 * program matcher yields for a raw Bash command, in order. With no matcher it is the gsd-test
 * detector.
 *
 * @param {string} command raw tool_input.command
 * @param {Object} [matcher] see GSD_TEST_MATCHER; default GSD_TEST_MATCHER
 * @param {Object} [opts] internal recursion state ({depth, inheritedPipefail, outerMasked,
 *   prefixes}); callers pass nothing
 * @returns {Object[]} entries
 */
function findProgramEntries(command, matcher, opts) {
  const m = matcher === undefined || matcher === null ? GSD_TEST_MATCHER : matcher;
  if (!validMatcher(m)) throw new TypeError('findProgramEntries: invalid program matcher');
  if (typeof command !== 'string' || command.trim().length === 0) return [];
  const o = opts || {};
  const st = {
    depth: Number.isInteger(o.depth) ? o.depth : 0,
    inheritedPipefail: Boolean(o.inheritedPipefail),
    outerMasked: Boolean(o.outerMasked),
    prefixes: Array.isArray(o.prefixes) ? o.prefixes : [],
    matcher: m,
  };
  try {
    const parsed = parseCommand(command);
    if (!parsed.ok) {
      return m.word.test(command)
        ? [{ kind: 'uncertain', reason: `unparseable command names ${m.label} (${parsed.reason})` }]
        : [];
    }
    return scanParsed(parsed, st);
  } catch (err) {
    // Defensive: the detector must never throw into a gate.
    return m.word.test(command)
      ? [{ kind: 'uncertain', reason: `detector error (${err && err.message ? err.message : 'unknown'})` }]
      : [];
  }
}

/**
 * Every gsd-test dispatch (and every uncertain gsd-test mention) in a raw Bash command, in
 * order: the generic walk with the gsd-test matcher.
 *
 * @param {string} command raw tool_input.command
 * @param {Object} [opts] internal recursion state ({depth, inheritedPipefail, outerMasked,
 *   prefixes}); callers pass nothing
 * @returns {Object[]} entries
 */
function findGsdTestDispatches(command, opts) {
  return findProgramEntries(command, GSD_TEST_MATCHER, opts);
}

/**
 * The first `kind: 'dispatch'` entry, or null. Never returns an uncertain entry (the tracer
 * gate reads this until 36-03 switches it to the plural form).
 *
 * @param {string} command
 * @returns {Object|null}
 */
function findGsdTestDispatch(command) {
  for (const e of findGsdTestDispatches(command)) if (e.kind === 'dispatch') return e;
  return null;
}

/**
 * Static expansion of a flag value: `~`, `~/`, a leading `$HOME`/`${HOME}`, a leading
 * `$XDG_CONFIG_HOME`/`${XDG_CONFIG_HOME}`. Anything else still carrying `$` or a backtick (or a
 * `~user` form) cannot be resolved -> null.
 *
 * @param {string} value
 * @param {{env?:Object, homedir?:string}} ctx
 * @returns {string|null}
 */
function expandStatic(value, ctx) {
  if (typeof value !== 'string') return null;
  const env = (ctx && ctx.env) || {};
  const homedir = ctx && typeof ctx.homedir === 'string' ? ctx.homedir : null;
  let v = value;

  if (v === '~' || v.startsWith('~/')) {
    if (!homedir) return null;
    v = v === '~' ? homedir : path.join(homedir, v.slice(2));
  } else if (v.startsWith('~')) {
    return null; // ~user
  } else {
    const home = /^(?:\$HOME|\$\{HOME\})(?=\/|$)/.exec(v);
    const xdg = /^(?:\$XDG_CONFIG_HOME|\$\{XDG_CONFIG_HOME\})(?=\/|$)/.exec(v);
    if (home) {
      const h = env.HOME || homedir;
      if (!h) return null;
      v = h + v.slice(home[0].length);
    } else if (xdg) {
      const x = env.XDG_CONFIG_HOME;
      if (typeof x !== 'string' || x.length === 0) return null;
      v = x + v.slice(xdg[0].length);
    }
  }
  return hasExpansion(v) ? null : v;
}

/** bash `cd` options: `-L`, `-P`, `-e`, `-@`, alone or clustered (`-Pe`). */
const CD_OPTION = /^-[LPe@]+$/;

/**
 * The target of one `cd` segment, read from its RAW tokens (36-REVIEW M-02): leading
 * assignments and the `cd` word are skipped, then bash's options (`-L`/`-P`/`-e`/`-@`, clustered
 * or not) and an ending `--`. argv/classify read `cd -P /x` as a short flag consuming `/x` (no
 * positional), and resolve.commandStartDir then fell back to `<cwd>/-P` — a bypass from a
 * non-gsd-core session cwd. An unknown option -> unresolvable. A bare `cd` (N-05) goes to the
 * shell's $HOME: the env HOME, else the injected homedir, else unresolvable.
 *
 * @returns {{target:string}|{noop:true}|null} null when the target cannot be known
 */
function cdTarget(seg, ctx) {
  const toks = Array.isArray(seg.tokens) ? seg.tokens : [];
  let k = 0;
  while (k < toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[k])) k += 1;
  k += 1; // the `cd` word
  while (k < toks.length) {
    const t = toks[k];
    if (t === '--') { k += 1; break; }
    if (CD_OPTION.test(t)) { k += 1; continue; }
    if (t.length > 1 && t.startsWith('-')) return null; // an option bash would reject or we cannot read
    break;
  }
  // Redirects are removed by the shell before `cd` sees its arguments.
  while (k < toks.length) {
    const m = REDIRECT.exec(toks[k]);
    if (!m) break;
    k += m[2] === '' ? 2 : 1;
  }
  const target = toks[k];
  if (target === undefined) {
    const env = (ctx && ctx.env) || {};
    if (typeof env.HOME === 'string' && env.HOME !== '') return { target: env.HOME };
    if (ctx && typeof ctx.homedir === 'string' && ctx.homedir !== '') return { target: ctx.homedir };
    return null;
  }
  if (target === '') return { noop: true };
  return { target };
}

/**
 * A prefix with every `cd` target read past its options (M-02) and statically expanded (36-03
 * handoff 1). resolve.commandStartDir would resolve `cd "$X"` as the literal path `<cwd>/$X`;
 * here a target carrying `$` or a backtick goes through expandStatic (leading
 * `$HOME`/`${HOME}`/`$XDG_CONFIG_HOME` only), a `~` / `~/x` target uses the injected homedir
 * when one is given, and a `~user`, `cd -` or unknown-option target cannot be resolved at all.
 * Each rewritten `cd` segment carries exactly `tokens: ['cd', target]` and `positionals:
 * [target]`, the two fields commandStartDir reads. null when any persisting `cd` target is
 * unresolvable.
 */
function expandCdTargets(prefix, ctx) {
  if (!prefix || prefix.ok !== true || !Array.isArray(prefix.segments)) return prefix;
  const segments = [];
  for (const seg of prefix.segments) {
    if (!seg || seg.program !== 'cd') {
      segments.push(seg);
      continue;
    }
    if (seg.unresolvable) return null; // a wrapper chdir option with no value (M-03)
    const t = cdTarget(seg, ctx);
    if (t === null) return null;
    if (t.noop) continue; // `cd ""` stays put
    let target = t.target;
    if (target === '-') return null; // `cd -` goes to $OLDPWD, which is not knowable here
    if (target.startsWith('~') && target !== '~' && !target.startsWith('~/')) return null; // ~user
    const homeForm = (target === '~' || target.startsWith('~/')) && ctx && typeof ctx.homedir === 'string';
    if (hasExpansion(target) || homeForm) {
      const expanded = expandStatic(target, ctx || {});
      if (expanded === null) return null;
      target = expanded;
    }
    segments.push(Object.assign({}, seg, { tokens: ['cd', target], positionals: [target] }));
  }
  return Object.assign({}, prefix, { segments });
}

/**
 * The directory a dispatch starts in: fold commandStartDir over its prefixes (outer prefix
 * first, then each `-c` payload prefix). `git -C` never persists ({followGitC:false}); segments
 * after the dispatch are never consulted.
 *
 * null when a persisting `cd` target is a shell expansion expandStatic cannot resolve (or a
 * `~user` form): the start dir is then unknown and a gate must fail closed rather than trust
 * `<cwd>/$X` (36-03 handoff 1).
 *
 * @param {Object} dispatch a `kind:'dispatch'` entry
 * @param {string} cwd
 * @param {{env?:Object, homedir?:string}} [ctx] for static `cd` target expansion
 * @returns {string|null}
 */
function startDirFor(dispatch, cwd, ctx) {
  let dir = cwd;
  const prefixes = dispatch && Array.isArray(dispatch.prefixes) ? dispatch.prefixes : [];
  for (const p of prefixes) {
    const q = expandCdTargets(p, ctx);
    if (q === null) return null;
    dir = commandStartDir(q, dir, { followGitC: false });
  }
  return dir;
}

/**
 * The tree a dispatch tests: `-source` (statically expanded, resolved against the start dir) or
 * the start dir. null when `-source` or the start dir cannot be resolved.
 *
 * @param {Object} dispatch
 * @param {string} cwd
 * @param {{env?:Object, homedir?:string}} ctx
 * @returns {string|null}
 */
function treeDirFor(dispatch, cwd, ctx) {
  const start = startDirFor(dispatch, cwd, ctx);
  if (start === null) return null;
  const source = dispatch && dispatch.flags ? dispatch.flags.source : undefined;
  if (typeof source !== 'string') return start;
  const expanded = expandStatic(source, ctx);
  if (expanded === null) return null;
  return path.resolve(start, expanded);
}

module.exports = {
  findProgramEntries,
  GSD_TEST_MATCHER,
  REDIRECT,
  hasExpansion,
  findGsdTestDispatches,
  findGsdTestDispatch,
  walkGoFlags,
  expandStatic,
  startDirFor,
  treeDirFor,
  dispatchEnv,
  WATCHED_ENV,
  INFORMATIONAL_FLAGS,
  SUBCOMMANDS,
  MAX_DASH_C_DEPTH,
  GSD_TEST_WORD,
};
