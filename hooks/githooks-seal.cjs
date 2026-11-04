#!/usr/bin/env node
'use strict';

/**
 * hooks/githooks-seal.cjs — PreToolUse(Bash) .githooks seal
 * (ENF-12 --no-verify flag-not-text + ENF-13 core.hooksPath=.githooks, HARD-01/04).
 *
 * Sealing the repo's own `.githooks` layer is higher-ROI than net-new gates (red-team
 * "what held up"): a fresh gsd-core worktree leaves `core.hooksPath` UNSET, so the repo's
 * pre-commit/pre-push gates are silently INERT — a contributor commits/pushes red without
 * ever running a single local gate. And `git commit --no-verify` / `-n` skips the hooks
 * even when they ARE wired. This gate denies both:
 *
 *   ENF-12 — a commit/push carrying the REAL `--no-verify` / `-n` argv flag → DENY.
 *            Crucially this consults the STRUCTURED flag space (hooks/lib/flags.hasFlag),
 *            never the raw command string and never the `-m` message value: so
 *            `git commit -m "never use --no-verify"` is NOT denied for the flag (the
 *            EP-3 false-positive boundary, threat T-03-04-FP — a false deny here gets the
 *            toolkit disabled). --no-verify is distinct from the GSD_CONTRIB_OVERRIDE
 *            valve (HARD-03), which this gate honors only for a thrown error; it does not lift this deny.
 *
 *   ENF-13 - a commit/push whose effective `core.hooksPath` in the resolved gsd-core worktree
 *            is not `.githooks` -> DENY (threat T-03-04-INERT), read from the LIVE git config
 *            (not a vendored guess). One exception: a session hooks dispatcher set through
 *            env config, which runs the hooks the repo's own value names. The commit/push is
 *            allowed when the effective value differs from the read with the env count key
 *            voided, passes dispatcherShape, the voided repo value is exactly `.githooks`, and
 *            the value passes a delegation canary (runDispatcherCanary, which states what that
 *            does and does not show). The check order in gate() is load-bearing: the canary
 *            executes a file named by a config value, so it runs last and only for a value
 *            that came from the hook's own env keys. The hook's reads run in the hook's env,
 *            so they do not see an override typed in the command itself.
 *
 * Scope: only `commit` / `push` actions are gated; every other command (git reads, non-git)
 * passes through as a no-op allow, so the seal never over-blocks. HARD-01/04: the whole
 * decision runs inside runGate, so an unparseable command or a config-read failure FAILS
 * CLOSED (deny) — escapable only by a deliberate, logged GSD_CONTRIB_OVERRIDE.
 *
 * @module hooks/githooks-seal
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseCommandForGates } = require('./lib/argv.cjs');
const { classifyAction, isNonGovernedCommand } = require('./lib/classify.cjs');
const { hasFlag } = require('./lib/flags.cjs');
const { runGate, readHookInput, deny, allow, emit, FailClosed, safeCommand } = require('./lib/failclosed.cjs');
const { resolveRootForCommand } = require('./lib/resolve.cjs');

// FailClosed/safeCommand: shared IN-03 helpers from failclosed.cjs.

const SEALED_ACTIONS = new Set(['commit', 'push']);
const REQUIRED_HOOKS_PATH = '.githooks';
const NO_VERIFY_FLAGS = ['--no-verify', '-n'];

const DISPATCHER_BASENAME = 'githooks-dispatch';
const CANARY_DIR_PREFIX = 'githooks-seal-canary-';
const CANARY_MARKER = 'canary-ran';
const CANARY_EXIT = 37;
const CANARY_TIMEOUT_MS = 5000;
// A relative marker, so no character of TMPDIR ever reaches a shell.
const CANARY_HOOK = `#!/bin/sh\n: > ${CANARY_MARKER}\nexit ${CANARY_EXIT}\n`;
// What a git hook's environment would point somewhere else. The config keys stay, so what runs
// in the canary is the dispatcher's own voiding of them.
const CANARY_ENV_DROP = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_PREFIX',
  'GIT_NAMESPACE',
  'GIT_CEILING_DIRECTORIES',
];

/**
 * A config value as git printed it, minus one trailing newline and no other change: `.githooks `
 * and `.GITHOOKS` must not compare equal to `.githooks`. A non-string (null, unset) reads as ''.
 *
 * @param {*} value
 * @returns {string}
 */
function stripOneNewline(value) {
  if (typeof value !== 'string') return '';
  return value.endsWith('\n') ? value.slice(0, -1) : value;
}

/**
 * The chained segments that ARE the sealed git action (commit/push).
 *
 * ENF-12 must consult ONLY these. `hasFlag` reports a flag's presence across the WHOLE
 * command's flag space, so scanning `parsed` directly makes any neighbor in the chain
 * that legitimately carries `-n` — `grep -n`, `sed -n`, `tail -n`, `sort -n` — read as a
 * `git commit -n`. Those are ubiquitous next to a commit, so the gate denied a large class
 * of correct commands.
 *
 * This is the SAME false-positive class the flag-not-text rule (EP-3) already closed, on a
 * second axis: that one was flag-vs-message-TEXT, this one is my-segment-vs-a-NEIGHBOR's.
 * Both end in the trust-eroding false deny that gets the toolkit switched off (red-team
 * H-B), which is the failure mode this module's own docstring calls load-bearing.
 *
 * Narrowing here must not weaken the seal, so this returns EVERY sealed segment rather
 * than the first: `git commit -m x && git push --no-verify` must still deny on the push.
 * (classify.findActionSegment is unsuitable — it returns one segment and falls back to
 * segs[0], which can be a non-git neighbor.) Mirrors the segment fan-out shape of
 * classify.hasGovernedSegment.
 *
 * PURE: reads only argv/classify output.
 *
 * @param {Object} parsed result of argv.parseCommand
 * @returns {Object[]} the segments classifying to a SEALED_ACTIONS action (possibly empty)
 */
function sealedSegments(parsed) {
  const segs = Array.isArray(parsed.segments) && parsed.segments.length > 0
    ? parsed.segments
    : [parsed];
  return segs.filter((seg) => {
    const r = classifyAction({ ok: true, segments: [seg] });
    return r && SEALED_ACTIONS.has(r.action);
  });
}

/**
 * The pure gate decision with the impure git-config read injected.
 *
 * @param {string} stdinString raw PreToolUse JSON
 * @param {Object} deps
 * @param {() => (string|null)} deps.readHooksPath reads the effective core.hooksPath for the
 *   resolved gsd-core worktree (the value or null). MAY THROW -> fail closed.
 * @param {() => (string|null)} [deps.readRepoHooksPath] the same read with the env count key
 *   voided. MAY THROW -> fail closed. Absent: repo reads as equal to effective, so a caller
 *   injecting only readHooksPath can never reach the dispatcher allow.
 * @param {(value:string) => {passed:boolean}} [deps.passesCanary] runs the delegation canary on
 *   the effective value. MAY THROW on a setup failure -> fail closed. Absent: deny.
 * @returns {{permissionDecision:string, permissionDecisionReason?:string}}
 */
function gate(stdinString, deps) {
  const input = readHookInput(stdinString);
  const command = (input.tool_input && input.tool_input.command) || '';

  const parsed = parseCommandForGates(command);
  if (!parsed.ok) throw new FailClosed('unparseable command: ' + parsed.reason);

  const action = classifyAction(parsed);
  // Only commit/push are sealed. Anything else (git reads, non-git) → no-op allow.
  if (!action || !SEALED_ACTIONS.has(action.action)) return allow();

  // (1) ENF-12 — the REAL --no-verify / -n flag (structured argv, never -m message text)
  // and never a CHAINED NEIGHBOUR's flag: scoped to the sealed git segment(s) only.
  const sealed = sealedSegments(parsed);
  if (sealed.some((seg) => hasFlag({ ok: true, segments: [seg] }, NO_VERIFY_FLAGS))) {
    return deny(
      '`--no-verify` / `-n` bypasses the repo\'s `.githooks` gates (pre-commit / pre-push). ' +
        'Remove it and let the local gates run. ' +
        '`GSD_CONTRIB_OVERRIDE` does not lift this deny: this gate honors it only for a thrown gate ' +
        'error. Turning the toolkit off is a human operator\'s decision, not a way past this deny: ' +
        '`node bin/contrib-capability.cjs off --reason "<why>"`, run from the toolkit checkout, strips ' +
        'the toolkit\'s gates from that gsd-core checkout and writes a receipt. (ENF-12)'
    );
  }

  // (2) ENF-13. This order is load-bearing: the canary executes a file named by a config value,
  // so it stays last and never runs for a repo-scope value, a shape failure or a wrong repo value.

  // (a) The effective value is .githooks: the repo's own gates run. Reads may throw -> fail closed
  // (HARD-01).
  const hooksPath = stripOneNewline(deps.readHooksPath());
  if (hooksPath === REQUIRED_HOOKS_PATH) return allow();

  // (b) The voided read happens before anything looks at the value.
  const repoHooksPath = deps.readRepoHooksPath ? stripOneNewline(deps.readRepoHooksPath()) : hooksPath;

  // (c) Voiding the count key changed nothing, so the value did not come from the count keys.
  if (repoHooksPath === hooksPath) {
    return deny(
      'This worktree\'s `core.hooksPath` is ' +
        (hooksPath ? '`' + hooksPath + '`' : 'UNSET') +
        ', so the repo\'s `.githooks` gates (pre-commit / pre-push) are silently INERT. ' +
        'Set it before committing/pushing: `git config core.hooksPath .githooks`. (ENF-13)'
    );
  }

  // (d) The value came from the hook's env keys and does not have a dispatcher's shape.
  const shape = dispatcherShape(hooksPath);
  if (!shape.genuine) {
    return deny(
      'The effective `core.hooksPath` is ' +
        (hooksPath ? '`' + hooksPath + '`' : 'empty') +
        ', which does not have a hooks dispatcher\'s shape (' + shape.why + '). (ENF-13)'
    );
  }

  // (e) A dispatcher runs the hooks the repo's own value names; that value must be .githooks.
  if (repoHooksPath !== REQUIRED_HOOKS_PATH) {
    return deny(
      'A dispatcher-shaped `core.hooksPath` is in force and the repo value is ' +
        (repoHooksPath ? '`' + repoHooksPath + '`' : 'UNSET') +
        ', not `.githooks`. (ENF-13)'
    );
  }

  // (f) The value must pass the delegation canary. No canary wired means no allow.
  const canary = deps.passesCanary ? deps.passesCanary(hooksPath) : null;
  if (!canary || !canary.passed) {
    return deny(
      'The effective `core.hooksPath` `' + hooksPath + '` did not pass the delegation canary' +
        (canary
          ? ' (marker ' + (canary.marker ? 'yes' : 'no') + ', exit ' + canary.status +
            ', signal ' + canary.signal + ')'
          : '') +
        '. (ENF-13)'
    );
  }

  // (g)
  return allow();
}

/**
 * Injectable entry seam. Defaults readHooksPath to a live read of `core.hooksPath` from
 * the RESOLVED gsd-core worktree's git config (that worktree, not a global).
 *
 * @param {string} stdinString raw PreToolUse JSON
 * @param {Object} [deps]
 * @param {() => (string|null)} [deps.readHooksPath]
 * @param {() => (string|null)} [deps.readRepoHooksPath]
 * @param {(value:string) => {passed:boolean}} [deps.passesCanary]
 * @param {Object} [deps.env] env for the live reads and the canary; defaults to process.env
 * @param {string} [deps.worktreeRoot]
 * @param {{checkOverride:Function, writeReceipt:Function}} [deps.overrideImpl]
 * @returns {{permissionDecision:string, permissionDecisionReason?:string}}
 */
function runGithooksGate(stdinString, deps = {}) {
  const ctx = {
    command: safeCommand(stdinString),
    action: 'githooks-seal',
    // OBS-02: read ONLY for session/tool ids in the verdict log; never logged verbatim.
    stdin: stdinString,
    worktreeRoot: deps.worktreeRoot,
    overrideImpl: deps.overrideImpl,
  };

  return runGate(() => {
    // RES-01 (D-07 uniformity): classify the governed action FIRST (pure parse→classify,
    // no filesystem) and short-circuit a confidently non-governed command to allow() BEFORE
    // resolveRootForCommand walks the tree — a non-commit/non-push command no longer pays a
    // filesystem walk. The governed set is SEALED_ACTIONS (commit/push); isNonGovernedCommand
    // narrows-not-weakens: unparseable/failClosed/commit/push fall through to the unchanged
    // resolve→gate path below (a governed commit/push still runs the ENF-12/ENF-13 seal).
    if (isNonGovernedCommand(parseCommandForGates(ctx.command), SEALED_ACTIONS)) return allow();

    const resolved = Object.assign({}, deps);
    if (!resolved.readHooksPath) {
      const root = resolved.worktreeRoot || resolveRootForCommand(ctx.command, process.cwd());
      if (!root) return allow();
      ctx.worktreeRoot = ctx.worktreeRoot || root;
      const env = resolved.env || process.env;
      resolved.readHooksPath = () => readHooksPathLive(root, env);
      resolved.readRepoHooksPath = resolved.readRepoHooksPath || (() => readRepoHooksPathLive(root, env));
      resolved.passesCanary = resolved.passesCanary || ((value) => runDispatcherCanary(value, { env }));
    }
    return gate(stdinString, resolved);
  }, ctx);
}

/**
 * Live read of `git config --get core.hooksPath` for a specific worktree. Returns the value
 * minus one trailing newline with no trim, or null when the key is unset or empty. THROWS on a
 * real git failure (not the "unset" exit code 1) so runGate fails closed (HARD-01).
 *
 * @param {string} root absolute gsd-core worktree root
 * @param {Object} [env] the child's environment; defaults to process.env
 * @returns {string|null}
 */
function readHooksPathLive(root, env = process.env) {
  const res = spawnSync('git', ['-C', root, 'config', '--get', 'core.hooksPath'], {
    encoding: 'utf8',
    env,
  });
  if (res.error) {
    throw new FailClosed('could not read core.hooksPath: ' + res.error.message);
  }
  // git config --get exits 1 when the key is simply not set — that is "unset", not an error.
  if (res.status === 1) return null;
  if (res.status !== 0) {
    throw new FailClosed(
      'git config --get core.hooksPath failed (exit ' + res.status + '): ' + (res.stderr || '')
    );
  }
  const out = stripOneNewline(String(res.stdout || ''));
  return out.length > 0 ? out : null;
}

/**
 * The repo value a delegating dispatcher reads: the same read with only the env count key
 * voided, the way the dispatcher's delegate voids it. GIT_CONFIG_PARAMETERS is never voided, so
 * a value from there stays equal to the effective read and cannot reach the canary.
 *
 * @param {string} root absolute gsd-core worktree root
 * @param {Object} [env] the hook's environment; defaults to process.env
 * @returns {string|null}
 */
function readRepoHooksPathLive(root, env = process.env) {
  const voided = Object.assign({}, env);
  delete voided.GIT_CONFIG_COUNT;
  return readHooksPathLive(root, voided);
}

/**
 * Does this value have a hooks dispatcher's shape: an absolute path to a directory named exactly
 * githooks-dispatch, holding a regular _delegate.sh and executable regular pre-commit and pre-push.
 *
 * Never throws. Every fs error (ENOENT, ENOTDIR, EACCES, ELOOP, any other) is about the value, not
 * a failed read, so it is a returned not-genuine: a throw would let the override valve lift a
 * directory nothing tested. Reads metadata only and executes nothing.
 *
 * @param {*} value the effective core.hooksPath
 * @returns {{genuine:boolean, why:string}}
 */
function dispatcherShape(value) {
  const notGenuine = (why) => ({ genuine: false, why });
  if (typeof value !== 'string' || value.length === 0) return notGenuine('no value');
  if (!path.isAbsolute(value)) return notGenuine('not an absolute path');
  if (path.basename(value) !== DISPATCHER_BASENAME) {
    return notGenuine('basename is not ' + DISPATCHER_BASENAME);
  }
  try {
    if (!fs.statSync(value).isDirectory()) return notGenuine('not a directory');
    if (!fs.statSync(path.join(value, '_delegate.sh')).isFile()) {
      return notGenuine('_delegate.sh is not a regular file');
    }
    for (const name of ['pre-commit', 'pre-push']) {
      const stat = fs.statSync(path.join(value, name));
      if (!stat.isFile()) return notGenuine(name + ' is not a regular file');
      if ((stat.mode & 0o111) === 0) return notGenuine(name + ' is not executable');
    }
  } catch (err) {
    return notGenuine((err && err.code) || 'stat failed');
  }
  return { genuine: true, why: 'shape matches' };
}

/** The canary's throwaway repo, in tmp: a repo value of .githooks and a hook that marks and fails. */
function writeCanaryRepo(tmp, env) {
  const init = spawnSync('git', ['init', '-q'], {
    cwd: tmp,
    env,
    stdio: 'ignore',
    timeout: CANARY_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  });
  if (init.error) throw init.error;
  if (init.status !== 0) {
    throw new Error('git init failed (exit ' + init.status + ', signal ' + init.signal + ')');
  }
  fs.appendFileSync(path.join(tmp, '.git', 'config'), '[core]\n\thooksPath = ' + REQUIRED_HOOKS_PATH + '\n');
  const hook = path.join(tmp, REQUIRED_HOOKS_PATH, 'pre-commit');
  fs.mkdirSync(path.dirname(hook));
  fs.writeFileSync(hook, CANARY_HOOK);
  fs.chmodSync(hook, 0o755);
}

/**
 * Run `<value>/pre-commit` in a throwaway repo whose own pre-commit writes a marker and exits 37.
 * Passes only when the marker exists and the exit status is exactly 37: the repo hook ran, and its
 * failure blocks.
 *
 * What passing shows is one thing: this file ran a hook in one throwaway repo and passed its failing
 * exit through. Everything else stays open, by decision:
 *   - A faithful functional copy of the dispatcher passes. It does delegate, so the gates run, and
 *     no identity is available without a personal path.
 *   - A forged dispatcher that detects the canary (by its temp path, say) passes. Having one in
 *     force for a session takes a change to the hook's env, which also controls every gate's env.
 *   - An honest but wrong dispatcher that behaves only in an empty non-linked repo, or that hardcodes
 *     ./.githooks, passes.
 *   - Only pre-commit runs. pre-push is checked as an executable file only: running it would run
 *     another repo's push policy inside this gate, so a dispatcher whose pre-push does not delegate
 *     passes this seal on a push.
 *
 * A setup failure (mkdtemp, git init, writing the fixture) throws FailClosed, which a logged override
 * can lift like any other gate fault. Anything from spawning the value file (ENOENT, EACCES, ETIMEDOUT,
 * a signal) is a returned failure and never a throw, so the valve cannot lift a value that failed.
 * The kill is SIGKILL because a stub that traps TERM would hold spawnSync past the bound, and a hook
 * that times out does not block the tool call. stdio is ignored, so the gate's stdout stays its own
 * and no grandchild holding a pipe can keep it waiting.
 *
 * Parallel runs use separate mkdtemp directories. An interrupted run can leave one behind; a later
 * run never reads it.
 *
 * @param {string} value a value that passed dispatcherShape
 * @param {Object} [opts]
 * @param {Object} [opts.env] the hook's environment; defaults to process.env
 * @param {number} [opts.timeoutMs] bound on the value file's run; defaults to 5000
 * @returns {{passed:boolean, marker:boolean, status:(number|null), signal:(string|null), error:(string|null)}}
 */
function runDispatcherCanary(value, opts = {}) {
  const env = Object.assign({}, opts.env || process.env);
  for (const key of CANARY_ENV_DROP) delete env[key];
  const timeout = opts.timeoutMs === undefined ? CANARY_TIMEOUT_MS : opts.timeoutMs;
  let tmp = null;
  try {
    try {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), CANARY_DIR_PREFIX));
      writeCanaryRepo(tmp, env);
    } catch (err) {
      throw new FailClosed('could not set up the delegation canary: ' + err.message);
    }
    let res;
    try {
      res = spawnSync(path.join(value, 'pre-commit'), [], {
        cwd: tmp,
        env,
        stdio: 'ignore',
        timeout,
        killSignal: 'SIGKILL',
      });
    } catch (err) {
      res = { error: err, status: null, signal: null };
    }
    const marker = fs.existsSync(path.join(tmp, CANARY_MARKER));
    return {
      passed: marker && res.status === CANARY_EXIT,
      marker,
      status: res.status,
      signal: res.signal,
      error: res.error ? res.error.code || res.error.message : null,
    };
  } finally {
    if (tmp) {
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
      } catch (_) {
        /* a removal failure must not flip a verdict */
      }
    }
  }
}


function main() {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => {
    buf += c;
  });
  process.stdin.on('end', () => {
    emit(runGithooksGate(buf));
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  runGithooksGate,
  gate,
  readHooksPathLive,
  readRepoHooksPathLive,
  dispatcherShape,
  runDispatcherCanary,
  REQUIRED_HOOKS_PATH,
  NO_VERIFY_FLAGS,
};
