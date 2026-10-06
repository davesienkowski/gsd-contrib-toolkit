# CTK-ADR-0008: Gate gsd-test dispatches at dispatch time (clean tree, unmasked exit, viable run)

- **Status:** Proposed. Dave has not approved this record. It becomes Accepted, or is superseded, only
  by his explicit sign-off; until then it documents a decision implemented on a branch, not an approved
  one.
- **Review:** Published for maintainer review and open to revision. A changed decision will be recorded
  by a superseding or amending CTK-ADR, never by a silent edit to an accepted record.
- **Date:** 2026-10-05 (milestone v2.8); amended in place 2026-10-06 from the Phase 36 code review
  (`36-REVIEW.md`), while still Proposed. See "Amendment: 36-REVIEW corrections" below.
- **Scope:** GSD Contribution Toolkit.
- **Relates to:** ENF-23 (`hooks/gsd-test-clean-tree.cjs`), ENF-24 (`hooks/gsd-test-viability.cjs`),
  and the detector they share (`hooks/lib/gsd-test-detect.cjs`).
  [CTK-ADR-0001](CTK-ADR-0001-harness-boundary-enforcement.md) Decision 1 to 4 (outcomes not steps,
  HARD-01 fail-closed, reuse LIVE, accountable override);
  [CTK-ADR-0005](CTK-ADR-0005-graded-gate-severity-and-toolkit-owned-signals.md) Decision 1, 2 and 4
  (`ask` as a third decision, severity matched to measured confidence, the narrow fail-open
  exception); [CTK-ADR-0007](CTK-ADR-0007-runtime-freshness-and-the-network-unavailable-severity.md)
  Decision 2 (an unobtainable input resolves to `ask`, never to `allow`). This record amends nothing.

## Context

`gsd-test` (v1.8.0, the Go runner) is the contributor's bench for the gsd-core suite. Its classic
(no-subcommand) path is **ref-based**: it resolves `--base` (default `main`) and `--head` (default
`HEAD`) to commits and merges them into a scratch worktree, so uncommitted edits are not tested.
Two forms do test the working tree as it is: the `run` subcommand (it builds a spec from
`git rev-parse --show-toplevel` with no base) and a classic run with an empty `--base=`
(`internal/worktree/worktree.go`: `if baseRef == "" { return &Worktree{path: repo} }`). The
original text of this paragraph said gsd-test "never tests the files in the working tree"; that was
true only of the classic path with a non-empty base (36-REVIEW M-01). Its verdict is only as good as
the invocation that produced it, and the invocation is written by an agent under time pressure.

Trek-e's reference guards (`gsd-test-clean-tree-guard.sh`, `gsd-test-viability-guard.sh`) record the
incidents this family exists to stop. They are the provenance of this record:

1. **Dirty tree (2026-07-17, gsd-core issue #2335 work).** A failing-first regression test was edited
   into the worktree and never committed. The bench returned 25308/25308 PASS on unmodified `next`,
   and the result was read as "the bug does not reproduce".
2. **Pipe masks the exit code (2026-07-17).** A pipeline exits with its last command's status. A run
   with 5 real failures exited 0 through `| tail -12`, and the contributor convention gates on exit 0,
   so a red suite became a green push.
3. **Unviable environment (2026-09-13, a freshly migrated workstation).** First, the legacy pre-Go
   bash `gsd-test` was still on PATH; it exited 125 with "pull access denied" after a full round trip.
   Then, with the Go client installed but no local `docker` CLI, the run produced zero containers and
   hung for 26 minutes in total silence.

**Why dispatch time, not push time.** The toolkit already denies a dirty tree: `lint-ci-marker`
(ENF-05 / ENF-17) checks `git status --porcelain` and the `git write-tree` marker. But it fires at
`git push`. By then the false-green verdict has already been read and acted on: the bug was declared
not reproducible, the fix was judged unnecessary, the PR was described as green. The decision the
verdict steers happens between the dispatch and the push, so the push-time check arrives after the
damage. The only boundary that precedes the verdict is the dispatch itself.

**Why CTK-ADR-0001 Decision 3 has nothing to reuse here.** No LIVE gsd-core script decides any of
these facts. Whether the tree is clean, whether a pipe hides the exit status, whether a config file
exists, and whether a Docker daemon answers are all local git, filesystem and process state. Like
ENF-21's runtime stamp (CTK-ADR-0007), these gates are toolkit-owned: they reach their verdict from
local state, and they call no gsd-core gate script.

## Decision

1. **A dispatch-gate family that shares one pure detector.** ENF-23 (clean tree, unmasked exit) and
   ENF-24 (config present, named bench configured, local Docker answering) are separate hook files on
   the existing PreToolUse `Bash` matcher, each with a 20 s harness timeout that a test checks against
   the subprocess bound each module exports. Both call the same detector,
   `hooks/lib/gsd-test-detect.cjs`, so the pair cannot disagree about what counts as a dispatch.

2. **Detector placement: a separate predicate, never a `classifyAction` action.** Adding a `gsd-test`
   action to `classify.classifyAction` was rejected on the ENF-22 lesson: a new action can displace a
   `pr-merge` or review-side action in a chained command (`gsd-test ... && gh pr merge 1`) and disarm
   ENF-20. `classifyAction` output for chained gsd-test commands is locked unchanged by regression
   rows. Consequences of the placement:
   - The detector itself is the RES-01 short-circuit. A command with no gsd-test dispatch is allowed
     before any resolve, git, filesystem or Docker work.
   - `nohup` and `time` are peeled inside the detector (bounded; past the bound the command is graded
     uncertain) instead of being added to classify's shared wrapper set, which every other Bash gate
     reads. Blast radius decided this.
   - `bash -c` / `sh -c` payloads, and the joined arguments of `eval` (36-REVIEW M-04), are re-parsed
     through the existing `argv.parseCommand`, sharing one depth bound of 2. A payload past that
     depth, or an unparseable one, that names gsd-test is graded uncertain.
   - The recognised wrapper set is closed: classify's `WRAPPER_BUILTINS` (`command`, `env`, `exec`,
     `sudo`, `nice`, `timeout`, `stdbuf`, `ionice`), plus `nohup`, `time`, shell `-c` and `eval`.
     A gsd-test reached through any other program (`setsid`, `script -c`, `unbuffer`, `flock`,
     `watch`, `chronic`, `builtin`, a here-string or a pipe into `bash`, a `case` arm) is not seen;
     that is a recorded residual, not a promise (36-REVIEW m-04).
   - A `command -v` / `command -V` lookup of gsd-test is not a dispatch; `type`, `hash` and `which`
     never resolve to gsd-test (36-REVIEW M-05).
   - The v1.8.0 subcommand is read from `args[0]` only (`cmd/gsd-test/main.go` `run()` dispatches on
     it before any flag parsing), and that subcommand's own Go flagset is walked, so flags after
     `gsd-test run` are read (36-REVIEW M-01). `wait` and `status` take a bare run id, which is never
     graded uncertain. `__run-worker` (internal) falls to the classic path, which over-governs it.
   - Go's flag package accepts `-f v`, `--f v`, `-f=v` and `--f=v`; `argv.classifyTokens` misreads
     single-dash long flags, so the detector carries its own small flag walker. The walker attributes
     every token inside a `$(...)` or backtick value to that value, so flags after
     `--head $(git rev-parse HEAD)` are still read. An argument list it cannot attribute is graded
     uncertain, never read as "no flags".
   - Grouping is quote-aware: only unquoted, unescaped `( ) { } &` affect pipe attribution and `cd`
     scoping (a quoted paren once hid a pipe; fixed and locked in 36-03).
   - `set -o pipefail` (and `set -euo pipefail`-style bundles, and a shell's own `-o pipefail`) is
     recognised by token, not by substring, and only at the top level of the command.

3. **The severity map, as shipped (amended 2026-10-06).** "Policy" denies are returned `deny()` values;
   "thrown" denies are `FailClosed` errors. The Source column separates what CONTEXT decided from what
   the planner and executor added beyond it and what the 36-REVIEW fix pass changed; every row marked
   as a planner or review addition is a judgement a reviewer should challenge first.

   **Per-subcommand applicability (orchestrator-amended decision, 36-REVIEW M-01).** This reverses
   36-CONTEXT Addendum 7 ("no subcommands; a dispatch is a dispatch"), which rested on a false
   premise. Decided by the review orchestrator on the v1.8.0 source; awaiting Dave's approval with the
   rest of this record.

   | Invocation | ENF-23 pipe | ENF-23 dirty tree | ENF-24 viability | Grounds (v1.8.0 `cmd/gsd-test/main.go`) |
   |---|---|---|---|---|
   | classic (no subcommand) | yes | yes, unless `--base=` is empty | config + bench + Docker | ref-based; empty base runs the repo as-is |
   | `run` | yes | no | config + Docker | copies the working tree; its exit code is the verdict |
   | `submit` | no | no | only with a truthy `--execute` | without `--execute` it validates and echoes the spec; with it, `executeSpec` loads the config and dispatches (synchronously) |
   | `wait <run-id>` | yes | no | no | renders an earlier async run's verdict as its exit code |
   | `status <run-id>`, `install-agent-hooks` | no | no | no | read run state / install files |

   The orchestrator's brief graded `submit` "viability only (async; returns immediately)". The source
   shows `submit` is synchronous with `--execute` and touches nothing without it, so ENF-24 governs
   only `submit --execute`. The tested repo of `submit --execute` is the spec's `repo` field, which
   cannot be attributed; arming uses the start dir.

   | Condition | Decision | Grounds | Source |
   |---|---|---|---|
   | No gsd-test dispatch; only informational ones (`--version`, or `-h` / `--help` with any value, which Go answers with ErrHelp); a `command -v` lookup; a subcommand the gate does not govern | allow, zero I/O | RES-01 action-first ordering | CONTEXT; amended by 36-REVIEW B-01, M-01, M-05, N-03 |
   | `--probe-benches` | governed like any classic run | v1.8.0 probes bench reachability during `config.Load` and then runs the full suite; only `--version` returns before `runner.Run` | 36-REVIEW B-01 (CONTEXT had it informational: a false premise) |
   | The tested tree is not a gsd-core checkout | allow (passthrough) | ROB-01 out-of-tree precedent | CONTEXT |
   | Pipe-masked dispatch (`gsd-test ... \| tail` with no pipefail in force; the noclobber redirect `>\|` is not a pipe) | deny (policy, ENF-23) | CTK-ADR-0005 Decision 2: a measured certainty | CONTEXT; N-01 |
   | Dirty tracked tree and the run tests the working HEAD | deny (policy, ENF-23), lists up to 10 paths | CTK-ADR-0005 Decision 2 | CONTEXT |
   | Dirty tracked tree and `--head` is a shell expansion (`$(...)`, `$SHA`, backtick), treated as the working HEAD | deny (policy, ENF-23), asks for a literal ref | CTK-ADR-0005 Decision 2; conservative reading | planner addition |
   | Classic `--base=` (empty) | no dirty-tree check (the pipe check still applies) | verified: `worktree.Prepare` returns the repo as-is for an empty base. An expanded `--base "$B"` stays on the dirty path | 36-REVIEW M-01 |
   | Empty `--config=` or `--bench=` read as the default (default config path; `defaults.pin`) | as for the default | verified: `config.Load("")` uses `defaultConfigPath`; `runner.ResolveEffective` falls back to `defaults.pin` / `defaults.exclude` | planner addition, verified by 36-REVIEW |
   | Empty `--head=` read as the working HEAD | deny on a dirty tree | over-deny: v1.8.0 `refs.Resolve` rejects an empty ref, so gsd-test exits 2 before any run | planner addition; 36-REVIEW records it as harmless |
   | Default config path | `$XDG_CONFIG_HOME/gsd-test/config.toml` for any non-empty value (a relative one resolves against the start dir), else `$HOME/.config/gsd-test/config.toml`, read from the gsd-test process environment | verified: `config.go` `defaultConfigPath` joins the value with no absolute check (it is not `os.UserConfigDir`) | 36-REVIEW m-02 (the gate used to ignore a relative value) |
   | The command sets HOME, XDG_CONFIG_HOME, DOCKER_HOST or DOCKER_CONTEXT (`NAME=v gsd-test`, `env NAME=v`, `export`, `unset`, `env -u`) | honoured: the config path and the probed daemon follow it | the gate checks what gsd-test will actually read | 36-REVIEW m-02 |
   | Such a value cannot be resolved statically (an expansion, `env -i` leaving no HOME, `sudo`'s env reset, `export -n`) | ask | CTK-ADR-0007 Decision 2: unobtainable input -> ask | 36-REVIEW m-02 |
   | Config file absent | deny (policy, ENF-24) | CTK-ADR-0005 Decision 2 | CONTEXT |
   | Config path not a regular file, over 1 MiB, or unreadable | deny (thrown) | HARD-01 (CTK-ADR-0001 Decision 2) | CONTEXT |
   | `--config` value is a shell expansion that cannot be resolved statically | ask | CTK-ADR-0007 Decision 2: unobtainable input -> ask | planner addition |
   | `--bench` value is a shell expansion that cannot be resolved statically | ask | CTK-ADR-0007 Decision 2 | planner addition |
   | Named bench not in any `[[benches]]` block | deny (policy, ENF-24), lists configured names only | CTK-ADR-0005 Decision 2 | CONTEXT |
   | Which bench the probe is for | `--bench`, else `defaults.pin`, else the benches left after `--exclude` / `defaults.exclude`; `run` and `submit --execute` pick from every bench. The local probe runs if that bench may be local; with no candidate left it still runs | `runner.ResolveEffective`; `dispatchRun` uses `bench.Options{}` | 36-REVIEW m-08 |
   | A bench whose host is absent, empty or `local` | local (probed) | verified: `config.go` `Host: rb.Host, // empty is fine — means local` | 36-REVIEW m-08 (CONTEXT said "host not exactly `local` skips the probe": a false premise in the bypass direction) |
   | A remote-only choice (`ssh://...`) | local probe skipped, allow | remote probing deferred | CONTEXT |
   | No `docker` CLI (spawn ENOENT) | deny (policy, ENF-24) | CTK-ADR-0005 Decision 2 | CONTEXT |
   | `docker info` exits non-zero (daemon down) | deny (policy, ENF-24), with the first stderr line | CTK-ADR-0005 Decision 2 | CONTEXT |
   | `docker info` overruns its bound (spawnSync `ETIMEDOUT`) | ask | CTK-ADR-0007 Decision 2 | CONTEXT |
   | `docker info` killed by any other signal | deny (thrown) | an unknown probe state, not a timeout | 36-REVIEW m-05 |
   | Uncertain command: unparseable, ambiguous wrapper, `-c` / `eval` payload past depth 2 | deny (thrown) | HARD-01 | CONTEXT; M-04 |
   | Unattributable argument list: open substitution at segment end, expansion in flag position, flag value missing | deny (thrown) | HARD-01 | planner addition |
   | `-source` value cannot be resolved statically | deny (thrown) | HARD-01 | planner addition |
   | An earlier `cd` target cannot be resolved (`cd "$X"`, `cd ~user`, `cd -`, a `cd` option other than `-L`/`-P`/`-e`/`-@`/`--`), or an `env -C` / `sudo -D` directory cannot | deny (thrown) | HARD-01 | planner addition; M-02, M-03 |
   | The gate's shared 15 s subprocess budget is spent (`GATE_BUDGET_MS`; each git call or probe gets the smaller of its own bound and what remains) | deny (thrown) | a hook the harness kills at 20 s emits no deny | 36-REVIEW m-06 |
   | git failure, unexpected probe error, unknown probe state | deny (thrown) | HARD-01 | CONTEXT |

   Across several dispatches in one command: any policy deny beats a thrown error (an uncertain entry
   or a dispatch whose check threw), a thrown error beats an ask, and an ask beats allow
   (36-REVIEW m-01; previously an uncertain entry threw before any dispatch was checked).

4. **Override semantics.** A returned policy deny (pipe, dirty tree, missing config, unknown bench,
   Docker missing or down) is **not** escapable through `GSD_CONTRIB_OVERRIDE`. That valve rescues
   thrown errors only, and records a receipt when it does (CTK-ADR-0001 Decision 4). Because a policy
   deny cannot be overridden, every policy reason names the real fix: commit or stash and re-run, run
   unpiped or prefix `set -o pipefail;` or redirect to a file, restore the config, use a configured
   bench name, start Docker. A thrown deny (git failure, unreadable config, an unresolvable path,
   an uncertain command, a spent budget) is override-escapable with a receipt. Because a thrown
   error is override-escapable, the gates evaluate every attributable dispatch before throwing:
   otherwise `gsd-test | tail; gsd-test $X` let the override lift the pipe deny through the uncertain
   neighbour (36-REVIEW m-01). A command with no attributable dispatch still throws with zero I/O.

5. **Arming.** The gates act only when the tested tree is a gsd-core checkout. The tested tree is the
   `-source` value resolved against the dispatch's own start dir, or else that start dir. The start dir
   follows the `cd` prefixes that persist to the dispatch (a closed `( )` subshell discards its `cd`;
   a `{ }` group keeps it; `git -C` does not move the shell). A `cd` target is read past bash's
   options (`-L`, `-P`, `-e`, `-@`, clustered or not, and `--`); a bare `cd` goes to `$HOME`
   (36-REVIEW M-02, N-05). `env -C <dir>` / `env --chdir[=]<dir>` and `sudo -D <dir>` /
   `sudo --chdir[=]<dir>` move the start dir of their own segment (36-REVIEW M-03; previously `sudo -D`
   hid the dispatch and `env -C` lost the directory). `$HOME`, `${HOME}`, `$XDG_CONFIG_HOME` and `~`
   expand statically; any other `$` or backtick target is unresolved and fails closed. These fixes
   live in the detector; `resolve.cjs` and `classify.cjs` are unchanged.

6. **"Tests the working HEAD"** means: `--head` omitted, `HEAD`, `@`, empty, a literal ref whose
   `git rev-parse --verify` commit equals HEAD's, or a shell-expansion value. The last is conservative
   on purpose: Trek-e's own deny text names `--head $(git rev-parse HEAD)` as a trap, and an expansion
   is never passed to git. Any other literal ref (`--head origin/next`, a different sha) is a
   deliberate ref-against-ref run, so a dirty tree is irrelevant and the gate allows. The ref lookup
   runs as an argv array with `--end-of-options` and `^{commit}`, so an option-shaped `--head` is
   inert. The dirty check is `git --no-optional-locks status --porcelain --untracked-files=no`. Each
   git call is bounded at 5 s and by the gate's shared 15 s budget, read only, and cached within a
   single gate call (status per root; a ref lookup per root and ref, 36-REVIEW m-06). This applies to
   the classic path only: `run`, `wait` and a classic empty `--base=` test the working tree.

### Trek-e provenance and divergences

The family adopts Trek-e's first two traps and his viability idea. It diverges deliberately where the
toolkit's own records already decide the question:

| Trek-e behaviour | Toolkit behaviour | Why |
|---|---|---|
| `GSD_HUMAN_OVERRIDE=1` in the command text is a human-only escape token | No escape token. Policy denies are not escapable; thrown errors are, via `GSD_CONTRIB_OVERRIDE` with a receipt | A token the agent can type is self-applicable; CTK-ADR-0001 Decision 4 already defines the one accountable valve |
| `git status --porcelain` counts untracked files | `--untracked-files=no`: tracked changes only | An untracked scratch file is not the false-green incident and would add noise (CTK-ADR-0005 Decision 2) |
| `git status ... \|\| true`: a git failure reads as clean | A git failure is a thrown deny | HARD-01 (CTK-ADR-0001 Decision 2) |
| Trap 3: `--head <40-hex>` required | Out of scope, deferred (CONTEXT) | Trap 3 protects a PostToolUse verdict recorder (Trek-e's `record-gsd-verdict.sh`) that the toolkit does not ship |
| Remote probe: `DOCKER_HOST=ssh://<bench> docker version`, two attempts | Local `docker info --format '{{.ServerVersion}}'` only, for a bench with host `local` or no bench named; 8 s, SIGKILL, no shell | The only configured bench here is local; remote probing is deferred |
| `pipefail` anywhere in the command, by substring | `set -o pipefail` by token, top level only; a shell's own `-o pipefail` for its `-c` payload | A substring test is satisfied by `echo pipefail` or a subshell `set` that does not reach the pipe |
| `run`, `wait`, `submit` subcommands exempted | Per-subcommand map (Decision 3): `run` and `wait` keep the pipe deny, `run` and `submit --execute` keep viability, none keeps the dirty-tree deny | The original row said "gsd-test v1.8.0 has no subcommands"; that was false (36-REVIEW M-01). Trek-e's blanket exemption also drops the pipe and viability checks, which still apply |
| `--dry-run` let through | No special case | The flag does not exist in v1.8.0 |
| Legacy pre-Go client on PATH denied; legacy `hosts` config layout denied | Both checks dropped | v1.8.0 is the client on PATH here; the legacy layout does not exist |

## Consequences

- **Positive:** each incident shape becomes an immediate deny at the moment of dispatch, with the fix
  in the reason: a dirty working-HEAD run, a pipe that hides the exit status, a missing config, an
  unknown bench, a missing or stopped Docker. A non-gsd-test Bash command costs no I/O at all.
- **Positive:** the detector is reusable. A later gate on another dispatch-shaped command can follow
  the same placement (a separate predicate beside `classifyAction`, never inside it).

**Negative / accepted residuals.** The gates are not complete, and nothing here makes them
unbypassable. Known gaps, largest first:

- **A newline-joined multi-line command is invisible.** `argv.splitSegments` treats an unquoted newline
  as whitespace, so with `cd X` on one line and `gsd-test ... | tail` on the next, the dispatch lands
  inside a segment whose program is `cd`. Neither gate sees it, and the same is true of every other Bash gate's
  segment classification. This is the largest remaining false negative. It is not fixed here because
  changing the splitter changes every gate's classification; it is seeded as its own decision
  (`SEED-argv-newline-separator-gap`).
- **`&` as a separator.** `a & gsd-test ...` is not split on the lone `&`, the same shared argv gap.
- **Command substitution of any kind is invisible**, not only `$(gsd-test)` as a program: an
  assignment capture (`OUT=$(gsd-test --head HEAD 2>&1); echo "$OUT" | tail`,
  `x=$(gsd-test | tail -5)`) and an argument (``echo `gsd-test` ``) bypass both the pipe and the
  dirty-tree checks (36-REVIEW m-03). Grading every `$(`/backtick span that names gsd-test as
  uncertain was rejected: it would deny every heredoc commit message that mentions gsd-test, a common
  pattern in this repository.
- **gsd-test reached as something other than a program word:** `xargs gsd-test`, the wrappers outside
  the closed set in Decision 2 (`setsid`, `script -qc`, `unbuffer`, `flock`, `watch`, `chronic`,
  `builtin command`), a here-string or a pipe into `bash`, a `case` arm, and invocations fed from a
  script, a Makefile or a heredoc (36-REVIEW m-04).
- **`source` / `.` and shell functions are not followed.** An environment change made by a sourced
  file is not seen, and a `cd` target is expanded with the hook's environment even after an earlier
  `export HOME=...` in the same command.
- **Non-pipe exit masking is out of scope:** `gsd-test || true`, `gsd-test; echo done`.
- **A grouped `set -o pipefail` is ignored.** `{ set -o pipefail; gsd-test | tail; }` stays masked and
  denies. This is a fail-safe false positive, not a bypass. (A `set -o pipefail` inside a separate
  subshell, `(set -o pipefail); gsd-test | tail`, is correctly denied; it is not a residual.)
- **A `$VAR` value that word-splits into extra flags** (`--head $SHA` where `SHA` holds
  `x --source y`) is read as a single value.
- **Remote benches are not probed.** A bench whose host is set and is not `local` skips the local
  Docker probe. (A bench with no host is local in v1.8.0 and is probed.)
- **An unresolvable `--config` or `--bench` asks and stops there.** That dispatch's bench check and
  Docker probe do not run, so a dead daemon behind `--config $CFG` reaches the user only as the ask.
- **`ask` is not a block.** The docker-timeout path, both unresolvable-value paths and the
  unresolvable-environment paths (36-REVIEW m-02) `ask`, and `ask`
  degrades to allow under `--dangerously-skip-permissions` and in any unattended run (the same limit
  CTK-ADR-0005 and CTK-ADR-0007 record). The reason text says so.
- **No `ask` proof kind.** `bin/verify-hooks.cjs` proves deny and allow at the real entrypoints only;
  the `ask` paths are unit-proven in `hooks/gsd-test-viability.test.cjs`
  (`SEED-enf22-residual-merge-continue-and-ask-proof-kind`). The dirty-tree and Docker denies are also
  unit-proven with injected dependencies and real temporary git repos, because a standing proof of
  them would depend on the machine's state.
- **A harness-killed hook does not deliver a deny.** If the harness kills a hook at its timeout, the
  hook emits no deny. Each gate now shares one 15 s budget across all of its subprocesses (36-REVIEW
  m-06), so N dispatches with distinct literal `--head` values, or N distinct `DOCKER_HOST`
  selections, end in a thrown deny instead of a 20 s kill. Node start-up and the verdict-log write
  still sit outside the budget; `settings.snippet.test.cjs` keeps 3 s of headroom.
- **Empty flag values were verified against the v1.8.0 source, not by running gsd-test.** `--config=`
  and `--bench=` fall back to the defaults; `--base=` runs the working tree; `--head=` makes gsd-test
  exit 2 before a run, so the dirty-tree deny it draws is a harmless over-deny.
- **Unknown flags are recorded silently** (36-REVIEW N-06). An undefined flag (`gsd-test --keep`) makes
  Go exit 2 with no run, but the walker records it as a boolean and the dispatch is still checked, so
  it can draw a dirty-tree deny. Treating it as inert was rejected: if the gate's flag table ever lags
  gsd-test, an inert reading would let a real run through.
- **`--skip-worktree` / `--assume-unchanged` changes are invisible** to `git status --porcelain`, so
  such a dirty tree reads as clean (36-REVIEW N-04; git 2.43).
- **`run --async | tail` draws the pipe deny** although `--async` returns exit 0 at once and the verdict
  arrives through `wait`. The pipe map is per subcommand, not per flag; the over-deny is accepted.
- **`submit --execute`'s tested repo is the spec's `repo` field.** It is not attributed; arming uses the
  dispatch's start dir.
- **The noclobber split.** argv splits `>|` on its `|`; the detector reads a segment that ends in a
  bare `>` before `|` as that redirect, but flags written after `>| file` are not read.
- **Quoting edge:** a double-quoted `$(...)` whose nested quotes leave argv's quote view out of step
  with an unquoted paren later in the same command is graded uncertain and denies when the command
  names gsd-test. Since 37-REVIEW MA-04 (the shared walk, fixed for ENF-25) `pushd <dir>`,
  `builtin cd` and `command cd` are followed as start-dir changes, and `popd`, a bare `pushd`,
  `pushd -n` and `pushd +N` / `-N` make the start dir unresolvable, so the gate fails closed.
- **The bench deny echoes configured bench names only** (at most 20, each clipped to 64 characters),
  never hosts, users or other config values.
- **Registration fact:** `capabilities/contribution-toolkit/capability.json` `hooks[]` is hand-
  maintained. `bin/build-capability.cjs` only stamps `version`; it copies hook files into the bundle
  but does not derive the manifest's entries. `verify-capability`'s `surface-hooks` check is what
  catches a missing hand-mirror. The next gate's plan must list the manifest edit as a hand step.
- **Deferred documentation drift** (out of this phase's scope): comments in `hooks/lib/verdict-log.cjs`,
  `hooks/lib/failclosed.cjs` and their tests still give an older wired-gate count; and the capability
  README's opening claim that every PreToolUse gate calls gsd-core's LIVE scripts has not been true
  since ENF-21, and is now further from true with these toolkit-owned gates.
- **Not projected into the bundle.** The bundle carries only docs linked from a projected skill. No
  skill links this record, so it ships in the repository but not in the capability bundle, like
  CTK-ADR-0001 through CTK-ADR-0006.
- **Honesty constraint (inherited):** CTK-ADR-0001's rule applies unchanged. Any blocking property
  belongs to the installed hooks running under Claude Code, not to the toolkit as a thing-in-itself.
  This family adds blocking denies on the dispatch surface and `ask` on four kinds of path (Docker
  timeout, an unresolvable `--config` or `--bench`, an unresolvable environment variable); it does not make
  the suite unbypassable.

## Amendment: 36-REVIEW corrections (2026-10-06)

The Phase 36 code review read the gsd-test v1.8.0 source (`open-gsd/gsd-test-runner@v1.8.0`:
`cmd/gsd-test/main.go`, `internal/runner/runner.go`, `internal/runner/policy.go`,
`internal/worktree/worktree.go`, `internal/config/config.go`, `internal/refs/refs.go`) and found four
premises of the original record false. The record is still Proposed, so the corrections are made in
place and listed here:

1. **`--probe-benches` is not informational.** It runs the full suite after probing benches (B-01).
2. **v1.8.0 has subcommands** (`submit`, `run`, `install-agent-hooks`, `wait`, `status`), and `run`
   tests the working tree. The per-subcommand map in Decision 3 replaces "a dispatch is a dispatch"
   (M-01, an orchestrator-amended decision awaiting Dave's approval).
3. **A bench with no host is local**, so it is probed (m-08). CONTEXT had it skip the probe.
4. **A relative `XDG_CONFIG_HOME` is used as given**, relative to gsd-test's working directory; the
   gate used to fall back to the home default (m-02). The review itself attributed this to
   `os.UserConfigDir`; the source shows a plain `os.Getenv` + `filepath.Join`.

Outside this repository, Dave's `~/.claude/commands/gsd-docker-test.md` tells agents that
`gsd-test --probe-benches` checks bench reachability without running tests, and its step 1 says
gsd-test rsyncs the working tree. Both are wrong for v1.8.0's classic path. This record does not edit
that file; it is listed for Dave in the 36-REVIEW dispositions.

## Alternatives considered

- **A `gsd-test` action in `classifyAction`.** Rejected: a new action can displace `pr-merge` or a
  review-side action in a chained command and disarm ENF-20 (the ENF-22 lesson). A separate predicate
  gets the same detection with no effect on any other gate.
- **Fix argv's newline and `&` splitting in this phase.** Rejected: every Bash gate's classification
  would change at once. That needs its own decision, gated by a frozen-corpus diff of
  `classifyAction` output, and is seeded instead.
- **Count untracked files as dirty (Trek-e parity).** Rejected: noise without the incident behind it
  (CTK-ADR-0005 Decision 2).
- **Deny when `docker info` overruns.** Rejected: an overrun is an unobtainable input, not a measured
  fact, and CTK-ADR-0007 Decision 2 resolves that case to `ask`. A slow Docker Desktop start must not
  read as "Docker is down".
- **A self-applicable escape token** (Trek-e's `GSD_HUMAN_OVERRIDE=1`). Rejected: any token the agent
  can type into the command is an agent bypass. The accountable valve already exists.
- **Exempt `run`, `wait` and `submit` wholesale (Trek-e parity).** Rejected: `run` and `wait` return the
  verdict as their exit code, so the pipe trap applies to them, and `run` / `submit --execute` need a
  viable environment.
- **Fix `cd` options and `env -C` / `sudo -D` in `resolve.cjs` / `classify.cjs`.** Rejected for this
  phase: every gate's cwd resolution and program classification would change at once; the fixes are
  detector-local.
- **Treat an unattributable argument list as "no flags".** Rejected: silently skipping what cannot be
  read is a bypass. `gsd-test $EXTRA` could carry `--head HEAD` or nothing; the gate cannot tell, so it
  fails closed.
- **Enforce at push time only (rely on `lint-ci-marker`).** Rejected: see Context. The verdict is acted
  on before the push.
