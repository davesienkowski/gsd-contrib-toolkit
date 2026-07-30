'use strict';

/**
 * hooks/lib/runtime-stamp.cjs — the ENF-21 RUNTIME-FRESHNESS ORACLE.
 *
 * ── WHAT THIS ANSWERS ───────────────────────────────────────────────────────────────────
 * "Is the globally-installed gsd-core runtime at `~/.claude/gsd-core` provably the same
 * gsd-core as `open-gsd/gsd-core` `origin/next` right now?"
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
const { GSD_CORE_OWNER, GSD_CORE_REPO } = require('./resolve.cjs');

// ───────────────────────────── constants ─────────────────────────────

/** The installed gsd-core runtime this module measures. */
const RUNTIME_ROOT = path.join(os.homedir(), '.claude', 'gsd-core');

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
 * The toolkit's USER-level state directory (D-01). Mirrors `tool-recorder.cjs`'s
 * `GSD_CONTRIB_LOG_DIR` shape but uses its OWN variable: the log dir names where the OBS-01
 * JSONL goes, and overloading it would move enforcement state as a side effect of relocating
 * a log.
 *
 * @param {Object} [env]
 * @returns {string}
 */
function resolveStateDir(env = process.env) {
  const override = env && env[STATE_DIR_ENV];
  if (typeof override === 'string' && override.trim().length > 0) return override.trim();
  return path.join(os.homedir(), STATE_DIRNAME);
}

/** @param {Object} [env] @returns {string} absolute path to the runtime stamp. */
function stampPath(env = process.env) {
  return path.join(resolveStateDir(env), STAMP_FILENAME);
}

/** @param {Object} [env] @returns {string} absolute path to the upstream-tip cache. */
function cachePath(env = process.env) {
  return path.join(resolveStateDir(env), CACHE_FILENAME);
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
  return obj;
}

/**
 * Read the toolkit-owned runtime stamp.
 *
 * @param {{readFileSync?:Function, stampPath?:string, env?:Object}} [deps]
 * @returns {Object|null} the stamp, or null when the file is ABSENT (the unstamped case)
 * @throws {FailClosed} on malformed JSON, a wrong schema, a bad sha/digest, or an unreadable
 *   (but present) file — fail-closed, never a guessed null
 */
function readStamp(deps = {}) {
  const readFileSync = deps.readFileSync || nodeFs.readFileSync;
  const file = deps.stampPath || stampPath(deps.env);

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
 * @param {{writeFileSync?:Function, mkdirSync?:Function, stampPath?:string, env?:Object}} [deps]
 * @returns {string} the path written
 */
function writeStamp(stamp, deps = {}) {
  const writeFileSync = deps.writeFileSync || nodeFs.writeFileSync;
  const mkdirSync = deps.mkdirSync || nodeFs.mkdirSync;
  const file = deps.stampPath || stampPath(deps.env);
  validateStamp(stamp, 'about to be written');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(stamp, null, 2) + '\n', { encoding: 'utf8' });
  return file;
}

/**
 * Build a well-formed stamp object.
 *
 * @param {{sha:string, runtimeDigest:string, mode:string, engineVerified:boolean, now?:string}} f
 * @returns {Object}
 */
function buildStamp(f) {
  return {
    schema: STAMP_SCHEMA,
    sha: f.sha,
    runtime_digest: f.runtimeDigest,
    mode: f.mode,
    engine_verified: f.engineVerified === true,
    installed_at: f.now || new Date().toISOString(),
    source: UPSTREAM_URL + '#' + UPSTREAM_REF,
  };
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
 *
 * @param {{readFileSync?:Function, cachePath?:string, env?:Object}} [deps]
 * @returns {Object|null}
 */
function readCacheLive(deps = {}) {
  const readFileSync = deps.readFileSync || nodeFs.readFileSync;
  const file = deps.cachePath || cachePath(deps.env);
  try {
    return JSON.parse(String(readFileSync(file, 'utf8')));
  } catch (_) {
    return null;
  }
}

/**
 * Write the upstream-tip cache. BEST-EFFORT: an unwritable state dir must never break a gate
 * run — it only costs one extra `ls-remote` next time.
 *
 * @param {Object} entry
 * @param {{writeFileSync?:Function, mkdirSync?:Function, cachePath?:string, env?:Object}} [deps]
 */
function writeCacheLive(entry, deps = {}) {
  const writeFileSync = deps.writeFileSync || nodeFs.writeFileSync;
  const mkdirSync = deps.mkdirSync || nodeFs.mkdirSync;
  const file = deps.cachePath || cachePath(deps.env);
  try {
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
 * @param {{fetchTip?:Function, readCache?:Function, writeCache?:Function, now?:Function}} [deps]
 * @returns {{sha:string, source:'cache'|'live'|'stale-cache', ageMs:number}}
 */
function upstreamTip(deps = {}) {
  const fetchTip = deps.fetchTip || (() => fetchTipLive());
  const readCache = deps.readCache || (() => readCacheLive());
  const writeCache = deps.writeCache || ((e) => writeCacheLive(e));
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
 *   fresh       — stamp present, digest matches, stamp.sha === upstream.sha
 *   unstamped   — no stamp at all (we do not know what is installed)
 *   unverified  — digest mismatch (a foreign reinstall replaced the runtime under our stamp)
 *   drifted     — digest matches but the stamped sha is not the upstream tip
 *
 * `unstamped` / `unverified` / `drifted` are ALL deny-shaped (see DENY_VERDICTS).
 *
 * @param {{stamp:(Object|null), runtimeDigest:string, upstream:{sha:string, source?:string, ageMs?:number}}} input
 * @returns {{verdict:string, reason:string, behind?:{stamped:string, upstream:string}}}
 */
function evaluateDrift(input) {
  const { stamp, runtimeDigest: digest, upstream } = input || {};
  const note = sourceNote(upstream);

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
        String(stamp.runtime_digest).slice(0, 19) + '…, measured ' + String(digest).slice(0, 19) +
        '…) — something reinstalled or edited `~/.claude/gsd-core` outside this toolkit, so the ' +
        'stamp can no longer be trusted',
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
  PAYLOAD_DIRS,
  DENY_VERDICTS,
  UpstreamUnavailable,
  // paths
  resolveStateDir,
  stampPath,
  cachePath,
  // digests
  runtimeDigest,
  payloadDigest,
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
