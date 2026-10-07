'use strict';

/**
 * bin/pr-status-prohibitions.test.cjs — the two test-tier prohibitions of dev-env quick 261007-fnu, as
 * SUBJECT-INJECTABLE negative tests (the gsd-core #1279 GSD_PROHIB_SUBJECT convention, as in
 * hooks/review-artifact-prohibitions.test.cjs).
 *
 * The subject is loaded from GSD_PROHIB_SUBJECT (resolved against the cwd) when set, else from
 * fixtures/pr-status-prohibition/real.cjs (the shipped surfaces). The prohibition prover runs this file
 * with no subject and with real.cjs (both must pass) and with each q<k>-*.cjs violation subject (each
 * must fail its own row):
 *
 *   Q1 (safety) pr-status calls no mutating or GraphQL gh verb: the subject's CLI runs through a stub gh
 *               that REFUSES anything but pr view, pr checks and the reviews GET, and no call is refused.
 *   Q2 (values) the generated bundle under capabilities/contribution-toolkit/skills/ is never hand-edited:
 *               every bundle file has a canonical skills/ source with identical bytes.
 *
 * @module bin/pr-status-prohibitions.test
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const S = process.env.GSD_PROHIB_SUBJECT
  ? require(path.resolve(process.cwd(), process.env.GSD_PROHIB_SUBJECT))
  : require('./fixtures/pr-status-prohibition/real.cjs');

const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'pr-status');
const STUB_FILE = path.join(__dirname, 'fixtures', 'pr-status-gh-stub.cjs');

test('prohibition Q1: the pr-status CLI calls only read-only gh verbs (stub gh refuses everything else)', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-status-prohib-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.copyFileSync(STUB_FILE, path.join(bin, 'gh'));
  fs.chmodSync(path.join(bin, 'gh'), 0o755);
  const logFile = path.join(dir, 'argv.log');
  fs.writeFileSync(logFile, '');
  spawnSync(process.execPath, [S.cli, '5235', '5079'], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, {
      PATH: bin + path.delimiter + process.env.PATH,
      PR_STATUS_STUB_FIXTURES: FIXTURES_DIR,
      PR_STATUS_STUB_LOG: logFile,
    }),
  });
  const log = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean);
  assert.ok(log.length > 0, 'the CLI made at least one gh call (non-vacuous)');
  const refused = log.filter((l) => l.startsWith('REFUSED'));
  assert.deepEqual(refused, [], 'no mutating or GraphQL gh call');
});

test('prohibition Q2: every bundled skill file matches its canonical skills/ source byte for byte', () => {
  const pairs = S.bundlePairs();
  assert.ok(pairs.length > 0, 'at least one bundled skill file (non-vacuous)');
  for (const p of pairs) {
    assert.notEqual(p.canonical, null, `${p.name}: bundle file has no canonical skills/ source`);
    assert.equal(p.bundle, p.canonical, `${p.name}: bundle differs from skills/ (edit skills/, then node bin/build-capability.cjs)`);
  }
});
