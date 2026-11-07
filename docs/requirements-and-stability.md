# Requirements and stability

Moved here from the top-level README: what you need installed, which surfaces are stable enough to
build on, and how the docs are kept honest by tests.

## Requirements

- **Node.js 22+** (the test suite runs on `node --test`; CI covers 22 and 24).
- **Claude Code** for the enforcement layer. `PreToolUse` hooks are a Claude Code
  harness feature - on other runtimes (Codex, OpenCode, ...) both skills run
  **advisory-only** and the gates do not block. This is stated in each skill and is
  not a degradation to work around.
- A local **`open-gsd/gsd-core`** checkout. The gates resolve and invoke that
  repo's LIVE scripts rather than vendoring copies of its policy, so they need it
  present (see [What It Uses](enforcement-reference.md#what-it-uses)).
- **`gh`** authenticated, for the issue/PR gates and the maintainer assists.

**Optional.** **MemPalace** - a separate third-party cross-session memory tool, providing the
`mempalace` CLI (verified against 3.6.0) - powers the advisory recall/capture steps (contribution
P0c/P7, sweep 1b/10). It is **not required** - those
steps are advisory, nothing downstream depends on them, and if the `mempalace` CLI is absent the
correct behaviour is to skip the step and carry on, exactly as when a concurrent `mine` holds the
palace lock. No gate consults it and no test requires it.

## Stability

The repo is public for reference and reuse, so it is worth saying plainly what you may build on:

| Surface | Stability |
|---|---|
| The **capability install contract** - `capability install <git-or-npm-source> --scope project --shared-file ...` | Stable. Versioned and tagged; the npm channel is integrity-pinned. |
| **`bin/contrib-capability.cjs`** verbs (`install`/`on`/`off`/`status`/`remove`) and the `--reason` requirement | Stable. |
| The **override receipt contract** - `GSD_CONTRIB_OVERRIDE` as a reason string, append-only JSONL | Stable. |
| **Internal step IDs** (`P0`...`P7`, sweep phase numbers), **hook counts**, and **`bin/` script names** | **Not stable - treat as internal.** They renumber whenever a step is added; `P0-P6` became `P0-P7` on 2026-07-31. Don't script against them. |
| **`hooks/lib/*`** internals | Not stable. |

Nothing here carries a deprecation window - see the scope note in the [README](../README.md).

## Docs that tests check

Note that several doc claims are **test-gated**. `docs-hook-counts.test.cjs`
derives the wired hook set from `settings.snippet.json` and asserts the counts
appearing in `docs/enforcement-reference.md`, `docs/install-and-layout.md`, `docs/guides/overview.md`, and the published-capability
README - so a hook added without a doc update fails CI by design. Run the suite
with `node --test` before opening a PR.
