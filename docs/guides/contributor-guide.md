# Contributor Guide — filing a gsd-core contribution through the toolkit

*How a contributor uses the toolkit to turn a verified finding into a clean `open-gsd/gsd-core`
issue + fix PR that can't land broken. For the big picture see the [Overview](overview.md); for the
maintainer side see the [Maintainer Guide](maintainer-guide.md).*

---

## 0. Prerequisites

- A local **`open-gsd/gsd-core`** checkout (the gates resolve and call its LIVE scripts).
- The toolkit installed into that checkout (below). Enforcement is **project-scoped** to gsd-core.
- Push access is *not* required — the pipeline works for both same-repo (CODEOWNER/member) and fork
  contributors; it detects which and routes the PR accordingly.

### Install / restore (idempotent)

```bash
node bin/contrib-capability.cjs install    # stage + consent + ledger + marker-tag every wired hook
node bin/contrib-capability.cjs status      # confirm ledger + consent + live gate set
```

`install` is the **single, re-runnable** entrypoint: it relinks the `~/.claude` command/skill symlinks
back into this repo (with a never-clobber fail-safe) and wires the gates into gsd-core's project
`.claude/settings.json`. Re-run it after any GSD update or `gsd-ver` toggle — it repairs without losing
work. (Not the owner? Install the published capability instead — see the README §*Install From the
Published Capability*.)

## 1. The one command: `/gsd-submit`

You don't hand-drive the pipeline. You point `/gsd-submit` at the finding and it loads the
[`core-contribution`](../skills-reference.md#core-contribution) skill, builds a **gated todo
checklist (P0–P6)**, and works it top-to-bottom:

```text
/gsd-submit the version-gate regex accepts a trailing newline — see issue #1549
/gsd-submit M-7
/gsd-submit fix the dedupe scorer off-by-one in scripts/issue-dedupe.cjs
```

`$ARGUMENTS` is free-form (a sentence, a rough description, or an audit-item label). If it's too vague to
identify a specific defect + location, the command asks **one** clarifying question, then goes.

> **The two non-negotiables** (from the skill): **(1) Verify before you file** — reproduce the *mechanism*
> on live `src/*.ts`; stated audit/review mechanisms are wrong ~⅓ of the time. **(2) Validate gates
> locally before pushing.** Urgency, "the maintainer already confirmed it", or "it's trivial, skip the
> gates" does **not** waive a single step — the skill names that pressure as the exact rationalization it
> guards against.

## 2. What the pipeline does (P0–P6)

The skill runs these as tool-tracked todos; a `[GATE]` todo may **not** be checked off without pasting
the real command output proving its pass condition.

| Phase | What happens | Gate / proof |
|---|---|---|
| **P0** | Ground in canon: read `CONTRIBUTING.md`, the matching issue + PR templates, the governing ADR(s), `CONTEXT.md`. List governing ADRs/policies for the touched area **before** authoring. | — (awareness) |
| **P1** | **Verify the finding** — reproduce the mechanism live with a probe or failing test. | `[GATE]` reproduced, else **withdraw** |
| **P2 / P2b** | Adversarial **law pass** (`skills-from-the-artificer`) + **policy conformance** (`trust-but-verify`, open+quote the ADRs) on the diff. | surface any LOCKED-decision conflict before filing |
| **P3** | **TDD the fix in a worktree** off `origin/next`: regression test **written first and watched FAIL**, then GREEN; run the full relevant suites + `npm run lint:ci` + the per-surface QA matrix. | `[GATE]` pasted RED output; `[GATE]` all green, lint exit 0 |
| **P4** | **File the issue** — body = `### GSD Version` + user-impact + repro + root cause + fix; run the version-gate on the exact body. Apply your labels **alongside** the bot auto-tags (never strip `needs-triage`). | `[GATE]` `valid-version` |
| **P5** | **Open the PR** — branch `fix/<issue#>-slug` → base `next`; title `<type>(#<issue#>): <imperative>`; fix-template body + `Fixes #<issue#>`; add a changeset. Run pr-template-policy on the exact body. | `[GATE]` `valid:true, template:fix` |
| **P6** | **Confirm CI green** — read **real check-run conclusions** on the latest head SHA (branch protection is evaluate-mode, so the ruleset "green" is not a gate). | `[GATE]` Tests ran + green on latest commit |

> **Ordering note:** P3 (local TDD) runs *before* P4/P5 deliberately — the harness enforcement gate fires
> on the **PR/push** (P5), not on local worktree work (P3), and the P4 issue body needs the empirical
> repro + `file:line` root cause that P3 produces. This is intentional, not a mistake.

## 3. The gates you'll meet (and how to get past them the right way)

Each gate DENIES at the `PreToolUse` boundary; most call a LIVE gsd-core script. You get past a gate by
**fixing the underlying problem**, not by working around it.

| If you try to… | Gate | Fix |
|---|---|---|
| `gh issue create` with a missing/invalid `### GSD Version` | `gh-issue-create` | Add a valid GSD Version; re-run the version-gate locally. |
| File a duplicate of an open issue | `issue-dedupe` | Check the flagged `#number`; comment on the existing issue instead. |
| `gh pr create` with wrong target / bad template / un-green CI | `gh-pr-create` | Base `next`; use the fix template with every heading + `Fixes #N`; get CI green. |
| `git push` / open a PR without a fresh `lint:ci`-green marker | `lint-ci-marker` | Run the **stamp** (below) on a clean tree. |
| `git push` with a secret / injection / base64 hit in the diff | `scan-gate` | Remove the flagged content. |
| Commit a stale generated `bin/lib/*.generated.cjs` | `freshness` | Re-run `build:lib` after changing its `src`. |
| Edit a generated `bin/lib/*.cjs` directly | `binlib-edit` (Write/Edit) | Edit the `src/*.ts` source, then `build:lib`. |
| `--no-verify` / swap `core.hooksPath` / leak private files upstream | `githooks-seal`, `containment` | Don't bypass the seal; keep private files out of the gsd-core tree. |
| A commit with a wrong conventional-commit prefix | `git-commit-convention` | Use `<type>(scope): …`. |

### Getting to green: the stamp → marker → gate → scan loop

```bash
node bin/lint-ci-stamp.cjs      # runs `npm run lint:ci`; on GREEN, stamps a tree-SHA marker
```

Then `git push` / `gh pr create` is allowed **only** while that marker matches the current tree and the
tree is clean. Change a file after stamping → the marker goes stale → re-stamp. The `scan-gate` runs the
LIVE secret/injection/base64 scans over the diff at push time.

## 4. Conventions worth following (match the maintainer)

These aren't all gate-enforced, but they're what gets a contribution reviewed cleanly (mirroring the
maintainer's live practice — see the [Maintainer Guide](maintainer-guide.md)):

- **Issue body = the Agent Brief shape.** For a confirmed bug, structure the body as *Reproduction
  (empirical — a real transcript, not hypothesized) → Root cause (`file:line`, in `src/*.ts` not the
  generated `bin/lib/*.cjs`) → Fix → Acceptance criteria → Verify.*
- **Respect the scope fence.** If the confirming issue/maintainer fenced the change ("scoped to X only;
  do not alter Y"), stay strictly inside it — the tempting adjacent fix is *its own* issue, not a rider
  (a scope breach is a re-review Blocker).
- **Qualify cross-repo issue cites.** A precedent `#N` that resolves against the **predecessor** repo
  (`gsd-build/get-shit-done`) must be named as such — never left as a bare `#N` a reader mistakes for an
  `open-gsd/gsd-core` issue.
- **Don't recreate the bug (Generative-Fix-Divergence).** If the root cause is a hand-maintained list
  that drifted, your fix must **consume the single source of truth** (or add a parity test) — not
  hardcode a fresh literal that will drift the same way.
- **No vacuous tests.** A regression test must be **proven fail-first** and can't pass with zero
  assertions (assert the match count `> 0`).
- **Enhancement/feature? Two extra checks.** *(a)* Is it a **`capability-candidate`** — extends behavior
  at an ADR-857 extension point (runtime/host, command, hook, skill)? Then deliver it as a **capability**,
  not a core patch. *(b)* An `approved-enhancement`/`approved-feature` arrives with a **conditions
  checklist** — treat every box as a merge-gate your PR must satisfy. No contributor code before the
  approval label.

## 5. When a gate denies: the recovery offramp (FLOW-01)

A deny is **fail-closed and unbypassable** — but it's not a dead end. `/gsd-submit` offers a GSD-native
recovery:

- **`/gsd-quick`** — fix the underlying problem inline (trivial correction), then return to the submission.
- **`/gsd-debug`** (or `/gsd-discuss-phase` → `/gsd-plan-phase` → `/gsd-execute-phase`) — route it as a
  tracked, resumable work item, then come back once it's green.

The offramp is **advisory only**: it never suggests bypassing the gate or abusing the override to dodge a
real failure.

## 6. The override valve (rare, logged, accountable)

`GSD_CONTRIB_OVERRIDE="<reason>"` is a deliberate escape for a genuinely-wrong gate (e.g. a false
positive), **never** to dodge a real failure. It takes a **non-empty reason string** (not a boolean) and
writes an append-only, per-worktree receipt at `.gsd-contrib/override-receipts.log`. If you can't write a
real reason, you shouldn't be overriding.

## Quick reference

```bash
# install / repair
node bin/contrib-capability.cjs install
# get to green before pushing
node bin/lint-ci-stamp.cjs
# file a contribution (in Claude Code)
/gsd-submit <your finding>
```

**See also:** [Overview](overview.md) · [commands-reference](../commands-reference.md) ·
[skills-reference](../skills-reference.md) · [README](../../README.md) (full gate table).
