#!/usr/bin/env node
'use strict';

/**
 * bin/fixtures/pr-status-gh-stub.cjs — the stub `gh` the pr-status tests copy onto PATH as `gh`.
 *
 * Serves the fixtures in $PR_STATUS_STUB_FIXTURES (indexed by view.number) for exactly three per-PR reads
 * (plus the per-repo merge-queue reads documented at serveQueue below):
 * `gh pr view N`, `gh pr checks N` (stdout = the checks JSON, exit = provenance.checksExit, stderr =
 * provenance.checksStderr) and `gh api ... repos/OWNER/REPO/pulls/N/reviews` (the page array). Every call
 * appends its argv as one JSON line to $PR_STATUS_STUB_LOG. Any other verb, and any -X / --method / -f /
 * -F / --field / --raw-field / --input / graphql argument, appends a REFUSED line and exits 99, so a test
 * can prove pr-status stays read-only. A number with no fixture exits 1 with gh's not-found message.
 * The timeline, files and compare reads (quick 261022-w9m) are documented at servePrExtra below.
 */

const fs = require('node:fs');
const path = require('node:path');

// Exit by setting process.exitCode and returning, never process.exit() right after a large write:
// process.exit() can cut off a pipe write that has not drained (a >1 MiB reviews payload would truncate).
function done(code) {
  process.exitCode = code;
  return code;
}

/**
 * The merge-queue reads (quick 261021-n2m). The queue state is per repo, not per PR, so it comes from ONE
 * file named by $PR_STATUS_STUB_QUEUE (a bin/fixtures/pr-status-queue/*.json); unset means an empty
 * repo: no active rules and no rulesets (mode absent). Four read-only paths:
 *   repos/O/R/rules/branches/<b>[?...]  -> rulesBranches[<b>] (default [])
 *   repos/O/R/rulesets[?...]            -> rulesets (default [])
 *   repos/O/R/rulesets/<id>             -> rulesetDetails[<id>], else 404
 *   repos/O/R                           -> repo (default { default_branch: 'next' })
 * `fail.<rules|rulesets|ruleset|repo>` makes that read exit 1 with the given stderr. With --slurp the
 * body is wrapped in one page, as gh --paginate --slurp does. Returns null for any other path.
 */
function serveQueue(apiPath, slurp) {
  const [p] = apiPath.split('?');
  let kind = null;
  let key = null;
  let m;
  if ((m = /^repos\/[^/]+\/[^/]+\/rules\/branches\/(.+)$/.exec(p))) [kind, key] = ['rules', decodeURIComponent(m[1])];
  else if (/^repos\/[^/]+\/[^/]+\/rulesets$/.test(p)) kind = 'rulesets';
  else if ((m = /^repos\/[^/]+\/[^/]+\/rulesets\/(\d+)$/.exec(p))) [kind, key] = ['ruleset', m[1]];
  else if (/^repos\/[^/]+\/[^/]+$/.test(p)) kind = 'repo';
  if (!kind) return null;
  const file = process.env.PR_STATUS_STUB_QUEUE;
  const q = file ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  if (q.fail && q.fail[kind]) {
    process.stderr.write(q.fail[kind] + '\n');
    return done(1);
  }
  let body;
  if (kind === 'rules') body = (q.rulesBranches && q.rulesBranches[key]) || [];
  else if (kind === 'rulesets') body = q.rulesets || [];
  else if (kind === 'repo') body = q.repo || { default_branch: 'next' };
  else {
    body = q.rulesetDetails && q.rulesetDetails[key];
    if (!body) {
      process.stderr.write('gh: Not Found (HTTP 404)\n');
      return done(1);
    }
  }
  process.stdout.write(JSON.stringify(slurp ? [body] : body) + '\n');
  return done(0);
}

/**
 * The per-PR reads added by quick 261022-w9m, served from the PR's own fixture:
 *   repos/O/R/issues/N/timeline[?...]  -> fx.timeline (default []); provenance.timelineFail = stderr, exit 1
 *   repos/O/R/pulls/N/files[?...]      -> fx.files (default [])
 *   repos/O/R/compare/<a>...<b>        -> fx.compare["<a>...<b>"] from the fixture whose compare map has that key,
 *                                         else 404; provenance.compareFail = stderr, exit 1
 * With --slurp the body is wrapped in one page. Returns null for any other path.
 */
function servePrExtra(apiPath, slurp, fixtures) {
  const [p] = apiPath.split('?');
  const out = (body) => {
    process.stdout.write(JSON.stringify(slurp ? [body] : body) + '\n');
    return done(0);
  };
  const fail = (msg) => {
    process.stderr.write(msg + '\n');
    return done(1);
  };
  let m;
  if ((m = /^repos\/[^/]+\/[^/]+\/issues\/(\d+)\/timeline$/.exec(p))) {
    const fx = fixtures.get(m[1]);
    if (!fx) return fail('gh: Not Found (HTTP 404)');
    if (fx.provenance && fx.provenance.timelineFail) return fail(fx.provenance.timelineFail);
    return out(fx.timeline || []);
  }
  if ((m = /^repos\/[^/]+\/[^/]+\/pulls\/(\d+)\/files$/.exec(p))) {
    const fx = fixtures.get(m[1]);
    if (!fx) return fail('gh: Not Found (HTTP 404)');
    return out(fx.files || []);
  }
  if ((m = /^repos\/[^/]+\/[^/]+\/compare\/(.+)$/.exec(p))) {
    for (const fx of fixtures.values()) {
      if (fx.compare && Object.prototype.hasOwnProperty.call(fx.compare, m[1])) {
        if (fx.provenance && fx.provenance.compareFail) return fail(fx.provenance.compareFail);
        return out(fx.compare[m[1]]);
      }
    }
    return fail('gh: Not Found (HTTP 404)');
  }
  return null;
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
    const apiPath = argv.find((a) => a.startsWith('repos/')) || '';
    const queue = serveQueue(apiPath, argv.includes('--slurp'));
    if (queue !== null) return queue;
    const extra = servePrExtra(apiPath, argv.includes('--slurp'), fixtures);
    if (extra !== null) return extra;
    const m = /^repos\/[^/]+\/[^/]+\/pulls\/(\d+)\/reviews(\?.*)?$/.exec(apiPath);
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
