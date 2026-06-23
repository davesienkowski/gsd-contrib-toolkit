# Integrity + Provenance Proof — contribution-toolkit (ADR-1244 trust model)

**Quick task:** 260623-nv5
**Recipe:** [`bin/prove-integrity-provenance.cjs`](../bin/prove-integrity-provenance.cjs) (re-runnable, sandboxed, Node built-ins only)
**Engine under test:** gsd-core @ branch `next`, HEAD `adef8b29` — compiled lib rebuilt (`npm run build:lib`, exit 0) before the run.

## What this closes

The native install of our `contribution-toolkit` capability was previously proven only via
`local` + `git` sources, both of which record `integrity: ""` (NULL) — the `--integrity`-gated
path had **never** run. This task exercises that path end to end against our own bundle:
a sandboxed install that (a) SUCCEEDS on a digest match and (b) FAILS CLOSED on a wrong digest,
plus an additive `provenance: { sourceRepo, commit }` block that gsd-core accepts.

## Source kind used, and why

**`npm:` over a local directory** (`npm:<abs-staged-dir>`).

A bare local path routes (via `parseSpec`, `src/capability-source.cts:798`) to kind `local`,
and `resolveLocal` (`:858`) **throws** `integrity pinning is not supported for local sources` —
a local path is a directory tree, not a single byte stream, so there is no stable artifact to
pin a sha512 SRI against. The two kinds that DO honor `--integrity` are `tarball` (an `https://…`
`.tgz` URL) and `npm` (`npm pack --ignore-scripts` over a target). The `npm:` route needs **no
network server** and is fully sandbox-safe: `npm pack --ignore-scripts` (`:948-949`) runs no
capability lifecycle scripts, and `--integrity` is verified over the produced `.tgz` BYTES at
`:970-971` **before** `assertSafeTarMembers` / extraction / staging.

The recipe stages a temp copy of `capabilities/contribution-toolkit/` under the scratch dir (the
real working copy is never touched) and adds a minimal `package.json` (`name` from the capability
`id`, `version` from the manifest) only if absent, so `npm pack` has a manifest to pack.

## How the digest was derived (NOT a blind sha512sum)

`npm pack` output bytes are not trivially reproducible by hand, so guessing the digest with
`sha512sum` would make the positive test pass for the wrong reason. Instead the recipe:

1. Runs install **#1 without `--integrity`** in a fresh sandbox GSD_HOME.
2. Reads the engine-recorded `integrity` back from that sandbox's ledger
   (`<GSD_HOME>/.gsd-capabilities.json`, `entries["contribution-toolkit"].integrity`). This is
   `computeIntegrity(tgzBytes) = "sha512-" + sha512(tgzBytes).base64` (`:293-295, :969, :997`) —
   the engine's own value over the produced tarball bytes.
3. Feeds **that** value to install **#2** with `--integrity`.

Engine-derived ⇒ same byte domain ⇒ the positive match is honest (mitigates T-nv5-02).

## Outcomes (exact, from the run)

| Phase | Result |
|-------|--------|
| **DIGEST** | engine-derived `sha512-70I7xBU7NIWT75NeS…` (read back from ledger) |
| **POSITIVE** | `installed` (exit 0) — `id=contribution-toolkit version=2.1.3 scope=global` |
| **NEGATIVE** | **refused** (exit 1) — see error below |
| **FAIL-CLOSED** | clean — no promoted `contribution-toolkit` dir, no ledger entry in the negative sandbox |
| **SANDBOX** | all installs ran with `GSD_HOME` under `/tmp`; real `~/.gsd` & `~/.claude` untouched |

### Negative-test exact error + exit code

The negative test mutates one base64 char of the derived digest (deterministic) and re-installs
in a fresh sandbox. Process **exit code 1**, with this error on stderr (from `verifyIntegrity`,
`src/capability-source.cts:307-309`):

```
Integrity mismatch: expected sha512-A0I7xBU7NIWT75NeSgCOax443HsjcWQcJ4YCc5Gs4HdwcmEDPO309vBJNPog7stNsR0wWOtovh8h3p8rryDXRA== but got sha512-70I7xBU7NIWT75NeSgCOax443HsjcWQcJ4YCc5Gs4HdwcmEDPO309vBJNPog7stNsR0wWOtovh8h3p8rryDXRA==
```

### Fail-closed assertion

`verifyIntegrity` throws inside `resolveNpm`'s `try { … } finally { rmSync(tmpPackDir);
rmSync(extractDir) }` (`:944-1001`), **before** `stageValidated` promotes anything. After the
refusal the recipe asserts the negative sandbox has neither
`<GSD_HOME>/.gsd/capabilities/contribution-toolkit/` nor a ledger entry for the id — both absent.
(Mitigates T-nv5-03: no partial staging promoted on tamper.)

## Sandbox safety (T-nv5-01)

Every `gsd-tools capability install` runs with `GSD_HOME` set to a fresh scratch sub-dir under
`os.tmpdir()`, with `--scope global` and a scratch cwd. Before **every** spawn the recipe asserts
the GSD_HOME is (a) non-empty, (b) under `os.tmpdir()`, (c) NOT under `os.homedir()`, and (d) not a
`~/.gsd`/`~/.claude` path — aborting otherwise. gsd-core resolves the global overlay home as
`gsdHome || process.env['GSD_HOME'] || os.homedir()` (`capability-loader.cts:301`,
`capability-source.cts:1071`), so a scratch GSD_HOME points the global capability root at
`<scratch>/.gsd/capabilities`. Verified out-of-band: `~/.gsd/capabilities` unchanged across runs,
no `contribution-toolkit` written to the real home, and the scratch dir is removed at start and end
(idempotent — a second run also exits 0). Each install uses a distinct GSD_HOME sub-dir, so no
"already installed" duplicate interference.

## Provenance block added (D1)

`capabilities/contribution-toolkit/capability.json` now carries the optional ADR-1244 D1 block:

```json
"provenance": {
  "sourceRepo": "https://github.com/davesienkowski/gsd-contribution-toolkit",
  "commit": "c364f5702b099957189644cf9590e02539bfd01f"
}
```

The commit is the **real** public-repo HEAD from `git ls-remote https://github.com/davesienkowski/gsd-contribution-toolkit HEAD`
(not hardcoded). Provenance is advisory (SHOULD be emitted; does not gate install): the LIVE
`verify-capability` (which runs gsd-core's own `validateCapability` / `validateVersionEnvelope` /
`validateRuntimeCompat` / `validateAgainstContract`) reports **13 pass, 0 fail** with the block
present, and bundle-parity stays green (the block is additive metadata; the canonical hooks/ bundle
is unaffected, so no `build-capability.cjs` regen was required — T-nv5-04 did not trip). The install
above (which extracts and validates the staged `capability.json` carrying provenance) still reports
`installed`, confirming gsd-core accepts the block.

## Trust-but-verify re-grounding — discrepancies

Before relying on the plan's grounded facts, the live gsd-core sources at branch `next`
(HEAD `adef8b29`) were re-grepped. **No discrepancies found** — every behavioural fact matched:

- `parseSpec` path → `local`; `resolveLocal` throws on `opts.integrity` (`:858`).
- `npm:` → `resolveNpm`: `npm pack --ignore-scripts` (`:948`) → `verifyIntegrity(tgzBytes, opts.integrity)` over .tgz bytes BEFORE staging (`:970-971`).
- `computeIntegrity`/`verifyIntegrity` use sha512 + the `sha512-` prefix and throw `Integrity mismatch` / `Unsupported integrity algorithm` (`:292-311`).
- `process.env['GSD_HOME']` overrides the global overlay home (`capability-loader.cts:301`, `capability-source.cts:1071`).
- CLI `capability install` supports `--integrity` / `--scope` / `--yes`; executable-surface capabilities abort without `--yes` (`gsd-tools.cjs:1672-1731`).
- ADR-1244 D1: `provenance` is `{ sourceRepo, commit }`, optional/advisory (`docs/adr/1244-capability-ecosystem.md:38`).

(Line numbers above reflect the re-grep at HEAD `adef8b29`; the tree was refactored recently, so
they may drift — the behaviours are what was confirmed.)
