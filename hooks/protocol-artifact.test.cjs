'use strict';

/**
 * node:test for hooks/protocol-artifact.cjs (ENF-19 protocol-artifact gate, CTK-ADR-0004,
 * HARD-01 fail-closed, HARD-04 robust-parse, ENF-15 synonym coverage).
 *
 * Driven via the injectable runProtocolArtifactGate(stdinString, deps) seam: the branch, the
 * artifact filesystem, the branch diff, the gsd-test run and HEAD's commit time are all
 * INJECTED, so the unit suite is hermetic (no git, no filesystem, no gsd-test state dir).
 *
 * Coverage:
 *   - non-governed / read-only commands            → ALLOW (no-op)
 *   - non-contribution branch, detached HEAD       → ALLOW (family not armed)
 *   - missing artifact                             → DENY, naming the file and its shape
 *   - malformed artifact JSON                      → fail-closed DENY (HARD-01)
 *   - each predicate: equals / in / every / nonEmpty
 *   - `every` over a non-array                     → DENY (not a vacuous pass)
 *   - `every` names the failing index
 *   - waiver on a docs-only diff                   → ALLOW
 *   - waiver contradicted by a code diff           → DENY (the honesty half)
 *   - gsd-test: green / red / no-cells / stale / schema bump
 *   - unparseable command                          → fail-closed DENY (HARD-04)
 *   - ENF-15 unclassifiable mutating synonym       → fail-closed DENY
 *   - a reader throw                               → fail-closed DENY, override-escapable (HARD-03)
 *
 * ENF-20 T4 additions (the three formerly-ADVISORY steps + the scaffold precondition):
 *   - STEP ZERO / P0 / P0b: absent → DENY (+ scaffold), properly filled → ALLOW
 *   - a FILLER artifact (filenames with no observed detail; an ADR id with no quote) → DENY
 *   - a freshly SCAFFOLDED artifact → DENY for EVERY gate entry, including P1/P2/P3/P3-matrix
 *     (the anti-inversion proof: a scaffold may never satisfy the gate that wrote it)
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const nodePath = require('node:path');

const { scaffold, hasUnfilledPlaceholders } = require('./lib/scaffold.cjs');

const {
  runProtocolArtifactGate,
  checkAssertion,
  checkWaiver,
  isNonEmpty,
  readPath,
  slugify,
  writeScaffoldLive,
  GATES,
  CODE_PATH_RE,
  P_STEP_FAMILIES,
  P0_CANON,
} = require('./protocol-artifact.cjs');

function input(command) {
  return JSON.stringify({ tool_name: 'Bash', tool_input: { command } });
}

// ── fixtures ────────────────────────────────────────────────────────────────

const P1_OK = {
  schema: 1,
  mechanism: 'resolveModelInternal falls through to the budget tier when the catalog key is absent',
  reproduced: true,
  source_files: ['src/core.cts:412'],
  evidence: [{ command: 'node -e "…"', observed: 'budget\n' }],
};

const P2_OK = {
  schema: 1,
  adrs_consulted: [{ id: 'ADR-0174', quote: 'the observability seam stays dormant until…' }],
  laws_applied: ['hyrums-law'],
  findings: [{ summary: 'unused export', disposition: 'filed', proof: '#2701' }],
};

const P3_OK = {
  schema: 1,
  test_file: 'tests/bug-1234-slug.test.cjs',
  red: { command: 'node --test tests/bug-1234-slug.test.cjs', observed_failure: 'not ok 1 …' },
  green: { command: 'node --test tests/bug-1234-slug.test.cjs', observed_pass: 'ok 1 …' },
};

const P3M_OK = { schema: 1, run_id: 'fc40141f-1628-4907-b6d9-50637a1e7227' };

/** STEP ZERO: the P-step todos actually created, in the tracker actually used. */
const SZ_OK = {
  schema: 1,
  tracker: 'TodoWrite',
  todos: [
    { step: 'P-1', text: 'Create this checklist as tool-tracked todos' },
    { step: 'P0', text: 'Read CONTRIBUTING + issue template + PR template + ADRs + CONTEXT.md' },
    { step: 'P0b', text: 'ADR/CONTEXT awareness sweep (POLICY-03)' },
    { step: 'P1', text: 'trust-but-verify; reproduce the mechanism live on src/*.cts' },
    { step: 'P2', text: 'skills-from-the-artificer over the diff' },
    { step: 'P2b', text: 'Policy conformance vs the ADRs (POLICY-01)' },
    { step: 'P3a', text: 'Worktree off origin/next; hooks rewired; build:lib' },
    { step: 'P3b', text: 'Regression test written FIRST and watched FAIL' },
    { step: 'P3c', text: 'Implement the fix; tests GREEN' },
    { step: 'P3d', text: 'Full relevant suites + lint:ci + the QA matrix' },
    { step: 'P4a', text: 'Issue body: GSD Version + user-impact + template shape' },
    { step: 'P4b', text: 'version-gate on the EXACT body' },
    { step: 'P4c', text: 'gh issue create; LEAVE needs-triage + bot tags' },
    { step: 'P5a', text: 'Branch fix/<issue#>-slug off next' },
    { step: 'P5b', text: 'pr-template-policy on the EXACT body' },
    { step: 'P5c', text: 'gh pr create; typed title; area label; changeset' },
    { step: 'P6', text: 'Read real check-runs on the head SHA' },
  ],
};

/** P0: what was read, with an OBSERVED detail per item (never a bare filename list). */
const P0_OK = {
  schema: 1,
  read: [
    { path: 'CONTRIBUTING.md',
      observed: '"every PR needs a changeset unless it carries `no-changelog`"' },
    { path: '.github/ISSUE_TEMPLATE/bug_report.yml',
      observed: 'requires a `### GSD Version` heading; `_No response_` fails the version-gate' },
    { path: '.github/PULL_REQUEST_TEMPLATE/fix.md',
      observed: 'requires `## Root cause` and `## Verification` headings' },
    { path: 'docs/adr/0174-observability-seam.md',
      observed: '"the observability seam stays dormant until explicitly enabled"' },
    { path: 'sdk/CONTEXT.md',
      observed: 'predicate: query handlers stay positional-arg only' },
  ],
};

/** P0b: the POLICY-03 awareness sweep, with the quoted clause + how the diff stands. */
const P0B_OK = {
  schema: 1,
  sweep: {
    command: "grep -rn 'observability' docs/adr/ sdk/CONTEXT.md",
    observed: 'docs/adr/0174-observability-seam.md:41: … \nsdk/CONTEXT.md:12: …',
  },
  adrs: [
    {
      id: 'ADR-0174',
      quote: 'the observability seam stays dormant until explicitly enabled',
      conforms_how: 'conforms: the diff never constructs a recorder, so the seam stays dormant',
    },
  ],
  context_predicates: [
    { source: 'sdk/CONTEXT.md', predicate: 'query handlers stay positional-arg only' },
  ],
};

/** The armed branch's artifact set, complete and filled. Overridable per test via `files`. */
const DEFAULT_FILES = Object.freeze({
  '.gsd/contrib/fix-1234-slug/P1-repro.json': P1_OK,
  '.gsd/contrib/fix-1234-slug/P2-review.json': P2_OK,
  '.gsd/contrib/fix-1234-slug/P3-red.json': P3_OK,
  '.gsd/contrib/fix-1234-slug/P3-matrix.json': P3M_OK,
  '.gsd/contrib/fix-1234-slug/STEP-ZERO-todos.json': SZ_OK,
  '.gsd/contrib/fix-1234-slug/P0-canon.json': P0_OK,
  '.gsd/contrib/fix-1234-slug/P0b-sweep.json': P0B_OK,
});

const MATRIX_GREEN = {
  schema_version: 1,
  summary: {
    outcome: 'passed',
    per_os: {
      'linux-node22': { passed: 25685, failed: 0, total: 25685 },
      'linux-node24': { passed: 24919, failed: 0, total: 24919 },
    },
    total_failures: 0,
    generated_at: '2026-07-27T19:40:53.993Z',
  },
  failures: [],
};

/** Default deps: armed contribution branch, every artifact present and well-formed. */
function deps(over = {}) {
  const files = Object.assign({}, DEFAULT_FILES, over.files || {});
  const base = {
    worktreeRoot: '/tmp/wt',
    readBranch: () => 'fix/1234-slug',
    artifactExists: (rel) => Object.prototype.hasOwnProperty.call(files, rel),
    readArtifact: (rel) => files[rel],
    readArtifactText: (rel) => JSON.stringify(files[rel]),
    readChangedPaths: () => ['src/core.cts', 'tests/bug-1234-slug.test.cjs'],
    readMatrixRun: () => MATRIX_GREEN,
    readHeadCommittedAt: () => '2026-07-27T19:00:00.000Z',
    overrideImpl: { checkOverride: () => ({ override: false }), writeReceipt: () => {} },
  };
  const merged = Object.assign(base, over);
  delete merged.files;
  return merged;
}

// ── no-op / arming ──────────────────────────────────────────────────────────

test('read-only command → allow (not governed)', () => {
  const d = runProtocolArtifactGate(input('git status --porcelain'), deps());
  assert.strictEqual(d.permissionDecision, 'allow');
});

test('gh issue list → allow (not a create)', () => {
  const d = runProtocolArtifactGate(input('gh issue list --repo open-gsd/gsd-core'), deps());
  assert.strictEqual(d.permissionDecision, 'allow');
});

test('governed action on `next` → allow (family not armed)', () => {
  const d = runProtocolArtifactGate(input('git push origin next'), deps({ readBranch: () => 'next' }));
  assert.strictEqual(d.permissionDecision, 'allow');
});

test('governed action on a detached HEAD → allow (no branch to key on)', () => {
  const d = runProtocolArtifactGate(input('git push origin HEAD'), deps({ readBranch: () => null }));
  assert.strictEqual(d.permissionDecision, 'allow');
});

test('fully-armed branch with every artifact present → allow', () => {
  for (const cmd of [
    'gh issue create --repo open-gsd/gsd-core --title t --body b',
    'gh pr create --repo open-gsd/gsd-core --title t --body b',
    'git push origin fix/1234-slug',
  ]) {
    const d = runProtocolArtifactGate(input(cmd), deps());
    assert.strictEqual(d.permissionDecision, 'allow', cmd + ' → ' + d.permissionDecisionReason);
  }
});

// ── missing / malformed artifacts ───────────────────────────────────────────

test('gh issue create with no P1 artifact → deny naming the file and its shape', () => {
  const d = runProtocolArtifactGate(
    input('gh issue create --repo open-gsd/gsd-core --title t --body b'),
    deps({ files: { '.gsd/contrib/fix-1234-slug/P1-repro.json': undefined } , artifactExists: () => false })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /ENF-19 P1/);
  assert.match(d.permissionDecisionReason, /P1-repro\.json/);
  assert.match(d.permissionDecisionReason, /mechanism/);
});

test('malformed artifact JSON → fail-closed deny (HARD-01)', () => {
  const d = runProtocolArtifactGate(
    input('gh issue create --repo open-gsd/gsd-core --title t --body b'),
    deps({
      readArtifact: () => {
        throw new Error('`P1-repro.json` is not valid JSON');
      },
    })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /not valid JSON/);
});

// ── predicates ──────────────────────────────────────────────────────────────

test('P1 reproduced:false → deny with WITHDRAW guidance (equals)', () => {
  const bad = Object.assign({}, P1_OK, { reproduced: false });
  const d = runProtocolArtifactGate(
    input('gh issue create --repo open-gsd/gsd-core --title t --body b'),
    deps({ files: { '.gsd/contrib/fix-1234-slug/P1-repro.json': bad } })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /WITHDRAW/);
});

test('P1 evidence entry missing `observed` → deny (every) and name the index', () => {
  const bad = Object.assign({}, P1_OK, {
    evidence: [{ command: 'a', observed: 'x' }, { command: 'b' }],
  });
  const d = runProtocolArtifactGate(
    input('gh issue create --repo open-gsd/gsd-core --title t --body b'),
    deps({ files: { '.gsd/contrib/fix-1234-slug/P1-repro.json': bad } })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /evidence\[1\]/);
});

test('P1 whitespace-only mechanism → deny (nonEmpty rejects filler)', () => {
  const bad = Object.assign({}, P1_OK, { mechanism: '   ' });
  const d = runProtocolArtifactGate(
    input('gh issue create --repo open-gsd/gsd-core --title t --body b'),
    deps({ files: { '.gsd/contrib/fix-1234-slug/P1-repro.json': bad } })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /causal mechanism/);
});

test('P2 finding with an off-menu disposition → deny (in)', () => {
  const bad = Object.assign({}, P2_OK, {
    findings: [{ summary: 's', disposition: 'mentioned-in-pr-body', proof: 'x' }],
  });
  const d = runProtocolArtifactGate(
    input('gh pr create --repo open-gsd/gsd-core --title t --body b'),
    deps({ files: { '.gsd/contrib/fix-1234-slug/P2-review.json': bad } })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /reason to FILE/);
});

test('P2 not-a-defect without proof → deny', () => {
  const bad = Object.assign({}, P2_OK, {
    findings: [{ summary: 's', disposition: 'not-a-defect' }],
  });
  const d = runProtocolArtifactGate(
    input('gh pr create --repo open-gsd/gsd-core --title t --body b'),
    deps({ files: { '.gsd/contrib/fix-1234-slug/P2-review.json': bad } })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /requires the proof/);
});

test('P2 ADR id with no quote → deny (POLICY-01 wants the clause)', () => {
  const bad = Object.assign({}, P2_OK, { adrs_consulted: [{ id: 'ADR-0174' }] });
  const d = runProtocolArtifactGate(
    input('gh pr create --repo open-gsd/gsd-core --title t --body b'),
    deps({ files: { '.gsd/contrib/fix-1234-slug/P2-review.json': bad } })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /quote/);
});

test('`every` over a non-array is a shape failure, not a vacuous pass', () => {
  const a = { path: 'xs', every: { path: 'k', nonEmpty: true }, else: 'boom' };
  assert.match(String(checkAssertion({ xs: 'not-a-list' }, a)), /not a list/);
  assert.strictEqual(checkAssertion({ xs: [] }, a), null); // empty list IS vacuously fine
});

test('an assertion with no predicate throws (contract bug, never a silent pass)', () => {
  assert.throws(() => checkAssertion({ a: 1 }, { path: 'a', else: 'x' }), /no predicate/);
});

// ── waivers ─────────────────────────────────────────────────────────────────

test('P3 waiver on a docs-only diff → allow', () => {
  const waived = { schema: 1, not_applicable: { reason: 'docs-only: no behavioural change' } };
  const d = runProtocolArtifactGate(
    input('git push origin docs/1234-slug'),
    deps({
      readBranch: () => 'docs/1234-slug',
      readChangedPaths: () => ['docs/adr/1234-thing.md', 'README.md'],
      files: { '.gsd/contrib/docs-1234-slug/P3-red.json': waived },
      artifactExists: (rel) => rel === '.gsd/contrib/docs-1234-slug/P3-red.json',
      readArtifact: () => waived,
    })
  );
  assert.strictEqual(d.permissionDecision, 'allow');
});

test('P3 waiver contradicted by a code diff → deny, naming the offending paths', () => {
  const waived = { schema: 1, not_applicable: { reason: 'docs-only, honest' } };
  const d = runProtocolArtifactGate(
    input('git push origin fix/1234-slug'),
    deps({
      readChangedPaths: () => ['docs/x.md', 'src/core.cts', 'hooks/thing.cjs'],
      files: { '.gsd/contrib/fix-1234-slug/P3-red.json': waived },
    })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /changes code/);
  assert.match(d.permissionDecisionReason, /src\/core\.cts/);
});

test('P3-matrix waiver on a docs-only diff skips the matrix entirely', () => {
  const waived = { schema: 1, not_applicable: { reason: 'docs-only' } };
  let matrixRead = false;
  const d = runProtocolArtifactGate(
    input('gh pr create --repo open-gsd/gsd-core --title t --body b'),
    deps({
      readChangedPaths: () => ['docs/adr/x.md'],
      files: { '.gsd/contrib/fix-1234-slug/P3-matrix.json': waived },
      readMatrixRun: () => {
        matrixRead = true;
        return MATRIX_GREEN;
      },
    })
  );
  assert.strictEqual(d.permissionDecision, 'allow');
  assert.strictEqual(matrixRead, false, 'a waived P3-matrix must not read a gsd-test run');
});

test('checkWaiver treats hooks/ and scripts/ as code', () => {
  assert.ok(CODE_PATH_RE.test('hooks/x.cjs'));
  assert.ok(CODE_PATH_RE.test('scripts/y.cjs'));
  assert.ok(CODE_PATH_RE.test('test/z.cjs'));
  assert.ok(!CODE_PATH_RE.test('docs/adr/a.md'));
  assert.strictEqual(checkWaiver({ id: 'P3' }, ['docs/a.md']), null);
  assert.match(String(checkWaiver({ id: 'P3' }, ['src/a.cts'])), /changes code/);
});

// ── gsd-test live verification ──────────────────────────────────────────────

test('P3-matrix with a red matrix run → deny', () => {
  const red = JSON.parse(JSON.stringify(MATRIX_GREEN));
  red.summary.outcome = 'failed';
  red.summary.total_failures = 3;
  const d = runProtocolArtifactGate(
    input('gh pr create --repo open-gsd/gsd-core --title t --body b'),
    deps({ readMatrixRun: () => red })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /not a note for the PR body/);
});

test('P3-matrix with a non-green cell → deny naming the cell', () => {
  const partial = JSON.parse(JSON.stringify(MATRIX_GREEN));
  partial.summary.per_os['linux-node24'].failed = 2;
  const d = runProtocolArtifactGate(
    input('gh pr create --repo open-gsd/gsd-core --title t --body b'),
    deps({ readMatrixRun: () => partial })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /linux-node24/);
});

test('P3-matrix with no per-cell results → deny (the matrix did not fan out)', () => {
  const empty = JSON.parse(JSON.stringify(MATRIX_GREEN));
  empty.summary.per_os = {};
  const d = runProtocolArtifactGate(
    input('gh pr create --repo open-gsd/gsd-core --title t --body b'),
    deps({ readMatrixRun: () => empty })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /did not fan out/);
});

test('P3-matrix run older than HEAD → deny as stale', () => {
  const d = runProtocolArtifactGate(
    input('gh pr create --repo open-gsd/gsd-core --title t --body b'),
    deps({ readHeadCommittedAt: () => '2026-07-28T10:00:00.000Z' })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /predates the current HEAD/);
});

test('P3-matrix with an unknown runner schema → fail-closed deny blaming the TOOLING', () => {
  const bumped = JSON.parse(JSON.stringify(MATRIX_GREEN));
  bumped.schema_version = 2;
  const d = runProtocolArtifactGate(
    input('gh pr create --repo open-gsd/gsd-core --title t --body b'),
    deps({ readMatrixRun: () => bumped })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /runner changed shape/);
});

// ── fail-closed posture ─────────────────────────────────────────────────────

test('unparseable command → fail-closed deny (HARD-04)', () => {
  const d = runProtocolArtifactGate(input('gh issue create --body "unterminated'), deps());
  assert.strictEqual(d.permissionDecision, 'deny');
});

test('malformed stdin → fail-closed deny, never a guessed allow', () => {
  const d = runProtocolArtifactGate('{not json', deps());
  assert.strictEqual(d.permissionDecision, 'deny');
});

test('a branch-read throw → fail-closed deny (HARD-01)', () => {
  const d = runProtocolArtifactGate(
    input('git push origin fix/1234-slug'),
    deps({
      readBranch: () => {
        throw new Error('git exploded');
      },
    })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /git exploded/);
});

test('an unreadable branch diff must not silently validate a waiver', () => {
  const waived = { schema: 1, not_applicable: { reason: 'docs-only' } };
  const d = runProtocolArtifactGate(
    input('git push origin fix/1234-slug'),
    deps({
      files: { '.gsd/contrib/fix-1234-slug/P3-red.json': waived },
      readChangedPaths: () => {
        throw new Error('could not read the branch diff');
      },
    })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /could not read the branch diff/);
});

test('a fail-closed throw is override-escapable, and writes a receipt (HARD-03)', () => {
  let receipt = null;
  const d = runProtocolArtifactGate(
    input('git push origin fix/1234-slug'),
    deps({
      readBranch: () => {
        throw new Error('git exploded');
      },
      overrideImpl: {
        checkOverride: () => ({ override: true, reason: 'infra down' }),
        writeReceipt: (root, rec) => {
          receipt = rec;
        },
      },
    })
  );
  assert.strictEqual(d.permissionDecision, 'allow');
  assert.strictEqual(receipt.action, 'protocol-artifact');
});

test('an override never flips an intentional policy deny', () => {
  const bad = Object.assign({}, P1_OK, { reproduced: false });
  const d = runProtocolArtifactGate(
    input('gh issue create --repo open-gsd/gsd-core --title t --body b'),
    deps({
      files: { '.gsd/contrib/fix-1234-slug/P1-repro.json': bad },
      overrideImpl: {
        checkOverride: () => ({ override: true, reason: 'nope' }),
        writeReceipt: () => {},
      },
    })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
});

// ── helpers ─────────────────────────────────────────────────────────────────

test('slugify collapses a branch to one safe path segment', () => {
  assert.strictEqual(slugify('fix/1234-slug'), 'fix-1234-slug');
  assert.strictEqual(slugify('fix/../../etc/passwd'), 'fix-.._.._etc_passwd'.replace(/_/g, '-'));
});

test('isNonEmpty rejects filler shapes', () => {
  for (const v of [null, undefined, '', '   ', [], {}, false]) {
    assert.strictEqual(isNonEmpty(v), false, JSON.stringify(v) + ' should be empty');
  }
  for (const v of ['x', [1], { a: 1 }, true, 0]) {
    assert.strictEqual(isNonEmpty(v), true, JSON.stringify(v) + ' should be non-empty');
  }
});

test('readPath walks dotted paths and numeric indices, undefined on a gap', () => {
  assert.strictEqual(readPath({ a: { b: [{ c: 7 }] } }, 'a.b.0.c'), 7);
  assert.strictEqual(readPath({ a: 1 }, 'a.b.c'), undefined);
});

test('the contract groups pr-create cheapest-first (shape before the disk read)', () => {
  const pr = GATES.filter((g) => g.on === 'pr-create').map((g) => g.id);
  assert.deepStrictEqual(pr, ['P2', 'P3-matrix']);
});

// ════════════════════════════════════════════════════════════════════════════
// ENF-20 T4 — the three formerly-ADVISORY steps, and the scaffold precondition
// ════════════════════════════════════════════════════════════════════════════

const ISSUE = 'gh issue create --repo open-gsd/gsd-core --title t --body b';
const PR = 'gh pr create --repo open-gsd/gsd-core --title t --body b';
const PUSH = 'git push origin fix/1234-slug';

const CMD_FOR = Object.freeze({ 'issue-create': ISSUE, 'pr-create': PR, push: PUSH });

/** `on` normalised to a list (an entry may govern more than one action). */
function onList(g) {
  return Array.isArray(g.on) ? g.on : [g.on];
}

const REL = (file) => '.gsd/contrib/fix-1234-slug/' + file;

/** Deny/allow for one command with one artifact swapped out. */
function run(cmd, rel, doc, extra = {}) {
  return runProtocolArtifactGate(
    input(cmd),
    deps(Object.assign({ files: { [rel]: doc } }, extra))
  );
}

// ── the gate table now covers the whole contribution spine ──────────────────

test('the gate table covers STEP ZERO, P0 and P0b — no step is left purely advisory', () => {
  const ids = GATES.map((g) => g.id);
  for (const id of ['STEP-ZERO', 'P0', 'P0b', 'P1', 'P2', 'P3-matrix', 'P3']) {
    assert.ok(ids.indexOf(id) !== -1, 'GATES is missing ' + id);
  }
});

test('the full pr-create group stays ordered cheapest-first (live read LAST)', () => {
  const pr = GATES.filter((g) => onList(g).indexOf('pr-create') !== -1).map((g) => g.id);
  assert.deepStrictEqual(pr, ['STEP-ZERO', 'P0', 'P0b', 'P2', 'P3-matrix']);
  assert.strictEqual(pr[pr.length - 1], 'P3-matrix', 'the gsd-test disk read must run last');
});

test('the issue-create group reports P1 first (a finding that does not reproduce is WITHDRAWN, not planned)', () => {
  const ic = GATES.filter((g) => onList(g).indexOf('issue-create') !== -1).map((g) => g.id);
  assert.deepStrictEqual(ic, ['P1', 'STEP-ZERO', 'P0']);
});

// ── STEP ZERO ───────────────────────────────────────────────────────────────

test('STEP ZERO artifact absent → deny, and a skeleton is SCAFFOLDED at the named path', () => {
  const written = [];
  const d = runProtocolArtifactGate(
    input(PR),
    deps({
      artifactExists: (rel) => rel !== REL('STEP-ZERO-todos.json'),
      writeScaffold: (rel, spec) => {
        written.push({ rel, spec });
        return { written: true, path: '/tmp/wt/' + rel };
      },
    })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /ENF-19 STEP-ZERO/);
  assert.match(d.permissionDecisionReason, /STEP-ZERO-todos\.json/);
  assert.strictEqual(written.length, 1, 'the gate must scaffold the missing artifact');
  assert.strictEqual(written[0].rel, REL('STEP-ZERO-todos.json'));
  // The deny must NAME the scaffolded path and say the placeholders are the agent's job.
  assert.match(d.permissionDecisionReason, /skeleton/i);
  assert.match(d.permissionDecisionReason, /OBSERVED/);
});

test('STEP ZERO with a filled, complete todo enumeration → the entry passes', () => {
  const d = run(PR, REL('STEP-ZERO-todos.json'), SZ_OK);
  assert.strictEqual(d.permissionDecision, 'allow');
});

test('STEP ZERO missing whole P-step families → deny NAMING the missing ones', () => {
  const partial = Object.assign({}, SZ_OK, {
    todos: SZ_OK.todos.filter((t) => !/^P[45]/.test(t.step)),
  });
  const d = run(PR, REL('STEP-ZERO-todos.json'), partial);
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /P4/);
  assert.match(d.permissionDecisionReason, /P5/);
});

test('STEP ZERO with a count instead of an enumeration → deny (a number is not a list)', () => {
  const d = run(PR, REL('STEP-ZERO-todos.json'), { schema: 1, tracker: 'TodoWrite', todos: 17 });
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /not a list/);
});

test('STEP ZERO with step ids but no todo TEXT → deny naming the index (id-only is filler)', () => {
  const idsOnly = Object.assign({}, SZ_OK, {
    todos: SZ_OK.todos.map((t, i) => (i === 3 ? { step: t.step } : t)),
  });
  const d = run(PR, REL('STEP-ZERO-todos.json'), idsOnly);
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /todos\[3\]/);
});

test('STEP ZERO with no named tracker → deny (a printed checklist is not a tracker)', () => {
  const d = run(PR, REL('STEP-ZERO-todos.json'), Object.assign({}, SZ_OK, { tracker: '  ' }));
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /tracker/i);
});

test('STEP ZERO gates the issue-create act too, not just the PR', () => {
  const d = runProtocolArtifactGate(
    input(ISSUE),
    deps({ artifactExists: (rel) => rel !== REL('STEP-ZERO-todos.json') })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /ENF-19 STEP-ZERO/);
});

// ── P0 ──────────────────────────────────────────────────────────────────────

test('P0 absent → deny naming the file and the canon it wants', () => {
  const d = runProtocolArtifactGate(
    input(PR),
    deps({ artifactExists: (rel) => rel !== REL('P0-canon.json') })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /ENF-19 P0 /);
  assert.match(d.permissionDecisionReason, /P0-canon\.json/);
});

test('P0 fully recorded with an observed detail per item → the entry passes', () => {
  const d = run(PR, REL('P0-canon.json'), P0_OK);
  assert.strictEqual(d.permissionDecision, 'allow');
});

test('P0 FILLER: a bare filename list with no observed detail → deny', () => {
  const filler = {
    schema: 1,
    read: P0_OK.read.map((r) => ({ path: r.path })),
  };
  const d = run(PR, REL('P0-canon.json'), filler);
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /read\[0\]/);
  assert.match(d.permissionDecisionReason, /observed/);
});

test('P0 FILLER: filenames as bare strings (no per-item shape at all) → deny', () => {
  const filler = { schema: 1, read: P0_OK.read.map((r) => r.path) };
  const d = run(PR, REL('P0-canon.json'), filler);
  assert.strictEqual(d.permissionDecision, 'deny');
});

test('P0 that never opened CONTEXT.md → deny naming exactly what is missing', () => {
  const partial = { schema: 1, read: P0_OK.read.filter((r) => !/CONTEXT\.md/.test(r.path)) };
  const d = run(PR, REL('P0-canon.json'), partial);
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /CONTEXT\.md/);
});

test('P0 that never opened a governing ADR → deny', () => {
  const partial = { schema: 1, read: P0_OK.read.filter((r) => !/docs\/adr\//.test(r.path)) };
  const d = run(PR, REL('P0-canon.json'), partial);
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /docs\/adr/);
});

test('P0_CANON names the five canon surfaces the protocol requires at Phase 0', () => {
  assert.strictEqual(P0_CANON.length, 5);
  for (const r of P0_CANON) {
    assert.ok(r.name && r.re instanceof RegExp);
    assert.ok(!r.re.global, 'a /g regex carries lastIndex across .test() calls');
  }
});

// ── P0b ─────────────────────────────────────────────────────────────────────

test('P0b absent → deny naming the file', () => {
  const d = runProtocolArtifactGate(
    input(PR),
    deps({ artifactExists: (rel) => rel !== REL('P0b-sweep.json') })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /ENF-19 P0b/);
  assert.match(d.permissionDecisionReason, /P0b-sweep\.json/);
});

test('P0b fully recorded → the entry passes', () => {
  const d = run(PR, REL('P0b-sweep.json'), P0B_OK);
  assert.strictEqual(d.permissionDecision, 'allow');
});

test('P0b FILLER: an ADR id with no quote → deny (POLICY-01 wants the clause)', () => {
  const filler = Object.assign({}, P0B_OK, { adrs: [{ id: 'ADR-0174' }] });
  const d = run(PR, REL('P0b-sweep.json'), filler);
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /quote/);
  assert.match(d.permissionDecisionReason, /adrs\[0\]/);
});

test('P0b with a quote but no diff-vs-clause statement → deny', () => {
  const filler = Object.assign({}, P0B_OK, {
    adrs: [{ id: 'ADR-0174', quote: 'the seam stays dormant' }],
  });
  const d = run(PR, REL('P0b-sweep.json'), filler);
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /conforms_how/);
});

test('P0b with no sweep OUTPUT recorded → deny (a claimed sweep is not a sweep)', () => {
  const filler = Object.assign({}, P0B_OK, {
    sweep: { command: "grep -rn x docs/adr/", observed: '' },
  });
  const d = run(PR, REL('P0b-sweep.json'), filler);
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /PRINTED|printed/);
});

test('P0b accepts an EXPLICIT empty context_predicates list (an area may genuinely have none)', () => {
  const none = Object.assign({}, P0B_OK, { context_predicates: [] });
  const d = run(PR, REL('P0b-sweep.json'), none);
  assert.strictEqual(d.permissionDecision, 'allow');
});

test('P0b with context_predicates ABSENT → deny (an omitted key is a skip, [] is a finding)', () => {
  const missing = Object.assign({}, P0B_OK);
  delete missing.context_predicates;
  const d = run(PR, REL('P0b-sweep.json'), missing);
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /not a list/);
});

test('P0b does NOT gate issue-create or push (no diff to sweep against — left advisory there)', () => {
  for (const cmd of [ISSUE, PUSH]) {
    const d = runProtocolArtifactGate(
      input(cmd),
      deps({ artifactExists: (rel) => rel !== REL('P0b-sweep.json') })
    );
    assert.strictEqual(d.permissionDecision, 'allow', cmd + ' → ' + d.permissionDecisionReason);
  }
});

// ── THE ANTI-INVERSION PROOF ────────────────────────────────────────────────
// A scaffold that could satisfy its own gate would make skipping free, silent AND
// automatic (CTK-ADR-0004 §Consequences). Asserted for EVERY entry in the table,
// including the pre-existing P1/P2/P3/P3-matrix.

test('every gate entry carries a renderable scaffold spec', () => {
  for (const g of GATES) {
    assert.ok(g.scaffold, g.id + ' has no scaffold spec');
    const text = scaffold(g.scaffold);
    assert.ok(hasUnfilledPlaceholders(text), g.id + ' rendered a scaffold with no placeholder');
  }
});

test('a freshly SCAFFOLDED artifact DENIES its own gate — every entry, no exceptions', () => {
  for (const g of GATES) {
    const rel = REL(g.file);
    const text = scaffold(g.scaffold);
    for (const act of onList(g)) {
      const d = runProtocolArtifactGate(
        input(CMD_FOR[act]),
        deps({
          files: { [rel]: JSON.parse(text) },
          readArtifactText: (r) => (r === rel ? text : JSON.stringify(DEFAULT_FILES[r])),
        })
      );
      assert.strictEqual(
        d.permissionDecision,
        'deny',
        g.id + ' (' + act + ') ACCEPTED its own unfilled scaffold'
      );
      assert.match(d.permissionDecisionReason, new RegExp('ENF-19 ' + g.id.replace('-', '\\-')));
    }
  }
});

test('the unfilled-scaffold deny NAMES the fields still outstanding', () => {
  const rel = REL('P1-repro.json');
  const text = scaffold(GATES.filter((g) => g.id === 'P1')[0].scaffold);
  const d = runProtocolArtifactGate(
    input(ISSUE),
    deps({ files: { [rel]: JSON.parse(text) }, readArtifactText: () => text })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /mechanism/);
  assert.match(d.permissionDecisionReason, /placeholder/i);
});

test('ONE remaining placeholder in an otherwise complete artifact → deny', () => {
  const nearly = Object.assign({}, P1_OK, { mechanism: '<<<FILL:mechanism>>> — one sentence' });
  const d = run(ISSUE, REL('P1-repro.json'), nearly);
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /placeholder/i);
});

test('a placeholder in a field the gate does not even assert → still deny', () => {
  // `green` is advertised in P3's shape but asserted only for `red`. A half-filled scaffold
  // must not slip through on the strength of the asserted half.
  const half = Object.assign({}, P3_OK, {
    green: { command: '<<<FILL:green.command>>>', observed_pass: '<<<FILL:green.observed_pass>>>' },
  });
  const d = run(PUSH, REL('P3-red.json'), half);
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /placeholder/i);
});

test('an eroded placeholder delimiter is still an unmet obligation', () => {
  const eroded = Object.assign({}, P1_OK, { mechanism: '<FILL:mechanism' });
  const d = run(ISSUE, REL('P1-repro.json'), eroded);
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /placeholder/i);
});

test('with NO raw-text reader injected, the scan falls back to the re-serialised doc', () => {
  const nearly = Object.assign({}, P2_OK, {
    laws_applied: ['<<<FILL:laws_applied.0>>> — a law that fired'],
  });
  const d = run(PR, REL('P2-review.json'), nearly, { readArtifactText: undefined });
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /placeholder/i);
});

test('an override never flips an unfilled-scaffold deny either', () => {
  const rel = REL('P1-repro.json');
  const text = scaffold(GATES.filter((g) => g.id === 'P1')[0].scaffold);
  const d = runProtocolArtifactGate(
    input(ISSUE),
    deps({
      files: { [rel]: JSON.parse(text) },
      readArtifactText: () => text,
      overrideImpl: { checkOverride: () => ({ override: true, reason: 'nope' }), writeReceipt: () => {} },
    })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
});

test('a waiver cannot rescue an artifact that still carries placeholders', () => {
  const both = { schema: 1, not_applicable: { reason: 'docs-only' }, test_file: '<<<FILL:test_file>>>' };
  const d = run(PUSH, REL('P3-red.json'), both);
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /placeholder/i);
  // …and the deny must tell a genuinely-waiving branch how to proceed.
  assert.match(d.permissionDecisionReason, /not_applicable/);
});

// ── the `covers` predicate ──────────────────────────────────────────────────

test('covers: a non-array is a shape failure, not a vacuous pass', () => {
  const a = {
    path: 'xs',
    covers: { path: 'k', require: [{ name: 'A', re: /a/ }] },
    else: 'boom',
  };
  assert.match(String(checkAssertion({ xs: 7 }, a)), /not a list/);
  assert.match(String(checkAssertion({ xs: [] }, a)), /missing/);
  assert.strictEqual(checkAssertion({ xs: [{ k: 'a' }] }, a), null);
});

test('covers: works over a list of bare strings (no inner path)', () => {
  const a = { path: 'xs', covers: { require: [{ name: 'A', re: /^a/ }] }, else: 'boom' };
  assert.strictEqual(checkAssertion({ xs: ['abc'] }, a), null);
  assert.match(String(checkAssertion({ xs: ['zzz'] }, a)), /`A`/);
});

test('P_STEP_FAMILIES is exactly P0..P6 and matches sub-steps by prefix', () => {
  assert.deepStrictEqual(P_STEP_FAMILIES.map((f) => f.name), ['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6']);
  const p3 = P_STEP_FAMILIES.filter((f) => f.name === 'P3')[0];
  assert.ok(p3.re.test('P3b'), 'P3b must cover the P3 family');
  assert.ok(!p3.re.test('P4a'));
});

// ── the live scaffold writer ─────────────────────────────────────────────────

test('writeScaffoldLive writes the skeleton, then never clobbers it', () => {
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'enf20-'));
  try {
    const g = GATES.filter((x) => x.id === 'STEP-ZERO')[0];
    const rel = '.gsd/contrib/fix-1-x/' + g.file;
    const first = writeScaffoldLive(root, rel, g.scaffold);
    assert.strictEqual(first.written, true);

    const raw = fs.readFileSync(nodePath.join(root, rel), 'utf8');
    assert.ok(hasUnfilledPlaceholders(raw), 'the written skeleton must be unfilled');
    JSON.parse(raw); // the gate JSON.parses artifacts and fails closed on malformed ones

    fs.writeFileSync(nodePath.join(root, rel), '{"real":"work"}');
    const second = writeScaffoldLive(root, rel, g.scaffold);
    assert.strictEqual(second.written, false);
    assert.strictEqual(fs.readFileSync(nodePath.join(root, rel), 'utf8'), '{"real":"work"}');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('writeScaffoldLive refuses a path that escapes the artifact dir', () => {
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'enf20-'));
  try {
    const g = GATES.filter((x) => x.id === 'STEP-ZERO')[0];
    const res = writeScaffoldLive(root, '../escaped-' + nodePath.basename(root) + '.json', g.scaffold);
    assert.strictEqual(res.written, false);
    assert.strictEqual(res.reason, 'outside-artifact-dir');
    assert.ok(!fs.existsSync(nodePath.join(root, '..', 'escaped-' + nodePath.basename(root) + '.json')));
    // …and the plain in-tree-but-outside-.gsd form is refused too.
    assert.strictEqual(writeScaffoldLive(root, 'src/evil.json', g.scaffold).reason, 'outside-artifact-dir');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a scaffold-write failure degrades to a plain deny, never to an allow', () => {
  const d = runProtocolArtifactGate(
    input(PR),
    deps({
      artifactExists: (rel) => rel !== REL('STEP-ZERO-todos.json'),
      writeScaffold: () => {
        throw new Error('read-only filesystem');
      },
    })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /ENF-19 STEP-ZERO/);
});
