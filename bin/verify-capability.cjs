#!/usr/bin/env node
'use strict';

/**
 * bin/verify-capability.cjs — the re-runnable SHARE-02 conformance check.
 *
 * Proves that `capabilities/contrib-gate/capability.json` (from 09-01) CONFORMS to the LIVE
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

const REPO_ROOT = path.resolve(__dirname, '..');
const MANIFEST_PATH = path.join(REPO_ROOT, 'capabilities', 'contrib-gate', 'capability.json');
const SKILLS_DIR = path.join(REPO_ROOT, 'skills');
const COMMANDS_DIR = path.join(REPO_ROOT, 'commands');
const FOLDER_ID = 'contrib-gate';
const LIVE_SCRIPT_REL = 'scripts/gen-capability-registry.cjs';

// The four LIVE exported validators this check REUSES (HARD-02: never reimplemented here).
const REQUIRED_VALIDATORS = [
  'validateCapability',
  'validateVersionEnvelope',
  'validateRuntimeCompat',
  'validateAgainstContract',
];

/**
 * ENFORCEMENT-HONESTY regex (T-09-02-OVERSELL). FAILS the check when the manifest description binds
 * the capability SELF-SUBJECT to an unbypassable / PreToolUse claim. Anchored to a "this capability"
 * subject so the HONEST disclaimer ("It does NOT and cannot reach the harness tool-call boundary";
 * "The separate, personal Claude Code PreToolUse hooks remain the harness-wide enforcement layer")
 * does NOT trip it — those mention PreToolUse/unbypassable only about the SEPARATE personal hooks.
 *   - /this capability\b[^.]*\b(unbypassable|pretooluse)/i  → "this capability ... unbypassable|PreToolUse"
 *     within a single sentence (no '.' between subject and claim).
 *   - /\bcapability is unbypassable\b/i                     → the bald "capability is unbypassable" claim.
 */
const HONESTY_RE = [
  /this capability\b[^.]*\b(unbypassable|pretooluse)/i,
  /\bcapability is unbypassable\b/i,
];

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
 * @returns {{ok:boolean, results:Array<{name,verdict,detail}>}}
 */
function runVerifyCapability(opts = {}) {
  const liveRoot = Object.prototype.hasOwnProperty.call(opts, 'liveRoot') ? opts.liveRoot : resolveGsdCoreCwd();
  const requireLiveScript = opts.requireLiveScript || liveRequireLiveScript;
  const manifestPath = opts.manifestPath || MANIFEST_PATH;
  const skillsDir = opts.skillsDir || SKILLS_DIR;
  const commandsDir = opts.commandsDir || COMMANDS_DIR;

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
  const checkErrors = (name, errs, note) => {
    const arr = Array.isArray(errs) ? errs : ['validator did not return an array (got ' + typeof errs + ')'];
    if (arr.length === 0) {
      results.push(result(name, 'pass', note));
    } else {
      results.push(result(name, 'fail', note + ' — LIVE validator errors: ' + arr.join('; ')));
    }
  };

  // validateCapability(cap, folderId) — folderId is the literal folder name 'contrib-gate'.
  checkErrors('validateCapability', live.validateCapability(manifest, FOLDER_ID), 'LIVE validateCapability(manifest, ' + JSON.stringify(FOLDER_ID) + ')');
  // validateVersionEnvelope(cap) — semver version + engines.gsd range (ADR-1244 D1).
  checkErrors('validateVersionEnvelope', live.validateVersionEnvelope(manifest), 'LIVE validateVersionEnvelope(manifest)');
  // validateRuntimeCompat(capId, runtimeCompat) — capId FIRST, runtimeCompat SECOND (per LIVE signature).
  checkErrors('validateRuntimeCompat', live.validateRuntimeCompat(FOLDER_ID, manifest.runtimeCompat), 'LIVE validateRuntimeCompat(' + JSON.stringify(FOLDER_ID) + ', manifest.runtimeCompat)');
  // validateAgainstContract(cap, capId) — contribution.into vs the loop-host contract + when refs a config key.
  checkErrors('validateAgainstContract', live.validateAgainstContract(manifest, FOLDER_ID), 'LIVE validateAgainstContract(manifest, ' + JSON.stringify(FOLDER_ID) + ')');

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
  const oversold = HONESTY_RE.some((re) => re.test(description));
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
  process.exit(runCli());
}

module.exports = { runVerifyCapability, runCli, resolveGsdCoreCwd, readShippedSkills, readShippedCommands, HONESTY_RE };
