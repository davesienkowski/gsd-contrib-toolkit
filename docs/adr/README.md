# Architecture Decision Records

Decision records for the **GSD Contribution Toolkit**. These are **toolkit-scoped** and namespaced
`CTK-ADR-*` so they are never confused with gsd-core's own numeric ADRs (e.g. ADR-959, ADR-1244),
which they reference. Format follows gsd-core's Nygard style (Status / Context / Decision /
Consequences).

> **Status & review:** these records are marked **Accepted** because the decisions are implemented and
> shipped — but they are **published for maintainer review and open to revision**. A changed decision is
> recorded by a *superseding or amending* CTK-ADR, never a silent edit to an accepted record.

| ADR | Decision | Status | Milestone |
|---|---|---|---|
| [CTK-ADR-0001](CTK-ADR-0001-harness-boundary-enforcement.md) | Enforce contribution outcomes at the harness boundary (PreToolUse hooks; outcomes-not-steps; fail-closed; reuse-LIVE) | Accepted | v1.0 |
| [CTK-ADR-0002](CTK-ADR-0002-capability-native-distribution.md) | Distribute as a `role:feature` capability carrying PreToolUse enforcement via `hooks[]` | Accepted | v2.1 |
| [CTK-ADR-0003](CTK-ADR-0003-full-surface-toggle-cross-runtime.md) | On/off toggles the full surface; per-runtime hybrid delivery; no `.md`→`.cjs` command rewrite | Accepted | v2.3 |
| [CTK-ADR-0004](CTK-ADR-0004-artifact-gated-step-discipline.md) | Enforce step discipline by requiring each step's artifact (**amends 0001 §Decision.1**) | Accepted | v1.1 |
| [CTK-ADR-0005](CTK-ADR-0005-graded-gate-severity-and-toolkit-owned-signals.md) | Grade gate severity (`ask` beside `allow`/`deny`); permit a strictly-additional toolkit-owned signal at lower severity (**amends 0001 §Decision.2 and §Decision.3**) | Accepted | v2.7+ |
| [CTK-ADR-0006](CTK-ADR-0006-universal-step-enforcement-and-obligation-scaffolding.md) | Enforce every step; scaffold **obligations, never evidence**; review-side gating (ENF-20) bounded to four mechanizable steps (**amends 0004**) | Accepted | v2.7+ |
| [CTK-ADR-0007](CTK-ADR-0007-runtime-freshness-and-the-network-unavailable-severity.md) | Gate on installed-runtime freshness via a digest-bound toolkit stamp (ENF-21); an unobtainable upstream tip resolves to `ask`, never `deny` (**amends 0005 §Decision.4**) | Accepted | v2.7+ |

For the narrative design overview, see [../foundations.md](../foundations.md).
