<!-- GSD:project-start source:PROJECT.md -->

## Project

**GSD-Contrib Toolkit**

A self-contained, GSD-update-proof toolkit that makes a *broken* `open-gsd/gsd-core`
contribution physically impossible to submit. It bundles the knowledge (the `core-contribution`
skill), the triggers (`/gsd-submit`, `/gsd-review-sweep`), and — the new load-bearing layer —
Claude Code `PreToolUse` hooks the *harness* runs (not the model), which call gsd-core's own gate
scripts to **deny** filing/pushing a broken issue/PR or editing generated `bin/lib/*.cjs`. For Dave
(a gsd-core CODEOWNER). **Public since 2026-07-31** — the "graduate into a maintainer-shareable
contributor toolkit" step, published MIT for reference and reuse. The `.planning/` GSD corpus stays
local and unpublished; the toolkit's own decision record lives in tracked `docs/adr/`.

**Core Value:** Enforce the **outcomes** that matter at the harness boundary — no broken issue/PR/push, no
generated-file edit — so that even a sloppy, deadline-pressured run is blocked and corrected rather
than merged red. (Verifier-reach = spec-reach, applied to Dave's own contribution pipeline.)

### Constraints

- **Enforcement mechanism**: Claude Code `PreToolUse` hooks returning `permissionDecision:"deny"` — fire before permission checks, unbypassable (even `--dangerously-skip-permissions`). — The only layer that survives model rationalization.
- **Containment**: One git repo Dave owns (`~/repos/gsd-contrib-toolkit/`); `~/.claude` copies are symlinks back to it; `install.sh` is idempotent and re-runnable after any GSD update. — A `gsd-ver`/reinstall toggle must never lose the work.
- **Settings scope**: Project-scoped `gsd-core/.claude/settings.json` (gitignored locally) so hooks fire only in the gsd-core repo. — Cleanest blast radius. (Decision below; revisit if a global+cwd-guard proves necessary.)
- **Privacy**: Nothing committed to or pushed at upstream gsd-core; no upstream repo edits. — Held private until proven; the toolkit itself went public MIT on 2026-07-31, but the upstream-containment rule is unchanged and permanent. The `.planning/` corpus (exploratory notes, unsent outreach drafts, session narrative) is deliberately NOT published and is scrubbed from git history.
- **Honesty**: Hooks lock outcomes, not steps. "Always create todos first" stays model-driven and is documented as such. — Don't oversell determinism.
- **Don't reinvent**: Reuse GSD's existing commands/skills and trek-e's published directives unless they break things. — Alignment reduces review friction; but alignment ≠ blind adoption (keep the sharper triage wheel).

<!-- GSD:project-end -->

<!-- GSD:stack-start source:STACK.md -->

## Technology Stack

Technology stack not yet documented. Will populate after codebase mapping or first phase.
<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->

## Conventions

Conventions not yet established. Will populate as patterns emerge during development.
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->

## Architecture

Architecture not yet mapped. Follow existing patterns found in the codebase.
<!-- GSD:architecture-end -->

<!-- GSD:skills-start source:skills/ -->

## Project Skills

No project skills found. Add skills to any of: `.claude/skills/`, `.agents/skills/`, `.cursor/skills/`, `.github/skills/`, or `.codex/skills/` with a `SKILL.md` index file.
<!-- GSD:skills-end -->

<!-- GSD:workflow-start source:GSD defaults -->

## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:

- `/gsd-quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd-debug` for investigation and bug fixing
- `/gsd-execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->

<!-- GSD:profile-start -->

## Developer Profile

> Profile not yet configured. Run `/gsd-profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->

## Dave's conventions (discovered 2026-08-12)

Canonical rules live in docs/guides/contributor-guide.md, README.md, and
.planning/spikes/CONVENTIONS.md; the items below are Dave's operating preferences for this repo.

- Do not oversell determinism or overstate guarantees; an overselling claim is treated as a real
  defect. State honestly what is enforced versus advisory. See README.md ("an overselling claim is
  a real defect").
- Verify a finding by reproducing the actual mechanism on live source before filing. Operating
  note: stated audit/review mechanisms are wrong about a third of the time, so reproduce, do not
  trust the description. See contributor-guide.md P1 ("Verify the finding").
- Escape valves (skip flags) are deliberate, logged, reason-carrying acts requiring a non-empty
  reason string; never a way to dodge a real failure or a fail-closed gate. See contributor-guide.md
  (GSD_CONTRIB_OVERRIDE) and README.md (reason-carrying escape valve).
- Reuse live upstream policy scripts rather than reimplementing or vendoring policy. See README.md
  ("Gate -> LIVE-script reuse", "no vendored fallback").
- Spikes: Node.js/bash `.cjs` scripts only, no package installs, no build step. See
  .planning/spikes/CONVENTIONS.md ("Node.js / bash only").
- Gates fail closed (exit 1 = refuse on absence or malformation); a skipped load-bearing proof is a
  failure, not a silent pass; require two independent signals before calling a claim validated. See
  README.md (EXEC-01, fail-closed) and .planning/spikes/CONVENTIONS.md ("Two independent signals per
  claim").
- TDD RED-first with a proven fail-first, non-vacuous regression test; edit the source, never the
  generated `bin/lib/*.cjs`. See contributor-guide.md P3 ("written first and watched FAIL"), "No
  vacuous tests", and the `binlib-edit` gate.
