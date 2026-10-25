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
4. **The daily signal.** A config dir is the daily install when its realpath equals the realpath of
   `~/.claude`, or when its realpath, or the realpath of its `gsd-core` or `hooks`, lies at or inside
   `~/.claude` by a segment-wise path test (so a sibling `~/.claude-contrib` is not inside). No durable
   local-mods marker exists via the paths read, so none is used.
5. **`sync` refuses the daily or an invalid dir** with exit 3, before any network call, tmpdir, clone,
   `npm ci` or install, and prints how to start a contribution session. There is no override: no flag,
   env variable or prompt, because no toolkit use legitimately reinstalls the daily install. For a
   contribution dir `sync` runs `install.js --claude --global --config-dir <cfg>` with
   `CLAUDE_CONFIG_DIR=<cfg>` in the child env, and writes the stamp into that dir's state dir.
6. **A read-only `where` verb** prints the config dir, its classification, runtime root, hooks root and
   state dir, and exits 0 for a contribution dir and 3 for the daily or an invalid dir. It writes nothing.
7. **`check` and the gate keep their verdicts.** Only `fresh` allows and an unobtainable upstream tip is
   still the only `ask` (CTK-ADR-0007). On the daily dir a non-fresh result also prints the
   start-a-contribution-session text; an invalid config dir makes `check` exit 3 and the gate deny
   (fail closed). The gate classifies only after it has armed, so a non-governed command costs no IO.
8. **The skills' Phase 0 runs `where` first** (sweep step 0b, core-contribution RT0) and stops with the
   launch form `CLAUDE_CONFIG_DIR=<absolute path> claude` on a non-zero exit. That step is advisory,
   model-driven text; the floors are Decision 5 and the ENF-21 gate at file and push time.
9. **`bin/gsd-refresh` follows the same line.** It runs `where` before its confirmation and snapshot,
   maps a refusal (from `where` or from `sync`) to exit 4 with a message naming
   `~/.gsd/local-mods/gsd-refresh.sh` as the daily install's maintainer, and never re-applies local mods:
   the only dir it may sync is a pristine contribution dir, which must stay pristine. Its `check` and
   `rebaseline` subcommands still read the local-mods audit.

## Consequences

- **Positive:** `sync` can no longer reinstall the daily install, from a sweep, a submit flow or
  `bin/gsd-refresh`. A contribution session's ENF-21 measures its own pristine runtime and managed
  hooks. The daily stamp's outside readers keep their path.
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
- **Residual (gsd-refresh):** `bin/gsd-refresh` no longer re-applies local mods, but its `check` and
  `rebaseline` still read the hard-wired `~/.gsd/local-mods` audit, and whether to retire it (it is
  also linked onto the user's PATH) is an open follow-up. In the other direction the local-mods refresh
  tool, run inside a contribution session, would follow the exported `CLAUDE_CONFIG_DIR` and install
  into the contribution dir; that tool lives outside this repo.
- **Residual (not measured):** a differently cased spelling of `~/.claude` on a case-insensitive
  filesystem; `~/.gsd` capabilities are shared across config dirs (they are not ENF-21-bound); wiring
  the gates user-scope in the contribution dir is the maintainer's decision and is not built.
- **Residual (test discipline):** while this record was implemented, one red test exercised a default
  write path against the unchanged module, which ignored the injected home, and overwrote the real
  daily stamp with fixture values (the old content was not recoverable; the fixture file was archived,
  so the daily dir reads unstamped). A test that exercises a default write path must assert that the
  resolved path lies under its temp dir before any write, or inject the path; the po0 tests now do.

## Alternatives considered

- **A durable local-mods marker as the daily signal.** None exists via the paths read; it could become
  a later second signal beside Decision 4.
- **An explicit, logged override for the refusal.** Rejected: no toolkit use reinstalls the daily
  install, and an override is the path the incident took by accident.
- **Copying or symlinking the daily `settings.json`.** Rejected: install.js dedupes hook entries by file
  stem (a copy keeps the daily hooks) and writes absolute hook paths into the file (a symlink would
  rewrite the daily one).
- **Per-config-dir state for the daily dir too.** Rejected: readers outside the toolkit bind to the
  daily stamp path.
- **Expanding `~` or trimming the value like install.js.** Rejected: Claude Code reads such values
  against the working directory, so the session and the installer would read different dirs.
