#!/usr/bin/env node
'use strict';

/**
 * hooks/gsd-test-clean-tree.cjs — PreToolUse(Bash) ENF-23 gsd-test clean-tree gate.
 *
 * RED stub (36-01 Task 1 step 1): always allows so the tracer tests fail at the assertion
 * level before the implementation lands.
 *
 * @module hooks/gsd-test-clean-tree
 */

const { runGate, allow, emit, safeCommand } = require('./lib/failclosed.cjs');

function gate(stdinString, deps) { // eslint-disable-line no-unused-vars
  return allow();
}

function runGsdTestCleanTreeGate(stdinString, deps = {}) {
  const ctx = {
    command: safeCommand(stdinString),
    action: 'gsd-test-clean-tree',
    stdin: stdinString,
    worktreeRoot: deps.worktreeRoot,
    overrideImpl: deps.overrideImpl,
  };
  return runGate(() => allow(), ctx);
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

module.exports = { runGsdTestCleanTreeGate, gate };
