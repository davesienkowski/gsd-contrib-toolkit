'use strict';

/**
 * bin/contrib-runtime-phase0-presence.test.cjs - the skills' Phase 0 asserts the contribution
 * config dir before it measures or syncs anything (quick 261024-po0, L12, CTK-ADR-0013).
 *
 * The 2026-10-24 incident: a review sweep's Phase 0 ran `runtime-sync.cjs sync` in the daily
 * ~/.claude session and reinstalled the daily install. Since Task 1, sync refuses the daily dir
 * itself (exit 3) and ENF-21 denies filing/pushing there. This file pins the advisory half: both
 * skills' Phase 0 run `runtime-sync.cjs where` FIRST, stop on a non-zero exit, and print the
 * contribution-session launch form instead of reaching `check` or the do-not-ask sync text.
 *
 * SECTION-SCOPED, DELIBERATELY (pattern of bin/sweep-handoff-presence.test.cjs): every assertion
 * runs against one extracted section, never the whole file. Both skills already name
 * `runtime-sync.cjs`, `advisory` and `stop` elsewhere for unrelated reasons, so a whole-file
 * substring check would be green before the sections were rewritten.
 *
 * Sections:
 *   - sweep step 0b: the single line starting `0b. ` in skills/maintainer-review-sweep/SKILL.md;
 *   - core-contribution checklist: the single line starting `[ ] RT0`;
 *   - core-contribution Phase 0 paragraph: from the line starting `**RT0` up to (not including) the
 *     line starting `Read before authoring` (the paragraph and its blockquote).
 *
 * HONESTY: the `where` step is model-driven. The floors are sync's own refusal of the daily dir and
 * the ENF-21 gate at file/push time; the prose sections must say so (advisory cue asserted).
 *
 * Pure node:test/node:fs over in-repo files: no spawn, no network, no writes.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const BUNDLE_SKILLS = path.join(REPO_ROOT, 'capabilities', 'contribution-toolkit', 'skills');

const SWEEP_SKILL = 'skills/maintainer-review-sweep/SKILL.md';
const CORE_SKILL = 'skills/core-contribution/SKILL.md';

// A section longer than this is an extraction bug (an unbounded window re-admits whole-file
// vacuity), not a long paragraph.
const MAX_SECTION_CHARS = 6000;

const WHERE = 'runtime-sync.cjs where';
const CHECK = 'runtime-sync.cjs check';
const DO_NOT_ASK = 'do not ask';
const ADR_LINK = '](../../docs/adr/CTK-ADR-0013';

function read(rel) {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

function singleLine(rel, prefix) {
  const lines = read(rel).split('\n').filter((l) => l.startsWith(prefix));
  assert.strictEqual(lines.length, 1, rel + ' must have exactly one line starting ' + JSON.stringify(prefix));
  return lines[0];
}

function rt0Paragraph() {
  const lines = read(CORE_SKILL).split('\n');
  const starts = lines.map((l, i) => (l.startsWith('**RT0') ? i : -1)).filter((i) => i !== -1);
  assert.strictEqual(starts.length, 1, CORE_SKILL + ' must have exactly one line starting **RT0');
  const endRel = lines.slice(starts[0]).findIndex((l) => l.startsWith('Read before authoring'));
  assert.ok(endRel > 0, CORE_SKILL + ' must have a `Read before authoring` line after the RT0 paragraph');
  const section = lines.slice(starts[0], starts[0] + endRel).join('\n');
  assert.ok(section.length <= MAX_SECTION_CHARS, 'RT0 paragraph extraction is unbounded: ' + section.length);
  return section;
}

const SECTIONS = [
  { label: 'sweep step 0b', prose: true, get: () => singleLine(SWEEP_SKILL, '0b. ') },
  { label: 'core-contribution RT0 checklist line', prose: false, get: () => singleLine(CORE_SKILL, '[ ] RT0') },
  { label: 'core-contribution RT0 Phase 0 paragraph', prose: true, get: rt0Paragraph },
];

for (const s of SECTIONS) {
  test('po0: ' + s.label + ' runs runtime-sync.cjs where before check' + (s.prose ? ' and before the do-not-ask sync text' : ''), () => {
    const sec = s.get();
    const w = sec.indexOf(WHERE);
    assert.notStrictEqual(w, -1, s.label + ' must contain `' + WHERE + '`');
    const c = sec.indexOf(CHECK);
    assert.notStrictEqual(c, -1, s.label + ' must still contain `' + CHECK + '`');
    assert.ok(w < c, s.label + ': `where` (' + w + ') must come before `check` (' + c + ')');
    if (s.prose) {
      const d = sec.indexOf(DO_NOT_ASK);
      assert.notStrictEqual(d, -1, s.label + ' must still contain `' + DO_NOT_ASK + '` (the sync text)');
      assert.ok(w < d, s.label + ': `where` (' + w + ') must come before `do not ask` (' + d + ')');
    }
  });

  test('po0: ' + s.label + ' stops on a non-zero where exit and prints the launch form', () => {
    const sec = s.get();
    assert.match(sec, /non-zero/i, s.label + ' must say what a non-zero `where` exit means');
    assert.match(sec, /stop/i, s.label + ' must say to stop on a non-zero `where` exit');
    assert.ok(sec.includes('CLAUDE_CONFIG_DIR='), s.label + ' must print the launch form CLAUDE_CONFIG_DIR=<absolute path> claude');
    if (s.prose) {
      assert.ok(sec.includes('$HOME/.claude-contrib'), s.label + ' must suggest $HOME/.claude-contrib in the launch form');
    }
    assert.ok(!sec.includes(ADR_LINK), s.label + ' must not link CTK-ADR-0013 as a markdown link (exact-set pin in bin/build-capability.test.cjs)');
  });

  if (s.prose) {
    test('po0: ' + s.label + ' names CTK-ADR-0013 by plain ID and states the advisory/floor split', () => {
      const sec = s.get();
      assert.ok(sec.includes('CTK-ADR-0013'), s.label + ' must name CTK-ADR-0013');
      assert.ok(!sec.includes(ADR_LINK), s.label + ' must name CTK-ADR-0013 by plain ID, never as a markdown link (exact-set pin in bin/build-capability.test.cjs)');
      assert.match(sec, /advisory/i, s.label + ' must say the where step is advisory');
    });
  }

  test('po0: ' + s.label + ' is printable ASCII', () => {
    const sec = s.get();
    const bad = [];
    for (let i = 0; i < sec.length; i++) {
      const code = sec.charCodeAt(i);
      if (code !== 0x0a && (code < 0x20 || code > 0x7e)) bad.push('U+' + code.toString(16).padStart(4, '0') + '@' + i);
    }
    assert.deepStrictEqual(bad, [], s.label + ' must be printable ASCII');
  });
}

test('po0 guard: the core-contribution checklist line keeps its leading [ ] RT0 token', () => {
  const lines = read(CORE_SKILL).split('\n').filter((l) => /^\[ \] RT0\b/.test(l));
  assert.strictEqual(lines.length, 1, 'exactly one checklist line must start with `[ ] RT0`');
});

test('po0 guard: each bundled skill copy is byte-identical to its canonical source', () => {
  for (const rel of [SWEEP_SKILL, CORE_SKILL]) {
    const bundled = path.join(BUNDLE_SKILLS, path.relative('skills', rel));
    assert.ok(fs.existsSync(bundled), 'bundled copy missing: ' + bundled);
    assert.ok(
      fs.readFileSync(path.join(REPO_ROOT, rel)).equals(fs.readFileSync(bundled)),
      rel + ' and its bundled copy differ: run node bin/build-capability.cjs'
    );
  }
});
