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
    () => rs.writeStamp(stamp, {
      stampPath: path.join(REAL_HOME, '.gsd-contrib', 'runtime-stamp.json'),
      writeFileSync: w.fn,
      mkdirSync: m.fn,
    }),
    /test fence/
  );
  assert.strictEqual(w.calls.length, 0, 'no write may be attempted');
  assert.strictEqual(m.calls.length, 0, 'no mkdir may be attempted');
});

test('po0: writeStamp refuses a path inside the real ~/.claude under node --test', () => {
  const w = spy();
  const stamp = rs.buildStamp({ sha: SHA, runtimeDigest: DIGEST, mode: 'installed', engineVerified: true });
  assert.throws(
    () => rs.writeStamp(stamp, { stampPath: path.join(REAL_HOME, '.claude', 'x', 'runtime-stamp.json'), writeFileSync: w.fn, mkdirSync: () => {} }),
    /test fence/
  );
  assert.strictEqual(w.calls.length, 0);
});

test('po0: writeCacheLive never writes the real ~/.gsd-contrib cache under node --test', () => {
  const w = spy();
  const m = spy();
  rs.writeCacheLive({ tip: SHA, fetched_at: new Date().toISOString() }, {
    cachePath: path.join(REAL_HOME, '.gsd-contrib', 'upstream-tip-cache.json'),
    writeFileSync: w.fn,
    mkdirSync: m.fn,
  });
  assert.strictEqual(w.calls.length, 0, 'the cache write must be fenced');
  assert.strictEqual(m.calls.length, 0, 'the cache mkdir must be fenced');
});

test('po0: tool-recorder appendRecord never writes the real ~/.gsd-contrib tool log under node --test', () => {
  const calls = [];
  const fsImpl = new Proxy({}, { get: (_, k) => (...a) => { calls.push(k); throw new Error('spy ' + String(k)); } });
  const env = Object.assign({}, process.env);
  delete env.GSD_CONTRIB_LOG_DIR;
  env.HOME = REAL_HOME;
  let out;
  try {
    out = recorder.appendRecord('{"x":1}', { env, fsImpl });
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
