#!/usr/bin/env node
'use strict';

/**
 * hooks/runtime-drift.cjs — PreToolUse(Bash) RUNTIME-FRESHNESS gate
 * (ENF-21, HARD-01 fail-closed, HARD-04 robust-parse).
 *
 * ── WHAT IT BLOCKS AND WHY ──────────────────────────────────────────────────────────────
 * Filing an issue, opening a PR, or pushing to `open-gsd/gsd-core` while the globally
 * installed gsd-core runtime at `~/.claude/gsd-core` is NOT provably at the current
 * `origin/next` tip. Reviewing or filing against a stale engine produces "reproduced
 * locally" results that do not match CI, and fixes that are already upstream. This gate
 * turns "I verified this against current `next`" from an assumption into a machine fact.
 *
 * The oracle is `hooks/lib/runtime-stamp.cjs` — read its header for WHY `VERSION` cannot
 * answer the question and why the stamp is digest-bound. This file owns only the ORDERING
 * and the verdict→decision mapping.
 *
 * ── D-05: THE ONE DELIBERATE `ask` (recorded in CTK-ADR-0007) ───────────────────────────
 * The LOCAL half is fully fail-closed. A missing stamp, a malformed stamp, or a
 * `runtime_digest` mismatch DENIES: not knowing what is installed IS the drift condition.
 * Any thrown error still denies through `runGate` — HARD-01 is untouched.
 *
 * The single deviation: when the upstream tip is genuinely unobtainable (github unreachable
 * AND no cached tip inside the 24 h staleness budget) the gate returns `ask`, never `deny`
 * and never a silent `allow`. Four reasons, all recorded in CTK-ADR-0007:
 *   1. CTK-ADR-0005 already narrowed HARD-01 to let a sub-check that CANNOT deny fail open.
 *      This is one rung sharper — a sub-check that CAN deny, whose input is unobtainable —
 *      and it resolves to the third severity CTK-ADR-0005 itself introduced, not to allow.
 *   2. `ask` is only ever produced by a DELIBERATE return. `failclosed.cjs` still collapses a
 *      throw, an empty decision, and any unrecognized value to `deny`, asserted byte-for-byte
 *      in `failclosed.test.cjs`. Teaching this gate to `ask` does not soften the floor.
 *   3. Staleness is a CORRECTNESS risk, not a CONTAINMENT risk. Every other gate reaches its
 *      verdict from local state; denying here on an unreachable network would take the whole
 *      suite offline with the ISP — the exact failure mode CTK-ADR-0005 names. An outage must
 *      not make gsd-core un-fileable.
 *   4. HONESTY LIMIT: `ask` degrades to allow under `--dangerously-skip-permissions`. Same
 *      accepted limit as ENF-11's advisory (quick task 260729-p3f). The reason string says so.
 * The catch is NARROW — wrapped around the `upstreamTip` call only. Wrapping the whole gate
 * would let a digest or stamp failure leak into `ask` and silently soften the floor.
 *
 * ── D-06: THE GOVERNED SURFACE IS EXACTLY THREE ACTIONS ─────────────────────────────────
 * `issue-create`, `pr-create`, `push` — the FILING/PUSHING surface. Triggering keys on
 * `hasGovernedSegment`, NEVER on `classifyAction(parsed).action`: per CTK-ADR-0006
 * §Decision.8 the chain aggregate reports only the first legacy-actionable segment, so
 * keying on it would manufacture a bypass (`git status && git push`).
 *
 * RECORDED GAP: the review-side verbs (`pr-review`, `pr-merge`) are DELIBERATELY not gated.
 * They are the charter-adjacent surface, not the filing surface this requirement scoped, and
 * their runtime-freshness coverage is the advisory RT0 step in `maintainer-review-sweep`.
 * Recorded as a deliberate non-gate in CTK-ADR-0007 — do not quietly widen it here without
 * amending that record.
 *
 * ── D-07: ARMING — ROB-01 DISCRIMINATOR, DELIBERATELY *NOT* HARD-02 FAIL-CLOSED ─────────
 * The other `gh` gates fail CLOSED on a null root that targets gsd-core, because their LIVE
 * policy script cannot load without a checkout (HARD-02). ENF-21 requires NO live script at
 * all — its oracle is the local stamp plus the network — so HARD-02 does not bind, a
 * null-root-but-targeting command is fully checkable, and it IS checked. Do not "fix" this
 * into a fail-closed deny: it would be a false deny on a command the gate can actually
 * adjudicate.
 *
 * ── COST ────────────────────────────────────────────────────────────────────────────────
 * The RES-01 action-first short-circuit is the FIRST thing after the parse, so a
 * non-governed command (`git status`, `npm test`) costs zero filesystem digests, zero stamp
 * reads, zero resolves and zero network calls. Asserted by call count in the tests, not by
 * timing. Inside the 15 min TTL even a governed command makes no network call at all.
 *
 * @module hooks/runtime-drift
 */

const { parseCommand } = require('./lib/argv.cjs');
const { hasGovernedSegment, isNonGovernedCommand } = require('./lib/classify.cjs');
const { runGate, readHookInput, deny, allow, ask, emit, FailClosed, safeCommand } = require('./lib/failclosed.cjs');
const { resolveRootForCommand, commandTargetsGsdCore } = require('./lib/resolve.cjs');
const runtimeStamp = require('./lib/runtime-stamp.cjs');

const { UpstreamUnavailable, REMEDIATION_COMMAND } = runtimeStamp;

/**
 * D-06: the filing/pushing surface, and ONLY that. Frozen so a future edit is a visible
 * decision rather than a mutation. See the header for why the review-side verbs are absent.
 */
const GOVERNED_ACTIONS = Object.freeze(['issue-create', 'pr-create', 'push']);

/** The honesty clause appended to the `ask` reason (T-0ov-07). */
const ASK_LIMIT_NOTE =
  'Note: an `ask` degrades to an ALLOW under `--dangerously-skip-permissions` — the same ' +
  'accepted limit ENF-11\'s advisory carries.';

/**
 * The pure gate decision with every impure dep injected.
 *
 * The ORDER below is load-bearing and must not be rearranged:
 *   1. read the harness payload (a malformed payload throws → fail-closed deny);
 *   2. parse; an unparseable command throws (HARD-04);
 *   3. RES-01 action-first short-circuit — BEFORE any IO of any kind (D-06);
 *   4. no governed segment at all → allow;
 *   5. ROB-01 arming (D-07);
 *   6. the oracle: digest → stamp → upstream tip → evaluateDrift;
 *   7. verdict → decision.
 *
 * @param {string} stdinString raw PreToolUse JSON
 * @param {Object} deps
 * @param {(command:string)=>(string|null)} deps.resolveRoot gsd-core root for the command, or null
 * @param {()=>string} deps.runtimeDigest digest of the installed runtime tree (may throw)
 * @param {()=>(Object|null)} deps.readStamp the toolkit stamp, or null when unstamped (may throw)
 * @param {()=>{sha:string, source:string, ageMs:number}} deps.upstreamTip the upstream tip
 *   (may throw UpstreamUnavailable → ask, or FailClosed → deny)
 * @param {Function} [deps.evaluateDrift] the pure verdict function (defaults to the oracle's)
 * @returns {{permissionDecision:string, permissionDecisionReason?:string}}
 */
function gate(stdinString, deps) {
  const input = readHookInput(stdinString);
  const command = (input.tool_input && input.tool_input.command) || '';

  const parsed = parseCommand(command);
  if (!parsed.ok) throw new FailClosed('unparseable command: ' + parsed.reason);

  // (3) RES-01 action-first short-circuit. This MUST stay above every digest, stamp read,
  // resolve and network call — it is what makes `git status` free.
  if (isNonGovernedCommand(parsed, GOVERNED_ACTIONS)) return allow();

  // (4) An unparseable/failClosed chain reaches here with no governed segment; ENF-15 is other
  // gates' concern, and a command this gate does not govern is not this gate's to block.
  if (!hasGovernedSegment(parsed, GOVERNED_ACTIONS)) return allow();

  // (5) ROB-01 arming (D-07). A governed action in an unrelated repo, not naming upstream
  // gsd-core, is not a gsd-core contribution.
  const root = deps.resolveRoot(command);
  if (root === null && commandTargetsGsdCore(parsed) !== true) return allow();

  // (6) The oracle. Each of these may THROW; every throw except UpstreamUnavailable reaches
  // runGate and DENIES (HARD-01).
  const digest = deps.runtimeDigest();
  const stamp = deps.readStamp();

  let upstream;
  try {
    upstream = deps.upstreamTip();
  } catch (err) {
    // NARROW catch, D-05: ONLY a genuinely unobtainable tip becomes `ask`. A FailClosed from
    // the tip resolver (a crafted `ls-remote` ref line — T-0ov-02) is tampering, not an
    // outage, and falls through to the fail-closed deny.
    if (err instanceof UpstreamUnavailable) {
      return ask(
        'ENF-21 could not verify that your installed gsd-core runtime matches `origin/next`: ' +
          ((err && err.message) || 'the upstream tip is unobtainable') + '. ' +
          'This is a NETWORK limit, not a policy decision — proceeding means you may be filing ' +
          'against a stale engine, so "I reproduced this locally" may not match CI. ' +
          'To resolve it deterministically once you are back online:\n\n  ' +
          REMEDIATION_COMMAND + '\n\n' + ASK_LIMIT_NOTE
      );
    }
    throw err;
  }

  const verdict = (deps.evaluateDrift || runtimeStamp.evaluateDrift)({
    stamp,
    runtimeDigest: digest,
    upstream,
  });

  // (7) Verdict → decision. ONLY `fresh` allows.
  if (verdict.verdict === 'fresh') return allow();

  return deny(
    'Blocked by the ENF-21 runtime-freshness gate (verdict: ' + verdict.verdict + '). ' +
      'You are about to file/push against `open-gsd/gsd-core`, but the gsd-core runtime installed ' +
      'at `' + runtimeStamp.RUNTIME_ROOT + '` is not provably at the current `origin/' +
      runtimeStamp.UPSTREAM_REF + '` tip — ' + verdict.reason + '.\n\n' +
      'Contributing against a stale engine produces local results that disagree with CI, and ' +
      'fixes that may already be upstream. One command resolves it, with no further decisions:\n\n  ' +
      REMEDIATION_COMMAND + '\n\n' +
      '(That command resolves the tip, verifies the installed payload against it, reinstalls from ' +
      '`origin/' + runtimeStamp.UPSTREAM_REF + '` only if it actually differs, and stamps the ' +
      'result. It never installs the PUBLISHED npm package, which can be far behind `' +
      runtimeStamp.UPSTREAM_REF + '`.)'
  );
}

/**
 * Injectable entry seam. Defaults the real impls into `deps` INSIDE the runGate callback, so a
 * throw from any default (a missing runtime root, an unreadable stamp) is caught by runGate and
 * fails closed rather than escaping the harness.
 *
 * @param {string} stdinString raw PreToolUse JSON
 * @param {Object} [deps]
 * @returns {{permissionDecision:string, permissionDecisionReason?:string}}
 */
function runRuntimeDriftGate(stdinString, deps = {}) {
  const ctx = {
    command: safeCommand(stdinString),
    action: 'runtime-drift',
    // OBS-02: read ONLY for session/tool ids in the verdict log; never logged verbatim.
    stdin: stdinString,
    worktreeRoot: deps.worktreeRoot,
    overrideImpl: deps.overrideImpl,
  };

  return runGate(() => {
    const resolved = Object.assign({}, deps);
    if (!resolved.resolveRoot) {
      resolved.resolveRoot = (command) => resolveRootForCommand(command, process.cwd());
    }
    if (!resolved.runtimeDigest) {
      resolved.runtimeDigest = () => runtimeStamp.runtimeDigest(runtimeStamp.RUNTIME_ROOT);
    }
    if (!resolved.readStamp) resolved.readStamp = () => runtimeStamp.readStamp();
    if (!resolved.upstreamTip) resolved.upstreamTip = () => runtimeStamp.upstreamTip();
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
    emit(runRuntimeDriftGate(buf));
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  runRuntimeDriftGate,
  gate,
  GOVERNED_ACTIONS,
  ASK_LIMIT_NOTE,
};
