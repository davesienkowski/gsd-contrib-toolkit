#!/usr/bin/env node
'use strict';

/**
 * hooks/worktree-fresh-base.cjs — STUB (37-01 fail-first): allows everything. Replaced by the
 * ENF-25 tracer slice.
 *
 * @module hooks/worktree-fresh-base
 */

const { runGate, readHookInput, allow, emit, safeCommand } = require('./lib/failclosed.cjs');

const FETCH_ARGV = Object.freeze(['fetch', '--quiet', '--no-auto-maintenance', 'origin', 'next']);
const FETCH_TIMEOUT_S = 15;
const FETCH_KILL_AFTER_S = 2;
const FETCH_BELT_MS = 20000;
const GIT_TIMEOUT_MS = 3000;

class FetchUnavailable extends Error {}

function gate(stdinString) {
  readHookInput(stdinString);
  return allow();
}

function runWorktreeFreshBaseGate(stdinString, deps = {}) {
  const ctx = {
    command: safeCommand(stdinString),
    action: 'worktree-fresh-base',
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
    emit(runWorktreeFreshBaseGate(buf));
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  runWorktreeFreshBaseGate,
  gate,
  FetchUnavailable,
  FETCH_ARGV,
  FETCH_TIMEOUT_S,
  FETCH_KILL_AFTER_S,
  FETCH_BELT_MS,
  GIT_TIMEOUT_MS,
};
