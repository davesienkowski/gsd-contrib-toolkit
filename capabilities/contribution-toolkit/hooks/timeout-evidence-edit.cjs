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
 * declaration, its entry and its export added in three separate Edits are judged at the export step). A judged
 * constant is denied when:
 *   - it has no TIMEOUT_EVIDENCE entry, but only when the entry set is readable: the TIMEOUT_EVIDENCE object
 *     literal was parsed with every member an unquoted key at the start of a line holding an object literal, it
 *     has entries, and every other exported numeric constant has one (amendment A3). Anything else (a spread-built
 *     map, a quoted or computed key, an empty or missing literal) is format drift: a silent pass, because a deny
 *     there could name an entry the file already has and could not be satisfied;
 *   - or its entry is kind `measured` with a positive literal observedMaxMs and the comment that starts
 *     `Evidence (TIMEOUT_EVIDENCE.<NAME>):` is missing, or lacks `worst observed <observedMaxMs>ms` (entries without
 *     censoredBelowMs only), or its first `margin <M>x` / `margin at least <M>x` has Math.round(M * 100) equal to
 *     neither Math.floor((value * 100) / observedMaxMs) nor upstream's Math.floor((value / observedMaxMs) * 100).
 *     The comment is bounded (amendment A2): from the tag to the closing star-slash of the same block comment, or to
 *     the end of a run of `//` lines; nothing after it is read.
 * Re-exports: for another tests/helpers/<f> file, the ON-DISK timeouts.cjs maps `const { A, B: alias } =
 * require('./<f>')` to exports in two forms, `const NAME = alias;` and the destructured name exported as itself. A
 * rising top-level constant A of <f> whose export has a measured entry is judged against that entry and comment in
 * the on-disk timeouts.cjs, and the reason names tests/helpers/timeouts.cjs; an export with no entry, a mirror or an
 * exempt kind sends A to arm B in its own file. Identifiers on a right-hand side resolve only through the image's
 * own top-level numeric constants, built in declaration order (`5 * PROBE_TIMEOUT_MS`); an imported or otherwise
 * unresolved identifier is trusted, as upstream's ESLint rule trusts it. Every deny names every failing constant,
 * the file to fix, the accepted forms and the passing order (entry and comment first, then the value; or all in
 * one Write or MultiEdit; a comment-only or evidence-only edit is never denied).
 *
 * ARM A CHECKS ARITHMETIC CURRENCY ONLY. It checks that the stated figures agree with the TIMEOUT_EVIDENCE entry
 * and the value. It cannot check that an observation is real: a raise with a recomputed margin and no new
 * measurement passes.
 *
 * ARM B (context only), every other gsd-core tests/** JS-family file (.js .cjs .mjs .ts .cts .mts, any case). A
 * declaration (any indentation) whose ASCII identifier contains `timeout` in any case, with a numeric-literal
 * right-hand side, rises when its value is greater than every baseline value of that name or the name is absent
 * from the baseline. Its comment block is the contiguous comment lines directly above the run of adjacent timeout
 * declarations it belongs to, plus the run's trailing `//` comments; a blank line ends the block. When that text
 * names neither an exempt kind (fixture data, test backstop, mirror; a bare "fixture" does not exempt) nor
 * (observed or worst) AND (margin or <n>x) AND a platform, the hook emits additionalContext and NO
 * permissionDecision, naming each constant in line order with its old and new value. Arm B never denies and never
 * asks; its evidence words can be satisfied by a comment with no real evidence behind it.
 *
 * SILENT PASS, NEVER AN EXPLICIT ALLOW OR ASK. Every other path writes NOTHING to stdout and exits 0. An explicit
 * allow would skip Claude Code's permission prompt; an ask degrades to allow under bypass mode, denies in a -p run
 * and has stalled interactive Orca workers. Only an object whose permissionDecision is exactly `deny` with a
 * non-empty reason, or an object with a non-empty additionalContext and no permissionDecision key, produces output.
 * It never uses failclosed.cjs emit() or runGate.
 *
 * FAILS OPEN. A malformed payload, a non-matching tool, a target outside <root>/tests/ or not JS-family, no gsd-core
 * root, a missing target on an Edit whose old_string is not empty, an old_string that is absent or not unique
 * without replace_all, a non-regular or over-1-MiB target, content, new_string or post-image over 1 MiB, a parse
 * the guard cannot read, and any throw (requires are lazy, inside the try) are a silent pass. A hook Claude Code
 * cancels at its timeout does not block the call either.
 *
 * NOT COVERED. Only Write, Edit and MultiEdit (MultiEdit only where the client offers it) on gsd-core tests/** are
 * seen: not Bash (sed, a heredoc, cp), NotebookEdit or git apply. Also not: a call-site swap to a larger existing
 * constant; an identifier at a call site (`IDENT * 4`); an imported identifier in timeouts.cjs; a new helper
 * constant re-exported through a NEW destructure in timeouts.cjs (a destructure is not a numeric declaration of
 * timeouts.cjs, and the on-disk map is read before the edit); an entry kind changed from measured to an exempt kind,
 * in the same edit as a raise or before it; an entry-only change that leaves the comment stale (no value rises; CI
 * checks the 2x floor); a non-exported numeric constant in timeouts.cjs; Claude Code's fuzzy quote matching on Edit
 * (an old_string the guard does not find is a silent pass); a dangling symlink outside the checkout whose target is
 * in tests/ (unconfirmed what the Write tool does with it); arm B's multiset rule, which misses a raise of the
 * smaller of two same-name locals that stays below the larger one; production src/ and bin/ timeouts.
 *
 * KNOWN FALSE DENIES. A value edited before its entry or comment, and correct figures in other wording. Both are
 * answered by the reason, which names the passing order and the exact accepted forms.
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
const TOP_DECL_RE = /^(?:const|let|var)[ \t]+([A-Za-z_$][A-Za-z0-9_$]*)[ \t]*=(?![=>])/;
const ANY_DECL_RE = /^([ \t]*)(?:export[ \t]+)?(?:const|let|var)[ \t]+([A-Za-z_$][A-Za-z0-9_$]*)[ \t]*=(?![=>])/;
const MAX_DEPTH = 20;

const lf = (s) => s.replace(/\r\n/g, '\n');
const bytes = (s) => Buffer.byteLength(s, 'utf8');

// ---------------------------------------------------------------- lexing

/**
 * Per-character kinds of a JS-like text: 0 code, 1 comment, 2 string. Linear; regex literals are not recognised
 * (an unterminated quote ends at its line, so a stray quote damages one line at most).
 *
 * @param {string} text
 * @returns {Uint8Array}
 */
function classify(text) {
  const n = text.length;
  const k = new Uint8Array(n);
  let i = 0;
  while (i < n) {
    const c = text[i];
    const d = text[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && text[i] !== '\n') k[i++] = 1;
      continue;
    }
    if (c === '/' && d === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      while (i < stop) k[i++] = 1;
      continue;
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
      continue;
    }
    k[i++] = 0;
  }
  return k;
}

/**
 * The analysed image: kinds, a copy with every comment character blanked to a space (newlines kept), and line
 * start offsets.
 *
 * @param {string} text LF-normalised
 */
function analyze(text) {
  const kinds = classify(text);
  let blanked = '';
  const parts = [];
  let runStart = 0;
  for (let i = 0; i < text.length; i++) {
    if (kinds[i] === 1 && text[i] !== '\n') {
      if (runStart < i) parts.push(text.slice(runStart, i));
      parts.push(' ');
      runStart = i + 1;
    }
  }
  parts.push(text.slice(runStart));
  blanked = parts.join('');
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  const lineEnd = (idx) => (idx + 1 < starts.length ? starts[idx + 1] - 1 : text.length);
  return { text, kinds, blanked, starts, lineEnd };
}

// ---------------------------------------------------------------- numbers

const NUM_RE =
  /^(?:0[xX][0-9a-fA-F](?:_?[0-9a-fA-F])*|0[oO][0-7](?:_?[0-7])*|0[bB][01](?:_?[01])*|(?:\d(?:_?\d)*(?:\.(?:\d(?:_?\d)*)?)?|\.\d(?:_?\d)*)(?:[eE][+-]?\d(?:_?\d)*)?)(?![A-Za-z0-9_$])/;
const ID_RE = /^[A-Za-z_$][A-Za-z0-9_$]*/;

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
    const rest = s.slice(i);
    const num = NUM_RE.exec(rest);
    if (num) {
      i += num[0].length;
      return Number(num[0].replace(/_/g, ''));
    }
    const id = ID_RE.exec(rest);
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

/**
 * Declarations of an analysed image. topLevel: `const|let|var NAME = ...` at column 0; otherwise any indentation
 * (optionally `export`). The right-hand side runs to the first code `;` or the end of the line, comments blanked.
 *
 * @returns {{name:string, rhs:string, line:number}[]}
 */
function declarations(A, topLevel) {
  const out = [];
  const re = topLevel ? TOP_DECL_RE : ANY_DECL_RE;
  for (let idx = 0; idx < A.starts.length; idx++) {
    const s = A.starts[idx];
    const e = A.lineEnd(idx);
    const line = A.text.slice(s, e);
    const m = re.exec(line);
    if (!m) continue;
    const kwOff = s + (topLevel ? 0 : m[1].length);
    if (A.kinds[kwOff] !== 0) continue;
    const rhsStart = s + m[0].length;
    let rhsEnd = e;
    for (let j = rhsStart; j < e; j++) {
      if (A.kinds[j] === 0 && A.text[j] === ';') {
        rhsEnd = j;
        break;
      }
    }
    out.push({ name: topLevel ? m[1] : m[2], rhs: A.blanked.slice(rhsStart, rhsEnd).trim(), line: idx });
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

/** Index of the `}` closing the code `{` at `open`, or -1. */
function closeOf(A, open) {
  let depth = 0;
  for (let j = open; j < A.text.length; j++) {
    if (A.kinds[j] !== 0) continue;
    const ch = A.text[j];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return j;
    }
  }
  return -1;
}

/**
 * Members of the object literal between `open` and `close`: { form, key, start, valueStart, end, lineStart }.
 * form is 'key' (IDENT: value), 'shorthand', 'spread', 'quoted', 'computed' or 'other'.
 */
function membersOf(A, open, close) {
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
    else if (/^['"`]/.test(t)) form = 'quoted';
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
 * The TIMEOUT_EVIDENCE object literal: { found, readable, entries }. readable only when every member is an unquoted
 * key at the start of a line whose value is an object literal, and at least one entry was read.
 */
function evidenceOf(A) {
  const re = /^(?:const|let|var)[ \t]+TIMEOUT_EVIDENCE[ \t]*=[ \t]*(?:Object\.freeze\(\s*)?\{/gm;
  const entries = new Map();
  let m;
  while ((m = re.exec(A.blanked))) {
    if (A.kinds[m.index] !== 0) continue;
    const open = m.index + m[0].length - 1;
    const close = closeOf(A, open);
    if (close === -1) return { found: true, readable: false, entries };
    let bad = false;
    for (const mem of membersOf(A, open, close)) {
      if (mem.form !== 'key' || !mem.lineStart) {
        bad = true;
        continue;
      }
      const vLead = /^\s*/.exec(A.blanked.slice(mem.valueStart, mem.end))[0];
      const vOpen = mem.valueStart + vLead.length;
      const vClose = A.blanked[vOpen] === '{' ? closeOf(A, vOpen) : -1;
      if (vClose === -1 || vClose >= mem.end) {
        bad = true;
        continue;
      }
      const fields = Object.create(null);
      for (const f of membersOf(A, vOpen, vClose)) {
        if (f.form === 'key') fields[f.key] = A.blanked.slice(f.valueStart, f.end).trim();
      }
      const kindRaw = fields.kind;
      const km = typeof kindRaw === 'string' ? /^(['"])([^'"]*)\1$/.exec(kindRaw) : null;
      entries.set(mem.key, {
        kind: km ? km[2] : null,
        observedMaxMs: typeof fields.observedMaxMs === 'string' ? evalNumeric(fields.observedMaxMs, null) : null,
        censored: Object.prototype.hasOwnProperty.call(fields, 'censoredBelowMs'),
      });
    }
    return { found: true, readable: !bad && entries.size > 0, entries };
  }
  return { found: false, readable: false, entries };
}

/**
 * Parse a timeouts.cjs-shaped module statically.
 *
 * @param {string} text
 * @returns {{exports:Set<string>|null, decls:Map<string,{value:number|null,rhs:string,line:number}>,
 *   entries:Map<string,{kind:string|null,observedMaxMs:number|null,censored:boolean}>, evidenceFound:boolean,
 *   readable:boolean, tags:Set<string>, reexports:Map<string,Map<string,string[]>>}}
 */
function parseTimeoutsModule(text) {
  const A = analyze(lf(String(text)));
  const exportsSet = exportsOf(A);
  const decls = topDecls(A);
  const ev = evidenceOf(A);
  const tags = new Set();
  for (const m of A.text.matchAll(/Evidence \(TIMEOUT_EVIDENCE\.([A-Za-z_$][A-Za-z0-9_$]*)\):/g)) tags.add(m[1]);
  const reexports = new Map();
  const dre = /^(?:const|let|var)[ \t]*\{([^}]*)\}[ \t]*=[ \t]*require\([ \t]*(['"])([^'"\n]+)\2[ \t]*\)/gm;
  let m;
  while ((m = dre.exec(A.blanked))) {
    if (A.kinds[m.index] !== 0) continue;
    const perSource = reexports.get(m[3]) || new Map();
    for (const part of m[1].split(',')) {
      const pm = /^\s*([A-Za-z_$][A-Za-z0-9_$]*)(?:\s*:\s*([A-Za-z_$][A-Za-z0-9_$]*))?\s*$/.exec(part);
      if (!pm) continue;
      const src = pm[1];
      const local = pm[2] || pm[1];
      const names = [];
      for (const [name, d] of decls) if (d.rhs === local && exportsSet && exportsSet.has(name)) names.push(name);
      if (exportsSet && exportsSet.has(local)) names.push(local);
      perSource.set(src, names);
    }
    reexports.set(m[3], perSource);
  }
  return { exports: exportsSet, decls, entries: ev.entries, evidenceFound: ev.found, readable: ev.readable, tags, reexports };
}

// ---------------------------------------------------------------- arm A

/**
 * The comment of NAME: from its `Evidence (TIMEOUT_EVIDENCE.NAME):` tag to the closing star-slash of the same block
 * comment, or to the end of the run of `//` lines holding the tag; whitespace and comment leaders collapsed.
 * null when the tag is absent.
 */
function commentFor(text, name) {
  const tag = 'Evidence (TIMEOUT_EVIDENCE.' + name + '):';
  const at = text.indexOf(tag);
  if (at === -1) return null;
  const from = at + tag.length;
  const lineStart = text.lastIndexOf('\n', at) + 1;
  let end;
  if (/^[ \t]*\/\//.test(text.slice(lineStart, at))) {
    // a run of `//` lines: up to the end of the last consecutive `//` line (amendment A2)
    end = text.indexOf('\n', at);
    if (end === -1) end = text.length;
    while (end < text.length) {
      const next = text.indexOf('\n', end + 1);
      const stop = next === -1 ? text.length : next;
      if (!/^[ \t]*\/\//.test(text.slice(end + 1, stop))) break;
      end = stop;
    }
  } else {
    // a block comment: up to its closing star-slash (amendment A2); an unclosed block ends at the tag's line
    const close = text.indexOf('*/', from);
    if (close !== -1) end = close;
    else {
      end = text.indexOf('\n', from);
      if (end === -1) end = text.length;
    }
  }
  return text
    .slice(from, end)
    .replace(/\n[ \t]*(?:\*(?!\/)|\/\/)?/g, ' ')
    .replace(/\s+/g, ' ');
}

const fmt = (h) => (h / 100).toFixed(2);

/**
 * Problems with NAME's comment for `value` against its measured entry, or null when it is current.
 */
function measuredProblems(text, name, value, entry) {
  const obs = entry.observedMaxMs;
  const c = commentFor(text, name);
  const hInt = Math.floor((value * 100) / obs);
  const hFlt = Math.floor((value / obs) * 100);
  const need =
    (entry.censored ? '' : '`worst observed ' + obs + 'ms` and ') +
    '`margin ' + fmt(hInt) + 'x` or `margin at least ' + fmt(hInt) + 'x`' +
    (hFlt !== hInt ? ' (' + fmt(hFlt) + ' is also accepted)' : '');
  if (c === null) return 'no `Evidence (TIMEOUT_EVIDENCE.' + name + '):` comment; it needs ' + need;
  const problems = [];
  if (!entry.censored) {
    const wo = /worst observed (\d+)ms/.exec(c);
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

const shown = (v) => (v === null || v === undefined ? 'none' : String(v));

function denyReason(failures) {
  return (
    'ENF-27: this edit raises, newly sets or newly exports ' + failures.length + ' timeout constant(s) whose ' +
    'evidence in `tests/helpers/timeouts.cjs` is missing or not current:\n' +
    failures.map((f) => '- ' + f).join('\n') + '\n' +
    'Fix `tests/helpers/timeouts.cjs`. Accepted forms, read only inside the comment that starts ' +
    '`Evidence (TIMEOUT_EVIDENCE.<NAME>):` (up to its closing star-slash, or the end of its `//` run): ' +
    '`worst observed <N>ms` with N equal to the entry\'s observedMaxMs (not needed when the entry has ' +
    'censoredBelowMs), and, as the first margin after the tag, `margin <M>x` or `margin at least <M>x`, where M is ' +
    'value / observedMaxMs rounded down to hundredths. Passing order: add or edit the TIMEOUT_EVIDENCE entry and ' +
    'the Evidence comment first (a comment-only or evidence-only edit is never denied), then change or export the ' +
    'value; or do all of it in one Write or MultiEdit. This guard checks only that the stated figures are ' +
    'arithmetically current with the entry; it cannot check that an observation is real. ' +
    '(ENF-27, fail-open edit guard)'
  );
}

/** Arm A over tests/helpers/timeouts.cjs: a list of failure lines (empty when nothing fails). */
function armA(baseline, post) {
  const P = parseTimeoutsModule(post);
  // Format drift (amendment A3): no exports object, or a TIMEOUT_EVIDENCE literal the parser cannot read in full
  // (missing, spread-built, a quoted, computed or non-line-start key, or empty) is a silent pass.
  if (!P.exports || !P.readable) return [];
  const B = parseTimeoutsModule(baseline);
  const baseExports = B.exports || new Set();
  const judged = [];
  for (const [name, d] of P.decls) {
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
    const head = j.name + ' ' + shown(j.old) + ' -> ' + j.value + (j.newlyExported ? ' (newly exported)' : '');
    const e = P.entries.get(j.name);
    if (!e) {
      if (!othersCovered) continue;
      failures.push(
        head + ': no TIMEOUT_EVIDENCE entry. Add `' + j.name + ": { kind: 'measured', observedMaxMs: <N>, ... }` " +
          '(or an exempt kind with its reason) to TIMEOUT_EVIDENCE and an `Evidence (TIMEOUT_EVIDENCE.' + j.name +
          '):` comment above the declaration first'
      );
      continue;
    }
    if (e.kind !== 'measured') continue;
    if (!(typeof e.observedMaxMs === 'number' && e.observedMaxMs > 0)) continue;
    const p = measuredProblems(post, j.name, j.value, e);
    if (p) failures.push(head + ' (TIMEOUT_EVIDENCE.' + j.name + ' observedMaxMs ' + e.observedMaxMs + (e.censored ? ', censored' : '') + '): ' + p);
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
  if (!T.readable) return out;
  const base = rel.slice('tests/helpers/'.length);
  const map = T.reexports.get('./' + base) || T.reexports.get('./' + base.replace(/\.[^.]+$/, ''));
  if (!map) return out;
  const tText = lf(timeoutsText);
  const P = topDecls(analyze(post));
  const B = topDecls(analyze(baseline));
  for (const [src, exportNames] of map) {
    const d = P.get(src);
    if (!d || d.value === null) continue;
    const b = B.get(src);
    const old = b ? b.value : null;
    if (!(old === null || old < d.value)) continue;
    for (const E of exportNames) {
      const e = T.entries.get(E);
      if (!e || e.kind !== 'measured') continue;
      out.handledLines.add(d.line);
      if (!(typeof e.observedMaxMs === 'number' && e.observedMaxMs > 0)) continue;
      const p = measuredProblems(tText, E, d.value, e);
      if (p) {
        out.failures.push(
          src + ' in `' + rel + '` (re-exported by tests/helpers/timeouts.cjs as ' + E + ') ' + shown(old) + ' -> ' +
            d.value + ' (TIMEOUT_EVIDENCE.' + E + ' observedMaxMs ' + e.observedMaxMs + (e.censored ? ', censored' : '') +
            '): ' + p
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
  let out = '';
  for (let j = A.starts[idx]; j < A.lineEnd(idx); j++) if (A.kinds[j] === 1) out += A.text[j];
  return out;
}

/** Arm B: rising unevidenced file-local timeout constants, in post-image line order. */
function armB(baseline, post, skipLines) {
  const isTimeout = (n) => /timeout/i.test(n);
  const baseVals = new Map();
  for (const d of declarations(analyze(baseline), false)) {
    if (!isTimeout(d.name)) continue;
    const v = evalNumeric(d.rhs, null);
    if (!baseVals.has(d.name)) baseVals.set(d.name, []);
    if (v !== null) baseVals.get(d.name).push(v);
  }
  const A = analyze(post);
  const decls = declarations(A, false).filter((d) => isTimeout(d.name));
  const declLines = new Set(decls.map((d) => d.line));
  const flagged = [];
  for (const d of decls) {
    if (skipLines && skipLines.has(d.line)) continue;
    const value = evalNumeric(d.rhs, null);
    if (value === null) continue;
    const vals = baseVals.get(d.name) || [];
    if (!(vals.length === 0 || vals.every((v) => value > v))) continue;
    let runStart = d.line;
    while (runStart > 0 && declLines.has(runStart - 1)) runStart--;
    let runEnd = d.line;
    while (declLines.has(runEnd + 1)) runEnd++;
    let text = '';
    for (let i = runStart - 1; i >= 0 && commentLine(A, i); i--) text = A.text.slice(A.starts[i], A.lineEnd(i)) + '\n' + text;
    for (let i = runStart; i <= runEnd; i++) text += '\n' + trailingComment(A, i);
    if (statesEvidence(text)) continue;
    flagged.push({ name: d.name, old: vals.length ? Math.max(...vals) : null, value, line: d.line + 1 });
  }
  return flagged;
}

function advisoryText(rel, flagged) {
  return (
    'ENF-27 timeout-evidence note (context only; nothing was blocked): this edit raises or adds ' + flagged.length +
    ' file-local timeout constant(s) in `' + rel + '` whose comment states no evidence:\n' +
    flagged.map((f) => '- ' + f.name + ' ' + shown(f.old) + ' -> ' + f.value + ' (line ' + f.line + ')').join('\n') + '\n' +
    'gsd-core TESTING-STANDARDS.md "Every new or changed timeout constant states its evidence": the comment directly ' +
    'above the declaration should state (1) the observed range (the worst observed duration, p50/p99 where known, ' +
    'and the sample count), (2) the worst platform (win32, darwin or linux), (3) the margin (the constant over the ' +
    'worst observation, at least 2x) and (4) the source and window; or name an exempt kind (fixture data, test ' +
    'backstop, mirror). Code review checks this upstream. (ENF-27, context-only note)'
  );
}

// ---------------------------------------------------------------- the decision

/**
 * The pure decision over a relative target path, its baseline, its post-image and (for a helper) the on-disk
 * timeouts.cjs text. Returns a deny object, an advisory object ({additionalContext}) or null.
 *
 * @param {{rel:string, baseline:string, post:string, timeoutsText?:string|null}} args
 */
function judge({ rel, baseline, post, timeoutsText }) {
  const b = lf(String(baseline));
  const p = lf(String(post));
  if (rel === TIMEOUTS_REL) {
    const failures = armA(b, p);
    return failures.length ? { permissionDecision: 'deny', permissionDecisionReason: denyReason(failures) } : null;
  }
  let skip = new Set();
  if (/^tests\/helpers\/[^/]+$/.test(rel)) {
    const r = armAReexport(rel, b, p, timeoutsText);
    if (r.failures.length) return { permissionDecision: 'deny', permissionDecisionReason: denyReason(r.failures) };
    skip = r.handledLines;
  }
  const flagged = armB(b, p, skip);
  return flagged.length ? { additionalContext: advisoryText(rel, flagged) } : null;
}

/**
 * Apply Edit/MultiEdit edits to an image as Claude Code does, or null when the tool would fail: CRLF normalised,
 * an empty old_string creates only on an empty or whitespace-only image, an absent old_string or a non-unique one
 * without replace_all fails, an empty new_string also removes a following newline, split/join (never a string
 * replace, where `$&` would expand), each edit on the running image.
 *
 * @param {string} image
 * @param {Array<{old_string:string,new_string:string,replace_all?:boolean}>} edits
 * @returns {string|null}
 */
function applyEdits(image, edits) {
  if (typeof image !== 'string' || !Array.isArray(edits) || edits.length === 0) return null;
  let img = lf(image);
  for (const e of edits) {
    if (!e || typeof e !== 'object') return null;
    if (typeof e.old_string !== 'string' || typeof e.new_string !== 'string') return null;
    let oldS = lf(e.old_string);
    const newS = lf(e.new_string);
    if (bytes(newS) > MAX_BYTES) return null;
    if (oldS === '') {
      if (img.trim() !== '') return null;
      img = newS;
      continue;
    }
    if (oldS === newS) return null;
    const count = img.split(oldS).length - 1;
    if (count === 0) return null;
    if (count > 1 && e.replace_all !== true) return null;
    if (newS === '' && !oldS.endsWith('\n') && img.includes(oldS + '\n')) oldS += '\n';
    if (e.replace_all === true) img = img.split(oldS).join(newS);
    else {
      const at = img.indexOf(oldS);
      img = img.slice(0, at) + newS + img.slice(at + oldS.length);
    }
    if (bytes(img) > MAX_BYTES) return null;
  }
  return img;
}

/** realpath of p; for a missing path, the realpath of its nearest existing ancestor joined with the rest. */
function realpathNearest(p) {
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
 * The decision over a PreToolUse payload: a deny object, an advisory object or null. May throw; runEditGuard
 * turns any throw into a silent pass.
 *
 * @param {string} stdinString
 * @param {{resolveRoot?: (startDir:string) => string}} [deps]
 */
function gate(stdinString, deps = {}) {
  const input = JSON.parse(stdinString);
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return null;
  const tool = input.tool_name;
  if (!TOOLS.has(tool)) return null;
  const ti = input.tool_input;
  if (!ti || typeof ti !== 'object') return null;
  const filePath = ti.file_path;
  if (typeof filePath !== 'string' || filePath.length === 0) return null;

  const cwd = typeof input.cwd === 'string' && input.cwd.length > 0 ? input.cwd : process.cwd();
  const abs = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(cwd, filePath);
  const real = realpathNearest(abs);
  if (!real || !JS_EXT_RE.test(real)) return null;

  const resolveRoot = deps.resolveRoot || require('./lib/resolve.cjs').resolveGsdCoreRoot;
  const rootReal = fs.realpathSync.native(resolveRoot(path.dirname(real)));
  const relNative = path.relative(rootReal, real);
  if (!relNative || path.isAbsolute(relNative)) return null;
  const segs = relNative.split(path.sep);
  if (segs.length < 2 || segs[0] !== 'tests' || segs.includes('..')) return null;
  const rel = segs.join('/');

  const { readRegularFileBounded } = require('./lib/regular-file.cjs');
  let baseline;
  try {
    baseline = readRegularFileBounded(real);
  } catch (err) {
    if (err && err.code === 'ENOENT') baseline = '';
    else return null;
  }
  baseline = lf(baseline);

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

  let timeoutsText = null;
  if (rel !== TIMEOUTS_REL && segs.length === 3 && segs[1] === 'helpers') {
    try {
      timeoutsText = readRegularFileBounded(path.join(rootReal, 'tests', 'helpers', 'timeouts.cjs'));
    } catch (_) {
      timeoutsText = null;
    }
  }
  return judge({ rel, baseline, post, timeoutsText });
}

/**
 * The entry seam: a deny object only for a result whose permissionDecision is exactly 'deny' with a non-empty
 * reason; an advisory object only for a non-empty additionalContext with no permissionDecision key; null (a silent
 * pass) for every other result and for any throw.
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
};
