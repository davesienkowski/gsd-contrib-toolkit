'use strict';

/**
 * hooks/timeout-evidence-edit.test.cjs - node:test for the timeout-evidence EDIT guard (ENF-27, quick 261120-2a2).
 *
 * Arm A denies a Write, Edit or MultiEdit whose post-image raises, newly sets or newly exports a numeric constant of
 * gsd-core tests/helpers/timeouts.cjs (or a helper constant timeouts.cjs re-exports) whose evidence is missing or no
 * longer arithmetically current. Arm B gives a context-only note (additionalContext, no permissionDecision) for a
 * raised or new file-local timeout constant elsewhere in tests/** whose comment states no evidence. Every other path
 * is a SILENT pass: runEditGuard returns null and the spawned hook exits 0 with EMPTY stdout.
 *
 * Fixtures are temp directories shaped like gsd-core (the resolve.cjs sentinel: scripts/ with one identity script and
 * gsd-core/bin/lib/), built with fs only: the hook never spawns git. Live rows read the gsd-core clone through
 * `git show` (read-only) and skip with a named reason when the clone or the object is absent. The verdict log is
 * redirected (isolateToolLog) and, for spawned hooks, switched off (GSD_CONTRIB_NO_VERDICT_LOG).
 */

const LOG_DIR = require('./lib/test-isolate.cjs').isolateToolLog(); // never the real ~/.gsd-contrib tool log
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const mod = require('./timeout-evidence-edit.cjs');
const { runEditGuard } = mod;

const HOOK = path.join(__dirname, 'timeout-evidence-edit.cjs');
const T = (lines) => lines.join('\n') + '\n';

// ---------------------------------------------------------------- fixtures

/** A synthetic tests/helpers/timeouts.cjs in upstream's shape (origin/next de0eefe18): declarations, then
 * TIMEOUT_EVIDENCE, then module.exports. REAL_REPO_GIT_TIMEOUT_MS is listed before GIT_TIMEOUT_MS (anchoring). */
const TIMEOUTS = T([
  "'use strict';",
  '',
  '/**',
  ' * Synthetic fixture shaped like gsd-core tests/helpers/timeouts.cjs.',
  ' */',
  '',
  "const { DEFAULT_GIT_TIMEOUT_MS, GIT_FIXTURE_TIMEOUT_MS } = require('./git-fixture.cjs');",
  "const { DEFAULT_TIMEOUT_MS: SEAM_FALLBACK_TIMEOUT_MS } = require('./process-seam.cjs');",
  '',
  '/**',
  ' * A short CLI probe.',
  ' *',
  ' * Evidence (TIMEOUT_EVIDENCE.PROBE_TIMEOUT_MS): worst observed 7424ms on darwin (p50 111ms, p99 3411ms of recorded spawns),',
  ' * margin 2.02x; CI seam spawn-stall records, 196 runs.',
  ' */',
  'const PROBE_TIMEOUT_MS = 15000;',
  '',
  '/**',
  ' * A hook fan-out.',
  ' *',
  ' * Evidence (TIMEOUT_EVIDENCE.HOOK_FANOUT_TIMEOUT_MS): worst observed 23514ms on win32 (p50 2326ms, p99 7563ms of recorded spawns),',
  ' * margin 2.55x; CI seam spawn-stall records, 188 runs.',
  ' */',
  'const HOOK_FANOUT_TIMEOUT_MS = 60000;',
  '',
  '/**',
  ' * Git plumbing; re-exports git-fixture.cjs DEFAULT_GIT_TIMEOUT_MS.',
  ' *',
  ' * Evidence (TIMEOUT_EVIDENCE.GIT_TIMEOUT_MS): worst observed 4669ms on win32 (p50 2344ms, p99 4669ms of recorded spawns),',
  ' * margin 3.21x; CI seam spawn-stall records, 188 runs.',
  ' */',
  'const GIT_TIMEOUT_MS = DEFAULT_GIT_TIMEOUT_MS;',
  '',
  '/**',
  ' * Re-exported from git-fixture.cjs under its own name.',
  ' *',
  ' * Evidence (TIMEOUT_EVIDENCE.GIT_FIXTURE_TIMEOUT_MS): worst observed 10114ms on win32 (p50 2558ms, p99 7180ms of recorded spawns),',
  ' * margin 5.93x; CI seam spawn-stall records, 188 runs.',
  ' */',
  '',
  '/**',
  ' * Hooks bundling.',
  ' *',
  ' * Evidence (TIMEOUT_EVIDENCE.BUILD_TIMEOUT_MS): no seam spawn of this class reached 2000ms across 1181 lanes (win32 564, darwin 188,',
  ' * linux 429); margin at least 15x. CI seam spawn-stall records, 188 runs.',
  ' */',
  'const BUILD_TIMEOUT_MS = 30000;',
  '',
  '/**',
  ' * Evidence (TIMEOUT_EVIDENCE.SEAM_DEFAULT_TIMEOUT_MS): mirror - mirror of tests/helpers/process-seam.cjs DEFAULT_TIMEOUT_MS.',
  ' */',
  'const SEAM_DEFAULT_TIMEOUT_MS = SEAM_FALLBACK_TIMEOUT_MS;',
  '',
  '/**',
  ' * Evidence (TIMEOUT_EVIDENCE.FIXTURE_HOOK_TIMEOUT_SECONDS): fixture-data - seconds value inside a hook-entry fixture.',
  ' */',
  'const FIXTURE_HOOK_TIMEOUT_SECONDS = 5;',
  '',
  '/**',
  ' * Evidence (TIMEOUT_EVIDENCE.PATHOLOGICAL_INPUT_TEST_TIMEOUT_MS): test-backstop - node:test hang backstop.',
  ' */',
  'const PATHOLOGICAL_INPUT_TEST_TIMEOUT_MS = 60000;',
  '',
  '/**',
  ' * Evidence (TIMEOUT_EVIDENCE.REAL_REPO_GIT_TIMEOUT_MS): worst observed 262ms on darwin (p50 37ms, p99 195ms of 350 harness spawns),',
  ' * margin 114.50x; local harness.',
  ' */',
  'const REAL_REPO_GIT_TIMEOUT_MS = 30000;',
  '',
  '/**',
  ' * Evidence (TIMEOUT_EVIDENCE.GSD_TOOLS_CLI_MODERATE_TIMEOUT_MS): worst observed 2270ms on win32 (p50 2036ms, p99 2270ms of recorded spawns),',
  ' * margin 13.21x; CI seam spawn-stall records, 188 runs.',
  ' */',
  'const GSD_TOOLS_CLI_MODERATE_TIMEOUT_MS = 30000;',
  '',
  '/**',
  ' * Evidence (TIMEOUT_EVIDENCE.TEN_K_TIMEOUT_MS): worst observed 10000ms on linux (p50 4000ms, p99 9000ms of 50 harness spawns),',
  ' * margin 4.60x; local harness.',
  ' */',
  'const TEN_K_TIMEOUT_MS = 46000;',
  '',
  'const HARNESS_OBS = 4000;',
  '',
  '/**',
  ' * Evidence (TIMEOUT_EVIDENCE.NONLITERAL_OBS_TIMEOUT_MS): worst observed 4000ms on linux (50 harness spawns),',
  ' * margin 2.25x; local harness.',
  ' */',
  'const NONLITERAL_OBS_TIMEOUT_MS = 9000;',
  '',
  '/**',
  ' * Evidence (TIMEOUT_EVIDENCE.ZERO_OBS_TIMEOUT_MS): worst observed 0ms on linux, margin 0x; local harness.',
  ' */',
  'const ZERO_OBS_TIMEOUT_MS = 9000;',
  '',
  '/** Not exported. */',
  'const LOCAL_ONLY_TIMEOUT_MS = 1234;',
  '',
  "const CI_SOURCE = 'ci seam spawn-stall records';",
  '',
  '/**',
  ' * Evidence for every numeric constant in this module.',
  ' */',
  'const TIMEOUT_EVIDENCE = Object.freeze({',
  "  PROBE_TIMEOUT_MS: { kind: 'measured', observedMaxMs: 7424, worstPlatform: 'darwin', samples: { darwin: 516 }, source: CI_SOURCE },",
  '  HOOK_FANOUT_TIMEOUT_MS: {',
  "    kind: 'measured',",
  '    observedMaxMs: 23514,',
  "    worstPlatform: 'win32',",
  '    samples: { win32: 266, darwin: 978 },',
  '    source: CI_SOURCE,',
  '  },',
  "  REAL_REPO_GIT_TIMEOUT_MS: { kind: 'measured', observedMaxMs: 262, worstPlatform: 'darwin', source: CI_SOURCE },",
  "  GIT_TIMEOUT_MS: { kind: 'measured', observedMaxMs: 4669, worstPlatform: 'win32', source: CI_SOURCE },",
  "  GIT_FIXTURE_TIMEOUT_MS: { kind: 'measured', observedMaxMs: 10114, worstPlatform: 'win32', source: CI_SOURCE },",
  "  BUILD_TIMEOUT_MS: { kind: 'measured', observedMaxMs: 2000, censoredBelowMs: 2000, worstPlatform: null, source: CI_SOURCE },",
  "  SEAM_DEFAULT_TIMEOUT_MS: { kind: 'mirror', of: { module: 'tests/helpers/process-seam.cjs', export: 'DEFAULT_TIMEOUT_MS' } },",
  "  FIXTURE_HOOK_TIMEOUT_SECONDS: { kind: 'fixture-data', reason: 'seconds value inside a hook-entry fixture' },",
  "  PATHOLOGICAL_INPUT_TEST_TIMEOUT_MS: { kind: 'test-backstop', reason: 'node:test per-test hang backstop' },",
  "  GSD_TOOLS_CLI_MODERATE_TIMEOUT_MS: { kind: 'measured', observedMaxMs: 2270, worstPlatform: 'win32', p50Ms: 2036, p99Ms: 2270, source: CI_SOURCE },",
  "  TEN_K_TIMEOUT_MS: { kind: 'measured', observedMaxMs: 10000, worstPlatform: 'linux', source: 'harness' },",
  "  NONLITERAL_OBS_TIMEOUT_MS: { kind: 'measured', observedMaxMs: HARNESS_OBS, worstPlatform: 'linux', source: 'harness' },",
  "  ZERO_OBS_TIMEOUT_MS: { kind: 'measured', observedMaxMs: 0, worstPlatform: 'linux', source: 'harness' },",
  '});',
  '',
  'module.exports = {',
  '  PROBE_TIMEOUT_MS,',
  '  HOOK_FANOUT_TIMEOUT_MS,',
  '  GIT_TIMEOUT_MS,',
  '  GIT_FIXTURE_TIMEOUT_MS,',
  '  BUILD_TIMEOUT_MS,',
  '  SEAM_DEFAULT_TIMEOUT_MS,',
  '  FIXTURE_HOOK_TIMEOUT_SECONDS,',
  '  PATHOLOGICAL_INPUT_TEST_TIMEOUT_MS,',
  '  REAL_REPO_GIT_TIMEOUT_MS,',
  '  GSD_TOOLS_CLI_MODERATE_TIMEOUT_MS,',
  '  TEN_K_TIMEOUT_MS,',
  '  NONLITERAL_OBS_TIMEOUT_MS,',
  '  ZERO_OBS_TIMEOUT_MS,',
  '  TIMEOUT_EVIDENCE,',
  '};',
]);

const GIT_FIXTURE = T([
  "'use strict';",
  '',
  '/** Git plumbing bound for a small fixture repo. */',
  'const DEFAULT_GIT_TIMEOUT_MS = 15000;',
  '',
  '/** A heavier fixture-repo git class. */',
  'const GIT_FIXTURE_TIMEOUT_MS = 60000;',
  '',
  '/** Not re-exported by timeouts.cjs. */',
  'const LOCAL_GIT_HELPER_TIMEOUT_MS = 5000;',
  '',
  'function runGit() {}',
  '',
  'module.exports = { runGit, DEFAULT_GIT_TIMEOUT_MS, GIT_FIXTURE_TIMEOUT_MS, LOCAL_GIT_HELPER_TIMEOUT_MS };',
]);

const PROCESS_SEAM = T([
  "'use strict';",
  '',
  '/** Fallback when a caller passes no timeoutMs. */',
  'const DEFAULT_TIMEOUT_MS = 60000;',
  '',
  'module.exports = { DEFAULT_TIMEOUT_MS };',
]);

const FOO_TEST = T([
  "'use strict';",
  '',
  "const test = require('node:test');",
  '',
  '// CLI probe bound: worst observed 900ms on win32 (p99 700ms of 50 spawns), margin 2.22x; local harness.',
  'const CLI_TIMEOUT_MS = 2000;',
  '',
  '// Spawn bound: worst observed 1800ms on linux (p99 1500ms of 50 spawns), margin 2.22x; local harness.',
  'const unrelated = 1;',
  'const BARE_TIMEOUT_MS = 4000;',
  '',
  "test('x', () => {",
  '  const t = unrelated;',
  '});',
]);

const SRC_X = T(["'use strict';", 'const X_TIMEOUT_MS = 1000;', 'module.exports = { X_TIMEOUT_MS };']);

const BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'timeout-evidence-edit-')));
test.after(() => fs.rmSync(BASE, { recursive: true, force: true }));

function write(root, rel, body) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  return p;
}

let rootSeq = 0;
/** A fresh gsd-core-shaped root. `files` overrides or adds files; a null body leaves that file out. */
function makeRoot(files = {}) {
  const root = path.join(BASE, 'r' + rootSeq++);
  write(root, 'scripts/issue-dedupe.cjs', '// sentinel\n');
  fs.mkdirSync(path.join(root, 'gsd-core', 'bin', 'lib'), { recursive: true });
  const all = Object.assign(
    {
      'tests/helpers/timeouts.cjs': TIMEOUTS,
      'tests/helpers/git-fixture.cjs': GIT_FIXTURE,
      'tests/helpers/process-seam.cjs': PROCESS_SEAM,
      'tests/foo.test.cjs': FOO_TEST,
      'src/x.cjs': SRC_X,
    },
    files
  );
  for (const [rel, body] of Object.entries(all)) if (body !== null) write(root, rel, body);
  return root;
}

const ROOT = makeRoot(); // read-only rows share this root; rows that change disk make their own
const TO = 'tests/helpers/timeouts.cjs';

function payload(tool, filePath, input, cwd) {
  const p = { tool_name: tool, tool_input: Object.assign({ file_path: filePath }, input) };
  if (cwd !== undefined) p.cwd = cwd;
  return JSON.stringify(p);
}
const guardWrite = (root, rel, content) => runEditGuard(payload('Write', path.join(root, rel), { content }));
const guardEdit = (root, rel, oldS, newS, extra = {}) =>
  runEditGuard(payload('Edit', path.join(root, rel), Object.assign({ old_string: oldS, new_string: newS }, extra)));
const guardMulti = (root, rel, edits) => runEditGuard(payload('MultiEdit', path.join(root, rel), { edits }));

/** Apply one exact, unique replacement to disk, as the Edit tool would after the hook passed. */
function applyToDisk(root, rel, oldS, newS) {
  const p = path.join(root, rel);
  const t = fs.readFileSync(p, 'utf8');
  assert.strictEqual(t.split(oldS).length - 1, 1, 'fixture edit must be unique: ' + JSON.stringify(oldS));
  const i = t.indexOf(oldS);
  fs.writeFileSync(p, t.slice(0, i) + newS + t.slice(i + oldS.length));
}

/** One step of a sequence: judge the Edit, assert the expectation, then apply it to disk. */
function step(root, rel, oldS, newS, expect) {
  expect(guardEdit(root, rel, oldS, newS));
  applyToDisk(root, rel, oldS, newS);
}

function assertDeny(result, ...needles) {
  assert.ok(result && typeof result === 'object', 'expected a deny object, got ' + JSON.stringify(result));
  assert.strictEqual(result.permissionDecision, 'deny', JSON.stringify(result));
  assert.ok(typeof result.permissionDecisionReason === 'string' && result.permissionDecisionReason.length > 0);
  for (const n of needles) {
    assert.ok(result.permissionDecisionReason.includes(n), 'reason should include ' + JSON.stringify(n) + ':\n' + result.permissionDecisionReason);
  }
}

function assertAdvisory(result, ...needles) {
  assert.ok(result && typeof result === 'object', 'expected an advisory object, got ' + JSON.stringify(result));
  assert.ok(!('permissionDecision' in result), 'an advisory carries no permissionDecision key: ' + JSON.stringify(result));
  assert.ok(typeof result.additionalContext === 'string' && result.additionalContext.length > 0, JSON.stringify(result));
  for (const n of needles) {
    assert.ok(result.additionalContext.includes(n), 'context should include ' + JSON.stringify(n) + ':\n' + result.additionalContext);
  }
}

function assertSilent(result) {
  assert.strictEqual(result, null, 'expected a silent pass (null), got ' + JSON.stringify(result));
}

const sub = (text, from, to) => {
  assert.ok(text.includes(from), 'fixture substitution source missing: ' + JSON.stringify(from));
  return text.split(from).join(to);
};

// The #6143 change (28c1f91d1) in the synthetic fixture: comment, entry and value of GSD_TOOLS_CLI_MODERATE_TIMEOUT_MS.
const MOD_COMMENT_OLD =
  'worst observed 2270ms on win32 (p50 2036ms, p99 2270ms of recorded spawns),\n * margin 13.21x';
const MOD_COMMENT_NEW =
  'worst observed 15020ms on win32 (p50 2270ms, p99 15020ms of recorded spawns),\n * margin 2.13x';
const MOD_ENTRY_OLD = 'observedMaxMs: 2270, worstPlatform: \'win32\', p50Ms: 2036, p99Ms: 2270';
const MOD_ENTRY_NEW = 'observedMaxMs: 15020, worstPlatform: \'win32\', p50Ms: 2270, p99Ms: 15020';
const MOD_VALUE_OLD = 'const GSD_TOOLS_CLI_MODERATE_TIMEOUT_MS = 30000;';
const MOD_VALUE_NEW = 'const GSD_TOOLS_CLI_MODERATE_TIMEOUT_MS = 32000;';
const COMPLIANT_6143 = sub(sub(sub(TIMEOUTS, MOD_COMMENT_OLD, MOD_COMMENT_NEW), MOD_ENTRY_OLD, MOD_ENTRY_NEW), MOD_VALUE_OLD, MOD_VALUE_NEW);
const STALE_6143 = sub(sub(TIMEOUTS, MOD_ENTRY_OLD, MOD_ENTRY_NEW), MOD_VALUE_OLD, MOD_VALUE_NEW);

const PROBE_DECL = 'const PROBE_TIMEOUT_MS = 15000;';
const ENTRY_ANCHOR = 'const TIMEOUT_EVIDENCE = Object.freeze({\n';
const EXPORT_ANCHOR = 'module.exports = {\n';
const CI_ANCHOR = "const CI_SOURCE = 'ci seam spawn-stall records';";

// ---------------------------------------------------------------- arm A: the #6143 replay (truth 7)

test('#6143: the compliant post-image Write passes', () => {
  assertSilent(guardWrite(ROOT, TO, COMPLIANT_6143));
});

test('#6143: the same Write with the comment hunk left at its old text (13.21x, 2270ms) denies, reason in full', () => {
  const r = guardWrite(ROOT, TO, STALE_6143);
  assertDeny(
    r,
    'tests/helpers/timeouts.cjs',
    'GSD_TOOLS_CLI_MODERATE_TIMEOUT_MS',
    '30000',
    '32000',
    'worst observed 15020ms',
    'margin 2.13x',
    '`worst observed <N>ms`',
    '`margin <M>x`',
    '`margin at least <M>x`',
    'first',
    'comment-only or evidence-only edit',
    'arithmetic',
    'cannot check that an observation is real',
    '(ENF-27, fail-open edit guard)'
  );
});

test('#6143: the compliant sequence (comment, entry, value; each applied to disk) passes at every step', () => {
  const root = makeRoot();
  step(root, TO, MOD_COMMENT_OLD, MOD_COMMENT_NEW, assertSilent);
  step(root, TO, MOD_ENTRY_OLD, MOD_ENTRY_NEW, assertSilent);
  step(root, TO, MOD_VALUE_OLD, MOD_VALUE_NEW, assertSilent);
});

test('#6143: the value edit first denies (stale 13.21x / 2270ms)', () => {
  assertDeny(guardEdit(ROOT, TO, MOD_VALUE_OLD, MOD_VALUE_NEW), 'GSD_TOOLS_CLI_MODERATE_TIMEOUT_MS', '30000', '32000');
});

test('value-first: a new exported constant with no entry and no comment denies; the reason names the entry and comment to add first', () => {
  const post = sub(sub(TIMEOUTS, CI_ANCHOR, 'const NEW_CLASS_TIMEOUT_MS = 30000;\n\n' + CI_ANCHOR), EXPORT_ANCHOR, EXPORT_ANCHOR + '  NEW_CLASS_TIMEOUT_MS,\n');
  assertDeny(guardWrite(ROOT, TO, post), 'NEW_CLASS_TIMEOUT_MS', 'TIMEOUT_EVIDENCE entry', 'Evidence (TIMEOUT_EVIDENCE.NEW_CLASS_TIMEOUT_MS):', '30000');
});

// ---------------------------------------------------------------- arm A: amendment A1 (newly exported is judged)

test('A1 row 1: declaration (pass), entry (pass), export line (DENY: Evidence comment missing), each a separate Edit', () => {
  const root = makeRoot();
  step(root, TO, CI_ANCHOR, '/** A new class, no evidence yet. */\nconst NEW_CLASS_TIMEOUT_MS = 30000;\n\n' + CI_ANCHOR, assertSilent);
  step(root, TO, ENTRY_ANCHOR, ENTRY_ANCHOR + "  NEW_CLASS_TIMEOUT_MS: { kind: 'measured', observedMaxMs: 5000, worstPlatform: 'linux', source: CI_SOURCE },\n", assertSilent);
  assertDeny(guardEdit(root, TO, EXPORT_ANCHOR, EXPORT_ANCHOR + '  NEW_CLASS_TIMEOUT_MS,\n'), 'NEW_CLASS_TIMEOUT_MS', 'Evidence (TIMEOUT_EVIDENCE.NEW_CLASS_TIMEOUT_MS):');
});

test('A1 row 2: two-Edit rename-raise (declaration renamed and raised passes; the export rename DENIES, no entry)', () => {
  const root = makeRoot();
  step(root, TO, MOD_VALUE_OLD, 'const GSD_TOOLS_CLI_HEAVY_TIMEOUT_MS = 40000;', assertSilent);
  assertDeny(
    guardEdit(root, TO, '  GSD_TOOLS_CLI_MODERATE_TIMEOUT_MS,\n', '  GSD_TOOLS_CLI_HEAVY_TIMEOUT_MS,\n'),
    'GSD_TOOLS_CLI_HEAVY_TIMEOUT_MS',
    'TIMEOUT_EVIDENCE entry'
  );
});

test('A1 row 2b: rename-raise with entry key and Evidence tag renamed first (stale 13.21x) DENIES at the export rename', () => {
  const root = makeRoot();
  step(root, TO, 'TIMEOUT_EVIDENCE.GSD_TOOLS_CLI_MODERATE_TIMEOUT_MS)', 'TIMEOUT_EVIDENCE.GSD_TOOLS_CLI_HEAVY_TIMEOUT_MS)', assertSilent);
  step(root, TO, '  GSD_TOOLS_CLI_MODERATE_TIMEOUT_MS: {', '  GSD_TOOLS_CLI_HEAVY_TIMEOUT_MS: {', assertSilent);
  step(root, TO, MOD_VALUE_OLD, 'const GSD_TOOLS_CLI_HEAVY_TIMEOUT_MS = 40000;', assertSilent);
  assertDeny(
    guardEdit(root, TO, '  GSD_TOOLS_CLI_MODERATE_TIMEOUT_MS,\n', '  GSD_TOOLS_CLI_HEAVY_TIMEOUT_MS,\n'),
    'GSD_TOOLS_CLI_HEAVY_TIMEOUT_MS',
    'margin 17.62x'
  );
});

test('A1 row 3: compliant order (entry, then declaration with its Evidence comment, then export) passes at every step', () => {
  const root = makeRoot();
  step(root, TO, ENTRY_ANCHOR, ENTRY_ANCHOR + "  NEW_CLASS_TIMEOUT_MS: { kind: 'measured', observedMaxMs: 5000, worstPlatform: 'linux', source: CI_SOURCE },\n", assertSilent);
  step(
    root,
    TO,
    CI_ANCHOR,
    '/**\n * Evidence (TIMEOUT_EVIDENCE.NEW_CLASS_TIMEOUT_MS): worst observed 5000ms on linux (50 harness spawns),\n * margin 6.00x; local harness.\n */\nconst NEW_CLASS_TIMEOUT_MS = 30000;\n\n' + CI_ANCHOR,
    assertSilent
  );
  step(root, TO, EXPORT_ANCHOR, EXPORT_ANCHOR + '  NEW_CLASS_TIMEOUT_MS,\n', assertSilent);
});

// ---------------------------------------------------------------- arm A: amendment A2 (the comment is bounded)

test('A2: PROBE margin clause removed and raised to 19000 (the next block states 2.55x) DENIES: margin missing', () => {
  const r = guardEdit(
    ROOT,
    TO,
    ' * margin 2.02x; CI seam spawn-stall records, 196 runs.\n */\nconst PROBE_TIMEOUT_MS = 15000;',
    ' * CI seam spawn-stall records, 196 runs.\n */\nconst PROBE_TIMEOUT_MS = 19000;'
  );
  assertDeny(r, 'PROBE_TIMEOUT_MS', '19000', 'margin 2.55x');
});

test('A2: worst observed is read only inside the constant\'s own comment', () => {
  // PROBE's own block comment loses its observation; a `//` line after the block's `*/` that says "worst observed
  // 7424ms" is the next match an unbounded scan would take, and must not satisfy it. 15010 keeps margin 2.02x.
  const post = sub(
    sub(TIMEOUTS, 'worst observed 7424ms on darwin', 'a darwin observation'),
    ' */\n' + PROBE_DECL,
    ' */\n// see worst observed 7424ms in the CI log\nconst PROBE_TIMEOUT_MS = 15010;'
  );
  assertDeny(guardWrite(ROOT, TO, post), 'PROBE_TIMEOUT_MS', 'worst observed 7424ms');
});

// ---------------------------------------------------------------- arm A: amendment A3 (format drift passes)

const SPREAD_TIMEOUTS = (() => {
  const start = TIMEOUTS.indexOf(ENTRY_ANCHOR);
  const end = TIMEOUTS.indexOf('});\n', start);
  const body = TIMEOUTS.slice(start + ENTRY_ANCHOR.length, end);
  return (
    TIMEOUTS.slice(0, start) +
    'const MEASURED_EVIDENCE = {\n' + body + '};\n\n' +
    'const TIMEOUT_EVIDENCE = Object.freeze({ ...MEASURED_EVIDENCE });\n' +
    TIMEOUTS.slice(end + 4)
  );
})();

test('A3: a spread-built TIMEOUT_EVIDENCE with a compliant raise is a silent pass (format drift)', () => {
  const root = makeRoot({ [TO]: SPREAD_TIMEOUTS });
  const post = sub(sub(SPREAD_TIMEOUTS, PROBE_DECL, 'const PROBE_TIMEOUT_MS = 30000;'), 'margin 2.02x', 'margin 4.04x');
  assertSilent(guardWrite(root, TO, post));
});

test('A3: a spread-built map also passes a new unevidenced export; the plain map denies the same Write (control)', () => {
  const addNew = (t) => sub(sub(t, CI_ANCHOR, 'const NEW_CLASS_TIMEOUT_MS = 30000;\n\n' + CI_ANCHOR), EXPORT_ANCHOR, EXPORT_ANCHOR + '  NEW_CLASS_TIMEOUT_MS,\n');
  const spreadRoot = makeRoot({ [TO]: SPREAD_TIMEOUTS });
  assertSilent(guardWrite(spreadRoot, TO, addNew(SPREAD_TIMEOUTS)));
  assertDeny(guardWrite(ROOT, TO, addNew(TIMEOUTS)), 'NEW_CLASS_TIMEOUT_MS', 'TIMEOUT_EVIDENCE entry');
});

test('A3: one quoted key among normal entries is drift (missing-entry passes); unquoted, the same Write denies', () => {
  const quoted = sub(TIMEOUTS, '  PROBE_TIMEOUT_MS: {', "  'PROBE_TIMEOUT_MS': {");
  const addNew = (t) => sub(sub(t, CI_ANCHOR, 'const NEW_CLASS_TIMEOUT_MS = 30000;\n\n' + CI_ANCHOR), EXPORT_ANCHOR, EXPORT_ANCHOR + '  NEW_CLASS_TIMEOUT_MS,\n');
  assertSilent(guardWrite(makeRoot({ [TO]: quoted }), TO, addNew(quoted)));
  assertDeny(guardWrite(ROOT, TO, addNew(TIMEOUTS)), 'NEW_CLASS_TIMEOUT_MS');
});

test('A3: two new unevidenced exported constants in one Write both deny (the co-rising constant is not "another")', () => {
  const post = sub(
    sub(TIMEOUTS, CI_ANCHOR, 'const NEW_A_TIMEOUT_MS = 30000;\nconst NEW_B_TIMEOUT_MS = 40000;\n\n' + CI_ANCHOR),
    EXPORT_ANCHOR,
    EXPORT_ANCHOR + '  NEW_A_TIMEOUT_MS,\n  NEW_B_TIMEOUT_MS,\n'
  );
  assertDeny(guardWrite(ROOT, TO, post), 'NEW_A_TIMEOUT_MS', 'NEW_B_TIMEOUT_MS');
});

test('A3: a post-image with no TIMEOUT_EVIDENCE block raises nothing judgeable and passes silently', () => {
  const start = TIMEOUTS.indexOf(ENTRY_ANCHOR);
  const end = TIMEOUTS.indexOf('});\n', start);
  const post = sub(TIMEOUTS.slice(0, start) + TIMEOUTS.slice(end + 4), PROBE_DECL, 'const PROBE_TIMEOUT_MS = 30000;');
  assertSilent(guardWrite(ROOT, TO, post));
});

// ---------------------------------------------------------------- arm A: boundary, precision, literal forms

test('boundary: equal value passes; 15070 (floor2 still 2.02) passes; 15071 (2.03) denies; lowered passes', () => {
  assertSilent(guardEdit(ROOT, TO, PROBE_DECL, 'const PROBE_TIMEOUT_MS = 15_000;'));
  assertSilent(guardEdit(ROOT, TO, PROBE_DECL, 'const PROBE_TIMEOUT_MS = 15070;'));
  assertDeny(guardEdit(ROOT, TO, PROBE_DECL, 'const PROBE_TIMEOUT_MS = 15071;'), 'PROBE_TIMEOUT_MS', '15071', 'margin 2.03x');
  assertSilent(guardEdit(ROOT, TO, PROBE_DECL, 'const PROBE_TIMEOUT_MS = 14000;'));
});

test('precision: 46000 over 10000 accepts 4.60x (integer floor) and 4.59x (upstream float floor); 4.61x denies', () => {
  const root = makeRoot({ [TO]: sub(sub(TIMEOUTS, 'const TEN_K_TIMEOUT_MS = 46000;', 'const TEN_K_TIMEOUT_MS = 40000;'), 'margin 4.60x', 'margin 4.00x') });
  const raise = (stated) => guardMulti(root, TO, [
    { old_string: 'margin 4.00x', new_string: 'margin ' + stated + 'x' },
    { old_string: 'const TEN_K_TIMEOUT_MS = 40000;', new_string: 'const TEN_K_TIMEOUT_MS = 46000;' },
  ]);
  assertSilent(raise('4.60'));
  assertSilent(raise('4.59'));
  assertDeny(raise('4.61'), 'TEN_K_TIMEOUT_MS');
});

test('literal forms: 30_000, 30 * 1000, 3e4 and 0x7530 all resolve, so each stale raise denies', () => {
  for (const rhs of ['30_000', '30 * 1000', '3e4', '0x7530', '(15000 + 15000)', '+30000']) {
    assertDeny(guardEdit(ROOT, TO, PROBE_DECL, 'const PROBE_TIMEOUT_MS = ' + rhs + ';'), 'PROBE_TIMEOUT_MS', '30000');
  }
});

test('evalNumeric: 15000, 15_000, 15 * 1000, 1.5e4 and 0x3A98 give 15000; a same-file constant resolves; others are trusted', () => {
  for (const src of ['15000', '15_000', '15 * 1000', '1.5e4', '0x3A98', '(7500 + 7500)', '30000 / 2', '0o35230', '0b11101010011000']) {
    assert.strictEqual(mod.evalNumeric(src, null), 15000, src);
  }
  assert.strictEqual(mod.evalNumeric('3 * PROBE_TIMEOUT_MS', { PROBE_TIMEOUT_MS: 15000 }), 45000);
  assert.strictEqual(mod.evalNumeric('3 * OTHER_MS', { PROBE_TIMEOUT_MS: 15000 }), null);
  assert.strictEqual(mod.evalNumeric('3 * PROBE_TIMEOUT_MS', null), null);
  for (const src of ['foo()', "'15000'", '15000n', '2 ** 3', '', 'a.b', '1 +', '(1', '1e400']) {
    assert.strictEqual(mod.evalNumeric(src, null), null, src);
  }
  assert.strictEqual(mod.evalNumeric('('.repeat(40) + '1' + ')'.repeat(40), null), null, 'depth cap');
});

test('symbol table: HOOK_FANOUT = 5 * PROBE_TIMEOUT_MS (75000) with a stale 2.55x comment denies', () => {
  assertDeny(guardEdit(ROOT, TO, 'const HOOK_FANOUT_TIMEOUT_MS = 60000;', 'const HOOK_FANOUT_TIMEOUT_MS = 5 * PROBE_TIMEOUT_MS;'), 'HOOK_FANOUT_TIMEOUT_MS', '75000');
});

test('trusted: an imported identifier on the right-hand side passes (as upstream ESLint trusts it)', () => {
  assertSilent(guardEdit(ROOT, TO, 'const GIT_TIMEOUT_MS = DEFAULT_GIT_TIMEOUT_MS;', 'const GIT_TIMEOUT_MS = DEFAULT_GIT_TIMEOUT_MS * 2;'));
});

test('call-site cases pass: IDENT * 4 at a call site, a call-site swap to a larger existing constant', () => {
  assertSilent(guardEdit(ROOT, 'tests/foo.test.cjs', '  const t = unrelated;', '  const t = spawn({ timeout: PROBE_TIMEOUT_MS * 4 });'));
  assertSilent(guardEdit(ROOT, 'tests/foo.test.cjs', '  const t = unrelated;', '  const t = spawn({ timeout: HOOK_FANOUT_TIMEOUT_MS });'));
});

// ---------------------------------------------------------------- arm A: the pass list (truth 6)

test('pass: exempt kinds (fixture-data, test-backstop) and a mirror raised', () => {
  assertSilent(guardEdit(ROOT, TO, 'const FIXTURE_HOOK_TIMEOUT_SECONDS = 5;', 'const FIXTURE_HOOK_TIMEOUT_SECONDS = 10;'));
  assertSilent(guardEdit(ROOT, TO, 'const PATHOLOGICAL_INPUT_TEST_TIMEOUT_MS = 60000;', 'const PATHOLOGICAL_INPUT_TEST_TIMEOUT_MS = 90000;'));
  assertSilent(guardEdit(ROOT, TO, 'const SEAM_DEFAULT_TIMEOUT_MS = SEAM_FALLBACK_TIMEOUT_MS;', 'const SEAM_DEFAULT_TIMEOUT_MS = 90000;'));
});

test('pass: a non-literal or non-positive observedMaxMs', () => {
  assertSilent(guardEdit(ROOT, TO, 'const NONLITERAL_OBS_TIMEOUT_MS = 9000;', 'const NONLITERAL_OBS_TIMEOUT_MS = 99000;'));
  assertSilent(guardEdit(ROOT, TO, 'const ZERO_OBS_TIMEOUT_MS = 9000;', 'const ZERO_OBS_TIMEOUT_MS = 99000;'));
});

test('pass: a constant not listed in module.exports (raised, or new and numeric)', () => {
  assertSilent(guardEdit(ROOT, TO, 'const LOCAL_ONLY_TIMEOUT_MS = 1234;', 'const LOCAL_ONLY_TIMEOUT_MS = 99999;'));
  assertSilent(guardEdit(ROOT, TO, CI_ANCHOR, 'const LOCAL_NEW_TIMEOUT_MS = 5000;\n' + CI_ANCHOR));
});

test('pass: a post-image with no module.exports object', () => {
  const start = TIMEOUTS.indexOf(EXPORT_ANCHOR);
  assertSilent(guardWrite(ROOT, TO, sub(TIMEOUTS.slice(0, start), PROBE_DECL, 'const PROBE_TIMEOUT_MS = 30000;')));
});

test('pass: comment-only and evidence-only edits never deny, even when they leave the comment stale', () => {
  assertSilent(guardEdit(ROOT, TO, 'margin 2.02x', 'margin 9.99x'));
  assertSilent(guardEdit(ROOT, TO, 'observedMaxMs: 7424,', 'observedMaxMs: 9000,'));
  assertSilent(guardEdit(ROOT, TO, 'Evidence (TIMEOUT_EVIDENCE.PROBE_TIMEOUT_MS): ', 'Evidence: '));
});

test('pass: an empty Write, and an Edit whose new_string removes a constant', () => {
  assertSilent(guardWrite(ROOT, TO, ''));
  assertSilent(guardEdit(ROOT, TO, PROBE_DECL + '\n', ''));
});

// ---------------------------------------------------------------- arm A: deny forms (truths 1-3)

test('deny: censored entry (no worst observed needed): 32000 with a stale "at least 15x" denies; "at least 16x" passes; 30010 passes', () => {
  assertDeny(guardEdit(ROOT, TO, 'const BUILD_TIMEOUT_MS = 30000;', 'const BUILD_TIMEOUT_MS = 32000;'), 'BUILD_TIMEOUT_MS', 'margin at least 16.00x');
  assertSilent(guardMulti(ROOT, TO, [
    { old_string: 'margin at least 15x', new_string: 'margin at least 16x' },
    { old_string: 'const BUILD_TIMEOUT_MS = 30000;', new_string: 'const BUILD_TIMEOUT_MS = 32000;' },
  ]));
  assertSilent(guardEdit(ROOT, TO, 'const BUILD_TIMEOUT_MS = 30000;', 'const BUILD_TIMEOUT_MS = 30010;'));
});

test('deny: uncensored entry with "worst observed" missing, or naming another figure', () => {
  const raise = { old_string: PROBE_DECL, new_string: 'const PROBE_TIMEOUT_MS = 30000;' };
  const margin = { old_string: 'margin 2.02x', new_string: 'margin 4.04x' };
  assertDeny(guardMulti(ROOT, TO, [margin, raise, { old_string: 'worst observed 7424ms on darwin', new_string: 'on darwin' }]), 'worst observed 7424ms');
  assertDeny(guardMulti(ROOT, TO, [margin, raise, { old_string: 'worst observed 7424ms', new_string: 'worst observed 7000ms' }]), 'worst observed 7424ms');
  assertSilent(guardMulti(ROOT, TO, [margin, raise]));
});

test('deny: the Evidence tag removed in the same Write as a raise', () => {
  const post = sub(sub(TIMEOUTS, 'Evidence (TIMEOUT_EVIDENCE.PROBE_TIMEOUT_MS): ', ''), PROBE_DECL, 'const PROBE_TIMEOUT_MS = 30000;');
  assertDeny(guardWrite(ROOT, TO, post), 'Evidence (TIMEOUT_EVIDENCE.PROBE_TIMEOUT_MS):');
});

test('deny: correct figures in other wording deny, and the reason shows the accepted forms', () => {
  const post = sub(
    sub(TIMEOUTS, 'worst observed 7424ms on darwin (p50 111ms, p99 3411ms of recorded spawns),\n * margin 2.02x', 'the worst observation was 7424 ms on darwin;\n * the margin is 4.04 times'),
    PROBE_DECL,
    'const PROBE_TIMEOUT_MS = 30000;'
  );
  assertDeny(guardWrite(ROOT, TO, post), '`worst observed <N>ms`', '`margin <M>x`', '`margin at least <M>x`', 'first');
});

test('deny: every failing constant is named at once', () => {
  const post = sub(sub(TIMEOUTS, PROBE_DECL, 'const PROBE_TIMEOUT_MS = 30000;'), 'const HOOK_FANOUT_TIMEOUT_MS = 60000;', 'const HOOK_FANOUT_TIMEOUT_MS = 90000;');
  assertDeny(guardWrite(ROOT, TO, post), 'PROBE_TIMEOUT_MS', 'HOOK_FANOUT_TIMEOUT_MS');
});

test('anchoring: GIT_TIMEOUT_MS is judged against its own entry although REAL_REPO_GIT_TIMEOUT_MS is listed first', () => {
  const parsed = mod.parseTimeoutsModule(TIMEOUTS);
  assert.ok(parsed && parsed.entries, 'parseTimeoutsModule returns entries');
  assert.strictEqual(parsed.entries.get('GIT_TIMEOUT_MS').observedMaxMs, 4669);
  assert.strictEqual(parsed.entries.get('REAL_REPO_GIT_TIMEOUT_MS').observedMaxMs, 262);
  assert.strictEqual(parsed.entries.get('HOOK_FANOUT_TIMEOUT_MS').observedMaxMs, 23514, 'a multi-line entry parses');
  assert.strictEqual(parsed.entries.get('BUILD_TIMEOUT_MS').censored, true);
  assert.strictEqual(parsed.entries.get('PROBE_TIMEOUT_MS').censored, false);
  assert.strictEqual(parsed.entries.get('SEAM_DEFAULT_TIMEOUT_MS').kind, 'mirror');
  assert.ok(parsed.exports.has('GIT_FIXTURE_TIMEOUT_MS') && parsed.exports.has('TIMEOUT_EVIDENCE'));
  assert.ok(parsed.tags.has('GIT_TIMEOUT_MS') && parsed.tags.has('GIT_FIXTURE_TIMEOUT_MS'));
  assert.deepStrictEqual(parsed.reexports.get('./git-fixture.cjs').get('DEFAULT_GIT_TIMEOUT_MS'), ['GIT_TIMEOUT_MS']);
  assert.deepStrictEqual(parsed.reexports.get('./git-fixture.cjs').get('GIT_FIXTURE_TIMEOUT_MS'), ['GIT_FIXTURE_TIMEOUT_MS']);
  assert.deepStrictEqual(parsed.reexports.get('./process-seam.cjs').get('DEFAULT_TIMEOUT_MS'), ['SEAM_DEFAULT_TIMEOUT_MS']);
});

// ---------------------------------------------------------------- arm A: re-exports (truth 4)

test('re-export: git-fixture DEFAULT_GIT_TIMEOUT_MS 15000 -> 16000 denies against GIT_TIMEOUT_MS in timeouts.cjs; restated, it passes', () => {
  const root = makeRoot();
  const raise = ['const DEFAULT_GIT_TIMEOUT_MS = 15000;', 'const DEFAULT_GIT_TIMEOUT_MS = 16000;'];
  assertDeny(guardEdit(root, 'tests/helpers/git-fixture.cjs', ...raise), 'DEFAULT_GIT_TIMEOUT_MS', 'GIT_TIMEOUT_MS', 'tests/helpers/timeouts.cjs', 'margin 3.42x');
  step(root, TO, 'margin 3.21x', 'margin 3.42x', assertSilent); // comment-only: passes
  assertSilent(guardEdit(root, 'tests/helpers/git-fixture.cjs', ...raise)); // its own entry (4669), not REAL_REPO's (262)
});

test('re-export: GIT_FIXTURE_TIMEOUT_MS (exported as itself) 60000 -> 70000 denies when stale and passes when restated', () => {
  const root = makeRoot();
  const raise = ['const GIT_FIXTURE_TIMEOUT_MS = 60000;', 'const GIT_FIXTURE_TIMEOUT_MS = 70000;'];
  assertDeny(guardEdit(root, 'tests/helpers/git-fixture.cjs', ...raise), 'GIT_FIXTURE_TIMEOUT_MS', 'tests/helpers/timeouts.cjs', 'margin 6.92x');
  step(root, TO, 'margin 5.93x', 'margin 6.92x', assertSilent);
  assertSilent(guardEdit(root, 'tests/helpers/git-fixture.cjs', ...raise));
});

test('re-export: process-seam DEFAULT_TIMEOUT_MS (a mirror export) raised with no evidence gets the arm B note, not a deny', () => {
  assertAdvisory(guardEdit(ROOT, 'tests/helpers/process-seam.cjs', 'const DEFAULT_TIMEOUT_MS = 60000;', 'const DEFAULT_TIMEOUT_MS = 90000;'), 'DEFAULT_TIMEOUT_MS', '60000', '90000');
});

test('re-export: a helper constant timeouts.cjs does not re-export gets the arm B note', () => {
  assertAdvisory(guardEdit(ROOT, 'tests/helpers/git-fixture.cjs', 'const LOCAL_GIT_HELPER_TIMEOUT_MS = 5000;', 'const LOCAL_GIT_HELPER_TIMEOUT_MS = 8000;'), 'LOCAL_GIT_HELPER_TIMEOUT_MS');
});

// ---------------------------------------------------------------- arm B (truths 8, 17-20)

test('arm B: a raised file-local constant whose comment block states no evidence gets a context note (no decision)', () => {
  assertAdvisory(guardEdit(ROOT, 'tests/foo.test.cjs', 'const BARE_TIMEOUT_MS = 4000;', 'const BARE_TIMEOUT_MS = 5000;'), 'BARE_TIMEOUT_MS', '4000', '5000', 'tests/foo.test.cjs', 'worst platform', 'margin', 'source');
});

test('arm B: a raise under a comment that states observed, margin and a platform is silent', () => {
  assertSilent(guardEdit(ROOT, 'tests/foo.test.cjs', 'const CLI_TIMEOUT_MS = 2000;', 'const CLI_TIMEOUT_MS = 2500;'));
});

test('arm B: a lowered value and an unchanged value are silent', () => {
  assertSilent(guardEdit(ROOT, 'tests/foo.test.cjs', 'const BARE_TIMEOUT_MS = 4000;', 'const BARE_TIMEOUT_MS = 3000;'));
  assertSilent(guardEdit(ROOT, 'tests/foo.test.cjs', 'const BARE_TIMEOUT_MS = 4000;', 'const BARE_TIMEOUT_MS = 4_000;'));
});

test('arm B: an indented new declaration in a test body is noted (any indentation)', () => {
  assertAdvisory(guardEdit(ROOT, 'tests/foo.test.cjs', '  const t = unrelated;', '  const t = unrelated;\n  const spawnTimeoutMs = 5000;'), 'spawnTimeoutMs', '5000');
});

test('arm B adjacency: a shared JSDoc block stating evidence covers a run of adjacent declarations', () => {
  const body = T([
    '/**',
    ' * Spawn bounds for the two CLI classes: worst observed 1200ms on darwin (p99 900ms of 40 spawns),',
    ' * margin 2.5x for both; local harness 2026-11-01.',
    ' */',
    'const A_TIMEOUT_MS = 3000;',
    'const B_TIMEOUT_MS = 3000;',
  ]);
  assertSilent(guardWrite(ROOT, 'tests/shared.test.cjs', body));
});

test('arm B adjacency: a blank line ends the comment block, so the declaration below it is noted', () => {
  assertAdvisory(guardWrite(ROOT, 'tests/blank.test.cjs', T(['// worst observed 1200ms on darwin, margin 2.5x; local harness.', '', 'const C_TIMEOUT_MS = 3000;'])), 'C_TIMEOUT_MS');
});

test('arm B exempt kinds: fixture data, test backstop and mirror are silent; a bare "fixture" is noted', () => {
  assertSilent(guardWrite(ROOT, 'tests/e1.test.cjs', T(['// Fixture data: the timeout field of a hook entry.', 'const HOOK_ENTRY_TIMEOUT = 5;'])));
  assertSilent(guardWrite(ROOT, 'tests/e2.test.cjs', T(['// Test backstop for a runaway parse.', 'const PARSE_TEST_TIMEOUT_MS = 60000;'])));
  assertSilent(guardWrite(ROOT, 'tests/e3.test.cjs', T(['// Mirror of process-seam DEFAULT_TIMEOUT_MS.', 'const SEAM_TIMEOUT_MS = 60000;'])));
  assertSilent(guardWrite(ROOT, 'tests/e4.test.cjs', T(['const TRAILING_TIMEOUT_MS = 5; // fixture-data inside a manifest'])));
  assertAdvisory(guardWrite(ROOT, 'tests/e5.test.cjs', T(['// spawn bound for the fixture repo', 'const FIXTURE_REPO_TIMEOUT_MS = 3000;'])), 'FIXTURE_REPO_TIMEOUT_MS');
});

test('arm B encoding: lower-case and camelCase names are timeout constants; evidence words match in any ASCII case', () => {
  assertAdvisory(guardWrite(ROOT, 'tests/c1.test.cjs', T(['const timeout = 3000;', '', 'const waitTimeoutMs = 3000;'])), 'timeout', 'waitTimeoutMs');
  assertSilent(guardWrite(ROOT, 'tests/c2.test.cjs', T(['// WORST OBSERVED 900MS ON WIN32, MARGIN 3X', 'const upperTimeoutMs = 3000;'])));
});

test('arm B ordering: two flagged constants are named in post-image line order, each with old and new value', () => {
  const r = guardWrite(ROOT, 'tests/o1.test.cjs', T(['const zTimeoutMs = 1000;', '', 'const aTimeoutMs = 2000;']));
  assertAdvisory(r, 'zTimeoutMs', 'aTimeoutMs');
  assert.ok(r.additionalContext.indexOf('zTimeoutMs') < r.additionalContext.indexOf('aTimeoutMs'), r.additionalContext);
});

test('arm B empty: an empty Write, a file with no timeout declaration and an edit that raises nothing are silent', () => {
  assertSilent(guardWrite(ROOT, 'tests/empty.test.cjs', ''));
  assertSilent(guardWrite(ROOT, 'tests/plain.test.cjs', T(['const a = 1;', 'const b = 2;'])));
  assertSilent(guardEdit(ROOT, 'tests/foo.test.cjs', "const test = require('node:test');", "const test = require('node:test'); // runner"));
});

test('arm B multiset (N-02): a name absent from the baseline rises; a value above every baseline value of the name rises', () => {
  const root = makeRoot({ 'tests/m.test.cjs': T(['function a() {', '  const timeoutMs = 1000;', '}', 'function b() {', '  const timeoutMs = 5000;', '}']) });
  assertAdvisory(guardEdit(root, 'tests/m.test.cjs', '  const timeoutMs = 5000;', '  const timeoutMs = 6000;'), 'timeoutMs', '5000', '6000');
});

test('arm B known miss (I2 N-03): raising the smaller of two same-name locals below the larger one is not noted', () => {
  const root = makeRoot({ 'tests/m.test.cjs': T(['function a() {', '  const timeoutMs = 1000;', '}', 'function b() {', '  const timeoutMs = 5000;', '}']) });
  assertSilent(guardEdit(root, 'tests/m.test.cjs', '  const timeoutMs = 1000;', '  const timeoutMs = 3000;'));
});

test('arm B: the Unicode-escape identifier is not matched (fail-open)', () => {
  assertSilent(guardWrite(ROOT, 'tests/u.test.cjs', T(['const \\u0074imeoutMs = 5000;'])));
});

test('arm B: JS-family extensions in any case are judged (.ts, .MTS); .json is not', () => {
  assertAdvisory(guardWrite(ROOT, 'tests/x.test.ts', T(['const tsTimeoutMs = 5000;'])), 'tsTimeoutMs');
  assertAdvisory(guardWrite(ROOT, 'tests/x.test.MTS', T(['const mtsTimeoutMs = 5000;'])), 'mtsTimeoutMs');
  assertSilent(guardWrite(ROOT, 'tests/x.json', T(['const jsonTimeoutMs = 5000;'])));
});

test('cost (T-261120-04): a 30000-line run of adjacent timeout declarations and a 60000-term right-hand side are judged in well under the 10 s hook timeout', { timeout: 8000 }, () => {
  const run = Array.from({ length: 30000 }, (_, i) => 'const t' + i + 'Timeout = 1;').join('\n') + '\n';
  const t0 = Date.now();
  const r = mod.judge({ rel: 'tests/p.test.cjs', baseline: '', post: run, timeoutsText: null });
  assertAdvisory(r, 't0Timeout', 't29999Timeout');
  const longRhs = 'const xTimeoutMs = ' + '1 + '.repeat(60000) + '1;\n';
  assertAdvisory(mod.judge({ rel: 'tests/p.test.cjs', baseline: '', post: longRhs, timeoutsText: null }), 'xTimeoutMs', '60001');
  assert.ok(Date.now() - t0 < 5000, 'judged in ' + (Date.now() - t0) + ' ms');
});

test('cost (T-261120-04): 90000 unclosed destructure lines, 6000 untagged measured exports and a 20000-edit MultiEdit stay well under the hook timeout', { timeout: 8000 }, () => {
  const t0 = Date.now();
  const destr = 'const x = `\n' + 'const { A\n'.repeat(90000) + '`;\n';
  assertSilent(mod.judge({ rel: TO, baseline: '', post: destr }));
  assertAdvisory(mod.judge({ rel: 'tests/helpers/git-fixture.cjs', baseline: '', post: 'const A_TIMEOUT_MS = 2;\n', timeoutsText: destr }), 'A_TIMEOUT_MS');
  const N = 6000;
  let body = '';
  for (let i = 0; i < N; i++) body += 'const C' + i + '_MS = 20;\n';
  body += 'const TIMEOUT_EVIDENCE = Object.freeze({\n';
  for (let i = 0; i < N; i++) body += '  C' + i + "_MS: { kind: 'measured', observedMaxMs: 10 },\n";
  body += '});\nmodule.exports = {\n';
  for (let i = 0; i < N; i++) body += '  C' + i + '_MS,\n';
  body += '};\n';
  assertDeny(mod.judge({ rel: TO, baseline: '', post: body }), 'C0_MS', 'and 5975 more');
  const img = Array.from({ length: 20000 }, (_, i) => 'const v' + i + ' = 1;').join('\n') + '\n';
  const edits = Array.from({ length: 20000 }, (_, i) => ({ old_string: 'const v' + i + ' = 1;', new_string: 'const v' + i + ' = 2;' }));
  assert.strictEqual(mod.applyEdits(img, edits), null, 'a MultiEdit over the edit cap is a silent pass');
  assert.ok(Date.now() - t0 < 5000, 'judged in ' + (Date.now() - t0) + ' ms');
});

test('applyEdits: a MultiEdit at the edit cap is applied; one edit more is a silent pass', () => {
  const cap = mod.MAX_EDITS;
  assert.ok(Number.isInteger(cap) && cap >= 50, 'MAX_EDITS is exported: ' + cap);
  const img = Array.from({ length: cap + 1 }, (_, i) => 'v' + i + ';').join('\n');
  const edits = (n) => Array.from({ length: n }, (_, i) => ({ old_string: 'v' + i + ';', new_string: 'w' + i + ';' }));
  assert.ok(mod.applyEdits(img, edits(cap)).startsWith('w0;'));
  assert.strictEqual(mod.applyEdits(img, edits(cap + 1)), null);
});

test('A2 (`//` run): the margin on the run\'s second line is read; a margin after the run ends is not', () => {
  const asRun = (tail) => sub(
    TIMEOUTS,
    '/**\n * A short CLI probe.\n *\n * Evidence (TIMEOUT_EVIDENCE.PROBE_TIMEOUT_MS): worst observed 7424ms on darwin (p50 111ms, p99 3411ms of recorded spawns),\n * margin 2.02x; CI seam spawn-stall records, 196 runs.\n */\n' + PROBE_DECL,
    '// A short CLI probe.\n// Evidence (TIMEOUT_EVIDENCE.PROBE_TIMEOUT_MS): worst observed 7424ms on darwin (p50 111ms, p99 3411ms),\n' + tail + 'const PROBE_TIMEOUT_MS = 30000;'
  );
  assertSilent(guardWrite(ROOT, TO, asRun('// margin 4.04x; CI seam spawn-stall records, 196 runs.\n')));
  assertDeny(guardWrite(ROOT, TO, asRun('// CI seam spawn-stall records, 196 runs.\n\n// margin 4.04x\n')), 'PROBE_TIMEOUT_MS', 'margin 4.04x');
});

// ---------------------------------------------------------------- creation, deletion, CRLF (truths 10, 11, 15)

test('creation: an Edit with an empty old_string on a missing, empty or whitespace-only target is a creation', () => {
  const root = makeRoot({ 'tests/empty.test.cjs': '', 'tests/ws.test.cjs': '  \n\n' });
  for (const rel of ['tests/missing.test.cjs', 'tests/empty.test.cjs', 'tests/ws.test.cjs']) {
    assertAdvisory(guardEdit(root, rel, '', 'const createdTimeoutMs = 5000;\n'), 'createdTimeoutMs');
  }
  assertSilent(guardEdit(root, 'tests/foo.test.cjs', '', 'const createdTimeoutMs = 5000;\n'), 'an empty old_string on a non-empty file fails in the tool');
});

test('creation: a Write into a new tests subdirectory resolves against the nearest existing ancestor', () => {
  assertAdvisory(guardWrite(ROOT, 'tests/newdir/deeper/a.test.cjs', T(['const newDirTimeoutMs = 5000;'])), 'newDirTimeoutMs');
});

test('deletion (N-03): a MultiEdit deleting the line between a comment and a declaration removes its newline too', () => {
  assertSilent(guardMulti(ROOT, 'tests/foo.test.cjs', [
    { old_string: 'const unrelated = 1;', new_string: '' },
    { old_string: 'const BARE_TIMEOUT_MS = 4000;', new_string: 'const BARE_TIMEOUT_MS = 5000;' },
  ]));
  // control: without the deletion, the code line above the declaration means no comment block, so it is noted
  assertAdvisory(guardMulti(ROOT, 'tests/foo.test.cjs', [
    { old_string: 'const BARE_TIMEOUT_MS = 4000;', new_string: 'const BARE_TIMEOUT_MS = 5000;' },
  ]), 'BARE_TIMEOUT_MS');
});

test('applyEdits: split/join (a $& or $1 in new_string is literal), replace_all, the deletion newline and the failure cases', () => {
  assert.strictEqual(mod.applyEdits('a X b', [{ old_string: 'X', new_string: '$&$1' }]), 'a $&$1 b');
  assert.strictEqual(mod.applyEdits('X X', [{ old_string: 'X', new_string: 'Y', replace_all: true }]), 'Y Y');
  assert.strictEqual(mod.applyEdits('X X', [{ old_string: 'X', new_string: 'Y' }]), null, 'not unique without replace_all');
  assert.strictEqual(mod.applyEdits('a b', [{ old_string: 'X', new_string: 'Y' }]), null, 'absent');
  assert.strictEqual(mod.applyEdits('l1\nl2\nl3\n', [{ old_string: 'l2', new_string: '' }]), 'l1\nl3\n');
  assert.strictEqual(mod.applyEdits('l1\r\nl2\r\n', [{ old_string: 'l1\r\n', new_string: 'L1\r\n' }]), 'L1\nl2\n', 'CRLF normalised');
  assert.strictEqual(mod.applyEdits('', [{ old_string: '', new_string: 'new' }]), 'new');
  assert.strictEqual(mod.applyEdits('x', [{ old_string: '', new_string: 'new' }]), null);
  assert.strictEqual(mod.applyEdits('a', [{ old_string: 'a', new_string: 'b' }, { old_string: 'b', new_string: 'c' }]), 'c', 'MultiEdit runs on the running image');
});

test('replace_all: every occurrence is applied; without it a non-unique old_string is a silent pass', () => {
  const root = makeRoot({ 'tests/ra.test.cjs': T(['const aTimeoutMs = 1000;', '', 'const bTimeoutMs = 1000;']) });
  const r = guardEdit(root, 'tests/ra.test.cjs', '1000', '9000', { replace_all: true });
  assertAdvisory(r, 'aTimeoutMs', 'bTimeoutMs');
  assertSilent(guardEdit(root, 'tests/ra.test.cjs', '1000', '9000'));
});

test('CRLF: a CRLF timeouts.cjs parses like LF; an LF Edit on it counts after normalising (Q-01)', () => {
  const root = makeRoot({ [TO]: TIMEOUTS.replace(/\n/g, '\r\n') });
  assertDeny(guardEdit(root, TO, PROBE_DECL, 'const PROBE_TIMEOUT_MS = 30000;'), 'PROBE_TIMEOUT_MS');
  assertDeny(guardEdit(root, TO, ' */\r\n' + PROBE_DECL, ' */\r\nconst PROBE_TIMEOUT_MS = 30000;'), 'PROBE_TIMEOUT_MS');
  assertSilent(guardWrite(root, TO, COMPLIANT_6143.replace(/\n/g, '\r\n')));
  assertDeny(guardWrite(root, TO, STALE_6143.replace(/\n/g, '\r\n')), 'GSD_TOOLS_CLI_MODERATE_TIMEOUT_MS');
});

test('CRLF: an arm B Edit on a CRLF test file is judged', () => {
  const root = makeRoot({ 'tests/foo.test.cjs': FOO_TEST.replace(/\n/g, '\r\n') });
  assertAdvisory(guardEdit(root, 'tests/foo.test.cjs', 'const BARE_TIMEOUT_MS = 4000;', 'const BARE_TIMEOUT_MS = 5000;'), 'BARE_TIMEOUT_MS');
});

// ---------------------------------------------------------------- scope and silent paths (truth 9)

test('silent: tools other than Write, Edit and MultiEdit, even naming timeouts.cjs', () => {
  for (const tool of ['Read', 'Bash', 'NotebookEdit', 'Grep']) {
    assertSilent(runEditGuard(payload(tool, path.join(ROOT, TO), { content: STALE_6143, command: 'x' })));
  }
});

test('silent: a target outside <root>/tests/ (src/, a tests-like sibling) and a root with no gsd-core sentinel', () => {
  assertSilent(guardWrite(ROOT, 'src/x.cjs', T(['const xTimeoutMs = 9000;'])));
  assertSilent(guardWrite(ROOT, 'tests2/a.test.cjs', T(['const xTimeoutMs = 9000;'])));
  const noroot = path.join(BASE, 'noroot');
  write(noroot, 'tests/helpers/timeouts.cjs', TIMEOUTS);
  assertSilent(guardWrite(noroot, TO, STALE_6143));
});

test('silent: a missing target on an Edit whose old_string is not empty; an absent or non-unique old_string', () => {
  assertSilent(guardEdit(ROOT, 'tests/nope.test.cjs', 'x', 'const nopeTimeoutMs = 5000;'));
  assertSilent(guardEdit(ROOT, TO, 'NOT IN THE FILE', 'const PROBE_TIMEOUT_MS = 30000;'));
  assertSilent(guardEdit(ROOT, TO, 'const ', 'const PROBE_TIMEOUT_MS = 30000; const '));
});

test('silent: content, new_string or a target over 1 MiB', () => {
  const big = 'x'.repeat(1024 * 1024 + 1);
  assertSilent(guardWrite(ROOT, 'tests/big.test.cjs', 'const bigTimeoutMs = 5000;\n//' + big));
  assertSilent(guardEdit(ROOT, 'tests/foo.test.cjs', 'const BARE_TIMEOUT_MS = 4000;', 'const BARE_TIMEOUT_MS = 5000;\n//' + big));
  const root = makeRoot({ 'tests/huge.test.cjs': 'const hugeTimeoutMs = 1;\n//' + big + '\n' });
  assertSilent(guardEdit(root, 'tests/huge.test.cjs', 'const hugeTimeoutMs = 1;', 'const hugeTimeoutMs = 5000;'));
});

test('silent: malformed payloads', () => {
  const stdins = [
    '', 'null', '[]', '{', 'not json', '42',
    JSON.stringify({ tool_name: 'Write' }),
    JSON.stringify({ tool_name: 'Write', tool_input: { file_path: 7, content: 'x' } }),
    JSON.stringify({ tool_name: 'Write', tool_input: { file_path: '', content: 'x' } }),
    JSON.stringify({ tool_name: 'Write', tool_input: { file_path: path.join(ROOT, TO), content: 7 } }),
    JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: path.join(ROOT, TO), old_string: 7, new_string: 'x' } }),
    JSON.stringify({ tool_name: 'MultiEdit', tool_input: { file_path: path.join(ROOT, TO), edits: 'x' } }),
    JSON.stringify({ tool_name: 'MultiEdit', tool_input: { file_path: path.join(ROOT, TO), edits: [] } }),
    JSON.stringify({ tool_name: 'MultiEdit', tool_input: { file_path: path.join(ROOT, TO), edits: [null] } }),
  ];
  for (const s of stdins) assertSilent(runEditGuard(s));
});

test('relative file_path resolves against the payload cwd', () => {
  assertDeny(runEditGuard(payload('Write', TO, { content: STALE_6143 }, ROOT)), 'GSD_TOOLS_CLI_MODERATE_TIMEOUT_MS');
});

test('symlink: a link outside the checkout naming timeouts.cjs is judged by its real path', () => {
  const outside = path.join(BASE, 'outside');
  fs.mkdirSync(outside, { recursive: true });
  const link = path.join(outside, 'link-timeouts.cjs');
  fs.symlinkSync(path.join(ROOT, TO), link);
  assertDeny(runEditGuard(payload('Edit', link, { old_string: MOD_VALUE_OLD, new_string: MOD_VALUE_NEW })), 'GSD_TOOLS_CLI_MODERATE_TIMEOUT_MS');
});

test('runEditGuard output discipline: a throw, an allow, an ask and an advisory that carries a decision are all null', () => {
  const stdin = payload('Write', path.join(ROOT, TO), { content: STALE_6143 });
  assertSilent(runEditGuard(stdin, { gateImpl: () => { throw new Error('boom'); } }));
  assertSilent(runEditGuard(stdin, { gateImpl: () => ({ permissionDecision: 'allow', permissionDecisionReason: 'x' }) }));
  assertSilent(runEditGuard(stdin, { gateImpl: () => ({ permissionDecision: 'ask', permissionDecisionReason: 'x' }) }));
  assertSilent(runEditGuard(stdin, { gateImpl: () => ({ permissionDecision: 'deny', permissionDecisionReason: '' }) }));
  assertSilent(runEditGuard(stdin, { gateImpl: () => ({ additionalContext: 'x', permissionDecision: 'allow' }) }));
  assertSilent(runEditGuard(stdin, { gateImpl: () => ({ additionalContext: '' }) }));
  assertDeny(runEditGuard(stdin, { gateImpl: () => ({ permissionDecision: 'deny', permissionDecisionReason: 'r' }) }), 'r');
  assertAdvisory(runEditGuard(stdin, { gateImpl: () => ({ additionalContext: 'note' }) }), 'note');
});

function verdictLines() {
  try {
    return fs.readFileSync(path.join(LOG_DIR, 'tool-log.jsonl'), 'utf8').split('\n').filter((l) => l.includes('"timeout-evidence-edit"')).length;
  } catch (_) {
    return 0;
  }
}

test('idempotency: the same deny payload twice gives identical output and appends one verdict line per deny', () => {
  const stdin = payload('Write', path.join(ROOT, TO), { content: STALE_6143 });
  const before = verdictLines();
  const a = runEditGuard(stdin);
  const b = runEditGuard(stdin);
  assertDeny(a, 'GSD_TOOLS_CLI_MODERATE_TIMEOUT_MS');
  assert.deepStrictEqual(a, b);
  assert.strictEqual(verdictLines() - before, 2);
  const c = guardEdit(ROOT, 'tests/foo.test.cjs', 'const BARE_TIMEOUT_MS = 4000;', 'const BARE_TIMEOUT_MS = 5000;');
  assertAdvisory(c, 'BARE_TIMEOUT_MS');
  assert.strictEqual(verdictLines() - before, 2, 'an advisory writes no verdict line');
});

// ---------------------------------------------------------------- spawned entrypoint

function spawnHook(stdin) {
  const env = Object.assign({}, process.env, { GSD_CONTRIB_NO_VERDICT_LOG: '1' });
  return spawnSync(process.execPath, [HOOK], { input: stdin, env, encoding: 'utf8', timeout: 15000 });
}

test('spawned: a deny envelope for the stale #6143 Write', () => {
  const r = spawnHook(payload('Write', path.join(ROOT, TO), { content: STALE_6143 }));
  assert.strictEqual(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.strictEqual(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.strictEqual(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.ok(out.hookSpecificOutput.permissionDecisionReason.includes('GSD_TOOLS_CLI_MODERATE_TIMEOUT_MS'));
});

test('spawned: an advisory envelope has additionalContext and NO permissionDecision key', () => {
  const r = spawnHook(payload('Edit', path.join(ROOT, 'tests/foo.test.cjs'), { old_string: 'const BARE_TIMEOUT_MS = 4000;', new_string: 'const BARE_TIMEOUT_MS = 5000;' }));
  assert.strictEqual(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.strictEqual(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.ok(!('permissionDecision' in out.hookSpecificOutput), JSON.stringify(out));
  assert.ok(out.hookSpecificOutput.additionalContext.includes('BARE_TIMEOUT_MS'));
});

test('spawned: a silent pass and garbage stdin are exit 0 with empty stdout', () => {
  for (const stdin of [payload('Read', path.join(ROOT, TO), {}), 'garbage', payload('Write', path.join(ROOT, TO), { content: COMPLIANT_6143 })]) {
    const r = spawnHook(stdin);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.stdout, '');
  }
});

test('spawned: a FIFO and a directory target pass within the spawn timeout (REVIEW-R4 WR-02)', (t) => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, 'tests', 'dir.test.cjs'));
  const mk = spawnSync('mkfifo', [path.join(root, 'tests', 'pipe.test.cjs')]);
  for (const rel of ['tests/dir.test.cjs'].concat(mk.status === 0 ? ['tests/pipe.test.cjs'] : [])) {
    const r = spawnHook(payload('Edit', path.join(root, rel), { old_string: 'a', new_string: 'const fifoTimeoutMs = 5000;' }));
    assert.strictEqual(r.status, 0, rel + ': ' + (r.error ? r.error.message : r.stderr));
    assert.strictEqual(r.stdout, '', rel);
  }
  if (mk.status !== 0) t.diagnostic('mkfifo unavailable; the FIFO case did not run');
});

// ---------------------------------------------------------------- live rows (read-only gsd-core clone)

const CLONE = path.join(os.homedir(), 'repos', 'gsd-core');
const NO_CLONE = 'no gsd-core clone at ~/repos/gsd-core (the live rows read it with git show only)';

function gitShow(rev) {
  const r = spawnSync('git', ['-C', CLONE, 'show', rev], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}
function gitLines(args) {
  const r = spawnSync('git', ['-C', CLONE].concat(args), { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim().split('\n').filter(Boolean) : null;
}
function liveTest(name, refs, fn) {
  return test(name, (t) => {
    if (!fs.existsSync(path.join(CLONE, '.git'))) return t.skip(NO_CLONE);
    for (const ref of refs) {
      if (gitShow(ref) === null) return t.skip('the clone has no object ' + ref);
    }
    return fn(t);
  });
}

liveTest('live #6143: baseline 28c1f91d1^, the Write of 28c1f91d1 passes; with the comment hunk reverted it denies',
  ['28c1f91d1^:tests/helpers/timeouts.cjs', '28c1f91d1:tests/helpers/timeouts.cjs'], () => {
    const before = gitShow('28c1f91d1^:tests/helpers/timeouts.cjs');
    const after = gitShow('28c1f91d1:tests/helpers/timeouts.cjs');
    assert.ok(before.includes('const GSD_TOOLS_CLI_MODERATE_TIMEOUT_MS = 30000;'), 'premise: the baseline holds 30000');
    assert.ok(after.includes('const GSD_TOOLS_CLI_MODERATE_TIMEOUT_MS = 32000;'), 'premise: the change raises to 32000');
    const root = makeRoot({ [TO]: before });
    assertSilent(guardWrite(root, TO, after));
    const neg = after.replace(
      'worst observed 15020ms on win32 (p50 2270ms, p99 15020ms of recorded spawns),\n * margin 2.13x',
      'worst observed 2270ms on win32 (p50 2036ms, p99 2270ms of recorded spawns),\n * margin 13.21x'
    );
    assert.notStrictEqual(neg, after, 'premise: the comment hunk was reverted');
    assertDeny(guardWrite(root, TO, neg), 'GSD_TOOLS_CLI_MODERATE_TIMEOUT_MS');
  });

liveTest('live replay: every timeouts.cjs snapshot since bfc114849, written as new, gives 0 denies (and its git-fixture.cjs)',
  ['bfc114849:tests/helpers/timeouts.cjs'], () => {
    const shas = gitLines(['log', '--format=%H', 'bfc114849^..origin/next', '--', 'tests/helpers/timeouts.cjs']);
    assert.ok(shas && shas.length >= 4, 'premise: at least 4 snapshots, got ' + JSON.stringify(shas));
    for (const sha of shas) {
      const text = gitShow(sha + ':tests/helpers/timeouts.cjs');
      const root = makeRoot({ [TO]: null, 'tests/helpers/git-fixture.cjs': null });
      assertSilent(guardWrite(root, TO, text));
      const gf = gitShow(sha + ':tests/helpers/git-fixture.cjs');
      if (gf !== null) {
        write(root, TO, text);
        assertSilent(guardWrite(root, 'tests/helpers/git-fixture.cjs', gf));
      }
    }
  });

liveTest('live current format (W-08): origin/next timeouts.cjs parses fully and treating each constant as new gives 0 denies',
  ['origin/next:tests/helpers/timeouts.cjs', 'origin/next:tests/helpers/git-fixture.cjs'], () => {
    const text = gitShow('origin/next:tests/helpers/timeouts.cjs');
    const parsed = mod.parseTimeoutsModule(text);
    assert.ok(parsed && parsed.exports && parsed.exports.size > 10, 'module.exports object found');
    assert.strictEqual(parsed.readable, true, 'the TIMEOUT_EVIDENCE literal is readable');
    let numeric = 0;
    for (const [name, decl] of parsed.decls) {
      if (decl.value === null || !parsed.exports.has(name)) continue;
      numeric++;
      assert.ok(parsed.entries.has(name), 'an entry for ' + name);
      if (parsed.entries.get(name).kind === 'measured') assert.ok(parsed.tags.has(name), 'an Evidence tag for ' + name);
    }
    assert.ok(numeric >= 14, 'premise: at least 14 exported numeric constants, got ' + numeric);
    for (const name of ['GIT_TIMEOUT_MS', 'GIT_FIXTURE_TIMEOUT_MS']) assert.ok(parsed.tags.has(name), 'tag ' + name);
    const gfMap = parsed.reexports.get('./git-fixture.cjs');
    assert.deepStrictEqual(gfMap.get('DEFAULT_GIT_TIMEOUT_MS'), ['GIT_TIMEOUT_MS']);
    assert.deepStrictEqual(gfMap.get('GIT_FIXTURE_TIMEOUT_MS'), ['GIT_FIXTURE_TIMEOUT_MS']);
    assertSilent(mod.judge({ rel: TO, baseline: '', post: text, timeoutsText: text }));
    const gf = gitShow('origin/next:tests/helpers/git-fixture.cjs');
    assertSilent(mod.judge({ rel: 'tests/helpers/git-fixture.cjs', baseline: '', post: gf, timeoutsText: text }));
    // control: the same module with PROBE_TIMEOUT_MS doubled and its comment untouched denies
    assert.ok(text.includes('const PROBE_TIMEOUT_MS = 15000;'), 'premise: PROBE_TIMEOUT_MS is 15000 at origin/next');
    const r = mod.judge({ rel: TO, baseline: text, post: text.replace('const PROBE_TIMEOUT_MS = 15000;', 'const PROBE_TIMEOUT_MS = 30000;'), timeoutsText: text });
    assertDeny(r, 'PROBE_TIMEOUT_MS');
  });
