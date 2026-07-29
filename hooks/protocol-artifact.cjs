#!/usr/bin/env node
'use strict';

/**
 * hooks/protocol-artifact.cjs — PreToolUse(Bash) ENF-19 protocol-artifact gate
 * (CTK-ADR-0004, HARD-01 fail-closed, HARD-04 robust-parse, ENF-15 synonym coverage).
 *
 * The payload-inspecting blocking gates enforce OUTCOMES: they parse the command's payload (an
 * issue body, a PR body, a commit message, an edited path) and check its content. That
 * leaves the P0-P6 steps which emit no payload at all — P1 reproduce-the-mechanism, P2 the
 * adversarial law pass + POLICY-01 ADR quoting, P3 TDD red-before-green. Those live ONLY in
 * `protocol-reminder.cjs`, the one advisory FAIL-OPEN hook, as prose fired once at
 * prompt-submit. Doing them and claiming them are indistinguishable, so the free option wins.
 *
 * This gate makes them enforceable the same way ENF-05 already made "run Tier-1 locally"
 * enforceable: give the step an ARTIFACT, and make the next outward write require it.
 *
 *   STEP ZERO -> `gh issue create` / `gh pr create`  the P-step todos actually created.
 *   P0        -> `gh issue create` / `gh pr create`  the canon read, with an OBSERVED detail each.
 *   P0b       -> `gh pr create`     the POLICY-03 sweep: quoted clause + diff-vs-clause.
 *   P1        -> `gh issue create`  a reproduction record carrying OBSERVED output.
 *   P2        -> `gh pr create`     quoted ADRs + a disposition-with-proof per finding.
 *   P3M       -> `gh pr create`     a gsd-test matrix run id, verified LIVE and for staleness.
 *                                 (protocol P3 also says "run the FULL relevant suites".)
 *   P3        -> `git push`         the red-before-green record.
 *
 * ENF-20 (T4) added the first three. They were the last purely-ADVISORY contribution steps
 * precisely BECAUSE they emit nothing at all: a todo list, a read, and a grep sweep leave no
 * payload, so doing them and claiming them were indistinguishable. The `lib/scaffold.cjs`
 * engine is what made them gateable — the gate can now deposit the skeleton it wants, so the
 * "I don't know the required shape" friction disappears while the "you must supply OBSERVED
 * values" obligation is untouched.
 *
 * THE SCAFFOLD PRECONDITION (load-bearing, and the reason this file imports scaffold.cjs).
 * A placeholder string is `nonEmpty`. Measured on this very table: five of P2's six shape
 * assertions PASS on a completely unfilled skeleton — only `in: DISPOSITIONS` caught it, by
 * luck. So `hasUnfilledPlaceholders` runs on the artifact's RAW TEXT as a PRECONDITION, before
 * any assertion and before the waiver short-circuit, for EVERY entry including the
 * pre-existing P1/P2/P3. Without it, scaffolding would invert the mechanism: skipping would
 * become free, silent AND automatic. `protocol-artifact.test.cjs` asserts directly that a
 * freshly scaffolded artifact denies its own gate, for every entry in the table.
 *
 * ARMING (CTK-ADR-0004 §Decision.3): the contribution BRANCH is the arm. A manual arm file
 * would itself be an unobservable step and simply would not be created. On `next`/`main`, on
 * a detached HEAD, or on any non-contribution branch, every command passes untouched — so
 * this is not the "gating everything" anti-pattern that gets a toolkit switched off.
 *
 * WAIVERS are checkable, not self-asserted. A docs-only branch genuinely has no failing test
 * and no reason to spend ten minutes on a two-cell Docker matrix, so P3 and the matrix check accept an explicit
 * `not_applicable.reason`. But the waiver is then CHECKED against the real diff: if the
 * branch touched `src/`, `tests/`, `bin/`, `scripts/` or `hooks/`, "not applicable" is
 * refused. A waiver nobody can contradict is just a skip with extra steps.
 *
 * HONESTY (CTK-ADR-0004 §Consequences, load-bearing): this checks artifact SHAPE, not
 * honesty. An agent can still author a conforming artifact from its own head. The gate turns
 * skipping from free-and-silent into deliberate-and-recorded. It must never be described as
 * closing that gap.
 *
 * @module hooks/protocol-artifact
 */

const fs = require('node:fs');
const path = require('node:path');

const { parseCommand } = require('./lib/argv.cjs');
const { classifyAction, isNonGovernedCommand } = require('./lib/classify.cjs');
const { runGate, readHookInput, deny, allow, emit, FailClosed, safeCommand } = require('./lib/failclosed.cjs');
const { resolveRootForCommand } = require('./lib/resolve.cjs');
const {
  PLACEHOLDER_RE,
  hasUnfilledPlaceholders,
  writeScaffoldIfAbsent,
} = require('./lib/scaffold.cjs');

// FailClosed/safeCommand: shared IN-03 helpers from failclosed.cjs.

/** Actions this gate governs. Everything else is a no-op allow. */
const GOVERNED_ACTIONS = new Set(['issue-create', 'pr-create', 'push']);

/**
 * Branches that ARM the family. A contribution branch is `<type>/<issue#>-<slug>` per the
 * repo's branch convention; `next`/`main` and a detached HEAD are never armed.
 */
const CONTRIB_BRANCH_RE = /^(?:fix|feat|enh|docs|chore|perf|refactor)\//;

/** Where a run's artifacts live, relative to the worktree root. `.gsd` is gitignored. */
const ARTIFACT_DIR = '.gsd/contrib';

/** Dispositions a P2 finding may carry. "mention it in the PR body" is not one of them. */
const DISPOSITIONS = Object.freeze(['fixed', 'not-a-defect', 'filed']);

/**
 * Paths whose presence in the diff REFUTES a "not applicable" waiver. Touching any of these
 * means the branch changed behaviour, so "no test was needed" and "no matrix was needed" are
 * both false. Deliberately broad: `hooks/` and `scripts/` ship and break as readily as `src/`.
 */
const CODE_PATH_RE = /^(?:src|tests?|bin|scripts|hooks)\//;

/** The one representable form of "this step does not apply to this branch". */
const WAIVER_PATH = 'not_applicable.reason';

/**
 * STEP ZERO's required coverage: the P-step FAMILIES the checklist must enumerate.
 *
 * Matched by PREFIX, so the skill's real sub-steps (`P3a`..`P3d`, `P4a`..`P4c`) each cover
 * their family. That is deliberate: pinning the exact 17-line checklist would make this gate
 * go stale the first time the skill gains a step, and a stale gate that denies correct work is
 * worse than a slightly coarser one. What it still refuses is a checklist with a whole phase
 * missing — the actual failure mode ("I can hold the six phases in my head").
 *
 * Non-global regexes on purpose: a `/g` pattern carries `lastIndex` across `.test()` calls and
 * would answer differently on identical input.
 */
const P_STEP_FAMILIES = Object.freeze([
  Object.freeze({ name: 'P0', re: /^P0/ }),
  Object.freeze({ name: 'P1', re: /^P1/ }),
  Object.freeze({ name: 'P2', re: /^P2/ }),
  Object.freeze({ name: 'P3', re: /^P3/ }),
  Object.freeze({ name: 'P4', re: /^P4/ }),
  Object.freeze({ name: 'P5', re: /^P5/ }),
  Object.freeze({ name: 'P6', re: /^P6/ }),
]);

/**
 * P0's required coverage — the five canon surfaces Phase 0 says to read BEFORE authoring
 * (`CONTRIBUTING.md`, the matching issue template, the matching PR template, the governing
 * ADR(s), and `CONTEXT.md` for the touched area).
 *
 * Matched against each entry's recorded `path`, so this asserts WHICH canon was opened without
 * pinning a filename that the upstream repo owns and may rename.
 */
const P0_CANON = Object.freeze([
  Object.freeze({ name: 'CONTRIBUTING.md', re: /CONTRIBUTING/i }),
  Object.freeze({ name: 'the matching issue template (.github/ISSUE_TEMPLATE/…)', re: /ISSUE_TEMPLATE/i }),
  Object.freeze({ name: 'the matching PR template (.github/PULL_REQUEST_TEMPLATE/…)', re: /PULL_REQUEST_TEMPLATE/i }),
  Object.freeze({ name: 'a governing ADR under docs/adr/', re: /docs\/adr\// }),
  Object.freeze({ name: '`CONTEXT.md` for the touched area', re: /CONTEXT\.md/ }),
]);

/**
 * The ENF-19 contract. A frozen table beside `POLICY_CHECKS` (policy-invariants) and
 * `SEALED_ACTIONS` (githooks-seal) rather than a `.artifact-gate.json` in gsd-core: a
 * root-level config file would be an untracked file in every worktree of a repo the toolkit
 * does not own, and a POLICY-02 commit hazard (CTK-ADR-0004 §Decision.2).
 *
 * Grouped by `on` (a single action, or a LIST when one step precedes more than one outward
 * write), and within a group ordered CHEAPEST FIRST — every shape check runs before the matrix
 * gate reads a run off disk. The first unmet requirement denies. Assertions are what make an
 * artifact worth demanding: a file gated on mere existence gets one line of filler.
 *
 * Array order note: within the `issue-create` group P1 leads. Every entry in that group is a
 * pure shape check, so this is not a cost ordering — it is guidance ordering. A finding that
 * does not reproduce must be WITHDRAWN, and telling an agent to go write a todo list for a
 * contribution it should never file is worse advice than telling it to withdraw.
 *
 * `scaffold` (ENF-20) is the spec `lib/scaffold.cjs` renders when the artifact is ABSENT: the
 * gate denies AND deposits the skeleton. Every substantive field is an unfilled placeholder —
 * never a value — and the scaffold precondition then denies while any placeholder remains, so
 * a skeleton can never satisfy the gate that wrote it.
 */
const GATES = Object.freeze([
  Object.freeze({
    id: 'P1',
    on: 'issue-create',
    file: 'P1-repro.json',
    what: 'the reproduction that justifies filing',
    shape: [
      '{ "schema": 1,',
      '  "mechanism": "one sentence: the causal mechanism, not the symptom",',
      '  "reproduced": true,',
      '  "source_files": ["src/foo.cts:120"],',
      '  "evidence": [{ "command": "<what you ran>", "observed": "<what it PRINTED>" }] }',
    ],
    assert: Object.freeze([
      Object.freeze({ path: 'mechanism', nonEmpty: true,
        else: 'State the causal mechanism in one sentence. A symptom restated is not a mechanism.' }),
      Object.freeze({ path: 'reproduced', equals: true,
        else: 'P1 did not reproduce. No repro -> WITHDRAW the finding; do not file it.' }),
      Object.freeze({ path: 'source_files', nonEmpty: true,
        else: 'Cite the live source you reproduced against (src/*.cts, file:line).' }),
      Object.freeze({ path: 'evidence', nonEmpty: true,
        else: 'Record at least one command you ran and what it printed.' }),
      Object.freeze({ path: 'evidence', every: Object.freeze({ path: 'command', nonEmpty: true }),
        else: 'Every evidence entry needs the `command` that produced it.' }),
      Object.freeze({ path: 'evidence', every: Object.freeze({ path: 'observed', nonEmpty: true }),
        else: 'Every evidence entry needs `observed` — what the command ACTUALLY printed, ' +
          'not what you expected it to print.' }),
    ]),
    scaffold: Object.freeze({
      title: 'P1-repro.json',
      step: 'P1 — trust-but-verify: reproduce the mechanism live',
      what: 'the reproduction that justifies filing',
      constants: Object.freeze({ schema: 1 }),
      fields: Object.freeze([
        Object.freeze({ path: 'mechanism',
          observed: 'one sentence naming the CAUSAL mechanism you observed, not the symptom' }),
        Object.freeze({ path: 'reproduced',
          observed: 'replace this whole string with the JSON boolean true (not "true"), and ' +
            'only if it actually reproduced — if it did not, WITHDRAW the finding' }),
        Object.freeze({ path: 'source_files.0',
          observed: 'the live source you reproduced against, `src/foo.cts:120`' }),
        Object.freeze({ path: 'evidence.0.command', observed: 'the command you ran, verbatim' }),
        Object.freeze({ path: 'evidence.0.observed',
          observed: 'what it PRINTED, pasted — not what you expected it to print' }),
      ]),
    }),
  }),

  // ── ENF-20: the three steps that emit nothing on their own ────────────────

  Object.freeze({
    id: 'STEP-ZERO',
    on: Object.freeze(['issue-create', 'pr-create']),
    file: 'STEP-ZERO-todos.json',
    what: 'the P-step checklist as REAL tool-tracked todos',
    shape: [
      '{ "schema": 1,',
      '  "tracker": "TodoWrite",',
      '  "todos": [{ "step": "P0", "text": "<the todo text you actually created>" }, …] }',
    ],
    assert: Object.freeze([
      Object.freeze({ path: 'tracker', nonEmpty: true,
        else: 'Name the `tracker` that holds the todos (TodoWrite / TaskCreate / a persistent ' +
          'checklist file). A markdown checklist printed in a message is not a tracker — it ' +
          'scrolls out of context on exactly the long run where a gate gets dropped.' }),
      Object.freeze({ path: 'todos', nonEmpty: true,
        else: 'List the todos you created. A count or a "yes, I made them" is not an enumeration.' }),
      Object.freeze({ path: 'todos', every: Object.freeze({ path: 'step', nonEmpty: true }),
        else: 'Every todo entry needs the `step` id it tracks (`P0`, `P3b`, `P5c`, …).' }),
      Object.freeze({ path: 'todos', every: Object.freeze({ path: 'text', nonEmpty: true }),
        else: 'Every todo entry needs its `text` — the line as it stands in the tracker. A bare ' +
          'list of step ids is filler; it proves nothing was tracked.' }),
      Object.freeze({ path: 'todos',
        covers: Object.freeze({ path: 'step', require: P_STEP_FAMILIES }),
        else: 'The checklist must cover every P-step family P0 through P6 — the whole spine, ' +
          'created up front, not the phases you happen to be thinking about now.' }),
    ]),
    scaffold: Object.freeze({
      title: 'STEP-ZERO-todos.json',
      step: 'STEP ZERO (P-1) — create the checklist as tool-tracked todos',
      what: 'the P-step todos you created, in the tracker you actually used',
      constants: Object.freeze({ schema: 1 }),
      fields: Object.freeze([
        Object.freeze({ path: 'tracker',
          observed: 'the tracker tool you used, e.g. `TodoWrite` — a printed checklist is not one' }),
        Object.freeze({ path: 'todos.0.step',
          observed: 'the step id this todo tracks, e.g. `P0`; add one entry per todo, and P0 ' +
            'through P6 must all appear' }),
        Object.freeze({ path: 'todos.0.text',
          observed: 'the todo text as it stands in the tracker, copied out' }),
      ]),
    }),
  }),

  Object.freeze({
    id: 'P0',
    on: Object.freeze(['issue-create', 'pr-create']),
    file: 'P0-canon.json',
    what: 'the canon you read before authoring, with an OBSERVED detail per item',
    shape: [
      '{ "schema": 1,',
      '  "read": [{ "path": "CONTRIBUTING.md",',
      '              "observed": "<a line you QUOTE, or a specific claim it makes>" }, …] }',
      'Required: CONTRIBUTING.md, the matching ISSUE template, the matching PR template,',
      'each governing ADR under docs/adr/, and CONTEXT.md for the touched area.',
    ],
    assert: Object.freeze([
      Object.freeze({ path: 'read', nonEmpty: true,
        else: 'Record what you opened at Phase 0.' }),
      Object.freeze({ path: 'read', every: Object.freeze({ path: 'path', nonEmpty: true }),
        else: 'Every entry needs the `path` you opened.' }),
      Object.freeze({ path: 'read', every: Object.freeze({ path: 'observed', nonEmpty: true }),
        else: 'Every entry needs `observed` — a QUOTED line from that file, or a specific claim ' +
          'it makes. A filename list is the one-line filler this gate exists to refuse: it is ' +
          'satisfiable without opening anything.' }),
      Object.freeze({ path: 'read',
        covers: Object.freeze({ path: 'path', require: P0_CANON }),
        else: 'Phase 0 is not finished: some of the governing canon was never opened.' }),
    ]),
    scaffold: Object.freeze({
      title: 'P0-canon.json',
      step: 'P0 — ground in the canon (read first, every time)',
      what: 'what you read, and what each one actually said',
      constants: Object.freeze({ schema: 1 }),
      fields: Object.freeze([
        Object.freeze({ path: 'read.0.path',
          observed: 'a file you opened, e.g. `CONTRIBUTING.md`. Repeat the entry for the issue ' +
            'template, the PR template, each governing ADR under docs/adr/, and CONTEXT.md' }),
        Object.freeze({ path: 'read.0.observed',
          observed: 'a line QUOTED from that file, or a specific claim it makes — never a ' +
            'restatement of the filename' }),
      ]),
    }),
  }),

  Object.freeze({
    id: 'P0b',
    on: Object.freeze(['pr-create']),
    file: 'P0b-sweep.json',
    what: 'the POLICY-03 ADR/CONTEXT awareness sweep',
    shape: [
      '{ "schema": 1,',
      '  "sweep":  { "command": "<the grep/gsd-tools sweep you ran>",',
      '              "observed": "<what it PRINTED>" },',
      '  "adrs":   [{ "id": "ADR-0174", "quote": "<the clause you opened>",',
      '               "conforms_how": "conforms|conflicts because …" }],',
      '  "context_predicates": [{ "source": "sdk/CONTEXT.md", "predicate": "<the predicate>" }] }',
      'An area with no CONTEXT.md predicate is real — record `"context_predicates": []`; the',
      'sweep output above is then the record. An ABSENT key is a skip, not a finding.',
    ],
    assert: Object.freeze([
      Object.freeze({ path: 'sweep.command', nonEmpty: true,
        else: 'Record the sweep you ran over `docs/adr/` AND `CONTEXT.md` (POLICY-03 is a LIST ' +
          'produced by a grep/gsd-tools sweep, not a recollection).' }),
      Object.freeze({ path: 'sweep.observed', nonEmpty: true,
        else: 'Record what the sweep PRINTED — the hit list itself. A claimed sweep is not a sweep.' }),
      Object.freeze({ path: 'adrs', nonEmpty: true,
        else: 'List the governing ADRs/policies the sweep surfaced for the changed area.' }),
      Object.freeze({ path: 'adrs', every: Object.freeze({ path: 'id', nonEmpty: true }),
        else: 'Every ADR entry needs its `id`.' }),
      Object.freeze({ path: 'adrs', every: Object.freeze({ path: 'quote', nonEmpty: true }),
        else: 'POLICY-01: open and QUOTE the clause. An ADR id alone is a lead, not a fact — ' +
          '"I read about it" is not a conformance check.' }),
      Object.freeze({ path: 'adrs', every: Object.freeze({ path: 'conforms_how', nonEmpty: true }),
        else: 'Every ADR entry needs `conforms_how` — this diff versus that clause, stated: ' +
          '`conforms because …` or `conflicts because …`. (This gate records the statement; it ' +
          'does not adjudicate it. A LOCKED-decision conflict is yours to surface before filing.)' }),
      Object.freeze({ path: 'context_predicates',
        every: Object.freeze({ path: 'source', nonEmpty: true }),
        else: 'Every predicate entry needs the `source` CONTEXT.md it came from. Found none? ' +
          'Record the empty list `[]` — an omitted key is a skipped sweep.' }),
      Object.freeze({ path: 'context_predicates',
        every: Object.freeze({ path: 'predicate', nonEmpty: true }),
        else: 'Every predicate entry needs the `predicate` itself, quoted.' }),
    ]),
    scaffold: Object.freeze({
      title: 'P0b-sweep.json',
      step: 'P0b — ADR/CONTEXT awareness sweep (POLICY-03), run BEFORE authoring',
      what: 'the sweep, the clauses it surfaced, and how this diff stands against them',
      constants: Object.freeze({ schema: 1 }),
      fields: Object.freeze([
        Object.freeze({ path: 'sweep.command',
          observed: 'the grep / gsd-tools sweep you ran over docs/adr/ AND CONTEXT.md' }),
        Object.freeze({ path: 'sweep.observed',
          observed: 'what that sweep PRINTED — the hit list, pasted, not a summary of it' }),
        Object.freeze({ path: 'adrs.0.id', observed: 'the governing ADR id, e.g. `ADR-0174`' }),
        Object.freeze({ path: 'adrs.0.quote',
          observed: 'the clause you opened, quoted verbatim (POLICY-01: an id is a lead)' }),
        Object.freeze({ path: 'adrs.0.conforms_how',
          observed: 'how THIS diff stands against that clause: `conforms because …` / ' +
            '`conflicts because …`' }),
        Object.freeze({ path: 'context_predicates.0.source',
          observed: 'the CONTEXT.md you swept, e.g. `sdk/CONTEXT.md`. Found no predicate? ' +
            'Replace this whole list with [] — the sweep output above is then the record' }),
        Object.freeze({ path: 'context_predicates.0.predicate',
          observed: 'the predicate governing the touched area, quoted' }),
      ]),
    }),
  }),

  Object.freeze({
    id: 'P2',
    on: 'pr-create',
    file: 'P2-review.json',
    what: 'the adversarial law pass + POLICY-01 ADR conformance',
    shape: [
      '{ "schema": 1,',
      '  "adrs_consulted": [{ "id": "ADR-0174", "quote": "<the clause you actually opened>" }],',
      '  "laws_applied": ["hyrums-law", "galls-law"],',
      '  "findings": [{ "summary": "...", "disposition": "fixed|not-a-defect|filed",',
      '                 "proof": "<sha | why it is not a defect | issue #>" }] }',
    ],
    assert: Object.freeze([
      Object.freeze({ path: 'adrs_consulted', nonEmpty: true,
        else: 'POLICY-01: open and QUOTE the governing ADR(s). An unquoted ADR id is not a conformance check.' }),
      Object.freeze({ path: 'adrs_consulted', every: Object.freeze({ path: 'quote', nonEmpty: true }),
        else: 'Each ADR entry needs the `quote` you read, not just its id.' }),
      Object.freeze({ path: 'laws_applied', nonEmpty: true,
        else: 'P2: name the Artificer laws you applied to this diff (skills-from-the-artificer).' }),
      Object.freeze({ path: 'findings', every: Object.freeze({ path: 'disposition', in: DISPOSITIONS }),
        else: 'Every finding needs a disposition of ' + DISPOSITIONS.join(' | ') +
          '. "Too big to fold in" is a reason to FILE, never a reason to merely mention in the PR body.' }),
      Object.freeze({ path: 'findings', every: Object.freeze({ path: 'proof', nonEmpty: true }),
        else: 'Every finding needs `proof` — a sha for `fixed`, an issue number for `filed`, ' +
          'the reasoning for `not-a-defect`. `not-a-defect` requires the proof, not the assertion.' }),
    ]),
    scaffold: Object.freeze({
      title: 'P2-review.json',
      step: 'P2 — the adversarial law pass + POLICY-01 ADR conformance',
      what: 'the laws that fired, the ADRs you quoted, and each finding\'s disposition',
      constants: Object.freeze({ schema: 1 }),
      fields: Object.freeze([
        Object.freeze({ path: 'adrs_consulted.0.id', observed: 'the ADR id, e.g. `ADR-0174`' }),
        Object.freeze({ path: 'adrs_consulted.0.quote',
          observed: 'the clause you actually opened, quoted verbatim' }),
        Object.freeze({ path: 'laws_applied.0',
          observed: 'a law that FIRED on this diff, e.g. `hyrums-law` — do not force-fit laws' }),
        Object.freeze({ path: 'findings.0.summary',
          observed: 'the finding in one line. Found none? Replace this whole list with []' }),
        Object.freeze({ path: 'findings.0.disposition',
          observed: 'exactly one of ' + DISPOSITIONS.join(' | ') }),
        Object.freeze({ path: 'findings.0.proof',
          observed: 'a sha for `fixed`, an issue number for `filed`, the reasoning for ' +
            '`not-a-defect`' }),
      ]),
    }),
  }),

  Object.freeze({
    id: 'P3-matrix',
    on: 'pr-create',
    file: 'P3-matrix.json',
    what: 'the gsd-test matrix result',
    waiver: true,
    shape: [
      '{ "schema": 1, "run_id": "<the gsd-test run id>" }',
      'Produce it with:  gsd-test -base next -head HEAD',
      'The run id names a directory under the gsd-test state dir; this gate reads that run\'s',
      'real failures.json. Local `npm test` proves YOUR tree — gsd-test proves base-merged-with-head',
      'across Node 22 and 24, which is the signal a PR actually needs.',
    ],
    assert: Object.freeze([
      Object.freeze({ path: 'run_id', nonEmpty: true, else: 'Record the gsd-test run id.' }),
    ]),
    // Beyond shape: verify the run LIVE (CTK-ADR-0001 §3 reuse-live-never-reimplement).
    verify: 'gsd-test',
    scaffold: Object.freeze({
      title: 'P3-matrix.json',
      step: 'P3d — the gsd-test matrix across Node 22 and 24',
      what: 'the run id this gate reads the real failures.json from',
      constants: Object.freeze({ schema: 1 }),
      fields: Object.freeze([
        Object.freeze({ path: 'run_id',
          observed: 'the run id printed by `gsd-test -base next -head HEAD`. It names a ' +
            'directory under the gsd-test state dir; this gate reads that run\'s own ' +
            'failures.json, so an invented id fails' }),
      ]),
    }),
  }),

  Object.freeze({
    id: 'P3',
    on: 'push',
    file: 'P3-red.json',
    what: 'the red-before-green record',
    waiver: true,
    shape: [
      '{ "schema": 1,',
      '  "test_file": "tests/bug-1234-slug.test.cjs",',
      '  "red":   { "command": "<how you ran it>", "observed_failure": "<the FAILING output>" },',
      '  "green": { "command": "<how you ran it>", "observed_pass": "<the PASSING output>" } }',
    ],
    assert: Object.freeze([
      Object.freeze({ path: 'test_file', nonEmpty: true,
        else: 'Name the regression test file you wrote.' }),
      Object.freeze({ path: 'red.observed_failure', nonEmpty: true,
        else: 'Record the test FAILING first — its actual output. A test that was never red ' +
          'proves only that it passes, not that it detects the defect.' }),
    ]),
    scaffold: Object.freeze({
      title: 'P3-red.json',
      step: 'P3b/P3c — regression test written FIRST, watched FAIL, then GREEN',
      what: 'the red-before-green record',
      constants: Object.freeze({ schema: 1 }),
      fields: Object.freeze([
        Object.freeze({ path: 'test_file',
          observed: 'the regression test file you wrote, `tests/bug-1234-slug.test.cjs`' }),
        Object.freeze({ path: 'red.command', observed: 'how you ran it BEFORE the fix' }),
        Object.freeze({ path: 'red.observed_failure',
          observed: 'the FAILING output, pasted. If you wrote the fix first: stash it, build, ' +
            'watch RED, restore' }),
        Object.freeze({ path: 'green.command', observed: 'how you ran it after the fix' }),
        Object.freeze({ path: 'green.observed_pass', observed: 'the PASSING output, pasted' }),
      ]),
    }),
  }),
]);

// ── artifact reading ────────────────────────────────────────────────────────

/**
 * Branch name -> directory slug. `/` and anything exotic collapse to `-` so the slug is a
 * single path segment and can never escape ARTIFACT_DIR.
 *
 * @param {string} branch
 * @returns {string}
 */
function slugify(branch) {
  return String(branch).replace(/[^A-Za-z0-9._-]/g, '-');
}

/**
 * Resolve a dotted path against a parsed artifact. Supports `a.b.c` and numeric indices
 * (`a.0.b`). Deliberately NOT the full `list[key=value]` form — no gate in GATES needs it,
 * and untested predicate surface is exactly what a fail-closed gate should not carry.
 *
 * @param {*} obj
 * @param {string} dotted
 * @returns {*} the value, or undefined when any segment is absent.
 */
function readPath(obj, dotted) {
  const parts = String(dotted).split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = cur[p];
  }
  return cur;
}

/**
 * Is a resolved value "present"? An empty string, an all-whitespace string, an empty array
 * and an empty object are all ABSENT — that is what stops a one-line filler file from
 * satisfying the gate. `false` is absent too: a boolean flag set false is not evidence.
 *
 * @param {*} v
 * @returns {boolean}
 */
function isNonEmpty(v) {
  if (v === null || v === undefined) return false;
  if (typeof v === 'string') return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'boolean') return v === true;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return true;
}

/**
 * Evaluate one assertion against an artifact. Returns null when satisfied, or a denial
 * detail string when not.
 *
 * @param {*} doc the parsed artifact (or one array element, under `every`)
 * @param {Object} a the assertion
 * @returns {string|null}
 */
function checkAssertion(doc, a) {
  const v = readPath(doc, a.path);

  if (a.equals !== undefined) {
    return v === a.equals ? null : a.else;
  }
  if (a.in !== undefined) {
    return a.in.indexOf(v) !== -1 ? null : a.else;
  }
  if (a.every !== undefined) {
    // A non-array where an array was promised is a shape failure, not a vacuous pass.
    if (!Array.isArray(v)) {
      return a.else + ' (`' + a.path + '` is not a list)';
    }
    for (let i = 0; i < v.length; i += 1) {
      if (checkAssertion(v[i], a.every) !== null) {
        // Naming the index matters: "one of your findings lacks proof" sends the agent
        // re-reading the whole file; "findings[2]" sends it to the line.
        return a.else + ' (failing entry: `' + a.path + '[' + i + ']`)';
      }
    }
    return null;
  }
  if (a.covers !== undefined) {
    // A non-array where an array was promised is a shape failure, not a vacuous pass — and a
    // COUNT where an enumeration was promised lands here, which is the point.
    if (!Array.isArray(v)) {
      return a.else + ' (`' + a.path + '` is not a list)';
    }
    const inner = a.covers.path;
    const seen = v.map((el) => {
      const raw = inner ? readPath(el, inner) : el;
      return raw === null || raw === undefined ? '' : String(raw);
    });
    const missing = a.covers.require
      .filter((r) => !seen.some((s) => r.re.test(s)))
      .map((r) => r.name);
    if (missing.length === 0) return null;
    // Naming what is MISSING is the whole value of this predicate: "your list is incomplete"
    // sends the agent guessing; "you never opened CONTEXT.md" sends it to the file.
    return a.else + ' (missing: ' + missing.map((n) => '`' + n + '`').join(', ') + ')';
  }
  if (a.nonEmpty === true) {
    return isNonEmpty(v) ? null : a.else;
  }
  // An assertion with no recognised predicate is a contract bug — fail closed rather than
  // silently passing (a predicate typo must never read as "satisfied").
  throw new FailClosed('ENF-19 contract bug: assertion for `' + a.path + '` has no predicate');
}

/**
 * Render the denial. Written as INSTRUCTIONS: this is the only text the agent sees at the
 * moment it is blocked, and a denial is not a request for human input — it is a request for
 * the artifact.
 *
 * @param {Object} g the gate entry
 * @param {string} rel repo-relative artifact path
 * @param {string|null} problem the failed assertion's text, or null when the file is absent
 * @param {string} [note] the scaffold outcome, when one was deposited (ENF-20)
 * @returns {string}
 */
function denialText(g, rel, problem, note) {
  const head = problem
    ? 'ENF-19 ' + g.id + ' — `' + rel + '` does not yet record ' + g.what + '.\n' + problem
    : 'ENF-19 ' + g.id + ' — this action requires ' + g.what + ', and `' + rel + '` does not exist.';
  const waiver = g.waiver
    ? '\n\nGenuinely not applicable (a docs-only branch that touches no code)? Record it ' +
      'explicitly — `{ "schema": 1, "' + WAIVER_PATH.split('.')[0] + '": { "reason": "..." } }` — ' +
      'and note the waiver is checked against the real diff, not taken on trust.'
    : '';
  return (
    head +
    (note || '') +
    '\n\nWrite it as:\n  ' +
    g.shape.join('\n  ') +
    waiver +
    '\n\nThis step leaves no other trace, which is why it is the one that gets skipped. ' +
    'Write the artifact and continue — do not stop and ask. ' +
    'Deliberate bypass: a logged `GSD_CONTRIB_OVERRIDE=<reason>`. (CTK-ADR-0004)'
  );
}

// ── ENF-20: the scaffold precondition ───────────────────────────────────────

/**
 * The field names still carrying a placeholder, for the denial text.
 *
 * Built from `scaffold.cjs`'s OWN pattern rather than a second copy of the sentinel, so the two
 * can never drift: the DECISION always comes from `hasUnfilledPlaceholders`, and this is purely
 * presentation on top of it.
 *
 * @param {*} raw artifact text
 * @returns {string[]} up to six distinct field names (possibly empty — an eroded marker may
 *   carry no name, which does not make it any less unfilled).
 */
function unfilledFieldNames(raw) {
  if (typeof raw !== 'string') return [];
  const re = new RegExp(PLACEHOLDER_RE.source + '(?::([^>\\s"]+))?', 'g');
  const out = [];
  let m = re.exec(raw);
  while (m !== null && out.length < 6) {
    const name = m[1] ? m[1] : '';
    if (name && out.indexOf(name) === -1) out.push(name);
    m = re.exec(raw);
  }
  return out;
}

/**
 * The denial detail for an artifact that is still a skeleton.
 *
 * @param {Object} g the gate entry
 * @param {*} raw artifact text
 * @returns {string}
 */
function unfilledText(g, raw) {
  const names = unfilledFieldNames(raw);
  return (
    'It is still the SKELETON, carrying unfilled placeholder(s)' +
    (names.length ? ': ' + names.map((n) => '`' + n + '`').join(', ') : '') +
    '. A scaffold supplies the OBLIGATION, never the evidence — the toolkit will not do this ' +
    'step for you. Replace every remaining `FILL` marker with an OBSERVED value (what you ran ' +
    'and what it printed), or delete the line outright if the field does not apply.'
  );
}

/**
 * Deposit the skeleton for an ABSENT artifact and describe what happened, for the denial.
 *
 * Never throws: the caller is already denying, and a filesystem problem here must degrade to a
 * plain "write it yourself" deny rather than mask the policy denial behind a fail-closed one.
 * (A malformed spec is a contract bug, caught loudly by the test suite, which renders every
 * gate's spec.)
 *
 * @param {Object} g the gate entry
 * @param {string} rel repo-relative artifact path
 * @param {Object} deps
 * @returns {string} '' when no writer is wired.
 */
function scaffoldNote(g, rel, deps) {
  if (typeof deps.writeScaffold !== 'function' || !g.scaffold) return '';

  let res;
  try {
    res = deps.writeScaffold(rel, g.scaffold);
  } catch (err) {
    return (
      '\n\nA skeleton could not be written for you (' + ((err && err.message) || 'write failure') +
      ') — create `' + rel + '` by hand, in the shape below.'
    );
  }

  if (res && res.written === true) {
    return (
      '\n\nA SKELETON has been written for you at `' + rel + '`. Every field in it is an ' +
      'unfilled `FILL` placeholder, and this gate keeps denying while any placeholder remains: ' +
      'fill each one with an OBSERVED value. The skeleton removes the "what shape?" friction, ' +
      'nothing else.'
    );
  }
  if (res && (res.reason === 'exists' || res.reason === 'race')) {
    return '\n\nA skeleton is already present at `' + rel + '` — fill it in.';
  }
  return (
    '\n\nA skeleton could not be written for you (' +
    String((res && (res.error || res.reason)) || 'unknown') +
    ') — create `' + rel + '` by hand, in the shape below.'
  );
}

/**
 * Is a claimed "not applicable" waiver credible against the real diff? A waiver that nobody
 * can contradict is just a skip with extra steps, so this is the half that makes the escape
 * hatch honest.
 *
 * @param {Object} g the gate entry
 * @param {string[]} changed repo-relative paths changed on this branch
 * @returns {string|null} null when the waiver stands, else the denial detail.
 */
function checkWaiver(g, changed) {
  const offending = (Array.isArray(changed) ? changed : []).filter((p) => CODE_PATH_RE.test(String(p)));
  if (offending.length === 0) return null;
  return (
    'This branch claims ' + g.id + ' is `not_applicable`, but it changes code: ' +
    offending.slice(0, 5).map((p) => '`' + p + '`').join(', ') +
    (offending.length > 5 ? ' (+' + (offending.length - 5) + ' more)' : '') +
    '. A code change is exactly the case ' + g.id + ' exists for — remove the waiver and do the step.'
  );
}

// ── gsd-test live verification ──────────────────────────────────────────────

/** The gsd-test runner's state directory, honouring XDG_STATE_HOME. @returns {string} */
function gsdTestStateDir() {
  const xdg = process.env.XDG_STATE_HOME;
  const base = xdg && xdg.trim() ? xdg : path.join(require('node:os').homedir(), '.local', 'state');
  return path.join(base, 'gsd-test', 'runs');
}

/** The gsd-test failures.json schema this gate was written against. */
const MATRIX_SCHEMA_VERSION = 1;

/**
 * Verify a gsd-test run LIVE (CTK-ADR-0001 §3): read the runner's OWN `failures.json`
 * rather than trusting a self-reported verdict, and require the run to be NEWER than HEAD so
 * a stale green cannot vouch for new code (the staleness property ENF-05 gets by keying its
 * marker to `git write-tree`).
 *
 * The `schema_version` pin is deliberate. Without it a runner field rename would make every
 * lookup return undefined, `outcome !== 'passed'` would fire, and the deny would blame the
 * contributor's tests for a tooling change. Pinning turns that into a diagnosable message —
 * the same reason CTK-ADR-0001 §3 pairs live reuse with a doctor shape-check.
 *
 * @param {string} runId
 * @param {Object} deps
 * @param {(runId: string) => *} deps.readMatrixRun parsed failures.json. MAY THROW.
 * @param {() => (string|null)} deps.readHeadCommittedAt ISO-8601 commit time of HEAD.
 * @returns {string|null} null when the run vouches for this tree, else the denial detail.
 */
function verifyMatrixRun(runId, deps) {
  const run = deps.readMatrixRun(runId); // may throw -> fail closed (HARD-01)
  if (!run || typeof run !== 'object') {
    return 'gsd-test run `' + runId + '` has no readable failures.json.';
  }

  if (run.schema_version !== MATRIX_SCHEMA_VERSION) {
    throw new FailClosed(
      'gsd-test failures.json is schema_version ' + String(run.schema_version) + ', but ENF-19 ' +
        'was written against ' + MATRIX_SCHEMA_VERSION + '. The runner changed shape — update ' +
        'hooks/protocol-artifact.cjs rather than assuming this run is green.'
    );
  }

  const summary = run.summary || {};
  if (summary.outcome !== 'passed') {
    return 'gsd-test run `' + runId + '` reports outcome `' + String(summary.outcome) +
      '`, not `passed`. A red matrix is a defect to fix, not a note for the PR body.';
  }
  if (summary.total_failures !== 0) {
    return 'gsd-test run `' + runId + '` reports ' + String(summary.total_failures) + ' failures.';
  }

  const perOs = summary.per_os;
  if (!perOs || typeof perOs !== 'object' || Object.keys(perOs).length === 0) {
    return 'gsd-test run `' + runId + '` records no per-cell results — the matrix did not fan out.';
  }
  for (const cell of Object.keys(perOs)) {
    const c = perOs[cell] || {};
    if (c.failed !== 0 || !(c.total > 0)) {
      return 'gsd-test cell `' + cell + '` in run `' + runId + '` is not green (' +
        String(c.failed) + ' failed of ' + String(c.total) + ').';
    }
  }

  // Staleness: a run generated BEFORE the current HEAD commit vouches for older code.
  const generatedAt = Date.parse(summary.generated_at || '');
  const headAt = Date.parse(deps.readHeadCommittedAt() || '');
  if (Number.isFinite(generatedAt) && Number.isFinite(headAt) && generatedAt < headAt) {
    return 'gsd-test run `' + runId + '` predates the current HEAD commit, so it vouches for ' +
      'code that is no longer what you are filing. Re-run: `gsd-test -base next -head HEAD`.';
  }

  return null;
}

// ── the gate ────────────────────────────────────────────────────────────────

/**
 * Does this entry govern `act`? `on` is a single action, or a LIST when one protocol step
 * precedes more than one outward write (STEP ZERO and P0 precede both the issue and the PR).
 *
 * @param {Object} g the gate entry
 * @param {string} act the classified action
 * @returns {boolean}
 */
function gateGoverns(g, act) {
  return Array.isArray(g.on) ? g.on.indexOf(act) !== -1 : g.on === act;
}

/**
 * The pure gate decision, with every impure read injected.
 *
 * @param {string} stdinString raw PreToolUse JSON
 * @param {Object} deps
 * @param {() => (string|null)} deps.readBranch current branch, null on detached HEAD. MAY THROW.
 * @param {(rel: string) => boolean} deps.artifactExists worktree-relative existence check.
 * @param {(rel: string) => *} deps.readArtifact parsed JSON at a worktree-relative path. MAY THROW.
 * @param {(rel: string) => string} [deps.readArtifactText] RAW text for the placeholder scan.
 * @param {(rel: string, spec: Object) => Object} [deps.writeScaffold] deposits a skeleton.
 * @param {() => string[]} deps.readChangedPaths repo-relative paths changed on this branch.
 * @param {(runId: string) => *} deps.readMatrixRun parsed gsd-test failures.json. MAY THROW.
 * @param {() => (string|null)} deps.readHeadCommittedAt ISO-8601 commit time of HEAD.
 * @returns {{permissionDecision:string, permissionDecisionReason?:string}}
 */
function gate(stdinString, deps) {
  const input = readHookInput(stdinString);
  const command = (input.tool_input && input.tool_input.command) || '';

  const parsed = parseCommand(command);
  if (!parsed.ok) throw new FailClosed('unparseable command: ' + parsed.reason);

  const action = classifyAction(parsed);
  // ENF-15: an unclassifiable MUTATING github synonym is failClosed -> deny, never a pass.
  if (action && action.failClosed === true) {
    throw new FailClosed(
      'unclassifiable mutating GitHub command — ENF-19 cannot tell which protocol artifact it needs'
    );
  }
  if (!action || !GOVERNED_ACTIONS.has(action.action)) return allow();

  // ARM: the contribution branch is the run boundary (CTK-ADR-0004 §Decision.3).
  const branch = deps.readBranch(); // may throw -> fail closed
  if (!branch || branch === 'HEAD' || !CONTRIB_BRANCH_RE.test(branch)) return allow();

  const dir = ARTIFACT_DIR + '/' + slugify(branch);

  for (const g of GATES) {
    if (!gateGoverns(g, action.action)) continue;

    const rel = dir + '/' + g.file;
    // ENF-20: deny AND scaffold. The obligation is unchanged; only the "what shape?" friction
    // is removed. `scaffoldNote` never throws, so a write failure cannot mask this denial.
    if (!deps.artifactExists(rel)) return deny(denialText(g, rel, null, scaffoldNote(g, rel, deps)));

    const doc = deps.readArtifact(rel); // may throw (malformed JSON) -> fail closed

    // ── THE SCAFFOLD PRECONDITION (ENF-20, mandatory, runs first) ───────────
    // A placeholder string is `nonEmpty`, so the shape assertions below would pass an untouched
    // skeleton — five of P2's six do. This must therefore run BEFORE every assertion AND before
    // the waiver: an artifact still carrying unmet obligations is not a waivable artifact, it
    // is an unwritten one. Fails closed on a non-string (hasUnfilledPlaceholders' own posture).
    //
    // Preferred input is the RAW file text. When no raw reader is injected the scan falls back
    // to the re-serialised doc, which is equivalent for detection — the sentinels live in JSON
    // string values and keys, both of which `JSON.stringify` reproduces verbatim, and a
    // malformed artifact never reaches here (the parse above fails closed).
    const raw = deps.readArtifactText ? deps.readArtifactText(rel) : JSON.stringify(doc);
    if (hasUnfilledPlaceholders(raw)) return deny(denialText(g, rel, unfilledText(g, raw)));

    // A waiver short-circuits this gate's assertions — but only if the diff backs it up.
    if (g.waiver && isNonEmpty(readPath(doc, WAIVER_PATH))) {
      const bad = checkWaiver(g, deps.readChangedPaths());
      if (bad !== null) return deny(denialText(g, rel, bad));
      continue;
    }

    for (const a of g.assert) {
      const problem = checkAssertion(doc, a);
      if (problem !== null) return deny(denialText(g, rel, problem));
    }

    if (g.verify === 'gsd-test') {
      const detail = verifyMatrixRun(String(readPath(doc, 'run_id')), deps);
      if (detail !== null) return deny(denialText(g, rel, detail));
    }
  }

  return allow();
}

/**
 * Injectable entry seam. Defaults every reader to a live read bound to the resolved
 * gsd-core worktree.
 *
 * @param {string} stdinString raw PreToolUse JSON
 * @param {Object} [deps]
 * @returns {{permissionDecision:string, permissionDecisionReason?:string}}
 */
function runProtocolArtifactGate(stdinString, deps = {}) {
  const ctx = {
    command: safeCommand(stdinString),
    action: 'protocol-artifact',
    worktreeRoot: deps.worktreeRoot,
    overrideImpl: deps.overrideImpl,
  };

  return runGate(() => {
    // RES-01 (D-07 uniformity): short-circuit a confidently non-governed command BEFORE any
    // filesystem walk. Unparseable / failClosed / governed commands fall through unchanged.
    if (isNonGovernedCommand(parseCommand(ctx.command), GOVERNED_ACTIONS)) return allow();

    const resolved = Object.assign({}, deps);
    const needsRoot =
      !resolved.readBranch || !resolved.artifactExists ||
      !resolved.readArtifact || !resolved.readChangedPaths || !resolved.readHeadCommittedAt;

    if (needsRoot) {
      const root = resolved.worktreeRoot || resolveRootForCommand(ctx.command, process.cwd());
      if (!root) return allow();
      ctx.worktreeRoot = ctx.worktreeRoot || root;
      if (!resolved.readBranch) resolved.readBranch = () => readBranchLive(root);
      if (!resolved.artifactExists) {
        resolved.artifactExists = (rel) => fs.existsSync(path.join(root, rel));
      }
      // One read per artifact, shared by the parse and the placeholder scan. Reading twice
      // would also let the file change between them — the shape check and the sentinel scan
      // must judge the same bytes.
      const rawCache = new Map();
      const rawOf = (rel) => {
        if (!rawCache.has(rel)) rawCache.set(rel, readTextLive(path.join(root, rel), rel));
        return rawCache.get(rel);
      };
      if (!resolved.readArtifact) resolved.readArtifact = (rel) => parseJsonText(rawOf(rel), rel);
      if (!resolved.readArtifactText) resolved.readArtifactText = rawOf;
      if (!resolved.writeScaffold) {
        resolved.writeScaffold = (rel, spec) => writeScaffoldLive(root, rel, spec);
      }
      if (!resolved.readChangedPaths) resolved.readChangedPaths = () => readChangedPathsLive(root);
      if (!resolved.readHeadCommittedAt) {
        resolved.readHeadCommittedAt = () => readHeadCommittedAtLive(root);
      }
    }
    if (!resolved.readMatrixRun) resolved.readMatrixRun = readMatrixRunLive;

    return gate(stdinString, resolved);
  }, ctx);
}

// ── live readers ────────────────────────────────────────────────────────────

/**
 * Live `git rev-parse --abbrev-ref HEAD`. Returns null on a detached HEAD. THROWS on a real
 * git failure so runGate fails closed (HARD-01).
 *
 * @param {string} root absolute worktree root
 * @returns {string|null}
 */
function readBranchLive(root) {
  const { spawnSync } = require('node:child_process');
  const res = spawnSync('git', ['-C', root, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' });
  if (res.error) throw new FailClosed('could not read the current branch: ' + res.error.message);
  if (res.status !== 0) {
    throw new FailClosed('git rev-parse --abbrev-ref HEAD failed (exit ' + res.status + ')');
  }
  const out = String(res.stdout || '').trim();
  if (!out || out === 'HEAD') return null;
  return out;
}

/**
 * Paths changed on this branch relative to its merge-base with the default branch. THROWS on
 * a git failure: an unreadable diff must not silently validate a waiver (HARD-01).
 *
 * @param {string} root
 * @returns {string[]} repo-relative paths (possibly empty)
 */
function readChangedPathsLive(root) {
  const { spawnSync } = require('node:child_process');
  const run = (args) => spawnSync('git', ['-C', root].concat(args), { encoding: 'utf8' });

  // Prefer the merge-base with the upstream default branch; fall back to HEAD~1 for a
  // freshly-branched tree where origin/next is not fetched.
  let base = '';
  for (const ref of ['origin/next', 'origin/main', 'next', 'main']) {
    const mb = run(['merge-base', 'HEAD', ref]);
    if (!mb.error && mb.status === 0) {
      base = String(mb.stdout || '').trim();
      if (base) break;
    }
  }

  const args = base ? ['diff', '--name-only', base, 'HEAD'] : ['diff', '--name-only', 'HEAD~1', 'HEAD'];
  const res = run(args);
  if (res.error) {
    throw new FailClosed('could not read the branch diff: ' + res.error.message);
  }
  if (res.status !== 0) {
    throw new FailClosed(
      'could not read the branch diff (`git ' + args.join(' ') + '` exit ' + res.status +
        '). A waiver cannot be validated against an unreadable diff.'
    );
  }
  return String(res.stdout || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * ISO-8601 committer date of HEAD. Returns null when unreadable — staleness then degrades to
 * "unchecked" rather than denying, because the shape and liveness checks are the load-bearing
 * ones and a repo with no commits is not a policy violation.
 *
 * @param {string} root
 * @returns {string|null}
 */
function readHeadCommittedAtLive(root) {
  const { spawnSync } = require('node:child_process');
  const res = spawnSync('git', ['-C', root, 'log', '-1', '--format=%cI'], { encoding: 'utf8' });
  if (res.error || res.status !== 0) return null;
  const out = String(res.stdout || '').trim();
  return out || null;
}

/**
 * Read an artifact's RAW text. THROWS (fail closed) when it cannot be read.
 *
 * @param {string} abs absolute path
 * @param {string} rel path to name in the error
 * @returns {string}
 */
function readTextLive(abs, rel) {
  try {
    return fs.readFileSync(abs, 'utf8');
  } catch (err) {
    throw new FailClosed('could not read `' + rel + '`: ' + ((err && err.message) || 'read failure'));
  }
}

/**
 * Parse artifact text. A malformed artifact THROWS (fail closed): a contract that silently
 * fails to load is indistinguishable from having no gate at all.
 *
 * @param {string} raw
 * @param {string} rel path to name in the error
 * @returns {*}
 */
function parseJsonText(raw, rel) {
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new FailClosed(
      '`' + rel + '` is not valid JSON (' + ((err && err.message) || 'parse failure') +
        '). Fix the artifact — a malformed one cannot vouch for anything.'
    );
  }
}

/**
 * Read + parse a JSON artifact.
 *
 * @param {string} abs absolute path
 * @param {string} rel path to name in the error
 * @returns {*}
 */
function readJsonLive(abs, rel) {
  return parseJsonText(readTextLive(abs, rel), rel);
}

/**
 * Deposit a skeleton under the worktree's artifact dir, and only there.
 *
 * `slugify` already collapses a branch name to one path segment, so the containment check is
 * belt-and-braces — but this function writes to disk on behalf of a gate, and a writer whose
 * only defence is a caller's sanitiser is one refactor away from being a file-planting
 * primitive. Refusals are RETURNED: the caller is already denying and just needs to say what
 * happened (`scaffoldNote`).
 *
 * @param {string} root absolute worktree root
 * @param {string} rel repo-relative artifact path
 * @param {Object} spec see lib/scaffold.cjs
 * @returns {{written:boolean, path:string, bytes?:number, reason?:string, error?:string}}
 */
function writeScaffoldLive(root, rel, spec) {
  const abs = path.resolve(root, rel);
  const dirAbs = path.resolve(root, ARTIFACT_DIR);
  if (abs.indexOf(dirAbs + path.sep) !== 0) {
    return { written: false, path: abs, reason: 'outside-artifact-dir' };
  }
  return writeScaffoldIfAbsent(abs, spec);
}

/**
 * Read a gsd-test run's failures.json from the runner's own state directory. THROWS when the
 * run id names nothing — an unverifiable run must not pass.
 *
 * @param {string} runId
 * @returns {*}
 */
function readMatrixRunLive(runId) {
  const safe = String(runId).replace(/[^A-Za-z0-9._-]/g, '');
  if (!safe) throw new FailClosed('ENF-19 P3-matrix: empty gsd-test run id');
  const abs = path.join(gsdTestStateDir(), safe, 'failures.json');
  if (!fs.existsSync(abs)) {
    throw new FailClosed(
      'ENF-19 P3-matrix: no gsd-test run `' + safe + '` under ' + gsdTestStateDir() +
        '. Run `gsd-test -base next -head HEAD` and record its run id.'
    );
  }
  return readJsonLive(abs, 'gsd-test run ' + safe + '/failures.json');
}

function main() {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => {
    buf += c;
  });
  process.stdin.on('end', () => {
    emit(runProtocolArtifactGate(buf));
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  runProtocolArtifactGate,
  gate,
  gateGoverns,
  checkAssertion,
  checkWaiver,
  readPath,
  isNonEmpty,
  slugify,
  verifyMatrixRun,
  denialText,
  unfilledFieldNames,
  unfilledText,
  scaffoldNote,
  readBranchLive,
  readChangedPathsLive,
  readHeadCommittedAtLive,
  readMatrixRunLive,
  readTextLive,
  parseJsonText,
  writeScaffoldLive,
  gsdTestStateDir,
  GATES,
  GOVERNED_ACTIONS,
  CONTRIB_BRANCH_RE,
  ARTIFACT_DIR,
  DISPOSITIONS,
  CODE_PATH_RE,
  WAIVER_PATH,
  MATRIX_SCHEMA_VERSION,
  P_STEP_FAMILIES,
  P0_CANON,
};
