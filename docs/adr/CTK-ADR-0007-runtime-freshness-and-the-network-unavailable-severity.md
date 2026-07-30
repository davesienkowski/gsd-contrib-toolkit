# CTK-ADR-0007: Gate on runtime freshness, and resolve an unobtainable upstream tip to `ask`

- **Status:** Accepted
- **Review:** Published for maintainer review and open to revision — a changed decision will be recorded
  by a superseding/amending CTK-ADR, never a silent edit to this record.
- **Date:** 2026-07-30 (milestone v2.7+)
- **Scope:** GSD Contribution Toolkit.
- **Amends:** CTK-ADR-0005 §Decision.4 ("a lower-severity check inside a fail-closed gate fails
  OPEN"), which admitted a scoped exception to HARD-01 **only** for a check that *cannot* deny. This
  record narrows that further: a check that *can* deny, whose input is *unobtainable*, resolves to
  `ask` — the third severity CTK-ADR-0005 itself introduced — and never to `allow`. Neither record is
  withdrawn.
- **Relates to:** ENF-21 (`hooks/runtime-drift.cjs`), the first gate whose verdict depends on network
  state; CTK-ADR-0001 §Decision.2 (HARD-01 fail-closed) and §Decision.3 (reuse LIVE, never
  reimplement); CTK-ADR-0006 §Decision.8 (gate on `hasGovernedSegment`, never the chain aggregate).

## Context

Nothing in the toolkit could tell whether the gsd-core engine it runs against is current.

The engine that matters is the **globally installed runtime** at `~/.claude/gsd-core` — a copy of the
published package that gsd-core's own installer replaces wholesale on every install. It is not
`~/repos/gsd-core`, and it does not appear in any `git log` a contributor reads. A contribution
reviewed or filed against a stale runtime produces two specific failures, both of which look like
success at the time:

1. **"Reproduced locally" stops meaning anything.** The contribution skill's Phase 1 and Phase 3d run
   against whatever is installed. If that is behind `next`, the reproduction and the suite results
   describe an engine the merge queue no longer has.
2. **The fix may already be upstream.** Filing it costs a maintainer a triage cycle to close as
   already-fixed — the exact cost this toolkit exists to avoid imposing.

Four candidate oracles were examined before the one below was chosen; three are recorded as rejected
in *Alternatives considered*, because each is the obvious thing to reach for and each is wrong in a
way that is not visible until you measure it.

The load-bearing measurement: **the runtime's `VERSION` file cannot answer the question.** gsd-core's
installer writes it as `fs.writeFileSync(versionDest, pkg.version)` (`bin/install.js:11023`) — the
plain package version, with no commit SHA. Two different `next` commits published under one package
version are indistinguishable there. (The `1.8.0+edge-probe (4f6935e2)` string present on this machine
when ENF-21 was built was hand-typed, is not reproducible, and is erased by the next reinstall.)

## Decision

1. **The oracle is a toolkit-owned, digest-bound stamp — not `VERSION`, and not inside the runtime.**
   `~/.gsd-contrib/runtime-stamp.json` records the `origin/next` SHA the runtime corresponds to. It
   lives **outside** `~/.claude/gsd-core` because a reinstall replaces that tree wholesale, and beside
   the existing OBS-01 user-level state (`tool-log.jsonl`) rather than in a per-worktree directory
   that GSD's worktree cleanup deletes.

   Living outside the tree it describes creates its own failure: a **foreign** reinstall (the user, or
   any other tool, running `npx @opengsd/gsd-core@latest --claude`) replaces the runtime without
   touching our stamp, and the stamp then silently lies. So the stamp also records a sha256 over the
   whole installed tree, and every read **recomputes and compares** it. A mismatch is verdict
   `unverified`, which is a DENY. An unbound stamp would have been worse than no stamp, because it
   would have looked authoritative.

2. **Network-unavailable resolves to `ask` — never `deny`, never a silent `allow`.**
   This is the one deviation from the fail-closed floor, and it is deliberately narrow: it applies
   **only** when `git ls-remote` fails **and** no cached tip exists inside the 24 h staleness budget.
   The `catch` is wrapped around the tip resolution alone, not the gate, so a digest failure or a
   malformed stamp cannot leak into it. Four reasons:

   1. CTK-ADR-0005 §4 already narrowed HARD-01 to let a sub-check that *cannot* deny fail open. This
      is one rung sharper — a sub-check that *can* deny, whose input is unobtainable — and it resolves
      to `ask`, the severity CTK-ADR-0005 itself introduced, not to `allow`.
   2. `ask` is only ever produced by a **deliberate return**. `failclosed.cjs` still collapses a
      throw, an empty decision, and any unrecognized value to `deny`, asserted byte-for-byte in
      `failclosed.test.cjs`. Teaching this gate to `ask` does not soften the floor for any other gate.
   3. **Staleness is a correctness risk, not a containment risk.** Every other gate in the suite
      reaches its verdict from local state. Denying here on an unreachable network would take the
      *whole* suite offline with the ISP — the exact failure mode CTK-ADR-0005 names ("one gate's
      misfire takes the whole suite offline"). An outage must not make gsd-core un-fileable.
   4. **Recorded honesty limit:** `ask` degrades to `allow` under `--dangerously-skip-permissions`
      and in any unattended run. This is the same accepted limit ENF-11's advisory carries (quick task
      260729-p3f). It is stated in the gate's module header and in its own reason string. Do not
      describe this path as blocking.

   A **malformed** `ls-remote` response is explicitly NOT an outage. The remote's output is
   remote-controlled input that steers a deny/allow, so only a line of exactly
   `<40-hex>\trefs/heads/next` is accepted; anything else throws `FailClosed` and is never rescued by
   the cache and never degraded to `ask`.

3. **The remediation is deliberately NOT in the hook.** `PreToolUse` hooks run under a harness
   timeout (the suite's current maximum is 120 s) and a real reinstall is `npm ci` + `install.js` —
   routinely longer. Worse, an in-hook reinstall would rewrite the user's global install in the middle
   of a `gh pr create`, invisibly and irreversibly, and a *failing* reinstall would re-fire on every
   subsequent governed command.

   "Automatic" is instead satisfied on two surfaces where mutation is visible, early, and
   reversible-by-rerun: **`node bin/runtime-sync.cjs sync`** is a single command with no prompts and
   no decisions, and the **RT0 step in both skills runs it for you** on any non-`fresh` verdict without
   asking. In the normal flow the user types nothing. The gate's deny reason quotes the same command
   verbatim, from the shared `REMEDIATION_COMMAND` constant, so the instruction cannot diverge across
   surfaces.

4. **Recorded gap: the review-side verbs are advisory-only.** ENF-21 governs exactly three actions —
   `issue-create`, `pr-create`, `push` — the filing/pushing surface. `pr-review` and `pr-merge` are
   **not** gated: they are the charter-adjacent surface, not the filing surface the requirement
   scoped. Their only runtime-freshness coverage is the RT0 step in `maintainer-review-sweep`, which
   is a discipline step, not a floor. Nothing stops a maintainer re-reviewing on a stale engine. This
   is a deliberate non-gate; widening it is a decision to record, not a bug to fix quietly.

5. **Recorded limit: the fast path proves PAYLOAD equivalence, not ENGINE equivalence.** A fresh
   clone has no built `gsd-core/bin/lib/*.cjs` (they are gitignored, produced by `npm ci` → `prepare`
   → `build:lib`), so `sync`'s pre-install comparison can only cover the installer's payload
   projection: `{workflows, references, templates, contexts}` — measured at 117 / 115 / 46 / 3 files,
   byte-identical to the runtime's. When those already match, no reinstall changes anything
   observable, so the run stamps and stops, recording `mode: "payload-verified", engine_verified:
   false`. Only an actual reinstall records `mode: "installed", engine_verified: true`.
   **`engine_verified` is recorded, not gated** — the gate keys on `sha` + `runtime_digest`. Promoting
   it to a gate input would turn every fast-path stamp into a deny, and is a decision to record here
   first.

## Consequences

- **Positive:** "I verified this against current `next`" becomes a machine fact instead of an
  assumption, on the surface where getting it wrong costs a maintainer's triage cycle. The remediation
  is one command with no decisions, quoted identically by the gate, the CLI and both skills.
- **Positive:** the cost is bounded and asserted. A non-governed Bash command (`git status`,
  `npm test`) costs **zero** filesystem digests and **zero** network calls — the RES-01 action-first
  short-circuit runs before any I/O, asserted by call count rather than by timing. Inside the 15 min
  TTL even a governed command makes no network call.
- **Negative / accepted (T-0ov-01):** `~/.gsd-contrib/runtime-stamp.json` and the tip cache are
  user-writable local state that steers a deny/allow. The digest binding means a hand-forged `sha`
  still needs a matching whole-tree digest, and a forged cache is bounded by the 24 h budget — but
  full forgery remains possible. This is accepted: the *sanctioned* bypass channel is
  `GSD_CONTRIB_OVERRIDE`, which is logged to a receipt. An unlogged bypass that requires deliberately
  hand-editing enforcement state is not a threat this layer can close.
- **Negative / accepted (T-0ov-05):** `sync` executes remote code — it clones the pinned tip and runs
  `npm ci` plus gsd-core's own installer. It is pinned to the `ls-remote`-resolved SHA with a
  rev-parse race guard, and it is never auto-invoked from a hook. This is the same trust the user
  already extends to `npx @opengsd/gsd-core`.
- **Negative / accepted:** the first run on any machine denies, because no stamp exists yet. That
  verdict is *correct* — we genuinely do not know what is installed — and the fix is one command. It
  is nonetheless a real first-use cost, and the deny reason is written to be self-resolving.
- **Honesty constraint (inherited):** CTK-ADR-0001's rule that the unbypassable property belongs to
  the installed hooks — not to the toolkit as a thing-in-itself — applies unchanged. ENF-21 adds a
  blocking floor on the filing surface and an `ask` on one network path; it does not make the suite
  more unbypassable.

## Alternatives considered

- **Extend `hooks/freshness.cjs` (ENF-14).** Rejected: a different axis entirely. ENF-14 compares a
  *staged* `src/*` against its *generated* `bin/lib/*.generated.cjs` at `git commit` time inside a
  gsd-core worktree, by delegating to gsd-core's own `check:<name>-fresh` scripts. ENF-21 compares the
  *installed global runtime* against a *remote ref*. Overloading one gate with both would give a
  single deny reason two unrelated meanings.
- **Diff the runtime against the local clone's working tree.** Rejected, and this is the trap worth
  recording: the local clone's `gsd-core/bin/lib/*.cjs` are **gitignored build artifacts** (17 tracked
  against 169 on disk when measured) and were, at the time ENF-21 was built, *staler than the
  runtime*. That comparison reports the runtime as behind whenever the clone is the stale side — a
  false deny driven by a directory the toolkit does not own. ENF-21 therefore never reads any local
  clone at all: it compares against `origin/next` **refs**, via `git ls-remote`.
- **`npx -y @opengsd/gsd-core@latest --claude` as the remediation.** Rejected: it installs the
  **published** package, which can be far behind `next`. Using it as the fix would REGRESS the
  runtime while reporting success — the worst available outcome. `sync` clones the resolved tip
  instead.
- **Deny on network failure.** Rejected — see Decision 2.3. It converts an ISP outage into a
  total inability to file against gsd-core, for a signal whose risk class is correctness, not
  containment.
- **A `git fetch` in the local clone to learn the tip.** Rejected: it mutates a repository the
  toolkit does not own, as a side effect of a read-only question. `ls-remote` answers the same
  question in ~0.3 s with no auth and no local write.
- **A sixth slash-command (`/gsd-runtime-sync`).** Rejected: ADR-959 fixes capability `commands[]` as
  gsd-tools CLI subcommands, not agent slash-commands, so a sixth `commands/*.md` would move the
  "5 commands" claim in three documents and buy nothing the RT0 skill step does not already give.
