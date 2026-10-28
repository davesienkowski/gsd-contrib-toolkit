'use strict';
// Test double (pr-status-fake-core): the exports pr-status reads; every completed non-success newest run is RED.
const VERDICT = Object.freeze({ CLEAN: 'CLEAN', RED: 'RED', INDETERMINATE: 'INDETERMINATE' });
function classifyBaseRuns(payload) {
  const runs = payload && payload.workflow_runs;
  if (!Array.isArray(runs)) return { verdict: VERDICT.INDETERMINATE, run: null, reason: 'malformed-payload' };
  if (runs.length === 0) return { verdict: VERDICT.CLEAN, run: null, reason: 'resolved' };
  return { verdict: runs[0].conclusion === 'success' ? VERDICT.CLEAN : VERDICT.RED, run: runs[0], reason: 'resolved' };
}
module.exports = { VERDICT, BYPASS_LABEL: 'fix-next', TESTS_WORKFLOW_FILE: 'test.yml', classifyBaseRuns };
