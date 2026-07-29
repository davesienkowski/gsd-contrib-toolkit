# GSD-Contrib Toolkit

A private, self-contained, GSD-update-proof toolkit that makes a *broken*
`open-gsd/gsd-core` contribution physically impossible to submit. It bundles the
contribution knowledge (two skills), the human triggers (five `gsd-*` commands),
the runnable tools (`bin/`), and — the load-bearing layer — the Claude Code
`PreToolUse` hooks the *harness* runs (not the model) to **deny** filing or pushing
a broken issue/PR or editing a generated `bin/lib/*.cjs` artifact.

This repository is the **owned source of truth**. Every at-risk asset lives here
and is symlinked back into `~/.claude`, and `node bin/contrib-capability.cjs install`
is the **sole** entrypoint that restores the full surface — hooks + commands + skills —
idempotently: re-run it after any GSD update or `gsd-ver` toggle to repair the toolkit
without losing work, so a reinstall can never lose the toolkit.

> **New here?** Start with the task-oriented **[Guides](docs/guides/)** — an
> [Overview](docs/guides/overview.md), a [Contributor Guide](docs/guides/contributor-guide.md)
> (file a change through the gates), and a [Maintainer Guide](docs/guides/maintainer-guide.md)
> (triage + re-review). This README is the architecture reference.

## What It Does

It enforces the **outcomes** that matter at the harness boundary — no broken
issue/PR/push, no generated-file edit — using Claude Code `PreToolUse` hooks that
the harness runs on every matching tool call (not the model). Because they fire
before the permission check, they cannot be talked around by a deadline-pressured
or rationalizing model.

Installed into gsd-core's project-scoped `.claude/settings.json` by the capability
CLI (`node bin/contrib-capability.cjs install` — see *Install / restore*) are
**17 hook registrations across 16 hook scripts**: **14 fail-closed `PreToolUse`
gates** (13 on `Bash`, 1 on `Write`/`Edit`), **1 advisory `UserPromptSubmit`
reminder**, and **1 observability recorder** wired on *both* `PostToolUse` and
`PostToolUseFailure` — which is why 16 files produce 17 registrations. Only the
14 `PreToolUse` gates block; the reminder and the recorder never deny. The wired
set is derived from the canonical `settings.snippet.json` (the source
`build-capability.cjs` reads).
The gates close concrete failure classes a gsd-core
contribution gets bounced (or merged red) for:

- shipping **red** — a `git push`/PR with un-green `lint:ci`, a failing
  affected-test set, or a secret/injection/base64 hit in the diff;
- filing a **broken issue/PR** — missing/invalid GSD Version, wrong PR target,
  a policy-violating template body, or a duplicate of an open issue;
- a **hidden generated-file failure** — committing a stale `bin/lib/*.generated.cjs`
  whose `src/*.ts` changed but `build:lib` was never re-run;
- **editing a generated artifact** directly (`bin/lib/*.cjs`) instead of its
  `src/*.ts` source;
- **bypassing the seal** — `--no-verify`, a swapped `core.hooksPath`, or a
  leak of private files up to upstream gsd-core;
- **adjudicating without the re-review evidence** — approving or merging a PR
  without the two orthogonal review passes, a green CI re-fetch, the exogenous
  self-check, or on an unchanged head OID.

### Gate Reference

Every wired `PreToolUse` gate DENIES at the harness boundary; most resolve and call
a **LIVE gsd-core script** rather than reimplementing its policy (see *What it
uses*). The last two rows are the wired **non-blocking** hooks — the advisory
reminder and the observability recorder — listed here so this table enumerates the
wired set exactly.

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
| `protocol-artifact.cjs` | Bash | filing/pushing on a contribution branch without the P1-P3 protocol artifacts | reads the branch diff + the LIVE `gsd-test` run |
| `review-artifact.cjs` | Bash | re-reviewing/approving/merging a PR without the four mechanizable re-review artifacts (step 8 two orthogonal passes, step 13 merge gate, step 1 treadmill guard, step 10 exogenous check), keyed to PR + HEAD OID | reads the review artifacts + the LIVE `gh` CI conclusions |
| `binlib-edit.cjs` | Write/Edit | editing a generated `bin/lib/*.cjs` instead of `src/*.ts` | (generated-path check — no LIVE script) |
| `protocol-reminder.cjs` | UserPromptSubmit | *(advisory only — reminds, never denies)* | — |
| `tool-recorder.cjs` | PostToolUse + PostToolUseFailure | *(observability only — records, never denies; the one hook wired on two events)* | — |

## How It Works

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

## What It Uses

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

## What You Can Do

### Contributor Workflow

- **Install / restore** the toolkit (idempotent):
  `node bin/contrib-capability.cjs install` — see *Install / restore* below.
- The **14 fail-closed `PreToolUse` gates** — the blocking part of the wired set of
  17 registrations; the other entries are the 1 advisory reminder and the 1
  observability recorder — fire automatically inside the gsd-core repo once the
  contribution-toolkit capability is installed (`node bin/contrib-capability.cjs install`).
- Drive a contribution with the **`gsd-submit`** command (file → push → PR through
  the gates) and the **`gsd-core-contribution`** skill (the contribution knowledge,
  including the stamp → marker → gate → scan loop).
- Run a maintainer-style sweep with **`gsd-review-sweep`**.

**Recovery offramp (FLOW-01).** When a contribution gate **denies** an action — or
the `gsd-core-contribution` skill surfaces a real blocking issue mid-run — you are
offered a GSD-native recovery choice rather than a dead-stop: **fix inline with
`/gsd-quick`** for a trivial correction, or **route the issue through the GSD
pipeline** (`/gsd-debug`, or `/gsd-discuss-phase`→`/gsd-plan-phase`→`/gsd-execute-phase`)
as a tracked, resumable work item — then return to the submission once it is green.
This offramp is **advisory only**: the deny stays **fail-closed and unbypassable**,
it NEVER suggests bypassing the gate or abusing `GSD_CONTRIB_OVERRIDE` to dodge a
real failure, and no gate is weakened. (Surfaced from the contribution skill +
`gsd-submit`/`gsd-review-sweep` commands.)

### Owner / Maintainer Pillar

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

### Share-Form Capability

`capabilities/contribution-toolkit/capability.json` packages the contribution +
maintainer-review knowledge as an installable, **opt-in** GSD capability (ADR-1244
`role:feature` manifest). The bundle is **self-contained**: it ships the
**16 hook scripts** (the 14 fail-closed `PreToolUse` gates + 1 advisory
`UserPromptSubmit` reminder + 1 `PostToolUse`/`PostToolUseFailure` observability
recorder = **17 wired registrations**), **both skills**
(`gsd-core-contribution`, `maintainer-review-sweep`), and
**all five commands** (`gsd-submit`, `gsd-review-sweep`, `gsd-triage-assist`,
`gsd-release-preflight`, `gsd-ruleset-drift`) under
`capabilities/contribution-toolkit/{hooks,skills,commands,fragments}/` — it is **not**
a hooks-only or prose-only-commands artifact. It also carries one advisory `plan:pre`
contribution and a default-off `workflow.gsd_contrib_enforcement` consent flag. Its
`gates[]` is **empty** and the capability is **advisory-only** (see
*What it does NOT do*) — the hooks it bundles fire as the **personal PreToolUse
hooks** layer once installed, a property of those hooks and not of the capability.

### Verify / Prove

- `node bin/verify-hooks.cjs` — captures byte-stable deny/allow proof artifacts for
  the gates.
- `node bin/self-test.cjs` — dog-foods the toolkit against a disposable sandbox.
- `node bin/verify-capability.cjs` — validates the share-form manifest by reusing
  the LIVE capability-registry validators (no schema reimplementation).

## What It Does NOT Do

This section is load-bearing — the project's core value is honesty, not overselling.

- **Hooks lock outcomes, not steps — narrowed, not withdrawn.** The gates enforce
  *what must not ship*. They do **not** directly enforce *how* you work — e.g.
  todo-first discipline stays model-driven (the skill plus the advisory
  `UserPromptSubmit` reminder). The narrowing: where a step deposits an
  **artifact**, the next outcome can be gated on that artifact, which makes the
  step enforceable *transitively* (ENF-05's `lint:ci` marker was the first
  instance; ENF-19's protocol artifacts generalise it — see
  [CTK-ADR-0004](docs/adr/CTK-ADR-0004-artifact-gated-step-discipline.md)). A step
  that deposits **nothing** is still unenforceable, and the gate asserts an
  artifact's *shape*, not its honesty.
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
- **Live-proven once; broader battle-testing continues.** The first toolkit-shepherded
  contribution landed upstream (issue #1154 → PR #1738, merged 2026-06-29), so the pipeline has
  cleared a real gsd-core contribution end-to-end. Proving it across the *full* contribution
  surface (enhancements, epics, fork PRs) is the remaining work.

## Directory Layout

| Path                    | Purpose                                                                                  |
| ----------------------- | ---------------------------------------------------------------------------------------- |
| `hooks/`                | Harness-run `PreToolUse` gate scripts + the `UserPromptSubmit` advisory + the `PostToolUse`/`PostToolUseFailure` recorder, plus the shared anti-bypass `hooks/lib/` (argv tokenizer, classifier, LIVE-script resolver, fail-closed harness, tree-SHA marker, override receipt, doctor). `doctor.cjs` and `preflight-shipped-paths.cjs` live here but are deliberately **not wired** — they are CLIs, not hooks. |
| `bin/`                  | Runnable tools: `verify-hooks`, `self-test`, `lint-ci-stamp`, `triage-assist`, `release-preflight`, `ruleset-drift`, `verify-capability`. |
| `commands/`             | Vendored slash commands: `gsd-submit`, `gsd-review-sweep`, `gsd-triage-assist`, `gsd-release-preflight`, `gsd-ruleset-drift`; symlinked into `~/.claude`. |
| `skills/`               | Vendored Claude skills: `gsd-core-contribution`, `maintainer-review-sweep`; symlinked into `~/.claude`. |
| `capabilities/`         | The share-form GSD capability: the **self-contained** `contribution-toolkit/` bundle — `capability.json` + `fragments/` + the bundled `hooks/` (16 scripts / 17 wired registrations), `skills/` (2), and `commands/` (5) a remote install delivers (NOT hooks-only). |
| `settings.snippet.json` | The canonical hooks settings block — the wired-set source `build-capability.cjs` reads to generate the capability bundle.         |

## Source of Truth and Symlinks

The vendored assets under `skills/` and `commands/` are the **source of truth**.
The copies under `~/.claude` are *symlinks* back into this repository — so editing
the file in `~/.claude` edits the tracked file here, and a GSD reinstall that
clobbers `~/.claude` is repaired by re-running the installer rather than by
recovering lost work.

## Install / Restore

There is **one local entrypoint** — the capability driver
`node bin/contrib-capability.cjs install` — which restores the `~/.claude` symlinks
AND installs/toggles the enforcement; plus a separate published-capability remote
route for anyone other than the owner (see step 2 below).

### 1. Install / Restore the Full Surface (the Capability CLI)

`node bin/contrib-capability.cjs install` is the **single, idempotent, re-runnable**
entrypoint. It delivers the vendored commands + skills (as `~/.claude` symlinks back
into this repo, with a never-clobber fail-safe that refuses to overwrite a real,
non-symlink file) and stages + marker-tags the enforcement gates — so re-running it
after a GSD update or `gsd-ver` toggle that clobbers `~/.claude` restores the full
surface without losing work.

The driver drives the LIVE gsd-core capability engine **project-scoped** (into the
local gsd-core checkout's `.claude/settings.json`, never `~/.claude`) and is
**ledger + consent tracked**:

```bash
node bin/contrib-capability.cjs install            # stage + consent + ledger + marker-tag every wired hook
node bin/contrib-capability.cjs on                 # (re)apply the tagged gates + enforcement flag on
node bin/contrib-capability.cjs off  --reason <w>  # strip the tagged gates + flag off + logged receipt
node bin/contrib-capability.cjs status             # report ledger + consent + live gate set
node bin/contrib-capability.cjs remove --reason <w> # remove from ledger + consent + logged receipt
```

- **`install`** — stages + records consent (a real `bundleContentHash` over the
  bundle), ledger-records, and marker-tags the gates into gsd-core's project
  `.claude/settings.json`, reconciling any legacy duplicate entries into one
  idempotent, byte-stable tagged set.
- **`on`** — re-applies EXACTLY the marker-tagged contrib gates and flips
  `workflow.gsd_contrib_enforcement` **on** (the flag lives in
  `<gsd-core>/.planning/config.json`).
- **`off`** — strips EXACTLY the marker-tagged gates from `settings.json`
  (untagged + other-capability hooks survive), flips the flag **off**, and writes
  an accountability receipt.
- **`status`** — reports the ledger entry, the consent record, and the live gate
  set.
- **`remove`** — strips the gates, deletes the ledger-owned files + drops the
  ledger entry, revokes project consent, and writes a receipt.

### 2. Install From the Published Capability (Remote Git)

The toolkit is also published as a **public, git-installable GSD capability** at
`github.com/davesienkowski/gsd-contribution-toolkit` (tagged `#v2.1.3`). This is the
distribution path for anyone other than the owner restoring local symlinks — it
delivers the **self-contained bundle** (the 16 hook scripts + 2 skills + 5 commands), **not**
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
  directory (the honest delivery mechanism — mirroring the driver's symlink-delivery
  semantics, just copied from the published tree rather than symlinked from this repo).
- The public repo was renamed to `gsd-contribution-toolkit` from its earlier
  `…-gate` name; GitHub redirects the old URL, so an existing `#v1.0.0` install
  does not hard-break.

**Integrity-pinned npm install.** The bundle is also published to npm as
`@davesienkowski/gsd-contribution-toolkit` (`#v2.1.3`). Unlike the git adapter — which
records a **null** integrity digest — the `npm:` source kind verifies the downloaded
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
  (authoritative source is `npm view … dist.integrity`).
- `capability.json` now carries an ADR-1244 D1 `provenance: { sourceRepo, commit }` block —
  advisory metadata that surfaces in the install ledger and does **not** gate the install.
- Proven end-to-end (positive install + tamper-refused + fail-closed) via
  `bin/prove-integrity-provenance.cjs`; see `proofs/integrity-provenance-proof.md`.

### Toggle-Off Genuinely Removes the Enforcement

This is honest by design: **toggling `off` (or `remove`) GENUINELY removes the
enforcement** — the gates leave gsd-core's `settings.json` (the gates *are* the
enforcement). It is never silent: `off` and `remove` both require a **non-empty
`--reason "<why>"`** and append a logged, per-project-root accountability receipt
at `<realpath(gsd-core)>/.gsd-contrib/override-receipts.log` — append-only JSONL of
`{ ts, action, projectRoot, reason }`, the same log the `GSD_CONTRIB_OVERRIDE`
escape valve uses. An empty reason is rejected before any mutation, and an
un-writable receipt fails the operation (no un-logged disable).

The enforcement is **not** "unbypassable" *as a capability* — only the installed
**personal PreToolUse hooks** are harness-wide and unbypassable **while installed**
(see *What it does NOT do*). The capability is a deliberate, consent + ledger
tracked, reversible install.

## Settings Scope

The capability install/toggle target is gsd-core's **project**
`.claude/settings.json` — **never** the global `~/.claude/settings.json`. The
project scope keeps the enforcement hooks firing only inside the gsd-core
repository, which is the cleanest blast radius.
