'use strict';

/**
 * node:test pins for 261006-jqh: every returned (policy) deny tells the truth about the
 * `GSD_CONTRIB_OVERRIDE` valve.
 *
 * The mechanism (hooks/lib/failclosed.cjs runGateInner): a gate that RETURNS deny gets deny back
 * with no override check; only a THROWN gate error reaches the catch, which consults
 * override.checkOverride() and, when set, writes a receipt and allows. So the override rescues
 * thrown gate errors only and never lifts a returned policy deny.
 *
 * D1: override semantics are unchanged; the `semantics:` tests below pass before AND after the fix.
 * D2: scope is every policy deny whose text claimed the override bypasses it: ENF-20 OVERRIDE_NOTE
 *     (missingText, shortfallText, liveText), ENF-19 denialText, ENF-12 `--no-verify`, ENF-11
 *     likely duplicate.
 * D3: each such deny keeps its own fix steps, then says the override does not lift it, then names
 *     the accountable off switch `node bin/contrib-capability.cjs off --reason "<why>"`. Plain ASCII.
 *
 * The `truthful:` tests fail on the pre-fix text; the `semantics:` tests pin today's decisions.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Before ANY hook is required: verdict rows go to a temp dir (never the shared
// ~/.gsd-contrib log), and no inherited override reaches the in-process gates.
process.env.GSD_CONTRIB_LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'override-note-vlog-'));
process.on('exit', () => fs.rmSync(process.env.GSD_CONTRIB_LOG_DIR, { recursive: true, force: true }));
delete process.env.GSD_CONTRIB_OVERRIDE;

const reviewArtifact = require('./review-artifact.cjs');
const protocolArtifact = require('./protocol-artifact.cjs');
const { runGithooksGate } = require('./githooks-seal.cjs');
const { runDedupeGate } = require('./issue-dedupe.cjs');
const { recordToolCall, serializeRecord, LOG_FILENAME } = require('./tool-recorder.cjs');

// The phrases that made the pre-fix text false, copied from the source lines:
// review-artifact.cjs:870 + protocol-artifact.cjs:617, githooks-seal.cjs:108, issue-dedupe.cjs:440.
const FALSE_CLAIMS = [
  'Deliberate bypass',
  'If a bypass is TRULY necessary, use',
  'to override (logged)',
  // Review round 2: false as a global statement (ENF-07 honors the override in its own policy
  // path), and `off` strips only the toolkit's tagged gates in one gsd-core checkout.
  'it rescues thrown gate errors only',
  'turns off every toolkit gate',
];
const TRUTH_MARKERS = [
  'does not lift this deny',
  'this gate honors it only for a thrown gate error',
  // The off switch is agent-runnable (README "what the hooks cannot stop"), so a deny names it only
  // as a human operator's decision, never as a way past the deny.
  "a human operator's decision, not a way past this deny",
  'contrib-capability.cjs off --reason',
];
const ASCII = /^[\x00-\x7F]*$/;

function assertTruthful(label, reason, tail) {
  assert.strictEqual(typeof reason, 'string', label + ': reason is a string');
  for (const c of FALSE_CLAIMS) {
    assert.ok(!reason.includes(c), label + ': reason still claims a bypass (' + c + '):\n' + reason);
  }
  for (const m of TRUTH_MARKERS) {
    assert.ok(reason.includes(m), label + ': reason lacks "' + m + '":\n' + reason);
  }
  assert.ok(ASCII.test(tail), label + ': rewritten tail is not plain ASCII:\n' + tail);
}

const lastParagraph = (s) => s.split('\n\n').pop();

// -- ENF-20 builders: six gates x three builders -----------------------------

const { missingText, shortfallText, liveText, GATES } = reviewArtifact;
const RA_REL = '.gsd-contrib/review-artifacts/pr42-a1b2c3d/R8-code-review.json';

for (const g of GATES) {
  test('truthful: ENF-20 missingText ' + g.id, () => {
    const normal = missingText(g, RA_REL, { written: true, path: RA_REL }, null);
    assertTruthful('missingText ' + g.id + ' normal', normal, lastParagraph(normal));
    const edge = missingText(g, RA_REL, null, null);
    assertTruthful('missingText ' + g.id + ' edge', edge, lastParagraph(edge));
  });

  test('truthful: ENF-20 shortfallText ' + g.id, () => {
    const normal = shortfallText(g, RA_REL, 'problem text');
    assertTruthful('shortfallText ' + g.id + ' normal', normal, lastParagraph(normal));
    const edge = shortfallText(g, RA_REL, '');
    assertTruthful('shortfallText ' + g.id + ' edge', edge, lastParagraph(edge));
  });

  test('truthful: ENF-20 liveText ' + g.id, () => {
    // liveText has no artifact, so its note must not tell the reader to write one.
    for (const [kind, problem] of [['normal', 'problem text'], ['edge', '']]) {
      const r = liveText(g, problem);
      assertTruthful('liveText ' + g.id + ' ' + kind, r, lastParagraph(r));
      assert.ok(!r.includes('Write the artifact'), 'liveText ' + g.id + ' ' + kind + ' names an artifact to write:\n' + r);
    }
  });
}

// -- ENF-19 denialText: every protocol-artifact gate -------------------------

const PA_REL = '.gsd-contrib/protocol-artifacts/x/P1.json';
for (const g of protocolArtifact.GATES) {
  test('truthful: ENF-19 denialText ' + g.id, () => {
    const absent = protocolArtifact.denialText(g, PA_REL, null);
    assertTruthful('denialText ' + g.id + ' absent', absent, lastParagraph(absent));
    const failed = protocolArtifact.denialText(g, PA_REL, 'problem text', '\n\nscaffold note');
    assertTruthful('denialText ' + g.id + ' failed', failed, lastParagraph(failed));
  });
}

// -- ENF-12 githooks-seal `--no-verify` --------------------------------------

function bashInput(command) {
  return JSON.stringify({ tool_name: 'Bash', tool_input: { command } });
}

function overrideStub(override) {
  const calls = { receipts: 0 };
  return {
    calls,
    impl: {
      checkOverride: () => (override ? { override: true, reason: 'pin: does the override lift this?' } : { override: false }),
      writeReceipt: () => {
        calls.receipts++;
      },
    },
  };
}

test('truthful: ENF-12 --no-verify deny', () => {
  for (const cmd of ['git commit --no-verify -m x', 'git commit -n -m x', 'git push --no-verify']) {
    const d = runGithooksGate(bashInput(cmd), {
      worktreeRoot: '/tmp/wt',
      readHooksPath: () => '.githooks',
      overrideImpl: overrideStub(false).impl,
    });
    assert.strictEqual(d.permissionDecision, 'deny', cmd);
    assertTruthful('ENF-12 ' + cmd, d.permissionDecisionReason, d.permissionDecisionReason);
  }
});

// -- ENF-11 issue-dedupe likely duplicate ------------------------------------

const STUB_SCORER = {
  scoreCandidates: (t, c) => c.map((x) => ({ number: x.number, title: x.title, score: 0.95 })),
  DEFAULT_THRESHOLD: 0.5,
};
const DUP_CMD = 'gh issue create --title "Widget crashes on start" --body "x"';

function dedupe(overrideImpl) {
  return runDedupeGate(bashInput(DUP_CMD), {
    liveScorer: STUB_SCORER,
    fetchOpenIssues: () => [{ number: 7, title: 'Widget crashes on start', body: '' }],
    worktreeRoot: '/tmp/wt',
    overrideImpl,
  });
}

test('truthful: ENF-11 likely-duplicate deny', () => {
  const d = dedupe(overrideStub(false).impl);
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
  const reason = d.permissionDecisionReason;
  const at = reason.indexOf('Comment on the existing issue');
  assert.notStrictEqual(at, -1, 'the duplicate deny keeps its comment-instead fix step:\n' + reason);
  assertTruthful('ENF-11 duplicate', reason, reason.slice(at));
});

// -- semantics pins (in-process): a policy deny is not lifted, no receipt ----

test('semantics: ENF-12 --no-verify stays deny with the override set, no receipt', () => {
  const o = overrideStub(true);
  const d = runGithooksGate(bashInput('git commit --no-verify -m x'), {
    worktreeRoot: '/tmp/wt',
    readHooksPath: () => '.githooks',
    overrideImpl: o.impl,
  });
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
  assert.strictEqual(o.calls.receipts, 0);
});

test('semantics: ENF-11 duplicate stays deny with the override set, no receipt', () => {
  const o = overrideStub(true);
  const d = dedupe(o.impl);
  assert.strictEqual(d.permissionDecision, 'deny', d.permissionDecisionReason);
  assert.strictEqual(o.calls.receipts, 0);
});

// -- spawned ENF-20 hook (ported from the 261006-jqh probe-enf20.cjs fixtures) -

const HOOK = path.join(__dirname, 'review-artifact.cjs');
const HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const ART_DIR = reviewArtifact.ARTIFACT_DIR + '/' + reviewArtifact.reviewSlug(42, HEAD);
const MT = 'mcp__memtrace__';
const SID = 'sess-override-note';
const P1_CMD = 'gh pr review 42 --comment --body "x"';
const T1_CMD = 'gh pr review 42 --body "unterminated';
const NO_SH = process.platform === 'win32' && 'no sh for the fake gh on win32';

/** A gsd-core sentinel root with the (empty) PR-42 artifact dir. */
function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'override-note-root-'));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.writeFileSync(path.join(root, 'scripts', 'issue-dedupe.cjs'), '');
  fs.mkdirSync(path.join(root, 'gsd-core', 'bin', 'lib'), { recursive: true });
  fs.mkdirSync(path.join(root, ART_DIR), { recursive: true });
  return root;
}

/** Fake gh: PR 42 at HEAD, no posted reviews, the number resolves to a PR. */
function ghScript(binDir) {
  const rf = path.join(binDir, 'reviews.jsonl');
  fs.writeFileSync(rf, '');
  return (
    '#!/bin/sh\n' +
    'if [ "$1" = "pr" ]; then printf \'%s\' \'{"number":42,"headRefOid":"' + HEAD + '"}\'; exit 0; fi\n' +
    'case "$*" in *reviews*) cat "' + rf + '" ;; *issues*) printf \'%s\' "https://api.github.com/repos/o/r/pulls/42" ;; esac\nexit 0\n'
  );
}

function memtraceRows() {
  return [MT + 'get_impact', MT + 'get_symbol_context', MT + 'recall_decision']
    .map((name, i) =>
      serializeRecord(
        recordToolCall(
          JSON.stringify({
            hook_event_name: 'PostToolUse',
            session_id: SID,
            tool_use_id: 'toolu_' + i,
            tool_name: name,
            tool_input: {},
            tool_response: {},
            cwd: '/tmp/wt',
          }),
          { env: {} }
        )
      )
    )
    .join('');
}

/** Run the real ENF-20 entrypoint once on `root`. */
function spawnReviewHook({ cmd, override, root }) {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'override-note-log-'));
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'override-note-bin-'));
  try {
    fs.writeFileSync(path.join(binDir, 'gh'), ghScript(binDir), { mode: 0o755 });
    fs.writeFileSync(path.join(logDir, LOG_FILENAME), memtraceRows());
    const env = Object.assign({}, process.env, {
      PATH: binDir + path.delimiter + (process.env.PATH || ''),
      GSD_CONTRIB_LOG_DIR: logDir,
    });
    delete env.GSD_CONTRIB_RECORD;
    delete env.GSD_CONTRIB_OVERRIDE;
    if (override) env.GSD_CONTRIB_OVERRIDE = 'pin: does the override lift this?';
    const res = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ tool_name: 'Bash', session_id: SID, tool_input: { command: cmd } }),
      encoding: 'utf8',
      cwd: root,
      env,
      timeout: 10000,
    });
    assert.strictEqual(res.status, 0, res.stderr);
    const hso = JSON.parse(res.stdout.trim().split('\n').pop()).hookSpecificOutput;
    return {
      decision: hso.permissionDecision,
      reason: hso.permissionDecisionReason || '',
      receiptPath: path.join(root, '.gsd-contrib', 'override-receipts.log'),
    };
  } finally {
    for (const d of [logDir, binDir]) fs.rmSync(d, { recursive: true, force: true });
  }
}

function receiptLines(p) {
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).length : 0;
}

test('truthful: ENF-20 spawned P1 (R8-code artifact missing) with the override set', { skip: NO_SH }, () => {
  const root = makeRoot();
  try {
    const r = spawnReviewHook({ cmd: P1_CMD, override: true, root });
    assert.strictEqual(r.decision, 'deny', r.reason);
    assertTruthful('spawned P1', r.reason, lastParagraph(r.reason));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('semantics: ENF-20 spawned thrown family (T1) is rescued by the override, one receipt per run', { skip: NO_SH }, () => {
  const bare = makeRoot();
  const root = makeRoot();
  try {
    const without = spawnReviewHook({ cmd: T1_CMD, override: false, root: bare });
    assert.strictEqual(without.decision, 'deny', without.reason);
    assert.ok(!fs.existsSync(without.receiptPath), 'no receipt without the override');

    const a = spawnReviewHook({ cmd: T1_CMD, override: true, root });
    const b = spawnReviewHook({ cmd: T1_CMD, override: true, root });
    assert.strictEqual(a.decision, 'allow', a.reason);
    assert.strictEqual(b.decision, 'allow', b.reason);
    assert.strictEqual(receiptLines(a.receiptPath), 2, 'exactly one receipt line per honored override');
  } finally {
    for (const d of [bare, root]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test('semantics: ENF-20 spawned policy family (P1) is not lifted by the override, no receipt', { skip: NO_SH }, () => {
  const root = makeRoot();
  try {
    const a = spawnReviewHook({ cmd: P1_CMD, override: true, root });
    const b = spawnReviewHook({ cmd: P1_CMD, override: true, root });
    assert.strictEqual(a.decision, 'deny', a.reason);
    assert.strictEqual(b.decision, 'deny', b.reason);
    assert.ok(!fs.existsSync(a.receiptPath), 'a policy deny writes no override receipt');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
