#!/usr/bin/env node
'use strict';

/**
 * hooks/gh-issue-create.cjs — PreToolUse(Bash) issue-version filing gate
 * (ENF-01, ENF-15 synonym coverage, HARD-01 fail-closed, HARD-04 robust-parse).
 *
 * The threat: a deadline-pressured (or AI) contributor files a bug-report issue with
 * a missing/invalid GSD Version. GitHub Issue Forms only enforce the version field in
 * the WEB form — `gh issue create`, the REST API (`gh api -X POST .../issues`), and
 * `curl` to api.github.com all walk around it. gsd-core's CI auto-closes such issues
 * AFTER the fact; this gate stops the bad filing at the PreToolUse boundary, BEFORE it
 * is created — and it does so identically for the native verb AND its synonym routes.
 *
 * Architecture (inherited from Waves 1-2, never re-implemented here):
 *   - argv.parseCommand        → robust char-by-char parse, fail-closed on unparseable
 *   - classify.classifyAction  → native `gh issue create` AND `gh api`/`curl` POST issues
 *                                synonyms map to the SAME action:'issue-create' (ENF-15)
 *   - resolve.requireLiveScript→ require() the LIVE issue-version-gate.cjs (no reimpl)
 *   - failclosed.runGate       → a thrown error DENIES; only a logged override allows
 *
 * Body resolution (the part this gate owns):
 *   --body / --body=…          → inline
 *   --body-file <path>         → read the file from disk and evaluate it
 *   --body-file -              → body arrives on the tool's STDIN, which a PreToolUse
 *                                hook CANNOT observe → fail closed DENY (HARD-04): we
 *                                will not allow-with-an-empty-body and let a bad issue
 *                                slip past unevaluated.
 *   gh api -f body=… / -F body=@path → field value (or @file read from disk)
 *   curl -d '{"body":…}'       → JSON request body
 *
 * The version gate only treats a `bug`-labeled issue (or a fully UNLABELED issue whose
 * body carries the `### GSD Version` heading) as a bug report — exactly the live
 * `evaluateVersionGate` contract; we pass through labels + body and honor its verdict.
 *
 * @module hooks/gh-issue-create
 */

const path = require('node:path');
const { parseCommand } = require('./lib/argv.cjs');
const { classifyAction, findActionSegment } = require('./lib/classify.cjs');
const { runGate, readHookInput, deny, allow, emit, FailClosed, safeCommand } = require('./lib/failclosed.cjs');
const { resolveRootForCommand, requireLiveScript } = require('./lib/resolve.cjs');

// FailClosed/safeCommand: shared IN-03 helpers from failclosed.cjs.


/**
 * Resolve the LABELS for the issue from a parsed segment, across all routes.
 *   native: --label/-l (repeatable; argv keeps the last, which is acceptable for the
 *           gate's bug-detection — a `bug` label anywhere makes it a bug report)
 *   gh api: -f labels=bug / -f label=bug
 *   curl  : labels inside the JSON -d body (best-effort)
 *
 * @param {Object} seg
 * @returns {string[]}
 */
function resolveLabels(seg) {
  const labels = [];
  const flags = seg.flags || {};
  const shortFlags = seg.shortFlags || {};

  const push = (v) => {
    if (typeof v !== 'string') return;
    for (const part of v.split(',')) {
      const t = part.trim();
      if (t) labels.push(t);
    }
  };

  push(flags.label);
  push(shortFlags.l);
  // gh api -f labels=bug / -f label=bug land in flags as f? No — `-f` is a short flag
  // whose VALUE is `labels=bug`. argv records repeated `-f` as the last; to be robust
  // we also scan the raw tokens for `-f`/`--field` key=value pairs below.
  scanFieldPairs(seg, (k, v) => {
    if (k === 'labels' || k === 'label') push(v);
  });

  return labels;
}

/**
 * Walk a segment's token list pulling out `-f key=value` / `-F key=value` /
 * `--field key=value` / `--raw-field key=value` pairs (gh api field syntax) and
 * `-d`/`--data` curl bodies. Calls cb(key, value) for each gh-api field pair.
 *
 * gh api fields can repeat, which argv's flag map collapses — so for fields we read
 * the ordered tokens directly (still the STRUCTURED token list from argv, never the
 * raw string: HARD-04 is preserved).
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
 * Extract a curl JSON request body's value for a key (best-effort, no JSON.parse on
 * possibly-partial data — we look for "key":"…"). Returns the raw -d/--data string if
 * key is null.
 *
 * @param {Object} seg
 * @returns {string|null} the -d/--data payload, or null
 */
function curlDataBody(seg) {
  const flags = seg.flags || {};
  const shortFlags = seg.shortFlags || {};
  if (typeof flags.data === 'string') return flags.data;
  if (typeof shortFlags.d === 'string') return shortFlags.d;
  // scan tokens for -d <value>
  const tokens = seg.tokens || [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === '-d' || tokens[i] === '--data') return tokens[i + 1] || null;
    if (tokens[i].startsWith('-d') && tokens[i].length > 2) return tokens[i].slice(2);
  }
  return null;
}

/**
 * Pull a string field out of a JSON-ish payload by key, tolerant of escaping. Returns
 * the unescaped value or null. Prefers a real JSON.parse; falls back to a regex for
 * partial/best-effort extraction.
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
    // fall through to regex
  }
  const re = new RegExp('"' + key + '"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"');
  const m = re.exec(payload);
  if (!m) return null;
  // Unescape common JSON escapes so `\\n` becomes a real newline for the gate.
  return m[1]
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

/**
 * Resolve the issue BODY across native / gh-api / curl routes. Returns the body
 * string. THROWS FailClosed when the body lives on a stdin the hook cannot observe
 * (`--body-file -`, gh api `-F body=@-`) — we will not allow an unevaluable body.
 *
 * @param {Object} seg
 * @param {string} route 'native' | 'gh-api' | 'curl'
 * @param {(p:string)=>(string|null)} readBodyFile reads a body file from disk
 * @returns {string} the resolved body (possibly '')
 */
function resolveBody(seg, route, readBodyFile) {
  const flags = seg.flags || {};

  if (route === 'native') {
    if (typeof flags.body === 'string') return flags.body;
    const bf = flags['body-file'];
    if (typeof bf === 'string') {
      if (bf === '-') {
        throw new FailClosed(
          'issue body is read from stdin (--body-file -), which a PreToolUse hook cannot ' +
            'observe — failing closed (HARD-04): cannot confirm the GSD Version is present'
        );
      }
      const content = readBodyFile(bf);
      if (typeof content !== 'string') {
        throw new FailClosed('could not read --body-file ' + bf + ' — failing closed');
      }
      return content;
    }
    // No body flag at all → empty body (the version gate will treat an unlabeled
    // empty body as not-a-bug → skip; a bug-labeled empty body → close).
    return '';
  }

  if (route === 'gh-api') {
    let body = null;
    let stdinSentinel = false;
    scanFieldPairs(seg, (k, v) => {
      if (k !== 'body') return;
      // -F body=@path reads a file; -F body=@- reads stdin.
      if (v.startsWith('@')) {
        const src = v.slice(1);
        if (src === '-') {
          stdinSentinel = true;
        } else {
          const content = readBodyFile(src);
          body = typeof content === 'string' ? content : null;
        }
      } else {
        body = v;
      }
    });
    if (stdinSentinel) {
      throw new FailClosed(
        'gh api body is read from stdin (-F body=@-) — failing closed (HARD-04)'
      );
    }
    return typeof body === 'string' ? body : '';
  }

  // curl
  const payload = curlDataBody(seg);
  if (payload === '@-' || payload === '-') {
    throw new FailClosed('curl body is read from stdin (-d @-) — failing closed (HARD-04)');
  }
  if (typeof payload === 'string' && payload.startsWith('@')) {
    const content = readBodyFile(payload.slice(1));
    if (typeof content !== 'string') {
      throw new FailClosed('could not read curl --data file — failing closed');
    }
    const fromFile = jsonField(content, 'body');
    return fromFile == null ? content : fromFile;
  }
  if (typeof payload === 'string') {
    const fromJson = jsonField(payload, 'body');
    return fromJson == null ? payload : fromJson;
  }
  return '';
}

/**
 * For the gh-api / curl routes, also pull labels out of the JSON / fields so the
 * version gate's bug-detection sees them.
 *
 * @param {Object} seg
 * @param {string} route
 * @returns {string[]}
 */
function resolveLabelsForRoute(seg, route) {
  if (route === 'native' || route === 'gh-api') return resolveLabels(seg);
  // curl: labels live in the JSON body as an array.
  const payload = curlDataBody(seg);
  const labels = [];
  if (typeof payload === 'string') {
    try {
      const obj = JSON.parse(payload);
      if (obj && Array.isArray(obj.labels)) {
        for (const l of obj.labels) if (typeof l === 'string') labels.push(l);
      }
    } catch (_) {
      const m = /"labels"\s*:\s*\[([^\]]*)\]/.exec(payload);
      if (m) {
        for (const part of m[1].split(',')) {
          const t = part.replace(/["'\s]/g, '');
          if (t) labels.push(t);
        }
      }
    }
  }
  return labels;
}

/**
 * The pure gate decision, with all impure dependencies injected (deps) so it is unit
 * testable without a real gsd-core checkout, filesystem, or process.env. Wrapped by
 * runGate at the module entry so any throw → fail-closed DENY.
 *
 * @param {string} stdinString raw PreToolUse JSON on stdin
 * @param {Object} deps
 * @param {{evaluateVersionGate: Function}} deps.liveVersionGate the LIVE script export
 * @param {(p:string)=>(string|null)} deps.readBodyFile reads a body file from disk
 * @returns {{permissionDecision:string, permissionDecisionReason?:string}}
 */
function gate(stdinString, deps) {
  const input = readHookInput(stdinString); // throws on malformed → fail closed
  const command = (input.tool_input && input.tool_input.command) || '';

  const parsed = parseCommand(command);
  if (!parsed.ok) {
    // Unparseable → cannot confidently classify → fail closed (HARD-04).
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
  const body = resolveBody(seg, route, deps.readBodyFile); // may throw FailClosed
  const labels = resolveLabelsForRoute(seg, route);

  const verdict = deps.liveVersionGate.evaluateVersionGate({ labels, body }); // may throw
  if (verdict && verdict.action === 'close') {
    return deny(
      'Issue blocked by the LIVE issue-version-gate (' +
        (verdict.reason || 'version') +
        '): a bug report must include a valid GSD Version (e.g. `1.18.0`) under a ' +
        '`### GSD Version` heading. Add the version, or apply the `version-exempt` label.'
    );
  }
  return allow();
}

/**
 * Injectable entry seam used by the test suite. Builds the runGate ctx (worktreeRoot
 * for the override receipt) and the live-gate dependency, defaulting to the REAL live
 * script resolved from cwd when not injected.
 *
 * @param {string} stdinString raw PreToolUse JSON
 * @param {Object} [deps]
 * @returns {{permissionDecision:string, permissionDecisionReason?:string}}
 */
function runIssueGate(stdinString, deps = {}) {
  // Lazily resolve the live script + worktree root only if not injected, so the unit
  // suite stays hermetic and a resolver failure still surfaces as a fail-closed deny.
  const ctx = {
    command: safeCommand(stdinString),
    action: 'issue-create',
    worktreeRoot: deps.worktreeRoot,
    overrideImpl: deps.overrideImpl,
  };

  return runGate(() => {
    const resolved = Object.assign({}, deps);
    if (!resolved.liveVersionGate) {
      const root = resolved.worktreeRoot || resolveRootForCommand(ctx.command, process.cwd());
      if (!root) return allow();
      ctx.worktreeRoot = ctx.worktreeRoot || root;
      resolved.liveVersionGate = requireLiveScript(root, 'scripts/issue-version-gate.cjs');
    }
    if (!resolved.readBodyFile) {
      const fs = require('node:fs');
      resolved.readBodyFile = (p) => {
        try {
          return fs.readFileSync(path.resolve(p), 'utf8');
        } catch (_) {
          return null;
        }
      };
    }
    return gate(stdinString, resolved);
  }, ctx);
}


// CLI entry: read stdin, run the gate, emit the PreToolUse decision envelope.
function main() {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => {
    buf += c;
  });
  process.stdin.on('end', () => {
    emit(runIssueGate(buf));
  });
}

if (require.main === module) {
  main();
}

module.exports = { runIssueGate, gate, resolveBody, resolveLabelsForRoute, findActionSegment };
