#!/usr/bin/env bash
# gsd-planning-push.sh — SessionEnd hook. Pushes ALL planning branches to the private
# remote at the session boundary (the chosen "push on boundary" cadence: least network
# noise, one push per session rather than per commit).
#
# OPT-IN: no-op unless the planning repo exists AND has a 'planning' remote.
# Non-fatal and quiet: a missing remote / no network never surfaces an error.
# Returns 0 in all cases.
set -uo pipefail

GITDIR="${GSD_PLAN_GITDIR:-$HOME/.gsd-planning.git}"
[ -d "$GITDIR" ] || exit 0
git --git-dir="$GITDIR" remote get-url planning >/dev/null 2>&1 || exit 0

# Detach so session teardown is never blocked by a slow/failed network push.
( git --git-dir="$GITDIR" push planning --all >/dev/null 2>&1 || true ) </dev/null >/dev/null 2>&1 &
disown 2>/dev/null || true
exit 0
