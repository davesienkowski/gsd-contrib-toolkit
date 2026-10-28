'use strict';
// Test double (pr-status-fake-core): every PR reads as not a fix.
function evaluateSelfTestReport() {
  return { ok: true, reason: 'ok_not_a_fix', problems: [] };
}
function extractReport() {
  return { found: false, json: null };
}
module.exports = { REASON: {}, evaluateSelfTestReport, extractReport };
