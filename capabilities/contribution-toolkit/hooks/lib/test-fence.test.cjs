'use strict';

/**
 * hooks/lib/test-fence.test.cjs - the suite-wide guard against a test writing the REAL user state
 * (quick 261024-po0, coordinator request after the incident in which a red test overwrote the real
 * ~/.gsd-contrib/runtime-stamp.json with fixture values).
 *
 * Under `node --test` (NODE_TEST_CONTEXT is set in every test-file process and inherited by a child
 * spawned with process.env), the toolkit's user-state writers refuse any path at or inside the REAL
 * home's .gsd-contrib or .claude. The real home is os.userInfo().homedir, which a test cannot move by
 * setting HOME. Every case below passes a SPY writer, so a red run against an unfenced module records
 * a call instead of touching a real file.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');

const rs = require('./runtime-stamp.cjs');
const recorder = require('../tool-recorder.cjs');

const REAL_HOME = os.userInfo().homedir;
const SHA = 'a'.repeat(40);
const DIGEST = 'sha256:' + 'f'.repeat(64);

// The cases below trigger the fence on purpose; mark them expected so it does not fail this file.
function expected(fn) {
  process.env.GSD_CONTRIB_TEST_FENCE_EXPECTED = '1';
  try {
    return fn();
  } finally {
    delete process.env.GSD_CONTRIB_TEST_FENCE_EXPECTED;
  }
}

function spy() {
  const calls = [];
  const fn = (...args) => { calls.push(args); };
  return { calls, fn };
}

test('po0 fence: node --test sets NODE_TEST_CONTEXT, so the fence is armed in this process', () => {
  assert.ok(process.env.NODE_TEST_CONTEXT, 'run this file with node --test');
});

test('po0: writeStamp refuses the real ~/.gsd-contrib stamp path under node --test, before any write', () => {
  const w = spy();
  const m = spy();
  const stamp = rs.buildStamp({ sha: SHA, runtimeDigest: DIGEST, mode: 'installed', engineVerified: true });
  assert.throws(
    () => expected(() => rs.writeStamp(stamp, {
      stampPath: path.join(REAL_HOME, '.gsd-contrib', 'runtime-stamp.json'),
      writeFileSync: w.fn,
      mkdirSync: m.fn,
    })),
    /test fence/
  );
  assert.strictEqual(w.calls.length, 0, 'no write may be attempted');
  assert.strictEqual(m.calls.length, 0, 'no mkdir may be attempted');
});

test('po0: writeStamp refuses a path inside the real ~/.claude under node --test', () => {
  const w = spy();
  const stamp = rs.buildStamp({ sha: SHA, runtimeDigest: DIGEST, mode: 'installed', engineVerified: true });
  assert.throws(
    () => expected(() => rs.writeStamp(stamp, { stampPath: path.join(REAL_HOME, '.claude', 'x', 'runtime-stamp.json'), writeFileSync: w.fn, mkdirSync: () => {} })),
    /test fence/
  );
  assert.strictEqual(w.calls.length, 0);
});

test('po0: writeCacheLive never writes the real ~/.gsd-contrib cache under node --test', () => {
  const w = spy();
  const m = spy();
  expected(() => rs.writeCacheLive({ tip: SHA, fetched_at: new Date().toISOString() }, {
    cachePath: path.join(REAL_HOME, '.gsd-contrib', 'upstream-tip-cache.json'),
    writeFileSync: w.fn,
    mkdirSync: m.fn,
  }));
  assert.strictEqual(w.calls.length, 0, 'the cache write must be fenced');
  assert.strictEqual(m.calls.length, 0, 'the cache mkdir must be fenced');
});

test('po0: tool-recorder appendRecord never writes the real ~/.gsd-contrib tool log under node --test', () => {
  const calls = [];
  const fsImpl = new Proxy({}, { get: (_, k) => (...a) => { calls.push(k); throw new Error('spy ' + String(k)); } });
  // The real log dir is named through GSD_CONTRIB_LOG_DIR, not HOME: the default resolves through
  // os.homedir() (the PROCESS HOME), so a HOME in this env would not reach it under a temp HOME (WR-05).
  const env = Object.assign({}, process.env, { GSD_CONTRIB_LOG_DIR: path.join(REAL_HOME, '.gsd-contrib') });
  let out;
  try {
    out = expected(() => recorder.appendRecord('{"x":1}', { env, fsImpl }));
  } catch (err) {
    assert.match(String(err && err.message), /test fence/);
  }
  assert.ok(out === undefined || out === null, 'nothing may be written');
  assert.deepStrictEqual(calls, [], 'no fs call may reach the real log dir; got ' + calls.join(','));
});

test('po0 guard: the fence leaves a temp path alone', (t) => {
  const fs = require('node:fs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'po0-fence-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stamp = rs.buildStamp({ sha: SHA, runtimeDigest: DIGEST, mode: 'installed', engineVerified: true });
  const file = rs.writeStamp(stamp, { stampPath: path.join(dir, 'runtime-stamp.json') });
  assert.ok(fs.existsSync(file));
});

test('po0 fence: an UNEXPECTED fire fails the test file even when the caller swallows the throw', (t) => {
  // A child test file leaks the way the 15 gate test files did (the tool recorder, no
  // GSD_CONTRIB_LOG_DIR, the real home) but with a spy fs, so even a broken fence writes nothing.
  const fs = require('node:fs');
  const { spawnSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'po0-fence-child-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const child = path.join(dir, 'leak.test.cjs');
  fs.writeFileSync(child,
    "'use strict';\n" +
    "const { test } = require('node:test');\n" +
    "const recorder = require(" + JSON.stringify(require.resolve('../tool-recorder.cjs')) + ");\n" +
    "test('leaks but swallows', () => {\n" +
    "  const fsImpl = new Proxy({}, { get: () => () => { throw new Error('spy'); } });\n" +
    "  const env = Object.assign({}, process.env, { GSD_CONTRIB_LOG_DIR: " + JSON.stringify(path.join(REAL_HOME, '.gsd-contrib')) + " });\n" +
    "  try { recorder.appendRecord('{}', { env, fsImpl }); } catch (_) { /* swallowed, like a gate */ }\n" +
    "});\n");
  const env = Object.assign({}, process.env);
  delete env.GSD_CONTRIB_LOG_DIR;
  delete env.GSD_CONTRIB_TEST_FENCE_EXPECTED;
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, ['--test', child], { env, encoding: 'utf8', timeout: 60000 });
  const out = (r.stdout || '') + (r.stderr || '');
  assert.notStrictEqual(r.status, 0, 'the leaking child test file must fail; output:\n' + out);
  assert.match(out, /GSD-CONTRIB-TEST-FENCE: 1 unexpected write/, out);
});

// Review WR-06: `node --test --test-isolation=none` runs every file in the runner process and leaves
// NODE_TEST_CONTEXT unset; the fence must still hold there. The child uses spy writers, so even an
// unarmed fence writes nothing.
test('po0 r2: the fence holds under node --test --test-isolation=none (no NODE_TEST_CONTEXT)', (t) => {
  const fs = require('node:fs');
  const { spawnSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'po0-fence-iso-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const child = path.join(dir, 'iso.test.cjs');
  fs.writeFileSync(child,
    "'use strict';\n" +
    "const { test } = require('node:test');\n" +
    "const assert = require('node:assert');\n" +
    "const rs = require(" + JSON.stringify(require.resolve('./runtime-stamp.cjs')) + ");\n" +
    "test('fenced in-process', () => {\n" +
    "  assert.ok(!process.env.NODE_TEST_CONTEXT, 'isolation=none leaves NODE_TEST_CONTEXT unset');\n" +
    "  const calls = [];\n" +
    "  const stamp = rs.buildStamp({ sha: 'a'.repeat(40), runtimeDigest: 'sha256:' + 'f'.repeat(64), mode: 'installed', engineVerified: true });\n" +
    "  process.env.GSD_CONTRIB_TEST_FENCE_EXPECTED = '1';\n" +
    "  try {\n" +
    "    assert.throws(() => rs.writeStamp(stamp, { stampPath: " + JSON.stringify(path.join(REAL_HOME, '.gsd-contrib', 'runtime-stamp.json')) + ",\n" +
    "      writeFileSync: (...a) => calls.push(a), mkdirSync: (...a) => calls.push(a), renameSync: (...a) => calls.push(a) }), /test fence/);\n" +
    "  } finally { delete process.env.GSD_CONTRIB_TEST_FENCE_EXPECTED; }\n" +
    "  assert.strictEqual(calls.length, 0);\n" +
    "});\n");
  const env = Object.assign({}, process.env);
  delete env.NODE_TEST_CONTEXT;
  delete env.GSD_CONTRIB_TEST_FENCE_EXPECTED;
  const r = spawnSync(process.execPath, ['--test', '--test-isolation=none', child], { env, encoding: 'utf8', timeout: 60000 });
  const out = (r.stdout || '') + (r.stderr || '');
  assert.strictEqual(r.status, 0, 'the fence must fire in-process under isolation=none; output:\n' + out);
});
