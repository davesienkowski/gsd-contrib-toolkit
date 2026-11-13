'use strict';

/**
 * bin/pr-update.test.cjs - HERMETIC test of the resumable two-phase PR update (`bin/pr-update.cjs`, quick 261113-wc1).
 *
 * What this pins:
 *   - the DRIVER contract: `run` walks eight steps, verifies each against READ-ONLY commands it runs itself, and
 *     EMITS (never spawns) the write for the first unverified step, exit 3. The stub gh/git
 *     (bin/fixtures/pr-update-stub.cjs) refuses every write verb; each test asserts it refused nothing.
 *   - the durable ledger: written with all steps pending before the first read, updated per step, garbage refused,
 *     a different head archived or refused, a lock with a live or dead pid.
 *   - the #5871 regressions: a red hosted run never advances (exit=1 under a green conclusion, wrong head, short
 *     chunk count), the excerpt stays byte-exact (real em dash), the run URL lands in the block.
 *   - the context budget, refusing without a source or above 600000 tokens.
 *
 * @module bin/pr-update.test
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, 'pr-update.cjs');
const STUB = path.join(__dirname, 'fixtures', 'pr-update-stub.cjs');
const PRSTATUS_STUB = path.join(__dirname, 'fixtures', 'pr-update-prstatus-stub.cjs');
const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const EXP = 'davesienkowski/gsd-core-experiments';
const RUN_URL = `https://github.com/${EXP}/actions/runs/77`;
const EM = '—';

/** A npmtest.out shaped like the real run 42744528257: chunk banners with an em dash, TAP totals per chunk. */
function npmtest({ chunks = 3, fail = 0, summaries = chunks } = {}) {
  const L = [];
  for (let k = 1; k <= chunks; k += 1) {
    L.push(`run-tests: chunk ${k}/${chunks} ${EM} 60 files`);
    if (k <= summaries) L.push('# tests 10', '# suites 0', '# pass ' + (10 - fail), '# fail ' + fail, '# skipped 1', '# todo 0');
    L.push(`run-tests: chunk ${k}/${chunks} completed in 5ms`);
  }
  L.push(`run-tests: temp sweep after chunk ${chunks}/${chunks} ${EM} removed 73 leaked entries`);
  return L.join('\n') + '\n';
}

function harness(t, over = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-update-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  for (const n of ['gh', 'git']) {
    fs.copyFileSync(STUB, path.join(bin, n));
    fs.chmodSync(path.join(bin, n), 0o755);
  }
  const art = path.join(root, 'artifact');
  fs.mkdirSync(art);
  fs.writeFileSync(path.join(art, 'head.txt'), `${HEAD}\nv24.22.2\nLinux runner 7.0.0-azure x86_64 GNU/Linux\nexit=0\n`);
  fs.writeFileSync(path.join(art, 'npmtest.out'), npmtest());
  const policy = path.join(root, 'policy');
  fs.mkdirSync(path.join(policy, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(policy, '.github'));
  fs.writeFileSync(path.join(policy, '.github', 'MAINTAINERS'), 'trek-e\n');
  fs.writeFileSync(
    path.join(policy, 'scripts', 'self-test-report-policy.cjs'),
    `const fs=require('fs');const b=fs.readFileSync(process.env.PR_BODY_FILE,'utf8');` +
      `const ok=b.includes('"head_sha": "'+process.env.HEAD_SHA+'"');` +
      `console.log(JSON.stringify({ok,reason:ok?'ok_report':'fail_stale_sha',problems:[]}));process.exitCode=ok?0:1;`,
  );
  const reportInputs = path.join(root, 'report-inputs.json');
  fs.writeFileSync(
    reportInputs,
    JSON.stringify({ failing_first: { test: 'tests/x.test.cjs', fails_on_base: true, passes_on_head: true }, commands: ['node --test tests/x.test.cjs', 'npm test'] }),
  );
  const findings = path.join(root, 'findings.md');
  fs.writeFileSync(findings, 'Major 1 (excerpt edited): fixed in 1234567.\nMinor 2: fixed in abcdef0.\n');
  const stateFile = path.join(root, 'state.json');
  const state = {
    pr: {
      headRefOid: HEAD,
      headRefName: 'fix/5797-x',
      isCrossRepository: true,
      headRepositoryOwner: { login: 'davesienkowski' },
      title: 'fix(#5797): x',
      body: '## Summary\n\nfix.\n\n## Self-test report\n\n```json\n{"schema":1,"head_sha":"' + OLD + '"}\n```\n\n## Checklist\n- [x] a\n',
    },
    remoteHeads: {},
    selftest: { ymlSha: OLD, blobSha: 'blob1', branchHead: 'c0', runs: [], artifactDir: art },
    comments: [],
    prstatus: [],
  };
  const ctx = {
    root,
    state,
    stateFile,
    ledgerDir: path.join(root, 'ledgers'),
    log: path.join(root, 'argv.log'),
    policy,
    reportInputs,
    findings,
    art,
  };
  ctx.save = () => fs.writeFileSync(stateFile, JSON.stringify(ctx.state));
  ctx.save();
  fs.writeFileSync(ctx.log, '');
  ctx.logLines = () => fs.readFileSync(ctx.log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  ctx.ledgerFile = path.join(ctx.ledgerDir, 'open-gsd__gsd-core__5871.jsonl');
  ctx.workDir = path.join(ctx.ledgerDir, 'open-gsd__gsd-core__5871.work');
  ctx.ledger = () => JSON.parse(fs.readFileSync(ctx.ledgerFile, 'utf8').trim());
  ctx.run = (extra = [], { head = HEAD, ctx: tokens = ['--ctx-tokens', '1000'], env = {} } = {}) => {
    const args = [
      SCRIPT, 'run', '--repo', 'open-gsd/gsd-core', '--pr', '5871', '--head', head, '--branch', 'fix/5797-x', '--remote', 'fork',
      '--worktree', root, '--fork', 'davesienkowski/gsd-core', '--report-inputs', reportInputs, '--findings', findings,
      '--ledger-dir', ctx.ledgerDir, '--policy-dir', policy, ...tokens, ...extra,
    ];
    const r = spawnSync(process.execPath, args, {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, PR_UPDATE_STUB_STATE: stateFile, PR_UPDATE_STUB_LOG: ctx.log, PR_UPDATE_PRSTATUS: PRSTATUS_STUB, ...env },
    });
    return { status: r.status, out: r.stdout, err: r.stderr };
  };
  ctx.noWritesSpawned = () => assert.deepEqual(ctx.logLines().filter((l) => l.REFUSED), [], 'pr-update spawned a write verb');
  return Object.assign(ctx, over);
}

const stepState = (h, id) => h.ledger().steps.find((s) => s.id === id).state;

function greenRun(h, id = 77) {
  h.state.selftest.ymlSha = HEAD;
  h.state.selftest.branchHead = 'c1';
  h.state.selftest.runs = [{ id, head_sha: 'c1', status: 'completed', conclusion: 'success', html_url: `https://github.com/${EXP}/actions/runs/${id}` }];
  h.save();
}

/** Drive the bundle to the point just before step 4 (steps 1-3 verified). */
function toStep4(h) {
  h.state.remoteHeads['fork fix/5797-x'] = HEAD;
  greenRun(h);
  h.state.selftest.runs[0].status = 'in_progress';
  h.state.selftest.runs[0].conclusion = null;
  h.state.pr.body = h.state.pr.body.replace(new RegExp(OLD, 'g'), HEAD).replace(/## Self-test report[\s\S]*?## Checklist/, `## Self-test report\n\nSelf-test pending for ${HEAD}\n\n## Checklist`);
  h.save();
}

test('refuses to run without a context-size source, and creates no ledger', (t) => {
  const h = harness(t);
  const r = h.run([], { ctx: [] });
  assert.equal(r.status, 2);
  assert.match(r.err, /--ctx-tokens|--transcript/);
  assert.equal(fs.existsSync(h.ledgerFile), false);
});

test('context budget: 600000 passes, 600001 refuses, --budget overrides', (t) => {
  const h = harness(t);
  assert.equal(h.run([], { ctx: ['--ctx-tokens', '600001'] }).status, 2);
  assert.match(h.run([], { ctx: ['--ctx-tokens', '600001'] }).err, /600001.*600000|600000/);
  assert.equal(h.run([], { ctx: ['--ctx-tokens', '600000'] }).status, 3);
  assert.equal(h.run(['--budget', '700000'], { ctx: ['--ctx-tokens', '650000'] }).status, 3);
  h.noWritesSpawned();
});

test('transcript source: the last real assistant line counts; a synthetic zero-usage last line is skipped; none refuses', (t) => {
  const h = harness(t);
  const line = (model, u) => JSON.stringify({ type: 'assistant', message: { model, usage: u } });
  const big = { input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: 700000 };
  const tr = path.join(h.root, 't.jsonl');
  fs.writeFileSync(tr, [line('claude-opus-5-5', big), line('<synthetic>', { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 })].join('\n') + '\n');
  const over = h.run([], { ctx: ['--transcript', tr] });
  assert.equal(over.status, 2, 'a synthetic last line must not read as 0 tokens');
  fs.writeFileSync(tr, line('claude-opus-5-5', { input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: 5000 }) + '\n');
  assert.equal(h.run([], { ctx: ['--transcript', tr] }).status, 3);
  fs.writeFileSync(tr, line('<synthetic>', { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }) + '\n');
  assert.equal(h.run([], { ctx: ['--transcript', tr] }).status, 2, 'no usable line refuses');
});

test('fresh run: ledger has all eight steps pending, step 1 emits the push as text and spawns nothing', (t) => {
  const h = harness(t);
  const r = h.run();
  assert.equal(r.status, 3);
  assert.match(r.out, new RegExp(`NEXT: git -C '?${h.root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'? push fork ${HEAD}:refs/heads/fix/5797-x`));
  const l = h.ledger();
  assert.equal(l.steps.length, 8);
  assert.ok(l.steps.every((s) => s.state === 'pending'));
  assert.ok(l.steps[0].emittedAt, 'the emit window is recorded');
  h.noWritesSpawned();
});

test('a same-repo PR and a foreign fork are refused (the runner clones davesienkowski/gsd-core only)', (t) => {
  const h = harness(t);
  h.state.pr.isCrossRepository = false;
  h.save();
  assert.equal(h.run().status, 2);
  h.state.pr.isCrossRepository = true;
  h.save();
  const r = h.run(['--fork', 'someone/else']);
  assert.equal(r.status, 2);
  assert.match(r.err, /davesienkowski/);
});

test('step 2 emits the contents PUT with an absolute base64 file carrying the new SELFTEST_SHA', (t) => {
  const h = harness(t);
  h.state.remoteHeads['fork fix/5797-x'] = HEAD;
  h.save();
  const r = h.run();
  assert.equal(r.status, 3);
  assert.equal(stepState(h, 1), 'done');
  assert.match(r.out, new RegExp(`NEXT: gh api -X PUT repos/${EXP}/contents/.github/workflows/selftest.yml`));
  assert.match(r.out, /branch=selftest\/run/);
  assert.match(r.out, /sha=blob1/);
  const b64 = fs.readFileSync(path.join(h.workDir, 'selftest.b64'), 'utf8');
  assert.ok(!b64.endsWith('\n'), 'no trailing newline in the base64');
  const yml = Buffer.from(b64, 'base64').toString();
  assert.match(yml, new RegExp(`SELFTEST_SHA: ${HEAD}`));
  assert.ok(path.isAbsolute(r.out.match(/content=@(\S+)/)[1].replace(/^'|'$/g, '')));
  h.noWritesSpawned();
});

test('step 2 adopts an existing run when SELFTEST_SHA already equals the head; no run yet means AWAITING', (t) => {
  const h = harness(t);
  h.state.remoteHeads['fork fix/5797-x'] = HEAD;
  h.state.selftest.ymlSha = HEAD;
  h.state.selftest.branchHead = 'c1';
  h.save();
  const waiting = h.run();
  assert.equal(waiting.status, 3);
  assert.match(waiting.out, /AWAITING:/);
  assert.ok(!/NEXT:/.test(waiting.out));
  assert.equal(stepState(h, 2), 'pending');
  greenRun(h);
  const r = h.run();
  assert.equal(stepState(h, 2), 'done');
  assert.equal(h.ledger().runId, 77);
  assert.match(r.out, /NEXT: gh pr edit 5871/, 'moves on to the pending-body write');
  h.noWritesSpawned();
});

test('a third dispatch emit refuses (another bundle keeps rewriting selftest/run)', (t) => {
  const h = harness(t);
  h.state.remoteHeads['fork fix/5797-x'] = HEAD;
  h.save();
  assert.equal(h.run().status, 3);
  assert.equal(h.run().status, 3);
  const third = h.run();
  assert.equal(third.status, 1);
  assert.match(third.out + third.err, /another bundle|rewritten/);
});

test('step 3 emits a body with the Self-test section replaced by the pending line (fence-aware, no stale block)', (t) => {
  const h = harness(t);
  h.state.remoteHeads['fork fix/5797-x'] = HEAD;
  greenRun(h);
  const r = h.run();
  assert.match(r.out, new RegExp(`NEXT: gh pr edit 5871 --repo open-gsd/gsd-core --body-file '?${h.workDir}/body-pending.md`));
  const body = fs.readFileSync(path.join(h.workDir, 'body-pending.md'), 'utf8');
  assert.match(body, new RegExp(`Self-test pending for ${HEAD}`));
  assert.ok(!body.includes('"head_sha"'), 'the stale block is gone');
  assert.match(body, /## Checklist/);
  assert.match(body, /## Summary/);
});

test('step 4: a run still in progress is AWAITING (exit 3), not a failure', (t) => {
  const h = harness(t);
  toStep4(h);
  const r = h.run();
  assert.equal(r.status, 3);
  assert.match(r.out, /AWAITING: .*77/);
  assert.equal(stepState(h, 4), 'pending');
  assert.ok(!/FAILED/.test(r.out));
});

test('step 4 red variants never advance: exit=1 under a green conclusion, wrong head, short chunk count, red conclusion', (t) => {
  const cases = [
    ['exit=1 with conclusion success', (h) => fs.writeFileSync(path.join(h.art, 'head.txt'), `${HEAD}\nv24\nLinux\nexit=1\n`), /exit/],
    ['head.txt names another commit', (h) => fs.writeFileSync(path.join(h.art, 'head.txt'), `${OLD}\nv24\nLinux\nexit=0\n`), /head/],
    ['a failing count', (h) => fs.writeFileSync(path.join(h.art, 'npmtest.out'), npmtest({ fail: 3 })), /fail/],
    ['fewer summaries than chunks', (h) => fs.writeFileSync(path.join(h.art, 'npmtest.out'), npmtest({ summaries: 2 })), /chunk/],
    ['conclusion failure', (h) => { h.state.selftest.runs[0].conclusion = 'failure'; }, /conclusion/],
  ];
  for (const [name, mutate, why] of cases) {
    const h = harness(t);
    toStep4(h);
    h.state.selftest.runs[0].status = 'completed';
    h.state.selftest.runs[0].conclusion = 'success';
    mutate(h);
    h.save();
    const r = h.run();
    assert.equal(r.status, 1, name);
    assert.match(r.out + r.err, why, name);
    assert.equal(stepState(h, 4), 'pending', name);
    assert.ok(h.ledger().steps.slice(4).every((s) => s.state === 'pending'), `${name}: later steps stay pending`);
    assert.ok(!/NEXT:/.test(r.out), `${name}: no write is emitted, so no reviewer is re-requested`);
    h.noWritesSpawned();
  }
});

test('step 4 green: step 5 emits a body whose block carries the head, sums, run URL and the byte-exact excerpt', (t) => {
  const h = harness(t);
  toStep4(h);
  h.state.selftest.runs[0].status = 'completed';
  h.state.selftest.runs[0].conclusion = 'success';
  h.save();
  const r = h.run();
  assert.equal(r.status, 3);
  assert.equal(stepState(h, 4), 'done');
  const body = fs.readFileSync(path.join(h.workDir, 'body-final.md'), 'utf8');
  assert.match(body, new RegExp(`Hosted run: ${RUN_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  const block = JSON.parse(body.match(/## Self-test report[\s\S]*?```json\n([\s\S]*?)\n```/)[1]);
  assert.equal(block.head_sha, HEAD);
  assert.equal(block.tool, 'npm-test');
  assert.deepEqual(block.full_suite, { command: 'npm test', result: 'passed', passed: 30, failed: 0 });
  assert.equal(block.environment.node, 'v24.22.2');
  assert.match(block.environment.os, /Linux/);
  assert.deepEqual(block.commands, ['node --test tests/x.test.cjs', 'npm test']);
  const out = fs.readFileSync(path.join(h.art, 'npmtest.out'), 'utf8');
  assert.ok(out.includes(block.output_excerpt), 'the excerpt is a verbatim slice of the program output');
  assert.ok(block.output_excerpt.includes(EM), 'the em dash survives (R-a)');
  assert.ok(block.output_excerpt.length <= 2000);
  assert.ok(!body.includes('Self-test pending'));
  h.noWritesSpawned();
});

test('buildExcerpt drops whole leading lines to fit 2000 UTF-16 units and refuses an oversize last line', () => {
  const { buildExcerpt } = require('./pr-update.cjs');
  const lines = Array.from({ length: 60 }, (_, i) => `line ${i} ${EM} ${'x'.repeat(80)}`);
  const ex = buildExcerpt(lines.join('\n') + '\n');
  assert.ok(ex.length <= 2000);
  assert.ok(lines.join('\n').endsWith(ex), 'a verbatim suffix made of whole lines');
  assert.ok(ex.startsWith('line '), 'never cut mid-line');
  assert.throws(() => buildExcerpt('ok\n' + 'y'.repeat(2001) + '\n'), /2000/);
});

test('step 5 refuses a placeholder or missing --report-inputs (exit 2) and a policy that does not say ok_report (exit 1)', (t) => {
  const h = harness(t);
  toStep4(h);
  h.state.selftest.runs[0].status = 'completed';
  h.state.selftest.runs[0].conclusion = 'success';
  h.save();
  fs.writeFileSync(h.reportInputs, JSON.stringify({ failing_first: { test: '<tests/x>', fails_on_base: true, passes_on_head: true }, commands: ['npm test'] }));
  assert.equal(h.run().status, 2);
  fs.rmSync(h.reportInputs);
  assert.equal(h.run().status, 2);
  fs.writeFileSync(h.reportInputs, JSON.stringify({ failing_first: { not_applicable_reason: 'docs only' }, commands: ['npm test'] }));
  fs.writeFileSync(path.join(h.policy, 'scripts', 'self-test-report-policy.cjs'), "console.log(JSON.stringify({ok:true,reason:'ok_maintainer_author',problems:[]}))");
  const r = h.run();
  assert.equal(r.status, 1);
  assert.match(r.out + r.err, /ok_report/);
  assert.ok(!/NEXT:/.test(r.out));
});

/** Walk the whole bundle with the caller's writes played by state edits. */
function toStep6(h) {
  toStep4(h);
  h.state.selftest.runs[0].status = 'completed';
  h.state.selftest.runs[0].conclusion = 'success';
  h.save();
  h.run();
  h.state.pr.body = fs.readFileSync(path.join(h.workDir, 'body-final.md'), 'utf8');
  h.save();
}

test('step 6 emits the re-review comment with the marker; findings without a commit ref are refused; an existing marker completes it', (t) => {
  const h = harness(t);
  toStep6(h);
  const r = h.run();
  assert.equal(r.status, 3);
  assert.equal(stepState(h, 5), 'done');
  assert.match(r.out, new RegExp(`NEXT: gh pr comment 5871 --repo open-gsd/gsd-core --body-file '?${h.workDir}/comment.md`));
  const c = fs.readFileSync(path.join(h.workDir, 'comment.md'), 'utf8');
  assert.ok(c.startsWith(`<!-- pr-update ${HEAD} -->`));
  assert.match(c, /Major 1/);
  fs.writeFileSync(h.findings, 'all fixed, trust me\n');
  assert.equal(h.run().status, 2);
  fs.writeFileSync(h.findings, 'Major 1: fixed in 1234567.\n');
  h.state.comments = [{ body: `<!-- pr-update ${HEAD} -->\nMajor 1: fixed in 1234567.` }];
  h.save();
  const again = h.run();
  assert.equal(stepState(h, 6), 'done');
  assert.ok(!/gh pr comment/.test(again.out), 'no duplicate comment is emitted');
  h.noWritesSpawned();
});

test('step 7 re-requests exactly the CHANGES_REQUESTED reviewers not yet requested; step 8 passes only when every postcondition holds', (t) => {
  const h = harness(t);
  toStep6(h);
  h.state.comments = [{ body: `<!-- pr-update ${HEAD} -->\nx 1234567` }];
  const real = (over = {}) => [
    {
      number: 5871,
      head: HEAD,
      reviewers: [{ login: 'trek-e', state: 'CHANGES_REQUESTED' }, { login: 'other', state: 'APPROVED' }],
      requested: [],
      checks: { failing: [], pending: [] },
      body: { selfTest: { status: 'bound', headSha: HEAD } },
      policies: { selfTest: { status: 'green', reason: 'ok_report' } },
      ...over,
    },
  ];
  h.state.prstatus = real();
  h.save();
  const r = h.run();
  assert.equal(r.status, 3);
  assert.match(r.out, /NEXT: gh api -X POST repos\/open-gsd\/gsd-core\/pulls\/5871\/requested_reviewers .*reviewers\[\]=trek-e/);
  assert.ok(!/other/.test(r.out.split('NEXT:')[1]));
  const variants = [
    ['selfTest binding stale', { body: { selfTest: { status: 'stale', headSha: OLD } } }],
    ['policy unknown', { policies: { selfTest: { status: 'unknown', reason: null } } }],
    ['Self-test report check red', { checks: { failing: ['Self-test report'], pending: [] } }],
  ];
  for (const [name, over] of variants) {
    h.state.prstatus = real({ requested: ['trek-e'], ...over });
    h.save();
    const bad = h.run();
    assert.equal(bad.status, 1, name);
    assert.equal(stepState(h, 8), 'pending', name);
  }
  h.state.prstatus = real({ requested: ['trek-e'], checks: { failing: [], pending: ['Self-test report'] } });
  h.save();
  const ok = h.run();
  assert.equal(ok.status, 0, ok.out + ok.err);
  assert.ok(h.ledger().steps.every((s) => s.state === 'done'));
  h.noWritesSpawned();
});

test('step 8 fails on a failed pr-status read (exit 1 with an error key) rather than passing on missing fields', (t) => {
  const h = harness(t);
  toStep6(h);
  h.state.comments = [{ body: `<!-- pr-update ${HEAD} -->\nx` }];
  h.state.prstatus = [{ repo: 'open-gsd/gsd-core', number: 5871, error: 'gh: boom' }];
  h.state.prstatusExit = 1;
  h.save();
  const r = h.run();
  assert.equal(r.status, 1);
  assert.match(r.out + r.err, /boom|pr-status/);
});

test('a head that moved on the PR before a write step fails the step and emits nothing', (t) => {
  const h = harness(t);
  h.state.remoteHeads['fork fix/5797-x'] = HEAD;
  greenRun(h);
  h.state.pr.headRefOid = 'd'.repeat(40);
  h.save();
  const r = h.run();
  assert.equal(r.status, 1);
  assert.match(r.out + r.err, /head moved|headRefOid/);
  assert.ok(!/NEXT:/.test(r.out));
});

test('--pending prints "bundle pending: #N steps a-b", one line per unfinished bundle, nothing when finished', (t) => {
  const h = harness(t);
  h.state.remoteHeads['fork fix/5797-x'] = HEAD;
  h.save();
  h.run();
  const pending = spawnSync(process.execPath, [SCRIPT, '--pending', '--ledger-dir', h.ledgerDir], { encoding: 'utf8' });
  assert.equal(pending.status, 0);
  assert.equal(pending.stdout.trim(), 'bundle pending: open-gsd/gsd-core#5871 steps 2-8');
  const { pendingLine } = require('./pr-update.cjs');
  const l = h.ledger();
  for (const s of l.steps) s.state = [1, 2, 4, 7].includes(s.id) ? 'done' : 'pending';
  assert.equal(pendingLine(l), 'bundle pending: open-gsd/gsd-core#5871 steps 3,5-6,8');
  for (const s of l.steps) s.state = 'done';
  assert.equal(pendingLine(l), null);
});

test('a garbage or foreign-version ledger is refused, never repaired', (t) => {
  const h = harness(t);
  fs.mkdirSync(h.ledgerDir, { recursive: true });
  fs.writeFileSync(h.ledgerFile, 'not json\n');
  assert.equal(h.run().status, 2);
  assert.equal(fs.readFileSync(h.ledgerFile, 'utf8'), 'not json\n');
  fs.writeFileSync(h.ledgerFile, JSON.stringify({ v: 99 }) + '\n');
  assert.equal(h.run().status, 2);
});

test('a different head: a finished bundle is archived to history; an unfinished one is refused unless --supersede --reason', (t) => {
  const h = harness(t);
  assert.equal(h.run().status, 3);
  const second = h.run([], { head: 'e'.repeat(40) });
  assert.equal(second.status, 2);
  assert.match(second.err, /--supersede/);
  assert.equal(h.ledger().head, HEAD, 'the unfinished ledger is untouched');
  assert.equal(h.run(['--supersede'], { head: 'e'.repeat(40) }).status, 2, 'a reason is required');
  const forced = h.run(['--supersede', '--reason', 'author pushed a fix'], { head: 'e'.repeat(40) });
  assert.ok([1, 3].includes(forced.status), forced.err);
  assert.equal(h.ledger().head, 'e'.repeat(40));
  const hist = fs.readFileSync(h.ledgerFile.replace(/\.jsonl$/, '.history.jsonl'), 'utf8');
  assert.match(hist, /author pushed a fix/);
  const done = h.ledger();
  for (const s of done.steps) s.state = 'done';
  fs.writeFileSync(h.ledgerFile, JSON.stringify(done) + '\n');
  h.run([], { head: 'f'.repeat(40) });
  assert.equal(h.ledger().head, 'f'.repeat(40));
  assert.equal(fs.readFileSync(h.ledgerFile.replace(/\.jsonl$/, '.history.jsonl'), 'utf8').trim().split('\n').length, 2);
});

test('lock: a live holder refuses, a dead pid on this host is replaced with a printed line, unlock needs a reason', (t) => {
  const h = harness(t);
  assert.equal(h.run().status, 3);
  const lock = h.ledgerFile + '.lock';
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, host: os.hostname(), at: new Date().toISOString() }));
  const live = h.run();
  assert.equal(live.status, 2);
  assert.match(live.err, /lock/);
  fs.writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 12345, host: os.hostname(), at: '2026-11-13T00:00:00Z' }));
  const dead = h.run();
  assert.equal(dead.status, 3);
  assert.match(dead.err, /stale lock|replaced/);
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, host: 'elsewhere', at: '2026-11-13T00:00:00Z' }));
  assert.equal(h.run().status, 2);
  const un = spawnSync(process.execPath, [SCRIPT, 'unlock', '--repo', 'open-gsd/gsd-core', '--pr', '5871', '--ledger-dir', h.ledgerDir], { encoding: 'utf8' });
  assert.equal(un.status, 2, 'no reason, no unlock');
  const ok = spawnSync(process.execPath, [SCRIPT, 'unlock', '--repo', 'open-gsd/gsd-core', '--pr', '5871', '--ledger-dir', h.ledgerDir, '--reason', 'holder gone'], { encoding: 'utf8' });
  assert.equal(ok.status, 0);
  assert.equal(fs.existsSync(lock), false);
});

test('replaceSelfTestSection is fence-aware: a ## line inside a code fence does not end the section; a missing section is inserted before Checklist', () => {
  const { replaceSelfTestSection } = require('./pr-update.cjs');
  const body = '## A\n\n## Self-test report\n\n```json\n{"x":"\\n## not a heading"}\n## fake\n```\n\ntail text\n\n## Checklist\n- [x] a\n';
  const out = replaceSelfTestSection(body, '## Self-test report\n\nNEW\n');
  assert.ok(out.includes('NEW'));
  assert.ok(!out.includes('fake') && !out.includes('tail text'));
  assert.ok(out.includes('## Checklist') && out.includes('## A'));
  const ins = replaceSelfTestSection('## A\n\n## Checklist\n- [x] a\n', '## Self-test report\n\nNEW\n');
  assert.ok(ins.indexOf('NEW') < ins.indexOf('## Checklist'));
  const app = replaceSelfTestSection('## A\n', '## Self-test report\n\nNEW\n');
  assert.ok(app.endsWith('NEW\n'));
});
