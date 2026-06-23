---
name: gsd-core-contribution
description: Use when filing or preparing a bug/fix issue and pull request for the open-gsd/gsd-core repository — including turning an audit or review finding into a contribution, filing a confirmed-bug + fix PR, or filing an epic and its children. Triggers include "file this as an issue/PR", "submit the fix", "open a confirmed-bug", "work item M-N as a fix PR", and any maintainer-style gsd-core contribution that must pass the repo's intake gates and match trek-e conventions.
---

# GSD-Core Contribution Pipeline

> **STEP ZERO — your very first tool call, before reading further, reproducing, or running anything:** create the P0–P6 checklist (in *Execution Protocol* below) as **tool-tracked todos** via your todo tool (Claude Code: **TodoWrite**). Not a printed markdown list, not "in your head." No exceptions — time pressure and "I'll move fast" do NOT waive it; the todos ARE how you move fast without dropping a gate. If you've already typed an orientation message, your next action is still the TodoWrite call, not a `Bash`/`Read`.
>
> **NEVER open the issue or PR before its gate is green.** Do not "file now and run lint/tests as a follow-up" — a PR that then fails `lint:ci` or the suite is the #1543/#1532 failure mode (lands red on the cut, doesn't beat the deadline). Gates run *before* the push, always.

## Overview

Author a verified finding into a **properly-filed issue + fix PR** on `open-gsd/gsd-core` that passes every intake gate on the first try and matches how the lead maintainer (trek-e) files. This is the **authoring** counterpart to `maintainer-review-sweep` (which reviews *others'* PRs).

> **Reuse + methodology decisions for this pipeline are fixed in [docs/REUSE-AND-METHODOLOGY.md](../../docs/REUSE-AND-METHODOLOGY.md)** — the `skills-from-the-artificer` + `trust-but-verify` pre-file review (ALIGN-01), Pocock `tdd` authoring + the gsd-core-native triage divergence (ALIGN-02), and the per-command reuse map (ALIGN-03). That record is the single source of truth; this skill wires to it, it does not re-decide.

**Core principle (load-bearing):** *Every submission is correct by construction, not by retry.* The repo's gates (version-gate, pr-template-policy, changeset-lint, `lint:ci`, intake bots) are deterministic and locally runnable — validate against them **before** you push, never discover failures from red CI. And never file a finding whose mechanism you have not reproduced live.

## When to use

- "File this as an issue/PR", "submit the fix", "open a confirmed-bug + fix PR"
- Turning an audit/review finding (e.g. "work item M-N") into a contribution
- Filing an epic umbrella + its children
- Any contribution to `open-gsd/gsd-core` that must clear the intake gates and match maintainer conventions

**Not for:** reviewing/triaging existing PRs (use `maintainer-review-sweep`); authoring in a repo without these specific gates.

## The two non-negotiables

1. **Verify before you file.** Reproduce the *mechanism* against live `src/*.cts`. Audit/review premises are wrong about a third of the time (this repo: M5, M7, PD-1 all had false stated mechanisms that "verified against source"). If it doesn't reproduce as described, find the real mechanism or **don't file**.
2. **Validate gates locally before pushing.** Run the gate scripts on your exact issue/PR body and `npm run lint:ci` on your branch. Red CI on a maintainer-filed item is a process failure, not a signal.

## Execution protocol — follow exactly, no skipping, no reordering

When this skill activates, **your FIRST action — before any Read, Bash, `gh`, or `git` call — is to create the checklist below as real, tool-tracked todos** using your platform's todo/task tool (in Claude Code, the **TodoWrite** tool), one todo per line. **Do NOT just print a markdown checklist in a message** — a printed list scrolls out of context on a long or interrupted run, which is the exact moment a gate gets dropped; tool-tracked todos persist and update as you go. If your first action is anything else, STOP and create the todos. This is not ceremony — "I can hold the six phases in my head" is how a gate gets silently dropped on a less-careful run, so the todos exist *every* time, even when you're confident. Then work them strictly top-to-bottom, flipping each to in-progress/complete in the tool as you go.

**HARD GATE rule:** a todo marked `[GATE]` may NOT be checked off without pasting the actual command output showing its pass condition. Do not start the next phase while any `[GATE]` in the current phase is unmet. Skipping, reordering, or "I'll do that later" = stop and restart the phase.

**Violating the letter of these steps is violating the spirit.** "I'm confident it reproduces" is not Phase 1. "It probably lints" is not the lint gate. Evidence or it didn't happen.

```
[ ] P-1 Create this checklist as tool-tracked todos (todo tool, NOT a printed list)   [GATE: todos exist BEFORE any other tool call]
[ ] P0  Read CONTRIBUTING.md + matching issue template + PR template + governing ADR(s) + CONTEXT.md
[ ] P0b ADR/CONTEXT awareness sweep (POLICY-03) — LIST governing ADRs/policies + CONTEXT.md predicates for the changed area BEFORE authoring (grep/gsd-tools over docs/adr/ + CONTEXT.md). Awareness only, NOT a pass/fail gate
[ ] P1  Run trust-but-verify; reproduce the mechanism live on src/*.cts (probe or failing test)   [GATE: reproduced, else WITHDRAW]
[ ] P2  Run skills-from-the-artificer; apply each firing law to the diff
[ ] P2b Policy conformance (POLICY-01) — check the DIFF vs the relevant ADRs + docs/agents/* via trust-but-verify (open+QUOTE the ADR) + skills-from-the-artificer law-lenses; surface any LOCKED-decision conflict before filing
[ ] P3a Worktree off origin/next; hooks rewired; node_modules linked; build:lib
[ ] P3b Regression test written FIRST and watched FAIL (test bar depends on type: fix / enhancement / feature — KNOW-02, see reference.md)   [GATE: pasted RED output]
[ ] P3c Implement the fix; tests GREEN
[ ] P3d Full relevant suites + `npm run lint:ci` + the QA-matrix-by-surface checklist for parser / FS-write / CLI / security (KNOW-01, see reference.md)   [GATE: all green, lint exit 0]
[ ] P4a Issue body: ### GSD Version + user-impact + template shape + cross-links + precedents
[ ] P4b version-gate on the EXACT body                                           [GATE: valid-version]
[ ] P4c gh issue create with labels; remove needs-triage via REST
[ ] P5a Branch fix/<issue#>-slug → base next; fix-template body + Fixes #<issue#>
[ ] P5b pr-template-policy on the EXACT body                                      [GATE: valid:true, template:fix]
[ ] P5c gh pr create with `area:` (+ security/runtime/no-changelog) label; add changeset
[ ] P6  Read real check-runs on the head SHA                                     [GATE: Tests ran + green on latest commit]
```

Epic instead of a single fix? Swap P4–P5 for the **Epic variant** below, but the protocol (todos + gates + evidence) is unchanged.

## Pipeline (run in order; adversarial gate between phases)

**REQUIRED SUB-SKILLS:** `tdd` (Matt Pocock — Phase 3 authoring; ALIGN-02, supersedes the former `superpowers:test-driven-development`), `skills-from-the-artificer` + `trust-but-verify` (Phase 1–2 pre-file review; ALIGN-01). **Companion:** `maintainer-review-sweep` (shared repo facts: labels, gotchas, authority). Verdicts and the named-skill choices are fixed in [docs/REUSE-AND-METHODOLOGY.md](../../docs/REUSE-AND-METHODOLOGY.md).

### Phase 0 — Ground in the canon (read first, every time)
Read before authoring: `CONTRIBUTING.md`, the matching **issue** template, the matching **PR** template (`.github/PULL_REQUEST_TEMPLATE/{fix,enhancement,feature}.md`), the governing **ADR(s)** in `docs/adr/`, and `CONTEXT.md` for the touched area. Know the gate scripts (see [reference.md](reference.md)).

**Issue types — all SIX, not three (KNOW-04).** The repo ships **six** issue templates in `.github/ISSUE_TEMPLATE/`: `bug_report`, `enhancement`, `feature_request`, **`chore`**, **`docs_issue`**, and **`config`**. Route the contribution to the template that fits its *nature* — a `chore`, `docs_issue`, or `config` change must NOT be force-fit into the bug/enhancement/feature shape (that trips the wrong intake gate). See the full type→use→labels table in [reference.md](reference.md).

**ADR/CONTEXT awareness sweep (POLICY-03) — run BEFORE you author.** Don't just passively read the canon: produce an explicit **LIST** of the governing decisions touching the changed area. Run a `grep`/`gsd-tools` sweep over `docs/adr/` **and** `CONTEXT.md` for the area's keywords/IDs (see the exact commands in [reference.md](reference.md)), and write down (a) the governing **ADRs/policies** that apply and (b) the relevant **`CONTEXT.md` predicates** for the touched area — so the governing decisions are in view up front, not discovered at review. This is **AWARENESS surfaced to the human/agent**: it puts the governing decisions on the table before authoring. It is explicitly **NOT deterministic enforcement** — a `CONTEXT.md` predicate listed here is awareness, **not** a pass/fail gate (the mechanizable, unbypassable floor is **POLICY-02**, Phase 3). The conformance *check* of the diff against this list happens in the pre-file Policy-conformance step below (POLICY-01).

### Phase 1 — Verify the finding (trust-but-verify)
**Invoke the `trust-but-verify` skill by name** and apply it to the finding: reproduce the mechanism on live `src/*.cts` with a throwaway probe or a failing test before you trust the premise. Remember **`bin/lib/*.cjs` is generated** from `src/*.cts` (ADR-457) — author in `src`, `npm run build:lib`. Correct the premise if wrong; record falsified findings rather than filing them.

### Phase 2 — Adversarial law pass
**Invoke the `skills-from-the-artificer` skill by name** on the proposed change; apply each *firing* law's key questions to the concrete diff. Capture any Hyrum's-Law behavior change to disclose in the PR. Don't force-fit laws.

> **Pre-file review (ALIGN-01):** the contribution path's review step runs BOTH named skills — `skills-from-the-artificer` AND `trust-but-verify` — exactly as the alignment record fixes them ([docs/REUSE-AND-METHODOLOGY.md](../../docs/REUSE-AND-METHODOLOGY.md)). Neither is optional; a finding reaches the file step only after both have run.

### Phase 2b — Policy conformance (pre-file; POLICY-01)
**Check the proposed DIFF for conformance against GSD's governing surfaces before you file** — not just your own intake gates. Check the diff against (a) the **relevant ADRs** surfaced by the Phase-0 awareness sweep (POLICY-03) AND (b) the `docs/agents/*` contribution norms. Run this through the two named skills: **invoke `trust-but-verify`** — you MUST **open AND QUOTE the actual ADR text** (a report/summary/awareness-list entry is a *lead, not a fact*; "I read about it" is not a pass) — and apply the firing **`skills-from-the-artificer`** law-lenses to the diff. For each ADR the awareness sweep flagged, open the file, quote the governing clause, and state diff-vs-clause: **conforms** / **conflicts** (with the quote). Surface any conflict with a **LOCKED** decision before filing — never silently violate one (see [reference.md](reference.md) for the open+quote procedure). **Honest scope:** this makes semantic ADR conformance a *rigorous quoted-source review*, run by `trust-but-verify` + `skills-from-the-artificer`; it does **not** "guarantee"/"enforce" conformance for arbitrary ADRs — the mechanizable subset that *is* deterministically gate-enforced is **POLICY-02** (Phase 3).

### Phase 3 — TDD the fix in a worktree
**Author with the `tdd` skill (Matt Pocock; ALIGN-02)** — the red/green/refactor discipline for this path. Worktree off `origin/next`; rewire hooks; symlink `node_modules`; `build:lib` (see [reference.md](reference.md) for exact commands — fresh worktrees have no deps and `bin/lib` is gitignored). **Regression test FIRST, watch it fail** (if you wrote the fix first, stash it, build, watch RED, restore). Then GREEN. **Run the FULL relevant suites AND `npm run lint:ci`** — not just the module's own tests (a deleted call can break a *structural/count* test elsewhere; `lint:ci` composes ~10 linters `eslint` alone doesn't). **Cover the `CONTRIBUTING` QA matrix for every surface your diff touches — `parser` / `FS-write` / `CLI` / `security` — as a per-surface checklist, not a single "is it tested?" box (KNOW-01): see the `## QA matrix by surface` table in [reference.md](reference.md) for the concrete checks each surface requires.** And **the test bar depends on the contribution type — `fix` (a regression test that fails-before/passes-after) vs `enhancement` (new-capability behavior + no-regression) vs `feature` (full coverage of the new surface) (KNOW-02): see `## Test bar by contribution type` in [reference.md](reference.md).** These checklists **supplement** the RED-before-GREEN `[GATE]` below — they do not replace it.

### Phase 4 — File the issue (validate gate first)
Body = template shape + a **`### GSD Version`** heading (`1.6.0-rc.1 (next @ <sha>)`) + a **user-impact statement** (what the user/agent/CI would *notice*, not just the mechanism) + Summary / Root-cause / Repro / Fix + cross-links to umbrellas and cited precedents. **Run the version-gate locally on the exact body** → must be `valid-version`. Labels: `bug`→`confirmed-bug` + `area: X` + `priority: X` (+ `security`). Then **remove the bot-added `needs-triage` via REST** (`gh issue edit` GraphQL is broken on this repo).

### Phase 5 — Open the PR (validate gate first)
Branch `fix/<issue#>-slug` → base `next`. **Push target:** if you have push access to the repo (CODEOWNER / member / collaborator) push the branch to **`origin`** and open a same-repo PR — the maintainer-style flow; only push to a **fork** and open a cross-fork PR if you're an external contributor without push access. (Check once with `gh api repos/open-gsd/gsd-core -q .permissions.push`.) Body = the **fix** template with **every** required heading + `Fixes #<issue#>`. **Run pr-template-policy locally on the exact body** → `valid:true,template:fix`. Conventional commits; **one concern per PR**; a stale-test correction lands as its own `test:`/`fix:` commit (never under `docs:` — the hotfix cherry-pick filter routes by prefix). Add a **changeset** (`Fixed`/`Security` don't trigger docs-lint). **Label the PR** to mirror the issue: `area: X` (always), `security`/`runtime: X` if applicable, `no-changelog` only if there's no changeset — NOT the issue-only `bug`/`confirmed-bug`/`priority:` labels, and not the maintainer/bot `review:`/`needs rebase` labels. The repo has no auto-labeler; an unlabeled PR is a gap.

### Phase 6 — Confirm CI green on the LATEST commit
Read **real check-run conclusions** (branch protection is evaluate-mode — "CI green" from the ruleset is not a gate). A **changeset-only commit can skip the Tests workflow**, leaving a stale FAILED run hidden behind green meta-checks — confirm Tests actually ran on the head SHA. Don't chase `BEHIND` (maintainer clears on merge). Fix any failure as a follow-up commit on the same branch.

## Epic variant (trek-e format)

Umbrellas use the **enhancement** template, labels `enhancement, approved-enhancement, area: X`, title `epic(<area>): <imperative> — <ADR/finish-the-rollout>`, body = Problem (hard numbers + prior-issue cites) / Goal + "Done when:" / Non-goals / children table. Governance line: *an approved epic does NOT approve its children — each child is its own issue + own `confirmed-bug`/`approved-enhancement` before code.* File children incrementally as worked (cadence, not bundling). See [reference.md](reference.md).

## Quick reference

| Step | Command / gate | Pass condition |
|---|---|---|
| version-gate | `node -e '…evaluateVersionGate({labels,body})'` | `{action:'skip',reason:'valid-version'}` |
| pr-template | `PR_BODY=… AUTHOR_ASSOCIATION=MEMBER node scripts/pr-template-policy.cjs` | `valid:true, template:fix` |
| lint (full) | `npm run lint:ci` | exit 0 (≠ `eslint .`) |
| changeset | `npm run changeset -- --type Fixed --pr <PR#> --body "…"` | fragment written |
| label cleanup | `gh api -X DELETE repos/open-gsd/gsd-core/issues/<#>/labels/needs-triage` | removed |

Exact snippets, body skeletons, label sets, and worktree setup → **[reference.md](reference.md)**.

## Gotchas (verified live)

- **`gh pr edit` / `gh issue edit` GraphQL is broken** on open-gsd (Projects-classic) — body/label edits silently fail. Use REST: `gh api -X PATCH repos/open-gsd/gsd-core/{pulls,issues}/<#> -f body=…` and `-X DELETE …/labels/<l>`.
- **`version-exempt` label does not exist** — the only version-gate bypass is a valid `### GSD Version` value.
- **`lint:ci` ≠ `eslint .`** — it runs skill-deps, test-file-count, command-contract, legacy-name, regression-names, windows-portability, **allow-test-rule-refs (needs `see #NNN` per ADR-456)**, resolution-provenance. Reproduce lint in a **clean worktree** (a stray untracked `gsd-core/bin/lib/*.cjs` poisons `eslint .`).
- **`bin/lib/*.cjs` is generated** (ADR-457) — edit `src/*.cts`, never the compiled output; `build:lib` before `node --test`.
- **No source-grep tests** — assert on typed/structured values, not stdout/file-content substrings (CONTRIBUTING; `local/no-source-grep`).
- **Security routing — WARN (KNOW-03):** a **real / exploitable vulnerability** (a live injection/escape vector) is reported via the repo's **PRIVATE GitHub security advisory at `/security/advisories/new`** (per `SECURITY.md`), **NOT** a public `gh issue create` — filing a live vuln publicly discloses it before a fix exists. The existing **public** path stays only for **non-exploitable / already-public / precedented** security findings: those are filed public `security`+`confirmed-bug` (precedents #751/#1406/#116). When in doubt about exploitability, use the private advisory first — you can downgrade to public, you cannot un-disclose. (See *Security routing (KNOW-03)* in [reference.md](reference.md).)

## Rationalization table (from real failures this program hit)

| Excuse | Reality |
|---|---|
| "I can hold the six phases in my head / I'll just start with P0" | In-head tracking is what drops a gate when context compacts or the task drags. Create the todo list FIRST, every time — it's the backstop, not ceremony. |
| "Deadline — I'll file the issue/PR now and run lint:ci + the suite as a follow-up" | A PR that then fails lint/tests is the #1543/#1532 failure — it lands RED on the cut, it doesn't beat the deadline. The gates ARE the fast path. Green locally, THEN push. |
| "I'll compress per your call and skip the slow gates" | Compress by doing the gates fast (they take seconds), not by skipping them. The only thing you compress is ceremony, never a `[GATE]`. |
| "The audit verified it against source, so it's real" | Premise ≠ mechanism. Reproduce it live or don't file. (M5/M7/PD-1 were wrong.) |
| "Module tests pass, ship it" | A deleted call breaks a structural/count test elsewhere (#1543). Run the full suite + `lint:ci`. |
| "CI shows green on the PR" | Meta-checks aren't Tests; a changeset-only commit can skip Tests and hide a stale FAIL (#1532). Read real check-runs on the head SHA. |
| "`eslint` is clean" | `lint:ci` runs 10 linters eslint doesn't (#1532 allow-test-rule-refs). |
| "I'll just `gh issue edit` the body" | GraphQL is broken here — it silently no-ops. Use REST. |
| "It's engine-internal, skip the user impact" | Every issue states what the user/agent/CI notices. Translate the mechanism. |
| "Bundle the test fix into the docs commit" | The hotfix picker routes by prefix; test fix = its own `test:` commit. |

## Red flags — STOP

- Your first action was a Read / Bash / `gh` / `git` call instead of creating the P0–P6 todos
- You printed a markdown checklist instead of creating real tool-tracked todos (it won't survive context compaction)
- About to `gh pr create` / `gh issue create` before that step's gate is green ("file now, validate after")
- Created the PR without an `area:` label (the repo has no auto-labeler)
- About to `gh issue create` without running the version-gate on the body
- About to `gh pr create` without running pr-template-policy on the body
- About to `gh issue create` a **real exploitable vulnerability** as a PUBLIC issue instead of filing the **PRIVATE advisory at `/security/advisories/new`** (KNOW-03) — a live vuln is disclosed the moment the public issue opens
- Filing a finding you only read about, never reproduced
- Ran the module's tests but not `lint:ci` / the full relevant suite
- Trusting "green" from the rollup without reading the head SHA's check-runs
- Editing `bin/lib/*.cjs` or treating it as source
- Calling work "done" while the latest commit never re-ran Tests

## Recovery Offramp

**Trigger:** a contribution gate **DENIES** the action (a `PreToolUse` hook returns `deny`), OR this skill itself surfaces a **real blocking issue** mid-run (P1 fails to reproduce, `lint:ci` red, the full suite fails, a POLICY/LOCKED-decision conflict). A deny or a real red is NOT a dead end — but it is also NOT a thing you route around.

**The deny is fail-closed and unbypassable. This offramp is an ADVISORY convenience layer, NOT a way around the gate.** It NEVER suggests bypassing the gate, and it NEVER suggests `GSD_CONTRIB_OVERRIDE` to dodge a real failure — the override receipt is for **transient infra** only (a flaky network/tool outage, already documented), never for a genuine red gate or an unreproduced finding. If the gate denied because the issue/PR is actually broken, the fix is to make it green, not to override it.

**Two tracked recovery paths — reuse EXISTING GSD commands (no parallel remediation flow):**

1. **Fix inline — `/gsd-quick`.** For a trivial/ad-hoc correction (a one-line body fix, a missing label, a small lint nit), make the fix via `/gsd-quick`, then resume the submission.
2. **Route through the pipeline.** For anything non-trivial or worth tracking: `/gsd-debug` (investigation of the real mechanism behind the red), OR the full `/gsd-discuss-phase`→`/gsd-plan-phase`→`/gsd-execute-phase` pipeline (planned, atomically committed, verified) — so the fix is tracked + resumable rather than a one-off scratch edit.

**Return to the submission.** Once the underlying issue is green, **re-enter the P0–P6 protocol and re-run the gate that denied** — the offramp resumes the contribution, it does not abandon it. The gate stays the load-bearing part; the offramp only routes you to the right GSD command to make it pass honestly.

**Honest limitation (model-driven — same honesty as "hooks lock outcomes, not steps"):** this offramp is **MODEL-DRIVEN**. It fires only while the model is running inside this GSD/contribution flow (this skill is active). A bare `gh pr create` / `gh issue create` typed outside any skill is **still denied by the hook** — the fail-closed enforcement holds — but no skill is active to offer this offramp, and a hook **cannot drive the model after a deny**. The deny is the guarantee; the offramp is the convenience layered on top of it when a skill is in play.
