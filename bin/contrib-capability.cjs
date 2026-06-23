#!/usr/bin/env node
'use strict';

/**
 * bin/contrib-capability.cjs — the CAP-03 thin driver for the contrib-gate capability.
 *
 *   node bin/contrib-capability.cjs install   # stage + consent + ledger + marker-tag the 13 hooks
 *   node bin/contrib-capability.cjs status     # report ledger entry + consent record + live gate set
 *   # (on | off | remove are added by Plan 12-02; the sandbox test by Plan 12-03)
 *
 * This is a THIN DRIVER. It NEVER reimplements the gsd-core capability engine
 * (capability-lifecycle / consent / source / ledger). It `require()`s the LIVE engine through the
 * SAME resolver the hooks use (hooks/lib/resolve.cjs requireLiveScript) so a gsd-core refactor that
 * renames/removes an export surfaces here as a LOUD nonzero error — never a stale vendored copy and
 * never a silent no-op (HARD-02 reuse-LIVE; mirrors bin/verify-capability.cjs LOUD-on-miss).
 *
 * Honesty (HARD): this driver MUST NOT label the capability itself "unbypassable". "Unbypassable"
 * is a property of the SEPARATE personal PreToolUse hooks WHILE installed, not of this opt-in,
 * toggleable capability. Its loop gates[]/contributions[] are advisory.
 *
 * ===========================================================================================
 * ENTRYPOINT SPIKE — DECISION (Task 1; recorded here and in 12-01-SUMMARY for 12-02/12-03)
 * ===========================================================================================
 *
 * Question: drive (A) the LIVE high-level orchestrator `capability-lifecycle.installCapability`
 * directly, or (B) compose the lower-level LIVE seams
 * (resolveCapabilitySource -> bundleContentHash -> recordProjectConsent -> recordInstall ->
 * applyCapabilitySharedEdits)?
 *
 * DECISION: (B) COMPOSE the lower-level LIVE functions, with a TOOLKIT-OWNED pre-reconcile step
 * that strips the pre-existing UNTAGGED legacy contrib entries (matched by the manifest hook
 * script basenames) BEFORE the LIVE applyCapabilitySharedEdits writes the one marker-tagged set.
 * The composed seams are ALL gsd-core's LIVE functions — zero engine logic is reimplemented.
 *
 * EVIDENCE (inspected LIVE signatures/behaviour in
 *   ~/repos/gsd-core/gsd-core/bin/lib/{capability-lifecycle,capability-source,capability-consent,
 *   capability-ledger}.cjs):
 *
 *   1. RECONCILE GAP (decisive). installCapability's shared-edit step is
 *      `reapplyCapabilitySharedEdits({ stripFiles, applyFiles, manifest })` (lifecycle.cjs ~L831),
 *      which calls `stripCapabilitySharedEdits` — and that strips ONLY entries stamped
 *      `CAP_MARKER === capId` (lifecycle.cjs ~L538 `e[CAP_MARKER] === capId`). The pre-existing
 *      duplicate entries written by install.sh are UNTAGGED, so installCapability would leave them
 *      in place. The plan's HARD requirement ("reconcile away the pre-existing duplicate
 *      manual-merge entries so exactly one marker-tagged set remains") therefore CANNOT be met by
 *      installCapability alone — a toolkit-owned pre-strip of the legacy untagged set (by manifest
 *      hook basename) is required no matter which entrypoint is chosen. Composition makes that
 *      pre-strip a first-class, controllable step.
 *
 *   2. TRUST / FIRST-PARTY GATE. installCapability(spec, opts) is ASYNC and runs the trust gates
 *      `evaluateSourceAllowed` + `evaluateInstallTrust`, rejects first-party ids
 *      (isFirstPartyCapabilityId), and gates a consent prompt behind `verdict.requiresConsent &&
 *      !opts.consentGranted` (lifecycle.cjs ~L693-L774). For a private, local, project-scope
 *      install of a THIRD-PARTY id ('contrib-gate' is not first-party), that whole gate layer is
 *      overhead we would have to satisfy with opts plumbing (consentGranted, strictKnownRegistries)
 *      to get a deterministic 'installed' result — composition lets us drive exactly the seams we
 *      need without depending on the orchestrator's trust verdict shape.
 *
 *   3. THE COMPOSABLE SEAMS EXIST AND FIT (all LIVE):
 *        - capability-source.resolveCapabilitySource(spec, opts) is ASYNC; parseSpec(spec) returns
 *          { kind: 'local', target } for an absolute path (source.cjs ~L647), and the local adapter
 *          (resolveLocal, source.cjs ~L689) stages the bundle directory — `promote: false` stages,
 *          `gsdHome: runtimeDir` selects the store. (Driver may stage via this, or apply directly
 *          from the in-repo bundle dir for the shared-edit half — both keep the engine LIVE.)
 *        - capability-consent.bundleContentHash(capDir) computes the security-binding hash
 *          (consent.cjs ~L333); recordProjectConsent({ gsdHome, projectRoot, id, integrity,
 *          disclosureSignature, contentHash }) writes a LOCKED, project-scope record keyed to
 *          realpath(projectRoot)+id (consent.cjs ~L647) and REQUIRES a non-empty contentHash.
 *          Default store is `${GSD_HOME||~}/.gsd/consent.json` (consentStorePath).
 *        - capability-ledger.recordInstall(runtimeDir, entry, opts?) records the ledger entry into
 *          `<runtimeDir>/.gsd-capabilities.json` (LEDGER_FILE_NAME); readLedger reads it back.
 *        - capability-lifecycle.applyCapabilitySharedEdits({ runtimeDir, capId, manifest,
 *          sharedFiles }) writes each manifest hooks[] entry into the shared settings file stamped
 *          with CAP_MARKER === capId, confining every write via confinedSharedFile /
 *          confinedBundleScript (returns null for absolute/`..`/symlink-escape — T-12-01-PATH).
 *          CAP_MARKER === '_gsdCapability'. stripCapabilitySharedEdits is its inverse (12-02 on/off).
 *
 * NET: composition is the path that BOTH satisfies the duplicate-reconcile HARD requirement AND
 * keeps every state-changing step on a LIVE gsd-core function. The runtimeDir for the shared-edit /
 * ledger writes is the resolved local gsd-core checkout (resolve.cjs sentinel walk — never a
 * hardcoded path, T-12-01-PATH containment); the consent store is `${GSD_HOME||~}/.gsd`.
 * ===========================================================================================
 *
 * LOUD-on-miss discipline (mirrors verify-capability.cjs): an unresolved gsd-core checkout, a
 * missing/renamed LIVE export, or a ScriptResolveError is an EXPLICIT nonzero error — an operation
 * that could not run is NEVER reported as success (T-12-01-SILENTPASS).
 *
 * No shell: pure require()/fs (carries the no-shell discipline of the hook layer).
 *
 * @module bin/contrib-capability
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  requireLiveScript: liveRequireLiveScript,
  ScriptResolveError,
} = require('../hooks/lib/resolve.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const BUNDLE_CAP_DIR = path.join(REPO_ROOT, 'capabilities', 'contrib-gate');
const MANIFEST_PATH = path.join(BUNDLE_CAP_DIR, 'capability.json');
const CAP_ID = 'contrib-gate';

// LIVE engine module paths (relative to the resolved gsd-core root) — resolved at runtime via
// requireLiveScript so a renamed module FAILS LOUD instead of falling back to a vendored copy.
const LIVE_LIFECYCLE_REL = 'gsd-core/bin/lib/capability-lifecycle.cjs';
const LIVE_CONSENT_REL = 'gsd-core/bin/lib/capability-consent.cjs';
const LIVE_SOURCE_REL = 'gsd-core/bin/lib/capability-source.cjs';
const LIVE_LEDGER_REL = 'gsd-core/bin/lib/capability-ledger.cjs';

// The settings file the gates are written into, relative to the gsd-core runtimeDir. The LIVE
// confinedSharedFile() resolves this against runtimeDir and rejects any escape (T-12-01-PATH).
const SHARED_SETTINGS_REL = path.join('.claude', 'settings.json');

/**
 * Resolve a gsd-core checkout carrying the sentinel layout (scripts/ + gsd-core/bin/lib/). Mirrors
 * bin/verify-capability.cjs resolveGsdCoreCwd: GSD_CORE_ROOT, then ~/repos/gsd-core, then ~/gsd-core.
 * Returns an absolute root, or null when none is reachable (caller turns null into a LOUD fail —
 * a write target is NEVER a hardcoded path; T-12-01-PATH containment).
 *
 * @returns {string|null}
 */
function resolveGsdCoreCwd() {
  const hasSentinel = (dir) => {
    try {
      return (
        fs.statSync(path.join(dir, 'scripts')).isDirectory() &&
        fs.statSync(path.join(dir, 'gsd-core', 'bin', 'lib')).isDirectory()
      );
    } catch (_) {
      return false;
    }
  };
  const candidates = [
    process.env.GSD_CORE_ROOT,
    path.join(os.homedir(), 'repos', 'gsd-core'),
    path.join(os.homedir(), 'gsd-core'),
  ].filter(Boolean);
  for (const c of candidates) {
    if (hasSentinel(c)) return c;
  }
  return null;
}

/**
 * The GSD_HOME-or-~ consent + ledger store root (project-scope consent lives at
 * `${GSD_HOME||~}/.gsd/consent.json`). Never writes outside this store or the resolved gsd-core
 * checkout (T-12-01-PATH path confinement).
 * @returns {string}
 */
function consentStoreHome() {
  return process.env.GSD_HOME || os.homedir();
}

if (require.main === module) {
  // Task 2 wires the install + status subcommands here. Task 1 establishes the file, header, spike
  // decision, and the LIVE-resolution scaffolding only.
  process.stderr.write(
    'contrib-capability: install/status subcommands are added in Task 2 of plan 12-01.\n'
  );
  process.exit(2);
}

module.exports = {
  CAP_ID,
  REPO_ROOT,
  BUNDLE_CAP_DIR,
  MANIFEST_PATH,
  SHARED_SETTINGS_REL,
  LIVE_LIFECYCLE_REL,
  LIVE_CONSENT_REL,
  LIVE_SOURCE_REL,
  LIVE_LEDGER_REL,
  resolveGsdCoreCwd,
  consentStoreHome,
  liveRequireLiveScript,
  ScriptResolveError,
};
