'use strict';

/**
 * node:test for hooks/gh-issue-create.cjs (ENF-01 / ENF-15 / HARD-01 / HARD-04).
 *
 * Drives the gate through the injectable runIssueGate(input, deps) seam so the
 * LIVE issue-version-gate.cjs export and the override check can be injected — no
 * filesystem walk, no real gsd-core checkout required for the unit suite.
 */

const test = require('node:test');
const assert = require('node:assert');

const { runIssueGate } = require('./gh-issue-create.cjs');

// The REAL live export shape, re-stated as a stub so the unit suite is hermetic:
// evaluateVersionGate({labels, body}) -> {action:'skip'|'close', reason}.
const liveVersionGate = require('/home/dave/repos/gsd-core/scripts/issue-version-gate.cjs');

// Build a PreToolUse stdin payload for a Bash command.
function input(command) {
  return JSON.stringify({ tool_name: 'Bash', tool_input: { command } });
}

// Default deps: real live gate, no override, no file reads, no worktree root.
function deps(over = {}) {
  return Object.assign(
    {
      liveVersionGate,
      readBodyFile: () => {
        throw new Error('no file read expected');
      },
      worktreeRoot: '/tmp/wt',
      overrideImpl: { checkOverride: () => ({ override: false }), writeReceipt: () => {} },
    },
    over
  );
}

// A body that PASSES the version gate (bug label + valid version).
const GOOD_BODY = '### GSD Version\n1.18.0';
// A body that FAILS the version gate (bug label, no usable version).
const BAD_BODY = '### GSD Version\n_No response_';

test('non-issue command (gh repo view) → allow (no-op)', () => {
  const d = runIssueGate(input('gh repo view octocat/hello'), deps());
  assert.strictEqual(d.permissionDecision, 'allow');
});

test('git status → allow (no-op)', () => {
  const d = runIssueGate(input('git status'), deps());
  assert.strictEqual(d.permissionDecision, 'allow');
});

test('gh issue create with a valid version body → allow', () => {
  const d = runIssueGate(
    input(`gh issue create --label bug --title x --body "${GOOD_BODY}"`),
    deps()
  );
  assert.strictEqual(d.permissionDecision, 'allow');
});

test('gh issue create with a version-failing body → DENY (ENF-01)', () => {
  const d = runIssueGate(
    input(`gh issue create --label bug --title x --body "${BAD_BODY}"`),
    deps()
  );
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /version/i);
});

test('unlabeled gh issue create with GSD Version heading but no version → DENY', () => {
  const d = runIssueGate(
    input(`gh issue create --title x --body "${BAD_BODY}"`),
    deps()
  );
  assert.strictEqual(d.permissionDecision, 'deny');
});

test('gh api POST issues synonym with a failing body → DENY (ENF-15)', () => {
  // gh api -X POST repos/o/r/issues -f title=x -f body=<bad>
  const cmd = `gh api -X POST repos/o/r/issues -f title=x -f body='${BAD_BODY}' -f labels=bug`;
  const d = runIssueGate(input(cmd), deps());
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
});

test('gh api POST issues synonym with a passing body → allow (ENF-15)', () => {
  const cmd = `gh api -X POST repos/o/r/issues -f title=x -f body='${GOOD_BODY}'`;
  const d = runIssueGate(input(cmd), deps());
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

test('curl POST issues synonym with a failing body → DENY (ENF-15)', () => {
  const cmd = `curl -X POST https://api.github.com/repos/o/r/issues -d '{"title":"x","body":"### GSD Version\\n_No response_"}'`;
  const d = runIssueGate(input(cmd), deps());
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
});

test('body sourced from --body-file <path> on disk is read and evaluated → DENY on bad body', () => {
  const d = runIssueGate(
    input('gh issue create --label bug --title x --body-file /tmp/body.md'),
    deps({ readBodyFile: (p) => (p === '/tmp/body.md' ? BAD_BODY : null) })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
});

test('--body-file - (stdin) body the hook cannot observe → FAIL CLOSED deny (HARD-04)', () => {
  const d = runIssueGate(
    input('gh issue create --label bug --title x --body-file -'),
    deps()
  );
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /stdin|cannot|fail.closed/i);
});

test('unparseable command (unbalanced quote) → FAIL CLOSED deny (HARD-04)', () => {
  const d = runIssueGate(input('gh issue create --title "unterminated'), deps());
  assert.strictEqual(d.permissionDecision, 'deny');
});

test('malformed stdin JSON → FAIL CLOSED deny (HARD-01)', () => {
  const d = runIssueGate('{not json', deps());
  assert.strictEqual(d.permissionDecision, 'deny');
});

test('a thrown live gate (e.g. reshaped script) → FAIL CLOSED deny (HARD-01)', () => {
  const d = runIssueGate(
    input(`gh issue create --label bug --title x --body "${BAD_BODY}"`),
    deps({
      liveVersionGate: {
        evaluateVersionGate() {
          throw new Error('live script reshaped');
        },
      },
    })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
});

test('a thrown live gate WITH a logged override → allow (HARD-03)', () => {
  const d = runIssueGate(
    input(`gh issue create --label bug --title x --body "${BAD_BODY}"`),
    deps({
      liveVersionGate: {
        evaluateVersionGate() {
          throw new Error('live script reshaped');
        },
      },
      overrideImpl: {
        checkOverride: () => ({ override: true, reason: 'transient gh outage' }),
        writeReceipt: () => '/tmp/wt/.gsd-contrib/override-receipts.log',
      },
    })
  );
  assert.strictEqual(d.permissionDecision, 'allow');
});
