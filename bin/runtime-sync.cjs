#!/usr/bin/env node
'use strict';

/**
 * bin/runtime-sync.cjs — the ENF-21 runtime-freshness CLI.
 *
 *   node bin/runtime-sync.cjs check   read-only: print the drift verdict, mutate nothing
 *   node bin/runtime-sync.cjs sync    remediate: bring `<config dir>/gsd-core` to `origin/next`
 *                                     and stamp it — one command, no prompts, no decisions
 *   node bin/runtime-sync.cjs where   read-only: print the session's config dir, its
 *                                     classification, roots and state dir (CTK-ADR-0013)
 *
 * -- THE CONFIG DIR, AND THE DAILY-INSTALL REFUSAL (CTK-ADR-0013, quick 261024-po0) --------
 * Every verb first classifies the session's Claude config dir (CLAUDE_CONFIG_DIR when it is an
 * absolute path, else ~/.claude; hooks/lib/runtime-stamp.cjs classifyConfigDir). `sync` REFUSES
 * (exit 3) the daily ~/.claude and an invalid value BEFORE anything else: no tip lookup, no
 * tmpdir, no git, npm or install.js, no stamp. There is no override: the daily install has its
 * own maintainer (the local-mods refresh tool), and contribution work runs in its own config dir.
 * For a contribution dir, install.js gets `--claude --global --config-dir <cfg>` and
 * CLAUDE_CONFIG_DIR=<cfg>, and the stamp lands in that dir's own state dir.
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
 * `runtime_digest` (+ the managed-hook fields below). Do not quietly promote it to a gate input.
 *
 * ── THE MANAGED gsd-core HOOKS (CTK-ADR-0011, quick 261017-w1i) ─────────────────────────
 * gsd-core installs its hooks into `<config dir>/hooks` only from a BUILT `hooks/dist`, which is
 * gitignored and produced by `npm run build:hooks` alone (`npm ci`'s `prepare` runs build:lib
 * only). Without the build, install.js silently keeps the OLD hooks. So:
 *   - the fast path above may stamp ONLY when the payload digests are equal AND an early
 *     `npm run build:hooks` succeeds AND every managed hook in the built `hooks/dist` is
 *     byte-equal to its installed copy; any other outcome is inconclusive and reinstalls. In
 *     practice that last condition never holds: install.js replaces `{{GSD_VERSION}}` in every
 *     .js/.cjs/.sh hook it writes and the built hooks/dist keeps the placeholder, so every sync
 *     reinstalls (CTK-ADR-0011 Decision 7; removing the fast path is a follow-up);
 *   - the slow path runs `npm run build:hooks` between `npm ci` and install.js, and aborts with NO
 *     stamp when the build fails or leaves `hooks/dist` with no regular file;
 *   - after install.js, every managed hook must exist as a regular file under `<config dir>/hooks`
 *     whose later of mtime and ctime is no older than the install start minus HOOK_MTIME_SLACK_MS
 *     and no later than the post-install clock plus HOOK_MTIME_SLACK_MS (a future-dated file is stale)
 *     (ctime because a copy API may carry the source's mtime over, never its ctime). That proves each
 *     managed file was WRITTEN by this install, NOT that its bytes are right (install.js rewrites
 *     hook content, so bytes cannot be compared), and a concurrent writer inside the install window
 *     is not detected;
 *   - the stamp records `hooks_files` (the built `hooks/dist` inventory, never all of
 *     `~/.claude/hooks`) and `hooks_digest` measured at stamp time, which `check` and the gate
 *     re-measure on every call.
 * The build always runs as the child process `npm run build:hooks` in the clone with a bounded
 * timeout; the clone's scripts/build-hooks.js is never loaded into this process.
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
/** `npm run build:hooks` in the clone (CTK-ADR-0011). A timeout throws, which aborts with no stamp. */
const BUILD_HOOKS_TIMEOUT_MS = 120000;
/**
 * How far before the install start a managed hook's write time (the later of mtime and ctime) may
 * sit and still count as written by this install (filesystem timestamp granularity and clock skew).
 * Older is stale: abort, no stamp. The same slack is the upper bound: a write time later than the
 * post-install clock plus the slack is stale too. The name keeps "MTIME" for compatibility.
 */
const HOOK_MTIME_SLACK_MS = 2000;

/**
 * Did this install write every managed hook (CTK-ADR-0011)? For each relpath under `hooksRoot`:
 * a stat failure or a non-regular file is MISSING; a write time below
 * `sinceMs - HOOK_MTIME_SLACK_MS`, or above now + HOOK_MTIME_SLACK_MS (or no finite mtime or ctime at all), is STALE. The write time is
 * the later of `mtimeMs` and `ctimeMs`: install.js writes the top-level .js/.cjs/.sh hooks and a
 * subdirectory's .sh files with writeFileSync but copies everything else, including the lib/*.js
 * helpers, with copyFileSync, and a platform whose copy preserves the source mtime would otherwise
 * read a freshly copied file as stale. A copy cannot carry ctime over; the kernel sets it
 * on any write. A non-finite timestamp is ignored rather than allowed to poison the max. This
 * proves each file was WRITTEN (or had its metadata changed) during the install window, not that
 * its bytes are right, and it cannot see a concurrent writer inside that window.
 *
 * @param {string} hooksRoot the installed hooks dir
 * @param {string[]} files managed relpaths (POSIX)
 * @param {number} sinceMs the install start, captured immediately before install.js ran
 * @param {{statSync?:Function, nowMs?:Function}} [deps]
 * @returns {{missing:string[], stale:string[]}}
 */
function verifyHooksWritten(hooksRoot, files, sinceMs, deps = {}) {
  const statSync = deps.statSync || nodeFs.statSync;
  const floor = sinceMs - HOOK_MTIME_SLACK_MS;
  // Ceiling (review m1): a write time ahead of the clock cannot be a write by this install, so a
  // stale hook with a future mtime must not pass. Measured once, after install.js has returned.
  const nowMs = deps.nowMs || (() => Date.now());
  const ceiling = nowMs() + HOOK_MTIME_SLACK_MS;
  const missing = [];
  const stale = [];
  for (const rel of files) {
    let st;
    try {
      st = statSync(path.join(hooksRoot, ...String(rel).split('/')));
    } catch (_) {
      missing.push(rel);
      continue;
    }
    if (!st || typeof st.isFile !== 'function' || !st.isFile()) {
      missing.push(rel);
      continue;
    }
    const times = [st.mtimeMs, st.ctimeMs].map(Number).filter(Number.isFinite);
    const latest = Math.max(...times);
    if (times.length === 0 || !(latest >= floor) || !(latest <= ceiling)) stale.push(rel);
  }
  return { missing, stale };
}

/** The first line of an error message, for a one-line abort. */
function firstLine(err) {
  return String((err && err.message) || 'unknown failure').split('\n')[0];
}

/** How many characters of a child's stderr line an abort message may quote. */
const STDERR_LINE_MAX = 200;

/**
 * The first non-empty line of a failed child's captured stderr, with control characters removed
 * and bounded to STDERR_LINE_MAX, or '' when there is none. `execFileSync` puts the child's stderr
 * on `err.stderr`, while `err.message` keeps only "Command failed: ..." on its first line, so this
 * is the line that says WHY (for example npm's `Missing script: "build:hooks"`, CTK-ADR-0011).
 *
 * @param {*} err the thrown error
 * @returns {string}
 */
function firstStderrLine(err) {
  const raw = err && err.stderr;
  if (raw === undefined || raw === null) return '';
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
  for (const line of text.split(/\r?\n/)) {
    const t = line.replace(/[\u0000-\u001f\u007f]/g, '').trim();
    if (t) return t.length > STDERR_LINE_MAX ? t.slice(0, STDERR_LINE_MAX) + '...' : t;
  }
  return '';
}

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

  'usage: node bin/runtime-sync.cjs <check|sync|where>',
  '',
  '  The config dir is CLAUDE_CONFIG_DIR when it is an absolute path, else ~/.claude (CTK-ADR-0013).',
  '',
  '  check   read-only. Print the ENF-21 runtime-freshness verdict for <config dir>/gsd-core and exit:',
  '            0 = fresh, 1 = drifted/unstamped/unverified, 2 = the upstream tip is unobtainable,',
  '            3 = CLAUDE_CONFIG_DIR is invalid (empty, relative or starting with ~). Writes nothing.',
  '  sync    bring the installed gsd-core runtime at <config dir>/gsd-core to the current',
  '            open-gsd/gsd-core origin/next tip and stamp it. No prompts, no decisions.',
  '            Also builds (npm run build:hooks) and verifies the managed gsd-core hooks',
  '            under <config dir>/hooks, and stamps them (CTK-ADR-0011). In practice it reinstalls',
  '            on every run: install.js writes the package version into the managed hooks',
  '            ({{GSD_VERSION}}), so they never byte-match the clone and the fast path cannot fire.',
  '            Exit 3: sync refuses the daily ~/.claude (or a dir resolving into it) and an invalid',
  '            CLAUDE_CONFIG_DIR, before touching anything; no override. Start a contribution session.',
  '  where   read-only. Print the config dir, its classification (daily, contrib or invalid), the',
  '            runtime root, the hooks root and the state dir. Exit 0 for a contribution dir,',
  '            3 for the daily or an invalid dir. Writes nothing.',
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
 * Since CTK-ADR-0013 it measures the session's config dir: an invalid CLAUDE_CONFIG_DIR exits 3
 * before measuring anything; on the daily dir a non-fresh or unknown result also prints
 * CONTRIB_SESSION_HINT (codes 0/1/2 unchanged); a contribution dir's reasons name its absolute roots.
 *
 * @param {Object} [deps]
 * @param {Object} [deps.oracle] the runtime-stamp module (or a partial override)
 * @param {Object} [deps.env] the environment to classify (defaults to process.env)
 * @param {string} [deps.homedir] the home dir for the classification (defaults to os.homedir())
 * @param {string} [deps.runtimeRoot] defaults to the classified `<config dir>/gsd-core`
 * @param {string} [deps.hooksRoot] the managed hooks dir (defaults to the classified `<config dir>/hooks`)
 * @param {(line:string)=>void} [deps.log]
 * @returns {{code:number, verdict:string, reason?:string}}
 */
function check(deps = {}) {
  const O = oracleOf(deps.oracle);
  const log = deps.log || ((l) => process.stdout.write(String(l) + '\n'));
  const env = deps.env || process.env;
  const desc = O.classifyConfigDir(env, { homedir: deps.homedir });
  if (desc.kind === 'invalid') {
    log('ENF-21 runtime freshness: INVALID CONFIG DIR - ' + desc.reason);
    log('');
    log(O.CONTRIB_SESSION_HINT);
    return { code: 3, verdict: 'invalid-config-dir', reason: desc.reason };
  }
  const daily = desc.kind === 'daily';
  const hint = () => {
    if (!daily) return;
    log('');
    log(O.CONTRIB_SESSION_HINT);
  };
  const runtimeRoot = deps.runtimeRoot || desc.runtimeRoot;
  const hooksRoot = deps.hooksRoot || desc.hooksRoot;

  const digest = O.runtimeDigest(runtimeRoot);
  const stamp = O.readStamp({ stampPath: path.join(desc.stateDir, O.STAMP_FILENAME) });
  // CTK-ADR-0011: the same one helper the gate calls, measured on every call (no cache).
  const hooksDigest = O.hooksDigestForStamp(stamp, hooksRoot);

  let upstream;
  try {
    upstream = O.upstreamTip({ cachePath: path.join(desc.stateDir, O.CACHE_FILENAME) });
  } catch (err) {
    if (err instanceof O.UpstreamUnavailable || err instanceof defaultOracle.UpstreamUnavailable) {
      log('ENF-21 runtime freshness: UNKNOWN — ' + ((err && err.message) || 'the upstream tip is unobtainable'));
      log('  (this is a network limit, not drift; re-run when github is reachable)');
      hint();
      return { code: 2, verdict: 'unknown', reason: (err && err.message) || '' };
    }
    throw err;
  }

  const v = O.evaluateDrift({
    stamp,
    runtimeDigest: digest,
    hooksDigest,
    upstream,
    runtimeLabel: desc.runtimeLabel,
    hooksLabel: desc.hooksLabel,
  });
  if (v.verdict === 'fresh') {
    log('ENF-21 runtime freshness: fresh — ' + v.reason);
    return { code: 0, verdict: v.verdict, reason: v.reason };
  }
  log('ENF-21 runtime freshness: ' + v.verdict.toUpperCase() + ' — ' + v.reason);
  log('');
  log('Remediate with:');
  log('  ' + O.REMEDIATION_COMMAND);
  hint();
  return { code: 1, verdict: v.verdict, reason: v.reason };
}

/**
 * install.js overrides that would let it write outside, or through a symlink out of, the classified
 * config dir (review WR-04, quick 261024-po0 round 2; read at gsd-core origin/next 354d727b):
 * GSD_ALLOW_SYMLINKED_DEST disables its symlinked-destination guard, GSD_AGENTS_DIR redirects the
 * agents dir. Never forwarded to the install child.
 */
const INSTALL_ENV_STRIP = Object.freeze(['GSD_ALLOW_SYMLINKED_DEST', 'GSD_AGENTS_DIR']);

/** The install.js child env: the parent env minus INSTALL_ENV_STRIP, with the config dir set. */
function installEnv(env, configDirEnv, configDir) {
  const out = Object.assign({}, env, { [configDirEnv]: configDir });
  for (const k of INSTALL_ENV_STRIP) delete out[k];
  return out;
}

/**
 * `where` - READ-ONLY: print the session's config dir, its classification, the runtime root, the
 * hooks root and the state dir (CTK-ADR-0013). Exit 0 for a contribution dir, 3 for the daily or
 * an invalid dir (with the reason and CONTRIB_SESSION_HINT). Reads only (realpath); writes nothing.
 *
 * @param {Object} [deps] `oracle`, `env`, `homedir`, `log`
 * @returns {{code:number, kind:string}}
 */
function where(deps = {}) {
  const O = oracleOf(deps.oracle);
  const log = deps.log || ((l) => process.stdout.write(String(l) + '\n'));
  const env = deps.env || process.env;
  const desc = O.classifyConfigDir(env, { homedir: deps.homedir });
  const show = (v) => (typeof v === 'string' && v.length > 0 ? v : '(none)');
  log('config dir: ' + show(desc.configDir) + (desc.fromEnv ? ' (from CLAUDE_CONFIG_DIR)' : ' (CLAUDE_CONFIG_DIR unset)'));
  log('classification: ' + desc.kind);
  log('runtime root: ' + show(desc.runtimeRoot));
  log('hooks root: ' + show(desc.hooksRoot));
  log('state dir: ' + show(desc.stateDir));
  if (desc.kind === 'contrib') return { code: 0, kind: desc.kind };
  log('');
  log((desc.kind === 'daily' ? 'Not a contribution session: ' : 'Invalid config dir: ') + desc.reason);
  log(O.CONTRIB_SESSION_HINT);
  return { code: 3, kind: desc.kind };
}

/**
 * `sync` — the single, decision-free remediation.
 *
 *   1. resolve the current `origin/next` tip (`git ls-remote`);
 *   2. shallow-clone that branch into a tmpdir, then RACE-GUARD: the clone's HEAD must equal
 *      the resolved tip, else abort (the tip can move between the two calls);
 *   3. compare the clone's payload to the runtime's; when equal, run an early
 *      `npm run build:hooks` and compare every built `hooks/dist` file to its installed copy
 *      under `~/.claude/hooks`; all equal: stamp `payload-verified` and stop; an early build
 *      failure, an empty `hooks/dist` or any hook difference is INCONCLUSIVE and falls through
 *      (CTK-ADR-0011);
 *   0. classify the session's config dir and REFUSE (exit 3) the daily install or an invalid
 *      value before every other step (CTK-ADR-0013);
 *   4. otherwise (after the symlinked-root preflight, D-12) `npm ci` (which runs `prepare` →
 *      `build:lib`, producing the gitignored `bin/lib/*.cjs` the installer requires), then
 *      `npm run build:hooks` (a failure or an empty `hooks/dist` aborts WITHOUT stamping), then
 *      `node <tmp>/bin/install.js --claude --global --config-dir <cfg>` with CLAUDE_CONFIG_DIR=<cfg>
 *      in its env, with the install start captured just before it;
 *   5. RE-verify by payload INVENTORY (D-13 — invariant under both installer transforms), then
 *      check every managed hook was WRITTEN by this install (exists, the later of mtime and ctime
 *      not older than the install start minus HOOK_MTIME_SLACK_MS and not later than the
 *      post-install clock plus HOOK_MTIME_SLACK_MS; proves the write, not the
 *      bytes); on any
 *      mismatch abort WITHOUT stamping (T-0ov-06 — never stamp an install we could not confirm);
 *   6. stamp `installed` with a freshly computed whole-tree digest plus `hooks_files` (the built
 *      `hooks/dist` inventory) and `hooks_digest` (measured now). The stamp is the LAST write;
 *   7. remove the tmpdir in a `finally`, on the success AND the failure path.
 *
 * @param {Object} [deps] injectable seams, including `hooksRoot` (the managed hooks dir),
 *   `statSync` (the post-install check) and `nowMs` (the install-start clock)
 * @returns {{code:number, mode?:string, stamp?:Object, reason?:string}}
 */
function sync(deps = {}) {
  const O = oracleOf(deps.oracle);
  const log = deps.log || ((l) => process.stdout.write(String(l) + '\n'));
  const env = deps.env || process.env;

  // (0) CTK-ADR-0013: classify the session's config dir FIRST, and refuse the daily install and an
  // invalid value before ANY other step: no tip lookup, no tmpdir, no git, npm or install.js, no
  // stamp. There is no override (flag, env variable or prompt).
  const desc = O.classifyConfigDir(env, { homedir: deps.homedir });
  if (desc.kind !== 'contrib') {
    const daily = desc.kind === 'daily';
    log('ENF-21 sync REFUSED: the config dir is ' + (daily ? 'the daily install' : 'invalid') + ' - ' + desc.reason + '.');
    log(daily
      ? 'sync never reinstalls the daily install (it has its own maintainer); nothing was touched.'
      : 'sync never guesses a config dir; nothing was touched.');
    log('');
    log(O.CONTRIB_SESSION_HINT);
    return { code: 3, reason: daily ? 'refused-daily-config-dir' : 'refused-invalid-config-dir' };
  }

  const execFileSync = deps.execFileSync || require('node:child_process').execFileSync;
  const mkdtempSync = deps.mkdtempSync || nodeFs.mkdtempSync;
  const mkdirSync = deps.mkdirSync || nodeFs.mkdirSync;
  const rmSync = deps.rmSync || nodeFs.rmSync;
  const now = deps.now || (() => new Date().toISOString());
  const runtimeRoot = deps.runtimeRoot || desc.runtimeRoot;
  const hooksRoot = deps.hooksRoot || desc.hooksRoot;
  const stampFile = path.join(desc.stateDir, O.STAMP_FILENAME);
  const statSync = deps.statSync || nodeFs.statSync;
  const nowMs = deps.nowMs || (() => Date.now());
  log('Config dir: ' + desc.configDir + ' (runtime ' + runtimeRoot + ', hooks ' + hooksRoot + ', stamp ' + stampFile + ')');

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
    const distRoot = path.join(tmp, 'hooks', 'dist');

    // CTK-ADR-0011 (D1): the hooks are ALWAYS built by the child process `npm run build:hooks`
    // in the clone, bounded; the clone's scripts/build-hooks.js is never loaded in this process.
    const buildHooks = () => execFileSync('npm', ['run', 'build:hooks'], {
      cwd: tmp,
      encoding: 'utf8',
      timeout: BUILD_HOOKS_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let mode = 'payload-verified';
    let engineVerified = false;
    let hooksFiles = null;
    let fastPath = false;
    // CTK-ADR-0013 note (2026-10-24): a runtime root that is MISSING (ENOENT on it or a payload dir)
    // is "no existing runtime", the state of a fresh contribution dir: skip the fast-path compare and
    // take the slow path. Every other read error (EACCES, a non-directory, an unreadable file) still
    // throws to the caller's abort. `check` and the gate never reach this and still fail closed.
    let existingDigest = null;
    try {
      existingDigest = O.payloadDigest(runtimeRoot);
    } catch (err) {
      if (!(err && err.missingRoot === true)) throw err;
      log('No existing runtime at ' + runtimeRoot + ' (' + firstLine(err) + ') - skipping the fast-path compare.');
    }
    const payloadEqual = existingDigest !== null && O.payloadDigest(cloneRoot) === existingDigest;

    if (payloadEqual) {
      // Byte-equality with the raw clone. Only possible when BOTH install transforms happen to be
      // no-ops for this payload, but when it holds it is the strongest answer available and it
      // costs neither an `npm ci` nor an install. Since CTK-ADR-0011 it must ALSO hold for the
      // managed hooks (D7): a hooks-only upstream commit leaves the payload equal. With the real
      // installer the hook comparison cannot succeed while hooks carry `{{GSD_VERSION}}` (install.js
      // substitutes it, hooks/dist keeps it), so when reached this branch can only log
      // "inconclusive". On an installer-produced runtime it is not even reached: the payload rewrites
      // (CTK-ADR-0007 Decision 6) keep payloadEqual false (measured: a second sync with nothing
      // changed still printed "Installed payload differs from the raw clone").
      log('Installed payload already matches ' + tip.slice(0, 8) + ' - checking the managed gsd-core hooks ...');
      try {
        buildHooks();
        const early = O.hooksInventory(distRoot);
        if (early.length === 0) {
          log('  the early `npm run build:hooks` left hooks/dist with no regular file; the fast path is inconclusive.');
        } else if (early.some((rel) => !O.isManagedHookRel(rel))) {
          // Never stamp a name the stamp cannot carry; the slow path names it and aborts.
          log('  the built hooks/dist holds a name the runtime stamp cannot record; the fast path is inconclusive.');
        } else if (O.hooksDigest(distRoot, early) === O.hooksDigest(hooksRoot, early)) {
          hooksFiles = early;
          fastPath = true;
          log('  every managed hook (' + early.length + ') is byte-equal to the built hooks/dist - no reinstall needed.');
        } else {
          log('  the installed managed hooks under ' + hooksRoot + ' differ from the built hooks/dist; the fast path is inconclusive.');
        }
      } catch (err) {
        log('  the early `npm run build:hooks` check failed (' + firstLine(err) + '); the fast path is inconclusive.');
      }
    }

    if (!fastPath) {
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
      // NEVER collapse a symlinked runtime root automatically (D-12). This also guards the
      // CTK-ADR-0011 route in (payload equal, hooks different): GSD_ALLOW_SYMLINKED_DEST is never set.
      if (symlinkPreflight(runtimeRoot, log, deps).blocked) {
        return { code: 1, reason: 'symlinked-runtime-root' };
      }

      log(payloadEqual
        ? 'The managed gsd-core hooks could not be confirmed - reinstalling from ' + tip.slice(0, 8) + ' ...'
        : 'Installed payload differs from the raw clone — reinstalling from ' + tip.slice(0, 8) + ' …');
      log('  npm ci …');
      execFileSync('npm', ['ci'], {
        cwd: tmp,
        encoding: 'utf8',
        timeout: NPM_CI_TIMEOUT_MS,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      // CTK-ADR-0011 (D1): npm ci's `prepare` builds bin/lib only; install.js copies hooks only
      // from a BUILT hooks/dist and silently keeps the old ones without it. Build, or abort.
      log('  npm run build:hooks ...');
      try {
        buildHooks();
      } catch (err) {
        log('ENF-21 sync ABORTED: `npm run build:hooks` failed in the clone (' + firstLine(err) + ').');
        const why = firstStderrLine(err);
        if (why) log('  stderr: ' + why);
        log('No stamp was written: install.js copies the gsd-core hooks only from a built hooks/dist, so');
        log('installing now would keep the OLD managed hooks under ' + hooksRoot + ' (CTK-ADR-0011).');
        return { code: 1, reason: 'hooks-build-failed' };
      }
      hooksFiles = O.hooksInventory(distRoot);
      if (hooksFiles.length === 0) {
        log('ENF-21 sync ABORTED: `npm run build:hooks` exited 0 but ' + distRoot + ' (hooks/dist) holds no');
        log('regular file at depth 0 or 1, so install.js would copy no hooks and keep the OLD managed');
        log('hooks under ' + hooksRoot + '. No stamp was written (CTK-ADR-0011).');
        return { code: 1, reason: 'hooks-dist-empty' };
      }
      // CTK-ADR-0011 (D2/D4): the inventory must pass the same relpath rule hooksDigest and
      // validateStamp enforce. Checked BEFORE install.js: otherwise a name the stamp cannot carry
      // (a backslash, a control character, ...) would surface only at stamp time, after a full
      // install, as a generic exception.
      const unsafe = hooksFiles.filter((rel) => !O.isManagedHookRel(rel));
      if (unsafe.length > 0) {
        log('ENF-21 sync ABORTED: the built hooks/dist under ' + distRoot + ' holds ' + unsafe.length +
          ' name(s) the runtime stamp');
        log('cannot record safely (empty, absolute, a backslash, a control character, a `.` or `..`');
        log('segment, or deeper than one subdirectory): ' +
          unsafe.slice(0, 5).map((r) => JSON.stringify(r)).join(', ') + '.');
        log('install.js was not run and no stamp was written (CTK-ADR-0011).');
        return { code: 1, reason: 'hooks-dist-unsafe-name' };
      }

      log('  node bin/install.js --claude --global --config-dir ' + desc.configDir + ' ...');
      // Captured immediately BEFORE install.js: every managed hook it writes must be newer.
      const installStartMs = nowMs();
      // CTK-ADR-0013: the config dir is named explicitly (the flag beats the env in install.js, and
      // --global makes the scope explicit instead of relying on install.js's non-TTY default), and
      // the child env carries the same dir, so flag and env agree.
      execFileSync(process.execPath, [path.join(tmp, 'bin', 'install.js'), '--claude', '--global', '--config-dir', desc.configDir], {
        cwd: tmp,
        encoding: 'utf8',
        timeout: INSTALL_TIMEOUT_MS,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: installEnv(env, O.CONFIG_DIR_ENV, desc.configDir),
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
        log('Do not work around it by hand-writing the stamp (' + stampFile + ') - that');
        log('forges the very evidence the gate exists to check. See CTK-ADR-0007 §Decision.7.');
        return { code: 1, reason: 'post-install-mismatch' };
      }

      log('Verified: ' + want.length + ' payload files match ' + tip.slice(0, 8) + ' exactly.');

      // CTK-ADR-0011 (D3): every managed hook must have been WRITTEN by this install. Names alone
      // cannot catch the measured defect (the stale hooks carry the right names), and bytes cannot
      // be compared (install.js rewrites hook content), so the check is existence + the later of
      // mtime and ctime.
      const hv = verifyHooksWritten(hooksRoot, hooksFiles, installStartMs, { statSync, nowMs });
      if (hv.missing.length > 0 || hv.stale.length > 0) {
        log('ENF-21 sync ABORTED: install.js did not rewrite every managed gsd-core hook under');
        log(hooksRoot + ' - refusing to stamp an install that cannot be confirmed.');
        log('');
        log('This check proves each managed hook was WRITTEN by this install (a regular file whose');
        log('later of mtime and ctime is between the install start minus ' + HOOK_MTIME_SLACK_MS + ' ms and now plus ' + HOOK_MTIME_SLACK_MS + ' ms); it does');
        log('not prove the bytes. A miss here means the hooks were not installed where this tool measures');
        log('them (for example an install.js that ignored --config-dir), a partial install, or a filesystem');
        log('whose clock or timestamps lag the install start, or run ahead of the clock, by more than the slack.');
        if (hv.missing.length) log('  missing (' + hv.missing.length + '): ' + hv.missing.slice(0, 5).join(', '));
        if (hv.stale.length) log('  not rewritten (' + hv.stale.length + '): ' + hv.stale.slice(0, 5).join(', '));
        log('');
        log('Do not work around it by hand-writing the stamp (' + stampFile + ') - that');
        log('forges the very evidence the gate exists to check. See CTK-ADR-0011.');
        return { code: 1, reason: 'post-install-hooks-mismatch' };
      }
      log('Verified: ' + hooksFiles.length + ' managed gsd-core hooks were written by this install.');
      mode = 'installed';
      engineVerified = true;
    }

    // (6) Stamp. The digest is over the WHOLE installed tree, so a later foreign reinstall
    // surfaces as `unverified` rather than a stamp that quietly lies. The managed-hook fields bind
    // the built hooks/dist inventory and the hooks digest measured NOW (CTK-ADR-0011). The stamp is
    // the LAST write: any throw above (a timed-out or killed child included) leaves no stamp.
    const stamp = O.buildStamp({
      sha: tip,
      runtimeDigest: O.runtimeDigest(runtimeRoot),
      mode,
      engineVerified,
      now: now(),
      hooksFiles,
      hooksDigest: O.hooksDigest(hooksRoot, hooksFiles),
    });
    // CTK-ADR-0013: one classification per run decides where the stamp lands, the path where reports.
    O.writeStamp(stamp, { stampPath: stampFile });
    log('Stamped: sha=' + tip.slice(0, 8) + ' mode=' + mode + ' engine_verified=' + engineVerified + ' at ' + stampFile);
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
  if (sub === 'where') return (deps.whereImpl || where)(deps).code;
  log(USAGE);
  return 2;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = {
  symlinkPreflight,
  firstStderrLine,
  STDERR_LINE_MAX,
  verifyHooksWritten,
  check,
  sync,
  where,
  main,
  USAGE,
  NPM_CI_TIMEOUT_MS,
  INSTALL_TIMEOUT_MS,
  CLONE_TIMEOUT_MS,
  BUILD_HOOKS_TIMEOUT_MS,
  HOOK_MTIME_SLACK_MS,
  INSTALL_ENV_STRIP,
};
