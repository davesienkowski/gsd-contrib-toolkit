'use strict';

/**
 * node:test for hooks/freshness.cjs (ENF-14 / HARD-01 / HARD-04).
 *
 * Drives the gate through the injectable runFreshnessGate(input, deps) seam: the staged
 * file list and the per-check runner are injected so the unit suite needs no real gsd-core
 * worktree, no git index, and no npm. The src→generated→check mapping under test mirrors
 * gsd-core's .githooks/pre-commit (the source of truth).
 */

const test = require('node:test');
const assert = require('node:assert');

const { runFreshnessGate, FRESHNESS_CHECKS, matchedChecks } = require('./freshness.cjs');

function input(command) {
  return JSON.stringify({ tool_name: 'Bash', tool_input: { command } });
}

function deps(over = {}) {
  return Object.assign(
    {
      gsdCoreRoot: '/tmp/gsd-core',
      stagedFiles: () => [],
      // runCheck(root, name) -> {name, ok, code, tail}; default: all pass.
      runCheck: (root, name) => ({ name, ok: true, code: 0, tail: '' }),
      worktreeRoot: '/tmp/gsd-core',
      overrideImpl: { checkOverride: () => ({ override: false }), writeReceipt: () => {} },
    },
    over
  );
}

// A staged pair governed by check:decisions-fresh (per the pre-commit globs).
const DECISIONS_SRC = 'sdk/src/query/decisions.ts';
const DECISIONS_GEN = 'gsd-core/bin/lib/decisions.generated.cjs';

test('non-commit command (git status) → allow (no-op)', () => {
  const d = runFreshnessGate(input('git status'), deps({ stagedFiles: () => [DECISIONS_SRC] }));
  assert.strictEqual(d.permissionDecision, 'allow');
});

test('commit with NO governed pair staged → allow (no checks run)', () => {
  const d = runFreshnessGate(
    input('git commit -m x'),
    deps({ stagedFiles: () => ['README.md', 'docs/whatever.md'] })
  );
  assert.strictEqual(d.permissionDecision, 'allow');
});

test('commit with a governed src staged + STALE generated (check nonzero) → DENY (ENF-14)', () => {
  const d = runFreshnessGate(
    input('git commit -m x'),
    deps({
      stagedFiles: () => [DECISIONS_SRC, DECISIONS_GEN],
      runCheck: (root, name) => ({ name, ok: false, code: 1, tail: 'decisions.generated.cjs is stale' }),
    })
  );
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
  assert.match(d.permissionDecisionReason, /build:lib/);
  assert.match(d.permissionDecisionReason, /check:decisions-fresh/);
});

test('commit with a governed pair staged + FRESH (check zero) → allow', () => {
  const d = runFreshnessGate(
    input('git commit -m x'),
    deps({
      stagedFiles: () => [DECISIONS_SRC, DECISIONS_GEN],
      runCheck: (root, name) => ({ name, ok: true, code: 0, tail: '' }),
    })
  );
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

test('only the MATCHED check runs (not all checks unconditionally)', () => {
  const ran = [];
  runFreshnessGate(
    input('git commit -m x'),
    deps({
      stagedFiles: () => [DECISIONS_SRC],
      runCheck: (root, name) => {
        ran.push(name);
        return { name, ok: true, code: 0, tail: '' };
      },
    })
  );
  assert.deepStrictEqual(ran, ['check:decisions-fresh']);
});

test('a check throwing for an infra reason → FAIL CLOSED deny (HARD-01)', () => {
  const d = runFreshnessGate(
    input('git commit -m x'),
    deps({
      stagedFiles: () => [DECISIONS_SRC],
      runCheck: () => {
        throw new Error('npm not found');
      },
    })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
});

test('infra failure WITH a logged override → allow (HARD-03)', () => {
  const d = runFreshnessGate(
    input('git commit -m x'),
    deps({
      stagedFiles: () => [DECISIONS_SRC],
      runCheck: () => {
        throw new Error('npm not found');
      },
      overrideImpl: {
        checkOverride: () => ({ override: true, reason: 'npm unavailable in CI shell' }),
        writeReceipt: () => '/tmp/gsd-core/.gsd-contrib/override-receipts.log',
      },
    })
  );
  assert.strictEqual(d.permissionDecision, 'allow');
});

test('staged-file read failing → FAIL CLOSED deny (HARD-01)', () => {
  const d = runFreshnessGate(
    input('git commit -m x'),
    deps({
      stagedFiles: () => {
        throw new Error('git index unreadable');
      },
    })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
});

test('malformed stdin JSON → FAIL CLOSED deny (HARD-01)', () => {
  const d = runFreshnessGate('{not json', deps());
  assert.strictEqual(d.permissionDecision, 'deny');
});

test('unparseable command (unbalanced quote) → FAIL CLOSED deny (HARD-04)', () => {
  const d = runFreshnessGate(input('git commit -m "unterminated'), deps());
  assert.strictEqual(d.permissionDecision, 'deny');
});

test('matchedChecks maps a staged src to its check (mirrors the pre-commit globs)', () => {
  const checks = matchedChecks([DECISIONS_SRC, 'README.md']);
  assert.ok(checks.includes('check:decisions-fresh'));
  // a generated artifact also matches its check
  const checks2 = matchedChecks([DECISIONS_GEN]);
  assert.ok(checks2.includes('check:decisions-fresh'));
});

test('FRESHNESS_CHECKS covers the full pre-commit check:*-fresh family', () => {
  const names = FRESHNESS_CHECKS.map((c) => c.name);
  for (const expected of [
    'check:alias-drift',
    'check:state-document-fresh',
    'check:configuration-fresh',
    'check:workstream-inventory-builder-fresh',
    'check:project-root-fresh',
    'check:plan-scan-fresh',
    'check:secrets-fresh',
    'check:schema-detect-fresh',
    'check:decisions-fresh',
    'check:workstream-name-policy-fresh',
  ]) {
    assert.ok(names.includes(expected), 'missing ' + expected);
  }
});
