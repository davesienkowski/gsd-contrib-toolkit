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
 *   (i) Quick 261006-jq4 (W4 measurement): CTK-ADR-0010, README.md and re-review.md step 8a record the
 *       subagent session_id as MEASURED (Claude Code 2.1.291, 2026-10-06): a subagent's tool calls reach
 *       PreToolUse/PostToolUse under the parent session_id. The documented-only wording is gone, and the
 *       CTK-ADR-0007 Decision 2 rationale for ask-not-deny stays.
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

// -- quick-261006-jq4 (W4 measurement): the subagent session_id is recorded as measured --
//
// The evidence lives in the local, unpublished planning corpus. This file is published, so it pins
// the SHAPE of a session UUID and an agent id (never the real values) to keep them out of the docs.

const JQ4_EVIDENCE = '.planning/quick/261006-jq4-measure-subagent-session-id-in-posttoolu/evidence/';
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const AGENT_ID_RE = /\ba[0-9a-f]{16}\b/;

/** CTK-ADR-0010's text from `startMarker` to `endMarker` (or to the end when endMarker is null). */
function adr10Section(startMarker, endMarker) {
  const text = fs.readFileSync(adrFile(10), 'utf8');
  const start = text.indexOf(startMarker);
  assert.ok(start !== -1, 'CTK-ADR-0010 contains ' + JSON.stringify(startMarker));
  if (endMarker === null) return text.slice(start);
  const end = text.indexOf(endMarker, start);
  assert.ok(end > start, 'CTK-ADR-0010 has ' + JSON.stringify(endMarker) + ' after ' + JSON.stringify(startMarker));
  return text.slice(start, end);
}

/** The single item in `items` matching `re`. */
function exactlyOne(items, re, what) {
  const hits = items.filter((s) => re.test(s));
  assert.strictEqual(hits.length, 1, 'exactly one ' + what + ' matches ' + re + ': ' + hits.length);
  return hits[0];
}

function assertAscii(s, what) {
  assert.match(s, /^[\x00-\x7F]*$/, what + ' is plain ASCII');
}

function assertHasAll(s, tokens, what) {
  for (const token of tokens) {
    assert.ok(s.includes(token), what + ' names ' + JSON.stringify(token) + ': ' + s);
  }
}

/** `s` with every run of whitespace collapsed to one space, so a re-wrap cannot red a token match. */
function norm(s) {
  return s.replace(/\s+/g, ' ');
}

test('quick-261006-jq4: CTK-ADR-0010 Context records the subagent session_id as measured (version, date, fields, modes, scope, evidence)', () => {
  const ctx = adr10Section('## Context', '## Decision');
  const paragraphs = ctx.split(/\n[ \t]*\n/);
  const raw = exactlyOne(paragraphs, /^\*\*Subagent sessions: measured/, 'Context paragraph');
  const p = norm(raw);
  assertHasAll(p, [
    '2.1.291', '2026-10-06', JQ4_EVIDENCE,
    '`session_id`', '`agent_id`', '`agent_type`', '`transcript_path`', '`agent_transcript_path`',
    'SubagentStop', 'PostToolUse', 'tool-recorder', 'run_in_background',
  ], 'the measured Context paragraph');
  for (const re of [/foreground/, /indistinguishable/, /print mode/, /interactive/i, /nested/, /fork/, /team/,
    /not published|unpublished/, /parent/]) {
    assert.match(p, re);
  }
  assert.doesNotMatch(p, UUID_RE, 'no session UUID in the published ADR');
  assert.doesNotMatch(p, AGENT_ID_RE, 'no agent id in the published ADR');
  assert.doesNotMatch(p, /\/home\//, 'no /home/ path in the published ADR');
  assertAscii(raw, 'the measured Context paragraph');
  const whole = fs.readFileSync(adrFile(10), 'utf8');
  assert.ok(!whole.includes('documented, not measured'), 'CTK-ADR-0010 no longer says "documented, not measured"');
});

test('quick-261006-jq4: CTK-ADR-0010 residual says the subagent session_id is measured and keeps the attestation fallback', () => {
  const raw = adr10Bullet(/^- \*\*Subagent `session_id`/);
  const b = norm(raw);
  assertHasAll(b, ['2.1.291', '2026-10-06', '`agent_id`'], 'the subagent residual');
  assert.match(b, /^- \*\*Subagent `session_id`: measured/);
  assert.match(b, /attestation/);
  assert.match(b, /interactive/i);
  assert.match(b, /nested/);
  assert.match(b, /\bask/);
  assert.doesNotMatch(b, /documented, not measured/);
  assert.doesNotMatch(b, UUID_RE);
  assert.doesNotMatch(b, AGENT_ID_RE);
  assertAscii(raw, 'the subagent residual');
});

test('quick-261006-jq4: CTK-ADR-0010 trek-e row keeps CTK-ADR-0007 Decision 2 and states the subagent answer as measured', () => {
  const lines = fs.readFileSync(adrFile(10), 'utf8').split('\n');
  const row = exactlyOne(lines, /^\| Cannot find the evidence: deny \|/, 'trek-e divergence row');
  assert.ok(row.includes('CTK-ADR-0007 Decision 2'), 'the row still cites CTK-ADR-0007 Decision 2: ' + row);
  assert.match(row, /\bmeasured\b/);
  assert.doesNotMatch(row, /question is unmeasured/);
  assertAscii(row, 'the trek-e divergence row');
});

test("quick-261006-jq4: CTK-ADR-0010 'Deny when the log cannot be observed' keeps the CTK-ADR-0007 rationale and drops the unmeasured-subagent clause", () => {
  const alt = adr10Section('## Alternatives considered', null);
  const bullets = alt.split(/\n(?=- \*\*)/);
  const raw = exactlyOne(bullets, /^- \*\*Deny when the log cannot be observed\.\*\*/, 'Alternatives bullet');
  const b = norm(raw);
  assertHasAll(b, ['cannot observe is not did not run', 'CTK-ADR-0007', 'Decision 2'], 'the deny alternative');
  assert.match(b, /\bmeasured\b/);
  assert.doesNotMatch(b, /subagent question unmeasured/);
  assertAscii(raw, 'the deny alternative');
});

test('quick-261006-jq4: README.md step 8a paragraph states the subagent session_id as measured', () => {
  const lines = fs.readFileSync(path.join(REPO, 'README.md'), 'utf8').split('\n');
  const start = lines.findIndex((l) => l.startsWith('**ENF-20 step 8a (memtrace evidence).**'));
  assert.ok(start !== -1, 'README.md has the ENF-20 step 8a paragraph');
  const out = [];
  for (let i = start; i < lines.length && lines[i].trim() !== ''; i++) out.push(lines[i]);
  const raw = out.join('\n');
  const p = norm(raw);
  assertHasAll(p, ['2.1.291', '2026-10-06', '`session_id`', '`agent_id`', 'CTK-ADR-0010'], 'the README step 8a paragraph');
  assert.match(p, /\bmeasured\b/);
  assert.match(p, /parent/);
  assert.doesNotMatch(p, /documented by Claude Code to carry/);
  assert.doesNotMatch(p, /not measured with\s+tool-recorder/);
  assertAscii(raw, 'the README step 8a paragraph');
});

test('quick-261006-jq4: re-review.md step 8a ends with the measured subagent answer', () => {
  const file = path.join(REPO, 'skills', 'maintainer-review-sweep', 're-review.md');
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const line = exactlyOne(lines, /^8a\. /, 're-review.md step 8a line');
  const i = line.indexOf('Subagent tool calls');
  assert.ok(i !== -1, 'the 8a line has a "Subagent tool calls" sentence');
  const tail = line.slice(i);
  assertHasAll(tail, ['2.1.291', '2026-10-06', 'parent session', 'CTK-ADR-0010'], 'the 8a subagent sentence');
  assert.match(tail, /\bmeasured\b/);
  assert.doesNotMatch(line, /per the Claude Code hooks docs, but that is not measured/);
  assertAscii(tail, 'the 8a subagent sentence');
});
