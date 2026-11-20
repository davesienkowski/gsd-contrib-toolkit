# CTK-ADR-0017: A fail-open read guard may deny the Read tool

- **Status:** Proposed (2026-11-19), implemented on the `gate-emitted-cjs-read` branch (quick 261119-szk). The
  gsd-contrib-toolkit orchestrator dispatched the hook under Dave's 2026-11-19 approval to build the hooks as Tier A
  gates with tests; Dave has not reviewed the content of this record.
- **Review:** Published for maintainer review and open to revision. A changed decision will be recorded by a
  superseding or amending CTK-ADR, never by a silent edit to an accepted record.
- **Date:** 2026-11-19 (milestone v2.8).
- **Scope:** GSD Contribution Toolkit: `hooks/emitted-cjs-read.cjs` (ENF-26) and its bundle copy, the one
  `PreToolUse` `Read` registration in `settings.snippet.json` and `capability.json`, and the count categories in
  `docs-hook-counts.test.cjs`. Every other gate, `hooks/lib/failclosed.cjs` and `runGate` are unchanged.
- **Amends:** CTK-ADR-0001 Decision 1 (outcomes, not steps) and Decision 2 (fail closed); CTK-ADR-0005 Decision 2
  (deny only with a measured near-zero false-positive rate) and Decision 4 (a check that can deny fails closed); and
  CTK-ADR-0007 (a check that can deny never resolves an unobtainable input to allow). Each exception below is
  confined to the read-guard class this record defines; for every other gate those clauses hold unchanged.
- **Relates to:** gsd-core ADR-457 (generated CJS has a single source); `hooks/binlib-edit.cjs` (ENF-03), whose
  candidate filter, env scrub and probe bound this guard reuses; `.planning/REQUIREMENTS.md`, which recorded this
  feature as a future "Read-side advisory redirect".

## Context

gsd-core compiles `src/**/*.cts` into gitignored `gsd-core/bin/lib/**/*.cjs` (tsconfig.build.json: rootDir `src`,
outDir `gsd-core/bin/lib`, sourceMap false). An agent that reads the emitted copy as if it were source loads tsc
output into its context: the authored comments and types are gone, and the code it reasons about is not the code it
must edit. binlib-edit already stops the edit of an emitted file; nothing steered the read.

A read is a step, not an outcome. The toolkit's gates deny broken outcomes (CTK-ADR-0001 Decision 1) and fail
closed (Decision 2), and since CTK-ADR-0005 a check that can deny may fail open only if it cannot deny. A read guard
that failed closed would block legitimate reads of any file on a hook error, which is a worse outcome than the
one it prevents. So the existing rules leave two choices: a non-denying advisory, or a new class.

## Decision

1. **The class.** A *read guard* is a `PreToolUse` hook registered only on the `Read` matcher. It may return
   `deny` for a Read of a file it can show is generated output, with a reason that names the source to read
   instead. It never denies a contribution outcome (an issue, a PR, a push, a commit or an edit).
2. **Silent pass, never an explicit allow.** Every path that does not deny writes nothing and exits 0. Claude
   Code's `permissionDecision: "allow"` skips the permission prompt, so an explicit allow from a guard would
   approve Reads the user's permission settings would have prompted for. Only an object whose permissionDecision
   is exactly `deny` produces output; the guard does not use `emit()` or `runGate`.
3. **Fail open.** Any error or undecidable input (malformed payload, no gsd-core root, a filesystem or git error,
   a git timeout, a module that fails to load) is a silent pass. This amends CTK-ADR-0001 Decision 2,
   CTK-ADR-0005 Decision 4 and CTK-ADR-0007 for this class only: a false pass costs some context quality; a
   fail-closed read guard would take every Read of the matching paths offline on a hook fault.
4. **Two signals before a deny.** ENF-26 denies only when the `src/<rel>.cts` twin is a regular file AND
   `git check-ignore` reports the emitted file ignored. A tracked hand-written file with a twin (a module being
   ported) stays readable, matching binlib-edit, which allows editing it.
5. **The false-positive bar.** CTK-ADR-0005 Decision 2 asks for a measured near-zero false-positive rate before a
   deny. No rate over real Reads was measured. What was measured is the agreement of the two signals over the file
   population of one gsd-core commit (36e60c09f: 287 bin/lib `.cjs` files with a twin, all ignored; 13 without,
   none ignored). That is structural evidence, not a false-positive rate. The bar is waived for this class because
   a false deny blocks no outcome and costs one Bash call, and the known false-deny classes are named below.
6. **Deny, not advisory.** An advisory (`additionalContext` beside a pass) still loads the emitted file, which is
   the harm. `ask` is no middle ground: under bypass mode it degrades to allow and loads the file, and in a `-p`
   run it denies anyway.
7. **The deliberate route.** Reading the emitted output on purpose goes through Bash (`sed -n`, `cat`), which the
   guard does not see; the deny reason says so. No environment valve is added, and GSD_CONTRIB_OVERRIDE does not
   apply (it rescues thrown errors in `runGate` gates, and this guard throws nothing out).

## Consequences

- **Coverage is only the Read tool.** Grep, Glob, NotebookRead and Bash reads are not seen; neither is a hard link
  to an emitted file, nor a case alias of the bin/lib path where realpath does not canonicalise case. The guard
  steers an agent that uses Read; it is not a boundary against one that reads another way.
- **Known false denies.** (a) A Read meant to see the emitted code itself, such as a stack trace line number,
  which exists only in the emitted file because gsd-core emits no source maps. (b) An untracked hand-written file
  with a twin that a nested repository or a global git excludes file reports ignored. Both are a silent pass away
  through Bash.
- **Counts.** The documented "fail-closed `PreToolUse` gates" stay the Bash, Write|Edit and EnterWorktree gates;
  the read guard is its own category, and every "can deny" sentence names both.
- **Timeout.** A `PreToolUse` command hook that Claude Code cancels at its timeout does not block the call (the
  hooks reference), so a hung guard also passes; the guard bounds its own git probe at 3000 ms.

## Alternatives considered

- **Advisory only** (the earlier REQUIREMENTS.md wording): rejected, the emitted file still loads.
- **Fail closed like binlib-edit**: rejected, a hook fault would block every matching Read and give nothing back.
- **Twin only, no git** (the first plan): rejected after review, it denies a tracked hand-written file during its
  port, which binlib-edit lets you edit.
- **Explicit allow on a pass** (the shared `emit()`): rejected, it skips the permission prompt.
