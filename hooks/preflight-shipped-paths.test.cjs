'use strict';

/**
 * node:test for hooks/preflight-shipped-paths.cjs — the ALIGN-04 registration-surface
 * companion check (advisory, MODEL-DRIVEN — NOT a blocking PreToolUse gate).
 *
 * Driven through the injectable runPreflight(deps) seam so the suite is hermetic: the
 * diff source and the LIVE-script loader are injected, so a test NEVER runs real git or
 * spawns node. The companion REIMPLEMENTS no ship-prefix logic (HARD-02) — it uses the
 * LIVE `diff-touches-shipped-paths.cjs` exported predicates (loadShipPrefixes / isShipped /
 * isPushBlocking / isCiGating) to classify the diff and surface WHICH shipped paths it touches.
 *
 * Covered:
 *   - a diff touching a shipped path (a `files` entry) → touchesShipped:true, the path in paths[]
 *   - a diff touching package.json (always shipped) → touchesShipped:true
 *   - a diff touching tests/* (CI-gating) → touchesShipped:true (matches the LIVE classifier)
 *   - a diff touching only .github/workflows/* (push-blocking) → touchesShipped:false (LIVE rule: unpickable, not shipped)
 *   - a clean diff (docs/planning only) → touchesShipped:false, paths empty
 *   - the LIVE script missing / loader throws → result carries an explicit error (NOT a false touchesShipped:false)
 *   - an empty diff → touchesShipped:false, no error
 */

const test = require('node:test');
const assert = require('node:assert');

const { runPreflight } = require('./preflight-shipped-paths.cjs');

// The LIVE module's REAL predicate shapes (mirrored from scripts/diff-touches-shipped-paths.cjs)
// so the injected loader returns the genuine contract — the companion uses these, never a reimpl.
const liveModule = {
  loadShipPrefixes() {
    // package.json is always shipped; here `bin` + `dist` are the package's `files` whitelist.
    return ['package.json', 'bin', 'dist'];
  },
  isShipped(diffPath, shipPrefixes) {
    const p = diffPath.replace(/\\/g, '/');
    return shipPrefixes.some((s) => p === s || p.startsWith(s + '/'));
  },
  isCiGating(diffPath) {
    return diffPath.startsWith('tests/');
  },
  isPushBlocking(diffPath) {
    return diffPath.replace(/\\/g, '/').startsWith('.github/workflows/');
  },
};

function deps(over = {}) {
  return Object.assign(
    {
      gsdCoreRoot: '/tmp/wt',
      loadLiveScript: () => liveModule,
      getDiffPaths: () => [],
    },
    over
  );
}

test('a diff touching a shipped `files` path → touchesShipped:true and the path is surfaced', () => {
  const r = runPreflight(deps({ getDiffPaths: () => ['bin/lint-ci-stamp.cjs', 'docs/x.md'] }));
  assert.strictEqual(r.touchesShipped, true);
  assert.ok(r.paths.includes('bin/lint-ci-stamp.cjs'), 'shipped path surfaced');
  assert.ok(!r.error, 'no error on a normal classification');
});

test('a diff touching package.json (always shipped) → touchesShipped:true', () => {
  const r = runPreflight(deps({ getDiffPaths: () => ['package.json'] }));
  assert.strictEqual(r.touchesShipped, true);
  assert.ok(r.paths.includes('package.json'));
});

test('a diff touching tests/* (CI-gating) → touchesShipped:true (matches the LIVE classifier)', () => {
  const r = runPreflight(deps({ getDiffPaths: () => ['tests/foo.test.cjs'] }));
  assert.strictEqual(r.touchesShipped, true);
  assert.ok(r.paths.includes('tests/foo.test.cjs'));
});

test('a diff touching only .github/workflows/* (push-blocking) → touchesShipped:false (LIVE rule)', () => {
  const r = runPreflight(deps({ getDiffPaths: () => ['.github/workflows/ci.yml'] }));
  assert.strictEqual(r.touchesShipped, false);
  assert.deepStrictEqual(r.paths, []);
});

test('a clean diff (docs/planning only) → touchesShipped:false, no surfaced paths', () => {
  const r = runPreflight(deps({ getDiffPaths: () => ['docs/readme.md', '.planning/x.md'] }));
  assert.strictEqual(r.touchesShipped, false);
  assert.deepStrictEqual(r.paths, []);
  assert.ok(!r.error);
});

test('an empty diff → touchesShipped:false, no error', () => {
  const r = runPreflight(deps({ getDiffPaths: () => [] }));
  assert.strictEqual(r.touchesShipped, false);
  assert.deepStrictEqual(r.paths, []);
  assert.ok(!r.error);
});

test('a missing/throwing LIVE script loader → explicit error, NOT a false touchesShipped:false', () => {
  const r = runPreflight(
    deps({
      getDiffPaths: () => ['bin/x.cjs'],
      loadLiveScript: () => {
        throw new Error('live script not found (no vendored fallback — fail closed)');
      },
    })
  );
  assert.ok(r.error, 'an error string is surfaced');
  assert.match(r.error, /live script not found|no vendored fallback/);
  // The companion must NOT claim the diff is clean when it could not classify it.
  assert.notStrictEqual(r.touchesShipped, false);
});

test('a diff-source failure (getDiffPaths throws) → explicit error, not a silent clean', () => {
  const r = runPreflight(
    deps({
      getDiffPaths: () => {
        throw new Error('git diff failed');
      },
    })
  );
  assert.ok(r.error, 'an error string is surfaced');
  assert.match(r.error, /git diff failed/);
  assert.notStrictEqual(r.touchesShipped, false);
});
