# GSD-Contrib Toolkit — Overview

*A tour of what the toolkit does, what's inside it, and the model that ties it together.
For the deep architecture reference see the top-level [README](../../README.md); for a step-by-step
walkthrough see the [Contributor Guide](contributor-guide.md) and [Maintainer Guide](maintainer-guide.md).*

---

## What it is, in one sentence

A private, GSD-update-proof toolkit that makes a **broken `open-gsd/gsd-core` contribution physically
impossible to submit** — and gives the maintainer a LIVE-script-backed triage/review pipeline — by
combining contribution *knowledge* (skills), human *triggers* (commands), runnable *tools* (`bin/`), and
the load-bearing layer: **Claude Code `PreToolUse` hooks the harness runs, not the model.**

## The core idea: lock outcomes, not steps

The insight is **verifier-reach = spec-reach** applied to a contribution pipeline. Instead of trusting a
deadline-pressured or rationalizing model to *follow* every step, the toolkit enforces the **outcomes
that must never happen** at the harness boundary:

- no **broken issue/PR** filed (missing/invalid GSD Version, wrong PR target, policy-violating body, a duplicate);
- no **red push** (un-green `lint:ci`, failing affected tests, a secret/injection/base64 hit);
- no **generated-file failure** shipped (a stale `bin/lib/*.generated.cjs` whose `src` changed);
- no **direct edit of a generated artifact** (`bin/lib/*.cjs` instead of its `src/*.ts`);
- no **seal bypass** (`--no-verify`, a swapped `core.hooksPath`, private files leaked upstream).

Because a `PreToolUse` hook fires **before** the permission check, these gates hold even under
`--dangerously-skip-permissions`. They **cannot be talked around** — that is the one property the
project actually claims. Everything else (todo-first discipline, review quality) is model-driven and
documented honestly as such.

**One narrowing (CTK-ADR-0004).** The mechanism above is unchanged — a gate still fires on an
*outcome*. What changed is the recognition that where a step deposits an **artifact**, that artifact
can become the *precondition* of the next outcome, which makes the step enforceable *transitively*
(ENF-05's `lint:ci` marker was the first instance; ENF-19's protocol artifacts generalise it). So
"model-driven" above now reads: model-driven **unless the step leaves evidence behind**. A step that
deposits nothing is still unenforceable, and the gate asserts an artifact's *shape*, not its honesty
— see [CTK-ADR-0004](../adr/CTK-ADR-0004-artifact-gated-step-discipline.md).

## What's in it

| Layer | What | Where |
|---|---|---|
| **Enforcement** | **13 harness-run hooks** — 12 fail-closed `PreToolUse` gates (11 on `Bash`, 1 on `Write`/`Edit`) + 1 advisory `UserPromptSubmit` reminder | `hooks/` (+ shared anti-bypass `hooks/lib/`) |
| **Knowledge (skills)** | **`gsd-core-contribution`** — the gated P0–P6 contribution pipeline; **`maintainer-review-sweep`** — the triage + re-review sweep (with `re-review.md`, `labels.md`, `triage-assist.md` sub-guides) | `skills/` |
| **Triggers (commands)** | **5** `gsd-*` slash-commands: `gsd-submit`, `gsd-review-sweep`, `gsd-triage-assist`, `gsd-release-preflight`, `gsd-ruleset-drift` | `commands/` |
| **Tools** | `contrib-capability` (the install/toggle driver), `lint-ci-stamp`, `triage-assist`, `release-preflight`, `ruleset-drift`, plus `verify-hooks` / `verify-capability` / `self-test` provers | `bin/` |
| **Share form** | An opt-in, consent + ledger tracked GSD capability bundling the 13 hooks + 2 skills + 5 commands | `capabilities/contribution-toolkit/` |
| **Wired-set source** | The canonical hooks settings block `build-capability.cjs` reads to generate the bundle | `settings.snippet.json` |

### The two pillars

The toolkit serves two roles, which is why it has both hard gates and advisory assists:

- **Contributor pillar (hard enforcement).** Drive a contribution with **`/gsd-submit`** (+ the
  `gsd-core-contribution` skill). The 12 gates make a broken issue/PR/push *impossible to land*. →
  [Contributor Guide](contributor-guide.md).
- **Maintainer pillar (advisory assists).** Triage and re-review with **`/gsd-review-sweep`**,
  **`/gsd-triage-assist`**, **`/gsd-release-preflight`**, **`/gsd-ruleset-drift`** (+ the
  `maintainer-review-sweep` skill). These are **read-only by default** — they surface evidence and stop
  for your call; nothing mutates GitHub or the tree without an explicit `--apply` / merge token. →
  [Maintainer Guide](maintainer-guide.md).

## The model that ties it together

Three mechanisms recur across the whole toolkit:

1. **The push-readiness loop — stamp → marker → gate → scan.**
   `lint-ci-stamp` runs `npm run lint:ci` and, on green, stamps a **tree-SHA marker**. Before a
   `git push`/`gh pr create`, `lint-ci-marker.cjs` reads that marker and **denies** if it's absent,
   stale, or the tree is dirty; `scan-gate.cjs` runs gsd-core's secret/injection/base64 scans over the
   diff and denies on any hit. The model gets a guided path to green; the harness locks the outcome.

2. **Gate → LIVE-script reuse (no vendored policy).** A gate does **not** reimplement gsd-core policy —
   it resolves the gsd-core worktree and `require()`s the **LIVE** script (`hooks/lib/resolve.cjs`). There
   is deliberately **no fallback**: a missing/refactored LIVE script throws, and the `runGate` harness
   turns any throw into a **fail-closed DENY** (never a silent allow). A `doctor` self-test asserts the
   LIVE scripts still export the shapes the gates expect, so a gsd-core refactor surfaces as a
   diagnosable deny, not a silent miss. This is what keeps the toolkit aligned as gsd-core evolves.

3. **The override valve — deliberate, logged, never silent.** `GSD_CONTRIB_OVERRIDE` takes a non-empty
   **reason string** (never a boolean) and writes an append-only, per-worktree receipt. It is an
   accountable escape hatch, not a default — and the recovery offramp never suggests using it to dodge a
   real failure.

## What the skills encode (and the drift discipline)

The two skills are **repo-aware**: they bake in `open-gsd/gsd-core`'s current conventions — trek-e's
review skeleton and multi-tier severity, the `CI.GATE.orthogonal-review-required` two-pass rule, the
Generative-Fix-Divergence anti-pattern, the Agent Brief `ready-for-agent` handoff, the label state
machine, the bug-vs-by-design triage gate, and the `capability-candidate` routing stance. These are kept
current by periodic **primary-source-verified** sweeps of the live repo (each convention traced to an
actual review/comment body, then adversarially re-checked) — the discipline that guards against the
skills drifting from the maintainer's live practice. See the milestone record in
[`.planning/MILESTONES.md`](../../.planning/MILESTONES.md) (v2.7).

## Containment & safety model

- **Owned source of truth.** This repo is authoritative; the `~/.claude` copies are **symlinks** back
  into it. A GSD update that clobbers `~/.claude` is repaired by **re-running the installer**, never by
  recovering lost work.
- **Project-scoped blast radius.** Enforcement installs into gsd-core's **project**
  `.claude/settings.json` — *never* the global `~/.claude/settings.json` — so the gates fire only inside
  the gsd-core checkout.
- **Reversible & accountable.** Toggling `off`/`remove` *genuinely* removes the enforcement (the gates
  *are* the enforcement) and requires a non-empty `--reason`, writing a receipt. Nothing is pushed to
  upstream gsd-core; the toolkit stays private.
- **Honest limits.** The **share-form capability is advisory-only** (`gates[]` empty) — only the
  installed **personal PreToolUse hooks** are the harness-wide, unbypassable layer. Don't read the
  capability as unbypassable.

## Status

- **Enforcement:** built and self-proven — `verify-hooks` captures byte-stable deny/allow proofs for all
  wired gates; `self-test` dog-foods the toolkit against a disposable sandbox.
- **Live proof:** the first toolkit-shepherded contribution landed upstream (issue #1154 → PR #1738,
  merged 2026-06-29) — the pipeline has cleared a real gsd-core contribution end-to-end.
- **Distribution:** published as a public, git- and npm-installable capability
  (`v2.1.3`); the npm channel verifies a real `sha512-` integrity digest before staging.

## Where to go next

- **[Contributor Guide](contributor-guide.md)** — install, then file a verified finding as a clean
  issue + fix PR through the gates.
- **[Maintainer Guide](maintainer-guide.md)** — run the triage sweep, re-review a stalled PR, and use
  the release/ruleset assists.
- **Reference:** [README](../../README.md) (architecture + gate table), [commands-reference](../commands-reference.md),
  [skills-reference](../skills-reference.md), [REUSE-AND-METHODOLOGY](../REUSE-AND-METHODOLOGY.md),
  [cross-runtime-delivery-model](../cross-runtime-delivery-model.md).
