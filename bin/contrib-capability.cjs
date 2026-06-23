#!/usr/bin/env node
'use strict';

/**
 * bin/contrib-capability.cjs — the CAP-03 thin driver for the contribution-toolkit capability.
 *
 *   node bin/contrib-capability.cjs install            # stage + consent + ledger + marker-tag the 13 hooks
 *   node bin/contrib-capability.cjs on                 # (re)apply the tagged gates + enforcement flag on
 *   node bin/contrib-capability.cjs off  --reason <w>  # strip the tagged gates + flag off + logged receipt
 *   node bin/contrib-capability.cjs status             # report ledger entry + consent record + live gate set
 *   node bin/contrib-capability.cjs remove --reason <w> # remove from ledger + consent + logged receipt
 *   # (the disposable-sandbox integration test is Plan 12-03)
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
 *      install of a THIRD-PARTY id ('contribution-toolkit' is not first-party), that whole gate layer is
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
// REUSE the in-repo append-only receipt writer (HARD honesty / accountability) — the SAME pattern the
// GSD_CONTRIB_OVERRIDE escape valve uses. off/remove leave a deliberate, recorded receipt; we do NOT
// fork a parallel receipt mechanism (the override.cjs record already carries an `action` field).
const { writeReceipt, receiptPathFor } = require('../hooks/lib/override.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const BUNDLE_CAP_DIR = path.join(REPO_ROOT, 'capabilities', 'contribution-toolkit');
const MANIFEST_PATH = path.join(BUNDLE_CAP_DIR, 'capability.json');
const CAP_ID = 'contribution-toolkit';

// LIVE engine module paths (relative to the resolved gsd-core root) — resolved at runtime via
// requireLiveScript so a renamed module FAILS LOUD instead of falling back to a vendored copy.
const LIVE_LIFECYCLE_REL = 'gsd-core/bin/lib/capability-lifecycle.cjs';
const LIVE_CONSENT_REL = 'gsd-core/bin/lib/capability-consent.cjs';
// NOTE (CR-02): no LIVE_SOURCE_REL — the driver applies shared edits directly from the in-repo bundle
// dir and never calls resolveCapabilitySource, so capability-source.cjs is intentionally not loaded.
const LIVE_LEDGER_REL = 'gsd-core/bin/lib/capability-ledger.cjs';
const LIVE_TRUST_REL = 'gsd-core/bin/lib/capability-trust.cjs';
const LIVE_CONFIG_REL = 'gsd-core/bin/lib/config.cjs';

// The advisory-surface config flag the on/off toggle flips (manifest config key). It lives in the
// gsd-core checkout's `.planning/config.json`; we flip it via the LIVE config.setConfigValue (never a
// hand-rolled JSON write) so the advisory contribution's `when: workflow.gsd_contrib_enforcement`
// genuinely turns on/off. on => true, off => false (off GENUINELY removes the enforcement).
const ENFORCEMENT_FLAG = 'workflow.gsd_contrib_enforcement';

// The settings file the gates are written into, relative to the gsd-core runtimeDir. The LIVE
// confinedSharedFile() resolves this against runtimeDir and rejects any escape (T-12-01-PATH).
const SHARED_SETTINGS_REL = path.join('.claude', 'settings.json');

// The agent-facing slash-command set the install DELIVERS into the runtime commands dir. The set is
// DATA-DRIVEN from the BUNDLE's commands/ dir on disk via the SAME /^gsd-.*\.md$/ filter
// build-capability.cjs readDisclosedCommandSet + verify-capability.cjs readShippedCommands use — so
// the delivered set provably equals the shipped/disclosed set (T-17-02-REPOSOURCE: source from the
// BUNDLE, never the repo working tree, so a remote-installed bundle is self-sufficient).
const COMMAND_NAME_RE = /^gsd-.*\.md$/;

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
// command delivery (deliver-on-install / reclaim-on-remove) — mirrors install.sh
// ---------------------------------------------------------------------------
//
// DELIVERY FORM DECISION (justified — recorded here + in 17-02-SUMMARY):
//   The install DELIVERS the 5 bundled slash-command .md's as ABSOLUTE SYMLINKS into the runtime
//   commands dir (`${CLAUDE_DIR:-~/.claude}/commands/<name>.md` -> the bundle's commands/<name>.md),
//   exactly mirroring install.sh's `ln -sfn "${abs_src}" "${tgt}"` (install.sh L66/L77). A symlink is
//   the closest LOCAL-PARITY analog to install.sh AND is correct for a promoted
//   `.gsd/capabilities/<id>/commands/` bundle: the bundle dir is stable + co-located with the rest of
//   the install, so a symlink keeps a single source of truth — regenerating the bundle (re-running
//   build-capability) is reflected at the link target without re-delivering. (If a future remote
//   adapter makes the bundle path ephemeral, switch to a copy — but for the local + promoted-bundle
//   install paths in scope here, a symlink is the parity-correct form.)
//
// FAIL-SAFE (T-17-02-CLOBBER): a real non-symlink file/dir at a command target is NEVER clobbered —
//   deliverBundledCommands throws a DriverError (install FAILS rather than overwrite a real file),
//   mirroring install.sh's `die "refusing to overwrite real file"` (install.sh L73).
//
// LIFECYCLE TIE DECISION (justified — per CONTEXT.md discretion): command delivery is tied to the
//   install/remove lifecycle (delivered by `install`, reclaimed by `remove`), NOT the on/off
//   enforcement toggle. Commands are AVAILABILITY, not enforcement — the on/off flag governs the gate
//   enforcement flag + the marker-tagged gates, NOT command availability. So `off` leaves the command
//   links in place (an operator turning enforcement off still has the slash-commands available); only
//   `remove` (and an uninstall) reclaims them.

/**
 * Resolve the runtime commands dir Claude Code reads slash-commands from: `${CLAUDE_DIR:-~/.claude}/commands`.
 * Honors the CLAUDE_DIR env override (so the hermetic lifecycle test can point delivery at a sandbox),
 * mirroring install.sh's `CLAUDE_DIR="${HOME}/.claude"`. Injectable via opts.commandsDir for the test.
 *
 * @param {object} [opts]
 * @param {string} [opts.commandsDir] explicit override (the test injects a sandbox dir); wins outright.
 * @param {string} [opts.claudeDir]   explicit ${CLAUDE_DIR} root override; commands dir = <claudeDir>/commands.
 * @returns {string} absolute path to the runtime commands dir.
 */
function claudeCommandsDir(opts = {}) {
  if (opts && typeof opts.commandsDir === 'string' && opts.commandsDir.length > 0) {
    return opts.commandsDir;
  }
  const claudeDir =
    (opts && typeof opts.claudeDir === 'string' && opts.claudeDir.length > 0 && opts.claudeDir) ||
    process.env.CLAUDE_DIR ||
    path.join(os.homedir(), '.claude');
  return path.join(claudeDir, 'commands');
}

/**
 * Enumerate the bundled command .md basenames from the BUNDLE's commands/ dir on disk (the SAME
 * /^gsd-.*\.md$/ filter the bundler + verifier use). Sourcing from the BUNDLE (never the repo working
 * tree) makes a remote-installed bundle self-sufficient (T-17-02-REPOSOURCE). Returns sorted names.
 *
 * @param {string} bundleDir bundle root (BUNDLE_CAP_DIR or an injected sandbox bundle).
 * @returns {string[]} the `gsd-*.md` basenames present in <bundleDir>/commands.
 */
function bundledCommandNames(bundleDir) {
  const dir = path.join(bundleDir, 'commands');
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    throw new DriverError(
      'cannot read the bundle commands dir ' + dir + ' (' + (err && err.message) + ') — the bundle ' +
        'must ship its commands/ (run `node bin/build-capability.cjs` to regenerate); an install that ' +
        'cannot source its commands FAILS LOUD rather than deliver nothing'
    );
  }
  return entries
    .filter((e) => e.isFile() && COMMAND_NAME_RE.test(e.name))
    .map((e) => e.name)
    .sort();
}

/**
 * DELIVER the bundled slash-command .md's into the runtime commands dir, mirroring install.sh
 * exactly: target `<commandsDir>/<name>.md`; `mkdir -p` the parent; if the target is already a symlink
 * resolving to the correct bundle source leave it (idempotent — count "already"); if it is a symlink
 * pointing elsewhere re-point it (count "linked"); if it is a REAL non-symlink file/dir DIE (throw a
 * DriverError — NEVER clobber, mirrors install.sh L73); otherwise create an absolute symlink → the
 * bundle source (count "linked"). The command sources are read from the BUNDLE (T-17-02-REPOSOURCE).
 *
 * @param {object} args
 * @param {string} args.bundleDir   the bundle root whose commands/ dir is the source of truth.
 * @param {string} args.commandsDir the runtime commands dir (claudeCommandsDir()).
 * @returns {{linked:number, already:number, names:string[]}}
 */
function deliverBundledCommands(args = {}) {
  const { bundleDir, commandsDir } = args;
  if (typeof bundleDir !== 'string' || typeof commandsDir !== 'string') {
    throw new DriverError('deliverBundledCommands requires { bundleDir, commandsDir } string paths');
  }
  const names = bundledCommandNames(bundleDir);
  fs.mkdirSync(commandsDir, { recursive: true });
  let linked = 0;
  let already = 0;
  for (const name of names) {
    const absSource = path.join(bundleDir, 'commands', name);
    const target = path.join(commandsDir, name);
    let st = null;
    try {
      st = fs.lstatSync(target);
    } catch (_) {
      st = null; // absent
    }
    if (st && st.isSymbolicLink()) {
      // Already a symlink. Leave it iff it resolves to the correct bundle source (idempotent).
      let current = '';
      try {
        current = fs.readlinkSync(target);
      } catch (_) {
        current = '';
      }
      if (current === absSource) {
        already += 1;
        continue;
      }
      // Symlink points elsewhere — re-point it (safe: replacing a symlink, not real data).
      fs.rmSync(target, { force: true });
      fs.symlinkSync(absSource, target);
      linked += 1;
      continue;
    }
    if (st) {
      // Exists and is NOT a symlink: a REAL file/dir. Fail-safe — never clobber (T-17-02-CLOBBER,
      // mirrors install.sh L73 `die "refusing to overwrite real file"`).
      throw new DriverError(
        'refusing to overwrite real file at ' + target + ' (not a symlink into our bundle) — command ' +
          'delivery NEVER clobbers a real file; move it aside and re-run (mirrors install.sh L73 fail-safe)'
      );
    }
    // Missing — create the symlink with an absolute target.
    fs.symlinkSync(absSource, target);
    linked += 1;
  }
  return { linked, already, names };
}

/**
 * RECLAIM exactly the delivered command links: for each bundled command name, if the target is a
 * SYMLINK whose resolved target is the bundle source (points INTO our bundle commands/ dir), unlink it
 * (count "removed"); if absent, no-op; if it is a REAL non-symlink file OR a symlink pointing ELSEWHERE
 * (not into our bundle), LEAVE it untouched (T-17-02-OVERREMOVE: only reclaim links into our bundle —
 * never touch an unrelated file or a foreign symlink). Used by remove (accountable via the receipt).
 *
 * @param {object} args
 * @param {string} args.bundleDir   the bundle root (its commands/ dir is the ownership boundary).
 * @param {string} args.commandsDir the runtime commands dir.
 * @returns {{removed:number, names:string[]}}
 */
function removeBundledCommands(args = {}) {
  const { bundleDir, commandsDir } = args;
  if (typeof bundleDir !== 'string' || typeof commandsDir !== 'string') {
    throw new DriverError('removeBundledCommands requires { bundleDir, commandsDir } string paths');
  }
  let names;
  try {
    names = bundledCommandNames(bundleDir);
  } catch (_) {
    // A missing bundle commands/ dir at remove time means there is nothing we own to reclaim — a
    // remove must never throw on a vanished bundle (the links it owns, if any, dangle harmlessly).
    return { removed: 0, names: [] };
  }
  let removed = 0;
  for (const name of names) {
    const absSource = path.join(bundleDir, 'commands', name);
    const target = path.join(commandsDir, name);
    let st = null;
    try {
      st = fs.lstatSync(target);
    } catch (_) {
      continue; // absent — nothing to reclaim
    }
    if (!st.isSymbolicLink()) {
      continue; // a REAL file — never remove an unrelated file (T-17-02-OVERREMOVE)
    }
    let current = '';
    try {
      current = fs.readlinkSync(target);
    } catch (_) {
      current = '';
    }
    if (current !== absSource) {
      continue; // a FOREIGN symlink (not into our bundle) — leave it untouched (T-17-02-OVERREMOVE)
    }
    fs.rmSync(target, { force: true });
    removed += 1;
  }
  return { removed, names };
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
 * @returns {{ liveRoot:string, lifecycle:object, consent:object, ledger:object, trust:object, config:object, CAP_MARKER:string }}
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
  // CR-02: capability-source is NOT loaded — the driver composes the shared-edit/ledger/consent seams
  // and applies the shared edits DIRECTLY from the in-repo bundle dir (see ENTRYPOINT SPIKE note,
  // "apply directly from the in-repo bundle dir … both keep the engine LIVE"). It never calls
  // resolveCapabilitySource, so loading + returning `source` only created a DECEPTIVE LOUD-on-miss
  // guarantee (a renamed/absent capability-source.cjs would pass the shape-check with zero entries).
  // Loading nothing it does not use keeps the required[] shape-check an honest map of the real surface.
  const ledger = load(LIVE_LEDGER_REL, 'ledger');
  const trust = load(LIVE_TRUST_REL, 'trust');
  const config = load(LIVE_CONFIG_REL, 'config');

  // Shape check: every LIVE function the driver composes must be present (a gsd-core rename surfaces
  // here as a LOUD fail, never a silent false-success — T-12-01-REIMPL / T-12-02-REIMPL).
  const required = [
    [lifecycle, 'applyCapabilitySharedEdits'],
    [lifecycle, 'stripCapabilitySharedEdits'],
    [lifecycle, 'removeCapability'],
    [lifecycle, 'confinedSharedFile'],
    [consent, 'bundleContentHash'],
    [consent, 'recordProjectConsent'],
    [consent, 'revokeProjectConsent'],
    [consent, 'readConsentStore'],
    [consent, 'consentStorePath'],
    [ledger, 'recordInstall'],
    [ledger, 'readLedger'],
    [trust, 'signatureForManifest'],
    [config, 'setConfigValue'],
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

  return { liveRoot, lifecycle, consent, ledger, trust, config, CAP_MARKER };
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
 * Drive the LIVE engine (composed seams — the spike's chosen path B) to install contribution-toolkit against
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

  // (5) DELIVER the bundled slash-commands into the runtime commands dir (mirrors install.sh) — AFTER
  // the LIVE consent/ledger/shared-edit install. Commands are AVAILABILITY (delivered by install,
  // reclaimed by remove), NOT enforcement: this is purely additive after the existing install steps
  // and does not touch the manifest, the gates, the consent/ledger flow, or the on/off flag. SOURCED
  // FROM THE BUNDLE (T-17-02-REPOSOURCE), with install.sh's never-clobber-a-real-file fail-safe.
  const commandsDir = claudeCommandsDir(opts);
  const delivered = deliverBundledCommands({ bundleDir, commandsDir });
  lines.push('[install] delivered ' + delivered.names.length + ' slash-command(s) to ' + commandsDir +
    ' (' + delivered.linked + ' linked, ' + delivered.already + ' already correct)');

  // The on/off flip of workflow.gsd_contrib_enforcement is OWNED by Plan 12-02; install leaves the
  // config default (OFF) so the advisory surface is the explicit opt-in 12-02 toggles.
  lines.push('[install] done — re-run is idempotent (LIVE apply strips its own marker first)');
  return { lines, applied, reconciled, delivered };
}

// ---------------------------------------------------------------------------
// off/remove accountability receipt (REUSE hooks/lib/override.cjs — EP-5)
// ---------------------------------------------------------------------------

/**
 * Require a non-empty accountability reason for off/remove. A disable MUST carry a real reason
 * (mirrors override.cjs empty-reason rejection) — a missing/whitespace reason throws a DriverError so
 * the operation FAILS LOUD before any state mutation, never proceeding un-accountable.
 *
 * @param {object} opts the run opts (reads opts.reason).
 * @param {string} action 'off' | 'remove' (named in the error).
 * @returns {string} the trimmed, non-empty reason.
 */
function requireReason(opts, action) {
  const raw = opts && opts.reason;
  const reason = typeof raw === 'string' ? raw.trim() : '';
  if (reason.length === 0) {
    throw new DriverError(
      action + ' requires a non-empty --reason "<why>": disabling the contrib guard is a deliberate, ' +
        'accountable act and is RECORDED in an append-only receipt — a disable without a real reason is ' +
        'rejected (mirrors the GSD_CONTRIB_OVERRIDE empty-reason rejection; no silent un-logged disable)'
    );
  }
  return reason;
}

/**
 * Probe that the per-project-root accountability receipt is APPEND-WRITABLE before any state mutation
 * (CR-01 / T-12-02-SKIPRECEIPT). The accountability honesty ethos requires that a disable which cannot
 * be LOGGED must FAIL before — not after — the gates are stripped or the enforcement flag is flipped.
 * The check is a real append-mode open (O_CREAT|O_APPEND) of the receipt file (mkdir the dir first):
 * this exercises the SAME write path writeReceipt uses (fs.appendFileSync O_APPEND), so an ENOSPC /
 * EACCES / EROFS that would later sink writeReceipt is caught HERE, with zero state mutated. Opening
 * for append (then immediately closing) writes no bytes — the real record is appended later by
 * writeAccountabilityReceipt. On any failure, throws a DriverError and the caller aborts before
 * touching settings.json / config.json / the ledger.
 *
 * @param {object} args
 * @param {string} args.liveRoot resolved gsd-core root.
 * @param {string} args.action   'off' | 'remove' (named in the error).
 * @returns {string} the canonical projectRoot the receipt is keyed to (reused by the later write).
 */
function probeReceiptWritable(args) {
  const { liveRoot, action } = args;
  let projectRoot;
  try {
    projectRoot = fs.realpathSync(liveRoot);
  } catch (_) {
    projectRoot = liveRoot;
  }
  const receiptFile = receiptPathFor(projectRoot);
  try {
    fs.mkdirSync(path.dirname(receiptFile), { recursive: true });
    // Append-mode open (O_CREAT|O_APPEND), write nothing, close — proves writeReceipt can append.
    const fd = fs.openSync(receiptFile, 'a');
    fs.closeSync(fd);
  } catch (probeErr) {
    throw new DriverError(
      'cannot write the ' + action + ' accountability receipt at ' + receiptFile + ' (' +
        (probeErr && probeErr.message) + ') — operation ABORTED before any state mutation: a disable ' +
        'that cannot be LOGGED must FAIL rather than strip the gates un-recorded ' +
        '(CR-01 / T-12-02-SKIPRECEIPT / override.cjs EP-5)'
    );
  }
  return projectRoot;
}

/**
 * Append a per-project-root, append-only accountability receipt for an off/remove, REUSING the
 * hooks/lib/override.cjs writeReceipt pattern (fs.appendFileSync O_APPEND — never read-modify-write,
 * never a shared global receipt; T-12-02-RACE). The receipt is keyed to realpath(gsd-core) so two
 * sessions sharing one checkout each append without clobbering. An un-writable receipt FAILS the
 * operation (DriverError) rather than letting the disable proceed un-logged (T-12-02-SKIPRECEIPT/EP-5).
 *
 * Record: { ts (ISO), action ('off'|'remove'), projectRoot (realpath gsd-core), reason }.
 *
 * @param {object} args
 * @param {string} args.liveRoot resolved gsd-core root.
 * @param {string} args.action   'off' | 'remove'.
 * @param {string} args.reason   non-empty accountability reason (already validated).
 * @returns {string} the receipt file path written.
 */
function writeAccountabilityReceipt(args) {
  const { liveRoot, action, reason } = args;
  // realpath the project root so the per-project-root key is canonical (a symlinked checkout keys to
  // the same receipt as its real path — never two divergent receipts for one tree).
  let projectRoot;
  try {
    projectRoot = fs.realpathSync(liveRoot);
  } catch (_) {
    projectRoot = liveRoot;
  }
  try {
    return writeReceipt(projectRoot, { action, reason, projectRoot });
  } catch (err) {
    throw new DriverError(
      'could not write the ' + action + ' accountability receipt at ' + receiptPathFor(projectRoot) +
        ' (' + (err && err.message) + ') — a disable that cannot be LOGGED must FAIL rather than ' +
        'proceed un-recorded (T-12-02-SKIPRECEIPT / override.cjs EP-5)'
    );
  }
}

// ---------------------------------------------------------------------------
// on / off — toggle the marker-tagged gates + the advisory enforcement flag
// ---------------------------------------------------------------------------

/**
 * Read the strip-target sharedEdits the LIVE ledger recorded for contribution-toolkit at install. `off` strips
 * exactly what install recorded (never a hand-built list), so the LIVE stripCapabilitySharedEdits
 * filters on CAP_MARKER===capId against the install-recorded targets. Falls back to the one known
 * settings target when the ledger entry omits sharedEdits (older install), so off still works.
 *
 * @param {object} ledger LIVE ledger module
 * @param {string} liveRoot resolved gsd-core root
 * @returns {Array<{file:string, marker?:string}>}
 */
function ledgerSharedEdits(ledger, liveRoot) {
  let entry = null;
  try {
    const led = ledger.readLedger(liveRoot);
    entry = led && led.entries && Object.prototype.hasOwnProperty.call(led.entries, CAP_ID)
      ? led.entries[CAP_ID]
      : null;
  } catch (_) {
    entry = null;
  }
  const recorded = entry && Array.isArray(entry.sharedEdits) ? entry.sharedEdits : null;
  if (recorded && recorded.length > 0) return recorded;
  // Fallback: the one settings file install always tags (keeps off working on a thin ledger entry).
  return [{ file: SHARED_SETTINGS_REL, marker: CAP_ID }];
}

/**
 * `on` — (re)apply EXACTLY the CAP_MARKER-tagged contrib gates via the LIVE apply engine, and flip the
 * advisory `workflow.gsd_contrib_enforcement` flag to true via the LIVE config setter. Mirrors the
 * install strip→apply idempotency pair (both halves LIVE) so a re-`on` is byte-stable.
 *
 * Honesty (HARD): on enables the gates; this driver NEVER labels the capability itself "unbypassable".
 *
 * @param {object} [opts] injectable seams (liveRoot/requireLiveScript/bundleDir/manifestPath).
 * @returns {{lines:string[], applied:number, enforcement:boolean}}
 */
function runOn(opts = {}) {
  const engine = loadLiveEngine(opts);
  const { liveRoot, lifecycle, config, CAP_MARKER } = engine;
  const bundleDir = opts.bundleDir || BUNDLE_CAP_DIR;
  const manifestPath = opts.manifestPath || path.join(bundleDir, 'capability.json');
  const manifest = readManifest(manifestPath);

  const lines = [];
  lines.push('[on] gsd-core checkout: ' + liveRoot);

  // Strip→apply (the LIVE engine's own reapply discipline) so on re-applies EXACTLY one marker-tagged
  // set — no growth on a re-run, and untagged/other-capability hooks are never touched (CAP_MARKER scope).
  lifecycle.stripCapabilitySharedEdits({
    runtimeDir: liveRoot,
    capId: CAP_ID,
    sharedEdits: ledgerSharedEdits(engine.ledger, liveRoot),
  });
  const sharedEdits = lifecycle.applyCapabilitySharedEdits({
    runtimeDir: liveRoot,
    capId: CAP_ID,
    manifest,
    sharedFiles: [SHARED_SETTINGS_REL],
  });
  const applied = Array.isArray(sharedEdits) ? sharedEdits.length : 0;
  lines.push('[on] applied the CAP_MARKER (' + CAP_MARKER + ')-tagged contrib gates across ' + applied + ' file(s)');

  // Flip the advisory surface ON via the LIVE config setter (writes <liveRoot>/.planning/config.json).
  config.setConfigValue(liveRoot, ENFORCEMENT_FLAG, true);
  lines.push('[on] set ' + ENFORCEMENT_FLAG + '=true (advisory contribution enabled)');
  lines.push('[on] done — the installed PreToolUse gates are now live; the loop advisory is enabled');
  return { lines, applied, enforcement: true };
}

/**
 * `off` — strip EXACTLY the CAP_MARKER-tagged contrib gates via the LIVE strip engine (untagged
 * pre-existing hooks and other capabilities' gates survive — it filters on CAP_MARKER===capId), flip
 * `workflow.gsd_contrib_enforcement` to false, AND append a logged accountability receipt (Task 2):
 * a disable is a deliberate, recorded act — never silent. An empty reason or an un-writable receipt
 * FAILS the operation rather than proceeding un-logged (mirrors override.cjs EP-5).
 *
 * Honesty (HARD): off GENUINELY removes the gates from settings.json — toggle-off removes the
 * enforcement; this driver NEVER labels the capability itself "unbypassable".
 *
 * @param {object} [opts] injectable seams + `reason` (required non-empty accountability reason).
 * @returns {{lines:string[], stripped:number, enforcement:boolean, receiptPath:string}}
 */
function runOff(opts = {}) {
  const engine = loadLiveEngine(opts);
  const { liveRoot, lifecycle, config, CAP_MARKER } = engine;

  // Accountability gate FIRST: reject an empty/whitespace reason BEFORE mutating anything, so a
  // disable that cannot be logged never half-removes the enforcement (T-12-02-SKIPRECEIPT).
  const reason = requireReason(opts, 'off');
  // CR-01: PROVE the receipt is append-writable BEFORE stripping the gates / flipping the flag — a
  // disable that cannot be LOGGED must FAIL with zero state mutated, not strip-then-fail-to-record.
  probeReceiptWritable({ liveRoot, action: 'off' });

  const lines = [];
  lines.push('[off] gsd-core checkout: ' + liveRoot);

  const result = lifecycle.stripCapabilitySharedEdits({
    runtimeDir: liveRoot,
    capId: CAP_ID,
    sharedEdits: ledgerSharedEdits(engine.ledger, liveRoot),
  });
  const stripped = countStripped(result);
  lines.push('[off] stripped the CAP_MARKER (' + CAP_MARKER + ')-tagged contrib gates: ' + stripped +
    ' entr' + (stripped === 1 ? 'y' : 'ies') + ' (untagged hooks survive)');

  // Flip the advisory surface OFF via the LIVE config setter — off genuinely removes the enforcement.
  config.setConfigValue(liveRoot, ENFORCEMENT_FLAG, false);
  lines.push('[off] set ' + ENFORCEMENT_FLAG + '=false (advisory contribution disabled)');

  // Accountability receipt (append-only, per-project-root) — an un-writable receipt FAILS off.
  const receiptPath = writeAccountabilityReceipt({ liveRoot, action: 'off', reason });
  lines.push('[off] logged accountability receipt: ' + receiptPath);
  lines.push('[off] done — toggle-off removed the contrib gates from settings.json');
  return { lines, stripped, enforcement: false, receiptPath };
}

/**
 * Count entries stripped by LIVE stripCapabilitySharedEdits across its result shape (it returns a
 * per-file record array; sum each record's stripped count, tolerating either a number or an array).
 * @param {*} result
 * @returns {number}
 */
function countStripped(result) {
  if (typeof result === 'number') return result;
  if (!Array.isArray(result)) return 0;
  let total = 0;
  for (const r of result) {
    if (typeof r === 'number') { total += r; continue; }
    if (r && typeof r.stripped === 'number') { total += r.stripped; continue; }
    if (r && Array.isArray(r.removed)) { total += r.removed.length; continue; }
    // WR-03: do NOT count opaque objects. An element lacking a `stripped` number or a `removed` array
    // carries no strip count (it may be metadata or a no-op record) — an unrecognized shape counts as
    // 0, not 1, so the log line never overcounts a no-op as a stripped entry.
  }
  return total;
}

// ---------------------------------------------------------------------------
// remove — LIVE removeCapability (strip + ledger) + revoke consent + receipt
// ---------------------------------------------------------------------------

/**
 * `remove` — drive the LIVE removeCapability(id, {runtimeDir, removeData, consentStoreDir, scope}) to
 * strip the capability-owned shared edits + delete the ledger-owned files + drop the ledger entry, and
 * revoke the project consent record (the LIVE removeCapability revokes consent internally when a
 * consentStoreDir + project scope are supplied; we ALSO call LIVE revokeProjectConsent keyed to the
 * SAME projectRoot install bound, so a divergent findProjectRoot resolution can never leave an orphan
 * consent record — T-12-02-ORPHAN). Then append the off/remove accountability receipt.
 *
 * Accountability (T-12-02-SKIPRECEIPT): remove requires a non-empty --reason and writes the same
 * per-project-root, append-only receipt off does; an empty reason or an un-writable receipt FAILS the
 * operation. The reason gate runs BEFORE any mutation.
 *
 * Honesty (HARD): never labels the capability itself "unbypassable".
 *
 * @param {object} [opts] injectable seams + `reason` (required) + optional removeData.
 * @returns {{lines:string[], status:string, strippedEdits:number, consentRevoked:boolean, receiptPath:string}}
 */
function runRemove(opts = {}) {
  const engine = loadLiveEngine(opts);
  const { liveRoot, lifecycle, consent } = engine;
  const consentHome = opts.consentHome || consentStoreHome();

  // Accountability gate FIRST — reject an empty reason before any LIVE mutation.
  const reason = requireReason(opts, 'remove');
  // CR-01: PROVE the receipt is append-writable BEFORE removeCapability strips edits / drops the
  // ledger entry — a remove that cannot be LOGGED must FAIL with zero state mutated.
  probeReceiptWritable({ liveRoot, action: 'remove' });
  // removeData defaults FALSE (preserve any CAPABILITY_DATA) unless explicitly requested.
  const removeData = opts.removeData === true;

  const lines = [];
  lines.push('[remove] gsd-core checkout: ' + liveRoot);

  // (1) LIVE removeCapability: strip shared edits + delete ledger-owned files + drop the ledger entry,
  // and (with consentStoreDir + project scope) revoke the bound consent record internally.
  const result = lifecycle.removeCapability(CAP_ID, {
    runtimeDir: liveRoot,
    removeData,
    consentStoreDir: consentHome,
    scope: 'project',
  });
  const status = (result && result.status) || 'unknown';
  // WR-01: fail on ANY non-success status, not only 'blocked'. The LIVE removeCapability success
  // statuses are 'removed' (capability-lifecycle.cjs ~L1140) and 'not_installed' (~L1067, already
  // clean). 'blocked'/'aborted'/'unknown' (the 'unknown' fallback when result is null/has no status)
  // or any unexpected value means the remove did NOT fully complete — never report it as success
  // (LOUD-on-miss: an op that did not run to completion is never reported as success).
  const REMOVE_SUCCESS = new Set(['removed', 'not_installed']);
  if (!REMOVE_SUCCESS.has(status)) {
    throw new DriverError(
      'LIVE removeCapability returned non-success status "' + status + '": ' +
        (((result && result.blockReasons) || []).join('; ') || 'no reason given') +
        ' — remove did not fully complete; fix and retry (an op that could not run is never reported ' +
        'as success — LOUD-on-miss)'
    );
  }
  const strippedEdits = Array.isArray(result && result.strippedEdits)
    ? countStripped(result.strippedEdits)
    : countStripped(result && result.strippedEdits);
  lines.push('[remove] LIVE removeCapability status=' + status + ' (strippedEdits=' + strippedEdits +
    ', removedFiles=' + ((result && result.removedFiles && result.removedFiles.length) || 0) + ')');

  // (2) Belt-and-suspenders: explicitly revoke the project consent keyed to the SAME projectRoot
  // install bound (liveRoot), so a divergent findProjectRoot resolution inside removeCapability can
  // never leave the install-bound record behind (T-12-02-ORPHAN). revokeProjectConsent is idempotent
  // (absent record => no-op).
  let consentRevoked = false;
  try {
    consent.revokeProjectConsent({ gsdHome: consentHome, projectRoot: liveRoot, id: CAP_ID });
    consentRevoked = true;
  } catch (err) {
    // A consent-lock failure must be surfaced, never silently swallowed (mirrors LIVE #1459) — but the
    // ledger removal already succeeded, so this is a LOUD warning line, not a hard fail of remove.
    lines.push('[remove] WARNING: could not revoke project consent: ' + (err && err.message) +
      ' — the consent record may be STALE; clear it manually (gsd capability trust revoke ' + CAP_ID + ')');
  }
  if (consentRevoked) {
    lines.push('[remove] revoked project consent for ' + CAP_ID + ' (ledger + consent cleaned)');
  }
  if (result && result.consentRevokeFailed) {
    lines.push('[remove] note: LIVE removeCapability also reported a consent-revoke warning: ' +
      (result.consentRevokeWarning || ''));
  }

  // (3) RECLAIM exactly the delivered slash-command links (only links into our bundle — never a real
  // file or a foreign symlink; T-17-02-OVERREMOVE). This runs BEFORE the final receipt write so the
  // reclaim is covered by the SAME logged accountability receipt (the receipt's action='remove'
  // already accounts for the whole remove; the reclaimed-command count is in the log lines). off does
  // NOT touch the command links — only remove (and an uninstall) reclaims them.
  const bundleDir = opts.bundleDir || BUNDLE_CAP_DIR;
  const commandsDir = claudeCommandsDir(opts);
  const reclaimed = removeBundledCommands({ bundleDir, commandsDir });
  lines.push('[remove] reclaimed ' + reclaimed.removed + ' delivered slash-command link(s) from ' +
    commandsDir + ' (only links into our bundle; real files + foreign symlinks left untouched)');

  // (4) Accountability receipt (append-only, per-project-root) — an un-writable receipt FAILS remove.
  const receiptPath = writeAccountabilityReceipt({ liveRoot, action: 'remove', reason });
  lines.push('[remove] logged accountability receipt: ' + receiptPath);
  lines.push('[remove] done — contribution-toolkit removed from the ledger; the gates left settings.json');
  return { lines, status, strippedEdits, consentRevoked, reclaimed, receiptPath };
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
    lines.push('[status] ledger: contribution-toolkit INSTALLED (version ' +
      (ledgerEntry.version || '?') + ', source ' + (ledgerEntry.source || '?') + ')');
  } else {
    lines.push('[status] ledger: contribution-toolkit NOT in ledger');
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
  lines.push('[status] consent: contribution-toolkit ' + (consented ? 'CONSENTED' : 'no project consent record'));

  // Live gates currently in settings.json (CAP_MARKER-tagged, owned by contribution-toolkit).
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
    'contrib-capability — thin driver for the contribution-toolkit capability (drives the LIVE gsd-core engine)',
    '',
    '  node bin/contrib-capability.cjs install            stage + consent + ledger + marker-tag the 13 hooks',
    '  node bin/contrib-capability.cjs on                 (re)apply the tagged gates + enforcement flag on',
    '  node bin/contrib-capability.cjs off  --reason <w>  strip the tagged gates + flag off (+ logged receipt)',
    '  node bin/contrib-capability.cjs status             report ledger + consent + live gate set',
    '  node bin/contrib-capability.cjs remove --reason <w> remove from ledger + consent (+ logged receipt)',
    '',
    'off/remove require --reason "<why>": disabling the contrib guard is a deliberate, accountable act',
    'recorded in an append-only per-project-root receipt (.gsd-contrib/override-receipts.log).',
    'toggle-off GENUINELY removes the gates from settings.json — the gates are the enforcement.',
    '',
    'Exit codes: 0 ok, 1 LOUD-on-miss (unresolved checkout / missing LIVE export / op failed), 2 usage.',
  ].join('\n');
}

/**
 * Parse a non-option `--reason <value>` / `--reason=<value>` from the driver argv. Returns the raw
 * string (empty when absent); requireReason() enforces non-emptiness with the accountable message.
 * Plain process.argv parsing (the hooks/lib argv/flags helpers are command-string parsers, not
 * subcommand-flag parsers — consistent with the 12-01 driver decision).
 * @param {string[]} args argv after the subcommand.
 * @returns {string}
 */
function parseReason(args) {
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--reason') return args[i + 1] == null ? '' : String(args[i + 1]);
    if (typeof a === 'string' && a.startsWith('--reason=')) return a.slice('--reason='.length);
  }
  return '';
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

  const KNOWN = new Set(['install', 'on', 'off', 'status', 'remove']);
  if (!KNOWN.has(sub)) {
    process.stderr.write('contrib-capability: unknown subcommand "' + sub + '"\n\n' + usage() + '\n');
    return 2;
  }

  try {
    let out;
    if (sub === 'install') out = runInstall();
    else if (sub === 'on') out = runOn();
    else if (sub === 'off') out = runOff({ reason: parseReason(args.slice(1)) });
    else if (sub === 'remove') out = runRemove({ reason: parseReason(args.slice(1)) });
    else out = runStatus();
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
  LIVE_LEDGER_REL,
  LIVE_TRUST_REL,
  DriverError,
  resolveGsdCoreCwd,
  consentStoreHome,
  claudeCommandsDir,
  bundledCommandNames,
  deliverBundledCommands,
  removeBundledCommands,
  loadLiveEngine,
  readManifest,
  manifestHookBasenames,
  reconcileLegacyEntries,
  ledgerSharedEdits,
  countStripped,
  requireReason,
  writeAccountabilityReceipt,
  parseReason,
  ENFORCEMENT_FLAG,
  runInstall,
  runOn,
  runOff,
  runRemove,
  runStatus,
  runCli,
  liveRequireLiveScript,
  ScriptResolveError,
};
