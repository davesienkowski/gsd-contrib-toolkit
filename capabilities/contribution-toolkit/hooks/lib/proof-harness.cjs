'use strict';

/**
 * hooks/lib/proof-harness.cjs — the INTEGRATION-proof capture primitive (TEST-01 / TEST-02).
 *
 * The hermetic unit suite proves each gate's policy through an injectable seam; it does NOT
 * prove the real entrypoint's stdin->stdout->exit WIRING. This primitive does: it SPAWNS the
 * real `node hooks/<name>.cjs`, feeds crafted stdin, captures stdout/stderr/exit, and
 * classifies the emitted permissionDecision.
 *
 * THE LOAD-BEARING SECURITY INVARIANT (the whole reason this primitive exists):
 *   A hook that crashes (non-zero exit) or emits empty / unparseable / non-decision stdout is
 *   classified INCONCLUSIVE (conclusive:false) — it is NEVER coerced to 'allow'. Reading a
 *   crash as an allow would manufacture a FALSE proof that a broken gate "passes clean input".
 *   classifyDecision therefore defaults to NOTHING on any ambiguity, and only ever returns the
 *   literal 'deny'/'allow' for a parseable decision emitted on a clean (exit 0) run.
 *
 * This module READS the decision field the gates already emit (hookSpecificOutput.
 * permissionDecision, per hooks/lib/failclosed.cjs `emit`). It reimplements NO policy.
 *
 * @module hooks/lib/proof-harness
 */

const { spawnSync } = require('node:child_process');

/**
 * Classify a captured (stdout, exitStatus) pair into a proof decision.
 *
 * The crash-is-not-allow rule is the load-bearing property: a non-zero status is an
 * INCONCLUSIVE FAIL regardless of what landed on stdout. Only a parseable
 * hookSpecificOutput.permissionDecision of the literal 'deny'/'allow' on a clean exit is
 * conclusive. Anything else (empty, non-JSON, JSON without a decision, an unknown decision
 * value) is {decision:null, conclusive:false} — never defaulted to 'allow'.
 *
 * @param {string} rawStdout the hook's full stdout.
 * @param {number} status the hook's exit status (0 = clean, non-zero = crash).
 * @returns {{decision: ('deny'|'allow'|null), conclusive: boolean, reason: string}}
 */
function classifyDecision(rawStdout, status) {
  // RULE 1 — crash != allow. A non-zero (or non-numeric) exit is inconclusive, full stop.
  if (typeof status !== 'number' || status !== 0) {
    return {
      decision: null,
      conclusive: false,
      reason: `non-zero/!numeric exit status (${String(status)}) — inconclusive (crash is NOT an allow)`,
    };
  }

  // RULE 2 — empty stdout on a clean exit is inconclusive (a hook that emitted nothing did
  // not make a decision; we must NOT guess 'allow').
  const text = typeof rawStdout === 'string' ? rawStdout.trim() : '';
  if (text === '') {
    return { decision: null, conclusive: false, reason: 'empty stdout — no decision emitted' };
  }

  // RULE 3 — parse exactly one JSON line. The gates emit one trimmed JSON line then exit 0.
  // If multiple lines were printed, the decision is the LAST parseable JSON line (the emit
  // envelope is written last); but unparseable content is inconclusive, never 'allow'.
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch (_) {
    // Fall back: try the last non-empty line in case the hook printed leading noise.
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try {
        parsed = JSON.parse(lines[i]);
        break;
      } catch (_e) {
        parsed = null;
      }
    }
  }
  if (parsed === null || typeof parsed !== 'object') {
    return { decision: null, conclusive: false, reason: 'stdout did not parse to a JSON object' };
  }

  // RULE 4 — read the decision field. Only the literals 'deny'/'allow' are conclusive.
  const hso = parsed.hookSpecificOutput;
  const pd = hso && typeof hso === 'object' ? hso.permissionDecision : undefined;
  if (pd === 'deny' || pd === 'allow') {
    return { decision: pd, conclusive: true, reason: `parsed permissionDecision:${pd}` };
  }

  // Anything else (no permissionDecision, or an unknown value) — inconclusive, NEVER 'allow'.
  return {
    decision: null,
    conclusive: false,
    reason: 'no parseable permissionDecision (deny|allow) — inconclusive, not coerced to allow',
  };
}

/**
 * Spawn the REAL hook entrypoint and capture its decision.
 *
 * Adapts the execFileSync shape from bin/lint-ci-stamp.cjs to spawnSync + `input:` so we can
 * feed crafted stdin synchronously and capture stdout/stderr/status without the gate's exit
 * status throwing (spawnSync never throws on a non-zero exit — it returns it, which is exactly
 * what classifyDecision needs to enforce the crash-is-not-allow rule).
 *
 * @param {string} absHookPath absolute path to the hook entrypoint (`hooks/<name>.cjs`).
 * @param {Object} [opts]
 * @param {string} [opts.stdin] the crafted stdin payload (default '').
 * @param {string} [opts.cwd] cwd for the spawn — set to a gsd-core checkout for gates that
 *   resolve LIVE scripts (default process.cwd()).
 * @returns {{decision:('deny'|'allow'|null), conclusive:boolean, reason:string,
 *            rawStdout:string, rawStderr:string, status:(number|null), spawnError:(Error|null)}}
 */
function spawnHook(absHookPath, opts = {}) {
  const stdin = typeof opts.stdin === 'string' ? opts.stdin : '';
  const cwd = opts.cwd || process.cwd();

  const res = spawnSync(process.execPath, [absHookPath], {
    input: stdin,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd,
    env: process.env,
  });

  // A spawn-level failure (node itself could not start) is an INFRA crash — inconclusive.
  if (res.error) {
    return {
      decision: null,
      conclusive: false,
      reason: `spawn failed: ${res.error.message}`,
      rawStdout: res.stdout || '',
      rawStderr: res.stderr || '',
      status: typeof res.status === 'number' ? res.status : null,
      spawnError: res.error,
    };
  }

  const rawStdout = res.stdout || '';
  // A signalled death (res.signal set, status null) is a crash → classify with a non-zero
  // sentinel so the crash-is-not-allow rule fires.
  const status = typeof res.status === 'number' ? res.status : (res.signal ? 1 : null);
  const classified = classifyDecision(rawStdout, status);

  return {
    decision: classified.decision,
    conclusive: classified.conclusive,
    reason: classified.reason,
    rawStdout,
    rawStderr: res.stderr || '',
    status,
    spawnError: null,
  };
}

module.exports = { spawnHook, classifyDecision };
