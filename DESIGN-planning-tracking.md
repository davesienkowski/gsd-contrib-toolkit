# DESIGN: local .planning tracking while developing gsd-core in gsd-core (AS-BUILT)

Status: BUILT and LIVE 2026-08-07. Supersedes the earlier draft (which predated the
branch-per-root + hook decisions). Build home: gsd-contrib-toolkit.

Requirement (Dave): track `.planning` AND keep code history visible while developing
gsd-core in gsd-core; make the push automatic and handled by the installed gsd-core so it
retains atomic commits and `.planning`; handle worktrees; never leak `.planning` upstream.

--------------------------------------------------------------------------------

## 1. What was verified first (grounding)

- `commit_docs:true` is a DEAD END here: `src/commands.cts:820` skips committing `.planning`
  with `skipped_gitignored` whenever it is gitignored (always, `.gitignore:33`). And it would
  target the CODE repo (leak surface). So GSD's own commit mechanism cannot capture `.planning`.
- GSD ships the exact automation seam: `gsd-graphify-update.sh` is a PostToolUse Bash hook that
  fires after every `git commit` (and the SDK shape `gsd-tools query commit`) and runs work
  detached, opt-in via config. This is the "handled by installed gsd-core" surface.
- GSD resolves the effective planning root per worktree (`resolveWorktreeContext` /
  `resolveWorktreeRoot`, used at `gsd-tools.cjs:3416`): local `.planning` wins; else a linked
  worktree remaps to `dirname(git-common-dir)`.
- Measured: 18 of 27 worktrees have their OWN `.planning` (independent roots); 9 remap to main.
  So "handle worktrees" means ~19 independent planning roots.
- Native-feature survey (Dave asked twice): GSD has NO built-in that versions/backs `.planning`
  to a private remote. Closest are `commit-to-subrepo`/`pr-subrepo` (monorepo file-routing by
  `sub_repos` prefix, #311 - not this), `detect/restore-custom-files` (install-preservation of
  user-ADDED files), `milestone` archive (in-tree), `state-snapshot` (ephemeral JSON). None fit.

## 2. As-built architecture

Twin git-dirs over one working tree, one bare planning repo, a branch per planning root.

- Planning repo: `~/.gsd-planning.git` (bare), remote `planning` ->
  `https://github.com/davesienkowski/gsd-core-planning.git` (private). NO origin/fork.
- Branch per root: main checkout -> `main`; each worktree with its own `.planning` ->
  `wt/<worktree-name>` (name = basename of the worktree git-dir, unique per repo); a worktree
  without local `.planning` remaps to `main`. Resolution mirrors GSD's own rule.
- Commits use plumbing (write-tree/commit-tree/update-ref) with a THROWAWAY index (a
  non-existent mktemp -u path; a pre-created 0-byte index is rejected by git). No working-tree
  checkout of the bare repo, so many worktrees commit to their own branches with no shared-index
  race; `update-ref` is atomic.
- Excludes: `graphs/` (regenerable, 26M), `.gsd-trace.jsonl`, `.mempalace-stage/`. Tracked size
  ~5M of markdown.
- Provenance: every planning commit is stamped `[code <sha>]`; `gsd-plan-track at <sha>` looks
  it up across all branches.
- Cadence: LOCAL atomic commit per code commit (any branch); PUSH at session boundary
  (SessionEnd) - least network noise. Manual `gsd-plan-track push` any time.

### Components (all in gsd-contrib-toolkit unless noted)

| File | Role |
|---|---|
| `bin/gsd-plan-track` | engine: init / commit / auto-commit / push / at / branches / check / git |
| `hooks/gsd-planning-track.sh` | PostToolUse (Bash) - snapshot after each commit, ANY branch, matches `gsd-tools query commit` too, opt-in = planning repo exists |
| `hooks/gsd-planning-push.sh` | SessionEnd - push all branches to the private remote |
| `~/.gsd/local-mods/install-planning-track-hooks.sh` | wires both into `~/.claude` (dry-run default, `--apply`/`--revert`, backs up settings.json) |
| `bin/gsd-refresh` (REAPPLY list) | re-applies the hook installer after every `sync` |

### Why it satisfies the requirement (verified against src/)

| Requirement | Delivered | Verified mechanism |
|---|---|---|
| gsd-core USES .planning | files on disk, untouched | commit_docs:false blocks only committing it, never using it |
| gsd-core SEES code history | code .git untouched | drift/verify/base-branch read the code repo directly |
| automatic | PostToolUse-after-commit hook | end-to-end: gate fires on commit, no-op on non-commit |
| handled by installed gsd-core | GSD's own hook surface (mirrors graphify) | fires on `git commit` AND `gsd-tools query commit` |
| atomic | one planning commit per code commit, per branch | scratch: +1 per change, no-op when unchanged |
| worktrees | branch per root (19 seeded) | resolution reuses GSD's rule; 18 wt/ branches on real data |
| no upstream leak | planning repo has no origin/fork | code repo shows 0 tracked/0 status .planning after all ops |

## 3. Adversarial + Artificer review (AS-BUILT, formal - the 4-lens norm)

### 3a. Artificer laws

- choose-boring-technology (PASS). Pure git plumbing + the existing graphify hook pattern; no
  new runtime, no third-party tool. Maximally boring and proven.
- galls-law (PASS). Shipped incrementally - engine, then hooks, then installer - each tested
  before the next. The complex multi-root system evolved from a working single-root one.
- greenspuns-tenth-rule (PASS). No homegrown VCS/DSL; git does the versioning, git plumbing does
  the multi-branch commit. Config gate is "repo exists", not a config language.
- leaky-abstractions (WATCH). Twin git-dirs over one work-tree leaks in two spots: (i) the
  commit hook snapshots the session `$PWD` root - a `cd /elsewhere && git commit` from a
  different cwd would target the wrong root (executor sessions run IN the worktree, so edge
  case); (ii) SessionEnd may not fire on a hard terminal kill - that session's commits stay
  local until the next SessionEnd pushes them. Both fail safe (local history intact).
- hyrums-law (WATCH). Depends on observable-but-uncontracted behavior: GSD's
  resolveWorktreeContext rule, the Claude Code hook JSON schema (`tool_input.command`), the
  `gsd-tools query commit` command shape, and `.planning` staying gitignored. Mitigations: the
  hook mirrors the EXACT shape GSD itself registers; a hyrum guard refuses if `.planning` stops
  being ignored; the commit matcher is broad enough to survive minor phrasing changes.
- postels-law (NOTE). The commit matcher is lenient (`*"query commit"*` etc.) - it can over-fire
  on an unrelated command containing that substring. Consequence is a harmless no-op snapshot,
  so leniency is the right call here.
- kerckhoffs / others: n/a.

### 3b. Adversarial red-team

1. Push cadence SessionEnd: a hard-killed terminal skips that session's push. Commits are safe
   locally; next SessionEnd pushes them. Accepted; manual `push` always available.
2. $PWD assumption in the commit hook (see leaky-abstractions). Edge case for cd-elsewhere
   commits; executor cwd is the worktree.
3. Branch proliferation: deleted worktrees leave `wt/*` branches behind (no auto-prune in v1).
   Known con of "branch per root". Add a prune verb later.
4. Concurrent auto-commit race: throwaway index + atomic update-ref. Two commits racing on the
   SAME branch are last-writer-wins on the ref; each snapshot is a full tree, so no corruption -
   worst case one snapshot is superseded. Safe.
5. Secrets/PII in .planning are pushed to the private remote. Acceptable (private), noted; never
   point the remote at a public repo.
6. Over-broad matcher (postels): harmless no-op over-fire.
7. Reused worktree name: if a worktree is deleted and a new one reuses the name, its `wt/<name>`
   branch continues the old history. Harmless semantic oddity.
8. gsd-refresh re-apply: if the toolkit `hooks/` source is missing, `--apply` fails and
   gsd-refresh halts loud (fail-safe), rather than silently dropping the hooks.

### 3c. Net

Direction confirmed; the review added guardrails already in the build (hyrum guard, fail-safe
detachment, backup-on-wire) and a small later-work list (branch prune, optional Stop-debounced
push, $PWD-from-command parsing).

## 4. Operational reference

- Status:            `gsd-plan-track check` / `gsd-plan-track branches`
- Manual snapshot:   `gsd-plan-track commit "msg"`  (current dir's root)
- Manual push:       `gsd-plan-track push`
- Find by code sha:  `gsd-plan-track at <sha>`
- Raw git:           `gsd-plan-track git <args>`   (add `gplan(){ gsd-plan-track git "$@"; }` to rc)
- Turn auto-tracking OFF: `bash ~/.gsd/local-mods/install-planning-track-hooks.sh --revert` then restart
- Fully remove: `--revert` + `rm -rf ~/.gsd-planning.git` (the remote is yours to delete)
- Survives `gsd-refresh sync`: yes (installer is in the REAPPLY list; re-applied with --apply)

## 5. Later work (not v1)

- Prune `wt/*` branches when a worktree is deleted.
- Optional Stop-debounced push for fresher remote in very long sessions.
- Parse a leading `cd <dir>` from the commit command to fix the $PWD edge case.
- Possible upstream contribution: a gsd-core capability that owns this (maintainer-owned).
