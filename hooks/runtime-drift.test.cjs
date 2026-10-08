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
  const calls = { resolveRoot: 0, runtimeDigest: 0, readStamp: 0, upstreamTip: 0, segmentDirs: 0, resolvePushUrls: 0 };
  const deps = Object.assign(
    {
      resolveRoot: () => { calls.resolveRoot += 1; return '/tmp/gsd-core'; },
      // quick-261007-rni F9 (PD-7): the default world has NO remotes, so a push to a named remote
      // takes rule c, which is exactly the pre-F9 cwd rule. Tests that need a resolution inject one.
      segmentDirs: () => { calls.segmentDirs += 1; return ['/tmp/gsd-core']; },
      resolvePushUrls: () => { calls.resolvePushUrls += 1; throw new Error('scenario: no remote lookup configured'); },
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

// ───────────── quick-261007-ji5 F8: key on the EXPLICIT repo target, not the session cwd ─────────────
//
// Observed 2026-10-07: `gh issue create --repo open-gsd/gsd-graph ...` run from a gsd-core session
// cwd was blocked as a filing against open-gsd/gsd-core. An explicit `--repo/-R`, `GH_REPO=` or
// gh-api `repos/<owner>/<repo>` target that is NOT open-gsd/gsd-core is not a gsd-core filing,
// whatever the cwd. With no explicit target, the cwd (root) still arms the gate.

for (const cmd of [
  'gh issue create --repo open-gsd/gsd-graph --title x --body y',
  'gh issue create -R open-gsd/gsd-graph --title x --body y',
  'GH_REPO=open-gsd/gsd-graph gh issue create --title x --body y',
  'gh pr create --repo davesienkowski/gsd-contrib-toolkit --title x --body y',
  'gh api -X POST repos/open-gsd/gsd-graph/issues -f title=x',
]) {
  test('F8: `' + cmd + '` from a gsd-core cwd → allow (explicit non-gsd-core target), oracle untouched', () => {
    const { deps, calls } = scenario({ readStamp: () => null }); // root = gsd-core; unstamped would deny
    const d = runRuntimeDriftGate(input(cmd), deps);
    assert.strictEqual(d.permissionDecision, 'allow', cmd);
    assert.strictEqual(oracleCalls(calls), 0, 'a filing against another repo never measures the runtime');
  });
}

for (const cmd of [
  'gh issue create --repo open-gsd/gsd-core --title x --body y',
  'gh issue create --title x --body y',
  'gh api -X POST repos/open-gsd/gsd-core/issues -f title=x',
  'gh issue create --repo open-gsd/gsd-graph --title x --body y && git push origin HEAD',
]) {
  test('F8 guard: `' + cmd + '` from a gsd-core cwd still ENGAGES (gsd-core target, or no explicit target)', () => {
    const { deps, calls } = scenario({ readStamp: () => null });
    const d = runRuntimeDriftGate(input(cmd), deps);
    assert.strictEqual(d.permissionDecision, 'deny', cmd);
    assert.ok(calls.runtimeDigest > 0, 'the gate must reach the oracle');
  });
}

// ── quick-261007-ji5 round 3 (re-review R2-WR-05): GH_REPO through `env` or an earlier export ──
for (const cmd of [
  'env GH_REPO=open-gsd/gsd-core gh issue create --title x --body y',
  'env -u FOO GH_REPO=open-gsd/gsd-core gh issue create --title x --body y',
  'export GH_REPO=open-gsd/gsd-core; gh issue create --title x --body y',
  'export GH_REPO=open-gsd/gsd-core && gh issue create --title x --body y',
  'GH_REPO=open-gsd/gsd-core; gh issue create --title x --body y',
]) {
  test('R2-WR-05: `' + cmd + '` from a NON-gsd-core cwd ENGAGES (GH_REPO names gsd-core)', () => {
    const { deps, calls } = scenario({ resolveRoot: () => null, readStamp: () => null });
    const d = runRuntimeDriftGate(input(cmd), deps);
    assert.strictEqual(d.permissionDecision, 'deny', cmd);
    assert.ok(calls.runtimeDigest > 0, 'the gate must reach the oracle');
  });
}

for (const cmd of [
  'env GH_REPO=open-gsd/gsd-graph gh issue create --title x --body y',
  'export GH_REPO=open-gsd/gsd-graph && gh issue create --title x --body y',
]) {
  test('R2-WR-05 other repo: `' + cmd + '` from a gsd-core cwd → allow (GH_REPO names another repo)', () => {
    const { deps, calls } = scenario({ readStamp: () => null });
    const d = runRuntimeDriftGate(input(cmd), deps);
    assert.strictEqual(d.permissionDecision, 'allow', cmd);
    assert.strictEqual(oracleCalls(calls), 0);
  });
}

// ───────────── quick-261007-rni F9: key a git push on its push TARGET (Revision 1 four-way rule) ─────────────
//
// Observed 2026-10-07: `git push backup fix/x` from a gsd-core session (backup = the
// davesienkowski/gsd-core-experiments fork) was blocked as a push to open-gsd/gsd-core. Per segment:
// (a) an open-gsd/gsd-core target URL arms from any dir; (b) every target URL another repo, with no
// push-redirect channel, does not arm; (c) an unresolvable, indeterminate or redirected target keeps
// the pre-F9 cwd rule and the deny says why; (d) no repository keeps the pre-F9 cwd rule. gh's
// --repo / GH_REPO / repos/<o>/<r> reading is never applied to a git push.
//
// Naming: `F9: ` fails before the fix and passes after; `F9 guard: ` passes both before and after.
// Every case runs unstamped (readStamp null), so allow <=> oracleCalls 0 and deny <=> runtimeDigest > 0.
{
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { pushSegmentDirs, resolveRootForCommand } = require('./lib/resolve.cjs');

  const FORK = 'https://github.com/davesienkowski/gsd-core-experiments.git';
  const UPSTREAM = 'https://github.com/open-gsd/gsd-core.git';
  const TOOLKIT = 'https://github.com/davesienkowski/gsd-contrib-toolkit.git';
  const REMOTES = { backup: [FORK], origin: [UPSTREAM] };
  const PD4 = /an unresolvable push target is treated as `open-gsd\/gsd-core`/;

  const A = fs.mkdtempSync(path.join(os.tmpdir(), 'f9-drift-a-'));
  const B = fs.mkdtempSync(path.join(os.tmpdir(), 'f9-drift-b-'));
  const C = fs.mkdtempSync(path.join(os.tmpdir(), 'f9-drift-c-'));
  const OTHER = fs.mkdtempSync(path.join(os.tmpdir(), 'f9-drift-other-'));
  const FIX = fs.mkdtempSync(path.join(os.tmpdir(), 'f9-drift-fix-'));
  fs.mkdirSync(path.join(FIX, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(FIX, 'gsd-core', 'bin', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(FIX, 'scripts', 'pr-target-policy.cjs'), 'module.exports = {};\n');
  require('node:test').after(() => {
    for (const d of [A, B, C, OTHER, FIX]) fs.rmSync(d, { recursive: true, force: true });
  });

  /**
   * A remote lookup that answers from `map` by `dir|name` first, then by `name`, and otherwise
   * throws like git's `No such remote`. Every call is recorded in `.log` as [dir, name].
   */
  function lookupMap(map) {
    const log = [];
    const fn = (dir, name) => {
      log.push([dir, name]);
      const own = (k) => Object.prototype.hasOwnProperty.call(map, k);
      if (own(dir + '|' + name)) return map[dir + '|' + name].slice();
      if (own(name)) return map[name].slice();
      throw new Error("No such remote '" + name + "'");
    };
    fn.log = log;
    return fn;
  }

  /** scenario() unstamped, with any injected segmentDirs / resolvePushUrls still counted. */
  function f9World(over = {}) {
    const { deps, calls } = scenario(Object.assign({ readStamp: () => null }, over));
    if (over.segmentDirs) {
      const f = over.segmentDirs;
      deps.segmentDirs = (c, s) => { calls.segmentDirs += 1; return f(c, s); };
    }
    if (over.resolvePushUrls) {
      const f = over.resolvePushUrls;
      deps.resolvePushUrls = (d, n) => { calls.resolvePushUrls += 1; return f(d, n); };
    }
    return { deps, calls };
  }

  function assertAllow(d, calls, cmd) {
    assert.strictEqual(d.permissionDecision, 'allow', cmd);
    assert.strictEqual(oracleCalls(calls), 0, 'an unarmed push never measures the runtime: ' + cmd);
  }

  function assertDeny(d, calls, cmd) {
    assert.strictEqual(d.permissionDecision, 'deny', cmd);
    assert.ok(calls.runtimeDigest > 0, 'an armed push reaches the oracle: ' + cmd);
  }

  // ── red cases ──

  for (const cmd of [
    'git push backup fix/x',
    'git push --repo=backup',
    'git push --repo backup',
    'git status && git push backup x',
  ]) {
    test('F9: `' + cmd + '` from a gsd-core cwd -> allow (backup is a fork), oracle untouched', () => {
      const lookup = lookupMap(REMOTES);
      const { deps, calls } = f9World({ resolvePushUrls: lookup });
      assertAllow(runRuntimeDriftGate(input(cmd), deps), calls, cmd);
      assert.deepStrictEqual(lookup.log.map((e) => e[1]), ['backup']);
    });
  }

  test('F9: the literal fork scp URL from a gsd-core cwd -> allow with no lookup', () => {
    const cmd = 'git push git@github.com:davesienkowski/gsd-core-experiments.git x';
    const lookup = lookupMap(REMOTES);
    const { deps, calls } = f9World({ resolvePushUrls: lookup });
    assertAllow(runRuntimeDriftGate(input(cmd), deps), calls, cmd);
    assert.strictEqual(calls.resolvePushUrls, 0);
  });

  test('F9: `git -C <A> push backup x` from base B looks backup up in A only -> allow', () => {
    const cmd = 'git -C ' + A + ' push backup x';
    const lookup = lookupMap(REMOTES);
    const { deps, calls } = f9World({ resolvePushUrls: lookup, segmentDirs: (c, s) => pushSegmentDirs(c, B, s) });
    assertAllow(runRuntimeDriftGate(input(cmd), deps), calls, cmd);
    assert.deepStrictEqual(lookup.log, [[A, 'backup']]);
  });

  test('F9: mixed-dir chain looks each remote up in its own dir (not the union) -> allow', () => {
    const cmd = 'cd ' + A + ' && git push backup x && cd ' + B + ' && git push origin main';
    const lookup = lookupMap({ [A + '|backup']: [FORK], [B + '|origin']: [TOOLKIT] });
    const { deps, calls } = f9World({ resolvePushUrls: lookup, segmentDirs: (c, s) => pushSegmentDirs(c, C, s) });
    assertAllow(runRuntimeDriftGate(input(cmd), deps), calls, cmd);
    assert.deepStrictEqual(lookup.log, [[A, 'backup'], [B, 'origin']]);
  });

  test('F9: null root + `git push origin HEAD` with origin -> upstream ENGAGES (rule a, D-07/F8)', () => {
    const { deps, calls } = f9World({ resolveRoot: () => null, resolvePushUrls: lookupMap(REMOTES) });
    assertDeny(runRuntimeDriftGate(input('git push origin HEAD'), deps), calls, 'origin HEAD');
  });

  test('F9: null root + a literal upstream URL ENGAGES (rule a)', () => {
    const cmd = 'git push https://github.com/open-gsd/gsd-core.git x';
    const { deps, calls } = f9World({ resolveRoot: () => null, resolvePushUrls: lookupMap(REMOTES) });
    assertDeny(runRuntimeDriftGate(input(cmd), deps), calls, cmd);
  });

  for (const cmd of [
    'GH_REPO=other/x git push origin y',
    'env GH_REPO=other/x git push origin y',
    'git push --repo=other/x origin y',
    'git push origin repos/other/x',
    'GH_REPO=other/x git push',
  ]) {
    test('F9: `' + cmd + '` from a gsd-core cwd ENGAGES (a git push is never read as a gh repo spec)', () => {
      const { deps, calls } = f9World({ resolvePushUrls: lookupMap(REMOTES) });
      assertDeny(runRuntimeDriftGate(input(cmd), deps), calls, cmd);
    });
  }

  test('F9: `git push nosuchremote x` denies and the reason names the unresolvable target', () => {
    const { deps, calls } = f9World({ resolvePushUrls: lookupMap(REMOTES) });
    const d = runRuntimeDriftGate(input('git push nosuchremote x'), deps);
    assertDeny(d, calls, 'nosuchremote');
    assert.match(d.permissionDecisionReason, /ENF-21/);
    assert.match(d.permissionDecisionReason, /nosuchremote/);
    assert.match(d.permissionDecisionReason, PD4);
  });

  for (const cmd of [
    'git -c remote.backup.pushurl=' + UPSTREAM + ' push backup x',
    'git --git-dir=/x/.git push backup x',
    'GIT_CONFIG_PARAMETERS=x git push backup y',
    'export GIT_CONFIG_GLOBAL=/x && git push backup y',
    'git remote set-url backup ' + UPSTREAM + ' && git push backup y',
    'git config remote.backup.pushurl ' + UPSTREAM + ' && git push backup y',
    'source ./env.sh && git push backup y',
    'git() { :; } && git push backup y',
    'git push --receive-pack=x backup y',
    'cat .git/config && git push backup x',
    'git -c color.ui=never push backup x',
    'git push --recurse-submodules check backup x',
  ]) {
    test('F9: redirect channel `' + cmd + '` never disarms; it denies with the unresolved sentence', () => {
      const { deps, calls } = f9World({ resolvePushUrls: lookupMap(REMOTES) });
      const d = runRuntimeDriftGate(input(cmd), deps);
      assertDeny(d, calls, cmd);
      assert.match(d.permissionDecisionReason, PD4);
    });
  }

  test('F9: two runs on the same push with the same deps give the same decision and lookup count', () => {
    const lookup = lookupMap(REMOTES);
    const { deps, calls } = f9World({ resolvePushUrls: lookup });
    const d1 = runRuntimeDriftGate(input('git push backup x'), deps);
    const n1 = lookup.log.length;
    const d2 = runRuntimeDriftGate(input('git push backup x'), deps);
    assertAllow(d1, calls, 'run 1');
    assertAllow(d2, calls, 'run 2');
    assert.strictEqual(n1, 1, 'one lookup in run 1');
    assert.strictEqual(lookup.log.length - n1, 1, 'one lookup in run 2 (no cross-invocation cache)');
  });

  test('F9: `cd <OTHER> && GIT_TRACE=1 git push origin main` reaches rule c after one lookup, then the cwd rule allows', () => {
    const cmd = 'cd ' + OTHER + ' && GIT_TRACE=1 git push origin main';
    const lookup = lookupMap({ [OTHER + '|origin']: ['https://github.com/someone/other.git'] });
    const { deps, calls } = f9World({
      resolveRoot: (c) => resolveRootForCommand(c, FIX),
      segmentDirs: (c, s) => pushSegmentDirs(c, FIX, s),
      resolvePushUrls: lookup,
    });
    assertAllow(runRuntimeDriftGate(input(cmd), deps), calls, cmd);
    assert.deepStrictEqual(lookup.log, [[OTHER, 'origin']]);
  });

  test('F9: scenario artifact (PD-7): the default world has no remotes, so `git push origin HEAD` denies WITH the sentence', () => {
    const { deps, calls } = scenario({ readStamp: () => null });
    const d = runRuntimeDriftGate(input('git push origin HEAD'), deps);
    assertDeny(d, calls, 'origin HEAD');
    assert.match(d.permissionDecisionReason, PD4);
  });

  // ── guards: pass before and after ──

  test('F9 guard: `git push origin fix/x` (origin -> upstream) from a gsd-core cwd denies', () => {
    const { deps, calls } = f9World({ resolvePushUrls: lookupMap(REMOTES) });
    assertDeny(runRuntimeDriftGate(input('git push origin fix/x'), deps), calls, 'origin fix/x');
  });

  test('F9 guard: a literal upstream URL from a gsd-core cwd denies with no lookup', () => {
    const { deps, calls } = f9World({ resolvePushUrls: lookupMap(REMOTES) });
    assertDeny(runRuntimeDriftGate(input('git push https://github.com/open-gsd/gsd-core.git x'), deps), calls, 'upstream URL');
    assert.strictEqual(calls.resolvePushUrls, 0);
  });

  test('F9 guard: `git push nosuchremote x` from a gsd-core cwd denies', () => {
    const { deps, calls } = f9World({ resolvePushUrls: lookupMap(REMOTES) });
    assertDeny(runRuntimeDriftGate(input('git push nosuchremote x'), deps), calls, 'nosuchremote');
  });

  test('F9 guard: `git push` (no repository) denies with ZERO dir and lookup calls', () => {
    const { deps, calls } = f9World();
    assertDeny(runRuntimeDriftGate(input('git push'), deps), calls, 'git push');
    assert.strictEqual(calls.segmentDirs, 0);
    assert.strictEqual(calls.resolvePushUrls, 0);
  });

  test('F9 guard: `git push --repo=backup x` denies (the repository is x, whose lookup fails)', () => {
    const { deps, calls } = f9World({ resolvePushUrls: lookupMap(REMOTES) });
    assertDeny(runRuntimeDriftGate(input('git push --repo=backup x'), deps), calls, '--repo=backup x');
  });

  test('F9 guard: `git push backup x && git push origin y` denies on the second segment', () => {
    const { deps, calls } = f9World({ resolvePushUrls: lookupMap(REMOTES) });
    assertDeny(runRuntimeDriftGate(input('git push backup x && git push origin y'), deps), calls, 'chain');
  });

  test('F9 guard: non-governed commands, gh filings and pushes with no repository never look a remote up', () => {
    for (const cmd of [
      'git status',
      'npm test',
      'gh issue create --repo open-gsd/gsd-graph --title x --body y',
      'gh pr create --title x --body y',
      'git push',
      'git push -u',
      'git push --tags',
    ]) {
      const { deps, calls } = f9World();
      runRuntimeDriftGate(input(cmd), deps);
      assert.strictEqual(calls.segmentDirs, 0, cmd);
      assert.strictEqual(calls.resolvePushUrls, 0, cmd);
    }
  });

  test('F9 guard: null root + origin -> a fork -> allow, oracle untouched (rule b)', () => {
    const { deps, calls } = f9World({ resolveRoot: () => null, resolvePushUrls: lookupMap({ origin: [FORK] }) });
    assertAllow(runRuntimeDriftGate(input('git push origin HEAD'), deps), calls, 'origin -> fork');
  });

  test('F9 guard: null root + `git push nosuchremote x` -> allow, oracle untouched (rule c keeps the cwd rule)', () => {
    const { deps, calls } = f9World({ resolveRoot: () => null, resolvePushUrls: lookupMap(REMOTES) });
    assertAllow(runRuntimeDriftGate(input('git push nosuchremote x'), deps), calls, 'nosuchremote');
  });

  {
    const narrowing = () => f9World({
      resolveRoot: (c) => resolveRootForCommand(c, FIX),
      segmentDirs: (c, s) => pushSegmentDirs(c, FIX, s),
      resolvePushUrls: lookupMap({ [OTHER + '|origin']: ['https://github.com/someone/other.git'] }),
    });
    for (const cmd of ['git -C ' + OTHER + ' push typo main', 'git -C ' + OTHER + ' -c x=y push origin main']) {
      test('F9 guard: narrowing kept: `' + cmd.replace(OTHER, '<OTHER>') + '` from a gsd-core fixture cwd -> allow', () => {
        const { deps, calls } = narrowing();
        assertAllow(runRuntimeDriftGate(input(cmd), deps), calls, cmd);
      });
    }
    test('F9 guard: `git push typo main` from the gsd-core fixture cwd denies', () => {
      const { deps, calls } = narrowing();
      assertDeny(runRuntimeDriftGate(input('git push typo main'), deps), calls, 'typo');
    });
  }

  for (const cmd of ['git -c color.ui=never push backup x', 'cat .git/config && git push backup x']) {
    test('F9 guard: over-arm pin `' + cmd + '` denies from a gsd-core cwd and allows from another repo', () => {
      const here = f9World({ resolvePushUrls: lookupMap(REMOTES) });
      assertDeny(runRuntimeDriftGate(input(cmd), here.deps), here.calls, cmd);
      const away = f9World({ resolveRoot: () => null, resolvePushUrls: lookupMap(REMOTES) });
      assertAllow(runRuntimeDriftGate(input(cmd), away.deps), away.calls, cmd);
    });
  }

  for (const [label, over] of [
    ['a throwing segmentDirs', { segmentDirs: () => { throw new Error('dirs boom'); } }],
    ['a throwing resolvePushUrls', { resolvePushUrls: () => { throw new Error('lookup boom'); } }],
  ]) {
    test('F9 guard: ' + label + ' on `git push backup x` denies from a gsd-core cwd and allows from a null root', () => {
      const here = f9World(over);
      assertDeny(runRuntimeDriftGate(input('git push backup x'), here.deps), here.calls, label);
      const away = f9World(Object.assign({ resolveRoot: () => null }, over));
      assertAllow(runRuntimeDriftGate(input('git push backup x'), away.deps), away.calls, label);
    });
  }

  test('F9 guard: a rule-a arm (origin -> upstream) carries NO unresolved sentence (PD-7 other half)', () => {
    const { deps, calls } = f9World({ resolvePushUrls: lookupMap(REMOTES) });
    const d = runRuntimeDriftGate(input('git push origin HEAD'), deps);
    assertDeny(d, calls, 'origin HEAD');
    assert.doesNotMatch(d.permissionDecisionReason, PD4);
  });
}
