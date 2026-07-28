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
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  runProtocolArtifactGate,
  checkAssertion,
  checkWaiver,
  isNonEmpty,
  readPath,
  slugify,
  GATES,
  CODE_PATH_RE,
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
  const files = Object.assign(
    {
      '.gsd/contrib/fix-1234-slug/P1-repro.json': P1_OK,
      '.gsd/contrib/fix-1234-slug/P2-review.json': P2_OK,
      '.gsd/contrib/fix-1234-slug/P3-red.json': P3_OK,
      '.gsd/contrib/fix-1234-slug/P3-matrix.json': P3M_OK,
    },
    over.files || {}
  );
  const base = {
    worktreeRoot: '/tmp/wt',
    readBranch: () => 'fix/1234-slug',
    artifactExists: (rel) => Object.prototype.hasOwnProperty.call(files, rel),
    readArtifact: (rel) => files[rel],
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
