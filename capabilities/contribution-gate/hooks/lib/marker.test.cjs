'use strict';

/**
 * node:test for hooks/lib/marker.cjs (ENF-05 — the shared tree-SHA marker contract).
 *
 * Proven here, all hermetic (injected git runner / injected fs — NEVER real git):
 *   - MARKER_SUBDIR is the frozen constant 'gsd-contrib/lint-ci-green'
 *   - readTreeShaLive runs `git write-tree` and returns the trimmed SHA on exit 0
 *   - readTreeShaLive THROWS (fail-closed) when the runner errors / non-zero
 *   - readWorkingTreeStatusLive runs `git status --porcelain`, returns the raw string ('' = clean)
 *   - resolveMarkerPathLive runs `git rev-parse --git-path …` and resolves to an ABSOLUTE path
 *   - resolveMarkerPathLive THROWS (fail-closed) when the runner errors
 *   - markerExistsLive returns true iff the injected fs reports the file exists
 */

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const marker = require('./marker.cjs');

// A fake runner factory: records the (file, args) it was called with, returns `out`.
function fakeRunner(out, calls) {
  return (file, args) => {
    if (calls) calls.push({ file, args });
    return out;
  };
}
function throwingRunner() {
  return () => {
    throw new Error('git unavailable');
  };
}

test('MARKER_SUBDIR is the frozen shared constant', () => {
  assert.strictEqual(marker.MARKER_SUBDIR, 'gsd-contrib/lint-ci-green');
});

test('all four live readers are exported as functions', () => {
  assert.strictEqual(typeof marker.readTreeShaLive, 'function');
  assert.strictEqual(typeof marker.readWorkingTreeStatusLive, 'function');
  assert.strictEqual(typeof marker.resolveMarkerPathLive, 'function');
  assert.strictEqual(typeof marker.markerExistsLive, 'function');
});

test('readTreeShaLive runs `git write-tree` and returns the trimmed SHA', () => {
  const calls = [];
  const sha = marker.readTreeShaLive('/tmp/wt', fakeRunner('deadbeef\n', calls));
  assert.strictEqual(sha, 'deadbeef');
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].file, 'git');
  assert.deepStrictEqual(calls[0].args, ['write-tree']);
});

test('readTreeShaLive THROWS when the runner errors (fail closed)', () => {
  assert.throws(() => marker.readTreeShaLive('/tmp/wt', throwingRunner()));
});

test('readWorkingTreeStatusLive runs `git status --porcelain` and returns the raw string', () => {
  const calls = [];
  const status = marker.readWorkingTreeStatusLive('/tmp/wt', fakeRunner(' M file.js\n', calls));
  assert.strictEqual(status, ' M file.js\n');
  assert.strictEqual(calls[0].file, 'git');
  assert.deepStrictEqual(calls[0].args, ['status', '--porcelain']);
});

test('readWorkingTreeStatusLive returns empty string for a clean tree', () => {
  const status = marker.readWorkingTreeStatusLive('/tmp/wt', fakeRunner('', null));
  assert.strictEqual(status, '');
});

test('readWorkingTreeStatusLive THROWS when the runner errors (fail closed)', () => {
  assert.throws(() => marker.readWorkingTreeStatusLive('/tmp/wt', throwingRunner()));
});

test('resolveMarkerPathLive runs `git rev-parse --git-path` for the tree SHA', () => {
  const calls = [];
  marker.resolveMarkerPathLive('/tmp/wt', 'abc123', fakeRunner('.git/gsd-contrib/lint-ci-green/abc123\n', calls));
  assert.strictEqual(calls[0].file, 'git');
  assert.deepStrictEqual(calls[0].args, [
    'rev-parse',
    '--git-path',
    'gsd-contrib/lint-ci-green/abc123',
  ]);
});

test('resolveMarkerPathLive resolves a relative --git-path result to an ABSOLUTE path under root', () => {
  const result = marker.resolveMarkerPathLive(
    '/tmp/wt',
    'abc123',
    fakeRunner('.git/gsd-contrib/lint-ci-green/abc123\n', null)
  );
  assert.strictEqual(path.isAbsolute(result), true);
  assert.strictEqual(result, path.resolve('/tmp/wt', '.git/gsd-contrib/lint-ci-green/abc123'));
});

test('resolveMarkerPathLive THROWS when the runner errors (fail closed)', () => {
  assert.throws(() => marker.resolveMarkerPathLive('/tmp/wt', 'abc123', throwingRunner()));
});

test('markerExistsLive returns true iff the injected fs reports the file exists', () => {
  const present = marker.markerExistsLive('/tmp/wt/.git/m', { existsSync: () => true });
  const absent = marker.markerExistsLive('/tmp/wt/.git/m', { existsSync: () => false });
  assert.strictEqual(present, true);
  assert.strictEqual(absent, false);
});

test('markerExistsLive passes the marker path through to fs.existsSync', () => {
  let seen = null;
  marker.markerExistsLive('/tmp/wt/.git/marker', { existsSync: (p) => { seen = p; return true; } });
  assert.strictEqual(seen, '/tmp/wt/.git/marker');
});
