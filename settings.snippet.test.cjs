'use strict';

/**
 * settings.snippet.test.cjs — node:test verifying the populated hooks snippet (Plan 03-07).
 *
 * The snippet is the KEYSTONE: until it is populated, none of the Wave-1..3 hooks actually
 * fire. install.sh's existing (Phase-1, proven) APPEND/UNION jq merge consumes this file and
 * wires it into gsd-core's PROJECT-scoped .claude/settings.json. This test asserts:
 *
 *   1. the snippet is valid JSON in the harness `{hooks:{<event>:[{matcher,hooks:[...]}]}}` shape
 *   2. EVERY wired hook (the Phase-3 eight Bash gates + the Phase-4 lint-ci-marker + scan-gate,
 *      plus binlib-edit + protocol-reminder) appears exactly once, each command referencing
 *      its hooks/<name>.cjs by an ABSOLUTE path
 *   3. matchers are correct: Bash gates under "Bash", binlib-edit under "Write|Edit",
 *      protocol-reminder under "UserPromptSubmit", and the two-matcher gate worktree-fresh-base
 *      (ENF-25) under BOTH "Bash" and "EnterWorktree" (one registration each)
 *   4. NO command references ~/.claude (project-scoped blast radius — PROJECT settings-scope)
 *   5. the doctor CLI is NOT wired (it is a CLI self-test, not a hook)
 *
 * It also proves the wiring end-to-end (T-03-07-CLOBBER / EP-6): running the SAME jq merge
 * install.sh uses against a temp settings.json seeded with a USER_EXISTING hook leaves that
 * hook intact AND adds all ten Phase-3 hooks.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SNIPPET_PATH = path.join(__dirname, 'settings.snippet.json');

const BASH_GATES = [
  'gh-issue-create',
  'gh-pr-create',
  'gh-edit',
  'githooks-seal',
  'issue-dedupe',
  'freshness',
  'containment',
  'policy-invariants',
  'lint-ci-marker',
  // `git-commit-convention` was wired in settings.snippet.json but MISSING from this array,
  // so the "appears exactly once" invariant below silently under-covered it. Added with ENF-20.
  'git-commit-convention',
  'scan-gate',
  'protocol-artifact',
  'review-artifact',
  // `runtime-drift` (ENF-21) was wired but MISSING here too, the same under-coverage the
  // git-commit-convention note above describes. Added with ENF-23/ENF-24 (36-05).
  'runtime-drift',
  // ENF-23 / ENF-24 (Phase 36): the gsd-test dispatch gates.
  'gsd-test-clean-tree',
  'gsd-test-viability',
];
const WRITE_EDIT_GATES = ['binlib-edit'];
const PROMPT_HOOKS = ['protocol-reminder'];
/**
 * OBS-01: the observation-only recorder. It is the ONE hook wired more than once — the harness
 * splits completed tool calls across TWO events (`PostToolUse` fires only on SUCCESS,
 * `PostToolUseFailure` fires on failure carrying `error` instead of `tool_response`), so a
 * recorder registered on only one of them silently drops half the population. Hence it is kept
 * OUT of ALL_HOOKS (whose invariant is "exactly once") and asserted separately below.
 */
const RECORDER_HOOKS = ['tool-recorder'];
const RECORDER_EVENTS = ['PostToolUse', 'PostToolUseFailure'];
/**
 * ENF-25 (Phase 37, WTREE-01): the worktree fresh-base gate must reach BOTH a `git worktree add`
 * typed through the Bash tool AND the harness EnterWorktree tool, so it is registered TWICE under
 * PreToolUse: once in the existing `Bash` group and once in its own `EnterWorktree` group (same
 * script). Like tool-recorder it is kept OUT of ALL_HOOKS (whose invariant is "exactly once") and
 * asserted separately below; it is in ALL_WIRED_SCRIPTS so the install-merge proof covers it.
 */
const TWO_MATCHER_GATES = ['worktree-fresh-base'];
const TWO_MATCHER_MATCHERS = ['Bash', 'EnterWorktree'];
const ALL_HOOKS = [...BASH_GATES, ...WRITE_EDIT_GATES, ...PROMPT_HOOKS];
/** Every wired script, however many times it appears — the presence set the merge proof uses. */
const ALL_WIRED_SCRIPTS = [...ALL_HOOKS, ...RECORDER_HOOKS, ...TWO_MATCHER_GATES];

function loadSnippet() {
  const raw = fs.readFileSync(SNIPPET_PATH, 'utf8');
  return JSON.parse(raw); // throws on invalid JSON
}

/** Collect every command string across every event/entry. */
function allCommands(snippet) {
  const cmds = [];
  const hooks = snippet.hooks || {};
  for (const evt of Object.keys(hooks)) {
    for (const entry of hooks[evt]) {
      for (const h of entry.hooks || []) {
        cmds.push({ evt, matcher: entry.matcher, command: h.command, type: h.type, timeout: h.timeout });
      }
    }
  }
  return cmds;
}

test('snippet is valid JSON with a top-level hooks object', () => {
  const snip = loadSnippet();
  assert.equal(typeof snip, 'object');
  assert.ok(snip.hooks && typeof snip.hooks === 'object', 'has .hooks object');
  assert.ok(Array.isArray(snip.hooks.PreToolUse), 'PreToolUse is an array');
  assert.ok(Array.isArray(snip.hooks.UserPromptSubmit), 'UserPromptSubmit is an array');
  for (const evt of RECORDER_EVENTS) {
    assert.ok(Array.isArray(snip.hooks[evt]), `${evt} is an array`);
  }
});

test('every entry has the harness {matcher, hooks:[{type:command, command, timeout}]} shape', () => {
  const snip = loadSnippet();
  for (const evt of Object.keys(snip.hooks)) {
    for (const entry of snip.hooks[evt]) {
      assert.ok(typeof entry.matcher === 'string' && entry.matcher.length > 0, `${evt} entry has a matcher`);
      assert.ok(Array.isArray(entry.hooks) && entry.hooks.length > 0, `${evt} entry has hooks[]`);
      for (const h of entry.hooks) {
        assert.equal(h.type, 'command', 'hook type is command');
        assert.ok(typeof h.command === 'string' && h.command.length > 0, 'hook has a command');
        assert.equal(typeof h.timeout, 'number', 'hook has a numeric timeout');
      }
    }
  }
});

test('each command runs node against an ABSOLUTE hooks/<name>.cjs path', () => {
  const snip = loadSnippet();
  for (const { command } of allCommands(snip)) {
    // shape: "<abs node>" "<abs ...>/hooks/<name>.cjs"
    const m = command.match(/"([^"]+\/hooks\/[a-z0-9-]+\.cjs)"/i);
    assert.ok(m, `command references a quoted hooks/*.cjs path: ${command}`);
    assert.ok(path.isAbsolute(m[1]), `hook path is absolute: ${m[1]}`);
    assert.ok(/node(\.exe)?"?\s/i.test(command) || /\/node"/.test(command),
      `command invokes node: ${command}`);
  }
});

test('every Phase-3 hook appears EXACTLY once', () => {
  const snip = loadSnippet();
  const cmds = allCommands(snip);
  for (const name of ALL_HOOKS) {
    const hits = cmds.filter((c) => c.command.includes(`/hooks/${name}.cjs"`));
    assert.equal(hits.length, 1, `${name} should appear exactly once (found ${hits.length})`);
  }
});

test('tool-recorder is wired on BOTH post-tool events, matcher "*" (OBS-01)', () => {
  const snip = loadSnippet();
  const cmds = allCommands(snip);
  for (const name of RECORDER_HOOKS) {
    const hits = cmds.filter((c) => c.command.includes(`/hooks/${name}.cjs"`));
    assert.equal(hits.length, RECORDER_EVENTS.length,
      `${name} must be wired on all ${RECORDER_EVENTS.length} post-tool events (found ${hits.length})`);
    assert.deepEqual(
      hits.map((h) => h.evt).sort(),
      [...RECORDER_EVENTS].sort(),
      // A recorder on PostToolUse alone reports only successes and looks like it is working.
      `${name} must cover BOTH success and failure streams`
    );
    for (const h of hits) {
      assert.equal(h.matcher, '*', `${name} matcher must be "*" — it observes every tool`);
      assert.ok(h.timeout <= 10,
        `${name} must carry a SHORT timeout (got ${h.timeout}) — observation must never stall a turn`);
    }
  }
});

test('the doctor CLI is NOT wired as a hook', () => {
  const snip = loadSnippet();
  const cmds = allCommands(snip);
  const doctor = cmds.filter((c) => c.command.includes('/hooks/doctor.cjs"'));
  assert.equal(doctor.length, 0, 'doctor.cjs is a CLI, must not be a hook entry');
});

test('Bash gates are under a Bash matcher', () => {
  const snip = loadSnippet();
  const cmds = allCommands(snip);
  for (const name of BASH_GATES) {
    const hit = cmds.find((c) => c.command.includes(`/hooks/${name}.cjs"`));
    assert.ok(hit, `${name} is wired`);
    assert.equal(hit.evt, 'PreToolUse', `${name} is a PreToolUse hook`);
    assert.equal(hit.matcher, 'Bash', `${name} matcher is Bash (got ${hit.matcher})`);
  }
});

/**
 * GTEST-07 / T-36-21: a PreToolUse hook killed by its harness timeout delivers NO deny, so each
 * gsd-test gate's settings timeout must exceed the worst case of its own subprocess bounds.
 *   - viability: one bounded `docker info` probe (DOCKER_PROBE_TIMEOUT_MS) per gate call;
 *   - clean-tree: up to three bounded git calls for one tree on the slow path (status, plus a
 *     rev-parse of HEAD and of a literal --head), each GIT_TIMEOUT_MS. A command that dispatches
 *     into several distinct trees can exceed this; that residual is not asserted here.
 * The bounds are read from the hook modules themselves, so raising a bound without raising the
 * settings timeout goes red here.
 */
test('GTEST-07: gsd-test gate timeouts exceed their own subprocess bounds', () => {
  const { DOCKER_PROBE_TIMEOUT_MS } = require('./hooks/gsd-test-viability.cjs');
  const { GIT_TIMEOUT_MS } = require('./hooks/gsd-test-clean-tree.cjs');
  assert.equal(typeof DOCKER_PROBE_TIMEOUT_MS, 'number', 'viability exports DOCKER_PROBE_TIMEOUT_MS');
  assert.equal(typeof GIT_TIMEOUT_MS, 'number', 'clean-tree exports GIT_TIMEOUT_MS');
  const cmds = allCommands(loadSnippet());
  const timeoutOf = (name) => {
    const hit = cmds.find((c) => c.command.includes(`/hooks/${name}.cjs"`));
    assert.ok(hit, `${name} is wired`);
    return hit.timeout * 1000;
  };
  const viability = timeoutOf('gsd-test-viability');
  assert.ok(viability > DOCKER_PROBE_TIMEOUT_MS,
    `gsd-test-viability timeout ${viability} ms must exceed DOCKER_PROBE_TIMEOUT_MS ${DOCKER_PROBE_TIMEOUT_MS}`);
  const cleanTree = timeoutOf('gsd-test-clean-tree');
  assert.ok(cleanTree > 3 * GIT_TIMEOUT_MS,
    `gsd-test-clean-tree timeout ${cleanTree} ms must exceed 3 x GIT_TIMEOUT_MS (${3 * GIT_TIMEOUT_MS})`);
});

/**
 * 36-REVIEW m-06: the per-call bounds alone do not bound a gate CALL (N dispatches with distinct
 * literal `--head` values, or N distinct DOCKER_HOST selections, multiply them). Each gate
 * therefore shares ONE deadline (GATE_BUDGET_MS) across all of its subprocesses, and the settings
 * timeout must exceed that budget with headroom for node start-up and the verdict write.
 */
test('m-06: each gsd-test gate settings timeout exceeds its shared subprocess budget by at least 3 s', () => {
  const via = require('./hooks/gsd-test-viability.cjs');
  const ct = require('./hooks/gsd-test-clean-tree.cjs');
  for (const [name, mod] of [['gsd-test-viability', via], ['gsd-test-clean-tree', ct]]) {
    assert.equal(typeof mod.GATE_BUDGET_MS, 'number', `${name} exports GATE_BUDGET_MS`);
    const hit = allCommands(loadSnippet()).find((c) => c.command.includes(`/hooks/${name}.cjs"`));
    assert.ok(hit.timeout * 1000 >= mod.GATE_BUDGET_MS + 3000,
      `${name} timeout ${hit.timeout * 1000} ms must exceed GATE_BUDGET_MS ${mod.GATE_BUDGET_MS} by >= 3000 ms`);
  }
});

test('ENF-25: worktree-fresh-base is wired exactly twice, PreToolUse on Bash and EnterWorktree, equal timeouts', () => {
  const cmds = allCommands(loadSnippet());
  for (const name of TWO_MATCHER_GATES) {
    const hits = cmds.filter((c) => c.command.includes(`/hooks/${name}.cjs"`));
    // Count first, so an unwired gate is an assertion failure (clean RED), never a TypeError.
    assert.equal(hits.length, TWO_MATCHER_MATCHERS.length,
      `${name} must be wired exactly ${TWO_MATCHER_MATCHERS.length} times (found ${hits.length})`);
    for (const h of hits) {
      assert.equal(h.evt, 'PreToolUse', `${name} is a PreToolUse hook (got ${h.evt})`);
    }
    // A registration lost on either matcher silently disarms half the gate (T-37-27).
    assert.deepEqual(hits.map((h) => h.matcher).sort(), [...TWO_MATCHER_MATCHERS].sort(),
      `${name} matchers must be exactly ${JSON.stringify(TWO_MATCHER_MATCHERS)}`);
    assert.equal(hits[0].timeout, hits[1].timeout,
      `${name} registrations must carry equal timeouts (got ${hits[0].timeout} and ${hits[1].timeout})`);
  }
});

/**
 * ENF-25 / T-37-26: the harness kills a hook at its settings timeout and then applies NO decision,
 * so each of the two registrations' timeout must exceed the gate's shared subprocess deadline
 * (GATE_BUDGET_MS) by at least 3 s (the 36-REVIEW m-06 headroom for node start-up and the verdict
 * write). The deadline must in turn cover the worst case it is meant to bound: one fetch belt plus
 * MAX_GIT_CALLS_PER_ROOT bounded non-fetch git calls. Every bound is read from the hook module, so
 * raising one without the other goes red here. Both comparisons are inclusive (45 s = 42 s + 3 s;
 * 20 s + 7 x 3 s = 41 s <= 42 s).
 */
test('ENF-25: worktree-fresh-base timeout covers its shared budget', () => {
  const wt = require('./hooks/worktree-fresh-base.cjs');
  for (const k of ['GATE_BUDGET_MS', 'FETCH_BELT_MS', 'MAX_GIT_CALLS_PER_ROOT', 'GIT_TIMEOUT_MS']) {
    assert.equal(typeof wt[k], 'number', `worktree-fresh-base exports ${k}`);
  }
  assert.ok(wt.GATE_BUDGET_MS >= wt.FETCH_BELT_MS + wt.MAX_GIT_CALLS_PER_ROOT * wt.GIT_TIMEOUT_MS,
    `GATE_BUDGET_MS ${wt.GATE_BUDGET_MS} must cover FETCH_BELT_MS ${wt.FETCH_BELT_MS} + ` +
    `MAX_GIT_CALLS_PER_ROOT ${wt.MAX_GIT_CALLS_PER_ROOT} x GIT_TIMEOUT_MS ${wt.GIT_TIMEOUT_MS}`);
  const hits = allCommands(loadSnippet()).filter((c) => c.command.includes('/hooks/worktree-fresh-base.cjs"'));
  assert.equal(hits.length, TWO_MATCHER_MATCHERS.length,
    `worktree-fresh-base must be wired on ${TWO_MATCHER_MATCHERS.length} matchers (found ${hits.length})`);
  for (const h of hits) {
    assert.ok(h.timeout * 1000 >= wt.GATE_BUDGET_MS + 3000,
      `worktree-fresh-base (${h.matcher}) timeout ${h.timeout * 1000} ms must exceed ` +
      `GATE_BUDGET_MS ${wt.GATE_BUDGET_MS} by >= 3000 ms`);
  }
});

test('binlib-edit is under a Write|Edit matcher', () => {
  const snip = loadSnippet();
  const hit = allCommands(snip).find((c) => c.command.includes('/hooks/binlib-edit.cjs"'));
  assert.equal(hit.evt, 'PreToolUse');
  assert.equal(hit.matcher, 'Write|Edit');
});

test('protocol-reminder is under UserPromptSubmit', () => {
  const snip = loadSnippet();
  const hit = allCommands(snip).find((c) => c.command.includes('/hooks/protocol-reminder.cjs"'));
  assert.equal(hit.evt, 'UserPromptSubmit');
});

test('NO command references ~/.claude (project-scoped blast radius)', () => {
  const snip = loadSnippet();
  for (const { command } of allCommands(snip)) {
    assert.ok(!command.includes('/.claude/hooks/'),
      `command must not point into ~/.claude: ${command}`);
  }
});

// ---- Wiring proof: the SAME jq merge install.sh uses preserves a pre-existing hook (EP-6) ----

test('install.sh merge wires every hook WITHOUT clobbering a pre-existing hook', { skip: hasNoJq() }, () => {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'snip-merge-'));
  const settings = path.join(tmpdir, 'settings.json');
  // Seed with a USER_EXISTING PreToolUse(Bash) hook that must survive the merge.
  const seed = {
    hooks: {
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'bash "/tmp/USER_EXISTING.sh"', timeout: 5 }] },
      ],
    },
  };
  fs.writeFileSync(settings, JSON.stringify(seed, null, 2));

  // Mirror install.sh's exact jq filter (canon dedupe, per-event append/union, EP-6).
  const filter = `
    def canon: walk(if type == "object" then to_entries | sort | from_entries else . end);
    ($snip[0].hooks // {}) as $sh
    | reduce ($sh | keys[]) as $evt (
        .;
        .hooks = (.hooks // {})
        | .hooks[$evt] = (((.hooks[$evt] // []) + $sh[$evt]) | unique_by(canon | tojson))
      )
  `;
  const merged = execFileSync(
    'jq',
    ['--slurpfile', 'snip', SNIPPET_PATH, filter, settings],
    { encoding: 'utf8' }
  );
  const out = JSON.parse(merged);

  // Flatten every command string from the merged structure (literal quotes intact).
  const mergedCmds = allCommands(out);

  // The user's pre-existing hook survives.
  const surviving = mergedCmds.some((c) => c.command.includes('/tmp/USER_EXISTING.sh'));
  assert.ok(surviving, 'pre-existing USER_EXISTING hook must survive the merge (EP-6)');

  // Every wired hook (Phase-3 + Phase-4 lint-ci-marker/scan-gate + OBS-01) is present after the merge.
  for (const name of ALL_WIRED_SCRIPTS) {
    assert.ok(
      mergedCmds.some((c) => c.command.includes(`/hooks/${name}.cjs"`)),
      `${name} present after merge`
    );
  }

  fs.rmSync(tmpdir, { recursive: true, force: true });
});

function hasNoJq() {
  try {
    execFileSync('jq', ['--version'], { stdio: 'ignore' });
    return false;
  } catch (_) {
    return true; // skip the merge proof where jq is unavailable
  }
}
