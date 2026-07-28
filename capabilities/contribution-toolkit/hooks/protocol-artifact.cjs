#!/usr/bin/env node
'use strict';

/**
 * hooks/protocol-artifact.cjs — PreToolUse(Bash) ENF-19 protocol-artifact gate
 * (CTK-ADR-0004, HARD-01 fail-closed, HARD-04 robust-parse, ENF-15 synonym coverage).
 *
 * The other twelve blocking gates enforce OUTCOMES: they parse the command's payload (an
 * issue body, a PR body, a commit message, an edited path) and check its content. That
 * leaves the P0-P6 steps which emit no payload at all — P1 reproduce-the-mechanism, P2 the
 * adversarial law pass + POLICY-01 ADR quoting, P3 TDD red-before-green. Those live ONLY in
 * `protocol-reminder.cjs`, the one advisory FAIL-OPEN hook, as prose fired once at
 * prompt-submit. Doing them and claiming them are indistinguishable, so the free option wins.
 *
 * This gate makes them enforceable the same way ENF-05 already made "run Tier-1 locally"
 * enforceable: give the step an ARTIFACT, and make the next outward write require it.
 *
 *   P1 -> `gh issue create`  a reproduction record carrying OBSERVED output.
 *   P2 -> `gh pr create`     quoted ADRs + a disposition-with-proof per finding.
 *   P3M-> `gh pr create`     a gsd-test matrix run id, verified LIVE and for staleness.
 *                          (protocol P3 also says "run the FULL relevant suites".)
 *   P3 -> `git push`         the red-before-green record.
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
 * The ENF-19 contract. A frozen table beside `POLICY_CHECKS` (policy-invariants) and
 * `SEALED_ACTIONS` (githooks-seal) rather than a `.artifact-gate.json` in gsd-core: a
 * root-level config file would be an untracked file in every worktree of a repo the toolkit
 * does not own, and a POLICY-02 commit hazard (CTK-ADR-0004 §Decision.2).
 *
 * Grouped by `on`, and within a group ordered CHEAPEST FIRST — P2's shape check runs before
 * the matrix gate reads a run off disk. The first unmet requirement denies. Assertions are what make an
 * artifact worth demanding: a file gated on mere existence gets one line of filler.
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
 * @returns {string}
 */
function denialText(g, rel, problem) {
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
    '\n\nWrite it as:\n  ' +
    g.shape.join('\n  ') +
    waiver +
    '\n\nThis step leaves no other trace, which is why it is the one that gets skipped. ' +
    'Write the artifact and continue — do not stop and ask. ' +
    'Deliberate bypass: a logged `GSD_CONTRIB_OVERRIDE=<reason>`. (CTK-ADR-0004)'
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
 * The pure gate decision, with every impure read injected.
 *
 * @param {string} stdinString raw PreToolUse JSON
 * @param {Object} deps
 * @param {() => (string|null)} deps.readBranch current branch, null on detached HEAD. MAY THROW.
 * @param {(rel: string) => boolean} deps.artifactExists worktree-relative existence check.
 * @param {(rel: string) => *} deps.readArtifact parsed JSON at a worktree-relative path. MAY THROW.
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
    if (g.on !== action.action) continue;

    const rel = dir + '/' + g.file;
    if (!deps.artifactExists(rel)) return deny(denialText(g, rel, null));

    const doc = deps.readArtifact(rel); // may throw (malformed JSON) -> fail closed

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
      if (!resolved.readArtifact) {
        resolved.readArtifact = (rel) => readJsonLive(path.join(root, rel), rel);
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
 * Read + parse a JSON artifact. A malformed artifact THROWS (fail closed): a contract that
 * silently fails to load is indistinguishable from having no gate at all.
 *
 * @param {string} abs absolute path
 * @param {string} rel path to name in the error
 * @returns {*}
 */
function readJsonLive(abs, rel) {
  let raw;
  try {
    raw = fs.readFileSync(abs, 'utf8');
  } catch (err) {
    throw new FailClosed('could not read `' + rel + '`: ' + ((err && err.message) || 'read failure'));
  }
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
  checkAssertion,
  checkWaiver,
  readPath,
  isNonEmpty,
  slugify,
  verifyMatrixRun,
  denialText,
  readBranchLive,
  readChangedPathsLive,
  readHeadCommittedAtLive,
  readMatrixRunLive,
  gsdTestStateDir,
  GATES,
  GOVERNED_ACTIONS,
  CONTRIB_BRANCH_RE,
  ARTIFACT_DIR,
  DISPOSITIONS,
  CODE_PATH_RE,
  WAIVER_PATH,
  MATRIX_SCHEMA_VERSION,
};
