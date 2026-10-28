'use strict';
// Test double (pr-status-fake-core): parses one login per line; passes a maintainer author, else fails.
function parseMaintainers(text) {
  const logins = new Set(String(text || '').split(/\r?\n/).map((l) => l.replace(/#.*$/, '').trim().toLowerCase()).filter(Boolean));
  return { ok: logins.size > 0, logins, invalid: [] };
}
function evaluateReviewed({ authorLogin, maintainers }) {
  return maintainers.has(String(authorLogin).toLowerCase()) ? { ok: true, reason: 'ok_maintainer_author' } : { ok: false, reason: 'fail_no_approval' };
}
module.exports = { REASON: {}, APPROVER_ROLES: new Set(['write', 'maintain', 'admin']), parseMaintainers, evaluateReviewed };
