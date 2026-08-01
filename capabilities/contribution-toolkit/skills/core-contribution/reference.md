# core-contribution — reference (commands, gates, templates)

**See also:** the reuse + methodology decisions governing this pipeline live in [docs/REUSE-AND-METHODOLOGY.md](../../docs/REUSE-AND-METHODOLOGY.md) (reuse map, `skills-from-the-artificer` + `trust-but-verify` pre-file review, Pocock `tdd` authoring).

## Named model-driven companions (referenced, NOT vendored)

These are the named skills/companions the pipeline drives by name — like `skills-from-the-artificer` and `trust-but-verify` (law-lens + quoted-source review) and Pocock's `tdd` (RED-before-GREEN authoring), each is referenced, never vendored:

- **`ci-preflight`** — the model-driven companion to the **lint:ci-before-push** gate (ALIGN-04). Invoke it **before** `git push` / `gh pr create`: it drives `bin/lint-ci-stamp.cjs` (04-01) to run `npm run lint:ci` and, **only on green**, stamp a tree-SHA marker. The PreToolUse `lint-ci-marker` gate (04-02) then READS that marker and the `scan-gate` (04-03) runs the secret/injection/base64 scans — a red lint, a dirty/changed tree, or a scan hit **DENIES** the push. `ci-preflight` is the human-loop partner that gives the model a guided path to GREEN *before* it hits those hard gates (honesty: the gates lock the outcome, `ci-preflight` is the model-driven step toward it).

### The Phase-4 stamp → marker → gate → scan loop (ALIGN-04)

```
ci-preflight                         # model-driven companion (this loop's driver)
  └─ bin/lint-ci-stamp.cjs           # 04-01: runs `npm run lint:ci`; on GREEN, stamps the tree-SHA marker
                                     #        (ENF-05 lint:ci-before-push)
git push / gh pr create
  ├─ hooks/lint-ci-marker.cjs        # 04-02: READS the marker — DENY if absent / stale / tree changed
  └─ hooks/scan-gate.cjs             # 04-03: runs LIVE secret-scan.sh / prompt-injection-scan.sh /
                                     #        base64-scan.sh — DENY on any hit (ENF-09)
```

Registration-surface awareness: during preflight, `hooks/preflight-shipped-paths.cjs` (an **advisory** companion, NOT a blocking gate) calls the LIVE `scripts/diff-touches-shipped-paths.cjs` to surface whether the working diff touches **shipped** paths (package.json + the package `files` whitelist + CI-gating `tests/*`). If it does, run the `ci-preflight` + `lint-ci-stamp` loop before pushing. It reimplements no ship-prefix logic and fails LOUD if the LIVE script is missing.

All commands assume `--repo open-gsd/gsd-core` (the clone has multiple remotes). Base branch is always **`next`**.

## Gate scripts (validate locally BEFORE filing/pushing)

```bash
# version-gate (issue) — body must contain a `### GSD Version` line with a semver/SHA token.
node -e 'const fs=require("fs");const g=require("./scripts/issue-version-gate.cjs");
  console.log(JSON.stringify(g.evaluateVersionGate({labels:[{name:"bug"},{name:"confirmed-bug"}],
  body:fs.readFileSync("BODY.md","utf8")})));'
# PASS: {"action":"skip","reason":"valid-version"}

# pr-template-policy (PR) — body must use the typed template with every required heading.
PR_BODY="$(cat PR.md)" AUTHOR_ASSOCIATION="MEMBER" CHANGED_FILES="src/foo.cts
tests/foo.test.cjs" node scripts/pr-template-policy.cjs
# PASS: {"valid":true,"action":"pass","template":"fix",...}

# full lint (NOT just eslint) — run on the branch after build:lib
npm run lint:ci   # composes eslint + ~9 project linters; must exit 0
```

`### GSD Version` value for engine-internal findings: **`1.6.0-rc.1 (next @ <8-char-sha>)`** (sha = current `origin/next`).

## Issue types (all six) (KNOW-04)

The repo ships **six** issue templates, not three — route a contribution to the one that fits so a `chore`/`docs_issue`/`config` change isn't force-fit into the bug/enhancement/feature shape. (Source for the set: the project gap-analysis `C5`, `.planning/notes/gap-analysis-2026-06-21.md` — templates exist for `bug_report, enhancement, feature_request, chore, docs_issue, config`.)

| # | Issue type (template) | Use for | Typical labels |
|---|---|---|---|
| 1 | **bug_report** | a defect / wrong behavior with a reproduced mechanism | `bug` → `confirmed-bug` + `area: X` + `priority: X` (+ `security`) |
| 2 | **enhancement** | improving an existing capability (also the **epic** umbrella shape) | `enhancement` → `approved-enhancement` + `area: X` |
| 3 | **feature_request** | a net-new capability | `feature` → `approved-feature` + `area: X` |
| 4 | **chore** | maintenance / tooling / deps / build / non-behavioral upkeep | `chore` + `area: X` |
| 5 | **docs_issue** | documentation defect or gap (not code behavior) | `documentation` + `area: X` |
| 6 | **config** | configuration / schema / settings surface change | `chore`/`config` + `area: X` (mirror the touched config area) |

Pick the template by the *nature of the change*, then apply that row's labels. A `chore` or `docs_issue` filed under `bug_report` trips the wrong intake gate (e.g. version-gate expectations / `confirmed-bug` fix-gate) — match the template to the work.

## Security routing (KNOW-03)

**WARN — route a real vulnerability to the PRIVATE advisory, not a public issue.** A **real / exploitable** vulnerability is reported via the repo's **private GitHub security advisory** at **`/security/advisories/new`** (per `SECURITY.md`) — **NOT** a public `gh issue create`. Filing a live, exploitable vector as a public issue discloses it before a fix exists.

The existing **public** path stays for the rest: a security finding that is **already public / precedented / non-exploitable** is filed as a public `security` + `confirmed-bug` issue (precedents #751 / #1406 / #116). Don't over-privatize an already-public finding either — the split is:

| Finding | Route |
|---|---|
| real / exploitable vulnerability (a live injection/escape vector) | **PRIVATE advisory `/security/advisories/new`** (per `SECURITY.md`) — never a public issue |
| non-exploitable / already-public / precedented security finding | public `security` + `confirmed-bug` issue (precedents #751 / #1406 / #116) |

When in doubt about exploitability, treat it as real and use the private advisory first — you can always downgrade to the public path, you cannot un-disclose.

## ADR / CONTEXT awareness (POLICY-03)

Run this **before authoring** to surface the governing decisions touching the changed area. The output is a **LIST of governing decisions surfaced for review (awareness)** — it is **not** a pass/fail gate, and a listed `CONTEXT.md` predicate is awareness, **not** deterministic enforcement (the mechanizable floor is POLICY-02, Phase 3).

```bash
# 1) Governing ADRs for the changed area — grep docs/adr/ for the area's keywords / IDs.
#    <AREA-KEYWORDS> = the file/function/feature words your diff touches (e.g. 'bin/lib|generated|build:lib').
grep -rniE '<AREA-KEYWORDS>' docs/adr/        # list every ADR that fires; note its ID + the clause line

# 2) Relevant CONTEXT.md predicates for the touched area — grep/gsd-tools over CONTEXT.md.
grep -niE '<AREA-KEYWORDS>' CONTEXT.md        # the greppable domain predicates for the area
gsd-tools query <predicate-query> 2>/dev/null # gsd-tools is the CLI fallback's structured form; grep is always-available

# 3) Write the LIST: governing ADRs/policies (by ID) + the relevant CONTEXT.md predicates.
#    This list feeds the Policy-conformance step (POLICY-01) below — it does NOT pass/fail anything by itself.
```

## MemPalace recall + capture (advisory)

Cross-session memory — the only surface here that remembers *previous sessions* (memtrace and graphify index code, not sessions). Recall at **P0c** (inside Phase 0, beside the POLICY-03 awareness sweep), capture at **Phase 7**.

> **Optional dependency.** MemPalace is a separate third-party tool, not shipped or required by this toolkit. If `mempalace` is not on `PATH`, skip P0c and P7 — no gate consults them, no test requires them, and nothing downstream breaks. Everything below assumes you have chosen to install it.

**Recall.** Always the CLI form — it works inside a subagent, where the main session's tool-call transport does not exist:

```bash
mempalace search "<area/#n> <symptom>" --results 5
```

Search **un-scoped**. One project scatters across up to three wings (`<project>`, `sessions`, `wing_<project>`) and the hook-captured *conversation history* lands in `sessions`, so passing `--wing gsd_core` silently drops it — **a wing-scoped miss is not evidence the memory is absent** (verified live 2026-07-31). **The lock:** a concurrent `mine` fails every other op with `palace ... is held by PID N` — retry once, then skip; it never blocks a contribution.

**Capture.** The staging directory lives **outside every repo**, and that is load-bearing rather than cosmetic: `mine` respects `.gitignore` by default and `mempalace sync` prunes drawers whose source file is gitignored, deleted, or moved — and gsd-core's `.planning/` **is** gitignored. A note staged inside a checkout is either skipped now or pruned later. **Leave the note in place after mining**, for the same reason.

```bash
STAGE="$HOME/.gsd-contrib-memory"
mkdir -p "$STAGE/problems"
# one-time: without a rooms: list, every note lands in `general` (mine has no --room flag)
[ -f "$STAGE/mempalace.yaml" ] || cat > "$STAGE/mempalace.yaml" <<'YAML'
rooms:
  - name: problems
  - name: decisions
  - name: technical
YAML
# write a REAL note (see the length gotcha below), then:
mempalace mine "$STAGE" --wing gsd_core --dry-run
mempalace mine "$STAGE" --wing gsd_core
```

**Room mapping:** falsified premise / gate rejection → `problems`; sweep verdict and what the exogenous pass caught → `decisions`.

**Three gotchas, each measured live 2026-07-31:**

1. **A short note is SILENTLY skipped.** A 3-line note dry-ran as `Files processed: 0 / Files skipped (read error or too short): 1 / Drawers filed: 0` — a no-op that exits clean. Write a real note (~15+ lines of prose: what was claimed, what actually happened, the verdict, the reusable lesson) and **always `--dry-run` first**; the pass condition is `Files processed: 1` with a non-zero `Drawers filed`.
2. **`mine` has no `--room` flag** — only `search` takes one. Rooms are detected from folder-path segments matched against the `rooms:` list in the stage's `mempalace.yaml`; with no such file, everything lands in `general`.
3. **Re-mining the whole stage is safe.** `mine` keys on the source path, so unchanged notes deduplicate instead of filing duplicate drawers — which is *why* the stage path must stay stable.

**Honest scope:** this whole section is **advisory and model-driven**. It adds no hook, no receipt, and no gate. Per CTK-ADR-0001 §Decision.1 a hook can verify at most that a command *ran*, never that its output was read or used — and gating on a recall would fail-closed against the palace lock, making gsd-core un-fileable for an entirely unrelated reason.

## Policy conformance (POLICY-01)

Run this **pre-file**, after the awareness sweep, on the proposed **diff**. The two skills that run it are **`trust-but-verify`** (open+quote discipline) and **`skills-from-the-artificer`** (law-lenses). Check the diff against the relevant ADRs (from the awareness list) + the `docs/agents/*` contribution norms.

```bash
# For EACH ADR the awareness sweep flagged: open it and QUOTE the governing clause —
# a report / summary / awareness-list entry is a LEAD, not a fact (trust-but-verify).
sed -n '1,200p' docs/adr/<ADR-ID>-*.md     # open the actual ADR; copy the governing clause verbatim
git diff --staged                          # the proposed diff under review (or the working diff pre-stage)
```

For each flagged ADR, record:

```
- ADR-<ID> — quoted clause: "<verbatim governing text from the ADR>"
  diff-vs-clause: conforms | CONFLICTS (LOCKED) — <why, citing the quote>
```

Then apply the firing `skills-from-the-artificer` law-lenses to the diff (Hyrum's Law, etc.) and also check the diff against the `docs/agents/*` contribution norms. **Surface any LOCKED-decision conflict before filing.** Honest scope: this is a rigorous *quoted-source* review (model-driven), not a deterministic guarantee for arbitrary ADRs — the mechanizable gate-enforced subset is POLICY-02 (Phase 3).

## Intake reality (verified)

> **Grounding:** every intake claim in this section is verified against the live `open-gsd/gsd-core` repo (`path:line` citations). The repo moves — **re-verify before trusting.** Last verified: 2026-07-02 against `origin/next`. This is the actual upstream intake reality every contribution must satisfy *by construction*; the reuse/methodology decisions it serves are the canonical ALIGN record (linked at the top of this file). Its verified-intake content was folded here (SYNC-01) so the intake facts travel WITH the skill to every runtime.

The gates below are what a submission is measured against upstream. The pipeline's job is to pre-satisfy each one **locally, before the push** — correct by construction, not by retry (see the *Local gate ⇒ CI gate* table at the end of this section).

### Issue-first — no code before approval
`CONTRIBUTING.md:111-119` — *"## The Issue-First Rule — No Exceptions … No code before approval."*
- **Fix:** open issue → maintainer applies **`confirmed-bug`** → then fix. `confirmed-bug` is the fix gate (`docs/agents/triage-labels.md:9,18`: *"the gate the fix workflow requires before any code is written"*).
- **Enhancement:** a maintainer must label the issue **`approved-enhancement`** before you write a single line of code (`CONTRIBUTING.md:62`).
- **Feature:** same with **`approved-feature`**; *"Incomplete specs are closed, not revised by maintainers."* (`CONTRIBUTING.md:74`).
- **PR without an approved linked issue is auto-closed:** *"PRs without a linked issue are closed without review, no exceptions."* (`CONTRIBUTING.md:182`); link with a closing keyword (`Closes/Fixes/Resolves #N`, `:186`); **no draft PRs** (`:184`).

(Route through the correct one of the six templates — see *Issue types (all six) (KNOW-04)* above; a `chore`/`docs_issue`/`config` change force-fit into `bug_report` trips the wrong gate.)

### Triage automation — the label lifecycle (and why you NEVER strip an auto-tag)
The label lifecycle is driven by GitHub Actions, not by CONTRIBUTING.md prose:

| Automation (`.github/workflows/`) | Trigger | Effect |
|---|---|---|
| `auto-label-issues.yml` | issue opened | **adds `needs-triage` to EVERY new issue, unconditionally** (`:20-25`, verified) |
| issue templates | on create | `bug_report`→`bug,needs-triage`; `chore`→`type: chore,needs-triage`; `enhancement`→`enhancement,needs-review`; `feature_request`→`feature-request,needs-review`; `docs_issue`→`documentation` |
| `duplicate-check.yml` | issue opened | scores vs open issues (`scripts/issue-dedupe.cjs`); may add `possible-duplicate` + a 24h challenge comment |
| `duplicate-sweep.yml` | daily 07:00 | auto-closes `possible-duplicate` as `duplicate` unless a human reply / 👎 vetoes |
| `remove-duplicate-label.yml` | issue comment | a reply clears `possible-duplicate` → adds `needs-maintainer-review` |
| `version-gate.yml` | issue opened | `scripts/issue-version-gate.cjs`; missing/invalid `### GSD Version` → adds `needs-version`, closes `not_planned` (the only bypass is a valid version — `version-exempt` does **not** exist, see *Submission gotchas* below) |
| `auto-branch.yml` | issue labeled | creates a branch when label ∈ `bug, enhancement, priority: critical, type: chore, area: docs` |
| `stale.yml` | weekly | 28d→stale, +14d→close; exempts `confirmed-bug`, `needs-reproduction`, `priority: critical`, `pinned`, … |

**The verified mechanism behind "never strip `needs-triage`":** **no in-repo automation reads `needs-triage`.** `auto-label-issues.yml` *adds* it; `triage-labels.md:21` says it *"is removed when any other state label is applied."* trek-e's *surfacing* queue — the saved filter / GitHub Projects board he triages from — keys on `label:needs-triage` and lives **outside the repo**. So stripping it drops the issue off his board with **zero CI signal** that anything broke. Apply your `confirmed-bug`/`approved-*`/`area:`/`priority:` labels **alongside** the auto-tags; enhancement/feature issues carry both `needs-review` and `needs-triage` — leave both. (The operational "never remove it" directive is in *Submission gotchas* below and the SKILL Gotchas table; this is the mechanism that makes it load-bearing.)

### PR-governance gates (all enforcing unless noted)
| Workflow | Enforces |
|---|---|
| `require-issue-link.yml` | PR body must contain `(closes\|fixes\|resolves) #N` or `setFailed` (`:85`) |
| `pr-title-validator.yml` | title `type(#issue): summary`; matcher loaded from the **base** branch so a PR can't edit its own ruler (`:60-64`); enforcing |
| `pr-template-format.yml` | `scripts/pr-template-policy.cjs`; **warns** trusted contributors, **fails+comments** untrusted (`action=='close'`) |
| `auto-close-unsolicited-prs.yml` | closes external PRs whose linked issue lacks `approved-feature,approved-enhancement,confirmed-bug` (`:50`); fails **open** on API error |
| `close-draft-prs.yml` / `-sweep.yml` | closes non-maintainer draft PRs (per-PR + 6-hourly sweep) |
| `pr-target-validator.yml` | branch model; **skips maintainers** (OWNER/MEMBER/COLLABORATOR) |
| `branch-naming.yml` | valid prefix (`feat/ fix/ hotfix/ docs/ chore/ …`); **warn-only**, non-blocking |
| `dismiss-unauthorized-pr-approvals.yml` | dismisses approvals from non-collaborators / a blocklist |

(The three typed PR templates + the `pr-template-policy.cjs` required headings are captured as skeletons in *Fix PR body skeleton* below; escape hatch `<!-- pr-template-exempt: <reason> -->`.)

### Changeset & docs gates
- `changeset-required.yml` (`scripts/changeset/lint.cjs`): a PR touching `bin/ gsd-core/ agents/ commands/ hooks/ sdk/src/` **without** a `.changeset/*.md` fragment fails. Opt-out: `no-changelog` label (`CONTRIBUTING.md:206-208`).
- `docs-required.yml` (`scripts/lint-docs-required.cjs`): a changeset typed `Added/Changed/Deprecated/Removed` **without** a `docs/` change fails. Opt-out: `no-docs` label or `<!-- docs-exempt: <reason> -->` (`:260,287`). `Fixed`/`Security` do **not** trip docs-lint.
- Changelog is built from **PR titles** — do not edit `CHANGELOG.md` directly (`:195`).

### CI test structure (the gates run as `node --test` suites inside `test.yml`)
`test.yml` (`name: Tests`) is the aggregate gate. Scope is computed by `scripts/ci-test-scope.cjs`, then:
- `lint-tests` → `npm run lint:ci` (ESLint + skill-deps + test-file-count + command-contract + PR-checks + legacy-name + regression-test-names + resolution-provenance + allow-test-rule-refs). **`lint:ci` ≠ `eslint .`.**
- `test` matrix: **ubuntu-22** (targeted), **ubuntu-24** (full + coverage gate ≥70% on `gsd-core/bin/lib` + scripts floor ≥55% + integration/security/install/slow), **windows-24** (windows scope).
- `test-full`: sharded parity — **windows-22 ×3, macos-22 ×3, macos-24 ×3** (`name: full test (<os>, <node>, shard N/3)`). Unit suite sharded `i/3`; integration+security on shard 1 only.
- `required-tests` — the branch-protection aggregate.

**Gates that live *inside* those test jobs (no standalone workflow):**
- **workflow/agent size budget** — `tests/workflow-size-budget.test.cjs` (XL_CAP; `CONTRIBUTING.md:882-890`; ADR-1610). Update via `npm run size:baseline`.
- **phase-6 capstone / loop-body ratchet** — `tests/phase6-capstone-conformance.test.cjs` (hardcoded `PRE_PHASE6` per-file byte ceilings; #1168/#1139). Runs in **shard 1/3** — a `plan-phase.md`/`execute-phase.md` growth over its frozen ceiling fails macOS/Windows shard-1/3 + ubuntu-24, *not* every shard.
- **golden install parity** — `npm run test:install` / `tests/golden-install-parity.test.cjs` (16 runtime fixtures; regen with `UPDATE_GOLDEN=1`), gated on `full_matrix`.
- **inventory manifest sync** — `tests/inventory-manifest-sync.test.cjs` (+ `docs/INVENTORY.md`).

Separate workflows: `security-scan.yml` (dependency integrity + prompt-injection/base64/secret scans + `.planning/`-not-committed check), `install-smoke.yml` (tarball install + mode-644 class), `mutation.yml` (Stryker per changed module; required check *"Stryker mutation score (changed files only)"*).

(Upstream testing norms — regression-test-first for a fix, no-source-grep, "CI green is not sufficient", generated `bin/lib`, the per-surface QA checklist — are in *QA matrix by surface (KNOW-01)* and *Test bar by contribution type (KNOW-02)* below plus the SKILL Gotchas; not re-pasted here.)

### RULESET.* tokens (verified against gsd-core 2026-07-05)
Trek-e's directives cite named `RULESET.*` tokens; the ones below are the ones **verified real against gsd-core** (source of the ✓/⚠/❌ verdicts: `.planning/notes/trek-e-directives-reconciliation-2026-07-05.md` — verified items only). They sharpen the classification + test-quality bar the toolkit's gates already partially enforce.

**Classification gates (require the approval label before code — the token form of *Issue-first* above):**
- `RULESET.CONTRIB.CLASSIFY.fix` — requires `confirmed-bug` before implementation
- `RULESET.CONTRIB.CLASSIFY.enhancement` — requires `approved-enhancement` before implementation
- `RULESET.CONTRIB.CLASSIFY.feature` — requires `approved-feature` before implementation
- `CI.GATE.issue-link-required` — a PR missing a linked issue → request-changes / HALT (`CONTRIBUTING.md:468`; the enforcing workflow is `require-issue-link.yml`, above)
- `META.RULE.canonical-source-precedence` — when sources disagree, precedence is `CONTRIBUTING.md > docs/adr/* > CONTEXT.md > agent memory` (`CONTRIBUTING.md:549`)

**Test-quality ruleset (`RULESET.TESTS.*` — what a "good test" means upstream):**
- `mutation-score` — Stryker incremental (`--since origin/next`), default **80% killed**; surviving mutants block merge (ADR-456 / `TESTING-STANDARDS.md:141`). Already covered by the toolkit's ENF-18 `mutation.yml` and the `mutation.yml` required check listed above.
- `boundary-coverage` — exercise inputs at N ∈ {limit-1, limit, limit+1}, not a trivial-fit/overflow pair.
- `no-timing-assertion` — no wall-clock elapsed assertions; use a clock-seam + `node:test` `mock.timers`.
- `property-based-testing` — parsing / transformation / budget-limit / bijective modules need ≥1 `fast-check` property test.
- `delete-bad-tests` — pass-always / vacuous-truth / source-grep / elapsed-time / real-race tests are **deleted and replaced in the same PR**, not left in place.
- `no-source-grep` — assert typed/structured values, never `readFileSync` a `.cjs` and substring-match on it. In gsd-core this is the ESLint rule **`local/no-source-grep`** (`eslint-rules/no-source-grep.cjs`, run by `eslint .` ⊂ `lint:ci`; ADR-452 retired the old homegrown `scripts/lint-*` scanners in favour of it) — the toolkit already phrases it as this ESLint rule in the *QA matrix by surface* parser row above and the *Submission gotchas* below.

The fix-type **regression-test-first** requirement (RED before the fix) is captured as prose in *Test bar by contribution type (KNOW-02)* below — it is not a distinct gsd-core `RULESET.TESTS.*` token, so it is cited there rather than minted as one here.

### Local gate ⇒ CI gate (pre-satisfy each upstream gate before the push)
| CI / triage gate (this section) | Skill step that pre-satisfies it locally |
|---|---|
| version-gate | P4b — run `issue-version-gate` on the exact body → `valid-version` |
| pr-template-policy | P5b — run `pr-template-policy.cjs` on the exact body → `valid:true` |
| require-issue-link / auto-close | P4/P5 — issue-first, `Fixes #N`, approval label present before PR |
| pr-title-validator | conventional `type(#issue):` title |
| changeset / docs | P5c — add `.changeset/` fragment; `Fixed`/`Security` skip docs-lint |
| lint:ci + scans (ALIGN-04) | P3d — `ci-preflight` → green + stamp before push |
| size-budget / phase-6 / golden / inventory | P3d — run the full relevant suites, not just the module's; regen goldens/baselines/INVENTORY when shipped paths move |
| **never strip `needs-triage`** | P4c — apply labels **alongside** auto-tags; never `DELETE` them |

**Do the gates locally, before the push — correct by construction, not by retry.**

## QA matrix by surface (KNOW-01)

The `CONTRIBUTING` QA matrix is not a single "is it tested?" box — it has a **distinct checklist per surface**. Identify which surface(s) your diff touches and satisfy the row(s). This is the concrete content the Phase-3 one-liner points to.

| Surface | What "covered" means — the per-surface checklist |
|---|---|
| **parser** | [ ] malformed / truncated / empty input cases · [ ] boundary & edge inputs (off-by-one, nesting depth, duplicate keys) · [ ] **assert on the typed/structured parse result, never a stdout/source substring** (`local/no-source-grep`) · [ ] round-trip / idempotent re-parse where applicable · [ ] error path returns a structured error, not a throw/exit |
| **FS-write** | [ ] **atomic** write (temp-then-rename, no partial file on crash) · [ ] **idempotent** re-run (second run is a no-op / byte-identical) · [ ] **path-escape** guard (no `..`/symlink/absolute-path escape outside the intended root) · [ ] permissions/mode preserved · [ ] no clobber of an existing file without the documented fail-safe |
| **CLI** | [ ] argv & **flag-ordering** variants (flag before/after positional, `=` vs space) · [ ] **exit codes** asserted (0 success / non-zero per failure class) · [ ] stdout vs stderr routing · [ ] `--help`/usage and unknown-flag handling · [ ] no interactive prompt in non-TTY |
| **security** | [ ] **injection / escaping** at the trust boundary (shell, SQL, path, template) · [ ] input validation rejects hostile input · [ ] **private-advisory routing** for a real vulnerability (see *Security routing (KNOW-03)* below — a real vuln is NOT a public issue) · [ ] no secret/PII in logs or error text · [ ] authZ/authN check on any new protected path |

Touch more than one surface → satisfy every row that fires. This checklist **supplements** the RED-before-GREEN `[GATE]` (Phase 3); it does not replace it.

## Test bar by contribution type (KNOW-02)

What "tested" *means* depends on the kind of change. Match the row for your contribution type — the bar is different for a fix vs an enhancement vs a feature.

| Type | The test requirement (what the bar IS for this type) |
|---|---|
| **fix** | A **regression test that FAILS before the fix and passes after** — RED-before-GREEN, the failing test pasted as evidence (Phase-3 `[GATE]`). It must reproduce the exact reported mechanism, so a revert of the fix re-reds it. One concern, one regression test. |
| **enhancement** | **Behavior tests for the new/changed capability** *plus* **no-regression on existing behavior** — the existing suite stays green and new tests assert the added behavior. Cover the QA-matrix surfaces the enhancement touches. Disclose any Hyrum's-Law behavior change (artificer pass) in the PR. |
| **feature** | **Full coverage of the new surface** — happy path + the firing QA-matrix-by-surface checks for every surface the feature introduces (parser/FS-write/CLI/security as applicable) + error/edge paths. A new feature owns its whole test surface, not just one happy-path test. |

All three sit **on top of** the RED-before-GREEN gate and `npm run lint:ci` — the per-type bar says *what to test*, the gate says *prove it ran red first / prove lint is green*.

## Worktree setup (per fix; fresh worktrees have no deps, and bin/lib is gitignored)

```bash
git fetch origin next --quiet
WT=~/repos/gsd-core-<issue#>-<slug>
git worktree add -b fix/<issue#>-<slug> "$WT" origin/next
cd "$WT"
git config core.hooksPath .githooks          # hooks are per-worktree
ln -s ~/repos/gsd-core/node_modules node_modules
npm run build:lib                            # regenerates gitignored bin/lib/*.cjs from src/*.cts
# ... TDD ...  then run the FULL relevant suites + `npm run lint:ci`
```

**Push target** — if you have push access (CODEOWNER/member: `gh api repos/open-gsd/gsd-core -q .permissions.push` → `true`), push the branch to **origin** and open a same-repo PR (`git push -u origin fix/<#>-<slug>` then `gh pr create --head fix/<#>-<slug>`). Only an external contributor without push access pushes to a fork and opens a cross-fork PR (`--head <user>:fix/<#>-<slug>`). Default to origin for maintainer work.

RED-before-GREEN when the fix is already written: `git stash push src/<file>.cts` → `build:lib` → run test (watch fail) → `git stash pop` → `build:lib` → run test (green).

## Issue body skeleton (bug_report, engine-internal)

```markdown
### GSD Version

1.6.0-rc.1 (next @ <sha>)

### Runtime

N/A — engine-internal (`src/<file>.cts`)

### Summary
<one paragraph: the defect, with file:function and the exact wrong behavior>

### Impact
<WHAT THE USER / AGENT / CI NOTICES — the observable symptom, not just the mechanism>

### Root cause
<why it exists; incomplete-fix gap? cite prior #issues>

### Steps to reproduce
```js
<minimal repro — a failing test or a node -e probe>
```

### Fix
<the change, in 1–3 sentences + the regression test you added>

### Notes
- Verified against live `src/<file>.cts`.
- Relates to #<umbrella>; precedents #<a>/#<b>. (Security: filed public per #751/#1406.)
```

Labels at `gh issue create`: `bug,confirmed-bug,area: <X>,priority: <low|medium|high>` (+ `security` if applicable) — applied **alongside** the bot's `needs-triage` auto-tag, which you must **NOT** remove:
```bash
gh issue create --repo open-gsd/gsd-core --title "<type>(<area>): <imperative>" --body-file BODY.md \
  --label "bug,confirmed-bug,area: core,priority: medium"
# DO NOT delete needs-triage (or any bot auto-tag). trek-e's triage process catches new issues
# by needs-triage; removing it drops the issue from his queue and he skips it (maintainer directive, 2026-07-02).
```

## Fix PR body skeleton (required headings — pr-template-policy enforces them)

```markdown
## Fix PR
## Linked Issue
Fixes #<issue#>
## What was broken
## What this fix does
## Root cause
## Testing
### How I verified the fix
### Regression test added?
- [x] Yes — added a test that would have caught this bug
### Platforms tested
### Runtimes tested
## Checklist
- [x] Issue linked above with `Fixes #NNN`
- [x] Linked issue has the `confirmed-bug` label
- [x] Fix is scoped to the reported bug
- [x] Regression test added
- [x] All existing tests pass (`npm test`)
- [x] `.changeset/` fragment added
## Breaking changes
<disclose any Hyrum's-Law behavior change from the artificer pass, else "None">
```

**PR title convention (ENFORCED at open time — `pr-title-validator.yml`, `WARN_ONLY:false`):** the title MUST be `<type>(#<issue#>): <imperative>` — the linked issue ref lives **inside the scope**, not the subject. The live matcher is `scripts/release-notes/conventional-title.cjs` (`evaluatePrTitle`): a leading tag (`[security] …`) fails `bad-prefix`; a scope without `#<n>` (e.g. `fix(core): …`) fails `missing-issue-ref`. Valid: `fix(#1542): roadmap rollback`, `feat(#39)!: drop legacy flag`, `enhance(#1549): add PR-title validator`. You MAY add an area after the ref: `fix(#1542, core): …`. (Issue titles are NOT title-gated — the `<type>(<area>)` form above is fine for `gh issue create`; only PR titles are checked, because the changelog is built from them.)

```bash
gh pr create --repo open-gsd/gsd-core --base next --head fix/<issue#>-<slug> \
  --title "<type>(#<issue#>): <imperative>" --body-file PR.md \
  --label "area: <X>"          # + "security" / "runtime: <X>" as applicable; "no-changelog" only if no changeset
# If labels didn't take (GraphQL flakiness), apply via REST — a PR IS an issue in the REST API:
gh api -X POST repos/open-gsd/gsd-core/issues/<PR#>/labels -f "labels[]=area: <X>"
# changeset references the PR number → add AFTER the PR exists, then push:
npm run changeset -- --type Fixed --pr <PR#> --body "<user-facing one-liner>"
git add .changeset/ && git commit -q -m "chore(changeset): Fixed fragment for #<PR#> (<slug>)" && git push
```

**PR labels (author-applied; the repo has NO auto-labeler):** `area: <X>` (always, mirror the issue) + `security`/`runtime: <X>` if applicable. Use `no-changelog` only when there is no changeset. Do NOT put `bug`/`confirmed-bug`/`priority:` on the PR (issue-only) or `review:`/`needs rebase` (maintainer/bot). `Fixed`/`Security` changesets do NOT trigger docs-lint.

## Cross-link map (reuse existing umbrellas; file ZERO new where one fits)

| Umbrella (open) | Absorbs | Precedents to cite |
|---|---|---|
| **#1216** config audit | config-merge / schema / key bugs | #751, #1406, #663 (proto-pollution) |
| **#1372** sectionizer (CLOSED, incomplete) | frontmatter/roadmap/verify/conversion parsing | — |
| **#1411** resolution provenance (CLOSED) | silent fall-open / verifier false-PASS | — |
| **#1154** honest verifier (OPEN) | verify-gate false-PASS family | — |
| **#1244** capability ecosystem (OPEN) | capability trust/consent/loader | — |

## Epic variant (trek-e format)

Enhancement template; labels `enhancement, approved-enhancement, area: <X>`; title `epic(<area>): <imperative> — <ADR / finish-the-rollout>`. Body:

```markdown
> Drafted with AI assistance during a review; approved and authored by the maintainer.
> An approved epic does NOT approve its children — each child is its own issue + own
> confirmed-bug / approved-enhancement before code.

## Epic: <name>
### Problem   — the recurring class, hard numbers + prior-issue/PR citations
### Goal      — end state, "Done when:" checklist
### Non-goals
<table: finding → file:line → severity → child issue>
```
Children: each is its own issue + PR. The child **PR title** follows the same enforced form — `<type>(#<child-issue#>): <scoped task>` (the child's OWN issue ref in the scope; do NOT put `(epic #<N>)` in the title subject — it fails `missing-issue-ref`). Reference the epic in the PR **body** instead (`Part of epic #<N>` / `Fixes #<child-issue#>`). File children incrementally as worked.

## Submission gotchas (verified live)

- `gh issue edit` / `gh pr edit` GraphQL is **broken** on open-gsd → use `gh api -X PATCH …/{issues,pulls}/<#> -f body="$(cat BODY.md)"` and `gh api -X DELETE …/labels/<l>` (for labels you legitimately change — NOT for auto-tags; see next).
- **NEVER remove `needs-triage` / bot auto-tags** (maintainer directive, trek-e 2026-07-02: *"don't remove auto-tags if you want me to catch it… when you remove the needs-triage, my process breaks and I skip it"*). His triage *catches* new issues by `needs-triage`; stripping it drops the issue from his queue. Apply your labels alongside the auto-tags; leave the auto-tags in place.
- `version-exempt` label **does not exist** — a valid `### GSD Version` is the only bypass.
- `lint:ci` runs `lint-allow-test-rule-refs` → any new `// allow-test-rule: <reason>` MUST carry `see #NNN` (ADR-456).
- A **changeset-only commit can skip the Tests workflow** → the head shows green meta-checks while a prior commit's Tests FAILED. Always read check-runs on the head SHA and confirm Tests ran there.
- Reproduce `lint:ci` in a **clean worktree** — a stray untracked `gsd-core/bin/lib/*.cjs` in the main checkout poisons `eslint .`.
- Don't chase `mergeStateStatus: BEHIND` — the maintainer clears it on merge; re-pushing can re-dismiss an approval.
