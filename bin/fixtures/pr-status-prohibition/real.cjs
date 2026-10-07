'use strict';

/**
 * Prohibition subject: the REAL shipped surfaces (bin/pr-status-prohibitions.test.cjs reads this when
 * GSD_PROHIB_SUBJECT is unset, and the prover uses it as the clean fixture).
 *   cli          - the pr-status CLI script run through the refusing stub gh (Q1).
 *   bundlePairs  - every generated bundle skill file paired with its canonical skills/ source (Q2).
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..');
const CANONICAL = path.join(ROOT, 'skills');
const BUNDLE = path.join(ROOT, 'capabilities', 'contribution-toolkit', 'skills');

function walk(dir, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = path.join(rel, e.name);
    if (e.isDirectory()) out.push(...walk(dir, r));
    else out.push(r);
  }
  return out;
}

function bundlePairs() {
  return walk(BUNDLE).map((rel) => {
    const src = path.join(CANONICAL, rel);
    return {
      name: rel,
      canonical: fs.existsSync(src) ? fs.readFileSync(src, 'utf8') : null,
      bundle: fs.readFileSync(path.join(BUNDLE, rel), 'utf8'),
    };
  });
}

module.exports = { cli: path.join(ROOT, 'bin', 'pr-status.cjs'), bundlePairs };
