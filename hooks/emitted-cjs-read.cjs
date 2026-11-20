#!/usr/bin/env node
'use strict';

/**
 * hooks/emitted-cjs-read.cjs - PreToolUse(Read) emitted-cjs read guard (ENF-26). RED STUB
 * (quick 261119-szk Task 1): every path passes silently until Task 2 lands the guard.
 *
 * @module hooks/emitted-cjs-read
 */

function gate() {
  return null;
}

function runReadGuard() {
  return null;
}

function main() {
  process.stdin.resume();
  process.stdin.on('data', () => {});
  process.stdin.on('end', () => {
    process.exitCode = 0;
  });
}

if (require.main === module) {
  main();
}

module.exports = { gate, runReadGuard };
