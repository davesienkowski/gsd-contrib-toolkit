'use strict';

/**
 * node:test for the tool-log WRITER against a hostile live slot (quick 261006-jox).
 *
 * `appendRecord` in hooks/tool-recorder.cjs is the single writer of
 * `$GSD_CONTRIB_LOG_DIR/tool-log.jsonl`. Every gate reaches it through
 * hooks/lib/verdict-log.cjs recordVerdict (OBS-02) after its decision is computed, and the recorder
 * hook reaches it directly (OBS-01). A FIFO planted at the slot used to block that open forever, so
 * the gate never emitted its verdict and the harness treated the timed-out hook as allow.
 *
 * These tests use REAL filesystem objects: a mkfifo FIFO (with and without a reader), a symlink to
 * a FIFO, a symlink to /dev/zero, a directory, and a symlink to a regular file. Every case that can
 * block pre-fix runs in a SPAWNED child under a wall-clock bound, because node:test cannot interrupt
 * a synchronous block in its own process. Rotation is pinned with sparse files at the real
 * MAX_LOG_BYTES boundary and read back through hooks/lib/tool-log-reader.cjs.
 *
 * Every test makes its own mkdtemp log dir under os.tmpdir() and removes it in a finally; nothing
 * here touches ~/.gsd-contrib. Lives in hooks/ (not hooks/lib/) so the capability bundle does not
 * copy it.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const {
  appendRecord,
  recordToolCall,
  serializeRecord,
  LOG_FILENAME,
  ROTATED_FILENAME,
  MAX_LOG_BYTES,
} = require('./tool-recorder.cjs');
const { readSessionRecords } = require('./lib/tool-log-reader.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const RECORDER_PATH = path.join(__dirname, 'tool-recorder.cjs');
const GATE_PATH = path.join(__dirname, 'gh-issue-create.cjs');

/** The harness wires gates with a 30 s timeout; 5 s is far inside it and far above a healthy run of well under 1 s. */
const BOUND_MS = 5000;
/** spawnSync kills a hung child with SIGKILL here, so a pre-fix hang fails the bound instead of hanging the test run. */
const KILL_MS = 6000;

const ONE_MIB = 1024 * 1024;

/** True when this platform has named pipes and `mkfifo` (mirrors hooks/review-artifact.test.cjs). */
function hasMkfifo() {
  if (process.platform === 'win32') return false;
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'jox-fifo-probe-'));
  try {
    execFileSync('mkfifo', [path.join(d, 'p')], { stdio: 'ignore' });
    return true;
  } catch (_) {
    return false;
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
}

const NO_FIFO = !hasMkfifo() && 'no mkfifo on this platform';
const NO_DEVZERO = (process.platform === 'win32' || !fs.existsSync('/dev/zero')) && 'no /dev/zero on this platform';

/** A fresh, private log dir under os.tmpdir(). Never ~/.gsd-contrib. */
function freshDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmAll(dirs) {
  for (const d of dirs) {
    if (d) fs.rmSync(d, { recursive: true, force: true });
  }
}

function mkfifo(p) {
  execFileSync('mkfifo', [p]);
}

/**
 * Child env: the real env with the log dir pointed at `logDir`, and every kill switch or valve an
 * outer shell might carry removed, so an inherited switch cannot make a red test pass vacuously.
 */
function childEnv(logDir) {
  const env = Object.assign({}, process.env, { GSD_CONTRIB_LOG_DIR: logDir });
  delete env.GSD_CONTRIB_NO_VERDICT_LOG;
  delete env.GSD_CONTRIB_RECORD;
  delete env.GSD_CONTRIB_OVERRIDE;
  return env;
}

/** Spawn node with `args` under the KILL_MS bound and measure integer wall-clock ms around it. */
function runBounded(args, input, env) {
  const t0 = Date.now();
  const res = spawnSync(process.execPath, args, {
    input,
    encoding: 'utf8',
    env,
    cwd: REPO_ROOT,
    timeout: KILL_MS,
    killSignal: 'SIGKILL',
  });
  const elapsed = Date.now() - t0;
  return {
    status: res.status,
    signal: res.signal,
    errorCode: res.error ? res.error.code || String(res.error) : null,
    stdout: res.stdout,
    stderr: res.stderr,
    elapsed,
  };
}

/** The child must finish on its own, strictly inside BOUND_MS. The signal check comes first. */
function assertBounded(t, label, r) {
  t.diagnostic('FIFO-TIMING ' + label + ' ' + r.elapsed + ' ms');
  assert.strictEqual(r.signal, null, label + ' was killed after ' + r.elapsed + ' ms without finishing');
  assert.strictEqual(r.errorCode, null, label + ' spawn error: ' + r.errorCode);
  assert.ok(r.elapsed < BOUND_MS, label + ' took ' + r.elapsed + ' ms (bound ' + BOUND_MS + ' ms)');
}

const CHILD_LINE = '{"jox":"child"}\n';

/** Call appendRecord twice in a spawned child and return [first, second] after the bound check. */
function appendInChild(t, label, logDir) {
  const script =
    'const m = require(' + JSON.stringify(RECORDER_PATH) + ');' +
    'const a = m.appendRecord(' + JSON.stringify(CHILD_LINE) + ');' +
    'const b = m.appendRecord(' + JSON.stringify(CHILD_LINE) + ');' +
    'process.stdout.write(JSON.stringify([a, b]));';
  const r = runBounded(['-e', script], '', childEnv(logDir));
  assertBounded(t, label, r);
  assert.strictEqual(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

/** A real recorder row, byte-identical to what the recorder hook writes. */
function recorderRow(sessionId, toolUseId, toolName) {
  const line = serializeRecord(
    recordToolCall(
      JSON.stringify({
        hook_event_name: 'PostToolUse',
        session_id: sessionId,
        tool_use_id: toolUseId,
        tool_name: toolName,
        tool_input: {},
        tool_response: {},
        cwd: '/tmp/jox',
      }),
      { env: {} }
    )
  );
  assert.ok(typeof line === 'string' && line.length > 0, 'recorder row built');
  return line;
}

/**
 * Make `file` a sparse regular file of exactly `size` bytes, optionally starting with `firstRow`.
 * With `withNewlines`, a newline byte lands at every 1 MiB offset below `size`, so the reader never
 * takes the CTK-ADR-0010 MN-02 quadratic carry path on the sparse body.
 */
function sparseSlot(file, size, withNewlines, firstRow) {
  fs.writeFileSync(file, firstRow || '');
  const fd = fs.openSync(file, 'r+');
  try {
    fs.ftruncateSync(fd, size);
    if (withNewlines) {
      const nl = Buffer.from('\n');
      const start = firstRow ? Buffer.byteLength(firstRow, 'utf8') : 0;
      for (let off = ONE_MIB; off < size; off += ONE_MIB) {
        if (off >= start) fs.writeSync(fd, nl, 0, 1, off);
      }
    }
  } finally {
    fs.closeSync(fd);
  }
}

function lstatKind(p) {
  const st = fs.lstatSync(p);
  if (st.isSymbolicLink()) return 'symlink';
  if (st.isFIFO()) return 'fifo';
  if (st.isDirectory()) return 'dir';
  if (st.isFile()) return 'file';
  return 'other';
}

const GATE_STDIN = '{"session_id":"jox-gate","tool_name":"Bash","tool_input":{"command":"ls"}}';

// -- end to end: a spawned gate decides exactly as it would with a normal log dir --------------

for (const [label, plant] of [
  [
    'gate with a FIFO at the slot',
    (dir) => {
      mkfifo(path.join(dir, LOG_FILENAME));
      return 'fifo';
    },
  ],
  [
    'gate with a symlink to a FIFO at the slot',
    (dir) => {
      const target = path.join(dir, 'elsewhere.fifo');
      mkfifo(target);
      fs.symlinkSync(target, path.join(dir, LOG_FILENAME));
      return 'symlink';
    },
  ],
]) {
  test('261006-jox e2e: ' + label + ' emits the normal envelope and exit code within the bound', { skip: NO_FIFO }, (t) => {
    const normalDir = freshDir('jox-gate-normal-');
    const plantedDir = freshDir('jox-gate-planted-');
    try {
      const normal = runBounded([GATE_PATH], GATE_STDIN, childEnv(normalDir));
      assertBounded(t, 'normal gate', normal);
      // The writer path is exercised: the normal run logs exactly one verdict row, so the bound on
      // the planted run is not vacuous.
      const rows = fs
        .readFileSync(path.join(normalDir, LOG_FILENAME), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      assert.strictEqual(rows.length, 1, 'one verdict row in the normal log dir');
      assert.strictEqual(rows[0].source, 'pretooluse-gate');

      const kind = plant(plantedDir);
      const planted = runBounded([GATE_PATH], GATE_STDIN, childEnv(plantedDir));
      assertBounded(t, label, planted);
      assert.strictEqual(planted.status, normal.status, 'same exit code');
      assert.strictEqual(planted.stdout, normal.stdout, 'byte-identical envelope');
      assert.strictEqual(lstatKind(path.join(plantedDir, LOG_FILENAME)), kind, 'the slot keeps its type');
      assert.strictEqual(fs.existsSync(path.join(plantedDir, ROTATED_FILENAME)), false, 'no rotation');
    } finally {
      rmAll([normalDir, plantedDir]);
    }
  });
}

test('261006-jox e2e: the recorder hook with a FIFO at the slot exits 0 silently within the bound', { skip: NO_FIFO }, (t) => {
  const dir = freshDir('jox-recorder-');
  try {
    mkfifo(path.join(dir, LOG_FILENAME));
    const payload = JSON.stringify({
      hook_event_name: 'PostToolUse',
      session_id: 'jox-rec',
      tool_use_id: 'toolu_jox',
      tool_name: 'Read',
      tool_input: {},
      tool_response: {},
      cwd: '/tmp/jox',
    });
    const r = runBounded([RECORDER_PATH], payload, childEnv(dir));
    assertBounded(t, 'recorder hook with a FIFO at the slot', r);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '');
    assert.strictEqual(lstatKind(path.join(dir, LOG_FILENAME)), 'fifo');
  } finally {
    rmAll([dir]);
  }
});

// -- appendRecord in a child: the cases that block forever pre-fix --------------------------------

test('261006-jox appendInChild: a FIFO with no reader returns null twice within the bound', { skip: NO_FIFO }, (t) => {
  const dir = freshDir('jox-child-fifo-');
  try {
    mkfifo(path.join(dir, LOG_FILENAME));
    const out = appendInChild(t, 'appendInChild FIFO with no reader', dir);
    assert.deepStrictEqual(out, [null, null]);
    assert.strictEqual(lstatKind(path.join(dir, LOG_FILENAME)), 'fifo');
    assert.strictEqual(fs.existsSync(path.join(dir, ROTATED_FILENAME)), false);
  } finally {
    rmAll([dir]);
  }
});

test('261006-jox appendInChild: a symlink to a FIFO returns null twice within the bound', { skip: NO_FIFO }, (t) => {
  const dir = freshDir('jox-child-link-');
  try {
    const target = path.join(dir, 'elsewhere.fifo');
    mkfifo(target);
    fs.symlinkSync(target, path.join(dir, LOG_FILENAME));
    const out = appendInChild(t, 'appendInChild symlink to a FIFO', dir);
    assert.deepStrictEqual(out, [null, null]);
    assert.strictEqual(lstatKind(path.join(dir, LOG_FILENAME)), 'symlink');
    assert.strictEqual(lstatKind(target), 'fifo');
    assert.strictEqual(fs.existsSync(path.join(dir, ROTATED_FILENAME)), false);
  } finally {
    rmAll([dir]);
  }
});

// -- appendRecord in-process: cases that cannot block, even pre-fix --------------------------------

test('261006-jox: a FIFO WITH a reader is refused, and the reader receives zero bytes', { skip: NO_FIFO }, () => {
  const dir = freshDir('jox-reader-');
  let rfd = null;
  try {
    const slot = path.join(dir, LOG_FILENAME);
    mkfifo(slot);
    rfd = fs.openSync(slot, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    const out = appendRecord('{"jox":"reader"}\n', { env: { GSD_CONTRIB_LOG_DIR: dir } });
    let got = 0;
    try {
      got = fs.readSync(rfd, Buffer.alloc(4096), 0, 4096, null);
    } catch (err) {
      if (err.code !== 'EAGAIN') throw err;
      got = 0; // no writer ever wrote: EAGAIN is zero bytes
    }
    assert.strictEqual(out, null, 'a FIFO with a reader is not a regular file');
    assert.strictEqual(got, 0, 'zero bytes reach the pipe');
    assert.strictEqual(lstatKind(slot), 'fifo');
  } finally {
    if (rfd !== null) fs.closeSync(rfd);
    rmAll([dir]);
  }
});

test('261006-jox: a symlink to /dev/zero at the slot is refused', { skip: NO_DEVZERO }, () => {
  const dir = freshDir('jox-devzero-');
  try {
    fs.symlinkSync('/dev/zero', path.join(dir, LOG_FILENAME));
    const out = appendRecord('{"jox":"devzero"}\n', { env: { GSD_CONTRIB_LOG_DIR: dir } });
    assert.strictEqual(out, null, 'a character device is not a regular file');
    assert.strictEqual(lstatKind(path.join(dir, LOG_FILENAME)), 'symlink');
    assert.strictEqual(fs.existsSync(path.join(dir, ROTATED_FILENAME)), false);
  } finally {
    rmAll([dir]);
  }
});

test('261006-jox: a directory at the slot returns null twice and stays a directory', () => {
  const dir = freshDir('jox-dir-');
  try {
    fs.mkdirSync(path.join(dir, LOG_FILENAME));
    const deps = { env: { GSD_CONTRIB_LOG_DIR: dir } };
    assert.strictEqual(appendRecord('{"jox":"dir"}\n', deps), null);
    assert.strictEqual(appendRecord('{"jox":"dir"}\n', deps), null);
    assert.strictEqual(lstatKind(path.join(dir, LOG_FILENAME)), 'dir');
    assert.strictEqual(fs.existsSync(path.join(dir, ROTATED_FILENAME)), false);
  } finally {
    rmAll([dir]);
  }
});

test('261006-jox: a symlink to a regular file still receives both appends', () => {
  const dir = freshDir('jox-link-reg-');
  const targetDir = freshDir('jox-link-target-');
  try {
    const target = path.join(targetDir, 'target.jsonl');
    fs.writeFileSync(target, '');
    const slot = path.join(dir, LOG_FILENAME);
    fs.symlinkSync(target, slot);
    const deps = { env: { GSD_CONTRIB_LOG_DIR: dir } };
    assert.strictEqual(appendRecord('{"n":1}\n', deps), slot);
    assert.strictEqual(appendRecord('{"n":2}\n', deps), slot);
    assert.strictEqual(fs.readFileSync(target, 'utf8'), '{"n":1}\n{"n":2}\n');
    assert.strictEqual(lstatKind(slot), 'symlink');
  } finally {
    rmAll([dir, targetDir]);
  }
});

// -- rotation: the real MAX_LOG_BYTES boundary, and read-back through the reader ------------------

test('261006-jox rotation boundary: exactly MAX_LOG_BYTES stays, MAX_LOG_BYTES + 1 rotates', () => {
  const atDir = freshDir('jox-rot-at-');
  const overDir = freshDir('jox-rot-over-');
  try {
    const line = '{"jox":"boundary"}\n';
    const lineBytes = Buffer.byteLength(line, 'utf8');

    const atSlot = path.join(atDir, LOG_FILENAME);
    sparseSlot(atSlot, MAX_LOG_BYTES, false);
    assert.strictEqual(appendRecord(line, { env: { GSD_CONTRIB_LOG_DIR: atDir } }), atSlot);
    assert.strictEqual(fs.existsSync(path.join(atDir, ROTATED_FILENAME)), false, 'not over the threshold');
    assert.strictEqual(fs.statSync(atSlot).size, MAX_LOG_BYTES + lineBytes);

    const overSlot = path.join(overDir, LOG_FILENAME);
    sparseSlot(overSlot, MAX_LOG_BYTES + 1, false);
    assert.strictEqual(appendRecord(line, { env: { GSD_CONTRIB_LOG_DIR: overDir } }), overSlot);
    assert.strictEqual(fs.statSync(path.join(overDir, ROTATED_FILENAME)).size, MAX_LOG_BYTES + 1);
    assert.strictEqual(fs.readFileSync(overSlot, 'utf8'), line, 'the live slot holds only the new line');
  } finally {
    rmAll([atDir, overDir]);
  }
});

test('261006-jox rotation read-back: the rotated slot is read, and a rotation overwrites the old one', () => {
  const dir = freshDir('jox-rot-read-');
  try {
    const env = { GSD_CONTRIB_LOG_DIR: dir };
    const slot = path.join(dir, LOG_FILENAME);
    fs.writeFileSync(path.join(dir, ROTATED_FILENAME), recorderRow('jox-stale', 'toolu_stale', 'Read'));
    sparseSlot(slot, MAX_LOG_BYTES + 1, true, recorderRow('jox-rot', 'toolu_rot1', 'Read'));

    assert.strictEqual(appendRecord(recorderRow('jox-rot', 'toolu_rot2', 'Grep'), { env }), slot);

    const rot = readSessionRecords('jox-rot', { env });
    assert.strictEqual(rot.complete, true, 'read complete: ' + rot.problems.join('; '));
    const tools = rot.records.map((r) => r.tool_name).sort();
    assert.deepStrictEqual(tools, ['Grep', 'Read'], 'Read from the rotated slot, Grep from the live slot');

    const stale = readSessionRecords('jox-stale', { env });
    assert.strictEqual(stale.records.length, 0, 'the previous rotation was overwritten');

    assert.deepStrictEqual(fs.readdirSync(dir).sort(), [ROTATED_FILENAME, LOG_FILENAME].sort());
  } finally {
    rmAll([dir]);
  }
});
