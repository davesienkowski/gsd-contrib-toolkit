# Label Handling (open-gsd/gsd-core)

Authoritative source: **`docs/agents/triage-labels.md`** in the repo (read it live — it may evolve). Below is the operational model for applying labels the way the lead maintainer does. Never invent label strings; apply only labels that exist (`gh label list`).

## Canonical role → repo label

| Canonical role | Repo label | Rule |
|---|---|---|
| needs-triage | `needs-triage` | Auto-applied on every new issue. **Remove it whenever you apply any other state label.** |
| needs-info | `needs-reproduction` | Use this, NOT a generic needs-info. Pair with a triage comment naming exactly what repro/info is missing. |
| ready-for-agent (bug) | `confirmed-bug` | The AFK fix gate (`RULESET.CONTRIB.CLASSIFY.fix`). Apply **with** `bug` when triage reproduces the bug. No fix code before this. |
| ready-for-human (enh/feat) | `approved-enhancement` / `approved-feature` | Maintainer approval gate. **No contributor code before one of these.** |
| wontfix | `wontfix` | Will not be actioned. |

**Documented-vs-live drift (flag to trek-e):** the doc maps ready-for-agent → `confirmed-bug`, but a separate literal **`ready-for-agent`** label is live on ~17 issues alongside `confirmed-bug` (and `ready-for-human` on ~4). Until reconciled, **match live practice**: a dispatchable bug carries `confirmed-bug` + `ready-for-agent`. Surface the ambiguity in the sweep output; don't silently pick one.

## Label families (apply the right ones, drop `needs-triage`)

- **Category:** `bug` · `enhancement` · `feature-request` · `documentation` · `chore` · `test` · `security`
- **State (issue):** `needs-triage` → `needs-reproduction` / `confirmed-bug`(+`ready-for-agent`) / `approved-enhancement` / `approved-feature` / `needs-maintainer-review` / `blocked` / `wontfix`
- **Lifecycle (post-approval):** `in-progress` → `fix-pending` (fix PR open) → `fix-released` (merged+released); `awaiting-retest` when a fix shipped in a newer version
- **Priority:** `priority: critical` (crashes, data-loss, security, blocks all) · `high` · `medium` · `low`
- **Size:** `size/S` · `size/M` · `size/L` · `size/XL`
- **Area:** `area: agents|commands|config|core|docs|hooks|installer|performance|workflow|workflows`
- **Runtime:** `runtime: claude-code|codex|gemini|opencode|qwen|copilot|cursor|windsurf|...` — apply when the issue is runtime-specific (e.g. #1394 gemini, #1383 codex, #1400 windows→`os: windows`)
- **PR review state:** `needs-review` → `review: changes requested` (+`needs changes`) / `review: approved` / `review: approved (merge conflict)` / `review: needs discussion`; `needs rebase`, `needs merge fixes`, `ci: failing`; `approved to merge` (CI green + approved); `no-changelog` (docs-only/changelog-direct, opts out of changeset)

## PR re-review → label transition (mirror trek-e)

After a re-review verdict, set the PR's review-state label to match:
- `CLEAR` → `review: approved`; add `approved to merge` only when CI conclusions are actually green and it's rebased. If conflicting, use `review: approved (merge conflict)` + `needs rebase`.
- `CHANGES REQUESTED` / `blocker open` → `review: changes requested` + `needs changes`; add `needs rebase` if BEHIND, `ci: failing` if checks red.
- **Re-review confirms a prior reviewer's requested changes are addressed** (all prior blockers `Resolved`, no new blocker) → **remove the now-stale `review: changes requested` + `needs changes`** — they flag outstanding *contributor* work, and there is none. Do this even when you leave the formal approve/CR state to the original reviewer: the label answers "are changes still needed?" (no), while the formal review state tracks their re-flip. Keep the labels only if your re-review found a NEW blocker.
- **Another maintainer's `CHANGES_REQUESTED` is open, contributor resolved it** → **dismiss their review** (re-review.md 12a), then `review: approved` (+ `approved to merge` if CI green + rebased), and remove the stale `review: changes requested` + `needs changes`. If their request is genuinely *unmet/unverifiable* → don't dismiss or approve; leave the formal CR to them, remove only a plainly-stale label (e.g. `needs-review`), and note it. That's the sole `CLEAR · merge-blocked` case.
- **Post-rebase, CLEAR** → once a `CLEAR · merge-blocked: rebase` PR is rebased and CI is green, apply `approved to merge` and hand to the lead to re-flip + merge.
- Remove stale review-state labels you're superseding (don't leave both `review: changes requested` and `review: approved`).
- **External contributors cannot self-label** (403). When the only gap is a missing label on a PR (e.g. `approved-enhancement` mirrored from the issue), that's a **maintainer one-click action**, not a code defect — apply it yourself.

## Bot-managed — DO NOT hand-edit

These are driven by GitHub Actions; let the workflows own them:
- `possible-duplicate` — duplicate-check/sweep loop (24h reporter window; a non-bot reply clears it → `needs-maintainer-review`). Exempt-from-auto-close: `priority: critical`, `pinned`, `confirmed-bug`, `confirmed`, `fix-pending`.
- `needs-version` / `version-exempt` — version-gate. `version-exempt` is the maintainer-only opt-out; apply it for docs/spec bugs where a version doesn't apply.

## Prefer canonical over duplicate (known drift — don't worsen)

Use the left, not the right: `confirmed-bug` (not `confirmed`) · `needs changes` (PR) vs `needs-changes` (issue) — they're distinct, pick by target · `area: workflow` for phase/STATE work vs `area: workflows` for workflow-definition files (genuinely two areas — choose deliberately) · `blocked` vs `status: blocked` (use `blocked`) · `in-progress` vs `status: in-progress` (use `in-progress`). Surface the duplicate pairs as a cleanup note to trek-e; never create a new variant.

## Always
- Re-fetch the issue/PR's current labels immediately before editing (TOCTOU).
- Every label change that's non-obvious gets a one-line triage comment (with the AI disclaimer).
- One category role + one state role per item; flag conflicting state labels and ask before resolving (e.g. #1216 carried both `needs-info` and `ready-for-human`).
