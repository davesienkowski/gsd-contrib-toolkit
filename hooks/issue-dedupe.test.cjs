'use strict';

/**
 * node:test for hooks/issue-dedupe.cjs (ENF-11 / HARD-01 / HARD-04).
 *
 * Drives the gate through the injectable runDedupeGate(input, deps) seam so the LIVE
 * scoreCandidates export and the open-issue fetch can be injected — no real `gh`, no
 * network, no gsd-core checkout required for the unit suite. The LIVE scorer stub is the
 * REAL scripts/issue-dedupe.cjs module (we exercise the real similarity math, only the
 * issue FETCH is mocked).
 */

const test = require('node:test');
const assert = require('node:assert');

const { runDedupeGate } = require('./issue-dedupe.cjs');

// The REAL live scorer — we never reimplement the similarity logic; we call it.
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
  test('LIVE-backed suite (issue-dedupe.test.cjs)', {
    skip:
      'no gsd-core checkout reachable via GSD_CORE_ROOT / ~/repos/gsd-core / ~/gsd-core — ' +
      'LIVE-backed cases SKIPPED (never fabricate a stand-in for a LIVE script)',
  }, () => {});
  return;
}
const liveScript = (rel) => require(path.join(LIVE_ROOT, rel));

const liveScorer = liveScript('scripts/issue-dedupe.cjs');

// Build a PreToolUse stdin payload for a Bash command.
function input(command) {
  return JSON.stringify({ tool_name: 'Bash', tool_input: { command } });
}

// Default deps: real live scorer, an injected fetch, no override.
function deps(over = {}) {
  return Object.assign(
    {
      liveScorer,
      fetchOpenIssues: () => [],
      worktreeRoot: '/tmp/wt',
      overrideImpl: { checkOverride: () => ({ override: false }), writeReceipt: () => {} },
    },
    over
  );
}

// A set of open issues that includes a near-duplicate of the new title below.
const OPEN_ISSUES = [
  { number: 12, title: 'race condition in two-window mode' },
  { number: 34, title: 'docs typo in README' },
];

test('non-issue-create command (gh repo view) → allow (no-op)', () => {
  const d = runDedupeGate(input('gh repo view octocat/hello'), deps());
  assert.strictEqual(d.permissionDecision, 'allow');
});

test('git status → allow (no-op)', () => {
  const d = runDedupeGate(input('git status'), deps());
  assert.strictEqual(d.permissionDecision, 'allow');
});

test('novel title with no candidate >= threshold → allow', () => {
  const d = runDedupeGate(
    input('gh issue create --title "completely unrelated new subject area" --body x'),
    deps({ fetchOpenIssues: () => OPEN_ISSUES })
  );
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

test('high-similarity open issue → DENY naming the duplicate #N (ENF-11)', () => {
  const d = runDedupeGate(
    input('gh issue create --title "race condition in two-window mode" --body x'),
    deps({ fetchOpenIssues: () => OPEN_ISSUES })
  );
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
  assert.match(d.permissionDecisionReason, /#12/);
});

test('gh api POST issues synonym near-duplicate → DENY (ENF-15 inherited)', () => {
  const cmd =
    "gh api -X POST repos/o/r/issues -f title='race condition in two-window mode' -f body=x";
  const d = runDedupeGate(input(cmd), deps({ fetchOpenIssues: () => OPEN_ISSUES }));
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
  assert.match(d.permissionDecisionReason, /#12/);
});

test('issue-list fetch failing (unauth gh / network) → FAIL CLOSED deny (HARD-01)', () => {
  const d = runDedupeGate(
    input('gh issue create --title "race condition in two-window mode" --body x'),
    deps({
      fetchOpenIssues: () => {
        throw new Error('gh: not authenticated');
      },
    })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /fetch|authenticated|fail.closed|dedupe/i);
});

test('a fetch failure WITH a logged override → allow (HARD-03)', () => {
  const d = runDedupeGate(
    input('gh issue create --title "race condition in two-window mode" --body x'),
    deps({
      fetchOpenIssues: () => {
        throw new Error('gh: not authenticated');
      },
      overrideImpl: {
        checkOverride: () => ({ override: true, reason: 'transient gh outage' }),
        writeReceipt: () => '/tmp/wt/.gsd-contrib/override-receipts.log',
      },
    })
  );
  assert.strictEqual(d.permissionDecision, 'allow');
});

test('issue with no resolvable title → allow (nothing to dedupe against)', () => {
  // gh issue create with no --title: interactive form; the hook cannot score, allow
  // (this is not a fail-closed case — there is no asserted title to be a duplicate of).
  const d = runDedupeGate(
    input('gh issue create --body x'),
    deps({ fetchOpenIssues: () => OPEN_ISSUES })
  );
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

test('unparseable command (unbalanced quote) → FAIL CLOSED deny (HARD-04)', () => {
  const d = runDedupeGate(input('gh issue create --title "unterminated'), deps());
  assert.strictEqual(d.permissionDecision, 'deny');
});

test('malformed stdin JSON → FAIL CLOSED deny (HARD-01)', () => {
  const d = runDedupeGate('{not json', deps());
  assert.strictEqual(d.permissionDecision, 'deny');
});

test('a thrown live scorer (reshaped script) → FAIL CLOSED deny (HARD-01)', () => {
  const d = runDedupeGate(
    input('gh issue create --title "race condition in two-window mode" --body x'),
    deps({
      fetchOpenIssues: () => OPEN_ISSUES,
      liveScorer: {
        scoreCandidates() {
          throw new Error('live script reshaped');
        },
      },
    })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
});

// --- RES-01: action-first short-circuit fires BEFORE the LIVE-script resolve ---
const denyingOverride = {
  overrideImpl: { checkOverride: () => ({ override: false }), writeReceipt: () => {} },
};

// D-09(b), HARD-02: a GOVERNED issue-create whose LIVE dedupe scorer is genuinely
// missing (worktreeRoot present but lacking scripts/issue-dedupe.cjs, no liveScorer
// injected) STILL DENIES — requireLiveScript throws → fail closed. This is the
// direction the short-circuit must NOT weaken.
test('RES-01/HARD-02: governed issue-create with a MISSING live scorer → DENY', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dedupe-noscript-gov-'));
  const d = runDedupeGate(
    input('gh issue create --title "some new subject" --body x'),
    Object.assign({ worktreeRoot: root }, denyingOverride)
  );
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
});

// D-09(a): a NON-governed command against the SAME missing-scorer root must ALLOW —
// proving the classify-first guard short-circuits before requireLiveScript is reached.
test('RES-01: non-governed (git status) with a MISSING live scorer → ALLOW (short-circuit before resolve)', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dedupe-noscript-nongov-'));
  const d = runDedupeGate(
    input('git status'),
    Object.assign({ worktreeRoot: root }, denyingOverride)
  );
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// Citation-overlap ADVISORY (quick task 260729-p3f)
//
// A second, toolkit-owned duplicate signal at a LOWER severity than the title-dice deny:
// two issues that cite the same RARE code paths are plausibly about the same thing even
// when their titles share no words. It ships as `ask`, never `deny`, because its measured
// recall is 2/9 at ~0.048 prompts per filing (sweep: scratchpad/dedupe-threshold-sweep.cjs).
//
// The invariants these tests fence:
//   1. a title-dice DENY is NEVER downgraded to an ask
//   2. below the measured threshold → allow (no prompt)
//   3. shared COMMON paths → allow (the false-positive guard; a rule that fires on
//      bin/install.js fires on everything)
//   4. the citation computation fails OPEN — a throw falls through to the dice verdict
//   5. a FETCH failure still fails CLOSED (HARD-01 untouched)
// ─────────────────────────────────────────────────────────────────────────────────────────

// A corpus where the two paths cited by #2774 are cited by NOBODY else — so, counting the
// unfiled issue itself, their document frequency is exactly 2 (RARE_DF_MAX).
const RARE_CORPUS = [
  {
    number: 2774,
    title: 'stale worktree slips past the freshness check',
    body: 'Repro touches `hooks/freshness.cjs` and also src/capability-hooks.cts.',
  },
  { number: 34, title: 'docs typo in README', body: 'see docs/contributing.md' },
  { number: 55, title: 'flaky windows runner', body: 'no code paths cited here' },
];

// A corpus where THREE open issues all cite the same two paths — document frequency 3 (+1
// for the unfiled issue = 4), comfortably above RARE_DF_MAX. These are the "false-positive
// engines" the measurement identified: paths so widely cited they carry no signal.
const COMMON_CORPUS = [
  {
    number: 700,
    title: 'installer leaves a dangling symlink',
    body: 'in bin/install.js and docs/setup.md',
  },
  { number: 701, title: 'add a --dry-run flag', body: 'bin/install.js plus docs/setup.md' },
  { number: 702, title: 'installer needs a changelog note', body: 'bin/install.js, docs/setup.md' },
];

test('ADVISORY: 2 shared RARE paths + no dice hit → ASK naming the #N and the paths', () => {
  const cmd =
    'gh issue create --title "worktree freshness regression after a rebase" ' +
    '--body "Investigated hooks/freshness.cjs and src/capability-hooks.cts."';
  const d = runDedupeGate(input(cmd), deps({ fetchOpenIssues: () => RARE_CORPUS }));
  assert.strictEqual(d.permissionDecision, 'ask', d.permissionDecisionReason);
  assert.match(d.permissionDecisionReason, /#2774/, 'must name the candidate issue');
  assert.match(d.permissionDecisionReason, /hooks\/freshness\.cjs/, 'must name the shared paths');
  assert.match(d.permissionDecisionReason, /src\/capability-hooks\.cts/);
});

test('ADVISORY: only 1 shared rare path → ALLOW (below the measured MIN_SHARED_RARE)', () => {
  const cmd =
    'gh issue create --title "worktree freshness regression after a rebase" ' +
    '--body "Investigated hooks/freshness.cjs only."';
  const d = runDedupeGate(input(cmd), deps({ fetchOpenIssues: () => RARE_CORPUS }));
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

test('ADVISORY false-positive guard: 2 shared COMMON paths (df > 2) → ALLOW, no prompt', () => {
  // The whole point of the rare-path gate. Two issues both citing bin/install.js and
  // docs/setup.md are not evidence of anything — those paths are cited by everyone.
  const cmd =
    'gh issue create --title "support a custom install prefix" ' +
    '--body "Would change bin/install.js and document it in docs/setup.md."';
  const d = runDedupeGate(input(cmd), deps({ fetchOpenIssues: () => COMMON_CORPUS }));
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

test('ADVISORY: a title-dice DENY is NEVER downgraded to an ask (deny wins)', () => {
  // Same title as #2774 AND two shared rare paths: both signals fire. The deny must win.
  const cmd =
    'gh issue create --title "stale worktree slips past the freshness check" ' +
    '--body "Repro touches hooks/freshness.cjs and src/capability-hooks.cts."';
  const d = runDedupeGate(input(cmd), deps({ fetchOpenIssues: () => RARE_CORPUS }));
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
  assert.match(d.permissionDecisionReason, /#2774/);
  assert.match(d.permissionDecisionReason, /DUPLICATE/);
});

test('ADVISORY: no --body at all → ALLOW, no throw (not a fail-closed case)', () => {
  const d = runDedupeGate(
    input('gh issue create --title "worktree freshness regression after a rebase"'),
    deps({ fetchOpenIssues: () => RARE_CORPUS })
  );
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

test('ADVISORY: a body citing no code paths at all → ALLOW', () => {
  const cmd =
    'gh issue create --title "worktree freshness regression after a rebase" ' +
    '--body "It just feels slow, no specifics."';
  const d = runDedupeGate(input(cmd), deps({ fetchOpenIssues: () => RARE_CORPUS }));
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

test('ADVISORY: --body-file is read, and its citations count', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dedupe-body-')), 'body.md');
  fs.writeFileSync(file, 'Investigated hooks/freshness.cjs and src/capability-hooks.cts.\n');
  const d = runDedupeGate(
    input(
      'gh issue create --title "worktree freshness regression after a rebase" --body-file ' + file
    ),
    deps({ fetchOpenIssues: () => RARE_CORPUS })
  );
  assert.strictEqual(d.permissionDecision, 'ask', d.permissionDecisionReason);
  assert.match(d.permissionDecisionReason, /#2774/);
});

test('ADVISORY: an UNREADABLE --body-file → ALLOW (no advisory), NOT a fail-closed deny', () => {
  const d = runDedupeGate(
    input(
      'gh issue create --title "worktree freshness regression after a rebase" ' +
        '--body-file /nonexistent/definitely/not/here.md'
    ),
    deps({ fetchOpenIssues: () => RARE_CORPUS })
  );
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

test('ADVISORY: the gh-api synonym route also reaches the advisory (ENF-15 inherited)', () => {
  const cmd =
    'gh api -X POST repos/o/r/issues ' +
    "-f title='worktree freshness regression after a rebase' " +
    "-f body='Investigated hooks/freshness.cjs and src/capability-hooks.cts.'";
  const d = runDedupeGate(input(cmd), deps({ fetchOpenIssues: () => RARE_CORPUS }));
  assert.strictEqual(d.permissionDecision, 'ask', d.permissionDecisionReason);
  assert.match(d.permissionDecisionReason, /#2774/);
});

// ---- C2: the citation computation FAILS OPEN ----

const throwingExtractor = {
  extractCitedPaths() {
    throw new Error('path extraction exploded');
  },
};

test('C2: a THROWING path extractor falls through to the dice verdict → ALLOW (does NOT deny)', () => {
  const cmd =
    'gh issue create --title "worktree freshness regression after a rebase" ' +
    '--body "Investigated hooks/freshness.cjs and src/capability-hooks.cts."';
  const d = runDedupeGate(
    input(cmd),
    deps(Object.assign({ fetchOpenIssues: () => RARE_CORPUS }, throwingExtractor))
  );
  assert.strictEqual(
    d.permissionDecision,
    'allow',
    'an advisory that can fail CLOSED is a whole-suite hazard for a 2/9 signal'
  );
});

test('C2: a THROWING path extractor still preserves the dice DENY (fails open, not blind)', () => {
  const cmd =
    'gh issue create --title "stale worktree slips past the freshness check" --body "x"';
  const d = runDedupeGate(
    input(cmd),
    deps(Object.assign({ fetchOpenIssues: () => RARE_CORPUS }, throwingExtractor))
  );
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
  assert.match(d.permissionDecisionReason, /#2774/);
});

test('HARD-01 UNCHANGED: a fetch failure still DENIES even now that ask exists', () => {
  // The advisory fails open; the FETCH does not. A dedupe we could not run is still a deny.
  const cmd =
    'gh issue create --title "worktree freshness regression after a rebase" ' +
    '--body "Investigated hooks/freshness.cjs and src/capability-hooks.cts."';
  const d = runDedupeGate(
    input(cmd),
    deps({
      fetchOpenIssues: () => {
        throw new Error('gh: not authenticated');
      },
    })
  );
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
  assert.match(d.permissionDecisionReason, /authenticated|fail.closed/i);
});

test('ADVISORY: candidates with no body at all are tolerated (legacy fetch shape)', () => {
  // OPEN_ISSUES carries {number,title} only — the advisory must not throw on a missing body.
  const cmd =
    'gh issue create --title "completely unrelated new subject area" ' +
    '--body "cites hooks/freshness.cjs and src/capability-hooks.cts"';
  const d = runDedupeGate(input(cmd), deps({ fetchOpenIssues: () => OPEN_ISSUES }));
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

// ---- the rare/df arithmetic, unit-level ----

const { extractCitedPaths, computeDocFrequency, findCitationOverlap } = require('./issue-dedupe.cjs');

test('extractCitedPaths pulls governed code paths and strips trailing punctuation', () => {
  const paths = extractCitedPaths(
    'See hooks/freshness.cjs, src/capability-hooks.cts. Also docs/adr/ADR-1244.md) and prose.'
  );
  assert.ok(paths.has('hooks/freshness.cjs'));
  assert.ok(paths.has('src/capability-hooks.cts'));
  assert.ok(paths.has('docs/adr/ADR-1244.md'), 'trailing ")" must be stripped');
  assert.strictEqual(paths.size, 3);
});

test('extractCitedPaths returns an empty set for a missing/non-string body', () => {
  assert.strictEqual(extractCitedPaths(undefined).size, 0);
  assert.strictEqual(extractCitedPaths(null).size, 0);
  assert.strictEqual(extractCitedPaths(42).size, 0);
  assert.strictEqual(extractCitedPaths('').size, 0);
});

test('computeDocFrequency counts the number of CITING issues per path', () => {
  const df = computeDocFrequency(COMMON_CORPUS, extractCitedPaths);
  assert.strictEqual(df.get('bin/install.js'), 3);
  assert.strictEqual(df.get('docs/setup.md'), 3);
  assert.strictEqual(df.get('nope/none.js'), undefined);
});

test('findCitationOverlap counts the UNFILED issue in df (matching the measured pair semantics)', () => {
  // A path cited by the candidate AND one other open issue has df 2; adding the unfiled
  // issue makes 3 — above RARE_DF_MAX, so it must NOT count as rare. This is the exact
  // construction the sweep measured (both members of a pair are inside the df corpus).
  const corpus = [
    { number: 10, title: 'a', body: 'hooks/one.cjs and hooks/two.cjs' },
    { number: 11, title: 'b', body: 'hooks/one.cjs and hooks/two.cjs' },
  ];
  const hit = findCitationOverlap('hooks/one.cjs plus hooks/two.cjs', corpus, {
    extractCitedPaths,
  });
  assert.strictEqual(hit, null, 'df 2 (+1 for the unfiled issue) = 3 → not rare');
});

test('findCitationOverlap fires at exactly 2 shared rare paths, and reports them sorted', () => {
  const corpus = [{ number: 10, title: 'a', body: 'hooks/two.cjs then hooks/one.cjs' }];
  const hit = findCitationOverlap('hooks/one.cjs plus hooks/two.cjs', corpus, {
    extractCitedPaths,
  });
  assert.ok(hit, 'df 1 (+1 unfiled) = 2 → rare; 2 shared → fires');
  assert.strictEqual(hit.number, 10);
  assert.deepStrictEqual(hit.sharedRare, ['hooks/one.cjs', 'hooks/two.cjs']);
});
