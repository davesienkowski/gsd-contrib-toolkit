'use strict';

/**
 * bin/install-integrity.test.cjs — the INST-03 (D-06) sandbox regression.
 *
 * Phase 28 closed two coupled install-integrity defects: INST-01/02 (a promoted bundle that
 * never resolved → the 12 wired PreToolUse gates dangled and enforcement was silently INERT) and
 * — the sibling shipped in quick task 260630-v1h — the binlib-edit `Write|Edit` gate installed
 * CATCH-ALL, which then received every `Bash` payload and fail-closed-DENIED all work. This test
 * is the regression that keeps BOTH closed: it installs the capability into a DISPOSABLE fixture
 * (mirroring bin/contrib-capability.test.cjs makeCapSandbox — the LIVE engine symlinked read-only,
 * every write confined to a mkdtemp root) and asserts:
 *
 *   (a) NO DANGLING — every CAP_MARKER-tagged wired settings hook target resolves to a real file
 *       (all 13). A future regression to a dangling promoted bundle makes this go RED. (Documented
 *       red-on-regression witness: with promotion suppressed the install fails loud + the targets
 *       dangle — the exact silent-inert defect INST-01/02 closed.)
 *
 *   (b) NO COLLATERAL DENY (the exact 260630-v1h class) — BOTH facets:
 *       * MATCHER SCOPE: the installed binlib-edit settings entry keeps its scoped `Write|Edit`
 *         matcher (a regression to a catch-all/absent matcher goes RED).
 *       * SELF-FILTER: spawning the REAL hooks/binlib-edit.cjs entrypoint with a representative
 *         NON-governed `Bash` payload yields a conclusive NON-deny (allow) — the tool_name
 *         self-filter short-circuits Bash before the Write/Edit HARD-01 fail-closed. The gate's
 *         real governed surface is UNWEAKENED: a Write to a bin/lib/*.cjs still DENIES.
 *
 * REACHABILITY: the install-dependent facets SKIP-with-note when no real gsd-core source is
 * reachable to seed the sandbox (never fabricate a fake sentinel layout). The spawn-only
 * self-filter facet (b) needs no checkout (binlib-edit is command-only) and always runs.
 *
 * HERMETICITY: the real gsd-core settings + the real consent store are snapshotted (sha256) before
 * the cycle and asserted byte/existence-identical after — every write lands inside the disposable
 * sandbox, never the real checkout. The sandbox is disposed in a finally (no temp residue leaks).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const drv = require('./contrib-capability.cjs');
const { requireLiveScript, resolveGsdCoreRoot } = require('../hooks/lib/resolve.cjs');
const { spawnHook } = require('../hooks/lib/proof-harness.cjs');

const CAP_ID = 'contribution-toolkit';
const CAP_MARKER = '_gsdCapability';
const SETTINGS_REL = path.join('.claude', 'settings.json');
const ENGINE_LIB_REL = path.join('gsd-core', 'bin', 'lib');

// The REAL canonical binlib-edit entrypoint (never the sandbox copy) — the 260630-v1h fix under test.
const BINLIB_EDIT = path.join(__dirname, '..', 'hooks', 'binlib-edit.cjs');

// Resolve the real gsd-core source the SAME way the driver does; null → the install facets SKIP.
const SOURCE_ROOT = drv.resolveGsdCoreCwd() || null;
const SKIP_NOTE =
  'no real gsd-core source reachable (set GSD_CORE_ROOT, or use ~/repos/gsd-core | ~/gsd-core) — ' +
  'the INST-03 install-dependent facets SKIPPED (env limitation; never fabricate a fake sentinel layout)';
const SKIP = SOURCE_ROOT ? false : SKIP_NOTE;

/** sha256 of a file's bytes, or null if absent. */
function sha(p) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  } catch (_) {
    return null;
  }
}

/** The real consent store path for the ambient ${GSD_HOME||~}/.gsd/consent.json. */
function realConsentPath() {
  return path.join(process.env.GSD_HOME || os.homedir(), '.gsd', 'consent.json');
}

/**
 * Snapshot the REAL gsd-core settings + the real consent store (sha256) so any mutation (a write
 * where the sandbox seam leaked) is caught by the after-comparison. Every driver write MUST land in
 * the disposable sandbox, never the real checkout.
 */
function snapshotRealState(sourceRoot) {
  const snap = {};
  snap[path.join(sourceRoot, SETTINGS_REL)] = sha(path.join(sourceRoot, SETTINGS_REL));
  snap[realConsentPath()] = sha(realConsentPath());
  return snap;
}

function assertRealStateUnchanged(before) {
  for (const key of Object.keys(before)) {
    assert.strictEqual(
      sha(key),
      before[key],
      'REAL state mutated! ' + key + ' changed (existence/bytes) — every install write MUST target ' +
        'the mkdtemp sandbox + sandboxed GSD_HOME, never the real gsd-core settings/consent'
    );
  }
}

/**
 * Build a DISPOSABLE mkdtemp sandbox that resolves to itself as a gsd-core root, SYMLINKS the LIVE
 * engine lib (so requireLiveScript loads the real engine — read-only), pre-seeds a writable
 * .claude/settings.json + a .planning/config.json, and a sandboxed GSD_HOME. Mirrors
 * bin/contrib-capability.test.cjs makeCapSandbox — the disposable-fixture discipline (12-01/12-02):
 * the engine is LIVE, every write target is sandboxed.
 */
function makeCapSandbox(sourceRoot) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-inst3-'));

  // Sentinel layout so resolveGsdCoreRoot(root) === root (never walks up to the real checkout).
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'gsd-core', 'bin'), { recursive: true });
  // Post-RES-02, hasSentinel additionally requires a LIVE gsd-core identity script under scripts/.
  fs.writeFileSync(
    path.join(root, 'scripts', 'issue-version-gate.cjs'),
    '// gsd-core identity stub (RES-02 sentinel)\n',
    'utf8'
  );
  // Symlink the LIVE engine lib — requireLiveScript loads the REAL engine (read-only require).
  fs.symlinkSync(path.join(sourceRoot, ENGINE_LIB_REL), path.join(root, ENGINE_LIB_REL), 'dir');

  // A writable fake settings.json pre-seeded with ONE UNTAGGED user hook (must survive install).
  const settingsPath = path.join(root, SETTINGS_REL);
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(
    settingsPath,
    JSON.stringify(
      {
        hooks: {
          PreToolUse: [
            {
              matcher: 'Bash',
              _userOwned: true,
              hooks: [{ type: 'command', command: 'echo pre-existing-user-hook' }],
            },
          ],
        },
      },
      null,
      2
    ) + '\n',
    'utf8'
  );

  // A config.json so the LIVE config.setConfigValue (the enforcement-flag flip) has a target.
  fs.mkdirSync(path.join(root, '.planning'), { recursive: true });
  fs.writeFileSync(path.join(root, '.planning', 'config.json'), JSON.stringify({}, null, 2) + '\n', 'utf8');

  // A sandboxed GSD_HOME + runtime command/skill dirs — every delivery write lands under the temp root.
  const gsdHome = path.join(root, '.gsdhome');
  fs.mkdirSync(gsdHome, { recursive: true });
  const commandsDir = path.join(root, '.claude-runtime', 'commands');
  const skillsDir = path.join(root, '.claude-runtime', 'skills');

  let disposed = false;
  function dispose() {
    if (disposed) return;
    disposed = true;
    fs.rmSync(root, { recursive: true, force: true });
  }

  return { root, gsdHome, settingsPath, commandsDir, skillsDir, dispose };
}

/** The injectable seam opts that confine EVERY driver write to the sandbox. */
function sandboxOpts(sb) {
  return { liveRoot: sb.root, consentHome: sb.gsdHome, commandsDir: sb.commandsDir, skillsDir: sb.skillsDir };
}

/**
 * Enumerate EVERY CAP_MARKER-tagged wired hook entry in the installed settings.json. For each,
 * parse the wired script path (strip a leading `node ` + surrounding quotes — the SAME shape the
 * driver's verifyWiredTargets uses) and stat it. Returns the tagged targets with their matcher +
 * whether the script resolves to a real file.
 */
function wiredTargets(settingsPath) {
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const hooks = settings && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks)
    ? settings.hooks
    : {};
  const out = [];
  for (const event of Object.keys(hooks)) {
    if (!Array.isArray(hooks[event])) continue;
    for (const e of hooks[event]) {
      if (!(e && typeof e === 'object' && e[CAP_MARKER] === CAP_ID)) continue;
      const inner = Array.isArray(e.hooks) ? e.hooks : [];
      const cmd = inner[0] && inner[0].command ? String(inner[0].command) : '';
      const scriptPath = cmd.replace(/^node\s+/, '').replace(/['"]/g, '').trim();
      out.push({
        event,
        matcher: e.matcher,
        command: cmd,
        scriptPath,
        resolves: !!scriptPath && fs.existsSync(scriptPath),
      });
    }
  }
  return out;
}

/** The promoted capDir the LIVE engine composes the wired command paths against. */
function sandboxCapDir(sb) {
  return path.join(sb.root, '.gsd', 'capabilities', CAP_ID);
}

// Payload builders (mirror hooks/integration-proof.test.cjs).
const bash = (command) => JSON.stringify({ tool_name: 'Bash', tool_input: { command } });
const write = (file_path) => JSON.stringify({ tool_name: 'Write', tool_input: { file_path } });

// ───────────────────────── INST-03 (a): no dangling wired targets ─────────────────────────

test('INST-03(a): a sandbox install wires EVERY CAP_MARKER target to a real file (14 resolve, no dangling)', { skip: SKIP }, () => {
  // The INST-01/02 closure as a regression: after a real install every wired gate script must
  // resolve. A future regression to a dangling promoted bundle makes this go RED. (Red-on-regression
  // witness below: with promotion suppressed these SAME targets dangle and the install fails loud.)
  const before = snapshotRealState(SOURCE_ROOT);
  const sb = makeCapSandbox(SOURCE_ROOT);
  try {
    assert.strictEqual(
      resolveGsdCoreRoot(sb.root),
      sb.root,
      'the sandbox must resolve to itself as a gsd-core root, not walk up to the real checkout'
    );

    drv.runInstall(sandboxOpts(sb));

    // The promoted capDir the wired paths are composed against exists (INST-02 promotion).
    assert.ok(fs.existsSync(sandboxCapDir(sb)), 'install must promote the capDir (INST-02)');

    // (a) NO DANGLING: enumerate every tagged wired target and stat each — all 14 resolve.
    const targets = wiredTargets(sb.settingsPath);
    assert.strictEqual(targets.length, 14, 'install must wire EXACTLY 14 tagged targets, got ' + targets.length);
    const dangling = targets.filter((t) => !t.resolves).map((t) => t.command);
    assert.deepStrictEqual(
      dangling, [],
      'every wired settings hook target MUST resolve to a real file — a dangling target is the exact ' +
        'silent-inert defect INST-01/02 closed; these do NOT resolve: ' + dangling.join(', ')
    );

    // Cross-check via the driver's own fail-loud verifier: verified === 14, no throw.
    const verification = drv.verifyWiredTargets({
      liveRoot: sb.root,
      confinedSharedFile: requireLiveScript(sb.root, 'gsd-core/bin/lib/capability-lifecycle.cjs').confinedSharedFile,
      capMarker: CAP_MARKER,
    });
    assert.strictEqual(verification.verified, 14, 'verifyWiredTargets must confirm all 14 wired targets resolve');
  } finally {
    sb.dispose();
  }
  assertRealStateUnchanged(before);
});

test('INST-03(a) red-on-regression witness: suppressed promotion → the SAME targets dangle + install fails loud', { skip: SKIP }, () => {
  // Proof the (a) assertion is red-on-regression (not vacuously green): with the promotion suppressed
  // (a no-op promoteBundle — the 2026-06-30 bundle-absent defect), the LIVE apply composes DANGLING
  // command paths, the wired targets do NOT resolve, and the install FAILS LOUD (verifyWiredTargets
  // throws post-apply). So a regression to a dangling promoted bundle is caught, never silently inert.
  const before = snapshotRealState(SOURCE_ROOT);
  const sb = makeCapSandbox(SOURCE_ROOT);
  try {
    assert.throws(
      () => drv.runInstall(Object.assign({}, sandboxOpts(sb), { promoteBundle: () => ({}) })),
      (err) =>
        err instanceof drv.DriverError &&
        /do NOT resolve|silently INERT/i.test(err.message) &&
        /re-run .*install/i.test(err.message),
      'a dangling promoted bundle must FAIL LOUD (red-on-regression for facet a)'
    );
    // The dangling settings persist on disk (verify runs after apply) — the SAME targets now dangle.
    assert.ok(!fs.existsSync(sandboxCapDir(sb)), 'suppressed promotion left the capDir ABSENT');
    const targets = wiredTargets(sb.settingsPath);
    assert.ok(
      targets.length > 0 && targets.some((t) => !t.resolves),
      'suppressed promotion leaves DANGLING wired targets — proving facet (a) catches a real regression'
    );
  } finally {
    sb.dispose();
  }
  assertRealStateUnchanged(before);
});

// ───────────────────────── INST-03 (b): no collateral deny (the 260630-v1h class) ─────────────────────────

test('INST-03(b) MATCHER SCOPE: the installed binlib-edit entry keeps its scoped Write|Edit matcher (not catch-all)', { skip: SKIP }, () => {
  // The 260630-v1h class, facet 1: a catch-all (absent) matcher on binlib-edit would route every Bash
  // payload into the Write|Edit gate. Assert the installed entry stays scoped to `Write|Edit` — a
  // regression to a catch-all/absent matcher goes RED.
  const before = snapshotRealState(SOURCE_ROOT);
  const sb = makeCapSandbox(SOURCE_ROOT);
  try {
    drv.runInstall(sandboxOpts(sb));

    const targets = wiredTargets(sb.settingsPath);
    const binlib = targets.find((t) => /binlib-edit\.cjs/.test(t.command));
    assert.ok(binlib, 'the installed settings must carry a wired binlib-edit entry');
    assert.strictEqual(
      binlib.matcher,
      'Write|Edit',
      'the binlib-edit gate MUST stay scoped to the `Write|Edit` matcher — a catch-all/absent matcher ' +
        'is the 260630-v1h defect (every Bash payload would trip the Write/Edit HARD-01 fail-closed); got: ' +
        JSON.stringify(binlib.matcher)
    );
    // The 11 Bash gates stay under `Bash`, binlib-edit is the sole Write|Edit entry (scope sanity).
    const writeEdit = targets.filter((t) => t.matcher === 'Write|Edit');
    assert.strictEqual(writeEdit.length, 1, 'exactly one Write|Edit-scoped gate (binlib-edit) — no catch-all creep');
  } finally {
    sb.dispose();
  }
  assertRealStateUnchanged(before);
});

test('INST-03(b) SELF-FILTER: binlib-edit ALLOWS a non-governed Bash payload (short-circuits before the Write/Edit HARD-01)', () => {
  // The 260630-v1h class, facet 2 (checkout-independent — binlib-edit is command-only). Spawn the REAL
  // hooks/binlib-edit.cjs with a representative NON-governed Bash payload: the tool_name self-filter
  // must short-circuit to ALLOW *before* the file_path check, so a catch-all install can never trip the
  // Write/Edit fail-closed on a Bash call. A regression that drops the self-filter would DENY here → RED.
  assert.ok(fs.existsSync(BINLIB_EDIT), 'precondition: the canonical binlib-edit entrypoint exists');
  const r = spawnHook(BINLIB_EDIT, { stdin: bash('ls') });
  assert.strictEqual(r.conclusive, true, 'the Bash decision must be CONCLUSIVE (a crash is never coerced) — ' + r.reason + '\nstderr: ' + r.rawStderr);
  assert.notStrictEqual(r.decision, 'deny', 'binlib-edit MUST NOT deny a non-governed Bash payload (self-filter allow)\nstdout: ' + r.rawStdout);
  assert.strictEqual(r.decision, 'allow', 'the tool_name self-filter short-circuits a Bash payload to ALLOW\nstdout: ' + r.rawStdout);
});

test('INST-03(b) GOVERNED SURFACE UNWEAKENED: binlib-edit still DENIES a Write to a bin/lib/*.cjs', () => {
  // The contrast that proves the self-filter did NOT weaken the real deny surface: a governed Write to a
  // generated bin/lib/*.cjs artifact still DENIES (ENF-03/ADR-457). This plan adds regression coverage
  // only — it never weakens a deny.
  const r = spawnHook(BINLIB_EDIT, { stdin: write('/g/gsd-core/bin/lib/decisions.cjs') });
  assert.strictEqual(r.conclusive, true, 'the Write decision must be CONCLUSIVE — ' + r.reason + '\nstderr: ' + r.rawStderr);
  assert.strictEqual(r.decision, 'deny', 'a Write to a generated bin/lib/*.cjs MUST still DENY (governed surface unweakened)\nstdout: ' + r.rawStdout);
});
