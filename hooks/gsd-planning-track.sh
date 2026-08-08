#!/usr/bin/env bash
# gsd-planning-track.sh — PostToolUse hook (Bash matcher) that snapshots .planning/
# into the separate private planning repo after every HEAD-advancing commit, on ANY
# branch (main OR a worktree feature branch). LOCAL commit only; the push happens at a
# boundary (see gsd-planning-push.sh) per the chosen "push on boundary" cadence.
#
# OPT-IN: no-op unless the planning repo exists (~/.gsd-planning.git, created by
#   `gsd-plan-track init`). No config key needed — init is the enable switch.
#
# Mirrors gsd-graphify-update.sh's PostToolUse contract, with two deliberate differences:
#   * it does NOT restrict to the default branch (worktree phase-execution commits live on
#     feature branches and MUST be captured), and
#   * it matches the SDK commit shape `gsd-tools query commit` too (the executor commits
#     that way, so the literal "git commit" substring never appears — see graphify #3653).
#
# Returns 0 in all cases. Never blocks the user-facing tool call.
set -uo pipefail

INPUT=$(cat 2>/dev/null || true)
[ -n "$INPUT" ] || exit 0

# Opt-in gate first (cheapest): planning repo must exist.
GITDIR="${GSD_PLAN_GITDIR:-$HOME/.gsd-planning.git}"
[ -d "$GITDIR" ] || exit 0

TOOL_INFO=$(printf '%s' "$INPUT" | node -e '
let d=""; process.stdin.on("data",c=>d+=c);
process.stdin.on("end",()=>{try{const p=JSON.parse(d);
  process.stdout.write((p.tool_name||"")+"\n"+(p.tool_input?.command||""));}catch{process.stdout.write("\n");}});
' 2>/dev/null || printf '\n')
TOOL_NAME=$(printf '%s\n' "$TOOL_INFO" | sed -n '1p')
COMMAND=$(printf '%s\n' "$TOOL_INFO" | sed -n '2,$p')

# Kimi Shell normalization (parity with graphify hook / #2304)
TOOL_NAME="${TOOL_NAME##*:}"; [ "$TOOL_NAME" = "Shell" ] && TOOL_NAME="Bash"
[ "$TOOL_NAME" = "Bash" ] || exit 0

# HEAD-advancing git op: shell-direct OR the SDK/shim commit shapes.
case "$COMMAND" in
  *"git commit"*|*"git merge"*|*"git pull"*|*"git rebase --continue"*|*"git cherry-pick"*) ;;
  *"gsd-tools query commit"*|*"gsd_run query commit"*|*"query commit"*) ;;
  *) exit 0 ;;
esac

[ -z "${CI:-}" ] || exit 0
git rev-parse --git-dir >/dev/null 2>&1 || exit 0

# Resolve the tool (PATH may be minimal in a hook).
TRACK=""
for c in "$(command -v gsd-plan-track 2>/dev/null)" \
         "$HOME/.local/bin/gsd-plan-track" \
         "$HOME/repos/gsd-contrib-toolkit/bin/gsd-plan-track"; do
  [ -n "$c" ] && [ -x "$c" ] && { TRACK="$c"; break; }
done
[ -n "$TRACK" ] || exit 0

# Detached, quiet, local-only snapshot of THIS directory's planning root.
bash "$TRACK" auto-commit "$PWD" </dev/null >/dev/null 2>&1 &
disown 2>/dev/null || true
exit 0
