#!/usr/bin/env node
'use strict';

/**
 * bin/runtime-sync.cjs — the ENF-21 runtime-freshness CLI.
 *
 *   node bin/runtime-sync.cjs check   read-only: print the drift verdict, mutate nothing
 *   node bin/runtime-sync.cjs sync    remediate: bring `~/.claude/gsd-core` to `origin/next`
 *                                     and stamp it — one command, no prompts, no decisions
 *
 * ── WHY THE REMEDIATION IS *NOT* IN THE HOOK (D-08) ─────────────────────────────────────
 * ENF-21's deny reason quotes `sync` verbatim rather than performing it, and both skills run
 * `check` (and `sync` on drift) at their Phase 0. The mutation deliberately does NOT live in
 * the PreToolUse gate:
 *   • a hook runs under a harness timeout (the suite's max is 120 s) and a real reinstall is
 *     `npm ci` + `install.js` — routinely longer;
 *   • it would rewrite the user's GLOBAL install in the middle of a `gh pr create`, invisibly
 *     and irreversibly;
 *   • a failing reinstall would then re-fire on every subsequent governed command.
 * So the mutation lives where it is visible, early, and reversible-by-rerun (the skill step and
 * this CLI), and is absent from the surface where it is dangerous.
 *
 * ── WHY IT CLONES INSTEAD OF USING npm OR THE LOCAL CHECKOUT ────────────────────────────
 *   • `npx @opengsd/gsd-core@latest --claude` installs the PUBLISHED package, which can be far
 *     behind `next` — using it would REGRESS the runtime. Never the remediation source.
 *   • the local `~/repos/gsd-core` clone's `gsd-core/bin/lib/*.cjs` are gitignored build
 *     artifacts, routinely STALER than the runtime. This CLI never reads, fetches, checks out,
 *     or writes to any local clone — it clones the pinned tip into a tmpdir and removes it.
 *
 * ── THE FAST PATH, AND WHAT IT HONESTLY PROVES (D-09) ───────────────────────────────────
 * A fresh clone has no built `gsd-core/bin/lib/*.cjs` (they are produced by `npm ci` →
 * `prepare` → `build:lib`), so the pre-install comparison can only cover the installer's
 * PAYLOAD projection: `<clone>/gsd-core/{workflows,references,templates,contexts}` against the
 * matching four directories of the runtime. When those already match, no reinstall can change
 * anything observable, so the run stamps and stops — recording `mode:'payload-verified',
 * engine_verified:false`. Only an actual reinstall records `mode:'installed',
 * engine_verified:true`. `engine_verified` is RECORDED, NOT GATED: the gate keys on `sha` +
 * `runtime_digest`. Do not quietly promote it to a gate input.
 *
 * ── WHY A RAW CLONE↔RUNTIME COMPARISON IS NOT ENOUGH (D-11) ─────────────────────────────
 * `bin/install.js` is NOT a byte-copy. It rewrites `/gsd:<cmd>` → `/gsd-<cmd>` throughout the
 * payload it writes, driven by the target runtime descriptor's
 * `hostBehaviors.hyphenNameAgentBody` (gsd-core #3583 / #3677). Measured on this machine: 104
 * `workflows/`, 32 `references/` and 16 `templates/` files differ by exactly that substitution,
 * while `contexts/` — which contains no command references — matches byte-for-byte.
 *
 * So `raw clone payload == installed payload` is simply the WRONG QUESTION wherever the
 * transform fires: it can never be satisfied, which made the original post-install re-verify
 * abort permanently and left ENF-21 denying with an unreachable remediation.
 *
 * The fix does NOT replicate upstream's rewrite policy here — that is exactly what
 * CTK-ADR-0001 §3 forbids, and it would rot the moment upstream changed the rule. Instead the
 * LIVE installer is run a SECOND time into a throwaway config dir and that output is hashed:
 * upstream stays the sole authority on its own transform, and we merely ensure the same
 * transform has been applied to both sides before comparing. A raw match still short-circuits
 * first, so the extra install is paid only when the cheap comparison is inconclusive.
 */

const nodeFs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const defaultOracle = require('../hooks/lib/runtime-stamp.cjs');

/** `npm ci` in a fresh gsd-core clone is slow but bounded; a timeout is an ABORT, never a stamp. */
const NPM_CI_TIMEOUT_MS = 600000;
/** The installer is faster but still bounded. */
const INSTALL_TIMEOUT_MS = 300000;
/** The shallow clone. */
const CLONE_TIMEOUT_MS = 300000;

const USAGE = [
  'usage: node bin/runtime-sync.cjs <check|sync>',
  '',
  '  check   read-only. Print the ENF-21 runtime-freshness verdict and exit:',
  '            0 = fresh, 1 = drifted/unstamped/unverified, 2 = the upstream tip is unobtainable.',
  '            Writes nothing.',
  '  sync    bring the installed gsd-core runtime at ~/.claude/gsd-core to the current',
  '            open-gsd/gsd-core origin/next tip and stamp it. No prompts, no decisions.',
  '            Reinstalls ONLY if the installed payload actually differs.',
].join('\n');

/**
 * Merge a partial oracle stub over the real module, so a caller (or a test) overrides only the
 * seams it cares about and every other function stays the real one.
 * @param {Object|undefined} over
 * @returns {Object}
 */
function oracleOf(over) {
  return over && over !== defaultOracle ? Object.assign({}, defaultOracle, over) : defaultOracle;
}

/**
 * `check` — the READ-ONLY verdict. It runs the exact same `evaluateDrift` the gate runs, so it
 * can never report `fresh` about a runtime the gate would deny.
 *
 * @param {Object} [deps]
 * @param {Object} [deps.oracle] the runtime-stamp module (or a partial override)
 * @param {string} [deps.runtimeRoot]
 * @param {(line:string)=>void} [deps.log]
 * @returns {{code:number, verdict:string, reason?:string}}
 */
function check(deps = {}) {
  const O = oracleOf(deps.oracle);
  const log = deps.log || ((l) => process.stdout.write(String(l) + '\n'));
  const runtimeRoot = deps.runtimeRoot || O.RUNTIME_ROOT;

  const digest = O.runtimeDigest(runtimeRoot);
  const stamp = O.readStamp();

  let upstream;
  try {
    upstream = O.upstreamTip();
  } catch (err) {
    if (err instanceof O.UpstreamUnavailable || err instanceof defaultOracle.UpstreamUnavailable) {
      log('ENF-21 runtime freshness: UNKNOWN — ' + ((err && err.message) || 'the upstream tip is unobtainable'));
      log('  (this is a network limit, not drift; re-run when github is reachable)');
      return { code: 2, verdict: 'unknown', reason: (err && err.message) || '' };
    }
    throw err;
  }

  const v = O.evaluateDrift({ stamp, runtimeDigest: digest, upstream });
  if (v.verdict === 'fresh') {
    log('ENF-21 runtime freshness: fresh — ' + v.reason);
    return { code: 0, verdict: v.verdict, reason: v.reason };
  }
  log('ENF-21 runtime freshness: ' + v.verdict.toUpperCase() + ' — ' + v.reason);
  log('');
  log('Remediate with:');
  log('  ' + O.REMEDIATION_COMMAND);
  return { code: 1, verdict: v.verdict, reason: v.reason };
}

/**
 * `sync` — the single, decision-free remediation.
 *
 *   1. resolve the current `origin/next` tip (`git ls-remote`);
 *   2. shallow-clone that branch into a tmpdir, then RACE-GUARD: the clone's HEAD must equal
 *      the resolved tip, else abort (the tip can move between the two calls);
 *   3. compare the clone's payload to the runtime's — equal ⇒ stamp `payload-verified` and stop;
 *   4. otherwise the difference may be the installer transform rather than drift, so `npm ci`
 *      (which runs `prepare` → `build:lib`, producing the gitignored `bin/lib/*.cjs` the
 *      installer requires) and build a PROJECTION by running `bin/install.js --claude` into a
 *      throwaway `--config-dir` with HOME redirected (D-11). If the runtime matches the
 *      projection ⇒ stamp `projection-verified` and stop — still no mutation. Only if it
 *      differs from the projection too is this real drift, and only then does the real
 *      `node <tmp>/bin/install.js --claude` run;
 *   5. RE-verify against the PROJECTION — like with like; on mismatch abort WITHOUT stamping
 *      (T-0ov-06 — never stamp an install we could not confirm);
 *   6. stamp `installed` with a freshly computed whole-tree digest;
 *   7. remove the tmpdir in a `finally`, on the success AND the failure path.
 *
 * @param {Object} [deps]
 * @returns {{code:number, mode?:string, stamp?:Object, reason?:string}}
 */
function sync(deps = {}) {
  const O = oracleOf(deps.oracle);
  const log = deps.log || ((l) => process.stdout.write(String(l) + '\n'));
  const execFileSync = deps.execFileSync || require('node:child_process').execFileSync;
  const mkdtempSync = deps.mkdtempSync || nodeFs.mkdtempSync;
  const mkdirSync = deps.mkdirSync || nodeFs.mkdirSync;
  const rmSync = deps.rmSync || nodeFs.rmSync;
  const now = deps.now || (() => new Date().toISOString());
  const runtimeRoot = deps.runtimeRoot || O.RUNTIME_ROOT;

  // (1) The target tip. Resolved BEFORE any tmpdir exists, so an outage costs nothing.
  let tip;
  try {
    tip = O.fetchTipLive({ execFileSync });
  } catch (err) {
    log('ENF-21 sync ABORTED: could not resolve the upstream `' + O.UPSTREAM_REF + '` tip — ' +
      ((err && err.message) || 'unknown failure'));
    return { code: 2, reason: 'upstream-unresolvable' };
  }
  log('Target: ' + O.UPSTREAM_URL + '#' + O.UPSTREAM_REF + ' @ ' + tip);

  const tmp = mkdtempSync(path.join(os.tmpdir(), 'gsd-runtime-sync-'));
  try {
    // (2) Shallow clone, branch-pinned. No local clone is read, fetched, or written.
    log('Cloning ' + O.UPSTREAM_REF + ' (depth 1) into ' + tmp + ' …');
    execFileSync('git', ['clone', '--depth', '1', '--branch', O.UPSTREAM_REF, O.UPSTREAM_URL, tmp], {
      encoding: 'utf8',
      timeout: CLONE_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const head = String(
      execFileSync('git', ['-C', tmp, 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
        timeout: 30000,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    ).trim();

    if (head !== tip) {
      // The RACE: `next` moved between the ls-remote and the clone. Stamping `tip` for a tree
      // that is actually `head` would be a lie; stamping `head` would silently target something
      // the user never asked for. Abort and let the re-run resolve a single consistent tip.
      log('ENF-21 sync ABORTED: ls-remote↔clone race — resolved tip ' + tip.slice(0, 8) +
        ' but the clone is at ' + head.slice(0, 8) + '. Re-run to pick up the newer tip.');
      return { code: 1, reason: 'race' };
    }

    // (3) The payload comparison (D-09, amended by D-11).
    const cloneRoot = path.join(tmp, 'gsd-core');
    const runtimePayload = () => O.payloadDigest(runtimeRoot);

    // `npm ci` runs `prepare` → `build:lib`, producing the gitignored `gsd-core/bin/lib/*.cjs`
    // that `bin/install.js` require()s. A fresh clone cannot run the installer unbuilt. Both the
    // PROJECTION and the real install need it, so it is hoisted and run at most once.
    let built = false;
    const ensureBuilt = () => {
      if (built) return;
      log('  npm ci …');
      execFileSync('npm', ['ci'], {
        cwd: tmp,
        encoding: 'utf8',
        timeout: NPM_CI_TIMEOUT_MS,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      built = true;
    };

    // D-11 — THE PROJECTION. The installer is NOT a byte-copy: it rewrites `/gsd:<cmd>` →
    // `/gsd-<cmd>` per the target descriptor's `hostBehaviors.hyphenNameAgentBody` (gsd-core
    // #3583 / #3677), so `raw clone payload == installed payload` is the WRONG question wherever
    // that transform fires. Rather than replicate upstream's rewrite policy here — which is what
    // CTK-ADR-0001 §3 forbids — we run the LIVE installer a second time into a throwaway config
    // dir and hash THAT. Upstream remains the only authority on its own transform; we merely
    // apply it to both sides before comparing. `--config-dir` takes priority over
    // CLAUDE_CONFIG_DIR, and HOME is redirected as well so any homedir() fallback inside the
    // installer lands in the sandbox and can never touch the user's real `~/.claude`.
    const projectedPayload = () => {
      ensureBuilt();
      const sandbox = path.join(tmp, '.enf21-projection');
      const sandboxHome = path.join(sandbox, 'home');
      const sandboxCfg = path.join(sandbox, 'cfg');
      mkdirSync(sandboxHome, { recursive: true });
      mkdirSync(sandboxCfg, { recursive: true });
      execFileSync(
        process.execPath,
        [path.join(tmp, 'bin', 'install.js'), '--claude', '--config-dir', sandboxCfg],
        {
          cwd: tmp,
          encoding: 'utf8',
          timeout: INSTALL_TIMEOUT_MS,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: Object.assign({}, process.env, { HOME: sandboxHome }),
        }
      );
      return O.payloadDigest(path.join(sandboxCfg, 'gsd-core'));
    };

    let mode = 'payload-verified';
    let engineVerified = false;

    if (O.payloadDigest(cloneRoot) === runtimePayload()) {
      // The byte-copy case: the transform is a no-op for this payload, so the raw comparison is
      // already conclusive and costs neither an `npm ci` nor an install.
      log('Installed payload already matches ' + tip.slice(0, 8) + ' — no reinstall needed.');
    } else {
      // Inconclusive, NOT yet drift: the difference may be the installer's transform rather than
      // a stale runtime. Build the projection to find out before mutating anything.
      log('Raw clone payload differs from the runtime — building an installer PROJECTION to');
      log('separate the installer transform from real drift (D-11) …');
      const projected = projectedPayload();

      if (projected === runtimePayload()) {
        log('Runtime payload MATCHES the projection of ' + tip.slice(0, 8) + ' — the raw');
        log('difference is the installer transform, not drift. No reinstall needed.');
        mode = 'projection-verified';
      } else {
        log('Runtime payload differs from the projection too — real drift. Reinstalling …');
        log('  node bin/install.js --claude …');
        execFileSync(process.execPath, [path.join(tmp, 'bin', 'install.js'), '--claude'], {
          cwd: tmp,
          encoding: 'utf8',
          timeout: INSTALL_TIMEOUT_MS,
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        // (5) Re-verify AGAINST THE PROJECTION — like with like. An install we cannot confirm is
        // never stamped (T-0ov-06). Before D-11 this compared against the RAW clone, which the
        // transform made unsatisfiable, so `sync` aborted permanently wherever it fired.
        if (runtimePayload() !== projected) {
          log('ENF-21 sync ABORTED: the reinstalled payload does not match the projection built');
          log('from the same tip by the same installer — refusing to stamp an install that');
          log('cannot be confirmed.');
          log('');
          log('The installer transform is already accounted for (D-11): both sides of this');
          log('comparison were produced by running `bin/install.js` on ' + tip.slice(0, 8) + ',');
          log('so a mismatch here is NOT the known transform. Something else is wrong — a');
          log('partial or failed install, a concurrent writer, or a non-deterministic installer.');
          log('');
          log('Do not work around it by hand-writing ~/.gsd-contrib/runtime-stamp.json — that');
          log('forges the very evidence the gate exists to check. See CTK-ADR-0007 §Decision.6.');
          return { code: 1, reason: 'post-install-mismatch' };
        }
        mode = 'installed';
        engineVerified = true;
      }
    }

    // (6) Stamp. The digest is over the WHOLE installed tree, so a later foreign reinstall
    // surfaces as `unverified` rather than a stamp that quietly lies.
    const stamp = O.buildStamp({
      sha: tip,
      runtimeDigest: O.runtimeDigest(runtimeRoot),
      mode,
      engineVerified,
      now: now(),
    });
    O.writeStamp(stamp);
    log('Stamped: sha=' + tip.slice(0, 8) + ' mode=' + mode + ' engine_verified=' + engineVerified);
    return { code: 0, mode, stamp };
  } catch (err) {
    log('ENF-21 sync ABORTED: ' + ((err && err.message) || 'unknown failure'));
    return { code: 1, reason: 'exception' };
  } finally {
    // (7) Always. Not a happy-path cleanup.
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch (_) {
      /* a tmpdir we cannot remove is not worth failing a successful sync over */
    }
  }
}

/**
 * argv dispatch. A bare invocation prints usage and exits NON-ZERO — it must never default to
 * the mutating subcommand.
 *
 * @param {string[]} argv the arguments after the script name
 * @param {Object} [deps]
 * @returns {number} the process exit code
 */
function main(argv, deps = {}) {
  const log = deps.log || ((l) => process.stdout.write(String(l) + '\n'));
  const sub = (argv && argv[0]) || '';
  if (sub === 'check') return (deps.checkImpl || check)(deps).code;
  if (sub === 'sync') return (deps.syncImpl || sync)(deps).code;
  log(USAGE);
  return 2;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = {
  check,
  sync,
  main,
  USAGE,
  NPM_CI_TIMEOUT_MS,
  INSTALL_TIMEOUT_MS,
  CLONE_TIMEOUT_MS,
};
