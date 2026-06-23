<!-- GSD:project-start source:PROJECT.md -->

## Project

**GSD-Contrib Toolkit**

A private, self-contained, GSD-update-proof toolkit that makes a *broken* `open-gsd/gsd-core`
contribution physically impossible to submit. It bundles the knowledge (the `gsd-core-contribution`
skill), the triggers (`/gsd-submit`, `/gsd-review-sweep`), and — the new load-bearing layer —
Claude Code `PreToolUse` hooks the *harness* runs (not the model), which call gsd-core's own gate
scripts to **deny** filing/pushing a broken issue/PR or editing generated `bin/lib/*.cjs`. For Dave
(a gsd-core CODEOWNER); private now, structured to graduate into a maintainer-shareable contributor
toolkit later.

**Core Value:** Enforce the **outcomes** that matter at the harness boundary — no broken issue/PR/push, no
generated-file edit — so that even a sloppy, deadline-pressured run is blocked and corrected rather
than merged red. (Verifier-reach = spec-reach, applied to Dave's own contribution pipeline.)

### Constraints

- **Enforcement mechanism**: Claude Code `PreToolUse` hooks returning `permissionDecision:"deny"` — fire before permission checks, unbypassable (even `--dangerously-skip-permissions`). — The only layer that survives model rationalization.
- **Containment**: One git repo Dave owns (`~/repos/gsd-contrib-toolkit/`); `~/.claude` copies are symlinks back to it; the driver `node bin/contrib-capability.cjs install` is the idempotent re-runnable-repair path (re-run after any GSD update). — A `gsd-ver`/reinstall toggle must never lose the work.
- **Settings scope**: Project-scoped `gsd-core/.claude/settings.json` (gitignored locally) so hooks fire only in the gsd-core repo. — Cleanest blast radius. (Decision below; revisit if a global+cwd-guard proves necessary.)
- **Privacy**: Nothing committed to or pushed at upstream gsd-core; no upstream repo edits. — Private until proven.
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
