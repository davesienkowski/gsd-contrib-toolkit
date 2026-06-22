#!/usr/bin/env node
'use strict';

/**
 * hooks/issue-dedupe.cjs — PreToolUse(Bash) pre-`gh issue create` dedupe gate
 * (ENF-11, ENF-15 synonym coverage inherited, HARD-01 fail-closed, HARD-04 robust-parse).
 *
 * The threat: a contributor (or AI) files an issue that DUPLICATES an open one, polluting
 * the tracker. gsd-core ships a dedupe scorer (scripts/issue-dedupe.cjs) but it runs as a
 * post-hoc CI step that LABELS + challenges AFTER the duplicate exists. This gate moves the
 * check to the PreToolUse boundary: before `gh issue create` (and its gh-api/curl synonyms)
 * reaches GitHub, fetch the OPEN issue titles, score the new title against them with the
 * LIVE scoreCandidates, and DENY on a high-confidence duplicate — naming the #N to dedupe
 * against so the contributor can comment on the existing issue or override deliberately.
 *
 * Architecture (inherited from Waves 1-2, never re-implemented here):
 *   - argv.parseCommand        → robust char-by-char parse, fail-closed on unparseable
 *   - classify.classifyAction  → native `gh issue create` AND gh-api/curl POST-issues
 *                                synonyms map to action:'issue-create' (ENF-15)
 *   - resolve.requireLiveScript→ require() the LIVE scripts/issue-dedupe.cjs (no reimpl of
 *                                the similarity math — we call scoreCandidates)
 *   - failclosed.runGate       → a thrown error DENIES; only a logged override allows
 *
 * Fail-closed posture (HARD-01): the dedupe needs a READ of the live open issues. If that
 * fetch fails (unauth `gh`, network), we DENY — a dedupe we cannot run is not silently
 * skipped for an enforcement gate (override-escapable). A title we cannot resolve (an
 * interactive `gh issue create` with no --title) is NOT a fail-closed case: there is no
 * asserted title to be a duplicate of, so we allow.
 *
 * Decision (warn-vs-deny): this gate DENIES on a candidate scoring >= the scorer's
 * threshold (default 0.6), consistent with the fail-closed enforcement posture; the reason
 * lists the duplicate #N + similarity and how to proceed.
 *
 * @module hooks/issue-dedupe
 */

const { parseCommand } = require('./lib/argv.cjs');
const { classifyAction } = require('./lib/classify.cjs');
const { runGate, readHookInput, deny, allow, emit } = require('./lib/failclosed.cjs');
const { resolveGsdCoreRoot, requireLiveScript } = require('./lib/resolve.cjs');

// A sentinel thrown to mean "I cannot confidently evaluate this — fail closed."
class FailClosed extends Error {}

/**
 * Find the structured segment classifyAction acted on (the first issue-create segment in a
 * chain) so title resolution reads the right segment's flags.
 *
 * @param {Object} parsed argv.parseCommand result (ok:true)
 * @returns {Object} the matching segment (or the first segment as a fallback)
 */
function findActionSegment(parsed) {
  const segs = Array.isArray(parsed.segments) && parsed.segments.length > 0
    ? parsed.segments
    : [parsed];
  for (const seg of segs) {
    const r = classifyAction({ ok: true, segments: [seg] });
    if (r && r.action === 'issue-create') return seg;
  }
  return segs[0];
}

/**
 * Walk a segment's STRUCTURED token list pulling `-f key=value` / `-F key=value` /
 * `--field key=value` / `--raw-field key=value` (gh api field syntax) pairs. Reads ordered
 * tokens (never the raw string — HARD-04 preserved) because gh api fields can repeat, which
 * argv's flag map collapses.
 *
 * @param {Object} seg
 * @param {(key:string, value:string)=>void} cb
 */
function scanFieldPairs(seg, cb) {
  const tokens = seg.tokens || [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    let kv = null;
    if (t === '-f' || t === '-F' || t === '--field' || t === '--raw-field') {
      kv = tokens[i + 1];
    } else if (t.startsWith('-f') && t.length > 2) {
      kv = t.slice(2); // -fkey=value bundled
    } else if (t.startsWith('--field=')) {
      kv = t.slice('--field='.length);
    } else if (t.startsWith('--raw-field=')) {
      kv = t.slice('--raw-field='.length);
    }
    if (typeof kv !== 'string') continue;
    const eq = kv.indexOf('=');
    if (eq === -1) continue;
    cb(kv.slice(0, eq), kv.slice(eq + 1));
  }
}

/**
 * The -d/--data curl payload string, if any (scans flags then ordered tokens).
 * @param {Object} seg
 * @returns {string|null}
 */
function curlDataBody(seg) {
  const flags = seg.flags || {};
  const shortFlags = seg.shortFlags || {};
  if (typeof flags.data === 'string') return flags.data;
  if (typeof shortFlags.d === 'string') return shortFlags.d;
  const tokens = seg.tokens || [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === '-d' || tokens[i] === '--data') return tokens[i + 1] || null;
    if (tokens[i].startsWith('-d') && tokens[i].length > 2) return tokens[i].slice(2);
  }
  return null;
}

/**
 * Pull a string field out of a JSON-ish payload by key (prefers JSON.parse, falls back to a
 * tolerant regex). Returns the value or null.
 *
 * @param {string} payload
 * @param {string} key
 * @returns {string|null}
 */
function jsonField(payload, key) {
  if (typeof payload !== 'string') return null;
  try {
    const obj = JSON.parse(payload);
    if (obj && typeof obj === 'object' && typeof obj[key] === 'string') return obj[key];
  } catch (_) {
    // fall through
  }
  const re = new RegExp('"' + key + '"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"');
  const m = re.exec(payload);
  if (!m) return null;
  return m[1]
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

/**
 * Resolve the new issue TITLE across native / gh-api / curl routes. Returns the title
 * string, or '' if no title is asserted (interactive create — not a fail-closed case).
 *
 * @param {Object} seg
 * @param {string} route 'native' | 'gh-api' | 'curl'
 * @returns {string}
 */
function resolveTitle(seg, route) {
  const flags = seg.flags || {};
  const shortFlags = seg.shortFlags || {};

  if (route === 'native') {
    if (typeof flags.title === 'string') return flags.title;
    if (typeof shortFlags.t === 'string') return shortFlags.t;
    return '';
  }

  if (route === 'gh-api') {
    let title = '';
    scanFieldPairs(seg, (k, v) => {
      if (k === 'title') title = v;
    });
    return title;
  }

  // curl
  const payload = curlDataBody(seg);
  if (typeof payload === 'string') {
    const fromJson = jsonField(payload, 'title');
    if (fromJson != null) return fromJson;
  }
  return '';
}

/**
 * The pure gate decision, with all impure dependencies injected so it is unit-testable
 * without a real gsd-core checkout, `gh`, or network. Wrapped by runGate so any throw →
 * fail-closed DENY.
 *
 * @param {string} stdinString raw PreToolUse JSON on stdin
 * @param {Object} deps
 * @param {{scoreCandidates: Function, DEFAULT_THRESHOLD?: number}} deps.liveScorer LIVE export
 * @param {(seg:Object, route:string)=>Array<{number:number,title:string}>} deps.fetchOpenIssues
 *   fetches the open-issue candidates for the target repo; THROWS on an unauth/network
 *   failure (→ fail closed).
 * @returns {{permissionDecision:string, permissionDecisionReason?:string}}
 */
function gate(stdinString, deps) {
  const input = readHookInput(stdinString); // throws on malformed → fail closed
  const command = (input.tool_input && input.tool_input.command) || '';

  const parsed = parseCommand(command);
  if (!parsed.ok) {
    throw new FailClosed('unparseable command: ' + parsed.reason);
  }

  const action = classifyAction(parsed);
  if (action.failClosed) {
    throw new FailClosed('unclassifiable mutating github call — failing closed (ENF-15)');
  }
  if (action.action !== 'issue-create') {
    return allow(); // not our concern → no-op
  }

  const seg = findActionSegment(parsed);
  const route = action.route || 'native';
  const newTitle = resolveTitle(seg, route);
  if (!newTitle || !newTitle.trim()) {
    // No asserted title (interactive form) — nothing to dedupe against. Not fail-closed.
    return allow();
  }

  const candidates = deps.fetchOpenIssues(seg, route); // may throw → fail closed (HARD-01)

  const matches = deps.liveScorer.scoreCandidates(newTitle, candidates); // may throw → fail closed
  if (Array.isArray(matches) && matches.length > 0) {
    const top = matches[0];
    const pct = Math.round((top.score || 0) * 100);
    const list = matches
      .map((m) => '  #' + m.number + ' — ' + m.title + ' (' + Math.round((m.score || 0) * 100) + '%)')
      .join('\n');
    return deny(
      'Likely DUPLICATE issue blocked by the LIVE dedupe scorer (ENF-11): the new title ' +
        'closely matches open issue #' + top.number + ' (' + pct + '% similar).\n' +
        'Possible duplicates:\n' + list + '\n' +
        'Comment on the existing issue instead of filing a new one. If this is genuinely ' +
        'distinct, set GSD_CONTRIB_OVERRIDE="<reason>" to override (logged).'
    );
  }
  return allow();
}

/**
 * The default LIVE open-issue fetch: `gh issue list --state open --json number,title` for
 * the target repo, via execFileSync (no shell). The repo is taken from the segment's
 * `--repo/-R` if present, else `gh` uses the cwd's default repo. THROWS on a non-zero exit
 * or spawn failure so the gate fails closed (HARD-01).
 *
 * @param {Object} seg the issue-create segment (for an optional --repo/-R)
 * @param {string} route
 * @returns {Array<{number:number, title:string}>}
 */
function fetchOpenIssuesLive(seg, route) {
  const { execFileSync } = require('node:child_process');
  const args = ['issue', 'list', '--state', 'open', '--json', 'number,title', '--limit', '200'];

  // Honor an explicit target repo (native --repo/-R; gh-api/curl carry it in the path, which
  // gh issue list cannot reuse — fall back to the cwd default in that case).
  const flags = seg.flags || {};
  const shortFlags = seg.shortFlags || {};
  if (route === 'native') {
    const repo = typeof flags.repo === 'string' ? flags.repo
      : typeof shortFlags.R === 'string' ? shortFlags.R : null;
    if (repo) args.push('--repo', repo);
  }

  let out;
  try {
    out = execFileSync('gh', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
  } catch (err) {
    throw new FailClosed(
      'could not fetch open issues via `gh issue list` (' +
        ((err && err.message) || 'spawn/auth failure') + ') — failing closed (HARD-01); ' +
        'authenticate gh or override with GSD_CONTRIB_OVERRIDE'
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(out);
  } catch (err) {
    throw new FailClosed('could not parse `gh issue list --json` output — failing closed');
  }
  if (!Array.isArray(parsed)) {
    throw new FailClosed('`gh issue list --json` did not return an array — failing closed');
  }
  return parsed
    .filter((c) => c && typeof c.number === 'number' && typeof c.title === 'string')
    .map((c) => ({ number: c.number, title: c.title }));
}

/**
 * Injectable entry seam used by the test suite. Builds the runGate ctx (worktreeRoot for the
 * override receipt) and defaults the live scorer + the open-issue fetch from the real
 * environment when not injected.
 *
 * @param {string} stdinString raw PreToolUse JSON
 * @param {Object} [deps]
 * @returns {{permissionDecision:string, permissionDecisionReason?:string}}
 */
function runDedupeGate(stdinString, deps = {}) {
  const ctx = {
    command: safeCommand(stdinString),
    action: 'issue-dedupe',
    worktreeRoot: deps.worktreeRoot,
    overrideImpl: deps.overrideImpl,
  };

  return runGate(() => {
    const resolved = Object.assign({}, deps);
    if (!resolved.liveScorer) {
      const root = resolveGsdCoreRoot(process.cwd());
      ctx.worktreeRoot = ctx.worktreeRoot || root;
      resolved.liveScorer = requireLiveScript(root, 'scripts/issue-dedupe.cjs');
    }
    if (!resolved.fetchOpenIssues) {
      resolved.fetchOpenIssues = fetchOpenIssuesLive;
    }
    return gate(stdinString, resolved);
  }, ctx);
}

/**
 * Best-effort extract the command for the override receipt without throwing.
 * @param {string} stdinString
 * @returns {string}
 */
function safeCommand(stdinString) {
  try {
    const o = JSON.parse(stdinString);
    return (o && o.tool_input && o.tool_input.command) || '';
  } catch (_) {
    return '';
  }
}

function main() {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => {
    buf += c;
  });
  process.stdin.on('end', () => {
    emit(runDedupeGate(buf));
  });
}

if (require.main === module) {
  main();
}

module.exports = { runDedupeGate, gate, resolveTitle, findActionSegment, fetchOpenIssuesLive };
