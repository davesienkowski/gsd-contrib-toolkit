# CTK-ADR-0006: Enforce every step, and scaffold obligations rather than evidence

- **Status:** Accepted
- **Review:** Published for maintainer review and open to revision — a changed decision will be recorded
  by a superseding/amending CTK-ADR, never a silent edit to this record.
- **Date:** 2026-07-29 (milestone v2.7+)
- **Scope:** GSD Contribution Toolkit.
- **Amends:** CTK-ADR-0004 — extends the artifact pattern from P1–P3 to **every** contribution step and
  to the review pipeline, and adds the scaffolding contract §Decision.4 implies but never states.
  Nothing in 0004 is withdrawn.
- **Relates to:** ENF-19 (`protocol-artifact`), **ENF-20** (`review-artifact`, new), OBS-01, and the
  `full-system-map.md` inventory that measured the gap.

## Context

CTK-ADR-0004 established that a step becomes enforceable once it deposits an artifact, and proved it
for P1/P2/P3. Two gaps remained, and an inventory of the live system measured both.

**Gap 1 — the enforcement inversion.** Charting every hook against every pipeline step gave:

> **Authoring: 13 blocking gates across 19 ENF codes. Adjudicating: zero blocking gates across 23
> steps.**

The side with *less* authority — proposing a change a maintainer must still approve — carried all the
enforcement. The side with *more* authority — approving, dismissing, closing, merging, actions that
are outward-facing and effectively irreversible — carried none. Posting a close comment and closing an
issue fired no hook at all.

The structural cause: `hooks/lib/classify.cjs` recognised exactly six mutating actions (`commit`,
`issue-create`, `issue-edit`, `pr-create`, `pr-edit`, `push`). Every review verb — `gh pr review`,
`gh pr merge`, `gh issue close`, and the comment forms — classified as `other`, so no gate could see
them even in principle.

**Gap 2 — the steps that emit nothing.** STEP ZERO (P0–P6 as tracked todos), P0 (read CONTRIBUTING +
templates + ADRs + CONTEXT.md) and P0b (the ADR/CONTEXT sweep) stayed advisory for the reason 0004
itself identified: doing the step and claiming the step are indistinguishable when the step produces
no output. POLICY-03 is explicit that P0b is "NOT a pass/fail gate."

**The directive that prompted this record** was to enforce all steps and let the toolkit create the
artifact where needed. The second half is where the danger is, and it is the reason this record exists
rather than a commit message.

## Decision

### 1. Scaffold obligations, never evidence

CTK-ADR-0004 §Consequences states the gate's value precisely: it "converts skipping from free and
silent into **deliberate and recorded**." A gate that *authors* its own target artifact converts
skipping into **free, silent, and automatic** — strictly worse than no gate, because the artifact now
carries the appearance of evidence.

So a gate may write a **skeleton** whose every substantive field is an unfilled placeholder, and must
then deny while any placeholder remains. `hooks/lib/scaffold.cjs` enforces this as a **runtime
invariant**, not merely a tested property: `scaffold()` re-checks its own output and throws
`ScaffoldContractError` rather than return a skeleton that could satisfy a gate.

Corollaries, each of which was a real design decision:

- **Booleans are claims, never format.** Scaffold constants are restricted to string/number/null, so
  `reproduced: true` cannot be pre-supplied as "structure".
- **Skeletons are valid JSON.** The artifact readers fail closed on malformed input, so a JSONC or
  markdown skeleton would surface as "not valid JSON" instead of "fill in the placeholders" —
  reintroducing the friction this removes, in a more confusing form.
- **Instructional text must never contain the sentinel**, because it survives into the filled artifact
  and would deny it forever.
- **Never overwrite.** `writeScaffoldIfAbsent` uses exclusive create (`O_EXCL`), so the kernel decides
  the race, not an `existsSync` pre-check. A scaffold must never clobber real work.

### 2. The placeholder scan is a PRECONDITION, not an extra assertion

This is the highest-severity invariant in this record, and it is a measurement, not a preference.

Run an untouched skeleton through the *existing* shape assertions:

| Gate | Shape assertions passing on an unfilled scaffold |
|---|---|
| ENF-19 P2 | **5 of 6** |
| ENF-20 R8-code | 4 of 5 → **5 of 5** after the documented "found nothing → delete the entry" edit |
| ENF-20 R8-security | 4 of 5 → **5 of 5** |

A placeholder string is `nonEmpty`. So for both step-8 artifacts the shape checks are *entirely*
satisfied by a file the gate wrote itself. Only ENF-19's one enum predicate caught it, by luck of
being an enum rather than a non-empty check.

Therefore: **every artifact gate MUST call `hasUnfilledPlaceholders` on the raw artifact text before
trusting any shape assertion**, and before any waiver short-circuit — a half-scaffolded artifact is
*unwritten*, not waivable. Any future gate-table entry that omits this re-opens the inversion. The
measurement is pinned as a regression test so a future reordering fails with an explanation.

Placeholder detection fails closed: on the open marker alone (a lone `>>>` occurs in genuine observed
output and is explicitly rejected as a signal), on either delimiter eroded, and on non-string or empty
input. **Stated limit:** deleting the word `FILL` itself is indistinguishable from filling the field.
At that point the artifact merely holds a bad value, which is the shape assertions' job.

### 3. Assert that an enumeration COVERS a required set

"Assert shape, never mere presence" (0004 §Decision.4) needs a sharper tool for steps whose output is
inherently a list. `covers` asserts an enumeration spans a required set **and names what is missing** —
`todos: 17` fails because a count is not a list; a P0 artifact listing filenames without an observed
detail per file fails; an ADR id without a quoted clause and a `conforms_how` fails.

Naming the gap is deliberate: "you never opened `CONTEXT.md`" sends the agent to a file, whereas "your
list is incomplete" sends it guessing. Required sets match by **prefix family** (`P3a`…`P3d` cover
`P3`) so the gate does not go stale the first time the skill gains a sub-step.

### 4. Review-side gating is legitimate, and bounded to four steps

A hook cannot evaluate judgement. But four re-review steps are pure **artifact-existence** checks, and
ENF-20 gates exactly those: two orthogonal passes (step 8), the merge gate (13), the treadmill guard
(1), and the exogenous self-check (10). Everything else on the review side — a verdict's correctness, a
label, a dismissal — stays out of scope because gating it would require adjudicating.

`issue-close` is **deliberately not governed**: no declared step backs it, and adding an obligation to
the frozen table with no step behind it would be enforcement theatre. **Recorded gap:** diverting a
pure `PATCH …/issues/{n}` + `state=closed` into the new `issue-close` action removed it from
`gh-edit`'s `{issue-edit, pr-edit}` surface, so a *pure* close is now edit-gated by nobody. An
edit-wins narrowing keeps any PATCH also carrying `title`/`body` on the `issue-edit` path.

### 5. Arming has two modes, both contextual

0004 §Decision.3 rejected a manual arm file because a manual arm is itself an unobservable step. That
principle now has two instantiations, and the difference is load-bearing: **ENF-19 arms on the
contribution branch**; **ENF-20 arms on the action being a review-side verb against a PR**, because a
maintainer re-reviews from `next` and would never be on a contribution branch.

### 6. Key the artifact to the thing it vouches for

A review artifact keyed to a PR number alone is satisfied by a stale review of an older push — the
staleness bug ENF-05 solved by keying its marker to `git write-tree`. ENF-20 keys to **PR number +
HEAD OID**, in two independent layers: the directory key, plus an in-artifact `head_oid` checked
against the live value. The second catches a file *copied forward* into the new directory, which the
directory key alone cannot see. A non-hex or unresolvable OID **throws** rather than being sanitized —
a key that cannot be trusted must fail closed, and this doubles as the path-traversal guard.

### 7. One engine, now literal

0004 §Decision.1 said "one engine, not a second gate system." ENF-20 imports ENF-19's predicate
vocabulary (`checkAssertion`, `readPath`, `isNonEmpty`) rather than restating it, and shares
`GSD_CONTRIB_OVERRIDE`, the receipt channel, HARD-01 and HARD-04. **Consequence to hold:** ENF-20 is
now coupled to ENF-19's export surface, so reshaping those exports is a two-gate change.

### 8. Extending the shared classifier requires a legacy-wins aggregation rule

`classifyAction` returns **one verdict per command chain**, and six gates read that aggregate directly.
Adding review actions naively made `gh issue comment 1 && gh issue create --title t` collapse to
`issue-comment` → not governed → `issue-dedupe` and `protocol-artifact` would have **allowed a create
they deny today**. The classifier extension would have manufactured a bypass in six gates while every
existing test stayed green.

So aggregation runs in two passes: legacy actions and fail-closed first, review-side actions only
where the old code returned `other`. Pass 2's outcomes are a strict subset of the old `other`, so no
pre-existing classification *can* change. **Normative consequence: gate on
`hasGovernedSegment(parsed, [...])`, never on `classifyAction(parsed).action`.**

Also recorded: a PR conversation comment posts to the **issues** endpoint and issue/PR numbers share
one namespace, so the classifier — which is pure by contract — cannot disambiguate. It reports what the
command *names* and exports `PR_COMMENT_EQUIVALENT_ACTIONS`; the gate resolves PR-ness with a real
lookup, behind a pure pre-filter so an ordinary issue comment costs zero network calls.

## Consequences

- **Positive:** no contribution step remains purely advisory except one named exception; the review
  pipeline gains its first enforcement; scaffolding removes the "I don't know the required format"
  friction without weakening the obligation; the measured 5-of-6 assertion hole is closed and pinned.
- **Positive:** ENF-20's treadmill check reads GitHub's own review list — **independent verification**,
  one rung above *artifact* on the trust ladder (attestation < artifact < independent verification).
  This is the first gate in the toolkit at that tier, affordable because it is a machine fact
  requiring no judgement.
- **Negative / accepted — the honesty limit is unchanged.** These gates check **shape, not honesty**. A
  `tracker: "TodoWrite"` with plausible todo text can still be authored from an agent's head.
  Scaffolding narrows the gap further only in the sense that skipping is now *recorded*; it must never
  be described as closing it.
- **Negative / accepted — `merge=#n` is an attestation inside an artifact gate.** The human's
  authorising token never reaches `PreToolUse`, so it is checked only for *consistency* with the PR
  being merged. A copied merge record naming another PR denies; a fabricated token for the right PR
  does not. Recorded so it is not later mistaken for evidence.
- **Negative / accepted — P0b stays advisory on `issue-create` and `push`.** POLICY-03 sweeps *the
  changed area* and P0b's load-bearing output is diff-vs-clause conformance. An issue has no diff and a
  bare push is transport, not authoring; gating it there would demand a conformance statement about a
  diff that does not exist. Asserted as a deliberate non-gate.
- **Negative / accepted — P0b records, never adjudicates.** `conforms_how` is checked for presence
  only, so POLICY-03's "NOT a pass/fail gate" survives: the gate enforces the *deposit* of awareness,
  not a verdict on it.
- **Negative / accepted — ENF-19 now writes to disk.** It was read-only. Writes are confined to
  `.gsd/contrib`, use exclusive-create, and a scaffold-write failure degrades to a plain deny — never
  masking a policy denial behind a fail-closed one.
- **Negative / accepted:** contribution and review branches now carry more mandatory `.gsd/contrib/`
  payload. `.gsd` is gitignored in gsd-core, so none of it enters a PR.
- **Honesty constraint (inherited, load-bearing):** the unbypassable property belongs to the installed
  hooks — not to any wrapper, not to the toolkit as a thing-in-itself. More gates do not change that.

## Alternatives considered

- **Have the toolkit fill the artifact in** — rejected as the inversion this record exists to prevent
  (§Decision.1). It was also the literal reading of the request, which is why the reasoning is recorded
  here rather than assumed.
- **Adopt the spike-004 receipt model for the review side** — rejected. Its own caveat says a receipt
  proves *emission*, not execution: "the same Goodhart shape as the *I have searched existing issues*
  checkbox — an assertion standing in for the act." The artifact model is strictly stronger and already
  trusted.
- **A root-level config file listing the gates** — rejected, per 0004 §Decision.2: it would be an
  untracked file in every worktree of a repository the toolkit does not own. The tables stay as tested
  source.
- **Pin STEP ZERO to the skill's exact checklist** — rejected: it would go stale the first time the
  skill gained a step. Prefix-family coverage instead.
- **Gate every review verb, not four** — rejected: the rest require adjudicating, which a hook cannot
  do. Four is the boundary of what is mechanizable, and naming that boundary is part of the decision.
