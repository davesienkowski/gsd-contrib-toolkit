# GSD-Contrib Toolkit

A private, self-contained, GSD-update-proof toolkit that makes a *broken*
`open-gsd/gsd-core` contribution physically impossible to submit. It bundles the
contribution knowledge, the command triggers, and the harness-run `PreToolUse`
hooks that **deny** filing or pushing a broken issue/PR or editing generated
`bin/lib/*.cjs` files.

This repository is the **owned source of truth**. It is structured so that a GSD
reinstall or a `gsd-ver` toggle can never lose the toolkit: every at-risk asset
lives here and is symlinked back into `~/.claude`, and `install.sh` restores
everything idempotently after any GSD update.

## Why this exists

The model-driven skill + commands rationalize past contribution gates under
deadline pressure. Claude Code `PreToolUse` hooks are the only layer the harness
*always* runs — they enforce the outcomes that matter (no broken issue/PR/push,
no generated-file edit) at a boundary the model cannot talk its way around.

## Directory layout

| Path                    | Purpose                                                                                  |
| ----------------------- | ---------------------------------------------------------------------------------------- |
| `skills/`               | Vendored Claude skills (source of truth); `~/.claude/skills/*` symlinks point back here. |
| `commands/`             | Vendored slash commands (e.g. `gsd-submit`, `gsd-review-sweep`); symlinked into `~/.claude`. |
| `hooks/`                | Harness-run `PreToolUse` / `UserPromptSubmit` hook scripts (populated in Phase 3).       |
| `settings.snippet.json` | Hooks settings block that `install.sh` merges into gsd-core's project `.claude/settings.json`. |
| `install.sh`            | Idempotent installer/restorer — recreates symlinks and merges the settings snippet.      |
| `README.md`             | This file.                                                                               |

## Source of truth and symlinks

The vendored assets under `skills/` and `commands/` are the **source of truth**.
The copies that live under `~/.claude` are *symlinks* back into this repository —
so editing the file in `~/.claude` edits the tracked file here, and a GSD
reinstall that clobbers `~/.claude` is repaired by re-running the installer
rather than by recovering lost work.

`hooks/` and `settings.snippet.json` are placeholders today and are filled in by
Phase 3 (the core enforcement hooks).

## Install / restore

To (re)establish the toolkit — including after a GSD update or `gsd-ver` toggle:

```
bash install.sh
```

`install.sh` is idempotent and re-runnable. It recreates the `~/.claude`
symlinks for the vendored skills and commands, and it merges
`settings.snippet.json` into gsd-core's **project-scoped** `.claude/settings.json`
under the `hooks` key — **never** the global `~/.claude/settings.json`. The
project scope keeps the hooks firing only inside the gsd-core repo, which is the
cleanest blast radius.

> `install.sh` is built in plan 01-03; the command above is the forward-looking
> restore instruction.

## Settings scope

`settings.snippet.json` is the *input block* the installer unions into gsd-core's
project `.claude/settings.json` `hooks` array. It is intentionally scoped to the
project settings file (which gsd-core gitignores locally), never the global
`~/.claude/settings.json`, so the enforcement hooks fire only when working inside
the gsd-core repository.
