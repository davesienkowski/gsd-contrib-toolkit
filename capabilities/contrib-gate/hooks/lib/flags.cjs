'use strict';

/**
 * hooks/lib/flags.cjs — flag-vs-message-text matcher (ENF-12 helper / edge-probe EP-3).
 *
 * The boundary bug this fixes: a gate that denies `--no-verify` by substring-grepping
 * the raw command will ALSO deny `git commit -m "never use --no-verify"` — a
 * false-positive deny that erodes trust and gets the toolkit disabled (red-team H-B).
 * The fix is to consult ONLY the STRUCTURED flag tokens produced by argv.cjs — never
 * the raw string, never the `-m` message value. A flag is a flag; message text is data.
 *
 * `hasFlag` reports presence of any of the named flags across all command segments.
 * `extractMessageText` deliberately surfaces the message body separately, so a caller
 * that wants to inspect the message does so explicitly — the message is never folded
 * back into the flag-detection path.
 *
 * Neither function throws: on a failed/garbage parse `hasFlag` returns false and
 * `extractMessageText` returns '' — the GATE (not this helper) owns the fail-closed
 * decision for an unparseable command, having already gotten {ok:false} from the parser.
 *
 * Pure: no I/O, no process.env.
 *
 * @module hooks/lib/flags
 */

require('./argv.cjs'); // contract dependency (operates on parseCommand output)

/**
 * Normalize a flag name to its bare form (strip leading dashes) and note whether
 * it was a long (>=2 char) or short (1 char) name. We match by bare name against
 * the structured `flags` (long) and `shortFlags` (short) maps.
 *
 * @param {string} name e.g. '--no-verify', '-n', 'no-verify', 'n'
 * @returns {{bare:string}}
 */
function normalizeName(name) {
  let bare = String(name);
  while (bare.startsWith('-')) bare = bare.slice(1);
  return { bare };
}

/**
 * Does the parsed command carry any of the named flags as a REAL argv flag?
 *
 * Consults only `flags` (long) and `shortFlags` (short) on each segment — the
 * structured flag space. The `-m`/`--message` VALUE is never inspected, so a flag
 * literal appearing inside a commit message does not match (EP-3).
 *
 * @param {Object} parsed result of argv.parseCommand
 * @param {string[]} names flag names to look for (with or without leading dashes)
 * @returns {boolean} true if any named flag is present as an argv flag
 */
function hasFlag(parsed, names) {
  if (!parsed || typeof parsed !== 'object' || parsed.ok !== true) return false;
  if (!Array.isArray(names) || names.length === 0) return false;

  const bareNames = names.map((n) => normalizeName(n).bare).filter((b) => b.length > 0);
  if (bareNames.length === 0) return false;

  const segments = Array.isArray(parsed.segments) && parsed.segments.length > 0
    ? parsed.segments
    : [parsed];

  for (const seg of segments) {
    const longFlags = (seg && seg.flags) || {};
    const shortFlags = (seg && seg.shortFlags) || {};
    for (const bare of bareNames) {
      // Long flag map is keyed by bare long name (e.g. 'no-verify').
      // Short flag map is keyed by single letter (e.g. 'n', and bundled 'X').
      if (Object.prototype.hasOwnProperty.call(longFlags, bare)) return true;
      if (Object.prototype.hasOwnProperty.call(shortFlags, bare)) return true;
    }
  }

  return false;
}

/**
 * Extract the commit/PR message body from the parsed command — the joined values
 * of `-m` / `--message`. Returns the message string so a caller can inspect it
 * EXPLICITLY and separately; it is never run through hasFlag.
 *
 * Scans every segment and joins discovered message values with a newline (git's
 * own multi-`-m` join semantics), preserving the deliberate segregation of message
 * data from flag space.
 *
 * @param {Object} parsed result of argv.parseCommand
 * @returns {string} the message text, or '' if none / on a bad parse
 */
function extractMessageText(parsed) {
  if (!parsed || typeof parsed !== 'object' || parsed.ok !== true) return '';

  const segments = Array.isArray(parsed.segments) && parsed.segments.length > 0
    ? parsed.segments
    : [parsed];

  const parts = [];
  for (const seg of segments) {
    const longFlags = (seg && seg.flags) || {};
    const shortFlags = (seg && seg.shortFlags) || {};

    if (typeof shortFlags.m === 'string') parts.push(shortFlags.m);
    if (typeof longFlags.message === 'string') parts.push(longFlags.message);
  }

  return parts.join('\n');
}

module.exports = { hasFlag, extractMessageText };
