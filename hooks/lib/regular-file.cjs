'use strict';

/**
 * hooks/lib/regular-file.cjs - the gate's bounded, regular-file-only file reader (38 verifier
 * VF-2, the same guard the BL-01 fix gave the tool-log reader), shared by every gate that opens a
 * file on its hot path (W5, quick 261006-jts).
 *
 * A PreToolUse hook that blocks past its harness timeout is treated as ALLOW, so a FIFO, socket,
 * device or directory planted where a gate reads must never be able to stall it. The reader's
 * contract:
 *
 *   - lstat the path; a symlink is followed only to check its target's type;
 *   - refuse anything that is not a regular file (NOT_REGULAR_FILE);
 *   - open O_RDONLY|O_NONBLOCK, so a FIFO open returns at once instead of waiting for a writer;
 *   - fstat the opened fd and re-check type and size, so a swap after the lstat cannot block;
 *   - read at most MAX_LIVE_READ_BYTES (one byte more is read to detect growth past the cap).
 *
 * It THROWS a plain Error (the raw fs error, NOT_REGULAR_FILE, or the read-cap message); each
 * caller maps that onto its own failure posture.
 *
 * @module hooks/lib/regular-file
 */

const fs = require('node:fs');

/**
 * The most bytes the gate reads from one artifact or `--body-file` (1 MiB). A real artifact is a
 * few KiB of JSON; the largest, an R8 pass with a long findings list, stays in the tens of KiB.
 * GitHub caps a review or comment body at 65,536 characters, at most 256 KiB of UTF-8. 1 MiB is
 * therefore far above any real input, while bounding what a planted file can make the hook
 * allocate (38 verifier VF-2: a symlink to /dev/zero grew the hook to ~23.7 GB RSS).
 */
const MAX_LIVE_READ_BYTES = 1024 * 1024;

/** Read-only and non-blocking: an open of a FIFO returns at once instead of waiting for a writer. */
const LIVE_OPEN_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0);

const NOT_REGULAR_FILE =
  'not a regular file (a FIFO, socket, device or directory, or a symlink to one); the gate reads ' +
  'regular files only';

/**
 * Read a REGULAR file's UTF-8 text, bounded (38 verifier VF-2; the same guard the BL-01 fix gave
 * the tool-log reader). The path is lstat'ed first; a symlink is followed only to see its target,
 * and a symlink to a regular file is read wherever it points, because the type and size checks
 * are what stop a hang or a runaway allocation, and an artifact is the reviewer's own text in any
 * case. Anything else is refused. The open is O_RDONLY|O_NONBLOCK and the fd is fstat'ed again, so
 * a swap after the lstat cannot block either. At most `max` bytes are accepted: one byte more is
 * read to detect growth past the cap. THROWS a plain Error; the caller turns it into FailClosed.
 *
 * @param {string} abs
 * @param {number} [max]
 * @returns {string}
 */
function readRegularFileBounded(abs, max = MAX_LIVE_READ_BYTES) {
  const overCap = () => new Error('larger than the ' + max + '-byte read cap; refusing to read it');
  let st = fs.lstatSync(abs);
  if (st.isSymbolicLink()) st = fs.statSync(abs);
  if (!st.isFile()) throw new Error(NOT_REGULAR_FILE);
  if (st.size > max) throw overCap();
  const fd = fs.openSync(abs, LIVE_OPEN_FLAGS);
  try {
    const fst = fs.fstatSync(fd);
    if (!fst.isFile()) throw new Error(NOT_REGULAR_FILE);
    if (fst.size > max) throw overCap();
    const buf = Buffer.alloc(max + 1);
    let n = 0;
    while (n < buf.length) {
      const got = fs.readSync(fd, buf, n, buf.length - n, n);
      if (!got) break;
      n += got;
    }
    if (n > max) throw overCap(); // grew past the cap after the fstat
    return buf.toString('utf8', 0, n);
  } finally {
    try {
      fs.closeSync(fd);
    } catch (_) {
      /* closing a read fd cannot change the result */
    }
  }
}

module.exports = {
  MAX_LIVE_READ_BYTES,
  LIVE_OPEN_FLAGS,
  NOT_REGULAR_FILE,
  readRegularFileBounded,
};
