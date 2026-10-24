# CTK-ADR-0011: Runtime freshness also binds the managed gsd-core hooks

- **Status:** Proposed (2026-10-17). Implemented on branch
  davesienkowski/fix-runtime-sync-builds-hooks; awaits Dave's sign-off.
- **Review:** Published for maintainer review and open to revision. A changed decision will be recorded
  by a superseding or amending CTK-ADR, never by a silent edit to an accepted record.
- **Date:** 2026-10-17 (milestone v2.8).
- **Scope:** GSD Contribution Toolkit.
- **Amends:** CTK-ADR-0007 Decision 1 (the digest scope now also covers the managed gsd-core hooks
  under ~/.claude/hooks) and Decision 5 (what the fast path proves). CTK-ADR-0007 is not withdrawn;
  its Status stays Accepted and it carries a back-link to this record.
- **Relates to:** ENF-21 (`hooks/runtime-drift.cjs`), its remediation CLI (`bin/runtime-sync.cjs`) and
  its oracle (`hooks/lib/runtime-stamp.cjs`); CTK-ADR-0001 Decision 3 (reuse the LIVE upstream script,
  never reimplement it); CTK-ADR-0010's W5 row (a gate hot-path file is read only through the bounded
  regular-file reader `hooks/lib/regular-file.cjs`). Implemented as quick task 261017-w1i.

## Context

CTK-ADR-0007 made "the installed gsd-core runtime is at `origin/next`" a machine fact: a toolkit-owned
stamp records the tip SHA plus a digest of `~/.claude/gsd-core`, the ENF-21 gate re-measures that
digest on every governed command, and `node bin/runtime-sync.cjs sync` is the one remediation.

That runtime is not the whole install. gsd-core's installer also writes its hooks into
`~/.claude/hooks`, and the remediation could reinstall gsd-core without ever building them. The
mechanism, read from gsd-core `origin/next` (030e7ca20, 2026-10-17):

1. `package.json` sets `"prepare": "npm run build:lib"`. `npm run build:hooks`
   (`node scripts/build-hooks.js`) is a separate script, run only by `build` and `prepublishOnly`.
   So the `npm ci` that `sync` runs builds `bin/lib` and never builds the hooks.
2. `.gitignore` line 18 lists `hooks/dist/`, so a fresh clone has no built hooks.
3. `bin/install.js` `installSharedHooksBundle` copies hooks only inside
   `if (fs.existsSync(hooksSrc))`, where `hooksSrc` is `<clone>/hooks/dist`. With no `hooks/dist` it
   copies nothing and raises nothing. With one, every top-level regular file is rewritten into
   `~/.claude/hooks` (`.js` / `.cjs` with config-dir, branding, `gsd:` and `{{GSD_VERSION}}` rewrites
   and `writeFileSync`; `.sh` with `{{GSD_VERSION}}` and `writeFileSync`; anything else
   `copyFileSync`), and each top-level directory is recursed one level for its regular files (a
   child `.sh` with `{{GSD_VERSION}}` and `writeFileSync`; every other child, including the
   `lib/*.js` helpers, `copyFileSync`).
4. CTK-ADR-0007's `runtime_digest` covers only `~/.claude/gsd-core`, never `~/.claude/hooks`.

So `sync`'s slow path ran `npm ci`, then install.js, which silently kept the OLD hooks, and the stamp
it then wrote read `fresh`. The gate and `check` agreed, because neither looked at the hooks.
Contributing with stale hooks is the same failure CTK-ADR-0007 exists to prevent: local behavior that
does not match `next`.

`~/.claude/hooks` is also not gsd-core's alone. On this machine it holds the user's and the local
mods' own files (for example `artifact-gate.cjs`, `herdr-agent-state.sh`, `gsd-planning-track.sh`,
`gsd-planning-push.sh`, `gsd-baton-statusline.sh`, `package.json`), which no gsd-core install writes.

## Decision

1. **The slow path builds the hooks, between `npm ci` and install.js, or aborts.** `sync` runs the
   LIVE upstream script as the child process `npm run build:hooks`, with the clone as cwd, no shell
   and a bounded timeout (`BUILD_HOOKS_TIMEOUT_MS`, 120 s). The clone's `scripts/build-hooks.js` is
   never loaded into the toolkit's own process. A failed or timed-out build ends the sync non-zero
   with reason `hooks-build-failed`, and the abort quotes the first non-empty line of the build's
   stderr (control characters removed, at most 200 characters), because that is where npm says why;
   a build that exits 0 but leaves `hooks/dist` with no regular file at depth 0 or 1 ends it with
   `hooks-dist-empty`. Neither runs install.js, neither writes a stamp, and the tmpdir is still
   removed.

2. **The managed hook set is the built `hooks/dist` inventory, never all of `~/.claude/hooks`.**
   `hooksInventory` mirrors install.js: each top-level entry is stat'ed with symlinks followed; a
   regular file is listed by name, a directory adds each regular-file child as `<dir>/<child>`, and
   anything deeper or non-regular is skipped. Dot-names are kept, because install.js copies them. The
   result is a list of POSIX relpaths sorted by plain `Array#sort`. A file in `~/.claude/hooks` that is
   not in that list is never listed, read, digested or required, so editing a user-owned hook can never
   turn ENF-21 into a deny. Every listed name must also pass the relpath rule of Decision 4
   (`isManagedHookRel`) before install.js runs: a name that fails it ends the sync with
   `hooks-dist-unsafe-name`, no install.js and no stamp, and on the fast path it is inconclusive. A
   name the stamp could not record would otherwise surface only at stamp time, after a full install.

3. **After install.js, every managed hook must have been written by this install.** The install start
   is captured immediately before install.js runs. `verifyHooksWritten` then requires every listed
   relpath to exist under `~/.claude/hooks` as a regular file whose write time, the later of its mtime
   and its ctime, is no older than the install start minus `HOOK_MTIME_SLACK_MS` (2000 ms); a missing
   or older file ends the sync with `post-install-hooks-mismatch` and no stamp. A timestamp that is not
   a finite number is ignored, and a file with neither is stale. ctime is included because install.js
   writes only the top-level `.js`, `.cjs` and `.sh` hooks and a subdirectory's `.sh` files with
   `writeFileSync`, and copies everything else, including the `lib/*.js` helpers, with
   `copyFileSync`; a copy API may carry the source's mtime over, but it cannot carry ctime, which the
   kernel sets on the write. What this
   proves: each managed file was written (or had its metadata changed) during the install window. What
   it does not prove: that its bytes are right. Bytes cannot be compared, because install.js rewrites
   hook content; names alone cannot catch the measured defect, because the stale hooks carry the right
   names.

4. **The stamp gains two additive fields; `STAMP_SCHEMA` stays 1.** A stamp written by `sync` records
   `hooks_files` (the sorted inventory) and `hooks_digest`, a `sha256:<hex>` over the listed files as
   installed under `~/.claude/hooks`, measured at stamp time. The framing, over a sorted copy of the
   list: a present regular file contributes `<rel> 0x00 <bytes> 0x00`; a missing one, or a path that is
   not a regular file, contributes `<rel>` followed by the marker `0x01 MISSING 0x00`, so absence always
   changes the digest and an empty file or a file whose text is `MISSING` cannot forge it. A non-regular
   path is framed missing without being opened, and a regular file is read through the bounded
   regular-file reader (CTK-ADR-0010 W5), so a FIFO, device, directory or symlink to one cannot stall
   the gate. `validateStamp` accepts a stamp with neither field (a legacy stamp), and throws FailClosed
   when only one is present, when `hooks_files` is not a non-empty array, when an entry is empty, has a
   backslash, a control character, a leading slash, a `.` or `..` segment or more than two segments,
   when the list is not strictly ascending (unsorted or duplicated), or when `hooks_digest` is not
   `sha256:<64-hex>`. The relpath rule is also the path-traversal guard: `hooksDigest` re-checks every
   entry before joining it under the hooks root.

5. **`evaluateDrift` checks in a fixed order, and an old stamp denies once.** The order: no stamp gives
   `unstamped`; a runtime digest mismatch gives `unverified` with the existing runtime reason, even when
   the hooks also differ; a stamp without hook fields gives `unverified`, saying the stamp predates hook
   coverage and to re-run sync; a hooks digest that differs from the stamped one (or was not measured)
   gives `unverified` naming `~/.claude/hooks`; then the SHA gives `drifted` or `fresh`. A stamp written
   before this record has no hook fields, so it reads `unverified` until one `sync` re-stamps it. That
   is the designed first-use cost; reading a legacy stamp as `fresh` would keep the hole open.

6. **One measurement helper, injectable roots.** `HOOKS_ROOT` is
   `path.join(path.dirname(RUNTIME_ROOT), 'hooks')`. `check` and the gate both measure through
   `hooksDigestForStamp(stamp, root)`, on every call with no module-level cache; it returns null
   without touching the filesystem when the stamp lists no hooks. `sync` and `check` take `hooksRoot`,
   and the gate takes `deps.hooksDigest(stamp)`, measured after the stamp read and before the upstream
   tip, outside the narrow `UpstreamUnavailable` catch, so a measurement failure denies through
   `runGate` and never becomes `ask`.

7. **The fast path stamps only when the hooks are also equal.** The no-reinstall fast path of
   CTK-ADR-0007 Decision 5 may stamp `payload-verified` only when all three hold: the payload digests
   are equal, an early `npm run build:hooks` in the clone succeeded, and every file of the built
   `hooks/dist` is byte-equal to its installed copy. An early build failure, an empty `hooks/dist` or
   any hook difference is inconclusive and falls through to the slow path (not an abort), which still
   runs the symlinked-runtime-root preflight first and never sets `GSD_ALLOW_SYMLINKED_DEST`. The
   condition closes the hooks-only-upstream-commit hole rather than recording it, but it cannot hold
   on any real install today: install.js replaces `{{GSD_VERSION}}` with the package version in every
   `.js`, `.cjs` and `.sh` hook it writes, and 28 of the 30 top-level files under gsd-core `hooks/`
   carry that placeholder at 030e7ca20 (`git grep -l`; the two without are `hooks.json` and
   `managed-hooks-registry.cjs`). The built `hooks/dist` keeps the placeholder, while the installed
   copy reads, for example, `gsd-hook-version: 1.17.0` (scratch-HOME install, 2026-10-17). So the
   built and installed bytes differ and the fast path never stamps. On an installer-produced runtime
   the first condition fails too: the installer's payload rewrites (CTK-ADR-0007 Decision 6) keep the
   raw clone's payload digest from matching, so the early build is not even reached. Measured
   2026-10-18 in a scratch HOME: a second `sync` straight after a successful one, with nothing
   changed, printed "Installed payload differs from the raw clone" and reinstalled. Every `sync`
   therefore reinstalls; the early build costs one extra `npm run build:hooks` only in the case where
   the payload digests do match. The fast-path code is kept for now;
   removing or replacing it is a follow-up.

## Consequences

- **Positive:** a `sync` that cannot build or confirm the gsd-core hooks no longer writes a stamp,
  and a stamp now binds the managed hook set, so stale, edited, removed or replaced managed hooks read
  `unverified` in both `check` and the gate.
- **Positive:** the user's own files in `~/.claude/hooks` never affect the verdict.
- **Negative / accepted:** every pre-existing stamp denies once (`unverified`, predates hook
  coverage) until one `sync`. This is the designed first-use cost.
- **Negative / accepted:** the gate now reads the managed hook files on each governed command, in
  addition to the runtime tree. A non-governed command still costs nothing.
- **Residual:** the write-time check proves each managed file was written in the install window, not
  that its bytes are right. Because it takes the later of mtime and ctime, a managed file that was
  only re-permissioned, re-owned or renamed inside the window (a metadata change that advances ctime)
  also passes it.
- **Residual:** a concurrent writer that rewrites a managed hook inside the install window is not
  detected by the write-time check. The next gate call re-measures the digest against the stamp, but that
  digest was taken after the concurrent write, so the stamp binds whatever was on disk at stamp time.
- **Residual:** the digest reads each file as UTF-8 text through the bounded reader and re-encodes it,
  so two files that differ only in invalid UTF-8 sequences digest equal.
- **Residual:** if `CLAUDE_CONFIG_DIR` points the install somewhere other than `~/.claude`, the
  post-install check finds the managed hooks missing or stale and aborts (fail closed, no stamp), the
  same assumption `RUNTIME_ROOT` already makes.
- **Residual:** a copy API that preserves the source's mtime (plausibly `copyFileSync` on some
  platforms; not measured here) no longer makes the sync abort, because the check also reads ctime.
  What still makes it abort, never stamp falsely: a filesystem whose clock or timestamps lag the
  install start by more than the 2 s slack (for example a network or drvfs mount, or coarse timestamp
  granularity at the boundary), or one that reports no usable mtime or ctime. The ctime behavior was
  verified on Linux (WSL2 ext4), where `utimes` backdates mtime and leaves ctime at the current time;
  other platforms were not measured.
- **Residual (upstream coupling):** the toolkit names three gsd-core internals that no LIVE API
  exposes: the `build:hooks` script (gsd-core `package.json`), its output directory `hooks/dist`
  (shared by `scripts/build-hooks.js` and install.js's `hooksSrc`), and install.js's one-level walk
  that `hooksInventory` mirrors; `HOOKS_ROOT` also assumes the Claude shared-hooks directory is named
  `hooks`. If upstream renames the script, folds it into another script, moves the output or changes
  the walk, every `sync` aborts (`hooks-build-failed`, `hooks-dist-empty` or
  `post-install-hooks-mismatch`) while the gate keeps denying. That fails closed: no stamp is ever
  written over hooks the toolkit could not confirm. Recovery is a toolkit change that follows
  upstream (update the script name, the dist path or `hooksInventory`, with a test), then one `sync`.
  The `hooks-build-failed` abort quotes the build's first stderr line (for example npm's
  `Missing script: "build:hooks"`), so the cause is visible without re-running anything. Do not
  hand-write the stamp to get past it.
- **Residual, known consequence (corrected 2026-10-23):** a local mod that edits a managed hook makes
  the gate deny. The 2026-10-17 local-mods audit (31 modified and 1 missing file, none under
  `hooks/`) found none, but that is no longer true. Since 2026-10-22 three local mods patch six
  managed hooks under `~/.claude/hooks`: `guards-fail-closed.sh` (`gsd-secret-read-guard.js`,
  `gsd-write-guard.js`, `gsd-agent-isolation-guard.js`, `gsd-worktree-path-guard.js`),
  `worker-state-record.sh` (`gsd-context-monitor.js`) and the quiet-workflow-advisory step in
  `gsd-refresh.sh` (`gsd-workflow-guard.js`). Their header comments say `~/.claude/hooks` is outside
  the ENF-21 digest; with this record that is false. After a local-mod restore
  (`gsd-refresh.sh --restore-only`) the stamp re-measure of the hooks reads UNVERIFIED and the gate
  denies. That is fail-closed, the same posture the runtime digest already has after local mods patch
  `~/.claude/gsd-core`. Options, not decided here: (a) re-stamp after every restore, which is only
  honest if the stamp is then taken over the patched bytes on purpose; (b) exclude the mod-patched
  hooks from the managed set, which leaves those six files unbound by the gate.
- **Out of scope, named:** the pre-existing whole-tree `runtime_digest` already reads `unverified`
  after local mods patch `~/.claude/gsd-core` (for example its `bin/lib` or `workflows`). This record
  does not change that.

## Alternatives considered

- **Digest all of `~/.claude/hooks`.** Rejected: that directory holds the user's and the local mods'
  own files, so every edit to one would turn ENF-21 into a deny. The managed set is what the build
  produced (Decision 2).
- **Compare the installed hooks' bytes to `hooks/dist` after install.** Rejected as the post-install
  check: install.js rewrites `.js` and `.cjs` content (config-dir paths, branding, `gsd:`,
  `{{GSD_VERSION}}`) and `.sh` content (`{{GSD_VERSION}}`), so a correct install need not match byte
  for byte, and a check that a correct install can fail would block every sync. Byte-equality survives
  only as the fast path's stricter condition (Decision 7), where a miss costs a reinstall, not an
  abort.
- **`require()` the clone's `scripts/build-hooks.js` in-process.** Rejected: it would run upstream code
  inside the CLI's own module scope, and it reimplements the build entry point instead of reusing the
  LIVE `npm run build:hooks` script (CTK-ADR-0001 Decision 3).
- **Bump `STAMP_SCHEMA`.** Rejected: an unknown schema is FailClosed, so a bump would hard-fail every
  older reader. Additive fields plus the `unverified` path for a hook-less stamp keep old readers
  working and old stamps safe.
