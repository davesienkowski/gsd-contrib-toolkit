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
   remediation of the action being gated. It is not, however, done with the user's consent: a
   `PreToolUse` hook runs BEFORE the permission prompt and in parallel with the other gates, so the
   fetch and the compare-and-swap happen when the agent PROPOSES the cut, and they persist when the
   user then declines the call, when another gate denies it, or when this gate denies a later cut
   in the same command (37-REVIEW MI-03). The mutation is acceptable without consent only because
   of point 2: it is the same forward-only refresh the user's own `git fetch` plus `merge --ff-only`
   would make.
2. **The mutation is small, monotonic and reversible.** It touches two refs and nothing else: the
   remote-tracking ref (exactly what any `git fetch` does) and a local `next` that is moved only
   forward, only when the old value is a proven ancestor, only through a compare-and-swap that never
   writes through a symbolic ref, and only when no worktree has it checked out or is rebasing or
   bisecting it. The previous value stays in `next`'s reflog under an ENF-25 message (the reflog is
   created if it does not exist). Nothing is rewritten, no working tree changes, and no index
   changes.
3. **It is bounded.** The fetch has a coreutils `timeout` and a spawnSync belt, every subprocess draws
   on one per-call deadline, and the whole gate fits inside its hook timeout with headroom, asserted
   by test. A reinstall cannot be bounded that way; a two-ref refresh can.
4. **When it cannot refresh safely, it does not try.** A held or diverged `next` is denied with the
   exact non-destructive command; an unobtainable origin asks, unless the last-fetched `origin/next`
   already proves a held or diverged `next`, which is denied (37-REVIEW MI-01). The gate never falls
   back to a stronger mutation, and never moves `next` on unrefreshed data.

**Why CTK-ADR-0001 Decision 3 has nothing to reuse.** No LIVE gsd-core script decides whether a
local trunk is stale before a cut. GSD's own worktree engine runs `git worktree add` from its own
node process, outside any Claude Code hook. Like ENF-21, ENF-23 and ENF-24, this gate is
toolkit-owned.

## Decision

1. **Trigger only on trunk-naming cuts in a gsd-core checkout.** The gate acts on a Bash
   `git [globals] worktree add` or a harness `EnterWorktree` cut. A Bash cut is found by a separate
   predicate on the shared segment walk (never a `classifyAction` action; the ENF-22 displacement
   lesson, locked by regression rows). The trunk-naming bases are `next`, `refs/heads/next`,
   `origin/next`, `refs/remotes/origin/next`, `remotes/origin/next`, `heads/next`, the origin/HEAD
   forms `origin`, `origin/HEAD`, `remotes/origin/HEAD` and `refs/remotes/origin/HEAD` (37-REVIEW
   MA-05: they resolve through origin/HEAD, which on a gsd-core clone is origin/next), and a HEAD base
   (omitted, `HEAD`, `@`) while the target tree's current branch is `next`. A trailing chain of
   `~N`, `^N`, `^{...}` and `@{0}` suffixes is stripped before matching, so `next~0` is `next`. A base
   that resolves through state the gate cannot read statically (`-`, `@{-N}`, `@{u}`, `@{upstream}`,
   `@{push}`, `@{N>0}`, any other `@{...}`, `rev:path`, `:/text`, `a..b`) is uncertain and denied
   (thrown). `EnterWorktree` with a non-empty `path` enters an existing worktree and is allowed with
   no work; every other `EnterWorktree` shape is a cut whose base comes from the effective
   `worktree.baseRef` (`fresh` means `origin/next`, `head` means the HEAD rule). Any other base, any
   target without the gsd-core sentinel, and any command with no cut are allowed before any fetch or
   git call (RES-01). **Arming (37-REVIEW MA-01):** the sentinel only nominates a root; the gate
   fetches and moves refs there only when `git remote get-url origin` parses as open-gsd/gsd-core
   (`resolve.repoSpecTargetsGsdCore`: owner and repo, case-folded, any host). Any other origin,
   including none, is out of scope and allowed with no fetch, so a sentinel vendored inside another
   repository never touches that repository, and a clone whose `origin` is a fork is not judged.

2. **Bounded fetch inside one shared budget.** The fetch is
   `timeout -k 2 15 git -C <root> fetch --quiet --no-auto-maintenance --no-tags origin +refs/heads/next:refs/remotes/origin/next`
   (37-REVIEW MA-02: a fully qualified, forced refspec, so a narrowed `remote.origin.fetch` cannot
   leave `origin/next` stale and a tag named `next` on origin cannot shadow the branch), spawned as
   an argv array with `GIT_TERMINAL_PROMPT=0`, `SSH_ASKPASS_REQUIRE=never` and
   `GCM_INTERACTIVE=never`, stdin ignored, and `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE` and
   `GIT_COMMON_DIR` removed from its environment, under a 20 s spawnSync belt with SIGKILL. The
   arming `git remote get-url origin` precedes it. Every subprocess of one gate call draws on one
   deadline, `GATE_BUDGET_MS` = 50000 (the 36-REVIEW m-06 pattern that CTK-ADR-0008 records): each
   call gets the smaller of its own cap and what remains, and under 100 ms left the gate throws.
   When the belt shrinks, the coreutils duration shrinks with it so that coreutils kills git before
   the belt kills `timeout`. The arithmetic is asserted by test (re-derived for the 37-REVIEW fixes,
   which added the symbolic-ref and common-dir calls): `FETCH_BELT_MS` + `MAX_GIT_CALLS_PER_ROOT` x
   `GIT_TIMEOUT_MS` = 20000 + 9 x 3000 = 47000 <= 50000, and `GATE_BUDGET_MS` + 3000 = 53000 <=
   `HOOK_TIMEOUT_S` = the 60 s hook timeout on both snippet registrations. The capability install
   writes no `timeout` (gsd-core's materializer drops it), so an installed registration runs under
   the harness default, which the reviewer read as 60 s; the budget fits that too (asserted).

3. **Only two refs may change.** The gate's own git argv is limited to `fetch` (through `timeout`),
   `remote get-url`, `rev-parse` (including `--git-common-dir`), `symbolic-ref`,
   `merge-base --is-ancestor`, `worktree list --porcelain` and `update-ref`. Only
   `refs/remotes/origin/next` (by the fetch) and `refs/heads/next` may change. `next` moves only when
   all of these hold: `refs/heads/next` is not a symbolic ref (`symbolic-ref -q` exits 1; a symbolic
   `next` is refused before any fetch, 37-REVIEW BL-01), the fetch succeeded, local `next` is a strict
   ancestor of `origin/next` (`merge-base --is-ancestor` exits 0), `next` is not **checked out** in any
   worktree, and one compare-and-swap
   `update-ref --no-deref --create-reflog -m 'ENF-25 worktree-fresh-base: fast-forward next to origin/next' refs/heads/next <new> <old>`
   succeeds, with `<old>` read in the same call and both values checked as full SHAs. It is attempted
   once. **"Checked out" follows git's own `branch -f` refusal (find_shared_symref, 37-REVIEW
   BL-02):** a worktree's porcelain block names `branch refs/heads/next`, OR that worktree's git dir
   (the common dir for the main worktree, `worktrees/<id>/` for a linked one) holds
   `rebase-merge/head-name` or `rebase-apply/head-name` equal to `refs/heads/next`, a
   `rebase-merge/update-refs` line naming it, or a `BISECT_START` naming `next`. A state file that
   cannot be read for any reason other than its absence fails closed. `next` is never moved by
   reset, force, rebase, merge, checkout, stash or delete, and never while checked out in that
   sense. `merge --ff-only`, `stash push`, `rebase --continue` / `--abort` and `bisect reset` appear
   only as text in deny reasons, for the user to run.

4. **The severity map, as shipped.** "Policy" denies are returned `deny()` values and are not
   escapable through `GSD_CONTRIB_OVERRIDE`. "Thrown" denies are `FailClosed` errors that the valve can
   rescue with a receipt (CTK-ADR-0001 Decision 4). An `ask` is a returned decision, never a throw.
   The Source column separates what 37-CONTEXT decided from what the planner and executor added. Every
   row marked as a planner addition or refinement is a judgement a reviewer should challenge first.

   | Condition | Decision | Source |
   |---|---|---|
   | No cut, a non-trunk base, or a non-gsd-core target (no sentinel) | allow, zero fetch | CONTEXT |
   | Sentinel present but `origin` does not parse as open-gsd/gsd-core, or there is no `origin` | allow, zero fetch, nothing moved | 37-REVIEW MA-01 (was: fetch and maybe move any sentinel-bearing repo; no `origin` asked) |
   | HEAD base and the current branch is not `next` (or HEAD is detached) | allow, zero fetch | CONTEXT |
   | The current branch is read from `symbolic-ref --quiet HEAD` (full ref), never `--short` | (how the HEAD rule reads) | executor refinement (37-03): `--short` prints `heads/next` when a tag named `next` exists, which skipped the check |
   | `git worktree add ../next` (no base, basename of the path is `next`) | judged as a local `next` cut (git checks out the existing branch) | PLANNER ADDITION (orchestrator-accepted) |
   | Remote base (`origin/next`, `refs/remotes/origin/next`, `remotes/origin/next`, and the origin/HEAD forms `origin`, `origin/HEAD`, `remotes/origin/HEAD`, `refs/remotes/origin/HEAD`), or `EnterWorktree` under `fresh` | allow after the fetch; local `next` untouched | CONTEXT; origin/HEAD forms 37-REVIEW MA-05 |
   | A trunk base with a trailing `~N` / `^N` / `^{...}` / `@{0}` chain (`next~0`, `origin/next^{commit}`, `HEAD~0`) | judged as the stripped base (no suffix bypass of a held-next deny) | 37-REVIEW MA-05 |
   | An indirect base: `-`, `@{-N}`, `@{u}`, `@{upstream}`, `@{push}`, `@{N>0}`, any other `@{...}`, `rev:path`, `:/text`, `a..b` | deny (thrown, constant reason) | 37-REVIEW MA-05; `@{N>0}` deliberately not stripped (after a CAS, `next@{1}` is the stale pre-move value) |
   | A HEAD-kind cut after a `git checkout` / `git switch` (any arguments, any repository) earlier in the same command | deny (thrown, constant reason) | 37-REVIEW MA-03 |
   | `refs/heads/next` is a symbolic ref (local or HEAD-on-next cut) | deny (thrown, constant reason), checked before the fetch | 37-REVIEW BL-01 |
   | Local `next` equals `origin/next` | allow | CONTEXT |
   | Local `next` strictly behind, held by no worktree, CAS succeeds | allow after the fast-forward | CONTEXT |
   | Local `next` strictly behind and checked out in any worktree (including the HEAD-on-next case) | policy deny with `git -C <holder> merge --ff-only origin/next`, a stash note, and the `origin/next` alternative | CONTEXT |
   | Local `next` strictly behind, checked out nowhere, but a worktree is rebasing it or bisecting from it | policy deny naming that worktree and `rebase --continue` / `--abort` or `bisect reset`, plus the `origin/next` alternative | 37-REVIEW BL-02 (git's own `branch -f` refuses the same move) |
   | A rebase / bisect state file unreadable for a reason other than its absence | deny (thrown) | 37-REVIEW BL-02 (when unsure, do not move) |
   | Local `next` ahead of `origin/next` | allow, nothing moves | PLANNER REFINEMENT (orchestrator-accepted): "diverged" read as "neither is an ancestor of the other" |
   | Local `next` and `origin/next` diverged | policy deny naming both short SHAs and the `origin/next` alternative only, never a reset | CONTEXT |
   | The CAS is refused (a concurrent writer moved `next`) | policy deny, one attempt | CONTEXT said "deny with fix"; executor refinement (37-03) made it a policy deny instead of a thrown one |
   | Local `next` missing | allow: with `-b` git rejects the missing base; with no `-b`, `git worktree add <path> next` DWIMs to `--track -b next <path> origin/next`, which the gate has just fetched (37-REVIEW NI-02 corrected the reason) | addition in 37-03, not in CONTEXT |
   | Fetch unobtainable: coreutils exit 124/137, belt timeout or signal, any other non-zero git exit (unreachable, auth, a held ref lock, a remote with no `next`) | ask, with a redacted reason, the manual `git -C <root> fetch origin next`, and the note that ask degrades to allow under `--dangerously-skip-permissions` | CONTEXT (CTK-ADR-0007 Decision 2) |
   | Fetch unobtainable, local or HEAD-on-next base, and the LAST-FETCHED `origin/next` already proves `next` behind and checked out (or rebasing / bisecting), or diverged | policy deny worded as stale evidence ("the last-fetched value: the gate could not refresh origin/next (...)"); never a CAS on that data | 37-REVIEW MI-01 (Trek-e's incident was exactly a known-stale `next`) |
   | The fetch succeeded but `origin/next` does not resolve | ask | PLANNER ADDITION (orchestrator-accepted) |
   | Credentials in fetch stderr: redacted to `scheme://***@` before a 200-character cap, control characters stripped, first line only | (reason hygiene) | PLANNER ADDITION |
   | `--no-auto-maintenance` on the fetch, so no gc runs inside the hook | (fetch argv) | PLANNER ADDITION |
   | Coreutils `timeout` missing (spawn ENOENT), exit 125/126/127, any other spawn error, `remote get-url` failing other than exit 2 | deny (thrown) | PLANNER REFINEMENT (orchestrator-accepted): an unbounded fetch is not an outage, so it denies rather than asks (37-04 fixed a fail-open here) |
   | A git call that exited 0 while spawnSync also reports ETIMEDOUT (a grandchild held the pipe) | treated as the success it was | 37-REVIEW NI-04 |
   | Same-segment repository redirect: `--git-dir`, `--work-tree`, `GIT_DIR=` / `GIT_WORK_TREE=` / `GIT_COMMON_DIR=` before git | deny (thrown, constant path-free reason) | PLANNER ADDITION: graded uncertain |
   | The hook process environment carries `GIT_DIR`, `GIT_WORK_TREE` or `GIT_COMMON_DIR` and the cut names the trunk (Bash or `EnterWorktree`) | deny (thrown, same constant reason) | orchestrator addition (37-04, extended to `EnterWorktree` in 37-05) |
   | Uncertain command (unparseable, an expansion in the base slot, an expanded option, an expanded global before the verb) | deny (thrown, same constant reason) | CONTEXT (HARD-01); expansion grading is a planner addition |
   | A start dir or `git -C` value that cannot be expanded statically (`cd "$X"`, `-C "$Y"`) | deny (thrown) before any resolve or git call | executor fix (37-02): the tracer used `-C "$Y"` literally, a silent bypass |
   | `pushd <dir>`, `builtin cd`, `command [-p] cd` before the cut | followed like `cd` (the shared walk, so the gsd-test gates follow them too) | 37-REVIEW MA-04 (was: ignored, so the gate fetched and moved the SESSION repo) |
   | `popd`, a bare `pushd`, `pushd -n`, `pushd +N` / `-N` before the cut | deny (thrown) before any resolve or git call | 37-REVIEW MA-04 |
   | The shared `GATE_BUDGET_MS` deadline is spent | deny (thrown) | 36-REVIEW m-06 pattern (CTK-ADR-0008) |
   | Any other git error after the fetch | deny (thrown) | CONTEXT (HARD-01) |
   | A `worktree.baseRef` settings layer that is not plain JSON (comments, trailing commas) | contributes nothing; the cascade falls through toward `fresh` | planner addition (37-05): `JSON.parse` only |
   | The `worktree.baseRef` cascade, first answer wins | managed `managed-settings.d/*.json` (last sorted first) and `managed-settings.json` in the platform managed dir (`/etc/claude-code` on Linux), then `<root>/.claude/settings.local.json`, `<root>/.claude/settings.json`, then (root a linked worktree) the main checkout's two project layers, then `~/.claude/settings.json` | 37-05; managed and main-checkout layers 37-REVIEW MI-04 (paths verified against the installed Claude Code 2.1.291 binary, 2026-10-06) |

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
| Stands down only when the target is proven to be another repository by its remote URL; an unknown dir keeps the guard on | Arms only on the gsd-core sentinel AND an `origin` that parses as open-gsd/gsd-core (37-REVIEW MA-01); anything else is allowed with no fetch | The toolkit's arming convention (ROB-01) plus the remote-URL half of Trek-e's guard, applied in the opposite direction: the toolkit must never fetch or move refs in a repository that is not gsd-core. Accepted bypass direction, not parity: a gsd-core clone missing the sentinel files, or one whose `origin` is a fork or a renamed remote, is not judged |
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
- **A fork configured as `origin` is not judged at all** (37-REVIEW MA-01): the gate arms only when
  `origin` parses as open-gsd/gsd-core, so a clone that tracks upstream under another remote name
  (`upstream`) with a fork as `origin` gets no fetch and no check. The URL check reads owner and
  repo only; the host is not checked, so any host serving an `open-gsd/gsd-core` path arms it.
- **The repository acted on is the one containing the sentinel root.** `git -C <root>` resolves the
  repository from the sentinel root; a nested repository between the root and the cut's target dir
  is not detected (`rev-parse --show-toplevel` is not compared; the origin check makes a non-gsd-core
  enclosing repository harmless).
- **`upstream/next` is not treated as trunk.** Only `origin` forms are; a cut from `upstream/next`
  is allowed with no fetch.
- **Ref names are compared case-sensitively.** Case-insensitive filesystems are not covered.
- **A command that cuts into several distinct repositories can exhaust the per-call budget.** Each
  root's fetch may take up to 20 s of the shared 50 s, so such a command can end in a thrown deny
  (fail-closed, override-escapable) instead of a verdict.
- **The refresh is not consented to and survives a deny (37-REVIEW MI-03).** `PreToolUse` hooks run
  before the permission prompt and in parallel with the other gates. The fetch and the CAS therefore
  happen when the cut is proposed and remain when the user declines the call, when another gate
  denies it, or when this gate denies a LATER cut in the same command (for example
  `git worktree add ../a next && git -C <held-clone> worktree add ../b next` moves the first root's
  `next`, then denies the call). Deferring every CAS until the call's final verdict is a possible
  refinement; it would still precede the permission prompt.
- **Inherited parser gaps (37-REVIEW MI-02).** The shared walk does not see a cut in: a lone `&`
  background (`sleep 1 & git worktree add ../x next`), a command substitution (`x=$(git worktree add
  ../x next)` or backticks), the `setsid`, `xargs`, `find -exec`, `flock`, `script -qc` and `watch`
  wrappers, a `case` arm, a shell function body (`f() { git worktree add ../x next; }; f`), and a
  payload piped or here-stringed into a shell (`echo '...' | bash`, `bash <<< '...'`). The
  newline residual below is the same family.
- **git aliases (37-REVIEW MI-02).** `git -c alias.wt="worktree add" wt ../x next` and a configured
  alias (`git wt ../x next`) are not seen; reading `alias.*` would cost a git call on every git
  command.
- **Only `checkout` / `switch` are modelled as HEAD changers (37-REVIEW MA-03).** A `git reset`,
  `rebase`, `pull`, `merge`, `commit` or `bisect` earlier in the same command can change what a
  later HEAD-kind cut is based on; the gate reads HEAD as it is at hook time.
- **A check-to-write window (37-REVIEW NI-06).** Between the holder checks (`worktree list`, the
  rebase / bisect state files) and the `update-ref`, a `git checkout next` elsewhere is not caught;
  the CAS guards the value only. git's own `branch -f` has the same window.
- **An ssh prompt on the controlling terminal (37-REVIEW NI-05).** `GIT_TERMINAL_PROMPT=0`,
  `SSH_ASKPASS_REQUIRE=never` and `GCM_INTERACTIVE=never` are set, but spawnSync has no `detached`
  option, so ssh can still prompt on the session's tty (or a configured `core.askPass` /
  `GIT_ASKPASS` can run). Each is bounded by the fetch timeout and ends in an ask. gsd-core's origin
  is anonymous https today, so this is latent.
- **A `$VAR` base is a deny (37-REVIEW NI-08).** Any shell expansion in the base slot is uncertain
  (HARD-01), so the common agent form `git worktree add ../pr "$SHA"` is denied for every non-trunk
  review cut. That false-deny cost is accepted by design; the verdict log is the place to measure it.
- **The `worktree.baseRef` cascade is a model of the harness, not the harness (37-REVIEW MI-04).**
  CLI `--settings` layers, the optional WSL inheritance of the Windows policy chain (registry, HKCU,
  `C:\Program Files\ClaudeCode` via DrvFs) and server-managed settings are not read. Whether the
  harness, started in a linked worktree, reads the main checkout's project settings is UNVERIFIED;
  the gate reads them after the worktree's own layers. The spawned-hook e2e rows cannot exercise the
  real managed path (it needs a root-owned file); unit rows use injected paths.
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
- **Bounded red windows in history.** Between `95aa582` (37-06 wiring) and `303b0c5` (37-07 docs) the
  full suite is red on exactly the docs-hook-counts tests, by plan. Each 37-REVIEW fix landed test
  first, so every `test(37): ... (red)` commit is red on exactly its own new rows until the next
  `fix(37)` commit. A `git bisect` that lands in such a window sees those failures.
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
