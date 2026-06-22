#!/usr/bin/env node
'use strict';

/**
 * hooks/doctor.cjs — the toolkit self-test CLI (HARD-02 / red-team H-E).
 *
 * Resolves the gsd-core root from the current working directory, runs the SHAPE-checking
 * doctor against every LIVE script the gates call, prints a human-readable report, and
 * exits nonzero if ANY script is missing, lost its export, or DRIFTED its return shape.
 *
 * Run it from inside a gsd-core checkout:
 *   cd /path/to/gsd-core && node /path/to/gsd-contrib-toolkit/hooks/doctor.cjs
 *
 * This is what catches a gsd-core refactor BEFORE it silently fail-closed-bricks the gates.
 * Phase 5 packages it into the toolkit's own CI.
 *
 * @module hooks/doctor
 */

const { runDoctor } = require('./lib/doctor.cjs');
const { resolveGsdCoreRoot } = require('./lib/resolve.cjs');

/**
 * @param {string} [startDir]
 * @returns {number} process exit code (0 = all shapes hold, 1 = a failure or no gsd-core).
 */
function runCli(startDir) {
  let root;
  try {
    root = resolveGsdCoreRoot(startDir == null ? process.cwd() : startDir);
  } catch (err) {
    process.stderr.write(
      'gsd-contrib doctor: could not find a gsd-core checkout from ' +
        (startDir == null ? process.cwd() : startDir) +
        '\n  (' + ((err && err.message) || String(err)) + ')\n' +
        '  Run this from inside the gsd-core repo.\n'
    );
    return 1;
  }

  const report = runDoctor(root);
  process.stdout.write('gsd-contrib doctor — LIVE gsd-core script shape check\n');
  process.stdout.write('  root: ' + root + '\n\n');
  for (const r of report.results) {
    const mark = r.ok ? 'PASS' : 'FAIL';
    process.stdout.write('  [' + mark + '] ' + r.script + ' :: ' + r.exportName + '\n');
    process.stdout.write('         ' + r.detail + '\n');
  }
  process.stdout.write('\n');
  if (report.ok) {
    process.stdout.write('All ' + report.results.length + ' LIVE script shape checks passed.\n');
  } else {
    const failed = report.results.filter((r) => !r.ok).length;
    process.stdout.write(
      failed + ' of ' + report.results.length + ' shape check(s) FAILED — a gsd-core script ' +
        'is missing or its contract drifted. Fix the toolkit before the gates fail-closed-brick.\n'
    );
  }
  return report.ok ? 0 : 1;
}

if (require.main === module) {
  process.exit(runCli());
}

module.exports = { runCli };
