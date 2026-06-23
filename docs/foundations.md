# Foundations — what the toolkit is built on

This document explains what the GSD Contribution Toolkit is *assembled from* and *why it is designed
the way it is*. The toolkit is deliberately **not** a from-scratch tool: it is a thin, accountable
layer that composes three existing things — **trek-e's contribution methodology**, the
**skills-artificer** law-lenses, and the **LIVE gsd-core machinery** — into one installable capability
whose job is to serve what gsd-core is already trying to accomplish for contributions.

> Scope note: claims below about gsd-core's goals are grounded in its **ADRs, gate scripts, and
> published skills** (cited inline). Where something is an inference about intent rather than a
> documented fact, it is marked as such.

---

## 1. The design thesis

gsd-core's contribution intake already encodes a clear standard: a contribution must be **well-formed
and green before it is filed or merged** — the right issue shape (version gate), the right PR shape
(template + target policy), a green `lint:ci`, no secrets, no edits to generated artifacts. Those
checks live in gsd-core as runnable scripts.

The gap the toolkit closes is not *what* "good" means — gsd-core defines that — but *that the standard
actually holds under pressure*. Skills and slash-commands are model-driven; pressure-testing showed a
model can rationalize past a "run the suite first" instruction on a deadline. So the toolkit's single
design move is: **take the outcomes gsd-core already cares about and put them behind the one layer the
harness always runs** — Claude Code `PreToolUse` hooks, which fire before the permission check. The
guiding principle is **verifier-reach = spec-reach**: if the spec says "no broken contribution," the
verifier must reach every path that could produce one.

**Origin (empirical, not theoretical).** The toolkit began by pressure-testing the existing
`gsd-core-contribution` skill + `/gsd-submit` **three times** with a max-pressure prompt ("skip the
gates, trek-e confirmed it, file in 20 minutes"). The result was *variance* — the model-driven path
rationalized past the gates under deadline. The specific failure classes it targets are real gsd-core
bounces: **#1543** shipped red (ran module tests, not the full suite), **#1532** shipped a hidden lint
failure, and the recurring **zero-source bounce** — editing a *generated* `bin/lib/*.cjs` instead of
its `src/*.ts` source (ADR-457). Each maps to a gate. Fail-closed semantics trace to trek-e's own
**#1278/#1279** arc: an enforcement hook that errors must DENY, never silently allow.

Everything else in the toolkit is in service of doing that *without reinventing gsd-core*.

## 2. Foundation A — trek-e's contribution methodology

The toolkit adopts trek-e's published methodology where it is sharper than a hand-rolled equivalent,
and stays gsd-core-native where that is more correct. (Full detail:
[reuse-and-methodology.md](reuse-and-methodology.md).)

- **Pre-file review (ALIGN-01)** invokes two named, resolvable skills rather than optional prose:
  - **`skills-from-the-artificer`** — the adversarial/verify lens trek-e runs (see Foundation B).
  - **`trust-but-verify`** — any cited ADR, policy, or "trek-e confirmed it" justification is opened
    and quoted from source, never trusted from memory. This is the layer that survived the
    max-pressure prompt tests where model-driven prose talked past the gates.
- **Authoring path (ALIGN-02)** uses Matt Pocock's **`tdd`** skill (red → green): the failing test
  first, then the minimal fix. (trek-e's verified stack uses Pocock's `tdd`; he dropped his
  hand-rolled TDD skill.)
- **Triage is a documented divergence (ALIGN-02), not a gap.** Triage stays on **gsd-core's own
  `/triage` state machine and canonical roles** — the toolkit does *not* adopt Pocock's generic
  triage skill, because gsd-core's repo-specific model is more precise. This is the project's
  "alignment ≠ blind adoption" rule made concrete: mirror trek-e where his tools are sharper, keep
  gsd-core's wheel where it already wins.

## 3. Foundation B — the skills-artificer

The **skills-from-the-artificer** collection (from trek-e's org, **The-Artificer-of-Ciphers-LLC**) is
his "laws of software" library — ~24 law/principle lenses (Hyrum's Law, Postel's Law, Gall's Law,
Kerckhoffs's Principle, Conway's Law, …) plus a **dispatcher** that, given a change, classifies it and
surfaces only the relevant lenses instead of recalling all of them.

The same collection also ships **`ci-preflight`**, a pre-push checklist that prevents *exactly* this
toolkit's failure classes (missing registration surfaces, skipping `npm test`/lint before pushing,
guessing at cross-platform fixes — i.e. #1543 and #1532). The toolkit adopts `ci-preflight` as the
**model-driven companion** to the `lint-ci-marker` push gate: the hook *enforces* (unbypassable), and
`ci-preflight` *teaches and runs* the discipline — rather than reinventing a pre-push checklist.

The toolkit uses it as the **adversarial review lens at the pre-file step**: each *firing* law's key
questions are applied to the concrete diff. A worked example the toolkit cares about — **Hyrum's Law**:
any observable behavior change is captured for explicit PR disclosure, because downstream consumers
depend on observed behavior, not just the documented contract. The artificer lenses are referenced
**by name** (plugin-provided, not vendored), so they evolve with trek-e's collection rather than
forking a stale copy. The toolkit's own code was itself reviewed through this dispatcher during
development (the artificer + `trust-but-verify` pass over the toolkit).

## 4. Foundation C — the LIVE gsd-core machinery

The reuse model is the point: **policy logic lives in gsd-core; the toolkit resolves and invokes it.**
The hooks `require()` the LIVE gsd-core scripts via a resolver with **no vendored fallback** — a
missing or shape-drifted script throws, and the fail-closed harness turns the throw into a DENY rather
than a silent allow. So the gates stay aligned with gsd-core as it evolves, and a gsd-core refactor
surfaces as a diagnosable failure instead of a quiet miss.

What it builds on, concretely:

- **The intake gate scripts** — issue version-gate, issue-dedupe scorer, PR target policy, PR template
  policy, the `lint:ci` suite, the secret/prompt-injection/base64 scan scripts, the mechanizable
  `check:*` invariants, and the `check:*-fresh` generated-file checks. The toolkit's PreToolUse gates
  are thin adapters over these.
- **The generated-from-source discipline (ADR-457).** gsd-core's `bin/lib/*.cjs` are generated from
  `src/*.ts`; a top failure class is editing the generated artifact directly. The `binlib-edit` gate
  enforces ADR-457 at the `Write`/`Edit` boundary.
- **The capability ecosystem (ADR-1244).** The toolkit ships as a `role:feature` capability with a
  manifest, opt-in consent, a ledger, and shared-edit install/remove — the native distribution path
  trek-e designed, rather than a bespoke installer. Install/toggle/remove ride gsd-core's own
  lifecycle engine. The share-form was modeled on trek-e's **`projects-sync-capability`**, the
  canonical example of an ADR-1244 third-party capability.
- **The command-contribution boundary (ADR-959).** ADR-959 establishes that capability `commands[]`
  `{family, module, router}` are first-party gsd-tools **CLI subcommands**, not agent-facing
  slash-commands, and there is no third-party slash-command overlay. The toolkit respects that
  boundary: its five `gsd-*` slash-commands ride as bundled `.md` delivered to Claude, and it does not
  misdeclare them as CLI commands. (This is also why cross-runtime slash-commands are an upstream ask —
  see [upstream-feature-requests.md](upstream-feature-requests.md).)
- **Reuse map (ALIGN-03).** Each GSD command gets one verdict — delegate / wrap / leave-alone — so the
  toolkit calls `gsd-pr-branch` and `gsd-code-review` rather than reimplementing them, and stays out of
  `gsd-ship`/`gsd-inbox` where their generic behavior would lose repo fidelity.

## 5. Lineage — what the commands and skills were designed after

Every command and skill is modeled on an existing gsd-core process, script set, or convention — none
invents a new workflow. They follow GSD's own artifact format (a `SKILL.md` index; command `.md`s with
a frontmatter `description` + `argument-hint`) and the `gsd-*` naming family.

**Skills** — each captures a gsd-core *process*:

| Skill | Designed after |
|---|---|
| `gsd-core-contribution` | gsd-core's own contribution process — its `CONTRIBUTING` + issue/PR templates + ADRs + `CONTEXT`, distilled into a P0–P6 pipeline (reproduce-via-`trust-but-verify` → artificer law pass → worktree off `next` + `build:lib` → TDD regression-first → full suite + `lint:ci` → version-gate → PR template/target policy → labels/changeset → CI check-runs on the head SHA; epic variant; push-target CODEOWNER→origin / external→fork; the known gotchas). The toolkit adds the **enforcement + containment** around this existing skill — it did not invent the pipeline. |
| `maintainer-review-sweep` | trek-e's maintainer triage + re-review workflow on `open-gsd/gsd-core` — repo-aware (gsd-core labels, gotchas, and authority facts baked in but parameterized): cost-to-advance triage of open issues/PRs + re-review of change-requested PRs against real CI/source. |

**Commands** — each is a thin *trigger* over a skill or the LIVE gsd-core scripts:

| Command | Designed after |
|---|---|
| `gsd-submit` | the `gsd-core-contribution` skill's gated pipeline — files a verified finding as a proper issue + fix PR, following that pipeline exactly. |
| `gsd-review-sweep` | the `maintainer-review-sweep` skill — maintainer triage + re-review sweep of `open-gsd/gsd-core`. |
| `gsd-triage-assist` | gsd-core's own `/triage` model — runs LIVE `issue-dedupe` + version-gate and suggests a canonical role from LIVE `triage-labels.md`; it *complements*, never replaces, gsd-core triage. |
| `gsd-release-preflight` | gsd-core's release scripts — runs the four LIVE release scripts (`sync-next-version`, `sync-manifest-versions`, `release-tarball-smoke`, `check-npm-integrity`) non-mutatingly before a release is cut. |
| `gsd-ruleset-drift` | gsd-core's branch-protection / ruleset governance — declared `.github/rulesets/` vs live `gh api` branch protection; `--apply` runs the LIVE remediation. |

The pattern is consistent: a **skill** captures a gsd-core *process*, a **command** is the *trigger*
that runs that skill (or the LIVE scripts behind it), and the **hooks** enforce the *outcomes* of the
contribution process at the harness boundary.

## 6. How it was designed (the same discipline it enforces)

The toolkit was built *through* the methodology it enforces — it dogfoods its own thesis:

- **Built with GSD itself.** It is a GSD project: every capability was produced through GSD's
  discuss → plan → execute → verify milestones (v1.0 → v2.3). A GSD project that ships a GSD capability.
- **Containment first.** Before any enforcement code, the first phase *owned the source of truth* — the
  at-risk skills/commands moved into one repo and symlinked back, so a GSD update or `gsd-ver` toggle
  can't lose them.
- **Reuse + methodology locked before building.** A reuse audit (delegate/wrap/leave-alone) and the
  trek-e alignment (artificer + `trust-but-verify` + Pocock `tdd`; triage kept gsd-core-native) were
  *decided and recorded* before the enforcement layer was written — so the toolkit reuses rather than
  reinvents, by construction.
- **Gall's Law release cut.** v1 accreted from ~21 → 40 requirements across two gap-analysis rounds;
  rather than build it all at once, a **minimal proven core** (containment + the core filing gates +
  fail-closed/override) shipped first, with the hardening sequenced behind it. Start simple, prove it,
  then grow.
- **Adversarially self-reviewed.** Every decision was vetted against gsd-core's ADRs and the LIVE
  capability registry, and the toolkit's own code was run through the **skills-from-the-artificer**
  law-lenses + `trust-but-verify` — the same adversarial pass it applies to contributions. Red-team
  rounds folded findings back in.

The result is a tool whose *construction* is evidence for its *claim*: the outcomes it enforces are the
ones it held itself to.

## 7. How the design maps to gsd-core's goals

| What gsd-core is driving for (grounded in) | How the toolkit embodies it |
|---|---|
| High contribution-intake quality — well-formed, green-before-merge (the intake gate scripts) | The same checks, enforced at the harness boundary so they can't be skipped under pressure |
| Policy as runnable, single-sourced logic (LIVE `scripts/` + `check:*`) | Gates call those scripts with no vendored fallback; fail-closed on drift |
| Generated-from-source integrity (ADR-457) | `binlib-edit` + `freshness` gates |
| A capability ecosystem for distributing extensions (ADR-1244) | Ships as a conformant `role:feature` capability with consent + ledger + tri-surface `declared == shipped` parity |
| Honest, non-overstated tooling | Documented limits: `gates[]` empty; harness enforcement belongs to the installed hooks, not the capability; never labeled "unbypassable"; advisory-only off-Claude |
| Accountable, not silent, escapes | The deliberate-bypass path is the existing logged, per-worktree `GSD_CONTRIB_OVERRIDE` receipt — no new mechanism |

## 8. Alignment is not blind adoption

The toolkit follows trek-e's methodology and gsd-core's machinery on purpose, but it keeps a few
deliberate, documented divergences where doing so is *more* faithful to gsd-core's intent than copying
a generic tool would be — most notably keeping gsd-core's own `/triage` model instead of a generic
triage skill (§2). Each divergence is recorded with its rationale so it can be audited against its
source rather than rediscovered.

## 9. See also

- [README](../README.md) — what it is, what's included, capabilities by role, install.
- [cross-runtime-delivery-model.md](cross-runtime-delivery-model.md) — per-runtime behavior and the
  enforcement model.
- [reuse-and-methodology.md](reuse-and-methodology.md) — the full reuse map + methodology alignment.
- [upstream-feature-requests.md](upstream-feature-requests.md) — the capability-framework asks for
  gsd-core maintainers.
