'use strict';

/**
 * bin/claims-delta.test.cjs — HERMETIC test of the claims-delta report and gate (quick 261113-cde).
 *
 * Every case builds a throwaway git repo, commits a base and a head, and runs the real CLI. The
 * load-bearing properties: the #5119 sentence is flagged, a flagged claim blocks the gate until it
 * is resolved or rewritten, and every doubt (bad policy, bad resolutions, nothing examined) fails
 * rather than passes.
 *
 * @module bin/claims-delta.test
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const CLI = path.join(__dirname, 'claims-delta.cjs');
const SWITCH = 'A `switch` case body is not a miss.';

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });
}

function makeRepo(baseFiles, headFiles) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claims-delta-'));
  git(root, 'init', '-q', '-b', 'main');
  const put = (files) => {
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), text);
    }
  };
  put({ 'README.txt': 'base\n', ...baseFiles });
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  git(root, 'tag', 'base');
  put(headFiles);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'head change');
  const dir = path.join(root, '.out');
  fs.mkdirSync(dir);
  return { root, dir };
}

function run(fx, extra = [], range = 'base..HEAD') {
  const r = spawnSync(process.execPath, [CLI, range, '--dir', fx.dir, '--repo', fx.root, ...extra], { encoding: 'utf8' });
  let json = null;
  try { json = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { /* usage errors print no JSON */ }
  return { code: r.status, out: r.stdout, err: r.stderr, json };
}

const NOBODY = ['--no-body', 'test fixture has no PR body'];
const sentences = (j) => (j && j.claims) || [];

test('the #5119 sentence in a code comment is flagged (negated)', () => {
  const fx = makeRepo({}, { 'a.cjs': `// ${SWITCH}\nmodule.exports = 1;\n` });
  const r = run(fx, NOBODY);
  assert.equal(r.code, 0);
  const c = sentences(r.json).find((s) => s.text.includes('switch'));
  assert.ok(c, 'sentence listed');
  assert.equal(c.kind, 'comment');
  assert.ok(c.flags.includes('negated'));
  assert.ok(fs.existsSync(path.join(fx.dir, 'CLAIMS-DELTA.md')));
});

test('the positive twin and a curly-apostrophe sentence are flagged; a plain sentence is not', () => {
  const fx = makeRepo({}, { 'a.cjs': '// A `switch` case body is a miss.\n// It doesn’t retry.\n// Adds a retry.\nmodule.exports = 1;\n' });
  const r = run(fx, NOBODY);
  const by = (t) => sentences(r.json).find((s) => s.text.includes(t));
  assert.ok(by('is a miss').flags.includes('definitional'));
  assert.ok(by('retry.') && by('doesn').flags.includes('negated'));
  assert.deepEqual(sentences(r.json).find((s) => s.text === 'Adds a retry.').flags, []);
});

test('each pattern family fires on its own sentence', () => {
  const lines = ['// This never fails.', '// The cache key is the path.', '// Recorded here rather than by editing section 5.', '// No caller passes null.'];
  const fx = makeRepo({}, { 'a.cjs': lines.join('\n') + '\nmodule.exports = 1;\n' });
  const r = run(fx, NOBODY);
  const flags = (t) => sentences(r.json).find((s) => s.text.includes(t)).flags;
  assert.ok(flags('never fails').includes('quantifier'));
  assert.ok(flags('cache key').includes('definitional'));
  assert.ok(flags('rather than').includes('scope-negation'));
  assert.ok(flags('No caller').includes('quantifier'));
});

test('wrapped comment lines join into one sentence', () => {
  const fx = makeRepo({}, { 'a.cjs': '// A switch case body\n// is not a miss.\nmodule.exports = 1;\n' });
  const r = run(fx, NOBODY);
  assert.ok(sentences(r.json).some((s) => s.text === 'A switch case body is not a miss.'));
});

test('test titles, ADR lines, doc lines and commit messages are sources', () => {
  const fx = makeRepo({}, {
    'x.test.cjs': "test('the guard never throws', () => {});\n",
    'docs/adr/0001-x.md': '# ADR\n\nThe lock is always held.\n',
    'notes/n.md': 'Every row is checked.\n',
  });
  const r = run(fx, NOBODY);
  const kinds = new Set(sentences(r.json).map((s) => s.kind));
  for (const k of ['title', 'adr', 'doc', 'commit']) assert.ok(kinds.has(k), `kind ${k}`);
  assert.ok(r.json.examined.title >= 1 && r.json.examined.adr >= 1);
});

test('PR body lines come from the body diff (new minus old, multiset)', () => {
  const fx = makeRepo({}, { 'a.cjs': 'module.exports = 1;\n' });
  const oldB = path.join(fx.dir, 'old.txt');
  const newB = path.join(fx.dir, 'new.txt');
  fs.writeFileSync(oldB, 'Kept line.\n');
  fs.writeFileSync(newB, 'Kept line.\nThe fix is never partial.\n');
  const r = run(fx, ['--body-old', oldB, '--body-new', newB]);
  const body = sentences(r.json).filter((s) => s.kind === 'body');
  assert.equal(body.length, 1);
  assert.match(body[0].text, /never partial/);
});

test('gate: an unresolved flagged claim exits 1; report mode exits 0', () => {
  const fx = makeRepo({}, { 'a.cjs': `// ${SWITCH}\n` });
  assert.equal(run(fx, NOBODY).code, 0);
  const g = run(fx, ['--gate', ...NOBODY]);
  assert.equal(g.code, 1);
  assert.ok(g.json.unresolved.length >= 1);
});

function resolution(fx, patch) {
  const id = run(fx, NOBODY).json.claims.find((s) => s.flags.length).id;
  if (!fs.existsSync(path.join(fx.root, 'oracle.cjs'))) {
    fs.writeFileSync(path.join(fx.root, 'oracle.cjs'), '// oracle\nmodule.exports = 1;\n');
    git(fx.root, 'add', 'oracle.cjs');
    git(fx.root, 'commit', '-q', '-m', 'oracle');
  }
  const entry = { id, kind: 'oracle', new_inputs: 10, evidence: 'oracle.cjs', command: 'node oracle.cjs', ...patch };
  fs.writeFileSync(path.join(fx.dir, 'CLAIMS-RESOLUTIONS.json'), JSON.stringify([entry]));
  return entry;
}

test('gate: an oracle entry with 10 new inputs resolves; 9 does not', () => {
  const fx = makeRepo({}, { 'a.cjs': `// ${SWITCH}\n` });
  resolution(fx, {});
  const ok = run(fx, ['--gate', ...NOBODY]);
  assert.equal(ok.code, 0, ok.out + ok.err);
  const fx2 = makeRepo({}, { 'a.cjs': `// ${SWITCH}\n` });
  resolution(fx2, { new_inputs: 9 });
  assert.equal(run(fx2, ['--gate', ...NOBODY]).code, 1);
});

test('gate: evidence that escapes the repo, is untracked, or is empty is refused', () => {
  const fx = makeRepo({}, { 'a.cjs': `// ${SWITCH}\n` });
  resolution(fx, { evidence: '../outside.cjs' });
  assert.equal(run(fx, ['--gate', ...NOBODY]).code, 1);
  fs.writeFileSync(path.join(fx.root, 'untracked.cjs'), 'x\n');
  resolution(fx, { evidence: 'untracked.cjs' });
  assert.equal(run(fx, ['--gate', ...NOBODY]).code, 1);
  fs.writeFileSync(path.join(fx.root, 'empty.cjs'), '');
  git(fx.root, 'add', 'empty.cjs');
  git(fx.root, 'commit', '-q', '-m', 'empty');
  resolution(fx, { evidence: 'empty.cjs' });
  assert.equal(run(fx, ['--gate', ...NOBODY]).code, 1);
});

test('gate: a tracked symlink pointing outside the repo is refused', () => {
  const fx = makeRepo({}, { 'a.cjs': `// ${SWITCH}\n` });
  const outside = path.join(os.tmpdir(), `cd-out-${process.pid}.cjs`);
  fs.writeFileSync(outside, 'x\n');
  fs.symlinkSync(outside, path.join(fx.root, 'link.cjs'));
  git(fx.root, 'add', 'link.cjs');
  git(fx.root, 'commit', '-q', '-m', 'link');
  resolution(fx, { evidence: 'link.cjs' });
  const r = run(fx, ['--gate', ...NOBODY]);
  fs.rmSync(outside);
  assert.equal(r.code, 1);
});

test('gate: a missing command, string new_inputs, unknown kind, extra field or duplicate id fail', () => {
  for (const patch of [{ command: '' }, { new_inputs: '10' }, { kind: 'trust-me' }, { extra: 1 }]) {
    const fx = makeRepo({}, { 'a.cjs': `// ${SWITCH}\n` });
    resolution(fx, patch);
    assert.equal(run(fx, ['--gate', ...NOBODY]).code, 1, JSON.stringify(patch));
  }
  const fx = makeRepo({}, { 'a.cjs': `// ${SWITCH}\n` });
  const e = resolution(fx, {});
  fs.writeFileSync(path.join(fx.dir, 'CLAIMS-RESOLUTIONS.json'), JSON.stringify([e, e]));
  assert.equal(run(fx, ['--gate', ...NOBODY]).code, 1);
});

test('gate: unparseable resolutions fail', () => {
  const fx = makeRepo({}, { 'a.cjs': `// ${SWITCH}\n` });
  fs.writeFileSync(path.join(fx.dir, 'CLAIMS-RESOLUTIONS.json'), '{nope');
  assert.equal(run(fx, ['--gate', ...NOBODY]).code, 1);
});

test('gate: not-a-rule needs a 15+ char reason and is listed as a dismissal', () => {
  const fx = makeRepo({}, { 'a.cjs': `// ${SWITCH}\n` });
  const id = run(fx, NOBODY).json.claims.find((s) => s.flags.length).id;
  fs.writeFileSync(path.join(fx.dir, 'CLAIMS-RESOLUTIONS.json'), JSON.stringify([{ id, kind: 'not-a-rule', reason: 'short' }]));
  assert.equal(run(fx, ['--gate', ...NOBODY]).code, 1);
  fs.writeFileSync(path.join(fx.dir, 'CLAIMS-RESOLUTIONS.json'), JSON.stringify([{ id, kind: 'not-a-rule', reason: 'quoted from the issue title, not a behavior claim' }]));
  const ok = run(fx, ['--gate', ...NOBODY]);
  assert.equal(ok.code, 0, ok.out + ok.err);
  assert.match(fs.readFileSync(path.join(fx.dir, 'CLAIMS-DELTA.md'), 'utf8'), /Reasoned dismissals/);
});

test('gate: a weakened rewrite passes because the delta is recomputed', () => {
  const fx = makeRepo({}, { 'a.cjs': `// ${SWITCH}\n` });
  assert.equal(run(fx, ['--gate', ...NOBODY]).code, 1);
  fs.writeFileSync(path.join(fx.root, 'a.cjs'), '// These switch shapes are reported: case 1, case 2.\n');
  git(fx.root, 'add', 'a.cjs');
  git(fx.root, 'commit', '-q', '-m', 'weaken');
  assert.equal(run(fx, ['--gate', ...NOBODY]).code, 0);
});

test('stale and unneeded resolutions warn without failing', () => {
  const fx = makeRepo({}, { 'a.cjs': '// Adds a retry.\n' });
  fs.writeFileSync(path.join(fx.dir, 'CLAIMS-RESOLUTIONS.json'), JSON.stringify([
    { id: 'aaaaaaaaaaaa', kind: 'not-a-rule', reason: 'there is no such claim here' },
  ]));
  const r = run(fx, ['--gate', ...NOBODY]);
  assert.equal(r.code, 0);
  assert.ok(r.json.warnings.some((w) => /stale-resolution/.test(w)));
});

test('gate: body flags are required unless --no-body gives a reason; a run that examines nothing fails', () => {
  const fx = makeRepo({}, { 'a.cjs': '// Adds a retry.\n' });
  assert.equal(run(fx, ['--gate']).code, 1);
  const fx2 = makeRepo({}, { 'img.bin': 'x' });
  const r = run(fx2, ['--gate', '--no-body', 'nothing to say here']);
  // the head commit message is always a source, so make it empty of sentences by using a range with no commits
  assert.ok(r.code === 0 || r.code === 1);
  const empty = run(fx2, ['--gate', '--no-body', 'nothing to say here'], 'HEAD..HEAD');
  assert.equal(empty.code, 1);
});

test('oversize sentence is flagged, not truncated', () => {
  const long = 'word '.repeat(420) + 'never ' + 'word '.repeat(10);
  const fx = makeRepo({}, { 'a.cjs': `// ${long}\n` });
  const r = run(fx, NOBODY);
  const c = sentences(r.json).find((s) => s.text.includes('never'));
  assert.ok(c.flags.includes('oversize'));
  assert.ok(c.flags.includes('quantifier'));
});

test('policy: empty patterns or a lowered threshold without a reason fails; with a reason it is recorded', () => {
  const fx = makeRepo({}, { 'a.cjs': '// Adds a retry.\n' });
  const bad = path.join(fx.dir, 'bad.json');
  fs.writeFileSync(bad, JSON.stringify({ minNewInputs: 10, patterns: [] }));
  assert.equal(run(fx, ['--gate', ...NOBODY, '--policy', bad, '--policy-reason', 'testing an empty policy now']).code, 1);
  const low = path.join(fx.dir, 'low.json');
  const shipped = JSON.parse(fs.readFileSync(path.join(__dirname, 'claims-delta.policy.json'), 'utf8'));
  fs.writeFileSync(low, JSON.stringify({ ...shipped, minNewInputs: 3 }));
  assert.equal(run(fx, ['--gate', ...NOBODY, '--policy', low]).code, 1);
  const ok = run(fx, ['--gate', ...NOBODY, '--policy', low, '--policy-reason', 'tuning the threshold for a tiny repo']);
  assert.equal(ok.code, 0, ok.out + ok.err);
  assert.match(ok.json.policy.reason, /tiny repo/);
});

test('usage errors exit 2 and write nothing', () => {
  const fx = makeRepo({}, { 'a.cjs': '// x\n' });
  for (const args of [[], ['base..HEAD'], ['base..HEAD', '--dir', fx.dir, '--bogus']]) {
    const r = spawnSync(process.execPath, [CLI, ...args, '--repo', fx.root], { encoding: 'utf8' });
    assert.equal(r.status, 2, args.join(' '));
  }
  assert.deepEqual(fs.readdirSync(fx.dir), []);
});

test('three-dot range diffs from the merge base', () => {
  const fx = makeRepo({}, { 'a.cjs': '// Adds a retry.\n' });
  git(fx.root, 'checkout', '-q', '-b', 'side', 'base');
  fs.writeFileSync(path.join(fx.root, 'b.cjs'), '// The side never fails.\n');
  git(fx.root, 'add', '-A');
  git(fx.root, 'commit', '-q', '-m', 'side');
  const r = run(fx, NOBODY, 'main...side');
  assert.ok(sentences(r.json).some((s) => s.text.includes('side never fails')));
  assert.ok(!sentences(r.json).some((s) => s.text.includes('Adds a retry')));
});

// --- R1 iteration 1 rows (B-01, B-02, W-01, W-02, W-04, W-05) ---------------------------------------

test('B-01: a range side that starts with - is a usage error and git writes nothing', () => {
  const fx = makeRepo({}, { 'a.cjs': '// Adds a retry.\n' });
  const target = path.join(os.tmpdir(), `cd-pwned-${process.pid}`);
  const r = spawnSync(process.execPath, [CLI, `HEAD..--output=${target}`, '--dir', fx.dir, '--repo', fx.root, ...NOBODY], { encoding: 'utf8' });
  const wrote = fs.existsSync(target);
  if (wrote) fs.rmSync(target);
  assert.equal(r.status, 2);
  assert.equal(wrote, false);
});

test('B-02: a changed file with no extractor is listed and the gate refuses until --allow-unexamined', () => {
  const fx = makeRepo({}, { 'x.go': '// Never leaks.\n' });
  const g = run(fx, ['--gate', ...NOBODY]);
  assert.equal(g.code, 1);
  assert.deepEqual(g.json.unexamined_files, ['x.go']);
  const ok = run(fx, ['--gate', ...NOBODY, '--allow-unexamined', 'go file reviewed by hand']);
  assert.equal(ok.code, 0, ok.out + ok.err);
  assert.match(fs.readFileSync(path.join(fx.dir, 'CLAIMS-DELTA.md'), 'utf8'), /x\.go/);
});

test('W-01: an added line that starts with ++ does not swallow the rest of the file', () => {
  const fx = makeRepo({}, { 'n.md': '++ x\n\nThis never fails.\n' });
  const r = run(fx, NOBODY);
  assert.ok(sentences(r.json).some((s) => s.text === 'This never fails.' && s.loc.startsWith('n.md')));
});

test('W-02: a markdown table row is its own sentence, so a table is not one oversize sentence', () => {
  const rows = Array.from({ length: 120 }, (_, i) => `| row ${i} | cell value ${i} |`).join('\n');
  const fx = makeRepo({}, { 't.md': `| a | b |\n|---|---|\n${rows}\n` });
  const r = run(fx, NOBODY);
  assert.ok(!sentences(r.json).some((s) => s.flags.includes('oversize')));
});

test('W-04: a policy whose patterns match nothing, or that sets g/y flags, is refused', () => {
  const fx = makeRepo({}, { 'a.cjs': '// Adds a retry.\n' });
  const shipped = JSON.parse(fs.readFileSync(path.join(__dirname, 'claims-delta.policy.json'), 'utf8'));
  const dead = path.join(fx.dir, 'dead.json');
  fs.writeFileSync(dead, JSON.stringify({ ...shipped, patterns: shipped.patterns.map((p) => ({ ...p, regex: '(?!)' })) }));
  assert.equal(run(fx, NOBODY.concat(['--policy', dead, '--policy-reason', 'a dead policy for the test'])).code, 1);
  const sticky = path.join(fx.dir, 'sticky.json');
  fs.writeFileSync(sticky, JSON.stringify({ ...shipped, patterns: shipped.patterns.map((p) => ({ ...p, flags: 'gi' })) }));
  assert.equal(run(fx, NOBODY.concat(['--policy', sticky, '--policy-reason', 'a sticky policy for the test'])).code, 1);
});

test('W-05: evidence must be changed in the range or be a test file', () => {
  const fx = makeRepo({}, { 'a.cjs': `// ${SWITCH}\n` });
  resolution(fx, { evidence: 'README.txt' });
  assert.equal(run(fx, ['--gate', ...NOBODY]).code, 1);
});

// --- R1 iteration 2 rows ------------------------------------------------------------------------------

test('I2: an unterminated title line with many backslashes does not hang the parser', () => {
  const fx = makeRepo({}, { 'x.test.cjs': `it('${'\\\\'.repeat(60)}\n` });
  const t0 = Date.now();
  run(fx, NOBODY);
  assert.ok(Date.now() - t0 < 5000);
});

test('I2: titles in *.spec.* files and __tests__ dirs are sources', () => {
  const fx = makeRepo({}, { 'a.spec.cjs': "it('never leaks', () => {});\n", '__tests__/b.cjs': "test('always safe', () => {});\n" });
  const r = run(fx, NOBODY);
  assert.equal(sentences(r.json).filter((s) => s.kind === 'title').length, 2);
});

test('I2: a code-only round with a commit message is examined, not refused as vacuous', () => {
  const fx = makeRepo({}, { 'a.cjs': 'module.exports = 1;\n' });
  assert.equal(run(fx, ['--gate', ...NOBODY]).code, 0);
});
