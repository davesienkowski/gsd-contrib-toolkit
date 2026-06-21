# gsd-core-contribution — reference (commands, gates, templates)

**See also:** the reuse + methodology decisions governing this pipeline live in [docs/REUSE-AND-METHODOLOGY.md](../../docs/REUSE-AND-METHODOLOGY.md) (reuse map, `skills-from-the-artificer` + `trust-but-verify` pre-file review, Pocock `tdd` authoring).

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

Labels at `gh issue create`: `bug,confirmed-bug,area: <X>,priority: <low|medium|high>` (+ `security` if applicable). Then:
```bash
gh issue create --repo open-gsd/gsd-core --title "<type>(<area>): <imperative>" --body-file BODY.md \
  --label "bug,confirmed-bug,area: core,priority: medium"
gh api -X DELETE "repos/open-gsd/gsd-core/issues/<#>/labels/needs-triage"   # bot auto-adds it
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

```bash
gh pr create --repo open-gsd/gsd-core --base next --head fix/<issue#>-<slug> \
  --title "<type>(<area>): <imperative>" --body-file PR.md \
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
Children: `<type>(<area>): <scoped task> (epic #<N>)`. File children incrementally as worked.

## Submission gotchas (verified live)

- `gh issue edit` / `gh pr edit` GraphQL is **broken** on open-gsd → use `gh api -X PATCH …/{issues,pulls}/<#> -f body="$(cat BODY.md)"` and `gh api -X DELETE …/labels/<l>`.
- `version-exempt` label **does not exist** — a valid `### GSD Version` is the only bypass.
- `lint:ci` runs `lint-allow-test-rule-refs` → any new `// allow-test-rule: <reason>` MUST carry `see #NNN` (ADR-456).
- A **changeset-only commit can skip the Tests workflow** → the head shows green meta-checks while a prior commit's Tests FAILED. Always read check-runs on the head SHA and confirm Tests ran there.
- Reproduce `lint:ci` in a **clean worktree** — a stray untracked `gsd-core/bin/lib/*.cjs` in the main checkout poisons `eslint .`.
- Don't chase `mergeStateStatus: BEHIND` — the maintainer clears it on merge; re-pushing can re-dismiss an approval.
