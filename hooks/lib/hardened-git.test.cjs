'use strict';

/**
 * hooks/lib/hardened-git.test.cjs - node:test for the hardened git lookup (quick 261119-szk fix round 4, option B).
 * The behavioural rows (planted git, lazy fetch, committed bare-shaped dir) run through the Read guard in
 * hooks/emitted-cjs-read.test.cjs; these rows pin the module's own API for the binlib-edit follow-up.
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const hg = require('./hardened-git.cjs');

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'hardened-git-'));
test.after(() => fs.rmSync(BASE, { recursive: true, force: true }));

test('exports the documented API', () => {
  for (const k of ['gitCandidates', 'resolveGitPath', 'fixedGit', 'probeEnvChanges', 'withHardenedProbeEnv']) {
    assert.strictEqual(typeof hg[k], 'function', k);
  }
  assert.ok(Object.isFrozen(hg.GIT_CANDIDATES));
  assert.ok(Object.isFrozen(hg.INJECTED_GIT_CONFIG));
  assert.strictEqual(typeof hg.NO_PROTOCOL, 'string');
});

test('gitCandidates: absolute system paths on POSIX, none on win32', () => {
  assert.deepStrictEqual(hg.gitCandidates('linux'), ['/usr/bin/git', '/usr/local/bin/git', '/bin/git', '/opt/homebrew/bin/git']);
  assert.deepStrictEqual(hg.gitCandidates('win32'), []);
  assert.deepStrictEqual([...hg.GIT_CANDIDATES], hg.gitCandidates(process.platform));
});

test('resolveGitPath: first executable regular file; relative, missing, directory and non-executable entries skipped', () => {
  const noExec = path.join(BASE, 'noexec');
  fs.writeFileSync(noExec, '#!/bin/sh\n', { mode: 0o644 });
  const exec = path.join(BASE, 'exec');
  fs.writeFileSync(exec, '#!/bin/sh\n', { mode: 0o755 });
  const link = path.join(BASE, 'link');
  fs.symlinkSync(exec, link);
  assert.strictEqual(hg.resolveGitPath(['git', 'rel/git', path.join(BASE, 'missing'), BASE, noExec, link, exec]), link,
    'a symlink to an executable is accepted, as the system git often is one');
  assert.strictEqual(hg.resolveGitPath([noExec]), null);
  assert.strictEqual(hg.resolveGitPath([]), null);
});

test('fixedGit: resolves GIT_CANDIDATES and returns the same value on every call', () => {
  const a = hg.fixedGit();
  assert.strictEqual(a, hg.resolveGitPath(hg.GIT_CANDIDATES));
  assert.strictEqual(hg.fixedGit(), a);
});

test('probeEnvChanges: config appended after inherited count entries, -c parameters appended, no transport, no lazy fetch', () => {
  const out = hg.probeEnvChanges({ GIT_CONFIG_COUNT: '2', GIT_CONFIG_PARAMETERS: "'a.b=c'" }, '/usr/bin/git');
  assert.strictEqual(out.GIT_CONFIG_COUNT, '4');
  assert.strictEqual(out.GIT_CONFIG_KEY_2, 'core.fsmonitor');
  assert.strictEqual(out.GIT_CONFIG_VALUE_2, 'false');
  assert.strictEqual(out.GIT_CONFIG_KEY_3, 'safe.bareRepository');
  assert.strictEqual(out.GIT_CONFIG_VALUE_3, 'explicit');
  assert.strictEqual(out.GIT_CONFIG_PARAMETERS, "'a.b=c' 'core.fsmonitor=false' 'safe.bareRepository=explicit'");
  assert.strictEqual(out.GIT_ALLOW_PROTOCOL, hg.NO_PROTOCOL);
  assert.strictEqual(out.GIT_NO_LAZY_FETCH, '1');
  assert.strictEqual(out.PATH, '/usr/bin');
  assert.strictEqual(hg.probeEnvChanges({ GIT_CONFIG_COUNT: '-1x' }).GIT_CONFIG_COUNT, '2', 'a malformed count is replaced');
  assert.ok(!('PATH' in hg.probeEnvChanges({ PATH: '/x' })), 'no gitPath: PATH is not touched');
  assert.ok(!('PATH' in hg.probeEnvChanges({ PATH: '/x' }, 'relative/git')), 'a relative gitPath: PATH is not touched');
});

test('withHardenedProbeEnv: fn sees the changes; every key is restored afterwards, including on a throw and an unset key', () => {
  const before = JSON.stringify(Object.entries(process.env).sort());
  const savedPath = process.env.PATH;
  delete process.env.PATH;
  try {
    const seen = hg.withHardenedProbeEnv(() => ({ path: process.env.PATH, lazy: process.env.GIT_NO_LAZY_FETCH }), '/usr/bin/git');
    assert.deepStrictEqual(seen, { path: '/usr/bin', lazy: '1' });
    assert.ok(!('PATH' in process.env), 'an unset PATH stays unset');
    assert.throws(() => hg.withHardenedProbeEnv(() => { throw new Error('boom'); }, '/usr/bin/git'), /boom/);
    assert.ok(!('PATH' in process.env));
  } finally {
    process.env.PATH = savedPath;
  }
  assert.strictEqual(JSON.stringify(Object.entries(process.env).sort()), before);
});
