# CTK-ADR-0005: Grade gate severity, and allow toolkit-owned signals beside the LIVE ones

- **Status:** Accepted
- **Review:** Published for maintainer review and open to revision — a changed decision will be recorded
  by a superseding/amending CTK-ADR, never a silent edit to this record.
- **Date:** 2026-07-29 (milestone v2.7+)
- **Scope:** GSD Contribution Toolkit.
- **Amends:** CTK-ADR-0001 §Decision.3 ("Reuse LIVE, never reimplement") — narrowed to permit a
  *strictly additional* toolkit-owned signal at a lower severity, without displacing the LIVE
  policy. And CTK-ADR-0001 §Decision.2 (HARD-01 fail-closed), which now admits one scoped
  exception. Neither is withdrawn — see Decision below.
- **Relates to:** ENF-11 (`issue-dedupe`), the first graded gate; CTK-ADR-0004 (the artifact
  pattern, whose "assert shape not honesty" honesty clause this record follows).
- **Amended by:** [CTK-ADR-0007](CTK-ADR-0007-runtime-freshness-and-the-network-unavailable-severity.md)
  (2026-07-30, milestone v2.7+) — narrows §Decision.4. That clause admits a fail-OPEN exception to
  HARD-01 **only** for a sub-check that *cannot* deny. CTK-ADR-0007 adds the adjacent case: a
  sub-check that *can* deny, whose input is *unobtainable* (ENF-21's upstream tip with the network
  down and no cached tip inside the staleness budget), resolves to **`ask`** — the third severity
  this record introduced — and never to `allow`. Narrowed, not withdrawn: this record stays
  **Accepted**, and every check that can deny still fails closed whenever its input is obtainable.

## Context

Two of the toolkit's founding rules met a case they did not anticipate.

**First, the binary severity.** Every gate had exactly two outcomes: `allow` or `deny`. That was
adequate while every signal was either conclusive or absent. ENF-11 broke it.

ENF-11 denies on a title Sørensen–Dice similarity ≥ 0.6, delegated to gsd-core's LIVE
`scoreCandidates`. Measured against gsd-core's own duplicate-closed issues:

| Rule | Recall on reworded duplicates | Pair FPR | Expected fires per filing |
|---|---|---|---|
| title-Dice ≥ 0.6 (the existing deny) | **0/9** | **0.00%** | 0.000 |
| ≥1 shared code-citation path | 5/9 | 4.99% | **4.238** |
| ≥2 shared paths | 3/9 | 0.70% | 0.595 |
| ≥2 shared *rare* paths (df ≤ 2) | 2/9 | 0.06% | **0.048** |

(3570 open non-duplicate pairs; 9 duplicates whose titles scored < 0.6. Expected-fires-per-filing =
pair FPR × the 85 open issues citing code, and is the decision-relevant figure. Sweep:
`scratchpad/dedupe-threshold-sweep.cjs`.)

Three facts follow, and they are the whole reason this record exists:

1. **The existing deny is precise, not broken.** 0.00% false positives over 3570 pairs. It reliably
   catches the byte-identical class, which is live: `#2739`–`#2748` are six issues with identical
   titles filed 2026-07-28 inside twelve minutes, all closed as duplicates.
2. **It is also blind.** 0/9 on duplicates that were reworded — the normal case when two competent
   agents describe the same defect independently.
3. **No citation rule is safe as a deny.** Nothing buys recall ≥ 3/9 at acceptable noise. The
   cheapest rule holding recall ≥ 3 fires on roughly every other legitimate filing. Under a binary
   severity the only options were "ship a gate that blocks constantly" or "ship nothing."

A methodological trap is worth recording, because it nearly produced the wrong decision: the rule
`rare(df ≤ 1) ≥ 1` appeared to give recall 4/9 at a 0.00% false-positive rate. It is an **artifact**.
Document frequency is computed over *open* issues, so a path shared by two open issues is cited by
both and has df ≥ 2 *by construction* — `df ≤ 1` therefore cannot fire on a false-positive pair at
all. Its 0.00% is a structural floor, not a measurement, while its recall is simultaneously inflated
because the closed duplicate never enters the corpus. Both errors point the same way, which is what
made it convincing.

**Second, the LIVE-only rule.** CTK-ADR-0001 §3 requires each gate to `require()` the LIVE gsd-core
script and never reimplement its policy. The citation signal has **no gsd-core counterpart** — and
the option of adding one upstream is closed: the maintainer has directed that nothing be added to or
changed in gsd-core. So the signal is either toolkit-owned or it does not exist.

## Decision

1. **Gates may return a third decision, `ask`.** `hooks/lib/failclosed.cjs` gains an `ask(reason)`
   builder and passes `permissionDecision: 'ask'` through, surfacing the reason and deferring to the
   human. `allow` and `deny` envelopes are unchanged byte-for-byte, and **anything that is not
   exactly `allow` or `ask` still becomes `deny`** — the fail-closed default for a garbage or empty
   decision is not weakened.

   Two independent collapse points had to be fixed, and both were load-bearing: `emit()` folded any
   non-`allow` into `deny`, and `runGate` separately folded any non-`deny` into `allow`. Either alone
   would have silently corrupted the new severity in opposite directions.

2. **Severity must match measured confidence.** A signal is eligible to `deny` only with a measured
   near-zero false-positive rate. A signal with real recall but material noise belongs at `ask`. A
   signal that can be neither is not shipped. **Thresholds are constants carrying their measured
   recall/FPR and the sweep path in a comment** — so a reader can tell a measurement from a guess,
   and re-run it.

3. **A toolkit-owned signal may run *beside* a LIVE one, never *instead of* it.** The LIVE
   `scoreCandidates` remains untouched and remains solely authoritative for the deny. The citation
   check is strictly additional and strictly lower-severity. It may not modify, wrap, re-weight, or
   substitute for LIVE policy. This is the narrow crack opened in CTK-ADR-0001 §3, and it is
   deliberately shaped so that removing the toolkit signal returns the gate to exactly its prior
   behaviour.

4. **A lower-severity check inside a fail-closed gate fails OPEN.** ENF-11 remains fail-closed for
   its enforcement path: a failed *fetch* still denies (HARD-01). But the citation computation is
   pure arithmetic over already-fetched data, and if it throws the gate falls through to the LIVE
   verdict rather than denying. An advisory able to fail closed would be a whole-suite hazard in
   exchange for a 2/9 signal.

   This is the scoped exception to HARD-01. It is admissible **only** for a check that cannot deny.
   Any check that can deny still fails closed, unconditionally.

5. **Noise is a first-class budget.** The chosen threshold, `rare(df ≤ 2) ≥ 2`, costs ~0.048
   expected fires per filing — roughly one prompt per twenty issues. A prompt that fires on every
   filing trains the human to dismiss it, which destroys more value than the signal adds. Recall was
   traded down (5/9 → 2/9) to buy that quiet, deliberately.

## Consequences

- **Positive:** a class of real-but-noisy signals becomes shippable at honest severity instead of
  being discarded or force-fit into a deny; the toolkit can act on evidence gsd-core has no
  mechanism for, without forking gsd-core policy; the precise existing deny is preserved rather than
  widened; thresholds carry their provenance, so a future reader can audit or re-derive them.
- **Negative / accepted:** the toolkit now prompts on pairs gsd-core's CI would not flag — a
  deliberate, recorded divergence. It is consistent with the toolkit's existing posture (ENF-11's own
  header notes gsd-core labels post-hoc while this gate blocks pre-file), but it does mean local and
  CI behaviour are no longer identical by construction.
- **Negative / accepted:** `ask` is a **human** gate. It reduces to `allow` for any unattended run,
  so it must never carry a check whose failure would be unsafe to wave through.
- **Negative / accepted:** ENF-11's real recall on reworded duplicates goes from 0/9 to **2/9**. That
  is an improvement, not a solution, and must not be described as closing the gap. The durable
  finding is the negative one: **no citation rule reaches recall ≥ 3/9 at acceptable noise**, so the
  remaining 7/9 are not reachable by this mechanism at all.
- **Honesty constraint (inherited, load-bearing):** CTK-ADR-0001's rule that the unbypassable
  property belongs to the installed hooks — not to any wrapper, and not to the toolkit as a
  thing-in-itself — applies unchanged. A graded severity does not make the suite more unbypassable;
  it makes one gate more honest about what it knows.

## Alternatives considered

- **Ship the citation rule as a `deny`** — rejected on measurement. At 0.595–4.238 expected fires per
  filing it would block routine work; L3 records one gate's fail-closed misfire already costing the
  entire suite, and there is still no per-gate quarantine.
- **Add the citation channel to gsd-core's `scoreCandidates`** (the original "Change A") — rejected:
  out of scope by maintainer direction. The evidence (0/9 vs 5/9, and the FPR table above) is
  recorded here should that ever be revisited upstream.
- **Leave ENF-11 title-only and accept 0/9** — rejected: 2/9 at ~1 prompt per 20 filings is a
  strictly better trade, and the measurement was already paid for.
- **Ship it as a fail-open advisory *hook* rather than a graded decision in the existing gate** —
  rejected: it needs the same fetch, the same parse, and the same classifier as ENF-11. A second hook
  would duplicate all three and double the `gh` call the plan measured at +161 ms.
- **`rare(df ≤ 1) ≥ 1`, which measures better** — rejected as a structural artifact (see Context).
  Recorded explicitly because it looked like the winner.
