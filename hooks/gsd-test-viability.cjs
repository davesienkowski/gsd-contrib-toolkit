#!/usr/bin/env node
'use strict';

/**
 * hooks/gsd-test-viability.cjs — PreToolUse(Bash) ENF-24 gsd-test viability gate.
 *
 * 36-04 Task 1 RED STUB: allows everything. The tests in gsd-test-viability.test.cjs are run
 * against this stub first (fail-first), then the real gate replaces it.
 *
 * @module hooks/gsd-test-viability
 */

const { runGate, allow, emit, safeCommand } = require('./lib/failclosed.cjs');

function gate() {
  return allow();
}

function parseBenches() {
  return [];
}

function runGsdTestViabilityGate(stdinString, deps = {}) {
  const ctx = {
    command: safeCommand(stdinString),
    action: 'gsd-test-viability',
    stdin: stdinString,
    worktreeRoot: deps.worktreeRoot,
    overrideImpl: deps.overrideImpl,
  };
  return runGate(() => gate(stdinString, deps), ctx);
}

function main() {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => {
    buf += c;
  });
  process.stdin.on('end', () => {
    emit(runGsdTestViabilityGate(buf));
  });
}

if (require.main === module) {
  main();
}

module.exports = { runGsdTestViabilityGate, gate, parseBenches };
