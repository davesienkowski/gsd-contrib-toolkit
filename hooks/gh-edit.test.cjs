'use strict';

/**
 * node:test for hooks/gh-edit.cjs (ENF-04 broken-edit→REST hint + ENF-15 PATCH synonym
 * + HARD-01/04 fail-closed).
 *
 * Driven via the injectable runEditGate(input, deps) seam: the LIVE version-gate and
 * template-policy exports + override are injected so the unit suite is hermetic.
 */

const test = require('node:test');
const assert = require('node:assert');

const { runEditGate } = require('./gh-edit.cjs');

const liveVersionGate = require('/home/dave/repos/gsd-core/scripts/issue-version-gate.cjs');
const liveTemplate = require('/home/dave/repos/gsd-core/scripts/pr-template-policy.cjs');

function input(command) {
  return JSON.stringify({ tool_name: 'Bash', tool_input: { command } });
}

function deps(over = {}) {
  return Object.assign(
    {
      liveVersionGate,
      liveTemplate,
      changedFiles: ['src/index.cts'],
      authorAssociation: 'OWNER',
      readBodyFile: () => {
        throw new Error('no file read expected');
      },
      worktreeRoot: '/tmp/wt',
      overrideImpl: { checkOverride: () => ({ override: false }), writeReceipt: () => {} },
    },
    over
  );
}

const BAD_ISSUE_BODY = '### GSD Version\n_No response_';
const GOOD_PR_BODY = [
  '## Fix PR',
  '## Linked Issue',
  'Fixes #12',
  '## What was broken',
  'x',
  '## What this fix does',
  'x',
  '## Testing',
  'x',
  '## Checklist',
  '- [x]',
].join('\n');

test('non-edit command (gh issue create) → allow (handled by other gates, not here)', () => {
  const d = runEditGate(input('gh issue create --title x'), deps());
  assert.strictEqual(d.permissionDecision, 'allow');
});

test('label-only issue edit (no body rewrite) → allow (avoid false-positive, H-B)', () => {
  const d = runEditGate(input('gh issue edit 7 --add-label triage'), deps());
  assert.strictEqual(d.permissionDecision, 'allow');
});

test('assignee-only pr edit → allow', () => {
  const d = runEditGate(input('gh pr edit 9 --add-assignee octocat'), deps());
  assert.strictEqual(d.permissionDecision, 'allow');
});

test('issue edit rewriting body to a version-failing body → DENY with REST hint (ENF-04)', () => {
  const d = runEditGate(
    input(`gh issue edit 7 --body "${BAD_ISSUE_BODY}"`),
    deps()
  );
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /version/i);
  // ENF-04: point to the correct REST/edit form.
  assert.match(d.permissionDecisionReason, /PATCH|api|REST|repos\//i);
});

test('issue edit with a valid version body → allow', () => {
  const d = runEditGate(
    input('gh issue edit 7 --body "### GSD Version\\n1.18.0"'),
    deps()
  );
  // backslash-n inside double quotes: argv eats the backslash → "### GSD Versionn1.18.0".
  // The gate normalizes; but to avoid encoding ambiguity assert via a real-newline body:
  const d2 = runEditGate(
    input('gh issue edit 7 --label bug --body "### GSD Version\n1.18.0"'),
    deps()
  );
  assert.strictEqual(d2.permissionDecision, 'allow', d2.permissionDecisionReason);
});

test('pr edit rewriting body to a NON-template body → DENY with REST hint (ENF-04)', () => {
  const d = runEditGate(
    input('gh pr edit 9 --body "just prose, no template"'),
    deps()
  );
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /template/i);
  assert.match(d.permissionDecisionReason, /PATCH|api|REST|repos\//i);
});

test('pr edit rewriting body to a VALID template body → allow', () => {
  const d = runEditGate(input(`gh pr edit 9 --body "${GOOD_PR_BODY}"`), deps());
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

test('gh api PATCH issues/N synonym with a bad body → DENY (ENF-15)', () => {
  const cmd = `gh api -X PATCH repos/o/r/issues/7 -f body='${BAD_ISSUE_BODY}' -f labels=bug`;
  const d = runEditGate(input(cmd), deps());
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
  assert.match(d.permissionDecisionReason, /PATCH|api|REST|repos\//i);
});

test('gh api PATCH pulls/N synonym with a non-template body → DENY (ENF-15)', () => {
  const cmd = `gh api -X PATCH repos/o/r/pulls/9 -f body='no template'`;
  const d = runEditGate(input(cmd), deps());
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
});

test('--body-file - (stdin) edit → FAIL CLOSED deny (HARD-04)', () => {
  const d = runEditGate(input('gh issue edit 7 --body-file -'), deps());
  assert.strictEqual(d.permissionDecision, 'deny');
});

test('unparseable edit → FAIL CLOSED deny (HARD-04)', () => {
  const d = runEditGate(input('gh issue edit 7 --body "unterminated'), deps());
  assert.strictEqual(d.permissionDecision, 'deny');
});

test('a thrown live gate during a body edit → FAIL CLOSED deny (HARD-01)', () => {
  const d = runEditGate(
    input(`gh issue edit 7 --body "${BAD_ISSUE_BODY}"`),
    deps({
      liveVersionGate: {
        evaluateVersionGate() {
          throw new Error('reshaped');
        },
      },
    })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
});

test('a thrown live gate WITH a logged override → allow (HARD-03)', () => {
  const d = runEditGate(
    input(`gh issue edit 7 --body "${BAD_ISSUE_BODY}"`),
    deps({
      liveVersionGate: {
        evaluateVersionGate() {
          throw new Error('reshaped');
        },
      },
      overrideImpl: {
        checkOverride: () => ({ override: true, reason: 'transient' }),
        writeReceipt: () => '/tmp/wt/.gsd-contrib/override-receipts.log',
      },
    })
  );
  assert.strictEqual(d.permissionDecision, 'allow');
});

// --- RES-01: action-first short-circuit fires BEFORE the LIVE-script resolve ---
// Override-only deps (NO live scripts injected) so the real resolve+requireLiveScript path
// runs; the worktreeRoot points at a temp dir lacking scripts/*.cjs.
const editDenyingOverride = {
  overrideImpl: { checkOverride: () => ({ override: false }), writeReceipt: () => {} },
};

// D-09(a): a NON-governed command against the missing-script root must ALLOW — proving the
// classify-first guard short-circuits before requireLiveScript is ever reached.
test('RES-01: non-governed command (git status) with a MISSING live-script root → ALLOW (short-circuit before resolve)', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-noscript-nongov-'));
  const d = runEditGate(
    input('git status'),
    Object.assign({ worktreeRoot: root }, editDenyingOverride)
  );
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

// D-09(b), HARD-02: the SAME missing-script root with a GOVERNED body edit STILL DENIES —
// requireLiveScript throws → fail closed. Opposite verdict, same root, decided purely by
// whether the action is a governed EDIT_ACTION.
test('RES-01/HARD-02: governed issue-edit (body rewrite) with a MISSING live-script root → DENY', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-noscript-gov-'));
  const d = runEditGate(
    input(`gh issue edit 7 --body "${BAD_ISSUE_BODY}"`),
    Object.assign({ worktreeRoot: root }, editDenyingOverride)
  );
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
});

// A benign label-only governed edit stays governed (not short-circuited) and its bodyless
// allow is unchanged — proving the guard does NOT over-allow governed edits (it only fires
// for NON-governed commands; a label-only edit is still issue-edit → governed → resolves →
// gate() allows a bodyless edit). Default deps() injects the live scripts so resolve is a no-op.
test('RES-01: label-only governed edit still ALLOWs via the unchanged gate() bodyless path', () => {
  const d = runEditGate(input('gh issue edit 7 --add-label triage'), deps());
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});
