# GSD Contribution Toolkit

A distributable, opt-in GSD capability (ADR-1244 `role:feature`) that packages the
`open-gsd/gsd-core` **contribution** and **maintainer-review** knowledge, the contribution
tooling, and the contribution gate scripts into one installable bundle. It exists so a
contributor can adopt the whole surface — knowledge, commands, and gates — in a single,
consent-tracked, reversible install rather than copying loose files by hand.

This is the **publish-facing** README that ships inside the capability bundle. For the
repo/dev-facing view (the owned source of truth and its symlink layout) see the root
`README.md`.

## What It Is

The GSD Contribution Toolkit is a self-contained capability bundle. A remote installer gets
the full surface — the gate scripts, both contribution skills, and all five `gsd-*` commands —
delivered into their runtime, plus an advisory planner contribution and a default-off consent
flag. Policy logic is **not** vendored: the bundled gates resolve and invoke the **LIVE
gsd-core scripts**, so the toolkit stays aligned as gsd-core evolves.

## What It Ships

The bundle under `capabilities/contribution-toolkit/{hooks,skills,commands,fragments}/` is
self-contained — not a hooks-only or prose-only artifact. It delivers:

- **13 hooks** — **12 fail-closed `PreToolUse` gates** (issue/PR policy, dedupe, freshness,
  containment, mechanizable invariants, the `lint:ci` marker, commit convention, the
  secret/injection/base64 scan, the generated-`bin/lib` edit guard, and the githooks seal)
  plus **1 advisory `UserPromptSubmit` reminder** that reminds but never denies.
- **2 skills** — `gsd-core-contribution` (the contribution knowledge, including the
  stamp -> marker -> gate -> scan loop) and `maintainer-review-sweep` (the owner/maintainer
  review knowledge).
- **5 commands** — `gsd-submit`, `gsd-review-sweep`, `gsd-triage-assist`,
  `gsd-release-preflight`, `gsd-ruleset-drift`.
- **1 advisory `plan:pre` contribution** — a planner fragment that reminds the planner to
  reuse the LIVE gsd-core scripts when filing or reviewing a contribution.
- **The default-off consent flag** — `workflow.gsd_contrib_enforcement`, which defaults to
  `false`; flipping it to `true` is the explicit opt-in / behavior-consent signal. Until then
  the capability is discovered-but-inactive.

## Install / On / Off / Remove Lifecycle

The local driver `node bin/contrib-capability.cjs` owns the lifecycle. It targets gsd-core's
**project** `.claude/settings.json` (never `~/.claude`) and is ledger + consent tracked:

```bash
node bin/contrib-capability.cjs install            # land fully ON: stage + consent + ledger + marker-tag the gates
node bin/contrib-capability.cjs on                 # (re)apply the tagged gates + flip the enforcement flag on
node bin/contrib-capability.cjs off  --reason <w>  # strip the tagged gates + flag off + logged receipt
node bin/contrib-capability.cjs status             # report ledger + consent + live gate set
node bin/contrib-capability.cjs remove --reason <w># permanent teardown + logged receipt
```

- **`install`** lands the toolkit **fully ON** — it stages the bundle, records consent, writes
  the ledger entry, and marker-tags the gates into the project `settings.json`.
- **`off`** is a **re-activatable disable**: it strips exactly the marker-tagged gates and
  flips the flag off, but leaves the ledger + consent in place so an `off` -> `on` round-trip
  cleanly restores the full surface.
- **`remove`** is **permanent teardown**: it strips the gates, drops the ledger entry, and
  revokes consent.
- Both **`off`** and **`remove`** require a non-empty `--reason "<why>"` and write an
  append-only accountability receipt; an empty reason is rejected before any mutation, so there
  is no un-logged disable.

## Per-Runtime Behavior

The toolkit is delivered with a **per-runtime hybrid** model — one capability projected two
ways, not a fork:

- **Claude Code** — the skills are delivered by **symlink** (containment, edit-live,
  byte-control), and the `PreToolUse` gates are fully present and can deny at the harness
  tool-call boundary.
- **Non-Claude runtimes** (Codex, OpenCode, CodeBuddy, …) — the same skills are delivered by
  the native framework's third-party `skills[]` **copy-convert** (dialect-translated copies).
  No `PreToolUse`-deny surface exists there, so the toolkit runs **advisory-only**.

For the full per-runtime matrix, the symlink-vs-copy-convert rationale, and why slash-commands
are Claude-only, see [`../../docs/cross-runtime-delivery-model.md`](../../docs/cross-runtime-delivery-model.md).

## Honesty

This section is load-bearing — the project's core value is honesty, not overselling.

- **Enforcement is Claude-only.** The deny enforcement is a property of the `PreToolUse` hooks
  themselves, which exist only on Claude Code. This capability adds no harness-wide enforcement
  of its own and is **not** unbypassable; its `gates[]` is empty and it is advisory-only.
- **Off / remove genuinely removes the enforcement.** Toggling `off` (or `remove`) strips the
  gates from gsd-core's `settings.json` — the gates *are* the enforcement, so removing them
  removes it, with a logged receipt every time.
- **Advisory-only on non-Claude runtimes.** Where no `PreToolUse`-deny surface exists, the
  bundled knowledge and commands still help, but nothing denies — that is an honest limitation,
  not a downgrade we chose.
