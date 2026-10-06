'use strict';

/**
 * docs-adr-status.test.cjs — lock tests for the Phase 36 documentation prohibitions
 * (36-VERIFICATION "Prohibitions": 36-05b, 36-06a, 36-06c).
 *
 *   (a) CTK-ADR-0008 is Accepted: its Status line reads `Accepted (2026-10-06, by Dave's explicit sign-off).`
 *       and never starts with Proposed.
 *   (b) docs/adr/README.md lists CTK-ADR-0008 as Accepted.
 *   (c) CTK-ADR-0001..0007 still say Accepted (no silent status edit of an Accepted record).
 *   (d) README.md's gsd-test-viability (ENF-24) row describes the docker timeout as `ask`, never deny.
 *   (e) Phase 37 (37-08): CTK-ADR-0009 is Accepted with the dated Status line
 *       `Accepted (2026-10-06, by Dave's explicit sign-off).`, and docs/adr/README.md lists it as Accepted.
 *   (f) Phase 38 (38-04): CTK-ADR-0010 (ENF-20 step 8a memtrace review evidence, amending CTK-ADR-0006
 *       Decision 4) is Accepted with the dated Status line `Accepted (2026-10-06, by Dave's explicit
 *       sign-off).`, and docs/adr/README.md lists it as Accepted.
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
 *       CTK-ADR-0007 Decision 2 rationale for ask-not-deny stays. The code review (WR-01..WR-04) adds
 *       pins for the MCP-call measurement, every unmeasured form, the claim phrase and its scope (with
 *       the inversions banned), and a leak guard over the four published jq4 scopes.
 *   (j) W5 (quick 261006-jts): CTK-ADR-0010's Decision 7 table carries exactly one W5 row (the
 *       gate hot-path state files outside ENF-20, read and written as regular files only through
 *       hooks/lib/regular-file.cjs), and exactly one "W5 residual" bullet names the same-class
 *       opens W5 left unchanged.
 *
 * Dave accepted CTK-ADR-0008, CTK-ADR-0009 and CTK-ADR-0010 on 2026-10-06 by explicit sign-off (quick
 * 261006-p4t); (a), (b), (e) and (f) pin that acceptance. A later change of decision is a superseding or
 * amending CTK-ADR, not an edit to these rows.
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

test('36-06a: CTK-ADR-0008 Status line says Accepted with the dated sign-off and not Proposed', () => {
  const line = statusLine(adrFile(8));
  assert.match(line, /^- \*\*Status:\*\* Accepted \(2026-10-06, by Dave's explicit sign-off\)\./, line);
  assert.doesNotMatch(line, /^- \*\*Status:\*\*\s*Proposed/, line);
  // The status paragraph records Dave's sign-off and never the pending wording.
  const lines = fs.readFileSync(adrFile(8), 'utf8').split('\n');
  const para = [];
  for (let i = lines.findIndex((l) => l === line); i < lines.length && lines[i].trim() !== ''; i++) para.push(lines[i]);
  const text = para.join(' ').replace(/\s+/g, ' ');
  assert.ok(text.includes('Dave has approved this record'), text);
  assert.doesNotMatch(text, /has not approved/i, text);
  assert.ok(text.includes('The sign-off covers the whole record, including the orchestrator-amended Decision 3 (36-REVIEW M-01).'), text);
});

test('36-06a: docs/adr/README.md row for CTK-ADR-0008 says Accepted (not Proposed)', () => {
  const cells = readmeRow('CTK-ADR-0008').split('|').map((c) => c.trim());
  assert.ok(cells.includes('Accepted'), `status cell is Accepted: ${JSON.stringify(cells)}`);
  assert.ok(!cells.includes('Proposed'), 'status cell is not Proposed');
});

test('37-08: CTK-ADR-0009 Status line says Accepted with the dated sign-off and not Proposed', () => {
  const line = statusLine(adrFile(9));
  assert.match(line, /^- \*\*Status:\*\* Accepted \(2026-10-06, by Dave's explicit sign-off\)\./, line);
  assert.doesNotMatch(line, /^- \*\*Status:\*\*\s*Proposed/, line);
  // The status paragraph records Dave's sign-off and never the pending wording.
  const lines = fs.readFileSync(adrFile(9), 'utf8').split('\n');
  const para = [];
  for (let i = lines.findIndex((l) => l === line); i < lines.length && lines[i].trim() !== ''; i++) para.push(lines[i]);
  const text = para.join(' ').replace(/\s+/g, ' ');
  assert.ok(text.includes('Dave has approved this record'), text);
  assert.doesNotMatch(text, /has not approved/i, text);
});

test('37-08: CTK-ADR-0009 docs/adr/README.md row says Accepted (not Proposed)', () => {
  const cells = readmeRow('CTK-ADR-0009').split('|').map((c) => c.trim());
  assert.ok(cells.includes('Accepted'), `status cell is Accepted: ${JSON.stringify(cells)}`);
  assert.ok(!cells.includes('Proposed'), 'status cell is not Proposed');
});

test('38-04: CTK-ADR-0010 Status line says Accepted with the dated sign-off and not Proposed', () => {
  const line = statusLine(adrFile(10));
  assert.match(line, /^- \*\*Status:\*\* Accepted \(2026-10-06, by Dave's explicit sign-off\)\./, line);
  assert.doesNotMatch(line, /^- \*\*Status:\*\*\s*Proposed/, line);
  // The status paragraph records Dave's sign-off and never the pending wording.
  const lines = fs.readFileSync(adrFile(10), 'utf8').split('\n');
  const para = [];
  for (let i = lines.findIndex((l) => l === line); i < lines.length && lines[i].trim() !== ''; i++) para.push(lines[i]);
  const text = para.join(' ').replace(/\s+/g, ' ');
  assert.ok(text.includes('Dave has approved this record'), text);
  assert.doesNotMatch(text, /has not approved/i, text);
});

test('38-04: CTK-ADR-0010 docs/adr/README.md row says Accepted (not Proposed)', () => {
  const cells = readmeRow('CTK-ADR-0010').split('|').map((c) => c.trim());
  assert.ok(cells.includes('Accepted'), `status cell is Accepted: ${JSON.stringify(cells)}`);
  assert.ok(!cells.includes('Proposed'), 'status cell is not Proposed');
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
// the SHAPE of a session UUID and an agent id (never the real values). The leak guard at the end of
// this block applies those two shapes plus `/home/` and `/tmp/` to exactly four scopes: the whole of
// CTK-ADR-0010, the README.md step 8a paragraph, the whole of skills/maintainer-review-sweep/re-review.md
// and the whole of its bundle copy under capabilities/contribution-toolkit/.
//
// Review WR-03: the tests pin the claim phrase and its scope and ban the inversions, so a negated or
// widened sentence reds even when every token is still present.

const JQ4_EVIDENCE = '.planning/quick/261006-jq4-measure-subagent-session-id-in-posttoolu/evidence/';
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const AGENT_ID_RE = /\ba[0-9a-f]{16}\b/;
const LOCAL_PATH_RE = /\/home\/|\/tmp\//;
/** A sentence that inverts the measured claim ("not logged", "never count(s)"). */
const INVERSION_RE = /\b(not|never) (logged|count)/;

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

/** Review WR-01: the text says an MCP tool call made inside a subagent was measured. */
function assertNamesMcpMeasurement(s, what) {
  assert.match(s, /\bMCP\b/, what + ' names MCP: ' + s);
  assert.match(s, /mcp__|MCP tool call/, what + ' names the MCP tool call: ' + s);
}

/**
 * Review WR-02: the "not measured" text names every scope limit the research recorded: interactive and
 * `--agent` sessions, nested subagents, forks, agent teams, the `PostToolUseFailure` event, hooks
 * installed through the capability rather than project settings, and that the MCP call was not memtrace.
 */
function assertNamesEveryUnmeasuredForm(s, what) {
  assertHasAll(s, ['`--agent`', '`PostToolUseFailure`', 'context7'], what);
  for (const re of [/interactive/i, /nested/, /fork/, /team/, /capability/, /project settings/, /context7, not memtrace/]) {
    assert.match(s, re, what + ' matches ' + re + ': ' + s);
  }
}

/** README.md's ENF-20 step 8a paragraph (raw). */
function readme8aParagraph() {
  const lines = fs.readFileSync(path.join(REPO, 'README.md'), 'utf8').split('\n');
  const start = lines.findIndex((l) => l.startsWith('**ENF-20 step 8a (memtrace evidence).**'));
  assert.ok(start !== -1, 'README.md has the ENF-20 step 8a paragraph');
  const out = [];
  for (let i = start; i < lines.length && lines[i].trim() !== ''; i++) out.push(lines[i]);
  return out.join('\n');
}

const RE_REVIEW_REL = path.join('skills', 'maintainer-review-sweep', 're-review.md');
const RE_REVIEW_BUNDLE_REL = path.join('capabilities', 'contribution-toolkit', RE_REVIEW_REL);

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
  for (const re of [/foreground/, /indistinguishable/, /print mode/, /one level deep/,
    /not published|unpublished/, /parent/]) {
    assert.match(p, re);
  }
  // WR-03: the claim itself, not just its tokens.
  assert.match(p, /a `session_id` equal to the parent session's/);
  // WR-01: the MCP run is cited and the run count is consistent (four `claude -p` runs).
  assertNamesMcpMeasurement(p, 'the measured Context paragraph');
  assert.match(p, /\b[Ff]our `claude -p` runs\b/);
  assert.doesNotMatch(p, /\b([Tt]hree|[Tt]wo) `claude -p` runs\b/);
  // WR-02: every scope limit.
  assertNamesEveryUnmeasuredForm(p, 'the measured Context paragraph');
  assert.doesNotMatch(p, UUID_RE, 'no session UUID in the published ADR');
  assert.doesNotMatch(p, AGENT_ID_RE, 'no agent id in the published ADR');
  assert.doesNotMatch(p, LOCAL_PATH_RE, 'no /home/ or /tmp/ path in the published ADR');
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
  assert.match(b, /\bask/);
  // WR-02: every scope limit; WR-03: no inversion of the claim.
  assertNamesEveryUnmeasuredForm(b, 'the subagent residual');
  assert.doesNotMatch(b, /never counts|\bnot logged\b/);
  assert.doesNotMatch(b, /documented, not measured/);
  assert.doesNotMatch(b, UUID_RE);
  assert.doesNotMatch(b, AGENT_ID_RE);
  assertAscii(raw, 'the subagent residual');
});

test('quick-261006-jq4: CTK-ADR-0010 trek-e row keeps CTK-ADR-0007 Decision 2 and states the subagent answer as measured', () => {
  const lines = fs.readFileSync(adrFile(10), 'utf8').split('\n');
  const row = exactlyOne(lines, /^\| Cannot find the evidence: deny \|/, 'trek-e divergence row');
  assert.ok(row.includes('CTK-ADR-0007 Decision 2'), 'the row still cites CTK-ADR-0007 Decision 2: ' + row);
  // WR-03: the claim phrase, and no "never measured" / "not measured" / "unmeasured" reversion.
  assert.match(row, /logged under the parent `session_id` \(measured/);
  assert.doesNotMatch(row, /\bnever measured\b|\bnot measured\b|unmeasured/);
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
  const raw = readme8aParagraph();
  const p = norm(raw);
  assertHasAll(p, ['2.1.291', '2026-10-06', '`session_id`', '`agent_id`', 'CTK-ADR-0010'], 'the README step 8a paragraph');
  assert.doesNotMatch(p, /documented by Claude Code to carry/);
  assert.doesNotMatch(p, /not measured with\s+tool-recorder/);
  // WR-03: the claim phrase and its scope. The inversion ban is scoped to the subagent sentences
  // (from "Subagent tool calls" to "When memtrace genuinely"), because the paragraph's earlier
  // "a review-body section never counts" is correct and would match it.
  const i = p.indexOf('Subagent tool calls');
  assert.ok(i !== -1, 'the README 8a paragraph has a "Subagent tool calls" sentence');
  const j = p.indexOf('When memtrace genuinely', i);
  const sub = j === -1 ? p.slice(i) : p.slice(i, j);
  assert.match(sub, /are logged under the parent `session_id` \(measured 2026-10-06/);
  for (const re of [/one level deep/, /print mode/, /foreground and background/]) assert.match(sub, re);
  assert.doesNotMatch(sub, INVERSION_RE);
  assert.doesNotMatch(p, /every (mode|depth)/);
  // WR-01: the MCP measurement.
  assertNamesMcpMeasurement(sub, 'the README subagent sentences');
  assertAscii(raw, 'the README step 8a paragraph');
});

test('quick-261006-jq4: re-review.md step 8a ends with the measured subagent answer', () => {
  const lines = fs.readFileSync(path.join(REPO, RE_REVIEW_REL), 'utf8').split('\n');
  const line = exactlyOne(lines, /^8a\. /, 're-review.md step 8a line');
  const i = line.indexOf('Subagent tool calls');
  assert.ok(i !== -1, 'the 8a line has a "Subagent tool calls" sentence');
  const tail = line.slice(i);
  assertHasAll(tail, ['2.1.291', '2026-10-06', 'parent session', 'CTK-ADR-0010'], 'the 8a subagent sentence');
  assert.doesNotMatch(line, /per the Claude Code hooks docs, but that is not measured/);
  // WR-03: the claim phrase, its scope, the forms not measured, and no inversion.
  assert.match(tail, /are logged under the parent session: measured/);
  for (const re of [/one level deep/, /print mode/, /interactive/i, /nested/, /fork/, /team/]) assert.match(tail, re);
  assert.doesNotMatch(tail, INVERSION_RE);
  assert.doesNotMatch(tail, /every (mode|depth)/);
  // WR-01: the MCP measurement.
  assertNamesMcpMeasurement(tail, 'the 8a subagent sentence');
  assertAscii(tail, 'the 8a subagent sentence');
});

test('quick-261006-jq4: no session UUID, agent id, /home/ or /tmp/ path in the four published jq4 scopes (review WR-04)', () => {
  const scopes = [
    ['CTK-ADR-0010 (whole file)', fs.readFileSync(adrFile(10), 'utf8')],
    ['README.md step 8a paragraph', readme8aParagraph()],
    [RE_REVIEW_REL + ' (whole file)', fs.readFileSync(path.join(REPO, RE_REVIEW_REL), 'utf8')],
    [RE_REVIEW_BUNDLE_REL + ' (whole file)', fs.readFileSync(path.join(REPO, RE_REVIEW_BUNDLE_REL), 'utf8')],
  ];
  for (const [what, text] of scopes) {
    assert.doesNotMatch(text, UUID_RE, 'no session UUID in ' + what);
    assert.doesNotMatch(text, AGENT_ID_RE, 'no agent id in ' + what);
    assert.doesNotMatch(text, LOCAL_PATH_RE, 'no /home/ or /tmp/ path in ' + what);
  }
});
// -- W5 (quick 261006-jts): the gate-path hardening row and its out-of-scope residual --

test('W5: CTK-ADR-0010 has exactly one W5 severity-map row naming every hardened gate-path file and the shared lib', () => {
  const rows = fs
    .readFileSync(adrFile(10), 'utf8')
    .split('\n')
    .filter((l) => l.trimStart().startsWith('|'))
    .filter((l) => l.includes('W5 (quick 261006-jts)'));
  assert.strictEqual(rows.length, 1, 'exactly one table row cites W5 (quick 261006-jts): ' + rows.length);
  for (const name of ['runtime-stamp.json', 'upstream-tip-cache.json', 'override-receipts.log', 'ENF-19', 'hooks/lib/regular-file.cjs', 'failures.json']) {
    assert.ok(rows[0].includes(name), 'the W5 row names ' + name + ': ' + rows[0]);
  }
});

test('W5: CTK-ADR-0010 has exactly one W5 residual bullet naming every same-class open W5 left unchanged', () => {
  const b = adr10Bullet(/W5 residual/);
  for (const site of [
    'gh-edit',
    'gh-pr-create',
    'gh-issue-create',
    'issue-dedupe',
    'git-commit-convention',
    'gsd-test-viability',
    'worktree-fresh-base',
    'binlib-edit',
    'runtimeDigest',
    'writeStamp',
    'bin/contrib-capability.cjs',
  ]) {
    assert.ok(b.includes(site), 'the W5 residual names ' + site + ': ' + b);
  }
  // W5 review WR-01: the CLI receipt preflight was aligned with writeReceipt, so the residual must not
  // still describe it as a blocking open.
  assert.ok(!/preflight opens\s+first/.test(b), 'the W5 residual must not call the aligned CLI preflight unguarded: ' + b);
});

// -- quick 261006-jsm (CONTEXT D10, coordinator, orchestrator B1): CTK-ADR-0010 marks the fixed ENF-20
// verdict routes and records the new residuals. Every lock anchors on its own bullet's bold lead
// (adr10Bullet asserts exactly one match); no Status line and no Decision text changes. --

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

// Review fix round WR-03: the pre-branch state of CTK-ADR-0010 is pinned by sha256 digests computed
// from commit e2690ca's text (2026-10-06), so these rows never read a git object: e2690ca is on no
// published branch, and a squash merge, a rebase or a fresh clone would lose it.
const { createHash: jsmCreateHash } = require('node:crypto');
const jsmSha256 = (t) => jsmCreateHash('sha256').update(t, 'utf8').digest('hex');
// sha256 of each non-ASCII line in e2690ca's residual list (one line, the `gh api .../reviews
// -fevent=APPROVE` line of the classify-`other` bullet, written with an ellipsis character).
const JSM_BASE_NON_ASCII_RESIDUAL_SHA256 = new Set([
  '9a0a2d51f02a2dbbec2b9dc71fb33b2390d995734af50de23559a8170a7cff53',
]);

test('261006-jsm: every line this branch added to the CTK-ADR-0010 residual list is plain ASCII', () => {
  const lines = adr10Residuals().split('\n');
  assert.ok(lines.some((l) => l.includes('261006-jsm')), 'the residual list carries the 261006-jsm lines');
  for (const l of lines) {
    if (/^[\x20-\x7e]*$/.test(l)) continue;
    assert.ok(JSM_BASE_NON_ASCII_RESIDUAL_SHA256.has(jsmSha256(l)), 'non-ASCII in a line not present at e2690ca: ' + l);
  }
});

// The branch-time pin (the text above `## Consequences` byte-identical to e2690ca) held only on the
// 261006-jsm branch: the W4 merge (quick 261006-jq4) rewrote Context with the measured subagent
// session_id, and Dave's acceptance flips Status. The invariant that survives the merge is that no
// 261006-jsm text sits above `## Consequences`.
test('261006-jsm: CTK-ADR-0010 carries no 261006-jsm text above `## Consequences` (no Status or Decision edit)', () => {
  const now = fs.readFileSync(adrFile(10), 'utf8');
  assert.ok(now.indexOf('## Consequences') > 0);
  assert.ok(!now.slice(0, now.indexOf('## Consequences')).includes('261006-jsm'));
});

// -- quick 261006-jsm review fix round WR-02: the keying bullet no longer says a wrong key cannot allow
test('261006-jsm WR-02: the keying bullet says a wrong key can allow and that the gate now asks', () => {
  const k = adr10Bullet(/^- \*\*Some recovered verdicts are keyed to the current branch's PR/);
  assert.ok(!k.includes('denies, never allows'), k);
  assert.match(k, /can be allowed/);
  assert.match(k, /asks/);
  assert.match(k, /any deny still wins/);
});

// -- quick 261006-jsm review fix round WR-03: these rows must not read a git object -------------
// e2690ca is on no published branch; after a squash merge, a rebase or in a fresh clone of the public
// repo `git show e2690ca:...` throws. The base text is pinned by digest instead.
test('261006-jsm WR-03: this suite reads no git object (hermetic in any clone)', () => {
  const src = fs.readFileSync(__filename, 'utf8');
  const gitShow = "['sh" + "ow', ";
  assert.ok(!src.includes(gitShow), 'docs-adr-status.test.cjs must not call git show');
});

// -- quick 261006-jsm review fix round (CR-01..04, WR-04, IN-01..03): the residual list matches what
// the review round fixed and what it found still open. Consequences bullets only.
test('261006-jsm review round: the still-open bullet lists the other shells, compound statements and multi-line eval', () => {
  const b = adr10Bullet(/^- \*\*Verdict routes still open after quick 261006-jsm/);
  for (const s of [
    "echo 'gh pr review 42 -a' | bash", "bash <<< 'gh pr review 42 -a'", '`ash -c`', '`mksh -c`', '`busybox sh -c`',
    '`su <user> -c`', '`script -c`', '`if true; then gh pr review 42 -a; fi`', '`for` / `while` ... `do`',
    'a multi-line eval or `-c` payload', '16 multi-line sh -c calls in 48,055',
    'curl -sX PUT', 'gh api -iX PUT', '`--input`', 'wrapped REST comment',
  ]) {
    assert.ok(b.includes(s), 'the still-open residual names ' + s + ': ' + b);
  }
});

test('261006-jsm review round: the fixed markers name the review-round spellings', () => {
  const other = adr10Bullet(/classif(y|ies) `other`/);
  for (const s of ['eval --', 'builtin eval', '-iFevent=APPROVE', 'curl -sd', 'gh api https://api.github.com/graphql', '`input: $var`']) {
    assert.ok(other.includes(s), 'the classify-other fixed marker names ' + s + ': ' + other);
  }
  const clear = adr10Bullet(/CLEAR-verdict PR comment/);
  for (const s of ['-fbody=CLEAR', 'curl -sd', 'a wrapped comment']) {
    assert.ok(clear.includes(s), 'the CLEAR fixed marker names ' + s + ': ' + clear);
  }
});

test('261006-jsm review round (IN-03): observability names verdict-log.cjs; bypass mode names the readable-event scope', () => {
  const o = adr10Bullet(/^- \*\*tool-recorder logs the recovered forms as `pr-review`/);
  assert.ok(o.includes('verdict-log.cjs'), o);
  const b = adr10Bullet(/^- \*\*The uncertain and unresolved asks are a prompt only in default mode/);
  assert.match(b, /statically recovered forms still deny/);
  assert.match(b, /readable event/);
});
