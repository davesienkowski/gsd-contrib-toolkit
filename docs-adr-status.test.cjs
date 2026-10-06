'use strict';

/**
 * docs-adr-status.test.cjs — lock tests for the Phase 36 documentation prohibitions
 * (36-VERIFICATION "Prohibitions": 36-05b, 36-06a, 36-06c).
 *
 *   (a) CTK-ADR-0008 is Proposed (Dave has not approved it) and its Status line never says Accepted.
 *   (b) docs/adr/README.md lists CTK-ADR-0008 as Proposed.
 *   (c) CTK-ADR-0001..0007 still say Accepted (no silent status edit of an Accepted record).
 *   (d) README.md's gsd-test-viability (ENF-24) row describes the docker timeout as `ask`, never deny.
 *
 * Approving ADR-0008 is Dave's call: when he does, update (a) and (b) here deliberately.
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
