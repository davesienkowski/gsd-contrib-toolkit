---
description: Surface drift between declared .github/rulesets/ and live branch protection; --apply runs the LIVE remediation (OWN-03).
argument-hint: "(empty = read-only drift report) | --apply"
allowed-tools: Bash, Read
---

Run the OWN-03 ruleset-governance **drift report** — a one-command, **advisory, read-only**
check that compares the **declared** ruleset state (`.github/rulesets/*.json`) against the
**live** state (`gh api repos/<repo>/rulesets`) and surfaces any drift in `enforcement`, ruleset
presence, or the `rules` set.

**This is advisory, NOT a deny gate.** It returns no permission verdict and is not a PreToolUse
hook — it surfaces drift; it does not block a tool call. **The default invocation is read-only**:
it reads the declared JSON and the live `gh api` state and PRINTS the diff plus the exact LIVE
remediation commands. It **never mutates** branch protection or rulesets by default.

**`--apply` runs the LIVE remediation — only on explicit maintainer authorization.** With
`--apply` the CLI invokes the LIVE `scripts/sync-rulesets.sh` (ruleset enforcement) and
`scripts/setup-branch-protection.sh` (branch protection) — the toolkit never reimplements that
apply policy (HARD-02). `--apply` is **never** the default and is a maintainer choice, not an
automatic mutation (D-05/D-08).

## Steps

1. **Run it from inside the gsd-core checkout root** (the LIVE-script resolver, the
   `.github/rulesets/` declared source, and the LIVE remediation scripts all live there). From the
   toolkit repo, point node at the doer while `cd`'d into gsd-core:

   ```bash
   cd ~/repos/gsd-core && node ~/repos/gsd-contrib-toolkit/bin/ruleset-drift.cjs
   ```

   For the guarded remediation (explicit maintainer authorization only):

   ```bash
   cd ~/repos/gsd-core && node ~/repos/gsd-contrib-toolkit/bin/ruleset-drift.cjs --apply
   ```

   (Adjust the gsd-core path if your checkout lives elsewhere. If you are already inside the
   gsd-core checkout, just run `node /path/to/gsd-contrib-toolkit/bin/ruleset-drift.cjs`.)

2. **Surface the declared-vs-live drift report verbatim.** Each drift row names the ruleset, the
   drifted field (`enforcement` / `presence` / `rules`), and the declared vs live values. When the
   declared and live state agree, it reports in-sync with no drift.

3. **A failed read is a LOUD error, never a false "no drift".** If the declared `.github/rulesets/`
   read or the live `gh api` read fails (missing dir, bad JSON, unauthenticated/failed `gh`), the
   CLI exits nonzero with an explicit error (HARD-02) — treat it as a blocker, not an in-sync
   result.

4. **Do not pass `--apply` unless the maintainer explicitly authorizes the mutation.** The default
   read-only report is the safe path; `--apply` runs the LIVE `sync-rulesets.sh` /
   `setup-branch-protection.sh` against live GitHub state. Never run it by default (D-05/D-08).

Report the drift rows (or the in-sync verdict) and the exit code back to me.
