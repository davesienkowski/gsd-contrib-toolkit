'use strict';

/**
 * bin/claims-delta-text.test.cjs — presence proof for the core-contribution text added by quick 261113-cde
 * (author fix round, size warning, pre-push review template). The text is advisory and model-driven; this test
 * only keeps it from silently dropping. Every assertion runs on the extracted SECTION, never the whole file,
 * so another part of the file cannot make it pass. CD_SKILLS_ROOT points at an alternative skills dir (used to
 * prove the test is red against the text before the change).
 *
 * @module bin/claims-delta-text.test
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = process.env.CD_SKILLS_ROOT || path.join(__dirname, '..', 'skills');
const read = (f) => fs.readFileSync(path.join(ROOT, 'core-contribution', f), 'utf8');

function section(text, heading) {
  const i = text.indexOf(heading);
  assert.ok(i >= 0, `heading present: ${heading}`);
  const rest = text.slice(i + heading.length);
  const m = /\n#{2,3} /.exec(rest);
  return m ? rest.slice(0, m.index) : rest;
}

test('SKILL.md Phase 5b holds the size warning, the fix-round rules and the honesty caveat', () => {
  const s = section(read('SKILL.md'), '### Phase 5b');
  assert.match(s, /about 10 files or about 800 changed lines/);
  assert.match(s, /tunable/);
  assert.match(s, /suggest a split/);
  assert.match(s, /current state/);
  assert.match(s, /re-review comment/);
  assert.match(s, /claims-delta\.cjs/);
  assert.match(s, /MERGEABLE/);
  assert.match(s, /10 or more NEW inputs/);
  assert.match(s, /pre-push-review\.md/);
  assert.match(s, /None of this is a hook/);
  assert.match(s, /self-reported/);
});

test('reference.md documents the claims-delta commands and the resolution schema', () => {
  const s = section(read('reference.md'), '## claims-delta');
  for (const needle of ['--gate', 'CLAIMS-RESOLUTIONS.json', 'new_inputs', 'not-a-rule', 'oversize', '--policy-reason', '--no-body']) assert.ok(s.includes(needle), needle);
});

test('pre-push-review.md quotes trek-e with the URL and names every pass and the new-inputs scoring', () => {
  const t = read('pre-push-review.md');
  assert.ok(t.includes('https://github.com/open-gsd/gsd-core/pull/5119#pullrequestreview-5895456040'));
  for (const skill of ['diagnosing-bugs', 'qa-test-architect', 'skills-from-the-artificer', 'code-review', 'security-review', 'memtrace']) assert.ok(t.includes(skill), skill);
  const scored = section(t, '## How the reviewer is scored');
  assert.match(scored, /new inputs it tried/);
  assert.match(scored, /not by earlier counter-examples/);
  assert.match(section(t, '## Prompt'), /BUILD NEW INPUTS/);
});
