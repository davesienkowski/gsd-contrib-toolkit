# CTK-ADR-0015: ENF-13 accepts a dispatcher that passes a delegation canary

- **Status:** Proposed (2026-11-03), implemented on the `davesienkowski/fix-enf13-dispatcher` branch (quick
  261103-uqe), awaits Dave's sign-off.
- **Review:** Published for maintainer review and open to revision. A changed decision will be recorded by a
  superseding or amending CTK-ADR, never by a silent edit to an accepted record.
- **Date:** 2026-11-03 (milestone v2.8).
- **Scope:** GSD Contribution Toolkit: `hooks/githooks-seal.cjs` and its bundle copy. ENF-13 only: the ENF-12
  code and text, `hooks/lib/argv.cjs`, `hooks/lib/classify.cjs` and `hooks/lib/resolve.cjs` are unchanged.
- **Relates to:** CTK-ADR-0001 Decision 1 (enforce at the harness boundary) and Decision 2 (gates fail closed);
  CTK-ADR-0009 (a gate may take a bounded action). No record defines ENF-13 (the rule lived in the hook's
  docstring and in `README.md`), so this record amends none.
- **Trigger:** a session-wide hooks dispatcher set through env config makes `git config --get core.hooksPath`
  print the dispatcher's path with scope `command`, in every checkout. ENF-13 then denied every commit and push
  from any session that loads the toolkit gates, with an INERT claim that was false (the dispatcher runs the
  repo's hooks) and a suggested fix that changed nothing (env config outranks repo config). The seal's tests
  passed: all of them injected the read.

## Context

ENF-13 denies a commit or push whose effective `core.hooksPath` is not `.githooks`, so a contributor cannot
commit with the repo's own gates inert. A dispatcher breaks the equation "effective value `.githooks` means the
gates run". Its stubs run a delegate that voids the env count key, asks git for the repo's own hooks directory
and runs the hook found there, so the gates run while the effective value names something else.

The reads in the hook run in the hook's env. They cannot see an override typed in the command, such as
`git -c core.hooksPath=/dev/null commit`. Before this record, those commands denied behind the dispatcher only
as a side effect of the false deny; with no dispatcher in force they were allowed. Removing the false deny
without replacing it would have turned them into allows.

The dispatcher is not vendored and is not identified by path: this repo is public, the dispatcher lives in
another repo, and its bytes change often.

## Decision

1. **The check order, which is load-bearing.** The canary executes a file named by a config value, so it runs
   last and only for a value that came from the hook's own env keys. After ENF-12 and the typed scan of
   Decision 2:

   | Step | Check | Result |
   |---|---|---|
   | (a) | Effective read, minus one trailing newline, no trim, is exactly `.githooks` | allow |
   | (b) | Voided read: the same read with the child env minus `GIT_CONFIG_COUNT` only, as the delegate does; `GIT_CONFIG_PARAMETERS` is never voided | continue |
   | (c) | Voided read equals the effective read: voiding changed nothing, so the value did not come from the count key. Then the scope read, on this branch only | deny: today's text A for any scope but `command`; text C for scope `command` or a failed scope read. Nothing runs |
   | (d) | `dispatcherShape`: absolute path, basename exactly `githooks-dispatch`, a directory, `_delegate.sh` a regular file, `pre-commit` and `pre-push` regular files with an exec bit. Every fs error is a shape failure | deny: text C. Nothing runs |
   | (e) | Voided read is exactly `.githooks` | deny: text B, naming the repo value or UNSET. Nothing runs |
   | - | A hook-skipping spelling ENF-12 does not see (Decision 2, last paragraph) | deny: text D. Nothing runs |
   | (f) | `runDispatcherCanary` passes | deny: text C with the marker and the exit or signal |
   | (g) | All of the above held | allow |

   The compares are byte-exact, so `.githooks ` (a quoted trailing space) and `.GITHOOKS` deny with or without a
   dispatcher. Text A is the only text that says INERT, in the state where it is true. Text B gives the fix that
   works there: `git config core.hooksPath .githooks` writes the value the delegate reads, the effective value
   stays the dispatcher, and if a session gate stops an agent's write, a human runs it in their own terminal.
   Text C says `git config` cannot fix it. Text D names the form.

2. **The typed scan.** `typedHooksPathOverride` reads the command text, before any config read, including with
   no dispatcher in force. It fails closed on the forms in the families table. Other forms, including some the
   parser sees as git, are listed or not known. Its region is the tokens after the program of a sealed git
   segment (program `git`, a bare `commit` or `push` token) up to the last such token. It needs no list of git's
   options to fail closed, so an override after `-C`, `--no-pager` or `--shallow-file` denies, and a message after
   the last sealing token is never read. It reads the newline split of the command, so a neighbor line neither
   widens a region nor hides a form, and it first:
   - removes heredoc operators, bodies and terminators with `argv.cjs`'s exported helpers, so a body never
     reaches the scan; the masked text that does not parse is refused when the default parse holds a sealed
     segment, never scanned through a body-bearing fallback;
   - strips leading newline characters from each token, so a backslash-newline does not hide a form;
   - stops at a token starting with `#`, except in the value positions it knows (after `-C`, `-c`, `-m`, `-F`,
     `-t`, `--namespace`, `--attr-source`, `--config-env`, `--message`), and ignores redirect tokens when it looks
     for a `git config` value.

   Families table. `k` is `core.hooksPath`; `K` is an env config key name (`GIT_CONFIG_COUNT`,
   `GIT_CONFIG_PARAMETERS`, `GIT_CONFIG_KEY_<n>`, `GIT_CONFIG_VALUE_<n>`).

   | Form, in a sealed segment's region or beside one | Verdict |
   |---|---|
   | `-c k=v`, `-c k`, `-c k=`, `--config-env=k=V`, `--config-env k=V`, in any case, in any position, repeated | deny; a `-c` value exactly `.githooks` does not hit |
   | `-c` or `--config-env` naming `include.path` or `includeif.<any>.path` | deny |
   | A config key holding anything outside `[A-Za-z0-9._:/*-]`: ANSI-C `$'...'`, `$K`, `$(...)` in the key | deny: the gate cannot read it |
   | A token with `$`, a backtick, `{` or `(`, outside the exempt positions (the token after `-C`, `--namespace`, `--attr-source`; the part after `=` of a `--long=value` token) | deny: the gate cannot read it |
   | `--git-dir`, `--work-tree`, either spelling; a leading `GIT_DIR=`, `GIT_WORK_TREE=` or `GIT_COMMON_DIR=` | deny: the checkout whose hooks run is not the one the gate read |
   | `K` as a whole word, or a built name `GIT_CONFIG_...$n`, before the program of any segment or in any token of a non-git segment, in a command with a sealed segment. Covers `export`, `export +=`, `declare`, `typeset`, `readonly`, `env`, `printf -v`, `read`, `for` | deny |
   | A `git config` write of `k`, `include.path` or `includeif.<any>.path`, including `--unset`, in a command with a sealed segment | deny, except a write of exactly `.githooks`, the advised fix |
   | `command`, `env`, `env -C`, bare `sudo`, bare `nice`, `timeout`, `stdbuf`, `exec`, a pipe or `/usr/bin/git` wrapping a form above | deny; the scan starts at the resolved program |
   | `git -C "$WT" commit`, `git -C "$(pwd)" commit`, `git -C dir push origin x`, `git --namespace=$N commit` | allow: exempt positions |
   | `-c user.name=x commit`, `-c commit.gpgsign=false commit`, `-c k=.githooks commit`, `-ck=v commit` (git rejects it, exit 129) | allow |
   | `git commit -c HEAD`, `git push -c k=v`, a trailing `git commit -c` | allow: after the last sealing token |
   | `git -c k=v status`, `git --git-dir=.git status; git commit`, `git log "$X"` then a commit on the next line | allow: not sealed |
   | A message naming a key or an option, on `-m`, in `$(cat <<'EOF' ...)`, in a heredoc body, or in a comment token | allow |
   | `git config --get k`, `--list`, bare `git config k`, `config get k`, each beside a commit | allow: reads |
   | `GIT_CONFIG_GLOBAL=x git commit`, `GIT_CONFIG_SYSTEM=x git commit`, `MY_GIT_CONFIG_COUNT=1 git commit` | allow: not these keys |

   Non-sealed commands with no typed hit stay allowed with no filesystem walk; a command with a typed hit reaches
   root resolution, and no gsd-core root still allows. This is new behavior with no dispatcher too: with an
   effective `.githooks` the deny rows of the table were allowed before this record.

   Spellings ENF-12 does not see (`--no-veri` and longer prefixes on commit and push, a short cluster such as
   `-qnm` or `-anm` on commit, a continuation before `--no-verify`) deny only on the dispatcher path, between (e)
   and (f). They denied behind the dispatcher only through the false deny this record removes, so this keeps that
   set and changes no other verdict: with an effective `.githooks` they stay allowed as they were. `-am "x"` and
   `-mn` are not hits. ENF-12 itself is unchanged, and it keeps its deny on `--no-verify` and `-n`.

3. **The canary, and why it may execute.** `resolve.cjs`'s sentinel probe deliberately executes nothing; this
   check differs because git runs this same file moments later for a commit, with the same privileges, and because
   by step (f) the value can only have come from the hook's env keys and has the shape of (d). The canary makes a
   mkdtemp repo whose `.githooks/pre-commit` writes a marker and exits 37, spawns `<value>/pre-commit` directly (no
   shell, stdio ignored, cwd the temp repo, git's location variables dropped from the env, the config keys kept),
   bound 5 s with SIGKILL, and removes the exact temp path in `finally`. It passes only when the marker exists and
   the exit status is exactly 37. For a push the file would not otherwise run; running `pre-commit` is still the
   only behavior this check observes. Measured against the real dispatcher: about 20 ms for the canary, 73 to 79 ms
   for the whole hook, against 31 to 44 ms for an ENF-12 deny that exits before any read.

4. **The override valve's reach.** A failed effective read, a failed voided read and a canary setup failure
   (mkdtemp, git init, writing the fixture) stay a thrown `FailClosed`, which a logged `GSD_CONTRIB_OVERRIDE` can
   lift, because the valve means a human deliberately setting it in the harness env with a receipt, and that
   matches every other gate fault. A shape failure (EACCES and ELOOP included), a canary that ran and failed
   (ENOENT, EACCES, a timeout and a signal included), a failed scope read and a typed-form deny are returned denies
   it cannot lift. None of the ENF-13 deny texts names the valve.

## Consequences

What the canary shows is one thing: this file ran a hook in one throwaway repo and passed its failing exit
through. It says nothing else about the file. Residuals, each accepted:

- **A faithful functional copy passes.** It does delegate, so the gates run; no identity is available without a
  personal path.
- **A forged dispatcher that detects the canary (by its temp path, say) passes.** Having one in force for a session
  takes a change to the hook's env (harness settings), and whoever can do that controls `PATH` and every gate's env.
  A repo-scope value never reaches the canary: it denies at step (c) and never runs.
- **An honest but wrong dispatcher passes** when it behaves only in an empty non-linked repo, or hardcodes
  `./.githooks`.
- **Only `pre-commit` is observed.** `pre-push` is checked as an executable file only, because running it would run
  another repo's push policy inside this gate. A dispatcher whose `pre-push` does not delegate passes this seal on
  a push.

Other consequences:

- **The dispatcher's own fail-open is inherited, and the canary cannot see it.** The real delegate prints one stderr
  line and exits 0 when it cannot resolve the repo's hooks dir. Measured with a planted `git` that exits 1 on
  `GIT_EXEC_PATH`: no dispatcher, exit 1 and the hook ran; real dispatcher, exit 0 and the hook did not run. The tests
  measure the same shape, and `git --exec-path=<planted> commit`, against the fixture delegate. This fix allows
  nothing behind the dispatcher that the no-dispatcher state denies, with the inherited dispatcher fail-open as the
  stated exception, and the env-value rows under "Reported, not closed" as a second one found by measurement. On every
  measured reported row the hook's own verdict behind the dispatcher is an allow only where its no-dispatcher verdict
  is an allow too; in these two exceptions the repo hook then stops the commit only with no dispatcher.
- **Coupling.** The basename `githooks-dispatch` and the dispatcher's `pre-commit` exit propagation are now a contract
  with another repo. A rename or a changed exit reintroduces a deny, fail-closed, with a text naming the canary result.
- **The real dispatcher is exercised only by the local end-to-end check.** The tests use a minimal fixture delegate,
  because the real bytes are not public. So a change in the dispatcher's repo surfaces as a live deny, not as a test
  failure here.
- **A noexec `TMPDIR` denies**, with a text that says so.
- **A hook timeout is fail-open.** The installed hook sets no timeout, the harness default is 600 s, and the Claude Code
  docs say a timed-out `PreToolUse` command hook does not block the tool call. That is why the bound uses SIGKILL: a stub
  that traps TERM would otherwise hold `spawnSync` past it. The killSignal on the canary's `git init` has no test.
- **Accepted false denies.** The scan reads no list of programs, so it cannot tell harmless uses apart; text D gives a way
  forward for each. On a local corpus of 2903 distinct commit or push commands, a prototype of the scan hit 10. The classes:
  - `env -u K git commit`, `unset K; git commit`, `echo K=v && git commit`, `grep K f; git commit`,
    `gh pr comment --body "... K ..." && git push` (a key named beside a commit).
  - `-c user.name=$N commit`, `--config-env user.name=$V commit`, `-c "http.extraHeader=... $T" push` (an unquoted value
    can word-split into options, and the parser drops quotes).
  - `-c 'url.git@x:.insteadOf=y' push` (`@` is outside the plain key characters).
  - `git commit -m "$M" -m push`, `git push "$R" commit`, `git add "$f" commit`, `git diff "$A" -- commit`,
    `git log "$R" -- push`, `git -c k=v log --grep commit` (a later positional spelled exactly `commit` or `push` widens the
    region).

### Reported, not closed

Each row was measured once with real bash and the fixture dispatcher, git 2.43.0: a real commit with no repo hook, and the
hook allows it, unless the row says otherwise. A PreToolUse parse is not complete, and this list makes no claim to be.

**The one everyday-shape gap in row 1 (dispatcher in force, repo value wrong or unset, must deny).** A second gsd-core
checkout reached through a variable: `git -C "$Q" commit`, `cd "$Q" && git commit`. The gate reads the cwd's tree, not the
target's, so a target whose repo value is unset commits with no repo hook (measured). Accepted because `git -C "$WT" commit` is itself
an everyday form that must stay allowed, linked worktrees share the config, and the literal form (`git -C <path> commit`)
follows the target and denies row 1.

**Denied before this record only through the false deny, and allowed now, the same verdict as with no dispatcher** (22 of
the measured rows; the hook at the base of this branch denied each of them behind the dispatcher, and this hook allows each
in both states):

- The second checkout rows above.
- Env set by shell constructs the scan cannot read: `export GIT_DIR=x; git commit` (lands in the other repo),
  `export GIT_WORK_TREE=x`, `GIT_WORK_TREE=x; export GIT_WORK_TREE`, the same on separate lines, and split-prefix built
  names (`a=GIT_CONFIG; export ${a}_VALUE_0=v`, `${a}_CONFIG_VALUE_0`, `export $(printf ...)=v`).
- Word-splits in exempt positions: `WT='. -c k=v'; git -C $WT commit`, `N='x -c k=v'; git --namespace $N commit`,
  `--namespace=$N`, `--exec-path=$X`.
- Repo config changed by anything other than a `git config` write the scan reads: `git config $K v`,
  `git config --remove-section core`, `git config --rename-section core x`, a shell append to `.git/config`, `sed -i` on it.
- Hooks removed from disk: `chmod -x .githooks/pre-commit`, `mv .githooks x`.
- The planted `git` rows above.

**The env-value rows: allowed in both states, weaker in effect behind the dispatcher.** The split-prefix built names above and a
leading `GIT_CONFIG_VALUE_0+=x git commit` set or extend the value key alone. With no dispatcher the count key is not in force, so
that changes nothing and the repo hook runs. Behind the dispatcher it moves the value in force and no hook runs. Setting all three
keys the same way would bypass the hook in both states; the dispatcher shortens the form, as it does for the planted `git` rows.

**No deny at the base of this branch, in any state, so no change:**

- Not seen as git by this parser: `! git ...`, `if git ...`, `{ git ...; }`, `(git ...)`, `echo $(git ...)`, `eval`, `sh -c`,
  `env -S`, `xargs`, `nohup`, `time`, `setsid -w`, `builtin command git`, `G=git; $G`, `$(command -v git)`, a git alias, a
  script file, a leading `K+=v git commit`, a leading redirect (`2>/dev/null git ...`, `</dev/null git ...`), `for`, `while`,
  `if then`, `case`, a function body.
- Variable or unreadable subcommand: `S=commit; git -c k=v $S`, `git -c k=v $'commit'`, `git -c k=v $(<newline>) commit`,
  `help.autocorrect` with a misspelled subcommand, `commit-tree` plus `update-ref`.
- ENF-12's own `other` shapes: `--shallow-file x commit --no-verify`, `--config-env user.name=HOME commit --no-verify`,
  `git 2>/dev/null commit --no-verify`, and `gh pr create x && git commit --no-verify`, whose action is `pr-create` (verdict
  measured, not run: gh reaches outside the fixture).
- Parser gaps beyond this gate: a continuation before a segment (`true && \<newline> git commit --no-verify`) and a here-string
  before a line (`cat <<< x`, newline, `git commit --no-verify`). `hooks/lib/argv.cjs` is unchanged, so ENF-12 and the action
  classifier still read those lines wrong. Their `-c k=v` siblings deny now, through the scan's own strip and mask.
- Quote, comment and arithmetic masks that hide the next line from the parse (`# it's` on the line before and after,
  `echo $'a\'b'; ...`, `echo $((1<<X))`, newline, `git ...`, newline, `X`), a continuation then a blank line before a line,
  and a value starting with a hash after an option outside the known value positions (`git --shallow-file "#x" -c k=v commit`).
- From outside any gsd-core checkout, `git --attr-source HEAD -C <gsd-core> -c k=v commit`: no root resolves, so it stays
  allowed.

**Plain-state near-spellings.** With an effective `.githooks`, `--no-veri`, `-qnm` and a continuation before `--no-verify` stay
allowed, as they were, and skip the hook.

**Advice limit.** Text A's advice does not help a worktree-scope value (`extensions.worktreeConfig`): after the advised write,
`--show-scope` still prints `worktree .husky`. It still denies.

**A false deny that predates this record.** ENF-12 reads a wrapper's own `-n` as the flag: `nice -n 5 git commit` denies with the
hook able to run. `sudo -n git commit` denies through the same read. ENF-12 is unchanged here.

## Alternatives considered

- **A sha256 pin of the dispatcher files.** Rejected: it reintroduces this same false deny on every edit of the dispatcher,
  which is live from its repo's main branch on merge, and it needs another repo's bytes as public fixtures.
- **Git identity of the dispatcher's clone.** Rejected: forgeable with `git init` and `git remote add`; it runs git inside a
  directory named by a possibly hostile value, where `core.fsmonitor` can execute; and it needs a private repo's name in
  public source.
- **Seed the canary with a commit and run it from a linked worktree.** Rejected, a decision and not an oversight: it catches
  dispatcher bugs that do not exist in the real one (the plan review measured the real delegate running the hook in a linked
  worktree), for more setup that itself needs its hooks voided.
- **Run `pre-push` in the canary.** Rejected: it runs another repo's push policy (URL judgment, secret scan) inside this gate.
- **Read only the repo value.** Rejected: a correct repo value would excuse any effective override, including `/dev/null`.
- **Widen ENF-12, or the parser, to the listed shapes.** Rejected here: every gate reads that parse, so the change belongs in
  its own record. Denying the near-spellings in the plain state too is a recommended follow-up; it adds new gate behavior this
  record did not need.
