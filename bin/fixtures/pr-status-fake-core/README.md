# pr-status-fake-core

A hermetic stand-in for a gsd-core checkout (quick 261028-owj), used only by
`bin/pr-status-prohibitions.test.cjs` prohibition Q1 so the pr-status CLI, run as a subprocess through the
refusing stub gh, reaches its policy reads (Tests runs, MAINTAINERS, collaborator permission) without the
real gsd-core checkout. It has the sentinel layout `hooks/lib/resolve.cjs` checks (`scripts/`,
`gsd-core/bin/lib/`, `scripts/pr-target-policy.cjs`). The three policy modules are minimal test doubles,
not copies of the upstream rules: the verdict tests use the LIVE modules or `deps.policies`.
