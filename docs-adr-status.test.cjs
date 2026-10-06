'use strict';

/**
 * docs-adr-status.test.cjs — lock tests for the Phase 36 documentation prohibitions
 * (36-VERIFICATION "Prohibitions": 36-05b, 36-06a, 36-06c).
 *
 *   (a) CTK-ADR-0008 is Proposed (Dave has not approved it) and its Status line never says Accepted.
 *   (b) docs/adr/README.md lists CTK-ADR-0008 as Proposed.
 *   (c) CTK-ADR-0001..0007 still say Accepted (no silent status edit of an Accepted record).
 *   (d) README.md's gsd-test-viability (ENF-24) row describes the docker timeout as `ask`, never deny.
 *   (e) Phase 37 (37-08): CTK-ADR-0009 is Proposed (Dave has not approved it), its Status line never
 *       says Accepted, and docs/adr/README.md lists it as Proposed.
 *   (f) Phase 38 (38-04): CTK-ADR-0010 (ENF-20 step 8a memtrace review evidence, amending CTK-ADR-0006
 *       Decision 4) is Proposed (Dave has not approved it), its Status line never says Accepted, and
 *       docs/adr/README.md lists it as Proposed.
 *
 *   (g) Phase 38 (38-04): README.md's review-artifact.cjs (ENF-20) row names step 8a, memtrace and `ask`,
 *       and no longer says "four mechanizable".
 *
 *   (h) Phase 38 code review (MJ-03, MN-01, MN-02, NT-05, BL-01 scope): CTK-ADR-0010's residuals list
 *       every route that classifies `other` (GraphQL, `-fevent=`, bare `--input`, `bash -c`) as one
 *       ENF-20-wide pre-existing gap, the sparse-extend scan-cap downgrade, the no-newline scan cost,
 *       the over-gating verdict forms and the live-slot FIFO that still blocks the verdict writer.
 *
 * Approving ADR-0008 is Dave's call: when he does, update (a) and (b) here deliberately.
 * Approving ADR-0009 is also Dave's call: when he does, update (e) here deliberately.
 * Approving ADR-0010 is Dave's call: when he does, update (f) here deliberately.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = __dirname;
const ADR_DIR = path.join(REPO, 'docs', 'adr');

function adrFile(n) {
  const prefix = `CTK-ADR-${String(n).padStart(4, '0')}-`;
  const hits = fs.readdirSync(ADR_DIR).filter((f) => f.startsWith(prefix) && f.endsWith('.md'));
  assert.strictEqual(hits.length, 1, `exactly one ADR file for ${prefix}, got ${JSON.stringify(hits)}`);
  return path.join(ADR_DIR, hits[0]);
}

function statusLine(file) {
  const line = fs.readFileSync(file, 'utf8').split('\n').find((l) => /^- \*\*Status:\*\*/.test(l));
  assert.ok(line, `${path.basename(file)} has a "- **Status:**" line`);
  return line;
}

function readmeRow(id) {
  const row = fs.readFileSync(path.join(ADR_DIR, 'README.md'), 'utf8').split('\n').find((l) => l.includes(`[${id}]`));
  assert.ok(row, `docs/adr/README.md has a row for ${id}`);
  return row;
}

test('36-06a: CTK-ADR-0008 Status line says Proposed and not Accepted', () => {
  const line = statusLine(adrFile(8));
  assert.match(line, /^- \*\*Status:\*\*\s*Proposed/, line);
  assert.doesNotMatch(line, /^- \*\*Status:\*\*\s*Accepted/, line);
  // The status paragraph may say "It becomes Accepted ... only when Dave approves" (conditional);
  // it must never claim the record IS accepted or approved.
  const lines = fs.readFileSync(adrFile(8), 'utf8').split('\n');
  const para = [];
  for (let i = lines.findIndex((l) => l === line); i < lines.length && lines[i].trim() !== ''; i++) para.push(lines[i]);
  assert.doesNotMatch(para.join(' '), /\b(is|was|been|now) (accepted|approved)\b/i, para.join(' '));
});

test('36-06a: docs/adr/README.md row for CTK-ADR-0008 says Proposed (not Accepted)', () => {
  const cells = readmeRow('CTK-ADR-0008').split('|').map((c) => c.trim());
  assert.ok(cells.includes('Proposed'), `status cell is Proposed: ${JSON.stringify(cells)}`);
  assert.ok(!cells.includes('Accepted'), 'status cell is not Accepted');
});

test('37-08: CTK-ADR-0009 Status line says Proposed and not Accepted', () => {
  const line = statusLine(adrFile(9));
  assert.match(line, /^- \*\*Status:\*\*\s*Proposed/, line);
  assert.doesNotMatch(line, /^- \*\*Status:\*\*\s*Accepted/, line);
  // The status paragraph may say "It becomes Accepted ... only when Dave approves" (conditional);
  // it must never claim the record IS accepted or approved.
  const lines = fs.readFileSync(adrFile(9), 'utf8').split('\n');
  const para = [];
  for (let i = lines.findIndex((l) => l === line); i < lines.length && lines[i].trim() !== ''; i++) para.push(lines[i]);
  assert.doesNotMatch(para.join(' '), /\b(is|was|been|now) (accepted|approved)\b/i, para.join(' '));
});

test('37-08: CTK-ADR-0009 docs/adr/README.md row says Proposed (not Accepted)', () => {
  const cells = readmeRow('CTK-ADR-0009').split('|').map((c) => c.trim());
  assert.ok(cells.includes('Proposed'), `status cell is Proposed: ${JSON.stringify(cells)}`);
  assert.ok(!cells.includes('Accepted'), 'status cell is not Accepted');
});

test('38-04: CTK-ADR-0010 Status line says Proposed and not Accepted', () => {
  const line = statusLine(adrFile(10));
  assert.match(line, /^- \*\*Status:\*\*\s*Proposed/, line);
  assert.doesNotMatch(line, /^- \*\*Status:\*\*\s*Accepted/, line);
  // The status paragraph may say "It becomes Accepted ... only when Dave approves" (conditional);
  // it must never claim the record IS accepted or approved.
  const lines = fs.readFileSync(adrFile(10), 'utf8').split('\n');
  const para = [];
  for (let i = lines.findIndex((l) => l === line); i < lines.length && lines[i].trim() !== ''; i++) para.push(lines[i]);
  assert.doesNotMatch(para.join(' '), /\b(is|was|been|now) (accepted|approved)\b/i, para.join(' '));
});

test('38-04: CTK-ADR-0010 docs/adr/README.md row says Proposed (not Accepted)', () => {
  const cells = readmeRow('CTK-ADR-0010').split('|').map((c) => c.trim());
  assert.ok(cells.includes('Proposed'), `status cell is Proposed: ${JSON.stringify(cells)}`);
  assert.ok(!cells.includes('Accepted'), 'status cell is not Accepted');
});

for (let n = 1; n <= 7; n++) {
  const id = `CTK-ADR-${String(n).padStart(4, '0')}`;
  test(`36-06c: ${id} Status line still says Accepted`, () => {
    assert.match(statusLine(adrFile(n)), /^- \*\*Status:\*\*\s*Accepted/);
  });
  test(`36-06c: docs/adr/README.md row for ${id} still says Accepted`, () => {
    assert.ok(readmeRow(id).split('|').map((c) => c.trim()).includes('Accepted'));
  });
}

test('36-05b: README.md ENF-24 gsd-test-viability row describes the docker timeout as `ask`, never deny', () => {
  const row = fs.readFileSync(path.join(REPO, 'README.md'), 'utf8').split('\n').find((l) => l.includes('`gsd-test-viability.cjs`'));
  assert.ok(row, 'README.md has a gsd-test-viability.cjs row');
  assert.match(row, /ENF-24/);
  assert.match(row, /`ask`, never deny, when `docker info` overruns its 8 s bound/);
  assert.doesNotMatch(row, /timeout[^;)]*\bdeny(es|ing)?\b(?!\W*never)/i);
  assert.doesNotMatch(row, /blocked|blocking/i);
});

test('38-04: README.md review-artifact.cjs row names step 8a, memtrace and `ask`, not "four mechanizable"', () => {
  const row = fs.readFileSync(path.join(REPO, 'README.md'), 'utf8').split('\n').find((l) => l.includes('`review-artifact.cjs`'));
  assert.ok(row, 'README.md has a review-artifact.cjs row');
  assert.match(row, /step 8a/);
  assert.match(row, /memtrace/);
  assert.match(row, /`ask`/);
  assert.doesNotMatch(row, /four mechanizable/);
});

// ── 38 review (MJ-03, MN-01, MN-02, NT-05, BL-01 scope): CTK-ADR-0010's residuals are complete ──

/** CTK-ADR-0010's "Negative / accepted residuals" list, as one string of bullets. */
function adr10Residuals() {
  const text = fs.readFileSync(adrFile(10), 'utf8');
  const start = text.indexOf('**Negative / accepted residuals.**');
  const end = text.indexOf('## Alternatives considered');
  assert.ok(start !== -1 && end > start, 'CTK-ADR-0010 has a residuals list before Alternatives considered');
  return text.slice(start, end);
}

/** The single residual bullet whose bold lead matches `re`. */
function adr10Bullet(re) {
  const bullets = adr10Residuals().split(/\n(?=- \*\*)/);
  const hits = bullets.filter((b) => re.test(b));
  assert.strictEqual(hits.length, 1, 'exactly one residual bullet matches ' + re + ': ' + hits.length);
  return hits[0];
}

test('38 review MJ-03: CTK-ADR-0010 lists every route that classifies `other` as one ENF-20-wide pre-existing gap, not GraphQL alone', () => {
  const b = adr10Bullet(/classif(y|ies) `other`/);
  for (const route of ['GraphQL', '-fevent=APPROVE', '--input', 'bash -c']) {
    assert.ok(b.includes(route), 'the residual names ' + route + ': ' + b);
  }
  assert.match(b, /pre-existing/);
  assert.match(b, /ENF-20-wide/);
  assert.doesNotMatch(adr10Residuals(), /\*\*GraphQL is outside the obligation\.\*\*/, 'GraphQL is no longer presented as the one gap');
});

test('38 review MN-01: CTK-ADR-0010 records the sparse-extend downgrade of the rotated log past the scan cap', () => {
  const b = adr10Bullet(/scan cap/);
  assert.match(b, /truncate/);
  assert.match(b, /tool-log\.1\.jsonl/);
  assert.match(b, /\bask\b/);
});

test('38 review MN-02: CTK-ADR-0010 records the cost of a log line with no newline', () => {
  const b = adr10Bullet(/no newline/);
  assert.match(b, /quadratic/);
});

test('38 review NT-05: CTK-ADR-0010 records the over-gating verdict forms (`--approve=false`)', () => {
  const b = adr10Bullet(/over-gat/);
  assert.ok(b.includes('--approve=false'), b);
});

test('38 review BL-01 scope: CTK-ADR-0010 records that a FIFO at the LIVE slot still blocks the verdict writer', () => {
  const b = adr10Bullet(/live slot/i);
  assert.match(b, /FIFO/);
  assert.match(b, /verdict/);
});

test('38 verifier VF-1: the classify-`other` residual also names the seven wrapper forms the verifier found', () => {
  const b = adr10Bullet(/classif(y|ies) `other`/);
  for (const form of [
    '( gh pr review 42 -a )',
    '{ gh pr review 42 -a; }',
    'nohup gh pr review 42 -a',
    'eval "gh pr review 42 -a"',
    'echo 42 | xargs gh pr review -a',
    '$(echo gh) pr review 42 -a',
    'gh -R o/r pr review 42 -a',
  ]) {
    assert.ok(b.includes(form), 'the residual names `' + form + '`: ' + b);
  }
});

test('38 verifier: the live-slot FIFO residual says it hangs every gate and points at its seed', () => {
  const b = adr10Bullet(/live slot/i);
  assert.match(b, /every gate/);
  assert.ok(b.includes('SEED-live-tool-log-fifo-hangs-all-gates'), b);
});

// ── quick 261006-jsm (CONTEXT D10, coordinator, orchestrator B1): CTK-ADR-0010 marks the fixed ENF-20
// verdict routes and records the new residuals. Every lock anchors on its own bullet's bold lead
// (adr10Bullet asserts exactly one match); no Status line and no Decision text changes. ──

test('261006-jsm: the classify-`other` residual marks the routes this branch fixed and keeps the open ones listed', () => {
  const b = adr10Bullet(/classif(y|ies) `other`/);
  assert.ok(b.includes('Fixed by quick 261006-jsm:'), b);
  for (const form of [
    'gh pr -R o/r review 42 -a',
    '-Fevent=APPROVE',
    'setsid',
    '`-lc`',
    'submitPullRequestReview',
    'addPullRequestReview',
    'denies on R8a',
  ]) {
    assert.ok(b.includes(form), 'the fixed marker names ' + form + ': ' + b);
  }
  assert.match(b, /bare `--input`[\s\S]*MJ-02 UNRESOLVED/);
  assert.match(b, /`\$\(echo gh\) pr review 42 -a` is an uncertain route that asks/);
});

test('261006-jsm: the CLEAR-comment residual is marked fixed (R8a governs both comment actions)', () => {
  const b = adr10Bullet(/CLEAR-verdict PR comment/);
  assert.ok(b.includes('Fixed by quick 261006-jsm:'), b);
  for (const s of ['`pr-comment`', '`issue-comment`', '`--comment`', 'step-8a verdict']) {
    assert.ok(b.includes(s), 'the fixed marker names ' + s + ': ' + b);
  }
});

test('261006-jsm: the opaque-ask residual carries the measured noise, the constants and the grade basis', () => {
  const b = adr10Bullet(/^- \*\*An opaque verdict route asks/);
  for (const s of [
    '17 / 47,642', '0.04%', '1,509 / 47,642', '3.2%', '2026-10-06',
    'eval "$(ssh-agent -s)"', 'eval "$CMD"', 'OPAQUE_SHELL_PAYLOAD_NEEDS_HINT',
    'RECOVERY_MAX_DEPTH', 'MAX_PREFIX_PEELS', 'CTK-ADR-0005 Decision 2', 'CTK-ADR-0007 Decision 2', 'MJ-02',
  ]) {
    assert.ok(b.includes(s), 'the opaque-ask residual names ' + s + ': ' + b);
  }
  assert.match(b, /outside one/);
});

test('261006-jsm (coordinator): the uncertain and unresolved asks degrade to allow under bypass mode', () => {
  const b = adr10Bullet(/^- \*\*The uncertain and unresolved asks are a prompt only in default mode/);
  assert.ok(b.includes('--dangerously-skip-permissions'), b);
  assert.match(b, /degrade to allow/);
  assert.match(b, /statically recovered forms still deny/);
});

test('261006-jsm (B1): the file-sourced GraphQL residual carries its measurement and the no-lookup ask', () => {
  const b = adr10Bullet(/^- \*\*A file-sourced GraphQL query asks/);
  for (const s of ['0 genuine', '48,055', '31 `gh api graphql` calls', 'no PR lookup', 'MJ-02', '-F query=@']) {
    assert.ok(b.includes(s), 'the file-sourced GraphQL residual names ' + s + ': ' + b);
  }
});

test('261006-jsm (D5): a CLEAR comment is a step-8a verdict, recorded as a consequence, not a Decision edit', () => {
  const b = adr10Bullet(/^- \*\*A `CLEAR` comment is a step-8a verdict/);
  assert.match(b, /`--comment` exemption/);
  assert.match(b, /without editing the Decision/);
});

test('261006-jsm: the still-open verdict routes are listed', () => {
  const b = adr10Bullet(/^- \*\*Verdict routes still open after quick 261006-jsm/);
  for (const s of [
    'gh -R o/r pr merge', 'x=$(gh pr review 42 -a)', '$X 42 -a', 'dismissPullRequestReview', 'bash review.sh',
    'bash -s', 'heredoc', '16 multi-line sh -c calls in 48,055', '-ftitle=x', 'zsh', 'never failed closed',
  ]) {
    assert.ok(b.includes(s), 'the still-open residual names ' + s + ': ' + b);
  }
});

test('261006-jsm: the keying and observability consequences are recorded', () => {
  const k = adr10Bullet(/^- \*\*Some recovered verdicts are keyed to the current branch's PR/);
  assert.match(k, /node id/);
  assert.match(k, /xargs/);
  assert.match(k, /R8a is session-scoped/);
  const o = adr10Bullet(/^- \*\*tool-recorder logs the recovered forms as `pr-review`/);
  assert.match(o, /governed stays false/);
});

const { execFileSync: jsmExecFileSync } = require('node:child_process');
const JSM_ADR10_REL = 'docs/adr/CTK-ADR-0010-memtrace-review-evidence.md';
const JSM_BASE = 'e2690ca';

test('261006-jsm: every line this branch added to the CTK-ADR-0010 residual list is plain ASCII', () => {
  const before = new Set(
    jsmExecFileSync('git', ['show', JSM_BASE + ':' + JSM_ADR10_REL], { cwd: REPO, encoding: 'utf8' }).split('\n')
  );
  const added = adr10Residuals().split('\n').filter((l) => !before.has(l));
  assert.ok(added.length > 0, 'the residual list gained lines');
  for (const l of added) assert.match(l, /^[\x20-\x7e]*$/, 'non-ASCII in an added line: ' + l);
});

test('261006-jsm: CTK-ADR-0010 is byte-identical to ' + JSM_BASE + ' up to `## Consequences` (no Status or Decision edit)', () => {
  const cut = (t) => t.slice(0, t.indexOf('## Consequences'));
  const base = jsmExecFileSync('git', ['show', JSM_BASE + ':' + JSM_ADR10_REL], { cwd: REPO, encoding: 'utf8' });
  const now = fs.readFileSync(adrFile(10), 'utf8');
  assert.ok(base.indexOf('## Consequences') > 0 && now.indexOf('## Consequences') > 0);
  assert.strictEqual(cut(now), cut(base));
});
