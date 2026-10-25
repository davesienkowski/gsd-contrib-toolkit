'use strict';

/**
 * hooks/lib/test-isolate.cjs - point this test process's tool log at a temp dir (quick 261024-po0).
 *
 * A gate test that calls runGate in-process logs its verdict through hooks/tool-recorder.cjs, whose
 * default directory is the REAL ~/.gsd-contrib; before this helper, 15 gate test files appended to the
 * real tool-log.jsonl on every suite run (found by hooks/lib/test-fence.cjs). Call it once at the top
 * of a test file. It sets GSD_CONTRIB_LOG_DIR unconditionally (a developer's own value is never the
 * test's), so children spawned with process.env inherit it, and removes the dir on exit.
 *
 * @returns {string} the temp dir
 */
function isolateToolLog() {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-contrib-test-log-'));
  process.env.GSD_CONTRIB_LOG_DIR = dir;
  process.on('exit', () => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (_) {
      /* best effort */
    }
  });
  return dir;
}

module.exports = { isolateToolLog };
