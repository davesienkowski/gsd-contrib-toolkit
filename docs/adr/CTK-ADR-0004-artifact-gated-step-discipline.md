# CTK-ADR-0004: Enforce step discipline by requiring each step's artifact

- **Status:** Accepted
- **Review:** Published for maintainer review and open to revision — a changed decision will be recorded
  by a superseding/amending CTK-ADR, never a silent edit to this record.
- **Date:** 2026-07-27 (milestone v1.1)
- **Scope:** GSD Contribution Toolkit.
- **Amends:** CTK-ADR-0001 §Decision.1 ("Enforce outcomes, not steps") and its Consequences clause
  "step-level discipline cannot be hard-enforced". Those statements are narrowed, not withdrawn —
  see Decision below.
- **Relates to:** ENF-05/ENF-17 (`lint-ci-marker`, the toolkit's first artifact gate, written before
  the pattern was named); ENF-08 (`protocol-reminder`, the advisory layer this supplements).

## Context

CTK-ADR-0001 drew the enforcement boundary at *outcomes*: a gate denies a broken issue body, a
malformed PR, an un-green push, an edit to a generated file. It recorded as an accepted limitation
that "a hook cannot force a step, only block an outcome", and that process discipline such as TDD
"stays model-driven".

That limitation held for ten of the twelve blocking gates. It did **not** hold for ENF-05, which was
already doing the thing the ADR said was impossible: `lint-ci-marker` forces the *step* "run Tier-1
locally" by requiring the *artifact* that step leaves behind — a marker keyed to `git write-tree`.
The step became enforceable the moment it was given something to deposit.

Meanwhile the P0–P6 protocol steps that emit nothing remain unenforced. A grep of all thirteen wired
hooks for `adversarial|artificer|rubber|tdd|repro` returns real hits in exactly one file:
`protocol-reminder.cjs`, whose own header identifies it as "the ONE advisory, FAIL-OPEN hook in the
suite". So P1 (reproduce the mechanism live), P2 (adversarial law pass + POLICY-01 ADR quoting) and
P3 (TDD red-before-green) are governed only by prose delivered once at prompt-submit — the same
model-driven discipline CTK-ADR-0001's own pressure tests showed to be what fails.

The distinguishing property of the skipped set is not severity. Every one of them is marked
mandatory. It is **observability**: doing the step and claiming the step are indistinguishable, so
the free option wins. TDD partially survives precisely because a failing test is a *thing*.

## Decision

Extend enforcement to steps **by giving each step an artifact and gating the next outcome on it**.
This does not overturn CTK-ADR-0001's mechanism — the gate still fires on an outcome (a `gh issue
create`, a `gh pr create`, a `git push`) and still denies a result. What changes is the recognition
that the *precondition* of that outcome can be a prior step's deposited evidence, which makes the
step enforceable transitively.

1. **One engine, not a second gate system.** ENF-19 (`hooks/protocol-artifact.cjs`) is a
   toolkit-native gate built on the existing `lib/failclosed.cjs`, `lib/argv.cjs`, `lib/classify.cjs`
   and `lib/resolve.cjs`. It inherits HARD-01 fail-closed, HARD-04 robust-parse, ENF-15 REST-synonym
   coverage, and the single `GSD_CONTRIB_OVERRIDE` receipt channel. We explicitly reject installing a
   second, independent gate runtime with its own override env var, its own log file and its own
   failure posture.
2. **The contract is a frozen table in code, not a config file in gsd-core.** A root-level
   `.artifact-gate.json` in gsd-core would be an untracked file in every worktree of a repository the
   toolkit does not own, and a live commit hazard against POLICY-02. The gate table lives beside
   `POLICY_CHECKS` and `SEALED_ACTIONS` as tested source.
3. **Armed by contribution branch, not by a manual arm file.** A manual arm is itself an unobservable
   step and would simply not be performed. The branch-name pattern *is* the run boundary: ordinary
   work on `next` and detached HEADs are untouched, so the gate cannot become the "switched off
   within a week" kind.
4. **Assert shape, never mere presence.** A file whose only requirement is existence gets one line of
   filler. Gates assert enumerations, dispositions-with-proof, and observed-not-expected values.
5. **Reuse LIVE, never reimplement** (inherited from CTK-ADR-0001 §3). The matrix gate does not trust
   a self-reported test result: the artifact carries a `gsd-test` run id and the hook reads that run's
   real `failures.json` from the runner's own state directory, then checks it is newer than HEAD.

## Consequences

- **Positive:** the three highest-value unobservable steps become preconditions rather than
  intentions; the artifacts are durable, greppable evidence of a contribution's reasoning; ENF-05 is
  retroactively explained as an instance of a general pattern rather than a one-off.
- **Negative / accepted:** the hook checks *shape*, not *honesty* — an agent can still author a
  conforming artifact from its own head without doing the work. This is unavoidable and is the point:
  the gate converts skipping from free and silent into deliberate and recorded. It is a narrowing of
  the gap, not a closing of it, and must never be described as the latter.
- **Negative / accepted:** contribution branches now carry a mandatory `.gsd/contrib/<slug>/` payload.
  `.gsd` is already gitignored in gsd-core, so the artifacts never enter a PR.
- **Honesty constraint (inherited, load-bearing):** CTK-ADR-0001's rule that the unbypassable property
  belongs to the installed hooks — not to any wrapper, and not to the toolkit as a thing-in-itself —
  applies unchanged to ENF-19.

## Alternatives considered

- **Adopt the upstream `artifact-gates` hook as-is, alongside the toolkit** — rejected. Its `match`
  field is a bare regex over the raw command, so it would ship a `gh api -X POST /repos/…/issues`
  synonym bypass one hook away from `classify.cjs`, which already closes it (ENF-15). It also adds a
  second override channel (`ARTIFACT_GATE_OVERRIDE`) and a mixed failure posture (fail-open when
  unadopted, deny when malformed) next to the toolkit's uniform HARD-01.
- **Reimplement ENF-05's marker on top of the new engine** — rejected. The marker is keyed to
  `git write-tree` and lives inside `$GIT_DIR` so linked worktrees never collide; the generic engine
  has no tree-SHA key and no `$GIT_DIR` addressing. ENF-05 stays as it is.
- **Leave P1–P3 advisory and rely on ENF-08** — rejected: that is the status quo whose failure is the
  reason this record exists.
