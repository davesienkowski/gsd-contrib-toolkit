#!/usr/bin/env node
'use strict';

/**
 * bin/fixtures/pr-update-prstatus-stub.cjs - stands in for `node bin/pr-status.cjs --json --body ...` in the
 * pr-update tests (pr-update reaches pr-status through the PR_UPDATE_PRSTATUS path). It prints the JSON array in
 * `prstatus` of $PR_UPDATE_STUB_STATE and exits with `prstatusExit` (default 0). The shape mirrors the real derive()
 * output of bin/pr-status.cjs: reviewers[{login,state}], requested[], checks{failing[],pending[]},
 * body{selfTest{status,headSha}}, policies{selfTest{status,reason}}; a failed read is {repo,number,error} with exit 1.
 */

const fs = require('node:fs');

const state = JSON.parse(fs.readFileSync(process.env.PR_UPDATE_STUB_STATE, 'utf8'));
fs.appendFileSync(process.env.PR_UPDATE_STUB_LOG, JSON.stringify({ tool: 'pr-status', argv: process.argv.slice(2) }) + '\n');
process.stdout.write(JSON.stringify(state.prstatus));
process.exitCode = state.prstatusExit || 0;
