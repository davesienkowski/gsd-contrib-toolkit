#!/usr/bin/env node
'use strict';

/**
 * hooks/scan-gate.cjs — PreToolUse(Bash) ENF-09 pre-push secret/injection/base64 gate.
 *
 * On a `git push`, this gate runs gsd-core's three LIVE scan scripts against the changes
 * about to be pushed and DENIES if any reports a hit, naming the offending scan + its
 * output tail. These scans run in CI today but are NOT enforced locally; this gate closes
 * that gap at the harness boundary. The three LIVE scripts — called, never reimplemented:
 *
 *   - scripts/secret-scan.sh           → committed-secret detection
 *   - scripts/prompt-injection-scan.sh → prompt-injection payloads in docs/markdown
 *   - scripts/base64-scan.sh           → suspicious base64 blobs
 *
 * SCOPE: the scan gate triggers ONLY on `git push`. `git commit`, `gh pr create`, and any
 * non-git command are no-op allows (the commit/pr filing concerns belong to the POLICY-02
 * and filing gates, not here). A non-push action is allowed WITHOUT running the scans.
 *
 * HARD-01: every path runs inside runGate, so a scan INFRA failure (script missing /
 * cannot spawn / exit 2 usage error) FAILS CLOSED (deny) — never silently treated as
 * clean — escapable only by a deliberate, logged GSD_CONTRIB_OVERRIDE receipt (HARD-03).
 * HARD-02: the scans are the LIVE gsd-core scripts, invoked via execFileSync('bash', …)
 * with NO shell and NO reimplemented detection regexes. HARD-04: the command is parsed via
 * the structured argv parser; an unparseable command throws → fail-closed deny.
 *
 * @module hooks/scan-gate
 */

const { parseCommand } = require('./lib/argv.cjs');
const { classifyAction } = require('./lib/classify.cjs');
const { runGate, readHookInput, deny, allow, emit, FailClosed, safeCommand } = require('./lib/failclosed.cjs');
const { resolveRootForCommand } = require('./lib/resolve.cjs');

// FailClosed/safeCommand: shared IN-03 helpers from failclosed.cjs.

/**
 * The three LIVE gsd-core scan scripts, each a shell script under scripts/. `script` is the
 * path relative to the gsd-core root (resolved + invoked via execFileSync('bash', …));
 * `describe` is the human label used in deny reasons. This table is the entire ENF-09 scan
 * surface — the gate REIMPLEMENTS none of their detection logic (HARD-02).
 */
const SCANS = Object.freeze([
  Object.freeze({ script: 'scripts/secret-scan.sh', describe: 'secret scan' }),
  Object.freeze({ script: 'scripts/prompt-injection-scan.sh', describe: 'prompt-injection scan' }),
  Object.freeze({ script: 'scripts/base64-scan.sh', describe: 'base64 scan' }),
]);

/** Actions that trigger the ENF-09 scans. Push only (not commit / pr-create). */
const TRIGGER_ACTIONS = new Set(['push']);

/** Default diff range scanned: the changes about to be pushed (HEAD's diff). */
const SCAN_DIFF_BASE = 'HEAD';

/** Max characters of a failed scan's output kept in the deny reason. */
const TAIL_LIMIT = 600;

/**
 * Run the SCANS as LIVE gsd-core shell scripts in the gsd-core worktree, with NO shell
 * (execFileSync of `bash <absScript> --diff HEAD` — an argv array, never a shell line).
 * Returns one result per scan. Exit 0 = clean; exit 1 = findings (ok:false, a real hit).
 * Exit 2 (usage error) OR a spawn/infra failure (bash missing / script missing → no numeric
 * status) is re-thrown as FailClosed so runGate fails closed (HARD-01) — a mis-invoked or
 * missing scan is NEVER silently treated as clean (T-04-03-FALSEPASS).
 *
 * @param {string} root absolute gsd-core worktree root.
 * @param {ReadonlyArray<{script:string}>} scans
 * @returns {Array<{script:string, ok:boolean, code:number, tail:string}>}
 */
function runScansLive(root, scans) {
  const { execFileSync } = require('node:child_process');
  const path = require('node:path');
  return scans.map((scan) => {
    const absPath = path.join(root, scan.script);
    try {
      execFileSync('bash', [absPath, '--diff', SCAN_DIFF_BASE], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      });
      return { script: scan.script, ok: true, code: 0, tail: '' };
    } catch (err) {
      // execFileSync throws on a nonzero exit AND on a spawn failure. Distinguish:
      //   exit 1            → real findings hit → DENY (ok:false).
      //   exit 2 (usage)    → we called it wrong → INFRA → fail closed.
      //   no numeric status → could not even spawn (bash/script missing) → fail closed.
      if (err && typeof err.status === 'number' && err.status === 1) {
        const out = (err.stdout || '') + (err.stderr || '');
        return { script: scan.script, ok: false, code: 1, tail: tailOf(out) };
      }
      const status = err && typeof err.status === 'number' ? ' (exit ' + err.status + ')' : '';
      throw new FailClosed(
        'could not run the LIVE scan `' + scan.script + '`' + status + ' at ' + absPath + ' (' +
          ((err && err.message) || 'spawn failure') + ') — failing closed (HARD-01)'
      );
    }
  });
}

/**
 * Keep the last TAIL_LIMIT characters of a scan's output (the actionable tail).
 * @param {string} out
 * @returns {string}
 */
function tailOf(out) {
  const s = String(out || '').trim();
  if (s.length <= TAIL_LIMIT) return s;
  return '…' + s.slice(s.length - TAIL_LIMIT);
}

/**
 * The pure gate decision with all impure deps injected.
 *
 * @param {string} stdinString raw PreToolUse JSON
 * @param {Object} deps
 * @param {string} deps.gsdCoreRoot the gsd-core worktree root.
 * @param {(root:string, scans:ReadonlyArray)=>Array} deps.runScans the per-scan runner.
 * @returns {{permissionDecision:string, permissionDecisionReason?:string}}
 */
function gate(stdinString, deps) {
  const input = readHookInput(stdinString);
  const command = (input.tool_input && input.tool_input.command) || '';

  const parsed = parseCommand(command);
  if (!parsed.ok) throw new FailClosed('unparseable command: ' + parsed.reason);

  const action = classifyAction(parsed);
  // A non-push command is out of scope — allow without running the scans. We do NOT
  // fail-closed on action.failClosed here: an unclassifiable mutating github call is the
  // filing gates' concern (03-03), not the scan gate's; this gate only ADDS the pre-push
  // scans on `git push`.
  if (!TRIGGER_ACTIONS.has(action.action)) return allow();

  const results = deps.runScans(deps.gsdCoreRoot, SCANS); // may throw → fail closed
  const failed = (results || []).filter((r) => r && r.ok === false);
  if (failed.length === 0) return allow();

  const detail = failed
    .map((f) => '`' + f.script + '` (exit ' + f.code + ')' + (f.tail ? ':\n' + f.tail : ''))
    .join('\n\n');

  return deny(
    'Blocked by the LIVE gsd-core pre-push scans (ENF-09). The push carries content that ' +
      'one or more scans flagged — fix it before pushing:\n\n' +
      detail
  );
}

/**
 * Injectable entry seam. Builds runGate ctx and defaults the gsd-core root + the live scan
 * runner from the real environment when not injected.
 *
 * @param {string} stdinString raw PreToolUse JSON
 * @param {Object} [deps]
 * @returns {{permissionDecision:string, permissionDecisionReason?:string}}
 */
function runScanGate(stdinString, deps = {}) {
  const ctx = {
    command: safeCommand(stdinString),
    action: 'scan-gate',
    worktreeRoot: deps.worktreeRoot,
    overrideImpl: deps.overrideImpl,
  };

  return runGate(() => {
    const resolved = Object.assign({}, deps);
    if (!resolved.gsdCoreRoot) {
      resolved.gsdCoreRoot = resolveRootForCommand(ctx.command, process.cwd());
      if (!resolved.gsdCoreRoot) return allow();
    }
    ctx.worktreeRoot = ctx.worktreeRoot || resolved.gsdCoreRoot;
    if (!resolved.runScans) {
      resolved.runScans = runScansLive;
    }
    return gate(stdinString, resolved);
  }, ctx);
}


function main() {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => {
    buf += c;
  });
  process.stdin.on('end', () => {
    emit(runScanGate(buf));
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  runScanGate,
  gate,
  runScansLive,
  SCANS,
  TRIGGER_ACTIONS,
};
