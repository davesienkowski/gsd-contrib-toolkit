'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { parseCommand } = require('./argv.cjs');
const { classifyAction } = require('./classify.cjs');

const cls = (cmd) => classifyAction(parseCommand(cmd));

// ---------------------------------------------------------------------------
// Native gh routes
// ---------------------------------------------------------------------------

test('gh issue create → issue-create / native', () => {
  assert.deepStrictEqual(cls('gh issue create --title x'), {
    action: 'issue-create',
    route: 'native',
  });
});

test('gh pr create → pr-create / native', () => {
  assert.deepStrictEqual(cls('gh pr create --title x'), {
    action: 'pr-create',
    route: 'native',
  });
});

test('gh issue edit → issue-edit / native', () => {
  assert.deepStrictEqual(cls('gh issue edit 12 --body y'), {
    action: 'issue-edit',
    route: 'native',
  });
});

test('gh pr edit → pr-edit / native', () => {
  assert.deepStrictEqual(cls('gh pr edit 12 --body y'), {
    action: 'pr-edit',
    route: 'native',
  });
});

test('git commit → commit', () => {
  assert.strictEqual(cls('git commit -m x').action, 'commit');
});

test('git push → push', () => {
  assert.strictEqual(cls('git push origin main').action, 'push');
});

// ---------------------------------------------------------------------------
// gh api synonym routes (ENF-15 / EP-1)
// ---------------------------------------------------------------------------

test('gh api -X POST repos/.../issues → issue-create / gh-api', () => {
  assert.deepStrictEqual(cls('gh api -X POST repos/OWNER/REPO/issues -f title=x'), {
    action: 'issue-create',
    route: 'gh-api',
  });
});

test('gh api -X POST repos/.../pulls → pr-create / gh-api', () => {
  assert.deepStrictEqual(cls('gh api -X POST repos/o/r/pulls -f title=x'), {
    action: 'pr-create',
    route: 'gh-api',
  });
});

test('gh api --method POST long-form → issue-create / gh-api', () => {
  assert.deepStrictEqual(cls('gh api --method POST repos/o/r/issues'), {
    action: 'issue-create',
    route: 'gh-api',
  });
});

test('gh api method is case-insensitive (post)', () => {
  assert.deepStrictEqual(cls('gh api -X post repos/o/r/issues'), {
    action: 'issue-create',
    route: 'gh-api',
  });
});

test('gh api path without /repos prefix still recognized', () => {
  assert.deepStrictEqual(cls('gh api -X POST /repos/o/r/issues'), {
    action: 'issue-create',
    route: 'gh-api',
  });
});

test('gh api -X PATCH .../issues/N → issue-edit / gh-api', () => {
  assert.deepStrictEqual(cls('gh api -X PATCH repos/o/r/issues/42'), {
    action: 'issue-edit',
    route: 'gh-api',
  });
});

test('gh api -X PATCH .../pulls/N → pr-edit / gh-api', () => {
  assert.deepStrictEqual(cls('gh api -X PATCH repos/o/r/pulls/42'), {
    action: 'pr-edit',
    route: 'gh-api',
  });
});

test('gh api POST inferred from -f field without explicit method', () => {
  assert.deepStrictEqual(cls('gh api repos/o/r/issues -f title=x'), {
    action: 'issue-create',
    route: 'gh-api',
  });
});

// ---------------------------------------------------------------------------
// curl synonym routes (ENF-15 / EP-1)
// ---------------------------------------------------------------------------

test('curl POST to api.github.com issues → issue-create / curl', () => {
  assert.deepStrictEqual(
    cls('curl -X POST https://api.github.com/repos/o/r/issues -d {}'),
    { action: 'issue-create', route: 'curl' }
  );
});

test('curl POST to api.github.com pulls → pr-create / curl', () => {
  assert.deepStrictEqual(
    cls('curl -X POST https://api.github.com/repos/o/r/pulls'),
    { action: 'pr-create', route: 'curl' }
  );
});

test('curl -XPOST bundled method → issue-create / curl', () => {
  assert.deepStrictEqual(
    cls('curl -XPOST https://api.github.com/repos/o/r/issues'),
    { action: 'issue-create', route: 'curl' }
  );
});

test('curl with -d implying POST → issue-create / curl', () => {
  assert.deepStrictEqual(
    cls('curl https://api.github.com/repos/o/r/issues -d @body.json'),
    { action: 'issue-create', route: 'curl' }
  );
});

test('curl PATCH to issues/N → issue-edit / curl', () => {
  assert.deepStrictEqual(
    cls('curl -X PATCH https://api.github.com/repos/o/r/issues/7'),
    { action: 'issue-edit', route: 'curl' }
  );
});

// ---------------------------------------------------------------------------
// FAIL CLOSED on unclassifiable mutating synonym
// ---------------------------------------------------------------------------

test('gh api POST to github issues with unmappable path → failClosed', () => {
  const r = cls('gh api -X POST repos/o/r/issues/weird/path/segments');
  assert.strictEqual(r.failClosed, true);
  assert.strictEqual(r.action, 'unknown');
});

test('curl POST to api.github.com unknown endpoint shape → failClosed', () => {
  const r = cls('curl -X POST https://api.github.com/repos/o/r/something');
  assert.strictEqual(r.failClosed, true);
  assert.strictEqual(r.action, 'unknown');
});

// ---------------------------------------------------------------------------
// Read-only / unrelated → other (must ALLOW, not fail-closed)
// ---------------------------------------------------------------------------

test('gh repo view → other (not failClosed)', () => {
  const r = cls('gh repo view o/r');
  assert.strictEqual(r.action, 'other');
  assert.notStrictEqual(r.failClosed, true);
});

test('git status → other (not failClosed)', () => {
  const r = cls('git status');
  assert.strictEqual(r.action, 'other');
  assert.notStrictEqual(r.failClosed, true);
});

test('read-only gh api GET on issues → other (not failClosed)', () => {
  const r = cls('gh api repos/o/r/issues');
  assert.strictEqual(r.action, 'other');
  assert.notStrictEqual(r.failClosed, true);
});

test('gh api GET with -X GET explicit → other', () => {
  const r = cls('gh api -X GET repos/o/r/issues/3');
  assert.strictEqual(r.action, 'other');
  assert.notStrictEqual(r.failClosed, true);
});

test('curl GET (no method, no data) to api.github.com → other', () => {
  const r = cls('curl https://api.github.com/repos/o/r/issues');
  assert.strictEqual(r.action, 'other');
  assert.notStrictEqual(r.failClosed, true);
});

test('curl POST to a non-github host → other (out of scope)', () => {
  const r = cls('curl -X POST https://example.com/repos/o/r/issues');
  assert.strictEqual(r.action, 'other');
  assert.notStrictEqual(r.failClosed, true);
});

// ---------------------------------------------------------------------------
// Parser fail-closed propagation
// ---------------------------------------------------------------------------

test('unparseable command (ok:false parse) → failClosed', () => {
  const r = classifyAction(parseCommand('gh issue create --title "unterminated'));
  assert.strictEqual(r.failClosed, true);
  assert.strictEqual(r.action, 'unknown');
});

test('classifyAction tolerates a null/garbage parse → failClosed', () => {
  assert.strictEqual(classifyAction(null).failClosed, true);
  assert.strictEqual(classifyAction({}).failClosed, true);
});

// ---------------------------------------------------------------------------
// Multi-segment: any mutating segment classifies the whole command
// ---------------------------------------------------------------------------

test('chained: read-only ; gh issue create → issue-create', () => {
  const r = cls('git status ; gh issue create --title x');
  assert.strictEqual(r.action, 'issue-create');
});

test('chained synonym: echo hi && gh api -X POST repos/o/r/pulls → pr-create', () => {
  const r = cls('echo hi && gh api -X POST repos/o/r/pulls');
  assert.strictEqual(r.action, 'pr-create');
  assert.strictEqual(r.route, 'gh-api');
});
