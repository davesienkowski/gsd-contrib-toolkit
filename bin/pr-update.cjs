#!/usr/bin/env node
'use strict';

/**
 * bin/pr-update.cjs - resumable two-phase PR update with a durable ledger (quick 261113-wc1, review-convergence W-C).
 *
 * Why: the 2026-11-13 morning bundle for #5871 (push, hosted Self-test, body, comment, re-request) died with its
 * session at ~909K tokens and left no record of which steps ran. This drives the bundle as eight steps, writes a
 * ledger line BEFORE step 1 and after every step, and can be re-run from any session until the postcondition holds.
 *
 *   node bin/pr-update.cjs run --repo owner/name --pr N --head <sha> --branch <fork branch> --remote <git remote>
 *        --worktree <dir> --fork davesienkowski/gsd-core --report-inputs <json> --findings <md>
 *        (--ctx-tokens N | --transcript <session.jsonl>) [--budget N] [--ledger-dir D] [--policy-dir P | --core-dir C]
 *        [--supersede --reason <text>] [--run-id N]
 *   node bin/pr-update.cjs --pending [--ledger-dir D]       one "bundle pending: <repo>#N steps a-b" line per open bundle
 *   node bin/pr-update.cjs status --repo R --pr N [--ledger-dir D]
 *   node bin/pr-update.cjs unlock --repo R --pr N --reason <text> [--ledger-dir D]
 *
 * Steps (phase 1 = 1-3, phase 2 = 4-8): 1 publish the fork branch; 2 dispatch the hosted Self-test (davesienkowski/
 * gsd-core-experiments, branch selftest/run, SELFTEST_SHA in selftest.yml); 3 body "Self-test pending for <head>";
 * 4 the run is green (conclusion success AND head.txt names the head AND exit=0 AND summed `# fail` 0 AND one
 * `# pass` summary per chunk); 5 body: unedited excerpt + run URL + head + counts, checked by the LIVE
 * self-test-report-policy; 6 re-review comment; 7 re-request the CHANGES_REQUESTED reviewers; 8 postcondition.
 *
 * DRIVER, NOT RUNNER. Each invocation verifies steps in order with READ-ONLY commands this script runs itself (gh
 * reads, git ls-remote, gh run download, pr-status CLI, the live policy script). The first unverified step is EMITTED
 * as `NEXT: <command>` (exit 3) and never spawned: the caller runs it as its own Bash call, so the caller's hooks
 * decide, then re-runs `run`. No `mark` verb: a step is done only when a read proves it. There is no write seam.
 *   Exit: 0 all eight steps verified; 1 a step failed (stops there); 2 usage or refusal; 3 a write is emitted
 *   (`NEXT:`) or a run is awaited (`AWAITING:`).
 *
 * LIMITS, stated plainly. (1) PreToolUse hooks see only the Bash call that runs an emitted write. gh-edit and
 * review-artifact are registered in ~/repos/gsd-core/.claude/settings.json only, so the body gate runs only in a
 * session started there; step 5 therefore also runs the live policy itself and refuses unless it says ok_report.
 * (2) The script cannot read the session size; --ctx-tokens is caller-reported and --transcript reads the harness's
 * own session file, so a caller that lies defeats the 600000-token refusal. (3) The ledger is a disk file in the
 * notes repo (untracked); the lock file is not a mutex for the emit-to-rerun window, the marker and head checks narrow
 * a double write (they do not prevent it). (4) The run URL points at a runner repo that may be private.
 *
 * Node built-ins only; argv arrays, no shell.
 *
 * @module bin/pr-update
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CTX_BUDGET_TOKENS = 600000; // policy value, tunable with --budget
const EXPERIMENTS = 'davesienkowski/gsd-core-experiments';
const SELFTEST_FORK = 'davesienkowski/gsd-core';
const SELFTEST_BRANCH = 'selftest/run';
const WORKFLOW_PATH = '.github/workflows/selftest.yml';
const EXCERPT_MAX = 2000; // the live policy's output_excerpt limit, in UTF-16 units (.length)
const EXCERPT_LINES = 40;
const MAX_DISPATCH_CHURN = 2; // SELFTEST_SHA changed by someone else between two of this bundle's dispatch emits
const RE_EMIT_NOTE_MS = 10 * 60 * 1000;
const MAX_BUFFER = 64 * 1024 * 1024;
const LEDGER_VERSION = 1;
const STEP_NAMES = ['publish branch', 'dispatch self-test', 'body pending', 'run green', 'body final', 're-review comment', 're-request reviewers', 'postcondition'];
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA_RE = /^[0-9a-f]{40}$/i;
const BRANCH_RE = /^[A-Za-z0-9._/-]+$/;

class UsageError extends Error {}
class StepFail extends Error {}

const marker = (head) => `<!-- pr-update ${head} -->`;
const lower = (s) => String(s || '').toLowerCase();
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function shq(a) {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`;
}
const cmdText = (argv) => argv.map(shq).join(' ');

/** The one read seam: spawn with an argv array, no shell. */
function read(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: MAX_BUFFER, ...opts });
  if (r.error || r.status !== 0) {
    const why = (r.stderr || (r.error && r.error.message) || '').split('\n')[0];
    throw new StepFail(`${cmd} ${args.slice(0, 3).join(' ')} failed (${r.status}): ${why}`);
  }
  return r.stdout;
}
const readJson = (cmd, args, opts) => JSON.parse(read(cmd, args, opts));
const ghApi = (p) => readJson('gh', ['api', p]);
const ghApiAll = (p) => readJson('gh', ['api', '--paginate', '--slurp', p]).flat();

// ---------- context budget ----------

function ctxFromTranscript(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new UsageError(`cannot read transcript ${file}: ${e.message}`);
  }
  const lines = text.split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    let o;
    try {
      o = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    const m = o && o.message;
    const u = m && m.usage;
    if (!u || (m.model && m.model === '<synthetic>')) continue;
    const sum = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
    if (sum > 0) return sum;
  }
  throw new UsageError(`no assistant line with usage above 0 in ${file}; pass --ctx-tokens N instead`);
}

function checkBudget(opts) {
  const budget = opts.budget ? Number(opts.budget) : CTX_BUDGET_TOKENS;
  let used;
  if (opts['ctx-tokens'] !== undefined) {
    if (!/^[0-9]+$/.test(opts['ctx-tokens'])) throw new UsageError('--ctx-tokens must be a plain non-negative integer');
    used = Number(opts['ctx-tokens']);
  }
  else if (opts.transcript) used = ctxFromTranscript(opts.transcript);
  else throw new UsageError('context size unknown: pass --ctx-tokens N or --transcript <session.jsonl> (the script cannot read the session size itself)');
  if (!Number.isFinite(used) || used < 0 || !Number.isFinite(budget)) throw new UsageError('--ctx-tokens and --budget must be numbers');
  if (used > budget) {
    throw new UsageError(`session is at ${used} tokens, above the ${budget} budget: the ledger is the resume note, so hand this bundle to a fresh session and re-run there`);
  }
}

// ---------- body helpers ----------

/** Lines of `body`, each tagged with whether it sits inside a code fence (the fence lines themselves count as inside). */
function scanFences(body) {
  const lines = body.split('\n');
  let fence = false;
  return lines.map((text) => {
    const isFence = /^\s*(```|~~~)/.test(text);
    const inside = fence || isFence;
    if (isFence) fence = !fence;
    return { text, inside };
  });
}

function sectionBounds(lines) {
  const start = lines.findIndex((l) => !l.inside && /^##\s+self-test report\s*$/i.test(l.text));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (!lines[i].inside && /^##\s/.test(lines[i].text)) {
      end = i;
      break;
    }
  }
  return { start, end };
}

/** Replace the `## Self-test report` section whole (fence-aware); insert before `## Checklist`, else append. */
function replaceSelfTestSection(body, section) {
  const lines = scanFences(body);
  const text = lines.map((l) => l.text);
  const sec = section.endsWith('\n') ? section : section + '\n';
  const b = sectionBounds(lines);
  if (b) return [...text.slice(0, b.start), ...(sec + '\n').split('\n').slice(0, -1), ...text.slice(b.end)].join('\n');
  const at = lines.findIndex((l) => !l.inside && /^##\s+checklist\b/i.test(l.text));
  if (at >= 0) return [...text.slice(0, at), ...(sec + '\n').split('\n').slice(0, -1), ...text.slice(at)].join('\n');
  return body.replace(/\n*$/, '\n\n') + sec;
}

function selfTestSection(body) {
  const lines = scanFences(body);
  const b = sectionBounds(lines);
  return b ? lines.slice(b.start, b.end).map((l) => l.text).join('\n') : null;
}

function selfTestReport(body) {
  const sec = selfTestSection(body);
  if (sec == null) return null;
  const m = sec.match(/```json\n([\s\S]*?)\n```/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

/** The last 40 lines of the program output, whole leading lines dropped until .length <= 2000; never edited. */
function buildExcerpt(text) {
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  let tail = lines.slice(-EXCERPT_LINES);
  while (tail.length > 0 && tail.join('\n').length > EXCERPT_MAX) tail = tail.slice(1);
  if (tail.length === 0) throw new StepFail(`the last output line alone exceeds ${EXCERPT_MAX} characters; no excerpt can be quoted unedited`);
  return tail.join('\n');
}

function pendingLine(ledger) {
  const ids = ledger.steps.filter((s) => s.state !== 'done').map((s) => s.id);
  if (ids.length === 0) return null;
  const parts = [];
  for (let i = 0; i < ids.length; ) {
    let j = i;
    while (j + 1 < ids.length && ids[j + 1] === ids[j] + 1) j += 1;
    parts.push(j > i ? `${ids[i]}-${ids[j]}` : String(ids[i]));
    i = j + 1;
  }
  return `bundle pending: ${ledger.repo}#${ledger.pr} steps ${parts.join(',')}`;
}

// ---------- ledger and lock ----------

const ledgerBase = (dir, repo, pr) => path.join(dir, `${repo.replace('/', '__')}__${pr}`);

function parseLedger(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  let l;
  try {
    l = JSON.parse(text.trim());
  } catch {
    throw new UsageError(`ledger ${file} is not valid JSON; refusing to repair it (move it aside to start over)`);
  }
  if (!l || l.v !== LEDGER_VERSION || !Array.isArray(l.steps) || l.steps.length !== STEP_NAMES.length) {
    throw new UsageError(`ledger ${file} has an unknown version or shape; refusing to repair it`);
  }
  return l;
}

function writeLedger(file, l) {
  l.updated = new Date().toISOString();
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(l) + '\n');
  fs.renameSync(tmp, file);
}

function newLedger(o) {
  const now = new Date().toISOString();
  return {
    v: LEDGER_VERSION,
    repo: o.repo,
    pr: Number(o.pr),
    head: o.head,
    branch: o.branch,
    remote: o.remote,
    fork: o.fork,
    created: now,
    updated: now,
    runId: null,
    runUrl: null,
    artifactDir: null,
    counts: null,
    dispatchSeen: null,
    dispatchChurn: 0,
    steps: STEP_NAMES.map((name, i) => ({ id: i + 1, name, state: 'pending', at: null, emittedAt: null, note: null })),
  };
}

function acquireLock(lock) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, host: os.hostname(), at: new Date().toISOString() }), { flag: 'wx' });
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let held = {};
      try {
        held = JSON.parse(fs.readFileSync(lock, 'utf8'));
      } catch {
        /* unreadable lock: treated as held */
      }
      let dead = false;
      if (held.host === os.hostname() && Number.isInteger(held.pid)) {
        try {
          process.kill(held.pid, 0);
        } catch (k) {
          dead = k.code === 'ESRCH';
        }
      }
      if (!dead) throw new UsageError(`lock ${lock} is held (pid ${held.pid} on ${held.host} since ${held.at}); if that session is gone run: node ${__filename} unlock --repo R --pr N --reason <why>`);
      process.stderr.write(`stale lock (pid ${held.pid} is dead on this host) replaced: ${lock}\n`);
      fs.rmSync(lock, { force: true });
    }
  }
  throw new UsageError(`could not take lock ${lock}`);
}

// ---------- report inputs ----------

function placeholderIn(v) {
  if (typeof v === 'string') return /^<[^<>]*>$/.test(v.trim());
  if (Array.isArray(v)) return v.some(placeholderIn);
  if (v && typeof v === 'object') return Object.values(v).some(placeholderIn);
  return false;
}

function loadReportInputs(file) {
  if (!file) throw new UsageError('--report-inputs <json> is required (failing_first and commands come from the P3b/P3c runs, not from this script)');
  let j;
  try {
    j = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new UsageError(`--report-inputs ${file}: ${e.message}`);
  }
  const ff = j && j.failing_first;
  const ffOk = ff && typeof ff === 'object' && ((typeof ff.test === 'string' && ff.test && ff.fails_on_base === true && ff.passes_on_head === true) || (typeof ff.not_applicable_reason === 'string' && ff.not_applicable_reason));
  if (!ffOk) throw new UsageError('--report-inputs: failing_first needs {test,fails_on_base:true,passes_on_head:true} or {not_applicable_reason}');
  if (!Array.isArray(j.commands) || j.commands.length === 0 || !j.commands.every((c) => typeof c === 'string' && c)) throw new UsageError('--report-inputs: commands must be a non-empty list of strings');
  if (placeholderIn(j)) throw new UsageError('--report-inputs: a value is still a <placeholder>');
  return { failing_first: ff, commands: j.commands };
}

// ---------- the steps ----------

function makeContext(o, ledger, work) {
  const prUrl = ['--repo', o.repo];
  const ctx = {
    o,
    ledger,
    work,
    prView() {
      const v = readJson('gh', ['pr', 'view', String(ledger.pr), ...prUrl, '--json', 'headRefOid,headRefName,isCrossRepository,headRepositoryOwner,body,title']);
      v.body = String(v.body || '').replace(/\r\n/g, '\n'); // a CRLF body would hide every heading and fence from the scanners
      return v;
    },
    assertHeadStill() {
      const v = ctx.prView();
      if (lower(v.headRefOid) !== lower(ledger.head)) throw new StepFail(`head moved: the PR headRefOid is ${v.headRefOid}, this bundle is for ${ledger.head}; start a new bundle for the new head`);
      return v;
    },
    prStatus() {
      const script = process.env.PR_UPDATE_PRSTATUS || path.join(__dirname, 'pr-status.cjs');
      const r = spawnSync(process.execPath, [script, '--json', '--body', ...prUrl, String(ledger.pr)], { encoding: 'utf8', maxBuffer: MAX_BUFFER });
      let j = null;
      try {
        j = JSON.parse(r.stdout);
      } catch {
        /* handled below */
      }
      const first = Array.isArray(j) ? j[0] : null;
      if (r.status !== 0 || !first || first.error) {
        throw new StepFail(`pr-status read failed (exit ${r.status}): ${(first && first.error) || (r.stderr || '').split('\n')[0] || 'no JSON'}`);
      }
      return first;
    },
    writeWork(name, text) {
      fs.mkdirSync(work, { recursive: true });
      const p = path.join(work, name);
      fs.writeFileSync(p, text);
      return p;
    },
  };
  return ctx;
}

/** CHANGES_REQUESTED reviewers whose review is on an OLDER commit; one already on the head is the author's to answer. */
function crToRerequest(st) {
  return (st.reviewers || []).filter((r) => r.state === 'CHANGES_REQUESTED' && r.onHead !== true).map((r) => r.login);
}

const emit = (...cmds) => ({ r: 'emit', cmds });
const waitFor = (note) => ({ r: 'await', note });
const done = (note) => ({ r: 'done', note: note || null });

function selftestYml() {
  const j = ghApi(`repos/${EXPERIMENTS}/contents/${WORKFLOW_PATH}?ref=${SELFTEST_BRANCH}`);
  const text = Buffer.from(String(j.content || '').replace(/\n/g, ''), 'base64').toString('utf8');
  const m = text.match(/^\s*SELFTEST_SHA:\s*(\S+)/m);
  return { sha: j.sha, text, selftestSha: m ? m[1] : null };
}

const STEPS = [
  // 1 publish the fork branch
  (c) => {
    const { o, ledger } = c;
    const out = read('git', ['-C', o.worktree, 'ls-remote', o.remote, `refs/heads/${ledger.branch}`]);
    if (out.split('\t')[0].trim() === ledger.head) return done();
    return emit(['git', '-C', o.worktree, 'push', o.remote, `${ledger.head}:refs/heads/${ledger.branch}`]);
  },
  // 2 dispatch the hosted Self-test
  (c) => {
    const { o, ledger } = c;
    const yml = selftestYml();
    if (o['run-id']) {
      const run = ghApi(`repos/${EXPERIMENTS}/actions/runs/${Number(o['run-id'])}`);
      const at = ghApi(`repos/${EXPERIMENTS}/contents/${WORKFLOW_PATH}?ref=${run.head_sha}`);
      const m = Buffer.from(String(at.content || ''), 'base64').toString('utf8').match(/^\s*SELFTEST_SHA:\s*(\S+)/m);
      if (!m || lower(m[1]) !== lower(ledger.head)) throw new StepFail(`--run-id ${o['run-id']} ran SELFTEST_SHA ${m ? m[1] : 'none'}, not ${ledger.head}`);
      ledger.runId = run.id;
      ledger.runUrl = run.html_url;
      return done(`adopted run ${run.id}`);
    }
    if (yml.selftestSha && lower(yml.selftestSha) === lower(ledger.head)) {
      const branchHead = ghApi(`repos/${EXPERIMENTS}/branches/${SELFTEST_BRANCH}`).commit.sha;
      const runs = ghApi(`repos/${EXPERIMENTS}/actions/runs?branch=${SELFTEST_BRANCH}&event=push&per_page=30`).workflow_runs || [];
      const run = runs.find((r) => r.head_sha === branchHead);
      if (!run) return waitFor(`no run yet for the ${SELFTEST_BRANCH} commit ${branchHead}`);
      ledger.runId = run.id;
      ledger.runUrl = run.html_url;
      return done(`run ${run.id}`);
    }
    // Re-emitting the same write after a dead session is fine; SELFTEST_SHA moving under us means another bundle shares the branch.
    if (ledger.dispatchSeen && ledger.dispatchSeen !== yml.selftestSha) ledger.dispatchChurn += 1;
    if (ledger.dispatchChurn > MAX_DISPATCH_CHURN) {
      throw new StepFail(`SELFTEST_SHA on ${SELFTEST_BRANCH} changed ${ledger.dispatchChurn} times between this bundle's dispatch emits (now ${yml.selftestSha}): another bundle is rewriting it; settle that first`);
    }
    ledger.dispatchSeen = yml.selftestSha;
    const next = yml.text.replace(/^(\s*SELFTEST_SHA:\s*)\S+/m, `$1${ledger.head}`);
    const file = c.writeWork('selftest.b64', Buffer.from(next).toString('base64'));
    return emit(['gh', 'api', '-X', 'PUT', `repos/${EXPERIMENTS}/contents/${WORKFLOW_PATH}`, '-f', `message=selftest: run gsd-core ${ledger.head.slice(0, 9)} (PR ${ledger.pr})`, '-f', `branch=${SELFTEST_BRANCH}`, '-f', `sha=${yml.sha}`, '-F', `content=@${path.resolve(file)}`]);
  },
  // 3 body "Self-test pending for <head>"
  (c) => {
    const { o, ledger } = c;
    const v = c.assertHeadStill();
    const report = selfTestReport(v.body);
    if ((selfTestSection(v.body) || '').includes(`Self-test pending for ${ledger.head}`) || (report && lower(report.head_sha) === lower(ledger.head))) return done();
    const file = c.writeWork('body-pending.md', replaceSelfTestSection(v.body, `## Self-test report\n\nSelf-test pending for ${ledger.head}\n`));
    return emit(['gh', 'pr', 'edit', String(ledger.pr), '--repo', o.repo, '--body-file', path.resolve(file)]);
  },
  // 4 the hosted run is green
  (c) => {
    const { ledger } = c;
    if (!ledger.runId) throw new StepFail('no hosted run recorded: step 2 has not seen one');
    const run = ghApi(`repos/${EXPERIMENTS}/actions/runs/${ledger.runId}`);
    if (run.status !== 'completed') return waitFor(`run ${ledger.runId} is ${run.status}; arm: node ~/repos/dev-env/scripts/event-monitor.mjs (or poll: gh run view ${ledger.runId} --repo ${EXPERIMENTS}); then re-run`);
    if (run.conclusion !== 'success') {
      throw new StepFail(`run ${ledger.runId} conclusion ${run.conclusion}; if the cause is the runner, rerun it yourself as its own call: gh run rerun ${ledger.runId} --repo ${EXPERIMENTS} --failed (then re-run this script); a red suite needs a fix and a new head`);
    }
    const dir = path.join(c.work, `run-${ledger.runId}-${Date.now()}`);
    fs.mkdirSync(c.work, { recursive: true });
    read('gh', ['run', 'download', String(ledger.runId), '--repo', EXPERIMENTS, '-n', 'selftest', '-D', dir]);
    const head = fs.readFileSync(path.join(dir, 'head.txt'), 'utf8').split('\n').filter((l) => l !== '');
    if (lower(head[0]) !== lower(ledger.head)) throw new StepFail(`head.txt names ${head[0]}, not the bundle head ${ledger.head}`);
    const exit = head[head.length - 1];
    if (exit !== 'exit=0') throw new StepFail(`head.txt says ${exit} (the suite ran red even though the run concluded success)`);
    const out = fs.readFileSync(path.join(dir, 'npmtest.out'), 'utf8');
    const sums = { tests: 0, pass: 0, fail: 0, skipped: 0, todo: 0 };
    let summaries = 0;
    for (const line of out.split('\n')) {
      const m = line.match(/^# (tests|pass|fail|skipped|todo) (\d+)$/);
      if (m) {
        sums[m[1]] += Number(m[2]);
        if (m[1] === 'pass') summaries += 1;
      }
    }
    const chunks = [...out.matchAll(/^run-tests: chunk (\d+)\/(\d+) completed/gm)].map((m) => Number(m[2]));
    const k = chunks.length ? chunks[chunks.length - 1] : 0;
    if (k < 1 || summaries !== k) throw new StepFail(`chunk count: ${summaries} pass summaries for ${k} chunks`);
    if (sums.fail !== 0) throw new StepFail(`summed # fail is ${sums.fail}`);
    ledger.artifactDir = dir;
    ledger.counts = sums;
    return done(`tests ${sums.tests} pass ${sums.pass} fail ${sums.fail} skipped ${sums.skipped} todo ${sums.todo}`);
  },
  // 5 body final: excerpt, run URL, head, counts
  (c) => {
    const { o, ledger } = c;
    const v = c.assertHeadStill();
    const sec = selfTestSection(v.body);
    const report = selfTestReport(v.body);
    if (report && lower(report.head_sha) === lower(ledger.head) && sec.includes(ledger.runUrl) && !sec.includes('Self-test pending for')) return done();
    const inputs = loadReportInputs(o['report-inputs']);
    const headTxt = fs.readFileSync(path.join(ledger.artifactDir, 'head.txt'), 'utf8').split('\n').filter((l) => l !== '');
    const out = fs.readFileSync(path.join(ledger.artifactDir, 'npmtest.out'), 'utf8');
    const block = {
      schema: 1,
      head_sha: ledger.head,
      tool: 'npm-test',
      failing_first: inputs.failing_first,
      commands: inputs.commands,
      full_suite: { command: 'npm test', result: 'passed', passed: ledger.counts.pass, failed: ledger.counts.fail },
      environment: { os: headTxt[2], node: headTxt[1] },
      output_excerpt: buildExcerpt(out),
    };
    const section = `## Self-test report\n\nHosted run: ${ledger.runUrl}\n\n\`\`\`json\n${JSON.stringify(block, null, 2)}\n\`\`\`\n`;
    const body = replaceSelfTestSection(v.body, section);
    const file = path.resolve(c.writeWork('body-final.md', body));
    runPolicy(c, v, file);
    return emit(['gh', 'pr', 'edit', String(ledger.pr), '--repo', o.repo, '--body-file', file]);
  },
  // 6 re-review comment
  (c) => {
    const { o, ledger } = c;
    const v = c.assertHeadStill();
    const comments = ghApiAll(`repos/${o.repo}/issues/${ledger.pr}/comments?per_page=100`);
    if ((Array.isArray(comments) ? comments : []).some((m) => String(m.body || '').includes(marker(ledger.head)))) return done();
    let text = '';
    try {
      text = fs.readFileSync(o.findings, 'utf8');
    } catch {
      /* refused below */
    }
    if (!text.trim() || !/\b[0-9a-f]{7,40}\b/.test(text)) throw new UsageError('--findings must be a file mapping each open finding to a commit (at least one 7-40 hex commit ref)');
    const file = c.writeWork('comment.md', `${marker(ledger.head)}\n${text.replace(/\n*$/, '\n')}`);
    void v;
    return emit(['gh', 'pr', 'comment', String(ledger.pr), '--repo', o.repo, '--body-file', path.resolve(file)]);
  },
  // 7 re-request the CHANGES_REQUESTED reviewers
  (c) => {
    const { o, ledger } = c;
    const st = c.prStatus();
    const cr = crToRerequest(st);
    const requested = (st.requested || []).map(lower);
    const missing = cr.filter((l) => !requested.includes(lower(l)));
    if (missing.length === 0) return done(cr.length ? null : 'no CHANGES_REQUESTED reviewer');
    c.assertHeadStill();
    return emit(['gh', 'api', '-X', 'POST', `repos/${o.repo}/pulls/${ledger.pr}/requested_reviewers`, ...missing.flatMap((l) => ['-f', `reviewers[]=${l}`])]);
  },
  // 8 postcondition
  (c) => {
    const { ledger } = c;
    const st = c.prStatus();
    const bad = [];
    const bound = st.body && st.body.selfTest;
    if (!bound || bound.status !== 'bound' || lower(bound.headSha) !== lower(ledger.head)) bad.push(`the Self-test block is not bound to ${ledger.head} (body.selfTest ${JSON.stringify(bound || null)})`);
    // W-B (quick 261113-wb1): the excerpt must be in THIS run's log (the run URL is the ledger's run).
    const ex = st.body && st.body.excerpt;
    if (!ex || ex.status !== 'ok') bad.push(`excerpt check is ${ex ? ex.status : 'absent'} (needs ok: every excerpt line in the run log, run URL present)`);
    else {
      // pr-status's headMatch compares the run's own head sha (the selftest/run commit in the experiments repo, never the gsd-core head)
      // with the PR head, so it is false or null for every hosted run. The binding to the PR head is head.txt line 1, checked in step 4.
      if (lower(ex.runUrl) !== lower(ledger.runUrl)) bad.push(`the excerpt is checked against ${ex.runUrl}, not this bundle's run ${ledger.runUrl}`);
    }
    const pol = st.policies && st.policies.selfTest;
    if (pol && !(pol.status === 'green' && pol.reason === 'ok_report')) bad.push(`policies.selfTest is ${pol.status}/${pol.reason}`);
    if (((st.checks && st.checks.failing) || []).includes('Self-test report')) bad.push('the "Self-test report" check is failing (it may not have re-run since the body edit)');
    const requested = (st.requested || []).map(lower);
    for (const login of crToRerequest(st)) if (!requested.includes(lower(login))) bad.push(`${login} is CHANGES_REQUESTED and not re-requested`);
    const body = c.prView().body;
    const sec = selfTestSection(body) || '';
    if (!ledger.runUrl || !sec.includes(ledger.runUrl)) bad.push('the Self-test section does not hold the run URL');
    if (bad.length) throw new StepFail(bad.join('; '));
    return done();
  },
];

/** Run the LIVE self-test-report policy on the exact composed body; refuse unless it says ok_report. */
function runPolicy(c, view, bodyFile) {
  let dir = c.o['policy-dir'];
  let tmp = null;
  if (!dir) {
    const core = c.o['core-dir'] || path.join(os.homedir(), 'repos', 'gsd-core');
    const fetched = spawnSync('git', ['-C', core, 'fetch', '-q', 'origin', 'next'], { encoding: 'utf8' });
    if (fetched.status !== 0) throw new StepFail(`cannot fetch origin/next in ${core} (${String(fetched.stderr).split('\n')[0]}); the policy would be judged from a stale ref: fix the fetch or pass --policy-dir with a fresh extract`);
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-update-policy-'));
    const tar = spawnSync('git', ['-C', core, 'archive', 'origin/next', 'scripts', '.github/MAINTAINERS'], { maxBuffer: MAX_BUFFER });
    if (tar.status !== 0) throw new StepFail(`cannot read the live policy from ${core} (git archive origin/next): ${String(tar.stderr).split('\n')[0]}`);
    const x = spawnSync('tar', ['-x', '-C', tmp], { input: tar.stdout });
    if (x.status !== 0) throw new StepFail('cannot extract the live policy archive');
    dir = tmp;
  }
  try {
    const titleFile = path.resolve(c.writeWork('title.txt', `${view.title}\n`));
    const r = spawnSync(process.execPath, ['scripts/self-test-report-policy.cjs'], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, PR_BODY_FILE: bodyFile, PR_TITLE_FILE: titleFile, HEAD_REF: view.headRefName, PR_AUTHOR_LOGIN: (view.headRepositoryOwner && view.headRepositoryOwner.login) || '', HEAD_SHA: c.ledger.head, MAINTAINERS_FILE: path.join(dir, '.github', 'MAINTAINERS') },
    });
    let j = null;
    try {
      j = JSON.parse(String(r.stdout).trim().split('\n').pop());
    } catch {
      /* handled below */
    }
    if (!j || j.reason !== 'ok_report') throw new StepFail(`the live self-test-report policy did not say ok_report: ${j ? `${j.reason} ${JSON.stringify(j.problems || [])}` : `no JSON (${String(r.stderr).split('\n')[0]})`}`);
  } finally {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------- CLI ----------

const USAGE = 'usage: pr-update run --repo owner/name --pr N --head <sha> --branch <b> --remote <r> --worktree <dir> --fork davesienkowski/gsd-core --report-inputs <json> --findings <md> (--ctx-tokens N | --transcript <jsonl>) [--budget N] [--ledger-dir D] [--policy-dir P | --core-dir C] [--run-id N] [--supersede --reason T] | --pending [--ledger-dir D] | status --repo R --pr N | unlock --repo R --pr N --reason T';

function parseArgs(argv) {
  const o = { _: [] };
  const flags = new Set(['pending', 'supersede']);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      o._.push(a);
      continue;
    }
    const k = a.slice(2);
    if (flags.has(k)) o[k] = true;
    else if (i + 1 < argv.length) {
      o[k] = argv[i + 1];
      i += 1;
    } else throw new UsageError(`${a} needs a value\n${USAGE}`);
  }
  return o;
}

function required(o) {
  if (!REPO_RE.test(o.repo || '')) throw new UsageError(`--repo owner/name is required\n${USAGE}`);
  if (!/^[1-9][0-9]*$/.test(String(o.pr || ''))) throw new UsageError(`--pr must be a positive integer\n${USAGE}`);
}

const ledgerDirOf = (o) => o['ledger-dir'] || process.env.PR_UPDATE_LEDGER_DIR || path.join(os.homedir(), 'repos', 'gsd-core-notes', 'ledgers', 'pr-update');

function runBundle(o) {
  required(o);
  if (!SHA_RE.test(o.head || '')) throw new UsageError('--head must be a 40-hex commit sha');
  for (const k of ['branch', 'remote', 'worktree']) if (!o[k]) throw new UsageError(`--${k} is required`);
  if (!BRANCH_RE.test(o.branch)) throw new UsageError('--branch has characters outside [A-Za-z0-9._/-]');
  if (o.fork !== SELFTEST_FORK) throw new UsageError(`--fork must be ${SELFTEST_FORK}: the hosted runner clones that repo only`);
  o.head = o.head.toLowerCase();
  checkBudget(o);
  if (o.supersede && !o.reason) throw new UsageError('--supersede needs --reason <text>');

  const dir = ledgerDirOf(o);
  fs.mkdirSync(dir, { recursive: true });
  const base = ledgerBase(dir, o.repo, o.pr);
  const file = `${base}.jsonl`;
  const work = `${base}.work`;
  acquireLock(`${file}.lock`);
  try {
    // Preconditions read the PR once; a refusal here leaves no ledger.
    const pre = readJson('gh', ['pr', 'view', String(o.pr), '--repo', o.repo, '--json', 'isCrossRepository,headRepositoryOwner,headRefName']);
    if (!pre.isCrossRepository) throw new UsageError(`PR ${o.repo}#${o.pr} is not from a fork: the bundle publishes to ${SELFTEST_FORK} only and never writes to ${o.repo}`);
    const url = read('git', ['-C', o.worktree, 'remote', 'get-url', o.remote]).trim();
    const pushUrl = read('git', ['-C', o.worktree, 'remote', 'get-url', '--push', o.remote]).trim();
    const forkUrl = (u) => /^(https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)davesienkowski\/gsd-core(\.git)?\/?$/i.test(u);
    for (const [kind, u] of [['fetch', url], ['push', pushUrl]]) {
      if (!forkUrl(u)) throw new UsageError(`--remote ${o.remote} ${kind} URL resolves to ${u}, not ${SELFTEST_FORK}: the bundle publishes to the fork only`);
    }
    if (pre.headRefName !== o.branch) throw new UsageError(`--branch ${o.branch} is not the PR's headRefName ${pre.headRefName}`);
    if (pre.headRepositoryOwner && lower(pre.headRepositoryOwner.login) !== lower(SELFTEST_FORK.split('/')[0])) throw new UsageError(`PR head repository owner is ${pre.headRepositoryOwner.login}, not ${SELFTEST_FORK.split('/')[0]}`);

    let ledger = parseLedger(file);
    if (ledger && (ledger.head !== o.head || o.supersede)) {
      const history = `${base}.history.jsonl`;
      const finished = ledger.steps.every((s) => s.state === 'done');
      if (!finished && !o.supersede) throw new UsageError(`an unfinished bundle for head ${ledger.head} exists (${pendingLine(ledger)}); finish it, or start over with --supersede --reason <text>`);
      fs.appendFileSync(history, JSON.stringify({ archivedAt: new Date().toISOString(), reason: o.reason || 'finished', ledger }) + '\n');
      ledger = null;
    }
    if (!ledger) {
      ledger = newLedger(o);
      writeLedger(file, ledger); // BEFORE step 1: a session that dies now leaves an exact to-do list
    }
    const c = makeContext(o, ledger, work);
    const save = () => writeLedger(file, ledger);

    for (let i = 0; i < STEPS.length; i += 1) {
      const step = ledger.steps[i];
      // Steps 1, 2 and 4 are monotonic facts (a published commit, a finished run, a stored artifact): trusted once recorded.
      const trusted = step.state === 'done' && [0, 1, 3].includes(i) && (i !== 3 || (ledger.artifactDir && fs.existsSync(ledger.artifactDir)));
      if (trusted) continue;
      let res;
      try {
        res = STEPS[i](c);
      } catch (e) {
        if (e instanceof StepFail) {
          step.state = 'pending';
          step.note = e.message;
          save();
          process.stdout.write(`FAILED step ${step.id} (${step.name}): ${e.message}\n`);
          return 1;
        }
        save();
        throw e;
      }
      if (res.r === 'done') {
        step.state = 'done';
        step.at = new Date().toISOString();
        step.note = res.note;
        save();
        process.stdout.write(`step ${step.id} ${step.name}: done${res.note ? ` (${res.note})` : ''}\n`);
        continue;
      }
      step.state = 'pending';
      if (res.r === 'await') {
        step.note = res.note;
        save();
        process.stdout.write(`AWAITING: step ${step.id} (${step.name}): ${res.note}\n`);
        return 3;
      }
      if (step.emittedAt && Date.now() - Date.parse(step.emittedAt) < RE_EMIT_NOTE_MS) {
        process.stderr.write(`NOTE: step ${step.id} was already emitted at ${step.emittedAt}; the reads decide, so it is emitted again\n`);
      }
      step.emittedAt = new Date().toISOString();
      step.note = null;
      save();
      const lines = res.cmds.map(cmdText);
      fs.mkdirSync(work, { recursive: true });
      fs.writeFileSync(path.join(work, `next-${step.id}.txt`), lines.join('\n') + '\n');
      for (const l of lines) process.stdout.write(`NEXT: ${l}\n`);
      process.stdout.write(`run it as its own call, then re-run: node ${__filename} run ... (step ${step.id}: ${step.name})\n`);
      return 3;
    }
    process.stdout.write(`all ${STEPS.length} steps verified for ${o.repo}#${o.pr} at ${o.head}\n`);
    return 0;
  } finally {
    fs.rmSync(`${file}.lock`, { force: true });
  }
}

function pending(o) {
  const dir = ledgerDirOf(o);
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl') && !n.endsWith('.history.jsonl')).sort();
  } catch {
    return 0;
  }
  for (const n of names) {
    try {
      const l = parseLedger(path.join(dir, n));
      const line = l && pendingLine(l);
      if (line) process.stdout.write(`${line}\n`);
    } catch (e) {
      process.stdout.write(`bundle unreadable: ${n}\n`);
    }
  }
  return 0;
}

function runCli(argv) {
  try {
    const o = parseArgs(argv);
    if (o.pending) return pending(o);
    const verb = o._[0];
    if (verb === 'run') return runBundle(o);
    if (verb === 'status') {
      required(o);
      const l = parseLedger(`${ledgerBase(ledgerDirOf(o), o.repo, o.pr)}.jsonl`);
      if (!l) throw new UsageError('no ledger for that PR');
      for (const s of l.steps) process.stdout.write(`step ${s.id} ${s.name}: ${s.state}${s.note ? ` (${s.note})` : ''}\n`);
      return 0;
    }
    if (verb === 'unlock') {
      required(o);
      if (!o.reason) throw new UsageError('unlock needs --reason <text>');
      const lock = `${ledgerBase(ledgerDirOf(o), o.repo, o.pr)}.jsonl.lock`;
      fs.rmSync(lock, { force: true });
      process.stdout.write(`unlocked ${lock}: ${o.reason}\n`);
      return 0;
    }
    throw new UsageError(USAGE);
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`${e.message}\n`);
      return 2;
    }
    if (e instanceof StepFail) {
      process.stdout.write(`FAILED: ${e.message}\n`);
      return 1;
    }
    throw e;
  }
}

module.exports = { buildExcerpt, ctxFromTranscript, pendingLine, replaceSelfTestSection, runCli, CTX_BUDGET_TOKENS };

if (require.main === module) process.exitCode = runCli(process.argv.slice(2));
