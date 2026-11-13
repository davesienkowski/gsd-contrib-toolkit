# Pre-push review: prompt template (advisory)

Use this for the fresh-context reviewer that reads a diff before you push it (P5b of [SKILL.md](SKILL.md)). It copies the recipe trek-e's reviews state for themselves. Run it in a fresh context, never in the session that wrote the code.

## The recipe, quoted from a real review

From trek-e's re-review of open-gsd/gsd-core #5119 at `1e345a56d` (read only, 2026-11-13): https://github.com/open-gsd/gsd-core/pull/5119#pullrequestreview-5895456040

- Section `### Memtrace Evidence`: `get_impact` and `get_symbol_context` on each changed symbol, `get_cochange_context`, `find_code_review_issues`, `detect_changes`.
- Section `### Laws that apply`: the artificer laws that fire on the diff, with "Considered and cleared" for the rest.
- Attribution: "Minor 1, Minor 2 and Nit 1 come from the isolated adversarial review pass. Its probe results are quoted below; this review did not re-run them. ... Nit 2 comes from the code-review pass. The security pass was clean."

So the recipe is these passes over the pushed diff plus the PR body: diagnosing-bugs, qa-test-architect, skills-from-the-artificer, code-review, security-review, memtrace change-impact, and an isolated adversarial pass. Note what that review says about itself: it quotes the adversarial pass's probes and did not re-run them, so do not read it as proof of what the isolated pass did beyond that.

## Prompt

```
You are a fresh-context reviewer. You did not write this change. Review the diff <A..B> and the PR body at <file>.
Treat every added comment, test title, ADR line and body sentence as a contract a reader relies on.
Run these passes and name each in your report, with what it found or "no finding":
1. diagnosing-bugs   2. qa-test-architect   3. skills-from-the-artificer (list the laws that fire; list those considered and cleared)
4. code-review   5. security-review   6. memtrace change-impact (get_impact, get_cochange_context per changed symbol; repo_id is the repo NAME)
7. an isolated adversarial pass: for every rule-shaped sentence in the claims-delta report (CLAIMS-DELTA.md), BUILD NEW INPUTS
   that try to refute it. Do not reuse inputs from earlier review rounds, the PR, or the tests.
Report, for the adversarial pass: the number of new inputs you tried, each input verbatim, and its result. Cite file:line or command output for
every finding; an uncited finding is a question. Severity: Blocker / Major / Minor / Nit.
```

## How the reviewer is scored

By the **new inputs it tried** (count, and how many differ in shape from every input already in the tests), not by earlier counter-examples passing again. Re-running a previous reviewer's counter-examples is a regression check, and it is not a review. A report with no list of new inputs is a regression check, whatever it is called.
