'use strict';

/**
 * hooks/lib/argv.cjs — Robust, dependency-free argv tokenizer + structured parser
 * for `tool_input.command` (HARD-04 / edge-probe EP-2).
 *
 * The whole anti-bypass surface rests on this module: every downstream gate asks
 * "is this an issue-create / a --no-verify commit / …" of the STRUCTURED parse this
 * produces. A naive String.split / substring grep is the EP-2 bypass (reordered
 * flags, quoting, --body=inline vs --body inline, stdin sentinel, command chaining
 * all walk around it). So we tokenize char-by-char with quote/escape state, and we
 * FAIL CLOSED — `{ ok:false, reason }`, never a throw, never a guessed `ok:true` —
 * on ANY uncertainty (unbalanced quote, null byte, empty, internal exception).
 *
 * Pure: no I/O, no process.env, no side effects.
 *
 * @module hooks/lib/argv
 */

/**
 * Recognize a heredoc redirection operator at index `i` (caller guarantees an
 * UNQUOTED, unescaped context): `<<WORD`, `<<-WORD`, with the delimiter optionally
 * quoted (`<<'WORD'`, `<<"WORD"`) and optional spaces/tabs between `<<` and WORD.
 *
 * Returns `{ delim, dash, end }` where `end` is the index just past the delimiter,
 * or null when this is not a heredoc we model (a single `<` redirect, a here-string
 * `<<<`, an unterminated quoted delimiter, or `<<` with no following word).
 *
 * @param {string} str
 * @param {number} i index of the first `<`
 * @returns {{delim:string, dash:boolean, end:number}|null}
 */
function parseHeredocOperator(str, i) {
  if (str[i] !== '<' || str[i + 1] !== '<') return null;
  if (str[i + 2] === '<') return null; // here-string <<<, not a heredoc

  let j = i + 2;
  let dash = false;
  if (str[j] === '-') { dash = true; j += 1; }
  while (str[j] === ' ' || str[j] === '\t') j += 1;

  let delim = '';
  const q = str[j];
  if (q === "'" || q === '"') {
    j += 1;
    while (j < str.length && str[j] !== q) { delim += str[j]; j += 1; }
    if (j >= str.length) return null; // unterminated delimiter quote → let normal parsing fail closed
    j += 1; // consume the closing quote
  } else {
    while (j < str.length && /[A-Za-z0-9_]/.test(str[j])) { delim += str[j]; j += 1; }
  }

  if (delim.length === 0) return null; // `<<` with no word — a redirection we don't treat as a heredoc
  return { delim, dash, end: j };
}

/**
 * Given `bodyStart` (index of the first character of a heredoc body — i.e. just
 * after the newline that ends the introducing line), return the index just past the
 * heredoc terminator line. The body is every line up to one equal to `delim` (with
 * leading tabs stripped from the terminator when `dash` is set, per `<<-`). If no
 * terminator is found, the body runs to end-of-string.
 *
 * @param {string} str
 * @param {number} bodyStart
 * @param {string} delim
 * @param {boolean} dash
 * @returns {number}
 */
function findHeredocBodyEnd(str, bodyStart, delim, dash) {
  let lineStart = bodyStart;
  while (lineStart <= str.length) {
    let lineEnd = str.indexOf('\n', lineStart);
    if (lineEnd === -1) lineEnd = str.length;
    let line = str.slice(lineStart, lineEnd);
    if (dash) line = line.replace(/^\t+/, '');
    if (line === delim) {
      return lineEnd === str.length ? str.length : lineEnd + 1;
    }
    if (lineEnd === str.length) return str.length;
    lineStart = lineEnd + 1;
  }
  return str.length;
}

/**
 * POSIX-style shell tokenizer.
 *
 * Walks the string one character at a time tracking single-quote / double-quote /
 * backslash-escape state, emitting tokens split on UNQUOTED whitespace. Quoted
 * whitespace is preserved within a single token. Adjacent quoted+unquoted runs
 * concatenate into one token (`--body="a b"` → `--body=a b`).
 *
 * Throws on an unbalanced quote or a dangling trailing escape — callers
 * (parseCommand) catch this and convert it to a fail-closed result.
 *
 * @param {string} str raw command string
 * @returns {string[]} ordered tokens
 * @throws {Error} on unbalanced quote / dangling escape
 */
function tokenize(str) {
  if (typeof str !== 'string') {
    throw new TypeError('tokenize: expected string');
  }

  const tokens = [];
  let cur = '';
  let hasToken = false; // distinguishes "" (empty quoted token) from no token
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  const pendingHeredocs = []; // delimiters seen on the current line, bodies consumed at \n

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];

    if (escaped) {
      // Inside double quotes a backslash only escapes a small set; for our
      // gate-classification purposes we keep the char literally either way.
      cur += ch;
      escaped = false;
      hasToken = true;
      continue;
    }

    if (ch === '\\' && !inSingle) {
      // Backslash escapes next char (outside single quotes).
      escaped = true;
      hasToken = true;
      continue;
    }

    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      } else {
        cur += ch;
      }
      hasToken = true;
      continue;
    }

    if (inDouble) {
      if (ch === '"') {
        inDouble = false;
      } else {
        cur += ch;
      }
      hasToken = true;
      continue;
    }

    // Unquoted, unescaped context:

    // Heredoc operator (<<WORD / <<-WORD / <<'WORD'): the body (the lines after the
    // current one, up to the terminator) is opaque shell input, not command syntax.
    // Record the delimiter and keep the operator text; the body is fast-forwarded
    // when the introducing line ends, so quotes/separators inside it never apply.
    const hd = parseHeredocOperator(str, i);
    if (hd) {
      cur += str.slice(i, hd.end);
      hasToken = true;
      pendingHeredocs.push({ delim: hd.delim, dash: hd.dash });
      i = hd.end - 1; // resume just after the delimiter (loop i++)
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      hasToken = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      hasToken = true;
      continue;
    }
    if (ch === '\n' && pendingHeredocs.length > 0) {
      // End of the introducing line → consume each pending heredoc body opaquely.
      if (hasToken) {
        tokens.push(cur);
        cur = '';
        hasToken = false;
      }
      let bodyStart = i + 1;
      for (const h of pendingHeredocs) {
        bodyStart = findHeredocBodyEnd(str, bodyStart, h.delim, h.dash);
      }
      pendingHeredocs.length = 0;
      i = bodyStart - 1; // resume after the last terminator (loop i++)
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v') {
      if (hasToken) {
        tokens.push(cur);
        cur = '';
        hasToken = false;
      }
      continue;
    }

    cur += ch;
    hasToken = true;
  }

  if (inSingle || inDouble) {
    throw new Error('unbalanced quote');
  }
  if (escaped) {
    throw new Error('dangling escape');
  }
  if (hasToken) {
    tokens.push(cur);
  }

  return tokens;
}

// Unquoted shell separators that split a command line into independent segments.
// We detect these BEFORE tokenizing each segment, by tokenizing once at the top
// level using sentinel-aware splitting. Simpler: split the RAW string on these
// separators while respecting quote/escape state, then tokenize each piece.
const SEGMENT_SEPARATORS = [';', '&&', '||', '|'];

/**
 * Split a raw command string into segments on UNQUOTED `;`, `&&`, `||`, `|`,
 * respecting quote and escape state so a separator inside `-m "a ; b"` does NOT
 * split. Returns the list of raw segment strings (trimmed). Throws on unbalanced
 * quote (same fail-closed contract as tokenize).
 *
 * @param {string} str
 * @returns {string[]}
 * @throws {Error} on unbalanced quote / dangling escape
 */
function splitSegments(str) {
  const segments = [];
  let cur = '';
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  const pendingHeredocs = []; // delimiters seen on the current line, bodies consumed at \n

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];

    if (escaped) {
      cur += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\' && !inSingle) {
      cur += ch;
      escaped = true;
      continue;
    }
    if (inSingle) {
      cur += ch;
      if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      cur += ch;
      if (ch === '"') inDouble = false;
      continue;
    }

    // Heredoc operator: keep the operator text and treat the body as opaque so a
    // `;`/`&&`/`|` inside it does NOT split the command (the body is one segment's
    // input, not a new command). The body is preserved verbatim in `cur` so the
    // per-segment re-tokenize stays consistent.
    const hd = parseHeredocOperator(str, i);
    if (hd) {
      cur += str.slice(i, hd.end);
      pendingHeredocs.push({ delim: hd.delim, dash: hd.dash });
      i = hd.end - 1; // resume just after the delimiter (loop i++)
      continue;
    }

    if (ch === "'") {
      cur += ch;
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      cur += ch;
      inDouble = true;
      continue;
    }
    if (ch === '\n' && pendingHeredocs.length > 0) {
      // End of the introducing line → append each pending heredoc body verbatim.
      cur += ch;
      let bodyStart = i + 1;
      for (const h of pendingHeredocs) {
        const end = findHeredocBodyEnd(str, bodyStart, h.delim, h.dash);
        cur += str.slice(bodyStart, end);
        bodyStart = end;
      }
      pendingHeredocs.length = 0;
      i = bodyStart - 1; // resume after the last terminator (loop i++)
      continue;
    }

    // Unquoted: check separators. Two-char first.
    const two = str.slice(i, i + 2);
    if (two === '&&' || two === '||') {
      segments.push(cur);
      cur = '';
      i += 1; // consume second char
      continue;
    }
    if (ch === ';' || ch === '|') {
      // Note: '|' here is unquoted; a doubled '||' was already handled above.
      segments.push(cur);
      cur = '';
      continue;
    }

    cur += ch;
  }

  if (inSingle || inDouble) {
    throw new Error('unbalanced quote');
  }
  if (escaped) {
    throw new Error('dangling escape');
  }
  segments.push(cur);

  return segments.map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * Classify an ordered token list (one segment) into a structured shape.
 * Program = first token. Subcommands = leading non-flag tokens after the program,
 * UNTIL the first flag is seen (after which non-flag tokens are positionals). A
 * long flag's value is the following token unless `--flag=value` form is used or
 * the next token is itself a flag (then the flag is boolean → value `true`).
 *
 * @param {string[]} tokens
 * @returns {{program:string, subcommands:string[], flags:Object, shortFlags:Object, positionals:string[], tokens:string[]}}
 */
// CR-02: a leading shell env-assignment prefix (`GIT_DIR=/x git commit …`,
// `A=1 B=2 git push …`) must NOT be read as the program — otherwise the real verb
// never surfaces and a gated mutation silently classifies as action:'other'. We
// drop the LEADING run of `NAME=VALUE` tokens before reading the program. This is
// the SINGLE source fix (no duplicate strip in classify.cjs) and it simultaneously
// repairs commandStartDir's `cd` detection for `FOO=x cd …`. The shape is the POSIX
// env-assignment NAME (`[A-Za-z_][A-Za-z0-9_]*`) followed by `=`. Toolkit-OWNED
// robust-parse rule (no LIVE shared classifier to delegate to; repoint per #1549 if
// gsd-core ever extracts one).
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

function classifyTokens(tokens) {
  const flags = {};
  const shortFlags = {};
  const subcommands = [];
  const positionals = [];
  let program = '';
  let sawFlag = false;

  // Advance past every LEADING env-assignment token; the program is the first
  // non-assignment token. seg.tokens stays the FULL raw argv (HARD-04 contract) —
  // only the program/subcommand/flag derivation begins at `ti`.
  let ti = 0;
  while (ti < tokens.length && ENV_ASSIGNMENT.test(tokens[ti])) ti += 1;
  program = ti < tokens.length ? tokens[ti] : '';

  for (let i = ti + 1; i < tokens.length; i++) {
    const tok = tokens[i];

    const isLong = tok.startsWith('--') && tok.length > 2;
    const isShort = !isLong && tok.startsWith('-') && tok.length > 1 && tok !== '-';

    if (isLong) {
      sawFlag = true;
      const body = tok.slice(2);
      const eq = body.indexOf('=');
      if (eq !== -1) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
      } else {
        const next = tokens[i + 1];
        if (next !== undefined && !(next.startsWith('-') && next.length > 1 && next !== '-')) {
          flags[body] = next;
          i += 1;
        } else {
          flags[body] = true;
        }
      }
      continue;
    }

    if (isShort) {
      sawFlag = true;
      const body = tok.slice(1);
      const eq = body.indexOf('=');
      if (eq !== -1) {
        shortFlags[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }
      if (body.length === 1) {
        // Single short flag: value is next token if it is not itself a flag.
        const next = tokens[i + 1];
        if (next !== undefined && !(next.startsWith('-') && next.length > 1 && next !== '-')) {
          shortFlags[body] = next;
          i += 1;
        } else {
          shortFlags[body] = true;
        }
      } else {
        // Bundled / value-attached short flag, e.g. -XPOST, -dfoo. Record the
        // leading letter with the remainder as value, AND keep each leading
        // boolean-ish letter present so callers can detect them. We retain the
        // first letter → remainder mapping (covers -XPOST → X:'POST').
        shortFlags[body[0]] = body.slice(1);
      }
      continue;
    }

    // Non-flag token.
    if (!sawFlag) {
      subcommands.push(tok);
    } else {
      positionals.push(tok);
    }
  }

  return { program, subcommands, flags, shortFlags, positionals, tokens };
}

/**
 * Parse a raw command string into a structured, fail-closed result.
 *
 * On success: `{ ok:true, program, subcommands, flags, shortFlags, positionals,
 *   tokens, segments, raw }` where `segments` is the per-segment structured parse
 * (length >= 1) and the top-level program/subcommands/flags mirror the FIRST
 * segment for single-command convenience.
 *
 * On ANY uncertainty: `{ ok:false, reason }`. Never throws. Never returns a
 * partial `ok:true`. This is the HARD-04 fail-closed contract every gate relies on.
 *
 * @param {string} str raw `tool_input.command`
 * @returns {{ok:true, program:string, subcommands:string[], flags:Object, shortFlags:Object, positionals:string[], tokens:string[], segments:Object[], raw:string}|{ok:false, reason:string}}
 */
function parseCommand(str) {
  try {
    if (typeof str !== 'string') {
      return { ok: false, reason: 'command is not a string' };
    }
    if (str.length === 0) {
      return { ok: false, reason: 'empty command' };
    }
    if (str.indexOf(String.fromCharCode(0)) !== -1) {
      return { ok: false, reason: 'null byte in command' };
    }
    if (str.trim().length === 0) {
      return { ok: false, reason: 'whitespace-only command' };
    }

    const rawSegments = splitSegments(str);
    if (rawSegments.length === 0) {
      return { ok: false, reason: 'no command after segment split' };
    }

    const segments = [];
    for (const seg of rawSegments) {
      const tokens = tokenize(seg);
      if (tokens.length === 0) {
        return { ok: false, reason: 'empty segment after tokenize' };
      }
      segments.push(classifyTokens(tokens));
    }

    const first = segments[0];
    return {
      ok: true,
      program: first.program,
      subcommands: first.subcommands,
      flags: first.flags,
      shortFlags: first.shortFlags,
      positionals: first.positionals,
      tokens: first.tokens,
      segments,
      raw: str,
    };
  } catch (err) {
    return {
      ok: false,
      reason: (err && err.message) ? err.message : 'unparseable command',
    };
  }
}

module.exports = { tokenize, parseCommand, splitSegments, classifyTokens };
