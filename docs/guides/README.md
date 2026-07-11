# GSD-Contrib Toolkit — Guides

Task-oriented walkthroughs. Start here if you want to *use* the toolkit; for the architecture reference
see the top-level [README](../../README.md).

| Guide | For | What it covers |
|---|---|---|
| **[Overview](overview.md)** | everyone | What the toolkit does, what's in it (skills, commands, hooks, tools, capability), and the model that ties it together (stamp→marker→gate→scan; gate→LIVE-script reuse; the override valve). |
| **[Contributor Guide](contributor-guide.md)** | contributors / CODEOWNERs filing changes | Install, then file a verified finding as a clean issue + fix PR through the P0–P6 gates; the gate map + how to get to green; the recovery offramp; conventions that get a clean review. |
| **[Maintainer Guide](maintainer-guide.md)** | maintainers / triagers | The daily `/gsd-review-sweep`, triaging an incoming issue with `/gsd-triage-assist` (by-design gate → Agent Brief → approval conditions → capability routing), the heavy re-review procedure, and the release/ruleset assists. |

## Reference docs (the "what each thing is" pages)

- [commands-reference](../commands-reference.md) — the 5 `gsd-*` commands, arguments, safety model.
- [skills-reference](../skills-reference.md) — the 2 skills the commands drive.
- [REUSE-AND-METHODOLOGY](../REUSE-AND-METHODOLOGY.md) — the reuse map governing what each path delegates to.
- [cross-runtime-delivery-model](../cross-runtime-delivery-model.md) — how the toolkit behaves on non-Claude runtimes.
- [foundations](../foundations.md) — the design foundations.
