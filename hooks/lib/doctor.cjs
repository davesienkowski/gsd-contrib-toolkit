'use strict';

/**
 * hooks/lib/doctor.cjs — the SHAPE-checking doctor (HARD-02 / red-team H-E).
 *
 * The whole anti-bypass thesis depends on the gates calling gsd-core's LIVE policy scripts
 * (hooks/lib/resolve.cjs). But those scripts are gsd-core INTERNAL — their exported-function
 * contracts are NOT a stable public API (Hyrum). trek-e can refactor `issue-version-gate`'s
 * return shape and our gate breaks → per HARD-01 it FAILS CLOSED → bricks every commit. An
 * existence-only doctor would not catch that: the file still exists, but its shape drifted.
 *
 * So the doctor asserts, for each referenced LIVE script, that its named export EXISTS, is a
 * FUNCTION, and returns its expected OUTPUT SHAPE on a known, deterministic fixture input —
 * NOT file presence alone. A drifted return shape is reported as a FAILURE, so a gsd-core
 * refactor surfaces as a loud doctor failure (fixable) instead of a silent fail-closed brick.
 *
 * The doctor is PURE w.r.t. gsd-core state: every fixtureInput is a pure input to a pure (or
 * read-only) export; the doctor never mutates the gsd-core checkout. runDoctor NEVER throws —
 * a missing/broken/drifted script is collected as a failing result so the CLI can print a full
 * report and exit nonzero, rather than aborting on the first problem.
 *
 * @module hooks/lib/doctor
 */

const { requireLiveScript } = require('./resolve.cjs');

/**
 * The EXACT verified contracts for every LIVE gsd-core script the toolkit calls. Each entry:
 *   - script:      path relative to the gsd-core root (what requireLiveScript loads)
 *   - exportName:  the function the toolkit invokes
 *   - fixtureInput: a deterministic argument list (spread into the export)
 *   - assertShape(result) -> boolean : the SHAPE contract on the return value
 *   - describe:    a human label for the report
 *
 * These shapes were verified against the live gsd-core checkout (2026-06-21/22):
 *   evaluateVersionGate({labels:['bug'], body:<no version>}) -> {action:'close', reason}
 *   classifyPrTarget('next','x')                             -> {decision:'allowed'}
 *   evaluatePrTemplate('', 'OWNER', [...])                   -> {valid:false, ...}
 *   scoreCandidates('t',[{number,title}],{})  (identical)    -> [{number,title,score:1}], len>=1
 */
const SHAPE_CHECKS = Object.freeze([
  Object.freeze({
    script: 'scripts/issue-version-gate.cjs',
    exportName: 'evaluateVersionGate',
    fixtureInput: [{ labels: ['bug'], body: 'something is broken; no version heading here' }],
    assertShape: (r) =>
      isObj(r) && (r.action === 'skip' || r.action === 'close'),
    describe: "evaluateVersionGate({labels,body}) -> {action:'skip'|'close', reason}",
  }),
  Object.freeze({
    script: 'scripts/pr-target-policy.cjs',
    exportName: 'classifyPrTarget',
    fixtureInput: ['next', 'x'],
    assertShape: (r) =>
      isObj(r) &&
      (r.decision === 'allowed' || r.decision === 'blocked' || r.decision === 'unusual'),
    describe: "classifyPrTarget(base,head) -> {decision:'allowed'|'blocked'|'unusual'}",
  }),
  Object.freeze({
    script: 'scripts/pr-template-policy.cjs',
    exportName: 'evaluatePrTemplate',
    fixtureInput: ['', 'OWNER', ['src/index.cts']],
    assertShape: (r) => isObj(r) && typeof r.valid === 'boolean',
    describe: 'evaluatePrTemplate(body,assoc,changed) -> {valid:boolean, action, ...}',
  }),
  Object.freeze({
    script: 'scripts/issue-dedupe.cjs',
    exportName: 'scoreCandidates',
    fixtureInput: [
      'My exact title',
      [{ number: 5, title: 'My exact title', body: '' }],
      {},
    ],
    assertShape: (r) =>
      Array.isArray(r) &&
      r.length >= 1 &&
      isObj(r[0]) &&
      typeof r[0].number === 'number' &&
      typeof r[0].score === 'number',
    describe: 'scoreCandidates(title,cands,opts) -> Array<{number,title,score}> (len>=1, score 1 on identical)',
  }),
]);

/**
 * @param {*} v
 * @returns {boolean} true for a plain (non-null, non-array) object.
 */
function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Run one shape check against a gsd-core root. Never throws — returns a structured result.
 *
 * @param {string} root absolute gsd-core root.
 * @param {Object} entry a SHAPE_CHECKS entry.
 * @returns {{script:string, exportName:string, ok:boolean, detail:string}}
 */
function checkOne(root, entry) {
  const base = { script: entry.script, exportName: entry.exportName };
  let mod;
  try {
    mod = requireLiveScript(root, entry.script);
  } catch (err) {
    // Missing file or require-time throw (ScriptResolveError or otherwise).
    return { ...base, ok: false, detail: 'could not load: ' + ((err && err.message) || String(err)) };
  }

  const fn = mod ? mod[entry.exportName] : undefined;
  if (typeof fn === 'undefined') {
    return { ...base, ok: false, detail: 'missing export `' + entry.exportName + '`' };
  }
  if (typeof fn !== 'function') {
    return {
      ...base,
      ok: false,
      detail: 'export `' + entry.exportName + '` is not a function (got ' + typeof fn + ')',
    };
  }

  let result;
  try {
    result = fn(...entry.fixtureInput);
  } catch (err) {
    return {
      ...base,
      ok: false,
      detail: 'export `' + entry.exportName + '` threw on the fixture input: ' + ((err && err.message) || String(err)),
    };
  }

  let shapeOk = false;
  try {
    shapeOk = entry.assertShape(result) === true;
  } catch (_) {
    shapeOk = false;
  }
  if (!shapeOk) {
    return {
      ...base,
      ok: false,
      detail:
        'RETURN SHAPE drift — `' + entry.exportName + '` no longer returns the expected ' +
        entry.describe + ' (got ' + safePreview(result) + ')',
    };
  }

  return { ...base, ok: true, detail: 'ok — ' + entry.describe };
}

/**
 * Run all SHAPE_CHECKS against a gsd-core root. Never throws.
 *
 * @param {string} root absolute gsd-core root (from resolveGsdCoreRoot).
 * @returns {{ok:boolean, results:Array<{script:string, exportName:string, ok:boolean, detail:string}>}}
 */
function runDoctor(root) {
  const results = SHAPE_CHECKS.map((entry) => checkOne(root, entry));
  const ok = results.every((r) => r.ok === true);
  return { ok, results };
}

/**
 * A short, safe preview of a value for a drift message.
 * @param {*} v
 * @returns {string}
 */
function safePreview(v) {
  try {
    const s = JSON.stringify(v);
    if (typeof s !== 'string') return String(v);
    return s.length > 120 ? s.slice(0, 120) + '…' : s;
  } catch (_) {
    return String(v);
  }
}

module.exports = {
  runDoctor,
  SHAPE_CHECKS,
  checkOne,
};
