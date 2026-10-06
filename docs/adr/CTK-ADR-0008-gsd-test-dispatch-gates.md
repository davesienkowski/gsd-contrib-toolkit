# CTK-ADR-0008: Gate gsd-test dispatches at dispatch time (clean tree, unmasked exit, viable run)

- **Status:** Proposed. Dave has not approved this record. It becomes Accepted, or is superseded, only
  by his explicit sign-off; until then it documents a decision implemented on a branch, not an approved
  one.
- **Review:** Published for maintainer review and open to revision. A changed decision will be recorded
  by a superseding or amending CTK-ADR, never by a silent edit to an accepted record.
- **Date:** 2026-10-05 (milestone v2.8)
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

`gsd-test` (v1.8.0, the Go runner) is the contributor's bench for the gsd-core suite. It is
**ref-based**: it resolves `--base` and `--head` to commits, clones them, and merges them in a
container. It never tests the files in the working tree. Its verdict is therefore only as good as the
invocation that produced it, and the invocation is written by an agent under time pressure.

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
   - `bash -c` / `sh -c` payloads are re-parsed through the existing `argv.parseCommand`, bounded at
     depth 2. A payload past that depth that names gsd-test is graded uncertain.
   - Go's flag package accepts `-f v`, `--f v`, `-f=v` and `--f=v`; `argv.classifyTokens` misreads
     single-dash long flags, so the detector carries its own small flag walker. The walker attributes
     every token inside a `$(...)` or backtick value to that value, so flags after
     `--head $(git rev-parse HEAD)` are still read. An argument list it cannot attribute is graded
     uncertain, never read as "no flags".
   - Grouping is quote-aware: only unquoted, unescaped `( ) { } &` affect pipe attribution and `cd`
     scoping (a quoted paren once hid a pipe; fixed and locked in 36-03).
   - `set -o pipefail` (and `set -euo pipefail`-style bundles, and a shell's own `-o pipefail`) is
     recognised by token, not by substring, and only at the top level of the command.

3. **The severity map, as shipped.** "Policy" denies are returned `deny()` values; "thrown" denies are
   `FailClosed` errors. The Source column separates what CONTEXT decided from what the planner and
   executor added beyond it; every row marked as a planner addition is a judgement a reviewer should
   challenge first.

   | Condition | Decision | Grounds | Source |
   |---|---|---|---|
   | No gsd-test dispatch, or only informational ones (`--version`, `-h`, `--help`, `--probe-benches`) | allow, zero I/O | RES-01 action-first ordering | CONTEXT |
   | The tested tree is not a gsd-core checkout | allow (passthrough) | ROB-01 out-of-tree precedent | CONTEXT |
   | Pipe-masked dispatch (`gsd-test ... \| tail` with no pipefail in force) | deny (policy, ENF-23) | CTK-ADR-0005 Decision 2: a measured certainty | CONTEXT |
   | Dirty tracked tree and the run tests the working HEAD | deny (policy, ENF-23), lists up to 10 paths | CTK-ADR-0005 Decision 2 | CONTEXT |
   | Dirty tracked tree and `--head` is a shell expansion (`$(...)`, `$SHA`, backtick), treated as the working HEAD | deny (policy, ENF-23), asks for a literal ref | CTK-ADR-0005 Decision 2; conservative reading | planner addition |
   | Empty `--head=`, `--config=` or `--bench=` read as the default (working HEAD, default config path, no bench) | as for the default | Go passes an empty value; not verified against gsd-test itself | planner addition |
   | Config file absent | deny (policy, ENF-24) | CTK-ADR-0005 Decision 2 | CONTEXT |
   | Config path not a regular file, over 1 MiB, or unreadable | deny (thrown) | HARD-01 (CTK-ADR-0001 Decision 2) | CONTEXT |
   | `--config` value is a shell expansion that cannot be resolved statically | ask | CTK-ADR-0007 Decision 2: unobtainable input -> ask | planner addition |
   | `--bench` value is a shell expansion that cannot be resolved statically | ask | CTK-ADR-0007 Decision 2 | planner addition |
   | Named bench not in any `[[benches]]` block | deny (policy, ENF-24), lists configured names only | CTK-ADR-0005 Decision 2 | CONTEXT |
   | Named bench's host is not exactly `local` | local probe skipped, allow | remote probing deferred | CONTEXT |
   | No `docker` CLI (spawn ENOENT) | deny (policy, ENF-24) | CTK-ADR-0005 Decision 2 | CONTEXT |
   | `docker info` exits non-zero (daemon down) | deny (policy, ENF-24), with the first stderr line | CTK-ADR-0005 Decision 2 | CONTEXT |
   | `docker info` overruns its 8 s bound | ask | CTK-ADR-0007 Decision 2 | CONTEXT |
   | Uncertain command: unparseable, ambiguous wrapper, `-c` payload past depth 2 | deny (thrown) | HARD-01 | CONTEXT |
   | Unattributable argument list: open substitution at segment end, expansion in flag position, flag value missing | deny (thrown) | HARD-01 | planner addition |
   | `-source` value cannot be resolved statically | deny (thrown) | HARD-01 | planner addition |
   | An earlier `cd` target cannot be resolved (`cd "$X"`, `cd ~user`, `cd -`) | deny (thrown) | HARD-01 | planner addition |
   | git failure, unexpected probe error, unknown probe state | deny (thrown) | HARD-01 | CONTEXT |

   Across several dispatches in one command, any deny beats any ask, and an ask beats allow.

4. **Override semantics.** A returned policy deny (pipe, dirty tree, missing config, unknown bench,
   Docker missing or down) is **not** escapable through `GSD_CONTRIB_OVERRIDE`. That valve rescues
   thrown errors only, and records a receipt when it does (CTK-ADR-0001 Decision 4). Because a policy
   deny cannot be overridden, every policy reason names the real fix: commit or stash and re-run, run
   unpiped or prefix `set -o pipefail;` or redirect to a file, restore the config, use a configured
   bench name, start Docker. A thrown deny (git failure, unreadable config, an unresolvable path,
   an uncertain command) is override-escapable with a receipt.

5. **Arming.** The gates act only when the tested tree is a gsd-core checkout. The tested tree is the
   `-source` value resolved against the dispatch's own start dir, or else that start dir. The start dir
   follows the `cd` prefixes that persist to the dispatch (a closed `( )` subshell discards its `cd`;
   a `{ }` group keeps it; `git -C` does not move the shell). `$HOME`, `${HOME}`, `$XDG_CONFIG_HOME`
   and `~` expand statically; any other `$` or backtick target is unresolved and fails closed.

6. **"Tests the working HEAD"** means: `--head` omitted, `HEAD`, `@`, empty, a literal ref whose
   `git rev-parse --verify` commit equals HEAD's, or a shell-expansion value. The last is conservative
   on purpose: Trek-e's own deny text names `--head $(git rev-parse HEAD)` as a trap, and an expansion
   is never passed to git. Any other literal ref (`--head origin/next`, a different sha) is a
   deliberate ref-against-ref run, so a dirty tree is irrelevant and the gate allows. The ref lookup
   runs as an argv array with `--end-of-options` and `^{commit}`, so an option-shaped `--head` is
   inert. The dirty check is `git --no-optional-locks status --porcelain --untracked-files=no`. Both
   git calls are bounded at 5 s, read only, and cached per root within a single gate call.

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
| `run`, `wait`, `submit` subcommands exempted | No exemption | gsd-test v1.8.0 has no subcommands; a dispatch is a dispatch |
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
- **gsd-test reached as something other than a program word:** `$(gsd-test)` or backtick embedding as
  a program, `xargs gsd-test`, and invocations fed from a script, a Makefile or a heredoc.
- **Non-pipe exit masking is out of scope:** `gsd-test || true`, `gsd-test; echo done`.
- **A grouped `set -o pipefail` is ignored.** `{ set -o pipefail; gsd-test | tail; }` stays masked and
  denies. This is a fail-safe false positive, not a bypass. (A `set -o pipefail` inside a separate
  subshell, `(set -o pipefail); gsd-test | tail`, is correctly denied; it is not a residual.)
- **A `$VAR` value that word-splits into extra flags** (`--head $SHA` where `SHA` holds
  `x --source y`) is read as a single value.
- **Remote or unspecified-host benches are not probed.** A bench whose host is not exactly `local`
  skips the Docker probe.
- **An unresolvable `--config` or `--bench` asks and stops there.** That dispatch's bench check and
  Docker probe do not run, so a dead daemon behind `--config $CFG` reaches the user only as the ask.
- **`ask` is not a block.** The docker-timeout path and both unresolvable-value paths `ask`, and `ask`
  degrades to allow under `--dangerously-skip-permissions` and in any unattended run (the same limit
  CTK-ADR-0005 and CTK-ADR-0007 record). The reason text says so.
- **No `ask` proof kind.** `bin/verify-hooks.cjs` proves deny and allow at the real entrypoints only;
  the `ask` paths are unit-proven in `hooks/gsd-test-viability.test.cjs`
  (`SEED-enf22-residual-merge-continue-and-ask-proof-kind`). The dirty-tree and Docker denies are also
  unit-proven with injected dependencies and real temporary git repos, because a standing proof of
  them would depend on the machine's state.
- **A harness-killed hook does not deliver a deny.** If the harness kills a hook at its timeout, the
  hook emits no deny. The 20 s timeout exceeds each module's bound (8 s Docker probe; 5 s per git
  call), but a single command that dispatches into several distinct trees can make more git calls than
  the bound assumes.
- **Empty flag values are a judgement.** Reading `--head=`, `--config=` and `--bench=` as the default
  mirrors Go's flag semantics but was not verified by running gsd-test.
- **Quoting edge:** a double-quoted `$(...)` whose nested quotes leave argv's quote view out of step
  with an unquoted paren later in the same command is graded uncertain and denies when the command
  names gsd-test. `pushd` and `popd` are not followed as start-dir changes.
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
  This family adds blocking denies on the dispatch surface and `ask` on three paths; it does not make
  the suite unbypassable.

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
- **Treat an unattributable argument list as "no flags".** Rejected: silently skipping what cannot be
  read is a bypass. `gsd-test $EXTRA` could carry `--head HEAD` or nothing; the gate cannot tell, so it
  fails closed.
- **Enforce at push time only (rely on `lint-ci-marker`).** Rejected: see Context. The verdict is acted
  on before the push.
