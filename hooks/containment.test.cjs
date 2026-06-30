'use strict';

/**
 * node:test for hooks/containment.cjs (ENF-06 containment A + ENF-07 containment B /
 * HARD-01 / HARD-04).
 *
 * Drives the gate through the injectable runContainmentGate(input, deps) seam: the staged
 * paths (for A) and the remote URL + current branch (for B) are injected so the unit suite
 * needs no real gsd-core worktree, git index, or remotes.
 */

const test = require('node:test');
const assert = require('node:assert');

const { parseCommand } = require('./lib/argv.cjs');
const {
  runContainmentGate,
  isToolkitArtifact,
  isUpstreamRemote,
  isContributionBranch,
  detectGit,
} = require('./containment.cjs');

function input(command) {
  return JSON.stringify({ tool_name: 'Bash', tool_input: { command } });
}

function deps(over = {}) {
  return Object.assign(
    {
      gsdCoreRoot: '/tmp/gsd-core',
      // A: paths being staged for a bare `git commit` (the cached set).
      stagedPaths: () => [],
      // B: remote URL resolver + current branch.
      remoteUrl: () => 'git@github.com:dave/gsd-core-fork.git',
      currentBranch: () => 'main',
      worktreeRoot: '/tmp/gsd-core',
      overrideImpl: { checkOverride: () => ({ override: false }), writeReceipt: () => {} },
    },
    over
  );
}

const UPSTREAM = 'https://github.com/open-gsd/gsd-core.git';
const FORK = 'git@github.com:dave/gsd-core-fork.git';

// ---- non-targeted commands ----

test('git status → allow (no-op)', () => {
  assert.strictEqual(runContainmentGate(input('git status'), deps()).permissionDecision, 'allow');
});

// ---- Containment A (ENF-06): staging .planning / toolkit artifacts ----

test('git add .planning/x → DENY (ENF-06 containment A)', () => {
  const d = runContainmentGate(input('git add .planning/STATE.md'), deps());
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
  assert.match(d.permissionDecisionReason, /\.planning/);
});

test('git add of a toolkit artifact (settings.snippet.json) → DENY (ENF-06)', () => {
  const d = runContainmentGate(input('git add settings.snippet.json'), deps());
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
});

test('git add of legitimate gsd-core source (sdk/) → allow', () => {
  const d = runContainmentGate(input('git add sdk/src/query/decisions.ts'), deps());
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

test('git add . with a .planning path in the cached set → DENY (ENF-06)', () => {
  // `git add .` has no explicit positional path → fall back to the staged/cached set.
  const d = runContainmentGate(
    input('git add .'),
    deps({ stagedPaths: () => ['sdk/x.ts', '.planning/ROADMAP.md'] })
  );
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
  assert.match(d.permissionDecisionReason, /\.planning/);
});

test('git commit with .planning staged in the cached set → DENY (ENF-06)', () => {
  const d = runContainmentGate(
    input('git commit -m x'),
    deps({ stagedPaths: () => ['.planning/STATE.md'] })
  );
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
});

test('git commit with only legitimate source staged → allow', () => {
  const d = runContainmentGate(
    input('git commit -m x'),
    deps({ stagedPaths: () => ['sdk/src/query/decisions.ts', 'docs/adr/0001.md'] })
  );
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

// ---- Containment B (ENF-07): upstream push from a non-contribution branch ----

test('git push origin main where origin=open-gsd → DENY (ENF-07 containment B)', () => {
  const d = runContainmentGate(
    input('git push origin main'),
    deps({ remoteUrl: (root, r) => (r === 'origin' ? UPSTREAM : FORK), currentBranch: () => 'main' })
  );
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
  assert.match(d.permissionDecisionReason, /open-gsd|upstream|fork/i);
});

test('git push origin fix/12-x to upstream origin → DENY (contribution goes via a fork)', () => {
  const d = runContainmentGate(
    input('git push origin fix/12-x'),
    deps({ remoteUrl: () => UPSTREAM, currentBranch: () => 'fix/12-x' })
  );
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
  assert.match(d.permissionDecisionReason, /fork/i);
});

test('git push fork fix/12-x (fork remote, contribution branch) → allow', () => {
  const d = runContainmentGate(
    input('git push fork fix/12-x'),
    deps({ remoteUrl: (root, r) => (r === 'fork' ? FORK : UPSTREAM), currentBranch: () => 'fix/12-x' })
  );
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

// G2: `-u` / `--set-upstream` must not swallow the remote. The generic argv parser
// treats a lone short flag as value-taking, so `git push -u fork x` previously lost
// `fork` and pushRemote fell back to 'origin' — mis-checking a fork push against the
// upstream origin and falsely DENYING it.

test('git push -u fork fix/12-x (fork remote, contribution branch) → allow [G2]', () => {
  const d = runContainmentGate(
    input('git push -u fork fix/12-x'),
    deps({ remoteUrl: (root, r) => (r === 'fork' ? FORK : UPSTREAM), currentBranch: () => 'fix/12-x' })
  );
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

test('git push --set-upstream fork fix/12-x → allow (long-form, remote not swallowed) [G2]', () => {
  const d = runContainmentGate(
    input('git push --set-upstream fork fix/12-x'),
    deps({ remoteUrl: (root, r) => (r === 'fork' ? FORK : UPSTREAM), currentBranch: () => 'fix/12-x' })
  );
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

test('git push -u origin main where origin=upstream from main → DENY (still gated) [G2]', () => {
  const d = runContainmentGate(
    input('git push -u origin main'),
    deps({ remoteUrl: (root, r) => (r === 'origin' ? UPSTREAM : FORK), currentBranch: () => 'main' })
  );
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
});

test('git push (no remote arg) resolving to upstream from main → DENY', () => {
  const d = runContainmentGate(
    input('git push'),
    deps({ remoteUrl: () => UPSTREAM, currentBranch: () => 'main' })
  );
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
});

test('an unreadable remote URL → FAIL CLOSED deny (HARD-01/04)', () => {
  const d = runContainmentGate(
    input('git push origin main'),
    deps({
      remoteUrl: () => {
        throw new Error('no such remote');
      },
    })
  );
  assert.strictEqual(d.permissionDecision, 'deny');
});

test('unreadable remote WITH a logged override → allow (HARD-03)', () => {
  const d = runContainmentGate(
    input('git push origin main'),
    deps({
      remoteUrl: () => {
        throw new Error('no such remote');
      },
      overrideImpl: {
        checkOverride: () => ({ override: true, reason: 'detached CI remote' }),
        writeReceipt: () => '/tmp/gsd-core/.gsd-contrib/override-receipts.log',
      },
    })
  );
  assert.strictEqual(d.permissionDecision, 'allow');
});

// ---- ROB-03 (ENF-07 option B): accountable origin-ONLY override + honest messages ----
// The override is consulted ONLY on the conjunction (remote NAME === 'origin') AND
// (isUpstreamRemote(url) === true). The remote NAME — not just the URL — is the origin-only
// discriminator: 'origin' and 'upstream' below both resolve to UPSTREAM, yet only 'origin' is
// overridable.

test('origin upstream push WITH a valid override → ALLOW + a receipt is written [ROB-03]', () => {
  const calls = [];
  const d = runContainmentGate(
    input('git push origin fix/12-x'),
    deps({
      remoteUrl: (root, r) => (r === 'origin' ? UPSTREAM : FORK),
      currentBranch: () => 'fix/12-x',
      overrideImpl: {
        checkOverride: () => ({ override: true, reason: 'maintainer push #1738' }),
        writeReceipt: (root, record) => {
          calls.push({ root, record });
          return '/tmp/gsd-core/.gsd-contrib/override-receipts.log';
        },
      },
    })
  );
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
  // The receipt MUST actually have been written (a bypass we cannot log is one we cannot honor).
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].root, '/tmp/gsd-core'); // keyed to the per-worktree gsd-core root
  assert.strictEqual(calls[0].record.reason, 'maintainer push #1738');
  assert.strictEqual(calls[0].record.action, 'containment-upstream-push');
});

test('origin upstream push, override set but writeReceipt THROWS → DENY (fail closed) [ROB-03]', () => {
  const d = runContainmentGate(
    input('git push origin fix/12-x'),
    deps({
      remoteUrl: (root, r) => (r === 'origin' ? UPSTREAM : FORK),
      currentBranch: () => 'fix/12-x',
      overrideImpl: {
        checkOverride: () => ({ override: true, reason: 'maintainer push' }),
        writeReceipt: () => {
          throw new Error('disk full');
        },
      },
    })
  );
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
  assert.match(d.permissionDecisionReason, /receipt could not be written/);
});

test('NON-origin upstream remote WITH override set → DENY, message has NO override promise [ROB-03]', () => {
  // remote NAME 'upstream' resolves to open-gsd/gsd-core (isUpstreamRemote true), but the
  // override is inert here: it must DENY even with the override set, and must NOT advertise it.
  const d = runContainmentGate(
    input('git push upstream fix/12-x'),
    deps({
      remoteUrl: () => UPSTREAM,
      currentBranch: () => 'fix/12-x',
      overrideImpl: {
        checkOverride: () => ({ override: true, reason: 'maintainer push' }),
        // The consult must NEVER reach this remote — a write here is a bug.
        writeReceipt: () => {
          throw new Error('writeReceipt must not be called on a non-origin remote');
        },
      },
    })
  );
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
  assert.doesNotMatch(d.permissionDecisionReason, /GSD_CONTRIB_OVERRIDE/);
});

test('origin upstream push with NO override → DENY, message DOES advertise GSD_CONTRIB_OVERRIDE [ROB-03]', () => {
  const d = runContainmentGate(
    input('git push origin fix/12-x'),
    deps({
      remoteUrl: (root, r) => (r === 'origin' ? UPSTREAM : FORK),
      currentBranch: () => 'fix/12-x',
      overrideImpl: { checkOverride: () => ({ override: false }), writeReceipt: () => {} },
    })
  );
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
  assert.match(d.permissionDecisionReason, /GSD_CONTRIB_OVERRIDE/);
});

test('fork push with an override set → ALLOW, the override is never consulted [ROB-03]', () => {
  // isUpstreamRemote(FORK) === false → allow before the consult; checkOverride must not run.
  const d = runContainmentGate(
    input('git push fork fix/12-x'),
    deps({
      remoteUrl: (root, r) => (r === 'fork' ? FORK : UPSTREAM),
      currentBranch: () => 'fix/12-x',
      overrideImpl: {
        checkOverride: () => {
          throw new Error('override must not be consulted on a fork push');
        },
        writeReceipt: () => {},
      },
    })
  );
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

// ---- CHAINED commands: per-action containment over one PreToolUse call (CHD-02 / CR-03) ----
// A single Bash invocation may chain add+commit+push. gate() must evaluate EVERY action, not
// just the first — the exact leak CR-03 closes: `commit && push origin main` to upstream must
// hit ENF-07 Containment B on the PUSH (today's first-match would only gate the add).

test('CHAINED add && commit && push origin main (origin=upstream) → DENY via Containment B on the PUSH [Goodhart, CR-03]', () => {
  const remoteCalls = [];
  const d = runContainmentGate(
    input('git add -A && git commit -m x && git push origin main'),
    deps({
      // legitimate staged source → Containment A on the add/commit must NOT be the denier,
      // so the only thing that can DENY is Containment B on the push.
      stagedPaths: () => ['sdk/src/query/decisions.ts'],
      remoteUrl: (root, r) => {
        remoteCalls.push(r);
        return r === 'origin' ? UPSTREAM : FORK;
      },
      currentBranch: () => 'main',
    })
  );
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
  // Goodhart — prove the deny fired on the PUSH segment, not the add/commit:
  // (1) the push remote ('origin') was actually consulted for its URL (evaluation reached B),
  assert.ok(remoteCalls.includes('origin'), 'remoteUrl was consulted for the push segment');
  // (2) the reason is the ENF-07 upstream-push message (origin path advertises the override),
  assert.match(d.permissionDecisionReason, /ENF-07/);
  assert.match(d.permissionDecisionReason, /GSD_CONTRIB_OVERRIDE/);
  // (3) and NOT the ENF-06 staged-artifact (Containment A) message — it is the push, not the add.
  assert.doesNotMatch(d.permissionDecisionReason, /ENF-06/);
});

test('the chained push deny reason is byte-for-byte identical to the single push deny [single-action preserved, CHD-02]', () => {
  const mk = (cmd) =>
    runContainmentGate(
      input(cmd),
      deps({
        remoteUrl: (root, r) => (r === 'origin' ? UPSTREAM : FORK),
        currentBranch: () => 'main',
        stagedPaths: () => ['sdk/src/query/decisions.ts'],
      })
    );
  const single = mk('git push origin main');
  const chained = mk('git add -A && git commit -m x && git push origin main');
  assert.strictEqual(single.permissionDecision, 'deny');
  assert.strictEqual(chained.permissionDecision, 'deny');
  // The collapsed single-action path and the chained path produce the SAME reason — the push
  // action carries its own seg, so the chain reproduces the prior single-push decision exactly.
  assert.strictEqual(chained.permissionDecisionReason, single.permissionDecisionReason);
});

test('CHAINED commit && push fork branch (fork remote) → ALLOW [CR-03 regression, no false-deny]', () => {
  const d = runContainmentGate(
    input('git commit -m x && git push fork fix/12-x'),
    deps({
      stagedPaths: () => ['sdk/src/query/decisions.ts'],
      remoteUrl: (root, r) => (r === 'fork' ? FORK : UPSTREAM),
      currentBranch: () => 'fix/12-x',
    })
  );
  assert.strictEqual(d.permissionDecision, 'allow', d.permissionDecisionReason);
});

test('CHAINED add .planning/x && push fork branch → DENY via Containment A (per-add fires in a chain) [CR-03]', () => {
  // The `.planning/` staged path is an offender on the FIRST action; the gate short-circuits to
  // that deny even though the later fork push would itself ALLOW — proving A fires per-add.
  const d = runContainmentGate(
    input('git add .planning/STATE.md && git push fork fix/12-x'),
    deps({
      remoteUrl: (root, r) => (r === 'fork' ? FORK : UPSTREAM),
      currentBranch: () => 'fix/12-x',
    })
  );
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
  assert.match(d.permissionDecisionReason, /ENF-06/);
  assert.match(d.permissionDecisionReason, /\.planning/);
});

// ---- fail-closed parse / input ----

test('malformed stdin JSON → FAIL CLOSED deny (HARD-01)', () => {
  assert.strictEqual(runContainmentGate('{not json', deps()).permissionDecision, 'deny');
});

test('unparseable command (unbalanced quote) → FAIL CLOSED deny (HARD-04)', () => {
  const d = runContainmentGate(input('git commit -m "unterminated'), deps());
  assert.strictEqual(d.permissionDecision, 'deny');
});

// ---- detectGit: multi-action shape (CHD-02) ----
// detectGit now returns an ORDERED ARRAY of every relevant git action across the parsed
// segments (object → array Hyrum shape change). A chained command yields one entry per
// matching git segment, each carrying its OWN seg; a non-git command yields an empty array.

test('detectGit collects ALL chained git actions (add + commit + push), not just the first', () => {
  const actions = detectGit(parseCommand('git add -A && git commit -m x && git push origin main'));
  assert.ok(Array.isArray(actions), 'detectGit returns an array');
  assert.deepStrictEqual(actions.map((a) => a.kind), ['add', 'commit', 'push']);
  const push = actions.find((a) => a.kind === 'push');
  assert.ok(push, 'a push action is present (not dropped after the first match)');
  // each action carries its OWN segment so pushRemote(seg) resolves the right push tail.
  assert.ok(push.seg.tokens.includes('push') && push.seg.tokens.includes('origin'));
});

test('detectGit collapses a single git action to a one-element array', () => {
  const actions = detectGit(parseCommand('git commit -m x'));
  assert.strictEqual(actions.length, 1);
  assert.strictEqual(actions[0].kind, 'commit');
});

test('detectGit returns an empty array for a non-git command (the new no-op signal)', () => {
  assert.deepStrictEqual(detectGit(parseCommand('npm test')), []);
});

// ---- pure predicate units ----

test('isToolkitArtifact flags .planning + toolkit files, not gsd-core source', () => {
  assert.ok(isToolkitArtifact('.planning/STATE.md'));
  assert.ok(isToolkitArtifact('settings.snippet.json'));
  assert.ok(isToolkitArtifact('install.sh'));
  assert.ok(isToolkitArtifact('hooks/containment.cjs'));
  assert.ok(!isToolkitArtifact('sdk/src/query/decisions.ts'));
  assert.ok(!isToolkitArtifact('docs/adr/0001.md'));
});

test('isUpstreamRemote recognizes open-gsd/gsd-core across URL forms', () => {
  assert.ok(isUpstreamRemote('https://github.com/open-gsd/gsd-core.git'));
  assert.ok(isUpstreamRemote('git@github.com:open-gsd/gsd-core.git'));
  assert.ok(!isUpstreamRemote('git@github.com:dave/gsd-core-fork.git'));
  assert.ok(!isUpstreamRemote('https://github.com/dave/gsd-core.git'));
});

// CHD-01 (T-26-02-01): rerouted through parseOwnerRepo → case-fold (CR-01) + port-strip.
test('isUpstreamRemote case-folds a mixed-case upstream URL → true (CR-01)', () => {
  assert.ok(isUpstreamRemote('https://github.com/Open-GSD/GSD-Core.git'));
  assert.ok(isUpstreamRemote('git@github.com:Open-GSD/GSD-Core.git'));
});

test('isUpstreamRemote handles a port-qualified upstream host → true', () => {
  assert.ok(isUpstreamRemote('https://github.com:443/open-gsd/gsd-core'));
  assert.ok(isUpstreamRemote('https://github.com:443/Open-GSD/GSD-Core.git'));
});

test('isUpstreamRemote: a fork / wrong-owner remote stays false (no false-deny)', () => {
  assert.ok(!isUpstreamRemote('git@github.com:dave/gsd-core-fork.git'));
  assert.ok(!isUpstreamRemote('https://github.com/dave/gsd-core.git'));
  assert.ok(!isUpstreamRemote(''));
  assert.ok(!isUpstreamRemote('not-a-url'));
});

test('isContributionBranch matches fix|docs|feat/, not main', () => {
  assert.ok(isContributionBranch('fix/12-x'));
  assert.ok(isContributionBranch('docs/13-y'));
  assert.ok(isContributionBranch('feat/14-z'));
  assert.ok(!isContributionBranch('main'));
  assert.ok(!isContributionBranch('master'));
});
