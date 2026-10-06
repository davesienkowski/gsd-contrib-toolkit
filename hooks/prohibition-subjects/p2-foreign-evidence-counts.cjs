'use strict';

/**
 * VIOLATION SUBJECT (test-only) for 38-05 P2 / MEMEV-02 safety: the tool-log reader counts every
 * parseable row, ignoring `session_id` and the gate-verdict `source` key. Re-exports ./real.cjs with
 * ONLY toolLogReader.readSessionRecords replaced (by a contract-valid reader, so the gate does not
 * deny on a contract bug instead). Never wired, never bundled.
 */

const fs = require('node:fs');
const path = require('node:path');
const real = require('./real.cjs');

function readSessionRecords(_sessionId, opts = {}) {
  const env = (opts && opts.env) || {};
  const file = path.join(String(env.GSD_CONTRIB_LOG_DIR || ''), real.toolRecorder.LOG_FILENAME);
  const records = [];
  let textIn = '';
  try {
    textIn = fs.readFileSync(file, 'utf8');
  } catch (_) {
    return { recorderOff: false, complete: false, records, problems: ['log absent'] };
  }
  for (const line of textIn.split('\n')) {
    let rec;
    try {
      rec = JSON.parse(line);
    } catch (_) {
      continue;
    }
    if (!rec || typeof rec !== 'object' || typeof rec.tool_name !== 'string') continue;
    if (rec.outcome !== 'ok' && rec.outcome !== 'fail') continue;
    records.push({ tool_name: rec.tool_name, outcome: rec.outcome });
  }
  return { recorderOff: false, complete: true, records, problems: [] };
}

module.exports = Object.assign({}, real, {
  toolLogReader: Object.assign({}, real.toolLogReader, { readSessionRecords }),
});
