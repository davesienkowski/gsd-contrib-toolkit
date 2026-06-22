'use strict';

/**
 * bin/verify-hooks.test.cjs — HERMETIC test of the verify-hooks runner's verdict/exit logic.
 *
 * The runner (`bin/verify-hooks.cjs`) drives the 05-01 proof-harness over every wired hook and
 * captures the emitted decision as a committed proofs/<hook>-<case>.json artifact. THIS test does
 * NOT spawn real hooks — it injects a STUB spawnHook via opts so the verdict math (deny-on-bad,
 * allow-on-clean, crash-is-not-allow, advisory-no-decision) is proven in isolation, byte-stable
 * and offline.
 *
 * It proves:
 *   (a) all cases conclusive+matching => ok:true (CLI exit-intent 0)
 *   (b) a deny-gate that emits ALLOW on its BAD fixture => ok:false (a gate that doesn't deny is a fail)
 *   (c) an INCONCLUSIVE case (crash/empty) => ok:false (crash is NOT a pass — 05-01 invariant)
 *   (d) write:false produces NO files (hermetic by default)
 *   (e) a LIVE case with no reachable checkout => verdict:'skipped' and does NOT flip ok
 *   (f) write:true emits per-case artifacts carrying the ACTUAL emitted JSON + exitCode + verdict
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runVerify } = require('./verify-hooks.cjs');

// ── Stub builders: a fake spawnHook returns the captured shape proof-harness emits. ──

// A conclusive deny capture.
const denyCap = () => ({
  decision: 'deny',
  conclusive: true,
  reason: 'parsed permissionDecision:deny',
  rawStdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'blocked' } }),
  rawStderr: '',
  status: 0,
  spawnError: null,
});
// A conclusive allow capture.
const allowCap = () => ({
  decision: 'allow',
  conclusive: true,
  reason: 'parsed permissionDecision:allow',
  rawStdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } }),
  rawStderr: '',
  status: 0,
  spawnError: null,
});
// An inconclusive (crash) capture.
const crashCap = () => ({
  decision: null,
  conclusive: false,
  reason: 'non-zero exit (2) — inconclusive (crash is NOT an allow)',
  rawStdout: '',
  rawStderr: 'boom',
  status: 2,
  spawnError: null,
});

// A tiny deny-gate-only proof table so each test controls exactly the captures it asserts on.
// `kind:'deny'` entries: BAD must deny, CLEAN must allow. We inject the table via opts.table.
const oneDenyGate = [{ name: 'fakegate', kind: 'deny', bad: 'BAD', clean: 'CLEAN', needsLive: false }];

function tmpProofsDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-verify-proofs-'));
}

// ── (a) all-pass => ok:true ──────────────────────────────────────────────────
test('verdict: deny-on-bad + allow-on-clean (both conclusive) => ok:true', () => {
  const spawn = (absPath, opts) => (opts.stdin === 'BAD' ? denyCap() : allowCap());
  const r = runVerify({ write: false, spawnHook: spawn, table: oneDenyGate });
  assert.equal(r.ok, true, JSON.stringify(r.results));
  assert.equal(r.results.every((x) => x.verdict === 'pass'), true);
});

// ── (b) a deny-gate emitting ALLOW on its BAD fixture => ok:false ─────────────
test('SECURITY: a deny-gate that ALLOWS its bad fixture => verdict fail, ok:false', () => {
  const spawn = () => allowCap(); // allow for BOTH cases — the BAD case should now FAIL
  const r = runVerify({ write: false, spawnHook: spawn, table: oneDenyGate });
  assert.equal(r.ok, false);
  const bad = r.results.find((x) => x.case === 'deny');
  assert.equal(bad.verdict, 'fail');
});

// ── (c) an inconclusive case => ok:false (crash != pass) ─────────────────────
test('SECURITY: an INCONCLUSIVE (crash) case => verdict fail/inconclusive, ok:false', () => {
  const spawn = (absPath, opts) => (opts.stdin === 'BAD' ? crashCap() : allowCap());
  const r = runVerify({ write: false, spawnHook: spawn, table: oneDenyGate });
  assert.equal(r.ok, false);
  const bad = r.results.find((x) => x.case === 'deny');
  assert.notEqual(bad.verdict, 'pass', 'a crash is NEVER a pass');
});

// ── (d) write:false produces NO files ────────────────────────────────────────
test('write:false writes no artifacts', () => {
  const dir = tmpProofsDir();
  try {
    const spawn = (absPath, opts) => (opts.stdin === 'BAD' ? denyCap() : allowCap());
    runVerify({ write: false, spawnHook: spawn, table: oneDenyGate, proofsDir: dir });
    assert.equal(fs.readdirSync(dir).length, 0, 'no files written when write:false');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── (e) a LIVE case with no reachable checkout => skipped, does NOT flip ok ───
test('a needsLive case with no checkout => verdict:skipped and does NOT fail ok', () => {
  const liveGate = [{ name: 'livegate', kind: 'deny', bad: 'BAD', clean: 'CLEAN', needsLive: true }];
  const spawn = () => { throw new Error('spawn must NOT be called for a skipped live case'); };
  const r = runVerify({ write: false, spawnHook: spawn, table: liveGate, liveCwd: null });
  assert.equal(r.ok, true, 'a skipped live case does not flip ok to false');
  assert.equal(r.results.every((x) => x.verdict === 'skipped'), true);
});

// ── (f) write:true emits artifacts carrying the actual emitted JSON + exitCode + verdict ──
test('write:true emits proofs/<hook>-<case>.json with the actual emitted JSON + exitCode + verdict', () => {
  const dir = tmpProofsDir();
  try {
    const spawn = (absPath, opts) => (opts.stdin === 'BAD' ? denyCap() : allowCap());
    const r = runVerify({ write: true, spawnHook: spawn, table: oneDenyGate, proofsDir: dir });
    assert.equal(r.ok, true);

    const denyPath = path.join(dir, 'fakegate-deny.json');
    const allowPath = path.join(dir, 'fakegate-allow.json');
    assert.ok(fs.existsSync(denyPath), 'deny artifact written');
    assert.ok(fs.existsSync(allowPath), 'allow artifact written');

    const denyArt = JSON.parse(fs.readFileSync(denyPath, 'utf8'));
    assert.equal(denyArt.hook, 'fakegate');
    assert.equal(denyArt.case, 'deny');
    assert.equal(denyArt.expected, 'deny');
    assert.equal(denyArt.verdict, 'pass');
    assert.equal(denyArt.exitCode, 0);
    // The ACTUAL emitted hookSpecificOutput JSON is captured, not a green/red boolean.
    assert.equal(denyArt.emitted.hookSpecificOutput.permissionDecision, 'deny');

    // 2-space JSON, trailing newline (human-diffable, stable).
    const raw = fs.readFileSync(denyPath, 'utf8');
    assert.ok(raw.endsWith('\n'), 'trailing newline');
    assert.ok(raw.includes('\n  "hook"'), '2-space indented');
    // No volatile fields (timestamp/pid) that would break byte-stability.
    assert.doesNotMatch(raw, /timestamp|"pid"/i, 'no volatile fields embedded');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── (g) WR-02: an advisory entry with NO inject fixture cannot report a sole `pass` ──
// An advisory hook proves itself by SURFACING context on its inject case. An entry that
// defines `none` but omits `inject` (entry.inject === undefined) has zero positive
// assertions — it must NOT yield a trivially-green `none` pass that makes ok:true.
test('WR-02: advisory entry missing its inject fixture records skipped (never a sole pass)', () => {
  // A quiet-clean-exit capture (no permissionDecision, no surfaced output).
  const quietCap = () => ({
    decision: null,
    conclusive: true,
    reason: 'clean exit, no decision',
    rawStdout: '',
    rawStderr: '',
    status: 0,
    spawnError: null,
  });
  const advisoryNoInject = [{ name: 'advnoinj', kind: 'advisory', none: '', needsLive: false }];
  const spawn = () => quietCap();
  const r = runVerify({ write: false, spawnHook: spawn, table: advisoryNoInject });
  const advCases = r.results.filter((a) => a.case === 'inject' || a.case === 'none');
  assert.ok(advCases.length > 0, 'the advisory entry produced at least one case result');
  assert.equal(
    advCases.some((a) => a.verdict === 'pass'),
    false,
    'no advisory case for an un-asserted entry may be a pass'
  );
  // ok must not be flipped false purely by this entry (skipped does not flip ok), but
  // critically it cannot be GREEN on a positive pass either — there are no passes here.
});

// ── (h) WR-02 no-regression: a fully-paired advisory entry still passes both cases ──
test('WR-02: a paired advisory entry (inject surfaces, none quiet) still passes both cases', () => {
  const surfaceCap = () => ({
    decision: null,
    conclusive: true,
    reason: 'clean exit, surfaced context, no decision',
    rawStdout: 'advisory: heads up about shipped paths',
    rawStderr: '',
    status: 0,
    spawnError: null,
  });
  const quietCap = () => ({
    decision: null,
    conclusive: true,
    reason: 'clean exit, no decision',
    rawStdout: '',
    rawStderr: '',
    status: 0,
    spawnError: null,
  });
  const pairedAdvisory = [
    { name: 'advpaired', kind: 'advisory', inject: 'INJECT', none: '', needsLive: false },
  ];
  const spawn = (absPath, opts) => (opts.stdin === 'INJECT' ? surfaceCap() : quietCap());
  const r = runVerify({ write: false, spawnHook: spawn, table: pairedAdvisory });
  const inj = r.results.find((a) => a.case === 'inject');
  const none = r.results.find((a) => a.case === 'none');
  assert.equal(inj.verdict, 'pass', 'inject surfaces => pass');
  assert.equal(none.verdict, 'pass', 'none stays quiet => pass');
  assert.equal(r.ok, true);
});
