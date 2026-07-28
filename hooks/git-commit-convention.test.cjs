'use strict';

/**
 * node:test for hooks/git-commit-convention.cjs (ENF-16 / HARD-01 / HARD-04).
 *
 * Drives the gate through the injectable runCommitConventionGate(input, deps) seam so the
 * worktree root, the override check, and the message-file reader can be injected — no
 * filesystem walk, no real gsd-core checkout required for the unit suite. Passing
 * worktreeRoot short-circuits the gsd-core root resolution so no filesystem walk occurs.
 */

const test = require('node:test');
const assert = require('node:assert');

const { runCommitConventionGate, firstLine } = require('./git-commit-convention.cjs');

// Build a PreToolUse stdin payload for a Bash command.
function input(command) {
  return JSON.stringify({ tool_name: 'Bash', tool_input: { command } });
}

// Default deps: hermetic — injected worktree root (no fs walk), no override, no file reads.
function deps(over = {}) {
  return Object.assign(
    {
      worktreeRoot: '/tmp/wt',
      overrideImpl: { checkOverride: () => ({ override: false }), writeReceipt: () => {} },
      readMessageFile: () => {
        throw new Error('no file read expected');
      },
    },
    over
  );
}

// ---- ALLOW: correctly-shaped recognized-type prefixes ----

test('git commit -m "fix(core): handle null" → ALLOW (type + (scope))', () => {
  const d = runCommitConventionGate(input('git commit -m "fix(core): handle null"'), deps());
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

test('git commit -m "feat!: breaking change" → ALLOW (type + !)', () => {
  const d = runCommitConventionGate(input('git commit -m "feat!: breaking change"'), deps());
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

test('git commit -m "fix: tidy" → ALLOW (type + :)', () => {
  const d = runCommitConventionGate(input('git commit -m "fix: tidy"'), deps());
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

test('git commit -m "docs: update" → ALLOW (correctly-shaped docs prefix)', () => {
  const d = runCommitConventionGate(input('git commit -m "docs: update"'), deps());
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

// ---- DENY: obviously-malformed prefix shapes ----

test('git commit -m "docs fix thing" → DENY (recognized type, no separator)', () => {
  const d = runCommitConventionGate(input('git commit -m "docs fix thing"'), deps());
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /prefix|convention|toolkit/i);
});

test('git commit -m "wip" → DENY (no recognized type at all)', () => {
  const d = runCommitConventionGate(input('git commit -m "wip"'), deps());
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /prefix|convention|toolkit/i);
});

test('git commit -m "update stuff" → DENY (no recognized type at all)', () => {
  const d = runCommitConventionGate(input('git commit -m "update stuff"'), deps());
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /prefix|convention|toolkit/i);
});

// ---- multi -m: the FIRST -m is the subject line ----

test('git commit -m "fix: x" -m "docs body" → ALLOW (first -m is the judged subject)', () => {
  const d = runCommitConventionGate(input('git commit -m "fix: x" -m "some body paragraph"'), deps());
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

test('git commit -m "wip" -m "fix: later" → DENY (first -m subject is malformed)', () => {
  const d = runCommitConventionGate(input('git commit -m "wip" -m "fix: later"'), deps());
  assert.strictEqual(d.permissionDecision, 'deny');
});

// ---- --message= inline form ----

test('git commit --message="feat: thing" → ALLOW', () => {
  const d = runCommitConventionGate(input('git commit --message="feat: thing"'), deps());
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

// ---- message-less commit (interactive editor) ----

test('git commit (no -m, no -F) → ALLOW (no asserted message to judge)', () => {
  const d = runCommitConventionGate(input('git commit'), deps());
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

test('git commit --amend (no message) → ALLOW (no asserted message)', () => {
  const d = runCommitConventionGate(input('git commit --amend'), deps());
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

// ---- -F <path>: read from disk and judge the first line ----

test('git commit -F /tmp/msg with a good prefix on disk → ALLOW', () => {
  const d = runCommitConventionGate(
    input('git commit -F /tmp/msg'),
    deps({ readMessageFile: (p) => (p === '/tmp/msg' ? 'fix: from a file\n\nbody' : null) })
  );
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

test('git commit -F /tmp/msg with a bad prefix on disk → DENY', () => {
  const d = runCommitConventionGate(
    input('git commit -F /tmp/msg'),
    deps({ readMessageFile: (p) => (p === '/tmp/msg' ? 'wip from a file' : null) })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
});

// ---- fail-closed paths (HARD-01 / HARD-04) ----

test('git commit -F - (stdin) the hook cannot observe → FAIL CLOSED deny (HARD-04)', () => {
  const d = runCommitConventionGate(input('git commit -F -'), deps());
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /stdin|cannot|fail.?closed|unparse/i);
});

test('git commit -m "unterminated (unbalanced quote) → FAIL CLOSED deny (HARD-04)', () => {
  const d = runCommitConventionGate(input('git commit -m "unterminated'), deps());
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /stdin|cannot|fail.?closed|unparse/i);
});

test('malformed stdin JSON → FAIL CLOSED deny (HARD-01)', () => {
  const d = runCommitConventionGate('{not json', deps());
  assert.strictEqual(d.permissionDecision, 'deny');
});

test('a thrown injected readMessageFile on the -F path → FAIL CLOSED deny (HARD-01)', () => {
  const d = runCommitConventionGate(
    input('git commit -F /tmp/msg'),
    deps({
      readMessageFile: () => {
        throw new Error('disk read blew up');
      },
    })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
});

test('fail-closed deny WITH a logged override → allow (HARD-03)', () => {
  const d = runCommitConventionGate(
    input('git commit -F -'),
    deps({
      overrideImpl: {
        checkOverride: () => ({ override: true, reason: 'known-good rebase fixup' }),
        writeReceipt: () => '/tmp/wt/.gsd-contrib/override-receipts.log',
      },
    })
  );
  assert.strictEqual(d.permissionDecision, 'allow');
});

// ---- non-commit actions pass through as a no-op allow ----

test('git status → ALLOW (no-op)', () => {
  const d = runCommitConventionGate(input('git status'), deps());
  assert.strictEqual(d.permissionDecision, 'allow');
});

test('git push origin HEAD → ALLOW (no-op)', () => {
  const d = runCommitConventionGate(input('git push origin HEAD'), deps());
  assert.strictEqual(d.permissionDecision, 'allow');
});

test('gh pr create … → ALLOW (no-op, not a commit)', () => {
  const d = runCommitConventionGate(input('gh pr create --title x --body y'), deps());
  assert.strictEqual(d.permissionDecision, 'allow');
});

// ── WR-03: firstLine subject boundary = first REAL newline ONLY ──────────────────
// A double-quoted `-m "a\nb"` token is collapsed by tokenize to `anb` (backslash consumed),
// so there is no boundary at all and the whole collapsed token is the subject. A
// single-quoted `-m 'fix: a\nb'` token keeps the literal backslash-n — which is NOT a
// boundary either (only a real control-char newline is). Both forms are judged on the SAME
// model, eliminating the quoting-dependent divergence WR-03 flagged.
test('WR-03: firstLine treats a literal backslash-n as part of the subject (no truncation)', () => {
  // single-quoted body: the token carries a literal two-char \n.
  assert.strictEqual(firstLine('fix: a\\nb'), 'fix: a\\nb');
  assert.strictEqual(firstLine('a\\nb'), 'a\\nb');
});

test('WR-03: firstLine splits only on a REAL newline (control char)', () => {
  assert.strictEqual(firstLine('x\ny'), 'x');
  assert.strictEqual(firstLine('feat: subject\n\nbody text'), 'feat: subject');
});

test('WR-03: both quoting forms of an equivalently-typed subject yield the same verdict', () => {
  // double-quoted "feat: a\nb" → tokenize collapses to `feat: anb` (one token, no boundary).
  const dq = runCommitConventionGate(input('git commit -m "feat: a\\nb"'), deps());
  // single-quoted 'feat: a\nb' → literal backslash-n retained, still one subject, no boundary.
  const sq = runCommitConventionGate(input("git commit -m 'feat: a\\nb'"), deps());
  assert.strictEqual(dq.permissionDecision, sq.permissionDecision, 'quoting must not change the verdict');
  assert.strictEqual(dq.permissionDecision, 'allow', 'a valid feat: prefix passes regardless of quoting');
});

// ---- RES-01 (D-07 uniformity): action-first short-circuit fires BEFORE any resolve/deps ----
// A non-commit command must ALLOW without the runGate callback ever reaching
// `Object.assign({}, deps)` (which precedes resolveGsdCoreRoot). A throwing getter on a
// resolver-dependent dep key proves the ordering: the short-circuit returns allow() before the
// Object.assign that would trigger it. On pre-27-03 code that getter throws inside runGate →
// deny, so this is a genuine regression.
test('git-commit-convention: a non-governed command (git status) ALLOWs without reaching the resolver (RES-01 uniformity)', () => {
  let resolverTouched = false;
  const trap = {};
  Object.defineProperty(trap, 'readMessageFile', {
    enumerable: true,
    get() {
      resolverTouched = true;
      throw new Error('resolver/deps must not be reached for a non-governed command');
    },
  });
  const d = runCommitConventionGate(input('git status'), trap);
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
  assert.strictEqual(resolverTouched, false, 'short-circuit must fire before any resolve/deps access');
});

// ---- Regression: types gsd-core's own canon documents and CI accepts ----
//
// ENF-16 replicated a bare conventional-commit vocabulary that omitted the two
// enhancement spellings gsd-core actually uses, so it denied commits the repo's
// own CONTRIBUTING.md gives as verbatim examples:
//
//   CONTRIBUTING.md:250-251 -> `enhance(#1549): add PR-title validator`
//   scripts/release-notes/conventional-title.cjs FEATURE_RE = /^feat(?:ure)?.../
//
// Found 2026-07-27 while responding to review on gsd-core PR #2685: the gate
// blocked `enhance(#2572): ...`, and `origin/next` carries 11 `enhance(` commits
// against 0 `enh(`. Falling back to `feat(` is NOT a safe workaround -- the
// changelog classifier buckets feat* as Feature, so it silently misfiles an
// enhancement.

test('git commit -m "enhance(#1549): add PR-title validator" -> ALLOW (CONTRIBUTING example)', () => {
  const d = runCommitConventionGate(
    input('git commit -m "enhance(#1549): add PR-title validator"'),
    deps()
  );
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

test('git commit -m "feature(#39): milestone-prefixed phase IDs" -> ALLOW (FEATURE_RE accepts feat(ure)?)', () => {
  const d = runCommitConventionGate(
    input('git commit -m "feature(#39): milestone-prefixed phase IDs"'),
    deps()
  );
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

test('git commit -m "enhance: no scope" -> ALLOW (scope is optional in the shape rule)', () => {
  const d = runCommitConventionGate(input('git commit -m "enhance: no scope"'), deps());
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

test('an unrecognized type is still DENIED -- widening must not become anything-goes', () => {
  const d = runCommitConventionGate(input('git commit -m "banana(#1): nope"'), deps());
  assert.strictEqual(d.permissionDecision, 'deny', 'banana is not a recognized type');
});

test('a recognized type without the separator is still DENIED (the original shape rule)', () => {
  const d = runCommitConventionGate(input('git commit -m "enhance the parser"'), deps());
  assert.strictEqual(d.permissionDecision, 'deny', 'no `:` after the type -> obvious violation');
});
