#!/usr/bin/env node
'use strict';

/**
 * hooks/lint-ci-marker.cjs — PreToolUse(Bash) ENF-05 marker READ gate (push + pr-create).
 *
 * This is the READER half of ENF-05. On a `git push` or `gh pr create` (and its ENF-15
 * REST synonyms), it DENIES unless a fresh lint-green marker exists for the current
 * `git write-tree` SHA AND the working tree is clean. The marker that vouches the lint
 * suite was green for this tree is WRITTEN by the separate stamp (bin/lint-ci-stamp, plan
 * 04-01's writer) — this gate only READS it. It NEVER invokes the lint suite and NEVER
 * writes a marker: it is fast and side-effect-free (the grep-proofs in the plan assert this).
 *
 *   ENF-05 — a push/PR-create whose current tree SHA has no marker → DENY, naming the
 *            exact `lint-ci-stamp` command to run (which proves the tree green). Keying to
 *            `git write-tree` (not HEAD)
 *            is what makes the marker survive an amend/rebase that keeps the same files
 *            while invalidating on any real content change (T-04-02-STALE).
 *
 *   EP-4   — a DIRTY working tree (`git status --porcelain` non-empty) → DENY even when a
 *            marker for the staged-tree SHA exists, because the pushed content would differ
 *            from the stamped tree (T-04-02-TOCTOU). A re-stamp after staging is required.
 *
 * Scope: only `push` / `pr-create` actions are gated (TRIGGER_ACTIONS); every other command
 * (git reads, non-git, commit) passes through as a no-op allow, so the gate never over-blocks.
 * An ENF-15 REST synonym (`gh api -X POST .../pulls`, curl) routes through classifyAction to
 * the SAME `pr-create` trigger, and an unmappable mutating github synonym throws FailClosed —
 * so a synonym cannot slip past the marker check (T-04-02-SYNONYM).
 *
 * HARD-01/04: the whole decision runs inside runGate, so an unparseable command, a malformed
 * stdin payload, or a git-read failure FAILS CLOSED (deny) — escapable only by a deliberate,
 * logged GSD_CONTRIB_OVERRIDE (HARD-03), distinct from `--no-verify` (denied by ENF-12).
 *
 * @module hooks/lint-ci-marker
 */

const { parseCommand } = require('./lib/argv.cjs');
const { classifyAction } = require('./lib/classify.cjs');
const { runGate, readHookInput, deny, allow, emit } = require('./lib/failclosed.cjs');
const { resolveGsdCoreRoot, commandStartDir, ScriptResolveError } = require('./lib/resolve.cjs');
const {
  readTreeShaLive,
  readWorkingTreeStatusLive,
  resolveMarkerPathLive,
  markerExistsLive,
} = require('./lib/marker.cjs');

class FailClosed extends Error {}

const TRIGGER_ACTIONS = new Set(['push', 'pr-create']);

/**
 * The pure gate decision with all impure git/marker reads injected.
 *
 * @param {string} stdinString raw PreToolUse JSON
 * @param {Object} deps
 * @param {() => string} deps.readTreeSha reads the current `git write-tree` SHA. MAY THROW
 *   → fail closed.
 * @param {() => string} deps.readWorkingTreeStatus reads `git status --porcelain` ('' =
 *   clean). MAY THROW → fail closed.
 * @param {(root: string, sha: string) => boolean} deps.readMarkerExists true iff the marker
 *   for `sha` exists. MAY THROW → fail closed.
 * @param {string} [deps.worktreeRoot] the resolved gsd-core worktree root (passed to
 *   readMarkerExists for diagnostics; the live readers are pre-bound to it).
 * @returns {{permissionDecision:string, permissionDecisionReason?:string}}
 */
function gate(stdinString, deps) {
  const input = readHookInput(stdinString);
  const command = (input.tool_input && input.tool_input.command) || '';

  const parsed = parseCommand(command);
  if (!parsed.ok) throw new FailClosed('unparseable command: ' + parsed.reason);

  const action = classifyAction(parsed);
  // An unmappable mutating github synonym must not slip through (T-04-02-SYNONYM).
  if (action && action.failClosed) {
    throw new FailClosed('unclassifiable mutating github call — failing closed (HARD-04)');
  }
  // Only push / pr-create are gated. Anything else (git reads, commit, non-git) → no-op allow.
  if (!action || !TRIGGER_ACTIONS.has(action.action)) return allow();

  // (1) EP-4 — a dirty working tree invalidates the marker even when the staged-tree SHA
  // has one, because the pushed content would differ. May throw → fail closed (HARD-01).
  const status = deps.readWorkingTreeStatus(deps.worktreeRoot);
  if (typeof status === 'string' && status.trim().length > 0) {
    return deny(
      'Working tree is DIRTY — the lint-green marker is keyed to the STAGED tree ' +
        '(`git write-tree`), but unstaged/untracked changes mean the pushed content will ' +
        'differ from what was proven green. Stage all changes and re-stamp: `lint-ci-stamp`. ' +
        '(ENF-05 EP-4)'
    );
  }

  // (2) ENF-05 — the marker for the CURRENT tree SHA must exist. Reading the SHA and the
  // marker may throw → fail closed (HARD-01).
  const sha = deps.readTreeSha(deps.worktreeRoot);
  if (!deps.readMarkerExists(deps.worktreeRoot, sha)) {
    return deny(
      'No fresh lint-green marker exists for the current tree (`git write-tree` ' +
        '= ' + sha + '). A push/PR cannot proceed on a tree that has not been proven ' +
        'green by the lint suite. Run `lint-ci-stamp` (it runs the lint suite and, on ' +
        'green, stamps the marker for this exact tree), then retry. An amend/rebase that ' +
        'changes content yields a new tree SHA and requires a fresh stamp. (ENF-05)'
    );
  }

  return allow();
}

/**
 * Injectable entry seam. Defaults the three readers to LIVE reads bound to the resolved
 * gsd-core worktree root. Mirrors githooks-seal's runGithooksGate shape exactly.
 *
 * @param {string} stdinString raw PreToolUse JSON
 * @param {Object} [deps]
 * @param {() => string} [deps.readTreeSha]
 * @param {() => string} [deps.readWorkingTreeStatus]
 * @param {(root: string, sha: string) => boolean} [deps.readMarkerExists]
 * @param {string} [deps.worktreeRoot]
 * @param {{checkOverride:Function, writeReceipt:Function}} [deps.overrideImpl]
 * @returns {{permissionDecision:string, permissionDecisionReason?:string}}
 */
function runLintCiMarkerGate(stdinString, deps = {}) {
  const ctx = {
    command: safeCommand(stdinString),
    action: 'lint-ci-marker',
    worktreeRoot: deps.worktreeRoot,
    overrideImpl: deps.overrideImpl,
  };

  return runGate(() => {
    const resolved = Object.assign({}, deps);
    const needsRoot =
      !resolved.readTreeSha || !resolved.readWorkingTreeStatus || !resolved.readMarkerExists;
    if (needsRoot && !resolved.worktreeRoot) {
      try {
        resolved.worktreeRoot = resolveGsdCoreRoot(commandStartDir(parseCommand(ctx.command), process.cwd()));
      } catch (err) {
        // Not a gsd-core checkout (e.g. a commit in another repo) → not this gate's
        // concern; allow. A broken gsd-core checkout still fails closed downstream.
        if (err instanceof ScriptResolveError) return allow();
        throw err;
      }
    }
    ctx.worktreeRoot = ctx.worktreeRoot || resolved.worktreeRoot;

    // Default each reader to a thin wrapper over the marker.cjs live readers, bound to the
    // resolved root. The gate is READ-ONLY — none of these write a marker or invoke linting.
    if (!resolved.readTreeSha) {
      resolved.readTreeSha = (root) => readTreeShaLive(root);
    }
    if (!resolved.readWorkingTreeStatus) {
      resolved.readWorkingTreeStatus = (root) => readWorkingTreeStatusLive(root);
    }
    if (!resolved.readMarkerExists) {
      resolved.readMarkerExists = (root, sha) =>
        markerExistsLive(resolveMarkerPathLive(root, sha));
    }

    return gate(stdinString, resolved);
  }, ctx);
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
    emit(runLintCiMarkerGate(buf));
  });
}

if (require.main === module) {
  main();
}

module.exports = { runLintCiMarkerGate, gate, TRIGGER_ACTIONS };
