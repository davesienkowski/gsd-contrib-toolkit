#!/usr/bin/env node
'use strict';

/**
 * hooks/binlib-edit.cjs — PreToolUse(Write|Edit) generated-file gate
 * (ENF-03, ADR-457, HARD-01/03 fail-closed).
 *
 * The #1 zero-source bounce in a gsd-core contribution is editing a GENERATED
 * `bin/lib/*.cjs` artifact instead of its `src/*.ts` source (PROJECT.md, ADR-457):
 * the hand-edit is silently overwritten by the next `build:lib`, so the change looks
 * applied but evaporates. This gate makes that physically impossible — a
 * PreToolUse(Write|Edit) whose `tool_input.file_path` resolves to any
 * `**\/bin/lib/*.cjs` leaf is DENIED, with a reason pointing the author at the
 * `src/*.ts` source + ADR-457.
 *
 * Segment-accuracy (threat T-03-04-SUBSTR / edge-probe EP-1 class): the match is NOT a
 * naive `includes('bin/lib')` substring. A `bin` PATH SEGMENT must be immediately
 * followed by a `lib` SEGMENT, immediately followed by a `*.cjs` LEAF that is the direct
 * child of that `lib`. So:
 *   - `.../bin/lib/decisions.cjs`            → DENY  (segment pair + .cjs leaf)
 *   - `.../packages/x/bin/lib/foo.cjs`       → DENY  (any depth)
 *   - `src/bin-lib-notes.md`                 → ALLOW (substring, not a segment pair)
 *   - `src/mybin/libfoo.cjs`                 → ALLOW (bin/lib split across one segment)
 *   - `.../bin/lib/README.md`                → ALLOW (segment pair but leaf is not .cjs)
 *   - `.../bin/lib/sub/nested.cjs`           → ALLOW (.cjs is not a direct lib child)
 *   - `.../lib/bin/x.cjs`                     → ALLOW (wrong order: must be bin then lib)
 *
 * HARD-01/03: the whole decision runs inside runGate, so a malformed payload, an absent
 * or non-string `file_path`, or any thrown error FAILS CLOSED (deny) — escapable only by
 * a deliberate, logged GSD_CONTRIB_OVERRIDE.
 *
 * @module hooks/binlib-edit
 */

const path = require('node:path');
const { runGate, readHookInput, deny, allow, emit, FailClosed } = require('./lib/failclosed.cjs');

// FailClosed: shared IN-03 helper from failclosed.cjs (binlib-edit has no safeCommand —
// it uses safeFilePath; Write/Edit gates read file_path, not command).

/**
 * Split a path into its segments, tolerant of either separator (the harness may hand us a
 * POSIX or a Windows-ish path). Empty segments (from leading/trailing/double separators)
 * are dropped so a trailing slash cannot smuggle a fake leaf.
 *
 * @param {string} filePath
 * @returns {string[]}
 */
function pathSegments(filePath) {
  return String(filePath)
    .split(/[\\/]+/)
    .filter((s) => s.length > 0);
}

/**
 * Is this file_path a generated `**\/bin/lib/*.cjs` artifact, by SEGMENT-accurate match?
 *
 * Requires a `bin` segment immediately followed by a `lib` segment, with the `*.cjs` leaf
 * as the DIRECT child of that `lib` (i.e. exactly one segment after `lib`, and it is the
 * final segment, and it ends in `.cjs`). Never a naive substring test.
 *
 * @param {string} filePath
 * @returns {boolean}
 */
function isGeneratedBinLib(filePath) {
  const segs = pathSegments(filePath);
  // Need at least bin / lib / leaf, with the leaf as the LAST segment.
  if (segs.length < 3) return false;
  const leafIdx = segs.length - 1;
  // bin and lib must be the two segments immediately preceding the leaf.
  if (segs[leafIdx - 2] !== 'bin') return false;
  if (segs[leafIdx - 1] !== 'lib') return false;
  const leaf = segs[leafIdx];
  return typeof leaf === 'string' && leaf.toLowerCase().endsWith('.cjs');
}

/**
 * The ENF-03 / ADR-457 deny reason — point the author at the `src/*.cts` source.
 *
 * @param {string} filePath
 * @returns {string}
 */
function binLibDenyReason(filePath) {
  return (
    'This file is a GENERATED artifact (`' +
    filePath +
    '`). Editing a `bin/lib/*.cjs` by hand is overwritten by the next `build:lib` ' +
    '(ADR-457: generated CJS has a single source). Edit the `src/*.ts` source instead, ' +
    'then run `build:lib` to regenerate. (ENF-03)'
  );
}

/**
 * The pure gate decision over a PreToolUse(Write|Edit) payload.
 *
 * @param {string} stdinString raw PreToolUse JSON
 * @returns {{permissionDecision:string, permissionDecisionReason?:string}}
 */
function gate(stdinString) {
  const input = readHookInput(stdinString); // throws on malformed JSON → fail closed
  const toolInput = input.tool_input || {};
  const filePath = toolInput.file_path;

  // An Edit/Write with no observable file_path cannot be evaluated — fail closed (HARD-01).
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new FailClosed(
      'PreToolUse(Write|Edit) carried no string file_path — failing closed (HARD-01)'
    );
  }

  if (isGeneratedBinLib(filePath)) {
    return deny(binLibDenyReason(filePath));
  }
  return allow();
}

/**
 * Injectable entry seam. Mirrors the other gates: deps carry the worktreeRoot + override
 * impl so runGate can record/honor a logged override, and the unit suite stays hermetic.
 *
 * @param {string} stdinString raw PreToolUse JSON
 * @param {Object} [deps]
 * @param {string} [deps.worktreeRoot]
 * @param {{checkOverride:Function, writeReceipt:Function}} [deps.overrideImpl]
 * @returns {{permissionDecision:string, permissionDecisionReason?:string}}
 */
function runBinlibGate(stdinString, deps = {}) {
  const ctx = {
    command: safeFilePath(stdinString),
    action: 'binlib-edit',
    worktreeRoot: deps.worktreeRoot,
    overrideImpl: deps.overrideImpl,
  };
  return runGate(() => gate(stdinString), ctx);
}

/**
 * Best-effort extract of the file_path for the override receipt (never throws).
 *
 * @param {string} stdinString
 * @returns {string}
 */
function safeFilePath(stdinString) {
  try {
    const o = JSON.parse(stdinString);
    const fp = o && o.tool_input && o.tool_input.file_path;
    return typeof fp === 'string' ? fp : '';
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
    emit(runBinlibGate(buf));
  });
}

if (require.main === module) {
  main();
}

module.exports = { runBinlibGate, gate, isGeneratedBinLib, binLibDenyReason, pathSegments };
