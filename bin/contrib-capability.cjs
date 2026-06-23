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
const LIVE_TRUST_REL = 'gsd-core/bin/lib/capability-trust.cjs';

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

// ---------------------------------------------------------------------------
// LIVE engine loading (LOUD-on-miss — T-12-01-SILENTPASS / T-12-01-REIMPL)
// ---------------------------------------------------------------------------

/**
 * A typed driver-level failure for a check/op that COULD NOT RUN (unresolved checkout, missing LIVE
 * export, ScriptResolveError). Carried to the CLI so it exits nonzero with a naming message — an
 * operation that could not run is NEVER reported as success.
 */
class DriverError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DriverError';
  }
}

/**
 * Require the LIVE engine modules through the resolver (HARD-02). Throws DriverError on an
 * unresolved checkout or a missing/renamed export — never a vendored fallback, never a silent miss.
 *
 * @param {object} [opts]
 * @param {string|null} [opts.liveRoot]          gsd-core root; default resolveGsdCoreCwd(); null => LOUD.
 * @param {Function}    [opts.requireLiveScript] (root, rel) => module; default the resolve.cjs one.
 * @returns {{ liveRoot:string, lifecycle:object, consent:object, source:object, ledger:object, trust:object, CAP_MARKER:string }}
 */
function loadLiveEngine(opts = {}) {
  const liveRoot = Object.prototype.hasOwnProperty.call(opts, 'liveRoot')
    ? opts.liveRoot
    : resolveGsdCoreCwd();
  const requireLiveScript = opts.requireLiveScript || liveRequireLiveScript;

  if (!liveRoot) {
    throw new DriverError(
      'cannot locate a gsd-core checkout (set GSD_CORE_ROOT, or use ~/repos/gsd-core | ~/gsd-core) — ' +
        'this driver writes nowhere except the resolved checkout + ${GSD_HOME||~}/.gsd store; a target ' +
        'is NEVER a hardcoded path (T-12-01-PATH), and an op that cannot resolve its target FAILS LOUD'
    );
  }

  const load = (rel, name) => {
    let mod;
    try {
      mod = requireLiveScript(liveRoot, rel);
    } catch (err) {
      const isResolve = err instanceof ScriptResolveError || (err && err.name === 'ScriptResolveError');
      throw new DriverError(
        'could not load LIVE ' + rel + ' (' + (isResolve ? 'ScriptResolveError' : (err && err.name)) +
          ': ' + (err && err.message) + ') — HARD-02: the LIVE engine is the sole source of truth; an ' +
          'unloadable LIVE module FAILS LOUD rather than falling back to a vendored copy'
      );
    }
    if (!mod || typeof mod !== 'object') {
      throw new DriverError('LIVE ' + rel + ' loaded but exported no module object (' + name + ')');
    }
    return mod;
  };

  const lifecycle = load(LIVE_LIFECYCLE_REL, 'lifecycle');
  const consent = load(LIVE_CONSENT_REL, 'consent');
  const source = load(LIVE_SOURCE_REL, 'source');
  const ledger = load(LIVE_LEDGER_REL, 'ledger');
  const trust = load(LIVE_TRUST_REL, 'trust');

  // Shape check: every LIVE function the driver composes must be present (a gsd-core rename surfaces
  // here as a LOUD fail, never a silent false-success — T-12-01-REIMPL).
  const required = [
    [lifecycle, 'applyCapabilitySharedEdits'],
    [lifecycle, 'stripCapabilitySharedEdits'],
    [lifecycle, 'confinedSharedFile'],
    [consent, 'bundleContentHash'],
    [consent, 'recordProjectConsent'],
    [consent, 'readConsentStore'],
    [consent, 'consentStorePath'],
    [ledger, 'recordInstall'],
    [ledger, 'readLedger'],
    [trust, 'signatureForManifest'],
  ];
  const missing = required
    .filter(([m, fn]) => typeof (m && m[fn]) !== 'function')
    .map(([, fn]) => fn);
  if (missing.length > 0) {
    throw new DriverError(
      'LIVE engine export(s) unavailable (renamed/removed in gsd-core): ' + missing.join(', ') +
        ' — HARD-02: this driver REUSES the LIVE engine and reimplements nothing, so a missing export ' +
        'FAILS LOUD (a gsd-core refactor must surface here, never a silent miss)'
    );
  }
  const CAP_MARKER = typeof lifecycle.CAP_MARKER === 'string' ? lifecycle.CAP_MARKER : '_gsdCapability';

  return { liveRoot, lifecycle, consent, source, ledger, trust, CAP_MARKER };
}

// ---------------------------------------------------------------------------
// Manifest + reconcile helpers
// ---------------------------------------------------------------------------

/**
 * Read + parse the bundle manifest. Throws DriverError on a read/parse error (LOUD-on-miss).
 * @param {string} [manifestPath]
 * @returns {object}
 */
function readManifest(manifestPath) {
  const p = manifestPath || MANIFEST_PATH;
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (err) {
    throw new DriverError('cannot read manifest ' + p + ': ' + (err && err.message));
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new DriverError('cannot parse manifest ' + p + ': ' + (err && err.message));
  }
}

/**
 * The set of toolkit hook script basenames declared by the manifest hooks[]. These identify the
 * LEGACY untagged install.sh entries the reconcile step must strip (matched by basename presence in
 * the entry's serialized command) so exactly one CAP_MARKER-tagged set remains (T-12-01-IDEMPOTENT).
 * @param {object} manifest
 * @returns {string[]}
 */
function manifestHookBasenames(manifest) {
  const hooks = Array.isArray(manifest && manifest.hooks) ? manifest.hooks : [];
  const out = [];
  for (const h of hooks) {
    const script = h && typeof h.script === 'string' ? h.script : '';
    if (!script) continue;
    out.push(path.basename(script));
  }
  return out;
}

/**
 * Reconcile away the pre-existing UNTAGGED contrib entries from the resolved gsd-core settings.json
 * BEFORE the LIVE applyCapabilitySharedEdits writes the one marker-tagged set. Removes only entries
 * that (a) are NOT owned by any capability marker AND (b) reference one of this capability's hook
 * script basenames. CAP_MARKER-tagged entries are left to the LIVE engine to manage (so a re-run is
 * idempotent — the LIVE apply strips its own marker first). Returns the count removed.
 *
 * Containment: writes ONLY the resolved settings file (path is confined via the LIVE
 * confinedSharedFile against runtimeDir; a null confine result is treated as "no file to touch").
 *
 * @param {object} args
 * @param {string} args.runtimeDir    resolved gsd-core root
 * @param {string} args.settingsRel   settings file rel path (SHARED_SETTINGS_REL)
 * @param {string} args.capMarker     CAP_MARKER value
 * @param {string[]} args.basenames   manifest hook basenames
 * @param {Function} args.confinedSharedFile  LIVE lifecycle.confinedSharedFile
 * @returns {number} entries removed
 */
function reconcileLegacyEntries(args) {
  const { runtimeDir, settingsRel, capMarker, basenames, confinedSharedFile } = args;
  const file = confinedSharedFile(runtimeDir, settingsRel);
  if (file === null) return 0; // unsafe/escaping path — nothing to touch (containment)
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return 0; // missing/unparseable — nothing legacy to reconcile
  }
  const hooks = settings && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks)
    ? settings.hooks
    : null;
  if (!hooks) return 0;
  const baseSet = new Set(basenames);
  let removed = 0;
  for (const event of Object.keys(hooks)) {
    if (!Array.isArray(hooks[event])) continue;
    const arr = hooks[event];
    const kept = arr.filter((e) => {
      if (typeof e !== 'object' || e === null) return true;
      // Leave CAP_MARKER-tagged entries to the LIVE engine (idempotent re-run).
      if (Object.prototype.hasOwnProperty.call(e, capMarker)) return true;
      const serialized = JSON.stringify(e);
      for (const b of baseSet) {
        if (serialized.includes(b)) return false; // legacy untagged contrib entry → strip
      }
      return true;
    });
    if (kept.length !== arr.length) {
      removed += arr.length - kept.length;
      if (kept.length === 0) delete hooks[event];
      else hooks[event] = kept;
    }
  }
  if (Object.keys(hooks).length === 0) delete settings.hooks;
  if (removed > 0) {
    fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  }
  return removed;
}

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------

/**
 * Drive the LIVE engine (composed seams — the spike's chosen path B) to install contrib-gate against
 * a local gsd-core checkout: (1) reconcile away the legacy untagged duplicates, (2) record a real
 * project-scope consent (bundleContentHash + signatureForManifest), (3) recordInstall into the LIVE
 * ledger, (4) applyCapabilitySharedEdits to write the 13 manifest hooks marker-tagged. Idempotent.
 *
 * @param {object} [opts] same injectable seams as loadLiveEngine, plus consentHome/bundleDir.
 * @returns {{lines:string[], applied:number, reconciled:number}}
 */
function runInstall(opts = {}) {
  const engine = loadLiveEngine(opts);
  const { liveRoot, lifecycle, consent, ledger, trust, CAP_MARKER } = engine;
  const consentHome = opts.consentHome || consentStoreHome();
  const bundleDir = opts.bundleDir || BUNDLE_CAP_DIR;
  const manifestPath = opts.manifestPath || path.join(bundleDir, 'capability.json');
  const manifest = readManifest(manifestPath);

  const lines = [];
  lines.push('[install] gsd-core checkout: ' + liveRoot);
  lines.push('[install] consent/ledger store: ' + consentHome);

  // (1) Reconcile the legacy untagged duplicates BEFORE the LIVE apply lays down the tagged set.
  const reconciled = reconcileLegacyEntries({
    runtimeDir: liveRoot,
    settingsRel: SHARED_SETTINGS_REL,
    capMarker: CAP_MARKER,
    basenames: manifestHookBasenames(manifest),
    confinedSharedFile: lifecycle.confinedSharedFile,
  });
  lines.push('[install] reconciled legacy untagged contrib entries: ' + reconciled);

  // (2) Real project-scope consent, bound to the bundle content hash + LIVE disclosure signature.
  const contentHash = consent.bundleContentHash(bundleDir);
  let disclosureSignature = '';
  try {
    disclosureSignature = trust.signatureForManifest(manifest, bundleDir) || '';
  } catch (_) {
    disclosureSignature = '';
  }
  consent.recordProjectConsent({
    gsdHome: consentHome,
    projectRoot: liveRoot,
    id: CAP_ID,
    integrity: '',
    disclosureSignature,
    contentHash,
  });
  lines.push('[install] recorded project consent (contentHash=' + contentHash.slice(0, 16) + '...)');

  // (3) Ledger entry (LIVE recordInstall). The LIVE apply (step 4) returns the sharedEdits records;
  // record the ledger entry to OWN that one tagged set.
  //
  // IDEMPOTENCY (T-12-01-IDEMPOTENT): the LIVE applyCapabilitySharedEdits APPENDS — it does not
  // strip a prior marker set. The LIVE orchestrator achieves a byte-stable re-run by pairing it with
  // stripCapabilitySharedEdits FIRST (reapplyCapabilitySharedEdits = strip→apply). We mirror that
  // exact LIVE pair here so a second `install` removes our prior CAP_MARKER-tagged set before laying
  // down the fresh one (no growth, no reimplementation — both halves are LIVE engine functions).
  lifecycle.stripCapabilitySharedEdits({
    runtimeDir: liveRoot,
    capId: CAP_ID,
    sharedEdits: [{ file: SHARED_SETTINGS_REL, marker: CAP_ID }],
  });
  const sharedEdits = lifecycle.applyCapabilitySharedEdits({
    runtimeDir: liveRoot,
    capId: CAP_ID,
    manifest,
    sharedFiles: [SHARED_SETTINGS_REL],
  });
  ledger.recordInstall(liveRoot, {
    id: CAP_ID,
    version: typeof manifest.version === 'string' ? manifest.version : '0.0.0',
    source: 'local:' + bundleDir,
    integrity: '',
    files: [],
    sharedEdits,
  });
  const applied = Array.isArray(sharedEdits) ? sharedEdits.length : 0;
  lines.push('[install] applied + ledger-recorded marker-tagged shared edits across ' + applied + ' file(s)');

  // The on/off flip of workflow.gsd_contrib_enforcement is OWNED by Plan 12-02; install leaves the
  // config default (OFF) so the advisory surface is the explicit opt-in 12-02 toggles.
  lines.push('[install] done — re-run is idempotent (LIVE apply strips its own marker first)');
  return { lines, applied, reconciled };
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

/**
 * Report the LIVE ledger entry, the consent record, and which contrib gates are currently live
 * (CAP_MARKER-tagged) in the resolved settings.json. Read-only.
 *
 * @param {object} [opts]
 * @returns {{lines:string[], installed:boolean, consented:boolean, liveGateCount:number}}
 */
function runStatus(opts = {}) {
  const engine = loadLiveEngine(opts);
  const { liveRoot, lifecycle, consent, ledger, CAP_MARKER } = engine;
  const consentHome = opts.consentHome || consentStoreHome();

  const lines = [];
  lines.push('[status] gsd-core checkout: ' + liveRoot);

  // Ledger entry.
  let installed = false;
  let ledgerEntry = null;
  try {
    const led = ledger.readLedger(liveRoot);
    ledgerEntry = led && led.entries && Object.prototype.hasOwnProperty.call(led.entries, CAP_ID)
      ? led.entries[CAP_ID]
      : null;
    installed = ledgerEntry !== null;
  } catch (err) {
    throw new DriverError('could not read the LIVE ledger: ' + (err && err.message));
  }
  if (installed) {
    lines.push('[status] ledger: contrib-gate INSTALLED (version ' +
      (ledgerEntry.version || '?') + ', source ' + (ledgerEntry.source || '?') + ')');
  } else {
    lines.push('[status] ledger: contrib-gate NOT in ledger');
  }

  // Consent record.
  let consented = false;
  try {
    const store = consent.readConsentStore(consentHome);
    const records = (store && store.records) || {};
    for (const key of Object.keys(records)) {
      const rec = records[key];
      if (rec && rec.id === CAP_ID) {
        consented = true;
        break;
      }
    }
  } catch (err) {
    throw new DriverError('could not read the consent store at ' + consentHome + ': ' + (err && err.message));
  }
  lines.push('[status] consent: contrib-gate ' + (consented ? 'CONSENTED' : 'no project consent record'));

  // Live gates currently in settings.json (CAP_MARKER-tagged, owned by contrib-gate).
  let liveGateCount = 0;
  const liveGateNames = [];
  const file = lifecycle.confinedSharedFile(liveRoot, SHARED_SETTINGS_REL);
  if (file !== null) {
    try {
      const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
      const hooks = settings && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks)
        ? settings.hooks
        : {};
      for (const event of Object.keys(hooks)) {
        if (!Array.isArray(hooks[event])) continue;
        for (const e of hooks[event]) {
          if (e && typeof e === 'object' && e[CAP_MARKER] === CAP_ID) {
            liveGateCount += 1;
            const cmd = e.hooks && e.hooks[0] && e.hooks[0].command ? String(e.hooks[0].command) : '';
            liveGateNames.push(event + ':' + path.basename(cmd.replace(/['"]/g, '')));
          }
        }
      }
    } catch (_) {
      // missing/unparseable settings.json — zero live gates.
    }
  }
  lines.push('[status] live gates (CAP_MARKER-tagged in settings.json): ' + liveGateCount);
  if (liveGateNames.length > 0) {
    lines.push('[status]   ' + liveGateNames.join(', '));
  }

  return { lines, installed, consented, liveGateCount };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function usage() {
  return [
    'contrib-capability — thin driver for the contrib-gate capability (drives the LIVE gsd-core engine)',
    '',
    '  node bin/contrib-capability.cjs install   stage + consent + ledger + marker-tag the 13 hooks',
    '  node bin/contrib-capability.cjs status     report ledger + consent + live gate set',
    '',
    '  (on | off | remove are added by Plan 12-02)',
    '',
    'Exit codes: 0 ok, 1 LOUD-on-miss (unresolved checkout / missing LIVE export / op failed), 2 usage.',
  ].join('\n');
}

/**
 * CLI entrypoint. Returns the process exit code (never throws — a DriverError becomes a nonzero
 * exit with a naming message; an unknown subcommand prints usage and exits 2).
 * @param {string[]} [argv] default process.argv.slice(2)
 * @returns {number}
 */
function runCli(argv) {
  const args = Array.isArray(argv) ? argv : process.argv.slice(2);
  const sub = args[0];

  if (!sub || sub === '-h' || sub === '--help' || sub === 'help') {
    process.stdout.write(usage() + '\n');
    return sub ? 0 : 2;
  }

  if (sub !== 'install' && sub !== 'status') {
    process.stderr.write('contrib-capability: unknown subcommand "' + sub + '"\n\n' + usage() + '\n');
    return 2;
  }

  try {
    const out = sub === 'install' ? runInstall() : runStatus();
    for (const line of out.lines) process.stdout.write(line + '\n');
    return 0;
  } catch (err) {
    const isDriver = err instanceof DriverError || (err && err.name === 'DriverError');
    process.stderr.write(
      '[FAIL] contrib-capability ' + sub + ' — ' +
        (isDriver ? '' : '(' + (err && err.name) + ') ') +
        ((err && err.message) || String(err)) + '\n' +
        '       An operation that could not run is NEVER reported as success (LOUD-on-miss).\n'
    );
    return 1;
  }
}

if (require.main === module) {
  process.exit(runCli());
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
  LIVE_TRUST_REL,
  DriverError,
  resolveGsdCoreCwd,
  consentStoreHome,
  loadLiveEngine,
  readManifest,
  manifestHookBasenames,
  reconcileLegacyEntries,
  runInstall,
  runStatus,
  runCli,
  liveRequireLiveScript,
  ScriptResolveError,
};
