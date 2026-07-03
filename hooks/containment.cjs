#!/usr/bin/env node
'use strict';

/**
 * hooks/containment.cjs — PreToolUse(Bash) containment-safety gate, BOTH halves
 * (ENF-06 containment A + ENF-07 containment B / HARD-01 fail-closed / HARD-04 robust-parse).
 *
 * The PROJECT containment constraint: nothing private (the toolkit, `.planning/`) ever leaks
 * INTO the gsd-core repo or UP to the upstream `open-gsd/gsd-core`. `origin` in the gsd-core
 * checkout IS https://github.com/open-gsd/gsd-core.git, so a push to it from a
 * non-contribution branch is exactly the leak to prevent. Two surfaced safety hooks:
 *
 *   A (ENF-06): on `git add` / `git commit` in gsd-core, DENY if any path being staged is a
 *               `.planning/` path or a toolkit artifact (settings.snippet.json, install.sh,
 *               hooks/, README/skills/commands from the toolkit). These have no business in
 *               the gsd-core tree.
 *   B (ENF-07): on `git push`, DENY if the target remote resolves to upstream
 *               `open-gsd/gsd-core` AND the current branch is not a contribution branch
 *               (`^(fix|docs|feat)/`). Even a contribution branch pushed to the UPSTREAM
 *               origin is denied — contribution goes via a FORK per the PROJECT privacy
 *               constraint; the reason directs the push to the fork.
 *
 * This is the toolkit-OWNED containment check: no LIVE gsd-core script governs "is this path
 * a toolkit artifact" or "is this remote upstream", so the logic lives here (documented as
 * ours, H-A). It uses git INDEX / REMOTE reads (execFileSync, no shell) — never re-parsing
 * the raw command string for paths (HARD-04: we read the structured argv + the git index).
 *
 * Architecture (inherited from Waves 1-2):
 *   - argv.parseCommand   → robust parse, fail-closed on unparseable (HARD-04)
 *   - resolve.resolveGsdCoreRoot → the worktree whose index/remotes we inspect
 *   - failclosed.runGate  → an unreadable remote / git failure DENIES (HARD-01); a real
 *                           containment hit is a normal deny; only a logged override allows
 *
 * @module hooks/containment
 */

const { parseCommand } = require('./lib/argv.cjs');
const { runGate, readHookInput, deny, allow, emit, FailClosed, safeCommand } = require('./lib/failclosed.cjs');
const { resolveGsdCoreRoot, commandStartDir, ScriptResolveError, parseOwnerRepo } = require('./lib/resolve.cjs');
const { resolveProgram } = require('./lib/classify.cjs');

// FailClosed/safeCommand: shared IN-03 helpers from failclosed.cjs.

/**
 * Toolkit-artifact / .planning patterns (containment A). A staged path matching ANY of these
 * has no business in the gsd-core tree. Anchored to path segments so a legitimate gsd-core
 * file that merely CONTAINS one of these words is not over-matched.
 */
const TOOLKIT_PATTERNS = Object.freeze([
  /(^|\/)\.planning(\/|$)/, // the planning dir anywhere in the path
  /(^|\/)settings\.snippet\.json$/, // the hooks settings snippet
  /(^|\/)install\.sh$/, // the toolkit installer
  /(^|\/)hooks\/[^/]+\.cjs$/, // toolkit hook scripts (bin/lib/*.cjs is gsd-core's own — excluded below)
  /(^|\/)\.gsd-contrib(\/|$)/, // the per-worktree override-receipt dir
]);

/**
 * gsd-core's OWN generated files live under `gsd-core/bin/lib/*.cjs`; do not let the broad
 * `hooks/*.cjs` toolkit pattern misfire on a path like `gsd-core/bin/lib/x.cjs` (it would
 * not match `hooks/` anyway, but guard explicitly against a `.../hooks/` inside gsd-core that
 * is legitimately gsd-core's — there is none today, but keep the predicate honest).
 */
const GSD_CORE_OWN = Object.freeze([
  /(^|\/)gsd-core\/bin\/lib\//,
]);

/**
 * Is this staged path a toolkit / .planning artifact that must NOT enter gsd-core (ENF-06)?
 *
 * @param {string} p repo-relative path
 * @returns {boolean}
 */
function isToolkitArtifact(p) {
  if (typeof p !== 'string' || p.length === 0) return false;
  if (GSD_CORE_OWN.some((re) => re.test(p))) return false;
  return TOOLKIT_PATTERNS.some((re) => re.test(p));
}

/**
 * Does this remote URL point at the UPSTREAM open-gsd/gsd-core (ENF-07)? Routes through the
 * unified parseOwnerRepo normalizer (CHD-01 / WR-03) so it case-folds (CR-01) and port-strips
 * exactly like the resolve.cjs classifiers — recognizes https/http (+ optional `:port`) and ssh
 * forms; the owner MUST be `open-gsd` and the repo `gsd-core`. A personal fork
 * (`dave/gsd-core-fork`, `dave/gsd-core`) is NOT upstream (no false-deny). Behavior-preserving
 * reroute: keeps the boolean shape the gate() consumer (:330) depends on, only ADDING the
 * case-fold + port handling the hand-rolled body lacked.
 *
 * @param {string} url
 * @returns {boolean}
 */
function isUpstreamRemote(url) {
  const r = parseOwnerRepo(url);
  return !!r && r.owner === 'open-gsd' && r.repo === 'gsd-core';
}

/**
 * Is `branch` a contribution branch (`^(fix|docs|feat)/…`)? Anything else (main, master,
 * arbitrary) is not.
 *
 * @param {string} branch
 * @returns {boolean}
 */
function isContributionBranch(branch) {
  if (typeof branch !== 'string') return false;
  return /^(fix|docs|feat)\//.test(branch.trim());
}

/**
 * Detect EVERY relevant git action across a parsed command's segments. argv records the
 * non-dash args after the subcommand as further `subcommands` entries, so for `git push
 * origin main` → subcommands = ['push','origin','main']; for `git add .planning/x sdk/y` →
 * ['add','.planning/x','sdk/y'].
 *
 * A single Bash invocation may CHAIN several git actions (`git add -A && git commit -m x &&
 * git push origin main`) — one PreToolUse call. This collects ALL of them so gate() can
 * evaluate each, instead of returning on the FIRST match (the CHD-02 leak: a chained
 * `commit && push origin main` would only gate the add and skip ENF-07 on the push).
 *
 * Shape (CHD-02, Hyrum-audited): returns an ORDERED ARRAY of `{kind, args, seg}` — one entry
 * per matching git segment — replacing the prior single `{kind,args,seg}` object. The empty
 * array is the new no-op signal (was `{kind:'other'}`). Each entry carries its OWN seg so
 * pushRemote(seg)/explicitAddPaths(args) operate on the right segment. The only in-tree
 * consumers are gate() (below) and hooks/containment.test.cjs, both updated atomically.
 *
 * CF-04 (wrapper normalization): a segment's raw program may be a wrapper builtin
 * (`sudo`/`command`/`env`/…), so keying directly on seg.program === 'git' let a wrapped
 * git (`sudo git push`, `command git add`, `env FOO=bar git add`) escape as a non-git no-op
 * and slip ENF-06/ENF-07. Each segment's effective program is now normalized through the
 * EXISTING resolveProgram(seg) from classify.cjs (D-02 — reuse, do NOT re-implement wrapper
 * stripping): it advances past the wrapper builtins and strips value-taking git global-option
 * tokens, returning the resolved prog plus the ordered non-flag arg tokens. As a documented
 * bonus, a value-taking global-option form (`git -C /p add …`) now also classifies because
 * resolveProgram strips the `-C` value — strictly MORE deny coverage, never a new allow. Each
 * entry still carries its RAW seg so pushRemote(seg) reads the untouched push tail unchanged.
 *
 * @param {Object} parsed argv.parseCommand result (ok:true)
 * @returns {Array<{kind:'add'|'commit'|'push', args:string[], seg:Object}>}
 */
function detectGit(parsed) {
  const segs = Array.isArray(parsed.segments) && parsed.segments.length > 0
    ? parsed.segments
    : [parsed];
  const actions = [];
  for (const seg of segs) {
    const { prog, args } = resolveProgram(seg);
    if (prog !== 'git') continue;
    const verb = args[0];
    if (verb === 'add') actions.push({ kind: 'add', args: args.slice(1), seg });
    else if (verb === 'commit') actions.push({ kind: 'commit', args: args.slice(1), seg });
    else if (verb === 'push') actions.push({ kind: 'push', args: args.slice(1), seg });
  }
  return actions;
}

/**
 * The explicit path positionals of a `git add` (the non-flag subcommand tail). A bare
 * `git add .` / `git add -A` / `git add -u` has no specific path → return [] so the caller
 * falls back to the cached set.
 *
 * @param {string[]} args the subcommand tail after `add`
 * @returns {string[]} explicit path operands (excluding `.`/flags/pathspec-magic)
 */
function explicitAddPaths(args) {
  const paths = [];
  for (const a of args || []) {
    if (typeof a !== 'string' || a.length === 0) continue;
    if (a.startsWith('-')) continue; // a flag (argv puts flags in seg.flags, but be safe)
    if (a === '.') continue; // "everything" → fall back to the cached set
    paths.push(a);
  }
  return paths;
}

/**
 * Default LIVE staged/cached path reader: `git diff --cached --name-only` in the gsd-core
 * worktree (execFileSync, no shell). THROWS → fail closed (HARD-01).
 *
 * @param {string} root
 * @returns {string[]}
 */
function stagedPathsLive(root) {
  const { execFileSync } = require('node:child_process');
  let out;
  try {
    out = execFileSync('git', ['diff', '--cached', '--name-only'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
  } catch (err) {
    throw new FailClosed(
      'could not read the staged file list in the gsd-core worktree (' +
        ((err && err.message) || 'git failure') + ') — failing closed (HARD-01)'
    );
  }
  return out.split('\n').map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * Default LIVE remote-URL resolver: `git remote get-url <remote>` (execFileSync, no shell).
 * THROWS → fail closed (HARD-01).
 *
 * @param {string} root
 * @param {string} remote
 * @returns {string}
 */
function remoteUrlLive(root, remote) {
  const { execFileSync } = require('node:child_process');
  try {
    return execFileSync('git', ['remote', 'get-url', remote], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    }).trim();
  } catch (err) {
    throw new FailClosed(
      'could not resolve the remote URL for `' + remote + '` (' +
        ((err && err.message) || 'git failure') + ') — failing closed (HARD-01)'
    );
  }
}

/**
 * Default LIVE current-branch resolver: `git rev-parse --abbrev-ref HEAD` (no shell).
 * THROWS → fail closed (HARD-01).
 *
 * @param {string} root
 * @returns {string}
 */
function currentBranchLive(root) {
  const { execFileSync } = require('node:child_process');
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    }).trim();
  } catch (err) {
    throw new FailClosed(
      'could not resolve the current branch (' + ((err && err.message) || 'git failure') +
        ') — failing closed (HARD-01)'
    );
  }
}

/**
 * git push options that consume a SEPARATE following token as their value. We must
 * skip that value when locating the <repository> positional. Everything else —
 * crucially `-u` / `--set-upstream`, plus `-f`/`--force`, `--tags`, `--all`,
 * `--delete`/`-d`, `--force-with-lease` (boolean or `=`-attached) — is boolean here.
 */
const PUSH_VALUE_FLAGS = Object.freeze(
  new Set(['--repo', '-o', '--push-option', '--receive-pack', '--exec'])
);

/**
 * The remote a `git push` targets: the first positional (the <repository>) after
 * `push`, else `origin`.
 *
 * Reads the RAW segment tokens, NOT the generic argv classification: argv treats a
 * lone short flag like `-u` as taking the next token as its value, so `git push -u
 * origin main` would swallow `origin` as `-u`'s "value" and leave the remote absent
 * from the subcommand tail — causing a fork push to be mis-checked against `origin`
 * (ENF-07 false deny). git push's `-u`/`--set-upstream` is boolean, so we scan the
 * push tail ourselves, skipping only the small set of options that truly take a
 * separate-token value (G2).
 *
 * @param {Object} seg argv segment for the `git push …` command (must expose tokens)
 * @returns {string}
 */
function pushRemote(seg) {
  const tokens = seg && Array.isArray(seg.tokens) ? seg.tokens : [];
  const pushIdx = tokens.indexOf('push');
  if (pushIdx === -1) return 'origin';

  for (let i = pushIdx + 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (typeof t !== 'string' || t.length === 0) continue;
    if (t.startsWith('-') && t !== '-') {
      // `--flag=value` carries its own value; a bare value-flag consumes the next
      // token. Either way the value is NOT the remote, so skip accordingly.
      const base = t.split('=')[0];
      if (!t.includes('=') && PUSH_VALUE_FLAGS.has(base)) i += 1;
      continue;
    }
    return t; // first non-flag token after `push` = <repository>
  }
  return 'origin';
}

/**
 * Containment A for a single add/commit action: DENY if any path being staged/committed is a
 * toolkit / `.planning` artifact (ENF-06). An `add` evaluates its explicit path operands (or
 * the cached set for a bare `git add .`/`-A`/`-u`); a `commit` evaluates the cached set.
 *
 * @param {{kind:'add'|'commit', args:string[]}} action one detectGit action
 * @param {Object} deps gate deps (gsdCoreRoot, stagedPaths)
 * @returns {{permissionDecision:string, permissionDecisionReason?:string}}
 */
function gateContainmentA(action, deps) {
  let paths;
  if (action.kind === 'add') {
    const explicit = explicitAddPaths(action.args);
    // Explicit path operands are evaluated directly; a bare `git add .`/`-A`/`-u` has no
    // operand → fall back to what would actually be staged (the cached set).
    paths = explicit.length > 0 ? explicit : deps.stagedPaths(deps.gsdCoreRoot);
  } else {
    // bare commit → the cached set is what is about to be committed.
    paths = deps.stagedPaths(deps.gsdCoreRoot);
  }
  const offenders = (paths || []).filter(isToolkitArtifact);
  if (offenders.length > 0) {
    return deny(
      'Containment breach blocked (ENF-06): these toolkit / `.planning` artifacts must ' +
        'NOT enter the gsd-core repo:\n' +
        offenders.map((p) => '  - ' + p).join('\n') + '\n' +
        'They belong in the private gsd-contrib-toolkit repo only. Unstage them ' +
        '(`git restore --staged <path>`) before committing.'
    );
  }
  return allow();
}

/**
 * Is a `git push` target a URL (a repository location) rather than a configured remote NAME?
 * A URL target contains a scheme (`://`) OR matches the scp-style ssh `user@host:owner/repo`
 * form. A bare word with no `://` and no scp-`@host:` (`origin`, `fork`, `upstream`, or a
 * relative path like `.` / `../x`) is a configured remote NAME (or a path) → false.
 *
 * This discriminator is the CHD-04 (WR-02) fix seam: a URL target must be classified DIRECTLY
 * via isUpstreamRemote — never routed through `git remote get-url <url>` (remoteUrlLive), which
 * THROWS FailClosed on a non-remote-name and is then flipped to ALLOW+receipt by the GENERAL
 * runGate override (failclosed.cjs:155-181), bypassing ROB-03's origin-only conjunction. The
 * scp regex mirrors parseOwnerRepo's own ssh-form matcher (Kerckhoffs: no new obscure URL
 * parser). It is deliberately conservative toward NAME: a bare remote name must NOT be
 * misread as a URL, or `origin`/`upstream` would skip the remoteUrl classification.
 *
 * @param {string} target the pushRemote(seg) value (the <repository> positional)
 * @returns {boolean}
 */
function isUrlTarget(target) {
  if (typeof target !== 'string' || target.length === 0) return false;
  if (target.includes('://')) return true; // any scheme:// form (https/http/ssh/git)
  if (/^[^@/\s]+@[^@:/\s]+:/.test(target)) return true; // scp-style ssh `git@host:owner/repo`
  return false;
}

/**
 * Containment B for a single push action: DENY if the target remote resolves to upstream
 * open-gsd/gsd-core (ENF-07), honoring the ROB-03 origin-only logged override. Each push
 * carries its OWN seg, so a chained / multi-push command resolves each remote independently.
 * A failure to read the remote URL or branch THROWS → propagates to runGate → fails closed
 * (the ROB-03 origin-only override + the thrown-path general override are unchanged).
 *
 * CHD-04 (WR-02): BEFORE consulting `deps.remoteUrl(root, remote)`, discriminate a URL target
 * from a configured remote NAME (isUrlTarget). A URL target is classified DIRECTLY via
 * isUpstreamRemote — a URL is by definition NOT the named `origin`, so an upstream URL push is
 * a RETURNED policy deny with the override INERT (failclosed.cjs:150-156), never the thrown
 * `git remote get-url <url>` that the general override would rescue. A fork URL allows. Only a
 * configured remote NAME falls through to the existing remoteUrl path, so a genuinely transient
 * git error on a NAMED remote still throws → override-rescuable (unchanged). The fix is
 * gate-local to ENF-07: no runGate/failclosed.cjs edit, no new try/rescue (Kerckhoffs).
 *
 * @param {{kind:'push', seg:Object}} action one detectGit push action
 * @param {string} command the full raw command (recorded in the override receipt)
 * @param {Object} deps gate deps (gsdCoreRoot, remoteUrl, currentBranch, overrideImpl)
 * @returns {{permissionDecision:string, permissionDecisionReason?:string}}
 */
function gateContainmentB(action, command, deps) {
  const remote = pushRemote(action.seg);

  // CHD-04 URL-vs-remote-name discriminator (before any `git remote get-url`). A URL target
  // is classified directly — never through the throw→general-override path (WR-02).
  if (isUrlTarget(remote)) {
    if (!isUpstreamRemote(remote)) {
      return allow(); // a fork URL (or a path remote) push is fine — not upstream
    }
    // Upstream open-gsd/gsd-core named by a URL. A URL is NOT the named `origin`, so the
    // origin-only override is INERT here: RETURN the policy deny (which the general runGate
    // override never rescues) and — like the non-origin NAMED path — do NOT advertise the
    // override (advertising an inert escape is the spoof, T-25-03-05 / T-26-05-01).
    const branch = deps.currentBranch(deps.gsdCoreRoot); // may throw → fail closed
    return deny(
      'Containment breach blocked (ENF-07): `' + remote + '` is a URL that resolves to the ' +
        'UPSTREAM open-gsd/gsd-core. Pushing private work to upstream from branch `' + branch +
        '` leaks it. A bare URL target is physically contained: a deliberate maintainer push ' +
        'is only possible to the named `origin` remote (the same-repo flow), not to a URL. ' +
        'Push to a fork (`git push fork ' + branch + '`) and open a PR, or use your `!` shell ' +
        'channel.'
    );
  }

  const url = deps.remoteUrl(deps.gsdCoreRoot, remote); // may throw → fail closed
  if (!isUpstreamRemote(url)) {
    return allow(); // pushing to a fork / non-upstream remote is fine
  }
  // Target IS upstream open-gsd/gsd-core. Pushing private work here leaks it, so the default
  // is DENY. ROB-03 (ENF-07 option B): a deliberate, accountable maintainer push to `origin`
  // (the same-repo CODEOWNER flow) may be honored via a LOGGED override — origin ONLY. A
  // non-origin upstream remote stays physically contained even with the override set.
  const branch = deps.currentBranch(deps.gsdCoreRoot); // may throw → fail closed

  if (remote === 'origin') {
    // Gate-local origin-only override consult. Kept HERE (not in the shared runGate) so the
    // harness never learns to flip a RETURNED policy deny — that wider blast radius is the
    // deferred generalization (CONTEXT §Deferred). The override is consulted only on the
    // conjunction isUpstreamRemote(url) === true (above) AND remote name === 'origin'.
    const check = deps.overrideImpl.checkOverride(deps.gsdCoreRoot);
    if (check && check.override) {
      // A bypass we cannot log is a bypass we cannot honor: write the receipt FIRST and fail
      // closed if it cannot be written (mirrors failclosed.cjs:173-178). The reason is read
      // from the env by checkOverride and persisted as escaped, length-capped JSON by
      // writeReceipt — no shell, no eval, no path interpolation (reason-injection safe).
      try {
        deps.overrideImpl.writeReceipt(deps.gsdCoreRoot, {
          reason: check.reason,
          command,
          action: 'containment-upstream-push',
        });
      } catch (_) {
        return deny(
          'Containment override present but its receipt could not be written — denying ' +
            '(fail closed, ENF-07).'
        );
      }
      return allow();
    }
    // No override → DENY, and DO advertise GSD_CONTRIB_OVERRIDE here: it now works on this
    // exact (origin) path, so the promise is honest.
    return deny(
      'Containment breach blocked (ENF-07): `' + remote + '` resolves to the UPSTREAM ' +
        'open-gsd/gsd-core. Pushing private work to upstream from branch `' + branch +
        '` leaks it. If this is a deliberate, accountable maintainer push to `origin`, set ' +
        'GSD_CONTRIB_OVERRIDE="<reason>" and re-run — the push is then ALLOWED and a ' +
        'per-worktree override receipt is logged. Otherwise push to a fork (`git push fork ' +
        branch + '`) and open a PR, or use your `!` shell channel.'
    );
  }

  // A non-origin remote that nonetheless resolves to upstream open-gsd/gsd-core stays
  // physically contained. The override is INERT here, so the message must NOT advertise it
  // (advertising an inert escape is the spoof we are fixing — T-25-03-05).
  return deny(
    'Containment breach blocked (ENF-07): `' + remote + '` resolves to the UPSTREAM ' +
      'open-gsd/gsd-core. Pushing private work to upstream from branch `' + branch +
      '` leaks it. This remote is physically contained: a deliberate maintainer push is only ' +
      'possible to `origin` (the same-repo flow), not to `' + remote + '`. Push to a fork ' +
      '(`git push fork ' + branch + '`) and open a PR, or use your `!` shell channel.'
  );
}

/**
 * The pure gate decision with all impure deps injected.
 *
 * Evaluates EVERY git action in the (possibly chained) command in order: Containment A for
 * each add/commit, Containment B for each push. DENIES on the FIRST action that fails
 * (fail-closed — a denied command is blocked regardless of later actions); allows only if
 * every action passes. A single-action command collapses to a one-element loop and reproduces
 * the prior decision + reason byte-for-byte (CHD-02).
 *
 * @param {string} stdinString raw PreToolUse JSON
 * @param {Object} deps
 * @param {string} deps.gsdCoreRoot worktree root
 * @param {(root:string)=>string[]} deps.stagedPaths cached-set reader (A fallback)
 * @param {(root:string, remote:string)=>string} deps.remoteUrl remote URL resolver (B)
 * @param {(root:string)=>string} deps.currentBranch branch resolver (B)
 * @param {{checkOverride:Function, writeReceipt:Function}} deps.overrideImpl the override
 *   module (B origin-only consult): checkOverride(root) reads GSD_CONTRIB_OVERRIDE,
 *   writeReceipt(root, record) appends the per-worktree audit receipt.
 * @returns {{permissionDecision:string, permissionDecisionReason?:string}}
 */
function gate(stdinString, deps) {
  const input = readHookInput(stdinString);
  const command = (input.tool_input && input.tool_input.command) || '';

  const parsed = parseCommand(command);
  if (!parsed.ok) throw new FailClosed('unparseable command: ' + parsed.reason);

  const actions = detectGit(parsed);
  if (actions.length === 0) return allow(); // no add/commit/push → no-op

  for (const action of actions) {
    const decision = action.kind === 'push'
      ? gateContainmentB(action, command, deps)
      : gateContainmentA(action, deps);
    // Deny on the FIRST failing action — a denied command is blocked regardless of the rest.
    if (decision && decision.permissionDecision === 'deny') return decision;
  }
  return allow();
}

/**
 * Injectable entry seam. Builds runGate ctx and defaults the gsd-core root + the live git
 * index / remote readers from the real environment when not injected.
 *
 * @param {string} stdinString raw PreToolUse JSON
 * @param {Object} [deps]
 * @returns {{permissionDecision:string, permissionDecisionReason?:string}}
 */
function runContainmentGate(stdinString, deps = {}) {
  const ctx = {
    command: safeCommand(stdinString),
    action: 'containment',
    worktreeRoot: deps.worktreeRoot,
    overrideImpl: deps.overrideImpl,
  };

  return runGate(() => {
    // RES-01 (D-07 uniformity — SPECIAL CASE, not the shared isNonGovernedCommand guard):
    // containment governs `git add` / `commit` / `push`, but classifyAction (which
    // isNonGovernedCommand keys on) does NOT surface `add` — it only maps commit/push. Feeding
    // this gate through isNonGovernedCommand would therefore be LOSSY: a `git add .planning/x`
    // classifies as 'other', so the shared guard would wrongly short-circuit it to allow() and
    // silently WEAKEN Containment-A (staging a toolkit/.planning artifact into gsd-core). So we
    // reorder this gate's OWN pure classifier (detectGit — structured argv only, no filesystem)
    // ahead of resolveGsdCoreRoot instead. A command with NO governed git action short-circuits
    // to allow() before any tree walk. narrows-not-weakens: an unparseable command (!parsed.ok)
    // is NOT short-circuited — it falls through to gate() which throws FailClosed → DENY (HARD-04);
    // and detectGit's empty-array no-op mirrors gate()'s own `actions.length === 0` allow exactly.
    const preParsed = parseCommand(ctx.command);
    if (preParsed.ok && detectGit(preParsed).length === 0) return allow();

    const resolved = Object.assign({}, deps);
    if (!resolved.gsdCoreRoot) {
      try {
        resolved.gsdCoreRoot = resolveGsdCoreRoot(commandStartDir(parseCommand(ctx.command), process.cwd()));
      } catch (err) {
        // Not a gsd-core checkout (e.g. a commit in another repo) → not this gate's
        // concern; allow. A broken gsd-core checkout still fails closed downstream.
        if (err instanceof ScriptResolveError) return allow();
        throw err;
      }
    }
    ctx.worktreeRoot = ctx.worktreeRoot || resolved.gsdCoreRoot;
    if (!resolved.stagedPaths) resolved.stagedPaths = stagedPathsLive;
    if (!resolved.remoteUrl) resolved.remoteUrl = remoteUrlLive;
    if (!resolved.currentBranch) resolved.currentBranch = currentBranchLive;
    // The origin-only override consult (B) and the runGate thrown-path use the SAME override
    // module; default it once here so both the gate-local consult and ctx stay consistent.
    if (!resolved.overrideImpl) resolved.overrideImpl = require('./lib/override.cjs');
    ctx.overrideImpl = ctx.overrideImpl || resolved.overrideImpl;
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
    emit(runContainmentGate(buf));
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  runContainmentGate,
  gate,
  isToolkitArtifact,
  isUpstreamRemote,
  isContributionBranch,
  detectGit,
  pushRemote,
  isUrlTarget,
  explicitAddPaths,
  stagedPathsLive,
  remoteUrlLive,
  currentBranchLive,
};
