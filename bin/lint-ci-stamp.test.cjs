'use strict';

/**
 * node:test for bin/lint-ci-stamp.cjs (ENF-05 — the lint:ci → atomic marker WRITER).
 *
 * All hermetic: every impure dep (runLintCi, readTreeSha, resolveMarkerPath, writeMarker)
 * is injected, so NO real git / npm / filesystem write runs. Proven here:
 *   - lint:ci passes (exit 0) → marker is WRITTEN for the tree SHA; runStamp returns
 *     {ok:true, markerPath, treeSha}.
 *   - lint:ci FAILS (exit 1) → writeMarker is NEVER called; runStamp returns {ok:false}
 *     surfacing the failing lint tail.
 *   - lint:ci INFRA failure (npm missing, no numeric status) → writeMarker is NEVER called;
 *     runStamp returns {ok:false} surfacing the infra error.
 *   - the path passed to writeMarker is exactly the resolveMarkerPath return.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { runStamp } = require('./lint-ci-stamp.cjs');

// A deps factory: a clean GREEN run by default; override per scenario.
function deps(over = {}) {
  const writes = [];
  const base = {
    root: '/tmp/wt',
    runLintCi: () => ({ ok: true, code: 0, tail: '' }),
    readTreeSha: () => 'abc123',
    resolveMarkerPath: (sha) => '/tmp/wt/.git/gsd-contrib/lint-ci-green/' + sha,
    writeMarker: (markerPath, treeSha) => {
      writes.push({ markerPath, treeSha });
    },
    _writes: writes,
  };
  return Object.assign(base, over);
}

test('lint:ci passes → marker written for the tree SHA; ok:true', () => {
  const d = deps();
  const result = runStamp(d);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.treeSha, 'abc123');
  assert.strictEqual(result.markerPath, '/tmp/wt/.git/gsd-contrib/lint-ci-green/abc123');
  assert.strictEqual(d._writes.length, 1);
  assert.strictEqual(d._writes[0].treeSha, 'abc123');
  assert.strictEqual(d._writes[0].markerPath, '/tmp/wt/.git/gsd-contrib/lint-ci-green/abc123');
});

test('lint:ci FAILS (exit 1) → writeMarker NEVER called; ok:false; failing tail surfaced', () => {
  const d = deps({
    runLintCi: () => ({ ok: false, code: 1, tail: 'eslint: 3 errors\n  no-unused-vars' }),
  });
  const result = runStamp(d);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(d._writes.length, 0); // NO marker on red lint
  assert.match(String(result.error || result.tail || ''), /eslint/);
});

test('lint:ci INFRA failure (no numeric status) → writeMarker NEVER called; ok:false; infra error surfaced', () => {
  const d = deps({
    runLintCi: () => {
      throw new Error('spawn npm ENOENT');
    },
  });
  const result = runStamp(d);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(d._writes.length, 0); // NO marker on infra failure
  assert.match(String(result.error || ''), /ENOENT|infra|npm/i);
});

test('the marker path passed to writeMarker is exactly resolveMarkerPath(sha)', () => {
  let resolverArg = null;
  const d = deps({
    readTreeSha: () => 'deadbeef',
    resolveMarkerPath: (sha) => {
      resolverArg = sha;
      return '/custom/path/' + sha;
    },
  });
  runStamp(d);
  assert.strictEqual(resolverArg, 'deadbeef');
  assert.strictEqual(d._writes[0].markerPath, '/custom/path/deadbeef');
});

test('runStamp is exported as a function', () => {
  assert.strictEqual(typeof runStamp, 'function');
});
