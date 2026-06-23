#!/usr/bin/env node
'use strict';

/**
 * bin/verify-capability.cjs — the re-runnable SHARE-02 conformance check.
 *
 * Proves that `capabilities/contribution-toolkit/capability.json` (from 09-01) CONFORMS to the LIVE
 * gsd-core capability-registry schema by REUSING gen-capability-registry.cjs's EXPORTED
 * validators — it NEVER reimplements a single schema field rule (HARD-02 / D-06). A drifted or
 * renamed LIVE validator therefore surfaces as a LOUD [FAIL], not a stale-policy false green.
 *
 *   node bin/verify-capability.cjs    # run every check, print [PASS]/[FAIL]/[SKIP], exit by outcome
 *
 * Why the EXPORTED validators and NOT `gen-capability-registry.cjs --check`:
 *   The LIVE `--check` mode validates gsd-core's OWN `capabilities/` dir and diffs its committed
 *   `gsd-core/bin/lib/capability-registry.cjs`. It cannot see our in-repo manifest without copying
 *   it INTO gsd-core — which the privacy constraint forbids. So conformance is proven by calling
 *   the exported functions directly against our manifest file (read-only against the LIVE checkout).
 *
 * THE LOAD-BEARING INVARIANT (mirrors the doctor shape-self-test + verify-hooks discipline):
 *   a check that could NOT run is NEVER a silent "conformant". If the gsd-core root can't be
 *   resolved, or a named LIVE validator is missing/renamed (require throws / export not a function),
 *   the check emits a [FAIL] line and returns NONZERO — never exit 0. No forged green.
 *
 * Beyond schema conformance, this check enforces two SHARE-01 safety invariants:
 *   - SURFACE DISCLOSURE (anti-under-disclosure, T-09-02-UNDERDISCLOSE): the manifest's declared
 *     executable surface (skills[] + the commands named in the description) must MATCH what the
 *     toolkit actually ships under skills/ and commands/ — read from DISK, data-driven, never a
 *     hardcoded literal. An under-disclosed surface defeats the ADR-1244 D5 installer consent gate.
 *   - ENFORCEMENT HONESTY (anti-oversell, T-09-02-OVERSELL): the description must NOT bind THIS
 *     capability's self-subject to "unbypassable" / "PreToolUse". Those words may appear ONLY in the
 *     honest disclaiming sentence about the SEPARATE personal hooks. The check uses a tight regex
 *     anchored to a capability-self claim (documented at HONESTY_RE below), not a bare substring of
 *     "unbypassable"/"PreToolUse" (which legitimately appear in the honest disclaimer).
 *
 * No shell: pure require()/fs reads (carries the no-shell discipline of the hook layer).
 *
 * @module bin/verify-capability
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { requireLiveScript: liveRequireLiveScript, ScriptResolveError } = require('../hooks/lib/resolve.cjs');
// Plan 11-01's bundle staleness truth: the parity check REUSES this single source so verify-capability
// and `build-capability --check` can NEVER disagree about whether the bundle is fresh (design §4).
const { checkBundleFresh: liveCheckBundleFresh } = require('./build-capability.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const MANIFEST_PATH = path.join(REPO_ROOT, 'capabilities', 'contribution-toolkit', 'capability.json');
const BUNDLE_HOOKS_DIR = path.join(REPO_ROOT, 'capabilities', 'contribution-toolkit', 'hooks');
const SKILLS_DIR = path.join(REPO_ROOT, 'skills');
const COMMANDS_DIR = path.join(REPO_ROOT, 'commands');
const FOLDER_ID = 'contribution-toolkit';
const LIVE_SCRIPT_REL = 'scripts/gen-capability-registry.cjs';
// The bundled resolver whose presence + reachability proves reuse-LIVE survives bundling (design §10).
const BUNDLED_RESOLVER_REL = path.join('lib', 'resolve.cjs');

// The four LIVE exported validators this check REUSES (HARD-02: never reimplemented here).
const REQUIRED_VALIDATORS = [
  'validateCapability',
  'validateVersionEnvelope',
  'validateRuntimeCompat',
  'validateAgainstContract',
];

/**
 * ENFORCEMENT-HONESTY regex (T-09-02-OVERSELL). FAILS the check when the manifest description binds
 * the capability SELF-SUBJECT to a POSITIVELY-ASSERTED unbypassable / PreToolUse claim. Anchored to a
 * "this capability" subject so the HONEST disclaimer ("It does NOT and cannot reach the harness
 * tool-call boundary"; "The separate, personal Claude Code PreToolUse hooks remain the harness-wide
 * enforcement layer") does NOT trip it — those mention PreToolUse/unbypassable only about the SEPARATE
 * personal hooks.
 *
 * NEGATION-AWARE (WR-01): the OLD pattern /this capability\b[^.]*\b(unbypassable|pretooluse)/i fired on
 * mere CO-PRESENCE — so honest negating disclaimers such as "This capability adds no PreToolUse hooks"
 * or "This capability explicitly avoids unbypassable enforcement" were FALSE positives. The match is
 * now two-stage:
 *   1. require a POSITIVE asserting verb (is / acts as / provides / reaches / enforces / fires at)
 *      between the "this capability" subject and the unbypassable/PreToolUse claim, within one sentence.
 *   2. exclude an explicit negator ("no" / "not" / "never" / "avoids" / "does not" / "adds no") sitting
 *      between the subject and the claim — so "this capability is NOT unbypassable" still passes.
 * This stays CONSERVATIVE: a genuine oversell ("this capability is unbypassable", "this capability
 * fires at PreToolUse") is still caught; only honest in-sentence disclaimers are released.
 */
const HONESTY_OVERSELL_RE = [
  /this capability\b[^.]*\b(?:is|are|acts? as|provides?|reaches?|enforces?|fires? at|guarantees?)\b[^.]*\b(unbypassable|pretooluse)/i,
  /\bcapability is unbypassable\b/i,
];
// A negator that ACTUALLY NEGATES the enforcement predicate means the sentence is an honest
// disclaimer, not an oversell.
//
// WR-02: the OLD blanket pattern (negator anywhere via `[^.]*` between subject and claim) was
// EVADABLE — a negator attached to an UNRELATED predicate released a genuine oversell, e.g.
//   "This capability is not advisory, and is unbypassable."          (not negates "advisory", not the claim)
//   "This capability does not help you, but it is unbypassable."     (not negates "help", not the claim)
// both falsely passed. The negator must sit IMMEDIATELY BEFORE the asserting verb that carries the
// enforcement claim (i.e. it negates the SAME predicate), not merely co-occur in the sentence.
const HONESTY_NEGATOR_RE =
  /this capability\b[^.]*?\b(?:no|not|never|n't|avoids?|without|lacks?|cannot|can't|does\s+not|do\s+not|adds?\s+no|installs?\s+no)\b\s*\b(?:is|are|acts?(?:\s+as)?|provides?|reaches?|enforces?|fires?(?:\s+at)?|guarantees?|unbypassable|pretooluse)\b/i;

/**
 * True iff `text` POSITIVELY oversells THIS capability as unbypassable/PreToolUse-reaching. An honest
 * negating disclaimer (a negator that actually negates the enforcement predicate) is NOT an oversell.
 * @param {string} text
 * @returns {boolean}
 */
function isOversold(text) {
  const s = typeof text === 'string' ? text : '';
  // Pattern [1] (/\bcapability is unbypassable\b/) is an unconditional exact-phrase oversell — it is
  // NOT subject to negator disambiguation, so a genuine "capability is unbypassable" is always caught
  // even if an unrelated negator appears elsewhere in the sentence (WR-02 evasion fix).
  if (HONESTY_OVERSELL_RE[1].test(s)) return true;
  // Pattern [0] requires a positive asserting verb between subject and claim. Release it ONLY when a
  // negator actually negates the enforcement predicate (negator adjacent to the asserting verb/claim).
  if (HONESTY_OVERSELL_RE[0].test(s)) {
    if (HONESTY_NEGATOR_RE.test(s)) return false;
    return true;
  }
  return false;
}

// Back-compat export name (the test suite + module consumers reference HONESTY_RE).
const HONESTY_RE = HONESTY_OVERSELL_RE;

/**
 * Resolve a gsd-core checkout carrying the sentinel layout (scripts/ + gsd-core/bin/lib/) so the
 * LIVE validators can be require()d. Mirrors bin/verify-hooks.cjs resolveGsdCoreCwd: GSD_CORE_ROOT,
 * then ~/repos/gsd-core, then ~/gsd-core. Returns an absolute root, or null when none is reachable.
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
 * Read the toolkit's ACTUAL shipped skill set from disk: the immediate subdirectories of skillsDir
 * that contain a SKILL.md. Data-driven so adding an undisclosed skill fails the disclosure check.
 *
 * LOUD-on-miss (CR-01): an unreadable/missing skills dir is NOT the same as "read succeeded, zero
 * skills". Returning [] on a readdir error would let the caller compare [] vs an empty manifest.skills
 * and report a PASS for a check that COULD NOT RUN — a forged green, violating the load-bearing
 * invariant. So a readdir error returns {ok:false} and the caller turns it into a [FAIL], mirroring
 * the doctor / unresolved-liveRoot LOUD discipline already used in this file.
 *
 * @param {string} skillsDir
 * @returns {{ok:boolean, skills:string[], error?:string}} ok:false => the dir was unreadable/missing.
 */
function readShippedSkills(skillsDir) {
  let entries;
  try {
    entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  } catch (err) {
    return { ok: false, skills: [], error: (err && err.message) || String(err) };
  }
  const out = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    if (fs.existsSync(path.join(skillsDir, ent.name, 'SKILL.md'))) out.push(ent.name);
  }
  out.sort();
  return { ok: true, skills: out };
}

/**
 * Read the toolkit's ACTUAL shipped command set from disk: the basenames (sans .md) of
 * commandsDir/gsd-*.md files. Data-driven so adding an undisclosed command fails the check.
 *
 * LOUD-on-miss (CR-01): symmetric to readShippedSkills — an unreadable/missing commands dir returns
 * {ok:false} so the caller emits a [FAIL]. (Previously this returned [] on error, surviving only
 * because an empty command set unconditionally FAILs downstream; the intent is now explicit and robust.)
 *
 * @param {string} commandsDir
 * @returns {{ok:boolean, commands:string[], error?:string}} ok:false => the dir was unreadable/missing.
 */
function readShippedCommands(commandsDir) {
  let entries;
  try {
    entries = fs.readdirSync(commandsDir, { withFileTypes: true });
  } catch (err) {
    return { ok: false, commands: [], error: (err && err.message) || String(err) };
  }
  const out = [];
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    if (/^gsd-.*\.md$/.test(ent.name)) out.push(ent.name.replace(/\.md$/, ''));
  }
  out.sort();
  return { ok: true, commands: out };
}

/**
 * One verdict line.
 * @param {string} name
 * @param {'pass'|'fail'|'skip'} verdict
 * @param {string} detail
 * @returns {{name:string, verdict:string, detail:string}}
 */
function result(name, verdict, detail) {
  return { name, verdict, detail: detail || '' };
}

/**
 * Run the SHARE-02 conformance + SHARE-01 safety checks. All impure seams are injectable so the
 * test suite can drive it hermetically (never the real gsd-core).
 *
 * @param {object} [opts]
 * @param {string|null} [opts.liveRoot]            gsd-core root; default resolveGsdCoreCwd(); null => LOUD fail.
 * @param {Function}    [opts.requireLiveScript]   (root, rel) => module; default the resolve.cjs live one.
 * @param {string}      [opts.manifestPath]        path to capability.json; default MANIFEST_PATH.
 * @param {string}      [opts.skillsDir]           default SKILLS_DIR.
 * @param {string}      [opts.commandsDir]         default COMMANDS_DIR.
 * @param {string}      [opts.bundleHooksDir]      bundle hooks/ dir; default BUNDLE_HOOKS_DIR.
 * @param {Function}    [opts.checkBundleFresh]    () => {fresh, staleFiles, checked}; default the real one.
 * @returns {{ok:boolean, results:Array<{name,verdict,detail}>}}
 */
function runVerifyCapability(opts = {}) {
  const liveRoot = Object.prototype.hasOwnProperty.call(opts, 'liveRoot') ? opts.liveRoot : resolveGsdCoreCwd();
  const requireLiveScript = opts.requireLiveScript || liveRequireLiveScript;
  const manifestPath = opts.manifestPath || MANIFEST_PATH;
  const skillsDir = opts.skillsDir || SKILLS_DIR;
  const commandsDir = opts.commandsDir || COMMANDS_DIR;
  const bundleHooksDir = opts.bundleHooksDir || BUNDLE_HOOKS_DIR;
  const checkBundleFresh = opts.checkBundleFresh || liveCheckBundleFresh;

  const results = [];

  // ── LOUD-on-miss #1: no reachable gsd-core checkout → the check could not run. ──
  if (!liveRoot) {
    results.push(result(
      'live-checkout',
      'fail',
      'cannot locate gsd-core checkout (set GSD_CORE_ROOT) — SHARE-02 conformance requires the LIVE ' +
        'gen-capability-registry.cjs validators; a check that did not run is NEVER reported conformant'
    ));
    return { ok: false, results };
  }
  results.push(result('live-checkout', 'pass', 'gsd-core root resolved: ' + liveRoot));

  // ── LOUD-on-miss #2: load the LIVE validators; a missing/renamed export is a LOUD fail. ──
  let live;
  try {
    live = requireLiveScript(liveRoot, LIVE_SCRIPT_REL);
  } catch (err) {
    const isResolve = err instanceof ScriptResolveError || (err && err.name === 'ScriptResolveError');
    results.push(result(
      'live-validators-load',
      'fail',
      'could not load LIVE ' + LIVE_SCRIPT_REL + ' (' + (isResolve ? 'ScriptResolveError' : (err && err.name)) +
        ': ' + (err && err.message) + ') — HARD-02: do NOT reimplement the schema; the LIVE validators are ' +
        'the sole source of truth, so an unloadable LIVE script FAILS LOUD rather than falling back to a vendored copy'
    ));
    return { ok: false, results };
  }

  const missing = REQUIRED_VALIDATORS.filter((n) => typeof (live && live[n]) !== 'function');
  if (missing.length > 0) {
    results.push(result(
      'live-validators-shape',
      'fail',
      'LIVE validator(s) unavailable (renamed/removed in gsd-core): ' + missing.join(', ') +
        ' — HARD-02: this check REUSES the LIVE validators and reimplements no schema rule, so a missing ' +
        'export FAILS LOUD (a gsd-core refactor must surface here, never a silent false conformant)'
    ));
    return { ok: false, results };
  }
  results.push(result('live-validators-shape', 'pass', 'all ' + REQUIRED_VALIDATORS.length + ' LIVE validators present: ' + REQUIRED_VALIDATORS.join(', ')));

  // ── Read + parse the manifest (a parse error is a [FAIL]). ──
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    results.push(result('manifest-read', 'fail', 'cannot read/parse manifest ' + manifestPath + ': ' + (err && err.message)));
    return { ok: false, results };
  }
  results.push(result('manifest-read', 'pass', 'parsed ' + manifestPath));

  // ── Schema conformance via the LIVE exported validators (zero local schema rules — HARD-02). ──
  // `callLiveValidator` is a THUNK so the invocation happens INSIDE the try/catch (WR-02): a LIVE
  // validator that THROWS (bad arg shape, internal assertion, gsd-core API change) becomes a clean
  // [FAIL] line naming the validator — never an uncaught stack trace propagating through runCli().
  const checkErrors = (name, callLiveValidator, note) => {
    let errs;
    try {
      errs = callLiveValidator();
    } catch (err) {
      results.push(result(
        name,
        'fail',
        note + ' — LIVE validator THREW: ' + ((err && err.message) || String(err)) +
          ' (a thrown validator FAILS LOUD per HARD-02 — a crashing check is NEVER a silent conformant)'
      ));
      return;
    }
    const arr = Array.isArray(errs) ? errs : ['validator did not return an array (got ' + typeof errs + ')'];
    if (arr.length === 0) {
      results.push(result(name, 'pass', note));
    } else {
      results.push(result(name, 'fail', note + ' — LIVE validator errors: ' + arr.join('; ')));
    }
  };

  // validateCapability(cap, folderId) — folderId is the literal folder name 'contribution-toolkit'.
  checkErrors('validateCapability', () => live.validateCapability(manifest, FOLDER_ID), 'LIVE validateCapability(manifest, ' + JSON.stringify(FOLDER_ID) + ')');
  // validateVersionEnvelope(cap) — semver version + engines.gsd range (ADR-1244 D1).
  checkErrors('validateVersionEnvelope', () => live.validateVersionEnvelope(manifest), 'LIVE validateVersionEnvelope(manifest)');
  // validateRuntimeCompat(capId, runtimeCompat) — capId FIRST, runtimeCompat SECOND (per LIVE signature).
  checkErrors('validateRuntimeCompat', () => live.validateRuntimeCompat(FOLDER_ID, manifest.runtimeCompat), 'LIVE validateRuntimeCompat(' + JSON.stringify(FOLDER_ID) + ', manifest.runtimeCompat)');
  // validateAgainstContract(cap, capId) — contribution.into vs the loop-host contract + when refs a config key.
  checkErrors('validateAgainstContract', () => live.validateAgainstContract(manifest, FOLDER_ID), 'LIVE validateAgainstContract(manifest, ' + JSON.stringify(FOLDER_ID) + ')');

  // ── SHARE-01 surface disclosure (T-09-02-UNDERDISCLOSE): declared == shipped, data-driven from disk. ──
  // LOUD-on-miss (CR-01): if the skills dir can't be read at all, the disclosure check COULD NOT RUN —
  // never silently PASS it (that would forge a green when skills/ is missing/permission-denied AND
  // manifest.skills is empty).
  const skillsResult = readShippedSkills(skillsDir);
  if (!skillsResult.ok) {
    results.push(result(
      'surface-skills',
      'fail',
      'cannot read skills/ directory (' + skillsResult.error + ') — the surface-disclosure check COULD NOT ' +
        'RUN; a check that did not run is NEVER reported conformant (LOUD-on-miss)'
    ));
  } else {
    const shippedSkills = skillsResult.skills;
    const declaredSkills = Array.isArray(manifest.skills) ? manifest.skills.slice().sort() : [];
    const skillsUndisclosed = shippedSkills.filter((s) => !declaredSkills.includes(s));
    const skillsOverdeclared = declaredSkills.filter((s) => !shippedSkills.includes(s));
    if (skillsUndisclosed.length === 0 && skillsOverdeclared.length === 0) {
      results.push(result('surface-skills', 'pass', 'manifest.skills == shipped skills/: [' + shippedSkills.join(', ') + ']'));
    } else {
      const parts = [];
      if (skillsUndisclosed.length) parts.push('UNDER-discloses (shipped but not declared): ' + skillsUndisclosed.join(', '));
      if (skillsOverdeclared.length) parts.push('declares but does not ship: ' + skillsOverdeclared.join(', '));
      results.push(result(
        'surface-skills',
        'fail',
        'manifest skill surface != shipped skills/ — ' + parts.join(' | ') +
          ' — under-disclosure defeats the ADR-1244 D5 consent gate'
      ));
    }
  }

  const description = typeof manifest.description === 'string' ? manifest.description : '';
  const commandsResult = readShippedCommands(commandsDir);
  if (!commandsResult.ok) {
    results.push(result(
      'surface-commands',
      'fail',
      'cannot read commands/ directory (' + commandsResult.error + ') — the surface-disclosure check ' +
        'COULD NOT RUN; a check that did not run is NEVER reported conformant (LOUD-on-miss)'
    ));
  } else {
  const shippedCommands = commandsResult.commands;
  const commandsUndisclosed = shippedCommands.filter((c) => !description.includes(c));
  if (shippedCommands.length > 0 && commandsUndisclosed.length === 0) {
    results.push(result('surface-commands', 'pass', 'every shipped command named in description: [' + shippedCommands.join(', ') + ']'));
  } else if (shippedCommands.length === 0) {
    results.push(result('surface-commands', 'fail', 'no gsd-*.md commands found under ' + commandsDir + ' — expected the disclosed command set'));
  } else {
    results.push(result(
      'surface-commands',
      'fail',
      'manifest under-discloses executable surface: ' + commandsUndisclosed.join(', ') +
        ' — command(s) ship under commands/ but are not named in the description; defeats the ADR-1244 D5 consent gate'
    ));
  }
  }

  // ── SHARE-01 enforcement honesty (T-09-02-OVERSELL): no capability-self unbypassable/PreToolUse claim. ──
  const oversold = isOversold(description);
  if (oversold) {
    results.push(result(
      'honesty',
      'fail',
      'description binds THIS capability to an "unbypassable"/"PreToolUse" claim — the capability is advisory ' +
        'at loop points and does NOT reach the harness boundary; that property belongs only to the SEPARATE ' +
        'personal hooks. Re-state the disclaimer so it does not oversell the capability (T-09-02-OVERSELL)'
    ));
  } else {
    results.push(result('honesty', 'pass', 'description does not oversell — no capability-self unbypassable/PreToolUse claim'));
  }

  // ── CAP-02 #1: hooks[] manifest FILE PRESENCE (closes the schema↔disk gap). ──
  // The LIVE validateCapability check above already asserts the hooks[] SCHEMA + script-safety (rule
  // C4 / isSafeHookScriptPath) — we do NOT reimplement that (HARD-02). This TOOLKIT-OWNED check asserts
  // the schema-safe path actually points at a file shipped in OUR bundle: every manifest hooks[].script
  // must EXIST under bundleHooksDir. A declared-but-absent script FAILs LOUD (never a silent pass).
  const declaredHooks = Array.isArray(manifest.hooks) ? manifest.hooks : [];
  const missingHookFiles = [];
  for (const h of declaredHooks) {
    const script = h && typeof h.script === 'string' ? h.script : '';
    if (!script) {
      missingHookFiles.push('(hooks[] entry with no string script)');
      continue;
    }
    // The manifest script path is relative to the bundle ROOT (e.g. 'hooks/gh-edit.cjs'); the bundle
    // hooks/ dir is that 'hooks/' prefix, so strip a leading 'hooks/' to land inside bundleHooksDir.
    const rel = script.replace(/^hooks\//, '');
    const abs = path.join(bundleHooksDir, rel);
    let present = false;
    try {
      present = fs.statSync(abs).isFile();
    } catch (_) {
      present = false;
    }
    if (!present) missingHookFiles.push(script);
  }
  if (declaredHooks.length === 0) {
    // No hooks[] declared — nothing to assert presence for; the schema check governs whether an empty
    // hooks[] is legal. A clean PASS here (the disk-presence invariant is vacuously satisfied).
    results.push(result('hooks-manifest', 'pass', 'manifest declares no hooks[] — no bundle script files to assert'));
  } else if (missingHookFiles.length === 0) {
    results.push(result(
      'hooks-manifest',
      'pass',
      'every manifest hooks[].script file exists under the bundle (' + declaredHooks.length + ' script(s))'
    ));
  } else {
    results.push(result(
      'hooks-manifest',
      'fail',
      'manifest hooks[].script file(s) MISSING from the bundle ' + bundleHooksDir + ': ' +
        missingHookFiles.join(', ') +
        ' — a declared script with no bundle file is NEVER a silent conformant (schema says safe-path, ' +
        'parity says present-and-identical; this closes the schema↔disk gap)'
    ));
  }

  // ── CAP-02 #2: bundle⇄source PARITY via Plan 11-01's checkBundleFresh (single staleness truth). ──
  // REUSE checkBundleFresh() rather than re-deriving the byte comparison so verify-capability and
  // `build-capability --check` can never disagree (design §4). A stale/missing bundle file is a [FAIL]
  // naming the path — equivalent to `build-capability --check` exiting 1 (T-11-03-01 integrity guard).
  let parity;
  try {
    parity = checkBundleFresh();
  } catch (err) {
    results.push(result(
      'bundle-parity',
      'fail',
      'bundle-parity check COULD NOT RUN (checkBundleFresh threw: ' + ((err && err.message) || String(err)) +
        ') — a check that did not run is NEVER reported conformant (LOUD-on-miss)'
    ));
    parity = null;
  }
  if (parity) {
    if (parity.fresh) {
      results.push(result(
        'bundle-parity',
        'pass',
        'bundle byte-identical to canonical hooks/ source (' + parity.checked + ' file(s) checked, not stale)'
      ));
    } else {
      const stale = (Array.isArray(parity.staleFiles) ? parity.staleFiles : [])
        .map((s) => (s && s.path ? s.path + ' (' + (s.reason || 'stale') + ')' : String(s)))
        .join(', ');
      results.push(result(
        'bundle-parity',
        'fail',
        'bundle is STALE/forged vs canonical source: ' + stale +
          ' — run `node bin/build-capability.cjs` to regenerate (equivalent to build --check exiting 1; ' +
          'a stale or forged bundle is NEVER a silent conformant — T-11-03-01)'
      ));
    }
  }

  // ── CAP-02 #3: runtime LIVE-resolution — the bundled hooks still reach LIVE gsd-core at runtime. ──
  // The bundle ships its own hooks/lib/resolve.cjs (Plan 11-01). This check asserts (a) that bundled
  // resolver FILE exists AND (b) a LIVE gsd-core checkout is reachable (liveRoot resolved above), so the
  // bundled gates' sentinel walk would still call LIVE scripts — proving reuse-LIVE survives bundling
  // (design §10 / T-11-03-02). An absent resolver or an unreachable checkout FAILs LOUD. (liveRoot:null
  // already short-circuited at live-checkout above, so reaching here means liveRoot is non-null.)
  const bundledResolver = path.join(bundleHooksDir, BUNDLED_RESOLVER_REL);
  let resolverPresent = false;
  try {
    resolverPresent = fs.statSync(bundledResolver).isFile();
  } catch (_) {
    resolverPresent = false;
  }
  if (!resolverPresent) {
    results.push(result(
      'runtime-live-resolution',
      'fail',
      'bundled resolver MISSING: ' + bundledResolver +
        ' — without hooks/lib/resolve.cjs the bundled gates cannot sentinel-walk to a LIVE gsd-core ' +
        'checkout; reuse-LIVE is broken in the bundle (NEVER a silent pass — T-11-03-02)'
    ));
  } else if (!liveRoot) {
    // Defensive: liveRoot:null is already a live-checkout LOUD fail above; keep the invariant explicit.
    results.push(result(
      'runtime-live-resolution',
      'fail',
      'no reachable LIVE gsd-core checkout — the bundled gates could not call LIVE scripts at runtime (LOUD-on-miss)'
    ));
  } else {
    results.push(result(
      'runtime-live-resolution',
      'pass',
      'bundled resolver present (' + bundledResolver + ') and a LIVE gsd-core checkout is reachable (' +
        liveRoot + ') — reuse-LIVE survives bundling'
    ));
  }

  const ok = results.every((r) => r.verdict === 'pass');
  return { ok, results };
}

/**
 * CLI: run every check, print the verify-hooks-style header + per-check lines + a pass/fail summary,
 * return 0 iff every check passed.
 * @returns {number}
 */
function runCli() {
  const { ok, results } = runVerifyCapability();
  process.stdout.write('verify-capability — SHARE-02 conformance via the LIVE gen-capability-registry validators (HARD-02)\n');
  process.stdout.write('  manifest: ' + MANIFEST_PATH + '\n\n');
  let pass = 0;
  let fail = 0;
  for (const r of results) {
    const mark = r.verdict === 'pass' ? 'PASS' : r.verdict === 'skip' ? 'SKIP' : 'FAIL';
    if (r.verdict === 'pass') pass += 1;
    else fail += 1;
    process.stdout.write('  [' + mark + '] ' + r.name + '\n');
    if (r.verdict !== 'pass' || r.detail) process.stdout.write('         ' + r.detail + '\n');
  }
  process.stdout.write('\n');
  process.stdout.write(pass + ' pass, ' + fail + ' fail across ' + results.length + ' checks.\n');
  if (ok) {
    process.stdout.write('Capability manifest CONFORMS to LIVE registry schema (SHARE-02).\n');
  } else {
    process.stdout.write('VERIFY FAILED — a LIVE validator was unavailable or the manifest is nonconformant/under-disclosed/oversold. ' +
      'An unrunnable check is NEVER a silent conformant (LOUD-on-miss).\n');
  }
  return ok ? 0 : 1;
}

if (require.main === module) {
  try {
    process.exit(runCli());
  } catch (err) {
    process.stderr.write(
      '[FAIL] verify-capability — unexpected error: ' +
        (err && err.message ? err.message : String(err)) + '\n'
    );
    process.exit(1);
  }
}

module.exports = { runVerifyCapability, runCli, resolveGsdCoreCwd, readShippedSkills, readShippedCommands, HONESTY_RE, isOversold };
