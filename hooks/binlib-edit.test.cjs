'use strict';

/**
 * node:test for hooks/binlib-edit.cjs (ENF-03 generated-file Edit/Write gate, ADR-457).
 *
 * Driven via the injectable runBinlibGate(stdinString, deps) seam: the override impl is
 * injected so the unit suite is hermetic (no filesystem / no env reads).
 *
 * Coverage (plan <behavior>):
 *   - a `**\/bin/lib/*.cjs` Edit/Write (top-level AND nested) → DENY, reason names src/*.ts + ADR-457
 *   - a `src/*.ts` source path → ALLOW (the correct file to edit)
 *   - a `bin/lib` SUBSTRING that is not a path SEGMENT (e.g. src/bin-lib-notes.md) → ALLOW
 *   - a doc/test/non-bin-lib file → ALLOW
 *   - a bin/lib path whose leaf is NOT .cjs (e.g. bin/lib/README.md) → ALLOW (segment+leaf accurate)
 *   - missing/absent file_path → fail-closed DENY (HARD-01)
 */

const test = require('node:test');
const assert = require('node:assert');

const { runBinlibGate } = require('./binlib-edit.cjs');

function input(filePath, toolName = 'Edit') {
  const tool_input = filePath === undefined ? {} : { file_path: filePath };
  return JSON.stringify({ tool_name: toolName, tool_input });
}

function deps(over = {}) {
  return Object.assign(
    {
      worktreeRoot: '/tmp/wt',
      overrideImpl: { checkOverride: () => ({ override: false }), writeReceipt: () => {} },
    },
    over
  );
}

test('top-level bin/lib/*.cjs Edit → deny, reason names src/*.ts + ADR-457', () => {
  const d = runBinlibGate(input('/home/x/gsd-core/bin/lib/decisions.cjs'), deps());
  assert.strictEqual(d.permissionDecision, 'deny');
  // ADR-457 source extension is `.ts` (a TS `src/` tree built by tsc), matching the
  // sibling freshness.cjs gate — NOT `.cts` (CONFLICT-02 / F-01).
  assert.match(d.permissionDecisionReason, /src\/\*\.ts/);
  assert.doesNotMatch(d.permissionDecisionReason, /\.cts/);
  assert.match(d.permissionDecisionReason, /457/);
});

test('nested .../packages/x/bin/lib/foo.cjs Edit → deny (glob matches any depth)', () => {
  const d = runBinlibGate(input('/repo/packages/x/bin/lib/foo.cjs'), deps());
  assert.strictEqual(d.permissionDecision, 'deny');
});

test('relative bin/lib/*.cjs path → deny (no leading slash)', () => {
  const d = runBinlibGate(input('bin/lib/state.cjs'), deps());
  assert.strictEqual(d.permissionDecision, 'deny');
});

test('Write (not just Edit) to bin/lib/*.cjs → deny', () => {
  const d = runBinlibGate(input('/g/gsd-core/bin/lib/x.cjs', 'Write'), deps());
  assert.strictEqual(d.permissionDecision, 'deny');
});

test('src/*.cts source path → allow (the correct file to edit)', () => {
  const d = runBinlibGate(input('/home/x/gsd-core/sdk/src/query/decisions.cts'), deps());
  assert.strictEqual(d.permissionDecision, 'allow');
});

test('src/bin-lib-notes.md (bin-lib substring, not a bin/lib segment pair) → allow', () => {
  const d = runBinlibGate(input('/repo/src/bin-lib-notes.md'), deps());
  assert.strictEqual(d.permissionDecision, 'allow');
});

test('a path containing "bin/lib" only as substring within one segment → allow', () => {
  const d = runBinlibGate(input('/repo/src/mybin/libfoo.cjs'), deps());
  assert.strictEqual(d.permissionDecision, 'allow');
});

test('bin/lib/README.md (segment pair but leaf is not .cjs) → allow', () => {
  const d = runBinlibGate(input('/g/gsd-core/bin/lib/README.md'), deps());
  assert.strictEqual(d.permissionDecision, 'allow');
});

test('bin/lib/sub/nested.cjs (.cjs not the direct child of lib) → allow (leaf must be a direct lib child)', () => {
  const d = runBinlibGate(input('/g/gsd-core/bin/lib/sub/nested.cjs'), deps());
  assert.strictEqual(d.permissionDecision, 'allow');
});

test('a doc file → allow', () => {
  const d = runBinlibGate(input('/repo/docs/guide.md'), deps());
  assert.strictEqual(d.permissionDecision, 'allow');
});

test('a test file → allow', () => {
  const d = runBinlibGate(input('/repo/hooks/foo.test.cjs'), deps());
  assert.strictEqual(d.permissionDecision, 'allow');
});

test('lib before bin (lib/bin/x.cjs — wrong order) → allow (segment order is bin then lib)', () => {
  const d = runBinlibGate(input('/g/gsd-core/lib/bin/x.cjs'), deps());
  assert.strictEqual(d.permissionDecision, 'allow');
});

test('missing file_path → fail-closed deny (HARD-01)', () => {
  const d = runBinlibGate(input(undefined), deps());
  assert.strictEqual(d.permissionDecision, 'deny');
});

test('non-string file_path → fail-closed deny (HARD-01)', () => {
  const stdin = JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: 123 } });
  const d = runBinlibGate(stdin, deps());
  assert.strictEqual(d.permissionDecision, 'deny');
});

test('malformed stdin JSON → fail-closed deny (HARD-01)', () => {
  const d = runBinlibGate('{not json', deps());
  assert.strictEqual(d.permissionDecision, 'deny');
});

test('fail-closed deny is override-escapable (HARD-03)', () => {
  const over = {
    overrideImpl: {
      checkOverride: () => ({ override: true, reason: 'rebuilding generated file by hand' }),
      writeReceipt: () => {},
    },
  };
  const d = runBinlibGate(input(undefined), deps(over));
  assert.strictEqual(d.permissionDecision, 'allow');
});
