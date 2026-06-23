---
description: Run the release pre-flight against all four LIVE release scripts before cutting a release (OWN-02).
argument-hint: "(no args needed)"
allowed-tools: Bash, Read
---

Run the OWN-02 release/publish **pre-flight** — a one-command, **advisory, read-only**
check that runs the four LIVE gsd-core release scripts in a non-mutating capacity, aggregates
**every** failure (no fail-fast), and exits nonzero if any blocker exists, so you see the full
picture before cutting a release.

**This is advisory, NOT a deny gate.** It returns no permission verdict and is not a PreToolUse
hook — it surfaces blockers; it does not block a tool call. It **never mutates** the working
tree or GitHub: it runs each LIVE script only in its check/dry-run capacity
(`check-npm-integrity` read-only, `release-tarball-smoke` dry-run, `sync-manifest-versions`
`--check`, `sync-next-version`'s pure release-version predicate — never its PR/in-place
mutation).

## Steps

1. **Run it from inside the gsd-core checkout root** (the LIVE-script resolver needs a gsd-core
   sentinel cwd). From the toolkit repo, point node at the doer while `cd`'d into gsd-core:

   ```bash
   cd ~/repos/gsd-core && node ~/repos/gsd-contrib-toolkit/bin/release-preflight.cjs
   ```

   (Adjust the gsd-core path if your checkout lives elsewhere. If you are already inside the
   gsd-core checkout, just run `node /path/to/gsd-contrib-toolkit/bin/release-preflight.cjs`.)

2. **Surface the aggregated PASS/FAIL output verbatim.** Each of the four LIVE release scripts
   prints one `[PASS]`/`[FAIL]` line with a detail; the final summary states whether it is clear
   to cut a release.

3. **If the CLI exits nonzero, STOP and report — the release is blocked.** Any single `[FAIL]`
   (integrity drift, manifest version drift, a non-release package version, a smoke failure, or a
   LOUD missing-LIVE-script error) blocks the release. List every failing check and its detail;
   do not proceed to cut a release until all four are `[PASS]`.

4. **A LOUD missing-LIVE-script error is a real FAIL, never a false green.** If a LIVE release
   script cannot be resolved or loaded, the pre-flight reports it as an explicit FAIL (HARD-02) —
   treat it as a blocker, not a pass.

Report the exit code and the per-script verdicts back to me.
