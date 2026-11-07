# Enforcement reference

The detail behind the [README](../README.md): what the hooks block, the full gate table, how the
enforcement works, what you can do with the toolkit, and (just as important) what it does not do.
Moved here from the top-level README so the front page can stay short. For step-by-step use, see the
[guides](guides/).

## What It Does

It enforces the **outcomes** that matter at the harness boundary - no broken
issue/PR/push, no generated-file edit - using Claude Code `PreToolUse` hooks that
the harness runs on every matching tool call (not the model). Because they fire
before the permission check, they cannot be talked around by a deadline-pressured
or rationalizing model.

Installed into gsd-core's project-scoped `.claude/settings.json` by the capability
CLI (`node bin/contrib-capability.cjs install` - see [Install / Restore](install-and-layout.md#install--restore)) are
**22 hook registrations across 20 hook scripts**: **18 fail-closed `PreToolUse`
gates** (17 on `Bash`, 1 on `Write`/`Edit`; 1 of the `Bash` gates also on
`EnterWorktree`), **1 advisory `UserPromptSubmit` reminder**, and **1
observability recorder** wired on *both* `PostToolUse` and `PostToolUseFailure`.
Two scripts are registered twice: the recorder (on two events) and
`worktree-fresh-base.cjs` (ENF-25, one gate under two `PreToolUse` matchers,
`Bash` and `EnterWorktree`) - which is why 20 files produce 22 registrations.
Only the 18 `PreToolUse` gates block; the reminder and the recorder never deny. The wired
set is derived from the canonical `settings.snippet.json` (the source
`build-capability.cjs` reads).
The gates close concrete failure classes a gsd-core
contribution gets bounced (or merged red) for:

- shipping **red** - a `git push`/PR with un-green `lint:ci`, a failing
  affected-test set, or a secret/injection/base64 hit in the diff;
- filing a **broken issue/PR** - missing/invalid GSD Version, wrong PR target,
  a policy-violating template body, or a duplicate of an open issue;
- a **hidden generated-file failure** - committing a stale `bin/lib/*.generated.cjs`
  whose `src/*.ts` changed but `build:lib` was never re-run;
- **editing a generated artifact** directly (`bin/lib/*.cjs`) instead of its
  `src/*.ts` source;
- **bypassing the seal**: `--no-verify`, a swapped `core.hooksPath` (the effective value must be
  `.githooks`, or a session dispatcher that passes a delegation canary with the repo value `.githooks`,
  [CTK-ADR-0015](adr/CTK-ADR-0015-enf13-accepts-a-dispatcher-that-passes-a-delegation-canary.md)),
  a typed override in the forms
  [CTK-ADR-0016](adr/CTK-ADR-0016-enf13-typed-scan-reads-as-git-and-the-shell-read.md) lists (it stops typed
  forms, nothing more),
  or a leak of private files up to upstream gsd-core;
- **adjudicating without the re-review evidence** - approving or merging a PR
  without the two orthogonal review passes, a green CI re-fetch, the exogenous
  self-check, or on an unchanged head OID; or approving / requesting changes
  without the memtrace graph pass (step 8a) recorded in this session.

### Gate Reference

Every wired `PreToolUse` gate DENIES at the harness boundary; most resolve and call
a **LIVE gsd-core script** rather than reimplementing its policy (see *What it
uses*). The last two rows are the wired **non-blocking** hooks - the advisory
reminder and the observability recorder - listed here so this table enumerates the
wired set exactly.

| Gate hook | Event | Blocks | LIVE script / check it calls |
| --------- | ----- | ------ | ---------------------------- |
| `gh-issue-create.cjs` | Bash | issue with missing/invalid GSD Version | `scripts/issue-version-gate.cjs` |
| `gh-pr-create.cjs` | Bash | PR with wrong target, bad template, missing `Fixes #N`/`Closes #N` linked issue, bad branch name (`^(fix\|docs\|feat)/\d+-`), un-green CI check-runs on the head SHA (ENF-18), or a Feature/Enhancement PR whose linked issue lacks an `approved-*` label (CF-02; the Fix and Internal buckets are exempt). A tests-only or docs-only PR may use the non-closing `Refs #N` form (BUG-4645) | `scripts/pr-target-policy.cjs`, `scripts/pr-template-policy.cjs`; the linked-issue, branch-name, check-runs and CF-02 checks are toolkit-owned |
| `gh-edit.cjs` | Bash | a `gh issue/pr edit` that rewrites a body to fail policy | the same create-gate policies (via REST synonyms) |
| `githooks-seal.cjs` | Bash | `--no-verify` and `core.hooksPath` swaps: the effective value must be `.githooks`, or a session dispatcher that passes a delegation canary with the repo value `.githooks` ([CTK-ADR-0015](adr/CTK-ADR-0015-enf13-accepts-a-dispatcher-that-passes-a-delegation-canary.md)); the override forms [CTK-ADR-0016](adr/CTK-ADR-0016-enf13-typed-scan-reads-as-git-and-the-shell-read.md) lists deny when typed in the command, and it stops typed forms, nothing more (arms on every push from a gsd-core checkout, fork and backup pushes included) | (flag/config seal, no LIVE script) |
| `issue-dedupe.cjs` | Bash | filing a duplicate of an open issue | `scripts/issue-dedupe.cjs` (dedupe scorer) |
| `freshness.cjs` | Bash | committing a stale generated `bin/lib/*.generated.cjs` | gsd-core `check:*-fresh` npm scripts |
| `containment.cjs` | Bash | leaking private files into / up to upstream gsd-core (its GitHub rename aliases count as upstream) | (containment check - no LIVE script) |
| `policy-invariants.cjs` | Bash | a commit/PR that fails a mechanizable ADR/policy invariant | gsd-core's own `check:*` npm scripts |
| `lint-ci-marker.cjs` | Bash | a push/PR without a fresh `lint:ci`-green marker for a clean tree (a push whose every target resolves to another owner/repo, such as a fork or backup remote, does not arm it; a push to upstream, an unresolvable target or a push with no explicit remote keeps the rule) | reads the tree-SHA marker (`npm run lint:ci`) |
| `git-commit-convention.cjs` | Bash | a commit with a missing/wrong conventional-commit prefix | (prefix check - no LIVE script) |
| `scan-gate.cjs` | Bash | a push with a secret/injection/base64 hit (arms on every push from a gsd-core checkout, fork and backup pushes included) | gsd-core's three LIVE scan scripts |
| `protocol-artifact.cjs` | Bash | filing/pushing on a contribution branch without the P1-P3 protocol artifacts (a push whose every target resolves to another owner/repo, such as a fork or backup remote, does not arm it; a push to upstream, an unresolvable target or a push with no explicit remote keeps the rule) | reads the branch diff + the LIVE `gsd-test` run |
| `review-artifact.cjs` | Bash | re-reviewing/approving/merging a PR (including the `gh api graphql` review-mutation route and a GraphQL query read from a file or stdin) without the mechanizable re-review evidence, keyed to PR + HEAD OID: the step 8 two orthogonal passes, step 13 merge gate, step 1 treadmill guard and step 10 exogenous check artifacts, and, for an approve or request-changes, step 8a memtrace evidence (`get_impact`, `get_symbol_context`, one recorded-decision verb) in tool-recorder's log for the session (`ask` when the log cannot answer, or when a filled `R8a-memtrace.json` attests memtrace was unavailable) | reads the review artifacts + the LIVE `gh` CI conclusions + tool-recorder's `tool-log.jsonl` for the session |
| `runtime-drift.cjs` | Bash | filing/pushing to `open-gsd/gsd-core` while the installed runtime of the session's Claude config dir (`$CLAUDE_CONFIG_DIR/gsd-core`, else `~/.claude/gsd-core`) is unstamped, digest-mismatched, or behind `origin/next`, or while the managed gsd-core hooks under that dir's `hooks/` are digest-mismatched or the stamp predates hook coverage (ENF-21, CTK-ADR-0011, CTK-ADR-0013; an invalid `CLAUDE_CONFIG_DIR` denies, and in the daily `~/.claude` a deny also says to start a contribution session; `ask`, never deny, when the upstream tip is unobtainable). A push arms on its target remote or URL: a plain push to a fork or backup remote passes, an upstream URL arms from anywhere, and a push with no explicit or no resolvable remote, or inside a command that is not an allowlisted plain form (a subshell, `bash -c`, an env assignment, a redirection, a config write, a `cd` to a bare relative directory that CDPATH could redirect), keeps the cwd rule; a literal URL that git maps to a configured remote is judged by that remote's URLs | (toolkit-owned stamp + `git ls-remote`; no LIVE script) |
| `gsd-test-clean-tree.cjs` | Bash | a `gsd-test` dispatch from a gsd-core checkout whose tracked tree is dirty while the run tests the working HEAD, or whose output is piped without `pipefail` (ENF-23) | (toolkit-owned `git status` + `git rev-parse` - no LIVE script) |
| `gsd-test-viability.cjs` | Bash | a `gsd-test` dispatch whose `config.toml` is missing, whose named `--bench` is absent from it, or whose local Docker daemon is missing/down (ENF-24; `ask`, never deny, when `docker info` overruns its 8 s bound) | (toolkit-owned config read + `docker info` - no LIVE script) |
| `worktree-fresh-base.cjs` | Bash + EnterWorktree | cutting a gsd-core worktree from a stale trunk: on a trunk cut it fetches `origin/next` and fast-forwards an unheld stale local `next` (compare-and-swap, never a reset), and denies with the fix when `next` is held by a worktree or has diverged (ENF-25; `ask`, never deny, when origin is unobtainable) | (toolkit-owned bounded `git fetch` + `update-ref` - no LIVE script; see [CTK-ADR-0009](adr/CTK-ADR-0009-gate-bounded-monotonic-ref-refresh.md)) |
| `binlib-edit.cjs` | Write/Edit | editing a generated `bin/lib/**/*.cjs` instead of its `src/*.cts` source | (generated-path candidate + repository pinning + read-only `git check-ignore` discriminator: ignored -> deny, tracked or not ignored -> allow, undecidable or redirected repository -> deny - no LIVE script) |
| `protocol-reminder.cjs` | UserPromptSubmit | *(advisory only - reminds, never denies)* | - |
| `tool-recorder.cjs` | PostToolUse + PostToolUseFailure | *(observability only - records, never denies; the one hook wired on two events)* | - |

**ENF-20 step 8a (memtrace evidence).** The evidence for an approve or request-changes is tool-recorder's own log
for the session (`tool-log.jsonl` and the rotated `tool-log.1.jsonl`): it proves `get_impact`, `get_symbol_context` and
a recorded-decision verb ran in this session, not which symbols they targeted, and a review-body section never counts.
Subagent tool calls are logged under the parent `session_id` (measured 2026-10-06 on Claude Code 2.1.291, one level
deep, foreground and background, print mode), including an MCP tool call made inside a subagent (a context7 call; a
memtrace verb is an MCP tool call on the same hook path), so a granted subagent's memtrace calls count; tool-recorder
drops `agent_id`, so the log does not say which agent ran them. The forms not measured are listed in CTK-ADR-0010. When memtrace genuinely cannot run, or its calls are not
visible to the recorder, the sanctioned escape is filling the scaffolded `.gsd/contrib/pr-<n>-<oid12>/R8a-memtrace.json`
with `status: "unavailable"`: the gate then asks a human and never allows by itself. See
[CTK-ADR-0010](adr/CTK-ADR-0010-memtrace-review-evidence.md) (Accepted).

### Worktree cuts `worktree-fresh-base` cannot see

The fresh-base check (ENF-25) runs only when Claude Code itself is about to cut the worktree: a
`git worktree add` typed through the Bash tool, or the harness `EnterWorktree` tool. A worktree
created any other way is never seen, so its trunk is not refreshed and a stale `next` is not denied:

- **Orca.** `orca-ide` creates worktrees out of band under `~/orca/workspaces/<repo>/<name>`. Neither
  a Bash `git worktree add` nor `EnterWorktree` passes through Claude Code, so no hook fires.
- **GSD's own worktree engine.** It runs `git worktree add` from a node child process (the installed
  runtime's worktree-safety module calls `execGit(['worktree', 'add', ...])`, a `spawnSync('git', ...)`
  wrapper), not through the Bash tool, so no Claude Code hook is in that path.
- **Any other creator outside the Bash tool and `EnterWorktree`**: an IDE, a terminal outside Claude
  Code, a script or Makefile the agent runs, or a newline-joined multi-line command (the shared
  command parser reads an unquoted newline as whitespace, so a cut on a later line is missed).

Before cutting a gsd-core worktree any of those ways, refresh the trunk by hand:

```bash
git -C <gsd-core checkout> fetch origin next
# then fast-forward the tree that has next checked out:
git -C <tree holding next> merge --ff-only origin/next
# or skip local next entirely and base the worktree on origin/next
```

Whether the harness itself fetches before an `EnterWorktree` cut under `worktree.baseRef=fresh` is
**UNVERIFIED**. When this gate fires, it runs its own bounded fetch regardless.

**When the refresh happens, and where.** The gate acts only in a clone whose `origin` is
`open-gsd/gsd-core` (a fork-only clone, a vendored copy inside another repository, or a clone with
no `origin` is left alone). Its fetch and fast-forward run in the `PreToolUse` hook, which fires
when the agent PROPOSES the cut, before the permission prompt. They are not undone if you then
decline the command, if another gate denies it, or if this gate denies a later cut in the same
command. Local `next` only ever moves forward, and each move is recorded in `next`'s reflog
(`git reflog show next`). `origin/next` is updated the way any `git fetch` updates it, so it follows
an upstream force-push. The gate refuses to move a `next` that is checked out, or being rebased or
bisected in any worktree. Before any fetch it also refuses when `next` or `origin/next` is a
symbolic ref or a filesystem symlink, because the write would land on another branch. See [CTK-ADR-0009](adr/CTK-ADR-0009-gate-bounded-monotonic-ref-refresh.md)
for the full list of shapes it cannot see (shell functions, command substitutions, `xargs` and
similar wrappers, git aliases).

## How It Works

**Harness-boundary enforcement.** A `PreToolUse` hook is run by the Claude Code
harness *before* the tool call's permission check. That makes the **personal
PreToolUse hooks** unbypassable - they fire on every matching tool call even under
`--dangerously-skip-permissions`. This property belongs to these hooks specifically
(not to the share-form capability - see *What it does NOT do*).

**The stamp -> marker -> gate -> scan loop** is the push-readiness path:

1. **Stamp** - `bin/lint-ci-stamp.cjs` runs `npm run lint:ci`; on green it stamps a
   tree-SHA marker recording that this exact tree passed.
2. **Marker** - before a `git push` (or `gh pr create`), `hooks/lint-ci-marker.cjs`
   READS that marker and DENIES if it is absent, stale (tree SHA mismatch), or the
   working tree is dirty.
3. **Scan** - `hooks/scan-gate.cjs` runs gsd-core's secret/injection/base64 scans
   over the `<base>...HEAD` range (the commits this push carries) and DENIES on any hit.

So the model is given a guided path to GREEN, and the harness-run hooks lock the
outcome.

**Gate -> LIVE-script reuse.** A gate does not reimplement gsd-core policy; it
resolves the gsd-core worktree and `require()`s the LIVE script via
`hooks/lib/resolve.cjs`. There is deliberately **no vendored fallback** - a missing
or broken LIVE script throws a typed error, and the `runGate` harness in
`hooks/lib/failclosed.cjs` turns any such throw into a **fail-closed DENY** rather
than a silent allow.

**The override valve.** `hooks/lib/override.cjs` reads `GSD_CONTRIB_OVERRIDE`, a
non-empty **reason string** (never a boolean flag, and distinct from the denied
`--no-verify`). Every gate honors it for a **thrown gate error**: a gate that
could not run (a LIVE script that will not load, an unparseable command, a failed
`gh` or file read). When it flips such an error to allow, it writes a timestamped,
append-only, **per-worktree** receipt under `.gsd-contrib/override-receipts.log`.
It does **not** lift a returned policy deny (a missing artifact, a duplicate issue,
`--no-verify`), with one exception that says so in its own deny text: ENF-07
containment honors it for a deliberate maintainer push to `origin`, with a receipt.
Turning the gates off is a human operator's decision, not a way past a deny:
`node bin/contrib-capability.cjs off --reason "<why>"` strips the toolkit's gates
from that gsd-core checkout and writes a receipt. It is a deliberate, logged
escape, never a silent default.

## What It Uses

The reuse model is the point: **policy logic lives in gsd-core; this toolkit
resolves and invokes it**, so it stays aligned as gsd-core evolves. The gates and
tools call these LIVE gsd-core scripts (resolved by `hooks/lib/resolve.cjs`) and
never reimplement them:

- **Issue / PR policy** - `scripts/issue-version-gate.cjs`,
  `scripts/issue-dedupe.cjs` (dedupe scorer), `scripts/pr-target-policy.cjs`,
  `scripts/pr-template-policy.cjs`.
- **Green-before-push** - `npm run lint:ci` (stamped) and the affected-test set;
  the three LIVE scan scripts for the secret/injection/base64 gate.
- **Generated-file freshness** - gsd-core's `check:*-fresh` npm scripts
  (e.g. `check:configuration-fresh`, `check:decisions-fresh`,
  `check:state-document-fresh`).
- **Mechanizable invariants** - gsd-core's own `check:*` npm scripts driven by
  `hooks/policy-invariants.cjs`.
- **Release scripts** - `scripts/sync-next-version.cjs`,
  `scripts/sync-manifest-versions.cjs`, `scripts/release-tarball-smoke.cjs`,
  `scripts/check-npm-integrity.cjs` (run non-mutatingly by `release-preflight`).
- **Capability validation** - `scripts/gen-capability-registry.cjs`'s validators
  (reused by `bin/verify-capability.cjs`).

A self-test (`hooks/lib/doctor.cjs`) asserts the LIVE scripts still export the
shapes the gates expect, so a gsd-core refactor that changes a script's shape
surfaces as a fail-closed DENY plus a diagnosable report - not a silent miss.

## What You Can Do

### Contributor Workflow

- **Install / restore** the toolkit (idempotent):
  `node bin/contrib-capability.cjs install` - see [Install / Restore](install-and-layout.md#install--restore).
- The **18 fail-closed `PreToolUse` gates** - the blocking part of the wired set of
  22 registrations; the other entries are the 1 advisory reminder and the 1
  observability recorder - fire automatically inside the gsd-core repo once the
  contribution-toolkit capability is installed (`node bin/contrib-capability.cjs install`).
- Drive a contribution with the **`gsd-submit`** command (file -> push -> PR through
  the gates) and the **`core-contribution`** skill (the contribution knowledge,
  including the stamp -> marker -> gate -> scan loop).
- Run a maintainer-style sweep with **`gsd-review-sweep`**.

**Recovery offramp (FLOW-01).** When a contribution gate **denies** an action - or
the `core-contribution` skill surfaces a real blocking issue mid-run - you are
offered a GSD-native recovery choice rather than a dead-stop: **fix inline with
`/gsd-quick`** for a trivial correction, or **route the issue through the GSD
pipeline** (`/gsd-debug`, or `/gsd-discuss-phase`->`/gsd-plan-phase`->`/gsd-execute-phase`)
as a tracked, resumable work item - then return to the submission once it is green.
This offramp is **advisory only**: the deny stays **fail-closed and unbypassable**,
it NEVER suggests bypassing the gate or abusing `GSD_CONTRIB_OVERRIDE` to dodge a
real failure, and no gate is weakened. (Surfaced from the contribution skill +
`gsd-submit`/`gsd-review-sweep` commands.)

### Owner / Maintainer Pillar

These are **advisory** assists (read-only by default - NOT deny-gates), each
reusing LIVE gsd-core scripts and surfaced through a `/gsd-*` command:

- **`gsd-triage-assist`** -> `bin/triage-assist.cjs` - LIVE dedupe + version-gate +
  canonical-role suggestion; mutations (e.g. `needs-triage` strip) only behind
  `--apply`.
- **`gsd-release-preflight`** -> `bin/release-preflight.cjs` - runs all four LIVE
  release scripts non-mutatingly, aggregates failures, exits nonzero on any.
- **`gsd-ruleset-drift`** -> `bin/ruleset-drift.cjs` - diffs declared
  `.github/rulesets/` against live `gh api` state, read-only; LIVE sync behind
  `--apply`.

The **`maintainer-review-sweep`** skill backs these assists. It mirrors the
review/triage side of the lead maintainer's own now-published process
([`review-open-prs.md`, `triage-review.md`, `bug-fixer.md`, `feature-builder.md`](https://github.com/The-Artificer-of-Ciphers-LLC/skills-from-the-artificer/tree/main/commands)):
the two-orthogonal-passes gate, multi-tier severity, Generative-Fix-Divergence,
the memtrace graph passes + co-change completeness gate, the external-tool gate,
and the test-quality ruleset. It **deliberately diverges** on autonomy - trek-e's
directives can merge unattended (`bug-fixer` always, `feature-builder`/`review`
behind an `AUTONOMOUS` flag), whereas this toolkit keeps all authoring behind the
human-gated `core-contribution` pipeline and its fail-closed push gate
(CTK-ADR-0001) and never self-merges - and inverts his memtrace-first stance where
this environment's `get_impact` floor makes grep the authority for callers.

### Share-Form Capability

`capabilities/contribution-toolkit/capability.json` packages the contribution +
maintainer-review knowledge as an installable, **opt-in** GSD capability (ADR-1244
`role:feature` manifest). The bundle is **self-contained**: it ships the
**20 hook scripts** (the 18 fail-closed `PreToolUse` gates on 19 registrations,
ENF-25 being registered under both `Bash` and `EnterWorktree` + 1 advisory
`UserPromptSubmit` reminder + 1 `PostToolUse`/`PostToolUseFailure` observability
recorder on 2 registrations = **22 wired registrations**), **both skills**
(`core-contribution`, `maintainer-review-sweep`), and
**all five commands** (`gsd-submit`, `gsd-review-sweep`, `gsd-triage-assist`,
`gsd-release-preflight`, `gsd-ruleset-drift`) under
`capabilities/contribution-toolkit/{hooks,skills,commands,fragments}/` - it is **not**
a hooks-only or prose-only-commands artifact. It also carries one advisory `plan:pre`
contribution and a default-off `workflow.gsd_contrib_enforcement` consent flag. Its
`gates[]` is **empty** and the capability is **advisory-only** (see
*What it does NOT do*) - the hooks it bundles fire as the **personal PreToolUse
hooks** layer once installed, a property of those hooks and not of the capability.

### Verify / Prove

- `node bin/verify-hooks.cjs` - captures byte-stable deny/allow proof artifacts for
  the gates.
- `node bin/self-test.cjs` - dog-foods the toolkit against a disposable sandbox.
  **Run it with your cwd inside a gsd-core checkout** (`cd ~/repos/gsd-core && node
  /path/to/gsd-contrib-toolkit/bin/self-test.cjs`), the same requirement `hooks/doctor.cjs`
  has. The HARD-01/HARD-02 fault-injection proofs build their sandbox from a real checkout
  and SKIP without one - and since 2026-07-30 a skipped load-bearing proof is a **failure**,
  not a silent pass (EXEC-01). Run from the toolkit root it exits 1 and names the reason.
- `node bin/verify-capability.cjs` - validates the share-form manifest by reusing
  the LIVE capability-registry validators (no schema reimplementation).

## What It Does NOT Do

This section is load-bearing - the project's core value is honesty, not overselling.

- **This is not a security control, and "unbypassable" is scoped.** The gates bind **the model inside
  a session**, not a human at a keyboard. The word "unbypassable" throughout these docs means *the
  model cannot talk its way past a `PreToolUse` deny* - including under
  `--dangerously-skip-permissions`. It does **not** mean tamper-proof: anyone with filesystem access
  can run `contrib-capability off --reason ...`, edit gsd-core's `.claude/settings.json`, or delete the
  hooks outright, and every one of those is documented here on purpose. The design assumes the
  operator knows every bypass, because the operator *is* the person being bound - this is a
  self-binding commitment device (Ulysses and the mast), not a perimeter. Do not deploy it as a
  control against an untrusted party; it was never designed to survive one, and publishing it costs
  nothing precisely because its value never depended on the design being secret.
- **Hooks lock outcomes, not steps - narrowed, not withdrawn.** The gates enforce
  *what must not ship*. They do **not** directly enforce *how* you work - e.g.
  todo-first discipline stays model-driven (the skill plus the advisory
  `UserPromptSubmit` reminder). The narrowing: where a step deposits an
  **artifact**, the next outcome can be gated on that artifact, which makes the
  step enforceable *transitively* (ENF-05's `lint:ci` marker was the first
  instance; ENF-19's protocol artifacts generalise it - see
  [CTK-ADR-0004](adr/CTK-ADR-0004-artifact-gated-step-discipline.md)). A step
  that deposits **nothing** is still unenforceable, and the gate asserts an
  artifact's *shape*, not its honesty.
- **The share-form capability is advisory-only.** Its `gates[]` is empty; a
  capability gate would block only at the closed set of GSD-loop extension points
  reached *inside* a GSD command. It does **not** reach the harness tool-call
  boundary - a direct issue/PR/push typed outside a GSD command never crosses a
  loop point, so the capability never sees it. The capability must **not** be read
  as unbypassable; only the **personal PreToolUse hooks** are the harness-wide
  enforcement layer.
- **The override is deliberate, not silent.** `GSD_CONTRIB_OVERRIDE` is a logged,
  per-worktree, reason-carrying valve for a thrown gate error, never a default.
  It does not lift a returned policy deny; the one exception is ENF-07's
  deliberate maintainer push to `origin`, which its deny names. Turning the gates
  off is a human operator's decision: `node bin/contrib-capability.cjs off --reason "<why>"`,
  which is logged too.
- **Live-proven once; broader battle-testing continues.** The first toolkit-shepherded
  contribution landed upstream (issue #1154 -> PR #1738, merged 2026-06-29), so the pipeline has
  cleared a real gsd-core contribution end-to-end. Proving it across the *full* contribution
  surface (enhancements, epics, fork PRs) is the remaining work.
