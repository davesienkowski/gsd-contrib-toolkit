# Cross-Runtime Delivery Model (RUN-01)

> Scope: this is the focused **RUN-01** record of *how* the contribution toolkit is delivered
> per runtime and *where* its enforcement actually applies. It deliberately does **not** cover
> the `install.sh` retirement (Phase 23) or the full DOC-03 cross-runtime user guide / README
> polish (Phase 24); Phase 24 can fold this into the larger DOC-03 guide.

## The one-paragraph truth

The contribution toolkit is delivered with a **per-runtime hybrid** model, not a single uniform
mechanism. On **Claude Code** the two skills are delivered by **symlink** (containment, edit-live,
byte-control) and the toolkit's **PreToolUse deny enforcement** is fully present. On **non-Claude
runtimes** (Codex, OpenCode, CodeBuddy, …) the same two skills are delivered by the **native
framework's third-party `skills[]` copy-convert** (dialect-translated copies), and **no
PreToolUse-deny surface exists** there, so the toolkit runs **advisory-only**. This is not a fork —
it is one capability projected two ways.

## Per-runtime matrix

| Layer | Claude | Non-Claude runtimes (Codex / OpenCode / others) |
|---|---|---|
| **Skills delivery** | **symlink** delivery — containment, edit-live, byte-control | **native third-party `skills[]` copy-convert** — dialect-translated copies |
| **PreToolUse enforcement** | **full** — gates can deny at the harness tool-call boundary | **none** — no PreToolUse-deny surface exists ⇒ **advisory-only** |

## Why symlink on Claude but copy-convert elsewhere (design §3)

Symlink delivery preserves containment and the **edit-live** workflow, but it is **only physically
possible where artifact conversion is identity** — i.e. the Claude Code runtime, where the canonical
artifact format *is* the runtime dialect, so the delivered file and the source file are the same
bytes. Other runtimes require the framework to **convert** each skill into that runtime's dialect.
That conversion mandates **copy-convert**: you cannot symlink a file that must be transformed — a
symlink would just point at the untranslated canonical bytes. So copy-convert is not a downgrade we
chose; it is the only mechanism that can deliver a *translated* artifact at all.

Consequence, stated plainly: **symlink edit-live is a Claude-only property.** On non-Claude runtimes
the delivered skill is a converted *copy*; editing the canonical source does not live-update the
already-converted copy the way a symlink would.

## Why enforcement is Claude-only (honesty framing)

PreToolUse **deny** enforcement is a **Claude Code harness feature** — the harness fires the hook
before the tool call (even under skip-permissions) and honors a deny decision. The gsd-core runtime
registry shows non-Claude runtimes have **no PreToolUse-deny surface** to fire into: Copilot has
"no hook events," OpenCode has "no lifecycle hook registration." Because the surface does not exist
on those runtimes, enforcement **cannot** exist there **regardless of delivery form** — converting
or symlinking the skill would not change that. On those runtimes the toolkit therefore runs
**advisory-only**: its guidance is advice, not a hard block.

This mirrors the manifest's existing honesty language: the deny property "belongs to those [Claude]
hooks," not to this capability. The capability itself is advisory; the harness hooks are the
enforcement layer, and that layer is Claude-only. The toolkit is never described as
unconditionally guaranteed against circumvention — enforcement is scoped to the Claude harness and
nothing more.

## What already exists vs. what is reused (Reuse-LIVE)

- **Claude symlink delivery already exists** (Phase 21): `deliverBundledSkills` /
  `removeBundledSkills` create directory symlinks resolving the runtime skills dir as
  `${CLAUDE_DIR:-~/.claude}/skills`. RUN-01 adds no new symlink code.
- **Cross-runtime skill delivery is the NATIVE framework's job.** Stock `gsd capability install`
  projects the bundle's declared **`skills[]`** contribution through the LIVE copy-convert /
  conversion pipeline into each runtime's dialect. This repo **reuses** that pipeline — it does
  **not** fork or reimplement copy-convert. RUN-01 adds **no new copy-convert code** in this repo
  (Reuse-LIVE).
- RUN-01's in-repo work is therefore **verify + document**: record this per-runtime model honestly,
  and prove (via `bin/skills-projection-shape.test.cjs`) that the bundle's `skills[]` is already
  shaped for native projection — every declared stem maps to a real bundle
  `skills/<stem>/SKILL.md`, so non-Claude skill delivery is reachable through the LIVE engine with
  no fork.

## Slash-commands are Claude-only this milestone

Slash-commands remain Claude-only for this milestone (ADR-959: the manifest's `commands[]` are
gsd-tools CLI subcommands, not an agent slash-command overlay); cross-runtime slash-commands are
escalated to **UPS-01** (see CMD-01 / UPS-01, Phase 24).
