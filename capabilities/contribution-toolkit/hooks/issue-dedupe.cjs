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
 * TWO SIGNALS, TWO SEVERITIES (260729-p3f):
 *
 *   1. TITLE similarity — the LIVE scoreCandidates, unchanged, still the only thing that can
 *      DENY. Measured at 0.00% false positives over 3570 open non-duplicate pairs: precise,
 *      not broken. It reliably catches the byte-identical class (#2739-#2748: six-plus
 *      identical titles filed within twelve minutes, all closed DUPLICATE). Do not widen it.
 *
 *   2. CODE-CITATION overlap — toolkit-owned, and only ever an `ask`. Two issues citing the
 *      same RARE code paths are plausibly the same defect even when their titles share no
 *      words, which is precisely the class signal 1 cannot see. But it is measured at recall
 *      2/9 with ~0.048 prompts per filing, so it is an advisory POINTER, never a block. See
 *      RARE_DF_MAX for the full measurement and the rejected alternatives.
 *
 * Signal 2 is a deliberate, recordable DIVERGENCE from strict reuse-LIVE (CTK-ADR-0001 §3):
 * gsd-core has no equivalent check, so this gate will prompt about pairs gsd-core's CI would
 * not flag. It is additive, not a reimplementation — gsd-core's similarity math remains
 * untouched and remains the sole authority for the deny. This wants its own CTK-ADR.
 *
 * Signal 2 also fails OPEN while the rest of the gate fails CLOSED. That asymmetry is
 * intentional and is explained at citationAdvisoryReason.
 *
 * @module hooks/issue-dedupe
 */

const { parseCommand } = require('./lib/argv.cjs');
const { classifyAction, findActionSegment, isNonGovernedCommand } = require('./lib/classify.cjs');
const { runGate, readHookInput, deny, allow, ask, emit, FailClosed, safeCommand } = require('./lib/failclosed.cjs');
const { resolveRootForCommand, requireLiveScript } = require('./lib/resolve.cjs');

// FailClosed/safeCommand: shared IN-03 helpers from failclosed.cjs.


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
 * Resolve the new issue BODY across native / gh-api / curl routes, for the citation
 * advisory ONLY. Returns the body string, or '' when there is none.
 *
 * Deliberately NOT the same function as gh-issue-create.cjs's `resolveBody`: that one throws
 * FailClosed when the body lives on an unobservable stdin, because THAT gate must not allow a
 * body it cannot inspect. Here the body is wanted for an ADVISORY, so an unavailable body is
 * simply "no advisory" (C2) — never a deny. A read failure throws and is swallowed by the
 * caller's try/catch. This version also honors `-b`, which the sibling does not.
 *
 * @param {Object} seg
 * @param {string} route 'native' | 'gh-api' | 'curl'
 * @returns {string} the body, or '' when absent/unavailable
 */
function resolveBodyForAdvisory(seg, route) {
  const flags = seg.flags || {};
  const shortFlags = seg.shortFlags || {};

  if (route === 'native') {
    if (typeof flags.body === 'string') return flags.body;
    if (typeof shortFlags.b === 'string') return shortFlags.b;
    const bf = flags['body-file'];
    if (typeof bf === 'string' && bf !== '-') {
      // May throw (missing/unreadable file) → caught upstream → no advisory, NOT a deny.
      return require('node:fs').readFileSync(bf, 'utf8');
    }
    return '';
  }

  if (route === 'gh-api') {
    let body = '';
    scanFieldPairs(seg, (k, v) => {
      if (k !== 'body') return;
      if (v.startsWith('@')) {
        const src = v.slice(1);
        if (src !== '-') body = require('node:fs').readFileSync(src, 'utf8');
      } else {
        body = v;
      }
    });
    return body;
  }

  // curl
  const payload = curlDataBody(seg);
  if (typeof payload === 'string' && !payload.startsWith('@')) {
    const fromJson = jsonField(payload, 'body');
    return fromJson == null ? payload : fromJson;
  }
  return '';
}

/**
 * The cited-code-path matcher.
 *
 * PROVENANCE: copied VERBATIM from the measurement scripts —
 * `.planning/notes/2026-07-28-sweep-and-toolkit-analysis/dup-fpr.cjs:11` (and the identical
 * literal in the full sweep, `scratchpad/dedupe-threshold-sweep.cjs`). Do NOT "improve" it:
 * the recall/false-positive-rate numbers that justify the thresholds below were measured with
 * EXACTLY this pattern over the real gsd-core tracker. Widening or narrowing it invalidates
 * them, and the thresholds would then be guesses again.
 */
const PATH_RE = /\b(?:src|tests|scripts|bin|hooks|docs|agents|commands|gsd-core|get-shit-done|\.github)\/[A-Za-z0-9_\-.\/]+?\.(?:cts|cjs|mjs|js|ts|md|json|ya?ml|sh)\b/g;

/**
 * A path counts as RARE when at most this many issues cite it. Two issues citing
 * `bin/install.js` is noise; two issues citing the same obscure module is a signal.
 *
 * MEASURED (do not tune by intuition — re-run the sweep):
 *   sweep script : scratchpad/dedupe-threshold-sweep.cjs
 *   corpus       : 117 open issues (85 citing >=1 path), 3570 open non-duplicate pairs,
 *                  9 "reworded" duplicates (title-dice < 0.6, i.e. invisible to the deny)
 *   rule shipped : rare(df<=2) >= 2  →  recall 2/9, pair-FPR 0.06%, 0.048 fires per filing
 *
 * Rejected alternatives, with the numbers that rejected them:
 *   sharedPaths >= 1  recall 5/9 but 4.238 fires/filing — fires on essentially every filing
 *   sharedPaths >= 2  recall 3/9 at 0.595 fires/filing — a prompt every ~2 filings
 *   jaccard >= 0.15   recall 4/9 at 1.333 fires/filing
 *   rare(df<=1)       a STRUCTURAL ARTIFACT, never ship it: the df corpus is built from OPEN
 *                     issues only, so any path shared by two open issues has df>=2 BY
 *                     CONSTRUCTION and df<=1 therefore cannot fire on a false positive. Its
 *                     0.00% is a floor, not a measurement.
 *
 * The negative result matters as much as the shipped rule: NO threshold reached recall >= 3/9
 * at acceptable noise. This advisory is an improvement on today's 0/9 for reworded
 * duplicates, not a solution to them.
 */
const RARE_DF_MAX = 2;

/** How many rare paths two issues must SHARE before the advisory fires. See RARE_DF_MAX. */
const MIN_SHARED_RARE = 2;

/**
 * Extract the set of cited code paths from an issue body.
 *
 * Mirrors the measurement's `cites()` helper exactly, including the trailing-punctuation
 * strip (`docs/foo.md).` → `docs/foo.md`) — prose cites paths mid-sentence.
 *
 * @param {*} body an issue body (anything non-string is treated as no citations)
 * @returns {Set<string>}
 */
function extractCitedPaths(body) {
  const found = new Set();
  const text = typeof body === 'string' ? body : '';
  if (text === '') return found;
  for (const m of text.matchAll(PATH_RE)) {
    found.add(m[0].replace(/[.,)]+$/, ''));
  }
  return found;
}

/**
 * Document frequency: for each cited path, how many issues in the corpus cite it.
 *
 * @param {Array<{body?: string}>} candidates the fetched open-issue corpus
 * @param {(body:*)=>Set<string>} extract the path extractor (injectable for tests)
 * @returns {Map<string, number>}
 */
function computeDocFrequency(candidates, extract) {
  const df = new Map();
  for (const c of candidates) {
    for (const p of extract(c && c.body)) {
      df.set(p, (df.get(p) || 0) + 1);
    }
  }
  return df;
}

/**
 * Find the best candidate sharing >= MIN_SHARED_RARE rare cited paths with the new body.
 *
 * The unfiled issue's OWN citations are counted into the document frequency (+1 for a path it
 * cites). That is not a detail — it reproduces the semantics the sweep measured, where BOTH
 * members of a scored pair were inside the df corpus. Without the +1, a path cited by the
 * candidate and one other open issue would read as df 2 ("rare") when the measured rule saw
 * it as df 3 ("common") and did not fire. Omitting it would make the gate noisier than the
 * 0.048 fires/filing that justified shipping it.
 *
 * @param {string} newBody the unfiled issue's body
 * @param {Array<{number:number,title:string,body?:string}>} candidates open-issue corpus
 * @param {{extractCitedPaths?: Function}} [deps] injectable extractor seam
 * @returns {{number:number, title:string, sharedRare:string[]}|null} null = no advisory
 */
function findCitationOverlap(newBody, candidates, deps = {}) {
  const extract = deps.extractCitedPaths || extractCitedPaths;
  const newPaths = extract(newBody);
  if (newPaths.size === 0) return null;

  const df = computeDocFrequency(candidates, extract);
  const dfWithNew = (p) => (df.get(p) || 0) + (newPaths.has(p) ? 1 : 0);

  let best = null;
  for (const c of candidates) {
    if (!c || typeof c.number !== 'number') continue;
    const shared = [...extract(c.body)].filter((p) => newPaths.has(p));
    const sharedRare = shared.filter((p) => dfWithNew(p) <= RARE_DF_MAX).sort();
    if (sharedRare.length < MIN_SHARED_RARE) continue;
    // Most overlapping rare paths wins; ties resolve to the lower issue number (stable).
    if (
      !best ||
      sharedRare.length > best.sharedRare.length ||
      (sharedRare.length === best.sharedRare.length && c.number < best.number)
    ) {
      best = { number: c.number, title: String(c.title == null ? '' : c.title), sharedRare };
    }
  }
  return best;
}

/**
 * Build the advisory ASK reason, or null when nothing fires.
 *
 * TOTALLY fail-OPEN (C2). Every step — body resolution, file reads, path extraction, the df
 * arithmetic — happens inside this try/catch, and ANY failure yields null, i.e. "no advisory",
 * leaving the LIVE title-dice verdict as the decision. The rest of ENF-11 is fail-CLOSED and
 * stays that way (a failed FETCH still denies, HARD-01), but an ADVISORY that can fail closed
 * would be a whole-suite outage risk in exchange for a 2/9 signal. That trade is not worth
 * taking; L3 already records what one gate's misfire costs.
 *
 * @param {Object} seg the issue-create segment
 * @param {string} route
 * @param {Array<{number:number,title:string,body?:string}>} candidates
 * @param {Object} deps
 * @returns {string|null} the ask reason, or null for no advisory
 */
function citationAdvisoryReason(seg, route, candidates, deps) {
  try {
    if (!Array.isArray(candidates) || candidates.length === 0) return null;
    const newBody = resolveBodyForAdvisory(seg, route);
    if (typeof newBody !== 'string' || newBody.trim() === '') return null;

    const hit = findCitationOverlap(newBody, candidates, deps);
    if (!hit) return null;

    return (
      'POSSIBLE duplicate — code-citation overlap (ENF-11 advisory, not a block): the new ' +
      'issue and open issue #' + hit.number + ' cite the same ' + hit.sharedRare.length +
      ' rarely-referenced code paths, which often means they are about the same defect even ' +
      'when the titles share no words.\n' +
      '  #' + hit.number + ' — ' + hit.title + '\n' +
      '  shared rare paths: ' + hit.sharedRare.join(', ') + '\n' +
      'Read #' + hit.number + ' first. If it is the same problem, comment there instead. If ' +
      'it is genuinely distinct, proceed — this is a prompt, not a gate.\n' +
      '(Signal strength is modest by measurement: it catches 2 of 9 known reworded ' +
      'duplicates and fires on roughly 1 in 20 filings. Treat it as a pointer, not a verdict.)'
    );
  } catch (_) {
    // C2: fail OPEN. No advisory; the title-dice verdict stands.
    return null;
  }
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

  const seg = findActionSegment(parsed, 'issue-create');
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

  // ORDER IS LOAD-BEARING: we are only here because the LIVE title-dice scorer produced NO
  // deny. A deny is never reconsidered, so it can never be downgraded to an advisory ask.
  // The citation advisory is strictly a second chance to notice a duplicate the title
  // similarity missed — at a lower severity, because its precision is lower.
  const advisory = citationAdvisoryReason(seg, route, candidates, deps);
  if (advisory) return ask(advisory);

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
  // `body` rides the SAME call the gate already made — no extra round trip, and therefore no
  // new failure mode for the fetch. Measured marginal cost +161 ms (1.161 s → 1.322 s over
  // 117 open issues / 620 KB). It feeds the citation advisory only.
  const args = ['issue', 'list', '--state', 'open', '--json', 'number,title,body', '--limit', '200'];

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
    // A missing or non-string body normalizes to '' — it must never make the map throw, and
    // the LIVE scoreCandidates ignores the extra field (it scores titles only).
    .map((c) => ({
      number: c.number,
      title: c.title,
      body: typeof c.body === 'string' ? c.body : '',
    }));
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
    // OBS-02: read ONLY for session/tool ids in the verdict log; never logged verbatim.
    stdin: stdinString,
    worktreeRoot: deps.worktreeRoot,
    overrideImpl: deps.overrideImpl,
  };

  return runGate(() => {
    // RES-01 action-first short-circuit: classify the governed action (pure
    // parse→classify, NO filesystem) BEFORE resolveRootForCommand/requireLiveScript, so a
    // confidently non-governed command allows without loading the LIVE dedupe scorer (no
    // collateral deny when that script is missing). Governed create (HARD-02), unparseable
    // (HARD-04), and ENF-15 synonyms all return false here and fall through unchanged.
    if (isNonGovernedCommand(parseCommand(ctx.command), ['issue-create'])) {
      return allow();
    }

    const resolved = Object.assign({}, deps);
    if (!resolved.liveScorer) {
      const root = resolved.worktreeRoot || resolveRootForCommand(ctx.command, process.cwd());
      if (!root) return allow();
      ctx.worktreeRoot = ctx.worktreeRoot || root;
      resolved.liveScorer = requireLiveScript(root, 'scripts/issue-dedupe.cjs');
    }
    if (!resolved.fetchOpenIssues) {
      resolved.fetchOpenIssues = fetchOpenIssuesLive;
    }
    return gate(stdinString, resolved);
  }, ctx);
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

module.exports = {
  runDedupeGate,
  gate,
  resolveTitle,
  findActionSegment,
  fetchOpenIssuesLive,
  // citation advisory (260729-p3f)
  resolveBodyForAdvisory,
  extractCitedPaths,
  computeDocFrequency,
  findCitationOverlap,
  citationAdvisoryReason,
  PATH_RE,
  RARE_DF_MAX,
  MIN_SHARED_RARE,
};
