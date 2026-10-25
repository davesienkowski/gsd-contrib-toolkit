'use strict';

/**
 * node:test for hooks/lib/runtime-stamp.cjs — the ENF-21 drift oracle.
 *
 * Every case here is HERMETIC: no real filesystem, no real `git`, no real network, no clock.
 * Each impure seam (`readdirSync`/`statSync`/`readFileSync`, `execFileSync`, `readCache`/
 * `writeCache`, `now`) is injected, which is exactly what lets the gate that consumes this
 * module be tested without touching `~/.claude/gsd-core` or github.com.
 *
 * Proven here:
 *   runtimeDigest  — stable across insertion order, sensitive to a single byte and to an added
 *                    file, blind to dot-prefixed entries, and FailClosed on a missing root.
 *   readStamp      — valid → object; absent → null; malformed/wrong-schema/bad-sha → THROWS.
 *   upstreamTip    — TTL cache (zero network inside the TTL), live refetch past it, the 24 h
 *                    stale-cache budget, UpstreamUnavailable past the budget, and a hard throw
 *                    on a tip that is not a clean 40-hex sha (never a guessed tip).
 *   fetchTipLive   — parses only `<40-hex>\trefs/heads/next`, throws on anything else, and
 *                    carries an explicit 5000 ms spawn timeout with no shell.
 *   evaluateDrift  — the four verdicts, pure (plain objects in, plain object out).
 */

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const rs = require('./runtime-stamp.cjs');
const { FailClosed } = require('./failclosed.cjs');

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

// ───────────────────────────── a virtual filesystem ─────────────────────────────

/**
 * Build an injectable {readdirSync, statSync, readFileSync} triple over a plain
 * relpath → contents map rooted at `root`. Directories are inferred from the paths.
 *
 * @param {string} root
 * @param {Object<string,string>} files
 */
function makeFs(root, files) {
  const dirs = new Set([root]);
  const fileMap = new Map();
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fileMap.set(abs, content);
    let d = path.dirname(abs);
    while (d.length > root.length) {
      dirs.add(d);
      d = path.dirname(d);
    }
  }
  return {
    readdirSync(dir) {
      const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
      const names = new Set();
      for (const k of [...fileMap.keys(), ...dirs]) {
        if (!k.startsWith(prefix)) continue;
        names.add(k.slice(prefix.length).split(path.sep)[0]);
      }
      return [...names];
    },
    statSync(p) {
      if (dirs.has(p)) return { isDirectory: () => true, isFile: () => false };
      if (fileMap.has(p)) return { isDirectory: () => false, isFile: () => true };
      const e = new Error('ENOENT: no such file or directory, stat ' + p);
      e.code = 'ENOENT';
      throw e;
    },
    readFileSync(p) {
      if (!fileMap.has(p)) {
        const e = new Error('ENOENT: no such file or directory, open ' + p);
        e.code = 'ENOENT';
        throw e;
      }
      return Buffer.from(fileMap.get(p), 'utf8');
    },
  };
}

// ───────────────────────────── constants ─────────────────────────────

test('the frozen constants are the documented ones', () => {
  assert.strictEqual(rs.STAMP_SCHEMA, 1);
  assert.strictEqual(rs.TTL_MS, 15 * 60 * 1000);
  assert.strictEqual(rs.STALE_BUDGET_MS, 24 * 60 * 60 * 1000);
  assert.strictEqual(rs.UPSTREAM_REF, 'next');
});

test('UPSTREAM_URL is the LITERAL upstream repo, built from resolve.cjs (no second source of truth)', () => {
  // Asserted as a LITERAL, not as `includes(OWNER + '/' + REPO)`. The composed form was the
  // original assertion and it passed VACUOUSLY: both constants were module-private in resolve.cjs,
  // so the expression evaluated to 'undefined/undefined' — which the equally-undefined URL
  // contained. The bug only surfaced when a real `ls-remote` hit github.com/undefined/undefined.
  assert.strictEqual(rs.UPSTREAM_URL, 'https://github.com/open-gsd/gsd-core.git');
  const { GSD_CORE_OWNER, GSD_CORE_REPO } = require('./resolve.cjs');
  assert.strictEqual(GSD_CORE_OWNER, 'open-gsd');
  assert.strictEqual(GSD_CORE_REPO, 'gsd-core');
  assert.ok(!rs.UPSTREAM_URL.includes('undefined'), 'the URL must never contain a stringified undefined');
});

test('REMEDIATION_COMMAND is the single absolute `runtime-sync.cjs sync` string', () => {
  assert.match(rs.REMEDIATION_COMMAND, /^node \/.*\/bin\/runtime-sync\.cjs sync$/);
});

test('REMEDIATION_COMMAND names a file that ACTUALLY EXISTS (a broken remediation is worse than none)', () => {
  const nodeFs = require('node:fs');
  assert.ok(rs.REMEDIATION_CLI, 'the CLI must be reachable from the canonical module');
  assert.ok(nodeFs.existsSync(rs.REMEDIATION_CLI), rs.REMEDIATION_CLI + ' must exist on disk');
});

test('the CLI is also reachable from the BUNDLED copy of this module (the path the harness wires)', () => {
  // build-capability projects hooks/ + hooks/lib/ into capabilities/contribution-toolkit/, and the
  // installed settings.json wires THAT copy. A fixed `../../bin/runtime-sync.cjs` resolves there to
  // the bundle root, which has no bin/ — the deny reason would name a path that does not exist.
  const nodeFs = require('node:fs');
  const bundleLib = path.resolve(__dirname, '..', '..', 'capabilities', 'contribution-toolkit', 'hooks', 'lib');
  const found = rs.resolveRemediationCli(path.dirname(bundleLib));
  assert.ok(found, 'the walk-up must find bin/runtime-sync.cjs from the bundled hooks dir');
  assert.ok(nodeFs.existsSync(found), found + ' must exist on disk');
  assert.strictEqual(found, rs.REMEDIATION_CLI, 'canonical and bundled copies must name the SAME CLI');
});

test('resolveRemediationCli returns null (never a fabricated path) when the CLI is unreachable', () => {
  assert.strictEqual(rs.resolveRemediationCli('/nonexistent/deep/path', { existsSync: () => false }), null);
});

test('the state dir defaults to ~/.gsd-contrib and honours GSD_CONTRIB_STATE_DIR', () => {
  const os = require('node:os');
  assert.strictEqual(rs.resolveStateDir({}), path.join(os.homedir(), '.gsd-contrib'));
  assert.strictEqual(rs.resolveStateDir({ GSD_CONTRIB_STATE_DIR: '/scratch/state' }), '/scratch/state');
  assert.strictEqual(rs.resolveStateDir({ GSD_CONTRIB_STATE_DIR: '   ' }), path.join(os.homedir(), '.gsd-contrib'));
  assert.strictEqual(rs.stampPath({ GSD_CONTRIB_STATE_DIR: '/s' }), path.join('/s', 'runtime-stamp.json'));
  assert.strictEqual(rs.cachePath({ GSD_CONTRIB_STATE_DIR: '/s' }), path.join('/s', 'upstream-tip-cache.json'));
});

// ───────────────────────────── runtimeDigest ─────────────────────────────

test('runtimeDigest: two identical trees produce EQUAL digests regardless of insertion order', () => {
  const a = rs.runtimeDigest('/rt', makeFs('/rt', { 'a.txt': 'one', 'b/c.txt': 'two', 'z.txt': 'three' }));
  const b = rs.runtimeDigest('/rt', makeFs('/rt', { 'z.txt': 'three', 'b/c.txt': 'two', 'a.txt': 'one' }));
  assert.strictEqual(a, b);
  assert.match(a, /^sha256:[0-9a-f]{64}$/);
});

test('runtimeDigest: ONE changed byte changes the digest', () => {
  const a = rs.runtimeDigest('/rt', makeFs('/rt', { 'a.txt': 'one', 'b/c.txt': 'two' }));
  const b = rs.runtimeDigest('/rt', makeFs('/rt', { 'a.txt': 'onE', 'b/c.txt': 'two' }));
  assert.notStrictEqual(a, b);
});

test('runtimeDigest: an ADDED file changes the digest', () => {
  const a = rs.runtimeDigest('/rt', makeFs('/rt', { 'a.txt': 'one' }));
  const b = rs.runtimeDigest('/rt', makeFs('/rt', { 'a.txt': 'one', 'b.txt': '' }));
  assert.notStrictEqual(a, b);
});

test('runtimeDigest: the path framing prevents a rename/concat collision', () => {
  // Without `<relpath>\0<bytes>\0` framing, {ab: 'c'} and {a: 'bc'} could collide.
  const a = rs.runtimeDigest('/rt', makeFs('/rt', { ab: 'c' }));
  const b = rs.runtimeDigest('/rt', makeFs('/rt', { a: 'bc' }));
  assert.notStrictEqual(a, b);
});

test('runtimeDigest: dot-prefixed entries (files AND directories) are IGNORED', () => {
  const plain = rs.runtimeDigest('/rt', makeFs('/rt', { 'a.txt': 'one' }));
  const withDots = rs.runtimeDigest(
    '/rt',
    makeFs('/rt', { 'a.txt': 'one', '.hidden': 'x', '.git/objects/deadbeef': 'y', 'sub/.cache/z': 'q' })
  );
  assert.strictEqual(plain, withDots);
});

test('runtimeDigest: a MISSING runtime root throws FailClosed', () => {
  assert.throws(
    () => rs.runtimeDigest('/nope', makeFs('/rt', { 'a.txt': 'one' })),
    (err) => err instanceof FailClosed && /runtime root/i.test(err.message)
  );
});

test('runtimeDigest: a runtime root that is a FILE, not a directory, throws FailClosed', () => {
  const fsx = makeFs('/rt', { 'a.txt': 'one' });
  assert.throws(() => rs.runtimeDigest('/rt/a.txt', fsx), (err) => err instanceof FailClosed);
});

// ───────────────────────────── readStamp / writeStamp ─────────────────────────────

/** The managed-hook digest a hook-carrying stamp records (quick 261017-w1i, CTK-ADR-0011). */
const HDIGEST = 'sha256:' + 'e'.repeat(64);

const VALID_STAMP = Object.freeze({
  schema: 1,
  sha: SHA_A,
  runtime_digest: 'sha256:' + 'f'.repeat(64),
  mode: 'payload-verified',
  engine_verified: false,
  installed_at: '2026-07-30T00:00:00.000Z',
  source: 'https://github.com/open-gsd/gsd-core.git#next',
  hooks_files: Object.freeze(['gsd-a.js', 'lib/b.sh']),
  hooks_digest: HDIGEST,
});

function stampReader(body) {
  return () => {
    if (body === null) {
      const e = new Error('ENOENT');
      e.code = 'ENOENT';
      throw e;
    }
    return body;
  };
}

test('readStamp: a valid stamp round-trips to the object', () => {
  const got = rs.readStamp({ readFileSync: stampReader(JSON.stringify(VALID_STAMP)), stampPath: '/s/runtime-stamp.json' });
  assert.deepStrictEqual(got, VALID_STAMP);
});

test('readStamp: an ABSENT stamp file is null (the unstamped case, not an error)', () => {
  assert.strictEqual(rs.readStamp({ readFileSync: stampReader(null), stampPath: '/s/x.json' }), null);
});

test('readStamp: malformed JSON THROWS FailClosed (fail-closed, never a guessed null)', () => {
  assert.throws(
    () => rs.readStamp({ readFileSync: stampReader('{not json'), stampPath: '/s/x.json' }),
    (err) => err instanceof FailClosed
  );
});

test('readStamp: a WRONG schema THROWS FailClosed', () => {
  const bad = JSON.stringify({ ...VALID_STAMP, schema: 2 });
  assert.throws(() => rs.readStamp({ readFileSync: stampReader(bad), stampPath: '/s/x.json' }), (e) => e instanceof FailClosed);
});

test('readStamp: a sha that is not 40-hex THROWS FailClosed', () => {
  for (const sha of ['', 'abc', SHA_A.slice(0, 39), SHA_A + 'a', 'g'.repeat(40), 42, null]) {
    const bad = JSON.stringify({ ...VALID_STAMP, sha });
    assert.throws(
      () => rs.readStamp({ readFileSync: stampReader(bad), stampPath: '/s/x.json' }),
      (e) => e instanceof FailClosed,
      'sha ' + JSON.stringify(sha) + ' should be rejected'
    );
  }
});

test('readStamp: a missing/misshapen runtime_digest THROWS FailClosed (D-02 binding is mandatory)', () => {
  for (const d of [undefined, '', 'deadbeef', 'sha256:zz', 42]) {
    const bad = JSON.stringify({ ...VALID_STAMP, runtime_digest: d });
    assert.throws(
      () => rs.readStamp({ readFileSync: stampReader(bad), stampPath: '/s/x.json' }),
      (e) => e instanceof FailClosed,
      'runtime_digest ' + JSON.stringify(d) + ' should be rejected'
    );
  }
});

test('readStamp: a non-ENOENT read error THROWS FailClosed (an unreadable stamp is not "absent")', () => {
  const boom = () => {
    const e = new Error('EACCES: permission denied');
    e.code = 'EACCES';
    throw e;
  };
  assert.throws(() => rs.readStamp({ readFileSync: boom, stampPath: '/s/x.json' }), (e) => e instanceof FailClosed);
});

test('writeStamp: creates the state dir and writes pretty JSON at the stamp path', () => {
  const mkdirs = [];
  const writes = [];
  rs.writeStamp(VALID_STAMP, {
    mkdirSync: (d, o) => mkdirs.push([d, o]),
    writeFileSync: (p, body) => writes.push([p, body]),
    stampPath: '/s/runtime-stamp.json',
  });
  assert.deepStrictEqual(mkdirs, [['/s', { recursive: true }]]);
  assert.strictEqual(writes.length, 1);
  assert.strictEqual(writes[0][0], '/s/runtime-stamp.json');
  assert.deepStrictEqual(JSON.parse(writes[0][1]), VALID_STAMP);
  assert.ok(writes[0][1].endsWith('\n'), 'the stamp ends with a newline');
});

test('writeStamp: refuses to write a stamp readStamp would reject (no self-inflicted lie)', () => {
  assert.throws(
    () => rs.writeStamp({ ...VALID_STAMP, sha: 'nope' }, {
      mkdirSync: () => {}, writeFileSync: () => {}, stampPath: '/s/x.json',
    }),
    (e) => e instanceof FailClosed
  );
});

// ───────────────────────────── fetchTipLive ─────────────────────────────

test('fetchTipLive: parses `<sha>\\trefs/heads/next` and spawns git with a 5000 ms timeout, no shell', () => {
  const calls = [];
  const sha = rs.fetchTipLive({
    execFileSync: (file, args, opts) => {
      calls.push({ file, args, opts });
      return SHA_A + '\trefs/heads/next\n';
    },
  });
  assert.strictEqual(sha, SHA_A);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].file, 'git');
  assert.deepStrictEqual(calls[0].args, ['ls-remote', rs.UPSTREAM_URL, 'next']);
  assert.strictEqual(calls[0].opts.timeout, 5000);
  assert.notStrictEqual(calls[0].opts.shell, true);
  assert.deepStrictEqual(calls[0].opts.stdio, ['ignore', 'pipe', 'pipe']);
});

test('fetchTipLive: a WRONG ref line throws FailClosed (T-0ov-02: never a guessed tip)', () => {
  for (const out of [
    SHA_A + '\trefs/heads/main\n',
    SHA_A + '\trefs/tags/next\n',
    'notasha\trefs/heads/next\n',
    SHA_A + '\n',
    '',
    '   ',
  ]) {
    assert.throws(
      () => rs.fetchTipLive({ execFileSync: () => out }),
      (e) => e instanceof FailClosed,
      'output ' + JSON.stringify(out) + ' should be rejected'
    );
  }
});

test('fetchTipLive: a spawn/network failure throws UpstreamUnavailable (NOT FailClosed)', () => {
  assert.throws(
    () => rs.fetchTipLive({ execFileSync: () => { throw new Error('ETIMEDOUT'); } }),
    (e) => e instanceof rs.UpstreamUnavailable && !(e instanceof FailClosed)
  );
});

test('fetchTipLive: picks the refs/heads/next line out of a multi-line ls-remote response', () => {
  const out = [SHA_B + '\trefs/heads/main', SHA_A + '\trefs/heads/next', SHA_B + '\trefs/heads/nextish'].join('\n');
  assert.strictEqual(rs.fetchTipLive({ execFileSync: () => out }), SHA_A);
});

// ───────────────────────────── upstreamTip ─────────────────────────────

const T0 = Date.parse('2026-07-30T12:00:00.000Z');

function cacheEntry(sha, fetchedAtMs) {
  return {
    schema: rs.STAMP_SCHEMA,
    url: rs.UPSTREAM_URL,
    ref: rs.UPSTREAM_REF,
    sha,
    fetched_at: new Date(fetchedAtMs).toISOString(),
  };
}

test('upstreamTip: inside the TTL the CACHE is used and fetchTip is NEVER called', () => {
  let fetches = 0;
  const writes = [];
  const res = rs.upstreamTip({
    fetchTip: () => { fetches += 1; return SHA_B; },
    readCache: () => cacheEntry(SHA_A, T0 - 60 * 1000),
    writeCache: (e) => writes.push(e),
    now: () => T0,
  });
  assert.strictEqual(res.sha, SHA_A);
  assert.strictEqual(res.source, 'cache');
  assert.strictEqual(res.ageMs, 60 * 1000);
  assert.strictEqual(fetches, 0, 'zero network calls inside the TTL');
  assert.strictEqual(writes.length, 0, 'a cache hit rewrites nothing');
});

test('upstreamTip: past the TTL it refetches LIVE and rewrites the cache', () => {
  let fetches = 0;
  const writes = [];
  const res = rs.upstreamTip({
    fetchTip: () => { fetches += 1; return SHA_B; },
    readCache: () => cacheEntry(SHA_A, T0 - rs.TTL_MS - 1),
    writeCache: (e) => writes.push(e),
    now: () => T0,
  });
  assert.strictEqual(res.sha, SHA_B);
  assert.strictEqual(res.source, 'live');
  assert.strictEqual(res.ageMs, 0);
  assert.strictEqual(fetches, 1);
  assert.strictEqual(writes.length, 1);
  assert.strictEqual(writes[0].sha, SHA_B);
  assert.strictEqual(writes[0].ref, rs.UPSTREAM_REF);
  assert.strictEqual(writes[0].url, rs.UPSTREAM_URL);
});

test('upstreamTip: NO cache at all → one live fetch', () => {
  const res = rs.upstreamTip({
    fetchTip: () => SHA_B,
    readCache: () => null,
    writeCache: () => {},
    now: () => T0,
  });
  assert.strictEqual(res.sha, SHA_B);
  assert.strictEqual(res.source, 'live');
});

test('upstreamTip: fetch fails but the cache is within the 24 h budget → stale-cache verdict', () => {
  const ageMs = 3 * 60 * 60 * 1000;
  const res = rs.upstreamTip({
    fetchTip: () => { throw new rs.UpstreamUnavailable('offline'); },
    readCache: () => cacheEntry(SHA_A, T0 - ageMs),
    writeCache: () => { throw new Error('must not rewrite the cache on a failed fetch'); },
    now: () => T0,
  });
  assert.strictEqual(res.sha, SHA_A);
  assert.strictEqual(res.source, 'stale-cache');
  assert.strictEqual(res.ageMs, ageMs);
});

test('upstreamTip: fetch fails and the cache is PAST the budget → UpstreamUnavailable', () => {
  assert.throws(
    () => rs.upstreamTip({
      fetchTip: () => { throw new rs.UpstreamUnavailable('offline'); },
      readCache: () => cacheEntry(SHA_A, T0 - rs.STALE_BUDGET_MS - 1),
      writeCache: () => {},
      now: () => T0,
    }),
    (e) => e instanceof rs.UpstreamUnavailable
  );
});

test('upstreamTip: fetch fails and there is NO cache → UpstreamUnavailable', () => {
  assert.throws(
    () => rs.upstreamTip({
      fetchTip: () => { throw new rs.UpstreamUnavailable('offline'); },
      readCache: () => null,
      writeCache: () => {},
      now: () => T0,
    }),
    (e) => e instanceof rs.UpstreamUnavailable
  );
});

test('upstreamTip: a fetchTip returning a NON-40-hex tip THROWS FailClosed, never a guessed tip', () => {
  for (const bad of ['', 'abc', SHA_A + 'a', 'g'.repeat(40), null, undefined, 42]) {
    assert.throws(
      () => rs.upstreamTip({
        fetchTip: () => bad,
        readCache: () => null,
        writeCache: () => {},
        now: () => T0,
      }),
      (e) => e instanceof FailClosed,
      'tip ' + JSON.stringify(bad) + ' should be rejected'
    );
  }
});

test('upstreamTip: a FailClosed from fetchTip is NOT rescued by a warm stale cache', () => {
  // A malformed remote response is a TAMPERING signal (T-0ov-02), not an outage — it must not
  // silently fall back to the cache and it must not degrade to `ask`.
  assert.throws(
    () => rs.upstreamTip({
      fetchTip: () => { throw new FailClosed('crafted ref line'); },
      readCache: () => cacheEntry(SHA_A, T0 - 1000),
      writeCache: () => {},
      now: () => T0 + rs.TTL_MS + 1,
    }),
    (e) => e instanceof FailClosed && !(e instanceof rs.UpstreamUnavailable)
  );
});

test('upstreamTip: a CORRUPT cache entry is treated as absent (refetch), never trusted', () => {
  for (const bad of [
    { ...cacheEntry(SHA_A, T0 - 1000), sha: 'nope' },
    { ...cacheEntry(SHA_A, T0 - 1000), ref: 'main' },
    { ...cacheEntry(SHA_A, T0 - 1000), url: 'https://evil.example/x.git' },
    { ...cacheEntry(SHA_A, T0 - 1000), schema: 99 },
    { ...cacheEntry(SHA_A, T0 - 1000), fetched_at: 'not-a-date' },
    {},
    null,
  ]) {
    let fetches = 0;
    const res = rs.upstreamTip({
      fetchTip: () => { fetches += 1; return SHA_B; },
      readCache: () => bad,
      writeCache: () => {},
      now: () => T0,
    });
    assert.strictEqual(res.source, 'live', 'corrupt cache ' + JSON.stringify(bad) + ' must force a refetch');
    assert.strictEqual(fetches, 1);
  }
});

test('upstreamTip: a cache dated in the FUTURE is not trusted as fresh', () => {
  let fetches = 0;
  const res = rs.upstreamTip({
    fetchTip: () => { fetches += 1; return SHA_B; },
    readCache: () => cacheEntry(SHA_A, T0 + 60 * 60 * 1000),
    writeCache: () => {},
    now: () => T0,
  });
  assert.strictEqual(res.source, 'live');
  assert.strictEqual(fetches, 1);
});

// ───────────────────────────── readCacheLive / writeCacheLive ─────────────────────────────

test('readCacheLive: an absent or unreadable cache is null (a cache miss is never an error)', () => {
  const enoent = () => { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; };
  assert.strictEqual(rs.readCacheLive({ readFileSync: enoent, cachePath: '/s/c.json' }), null);
  assert.strictEqual(rs.readCacheLive({ readFileSync: () => '{oops', cachePath: '/s/c.json' }), null);
});

test('readCacheLive: a well-formed cache round-trips', () => {
  const entry = cacheEntry(SHA_A, T0);
  const got = rs.readCacheLive({ readFileSync: () => JSON.stringify(entry), cachePath: '/s/c.json' });
  assert.deepStrictEqual(got, entry);
});

test('writeCacheLive: writes to the cache path and never throws on a write failure', () => {
  const writes = [];
  rs.writeCacheLive(cacheEntry(SHA_A, T0), {
    mkdirSync: () => {},
    writeFileSync: (p, b) => writes.push([p, b]),
    cachePath: '/s/upstream-tip-cache.json',
  });
  assert.strictEqual(writes[0][0], '/s/upstream-tip-cache.json');
  // A cache is an optimization: an unwritable state dir must not break a gate run.
  assert.doesNotThrow(() =>
    rs.writeCacheLive(cacheEntry(SHA_A, T0), {
      mkdirSync: () => { throw new Error('EROFS'); },
      writeFileSync: () => { throw new Error('EROFS'); },
      cachePath: '/s/c.json',
    })
  );
});

// ───────────────────────────── evaluateDrift (pure) ─────────────────────────────

const DIGEST = 'sha256:' + 'f'.repeat(64);
const FRESH_UPSTREAM = Object.freeze({ sha: SHA_A, source: 'live', ageMs: 0 });

test('evaluateDrift: stamp present + digest matches + sha matches → fresh', () => {
  const r = rs.evaluateDrift({
    stamp: { ...VALID_STAMP, sha: SHA_A, runtime_digest: DIGEST },
    runtimeDigest: DIGEST,
    hooksDigest: HDIGEST,
    upstream: FRESH_UPSTREAM,
  });
  assert.strictEqual(r.verdict, 'fresh');
  assert.strictEqual(typeof r.reason, 'string');
  assert.ok(r.reason.length > 0);
});

test('evaluateDrift: a null stamp → unstamped', () => {
  const r = rs.evaluateDrift({ stamp: null, runtimeDigest: DIGEST, hooksDigest: HDIGEST, upstream: FRESH_UPSTREAM });
  assert.strictEqual(r.verdict, 'unstamped');
  assert.match(r.reason, /stamp/i);
});

test('evaluateDrift: a digest mismatch → unverified (a foreign reinstall replaced the runtime)', () => {
  const r = rs.evaluateDrift({
    stamp: { ...VALID_STAMP, sha: SHA_A, runtime_digest: DIGEST },
    runtimeDigest: 'sha256:' + '0'.repeat(64),
    hooksDigest: HDIGEST,
    upstream: FRESH_UPSTREAM,
  });
  assert.strictEqual(r.verdict, 'unverified');
});

test('evaluateDrift: unverified takes precedence over a sha match AND over a sha mismatch', () => {
  const mismatched = 'sha256:' + '0'.repeat(64);
  for (const upstreamSha of [SHA_A, SHA_B]) {
    const r = rs.evaluateDrift({
      stamp: { ...VALID_STAMP, sha: SHA_A, runtime_digest: DIGEST },
      runtimeDigest: mismatched,
      hooksDigest: HDIGEST,
      upstream: { sha: upstreamSha, source: 'live', ageMs: 0 },
    });
    assert.strictEqual(r.verdict, 'unverified');
  }
});

test('evaluateDrift: digest matches but the SHAs differ → drifted, carrying both SHAs', () => {
  const r = rs.evaluateDrift({
    stamp: { ...VALID_STAMP, sha: SHA_A, runtime_digest: DIGEST },
    runtimeDigest: DIGEST,
    hooksDigest: HDIGEST,
    upstream: { sha: SHA_B, source: 'live', ageMs: 0 },
  });
  assert.strictEqual(r.verdict, 'drifted');
  assert.deepStrictEqual(r.behind, { stamped: SHA_A, upstream: SHA_B });
  assert.ok(r.reason.includes(SHA_A.slice(0, 8)) && r.reason.includes(SHA_B.slice(0, 8)));
});

test('evaluateDrift: a stale-cache upstream DISCLOSES the cache age in the reason', () => {
  const ageMs = 90 * 60 * 1000;
  for (const upstreamSha of [SHA_A, SHA_B]) {
    const r = rs.evaluateDrift({
      stamp: { ...VALID_STAMP, sha: SHA_A, runtime_digest: DIGEST },
      runtimeDigest: DIGEST,
      hooksDigest: HDIGEST,
      upstream: { sha: upstreamSha, source: 'stale-cache', ageMs },
    });
    assert.match(r.reason, /cached/i, 'a stale-cache adjudication must say so');
    assert.match(r.reason, /90 minutes/, 'the reason discloses the cache age');
  }
});

test('evaluateDrift returns EXACTLY one of the four verdicts, and only `fresh` is allow-shaped', () => {
  const verdicts = new Set([
    rs.evaluateDrift({ stamp: null, runtimeDigest: DIGEST, hooksDigest: HDIGEST, upstream: FRESH_UPSTREAM }).verdict,
    rs.evaluateDrift({ stamp: { ...VALID_STAMP, runtime_digest: 'sha256:' + '1'.repeat(64) }, runtimeDigest: DIGEST, hooksDigest: HDIGEST, upstream: FRESH_UPSTREAM }).verdict,
    rs.evaluateDrift({ stamp: { ...VALID_STAMP, sha: SHA_B, runtime_digest: DIGEST }, runtimeDigest: DIGEST, hooksDigest: HDIGEST, upstream: FRESH_UPSTREAM }).verdict,
    rs.evaluateDrift({ stamp: { ...VALID_STAMP, sha: SHA_A, runtime_digest: DIGEST }, runtimeDigest: DIGEST, hooksDigest: HDIGEST, upstream: FRESH_UPSTREAM }).verdict,
  ]);
  assert.deepStrictEqual([...verdicts].sort(), ['drifted', 'fresh', 'unstamped', 'unverified']);
  assert.deepStrictEqual([...rs.DENY_VERDICTS].sort(), ['drifted', 'unstamped', 'unverified']);
});

test('evaluateDrift is PURE — plain objects in, plain object out, no injected deps at all', () => {
  const before = JSON.stringify(VALID_STAMP);
  const r = rs.evaluateDrift({ stamp: VALID_STAMP, runtimeDigest: VALID_STAMP.runtime_digest, hooksDigest: HDIGEST, upstream: FRESH_UPSTREAM });
  assert.strictEqual(JSON.stringify(VALID_STAMP), before, 'evaluateDrift must not mutate its input');
  assert.strictEqual(typeof r, 'object');
  // No decision object — the GATE maps verdicts to decisions, so the CLI can reuse this.
  assert.strictEqual(r.permissionDecision, undefined);
});

// ───────────── quick 261017-w1i (CTK-ADR-0011): the managed gsd-core hooks ─────────────
//
// `sync` used to reinstall gsd-core without building its hooks, so install.js kept the OLD
// ~/.claude/hooks/* and the stamp (whose digest covered only ~/.claude/gsd-core) still read fresh.
// The stamp now binds the managed hook set: `hooks_files` (the built hooks/dist inventory) and
// `hooks_digest`. Every new export is touched INSIDE a test body, so a missing export fails its own
// test and never crashes this file.

/**
 * The D4 framing, computed by hand with node:crypto: a present file is `<rel> 0x00 <bytes> 0x00`,
 * a missing one is `<rel> 0x01 MISSING 0x00`, over the plain-sorted list.
 *
 * @param {Array<[string, (string|null)]>} entries rel and its content, or null for missing
 */
function handHooksDigest(entries) {
  const crypto = require('node:crypto');
  const h = crypto.createHash('sha256');
  for (const [rel, body] of entries.slice().sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    h.update(Buffer.from(rel, 'utf8'));
    if (body === null) {
      h.update(Buffer.from([0x01]));
      h.update(Buffer.from('MISSING', 'latin1'));
      h.update(Buffer.from([0x00]));
    } else {
      h.update(Buffer.from([0x00]));
      h.update(Buffer.from(body, 'utf8'));
      h.update(Buffer.from([0x00]));
    }
  }
  return 'sha256:' + h.digest('hex');
}

/** An fs seam whose every call throws, proving a code path never touches the filesystem. */
function throwIfCalled(name) {
  return () => { throw new Error('w1i: ' + name + ' must not be called'); };
}
const NO_FS = Object.freeze({
  readdirSync: throwIfCalled('readdirSync'),
  statSync: throwIfCalled('statSync'),
  lstatSync: throwIfCalled('lstatSync'),
  readFileSync: throwIfCalled('readFileSync'),
});

const HOOKS_TREE = Object.freeze({ 'gsd-a.js': 'console.log(1);\n', 'lib/b.sh': '#!/bin/sh\necho b\n' });

test('w1i: HOOKS_ROOT is the hooks dir beside the runtime root (path.dirname(RUNTIME_ROOT)/hooks)', () => {
  assert.strictEqual(rs.HOOKS_ROOT, path.join(path.dirname(rs.RUNTIME_ROOT), 'hooks'));
});

test('w1i: HOOK_MISSING_FRAME is the string 0x01 MISSING 0x00', () => {
  assert.strictEqual(rs.HOOK_MISSING_FRAME, '\u0001MISSING\u0000');
});

test('w1i: isManagedHookRel accepts one- or two-segment POSIX relpaths, dot-names included', () => {
  for (const rel of ['gsd-a.js', 'lib/b.sh', '.dot.js', 'lib/.x.sh', 'gsd-statusline.js']) {
    assert.strictEqual(rs.isManagedHookRel(rel), true, JSON.stringify(rel) + ' should be accepted');
  }
});

test('w1i: isManagedHookRel rejects empty, absolute, backslash, . and .. segments, deep, empty segments and control chars', () => {
  for (const rel of [
    '', '/abs', '/etc/passwd', 'lib\\b.sh', '..\\x', '../x', 'lib/../x', './x', 'lib/./x', '.', '..',
    'a/b/c', 'a//b', 'lib/', '/lib', 'a\u0007b', 'a\nb', 'lib/\u0000x', 'a\u007fb', 42, null, undefined, ['a'],
  ]) {
    assert.strictEqual(rs.isManagedHookRel(rel), false, JSON.stringify(rel) + ' should be rejected');
  }
});

test('w1i: hooksInventory lists depth-0 files and depth-1 files of a subdir, skips depth-2, keeps dot-names', () => {
  const fsx = makeFs('/h', {
    'gsd-a.js': 'a', 'lib/b.sh': 'b', 'lib/deep/c.js': 'c', 'lib/deeper/x/y.js': 'y', '.dot.js': 'd',
  });
  assert.deepStrictEqual(rs.hooksInventory('/h', fsx), ['.dot.js', 'gsd-a.js', 'lib/b.sh']);
});

test('w1i: hooksInventory returns relpaths sorted by plain Array#sort whatever the readdir order', () => {
  const fsx = makeFs('/h', { 'b.js': '1', 'B.js': '2', 'a.js': '3', 'lib/z.sh': '4', 'lib/Y.sh': '5' });
  const reversed = Object.assign({}, fsx, { readdirSync: (d) => fsx.readdirSync(d).slice().reverse() });
  const want = ['B.js', 'a.js', 'b.js', 'lib/Y.sh', 'lib/z.sh'];
  assert.deepStrictEqual(rs.hooksInventory('/h', fsx), want);
  assert.deepStrictEqual(rs.hooksInventory('/h', reversed), want);
});

test('w1i: hooksInventory returns [] for an absent root, a root that is a file, and an absent real path', () => {
  const fsx = makeFs('/h', { 'gsd-a.js': 'a' });
  assert.deepStrictEqual(rs.hooksInventory('/nope', fsx), []);
  const fileRoot = Object.assign({}, fsx, {
    readdirSync: () => { const e = new Error('ENOTDIR'); e.code = 'ENOTDIR'; throw e; },
  });
  assert.deepStrictEqual(rs.hooksInventory('/h/gsd-a.js', fileRoot), []);
  assert.deepStrictEqual(rs.hooksInventory(path.join(require('node:os').tmpdir(), 'w1i-absent-' + process.pid + '-' + Date.now())), []);
});

test('w1i: hooksDigest equals the D4 framing computed by hand', () => {
  const fsx = makeFs('/h', HOOKS_TREE);
  const got = rs.hooksDigest('/h', ['gsd-a.js', 'lib/b.sh'], fsx);
  assert.match(got, /^sha256:[0-9a-f]{64}$/);
  assert.strictEqual(got, handHooksDigest([['gsd-a.js', HOOKS_TREE['gsd-a.js']], ['lib/b.sh', HOOKS_TREE['lib/b.sh']]]));
});

test('w1i: hooksDigest over a REAL temp dir (the default bounded reader) equals the hand framing', (t) => {
  const nodeFs = require('node:fs');
  const os = require('node:os');
  const root = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'w1i-hooks-'));
  t.after(() => nodeFs.rmSync(root, { recursive: true, force: true }));
  nodeFs.mkdirSync(path.join(root, 'lib'));
  nodeFs.writeFileSync(path.join(root, 'gsd-a.js'), HOOKS_TREE['gsd-a.js']);
  nodeFs.writeFileSync(path.join(root, 'lib', 'b.sh'), HOOKS_TREE['lib/b.sh']);
  nodeFs.mkdirSync(path.join(root, 'dir.js'));
  const got = rs.hooksDigest(root, ['dir.js', 'gone.js', 'gsd-a.js', 'lib/b.sh']);
  assert.strictEqual(got, handHooksDigest([
    ['dir.js', null], ['gone.js', null], ['gsd-a.js', HOOKS_TREE['gsd-a.js']], ['lib/b.sh', HOOKS_TREE['lib/b.sh']],
  ]));
});

test('w1i: hooksDigest is list-order independent (it sorts a copy and leaves the caller list alone)', () => {
  const fsx = makeFs('/h', HOOKS_TREE);
  const list = ['lib/b.sh', 'gsd-a.js'];
  const a = rs.hooksDigest('/h', ['gsd-a.js', 'lib/b.sh'], fsx);
  const b = rs.hooksDigest('/h', list, fsx);
  assert.strictEqual(a, b);
  assert.deepStrictEqual(list, ['lib/b.sh', 'gsd-a.js'], 'the caller list is not sorted in place');
});

test('w1i: hooksDigest changes on one byte and on a rename', () => {
  const base = rs.hooksDigest('/h', ['gsd-a.js', 'lib/b.sh'], makeFs('/h', HOOKS_TREE));
  const oneByte = rs.hooksDigest('/h', ['gsd-a.js', 'lib/b.sh'],
    makeFs('/h', Object.assign({}, HOOKS_TREE, { 'gsd-a.js': 'console.log(2);\n' })));
  assert.notStrictEqual(base, oneByte);
  const renamedTree = { 'gsd-z.js': HOOKS_TREE['gsd-a.js'], 'lib/b.sh': HOOKS_TREE['lib/b.sh'] };
  const renamed = rs.hooksDigest('/h', ['gsd-z.js', 'lib/b.sh'], makeFs('/h', renamedTree));
  assert.notStrictEqual(base, renamed);
});

test('w1i: hooksDigest ignores an unlisted file under the root (a user hook never moves the digest)', () => {
  const a = rs.hooksDigest('/h', ['gsd-a.js', 'lib/b.sh'], makeFs('/h', HOOKS_TREE));
  const b = rs.hooksDigest('/h', ['gsd-a.js', 'lib/b.sh'],
    makeFs('/h', Object.assign({}, HOOKS_TREE, { 'artifact-gate.cjs': 'user', 'lib/user.sh': 'user' })));
  assert.strictEqual(a, b);
});

test('w1i: hooksDigest frames a directory at a listed path as missing, without reading it', () => {
  const fsx = makeFs('/h', { 'gsd-a.js/inner.txt': 'x', 'lib/b.sh': HOOKS_TREE['lib/b.sh'] });
  const reads = [];
  const spy = Object.assign({}, fsx, { readFileSync: (p) => { reads.push(p); return fsx.readFileSync(p); } });
  const got = rs.hooksDigest('/h', ['gsd-a.js', 'lib/b.sh'], spy);
  assert.strictEqual(got, handHooksDigest([['gsd-a.js', null], ['lib/b.sh', HOOKS_TREE['lib/b.sh']]]));
  assert.deepStrictEqual(reads, [path.join('/h', 'lib', 'b.sh')], 'only the regular file is read');
});

test('w1i: hooksDigest tells a missing file, an empty file and a file whose text is MISSING apart', () => {
  const missing = rs.hooksDigest('/h', ['gsd-a.js'], makeFs('/h', {}));
  const empty = rs.hooksDigest('/h', ['gsd-a.js'], makeFs('/h', { 'gsd-a.js': '' }));
  const text = rs.hooksDigest('/h', ['gsd-a.js'], makeFs('/h', { 'gsd-a.js': 'MISSING' }));
  const textFramed = rs.hooksDigest('/h', ['gsd-a.js'], makeFs('/h', { 'gsd-a.js': '\u0001MISSING' }));
  assert.strictEqual(new Set([missing, empty, text, textFramed]).size, 4);
  assert.strictEqual(missing, handHooksDigest([['gsd-a.js', null]]));
});

test('w1i: hooksDigest over an absent root frames every file as missing and differs from the all-present digest', () => {
  let got;
  assert.doesNotThrow(() => { got = rs.hooksDigest('/nope', ['gsd-a.js', 'lib/b.sh'], makeFs('/h', HOOKS_TREE)); });
  assert.strictEqual(got, handHooksDigest([['gsd-a.js', null], ['lib/b.sh', null]]));
  assert.notStrictEqual(got, rs.hooksDigest('/h', ['gsd-a.js', 'lib/b.sh'], makeFs('/h', HOOKS_TREE)));
});

test('w1i: hooksDigest throws FailClosed on a non-array list or an invalid relpath', () => {
  const fsx = makeFs('/h', HOOKS_TREE);
  for (const files of [undefined, null, 'gsd-a.js', 42, {}, ['../etc/passwd'], ['/etc/passwd'], ['lib\\b.sh'], ['a/b/c'], [''], [7]]) {
    assert.throws(() => rs.hooksDigest('/h', files, fsx), (e) => e instanceof FailClosed,
      'files ' + JSON.stringify(files) + ' should throw FailClosed');
  }
});

test('w1i: hooksDigest throws FailClosed naming the relpath when a regular file cannot be read', () => {
  const fsx = makeFs('/h', HOOKS_TREE);
  const boom = Object.assign({}, fsx, {
    readFileSync: (p) => {
      if (p.endsWith('b.sh')) { const e = new Error('EACCES: permission denied'); e.code = 'EACCES'; throw e; }
      return fsx.readFileSync(p);
    },
  });
  assert.throws(() => rs.hooksDigest('/h', ['gsd-a.js', 'lib/b.sh'], boom),
    (e) => e instanceof FailClosed && e.message.includes('lib/b.sh'));
});

test('w1i: hooksDigest over an unchanged tree returns the same value twice', () => {
  const fsx = makeFs('/h', HOOKS_TREE);
  assert.strictEqual(rs.hooksDigest('/h', ['gsd-a.js', 'lib/b.sh'], fsx), rs.hooksDigest('/h', ['gsd-a.js', 'lib/b.sh'], fsx));
});

test('w1i: hooksDigestForStamp is null for null/undefined and a hook-less stamp, with no filesystem access', () => {
  assert.strictEqual(typeof rs.hooksDigestForStamp, 'function');
  const legacy = Object.assign({}, VALID_STAMP);
  delete legacy.hooks_files;
  delete legacy.hooks_digest;
  assert.strictEqual(rs.hooksDigestForStamp(null, '/h', NO_FS), null);
  assert.strictEqual(rs.hooksDigestForStamp(undefined, '/h', NO_FS), null);
  assert.strictEqual(rs.hooksDigestForStamp(legacy, '/h', NO_FS), null);
});

test('w1i: hooksDigestForStamp equals hooksDigest(root, stamp.hooks_files) for a hook-carrying stamp', () => {
  const fsx = makeFs('/h', HOOKS_TREE);
  assert.strictEqual(
    rs.hooksDigestForStamp(VALID_STAMP, '/h', fsx),
    rs.hooksDigest('/h', VALID_STAMP.hooks_files, fsx)
  );
  assert.match(rs.hooksDigestForStamp(VALID_STAMP, '/h', fsx), /^sha256:[0-9a-f]{64}$/);
});

test('w1i: readStamp throws FailClosed on every malformed or half-present hook field', () => {
  const cases = [
    ['hooks_files only', { hooks_digest: undefined }],
    ['hooks_digest only', { hooks_files: undefined }],
    ['non-array hooks_files', { hooks_files: 'gsd-a.js' }],
    ['object hooks_files', { hooks_files: { 0: 'gsd-a.js' } }],
    ['empty hooks_files', { hooks_files: [] }],
    ['empty-string entry', { hooks_files: ['', 'gsd-a.js'] }],
    ['non-string entry', { hooks_files: [7] }],
    ['absolute entry', { hooks_files: ['/etc/passwd'] }],
    ['.. entry', { hooks_files: ['../x'] }],
    ['inner .. entry', { hooks_files: ['lib/../x'] }],
    ['backslash entry', { hooks_files: ['lib\\b.sh'] }],
    ['control-char entry', { hooks_files: ['gsd-\u0001a.js'] }],
    ['three-segment entry', { hooks_files: ['a/b/c.js'] }],
    ['unsorted', { hooks_files: ['lib/b.sh', 'gsd-a.js'] }],
    ['duplicated', { hooks_files: ['gsd-a.js', 'gsd-a.js'] }],
    ['malformed hooks_digest', { hooks_digest: 'sha256:zz' }],
    ['bare-hex hooks_digest', { hooks_digest: 'e'.repeat(64) }],
    ['numeric hooks_digest', { hooks_digest: 42 }],
    ['null hooks_digest', { hooks_digest: null }],
  ];
  for (const [label, patch] of cases) {
    const bad = JSON.stringify(Object.assign({}, VALID_STAMP, patch));
    assert.throws(
      () => rs.readStamp({ readFileSync: stampReader(bad), stampPath: '/s/x.json' }),
      (e) => e instanceof FailClosed,
      label + ' should be rejected'
    );
  }
});

test('w1i guard: a legacy stamp with neither hook field still reads back (old readers and old stamps stay valid)', () => {
  const legacy = Object.assign({}, VALID_STAMP);
  delete legacy.hooks_files;
  delete legacy.hooks_digest;
  const got = rs.readStamp({ readFileSync: stampReader(JSON.stringify(legacy)), stampPath: '/s/x.json' });
  assert.deepStrictEqual(got, legacy);
});

test('w1i guard: buildStamp without hooksFiles emits neither hook field (the legacy shape)', () => {
  const s = rs.buildStamp({ sha: SHA_A, runtimeDigest: DIGEST, mode: 'payload-verified', engineVerified: false, now: 'x' });
  assert.ok(!('hooks_files' in s));
  assert.ok(!('hooks_digest' in s));
  assert.strictEqual(s.schema, 1);
});

test('w1i: buildStamp with hooksFiles/hooksDigest emits sorted hooks_files and hooks_digest, schema still 1, and round-trips', () => {
  const files = ['lib/b.sh', 'gsd-a.js'];
  const s = rs.buildStamp({
    sha: SHA_A, runtimeDigest: DIGEST, mode: 'installed', engineVerified: true, now: '2026-10-17T00:00:00.000Z',
    hooksFiles: files, hooksDigest: HDIGEST,
  });
  assert.strictEqual(s.schema, 1);
  assert.strictEqual(rs.STAMP_SCHEMA, 1);
  assert.deepStrictEqual(s.hooks_files, ['gsd-a.js', 'lib/b.sh']);
  assert.deepStrictEqual(files, ['lib/b.sh', 'gsd-a.js'], 'buildStamp sorts a copy');
  assert.strictEqual(s.hooks_digest, HDIGEST);
  const writes = [];
  rs.writeStamp(s, { mkdirSync: () => {}, writeFileSync: (p, body) => writes.push(body), stampPath: '/s/runtime-stamp.json' });
  const back = rs.readStamp({ readFileSync: stampReader(writes[0]), stampPath: '/s/runtime-stamp.json' });
  assert.deepStrictEqual(back.hooks_files, ['gsd-a.js', 'lib/b.sh']);
  assert.strictEqual(back.hooks_digest, HDIGEST);
  assert.strictEqual(back.schema, 1);
});

test('w1i: evaluateDrift: a stamp with no hook fields is unverified, the reason says it predates hook coverage and to re-run sync', () => {
  const legacy = { ...VALID_STAMP, sha: SHA_A, runtime_digest: DIGEST };
  delete legacy.hooks_files;
  delete legacy.hooks_digest;
  const r = rs.evaluateDrift({ stamp: legacy, runtimeDigest: DIGEST, hooksDigest: null, upstream: FRESH_UPSTREAM });
  assert.strictEqual(r.verdict, 'unverified');
  assert.match(r.reason, /predates hook coverage/);
  assert.ok(r.reason.includes('~/.claude/hooks'), r.reason);
  assert.match(r.reason, /re-run[^.]*sync/, r.reason);
});

test('w1i: evaluateDrift: a hooks digest mismatch is unverified naming ~/.claude/hooks', () => {
  const r = rs.evaluateDrift({
    stamp: { ...VALID_STAMP, sha: SHA_A, runtime_digest: DIGEST },
    runtimeDigest: DIGEST,
    hooksDigest: 'sha256:' + '0'.repeat(64),
    upstream: FRESH_UPSTREAM,
  });
  assert.strictEqual(r.verdict, 'unverified');
  assert.ok(r.reason.includes('~/.claude/hooks'), r.reason);
  assert.ok(r.reason.includes(HDIGEST.slice(0, 19)), 'the stamped hooks digest prefix is shown: ' + r.reason);
});

test('w1i: evaluateDrift: a hook-carrying stamp with an undefined measured hooksDigest is unverified', () => {
  const r = rs.evaluateDrift({ stamp: { ...VALID_STAMP, runtime_digest: DIGEST }, runtimeDigest: DIGEST, upstream: FRESH_UPSTREAM });
  assert.strictEqual(r.verdict, 'unverified');
});

test('w1i: evaluateDrift follows the D5 order: unstamped, runtime digest, missing hook fields, hooks digest, then sha', () => {
  const legacy = { ...VALID_STAMP, sha: SHA_A, runtime_digest: DIGEST };
  delete legacy.hooks_files;
  delete legacy.hooks_digest;
  const OTHER_RT = 'sha256:' + '1'.repeat(64);
  const OTHER_H = 'sha256:' + '2'.repeat(64);
  const behind = { sha: SHA_B, source: 'live', ageMs: 0 };
  // 1. null stamp wins over everything
  assert.strictEqual(rs.evaluateDrift({ stamp: null, runtimeDigest: OTHER_RT, hooksDigest: OTHER_H, upstream: behind }).verdict, 'unstamped');
  // 2. a runtime digest mismatch gives the RUNTIME reason even when the hooks also differ
  const rt = rs.evaluateDrift({ stamp: { ...VALID_STAMP, runtime_digest: DIGEST }, runtimeDigest: OTHER_RT, hooksDigest: OTHER_H, upstream: behind });
  assert.strictEqual(rt.verdict, 'unverified');
  assert.ok(rt.reason.includes('~/.claude/gsd-core'), rt.reason);
  assert.ok(!rt.reason.includes('~/.claude/hooks'), 'the runtime reason, not the hooks one: ' + rt.reason);
  // 3. missing hook fields beat a sha mismatch
  const lg = rs.evaluateDrift({ stamp: legacy, runtimeDigest: DIGEST, hooksDigest: null, upstream: behind });
  assert.strictEqual(lg.verdict, 'unverified');
  assert.match(lg.reason, /predates hook coverage/);
  // 4. a hooks digest mismatch beats a sha mismatch
  const hm = rs.evaluateDrift({ stamp: { ...VALID_STAMP, runtime_digest: DIGEST }, runtimeDigest: DIGEST, hooksDigest: OTHER_H, upstream: behind });
  assert.strictEqual(hm.verdict, 'unverified');
  assert.ok(hm.reason.includes('~/.claude/hooks'), hm.reason);
  // 5. everything matching: the sha decides
  assert.strictEqual(rs.evaluateDrift({ stamp: { ...VALID_STAMP, runtime_digest: DIGEST }, runtimeDigest: DIGEST, hooksDigest: HDIGEST, upstream: behind }).verdict, 'drifted');
  assert.strictEqual(rs.evaluateDrift({ stamp: { ...VALID_STAMP, runtime_digest: DIGEST }, runtimeDigest: DIGEST, hooksDigest: HDIGEST, upstream: FRESH_UPSTREAM }).verdict, 'fresh');
});

test('w1i guard: runtimeDigest of the runtime tree is unchanged by files in the sibling hooks dir', () => {
  const without = rs.runtimeDigest('/h/.claude/gsd-core', makeFs('/h/.claude', { 'gsd-core/a.md': 'one' }));
  const withHooks = rs.runtimeDigest('/h/.claude/gsd-core',
    makeFs('/h/.claude', { 'gsd-core/a.md': 'one', 'hooks/gsd-a.js': 'x', 'hooks/lib/b.sh': 'y' }));
  assert.strictEqual(without, withHooks);
});

// ------------- quick 261024-po0 (CTK-ADR-0013): the session's Claude config dir -------------
//
// The oracle's roots and state follow CLAUDE_CONFIG_DIR (else <home>/.claude). Every case injects
// `env`, `homedir` and (where realpath matters) `realpathSync`, so the runner's own environment
// never leaks in. New exports are touched only inside test bodies, so a missing export fails its
// own case and never crashes this file.

const po0Crypto = require('node:crypto');

const PO0_HOME = '/h';
const PO0_DAILY = '/h/.claude';

/** A realpathSync stub: listed paths map to their target, every other path throws ENOENT. */
function po0Realpath(map = {}) {
  return (p) => {
    const k = path.resolve(String(p));
    if (Object.prototype.hasOwnProperty.call(map, k)) return map[k];
    const e = new Error('ENOENT: no such file or directory, realpath ' + k);
    e.code = 'ENOENT';
    throw e;
  };
}

/** The per-config-dir state key, computed independently of the module under test. */
function po0Key(cfg) {
  return po0Crypto.createHash('sha256').update(path.resolve(cfg)).digest('hex').slice(0, 16);
}

test('po0: classifyConfigDir with CLAUDE_CONFIG_DIR unset is daily <home>/.claude with tilde labels', () => {
  const d = rs.classifyConfigDir({}, { homedir: PO0_HOME, realpathSync: po0Realpath() });
  assert.strictEqual(d.kind, 'daily');
  assert.strictEqual(d.fromEnv, false);
  assert.strictEqual(d.configDir, PO0_DAILY);
  assert.strictEqual(d.runtimeRoot, path.join(PO0_DAILY, 'gsd-core'));
  assert.strictEqual(d.hooksRoot, path.join(PO0_DAILY, 'hooks'));
  assert.strictEqual(d.stateDir, path.join(PO0_HOME, '.gsd-contrib'));
  assert.strictEqual(d.runtimeLabel, '~/.claude/gsd-core');
  assert.strictEqual(d.hooksLabel, '~/.claude/hooks');
});

test('po0: classifyConfigDir with an undefined CLAUDE_CONFIG_DIR value is treated as unset (daily)', () => {
  const d = rs.classifyConfigDir({ CLAUDE_CONFIG_DIR: undefined }, { homedir: PO0_HOME, realpathSync: po0Realpath() });
  assert.strictEqual(d.kind, 'daily');
  assert.strictEqual(d.configDir, PO0_DAILY);
});

test('po0: classifyConfigDir with an absolute non-daily value is contrib with absolute roots and a per-dir state dir', () => {
  const cfg = '/h/.claude-contrib';
  const d = rs.classifyConfigDir({ CLAUDE_CONFIG_DIR: cfg }, { homedir: PO0_HOME, realpathSync: po0Realpath() });
  assert.strictEqual(d.kind, 'contrib');
  assert.strictEqual(d.fromEnv, true);
  assert.strictEqual(d.value, cfg);
  assert.strictEqual(d.configDir, cfg);
  assert.strictEqual(d.runtimeRoot, path.join(cfg, 'gsd-core'));
  assert.strictEqual(d.hooksRoot, path.join(cfg, 'hooks'));
  assert.strictEqual(d.stateDir, path.join(PO0_HOME, '.gsd-contrib', 'config-dirs', po0Key(cfg)));
  assert.strictEqual(d.runtimeLabel, path.join(cfg, 'gsd-core'));
  assert.strictEqual(d.hooksLabel, path.join(cfg, 'hooks'));
});

test('po0: classifyConfigDir resolves an absolute value with path.resolve (a trailing slash and a doubled slash collapse)', () => {
  const a = rs.classifyConfigDir({ CLAUDE_CONFIG_DIR: '/srv//contrib/' }, { homedir: PO0_HOME, realpathSync: po0Realpath() });
  assert.strictEqual(a.kind, 'contrib');
  assert.strictEqual(a.configDir, '/srv/contrib');
  assert.strictEqual(a.value, '/srv//contrib/', 'the raw value is kept verbatim beside the resolved dir');
});

for (const value of ['', '   ', 'rel/x', './x', '~', '~/x', '~user/x']) {
  test('po0: classifyConfigDir with CLAUDE_CONFIG_DIR=' + JSON.stringify(value) + ' is invalid, never normalized', () => {
    const d = rs.classifyConfigDir({ CLAUDE_CONFIG_DIR: value }, { homedir: PO0_HOME, realpathSync: po0Realpath() });
    assert.strictEqual(d.kind, 'invalid');
    assert.strictEqual(d.fromEnv, true);
    assert.strictEqual(d.value, value);
    assert.strictEqual(d.configDir, null);
    assert.strictEqual(d.runtimeRoot, null);
    assert.strictEqual(d.hooksRoot, null);
    assert.strictEqual(d.stateDir, null);
    assert.strictEqual(typeof d.reason, 'string');
    assert.ok(d.reason.includes(JSON.stringify(value)), 'the reason quotes the raw value: ' + d.reason);
    assert.ok(d.reason.includes('CLAUDE_CONFIG_DIR'), d.reason);
  });
}

test('po0: resolveConfigDir is pure and reports unset, valid and invalid values', () => {
  assert.deepStrictEqual(rs.resolveConfigDir({}, PO0_HOME), { configDir: PO0_DAILY, fromEnv: false, invalid: false });
  const ok = rs.resolveConfigDir({ CLAUDE_CONFIG_DIR: '/c/x/' }, PO0_HOME);
  assert.strictEqual(ok.configDir, '/c/x');
  assert.strictEqual(ok.fromEnv, true);
  assert.strictEqual(ok.invalid, false);
  const bad = rs.resolveConfigDir({ CLAUDE_CONFIG_DIR: '~/x' }, PO0_HOME);
  assert.strictEqual(bad.invalid, true);
  assert.strictEqual(bad.configDir, null);
  assert.ok(bad.reason.includes(JSON.stringify('~/x')));
  assert.strictEqual(rs.CONFIG_DIR_ENV, 'CLAUDE_CONFIG_DIR');
});

test('po0: isDailyConfigDir is true for the daily dir itself, with a trailing slash, a doubled slash and a symlink to it', () => {
  const rp = po0Realpath({ '/h/.claude': '/h/.claude', '/links/daily': '/h/.claude' });
  const o = { homedir: PO0_HOME, realpathSync: rp };
  assert.strictEqual(rs.isDailyConfigDir('/h/.claude', o), true);
  assert.strictEqual(rs.isDailyConfigDir('/h/.claude/', o), true);
  assert.strictEqual(rs.isDailyConfigDir('/h//.claude', o), true);
  assert.strictEqual(rs.isDailyConfigDir('/links/daily', o), true);
});

test('po0: isDailyConfigDir is true when cfg/gsd-core or cfg/hooks resolves at or inside the daily dir, or cfg lies inside it', () => {
  const rp = po0Realpath({
    '/h/.claude': '/h/.claude',
    '/c1/gsd-core': '/h/.claude/gsd-core',
    '/c2/hooks': '/h/.claude/hooks',
    '/c3/gsd-core': '/h/.claude',
  });
  const o = { homedir: PO0_HOME, realpathSync: rp };
  assert.strictEqual(rs.isDailyConfigDir('/c1', o), true, 'gsd-core symlinked into the daily dir');
  assert.strictEqual(rs.isDailyConfigDir('/c2', o), true, 'hooks symlinked into the daily dir');
  assert.strictEqual(rs.isDailyConfigDir('/c3', o), true, 'gsd-core resolving AT the daily dir');
  assert.strictEqual(rs.isDailyConfigDir('/h/.claude/nested', o), true, 'cfg inside the daily dir');
});

test('po0: isDailyConfigDir is false for the sibling <home>/.claude-contrib (a string-prefix collision) and an unrelated dir', () => {
  const rp = po0Realpath({ '/h/.claude': '/h/.claude' });
  const o = { homedir: PO0_HOME, realpathSync: rp };
  assert.strictEqual(rs.isDailyConfigDir('/h/.claude-contrib', o), false);
  assert.strictEqual(rs.isDailyConfigDir('/srv/contrib', o), false);
});

test('po0: isDailyConfigDir falls back to path.resolve when realpath throws for every path', () => {
  const o = { homedir: PO0_HOME, realpathSync: po0Realpath() };
  assert.strictEqual(rs.isDailyConfigDir('/h/.claude/', o), true);
  assert.strictEqual(rs.isDailyConfigDir('/h/.claude-contrib', o), false);
});

test('po0: classifyConfigDir is daily for an absolute value that is a symlink to the daily dir, with a reason', () => {
  const rp = po0Realpath({ '/h/.claude': '/h/.claude', '/links/daily': '/h/.claude' });
  const d = rs.classifyConfigDir({ CLAUDE_CONFIG_DIR: '/links/daily' }, { homedir: PO0_HOME, realpathSync: rp });
  assert.strictEqual(d.kind, 'daily');
  assert.strictEqual(d.stateDir, path.join(PO0_HOME, '.gsd-contrib'), 'the daily stamp path does not move');
  assert.ok(d.reason.length > 0, 'the daily reason says which test made it daily');
});

test('po0: resolveStateDir per config dir: override wins, daily keeps ~/.gsd-contrib, contrib gets config-dirs/<16 hex>', () => {
  const o = { homedir: PO0_HOME };
  assert.strictEqual(rs.resolveStateDir({}, o), path.join(PO0_HOME, '.gsd-contrib'));
  assert.strictEqual(rs.resolveStateDir({ CLAUDE_CONFIG_DIR: '/h/.claude' }, o), path.join(PO0_HOME, '.gsd-contrib'));
  const a = rs.resolveStateDir({ CLAUDE_CONFIG_DIR: '/c/a' }, o);
  const b = rs.resolveStateDir({ CLAUDE_CONFIG_DIR: '/c/b' }, o);
  assert.strictEqual(a, path.join(PO0_HOME, '.gsd-contrib', 'config-dirs', po0Key('/c/a')));
  assert.notStrictEqual(a, b, 'two contribution dirs get two state dirs');
  assert.strictEqual(rs.resolveStateDir({ CLAUDE_CONFIG_DIR: '/c/a/' }, o), a, 'a trailing slash maps to the same key');
  assert.strictEqual(rs.resolveStateDir({ CLAUDE_CONFIG_DIR: '/c/a', GSD_CONTRIB_STATE_DIR: '/s' }, o), '/s');
  assert.strictEqual(rs.resolveStateDir({ CLAUDE_CONFIG_DIR: 'rel/x', GSD_CONTRIB_STATE_DIR: '/s' }, o), '/s',
    'the override wins over every config dir, an invalid one included');
  assert.strictEqual(rs.stampPath({ CLAUDE_CONFIG_DIR: '/c/a' }, o), path.join(a, 'runtime-stamp.json'));
  assert.strictEqual(rs.cachePath({ CLAUDE_CONFIG_DIR: '/c/a' }, o), path.join(a, 'upstream-tip-cache.json'));
  assert.strictEqual(rs.stampPath({}, o), path.join(PO0_HOME, '.gsd-contrib', 'runtime-stamp.json'));
});

test('po0: resolveStateDir throws FailClosed for an invalid CLAUDE_CONFIG_DIR with no override', () => {
  assert.throws(() => rs.resolveStateDir({ CLAUDE_CONFIG_DIR: 'rel/x' }, { homedir: PO0_HOME }), FailClosed);
  assert.throws(() => rs.resolveStateDir({ CLAUDE_CONFIG_DIR: '' }, { homedir: PO0_HOME }), FailClosed);
});

test('po0: runtimeRootFor and hooksRootFor return the classified roots and throw FailClosed on invalid', () => {
  const o = { homedir: PO0_HOME, realpathSync: po0Realpath() };
  assert.strictEqual(rs.runtimeRootFor({}, o), path.join(PO0_DAILY, 'gsd-core'));
  assert.strictEqual(rs.hooksRootFor({}, o), path.join(PO0_DAILY, 'hooks'));
  assert.strictEqual(rs.runtimeRootFor({ CLAUDE_CONFIG_DIR: '/c/a' }, o), '/c/a/gsd-core');
  assert.strictEqual(rs.hooksRootFor({ CLAUDE_CONFIG_DIR: '/c/a' }, o), '/c/a/hooks');
  assert.throws(() => rs.runtimeRootFor({ CLAUDE_CONFIG_DIR: '~/x' }, o), FailClosed);
  assert.throws(() => rs.hooksRootFor({ CLAUDE_CONFIG_DIR: './x' }, o), FailClosed);
});

test('po0: CONTRIB_SESSION_HINT is one printable-ASCII string naming the launch form, the default and the scrub variable', () => {
  const h = rs.CONTRIB_SESSION_HINT;
  assert.strictEqual(typeof h, 'string');
  assert.ok(h.includes('CLAUDE_CONFIG_DIR='), h);
  assert.ok(h.includes('$HOME/.claude-contrib'), h);
  assert.ok(h.includes('CLAUDE_CODE_SUBPROCESS_ENV_SCRUB'), h);
  assert.ok(/^[\x20-\x7e\n]*$/.test(h), 'printable ASCII only');
});

function po0LoadChild(value) {
  const { spawnSync } = require('node:child_process');
  const nodeOs = require('node:os');
  const nodeFs = require('node:fs');
  const home = nodeFs.mkdtempSync(path.join(nodeOs.tmpdir(), 'po0-load-'));
  const env = { PATH: process.env.PATH || '', HOME: home };
  if (value !== undefined) env.CLAUDE_CONFIG_DIR = value;
  const mod = path.join(__dirname, 'runtime-stamp.cjs');
  const r = spawnSync(process.execPath, ['-e',
    'const m=require(' + JSON.stringify(mod) + ');process.stdout.write(JSON.stringify({r:m.RUNTIME_ROOT,h:m.HOOKS_ROOT}))'],
  { env, encoding: 'utf8', timeout: 30000 });
  nodeFs.rmSync(home, { recursive: true, force: true });
  return { home, r };
}

for (const value of ['', 'rel/x', '~/x']) {
  test('po0: requiring runtime-stamp.cjs with CLAUDE_CONFIG_DIR=' + JSON.stringify(value) + ' never throws and keeps the daily default constants', () => {
    const { home, r } = po0LoadChild(value);
    assert.strictEqual(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.strictEqual(out.r, path.join(home, '.claude', 'gsd-core'));
    assert.strictEqual(out.h, path.join(path.dirname(out.r), 'hooks'));
    // Paired with a function call: the decision paths use the functions, which refuse the value.
    assert.strictEqual(rs.classifyConfigDir({ CLAUDE_CONFIG_DIR: value }, { homedir: home }).kind, 'invalid');
  });
}

test('po0: requiring runtime-stamp.cjs with an absolute CLAUDE_CONFIG_DIR sets RUNTIME_ROOT to <value>/gsd-core', () => {
  const { r } = po0LoadChild('/srv/po0-contrib');
  assert.strictEqual(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.strictEqual(out.r, path.join('/srv/po0-contrib', 'gsd-core'));
  assert.strictEqual(out.h, path.join('/srv/po0-contrib', 'hooks'));
});

test('po0: evaluateDrift names runtimeLabel and hooksLabel in its unverified reasons when given', () => {
  const OTHER_RT = 'sha256:' + '1'.repeat(64);
  const OTHER_H = 'sha256:' + '2'.repeat(64);
  const HD = 'sha256:' + 'e'.repeat(64);
  const RD = 'sha256:' + 'f'.repeat(64);
  const base = {
    schema: rs.STAMP_SCHEMA, sha: SHA_A, runtime_digest: RD, mode: 'installed', engine_verified: true,
    installed_at: '2026-10-24T00:00:00.000Z', source: rs.UPSTREAM_URL + '#' + rs.UPSTREAM_REF,
    hooks_files: ['gsd-a.js'], hooks_digest: HD,
  };
  const labels = { runtimeLabel: '/c/a/gsd-core', hooksLabel: '/c/a/hooks' };
  const up = { sha: SHA_A, source: 'live', ageMs: 0 };
  const rt = rs.evaluateDrift(Object.assign({ stamp: base, runtimeDigest: OTHER_RT, hooksDigest: HD, upstream: up }, labels));
  assert.ok(rt.reason.includes('/c/a/gsd-core'), rt.reason);
  assert.ok(!rt.reason.includes('~/.claude/gsd-core'), rt.reason);
  const legacy = Object.assign({}, base);
  delete legacy.hooks_files;
  delete legacy.hooks_digest;
  const lg = rs.evaluateDrift(Object.assign({ stamp: legacy, runtimeDigest: RD, hooksDigest: null, upstream: up }, labels));
  assert.ok(lg.reason.includes('/c/a/hooks'), lg.reason);
  const hm = rs.evaluateDrift(Object.assign({ stamp: base, runtimeDigest: RD, hooksDigest: OTHER_H, upstream: up }, labels));
  assert.ok(hm.reason.includes('/c/a/hooks'), hm.reason);
  assert.ok(!hm.reason.includes('~/.claude/hooks'), hm.reason);
});

test('po0 guard: evaluateDrift without labels keeps ~/.claude/gsd-core and ~/.claude/hooks', () => {
  const RD = 'sha256:' + 'f'.repeat(64);
  const HD = 'sha256:' + 'e'.repeat(64);
  const base = {
    schema: rs.STAMP_SCHEMA, sha: SHA_A, runtime_digest: RD, mode: 'installed', engine_verified: true,
    installed_at: '2026-10-24T00:00:00.000Z', source: rs.UPSTREAM_URL + '#' + rs.UPSTREAM_REF,
    hooks_files: ['gsd-a.js'], hooks_digest: HD,
  };
  const up = { sha: SHA_A, source: 'live', ageMs: 0 };
  assert.ok(rs.evaluateDrift({ stamp: base, runtimeDigest: 'sha256:' + '1'.repeat(64), hooksDigest: HD, upstream: up })
    .reason.includes('~/.claude/gsd-core'));
  assert.ok(rs.evaluateDrift({ stamp: base, runtimeDigest: RD, hooksDigest: 'sha256:' + '2'.repeat(64), upstream: up })
    .reason.includes('~/.claude/hooks'));
});

test('po0: readStamp/writeStamp round-trip and upstreamTip cache writes land in the per-config-dir state dir', (t) => {
  const nodeFs = require('node:fs');
  const nodeOs = require('node:os');
  const home = nodeFs.mkdtempSync(path.join(nodeOs.tmpdir(), 'po0-state-'));
  t.after(() => nodeFs.rmSync(home, { recursive: true, force: true }));
  const cfg = path.join(home, 'contrib-a');
  const env = { CLAUDE_CONFIG_DIR: cfg };
  const stateDir = path.join(home, '.gsd-contrib', 'config-dirs', po0Key(cfg));
  // SAFETY: prove the default paths resolve under the temp home BEFORE any default write runs, so
  // a module that ignores {env, homedir} fails here and never writes the real daily stamp or cache.
  assert.strictEqual(rs.stampPath(env, { homedir: home }), path.join(stateDir, 'runtime-stamp.json'));
  assert.strictEqual(rs.cachePath(env, { homedir: home }), path.join(stateDir, 'upstream-tip-cache.json'));
  const stamp = rs.buildStamp({
    sha: SHA_A, runtimeDigest: 'sha256:' + 'f'.repeat(64), mode: 'installed', engineVerified: true,
    now: '2026-10-24T00:00:00.000Z', hooksFiles: ['gsd-a.js'], hooksDigest: 'sha256:' + 'e'.repeat(64),
  });
  const written = rs.writeStamp(stamp, { env, homedir: home });
  assert.strictEqual(written, path.join(stateDir, 'runtime-stamp.json'));
  assert.ok(nodeFs.existsSync(written));
  assert.ok(!nodeFs.existsSync(path.join(home, '.gsd-contrib', 'runtime-stamp.json')), 'the daily stamp is untouched');
  assert.deepStrictEqual(rs.readStamp({ env, homedir: home }), stamp);
  assert.strictEqual(rs.readStamp({ env: { CLAUDE_CONFIG_DIR: path.join(home, 'contrib-b') }, homedir: home }), null,
    'a second contribution dir has its own (absent) stamp');
  const tip = rs.upstreamTip({ env, homedir: home, fetchTip: () => SHA_B, now: () => Date.parse('2026-10-24T00:00:00.000Z') });
  assert.strictEqual(tip.sha, SHA_B);
  const cache = JSON.parse(nodeFs.readFileSync(path.join(stateDir, 'upstream-tip-cache.json'), 'utf8'));
  assert.strictEqual(cache.sha, SHA_B);
  assert.ok(!nodeFs.existsSync(path.join(home, '.gsd-contrib', 'upstream-tip-cache.json')), 'the daily cache is untouched');
});

// Verifier finding (quick 261024-po0): a DANGLING symlink cannot be realpath'd, and the plain
// path.resolve fallback is the link's own path, so a cfg/hooks or cfg/gsd-core link aimed at a
// not-yet-existing path inside the daily dir classified as a contribution dir. Real fs, temp home.
test('po0: a dangling cfg/hooks or cfg/gsd-core symlink aimed inside the daily dir is daily', (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'po0-dangling-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'h');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  for (const sub of ['hooks', 'gsd-core']) {
    const cfg = path.join(root, 'c-' + sub);
    fs.mkdirSync(cfg);
    fs.symlinkSync(path.join(home, '.claude', sub + '-not-yet'), path.join(cfg, sub));
    assert.strictEqual(fs.existsSync(path.join(cfg, sub)), false, 'the link must dangle');
    assert.strictEqual(rs.isDailyConfigDir(cfg, { homedir: home }), true, 'dangling ' + sub + ' link into the daily dir');
    // A relative dangling link is resolved against the link's own directory.
    const cfgRel = path.join(root, 'r-' + sub);
    fs.mkdirSync(cfgRel);
    fs.symlinkSync(path.relative(cfgRel, path.join(home, '.claude', sub + '-later')), path.join(cfgRel, sub));
    assert.strictEqual(rs.isDailyConfigDir(cfgRel, { homedir: home }), true, 'relative dangling ' + sub + ' link');
  }
  // A dangling link that points OUTSIDE the daily dir stays a contribution dir.
  const ok = path.join(root, 'ok');
  fs.mkdirSync(ok);
  fs.symlinkSync(path.join(root, 'elsewhere', 'hooks'), path.join(ok, 'hooks'));
  assert.strictEqual(rs.isDailyConfigDir(ok, { homedir: home }), false);
});
