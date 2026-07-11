# Triage-Assist Procedure (initial triage of an incoming issue)

An **advisory** first-triage pass for one incoming `open-gsd/gsd-core` issue. Invoked directly (`/gsd-triage-assist #N`) or as a complement to the sweep when a freshly-opened issue still carries `needs-triage`. It **complements, does not replace** the re-review sweep: the sweep ranks/clears open work; this assist gives a fast, LIVE-script-backed first call on a single new issue.

**Scope (two parts, in order).** First, the **advisory surface pass** (Steps 1–6 below) — the LIVE-script-backed dedupe/version/role signal, which mutates nothing. Then, once you're advancing the issue, the **issue-advancement artifacts** that mirror trek-e: the bug-vs-by-design gate, the Agent Brief, the enhancement/feature approval, and the capability-candidate routing. Those artifacts are the *shapes you post* — the issue **state machine** itself still lives in `/triage` (this file documents the format and the ordering; it does not re-implement `/triage`'s transitions).

**Doer:** `node bin/triage-assist.cjs` — run from inside the gsd-core checkout so the `hooks/lib` resolver finds the LIVE scripts. It is advisory (no allow/deny verdict, not a PreToolUse gate) and **mutates nothing without `--apply`**.

**Verdict standard:** every signal you report — the duplicate match, the version-gate finding, the suggested role — must come from a LIVE gsd-core script the assist actually invoked. If a LIVE script can't be loaded the assist returns an explicit `error`; report that LOUD, never a clean/no-duplicate/role-suggested result (HARD-02). The suggested role is read ONLY from LIVE `docs/agents/triage-labels.md` — there is **no toolkit-side heuristic role logic** (decision D-07).

## Inputs

| Input | Notes |
|---|---|
| issue `number` | the incoming issue to triage (NOT a PR number) |
| issue `title` | scored against open issues by LIVE `scoreCandidates` |
| issue `body` | passed to LIVE `evaluateVersionGate` (bug-report version check) |
| issue `labels` | passed to LIVE `evaluateVersionGate` (label authority) |
| `--apply` | OFF by default; only on explicit maintainer authorization (D-05) |

## Steps (in order)

1. **Gather the issue + the candidate set.** Fetch the incoming issue (`number`, `title`, `body`, `labels`) and the open-issue candidate list (`gh issue list --repo open-gsd/gsd-core --state open --json number,title`). The assist fetches the candidate list itself via no-shell `gh`; you only need the target issue's fields to hand it. Re-fetch live state — never triage a stale snapshot.
2. **Run the assist (surface mode).** `node bin/triage-assist.cjs` (no `--apply`). It invokes LIVE `scripts/issue-dedupe.cjs` (`scoreCandidates`) for the duplicate signal, LIVE `scripts/issue-version-gate.cjs` (`evaluateVersionGate`) for the bug-report version finding, and reads the canonical roles from LIVE `docs/agents/triage-labels.md`. **If it returns an `error`, STOP** — a missing/unloadable LIVE script means you cannot give a verdict; surface the error, never a guessed clean/role result.
3. **State the suggested role with the LIVE source named.** Report the suggested canonical role and name `docs/agents/triage-labels.md` as its **sole** source (D-07). The role is one of the LIVE table's canonical roles — never a value you computed. If the assist surfaced no role (it fails LOUD instead), do not invent one.
4. **Surface the dedupe signal + version-gate finding as evidence.** If a candidate scored at/above the LIVE threshold (0.6), state the matched `#number(s)` + similarity % from the assist's output (the LIVE `possible-duplicate` lifecycle then applies — don't hand-edit that bot-managed label). If the version-gate returned `close`, state the reason (`missing-version` / `invalid-version`).
5. **Present the remediation as a confirm step — NEVER auto-applied.** Show the exact `gh` label-apply + `needs-triage` strip commands the assist printed (`needs-triage` is removed when any state label is applied — per the LIVE table). Present them for the maintainer to confirm and run; **do not** apply them as a side effect of triaging (decision D-04).
6. **Stop / await human authorization before any `--apply` mutation.** Only re-run with `--apply` when the maintainer **explicitly** authorizes applying the role + stripping `needs-triage` for that one issue (D-05). A bare "triage #N" is NOT authorization to mutate. If you cannot pin the authorization to exactly one issue, ask which before any `--apply`.

## Settle bug-vs-by-design against the design record (BEFORE you confirm)

The advisory pass surfaces a *role*; before you commit to `confirmed-bug`, settle whether the reported behavior is a **defect at all** — trek-e resolves "is this a bug or working-as-designed?" against the **design record**, not intuition (#2045). Grep `docs/prd/`, `docs/adr/`, and `docs/explanation/` for the touched capability/feature; **open and QUOTE** the governing clause (a summary is a lead, not a fact — `trust-but-verify`). Three outcomes, and the ordering matters — this gate precedes the Agent Brief:

- **Intended AND implemented** → **by-design**: `wontfix` (or a docs clarification), *not* `confirmed-bug`. Cite the clause that documents the behavior.
- **Intended but NOT fully implemented** → it IS a `confirmed-bug` — an *implementation gap*, not a limitation. This is the common trap: a real bug looks like a by-design limit until the design record proves the intent. (#2045: PRD-1244 FR7 (`docs/prd/1244-capability-ecosystem.md:69`) intends third-party↔first-party surface parity; the impl "didn't finish threading the overlay" → three confirmed defects, not a documented limit.)
- **No design record either way** → genuine gray area: route to `/grilling` + `/domain-modeling` for a design decision before confirming — never a silent maintainer guess.

Only once the design record settles it's a real defect do you emit the **Agent Brief** below. If it's a feature/enhancement ask rather than a bug, use the **approval-conditions** format further down instead.

## Agent Brief — the `ready-for-agent` handoff (mirror trek-e)

The advisory pass above *surfaces* a role; **confirming** a bug is a separate, heavier act. When triage reproduces a bug and you move it to **`confirmed-bug` + `ready-for-agent`**, trek-e no longer just relabels — he posts a structured **Agent Brief** an AFK executor can implement directly (verified verbatim #2070; the diagnosis-first variant #2118). The brief IS the expensive artifact the `ready-for-agent` label gates dispatch on; a bare label with no brief strands the issue. Post it as a triage comment (with the AI disclaimer), then relabel.

**Format (fixed sections, trek-e's shape):**

```
> *This was generated by AI during triage.*

## Agent Brief — confirmed-bug        [or: ## Triage Diagnosis — CONFIRMED]
**Verified & reproduced on `next`.** <one-line what-and-where>

### Reproduction (empirical, current `next`)
<the ACTUAL commands + literal observed output / on-disk state — a real transcript, never a plausible one>

### Root cause (`src/<file>.cts`)
<numbered; each cause carries a `file:line`>

### Fix
<numbered steps; PREFER consuming the single source of truth over a new literal (avoid Generative-Fix-Divergence); note any in-repo precedent>

### Acceptance criteria
<bullets: concrete input → expected output/behavior>

### Verify
<test command(s); require fail-first regression tests for both halves; changeset + PR template>

### Authorization & scope fence
Go ahead and open the PR — <regression-first>; **scoped to <the specific defect> only. Do NOT alter <the adjacent intended behavior>.**
```

**Rules for the brief:**
- **Empirical, not hypothesized.** The Reproduction block must be an actual run's output (honesty-of-evidence — same non-negotiable as the sweep). If you couldn't reproduce, it isn't `confirmed-bug`; route to `needs-reproduction` instead.
- **`file:line` root cause.** Cite the real source location (`src/*.cts`, not the generated `bin/lib/*.cjs` — ADR-457).
- **Fix that doesn't re-introduce the bug.** If the root cause is a drifted hand-maintained list, the suggested Fix must reuse the source of truth (or add a parity test) — the Generative-Fix-Divergence rule (re-review.md 4c) applies to the *proposed* fix too.
- **Authorization + scope fence (mirror trek-e #2107).** Close the brief with an explicit go-ahead AND a scope fence — name what the PR may change and what it must **not** touch (#2107: *"scoped to the `blocking-human` opt-out only. Do not alter auto-mode's intended bypass"*). The fence keeps a small fix from drawing a sprawling change and binds the executor/contributor; the PR re-review (re-review.md step 8, scope-frozen to the defect class) enforces it.
- **Disposition line.** End with the labels you're setting: `**Disposition:** confirmed-bug + ready-for-agent` — and set them *alongside* the bot auto-tags (never strip `needs-triage` yourself here; `confirmed-bug` transitions it per the sweep's [labels.md](labels.md)).

## Enhancement / feature approval — the conditions checklist (mirror trek-e)

The Agent Brief is the **bug** confirm artifact. For an **enhancement / feature** (`approved-enhancement` / `approved-feature` is the code-gate — *no contributor code before it*), trek-e's approval is not a bare label either: it's a structured approval carrying a **hard caveat** plus an explicit **conditions checklist**, every item required before merge (#860). Post it as the approval comment, then apply the gate label alongside the auto-tags.

```
## ✅ Approved — `approved-enhancement` | `approved-feature`
<one-line: what's approved and the shape it must take>

### ⚠️ Caveat: <the one load-bearing constraint>        [only if there is a load-bearing boundary]
<the single change that would over-reach — e.g. "must land as a true drop-in; do NOT modify shared function X (breaks other consumers)">

### Conditions (all required before merge)
- [ ] <scope boundary — what's in, what's explicitly out (→ separate issue)>
- [ ] <changeset present (right type) + docs accompany it>
- [ ] <parity/registry updates done together + any count test bumped>
- [ ] <regression coverage via existing helpers>
- [ ] <issue-linked branch flow (branch `<type>/<issue#>-slug`, body `Closes #<issue#>`)>
- [ ] <no new runtime dependency / license exposure>            [where relevant]
```

**Rules:**
- **The caveat is the boundary that protects other consumers.** trek-e's #860 hard caveat forbade patching the shared `copyWithPathReplacement` "to benefit all runtimes" — it breaks the drop-in contract for existing runtimes. Name the one over-reaching change and forbid it; push the tempting generic fix to its own issue (#860 → #983).
- **Conditions are merge-gates, not suggestions.** Each box is a required pre-merge condition the PR re-review (re-review.md) then checks.
- **Re-scope, don't silently re-approve, when the platform moves.** If the architecture changed since approval (a new extension-point / host-integration interface landed), re-scope the approval to the new shape and say so — an approved feature built the old way is stale (#860 was re-scoped from scattered projection-edits to the 1.7.0 descriptor-first host-integration interface). See capability routing next.

## Route extension-point-shaped enhancements → `capability-candidate` (deliver as a capability, not core)

Before approving an enhancement as a **direct core change**, check whether it belongs on one of ADR-857's **"the 12" extension points** — if so, label it **`capability-candidate`** (live label: *"Deliver as an ADR-857 capability on one of 'the 12' extension points, not a direct code change"*) and steer it there instead of a core patch. The bar rose with the Embeddable Orchestration System (ADR-1239): adding a host/runtime is now a **declared, negotiated, parity-tested capability set — not scattered `runtime === '…'` edits** (#2099/#2102 migrate hosts onto EoS; #860 re-scoped to the descriptor-first host-integration interface). **Routing test:** does the change *extend* behavior at a declared extension point (runtime/host, command family, hook, skill…)? → `capability-candidate`. Does it *fix/alter core dispatch itself*? → core. Surface the routing in the approval; never default an extension-shaped feature into a core patch.

## Cross-cutting rules (carried from the sweep)

- **Honesty of evidence (non-negotiable).** The duplicate match, the version-gate reason, and the suggested role must come from the assist's actual LIVE-script output. If a script didn't run / couldn't load, write "not run" / report the LOUD error — never synthesize a plausible match or role.
- **Disclaimer on any tracker write.** If you (with `--apply`, or by running the surfaced `gh` command on the maintainer's behalf after authorization) apply a label or strip `needs-triage`, the action is the maintainer's confirmed call — carry the skill's `> *Generated by AI during triage; reviewed and posted by a human maintainer (@<you>).*` disclaimer on any comment that accompanies it.
- **Never hand-edit bot-managed labels.** `possible-duplicate` and `needs-version` are managed by LIVE GitHub Actions (see [labels.md](labels.md)) — surface the signal, let the lifecycle workflows own those labels. (`version-exempt` is a maintainer opt-out the version-gate *reads*, not a bot-managed label — and it is **not created live**, so don't try to apply it; see [labels.md](labels.md).)
- **Cross-repo issue-number provenance (#2107).** When an issue, brief, or PR cites other `#numbers` as precedent, verify they resolve against **this** tracker before repeating them — references can resolve against the **predecessor repo** (`gsd-build/get-shit-done`), not `open-gsd/gsd-core` (#2107: `#2827`/`#3309` were predecessor-repo refs that 404 here, while `#38` was a real in-tracker issue). Qualify predecessor-repo cites explicitly (name the repo) so a bare `#2827` isn't mistaken for this tracker's issue.
- **Advisory, not enforcement.** This procedure suggests and surfaces; it is not a deny gate and applies nothing on its own. The harness-boundary PreToolUse hooks remain the only enforcement layer.

## Red flags — STOP

- About to report a duplicate match or a role the assist didn't actually surface → run the assist or write "not run."
- About to suggest a role NOT in LIVE `docs/agents/triage-labels.md` → don't; the LIVE table is the sole source (D-07).
- About to apply a label / strip `needs-triage` without explicit per-issue authorization → don't; surface the `gh` commands and await the maintainer (D-04/D-05).
- The assist returned an `error` and you're about to report "no duplicates / clean" → don't; a LIVE-script miss is a LOUD failure, never a false clean (HARD-02).
- About to hand-edit `possible-duplicate` / `needs-version` → don't; those are bot-managed lifecycle labels.
