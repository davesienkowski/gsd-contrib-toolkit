'use strict';

/**
 * node:test for hooks/lib/scaffold.cjs (ENF-20 — the obligation-scaffolding contract).
 *
 * The load-bearing property under test is NEGATIVE: a freshly scaffolded artifact must FAIL
 * its own gate. CTK-ADR-0004 §Consequences says the artifact gates check SHAPE, not honesty,
 * and that their whole value is converting a skip from free-and-silent into
 * deliberate-and-recorded. A scaffold that filled the artifact in would make skipping free,
 * silent AND automatic. So every test here that looks like a "does it work" test is really a
 * "can it cheat" test.
 *
 * Proven here:
 *   - scaffold(spec) emits the sentinel for EVERY declared field (the anti-cheat guard)
 *   - hasUnfilledPlaceholders(scaffold(spec)) === true            ← THE critical assertion
 *   - one surviving placeholder out of many still reads as unfilled
 *   - only a fully-filled artifact reads as filled
 *   - a partially-EDITED placeholder (closing/opening delimiter eroded) reads as UNFILLED
 *     (fail-closed), and the one undetectable mangling is documented, not hidden
 *   - the skeleton is valid JSON, so the ENF-19 reader reaches the placeholder check instead
 *     of dying on a malformed-artifact error
 *   - no field is ever pre-filled with a non-placeholder value; a fieldless (therefore
 *     self-satisfying) spec THROWS
 *   - boolean constants are refused — a boolean is the shape of a CLAIM, never of a format
 *   - determinism: two calls return byte-identical text (no timestamps, no randomness)
 *   - writeScaffoldIfAbsent writes with flag 'wx', creates parent dirs, and NEVER overwrites
 *   - a genuine O_EXCL race (both callers lose the existsSync pre-check) → exactly one write,
 *     the loser reports not-written, and the file on disk is one complete scaffold
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  PLACEHOLDER,
  PLACEHOLDER_OPEN,
  PLACEHOLDER_CLOSE,
  PLACEHOLDER_RE,
  placeholderFor,
  findPlaceholders,
  hasUnfilledPlaceholders,
  scaffold,
  writeScaffoldIfAbsent,
} = require('./scaffold.cjs');

// ── fixtures ────────────────────────────────────────────────────────────────

/** A spec mirroring the shape of ENF-19's P1 gate: nested paths + an array element. */
const SPEC = Object.freeze({
  id: 'P1',
  title: 'P1-repro.json',
  step: 'P1 — reproduce the mechanism before filing',
  what: 'the reproduction that justifies filing',
  constants: Object.freeze({ schema: 1 }),
  fields: Object.freeze([
    Object.freeze({ path: 'mechanism', observed: 'one sentence naming the causal mechanism you traced' }),
    Object.freeze({ path: 'reproduced', observed: 'true ONLY if you watched it fail; otherwise withdraw' }),
    Object.freeze({ path: 'evidence.0.command', observed: 'the exact command line you ran' }),
    Object.freeze({ path: 'evidence.0.observed', observed: 'what it PRINTED, pasted verbatim' }),
  ]),
});

/** A minimal spec: no constants, one flat field. */
const MINIMAL = Object.freeze({
  title: 'X.json',
  step: 'X — do the thing',
  fields: Object.freeze([Object.freeze({ path: 'note', observed: 'what you observed' })]),
});

/** Replace every placeholder VALUE in a scaffold with a filled-in observed value. */
function fillAll(text) {
  return text.replace(/"<{1,3}FILL[^"]*"/g, '"an observed value"');
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ctk-scaffold-'));
}

// ── the sentinel ────────────────────────────────────────────────────────────

test('the sentinel is exported and is the frozen <<<FILL...>>> token family', () => {
  assert.strictEqual(PLACEHOLDER_OPEN, '<<<FILL:');
  assert.strictEqual(PLACEHOLDER_CLOSE, '>>>');
  assert.strictEqual(PLACEHOLDER, '<<<FILL>>>');
  assert.strictEqual(placeholderFor('mechanism'), '<<<FILL:mechanism>>>');
});

test('PLACEHOLDER_RE is NOT global — a stateful lastIndex would make detection flaky', () => {
  assert.strictEqual(PLACEHOLDER_RE instanceof RegExp, true);
  assert.strictEqual(PLACEHOLDER_RE.global, false);
  // Same input, same answer, twice — the property a /g regex silently breaks.
  assert.strictEqual(PLACEHOLDER_RE.test('<<<FILL:a>>>'), true);
  assert.strictEqual(PLACEHOLDER_RE.test('<<<FILL:a>>>'), true);
});

test('the sentinel does not fire on ordinary prose or on plausible observed output', () => {
  const innocent = [
    'fill in the form',
    'FILL the buffer',
    'the FILL: label',
    'landfill',
    '>>> python repl output',   // a lone close delimiter is NOT a placeholder
    'a < b && c > d',
    'git conflict markers <<<<<<< HEAD',
    '{ "observed": "not ok 1 - fill order\\n" }',
  ];
  for (const s of innocent) {
    assert.strictEqual(hasUnfilledPlaceholders(s), false, `false positive on: ${s}`);
  }
});

// ── THE critical contract: a fresh scaffold fails its own gate ───────────────

test('CRITICAL: a freshly scaffolded artifact FAILS its own gate', () => {
  assert.strictEqual(
    hasUnfilledPlaceholders(scaffold(SPEC)),
    true,
    'a fresh scaffold must NEVER be able to satisfy the gate that produced it — ' +
      'the toolkit scaffolds OBLIGATIONS, never EVIDENCE (CTK-ADR-0004 §Consequences)'
  );
  assert.strictEqual(hasUnfilledPlaceholders(scaffold(MINIMAL)), true);
});

test('GUARD: scaffold output carries the sentinel once per declared field', () => {
  const text = scaffold(SPEC);
  assert.ok(text.includes(PLACEHOLDER_OPEN), 'the sentinel must be greppable in the raw text');
  const found = findPlaceholders(text);
  assert.strictEqual(
    found.length,
    SPEC.fields.length,
    'every declared field must arrive as an unfilled placeholder — a refactor that emits ' +
      'fewer placeholders than fields is emitting a partially self-satisfying skeleton'
  );
  for (const f of SPEC.fields) {
    const leaf = f.path.split('.').pop();
    assert.ok(text.includes(placeholderFor(f.path)), `no placeholder for ${f.path}`);
    assert.ok(text.includes(`"${leaf}"`), `field ${f.path} missing from the skeleton`);
  }
});

test('GUARD: scaffold self-checks — a fieldless spec would be self-satisfying, so it THROWS', () => {
  assert.throws(
    () => scaffold({ title: 'Z.json', step: 'Z', fields: [] }),
    /at least one field|self-satisfying/i
  );
  assert.throws(() => scaffold({ title: 'Z.json', step: 'Z' }), /fields/i);
});

test('GUARD: no field is ever pre-filled — a field carrying a value is a contract bug', () => {
  assert.throws(
    () => scaffold({
      title: 'Z.json',
      step: 'Z',
      fields: [{ path: 'reproduced', observed: 'x', value: true }],
    }),
    /value|evidence/i
  );
});

test('GUARD: a boolean constant is refused — a boolean is a CLAIM, not a format', () => {
  assert.throws(
    () => scaffold({
      title: 'Z.json',
      step: 'Z',
      constants: { reproduced: true },
      fields: [{ path: 'note', observed: 'x' }],
    }),
    /boolean/i
  );
});

test('GUARD: a constant may not shadow a declared field', () => {
  assert.throws(
    () => scaffold({
      title: 'Z.json',
      step: 'Z',
      constants: { note: 'prefilled' },
      fields: [{ path: 'note', observed: 'x' }],
    }),
    /note/
  );
});

// ── partial fills ───────────────────────────────────────────────────────────

test('ONE surviving placeholder out of many still reads as UNFILLED', () => {
  const text = scaffold(SPEC);
  const parsed = JSON.parse(text);
  parsed.mechanism = 'the catalog key is absent so resolveModel falls through to the budget tier';
  parsed.reproduced = true;
  parsed.evidence[0].command = 'node -e "…"';
  // evidence[0].observed deliberately left as the placeholder.
  assert.strictEqual(hasUnfilledPlaceholders(JSON.stringify(parsed, null, 2)), true);
  assert.strictEqual(findPlaceholders(JSON.stringify(parsed, null, 2)).length, 1);
});

test('only an artifact with EVERY placeholder replaced reads as filled', () => {
  const filled = fillAll(scaffold(SPEC));
  assert.strictEqual(
    hasUnfilledPlaceholders(filled),
    false,
    'the meta/instruction block must not itself contain the raw sentinel, or a fully ' +
      'filled artifact would be denied forever'
  );
  // And it is still valid JSON after filling.
  assert.doesNotThrow(() => JSON.parse(filled));
});

test('a partially-EDITED placeholder reads as UNFILLED (fail-closed)', () => {
  // The realistic mangling: the closing delimiter is deleted / the value is truncated.
  assert.strictEqual(hasUnfilledPlaceholders('"mechanism": "<<<FILL:mechanism"'), true);
  assert.strictEqual(hasUnfilledPlaceholders('"mechanism": "<<<FILL"'), true);
  assert.strictEqual(hasUnfilledPlaceholders('"mechanism": "<<<FILL:mechanism>>"'), true);
  // Erosion on the OPENING side is also caught — detection needs neither delimiter intact.
  assert.strictEqual(hasUnfilledPlaceholders('"mechanism": "<<FILL:mechanism>>>"'), true);
  assert.strictEqual(hasUnfilledPlaceholders('"mechanism": "<FILL:mechanism>>>"'), true);
});

test('DOCUMENTED LIMIT: deleting the word FILL itself is indistinguishable from filling it', () => {
  // The one mangling this cannot see. At that point the sentinel is gone and the value is
  // just a bad value — which is the GATE\'s own shape assertions\' job, not this module\'s.
  assert.strictEqual(hasUnfilledPlaceholders('"mechanism": "<<<:mechanism>>>"'), false);
});

test('hasUnfilledPlaceholders tolerates non-string input by failing CLOSED', () => {
  assert.strictEqual(hasUnfilledPlaceholders(null), true);
  assert.strictEqual(hasUnfilledPlaceholders(undefined), true);
  assert.strictEqual(hasUnfilledPlaceholders(42), true);
  assert.strictEqual(hasUnfilledPlaceholders({}), true);
  assert.strictEqual(hasUnfilledPlaceholders(''), true);
});

// ── shape of the skeleton ───────────────────────────────────────────────────

test('the skeleton is valid JSON so the ENF-19 reader reaches the placeholder check', () => {
  const doc = JSON.parse(scaffold(SPEC));
  assert.strictEqual(doc.schema, 1, 'declared format constants are carried through');
  assert.strictEqual(typeof doc.mechanism, 'string');
  assert.strictEqual(Array.isArray(doc.evidence), true);
  assert.strictEqual(doc.evidence.length, 1);
  assert.strictEqual(typeof doc.evidence[0].command, 'string');
});

test('the skeleton names its artifact and the step it belongs to', () => {
  const doc = JSON.parse(scaffold(SPEC));
  assert.ok(String(doc._artifact).includes('P1-repro.json'));
  assert.ok(String(doc._artifact).includes('the reproduction that justifies filing'));
  assert.strictEqual(doc._step, 'P1 — reproduce the mechanism before filing');
  assert.ok(/observed/i.test(String(doc._howto)), 'the instructions must demand OBSERVED values');
});

test('each placeholder line carries a one-line comment describing an OBSERVED value', () => {
  const text = scaffold(SPEC);
  for (const f of SPEC.fields) {
    const line = text.split('\n').find((l) => l.includes(placeholderFor(f.path)));
    assert.ok(line, `no line for ${f.path}`);
    assert.ok(line.includes(f.observed), `line for ${f.path} lacks its guidance comment`);
    assert.strictEqual(line.includes('\n'), false, 'one placeholder per LINE');
  }
});

test('scaffold refuses an array index gap — a JSON hole would serialize as a null value', () => {
  assert.throws(
    () => scaffold({
      title: 'Z.json',
      step: 'Z',
      fields: [{ path: 'evidence.2.command', observed: 'x' }],
    }),
    /index/i
  );
});

test('scaffold requires a title and a step', () => {
  assert.throws(() => scaffold({ step: 'Z', fields: [{ path: 'a', observed: 'x' }] }), /title/i);
  assert.throws(() => scaffold({ title: 'Z.json', fields: [{ path: 'a', observed: 'x' }] }), /step/i);
  assert.throws(() => scaffold(null), /spec/i);
});

// ── determinism ─────────────────────────────────────────────────────────────

test('DETERMINISM: scaffold(spec) twice returns byte-identical text', () => {
  assert.strictEqual(scaffold(SPEC), scaffold(SPEC));
  assert.strictEqual(scaffold(MINIMAL), scaffold(MINIMAL));
  // No timestamp, no run id, no randomness anywhere in the output.
  assert.strictEqual(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(scaffold(SPEC)), false);
});

test('DETERMINISM: field order in the output follows the spec order', () => {
  const lines = scaffold(SPEC).split('\n');
  const idx = (needle) => lines.findIndex((l) => l.includes(needle));
  assert.ok(idx('"mechanism"') < idx('"reproduced"'));
  assert.ok(idx('"reproduced"') < idx('"command"'));
  assert.ok(idx('"command"') < idx('"observed"'));
});

// ── writeScaffoldIfAbsent ───────────────────────────────────────────────────

test('writeScaffoldIfAbsent writes the skeleton when the file is absent', () => {
  const dir = tmpdir();
  const p = path.join(dir, 'nested', 'deeper', 'P1-repro.json');
  const res = writeScaffoldIfAbsent(p, SPEC);
  assert.strictEqual(res.written, true);
  assert.strictEqual(res.path, p);
  assert.strictEqual(fs.readFileSync(p, 'utf8'), scaffold(SPEC));
  assert.strictEqual(hasUnfilledPlaceholders(fs.readFileSync(p, 'utf8')), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('writeScaffoldIfAbsent opens with flag `wx` (exclusive create), never a plain write', () => {
  const seen = [];
  const fakeFs = {
    existsSync: () => false,
    mkdirSync: () => {},
    writeFileSync: (p, data, opts) => { seen.push({ p, data, opts }); },
  };
  const res = writeScaffoldIfAbsent('/nowhere/P1-repro.json', SPEC, { fs: fakeFs });
  assert.strictEqual(res.written, true);
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].opts.flag, 'wx');
  assert.strictEqual(seen[0].data, scaffold(SPEC));
});

test('writeScaffoldIfAbsent on an EXISTING file is a no-op and does NOT clobber it', () => {
  const dir = tmpdir();
  const p = path.join(dir, 'P1-repro.json');
  const real = JSON.stringify({ schema: 1, mechanism: 'ten minutes of real work' }, null, 2);
  fs.writeFileSync(p, real, 'utf8');
  const before = fs.readFileSync(p);

  const res = writeScaffoldIfAbsent(p, SPEC);
  assert.strictEqual(res.written, false);
  assert.strictEqual(res.reason, 'exists');
  assert.deepStrictEqual(fs.readFileSync(p), before, 'the original BYTES must survive verbatim');
  assert.strictEqual(fs.readFileSync(p, 'utf8'), real);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CONCURRENCY: two callers race through the pre-check → exactly one writes', () => {
  const dir = tmpdir();
  const p = path.join(dir, 'P1-repro.json');
  // Both "processes" observe absence (the pre-check is inherently racy); O_EXCL decides.
  const raceFs = {
    existsSync: () => false,
    mkdirSync: (d, o) => fs.mkdirSync(d, o),
    writeFileSync: (f, d, o) => fs.writeFileSync(f, d, o),
  };

  const a = writeScaffoldIfAbsent(p, SPEC, { fs: raceFs });
  const b = writeScaffoldIfAbsent(p, SPEC, { fs: raceFs });

  const written = [a, b].filter((r) => r.written === true);
  const lost = [a, b].filter((r) => r.written === false);
  assert.strictEqual(written.length, 1, 'exactly one caller may create the artifact');
  assert.strictEqual(lost.length, 1);
  assert.strictEqual(lost[0].reason, 'race');

  // And no partial / doubled / corrupt file resulted.
  const onDisk = fs.readFileSync(p, 'utf8');
  assert.strictEqual(onDisk, scaffold(SPEC));
  assert.doesNotThrow(() => JSON.parse(onDisk));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('writeScaffoldIfAbsent reports a write failure instead of throwing', () => {
  const fakeFs = {
    existsSync: () => false,
    mkdirSync: () => {},
    writeFileSync: () => { const e = new Error('EACCES: permission denied'); e.code = 'EACCES'; throw e; },
  };
  const res = writeScaffoldIfAbsent('/nowhere/P1-repro.json', SPEC, { fs: fakeFs });
  assert.strictEqual(res.written, false);
  assert.strictEqual(res.reason, 'write-failed');
  assert.ok(/EACCES/.test(res.error));
});

test('writeScaffoldIfAbsent reports an mkdir failure instead of throwing', () => {
  const fakeFs = {
    existsSync: () => false,
    mkdirSync: () => { const e = new Error('EROFS: read-only file system'); e.code = 'EROFS'; throw e; },
    writeFileSync: () => { throw new Error('must not be reached'); },
  };
  const res = writeScaffoldIfAbsent('/nowhere/P1-repro.json', SPEC, { fs: fakeFs });
  assert.strictEqual(res.written, false);
  assert.strictEqual(res.reason, 'mkdir-failed');
  assert.ok(/EROFS/.test(res.error));
});

test('writeScaffoldIfAbsent PROPAGATES a spec contract bug — a bad spec must be loud', () => {
  const fakeFs = { existsSync: () => false, mkdirSync: () => {}, writeFileSync: () => {} };
  assert.throws(
    () => writeScaffoldIfAbsent('/nowhere/Z.json', { title: 'Z', step: 'Z', fields: [] }, { fs: fakeFs }),
    /at least one field|self-satisfying/i
  );
});

test('writeScaffoldIfAbsent requires an absolute-ish path string', () => {
  assert.throws(() => writeScaffoldIfAbsent('', SPEC), /path/i);
  assert.throws(() => writeScaffoldIfAbsent(null, SPEC), /path/i);
});
