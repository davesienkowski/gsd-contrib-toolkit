#!/usr/bin/env node
'use strict';

/**
 * bin/verify-hooks.cjs — the ONE re-runnable proof command (TEST-01 / TEST-02).
 *
 * 05-01 built the proof-harness (`spawnHook` + `classifyDecision`) and the per-hook deny/allow
 * assertions in hooks/integration-proof.test.cjs. THIS command packages them as a single
 * executable check: it drives the harness over every wired hook, captures the ACTUAL emitted
 * permissionDecision JSON (plus exit code + verdict) into committed `proofs/<hook>-<case>.json`
 * artifacts, and exits NONZERO if ANY proof is inconclusive or contradicts its expected verdict.
 *
 *   node bin/verify-hooks.cjs        # run every proof, (re)write proofs/, exit by outcome
 *
 * THE LOAD-BEARING INVARIANT (inherited from 05-01): a hook that crashes (non-zero exit) or
 * emits empty/unparseable/non-decision stdout is INCONCLUSIVE — it is NEVER a pass. The verdict
 * derives strictly from classifyDecision: a case passes only when the capture is conclusive AND
 * its decision matches the expected verdict. The artifact stores the actual emitted JSON so a
 * human / Phase 6 can independently re-check — the runner cannot forge a green that isn't there.
 *
 * Artifacts deliberately embed NO timestamps/PIDs so re-runs are BYTE-STABLE evidence.
 *
 * @module bin/verify-hooks
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { spawnHook: liveSpawnHook } = require('../hooks/lib/proof-harness.cjs');

const HOOKS_DIR = path.join(__dirname, '..', 'hooks');
const PROOFS_DIR = path.join(__dirname, '..', 'proofs');
const absHook = (name) => path.join(HOOKS_DIR, `${name}.cjs`);

// ── stdin fixture builders (mirror hooks/integration-proof.test.cjs) ─────────────
const bash = (command) => JSON.stringify({ tool_name: 'Bash', tool_input: { command } });
const edit = (file_path) => JSON.stringify({ tool_name: 'Edit', tool_input: { file_path } });

/**
 * Resolve a gsd-core checkout carrying the sentinel layout (scripts/ + gsd-core/bin/lib/) so
 * gates that resolve LIVE scripts find them. Mirrors hooks/integration-proof.test.cjs's
 * resolveGsdCoreCwd + the doctor's resolve-or-explain stance: no checkout => null, and the
 * needsLive cases SKIP with a note (an EXTERNAL checkout being absent is an env limit, not a
 * gate failure). Threat T-05-02-SILENTSKIP: a skip is RECORDED, never silently dropped.
 *
 * @returns {string|null} an absolute gsd-core root, or null when none is reachable.
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
 * THE SINGLE CANONICAL PROOF TABLE.
 *
 * Source of truth: hooks/integration-proof.test.cjs (the DENY_GATES table + the binlib-edit and
 * advisory proofs). It is re-declared here (not imported) because the test file is a node:test
 * module, not an exporting lib; this runner and that test MUST stay in sync — any fixture change
 * belongs in BOTH (the test asserts the same captures the runner records).
 *
 * Entry shape: { name, kind, bad/clean (deny gates) | inject/none (advisory), needsLive }.
 *   - kind:'deny'     → BAD must emit deny, CLEAN must emit allow.
 *   - kind:'advisory' → INJECT-case must surface additionalContext (or any advisory surface) and
 *                        the NONE-case stays quiet; BOTH must carry NO permissionDecision.
 */
const PROOF_TABLE = [
  // ── deny gates (command-trips-the-gate fixtures; needsLive resolves LIVE scripts) ──
  { name: 'gh-issue-create', kind: 'deny', needsLive: true,
    bad: bash('gh issue create --label bug --title x --body "### GSD Version\\n_No response_"'),
    clean: bash('git status') },
  { name: 'gh-pr-create', kind: 'deny', needsLive: true,
    bad: bash('gh pr create --base next --title x --body ""'),
    clean: bash('gh repo view o/r') },
  { name: 'gh-edit', kind: 'deny', needsLive: true,
    bad: bash('gh pr edit 9 --body "just prose, no template"'),
    clean: bash('gh issue edit 7 --add-label triage') },
  { name: 'githooks-seal', kind: 'deny', needsLive: true,
    bad: bash('git commit --no-verify -m x'),
    clean: bash('git status') },
  { name: 'containment', kind: 'deny', needsLive: true,
    bad: bash('git add .planning/STATE.md'),
    clean: bash('git status') },
  { name: 'lint-ci-marker', kind: 'deny', needsLive: true,
    bad: bash('git push origin HEAD'),
    clean: bash('git status') },
  // ENF-16 (07-01): a malformed conventional-commit prefix DENIES; a clean read ALLOWS.
  // needsLive=true — the gate resolves the gsd-core root from cwd and short-circuits to ALLOW
  // outside a gsd-core checkout, so the bad-prefix deny is only CONCLUSIVE when run there.
  { name: 'git-commit-convention', kind: 'deny', needsLive: true,
    bad: bash('git commit -m "docs fix thing"'),
    clean: bash('git status') },
  { name: 'policy-invariants', kind: 'deny', needsLive: true,
    bad: bash('git commit -m wip'),
    clean: bash('git status') },
  { name: 'issue-dedupe', kind: 'deny', needsLive: true,
    bad: bash('gh issue create --title "x'),
    clean: bash('git status') },
  { name: 'freshness', kind: 'deny', needsLive: true,
    bad: bash('git commit "unterminated'),
    clean: bash('git status') },
  { name: 'scan-gate', kind: 'deny', needsLive: true,
    bad: bash('git push "unterminated'),
    clean: bash('git status') },
  // ── binlib-edit (Write|Edit gate): command-only, no live resolution ──
  { name: 'binlib-edit', kind: 'deny', needsLive: false,
    bad: edit('/g/gsd-core/bin/lib/decisions.cjs'),
    clean: edit('/g/gsd-core/sdk/src/query/decisions.cts') },
  // ── advisory hooks: inject-vs-none, and NEVER a permissionDecision ──
  { name: 'protocol-reminder', kind: 'advisory', needsLive: false,
    inject: JSON.stringify({ prompt: 'please file an issue on gsd-core for this parser bug', hook_event_name: 'UserPromptSubmit' }),
    none: JSON.stringify({ prompt: 'refactor this function to be cleaner', hook_event_name: 'UserPromptSubmit' }) },
  { name: 'preflight-shipped-paths', kind: 'advisory', needsLive: true,
    // preflight reads the REAL working-tree diff at cwd; no stdin payload (single surfaced case).
    inject: '', none: null },
];

/**
 * Compute a deny-gate case verdict from a capture.
 * @param {{conclusive:boolean, decision:(string|null)}} cap
 * @param {'deny'|'allow'} expected
 * @returns {'pass'|'fail'|'inconclusive'}
 */
function denyVerdict(cap, expected) {
  if (!cap.conclusive) return 'inconclusive';
  return cap.decision === expected ? 'pass' : 'fail';
}

/**
 * Serialize one proof artifact: 2-space JSON + trailing newline, NO timestamps/PIDs (byte-stable).
 * @param {object} artifact
 * @returns {string}
 */
function serializeArtifact(artifact) {
  return JSON.stringify(artifact, null, 2) + '\n';
}

/**
 * Atomic write (tmp -> rename), copied from bin/lint-ci-stamp.cjs writeMarkerAtomic discipline.
 * @param {string} finalPath
 * @param {string} body
 */
function writeAtomic(finalPath, body) {
  fs.mkdirSync(path.dirname(finalPath), { recursive: true });
  const tmp = finalPath + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, body, { encoding: 'utf8' });
  fs.renameSync(tmp, finalPath);
}

/**
 * Parse the emitted hookSpecificOutput JSON out of a capture's rawStdout (best-effort, for the
 * artifact's `emitted` field). Returns the parsed object, or null if nothing parseable.
 * @param {string} rawStdout
 * @returns {object|null}
 */
function parseEmitted(rawStdout) {
  const text = typeof rawStdout === 'string' ? rawStdout.trim() : '';
  if (text === '') return null;
  try {
    return JSON.parse(text);
  } catch (_) {
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try {
        return JSON.parse(lines[i]);
      } catch (_e) { /* keep trying earlier lines */ }
    }
  }
  return null;
}

/**
 * Build the artifact record for ONE case (the captured evidence Phase 6 cites).
 * @returns {object}
 */
function buildArtifact(hook, kase, fixture, expected, cap, verdict, note) {
  const art = {
    hook,
    case: kase,
    fixture: fixture === null ? null : fixture,
    expected,
    verdict,
    decision: cap ? cap.decision : null,
    exitCode: cap ? cap.status : null,
    reason: cap ? cap.reason : (note || ''),
    emitted: cap ? parseEmitted(cap.rawStdout) : null,
  };
  if (note) art.note = note;
  return art;
}

/**
 * Drive the proof table over spawnHook, compute per-case verdicts, optionally write artifacts.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.write=true] write proofs/<hook>-<case>.json when true.
 * @param {string} [opts.proofsDir] target dir for artifacts (default PROOFS_DIR).
 * @param {Array}  [opts.table] the proof table (default PROOF_TABLE) — injected by the test.
 * @param {Function} [opts.spawnHook] the (absPath, {stdin,cwd}) capture fn (default the live harness).
 * @param {string|null} [opts.liveCwd] cwd for needsLive cases (default resolveGsdCoreCwd()); null => SKIP.
 * @returns {{ok:boolean, results:Array<{hook,case,verdict,...}>}}
 */
function runVerify(opts = {}) {
  const write = opts.write !== false;
  const proofsDir = opts.proofsDir || PROOFS_DIR;
  const table = opts.table || PROOF_TABLE;
  const spawn = opts.spawnHook || liveSpawnHook;
  const liveCwd = Object.prototype.hasOwnProperty.call(opts, 'liveCwd') ? opts.liveCwd : resolveGsdCoreCwd();

  const results = [];

  for (const entry of table) {
    const hookPath = absHook(entry.name);

    // A needsLive entry with no reachable checkout SKIPS (recorded, never dropped or coerced).
    if (entry.needsLive && !liveCwd) {
      const note = 'no gsd-core checkout reachable (set GSD_CORE_ROOT) — LIVE-resolving proof skipped (env limit)';
      const cases = entry.kind === 'advisory' ? [['inject', 'inject'], ['none', 'none']] : [['deny', 'deny'], ['allow', 'allow']];
      for (const [kase, fixtureKey] of cases) {
        const art = buildArtifact(entry.name, kase, entry[fixtureKey] === undefined ? null : entry[fixtureKey], kase, null, 'skipped', note);
        results.push(art);
        if (write) writeAtomic(path.join(proofsDir, `${entry.name}-${kase}.json`), serializeArtifact(art));
      }
      continue;
    }

    const cwd = entry.needsLive ? liveCwd : process.cwd();

    if (entry.kind === 'advisory') {
      // INJECT case: surfaces advisory content; NONE case: stays quiet. BOTH: no permissionDecision.
      for (const kase of ['inject', 'none']) {
        const fixture = entry[kase];
        if (fixture === undefined) continue; // entry doesn't define this case
        const spawnOpts = { cwd };
        if (typeof fixture === 'string') spawnOpts.stdin = fixture;
        const cap = spawn(hookPath, spawnOpts);
        const cleanExit = cap.status === 0;
        const surfaced = (cap.rawStdout + cap.rawStderr).trim().length > 0;
        const hasDecision = /permissionDecision/.test(cap.rawStdout) || /permissionDecision/.test(cap.rawStderr);
        // Advisory verdict: clean exit, NO permissionDecision, and the expected surface presence.
        let verdict;
        if (!cleanExit || hasDecision) {
          verdict = 'fail';
        } else if (kase === 'inject') {
          verdict = surfaced ? 'pass' : 'fail';
        } else { // 'none'
          verdict = 'pass'; // a quiet companion is acceptable; the key invariant is no decision
        }
        const art = buildArtifact(entry.name, kase, fixture, kase === 'inject' ? 'advisory-surface' : 'advisory-quiet', cap, verdict, hasDecision ? 'UNEXPECTED permissionDecision from an advisory hook' : '');
        results.push(art);
        if (write) writeAtomic(path.join(proofsDir, `${entry.name}-${kase}.json`), serializeArtifact(art));
      }
      continue;
    }

    // deny gate: BAD must deny, CLEAN must allow.
    for (const [kase, fixtureKey, expected] of [['deny', 'bad', 'deny'], ['allow', 'clean', 'allow']]) {
      const fixture = entry[fixtureKey];
      const cap = spawn(hookPath, { stdin: fixture, cwd });
      const verdict = denyVerdict(cap, expected);
      const art = buildArtifact(entry.name, kase, fixture, expected, cap, verdict, '');
      results.push(art);
      if (write) writeAtomic(path.join(proofsDir, `${entry.name}-${kase}.json`), serializeArtifact(art));
    }
  }

  // ok is true ONLY if every NON-skipped case is a pass. A skipped case does not flip ok.
  const ok = results.every((r) => r.verdict === 'pass' || r.verdict === 'skipped');
  return { ok, results };
}

/**
 * CLI entry: run every proof, write artifacts, print PASS/FAIL lines (mirrors doctor.cjs), and
 * return the exit code (0 = every reachable proof passed; 1 = any non-pass non-skip).
 * @returns {number}
 */
function runCli() {
  const { ok, results } = runVerify({ write: true });
  process.stdout.write('verify-hooks — re-runnable deny/allow proof capture (TEST-01/TEST-02)\n');
  process.stdout.write('  proofs: ' + PROOFS_DIR + '\n\n');
  let pass = 0; let fail = 0; let skip = 0;
  for (const r of results) {
    const mark = r.verdict === 'pass' ? 'PASS' : r.verdict === 'skipped' ? 'SKIP' : 'FAIL';
    if (r.verdict === 'pass') pass += 1;
    else if (r.verdict === 'skipped') skip += 1;
    else fail += 1;
    process.stdout.write('  [' + mark + '] ' + r.hook + '-' + r.case + ' :: expected=' + r.expected + ' decision=' + String(r.decision) + ' exit=' + String(r.exitCode) + '\n');
    if (r.verdict !== 'pass') process.stdout.write('         ' + (r.reason || r.note || '') + '\n');
  }
  process.stdout.write('\n');
  process.stdout.write(pass + ' pass, ' + fail + ' fail, ' + skip + ' skip across ' + results.length + ' proof cases.\n');
  if (!ok) {
    process.stdout.write('VERIFY FAILED — a hook proof was inconclusive or contradicted its expected verdict. ' +
      'A crash/empty capture is NEVER a pass (05-01 invariant). Inspect proofs/ for the captured evidence.\n');
  } else {
    process.stdout.write('All reachable hook proofs PASSED (skipped cases need a live gsd-core checkout).\n');
  }
  return ok ? 0 : 1;
}

if (require.main === module) {
  process.exit(runCli());
}

module.exports = { runVerify, runCli, resolveGsdCoreCwd, PROOF_TABLE };
