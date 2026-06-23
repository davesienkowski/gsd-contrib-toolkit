# Track 1 — Upstream Capability Feature Requests (to trek-e / gsd-core)

> **STATUS: CAPTURED, NOT filed this milestone (v2.3).**
> These are two Track 1 upstream feature requests to trek-e / upstream gsd-core. They are recorded
> here so they can be filed later without re-deriving the design. **Nothing in this milestone files an
> issue, opens a PR, or pushes to upstream gsd-core.** The filing method (issue vs. issue + reference
> PR) and timing are a separate, deliberate, later act — the privacy / don't-touch-upstream constraint
> holds until then. The **v2.3 in-repo driver is the reference implementation** for both asks.

These asks come from the approved design's Track 1 section
(`docs/superpowers/specs/2026-06-23-on-off-full-surface-toggle-design.md` §10). The goal: let the
**stock** `gsd capability install/enable/disable` + `/gsd-surface` lifecycle eventually run with
symlink delivery, so this capability becomes a properly distributable, cross-runtime GSD capability
without forking the framework. Until Track 1 lands, the v2.3 driver provides the full-surface toggle on
Claude with symlinks, and the framework's existing copy-convert provides cross-runtime skill delivery.

---

## Ask (a) — Opt-in `link` (symlink) delivery mode + persistent canonical bundle target + namespacing

A feature capability whose Claude projection is byte-identical (no dialect conversion) currently cannot
use the framework's native delivery to mirror its artifacts by symlink — it must copy. We ask for an
**opt-in `link` (symlink) delivery mode** plus the two things that make it land safely.

1. **Opt-in `link` (symlink) delivery mode** for `skills` / `commands` / `agents`, with **default
   `copy`** for back-compat. Valid **only where conversion is identity** (Claude tier-1); runtimes that
   need conversion fall back to copy. Enable/disable becomes **symlink-on-enable / unlink-on-disable**.

2. **A persistent canonical bundle target** for the symlink to point at. Today the native projection
   pipeline stages into a `mkdtempSync(os.tmpdir())` dir, converts, copies, and **discards the temp dir**
   (`STAGED_DIRS` cleanup) — so there is no stable symlink target. Link-mode must point at the
   **persistent discovered bundle dir**, not a transient staging dir.

3. **The `gsd-` namespacing decision.** Claude projection applies `gsd-` prefixing. Link-mode therefore
   requires the canonical source to already be in **final (namespaced) form**, OR link-mode must
   **opt out of prefixing**. Either choice is fine — it just has to be decided so the symlink target and
   the projected name agree.

**Reference implementation (cite by name): the v2.3 driver in `bin/contrib-capability.cjs`.** It already
proves symlink-on-enable / unlink-on-disable in practice:

- `deliverBundledSkills` / `removeBundledSkills` — **directory** symlink mirrors (skills are dir
  symlinks; reclaim must `lstat` and unlink the link itself, not its contents).
- `deliverBundledCommands` / `removeBundledCommands` — the command-symlink helpers (sourced from the
  bundle's `commands/` dir via the same `/^gsd-.*\.md$/` filter the bundler + verifier use).

These carry the **T-17-02 safeties** that the upstream `surface.cjs` implementation would need:

- **T-17-02-CLOBBER** — never overwrite a real (non-symlink) file/dir at a delivery target; deliver
  fails safe rather than clobbering a user's real file.
- **T-17-02-OVERREMOVE** — on disable, reclaim **only** symlinks pointing into our bundle; a real
  file/dir or a foreign symlink at the target is left untouched.
- **T-17-02-REPOSOURCE** — source the artifacts from the bundle, not from an arbitrary path.

In short: the driver is a working reference for link-on-enable / unlink-on-disable with the two
clobber/over-remove safeties, against the persistent in-repo bundle — exactly what a native `link`
delivery mode would formalize.

---

## Ask (b) — A third-party slash-command overlay surface (the CMD-01 gap)

There is currently **no third-party slash-command overlay surface** for a feature capability to
contribute **agent-facing slash-commands** cross-runtime.

- The capability `commands[]` `{family, module, router}` field is for **first-party gsd-tools CLI
  subcommands** (invoked via `gsd_run`), validated by `validateCommandEntry` (which needs a `.cjs`
  module) — it is **not** an agent-facing slash-command surface. Evidence:
  **ADR-959** (`gsd-core/docs/adr/959-capability-command-contribution.md`) and
  `gsd-core/bin/lib/capability-loader.cjs:697`.
- Consequence today: the 5 `.md` prose slash-commands cannot be shaped into the `.cjs`
  `{family, module, router}` form without **mis-shaping** them, so they stay Claude-only (delivered by
  `.md` symlink) and cross-runtime slash-command support has to be escalated upstream. (Skills, by
  contrast, DO have a native third-party `skills` contribution and already ship cross-runtime.)

**Ask:** add a **third-party slash-command overlay surface** so a feature capability can contribute
agent-facing slash-commands **cross-runtime** — copy-convert for runtimes that need a dialect change,
and identity/link-mode where conversion is identity (Claude tier-1) — **without** forcing `.md` prose
commands into the `.cjs` CLI shape.

**Reference / gap (cite by name):** the **CMD-01 finding** (see `docs/cross-runtime-delivery-model.md`)
and design §10 gap 4. This is the **largest unknown** and should be **scoped before any reliance on
native command projection for non-Claude runtimes**. The 5 Claude-only `.md` commands the v2.3 driver
delivers by symlink are the concrete reference for what such an overlay would need to project.

---

> **STATUS (restated): CAPTURED, NOT filed this milestone.** Filing method (issue vs. issue + reference
> PR) and timing are decided later as a separate, deliberate act. No upstream gsd-core issue, PR, or push
> is performed by this milestone — the privacy / don't-touch-upstream constraint is honored.
