'use strict';

/**
 * node:test for hooks/lib/regular-file.cjs writeRegularFile (W5, quick 261006-jts): the gate's
 * non-blocking, regular-file-only writer. It opens O_WRONLY|O_CREAT|O_NONBLOCK (+O_APPEND),
 * fstats the fd, refuses anything that is not a regular file, and only then truncates (truncate
 * mode) and writes.
 *
 * This file is copied into the capability bundle and runs there too, so it is
 * location-independent: it requires only ./regular-file.cjs and node builtins, and every fixture
 * lives under os.tmpdir().
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const rf = require('./regular-file.cjs');

/** True when this platform has named pipes and `mkfifo`. */
function hasMkfifo() {
  if (process.platform === 'win32') return false;
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'w5-rf-fifo-probe-'));
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
const NOT_REGULAR = /not a regular file/;

function tmp(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'w5-rf-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

test('W5 writeRegularFile: truncate mode replaces longer old content', (t) => {
  const f = path.join(tmp(t), 'c.json');
  fs.writeFileSync(f, 'x'.repeat(4096));
  rf.writeRegularFile(f, 'new\n');
  assert.strictEqual(fs.readFileSync(f, 'utf8'), 'new\n');
});

test('W5 writeRegularFile: two truncate-mode writes leave only the second content', (t) => {
  const f = path.join(tmp(t), 'c.json');
  rf.writeRegularFile(f, 'first content, longer\n');
  rf.writeRegularFile(f, 'second\n');
  assert.strictEqual(fs.readFileSync(f, 'utf8'), 'second\n');
});

test('W5 writeRegularFile: append mode creates the file and two appends leave both lines', (t) => {
  const f = path.join(tmp(t), 'r.log');
  rf.writeRegularFile(f, '{"a":1}\n', { append: true });
  rf.writeRegularFile(f, '{"b":2}\n', { append: true });
  assert.strictEqual(fs.readFileSync(f, 'utf8'), '{"a":1}\n{"b":2}\n');
});

test('W5 writeRegularFile: a multi-byte UTF-8 payload is written whole', (t) => {
  const f = path.join(tmp(t), 'u.txt');
  const unit = 'caf' + String.fromCharCode(0xe9) + ' ' + String.fromCharCode(0x2713) + ' ';
  const text = unit.repeat(20000) + '\n';
  rf.writeRegularFile(f, text);
  assert.strictEqual(fs.readFileSync(f, 'utf8'), text);
});

test('W5 writeRegularFile: a FIFO with no reader throws ENXIO at once and stays a FIFO', { skip: NO_FIFO }, (t) => {
  for (const append of [false, true]) {
    const f = path.join(tmp(t), 'p');
    execFileSync('mkfifo', [f]);
    const t0 = Date.now();
    assert.throws(() => rf.writeRegularFile(f, 'x\n', { append }), (err) => err && err.code === 'ENXIO');
    assert.ok(Date.now() - t0 < 1000, 'the open returned at once');
    assert.ok(fs.lstatSync(f).isFIFO());
  }
});

test('W5 writeRegularFile: a FIFO with a reader held open is refused by type and nothing is written', { skip: NO_FIFO }, (t) => {
  const f = path.join(tmp(t), 'p');
  execFileSync('mkfifo', [f]);
  const rfd = fs.openSync(f, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  try {
    for (const append of [false, true]) {
      assert.throws(() => rf.writeRegularFile(f, 'x\n', { append }), NOT_REGULAR);
    }
    let got = 0;
    try {
      got = fs.readSync(rfd, Buffer.alloc(16), 0, 16, null);
    } catch (err) {
      assert.strictEqual(err.code, 'EAGAIN');
    }
    assert.strictEqual(got, 0, 'bytes reached the FIFO');
  } finally {
    fs.closeSync(rfd);
  }
  assert.ok(fs.lstatSync(f).isFIFO());
});

test('W5 writeRegularFile: a symlink to /dev/zero is refused by type in both modes, never EINVAL', { skip: NO_DEVZERO }, (t) => {
  const f = path.join(tmp(t), 'z');
  fs.symlinkSync('/dev/zero', f);
  for (const append of [false, true]) {
    assert.throws(
      () => rf.writeRegularFile(f, 'x\n', { append }),
      (err) => NOT_REGULAR.test(err.message) && !/EINVAL/.test(err.message) && err.code !== 'EINVAL'
    );
  }
  assert.strictEqual(fs.readlinkSync(f), '/dev/zero');
});

test('W5 writeRegularFile: a directory throws (EISDIR)', (t) => {
  const d = path.join(tmp(t), 'd');
  fs.mkdirSync(d);
  for (const append of [false, true]) {
    assert.throws(() => rf.writeRegularFile(d, 'x\n', { append }), (err) => err && err.code === 'EISDIR');
  }
  assert.ok(fs.lstatSync(d).isDirectory());
});

test('W5 regular-file: the read and write open flags are both non-blocking', () => {
  const nb = fs.constants.O_NONBLOCK || 0;
  assert.strictEqual(rf.LIVE_OPEN_FLAGS & nb, nb);
  assert.strictEqual(rf.LIVE_WRITE_FLAGS & nb, nb);
  assert.strictEqual(rf.LIVE_WRITE_FLAGS & fs.constants.O_WRONLY, fs.constants.O_WRONLY);
  assert.strictEqual(rf.LIVE_WRITE_FLAGS & fs.constants.O_CREAT, fs.constants.O_CREAT);
  assert.strictEqual(rf.LIVE_WRITE_FLAGS & (fs.constants.O_TRUNC || 0), 0, 'never O_TRUNC before the type check');
  assert.match(rf.NOT_REGULAR_WRITE_TARGET, NOT_REGULAR);
});
