'use strict';

/**
 * node:test for hooks/tool-recorder.cjs (OBS-01, the executed-call recorder).
 *
 * Driven via the injectable recordToolCall(stdinString, deps) / appendRecord(line, deps) seams:
 * the environment, the clock, the cwd and the filesystem are all INJECTED, so the unit suite is
 * hermetic — matching the convention in hooks/protocol-artifact.test.cjs.
 *
 * The two load-bearing properties, both ASSERTED rather than assumed:
 *
 *   FAIL-OPEN (D3)  — every hostile input yields `null`, never a throw; and the SPAWNED hook exits
 *                     0 with EMPTY stdout on garbage. This is the one hook in the suite that must
 *                     never fail closed, because there is no decision left to fail closed on.
 *   NO PAYLOADS (D2)— a `Write` payload's `tool_input.content` and a `Bash` payload's raw command
 *                     are proven ABSENT from the serialized record, by searching the serialized
 *                     bytes for the secret itself.
 *
 * Coverage:
 *   - PostToolUse payload                        → outcome 'ok'
 *   - PostToolUseFailure payload                 → outcome 'fail' + a redacted error_kind
 *   - malformed / empty / non-object stdin       → null, no throw (the fail-open proof)
 *   - some OTHER event (PreToolUse)              → null (not ours to record)
 *   - Write payload carrying a secret            → the secret is ABSENT from the record
 *   - Bash payload                               → action + governed populated, raw command absent
 *   - GSD_CONTRIB_RECORD=off                     → no record
 *   - pathological oversized fields              → serialized line stays < 4096 bytes
 *   - error_kind redaction (paths/tokens/bodies) → dropped, never leaked
 *   - log path resolution (D1) + env override
 *   - rotation at 50 MB, and a best-effort drop when the log dir cannot be created
 *   - end-to-end: the spawned hook exits 0, writes nothing to stdout, appends exactly one line
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const {
  recordToolCall,
  serializeRecord,
  appendRecord,
  resolveLogDir,
  errorKind,
  looksSensitive,
  outcomeOf,
  MAX_RECORD_BYTES,
  MAX_LOG_BYTES,
  LOG_FILENAME,
  ROTATED_FILENAME,
  LOG_DIRNAME,
} = require('./tool-recorder.cjs');

const HOOK_PATH = path.join(__dirname, 'tool-recorder.cjs');

/** A frozen clock + cwd + empty env, so every record is deterministic. */
function deps(over = {}) {
  return Object.assign(
    {
      env: {},
      now: () => '2026-07-29T12:00:00.000Z',
      cwd: () => '/home/dave/repos/gsd-core',
    },
    over
  );
}

/** A successful PostToolUse payload. */
function post(over = {}) {
  return JSON.stringify(
    Object.assign(
      {
        hook_event_name: 'PostToolUse',
        session_id: 'sess-abc',
        tool_use_id: 'toolu_01',
        tool_name: 'Read',
        cwd: '/home/dave/repos/gsd-core',
        duration_ms: 42,
        tool_input: { file_path: '/etc/hosts' },
        tool_response: { file: { numLines: 12 } },
      },
      over
    )
  );
}

/** A PostToolUseFailure payload (carries `error` + `is_interrupt` INSTEAD of `tool_response`). */
function fail(over = {}) {
  return JSON.stringify(
    Object.assign(
      {
        hook_event_name: 'PostToolUseFailure',
        session_id: 'sess-abc',
        tool_use_id: 'toolu_02',
        tool_name: 'Bash',
        cwd: '/home/dave/repos/gsd-core',
        duration_ms: 7,
        is_interrupt: false,
        tool_input: { command: 'ls /nope' },
        error: 'ENOENT: no such file or directory',
      },
      over
    )
  );
}

// ── the two outcome streams ─────────────────────────────────────────────────

test('a PostToolUse payload records outcome "ok"', () => {
  const rec = recordToolCall(post(), deps());
  assert.strictEqual(rec.outcome, 'ok');
  assert.strictEqual(rec.tool_name, 'Read');
  assert.strictEqual(rec.session_id, 'sess-abc');
  assert.strictEqual(rec.tool_use_id, 'toolu_01');
  assert.strictEqual(rec.duration_ms, 42);
  assert.strictEqual(rec.cwd, '/home/dave/repos/gsd-core');
  assert.strictEqual(rec.ts, '2026-07-29T12:00:00.000Z');
  assert.ok(!('error_kind' in rec), 'a success carries no error_kind');
});

test('a PostToolUseFailure payload records outcome "fail" with a redacted error_kind', () => {
  const rec = recordToolCall(fail(), deps());
  assert.strictEqual(rec.outcome, 'fail');
  assert.strictEqual(rec.error_kind, 'ENOENT');
  // The MESSAGE BODY never survives — only the leading class token.
  assert.ok(!serializeRecord(rec).includes('no such file'), 'the error body must not be recorded');
});

test('the outcome is inferred from SHAPE when the event name is absent (rename-tolerant)', () => {
  assert.strictEqual(outcomeOf({ tool_response: {} }), 'ok');
  assert.strictEqual(outcomeOf({ error: 'boom' }), 'fail');
  assert.strictEqual(outcomeOf({}), null);
  // camelCase spelling is accepted too.
  assert.strictEqual(outcomeOf({ hookEventName: 'PostToolUse' }), 'ok');
});

test('some OTHER event is not ours to record', () => {
  const pre = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } });
  assert.strictEqual(recordToolCall(pre, deps()), null);
  const prompt = JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'hi' });
  assert.strictEqual(recordToolCall(prompt, deps()), null);
});

// ── FAIL-OPEN (D3): hostile input never throws ──────────────────────────────

test('malformed / empty / non-object stdin → null, NEVER a throw (the fail-open proof)', () => {
  for (const bad of ['', '   ', '{not json', 'null', '[]', '"a string"', '42', undefined, null, {}]) {
    let rec;
    assert.doesNotThrow(() => {
      rec = recordToolCall(bad, deps());
    }, 'input ' + JSON.stringify(bad) + ' must not throw');
    assert.strictEqual(rec, null, 'input ' + JSON.stringify(bad) + ' must record nothing');
  }
});

test('serializeRecord tolerates a null / non-object record', () => {
  assert.strictEqual(serializeRecord(null), null);
  assert.strictEqual(serializeRecord(undefined), null);
  assert.strictEqual(serializeRecord('nope'), null);
});

// ── D2: no payload content, ever ────────────────────────────────────────────

test('a Write payload NEVER records tool_input.content (the D2 guarantee, asserted)', () => {
  const SECRET = 'ghp_thisIsAFakeTokenThatMustNeverBeLogged1234';
  const payload = post({
    tool_name: 'Write',
    tool_input: { file_path: '/tmp/x.env', content: 'API_KEY=' + SECRET + '\nmore secret file body' },
    tool_response: { ok: true },
  });
  const rec = recordToolCall(payload, deps());
  const line = serializeRecord(rec);
  assert.ok(line, 'a Write call is still recorded');
  assert.ok(!line.includes(SECRET), 'the file content must be ABSENT from the record');
  assert.ok(!line.includes('API_KEY'), 'no fragment of the content may leak');
  assert.ok(!line.includes('more secret file body'), 'no fragment of the content may leak');
  // A non-Bash tool carries no classification fields at all.
  assert.ok(!('action' in rec), 'action is a Bash-only field');
  assert.ok(!('governed' in rec), 'governed is a Bash-only field');
});

test('a Bash payload records the CLASSIFIED action, never the raw command', () => {
  const SECRET = 'AWS_SECRET_ACCESS_KEY_abcdefghijklmnop';
  const payload = post({
    tool_name: 'Bash',
    tool_input: { command: 'git push origin fix/1234-slug # ' + SECRET },
  });
  const rec = recordToolCall(payload, deps());
  const line = serializeRecord(rec);
  assert.strictEqual(rec.action, 'push');
  assert.strictEqual(rec.governed, true);
  assert.ok(!line.includes(SECRET), 'the raw command must be ABSENT from the record');
  assert.ok(!line.includes('git push'), 'the raw command must be ABSENT from the record');
  assert.ok(!line.includes('fix/1234-slug'), 'the raw command must be ABSENT from the record');
});

test('an ungoverned Bash command is recorded as such (the denominator L1 needs)', () => {
  const rec = recordToolCall(post({ tool_name: 'Bash', tool_input: { command: 'ls -la' } }), deps());
  assert.strictEqual(rec.action, 'other');
  assert.strictEqual(rec.governed, false);
});

test('an unparseable Bash command degrades to a classification, never a throw', () => {
  const rec = recordToolCall(post({ tool_name: 'Bash', tool_input: { command: 'git push "unterminated' } }), deps());
  assert.ok(rec, 'the call is still recorded');
  assert.strictEqual(rec.governed, false, 'an unclassifiable command is not claimed as governed');
});

test('a Bash payload with no command at all still records', () => {
  const rec = recordToolCall(post({ tool_name: 'Bash', tool_input: {} }), deps());
  assert.ok(rec);
  assert.strictEqual(rec.governed, false);
});

// ── D6: kill switch ─────────────────────────────────────────────────────────

test('GSD_CONTRIB_RECORD=off disables recording entirely', () => {
  assert.strictEqual(recordToolCall(post(), deps({ env: { GSD_CONTRIB_RECORD: 'off' } })), null);
  assert.strictEqual(recordToolCall(post(), deps({ env: { GSD_CONTRIB_RECORD: ' OFF ' } })), null);
  // Anything else leaves it ON — this is an opt-OUT, not an opt-in.
  assert.ok(recordToolCall(post(), deps({ env: { GSD_CONTRIB_RECORD: 'on' } })));
  assert.ok(recordToolCall(post(), deps({ env: {} })));
});

// ── D4: bounded records ─────────────────────────────────────────────────────

test('a pathological payload still serializes well under 4096 bytes (atomic-append bound)', () => {
  const huge = 'A'.repeat(200000);
  const payload = post({
    session_id: huge,
    tool_use_id: huge,
    tool_name: huge,
    cwd: '/' + huge,
    tool_input: { command: huge, content: huge },
    duration_ms: 1e300,
  });
  const rec = recordToolCall(payload, deps());
  const line = serializeRecord(rec);
  assert.ok(line, 'a bounded record is still produced');
  assert.ok(
    Buffer.byteLength(line, 'utf8') < 4096,
    'serialized record must stay under the 4096-byte POSIX atomic-append floor (got ' +
      Buffer.byteLength(line, 'utf8') + ')'
  );
  assert.ok(MAX_RECORD_BYTES < 4096, 'the enforced cap itself is below 4096');
});

test('control characters cannot tear one record into two log lines', () => {
  const rec = recordToolCall(post({ session_id: 'a\nb\r\nc', cwd: '/x\u0000/y' }), deps());
  const line = serializeRecord(rec);
  assert.strictEqual(line.split('\n').filter(Boolean).length, 1, 'exactly one JSONL line');
  assert.strictEqual(rec.session_id, 'a b c');
});

test('a record that cannot be bounded is DROPPED rather than written un-bounded', () => {
  assert.strictEqual(serializeRecord({ blob: 'z'.repeat(MAX_RECORD_BYTES + 10) }), null);
});

// ── error_kind redaction ────────────────────────────────────────────────────

test('errorKind keeps a class token and refuses anything path/token/secret-shaped', () => {
  assert.strictEqual(errorKind('TypeError: cannot read x'), 'TypeError');
  assert.strictEqual(errorKind({ code: 'ENOENT', message: 'nope' }), 'ENOENT');
  assert.strictEqual(errorKind({ name: 'AbortError' }), 'AbortError');
  // A leading token that is a path, a URL, an assignment or an opaque blob is DROPPED.
  assert.strictEqual(errorKind('/home/dave/secret/path failed'), null);
  assert.strictEqual(errorKind('https://api.github.com/x 404'), null);
  assert.strictEqual(errorKind('TOKEN=ghp_abcdefghijklmnopqrst nope'), null);
  assert.strictEqual(errorKind('ghp_abcdefghijklmnopqrstuvwx'), null);
  assert.strictEqual(errorKind(null), null);
  assert.strictEqual(errorKind(undefined), null);
});

test('looksSensitive is deliberately over-broad (a false refusal costs one null field)', () => {
  assert.ok(looksSensitive('a/b'));
  assert.ok(looksSensitive('C:\\x'));
  assert.ok(looksSensitive('K=V'));
  assert.ok(looksSensitive('user@host'));
  assert.ok(looksSensitive('abcdefghijklmnopqrstuvwxyz'));
  assert.ok(!looksSensitive('ENOENT'));
});

// ── D1: the log location ────────────────────────────────────────────────────

test('the default log path is USER-level, never per-worktree (D1)', () => {
  const dir = resolveLogDir({});
  assert.strictEqual(dir, path.join(os.homedir(), LOG_DIRNAME));
  assert.ok(!dir.includes('worktree'), 'the log must not live anywhere worktree cleanup can reach');
});

test('GSD_CONTRIB_LOG_DIR overrides the directory', () => {
  assert.strictEqual(resolveLogDir({ GSD_CONTRIB_LOG_DIR: '/tmp/obs' }), '/tmp/obs');
  assert.strictEqual(resolveLogDir({ GSD_CONTRIB_LOG_DIR: '   ' }), path.join(os.homedir(), LOG_DIRNAME));
});

// ── D4: rotation + best-effort append ───────────────────────────────────────

test('appendRecord rotates ONCE past 50 MB, overwriting the previous rotation', () => {
  const calls = { renamed: null, appended: null };
  const fsImpl = {
    mkdirSync: () => {},
    statSync: () => ({ size: MAX_LOG_BYTES + 1 }),
    renameSync: (from, to) => {
      calls.renamed = [from, to];
    },
    appendFileSync: (f, line) => {
      calls.appended = [f, line];
    },
  };
  const out = appendRecord('{"a":1}\n', { env: { GSD_CONTRIB_LOG_DIR: '/tmp/obs' }, fsImpl });
  assert.strictEqual(out, path.join('/tmp/obs', LOG_FILENAME));
  assert.deepStrictEqual(calls.renamed, [
    path.join('/tmp/obs', LOG_FILENAME),
    path.join('/tmp/obs', ROTATED_FILENAME),
  ]);
  assert.strictEqual(calls.appended[1], '{"a":1}\n');
});

test('appendRecord does NOT rotate below the threshold, and tolerates an absent log', () => {
  let renamed = false;
  const fsImpl = {
    mkdirSync: () => {},
    statSync: () => {
      throw new Error('ENOENT');
    },
    renameSync: () => {
      renamed = true;
    },
    appendFileSync: () => {},
  };
  appendRecord('{"a":1}\n', { env: { GSD_CONTRIB_LOG_DIR: '/tmp/obs' }, fsImpl });
  assert.strictEqual(renamed, false, 'an absent log has nothing to rotate');
});

test('an uncreatable log directory drops the record SILENTLY (best-effort, D4)', () => {
  const fsImpl = {
    mkdirSync: () => {
      throw new Error('EACCES');
    },
    statSync: () => ({ size: 0 }),
    renameSync: () => {},
    appendFileSync: () => {
      throw new Error('must not be reached');
    },
  };
  let out;
  assert.doesNotThrow(() => {
    out = appendRecord('{"a":1}\n', { env: { GSD_CONTRIB_LOG_DIR: '/tmp/obs' }, fsImpl });
  });
  assert.strictEqual(out, null);
});

test('a failing append drops the record rather than escalating', () => {
  const fsImpl = {
    mkdirSync: () => {},
    statSync: () => ({ size: 0 }),
    renameSync: () => {},
    appendFileSync: () => {
      throw new Error('ENOSPC');
    },
  };
  assert.strictEqual(appendRecord('{"a":1}\n', { env: { GSD_CONTRIB_LOG_DIR: '/tmp/obs' }, fsImpl }), null);
  assert.strictEqual(appendRecord('', { env: { GSD_CONTRIB_LOG_DIR: '/tmp/obs' }, fsImpl }), null);
  assert.strictEqual(appendRecord(null, { env: { GSD_CONTRIB_LOG_DIR: '/tmp/obs' }, fsImpl }), null);
});

// ── end-to-end: the SPAWNED hook is silent, exits 0, and writes exactly one line ──

/** Spawn the real hook with a temp log dir. Returns {status, stdout, stderr, lines}. */
function spawnHook(stdin, envOver = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'obs01-'));
  try {
    const res = spawnSync(process.execPath, [HOOK_PATH], {
      input: stdin,
      encoding: 'utf8',
      env: Object.assign({}, process.env, { GSD_CONTRIB_LOG_DIR: dir }, envOver),
    });
    const file = path.join(dir, LOG_FILENAME);
    const lines = fs.existsSync(file)
      ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
      : [];
    return { status: res.status, stdout: res.stdout, stderr: res.stderr, lines };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('the spawned hook exits 0, emits NOTHING on stdout, and appends exactly one line', () => {
  const r = spawnHook(post());
  assert.strictEqual(r.status, 0, 'exit 0 always');
  assert.strictEqual(r.stdout, '', 'a PostToolUse hook must emit no decision — stdout stays empty');
  assert.strictEqual(r.lines.length, 1, 'exactly one JSONL line');
  const rec = JSON.parse(r.lines[0]);
  assert.strictEqual(rec.outcome, 'ok');
  assert.strictEqual(rec.tool_name, 'Read');
});

test('the spawned hook survives garbage on stdin: exit 0, no stdout, no record', () => {
  for (const bad of ['', '{not json', 'null', '\u0000\u0001']) {
    const r = spawnHook(bad);
    assert.strictEqual(r.status, 0, 'garbage must still exit 0: ' + JSON.stringify(bad));
    assert.strictEqual(r.stdout, '', 'garbage must still produce no stdout');
    assert.strictEqual(r.lines.length, 0, 'garbage records nothing');
  }
});

test('the spawned hook honours the kill switch end to end', () => {
  const r = spawnHook(post(), { GSD_CONTRIB_RECORD: 'off' });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '');
  assert.strictEqual(r.lines.length, 0);
});

test('the hook file parses under node --check (it ships as a wired hook)', () => {
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', HOOK_PATH], { stdio: 'ignore' }));
});
