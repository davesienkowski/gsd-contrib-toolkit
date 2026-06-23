# Commands reference

The toolkit ships **five** `gsd-*` slash-commands. Each is a thin *trigger* — two drive a skill, three
drive a LIVE-script doer in `bin/`. This page documents what each does, the **accepted arguments**, and
the safety model.

Conventions used below:
- **Synopsis** shows the slash invocation and its `argument-hint` (the accepted argument shapes).
- `$ARGUMENTS` is free-form: where a command says it "interprets" your text, you can type plain prose
  and it resolves the mode.
- **Mutation safety:** commands are either *advisory* (surface only) or carry an explicit, opt-in apply
  path. None mutates GitHub or the working tree by default unless stated.

> **Runtime note.** Slash-commands and their enforcement are a **Claude Code** feature. On non-Claude
> runtimes the toolkit runs advisory-only and these commands may not be available as slash-commands
> (see [cross-runtime-delivery-model.md](cross-runtime-delivery-model.md)).

---

## Contributor

### `/gsd-submit`

**Synopsis:** `/gsd-submit <finding / bug description, or an audit item like "M-7">`

File a verified finding as a proper `open-gsd/gsd-core` **issue + fix PR**, following the
[`gsd-core-contribution`](skills-reference.md#gsd-core-contribution) skill's gated P0–P6 pipeline
exactly. It loads the skill first, builds the gated todo checklist, and works it top-to-bottom — no
`[GATE]` todo is marked done without the real command output proving its pass condition.

**Accepted arguments** (`$ARGUMENTS`, free-form — interpreted):
- A full sentence or rough description of the bug/change.
- A rough label (e.g. an audit item `M-7` / `M7`).
- If the text is too vague to identify a specific defect/location, the command asks **one** clarifying
  question before proceeding.

**Examples:**
```text
/gsd-submit the version-gate regex accepts a trailing newline — see issue #1549
/gsd-submit M-7
/gsd-submit fix the dedupe scorer off-by-one in scripts/issue-dedupe.cjs
```

**Notes:** urgency / authority / "it's trivial, skip the gates" framing does **not** waive a step
(the skill names this as the rationalization it guards against). If a gate denies, the
[recovery offramp](#recovery-offramp) applies. `allowed-tools: Skill, Bash, Read, Edit, Write, Grep, Glob`.

---

## Maintainer

### `/gsd-review-sweep`

**Synopsis:** `/gsd-review-sweep (empty = triage sweep) | re-review #N | clear #N merge=#N`

Maintainer triage + re-review sweep of `open-gsd/gsd-core`, following the
[`maintainer-review-sweep`](skills-reference.md#maintainer-review-sweep) skill exactly. Every reported
number must come from a command actually run (evidence is exogenous).

**Accepted arguments** (`$ARGUMENTS`, free-form — the mode is inferred):
- **empty** / "triage the repo" / "what's ready" / "what should I clear" → **sweep mode**: ranks open
  issues/PRs by cost-to-advance, presents the buckets, and **awaits your pick** before any per-PR
  re-review.
- a **PR number** (`#N`) or a description of one PR → **re-review** that PR (resolves the number from
  the open list first; asks if the description matches more than one).
- an explicit merge authorization — `merge=#N`, or prose like "clear and merge it" → treated as the
  merge token **for that one resolved PR only**. Merges **only** if the re-review verdict is a plain,
  evidence-backed CLEAR and no other maintainer has an unresolved change-request.

**Examples:**
```text
/gsd-review-sweep
/gsd-review-sweep re-review #1532
/gsd-review-sweep clear #1532 merge=#1532
/gsd-review-sweep is the roadmap-rollback PR ready to merge?
```

**Notes:** ball-in-court anchors to the latest `CHANGES_REQUESTED`; "green" is read from real
check-runs on the head SHA, not the ruleset. `allowed-tools: Skill, Bash, Read, Grep, Glob, AskUserQuestion`.

### `/gsd-triage-assist`

**Synopsis:** `/gsd-triage-assist #N | <issue number/title/body> | … --apply (only on explicit authorization)`

Advisory **first-triage** of an incoming issue: runs LIVE `issue-dedupe` + `issue-version-gate`,
suggests a canonical triage role read **only** from LIVE `docs/agents/triage-labels.md`, and surfaces
the `needs-triage` strip command for you to confirm. Complements — does not replace — the re-review
sweep. Doer: `node bin/triage-assist.cjs` (run from inside the gsd-core checkout). **No GitHub mutation
by default.**

**Accepted arguments** (`$ARGUMENTS`):
- a bare issue number / "triage #N" / a pasted issue body → **surface mode** (no `--apply`): presents
  the dedupe signal, version-gate finding, suggested role, and the exact remediation commands, then
  stops for your confirm.
- explicit apply authorization — e.g. "apply the role and strip needs-triage on #N", "confirm and
  label it" → runs the doer with **`--apply`** for that **one resolved issue only**. If the
  authorization can't be pinned to exactly one issue, it asks which before any `--apply`.

**Examples:**
```text
/gsd-triage-assist #1601
/gsd-triage-assist triage this: "crash on empty CONTEXT.md" …
/gsd-triage-assist apply the role and strip needs-triage on #1601
```

**Notes:** advisory only — no allow/deny verdict, not a PreToolUse gate. A LIVE script that can't load
fails LOUD (never a clean/no-duplicate result). `allowed-tools: Skill, Bash, Read, Grep, Glob, AskUserQuestion`.

### `/gsd-release-preflight`

**Synopsis:** `/gsd-release-preflight` *(no args needed)*

One-command, **advisory, read-only** release pre-flight: runs the four LIVE gsd-core release scripts in
their non-mutating capacity (`check-npm-integrity` read-only, `release-tarball-smoke` dry-run,
`sync-manifest-versions --check`, `sync-next-version`'s release-version predicate), aggregates **every**
failure (no fail-fast), and exits nonzero if any blocker exists. Doer:
`node bin/release-preflight.cjs`.

**Accepted arguments:** none.

**How to run** (the doer needs a gsd-core sentinel cwd):
```bash
cd ~/repos/gsd-core && node ~/repos/gsd-contrib-toolkit/bin/release-preflight.cjs
```

**Notes:** never mutates the tree or GitHub. Any single `[FAIL]` (integrity/manifest/version drift, a
smoke failure, or a LOUD missing-LIVE-script error) blocks the release. `allowed-tools: Bash, Read`.

### `/gsd-ruleset-drift`

**Synopsis:** `/gsd-ruleset-drift (empty = read-only drift report) | --apply`

Advisory ruleset-governance drift report: compares **declared** `.github/rulesets/*.json` against the
**live** `gh api repos/<repo>/rulesets` state and surfaces drift in `enforcement`, presence, or the
`rules` set. Doer: `node bin/ruleset-drift.cjs`.

**Accepted arguments:**
- **empty** (default) → **read-only** report: prints the declared-vs-live diff plus the exact LIVE
  remediation commands. Never mutates.
- **`--apply`** → runs the LIVE remediation (`scripts/sync-rulesets.sh` +
  `scripts/setup-branch-protection.sh`). **Only on explicit maintainer authorization** — never the
  default.

**How to run:**
```bash
cd ~/repos/gsd-core && node ~/repos/gsd-contrib-toolkit/bin/ruleset-drift.cjs           # report
cd ~/repos/gsd-core && node ~/repos/gsd-contrib-toolkit/bin/ruleset-drift.cjs --apply   # remediate
```

**Notes:** a failed declared/live read is a LOUD error (never a false "no drift"). `allowed-tools: Bash, Read`.

---

## Recovery offramp

When a contribution gate **denies** (or a skill surfaces a real blocking issue mid-run), `/gsd-submit`
and `/gsd-review-sweep` offer a GSD-native recovery rather than a dead stop: **`/gsd-quick`** for a
trivial inline fix, or **`/gsd-debug`** (or `/gsd-discuss-phase`→`/gsd-plan-phase`→`/gsd-execute-phase`)
for a tracked, resumable one. The offramp is **advisory only** — the deny stays fail-closed and it never
bypasses the gate or abuses `GSD_CONTRIB_OVERRIDE`.

## See also

- [skills-reference.md](skills-reference.md) — the two skills the commands drive.
- [reuse-and-methodology.md](reuse-and-methodology.md) — the reuse map governing what each path delegates to.
