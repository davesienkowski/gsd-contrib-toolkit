'use strict';

/**
 * VIOLATION SUBJECT (test-only) for 38-05 P5 / MEMEV-02 transparency: the step-8a ADR is marked
 * Accepted. Re-exports ./real.cjs with ONLY adrText changed (its Status line rewritten). Never wired,
 * never bundled.
 */

const real = require('./real.cjs');

function adrText() {
  return real.adrText().replace(/^- \*\*Status:\*\*.*$/m, '- **Status:** Accepted');
}

module.exports = Object.assign({}, real, { adrText });
