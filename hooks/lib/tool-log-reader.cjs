'use strict';

// 38-01 RED stub: replaced by the real reader in the feat commit.

const SCAN_CHUNK_BYTES = 1024 * 1024;

function sessionNeedle(id) {
  return '"session_id":' + JSON.stringify(id);
}

function readSessionRecords(_sessionId, _opts = {}) {
  return { recorderOff: false, complete: true, records: [], problems: [] };
}

module.exports = { readSessionRecords, sessionNeedle, SCAN_CHUNK_BYTES };
