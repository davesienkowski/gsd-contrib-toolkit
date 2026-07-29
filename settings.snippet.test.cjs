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
 *      protocol-reminder under "UserPromptSubmit"
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
  'scan-gate',
  'protocol-artifact',
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
const ALL_HOOKS = [...BASH_GATES, ...WRITE_EDIT_GATES, ...PROMPT_HOOKS];
/** Every wired script, however many times it appears — the presence set the merge proof uses. */
const ALL_WIRED_SCRIPTS = [...ALL_HOOKS, ...RECORDER_HOOKS];

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
    assert.equal(hit.evt, 'PreToolUse', `${name} is a PreToolUse hook`);
    assert.equal(hit.matcher, 'Bash', `${name} matcher is Bash (got ${hit.matcher})`);
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
