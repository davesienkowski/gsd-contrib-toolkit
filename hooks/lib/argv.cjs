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
function classifyTokens(tokens) {
  const flags = {};
  const shortFlags = {};
  const subcommands = [];
  const positionals = [];
  let program = '';
  let sawFlag = false;

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];

    if (i === 0) {
      program = tok;
      continue;
    }

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
