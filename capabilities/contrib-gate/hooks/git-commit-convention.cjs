#!/usr/bin/env node
'use strict';

/**
 * hooks/git-commit-convention.cjs — PreToolUse(Bash) conventional-commit PREFIX gate
 * (ENF-16, HARD-01 fail-closed, HARD-04 robust-parse).
 *
 * The threat: a deadline-pressured (or AI) contributor commits a test fix mislabeled
 * `docs:` (or a commit with no recognized type at all). The prefix is NOT a style nit
 * in gsd-core: the release / hotfix cherry-pick filter BUCKETS on the conventional-commit
 * prefix, so a wrong-or-missing prefix routes a change into the wrong release lane. This
 * gate stops the obviously-malformed prefix at the PreToolUse boundary, BEFORE the commit
 * is created. (N7 gap — prefix-correctness matters beyond style.)
 *
 * SCOPE (deliberately narrow): this gate judges only the obvious-violation PREFIX SHAPE —
 * a recognized type immediately followed by an optional `(scope)`, optional `!`, then `:`.
 * It does NOT judge whether the chosen type is the SEMANTICALLY correct one for the diff
 * (a `docs:` that should be `test:` passes the shape check) — that semantic judgment is
 * out of scope and belongs to human/CI review. The obvious-violation class this gate
 * DENIES is: a recognized type NOT immediately followed by `(`/`!`/`:`, OR no recognized
 * type prefix at all.
 *
 * HARD-02 / TOOLKIT-OWNED (read OWNED_NOTE below): gsd-core exposes NO reusable shared
 * conventional-commit / type-validation matcher today (#1549). `classifyTitle` in
 * scripts/release-notes/format-github-release-notes.cjs only buckets feat/fix → categories
 * and cannot judge a docs/test mislabel; the discord-release-summary strip-regex is a
 * private formatting helper, not an exported policy matcher. Per HARD-02 we may NOT pretend
 * to "call the repo's script" for a matcher that does not exist. So the toolkit OWNS this
 * obvious-prefix check, replicates gsd-core's release/cherry-pick prefix POLICY locally,
 * names it as ours in the deny reason, and is MANDATED to repoint at the LIVE shared
 * matcher (via requireLiveScript + a doctor shape-check) once gsd-core extracts one (#1549)
 * — exactly the LINKED_ISSUE_RE / BRANCH_NAME_RE H-A pattern in gh-pr-create.cjs. The
 * recognized-type set is DECLARED in this file (no fenced block copied from gsd-core).
 *
 * Architecture (inherited from Waves 1-2, never re-implemented here):
 *   - argv.parseCommand        → robust char-by-char parse, fail-closed on unparseable
 *   - classify.classifyAction  → `git commit` (and equivalent forms) → action:'commit'
 *   - failclosed.runGate       → a thrown error DENIES; only a logged override allows
 *   - resolve.resolveGsdCoreRoot→ a commit OUTSIDE a gsd-core checkout is not our concern
 *
 * Message resolution (the part this gate owns):
 *   -m / --message <subject>   → the FIRST -m/--message is the subject line (repeated -m
 *                                are body paragraphs; we judge the subject only)
 *   --message=<subject>        → inline form
 *   -F / --file <path>         → read the file from disk (subject = first line)
 *   -F - / --file -            → message arrives on the tool's STDIN, which a PreToolUse
 *                                hook CANNOT observe → fail closed DENY (HARD-04)
 *   (no -m and no -F)          → interactive editor commit, no asserted message to judge →
 *                                pass through as allow (never fail-closed on a legitimately
 *                                message-less commit, T-07-01-OVERBLOCK)
 *
 * @module hooks/git-commit-convention
 */

const path = require('node:path');
const { parseCommand } = require('./lib/argv.cjs');
const { classifyAction, findActionSegment } = require('./lib/classify.cjs');
const { runGate, readHookInput, deny, allow, emit, FailClosed, safeCommand } = require('./lib/failclosed.cjs');
const { resolveGsdCoreRoot, commandStartDir, ScriptResolveError } = require('./lib/resolve.cjs');

// FailClosed/safeCommand are the shared IN-03 helpers from failclosed.cjs (runGate's
// catch turns any throw into a DENY unless a logged override is present).

// Only `git commit` is gated. Every other action (push, pr-create, git reads, non-git)
// passes through as a no-op allow so the gate never over-blocks (T-07-01-OVERBLOCK).
const TRIGGER_ACTIONS = new Set(['commit']);

// TOOLKIT-OWNED recognized conventional-commit types. DECLARED here (no fenced block copied
// from gsd-core). This mirrors the type vocabulary gsd-core's release/cherry-pick filter
// buckets on; it is the toolkit's own replica pending the #1549 shared matcher.
const RECOGNIZED_TYPES = [
  'feat', 'fix', 'docs', 'chore', 'ci', 'refactor', 'test', 'build', 'perf', 'style', 'revert',
];

// The obvious-prefix SHAPE rule: a recognized type immediately followed by an optional
// `(scope)`, an optional `!`, then a `:`. Anything else (recognized type without the
// separator, or no recognized type at all) is the obvious-violation class → DENY.
const PREFIX_RE = new RegExp(
  '^(?:' + RECOGNIZED_TYPES.join('|') + ')(?:\\([^)]*\\))?!?:'
);

// TOOLKIT-OWNED note (mirror gh-pr-create.cjs OWNED_NOTE). Names this as the toolkit's own
// check and mandates the repoint at the LIVE shared matcher once #1549 extracts one.
const OWNED_NOTE =
  'This is the toolkit’s own conventional-commit PREFIX check (ENF-16) — a replica of ' +
  'gsd-core’s release / cherry-pick prefix policy, NOT a callable repo script: gsd-core ' +
  'exposes no shared conventional-commit matcher yet (#1549). It MUST be repointed at the ' +
  'LIVE shared matcher (via requireLiveScript + a doctor shape-check) once gsd-core extracts ' +
  'one (#1549). It judges PREFIX SHAPE only — choosing the semantically-correct type for the ' +
  'diff is out of scope.';


/**
 * Resolve the commit SUBJECT line from a parsed segment (TOOLKIT-OWNED resolution). Reads,
 * in order:
 *   1. the FIRST `-m` / `--message` / `--message=…` value (repeated -m are body paragraphs;
 *      the FIRST is the subject — never re-tokenize the raw string, scan structured tokens),
 *   2. else `-F` / `--file` / `--file=…` (read from disk via deps.readMessageFile; a
 *      `-`/stdin sentinel → throw FailClosed naming HARD-04),
 *   3. else null (no asserted message → caller allows: interactive editor commit).
 *
 * @param {Object} seg structured segment from argv.parseCommand
 * @param {(p:string)=>(string|null)} readMessageFile reads a commit-message file from disk
 * @returns {string|null} the subject line, or null when there is no asserted message
 */
function resolveCommitMessage(seg, readMessageFile) {
  // (1) -m / --message — scan the ORDERED structured tokens for the FIRST occurrence so a
  // multi-paragraph `-m subject -m body` correctly takes `subject` as the subject line.
  const tokens = Array.isArray(seg.tokens) ? seg.tokens : [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '-m' || t === '--message') {
      const v = tokens[i + 1];
      if (typeof v === 'string') return firstLine(v);
      // -m with no following value: malformed → fail closed.
      throw new FailClosed('git commit -m given without a message value — failing closed (HARD-04)');
    }
    if (typeof t === 'string' && t.startsWith('--message=')) {
      return firstLine(t.slice('--message='.length));
    }
    if (typeof t === 'string' && t.startsWith('-m') && t.length > 2) {
      // -msubject bundled short form.
      return firstLine(t.slice(2));
    }
  }

  // (2) -F / --file — read the message from disk; stdin sentinel fails closed.
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    let filePath = null;
    if (t === '-F' || t === '--file') {
      filePath = tokens[i + 1];
    } else if (typeof t === 'string' && t.startsWith('--file=')) {
      filePath = t.slice('--file='.length);
    } else if (typeof t === 'string' && t.startsWith('-F') && t.length > 2) {
      filePath = t.slice(2);
    }
    if (filePath == null) continue;
    if (filePath === '-') {
      throw new FailClosed(
        'commit message is read from stdin (git commit -F -), which a PreToolUse hook ' +
          'cannot observe — failing closed (HARD-04): cannot confirm the prefix convention'
      );
    }
    const content = readMessageFile(filePath);
    if (typeof content !== 'string') {
      throw new FailClosed('could not read commit message file ' + filePath + ' — failing closed');
    }
    return firstLine(content);
  }

  // (3) No asserted message — interactive editor commit. Nothing to judge → allow.
  return null;
}

/**
 * The first non-empty line of a message (the conventional-commit subject). Trims a leading
 * UTF-8 BOM and surrounding whitespace.
 *
 * WR-03 model: the subject boundary is the first REAL newline only (the `\n` control char).
 * A literal backslash-n in a single-quoted body (token `fix: a\nb`) is part of the subject,
 * NOT a boundary — and a double-quoted `-m "a\nb"` is collapsed by tokenize to `anb` (the
 * backslash is consumed) before this function ever sees it. Splitting on the literal two-char
 * `\\n` was a quoting-dependent divergence: it truncated single-quoted subjects (e.g. a regex
 * or path containing `\n`) while having no effect on the double-quoted form. Treating only the
 * real newline as the boundary makes both quoting forms judge the SAME subject and removes the
 * silent-truncation hazard.
 *
 * @param {string} s
 * @returns {string}
 */
function firstLine(s) {
  if (typeof s !== 'string') return '';
  const noBom = s.replace(/^﻿/, '');
  // Subject boundary = first REAL newline only (WR-03). Literal backslash-n is NOT a boundary.
  const idx = noBom.indexOf('\n');
  const line = idx === -1 ? noBom : noBom.slice(0, idx);
  return line.trim();
}

/**
 * Apply the TOOLKIT-OWNED obvious-prefix SHAPE rule to a commit subject. PASSES only when
 * the subject begins with a recognized type immediately followed by an optional `(scope)`,
 * an optional `!`, then `:`. Otherwise DENIES (recognized type without the separator, or no
 * recognized type at all). A null subject (no asserted message) is NOT this function's
 * concern — the caller short-circuits to allow before calling.
 *
 * @param {string} subject the commit subject line
 * @returns {{ok:boolean, reason?:string}}
 */
function checkPrefix(subject) {
  if (typeof subject !== 'string' || subject.length === 0) {
    // An empty subject with an asserted message flag is a malformed prefix → deny.
    return {
      ok: false,
      reason:
        'Commit subject is empty — it cannot carry a conventional-commit prefix. ' + OWNED_NOTE,
    };
  }
  if (PREFIX_RE.test(subject)) {
    return { ok: true };
  }
  return {
    ok: false,
    reason:
      'Commit subject `' +
      subject +
      '` has an OBVIOUSLY-malformed conventional-commit prefix: it must begin with a ' +
      'recognized type (' +
      RECOGNIZED_TYPES.join('|') +
      ') immediately followed by an optional `(scope)`, optional `!`, then `:` — e.g. ' +
      '`fix(core): …`, `feat!: …`, `docs: …`. ' +
      OWNED_NOTE,
  };
}

/**
 * The pure gate decision with all impure dependencies injected (deps) so it is unit
 * testable without a real gsd-core checkout or filesystem. Wrapped by runGate at the
 * module entry so any throw → fail-closed DENY.
 *
 * @param {string} stdinString raw PreToolUse JSON on stdin
 * @param {Object} deps
 * @param {(p:string)=>(string|null)} deps.readMessageFile reads a commit-message file
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
    throw new FailClosed('unclassifiable mutating call — failing closed (HARD-04)');
  }
  if (!TRIGGER_ACTIONS.has(action.action)) {
    return allow(); // not a commit → not our concern → no-op
  }

  const seg = findActionSegment(parsed, 'commit');
  const subject = resolveCommitMessage(seg, deps.readMessageFile); // may throw FailClosed
  if (subject == null) {
    // No asserted message (interactive editor commit) — nothing to judge → allow.
    return allow();
  }

  const verdict = checkPrefix(subject);
  if (!verdict.ok) {
    return deny(verdict.reason);
  }
  return allow();
}

/**
 * Injectable entry seam used by the test suite. Builds the runGate ctx (worktreeRoot for
 * the override receipt) and the file-reader dep, resolving the gsd-core root from the
 * command's OWN cwd; a commit OUTSIDE a gsd-core checkout returns allow (not our concern),
 * exactly like lint-ci-marker.cjs.
 *
 * @param {string} stdinString raw PreToolUse JSON
 * @param {Object} [deps]
 * @param {(p:string)=>(string|null)} [deps.readMessageFile]
 * @param {string} [deps.worktreeRoot]
 * @param {{checkOverride:Function, writeReceipt:Function}} [deps.overrideImpl]
 * @returns {{permissionDecision:string, permissionDecisionReason?:string}}
 */
function runCommitConventionGate(stdinString, deps = {}) {
  const ctx = {
    command: safeCommand(stdinString),
    action: 'commit',
    worktreeRoot: deps.worktreeRoot,
    overrideImpl: deps.overrideImpl,
  };

  return runGate(() => {
    const resolved = Object.assign({}, deps);

    // Resolve the gsd-core root from the command's OWN cwd (it may `cd` into a worktree).
    // A commit in a non-gsd-core checkout is not our concern → allow. An injected
    // worktreeRoot short-circuits the filesystem walk so the unit suite stays hermetic.
    if (!resolved.worktreeRoot) {
      try {
        resolved.worktreeRoot = resolveGsdCoreRoot(
          commandStartDir(parseCommand(ctx.command), process.cwd())
        );
      } catch (err) {
        if (err instanceof ScriptResolveError) return allow();
        throw err;
      }
    }
    ctx.worktreeRoot = ctx.worktreeRoot || resolved.worktreeRoot;

    if (!resolved.readMessageFile) {
      const fs = require('node:fs');
      resolved.readMessageFile = (p) => {
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
    emit(runCommitConventionGate(buf));
  });
}

if (require.main === module) {
  main();
}

module.exports = { runCommitConventionGate, gate, resolveCommitMessage, checkPrefix, firstLine };
