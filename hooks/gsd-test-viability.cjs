#!/usr/bin/env node
'use strict';

/**
 * hooks/gsd-test-viability.cjs — PreToolUse(Bash) ENF-24 gsd-test viability gate.
 *
 * A gsd-test dispatch can pass every SHAPE check and still be launched against an environment
 * that cannot run it. trek-e's 2026-09-13 incidents: with no docker CLI the run produced zero
 * containers and hung 26 minutes in silence; a stale client wasted a full round trip. This gate
 * turns those into an immediate deny that names the fix, checking cheapest first:
 *
 *   GTEST-04 — the gsd-test config file exists;
 *   GTEST-05 — the `--bench` the dispatch names is a `[[benches]]` entry in that config;
 *   GTEST-06 — the local Docker daemon answers a bounded `docker info` probe.
 *
 * ── ORDER (load-bearing) ────────────────────────────────────────────────────────────────
 *   1. read the harness payload (malformed JSON throws -> fail-closed deny);
 *   2. the shared detector: no entry -> allow, BEFORE any resolve, fs or spawn work (RES-01;
 *      36-CONTEXT Addendum 2 — `isNonGovernedCommand` is deliberately NOT used);
 *   3. an `uncertain` entry (HARD-01) is HELD: every attributable dispatch is still checked and
 *      a policy deny it earns is returned first (36-REVIEW m-01). With no attributable dispatch
 *      the held error is thrown before any I/O;
 *   4. informational dispatches (`--version`, `-h`, `--help`) and subcommands that need no
 *      viable environment (`wait`, `status`, `install-agent-hooks`, `submit` without
 *      `--execute`) are dropped; none left -> allow;
 *   5. per dispatch, in command order:
 *        a. tree = `treeDirFor` (start dir + `-source`); unresolvable -> throw FailClosed;
 *        b. not a gsd-core checkout -> this dispatch contributes allow (ROB-01 precedent);
 *        c. config path: `--config` (static expansion, relative to the start dir), else
 *           `$XDG_CONFIG_HOME/gsd-test/config.toml` (non-empty absolute), else
 *           `<homedir>/.config/gsd-test/config.toml`. An unexpandable value -> ask;
 *           missing file -> deny;
 *        d. a named bench absent from the config -> deny; an unexpandable value -> ask;
 *        e. GTEST-06: when no bench is named or the named bench's host is exactly "local", probe
 *           Docker (at most ONCE per gate call): ok -> allow; missing CLI / daemon down -> deny;
 *           timeout -> ask; any other result or a throw -> deny. A bench with any other or no
 *           host skips the probe (remote ssh probing is deferred, CONTEXT §Deferred).
 *   6. precedence across dispatches: the first policy deny returns at once; else the first held
 *      throw (an uncertain entry or a dispatch whose check threw); else the first ask; else
 *      allow.
 *
 * ── SEVERITY ────────────────────────────────────────────────────────────────────────────
 * A returned deny is a POLICY deny: GSD_CONTRIB_OVERRIDE rescues THROWN errors only and never
 * flips it (Addendum 4), so every deny reason names the real fix. The two `ask` returns (an
 * unexpandable `--config` or `--bench` value) mean "cannot check", not a known-bad fact; no
 * catch anywhere produces ask, so every throw still denies. The docker-timeout ask (CTK-ADR-0005
 * §2, CTK-ADR-0007 §2) means the probe overran its bound — not that Docker is down.
 *
 * ── DOCKER PROBE ────────────────────────────────────────────────────────────────────────
 * The single read-only `docker info --format {{.ServerVersion}}`: a frozen argv, no shell, no
 * command text in its arguments, `timeout` + SIGKILL. The gate never starts, restarts or
 * reconfigures Docker and never runs gsd-test.
 *
 * ── PRIVACY ─────────────────────────────────────────────────────────────────────────────
 * The config is only READ (never executed or required) and only `name`/`host` lines inside
 * `[[benches]]` blocks are parsed. A deny reason echoes configured bench NAMES (truncated and
 * capped) — never hosts, users, tokens or file excerpts (T-36-15).
 *
 * Registered in settings.snippet.json by 36-05 (until then it is not wired and not bundled).
 *
 * @module hooks/gsd-test-viability
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runGate, readHookInput, deny, allow, ask, emit, safeCommand, FailClosed } = require('./lib/failclosed.cjs');
const { resolveGsdCoreRoot, ScriptResolveError } = require('./lib/resolve.cjs');
const { findGsdTestDispatches, treeDirFor, startDirFor, expandStatic } = require('./lib/gsd-test-detect.cjs');

/** The honesty clause appended to every `ask` reason (same sentence as runtime-drift.cjs). */
const ASK_LIMIT_NOTE =
  'Note: an `ask` degrades to an ALLOW under `--dangerously-skip-permissions` — the same ' +
  'accepted limit ENF-11\'s advisory carries.';

/** The fixed, frozen probe argv (T-36-17): no command text ever reaches docker. */
const DOCKER_PROBE_ARGS = Object.freeze(['info', '--format', '{{.ServerVersion}}']);

/** Probe bound. 36-05 asserts the settings hook timeout (20 s) exceeds it. */
const DOCKER_PROBE_TIMEOUT_MS = 8000;

/** At most this many chars of docker's first stderr line reach a reason. */
const MAX_DOCKER_DETAIL = 200;

/** A config file larger than this is not a gsd-test config; reading it fails closed. */
const MAX_CONFIG_BYTES = 1024 * 1024;

/** Bench-name listing bounds in a deny reason. */
const MAX_BENCHES_LISTED = 20;
const MAX_BENCH_NAME_CHARS = 64;

/** Truncate a name for display. */
function clip(s) {
  const v = String(s);
  return v.length > MAX_BENCH_NAME_CHARS ? v.slice(0, MAX_BENCH_NAME_CHARS) + '...' : v;
}

const BENCHES_HEADER = /^\[\[\s*benches\s*\]\]\s*(?:#.*)?$/;
const KEY_LINE = /^(name|host)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')\s*(?:#.*)?$/;

/**
 * Zero-dependency `[[benches]]` reader (CONTEXT §Viability gate: no TOML library). Returns every
 * `[[benches]]` block that has a `name`, as `{name, host}` (`host` null when absent).
 *
 * @param {string} text the config file text
 * @returns {{name:string, host:(string|null)}[]}
 */
function parseBenches(text) {
  let src = typeof text === 'string' ? text : '';
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);
  const out = [];
  let cur = null;
  const close = () => {
    if (cur && cur.name !== null) out.push(cur);
    cur = null;
  };
  for (const raw of src.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (BENCHES_HEADER.test(line)) {
      close();
      cur = { name: null, host: null };
      continue;
    }
    if (line.startsWith('[')) {
      close();
      continue;
    }
    if (!cur) continue;
    const m = KEY_LINE.exec(line);
    if (!m) continue;
    const value = m[2] !== undefined ? m[2].replace(/\\(.)/g, '$1') : m[3];
    if (cur[m[1]] === null) cur[m[1]] = value;
  }
  close();
  return out;
}

/** The comma list of configured bench names for a deny reason. */
function benchList(benches) {
  if (benches.length === 0) return '<none>';
  const shown = benches.slice(0, MAX_BENCHES_LISTED).map((b) => clip(b.name));
  const more = benches.length - shown.length;
  return shown.join(', ') + (more > 0 ? ' (and ' + more + ' more)' : '');
}

function askUnexpandable(flag, value) {
  return ask(
    'ENF-24 gsd-test viability gate cannot check this dispatch: the `--' + flag + '` value `' +
      clip(value) + '` is a shell expansion that cannot be resolved statically, so the gate ' +
      'cannot confirm the ' + (flag === 'config' ? 'config file exists' : 'bench is configured') +
      '. Pass a literal value to have it checked. ' + ASK_LIMIT_NOTE
  );
}

function missingConfigReason(p) {
  return (
    'Blocked by the ENF-24 gsd-test viability gate: the gsd-test config file `' + p + '` does ' +
    'not exist. gsd-test cannot run without it — the run would fail (or stall) instead of testing ' +
    'anything.\n\n' +
    'Fix: restore the config from your documented gsd-test setup (do not hand-write one from ' +
    'guesses), or pass `--config <path>` naming the config file that does exist, then re-run.'
  );
}

function missingBenchReason(bench, p, benches) {
  return (
    'Blocked by the ENF-24 gsd-test viability gate: the bench `' + clip(bench) + '` named by ' +
    '`--bench` is not a `[[benches]]` entry in `' + p + '`, so gsd-test has nowhere to run.\n\n' +
    'Configured benches: ' + benchList(benches) + '\n\n' +
    'Fix: pass `--bench <name>` with one of the configured names, or add the bench to the config, ' +
    'then re-run.'
  );
}

/** First non-empty line of a stream, trimmed and capped. */
function firstLine(s) {
  const line = String(s == null ? '' : s)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return line ? line.slice(0, MAX_DOCKER_DETAIL) : '';
}

/**
 * Map a spawnSync-shaped result of the docker probe to a typed state (pure).
 *
 * @param {{status?:(number|null), signal?:(string|null), error?:{code?:string}, stdout?:string, stderr?:string}} res
 * @returns {{state:('ok'|'missing'|'down'|'timeout'|'error'), detail:string}}
 */
function classifyDockerResult(res) {
  const r = res && typeof res === 'object' ? res : {};
  const code = r.error && r.error.code;
  if (code === 'ENOENT') return { state: 'missing', detail: '' };
  // Only OUR bound is a timeout: spawnSync reports it as ETIMEDOUT (36-REVIEW m-05). A probe
  // killed by any other signal is an unknown state -> error -> thrown deny, never an ask.
  if (code === 'ETIMEDOUT') return { state: 'timeout', detail: '' };
  if (r.status === null && r.signal) return { state: 'error', detail: 'docker info was killed by ' + String(r.signal).slice(0, 32) };
  if (r.error) return { state: 'error', detail: String(code || r.error.message || 'spawn error').slice(0, MAX_DOCKER_DETAIL) };
  if (r.status === 0) return { state: 'ok', detail: '' };
  if (typeof r.status === 'number') {
    return { state: 'down', detail: firstLine(r.stderr) || 'exit status ' + r.status };
  }
  return { state: 'error', detail: 'no exit status' };
}

const DOCKER_MISSING_REASON =
  'Blocked by the ENF-24 gsd-test viability gate: there is no `docker` CLI on PATH. gsd-test ' +
  'drives the bench through the local docker CLI; without it the run starts zero containers and ' +
  'can hang in silence (trek-e, 2026-09-13: 26 minutes).\n\n' +
  'Fix: install or enable the Docker CLI — on WSL, enable Docker Desktop\'s WSL integration for ' +
  'this distro — then re-run.';

function dockerDownReason(detail) {
  return (
    'Blocked by the ENF-24 gsd-test viability gate: `docker info` failed (' + detail + '), so the ' +
    'Docker daemon is not answering and the run cannot start a container.\n\n' +
    'Fix: start Docker Desktop (or the Docker daemon), wait until `docker info` succeeds, then re-run.'
  );
}

const DOCKER_TIMEOUT_ASK =
  'ENF-24 gsd-test viability gate could not confirm Docker within ' + DOCKER_PROBE_TIMEOUT_MS / 1000 +
  ' s: `docker info` did not answer in time. If Docker is down the run may hang. Proceed only if ' +
  'you know Docker is starting up. ' + ASK_LIMIT_NOTE;

/**
 * Whether ENF-24 governs a dispatch, per gsd-test v1.8.0 subcommand (36-REVIEW M-01;
 * orchestrator-amended decision recorded in CTK-ADR-0008):
 *   classic — config + named bench + Docker;
 *   run     — config + Docker (dispatchRun loads the config and picks a bench by target);
 *   submit  — only with a truthy `--execute` (without it, runSubmit validates and echoes the
 *             spec; it loads no config and starts no container);
 *   wait / status / install-agent-hooks — not governed (they read run state or install files).
 */
function governs(d) {
  const sub = d.subcommand === undefined ? null : d.subcommand;
  if (sub === null || sub === 'run') return true;
  if (sub === 'submit') return Boolean(d.flags && d.flags.execute !== undefined && d.flags.execute !== false);
  return false;
}

/**
 * The config path this dispatch reads, or `{ask}` when `--config` cannot be expanded.
 *
 * @returns {{path:string}|{ask:Object}}
 */
function configPathFor(d, startDir, deps) {
  const ctx = { env: deps.env, homedir: deps.homedir };
  const flag = d.flags ? d.flags.config : undefined;
  if (typeof flag === 'string' && flag !== '') {
    const expanded = expandStatic(flag, ctx);
    if (expanded === null) return { ask: askUnexpandable('config', flag) };
    return { path: path.resolve(startDir, expanded) };
  }
  // An empty `--config=` is an empty Go value; gsd-test falls back to its default (the same
  // reading 36-03 gave an empty `--head=`).
  const xdg = deps.env ? deps.env.XDG_CONFIG_HOME : undefined;
  if (typeof xdg === 'string' && xdg.length > 0 && path.isAbsolute(xdg)) {
    return { path: path.join(xdg, 'gsd-test', 'config.toml') };
  }
  return { path: path.join(deps.homedir, '.config', 'gsd-test', 'config.toml') };
}

/**
 * The pure gate decision with every impure dep injected.
 *
 * @param {string} stdinString raw PreToolUse JSON
 * @param {Object} deps
 * @param {string} deps.cwd the hook's working directory (the command's base cwd)
 * @param {Object} deps.env environment for static expansion
 * @param {string} deps.homedir home directory for `~` expansion and the default config path
 * @param {(dir:string)=>(string|null)} deps.resolveTreeRoot gsd-core root for a dir, or null
 * @param {(p:string)=>(string|null)} deps.readConfig config text, null when absent (may throw)
 * @returns {{permissionDecision:string, permissionDecisionReason?:string}}
 */
function gate(stdinString, deps) {
  const input = readHookInput(stdinString);
  const command = (input.tool_input && input.tool_input.command) || '';

  // (2) RES-01: the detector is the first short-circuit.
  const entries = findGsdTestDispatches(command);
  if (entries.length === 0) return allow();

  // (3) HARD-01: an unattributable gsd-test mention fails closed — after every attributable
  // dispatch's policy checks (36-REVIEW m-01), so the override valve can never lift a policy deny
  // earned elsewhere in the same command. With no attributable dispatch: thrown with zero I/O.
  let pending = null;
  const uncertain = entries.find((e) => e.kind === 'uncertain');
  if (uncertain) {
    pending = new FailClosed(
      'ENF-24 gsd-test viability gate cannot attribute this gsd-test command (' +
        uncertain.reason +
        ') — failing closed. Re-run it as a plain `gsd-test` invocation with literal flag values.'
    );
  }

  // (4) Informational invocations only print; they need no config, bench or Docker. Nor do the
  // subcommands ENF-24 does not govern (see `governs`).
  const dispatches = entries.filter((e) => e.kind === 'dispatch' && !e.informational && governs(e));

  const state = { firstAsk: null, docker: null };
  for (const d of dispatches) {
    let decision = null;
    try {
      decision = checkDispatch(d, deps, state);
    } catch (err) {
      if (!pending) pending = err; // held: a later policy deny still wins (m-01)
      continue;
    }
    if (decision) return decision;
  }

  if (pending) throw pending;
  return state.firstAsk || allow();
}

/**
 * The checks for one dispatch: a `deny()` decision, or null. An `ask` is recorded in
 * `state.firstAsk` (deny > thrown > ask > allow across dispatches). Throws FailClosed on an
 * unresolvable directory or a probe failure.
 */
function checkDispatch(d, deps, state) {
  const ctx = { env: deps.env, homedir: deps.homedir };
  // (5a) Which tree, and the start dir a relative `--config` resolves against.
  const startDir = startDirFor(d, deps.cwd, ctx);
  const treeDir = startDir === null ? null : treeDirFor(d, deps.cwd, ctx);
  if (startDir === null || treeDir === null) {
    throw new FailClosed(
      'ENF-24 gsd-test viability gate cannot resolve this dispatch\'s directory statically (a ' +
        '`-source` value or an earlier `cd` target is a shell expansion, `~user` or `-`, or that ' +
        '`cd` carries an option other than -L/-P/-e/-@/--) — failing closed. Pass a literal path.'
    );
  }

  // (5b) Out-of-tree passthrough.
  if (deps.resolveTreeRoot(treeDir) === null) return null;

  // (5c) GTEST-04: the config file exists.
  const cfg = configPathFor(d, startDir, deps);
  if (cfg.ask) {
    if (!state.firstAsk) state.firstAsk = cfg.ask;
    return null;
  }
  const text = deps.readConfig(cfg.path);
  if (text === null || text === undefined) return deny(missingConfigReason(cfg.path));

  // (5d) GTEST-05: the named bench is configured. An empty `--bench=` names no bench.
  const benchFlag = d.flags ? d.flags.bench : undefined;
  let named = null;
  if (typeof benchFlag === 'string' && benchFlag !== '') {
    const bench = expandStatic(benchFlag, ctx);
    if (bench === null) {
      if (!state.firstAsk) state.firstAsk = askUnexpandable('bench', benchFlag);
      return null;
    }
    const benches = parseBenches(text);
    named = benches.find((b) => b.name === bench);
    if (!named) return deny(missingBenchReason(bench, cfg.path, benches));
  }

  // (5e) GTEST-06: the local Docker probe, only for a local (or unnamed) bench.
  if (named !== null && named.host !== 'local') return null;
  if (state.docker === null) state.docker = deps.dockerProbe();
  const docker = state.docker;
  const st = docker && docker.state;
  if (st === 'ok') return null;
  if (st === 'missing') return deny(DOCKER_MISSING_REASON);
  if (st === 'down') return deny(dockerDownReason(String(docker.detail || 'non-zero exit').slice(0, MAX_DOCKER_DETAIL)));
  if (st === 'timeout') {
    if (!state.firstAsk) state.firstAsk = ask(DOCKER_TIMEOUT_ASK);
    return null;
  }
  throw new FailClosed(
    'ENF-24 gsd-test viability gate could not run the docker probe (' +
      (st === 'error' ? String(docker.detail || 'spawn error') : 'unexpected probe result') +
      ') — failing closed.'
  );
}

/**
 * Real config reader: ENOENT/ENOTDIR -> null (the missing-config policy deny); a path that is
 * not a regular file, is larger than 1 MiB, or cannot be read -> throw FailClosed. The file is
 * only ever read as text — never executed or required.
 */
function defaultReadConfig(p) {
  let st;
  try {
    st = fs.statSync(p);
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return null;
    throw new FailClosed('ENF-24 could not stat the gsd-test config `' + p + '` (' + ((err && err.code) || 'error') + ') — failing closed.');
  }
  if (!st.isFile()) {
    throw new FailClosed('ENF-24: the gsd-test config `' + p + '` exists but is not a regular file — failing closed.');
  }
  if (st.size > MAX_CONFIG_BYTES) {
    throw new FailClosed('ENF-24: the gsd-test config `' + p + '` is larger than 1 MiB — failing closed.');
  }
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (err) {
    throw new FailClosed('ENF-24 could not read the gsd-test config `' + p + '` (' + ((err && err.code) || 'error') + ') — failing closed.');
  }
}

/**
 * Injectable entry seam. Defaults the real impls INSIDE the runGate callback so a throwing
 * default fails closed rather than escaping the harness.
 *
 * @param {string} stdinString raw PreToolUse JSON
 * @param {Object} [deps]
 * @returns {{permissionDecision:string, permissionDecisionReason?:string}}
 */
function runGsdTestViabilityGate(stdinString, deps = {}) {
  const ctx = {
    command: safeCommand(stdinString),
    action: 'gsd-test-viability',
    // OBS-02: read ONLY for session/tool ids in the verdict log; never logged verbatim.
    stdin: stdinString,
    worktreeRoot: deps.worktreeRoot,
    overrideImpl: deps.overrideImpl,
  };

  return runGate(() => {
    const resolved = Object.assign({}, deps);
    // Addendum 6: the hook's cwd is process.cwd(), as every other Bash gate.
    if (!resolved.cwd) resolved.cwd = process.cwd();
    if (!resolved.env) resolved.env = process.env;
    if (!resolved.homedir) resolved.homedir = os.homedir();
    if (!resolved.resolveTreeRoot) {
      resolved.resolveTreeRoot = (dir) => {
        try {
          return resolveGsdCoreRoot(dir);
        } catch (err) {
          // Not a gsd-core checkout: not this gate's concern. Anything else fails closed.
          if (err instanceof ScriptResolveError) return null;
          throw err;
        }
      };
    }
    if (!resolved.readConfig) resolved.readConfig = defaultReadConfig;
    if (!resolved.dockerProbe) {
      // Built ONLY when no probe is injected; the spawn seam defaults to child_process.spawnSync.
      const spawn = resolved.spawnSync || require('node:child_process').spawnSync;
      resolved.dockerProbe = () =>
        classifyDockerResult(
          spawn('docker', [...DOCKER_PROBE_ARGS], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: DOCKER_PROBE_TIMEOUT_MS,
            killSignal: 'SIGKILL',
            env: process.env,
          })
        );
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
    emit(runGsdTestViabilityGate(buf));
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  runGsdTestViabilityGate,
  gate,
  parseBenches,
  classifyDockerResult,
  DOCKER_PROBE_TIMEOUT_MS,
  DOCKER_PROBE_ARGS,
  ASK_LIMIT_NOTE,
};
