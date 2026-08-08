# DESIGN: gsd-refresh - keep the global gsd-core install on latest `next`, mods intact

Status: exploration output (2026-08-07). Not yet built. Build home: gsd-contrib-toolkit.
Author loop: /gsd-explore session, then adversarial + Artificer review folded in.

This one file covers all four requested outputs:
- Section 1-2: the design decision record + architecture
- Section 3: the "verify stale mods now" result (executed, read-only)
- Section 4: the Artificer + adversarial review (and how it changed the design)
- Section 5: the phased build plan (the todo)
- Section 6: the feasibility spike (GO/NO-GO gates)

--------------------------------------------------------------------------------

## 1. The problem, and what changed

Goal: one low-friction, frequently-run action that (a) brings the global WSL install
(`~/.claude/gsd-core` + agents/skills/hooks) to the canonical `origin/next` tip, and
(b) preserves local modifications and re-applies them accurately afterward.

What "recently changed": the symlink edge-layout is gone. `~/.claude/gsd-core` used to be
a symlink to a swappable `gsd-core-next-edge` sibling (hot-swap). As of 2026-08-05 it is a
plain directory with no siblings, so the old hot-swap trick no longer exists.

Two half-solutions coexist today, neither owns the whole job:
- `gsd-contrib-toolkit/bin/runtime-sync.cjs sync` does the INSTALL (clone origin/next ->
  npm ci -> build:lib -> install.js -> ENF-21 stamp) but silently reverts every local mod.
- `~/.gsd/local-mods/*.sh` scripts do the RE-APPLY but are manual, default to dry-run, need
  a session restart to take effect, and re-derive each edit imperatively.

Current live mod state (measured 2026-08-07, `audit-local-mods.sh`): 12 modified + 3 missing
= 15 local mods. Three re-apply scripts exist: grant-memtrace-to-agents.sh,
remove-mempalace.sh, j2-dispatch-event-schema-version.sh.

## 2. Decisions (from the explore session)

D1. SOURCE = canonical `origin/next` tip. Keep runtime-sync's fresh-clone philosophy
    (never the local checkout, never the npm-published package). Rationale in
    runtime-sync.cjs header: npm is behind next; the local checkout's bin/lib is stale.

D2. MOD STRATEGY = both, layered. Shrink the mod surface by converting what CAN be
    installer-native, AND keep a declarative, verified path for the irreducible residue.
    Three classes:

    | Class | Files today | Native target | Stale handling |
    |-------|-------------|---------------|----------------|
    | A grants   | 10 agent `tools:` edits | local capability (adds tools, edits nothing) | regenerated fresh each run -> cannot go stale |
    | B deletions| 3 mempalace files       | install profile / post-install exclusion list | regenerated fresh each run -> cannot go stale |
    | C raw patch| 2 bin/lib J2 files (+ future) | declarative patch tracked by gsd-patch | blob-check vs fresh build -> FLAG if absorbed |

D3. TRIGGER = read-only SessionStart nudge + one explicit mutate command. The nudge only
    CHECKS drift and prints a reminder. `gsd-refresh` is the only thing that mutates, and it
    ends by prompting a restart. Rationale (runtime-sync header D-08): a hook runs under a
    ~120s harness timeout that a real reinstall overruns; mutating mid-`gh pr create` is
    invisible and irreversible; a failed reinstall re-fires on every later command. Also,
    agent/skill/hook definitions load at session start, so a mid-session mutate is not live
    until restart anyway.

D4. STALE-MOD HANDLING = two-tier by class. Classes A and B are regenerated declaratively
    every run, so they cannot go stale. Class C raw patches are blob-checked against the
    freshly-synced build; if upstream now ships the change, FLAG for human confirmation
    before dropping (never silently regress a file).

## 3. Verify stale mods now - RESULT (executed read-only, 2026-08-07)

Finding: the 2 bin/lib mods are a LIVE local candidate patch, NOT stale residue. They must
be preserved. This overturns a prior memory note that said they "landed upstream."

Three-way hash proof (sha256, first 16 chars):

    command-routing-hub.cjs   installed 4e2e3fc716a5d064
                              repo-build 5c3d4e54c3eb0dee
                              manifest   5c3d4e54c3eb0dee   (repo-build == manifest)
    observability/event.cjs   installed d990d52dae36d68c
                              repo-build c3595929b827ab0e
                              manifest   c3595929b827ab0e   (repo-build == manifest)

The installed files carry `__J2_LOCAL_SCHEMA_VERSION__`, `DISPATCH_EVENT_SCHEMA_VERSION`,
and `durationMs` markers citing ADR-2619, applied by j2-dispatch-event-schema-version.sh.
The current origin/next build (repo-build) lacks them and equals the 1.9.1 manifest. So the
divergence is Dave's, not upstream's -> keep, do not retire.

Design consequence: bin/lib is gitignored (tsc-emitted from src/*.cts), so Class-C
blob-archaeology cannot `git show origin/next:gsd-core/bin/lib/...`. The correct absorbed
check compares the patched installed file against the freshly-synced build (which `sync`
already produces): identical post-sync -> upstream absorbed it -> safe to retire. That
check is free inside the sync flow.

Open lifecycle question this raises: is J2 a permanent personal divergence, or a candidate
pending an upstream PR? If pending, track it with its issue/PR number so the absorbed-check
auto-retires it the moment it lands. See Section 5, Phase 3.

## 4. Adversarial + Artificer review (folded back into the design)

### 4a. Artificer laws that fired

Greenspun's Tenth Rule (strongest hit). A new `mods.json` + anchor-hash apply engine would
be a homegrown patch DSL. But that engine ALREADY EXISTS: `gsd-patch` (Dave's own tool) does
anchor-hash-asserted transforms, tracks stock bytes, refuses symlinked / RUNTIME_ROOT
targets, and has list/on/off/diff/verify/rebaseline. It is only scoped to hooks/settings
today. CORRECTION: do not build Layer 2 from scratch - extend gsd-patch to also target
agents/ and the payload. This collapses the "most surface to build" cost of the layered plan.

Gall's Law (strong). "Both, layered" with 3 classes + capability + profile + engine + nudge
hook is a complex system built at once. Gall: a working complex system evolves from a working
simple one. The simple working version already exists (sync + 3 scripts). CORRECTION: ship a
thin orchestrator FIRST that chains what already works, then strangler-fig each class into a
native form. Do not build the native conversions in v1.

Hyrum's Law (strong). The design depends on observable, non-contract behaviors of gsd-core:
the exact agent `tools:` line shape (grant anchor), install.js path-baking + slash transforms,
ENF-21 digest scope, the manifest format/location. Any upstream refactor silently breaks an
anchor. Mitigations already aligned: anchor-hash asserts fail loud (HALT beats half-apply).
Reinforced: converting Class A grants to a capability REMOVES the agent-file-shape dependency
entirely (capability is a supported contract) - another reason "need fewer" wins long-term.

Leaky Abstractions (strong). `gsd-refresh` promises "one command, install stays correct," but
install.js is not a byte-copy: it bakes the config-dir path and rewrites `/gsd:` to `/gsd-`
(runtime-sync header D-13). So a naive byte-hash cannot confirm an install. Verify at the
level the installer works: manifest hashes are stamped post-install (audit-local-mods already
uses them correctly), and the absorbed-check compares against the post-sync build, not raw
upstream bytes. Rule: fail loud and visibly when a mod did not land; never report a silent
success.

Supporting: choose-boring-technology (reuse runtime-sync + gsd-patch = boring and proven -
good); zawinski's-law (resist scope creep - the scheduled-cache trigger option was correctly
rejected; keep resisting).

### 4b. Adversarial red-team (gaps not in the original design)

A. Restart is not enforceable. gsd-refresh prompts a restart but cannot make Dave restart.
   If he keeps working, new install + old in-memory agents = split-brain session. FIX: write
   a "restart-required" sentinel; the SessionStart nudge nags until the runtime SHA in memory
   matches on-disk. Idempotent re-nudge.

B. No rollback, and the source is `next` (not a release). A broken tip installs a broken
   global runtime affecting every project. "Run often" multiplies the odds of catching a bad
   tip. FIX (v1, required): snapshot `~/.claude/gsd-core` + agents/skills/hooks before sync;
   `gsd-refresh --rollback` restores the snapshot. This is the biggest missing piece.

C. The nudge adds session-start cost and noise (Dave's SessionStart surface is already
   crowded). "N days behind" is a weak signal. FIX: cheapest possible check - one
   `git ls-remote origin next` for the tip SHA vs a cached last-installed SHA, rate-limited
   to once/day; no clone at startup. Signal = behind-by-SHA, optionally behind-by-N-commits.

D. Class A -> capability may not be behavior-identical. Can a capability ADD tools to an
   already-shipped agent, or only to capability-owned agents? If it cannot augment a shipped
   agent's tool list, Class A stays a patch. This is a GO/NO-GO gate (Section 6), not an
   assumption.

E. Class B -> profile may not support exclusion. Install profiles are core/standard/full
   budget tiers; they bound the skill surface but may not express "install all EXCEPT
   mempalace." If not, deletions stay a declarative post-install rm list applied by the
   orchestrator. Do not assume profile exclusion exists (Section 6 gate).

F. J2 patch sits on a generated file and may be pending-upstream. See Section 3 lifecycle
   question. Track candidate patches with an issue/PR number so the absorbed-check retires
   them on merge.

G. audit-as-assertion needs a declared expected set. To turn audit-local-mods from a report
   into a gate, it needs a baseline ("expect exactly these mods"). That baseline IS the
   gsd-patch state + the class A/B declarations. gsd-patch already has `rebaseline` - reuse it.

### 4c. Net effect of the review

The plan shifts from "build a big new layered tool" to "thinly orchestrate what already
works, add a snapshot, and evolve toward native." Concretely:
- Do NOT build a new manifest engine. Extend gsd-patch (Greenspun).
- Ship the thin orchestrator first; evolve classes to native later (Gall / strangler-fig).
- Add pre-sync snapshot + rollback to v1 (adversarial B) - newly required.
- Nudge = cheap SHA compare, rate-limited, no startup clone (adversarial C).
- Capability + profile conversions are GO/NO-GO spikes, not assumptions (D/E).
- Distinguish permanent mods from pending-upstream candidates; absorbed-check vs fresh build
  (F, Section 3).

## 5. Phased build plan (the todo)

Build in gsd-contrib-toolkit. Each phase ships a working tool (Gall). Do not start Phase 2/3
before Phase 1 is in daily use.

Phase 1 - thin orchestrator + safety net (MVP, highest value, lowest risk)
- [ ] `gsd-refresh` command that: snapshots the current install (B), runs
      `runtime-sync.cjs sync`, then runs the 3 existing re-apply scripts with `--apply`
      (grant-memtrace, remove-mempalace, j2), then runs audit-local-mods as an ASSERTION
      against the expected set, then prints a restart instruction + writes a restart sentinel.
- [ ] `gsd-refresh --rollback` restores the pre-sync snapshot.
- [ ] Assertion fails loud if any expected mod did not land (leaky-abstractions rule).
- Value: removes the dry-run-by-default and forgot-a-script footguns immediately, with zero
  new engine and full rollback. This alone solves 80 percent of the pain.

Phase 2 - trigger nudge
- [ ] SessionStart hook: `git ls-remote origin next` vs cached last-installed SHA, once/day,
      read-only, prints "runtime N behind - run gsd-refresh" and nags until the restart
      sentinel clears. No clone, no mutate.

Phase 3 - shrink the surface (strangler-fig, only after Phase 1 is trusted)
- [ ] Class A: spike then (if GO) convert 10 grants to a local capability; delete
      grant-memtrace script once sync re-emits the grants natively.
- [ ] Class B: spike then convert mempalace deletions to a profile OR a declarative
      exclusion list owned by the orchestrator; delete remove-mempalace script.
- [ ] Class C: register the J2 patch with gsd-patch (extended to payload/agents), tracked
      with its issue/PR number; add the absorbed-check (installed vs post-sync build) so it
      auto-flags for retirement when it lands upstream.
- [ ] Retire the imperative scripts one at a time as each class goes native.

## 6. Feasibility spike (GO/NO-GO gates)

Primary unknown: can Class A grants become a clean local capability without tripping ENF-21
or the profile-closure lint, AND actually augment already-shipped agents' tool lists?

Gate A1 (capability tool-augmentation): does `gsd-tools capability install <local> --scope
global` allow a capability to ADD `mcp__memtrace__*` tools to the 10 SHIPPED agents, or only
to capability-owned agents? Test: build a throwaway local capability that declares the grant,
install to a scratch --config-dir, inspect the installed agent files. GO if the shipped
agents gain the tools. NO-GO -> Class A stays a gsd-patch target.

Gate A2 (ENF-21 safety): confirm the capability route does not move the ENF-21 digest.
Expected safe: digest covers only gsd-core/{workflows,references,templates,contexts};
agents/ is outside it (per memory + runtime-stamp.cjs:162). Verify empirically.

Gate A3 (profile-closure lint): confirm a local capability adding agent grants passes
`lint:skill-deps` profile closure. If it fails, the grant must ship outside profile scope.

Gate B1 (deletion via profile): can any install profile express "exclude mempalace," or must
deletions be a post-install rm? Inspect install-profiles.cts. Likely NO-GO -> declarative
exclusion list in the orchestrator (still fine; regenerated each run).

Gate C1 (gsd-patch payload scope): gsd-patch currently refuses RUNTIME_ROOT targets and is
scoped to hooks/settings. Extending it to agents/ is safe (outside ENF-21). Extending it to
payload (workflows/references/templates/contexts) or bin/lib WOULD touch RUNTIME_ROOT and
trip ENF-21 - so Class C for a bin/lib file cannot use gsd-patch's RUNTIME_ROOT refusal as-is.
Decide: either (i) keep bin/lib patches as a post-sync re-apply step in the orchestrator (like
today's j2 script, just chained), or (ii) give gsd-patch a distinct "post-install payload
patch" mode that re-applies AFTER sync and accepts the drift verdict. Recommend (i) for v1.

Decision rule: if A1 is NO-GO, Class A stays imperative and Phase 3 shrinks to Class C only.
The Phase 1 MVP does not depend on ANY gate - it ships regardless.
