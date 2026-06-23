#!/usr/bin/env bash
#
# install.sh — idempotent restorer for the gsd-contrib-toolkit.
#
# One job, safe to run repeatedly:
#   INST-01 / INST-03: (re)create the ~/.claude symlinks for every vendored
#   skill and command, pointing back at the source of truth in THIS repo.
#   Run after any GSD update / `gsd-ver` toggle that deletes them.
#
# It NEVER touches ~/.claude/settings.json or any project settings.json. The
# enforcement install/toggle is now a separate, ledger-clean capability CLI:
#   node bin/contrib-capability.cjs install | on | off | status | remove
#
# Usage:
#   ./install.sh

set -euo pipefail

# --- Resolve this repo's root from the script's own location (cwd-independent).
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- Vendored assets: "<repo-relative source>|<~/.claude target>".
#     Operate ONLY on these seven named targets — never glob-delete a directory.
#     INVARIANT: this ASSETS list must stay in sync with commands/*.md and the
#     two skills/ dirs — one entry per shipped command and skill (5 commands +
#     2 skills). Add a new command/skill here when one is added to the repo.
CLAUDE_DIR="${HOME}/.claude"
ASSETS=(
  "skills/gsd-core-contribution|${CLAUDE_DIR}/skills/gsd-core-contribution"
  "skills/maintainer-review-sweep|${CLAUDE_DIR}/skills/maintainer-review-sweep"
  "commands/gsd-submit.md|${CLAUDE_DIR}/commands/gsd-submit.md"
  "commands/gsd-review-sweep.md|${CLAUDE_DIR}/commands/gsd-review-sweep.md"
  "commands/gsd-triage-assist.md|${CLAUDE_DIR}/commands/gsd-triage-assist.md"
  "commands/gsd-release-preflight.md|${CLAUDE_DIR}/commands/gsd-release-preflight.md"
  "commands/gsd-ruleset-drift.md|${CLAUDE_DIR}/commands/gsd-ruleset-drift.md"
)

log()  { printf '%s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# SYMLINK RESTORE (INST-01 / INST-03) — the only thing install.sh does.
# ---------------------------------------------------------------------------
restore_symlinks() {
  local linked=0 already=0
  local entry src tgt abs_src
  for entry in "${ASSETS[@]}"; do
    src="${entry%%|*}"
    tgt="${entry##*|}"
    abs_src="${REPO_ROOT}/${src}"

    # The source of truth must exist in the repo — refuse to link a dangling target.
    [ -e "${abs_src}" ] || die "missing repo source: ${abs_src} (cannot restore symlink ${tgt})"

    # Ensure the parent dir (~/.claude/skills or ~/.claude/commands) exists.
    mkdir -p "$(dirname "${tgt}")"

    if [ -L "${tgt}" ]; then
      # Already a symlink. Leave it iff it resolves to the correct repo source.
      if [ "$(readlink "${tgt}")" = "${abs_src}" ]; then
        already=$((already + 1))
        continue
      fi
      # Symlink points elsewhere — re-point it (safe: replacing a symlink, not real data).
      ln -sfn "${abs_src}" "${tgt}"
      linked=$((linked + 1))
      continue
    fi

    if [ -e "${tgt}" ]; then
      # Exists and is NOT a symlink: a REAL file/dir. Fail-safe — never clobber (T-03-01).
      die "refusing to overwrite real file at ${tgt} (not a symlink into this repo). Move it aside and re-run."
    fi

    # Missing — create the symlink with an absolute target.
    ln -sfn "${abs_src}" "${tgt}"
    linked=$((linked + 1))
  done
  log "Symlinks: ${linked} (re)created, ${already} already correct (${#ASSETS[@]} total)."
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
log "gsd-contrib-toolkit installer — repo: ${REPO_ROOT}"
restore_symlinks
log "Done."
