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
  const calls = { resolveRoot: 0, runtimeDigest: 0, readStamp: 0, upstreamTip: 0, segmentDirs: 0, resolvePushUrls: 0, urlRewrites: 0 };
  const deps = Object.assign(
    {
      resolveRoot: () => { calls.resolveRoot += 1; return '/tmp/gsd-core'; },
      // quick-261007-rni F9 (PD-7): the default world has NO remotes, so a push to a named remote
      // takes rule c, which is exactly the pre-F9 cwd rule. Tests that need a resolution inject one.
      segmentDirs: () => { calls.segmentDirs += 1; return ['/tmp/gsd-core']; },
      // F9 R4 (item 2): git's own "No such remote" shape (exit 2), so a literal URL target takes
      // the literal path, as in a real repo with no `remote."<URL>"` entry.
      resolvePushUrls: (d, name) => {
        calls.resolvePushUrls += 1;
        throw Object.assign(new Error("scenario: no remote lookup configured (No such remote '" + name + "')"), { status: 2, signal: null });
      },
      // quick-261007-rni F9 R2 (item 5): the default world has no url.<base>.insteadOf / pushInsteadOf rewrite.
      urlRewrites: () => { calls.urlRewrites += 1; return []; },
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
// davesienkowski/gsd-core-sandbox fork) was blocked as a push to open-gsd/gsd-core. Per segment:
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

  const FORK = 'https://github.com/davesienkowski/gsd-core-sandbox.git';
  const UPSTREAM = 'https://github.com/open-gsd/gsd-core.git';
  const TOOLKIT = 'https://github.com/davesienkowski/gsd-contrib-toolkit.git';
  const REMOTES = { backup: [FORK], origin: [UPSTREAM] };
  // F9 R2 (item 8, WR-02): the rule-c note describes the cwd fallback, not a gsd-core verdict.
  // F9 R3 (IN-01) FLIPPED this pin's wording: "could not confirm where this push goes (X), so the
  // gate fell back to ..." (one sentence; true also when the remote resolved but failed the allowlist).
  const PD4 = /could not confirm where this push goes \(.*\), so the gate fell back to the gsd-core-checkout rule/s;

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
      // F9 R4 (item 2): git exits 2 for "No such remote" (a literal URL then takes the literal path).
      throw Object.assign(new Error("error: No such remote '" + name + "'"), { status: 2, signal: null });
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
      deps.resolvePushUrls = (d, n, ms) => { calls.resolvePushUrls += 1; return f(d, n, ms); };
    }
    if (over.urlRewrites) {
      const f = over.urlRewrites;
      deps.urlRewrites = (d, ms) => { calls.urlRewrites += 1; return f(d, ms); };
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

  // F9 R4 (item 2) FLIPPED the lookup count 0 -> 1: a literal is first looked up as a remote NAME
  // (git exits 2, "No such remote", so the literal itself is classified).
  test('F9: the literal fork scp URL from a gsd-core cwd -> allow after one remote-name lookup', () => {
    const cmd = 'git push git@github.com:davesienkowski/gsd-core-sandbox.git x';
    const lookup = lookupMap(REMOTES);
    const { deps, calls } = f9World({ resolvePushUrls: lookup });
    assertAllow(runRuntimeDriftGate(input(cmd), deps), calls, cmd);
    assert.strictEqual(calls.resolvePushUrls, 1);
    assert.deepStrictEqual(lookup.log.map((e) => e[1]), ['git@github.com:davesienkowski/gsd-core-sandbox.git']);
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

  // ───────────── quick-261007-rni F9 R2: hardening round (REVIEW CR-01..04 / WR-01..03, ADVERSARIAL C1) ─────────────
  //
  // Rule (b) is an ALLOWLIST (CONTEXT Revision 2): a push may classify 'other' only when the raw
  // command has no ( ) { } ` $ < > \ or newline (except the exact token 2>&1), no env assignment or
  // privilege wrapper, and every segment is an allowlisted program / git subcommand; a dash token
  // after the push positional is a known boolean; no --receive-pack / --exec (any abbreviation);
  // a literal URL needs an empty `git config --get-regexp ^url\.`; lookups share a 5000 ms budget
  // and at most 3 dirs. Anything short of that is rule (c): the pre-F9 cwd rule.
  //
  // Naming: `F9 R2: ` fails before the R2 fix and passes after; `F9 R2 guard: ` passes both.
  // Every deny row is from a gsd-core cwd with an unstamped runtime; origin = upstream and
  // backup = a fork unless the row says otherwise.
  {
    const UP_SLASH = 'https://github.com/open-gsd/gsd-core.git/';
    const UP_SCP_SLASH = 'git@github.com:open-gsd/gsd-core.git/';
    const PLANT = "printf '[url \"https://github.com/open-gsd/gsd-core.git\"]\\n\\tpushInsteadOf = " + FORK + "\\n'";

    // [label, command, lookup map, decision when the command runs from a non-gsd-core cwd]
    const DENY_ROWS = [
      // REVIEW bypass table (CR-01, CR-02, CR-03)
      ['REVIEW row 1', 'git push ' + UP_SLASH + ' next', REMOTES, 'deny'],
      ['REVIEW row 2', 'git push backup x', { backup: [UP_SLASH] }, 'deny'],
      ['REVIEW row 3', 'git push backup x', { backup: [UP_SCP_SLASH] }, 'deny'],
      ['REVIEW row 4', 'git push backup x && (git push origin main)', REMOTES, 'allow'],
      ['REVIEW row 5', 'git push backup x && { git push origin main; }', REMOTES, 'allow'],
      ['REVIEW row 6', 'git push backup x && bash -c "git push origin main"', REMOTES, 'allow'],
      ['REVIEW row 7', 'git push backup x && sh -c "git push origin main"', REMOTES, 'allow'],
      ['REVIEW row 8', 'git push backup x && xargs git push origin < /dev/null', REMOTES, 'allow'],
      ['REVIEW row 9', 'cd /tmp/tk && git push origin main && cd /tmp/gc && (git push origin main)', { origin: [TOOLKIT] }, 'allow'],
      ['REVIEW row 10', 'bash -c "git remote set-url backup ' + UPSTREAM + '" && git push backup x', REMOTES, 'allow'],
      // CR-03 spellings
      ['CR-03 node -e', 'node -e "require(\'child_process\').execSync(\'git remote set-url backup ' + UPSTREAM + '\')" && git push backup x', REMOTES, 'allow'],
      ['CR-03 script', 'sh ./fix.sh && git push backup x', REMOTES, 'allow'],
      ['CR-03 cd .git append', "cd .git && printf '[remote \"backup\"]\\n pushurl = " + UPSTREAM + "\\n' >> config && cd .. && git push backup x", REMOTES, 'allow'],
      // CR-04 spellings
      ['CR-04 printf -v GIT_DIR', 'printf -v GIT_DIR %s /other/repo && export GIT_DIR && git push backup x', REMOTES, 'allow'],
      ['CR-04 HOME prefix', 'HOME=/tmp/e git push backup x', REMOTES, 'allow'],
      ['CR-04 XDG prefix', 'XDG_CONFIG_HOME=/tmp/e/.config git push backup x', REMOTES, 'allow'],
      ['CR-04 export HOME', 'export HOME=/tmp/e && git push backup x', REMOTES, 'allow'],
      ['CR-04 sudo', 'sudo -u someone git push backup x', REMOTES, 'allow'],
      ['CR-04 env -i', 'env -i git push backup x', REMOTES, 'allow'],
      // ADVERSARIAL C1 refutations
      ['ADV 1 scp trailing slash', 'git push ' + UP_SCP_SLASH + ' x', REMOTES, 'deny'],
      ['ADV 1 ssh trailing slash', 'git push ssh://git@github.com/open-gsd/gsd-core.git/ x', REMOTES, 'deny'],
      // F9 R4 (item 1, REVIEW-R3 CR-01) FLIPPED these two from 'allow' to 'deny' away from gsd-core:
      // dot segments collapse, so the URL parses as open-gsd/gsd-core (rule a, any cwd).
      ['ADV 1b dot-dot segment', 'git push https://github.com/open-gsd/gsd-core/../gsd-core x', REMOTES, 'deny'],
      ['ADV 1b dot segment', 'git push https://github.com/open-gsd/gsd-core/./ x', REMOTES, 'deny'],
      ['ADV 2 .git/./config append', "printf '[remote \"backup\"]\\n\\tpushurl = https://github.com/open-gsd/gsd-core\\n' >> .git/./config && git push backup x", REMOTES, 'allow'],
      ['ADV 3 cd .git config append', "cd .git && printf x >> config && cd .. && git push backup x", REMOTES, 'allow'],
      ['ADV 4 XDG planted config', 'mkdir -p /tmp/x2/git && ' + PLANT + ' > /tmp/x2/git/./config && XDG_CONFIG_HOME=/tmp/x2 git push backup x', REMOTES, 'allow'],
      ['ADV 4 export XDG', 'export XDG_CONFIG_HOME=/tmp/x; git push backup x', REMOTES, 'allow'],
      ['ADV 5 HOME planted config', 'mkdir -p /tmp/h2/.config/git && ' + PLANT + ' > /tmp/h2/.config/git/./config && HOME=/tmp/h2 git push backup x', REMOTES, 'allow'],
      ['ADV 6 --receive-pack after positional', 'git push backup x --receive-pack=foo', REMOTES, 'allow'],
      ['ADV 6 --exec after positional', 'git push backup x --exec=foo', REMOTES, 'allow'],
      ['ADV 6 quoted --receive-pack', "git push --porcelain backup x --receive-pack='git-receive-pack open-gsd/gsd-core.git #'", REMOTES, 'allow'],
      ['ADV 6 abbreviated --receive', 'git push backup x --receive=foo', REMOTES, 'allow'],
      ['ADV 6 abbreviated --exe', 'git push backup x --exe=foo', REMOTES, 'allow'],
      ['ADV 6 unknown option after positional', 'git push backup x --frobnicate', REMOTES, 'allow'],
      ['ADV 6 value option after positional', 'git push backup x -o ci.skip', REMOTES, 'allow'],
      // allowlist (item 3) beyond the reported spellings
      ['item 3 git fetch --upload-pack', 'git fetch --upload-pack="git remote set-url backup ' + UPSTREAM + '; git-upload-pack" . && git push backup x', REMOTES, 'allow'],
      ['item 3 git ls-remote -u', 'git ls-remote -u git-upload-pack . && git push backup x', REMOTES, 'allow'],
      ['item 3 git -c on a non-push segment', 'git -c core.pager=less log && git push backup x', REMOTES, 'allow'],
      ['item 3 git diff --output', 'git diff --output=.git/config && git push backup x', REMOTES, 'allow'],
      ['item 3 git branch write form', 'git branch -u origin/main && git push backup x', REMOTES, 'allow'],
      ['item 3 git config read', 'git config --get remote.backup.url && git push backup x', REMOTES, 'allow'],
      ['item 3 unknown git subcommand', 'git p origin x && git push backup x', REMOTES, 'allow'],
      ['item 3 tee', 'git status | tee .git/config && git push backup x', REMOTES, 'allow'],
      ['item 3 cat with a file', 'cat .git/./config && git push backup x', REMOTES, 'allow'],
      ['item 3 pipe consumer with a file', 'git push backup x | grep -f .git/config', REMOTES, 'allow'],
      ['item 3 |& pipe', 'git push backup x |& tail -5', REMOTES, 'allow'],
      ['item 3 nice wrapper', 'nice git push backup x', REMOTES, 'allow'],
      ['item 1 dollar', 'cd $HOME/repos/gsd-core && git push backup x', REMOTES, 'allow'],
      ['item 1 newline', 'git status\ngit push backup x', REMOTES, 'allow'],
      ['item 1 redirect', 'git push backup x > /tmp/out', REMOTES, 'allow'],
    ];
    // Rows the pre-R2 gate already denied (config-file token / no-op): pinned as guards.
    const GUARD_ROWS = new Set(['item 3 git diff --output', 'item 3 tee', 'item 3 pipe consumer with a file']);
    for (const [label, cmd, map, away] of DENY_ROWS) {
      test((GUARD_ROWS.has(label) ? 'F9 R2 guard: ' : 'F9 R2: ') + label + ': `' + cmd.replace(/\n/g, '\\n') + '` DENIES from a gsd-core cwd (stale runtime)', () => {
        const here = f9World({ resolvePushUrls: lookupMap(map) });
        assertDeny(runRuntimeDriftGate(input(cmd), here.deps), here.calls, cmd);
        const elsewhere = f9World({ resolveRoot: () => null, resolvePushUrls: lookupMap(map) });
        const d = runRuntimeDriftGate(input(cmd), elsewhere.deps);
        if (away === 'deny') assertDeny(d, elsewhere.calls, cmd + ' (from another repo: rule a)');
        else assertAllow(d, elsewhere.calls, cmd + ' (from another repo: rule c keeps the cwd rule)');
      });
    }

    // T-261007-rni-07 (item 5): a literal fork URL with a url.<base>.pushInsteadOf rewrite configured.
    test('F9 R2: a literal fork URL with a url.*.pushInsteadOf rewrite configured DENIES (item 5, T-07)', () => {
      const cmd = 'git push ' + FORK + ' x';
      const rewrites = ['url.https://github.com/open-gsd/gsd-core.git.pushinsteadof ' + FORK];
      const here = f9World({ resolvePushUrls: lookupMap(REMOTES), urlRewrites: () => rewrites.slice() });
      const d = runRuntimeDriftGate(input(cmd), here.deps);
      assertDeny(d, here.calls, cmd);
      // F9 R4 (item 2) FLIPPED 0 -> 1: a literal is first looked up as a remote NAME ("No such remote").
      assert.strictEqual(here.calls.resolvePushUrls, 1, 'a literal target is looked up once as a remote name');
      assert.strictEqual(here.calls.urlRewrites, 1, 'the rewrite check runs once, in the push dir');
      assert.match(d.permissionDecisionReason, PD4);
    });

    test('F9 R2: a literal fork URL whose rewrite check throws DENIES from a gsd-core cwd (item 5)', () => {
      const cmd = 'git push ' + FORK + ' x';
      const here = f9World({ urlRewrites: () => { throw new Error('fatal: not a git repository'); } });
      assertDeny(runRuntimeDriftGate(input(cmd), here.deps), here.calls, cmd);
    });

    // ── positive pins (item 9): the plain forms still allow ──
    // F9 R3 (item 2): a derived dir that does not exist is rule c, so the two `~/repos/gsd-core`
    // pins run under a fixture HOME that has that dir (hermetic: CI has no ~/repos/gsd-core).
    const PIN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'f9r3-pin-home-'));
    fs.mkdirSync(path.join(PIN_HOME, 'repos', 'gsd-core'), { recursive: true });
    require('node:test').after(() => fs.rmSync(PIN_HOME, { recursive: true, force: true }));
    for (const cmd of [
      'git push backup fix/x',
      'git push backup fix/x 2>&1 | tail -5',
      'cd ~/repos/gsd-core && git push backup x',
      'git -C ~/repos/gsd-core push backup x',
      'git status && git push backup x',
      'git push backup x --force-with-lease',
      'git push -u backup fix/x && git log --oneline -3 | head -3',
      'git remote -v && git push backup x',
      'git push ' + FORK + ' x',
    ]) {
      test('F9 R2 guard: pin `' + cmd + '` from a gsd-core cwd ALLOWS (backup is a fork)', () => {
        const lookup = lookupMap(REMOTES);
        const { deps, calls } = f9World({ resolvePushUrls: lookup, segmentDirs: (c, s) => pushSegmentDirs(c, FIX, s) });
        const savedHome = process.env.HOME;
        process.env.HOME = PIN_HOME;
        try {
          assertAllow(runRuntimeDriftGate(input(cmd), deps), calls, cmd);
        } finally {
          process.env.HOME = savedHome;
        }
      });
    }

    // ── item 6 / WR-01: the lookup budget and the dir cap ──
    test('F9 R2: three pushes whose lookups take 2500 ms each share ONE 5000 ms budget; the third falls to rule c', () => {
      let clock = 1000000;
      const timeouts = [];
      const lookup = (dir, name, ms) => { timeouts.push(ms); clock += 2500; return [FORK]; };
      const cmd = 'git push backup a && git push backup b && git push backup c';
      const { deps, calls } = f9World({ resolvePushUrls: lookup, now: () => clock });
      assertDeny(runRuntimeDriftGate(input(cmd), deps), calls, cmd);
      assert.deepStrictEqual(timeouts, [3000, 2500], 'each lookup gets min(3000, remaining); none once the budget is spent');
    });

    test('F9 R2: a lookup that returns after the deadline does not earn rule b', () => {
      let clock = 0;
      const lookup = () => { clock += 6000; return [FORK]; };
      const { deps, calls } = f9World({ resolvePushUrls: lookup, now: () => clock });
      assertDeny(runRuntimeDriftGate(input('git push backup x'), deps), calls, 'slow lookup');
    });

    test('F9 R2: more than 3 candidate dirs falls to rule c with NO lookup', () => {
      const { deps, calls } = f9World({ resolvePushUrls: lookupMap(REMOTES), segmentDirs: () => ['/a', '/b', '/c', '/d'] });
      assertDeny(runRuntimeDriftGate(input('git push backup x'), deps), calls, '4 dirs');
      assert.strictEqual(calls.resolvePushUrls, 0);
    });

    test('F9 R2: `cd A; cd B; cd C; cd OTHER; git push backup x` (4 real candidate dirs) DENIES with no lookup', () => {
      const cmd = 'cd ' + A + '; cd ' + B + '; cd ' + C + '; cd ' + OTHER + '; git push backup x';
      const { deps, calls } = f9World({ resolvePushUrls: lookupMap(REMOTES), segmentDirs: (c, s) => pushSegmentDirs(c, FIX, s) });
      assertDeny(runRuntimeDriftGate(input(cmd), deps), calls, cmd);
      assert.strictEqual(calls.resolvePushUrls, 0);
    });

    test('F9 R2 guard: exactly 3 candidate dirs, every URL a fork -> allow', () => {
      const { deps, calls } = f9World({ resolvePushUrls: lookupMap(REMOTES), segmentDirs: () => ['/a', '/b', '/c'] });
      assertAllow(runRuntimeDriftGate(input('git push backup x'), deps), calls, '3 dirs');
      assert.strictEqual(calls.resolvePushUrls, 3);
    });

    // ── item 7: gh --repo through the stricter parseOwnerRepo ──
    for (const [spec, label] of [
      ['open-gsd/./gsd-core', 'F9 R2: '],
      ['open-gsd/gsd-core.git/', 'F9 R2: '],
      ['open-gsd/gsd-core/', 'F9 R2 guard: '],
    ]) {
      test(label + '`gh issue create --repo ' + spec + '` from a non-gsd-core cwd ARMS (item 7)', () => {
        const { deps, calls } = f9World({ resolveRoot: () => null });
        assertDeny(runRuntimeDriftGate(input('gh issue create --repo ' + spec + ' --title x --body y'), deps), calls, spec);
      });
    }

    // ── item 8 / WR-02: the note text and backtick escaping ──
    test('F9 R2: the rule-c note describes the cwd fallback, not an upstream verdict', () => {
      const { deps, calls } = f9World({ resolvePushUrls: lookupMap(REMOTES) });
      const d = runRuntimeDriftGate(input('git push nosuchremote x'), deps);
      assertDeny(d, calls, 'nosuchremote');
      assert.match(d.permissionDecisionReason, PD4);
      assert.match(d.permissionDecisionReason, /nosuchremote/);
      assert.doesNotMatch(d.permissionDecisionReason, /treated as `open-gsd\/gsd-core`/);
    });

    test('F9 R2: a backtick in an echoed token is escaped in the deny note', () => {
      const { deps, calls } = f9World({ resolvePushUrls: lookupMap(REMOTES) });
      const d = runRuntimeDriftGate(input('git push a`b`c y'), deps);
      assertDeny(d, calls, 'backtick');
      assert.ok(d.permissionDecisionReason.includes("a'b'c"), d.permissionDecisionReason);
      assert.ok(!d.permissionDecisionReason.includes('a`b`c'), 'raw backticks must not reach the reason');
    });

    // ── zero-IO short-circuit still holds for the new dep ──
    test('F9 R2 guard: non-governed commands never resolve dirs, look a remote up or read url rewrites', () => {
      for (const cmd of ['git status', 'npm test', 'git log --oneline | head', 'ls && git diff']) {
        const { deps, calls } = f9World();
        assertAllow(runRuntimeDriftGate(input(cmd), deps), calls, cmd);
        assert.strictEqual(calls.segmentDirs + calls.resolvePushUrls + calls.urlRewrites + calls.resolveRoot, 0, cmd);
      }
    });
  }

  // ───────────── quick-261007-rni F9 R3: hardening round 3 (REVIEW-R2 CR-01..03 / WR-01..03 / IN-01, ADVERSARIAL-R2 A/B) ─────────────
  //
  // Naming: `F9 R3: ` fails before the R3 fix and passes after; `F9 R3 guard: ` passes both.
  // Every deny row is from a gsd-core cwd with an unstamped runtime.
  {
    const ALIAS_OPEN = 'https://github.com/open-gsd/get-shit-done-redux';
    const ALIAS_REDUX = 'https://github.com/GSD-redux/get-shit-done-redux.git';
    const UP_DSLASH = 'https://github.com/open-gsd//gsd-core.git';
    const UP_PCT_USER = 'https://u%2Dx@github.com/open-gsd/gsd-core.git';

    // [label, command, lookup map, decision when the command runs from a non-gsd-core cwd]
    const R3_ROWS = [
      // ADVERSARIAL-R2 A / REVIEW-R2 CR-01: the rename aliases are upstream (rule a, any cwd)
      ['ADV-R2 A literal alias', 'git push ' + ALIAS_OPEN + ' fix/x', REMOTES, 'deny'],
      ['ADV-R2 A GSD-redux alias + pipe', 'git push ' + ALIAS_REDUX + ' fix/x 2>&1 | tail -5', REMOTES, 'deny'],
      ['ADV-R2 A scp alias', 'git push git@github.com:open-gsd/get-shit-done-redux.git fix/x', REMOTES, 'deny'],
      ['ADV-R2 A git -C alias', 'git -C ' + FIX + ' push ' + ALIAS_OPEN + ' x', REMOTES, 'deny'],
      ['ADV-R2 A named legacy remote', 'git push legacy fix/x', { legacy: [ALIAS_REDUX] }, 'deny'],
      ['CR-01 upper-case alias', 'git push https://github.com/OPEN-GSD/GET-SHIT-DONE-REDUX next', REMOTES, 'deny'],
      ['CR-01 origin = alias', 'git push origin next', { origin: [ALIAS_OPEN + '.git'] }, 'deny'],
      ['CR-01 origin = alias + pipe', 'git push origin HEAD:next 2>&1 | tail -3', { origin: [ALIAS_OPEN + '.git'] }, 'deny'],
      // item 1: any other open-gsd repo is never 'other' (rule c: the cwd rule)
      ['item 1 org literal', 'git push https://github.com/open-gsd/gsd-test-runner.git x', REMOTES, 'allow'],
      ['item 1 org remote', 'git push tr x', { tr: ['https://github.com/open-gsd/some-renamed-repo.git'] }, 'allow'],
      // REVIEW-R2 CR-02: `//` and `%`-userinfo upstream URLs are rule a
      ['CR-02 // literal', 'git push ' + UP_DSLASH + ' next', REMOTES, 'deny'],
      ['CR-02 %-userinfo literal', 'git push ' + UP_PCT_USER + ' next', REMOTES, 'deny'],
      ['CR-02 // remote', 'git push backup x', { backup: [UP_DSLASH] }, 'deny'],
      // REVIEW-R2 WR-02: OLDPWD / the inherited dir stack
      ['WR-02 cd -', 'cd - && git push backup x', REMOTES, 'allow'],
      ['WR-02 cd -- -', 'cd -- - && git push backup x', REMOTES, 'allow'],
      ['WR-02 popd', 'popd && git push backup x', REMOTES, 'allow'],
      ['WR-02 bare pushd', 'pushd && git push backup x', REMOTES, 'allow'],
      // REVIEW-R2 WR-03 is pinned in resolve.test.cjs (segmentRepoTarget / tokenTargetsGsdCoreApi)
      // and below: the classifier marks every dot-segment `repos/` form unknown + failClosed, so it is
      // ENF-15's (gh-issue-create) to deny, and ENF-21 never governs an unknown action (step 4).
    ];
    for (const [label, cmd, map, away] of R3_ROWS) {
      test('F9 R3: ' + label + ': `' + cmd.replace(FIX, '<FIX>') + '` DENIES from a gsd-core cwd (stale runtime)', () => {
        const here = f9World({ resolvePushUrls: lookupMap(map) });
        assertDeny(runRuntimeDriftGate(input(cmd), here.deps), here.calls, cmd);
        const elsewhere = f9World({ resolveRoot: () => null, resolvePushUrls: lookupMap(map) });
        const d = runRuntimeDriftGate(input(cmd), elsewhere.deps);
        if (away === 'deny') assertDeny(d, elsewhere.calls, cmd + ' (from another repo: rule a)');
        else assertAllow(d, elsewhere.calls, cmd + ' (from another repo: rule c keeps the cwd rule)');
      });
    }

    // ADVERSARIAL-R2 B / REVIEW-R2 CR-03: lexical vs physical dirs, with REAL symlinks and the real
    // pushSegmentDirs. T/F/root is the gsd-core cwd (backup -> fork); T/F/lnk -> T/E/x; T/E/root's
    // backup -> upstream; T/gc/lnk -> T/E/x and T/E's backup -> upstream (where `gc/lnk/..` lands).
    const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'f9r3-drift-phys-')));
    require('node:test').after(() => fs.rmSync(T, { recursive: true, force: true }));
    const FR = path.join(T, 'F', 'root');
    const ER = path.join(T, 'E', 'root');
    const GC = path.join(T, 'gc');
    const EVIL = path.join(T, 'F', 'evil1');
    for (const d of [FR, ER, path.join(T, 'E', 'x'), GC, EVIL]) fs.mkdirSync(d, { recursive: true });
    fs.symlinkSync(path.join(T, 'E', 'x'), path.join(T, 'F', 'lnk'));
    fs.symlinkSync(path.join(T, 'E', 'x'), path.join(GC, 'lnk'));
    const PHYS_MAP = {
      [FR + '|backup']: [FORK],
      [GC + '|backup']: [FORK],
      [ER + '|backup']: [UPSTREAM],
      [path.join(T, 'E') + '|backup']: [UPSTREAM],
      [EVIL + '|backup']: [UPSTREAM],
      origin: [UPSTREAM],
    };
    // The same layout where the physical dir's backup is ANOTHER fork: nothing is upstream, so
    // only the `unverified` mark keeps the push off rule (b).
    const PHYS_FORK_MAP = Object.assign({}, PHYS_MAP, { [ER + '|backup']: [TOOLKIT], [path.join(T, 'E') + '|backup']: [TOOLKIT] });
    const B_ROWS = [
      ['git -C lnk/.. push backup x', GC],
      ['cd -P lnk/.. && git push backup x', GC],
      ['git -C ../lnk/../root push backup x', FR],
      ['git -C ' + path.join(T, 'F') + '/lnk/../root push backup x', FR],
      ['cd -P ../lnk/../root && git push backup x', FR],
      ['cd -P ../lnk && cd .. && git -C root push backup x', FR],
    ];
    for (const [cmd, base] of B_ROWS) {
      test('F9 R3: ADV-R2 B `' + cmd.replace(T, '<T>') + '` (symlink `..`, physical backup = upstream) DENIES from any cwd (rule a)', () => {
        const segmentDirs = (c, s) => pushSegmentDirs(c, base, s);
        const here = f9World({ resolvePushUrls: lookupMap(PHYS_MAP), segmentDirs });
        const d = runRuntimeDriftGate(input(cmd), here.deps);
        assertDeny(d, here.calls, cmd);
        assert.doesNotMatch(d.permissionDecisionReason, /Note: ENF-21 could not/);
        const away = f9World({ resolveRoot: () => null, resolvePushUrls: lookupMap(PHYS_MAP), segmentDirs });
        assertDeny(runRuntimeDriftGate(input(cmd), away.deps), away.calls, cmd + ' (from another repo: rule a)');
      });
      test('F9 R3: ADV-R2 B `' + cmd.replace(T, '<T>') + '` (symlink `..`, every URL a fork) DENIES from a gsd-core cwd with the symlink note (rule c)', () => {
        const here = f9World({ resolvePushUrls: lookupMap(PHYS_FORK_MAP), segmentDirs: (c, s) => pushSegmentDirs(c, base, s) });
        const d = runRuntimeDriftGate(input(cmd), here.deps);
        assertDeny(d, here.calls, cmd);
        assert.match(d.permissionDecisionReason, PD4);
        assert.match(d.permissionDecisionReason, /symlink/);
      });
    }

    // ADVERSARIAL-R2 row 31 (found by the R3 e2e re-run): a missing dir must not hide the real one.
    test('F9 R3: `cd ../nope || cd ../evil1 && git push backup x` (evil1 backup = upstream) DENIES from any cwd (rule a)', () => {
      const cmd = 'cd ../nope || cd ../evil1 && git push backup x';
      const segmentDirs = (c, s) => pushSegmentDirs(c, FR, s);
      const here = f9World({ resolvePushUrls: lookupMap(PHYS_MAP), segmentDirs });
      assertDeny(runRuntimeDriftGate(input(cmd), here.deps), here.calls, cmd);
      const away = f9World({ resolveRoot: () => null, resolvePushUrls: lookupMap(PHYS_MAP), segmentDirs });
      assertDeny(runRuntimeDriftGate(input(cmd), away.deps), away.calls, cmd + ' (from another repo: rule a)');
    });

    // positive pins with real dirs: the plain forms still allow
    for (const cmd of ['git push backup fix/x', 'git push backup fix/x 2>&1 | tail -5', 'git -C ' + FR + ' push backup x']) {
      test('F9 R3 guard: pin `' + cmd.replace(T, '<T>') + '` from a real (realpath) gsd-core fixture cwd ALLOWS', () => {
        const { deps, calls } = f9World({ resolvePushUrls: lookupMap(PHYS_MAP), segmentDirs: (c, s) => pushSegmentDirs(c, FR, s) });
        assertAllow(runRuntimeDriftGate(input(cmd), deps), calls, cmd);
      });
    }

    test('F9 R3 guard: WR-03 `gh api -X POST repos/open-gsd/x/../gsd-core/issues` is unclassifiable (ENF-15 denies it), so ENF-21 leaves it alone', () => {
      const { parseCommandForGates } = require('./lib/argv.cjs');
      const { classifyAction } = require('./lib/classify.cjs');
      const { segmentRepoTarget } = require('./lib/resolve.cjs');
      const cmd = 'gh api -X POST repos/open-gsd/x/../gsd-core/issues -f title=t';
      const seg = parseCommandForGates(cmd).segments[0];
      assert.deepStrictEqual(classifyAction({ ok: true, segments: [seg] }), { action: 'unknown', failClosed: true });
      assert.strictEqual(segmentRepoTarget(seg), 'gsd-core');
    });

    // IN-01: one sentence, and it does not claim the target "could not be resolved" twice.
    test('F9 R3: the rule-c note reads "could not confirm where this push goes (...)" once, with no repeated clause', () => {
      const { deps, calls } = f9World({ resolvePushUrls: lookupMap(REMOTES) });
      const d = runRuntimeDriftGate(input('git push backup x && git stash'), deps);
      assertDeny(d, calls, 'allowlist miss');
      assert.match(d.permissionDecisionReason, PD4);
      assert.doesNotMatch(d.permissionDecisionReason, /could not resolve where this push goes/);
      assert.doesNotMatch(d.permissionDecisionReason, /Its target could not be resolved/);
    });

    test('F9 R3: a rule-a alias arm (`legacy` -> GSD-redux) carries NO unresolved note', () => {
      const { deps, calls } = f9World({ resolvePushUrls: lookupMap({ legacy: [ALIAS_REDUX] }) });
      const d = runRuntimeDriftGate(input('git push legacy x'), deps);
      assertDeny(d, calls, 'legacy');
      assert.doesNotMatch(d.permissionDecisionReason, /Note: ENF-21 could not/);
    });
  }

  // ───────────── quick-261007-rni F9 R4 (REVIEW-R3 CR-01 / WR-02, ADVERSARIAL-R3 R3-A / R3-B) ─────────────
  //
  // Naming: `F9 R4: ` fails before the R4 fix and passes after; `F9 R4 guard: ` passes both.
  // Every deny row is from a gsd-core cwd with an unstamped runtime.
  {
    const DOTP = 'https://github.com/x/../open-gsd/gsd-core.git';
    const DOT1 = 'https://github.com/./open-gsd/gsd-core.git';
    const PCTP = 'https://github.com/%6Fpen-gsd/gsd-core.git';
    const LIT = 'https://github.com/davesienkowski/gsd-core-sandbox';
    // [label, command, lookup map, decision when the command runs from a non-gsd-core cwd, R4 or guard]
    const R4_ROWS = [
      // REVIEW-R3 CR-01: dot segments (ENF-21 denied these here already; rule a now arms everywhere)
      ['CR-01 row 3 dot-dot literal', 'git push ' + DOTP + ' fix/1-x', REMOTES, 'deny', 'R4'],
      ['CR-01 row 4 dot literal', 'git push ' + DOT1 + ' fix/1-x', REMOTES, 'deny', 'R4'],
      ['CR-01 row 5 dotp remote', 'git push dotp fix/1-x', { dotp: [DOTP] }, 'deny', 'R4'],
      ['CR-01 row 6 dot1 remote', 'git push dot1 fix/1-x', { dot1: [DOT1] }, 'deny', 'R4'],
      ['CR-01 mid-path dot-dot', 'git push https://github.com/open-gsd/x/../gsd-core.git fix/1-x', REMOTES, 'deny', 'R4'],
      // REVIEW-R3 residual: unreserved escapes
      ['residual %6F literal', 'git push ' + PCTP + ' fix/1-x', REMOTES, 'deny', 'R4'],
      ['residual %6F remote', 'git push pctp fix/1-x', { pctp: [PCTP] }, 'deny', 'R4'],
      ['residual %2D literal', 'git push https://github.com/open-gsd/gsd%2Dcore.git fix/1-x', REMOTES, 'deny', 'R4'],
      // ADVERSARIAL-R3 R3-A: remote."<literal URL>" alias planted by an earlier call
      ['R3-A literal alias', 'git push ' + LIT + ' fix/x', { [LIT]: [UPSTREAM] }, 'deny', 'R4'],
      ['R3-A after a fork push', 'git push backup fix/x; git push ' + LIT + ' fix/x', Object.assign({ [LIT]: [UPSTREAM] }, REMOTES), 'deny', 'R4'],
      ['R3-A alias with pipe', 'git push ' + LIT + ' fix/x 2>&1 | tail -5', { [LIT]: [UPSTREAM] }, 'deny', 'R4'],
      // ADVERSARIAL-R3 R3-B: CDPATH (`cd docs` may land in $CDPATH/docs); rule c keeps the cwd rule
      ['R3-B cd docs', 'cd docs && git push backup fix/x', REMOTES, 'allow', 'R4'],
      ['R3-B pushd docs', 'pushd docs && git push backup fix/x', REMOTES, 'allow', 'R4'],
    ];
    for (const [label, cmd, map, away, kind] of R4_ROWS) {
      test((kind === 'R4' ? 'F9 R4: ' : 'F9 R4 guard: ') + label + ': `' + cmd + '` DENIES from a gsd-core cwd (stale runtime)', () => {
        const here = f9World({ resolvePushUrls: lookupMap(map) });
        const dh = runRuntimeDriftGate(input(cmd), here.deps);
        assertDeny(dh, here.calls, cmd);
        const elsewhere = f9World({ resolveRoot: () => null, resolvePushUrls: lookupMap(map) });
        const d = runRuntimeDriftGate(input(cmd), elsewhere.deps);
        if (away === 'deny') assertDeny(d, elsewhere.calls, cmd + ' (from another repo: rule a)');
        else assertAllow(d, elsewhere.calls, cmd + ' (from another repo: rule c keeps the cwd rule)');
      });
    }

    test('F9 R4: the CDPATH rule-c note names CDPATH', () => {
      const { deps, calls } = f9World({ resolvePushUrls: lookupMap(REMOTES) });
      const d = runRuntimeDriftGate(input('cd docs && git push backup fix/x'), deps);
      assertDeny(d, calls, 'cd docs');
      assert.match(d.permissionDecisionReason, PD4);
      assert.match(d.permissionDecisionReason, /CDPATH/);
    });

    // REVIEW-R3 WR-02 (item 4): the gh paths treat a rename alias as upstream (arms from any cwd).
    for (const cmd of [
      'gh issue create --repo open-gsd/get-shit-done-redux --title x --body y',
      'gh pr create -R GSD-redux/get-shit-done-redux --title x --body y',
    ]) {
      test('F9 R4: `' + cmd + '` from a non-gsd-core cwd ARMS (alias = upstream on the gh path)', () => {
        const { deps, calls } = f9World({ resolveRoot: () => null });
        assertDeny(runRuntimeDriftGate(input(cmd), deps), calls, cmd);
      });
    }

    test('F9 R4 guard: `gh issue create --repo gsd-build/get-shit-done` (not an alias) from a non-gsd-core cwd allows', () => {
      const { deps, calls } = f9World({ resolveRoot: () => null });
      assertAllow(runRuntimeDriftGate(input('gh issue create --repo gsd-build/get-shit-done --title x --body y'), deps), calls, 'gsd-build');
    });

    // positive pins (the literal fork URL now takes one "No such remote" lookup, then the literal)
    for (const cmd of [
      'git push backup fix/x',
      'git push backup fix/x 2>&1 | tail -5',
      'git -C ' + FIX + ' push backup x',
      'git push git@github.com:davesienkowski/gsd-core-sandbox.git x',
      'cd ./sub && git push backup x',
      'git -C docs push backup x',
    ]) {
      test('F9 R4 guard: pin `' + cmd.replace(FIX, '<FIX>') + '` from a gsd-core cwd ALLOWS', () => {
        const { deps, calls } = f9World({ resolvePushUrls: lookupMap(REMOTES) });
        assertAllow(runRuntimeDriftGate(input(cmd), deps), calls, cmd);
      });
    }
  }
}
