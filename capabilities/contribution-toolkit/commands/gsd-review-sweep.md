---
description: Maintainer triage + re-review sweep of open-gsd/gsd-core — rank open issues/PRs by cost-to-advance and re-review change-requested PRs against real CI/source, following the maintainer-review-sweep skill exactly.
argument-hint: "(empty = triage sweep) | re-review #N | clear #N merge=#N"
allowed-tools: Skill, Bash, Read, Grep, Glob, AskUserQuestion
---

**BEFORE ANYTHING ELSE: invoke the Skill tool with `skill: "maintainer-review-sweep"` now.**

Do not list issues, post any review, relabel, dismiss, or merge until that skill is loaded. Once it is, follow it exactly:

- **Evidence is exogenous.** Every verdict and every reported number (CI conclusion, test count, `lint:ci`, `git diff`) must come from a command you actually ran and captured — never synthesized. If you couldn't run it, write "not run."
- **Respect the intake perimeter.** Don't work around the repo's bots; deliver a re-review as a single human-submitted formal review with the required disclaimer line.
- **Ball-in-court anchors to the latest `CHANGES_REQUESTED`**, not the latest review of any kind.
- **Read real check-runs on the head SHA** — branch protection is evaluate-mode, so "green" from the ruleset is not a gate; and a changeset-only commit can hide a stale failed Tests run.
- **Stop at merge-readiness.** Merge ONLY if the task below carries an explicit `merge=#N` token AND the verdict is a plain, evidence-backed CLEAR AND no other maintainer has an unresolved change-request.
- In sweep mode, present the ranked buckets and **await my pick** before any per-PR re-review.

Which GSD commands this toolkit delegates to, wraps, or leaves alone — and the methodology this path inherits — is documented in `docs/REUSE-AND-METHODOLOGY.md` (the reuse map governs which commands the sweep delegates to).

**Recovery Offramp.** If a gate **denies** an action during the sweep/re-review (or the skill surfaces a real blocking issue mid-triage), don't dead-stop and don't route around it: the deny stays **fail-closed/unbypassable** and this offramp is **advisory only** — it NEVER bypasses the gate or uses `GSD_CONTRIB_OVERRIDE` to dodge a real failure. Take one of two tracked paths, then return to the sweep once it's green: **`/gsd-quick`** for a trivial inline fix, or **`/gsd-debug`** (or `/gsd-discuss-phase`→`/gsd-plan-phase`→`/gsd-execute-phase`) for a tracked, resumable one. See the fuller **Recovery Offramp** section in the `gsd-core-contribution` skill for the full version.

**Interpreting my request below (it may be plain prose — figure out the mode):**
- Status / "what's ready" / "what should I clear" / "triage the repo" / empty → **sweep mode** (Phases 0–8).
- Names or describes a specific PR (a number, or e.g. "the roadmap rollback PR") → **re-review** it; resolve the PR number from the open list first. If the description matches more than one open PR, ask which before reviewing.
- Authorizes merging (e.g. "merge it if it's clean", "clear and merge it") → treat as the `merge=#N` token **for that one resolved PR only**, and still merge only if the re-review verdict is a plain CLEAR with no other maintainer's unresolved change-request. If the prose says "merge" but you cannot pin it to exactly one PR, ask which one before merging — never merge on a vague target.

My request:

$ARGUMENTS
