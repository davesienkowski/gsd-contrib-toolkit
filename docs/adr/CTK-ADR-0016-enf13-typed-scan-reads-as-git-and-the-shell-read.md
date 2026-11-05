# CTK-ADR-0016: ENF-13's typed scan reads a command closer to how git and the shell read it

- **Status:** Proposed (2026-11-04), implemented on the `enf13-followups` branch (quick 261104-ov8). Dave accepted
  CTK-ADR-0015 and asked for its review findings to be fixed; he has not reviewed the content of this record.
- **Review:** Published for maintainer review and open to revision. A changed decision will be recorded by a
  superseding or amending CTK-ADR, never by a silent edit to an accepted record.
- **Date:** 2026-11-04 (milestone v2.8).
- **Scope:** GSD Contribution Toolkit: `hooks/githooks-seal.cjs` and its bundle copy, the typed scan only. The ENF-12
  branch and its text, `hooks/lib/argv.cjs` and `hooks/lib/classify.cjs` are unchanged. The dispatcher decisions of
  CTK-ADR-0015 (shape, repo value, canary, check order, the override valve) are unchanged.
- **Amends:** CTK-ADR-0015 Decision 2 (the typed scan), its families table, its accepted false denies and its
  Reported list. CTK-ADR-0015 keeps its text and its Status; it carries a back-link to this record.
- **Trigger:** the independent review of quick 261103-uqe found five Minors and two Nits in that scan: compound forms
  that carry an override allow, a quoted hash blinds it, a glob names the key, one deny text advises writing a value
  into the command, and ordinary reads deny.

## What this is and is not

The scan stops typed forms and is not a seal against an agent working around it. It reads text with a hand parser that
drops quotes, so a form can reach git without being spelled in the command, and the list in "What stays open" is what
was measured, not everything that exists. A form it stops is a form an honest or hurried command would type.

## Decision

Terms as in CTK-ADR-0015: `k` is `core.hooksPath`, `K` is an env config key name.

1. **The mask drops a comment only where that cannot hide a command.** `maskHeredocBodies` is now `maskShellText`, and
   `scanTokens` and its value-position list are gone. A word-start, unquoted, unescaped hash is removed through its
   newline when its text on that line holds none of the quotes, the backtick and `;&|(){}`, and no unquoted `${` is
   open. The check runs before the heredoc check, so `# <<EOF` no longer hides the next line.
   Why those conditions: the walker's quote state is flat, so it can call a hash a comment where bash is inside a nested
   quote, a substitution or an expansion. For a command to be hidden there, a closing delimiter or a separator has to
   follow on that line, or for `${`, on a later one (`git ${y:- --namespace #x -c k=v commit`, newline, `}`). A kept
   comment reads as tokens. This covers the forms named here; the mask's flat state still has the open rows below.
   A backslash-newline now leaves no characters outside single quotes, as bash removes it. Text that masks to empty or
   whitespace is no hit and no refusal, at the top level and in a payload.

2. **A segment's git is the resolved program, else the first token that is the word git** (with a fused prefix such as
   `(git`, `$(git`, `x=$(git` dropped). No list of compound words: this closes `( )`, `{ }`, `!`, `time`, `if`, `then`,
   `do`, `while`, `nohup`, `xargs`, `setsid`, `case`, a function body, a leading redirect, `echo $(git ...)` and a
   backtick. A sealing word also matches with a `)`, a backtick or a redirect fused on (`commit>/dev/null`). Leading repo
   assignments, the named rules and the config write rule read this located git. The rules that read git's own option
   list, and the spelling rule, read a resolved git only, since a located git may be another program's argument.

3. **A literal payload is read once more.** The words after `eval`, and the value of a shell's `-c` (any short cluster
   holding c, then a skipped `--`), go through the same mask and parse, to depth 3, and join the views. One that does
   not parse or is past the bound counts only if it holds git and a sealing word, as `text this gate cannot read`.

4. **The named rules read the whole region; only the generic rule stops at the subcommand.** `-c`, `--config-env`,
   `--git-dir` and `--work-tree` read to the last sealing word as before, with no walk and no paren balancing. So a value
   that shifts a walk does not hide them (`git --namespace ">x" -c k=v commit`, `git -C $(echo . -c k=v) commit`). The
   generic rule (shell syntax in git's options) runs on a resolved git, on the redirect-free tokens, to the first bare word
   that is no known option's value, and reads that word too. `git log "$B"..HEAD -- commit` and its siblings allow.
   A wrong stop opens a shape that needs an expansion or a brace after it, and the review measured that as a real commit
   with no hook: see "What stays open".

5. **A value is not read for shell syntax.** `-c user.name="$N"`, `-c core.sshCommand="ssh -i $I"`,
   `--config-env user.name=$V` and `-c "http.extraHeader=Authorization: Bearer $T"` allow. The key rule stays:
   `-c "$K=v"` denies. A key naming hooks config is checked before the plain-key check, so `includeIf` keeps its own
   text. `*` leaves the plain key characters (a glob can name the key) and `@`, `+`, `%`, `,` join them. Keys compare ASCII
   case-insensitively, as git's do; a non-ASCII key is unreadable and denies. Word splitting in an unquoted value joins the
   family CTK-ADR-0015 already reports for `git -C $WT`. One exception: a `-c` or `--config-env` value the parser split at
   an unquoted substitution (`git -c user.name=$(echo a) commit`) is shell syntax in the option list and denies, because the
   walk would stop at its second word and `classifyAction` reads the rest as other, which skips ENF-12 and the config reads.
   Quoting it allows. `-C` stays out of this: `git -C $(git rev-parse --show-toplevel) commit` is everyday.

6. **The key rule fails closed on programs.** In a non-git segment any token naming `K` hits, as before, unless the
   program is one that only reads (`echo`, `grep`, `rg`, `head`, `tail`, `cat`, `wc`, `ls`, `gh`, `unset`) and no token of
   the segment holds shell syntax or a redirect character. Tokens before the program are still read. So `grep K f`,
   `echo K=v`, `unset K` and `gh ... --body "K"` allow, and `echo $(( K = 1 ))`, `echo () { K=x; }` and
   `echo K=x > f; . ./f` deny.
   Before a resolved git, a token holding `K` hits unless it is exactly the name after `-u` or `--unset`, or exactly
   `--unset=K`. In a sealed git's region (to the last sealing word), `K` hits when any region token holds shell syntax:
   arithmetic there assigns in the current shell before git starts (`git -c user.name=$((K=1)) commit`). The implemented
   rule reads the region and not one token, because `git -c user.name=$(( K = 1 )) commit` spaces the two apart and denied
   at the previous tip. A heredoc message after the sealing word stays untouched, on a located git in a compound form too:
   `( git commit -m "... K ..." )` allows. `env -uK git commit` denies: the name is
   not on its own, and the hook does run there, so this is a false deny.

7. **A config write's glob key denies only where git reads it as a key.** `git config core.hooks* /dev/null && git commit`
   denies on `*`, `?` and `[`, and only when `config` is git's subcommand, read with the generic rule's walk. `git add
   config *.md && git commit` and `git commit config -m "fix: why?"` allow.

8. **The deny text no longer says to write a value out.** The advice now reads: a secret config value goes through
   `--config-env=<key>=<ENVVAR>`, since command lines can be read by other processes, and `-c <key>="$VALUE"` is for a
   value that is not secret. Tests run both through the hook, and each allows for a key that does not name hooks config.

Not adopted: a net that denies when `classifyAction` says commit or push and no view is sealed. On the raw parse it has true
inputs only where the mask is wrong, and the mask rule above removes the rows the plan review listed; it would also deny
`echo ok # note; git commit -m x`, `git status # note; git push origin x` and `git`, newline, `commit -m x`, which commit
nothing. Mask misreads that remain are in "What stays open" and this record does not call them closed.

Kept on purpose, from the review's "Beyond requirement" list: `--git-dir`, `--work-tree`, `include.path`, `includeIf`, config
writes and `--no-veri`. Removing them would allow forms that deny today. The two parse views stay, because ENF-12 still reads
the default parse.

## Consequences

**Verdicts that changed.** Allow now, deny under CTK-ADR-0015, the hook runs or nothing commits: `env -u K git commit`,
`unset K`, `echo K=v`, `grep K f`, `gh pr comment --body "... K ..."`, `-c user.name=$N`, `--config-env user.name=$V`,
`-c 'url.git@x:.insteadOf=y'`, `-c "http.extraHeader=... $T"`, `git commit -m "$M" -m push`, `git push "$R" commit`, `git add
"$f" commit`, `git diff "$A" -- commit`, `git log "$R" -- push`, and `git log \`, newline, a blank line, `git commit`. `git -c k=v
log --grep commit` keeps denying. Deny now, allow before: every compound and payload form in Decision 2 and 3, `git -c
core.hooks* commit`, `git commit>/dev/null` with an override, and the three rows of Decision 7. CTK-ADR-0015's rows for a
quoted hash were refuted by the review (an env wrapper and a redirect before the option); both deny now, as does the
reported `git --shallow-file "#x" -c k=v commit`.

**Accepted false denies this record adds.** A kept comment reads as tokens to the end of its segment: `# K (see notes)`,
newline, `git commit`; `export FOO=1 # K (note)`; `cd . # K is (not) set`; `git commit # see (git -c k=v commit)`. A located
git in text: `echo git -c k=v commit; git commit`. A listed reader beside syntax or a redirect keeps its deny as before:
`grep K "$D"; git commit`, `grep K f > out; git commit`. Text D gives a way forward for each, and none of these shapes is
in the corpus below.

**What stays open.** Each row commits with no repo hook behind the fixture dispatcher unless it says otherwise. The test
file's reported rows print this list when it runs; verdict and effect come from that output.

Denied at the previous tip, allowed now:
- Word splitting in an unquoted value: `N='x -c k=v'; git -c user.name=$N commit`, `git --shallow-file $X commit`.
- A wrong stop of the generic walk: `git <<< x $O commit`, `git <<< x {-c,k=v} commit`, `git --namespace ">x" {-c,k=v} commit`,
  `git --namespace ">x" $O commit`, `git --namespace <(echo a b) $O commit`, `git --attr-source "<x" $O commit`.

- A listed reader on a pipe: `echo K=x | tee f; . ./f; git commit`, `echo K=x | source /dev/stdin` with lastpipe. A deny here
  would cost `echo K=v; git commit`.
- A quoted substitution in an option value holding the command: `git --config-env user.name="$(git -c k=v commit)" commit`,
  `git --super-prefix "$(...)" commit`, and in `-c user.name="$(...)"` and `--shallow-file "$(...)"` the inner commit. Denying
  these needs a value read, and `-c user.name="$(git config user.name)"` is ordinary.

Allowed at the previous tip too:
- `echo "$(git -c k=v commit)"`, a quoted substitution: one token, the same shape as a `-m "$(cat <<EOF ...)"` message.
- `git -c alias.ci='-c k=v commit' ci`.
- A payload built from a variable: `eval "$CMD"`, `bash -c "$C"`. Denying it would deny `eval "$(ssh-agent)"`.
- `env -S 'git -c k=v commit'`: its text is no eval or shell payload here.
- `( git $OPTS commit )`, and a glob as a whole option, `git * commit` (no commit in the fixture; a file named `-c...` would
  change that).
- Compound forms with no typed form: `( git commit --no-verify )`, `time git commit -n`, and `( git commit )` with a wrong repo
  value. ENF-12 and the config reads key on `classifyAction`, which is unchanged.
- A config glob write in a compound form, `( git config core.hooks* /dev/null; git commit )`.
- Comments the mask keeps that hold a quote or a heredoc operator: `# (x) <<EOF`, newline, `git -c k=v commit`; `# don't`,
  newline, `git -c k=v commit # don't`, and the same with a key assignment. `# don't` then an ordinary commit is still refused by
  the shared parse as an unbalanced quote, unchanged here.
- The mask's flat quote state: `echo "$(echo "a #b`, newline, `c"; git -c k=v commit; echo "d")"`, the ANSI-C form
  `echo $'a\'b #'; git -c k=v commit; echo \'`, and `echo $((1<<2))` with a following line read as a heredoc body.
- Arithmetic outside a sealed region: `git commit -m $((K=1))` after the sealing word, and `git log $((K=1)); git commit`.
- A command that reaches a shell or an interpreter with no `eval` or `-c` word to read: `bash <<'EOF'`, `sh <<EOF`, `cat <<'EOF' | bash`,
  `bash <<< '...'`, `echo '...' | bash`, `source <(...)`, `bash <(...)`, `python3 -c`, `node -e`, `perl -e`, `script -qc`, `trap '...' EXIT`.
- A program word that is an expansion: ` its variable subcommand, repo config and hooks on disk rows.

**Measured on this code, against the base commit 3377491.**
- Corpus: distinct Bash commands holding the word git from local transcripts, 64140 parsed. Scan hits 63 at base, 56 here, 0
  new, 7 lost. Every lost hit read and classed: 7 false denies removed (3 `unset K`, 2 `env -u K`, 1 `-c` value holding a
  substitution, 1 heredoc message holding the word push) and 0 real overrides opened. A corpus of past commands is no guard
  for a shape nobody typed: the plan review's bypass rows had 0 corpus hits, so the test bank carries that direction.
- Tests: a shape bank through the spawned hook in both states, with the real effect in bash behind a fixture dispatcher,
  including every BLOCKER and MAJOR row of both plan reviews, except the rows named in "What stays open".
- `hooks/githooks-seal.cjs` went from 909 to 1071 lines (343 to 400 comment and blank lines, 566 to 671 other lines), so
  this did not shrink it. Removed: the comment-token logic, the value check and its exempt list. Added: the payload reader,
  the located git, the option walk and the key rule's branches. Minor 5 asked for less; the false denies it names are gone,
  and the size is not. The independent review measured cuts: none over 12 code lines keeps today's verdicts, by what it tried,
  and the largest it could recommend saves 3. So the size stays open: a real shrink means moving the scan to `hooks/lib/`, which
  removes no code, or dropping an accepted rule, which is a decision for the owner.
- Timing is indicative only and no decision depends on it. CTK-ADR-0015 recorded 16 to 24 ms for the canary and 63 to 79 ms for
  the whole hook. The review measured under load: canary 26 to 108 ms (median 43, n=20), whole gate 39 to 92 ms (median 53,
  n=20), a spawned hook 129 ms. This tip: canary 16.7 to 27.5 ms (median 20.7, n=20), a spawned bundle hook on an ordinary
  commit 60.6 to 84.4 ms (median 66.8, n=20), slowest scan pair in the corpus 2 ms. One machine, one session each.

## Alternatives considered

- **Strip compound words in `classify.cjs`.** The review's suggestion. Rejected: every gate reads that parse, and CTK-ADR-0015
  rejected widening it.
- **A list of setters for the key rule, and a list of compound leaders.** Prototyped first. The plan review measured each gap as a
  real bypass (`let`, `getopts`, `exec {K}`, `source <(...)`, a function body). A read-only list fails closed on a missing entry.
- **Balancing parens and backticks in the option walk.** Prototyped first. A value could still shift it, and it needed `${` too.
  Keeping the named rules off any walk removed that code and that failure.
- **Keep a comment only by text, with no `${` depth.** Refuted by a closing `}` on the next line, measured as a bypass.
- **Drop a kept comment up to the first delimiter.** Clears three false denies and opens `git -C ${x:- #b -c k=v} commit` where a
  directory named `#b` exists. Not taken.
git' -c k=v commit`, `${G:-git} -c k=v commit`.
- A config glob behind `--file`: `git config --file .git/config core.hooks* /dev/null && git commit`.
- Everything else CTK-ADR-0015 reports under its variable subcommand, repo config and hooks on disk rows.

**Measured on this code, against the base commit 3377491.**
- Corpus: distinct Bash commands holding the word git from local transcripts, 64140 parsed. Scan hits 63 at base, 56 here, 0
  new, 7 lost. Every lost hit read and classed: 7 false denies removed (3 `unset K`, 2 `env -u K`, 1 `-c` value holding a
  substitution, 1 heredoc message holding the word push) and 0 real overrides opened. A corpus of past commands is no guard
  for a shape nobody typed: the plan review's bypass rows had 0 corpus hits, so the test bank carries that direction.
- Tests: a shape bank through the spawned hook in both states, with the real effect in bash behind a fixture dispatcher,
  including every BLOCKER and MAJOR row of both plan reviews, except the rows named in "What stays open".
- `hooks/githooks-seal.cjs` went from 909 to 1061 lines (285 to 330 comment lines, 624 to 731 other lines), so
  this did not shrink it. Removed: the comment-token logic, the value check and its exempt list. Added: the payload reader,
  the located git, the option walk and the key rule's branches. Minor 5 asked for less; the false denies it names are gone,
  and the size is not.
- Timing is indicative only and no decision depends on it. CTK-ADR-0015 recorded 16 to 24 ms for the canary and 63 to 79 ms for
  the whole hook. The review measured under load: canary 26 to 108 ms (median 43, n=20), whole gate 39 to 92 ms (median 53,
  n=20), a spawned hook 129 ms. This tip: canary 16.7 to 27.5 ms (median 20.7, n=20), a spawned bundle hook on an ordinary
  commit 60.6 to 84.4 ms (median 66.8, n=20), slowest scan pair in the corpus 2 ms. One machine, one session each.

## Alternatives considered

- **Strip compound words in `classify.cjs`.** The review's suggestion. Rejected: every gate reads that parse, and CTK-ADR-0015
  rejected widening it.
- **A list of setters for the key rule, and a list of compound leaders.** Prototyped first. The plan review measured each gap as a
  real bypass (`let`, `getopts`, `exec {K}`, `source <(...)`, a function body). A read-only list fails closed on a missing entry.
- **Balancing parens and backticks in the option walk.** Prototyped first. A value could still shift it, and it needed `${` too.
  Keeping the named rules off any walk removed that code and that failure.
- **Keep a comment only by text, with no `${` depth.** Refuted by a closing `}` on the next line, measured as a bypass.
- **Drop a kept comment up to the first delimiter.** Clears three false denies and opens `git -C ${x:- #b -c k=v} commit` where a
  directory named `#b` exists. Not taken.
