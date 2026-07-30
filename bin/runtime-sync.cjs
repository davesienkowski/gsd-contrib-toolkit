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
 * ── WHY BYTE-EQUALITY CANNOT CONFIRM AN INSTALL (D-13, replaces D-11) ──────────────────
 * `bin/install.js` is NOT a byte-copy. It applies TWO transforms to the payload it writes:
 *   1. `/gsd:<cmd>` → `/gsd-<cmd>`, per the target descriptor's
 *      `hostBehaviors.hyphenNameAgentBody` (gsd-core #3583 / #3677) — config-INDEPENDENT.
 *   2. the CONFIG-DIR PATH is baked in (`copyWithPathReplacement`) — config-DEPENDENT.
 *      Measured on `workflows/note.md`: the repo says `~/.claude/notes/…`, an install to
 *      `~/.claude` writes `$HOME/.claude/notes/…`, and an install anywhere else writes that
 *      other path.
 *
 * D-11 tried to neutralise (1) by running the LIVE installer a second time into a throwaway
 * `--config-dir` and comparing against that projection. Transform (2) defeats it: a projection
 * must use a DIFFERENT config dir than the real install, so the two can never match. The
 * projection comparison could only ever FAIL, which is exactly what it did on first real use.
 *
 * D-13 compares the payload INVENTORY instead — the sorted file list across the four payload
 * dirs. Neither transform adds, removes, or renames a file, so the inventory is invariant under
 * both while still proving the tip's payload actually landed. This is deliberately weaker than
 * byte-equality and is described as such: it proves the right FILE SET, not the right bytes.
 * The raw byte comparison is kept as a fast path, since when it does hold it proves more.
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

/**
 * Refuse to reinstall over a SYMLINKED runtime root (D-12, corrected).
 *
 * A multi-runtime layout parks several runtimes side by side and makes `<root>/gsd-core` a
 * SYMLINK to whichever is active:
 *
 *   ~/.claude/gsd-core -> ~/.claude/gsd-core-next-edge
 *   ~/.claude/gsd-core-stable/   ~/.claude/gsd-core-edge/   ~/.claude/gsd-core-next-edge/
 *
 * `bin/install.js` refuses to write through such a destDir and names
 * `GSD_ALLOW_SYMLINKED_DEST=1` as the opt-out.
 *
 * ⚠️ THIS TOOL MUST NEVER SET THAT FLAG ITSELF. An earlier revision did, after verifying the
 * link stayed INSIDE the install root — reasoning the guard was about path CONFINEMENT. That
 * was wrong, and it was proven wrong destructively: the install REPLACED the symlink with a real
 * directory, so the switch was gone and the active sibling silently kept the OLD payload.
 * Containment is not the only thing that guard protects; the symlink LAYOUT is.
 *
 * Whether to collapse a deliberate symlink layout is the USER's decision, never an automatic
 * remediation's. So: abort with instructions. If the user genuinely wants it, they set
 * `GSD_ALLOW_SYMLINKED_DEST=1` in their own environment and re-run — that env is inherited
 * untouched, so their explicit choice still works.
 *
 * @param {string} runtimeRoot the `<install root>/gsd-core` path
 * @param {(l:string)=>void} log
 * @param {Object} [deps] injectable `lstatSync` / `realpathSync` / `env`
 * @returns {{blocked:boolean, target?:string}}
 */
function symlinkPreflight(runtimeRoot, log, deps = {}) {
  const lstatSync = deps.lstatSync || nodeFs.lstatSync;
  const realpathSync = deps.realpathSync || nodeFs.realpathSync;
  const env = deps.env || process.env;

  let isLink = false;
  try {
    isLink = lstatSync(runtimeRoot).isSymbolicLink();
  } catch (_) {
    return { blocked: false }; // absent → the installer will create it normally
  }
  if (!isLink) return { blocked: false };

  // The user's OWN explicit opt-in is honored — it is their layout and their call.
  if (env.GSD_ALLOW_SYMLINKED_DEST === '1') {
    log('NOTE: ' + runtimeRoot + ' is a symlink, and GSD_ALLOW_SYMLINKED_DEST=1 is set in your');
    log('environment. Proceeding — be aware the installer may REPLACE the symlink with a real');
    log('directory, collapsing a multi-runtime switch layout.');
    return { blocked: false };
  }

  let target = '(unresolvable)';
  try {
    target = realpathSync(runtimeRoot);
  } catch (_) { /* keep the placeholder */ }

  log('ENF-21 sync ABORTED: ' + runtimeRoot + ' is a SYMLINK to');
  log('  ' + target);
  log('');
  log('Reinstalling would let the installer REPLACE that symlink with a real directory,');
  log('collapsing what is almost certainly a deliberate multi-runtime switch layout — the');
  log('active sibling would silently keep the OLD payload. That is your decision, not this');
  log('tool\'s, so nothing has been written.');
  log('');
  log('Either:');
  log('  • point the symlink at the runtime you want and reinstall it yourself, or');
  log('  • collapse the layout deliberately:  GSD_ALLOW_SYMLINKED_DEST=1 <this command>');
  return { blocked: true, target };
}

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
 *   4. otherwise `npm ci` (which runs `prepare` → `build:lib`, producing the gitignored
 *      `bin/lib/*.cjs` the installer requires) then `node <tmp>/bin/install.js --claude`;
 *   5. RE-verify by payload INVENTORY (D-13 — invariant under both installer transforms); on
 *      mismatch abort WITHOUT stamping (T-0ov-06 — never stamp an install we could not
 *      confirm);
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

    // (3) The comparison (D-09, amended by D-13 — D-11's projection was UNSOUND, see below).
    const cloneRoot = path.join(tmp, 'gsd-core');

    let mode = 'payload-verified';
    let engineVerified = false;

    if (O.payloadDigest(cloneRoot) === O.payloadDigest(runtimeRoot)) {
      // Byte-equality with the raw clone. Only possible when BOTH install transforms happen to be
      // no-ops for this payload, but when it holds it is the strongest answer available and it
      // costs neither an `npm ci` nor an install.
      log('Installed payload already matches ' + tip.slice(0, 8) + ' — no reinstall needed.');
    } else {
      // D-13 — WHY NOT A PROJECTION (this replaces D-11):
      // D-11 tried to neutralise the installer's `/gsd:` → `/gsd-` rewrite by running the LIVE
      // installer into a throwaway `--config-dir` and comparing against THAT. It is unsound.
      // `bin/install.js` applies a SECOND transform: it bakes the CONFIG-DIR PATH into the
      // payload (`copyWithPathReplacement`). Measured on `workflows/note.md`:
      //     repo        `~/.claude/notes/…`
      //     real install `$HOME/.claude/notes/…`
      //     projection   `<sandbox>/cfg/notes/…`
      // A projection must use a DIFFERENT config dir than the real install, so its bytes can
      // never equal the real install's. The projection comparison could only ever fail.
      //
      // The sound comparison is the payload INVENTORY: neither transform adds, removes, or
      // renames a file, so the file SET is invariant under both while remaining a real check
      // that the tip's payload actually landed. It is honestly weaker than byte-equality —
      // it proves the right files, not the right bytes — and the stamp says so via
      // `engine_verified`.
      // NEVER collapse a symlinked runtime root automatically (D-12).
      if (symlinkPreflight(runtimeRoot, log, deps).blocked) {
        return { code: 1, reason: 'symlinked-runtime-root' };
      }

      log('Installed payload differs from the raw clone — reinstalling from ' + tip.slice(0, 8) + ' …');
      log('  npm ci …');
      execFileSync('npm', ['ci'], {
        cwd: tmp,
        encoding: 'utf8',
        timeout: NPM_CI_TIMEOUT_MS,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      log('  node bin/install.js --claude …');
      execFileSync(process.execPath, [path.join(tmp, 'bin', 'install.js'), '--claude'], {
        cwd: tmp,
        encoding: 'utf8',
        timeout: INSTALL_TIMEOUT_MS,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      // (5) Re-verify by INVENTORY. An install we cannot confirm is never stamped (T-0ov-06).
      const want = O.payloadInventory(cloneRoot);
      const got = O.payloadInventory(runtimeRoot);
      const missing = want.filter((f) => !got.includes(f));
      const extra = got.filter((f) => !want.includes(f));

      if (missing.length > 0 || extra.length > 0) {
        log('ENF-21 sync ABORTED: the reinstalled payload does not carry the same FILE SET as');
        log(tip.slice(0, 8) + ' — refusing to stamp an install that cannot be confirmed.');
        log('');
        log('This comparison is invariant under both known installer transforms (the');
        log('`/gsd:` → `/gsd-` rewrite and the baked-in config-dir path), so a mismatch here is');
        log('a genuinely wrong file set: a partial or failed install, or a concurrent writer.');
        if (missing.length) log('  missing (' + missing.length + '): ' + missing.slice(0, 5).join(', '));
        if (extra.length) log('  unexpected (' + extra.length + '): ' + extra.slice(0, 5).join(', '));
        log('');
        log('Do not work around it by hand-writing ~/.gsd-contrib/runtime-stamp.json — that');
        log('forges the very evidence the gate exists to check. See CTK-ADR-0007 §Decision.8.');
        return { code: 1, reason: 'post-install-mismatch' };
      }

      log('Verified: ' + want.length + ' payload files match ' + tip.slice(0, 8) + ' exactly.');
      mode = 'installed';
      engineVerified = true;
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
  symlinkPreflight,
  check,
  sync,
  main,
  USAGE,
  NPM_CI_TIMEOUT_MS,
  INSTALL_TIMEOUT_MS,
  CLONE_TIMEOUT_MS,
};
