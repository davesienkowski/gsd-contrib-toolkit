# CTK-ADR-0012: Follow the gsd-core merge queue: BEHIND is never author work, the queue mode is read live

- **Status:** Accepted (2026-10-21, by Dave's explicit sign-off). Dave has approved this record; before
  that sign-off it was Proposed, documenting a decision implemented on branch
  `davesienkowski/merge-queue-awareness` and fast-forwarded into toolkit main at 58528a3. Approval basis:
  Dave, 2026-10-21, "i pre approve sign offs on everything. proceed using your judgement" (relayed to the
  landing session by the coordinating session). Dave's 2026-10-21 request to "update my
  gsd-contrib-toolkit and anything we use related to it to consider what trek-e said" is the trigger for
  the work (quick 261021-n2m). An independent adversarial gate on 2026-10-21 refuted this record's first
  draft (it said up-to-date was not enforced on `next`); the corrections are folded in below, and a
  round-2 gate on the corrected record returned MERGE-OK.
- **Review:** Published for maintainer review and open to revision. A changed decision is recorded by a
  superseding or amending CTK-ADR, never a silent edit to this record.
- **Date:** 2026-10-21 (milestone v2.8). Consequences gained two additions after acceptance, both dated
  2026-10-21 there; no Decision changed. (1) The Update-branch consequence gained the stale-BEHIND note
  (round-2 gate note N2) and the parents-and-content sentence for re-review step 13 (follow-up gate on
  N1). (2) A new consequence records the `queue.strictUpToDate` removal (round-2 gate note N4).
- **Scope:** GSD Contribution Toolkit: `bin/pr-status.cjs`, the `maintainer-review-sweep` and
  `core-contribution` skills, the `gsd-submit` and `gsd-review-sweep` commands, the maintainer guide.
- **Trigger:** trek-e's announcement on the gsd-core Discord, 2026-10-21 (relayed by Dave), that
  open-gsd/gsd-core `next` moves to a GitHub merge queue.
- **Relates to:** CTK-ADR-0001 (honesty constraint: advisory text is not enforcement); CTK-ADR-0005
  Decision 4 (a check that cannot deny may fail open); CTK-ADR-0006 Decision 4 (the ENF-20 treadmill
  guard, deliberately unchanged here). Amends no earlier record.
- **Revisit:** at trek-e's four-week review of the queue (he said he would decide then whether to keep
  it, tune it, or try a weekly fix-train branch), and earlier on any trigger listed under *Revisit*.

## Context

### What was announced

trek-e's reason: in 30 days, 119 of 139 merged fix PRs saw `next` move under them, which meant endless
rebase-and-CI cycles, and some merges landed untested against the current `next`. The rules he gave
contributors:

1. Keep opening PRs against `next` with a linked, confirmed issue.
2. Do not rebase or "update branch" because `next` moved. Once a PR is approved and green it joins the
   queue; GitHub tests it on top of the PRs ahead of it, then squash-merges it. A failure removes it from
   the queue and shows the reason on the PR.
3. Do not push new commits after approval unless needed: a push means a new review and a new run.
4. The fix PR template gains a "Self-test report": the failing test, that it fails before and passes
   after, the command run, OS and Node version. CI re-runs it. Advisory at first.
5. PRs from outside the maintainer team need an approving review; maintainer PRs no longer need an admin
   override.
6. Unchanged: squash-merge, changesets, issue-first, no "re-run until green".

Timeline as announced: a heads-up plus a CI change so every required check reports in the queue; then
the queue in evaluate mode; after about a week of clean results it is switched on (date posted on
Discord); after four weeks, keep, tune or replace it. It may be reverted.

### What was live on 2026-10-21 (the baseline for the revisit)

Verified against GitHub and `origin/next` (812ddb5f) on 2026-10-21 at about 20:40 UTC:

| Question | Live answer | How it was read |
|---|---|---|
| A merge queue on `next`? | **No.** No ruleset holds a `merge_queue` rule; `mergeQueue(branch:"next")` is null | `gh api repos/open-gsd/gsd-core/rulesets` and each ruleset's rules; GraphQL `repository{mergeQueue(branch:"next")}` |
| Ruleset enforcement | All three rulesets (`main-protection` on `~DEFAULT_BRANCH` = `next`, `release-branches`, `tag-immutability`) are `evaluate`; `rules/branches/next` returns `[]` | REST rulesets and rules endpoints |
| Self-test report in the fix template | **Not landed.** `.github/PULL_REQUEST_TEMPLATE/fix.md` last changed 2026-09-13 (1110c3b4e) and has no such section | `git show origin/next:.github/PULL_REQUEST_TEMPLATE/fix.md` |
| Classic branch protection on `next` | **Enforced for non-admins.** `protected: true`; 7 required checks (check-branch, changeset-lint, docs-lint, validate-target, Issue link required, Pull request template format, Required tests); `enforcement_level: non_admins`. `branches/next/protection` returns 404 to this token: a permissions limit, not absence | `gh api repos/open-gsd/gsd-core/branches/next --jq '{protected,protection}'` |
| Is up-to-date required? | **Yes, for non-admins.** 36 of 79 open PRs on `next` read BEHIND (35 BLOCKED, 8 DIRTY; e.g. #5598 `mergeable_state: behind`). Control: the fork's #33, 1303 commits behind an unprotected `next`, reads `clean`. GitHub reports BEHIND only when the base requires up-to-date branches; the evaluate rulesets do not affect merge state, so the requirement comes from classic protection | `gh pr list --base next --state open --json mergeStateStatus`; `gh api repos/davesienkowski/gsd-core/pulls/33`, `branches/next` there (`protected: false`), `compare` (`behind_by 1303`) |
| Every required check reports in the queue | **Not landed.** Only `test.yml` has a `merge_group` trigger (#4242, 2026-09-03). The required checks `Changeset Required`, `require-issue-link` and `pr-template-format` run on `pull_request` / `pull_request_target` only. #4999 (make next merge-queue-ready) was reverted by #5001 on 2026-09-25 | `git grep merge_group origin/next -- .github/workflows`, PR search |

So the queue is announced, not configured, and until it is active a non-admin cannot merge a BEHIND PR on
`next`: someone must update the branch first, or bypass the requirement with `--admin`. That admin bypass
is the "landed untested against next" path trek-e named, and his "maintainer PRs no longer need an admin
override" fits this. The toolkit must read the mode rather than assume it, and must say who updates a
BEHIND branch while there is no queue.

### What the toolkit encoded

The toolkit taught the treadmill trek-e is retiring:

- the sweep's cost tier ranked *approved+rebase* first, the maintainer guide repeated it;
- `pr-status` counted BEHIND as a blocker and put the ball on the author for it, and its ready line
  required "not DIRTY or BEHIND";
- the merge gate (re-review step 13) required "rebased (not BEHIND/DIRTY)", step 14 was a "post-rebase
  handoff", and labels.md added `needs rebase` when a PR was BEHIND;
- nothing told an author not to push after approval, and nothing asked for a self-test report;
- push commands were composed against the worktree's tracking remote. On 2026-10-21 that was wrong for
  #5119 and #5192 (tracking `origin`, heads on the fork); only the explicit lease stopped a stray branch
  on open-gsd.

## Decision

1. **BEHIND is never author work; who handles it depends on the queue mode.**
   - **Author (every mode):** never rebase or Update branch because `next` moved; BEHIND never costs a
     tier and never earns a rebase request. A rebase is justified only by a DIRTY conflict or by a needed
     change that requires new commits anyway. This is faithful to trek-e's rule and holds now.
   - **Maintainer, queue `none`, `evaluate` or `unknown`:** a BEHIND PR cannot be merged by a non-admin
     (classic protection requires up-to-date branches). At merge time the maintainer runs Update branch
     (`gh pr update-branch <n>`, a merge commit from the base, which triggers one fresh CI run), waits for
     it to go green, and then merges.
   - **Queue `active`:** BEHIND is moot; the queue tests the PR on top of the entries ahead of it.
   - **`--admin` is never used, in any mode.** It bypasses both the queue and the up-to-date
     requirement, which is how a merge lands untested against `next`.
   `pr-status` treats a reported BEHIND as proof that up-to-date is enforced on the base (GitHub reports
   it only then), because classic protection is not fully readable: with no active queue it keeps the PR
   MAINTAINER ready and adds "maintainer: Update branch at merge time; never --admin".

2. **The queue mode is read live, never hardcoded.** `pr-status` reads it once per repo and base branch
   per run with REST GETs only: `rules/branches/<base>` (active rules; a `merge_queue` entry means
   **active**), then the repository rulesets and the details of the branch rulesets in evaluate mode (a
   `merge_queue` rule whose `ref_name` conditions cover the base means **evaluate**), with `repos/<R>`
   read only to resolve `~DEFAULT_BRANCH`. Otherwise **none**. Any failed read is **unknown**, named with
   its error. A reply that is not an array of pages also reads as **unknown** (Postel: accept liberally, never
   silently degrade an odd shape to none). No GraphQL: `pr-status`'s read-only contract
   excludes it, and `hooks/review-artifact.cjs` gates GraphQL.

3. **Failing open is correct here, and only here.** `pr-status` is an advisory read, not a gate: it
   cannot deny anything, and unknown gets the same conservative treatment as none and evaluate (BEHIND
   is the maintainer's Update branch at merge time, never the author's work). This is CTK-ADR-0005 Decision 4's reasoning (a check that cannot deny may fail open) applied to
   a tool outside the gate suite. The failure is always printed, never silently reported as none.

4. **"Ready" means approved on the head, no pending requests, checks green, not DIRTY.** When the queue is
   active the ready line adds that the PR enters the merge queue on its base (`gh pr merge` enqueues it);
   when the PR is BEHIND with no active queue it adds the maintainer caveat from Decision 1. The ready-line
   text and `--json` (`queue`, `ball.entersQueue`, `ball.mergeCaveat`) changed; the only in-repo
   consumers are the two skills, both updated (Hyrum: an external parser of the old text would break).

5. **No push after approval unless a change is needed.** A push dismisses the approval and restarts review
   and CI (trek-e's announcement; the evaluate `main-protection` ruleset carries
   `dismiss_stale_reviews_on_push: true`; classic protection's review settings are not readable with
   this token). The contribution skill, the gsd-submit command and the sweep hand-off carry the rule.

6. **Fix PR bodies carry an advisory `## Self-test report`.** Its items follow the announcement (failing
   test, fails before, passes after, command, OS, Node version) because the upstream template has not
   landed it. pr-template-policy checks only that required headings are present, so the extra heading
   passes the template gate. When `fix.md` on `origin/next` gains the section, the skeleton mirrors its
   exact headings and the advisory note goes.

7. **A push to an existing PR goes to the remote named by the PR's `head.repo`.** Read it with
   `gh api repos/<owner>/<repo>/pulls/<n> --jq '.head.repo.full_name, .head.ref, .head.sha'`, map it to
   the local remote whose URL names it, confirm with `git ls-remote`, and after a needed history rewrite
   push with `--force-with-lease=<head.ref>:<head.sha>`. Never the worktree's tracking remote. Hand-offs
   name `head.repo`.

8. **Deliberately unchanged.**
   - The ENF-20 treadmill guard (CTK-ADR-0006 Decision 4) and the sweep's stop condition. They count
     re-review rounds at an unchanged head to stop a dismiss-on-push loop; that is independent of how a
     PR reaches the queue. The queue makes BEHIND-only rebases rarer; it does not make the guard wrong.
   - Hook behaviour and hook text. A grep of `hooks/` for `BEHIND`, `mergeStateStatus`, `update-branch`
     and `behind_by` found no gate that reads merge state or pushes toward a rebase (via the paths
     searched). ENF-07's deny text suggests `git push fork <branch>`, which is pinned byte-for-byte by
     the `proofs/` corpus; regenerating that corpus needs `verify-hooks` against a built gsd-core, so it
     is not touched here.
   - No new gate. Every rule above is model-driven advice in skills and commands. Per CTK-ADR-0001's
     honesty constraint, none of it is to be described as enforced.

## Consequences

- **Positive:** the sweep and the contribution path stop generating rebase churn that the maintainers
  have measured as the main cost on `next`, and they stop pushing after approval. `pr-status` tells the
  truth about the queue on every run, so the moment trek-e switches it on, the ready line and the BEHIND
  note change without a toolkit edit.
- **Positive:** the push-target rule removes a failure that had already happened once.
- **Negative / accepted:** until the queue is active, every BEHIND merge costs the maintainer one Update
  branch and one fresh CI run. That is the price of never using `--admin`, and it is still far cheaper
  than an author rebase per move of `next`. Not verified: whether that Update-branch push dismisses an
  existing approval (classic protection's dismiss-stale setting is not readable with this token); if it
  does, the maintainer re-approves after the run. Added 2026-10-21 after acceptance (round-2 gate note
  N2; no Decision changed): BEHIND can also be stale, read while `compare ... behind_by=0`, and the Update
  branch is then a harmless no-op (gh 2.95.0 prints `PR branch already up-to-date` and pushes nothing;
  that string and the compare are read from the gh binary, not exercised live). This record claims
  neither the dismissal nor the absence of one. Re-review step 13 (note N1) handles both: it records the
  head before the update, accepts only one new merge commit from the base, re-reads the checks and the
  approval on the new head, and merges with `--match-head-commit`. Added 2026-10-21 after acceptance
  (follow-up gate on N1): that check covers both its parents and its content. The new head's tree must
  equal the clean merge of its parents, recomputed locally with `git merge-tree --write-tree` (git 2.38+;
  a throwaway-worktree merge on an older git), because a contributor can force-push a merge commit with
  the expected parents and extra changes. A mismatch from a differing merge engine only costs a
  restart. Run on 2026-10-21 with git 2.43.0 over Dave's local gsd-core clone (`~/repos/gsd-core`),
  selecting every commit reachable from any ref with two parents, committer `GitHub` and a subject
  `Merge branch '<x>' into <y>` (`git log --all --merges --committer='^GitHub <'`, subject filtered): 89
  of 90 matched. The other (29241b3c) is a conflict resolved in GitHub's web editor (merge-tree reports
  a conflict in `get-shit-done/bin/lib/config.cjs`); Update branch cannot produce one, and the check
  rightly aborts on it.
- **Negative / accepted:** classic branch protection is only partly visible. `branches/<base>` shows it
  exists and which checks it requires, but `branches/<base>/protection` (and with it any up-to-date flag or
  classic merge-queue setting) returns 404 without admin rights. So `pr-status` keys the maintainer caveat
  on a reported BEHIND, which GitHub emits only under an up-to-date requirement, and a merge queue set up
  through classic protection rather than a ruleset would read as none.
- **Negative / accepted:** the Self-test report shape may differ from the template trek-e lands; the
  advisory note and the wording test make the re-mirror a one-file edit.
- **Negative / accepted:** each `pr-status` run now makes two to four extra REST reads per base branch
  (four on open-gsd today: the rules read, the rulesets list and two evaluate-mode branch rulesets).
- **`queue.strictUpToDate` removed (added 2026-10-21 after acceptance, round-2 gate note N4; no Decision
  changed).** The first implementation also returned `strictUpToDate` in the `pr-status --json` queue
  object. It read active rulesets only, so on open-gsd `next` it said `false` while classic protection
  enforces up-to-date for non-admins, and nothing keyed on it. Choice: removed, not kept as a deprecated
  field for one release. Hyrum's law cuts toward removal here: every observable field gains a consumer
  in time, and a consumer of this one would trust a false negative, so the cheapest moment to drop it is
  before the first release that carries it. It is in no release tag (the latest is v2.7) and reached the
  published main on 2026-10-21 (origin/main at 3254623). No consumer was found via the paths searched:
  `git grep` of the toolkit (only `bin/pr-status.cjs`, its test and three fixtures), `grep -r` of
  `~/repos` with `.git` and `node_modules` excluded (including dev-env and orca-gsd-plugin; only two
  gsd-core-notes gate reports mention it), and `~/.claude/{skills,commands,hooks}` and `~/.gsd`. A
  consumer outside Dave's machine cannot be ruled out; it would now see the key absent rather than a
  wrong value. The queue object is now exactly `base`, `mode` and `ruleset` (`base`, `mode` and `error`
  when unknown); a key-set test in `bin/pr-status.test.cjs` pins the active, evaluate and none shapes,
  so a later field there is a decision, not drift.

## Alternatives considered

- **Hardcode "the queue is on" in the skills.** Rejected: on 2026-10-21 it is not on, and the announced
  timeline passes through an evaluate period and a possible revert. A hardcoded claim would be false on
  the day it was written.
- **Read `mergeQueue(branch:)` over GraphQL.** Rejected: `pr-status` is REST-only by contract, and the
  stub that proves it read-only refuses any GraphQL argument. `rules/branches/<base>` answers the active
  question for rulesets; the classic-protection gap is recorded above.
- **Keep BEHIND as an author blocker until the queue enforces.** Rejected: GitHub does block a BEHIND merge
  for non-admins today (classic protection), but the fix belongs to whoever merges. Asking every author to
  rebase each time `next` moves is the churn trek-e measured (119 of 139 fix PRs); one maintainer Update
  branch at merge time gives the same tested-against-current-`next` result once per PR.
- **Merge BEHIND PRs with `--admin`.** Rejected in every mode: it skips the up-to-date check and the
  queue, so the merge is untested against the current `next`, the exact failure the queue exists to stop.
- **A hook that denies a push to an approved PR.** Rejected for now: it would need a network lookup of
  approval state on every push, and the "unless a change is needed" exception is a judgement a hook cannot
  make. If pushes after approval keep happening, revisit with an `ask`-severity gate (CTK-ADR-0005).

## Revisit

Re-open this record when any of these happens, and re-run the live checks in *Context*:

- trek-e posts the four-week review on Discord (keep, tune, or a weekly fix-train branch);
- `pr-status` first reports `queue: next active`: check the ready line and merge-gate wording against how
  the queue actually behaves (grouping, failure reasons, `gh pr merge` behaviour);
- `.github/PULL_REQUEST_TEMPLATE/fix.md` on `origin/next` gains a Self-test report: mirror its headings;
- the required checks gain `merge_group` triggers, or the queue is reverted: on a revert the maintainer
  side of Decision 1 (Update branch at merge time) becomes permanent, so re-check its cost;
- classic protection on `next` changes (`gh api repos/open-gsd/gsd-core/branches/next --jq .protection`), or
  open PRs stop reading BEHIND while behind `next`: the up-to-date requirement Decision 1 relies on moved;
- Dave signed off on 2026-10-21 (see Status); from here a changed decision is an amending or superseding
  CTK-ADR, never an edit to this record.
