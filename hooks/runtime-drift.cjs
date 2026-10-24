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
 * PUSH TARGET (quick-261007-rni F9, Revision 1). A `git push` segment arms on where it pushes,
 * not only on the cwd (hooks/lib/push-target.cjs). Its repository is the first positional after
 * `push`, else the last `--repo`; a URL / path is parsed, a remote name is resolved with
 * `git -C <that segment's dir> remote get-url --push --all`. Four ways:
 *   (a) any open-gsd/gsd-core URL arms from ANY directory (the posture above);
 *   (b) every URL another owner/repo AND the whole command is an allowlisted plain form
 *       (Revision 2: no subshell / group / expansion / redirection except `2>&1`, no env
 *       assignment or sudo, every segment an allowlisted program or read-only git subcommand, no
 *       `--receive-pack` / `--exec`, no url rewrite for a literal URL, lookups inside one
 *       5000 ms budget and at most 3 dirs): this segment does NOT arm, so
 *       `git push backup fix/x` to a fork from a gsd-core cwd passes;
 *   (c) anything short of (b): unresolvable, indeterminate, off the allowlist or redirected
 *       (lookup failure or budget, unparseable URL, unknown option, `-c` / `--git-dir` / env /
 *       config writes / `bash -c` / a subshell / `--receive-pack`): the pre-F9 cwd rule,
 *       unchanged, and the deny says the gate fell back to it. So
 *       `git -C <other repo> push typo main` still passes through (the resolveRoot default in
 *       runRuntimeDriftGate follows `git -C`);
 *   (d) no repository: the pre-F9 cwd rule, unchanged.
 * gh's `--repo` / `GH_REPO` / `repos/<o>/<r>` reading is never applied to a git push (it let
 * `GH_REPO=other/x git push origin y` through). issue-create / pr-create keep F8 unchanged.
 *
 * ── COST ────────────────────────────────────────────────────────────────────────────────
 * The RES-01 action-first short-circuit is the FIRST thing after the parse, so a
 * non-governed command (`git status`, `npm test`) costs zero filesystem digests, zero stamp
 * reads, zero resolves and zero network calls. Asserted by call count in the tests, not by
 * timing. Inside the 15 min TTL even a governed command makes no network call at all.
 * The F9 lookups (local `git remote get-url` for a remote name, `git config --get-regexp ^url\.`
 * for a literal URL; no network) run only for a governed push segment with an explicit
 * repository, share ONE 5000 ms budget per invocation (each call min(3000 ms, remaining)), and
 * never run for more than 3 candidate dirs.
 *
 * @module hooks/runtime-drift
 */

const { parseCommandForGates } = require('./lib/argv.cjs');
const { hasGovernedSegment, isNonGovernedCommand, classifyAction } = require('./lib/classify.cjs');
const { runGate, readHookInput, deny, allow, ask, emit, FailClosed, safeCommand } = require('./lib/failclosed.cjs');
const { resolveRootForCommand, commandTargetsGsdCore, segmentRepoTarget, ghRepoBySegment, pushSegmentDirs } = require('./lib/resolve.cjs');
const { classifyPushTarget, createLookupBudget, resolvePushUrlsLive, urlRewritesLive } = require('./lib/push-target.cjs');
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
 *   6. the oracle: digest → stamp → managed hooks → upstream tip → evaluateDrift;
 *   7. verdict → decision.
 *
 * @param {string} stdinString raw PreToolUse JSON
 * @param {Object} deps
 * @param {(command:string)=>(string|null)} deps.resolveRoot gsd-core root for the command, or null
 * @param {(command:string, seg:Object)=>(string[]|null)} deps.segmentDirs the dirs ONE push segment
 *   can run in (F9; a throw, null or [] makes that push target unresolvable -> rule c)
 * @param {(dir:string, name:string, timeoutMs:number)=>string[]} deps.resolvePushUrls every push
 *   URL of a remote name in a dir (F9; a throw makes the target unresolvable -> rule c)
 * @param {(dir:string, timeoutMs:number)=>string[]} deps.urlRewrites the url.<base>.insteadOf /
 *   pushInsteadOf lines in a dir (F9 R2 item 5; non-empty or a throw -> rule c for a literal URL)
 * @param {()=>number} [deps.now] the clock for the shared lookup budget (F9 R2 item 6)
 * @param {()=>string} deps.runtimeDigest digest of the installed runtime tree (may throw)
 * @param {()=>(Object|null)} deps.readStamp the toolkit stamp, or null when unstamped (may throw)
 * @param {(stamp:(Object|null))=>(string|null)} deps.hooksDigest the managed gsd-core hooks digest
 *   measured over the stamp's own `hooks_files`, or null when the stamp lists none (may throw
 *   FailClosed, which denies; CTK-ADR-0011)
 * @param {()=>{sha:string, source:string, ageMs:number}} deps.upstreamTip the upstream tip
 *   (may throw UpstreamUnavailable → ask, or FailClosed → deny)
 * @param {Function} [deps.evaluateDrift] the pure verdict function (defaults to the oracle's)
 * @returns {{permissionDecision:string, permissionDecisionReason?:string}}
 */
function gate(stdinString, deps) {
  const input = readHookInput(stdinString);
  const command = (input.tool_input && input.tool_input.command) || '';

  const parsed = parseCommandForGates(command);
  if (!parsed.ok) throw new FailClosed('unparseable command: ' + parsed.reason);

  // (3) RES-01 action-first short-circuit. This MUST stay above every digest, stamp read,
  // resolve and network call — it is what makes `git status` free.
  if (isNonGovernedCommand(parsed, GOVERNED_ACTIONS)) return allow();

  // (4) An unparseable/failClosed chain reaches here with no governed segment; ENF-15 is other
  // gates' concern, and a command this gate does not govern is not this gate's to block.
  if (!hasGovernedSegment(parsed, GOVERNED_ACTIONS)) return allow();

  // (5) ROB-01 arming (D-07), per governed SEGMENT (quick-261007-ji5 F8). A segment with an
  // EXPLICIT repo target (`--repo`/`-R`/`GH_REPO=`/gh-api `repos/<o>/<r>`) is armed only when that
  // target is open-gsd/gsd-core (an unparseable explicit spec counts as gsd-core, fail-closed): a
  // `gh issue create --repo open-gsd/gsd-graph` from a gsd-core cwd is not a gsd-core filing. A
  // segment with NO explicit target keeps the old rule: armed when the command resolves to a
  // gsd-core root or otherwise names upstream gsd-core.
  //
  // quick-261007-rni F9: a `push` segment is keyed on its PUSH TARGET instead (classifyPushTarget,
  // see the D-07 header): gsd-core arms (rule a); other does not arm this segment (rule b); null
  // falls to the same old rule (rules c and d), and a rule-c arm records why the target was
  // unresolvable for the deny text. gh's repo reading is never applied to a git push.
  let root;
  let armed = false;
  let unresolvedPhrase = null;
  let budget = null; // F9 R2 item 6: ONE lookup budget for every push segment of this invocation
  const ghRepos = ghRepoBySegment(parsed.segments); // R2-WR-05: env / earlier-export GH_REPO
  for (let si = 0; si < parsed.segments.length; si++) {
    const seg = parsed.segments[si];
    const action = classifyAction({ ok: true, segments: [seg] }).action;
    if (!GOVERNED_ACTIONS.includes(action)) continue;
    let target;
    let unresolved = null;
    if (action === 'push') {
      if (budget === null) budget = createLookupBudget(deps.now);
      const r = classifyPushTarget(seg, parsed, {
        command,
        segmentDirs: () => deps.segmentDirs(command, seg),
        resolvePushUrls: deps.resolvePushUrls,
        urlRewrites: deps.urlRewrites,
        budget,
      });
      target = r.target;
      unresolved = r.unresolved;
    } else {
      target = segmentRepoTarget(seg, ghRepos[si]);
    }
    if (target === 'gsd-core') { armed = true; break; }
    if (target === 'other') continue;
    if (root === undefined) root = deps.resolveRoot(command);
    if (root !== null || commandTargetsGsdCore(parsed) === true) {
      armed = true;
      unresolvedPhrase = unresolved;
      break;
    }
  }
  if (!armed) return allow();

  // (6) The oracle. Each of these may THROW; every throw except UpstreamUnavailable reaches
  // runGate and DENIES (HARD-01). The managed hooks under ~/.claude/hooks are measured over the
  // stamp's own list (CTK-ADR-0011), OUTSIDE the narrow catch below, before any network call.
  const digest = deps.runtimeDigest();
  const stamp = deps.readStamp();
  const hooksDigest = deps.hooksDigest(stamp);

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
    hooksDigest,
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
      '`origin/' + runtimeStamp.UPSTREAM_REF + '`, builds and reinstalls the managed hooks, and stamps the ' +
      'result. It never installs the PUBLISHED npm package, which can be far behind `' +
      runtimeStamp.UPSTREAM_REF + '`.)' +
      // quick-261007-rni F9 (PD-4), R2 item 8 (WR-02), R3 IN-01: a rule-c arm says the gate could not
      // CONFIRM the target (true also when the remote resolved but the command failed the rule-(b)
      // allowlist) and fell back to the cwd rule; it did NOT decide the push goes upstream. Only a
      // rule-c arm carries a phrase (rules a and d set none), so the note never appears otherwise.
      (unresolvedPhrase
        ? '\n\nNote: ENF-21 could not confirm where this push goes (' + unresolvedPhrase + '), so the ' +
          'gate fell back to the gsd-core-checkout rule: this command runs in a gsd-core checkout (or ' +
          'names open-gsd/gsd-core), so it is gated like any push from there.'
        : '')
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
      // Follows `git -C <dir>` by default (see commandStartDir), so a `git -C <other-repo> push`
      // from a gsd-core session cwd resolves the OTHER tree and passes through instead of
      // false-gating a push to an unrelated repo (ENF-21 narrowing).
      resolved.resolveRoot = (command) => resolveRootForCommand(command, process.cwd());
    }
    // quick-261007-rni F9: where ONE push segment runs, and what its remote resolves to there.
    if (!resolved.segmentDirs) {
      resolved.segmentDirs = (command, seg) => pushSegmentDirs(command, process.cwd(), seg);
    }
    if (!resolved.resolvePushUrls) resolved.resolvePushUrls = resolvePushUrlsLive;
    if (!resolved.urlRewrites) resolved.urlRewrites = urlRewritesLive; // F9 R2 item 5
    if (!resolved.runtimeDigest) {
      resolved.runtimeDigest = () => runtimeStamp.runtimeDigest(runtimeStamp.RUNTIME_ROOT);
    }
    if (!resolved.readStamp) resolved.readStamp = () => runtimeStamp.readStamp();
    if (!resolved.hooksDigest) resolved.hooksDigest = (stamp) => runtimeStamp.hooksDigestForStamp(stamp, runtimeStamp.HOOKS_ROOT);
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
