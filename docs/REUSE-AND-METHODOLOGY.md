# Reuse & Methodology Alignment

**Status:** Canonical decision record. **Audience:** Phases 3–6 authors and reviewers.

This is the single source of truth for two decisions the gsd-contrib-toolkit fixes **before any
enforcement code is written**: (1) what the toolkit reuses from GSD's existing command machinery
versus what it builds itself (the per-command reuse map, ALIGN-03); and (2) where the toolkit mirrors
trek-e's methodology — the artificer law-lenses + `trust-but-verify` on the pre-file review step
(ALIGN-01) and Matt Pocock's `tdd` on the authoring path (ALIGN-02) — versus where it stays
gsd-core-native (triage, on gsd-core's own repo-model). Phases 3–6 consume THIS record instead of
re-deciding reuse or methodology. Plan 02-02 wires the `gsd-core-contribution` skill and the
`gsd-submit` / `gsd-review-sweep` commands to reference it.

## Reuse Map

Per **ALIGN-03**, every GSD command the toolkit could lean on gets exactly one verdict —
**delegate**, **wrap**, or **leave-alone** — plus a defensible rationale. The contribution path is the
toolkit's own `gsd-submit` flow gated by the Phase 3/4 PreToolUse hooks; a command is "leave-alone"
when it sits outside that path and "delegate" when the path calls it rather than reimplementing it.

| Command | Verdict | Rationale |
|---------|---------|-----------|
| `gsd-ship` | leave-alone | `gsd-ship` is GSD's generic PR/review/merge-prep flow for a project's *own* roadmap work. The contribution path does not ship the toolkit's own roadmap — it files an upstream gsd-core contribution through the toolkit's `gsd-submit` plus the Phase 3/4 enforcement gates (issue-version, PR-template, lint:ci). Routing contributions through `gsd-ship` would bypass those gates, so it stays out of the contribution path entirely. |
| `gsd-inbox` | leave-alone | `gsd-inbox` is the generic issue/PR triage inbox. Maintainer-side sweeps in this toolkit go through the vendored `maintainer-review-sweep` skill, which carries the repo-specific labels, gotchas, and authority facts. The generic inbox would lose that repo fidelity, so it is left out of the contribution and sweep paths. |
| `gsd-pr-branch` | delegate | `gsd-pr-branch` produces a clean, `.planning/`-free PR branch — exactly what an upstream contribution must not leak. The toolkit calls it rather than reimplementing branch filtering, so the toolkit inherits GSD's filtering as GSD evolves it instead of maintaining a parallel copy that can drift. |
| `gsd-code-review` | delegate | `gsd-code-review` is the pre-file review engine. The toolkit invokes it rather than building its own reviewer, then layers the methodology below (artificer law-lenses + `trust-but-verify`) on top of its output. Delegating keeps the review surface aligned with GSD's reviewer as it improves. |

**Legend — what the verdicts mean:**

- **delegate** — the toolkit *calls* the existing GSD command rather than reimplementing its behavior;
  the command's output feeds the contribution path directly.
- **wrap** — the toolkit calls the command but adds its own gates/checks *around* it (no command in
  this map currently takes this verdict; it is defined here so a later phase can adopt it without
  redefining the term).
- **leave-alone** — the command is out of the contribution/sweep path entirely; the toolkit neither
  calls it nor reimplements it.

## Methodology Alignment (trek-e)

The toolkit mirrors trek-e's published methodology where it is sharper than a hand-rolled equivalent.
Two parts of the contribution path adopt named, resolvable skills.

### Pre-file review

Per **ALIGN-01**, the pre-file review step — the gate a contribution passes through *before* it is
filed — explicitly invokes two skills by name, not as optional prose:

- **`skills-from-the-artificer`** — the law-lens dispatcher. Each *firing* law's key questions are
  applied to the concrete diff (Hyrum's-Law behavior changes captured for PR disclosure). This is the
  adversarial/verify lens trek-e runs.
- **`trust-but-verify`** — the claim-verification skill. Any cited ADR, policy, or "trek-e confirmed
  it" justification is opened and quoted from source rather than trusted from memory. This is the layer
  that survived the max-pressure prompt tests where model-driven prose rationalized past the gates.

Both skills are invoked together at the pre-file review step and are wired into the
`gsd-core-contribution` skill's review section by plan 02-02 so they are part of the documented
contribution path.

### Authoring path

Per **ALIGN-02**, contribution code/fix authoring adopts Matt Pocock's **`tdd`** skill (red → green):
write the failing test first, then the minimal fix to pass it. This replaces the
`superpowers:test-driven-development` sub-skill currently named in the `gsd-core-contribution` skill's
Phase 3 (the swap is performed by plan 02-02). `tdd` is cited here by its exact resolvable skill name
so a downstream verifier matches it.

## Triage Divergence (documented)

Per **ALIGN-02**, triage is a **deliberate, documented divergence** from trek-e's stack — not a TODO
and not a gap. Triage **stays on gsd-core's own repo-model**: its `/triage` state machine and its
canonical roles. The toolkit does **not** adopt Matt Pocock's generic `triage` skill.

**Rationale (locked, from the REQUIREMENTS Out-of-Scope ruling):** gsd-core's own `/triage` state
machine and canonical roles are more specific to this repo than a generic per-repo triage; replacing
them with Pocock's generic triage would lose fidelity. The toolkit mirrors trek-e on verify and TDD —
where his skills are sharper — but keeps the sharper triage wheel that gsd-core already owns. This
divergence is recorded here so a later phase audits the choice against its source instead of
rediscovering it.

---

*Traceability: ALIGN-01 (pre-file review skills), ALIGN-02 (Pocock `tdd` adoption + triage divergence),
ALIGN-03 (per-command reuse map) are each addressed and ID-cited above. Referenced by plan 02-02.*
