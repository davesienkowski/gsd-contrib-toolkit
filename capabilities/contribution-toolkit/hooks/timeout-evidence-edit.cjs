#!/usr/bin/env node
'use strict';

/**
 * hooks/timeout-evidence-edit.cjs - PreToolUse(Write|Edit|MultiEdit) timeout-evidence edit guard (ENF-27, quick
 * 261120-2a2, CTK-ADR-0018 Proposed).
 *
 * WHAT IT DOES. gsd-core's TESTING-STANDARDS.md says "Every new or changed timeout constant states its evidence".
 * Upstream CI (tests/timeout-evidence.test.cjs) checks the TIMEOUT_EVIDENCE data in tests/helpers/timeouts.cjs
 * against each value, never the comment, so a raise that leaves the comment's figures behind stays green. This
 * hook judges the POST-IMAGE of an edit (the file as it would be after the Write, Edit or MultiEdit) against the
 * file on disk, statically: it never loads or runs the file. It has two arms.
 *
 * ARM A (deny), target tests/helpers/timeouts.cjs. A top-level numeric constant listed in the post-image
 * `module.exports = { ... }` is JUDGED when its value rises (the post value resolves and the baseline has no
 * resolved value for it or a smaller one) or when it is newly listed in module.exports (amendment A1, so a
 * declaration, its entry and its export added in three separate Edits are judged at the export step). Declarators
 * after the first in one statement (`const A = 1, B = 2;`, also continued on following lines after a trailing
 * comma) are declarations too. A judged constant is denied when:
 *   - it has no TIMEOUT_EVIDENCE entry, but only when the entry set is fully readable: the TIMEOUT_EVIDENCE object
 *     literal was found, every member is an unquoted key at the start of a line holding an object literal, it has
 *     entries, and every other exported numeric constant has one (amendment A3). Otherwise a missing entry is
 *     undecidable and passes, because CI loads the object and may see an entry the static parse cannot;
 *   - or its entry is kind `measured` with a positive literal observedMaxMs and its Evidence comment is missing, or
 *     lacks `worst observed <observedMaxMs>ms` (entries without censoredBelowMs only; a fraction is accepted), or its
 *     first `margin <M>x` / `margin at least <M>x` has Math.round(M * 100) equal to neither
 *     Math.floor((value * 100) / observedMaxMs) nor upstream's Math.floor((value / observedMaxMs) * 100). This check
 *     runs whenever the literal is found, whatever other members it holds (review WR-01), EXCEPT for an entry that a
 *     later member may override: a later spread, computed, accessor or other non-key member, or a later member of
 *     the same name that is quoted, shorthand, not at a line start or not an object literal (R2-I2 W-03). Such a
 *     constant is not judged, because its effective entry is not the one the parser read.
 * The Evidence comment of NAME starts at the first ACCEPTED `Evidence (TIMEOUT_EVIDENCE.<NAME>):` tag. A tag is
 * accepted only where it starts a comment line: an own-line `//`, a line inside a block comment (with or without a
 * leading `*`), or the first text after `/*` or `/**`. A tag after code on the same line, or after other text on its
 * comment line, is ignored, and the deny reason says so. The comment runs from the tag to the end of its own block
 * comment or its own run of `//` lines, or to the next accepted tag inside that comment (amendment A2, review
 * WR-04); nothing after it is read.
 * Re-exports: for another tests/helpers/<f> file, the ON-DISK timeouts.cjs maps `const { A, B: alias } =
 * require('./<f>')` to exports in two forms, `const NAME = alias;` and the destructured name exported as itself. A
 * rising top-level constant A of <f> whose export has a measured entry is judged against that entry and comment in
 * the on-disk timeouts.cjs, and the reason names tests/helpers/timeouts.cjs; an export with no entry, a mirror or an
 * exempt kind sends A to arm B in its own file. Identifiers on a right-hand side resolve only through the image's
 * own top-level numeric constants, built in declaration order (`5 * PROBE_TIMEOUT_MS`); any other identifier,
 * call (`Number(30000)`) or operator outside + - * / (`2 ** 15`) is unresolved and trusted, as upstream's ESLint
 * rule trusts a non-literal. Every deny names every failing constant (at most 25 one by one), the file to fix, the
 * accepted forms, the position rule and the passing order (entry and comment first, then the value; or all in one
 * Write or MultiEdit).
 *
 * ARM A CHECKS ARITHMETIC CURRENCY ONLY. It checks that the stated figures agree with the TIMEOUT_EVIDENCE entry
 * and the value. It cannot check that an observation is real: a raise with a recomputed margin and no new
 * measurement passes.
 *
 * ARM B (context only), every other gsd-core tests/** JS-family file (.js .cjs .mjs .ts .cts .mts, any case). A
 * declaration (any indentation, optionally `export`, optionally with a one-word TypeScript annotation such as
 * `: number`) whose ASCII identifier contains `timeout` in any case, with a numeric-literal right-hand side, rises
 * when its value is greater than every baseline value of that name or the name is absent from the baseline. Its
 * comment block is the contiguous comment lines directly above the run of adjacent timeout declarations it belongs
 * to, plus the run's trailing `//` comments; a blank line ends the block. When that text names neither an exempt
 * kind (fixture data, test backstop, mirror; a bare "fixture" does not exempt) nor (observed or worst) AND (margin
 * or <n>x) AND a platform, the hook emits additionalContext and NO permissionDecision, naming each constant (at most
 * 25) in line order with its old and new value. Arm B never denies and never asks; its evidence words can be
 * satisfied by a comment with no real evidence behind it.
 *
 * OUTPUT. Never an explicit allow or ask: an allow would skip Claude Code's permission prompt; an ask degrades to
 * allow under bypass mode, denies in a -p run and has stalled interactive Orca workers. Only an object whose
 * permissionDecision is exactly `deny` with a non-empty reason, or an object with a non-empty additionalContext and
 * no permissionDecision key, produces output. It never uses failclosed.cjs emit() or runGate. Names and file paths
 * in a reason or note are printed as JSON string literals, cut to 120 characters before quoting; the names inside
 * the forms the reason asks the agent to write stay verbatim, and a name over 200 characters gets no such form.
 *
 * WORK BUDGET. Every scan counts its work (characters scanned and loop steps) against WORK_BUDGET, a fixed
 * multiple of the 1 MiB input cap (a deps.workBudget seam overrides it in tests). The count includes applying the
 * edits. When it runs out the hook stops judging and emits a context-only note, "ENF-27 did not judge this edit
 * (work budget)", with no decision and no verdict-log line. The result is a pure function of the payload and the
 * on-disk files, never of the clock. A file crafted to exhaust the budget is a known fail-open route: its edits
 * get the note instead of a judgement. Claude Code's own timeout still applies (10 s in settings.snippet.json; 600 s
 * by default for a command hook with no timeout key, the capability.json route); a cancelled PreToolUse command hook
 * does not block the call.
 *
 * FAILS OPEN. A malformed payload, a non-matching tool, a target outside <root>/tests/ or not JS-family, a path over
 * 4096 characters or 256 segments, no gsd-core root, a missing target on an Edit whose old_string is not empty, an
 * old_string that is absent or not unique without replace_all, a MultiEdit with more than 200 edits, a non-regular or
 * over-1-MiB target, content, new_string or post-image over 1 MiB (a replace_all is measured before it is built), a
 * parse the guard cannot read, and any throw (requires are lazy, inside the try) are a silent pass.
 *
 * ROOT. The gsd-core root is the OUTERMOST checkout above the target (hooks/lib/resolve.cjs sentinel layout, applied
 * repeatedly) whose tests/ directory holds the target (security review MEDIUM-2: a sentinel planted inside tests/
 * no longer moves the root). A checkout nested elsewhere in another (for example .claude/worktrees/w1) is judged
 * against itself, because the outer checkout's tests/ does not hold the target. A directory outside gsd-core that
 * carries the sentinel layout is judged as gsd-core (INFO-2, shared with every gate using the resolver).
 *
 * NOT COVERED. Only Write, Edit and MultiEdit (MultiEdit only where the client offers it) on gsd-core tests/** are
 * seen: not Bash (sed, a heredoc, cp), NotebookEdit or git apply. Also not:
 *   - a call-site swap to a larger existing constant; an identifier at a call site (`IDENT * 4`); an imported
 *     identifier, a call or a `**` expression on a right-hand side in timeouts.cjs (trusted);
 *   - a numeric literal written inside the module.exports object (`PROBE_TIMEOUT_MS: 30000,`) or a later
 *     `module.exports.PROBE_TIMEOUT_MS = ...` assignment (only declarations are judged);
 *   - a right-hand side that starts on the next line (`const X =`, then the value), and a declarator that follows a
 *     multi-line object or array in the same statement (unresolved or unseen);
 *   - a TypeScript annotation in arm B beyond one word (`: Record<string, number>`);
 *   - a lone CR, U+2028 or U+2029 used as a line break: JavaScript ends a `//` comment there and the hook does not
 *     (security review INFO-1), so a declaration after one on a comment line is hidden from the hook;
 *   - lexer limits: a regex literal is recognised after an operator, `( , = : [ ! & | ? { } ;`, the start of the file
 *     or the keywords return, case, typeof, void, delete, in, of, instanceof, new, throw, yield, await, else and do;
 *     a regex after `)` or `]`, and a template literal nested inside `${ }`, are misread. A misread slash-star opens a
 *     phantom comment in both directions: it can hide a raised declaration until the next star-slash (a silent
 *     pass), or a later comment-only edit can expose a declaration the baseline hid, which is then judged as new (a
 *     false deny, satisfied by restating that constant's figures);
 *   - a new helper constant re-exported through a NEW destructure in timeouts.cjs (a destructure is not a numeric
 *     declaration of timeouts.cjs, and the on-disk map is read before the edit);
 *   - an entry kind changed from measured to an exempt kind, in the same edit as a raise or before it; an
 *     entry-only change that leaves the comment stale (no value rises; CI checks the 2x floor); a non-exported
 *     numeric constant in timeouts.cjs;
 *   - Claude Code's fuzzy quote matching on Edit (an old_string the guard does not find is a silent pass); a
 *     dangling symlink outside the checkout whose target is in tests/ (unconfirmed what the Write tool does);
 *   - arm B's multiset rule, which misses a raise of the smaller of two same-name locals that stays below the larger
 *     one; production src/ and bin/ timeouts.
 *
 * KNOWN FALSE DENIES. A value edited before its entry or comment; correct figures in other wording; a correct
 * Evidence comment whose tag does not start its comment line (after code, or after other text); and the phantom
 * comment case above. The reason answers each: it names the passing order, the exact accepted forms and the
 * position rule.
 *
 * READ-ONLY. It realpaths the target, reads the target and (for a helper) the on-disk timeouts.cjs once each through
 * hooks/lib/regular-file.cjs (O_NONBLOCK, regular files only, 1 MiB), and parses text statically: no eval, no
 * dynamic code, no child process, no require of the target. Its one write is the best-effort verdict-log line on
 * a deny (hooks/lib/verdict-log.cjs, total). A file changed between the hook's read and the tool's apply is judged
 * on the earlier snapshot.
 *
 * @module hooks/timeout-evidence-edit
 */

const fs = require('node:fs');
const path = require('node:path');

const MAX_BYTES = 1024 * 1024;
const TIMEOUTS_REL = 'tests/helpers/timeouts.cjs';
const TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);
const JS_EXT_RE = /\.(?:[cm]?js|[cm]?ts)$/i;
const DECL_HEAD =
  '(?:const|let|var)[ \\t]+([A-Za-z_$][A-Za-z0-9_$]*)(?:[ \\t]*:[ \\t]*[A-Za-z_$][A-Za-z0-9_$]*)?[ \\t]*=(?![=>])';
const TOP_DECL_RE = new RegExp('^' + DECL_HEAD);
const ANY_DECL_RE = new RegExp('^([ \\t]*)(?:export[ \\t]+)?' + DECL_HEAD);
const MAX_DEPTH = 20;
/** The most edits one MultiEdit may carry before the guard passes it silently (each edit scans the image). */
const MAX_EDITS = 200;
/** A destructure's braces must close within this many characters (a real one is a line or two). */
const MAX_DESTRUCTURE_CHARS = 4096;
/** The most constants a deny reason or a note lists one by one. */
const MAX_LISTED = 25;
/** A name or path is cut to this many characters before it is printed as a JSON string literal. */
const MAX_LABEL = 120;
/** A name longer than this gets no write-this form in the reason (it would be the reason's whole length). */
const MAX_NAME_IN_FORM = 200;
/** Paths longer than this, or with more segments, are a silent pass before any filesystem call. */
const MAX_PATH_CHARS = 4096;
const MAX_PATH_SEGMENTS = 256;
/** A multi-declarator statement is followed across at most this many continuation lines. */
const MAX_CONTINUATION_LINES = 64;
/** The most nested gsd-core checkouts walked when choosing the root. */
const MAX_ROOT_WALK = 64;
/**
 * The work budget, in counted steps (characters scanned plus loop iterations): a fixed multiple of the 1 MiB input
 * cap, sized so that a MultiEdit at the 200-edit cap over a 1 MiB image plus the judging of both images fits.
 */
const WORK_BUDGET = 256 * MAX_BYTES;

const lf = (s) => s.replace(/\r\n/g, '\n');
const bytes = (s) => Buffer.byteLength(s, 'utf8');

// ---------------------------------------------------------------- work budget

class BudgetExceeded extends Error {}
let CURRENT = null;

/** Count n steps against the active budget (none outside gate() and judge()); throw BudgetExceeded past it. */
function spend(n) {
  if (CURRENT === null) return;
  CURRENT.left -= n;
  if (CURRENT.left < 0) throw new BudgetExceeded('ENF-27 work budget exhausted');
}

/** Run fn under a fresh budget of n steps, restoring the previous one after. */
function withBudget(n, fn) {
  const prev = CURRENT;
  CURRENT = { left: Number.isFinite(n) && n >= 0 ? n : WORK_BUDGET };
  try {
    return fn();
  } finally {
    CURRENT = prev;
  }
}

function budgetNote(rel) {
  return {
    additionalContext:
      'ENF-27 did not judge this edit (work budget): the file ' + label(rel) + ' or the edit is too large or too ' +
      'unusual to check within the guard\'s fixed work limit, so nothing was checked and nothing was blocked. If ' +
      'this edit raises or adds a gsd-core test timeout, restate its TIMEOUT_EVIDENCE entry and Evidence comment ' +
      'yourself. (ENF-27, context-only note)',
  };
}

// ---------------------------------------------------------------- printing

/** A name or path as a JSON string literal, cut to MAX_LABEL characters first (review LOW-4, LOW-5). */
function label(s) {
  const t = String(s);
  return JSON.stringify(t.length > MAX_LABEL ? t.slice(0, MAX_LABEL) + '...' : t);
}

/** A finite number in plain decimal form (never exponent form), so the `ms`/`x` patterns can read it back. */
function plain(x) {
  const s = String(x);
  const m = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(s);
  if (!m) return s;
  const digits = m[2] + (m[3] || '');
  const point = 1 + Number(m[4]);
  if (point <= 0) return m[1] + '0.' + '0'.repeat(-point) + digits;
  if (point >= digits.length) return m[1] + digits + '0'.repeat(point - digits.length);
  return m[1] + digits.slice(0, point) + '.' + digits.slice(point);
}

/** An integer count of hundredths as a decimal with two places (`213` -> `2.13`). */
function hundredths(h) {
  const neg = h < 0;
  const d = plain(Math.abs(h)).padStart(3, '0');
  return (neg ? '-' : '') + d.slice(0, -2) + '.' + d.slice(-2);
}

const shown = (v) => (v === null || v === undefined ? 'none' : plain(v));

// ---------------------------------------------------------------- lexing

const REGEX_AFTER_CHARS = new Set('(,=:[!&|?{};+-*%<>~^'.split(''));
const REGEX_AFTER_WORDS = new Set(['return', 'case', 'typeof', 'void', 'delete', 'in', 'of', 'instanceof', 'new', 'throw', 'yield', 'await', 'else', 'do']);
const isIdentChar = (c) => /[A-Za-z0-9_$]/.test(c);

/**
 * Per-character kinds of a JS-like text (0 code, 1 comment, 2 string or regex literal) and the comment tokens
 * ({start, end, block}). Linear. A regex literal is recognised after an operator or punctuator that can precede an
 * expression, the start of the text, or a keyword in REGEX_AFTER_WORDS (review LOW-3, R2-I2 W-06); elsewhere a slash
 * is division. An unterminated quote or regex ends at its line.
 *
 * @param {string} text
 */
function classify(text) {
  const n = text.length;
  spend(n);
  const k = new Uint8Array(n);
  const comments = [];
  let i = 0;
  let lastSig = '';
  let word = '';
  while (i < n) {
    const c = text[i];
    const d = text[i + 1];
    if (c === '/' && d === '/') {
      const s = i;
      while (i < n && text[i] !== '\n') k[i++] = 1;
      comments.push({ start: s, end: i, block: false });
      continue;
    }
    if (c === '/' && d === '*') {
      const s = i;
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      while (i < stop) k[i++] = 1;
      comments.push({ start: s, end: stop, block: true });
      continue;
    }
    if (c === '/' && (lastSig === '' || REGEX_AFTER_CHARS.has(lastSig) || (isIdentChar(lastSig) && REGEX_AFTER_WORDS.has(word)))) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n && text[j] !== '\n') {
        const ch = text[j];
        if (ch === '\\') {
          j += 2;
          continue;
        }
        if (inClass) {
          if (ch === ']') inClass = false;
        } else if (ch === '[') inClass = true;
        else if (ch === '/') {
          closed = true;
          break;
        }
        j++;
      }
      if (closed) {
        j++;
        while (j < n && /[A-Za-z]/.test(text[j])) j++;
        while (i < j) k[i++] = 2;
        lastSig = 'a';
        word = '';
        continue;
      }
    }
    if (c === "'" || c === '"' || c === '`') {
      k[i++] = 2;
      while (i < n) {
        const ch = text[i];
        if (ch === '\\') {
          k[i++] = 2;
          if (i < n) k[i++] = 2;
          continue;
        }
        if (ch === c) {
          k[i++] = 2;
          break;
        }
        if (ch === '\n' && c !== '`') break;
        k[i++] = 2;
      }
      lastSig = '"';
      word = '';
      continue;
    }
    k[i++] = 0;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') continue;
    if (isIdentChar(c)) word = isIdentChar(lastSig) ? word + c : c;
    else word = '';
    lastSig = c;
  }
  return { kinds: k, comments };
}

/**
 * The analysed image: kinds, comment tokens, a copy with every comment character blanked to a space (newlines
 * kept), and line start offsets.
 *
 * @param {string} text LF-normalised
 */
function analyze(text) {
  const { kinds, comments } = classify(text);
  spend(2 * text.length);
  const parts = [];
  let i = 0;
  while (i < text.length) {
    let j = i;
    const blank = kinds[i] === 1 && text[i] !== '\n';
    while (j < text.length && (kinds[j] === 1 && text[j] !== '\n') === blank) j++;
    parts.push(blank ? ' '.repeat(j - i) : text.slice(i, j));
    i = j;
  }
  const blanked = parts.join('');
  const starts = [0];
  for (let q = 0; q < text.length; q++) if (text[q] === '\n') starts.push(q + 1);
  const lineEnd = (idx) => (idx + 1 < starts.length ? starts[idx + 1] - 1 : text.length);
  return { text, kinds, comments, blanked, starts, lineEnd };
}

/** The line index holding offset `off` (binary search over line starts). */
function lineOf(A, off) {
  let lo = 0;
  let hi = A.starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (A.starts[mid] <= off) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

// ---------------------------------------------------------------- numbers

const NUM_RE =
  /(?:0[xX][0-9a-fA-F](?:_?[0-9a-fA-F])*|0[oO][0-7](?:_?[0-7])*|0[bB][01](?:_?[01])*|(?:\d(?:_?\d)*(?:\.(?:\d(?:_?\d)*)?)?|\.\d(?:_?\d)*)(?:[eE][+-]?\d(?:_?\d)*)?)(?![A-Za-z0-9_$])/y;
const ID_RE = /[A-Za-z_$][A-Za-z0-9_$]*/y;

/**
 * Resolve a right-hand side statically: numeric literals (decimal with `_`, fraction, exponent, 0x, 0o, 0b), unary
 * + and -, binary + - * /, parentheses and, when `symtab` is given, identifiers it holds. Anything else, a depth
 * past 20 or a non-finite result is null (unresolved, trusted).
 *
 * @param {string} src
 * @param {Object<string, number>|null} symtab
 * @returns {number|null}
 */
function evalNumeric(src, symtab) {
  if (typeof src !== 'string') return null;
  spend(src.length + 1);
  const s = src;
  let i = 0;
  const ws = () => {
    while (i < s.length && /\s/.test(s[i])) i++;
  };
  const fail = () => {
    throw new Error('unresolved');
  };
  function primary(depth) {
    if (depth > MAX_DEPTH) fail();
    ws();
    const c = s[i];
    if (c === '(') {
      i++;
      const v = expr(depth + 1);
      ws();
      if (s[i] !== ')') fail();
      i++;
      return v;
    }
    if (c === '+' || c === '-') {
      i++;
      const v = primary(depth + 1);
      return c === '-' ? -v : v;
    }
    // sticky regexes at i: no per-token copy of the rest of the line (linear in the line, T-261120-04)
    NUM_RE.lastIndex = i;
    const num = NUM_RE.exec(s);
    if (num) {
      i += num[0].length;
      return Number(num[0].replace(/_/g, ''));
    }
    ID_RE.lastIndex = i;
    const id = ID_RE.exec(s);
    if (id && symtab && Object.prototype.hasOwnProperty.call(symtab, id[0])) {
      i += id[0].length;
      return symtab[id[0]];
    }
    return fail();
  }
  function term(depth) {
    let v = primary(depth + 1);
    for (;;) {
      ws();
      const c = s[i];
      if ((c === '*' || c === '/') && s[i + 1] !== '*' && s[i + 1] !== '/' && s[i + 1] !== '=') {
        i++;
        const r = primary(depth + 1);
        v = c === '*' ? v * r : v / r;
      } else return v;
    }
  }
  function expr(depth) {
    if (depth > MAX_DEPTH) fail();
    let v = term(depth + 1);
    for (;;) {
      ws();
      const c = s[i];
      if ((c === '+' || c === '-') && s[i + 1] !== c && s[i + 1] !== '=') {
        i++;
        const r = term(depth + 1);
        v = c === '+' ? v + r : v - r;
      } else return v;
    }
  }
  try {
    const v = expr(0);
    ws();
    if (i !== s.length) return null;
    return Number.isFinite(v) ? v : null;
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------- declarations

const MORE_DECL_RE = /^\s*([A-Za-z_$][A-Za-z0-9_$]*)(?:[ \t]*:[ \t]*[A-Za-z_$][A-Za-z0-9_$]*)?[ \t]*=(?![=>])([\s\S]*)$/;

/**
 * Declarations of an analysed image. topLevel: a statement `const|let|var NAME = ...` at column 0; otherwise any
 * indentation (optionally `export`). The statement runs to the first code `;` at depth 0 or the end of its line, and
 * on to the next line while that line ends with a depth-0 `,` (review WR-02, R2-I2 W-08). It is split at depth-0
 * commas; each part `IDENT = rhs` after the first is a declaration too, on the line where it starts.
 *
 * @returns {{name:string, rhs:string, line:number}[]}
 */
function declarations(A, topLevel) {
  const out = [];
  const re = topLevel ? TOP_DECL_RE : ANY_DECL_RE;
  const n = A.text.length;
  for (let idx = 0; idx < A.starts.length; idx++) {
    spend(1);
    const s = A.starts[idx];
    const e = A.lineEnd(idx);
    const line = A.text.slice(s, e);
    const m = re.exec(line);
    if (!m) continue;
    const kwOff = s + (topLevel ? 0 : m[1].length);
    if (A.kinds[kwOff] !== 0) continue;
    const name = topLevel ? m[1] : m[2];
    const rhsStart = s + m[0].length;
    const parts = [];
    let partStart = rhsStart;
    let partLine = idx;
    let curLine = idx;
    let depth = 0;
    let lastSig = '';
    let continued = 0;
    let j = rhsStart;
    for (; j < n; j++) {
      const ch = A.text[j];
      if (ch === '\n') {
        if (depth !== 0 || lastSig !== ',' || ++continued > MAX_CONTINUATION_LINES) break;
        curLine++;
        continue;
      }
      if (A.kinds[j] !== 0) continue;
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') depth--;
      else if (ch === ';' && depth === 0) break;
      else if (ch === ',' && depth === 0) {
        parts.push({ a: partStart, b: j, line: partLine });
        partStart = j + 1;
        partLine = curLine;
      }
      if (ch !== ' ' && ch !== '\t') lastSig = ch;
    }
    spend(j - rhsStart + 1);
    parts.push({ a: partStart, b: j, line: partLine });
    out.push({ name, rhs: A.blanked.slice(parts[0].a, parts[0].b).trim(), line: idx });
    for (let p = 1; p < parts.length; p++) {
      const raw = A.blanked.slice(parts[p].a, parts[p].b);
      const lead = /^\s*/.exec(raw)[0];
      const more = MORE_DECL_RE.exec(raw);
      if (!more) continue;
      out.push({ name: more[1], rhs: more[2].trim(), line: parts[p].line + (lead.match(/\n/g) || []).length });
    }
  }
  return out;
}

/** Top-level declarations with a same-image symbol table built in declaration order (first declaration wins). */
function topDecls(A) {
  const symtab = Object.create(null);
  const decls = new Map();
  for (const d of declarations(A, true)) {
    if (decls.has(d.name)) continue;
    const value = evalNumeric(d.rhs, symtab);
    decls.set(d.name, { value, rhs: d.rhs, line: d.line });
    if (value !== null) symtab[d.name] = value;
  }
  return decls;
}

// ---------------------------------------------------------------- object literals

/** Index of the `}` closing the code `{` at `open`, or -1 (also past `limit` characters). */
function closeOf(A, open, limit = Infinity) {
  let depth = 0;
  const stop = Math.min(A.text.length, open + limit);
  let j = open;
  try {
    for (; j < stop; j++) {
      if (A.kinds[j] !== 0) continue;
      const ch = A.text[j];
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) return j;
      }
    }
    return -1;
  } finally {
    spend(j - open + 1);
  }
}

/**
 * Members of the object literal between `open` and `close`: { form, key, start, valueStart, end, lineStart }.
 * form is 'key' (IDENT: value), 'shorthand', 'spread', 'quoted' (key holds the unquoted name when it is a plain
 * one), 'computed' or 'other' (a method, getter or anything else).
 */
function membersOf(A, open, close) {
  spend(close - open + 1);
  const segs = [];
  let depth = 0;
  let segStart = open + 1;
  for (let j = open + 1; j < close; j++) {
    if (A.kinds[j] !== 0) continue;
    const ch = A.text[j];
    if (ch === '{' || ch === '[' || ch === '(') depth++;
    else if (ch === '}' || ch === ']' || ch === ')') depth--;
    else if (ch === ',' && depth === 0) {
      segs.push([segStart, j]);
      segStart = j + 1;
    }
  }
  segs.push([segStart, close]);
  const out = [];
  for (const [a, b] of segs) {
    const raw = A.blanked.slice(a, b);
    const lead = /^\s*/.exec(raw)[0];
    const t = raw.trim();
    if (!t) continue;
    const start = a + lead.length;
    let q = start - 1;
    while (q >= 0 && (A.blanked[q] === ' ' || A.blanked[q] === '\t')) q--;
    const lineStart = q < 0 || A.blanked[q] === '\n';
    let form = 'other';
    let key = null;
    let valueStart = -1;
    let m;
    if (t.startsWith('...')) form = 'spread';
    else if ((m = /^(['"])([A-Za-z_$][A-Za-z0-9_$]*)\1\s*:/.exec(t))) {
      form = 'quoted';
      key = m[2];
    } else if (/^['"`]/.test(t)) form = 'other';
    else if (t[0] === '[') form = 'computed';
    else if ((m = /^([A-Za-z_$][A-Za-z0-9_$]*)\s*:/.exec(t))) {
      form = 'key';
      key = m[1];
      valueStart = start + m[0].length;
    } else if ((m = /^([A-Za-z_$][A-Za-z0-9_$]*)$/.exec(t))) {
      form = 'shorthand';
      key = m[1];
    }
    out.push({ form, key, start, valueStart, end: b, lineStart });
  }
  return out;
}

/** Names listed in the first top-level `module.exports = { ... }` object, or null when there is none. */
function exportsOf(A) {
  const re = /^module\.exports[ \t]*=[ \t]*\{/gm;
  spend(A.text.length);
  let m;
  while ((m = re.exec(A.blanked))) {
    if (A.kinds[m.index] !== 0) continue;
    const open = m.index + m[0].length - 1;
    const close = closeOf(A, open);
    if (close === -1) return null;
    const names = new Set();
    for (const mem of membersOf(A, open, close)) if (mem.key) names.add(mem.key);
    return names;
  }
  return null;
}

/**
 * The TIMEOUT_EVIDENCE object literal: { found, readable, entries }.
 *   - entries: name -> { kind, observedMaxMs, censored, overridden } for every CLEAN member (an unquoted key at the
 *     start of a line holding an object literal; the last clean one of a name wins). overridden is true when a later
 *     member may replace it: a spread, computed, quoted-other or other member, or a later non-clean member of the
 *     same name (R2-I2 W-03).
 *   - readable: found, every member clean, and at least one entry (amendment A3).
 */
function evidenceOf(A) {
  const re = /^(?:const|let|var)[ \t]+TIMEOUT_EVIDENCE[ \t]*=[ \t]*(?:Object\.freeze\(\s*)?\{/gm;
  spend(A.text.length);
  const entries = new Map();
  let m;
  while ((m = re.exec(A.blanked))) {
    if (A.kinds[m.index] !== 0) continue;
    const open = m.index + m[0].length - 1;
    const close = closeOf(A, open);
    if (close === -1) return { found: true, readable: false, entries };
    const members = membersOf(A, open, close);
    let unclean = false;
    let lastAny = -1;
    const lastNamed = new Map();
    const cleanAt = new Map();
    members.forEach((mem, idx) => {
      let clean = mem.form === 'key' && mem.lineStart;
      let vOpen = -1;
      let vClose = -1;
      if (clean) {
        const vLead = /^\s*/.exec(A.blanked.slice(mem.valueStart, mem.end))[0];
        vOpen = mem.valueStart + vLead.length;
        vClose = A.blanked[vOpen] === '{' ? closeOf(A, vOpen, mem.end - vOpen) : -1;
        if (vClose === -1 || vClose >= mem.end) clean = false;
      }
      if (!clean) {
        unclean = true;
        if (mem.key && (mem.form === 'key' || mem.form === 'quoted' || mem.form === 'shorthand')) lastNamed.set(mem.key, idx);
        else lastAny = idx;
        return;
      }
      const fields = Object.create(null);
      for (const f of membersOf(A, vOpen, vClose)) {
        if (f.form === 'key') fields[f.key] = A.blanked.slice(f.valueStart, f.end).trim();
      }
      const kindRaw = fields.kind;
      const km = typeof kindRaw === 'string' ? /^(['"])([^'"]*)\1$/.exec(kindRaw) : null;
      cleanAt.set(mem.key, idx);
      entries.set(mem.key, {
        kind: km ? km[2] : null,
        observedMaxMs: typeof fields.observedMaxMs === 'string' ? evalNumeric(fields.observedMaxMs, null) : null,
        censored: Object.prototype.hasOwnProperty.call(fields, 'censoredBelowMs'),
        overridden: false,
      });
    });
    for (const [key, idx] of cleanAt) {
      const named = lastNamed.has(key) ? lastNamed.get(key) : -1;
      if (lastAny > idx || named > idx) entries.get(key).overridden = true;
    }
    return { found: true, readable: !unclean && entries.size > 0, entries };
  }
  return { found: false, readable: false, entries };
}

/**
 * Evidence tags: the first ACCEPTED tag of each name with the comment text it heads, and the first ignored tag of
 * each name that has no accepted one. A tag is accepted when it lies in a comment and its line holds, before it,
 * only whitespace and one comment leader (`//`, `/*`, `/**` or `*`). Its text runs to the end of its comment unit
 * (a block comment, or a run of own-line `//` comments on consecutive lines) or to the next accepted tag in that
 * unit. Linear: every unit is scanned once.
 */
function evidenceTags(A) {
  const units = [];
  for (const c of A.comments) {
    const ownLine = /^[ \t]*$/.test(A.text.slice(A.starts[lineOf(A, c.start)], c.start));
    const prev = units[units.length - 1];
    if (!c.block && ownLine && prev && !prev.block && prev.ownLine && /^\n[ \t]*$/.test(A.text.slice(prev.end, c.start))) {
      prev.end = c.end;
      continue;
    }
    units.push({ start: c.start, end: c.block && A.text.slice(c.end - 2, c.end) === '*/' ? c.end - 2 : c.end, block: c.block, ownLine });
  }
  spend(units.length + A.text.length);
  const accepted = [];
  const ignored = new Map();
  let u = 0;
  const tagRe = /Evidence \(TIMEOUT_EVIDENCE\.([A-Za-z_$][A-Za-z0-9_$]*)\):/g;
  let m;
  while ((m = tagRe.exec(A.text))) {
    const at = m.index;
    while (u < units.length && units[u].end <= at) u++;
    const unit = units[u];
    const inUnit = unit && unit.start <= at && A.kinds[at] === 1;
    const prefix = A.text.slice(A.starts[lineOf(A, at)], at);
    if (inUnit && /^[ \t]*(?:\/\/+|\/\*+|\*+)?[ \t]*$/.test(prefix)) {
      accepted.push({ name: m[1], from: at + m[0].length, unit: u });
    } else if (!ignored.has(m[1])) {
      const codeBefore = /[^ \t]/.test(A.blanked.slice(A.starts[lineOf(A, at)], at).replace(/\/\/+|\/\*+|\*+/g, ''));
      ignored.set(m[1], { line: lineOf(A, at) + 1, afterCode: codeBefore || !inUnit });
    }
  }
  const tagAt = new Map();
  for (let i = 0; i < accepted.length; i++) {
    const t = accepted[i];
    if (tagAt.has(t.name)) continue;
    const next = accepted[i + 1];
    const end = next && next.unit === t.unit ? next.from - ('Evidence (TIMEOUT_EVIDENCE.' + next.name + '):').length : units[t.unit].end;
    tagAt.set(t.name, { from: t.from, to: Math.max(t.from, end) });
  }
  for (const name of tagAt.keys()) ignored.delete(name);
  return { tagAt, ignored };
}

/**
 * Parse a timeouts.cjs-shaped module statically.
 *
 * @param {string} text
 */
function parseTimeoutsModule(text) {
  const A = analyze(lf(String(text)));
  const exportsSet = exportsOf(A);
  const decls = topDecls(A);
  const ev = evidenceOf(A);
  const { tagAt, ignored } = evidenceTags(A);
  const tags = new Set(tagAt.keys());
  // `const { A, B: alias } = require('./<f>')` at the start of a code line; the braces close within a bounded span.
  // Exported names are looked up per right-hand side in one index (security review MEDIUM-1).
  const byRhs = new Map();
  if (exportsSet) {
    for (const [name, d] of decls) {
      if (!exportsSet.has(name)) continue;
      if (!byRhs.has(d.rhs)) byRhs.set(d.rhs, []);
      byRhs.get(d.rhs).push(name);
    }
  }
  const reexports = new Map();
  for (let idx = 0; idx < A.starts.length; idx++) {
    spend(1);
    const ls = A.starts[idx];
    if (A.kinds[ls] !== 0) continue;
    const head = /^(?:const|let|var)[ \t]*\{/.exec(A.blanked.slice(ls, ls + 16));
    if (!head) continue;
    const open = ls + head[0].length - 1;
    const close = closeOf(A, open, MAX_DESTRUCTURE_CHARS);
    if (close === -1) continue;
    const tail = /^[ \t]*=[ \t]*require\([ \t]*(['"])([^'"\n]+)\1[ \t]*\)/.exec(A.blanked.slice(close + 1, close + 1 + 512));
    if (!tail) continue;
    const source = tail[2];
    const perSource = reexports.get(source) || new Map();
    for (const part of A.blanked.slice(open + 1, close).split(',')) {
      spend(part.length + 1);
      const pm = /^\s*([A-Za-z_$][A-Za-z0-9_$]*)(?:\s*:\s*([A-Za-z_$][A-Za-z0-9_$]*))?\s*$/.exec(part);
      if (!pm) continue;
      const local = pm[2] || pm[1];
      const names = (byRhs.get(local) || []).slice();
      if (exportsSet && exportsSet.has(local)) names.push(local);
      perSource.set(pm[1], names);
    }
    reexports.set(source, perSource);
  }
  const comment = (name) => {
    const t = tagAt.get(name);
    if (!t) return null;
    spend(t.to - t.from + 1);
    return A.text.slice(t.from, t.to).replace(/\n[ \t]*(?:\*(?!\/)|\/\/)?/g, ' ').replace(/\s+/g, ' ');
  };
  return {
    text: A.text,
    exports: exportsSet,
    decls,
    entries: ev.entries,
    evidenceFound: ev.found,
    readable: ev.readable,
    tags,
    ignoredTags: ignored,
    comment,
    reexports,
  };
}

// ---------------------------------------------------------------- arm A

/** A name verbatim for a write-this form, or null when it is too long to restate. */
const formName = (name) => (name.length <= MAX_NAME_IN_FORM ? name : null);

/**
 * Problems with NAME's comment for `value` against its measured entry, or null when it is current.
 */
function measuredProblems(P, name, value, entry) {
  const obs = entry.observedMaxMs;
  const hInt = Math.floor((value * 100) / obs);
  const hFlt = Math.floor((value / obs) * 100);
  const need =
    (entry.censored ? '' : '`worst observed ' + plain(obs) + 'ms` and ') +
    '`margin ' + hundredths(hInt) + 'x` or `margin at least ' + hundredths(hInt) + 'x`' +
    (hFlt !== hInt ? ' (' + hundredths(hFlt) + ' is also accepted)' : '');
  const c = P.comment(name);
  if (c === null) {
    const fn = formName(name);
    const tag = fn ? '`Evidence (TIMEOUT_EVIDENCE.' + fn + '):`' : 'Evidence';
    const ig = P.ignoredTags.get(name);
    if (ig) {
      return (
        'its ' + tag + ' tag on line ' + ig.line + (ig.afterCode ? ' follows code' : ' follows other text') +
        ' on the same line and was ignored (a tag counts only where it starts a comment line); put the Evidence ' +
        'comment on its own line(s) above the declaration; it needs ' + need
      );
    }
    return 'no ' + tag + ' comment; it needs ' + need;
  }
  const problems = [];
  if (!entry.censored) {
    const wo = /worst observed (\d+(?:\.\d+)?)ms/.exec(c);
    if (!wo) problems.push('no `worst observed <N>ms`');
    else if (Number(wo[1]) !== obs) problems.push('it states `worst observed ' + wo[1] + 'ms`');
  }
  const mg = /margin (?:at least )?(\d+(?:\.\d+)?)x/.exec(c);
  if (!mg) problems.push('no `margin <M>x` (margin missing)');
  else {
    const st = Math.round(Number(mg[1]) * 100);
    if (st !== hInt && st !== hFlt) problems.push('its first margin is `' + mg[0] + '`');
  }
  if (!problems.length) return null;
  return problems.join('; ') + '; it needs ' + need;
}

function denyReason(failures) {
  return (
    'ENF-27: this edit raises, newly sets or newly exports ' + failures.length + ' timeout constant(s) whose ' +
    'evidence in `tests/helpers/timeouts.cjs` is missing or not current:\n' +
    failures.slice(0, MAX_LISTED).map((f) => '- ' + f).join('\n') + '\n' +
    (failures.length > MAX_LISTED ? '- ... and ' + (failures.length - MAX_LISTED) + ' more constant(s)\n' : '') +
    'Fix `tests/helpers/timeouts.cjs`. Accepted forms, read only inside the comment that starts ' +
    '`Evidence (TIMEOUT_EVIDENCE.<NAME>):` (up to the end of that block comment or `//` run): ' +
    '`worst observed <N>ms` with N equal to the entry\'s observedMaxMs (not needed when the entry has ' +
    'censoredBelowMs), and, as the first margin after the tag, `margin <M>x` or `margin at least <M>x`, where M is ' +
    'value / observedMaxMs rounded down to hundredths. The tag counts only where it starts a comment line (an ' +
    'own-line `//`, a line of a block comment, or the first text after `/*` or `/**`); a tag after code on the same ' +
    'line is ignored. A TIMEOUT_EVIDENCE key is written unquoted, as an identifier at the start of its line ' +
    '(`NAME: { ... }`), never as a quoted string. Passing order: add or edit the TIMEOUT_EVIDENCE entry and the ' +
    'Evidence comment first, then change or export the value; or do all of it in one Write or MultiEdit. This guard ' +
    'checks only that the stated figures are arithmetically current with the entry; it cannot check that an ' +
    'observation is real. (ENF-27, fail-open edit guard)'
  );
}

/** Arm A over tests/helpers/timeouts.cjs: a list of failure lines (empty when nothing fails). */
function armA(baseline, post) {
  const P = parseTimeoutsModule(post);
  // No exports object, or no TIMEOUT_EVIDENCE literal: nothing to judge against.
  if (!P.exports || !P.evidenceFound) return [];
  const B = parseTimeoutsModule(baseline);
  const baseExports = B.exports || new Set();
  const judged = [];
  for (const [name, d] of P.decls) {
    spend(1);
    if (d.value === null || !P.exports.has(name)) continue;
    const b = B.decls.get(name);
    const old = b ? b.value : null;
    const rises = old === null || old < d.value;
    const newlyExported = !baseExports.has(name); // amendment A1: a newly exported constant is judged as new
    if (rises || newlyExported) judged.push({ name, old, value: d.value, newlyExported: !rises });
  }
  if (!judged.length) return [];
  // Amendment A3: "no entry" denies only when every OTHER exported numeric constant has an entry the parser read.
  const judgedNames = new Set(judged.map((j) => j.name));
  let othersCovered = true;
  for (const [name, d] of P.decls) {
    if (d.value !== null && P.exports.has(name) && !judgedNames.has(name) && !P.entries.has(name)) othersCovered = false;
  }
  const failures = [];
  for (const j of judged) {
    const head = label(j.name) + ' ' + shown(j.old) + ' -> ' + plain(j.value) + (j.newlyExported ? ' (newly exported)' : '');
    const e = P.entries.get(j.name);
    if (!e) {
      // Amendment A3: a missing entry is undecidable unless the whole entry set was read and covers the others.
      if (!P.readable || !othersCovered) continue;
      const fn = formName(j.name);
      failures.push(
        head + ': no TIMEOUT_EVIDENCE entry. ' +
          (fn
            ? 'Add `' + fn + ": { kind: 'measured', observedMaxMs: <N>, ... }` (key unquoted; or an exempt kind with " +
              'its reason) to TIMEOUT_EVIDENCE and an `Evidence (TIMEOUT_EVIDENCE.' + fn + '):` comment above the ' +
              'declaration first'
            : 'Its name is over ' + MAX_NAME_IN_FORM + ' characters; add its TIMEOUT_EVIDENCE entry (key unquoted) and ' +
              'its Evidence comment first')
      );
      continue;
    }
    if (e.overridden) continue; // R2-I2 W-03: a later member may replace this entry
    if (e.kind !== 'measured') continue;
    if (!(typeof e.observedMaxMs === 'number' && e.observedMaxMs > 0)) continue;
    const p = measuredProblems(P, j.name, j.value, e);
    if (p) failures.push(head + ' (TIMEOUT_EVIDENCE observedMaxMs ' + plain(e.observedMaxMs) + (e.censored ? ', censored' : '') + '): ' + p);
  }
  return failures;
}

/**
 * Arm A for a re-exported helper constant: { failures, handledLines } where handledLines are the top-level lines
 * of the helper judged against a measured export (arm B skips them).
 */
function armAReexport(rel, baseline, post, timeoutsText) {
  const out = { failures: [], handledLines: new Set() };
  if (typeof timeoutsText !== 'string') return out;
  const T = parseTimeoutsModule(timeoutsText);
  if (!T.evidenceFound) return out;
  const base = rel.slice('tests/helpers/'.length);
  const map = T.reexports.get('./' + base) || T.reexports.get('./' + base.replace(/\.[^.]+$/, ''));
  if (!map) return out;
  const P = topDecls(analyze(post));
  const B = topDecls(analyze(baseline));
  for (const [src, exportNames] of map) {
    spend(1);
    const d = P.get(src);
    if (!d || d.value === null) continue;
    const b = B.get(src);
    const old = b ? b.value : null;
    if (!(old === null || old < d.value)) continue;
    for (const E of exportNames) {
      const e = T.entries.get(E);
      if (!e || e.kind !== 'measured' || e.overridden) continue;
      out.handledLines.add(d.line);
      if (!(typeof e.observedMaxMs === 'number' && e.observedMaxMs > 0)) continue;
      const p = measuredProblems(T, E, d.value, e);
      if (p) {
        out.failures.push(
          label(src) + ' in ' + label(rel) + ' (re-exported by tests/helpers/timeouts.cjs as ' + label(E) + ') ' +
            shown(old) + ' -> ' + plain(d.value) + ' (TIMEOUT_EVIDENCE observedMaxMs ' + plain(e.observedMaxMs) +
            (e.censored ? ', censored' : '') + '): ' + p
        );
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- arm B

const EXEMPT_RE = /fixture[- ]data|test[- ]backstop|\bmirror\b/i;

function statesEvidence(t) {
  if (EXEMPT_RE.test(t)) return true;
  return /observ|worst/i.test(t) && /margin|\b\d+(?:\.\d+)?x\b/i.test(t) && /win32|darwin|linux|windows|macos/i.test(t);
}

/** Is line idx a pure comment line (non-empty, every non-whitespace character a comment)? */
function commentLine(A, idx) {
  const s = A.starts[idx];
  const e = A.lineEnd(idx);
  spend(e - s + 1);
  let any = false;
  for (let j = s; j < e; j++) {
    const ch = A.text[j];
    if (ch === ' ' || ch === '\t') continue;
    if (A.kinds[j] !== 1) return false;
    any = true;
  }
  return any;
}

/** The comment text of a line's comment characters (a trailing `//` or block). */
function trailingComment(A, idx) {
  spend(A.lineEnd(idx) - A.starts[idx] + 1);
  let out = '';
  for (let j = A.starts[idx]; j < A.lineEnd(idx); j++) if (A.kinds[j] === 1) out += A.text[j];
  return out;
}

/** Arm B: rising unevidenced file-local timeout constants, in post-image line order. */
function armB(baseline, post, skipLines) {
  const isTimeout = (n) => /timeout/i.test(n);
  // The highest resolved baseline value per name, computed once (security review LOW-7).
  const baseMax = new Map();
  for (const d of declarations(analyze(baseline), false)) {
    if (!isTimeout(d.name)) continue;
    const v = evalNumeric(d.rhs, null);
    if (!baseMax.has(d.name)) baseMax.set(d.name, null);
    if (v !== null && (baseMax.get(d.name) === null || v > baseMax.get(d.name))) baseMax.set(d.name, v);
  }
  const A = analyze(post);
  const decls = declarations(A, false).filter((d) => isTimeout(d.name));
  // Runs of adjacent timeout declarations, found in one pass; each run's comment text is built once.
  const runOf = new Map();
  for (const d of decls) {
    spend(1);
    const prev = runOf.get(d.line - 1);
    if (runOf.has(d.line)) continue;
    if (prev) {
      prev.end = d.line;
      runOf.set(d.line, prev);
    } else runOf.set(d.line, { start: d.line, end: d.line, text: null });
  }
  const runText = (r) => {
    if (r.text !== null) return r.text;
    const above = [];
    for (let i = r.start - 1; i >= 0 && commentLine(A, i); i--) above.push(A.text.slice(A.starts[i], A.lineEnd(i)));
    const trailing = [];
    for (let i = r.start; i <= r.end; i++) trailing.push(trailingComment(A, i));
    r.text = above.reverse().join('\n') + '\n' + trailing.join('\n');
    return r.text;
  };
  const flagged = [];
  for (const d of decls) {
    spend(1);
    if (skipLines && skipLines.has(d.line)) continue;
    const value = evalNumeric(d.rhs, null);
    if (value === null) continue;
    const max = baseMax.has(d.name) ? baseMax.get(d.name) : null;
    if (!(max === null || value > max)) continue;
    if (statesEvidence(runText(runOf.get(d.line)))) continue;
    flagged.push({ name: d.name, old: max, value, line: d.line + 1 });
  }
  return flagged;
}

function advisoryText(rel, flagged) {
  const listed = flagged.slice(0, MAX_LISTED).map((f) => '- ' + label(f.name) + ' ' + shown(f.old) + ' -> ' + plain(f.value) + ' (line ' + f.line + ')');
  if (flagged.length > MAX_LISTED) listed.push('- ... and ' + (flagged.length - MAX_LISTED) + ' more constant(s)');
  return (
    'ENF-27 timeout-evidence note (context only; nothing was blocked): this edit raises or adds ' + flagged.length +
    ' file-local timeout constant(s) in ' + label(rel) + ' whose comment states no evidence:\n' +
    listed.join('\n') + '\n' +
    'gsd-core TESTING-STANDARDS.md "Every new or changed timeout constant states its evidence": the comment directly ' +
    'above the declaration should state (1) the observed range (the worst observed duration, p50/p99 where known, ' +
    'and the sample count), (2) the worst platform (win32, darwin or linux), (3) the margin (the constant over the ' +
    'worst observation, at least 2x) and (4) the source and window; or name an exempt kind (fixture data, test ' +
    'backstop, mirror). Code review checks this upstream. (ENF-27, context-only note)'
  );
}

// ---------------------------------------------------------------- the decision

function judgeCore({ rel, baseline, post, timeoutsText }) {
  const b = lf(String(baseline));
  const p = lf(String(post));
  if (rel === TIMEOUTS_REL) {
    const failures = armA(b, p);
    return failures.length ? { permissionDecision: 'deny', permissionDecisionReason: denyReason(failures) } : null;
  }
  let skip = new Set();
  if (/^tests\/helpers\/[^/]+$/.test(rel)) {
    const r = armAReexport(rel, b, p, typeof timeoutsText === 'string' ? lf(timeoutsText) : timeoutsText);
    if (r.failures.length) return { permissionDecision: 'deny', permissionDecisionReason: denyReason(r.failures) };
    skip = r.handledLines;
  }
  const flagged = armB(b, p, skip);
  return flagged.length ? { additionalContext: advisoryText(rel, flagged) } : null;
}

/**
 * The pure decision over a relative target path, its baseline, its post-image and (for a helper) the on-disk
 * timeouts.cjs text. Returns a deny object, an advisory object ({additionalContext}) or null. Called outside gate()
 * it runs under its own budget (args.workBudget, default WORK_BUDGET) and returns the budget note when it runs out.
 *
 * @param {{rel:string, baseline:string, post:string, timeoutsText?:string|null, workBudget?:number}} args
 */
function judge(args) {
  if (CURRENT !== null) return judgeCore(args);
  return withBudget(args.workBudget, () => {
    try {
      return judgeCore(args);
    } catch (err) {
      if (err instanceof BudgetExceeded) return budgetNote(args.rel);
      throw err;
    }
  });
}

/**
 * Apply Edit/MultiEdit edits to an image as Claude Code does, or null when the tool would fail: CRLF normalised,
 * an empty old_string creates only on an empty or whitespace-only image, an absent old_string or a non-unique one
 * without replace_all fails, an empty new_string also removes a following newline, split/join (never a string
 * replace, where `$&` would expand), each edit on the running image. A replace_all is counted first and refused
 * when its result would pass the 1 MiB cap, before the string is built (security review LOW-6).
 *
 * @param {string} image
 * @param {Array<{old_string:string,new_string:string,replace_all?:boolean}>} edits
 * @returns {string|null}
 */
function applyEdits(image, edits) {
  if (typeof image !== 'string' || !Array.isArray(edits) || edits.length === 0 || edits.length > MAX_EDITS) return null;
  let img = lf(image);
  for (const e of edits) {
    if (!e || typeof e !== 'object') return null;
    if (typeof e.old_string !== 'string' || typeof e.new_string !== 'string') return null;
    let oldS = lf(e.old_string);
    const newS = lf(e.new_string);
    spend(img.length + newS.length + 1);
    if (bytes(newS) > MAX_BYTES) return null;
    if (oldS === '') {
      if (img.trim() !== '') return null;
      img = newS;
      continue;
    }
    if (oldS === newS) return null;
    const first = img.indexOf(oldS);
    if (first === -1) return null;
    if (e.replace_all !== true && img.indexOf(oldS, first + oldS.length) !== -1) return null;
    if (newS === '' && !oldS.endsWith('\n') && img.includes(oldS + '\n')) oldS += '\n';
    if (e.replace_all === true) {
      let count = 0;
      for (let at = img.indexOf(oldS); at !== -1; at = img.indexOf(oldS, at + oldS.length)) count++;
      spend(count);
      if (img.length + count * (newS.length - oldS.length) > MAX_BYTES) return null;
      img = img.split(oldS).join(newS);
    } else {
      const at = img.indexOf(oldS);
      img = img.slice(0, at) + newS + img.slice(at + oldS.length);
    }
    if (bytes(img) > MAX_BYTES) return null;
  }
  return img;
}

/** realpath of p; for a missing path, the realpath of its nearest existing ancestor joined with the rest. */
function realpathNearest(p) {
  if (typeof p !== 'string' || p.length > MAX_PATH_CHARS || p.split(/[\\/]/).length > MAX_PATH_SEGMENTS) return null;
  try {
    return fs.realpathSync.native(p);
  } catch (_) {
    const rest = [];
    let cur = p;
    for (;;) {
      const parent = path.dirname(cur);
      if (parent === cur) return null;
      rest.unshift(path.basename(cur));
      cur = parent;
      try {
        return path.join(fs.realpathSync.native(cur), ...rest);
      } catch (__) {
        /* keep walking up */
      }
    }
  }
}

/**
 * The relative path of `real` under the OUTERMOST gsd-core checkout above it whose tests/ holds it, or null
 * (security review MEDIUM-2). resolveRoot throws when no further ancestor carries the sentinel; that ends the walk.
 */
function relUnderOutermostRoot(real, resolveRoot) {
  const roots = [];
  let start = path.dirname(real);
  for (let k = 0; k < MAX_ROOT_WALK; k++) {
    let r;
    try {
      r = resolveRoot(start);
    } catch (_) {
      break;
    }
    roots.push(r);
    const parent = path.dirname(r);
    if (parent === r) break;
    start = parent;
  }
  for (let i = roots.length - 1; i >= 0; i--) {
    let rootReal;
    try {
      rootReal = fs.realpathSync.native(roots[i]);
    } catch (_) {
      continue;
    }
    const relNative = path.relative(rootReal, real);
    if (!relNative || path.isAbsolute(relNative)) continue;
    const segs = relNative.split(path.sep);
    if (segs.length < 2 || segs[0] !== 'tests' || segs.includes('..')) continue;
    return { rootReal, segs, rel: segs.join('/') };
  }
  return null;
}

/**
 * The decision over a PreToolUse payload: a deny object, an advisory object or null. May throw; runEditGuard
 * turns any throw into a silent pass.
 *
 * @param {string} stdinString
 * @param {{resolveRoot?: (startDir:string) => string, workBudget?: number}} [deps]
 */
function gate(stdinString, deps = {}) {
  const input = JSON.parse(stdinString);
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return null;
  const tool = input.tool_name;
  if (!TOOLS.has(tool)) return null;
  const ti = input.tool_input;
  if (!ti || typeof ti !== 'object') return null;
  const filePath = ti.file_path;
  if (typeof filePath !== 'string' || filePath.length === 0 || filePath.length > MAX_PATH_CHARS) return null;

  const cwd = typeof input.cwd === 'string' && input.cwd.length > 0 ? input.cwd : process.cwd();
  const abs = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(cwd, filePath);
  const real = realpathNearest(abs);
  if (!real || !JS_EXT_RE.test(real)) return null;

  const resolveRoot = deps.resolveRoot || require('./lib/resolve.cjs').resolveGsdCoreRoot;
  const where = relUnderOutermostRoot(real, resolveRoot);
  if (!where) return null;
  const { rootReal, segs, rel } = where;

  const { readRegularFileBounded } = require('./lib/regular-file.cjs');
  let baseline;
  try {
    baseline = readRegularFileBounded(real);
  } catch (err) {
    if (err && err.code === 'ENOENT') baseline = '';
    else return null;
  }
  baseline = lf(baseline);
  let timeoutsText = null;
  if (rel !== TIMEOUTS_REL && segs.length === 3 && segs[1] === 'helpers') {
    try {
      timeoutsText = readRegularFileBounded(path.join(rootReal, 'tests', 'helpers', 'timeouts.cjs'));
    } catch (_) {
      timeoutsText = null;
    }
  }

  return withBudget(deps.workBudget, () => {
    try {
      let post;
      if (tool === 'Write') {
        if (typeof ti.content !== 'string' || bytes(ti.content) > MAX_BYTES) return null;
        post = lf(ti.content);
      } else if (tool === 'Edit') {
        post = applyEdits(baseline, [{ old_string: ti.old_string, new_string: ti.new_string, replace_all: ti.replace_all }]);
      } else {
        post = applyEdits(baseline, ti.edits);
      }
      if (typeof post !== 'string' || bytes(post) > MAX_BYTES) return null;
      return judgeCore({ rel, baseline, post, timeoutsText });
    } catch (err) {
      if (err instanceof BudgetExceeded) return budgetNote(rel);
      throw err;
    }
  });
}

/**
 * The entry seam: a deny object only for a result whose permissionDecision is exactly 'deny' with a non-empty
 * reason; an advisory object only for a non-empty additionalContext with no permissionDecision key; null (a silent
 * pass) for every other result and for any throw. Only a deny is written to the verdict log.
 *
 * @param {string} stdinString
 * @param {Object} [deps] gate deps, plus deps.gateImpl (test seam replacing gate)
 */
function runEditGuard(stdinString, deps = {}) {
  const startedAt = Date.now();
  let result;
  try {
    result = (deps.gateImpl || gate)(stdinString, deps);
  } catch (_) {
    return null;
  }
  if (!result || typeof result !== 'object') return null;
  if (result.permissionDecision === 'deny') {
    if (typeof result.permissionDecisionReason !== 'string' || result.permissionDecisionReason.length === 0) return null;
    const decision = { permissionDecision: 'deny', permissionDecisionReason: result.permissionDecisionReason };
    try {
      require('./lib/verdict-log.cjs').recordVerdict(
        { action: 'timeout-evidence-edit', stdin: stdinString },
        decision,
        Date.now() - startedAt
      );
    } catch (_) {
      /* best effort: a verdict that cannot be logged is dropped */
    }
    return decision;
  }
  if (Object.prototype.hasOwnProperty.call(result, 'permissionDecision')) return null;
  if (typeof result.additionalContext === 'string' && result.additionalContext.length > 0) {
    return { additionalContext: result.additionalContext };
  }
  return null;
}

function main() {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => {
    buf += c;
  });
  process.stdin.on('error', () => {
    process.exitCode = 0;
  });
  process.stdin.on('end', () => {
    let out = null;
    try {
      out = runEditGuard(buf);
    } catch (_) {
      out = null;
    }
    if (out && out.permissionDecision === 'deny') {
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: out.permissionDecisionReason,
          },
        }) + '\n'
      );
    } else if (out && typeof out.additionalContext === 'string') {
      process.stdout.write(
        JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: out.additionalContext } }) + '\n'
      );
    }
    process.exitCode = 0;
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  gate,
  judge,
  runEditGuard,
  parseTimeoutsModule,
  evalNumeric,
  applyEdits,
  realpathNearest,
  main,
  MAX_EDITS,
  WORK_BUDGET,
};
