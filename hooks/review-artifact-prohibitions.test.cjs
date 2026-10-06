'use strict';

/**
 * node:test — the five Phase 38 prohibitions (38-05), as SUBJECT-INJECTABLE negative tests.
 *
 * The subject is loaded from `GSD_PROHIB_SUBJECT` (resolved against the cwd, the gsd-core #1279
 * convention) when set, else from ./prohibition-subjects/real.cjs (the shipped modules). A subject
 * exports {reviewArtifact, toolLogReader, toolRecorder, adrText}. The prohibition prover runs this
 * file three ways: with no subject and with the real subject (both must pass), and with each
 * `prohibition-subjects/p<k>-*.cjs` violation subject (each must fail its own `38-05 P<k>` rows).
 *
 *   P1 (MEMEV-01 safety)       a cannot-observe case never resolves to allow; it asks
 *   P2 (MEMEV-02 safety)       foreign / verdict-row / failed / misnamed / malformed / body evidence never counts
 *   P3 (MEMEV-04 safety)       R8a-memtrace.json never allows; its scaffold pre-fills nothing
 *   P4 (MEMEV-02 privacy)      a decision reason never echoes recorder log content
 *   P5 (MEMEV-02 transparency) the ADR records Dave's acceptance and says the evidence is not proof of targeting
 *
 * Every gate call goes through `S.reviewArtifact.runReviewArtifactGate`, with `readToolLog`
 * ALWAYS injected (the gate's own default binds the shipped reader at import, which a subject
 * could not replace). Real-file rows are written with `S.toolRecorder` into a fresh mkdtemp dir
 * and read with `S.toolLogReader.readSessionRecords` through an explicit env; the real
 * ~/.gsd-contrib log is never read or written.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Before ANY subject loads: no override valve, and the gate's own verdict log goes to a temp dir.
delete process.env.GSD_CONTRIB_OVERRIDE;
process.env.GSD_CONTRIB_LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rev-art-prohib-vlog-'));
const TEMP_DIRS = [process.env.GSD_CONTRIB_LOG_DIR];
process.on('exit', () => {
  for (const d of TEMP_DIRS) fs.rmSync(d, { recursive: true, force: true });
});

const S = process.env.GSD_PROHIB_SUBJECT
  ? require(path.resolve(process.cwd(), process.env.GSD_PROHIB_SUBJECT))
  : require('./prohibition-subjects/real.cjs');

// The scaffold renderer is not a subject property: P3 checks the SPEC a subject's GATES carries.
const { scaffold } = require('./lib/scaffold.cjs');

// ── fixtures (self-contained; nothing from review-artifact.test.cjs) ──────────

const HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const PR = 42;
const MT = 'mcp__memtrace__';
const SESSION = 'sess-38-05';
const APPROVE = 'gh pr review 42 --approve';

const ANALYSIS_AT = Date.parse('2026-07-29T11:00:00.000Z');

function dirFor() {
  return S.reviewArtifact.ARTIFACT_DIR + '/' + S.reviewArtifact.reviewSlug(PR, HEAD);
}

const R8A_FILE = 'R8a-memtrace.json';

function text(obj) {
  return JSON.stringify(obj, null, 2) + '\n';
}

function baseFiles() {
  const dir = dirFor();
  return {
    [dir + '/R8-code-review.json']: text({
      schema: 1,
      pass: 'code-review',
      head_oid: HEAD,
      command: '/code-review on the delta (gh pr diff 42)',
      verdict: 'PASS — no correctness findings on the change itself',
      findings: [],
    }),
    [dir + '/R8-security-review.json']: text({
      schema: 1,
      pass: 'security-review',
      head_oid: HEAD,
      command: '/security-review on the delta',
      verdict: 'PASS — no code surface',
      findings: [],
    }),
    [dir + '/R10-exogenous.json']: text({
      schema: 1,
      head_oid: HEAD,
      reviewer: 'feature-dev:code-reviewer (fresh subagent, given diff + blockers + ADRs only)',
      withheld_verdict: true,
      conclusion: 'all blocking findings are resolved',
      independent_judgement: [{ finding: 'Blocker 1', judgement: 'resolved' }],
      primary_source_checks: [{ claim: 'Blocker 1 resolved', quote: 'src/core.cts:44 + const tier = catalog[key]' }],
    }),
  };
}

/** A PreToolUse payload. `sessionId: null` omits the key. */
function input(command, sessionId = SESSION) {
  const payload = { tool_name: 'Bash', tool_input: { command } };
  if (sessionId !== null) payload.session_id = sessionId;
  return JSON.stringify(payload);
}

/** The reader's result shape. */
function toolLog(records, over = {}) {
  return Object.assign({ recorderOff: false, complete: true, records, problems: [] }, over);
}

/**
 * Hermetic deps: PR 42 at HEAD, R8-code / R8-security / R10 present and valid, no posted reviews,
 * a recording writeScaffold, a non-overriding override. `readToolLog` is REQUIRED (never defaulted).
 */
function deps(readToolLog, extraFiles = {}) {
  assert.strictEqual(typeof readToolLog, 'function', 'readToolLog is always injected');
  const files = Object.assign(baseFiles(), extraFiles);
  const calls = { scaffolded: [], readToolLog: [] };
  return {
    worktreeRoot: '/tmp/wt',
    _calls: calls,
    resolvePr: () => ({ number: PR, headOid: HEAD }),
    resolveIsPullRequest: () => true,
    artifactExists: (rel) => files[rel] !== undefined,
    readArtifactText: (rel) => {
      if (files[rel] === undefined) throw new Error('could not read `' + rel + '`');
      return files[rel];
    },
    artifactMtimeMs: () => ANALYSIS_AT,
    writeScaffold: (rel) => {
      calls.scaffolded.push(rel);
      return { written: true, path: '/tmp/wt/' + rel, bytes: 512 };
    },
    readPostedReviews: () => [],
    readBodyFile: () => {
      throw new Error('no body file in this fixture');
    },
    readToolLog: (sid) => {
      calls.readToolLog.push(sid);
      return readToolLog(sid);
    },
    overrideImpl: { checkOverride: () => ({ override: false }), writeReceipt: () => {} },
  };
}

function gate(command, dp, sessionId = SESSION) {
  return S.reviewArtifact.runReviewArtifactGate(input(command, sessionId), dp);
}

// ── real-file fixtures (tool-recorder writes, tool-log-reader reads, explicit env) ──

function freshLogDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rev-art-prohib-log-'));
  TEMP_DIRS.push(dir);
  return dir;
}

/** Append recorder rows built by the subject's own recordToolCall + serializeRecord + appendRecord. */
function recordRows(dir, sessionId, rows) {
  const R = S.toolRecorder;
  for (const r0 of rows) {
    const r = typeof r0 === 'string' ? { tool_name: r0 } : r0;
    const fail = r.outcome === 'fail';
    const payload = {
      hook_event_name: fail ? 'PostToolUseFailure' : 'PostToolUse',
      session_id: sessionId,
      tool_use_id: r.tool_use_id || 'toolu_38_05',
      tool_name: r.tool_name,
      tool_input: r.tool_name === 'Bash' ? { command: 'ls' } : {},
      cwd: r.cwd || '/tmp/wt',
    };
    if (fail) payload.error = 'boom';
    else payload.tool_response = {};
    const rdeps = { env: {} };
    if (r.ts) rdeps.now = () => r.ts;
    const line = R.serializeRecord(R.recordToolCall(JSON.stringify(payload), rdeps));
    assert.ok(line, 'the recorder produced a line for ' + r.tool_name);
    assert.ok(R.appendRecord(line, { env: { GSD_CONTRIB_LOG_DIR: dir } }), 'the recorder appended a line');
  }
}

/** Append a raw (hand-written) line to the fixture log. */
function rawLine(dir, line) {
  fs.appendFileSync(path.join(dir, S.toolRecorder.LOG_FILENAME), line + '\n', 'utf8');
}

/** A readToolLog reading the fixture dir through the subject's reader and an explicit env. */
function realReader(dir) {
  return (sid) => S.toolLogReader.readSessionRecords(sid, { env: { GSD_CONTRIB_LOG_DIR: dir } });
}

function assertDeny(d) {
  assert.notStrictEqual(d.permissionDecision, 'allow', 'never allow: ' + d.permissionDecisionReason);
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
  assert.match(d.permissionDecisionReason, /R8a-memtrace/, 'the deny comes from the step-8a obligation');
}

function assertAsk(d) {
  assert.notStrictEqual(d.permissionDecision, 'allow', 'never allow: ' + d.permissionDecisionReason);
  assert.strictEqual(d.permissionDecision, 'ask', d.permissionDecisionReason);
  assert.match(d.permissionDecisionReason, /R8a-memtrace/, 'the ask comes from the step-8a obligation');
}

// ── P1 (MEMEV-01 safety): cannot-observe never resolves to allow ────────────

test('38-05 P1 cannot-observe: a payload without session_id → ask, never allow', () => {
  const dp = deps(() => toolLog([]));
  assertAsk(gate(APPROVE, dp, null));
});

test('38-05 P1 cannot-observe: readToolLog reports recorderOff (GSD_CONTRIB_RECORD=off) → ask, never allow', () => {
  const dp = deps(() => ({ recorderOff: true, complete: false, records: [], problems: ['recorder off'] }));
  assertAsk(gate(APPROVE, dp));
});

test('38-05 P1 cannot-observe: complete:false with zero records (absent or unreadable log) → ask, never allow', () => {
  const dp = deps(() => toolLog([], { complete: false, problems: ['log absent: tool-log.jsonl, tool-log.1.jsonl'] }));
  assertAsk(gate(APPROVE, dp));
});

test('38-05 P1 cannot-observe: complete:true with only failed rows (zero successful) → ask, never allow', () => {
  const dp = deps(() =>
    toolLog([
      { tool_name: MT + 'get_impact', outcome: 'fail' },
      { tool_name: MT + 'get_symbol_context', outcome: 'fail' },
      { tool_name: MT + 'recall_decision', outcome: 'fail' },
      { tool_name: 'Bash', outcome: 'fail' },
    ])
  );
  assertAsk(gate(APPROVE, dp));
});

test('38-05 P1 cannot-observe: complete:false with a shortfall (no get_impact seen, part of the log unread) → ask, never allow', () => {
  const dp = deps(() =>
    toolLog(
      [
        { tool_name: MT + 'get_symbol_context', outcome: 'ok' },
        { tool_name: MT + 'recall_decision', outcome: 'ok' },
        { tool_name: 'Bash', outcome: 'ok' },
      ],
      { complete: false, problems: ['unreadable tool-log.1.jsonl: EACCES'] }
    )
  );
  assertAsk(gate(APPROVE, dp));
});

// ── P2 (MEMEV-02 safety): only own, successful, exactly-named recorder rows count ─

const THREE = [MT + 'get_impact', MT + 'get_symbol_context', MT + 'recall_decision'];

test("38-05 P2 evidence (real file): another session's three memtrace rows + an own Bash row → deny", () => {
  const dir = freshLogDir();
  recordRows(dir, 'sess-38-05-other', THREE);
  recordRows(dir, SESSION, ['Bash']);
  assertDeny(gate(APPROVE, deps(realReader(dir))));
});

test('38-05 P2 evidence (real file): an own gate-verdict-shaped row naming get_impact never counts → deny', () => {
  const dir = freshLogDir();
  rawLine(
    dir,
    JSON.stringify({
      ts: '2026-10-06T00:00:00.000Z',
      source: 'pretooluse-gate',
      session_id: SESSION,
      tool_name: MT + 'get_impact',
      outcome: 'ok',
      cwd: '/tmp/wt',
    })
  );
  recordRows(dir, SESSION, [MT + 'get_symbol_context', MT + 'recall_decision']);
  assertDeny(gate(APPROVE, deps(realReader(dir))));
});

test('38-05 P2 evidence (real file): own memtrace rows all failed + an own successful Bash row → deny', () => {
  const dir = freshLogDir();
  recordRows(dir, SESSION, THREE.map((t) => ({ tool_name: t, outcome: 'fail' })));
  recordRows(dir, SESSION, ['Bash']);
  assertDeny(gate(APPROVE, deps(realReader(dir))));
});

test('38-05 P2 evidence (real file): own `mcp__memtrace__get_impact_v2` never satisfies get_impact → deny', () => {
  const dir = freshLogDir();
  recordRows(dir, SESSION, [MT + 'get_impact_v2', MT + 'get_symbol_context', MT + 'recall_decision']);
  assertDeny(gate(APPROVE, deps(realReader(dir))));
});

test('38-05 P2 evidence (real file): a malformed own line naming all three tools + an own Bash row → deny', () => {
  const dir = freshLogDir();
  rawLine(
    dir,
    '{"session_id":' + JSON.stringify(SESSION) + ',"tool_name":"' + THREE.join('","tool_name":"') + '","outcome":"ok"'
  );
  recordRows(dir, SESSION, ['Bash']);
  assertDeny(gate(APPROVE, deps(realReader(dir))));
});

test('38-05 P2 evidence (real file): a `### Memtrace Evidence` review body naming every tool, only own Bash rows → deny', () => {
  const dir = freshLogDir();
  recordRows(dir, SESSION, ['Bash']);
  const all = [...S.reviewArtifact.MEMTRACE_REQUIRED_ALL, ...S.reviewArtifact.MEMTRACE_REQUIRED_ANY].map((v) =>
    v.startsWith(MT) ? v : MT + v
  );
  const body = '## Re-Review\n\n### Memtrace Evidence\n' + all.map((t) => '- ' + t + ': ran, no impact').join('\n');
  assertDeny(gate(APPROVE + ' --body "' + body + '"', deps(realReader(dir))));
});

// ── P3 (MEMEV-04 safety): R8a-memtrace.json never allows; its scaffold pre-fills nothing ──

const ONLY_BASH = () => toolLog([{ tool_name: 'Bash', outcome: 'ok' }]);

function r8aSpec() {
  const e = S.reviewArtifact.GATES.find((g) => g.id === 'R8a-memtrace');
  assert.ok(e, 'the R8a-memtrace gate entry exists');
  assert.ok(e.spec && typeof e.spec === 'object', 'R8a-memtrace carries a scaffold spec');
  return e.spec;
}

test('38-05 P3 attestation: a filled valid R8a-memtrace.json with missing evidence → ask, never allow', () => {
  const filled = {
    schema: 1,
    pass: 'memtrace-unavailable',
    head_oid: HEAD,
    status: 'unavailable',
    unavailable_reason: 'memtrace sidecar down; used grep + /code-review',
  };
  const dp = deps(ONLY_BASH, { [dirFor() + '/' + R8A_FILE]: text(filled) });
  assertAsk(gate(APPROVE, dp));
});

test('38-05 P3 scaffold: the R8a spec pre-fills no status; head_oid, status and unavailable_reason render as FILL sentinels', () => {
  const spec = r8aSpec();
  const constants = spec.constants || {};
  for (const k of ['status', 'unavailable_reason', 'head_oid']) {
    assert.ok(!Object.prototype.hasOwnProperty.call(constants, k), 'the scaffold constants pre-fill `' + k + '`');
  }
  const doc = JSON.parse(scaffold(spec));
  for (const k of ['head_oid', 'status', 'unavailable_reason']) {
    assert.ok(typeof doc[k] === 'string' && doc[k].startsWith('<<<FILL:' + k + '>>>'), k + ' is a FILL sentinel: ' + doc[k]);
  }
  assert.notStrictEqual(doc.status, 'unavailable', 'status is never pre-filled');
});

test('38-05 P3 scaffold: a freshly rendered R8a scaffold present as the artifact, missing evidence → deny', () => {
  const dp = deps(ONLY_BASH, { [dirFor() + '/' + R8A_FILE]: scaffold(r8aSpec()) });
  assertDeny(gate(APPROVE, dp));
});

// ── P4 (MEMEV-02 privacy): a decision reason never echoes log content ───────

const MARK = Object.freeze({
  cwd: '/tmp/CWDMARK_38_05_P4',
  tuid: 'TUIDMARK_38_05_P4',
  ts: 'TSMARK_38_05_P4',
  tool: 'mcp__secret__TOOLMARK_38_05_P4',
  other: 'SESSMARK_38_05_P4',
});

function assertNoMarkers(why, own) {
  for (const m of ['CWDMARK_38_05_P4', 'TUIDMARK_38_05_P4', 'TSMARK_38_05_P4', 'TOOLMARK_38_05_P4', 'SESSMARK_38_05_P4']) {
    assert.ok(!why.includes(m), 'the reason leaks ' + m + ': ' + why);
  }
  assert.ok(!why.includes(own), 'the reason leaks the session id: ' + why);
}

test('38-05 P4 privacy (real file, deny): cwd, tool_use_id, ts, a non-required tool and another session id never reach the reason', () => {
  const own = 'sess-38-05-p4-deny';
  const dir = freshLogDir();
  recordRows(dir, MARK.other, THREE.map((t) => ({ tool_name: t, cwd: MARK.cwd })));
  recordRows(dir, own, [
    { tool_name: 'Bash', cwd: MARK.cwd, tool_use_id: MARK.tuid, ts: MARK.ts },
    { tool_name: MARK.tool, cwd: MARK.cwd, tool_use_id: MARK.tuid + '_2', ts: MARK.ts },
  ]);
  const d = gate(APPROVE, deps(realReader(dir)), own);
  assertDeny(d);
  assertNoMarkers(d.permissionDecisionReason, own);
});

test('38-05 P4 privacy (real file, ask): own rows with markers, all failed → the ask reason carries no marker', () => {
  const own = 'sess-38-05-p4-ask';
  const dir = freshLogDir();
  recordRows(dir, MARK.other, THREE.map((t) => ({ tool_name: t, cwd: MARK.cwd })));
  recordRows(dir, own, [
    { tool_name: 'Bash', outcome: 'fail', cwd: MARK.cwd, tool_use_id: MARK.tuid, ts: MARK.ts },
    { tool_name: MT + 'get_impact', outcome: 'fail', cwd: MARK.cwd, tool_use_id: MARK.tuid + '_2', ts: MARK.ts },
    { tool_name: MARK.tool, outcome: 'fail', cwd: MARK.cwd, tool_use_id: MARK.tuid + '_3', ts: MARK.ts },
  ]);
  const d = gate(APPROVE, deps(realReader(dir)), own);
  assertAsk(d);
  assertNoMarkers(d.permissionDecisionReason, own);
});

// -- P5 (MEMEV-02 transparency): the ADR records Dave's acceptance and limits its claim --

function statusParagraph(adr) {
  const lines = adr.split('\n');
  const i = lines.findIndex((l) => /^- \*\*Status:\*\*/.test(l));
  assert.ok(i !== -1, 'the ADR has a "- **Status:**" line');
  const para = [];
  for (let j = i; j < lines.length && lines[j].trim() !== '' && (j === i || !/^- \*\*/.test(lines[j])); j++) {
    para.push(lines[j]);
  }
  return { line: lines[i], para: para.join(' ') };
}

test('38-05 P5 transparency: the step-8a ADR Status line is Accepted and its status paragraph records the sign-off, never the pending wording', () => {
  const { line, para } = statusParagraph(S.adrText());
  assert.match(line, /^- \*\*Status:\*\* Accepted/, line);
  assert.doesNotMatch(line, /^- \*\*Status:\*\*\s*Proposed/, line);
  const text = para.replace(/\s+/g, ' ');
  assert.ok(text.includes('Dave has approved this record'), text);
  assert.doesNotMatch(text, /has not approved|becomes Accepted, or is superseded|until then|not an approved one|awaits? Dave/i, text);
});

test('38-05 P5 transparency: the ADR says the recorder evidence is `not proof` of what was analysed', () => {
  assert.ok(S.adrText().includes('not proof'), 'the ADR states the targeting limit (`not proof`)');
});
