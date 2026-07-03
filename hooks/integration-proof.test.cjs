'use strict';

/**
 * hooks/integration-proof.test.cjs — INTEGRATION proofs (TEST-01 / TEST-02).
 *
 * The hermetic unit suite (hooks/*.test.cjs, 315 cases) proves each gate's POLICY LOGIC
 * through an injectable seam. It does NOT prove the stdin->stdout->exit WIRING of the real
 * entrypoint (`node hooks/<name>.cjs`). A hook could pass every unit test and still mis-wire
 * its `main()` — emit nothing, crash, or drop the decision.
 *
 * This file closes that gap: it SPAWNS the real entrypoint via hooks/lib/proof-harness.cjs,
 * feeds crafted stdin, and CAPTURES the emitted permissionDecision — proving deny-on-bad and
 * allow-on-clean end-to-end for every wired gate, plus the two advisory hooks.
 *
 * THE LOAD-BEARING INVARIANT (asserted explicitly below): a hook that crashes (non-zero exit)
 * or emits empty/unparseable stdout is an INCONCLUSIVE FAIL — NEVER coerced to 'allow'. A
 * mis-classifier that read a crash as "allow" would manufacture a FALSE proof.
 *
 * Task 1 (this section): the classify invariants — pure, no spawn needed.
 * Task 2 (added later): the per-hook deny+allow proofs — real spawn.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const { classifyDecision, spawnHook } = require('./lib/proof-harness.cjs');
const { makeSandbox, removeScript } = require('./lib/sandbox.cjs');

// ── Task 1: classifyDecision invariants (the security core) ────────────────────

// A well-formed deny envelope (what every PreToolUse gate emits on a deny, exit 0).
const DENY_LINE = JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: 'blocked',
  },
});
// A well-formed allow envelope (exit 0).
const ALLOW_LINE = JSON.stringify({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
});

test('classify: well-formed deny + exit 0 → {decision:"deny", conclusive:true}', () => {
  const r = classifyDecision(DENY_LINE, 0);
  assert.equal(r.decision, 'deny');
  assert.equal(r.conclusive, true);
});

test('classify: well-formed allow + exit 0 → {decision:"allow", conclusive:true}', () => {
  const r = classifyDecision(ALLOW_LINE, 0);
  assert.equal(r.decision, 'allow');
  assert.equal(r.conclusive, true);
});

test('SECURITY: non-zero exit → conclusive:false REGARDLESS of stdout (crash != allow)', () => {
  // Even if a crashing hook happened to print a valid allow line, a non-zero exit is a
  // crash — it is INCONCLUSIVE, never honored as an allow.
  const r = classifyDecision(ALLOW_LINE, 1);
  assert.equal(r.conclusive, false);
  assert.notEqual(r.decision, 'allow');
});

test('SECURITY: non-zero exit with a deny line → conclusive:false (still inconclusive)', () => {
  const r = classifyDecision(DENY_LINE, 1);
  assert.equal(r.conclusive, false);
});

test('SECURITY: empty stdout + exit 0 → {decision:null, conclusive:false} (NEVER allow)', () => {
  const r = classifyDecision('', 0);
  assert.equal(r.decision, null);
  assert.equal(r.conclusive, false);
});

test('SECURITY: unparseable stdout + exit 0 → conclusive:false (NEVER coerced to allow)', () => {
  const r = classifyDecision('this is not json', 0);
  assert.equal(r.decision, null);
  assert.equal(r.conclusive, false);
});

test('SECURITY: valid JSON but no permissionDecision → conclusive:false', () => {
  const r = classifyDecision(JSON.stringify({ hookSpecificOutput: { additionalContext: 'x' } }), 0);
  assert.equal(r.decision, null);
  assert.equal(r.conclusive, false);
});

test('SECURITY: a permissionDecision that is neither deny nor allow → conclusive:false', () => {
  const weird = JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'maybe' },
  });
  const r = classifyDecision(weird, 0);
  assert.equal(r.decision, null);
  assert.equal(r.conclusive, false);
});

test('classify: trailing whitespace / extra newline around the JSON line is tolerated', () => {
  const r = classifyDecision('\n  ' + DENY_LINE + '  \n', 0);
  assert.equal(r.decision, 'deny');
  assert.equal(r.conclusive, true);
});

// ── Task 2: real-entrypoint deny+allow proofs (spawn the live `node hooks/<name>.cjs`) ──

const HOOKS_DIR = __dirname;
const abs = (name) => path.join(HOOKS_DIR, `${name}.cjs`);

// Build a PreToolUse[Bash] stdin payload (the shape every Bash gate parses).
const bash = (command) => JSON.stringify({ tool_name: 'Bash', tool_input: { command } });
// Build a PreToolUse[Write|Edit] stdin payload (binlib-edit reads tool_input.file_path).
const edit = (file_path) => JSON.stringify({ tool_name: 'Edit', tool_input: { file_path } });

// CF-01 (30-01): a COMPLETE valid `fix` PR-template body (WITH `Fixes #12`), so the title-deny
// fixture passes template + base and denies on the missing issue-ref — hermetic. Joined with REAL
// newlines (the NATIVE double-quoted `--body` route strips a backslash, so a `\n` sentinel would
// collapse to `n`). Mirrors CF01_VALID_FIX_BODY in bin/verify-hooks.cjs (the sync target).
const CF01_VALID_FIX_BODY = [
  '## Fix PR', '', '## Linked Issue', 'Fixes #12', '', '## What was broken', 'the thing',
  '', '## What this fix does', 'fixes the thing', '', '## Testing', 'node --test',
  '', '## Checklist', '- [x] tests',
].join('\n');

/**
 * Resolve a directory that carries the gsd-core sentinel layout (scripts/ + gsd-core/bin/lib/)
 * so gates that resolve LIVE scripts find them. Mirrors the doctor's resolve-or-explain stance:
 * if no checkout is reachable, return null and the LIVE-resolving cases SKIP with a note —
 * never a hard failure on a missing EXTERNAL checkout (threat T-05-01-EXTCHECKOUT: accept).
 */
function resolveGsdCoreCwd() {
  const hasSentinel = (dir) => {
    try {
      return (
        fs.statSync(path.join(dir, 'scripts')).isDirectory() &&
        fs.statSync(path.join(dir, 'gsd-core', 'bin', 'lib')).isDirectory()
      );
    } catch (_) {
      return false;
    }
  };
  const candidates = [
    process.env.GSD_CORE_ROOT,
    path.join(os.homedir(), 'repos', 'gsd-core'),
    path.join(os.homedir(), 'gsd-core'),
  ].filter(Boolean);
  for (const c of candidates) {
    if (hasSentinel(c)) return c;
  }
  return null;
}

const GSD_CORE_CWD = resolveGsdCoreCwd();

/**
 * The per-hook proof table. Each entry's BAD/CLEAN fixture is a CAPTURED, probed payload that
 * trips (or stays out of) the gate based on the COMMAND ALONE — so the proof is environment-
 * independent. For gates whose policy DENY depends on live external state (issue-dedupe: live
 * open-issue list; freshness: staged governed src; scan-gate: live scan results), the BAD
 * fixture exercises the gate's HARD-01/HARD-04 FAIL-CLOSED wiring (an unparseable command →
 * deny) — which still proves the real entrypoint emits a captured deny end-to-end. The fixture
 * source is cited per entry. needsLive=true entries SKIP when no gsd-core checkout is reachable.
 */
const DENY_GATES = [
  {
    name: 'gh-issue-create',
    // src: gh-issue-create.test.cjs — bad body fails the LIVE issue-version-gate.
    bad: bash('gh issue create --label bug --title x --body "### GSD Version\\n_No response_"'),
    clean: bash('git status'),
    needsLive: true,
  },
  {
    name: 'gh-pr-create',
    // src: gh-pr-create.test.cjs — empty body fails the LIVE pr-template-policy.
    bad: bash('gh pr create --base next --title x --body ""'),
    clean: bash('gh repo view o/r'),
    needsLive: true,
  },
  {
    name: 'gh-edit',
    // src: gh-edit.test.cjs — a non-template PR body edit is denied with the REST hint.
    bad: bash('gh pr edit 9 --body "just prose, no template"'),
    clean: bash('gh issue edit 7 --add-label triage'),
    needsLive: true,
  },
  {
    name: 'githooks-seal',
    // src: githooks-seal.test.cjs — real --no-verify flag → deny (ENF-12), command-only.
    bad: bash('git commit --no-verify -m x'),
    clean: bash('git status'),
    needsLive: true,
  },
  {
    name: 'containment',
    // src: containment.test.cjs — git add of a .planning artifact → deny (ENF-06), command-only.
    // The ALLOW path still resolves the LIVE origin-remote classifier, so needsLive for clean.
    bad: bash('git add .planning/STATE.md'),
    clean: bash('git status'),
    needsLive: true,
  },
  {
    name: 'lint-ci-marker',
    // src: lint-ci-marker.test.cjs — git push with no valid lint-green marker / dirty tree → deny.
    bad: bash('git push origin HEAD'),
    clean: bash('git status'),
    needsLive: true,
  },
  {
    name: 'git-commit-convention',
    // src: git-commit-convention.test.cjs (07-01, ENF-16) — a malformed conventional-commit
    // prefix (`docs ` not followed by (scope)/!/:) → deny. needsLive because the gate resolves
    // the gsd-core root from cwd and ALLOWS outside a checkout, so the deny is only conclusive there.
    bad: bash('git commit -m "docs fix thing"'),
    clean: bash('git status'),
    needsLive: true,
  },
  {
    name: 'policy-invariants',
    // policy-invariants' POLICY-02 content-deny needs a LIVE mechanizable check (lint:ci/…) to fail
    // (uncontrollable here — historically it rode a transient gsd-core ESLint-config failure, which
    // gsd-core has since fixed, so a plain commit now ALLOWS). The BAD fixture instead proves the
    // gate's deterministic FAIL-CLOSED wiring (HARD-04): an unparseable commit → captured deny,
    // independent of gsd-core's lint state. src: policy-invariants.test.cjs.
    bad: bash('git commit -m "wip'),
    clean: bash('git status'),
    needsLive: true,
  },
  {
    name: 'issue-dedupe',
    // issue-dedupe's policy DENY needs a live near-duplicate open issue (uncontrollable here);
    // the BAD fixture instead proves the entrypoint's FAIL-CLOSED wiring (HARD-04): an
    // unparseable issue-create command → captured deny. src: issue-dedupe.test.cjs (unparseable).
    // The ALLOW path resolves the LIVE dedupe scorer, so needsLive for the clean case.
    bad: bash('gh issue create --title "x'),
    clean: bash('git status'),
    needsLive: true,
  },
  {
    name: 'freshness',
    // freshness DENY needs a staged governed src + stale generated (uncontrollable here); the BAD
    // fixture proves the FAIL-CLOSED wiring (HARD-04): an unparseable commit → captured deny.
    // The ALLOW path resolves the LIVE freshness checks, so needsLive for the clean case.
    bad: bash('git commit "unterminated'),
    clean: bash('git status'),
    needsLive: true,
  },
  {
    name: 'scan-gate',
    // scan-gate DENY needs a live scan to fail (uncontrollable here); the BAD fixture proves the
    // FAIL-CLOSED wiring (HARD-04): an unparseable push → captured deny. src: scan-gate.test.cjs.
    bad: bash('git push "unterminated'),
    clean: bash('git status'),
    needsLive: true,
  },
  // ── WR-01 (07-05): bypass-form deny fixtures (CR-01..CR-04) ──────────────────────────────
  // Each spawns an EXISTING wired gate (via `hook`) with a BYPASS-form bad fixture that, once
  // the shared classifier was hardened, now classifies to the gated action and DENIES under a
  // live checkout. The distinct `name` keeps test titles unique. Mirrors bin/verify-hooks.cjs
  // PROOF_TABLE (this file is the sync SOURCE). `hook` = the real gate file to spawn.
  {
    name: 'git-commit-convention-bypass-globalopt', hook: 'git-commit-convention',
    // CR-01: `git -C <path> commit -m "docs fix thing"` now classifies as commit → ENF-16 denies.
    bad: bash('git -C /tmp commit -m "docs fix thing"'),
    clean: bash('git status'),
    needsLive: true,
  },
  {
    name: 'git-commit-convention-bypass-envprefix', hook: 'git-commit-convention',
    // CR-02: `GIT_DIR=/x git commit -m "docs fix thing"` now classifies as commit → ENF-16 denies.
    bad: bash('GIT_DIR=/x git commit -m "docs fix thing"'),
    clean: bash('git status'),
    needsLive: true,
  },
  {
    name: 'git-commit-convention-bypass-abspath', hook: 'git-commit-convention',
    // CR-03: `/usr/bin/git commit -m "docs fix thing"` now classifies as commit → ENF-16 denies.
    bad: bash('/usr/bin/git commit -m "docs fix thing"'),
    clean: bash('git status'),
    needsLive: true,
  },
  {
    name: 'gh-pr-create-bypass-rawfield', hook: 'gh-pr-create',
    // CR-04: `gh api …/pulls --raw-field …` now classifies as pr-create → ENF-18 CI gate denies.
    bad: bash('gh api repos/o/r/pulls --raw-field body=x --raw-field base=main'),
    clean: bash('gh repo view o/r'),
    needsLive: true,
  },
  {
    name: 'gh-pr-create-bypass-databinary', hook: 'gh-pr-create',
    // CR-04: `curl …/pulls --data-binary {}` now classifies as pr-create → ENF-18 CI gate denies.
    bad: bash('curl https://api.github.com/repos/o/r/pulls --data-binary {}'),
    clean: bash('gh repo view o/r'),
    needsLive: true,
  },
  {
    name: 'gh-pr-create-title', hook: 'gh-pr-create',
    // CF-01 (30-01): a valid fix template + base=next with a non-conforming title (`fix(core): x`,
    // missing the `(#<issue>)` ref) → the LIVE conventional-title matcher (evaluatePrTitle) DENIES
    // before the PR opens. Hermetic (the title check is pure, runs after template+base, before CI).
    bad: bash(`gh pr create --base next --title 'fix(core): x' --body "${CF01_VALID_FIX_BODY}"`),
    clean: bash('gh repo view o/r'),
    needsLive: true,
  },
];

for (const g of DENY_GATES) {
  const cwd = g.needsLive ? GSD_CORE_CWD : process.cwd();
  const skip =
    g.needsLive && !GSD_CORE_CWD
      ? 'no gsd-core checkout reachable (set GSD_CORE_ROOT) — LIVE-resolving case skipped (env limit)'
      : false;

  test(`PROOF deny-on-bad: ${g.name} real entrypoint emits a captured permissionDecision:deny`, { skip }, () => {
    const r = spawnHook(abs(g.hook || g.name), { stdin: g.bad, cwd });
    assert.equal(r.conclusive, true, `inconclusive (crash/empty?) for ${g.name}: ${r.reason}\nstderr: ${r.rawStderr}`);
    assert.equal(r.decision, 'deny', `${g.name} bad fixture should DENY but got ${r.decision}\nstdout: ${r.rawStdout}`);
  });

  test(`PROOF allow-on-clean: ${g.name} real entrypoint emits a captured permissionDecision:allow`, { skip }, () => {
    const r = spawnHook(abs(g.hook || g.name), { stdin: g.clean, cwd });
    assert.equal(r.conclusive, true, `inconclusive for ${g.name} clean: ${r.reason}\nstderr: ${r.rawStderr}`);
    assert.equal(r.decision, 'allow', `${g.name} clean fixture should ALLOW but got ${r.decision}\nstdout: ${r.rawStdout}`);
  });
}

// binlib-edit (Write|Edit gate): command-only, no live-script resolution needed.
test('PROOF deny-on-bad: binlib-edit real entrypoint denies a bin/lib/*.cjs edit (ENF-03)', () => {
  // src: binlib-edit.test.cjs — a generated bin/lib/*.cjs path → deny.
  const r = spawnHook(abs('binlib-edit'), { stdin: edit('/g/gsd-core/bin/lib/decisions.cjs') });
  assert.equal(r.conclusive, true, `inconclusive: ${r.reason}\nstderr: ${r.rawStderr}`);
  assert.equal(r.decision, 'deny', `bin/lib edit should DENY\nstdout: ${r.rawStdout}`);
});

test('PROOF allow-on-clean: binlib-edit real entrypoint allows a src/*.cts edit', () => {
  // src: binlib-edit.test.cjs — the correct source file → allow.
  const r = spawnHook(abs('binlib-edit'), { stdin: edit('/g/gsd-core/sdk/src/query/decisions.cts') });
  assert.equal(r.conclusive, true, `inconclusive: ${r.reason}\nstderr: ${r.rawStderr}`);
  assert.equal(r.decision, 'allow', `src/*.cts edit should ALLOW\nstdout: ${r.rawStdout}`);
});

// ── Advisory hooks: prove inject/surface-vs-none AND that they NEVER emit a permissionDecision ──

test('PROOF advisory: protocol-reminder INJECTS additionalContext on a contribution prompt', () => {
  // src: protocol-reminder.test.cjs — a contribution-shaped prompt → P0..P6 reminder.
  const r = spawnHook(abs('protocol-reminder'), {
    stdin: JSON.stringify({ prompt: 'please file an issue on gsd-core for this parser bug', hook_event_name: 'UserPromptSubmit' }),
  });
  assert.equal(r.status, 0, 'advisory hook exits 0');
  assert.match(r.rawStdout, /additionalContext/, 'contribution prompt injects additionalContext');
  assert.match(r.rawStdout, /P0/, 'the injected reminder enumerates the protocol steps');
  // It is advisory — it must NEVER carry an enforcement decision.
  assert.doesNotMatch(r.rawStdout, /permissionDecision/, 'advisory reminder must NOT emit a permissionDecision');
});

test('PROOF advisory: protocol-reminder emits NOTHING on a clean prompt (no injection, no deny)', () => {
  const r = spawnHook(abs('protocol-reminder'), {
    stdin: JSON.stringify({ prompt: 'refactor this function to be cleaner', hook_event_name: 'UserPromptSubmit' }),
  });
  assert.equal(r.status, 0, 'advisory hook exits 0');
  assert.equal(r.rawStdout.trim(), '', 'a clean prompt injects nothing (empty stdout)');
  assert.doesNotMatch(r.rawStdout, /permissionDecision/, 'never a permissionDecision');
});

test('PROOF advisory: preflight-shipped-paths surfaces vs reports clean, NEVER a permissionDecision', { skip: GSD_CORE_CWD ? false : 'no gsd-core checkout reachable (env limit)' }, () => {
  // preflight reads the REAL working-tree diff at cwd (model-driven companion; no stdin payload).
  const r = spawnHook(abs('preflight-shipped-paths'), { cwd: GSD_CORE_CWD });
  assert.equal(r.status, 0, 'advisory companion exits 0');
  // It either surfaces shipped paths, reports clean, or fails LOUD — but in ALL cases it is a
  // human-readable surface, NEVER an enforcement decision.
  assert.doesNotMatch(r.rawStdout, /permissionDecision/, 'preflight must NEVER emit a permissionDecision (stdout)');
  assert.doesNotMatch(r.rawStderr, /permissionDecision/, 'preflight must NEVER emit a permissionDecision (stderr)');
  // It produced SOME advisory surface (shipped-path warning, clean note, or a loud error).
  assert.ok((r.rawStdout + r.rawStderr).trim().length > 0, 'preflight surfaces an advisory line');
});

// ── The crash-is-not-allow invariant, proven against a REAL spawn (not just classify) ──

test('PROOF security: a hook that CRASHES (non-zero exit) is INCONCLUSIVE, never allow', () => {
  // Write a throwaway "hook" that crashes, spawn it through the real harness, and assert the
  // capture is inconclusive — proving the crash!=allow invariant survives an actual process exit.
  const tmp = path.join(os.tmpdir(), `gsd-proof-crash-${process.pid}.cjs`);
  fs.writeFileSync(tmp, 'process.stderr.write("boom\\n"); process.exit(2);\n');
  try {
    const r = spawnHook(tmp, { stdin: bash('git status') });
    assert.equal(r.status, 2, 'the crashing hook exited non-zero');
    assert.equal(r.conclusive, false, 'a crash is INCONCLUSIVE');
    assert.notEqual(r.decision, 'allow', 'a crash is NEVER coerced to allow');
  } finally {
    fs.rmSync(tmp, { force: true });
  }
});

test('PROOF security: a hook that emits EMPTY stdout (exit 0) is INCONCLUSIVE, never allow', () => {
  const tmp = path.join(os.tmpdir(), `gsd-proof-silent-${process.pid}.cjs`);
  fs.writeFileSync(tmp, 'process.exit(0);\n'); // exits clean but says NOTHING
  try {
    const r = spawnHook(tmp, { stdin: bash('git status') });
    assert.equal(r.status, 0, 'the silent hook exited clean');
    assert.equal(r.conclusive, false, 'empty stdout is INCONCLUSIVE');
    assert.notEqual(r.decision, 'allow', 'silence is NEVER coerced to allow');
  } finally {
    fs.rmSync(tmp, { force: true });
  }
});

// ── RES-03 (27-04): the consolidated both-directions + ~/.claude false-root regression ──────────
//
// This ONE discoverable block proves the whole Phase 27 guarantee end-to-end, on the real gate
// entrypoints, asserting the emitted permissionDecision VALUE (never a stdout substring / source
// grep). It covers the three D-09 fixture classes:
//
//   (a) a NON-governed in-tree command in a checkout whose SPECIFIC live script was removed → ALLOW
//       (the 27-01/27-02 action-first reorder short-circuits BEFORE requireLiveScript) — mirrored
//       for both gh-issue-create (issue-version-gate.cjs) and issue-dedupe (issue-dedupe.cjs).
//   (b) a GOVERNED in-tree action (gh issue create) in that SAME script-removed checkout → DENY
//       (HARD-02 — fail-closed is NARROWED to the governed action, never weakened; the sandbox
//       still hasSentinel-matches via its three remaining identity scripts, so the root resolves
//       and the missing specific script fails closed).
//   (c) an effective cwd under a ~/.claude-shape INSTALL root (scripts/ + gsd-core/bin/lib/ but NO
//       identity script) + a non-governed command → ALLOW (RES-02 hasSentinel now REJECTS the
//       install-root shape, so it no longer false-resolves as a checkout — the exact permanent
//       trigger observed live 2026-07-02 when `ls -R`/`grep` under ~/.claude/skills/... was denied
//       by issue-dedupe's requireLiveScript).
//
// Cases (a)/(b) copy the four LIVE identity scripts from the real checkout (makeSandbox), so they
// SKIP-with-note when none is reachable (env limit) — never a fabricated layout. Case (c) builds a
// synthetic install-root shape (no real scripts needed) and never skips.

const RES03_SKIP = GSD_CORE_CWD
  ? false
  : 'no gsd-core checkout reachable (set GSD_CORE_ROOT) — RES-03 sandbox regression skipped (env limit)';

test('RES-03(a): non-governed command + a checkout whose LIVE script was removed → ALLOW (gh-issue-create, issue-version-gate.cjs removed)', { skip: RES03_SKIP }, () => {
  const sb = makeSandbox({ sourceRoot: GSD_CORE_CWD });
  try {
    // Remove gh-issue-create's specific LIVE script. The sandbox still hasSentinel-matches via its
    // three remaining identity scripts, so it resolves as a real checkout.
    removeScript(sb.root, 'scripts/issue-version-gate.cjs');
    const r = spawnHook(abs('gh-issue-create'), { stdin: bash('git status'), cwd: sb.root });
    assert.equal(r.conclusive, true, `inconclusive (crash/empty?): ${r.reason}\nstderr: ${r.rawStderr}`);
    assert.equal(
      r.decision,
      'allow',
      `a NON-governed command must ALLOW despite the missing LIVE script — the action-first reorder short-circuits before requireLiveScript\nstdout: ${r.rawStdout}`
    );
  } finally {
    sb.dispose();
  }
});

test('RES-03(a mirror): non-governed command + a checkout whose LIVE script was removed → ALLOW (issue-dedupe, issue-dedupe.cjs removed)', { skip: RES03_SKIP }, () => {
  const sb = makeSandbox({ sourceRoot: GSD_CORE_CWD });
  try {
    // Remove issue-dedupe's specific LIVE script; the sandbox still resolves via the other three.
    removeScript(sb.root, 'scripts/issue-dedupe.cjs');
    const r = spawnHook(abs('issue-dedupe'), { stdin: bash('ls -R'), cwd: sb.root });
    assert.equal(r.conclusive, true, `inconclusive (crash/empty?): ${r.reason}\nstderr: ${r.rawStderr}`);
    assert.equal(
      r.decision,
      'allow',
      `a NON-governed command must ALLOW despite the missing LIVE script — the action-first reorder short-circuits before requireLiveScript\nstdout: ${r.rawStdout}`
    );
  } finally {
    sb.dispose();
  }
});

test('RES-03(b): GOVERNED gh issue create + the SAME script-removed checkout → DENY (HARD-02, fail-closed narrowed-not-weakened)', { skip: RES03_SKIP }, () => {
  const sb = makeSandbox({ sourceRoot: GSD_CORE_CWD });
  try {
    // Same removal as (a) — but now the command IS the governed action. The gate resolves the
    // sandbox root (still hasSentinel via the 3 remaining identity scripts), reaches
    // requireLiveScript for the missing issue-version-gate.cjs, and MUST fail closed.
    removeScript(sb.root, 'scripts/issue-version-gate.cjs');
    // A body that would otherwise PASS the version gate — proving the deny is CAUSED by the missing
    // LIVE script (fail-closed), not by a policy rejection.
    const cmd = 'gh issue create --label bug --title x --body "### GSD Version\\n1.18.0"';
    const r = spawnHook(abs('gh-issue-create'), { stdin: bash(cmd), cwd: sb.root });
    assert.equal(r.conclusive, true, `inconclusive (crash/empty?): ${r.reason}\nstderr: ${r.rawStderr}`);
    assert.equal(
      r.decision,
      'deny',
      `a GOVERNED action with a missing LIVE script must STILL fail closed (HARD-02) — v2.6 narrows fail-closed's scope, it does not weaken it\nstdout: ${r.rawStdout}`
    );
  } finally {
    sb.dispose();
  }
});

test('RES-03(c): a ~/.claude-shape install root (scripts/ + gsd-core/bin/lib/, NO identity script) + non-governed command → ALLOW (the live 2026-07-02 permanent-trigger case)', () => {
  // Reproduce the ~/.claude INSTALL layout: the two DIRECTORY sentinels the PRE-RES-02 hasSentinel
  // matched on, but NO live gsd-core policy script under scripts/ (only a non-policy file). Post
  // RES-02 this shape is REJECTED — it no longer false-resolves as a checkout.
  const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-claude-shape-'));
  try {
    fs.mkdirSync(path.join(fakeRoot, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(fakeRoot, 'gsd-core', 'bin', 'lib'), { recursive: true });
    fs.writeFileSync(
      path.join(fakeRoot, 'scripts', 'some-installed-helper.cjs'),
      '// an installed runtime file — NOT a gsd-core policy script (no identity match)\n'
    );
    // issue-dedupe is the gate that fired in the live incident; assert its real entrypoint now
    // ALLOWs a non-governed command run from under this install-shape root.
    const r = spawnHook(abs('issue-dedupe'), { stdin: bash('ls -R'), cwd: fakeRoot });
    assert.equal(r.conclusive, true, `inconclusive (crash/empty?): ${r.reason}\nstderr: ${r.rawStderr}`);
    assert.equal(
      r.decision,
      'allow',
      `a ~/.claude-shape install root must no longer be a false checkout — a non-governed command there must ALLOW (RES-02 sentinel + RES-01 reorder)\nstdout: ${r.rawStdout}`
    );
  } finally {
    fs.rmSync(fakeRoot, { recursive: true, force: true });
  }
});
