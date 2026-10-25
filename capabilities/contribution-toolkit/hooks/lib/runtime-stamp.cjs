'use strict';

/**
 * hooks/lib/runtime-stamp.cjs — the ENF-21 RUNTIME-FRESHNESS ORACLE.
 *
 * ── WHAT THIS ANSWERS ───────────────────────────────────────────────────────────────────
 * "Is the globally-installed gsd-core runtime at `~/.claude/gsd-core` provably the same
 * gsd-core as `open-gsd/gsd-core` `origin/next` right now?"
 *
 * Since quick 261024-po0 (CTK-ADR-0013) "installed" means the SESSION's Claude config dir:
 * `CLAUDE_CONFIG_DIR` when it is an absolute path, else `~/.claude`. The runtime root is
 * `<config dir>/gsd-core`, the managed hooks live in `<config dir>/hooks`, and the toolkit state
 * (stamp, tip cache) is kept per config dir (the daily `~/.claude` keeps `~/.gsd-contrib`). An
 * empty, relative or `~`-prefixed value is INVALID and is refused, never normalized. See
 * classifyConfigDir below; every decision path calls the functions, never the load-time constants.
 *
 * That question matters because a contribution reviewed or filed against a STALE engine
 * produces "reproduced locally" results that do not match CI, and fixes that are already
 * upstream. This module is the single place that answers it; `hooks/runtime-drift.cjs`
 * (the blocking PreToolUse gate) and `bin/runtime-sync.cjs` (the remediation CLI) both
 * consume it, so the verdict cannot diverge between the two surfaces.
 *
 * ── WHY `VERSION` CANNOT BE THE ORACLE (finding #2) ─────────────────────────────────────
 * gsd-core's installer writes the runtime's VERSION file as `fs.writeFileSync(versionDest,
 * pkg.version)` (bin/install.js:11023) — the PLAIN package version (`1.8.0`), with no commit
 * SHA. Two different `next` commits published under the same package version are
 * indistinguishable there. The `+edge-probe (4f6935e2)` suffix a human once typed into that
 * file is not reproducible and is ERASED by the next reinstall. So freshness needs a
 * TOOLKIT-OWNED stamp, written by our own remediation path.
 *
 * ── WHY THE STAMP LIVES OUTSIDE `~/.claude/gsd-core` (D-01) ─────────────────────────────
 * `~/.claude/gsd-core` is a copy of the published package that every install REPLACES
 * WHOLESALE. Nothing written inside it survives. The stamp therefore lives at
 * `~/.gsd-contrib/runtime-stamp.json`, beside the existing OBS-01 user-level state
 * (`tool-log.jsonl`) — the established USER-level state dir for this toolkit.
 *
 * ── WHY `runtime_digest` EXISTS (D-02) ──────────────────────────────────────────────────
 * Because the stamp lives outside the tree it describes, a FOREIGN reinstall
 * (`npx @opengsd/gsd-core@latest --claude`, run by the user or by another tool) replaces
 * the runtime without touching our stamp — and the stamp would then silently LIE. So the
 * stamp records a sha256 over the installed tree, and every read recomputes it. A mismatch
 * is verdict `unverified`, which is DRIFT: not knowing what is installed is precisely the
 * condition this gate exists to catch.
 *
 * ── WHY THE STAMP ALSO BINDS THE MANAGED HOOKS (CTK-ADR-0011, quick 261017-w1i) ──────────
 * `runtime_digest` covers only `~/.claude/gsd-core`. gsd-core also installs its hooks into
 * `~/.claude/hooks`, and only from a BUILT `hooks/dist` (gitignored, produced by
 * `npm run build:hooks`, never by `npm ci`); with no `hooks/dist` the installer silently keeps
 * the OLD hooks. So a stamp written by a sync now also records `hooks_files` (the sorted relpaths
 * of the built `hooks/dist` inventory: top-level files plus one level of subdirectories, exactly
 * what install.js copies) and `hooks_digest` (a sha256 over those files as installed under
 * `~/.claude/hooks`). Limits, stated plainly:
 *   - the managed set is the built `hooks/dist` inventory, NEVER all of `~/.claude/hooks`: the
 *     user's own and local-mods files in that directory are never listed, read or required;
 *   - each listed file is read as UTF-8 TEXT through the bounded regular-file reader
 *     (CTK-ADR-0010 W5) and re-encoded, so two files that differ only in invalid UTF-8 sequences
 *     digest equal; a path that is not a regular file (FIFO, socket, device, directory, or a
 *     symlink to one) is framed MISSING without being opened, so it can never stall the gate;
 *   - the fields are ADDITIVE and STAMP_SCHEMA stays 1. A stamp without them is still readable,
 *     but evaluateDrift reports it `unverified` (it predates hook coverage), so every old stamp
 *     denies once until one `sync` re-stamps it.
 *
 * ── WHY `git ls-remote`, NEVER A CLONE FETCH (D-03, finding #5) ─────────────────────────
 * The local gsd-core clone's own `gsd-core/bin/lib/*.cjs` are GITIGNORED build artifacts and
 * are routinely STALER than the runtime — diffing against its working tree reports the
 * runtime as behind when the clone is the stale side. `git ls-remote` asks github directly,
 * touches no local clone, needs no auth, and returns in ~0.3 s. It is also never given a
 * shell, and always carries a 5 s timeout, so a hung network cannot eat the hook budget.
 *
 * ── SEVERITY POSTURE (D-05; recorded in CTK-ADR-0007) ───────────────────────────────────
 * The LOCAL half is fully fail-closed: a missing / malformed / digest-mismatched stamp
 * THROWS `FailClosed`, which `runGate` turns into a DENY (HARD-01 untouched). The ONE
 * deviation lives in the caller: when the upstream tip is genuinely unobtainable (network
 * down AND no cached tip within the 24 h budget) this module throws the DISTINCT
 * `UpstreamUnavailable`, and the gate maps that — and only that — to `ask`. A malformed
 * remote response is NOT an outage; it throws `FailClosed` and is never rescued by the cache.
 *
 * @module hooks/lib/runtime-stamp
 */

const nodeCrypto = require('node:crypto');
const nodeFs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { FailClosed } = require('./failclosed.cjs');
const { readRegularFileBounded, writeRegularFile } = require('./regular-file.cjs');
const { GSD_CORE_OWNER, GSD_CORE_REPO } = require('./resolve.cjs');
const { assertNotRealUserState } = require('./test-fence.cjs');

// ───────────────────────────── constants ─────────────────────────────

/** The variable that selects the session's Claude config dir (CTK-ADR-0013). */
const CONFIG_DIR_ENV = 'CLAUDE_CONFIG_DIR';

/** The subdirectory of the state dir that holds one state dir per non-daily config dir. */
const CONFIG_DIRS_SUBDIR = 'config-dirs';

/**
 * The installed gsd-core runtime this module measures BY DEFAULT: `<config dir>/gsd-core` for the
 * config dir in this process's environment at load time (CLAUDE_CONFIG_DIR when it is a valid
 * absolute path, else `~/.claude`). Computed from the environment only (no filesystem IO) and
 * wrapped so that nothing at load can throw: a hook that crashes at load fails open. Kept for
 * compatibility; every decision path calls classifyConfigDir / runtimeRootFor instead.
 */
const RUNTIME_ROOT = loadTimeRuntimeRoot();

/**
 * Where gsd-core's installer writes its managed hooks: the `hooks` directory beside the runtime
 * root (CTK-ADR-0011). Derived from RUNTIME_ROOT, so both move together; callers inject their own.
 */
const HOOKS_ROOT = path.join(path.dirname(RUNTIME_ROOT), 'hooks');

/**
 * The frame a LISTED but missing (or non-regular) managed hook contributes after its relpath:
 * 0x01 `MISSING` 0x00. A present file contributes 0x00 <bytes> 0x00 instead, so absence always
 * changes the digest and cannot be forged by an empty file or by a file whose text is `MISSING`.
 * A string, because Node cannot freeze a non-empty Buffer; hash it as latin1.
 */
const HOOK_MISSING_FRAME = '\u0001MISSING\u0000';

/** State-dir default (D-01) and the dedicated directory override. */
const STATE_DIRNAME = '.gsd-contrib';
const STATE_DIR_ENV = 'GSD_CONTRIB_STATE_DIR';
const STAMP_FILENAME = 'runtime-stamp.json';
const CACHE_FILENAME = 'upstream-tip-cache.json';

/** The stamp/cache schema version. A stamp at any other schema is FailClosed, not ignored. */
const STAMP_SCHEMA = 1;

/** Inside the TTL the cached tip is used and ZERO network calls happen (D-04). */
const TTL_MS = 15 * 60 * 1000;

/**
 * How long a cached tip may still ADJUDICATE once the network is unreachable (D-04). The TTL
 * governs *when to refetch*; the budget governs *how long a cached tip stays usable*. Past the
 * budget the verdict is `UpstreamUnavailable` → the gate's `ask`.
 */
const STALE_BUDGET_MS = 24 * 60 * 60 * 1000;

/**
 * Built from resolve.cjs's owner/repo — deliberately NOT a second source of truth (D-03).
 *
 * The load-bearing assertion below is not paranoia. Both constants were module-PRIVATE in
 * resolve.cjs until this module needed them, and a silent `undefined` composes into the
 * perfectly-shaped URL `https://github.com/undefined/undefined.git`, which `ls-remote` answers
 * with a plain "Repository not found" — i.e. an ordinary network failure, which D-05 maps to
 * `ask`. The gate would then have degraded to a permanent, silent, well-reasoned prompt against a
 * repo that does not exist. Fail LOUD at load instead.
 */
if (typeof GSD_CORE_OWNER !== 'string' || typeof GSD_CORE_REPO !== 'string' ||
    GSD_CORE_OWNER.length === 0 || GSD_CORE_REPO.length === 0) {
  throw new Error(
    'runtime-stamp: hooks/lib/resolve.cjs must export non-empty GSD_CORE_OWNER/GSD_CORE_REPO — ' +
      'got ' + JSON.stringify(GSD_CORE_OWNER) + '/' + JSON.stringify(GSD_CORE_REPO)
  );
}
const UPSTREAM_URL = 'https://github.com/' + GSD_CORE_OWNER + '/' + GSD_CORE_REPO + '.git';
const UPSTREAM_REF = 'next';

/** The `git ls-remote` spawn cap. A hung network must not eat the harness hook timeout. */
const LS_REMOTE_TIMEOUT_MS = 5000;

/**
 * Locate the real `bin/runtime-sync.cjs` by walking up from a starting directory.
 *
 * This is not over-engineering — a fixed `../../bin/runtime-sync.cjs` is WRONG for the copy of
 * this module that actually runs. `build-capability.cjs` projects `hooks/` + `hooks/lib/` into
 * `capabilities/contribution-toolkit/`, and the harness wires the BUNDLED path, so at gate time
 * `__dirname` is `capabilities/contribution-toolkit/hooks/lib`. Two levels up is the bundle root,
 * which has no `bin/` — the deny reason would have handed the user a path that does not exist,
 * which is the one thing a remediation string must never do. Walking up finds the repo root from
 * either location.
 *
 * @param {string} startDir
 * @param {{existsSync?:Function}} [deps]
 * @returns {string|null} absolute path to the CLI, or null when it is not reachable from here
 */
function resolveRemediationCli(startDir, deps = {}) {
  const existsSync = deps.existsSync || nodeFs.existsSync;
  let dir = path.resolve(startDir);
  for (let i = 0; i < 12; i += 1) {
    const candidate = path.join(dir, 'bin', 'runtime-sync.cjs');
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** The CLI this module's deny reasons point at, or null when it is not reachable. */
const REMEDIATION_CLI = resolveRemediationCli(path.resolve(__dirname, '..'));

/**
 * THE single remediation string. Every deny reason, the `ask` reason, the CLI's own output, and
 * both skill steps quote THIS constant, so the instruction cannot diverge across surfaces.
 *
 * When the CLI is genuinely unreachable — an adopter who installed only the published capability
 * bundle, with no toolkit checkout — the string degrades to a NAMED placeholder rather than an
 * absolute path that resolves to nothing. A user who cannot find the file is better served by
 * being told which repo it lives in than by a confident, broken path.
 */
const REMEDIATION_COMMAND = REMEDIATION_CLI
  ? 'node ' + REMEDIATION_CLI + ' sync'
  : 'node <gsd-contrib-toolkit>/bin/runtime-sync.cjs sync';

/**
 * THE single start-a-contribution-session text (CTK-ADR-0013). `runtime-sync where`, the sync
 * refusal, `check` on the daily dir and the ENF-21 gate on the daily dir all quote THIS constant,
 * the same single-source rule as REMEDIATION_COMMAND. It names no private tool or path.
 */
const CONTRIB_SESSION_HINT =
  'Contribution work (review sweeps, /gsd-submit, runtime-sync check and sync) runs in its own ' +
  'Claude config dir, never the daily ~/.claude. Start a contribution session in the gsd-core ' +
  'checkout with: CLAUDE_CONFIG_DIR=<absolute path, for example $HOME/.claude-contrib> claude. ' +
  'The value must be absolute: Claude Code reads a ~, empty or relative value against the working ' +
  'directory. With CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1 set, hooks and Bash do not see the variable ' +
  'and resolve the daily dir instead (CTK-ADR-0013).';

/**
 * The four PAYLOAD directories the installer projects from `<clone>/gsd-core/` into
 * `~/.claude/gsd-core/` (measured: 117 / 115 / 46 / 3 files, byte-identical). `bin/` is
 * deliberately absent — it is BUILT (`build:lib`) and does not exist in a fresh clone, which is
 * exactly why `sync`'s fast path can only claim `payload-verified`, never `engine_verified`
 * (D-09).
 */
const PAYLOAD_DIRS = Object.freeze(['workflows', 'references', 'templates', 'contexts']);

/** The three deny-shaped verdicts. Only `fresh` is allow-shaped. */
const DENY_VERDICTS = Object.freeze(['unstamped', 'unverified', 'drifted']);

const SHA40 = /^[0-9a-f]{40}$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

/**
 * The upstream tip could not be obtained: no network AND no cached tip inside the staleness
 * budget. DISTINCT from FailClosed on purpose — the gate maps THIS, and only this, to `ask`
 * (D-05). Everything else still denies. It deliberately does NOT extend FailClosed, so an
 * `instanceof FailClosed` check cannot accidentally swallow it (and vice versa).
 */
class UpstreamUnavailable extends Error {
  constructor(message) {
    super(message);
    this.name = 'UpstreamUnavailable';
  }
}

// ───────────────────────────── paths ─────────────────────────────

/**
 * Resolve the session's Claude config dir from an environment (CTK-ADR-0013). PURE: no IO.
 *
 *   CLAUDE_CONFIG_DIR absent or undefined  -> `<home>/.claude` (fromEnv false)
 *   empty or whitespace-only              -> INVALID (Claude Code reads it as the working directory)
 *   starting with `~`                     -> INVALID (Claude Code does not expand it; install.js does)
 *   relative                              -> INVALID (Claude Code reads it against the working directory)
 *   absolute                              -> path.resolve(value) (the value itself is never trimmed,
 *                                            expanded or otherwise normalized)
 *
 * An invalid value is never mapped to `~/.claude`: the installer and the session would then read
 * different dirs. Callers refuse it (sync, where, check) or deny (the gate).
 *
 * @param {Object} [env]
 * @param {string} [homedir] defaults to os.homedir()
 * @returns {{configDir:(string|null), fromEnv:boolean, invalid:boolean, reason?:string}}
 */
function resolveConfigDir(env, homedir) {
  const home = homedir === undefined ? os.homedir() : homedir;
  const value = env ? env[CONFIG_DIR_ENV] : undefined;
  if (value === undefined) {
    return { configDir: path.join(home, '.claude'), fromEnv: false, invalid: false };
  }
  const shown = CONFIG_DIR_ENV + '=' + JSON.stringify(value);
  const bad = (why) => ({ configDir: null, fromEnv: true, invalid: true, reason: shown + ' ' + why });
  if (typeof value !== 'string') return bad('is not a string; set it to an absolute path or unset it');
  if (value.trim() === '') {
    return bad('is empty: Claude Code reads an empty value as the working directory, so the session and ' +
      'the installer would use different dirs; set it to an absolute path or unset it');
  }
  if (value.startsWith('~')) {
    return bad('starts with ~, which Claude Code does not expand (it reads the value against the working ' +
      'directory) while install.js does; set it to an absolute path such as $HOME/.claude-contrib');
  }
  if (!path.isAbsolute(value)) {
    return bad('is a relative path, which Claude Code reads against the working directory; set it to an ' +
      'absolute path');
  }
  return { configDir: path.resolve(value), fromEnv: true, invalid: false };
}

/** The load-time RUNTIME_ROOT: env only, never IO, never a throw. */
function loadTimeRuntimeRoot() {
  try {
    const r = resolveConfigDir(process.env, os.homedir());
    if (!r.invalid && typeof r.configDir === 'string') return path.join(r.configDir, 'gsd-core');
  } catch (_) {
    /* fall through to the daily default */
  }
  return path.join(os.homedir(), '.claude', 'gsd-core');
}

/** Is `p` at or inside `base`, by a segment-wise test (so `/h/.claude-contrib` is not in `/h/.claude`)? */
function isAtOrInside(p, base) {
  const rel = path.relative(base, p);
  if (rel === '') return true;
  return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

/**
 * The top-level entries of a config dir that gsd-core's install.js writes (read at gsd-core
 * origin/next 354d727b). Any of them resolving into the daily install makes the dir daily: install.js
 * would write through it (review WR-04, quick 261024-po0 round 2). Other entries (rules/, CLAUDE.md,
 * user-owned links) are not written by install.js and are not checked.
 */
const INSTALL_WRITTEN_ENTRIES = Object.freeze([
  'gsd-core', 'hooks', 'agents', 'skills', 'commands', 'scripts', 'workflows', 'gsd-pristine',
  'gsd-migration-journal', 'settings.json', 'gsd-file-manifest.json',
]);

/** A classification that cannot be decided; classifyConfigDir turns it into `invalid` (refuse). */
class ClassificationUncertain extends Error {
  constructor(message) {
    super(message);
    this.name = 'ClassificationUncertain';
  }
}

/**
 * Why `configDir` is the daily install, or null when it is not (CTK-ADR-0013 Decision 4). Paths
 * are compared by realpath, falling back to the realpath of the deepest existing ancestor for a
 * path that does not exist yet. Daily when the dir IS a daily `<home>/.claude` (a symlink to it
 * included), lies inside it, contains it, or when one of INSTALL_WRITTEN_ENTRIES resolves at or
 * inside it. The daily dirs are `$HOME/.claude` AND `<passwd home>/.claude` (review WR-03), so a
 * changed HOME cannot unlock the account's real daily dir.
 *
 * THROWS ClassificationUncertain when it cannot decide (review WR-02): the passwd home is
 * unreadable, a dangling symlink chain passes 8 hops, or realpath/readlink fails with anything other
 * than "absent" (ENOENT) or "not a symlink" (EINVAL).
 *
 * @param {string} configDir
 * @param {{homedir?:string, userInfo?:Function, realpathSync?:Function, readlinkSync?:Function}} [opts]
 * @returns {(string|null)}
 */
function dailyConfigDirReason(configDir, opts = {}) {
  const home = opts.homedir === undefined ? os.homedir() : opts.homedir;
  const userInfo = opts.userInfo || os.userInfo;
  const realpathSync = opts.realpathSync || nodeFs.realpathSync;
  const readlinkSync = opts.readlinkSync || nodeFs.readlinkSync;
  let passwdHome;
  try {
    passwdHome = userInfo().homedir;
  } catch (e) {
    throw new ClassificationUncertain('the passwd home could not be read (' + (e && e.message) + ')');
  }
  if (typeof passwdHome !== 'string' || !path.isAbsolute(passwdHome)) {
    throw new ClassificationUncertain('the passwd home is not an absolute path: ' + JSON.stringify(passwdHome));
  }
  const code = (e) => (e && typeof e.code === 'string' ? e.code : 'UNKNOWN');
  // realpath, else (a path that does not exist yet) the realpath of its deepest existing ancestor
  // plus the rest. A DANGLING symlink is followed through readlink first (verifier finding, quick
  // 261024-po0): otherwise `cfg/hooks -> ~/.claude/<not yet>` would resolve to the link's own path
  // and the dir would read as a contribution dir.
  const rp = (p, hops = 0) => {
    const abs = path.resolve(p);
    try {
      return path.resolve(String(realpathSync(abs)));
    } catch (e) {
      if (code(e) !== 'ENOENT') {
        throw new ClassificationUncertain('realpath ' + abs + ' failed with ' + code(e));
      }
    }
    let target = null;
    try {
      target = String(readlinkSync(abs));
    } catch (e) {
      if (code(e) !== 'ENOENT' && code(e) !== 'EINVAL') {
        throw new ClassificationUncertain('readlink ' + abs + ' failed with ' + code(e));
      }
    }
    if (target !== null) {
      if (hops >= 8) throw new ClassificationUncertain('more than 8 dangling symlink hops at ' + abs);
      return rp(path.resolve(path.dirname(abs), target), hops + 1);
    }
    // Walking up to the parent shortens the path, so it terminates without spending a link hop.
    const parent = path.dirname(abs);
    return parent === abs ? abs : path.join(rp(parent, hops), path.basename(abs));
  };
  const dailies = [];
  for (const h of [home, passwdHome]) {
    const d = rp(path.join(h, '.claude'));
    if (!dailies.includes(d)) dailies.push(d);
  }
  const cfg = rp(configDir);
  for (const daily of dailies) {
    if (cfg === daily) return 'the config dir ' + configDir + ' is the daily install ' + daily;
    if (isAtOrInside(cfg, daily)) return 'the config dir ' + configDir + ' lies inside the daily install ' + daily;
    if (isAtOrInside(daily, cfg)) return 'the config dir ' + configDir + ' contains the daily install ' + daily;
  }
  for (const sub of INSTALL_WRITTEN_ENTRIES) {
    const r = rp(path.join(configDir, sub));
    for (const daily of dailies) {
      if (isAtOrInside(r, daily)) {
        return 'the config dir\'s ' + sub + ' (' + path.join(configDir, sub) + ') resolves to ' + r +
          ', inside the daily install ' + daily;
      }
    }
  }
  return null;
}

/**
 * @param {string} configDir
 * @param {{homedir?:string, realpathSync?:Function}} [opts]
 * @returns {boolean} true when `configDir` is (or resolves into) the daily `<home>/.claude`
 */
function isDailyConfigDir(configDir, opts = {}) {
  return dailyConfigDirReason(configDir, opts) !== null;
}

/** The state-dir override, trimmed, or null. */
function stateDirOverride(env) {
  const override = env && env[STATE_DIR_ENV];
  return typeof override === 'string' && override.trim().length > 0 ? override.trim() : null;
}

/** The per-config-dir state key: the first 16 hex of sha256(path.resolve(configDir)). */
function configDirKey(configDir) {
  return nodeCrypto.createHash('sha256').update(path.resolve(configDir)).digest('hex').slice(0, 16);
}

/**
 * Classify the session's config dir (CTK-ADR-0013). Reads only (realpath), writes nothing.
 *
 *   invalid -> every path null, `reason` says why (callers refuse or deny)
 *   daily   -> the daily `<home>/.claude` (or a dir resolving into it); tilde labels; the state dir
 *              stays `<home>/.gsd-contrib`, so the daily stamp path does not move
 *   contrib -> any other absolute dir; absolute labels; the state dir is
 *              `<home>/.gsd-contrib/config-dirs/<16 hex>`
 * GSD_CONTRIB_STATE_DIR, when set, is the state dir for daily and contrib alike.
 *
 * @param {Object} [env]
 * @param {{homedir?:string, realpathSync?:Function}} [opts]
 * @returns {{kind:string, fromEnv:boolean, value:(string|undefined), configDir:(string|null),
 *   runtimeRoot:(string|null), hooksRoot:(string|null), stateDir:(string|null),
 *   runtimeLabel:(string|null), hooksLabel:(string|null), reason:string}}
 */
function classifyConfigDir(env = process.env, opts = {}) {
  const home = opts.homedir === undefined ? os.homedir() : opts.homedir;
  const value = env ? env[CONFIG_DIR_ENV] : undefined;
  const r = resolveConfigDir(env, home);
  if (r.invalid) {
    return {
      kind: 'invalid', fromEnv: true, value, configDir: null, runtimeRoot: null, hooksRoot: null,
      stateDir: null, runtimeLabel: null, hooksLabel: null, reason: r.reason,
    };
  }
  const cfg = r.configDir;
  let why;
  try {
    why = r.fromEnv
      ? dailyConfigDirReason(cfg, {
        homedir: home, userInfo: opts.userInfo, realpathSync: opts.realpathSync, readlinkSync: opts.readlinkSync,
      })
      : CONFIG_DIR_ENV + ' is unset, so the session uses the daily ~/.claude';
  } catch (e) {
    // Any uncertainty refuses (review WR-02): never read as a contribution dir.
    return {
      kind: 'invalid', fromEnv: true, value, configDir: null, runtimeRoot: null, hooksRoot: null,
      stateDir: null, runtimeLabel: null, hooksLabel: null,
      reason: 'could not classify ' + CONFIG_DIR_ENV + '=' + JSON.stringify(value) + ': ' +
        String((e && e.message) || e) + '; refusing rather than treating it as a contribution dir',
    };
  }
  const daily = why !== null;
  const override = stateDirOverride(env);
  const stateDir = override !== null
    ? override
    : (daily ? path.join(home, STATE_DIRNAME) : path.join(home, STATE_DIRNAME, CONFIG_DIRS_SUBDIR, configDirKey(cfg)));
  return {
    kind: daily ? 'daily' : 'contrib',
    fromEnv: r.fromEnv,
    value,
    configDir: cfg,
    runtimeRoot: path.join(cfg, 'gsd-core'),
    hooksRoot: path.join(cfg, 'hooks'),
    stateDir,
    runtimeLabel: daily ? '~/.claude/gsd-core' : path.join(cfg, 'gsd-core'),
    hooksLabel: daily ? '~/.claude/hooks' : path.join(cfg, 'hooks'),
    reason: daily ? why : '',
  };
}

/** A classification that must be usable: an invalid config dir THROWS FailClosed. */
function usableConfigDir(env, opts) {
  const d = classifyConfigDir(env === undefined ? process.env : env, opts || {});
  if (d.kind === 'invalid') throw new FailClosed('ENF-21: ' + d.reason);
  return d;
}

/** @returns {string} `<config dir>/gsd-core` for the classified config dir (FailClosed on invalid). */
function runtimeRootFor(env = process.env, opts = {}) {
  return usableConfigDir(env, opts).runtimeRoot;
}

/** @returns {string} `<config dir>/hooks` for the classified config dir (FailClosed on invalid). */
function hooksRootFor(env = process.env, opts = {}) {
  return usableConfigDir(env, opts).hooksRoot;
}

/**
 * The toolkit's USER-level state directory (D-01), per config dir since CTK-ADR-0013. Mirrors
 * `tool-recorder.cjs`'s `GSD_CONTRIB_LOG_DIR` shape but uses its OWN variable: the log dir names
 * where the OBS-01 JSONL goes, and overloading it would move enforcement state as a side effect of
 * relocating a log.
 *
 *   GSD_CONTRIB_STATE_DIR set -> that dir, for every config dir (an invalid one included)
 *   daily config dir          -> `<home>/.gsd-contrib` (unchanged: outside readers bind to it)
 *   contribution config dir   -> `<home>/.gsd-contrib/config-dirs/<first 16 hex of sha256(path)>`
 *   invalid, no override      -> THROWS FailClosed
 *
 * @param {Object} [env]
 * @param {{homedir?:string, realpathSync?:Function}} [opts]
 * @returns {string}
 */
function resolveStateDir(env = process.env, opts = {}) {
  const override = stateDirOverride(env);
  if (override !== null) return override;
  return usableConfigDir(env || {}, opts).stateDir;
}

/** @param {Object} [env] @param {Object} [opts] @returns {string} absolute path to the runtime stamp. */
function stampPath(env = process.env, opts = {}) {
  return path.join(resolveStateDir(env, opts), STAMP_FILENAME);
}

/** @param {Object} [env] @param {Object} [opts] @returns {string} absolute path to the upstream-tip cache. */
function cachePath(env = process.env, opts = {}) {
  return path.join(resolveStateDir(env, opts), CACHE_FILENAME);
}

// ───────────────────────────── the tree digest (D-02) ─────────────────────────────

/**
 * sha256 over an installed tree: every file under `root`, sorted by POSIX-relative path, framed
 * as `<relpath>\0<file bytes>\0`.
 *
 * The framing is load-bearing: without the path in the hash, a rename would be invisible, and
 * without the NUL terminators `{ab:'c'}` and `{a:'bc'}` would collide. Sorting by the POSIX
 * relpath (a plain `Array#sort()`, not locale-aware) makes the digest stable across platforms
 * and independent of readdir order.
 *
 * Any path segment beginning with `.` is SKIPPED — `.git`, editor caches and other incidental
 * dot-state are not part of the installed payload and would make the digest unstable for
 * reasons that are not drift.
 *
 * @param {string} root absolute path to the tree to measure
 * @param {{readdirSync?:Function, readFileSync?:Function, statSync?:Function}} [deps]
 * @returns {string} `sha256:<hex>`
 * @throws {FailClosed} when the root is missing or is not a directory
 */
function runtimeDigest(root, deps = {}) {
  const readdirSync = deps.readdirSync || nodeFs.readdirSync;
  const readFileSync = deps.readFileSync || nodeFs.readFileSync;
  const statSync = deps.statSync || nodeFs.statSync;

  let st;
  try {
    st = statSync(root);
  } catch (err) {
    throw new FailClosed(
      'ENF-21: the gsd-core runtime root is missing or unreadable at ' + root +
        ' (' + ((err && err.message) || 'stat failure') + ') — cannot verify runtime freshness'
    );
  }
  if (!st || !st.isDirectory()) {
    throw new FailClosed('ENF-21: the gsd-core runtime root is not a directory: ' + root);
  }

  /** @type {string[]} POSIX-relative paths of every non-dot file under root. */
  const rels = [];
  const walk = (dir, relPrefix) => {
    let names;
    try {
      names = readdirSync(dir);
    } catch (err) {
      throw new FailClosed(
        'ENF-21: could not read the runtime directory ' + dir +
          ' (' + ((err && err.message) || 'readdir failure') + ')'
      );
    }
    for (const name of names) {
      if (typeof name !== 'string' || name.length === 0) continue;
      if (name.startsWith('.')) continue; // dot-state is not payload
      const abs = path.join(dir, name);
      const rel = relPrefix === '' ? name : relPrefix + '/' + name;
      let entryStat;
      try {
        entryStat = statSync(abs);
      } catch (_) {
        continue; // a vanished entry (race) is not payload we can measure
      }
      if (entryStat.isDirectory()) walk(abs, rel);
      else rels.push(rel);
    }
  };
  walk(root, '');

  rels.sort();

  const hash = nodeCrypto.createHash('sha256');
  const NUL = Buffer.from([0]);
  for (const rel of rels) {
    hash.update(Buffer.from(rel, 'utf8'));
    hash.update(NUL);
    let body;
    try {
      body = readFileSync(path.join(root, ...rel.split('/')));
    } catch (err) {
      throw new FailClosed(
        'ENF-21: could not read the runtime file ' + rel +
          ' (' + ((err && err.message) || 'read failure') + ')'
      );
    }
    hash.update(Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8'));
    hash.update(NUL);
  }
  return 'sha256:' + hash.digest('hex');
}

/**
 * The PAYLOAD INVENTORY (D-13): the sorted `<dir>/<relative path>` list across the four payload
 * directories — names only, no content.
 *
 * WHY NAMES: `bin/install.js` applies TWO content transforms when it writes the payload, and a
 * byte comparison is defeated by the second one.
 *   1. `/gsd:<cmd>` → `/gsd-<cmd>` (`hostBehaviors.hyphenNameAgentBody`) — config-independent.
 *   2. the CONFIG-DIR path is baked in (`copyWithPathReplacement`): the same source line renders
 *      as `~/.claude/notes/…` in the repo, `$HOME/.claude/notes/…` when installed to `~/.claude`,
 *      and `<sandbox>/cfg/notes/…` when installed anywhere else.
 * Transform 2 makes any two installs with DIFFERENT config dirs differ by construction — which is
 * why comparing a real install against a sandboxed "projection" can never succeed.
 *
 * The inventory is invariant under BOTH transforms (neither adds, removes, or renames a file), so
 * it is a sound cross-install comparison. It is genuinely weaker than byte-equality — it proves
 * the right FILE SET, not the right bytes — and callers must describe it honestly.
 *
 * @param {string} root the directory CONTAINING the four payload dirs
 * @param {Object} [deps] injectable `readdirSync`
 * @returns {string[]} sorted relative paths, prefixed by their payload dir
 */
function payloadInventory(root, deps = {}) {
  const readdirSync = deps.readdirSync || nodeFs.readdirSync;
  const out = [];
  for (const dir of PAYLOAD_DIRS) {
    const base = path.join(root, dir);
    const walk = (abs, rel) => {
      let entries;
      try {
        entries = readdirSync(abs, { withFileTypes: true });
      } catch (_) {
        return; // an absent payload dir contributes nothing; the caller compares the whole list
      }
      for (const e of entries.slice().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
        const childRel = rel ? rel + '/' + e.name : e.name;
        if (e.isDirectory()) walk(path.join(abs, e.name), childRel);
        else out.push(dir + '/' + childRel);
      }
    };
    walk(base, '');
  }
  return out.sort();
}

/**
 * The PAYLOAD digest (D-09): a digest of only the four installer-projected directories, used by
 * `bin/runtime-sync.cjs` to compare a fresh clone against the installed runtime. It answers the
 * NARROWER question "does the runtime's payload equal `next`'s?" — it cannot see `bin/`, which
 * is built and absent from a fresh clone. Hence `mode:'payload-verified', engine_verified:false`.
 *
 * @param {string} root the directory CONTAINING the four payload dirs
 * @param {Object} [deps] forwarded to runtimeDigest
 * @returns {string} `sha256:<hex>` over the concatenated per-directory digests
 */
function payloadDigest(root, deps = {}) {
  const hash = nodeCrypto.createHash('sha256');
  for (const dir of PAYLOAD_DIRS) {
    hash.update(dir);
    hash.update('\0');
    hash.update(runtimeDigest(path.join(root, dir), deps));
    hash.update('\0');
  }
  return 'sha256:' + hash.digest('hex');
}

// ───────────────────────────── the managed gsd-core hooks (CTK-ADR-0011) ─────────────────────────────

/**
 * Is `rel` a managed-hook relpath this toolkit will join under a hooks root? A non-empty POSIX
 * relpath of ONE or TWO non-empty segments (install.js copies `hooks/dist` top-level files and one
 * level of subdirectories), with no backslash, no control character (below 0x20, or 0x7f), no
 * leading slash, and no `.` or `..` segment. This is the path-traversal guard for a stamp's
 * user-writable `hooks_files`: nothing that fails it is ever joined or read.
 *
 * @param {*} rel
 * @returns {boolean}
 */
function isManagedHookRel(rel) {
  if (typeof rel !== 'string' || rel.length === 0) return false;
  if (rel.includes('\\')) return false;
  for (let i = 0; i < rel.length; i += 1) {
    const c = rel.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return false;
  }
  if (rel.startsWith('/')) return false;
  const segs = rel.split('/');
  if (segs.length > 2) return false;
  return segs.every((seg) => seg.length > 0 && seg !== '.' && seg !== '..');
}

/**
 * The managed hook INVENTORY of a built `hooks/dist`: mirrors gsd-core's
 * `installSharedHooksBundle` exactly. Each top-level entry is stat'ed (symlinks FOLLOWED, as
 * install.js does); a regular file adds its name, a directory adds each REGULAR-file child as
 * `<dir>/<child>`, and anything deeper or non-regular is skipped. Dot-names are KEPT, because
 * install.js copies them. A root that is absent, unreadable or not a directory is `[]`, never a
 * throw: the caller decides what an empty inventory means.
 *
 * @param {string} root absolute path to the hooks dir to list (a clone's `hooks/dist`)
 * @param {{readdirSync?:Function, statSync?:Function}} [deps]
 * @returns {string[]} POSIX relpaths, sorted by plain Array#sort
 */
function hooksInventory(root, deps = {}) {
  const readdirSync = deps.readdirSync || nodeFs.readdirSync;
  const statSync = deps.statSync || nodeFs.statSync;
  const statOf = (abs) => {
    try {
      return statSync(abs);
    } catch (_) {
      return null; // a vanished or unreadable entry is not a file install.js would copy
    }
  };
  let names;
  try {
    names = readdirSync(root);
  } catch (_) {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (typeof name !== 'string' || name.length === 0) continue;
    const abs = path.join(root, name);
    const st = statOf(abs);
    if (!st) continue;
    if (st.isFile()) {
      out.push(name);
      continue;
    }
    if (!st.isDirectory()) continue;
    let kids;
    try {
      kids = readdirSync(abs);
    } catch (_) {
      continue;
    }
    for (const kid of kids) {
      if (typeof kid !== 'string' || kid.length === 0) continue;
      const kst = statOf(path.join(abs, kid));
      if (kst && kst.isFile()) out.push(name + '/' + kid);
    }
  }
  return out.sort();
}

/**
 * sha256 over a LISTED set of managed hooks under `root` (CTK-ADR-0011, D4 framing), over a sorted
 * COPY of `files` so the list order never matters:
 *
 *   present regular file   utf8(rel) 0x00 <bytes> 0x00
 *   missing / non-regular  utf8(rel) HOOK_MISSING_FRAME   (0x01 MISSING 0x00)
 *
 * Only listed files are read, so an unlisted file under `root` never moves the digest. Each path
 * is stat'ed first; a stat failure or anything that is not a regular file is framed MISSING
 * WITHOUT being opened, so a FIFO, socket, device or directory can never block the gate. A regular
 * file is read through the bounded regular-file reader (CTK-ADR-0010 W5) as UTF-8 text and
 * re-encoded; an injected reader may return a Buffer. A read failure on a regular file is
 * FailClosed (a hook we cannot read is not a hook we have verified).
 *
 * @param {string} root absolute path to the hooks dir
 * @param {string[]} files managed relpaths (each must pass isManagedHookRel)
 * @param {{statSync?:Function, readFileSync?:Function}} [deps]
 * @returns {string} `sha256:<hex>`
 * @throws {FailClosed} when `files` is not an array, an entry is not a managed relpath, or a
 *   regular file cannot be read
 */
function hooksDigest(root, files, deps = {}) {
  if (!Array.isArray(files)) {
    throw new FailClosed('ENF-21: the managed gsd-core hook list is not an array: ' + JSON.stringify(files));
  }
  for (const rel of files) {
    if (!isManagedHookRel(rel)) {
      throw new FailClosed(
        'ENF-21: ' + JSON.stringify(rel) + ' is not a managed hook relpath (one or two plain POSIX ' +
          'segments, no `.`/`..`, no backslash, no control character)'
      );
    }
  }
  const statSync = deps.statSync || nodeFs.statSync;
  // The default drops any encoding argument: the shared reader's second parameter is its byte cap.
  const readFileSync = deps.readFileSync || ((p) => readRegularFileBounded(p));

  const hash = nodeCrypto.createHash('sha256');
  const NUL = Buffer.from([0]);
  const MISSING = Buffer.from(HOOK_MISSING_FRAME, 'latin1');
  for (const rel of files.slice().sort()) {
    hash.update(Buffer.from(rel, 'utf8'));
    const abs = path.join(root, ...rel.split('/'));
    let st = null;
    try {
      st = statSync(abs);
    } catch (_) {
      st = null;
    }
    if (!st || typeof st.isFile !== 'function' || !st.isFile()) {
      hash.update(MISSING);
      continue;
    }
    let body;
    try {
      body = readFileSync(abs);
    } catch (err) {
      throw new FailClosed(
        'ENF-21: could not read the managed gsd-core hook ' + rel + ' under ' + root +
          ' (' + ((err && err.message) || 'read failure') + ')'
      );
    }
    hash.update(NUL);
    hash.update(Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8'));
    hash.update(NUL);
  }
  return 'sha256:' + hash.digest('hex');
}

/**
 * The ONE measurement helper `check` and the gate both call (no module-level cache, so a sync
 * that lands between two calls is seen by the next one). Null, with NO filesystem access, when
 * there is no stamp or the stamp carries no `hooks_files` (evaluateDrift then reports the stamp as
 * predating hook coverage); otherwise hooksDigest over the stamp's own list.
 *
 * @param {(Object|null|undefined)} stamp a validated stamp
 * @param {string} [root] the hooks dir (defaults to HOOKS_ROOT)
 * @param {Object} [deps] forwarded to hooksDigest
 * @returns {(string|null)}
 */
function hooksDigestForStamp(stamp, root, deps = {}) {
  if (stamp === null || stamp === undefined || typeof stamp !== 'object') return null;
  if (!Array.isArray(stamp.hooks_files)) return null;
  return hooksDigest(root === undefined ? HOOKS_ROOT : root, stamp.hooks_files, deps);
}

// ───────────────────────────── the stamp ─────────────────────────────

/**
 * Validate a stamp object. THROWS FailClosed on anything we cannot trust — a stamp we cannot
 * read is not "no stamp", it is "we do not know what is installed", which is drift.
 *
 * @param {*} obj
 * @param {string} where a short label for the error message
 * @returns {Object} the validated stamp
 * @throws {FailClosed}
 */
function validateStamp(obj, where) {
  const bad = (why) => new FailClosed('ENF-21: the runtime stamp (' + where + ') is unusable — ' + why);
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) throw bad('not a JSON object');
  if (obj.schema !== STAMP_SCHEMA) {
    throw bad('schema ' + JSON.stringify(obj.schema) + ' is not the expected ' + STAMP_SCHEMA);
  }
  if (typeof obj.sha !== 'string' || !SHA40.test(obj.sha)) {
    throw bad('`sha` is not a 40-hex commit id');
  }
  if (typeof obj.runtime_digest !== 'string' || !DIGEST_RE.test(obj.runtime_digest)) {
    throw bad('`runtime_digest` is not a `sha256:<64-hex>` digest');
  }
  // CTK-ADR-0011: the managed-hook binding is ADDITIVE. Both fields absent is a legacy stamp (it
  // reads back, and evaluateDrift reports it unverified); if either is present, both must be, and
  // both must be well-formed, because `hooks_files` steers which paths the gate reads.
  const hasFiles = obj.hooks_files !== undefined;
  const hasDigest = obj.hooks_digest !== undefined;
  if (hasFiles !== hasDigest) {
    throw bad(hasFiles ? '`hooks_files` is present without `hooks_digest`' : '`hooks_digest` is present without `hooks_files`');
  }
  if (hasFiles) {
    const files = obj.hooks_files;
    if (!Array.isArray(files) || files.length === 0) {
      throw bad('`hooks_files` is not a non-empty array of managed hook relpaths');
    }
    for (let i = 0; i < files.length; i += 1) {
      if (!isManagedHookRel(files[i])) {
        throw bad('`hooks_files` entry ' + JSON.stringify(files[i]) + ' is not a managed hook relpath');
      }
      if (i > 0 && !(files[i - 1] < files[i])) {
        throw bad('`hooks_files` is not sorted and unique (at ' + JSON.stringify(files[i]) + ')');
      }
    }
    if (typeof obj.hooks_digest !== 'string' || !DIGEST_RE.test(obj.hooks_digest)) {
      throw bad('`hooks_digest` is not a `sha256:<64-hex>` digest');
    }
  }
  return obj;
}

/**
 * Read the toolkit-owned runtime stamp.
 *
 * The default reader is the shared bounded, regular-file-only reader (W5): a stamp path that is
 * a FIFO, socket, device or directory (or a symlink to one), or is over the 1 MiB read cap, is
 * refused at once instead of blocking the hook past its harness timeout, and lands in the same
 * "exists but could not be read" FailClosed below. Only ENOENT is the unstamped null, so a planted
 * special file is never read as absent (that would let an offline run turn the deny into an ask).
 *
 * @param {{readFileSync?:Function, stampPath?:string, env?:Object, homedir?:string}} [deps]
 * @returns {Object|null} the stamp, or null when the file is ABSENT (the unstamped case)
 * @throws {FailClosed} on malformed JSON, a wrong schema, a bad sha/digest, or an unreadable,
 *   non-regular or oversized (but present) file: fail-closed, never a guessed null
 */
function readStamp(deps = {}) {
  // The default drops the encoding argument: the shared reader's second parameter is its byte cap.
  const readFileSync = deps.readFileSync || ((p) => readRegularFileBounded(p));
  const file = deps.stampPath || stampPath(deps.env, { homedir: deps.homedir });

  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null; // genuinely unstamped
    throw new FailClosed(
      'ENF-21: the runtime stamp at ' + file + ' exists but could not be read (' +
        ((err && err.message) || 'read failure') + ')'
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(String(raw));
  } catch (err) {
    throw new FailClosed(
      'ENF-21: the runtime stamp at ' + file + ' is not valid JSON (' +
        ((err && err.message) || 'parse failure') + ') — re-stamp with: ' + REMEDIATION_COMMAND
    );
  }
  return validateStamp(parsed, file);
}

/**
 * Write the runtime stamp. The stamp is VALIDATED before it is written, so this path can never
 * produce a stamp `readStamp` would reject (a self-inflicted permanent deny).
 *
 * @param {Object} stamp
 * @param {{writeFileSync?:Function, mkdirSync?:Function, stampPath?:string, env?:Object,
 *   homedir?:string}} [deps]
 * @returns {string} the path written
 */
function writeStamp(stamp, deps = {}) {
  const writeFileSync = deps.writeFileSync || nodeFs.writeFileSync;
  const mkdirSync = deps.mkdirSync || nodeFs.mkdirSync;
  const file = deps.stampPath || stampPath(deps.env, { homedir: deps.homedir });
  validateStamp(stamp, 'about to be written');
  assertNotRealUserState(file); // under node --test only (quick 261024-po0 incident)
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(stamp, null, 2) + '\n', { encoding: 'utf8' });
  return file;
}

/**
 * Build a well-formed stamp object. With `hooksFiles` it also emits `hooks_files` (a sorted COPY)
 * and `hooks_digest` (CTK-ADR-0011); without it the legacy shape is unchanged.
 *
 * @param {{sha:string, runtimeDigest:string, mode:string, engineVerified:boolean, now?:string,
 *   hooksFiles?:string[], hooksDigest?:string}} f
 * @returns {Object}
 */
function buildStamp(f) {
  const stamp = {
    schema: STAMP_SCHEMA,
    sha: f.sha,
    runtime_digest: f.runtimeDigest,
    mode: f.mode,
    engine_verified: f.engineVerified === true,
    installed_at: f.now || new Date().toISOString(),
    source: UPSTREAM_URL + '#' + UPSTREAM_REF,
  };
  if (f.hooksFiles !== undefined && f.hooksFiles !== null) {
    stamp.hooks_files = Array.isArray(f.hooksFiles) ? f.hooksFiles.slice().sort() : f.hooksFiles;
    stamp.hooks_digest = f.hooksDigest;
  }
  return stamp;
}

// ───────────────────────────── the upstream tip ─────────────────────────────

/**
 * Ask github for the current `refs/heads/next` tip via `git ls-remote` — no shell, a hard 5 s
 * timeout, and NO contact with any local clone (finding #5).
 *
 * PARSING IS STRICT BY DESIGN (T-0ov-02): the response is remote-controlled input that steers a
 * deny/allow, so only a line of exactly `<40-hex>\trefs/heads/next` is accepted. Anything else —
 * a different ref, a non-hex first field, an empty response — throws `FailClosed`, never a
 * guessed tip. A SPAWN/network failure is a different thing entirely and throws
 * `UpstreamUnavailable` so the caller can fall back to the cache (and ultimately to `ask`).
 *
 * @param {{execFileSync?:Function}} [deps]
 * @returns {string} the 40-hex tip
 */
function fetchTipLive(deps = {}) {
  const execFileSync = deps.execFileSync || require('node:child_process').execFileSync;
  let out;
  try {
    out = execFileSync('git', ['ls-remote', UPSTREAM_URL, UPSTREAM_REF], {
      encoding: 'utf8',
      timeout: LS_REMOTE_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
  } catch (err) {
    throw new UpstreamUnavailable(
      'could not reach ' + UPSTREAM_URL + ' (' + ((err && err.message) || 'ls-remote failure') + ')'
    );
  }

  const wanted = 'refs/heads/' + UPSTREAM_REF;
  for (const line of String(out == null ? '' : out).split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length !== 2) continue;
    if (parts[1] !== wanted) continue;
    if (!SHA40.test(parts[0])) break; // a non-hex sha on the right ref is tampering, not a miss
    return parts[0];
  }
  throw new FailClosed(
    'ENF-21: `git ls-remote ' + UPSTREAM_URL + ' ' + UPSTREAM_REF + '` returned no clean ' +
      '`<40-hex> ' + wanted + '` line — refusing to guess an upstream tip'
  );
}

/**
 * Validate a cache entry. Returns the entry, or null when it is unusable — a corrupt or
 * foreign-URL cache is treated as ABSENT (refetch), never trusted and never fatal.
 *
 * @param {*} entry
 * @param {number} nowMs
 * @returns {{entry:Object, ageMs:number}|null}
 */
function usableCache(entry, nowMs) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null;
  if (entry.schema !== STAMP_SCHEMA) return null;
  if (entry.url !== UPSTREAM_URL || entry.ref !== UPSTREAM_REF) return null;
  if (typeof entry.sha !== 'string' || !SHA40.test(entry.sha)) return null;
  const fetchedAt = Date.parse(entry.fetched_at);
  if (!Number.isFinite(fetchedAt)) return null;
  const ageMs = nowMs - fetchedAt;
  if (ageMs < 0) return null; // a cache dated in the future is not evidence of anything
  return { entry, ageMs };
}

/**
 * Read the upstream-tip cache. A cache MISS or a corrupt cache is null, never an error — the
 * cache is a latency optimization plus an outage cushion, not a source of authority.
 * The default reader is the shared bounded, regular-file-only reader (W5), so a cache path that
 * is a FIFO, socket, device or directory (or a symlink to one), or is over the 1 MiB read cap, is
 * a miss at once rather than a read that blocks the hook past its harness timeout.
 *
 * @param {{readFileSync?:Function, cachePath?:string, env?:Object, homedir?:string}} [deps]
 * @returns {Object|null}
 */
function readCacheLive(deps = {}) {
  // The default drops the encoding argument: the shared reader's second parameter is its byte cap.
  const readFileSync = deps.readFileSync || ((p) => readRegularFileBounded(p));
  try {
    // Inside the try: a path that cannot be resolved (an invalid config dir) is a miss too.
    const file = deps.cachePath || cachePath(deps.env, { homedir: deps.homedir });
    return JSON.parse(String(readFileSync(file, 'utf8')));
  } catch (_) {
    return null;
  }
}

/**
 * Write the upstream-tip cache. BEST-EFFORT: an unwritable state dir must never break a gate
 * run — it only costs one extra `ls-remote` next time.
 * The default writer is the shared non-blocking, regular-file-only writer (W5): a cache path that
 * is a FIFO, socket, device or directory (or a symlink to one) is refused at once, and that refusal
 * is swallowed like any other unwritable cache, instead of blocking the hook past its timeout.
 *
 * @param {Object} entry
 * @param {{writeFileSync?:Function, mkdirSync?:Function, cachePath?:string, env?:Object,
 *   homedir?:string}} [deps]
 */
function writeCacheLive(entry, deps = {}) {
  const writeFileSync = deps.writeFileSync || ((p, data) => writeRegularFile(p, data));
  const mkdirSync = deps.mkdirSync || nodeFs.mkdirSync;
  try {
    const file = deps.cachePath || cachePath(deps.env, { homedir: deps.homedir });
    assertNotRealUserState(file); // under node --test only; caught below, so a fenced write is a miss
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(entry, null, 2) + '\n', { encoding: 'utf8' });
  } catch (_) {
    /* a cache we cannot write is a cache miss next time — never a gate failure */
  }
}

/**
 * Resolve the current upstream tip under the TTL cache + staleness budget (D-04).
 *
 *   age < TTL_MS                       → the cached tip, ZERO network calls
 *   age >= TTL_MS, fetch OK            → the live tip, cache rewritten
 *   fetch fails, age <= STALE_BUDGET   → the cached tip, flagged `stale-cache` + its age
 *   fetch fails, no usable cache       → THROWS UpstreamUnavailable  (→ the gate's `ask`)
 *   fetch returns a non-40-hex tip     → THROWS FailClosed           (→ deny; never a guess)
 *
 * The default cache closures read and write the cache of the config dir named by `deps.env` /
 * `deps.homedir` (or `deps.cachePath` when given), so each config dir keeps its own tip cache.
 *
 * @param {{fetchTip?:Function, readCache?:Function, writeCache?:Function, now?:Function,
 *   env?:Object, homedir?:string, cachePath?:string}} [deps]
 * @returns {{sha:string, source:'cache'|'live'|'stale-cache', ageMs:number}}
 */
function upstreamTip(deps = {}) {
  const cacheDeps = { env: deps.env, homedir: deps.homedir, cachePath: deps.cachePath };
  const fetchTip = deps.fetchTip || (() => fetchTipLive());
  const readCache = deps.readCache || (() => readCacheLive(cacheDeps));
  const writeCache = deps.writeCache || ((e) => writeCacheLive(e, cacheDeps));
  const now = deps.now || (() => Date.now());

  const nowMs = now();
  let cached = null;
  try {
    cached = usableCache(readCache(), nowMs);
  } catch (_) {
    cached = null; // an exploding cache reader is a cache miss, nothing more
  }

  if (cached && cached.ageMs < TTL_MS) {
    return { sha: cached.entry.sha, source: 'cache', ageMs: cached.ageMs };
  }

  let tip = null;
  let fetchErr = null;
  try {
    tip = fetchTip();
  } catch (err) {
    // A malformed remote response is TAMPERING, not an outage — it must not be rescued by the
    // cache and must not degrade to `ask`. Only a genuine reach failure falls through.
    if (err instanceof FailClosed) throw err;
    fetchErr = err;
  }

  if (fetchErr) {
    if (cached && cached.ageMs <= STALE_BUDGET_MS) {
      return { sha: cached.entry.sha, source: 'stale-cache', ageMs: cached.ageMs };
    }
    throw new UpstreamUnavailable(
      'the upstream `' + UPSTREAM_REF + '` tip is unobtainable (' +
        ((fetchErr && fetchErr.message) || 'network failure') + ')' +
        (cached
          ? ' and the cached tip is ' + Math.round(cached.ageMs / 60000) + ' minutes old, past the ' +
            Math.round(STALE_BUDGET_MS / 3600000) + ' h staleness budget'
          : ' and no cached tip is available')
    );
  }

  if (typeof tip !== 'string' || !SHA40.test(tip)) {
    throw new FailClosed(
      'ENF-21: the upstream tip resolver returned ' + JSON.stringify(tip) +
        ', which is not a 40-hex commit id — refusing to guess an upstream tip'
    );
  }

  writeCache({
    schema: STAMP_SCHEMA,
    url: UPSTREAM_URL,
    ref: UPSTREAM_REF,
    sha: tip,
    fetched_at: new Date(nowMs).toISOString(),
  });
  return { sha: tip, source: 'live', ageMs: 0 };
}

// ───────────────────────────── the verdict (pure) ─────────────────────────────

/**
 * Render the upstream source as a short clause for a reason string, disclosing the cache age
 * whenever the adjudication rode a stale cache (so a user is never told "current" on the basis
 * of yesterday's answer without being told).
 *
 * @param {{source?:string, ageMs?:number}} upstream
 * @returns {string}
 */
function sourceNote(upstream) {
  const u = upstream || {};
  if (u.source === 'stale-cache') {
    return ' (compared against a CACHED `' + UPSTREAM_REF + '` tip from ' +
      Math.round((u.ageMs || 0) / 60000) + ' minutes ago — github was unreachable)';
  }
  if (u.source === 'cache') {
    return ' (compared against a cached `' + UPSTREAM_REF + '` tip from ' +
      Math.round((u.ageMs || 0) / 60000) + ' minutes ago)';
  }
  return '';
}

/**
 * THE PURE VERDICT. Plain objects in, a plain object out — no filesystem, no network, no clock.
 * That purity is what lets `bin/runtime-sync.cjs check` reuse the exact adjudication the gate
 * performs, so `check` can never say "fresh" about a runtime the gate would deny.
 *
 * It deliberately returns a VERDICT, never a permissionDecision: mapping verdicts to
 * deny/allow/ask is the gate's job, and keeping it out of here is what keeps this reusable.
 *
 * The checks run in this ORDER (CTK-ADR-0011, D5), and the first that fires decides:
 *
 *   unstamped   - no stamp at all (we do not know what is installed)
 *   unverified  - runtime digest mismatch (a foreign reinstall replaced the runtime under our
 *                 stamp); this reason wins even when the hooks also differ
 *   unverified  - the stamp carries no hook fields: it predates hook coverage, so the managed
 *                 gsd-core hooks under `~/.claude/hooks` are unverified until one `sync`
 *   unverified  - the measured managed-hooks digest is not the stamped one (or was not measured)
 *   drifted     - both digests match but the stamped sha is not the upstream tip
 *   fresh       - stamp present, both digests match, stamp.sha === upstream.sha
 *
 * `unstamped` / `unverified` / `drifted` are ALL deny-shaped (see DENY_VERDICTS).
 *
 * @param {{stamp:(Object|null), runtimeDigest:string, hooksDigest?:(string|null),
 *   upstream:{sha:string, source?:string, ageMs?:number}, runtimeLabel?:string,
 *   hooksLabel?:string}} input  the labels name the measured roots in the reasons (defaults
 *   `~/.claude/gsd-core` and `~/.claude/hooks`; CTK-ADR-0013)
 * @returns {{verdict:string, reason:string, behind?:{stamped:string, upstream:string}}}
 */
function evaluateDrift(input) {
  const { stamp, runtimeDigest: digest, hooksDigest: measuredHooks, upstream } = input || {};
  const note = sourceNote(upstream);
  // CTK-ADR-0013: the reasons name the session's config dir; the defaults are the daily labels.
  const runtimeLabel = (input && typeof input.runtimeLabel === 'string' && input.runtimeLabel) || '~/.claude/gsd-core';
  const hooksLabel = (input && typeof input.hooksLabel === 'string' && input.hooksLabel) || '~/.claude/hooks';

  if (stamp === null || stamp === undefined) {
    return {
      verdict: 'unstamped',
      reason:
        'the installed gsd-core runtime carries NO toolkit stamp, so which upstream commit it ' +
        'corresponds to is unknown (the installer writes only a package version, never a SHA)',
    };
  }

  if (stamp.runtime_digest !== digest) {
    return {
      verdict: 'unverified',
      reason:
        'the installed runtime no longer matches the tree the stamp describes (stamped digest ' +
        String(stamp.runtime_digest).slice(0, 19) + '..., measured ' + String(digest).slice(0, 19) +
        '...): something reinstalled or edited `' + runtimeLabel + '` outside this toolkit, so the ' +
        'stamp can no longer be trusted',
    };
  }

  if (!Array.isArray(stamp.hooks_files)) {
    return {
      verdict: 'unverified',
      reason:
        'the runtime stamp predates hook coverage (it records no `hooks_files` / `hooks_digest`), ' +
        'so the managed gsd-core hooks under `' + hooksLabel + '` are unverified: a sync that never ' +
        'built them would have kept the OLD hooks; re-run sync once to re-stamp with hook coverage',
    };
  }

  if (stamp.hooks_digest !== measuredHooks) {
    return {
      verdict: 'unverified',
      reason:
        'the managed gsd-core hooks under `' + hooksLabel + '` no longer match the set the stamp ' +
        'describes (stamped hooks digest ' + String(stamp.hooks_digest).slice(0, 19) + '..., measured ' +
        String(measuredHooks).slice(0, 19) + '...): a managed hook was edited, removed or replaced ' +
        'outside this toolkit, so the stamp can no longer be trusted',
    };
  }

  const upstreamSha = upstream && upstream.sha;
  if (stamp.sha !== upstreamSha) {
    return {
      verdict: 'drifted',
      behind: { stamped: stamp.sha, upstream: upstreamSha },
      reason:
        'the installed runtime is at ' + String(stamp.sha).slice(0, 8) + ' but `origin/' +
        UPSTREAM_REF + '` is at ' + String(upstreamSha).slice(0, 8) + note,
    };
  }

  return {
    verdict: 'fresh',
    reason: 'the installed runtime is at ' + String(stamp.sha).slice(0, 8) + ', the current `origin/' +
      UPSTREAM_REF + '` tip' + note,
  };
}

module.exports = {
  // constants
  RUNTIME_ROOT,
  HOOKS_ROOT,
  HOOK_MISSING_FRAME,
  STATE_DIRNAME,
  STATE_DIR_ENV,
  STAMP_FILENAME,
  CACHE_FILENAME,
  STAMP_SCHEMA,
  TTL_MS,
  STALE_BUDGET_MS,
  UPSTREAM_URL,
  UPSTREAM_REF,
  LS_REMOTE_TIMEOUT_MS,
  REMEDIATION_COMMAND,
  REMEDIATION_CLI,
  resolveRemediationCli,
  CONFIG_DIR_ENV,
  CONFIG_DIRS_SUBDIR,
  CONTRIB_SESSION_HINT,
  PAYLOAD_DIRS,
  DENY_VERDICTS,
  UpstreamUnavailable,
  // config dir (CTK-ADR-0013)
  resolveConfigDir,
  isDailyConfigDir,
  INSTALL_WRITTEN_ENTRIES,
  classifyConfigDir,
  runtimeRootFor,
  hooksRootFor,
  // paths
  resolveStateDir,
  stampPath,
  cachePath,
  // digests
  runtimeDigest,
  payloadDigest,
  payloadInventory,
  // managed hooks (CTK-ADR-0011)
  isManagedHookRel,
  hooksInventory,
  hooksDigest,
  hooksDigestForStamp,
  // stamp
  readStamp,
  writeStamp,
  buildStamp,
  validateStamp,
  // upstream
  fetchTipLive,
  readCacheLive,
  writeCacheLive,
  usableCache,
  upstreamTip,
  // verdict
  evaluateDrift,
};
