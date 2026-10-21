# CTK-ADR-0012: Follow the gsd-core merge queue: BEHIND is informational, the queue mode is read live

- **Status:** Accepted (2026-10-21, by Dave's explicit request). Dave asked on 2026-10-21 to "update my
  gsd-contrib-toolkit and anything we use related to it to consider what trek-e said"; that request is
  the approval basis for this record (quick 261021-n2m).
- **Review:** Published for maintainer review and open to revision. A changed decision is recorded by a
  superseding or amending CTK-ADR, never a silent edit to this record.
- **Date:** 2026-10-21 (milestone v2.8+)
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
| Every required check reports in the queue | **Not landed.** Only `test.yml` has a `merge_group` trigger (#4242, 2026-09-03). The required checks `Changeset Required`, `require-issue-link` and `pr-template-format` run on `pull_request` / `pull_request_target` only. #4999 (make next merge-queue-ready) was reverted by #5001 on 2026-09-25 | `git grep merge_group origin/next -- .github/workflows`, PR search |

So the queue is announced, not configured. That is the reason the toolkit must read the mode rather
than assume it.

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

1. **BEHIND is informational in every mode.** It is never a blocker, never makes the author owe work,
   never costs a tier, and never earns a rebase or Update-branch request. A rebase is justified only by a
   DIRTY conflict or by a needed change that requires new commits anyway. This holds before the queue
   enforces too: the rulesets are `evaluate`, so the strict up-to-date policy is not enforced, the
   maintainer's squash merge does not need a rebase, and the announcement asks contributors to stop now.

2. **The queue mode is read live, never hardcoded.** `pr-status` reads it once per repo and base branch
   per run with REST GETs only: `rules/branches/<base>` (active rules; a `merge_queue` entry means
   **active**), then the repository rulesets and the details of the branch rulesets in evaluate mode (a
   `merge_queue` rule whose `ref_name` conditions cover the base means **evaluate**), with `repos/<R>`
   read only to resolve `~DEFAULT_BRANCH`. Otherwise **none**. Any failed read is **unknown**, named with
   its error, and the output treats BEHIND as informational. No GraphQL: `pr-status`'s read-only contract
   excludes it, and `hooks/review-artifact.cjs` gates GraphQL.

3. **Failing open is correct here, and only here.** `pr-status` is an advisory read, not a gate: it
   cannot deny anything, and every mode, including unknown, yields the same non-blocking treatment of
   BEHIND. This is CTK-ADR-0005 Decision 4's reasoning (a check that cannot deny may fail open) applied to
   a tool outside the gate suite. The failure is always printed, never silently reported as none.

4. **"Ready" means approved on the head, no pending requests, checks green, not DIRTY.** When the queue is
   active the ready line adds that the PR enters the merge queue on its base; the merge gate says
   `gh pr merge` then enqueues the PR and that `--admin` (which bypasses the queue) is never used.

5. **No push after approval unless a change is needed.** A push dismisses the approval and restarts review
   and CI (the live `main-protection` ruleset carries `dismiss_stale_reviews_on_push: true`, evaluate
   mode). The contribution skill, the gsd-submit command and the sweep hand-off carry the rule.

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
- **Negative / accepted:** without an enforcing queue, an approved PR that is BEHIND may still need an
  update at merge time if an active ruleset ever enforces up-to-date branches. `pr-status` names that case
  in its BEHIND note (an active `required_status_checks` rule with the strict policy) and assigns the
  update to the maintainer at merge time, never to the author.
- **Negative / accepted:** a queue configured through classic branch protection rather than a ruleset is
  not visible to these REST reads. open-gsd uses rulesets; the classic branch-protection read for `next`
  returned 404 on 2026-10-21, which means either no classic protection or no permission to read it, so
  this is recorded, not handled.
- **Negative / accepted:** the Self-test report shape may differ from the template trek-e lands; the
  advisory note and the wording test make the re-mirror a one-file edit.
- **Negative / accepted:** each `pr-status` run now makes two to four extra REST reads per base branch
  (four on open-gsd today: the rules read, the rulesets list and two evaluate-mode branch rulesets).

## Alternatives considered

- **Hardcode "the queue is on" in the skills.** Rejected: on 2026-10-21 it is not on, and the announced
  timeline passes through an evaluate period and a possible revert. A hardcoded claim would be false on
  the day it was written.
- **Read `mergeQueue(branch:)` over GraphQL.** Rejected: `pr-status` is REST-only by contract, and the
  stub that proves it read-only refuses any GraphQL argument. `rules/branches/<base>` answers the active
  question for rulesets; the classic-protection gap is recorded above.
- **Keep BEHIND as a blocker until the queue enforces.** Rejected: the strict up-to-date policy sits in an
  evaluate-mode ruleset, so GitHub does not block a BEHIND merge, and the announcement asks contributors to
  stop rebasing now.
  Keeping it would keep producing the churn the queue is meant to end.
- **A hook that denies a push to an approved PR.** Rejected for now: it would need a network lookup of
  approval state on every push, and the "unless a change is needed" exception is a judgement a hook cannot
  make. If pushes after approval keep happening, revisit with an `ask`-severity gate (CTK-ADR-0005).

## Revisit

Re-open this record when any of these happens, and re-run the live checks in *Context*:

- trek-e posts the four-week review on Discord (keep, tune, or a weekly fix-train branch);
- `pr-status` first reports `queue: next active`: check the ready line and merge-gate wording against how
  the queue actually behaves (grouping, failure reasons, `gh pr merge` behaviour);
- `.github/PULL_REQUEST_TEMPLATE/fix.md` on `origin/next` gains a Self-test report: mirror its headings;
- the required checks gain `merge_group` triggers, or the queue is reverted: if a revert comes with an
  enforced up-to-date policy, Decision 1 needs a fresh look.
