'use strict';

/**
 * hooks/lib/gsd-test-detect.cjs — the shared gsd-test dispatch detector (GTEST-01).
 *
 * RED stub (36-01 Task 1 step 1): always returns null so the tracer tests fail at the
 * assertion level before the implementation lands.
 *
 * @module hooks/lib/gsd-test-detect
 */

/**
 * @param {string} command raw tool_input.command
 * @returns {Object|null}
 */
function findGsdTestDispatch(command) { // eslint-disable-line no-unused-vars
  return null;
}

module.exports = { findGsdTestDispatch };
