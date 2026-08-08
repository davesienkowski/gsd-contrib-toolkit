'use strict';

/**
 * node:test for hooks/lib/resolve.cjs (HARD-02 resolver half).
 *
 * Proven here:
 *   - resolveGsdCoreRoot walks up from a nested cwd to the ancestor with the gsd-core
 *     sentinel layout (scripts/ + gsd-core/bin/lib/) and returns it
 *   - a startDir with no sentinel ancestor → throws ScriptResolveError
 *   - requireLiveScript loads a present module's exports
 *   - a missing script → ScriptResolveError carrying the attempted path + root (NO
 *     vendored fallback — a missing live script must fail closed, never reimplement)
 *   - it loads the REAL live gsd-core scripts when present (issue-version-gate / pr-target-policy)
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const res = require('./resolve.cjs');
const { parseCommand } = require('./argv.cjs');

/**
 * Build a fixture tree shaped like a gsd-core checkout:
 *   <root>/scripts/probe.cjs
 *   <root>/scripts/pr-target-policy.cjs  (the RES-02 identity script — a trivial stub is
 *                                          sufficient for a presence-based hasSentinel; NOT
 *                                          issue-version-gate.cjs, which the pre-existing
 *                                          "NEVER falls back to a vendored copy" test below
 *                                          asserts is ABSENT from this fixture)
 *   <root>/gsd-core/bin/lib/.keep
 *   <root>/a/b/c/   (a nested cwd to resolve up from)
 */
function makeFixtureRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-core-fixture-'));
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'gsd-core', 'bin', 'lib'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'scripts', 'probe.cjs'),
    "module.exports = { ping: () => 'pong', VALUE: 42 };\n"
  );
  // The RES-02 identity script — hasSentinel now requires at least one
  // GSD_CORE_IDENTITY_SCRIPTS basename present under scripts/ (D-05: every existing
  // makeFixtureRoot-based test must keep hasSentinel-matching — no new false-negative).
  fs.writeFileSync(path.join(root, 'scripts', 'pr-target-policy.cjs'), 'module.exports = {};\n');
  fs.mkdirSync(path.join(root, 'a', 'b', 'c'), { recursive: true });
  return root;
}

test('resolveGsdCoreRoot: finds the root from a nested cwd via the sentinel layout', () => {
  const root = makeFixtureRoot();
  const nested = path.join(root, 'a', 'b', 'c');
  const resolved = res.resolveGsdCoreRoot(nested);
  assert.strictEqual(fs.realpathSync(resolved), fs.realpathSync(root));
});

test('resolveGsdCoreRoot: returns the root itself when startDir IS the root', () => {
  const root = makeFixtureRoot();
  assert.strictEqual(fs.realpathSync(res.resolveGsdCoreRoot(root)), fs.realpathSync(root));
});

test('resolveGsdCoreRoot: a dir with only scripts/ (no gsd-core/bin/lib) does NOT match', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'half-'));
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  assert.throws(() => res.resolveGsdCoreRoot(root), res.ScriptResolveError);
});

test('resolveGsdCoreRoot: no sentinel ancestor → throws ScriptResolveError', () => {
  const lonely = fs.mkdtempSync(path.join(os.tmpdir(), 'no-sentinel-'));
  assert.throws(() => res.resolveGsdCoreRoot(lonely), res.ScriptResolveError);
});

test('requireLiveScript: loads a present module exports', () => {
  const root = makeFixtureRoot();
  const mod = res.requireLiveScript(root, 'scripts/probe.cjs');
  assert.strictEqual(typeof mod.ping, 'function');
  assert.strictEqual(mod.ping(), 'pong');
  assert.strictEqual(mod.VALUE, 42);
});

test('requireLiveScript: a missing script throws a typed ScriptResolveError with path+root', () => {
  const root = makeFixtureRoot();
  let thrown;
  try {
    res.requireLiveScript(root, 'scripts/does-not-exist.cjs');
  } catch (e) {
    thrown = e;
  }
  assert.ok(thrown instanceof res.ScriptResolveError, 'must be a typed ScriptResolveError');
  assert.strictEqual(thrown.root, root);
  assert.match(thrown.attemptedPath, /does-not-exist\.cjs$/);
});

test('requireLiveScript: NEVER falls back to a vendored copy — a missing live script is an error', () => {
  const root = makeFixtureRoot();
  // There is no local reimplementation to silently return; it must throw.
  assert.throws(
    () => res.requireLiveScript(root, 'scripts/issue-version-gate.cjs'),
    res.ScriptResolveError
  );
});

test('requireLiveScript: a module that throws at require-time → ScriptResolveError (→ fail closed)', () => {
  const root = makeFixtureRoot();
  fs.writeFileSync(
    path.join(root, 'scripts', 'boom.cjs'),
    "throw new Error('module init failed');\n"
  );
  assert.throws(() => res.requireLiveScript(root, 'scripts/boom.cjs'), res.ScriptResolveError);
});

// --- RES-02: the ~/.claude install-root false-checkout tightening (D-03/D-05 guardrails) ---
// hasSentinel now additionally requires a GSD_CORE_IDENTITY_SCRIPTS basename under scripts/
// (a disjunction — .some, not .every). Proven both directions: the install-root shape
// (scripts/ + gsd-core/bin/lib/ but NO live policy script) is rejected; a real checkout
// missing ONE identity script (three of four present) still resolves (HARD-02 preserved).

test('hasSentinel identity: a ~/.claude install-root shape (scripts/ + gsd-core/bin/lib/, NO identity script) is REJECTED', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-install-root-'));
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'gsd-core', 'bin', 'lib'), { recursive: true });
  // A non-policy script under scripts/ — present in the real ~/.claude install, but not one
  // of the GSD_CORE_IDENTITY_SCRIPTS basenames, so it must NOT satisfy the identity check.
  fs.writeFileSync(
    path.join(root, 'scripts', 'fix-slash-commands.cjs'),
    'module.exports = {};\n'
  );

  assert.strictEqual(res.hasSentinel(root), false);
  assert.throws(() => res.resolveGsdCoreRoot(root), res.ScriptResolveError);
  assert.strictEqual(res.resolveRootForCommand('ls -R', root), null);
});

test('hasSentinel identity disjunction: a real checkout missing ONE identity script (3 of 4 present) STILL resolves', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'checkout-one-renamed-'));
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'gsd-core', 'bin', 'lib'), { recursive: true });
  // Three of GSD_CORE_IDENTITY_SCRIPTS present; issue-version-gate.cjs deliberately absent
  // (simulates an upstream single-script rename) — the disjunction must still match.
  const present = res.GSD_CORE_IDENTITY_SCRIPTS.filter((name) => name !== 'issue-version-gate.cjs');
  assert.strictEqual(present.length, 3);
  for (const name of present) {
    fs.writeFileSync(path.join(root, 'scripts', name), 'module.exports = {};\n');
  }

  assert.strictEqual(res.hasSentinel(root), true);
  assert.strictEqual(fs.realpathSync(res.resolveGsdCoreRoot(root)), fs.realpathSync(root));
});

test('hasSentinel identity: the updated makeFixtureRoot fixture still resolves (no new false-negative, D-05)', () => {
  const root = makeFixtureRoot();
  assert.strictEqual(res.hasSentinel(root), true);
  assert.strictEqual(fs.realpathSync(res.resolveGsdCoreRoot(root)), fs.realpathSync(root));
});

// --- commandStartDir: derive the effective cwd from a `cd ... && git ...` command ---
// The bug this fixes: a hook resolving the gsd-core root from process.cwd() lints the
// SESSION's repo, not the worktree the git command actually targets. The git command
// usually starts with `cd <worktree> && git commit`, so the effective cwd is the cd
// target, not the hook's process.cwd().

const BASE = '/home/dave/repos/gsd-core';

test('commandStartDir: no cd → returns the base cwd', () => {
  const parsed = parseCommand('git commit -m "x"');
  assert.strictEqual(res.commandStartDir(parsed, BASE), BASE);
});

test('commandStartDir: leading `cd <abs> && git` → returns the cd target', () => {
  const parsed = parseCommand('cd /home/dave/repos/gsd-core-1549-pr-title && git commit -m "x"');
  assert.strictEqual(
    res.commandStartDir(parsed, BASE),
    '/home/dave/repos/gsd-core-1549-pr-title'
  );
});

test('commandStartDir: relative cd resolves against the base cwd', () => {
  const parsed = parseCommand('cd ../gsd-core-1549-pr-title && git commit -m "x"');
  assert.strictEqual(
    res.commandStartDir(parsed, BASE),
    '/home/dave/repos/gsd-core-1549-pr-title'
  );
});

test('commandStartDir: expands a leading ~ in the cd target', () => {
  const parsed = parseCommand('cd ~/repos/gsd-core-1549-pr-title && git commit -m "x"');
  assert.strictEqual(
    res.commandStartDir(parsed, BASE),
    path.join(os.homedir(), 'repos', 'gsd-core-1549-pr-title')
  );
});

test('commandStartDir: multiple cd segments → the last one wins', () => {
  const parsed = parseCommand('cd /tmp && cd /home/dave/repos/gsd-core-1549-pr-title && git commit');
  assert.strictEqual(
    res.commandStartDir(parsed, BASE),
    '/home/dave/repos/gsd-core-1549-pr-title'
  );
});

test('commandStartDir: an unparseable command → falls back to the base cwd', () => {
  assert.strictEqual(res.commandStartDir({ ok: false, reason: 'x' }, BASE), BASE);
});

test('commandStartDir: missing baseCwd → defaults to process.cwd()', () => {
  const parsed = parseCommand('git status');
  assert.strictEqual(res.commandStartDir(parsed), process.cwd());
});

// --- commandStartDir: follow `git -C <dir>` ONLY under the opt-in `{followGitC:true}` (ENF-21
//     narrowing). A `git -C <other-repo> push` from a gsd-core SESSION cwd must resolve the OTHER
//     tree, not the session's — otherwise the runtime-freshness gate false-fires on a push to an
//     unrelated repo. The default (no opt) must NOT follow `-C`, so the commit-convention gate's
//     CR-01 over-deny is preserved. ---
const FGC = { followGitC: true };

test('commandStartDir: default does NOT follow `git -C` (preserves commit-convention over-deny)', () => {
  const parsed = parseCommand('git -C /home/dave/repos/gsd-handover push origin main');
  assert.strictEqual(res.commandStartDir(parsed, BASE), BASE);
});

test('commandStartDir(followGitC): `git -C <abs>` → returns the -C target', () => {
  const parsed = parseCommand('git -C /home/dave/repos/gsd-handover push origin main');
  assert.strictEqual(res.commandStartDir(parsed, BASE, FGC), '/home/dave/repos/gsd-handover');
});

test('commandStartDir(followGitC): relative `git -C` resolves against the base cwd', () => {
  const parsed = parseCommand('git -C ../gsd-handover push');
  assert.strictEqual(res.commandStartDir(parsed, BASE, FGC), '/home/dave/repos/gsd-handover');
});

test('commandStartDir(followGitC): a SUBCOMMAND -C (git log -C) is NOT a chdir', () => {
  const parsed = parseCommand('git log -C 50');
  assert.strictEqual(res.commandStartDir(parsed, BASE, FGC), BASE);
});

test('commandStartDir(followGitC): a global -C before a subcommand -C uses only the global one', () => {
  const parsed = parseCommand('git -C /home/dave/repos/gsd-handover log -C 50');
  assert.strictEqual(res.commandStartDir(parsed, BASE, FGC), '/home/dave/repos/gsd-handover');
});

test('commandStartDir(followGitC): multiple global -C apply cumulatively', () => {
  const parsed = parseCommand('git -C /home/dave/repos -C gsd-handover push');
  assert.strictEqual(res.commandStartDir(parsed, BASE, FGC), '/home/dave/repos/gsd-handover');
});

test('commandStartDir(followGitC): `git -c k=v -C <abs>` skips the -c value and follows -C', () => {
  const parsed = parseCommand('git -c user.name=x -C /home/dave/repos/gsd-handover push');
  assert.strictEqual(res.commandStartDir(parsed, BASE, FGC), '/home/dave/repos/gsd-handover');
});

test('resolveRootForCommand(followGitC): `git -C <non-gsd-core>` from a gsd-core cwd → null', () => {
  const gsdRoot = makeFixtureRoot();
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'not-gsd-core-'));
  // Before the -C fix this false-resolved to the session cwd (gsdRoot) and gated the push.
  assert.strictEqual(
    res.resolveRootForCommand('git -C ' + other + ' push origin main', gsdRoot, FGC),
    null
  );
  fs.rmSync(other, { recursive: true, force: true });
  fs.rmSync(gsdRoot, { recursive: true, force: true });
});

test('resolveRootForCommand(followGitC): `git -C <gsd-core-checkout>` → that root (still gated)', () => {
  const gsdRoot = makeFixtureRoot();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'session-'));
  assert.strictEqual(res.resolveRootForCommand('git -C ' + gsdRoot + ' push', base, FGC), gsdRoot);
  fs.rmSync(base, { recursive: true, force: true });
  fs.rmSync(gsdRoot, { recursive: true, force: true });
});

test('resolveRootForCommand default (no opt): `git -C <non-gsd-core>` still resolves the session root', () => {
  const gsdRoot = makeFixtureRoot();
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'not-gsd-core-'));
  // Default behavior unchanged: no -C following, so the session (gsdRoot) is resolved.
  assert.strictEqual(
    res.resolveRootForCommand('git -C ' + other + ' commit -m "x"', gsdRoot),
    gsdRoot
  );
  fs.rmSync(other, { recursive: true, force: true });
  fs.rmSync(gsdRoot, { recursive: true, force: true });
});

// --- resolveRootForCommand: root-or-null for a parsed command's effective cwd ---

test('resolveRootForCommand: cd into a gsd-core checkout → returns that root', () => {
  const root = makeFixtureRoot();
  const got = res.resolveRootForCommand(`cd ${root} && git commit -m x`, '/some/other/base');
  assert.strictEqual(fs.realpathSync(got), fs.realpathSync(root));
});

test('resolveRootForCommand: cd into a NON-gsd-core dir → returns null (not our concern)', () => {
  const lonely = fs.mkdtempSync(path.join(os.tmpdir(), 'no-core-'));
  assert.strictEqual(res.resolveRootForCommand(`cd ${lonely} && git commit -m x`, lonely), null);
});

test('resolveRootForCommand: no cd, baseCwd is a gsd-core checkout → returns the base root', () => {
  const root = makeFixtureRoot();
  assert.strictEqual(
    fs.realpathSync(res.resolveRootForCommand('git status', root)),
    fs.realpathSync(root)
  );
});

// --- commandTargetsGsdCore: does a parsed command explicitly target UPSTREAM open-gsd/gsd-core? ---
// The ROB-01 discriminator (HARD-04: reads STRUCTURED argv, never a raw-string re-parse).
// An out-of-tree command (resolveRootForCommand → null) passes through (ALLOW) ONLY when it does
// NOT target upstream gsd-core. A `-R/--repo open-gsd/gsd-core`, a gh-api `repos/open-gsd/gsd-core`
// path positional, or a curl `api.github.com/repos/open-gsd/gsd-core` URL all target it regardless
// of cwd → those must NOT passthrough (Task 2 fails them closed).

test('commandTargetsGsdCore: native -R open-gsd/gsd-core → true', () => {
  assert.strictEqual(
    res.commandTargetsGsdCore(parseCommand('gh issue create -R open-gsd/gsd-core --title x')),
    true
  );
});

test('commandTargetsGsdCore: --repo open-gsd/gsd-core → true', () => {
  assert.strictEqual(
    res.commandTargetsGsdCore(parseCommand('gh issue create --repo open-gsd/gsd-core --title x')),
    true
  );
});

test('commandTargetsGsdCore: --repo=open-gsd/gsd-core (attached form) → true', () => {
  assert.strictEqual(
    res.commandTargetsGsdCore(parseCommand('gh pr create --repo=open-gsd/gsd-core --base next')),
    true
  );
});

test('commandTargetsGsdCore: host-qualified -R github.com/open-gsd/gsd-core → true', () => {
  assert.strictEqual(
    res.commandTargetsGsdCore(parseCommand('gh issue create -R github.com/open-gsd/gsd-core')),
    true
  );
});

test('commandTargetsGsdCore: -R open-gsd/gsd-core.git (trailing .git stripped) → true', () => {
  assert.strictEqual(
    res.commandTargetsGsdCore(parseCommand('gh issue create -R open-gsd/gsd-core.git')),
    true
  );
});

test('commandTargetsGsdCore: gh api -X POST repos/open-gsd/gsd-core/issues → true', () => {
  assert.strictEqual(
    res.commandTargetsGsdCore(
      parseCommand('gh api -X POST repos/open-gsd/gsd-core/issues -f title=x')
    ),
    true
  );
});

test('commandTargetsGsdCore: gh api repos/open-gsd/gsd-core/pulls → true', () => {
  assert.strictEqual(
    res.commandTargetsGsdCore(parseCommand('gh api repos/open-gsd/gsd-core/pulls')),
    true
  );
});

test('commandTargetsGsdCore: curl api.github.com/repos/open-gsd/gsd-core URL → true', () => {
  assert.strictEqual(
    res.commandTargetsGsdCore(
      parseCommand('curl -X POST https://api.github.com/repos/open-gsd/gsd-core/issues -d "{}"')
    ),
    true
  );
});

test('commandTargetsGsdCore: a fork (dave/gsd-core-fork) is NOT a target → false', () => {
  assert.strictEqual(
    res.commandTargetsGsdCore(parseCommand('gh issue create -R dave/gsd-core-fork --title x')),
    false
  );
});

test('commandTargetsGsdCore: dave/gsd-core (right repo name, WRONG owner) → false', () => {
  assert.strictEqual(
    res.commandTargetsGsdCore(parseCommand('gh issue create -R dave/gsd-core --title x')),
    false
  );
});

test('commandTargetsGsdCore: gh issue list (no -R) → false', () => {
  assert.strictEqual(res.commandTargetsGsdCore(parseCommand('gh issue list')), false);
});

test('commandTargetsGsdCore: a non-gh out-of-tree command (cat) → false', () => {
  assert.strictEqual(
    res.commandTargetsGsdCore(parseCommand('cat ~/.claude/skills/x/law.md')),
    false
  );
});

test('commandTargetsGsdCore: cd into a skills dir then cat → false', () => {
  assert.strictEqual(
    res.commandTargetsGsdCore(parseCommand('cd ~/.claude/skills/x && cat law.md')),
    false
  );
});

test('commandTargetsGsdCore: an unparseable / empty / null parse result → false', () => {
  assert.strictEqual(res.commandTargetsGsdCore({ ok: false, reason: 'x' }), false);
  assert.strictEqual(res.commandTargetsGsdCore(null), false);
  assert.strictEqual(res.commandTargetsGsdCore(parseCommand('')), false);
});

// --- parseOwnerRepo: the SINGLE enumerated owner/repo normalizer (CHD-01, Task 1) ---
// Postel-inversion (binding): the accepted forms are ENUMERATED; an un-enumerated /
// GitHub-ish-but-unparseable input returns null (the explicit "unparseable" signal the
// three-way commandTargetsGsdCore caller treats as fail-closed). Owner/repo are LOWER-cased
// (GitHub routes them case-insensitively — CR-01). host is lowercased too.

test('parseOwnerRepo: bare owner/repo → lowercased {owner,repo,host:github.com}', () => {
  assert.deepStrictEqual(res.parseOwnerRepo('open-gsd/gsd-core'), {
    owner: 'open-gsd',
    repo: 'gsd-core',
    host: 'github.com',
  });
});

test('parseOwnerRepo: case-variant bare owner/repo → lowercased (CR-01)', () => {
  assert.deepStrictEqual(res.parseOwnerRepo('Open-GSD/GSD-Core'), {
    owner: 'open-gsd',
    repo: 'gsd-core',
    host: 'github.com',
  });
});

test('parseOwnerRepo: https URL with trailing .git → owner/repo', () => {
  assert.deepStrictEqual(res.parseOwnerRepo('https://github.com/open-gsd/gsd-core.git'), {
    owner: 'open-gsd',
    repo: 'gsd-core',
    host: 'github.com',
  });
});

test('parseOwnerRepo: https URL with an explicit :port → port stripped from host', () => {
  assert.deepStrictEqual(res.parseOwnerRepo('https://github.com:443/open-gsd/gsd-core'), {
    owner: 'open-gsd',
    repo: 'gsd-core',
    host: 'github.com',
  });
});

test('parseOwnerRepo: ssh git@host:owner/repo.git → owner/repo + host', () => {
  assert.deepStrictEqual(res.parseOwnerRepo('git@github.com:open-gsd/gsd-core.git'), {
    owner: 'open-gsd',
    repo: 'gsd-core',
    host: 'github.com',
  });
});

test('parseOwnerRepo: gh:owner/repo shorthand → owner/repo', () => {
  assert.deepStrictEqual(res.parseOwnerRepo('gh:open-gsd/gsd-core'), {
    owner: 'open-gsd',
    repo: 'gsd-core',
    host: 'github.com',
  });
});

test('parseOwnerRepo: GH_HOST-qualified enterprise host is retained (lowercased)', () => {
  assert.deepStrictEqual(res.parseOwnerRepo('https://ghe.example.com/open-gsd/gsd-core'), {
    owner: 'open-gsd',
    repo: 'gsd-core',
    host: 'ghe.example.com',
  });
});

test('parseOwnerRepo: a GitHub-ish-but-unparseable input → null (fail-closed signal)', () => {
  assert.strictEqual(res.parseOwnerRepo('weird::garbage'), null);
  assert.strictEqual(res.parseOwnerRepo(':::bad'), null);
  assert.strictEqual(res.parseOwnerRepo('foo'), null); // single bare word, <2 segments
  assert.strictEqual(res.parseOwnerRepo(''), null);
  assert.strictEqual(res.parseOwnerRepo('   '), null);
  assert.strictEqual(res.parseOwnerRepo(null), null);
  assert.strictEqual(res.parseOwnerRepo(undefined), null);
  assert.strictEqual(res.parseOwnerRepo(42), null);
});

// --- repoSpecTargetsGsdCore: rerouted through parseOwnerRepo (case-fold) ---

test('repoSpecTargetsGsdCore: Open-GSD/GSD-Core (case-variant) → true (CR-01)', () => {
  assert.strictEqual(res.repoSpecTargetsGsdCore('Open-GSD/GSD-Core'), true);
});

test('repoSpecTargetsGsdCore: open-gsd/gsd-core → true', () => {
  assert.strictEqual(res.repoSpecTargetsGsdCore('open-gsd/gsd-core'), true);
});

test('repoSpecTargetsGsdCore: dave/gsd-core-fork → false (no false-deny)', () => {
  assert.strictEqual(res.repoSpecTargetsGsdCore('dave/gsd-core-fork'), false);
});

test('repoSpecTargetsGsdCore: dave/gsd-core (wrong owner) → false', () => {
  assert.strictEqual(res.repoSpecTargetsGsdCore('dave/gsd-core'), false);
});

test('repoSpecTargetsGsdCore: a non-string / empty → false', () => {
  assert.strictEqual(res.repoSpecTargetsGsdCore(''), false);
  assert.strictEqual(res.repoSpecTargetsGsdCore(true), false);
  assert.strictEqual(res.repoSpecTargetsGsdCore(undefined), false);
});

// --- tokenTargetsGsdCoreApi: rerouted; closes the api.github.com:443 port-slip ---

test('tokenTargetsGsdCoreApi: api.github.com/repos/open-gsd/gsd-core/issues → true', () => {
  assert.strictEqual(
    res.tokenTargetsGsdCoreApi('https://api.github.com/repos/open-gsd/gsd-core/issues'),
    true
  );
});

test('tokenTargetsGsdCoreApi: api.github.com:443/... (port stripped) → true', () => {
  assert.strictEqual(
    res.tokenTargetsGsdCoreApi('https://api.github.com:443/repos/open-gsd/gsd-core/pulls'),
    true
  );
});

test('tokenTargetsGsdCoreApi: a bare repos/<owner>/<repo> path positional → true', () => {
  assert.strictEqual(res.tokenTargetsGsdCoreApi('repos/open-gsd/gsd-core/issues'), true);
});

test('tokenTargetsGsdCoreApi: case-variant repos/Open-GSD/GSD-Core → true (CR-01)', () => {
  assert.strictEqual(res.tokenTargetsGsdCoreApi('repos/Open-GSD/GSD-Core/issues'), true);
});

test('tokenTargetsGsdCoreApi: a fork repos/dave/gsd-core-fork/issues → false', () => {
  assert.strictEqual(res.tokenTargetsGsdCoreApi('repos/dave/gsd-core-fork/issues'), false);
});

test('tokenTargetsGsdCoreApi: a non-repos/ path does NOT match → false', () => {
  assert.strictEqual(res.tokenTargetsGsdCoreApi('open-gsd/gsd-core'), false);
  assert.strictEqual(res.tokenTargetsGsdCoreApi('user/repos/open-gsd/gsd-core'), false);
});

// --- commandTargetsGsdCore: GH_REPO-aware + three-way discriminator (CHD-01, Task 2) ---
// Three-way (binding [Postel + Leaky Abstractions]):
//   clearly-not-targeting (no repo-spec intent) → false (ROB-01 passthrough preserved)
//   explicit spec that parses as open-gsd/gsd-core → true (DENY)
//   explicit spec that is GitHub-ish but parseOwnerRepo CANNOT resolve → true (fail-closed DENY)
//   explicit spec that parses as a clearly-non-upstream fork → false (no false-deny)

test('commandTargetsGsdCore: case-variant -R Open-GSD/GSD-Core → true (CR-01 via Task-1 reroute)', () => {
  assert.strictEqual(
    res.commandTargetsGsdCore(parseCommand('gh issue create -R Open-GSD/GSD-Core --title x')),
    true
  );
});

test('commandTargetsGsdCore: GH_REPO=open-gsd/gsd-core env token → true (CR-02)', () => {
  const parsed = parseCommand('GH_REPO=open-gsd/gsd-core gh issue create --title x');
  // Goodhart: assert the env token actually drove the classification — argv keeps the
  // leading NAME=VALUE in seg.tokens (not seg.program, which is `gh`).
  assert.strictEqual(parsed.segments[0].program, 'gh');
  assert.strictEqual(parsed.segments[0].tokens[0], 'GH_REPO=open-gsd/gsd-core');
  assert.strictEqual(res.commandTargetsGsdCore(parsed), true);
});

test('commandTargetsGsdCore: case-variant GH_REPO=Open-GSD/GSD-Core env token → true', () => {
  assert.strictEqual(
    res.commandTargetsGsdCore(parseCommand('GH_REPO=Open-GSD/GSD-Core gh pr create --base next')),
    true
  );
});

test('commandTargetsGsdCore: GH_HOST + GH_REPO env tokens → true (host-qualified)', () => {
  assert.strictEqual(
    res.commandTargetsGsdCore(
      parseCommand('GH_HOST=github.com GH_REPO=open-gsd/gsd-core gh issue create --title x')
    ),
    true
  );
});

test('commandTargetsGsdCore: GH_REPO=dave/gsd-core-fork (fork env token) → false (no false-deny)', () => {
  assert.strictEqual(
    res.commandTargetsGsdCore(parseCommand('GH_REPO=dave/gsd-core-fork gh issue create --title x')),
    false
  );
});

test('commandTargetsGsdCore: explicit -R weird::garbage (githubish-unparseable) → true (fail-closed)', () => {
  assert.strictEqual(
    res.commandTargetsGsdCore(parseCommand('gh issue create -R weird::garbage --title x')),
    true
  );
});

test('commandTargetsGsdCore: explicit GH_REPO=:::bad (githubish-unparseable) → true (fail-closed)', () => {
  assert.strictEqual(
    res.commandTargetsGsdCore(parseCommand('GH_REPO=:::bad gh issue create --title x')),
    true
  );
});

test('commandTargetsGsdCore: a lowercase NAME=VALUE (not GH_REPO) leading token is ignored → false', () => {
  // `gh_repo=...` (lowercase) is NOT the GH_REPO env var; must not trigger targeting.
  assert.strictEqual(
    res.commandTargetsGsdCore(parseCommand('gh issue list')),
    false
  );
});

test('commandTargetsGsdCore: a -f title=x field token is NOT mistaken for an env assignment → false', () => {
  // The `title=x` token follows the program; it is not a leading env assignment.
  assert.strictEqual(
    res.commandTargetsGsdCore(parseCommand('gh api repos/dave/gsd-core-fork/issues -f title=x')),
    false
  );
});

// --- Integration against the REAL gsd-core checkout when present ---
const REAL_GSD_CORE = '/home/dave/repos/gsd-core';
const hasRealCore =
  fs.existsSync(path.join(REAL_GSD_CORE, 'scripts')) &&
  fs.existsSync(path.join(REAL_GSD_CORE, 'gsd-core', 'bin', 'lib'));

test('real gsd-core: resolves the root and require()s the LIVE issue-version-gate / pr-target-policy', { skip: !hasRealCore }, () => {
  const root = res.resolveGsdCoreRoot(path.join(REAL_GSD_CORE, 'scripts'));
  assert.strictEqual(fs.realpathSync(root), fs.realpathSync(REAL_GSD_CORE));

  const versionGate = res.requireLiveScript(root, 'scripts/issue-version-gate.cjs');
  assert.strictEqual(typeof versionGate.evaluateVersionGate, 'function');

  const prTarget = res.requireLiveScript(root, 'scripts/pr-target-policy.cjs');
  assert.strictEqual(typeof prTarget.classifyPrTarget, 'function');
  // Shape-check a RETURN (what the doctor in 03-06 will do on fixtures).
  const decision = prTarget.classifyPrTarget('next', 'anything');
  assert.strictEqual(decision.decision, 'allowed');
});

// ───────────────── the shared branch-naming policy (one definition) ─────────────────
//
// Mirrors upstream `.github/workflows/branch-naming.yml`. These cases are the exact ones the
// two former local copies got WRONG: gh-pr-create.cjs allowed only `fix|docs|feat` AND demanded
// an issue number; protocol-artifact.cjs invented `enh/` and missed five upstream prefixes.

test('branch policy: every upstream prefix is conventional (the 8 gh-pr-create used to DENY)', () => {
  for (const p of res.UPSTREAM_BRANCH_PREFIXES) {
    assert.strictEqual(res.isConventionalBranch(p + '2801-thing'), true,
      p + ' is valid upstream and must not be denied');
  }
  // The specific regressions: these were denied by the old /^(fix|docs|feat)\/\d+-/.
  for (const b of ['hotfix/2801-x', 'perf/2801-x', 'refactor/2801-x', 'test/2801-x',
    'release/1.9.0', 'ci/2801-x', 'revert/2801-x']) {
    assert.strictEqual(res.isConventionalBranch(b), true, b + ' must be accepted');
  }
});

test('branch policy: upstream requires NO issue number — a bare slug is conventional', () => {
  // The old gh-pr-create regex demanded `\d+-`; upstream never does.
  assert.strictEqual(res.isConventionalBranch('fix/typo-in-readme'), true);
  assert.strictEqual(res.isConventionalBranch('docs/clarify-adr-0007'), true);
});

test('branch policy: `enh/` was INVENTED locally and is not upstream', () => {
  assert.strictEqual(res.isConventionalBranch('enh/2801-x'), false);
  assert.strictEqual(res.isContribBranch('enh/2801-x'), false);
});

test('branch policy: a non-conventional prefix is rejected', () => {
  for (const b of ['wip/thing', 'dave/scratch', 'nonsense', '']) {
    assert.strictEqual(res.isConventionalBranch(b), false, b + ' must be rejected');
  }
});

test('branch policy: upstream exemptions are conventional but are NOT contribution branches', () => {
  for (const b of ['main', 'next', 'develop', 'dependabot/npm/x', 'renovate/y',
    'gsd/auto-1', 'claude/auto-2']) {
    assert.strictEqual(res.isConventionalBranch(b), true, b + ' is exempt upstream');
    assert.strictEqual(res.isContribBranch(b), false,
      b + ' must never ARM the artifact protocol');
  }
});

test('branch policy: the five prefixes protocol-artifact used to MISS now arm the family', () => {
  // The enforcement hole: `hotfix|test|release|ci|revert` did not arm the artifact protocol.
  for (const b of ['hotfix/2801-x', 'test/2801-x', 'release/1.9.0', 'ci/2801-x', 'revert/2801-x']) {
    assert.strictEqual(res.isContribBranch(b), true, b + ' must arm the protocol');
  }
});

test('branch policy: the two gates now agree — contrib ⊆ conventional, no gate-only branch', () => {
  const samples = ['fix/1-a', 'hotfix/2-b', 'enh/3-c', 'wip/d', 'next', 'main',
    'dependabot/x', 'release/1.0.0', 'fix/no-number'];
  for (const b of samples) {
    if (res.isContribBranch(b)) {
      assert.strictEqual(res.isConventionalBranch(b), true,
        b + ' arms the protocol but would be DENIED at PR time — the old contradiction');
    }
  }
});
