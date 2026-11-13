'use strict';

/**
 * bin/claims-delta.test.cjs — HERMETIC test of the claims-delta report and gate (quick 261113-cde, FIX-PLAN R3).
 *
 * Every case builds a throwaway git repo, commits a base and a head, and runs the real CLI. The model under
 * test: EVERY added line of every readable file, every added commit-message line and every body-diff line is a
 * candidate, whatever the file type; the kind label never decides what is examined. The load-bearing
 * properties: the #5119 sentence is flagged, a flagged claim blocks the gate until it is resolved or
 * rewritten, and every doubt (bad policy, bad resolutions, nothing examined, a binary file) fails rather
 * than passes, leaving no stale clean report behind.
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
const claims = (r) => (r.json && r.json.claims) || [];
const texts = (r) => claims(r).map((c) => c.text);
const reportPath = (fx) => path.join(fx.dir, 'CLAIMS-DELTA.md');

test('the #5119 sentence in a code comment is flagged (negated)', () => {
  const fx = makeRepo({}, { 'a.cjs': `// ${SWITCH}\nmodule.exports = 1;\n` });
  const r = run(fx, NOBODY);
  assert.equal(r.code, 0);
  const c = claims(r).find((s) => s.text.includes('switch'));
  assert.ok(c, 'claim listed');
  assert.equal(c.kind, 'comment');
  assert.ok(c.flags.includes('negated'));
  assert.ok(fs.existsSync(reportPath(fx)));
});

test('the positive twin and a curly-apostrophe sentence are flagged; a plain sentence is not listed', () => {
  const fx = makeRepo({}, { 'a.cjs': '// A `switch` case body is a miss.\n// It doesn\u2019t retry.\n// Adds a retry.\nmodule.exports = 1;\n' });
  const r = run(fx, NOBODY);
  assert.ok(claims(r).some((c) => c.text.includes('is a miss') && c.flags.includes('definitional')));
  assert.ok(claims(r).some((c) => c.text.includes('doesn') && c.flags.includes('negated')));
  assert.ok(!texts(r).some((t) => t === 'Adds a retry.'));
});

test('each pattern family fires on its own sentence', () => {
  const lines = ['// This never fails.', '// The cache key is the path.', '// Recorded here rather than by editing section 5.', '// No caller passes null.'];
  const fx = makeRepo({}, { 'a.cjs': lines.join('\n') + '\nmodule.exports = 1;\n' });
  const r = run(fx, NOBODY);
  const flags = (t) => claims(r).find((c) => c.text.includes(t)).flags;
  assert.ok(flags('never fails').includes('quantifier'));
  assert.ok(flags('cache key').includes('definitional'));
  assert.ok(flags('rather than').includes('scope-negation'));
  assert.ok(flags('No caller').includes('quantifier'));
});

test('a sentence wrapped over comment lines is one claim with its whole text', () => {
  const fx = makeRepo({}, { 'a.cjs': '// A switch case body\n// is not a miss.\nmodule.exports = 1;\n' });
  const r = run(fx, NOBODY);
  assert.ok(texts(r).includes('A switch case body is not a miss.'));
});

test('test titles, ADR lines, doc lines and commit messages are examined and labelled', () => {
  const fx = makeRepo({}, {
    'x.test.cjs': "test('the guard never throws', () => {});\n",
    'docs/adr/0001-x.md': '# ADR\n\nThe lock is always held.\n',
    'notes/n.md': 'Every row is checked.\n',
  });
  git(fx.root, 'commit', '-q', '--allow-empty', '-m', 'it never loses a row');
  const r = run(fx, NOBODY);
  const kinds = new Set(claims(r).map((c) => c.kind));
  for (const k of ['title', 'adr', 'doc', 'commit']) assert.ok(kinds.has(k), `kind ${k}`);
  assert.ok(r.json.examined.title >= 1 && r.json.examined.adr >= 1 && r.json.examined.commit >= 1);
});

test('PR body lines come from the body diff (new minus old, multiset)', () => {
  const fx = makeRepo({}, { 'a.cjs': 'module.exports = 1;\n' });
  const oldB = path.join(fx.dir, 'old.txt');
  const newB = path.join(fx.dir, 'new.txt');
  fs.writeFileSync(oldB, 'Kept line.\n');
  fs.writeFileSync(newB, 'Kept line.\nThe fix is never partial.\n');
  const r = run(fx, ['--body-old', oldB, '--body-new', newB]);
  const body = claims(r).filter((c) => c.kind === 'body');
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
  const id = claims(run(fx, NOBODY)).find((c) => c.text.includes('switch')).id;
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

test('gate: not-a-claim needs a 15+ char reason and is listed as a dismissal; the old not-a-rule kind is refused', () => {
  const fx = makeRepo({}, { 'a.cjs': `// ${SWITCH}\n` });
  const id = claims(run(fx, NOBODY)).find((c) => c.flags.length).id;
  const put = (e) => fs.writeFileSync(path.join(fx.dir, 'CLAIMS-RESOLUTIONS.json'), JSON.stringify([{ id, ...e }]));
  put({ kind: 'not-a-claim', reason: 'short' });
  assert.equal(run(fx, ['--gate', ...NOBODY]).code, 1);
  put({ kind: 'not-a-rule', reason: 'quoted from the issue title, not a behavior claim' });
  assert.equal(run(fx, ['--gate', ...NOBODY]).code, 1);
  put({ kind: 'not-a-claim', reason: 'quoted from the issue title, not a behavior claim' });
  const ok = run(fx, ['--gate', ...NOBODY]);
  assert.equal(ok.code, 0, ok.out + ok.err);
  assert.match(fs.readFileSync(reportPath(fx), 'utf8'), /Reasoned dismissals/);
});

test('gate: a weakened rewrite passes because the delta is recomputed', () => {
  const fx = makeRepo({}, { 'a.cjs': `// ${SWITCH}\n` });
  assert.equal(run(fx, ['--gate', ...NOBODY]).code, 1);
  fs.writeFileSync(path.join(fx.root, 'a.cjs'), '// These switch shapes are reported: case 1, case 2.\n');
  git(fx.root, 'add', 'a.cjs');
  git(fx.root, 'commit', '-q', '-m', 'weaken');
  assert.equal(run(fx, ['--gate', ...NOBODY]).code, 0);
});

test('a resolution for an id that is not in the delta warns (stale) without failing', () => {
  const fx = makeRepo({}, { 'a.cjs': '// Adds a retry.\n' });
  fs.writeFileSync(path.join(fx.dir, 'CLAIMS-RESOLUTIONS.json'), JSON.stringify([
    { id: 'aaaaaaaaaaaa', kind: 'not-a-claim', reason: 'there is no such claim here' },
  ]));
  const r = run(fx, ['--gate', ...NOBODY]);
  assert.equal(r.code, 0);
  assert.ok(r.json.warnings.some((w) => /stale-resolution/.test(w)));
});

test('gate: body flags are required unless --no-body gives a reason; a range with nothing in it fails', () => {
  const fx = makeRepo({}, { 'a.cjs': '// Adds a retry.\n' });
  assert.equal(run(fx, ['--gate']).code, 1);
  const empty = run(fx, ['--gate', '--no-body', 'nothing to say here'], 'HEAD..HEAD');
  assert.equal(empty.code, 1);
});

test('oversize claim is flagged, not truncated, and a reasoned not-a-claim clears it', () => {
  const long = 'word '.repeat(420) + 'never ' + 'word '.repeat(10);
  const fx = makeRepo({}, { 'a.cjs': `// ${long}\n` });
  const r = run(fx, NOBODY);
  const c = claims(r).find((s) => s.text.includes('never'));
  assert.ok(c.flags.includes('oversize') && c.flags.includes('quantifier'));
  fs.writeFileSync(path.join(fx.dir, 'CLAIMS-RESOLUTIONS.json'), JSON.stringify([{ id: c.id, kind: 'not-a-claim', reason: 'fixture filler text with no rule' }]));
  assert.equal(run(fx, ['--gate', ...NOBODY]).code, 0);
});

test('policy: empty patterns, dead patterns, g/y flags, or a --policy without a reason fail', () => {
  const fx = makeRepo({}, { 'a.cjs': '// Adds a retry.\n' });
  const shipped = JSON.parse(fs.readFileSync(path.join(__dirname, 'claims-delta.policy.json'), 'utf8'));
  const put = (name, pol) => { const f = path.join(fx.dir, name); fs.writeFileSync(f, JSON.stringify(pol)); return f; };
  const reason = ['--policy-reason', 'a policy override for the test'];
  assert.equal(run(fx, [...NOBODY, '--policy', put('e.json', { ...shipped, patterns: [] }), ...reason]).code, 1);
  assert.equal(run(fx, [...NOBODY, '--policy', put('d.json', { ...shipped, patterns: shipped.patterns.map((p) => ({ ...p, regex: '(?!)' })) }), ...reason]).code, 1);
  assert.equal(run(fx, [...NOBODY, '--policy', put('s.json', { ...shipped, patterns: shipped.patterns.map((p) => ({ ...p, flags: 'gi' })) }), ...reason]).code, 1);
  const low = put('l.json', { ...shipped, minNewInputs: 3 });
  assert.equal(run(fx, ['--gate', ...NOBODY, '--policy', low]).code, 1);
  const ok = run(fx, ['--gate', ...NOBODY, '--policy', low, ...reason]);
  assert.equal(ok.code, 0, ok.out + ok.err);
  assert.match(ok.json.policy.reason, /override/);
});

test('usage errors exit 2 and write nothing when no report exists', () => {
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
  git(fx.root, 'add', 'b.cjs');
  git(fx.root, 'commit', '-q', '-m', 'side');
  const r = run(fx, NOBODY, 'main...side');
  assert.ok(texts(r).some((t) => t.includes('side never fails')));
});

test('B-01: a range side that starts with - is a usage error and git writes nothing', () => {
  const fx = makeRepo({}, { 'a.cjs': '// Adds a retry.\n' });
  const target = path.join(os.tmpdir(), `cd-pwned-${process.pid}`);
  const r = spawnSync(process.execPath, [CLI, `HEAD..--output=${target}`, '--dir', fx.dir, '--repo', fx.root, ...NOBODY], { encoding: 'utf8' });
  const wrote = fs.existsSync(target);
  if (wrote) fs.rmSync(target);
  assert.equal(r.status, 2);
  assert.equal(wrote, false);
});

test('B-02: a binary file is unexamined and the gate refuses until --allow-unexamined; an unknown text type is examined', () => {
  const fx = makeRepo({}, { 'img.bin': Buffer.from([0, 1, 2, 3, 0, 255, 0, 7]), 'x.go': '// Never leaks.\n' });
  const g = run(fx, ['--gate', ...NOBODY]);
  assert.equal(g.code, 1);
  assert.deepEqual(g.json.unexamined_files, ['img.bin (binary)']);
  assert.ok(claims(g).some((c) => c.loc.startsWith('x.go') && /Never leaks/.test(c.text)), 'the .go line is examined');
  const fx2 = makeRepo({}, { 'img.bin': Buffer.from([0, 1, 2, 3, 0, 255, 0, 7]) });
  assert.equal(run(fx2, ['--gate', ...NOBODY, '--allow-unexamined', 'binary asset reviewed by hand']).code, 0);
});

test('W-01: an added line that starts with ++ does not swallow the rest of the file', () => {
  const fx = makeRepo({}, { 'n.md': '++ x\n\nThis never fails.\n' });
  assert.ok(claims(run(fx, NOBODY)).some((c) => c.text === 'This never fails.' && c.loc.startsWith('n.md')));
});

test('W-02: a 120-row markdown table is not one oversize claim', () => {
  const rows = Array.from({ length: 120 }, (_, i) => `| row ${i} | cell value ${i} |`).join('\n');
  const fx = makeRepo({}, { 't.md': `| a | b |\n|---|---|\n${rows}\n| never | ever |\n` });
  const r = run(fx, NOBODY);
  assert.ok(!claims(r).some((c) => c.flags.includes('oversize')));
  assert.ok(claims(r).some((c) => /never/.test(c.text)));
});

test('W-05: evidence must be changed in the range or be a test file', () => {
  const fx = makeRepo({}, { 'a.cjs': `// ${SWITCH}\n` });
  resolution(fx, { evidence: 'README.txt' });
  assert.equal(run(fx, ['--gate', ...NOBODY]).code, 1);
});

test('I2: titles in *.spec.* files and __tests__ dirs are examined', () => {
  const fx = makeRepo({}, { 'a.spec.cjs': "it('never leaks', () => {});\n", '__tests__/b.cjs': "test('always safe', () => {});\n" });
  assert.equal(claims(run(fx, NOBODY)).filter((c) => /never leaks|always safe/.test(c.text)).length, 2);
});

test('I2: a code-only round with a commit message is examined, not refused as vacuous', () => {
  const fx = makeRepo({}, { 'a.cjs': 'module.exports = 1;\n' });
  assert.equal(run(fx, ['--gate', ...NOBODY]).code, 0);
});

// --- Every readable added line is a candidate, whatever its kind (FIX-PLAN R3) ---------------------------

test('R3: T1 star-less block continuation, T5 mid-line block comment, mid-line # and Ruby block are all flagged', () => {
  const fx = makeRepo({}, {
    'a.js': '/* first line\n   this never fails and is always safe\n*/\nlet z = 1; /* a mid-line never */\n',
    'r.rb': '=begin\nthis never raises\n=end\n',
    'run.sh': 'echo hi #never fails\n',
  });
  const t = texts(run(fx, NOBODY)).join('\n');
  for (const needle of ['never fails and is always safe', 'mid-line never', 'never raises', 'never fails']) assert.ok(t.includes(needle), needle);
});

test('R3 review BLOCKER 1: a Python string holding three quotes before a docstring does not hide the docstring', () => {
  const fx = makeRepo({}, { 'q.py': 'x = "a\\"\\"\\"b"\ndef f():\n    \'\'\'This never raises.\'\'\'\n    return 1\n' });
  assert.ok(texts(run(fx, NOBODY)).some((t) => /never raises/.test(t)));
});

test('R3 review BLOCKER 2: a /* after a // on one line, then a star-less continuation, is flagged', () => {
  const fx = makeRepo({}, { 'a.js': "const re = /a\\/\\//; /* opens here\nthis never fails and is always safe\n*/\n" });
  assert.ok(texts(run(fx, NOBODY)).some((t) => /never fails/.test(t)));
});

test('R3 review BLOCKER 3: CRLF in the diff, the body files and a commit message does not crash the gate', () => {
  const fx = makeRepo({}, { 'a.md': '- This never fails.\r\n\r\nSecond line is fine.\r\n', 'b.js': '\uFEFF// this never fails\r\nlet x = 1;\r\n' });
  const oldB = path.join(fx.dir, 'old.txt');
  const newB = path.join(fx.dir, 'new.txt');
  fs.writeFileSync(oldB, 'Kept.\r\n');
  fs.writeFileSync(newB, 'Kept.\r\nThe body is never stale.\r\n');
  fs.writeFileSync(path.join(fx.root, 'msg.txt'), 'subject\r\n\r\nthe tool never loses a row\r\n');
  git(fx.root, 'commit', '-q', '--allow-empty', '-F', 'msg.txt');
  const r = run(fx, ['--body-old', oldB, '--body-new', newB]);
  assert.equal(r.code, 0, r.err);
  const t = texts(r);
  assert.ok(t.some((x) => x === 'This never fails.'));
  assert.ok(t.some((x) => x === 'this never fails'));
  assert.ok(t.some((x) => /body is never stale/.test(x) && !/\r/.test(x)));
  assert.ok(t.some((x) => /never loses a row/.test(x) && !/\r/.test(x)));
});

test('R3: a bare code line holding a rule-shaped phrase is a candidate, labelled code', () => {
  const fx = makeRepo({}, { 'a.js': "throw new Error('The cache must not be reused');\n" });
  const c = claims(run(fx, NOBODY)).find((s) => /must not/.test(s.text));
  assert.ok(c, 'code line examined');
  assert.equal(c.kind, 'code');
});

test('R3: --first-parent is gone, so a merged base branch commit message is examined (all parents)', () => {
  const fx = makeRepo({}, { 'a.cjs': '// Adds a retry.\n' });
  git(fx.root, 'checkout', '-q', '-b', 'up', 'base');
  fs.writeFileSync(path.join(fx.root, 'u.cjs'), 'let u = 1;\n');
  git(fx.root, 'add', 'u.cjs');
  git(fx.root, 'commit', '-q', '-m', 'upstream says never');
  git(fx.root, 'checkout', '-q', 'main');
  git(fx.root, 'merge', '-q', '--no-edit', 'up');
  assert.ok(claims(run(fx, NOBODY)).some((c) => c.kind === 'commit' && /upstream says never/.test(c.text)));
});

test('R3: a failed run overwrites an earlier clean report with a refused stub; a usage error does too', () => {
  const fx = makeRepo({}, { 'a.cjs': '// Adds a retry.\n' });
  assert.equal(run(fx, ['--gate', ...NOBODY]).code, 0);
  assert.match(fs.readFileSync(reportPath(fx), 'utf8'), /clean/);
  const bad = path.join(fx.dir, 'bad.json');
  fs.writeFileSync(bad, '{nope');
  assert.equal(run(fx, ['--gate', ...NOBODY, '--policy', bad, '--policy-reason', 'a broken policy for the test']).code, 1);
  assert.match(fs.readFileSync(reportPath(fx), 'utf8'), /REFUSED/);
  assert.doesNotMatch(fs.readFileSync(reportPath(fx), 'utf8'), /Verdict: \*\*clean\*\*/);
  assert.equal(run(fx, ['--gate', ...NOBODY]).code, 0);
  const u = spawnSync(process.execPath, [CLI, 'base..HEAD', '--dir', fx.dir, '--repo', fx.root, '--bogus'], { encoding: 'utf8' });
  assert.equal(u.status, 2);
  assert.match(fs.readFileSync(reportPath(fx), 'utf8'), /REFUSED/);
});

test('R3: deleted files add nothing; a renamed file is examined as added', () => {
  const fx = makeRepo({ 'old.cjs': '// this never fails\nlet y = 2;\n', 'gone.cjs': '// always\n' }, { 'touch.txt': 'x\n' });
  git(fx.root, 'rm', '-q', 'gone.cjs');
  git(fx.root, 'mv', 'old.cjs', 'new.cjs');
  git(fx.root, 'commit', '-q', '-m', 'move');
  const r = run(fx, NOBODY);
  assert.ok(claims(r).some((c) => c.loc.startsWith('new.cjs') && /never fails/.test(c.text)));
  assert.ok(!claims(r).some((c) => c.loc.startsWith('gone.cjs')));
});

test('R3 Q-02: a configured external diff program is never run', () => {
  const fx = makeRepo({}, { 'a.cjs': '// Adds a retry.\n' });
  git(fx.root, 'config', 'diff.external', '/nonexistent/program');
  assert.equal(run(fx, NOBODY).code, 0);
});

test('R3: long mixed lines and a 5000-line file are scanned in bounded time', () => {
  const mixed = ('/* ' + '"""\'\'\' // /* x '.repeat(8000) + ' the key is the ').repeat(2);
  const big = Array.from({ length: 5000 }, (_, i) => `// line ${i} with some plain words`).join('\n') + '\n';
  const fx = makeRepo({}, { 'a.js': `${mixed}\nlet a = 1;\n`, 'b.js': big });
  const t0 = Date.now();
  const r = run(fx, NOBODY);
  assert.equal(r.code, 0, r.err);
  assert.ok(Date.now() - t0 < 8000, `took ${Date.now() - t0} ms`);
});

// --- R1 iteration 1 on FIX-PLAN R3 -------------------------------------------------------------------

test('R3 B-01: a sentence whose other half is an unchanged line is read whole', () => {
  const fx = makeRepo({ 'a.cjs': '// not reachable\nlet a = 1;\n' }, { 'a.cjs': '// This path is\n// not reachable\nlet a = 1;\n' });
  const c = claims(run(fx, NOBODY)).find((s) => /not reachable/.test(s.text));
  assert.ok(c, 'claim found across the added/unchanged boundary');
  assert.ok(c.flags.includes('negated'));
});

test('R3 W-01: emphasis, code spans and bare tags inside a phrase do not hide it', () => {
  const fx = makeRepo({}, { 'n.md': 'The value is **not** safe.\n\nIt does _not_ work.\n\nIt is `not` safe.\n\nIt is <b>not</b> safe.\n' });
  assert.equal(claims(run(fx, NOBODY)).filter((c) => c.flags.includes('negated')).length, 4);
});

test('R3 W-02: wrapped lines under ///, --, nested > and numbered markers still match', () => {
  const fx = makeRepo({}, {
    'a.rs': '/// it is\n/// not safe\n',
    'b.sql': '-- it is\n-- not safe\n',
    'c.md': '> > it is\n> > not safe\n',
    'd.md': '2. it is\n3. not safe\n',
  });
  const r = run(fx, NOBODY);
  for (const f of ['a.rs', 'b.sql', 'c.md', 'd.md']) assert.ok(claims(r).some((c) => c.loc.startsWith(f) && c.flags.includes('negated')), f);
});

test('R3 Q-02: a claim keeps its id when a neighbouring line changes', () => {
  const fx = makeRepo({}, { 'a.cjs': '// first\n// the cache key is a hash\n// third\nlet z = 1;\n' });
  const c1 = claims(run(fx, NOBODY)).find((c) => /cache key/.test(c.text));
  assert.ok(c1);
  fs.writeFileSync(path.join(fx.root, 'a.cjs'), '// first changed\n// the cache key is a hash\n// third changed again\nlet z = 1;\n');
  git(fx.root, 'add', 'a.cjs');
  git(fx.root, 'commit', '-q', '-m', 'edit neighbours');
  const c2 = claims(run(fx, NOBODY)).find((c) => /cache key/.test(c.text));
  assert.equal(c1.id, c2.id);
});

test('R3 W-04/W-07: the report names the commits and carries a per-file table', () => {
  const fx = makeRepo({}, { 'a.cjs': '// Adds a retry.\nlet z = 1;\n' });
  const r = run(fx, NOBODY);
  assert.match(r.json.head, /^[0-9a-f]{40}$/);
  assert.match(r.json.base, /^[0-9a-f]{40}$/);
  assert.ok(r.json.commits >= 1);
  const f = r.json.files.find((x) => x.file === 'a.cjs');
  assert.deepEqual([f.added, f.examined, f.flagged], [2, 2, 0]);
  assert.match(fs.readFileSync(reportPath(fx), 'utf8'), /a\.cjs \| 2 \| 2 \| 0/);
});

test('R3 W-03: a flag error before --dir still overwrites an existing report with a refused stub', () => {
  const fx = makeRepo({}, { 'a.cjs': '// Adds a retry.\n' });
  assert.equal(run(fx, ['--gate', ...NOBODY]).code, 0);
  const u = spawnSync(process.execPath, [CLI, '--bogus', 'base..HEAD', '--dir', fx.dir, '--repo', fx.root], { encoding: 'utf8' });
  assert.equal(u.status, 2);
  assert.match(fs.readFileSync(reportPath(fx), 'utf8'), /REFUSED/);
});

// --- R1 iteration 2 on FIX-PLAN R3 --------------------------------------------------------------------

test('R3-I2 B-01: scope-negation survives wrapping, indentation and emphasis', () => {
  const fx = makeRepo({}, { 'a.js': '    // this is recorded rather\n    // than edited here\n', 'n.md': 'Recorded **instead** of editing.\n', 'b.js': '// no wrap but   indented  rather   than this\n' });
  const r = run(fx, NOBODY);
  for (const f of ['a.js', 'n.md', 'b.js']) assert.ok(claims(r).some((c) => c.loc.startsWith(f) && c.flags.includes('scope-negation')), f);
});

test('R3-I2 B-02: a stray < on a line does not blank the comment after it', () => {
  const fx = makeRepo({}, { 'a.js': 'if (a<b) go(); // the pool must not be empty; f(x => x)\n' });
  assert.ok(claims(run(fx, NOBODY)).some((c) => /must not be empty/.test(c.text)));
});

test('R3-I2 W-01: deleting a binary file does not refuse the gate', () => {
  const fx = makeRepo({ 'img.bin': Buffer.from([0, 1, 2, 0, 255]) }, { 'a.cjs': '// Adds a retry.\n' });
  git(fx.root, 'rm', '-q', 'img.bin');
  git(fx.root, 'commit', '-q', '-m', 'drop binary');
  const g = run(fx, ['--gate', ...NOBODY]);
  assert.equal(g.code, 0, g.out + g.err);
});

test('R3-I2 W-05: a --dir=D spelling still stubs an old clean report on a usage error', () => {
  const fx = makeRepo({}, { 'a.cjs': '// Adds a retry.\n' });
  assert.equal(run(fx, ['--gate', ...NOBODY]).code, 0);
  const u = spawnSync(process.execPath, [CLI, `--dir=${fx.dir}`, 'base..HEAD', '--repo', fx.root], { encoding: 'utf8' });
  assert.equal(u.status, 2);
  assert.match(fs.readFileSync(reportPath(fx), 'utf8'), /REFUSED/);
});

// --- Coordinator adversarial review of 49349f1..90282df (quick 261113-cde) ------------------------------

test('review B-01: rule words inside tag attributes, JSX props and a stray < ... > are still read', () => {
  const fx = makeRepo({}, {
    'a.html': '<img alt="The gate always refuses unsigned pushes">\n',
    'b.html': '<abbr title="This check must never be skipped">x</abbr>\n',
    'c.jsx': '<Callout title="Tokens never expire ..." />\n',
    'd.js': '// lo<hi holds so the scan never overruns mid>lo\n',
    'e.md': 'The hook <must not> be skipped\n',
  });
  const r = run(fx, NOBODY);
  for (const f of ['a.html', 'b.html', 'c.jsx', 'd.js', 'e.md']) assert.ok(claims(r).some((c) => c.loc.startsWith(f)), f);
});

test('review B-01: one 200 KB line of repeated "<a x=" is scanned in under 2 s', () => {
  const fx = makeRepo({}, { 'big.txt': `${'<a x='.repeat(40000)}\n` });
  const t0 = Date.now();
  const r = run(fx, NOBODY);
  assert.equal(r.code, 0, r.err);
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
});

test('review W-01: a broadening clause added next to an unchanged trigger line is a claim', () => {
  const fx = makeRepo({ 'a.cjs': '// This guard never fails\nlet a = 1;\n' }, { 'a.cjs': '// This guard never fails\n// whatever process holds the lock.\nlet a = 1;\n' });
  assert.ok(claims(run(fx, NOBODY)).some((c) => /never fails/.test(c.text)), 'sentence with an added line is a candidate');
});

test('review W-02: a 0x01 byte inside a commit message does not drop the rest', () => {
  const fx = makeRepo({}, { 'a.cjs': 'let z = 1;\n' });
  fs.writeFileSync(path.join(fx.root, 'msg.txt'), 'tidy \x01 the queue never drops jobs\n');
  fs.writeFileSync(path.join(fx.root, 'a.cjs'), 'let z = 2;\n');
  git(fx.root, 'add', 'a.cjs');
  git(fx.root, 'commit', '-q', '-F', path.join(fx.root, 'msg.txt'));
  assert.ok(claims(run(fx, NOBODY)).some((c) => c.kind === 'commit' && /never drops jobs/.test(c.text)));
});

test('review W-03: a policy whose patterns use single spaces is refused at load (wrapped sample)', () => {
  const fx = makeRepo({}, { 'a.cjs': '// Adds a retry.\n' });
  const shipped = JSON.parse(fs.readFileSync(path.join(__dirname, 'claims-delta.policy.json'), 'utf8'));
  const single = { ...shipped, patterns: shipped.patterns.map((p) => (p.id === 'scope-negation' ? { ...p, regex: p.regex.replace(/\\s\+/g, ' ') } : p)) };
  const f = path.join(fx.dir, 'single.json');
  fs.writeFileSync(f, JSON.stringify(single));
  const r = run(fx, [...NOBODY, '--policy', f, '--policy-reason', 'a single-space policy for the test']);
  assert.equal(r.code, 1, r.out + r.err);
});

// --- Coordinator follow-up: only bare tags are read through (quick 261113-cde) ---------------------------

test('bare-tag follow-up: tag-hiding cases stay flagged next to bare tags, and <em>never</em> is flagged', () => {
  const fx = makeRepo({}, {
    'a.html': '<p><img alt="The gate always refuses unsigned pushes"></p>\n',
    'b.html': '<abbr title="This check must never be skipped">x</abbr>\n',
    'c.jsx': '<Callout title="Tokens never expire ..." />\n',
    'd.js': '// lo<hi holds so the scan never overruns mid>lo\n',
    'e.md': 'The hook <must not> be skipped\n',
    'f.md': 'This <em>never</em> expires.\n',
  });
  const r = run(fx, NOBODY);
  for (const f of ['a.html', 'b.html', 'c.jsx', 'd.js', 'e.md', 'f.md']) assert.ok(claims(r).some((c) => c.loc.startsWith(f)), f);
});

test('bare-tag follow-up: one 200 KB line of repeated "<b>x</b> " is scanned in under 2 s', () => {
  const fx = makeRepo({}, { 'big.txt': `${'<b>x</b> '.repeat(20000)}\n` });
  const t0 = Date.now();
  const r = run(fx, NOBODY);
  assert.equal(r.code, 0, r.err);
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
});
