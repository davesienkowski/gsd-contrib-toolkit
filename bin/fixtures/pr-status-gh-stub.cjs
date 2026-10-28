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
 * The timeline, files and compare reads (quick 261022-w9m) are documented at servePrExtra below. The
 * issue-status reads (same quick) come from fixtures with an `issue` key: `gh api repos/O/R/issues/N` ->
 * fx.issue, its timeline as above, and `gh issue list --repo R --author A --state open --json number
 * --limit N` -> the open non-PR issue fixtures of that author, newest number first.
 * The --cr and --body reads (quick 261023-2u4): `gh api ... repos/O/R/pulls/N/reviews/<id>/comments` (at
 * servePrExtra below) and `gh pr view N ... --json body,baseRefOid,changedFiles` -> fx.bodyView (absent ->
 * gh's not-found message, exit 1; provenance.bodyFail = stderr, exit 1). Every other `pr view` returns fx.view.
 * The gsd-core CI-check reads (quick 261028-owj: workflow runs and run attempts, .github/MAINTAINERS contents,
 * collaborator permission) are served from $PR_STATUS_STUB_QUEUE; see serveQueue below.
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
 *
 * The gsd-core CI-check reads (quick 261028-owj) come from the same queue file, also per repo, all single
 * GETs (no --paginate):
 *   repos/O/R/actions/workflows/<file>/runs?branch=<b>&...  -> baseRuns[<b>] (default {"workflow_runs":[]})
 *   repos/O/R/actions/runs/<id>/attempts/<n>                -> attempts["<id>/<n>"], else 404
 *   repos/O/R/contents/.github/MAINTAINERS[?ref=...]        -> {content: base64(maintainers), encoding: 'base64'}
 *                                                              from the `maintainers` text key, else 404 (any ref)
 *   repos/O/R/collaborators/<login>/permission              -> roles[<login>] (an object, or a bare role name
 *                                                              string for {permission, role_name}), else 404
 * `fail.<runs|attempt|maintainers|permission>` makes that read exit 1 with the given stderr; for permission
 * it may also be an object keyed by login (only those logins fail).
 */
function serveQueue(apiPath, slurp) {
  const [p, query] = apiPath.split('?');
  let kind = null;
  let key = null;
  let m;
  if ((m = /^repos\/[^/]+\/[^/]+\/actions\/workflows\/[^/]+\/runs$/.exec(p))) [kind, key] = ['runs', new URLSearchParams(query || '').get('branch') || ''];
  else if ((m = /^repos\/[^/]+\/[^/]+\/actions\/runs\/(\d+)\/attempts\/(\d+)$/.exec(p))) [kind, key] = ['attempt', `${m[1]}/${m[2]}`];
  else if (/^repos\/[^/]+\/[^/]+\/contents\/\.github\/MAINTAINERS$/.test(p)) kind = 'maintainers';
  else if ((m = /^repos\/[^/]+\/[^/]+\/collaborators\/([^/]+)\/permission$/.exec(p))) [kind, key] = ['permission', decodeURIComponent(m[1])];
  else if ((m = /^repos\/[^/]+\/[^/]+\/rules\/branches\/(.+)$/.exec(p))) [kind, key] = ['rules', decodeURIComponent(m[1])];
  else if (/^repos\/[^/]+\/[^/]+\/rulesets$/.test(p)) kind = 'rulesets';
  else if ((m = /^repos\/[^/]+\/[^/]+\/rulesets\/(\d+)$/.exec(p))) [kind, key] = ['ruleset', m[1]];
  else if (/^repos\/[^/]+\/[^/]+$/.test(p)) kind = 'repo';
  if (!kind) return null;
  const file = process.env.PR_STATUS_STUB_QUEUE;
  const q = file ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const failSpec = q.fail && q.fail[kind];
  const failMsg = failSpec && typeof failSpec === 'object' ? failSpec[key] : failSpec;
  if (failMsg) {
    process.stderr.write(failMsg + '\n');
    return done(1);
  }
  const notFound = () => {
    process.stderr.write('gh: Not Found (HTTP 404)\n');
    return done(1);
  };
  let body;
  if (kind === 'runs') body = (q.baseRuns && q.baseRuns[key]) || { workflow_runs: [] };
  else if (kind === 'attempt') {
    body = q.attempts && q.attempts[key];
    if (!body) return notFound();
  } else if (kind === 'maintainers') {
    if (typeof q.maintainers !== 'string') return notFound();
    body = { name: 'MAINTAINERS', path: '.github/MAINTAINERS', encoding: 'base64', content: Buffer.from(q.maintainers, 'utf8').toString('base64') };
  } else if (kind === 'permission') {
    const hit = Object.keys(q.roles || {}).find((k) => k.toLowerCase() === key.toLowerCase());
    if (hit === undefined) return notFound();
    const role = q.roles[hit];
    body = typeof role === 'string' ? { permission: role, role_name: role } : role;
  } else if (kind === 'rules') body = (q.rulesBranches && q.rulesBranches[key]) || [];
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
 *   repos/O/R/pulls/N                  -> fx.pull (push-target's REST pull read), else 404
 *   repos/O/R/pulls/N/files[?...]      -> fx.files (default [])
 *   repos/O/R/compare/<a>...<b>        -> fx.compare["<a>...<b>"] from the fixture whose compare map has that key,
 *                                         else 404; provenance.compareFail = stderr, exit 1
 *   repos/O/R/pulls/N/reviews/<id>/comments[?...] -> fx.reviewComments[<id>] (default []);
 *                                         provenance.reviewCommentsFail = stderr, exit 1 (quick 261023-2u4; matched
 *                                         here, before the reviews regex in main, which would refuse it)
 * With --slurp the body is wrapped in one page. Returns null for any other path.
 */
function servePrExtra(apiPath, slurp, fixtures, issues) {
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
    const fx = fixtures.get(m[1]) || (issues && issues.get(m[1]));
    if (!fx) return fail('gh: Not Found (HTTP 404)');
    if (fx.provenance && fx.provenance.timelineFail) return fail(fx.provenance.timelineFail);
    return out(fx.timeline || []);
  }
  if ((m = /^repos\/[^/]+\/[^/]+\/pulls\/(\d+)$/.exec(p))) {
    const fx = fixtures.get(m[1]);
    if (!fx || !fx.pull) return fail('gh: Not Found (HTTP 404)');
    return out(fx.pull);
  }
  if ((m = /^repos\/[^/]+\/[^/]+\/pulls\/(\d+)\/files$/.exec(p))) {
    const fx = fixtures.get(m[1]);
    if (!fx) return fail('gh: Not Found (HTTP 404)');
    return out(fx.files || []);
  }
  if ((m = /^repos\/[^/]+\/[^/]+\/pulls\/(\d+)\/reviews\/(\d+)\/comments$/.exec(p))) {
    const fx = fixtures.get(m[1]);
    if (!fx) return fail('gh: Not Found (HTTP 404)');
    if (fx.provenance && fx.provenance.reviewCommentsFail) return fail(fx.provenance.reviewCommentsFail);
    return out((fx.reviewComments && fx.reviewComments[m[2]]) || []);
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
  const issues = new Map(); // issue-status fixtures (quick 261022-w9m), indexed by issue.number
  for (const f of fs.readdirSync(process.env.PR_STATUS_STUB_FIXTURES)) {
    if (!f.endsWith('.json')) continue;
    const fx = JSON.parse(fs.readFileSync(path.join(process.env.PR_STATUS_STUB_FIXTURES, f), 'utf8'));
    if (fx && fx.view && fx.view.number != null) fixtures.set(String(fx.view.number), fx);
    if (fx && fx.issue && fx.issue.number != null) issues.set(String(fx.issue.number), fx);
  }
  const notFound = (n) => {
    process.stderr.write('GraphQL: Could not resolve to a PullRequest with the number of ' + n + '. (repository.pullRequest)\n');
    return done(1);
  };
  if (argv[0] === 'pr' && (argv[1] === 'view' || argv[1] === 'checks')) {
    const n = argv[2];
    const fx = fixtures.get(n);
    if (!fx) return notFound(n);
    if (argv[1] === 'view' && argv[argv.indexOf('--json') + 1] === 'body,baseRefOid,changedFiles') {
      // The --body read (quick 261023-2u4): a separate view with only the body fields.
      if (fx.provenance && fx.provenance.bodyFail) {
        process.stderr.write(fx.provenance.bodyFail + '\n');
        return done(1);
      }
      if (!fx.bodyView) return notFound(n);
      process.stdout.write(JSON.stringify(fx.bodyView) + '\n');
      return done(0);
    }
    if (argv[1] === 'view') {
      process.stdout.write(JSON.stringify(fx.view) + '\n');
      return done(0);
    }
    const prov = fx.provenance || {};
    if (prov.checksStderr) process.stderr.write(prov.checksStderr + '\n');
    if (fx.checks != null) process.stdout.write(JSON.stringify(fx.checks) + '\n');
    return done(prov.checksExit || 0);
  }
  if (argv[0] === 'issue' && argv[1] === 'list') {
    // gh issue list --repo R --author A --state open --json number --limit N: open, non-PR issue fixtures by author
    const flag = (name) => (argv.indexOf(name) >= 0 ? argv[argv.indexOf(name) + 1] : null);
    if (flag('--state') !== 'open' || flag('--json') !== 'number' || !flag('--author') || !flag('--repo')) return refuse('unexpected-issue-list-args');
    const author = String(flag('--author')).toLowerCase();
    const limit = Number(flag('--limit') || 30);
    const out = [...issues.values()]
      .map((fx) => fx.issue)
      .filter((i) => String(i.state).toLowerCase() === 'open' && !i.pull_request && i.user && String(i.user.login).toLowerCase() === author)
      .map((i) => ({ number: i.number }))
      .sort((a, b) => b.number - a.number)
      .slice(0, limit);
    process.stdout.write(JSON.stringify(out) + '\n');
    return done(0);
  }
  if (argv[0] === 'api') {
    const apiPath = argv.find((a) => a.startsWith('repos/')) || '';
    const queue = serveQueue(apiPath, argv.includes('--slurp'));
    if (queue !== null) return queue;
    const im = /^repos\/[^/]+\/[^/]+\/issues\/(\d+)$/.exec(apiPath.split('?')[0]);
    if (im) {
      const fx = issues.get(im[1]);
      if (!fx) {
        process.stderr.write('gh: Not Found (HTTP 404)\n');
        return done(1);
      }
      process.stdout.write(JSON.stringify(fx.issue) + '\n');
      return done(0);
    }
    const extra = servePrExtra(apiPath, argv.includes('--slurp'), fixtures, issues);
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
