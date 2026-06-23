# GSD Contribution Toolkit

> A self-contained, installable **GSD capability** that makes a *broken* `open-gsd/gsd-core`
> contribution physically hard to submit — by enforcing the **outcomes** that matter
> (no broken issue/PR/push, no edits to generated files) at the Claude Code harness boundary.

A `role:feature` capability for **GSD 1.6.0+** (ADR-1244 capability ecosystem). It bundles the
*knowledge* (two skills), the *triggers* (five `gsd-*` commands), and the *load-bearing layer* —
twelve `PreToolUse` enforcement hooks that the **harness** runs (not the model) and that call
gsd-core's own LIVE gate scripts at runtime. It installs, toggles, and removes through gsd-core's
native capability system, tracked by gsd-core's ledger + consent.

- **Repo:** `github.com/davesienkowski/gsd-contribution-toolkit`
- **Latest release:** `#v2.1.1`
- **Install:** [§ Install](#install) · **Architecture:** [docs/cross-runtime-delivery-model.md](docs/cross-runtime-delivery-model.md)
- **Reviewers (gsd-core maintainers):** start at [§ For reviewers](#for-reviewers).

---

## Table of contents

- [Why it exists](#why-it-exists)
- [What's included](#whats-included)
- [What it's capable of — by role](#what-its-capable-of--by-role)
- [Install](#install)
- [Manage (on / off / status / remove)](#manage-on--off--status--remove)
- [How it works](#how-it-works)
- [Per-runtime behavior](#per-runtime-behavior)
- [What the gates cover](#what-the-gates-cover)
- [Recovery offramp](#recovery-offramp)
- [Honesty & scope](#honesty--scope)
- [Documentation](#documentation)
- [For reviewers](#for-reviewers)
- [Provenance & versioning](#provenance--versioning)

---

## Why it exists

Skills and slash-commands are model-driven: under deadline pressure a model can rationalize past a
"please run the full suite first" instruction. Pressure-testing the contribution skill confirmed that
variance. **Hooks are the only layer the harness always runs** — they fire *before* the permission
check, so they hold even under `--dangerously-skip-permissions`. This toolkit puts the
non-negotiable contribution outcomes behind that layer, so even a sloppy, deadline-pressured run is
blocked and corrected rather than merged red. (Verifier-reach = spec-reach, applied to one's own
contribution pipeline.)

## What's included

The bundle is **self-contained** — a remote install delivers the full working surface, not a
hooks-only artifact:

| Surface | Count | Items |
|---|---|---|
| `PreToolUse` gates | 12 | `gh-issue-create`, `gh-pr-create`, `gh-edit`, `issue-dedupe`, `policy-invariants`, `lint-ci-marker`, `git-commit-convention`, `containment`, `freshness`, `githooks-seal`, `scan-gate`, `binlib-edit` |
| `UserPromptSubmit` advisory | 1 | `protocol-reminder` |
| Skills | 2 | `gsd-core-contribution`, `maintainer-review-sweep` |
| Commands | 5 | `gsd-submit`, `gsd-review-sweep`, `gsd-triage-assist`, `gsd-release-preflight`, `gsd-ruleset-drift` |
| Loop contribution | 1 | an advisory `plan:pre` fragment, gated by the default-off `workflow.gsd_contrib_enforcement` flag |

The bundled hook scripts **resolve and call the LIVE gsd-core gate scripts at runtime** — they never
reimplement gsd-core policy. When gsd-core's scripts evolve, the gates follow.

## What it's capable of — by role

| Role | What the toolkit gives you |
|---|---|
| **CODEOWNER** (repo owner) | The full enforcement pipeline applied to your *own* contributions: no broken issue/PR/push and no generated-file edits can leave your machine. Plus every maintainer + contributor capability below. |
| **Maintainer** | `gsd-triage-assist` (LIVE dedupe + version-gate + canonical role suggestion), `gsd-release-preflight` (runs the four LIVE release scripts before a release is cut), `gsd-ruleset-drift` (declared `.github/rulesets/` vs live branch protection), and the `maintainer-review-sweep` skill (cost-to-advance triage + re-review of change-requested PRs). |
| **Contributor** | `gsd-submit` files a verified finding as a proper issue + fix PR through the repo's intake gates; gates enforce well-formed issues/PRs, version/template policy, conventional commits, a green `lint:ci` stamp before push, CI-check-run-green before PR, secret/scan cleanliness, and no edits to generated `bin/lib/*.cjs`. |
| **Collaborator** | The same gates as a contributor, plus advisory guidance from the `gsd-core-contribution` skill and a GSD-native [recovery offramp](#recovery-offramp) when a gate denies — so a block becomes a tracked, resumable fix, not a dead stop. |

> Enforcement is a **Claude Code** property (see [Per-runtime behavior](#per-runtime-behavior)). On
> other runtimes the skills + commands still deliver, but the toolkit runs **advisory-only**.

## Install

Install through gsd-core's git capability adapter (ADR-1244 D3):

```bash
node <gsd-core>/bin/gsd-tools.cjs capability install \
  https://github.com/davesienkowski/gsd-contribution-toolkit.git#v2.1.1 \
  --scope project --yes --shared-file .claude/settings.json
```

- `--scope project` installs into the gsd-core checkout (`.gsd/capabilities/contribution-toolkit/` +
  a `.gsd-capabilities.json` ledger), keeping enforcement project-scoped — never `~/.claude`.
  Use `--scope global` for `~/.gsd/...`.
- `--yes` grants consent — the capability ships executable surfaces (the 13 hooks), so the install
  discloses them and aborts without consent.
- `--shared-file .claude/settings.json` is **required to actually wire the hooks** into
  `settings.json`; without it the install records the ledger + overlay but applies no gates.
- Pin a release with `#v2.1.1` (a tag) or `#sha:<40-hex>` (an exact commit). The earlier `…-gate`
  repo name GitHub-redirects, so an existing `#v1.0.0` install does not hard-break.

## Manage (on / off / status / remove)

```bash
node <gsd-core>/bin/gsd-tools.cjs capability status   --scope project
node <gsd-core>/bin/gsd-tools.cjs capability disable  contribution-toolkit --scope project
node <gsd-core>/bin/gsd-tools.cjs capability enable   contribution-toolkit --scope project
node <gsd-core>/bin/gsd-tools.cjs capability update   contribution-toolkit --scope project --yes
node <gsd-core>/bin/gsd-tools.cjs capability remove   contribution-toolkit --scope project
```

`enable`/`disable` toggle the **entire** surface (hooks + commands + skills); `remove` strips exactly
the ledger-recorded files + shared-file fragments and revokes consent — it never deletes shared files
wholesale. `disable`/`remove` genuinely take the enforcement away (the hooks leave `settings.json` —
the hooks *are* the enforcement).

> The owner can also drive the same lifecycle from a local clone via the toolkit's own wrapper
> (`bin/contrib-capability.cjs install|on|off|status|remove`), which auto-applies the shared-edits
> and reconciles legacy untagged entries. Remote installers use the native adapter above.

## How it works

1. **Harness-boundary enforcement.** The 12 `PreToolUse` gates are written into `settings.json` on
   install. The harness runs them before each matching tool call; a broken contribution outcome
   returns `permissionDecision: "deny"`. They fail **closed** — an unparseable command, an
   unreadable body, or a missing LIVE script denies rather than allows.
2. **Reuse, never reimplement.** Each gate resolves and calls the LIVE gsd-core gate script (issue
   version-gate, PR template policy, `lint:ci`, the scan scripts, etc.). See
   [docs/reuse-and-methodology.md](docs/reuse-and-methodology.md).
3. **Accountable override.** A deliberate bypass rides on the existing per-worktree, append-only
   `GSD_CONTRIB_OVERRIDE` receipt (a logged reason-string, never silent) — no new mechanism.

## Per-runtime behavior

Delivery is **per-runtime**, and what it enforces depends on the runtime:

| Layer | Claude Code | Other runtimes (Codex, OpenCode, …) |
|---|---|---|
| Skills | delivered | delivered via the native `skills[]` contribution (copy-convert) |
| Commands | delivered | Claude-only today (no third-party slash-command surface — see [upstream](docs/upstream-feature-requests.md)) |
| `PreToolUse` enforcement | **full** | **none** → toolkit runs **advisory-only** |

Enforcement is a Claude-harness property; everywhere else the toolkit is advice, not a hard block.
Each skill carries an explicit advisory-only note. Full model:
[docs/cross-runtime-delivery-model.md](docs/cross-runtime-delivery-model.md).

## What the gates cover

| Gate | Guards |
|---|---|
| `gh-issue-create` / `gh-pr-create` / `gh-edit` | well-formed, intake-passing issues/PRs (incl. `gh api`/`curl` REST synonyms) |
| `issue-dedupe` | duplicate-issue detection before filing |
| `policy-invariants` | the LIVE gsd-core mechanizable POLICY-02 checks on commit / pr-create |
| `lint-ci-marker` | a fresh, tree-keyed `lint:ci`-green stamp before push |
| `git-commit-convention` | conventional-commit message shape |
| `containment` | edits/pushes confined to the intended worktree |
| `freshness` | acting against a current base |
| `githooks-seal` | git hooks not tampered |
| `scan-gate` | secret / prompt-injection / base64 scans before push |
| `binlib-edit` | no hand-edits to generated `bin/lib/*.cjs` (ADR-457) |

## Recovery offramp

When a gate **denies** — or the `gsd-core-contribution` skill surfaces a real blocking issue
mid-run — you are offered a GSD-native recovery rather than a dead stop: **fix inline with
`/gsd-quick`** for a trivial correction, or **route the issue through the GSD pipeline**
(`/gsd-debug`, or `/gsd-discuss-phase`→`/gsd-plan-phase`→`/gsd-execute-phase`) as a tracked,
resumable work item — then return to the submission once it is green. The offramp is **advisory
only**: the deny stays fail-closed, and it never suggests bypassing a gate or abusing the override.

## Honesty & scope

Please read this as written — don't over-read it:

- The capability's **GSD-loop surfaces are advisory**: `gates[]` is **empty**, and the one
  `plan:pre` contribution fires only inside a GSD command. The capability does **not** reach the
  harness tool-call boundary — a direct issue/PR/push typed outside a GSD command never crosses a
  loop point, so the capability never sees it.
- The **harness-boundary enforcement** is a property of the 12 `PreToolUse` hooks **once installed
  into `settings.json`**, not an inherent property of this (toggleable) capability. **Do not read
  this capability as "unbypassable."**
- It is **fully removable**: `disable`/`remove` genuinely takes the enforcement away.
- Deliberate-bypass accountability rides on the existing per-worktree, append-only
  `GSD_CONTRIB_OVERRIDE` receipt — this capability adds no new receipt mechanism.

## Documentation

- [docs/cross-runtime-delivery-model.md](docs/cross-runtime-delivery-model.md) — the per-runtime
  delivery model, symlink-vs-copy-convert, enforcement-is-Claude-only, the `off`-vs-`remove`
  lifecycle, and why slash-commands are Claude-only (ADR-959).
- [docs/reuse-and-methodology.md](docs/reuse-and-methodology.md) — the reuse map (delegate / wrap /
  leave-alone) and methodology alignment with trek-e's published practices.
- [docs/upstream-feature-requests.md](docs/upstream-feature-requests.md) — two capability-framework
  asks for gsd-core maintainers (an opt-in symlink/`link` delivery mode; a third-party
  slash-command overlay surface), each citing this toolkit as the reference implementation.

## For reviewers

If you maintain gsd-core and are reviewing this toolkit:

- The bundle conforms to the LIVE capability validators (tri-surface `declared == shipped` parity
  across hooks + skills + commands) — see the manifest `capability.json`.
- The two things that would let this capability go *fully native* and *cross-runtime* are written up
  in [docs/upstream-feature-requests.md](docs/upstream-feature-requests.md) — they are framework
  additions, not changes this toolkit can make on its own.
- The honesty contract above is deliberate and enforced by the publish-time conformance check; the
  capability is never presented as carrying harness-wide enforcement on its own.

## Provenance & versioning

- **Version:** 2.1.1 (semver; the bundle is generated from canonical `hooks/`/`skills/`/`commands/`
  with a `--check` drift gate and validated against the LIVE gsd-core capability validators before
  publish). v2.1.1 is a **docs/README release** — the bundle logic is byte-identical to v2.1.0.
- **Source toolkit:** `gsd-contrib-toolkit` (private), through the v2.3 milestone.
- See [CHANGELOG.md](CHANGELOG.md) for the release history.
