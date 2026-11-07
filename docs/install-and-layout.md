# Install and layout

Moved here from the top-level README: how the toolkit is laid out, how the local and published installs
work, how toggling off removes the enforcement, and where the settings live. The short version is in
the [README](../README.md#install).

This repository is the **owned source of truth**. Every at-risk asset lives here
and is symlinked back into `~/.claude`, and `node bin/contrib-capability.cjs install`
is the **sole** entrypoint that restores the full surface - hooks + commands + skills -
idempotently: re-run it after any GSD update or runtime change to repair the toolkit
without losing work, so a reinstall can never lose the toolkit.

## Directory Layout

| Path                    | Purpose                                                                                  |
| ----------------------- | ---------------------------------------------------------------------------------------- |
| `hooks/`                | Harness-run `PreToolUse` gate scripts + the `UserPromptSubmit` advisory + the `PostToolUse`/`PostToolUseFailure` recorder, plus the shared anti-bypass `hooks/lib/` (argv tokenizer, classifier, LIVE-script resolver, fail-closed harness, tree-SHA marker, override receipt, doctor, tool-log reader, verdict log, worktree-add detection, runtime stamp, sandbox/scaffold helpers). `doctor.cjs` and `preflight-shipped-paths.cjs` live here but are deliberately **not wired** - they are CLIs, not hooks. `gsd-planning-track.sh` (PostToolUse) and `gsd-planning-push.sh` (SessionEnd) are opt-in hooks that back up a private `.planning/` repo; they are not part of the capability's wired set. |
| `bin/`                  | Runnable tools: `contrib-capability` (install/toggle), `build-capability` (bundle rebuild/check), `runtime-sync` (ENF-21 runtime; `runtime-sync where` prints the measured Claude config dir, and `sync` refuses the daily `~/.claude` install, CTK-ADR-0013), `verify-hooks`, `self-test`, `lint-ci-stamp`, `triage-assist`, `release-preflight`, `ruleset-drift`, `verify-capability`, `convention-drift`, `verdict-stats` (advisory), `prove-integrity-provenance`, `pr-status` (read-only PR snapshot and ball-in-court; `--cr` for the latest change request's checklist, activity and re-request trace, `--body` for the body's shas and the Self-test report binding), `base-conflicts` (read-only conflicts vs the base, merge objects in a temp object dir), `issue-status` (read-only issue ball-in-court and linked PRs), `push-target` (the PR's head remote and push command, printed only), plus the `gsd-plan-track`/`gsd-refresh` shell helpers. |
| `commands/`             | Vendored slash commands: `gsd-submit`, `gsd-review-sweep`, `gsd-triage-assist`, `gsd-release-preflight`, `gsd-ruleset-drift`; symlinked into `~/.claude`. |
| `skills/`               | Vendored Claude skills: `core-contribution`, `maintainer-review-sweep`; symlinked into `~/.claude`. |
| `capabilities/`         | The share-form GSD capability: the **self-contained** `contribution-toolkit/` bundle - `capability.json` + `fragments/` + the bundled `hooks/` (20 scripts / 22 wired registrations), `skills/` (2), and `commands/` (5) a remote install delivers (NOT hooks-only). |
| `settings.snippet.json` | The canonical hooks settings block - the wired-set source `build-capability.cjs` reads to generate the capability bundle.         |

## Source of Truth and Symlinks

The vendored assets under `skills/` and `commands/` are the **source of truth**.
The copies under `~/.claude` are *symlinks* back into this repository - so editing
the file in `~/.claude` edits the tracked file here, and a GSD reinstall that
clobbers `~/.claude` is repaired by re-running the installer rather than by
recovering lost work.

## Install / Restore

There is **one local entrypoint** - the capability driver
`node bin/contrib-capability.cjs install` - which restores the `~/.claude` symlinks
AND installs/toggles the enforcement; plus a separate published-capability remote
route for anyone other than the owner (see step 2 below).

### 1. Install / Restore the Full Surface (the Capability CLI)

`node bin/contrib-capability.cjs install` is the **single, idempotent, re-runnable**
entrypoint. It delivers the vendored commands + skills (as `~/.claude` symlinks back
into this repo, with a never-clobber fail-safe that refuses to overwrite a real,
non-symlink file) and stages + marker-tags the enforcement gates - so re-running it
after a GSD update or runtime change that clobbers `~/.claude` restores the full
surface without losing work.

The driver drives the LIVE gsd-core capability engine **project-scoped** (into the
local gsd-core checkout's `.claude/settings.json`, never `~/.claude`) and is
**ledger + consent tracked**:

```bash
node bin/contrib-capability.cjs install            # stage + consent + ledger + marker-tag every wired hook
node bin/contrib-capability.cjs on                 # (re)apply the tagged gates, deliver commands + skills, flag on
node bin/contrib-capability.cjs off  --reason <w>  # strip the tagged gates, reclaim commands + skills, flag off, logged receipt
node bin/contrib-capability.cjs status             # report ledger + consent + live gate set
node bin/contrib-capability.cjs remove --reason <w> # remove from ledger + consent, reclaim commands + skills, logged receipt
```

- **`install`** - stages + records consent (a real `bundleContentHash` over the
  bundle), ledger-records, and marker-tags the gates into gsd-core's project
  `.claude/settings.json`, reconciling any legacy duplicate entries into one
  idempotent, byte-stable tagged set.
- **`on`** - re-applies EXACTLY the marker-tagged contrib gates, delivers the
  commands and skills, and flips
  `workflow.gsd_contrib_enforcement` **on** (the flag lives in
  `<gsd-core>/.planning/config.json`).
- **`off`** - strips EXACTLY the marker-tagged gates from `settings.json`
  (untagged + other-capability hooks survive), reclaims the commands and
  skills, flips the flag **off**, and writes an accountability receipt.
- **`status`** - reports the ledger entry, the consent record, and the live gate
  set.
- **`remove`** - strips the gates, deletes the ledger-owned files + drops the
  ledger entry, revokes project consent, and writes a receipt.

### 2. Install From the Published Capability (Remote Git)

The toolkit is also published as a **public, git-installable GSD capability** at
`github.com/davesienkowski/gsd-contribution-toolkit` (tagged `#v2.1.3`). This is the
distribution path for anyone other than the owner restoring local symlinks - it
delivers the **self-contained bundle** (the 20 hook scripts + 2 skills + 5 commands), **not**
a hooks-only artifact. Install it through gsd-core's git capability adapter:

```bash
node <gsd-core>/bin/gsd-tools.cjs capability install \
  https://github.com/davesienkowski/gsd-contribution-toolkit.git#v2.1.3 \
  --scope project --yes --shared-file .claude/settings.json
```

- `--scope project` keeps the enforcement project-scoped to the gsd-core checkout
  (never `~/.claude`), the same blast radius as the local install.
- `--shared-file .claude/settings.json` is **required**: it is where the adapter
  wires the bundled hooks so the gates fire inside the project.
- The toolkit install engine lays the command `.md`s into the runtime commands
  directory (the honest delivery mechanism - mirroring the driver's symlink-delivery
  semantics, just copied from the published tree rather than symlinked from this repo).
- The public repo was renamed to `gsd-contribution-toolkit` from its earlier
  `...-gate` name; GitHub redirects the old URL, so an existing `#v1.0.0` install
  does not hard-break.

**Integrity-pinned npm install.** The bundle is also published to npm as
`@davesienkowski/gsd-contribution-toolkit` (`#v2.1.3`). Unlike the git adapter - which
records a **null** integrity digest - the `npm:` source kind verifies the downloaded
tarball against a real `sha512-` digest **before** staging, so a tampered artifact is
refused fail-closed. This is the only channel that turns the ADR-1244 integrity guarantee
**on** for an installer:

```bash
DIGEST=$(npm view @davesienkowski/gsd-contribution-toolkit@2.1.3 dist.integrity)
node <gsd-core>/bin/gsd-tools.cjs capability install \
  npm:@davesienkowski/gsd-contribution-toolkit@2.1.3 \
  --integrity "$DIGEST" \
  --scope project --yes --shared-file .claude/settings.json
```

- Published digest for `2.1.3`: `sha512-5H+u7QH2bSrrc4tmFiUy1JTnMXq0SqLabFX6lOrNFhDCXHIeJ4648Ix2PTk/Y6zpuRh2NRN/TdJFAyIrn2CQ0Q==`
  (authoritative source is `npm view ... dist.integrity`).
- `capability.json` now carries an ADR-1244 D1 `provenance: { sourceRepo, commit }` block -
  advisory metadata that surfaces in the install ledger and does **not** gate the install.
- Proven end-to-end (positive install + tamper-refused + fail-closed) via
  `bin/prove-integrity-provenance.cjs`; see `proofs/integrity-provenance-proof.md`.

### Toggle-Off Genuinely Removes the Enforcement

This is honest by design: **toggling `off` (or `remove`) GENUINELY removes the
enforcement** - the gates leave gsd-core's `settings.json` (the gates *are* the
enforcement). It is never silent: `off` and `remove` both require a **non-empty
`--reason "<why>"`** and append a logged, per-project-root accountability receipt
at `<realpath(gsd-core)>/.gsd-contrib/override-receipts.log` - append-only JSONL of
`{ ts, action, projectRoot, reason }`, the same log the `GSD_CONTRIB_OVERRIDE`
escape valve uses. An empty reason is rejected before any mutation, and an
un-writable receipt fails the operation (no un-logged disable).

The enforcement is **not** "unbypassable" *as a capability* - only the installed
**personal PreToolUse hooks** are harness-wide and unbypassable **while installed**
(see [What It Does NOT Do](enforcement-reference.md#what-it-does-not-do)). The capability is a deliberate, consent + ledger
tracked, reversible install.

## Settings Scope

The capability install/toggle target is gsd-core's **project**
`.claude/settings.json` - **never** the global `~/.claude/settings.json`. The
project scope keeps the enforcement hooks firing only inside the gsd-core
repository, which is the cleanest blast radius.
