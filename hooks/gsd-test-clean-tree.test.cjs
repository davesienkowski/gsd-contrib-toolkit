'use strict';

/**
 * node:test for hooks/gsd-test-clean-tree.cjs — the ENF-23 gsd-test clean-tree gate.
 *
 * 36-01 tracer slice: the pipe deny (GTEST-03) wired end to end — argv `nextOp` -> the shared
 * detector (hooks/lib/gsd-test-detect.cjs) -> the gate -> the emitted decision.
 *
 *   • unit rows drive `runGsdTestCleanTreeGate(stdin, deps)` with an injected `resolveTreeRoot`
 *     and a call counter, so the RES-01 short-circuit (no dispatch -> zero resolves) is asserted
 *     by COUNT, not by timing (Addendum 2);
 *   • tracer rows spawn the REAL entrypoint through proof-harness spawnHook from a temp dir that
 *     carries the gsd-core sentinel layout (scripts/issue-dedupe.cjs + gsd-core/bin/lib/), so the
 *     emitted JSON decision is what the harness would actually see. No real gsd-test, no Docker.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runGsdTestCleanTreeGate, PIPE_REASON } = require('./gsd-test-clean-tree.cjs');
const { findGsdTestDispatch } = require('./lib/gsd-test-detect.cjs');
const { spawnHook } = require('./lib/proof-harness.cjs');

const HOOK = path.join(__dirname, 'gsd-test-clean-tree.cjs');
const PIPED = 'gsd-test -base next -head origin/next | tail';
const UNPIPED = 'gsd-test -base next -head origin/next';
const FAKE_CWD = path.join(path.sep, 'fake', 'gsd-core');

function input(command) {
  return JSON.stringify({ tool_name: 'Bash', tool_input: { command } });
}

/** Injected deps + a counter on the one impure seam the tracer slice has. */
function scenario(over = {}) {
  const calls = { resolveTreeRoot: 0, dirs: [] };
  const deps = Object.assign(
    {
      cwd: FAKE_CWD,
      resolveTreeRoot: (dir) => {
        calls.resolveTreeRoot += 1;
        calls.dirs.push(dir);
        return FAKE_CWD;
      },
      overrideImpl: { checkOverride: () => ({ override: false }), writeReceipt: () => {} },
    },
    over
  );
  return { deps, calls };
}

/** A temp dir holding the gsd-core sentinel layout; removed in the caller's finally. */
function makeSentinelDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gtest-tracer-'));
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'gsd-core', 'bin', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'scripts', 'issue-dedupe.cjs'), '');
  return dir;
}

// ───────────────────────── detector (tracer form) ─────────────────────────

test('ENF-23 GTEST-03: the detector reports a piped plain dispatch as pipedOut + pipeMasked', () => {
  const d = findGsdTestDispatch(PIPED);
  assert.ok(d, 'a plain gsd-test dispatch must be detected');
  assert.strictEqual(d.kind, 'dispatch');
  assert.strictEqual(d.pipedOut, true);
  assert.strictEqual(d.pipeMasked, true);
});

test('ENF-23 GTEST-03: the detector returns null for a non-dispatch (`git status`)', () => {
  assert.strictEqual(findGsdTestDispatch('git status'), null);
});

// ───────────────────────── gate (injected deps) ─────────────────────────

test('ENF-23 GTEST-03: a piped dispatch from a gsd-core tree DENIES naming ENF-23, pipefail and a redirect', () => {
  const { deps, calls } = scenario();
  const d = runGsdTestCleanTreeGate(input(PIPED), deps);
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /ENF-23/);
  assert.match(d.permissionDecisionReason, /pipefail/);
  assert.match(d.permissionDecisionReason, /> \S+ 2>&1/, 'must name a redirect-to-file alternative');
  assert.strictEqual(calls.resolveTreeRoot, 1);
});

test('ENF-23 GTEST-03: the same dispatch UNPIPED allows (the tracer slice gates the pipe only)', () => {
  const { deps } = scenario();
  const d = runGsdTestCleanTreeGate(input(UNPIPED), deps);
  assert.strictEqual(d.permissionDecision, 'allow');
});

test('ENF-23 GTEST-03: `git status` allows with ZERO resolveTreeRoot calls (RES-01, Addendum 2)', () => {
  const { deps, calls } = scenario();
  const d = runGsdTestCleanTreeGate(input('git status'), deps);
  assert.strictEqual(d.permissionDecision, 'allow');
  assert.strictEqual(calls.resolveTreeRoot, 0, 'the detector short-circuit runs before any resolve');
});

test('ENF-23 GTEST-03: a piped dispatch whose tree is not a gsd-core checkout ALLOWS', () => {
  const { deps } = scenario({ resolveTreeRoot: () => null });
  const d = runGsdTestCleanTreeGate(input(PIPED), deps);
  assert.strictEqual(d.permissionDecision, 'allow');
});

test('ENF-23 GTEST-03: the tree is resolved from the command start dir (`cd sub && ...`)', () => {
  const { deps, calls } = scenario();
  const d = runGsdTestCleanTreeGate(input('cd sub && ' + PIPED), deps);
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.deepStrictEqual(calls.dirs, [path.resolve(FAKE_CWD, 'sub')]);
});

test('ENF-23 GTEST-03: PIPE_REASON is byte-stable (no cwd, home path or sha)', () => {
  assert.strictEqual(typeof PIPE_REASON, 'string');
  assert.match(PIPE_REASON, /ENF-23/);
  assert.ok(!PIPE_REASON.includes(process.cwd()), 'no cwd');
  assert.ok(!PIPE_REASON.includes(os.homedir()), 'no home path');
  assert.ok(!/[0-9a-f]{40}/.test(PIPE_REASON), 'no sha');
});

// ───────────────────────── tracer: the real entrypoint, spawned ─────────────────────────

test('ENF-23 GTEST-03 tracer: the spawned entrypoint DENIES a piped dispatch from a gsd-core-shaped dir', () => {
  const dir = makeSentinelDir();
  try {
    const r = spawnHook(HOOK, { stdin: input(PIPED), cwd: dir });
    assert.strictEqual(r.conclusive, true, r.reason + ' ' + r.rawStderr);
    assert.strictEqual(r.decision, 'deny', r.reason);
    const emitted = JSON.parse(r.rawStdout).hookSpecificOutput;
    assert.strictEqual(emitted.permissionDecisionReason, PIPE_REASON);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ENF-23 GTEST-03 tracer: the spawned entrypoint ALLOWS `git status` from a gsd-core-shaped dir', () => {
  const dir = makeSentinelDir();
  try {
    const r = spawnHook(HOOK, { stdin: input('git status'), cwd: dir });
    assert.strictEqual(r.conclusive, true, r.reason + ' ' + r.rawStderr);
    assert.strictEqual(r.decision, 'allow', r.reason);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
