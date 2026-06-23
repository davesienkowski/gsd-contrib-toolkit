# CTK-ADR-0002: Distribute as a `role:feature` capability that carries PreToolUse enforcement via `hooks[]`

- **Status:** Accepted
- **Review:** Published for maintainer review and open to revision — a changed decision will be recorded
  by a superseding/amending CTK-ADR, never a silent edit to this record.
- **Date:** 2026-06-23 (milestone v2.1)
- **Scope:** GSD Contribution Toolkit.
- **Relates to (gsd-core):** ADR-1244 (capability ecosystem), ADR-894 (capability declaration format).
- **Supersedes (in part):** the v1.0 `06-CAPABILITY-SPEC` verdict that a shareable capability could
  only *advise*.

## Context

CTK-ADR-0001 puts enforcement in `PreToolUse` hooks. The question is how to *distribute* that — to the
owner restoring a setup, and eventually to other contributors — without a bespoke installer.

gsd-core ships a native capability ecosystem (ADR-1244): a manifest, opt-in consent, a ledger, and
shared-edit install/remove driven by a lifecycle engine. trek-e's `projects-sync-capability` is the
canonical third-party example.

The v1.0 `06-CAPABILITY-SPEC` had concluded the shareable form could only carry *advisory* loop
surfaces — but that reasoning looked only at `gates[]` (loop-point checks) and the `role:runtime`
`hooksSurface` axis, and **missed the `hooks: [{event, script}]` field on a `role:feature` body.**
Re-verified in LIVE gsd-core:

- `capability-validator.cjs` `validateFeatureBody` rule **C4** accepts `hooks` as `{event, script}`
  with a safe in-bundle relative `script` path; `hooks` is a feature-only field.
- `capability-lifecycle.cjs` `applyCapabilitySharedEdits` reads `manifest.hooks` and writes each into
  `settings.json` `hooks[event]` as the **absolute confined path**, **marker-tagged** so
  `stripCapabilitySharedEdits` / `removeCapability` remove exactly those entries.

No first-party capability ships a **non-empty** `hooks[]` array — all entries in the frozen
capability registry declare `"hooks": []`. This toolkit is the first to carry enforcement hooks this
way. (Re-verified against the live `capability-validator.cjs`, `capability-lifecycle.cjs`, and
`capability-registry.cjs`, 2026-06-23.)

## Decision

Ship the toolkit as **one `role:feature` capability bundle** whose `hooks[]` carries the 12 PreToolUse
gates + the 1 `UserPromptSubmit` advisory, plus `skills`, prose-disclosed commands, the default-off
`workflow.gsd_contrib_enforcement` config flag, and a single advisory `plan:pre` contribution.

- **Install/toggle/remove drive the LIVE engine** (`capability-lifecycle`/`consent`/`ledger`) — not a
  reimplementation. The ledger owns exactly one marker-tagged set, reconciling away the earlier
  manual-merge duplicate entries.
- **`gates[]` is empty** by honesty: the capability's loop surfaces are advisory and never reach the
  harness tool-call boundary; the harness-boundary property belongs to the installed hooks
  (CTK-ADR-0001), not to the capability.
- **The bundle is generated** from canonical `hooks/` by `build-capability.cjs` (with a `--check`
  drift gate); `verify-capability.cjs` asserts tri-surface `declared == shipped` parity against the
  LIVE validators and that bundled hooks still reach the LIVE gate scripts.

## Consequences

- **Positive:** native, consent-tracked, ledger-clean distribution; reuses gsd-core's lifecycle wholesale;
  proves a `role:feature` capability can legitimately ship enforcement hooks (a reusable pattern for
  gsd-core).
- **Negative / accepted:** an owner-side wrapper (`bin/contrib-capability.cjs`) is retained because the
  stock CLI requires `--shared-file` to apply hooks and does not reconcile legacy *untagged* duplicate
  entries; the wrapper applies shared-edits automatically and reconciles. The wrapper is owner-only;
  remote installers use the native git adapter.
- **Honesty:** the manifest description states plainly that the capability is advisory at loop points and
  is **not** "unbypassable" — that property is the installed hooks', not the capability's.
- **Dependency on framework internals (Hyrum's Law):** this decision relies on *observable behavior* of
  gsd-core's capability framework — the validator's C4 rule, the `hooks`-is-feature-only constraint, and
  `applyCapabilitySharedEdits`'s marker-tagged write — none of which is a frozen public contract. A
  gsd-core refactor of any of these could require re-verifying the bundle; `verify-capability.cjs`
  (which calls the LIVE validators) is the canary that would catch it.
