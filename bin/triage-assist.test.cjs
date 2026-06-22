'use strict';

/**
 * bin/triage-assist.test.cjs — HERMETIC test of the OWN-01 advisory triage assist.
 *
 * The assist (`bin/triage-assist.cjs`) — given an incoming issue — calls LIVE
 * `scripts/issue-dedupe.cjs` (`scoreCandidates`) + `scripts/issue-version-gate.cjs`
 * (`evaluateVersionGate`), reads the canonical roles ONLY from LIVE
 * `docs/agents/triage-labels.md`, and surfaces the `needs-triage` strip + dedupe
 * signal + suggested role + exact `gh` remediation STRINGS — never mutating GitHub
 * without `--apply`.
 *
 * THIS test does NOT touch a real gsd-core checkout, the real `gh`, or the real
 * filesystem. It injects every impure seam (the two LIVE-script loaders, the `gh`
 * candidate fetcher, the role-source reader, and the mutate function) so the
 * advisory verdict math is proven offline. The cases mirror the plan's <behavior>:
 *   (a) a title >= 0.6 against a candidate list surfaces that #number + score.
 *   (b) a bug body missing a valid version surfaces the LIVE version-gate finding.
 *   (c) the suggested role comes from the LIVE triage-labels.md source — never a
 *       toolkit-computed value.
 *   (d) a throwing LIVE loader (ScriptResolveError) yields an explicit `error` and
 *       NO clean/no-duplicate/role-suggested verdict (LOUD on miss).
 *   (e) default invocation (no --apply) prints remediation strings and NEVER calls
 *       the injected mutate seam; mutate is reachable ONLY with --apply.
 *
 * @module bin/triage-assist.test
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  runTriageAssist,
  runCli,
  parseRolesFromTriageLabels,
} = require('./triage-assist.cjs');

// --- LIVE-script stub factories ------------------------------------------

// A stub of the LIVE issue-dedupe module. scoreCandidates mirrors the real
// pure contract: returns [{number,title,score}] for candidates >= threshold.
function makeDedupe(scored) {
  return {
    DEFAULT_THRESHOLD: 0.6,
    POSSIBLE_DUPLICATE_LABEL: 'possible-duplicate',
    scoreCandidates: (_title, _candidates, _opts) => scored.slice(),
  };
}

// A stub of the LIVE issue-version-gate module.
function makeVersionGate(result) {
  return {
    evaluateVersionGate: (_input) => result,
  };
}

// A canonical roles fixture mirroring the real LIVE triage-labels.md table shape.
const ROLE_SOURCE = `# Triage Labels

| Canonical role    | Label in this repo       | Notes |
|-------------------|--------------------------|-------|
| \`needs-triage\`    | \`needs-triage\`           | Auto-applied |
| \`needs-info\`      | \`needs-reproduction\`     | Waiting on reporter |
| \`ready-for-agent\` | \`confirmed-bug\`          | Bug verified |
| \`ready-for-human\` | \`approved-enhancement\` / \`approved-feature\` | Human codes it |
| \`wontfix\`         | \`wontfix\`                | Will not be actioned |

- \`needs-triage\` is removed when any other state label is applied.
`;

// Base deps: a clean (no-dup) issue with a valid version, role source present,
// and a mutate seam we assert is NOT called by default.
function baseDeps(over = {}) {
  let mutateCalls = 0;
  const deps = Object.assign(
    {
      gsdCoreRoot: '/fake/gsd-core',
      issue: { number: 42, title: 'Brand new unique subject', body: 'detail', labels: [] },
      loadDedupe: () => makeDedupe([]),
      loadVersionGate: () => makeVersionGate({ action: 'skip', reason: 'not-a-bug' }),
      fetchCandidates: () => [{ number: 7, title: 'something else entirely' }],
      readRoleSource: () => ROLE_SOURCE,
      mutate: () => {
        mutateCalls += 1;
      },
      apply: false,
    },
    over
  );
  deps._mutateCalls = () => mutateCalls;
  return deps;
}

// --- parseRolesFromTriageLabels unit -------------------------------------

test('parseRolesFromTriageLabels: extracts the canonical roles from the LIVE markdown table', () => {
  const roles = parseRolesFromTriageLabels(ROLE_SOURCE);
  assert.ok(roles.includes('ready-for-agent'));
  assert.ok(roles.includes('ready-for-human'));
  assert.ok(roles.includes('needs-info'));
  assert.ok(roles.includes('wontfix'));
  assert.ok(roles.includes('needs-triage'));
});

// --- (a) dedupe signal ---------------------------------------------------

test('(a) a candidate scoring >= 0.6 is surfaced as a likely-duplicate signal with #number + score', () => {
  const r = runTriageAssist(
    baseDeps({
      loadDedupe: () => makeDedupe([{ number: 7, title: 'matched issue', score: 0.83 }]),
    })
  );
  assert.equal(r.error, undefined);
  assert.equal(r.dedupe.likelyDuplicate, true);
  assert.equal(r.dedupe.candidates.length, 1);
  assert.equal(r.dedupe.candidates[0].number, 7);
  assert.ok(Math.abs(r.dedupe.candidates[0].score - 0.83) < 1e-9);
});

test('(a2) no candidate at/above threshold => no likely-duplicate signal', () => {
  const r = runTriageAssist(baseDeps());
  assert.equal(r.error, undefined);
  assert.equal(r.dedupe.likelyDuplicate, false);
  assert.equal(r.dedupe.candidates.length, 0);
});

// --- (b) version-gate finding --------------------------------------------

test('(b) a bug body missing a valid version surfaces the LIVE version-gate close finding', () => {
  const r = runTriageAssist(
    baseDeps({
      issue: { number: 42, title: 'crash on start', body: '### GSD Version\n_No response_', labels: ['bug'] },
      loadVersionGate: () => makeVersionGate({ action: 'close', reason: 'missing-version' }),
    })
  );
  assert.equal(r.error, undefined);
  assert.equal(r.versionGate.action, 'close');
  assert.equal(r.versionGate.reason, 'missing-version');
});

// --- (c) role from LIVE source only --------------------------------------

test('(c) the suggested role is one of the canonical roles read from the LIVE triage-labels.md source', () => {
  const r = runTriageAssist(baseDeps());
  assert.equal(r.error, undefined);
  const roles = parseRolesFromTriageLabels(ROLE_SOURCE);
  // The suggestion must be a member of the LIVE-sourced role set — never an
  // invented/toolkit-computed value.
  assert.ok(r.suggestedRole, 'a role should be suggested');
  assert.ok(roles.includes(r.suggestedRole), 'suggested role must come from the LIVE source');
  // And the result records the source list it was drawn from (provenance).
  assert.deepEqual(r.roleSource, roles);
});

test('(c2) a missing version on a bug routes the suggestion to the version-gate role from the LIVE source', () => {
  const r = runTriageAssist(
    baseDeps({
      issue: { number: 42, title: 'crash on start', body: 'no version', labels: ['bug'] },
      loadVersionGate: () => makeVersionGate({ action: 'close', reason: 'missing-version' }),
    })
  );
  assert.equal(r.error, undefined);
  // 'needs-info' is the canonical LIVE role for "waiting on reporter" (needs-version analog).
  assert.equal(r.suggestedRole, 'needs-info');
  assert.ok(r.roleSource.includes('needs-info'));
});

// --- (d) LOUD on a missing/unloadable LIVE script ------------------------

test('(d) a throwing dedupe loader yields an explicit error and NO clean/role verdict', () => {
  const r = runTriageAssist(
    baseDeps({
      loadDedupe: () => {
        const e = new Error('live script not found (no vendored fallback — fail closed)');
        e.name = 'ScriptResolveError';
        throw e;
      },
    })
  );
  assert.ok(r.error, 'a throwing LIVE loader must surface an explicit error');
  assert.equal(r.dedupe, undefined, 'no dedupe verdict on a LOUD miss');
  assert.equal(r.suggestedRole, undefined, 'no role suggested on a LOUD miss');
});

test('(d2) a throwing version-gate loader yields an explicit error and NO clean/role verdict', () => {
  const r = runTriageAssist(
    baseDeps({
      loadVersionGate: () => {
        const e = new Error('live script failed to load');
        e.name = 'ScriptResolveError';
        throw e;
      },
    })
  );
  assert.ok(r.error);
  assert.equal(r.suggestedRole, undefined);
});

test('(d3) an unreadable LIVE triage-labels.md source yields an explicit error, never a guessed role', () => {
  const r = runTriageAssist(
    baseDeps({
      readRoleSource: () => {
        throw new Error('ENOENT: triage-labels.md');
      },
    })
  );
  assert.ok(r.error);
  assert.equal(r.suggestedRole, undefined);
});

// --- (e) --apply mutation guard ------------------------------------------

test('(e) default invocation (no --apply) NEVER calls the mutate seam and surfaces gh remediation strings', () => {
  const deps = baseDeps();
  const r = runTriageAssist(deps);
  assert.equal(r.error, undefined);
  assert.equal(deps._mutateCalls(), 0, 'mutate must never run without --apply');
  // The remediation is surfaced as exact gh command STRINGS (apply-role + strip needs-triage).
  assert.ok(Array.isArray(r.remediation));
  assert.ok(r.remediation.some((c) => /gh /.test(c)));
  assert.ok(r.remediation.some((c) => /needs-triage/.test(c)), 'must surface the needs-triage strip');
  assert.equal(r.mutated, false);
});

test('(e2) the mutate seam is reachable ONLY with --apply', () => {
  const deps = baseDeps({ apply: true });
  const r = runTriageAssist(deps);
  assert.equal(r.error, undefined);
  assert.equal(deps._mutateCalls() > 0, true, 'mutate runs only when apply is set');
  assert.equal(r.mutated, true);
});

// --- runCli surface ------------------------------------------------------

test('runCli: returns 0 on a clean advisory run and writes to stdout', () => {
  const out = [];
  const code = runCli(
    Object.assign(baseDeps(), {
      write: (s) => out.push(s),
      writeErr: () => {},
    })
  );
  assert.equal(code, 0);
  assert.ok(out.join('').length > 0);
});

test('runCli: returns nonzero and writes LOUD to stderr on a LIVE-script miss (never a false clean)', () => {
  const err = [];
  const code = runCli(
    Object.assign(
      baseDeps({
        loadDedupe: () => {
          const e = new Error('ScriptResolveError: missing live script');
          e.name = 'ScriptResolveError';
          throw e;
        },
      }),
      { write: () => {}, writeErr: (s) => err.push(s) }
    )
  );
  assert.notEqual(code, 0);
  assert.ok(/LOUD|could NOT|error/i.test(err.join('')));
});
