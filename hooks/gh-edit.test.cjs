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

// PORTABILITY (2026-07-30): these LIVE requires were hardcoded to `/home/dave/repos/gsd-core/...`,
// so this file only ever loaded on one machine — CI surfaced it as `Cannot find module` on the
// first run. Resolve the checkout the way the rest of the toolkit does (GSD_CORE_ROOT, then
// ~/repos/gsd-core, then ~/gsd-core) and SKIP the whole LIVE-backed file when none is reachable.
// Skipping is the honest option: fabricating a stand-in for a LIVE gsd-core script would make this
// suite assert against a fiction (the same reason fault-injection.test.cjs refuses to fake a
// sentinel layout). CI's `compat` job sets GSD_CORE_ROOT so these RUN for real there.
const os = require('node:os');
const path = require('node:path');
const { resolveGsdCoreRoot } = require('./lib/resolve.cjs');

function liveGsdCoreRootOrNull() {
  const candidates = [
    process.env.GSD_CORE_ROOT,
    path.join(os.homedir(), 'repos', 'gsd-core'),
    path.join(os.homedir(), 'gsd-core'),
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      return resolveGsdCoreRoot(c);
    } catch (_) {
      /* try the next candidate */
    }
  }
  return null;
}

const LIVE_ROOT = liveGsdCoreRootOrNull();
if (!LIVE_ROOT) {
  test('LIVE-backed suite (gh-edit.test.cjs)', {
    skip:
      'no gsd-core checkout reachable via GSD_CORE_ROOT / ~/repos/gsd-core / ~/gsd-core — ' +
      'LIVE-backed cases SKIPPED (never fabricate a stand-in for a LIVE script)',
  }, () => {});
  return;
}
const liveScript = (rel) => require(path.join(LIVE_ROOT, rel));

const liveVersionGate = liveScript('scripts/issue-version-gate.cjs');
const liveTemplate = liveScript('scripts/pr-template-policy.cjs');

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

// ---- CF-07 (← CR-01): chain-aware edit gate ------------------------------------------
// The edit gate must decide gate/no-gate from ANY governed segment (hasGovernedSegment
// over EDIT_ACTIONS), not the FIRST actionable segment. Pre-CF-07 these RED cases collapse
// the chain to `issue-create` / `commit` and ALLOW; after the fix the edit gate is REACHED,
// while non-governed chains and body-less (label-only) edits still ALLOW.

test('CF-07: gh issue create && gh pr edit (non-template body) → REACHES pr-edit gate → DENY (ENF-04)', () => {
  const d = runEditGate(
    input('gh issue create --title t --body b && gh pr edit 5 --body "just prose, no template"'),
    deps()
  );
  // pre-CF-07: collapses to `issue-create` (not an EDIT_ACTION) → allow. Post-CF-07: the
  // pr-edit segment is found and the LIVE pr-template-policy denies.
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
  assert.match(d.permissionDecisionReason, /template/i);
});

test('CF-07: git commit && gh issue edit (bad version body) → REACHES issue-edit gate → DENY (LIVE version-gate)', () => {
  const d = runEditGate(
    input(`git commit -m x && gh issue edit 7 --body "${BAD_ISSUE_BODY}"`),
    deps()
  );
  // pre-CF-07: collapses to `commit` → allow. Post-CF-07: the issue-edit segment is found
  // and the LIVE issue-version-gate denies.
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
  assert.match(d.permissionDecisionReason, /version/i);
});

test('CF-07 narrows-not-weakens: git status && ls → allow (no governed segment)', () => {
  const d = runEditGate(input('git status && ls'), deps());
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

test('CF-07 narrows-not-weakens: git commit && gh pr edit 5 --add-label x (label-only, no body) → allow (H-B)', () => {
  const d = runEditGate(input('git commit -m x && gh pr edit 5 --add-label x'), deps());
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

// --- CF-06 (D-04): out-of-tree null-root ROB-01 discriminator ------------------------------
// These cases exercise gh-edit's null-root branch (runEditGate :295-300). To reach it the deps
// MUST omit worktreeRoot AND the live policy deps, so resolveRootForCommand(cmd, process.cwd())
// actually runs. The suite runs from the toolkit repo cwd — no gsd-core sentinel above it →
// resolveRootForCommand returns null → the null-root branch is the decision point. The denying
// override ensures a fail-closed throw surfaces as a real deny (not an override allow).
// D-01: the three open-gsd/gsd-core-targeting cases are the RED baseline — today gh-edit.cjs:298
// unconditionally ALLOWs them; after Task 2 they DENY. The fork / non-targeting cases assert the
// must-still-allow passthrough (narrows-not-weakens) — they ALLOW before AND after.

test('CF-06 RED: out-of-tree gh api PATCH targeting open-gsd/gsd-core issue → DENY (fail-closed)', () => {
  const d = runEditGate(
    input('gh api -X PATCH repos/open-gsd/gsd-core/issues/1 -f body=hi'),
    editDenyingOverride
  );
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
});

test('CF-06 RED: out-of-tree gh issue edit -R open-gsd/gsd-core → DENY (fail-closed)', () => {
  const d = runEditGate(
    input('gh issue edit -R open-gsd/gsd-core 7 --body "prose"'),
    editDenyingOverride
  );
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
});

test('CF-06 RED: out-of-tree gh pr edit -R open-gsd/gsd-core → DENY (fail-closed)', () => {
  const d = runEditGate(
    input('gh pr edit -R open-gsd/gsd-core 9 --body "prose"'),
    editDenyingOverride
  );
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
});

// Must-still-allow (D-01 narrows-not-weakens): an out-of-tree edit targeting a FORK or a
// non-targeting edit still passes through — ALLOW before AND after the fix.
test('CF-06: out-of-tree gh api PATCH targeting a fork repo → ALLOW (passthrough preserved)', () => {
  const d = runEditGate(
    input('gh api -X PATCH repos/dave/gsd-core-fork/issues/1 -f body=hi'),
    editDenyingOverride
  );
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

test('CF-06: out-of-tree gh issue edit -R dave/gsd-core-fork → ALLOW (passthrough preserved)', () => {
  const d = runEditGate(
    input('gh issue edit -R dave/gsd-core-fork 7 --body "prose"'),
    editDenyingOverride
  );
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

test('CF-06: out-of-tree non-targeting label-only edit (no -R) → ALLOW (passthrough preserved)', () => {
  const d = runEditGate(
    input('gh issue edit 7 --add-label triage'),
    editDenyingOverride
  );
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});
