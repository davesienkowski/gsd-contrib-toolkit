---
name: maintainer-review-sweep
description: Use when sweeping a GitHub repo you maintain (issues + PRs) to decide what to act on and to re-review stalled change-requested pull requests before merge. Triggers — "triage the repo", "what should I pick up / clear", "re-review this PR", "is this ready to merge". Repo-aware: open-gsd/gsd-core conventions baked in but parameterized.
---

# Maintainer Review Sweep

## Advisory-only on non-Claude runtimes

PreToolUse enforcement is a Claude Code harness feature. On non-Claude runtimes (Codex, OpenCode, …) this toolkit runs **advisory-only** — the gates are not enforced; treat its guidance as advice, not a hard block. Enforcement (the fail-closed PreToolUse deny) exists ONLY on the Claude Code runtime; everywhere else this skill's gates are guidance you must follow yourself, not a hard stop.

## Overview

A maintainer-grade triage + re-review pipeline. It ranks open work by **cost-to-advance** (a re-review beats a fresh design pass), then re-reviews change-requested PRs against the blocking reviewer's findings, the governing ADRs, and software-law lenses — and stops at "clear to merge" unless explicitly authorized.

**Core principle (load-bearing):** *Exogenous, evidence-grounded verification beats endogenous self-grading.* Every verdict must be defensible by external facts — real CI conclusions, real test output, real `git diff` — and by a fresh reviewer that never saw this verdict. An agent grading its own conclusion is the documented failure mode (LLM self-attribution bias is largest exactly on incorrect outputs), not the safeguard.

## When to use

- "Triage open issues/PRs", "what's ready", "what should I clear", "re-review #N", "is #N mergeable"
- Maintainer or codeowner context on a repo where external contributors open PRs

**Not for:** authoring your own feature (use the project's normal flow); reviewing a diff you just wrote in this same session (self-bias — get a fresh context).

## Inputs (Phase 0 — Scope)

| Input | Default |
|---|---|
| `repo` | `open-gsd/gsd-core` (always pass `--repo`; clone has multiple remotes) |
| `exclude-author` | the lead maintainer (e.g. `trek-e`) — **filter for ACTION, never hide**; still show their items, especially high-severity/security |
| `target branch` | the repo **default branch** (resolve via API; here `next`) — older release lines are out of scope |
| `merge token` | none. Merge only when the invocation explicitly carries `merge=#<n>` |

## The pipeline

Run in order. **Adversarial gate between every phase:** before advancing, state the strongest reason the previous phase's output is wrong, and resolve it. Re-fetch live state (PR HEAD OID, labels, reviews) immediately before any write — never act on a stale snapshot.

0. **Scope** — resolve repo, default branch, exclude-author, merge token.
1. **Discover** — list open issues + PRs (`gh ... --json number,title,author,labels,...`). Drop excluded-author from the *action* set (keep them visible). Tag next-relevance.
2. **Cross-reference in-flight work** — before ranking, map relationships across the open set: **duplicate/overlapping issues** (same defect by domain concept, not just wording), **issue ↔ PR links** (is this issue already addressed by an open PR?), and **PR ↔ PR collisions** (two PRs editing the same files/module → rebase-order or mutual-break risk). Group related `#numbers` so nothing is picked up, relabeled, or cleared in isolation. Carries into re-review.md step 7.
3. **Prioritize** — two lenses: quick-fix vs. highest user impact. Surface data-loss/security/runtime-broken first. Demote anything already covered by in-flight work (from Phase 2).
4. **State & cost-to-advance** — rank by cheapness to advance: *approved+rebase* < *brief-ready, no PR* < *re-review round* < *needs design*. A re-review ranks above a full design pass.
5. **Stranded-value sweep** — find issues with a complete brief but a missing `ready-for-agent` label; relabel them (a brief is the expensive part; the label is the only thing gating dispatch). Skip any superseded by an open PR (from Phase 2).
6. **Ball-in-court** — for change-requested PRs, anchor to the latest **`CHANGES_REQUESTED`** review (NOT the latest review of any kind). Author pushed *after* it → needs re-review (ball on reviewer). Otherwise author still owes changes.
7. **Authority reality** — read role, CODEOWNERS, and **rulesets** (note `enforcement: evaluate` = audit-only, NOT enforcing; `required_status_checks` in evaluate mode means CI is not gated — you must read real check conclusions yourself). Decide: can *you* clear it, or is a specific reviewer structurally required?
8. **Present & select (sweep mode).** Present the ranked buckets from Phases 2–7 — cost-to-advance tiers, ball-in-court, collisions, authority — and **await the user's pick** before any per-PR re-review. Skip this when invoked directly on a named PR (`re-review #N`). If persisting the report, write it to the repo's scratch location (`.planning/notes/` here — gitignored — or the repo's agreed scratch dir).
9. **Per-PR re-review** — for each *selected* PR, follow **[re-review.md](re-review.md)** (includes the ADR/source-of-truth pass and the cross-reference collision check). Produces a drafted review + verdict; submits only on human OK; merges only with the token AND a plain-`CLEAR`, evidence-backed verdict AND no other maintainer's *unresolved* change-request (a verifiably-resolved one is dismissed on human OK, not merged-over).

## Cross-cutting rules (always on)

- **Honesty of evidence (non-negotiable).** Local-verification numbers (`npm ci`, `build:lib`, `lint:ci`, test counts) must come from commands you *actually ran* and captured. If you could not run it, write "not run" — never synthesize a plausible count. Fabricated verification is the exact dishonesty this pipeline exists to prevent.
- **Respect the intake perimeter.** The repo's GitHub Actions (auto-close-unsolicited-prs, require-issue-link, dedupe, version-gate, dismiss-unauthorized-pr-approvals) are LIVE — never work around them. Deliver the re-review as a **single human-submitted formal review** (Approve if CLEAR, Request-changes if a code blocker remains) — never a bot auto-approval the perimeter may dismiss, and don't double-post a standalone comment alongside it.
- **Disclaimer on every tracker write:** `> *Generated by AI during triage; reviewed and posted by a human maintainer (@<you>).*` — use "submitted" for a formal review, "posted" for a comment, "dismissed" for a review dismissal.
- **Bounded comments — don't clutter the timeline.** One review body per round, ≤ ~200 visible words, verification depth in a single `<details>` fold, clean optional sections suppressed. Submit a formal review only when the verdict changes; edit a running comment for interim status. The hard template in [re-review.md](re-review.md) is the contract — post exactly it, no more.
- **Follow the `/triage` state machine** (one category role + one state role; flag conflicting states, ask before unusual transitions).
- **Handle labels exactly like the lead maintainer** — see **[labels.md](labels.md)**: remove `needs-triage` on any state transition; `confirmed-bug`(+`ready-for-agent`) is the bug fix-gate, `approved-enhancement`/`approved-feature` the code-gate; use `needs-reproduction` not generic needs-info; never hand-edit bot-managed labels (`possible-duplicate`, `needs-version`, `version-exempt`); apply the missing-label-on-PR maintainer one-click action; re-fetch labels before editing.
- **Don't clear over a lead's *unresolved* change-request.** Never merge while another maintainer has an *unresolved* `CHANGES_REQUESTED`. But if your re-review *verifiably confirms* the contributor resolved exactly what they requested, **dismiss** that stale CR (re-review.md 12a) with an evidence-cited message — fulfilling their conditions, not overriding them — rather than leaving the PR stuck awaiting a manual re-flip.
- **Delegate issue-side advancement to `/triage`.** This sweep ranks and relabels issues; for issues that need reproduction, grilling/design (`/grilling` + `/domain-modeling`), an `.out-of-scope/` prior-rejection check, or the needs-info loop, hand off to the `/triage` skill rather than reimplementing its state machine. The sweep identifies and routes; `/triage` advances.
- **Initial-triage assist for an incoming issue.** For a fast, LIVE-script-backed first call on a single freshly-opened issue (duplicate signal + version-gate finding + suggested canonical role + the `needs-triage` strip), use **[triage-assist.md](triage-assist.md)** (doer: `bin/triage-assist.cjs`). It **complements** this sweep — advisory and surface-only, it mutates nothing without explicit `--apply`, and the suggested role comes ONLY from LIVE `docs/agents/triage-labels.md`. It does not replace the sweep's ranking or the re-review path.

## Quick reference

| Want | Do |
|---|---|
| "Triage the repo" | Phases 0–8 (rank → present → you pick) |
| "Initial-triage an incoming issue #N" | [triage-assist.md](triage-assist.md) + `bin/triage-assist.cjs` (advisory: LIVE dedupe + version-gate + role, surface-only) |
| "Re-review #N" | Phase 0 + [re-review.md](re-review.md) on #N |
| "Clear #N to merge" | re-review.md; stop at merge-readiness unless `merge=#N` given |
| Ball-in-court of a PR | Phase 6 logic (anchor to latest CHANGES_REQUESTED) |

## Common mistakes (red flags — STOP)

- Comparing a commit to the *latest review* instead of the latest **CHANGES_REQUESTED** → wrong ball-in-court (a non-owner's approval does not clear an owner's change-request).
- Reporting test counts you did not run → fabrication. Run it or write "not run."
- Trusting "CI green" from the ruleset → it's in evaluate mode; read actual check-run conclusions.
- Grading your own verdict → self-bias. Use the exogenous reviewer in re-review.md.
- Dropping the excluded maintainer's high-severity/security issues from view → filter action, not visibility.
- Acting on a stale snapshot → re-fetch HEAD OID + reviews right before any relabel/post/merge.
- Posting a 2,000-line review of a 40-line fix → scope-freeze to the defect class.
- Re-reviewing the same PR on every push → dismiss-stale-on-push loop. Stop after 2 rounds without new substantive change; escalate to a human.
- Editing a generated `bin/lib/*.cjs` or trusting it as source → it's built from `src/*.cts` (ADR-457); verify the source changed and `build:lib` is clean.
- Posting a long multi-section review wall → use the hard size-bounded template (re-review.md); depth goes in the one `<details>`, never clobber the PR/issue history with repeated full dumps.

## Validation

Live-validated 2026-06-20 (RED→GREEN→REFACTOR per `superpowers:writing-skills`): on **#1409** the CI-attribution heuristic produced a wrong APPROVE (a coverage-table misread) — caught when the contributor's rebase falsified the "stale-base, rebase clears it" claim, corrected to Request-changes, and step 4a hardened to demand the literal failing assertion. On **#1418** it correctly Request-changed a changeset `product-name-purity` blocker that the prior reviewer's review predated. Both runs exercised the discover→re-review path end-to-end.
