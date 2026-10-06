'use strict';

/**
 * hooks/prohibition-subjects/real.cjs — the CLEAN CONTROL subject for
 * hooks/review-artifact-prohibitions.test.cjs (Phase 38 plan 05).
 *
 * TEST-ONLY. Not wired into any hook command and not under hooks/lib, so build-capability never
 * bundles it. It exposes the SHIPPED modules and the SHIPPED ADR text unchanged; the prohibition
 * prover (verify-prohibitions.cjs -> gsd-core `check prohibition-enforcement`) runs the negative
 * test against it as the causation control, and each `p<k>-*.cjs` sibling re-exports it with
 * exactly one property broken.
 *
 * Subject contract: {reviewArtifact, toolLogReader, toolRecorder, adrText}.
 */

const fs = require('node:fs');
const path = require('node:path');

const ADR_DIR = path.join(__dirname, '..', '..', 'docs', 'adr');
const ADR_RE = /^CTK-ADR-\d{4}-memtrace-review-evidence\.md$/;

/**
 * The text of the single step-8a memtrace-evidence ADR.
 *
 * @returns {string}
 * @throws {Error} when there is not exactly one matching ADR file
 */
function adrText() {
  const hits = fs.readdirSync(ADR_DIR).filter((f) => ADR_RE.test(f));
  if (hits.length !== 1) {
    throw new Error('expected exactly one CTK-ADR-*-memtrace-review-evidence.md, got ' + JSON.stringify(hits));
  }
  return fs.readFileSync(path.join(ADR_DIR, hits[0]), 'utf8');
}

module.exports = {
  reviewArtifact: require('../review-artifact.cjs'),
  toolLogReader: require('../lib/tool-log-reader.cjs'),
  toolRecorder: require('../tool-recorder.cjs'),
  adrText,
};
