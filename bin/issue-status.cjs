#!/usr/bin/env node
'use strict';

/**
 * bin/issue-status.cjs - read-only issue thread snapshot and ball-in-court for the maintainer review sweep.
 *
 * Why: the 2026-10-23 sweep read every issue thread by hand to answer "who owes the next move?" and
 * "which PRs are tied to it?" (gsd-core-notes sweep-2026-10-23/issues.md, scriptable steps 1 and 2).
 * pr-status answers that for PRs only. This prints, per issue: state, labels, assignees, the newest
 * human comment, the newest non-author comment and whether the author replied after it, the logins the
 * author's newest comment @mentions that have not commented since, one ball line, and the PRs that
 * cross-reference the issue with their state, whether each one closes it, and the pr-status ball of
 * each open one.
 *
 *   node bin/issue-status.cjs [--json] [--no-prs] [--repo owner/name] [--author login [--limit n]] [<n...>]
 *
 * `--author` adds every open issue that login opened (gh issue list, newest first, --limit default 50,
 * at most 500); numbers given on the command line print first, in argv order, and a number is printed
 * once. Text output is plain ASCII (pr-status's clean() rule) and ends with a point-in-time footer.
 * `--json` prints an array of derive() results (the --author note, if any, goes to stderr). A failed issue read prints `owner/name#N ERROR: <first
 * stderr line>` and exits 1; usage errors exit 2; an author with no open issues prints `no open issues`
 * and exits 0.
 *
 * CONTRACT - READ-ONLY gh only. Per issue two REST GETs:
 *   1. gh api "repos/R/issues/N"
 *   2. gh api --paginate --slurp "repos/R/issues/N/timeline?per_page=100"
 * once per run with --author:
 *   0. gh issue list --repo R --author A --state open --json number --limit L
 * and, unless --no-prs, per same-repo PR that cross-references the issue (one read per PR per run):
 *   3. gh pr view P --repo R --json number,state,title,mergedAt,closedAt,closingIssuesReferences
 *   4. for an OPEN PR, pr-status's own reads (fetchPr, fetchQueue) for its ball line
 * No mutating verb, no `gh api -X/--method/-f/-F/--input`, no `gh api graphql`.
 *
 * BALL RULE (facts only; no reading of intent from prose). Human comments are the timeline's
 * `commented` events whose user is not a bot (type Bot or a login ending in [bot]), in created_at
 * order (stable: equal times keep timeline order; a reply counts only when it comes later in this
 * order). Logins compare case-insensitively.
 *   - The number is a PR, or the issue is not open -> no ball.
 *   - No human comment -> MAINTAINERS (nobody has answered the issue).
 *   - The newest human comment is not the author's (round 2 review, Major 3):
 *       it @mentions logins other than its writer, and not only the author -> MENTIONED <those logins>
 *       (the author too when named beside others);
 *       it mentions nobody, only its writer, or only the author -> AUTHOR owes a reply to that commenter.
 *   - The newest is the author's and it @mentions logins with no comment after it -> MENTIONED <logins>.
 *   - Else -> MAINTAINERS (the author commented last and asked nobody by name).
 * A later comment from a mentioned login clears it, because that comment becomes the newest one and is
 * read by the same rule. Mentions inside fenced code, inline code, HTML comments and quoted (>) lines
 * do not count. A bot comment is ignored entirely (it neither asks nor answers).
 * A label, an approval, an assignee or an open PR is printed but never moves the ball: the agent reads
 * those itself. A comment on a linked PR is not read, so an author who answered there still reads as
 * AUTHOR owes.
 * A cross-reference is printed as "references"; when the PR's closingIssuesReferences names this issue
 * it is "closes this issue" (open), "closed this issue" (merged) or "would have closed this issue
 * (closed unmerged)" (a mention is not a closing link). Linked PRs come from `cross-referenced` events
 * only: a PR attached through the Development sidebar with no textual mention is not listed.
 * Cross-references from another repo are listed with their repo and never read.
 *
 * No shell: execFileSync with argv arrays; numbers are validated as digits. Node built-ins only.
 *
 * @module bin/issue-status
 */

const prStatus = require('./pr-status.cjs');

const { clean, firstErrorLine } = prStatus;
const DEFAULT_REPO = 'open-gsd/gsd-core';
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const PR_FIELDS = 'number,state,title,mergedAt,closedAt,closingIssuesReferences';
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;
const MAX_LINE = 160; // first line of a comment, cut at this length
const USAGE =
  'usage: issue-status [--json] [--no-prs] [--repo owner/name] [--author login [--limit n]] [<issue-number...>]  (default repo ' +
  DEFAULT_REPO +
  ')';
const FOOTER =
  'Snapshot is point-in-time (two gh reads per issue, plus one read per linked PR and pr-status reads for open ones); re-run before any write. ' +
  'The ball line reads comments and @mentions only: labels, approvals and assignees are printed for you to weigh.';

/** The read-only argv arrays for one issue. */
function ghArgs(number, repo) {
  return {
    issue: ['api', `repos/${repo}/issues/${number}`],
    timeline: ['api', '--paginate', '--slurp', `repos/${repo}/issues/${number}/timeline?per_page=100`],
  };
}

function prViewArgs(number, repo) {
  return ['pr', 'view', String(number), '--repo', repo, '--json', PR_FIELDS];
}

function defaultGh(args) {
  const { execFileSync } = require('node:child_process');
  const out = execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(out);
}

function lower(s) {
  return String(s == null ? '' : s).toLowerCase();
}

function isBot(user) {
  return Boolean(user) && (user.type === 'Bot' || /\[bot\]$/i.test(String(user.login || '')));
}

/** Flatten a --paginate --slurp reply; any other shape throws, so the issue reads as an ERROR, never as quiet. */
function pagesToArray(pages, what) {
  if (!Array.isArray(pages) || !pages.every((p) => Array.isArray(p))) throw new Error(`${what} reply is not an array of pages`);
  return pages.flat();
}

/** The @logins a comment body names, outside fenced code, inline code and quoted lines; lowercased, in order. */
function mentionsIn(body) {
  const text = String(body || '')
    .replace(/<!--[\s\S]*?(-->|$)/g, ' ')
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/~~~[\s\S]*?(~~~|$)/g, ' ')
    .split('\n')
    .filter((l) => !/^\s*>/.test(l))
    .join('\n')
    .replace(/`[^`\n]*`/g, ' ');
  const out = [];
  const re = /(^|[^A-Za-z0-9_`./-])@([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))(?![A-Za-z0-9_/-])/g;
  let m;
  while ((m = re.exec(text))) {
    const login = lower(m[2]);
    if (!out.includes(login)) out.push(login);
  }
  return out;
}

function firstLine(body) {
  const line = String(body || '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !/^>/.test(l)) || '';
  return line.length > MAX_LINE ? line.slice(0, MAX_LINE) + '...' : line;
}

function commentOf(e) {
  return {
    login: String(e.user.login),
    association: String(e.author_association || ''),
    createdAt: String(e.created_at || ''),
    url: String(e.html_url || ''),
    firstLine: firstLine(e.body),
    mentions: mentionsIn(e.body),
  };
}

/**
 * Pure verdict over the issue and its timeline.
 *
 * @param {{issue: object, timeline: object[], repo?: string}} input timeline flat or page-nested; repo = the
 *   owner/name the issue was read from (decides which cross-references are same-repo; default: the issue's URL)
 * @returns {object} snapshot with comments, mentions, ball and linked PR references
 */
function derive({ issue, timeline, repo }) {
  const i = issue || {};
  const author = String((i.user && i.user.login) || '');
  const state = String(i.state || '').toUpperCase();
  const isPr = Boolean(i.pull_request);
  const events = (Array.isArray(timeline) ? timeline : []).flat().filter(Boolean);

  const all = events
    .map((e, idx) => ({ e, idx }))
    .filter(({ e }) => e.event === 'commented' && e.user && e.user.login);
  const bots = all.filter(({ e }) => isBot(e.user)).length;
  const human = all.filter(({ e }) => !isBot(e.user));
  human.sort((a, b) => {
    const ta = String(a.e.created_at || '');
    const tb = String(b.e.created_at || '');
    return ta < tb ? -1 : ta > tb ? 1 : a.idx - b.idx;
  });
  const comments = human.map(({ e }) => commentOf(e));
  const isAuthor = (c) => lower(c.login) === lower(author);

  const newest = comments.length ? comments[comments.length - 1] : null;
  let lastNonAuthorIdx = -1;
  let lastAuthorIdx = -1;
  comments.forEach((c, k) => {
    if (isAuthor(c)) lastAuthorIdx = k;
    else lastNonAuthorIdx = k;
  });
  const lastNonAuthor = lastNonAuthorIdx >= 0 ? comments[lastNonAuthorIdx] : null;
  const authorReplied = lastNonAuthor ? lastAuthorIdx > lastNonAuthorIdx : null;
  const lastAuthor = lastAuthorIdx >= 0 ? comments[lastAuthorIdx] : null;
  const mentioned = lastAuthor ? lastAuthor.mentions.filter((m) => m !== lower(author)) : [];
  const unanswered = mentioned.filter((m) => !comments.slice(lastAuthorIdx + 1).some((c) => lower(c.login) === m));

  let ball;
  if (isPr) ball = { owner: 'n/a', logins: [], reason: 'is a pull request, use pr-status' };
  else if (state !== 'OPEN') ball = { owner: 'n/a', logins: [], reason: `state ${state || 'unknown'}` };
  else if (!newest) ball = { owner: 'maintainers', logins: [], reason: 'no human comment yet' };
  else if (!isAuthor(newest)) {
    const asked = newest.mentions.filter((m) => m !== lower(newest.login));
    if (asked.length && !(asked.length === 1 && asked[0] === lower(author))) {
      ball = { owner: 'mentioned', logins: asked, reason: `newest comment ${newest.createdAt} by ${newest.login} @mentions them` };
    } else ball = { owner: 'author', logins: [author], reason: `newest comment is by ${newest.login}`, to: newest.login };
  }
  else if (unanswered.length) ball = { owner: 'mentioned', logins: unanswered, reason: `author's newest comment ${newest.createdAt} @mentions them and they have not commented since` };
  else ball = { owner: 'maintainers', logins: [], reason: 'the author commented last and @mentioned nobody who has not answered' };

  // PRs that cross-reference the issue: deduped by repo and number, ascending; same-repo ones are read later.
  const issueRepo = repo || repoOfIssue(i);
  const refs = new Map();
  for (const e of events) {
    const si = e.event === 'cross-referenced' && e.source && e.source.issue;
    if (!si || !si.pull_request || si.number == null) continue;
    const repo = String((si.repository && si.repository.full_name) || issueRepo || '');
    const key = `${lower(repo)}#${si.number}`;
    if (refs.has(key)) continue;
    refs.set(key, {
      repo,
      number: Number(si.number),
      title: String(si.title || ''),
      state: String(si.state || '').toUpperCase(),
      merged: Boolean(si.pull_request.merged_at),
      sameRepo: issueRepo ? lower(repo) === lower(issueRepo) : true,
    });
  }
  const linkedPrs = [...refs.values()].sort((a, b) => (a.repo === b.repo ? a.number - b.number : a.repo < b.repo ? -1 : 1));

  return {
    number: i.number,
    title: String(i.title || ''),
    state,
    isPr,
    author,
    labels: (Array.isArray(i.labels) ? i.labels : []).map((l) => String((l && l.name) || l || '')).filter(Boolean),
    assignees: (Array.isArray(i.assignees) ? i.assignees : []).map((a) => String((a && a.login) || '')).filter(Boolean),
    comments: { human: comments.length, bot: bots },
    newest,
    lastNonAuthor,
    authorReplied,
    lastAuthor: lastAuthor ? { createdAt: lastAuthor.createdAt, url: lastAuthor.url, mentions: mentioned, unanswered } : null,
    ball,
    linkedPrs,
  };
}

/** owner/name from the issue's repository_url or html_url, or '' when neither is present. */
function repoOfIssue(i) {
  const m =
    /\/repos\/([^/]+\/[^/]+)$/.exec(String(i.repository_url || '')) ||
    /github\.com\/([^/]+\/[^/]+)\/(?:issues|pull)\//.exec(String(i.html_url || ''));
  return m ? m[1] : '';
}

/**
 * Read one issue and its timeline (two REST GETs).
 *
 * @returns {{issue: object, timeline: object[]}}
 */
function fetchIssue(number, repo, deps = {}) {
  const gh = deps.gh || defaultGh;
  const args = ghArgs(number, repo);
  const issue = gh(args.issue);
  if (!issue || typeof issue !== 'object' || Array.isArray(issue)) throw new Error('issue reply is not an object');
  // A PR number answers the issues endpoint too: report it and skip the timeline.
  if (issue.pull_request) return { issue, timeline: [] };
  const timeline = pagesToArray(gh(args.timeline), 'timeline');
  return { issue, timeline };
}

/**
 * Fill each same-repo linked PR with its state, whether it closes the issue, and (OPEN) its pr-status ball.
 * One pr view per PR per run (cache), and pr-status's reads once per open PR (cache). A failed read is
 * named on the PR (closes: null with error), never a thrown issue error.
 */
function enrichPrs(d, repo, deps, cache) {
  const gh = deps.gh || defaultGh;
  for (const p of d.linkedPrs) {
    if (!p.sameRepo) continue;
    const key = String(p.number);
    if (!cache.view.has(key)) {
      try {
        cache.view.set(key, { v: gh(prViewArgs(p.number, repo)) });
      } catch (err) {
        cache.view.set(key, { error: firstErrorLine(err) });
      }
    }
    const got = cache.view.get(key);
    if (got.error) {
      p.closes = null;
      p.error = got.error;
      continue;
    }
    const v = got.v || {};
    p.state = String(v.state || p.state || '').toUpperCase();
    p.title = String(v.title || p.title);
    p.merged = Boolean(v.mergedAt) || p.merged;
    const closing = Array.isArray(v.closingIssuesReferences) ? v.closingIssuesReferences : [];
    p.closes = closing.some((c) => c && Number(c.number) === Number(d.number) && (!c.repository || !c.repository.owner || lower(`${c.repository.owner.login}/${c.repository.name}`) === lower(repo)));
    if (p.state === 'OPEN') {
      if (!cache.status.has(key)) {
        try {
          const pr = prStatus.fetchPr(p.number, repo, deps);
          const base = String((pr.view && pr.view.baseRefName) || '');
          if (!cache.queue.has(base)) cache.queue.set(base, prStatus.fetchQueue(repo, base, deps));
          cache.status.set(key, { d: prStatus.derive({ ...pr, queue: cache.queue.get(base) }) });
        } catch (err) {
          cache.status.set(key, { error: firstErrorLine(err) });
        }
      }
      const st = cache.status.get(key);
      if (st.error) p.prStatusError = st.error;
      else {
        p.head = st.d.head;
        p.ballLine = prStatus.ballLineOf(st.d);
      }
    }
  }
}

function short(sha, n) {
  return String(sha || '').slice(0, n) || '-';
}

function ballText(b) {
  if (b.owner === 'n/a') return null;
  if (b.owner === 'author') return `  ball: AUTHOR ${clean(b.logins[0])} owes a reply (newest comment is by ${clean(b.to)})`;
  if (b.owner === 'mentioned') return `  ball: MENTIONED ${b.logins.map(clean).join(', ')} owe(s) a reply (${clean(b.reason)})`;
  return `  ball: MAINTAINERS (${clean(b.reason)})`;
}

/** Render one derive() result as ASCII text lines. */
function formatText(d) {
  const lines = [];
  const repo = d.repo ? clean(d.repo) : '';
  if (d.isPr) {
    lines.push(`${repo}#${clean(d.number)} is a pull request, use pr-status`);
    return lines.join('\n');
  }
  lines.push(`${repo}#${clean(d.number)} ${clean(d.state)} author ${clean(d.author)} "${clean(d.title)}"`);
  lines.push(`  labels: ${d.labels.length ? d.labels.map(clean).join(', ') : 'none'}`);
  lines.push(`  assignees: ${d.assignees.length ? d.assignees.map(clean).join(', ') : 'none'}`);
  if (!d.newest) lines.push(`  comments: none${d.comments.bot ? ` (${d.comments.bot} bot)` : ''}`);
  else {
    const n = d.newest;
    lines.push(`  comments: ${d.comments.human} human, ${d.comments.bot} bot; newest ${clean(n.createdAt)} by ${clean(n.login)} (${clean(n.association) || '-'})`);
  }
  if (d.lastNonAuthor) {
    const c = d.lastNonAuthor;
    lines.push(`  last non-author comment: ${clean(c.login)} (${clean(c.association) || '-'}) ${clean(c.createdAt)} ${clean(c.url)}`);
    lines.push(`    "${clean(c.firstLine)}"`);
    lines.push(`  author replied after it: ${d.authorReplied ? 'yes' : 'no'}`);
  } else if (d.newest) {
    lines.push('  last non-author comment: none');
  }
  if (d.lastAuthor) {
    const a = d.lastAuthor;
    const m = a.mentions.length ? a.mentions.map(clean).join(', ') : 'nobody';
    const u = a.unanswered.length ? a.unanswered.map(clean).join(', ') : 'none';
    lines.push(`  author's newest comment: ${clean(a.createdAt)} @mentions ${m}; not answered since: ${u}`);
  }
  const bl = ballText(d.ball);
  if (bl) lines.push(bl);
  else lines.push(`  ball: none (${clean(d.ball.reason)})`);
  if (!d.linkedPrs.length) lines.push('  prs: none cross-reference this issue');
  for (const p of d.linkedPrs) {
    const where = p.sameRepo ? '' : `${clean(p.repo)}`;
    if (!p.sameRepo) {
      lines.push(`  pr: ${where}#${clean(p.number)} ${clean(p.state)}${p.merged ? ' merged' : ''} references (other repo, not read) "${clean(p.title)}"`);
      continue;
    }
    let link;
    if (p.closes === true && p.merged) link = 'closed this issue';
    else if (p.closes === true && p.state === 'CLOSED') link = 'would have closed this issue (closed unmerged)';
    else if (p.closes === true) link = 'closes this issue';
    else if (p.closes === false) link = 'references (does not close)';
    else if (p.error) link = `references (closing: unknown, read failed: ${clean(p.error)})`;
    else link = 'references (closing not read: --no-prs)';
    lines.push(`  pr: #${clean(p.number)} ${clean(p.state)}${p.merged ? ' merged' : ''} ${link} "${clean(p.title)}"`);
    if (p.ballLine) lines.push(`    head ${clean(short(p.head, 12))};${p.ballLine.replace(/^ {2}/, ' ')}`);
    if (p.prStatusError) lines.push(`    pr-status read failed: ${clean(p.prStatusError)}`);
  }
  return lines.join('\n');
}

/** Parse argv into { json, prs, repo, author, limit, numbers } or { usageError }. */
function parseArgs(argv) {
  let json = false;
  let prs = true;
  let repo = DEFAULT_REPO;
  let author = null;
  let limit = DEFAULT_LIMIT;
  const numbers = [];
  const list = Array.isArray(argv) ? argv : [];
  if (list.some((a) => a === '--help' || a === '-h')) return { help: true };
  let limitGiven = false;
  const valueOf = (a, name, i) => (a === name ? list[i + 1] : a.slice(name.length + 1));
  for (let i = 0; i < list.length; i += 1) {
    const a = String(list[i]);
    if (a === '--json') json = true;
    else if (a === '--no-prs') prs = false;
    else if (a === '--repo' || a.startsWith('--repo=')) {
      const v = valueOf(a, '--repo', i);
      if (a === '--repo') i += 1;
      if (v == null || !REPO_PATTERN.test(String(v))) return { usageError: `bad --repo value: ${clean(v)}` };
      repo = String(v);
    } else if (a === '--author' || a.startsWith('--author=')) {
      const v = valueOf(a, '--author', i);
      if (a === '--author') i += 1;
      if (v == null || !LOGIN_PATTERN.test(String(v))) return { usageError: `bad --author value: ${clean(v)}` };
      author = String(v);
    } else if (a === '--limit' || a.startsWith('--limit=')) {
      const v = valueOf(a, '--limit', i);
      if (a === '--limit') i += 1;
      if (v == null || !/^[0-9]+$/.test(String(v)) || Number(v) < 1 || Number(v) > MAX_LIMIT) return { usageError: `--limit must be 1 to ${MAX_LIMIT}: ${clean(v)}` };
      limit = Number(v);
      limitGiven = true;
    } else if (/^[0-9]+$/.test(a)) {
      const n = a.replace(/^0+/, '');
      if (n === '') return { usageError: `issue number must be 1 or more: ${a}` };
      if (!numbers.includes(n)) numbers.push(n);
    } else return { usageError: `not an issue number or flag: ${clean(a)}` };
  }
  if (numbers.length === 0 && !author) return { usageError: 'no issue number or --author given' };
  if (limitGiven && !author) return { usageError: '--limit needs --author' };
  return { json, prs, repo, author, limit, numbers };
}

/**
 * CLI entry. Returns the exit code: 0 ok, 1 when any read failed, 2 usage.
 *
 * @param {string[]} argv
 * @param {{gh?: Function, sleep?: Function, stdout?: {write: Function}, stderr?: {write: Function}}} [deps]
 */
function runCli(argv, deps = {}) {
  const out = deps.stdout || process.stdout;
  const errOut = deps.stderr || process.stderr;
  const gh = deps.gh || defaultGh;
  const args = parseArgs(argv);
  if (args.help) {
    out.write(USAGE + '\n');
    return 0;
  }
  if (args.usageError) {
    errOut.write(`issue-status: ${args.usageError}\n${USAGE}\n`);
    return 2;
  }
  let failed = false;
  const numbers = [...args.numbers];
  let listNote = null;
  if (args.author) {
    try {
      const listed = gh(['issue', 'list', '--repo', args.repo, '--author', args.author, '--state', 'open', '--json', 'number', '--limit', String(args.limit)]);
      if (!Array.isArray(listed)) throw new Error('issue list reply is not an array');
      const found = listed.map((x) => String(x && x.number)).filter((n) => /^[1-9][0-9]*$/.test(n));
      found.sort((a, b) => Number(a) - Number(b));
      for (const n of found) if (!numbers.includes(n)) numbers.push(n);
      if (found.length === 0) listNote = `${clean(args.repo)}: no open issues by ${clean(args.author)}`;
      else if (found.length >= args.limit) listNote = `${clean(args.repo)}: --limit ${args.limit} reached; more open issues by ${clean(args.author)} may exist`;
    } catch (err) {
      failed = true;
      listNote = `${clean(args.repo)} issue list ERROR: ${clean(firstErrorLine(err))}`;
    }
  }
  const cache = { view: new Map(), status: new Map(), queue: new Map() };
  const results = numbers.map((n) => {
    try {
      const d = { repo: args.repo, ...derive({ ...fetchIssue(n, args.repo, { ...deps, gh }), repo: args.repo }) };
      if (args.prs && !d.isPr) enrichPrs(d, args.repo, { ...deps, gh }, cache);
      return d;
    } catch (err) {
      failed = true;
      return { repo: args.repo, number: Number(n), error: firstErrorLine(err) };
    }
  });
  if (args.json) {
    // Always an array (possibly empty); the --author note goes to stderr so the JSON shape never changes.
    if (listNote) errOut.write(listNote + '\n');
    const ascii = JSON.stringify(results, null, 2).replace(/[\u007f-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
    out.write(ascii + '\n');
  } else {
    const blocks = results.map((d) => (d.error ? `${clean(d.repo)}#${clean(d.number)} ERROR: ${clean(d.error)}` : formatText(d)));
    if (listNote) blocks.unshift(listNote);
    out.write(blocks.join('\n\n') + '\n\n' + FOOTER + '\n');
  }
  return failed ? 1 : 0;
}

module.exports = { derive, fetchIssue, formatText, mentionsIn, parseArgs, runCli };

if (require.main === module) process.exitCode = runCli(process.argv.slice(2));
