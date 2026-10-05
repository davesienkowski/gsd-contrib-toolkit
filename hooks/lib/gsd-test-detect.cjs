'use strict';

/**
 * hooks/lib/gsd-test-detect.cjs — the shared gsd-test dispatch detector (GTEST-01).
 *
 * ONE pure predicate both gsd-test dispatch gates (ENF-23 clean-tree, ENF-24 viability) call
 * FIRST: no dispatch -> null -> the gate allows before any filesystem, git or docker work
 * (RES-01 action-first ordering; 36-CONTEXT Addendum 2 — `isNonGovernedCommand` cannot serve,
 * because gsd-test is deliberately NOT a classifyAction action).
 *
 * TRACER FORM (36-01). This recognises the plain dispatch only: a segment whose resolved
 * program (classify.resolveProgram — leading env assignments, wrapper builtins, basename) is
 * `gsd-test`, and reports whether its output is piped from argv's per-segment `nextOp`.
 * 36-02 expands it to every variant (Go flag walker, informational invocations, `set -o
 * pipefail`, `bash -c` payloads, `|&`/`(`/`&` residue, the unparseable-command rule). The
 * returned shape is already the final one so the gates do not change when it grows.
 *
 * Pure: no fs, no child_process, no env reads. Never executes the command it classifies.
 *
 * @module hooks/lib/gsd-test-detect
 */

const { parseCommand } = require('./argv.cjs');
const { resolveProgram } = require('./classify.cjs');

/**
 * Find the first gsd-test dispatch in a raw Bash command.
 *
 * @param {string} command raw tool_input.command
 * @returns {null|{
 *   kind: 'dispatch',
 *   seg: Object,
 *   segIndex: number,
 *   pipedOut: boolean,
 *   pipefail: boolean,
 *   pipeMasked: boolean,
 *   informational: boolean,
 *   flags: Object,
 *   unresolved: Set<string>,
 *   prefixes: Array<{ok:true, segments:Object[]}>
 * }} null when the command is not a gsd-test dispatch
 */
function findGsdTestDispatch(command) {
  if (typeof command !== 'string' || command.trim().length === 0) return null;

  const parsed = parseCommand(command);
  // 36-02 adds the uncertain rule for an unparseable command that names gsd-test.
  if (!parsed.ok) return null;

  for (let segIndex = 0; segIndex < parsed.segments.length; segIndex++) {
    const seg = parsed.segments[segIndex];
    if (resolveProgram(seg).prog !== 'gsd-test') continue;
    const pipedOut = seg.nextOp === '|';
    return {
      kind: 'dispatch',
      seg,
      segIndex,
      pipedOut,
      pipefail: false,
      pipeMasked: pipedOut,
      informational: false,
      flags: {},
      unresolved: new Set(),
      // The segments BEFORE the dispatch, in parseCommand shape, so a gate can compute the
      // dispatch's start dir with resolve.commandStartDir (a `cd X &&` prefix is honoured).
      prefixes: [{ ok: true, segments: parsed.segments.slice(0, segIndex) }],
    };
  }
  return null;
}

module.exports = { findGsdTestDispatch };
