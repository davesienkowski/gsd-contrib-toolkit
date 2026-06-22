# GSD-Contrib Toolkit

A private, self-contained, GSD-update-proof toolkit that makes a *broken*
`open-gsd/gsd-core` contribution physically impossible to submit. It bundles the
contribution knowledge (two skills), the human triggers (five `gsd-*` commands),
the runnable tools (`bin/`), and — the load-bearing layer — the Claude Code
`PreToolUse` hooks the *harness* runs (not the model) to **deny** filing or pushing
a broken issue/PR or editing a generated `bin/lib/*.cjs` artifact.

This repository is the **owned source of truth**. Every at-risk asset lives here
and is symlinked back into `~/.claude`, and `install.sh` restores everything
idempotently after any GSD update or `gsd-ver` toggle — so a reinstall can never
lose the toolkit.

## What it does

It enforces the **outcomes** that matter at the harness boundary — no broken
issue/PR/push, no generated-file edit — using Claude Code `PreToolUse` hooks that
the harness runs on every matching tool call (not the model). Because they fire
before the permission check, they cannot be talked around by a deadline-pressured
or rationalizing model.

Wired into gsd-core's project-scoped settings (`settings.snippet.json`) are
**12 fail-closed PreToolUse gates** (11 on `Bash`, 1 on `Write`/`Edit`) plus
**1 advisory `UserPromptSubmit` reminder**. The gates close concrete failure
classes a gsd-core contribution gets bounced (or merged red) for:

- shipping **red** — a `git push`/PR with un-green `lint:ci`, a failing
  affected-test set, or a secret/injection/base64 hit in the diff;
- filing a **broken issue/PR** — missing/invalid GSD Version, wrong PR target,
  a policy-violating template body, or a duplicate of an open issue;
- a **hidden generated-file failure** — committing a stale `bin/lib/*.generated.cjs`
  whose `src/*.ts` changed but `build:lib` was never re-run;
- **editing a generated artifact** directly (`bin/lib/*.cjs`) instead of its
  `src/*.ts` source;
- **bypassing the seal** — `--no-verify`, a swapped `core.hooksPath`, or a
  leak of private files up to upstream gsd-core.

### Gate reference

Each gate DENIES at the `PreToolUse` boundary; most resolve and call a **LIVE
gsd-core script** rather than reimplementing its policy (see *What it uses*).

| Gate hook | Event | Blocks | LIVE script / check it calls |
| --------- | ----- | ------ | ---------------------------- |
| `gh-issue-create.cjs` | Bash | issue with missing/invalid GSD Version | `scripts/issue-version-gate.cjs` |
| `gh-pr-create.cjs` | Bash | PR with wrong target / bad template / un-green CI | `scripts/pr-target-policy.cjs`, `scripts/pr-template-policy.cjs` |
| `gh-edit.cjs` | Bash | a `gh issue/pr edit` that rewrites a body to fail policy | the same create-gate policies (via REST synonyms) |
| `githooks-seal.cjs` | Bash | `--no-verify` and `core.hooksPath` swaps | (flag/config seal — no LIVE script) |
| `issue-dedupe.cjs` | Bash | filing a duplicate of an open issue | `scripts/issue-dedupe.cjs` (dedupe scorer) |
| `freshness.cjs` | Bash | committing a stale generated `bin/lib/*.generated.cjs` | gsd-core `check:*-fresh` npm scripts |
| `containment.cjs` | Bash | leaking private files into / up to upstream gsd-core | (containment check — no LIVE script) |
| `policy-invariants.cjs` | Bash | a commit/PR that fails a mechanizable ADR/policy invariant | gsd-core's own `check:*` npm scripts |
| `lint-ci-marker.cjs` | Bash | a push/PR without a fresh `lint:ci`-green marker for a clean tree | reads the tree-SHA marker (`npm run lint:ci`) |
| `git-commit-convention.cjs` | Bash | a commit with a missing/wrong conventional-commit prefix | (prefix check — no LIVE script) |
| `scan-gate.cjs` | Bash | a push with a secret/injection/base64 hit | gsd-core's three LIVE scan scripts |
| `binlib-edit.cjs` | Write/Edit | editing a generated `bin/lib/*.cjs` instead of `src/*.ts` | (generated-path check — no LIVE script) |
| `protocol-reminder.cjs` | UserPromptSubmit | *(advisory only — reminds, never denies)* | — |

## How it works

**Harness-boundary enforcement.** A `PreToolUse` hook is run by the Claude Code
harness *before* the tool call's permission check. That makes the **personal
PreToolUse hooks** unbypassable — they fire on every matching tool call even under
`--dangerously-skip-permissions`. This property belongs to these hooks specifically
(not to the share-form capability — see *What it does NOT do*).

**The stamp → marker → gate → scan loop** is the push-readiness path:

1. **Stamp** — `bin/lint-ci-stamp.cjs` runs `npm run lint:ci`; on green it stamps a
   tree-SHA marker recording that this exact tree passed.
2. **Marker** — before a `git push` (or `gh pr create`), `hooks/lint-ci-marker.cjs`
   READS that marker and DENIES if it is absent, stale (tree SHA mismatch), or the
   working tree is dirty.
3. **Scan** — `hooks/scan-gate.cjs` runs gsd-core's secret/injection/base64 scans
   over the diff about to be pushed and DENIES on any hit.

So the model is given a guided path to GREEN, and the harness-run hooks lock the
outcome.

**Gate → LIVE-script reuse.** A gate does not reimplement gsd-core policy; it
resolves the gsd-core worktree and `require()`s the LIVE script via
`hooks/lib/resolve.cjs`. There is deliberately **no vendored fallback** — a missing
or broken LIVE script throws a typed error, and the `runGate` harness in
`hooks/lib/failclosed.cjs` turns any such throw into a **fail-closed DENY** rather
than a silent allow.

**The override valve.** `hooks/lib/override.cjs` reads `GSD_CONTRIB_OVERRIDE` — a
non-empty **reason string** (never a boolean flag, and distinct from the denied
`--no-verify`). When set it writes a timestamped, append-only, **per-worktree**
receipt under `.gsd-contrib/override-receipts.log`. It is a deliberate, logged
escape, never a silent default.

## What it uses

The reuse model is the point: **policy logic lives in gsd-core; this toolkit
resolves and invokes it**, so it stays aligned as gsd-core evolves. The gates and
tools call these LIVE gsd-core scripts (resolved by `hooks/lib/resolve.cjs`) and
never reimplement them:

- **Issue / PR policy** — `scripts/issue-version-gate.cjs`,
  `scripts/issue-dedupe.cjs` (dedupe scorer), `scripts/pr-target-policy.cjs`,
  `scripts/pr-template-policy.cjs`.
- **Green-before-push** — `npm run lint:ci` (stamped) and the affected-test set;
  the three LIVE scan scripts for the secret/injection/base64 gate.
- **Generated-file freshness** — gsd-core's `check:*-fresh` npm scripts
  (e.g. `check:configuration-fresh`, `check:decisions-fresh`,
  `check:state-document-fresh`).
- **Mechanizable invariants** — gsd-core's own `check:*` npm scripts driven by
  `hooks/policy-invariants.cjs`.
- **Release scripts** — `scripts/sync-next-version.cjs`,
  `scripts/sync-manifest-versions.cjs`, `scripts/release-tarball-smoke.cjs`,
  `scripts/check-npm-integrity.cjs` (run non-mutatingly by `release-preflight`).
- **Capability validation** — `scripts/gen-capability-registry.cjs`'s validators
  (reused by `bin/verify-capability.cjs`).

A self-test (`hooks/lib/doctor.cjs`) asserts the LIVE scripts still export the
shapes the gates expect, so a gsd-core refactor that changes a script's shape
surfaces as a fail-closed DENY plus a diagnosable report — not a silent miss.

## What you can do

### Contributor workflow

- **Install / restore** the toolkit (idempotent): `bash install.sh` — see
  *Install / restore* below.
- The **12 contributor gates** fire automatically inside the gsd-core repo once
  the settings snippet is merged.
- Drive a contribution with the **`gsd-submit`** command (file → push → PR through
  the gates) and the **`gsd-core-contribution`** skill (the contribution knowledge,
  including the stamp → marker → gate → scan loop).
- Run a maintainer-style sweep with **`gsd-review-sweep`**.

### Owner / maintainer pillar

These are **advisory** assists (read-only by default — NOT deny-gates), each
reusing LIVE gsd-core scripts and surfaced through a `/gsd-*` command:

- **`gsd-triage-assist`** → `bin/triage-assist.cjs` — LIVE dedupe + version-gate +
  canonical-role suggestion; mutations (e.g. `needs-triage` strip) only behind
  `--apply`.
- **`gsd-release-preflight`** → `bin/release-preflight.cjs` — runs all four LIVE
  release scripts non-mutatingly, aggregates failures, exits nonzero on any.
- **`gsd-ruleset-drift`** → `bin/ruleset-drift.cjs` — diffs declared
  `.github/rulesets/` against live `gh api` state, read-only; LIVE sync behind
  `--apply`.

The **`maintainer-review-sweep`** skill backs these assists.

### Share-form capability

`capabilities/contrib-gate/capability.json` packages the contribution +
maintainer-review knowledge as an installable, **opt-in** GSD capability (ADR-1244
`role:feature` manifest): both skills, all five commands, one advisory `plan:pre`
contribution, and a default-off `workflow.gsd_contrib_enforcement` consent flag.
Its `gates[]` is **empty** and it is **advisory-only** (see *What it does NOT do*).

### Verify / prove

- `node bin/verify-hooks.cjs` — captures byte-stable deny/allow proof artifacts for
  the gates.
- `node bin/self-test.cjs` — dog-foods the toolkit against a disposable sandbox.
- `node bin/verify-capability.cjs` — validates the share-form manifest by reusing
  the LIVE capability-registry validators (no schema reimplementation).

## What it does NOT do

This section is load-bearing — the project's core value is honesty, not overselling.

- **Hooks lock outcomes, not steps.** The gates enforce *what must not ship*. They
  do **not** enforce *how* you work — e.g. todo-first discipline stays model-driven
  (the skill plus the advisory `UserPromptSubmit` reminder). That is an honest
  limitation a `PreToolUse` hook cannot enforce.
- **The share-form capability is advisory-only.** Its `gates[]` is empty; a
  capability gate would block only at the closed set of GSD-loop extension points
  reached *inside* a GSD command. It does **not** reach the harness tool-call
  boundary — a direct issue/PR/push typed outside a GSD command never crosses a
  loop point, so the capability never sees it. The capability must **not** be read
  as unbypassable; only the **personal PreToolUse hooks** are the harness-wide
  enforcement layer.
- **The override is deliberate, not silent.** `GSD_CONTRIB_OVERRIDE` is a logged,
  per-worktree, reason-carrying escape valve — never a default. Setting it records
  an append-only receipt.
- **Not yet battle-tested on a real contribution.** The toolkit is built and
  self-proven; proving it on a live gsd-core contribution remains.

## Directory layout

| Path                    | Purpose                                                                                  |
| ----------------------- | ---------------------------------------------------------------------------------------- |
| `hooks/`                | Harness-run `PreToolUse` / `UserPromptSubmit` gate scripts + the shared anti-bypass `hooks/lib/` (argv tokenizer, classifier, LIVE-script resolver, fail-closed harness, tree-SHA marker, override receipt, doctor). |
| `bin/`                  | Runnable tools: `verify-hooks`, `self-test`, `lint-ci-stamp`, `triage-assist`, `release-preflight`, `ruleset-drift`, `verify-capability`. |
| `commands/`             | Vendored slash commands: `gsd-submit`, `gsd-review-sweep`, `gsd-triage-assist`, `gsd-release-preflight`, `gsd-ruleset-drift`; symlinked into `~/.claude`. |
| `skills/`               | Vendored Claude skills: `gsd-core-contribution`, `maintainer-review-sweep`; symlinked into `~/.claude`. |
| `capabilities/`         | The share-form GSD capability manifest (`contrib-gate/capability.json`) + its fragments. |
| `settings.snippet.json` | The hooks settings block that `install.sh` merges into gsd-core's project `.claude/settings.json`. |
| `install.sh`            | Idempotent installer/restorer — recreates symlinks and merges the settings snippet.      |

## Source of truth and symlinks

The vendored assets under `skills/` and `commands/` are the **source of truth**.
The copies under `~/.claude` are *symlinks* back into this repository — so editing
the file in `~/.claude` edits the tracked file here, and a GSD reinstall that
clobbers `~/.claude` is repaired by re-running the installer rather than by
recovering lost work.

## Install / restore

To (re)establish the toolkit — including after a GSD update or `gsd-ver` toggle:

```bash
bash install.sh /path/to/gsd-core
```

`install.sh` is idempotent and re-runnable. It first **recreates the `~/.claude`
symlinks** for the vendored skills and commands (refusing to clobber a real file),
then **merges** `settings.snippet.json` into gsd-core's **project-scoped**
`.claude/settings.json` by append/union into each hook-event array (deduped, never
array-replace). If no gsd-core path is given, the settings merge is skipped with a
warning and the symlink restore still runs. (`jq >= 1.5` is required for the merge.)

## Settings scope

The merge target is gsd-core's **project** `.claude/settings.json` — **never** the
global `~/.claude/settings.json` (the installer refuses to write it). The project
scope keeps the enforcement hooks firing only inside the gsd-core repository, which
is the cleanest blast radius.
