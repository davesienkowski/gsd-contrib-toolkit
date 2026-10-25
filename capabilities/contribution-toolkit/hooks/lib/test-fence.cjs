'use strict';

/**
 * hooks/lib/test-fence.cjs - refuse a write into the REAL user state while running under `node --test`.
 *
 * Why (quick 261024-po0): a red test once exercised the stamp writer against a module that ignored the
 * test's temp home and overwrote the real ~/.gsd-contrib/runtime-stamp.json with fixture values. Per-test
 * temp dirs are still the rule; this is the backstop that turns the next such slip into a loud failure.
 *
 * Armed only when NODE_TEST_CONTEXT is set: `node --test` sets it in every test-file process, and a child
 * spawned with that process's env inherits it. A hook run by the harness never has it, so production
 * behavior is unchanged. The real home is os.userInfo().homedir, which a test cannot move by setting HOME.
 * Fenced: any path at or inside <real home>/.gsd-contrib or <real home>/.claude. Not fenced: a test file
 * run directly with `node file.test.cjs` (no NODE_TEST_CONTEXT). An unexpected fire also sets the
 * process exit code to 1 at exit, so the leaking test file fails even when the caller swallowed the throw.
 *
 * @module hooks/lib/test-fence
 */

const os = require('node:os');
const path = require('node:path');

const FENCED_DIRS = Object.freeze(['.gsd-contrib', '.claude']);

/** The real account home, or null when it cannot be read. Never $HOME. */
function realHome() {
  try {
    const h = os.userInfo().homedir;
    return typeof h === 'string' && h.length > 0 ? h : null;
  } catch (_) {
    return null;
  }
}

const unexpected = [];

/** Record an unexpected fire; the first one registers an exit hook that fails the process. */
function failOnExit(abs) {
  if (unexpected.length === 0) {
    process.on('exit', () => {
      try {
        process.stderr.write('GSD-CONTRIB-TEST-FENCE: ' + unexpected.length + ' unexpected write(s) to the real user ' +
          'state were refused; failing this test file (first: ' + unexpected[0] + ')\n');
      } catch (_) { /* best effort */ }
      process.exitCode = 1;
    });
  }
  unexpected.push(abs);
}

/**
 * Throw when `file` would land in the real user state under `node --test`.
 *
 * @param {string} file the path about to be written (or whose directory is about to be created)
 * @param {Object} [env] defaults to process.env
 * @throws {Error} "test fence: ..." when armed and the path is fenced
 */
function assertNotRealUserState(file, env = process.env) {
  if (!env || !env.NODE_TEST_CONTEXT) return;
  const home = realHome();
  if (home === null) return;
  const abs = path.resolve(String(file));
  for (const d of FENCED_DIRS) {
    const base = path.join(home, d);
    const rel = path.relative(base, abs);
    if (rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel))) {
      const msg = 'test fence: refusing to write ' + abs + ' (inside the real ' + base + ') under node --test; ' +
        'give the test a temp HOME / GSD_CONTRIB_STATE_DIR / GSD_CONTRIB_LOG_DIR or inject the path';
      try { process.stderr.write('GSD-CONTRIB-TEST-FENCE: ' + abs + '\n'); } catch (_) { /* best effort */ }
      // Loud, not just blocked: callers such as the tool recorder swallow the throw, so an UNEXPECTED
      // fire also fails the test file through its exit code. A test that triggers the fence on purpose
      // sets GSD_CONTRIB_TEST_FENCE_EXPECTED=1 around the call.
      if (env.GSD_CONTRIB_TEST_FENCE_EXPECTED !== '1') failOnExit(abs);
      throw new Error(msg);
    }
  }
}

module.exports = { assertNotRealUserState, realHome, FENCED_DIRS };
