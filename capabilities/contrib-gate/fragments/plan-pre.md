# Contrib-Gate Contribution Discipline

> Advisory only. This fragment ADVISES the planner — it does not block. It is injected at
> `plan:pre` (`onError: skip`) and only when `workflow.gsd_contrib_enforcement` is opted in.

When this project plans work that files an issue, opens/updates a PR, or pushes toward an
`open-gsd/gsd-core` contribution, the planner should:

- **Reuse the LIVE gsd-core scripts** for filing, dedupe, freshness, policy, and review checks —
  never reimplement the policy gsd-core already owns (HARD-02). A missing LIVE script must fail
  LOUD, not silently fall back to a vendored copy.
- **Respect the enforcement split, honestly.** This capability's `gates[]` is empty: it is
  advisory-only. A capability gate (when one exists) blocks only at the closed GSD-loop extension
  points reached *inside* a GSD command. It does NOT reach the harness tool-call boundary.
- **Know where the real enforcement lives.** The separate, personal Claude Code PreToolUse hooks
  fire at the harness boundary on every Bash/Edit/Write tool call — they enforce the no-broken-
  issue/PR/push and no-generated-file-edit outcomes. Those hooks, not this capability, are the
  harness-wide layer; this fragment cannot reproduce that reach.
- **Keep bypasses accountable.** Any deliberate override is recorded by the existing per-worktree,
  append-only `GSD_CONTRIB_OVERRIDE` receipt (`hooks/lib/override.cjs`) — a logged reason string,
  never a silent default. This capability adds no new receipt mechanism.
