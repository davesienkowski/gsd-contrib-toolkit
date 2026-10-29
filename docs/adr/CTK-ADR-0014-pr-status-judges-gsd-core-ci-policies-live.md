# CTK-ADR-0014: pr-status judges the gsd-core CI policies with the LIVE scripts; base and reviewer reds are never author work

- **Status:** Accepted (2026-10-28, by Dave's explicit sign-off). Before that sign-off it was Proposed,
  documenting a decision implemented on the `davesienkowski/ctk-pr-status-ci-checks` branch (quick
  261028-owj) and merged into toolkit main at 55b8634.
- **Review:** Published for maintainer review and open to revision. A changed decision will be recorded
  by a superseding or amending CTK-ADR, never by a silent edit to an accepted record.
- **Date:** 2026-10-28 (milestone v2.8).
- **Scope:** GSD Contribution Toolkit: `bin/pr-status.cjs` (and `bin/issue-status.cjs` through the shared
  `derive`), the `maintainer-review-sweep` skill text that describes pr-status output.
- **Amends:** CTK-ADR-0012 Decision 4 ("ready" means approved on the head, no pending requests, checks
  green, not DIRTY). CTK-ADR-0012 is not withdrawn; its Status stays Accepted and it carries a back-link
  to this record.
- **Relates to:** CTK-ADR-0001 Decision 3 (reuse the LIVE upstream scripts, no vendored fallback);
  CTK-ADR-0012 Decision 3 (pr-status is advisory and fails open to informational) and Decision 6 (the
  Self-test report is advisory).
- **Trigger:** three gsd-core checks pr-status did not model, verified on gsd-core `origin/next`
  65638993a on 2026-10-28: Base branch health with the `fix-next` label (#5781, rolled into the required
  "Required tests"), Reviewed or maintainer (#5607, advisory) and Self-test report (#5614, advisory).
  Before this record a red base read as author work, and the Self-test report was checked only for its
  head binding.

## Context

gsd-core judges these checks with pure policy modules under `scripts/` (`ci-next-health.cjs`,
`reviewed-or-maintainer-policy.cjs`, `self-test-report-policy.cjs`), each run in CI from the BASE sha so a
PR cannot rewrite the rule that judges it. pr-status ran from any directory with no access to those
modules, and treated every failing check as the author's to fix. Re-deriving the three rules in the
toolkit would be a second hand-written copy that drifts (the Generative-Fix-Divergence concern).

## Decision

1. **The verdicts come from the LIVE gsd-core scripts.** pr-status `require()`s the three modules through
   `hooks/lib/resolve.cjs` `requireLiveScript` from a local checkout: `GSD_CORE_ROOT`, then
   `~/repos/gsd-core`, then `~/gsd-core`. Never the current directory: run from a worktree of a PR head,
   the PR's own edited policy would judge the PR with the user's gh token. The `policies:` line names the
   checkout and its HEAD, because that checkout, not the CI run, decided the printed verdict. No policy
   verdict is re-derived. Supporting logic that mirrors upstream workflow steps, each a drift risk named
   here: the shape of the base-runs read (ci-next-health's `main()` fetcher is not exported; its comment
   names the source sha), the workflow's login pattern and its choice of which approvers get a permission
   read, `fix-next` presence read from the PR's labels (the pull_request path; the merge-group bypass is
   not modelled), the attribution of a red Required tests to base health by check and workflow name, and
   the prose that explains each reason code. A relative `GSD_CORE_ROOT` is ignored (it would resolve
   against the cwd). The existing `selfTestBlock` reimplementation is pinned by a parity test against the
   LIVE `extractReport`.
2. **Every input is a REST GET, and a failed or partial input makes that verdict unknown.** The new reads
   (the base branch's Tests push runs and a re-run's previous attempt, `.github/MAINTAINERS` at the base
   sha, each candidate approver's collaborator permission) keep pr-status inside CTK-ADR-0012's read-only
   contract. No partial input (for example roles missing after a 403, a reviews reply that is not an
   array of pages, or a failed previous-attempt read) is passed to a policy. Upstream CI reads a failed
   previous-attempt read as red because it is a gate; pr-status prints unknown because it is a report.
3. **A red base is never author work; a red Reviewed or maintainer is reviewer-side.** Failing checks are
   split into author-side, base health (Base branch health, and Required tests when Base branch health is
   red and no other Tests job is), reviewer-side (Reviewed or maintainer) and advisory (Self-test report).
   Among failing checks, only author-side reds put the ball on the author (as before, DIRTY and a change
   request on the head also do). The blocker text follows the live verdict:
   a red check over a base that is green now asks for a re-run, a PR already carrying `fix-next` is not
   told to apply it, and a red Reviewed or maintainer check beside a live green verdict is the
   maintainer's re-run, not a review owed.
4. **Amends CTK-ADR-0012 Decision 4: "ready" means no blocking check red.** An advisory red (Self-test
   report) no longer blocks the ready line; the ready line names it with its policy reason instead of
   claiming every check is green. Every Self-test red is advisory whatever its reason (CTK-ADR-0012
   Decision 6); `fail_suite_not_passed` from an honest report (one known environment failure) prints as
   advisory, never as a defect.

## Consequences

- pr-status needs a gsd-core checkout for these verdicts; without one it prints `policies: unknown` and
  the rest of the snapshot is unchanged.
- The verdict can differ from the CI run: the local checkout may be ahead of or behind the base sha CI
  used, and a check run can predate an approval or a base fix. The policy footer says so.
- The check and workflow names (`Required tests`, `Base branch health`, `Reviewed or maintainer`,
  `Self-test report`, workflow `Tests`) are matched literally; an upstream rename silently drops the
  split back to author-side for that check. Known limit, not guarded.
- `--json` gains `policies` and `ball.advisory`; the ready-line text changed. The in-repo consumers are the
  sweep skill (updated) and `bin/issue-status.cjs`, whose linked-PR ball now follows the same split.

## Alternatives considered

- **Vendor the three policy modules with a drift test.** Rejected: CTK-ADR-0001 forbids a vendored
  fallback, and the LIVE checkout already exists on the machines that run the sweep.
- **Fetch the scripts from GitHub at the base sha and evaluate them.** Rejected: it executes code fetched
  over the network for any `--repo`, a larger trust step than requiring a local checkout the user keeps.
- **Keep every red check as author work.** Rejected: it blamed authors for a red `next` and for a missing
  second review, the two mistakes this record exists to stop.
