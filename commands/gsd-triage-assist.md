---
description: Advisory first-triage of an incoming open-gsd/gsd-core issue — runs LIVE issue-dedupe + version-gate, suggests a canonical triage role from LIVE triage-labels.md, and surfaces the needs-triage strip for you to confirm. Complements (does not replace) the re-review sweep.
argument-hint: "#N | <issue number/title/body> | … --apply (only on explicit authorization)"
allowed-tools: Skill, Bash, Read, Grep, Glob, AskUserQuestion
---

**BEFORE ANYTHING ELSE: invoke the Skill tool with `skill: "maintainer-review-sweep"` now.**

Do not fetch the issue, run any dedupe, suggest a role, or relabel until that skill is loaded. Once it is, follow its **[triage-assist.md](../skills/maintainer-review-sweep/triage-assist.md)** sub-procedure exactly — the triage assist is an *advisory* first-pass that complements the re-review sweep, not a replacement for it.

The doer is **`node bin/triage-assist.cjs`**, run from inside the gsd-core checkout (so the `hooks/lib` resolver finds the LIVE scripts). It is advisory: it returns no allow/deny verdict, is not a PreToolUse gate, and performs **no GitHub mutation by default**.

- **Evidence is exogenous.** The dedupe signal, the version-gate finding, and the suggested role all come from the LIVE gsd-core scripts the assist actually invoked (`scripts/issue-dedupe.cjs`, `scripts/issue-version-gate.cjs`, `docs/agents/triage-labels.md`) — never synthesized. If a LIVE script could not be loaded the assist fails LOUD (explicit error); report that, never a clean/no-duplicate result.
- **Role source is LIVE-only.** The suggested canonical role is read ONLY from LIVE `docs/agents/triage-labels.md` — there is no toolkit-side heuristic role logic (decision D-07 / HARD-02). State the role with that file as the sole source.
- **Surface, don't auto-apply.** Present the suggested role + the exact `gh` label-apply + `needs-triage` strip commands as the maintainer's **explicit confirm step** — never an automatic mutation (decision D-04).
- **`--apply` only on explicit authorization.** Pass `--apply` to `bin/triage-assist.cjs` ONLY when the request below explicitly authorizes applying the label / stripping `needs-triage` for that one issue (decision D-05). Default invocation is surface-only.

**Interpreting my request below:**
- A bare issue number / "triage #N" / a pasted issue → run the assist in **surface mode** (no `--apply`); present the dedupe signal, version-gate finding, suggested role, and the remediation commands, then stop and await my confirm.
- Explicitly authorizes applying (e.g. "apply the role and strip needs-triage on #N", "confirm and label it") → treat as authorization to run with `--apply` **for that one resolved issue only**. If you cannot pin the authorization to exactly one issue, ask which one before any `--apply`.

My request:

$ARGUMENTS
