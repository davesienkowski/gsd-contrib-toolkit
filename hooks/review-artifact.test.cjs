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
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 38-01 (Phase 36 m-07 pattern): runGate records every verdict (OBS-02). Point the log at a
// per-file temp dir BEFORE the hook is required, so this suite never appends synthetic verdicts
// (now carrying real-looking session ids) to the real ~/.gsd-contrib/tool-log.jsonl that the
// R8a-memtrace obligation itself reads as evidence.
process.env.GSD_CONTRIB_LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rev-art-vlog-'));
process.on('exit', () => fs.rmSync(process.env.GSD_CONTRIB_LOG_DIR, { recursive: true, force: true }));

const reviewArtifact = require('./review-artifact.cjs');
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
} = reviewArtifact;
const { recordToolCall, serializeRecord, LOG_FILENAME } = require('./tool-recorder.cjs');

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

/** The PreToolUse payload's session id every default fixture carries (38-01). */
const SESSION = 'sess-A';

const MT = 'mcp__memtrace__';

/** A PreToolUse payload. `sessionId: null` omits the key entirely (a payload with no session). */
function input(command, sessionId = SESSION) {
  const payload = { tool_name: 'Bash', tool_input: { command } };
  if (sessionId !== null) payload.session_id = sessionId;
  return JSON.stringify(payload);
}

/** The reader's result shape (hooks/lib/tool-log-reader.cjs readSessionRecords). */
function toolLog(records, over = {}) {
  return Object.assign({ recorderOff: false, complete: true, records, problems: [] }, over);
}

/** Complete step-8a memtrace evidence: both REQUIRED_ALL verbs plus one recorded-decision verb. */
const COMPLETE_EVIDENCE = Object.freeze([
  Object.freeze({ tool_name: MT + 'get_impact', outcome: 'ok' }),
  Object.freeze({ tool_name: MT + 'get_symbol_context', outcome: 'ok' }),
  Object.freeze({ tool_name: MT + 'recall_decision', outcome: 'ok' }),
  Object.freeze({ tool_name: 'Bash', outcome: 'ok' }),
]);

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
  const calls = {
    resolvePr: 0,
    resolveIsPullRequest: 0,
    readPostedReviews: 0,
    scaffolded: [],
    readToolLog: [],
  };

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
    // 38-01: complete step-8a evidence by default, so every pre-existing verdict test stays green.
    readToolLog: (sid) => {
      calls.readToolLog.push(sid);
      return toolLog(COMPLETE_EVIDENCE.slice());
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
    ['R8-code', 'R8-security', 'R10', 'R8a-memtrace', 'R13', 'R1'],
    'disk checks before the network treadmill lookup'
  );
  assert.deepStrictEqual(
    GATES.map((g) => g.step),
    [8, 8, 10, '8a', 13, 1],
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

// ── 38-01: ENF-20 R8a-memtrace (re-review step 8a) tracer ───────────────────

/** Every full memtrace tool name the R8a deny must name when NO memtrace call ran. */
const ALL_FIVE = [
  MT + 'get_impact',
  MT + 'get_symbol_context',
  MT + 'recall_decision',
  MT + 'why_is_this_here',
  MT + 'governing_contracts',
];

/**
 * APPEND recorder-format rows for `sessionId` to this file's temp tool-log.jsonl, built by
 * tool-recorder's OWN recordToolCall + serializeRecord (never a hand-written shape). Append, never
 * overwrite: verdict-log writes the gate rows into the same file.
 */
function appendRecorderRows(sessionId, toolNames) {
  const file = path.join(process.env.GSD_CONTRIB_LOG_DIR, LOG_FILENAME);
  let i = 0;
  for (const tool_name of toolNames) {
    i += 1;
    const payload = {
      hook_event_name: 'PostToolUse',
      session_id: sessionId,
      tool_use_id: 'toolu_38_01_' + sessionId + '_' + i,
      tool_name,
      tool_input: tool_name === 'Bash' ? { command: 'ls' } : {},
      tool_response: {},
      cwd: '/tmp/wt',
    };
    const line = serializeRecord(recordToolCall(JSON.stringify(payload), { env: {} }));
    assert.ok(line, 'the recorder produced a line for ' + tool_name);
    fs.appendFileSync(file, line, 'utf8');
  }
}

test('38-01 m-07: this file points GSD_CONTRIB_LOG_DIR at its own temp dir, and the gate verdict lands there', () => {
  const dir = process.env.GSD_CONTRIB_LOG_DIR || '';
  assert.ok(
    path.basename(dir).startsWith('rev-art-vlog-'),
    "GSD_CONTRIB_LOG_DIR is this file's mkdtemp dir, not ~/.gsd-contrib: " + dir
  );
  runReviewArtifactGate(input('gh pr review 42 --approve'), deps());
  assert.ok(fs.existsSync(path.join(dir, 'tool-log.jsonl')), 'the verdict was recorded in the temp dir');
});

test('38-01 R8a tracer: an approve whose session holds no memtrace call is DENIED, naming the tools', () => {
  const dp = deps({
    readToolLog: (sid) => {
      dp._calls.readToolLog.push(sid);
      return toolLog([
        { tool_name: 'Read', outcome: 'ok' },
        { tool_name: 'Bash', outcome: 'ok' },
      ]);
    },
  });
  const d = runReviewArtifactGate(input('gh pr review 42 --approve'), dp);
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
  assert.match(d.permissionDecisionReason, /ENF-20 R8a-memtrace \(re-review step 8a\)/);
  for (const t of ALL_FIVE) {
    assert.ok(d.permissionDecisionReason.includes(t), 'the deny names ' + t);
  }
  assert.deepStrictEqual(dp._calls.readToolLog, ['sess-A'], 'the payload session id reaches the reader');
});

test('38-01 R8a tracer: an approve with complete memtrace evidence for its session → allow', () => {
  const dp = deps();
  const d = runReviewArtifactGate(input('gh pr review 42 --approve'), dp);
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
  assert.deepStrictEqual(dp._calls.readToolLog, ['sess-A'], 'read exactly once, for the payload session');
});

test('38-01 R8a tracer (real file): the default reader reads the temp tool-log.jsonl; no memtrace rows → deny', () => {
  appendRecorderRows('sess-38-01-deny', ['Read', 'Bash']);
  const dp = deps();
  delete dp.readToolLog;
  const d = runReviewArtifactGate(input('gh pr review 42 --approve', 'sess-38-01-deny'), dp);
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
  assert.match(d.permissionDecisionReason, /ENF-20 R8a-memtrace \(re-review step 8a\)/);
  for (const t of ALL_FIVE) {
    assert.ok(d.permissionDecisionReason.includes(t), 'the deny names ' + t);
  }
});

test('38-01 R8a tracer (real file): the session ran get_impact + get_symbol_context + recall_decision → allow', () => {
  appendRecorderRows('sess-38-01-allow', [
    MT + 'get_impact',
    MT + 'get_symbol_context',
    MT + 'recall_decision',
  ]);
  const dp = deps();
  delete dp.readToolLog;
  const d = runReviewArtifactGate(input('gh pr review 42 --approve', 'sess-38-01-allow'), dp);
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

test('38-01 MEMEV-03: the required memtrace set is exact, frozen, and phantom-free', () => {
  const all = reviewArtifact.MEMTRACE_REQUIRED_ALL;
  const any = reviewArtifact.MEMTRACE_REQUIRED_ANY;
  assert.deepStrictEqual(all, ['get_impact', 'get_symbol_context']);
  assert.deepStrictEqual(any, ['recall_decision', 'why_is_this_here', 'governing_contracts']);
  assert.ok(Object.isFrozen(all), 'MEMTRACE_REQUIRED_ALL is frozen');
  assert.ok(Object.isFrozen(any), 'MEMTRACE_REQUIRED_ANY is frozen');
  assert.ok(
    !all.concat(any).includes('find_code_review_issues'),
    'find_code_review_issues exists on the live surface but is optional in re-review.md step 8a'
  );
  assert.strictEqual(reviewArtifact.MEMTRACE_TOOL_PREFIX, 'mcp__memtrace__');
});

// ── 38-02: cannot-observe is ASK; deny dominates ask ────────────────────────

const R8A_ASK_PREFIX = 'ENF-20 R8a-memtrace (re-review step 8a) — ';

/** Every R8a ask shares one shape: prefix, cannot-observe statement, human-decides note. */
function assertR8aAsk(d) {
  assert.strictEqual(d.permissionDecision, 'ask', d.permissionDecisionReason);
  const why = d.permissionDecisionReason;
  assert.ok(why.startsWith(R8A_ASK_PREFIX), 'the ask reason starts with the R8a prefix: ' + why);
  assert.match(why, /could not observe/);
  assert.match(why, /not a finding that memtrace did not run/);
  assert.match(why, /human decides/i);
  return why;
}

/** deps() whose readToolLog returns `result` (and records each call). */
function depsWithLog(result, over = {}) {
  const dp = deps(over);
  dp.readToolLog = (sid) => {
    dp._calls.readToolLog.push(sid);
    return typeof result === 'function' ? result(sid) : result;
  };
  return dp;
}

const RECORDER_OFF = Object.freeze({ recorderOff: true, complete: false, records: [], problems: ['recorder off'] });

test('38-02 R8a ask: a payload without session_id → ask naming session_id; the log is never read', () => {
  const dp = deps();
  const d = runReviewArtifactGate(input('gh pr review 42 --approve', null), dp);
  const why = assertR8aAsk(d);
  assert.match(why, /session_id/);
  assert.deepStrictEqual(dp._calls.readToolLog, [], 'no session to scope → no read');
});

for (const [label, sid] of [["''", ''], ["'   '", '   '], ['42', 42]]) {
  test('38-02 R8a ask: session_id ' + label + ' → ask', () => {
    const dp = deps();
    const d = runReviewArtifactGate(input('gh pr review 42 --approve', sid), dp);
    const why = assertR8aAsk(d);
    assert.match(why, /session_id/);
    assert.deepStrictEqual(dp._calls.readToolLog, []);
  });
}

test('38-02 R8a ask: readToolLog {recorderOff:true} → ask naming GSD_CONTRIB_RECORD=off', () => {
  const d = runReviewArtifactGate(input('gh pr review 42 --approve'), depsWithLog(RECORDER_OFF));
  const why = assertR8aAsk(d);
  assert.match(why, /GSD_CONTRIB_RECORD=off/);
});

test('38-02 R8a ask: log absent (complete:false, no records) → ask carrying the reader problem', () => {
  const problem = 'log absent: tool-log.jsonl, tool-log.1.jsonl';
  const d = runReviewArtifactGate(
    input('gh pr review 42 --approve'),
    depsWithLog(toolLog([], { complete: false, problems: [problem] }))
  );
  const why = assertR8aAsk(d);
  assert.ok(why.includes(problem), 'the ask carries the reader problem: ' + why);
});

test('38-02 R8a ask: complete:false with own ok rows lacking get_impact → ask (part of the log unread)', () => {
  const d = runReviewArtifactGate(
    input('gh pr review 42 --approve'),
    depsWithLog(
      toolLog(
        [
          { tool_name: MT + 'get_symbol_context', outcome: 'ok' },
          { tool_name: MT + 'recall_decision', outcome: 'ok' },
          { tool_name: 'Bash', outcome: 'ok' },
        ],
        { complete: false, problems: ['unreadable tool-log.1.jsonl: EACCES'] }
      )
    )
  );
  const why = assertR8aAsk(d);
  assert.ok(why.includes('unreadable tool-log.1.jsonl: EACCES'));
  assert.ok(why.includes(MT + 'get_impact'), 'the ask names the tool not seen');
});

test('38-02 R8a: complete:false with complete evidence → allow (evidence found is real)', () => {
  const d = runReviewArtifactGate(
    input('gh pr review 42 --approve'),
    depsWithLog(toolLog(COMPLETE_EVIDENCE.slice(), { complete: false, problems: ['read budget exceeded'] }))
  );
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

test('38-02 R8a ask: complete:true with only outcome fail rows (incl. failed memtrace calls) → ask', () => {
  const d = runReviewArtifactGate(
    input('gh pr review 42 --approve'),
    depsWithLog(
      toolLog([
        { tool_name: MT + 'get_impact', outcome: 'fail' },
        { tool_name: MT + 'get_symbol_context', outcome: 'fail' },
        { tool_name: MT + 'recall_decision', outcome: 'fail' },
        { tool_name: 'Bash', outcome: 'fail' },
      ])
    )
  );
  const why = assertR8aAsk(d);
  assert.match(why, /no successful/);
});

test('38-02 precedence: a recorder-off ask does not mask the R1 treadmill deny at the same head', () => {
  const dp = depsWithLog(RECORDER_OFF, {
    readPostedReviews: () => [
      { commit_id: HEAD, state: 'CHANGES_REQUESTED', body: '## Re-Review — PR #42 · **1 BLOCKER(S) OPEN**' },
    ],
  });
  const d = runReviewArtifactGate(input('gh pr review 42 --approve'), dp);
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
  assert.match(d.permissionDecisionReason, /ENF-20 R1/);
});

test('38-02 precedence: `gh pr review 42 --approve && gh pr merge 42 --squash`, recorder off, no merge record → R13 deny', () => {
  const dp = depsWithLog(RECORDER_OFF, { files: absent(R13) });
  const d = runReviewArtifactGate(input('gh pr review 42 --approve && gh pr merge 42 --squash'), dp);
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
  assert.match(d.permissionDecisionReason, /ENF-20 R13/);
});

test('38-02 precedence: an override never flips the R8a ask; no receipt is written', () => {
  let receipt = null;
  const d = runReviewArtifactGate(
    input('gh pr review 42 --approve'),
    depsWithLog(RECORDER_OFF, {
      overrideImpl: {
        checkOverride: () => ({ override: true, reason: 'memtrace down' }),
        writeReceipt: (root, rec) => {
          receipt = rec;
        },
      },
    })
  );
  assertR8aAsk(d);
  assert.strictEqual(receipt, null, 'an ask is a policy decision, not an error: no receipt');
});

test('38-02 contract: readToolLog throws → deny', () => {
  const d = runReviewArtifactGate(
    input('gh pr review 42 --approve'),
    depsWithLog(() => {
      throw new Error('reader exploded');
    })
  );
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
  assert.match(d.permissionDecisionReason, /reader exploded/);
});

test('38-02 contract: readToolLog throws with override:true → allow and a review-artifact receipt (HARD-03 parity)', () => {
  let receipt = null;
  const d = runReviewArtifactGate(
    input('gh pr review 42 --approve'),
    depsWithLog(
      () => {
        throw new Error('reader exploded');
      },
      {
        overrideImpl: {
          checkOverride: () => ({ override: true, reason: 'recorder log on a dead disk' }),
          writeReceipt: (root, rec) => {
            receipt = rec;
          },
        },
      }
    )
  );
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
  assert.ok(receipt, 'a bypass must leave a receipt');
  assert.strictEqual(receipt.action, 'review-artifact');
});

for (const [label, value] of [['null', null], ['{}', {}], ["'x'", 'x']]) {
  test('38-02 contract: readToolLog returns ' + label + ' → deny (contract bug)', () => {
    const d = runReviewArtifactGate(input('gh pr review 42 --approve'), depsWithLog(value));
    assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
    assert.match(d.permissionDecisionReason, /ENF-20 contract bug: readToolLog/);
  });
}

test('38-02 budget: READ_BUDGET_MS × 3 fits inside the review-artifact hook timeout in settings.snippet.json', () => {
  const { READ_BUDGET_MS } = require('./lib/tool-log-reader.cjs');
  const settings = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'settings.snippet.json'), 'utf8'));
  const timeouts = [];
  (function walk(node) {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node && typeof node === 'object') {
      if (typeof node.command === 'string' && node.command.includes('review-artifact.cjs')) {
        timeouts.push(node.timeout);
      }
      Object.values(node).forEach(walk);
    }
  })(settings);
  assert.strictEqual(timeouts.length, 1, 'exactly one review-artifact hook is registered');
  assert.ok(Number.isFinite(timeouts[0]) && timeouts[0] > 0, 'it carries a numeric timeout');
  assert.ok(Number.isInteger(READ_BUDGET_MS) && READ_BUDGET_MS > 0);
  assert.ok(READ_BUDGET_MS * 3 <= timeouts[0] * 1000, READ_BUDGET_MS + ' ms × 3 vs ' + timeouts[0] + ' s');
});

test('38-02 R8a ask (real reader): GSD_CONTRIB_RECORD=off in process.env, default readToolLog → ask', () => {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'GSD_CONTRIB_RECORD');
  const prev = process.env.GSD_CONTRIB_RECORD;
  process.env.GSD_CONTRIB_RECORD = 'off';
  try {
    appendRecorderRows('sess-38-02-off', [MT + 'get_impact']);
    const dp = deps();
    delete dp.readToolLog;
    const d = runReviewArtifactGate(input('gh pr review 42 --approve', 'sess-38-02-off'), dp);
    const why = assertR8aAsk(d);
    assert.match(why, /GSD_CONTRIB_RECORD=off/);
  } finally {
    if (had) process.env.GSD_CONTRIB_RECORD = prev;
    else delete process.env.GSD_CONTRIB_RECORD;
  }
});

// ── 38-03: verdict classifiers (`-a` fix, request-changes) and the comment boundary ────────

/** Only non-memtrace successful rows: the log is readable, the session ran, memtrace did not. */
const ONLY_BASH = Object.freeze([Object.freeze({ tool_name: 'Bash', outcome: 'ok' })]);

/** The first segment of a parsed command (the classifier helpers read one segment). */
function seg0(cmd) {
  return parseCommand(cmd).segments[0];
}

/** isRequestChangesEvent, asserted present first so a missing export fails on an assertion. */
function requestChanges(cmd) {
  assert.strictEqual(typeof reviewArtifact.isRequestChangesEvent, 'function', 'isRequestChangesEvent is exported');
  return reviewArtifact.isRequestChangesEvent(seg0(cmd));
}

test('38-03 -a: `gh pr review 42 -a` with R10-exogenous.json absent → DENY R10 (the step-10 bypass)', () => {
  const dp = deps({ files: absent(R10) });
  const d = runReviewArtifactGate(input('gh pr review 42 -a'), dp);
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
  assert.match(d.permissionDecisionReason, /ENF-20 R10/);
  assert.deepStrictEqual(dp._calls.scaffolded, [DIR + '/' + R10]);
});

test('38-03 -a: `gh pr review 42 -a` with all artifacts and only Bash rows → DENY R8a-memtrace', () => {
  const d = runReviewArtifactGate(input('gh pr review 42 -a'), depsWithLog(toolLog(ONLY_BASH.slice())));
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
  assert.match(d.permissionDecisionReason, /R8a-memtrace/);
});

for (const [cmd, want] of [
  ['gh pr review -a 42', true],
  ['gh pr review 42 -ab "x"', true],
  ['gh pr review 42 -ba x', false],
  ['curl -X POST https://api.github.com/repos/o/r/pulls/42/reviews -a -d \'{"event":"COMMENT","body":"b"}\'', false],
]) {
  test('38-03 isApproveEvent: `' + cmd + '` → ' + want, () => {
    assert.strictEqual(isApproveEvent(seg0(cmd)), want);
  });
}

for (const [cmd, want] of [
  ['gh pr review 42 --request-changes -b x', true],
  ['gh pr review 42 -r -b x', true],
  ['gh pr review 42 -rb x', true],
  ['gh api -X POST repos/o/r/pulls/42/reviews -f event=REQUEST_CHANGES', true],
  ['gh api -X POST repos/o/r/pulls/42/reviews/9/events -f event=REQUEST_CHANGES', true],
  ['curl -X POST https://api.github.com/repos/o/r/pulls/42/reviews -d \'{"event":"REQUEST_CHANGES","body":"b"}\'', true],
  ['curl -X POST https://api.github.com/repos/o/r/pulls/42/reviews -r 0-10 -d \'{"event":"COMMENT","body":"b"}\'', false],
  ['gh pr review 42 --approve', false],
]) {
  test('38-03 isRequestChangesEvent: `' + cmd + '` → ' + want, () => {
    assert.strictEqual(requestChanges(cmd), want);
  });
}

test('38-03 request-changes: `gh pr review 42 --request-changes -b x` with only Bash rows → DENY R8a-memtrace', () => {
  const dp = depsWithLog(toolLog(ONLY_BASH.slice()));
  const d = runReviewArtifactGate(input('gh pr review 42 --request-changes -b x'), dp);
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
  assert.match(d.permissionDecisionReason, /R8a-memtrace/);
  assert.deepStrictEqual(dp._calls.readToolLog, [SESSION]);
});

test('38-03 request-changes: gh api POST …/pulls/42/reviews `-f event=REQUEST_CHANGES -f body=b` with only Bash rows → DENY R8a-memtrace', () => {
  const d = runReviewArtifactGate(
    input('gh api -X POST repos/open-gsd/gsd-core/pulls/42/reviews -f event=REQUEST_CHANGES -f body=b'),
    depsWithLog(toolLog(ONLY_BASH.slice()))
  );
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
  assert.match(d.permissionDecisionReason, /R8a-memtrace/);
});

test('38-03 comment: `gh pr review 42 --comment -b x` with only Bash rows → allow; the log is never read, nothing scaffolded', () => {
  const dp = depsWithLog(toolLog(ONLY_BASH.slice()));
  const d = runReviewArtifactGate(input('gh pr review 42 --comment -b x'), dp);
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
  assert.deepStrictEqual(dp._calls.readToolLog, [], 'a comment review never reads the recorder log');
  assert.ok(!dp._calls.scaffolded.includes(DIR + '/R8a-memtrace.json'), 'R8a-memtrace.json is not scaffolded');
  assert.deepStrictEqual(dp._calls.scaffolded, []);
});

test('38-03 comment: `gh pr review 42 -c -b x` with only Bash rows → allow; the log is never read', () => {
  const dp = depsWithLog(toolLog(ONLY_BASH.slice()));
  const d = runReviewArtifactGate(input('gh pr review 42 -c -b x'), dp);
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
  assert.deepStrictEqual(dp._calls.readToolLog, []);
  assert.deepStrictEqual(dp._calls.scaffolded, []);
});

test('38-03 comment: `gh pr review 42 --comment -b x` with R8-code-review.json absent → DENY R8-code (R8 unchanged for comments)', () => {
  const dp = depsWithLog(toolLog(ONLY_BASH.slice()), { files: absent(R8_CODE) });
  const d = runReviewArtifactGate(input('gh pr review 42 --comment -b x'), dp);
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
  assert.match(d.permissionDecisionReason, /ENF-20 R8-code/);
  assert.deepStrictEqual(dp._calls.readToolLog, []);
});

test('38-03 pending: gh api POST …/pulls/42/reviews `-f body=x` (no event) → the log is never read', () => {
  const dp = depsWithLog(toolLog(ONLY_BASH.slice()));
  const d = runReviewArtifactGate(input('gh api -X POST repos/open-gsd/gsd-core/pulls/42/reviews -f body=x'), dp);
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
  assert.deepStrictEqual(dp._calls.readToolLog, []);
  assert.deepStrictEqual(dp._calls.scaffolded, []);
});

test('38-03 request-changes: `gh pr review 42 -r -b x` with R10 absent and complete evidence → allow (request-changes never needs R10)', () => {
  const dp = deps({ files: absent(R10) });
  const d = runReviewArtifactGate(input('gh pr review 42 -r -b x'), dp);
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
  assert.deepStrictEqual(dp._calls.readToolLog, [SESSION], 'request-changes is a verdict: R8a read the log');
  assert.deepStrictEqual(dp._calls.scaffolded, []);
});

// ── 38-03: R8a scaffold-on-deny and the deny-path evidence rows ─────────────

const R8A = 'R8a-memtrace.json';
const R8A_PATH = DIR + '/' + R8A;

/** The R8a gate entry, asserted to carry a spec so a missing one fails on an assertion. */
function r8aEntry() {
  const e = GATES.find((x) => x.id === 'R8a-memtrace');
  assert.ok(e, 'the R8a-memtrace entry exists');
  assert.ok(e.spec && typeof e.spec === 'object', 'R8a-memtrace carries a scaffold spec');
  return e;
}

/** An approve against a COMPLETE log whose own successful rows are `records`. */
function approveWith(records, over = {}) {
  const dp = depsWithLog(toolLog(records), over);
  return { dp, d: runReviewArtifactGate(input('gh pr review 42 --approve'), dp) };
}

test('38-03 scaffold: complete log, missing evidence, artifact absent → DENY + scaffold; names the path, the tools and the ask-never-allow escape', () => {
  const { dp, d } = approveWith(ONLY_BASH.slice());
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
  assert.deepStrictEqual(dp._calls.scaffolded, [R8A_PATH], 'the R8a deny scaffolds the attestation');
  const why = d.permissionDecisionReason;
  assert.match(why, /ENF-20 R8a-memtrace \(re-review step 8a\)/);
  assert.ok(why.includes(R8A_PATH), 'the deny names the scaffold path: ' + why);
  for (const t of ALL_FIVE) assert.ok(why.includes(t), 'the deny names ' + t);
  assert.match(why, /human ask/i);
  assert.match(why, /never an allow/i);
});

test('38-03 scaffold: the R8a spec renders obligations only — FILL sentinels, constants exactly schema 1 + pass', () => {
  const e = r8aEntry();
  assert.doesNotThrow(() => validateSpec(e.spec));
  assert.strictEqual(e.file, undefined, 'R8a keeps `artifact`, never `file`');
  assert.strictEqual(e.artifact, R8A);
  const doc = JSON.parse(scaffold(e.spec));
  for (const k of ['head_oid', 'status', 'unavailable_reason']) {
    assert.ok(typeof doc[k] === 'string' && doc[k].startsWith('<<<FILL:' + k + '>>>'), k + ' is a FILL sentinel: ' + doc[k]);
  }
  assert.notStrictEqual(doc.status, 'unavailable', 'status is never pre-filled');
  const constants = {};
  for (const k of Object.keys(doc)) {
    if (k.startsWith('_') || ['head_oid', 'status', 'unavailable_reason'].includes(k)) continue;
    constants[k] = doc[k];
  }
  assert.deepStrictEqual(constants, { schema: 1, pass: 'memtrace-unavailable' });
});

test('38-03 scaffold: the fresh scaffold present + missing evidence → DENY naming status, unavailable_reason and head_oid as unfilled', () => {
  const e = r8aEntry();
  const { dp, d } = approveWith(ONLY_BASH.slice(), { files: { [R8A_PATH]: scaffold(e.spec) } });
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
  const why = d.permissionDecisionReason;
  for (const f of ['status', 'unavailable_reason', 'head_oid']) {
    assert.ok(why.includes('`' + f + '`'), 'the deny names `' + f + '` as unfilled: ' + why);
  }
  assert.match(why, /placeholder/i);
  assert.deepStrictEqual(dp._calls.scaffolded, [], 'a present file is never re-scaffolded');
});

for (const [label, res, re] of [
  ["{written:false, reason:'exists'}", { written: false, reason: 'exists' }, /already present/],
  ["{written:false, reason:'race'}", { written: false, reason: 'race' }, /already present/],
  ["{written:false, error:'EACCES'}", { written: false, reason: 'write-failed', error: 'EACCES' }, /could NOT be written[\s\S]*EACCES/],
]) {
  test('38-03 scaffold result: writeScaffold returns ' + label + ' → the deny says so', () => {
    const calls = [];
    const { d } = approveWith(ONLY_BASH.slice(), {
      writeScaffold: (rel) => {
        calls.push(rel);
        return Object.assign({ path: '/tmp/wt/' + rel }, res);
      },
    });
    assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
    assert.deepStrictEqual(calls, [R8A_PATH]);
    assert.match(d.permissionDecisionReason, re);
  });
}

test('38-03 source: a `### Memtrace Evidence` body naming all five tools, log with only Bash rows → DENY (evidence never comes from the body)', () => {
  const body = '## Re-Review\n\n### Memtrace Evidence\n' + ALL_FIVE.map((t) => '- ' + t + ': ran, no impact').join('\n');
  const dp = depsWithLog(toolLog(ONLY_BASH.slice()));
  const d = runReviewArtifactGate(input('gh pr review 42 --approve --body "' + body + '"'), dp);
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
  assert.match(d.permissionDecisionReason, /R8a-memtrace/);
});

test('38-03 evidence: the three memtrace tools with outcome fail plus Bash ok → DENY naming all of them', () => {
  const { d } = approveWith([
    { tool_name: MT + 'get_impact', outcome: 'fail' },
    { tool_name: MT + 'get_symbol_context', outcome: 'fail' },
    { tool_name: MT + 'recall_decision', outcome: 'fail' },
    { tool_name: 'Bash', outcome: 'ok' },
  ]);
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
  for (const t of ALL_FIVE) assert.ok(d.permissionDecisionReason.includes(t), 'the deny names ' + t);
});

for (const name of ['mcp__memtrace__get_impact_v2', 'MCP__MEMTRACE__GET_IMPACT', 'mcp__memtracex__get_impact', 'mcp__memtrace__']) {
  test('38-03 names: `' + name + '` never satisfies get_impact → DENY naming mcp__memtrace__get_impact', () => {
    const { d } = approveWith([
      { tool_name: MT + 'get_symbol_context', outcome: 'ok' },
      { tool_name: MT + 'recall_decision', outcome: 'ok' },
      { tool_name: name, outcome: 'ok' },
    ]);
    assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
    assert.ok(d.permissionDecisionReason.includes('`' + MT + 'get_impact`'), d.permissionDecisionReason);
  });
}

for (const verb of ['recall_decision', 'why_is_this_here', 'governing_contracts']) {
  test('38-03 any-of: `' + verb + '` alone satisfies the recorded-decision group → allow', () => {
    const { d } = approveWith([
      { tool_name: MT + 'get_impact', outcome: 'ok' },
      { tool_name: MT + 'get_symbol_context', outcome: 'ok' },
      { tool_name: MT + verb, outcome: 'ok' },
    ]);
    assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
  });
}

test('38-03 order: only get_impact present → the deny names get_symbol_context and the any-of group, not get_impact', () => {
  const { d } = approveWith([{ tool_name: MT + 'get_impact', outcome: 'ok' }, { tool_name: 'Bash', outcome: 'ok' }]);
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
  const why = d.permissionDecisionReason;
  assert.ok(why.includes(MT + 'get_symbol_context'));
  for (const v of ['recall_decision', 'why_is_this_here', 'governing_contracts']) assert.ok(why.includes(MT + v), v);
  assert.ok(!why.includes(MT + 'get_impact'), 'get_impact ran, so the deny does not name it: ' + why);
});

test('38-03 order: the same incomplete records in two different orders → byte-identical deny reasons', () => {
  const rows = [
    { tool_name: 'Bash', outcome: 'ok' },
    { tool_name: MT + 'get_symbol_context', outcome: 'ok' },
    { tool_name: MT + 'get_impact', outcome: 'fail' },
    { tool_name: 'Read', outcome: 'ok' },
  ];
  const a = approveWith(rows.slice()).d;
  const b = approveWith(rows.slice().reverse()).d;
  assert.strictEqual(a.permissionDecision, 'deny');
  assert.strictEqual(a.permissionDecisionReason, b.permissionDecisionReason);
});

test('38-03 order: R8-code-review.json absent + no memtrace → DENY R8-code; the log is never read', () => {
  const { dp, d } = approveWith(ONLY_BASH.slice(), { files: absent(R8_CODE) });
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
  assert.match(d.permissionDecisionReason, /ENF-20 R8-code/);
  assert.deepStrictEqual(dp._calls.readToolLog, []);
});

// ── 38-03: a filled unavailability attestation asks, never allows ───────────

const ATTESTED = 'memtrace sidecar down; used grep + /code-review';

/** A fully filled R8a-memtrace.json for this push. */
function filledR8a(over = {}) {
  return Object.assign(
    { schema: 1, pass: 'memtrace-unavailable', head_oid: HEAD, status: 'unavailable', unavailable_reason: ATTESTED },
    over
  );
}

/** An approve with only Bash rows (evidence missing) and `fileText` at the R8a path. */
function approveAttested(fileText, over = {}) {
  return approveWith(ONLY_BASH.slice(), Object.assign({}, over, { files: Object.assign({ [R8A_PATH]: fileText }, over.files || {}) }));
}

/** The quoted attestation in an R8a attestation ask, between « and ». */
function quotedAttestation(why) {
  const m = /«([\s\S]*?)»/.exec(why);
  assert.ok(m, 'the ask quotes the attestation between « and »: ' + why);
  return m[1];
}

/** Every filled-attestation ask: prefix, quoted reviewer attestation, cannot-verify, tools, note. */
function assertAttestAsk(d) {
  assert.strictEqual(d.permissionDecision, 'ask', d.permissionDecisionReason);
  const why = d.permissionDecisionReason;
  assert.ok(why.startsWith(R8A_ASK_PREFIX), why);
  assert.match(why, /unverified attestation/i);
  assert.match(why, /cannot verify/i);
  assert.match(why, /does not answer this prompt/);
  return why;
}

test('38-03 attest: filled attestation + missing evidence → ASK quoting the attested reason; the gate cannot verify it', () => {
  const { d } = approveAttested(text(filledR8a()));
  const why = assertAttestAsk(d);
  assert.strictEqual(quotedAttestation(why), ATTESTED);
  for (const t of ALL_FIVE) assert.ok(why.includes(t), 'the ask names ' + t);
});

for (const [label, oid, want] of [
  ['HEAD first 7 chars', HEAD.slice(0, 7), 'ask'],
  ['HEAD first 6 chars', HEAD.slice(0, 6), 'deny'],
  ['OTHER_HEAD', OTHER_HEAD, 'deny'],
]) {
  test('38-03 attest head_oid: ' + label + ' → ' + want, () => {
    const { d } = approveAttested(text(filledR8a({ head_oid: oid })));
    if (want === 'ask') {
      assertAttestAsk(d);
    } else {
      assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
      assert.match(d.permissionDecisionReason, /now heads at/);
    }
  });
}

for (const [label, status] of [["'Unavailable'", 'Unavailable'], ["'unavailаble' (U+0430)", 'unavail\u0430ble'], ["'available'", 'available']]) {
  test('38-03 attest status: ' + label + ' → deny', () => {
    const { d } = approveAttested(text(filledR8a({ status })));
    assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
    assert.match(d.permissionDecisionReason, /Set `status` to exactly `unavailable`/);
  });
}

for (const [label, reason] of [["''", ''], ["'   '", '   ']]) {
  test('38-03 attest reason: ' + label + ' → deny', () => {
    const { d } = approveAttested(text(filledR8a({ unavailable_reason: reason })));
    assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
    assert.match(d.permissionDecisionReason, /Record why memtrace could not run/);
  });
}

test("38-03 attest: pass 'code-review' (a copied R8 file) → deny", () => {
  const { d } = approveAttested(text(filledR8a({ pass: 'code-review' })));
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
  assert.match(d.permissionDecisionReason, /must record `pass: "memtrace-unavailable"`/);
});

for (const [label, body, re] of [["''", '', /the file is empty/], ["'{}'", '{}', /must record `pass: "memtrace-unavailable"`/]]) {
  test('38-03 attest file: ' + label + ' → deny', () => {
    const { d } = approveAttested(body);
    assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
    assert.match(d.permissionDecisionReason, re);
  });
}

test('38-03 attest: malformed JSON → fail-closed deny', () => {
  const { d } = approveAttested('{"schema": 1, "pass": "memtrace-unavailable",');
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
  assert.match(d.permissionDecisionReason, /not valid JSON/);
});

test('38-03 attest: filled attestation + COMPLETE evidence → allow; R8a-memtrace.json is never read', () => {
  const reads = [];
  const dp = deps({ files: { [R8A_PATH]: text(filledR8a()) } });
  const inner = dp.readArtifactText;
  dp.readArtifactText = (rel) => {
    reads.push(rel);
    return inner(rel);
  };
  const d = runReviewArtifactGate(input('gh pr review 42 --approve'), dp);
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
  assert.ok(!reads.includes(R8A_PATH), 'the attestation is not read when the evidence exists: ' + reads.join(', '));
});

test('38-03 attest: filled attestation + missing evidence + a prior re-review round at HEAD → DENY R1', () => {
  const { d } = approveAttested(text(filledR8a()), {
    readPostedReviews: () => [
      { commit_id: HEAD, state: 'CHANGES_REQUESTED', body: '## Re-Review — PR #42 · **1 BLOCKER(S) OPEN**' },
    ],
  });
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
  assert.match(d.permissionDecisionReason, /ENF-20 R1/);
});

test('38-03 sanitiser: a 2,000-char reason with control characters → at most 300 chars quoted, controls replaced, labelled unverified', () => {
  const reason = 'START\u0007\u001b[31m\nINJECT\u2028' + 'Z'.repeat(2000);
  const { d } = approveAttested(text(filledR8a({ unavailable_reason: reason })));
  const why = assertAttestAsk(d);
  const q = quotedAttestation(why);
  assert.ok(Array.from(q).length <= 300, 'quoted ' + Array.from(q).length + ' characters');
  assert.ok(!/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(q), 'no control character survives in the quote');
  assert.ok(q.startsWith('START  [31m INJECT '), 'controls are replaced with spaces: ' + JSON.stringify(q.slice(0, 24)));
  assert.ok(!why.includes('\u0007') && !why.includes('\u001b') && !why.includes('\u2028'));
  assert.ok(!/Z{301}/.test(why), 'no more than 300 characters of the reason reach the prompt');
});

/**
 * APPEND recorder rows built by tool-recorder's own recordToolCall + serializeRecord, with a
 * per-row outcome, cwd, tool_use_id and ts (the privacy markers). Never hand-written.
 */
function appendRecorderRowsWith(sessionId, rows) {
  const file = path.join(process.env.GSD_CONTRIB_LOG_DIR, LOG_FILENAME);
  for (const r of rows) {
    const payload = {
      hook_event_name: r.outcome === 'fail' ? 'PostToolUseFailure' : 'PostToolUse',
      session_id: sessionId,
      tool_use_id: r.tool_use_id || 'toolu_38_03',
      tool_name: r.tool_name,
      tool_input: r.tool_name === 'Bash' ? { command: 'ls' } : {},
      cwd: r.cwd || '/tmp/wt',
    };
    if (r.outcome === 'fail') payload.error = 'boom';
    else payload.tool_response = {};
    const deps0 = { env: {} };
    if (r.ts) deps0.now = () => r.ts;
    const line = serializeRecord(recordToolCall(JSON.stringify(payload), deps0));
    assert.ok(line, 'the recorder produced a line for ' + r.tool_name);
    fs.appendFileSync(file, line, 'utf8');
  }
}

test('38-03 forgery (real file): another session\'s memtrace rows and hand-written gate-verdict-shaped rows never count → DENY naming all memtrace tools', () => {
  const own = 'sess-38-03-forge';
  appendRecorderRows('sess-38-03-forge-other', ALL_FIVE);
  const file = path.join(process.env.GSD_CONTRIB_LOG_DIR, LOG_FILENAME);
  for (const t of [MT + 'get_impact', MT + 'get_symbol_context', MT + 'recall_decision']) {
    fs.appendFileSync(
      file,
      JSON.stringify({ ts: new Date().toISOString(), source: 'pretooluse-gate', session_id: own, tool_name: t, outcome: 'ok', cwd: '/tmp/wt' }) + '\n',
      'utf8'
    );
  }
  appendRecorderRows(own, ['Bash']);
  const dp = deps();
  delete dp.readToolLog;
  const d = runReviewArtifactGate(input('gh pr review 42 --approve', own), dp);
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
  for (const t of ALL_FIVE) assert.ok(d.permissionDecisionReason.includes(t), 'the deny names ' + t);
});

const PRIV = Object.freeze({
  cwd: '/tmp/CWDMARK_38_03_q7',
  tuid: 'TUIDMARK_38_03_q7',
  ts: 'TSMARK_38_03_q7',
  tool: 'mcp__secret__TOOLMARK_38_03_q7',
  other: 'SESSMARK_38_03_q7',
});

/** No privacy marker and no session id in a decision reason. */
function assertNoMarkers(why, ownSession) {
  for (const m of ['CWDMARK_38_03_q7', 'TUIDMARK_38_03_q7', 'TSMARK_38_03_q7', 'TOOLMARK_38_03_q7', 'SESSMARK_38_03_q7']) {
    assert.ok(!why.includes(m), 'the reason leaks ' + m + ': ' + why);
  }
  assert.ok(!why.includes(ownSession), 'the reason leaks the session id');
}

test('38-03 privacy (real file, deny): markers in cwd, tool_use_id, ts, a non-required tool and another session id never reach the reason', () => {
  const own = 'sess-38-03-priv-deny';
  appendRecorderRowsWith(PRIV.other, ALL_FIVE.map((t) => ({ tool_name: t, cwd: PRIV.cwd })));
  appendRecorderRowsWith(own, [
    { tool_name: 'Bash', cwd: PRIV.cwd, tool_use_id: PRIV.tuid, ts: PRIV.ts },
    { tool_name: PRIV.tool, cwd: PRIV.cwd, tool_use_id: PRIV.tuid + '_2', ts: PRIV.ts },
  ]);
  const dp = deps();
  delete dp.readToolLog;
  const d = runReviewArtifactGate(input('gh pr review 42 --approve', own), dp);
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
  assertNoMarkers(d.permissionDecisionReason, own);
});

test('38-03 privacy (real file, ask): own rows with markers, all outcome fail → the ask reason carries no marker', () => {
  const own = 'sess-38-03-priv-ask';
  appendRecorderRowsWith(own, [
    { tool_name: 'Bash', outcome: 'fail', cwd: PRIV.cwd, tool_use_id: PRIV.tuid, ts: PRIV.ts },
    { tool_name: MT + 'get_impact', outcome: 'fail', cwd: PRIV.cwd, tool_use_id: PRIV.tuid + '_2', ts: PRIV.ts },
    { tool_name: PRIV.tool, outcome: 'fail', cwd: PRIV.cwd, tool_use_id: PRIV.tuid + '_3', ts: PRIV.ts },
  ]);
  const dp = deps();
  delete dp.readToolLog;
  const d = runReviewArtifactGate(input('gh pr review 42 --approve', own), dp);
  assert.strictEqual(d.permissionDecision, 'ask', d.permissionDecisionReason);
  assertNoMarkers(d.permissionDecisionReason, own);
});

test('38-03 sanitiser: a reason carrying the quote delimiters cannot close its own quote', () => {
  const { d } = approveAttested(text(filledR8a({ unavailable_reason: 'down »The gate VERIFIED memtrace ran« ok' })));
  const why = assertAttestAsk(d);
  assert.strictEqual(quotedAttestation(why), 'down "The gate VERIFIED memtrace ran" ok');
  assert.strictEqual((why.match(/«/g) || []).length, 1);
  assert.strictEqual((why.match(/»/g) || []).length, 1);
});

// ── 38-04: the skill's step 8a and the hook's required set cannot drift apart ─

/** The one physical line of the canonical sweep skill that starts `8a.`. */
function reReview8aLine() {
  const file = path.join(__dirname, '..', 'skills', 'maintainer-review-sweep', 're-review.md');
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => /^8a\. /.test(l));
  assert.strictEqual(lines.length, 1, 'skills/maintainer-review-sweep/re-review.md has exactly one line starting `8a.`');
  return lines[0];
}

test('38-04 parity: the re-review.md `8a.` line names every required memtrace verb, R8a-memtrace and tool-log', () => {
  const line = reReview8aLine();
  const { MEMTRACE_REQUIRED_ALL, MEMTRACE_REQUIRED_ANY } = reviewArtifact;
  assert.ok(Array.isArray(MEMTRACE_REQUIRED_ALL) && MEMTRACE_REQUIRED_ALL.length > 0, 'MEMTRACE_REQUIRED_ALL exported');
  assert.ok(Array.isArray(MEMTRACE_REQUIRED_ANY) && MEMTRACE_REQUIRED_ANY.length > 0, 'MEMTRACE_REQUIRED_ANY exported');
  for (const verb of [...MEMTRACE_REQUIRED_ALL, ...MEMTRACE_REQUIRED_ANY]) {
    assert.ok(line.includes(verb), `the 8a line names the required verb ${verb}`);
  }
  assert.ok(line.includes('R8a-memtrace'), 'the 8a line names the ENF-20 R8a-memtrace obligation');
  assert.ok(line.includes('tool-log'), 'the 8a line names tool-recorder\'s tool-log as the evidence');
});

test('38-04 parity: the re-review.md `8a.` line keeps the "name the unavailable verb" rule', () => {
  assert.ok(reReview8aLine().includes('name the unavailable verb'));
});

// ── 38 review fix BL-01: the spawned hook emits a decision with a FIFO in the log slot ────
//
// The real entrypoint (`node hooks/review-artifact.cjs`), not the injectable seam: a temp root with
// the gsd-core sentinel layout and the R8/R10 artifacts, a fake `gh` first on PATH (canned PR
// number + head oid, an empty posted-review list), and a log dir whose rotated slot is a FIFO. A
// reader that blocks on the FIFO never emits, and the harness then treats the timed-out hook as
// allow; the fixed reader refuses the FIFO, the read is incomplete, and the hook emits an ask.

const { execFileSync, spawnSync } = require('node:child_process');

/** True when this platform has named pipes and `mkfifo`. */
function hasMkfifo() {
  if (process.platform === 'win32') return false;
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rev-art-fifo-probe-'));
  try {
    execFileSync('mkfifo', [path.join(d, 'p')], { stdio: 'ignore' });
    return true;
  } catch (_) {
    return false;
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
}

test('38 fix BL-01 e2e (spawned hook): a FIFO at tool-log.1.jsonl → the real entrypoint emits an ask, within its bound', { skip: !hasMkfifo() && 'no mkfifo on this platform' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rev-art-e2e-root-'));
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rev-art-e2e-log-'));
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rev-art-e2e-bin-'));
  try {
    // gsd-core sentinel layout (hooks/lib/resolve.cjs hasSentinel): scripts/ with one identity
    // script, and gsd-core/bin/lib/. Nothing here is executed.
    fs.mkdirSync(path.join(root, 'scripts'));
    fs.writeFileSync(path.join(root, 'scripts', 'issue-dedupe.cjs'), '');
    fs.mkdirSync(path.join(root, 'gsd-core', 'bin', 'lib'), { recursive: true });
    const adir = path.join(root, DIR);
    fs.mkdirSync(adir, { recursive: true });
    fs.writeFileSync(path.join(adir, R8_CODE), text(R8_CODE_OK));
    fs.writeFileSync(path.join(adir, R8_SEC), text(R8_SEC_OK));
    fs.writeFileSync(path.join(adir, R10), text(R10_OK));

    // Fake gh: `gh pr view …` → PR 42 at HEAD; every `gh api …` (the posted-review list) → empty.
    fs.writeFileSync(
      path.join(binDir, 'gh'),
      '#!/bin/sh\nif [ "$1" = "pr" ]; then printf \'%s\' \'{"number":42,"headRefOid":"' + HEAD + '"}\'; fi\nexit 0\n',
      { mode: 0o755 }
    );

    const sid = 'sess-38-fix-e2e-fifo';
    const live = serializeRecord(
      recordToolCall(
        JSON.stringify({
          hook_event_name: 'PostToolUse',
          session_id: sid,
          tool_use_id: 'toolu_e2e',
          tool_name: 'Bash',
          tool_input: { command: 'ls' },
          tool_response: {},
          cwd: '/tmp/wt',
        }),
        { env: {} }
      )
    );
    fs.writeFileSync(path.join(logDir, LOG_FILENAME), live);
    execFileSync('mkfifo', [path.join(logDir, 'tool-log.1.jsonl')]);

    const env = Object.assign({}, process.env, {
      PATH: binDir + path.delimiter + (process.env.PATH || ''),
      GSD_CONTRIB_LOG_DIR: logDir,
    });
    delete env.GSD_CONTRIB_RECORD;
    delete env.GSD_CONTRIB_OVERRIDE;

    const t0 = Date.now();
    const res = spawnSync(process.execPath, [path.join(__dirname, 'review-artifact.cjs')], {
      input: input('gh pr review 42 --approve', sid),
      encoding: 'utf8',
      cwd: root,
      env,
      timeout: 10000,
    });
    const elapsed = Date.now() - t0;
    assert.strictEqual(res.signal, null, 'the hook was killed after ' + elapsed + ' ms without a decision');
    assert.strictEqual(res.status, 0, res.stderr);
    assert.ok(elapsed < 5000, 'the hook decided in ' + elapsed + ' ms');
    const out = JSON.parse(res.stdout.trim().split('\n').pop());
    const hso = out.hookSpecificOutput;
    assert.strictEqual(hso.permissionDecision, 'ask', hso.permissionDecisionReason);
    assert.ok(hso.permissionDecisionReason.startsWith(R8A_ASK_PREFIX), hso.permissionDecisionReason);
    assert.match(hso.permissionDecisionReason, /unreadable tool-log\.1\.jsonl: not a regular file/);
  } finally {
    for (const d of [root, logDir, binDir]) fs.rmSync(d, { recursive: true, force: true });
  }
});
