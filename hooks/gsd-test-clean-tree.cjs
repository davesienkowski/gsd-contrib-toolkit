#!/usr/bin/env node
'use strict';

/**
 * hooks/gsd-test-clean-tree.cjs — PreToolUse(Bash) ENF-23 gsd-test clean-tree gate.
 *
 * gsd-test dispatches a ref-based Docker test run. Two of trek-e's documented traps turn such a
 * run into a FALSE GREEN, and this gate denies both at dispatch time:
 *
 *   trap 2 (GTEST-03, this tracer slice) — the dispatch's output is PIPED (`gsd-test ... | tail`).
 *            A pipeline exits with its LAST command's status, so a failed run reads as exit 0.
 *   trap 1 (GTEST-02, plan 36-03) — the working tree is dirty while the run tests HEAD, so the
 *            edits under test are not the ones gsd-test checks out.
 *
 * ── ORDER (load-bearing) ────────────────────────────────────────────────────────────────
 *   1. read the harness payload (malformed JSON throws -> fail-closed deny);
 *   2. the shared detector (hooks/lib/gsd-test-detect.cjs): no dispatch -> allow, BEFORE any
 *      resolve, git or fs work (RES-01; 36-CONTEXT Addendum 2 — `isNonGovernedCommand` is
 *      deliberately NOT used, gsd-test is not a classifyAction action);
 *   3. resolve the dispatch's tree from its start dir (a `cd X &&` prefix is honoured);
 *      not a gsd-core checkout -> allow (out-of-tree passthrough, ROB-01 precedent);
 *   4. pipe masked -> deny(PIPE_REASON).
 *
 * A returned deny is a POLICY deny: GSD_CONTRIB_OVERRIDE rescues thrown errors only and never
 * flips it (Addendum 4), so PIPE_REASON always names the real fix.
 *
 * TRACER SLICE (36-01): pipe deny only. 36-03 completes the dirty-tree half; 36-05 registers
 * the hook in settings.snippet.json (until then it is not wired and not bundled).
 *
 * @module hooks/gsd-test-clean-tree
 */

const { runGate, readHookInput, deny, allow, emit, safeCommand } = require('./lib/failclosed.cjs');
const { commandStartDir, resolveGsdCoreRoot, ScriptResolveError } = require('./lib/resolve.cjs');
const { findGsdTestDispatch } = require('./lib/gsd-test-detect.cjs');

/**
 * The pipe-deny reason. A module CONSTANT with no cwd, path, sha or timestamp: it becomes a
 * committed byte-stable proof fixture in 36-05.
 */
const PIPE_REASON =
  'Blocked by the ENF-23 gsd-test clean-tree gate: this gsd-test dispatch is piped into another ' +
  'command. A shell pipeline exits with the status of its LAST command, so a failed gsd-test run ' +
  'piped into `tail`/`tee`/`grep` reads as exit 0 — a false green.\n\n' +
  'Re-run it one of these ways:\n' +
  '  1. run it unpiped: `gsd-test ...` on its own;\n' +
  '  2. prefix the pipeline with `set -o pipefail;` so the pipeline fails when gsd-test fails;\n' +
  '  3. redirect to a file and read the log after: `gsd-test ... > gsd-test.log 2>&1`, then ' +
  'inspect `gsd-test.log` and the exit status.';

/**
 * The pure gate decision with every impure dep injected.
 *
 * @param {string} stdinString raw PreToolUse JSON
 * @param {Object} deps
 * @param {string} deps.cwd the hook's working directory (the command's base cwd)
 * @param {(dir:string)=>(string|null)} deps.resolveTreeRoot gsd-core root for a dir, or null
 * @returns {{permissionDecision:string, permissionDecisionReason?:string}}
 */
function gate(stdinString, deps) {
  const input = readHookInput(stdinString);
  const command = (input.tool_input && input.tool_input.command) || '';

  // (2) RES-01: the detector is the first short-circuit — nothing below runs for `git status`.
  const d = findGsdTestDispatch(command);
  if (d === null) return allow();

  // (3) Which tree. followGitC:false — a `git -C <dir>` earlier in the chain does not move the
  // shell's cwd, so it must not move the gsd-test dispatch's tree either.
  const startDir = commandStartDir(d.prefixes[0], deps.cwd, { followGitC: false });
  const root = deps.resolveTreeRoot(startDir);
  if (root === null) return allow();

  // (4) Trap 2: a piped dispatch masks the exit code.
  if (d.pipeMasked) return deny(PIPE_REASON);

  return allow();
}

/**
 * Injectable entry seam. Defaults the real impls INSIDE the runGate callback so a throwing
 * default fails closed rather than escaping the harness.
 *
 * @param {string} stdinString raw PreToolUse JSON
 * @param {Object} [deps]
 * @returns {{permissionDecision:string, permissionDecisionReason?:string}}
 */
function runGsdTestCleanTreeGate(stdinString, deps = {}) {
  const ctx = {
    command: safeCommand(stdinString),
    action: 'gsd-test-clean-tree',
    // OBS-02: read ONLY for session/tool ids in the verdict log; never logged verbatim.
    stdin: stdinString,
    worktreeRoot: deps.worktreeRoot,
    overrideImpl: deps.overrideImpl,
  };

  return runGate(() => {
    const resolved = Object.assign({}, deps);
    // Addendum 6: the hook's cwd is process.cwd(), as every other Bash gate.
    if (!resolved.cwd) resolved.cwd = process.cwd();
    if (!resolved.resolveTreeRoot) {
      resolved.resolveTreeRoot = (dir) => {
        try {
          return resolveGsdCoreRoot(dir);
        } catch (err) {
          // Not a gsd-core checkout: not this gate's concern. Anything else fails closed.
          if (err instanceof ScriptResolveError) return null;
          throw err;
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
    emit(runGsdTestCleanTreeGate(buf));
  });
}

if (require.main === module) {
  main();
}

module.exports = { runGsdTestCleanTreeGate, gate, PIPE_REASON };
