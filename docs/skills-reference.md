# Skills reference

The toolkit ships **two** skills. A skill captures a gsd-core *process*; it is invoked three ways:
**automatically** when your request matches its trigger phrases, **explicitly** via the Skill tool
(`skill: "<name>"`), or **by a command** that loads it (see [commands-reference.md](commands-reference.md)).

> **Runtime note.** PreToolUse enforcement is a Claude Code harness feature. On non-Claude runtimes
> both skills run **advisory-only** — their gates are guidance you must follow yourself, not a hard
> stop (each `SKILL.md` carries this note).

---

## `gsd-core-contribution`

**What it is:** the gsd-core contribution pipeline — turning a verified finding into a properly-filed
`open-gsd/gsd-core` **bug/fix issue + pull request** that passes the repo's intake gates and matches
trek-e conventions.

**When it triggers:** "file this as an issue/PR", "submit the fix", "open a confirmed-bug", "work item
M-N as a fix PR", turning an audit/review finding into a contribution, and filing an epic + its children.
(Usually reached via [`/gsd-submit`](commands-reference.md#gsd-submit).)

**What it's capable of** — a gated **P0–P6** pipeline, run in order with an adversarial gate between
phases:

| Phase | Does |
|---|---|
| **STEP ZERO** | Create the P0–P6 checklist as **tool-tracked todos** (TodoWrite) before anything else. |
| **P0 — Ground in the canon** | Read CONTRIBUTING + templates + relevant ADRs + CONTEXT first, every time. |
| **P1 — Verify the finding** | Reproduce the mechanism live (`trust-but-verify`); if it can't be reproduced, withdraw/correct — don't file. |
| **P2 — Adversarial law pass** | Apply the `skills-from-the-artificer` law-lenses to the change (e.g. Hyrum's-Law behavior disclosure). |
| **P2b — Policy conformance** | Pre-file POLICY-01 check against gsd-core's mechanizable invariants. |
| **P3 — TDD the fix** | Red→green in a worktree off `next` (Pocock `tdd`); `build:lib` from source, never edit generated `bin/lib/*.cjs`. |
| **P4 — File the issue** | Validate the version-gate **first**, then file. |
| **P5 — Open the PR** | Validate the template/target gate **first**, then open. |
| **P6 — Confirm CI green** | Confirm Tests are green on the **latest** commit (head SHA), not a stale rollup. |

It also carries an **epic variant** (trek-e format), a **quick reference** (commands/gates/templates),
a **gotchas** list (verified live), a **rationalization table** (from real failures #1543/#1532), and a
**recovery offramp**.

**The two non-negotiables:** create the gated todos before acting; never open the issue/PR before its
gate is green.

**How it's used:**
- `/gsd-submit <finding>` — the primary trigger.
- Auto-triggers on the phrases above, or invoke `skill: "gsd-core-contribution"` directly.

**Sub-files:** [`reference.md`](../skills/gsd-core-contribution/reference.md) — commands, gate
definitions, and templates.

---

## `maintainer-review-sweep`

**What it is:** a maintainer's repo sweep — decide what to act on across open issues/PRs, and re-review
stalled change-requested pull requests before merge. Repo-aware: `open-gsd/gsd-core` conventions are
baked in but parameterized.

**When it triggers:** "triage the repo", "what should I pick up / clear", "re-review this PR", "is this
ready to merge". (Reached via [`/gsd-review-sweep`](commands-reference.md#gsd-review-sweep) and, for the
first-triage sub-procedure, [`/gsd-triage-assist`](commands-reference.md#gsd-triage-assist).)

**What it's capable of** — a sweep pipeline plus a re-review procedure:

| Stage | Does |
|---|---|
| **Phase 0 — Scope** | Gather the inputs (open issues/PRs, in-flight work). |
| **Prioritize** | Two lenses — quick-fix vs. highest user impact; surface data-loss/security/runtime-broken first; demote anything covered by in-flight work. |
| **Stranded-value sweep** | Find issues with a complete brief but a missing `ready-for-agent` label and relabel them (the brief is the expensive part). |
| **Re-review (`re-review.md`)** | Ball-in-court anchored to the latest `CHANGES_REQUESTED`; read real check-runs on the head SHA; deliver one human-submitted formal review with the required disclaimer. |
| **Merge-readiness** | Merge **only** on explicit authorization, a plain evidence-backed CLEAR, and no other maintainer's unresolved change-request. |
| **Triage-assist (`triage-assist.md`)** | Advisory first-pass: LIVE dedupe + version-gate + a canonical role from LIVE `triage-labels.md`; surface the label/strip commands, no auto-mutation. |

**Cross-cutting rules (always on):** evidence is exogenous (every number from a command you ran, else
"not run"); respect the repo's intake perimeter (don't work around its bots); stop at merge-readiness.

**How it's used:**
- `/gsd-review-sweep [empty | re-review #N | clear #N merge=#N]` — sweep / re-review / authorized merge.
- `/gsd-triage-assist [#N | <issue> | … --apply]` — the advisory first-triage sub-procedure.
- Auto-triggers on the phrases above, or invoke `skill: "maintainer-review-sweep"` directly.

**Sub-files:** [`labels.md`](../skills/maintainer-review-sweep/labels.md) (canonical labels/roles),
[`re-review.md`](../skills/maintainer-review-sweep/re-review.md) (the re-review procedure),
[`triage-assist.md`](../skills/maintainer-review-sweep/triage-assist.md) (the first-triage sub-procedure).

---

## See also

- [commands-reference.md](commands-reference.md) — the five commands that drive these skills.
- [foundations.md](foundations.md) — what each skill was designed after, and the toolkit's lineage.
