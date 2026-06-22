#!/usr/bin/env node
'use strict';

/**
 * hooks/gh-edit.cjs — PreToolUse(Bash) gh-edit→REST filing gate
 * (ENF-04 broken-edit→REST hint, ENF-15 PATCH synonym, HARD-01/04 fail-closed).
 *
 * ENF-04 targets a broken `gh issue edit` / `gh pr edit`: an edit that REWRITES a
 * policy-governed body to something that would fail the same policy the create gates
 * enforce (the issue version gate for issue bodies; the PR template policy for PR
 * bodies). Rather than silently let a contributor edit an issue/PR body into a
 * non-conforming state, this gate denies and POINTS TO THE CORRECT REST/edit FORM
 * (the `gh api -X PATCH repos/OWNER/REPO/{issues|pulls}/N` shape) so the user knows the
 * sanctioned way to make the change.
 *
 * Scope discipline (red-team H-B — avoid false-positive denies that get the toolkit
 * disabled): a BENIGN edit that does NOT rewrite a policy-governed body — a label
 * change (`--add-label`), an assignee change (`--add-assignee`), a milestone, a title
 * tweak — is ALLOWED. We only act when the edit carries a body (`--body` / `--body-file`
 * / gh-api `-f body=`), i.e. it actually rewrites the governed content.
 *
 * ENF-15: the `gh api -X PATCH repos/.../issues/N` and `.../pulls/N` synonyms classify
 * (via the shared classifier) to the same `issue-edit` / `pr-edit` action and are gated
 * identically. HARD-01/04: every path runs inside runGate, so an unparseable command, an
 * unobservable stdin body, or a missing/reshaped live script FAILS CLOSED (deny) —
 * escapable only by a logged override.
 *
 * @module hooks/gh-edit
 */

const path = require('node:path');
const { parseCommand } = require('./lib/argv.cjs');
const { classifyAction } = require('./lib/classify.cjs');
const { runGate, readHookInput, deny, allow, emit, FailClosed, safeCommand } = require('./lib/failclosed.cjs');
const { resolveRootForCommand, requireLiveScript } = require('./lib/resolve.cjs');

// FailClosed/safeCommand: shared IN-03 helpers from failclosed.cjs.

const EDIT_ACTIONS = new Set(['issue-edit', 'pr-edit']);

/**
 * Normalize a `\n` sentinel (single-quoted shell body form) into real newlines so the
 * live policies (which split on real newlines) see the intended structure.
 * @param {string} s
 * @returns {string}
 */
function normalizeBody(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\\r/g, '\n');
}

/**
 * Find the edit segment classifyAction acted on.
 * @param {Object} parsed
 * @returns {{seg:Object, action:string, route:string}|null}
 */
function findEditSegment(parsed) {
  const segs = Array.isArray(parsed.segments) && parsed.segments.length > 0
    ? parsed.segments
    : [parsed];
  for (const seg of segs) {
    const r = classifyAction({ ok: true, segments: [seg] });
    if (r && EDIT_ACTIONS.has(r.action)) {
      return { seg, action: r.action, route: r.route || 'native' };
    }
  }
  return null;
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
 * Determine whether an edit segment carries a BODY rewrite, and resolve that body.
 * Returns { hasBody:boolean, body?:string }. Throws FailClosed for an unobservable
 * stdin body (HARD-04) — an edit we cannot evaluate must not be allowed through.
 *
 * @param {Object} seg
 * @param {string} route
 * @param {(p:string)=>(string|null)} readBodyFile
 * @returns {{hasBody:boolean, body?:string}}
 */
function resolveEditBody(seg, route, readBodyFile) {
  const flags = seg.flags || {};

  if (route === 'native') {
    if (typeof flags.body === 'string') return { hasBody: true, body: normalizeBody(flags.body) };
    const bf = flags['body-file'];
    if (typeof bf === 'string') {
      if (bf === '-') {
        throw new FailClosed(
          'edit body is read from stdin (--body-file -) — failing closed (HARD-04): ' +
            'cannot confirm the rewritten body conforms'
        );
      }
      const content = readBodyFile(bf);
      if (typeof content !== 'string') {
        throw new FailClosed('could not read --body-file ' + bf + ' — failing closed');
      }
      return { hasBody: true, body: content };
    }
    return { hasBody: false }; // label/assignee/title-only edit → benign, allow
  }

  // gh-api PATCH
  let body = null;
  let hasBody = false;
  let stdinSentinel = false;
  scanFieldPairs(seg, (k, v) => {
    if (k !== 'body') return;
    hasBody = true;
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
  if (!hasBody) return { hasBody: false };
  if (stdinSentinel) {
    throw new FailClosed('gh api edit body is read from stdin (-F body=@-) — failing closed (HARD-04)');
  }
  if (typeof body !== 'string') {
    throw new FailClosed('could not resolve gh api edit body — failing closed');
  }
  return { hasBody: true, body };
}

/**
 * Resolve labels for an issue edit (so the version gate's bug-detection works).
 * @param {Object} seg
 * @param {string} route
 * @returns {string[]}
 */
function resolveLabels(seg, route) {
  const labels = [];
  const push = (v) => {
    if (typeof v !== 'string') return;
    for (const part of v.split(',')) {
      const t = part.trim();
      if (t) labels.push(t);
    }
  };
  if (route === 'native') {
    const flags = seg.flags || {};
    const shortFlags = seg.shortFlags || {};
    push(flags.label);
    push(flags['add-label']);
    push(shortFlags.l);
  } else {
    scanFieldPairs(seg, (k, v) => {
      if (k === 'labels' || k === 'label') push(v);
    });
  }
  return labels;
}

/**
 * The REST/edit form hint ENF-04 requires — point the user to the sanctioned way to
 * make the change.
 * @param {string} action 'issue-edit'|'pr-edit'
 * @returns {string}
 */
function restHint(action) {
  const resource = action === 'pr-edit' ? 'pulls' : 'issues';
  return (
    'To edit it the sanctioned way, use the REST form: ' +
    '`gh api -X PATCH repos/OWNER/REPO/' +
    resource +
    '/N -f body=<conforming-body>` (ENF-04) — with a body that satisfies the policy below.'
  );
}

/**
 * The pure edit gate decision with impure deps injected.
 *
 * @param {string} stdinString raw PreToolUse JSON
 * @param {Object} deps
 * @param {{evaluateVersionGate:Function}} deps.liveVersionGate LIVE issue-version-gate export
 * @param {{evaluatePrTemplate:Function}} deps.liveTemplate LIVE pr-template-policy export
 * @param {string[]} [deps.changedFiles]
 * @param {string} [deps.authorAssociation]
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
  if (!EDIT_ACTIONS.has(action.action)) return allow(); // not an edit → not our concern

  const found = findEditSegment(parsed);
  if (!found) return allow();
  const { seg, action: editAction, route } = found;

  const { hasBody, body } = resolveEditBody(seg, route, deps.readBodyFile); // may throw
  if (!hasBody) {
    // Label/assignee/title/milestone-only edit — benign, do not over-block (H-B).
    return allow();
  }

  if (editAction === 'issue-edit') {
    const labels = resolveLabels(seg, route);
    const verdict = deps.liveVersionGate.evaluateVersionGate({ labels, body }); // may throw
    if (verdict && verdict.action === 'close') {
      return deny(
        'This issue edit would set a body that fails the LIVE issue-version-gate (' +
          (verdict.reason || 'version') +
          '): a bug report needs a valid GSD Version under `### GSD Version`. ' +
          restHint('issue-edit')
      );
    }
    return allow();
  }

  // pr-edit
  const tmpl = deps.liveTemplate.evaluatePrTemplate(
    body,
    deps.authorAssociation || 'OWNER',
    deps.changedFiles
  ); // may throw
  if (!tmpl || tmpl.valid !== true) {
    return deny(
      'This PR edit would set a body that fails the LIVE pr-template-policy: ' +
        ((tmpl && tmpl.reason) || 'the body does not match a typed PR template') +
        '. ' +
        restHint('pr-edit')
    );
  }
  return allow();
}

/**
 * Injectable entry seam. Defaults the LIVE script deps from the real environment.
 * @param {string} stdinString raw PreToolUse JSON
 * @param {Object} [deps]
 * @returns {{permissionDecision:string, permissionDecisionReason?:string}}
 */
function runEditGate(stdinString, deps = {}) {
  const ctx = {
    command: safeCommand(stdinString),
    action: 'gh-edit',
    worktreeRoot: deps.worktreeRoot,
    overrideImpl: deps.overrideImpl,
  };

  return runGate(() => {
    const resolved = Object.assign({}, deps);
    // Resolve from the command's own cwd (may `cd` into a worktree); null = not a
    // gsd-core checkout → allow (not our concern).
    let root = resolved.worktreeRoot || null;
    if (!root && (!resolved.liveVersionGate || !resolved.liveTemplate)) {
      root = resolveRootForCommand(ctx.command, process.cwd());
      if (!root) return allow();
      ctx.worktreeRoot = ctx.worktreeRoot || root;
    }
    if (!resolved.liveVersionGate) {
      resolved.liveVersionGate = requireLiveScript(root, 'scripts/issue-version-gate.cjs');
    }
    if (!resolved.liveTemplate) {
      resolved.liveTemplate = requireLiveScript(root, 'scripts/pr-template-policy.cjs');
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


function main() {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => {
    buf += c;
  });
  process.stdin.on('end', () => {
    emit(runEditGate(buf));
  });
}

if (require.main === module) {
  main();
}

module.exports = { runEditGate, gate, resolveEditBody, findEditSegment, restHint, normalizeBody };
