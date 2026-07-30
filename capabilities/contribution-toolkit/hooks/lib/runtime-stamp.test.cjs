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

const VALID_STAMP = Object.freeze({
  schema: 1,
  sha: SHA_A,
  runtime_digest: 'sha256:' + 'f'.repeat(64),
  mode: 'payload-verified',
  engine_verified: false,
  installed_at: '2026-07-30T00:00:00.000Z',
  source: 'https://github.com/open-gsd/gsd-core.git#next',
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
    upstream: FRESH_UPSTREAM,
  });
  assert.strictEqual(r.verdict, 'fresh');
  assert.strictEqual(typeof r.reason, 'string');
  assert.ok(r.reason.length > 0);
});

test('evaluateDrift: a null stamp → unstamped', () => {
  const r = rs.evaluateDrift({ stamp: null, runtimeDigest: DIGEST, upstream: FRESH_UPSTREAM });
  assert.strictEqual(r.verdict, 'unstamped');
  assert.match(r.reason, /stamp/i);
});

test('evaluateDrift: a digest mismatch → unverified (a foreign reinstall replaced the runtime)', () => {
  const r = rs.evaluateDrift({
    stamp: { ...VALID_STAMP, sha: SHA_A, runtime_digest: DIGEST },
    runtimeDigest: 'sha256:' + '0'.repeat(64),
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
      upstream: { sha: upstreamSha, source: 'live', ageMs: 0 },
    });
    assert.strictEqual(r.verdict, 'unverified');
  }
});

test('evaluateDrift: digest matches but the SHAs differ → drifted, carrying both SHAs', () => {
  const r = rs.evaluateDrift({
    stamp: { ...VALID_STAMP, sha: SHA_A, runtime_digest: DIGEST },
    runtimeDigest: DIGEST,
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
      upstream: { sha: upstreamSha, source: 'stale-cache', ageMs },
    });
    assert.match(r.reason, /cached/i, 'a stale-cache adjudication must say so');
    assert.match(r.reason, /90 minutes/, 'the reason discloses the cache age');
  }
});

test('evaluateDrift returns EXACTLY one of the four verdicts, and only `fresh` is allow-shaped', () => {
  const verdicts = new Set([
    rs.evaluateDrift({ stamp: null, runtimeDigest: DIGEST, upstream: FRESH_UPSTREAM }).verdict,
    rs.evaluateDrift({ stamp: { ...VALID_STAMP, runtime_digest: 'sha256:' + '1'.repeat(64) }, runtimeDigest: DIGEST, upstream: FRESH_UPSTREAM }).verdict,
    rs.evaluateDrift({ stamp: { ...VALID_STAMP, sha: SHA_B, runtime_digest: DIGEST }, runtimeDigest: DIGEST, upstream: FRESH_UPSTREAM }).verdict,
    rs.evaluateDrift({ stamp: { ...VALID_STAMP, sha: SHA_A, runtime_digest: DIGEST }, runtimeDigest: DIGEST, upstream: FRESH_UPSTREAM }).verdict,
  ]);
  assert.deepStrictEqual([...verdicts].sort(), ['drifted', 'fresh', 'unstamped', 'unverified']);
  assert.deepStrictEqual([...rs.DENY_VERDICTS].sort(), ['drifted', 'unstamped', 'unverified']);
});

test('evaluateDrift is PURE — plain objects in, plain object out, no injected deps at all', () => {
  const before = JSON.stringify(VALID_STAMP);
  const r = rs.evaluateDrift({ stamp: VALID_STAMP, runtimeDigest: VALID_STAMP.runtime_digest, upstream: FRESH_UPSTREAM });
  assert.strictEqual(JSON.stringify(VALID_STAMP), before, 'evaluateDrift must not mutate its input');
  assert.strictEqual(typeof r, 'object');
  // No decision object — the GATE maps verdicts to decisions, so the CLI can reuse this.
  assert.strictEqual(r.permissionDecision, undefined);
});
