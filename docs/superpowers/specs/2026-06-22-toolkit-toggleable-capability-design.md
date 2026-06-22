# Design — Toolkit as a Toggleable GSD Capability

**Date:** 2026-06-22
**Status:** Approved design (brainstorming output) — ready for planning
**Author:** Dave + Claude
**Supersedes (in part):** the v1.0 `06-CAPABILITY-SPEC.md` verdict that "a capability cannot carry the
PreToolUse enforcement" (see Correction below).

---

## 1. Goal

Package the gsd-contrib-toolkit as a **single, installable, toggleable GSD capability** — the native
distribution form trek-e designed (ADR-1244) — so the whole toolkit (enforcement hooks **and** tooling)
can be installed, turned **on/off**, and removed cleanly against a local gsd-core checkout, with the
install/remove tracked by gsd-core's own capability **ledger** (which also eliminates the current
duplicate-entry problem in `settings.json`).

Privacy is preserved: the capability lives in **this** repo and installs into a local gsd-core checkout;
**nothing is committed or pushed to upstream gsd-core.**

## 2. Correction to the v1.0 verdict (why this is possible)

The v1.0 `06-CAPABILITY-SPEC.md` concluded the shareable capability could only *advise* — that the
PreToolUse enforcement could not ride in a capability. That conclusion reasoned only about `gates[]`
(loop-point checks) and the `role:runtime` `hooksSurface`/`hookEvents` axis, and **missed the
`hooks: [{event, script}]` field on a `role:feature` body.**

Verified in LIVE gsd-core (`~/repos/gsd-core/gsd-core/bin/lib/`):
- `capability-validator.cjs` `validateFeatureBody` rule **C4** accepts `hooks` as an array of
  `{event: string, script: string}` (script = a safe **relative in-bundle path**).
- `FEATURE_FIELDS_FORBIDDEN_ON_RUNTIME` lists `hooks` — i.e. `hooks` is a **feature-only** field.
- `capability-lifecycle.cjs` `applyCapabilitySharedEdits({runtimeDir, capId, manifest, sharedFiles})`
  reads `manifest.hooks` and writes each `{event, script}` into `settings.json` `hooks[event]` as the
  **absolute confined path**, **marker-tagged (`CAP_MARKER`)** so `stripCapabilitySharedEdits` /
  `removeCapability` remove exactly those entries.

No first-party capability ships a `hooks[]` array today — this toolkit would be the first, which is
fitting since it *is* a hooks bundle.

`role:runtime` capabilities (claude/codex/cursor) are **runtime adapters** (configHome / configFormat /
artifactLayout), not a vehicle for shipping hooks. So there is **no runtime capability** in this design.

## 3. Architecture — one `role:feature` capability

A single bundle, `capabilities/contrib-gate/`, carries the whole toolkit:

| Manifest field | Contents |
|---|---|
| `id` | `contrib-gate` (unreserved; `gsd-`/`gsd-core-`/`anthropic-` are reserved first-party) |
| `role` | `feature` |
| `version`, `engines.gsd`, `runtimeCompat`, `tier`, `requires:[]`, `title`, `description` | required envelope (description carries the honesty statement) |
| **`hooks`** | the **12 PreToolUse gates + the UserPromptSubmit advisory** as `{event, script}` entries → installed into `settings.json` (the enforcement) |
| `skills` | `gsd-core-contribution`, `maintainer-review-sweep` |
| commands (disclosed in `description` prose) | `gsd-submit`, `gsd-review-sweep`, `gsd-triage-assist`, `gsd-release-preflight`, `gsd-ruleset-drift` — Phase 9 established these `.md` commands don't fit the LIVE `validateCommandEntry` `{family, module, router}` shape (which needs a `.cjs` module), so they are disclosed in prose, not a `commands[]` array |
| `config` | one default-off flag `workflow.gsd_contrib_enforcement` (the advisory-behavior consent signal) |
| `contributions` | one advisory `plan:pre` fragment (`onError:"skip"`, gated by `when`) |
| `gates` | `[]` (loop-gates genuinely don't apply; never fabricate one) |

**Toggle granularity:** all-or-nothing, one bundle (per decision). Enforcement + tooling install/remove
together.

## 4. Bundle structure & staying in sync

Top-level `hooks/` stays the **dev source of truth**; the bundle is a **generated artifact** so there is
no second hand-maintained copy:

```
capabilities/contrib-gate/
  capability.json          # manifest (hooks[] + skills + commands + config + contribution + gates:[])
  hooks/                   # GENERATED from ../../hooks/*.cjs + hooks/lib/  (gate scripts; still call LIVE gsd-core scripts at runtime)
  fragments/plan-pre.md    # advisory contribution (existing)
```

- `bin/build-capability.cjs` assembles the bundle from canonical `hooks/`, stamps `version`, and has a
  **`--check` drift mode** (exit 1 if the bundle is stale vs source) — mirrors gsd-core's own
  "generated-from-source / `--check` for staleness" discipline.
- The bundled hook scripts keep their `require('./lib/...')` relative requires (so `hooks/lib/` ships in
  the bundle) and still resolve + call the **LIVE** gsd-core gate scripts at runtime via the existing
  `hooks/lib/resolve.cjs` resolver — **reuse-LIVE preserved.**
- `bin/verify-capability.cjs` is extended to validate the `hooks[]` manifest (still via the LIVE
  exported validators — no schema reimplementation) and to assert bundle⇄source parity.

## 5. Installer / toggler — driving the LIVE lifecycle

`bin/contrib-capability.cjs <install | on | off | status | remove>` is a **thin driver** that
`require()`s the LIVE gsd-core capability engine (same resolver the hooks use; never reimplemented).

**Entrypoint preference (resolved during planning via a short spike):** prefer the highest-level LIVE
orchestrator that fits a **local, private, project-scope** install — `capability-lifecycle.installCapability`
if its assumptions (source spec, consent, ledger, shared-edits) fit; otherwise compose the lower-level
LIVE functions below. Either way the engine is gsd-core's, not ours.

- **`install`** — `resolveCapabilitySource` (local adapter) stages the bundle → `recordProjectConsent`
  (project-scope consent in `${GSD_HOME||~}/.gsd/consent.json`, keyed to `realpath(gsd-core)` + capId +
  bundle hash) → `recordInstall` (ledger) → `applyCapabilitySharedEdits` writes the 12 gates +
  advisory into `gsd-core/.claude/settings.json`, marker-tagged. **Reconciles away the current
  duplicate entries** (the ledger now owns exactly one tagged set).
- **`on` / `off`** — `applyCapabilitySharedEdits` / `stripCapabilitySharedEdits` toggle the
  settings.json hooks, and flip `workflow.gsd_contrib_enforcement` for the advisory surfaces.
- **`status`** — report ledger entry, consent record, and which gates are live.
- **`remove`** — `removeCapability` (strip shared edits + delete ledger-owned files + revoke consent).
- Scope: **project**, pinned to the local gsd-core checkout. Default config flag is OFF (explicit opt-in
  for the advisory behavior).

## 6. "Off" semantics & accountability

Toggling **off removes the enforcement** (the gates leave `settings.json`) — that is the meaning of a
toggleable capability, and it is stated honestly in the manifest description and the README. To keep a
disable **accountable, not silent**, `off` / `remove` writes a **logged, append-only receipt** reusing
the `hooks/lib/override.cjs` pattern (per-project-root, reason-string recorded) — so turning the guard
off is a deliberate, recorded act, mirroring the `GSD_CONTRIB_OVERRIDE` philosophy.

The manifest description must NOT claim the capability is "unbypassable"; "unbypassable" applies only to
the PreToolUse hooks **while installed**. The loop `gates[]`/`contributions[]` remain advisory.

## 7. Fold-in — the pre-existing `policy-invariants` proof failure

`bin/verify-hooks.cjs` reports `37 pass, 1 fail` — `policy-invariants-deny` expects `deny` but the LIVE
`policy-invariants` entrypoint now returns `allow`. Reproduced before any of phases 7–10 (commit
`65cba7c`); it is LIVE gsd-core policy-script drift, not toolkit regression (logged in
`deferred-items.md`). This design **folds in the fix**: diagnose *why* the gate's "bad" fixture no longer
trips a deny (which LIVE mechanizable check changed), correct the fixture (or the gate's expectation),
and re-capture so `verify-hooks` is **38/38 green**. This is gated by `/gsd-debug`-style root-cause
analysis, not a blind fixture edit.

## 8. Testing

- **`verify-capability.cjs`** extended: validates the `hooks[]` manifest via LIVE validators; asserts
  bundle⇄source parity; LOUD-on-miss.
- **`build-capability.cjs --check`**: drift gate (bundle stale vs source → fail).
- **New install/toggle test** on a **disposable sandbox** (mkdtemp; mirrors `fault-injection.test.cjs`):
  drives the LIVE lifecycle functions to install → assert 12 gates marker-tagged in a fake settings.json
  → `off` strips exactly them → `on` restores → `remove` cleans ledger + consent. No real gsd-core
  settings mutated in tests.
- **`verify-hooks.cjs`** 38/38 after the §7 fix.
- **`self-test.cjs`** integrates the new checks.

## 9. Migration from `install.sh`

- `install.sh` keeps **only** the `~/.claude` symlink restore (and its stale vendored list is fixed to
  include the 3 new phase-8 commands).
- Its `settings.json` merge is **superseded** by the ledger-clean capability `install`.
- First capability `install` **reconciles** the existing duplicate `settings.json` entries into one
  marker-tagged set.

## 10. Constraints honored

- **Privacy:** bundle + installer live in this repo; install targets a local gsd-core checkout; nothing
  committed/pushed upstream.
- **Reuse-LIVE (HARD-02):** the installer drives the LIVE `capability-lifecycle`/`consent`/`source`/
  `ledger` functions and the bundled hooks call LIVE gate scripts — no reimplementation of gsd-core
  policy or the capability engine.
- **Honesty:** enforcement is unbypassable *while installed*, removable by toggle-off (recorded);
  capability never labeled "unbypassable"; loop surfaces are advisory.

## 11. Out of scope / deferred

- Publishing to an external registry or the URL importer (ADR-1244 D3 non-local adapters).
- Contributing the missing `gsd capability install` CLI **upstream** to gsd-core (private until proven).
- A `role:runtime` adapter (not needed — claude adapter already exists in gsd-core).
- Global-scope (`~/.gsd/capabilities/`) install — project-scope only for now.

## 12. Suggested delivery

A new GSD milestone (e.g. **v2.1 — Capability-Native Distribution**) with roughly these phases:
1. Bundle + `build-capability.cjs` (+ `--check`) + `verify-capability` extension for `hooks[]`.
2. `contrib-capability.cjs` installer/toggler driving the LIVE lifecycle + consent + ledger + receipt.
3. Fold-in the `policy-invariants` fix → `verify-hooks` 38/38.
4. Migration (install.sh slim-down + duplicate reconcile) + docs update.
