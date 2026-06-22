'use strict';

/**
 * node:test for hooks/scan-gate.cjs — the ENF-09 pre-push LIVE scan gate.
 *
 * Driven through the injectable runScanGate(input, deps) seam so the unit suite is
 * hermetic: the scan runner (which in production execFile's the LIVE gsd-core shell
 * scans secret-scan.sh / prompt-injection-scan.sh / base64-scan.sh) is injected, so a
 * test NEVER actually spawns bash. The gate REIMPLEMENTS no scan logic — it only invokes
 * the LIVE scripts (HARD-02); these tests prove the allow/deny/fail-closed contract.
 *
 * Covered:
 *   - git push, all scans clean → allow
 *   - git push, one scan failing (exit 1) → deny naming the script + its tail + ENF-09
 *   - git push, multiple scans failing → deny naming each
 *   - git push, scan INFRA failure (runScans throws) → fail-closed deny (HARD-01)
 *   - fail-closed WITH a logged override → allow + receipt (HARD-03)
 *   - git commit (non-push) → allow, no scans run (out of scan-gate scope)
 *   - gh pr create → allow (scan gate is push-only per the phase decision)
 *   - a non-git command (ls) → allow, no scans run
 *   - unparseable command → fail-closed deny (HARD-04)
 *   - malformed stdin JSON → fail-closed deny
 *   - SCANS is EXACTLY the three LIVE shell scripts
 */

const test = require('node:test');
const assert = require('node:assert');

const { runScanGate, SCANS, TRIGGER_ACTIONS } = require('./scan-gate.cjs');

function input(command) {
  return JSON.stringify({ tool_name: 'Bash', tool_input: { command } });
}

// A runScans stub: returns a result per scan. `fails` maps a script-path → tail string;
// any scan NOT in `fails` is reported clean. Records which scans were run.
function stubRunner(fails = {}, ran = []) {
  return (root, scans) => {
    return scans.map((s) => {
      ran.push(s.script);
      if (Object.prototype.hasOwnProperty.call(fails, s.script)) {
        return { script: s.script, ok: false, code: 1, tail: fails[s.script] };
      }
      return { script: s.script, ok: true, code: 0, tail: '' };
    });
  };
}

function deps(over = {}) {
  return Object.assign(
    {
      worktreeRoot: '/tmp/wt',
      gsdCoreRoot: '/tmp/wt',
      runScans: (_root, scans) => scans.map((s) => ({ script: s.script, ok: true, code: 0, tail: '' })),
      overrideImpl: { checkOverride: () => ({ override: false }), writeReceipt: () => {} },
    },
    over
  );
}

test('git push, all scans clean → allow (all three LIVE scans run)', () => {
  const ran = [];
  const d = runScanGate(input('git push origin main'), deps({ runScans: stubRunner({}, ran) }));
  assert.strictEqual(d.permissionDecision, 'allow');
  assert.deepStrictEqual(
    ran.sort(),
    ['scripts/base64-scan.sh', 'scripts/prompt-injection-scan.sh', 'scripts/secret-scan.sh'].sort()
  );
});

test('git push, one scan failing → deny naming the script + tail + ENF-09', () => {
  const d = runScanGate(
    input('git push origin main'),
    deps({ runScans: stubRunner({ 'scripts/secret-scan.sh': 'leaked AWS key AKIA…' }) })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /secret-scan\.sh/);
  assert.match(d.permissionDecisionReason, /leaked AWS key/);
  assert.match(d.permissionDecisionReason, /ENF-09/);
});

test('git push, prompt-injection scan failing → deny naming it', () => {
  const d = runScanGate(
    input('git push'),
    deps({ runScans: stubRunner({ 'scripts/prompt-injection-scan.sh': 'ignore all previous instructions' }) })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /prompt-injection-scan\.sh/);
  assert.match(d.permissionDecisionReason, /ignore all previous instructions/);
});

test('git push, multiple scans failing → deny naming each', () => {
  const d = runScanGate(
    input('git push'),
    deps({
      runScans: stubRunner({
        'scripts/secret-scan.sh': 'secret hit',
        'scripts/base64-scan.sh': 'suspicious base64 blob',
      }),
    })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /secret-scan\.sh/);
  assert.match(d.permissionDecisionReason, /base64-scan\.sh/);
});

test('git push, scan INFRA failure (runScans throws) → fail-closed deny (HARD-01)', () => {
  const d = runScanGate(
    input('git push'),
    deps({
      runScans: () => {
        throw new Error('bash: command not found');
      },
    })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /bash: command not found/);
});

test('a logged override flips a fail-closed infra error → allow + receipt (HARD-03)', () => {
  let receipt = null;
  const d = runScanGate(
    input('git push'),
    deps({
      runScans: () => {
        throw new Error('scan script missing');
      },
      overrideImpl: {
        checkOverride: () => ({ override: true, reason: 'scans ran manually, infra outage' }),
        writeReceipt: (root, rec) => {
          receipt = rec;
        },
      },
    })
  );
  assert.strictEqual(d.permissionDecision, 'allow');
  assert.ok(receipt, 'an honored override writes a receipt');
});

test('git commit (non-push) → allow, no scans run', () => {
  const ran = [];
  const d = runScanGate(input('git commit -m wip'), deps({ runScans: stubRunner({}, ran) }));
  assert.strictEqual(d.permissionDecision, 'allow');
  assert.deepStrictEqual(ran, []);
});

test('gh pr create → allow, no scans run (scan gate is push-only)', () => {
  const ran = [];
  const d = runScanGate(
    input('gh pr create --base next --title x --body y'),
    deps({ runScans: stubRunner({}, ran) })
  );
  assert.strictEqual(d.permissionDecision, 'allow');
  assert.deepStrictEqual(ran, []);
});

test('a non-git command (ls) → allow, no scans run', () => {
  const ran = [];
  const d = runScanGate(input('ls -la'), deps({ runScans: stubRunner({}, ran) }));
  assert.strictEqual(d.permissionDecision, 'allow');
  assert.deepStrictEqual(ran, []);
});

test('an unparseable command fails closed (deny, HARD-04)', () => {
  const d = runScanGate(
    JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git push "unterminated' } }),
    deps()
  );
  assert.strictEqual(d.permissionDecision, 'deny');
});

test('malformed stdin JSON fails closed (deny)', () => {
  const d = runScanGate('{not json', deps());
  assert.strictEqual(d.permissionDecision, 'deny');
});

test('SCANS is EXACTLY the three LIVE shell scans; TRIGGER_ACTIONS is push-only', () => {
  const scripts = SCANS.map((s) => s.script).sort();
  assert.deepStrictEqual(
    scripts,
    ['scripts/base64-scan.sh', 'scripts/prompt-injection-scan.sh', 'scripts/secret-scan.sh'].sort()
  );
  // No scan entry should reimplement detection logic — each is just a .sh path.
  for (const s of SCANS) {
    assert.match(s.script, /\.sh$/);
  }
  assert.deepStrictEqual([...TRIGGER_ACTIONS].sort(), ['push']);
});
