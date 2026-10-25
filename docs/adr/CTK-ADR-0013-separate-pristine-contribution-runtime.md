# CTK-ADR-0013: Contribution work runs in a separate, pristine Claude config dir; sync refuses the daily install

- **Status:** Proposed (2026-10-24). Implemented on the bl-pristine-runtime branch (quick 261024-po0);
  awaits Dave's sign-off.
- **Review:** Published for maintainer review and open to revision. A changed decision will be recorded
  by a superseding or amending CTK-ADR, never by a silent edit to an accepted record.
- **Date:** 2026-10-24 (milestone v2.8).
- **Scope:** GSD Contribution Toolkit: the ENF-21 oracle (`hooks/lib/runtime-stamp.cjs`), its CLI
  (`bin/runtime-sync.cjs`), the gate (`hooks/runtime-drift.cjs`), `bin/gsd-refresh`, and the Phase 0
  text of the `maintainer-review-sweep` and `core-contribution` skills.
- **Amends:** CTK-ADR-0011, at two residuals: the one that says a `CLAUDE_CONFIG_DIR` pointing elsewhere
  makes `sync` abort, and the one on local mods that patch managed hooks. CTK-ADR-0011 is not
  withdrawn; its Status stays Accepted and it carries a back-link to this record.
- **Relates to:** CTK-ADR-0007 (the ENF-21 stamp and its verdicts, unchanged here); CTK-ADR-0001
  Decision 2 (fail closed) and Decision 3 (reuse the LIVE upstream installer, never reimplement it).
- **Trigger:** on 2026-10-24 a review-sweep session's Phase 0 ran `runtime-sync sync`, which reinstalled
  the maintainer's daily `~/.claude` install from `origin/next` and dropped six local mods, including the
  patches that make several managed guard hooks fail closed. That evening the maintainer decided that
  contribution work gets its own pristine config dir and that `sync` must never reinstall the daily one.

## Context

Until this record the toolkit fixed its roots at `~/.claude`: `RUNTIME_ROOT` was `~/.claude/gsd-core`,
`HOOKS_ROOT` was `~/.claude/hooks`, and the ENF-21 state (stamp and tip cache) lived in `~/.gsd-contrib`.
`sync` ran gsd-core's `bin/install.js --claude` with the inherited environment, so an exported
`CLAUDE_CONFIG_DIR` sent the install elsewhere while the toolkit kept measuring `~/.claude`.

The daily `~/.claude` is not pristine and is not meant to be: local mods patch files in its `gsd-core/`
and, since 2026-10-22, six managed hooks (CTK-ADR-0011's local-mods residual). Its maintainer is the
local-mods refresh tool, `~/.gsd/local-mods/gsd-refresh.sh`, which reinstalls and then re-applies the
mods. A toolkit `sync` against that dir reinstalls the payload and drops the mods; nothing in the
toolkit stopped it.

Facts this design rests on, read at gsd-core `origin/next` 354d727b: install.js takes `--config-dir`
over the `CLAUDE_CONFIG_DIR` env, treats a blank value as unset and expands a leading `~`; a scratch
`--claude --global --config-dir <dir>` install produced a complete runtime in `<dir>` (its `gsd-core/`,
`hooks/`, `gsd-file-manifest.json`, and a `settings.json` whose hook commands point at `<dir>/hooks`).
Claude Code reads a `~` or an empty `CLAUDE_CONFIG_DIR` against the working directory
(anthropics/claude-code #78988, #104629), so installer and session can disagree on such a value. A
config dir carries its own settings, login (`.credentials.json`), plugins and `.claude.json`.

## Decision

1. **Resolve the session's config dir once.** `CLAUDE_CONFIG_DIR` when set and absolute, else
   `~/.claude`. The runtime root is `<cfg>/gsd-core` and the hooks root `<cfg>/hooks`. One resolver
   (`classifyConfigDir` in `hooks/lib/runtime-stamp.cjs`) serves the gate, `check`, `sync` and `where`.
2. **Refuse an invalid value, never normalize it.** A set but empty, whitespace-only, relative or
   `~`-prefixed value is invalid: it is never trimmed, expanded or mapped to `~/.claude`, because
   install.js and Claude Code would read it differently.
3. **State per config dir.** The daily dir keeps `~/.gsd-contrib` (the daily stamp
   `~/.gsd-contrib/runtime-stamp.json` does not move: readers outside the toolkit bind to it); any other
   dir uses `~/.gsd-contrib/config-dirs/<first 16 hex of sha256(path.resolve(cfg))>`.
   `GSD_CONTRIB_STATE_DIR` still overrides both.
4. **The daily signal.** The daily dirs are `$HOME/.claude` and `<passwd home>/.claude` (the passwd
   home is `os.userInfo().homedir`), so a changed `HOME` cannot unlock the account's real daily dir. A
   config dir is the daily install when its realpath equals the realpath of a daily dir, lies at or
   inside one, or contains one (so `CLAUDE_CONFIG_DIR=$HOME` is refused), or when any top-level entry
   that install.js writes (`gsd-core`, `hooks`, `agents`, `skills`, `commands`, `scripts`, `workflows`,
   `gsd-pristine`, `gsd-migration-journal`, `settings.json`, `gsd-file-manifest.json`) resolves at or
   inside one, by a segment-wise path test (so a sibling `~/.claude-contrib` is not inside). Other
   entries, such as a `rules/` link into the daily dir, are not written by install.js and are not
   checked. A path that does not exist yet resolves through its deepest existing ancestor, and a
   dangling symlink is followed through readlink, so `cfg/hooks -> ~/.claude/<not yet>` is daily too
   (added 2026-10-24 on an independent verifier finding). A classification that cannot be decided
   refuses as invalid, never as a contribution dir: an unreadable passwd home, more than 8 dangling
   symlink hops, or a realpath or readlink error other than "absent" or "not a symlink" (EACCES, ELOOP,
   ENOTDIR and the like). The passwd home, the entry list and the uncertainty rule were added 2026-10-24
   in round 2 on the independent review (WR-02, WR-03, WR-04, IN-01). No durable local-mods marker
   exists via the paths read, so none is used.
5. **`sync` refuses the daily or an invalid dir** with exit 3, before any network call, tmpdir, clone,
   `npm ci` or install, and prints how to start a contribution session. There is no override: no flag,
   env variable or prompt, because no toolkit use legitimately reinstalls the daily install. For a
   contribution dir `sync` runs `install.js --claude --global --config-dir <cfg>` with
   `CLAUDE_CONFIG_DIR=<cfg>` in the child env, and writes the stamp into that dir's state dir. The
   child env drops `GSD_ALLOW_SYMLINKED_DEST` (which disables install.js's symlinked-destination
   guard) and `GSD_AGENTS_DIR` (which redirects its agents dir), so an inherited opt-in cannot let
   install.js write through a symlink into the daily dir.
6. **A read-only `where` verb** prints the config dir, its classification, runtime root, hooks root and
   state dir, and exits 0 for a contribution dir and 3 for the daily or an invalid dir. It writes nothing.
7. **`check` and the gate keep their verdicts.** Only `fresh` allows and an unobtainable upstream tip is
   still the only `ask` (CTK-ADR-0007). On the daily dir a non-fresh result also prints the
   start-a-contribution-session text; an invalid config dir makes `check` exit 3 and the gate deny
   (fail closed). The gate classifies only after it has armed, so a non-governed command costs no IO.
8. **The skills' Phase 0 runs `where` first** (sweep step 0b, core-contribution RT0) and stops with the
   launch form `CLAUDE_CONFIG_DIR=<absolute path> claude` on a non-zero exit. That step is advisory,
   model-driven text; the floors are Decision 5 and the ENF-21 gate at file and push time.
9. **`bin/gsd-refresh` follows the same line.** Every mode that writes (refresh and `--rollback`) runs
   `where` first, before any confirmation, snapshot, prune or restore, and maps a refusal (from `where`
   or from `sync`) to exit 4 with a message naming `~/.gsd/local-mods/gsd-refresh.sh` as the daily
   install's maintainer. Snapshots are kept per config dir (under a key of the dir's realpath, each
   recording `config_dir=` in its meta), so pruning stays within one dir and a rollback restores only a
   snapshot taken of the same dir; a named id must match the snapshot-id form. It never re-applies
   local mods: the only dir it may sync is a pristine contribution dir, which must stay pristine.
   `rebaseline` is retired (it fed the removed mod-baseline assertion; it now exits 1 and writes
   nothing). `check` and `--list` only read; `check` still prints the local-mods audit. The rollback
   classification, the per-dir snapshots and the retirement were added 2026-10-24 in round 2 on the
   independent review (CR-01).

## Consequences

- **Positive:** `sync` can no longer reinstall the daily install, from a sweep, a submit flow or
  `bin/gsd-refresh`, and `bin/gsd-refresh --rollback` can no longer restore into it. A contribution
  session's ENF-21 measures its own pristine runtime and managed hooks. The daily stamp's outside
  readers keep their path. This covers `runtime-sync` and `bin/gsd-refresh` only: `bin/contrib-capability.cjs`
  still writes the daily dir (the capability-delivery residual below).
- **Negative / accepted (adopter cost):** a user with one config dir can no longer sync at all without
  creating a second config dir and logging in there. The login is per dir (its own
  `.credentials.json`); never copy one, since a shared refresh token races.
- **Negative / accepted:** a new contribution dir starts unstamped, so its gate denies until its first
  `sync`. The daily stamp is never refreshed by the toolkit again, so a daily session's gate denies
  filing and pushing with the start-a-contribution-session text. That deny is the forcing function.
- **Residual (provisioning):** a contribution `settings.json` must be generated from the daily one minus
  every managed hook entry and the statusLine, never copied. install.js finds its hook entries by file
  stem, so a copied file would keep running the daily, local-mod-patched hooks while ENF-21 measures a
  pristine `<cfg>/hooks` and reads `fresh`. The toolkit cannot see that; the generation is outside
  this repo.
- **Residual (unmeasured env inheritance):** hook and Bash children inheriting `CLAUDE_CONFIG_DIR` in a
  live session is documented by Claude Code but not measured here. With
  `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` every resolver sees the daily dir, so `sync` refuses and the gate
  denies: fail closed, but confusing; the printed hint names the variable.
- **Residual (upstream coupling):** install.js `--config-dir` was verified at gsd-core `next` 354d727b
  only. If upstream drops or renames it, install.js exits non-zero and `sync` aborts with no stamp.
- **Residual (where the gates load):** the toolkit gates load only from the gsd-core checkout's project
  settings (inferred, not measured), so a contribution session must start in that checkout.
- **Residual (capability delivery):** `bin/contrib-capability.cjs on` delivers commands and skills by
  `CLAUDE_DIR`, not `CLAUDE_CONFIG_DIR`, so in a contribution session it still targets the daily dir.
- **Residual (per-dir surfaces):** plugins (the guard plugin included), MCP servers and push
  allowlists are per config dir, and a fresh contribution dir has none until it is provisioned; until
  then a contribution session is less guarded than a daily one.
- **Residual (gsd-refresh):** `bin/gsd-refresh` no longer re-applies local mods and its writing modes
  refuse the daily dir, but its read-only `check` still prints the hard-wired `~/.gsd/local-mods`
  audit, and whether to retire the command (it is also linked onto the user's PATH) is an open
  follow-up. Snapshots taken before round 2 sit flat in the snapshot root, carry no `config_dir=`, and
  are never listed or restored by it. In the other direction the local-mods refresh
  tool, run inside a contribution session, would follow the exported `CLAUDE_CONFIG_DIR` and install
  into the contribution dir; that tool lives outside this repo.
- **Residual (classification depth):** only the top-level entries install.js writes are checked; a
  symlink deeper down (for example `skills/gsd-x -> ~/.claude/...`) is left to install.js's own
  symlinked-destination guard, which `sync` keeps armed by dropping `GSD_ALLOW_SYMLINKED_DEST`. That
  guard was read on the install paths in gsd-core `next` 354d727b, not on every write.
- **Residual (not measured):** a differently cased spelling of `~/.claude` on a case-insensitive
  filesystem; `~/.gsd` capabilities are shared across config dirs (they are not ENF-21-bound); wiring
  the gates user-scope in the contribution dir is the maintainer's decision and is not built.
- **Residual (test discipline):** while this record was implemented, one red test exercised a default
  write path against the unchanged module, which ignored the injected home, and overwrote the real
  daily stamp with fixture values (the old content was not recoverable; the fixture file was archived,
  so the daily dir reads unstamped). A test that exercises a default write path must assert that the
  resolved path lies under its temp dir before any write, or inject the path; the po0 tests now do.
  Backstop (added 2026-10-24 on the coordinator's request): `hooks/lib/test-fence.cjs` makes the stamp,
  tip-cache and tool-log writers refuse any path inside the real home's `.gsd-contrib` or `.claude`
  while `NODE_TEST_CONTEXT` is set, and an unexpected refusal fails the test file through its exit
  code. Its first full run found 18 pre-existing test files that appended to the real tool log; they now
  call `hooks/lib/test-isolate.cjs` for a temp `GSD_CONTRIB_LOG_DIR`. Since round 2 the fence also arms
  when the process was started with `--test`, so `node --test --test-isolation=none` (which leaves
  `NODE_TEST_CONTEXT` unset) is fenced too, and its own tests name the real paths without relying on
  `HOME`, so the suite is green under a temp `HOME`. Limits: a test file run directly with
  `node file.test.cjs` is not fenced, nor is a child spawned with an env that drops
  `NODE_TEST_CONTEXT`; only those three writers are fenced (the writers of `~/.claude`, such as
  install.js through `sync`, `bin/contrib-capability.cjs` and `bin/gsd-refresh`, are not); and paths are
  compared lexically, without realpath, so a symlink into the real state dir is not caught.

## Alternatives considered

- **A durable local-mods marker as the daily signal.** None exists via the paths read; it could become
  a later second signal beside Decision 4.
- **An explicit, logged override for the refusal.** Rejected: no toolkit use reinstalls the daily
  install, and an override is the path the incident took by accident.
- **Copying or symlinking the daily `settings.json`.** Rejected: install.js dedupes hook entries by file
  stem, so a copy keeps the daily hooks; it writes the file by temp file plus rename, so a symlink is
  replaced by a regular file that carries the daily hook entries (and since round 2 a symlinked
  `settings.json` into the daily dir makes the config dir classify as daily).
- **Per-config-dir state for the daily dir too.** Rejected: readers outside the toolkit bind to the
  daily stamp path.
- **Expanding `~` or trimming the value like install.js.** Rejected: Claude Code reads such values
  against the working directory, so the session and the installer would read different dirs.
