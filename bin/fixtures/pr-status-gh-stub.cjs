#!/usr/bin/env node
'use strict';

/**
 * bin/fixtures/pr-status-gh-stub.cjs — the stub `gh` the pr-status tests copy onto PATH as `gh`.
 *
 * Serves the fixtures in $PR_STATUS_STUB_FIXTURES (indexed by view.number) for exactly three reads:
 * `gh pr view N`, `gh pr checks N` (stdout = the checks JSON, exit = provenance.checksExit, stderr =
 * provenance.checksStderr) and `gh api ... repos/OWNER/REPO/pulls/N/reviews` (the page array). Every call
 * appends its argv as one JSON line to $PR_STATUS_STUB_LOG. Any other verb, and any -X / --method / -f /
 * -F / --field / --raw-field / --input / graphql argument, appends a REFUSED line and exits 99, so a test
 * can prove pr-status stays read-only. A number with no fixture exits 1 with gh's not-found message.
 */

const fs = require('node:fs');
const path = require('node:path');

// Exit by setting process.exitCode and returning, never process.exit() right after a large write:
// process.exit() can cut off a pipe write that has not drained (a >1 MiB reviews payload would truncate).
function done(code) {
  process.exitCode = code;
  return code;
}

function main() {
  const argv = process.argv.slice(2);
  const log = process.env.PR_STATUS_STUB_LOG;
  const record = (line) => {
    if (log) fs.appendFileSync(log, line + '\n');
  };
  record(JSON.stringify(argv));
  const refuse = (why) => {
    record('REFUSED ' + why + ' ' + JSON.stringify(argv));
    process.stderr.write('stub gh refused: ' + why + '\n');
    return done(99);
  };
  const BAD = new Set(['-X', '--method', '-f', '-F', '--field', '--raw-field', '--input']);
  for (const a of argv) {
    if (BAD.has(a) || /^(-X|--method=|--field=|--raw-field=|--input=)/.test(a) || /graphql/i.test(a)) return refuse('mutating-or-graphql-arg');
  }
  const fixtures = new Map();
  for (const f of fs.readdirSync(process.env.PR_STATUS_STUB_FIXTURES)) {
    if (!f.endsWith('.json')) continue;
    const fx = JSON.parse(fs.readFileSync(path.join(process.env.PR_STATUS_STUB_FIXTURES, f), 'utf8'));
    if (fx && fx.view && fx.view.number != null) fixtures.set(String(fx.view.number), fx);
  }
  const notFound = (n) => {
    process.stderr.write('GraphQL: Could not resolve to a PullRequest with the number of ' + n + '. (repository.pullRequest)\n');
    return done(1);
  };
  if (argv[0] === 'pr' && (argv[1] === 'view' || argv[1] === 'checks')) {
    const n = argv[2];
    const fx = fixtures.get(n);
    if (!fx) return notFound(n);
    if (argv[1] === 'view') {
      process.stdout.write(JSON.stringify(fx.view) + '\n');
      return done(0);
    }
    const prov = fx.provenance || {};
    if (prov.checksStderr) process.stderr.write(prov.checksStderr + '\n');
    if (fx.checks != null) process.stdout.write(JSON.stringify(fx.checks) + '\n');
    return done(prov.checksExit || 0);
  }
  if (argv[0] === 'api') {
    const m = /^repos\/[^/]+\/[^/]+\/pulls\/(\d+)\/reviews(\?.*)?$/.exec(argv.find((a) => a.startsWith('repos/')) || '');
    if (!m) return refuse('unknown-api-path');
    const fx = fixtures.get(m[1]);
    if (!fx) {
      process.stderr.write('gh: Not Found (HTTP 404)\n');
      return done(1);
    }
    process.stdout.write(JSON.stringify(fx.reviews) + '\n');
    return done(0);
  }
  return refuse('unknown-verb');
}

main();
