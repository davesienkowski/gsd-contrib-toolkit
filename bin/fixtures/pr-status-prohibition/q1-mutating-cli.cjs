'use strict';
// Q1 violation CLI: one read, then a mutating `gh pr comment`. Run only against the refusing stub gh.
const { execFileSync } = require('node:child_process');

const n = process.argv[2];
const run = (args) => {
  try {
    return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    return String(err.stderr || '');
  }
};
process.stdout.write(run(['pr', 'view', n, '--repo', 'open-gsd/gsd-core', '--json', 'number']));
process.stdout.write(run(['pr', 'comment', n, '--repo', 'open-gsd/gsd-core', '--body', 'ping']));
