#!/usr/bin/env bash
#
# install.sh — idempotent restorer for the gsd-contrib-toolkit.
#
# Two jobs, both safe to run repeatedly:
#   1. INST-01 / INST-03: (re)create the ~/.claude symlinks for every vendored
#      skill and command, pointing back at the source of truth in THIS repo.
#      Run after any GSD update / `gsd-ver` toggle that deletes them.
#   2. INST-02: merge the `hooks` block from settings.snippet.json into
#      gsd-core's PROJECT-scoped .claude/settings.json — by APPEND/UNION into
#      each hook-event array (never array-replace), deduped, idempotent.
#      NEVER touches ~/.claude/settings.json.
#
# Usage:
#   ./install.sh [GSD_CORE_REPO]
#   GSD_CORE_REPO=/path/to/gsd-core ./install.sh
#
# If no gsd-core repo path is given (or its .claude dir is absent), the settings
# merge is SKIPPED with a warning and the symlink restore still runs — the
# symlink restore is never blocked by a missing/invalid gsd-core path.

set -euo pipefail

# --- Resolve this repo's root from the script's own location (cwd-independent).
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- Vendored assets: "<repo-relative source>|<~/.claude target>".
#     Operate ONLY on these four named targets — never glob-delete a directory.
CLAUDE_DIR="${HOME}/.claude"
ASSETS=(
  "skills/gsd-core-contribution|${CLAUDE_DIR}/skills/gsd-core-contribution"
  "skills/maintainer-review-sweep|${CLAUDE_DIR}/skills/maintainer-review-sweep"
  "commands/gsd-submit.md|${CLAUDE_DIR}/commands/gsd-submit.md"
  "commands/gsd-review-sweep.md|${CLAUDE_DIR}/commands/gsd-review-sweep.md"
)

SNIPPET="${REPO_ROOT}/settings.snippet.json"

log()  { printf '%s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

# --- Preflight: jq is required for the settings merge (and cheap to assert up
#     front so the failure mode is clear rather than a mid-run crash).
command -v jq >/dev/null 2>&1 || die "jq is required but was not found on PATH."

# ---------------------------------------------------------------------------
# 1. SYMLINK RESTORE (INST-01 / INST-03) — runs FIRST and unconditionally.
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
  log "Symlinks: ${linked} (re)created, ${already} already correct (4 total)."
}

# ---------------------------------------------------------------------------
# 2. SETTINGS MERGE (INST-02) — project-scoped, append/union, idempotent.
# ---------------------------------------------------------------------------
merge_settings() {
  local gsd_core="${1:-}"

  if [ -z "${gsd_core}" ]; then
    warn "no gsd-core repo path given (arg or GSD_CORE_REPO) — skipping settings merge (symlinks done)."
    return 0
  fi
  if [ ! -d "${gsd_core}/.claude" ]; then
    warn "'${gsd_core}/.claude' does not exist — skipping settings merge (symlinks done)."
    return 0
  fi

  local settings="${gsd_core}/.claude/settings.json"

  # NEVER write to the user-global settings — project-scoped only (T-03-03).
  case "${settings}" in
    "${HOME}/.claude/settings.json")
      die "refusing to write user-global settings (${settings}); project-scoped only." ;;
  esac

  [ -f "${SNIPPET}" ] || die "settings snippet not found: ${SNIPPET}"
  jq -e . "${SNIPPET}" >/dev/null 2>&1 || die "settings snippet is not valid JSON: ${SNIPPET}"

  local tmp
  tmp="$(mktemp)"
  # shellcheck disable=SC2064
  trap "rm -f '${tmp}'" RETURN

  if [ -f "${settings}" ]; then
    # Refuse to overwrite a file we can't parse (T-03-02).
    jq -e . "${settings}" >/dev/null 2>&1 || die "existing settings is not valid JSON, refusing to overwrite: ${settings}"

    # APPEND/UNION the snippet's hooks into each hook-event array, deduped.
    #   For each event key in snippet.hooks:
    #     .hooks[evt] = ((.hooks[evt] // []) + snippet[evt]) | unique_by(tojson)
    # This PRESERVES pre-existing arrays (never array-replaces — NOT `.[0] * .[1]`,
    # EP-6) and is idempotent (unique_by drops our re-added duplicate). An empty
    # snippet.hooks ({}) iterates zero keys → byte-identical output.
    jq -S --slurpfile snip "${SNIPPET}" '
      ($snip[0].hooks // {}) as $sh
      | reduce ($sh | keys[]) as $evt (
          .;
          .hooks = (.hooks // {})
          | .hooks[$evt] = (((.hooks[$evt] // []) + $sh[$evt]) | unique_by(tojson))
        )
    ' "${settings}" > "${tmp}"

    if cmp -s "${tmp}" "${settings}"; then
      log "Settings: already up to date (no change) at ${settings}."
    else
      mv "${tmp}" "${settings}"
      log "Settings: merged hooks block into ${settings} (append/union, deduped)."
    fi
  else
    # No settings yet — create from the snippet's hooks block.
    jq -S '{hooks: (.hooks // {})}' "${SNIPPET}" > "${tmp}"
    mv "${tmp}" "${settings}"
    log "Settings: created ${settings} from snippet hooks block."
  fi
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
log "gsd-contrib-toolkit installer — repo: ${REPO_ROOT}"
restore_symlinks
merge_settings "${1:-${GSD_CORE_REPO:-}}"
log "Done."
