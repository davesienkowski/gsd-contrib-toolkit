'use strict';

/**
 * Docs pins: the override valve docs say what `GSD_CONTRIB_OVERRIDE` actually does.
 *
 * hooks/lib/failclosed.cjs runGateInner consults the override only for a THROWN gate error, so
 * the override never lifts a returned policy deny. Each doc section that describes the valve must
 * scope it to thrown gate errors and name the accountable off switch
 * `node bin/contrib-capability.cjs off --reason "<why>"`, in plain ASCII. CTK-ADR-0010's residual
 * bullet records the correction; no ADR Status line changes.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO = __dirname;
const ASCII = /^[\x00-\x7F]*$/;
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

/** text from `start` up to (not including) `end`; both must exist. */
function between(text, start, end, label) {
  const a = text.indexOf(start);
  assert.notStrictEqual(a, -1, label + ': start marker not found: ' + start);
  const b = text.indexOf(end, a + start.length);
  assert.notStrictEqual(b, -1, label + ': end marker not found: ' + JSON.stringify(end));
  return text.slice(a, b);
}

/** text from `start` up to the next line that starts with `prefix`. */
function untilLinePrefix(text, start, prefix, label) {
  const a = text.indexOf(start);
  assert.notStrictEqual(a, -1, label + ': start marker not found: ' + start);
  const b = text.indexOf('\n' + prefix, a + start.length);
  assert.notStrictEqual(b, -1, label + ': no following line starting ' + prefix);
  return text.slice(a, b);
}

function assertScoped(label, section) {
  for (const m of ['GSD_CONTRIB_OVERRIDE', 'thrown', 'contrib-capability.cjs off --reason']) {
    assert.ok(section.includes(m), label + ' lacks "' + m + '":\n' + section);
  }
  assert.ok(ASCII.test(section), label + ' is not plain ASCII:\n' + section);
}

/**
 * Review round 2: a doc site describing the valve must not state "thrown gate errors only" as a
 * global rule, because ENF-07 (hooks/containment.cjs) honors the override in its own policy path
 * for a maintainer push to `origin`; it names that exception, and it presents the off switch as a
 * human operator's decision (the agent can run it too, so it is not offered as a way past a deny).
 */
function assertDocTruthful(label, section) {
  assertScoped(label, section);
  const flat = section.replace(/\s+/g, ' ');
  assert.ok(!/thrown gate errors only/i.test(flat), label + ' states "thrown gate errors only" as a global rule:\n' + section);
  assert.ok(flat.includes('ENF-07'), label + ' does not name the ENF-07 exception:\n' + section);
  assert.ok(/operator/i.test(flat), label + ' does not present the off switch as an operator decision:\n' + section);
  for (const c of ['Deliberate bypass', 'genuinely-wrong gate', 'turns off every toolkit gate']) {
    assert.ok(!flat.includes(c), label + ' still says "' + c + '":\n' + section);
  }
}

// Mirrored (copied, not imported) from docs-adr-status.test.cjs.
function adrFile(n) {
  const dir = path.join(REPO, 'docs', 'adr');
  const prefix = `CTK-ADR-${String(n).padStart(4, '0')}-`;
  const hits = fs.readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith('.md'));
  assert.strictEqual(hits.length, 1, `exactly one ADR file for ${prefix}, got ${JSON.stringify(hits)}`);
  return path.join(dir, hits[0]);
}

function adr10Residuals() {
  const text = fs.readFileSync(adrFile(10), 'utf8');
  const start = text.indexOf('**Negative / accepted residuals.**');
  const end = text.indexOf('## Alternatives considered');
  assert.ok(start !== -1 && end > start, 'CTK-ADR-0010 has a residuals list before Alternatives considered');
  return text.slice(start, end);
}

function adr10Bullet(re) {
  const bullets = adr10Residuals().split(/\n(?=- \*\*)/);
  const hits = bullets.filter((b) => re.test(b));
  assert.strictEqual(hits.length, 1, 'exactly one residual bullet matches ' + re + ': ' + hits.length);
  return hits[0];
}

test('docs-honesty: contributor guide section 6 scopes the override to thrown gate errors', () => {
  const s = between(read('docs/guides/contributor-guide.md'), '## 6. The override valve', '## Quick reference', 'contributor-guide');
  assertDocTruthful('contributor-guide section 6', s);
  assert.ok(!s.includes('genuinely-wrong gate'), 'section 6 still presents the override as a false-positive escape:\n' + s);
  assert.ok(s.includes('dodge a real failure'), 'section 6 keeps the never-dodge warning:\n' + s);
});

test('docs-honesty: README override valve paragraph scopes the override to thrown gate errors', () => {
  const s = between(read('README.md'), '**The override valve.**', '\n\n', 'README valve');
  assertDocTruthful('README valve paragraph', s);
  assert.ok(s.includes('never a silent default'), 'the valve paragraph keeps "never a silent default":\n' + s);
});

test('docs-honesty: README honesty bullet scopes the override to thrown gate errors', () => {
  const s = untilLinePrefix(read('README.md'), '- **The override is deliberate, not silent.**', '- **', 'README bullet');
  assertDocTruthful('README honesty bullet', s);
});

test('docs-honesty: overview item 3 scopes the override to thrown gate errors', () => {
  const s = between(read('docs/guides/overview.md'), '3. **The override valve', '\n\n', 'overview item 3');
  assertDocTruthful('overview item 3', s);
  assert.ok(s.includes('dodge a real failure'), 'overview item 3 keeps the never-dodge clause:\n' + s);
});

test('docs-honesty: CTK-ADR-0010 override-note residual records the correction', () => {
  const b = adr10Bullet(/ENF-20 override note/);
  assertScoped('CTK-ADR-0010 override-note bullet', b);
  assert.ok(b.includes('does not lift'), 'the bullet says the override does not lift the deny:\n' + b);
  assert.ok(b.includes('ENF-19, ENF-12 and ENF-11'), 'the bullet names the other corrected denies:\n' + b);
  assert.ok(!b.includes('left unchanged'), 'the bullet no longer says the note was left unchanged:\n' + b);
});

test('docs-honesty: ADR-0010 Status line unchanged', () => {
  const line = fs.readFileSync(adrFile(10), 'utf8').split('\n').find((l) => l.startsWith('- **Status:**'));
  assert.ok(line, 'CTK-ADR-0010 has a Status line');
  assert.match(line, /^- \*\*Status:\*\* Proposed\./);
});
