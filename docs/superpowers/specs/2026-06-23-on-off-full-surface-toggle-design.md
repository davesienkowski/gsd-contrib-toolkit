# Design — `on`/`off` as the Full-Surface Toggle (+ Cross-Runtime Delivery)

**Date:** 2026-06-23
**Status:** Approved design (brainstorming output) — ready for GSD planning
**Author:** Dave + Claude
**Builds on:** `2026-06-22-toolkit-toggleable-capability-design.md` (the toggleable-capability foundation)
**Supersedes:** §9 of that spec (`install.sh` slim-down) — `install.sh` is now **retired**, not slimmed.

---

## 1. Problem

Today the `contribution-toolkit` capability separates **enforcement** from **availability**:

- `on`/`off` toggle only the hooks (the CAP_MARKER-tagged gates in `settings.json`) and the
  `workflow.gsd_contrib_enforcement` flag.
- The **5 commands** are tied to the `install`/`remove` lifecycle (delivered by `install`, reclaimed by
  `remove`) — see the documented "LIFECYCLE TIE DECISION" in `bin/contrib-capability.cjs`.
- The **2 skills** are not handled by the driver at all; they are symlinked only by `install.sh`.

Consequence: turning the capability **off** leaves both skills and all five commands installed and usable,
and `install.sh` can silently re-add links after an `off`. The desired behavior is: **`off` deactivates
the entire surface (hooks + commands + skills); `on` restores all of it; `install` lands fully ON.**

## 2. Goal

Redefine `on`/`off` as the **full-surface** activate/deactivate for the whole capability, and make the
capability a properly distributable, **cross-runtime** GSD capability — without losing the symlink-based
containment, edit-live workflow, and harness enforcement that define the toolkit.

`install` ⇒ fully ON. `off` ⇒ everything deactivated but **re-activatable** (ledger/consent/bundle
preserved). `remove` ⇒ permanent teardown.

## 3. Core constraint that shapes everything

Symlink delivery preserves containment/edit-live but is **only physically possible where artifact
conversion is identity** — i.e. the Claude Code runtime (canonical format == runtime dialect). Other
runtimes (Codex, OpenCode, CodeBuddy, …) require the framework to **convert** skills/commands into their
dialect, which mandates **copy-convert** (you cannot symlink a file that must be transformed).

Additionally, the toolkit's load-bearing value — **PreToolUse deny enforcement** — is a **Claude Code
harness feature**. The gsd-core runtime registry shows non-Claude runtimes have no PreToolUse-deny
surface (e.g. Copilot "no hook events," OpenCode "no lifecycle hook registration"). So enforcement
**cannot** exist on those runtimes regardless of delivery form. This matches the manifest's existing
honesty language ("advisory-only … that property belongs to those [Claude] hooks").

## 4. Decision — per-runtime hybrid delivery

| Layer | Claude | Codex / OpenCode / others |
|---|---|---|
| Skills + commands | **symlink** (containment, edit-live, byte-control) | **copy-convert** (dialect-translated) |
| PreToolUse enforcement | **full** | **none** → toolkit runs **advisory-only** |

This is not a fork — it is per-runtime. Claude gets symlink + full enforcement; other runtimes get a
converted copy of the skills/commands running advisory-only (the honest ceiling there). Cross-runtime
support is preserved because non-Claude runtimes keep working via the framework's existing copy-convert.

## 5. Lifecycle semantics (the behavior change)

| Command | Hooks | Commands | Skills | Ledger / consent |
|---|---|---|---|---|
| `install` | apply + **enable** (flag on) | deliver | **deliver** | record |
| `on` | apply | deliver | deliver | — |
| `off` | strip | **reclaim** | **reclaim** | **preserved** (re-activatable) |
| `remove` | strip | reclaim | reclaim | drop + revoke |

Key shifts vs. today:
- `install` lands **fully ON** (flips `workflow.gsd_contrib_enforcement` to true). This overrides the
  current "install leaves config default OFF" behavior.
- `on` now **delivers** commands + skills (in addition to applying gates).
- `off` now **reclaims** commands + skills (in addition to stripping gates), under the existing
  accountability-receipt flow.
- `off` vs `remove`: "deactivate, keep re-activatable" vs "permanent teardown."

## 6. Components — Track 2 (build now, this repo)

The driver becomes the single authority for all delivery; `install.sh` is retired.

1. **`deliverBundledSkills` / `removeBundledSkills`** in `bin/contrib-capability.cjs` — mirror the
   existing `deliverBundledCommands` / `removeBundledCommands`, but for **directory** symlinks (skills are
   directories, commands are files). Sourced from the bundle (`capabilities/contribution-toolkit/skills/`)
   per the existing T-17-02-REPOSOURCE pattern. Resolve the runtime skills dir as
   `${CLAUDE_DIR:-~/.claude}/skills`, mirroring `claudeCommandsDir`.
2. **`runInstall` / `runOn` / `runOff` / `runRemove`** rewired:
   - `runInstall`: deliver commands + skills, then set `workflow.gsd_contrib_enforcement = true`.
   - `runOn`: apply gates + deliver commands + skills + flag on.
   - `runOff`: probe receipt → strip gates → reclaim commands + skills → flag off → write receipt. All
     reclaim happens **after** the strip and **under** the same append-only receipt (preserves the
     "a disable that cannot be logged mutates nothing" invariant).
   - `runRemove`: unchanged teardown + reclaim commands + skills (already reclaims commands).
3. **Retire `install.sh`** — delete it; document `node bin/contrib-capability.cjs install` as the sole
   entrypoint. Update the root README and any references. (Supersedes the §9 slim-down from the prior
   spec.) The driver's `install` being idempotent + fully-ON replaces install.sh's re-runnable-repair
   role.
4. **Advisory-degradation surfacing** — on non-Claude runtimes, the delivered skills/commands carry a
   clear banner: "PreToolUse enforcement is unavailable on this runtime; the contribution toolkit runs
   advisory-only here." Mechanism resolved in planning (e.g. a converted-artifact header injected at
   copy-convert time, or a runtime-detected note) — must be surfaced to the user, not docs-only.
5. **`capability.json` title casing** — `"GSD contribution toolkit"` → `"GSD Contribution Toolkit"`.

## 7. Safeties (reuse, extended to skill dir-symlinks)

Both existing fail-safes extend to skills:
- **Never clobber a real file/dir** (T-17-02-CLOBBER) — a real file or directory at a skill target is
  never overwritten; the operation fails loud.
- **Only reclaim symlinks pointing into our bundle** (T-17-02-OVERREMOVE) — a foreign symlink or a real
  dir at a skill target is left untouched on reclaim.

Skills are directory symlinks, so reclaim must `lstat` and unlink the **link** (never recurse into a
followed target). The `off` writability-probe and append-only receipt are unchanged.

## 8. Documentation

A dedicated **`docs/`** addition explaining how the capability works across runtimes:
- The per-runtime behavior matrix (§4) and the symlink-vs-copy-convert model (§3).
- Why enforcement is Claude-only and what "advisory-only" means on other runtimes.
- The lifecycle semantics (§5) and the `off` vs `remove` distinction.

**READMEs** brought to consistent GitHub best-practices formatting (proper punctuation, title case),
with the root `README.md` and a **new** `capabilities/contribution-toolkit/README.md` sharing the same
voice/structure (a distributable capability needs its own README). The bundle README is the
publish-facing one; the root README is the repo/dev-facing one; they should read consistently.

## 9. Testing

Extend/repurpose the existing suites to assert the **new** lifecycle (the current tests encode the old
split and must move with the change):

- `install-delivers-skills.test.cjs` / `install-delivers-commands.test.cjs` — install delivers both;
  `on` redelivers both.
- `offramp-presence.test.cjs` — `off` reclaims both; round-trip `off`→`on` restores both.
- Clobber / over-remove safeties exercised on **directory** symlinks (skills), not just file symlinks.
- `install` lands fully ON (flag true) assertion.
- `verify-capability.test.cjs` updated for the title-casing + any manifest changes.
- `self-test.cjs` integrates the new checks.

All on disposable sandboxes (mkdtemp; `CLAUDE_DIR`/`commandsDir`/`skillsDir` injection) — no real
`~/.claude` or gsd-core settings mutated.

## 10. Track 1 — upstream feature request to trek-e (captured here, filed later)

To eventually run the full **stock** `gsd capability install/enable/disable` + `/gsd-surface` lifecycle
with symlink delivery, the capability framework needs additions. Captured now; filing method (issue vs
issue+reference-PR) decided when we file. Track 2's driver code is the reference implementation.

Gaps identified in LIVE gsd-core:
1. **Opt-in `link` (symlink) delivery mode** for `skills`/`commands`/`agents`, default `copy` for
   back-compat. Valid **only where conversion is identity** (Claude tier-1); runtimes needing conversion
   fall back to copy. Enable/disable = symlink-on-enable / unlink-on-disable via `surface.cjs`, carrying
   the two safeties from §7.
2. **A persistent canonical bundle target** for the symlink. Today the projection pipeline stages into a
   `mkdtempSync(os.tmpdir())` dir, converts, copies, and discards the temp dir (`STAGED_DIRS` cleanup) —
   so there is no stable symlink target. Link-mode must point at the persistent discovered bundle dir.
3. **Namespacing decision** — Claude projection applies `gsd-` prefixing. Link-mode requires the
   canonical source already in final (namespaced) form, or link-mode opts out of prefixing.
4. **`.md` prose-command projection** — the 5 commands are `.md` files that do not fit the native
   `validateCommandEntry` `{family, module, router}` shape (which needs a `.cjs` module), so they are
   currently disclosed in prose, not a `commands[]` array. For the framework to project commands
   cross-runtime (copy-convert) and under link-mode, it needs native support for `.md` prose commands
   (or the commands must be restructured to the `.cjs` shape). This is the largest unknown and should be
   scoped before any reliance on native command projection for non-Claude runtimes.

Until Track 1 lands, Track 2's driver provides the full-surface toggle on Claude with symlinks, and the
framework's existing copy-convert provides cross-runtime skill delivery.

## 11. Constraints honored

- **Containment:** Claude delivery stays symlink-back-to-repo; the driver remains the single authority;
  retiring `install.sh` removes the silent-re-add path rather than adding a competing one.
- **Reuse-LIVE:** hooks continue via the LIVE `applyCapabilitySharedEdits` engine; cross-runtime skill
  delivery uses the framework's copy-convert; Track 1 contributes upstream rather than forking.
- **Honesty:** enforcement is Claude-only and labeled as such; non-Claude runtimes are surfaced as
  advisory-only; the capability is never labeled "unbypassable."
- **Privacy:** bundle + driver live in this repo; nothing committed/pushed upstream gsd-core (the Track 1
  feature request, when filed, is a separate, deliberate act).

## 12. Out of scope / deferred

- Filing the Track 1 feature request (captured here; filed later, method TBD).
- Restructuring the 5 `.md` commands into the native `.cjs` `{family, module, router}` shape (only needed
  if/when native command projection is pursued).
- Global-scope (`~/.gsd/capabilities/`) install — project-scope only.
- Publishing to an external registry / URL importer.

## 13. Suggested delivery

A GSD phase (or small milestone) with roughly:
1. `deliverBundledSkills` / `removeBundledSkills` + driver rewire (`install`/`on`/`off`/`remove`) + tests.
2. Retire `install.sh` + update references.
3. Advisory-degradation surfacing on non-Claude runtimes.
4. Docs directory + README polish (root + bundle) + `capability.json` title casing.
5. Capture the Track 1 feature request as a tracked artifact for later filing.
