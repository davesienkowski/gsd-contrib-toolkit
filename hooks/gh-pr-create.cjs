#!/usr/bin/env node
'use strict';

/**
 * hooks/gh-pr-create.cjs — PreToolUse(Bash) PR filing gate.
 *
 * Enforces, at the PreToolUse boundary, the four things a contribution PR must satisfy
 * BEFORE it is opened — closing the broken-PR failure class the toolkit exists for:
 *
 *   (1) ENF-02  Template: the PR body must pass gsd-core's LIVE pr-template-policy.cjs
 *               (`evaluatePrTemplate(body, authorAssociation, changedFiles) -> {valid}`).
 *   (2) ENF-10  Base: the target branch must be `allowed` per gsd-core's LIVE
 *               pr-target-policy.cjs (`classifyPrTarget(base, head) -> {decision}`).
 *               'blocked' and (conservatively) 'unusual' both DENY.
 *   (3) ENF-10  Linked issue — TOOLKIT-OWNED: the body must carry `Fixes #N` / `Closes #N`.
 *   (4) ENF-10  Branch name — TOOLKIT-OWNED: the head branch must match
 *               `^(fix|docs|feat)/\d+-`.
 *
 * IMPORTANT (red-team H-A): only the base check is a callable LIVE gsd-core script.
 * The linked-issue and branch-name policies live in gsd-core CI WORKFLOWS
 * (`require-issue-link`, `branch-naming`) — NOT callable scripts. Per HARD-02 we may
 * not pretend to "call the repo's script" for them, so the toolkit OWNS those two
 * checks, replicates the CI-workflow policy locally, and DOCUMENTS them as ours (with
 * the attendant drift risk accepted, T-03-03-OWN). The deny reasons are worded
 * accordingly — "the toolkit's own … check (a gsd-core CI-workflow policy replicated
 * here)" — never "the repo's script".
 *
 * ENF-15: the `gh api -X POST repos/.../pulls` and `curl` POST synonyms classify to the
 * same `pr-create` action and are gated identically. HARD-01/04: every path runs inside
 * runGate so an unparseable command, an unobservable stdin body, a missing/reshaped live
 * script, or an unauth gh all FAIL CLOSED (deny) — escapable only by a logged override.
 *
 * @module hooks/gh-pr-create
 */

const path = require('node:path');
const { parseCommand } = require('./lib/argv.cjs');
const { classifyAction } = require('./lib/classify.cjs');
const { runGate, readHookInput, deny, allow, emit } = require('./lib/failclosed.cjs');
const { resolveRootForCommand, requireLiveScript } = require('./lib/resolve.cjs');

class FailClosed extends Error {}

// Toolkit-OWNED policies (replicated from gsd-core CI workflows — H-A). Documented as
// ours; the deny reasons name them as the toolkit's own.
const LINKED_ISSUE_RE = /\b(?:Fixes|Closes|Resolves)\s+#\d+\b/i;
const BRANCH_NAME_RE = /^(fix|docs|feat)\/\d+-/;

const OWNED_NOTE =
  'This is the toolkit’s own check — a gsd-core CI-workflow policy ' +
  '(require-issue-link / branch-naming) replicated locally, not a callable repo script (ENF-10/H-A).';

/**
 * Normalize a `\n` sentinel (the shell-token form of a multi-line body) into real
 * newlines so the LIVE template policy — which splits on real newlines to find
 * headings — sees the intended structure. Real embedded newlines pass through.
 *
 * @param {string} s
 * @returns {string}
 */
function normalizeBody(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\\r/g, '\n');
}

/**
 * Find the segment classifyAction acted on (the first pr-create segment in a chain).
 * @param {Object} parsed
 * @returns {Object}
 */
function findActionSegment(parsed) {
  const segs = Array.isArray(parsed.segments) && parsed.segments.length > 0
    ? parsed.segments
    : [parsed];
  for (const seg of segs) {
    const r = classifyAction({ ok: true, segments: [seg] });
    if (r && r.action === 'pr-create') return seg;
  }
  return segs[0];
}

/**
 * Walk a segment's structured tokens pulling gh-api `-f/-F/--field key=value` pairs.
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
      kv = t.slice(2);
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
 * Resolve the PR BODY across native / gh-api / curl routes. Throws FailClosed when the
 * body is read from a stdin the hook cannot observe (HARD-04).
 *
 * @param {Object} seg
 * @param {string} route
 * @param {(p:string)=>(string|null)} readBodyFile
 * @returns {string}
 */
function resolveBody(seg, route, readBodyFile) {
  const flags = seg.flags || {};

  if (route === 'native') {
    if (typeof flags.body === 'string') return normalizeBody(flags.body);
    const bf = flags['body-file'];
    if (typeof bf === 'string') {
      if (bf === '-') {
        throw new FailClosed(
          'PR body is read from stdin (--body-file -), which a PreToolUse hook cannot ' +
            'observe — failing closed (HARD-04): cannot confirm the PR template'
        );
      }
      const content = readBodyFile(bf);
      if (typeof content !== 'string') {
        throw new FailClosed('could not read --body-file ' + bf + ' — failing closed');
      }
      return content;
    }
    return '';
  }

  if (route === 'gh-api') {
    let body = null;
    let stdinSentinel = false;
    scanFieldPairs(seg, (k, v) => {
      if (k !== 'body') return;
      if (v.startsWith('@')) {
        const src = v.slice(1);
        if (src === '-') stdinSentinel = true;
        else {
          const content = readBodyFile(src);
          body = typeof content === 'string' ? content : null;
        }
      } else {
        body = normalizeBody(v);
      }
    });
    if (stdinSentinel) {
      throw new FailClosed('gh api PR body is read from stdin (-F body=@-) — failing closed (HARD-04)');
    }
    return typeof body === 'string' ? body : '';
  }

  // curl
  const shortFlags = seg.shortFlags || {};
  let payload = typeof flags.data === 'string' ? flags.data : shortFlags.d;
  if (payload === '@-' || payload === '-') {
    throw new FailClosed('curl PR body is read from stdin (-d @-) — failing closed (HARD-04)');
  }
  if (typeof payload === 'string') {
    const body = jsonField(payload, 'body');
    return body == null ? normalizeBody(payload) : normalizeBody(body);
  }
  return '';
}

/**
 * Resolve the target BASE branch across routes. Native: --base/-B. gh-api: -f base=.
 * curl: JSON "base". Returns null when unresolved (caller treats conservatively).
 *
 * @param {Object} seg
 * @param {string} route
 * @returns {string|null}
 */
function resolveBase(seg, route) {
  const flags = seg.flags || {};
  const shortFlags = seg.shortFlags || {};
  if (route === 'native') {
    if (typeof flags.base === 'string') return flags.base;
    if (typeof shortFlags.B === 'string') return shortFlags.B;
    return null;
  }
  if (route === 'gh-api') {
    let base = null;
    scanFieldPairs(seg, (k, v) => {
      if (k === 'base') base = v;
    });
    return base;
  }
  // curl
  const payload = typeof flags.data === 'string' ? flags.data : shortFlags.d;
  if (typeof payload === 'string') return jsonField(payload, 'base');
  return null;
}

/**
 * Best-effort extract a string field from a JSON-ish payload. Prefers JSON.parse.
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
    /* fall through */
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
 * The pure PR gate decision with all impure deps injected.
 *
 * @param {string} stdinString raw PreToolUse JSON
 * @param {Object} deps
 * @param {{evaluatePrTemplate:Function}} deps.liveTemplate LIVE pr-template-policy export
 * @param {{classifyPrTarget:Function}} deps.liveTarget LIVE pr-target-policy export
 * @param {string} deps.branch current head branch name
 * @param {string[]} [deps.changedFiles] changed files (for the template tooling carve-out)
 * @param {string} [deps.authorAssociation] e.g. 'OWNER'
 * @param {(p:string)=>(string|null)} deps.readBodyFile
 * @returns {{permissionDecision:string, permissionDecisionReason?:string}}
 */
function gate(stdinString, deps) {
  const input = readHookInput(stdinString);
  const command = (input.tool_input && input.tool_input.command) || '';

  const parsed = parseCommand(command);
  if (!parsed.ok) throw new FailClosed('unparseable command: ' + parsed.reason);

  const action = classifyAction(parsed);
  if (action.failClosed) {
    throw new FailClosed('unclassifiable mutating github call — failing closed (ENF-15)');
  }
  if (action.action !== 'pr-create') return allow();

  const seg = findActionSegment(parsed);
  const route = action.route || 'native';

  const body = resolveBody(seg, route, deps.readBodyFile); // may throw FailClosed
  const base = resolveBase(seg, route);
  const head = deps.branch;

  // (1) ENF-02 — LIVE template policy (call, never reimplement).
  const tmpl = deps.liveTemplate.evaluatePrTemplate(
    body,
    deps.authorAssociation || 'OWNER',
    deps.changedFiles
  );
  if (!tmpl || tmpl.valid !== true) {
    return deny(
      'PR blocked by the LIVE pr-template-policy (ENF-02): ' +
        ((tmpl && tmpl.reason) || 'PR body does not match a typed PR template') +
        '. Use a fix / enhancement / feature template.'
    );
  }

  // (2) ENF-10 — LIVE base policy (call, never reimplement). Conservative: only
  // 'allowed' passes; 'blocked' and 'unusual' deny.
  if (base == null || base === '') {
    throw new FailClosed(
      'could not resolve the PR base branch — failing closed (HARD-04): cannot confirm the target is allowed'
    );
  }
  const target = deps.liveTarget.classifyPrTarget(base, head);
  if (!target || target.decision !== 'allowed') {
    return deny(
      'PR base `' +
        base +
        '` is ' +
        ((target && target.decision) || 'not allowed') +
        ' per the LIVE pr-target-policy (ENF-10). Contributions target `next`.'
    );
  }

  // (3) ENF-10 — TOOLKIT-OWNED linked-issue check (H-A).
  if (!LINKED_ISSUE_RE.test(body)) {
    return deny(
      'PR body is missing a linked issue (e.g. `Fixes #123` / `Closes #123`). ' +
        OWNED_NOTE
    );
  }

  // (4) ENF-10 — TOOLKIT-OWNED branch-name check (H-A).
  if (typeof head !== 'string' || !BRANCH_NAME_RE.test(head)) {
    return deny(
      'Head branch `' +
        String(head) +
        '` does not match the required `fix|docs|feat/<issue#>-slug` form. ' +
        OWNED_NOTE
    );
  }

  return allow();
}

/**
 * Injectable entry seam. Builds runGate ctx and defaults the LIVE script deps + the
 * current branch from the real environment when not injected.
 *
 * @param {string} stdinString raw PreToolUse JSON
 * @param {Object} [deps]
 * @returns {{permissionDecision:string, permissionDecisionReason?:string}}
 */
function runPrGate(stdinString, deps = {}) {
  const ctx = {
    command: safeCommand(stdinString),
    action: 'pr-create',
    worktreeRoot: deps.worktreeRoot,
    overrideImpl: deps.overrideImpl,
  };

  return runGate(() => {
    const resolved = Object.assign({}, deps);
    // Resolve the root from the command's OWN cwd (it may `cd` into a worktree), not the
    // session cwd. null = the command does not target a gsd-core checkout → allow. The
    // head branch is read from that same root so a cross-repo session reads the worktree's
    // branch, not the session repo's.
    let root = resolved.worktreeRoot || null;
    if (!root && (!resolved.liveTemplate || !resolved.liveTarget || !resolved.branch)) {
      root = resolveRootForCommand(ctx.command, process.cwd());
      if (!root) return allow();
    }
    ctx.worktreeRoot = ctx.worktreeRoot || root;
    if (!resolved.liveTemplate) {
      resolved.liveTemplate = requireLiveScript(root, 'scripts/pr-template-policy.cjs');
    }
    if (!resolved.liveTarget) {
      resolved.liveTarget = requireLiveScript(root, 'scripts/pr-target-policy.cjs');
    }
    if (!resolved.branch) {
      resolved.branch = currentBranch(root);
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

/**
 * Read the current git branch from HEAD. Throws (→ fail closed) if it cannot be read,
 * because a PR gate that cannot determine the head branch cannot enforce ENF-10.
 * @returns {string}
 */
function currentBranch(root) {
  const { execFileSync } = require('node:child_process');
  const opts = { encoding: 'utf8' };
  if (root) opts.cwd = root; // read the branch of the worktree the command targets
  const out = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], opts);
  return out.trim();
}

/**
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
    emit(runPrGate(buf));
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  runPrGate,
  gate,
  resolveBody,
  resolveBase,
  normalizeBody,
  LINKED_ISSUE_RE,
  BRANCH_NAME_RE,
};
