# CTK-ADR-0003: On/off toggles the full surface; per-runtime hybrid delivery; no `.md`→`.cjs` command rewrite

- **Status:** Accepted
- **Review:** Published for maintainer review and open to revision — a changed decision will be recorded
  by a superseding/amending CTK-ADR, never a silent edit to this record.
- **Date:** 2026-06-23 (milestone v2.3)
- **Scope:** GSD Contribution Toolkit.
- **Relates to (gsd-core):** ADR-959 (capability command contribution), ADR-1244 (capability ecosystem).
- **Builds on:** CTK-ADR-0002.

## Context

After CTK-ADR-0002 the lifecycle had a split: `on`/`off` toggled only the hooks + the enforcement
flag, the 5 commands were tied to `install`/`remove`, and the 2 skills were delivered only by a
separate `install.sh`. So disabling the capability left the commands and skills in place. The goal
became: **`off` deactivates the entire surface and `on` restores it**, with the capability also working
**cross-runtime** (Codex, OpenCode, …).

Two hard constraints surfaced:

1. **Symlink delivery is only possible where artifact conversion is identity** — i.e. the Claude
   runtime. Other runtimes need their own dialect, so delivery there must be **copy-convert**; you
   cannot symlink a file that must be transformed.
2. **PreToolUse enforcement is a Claude-harness feature.** The gsd-core runtime registry shows
   non-Claude runtimes emit **no PreToolUse events** — so there is nothing to deny on (e.g. Copilot
   has a hook *surface* but "no hook events emitted"; OpenCode has "no lifecycle hook registration").
   Enforcement cannot exist there regardless of delivery.

A tempting "fix" — rewriting the 5 `.md` slash-commands into `.cjs` `commands[]` so the framework
projects them cross-runtime — was investigated and **rejected on evidence**: ADR-959 +
`capability-loader.cjs` establish that `commands[]` `{family, module, router}` is for **gsd-tools CLI
subcommands**, not agent-facing slash-commands, and there is **no third-party slash-command overlay
surface**. The rewrite would mis-shape agent slash-commands into CLI subcommands and still not produce
cross-runtime slash-commands.

## Decision

1. **`on`/`off` toggle the entire surface** — hooks + commands + skills. `install` lands **fully ON**
   (delivers everything + flips the enforcement flag). `off` strips the gates, reclaims commands +
   skills, and flips the flag off — **after** a receipt-writability probe and **under** the existing
   append-only accountability receipt (an un-loggable disable mutates nothing). `off` preserves
   ledger/consent/bundle so it is re-activatable; `remove` remains the permanent teardown.
2. **Per-runtime hybrid delivery.** Claude: symlink delivery + full PreToolUse enforcement. Non-Claude:
   skills via the native `skills[]` copy-convert, running **advisory-only** (surfaced by an advisory
   note in each skill). Symlink edit-live is documented as a Claude-only property.
3. **No `.md`→`.cjs` command rewrite.** The 5 slash-commands stay `.md`, delivered to Claude.
   Cross-runtime slash-command support is escalated upstream (a third-party slash-command overlay
   surface — see `upstream-feature-requests.md`), not forced in-repo.

## Consequences

- **Positive:** a clean `off`→`on` round-trip restores the whole surface; skills ship cross-runtime;
  the accountability invariant is preserved; the dir-symlink delivery reuses the existing
  never-clobber-real-file / only-reclaim-our-own-link fail-safes.
- **Negative / accepted:** cross-runtime **slash-commands** are not available until gsd-core adds the
  upstream overlay (Claude-only until then); commands delivered via a future native path would lose
  symlink edit-live on Claude (skills retain it).
- **Upstream asks captured (not filed):** an opt-in `link` (symlink) delivery mode where conversion is
  identity; a third-party slash-command overlay surface. The v2.3 driver is the reference
  implementation.

## Alternatives considered

- **Rewrite commands to `.cjs` `commands[]`** — rejected (ADR-959: wrong command kind; no slash-command
  overlay). Documented as the CMD-01 finding.
- **Copy-convert everywhere (drop symlinks even on Claude)** — rejected: loses containment + edit-live
  on the owner's own runtime for no gain, since enforcement is Claude-only anyway.
- **Keep the old availability/enforcement split** — rejected: it left `off` half-disabled, which is the
  behavior this ADR exists to fix.
