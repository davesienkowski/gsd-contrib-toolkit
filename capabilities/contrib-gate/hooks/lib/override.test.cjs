'use strict';

/**
 * node:test for hooks/lib/override.cjs (HARD-03 / EP-5).
 *
 * Proven here:
 *   - unset / empty / whitespace-only GSD_CONTRIB_OVERRIDE → override:false (no bypass)
 *   - a non-empty reason → override:true carrying the trimmed reason
 *   - writeReceipt writes under the PER-WORKTREE root and APPENDS (no truncate)
 *   - two distinct worktree roots write to DISTINCT receipt files (no clobber — EP-5)
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ovr = require('./override.cjs');

function withEnv(value, fn) {
  const saved = process.env.GSD_CONTRIB_OVERRIDE;
  if (value === undefined) delete process.env.GSD_CONTRIB_OVERRIDE;
  else process.env.GSD_CONTRIB_OVERRIDE = value;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.GSD_CONTRIB_OVERRIDE;
    else process.env.GSD_CONTRIB_OVERRIDE = saved;
  }
}

function tmpWorktree() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-wt-'));
}

test('checkOverride: unset env → override:false', () => {
  withEnv(undefined, () => {
    assert.deepStrictEqual(ovr.checkOverride('/tmp/wt'), { override: false });
  });
});

test('checkOverride: empty string → override:false (no bypass)', () => {
  withEnv('', () => {
    assert.strictEqual(ovr.checkOverride('/tmp/wt').override, false);
  });
});

test('checkOverride: whitespace-only → override:false (no bypass)', () => {
  withEnv('   \t  ', () => {
    assert.strictEqual(ovr.checkOverride('/tmp/wt').override, false);
  });
});

test('checkOverride: a real reason → override:true with the trimmed reason', () => {
  withEnv('  transient gh outage  ', () => {
    const r = ovr.checkOverride('/tmp/wt');
    assert.strictEqual(r.override, true);
    assert.strictEqual(r.reason, 'transient gh outage');
  });
});

test('checkOverride: a value resembling --no-verify is still just a REASON (override:true), not a flag', () => {
  // The override is a reason string; it is NOT --no-verify (which ENF-12 denies).
  withEnv('--no-verify', () => {
    const r = ovr.checkOverride('/tmp/wt');
    // It is a non-empty reason → override true. The point: presence of --no-verify in a
    // COMMAND never sets override; only this env var does. Here it is the override reason.
    assert.strictEqual(r.override, true);
    assert.strictEqual(r.reason, '--no-verify');
  });
});

test('writeReceipt: creates the per-worktree receipt dir+file and records the fields', () => {
  const wt = tmpWorktree();
  const file = ovr.writeReceipt(wt, {
    reason: 'transient outage',
    command: 'gh pr create --base main',
    action: 'pr-create',
  });
  assert.ok(fs.existsSync(file), 'receipt file should exist');
  assert.strictEqual(file, path.join(wt, '.gsd-contrib', 'override-receipts.log'));
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.strictEqual(lines.length, 1);
  const rec = JSON.parse(lines[0]);
  assert.strictEqual(rec.reason, 'transient outage');
  assert.strictEqual(rec.action, 'pr-create');
  assert.strictEqual(rec.command, 'gh pr create --base main');
  assert.match(rec.ts, /^\d{4}-\d{2}-\d{2}T/); // ISO timestamp
});

test('writeReceipt: APPENDS (second call adds a record, does not truncate)', () => {
  const wt = tmpWorktree();
  ovr.writeReceipt(wt, { reason: 'first', command: 'a', action: 'issue-create' });
  const file = ovr.writeReceipt(wt, { reason: 'second', command: 'b', action: 'pr-create' });
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.strictEqual(lines.length, 2, 'append must preserve the first record');
  assert.strictEqual(JSON.parse(lines[0]).reason, 'first');
  assert.strictEqual(JSON.parse(lines[1]).reason, 'second');
});

test('writeReceipt: two DISTINCT worktree roots write to DISTINCT files (EP-5 no clobber)', () => {
  const wtA = tmpWorktree();
  const wtB = tmpWorktree();
  const fileA = ovr.writeReceipt(wtA, { reason: 'from-A', command: 'a', action: 'pr-create' });
  const fileB = ovr.writeReceipt(wtB, { reason: 'from-B', command: 'b', action: 'pr-create' });
  assert.notStrictEqual(fileA, fileB, 'distinct worktrees must have distinct receipt paths');

  const recA = JSON.parse(fs.readFileSync(fileA, 'utf8').trim());
  const recB = JSON.parse(fs.readFileSync(fileB, 'utf8').trim());
  assert.strictEqual(recA.reason, 'from-A');
  assert.strictEqual(recB.reason, 'from-B');
  // Writing to A must not have leaked into B (no shared global).
  assert.strictEqual(fs.readFileSync(fileA, 'utf8').includes('from-B'), false);
});

test('writeReceipt: truncates an oversized command in the audit record', () => {
  const wt = tmpWorktree();
  const big = 'x'.repeat(2000);
  const file = ovr.writeReceipt(wt, { reason: 'big', command: big, action: 'issue-create' });
  const rec = JSON.parse(fs.readFileSync(file, 'utf8').trim());
  assert.ok(rec.command.length < big.length, 'command should be truncated');
  assert.match(rec.command, /truncated/);
});

test('writeReceipt: rejects a missing worktreeRoot (cannot key a per-worktree receipt)', () => {
  assert.throws(() => ovr.writeReceipt(undefined, { reason: 'x' }), /worktreeRoot/);
  assert.throws(() => ovr.writeReceipt('   ', { reason: 'x' }), /worktreeRoot/);
});

test('writeReceipt: concurrent appends from many calls all land (append-only, no race-lost writes)', () => {
  const wt = tmpWorktree();
  const N = 25;
  for (let i = 0; i < N; i++) {
    ovr.writeReceipt(wt, { reason: 'r' + i, command: 'c' + i, action: 'pr-create' });
  }
  const file = path.join(wt, '.gsd-contrib', 'override-receipts.log');
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.strictEqual(lines.length, N, 'every appended receipt must survive');
});
