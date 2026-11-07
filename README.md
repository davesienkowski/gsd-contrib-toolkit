# GSD-Contrib Toolkit

Guard rails for contributing to [`open-gsd/gsd-core`](https://github.com/open-gsd/gsd-core) with
Claude Code. It stops a broken issue or pull request from being filed, and stops code that is not
green from being pushed.

It does this with **hooks**: small checks that Claude Code itself runs just before a command such as
`git push` or `gh pr create`. If a check says no, the command does not run. The toolkit also ships
five slash commands and two skills (written instructions Claude follows) that walk you through a
contribution and help maintainers triage and review.

**Who it is for:** people who contribute to or maintain gsd-core using Claude Code.

> **Read this first.** This is one contributor's working toolkit, built around gsd-core's specific
> intake rules and one maintainer's review habits. It is published (MIT) for reference and reuse, not
> as a supported product: there is no release schedule and no support promise. The most reusable part
> is the pattern (hooks that check outcomes, reusing gsd-core's own scripts instead of copying its
> rules); the specific checks are tuned to one repository.
>
> Be skeptical of any claim here that sounds too strong. The aim is to say exactly what is enforced
> and what is only advice, and an overselling claim is a real defect: please report one.

## What it blocks

These are enforced by the hooks, not left to the model's good intentions:

- Pushing, or opening a PR, when `lint:ci` (gsd-core's lint-and-checks command) has not passed on the exact files you are pushing, or when
  gsd-core's secret, prompt-injection or base64 scans find something.
- Filing an issue or PR that breaks gsd-core's intake rules (what an issue or PR must contain): missing GSD version, wrong target branch,
  a body that fails the template, no linked issue, or a duplicate of an open issue.
- Committing stale generated files, or editing a generated `bin/lib/*.cjs` (built from source files; edit the source) instead of its source.
- Skipping the checks (`--no-verify`, swapping `core.hooksPath`) or sending private files upstream.
- Approving or merging a PR without the review evidence the maintainer process asks for.

Two limits: the `lint:ci` and protocol-artifact checks do not arm for pushes that go only to a
fork or backup remote (see [the table](docs/enforcement-reference.md)), and the review-evidence check
looks at the shape of the review artifact, not whether the review itself is honest.

18 of the 20 hook scripts block; the other two only remind or record. The full table, with what each
one calls, is in [docs/enforcement-reference.md](docs/enforcement-reference.md).

## What it does not do

- **It is not a security control.** The hooks stop the AI model from talking its way past a check,
  even with `--dangerously-skip-permissions`. They do not stop you: anyone with access to the files
  can turn the toolkit off, and that is by design (see [Turning it off](#turning-it-off)).
- **It checks outcomes, not how you work.** It can stop a broken PR; it cannot make you plan first.
  Habits such as writing a todo list first are guidance, not enforcement.
- **The installable capability's own gate list is empty.** It carries skills and commands only. The
  blocking comes from the hooks, which the install route wires into gsd-core's project settings. On
  runtimes (the AI coding tools GSD supports) other than Claude Code there are no hooks, so the skills
  run as advice only.

More detail: [docs/enforcement-reference.md](docs/enforcement-reference.md#what-it-does-not-do).

## Requirements

- Node.js 22 or newer (CI runs 22 and 24).
- Claude Code (the hooks need it).
- A local checkout of `open-gsd/gsd-core`. The installer looks in `$GSD_CORE_ROOT`, then
  `~/repos/gsd-core`, then `~/gsd-core`.
- `gh`, signed in. The issue and PR checks call it, and they deny when it is not authenticated.

## Install

**From a clone of this repository** (the commands and skills are linked into `~/.claude`, so edits here
take effect):

```bash
node bin/contrib-capability.cjs install   # wire the hooks, commands and skills; safe to re-run
node bin/contrib-capability.cjs status    # show what is installed
```

Re-run `install` after a GSD update or any runtime change that disturbs `~/.claude`.

**From the published package** (copies instead of links), through gsd-core's capability installer (its add-on command):

```bash
node <gsd-core>/bin/gsd-tools.cjs capability install \
  https://github.com/davesienkowski/gsd-contribution-toolkit.git#v2.1.3 \
  --scope project --yes --shared-file .claude/settings.json
```

`--shared-file` names the project settings file that receives the hooks. `--scope project` keeps the hooks inside the gsd-core checkout, never in your global
`~/.claude/settings.json`. An npm route that verifies a checksum before installing is described in
[docs/install-and-layout.md](docs/install-and-layout.md).

### Turning it off

```bash
node bin/contrib-capability.cjs off --reason "why"      # remove the hooks (and the commands and skills)
node bin/contrib-capability.cjs on                      # put them back
node bin/contrib-capability.cjs remove --reason "why"   # full teardown
```

Turning it off really removes the checks. It needs a non-empty reason and writes a log entry, so it is
a deliberate, recorded act rather than a quiet workaround. For a check that crashes rather than says
no, a `GSD_CONTRIB_OVERRIDE` reason string lets the command through and is logged; it does not lift a
real deny (one narrow, logged exception is named in the reference). Both are explained in [docs/enforcement-reference.md](docs/enforcement-reference.md#how-it-works).

## Using it

| Command | What it does |
| --- | --- |
| `/gsd-submit <finding>` | File a verified finding as an issue plus fix PR, through the gates |
| `/gsd-review-sweep` | Maintainer triage and re-review of open issues and PRs |
| `/gsd-triage-assist #N` | First-pass triage suggestion for one incoming issue |
| `/gsd-release-preflight` | Run gsd-core's pre-release checks (preflight) without changing anything |
| `/gsd-ruleset-drift` | Compare declared branch rules with the live ones, i.e. ruleset drift (read-only by default) |

New here? Read the [Overview](docs/guides/overview.md), then the
[Contributor Guide](docs/guides/contributor-guide.md) (file a change) or the
[Maintainer Guide](docs/guides/maintainer-guide.md) (triage and review).

## Where to go next

- [Guides](docs/guides/): overview, contributor and maintainer walkthroughs.
- [Enforcement reference](docs/enforcement-reference.md): the gate table, how the checks work, the
  limits in full.
- [Install and layout](docs/install-and-layout.md): directory layout, both install routes, settings scope.
- [Requirements and stability](docs/requirements-and-stability.md): what you can build on and what may change.
- [Commands](docs/commands-reference.md) and [skills](docs/skills-reference.md) reference.
- [Decision records](docs/adr/) and [design foundations](docs/foundations.md).

## Contributing

Issues and PRs are welcome, especially corrections. If this README or anything in [docs/](docs/)
claims something the code does not do, that is the most useful thing you can report. Several doc
claims are checked by tests (see [requirements-and-stability](docs/requirements-and-stability.md#docs-that-tests-check)),
so run `node --test` before opening a PR.

## License

[MIT](LICENSE), the same license as `open-gsd/gsd-core`. This project is not affiliated with or
endorsed by the `open-gsd/gsd-core` maintainers; it is an independent contributor-side toolkit built
against that repository's public conventions.
