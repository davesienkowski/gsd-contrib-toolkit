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

// ═══════════════════════════════════════════════════════════════════════════════
// ENF-22 (quick task 260731-ih5) — the graded `ask` on a merge that will commit.
//
// Origin: SEED-enf16-misses-git-merge-implicit-commit. A CLEANLY-mergeable
// `git merge origin/next --no-edit` commits ITSELF, so no `git commit` is ever issued
// and ENF-16 above is never consulted — git's generated subject
// `Merge remote-tracking branch 'origin/next' into fix/…` landed on a gsd-core PR
// branch live on 2026-07-31. The inversion the seed records: a CONFLICTED merge is
// accidentally safe (it forces an explicit `git commit -F <file>`, which ENF-16 DOES
// gate); only the clean merge slips.
//
// Severity is `ask`, not `deny`, and that is CTK-ADR-0005 §Decision.2 doing the work:
// a merge that FAST-FORWARDS creates no commit at all, and this gate is pure — it runs
// no git queries — so it cannot tell which case it is looking at. Every fast-forwardable
// merge would be a false positive by construction, which makes deny inadmissible.
// ═══════════════════════════════════════════════════════════════════════════════

// ---- ASK: the predictive class (a merge that will commit, no asserted subject) ----

test('ENF-22: git merge origin/next --no-edit → ASK naming --no-commit and --no-ff (the seed’s command)', () => {
  const d = runCommitConventionGate(input('git merge origin/next --no-edit'), deps());
  assert.strictEqual(d.permissionDecision, 'ask', d.permissionDecisionReason);
  assert.match(d.permissionDecisionReason, /--no-commit/);
  assert.match(d.permissionDecisionReason, /--no-ff/);
  assert.match(d.permissionDecisionReason, /ENF-22/);
});

test('ENF-22: git merge origin/next (bare) → ASK', () => {
  const d = runCommitConventionGate(input('git merge origin/next'), deps());
  assert.strictEqual(d.permissionDecision, 'ask', d.permissionDecisionReason);
});

test('ENF-22: git merge origin/next --no-ff → ASK (a forced merge commit is the strongest case)', () => {
  const d = runCommitConventionGate(input('git merge origin/next --no-ff'), deps());
  assert.strictEqual(d.permissionDecision, 'ask', d.permissionDecisionReason);
});

test('ENF-22: git merge -n origin/next → ASK (-n is --no-stat on merge, NEVER an exemption)', () => {
  // On `git commit`, -n means --no-verify; on `git merge` it means --no-stat. Reading it
  // as a --no-commit abbreviation would silently disarm the gate.
  const d = runCommitConventionGate(input('git merge -n origin/next'), deps());
  assert.strictEqual(d.permissionDecision, 'ask', d.permissionDecisionReason);
});

test('ENF-22: git merge --no-commit --commit origin/next → ASK (git resolves the pair last-wins)', () => {
  const d = runCommitConventionGate(input('git merge --no-commit --commit origin/next'), deps());
  assert.strictEqual(d.permissionDecision, 'ask', d.permissionDecisionReason);
});

// ---- ALLOW: the D5 exempt forms (each provably cannot create an unasserted commit) ----

test('ENF-22: git merge origin/next --no-commit --no-ff → ALLOW (the remediated form itself)', () => {
  const d = runCommitConventionGate(input('git merge origin/next --no-commit --no-ff'), deps());
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

test('ENF-22: git merge --squash origin/next → ALLOW (git implies --no-commit)', () => {
  const d = runCommitConventionGate(input('git merge --squash origin/next'), deps());
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

test('ENF-22: git merge --ff-only origin/next → ALLOW (fast-forwards or errors; never a merge commit)', () => {
  const d = runCommitConventionGate(input('git merge --ff-only origin/next'), deps());
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

test('ENF-22: git merge --abort / --quit / --continue → ALLOW (operation-control, no ref)', () => {
  for (const cmd of ['git merge --abort', 'git merge --quit', 'git merge --continue']) {
    const d = runCommitConventionGate(input(cmd), deps());
    assert.strictEqual(d.permissionDecision, 'allow', `${cmd}: ${d.permissionDecisionReason}`);
  }
});

test('ENF-22: git merge with no ref → ALLOW (nothing to name in a remediation)', () => {
  const d = runCommitConventionGate(input('git merge'), deps());
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

// ---- The CONCLUSIVE class: an AUTHOR-asserted subject routes to the ENF-16 check ----
// This is NOT the rejected Fix Option 1: an author-supplied -m is asserted in the command
// exactly as it is for `git commit`. Nothing here reads or judges a git-GENERATED subject.

test('ENF-22: git merge -m "chore(#2570): merge origin/next" → ALLOW (asserted, well-formed)', () => {
  const d = runCommitConventionGate(
    input('git merge -m "chore(#2570): merge origin/next" origin/next'),
    deps()
  );
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

test('ENF-22: git merge -m "merged next" → DENY (asserted, malformed — conclusive, so deny is admissible)', () => {
  const d = runCommitConventionGate(input('git merge -m "merged next" origin/next'), deps());
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
  assert.match(d.permissionDecisionReason, /prefix|convention|toolkit/i);
});

// ---- T-ih5-04: no pre-existing ENF-16 DENY may be weakened to an ask (D6 ordering) ----

test('ENF-22 T-ih5-04: git merge x && git commit -m "wip" → DENY (the commit path runs FIRST and wins)', () => {
  const d = runCommitConventionGate(input('git merge x && git commit -m "wip"'), deps());
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
  assert.match(d.permissionDecisionReason, /prefix|convention|toolkit/i);
});

test('ENF-22: a merge masked behind a later push is still seen (hasGovernedSegment, not classifyAction)', () => {
  // classifyAction collapses this chain to the legacy `push`, so a first-result trigger
  // would miss the merge entirely.
  const d = runCommitConventionGate(input('git merge origin/next && git push origin HEAD'), deps());
  assert.strictEqual(d.permissionDecision, 'ask', d.permissionDecisionReason);
});

// ---- Bypass-form parity: the merge path inherits ENF-16's CR-01/CR-03 coverage ----

test('ENF-22: the four bypass forms of a bare merge each ASK (parity with commit)', () => {
  for (const cmd of [
    'sudo git merge origin/next',
    '/usr/bin/git merge origin/next',
    'GIT_DIR=/x git merge origin/next',
    'git -C /tmp merge origin/next',
  ]) {
    const d = runCommitConventionGate(input(cmd), deps());
    assert.strictEqual(d.permissionDecision, 'ask', `${cmd}: ${d.permissionDecisionReason}`);
  }
});
