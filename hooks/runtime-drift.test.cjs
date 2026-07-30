'use strict';

/**
 * node:test for hooks/runtime-drift.cjs — the ENF-21 runtime-drift gate.
 *
 * Every case drives the injectable `runRuntimeDriftGate(stdin, deps)` seam with the ORACLE
 * fully stubbed: no real filesystem, no real `git`, no network. The oracle's own behaviour is
 * proven separately in hooks/lib/runtime-stamp.test.cjs; what is proven HERE is the gate's
 * ORDERING and its verdict→decision mapping, both of which are load-bearing:
 *
 *   • the RES-01 action-first short-circuit runs BEFORE any digest / stamp read / resolve /
 *     network call — asserted by CALL COUNT, not by timing (D-06);
 *   • an unparseable command fails closed WITHOUT consulting the oracle (HARD-04);
 *   • ROB-01 arming lets an out-of-tree non-gsd-core push through, but a null-root command that
 *     explicitly targets open-gsd/gsd-core still ENGAGES (D-07's deliberate difference from the
 *     other gh gates: ENF-21 needs no LIVE script, so HARD-02 does not bind here);
 *   • only `UpstreamUnavailable` becomes `ask`; every other throw still DENIES (HARD-01 floor);
 *   • the gate triggers on hasGovernedSegment, never on the chain aggregate (CTK-ADR-0006 §D.8).
 */

const test = require('node:test');
const assert = require('node:assert');

const { runRuntimeDriftGate, gate, GOVERNED_ACTIONS } = require('./runtime-drift.cjs');
const { UpstreamUnavailable, REMEDIATION_COMMAND, STAMP_SCHEMA } = require('./lib/runtime-stamp.cjs');
const { FailClosed } = require('./lib/failclosed.cjs');

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const DIGEST = 'sha256:' + 'f'.repeat(64);

function input(command) {
  return JSON.stringify({ tool_name: 'Bash', tool_input: { command } });
}

function stampAt(sha, digest) {
  return {
    schema: STAMP_SCHEMA,
    sha,
    runtime_digest: digest,
    mode: 'payload-verified',
    engine_verified: false,
    installed_at: '2026-07-30T00:00:00.000Z',
    source: 'https://github.com/open-gsd/gsd-core.git#next',
  };
}

/**
 * Build injectable deps plus a `calls` counter for every impure seam. The DEFAULT world is a
 * FRESH runtime inside a real gsd-core checkout, so each test overrides only what it is about.
 */
function scenario(over = {}) {
  const calls = { resolveRoot: 0, runtimeDigest: 0, readStamp: 0, upstreamTip: 0 };
  const deps = Object.assign(
    {
      resolveRoot: () => { calls.resolveRoot += 1; return '/tmp/gsd-core'; },
      runtimeDigest: () => { calls.runtimeDigest += 1; return DIGEST; },
      readStamp: () => { calls.readStamp += 1; return stampAt(SHA_A, DIGEST); },
      upstreamTip: () => { calls.upstreamTip += 1; return { sha: SHA_A, source: 'live', ageMs: 0 }; },
      overrideImpl: { checkOverride: () => ({ override: false }), writeReceipt: () => {} },
    },
    over
  );
  return { deps, calls };
}

/** Total impure-seam invocations — the "did the oracle run at all?" number. */
function oracleCalls(calls) {
  return calls.runtimeDigest + calls.readStamp + calls.upstreamTip;
}

// ───────────────────────── governed surface ─────────────────────────

test('GOVERNED_ACTIONS is exactly the three filing/pushing actions (D-06)', () => {
  assert.deepStrictEqual([...GOVERNED_ACTIONS].sort(), ['issue-create', 'pr-create', 'push']);
});

test('the review-side verbs are DELIBERATELY not in the governed set (recorded gap D-06)', () => {
  for (const a of ['pr-review', 'pr-merge', 'issue-close', 'issue-comment', 'pr-comment', 'pr-edit', 'issue-edit', 'commit']) {
    assert.ok(!GOVERNED_ACTIONS.includes(a), a + ' must NOT be gated by ENF-21');
  }
});

// ───────────────────── RES-01 action-first short-circuit (D-06) ─────────────────────

for (const cmd of ['git status', 'npm test', 'gh pr review 9 --approve', 'ls -la', 'gh repo view o/r', 'git commit -m x']) {
  test(`non-governed \`${cmd}\` ALLOWS and costs ZERO digests, ZERO stamp reads, ZERO network calls`, () => {
    const { deps, calls } = scenario();
    const d = runRuntimeDriftGate(input(cmd), deps);
    assert.strictEqual(d.permissionDecision, 'allow');
    assert.strictEqual(oracleCalls(calls), 0, 'the oracle must not be consulted at all');
    assert.strictEqual(calls.resolveRoot, 0, 'the short-circuit runs BEFORE any filesystem resolve');
  });
}

// ───────────────────── HARD-04 fail-closed on an unparseable command ─────────────────────

test('an unparseable command DENIES (HARD-04) and never consults the oracle', () => {
  const { deps, calls } = scenario();
  const d = runRuntimeDriftGate(input('gh pr create --title "x'), deps);
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.strictEqual(oracleCalls(calls), 0);
  assert.strictEqual(calls.resolveRoot, 0);
});

// ───────────────────── ROB-01 arming (D-07) ─────────────────────

test('governed + out-of-tree + NOT targeting gsd-core → allow (ROB-01 passthrough)', () => {
  const { deps, calls } = scenario({ resolveRoot: () => null });
  const d = runRuntimeDriftGate(input('git push origin HEAD'), deps);
  assert.strictEqual(d.permissionDecision, 'allow');
  assert.strictEqual(oracleCalls(calls), 0, 'an unrelated repo push never measures the runtime');
});

test('governed + NULL root + --repo open-gsd/gsd-core → the gate ENGAGES (D-07, not fail-closed)', () => {
  const { deps, calls } = scenario({
    resolveRoot: () => null,
    readStamp: () => null, // unstamped → a real, reachable deny
  });
  const d = runRuntimeDriftGate(
    input('gh pr create --repo open-gsd/gsd-core --title x --body y'),
    deps
  );
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.ok(calls.runtimeDigest > 0, 'the gate must REACH the oracle, not fail closed on a null root');
  assert.match(d.permissionDecisionReason, /ENF-21/);
});

test('governed + null root + a gh-api path targeting open-gsd/gsd-core → ENGAGES', () => {
  const { deps, calls } = scenario({ resolveRoot: () => null, readStamp: () => null });
  const d = runRuntimeDriftGate(
    input('gh api -X POST repos/open-gsd/gsd-core/issues -f title=x'),
    deps
  );
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.ok(calls.runtimeDigest > 0);
});

test('governed + null root + a FORK repo spec → allow (no false deny on a fork)', () => {
  const { deps, calls } = scenario({ resolveRoot: () => null, readStamp: () => null });
  const d = runRuntimeDriftGate(
    input('gh pr create --repo dave/gsd-core-fork --title x --body y'),
    deps
  );
  assert.strictEqual(d.permissionDecision, 'allow');
  assert.strictEqual(oracleCalls(calls), 0);
});

// ───────────────────── verdict → decision mapping ─────────────────────

test('verdict `fresh` → allow', () => {
  const { deps } = scenario();
  const d = runRuntimeDriftGate(input('git push origin HEAD'), deps);
  assert.strictEqual(d.permissionDecision, 'allow');
});

test('verdict `drifted` → deny, quoting REMEDIATION_COMMAND verbatim and naming ENF-21', () => {
  const { deps } = scenario({ upstreamTip: () => ({ sha: SHA_B, source: 'live', ageMs: 0 }) });
  const d = runRuntimeDriftGate(input('git push origin HEAD'), deps);
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.ok(d.permissionDecisionReason.includes(REMEDIATION_COMMAND));
  assert.match(d.permissionDecisionReason, /ENF-21/);
  assert.match(d.permissionDecisionReason, /drifted/);
});

test('verdict `unstamped` → deny, quoting REMEDIATION_COMMAND verbatim and naming ENF-21', () => {
  const { deps } = scenario({ readStamp: () => null });
  const d = runRuntimeDriftGate(input('gh issue create --title x --body y'), deps);
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.ok(d.permissionDecisionReason.includes(REMEDIATION_COMMAND));
  assert.match(d.permissionDecisionReason, /ENF-21/);
  assert.match(d.permissionDecisionReason, /unstamped/);
});

test('verdict `unverified` → deny, quoting REMEDIATION_COMMAND verbatim and naming ENF-21', () => {
  const { deps } = scenario({ runtimeDigest: () => 'sha256:' + '0'.repeat(64) });
  const d = runRuntimeDriftGate(input('gh pr create --title x --body y'), deps);
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.ok(d.permissionDecisionReason.includes(REMEDIATION_COMMAND));
  assert.match(d.permissionDecisionReason, /ENF-21/);
  assert.match(d.permissionDecisionReason, /unverified/);
});

// ───────────────────── the ONE deviation: ask on an unobtainable tip (D-05) ─────────────────────

test('UpstreamUnavailable → ask (NOT deny, NOT allow), naming the unreachable network', () => {
  const { deps } = scenario({
    upstreamTip: () => { throw new UpstreamUnavailable('the upstream `next` tip is unobtainable (ETIMEDOUT)'); },
  });
  const d = runRuntimeDriftGate(input('git push origin HEAD'), deps);
  assert.strictEqual(d.permissionDecision, 'ask');
  assert.match(d.permissionDecisionReason, /ENF-21/);
  assert.match(d.permissionDecisionReason, /unobtainable|unreachable|network/i);
});

test('the ask reason records the --dangerously-skip-permissions honesty limit (T-0ov-07)', () => {
  const { deps } = scenario({
    upstreamTip: () => { throw new UpstreamUnavailable('offline'); },
  });
  const d = runRuntimeDriftGate(input('git push origin HEAD'), deps);
  assert.match(d.permissionDecisionReason, /dangerously-skip-permissions/);
});

test('a DIGEST failure still DENIES — the HARD-01 floor is not softened by the ask path', () => {
  const { deps } = scenario({
    runtimeDigest: () => { throw new FailClosed('runtime root missing'); },
  });
  const d = runRuntimeDriftGate(input('git push origin HEAD'), deps);
  assert.strictEqual(d.permissionDecision, 'deny');
});

test('a MALFORMED-STAMP failure still DENIES', () => {
  const { deps } = scenario({
    readStamp: () => { throw new FailClosed('the runtime stamp is not valid JSON'); },
  });
  const d = runRuntimeDriftGate(input('git push origin HEAD'), deps);
  assert.strictEqual(d.permissionDecision, 'deny');
});

test('a FailClosed thrown by upstreamTip (a crafted ref line) DENIES, it does NOT become ask', () => {
  const { deps } = scenario({
    upstreamTip: () => { throw new FailClosed('ls-remote returned no clean refs/heads/next line'); },
  });
  const d = runRuntimeDriftGate(input('git push origin HEAD'), deps);
  assert.strictEqual(d.permissionDecision, 'deny');
});

test('a plain unexpected throw from the resolver DENIES (nothing leaks into ask)', () => {
  const { deps } = scenario({ resolveRoot: () => { throw new Error('boom'); } });
  const d = runRuntimeDriftGate(input('git push origin HEAD'), deps);
  assert.strictEqual(d.permissionDecision, 'deny');
});

// ───────────────────── the stale-cache path still adjudicates (D-04) ─────────────────────

test('a `stale-cache` tip still produces a REAL DENY, and the reason discloses the cache age', () => {
  const { deps } = scenario({
    upstreamTip: () => ({ sha: SHA_B, source: 'stale-cache', ageMs: 90 * 60 * 1000 }),
  });
  const d = runRuntimeDriftGate(input('git push origin HEAD'), deps);
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /cached/i);
  assert.match(d.permissionDecisionReason, /90 minutes/);
});

test('a `stale-cache` tip still produces a REAL ALLOW when the runtime matches it', () => {
  const { deps } = scenario({
    upstreamTip: () => ({ sha: SHA_A, source: 'stale-cache', ageMs: 42 * 60 * 1000 }),
  });
  const d = runRuntimeDriftGate(input('git push origin HEAD'), deps);
  assert.strictEqual(d.permissionDecision, 'allow');
});

// ───────────────────── chain safety (CTK-ADR-0006 §Decision.8) ─────────────────────

test('`git status && git push origin HEAD` ENGAGES — hasGovernedSegment, never the aggregate', () => {
  const { deps, calls } = scenario({ upstreamTip: () => ({ sha: SHA_B, source: 'live', ageMs: 0 }) });
  const d = runRuntimeDriftGate(input('git status && git push origin HEAD'), deps);
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.ok(calls.runtimeDigest > 0);
});

test('`gh issue comment 1 --body x && gh issue create --title y --body z` ENGAGES on the create', () => {
  const { deps, calls } = scenario({ readStamp: () => null });
  const d = runRuntimeDriftGate(
    input('gh issue comment 1 --body x && gh issue create --title y --body z'),
    deps
  );
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.ok(calls.runtimeDigest > 0);
});

test('a wrapped push (`sudo git push origin main`) still ENGAGES (CF-04/CF-08 wrapper handling)', () => {
  const { deps, calls } = scenario({ readStamp: () => null });
  const d = runRuntimeDriftGate(input('sudo git push origin main'), deps);
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.ok(calls.runtimeDigest > 0);
});

// ───────────────────── ordering, asserted structurally ─────────────────────

test('the oracle is consulted in the order digest → stamp → tip, and only ONCE each', () => {
  const order = [];
  const { deps } = scenario({
    runtimeDigest: () => { order.push('digest'); return DIGEST; },
    readStamp: () => { order.push('stamp'); return stampAt(SHA_A, DIGEST); },
    upstreamTip: () => { order.push('tip'); return { sha: SHA_A, source: 'live', ageMs: 0 }; },
  });
  runRuntimeDriftGate(input('git push origin HEAD'), deps);
  assert.deepStrictEqual(order, ['digest', 'stamp', 'tip']);
});

test('malformed stdin DENIES (readHookInput throws → fail closed)', () => {
  const { deps, calls } = scenario();
  for (const bad of ['', 'not json', 'null', '[]']) {
    const d = runRuntimeDriftGate(bad, deps);
    assert.strictEqual(d.permissionDecision, 'deny', JSON.stringify(bad));
  }
  assert.strictEqual(oracleCalls(calls), 0);
});

test('the pure gate() seam is exported and returns a decision object', () => {
  const { deps } = scenario();
  const d = gate(input('git status'), deps);
  assert.deepStrictEqual(d, { permissionDecision: 'allow' });
});
