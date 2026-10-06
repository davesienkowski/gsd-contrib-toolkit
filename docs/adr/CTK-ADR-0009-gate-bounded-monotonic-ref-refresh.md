# CTK-ADR-0009: A gate may perform a bounded, monotonic, compare-and-swap ref refresh

- **Status:** Proposed. Dave has not approved this record. It becomes Accepted, or is superseded, only
  by his explicit sign-off; until then it documents a decision implemented on a branch, not an approved
  one.
- **Review:** Published for maintainer review and open to revision. A changed decision will be recorded
  by a superseding or amending CTK-ADR, never by a silent edit to an accepted record.
- **Date:** 2026-10-06 (milestone v2.8).
- **Scope:** GSD Contribution Toolkit.
- **Relates to:** ENF-25 (`hooks/worktree-fresh-base.cjs`), its detector
  (`hooks/lib/worktree-add-detect.cjs`) and the shared segment walk it rides on
  (`hooks/lib/gsd-test-detect.cjs`, parametrized with a program matcher in Phase 37).
  [CTK-ADR-0001](CTK-ADR-0001-harness-boundary-enforcement.md) Decision 2 to 4 (HARD-01 fail-closed,
  reuse LIVE, accountable override);
  [CTK-ADR-0005](CTK-ADR-0005-graded-gate-severity-and-toolkit-owned-signals.md) Decision 1 and 2
  (`ask` as a third decision, severity matched to measured confidence);
  [CTK-ADR-0007](CTK-ADR-0007-runtime-freshness-and-the-network-unavailable-severity.md) Decision 2
  and 3 and its rejected alternative "A git fetch in the local clone";
  [CTK-ADR-0008](CTK-ADR-0008-gsd-test-dispatch-gates.md) (the separate-predicate detector placement
  and the per-call `GATE_BUDGET_MS` pattern from its 36-REVIEW m-06 amendment). Provenance: Trek-e's
  `worktree-fresh-base-guard.sh` (incident 2026-09-10). This record amends nothing.

## Context

On 2026-09-10 Trek-e's main gsd-core checkout sat on `next` 53 commits behind `origin/next`. Every
worktree cut from `next` in that window inherited the stale trunk, so branches were written against
code that had already been rewritten upstream, and the first rebase produced conflicts unrelated to
the change. His `worktree-fresh-base-guard.sh` made the fetch part of worktree creation. ENF-25 adopts
that idea for the toolkit.

Every earlier toolkit gate leaves the repository it judges untouched: it inspects local state, or
calls a LIVE gsd-core script, and returns `allow`, `ask` or `deny`. (Toolkit-owned state, such as the
ENF-21 stamp and tip cache, the verdict log and override receipts, lives outside that repository.)
ENF-25 is the first gate that changes repository state. It
fetches `origin next`, which writes `refs/remotes/origin/next`, `FETCH_HEAD` and objects, and it can
move the local branch `refs/heads/next`. That is a precedent, so it gets its own record.

**CTK-ADR-0007 said the opposite for ENF-21, and that decision stands.** Its Alternatives rejected
"a `git fetch` in the local clone to learn the tip" because it mutates a repository the toolkit does
not own as a side effect of a read-only question, and `git ls-remote` answers the same question with
no local write. Its Decision 3 kept remediation out of the hook: a reinstall is long, rewrites the
user's global runtime invisibly, and would re-fire on every governed command if it failed. ENF-25
differs on each point:

1. **The question is not read-only.** ENF-21 asks "is the installed runtime current?", and knowing
   the answer is enough. ENF-25 sits in front of a cut whose whole purpose is to start from the
   trunk. Knowing that `origin/next` has moved does not make the base fresh. The refresh IS the
   remediation, and the cut is the user's own request to act on that repository's trunk now.
2. **The mutation is small, monotonic and reversible.** It touches two refs and nothing else: the
   remote-tracking ref (exactly what any `git fetch` does) and a local `next` that is moved only
   forward, only when the old value is a proven ancestor, only through a compare-and-swap, and only
   when no worktree has it checked out. The previous value stays in `next`'s reflog under an ENF-25
   message. Nothing is rewritten, no working tree changes, and no index changes.
3. **It is bounded.** The fetch has a coreutils `timeout` and a spawnSync belt, every subprocess draws
   on one per-call deadline, and the whole gate fits inside its hook timeout with headroom, asserted
   by test. A reinstall cannot be bounded that way; a two-ref refresh can.
4. **When it cannot refresh safely, it does not try.** A held or diverged `next` is denied with the
   exact non-destructive command; an unobtainable origin asks. The gate never falls back to a
   stronger mutation.

**Why CTK-ADR-0001 Decision 3 has nothing to reuse.** No LIVE gsd-core script decides whether a
local trunk is stale before a cut. GSD's own worktree engine runs `git worktree add` from its own
node process, outside any Claude Code hook. Like ENF-21, ENF-23 and ENF-24, this gate is
toolkit-owned.

## Decision

1. **Trigger only on trunk-naming cuts in a gsd-core checkout.** The gate acts on a Bash
   `git [globals] worktree add` or a harness `EnterWorktree` cut. A Bash cut is found by a separate
   predicate on the shared segment walk (never a `classifyAction` action; the ENF-22 displacement
   lesson, locked by regression rows). The trunk-naming bases are `next`, `refs/heads/next`,
   `origin/next`, `refs/remotes/origin/next`, and a HEAD base (omitted, `HEAD`, `@`) while the target
   tree's current branch is `next`. `EnterWorktree` with a non-empty `path` enters an existing
   worktree and is allowed with no work; every other `EnterWorktree` shape is a cut whose base comes
   from the effective `worktree.baseRef` (`fresh` means `origin/next`, `head` means the HEAD rule).
   Any other base, any non-gsd-core target (no sentinel), and any command with no cut are allowed
   before any fetch or git call (RES-01).

2. **Bounded fetch inside one shared budget.** The fetch is
   `timeout -k 2 15 git -C <root> fetch --quiet --no-auto-maintenance origin next`, spawned as an argv
   array with `GIT_TERMINAL_PROMPT=0`, stdin ignored, and `GIT_DIR`, `GIT_WORK_TREE`,
   `GIT_INDEX_FILE` and `GIT_COMMON_DIR` removed from its environment, under a 20 s spawnSync belt
   with SIGKILL. A `git remote get-url origin` precedes it. Every subprocess of one gate call draws on
   one deadline, `GATE_BUDGET_MS` = 42000 (the 36-REVIEW m-06 pattern that CTK-ADR-0008 records):
   each call gets the smaller of its own cap and what remains, and under 100 ms left the gate throws.
   When the belt shrinks, the coreutils duration shrinks with it so that coreutils kills git before
   the belt kills `timeout`. The arithmetic is asserted by test: `FETCH_BELT_MS` +
   `MAX_GIT_CALLS_PER_ROOT` x `GIT_TIMEOUT_MS` = 20000 + 7 x 3000 = 41000 <= 42000, and
   `GATE_BUDGET_MS` + 3000 = 45000 <= the 45 s hook timeout on both registrations.

3. **Only two refs may change.** The gate's own git argv is limited to `fetch` (through `timeout`),
   `remote get-url`, `rev-parse`, `symbolic-ref`, `merge-base --is-ancestor`,
   `worktree list --porcelain` and `update-ref`. Only `refs/remotes/origin/next` (by the fetch) and
   `refs/heads/next` may change. `next` moves only when all of these hold: the fetch succeeded, local
   `next` is a strict ancestor of `origin/next` (`merge-base --is-ancestor` exits 0), no worktree's
   porcelain block names `branch refs/heads/next`, and one compare-and-swap
   `update-ref -m 'ENF-25 worktree-fresh-base: fast-forward next to origin/next' refs/heads/next <new> <old>`
   succeeds, with `<old>` read in the same call and both values checked as full SHAs. It is attempted
   once. `next` is never moved by reset, force, rebase, merge, checkout, stash or delete, and never
   while checked out in any worktree. `merge --ff-only` and `stash push` appear only as text in deny
   reasons, for the user to run.

4. **The severity map, as shipped.** "Policy" denies are returned `deny()` values and are not
   escapable through `GSD_CONTRIB_OVERRIDE`. "Thrown" denies are `FailClosed` errors that the valve can
   rescue with a receipt (CTK-ADR-0001 Decision 4). An `ask` is a returned decision, never a throw.
   The Source column separates what 37-CONTEXT decided from what the planner and executor added. Every
   row marked as a planner addition or refinement is a judgement a reviewer should challenge first.

   | Condition | Decision | Source |
   |---|---|---|
   | No cut, a non-trunk base, or a non-gsd-core target | allow, zero fetch | CONTEXT |
   | HEAD base and the current branch is not `next` (or HEAD is detached) | allow, zero fetch | CONTEXT |
   | The current branch is read from `symbolic-ref --quiet HEAD` (full ref), never `--short` | (how the HEAD rule reads) | executor refinement (37-03): `--short` prints `heads/next` when a tag named `next` exists, which skipped the check |
   | `git worktree add ../next` (no base, basename of the path is `next`) | judged as a local `next` cut (git checks out the existing branch) | PLANNER ADDITION (orchestrator-accepted) |
   | Remote base (`origin/next`, `refs/remotes/origin/next`), or `EnterWorktree` under `fresh` | allow after the fetch; local `next` untouched | CONTEXT |
   | Local `next` equals `origin/next` | allow | CONTEXT |
   | Local `next` strictly behind, held by no worktree, CAS succeeds | allow after the fast-forward | CONTEXT |
   | Local `next` strictly behind and checked out in any worktree (including the HEAD-on-next case) | policy deny with `git -C <holder> merge --ff-only origin/next`, a stash note, and the `origin/next` alternative | CONTEXT |
   | Local `next` ahead of `origin/next` | allow, nothing moves | PLANNER REFINEMENT (orchestrator-accepted): "diverged" read as "neither is an ancestor of the other" |
   | Local `next` and `origin/next` diverged | policy deny naming both short SHAs and the `origin/next` alternative only, never a reset | CONTEXT |
   | The CAS is refused (a concurrent writer moved `next`) | policy deny, one attempt | CONTEXT said "deny with fix"; executor refinement (37-03) made it a policy deny instead of a thrown one |
   | Local `next` missing | allow (git itself rejects the missing base) | addition in 37-03, not in CONTEXT |
   | Fetch unobtainable: coreutils exit 124/137, belt timeout or signal, any other non-zero git exit (unreachable, auth, a held ref lock), no `origin` remote | ask, with a redacted reason, the manual `git -C <root> fetch origin next`, and the note that ask degrades to allow under `--dangerously-skip-permissions` | CONTEXT (CTK-ADR-0007 Decision 2) |
   | The fetch succeeded but `origin/next` does not resolve | ask | PLANNER ADDITION (orchestrator-accepted) |
   | Credentials in fetch stderr: redacted to `scheme://***@` before a 200-character cap, control characters stripped, first line only | (reason hygiene) | PLANNER ADDITION |
   | `--no-auto-maintenance` on the fetch, so no gc runs inside the hook | (fetch argv) | PLANNER ADDITION |
   | Coreutils `timeout` missing (spawn ENOENT), exit 125/126/127, any other spawn error, `remote get-url` failing other than exit 2 | deny (thrown) | PLANNER REFINEMENT (orchestrator-accepted): an unbounded fetch is not an outage, so it denies rather than asks (37-04 fixed a fail-open here) |
   | Same-segment repository redirect: `--git-dir`, `--work-tree`, `GIT_DIR=` / `GIT_WORK_TREE=` / `GIT_COMMON_DIR=` before git | deny (thrown, constant path-free reason) | PLANNER ADDITION: graded uncertain |
   | The hook process environment carries `GIT_DIR`, `GIT_WORK_TREE` or `GIT_COMMON_DIR` and the cut names the trunk (Bash or `EnterWorktree`) | deny (thrown, same constant reason) | orchestrator addition (37-04, extended to `EnterWorktree` in 37-05) |
   | Uncertain command (unparseable, an expansion in the base slot, an expanded option, an expanded global before the verb) | deny (thrown, same constant reason) | CONTEXT (HARD-01); expansion grading is a planner addition |
   | A start dir or `git -C` value that cannot be expanded statically (`cd "$X"`, `-C "$Y"`) | deny (thrown) before any resolve or git call | executor fix (37-02): the tracer used `-C "$Y"` literally, a silent bypass |
   | The shared `GATE_BUDGET_MS` deadline is spent | deny (thrown) | 36-REVIEW m-06 pattern (CTK-ADR-0008) |
   | Any other git error after the fetch | deny (thrown) | CONTEXT (HARD-01) |
   | A `worktree.baseRef` settings layer that is not plain JSON (comments, trailing commas) | contributes nothing; the cascade falls through toward `fresh` | planner addition (37-05): `JSON.parse` only |

   Across several cuts in one command an ask is held while later cuts are checked; a later policy deny
   or thrown error wins over it, and only asks with allows give `ask`. A failed fetch is cached per
   root for the rest of the call and is not retried.

5. **Override semantics.** The only escape is `GSD_CONTRIB_OVERRIDE`, and it rescues thrown errors
   only, with a receipt. There is no agent-visible escape token. Because a policy deny cannot be
   overridden, every policy reason names a real, non-destructive fix.

### Trek-e provenance and divergences

| Trek-e behaviour | Toolkit behaviour | Why |
|---|---|---|
| Fetches `origin next` on every `git worktree add` and every `EnterWorktree` | Fetches only for trunk-naming cuts | A PR-head or feature-branch cut does not use the trunk; no network for it (CONTEXT, Deferred: Trek-e parity) |
| A failed fetch denies | A failed fetch asks | CTK-ADR-0007 Decision 2: an unobtainable input resolves to `ask`; an outage must not stop all worktree cuts |
| `GSD_WORKTREE_STALE_OK=1` in the command text is a human-only escape, logged | No escape token; only `GSD_CONTRIB_OVERRIDE`, for thrown errors only | A token the agent can type is self-applicable (CTK-ADR-0001 Decision 4) |
| Stands down only when the target is proven to be another repository by its remote URL; an unknown dir keeps the guard on | Arms only on the gsd-core sentinel; anything without it is allowed | The toolkit's arming convention (ROB-01). This is an accepted bypass direction, not parity: a gsd-core clone missing the sentinel files is not judged |
| A diverged base is allowed (`merge-base --is-ancestor ... \|\| exit 0`) | A diverged `next` is denied, naming the divergence | Cutting from a diverged trunk is the incident shape; the fix is the `origin/next` alternative |
| A refused `update-ref` is ignored (`\|\| true`) and the hook falls through | A refused CAS is a policy deny | A silent CAS loss leaves a stale base behind an allow |
| `EnterWorktree` gets the fetch and the fast-forward, with no base check | `EnterWorktree` is judged by the effective `worktree.baseRef` with the same verdict function as a Bash cut | `head` on a stale checked-out `next` is the same hazard as a Bash cut |
| Parses the command with `grep`/`sed` regexes and strips heredocs with `awk` | Parses through the shared argv segment walk (groups, wrappers, `bash -c`, `eval`, `cd`, `env -C`, `sudo -D`) | One parser for every gate; regexes missed grouped and wrapped forms |
| `perl -e 'alarm ...'` bounds the fetch | Coreutils `timeout -k 2 15` plus a spawnSync belt | Coreutils is present here; perl was Trek-e's portability workaround |

## Consequences

- **Positive:** a trunk cut in a gsd-core checkout starts from the current `origin/next` without the
  user typing anything when it is safe, and with the exact command when it is not. A command that is
  not a trunk cut costs no I/O.
- **Positive:** the precedent is narrow. A later gate may mutate state only under the same
  constraints: the mutation is the remediation of the action being gated, it is monotonic and
  compare-and-swap, it is bounded and asserted, it is scoped to named refs, and it never falls back
  to a stronger mutation.

**Negative / accepted residuals.** The gate is not complete and can be bypassed. Known gaps:

- **The first gate that mutates state.** A trunk cut writes `refs/remotes/origin/next`, `FETCH_HEAD`
  and fetched objects, and may move `next` and append to its reflog. Repository hooks in the target
  repo, such as `reference-transaction`, run for those ref updates.
- **`ask` is not a block.** The unobtainable-origin path asks, and `ask` degrades to allow under
  `--dangerously-skip-permissions` and in any unattended run (the limit CTK-ADR-0005 and CTK-ADR-0007
  record). The reason text says so.
- **No `ask` proof kind.** `bin/verify-hooks.cjs` proves deny and allow at the real entrypoints only.
  The ask paths are unit- and e2e-proven on temp fixtures in `hooks/worktree-fresh-base.test.cjs`.
- **Worktrees created outside Claude Code are invisible (WTREE-05).** Orca (`orca-ide`) creates them
  out of band under `~/orca/workspaces/<repo>/<name>`; GSD's own worktree engine runs
  `git worktree add` from a node child process (`spawnSync`); and an IDE, an outside terminal, or a
  script or Makefile the agent runs also never reach the hook. The README documents these and the
  manual refresh.
- **A newline-joined multi-line command is invisible**, the shared argv residual CTK-ADR-0008 records
  (`SEED-argv-newline-separator-gap`).
- **A repository redirect set in an earlier segment is not graded.** `export GIT_DIR=/x; git worktree
  add p next` (or `declare -x`) is not seen; only same-segment forms and the hook's own environment
  are.
- **An unquoted expansion in the path slot with a literal base is read as the path.** A word-splitting
  `$OPTS` that removes the base is not modelled.
- **A fork configured as `origin`** makes `origin/next` the fork's `next`. The gate refreshes against
  whatever `origin` is.
- **`upstream/next` is not treated as trunk.** Only `origin` forms are; a cut from `upstream/next`
  is allowed with no fetch.
- **Ref names are compared case-sensitively.** Case-insensitive filesystems are not covered.
- **A command that cuts into several distinct repositories can exhaust the per-call budget.** Each
  root's fetch may take up to 20 s of the shared 42 s, so such a command can end in a thrown deny
  (fail-closed, override-escapable) instead of a verdict.
- **A fetch belt under about 4 s can orphan git.** When the deadline is nearly spent, the coreutils
  duration clamps to 1 s and its 2 s kill-after can outlast the belt, so the belt may reap `timeout`
  and leave git holding a ref lock. The outcome is still an ask, and `next` cannot move.
- **Whether the harness fetches before an `EnterWorktree` cut under `fresh` is UNVERIFIED.** ENF-25
  fetches whenever it fires, regardless.
- **Settings are parsed as plain JSON.** A `worktree.baseRef` layer with comments contributes nothing
  and the cascade falls through toward `fresh` (the conservative direction, which fetches). Claude
  Code settings are strict JSON as far as known; that is UNVERIFIED. If the harness ever accepted a
  commented layer saying `head`, the gate would judge `fresh` and would not deny a stale checked-out
  `next` for that cut.
- **`EnterWorktree` schema drift.** A future parameter that names a base is not modelled; any shape
  other than a non-empty `path` is treated as a cut and judged by the setting.
- **Deny reasons are not byte-stable.** They carry real paths and short SHAs, so the standing proofs
  use the constant path-free uncertain reason instead.
- **A bounded red window in history.** Between `95aa582` (37-06 wiring) and `303b0c5` (37-07 docs) the
  full suite is red on exactly the docs-hook-counts tests, by plan. A `git bisect` that lands in that
  window sees those failures.
- **Not projected into the bundle.** No skill links this record, so it ships in the repository but
  not in the capability bundle, like CTK-ADR-0008.
- **Honesty constraint (inherited):** CTK-ADR-0001's rule applies unchanged. Any blocking property
  belongs to the installed hooks running under Claude Code, not to the toolkit as a thing-in-itself.

## Alternatives considered

- **Deny only, without the fast-forward.** Rejected: it forces a manual step that the gate can do
  safely, and a guard that only nags on every stale trunk gets switched off.
- **A read-only `git ls-remote` check, like ENF-21.** Rejected: it can say the trunk is stale but
  cannot make the base fresh, which is the point of the gate.
- **Fetch on every cut (Trek-e parity).** Deferred (CONTEXT, Deferred ideas): a non-trunk cut does
  not use the trunk.
- **Reset or force-update `next`.** Rejected: destructive. A diverged or held `next` is the user's to
  resolve; the gate names the non-destructive command.
- **`perl -e alarm` as the bound.** Rejected: coreutils `timeout` is present, and its kill-after
  grace is clearer to reason about.
- **Remediation outside the hook, like `runtime-sync` for ENF-21.** Rejected: the cut happens now,
  and the fix takes seconds, is monotonic, and can be undone from the reflog. CTK-ADR-0007's reasons
  for keeping a reinstall out of the hook (length, an invisible global rewrite, re-firing on failure)
  do not apply to a two-ref refresh.
