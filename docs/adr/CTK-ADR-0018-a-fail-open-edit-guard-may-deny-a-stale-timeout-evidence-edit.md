# CTK-ADR-0018: A fail-open edit guard may deny a stale timeout-evidence edit

- **Status:** Proposed (2026-11-20), implemented on the `gate-timeout-increase` branch (quick 261120-2a2). The
  gsd-contrib-toolkit orchestrator dispatched the build as a Tier A quick task; Dave has not reviewed the content of
  this record.
- **Review:** Published for maintainer review and open to revision. A changed decision will be recorded by a
  superseding or amending CTK-ADR, never by a silent edit to an accepted record.
- **Date:** 2026-11-20 (milestone v2.8).
- **Scope:** GSD Contribution Toolkit: `hooks/timeout-evidence-edit.cjs` (ENF-27) and its bundle copy, the one
  `PreToolUse` `Write|Edit|MultiEdit` registration in `settings.snippet.json` and `capability.json`, and the edit
  guard count category in `docs-hook-counts.test.cjs`. Every other gate, `hooks/binlib-edit.cjs`,
  `hooks/lib/failclosed.cjs` and `runGate` are unchanged.
- **Amends:** CTK-ADR-0001 Decision 2 (fail closed) and CTK-ADR-0001 Decision 3 (reuse LIVE), as narrowed by
  CTK-ADR-0005 Decision 3 (a toolkit-owned signal only beside a LIVE one, at a lower severity); CTK-ADR-0005
  Decision 2 (deny only with a measured near-zero false-positive rate) and CTK-ADR-0005 Decision 4 (a check that
  can deny fails closed); and CTK-ADR-0007 (a check that can deny never resolves an unobtainable input to allow).
  Each exception below is confined to the edit-guard class this record defines; for every other gate those
  clauses hold unchanged.
- **Relates to:** CTK-ADR-0017 (the fail-open read guard, whose output discipline this class reuses); gsd-core
  TESTING-STANDARDS.md "Every new or changed timeout constant states its evidence" (gsd-core #4689) and its
  `tests/helpers/timeouts.cjs` `TIMEOUT_EVIDENCE` data; gsd-core #6143, the one compliant upstream raise.

## Context

gsd-core requires every new or changed test timeout constant to state its evidence: the observed range, the
worst platform, the margin (the constant over the worst observation, at least 2x) and the source. In
`tests/helpers/timeouts.cjs` the evidence is data: each exported constant has a `TIMEOUT_EVIDENCE` entry, and a
comment that starts `Evidence (TIMEOUT_EVIDENCE.<NAME>):` restates it. Upstream CI
(`tests/timeout-evidence.test.cjs`) checks the entries against the values and never reads a comment. Reproduced
on a copy of origin/next de0eefe18: raising `PROBE_TIMEOUT_MS` from 15000 to 30000 with its comment still saying
`margin 2.02x` passes that test (34 pass, 0 fail); only a value below 2x the observation fails it. The validator
answers a state question (is this value at least 2x its entry); the gap is a before/after question (did this edit
leave the stated figures behind). No LIVE gsd-core script answers the second question, so a gate built under
CTK-ADR-0001 Decision 3 cannot exist for it.

A fail-closed gate on every `Write`, `Edit` and `MultiEdit` under gsd-core `tests/**` would take every test edit
offline on a hook fault, for a protected outcome that is a comment convention. The existing rules leave two
choices: a non-denying advisory, which leaves the gap open, or a new class.

## Decision

1. **The class.** An *edit guard* is a `PreToolUse` hook registered only on the `Write|Edit|MultiEdit` matcher and
   scoped by its own filter to gsd-core `tests/**` JS-family files. It judges the post-image of the edit (the file
   as it would be after the tool ran) statically, never loading or running it. It may deny an edit whose result it
   can show breaks a stated, arithmetic rule, with a reason that names a passing order.
2. **What ENF-27 denies (arm A).** In `tests/helpers/timeouts.cjs`, a top-level numeric constant listed in
   `module.exports` is judged when its value rises or when it is newly exported. It is denied when it has no
   `TIMEOUT_EVIDENCE` entry, or when its entry is `measured` with a positive literal `observedMaxMs` and its
   Evidence comment (bounded at the comment's end) lacks `worst observed <observedMaxMs>ms` (uncensored entries)
   or a first `margin <M>x` / `margin at least <M>x` equal to value / observedMaxMs rounded down to hundredths. A
   helper constant that `timeouts.cjs` re-exports is judged against that export's entry and comment. The guard
   checks only that the stated figures are arithmetically current with the entry; it cannot check that an
   observation is real, so a raise with a recomputed margin and no new measurement passes.
3. **A third output: the context-only arm (arm B).** For a raised or new file-local timeout constant elsewhere in
   `tests/**` whose comment names no evidence and no exempt kind, the guard emits `additionalContext` with no
   `permissionDecision`. It neither denies nor asks; it informs. The measured event population supports nothing
   stronger: replayed through the final guard, the 110 commits and 345 `tests/**` file changes since the evidence
   rule landed gave 5 flagged constants, all new names from one move of older constants and none a raise of an
   existing value, and 0 denies. A deny would have blocked that move.
4. **Silent pass, never an explicit allow or ask.** As in CTK-ADR-0017, every other path writes nothing and exits
   0, and only a `deny` with a non-empty reason or an `additionalContext` with no decision produces output. `ask`
   is no middle ground here either: CTK-ADR-0017 recorded that it degrades to allow under bypass mode and denies
   in a `-p` run, and interactive Orca workers stalled at hook prompts (2026-10-06). Neither path
   adds a check, so the guard never emits it.
5. **Fail open.** Any error or undecidable input (malformed payload, no gsd-core root, a filesystem error, a
   non-regular or oversized file, a module that fails to load) is a silent pass. So is format drift: a
   `TIMEOUT_EVIDENCE` literal the parser cannot read in full (spread-built, a quoted or computed key, empty or
   missing), because a deny there could name an entry the file already has and could not be satisfied. This
   amends CTK-ADR-0001 Decision 2, CTK-ADR-0005 Decision 4 and CTK-ADR-0007 for this class only.
6. **A toolkit-owned signal alone may deny.** CTK-ADR-0001 Decision 3, as narrowed by CTK-ADR-0005 Decision 3,
   lets a toolkit-owned signal run only beside a LIVE one at a lower severity. ENF-27 denies on a toolkit-owned
   signal alone, because no LIVE signal answers a before/after question (Context). The guard does not reimplement
   the LIVE validator and does not call it; it reads the same data upstream CI reads and adds a check upstream has
   none for.
7. **The false-positive bar, waived with this record's own reason.** CTK-ADR-0005 Decision 2 asks for a measured
   near-zero false-positive rate before a deny. No rate over real edits was measured, and the upstream population
   is too small for one. What was measured is structural agreement: replaying every `timeouts.cjs` and
   `git-fixture.cjs` snapshot since the evidence landing (5 snapshots, 90 constant judgements, each constant treated
   as new) and the 3 consecutive before/after pairs gave 0 denies, and the #6143 post-image with its comment hunk
   reverted denied. That is agreement with every compliant upstream state, not a false-positive rate. The bar is
   waived for this class because ENF-27 does deny an edit, but every deny names a passing order (entry and
   comment first, then the value, or all in one Write or MultiEdit; a comment-only or evidence-only edit is never
   denied), so a false deny costs one edit, and every error fails open. CTK-ADR-0017's reason (a deny that blocks
   no outcome) does not apply here and is not borrowed.

## Consequences

- **Coverage is Write, Edit and MultiEdit only** (MultiEdit where the client offers it), on gsd-core `tests/**`.
  Bash (`sed`, a heredoc, `cp`), NotebookEdit and `git apply` are not seen. Also not covered: a call-site swap to a
  larger existing constant (#6143 did this, compliantly); an identifier at a call site; an imported identifier in
  `timeouts.cjs`; a new helper constant re-exported through a new destructure; an entry kind changed from measured
  to an exempt kind; an entry-only change that leaves the comment stale (CI checks the 2x floor); a non-exported
  constant in `timeouts.cjs`; Claude Code's fuzzy quote matching on Edit; production `src/` and `bin/` timeouts.
  Upstream relies on code review for these, and the guard removes no review. Two parse limits fail open: a
  right-hand side that starts on the next line is unresolved and trusted, and a MultiEdit with more than 200 edits
  passes silently.
- **First tag occurrence.** The Evidence comment is read from the first occurrence of its
  `Evidence (TIMEOUT_EVIDENCE.<NAME>):` tag. An earlier mention of the same tag text (none upstream today) would be
  read instead of the comment above the declaration and could cause a false deny until that mention is edited.
- **Known false denies.** A value edited before its entry or comment, and correct figures in other wording. The
  reason answers both: it names the passing order and the exact accepted forms.
- **Arm B is advisory and weak.** Its evidence words can be satisfied by a comment with no real evidence, and its
  rise rule (above every baseline value of the same name) misses a raise of the smaller of two same-name locals.
- **Format dependence.** Arm A reads upstream's current shapes (line-start entry keys, the Evidence tag, a
  `module.exports = {` object). A live test over the gsd-core clone's origin/next turns red when those shapes
  change; without the clone that test skips, and a changed shape fails open as a silent pass.
- **Counts.** The documented "fail-closed `PreToolUse` gates" stay the Bash, Write|Edit and EnterWorktree gates;
  the edit guard is its own category beside the read guard, and every "can deny" sentence names it.
- **Timeout.** A `PreToolUse` command hook that Claude Code cancels at its timeout does not block the call, so a
  hung guard also passes; the guard reads at most two bounded files and spawns nothing.

## Alternatives considered

- **Call the LIVE validator** (CTK-ADR-0001 Decision 3): rejected, it answers whether a value clears 2x its entry,
  and the stale-comment raise clears it.
- **Fail closed like binlib-edit**: rejected, a hook fault would block every gsd-core test edit for a comment
  convention.
- **Advisory only, also for timeouts.cjs**: rejected, the measured gap (a stale comment merged green) is the
  outcome the guard exists to stop, and a deny with a passing order costs one edit.
- **Deny or ask in arm B**: rejected, the only observed event class is a move of older constants, which a deny
  would block and an ask would either wave through or stall.
- **Compare old and new strings with a typed confirmation phrase** (a published prior-art guard): rejected, it
  fails closed on the transcript and judges fragments; this guard judges the post-image and needs no phrase.
