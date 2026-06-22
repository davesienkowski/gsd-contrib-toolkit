'use strict';

/**
 * node:test for the fault-injection proofs (TEST-01 / TEST-02, HARD-01 / HARD-02).
 *
 * This file proves the anti-bypass thesis's FAILURE mode on a DISPOSABLE sandbox copy of the
 * gsd-core sentinel layout — never the real ~/repos/gsd-core checkout:
 *
 *   Task 1 (this file's sandbox unit cases): hooks/lib/sandbox.cjs builds a temp copy of the
 *     sentinel layout (scripts/ + gsd-core/bin/lib/), its mutators (removeScript /
 *     driftScriptShape) reject `../` path escapes and only write inside the temp root, and the
 *     REAL source bytes are provably unchanged before/after.
 *
 *   Task 2 (fault proofs): removing a referenced LIVE script makes the affected gate's REAL
 *     entrypoint emit a CONCLUSIVE deny naming the missing script (HARD-01, fail-closed);
 *     runDoctor passes on a faithful clean copy (ok:true) and reports ok:false naming the
 *     drifted script while the file STILL EXISTS (HARD-02 — shape, not absence).
 *
 * SECURITY INVARIANT: every write targets the temp sandbox only. If no real gsd-core checkout
 * is reachable, the fault cases SKIP with a recorded note rather than fabricate a fake layout
 * (a fabricated proof is worse than no proof).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const {
  makeSandbox,
  removeScript,
  driftScriptShape,
  SANDBOX_SCRIPTS,
} = require('./lib/sandbox.cjs');
const { resolveGsdCoreRoot, hasSentinel } = require('./lib/resolve.cjs');
const { spawnHook } = require('./lib/proof-harness.cjs');
const { runDoctor } = require('./lib/doctor.cjs');

const GH_PR_CREATE_HOOK = path.join(__dirname, 'gh-pr-create.cjs');

/**
 * A complete, valid `fix` PR-template body (all required headings) WITH a Fixes #N — borrowed
 * from gh-pr-create.test.cjs so the gate reaches LIVE script resolution before any policy deny.
 */
const GOOD_PR_BODY = [
  '## Fix PR',
  '',
  '## Linked Issue',
  'Fixes #12',
  '',
  '## What was broken',
  'the thing',
  '',
  '## What this fix does',
  'fixes the thing',
  '',
  '## Testing',
  'node --test',
  '',
  '## Checklist',
  '- [x] tests',
].join('\n');

/** Build a PreToolUse stdin payload for a `gh pr create` Bash command. */
function prCreateStdin(body) {
  const cmd = 'gh pr create --base next --title x --body "' + body.replace(/"/g, '\\"') + '"';
  return JSON.stringify({ tool_name: 'Bash', tool_input: { command: cmd } });
}

/** Extract the emitted permissionDecisionReason from a spawnHook result (or '' if unparseable). */
function denyReason(res) {
  try {
    return JSON.parse(res.rawStdout).hookSpecificOutput.permissionDecisionReason || '';
  } catch (_) {
    return '';
  }
}

/**
 * Resolve the REAL gsd-core checkout from this toolkit's cwd, or null if unreachable.
 * When null, the fault cases SKIP-with-note (never fabricate).
 */
function realGsdCoreRootOrNull() {
  try {
    return resolveGsdCoreRoot(process.cwd());
  } catch (_) {
    return null;
  }
}

const SOURCE_ROOT = realGsdCoreRootOrNull();
const SKIP_NOTE =
  'no real gsd-core checkout reachable from cwd — fault injection SKIPPED (env limitation; ' +
  'never fabricate a fake sentinel layout)';

/** sha256 of a file's bytes, or null if absent. */
function sha(p) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  } catch (_) {
    return null;
  }
}

// ───────────────────────── Task 1: sandbox builder unit cases ─────────────────────────

test('makeSandbox: root is under os.tmpdir() and reproduces the sentinel layout', { skip: SOURCE_ROOT ? false : SKIP_NOTE }, () => {
  const sb = makeSandbox({ sourceRoot: SOURCE_ROOT });
  try {
    assert.ok(
      sb.root.startsWith(fs.realpathSync(os.tmpdir())) || sb.root.startsWith(os.tmpdir()),
      'sandbox root must live under os.tmpdir(), got ' + sb.root
    );
    // The sentinel must resolve to the sandbox itself, NOT walk up to the real checkout.
    assert.strictEqual(hasSentinel(sb.root), true, 'sandbox must have the sentinel layout');
    assert.strictEqual(
      resolveGsdCoreRoot(sb.root),
      sb.root,
      'resolveGsdCoreRoot(sandboxRoot) must return the sandbox, not the real checkout'
    );
    // Every SHAPE-checked script was copied in.
    for (const rel of SANDBOX_SCRIPTS) {
      assert.strictEqual(fs.existsSync(path.join(sb.root, rel)), true, 'missing copied script ' + rel);
    }
  } finally {
    sb.dispose();
  }
});

test('makeSandbox.dispose() removes the temp dir', { skip: SOURCE_ROOT ? false : SKIP_NOTE }, () => {
  const sb = makeSandbox({ sourceRoot: SOURCE_ROOT });
  const root = sb.root;
  assert.strictEqual(fs.existsSync(root), true);
  sb.dispose();
  assert.strictEqual(fs.existsSync(root), false, 'dispose() must rmSync the sandbox');
  // dispose() is idempotent (force:true) — a second call must not throw.
  assert.doesNotThrow(() => sb.dispose());
});

test('removeScript / driftScriptShape REJECT path escapes (../ and absolute)', { skip: SOURCE_ROOT ? false : SKIP_NOTE }, () => {
  const sb = makeSandbox({ sourceRoot: SOURCE_ROOT });
  try {
    for (const rel of ['../escape.cjs', '../../etc/passwd', 'scripts/../../escape.cjs']) {
      assert.throws(
        () => removeScript(sb.root, rel),
        /escape|outside|invalid/i,
        'removeScript must reject path escape: ' + rel
      );
      assert.throws(
        () => driftScriptShape(sb.root, rel, 'classifyPrTarget'),
        /escape|outside|invalid/i,
        'driftScriptShape must reject path escape: ' + rel
      );
    }
    // An absolute path that resolves outside the sandbox must also be rejected.
    assert.throws(
      () => removeScript(sb.root, '/tmp/not-the-sandbox.cjs'),
      /escape|outside|invalid/i
    );
  } finally {
    sb.dispose();
  }
});

test('the REAL gsd-core source bytes are UNCHANGED after a full mutate cycle', { skip: SOURCE_ROOT ? false : SKIP_NOTE }, () => {
  // Snapshot the real source scripts' bytes BEFORE.
  const before = new Map();
  for (const rel of SANDBOX_SCRIPTS) {
    before.set(rel, sha(path.join(SOURCE_ROOT, rel)));
  }

  const sb = makeSandbox({ sourceRoot: SOURCE_ROOT });
  try {
    // Mutate the SANDBOX heavily — none of this may touch the real checkout.
    removeScript(sb.root, 'scripts/pr-template-policy.cjs');
    driftScriptShape(sb.root, 'scripts/pr-target-policy.cjs', 'classifyPrTarget');
  } finally {
    sb.dispose();
  }

  // The real source bytes must be byte-identical AFTER.
  for (const rel of SANDBOX_SCRIPTS) {
    assert.strictEqual(
      sha(path.join(SOURCE_ROOT, rel)),
      before.get(rel),
      'REAL gsd-core source mutated! ' + rel + ' — the sandbox must NEVER write outside its temp root'
    );
  }
});

test('removeScript actually removes the sandbox file; driftScriptShape rewrites it in place', { skip: SOURCE_ROOT ? false : SKIP_NOTE }, () => {
  const sb = makeSandbox({ sourceRoot: SOURCE_ROOT });
  try {
    const target = path.join(sb.root, 'scripts', 'pr-target-policy.cjs');
    assert.strictEqual(fs.existsSync(target), true);

    // drift: the file STILL EXISTS but its export returns a wrong shape.
    driftScriptShape(sb.root, 'scripts/pr-target-policy.cjs', 'classifyPrTarget');
    assert.strictEqual(fs.existsSync(target), true, 'drift must keep the file present (shape, not absence)');
    delete require.cache[target];
    const drifted = require(target);
    assert.strictEqual(typeof drifted.classifyPrTarget, 'function');
    const out = drifted.classifyPrTarget('next', 'x');
    assert.ok(
      !(out && typeof out === 'object' && (out.decision === 'allowed' || out.decision === 'blocked' || out.decision === 'unusual')),
      'drifted export must NOT return a valid classifyPrTarget shape'
    );

    // remove: the file is gone.
    removeScript(sb.root, 'scripts/issue-dedupe.cjs');
    assert.strictEqual(fs.existsSync(path.join(sb.root, 'scripts', 'issue-dedupe.cjs')), false);
  } finally {
    sb.dispose();
  }
});

// ───────────────────── Task 2: fault-injection proofs (HARD-01 / HARD-02) ─────────────────────

test('HARD-01: a REMOVED live script makes gh-pr-create emit a CONCLUSIVE deny naming the missing script', { skip: SOURCE_ROOT ? false : SKIP_NOTE }, () => {
  const sb = makeSandbox({ sourceRoot: SOURCE_ROOT });
  try {
    // The gate resolves pr-template-policy FIRST (gh-pr-create.cjs), so removing it forces a
    // requireLiveScript ScriptResolveError → runGate catch → fail-closed deny BEFORE any
    // branch/template policy can decide. The deny reason therefore NAMES the missing script,
    // distinguishing a script-resolution fail-close from a generic policy deny.
    removeScript(sb.root, 'scripts/pr-template-policy.cjs');

    const res = spawnHook(GH_PR_CREATE_HOOK, { stdin: prCreateStdin(GOOD_PR_BODY), cwd: sb.root });

    // It is a CONCLUSIVE deny — NOT allow, NOT inconclusive (a crash/non-zero exit is NOT a pass).
    assert.strictEqual(res.conclusive, true, 'deny must be conclusive (clean exit 0 + parseable envelope), got: ' + res.reason);
    assert.strictEqual(res.decision, 'deny', 'a missing LIVE script must FAIL CLOSED (deny), got: ' + res.decision);
    assert.notStrictEqual(res.decision, 'allow', 'a missing LIVE script must NEVER allow');
    assert.strictEqual(res.status, 0, 'the gate emits a real deny envelope on exit 0, not a crash');

    // The deny is CAUSED by the missing script (names it), not by branch/template policy.
    const reason = denyReason(res);
    assert.match(
      reason,
      /live script not found|pr-template-policy\.cjs|requireLiveScript/i,
      'the deny must name the missing live script (script-resolution fail-close), got: ' + reason
    );
  } finally {
    sb.dispose();
  }
});

test('HARD-02 (control): runDoctor on a faithful CLEAN sandbox returns ok:true (4/4 shapes hold)', { skip: SOURCE_ROOT ? false : SKIP_NOTE }, () => {
  const sb = makeSandbox({ sourceRoot: SOURCE_ROOT });
  try {
    const report = runDoctor(sb.root);
    assert.strictEqual(
      report.ok,
      true,
      'the doctor must PASS on a faithful copy (proves a later red is meaningful, not always-red): ' +
        JSON.stringify(report.results.filter((r) => !r.ok))
    );
    assert.strictEqual(report.results.length, 4, 'all four SHAPE_CHECKS run');
    assert.ok(report.results.every((r) => r.ok === true), 'every shape check holds on the clean copy');
  } finally {
    sb.dispose();
  }
});

test('HARD-02: a SHAPE-DRIFTED live script makes runDoctor report ok:false naming it — while the file STILL EXISTS (shape, not absence)', { skip: SOURCE_ROOT ? false : SKIP_NOTE }, () => {
  const sb = makeSandbox({ sourceRoot: SOURCE_ROOT });
  try {
    const target = path.join(sb.root, 'scripts', 'pr-target-policy.cjs');
    driftScriptShape(sb.root, 'scripts/pr-target-policy.cjs', 'classifyPrTarget');

    // CRITICAL: the file STILL EXISTS post-drift — so an existence-only check would PASS. This
    // proves the doctor caught the RETURN SHAPE, not mere absence (T-05-03-FAKEPASS).
    assert.strictEqual(fs.existsSync(target), true, 'the drifted script must still exist on disk');

    const report = runDoctor(sb.root);
    assert.strictEqual(report.ok, false, 'a drifted return shape must make the doctor report ok:false');

    const drifted = report.results.find((r) => r.script === 'scripts/pr-target-policy.cjs');
    assert.ok(drifted, 'the report must include the drifted script');
    assert.strictEqual(drifted.ok, false, 'the drifted script entry must be ok:false');
    assert.match(
      drifted.detail,
      /shape|drift/i,
      'the failing detail must name a SHAPE drift, not a missing file: ' + drifted.detail
    );

    // The OTHER three scripts (untouched) must still pass — the doctor pinpoints the drift, not a blanket red.
    const others = report.results.filter((r) => r.script !== 'scripts/pr-target-policy.cjs');
    assert.ok(others.every((r) => r.ok === true), 'untouched scripts must still pass (precise drift detection)');
  } finally {
    sb.dispose();
  }
});
