'use strict';

/**
 * node:test for hooks/review-artifact.cjs (ENF-20 review-side artifact gate, CTK-ADR-0004,
 * HARD-01 fail-closed, HARD-04 robust-parse, ENF-15 synonym coverage).
 *
 * Driven via the injectable runReviewArtifactGate(stdinString, deps) seam: the PR resolution,
 * the PR-vs-issue lookup, the artifact filesystem, the artifact mtimes, the scaffolder and the
 * posted-review list are ALL injected, so this suite is hermetic (no git, no gh, no network,
 * no filesystem).
 *
 * Coverage, per the four mechanizable re-review steps (full-system-map.md:169-174):
 *   step 8  — `gh pr review` with/without the /code-review + /security-review artifacts
 *   step 13 — `gh pr merge` with/without the merge record, its `merge=#n` token, and a CI
 *             re-fetch that post-dates the last analysis artifact
 *   step 1  — the treadmill guard: a second re-review post on an UNCHANGED head oid
 *   step 10 — a CLEAR/Approve verdict post with no exogenous-check artifact
 *
 * Plus the properties that make the mechanism worth having:
 *   - a freshly SCAFFOLDED (unfilled) artifact still DENIES — the anti-inversion proof, run
 *     against the real GATES specs and the real `scaffold()` renderer, end to end
 *   - an artifact keyed to a DIFFERENT head oid denies (both the directory key and the
 *     in-artifact `head_oid`, which catches a copied file)
 *   - a non-review command is untouched — no lookup, no scaffold, no deny
 *   - a CHAINED command stays governed even when a LEGACY action wins classifyAction's
 *     aggregation (`git commit -m x && gh pr merge 42`) — the T1 aggregation trap
 *   - `gh pr review --help` is allowed
 *   - an ordinary ISSUE comment is allowed, while the same POST to `/issues/<pr#>/comments`
 *     (GitHub's PR conversation-comment route) is governed
 *   - unparseable command / malformed stdin / a reader throw → fail-closed DENY, and the
 *     throw is override-escapable WITH a receipt (HARD-03)
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  runReviewArtifactGate,
  GATES,
  GOVERNED_ACTIONS,
  ARTIFACT_DIR,
  reviewSlug,
  prSelector,
  bodyText,
  isApproveEvent,
  isHelpInvocation,
  normalizeOid,
  unfilledFields,
  CLEAR_VERDICT_RE,
  REVIEW_POST_RE,
  TREADMILL_MAX_POSTS_PER_OID,
} = require('./review-artifact.cjs');

const { parseCommand } = require('./lib/argv.cjs');
const { scaffold, validateSpec, hasUnfilledPlaceholders } = require('./lib/scaffold.cjs');
// ENF-19's OWN predicate, imported to MEASURE (not to re-implement) what the shape assertions
// do and do not catch — see the anti-inversion measurement below.
const { checkAssertion } = require('./protocol-artifact.cjs');

// ── fixtures ────────────────────────────────────────────────────────────────

const HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const OTHER_HEAD = 'ffeeddccbbaa99887766554433221100ffeeddcc';
const PR = 42;

const DIR = ARTIFACT_DIR + '/' + reviewSlug(PR, HEAD);
const STALE_DIR = ARTIFACT_DIR + '/' + reviewSlug(PR, OTHER_HEAD);

const R8_CODE = 'R8-code-review.json';
const R8_SEC = 'R8-security-review.json';
const R10 = 'R10-exogenous.json';
const R13 = 'R13-merge.json';

const ANALYSIS_AT = Date.parse('2026-07-29T11:00:00.000Z');
const REFETCH_AT = '2026-07-29T12:00:00.000Z';

const R8_CODE_OK = {
  schema: 1,
  pass: 'code-review',
  head_oid: HEAD,
  command: '/code-review on the delta (gh pr diff 42)',
  verdict: 'PASS — no correctness findings on the change itself',
  findings: [{ severity: 'Minor', path: 'src/core.cts:412', summary: 'unused export' }],
};

const R8_SEC_OK = {
  schema: 1,
  pass: 'security-review',
  head_oid: HEAD,
  command: '/security-review on the delta',
  verdict: 'PASS — no code surface',
  findings: [],
};

const R10_OK = {
  schema: 1,
  head_oid: HEAD,
  reviewer: 'feature-dev:code-reviewer (fresh subagent, given diff + blockers + ADRs only)',
  withheld_verdict: true,
  conclusion: 'all three blocking findings are resolved by 8161fcc6',
  independent_judgement: [{ finding: 'Blocker 1 — stale generated artifact', judgement: 'resolved' }],
  primary_source_checks: [
    { claim: 'Blocker 1 resolved', quote: 'bin/lib/core.generated.cjs:44 +  const tier = catalog[key]' },
  ],
};

const R13_OK = {
  schema: 1,
  head_oid: HEAD,
  authorization: 'merge=#42',
  verdict: 'CLEAR',
  ci_refetched_at: REFETCH_AT,
  ci_conclusions: [
    { name: 'unit (ubuntu, node22)', conclusion: 'success' },
    { name: 'lint:ci', conclusion: 'success' },
  ],
};

function input(command) {
  return JSON.stringify({ tool_name: 'Bash', tool_input: { command } });
}

/** JSON text on disk — the gate reads RAW TEXT so the placeholder scan can run first. */
function text(obj) {
  return JSON.stringify(obj, null, 2) + '\n';
}

/**
 * Default deps: PR 42 at HEAD, every artifact present, filled and well-formed, no prior
 * posted re-review, and nothing scaffolded yet. `over.files` REPLACES individual entries
 * (set one to `undefined` to make it absent).
 */
function deps(over = {}) {
  const files = Object.assign(
    {
      [DIR + '/' + R8_CODE]: text(R8_CODE_OK),
      [DIR + '/' + R8_SEC]: text(R8_SEC_OK),
      [DIR + '/' + R10]: text(R10_OK),
      [DIR + '/' + R13]: text(R13_OK),
    },
    over.files || {}
  );
  const mtimes = Object.assign({}, over.mtimes || {});
  const calls = { resolvePr: 0, resolveIsPullRequest: 0, readPostedReviews: 0, scaffolded: [] };

  const base = {
    worktreeRoot: '/tmp/wt',
    _calls: calls,
    resolvePr: () => {
      calls.resolvePr += 1;
      return { number: PR, headOid: HEAD };
    },
    resolveIsPullRequest: () => {
      calls.resolveIsPullRequest += 1;
      return true;
    },
    artifactExists: (rel) => files[rel] !== undefined,
    readArtifactText: (rel) => {
      if (files[rel] === undefined) throw new Error('could not read `' + rel + '`');
      return files[rel];
    },
    artifactMtimeMs: (rel) => (rel in mtimes ? mtimes[rel] : ANALYSIS_AT),
    writeScaffold: (rel) => {
      calls.scaffolded.push(rel);
      return { written: true, path: '/tmp/wt/' + rel, bytes: 512 };
    },
    readPostedReviews: () => {
      calls.readPostedReviews += 1;
      return [];
    },
    readBodyFile: () => {
      throw new Error('no body file in this fixture');
    },
    overrideImpl: { checkOverride: () => ({ override: false }), writeReceipt: () => {} },
  };

  const merged = Object.assign(base, over);
  delete merged.files;
  delete merged.mtimes;
  merged._calls = calls;
  return merged;
}

function absent(...names) {
  const files = {};
  for (const n of names) files[DIR + '/' + n] = undefined;
  return files;
}

// ── the frozen table itself ─────────────────────────────────────────────────

test('the gate table is frozen, complete, and ordered cheapest-first', () => {
  assert.ok(Object.isFrozen(GATES), 'GATES must be frozen (CTK-ADR-0004 §Decision.2)');
  assert.deepStrictEqual(
    GATES.map((g) => g.id),
    ['R8-code', 'R8-security', 'R10', 'R13', 'R1'],
    'disk checks before the network treadmill lookup'
  );
  assert.deepStrictEqual(
    GATES.map((g) => g.step),
    [8, 8, 10, 13, 1],
    'every entry names the re-review step it mechanizes'
  );
  for (const g of GATES) {
    assert.ok(Array.isArray(g.on) && g.on.length > 0, g.id + ' governs at least one action');
    for (const a of g.on) {
      assert.ok(GOVERNED_ACTIONS.has(a), g.id + ' governs the classified action `' + a + '`');
    }
  }
});

test('EVERY gate spec is valid AND its rendered scaffold FAILS its own gate (anti-inversion)', () => {
  for (const g of GATES) {
    if (!g.spec) continue;
    assert.doesNotThrow(() => validateSpec(g.spec), g.id + ' spec must be a valid scaffold spec');
    const skeleton = scaffold(g.spec);
    assert.strictEqual(
      hasUnfilledPlaceholders(skeleton),
      true,
      g.id + ' scaffold must NOT be able to satisfy the gate that writes it'
    );
    assert.doesNotThrow(() => JSON.parse(skeleton), g.id + ' scaffold must be valid JSON');
  }
});

// ── step 8: two orthogonal passes ───────────────────────────────────────────

test('step 8 — `gh pr review` with BOTH pass artifacts → allow', () => {
  const d = runReviewArtifactGate(
    input('gh pr review 42 --request-changes --body "one blocker open"'),
    deps()
  );
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

test('step 8 — no /code-review artifact → DENY, naming the path written and the OBSERVED duty', () => {
  const dp = deps({ files: absent(R8_CODE) });
  const d = runReviewArtifactGate(input('gh pr review 42 --request-changes --body b'), dp);
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /ENF-20 R8-code/);
  assert.match(d.permissionDecisionReason, /re-review step 8/);
  assert.match(d.permissionDecisionReason, new RegExp(R8_CODE.replace('.', '\\.')));
  assert.match(d.permissionDecisionReason, /OBSERVED/);
  assert.deepStrictEqual(dp._calls.scaffolded, [DIR + '/' + R8_CODE], 'the gate scaffolds on deny');
});

test('step 8 — the SECURITY pass is required separately (a single blended pass is not two)', () => {
  const dp = deps({ files: absent(R8_SEC) });
  const d = runReviewArtifactGate(input('gh pr review 42 --approve'), dp);
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /ENF-20 R8-security/);
  assert.deepStrictEqual(dp._calls.scaffolded, [DIR + '/' + R8_SEC]);
});

test('step 8 — a finding with an off-menu severity → DENY (shape, not mere presence)', () => {
  const bad = Object.assign({}, R8_CODE_OK, {
    findings: [{ severity: 'meh', path: 'a.cts:1', summary: 's' }],
  });
  const d = runReviewArtifactGate(
    input('gh pr review 42 --request-changes --body b'),
    deps({ files: { [DIR + '/' + R8_CODE]: text(bad) } })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /severity/i);
});

test('step 8 — an EMPTY findings list is a legitimate pass result (no fabrication pressure)', () => {
  const clean = Object.assign({}, R8_CODE_OK, { findings: [] });
  const d = runReviewArtifactGate(
    input('gh pr review 42 --request-changes --body b'),
    deps({ files: { [DIR + '/' + R8_CODE]: text(clean) } })
  );
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

test('step 8 — the REST synonym is governed too (`gh api POST …/pulls/42/reviews`)', () => {
  const dp = deps({ files: absent(R8_CODE) });
  const d = runReviewArtifactGate(
    input('gh api -X POST repos/open-gsd/gsd-core/pulls/42/reviews -f event=APPROVE -f body=CLEAR'),
    dp
  );
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /ENF-20 R8-code/);
});

// ── step 10: exogenous self-check before a CLEAR / Approve verdict ──────────

test('step 10 — `--approve` with no exogenous artifact → DENY + scaffold', () => {
  const dp = deps({ files: absent(R10) });
  const d = runReviewArtifactGate(input('gh pr review 42 --approve --body "**CLEAR**"'), dp);
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /ENF-20 R10/);
  assert.match(d.permissionDecisionReason, /re-review step 10/);
  assert.deepStrictEqual(dp._calls.scaffolded, [DIR + '/' + R10]);
});

test('step 10 — a request-changes verdict does NOT require the exogenous artifact', () => {
  const d = runReviewArtifactGate(
    input('gh pr review 42 --request-changes --body "1 BLOCKER(S) OPEN"'),
    deps({ files: absent(R10) })
  );
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

test('step 10 — `CLEAR · merge-blocked` is still a CLEAR verdict and still requires it', () => {
  const d = runReviewArtifactGate(
    input('gh pr comment 42 --body "## Re-Review — PR #42 · **CLEAR · merge-blocked: rebase**"'),
    deps({ files: absent(R10) })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /ENF-20 R10/);
});

test('step 10 — the exogenous reviewer must not have been handed the verdict', () => {
  const bad = Object.assign({}, R10_OK, { withheld_verdict: false });
  const d = runReviewArtifactGate(
    input('gh pr review 42 --approve'),
    deps({ files: { [DIR + '/' + R10]: text(bad) } })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /verdict/i);
});

test('step 10 — a reviewer claim with no quoted primary source → DENY (trust-but-verify)', () => {
  const bad = Object.assign({}, R10_OK, {
    primary_source_checks: [{ claim: 'Blocker 1 resolved' }],
  });
  const d = runReviewArtifactGate(
    input('gh pr review 42 --approve'),
    deps({ files: { [DIR + '/' + R10]: text(bad) } })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /primary_source_checks\[0\]/);
});

// ── step 13: the merge gate ─────────────────────────────────────────────────

test('step 13 — `gh pr merge` with a complete, fresh merge record → allow', () => {
  const d = runReviewArtifactGate(input('gh pr merge 42 --squash'), deps());
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

test('step 13 — no merge record → DENY + scaffold', () => {
  const dp = deps({ files: absent(R13) });
  const d = runReviewArtifactGate(input('gh pr merge 42 --squash'), dp);
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /ENF-20 R13/);
  assert.match(d.permissionDecisionReason, /re-review step 13/);
  assert.deepStrictEqual(dp._calls.scaffolded, [DIR + '/' + R13]);
});

test('step 13 — a `merge=#n` token naming a DIFFERENT PR → DENY', () => {
  const bad = Object.assign({}, R13_OK, { authorization: 'merge=#1738' });
  const d = runReviewArtifactGate(
    input('gh pr merge 42 --squash'),
    deps({ files: { [DIR + '/' + R13]: text(bad) } })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /merge=#42/);
});

test('step 13 — a CI re-fetch that PREDATES the last analysis artifact → DENY as stale', () => {
  const d = runReviewArtifactGate(
    input('gh pr merge 42 --squash'),
    deps({ mtimes: { [DIR + '/' + R10]: Date.parse('2026-07-29T13:00:00.000Z') } })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /re-fetch/i);
  assert.match(d.permissionDecisionReason, new RegExp(R10.replace('.', '\\.')));
});

test('step 13 — a red CI conclusion → DENY', () => {
  const bad = Object.assign({}, R13_OK, {
    ci_conclusions: [{ name: 'unit', conclusion: 'failure' }],
  });
  const d = runReviewArtifactGate(
    input('gh pr merge 42 --squash'),
    deps({ files: { [DIR + '/' + R13]: text(bad) } })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /conclusion/i);
});

test('step 13 — `CLEAR · merge-blocked` is NOT a mergeable verdict', () => {
  const bad = Object.assign({}, R13_OK, { verdict: 'CLEAR · merge-blocked: rebase' });
  const d = runReviewArtifactGate(
    input('gh pr merge 42 --squash'),
    deps({ files: { [DIR + '/' + R13]: text(bad) } })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /CLEAR/);
});

test('step 13 — a merge whose analysis artifacts are absent → DENY (nothing for the re-fetch to post-date)', () => {
  const dp = deps({ files: absent(R8_SEC) });
  const d = runReviewArtifactGate(input('gh pr merge 42 --squash'), dp);
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /ENF-20 R8-security/);
});

test('step 13 — the REST synonym is governed (`gh api PUT …/pulls/42/merge`)', () => {
  const d = runReviewArtifactGate(
    input('gh api -X PUT repos/open-gsd/gsd-core/pulls/42/merge -f merge_method=squash'),
    deps({ files: absent(R13) })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /ENF-20 R13/);
});

// ── step 1: the treadmill guard ─────────────────────────────────────────────

test('step 1 — a prior re-review post at the SAME head oid → DENY (treadmill)', () => {
  const dp = deps({
    readPostedReviews: () => [
      { commit_id: HEAD, state: 'CHANGES_REQUESTED', body: '## Re-Review — PR #42 · **1 BLOCKER(S) OPEN**' },
    ],
  });
  const d = runReviewArtifactGate(input('gh pr review 42 --approve'), dp);
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /ENF-20 R1/);
  assert.match(d.permissionDecisionReason, /re-review step 1/);
  assert.match(d.permissionDecisionReason, /human maintainer/i);
});

test('step 1 — a prior post at a DIFFERENT head oid does not block (HEAD moved)', () => {
  const d = runReviewArtifactGate(
    input('gh pr review 42 --approve'),
    deps({
      readPostedReviews: () => [
        { commit_id: OTHER_HEAD, state: 'CHANGES_REQUESTED', body: '## Re-Review — PR #42 · **CHANGES REQUESTED**' },
      ],
    })
  );
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

test("step 1 — another maintainer's ordinary review at this oid is not a re-review round", () => {
  const d = runReviewArtifactGate(
    input('gh pr review 42 --approve'),
    deps({
      readPostedReviews: () => [{ commit_id: HEAD, state: 'APPROVED', body: 'lgtm, thanks!' }],
    })
  );
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

test('step 1 — the treadmill threshold is a NAMED frozen constant', () => {
  assert.strictEqual(TREADMILL_MAX_POSTS_PER_OID, 1);
});

// ── the anti-inversion proof, end to end ───────────────────────────────────

test('a freshly SCAFFOLDED (unfilled) artifact STILL DENIES — the whole point of the task', () => {
  const g = GATES.find((x) => x.id === 'R8-code');
  const skeleton = scaffold(g.spec); // the REAL renderer, the REAL spec
  const d = runReviewArtifactGate(
    input('gh pr review 42 --request-changes --body b'),
    deps({ files: { [DIR + '/' + R8_CODE]: skeleton } })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /placeholder/i);
  assert.match(d.permissionDecisionReason, /head_oid/);
});

test('MEASURED: the shape assertions ALONE would pass an unfilled scaffold — the placeholder scan is what denies', () => {
  // This is the regression test for the inversion the whole task exists to prevent, and it is
  // pinned with a MEASUREMENT rather than an assertion of intent.
  //
  // A placeholder string is `nonEmpty`. So an UNFILLED skeleton whose optional list entry the
  // agent legitimately deleted (the field guidance tells them to, when the pass found nothing)
  // satisfies EVERY ONE of R8-code's five shape assertions. If `hasUnfilledPlaceholders` were
  // ever dropped from `requireArtifact`, or moved to run AFTER the shape checks, an untouched
  // scaffold would satisfy the gate that wrote it — the gate would stop meaning "prove you did
  // the step" and start meaning "the gate does the step for you" (CTK-ADR-0004 §Consequences).
  const g = GATES.find((x) => x.id === 'R8-code');
  const doc = JSON.parse(scaffold(g.spec));
  doc.findings = []; // the documented "the pass found nothing" edit
  const unsatisfied = g.assert.filter((a) => checkAssertion(doc, a) !== null);
  assert.deepStrictEqual(
    unsatisfied,
    [],
    'MEASUREMENT CHANGED: R8-code shape assertions no longer all pass on an unfilled scaffold. ' +
      'That is fine — but do NOT read it as "the shape checks are sufficient now". Re-measure ' +
      'and keep the placeholder precondition first.'
  );

  // ...and the gate DENIES it anyway.
  const d = runReviewArtifactGate(
    input('gh pr review 42 --request-changes --body b'),
    deps({ files: { [DIR + '/' + R8_CODE]: JSON.stringify(doc, null, 2) + '\n' } })
  );
  assert.strictEqual(d.permissionDecision, 'deny', 'an unfilled scaffold must NEVER satisfy its gate');
  assert.match(d.permissionDecisionReason, /placeholder/i);
});

test('a scaffold with ONE placeholder left still denies (and names the field)', () => {
  const g = GATES.find((x) => x.id === 'R10');
  const skeleton = scaffold(g.spec);
  const nearlyDone = JSON.parse(skeleton);
  // Fill everything except `reviewer`.
  const fill = (o) => {
    for (const k of Object.keys(o)) {
      if (typeof o[k] === 'string' && /<{1,3}FILL/.test(o[k]) && k !== 'reviewer') o[k] = 'observed';
      else if (o[k] && typeof o[k] === 'object') fill(o[k]);
    }
  };
  fill(nearlyDone);
  const d = runReviewArtifactGate(
    input('gh pr review 42 --approve'),
    deps({ files: { [DIR + '/' + R10]: JSON.stringify(nearlyDone, null, 2) } })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /reviewer/);
});

test('unfilledFields names the fields still carrying a sentinel', () => {
  const g = GATES.find((x) => x.id === 'R13');
  const names = unfilledFields(scaffold(g.spec));
  assert.ok(names.includes('head_oid'), JSON.stringify(names));
  assert.ok(names.includes('authorization'), JSON.stringify(names));
});

// ── staleness: a different head oid ────────────────────────────────────────

test('artifacts keyed to a DIFFERENT head oid do not vouch for this push (directory key)', () => {
  const dp = deps({
    files: Object.assign(absent(R8_CODE, R8_SEC, R10, R13), {
      [STALE_DIR + '/' + R8_CODE]: text(R8_CODE_OK),
      [STALE_DIR + '/' + R8_SEC]: text(R8_SEC_OK),
    }),
  });
  const d = runReviewArtifactGate(input('gh pr review 42 --request-changes --body b'), dp);
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /ENF-20 R8-code/);
  assert.ok(dp._calls.scaffolded[0].startsWith(DIR), 'the scaffold lands under the CURRENT oid key');
});

test('an artifact COPIED into this oid directory but naming another oid → DENY', () => {
  const copied = Object.assign({}, R8_CODE_OK, { head_oid: OTHER_HEAD });
  const d = runReviewArtifactGate(
    input('gh pr review 42 --request-changes --body b'),
    deps({ files: { [DIR + '/' + R8_CODE]: text(copied) } })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /head_oid/);
  assert.match(d.permissionDecisionReason, new RegExp(HEAD.slice(0, 12)));
});

test('an abbreviated but CORRECT head_oid prefix is accepted', () => {
  const short = Object.assign({}, R8_CODE_OK, { head_oid: HEAD.slice(0, 8) });
  const d = runReviewArtifactGate(
    input('gh pr review 42 --request-changes --body b'),
    deps({ files: { [DIR + '/' + R8_CODE]: text(short) } })
  );
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

// ── ordinary work is untouched ──────────────────────────────────────────────

test('non-review commands are completely untouched (no lookup, no scaffold)', () => {
  for (const cmd of [
    'git status --porcelain',
    'gh issue create --repo open-gsd/gsd-core --title t --body b',
    'gh pr create --title t --body b',
    'git commit -m "fix(1234): x"',
    'gh pr view 42 --json headRefOid',
    'gh pr diff 42',
    'npm test',
  ]) {
    const dp = deps();
    const d = runReviewArtifactGate(input(cmd), dp);
    assert.strictEqual(d.permissionDecision, 'allow', cmd + ' → ' + d.permissionDecisionReason);
    assert.strictEqual(dp._calls.resolvePr, 0, cmd + ' must not resolve a PR');
    assert.deepStrictEqual(dp._calls.scaffolded, [], cmd + ' must not scaffold anything');
  }
});

test('an ordinary PR comment (no verdict, no re-review header) is untouched', () => {
  const dp = deps({ files: absent(R10) });
  const d = runReviewArtifactGate(input('gh pr comment 42 --body "thanks — rebased and pushed"'), dp);
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
  assert.strictEqual(dp._calls.resolvePr, 0);
});

test('an ordinary ISSUE comment is allowed WITHOUT a PR-ness lookup', () => {
  const dp = deps();
  const d = runReviewArtifactGate(input('gh issue comment 42 --body "will fix, thanks"'), dp);
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
  assert.strictEqual(dp._calls.resolveIsPullRequest, 0, 'no network for an ordinary comment');
});

test('a verdict-shaped comment on a real ISSUE is allowed (the lookup says it is not a PR)', () => {
  const dp = deps({ files: absent(R10), resolveIsPullRequest: () => false });
  const d = runReviewArtifactGate(
    input('gh issue comment 42 --body "triage: CLEAR to close, the repro no longer reproduces"'),
    dp
  );
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
  assert.strictEqual(dp._calls.resolvePr, 0);
});

test('the same POST to /issues/<pr#>/comments IS governed — the PR conversation route', () => {
  const dp = deps({ files: absent(R10) });
  const d = runReviewArtifactGate(
    input('gh api -X POST repos/open-gsd/gsd-core/issues/42/comments -f body="## Re-Review — PR #42 · **CLEAR**"'),
    dp
  );
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /ENF-20 R10/);
  assert.ok(dp._calls.resolveIsPullRequest > 0, 'PR-ness is resolved with a real lookup');
});

test('`gh pr review --help` is never denied', () => {
  for (const cmd of ['gh pr review --help', 'gh pr merge --help', 'gh pr review -h']) {
    const dp = deps({ files: absent(R8_CODE, R8_SEC, R10, R13) });
    const d = runReviewArtifactGate(input(cmd), dp);
    assert.strictEqual(d.permissionDecision, 'allow', cmd + ' → ' + d.permissionDecisionReason);
    assert.deepStrictEqual(dp._calls.scaffolded, [], cmd + ' must not scaffold');
  }
});

// ── chained commands (the T1 aggregation trap) ─────────────────────────────

test('a chained merge stays governed — `gh pr merge 42 --squash && echo ok`', () => {
  const d = runReviewArtifactGate(
    input('gh pr merge 42 --squash && echo ok'),
    deps({ files: absent(R13) })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /ENF-20 R13/);
});

test('a merge hidden behind a LEGACY action still fires — `git commit -m x && gh pr merge 42`', () => {
  // classifyAction aggregates ONE verdict per chain and legacy actions deliberately WIN, so
  // gating on `classifyAction(parsed).action` would report `commit` here and miss the merge
  // entirely. This gate triggers on hasGovernedSegment (T1 carry-forward #1).
  const d = runReviewArtifactGate(
    input('git commit -m "wip" && gh pr merge 42 --squash'),
    deps({ files: absent(R13) })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /ENF-20 R13/);
});

test('the FIRST unmet requirement in a chain denies (review before merge)', () => {
  const d = runReviewArtifactGate(
    input('gh pr review 42 --approve && gh pr merge 42 --squash'),
    deps({ files: absent(R8_CODE, R13) })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /ENF-20 R8-code/);
});

// ── fail-closed posture (HARD-01 / HARD-04) ────────────────────────────────

test('unparseable command → fail-closed DENY (HARD-04)', () => {
  const d = runReviewArtifactGate(input('gh pr review 42 --body "unterminated'), deps());
  assert.strictEqual(d.permissionDecision, 'deny');
});

test('malformed stdin → fail-closed DENY, never a guessed allow', () => {
  const d = runReviewArtifactGate('{not json', deps());
  assert.strictEqual(d.permissionDecision, 'deny');
});

test('an unclassifiable mutating GitHub synonym → fail-closed DENY (ENF-15)', () => {
  const d = runReviewArtifactGate(
    input('gh api -X POST repos/open-gsd/gsd-core/issues/weird/reviews -f body=x'),
    deps()
  );
  assert.strictEqual(d.permissionDecision, 'deny');
});

test('malformed artifact JSON → fail-closed DENY (a gate that cannot load is no gate)', () => {
  const d = runReviewArtifactGate(
    input('gh pr review 42 --request-changes --body b'),
    deps({ files: { [DIR + '/' + R8_CODE]: '{ "schema": 1, oops' } })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /not valid JSON/);
});

test('an unreadable head-oid lookup → fail-closed DENY (never key against a guess)', () => {
  const d = runReviewArtifactGate(
    input('gh pr merge 42 --squash'),
    deps({
      resolvePr: () => {
        throw new Error('gh: could not resolve the PR head');
      },
    })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /could not resolve the PR head/);
});

test('a non-hex head oid → fail-closed DENY (a bad key is not a usable key)', () => {
  const d = runReviewArtifactGate(
    input('gh pr merge 42 --squash'),
    deps({ resolvePr: () => ({ number: PR, headOid: '../../etc/passwd' }) })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
});

test('an unreadable posted-review list → fail-closed DENY (the treadmill must not be guessed)', () => {
  const d = runReviewArtifactGate(
    input('gh pr review 42 --approve'),
    deps({
      readPostedReviews: () => {
        throw new Error('gh api reviews failed');
      },
    })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /gh api reviews failed/);
});

test('an unreadable --body-file → fail-closed DENY (the verdict cannot be read)', () => {
  const d = runReviewArtifactGate(input('gh pr comment 42 --body-file /tmp/nope.md'), deps());
  assert.strictEqual(d.permissionDecision, 'deny');
});

test('a fail-closed throw is override-escapable AND writes a receipt (HARD-03)', () => {
  let receipt = null;
  const d = runReviewArtifactGate(
    input('gh pr merge 42 --squash'),
    deps({
      resolvePr: () => {
        throw new Error('gh exploded');
      },
      overrideImpl: {
        checkOverride: () => ({ override: true, reason: 'github api outage' }),
        writeReceipt: (root, rec) => {
          receipt = rec;
        },
      },
    })
  );
  assert.strictEqual(d.permissionDecision, 'allow');
  assert.ok(receipt, 'a bypass must leave a receipt');
  assert.strictEqual(receipt.action, 'review-artifact');
});

test('an override NEVER flips an intentional policy deny', () => {
  const d = runReviewArtifactGate(
    input('gh pr merge 42 --squash'),
    deps({
      files: absent(R13),
      overrideImpl: {
        checkOverride: () => ({ override: true, reason: 'in a hurry' }),
        writeReceipt: () => {},
      },
    })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
});

// ── helpers ─────────────────────────────────────────────────────────────────

test('reviewSlug keys artifacts to the PR number AND the head oid, in one safe segment', () => {
  const slug = reviewSlug(42, HEAD);
  assert.strictEqual(slug, 'pr-42-' + HEAD.slice(0, 12));
  assert.strictEqual(slug.indexOf('/'), -1);
  assert.notStrictEqual(reviewSlug(42, HEAD), reviewSlug(42, OTHER_HEAD));
  assert.notStrictEqual(reviewSlug(42, HEAD), reviewSlug(43, HEAD));
});

test('normalizeOid rejects anything that is not a hex object id', () => {
  assert.strictEqual(normalizeOid(HEAD.toUpperCase()), HEAD);
  assert.strictEqual(normalizeOid('../../etc/passwd'), null);
  assert.strictEqual(normalizeOid(''), null);
  assert.strictEqual(normalizeOid('abc'), null); // too short to key on
});

test('prSelector reads the number from every shape that names one', () => {
  const sel = (cmd) => prSelector(parseCommand(cmd).segments[0]);
  assert.strictEqual(sel('gh pr review 42 --approve'), '42');
  assert.strictEqual(sel('gh pr review --approve 42'), '42');
  assert.strictEqual(sel('gh pr merge --repo open-gsd/gsd-core 42 --squash'), '42');
  assert.strictEqual(sel('gh api -X PUT repos/open-gsd/gsd-core/pulls/42/merge'), '42');
  assert.strictEqual(sel('gh api -X POST repos/o/r/issues/42/comments -f body=x'), '42');
  assert.strictEqual(
    sel('gh pr review https://github.com/open-gsd/gsd-core/pull/42 --approve'),
    '42'
  );
  assert.strictEqual(sel('gh pr review --approve'), null); // gh infers from the branch
});

test('bodyText finds the body in native, field and JSON forms', () => {
  const body = (cmd) => bodyText(parseCommand(cmd).segments[0], {});
  assert.match(body('gh pr comment 42 --body "**CLEAR**"'), /CLEAR/);
  assert.match(body('gh pr comment 42 -b "**CLEAR**"'), /CLEAR/);
  assert.match(body('gh api -X POST repos/o/r/issues/42/comments -f body=CLEAR'), /CLEAR/);
  assert.match(
    body('curl -X POST https://api.github.com/repos/o/r/pulls/42/reviews -d \'{"body":"CLEAR"}\''),
    /CLEAR/
  );
  assert.strictEqual(body('gh pr review 42 --approve'), '');
});

test('isApproveEvent covers the native flag and the REST event field', () => {
  const approve = (cmd) => isApproveEvent(parseCommand(cmd).segments[0]);
  assert.strictEqual(approve('gh pr review 42 --approve'), true);
  assert.strictEqual(approve('gh api -X POST repos/o/r/pulls/42/reviews -f event=APPROVE'), true);
  assert.strictEqual(
    approve('curl -X POST https://api.github.com/repos/o/r/pulls/42/reviews -d \'{"event":"APPROVE"}\''),
    true
  );
  assert.strictEqual(approve('gh pr review 42 --request-changes --body b'), false);
});

test('isHelpInvocation recognizes --help / -h only as a real argv flag', () => {
  assert.strictEqual(isHelpInvocation(parseCommand('gh pr review --help').segments[0]), true);
  assert.strictEqual(
    isHelpInvocation(parseCommand('gh pr comment 42 --body "see --help"').segments[0]),
    false
  );
});

test('the verdict/re-review detectors do not fire on ordinary prose', () => {
  assert.strictEqual(CLEAR_VERDICT_RE.test('this makes the intent clear'), false);
  assert.strictEqual(CLEAR_VERDICT_RE.test('## Re-Review — PR #42 · **CLEAR**'), true);
  assert.strictEqual(REVIEW_POST_RE.test('## Re-Review — PR #42 · **CHANGES REQUESTED**'), true);
  assert.strictEqual(REVIEW_POST_RE.test('rebased, please re-review when you get a chance'), false);
});
