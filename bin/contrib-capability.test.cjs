'use strict';

/**
 * bin/contrib-capability.test.cjs — the CAP-07 disposable-sandbox install/toggle/remove proof.
 *
 * This is the verifier-reach=spec-reach proof for v2.1's install engine: it drives the SAME LIVE
 * gsd-core lifecycle functions bin/contrib-capability.cjs drives (HARD-02 — never a reimplementation)
 * against a FAKE .claude/settings.json + a sandboxed consent/ledger store on a DISPOSABLE
 * mkdtemp sandbox, and proves the full lifecycle is BOTH correct AND hermetic:
 *
 *   install -> EXACTLY 13 CAP_MARKER-tagged hook entries (the 12 PreToolUse gates + the 1
 *              UserPromptSubmit advisory from the manifest hooks[]) land in the fake settings.json.
 *   off     -> stripCapabilitySharedEdits removes EXACTLY those 13 tagged entries; a PRE-SEEDED
 *              UNTAGGED user hook SURVIVES (the strip is marker-scoped, not a blanket wipe).
 *   on      -> applyCapabilitySharedEdits restores EXACTLY the 13 tagged entries.
 *   remove  -> removeCapability + revokeProjectConsent leave NO ledger entry and NO consent record
 *              for 'contribution-toolkit' in the SANDBOXED store.
 *
 * HERMETICITY (the load-bearing security invariant — mirrors fault-injection.test.cjs's
 * "REAL gsd-core source bytes UNCHANGED" guard): the REAL gsd-core .claude/settings.json AND the
 * real ${GSD_HOME||~}/.gsd consent + the real <gsd-core>/.gsd-capabilities.json ledger are snapshotted
 * (sha256 + existence) BEFORE the whole cycle and asserted byte/existence-IDENTICAL AFTER. Every
 * lifecycle WRITE targets the mkdtemp sandbox (runtimeDir=sandbox) + a sandboxed GSD_HOME
 * (consentHome=sandbox/.gsdhome) — nothing the driver writes can reach the real checkout.
 *
 * SANDBOX SEED: the disposable root carries the gsd-core sentinel layout (scripts/ +
 * gsd-core/bin/lib/) so resolveGsdCoreRoot(sandbox)===sandbox; gsd-core/bin/lib is a SYMLINK to the
 * REAL engine dir so requireLiveScript(sandbox, ...) loads the LIVE capability engine (read-only
 * require — the engine modules are never written), while the driver's WRITES (settings/ledger/
 * config/consent) all land under the temp root. The bundle is the REAL in-repo
 * capabilities/contribution-toolkit (read-only — its manifest hooks[] is the source of the exactly-13 set).
 *
 * REACHABILITY: when no real gsd-core source is reachable to seed the sandbox, every case
 * SKIPs-with-note (never fabricate a fake sentinel layout — a fabricated proof is worse than no
 * proof; mirrors fault-injection.test.cjs SKIP_NOTE).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const drv = require('./contrib-capability.cjs');
const { requireLiveScript } = require('../hooks/lib/resolve.cjs');
const { resolveGsdCoreRoot } = require('../hooks/lib/resolve.cjs');

const CAP_ID = 'contribution-toolkit';
const CAP_MARKER = '_gsdCapability';
const SETTINGS_REL = path.join('.claude', 'settings.json');
const LEDGER_REL = '.gsd-capabilities.json';
const ENGINE_LIB_REL = path.join('gsd-core', 'bin', 'lib');

/**
 * Resolve the REAL gsd-core source the SAME way the driver does (resolveGsdCoreCwd: GSD_CORE_ROOT,
 * then ~/repos/gsd-core, then ~/gsd-core — a candidate list, NOT a cwd-walk: gsd-core is a sibling
 * of this toolkit, never an ancestor). Returns an absolute root, or null when none is reachable.
 * When null, every case SKIPs-with-note (never fabricate).
 */
function realGsdCoreRootOrNull() {
  const root = drv.resolveGsdCoreCwd();
  return root || null;
}

const SOURCE_ROOT = realGsdCoreRootOrNull();
const SKIP_NOTE =
  'no real gsd-core source reachable (set GSD_CORE_ROOT, or use ~/repos/gsd-core | ~/gsd-core) — ' +
  'install/toggle lifecycle SKIPPED (env limitation; never fabricate a fake sentinel layout)';
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

/** The real Claude runtime command/skill dirs the driver would touch if a sandbox seam leaked. */
function realClaudeDir() {
  return process.env.CLAUDE_DIR || path.join(os.homedir(), '.claude');
}
function realClaudeCommandsDir() {
  return path.join(realClaudeDir(), 'commands');
}
function realClaudeSkillsDir() {
  return path.join(realClaudeDir(), 'skills');
}

/** Sorted listing of a dir's entries, or null if absent — a stray real-link delivery flips this. */
function listDirOrNull(p) {
  try {
    return fs.readdirSync(p).slice().sort().join('\n');
  } catch (_) {
    return null;
  }
}

/**
 * Snapshot the REAL gsd-core state (settings + ledger), the real consent store (sha256), AND the real
 * ~/.claude commands + skills dir LISTINGS as a { path -> snapshot|null } map, so a mutation of ANY of
 * them (write where there was none, a byte change, or a stray delivered/reclaimed link in the real
 * ~/.claude/skills | ~/.claude/commands) is caught by the after-comparison. The dir LISTINGS guard the
 * 21-02 full-surface delivery/reclaim: a leaked skillsDir/commandsDir seam would surface as a new entry
 * in the real ~/.claude listing here (T-21-08 hermeticity).
 */
function snapshotRealState(sourceRoot) {
  const snap = {};
  snap[path.join(sourceRoot, SETTINGS_REL)] = sha(path.join(sourceRoot, SETTINGS_REL));
  snap[path.join(sourceRoot, LEDGER_REL)] = sha(path.join(sourceRoot, LEDGER_REL));
  snap[realConsentPath()] = sha(realConsentPath());
  // 21-03: also snapshot the real ~/.claude command + skill dir LISTINGS (existence + entries) so a
  // stray real-link delivery/reclaim (a leaked commandsDir/skillsDir seam) is CAUGHT, not silent.
  snap['LISTING:' + realClaudeCommandsDir()] = listDirOrNull(realClaudeCommandsDir());
  snap['LISTING:' + realClaudeSkillsDir()] = listDirOrNull(realClaudeSkillsDir());
  return snap;
}

/** Assert a real-state snapshot is byte/existence/listing-identical to `before`. */
function assertRealStateUnchanged(before) {
  for (const key of Object.keys(before)) {
    if (key.startsWith('LISTING:')) {
      const p = key.slice('LISTING:'.length);
      assert.strictEqual(
        listDirOrNull(p),
        before[key],
        'REAL ~/.claude dir mutated! ' + p + ' listing changed (existence/entries) — the full-surface ' +
          'command/skill delivery MUST target the sandbox commandsDir/skillsDir, never the real ~/.claude'
      );
      continue;
    }
    assert.strictEqual(
      sha(key),
      before[key],
      'REAL state mutated! ' + key + ' changed (existence/bytes) — every lifecycle write MUST target ' +
        'the mkdtemp sandbox + sandboxed GSD_HOME, never the real gsd-core settings/consent/ledger'
    );
  }
}

/**
 * Build a DISPOSABLE mkdtemp sandbox that resolves to itself as a gsd-core root, SYMLINKS the LIVE
 * engine lib (so requireLiveScript loads the real engine — read-only), pre-seeds a writable
 * .claude/settings.json carrying ONE UNTAGGED user hook + a .planning/config.json (for the
 * enforcement-flag flip), and a sandboxed GSD_HOME for the consent/ledger store.
 *
 * @param {string} sourceRoot the REAL gsd-core root to symlink the engine from.
 * @returns {{root:string, gsdHome:string, settingsPath:string, dispose:Function}}
 */
function makeCapSandbox(sourceRoot) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cap-'));

  // Sentinel layout so resolveGsdCoreRoot(root) === root (never walks up to the real checkout).
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'gsd-core', 'bin'), { recursive: true });
  // Post-RES-02, hasSentinel additionally requires a LIVE gsd-core identity script under scripts/
  // (so a ~/.claude install root no longer false-resolves). A faithful checkout fixture must carry
  // one (D-05: a real checkout still resolves) — an empty stub suffices (existence-only probe).
  fs.writeFileSync(path.join(root, 'scripts', 'issue-version-gate.cjs'), '// gsd-core identity stub (RES-02 sentinel)\n', 'utf8');
  // Symlink the LIVE engine lib — requireLiveScript(root, 'gsd-core/bin/lib/...') loads the REAL
  // engine (read-only require; the engine modules are NEVER written). This is the disposable-sandbox
  // discipline 12-01/12-02 used: the engine is LIVE, the state targets are sandboxed.
  fs.symlinkSync(path.join(sourceRoot, ENGINE_LIB_REL), path.join(root, ENGINE_LIB_REL), 'dir');

  // A writable fake settings.json pre-seeded with ONE UNTAGGED hook (must SURVIVE the off-strip).
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

  // A config.json so the LIVE config.setConfigValue (the on/off enforcement-flag flip) has a target.
  fs.mkdirSync(path.join(root, '.planning'), { recursive: true });
  fs.writeFileSync(path.join(root, '.planning', 'config.json'), JSON.stringify({}, null, 2) + '\n', 'utf8');

  // A sandboxed GSD_HOME for the consent + ledger store (created under the temp root so dispose()
  // removes it with the sandbox — no temp consent/ledger residue leaks; T-12-03-LEAK).
  const gsdHome = path.join(root, '.gsdhome');
  fs.mkdirSync(gsdHome, { recursive: true });

  // A sandboxed runtime commands dir for the slash-command delivery/reclaim (Plan 17-02). Injected via
  // sandboxOpts.commandsDir so the driver NEVER writes to the real ~/.claude/commands (T-17-02-REALCHECKOUT).
  const commandsDir = path.join(root, '.claude-runtime', 'commands');
  // A sandboxed runtime skills dir for the skill delivery/reclaim (Plan 21-02). Injected via
  // sandboxOpts.skillsDir so the driver NEVER writes to the real ~/.claude/skills (hermeticity).
  const skillsDir = path.join(root, '.claude-runtime', 'skills');

  let disposed = false;
  function dispose() {
    if (disposed) return;
    disposed = true;
    fs.rmSync(root, { recursive: true, force: true });
  }

  return { root, gsdHome, settingsPath, commandsDir, skillsDir, dispose };
}

/**
 * The injectable seam opts that confine EVERY driver write to the sandbox — liveRoot (settings/ledger/
 * config), consentHome (consent store), and commandsDir (the slash-command delivery target). Injecting
 * commandsDir means the command delivery/reclaim NEVER touches the real ~/.claude/commands.
 */
function sandboxOpts(sb) {
  return { liveRoot: sb.root, consentHome: sb.gsdHome, commandsDir: sb.commandsDir, skillsDir: sb.skillsDir };
}

/** The 5 bundled slash-command basenames the install delivers (data-driven from the REAL bundle). */
function bundledCommandNames() {
  return drv.bundledCommandNames(drv.BUNDLE_CAP_DIR);
}

/**
 * Count the delivered command symlinks in the sandbox commands dir that resolve to the bundle source.
 * Returns { delivered, names } — delivered = how many of the bundled commands are present as a symlink
 * pointing at <BUNDLE>/commands/<name>.md (proves the local-parity symlink form, not a stray copy).
 */
function countDeliveredCommands(sb) {
  const names = bundledCommandNames();
  let delivered = 0;
  for (const name of names) {
    const target = path.join(sb.commandsDir, name);
    let st = null;
    try {
      st = fs.lstatSync(target);
    } catch (_) {
      continue;
    }
    if (!st.isSymbolicLink()) continue;
    const want = path.join(drv.BUNDLE_CAP_DIR, 'commands', name);
    let cur = '';
    try {
      cur = fs.readlinkSync(target);
    } catch (_) {
      cur = '';
    }
    if (cur === want) delivered += 1;
  }
  return { delivered, names };
}

/** The bundled skill stems the install/on delivers (data-driven from the REAL bundle). */
function bundledSkillNames() {
  return drv.bundledSkillNames(drv.BUNDLE_CAP_DIR);
}

/**
 * Count the delivered skill DIRECTORY symlinks in the sandbox skills dir that resolve to the bundle
 * source. Returns { delivered, names } — delivered = how many bundled skills are present as a symlink
 * pointing at <BUNDLE>/skills/<stem> (proves the local-parity dir-symlink form, not a stray copy).
 */
function countDeliveredSkills(sb) {
  const names = bundledSkillNames();
  let delivered = 0;
  for (const stem of names) {
    const target = path.join(sb.skillsDir, stem);
    let st = null;
    try {
      st = fs.lstatSync(target);
    } catch (_) {
      continue;
    }
    if (!st.isSymbolicLink()) continue;
    const want = path.join(drv.BUNDLE_CAP_DIR, 'skills', stem);
    let cur = '';
    try {
      cur = fs.readlinkSync(target);
    } catch (_) {
      cur = '';
    }
    if (cur === want) delivered += 1;
  }
  return { delivered, names };
}

/** Count CAP_MARKER-tagged contribution-toolkit entries in the sandbox settings.json, grouped by event. */
function countTagged(settingsPath) {
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const hooks = settings && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks)
    ? settings.hooks
    : {};
  const byEvent = {};
  let total = 0;
  for (const event of Object.keys(hooks)) {
    if (!Array.isArray(hooks[event])) continue;
    for (const e of hooks[event]) {
      if (e && typeof e === 'object' && e[CAP_MARKER] === CAP_ID) {
        total += 1;
        byEvent[event] = (byEvent[event] || 0) + 1;
      }
    }
  }
  return { total, byEvent };
}

/**
 * Extract every CAP_MARKER-tagged hook command from the sandbox settings, parse out the wired script
 * path (the single-quoted absolute path the LIVE confinedBundleScript writes after `node `), and return
 * the list of commands whose script does NOT resolve to a real file. An EMPTY list proves the promoted
 * capDir resolves the wired gates (INST-02); a NON-empty list is the exact dangling-path silent-inert
 * defect — the settings point the gates at scripts that do not exist because the bundle was never promoted.
 */
function unresolvedWiredScripts(settingsPath) {
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const hooks = settings && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks)
    ? settings.hooks
    : {};
  const bad = [];
  for (const event of Object.keys(hooks)) {
    if (!Array.isArray(hooks[event])) continue;
    for (const e of hooks[event]) {
      if (!(e && typeof e === 'object' && e[CAP_MARKER] === CAP_ID)) continue;
      const inner = Array.isArray(e.hooks) ? e.hooks : [];
      for (const h of inner) {
        const cmd = h && typeof h.command === 'string' ? h.command : '';
        const m = cmd.match(/'([^']+)'/); // the confined absolute script path is single-quoted
        const scriptPath = m ? m[1] : '';
        if (!scriptPath || !fs.existsSync(scriptPath)) bad.push(cmd);
      }
    }
  }
  return bad;
}

/** The promoted capDir the LIVE engine composes the wired command paths against. */
function sandboxCapDir(sb) {
  return path.join(sb.root, '.gsd', 'capabilities', CAP_ID);
}

/** True iff the pre-seeded UNTAGGED user hook still exists (proves a marker-scoped strip). */
function userHookSurvives(settingsPath) {
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const pre = (settings.hooks && settings.hooks.PreToolUse) || [];
  return pre.some((e) => e && e._userOwned === true && !Object.prototype.hasOwnProperty.call(e, CAP_MARKER));
}

/** Read the sandboxed ledger; true iff a contribution-toolkit entry exists. */
function ledgerHasCap(sb) {
  const led = requireLiveScript(sb.root, 'gsd-core/bin/lib/capability-ledger.cjs');
  let store = null;
  try {
    store = led.readLedger(sb.root);
  } catch (_) {
    return false;
  }
  return !!(store && store.entries && Object.prototype.hasOwnProperty.call(store.entries, CAP_ID));
}

/**
 * Read the enforcement flag the on/off toggle flips, from the sandbox .planning/config.json. The LIVE
 * config.setConfigValue stores dot-notation keys NESTED (capability-source: gsd-core config.cjs
 * _setNestedValue splits on '.'), so `workflow.gsd_contrib_enforcement` lands at
 * config.workflow.gsd_contrib_enforcement — NOT a flat string key. Returns the leaf value (undefined
 * when absent). WR-02: this proves the on/off flag flip actually happened (a silent setConfigValue
 * failure, or a namespace drift, would surface here).
 */
function readEnforcementFlag(sb) {
  const cfg = JSON.parse(fs.readFileSync(path.join(sb.root, '.planning', 'config.json'), 'utf8'));
  return cfg && cfg.workflow ? cfg.workflow.gsd_contrib_enforcement : undefined;
}

/** Read the sandboxed consent store; true iff a contribution-toolkit record exists. */
function consentHasCap(sb) {
  const cs = requireLiveScript(sb.root, 'gsd-core/bin/lib/capability-consent.cjs');
  let store = null;
  try {
    store = cs.readConsentStore(sb.gsdHome);
  } catch (_) {
    return false;
  }
  const records = (store && store.records) || {};
  return Object.keys(records).some((k) => records[k] && records[k].id === CAP_ID);
}

// ───────────────────────── manifest sanity: exactly 13 hooks (12 + 1) ─────────────────────────

test('manifest declares EXACTLY the 12 PreToolUse gates + 1 UserPromptSubmit advisory (= 13)', () => {
  const manifest = drv.readManifest();
  assert.strictEqual(manifest.id, CAP_ID, 'manifest id must be contribution-toolkit');
  const hooks = Array.isArray(manifest.hooks) ? manifest.hooks : [];
  assert.strictEqual(hooks.length, 13, 'manifest hooks[] must declare exactly 13 entries');
  const pre = hooks.filter((h) => h.event === 'PreToolUse').length;
  const ups = hooks.filter((h) => h.event === 'UserPromptSubmit').length;
  assert.strictEqual(pre, 12, 'exactly 12 PreToolUse gates');
  assert.strictEqual(ups, 1, 'exactly 1 UserPromptSubmit advisory');
});

// ───────────────────────── the load-bearing lifecycle proof ─────────────────────────

test('install -> off -> on -> remove on a disposable sandbox; exactly 13 tagged, untagged survives, real state unchanged', { skip: SKIP }, () => {
  // Snapshot the REAL gsd-core state + real consent BEFORE — must be byte/existence-identical AFTER.
  const before = snapshotRealState(SOURCE_ROOT);

  const sb = makeCapSandbox(SOURCE_ROOT);
  try {
    // Sanity: the sandbox resolves to ITSELF (never the real checkout) — the TOCTOU mitigation.
    assert.strictEqual(
      resolveGsdCoreRoot(sb.root),
      sb.root,
      'the sandbox must resolve to itself as a gsd-core root, not walk up to the real checkout'
    );

    const opts = sandboxOpts(sb);

    // ── install: exactly 13 CAP_MARKER-tagged entries (12 PreToolUse + 1 UserPromptSubmit) ──
    drv.runInstall(opts);
    let tagged = countTagged(sb.settingsPath);
    assert.strictEqual(tagged.total, 13, 'install must tag EXACTLY 13 entries, got ' + tagged.total);
    assert.strictEqual(tagged.byEvent.PreToolUse, 12, 'exactly 12 PreToolUse gates tagged');
    assert.strictEqual(tagged.byEvent.UserPromptSubmit, 1, 'exactly 1 UserPromptSubmit advisory tagged');
    assert.strictEqual(userHookSurvives(sb.settingsPath), true, 'the pre-seeded untagged user hook must survive install');
    assert.strictEqual(ledgerHasCap(sb), true, 'install must record a ledger entry for contribution-toolkit');
    assert.strictEqual(consentHasCap(sb), true, 'install must record a consent record for contribution-toolkit');
    // 17-02: install delivers the 5 bundled slash-commands as symlinks → the bundle, into the SANDBOX
    // commands dir (never the real ~/.claude/commands — confined via sandboxOpts.commandsDir).
    let cmds = countDeliveredCommands(sb);
    assert.strictEqual(cmds.names.length, 5, 'the bundle must ship exactly 5 slash-commands');
    assert.strictEqual(cmds.delivered, 5, 'install must deliver all 5 command symlinks → the bundle, got ' + cmds.delivered);
    // 21-02: install ALSO delivers the 2 bundled skills as dir-symlinks → the bundle, into the SANDBOX
    // skills dir (never the real ~/.claude/skills — confined via sandboxOpts.skillsDir).
    let skl = countDeliveredSkills(sb);
    assert.strictEqual(skl.names.length, 2, 'the bundle must ship exactly 2 skills');
    assert.strictEqual(skl.delivered, 2, 'install must deliver all 2 skill symlinks → the bundle, got ' + skl.delivered);
    // 21-02: install lands FULLY ON — the enforcement flag is true after install.
    assert.strictEqual(
      readEnforcementFlag(sb),
      true,
      'install must set workflow.gsd_contrib_enforcement=true (install lands fully ON)'
    );

    // ── off: EXACTLY the 13 tagged entries stripped; the UNTAGGED user hook SURVIVES ──
    drv.runOff(Object.assign({}, opts, { reason: 'CAP-07 hermetic lifecycle proof: off' }));
    tagged = countTagged(sb.settingsPath);
    assert.strictEqual(tagged.total, 0, 'off must strip EXACTLY the 13 tagged entries, leftover=' + tagged.total);
    assert.strictEqual(
      userHookSurvives(sb.settingsPath),
      true,
      'off MUST be marker-scoped: the pre-seeded untagged user hook must SURVIVE the strip (not a blanket wipe)'
    );
    // WR-02: off must flip workflow.gsd_contrib_enforcement OFF in config.json (read it back).
    assert.strictEqual(
      readEnforcementFlag(sb),
      false,
      'runOff must set workflow.gsd_contrib_enforcement=false in config.json'
    );
    // 21-02 (REVERSES 17-02): off OWNS the full surface — it reclaims BOTH the 5 command links AND the
    // 2 skill links (commands/skills are enforcement-coupled availability now, governed by on/off).
    cmds = countDeliveredCommands(sb);
    assert.strictEqual(cmds.delivered, 0, 'off must reclaim all 5 command links (full-surface toggle), leftover=' + cmds.delivered);
    skl = countDeliveredSkills(sb);
    assert.strictEqual(skl.delivered, 0, 'off must reclaim all 2 skill links (full-surface toggle), leftover=' + skl.delivered);

    // ── on: the 13 tagged entries are restored (and the untagged user hook is still there) ──
    drv.runOn(opts);
    tagged = countTagged(sb.settingsPath);
    assert.strictEqual(tagged.total, 13, 'on must restore EXACTLY 13 tagged entries, got ' + tagged.total);
    assert.strictEqual(tagged.byEvent.PreToolUse, 12, 'on restores 12 PreToolUse gates');
    assert.strictEqual(tagged.byEvent.UserPromptSubmit, 1, 'on restores 1 UserPromptSubmit advisory');
    assert.strictEqual(userHookSurvives(sb.settingsPath), true, 'the untagged user hook must still survive after on');
    // WR-02: on must flip workflow.gsd_contrib_enforcement ON in config.json (read it back).
    assert.strictEqual(
      readEnforcementFlag(sb),
      true,
      'runOn must set workflow.gsd_contrib_enforcement=true in config.json'
    );
    // 21-02: off→on round-trips the FULL surface — on restores the 5 command links + 2 skill links
    // that off reclaimed (ledger/consent/bundle preserved by off make this restoration possible).
    cmds = countDeliveredCommands(sb);
    assert.strictEqual(cmds.delivered, 5, 'on must restore all 5 command links (off→on round-trip), got ' + cmds.delivered);
    skl = countDeliveredSkills(sb);
    assert.strictEqual(skl.delivered, 2, 'on must restore all 2 skill links (off→on round-trip), got ' + skl.delivered);

    // ── remove: no ledger entry + no consent record for contribution-toolkit remain in the sandbox store ──
    drv.runRemove(Object.assign({}, opts, { reason: 'CAP-07 hermetic lifecycle proof: remove' }));
    tagged = countTagged(sb.settingsPath);
    assert.strictEqual(tagged.total, 0, 'remove must leave no tagged gates, leftover=' + tagged.total);
    assert.strictEqual(ledgerHasCap(sb), false, 'remove must drop the ledger entry for contribution-toolkit');
    assert.strictEqual(consentHasCap(sb), false, 'remove must revoke the consent record for contribution-toolkit');
    assert.strictEqual(
      userHookSurvives(sb.settingsPath),
      true,
      'the pre-seeded untagged user hook must STILL survive after the full cycle'
    );
    // 17-02: remove reclaims EXACTLY the 5 delivered command links — none remain after the cycle.
    cmds = countDeliveredCommands(sb);
    assert.strictEqual(cmds.delivered, 0, 'remove must reclaim all 5 delivered command links, leftover=' + cmds.delivered);
    // 21-02: remove reclaims the 2 delivered skill links too (permanent teardown of BOTH surfaces).
    skl = countDeliveredSkills(sb);
    assert.strictEqual(skl.delivered, 0, 'remove must reclaim all 2 delivered skill links, leftover=' + skl.delivered);
  } finally {
    sb.dispose();
  }

  // ── hermeticity: the REAL gsd-core settings + real ledger + real consent are UNCHANGED ──
  assertRealStateUnchanged(before);
});

test('double-install is idempotent: a second install keeps the tagged set at 13 (no growth)', { skip: SKIP }, () => {
  // WR-02: the driver claims re-run idempotency (LIVE apply strips its own marker first). Prove it
  // empirically — a second install that grew the tagged set from 13 to 26 must be caught here.
  const before = snapshotRealState(SOURCE_ROOT);
  const sb = makeCapSandbox(SOURCE_ROOT);
  try {
    const opts = sandboxOpts(sb);

    drv.runInstall(opts);
    let tagged = countTagged(sb.settingsPath);
    assert.strictEqual(tagged.total, 13, 'first install must tag EXACTLY 13 entries, got ' + tagged.total);

    drv.runInstall(opts); // second call — must NOT append a second tagged set.
    tagged = countTagged(sb.settingsPath);
    assert.strictEqual(tagged.total, 13, 'double-install must NOT grow the tagged set (idempotent), got ' + tagged.total);
    assert.strictEqual(tagged.byEvent.PreToolUse, 12, 'still exactly 12 PreToolUse gates after re-install');
    assert.strictEqual(tagged.byEvent.UserPromptSubmit, 1, 'still exactly 1 UserPromptSubmit advisory after re-install');
    assert.strictEqual(
      userHookSurvives(sb.settingsPath),
      true,
      'the pre-seeded untagged user hook must survive a double-install'
    );
  } finally {
    sb.dispose();
  }
  assertRealStateUnchanged(before);
});

// ───────────────────────── 28-01 INST-02: driver-owned bundle promotion (RED→GREEN) ─────────────────────────

test('install PROMOTES the bundle so the capDir resolves + every wired command script is a real file (INST-02)', { skip: SKIP }, () => {
  // INST-02 (D-01/D-02) RED→GREEN pivot. Today the driver "never calls resolveCapabilitySource" and
  // ASSUMES a pre-promoted <liveRoot>/.gsd/capabilities/contribution-toolkit bundle already exists — it
  // does NOT create it, so the LIVE apply realpaths an ABSENT capDir, falls into confinedBundleScript's
  // lexical catch-branch, and emits DANGLING command paths → enforcement silently INERT. This test
  // FAILS on the pre-promotion driver (capDir absent + wired scripts unresolved) and PASSES once
  // promoteBundle is wired into runInstall (Task 2).
  const before = snapshotRealState(SOURCE_ROOT);
  const sb = makeCapSandbox(SOURCE_ROOT);
  try {
    const opts = sandboxOpts(sb);
    drv.runInstall(opts);

    // (a) the promoted capDir must RESOLVE (present) after install — the promotion the driver now OWNS.
    const capDir = sandboxCapDir(sb);
    assert.ok(
      fs.existsSync(capDir),
      'install must promote the bundle so <liveRoot>/.gsd/capabilities/' + CAP_ID + ' resolves (INST-02)'
    );
    // The promoted capDir's own hooks/ must resolve to real files (the wired gates point INTO it).
    assert.ok(
      fs.existsSync(path.join(capDir, 'hooks')),
      'the promoted capDir must expose its hooks/ dir (the wired gates resolve INTO it)'
    );

    // (b) every CAP_MARKER-tagged wired command script must resolve to a real file — no dangling paths.
    const unresolved = unresolvedWiredScripts(sb.settingsPath);
    assert.deepStrictEqual(
      unresolved,
      [],
      'every wired command script must resolve to a real file after promotion (no silent-inert dangling ' +
        'paths); unresolved: ' + JSON.stringify(unresolved)
    );
  } finally {
    sb.dispose();
  }
  // Hermeticity preserved: the promoted capDir lands INSIDE the sandbox — the real checkout is untouched.
  assertRealStateUnchanged(before);
});

test('off without a reason FAILS before mutation; the sandbox settings are untouched', { skip: SKIP }, () => {
  const sb = makeCapSandbox(SOURCE_ROOT);
  try {
    const opts = sandboxOpts(sb);
    drv.runInstall(opts);
    const before = sha(sb.settingsPath);
    assert.throws(
      () => drv.runOff(Object.assign({}, opts, { reason: '   ' })),
      /reason/i,
      'off with an empty/whitespace --reason must FAIL (accountability gate before mutation)'
    );
    assert.strictEqual(sha(sb.settingsPath), before, 'a rejected off must NOT mutate the settings (gate runs first)');
    assert.strictEqual(countTagged(sb.settingsPath).total, 13, 'the 13 tagged gates remain after the rejected off');
  } finally {
    sb.dispose();
  }
});

test('off whose receipt cannot be written FAILS probe-first; gates/commands/skills/flag are ALL untouched', { skip: SKIP }, () => {
  // CR-01 / T-21-05: probeReceiptWritable runs FIRST — a disable that cannot be LOGGED must FAIL with
  // ZERO state mutated (never strip-then-fail-to-record). Make the receipt UN-writable by planting a
  // regular FILE where the receipt's parent dir (<liveRoot>/.gsd-contrib) must be — mkdir(recursive)
  // over an existing file throws, so the probe throws BEFORE any strip/reclaim/flag-flip.
  const before = snapshotRealState(SOURCE_ROOT);
  const sb = makeCapSandbox(SOURCE_ROOT);
  try {
    const opts = sandboxOpts(sb);
    drv.runInstall(opts);

    // Pre-condition: fully ON (13 gates + 5 commands + 2 skills + flag true).
    assert.strictEqual(countTagged(sb.settingsPath).total, 13, 'pre: 13 tagged gates');
    assert.strictEqual(countDeliveredCommands(sb).delivered, 5, 'pre: 5 command links');
    assert.strictEqual(countDeliveredSkills(sb).delivered, 2, 'pre: 2 skill links');
    assert.strictEqual(readEnforcementFlag(sb), true, 'pre: enforcement flag true');

    // Plant a regular file at <liveRoot>/.gsd-contrib so the receipt-dir mkdir (probe) fails.
    const receiptDir = path.join(sb.root, '.gsd-contrib');
    fs.writeFileSync(receiptDir, 'not a directory — forces the receipt probe to fail\n', 'utf8');
    const settingsBefore = sha(sb.settingsPath);

    assert.throws(
      () => drv.runOff(Object.assign({}, opts, { reason: 'CR-01 probe-first proof: receipt unwritable' })),
      (err) => err instanceof drv.DriverError && /accountability receipt/i.test(err.message),
      'off must FAIL when the receipt cannot be written (probe-first), not strip-then-fail-to-record'
    );

    // ZERO mutation: gates, commands, skills, flag, and the settings bytes are ALL unchanged.
    assert.strictEqual(sha(sb.settingsPath), settingsBefore, 'a probe-failed off must NOT mutate settings.json');
    assert.strictEqual(countTagged(sb.settingsPath).total, 13, 'the 13 tagged gates remain after the probe-failed off');
    assert.strictEqual(countDeliveredCommands(sb).delivered, 5, 'the 5 command links remain after the probe-failed off (no reclaim)');
    assert.strictEqual(countDeliveredSkills(sb).delivered, 2, 'the 2 skill links remain after the probe-failed off (no reclaim)');
    assert.strictEqual(readEnforcementFlag(sb), true, 'the enforcement flag stays true after the probe-failed off (no flip)');
  } finally {
    sb.dispose();
  }
  assertRealStateUnchanged(before);
});

test('the sandbox temp root is removed by dispose() (no temp consent/ledger residue leaks)', { skip: SKIP }, () => {
  const sb = makeCapSandbox(SOURCE_ROOT);
  const root = sb.root;
  drv.runInstall(sandboxOpts(sb));
  assert.strictEqual(fs.existsSync(root), true, 'the sandbox exists during the test');
  sb.dispose();
  assert.strictEqual(fs.existsSync(root), false, 'dispose() must rmSync the sandbox (T-12-03-LEAK)');
});

// ───────────────────────── 17-02 command-delivery fail-safes ─────────────────────────

test('a pre-seeded REAL command file is NEVER clobbered by install and NEVER reclaimed by remove', { skip: SKIP }, () => {
  // T-17-02-CLOBBER + T-17-02-OVERREMOVE: a real (non-symlink) file at a command target must survive
  // BOTH install (install FAILS LOUD rather than overwrite it) and remove (remove leaves it untouched
  // — it only reclaims symlinks pointing into our bundle).
  const before = snapshotRealState(SOURCE_ROOT);
  const sb = makeCapSandbox(SOURCE_ROOT);
  try {
    const opts = sandboxOpts(sb);
    const names = bundledCommandNames();
    const realTarget = path.join(sb.commandsDir, names[0]);
    const REAL_BODY = '# a REAL user file at a command path — must NEVER be clobbered\n';
    fs.mkdirSync(sb.commandsDir, { recursive: true });
    fs.writeFileSync(realTarget, REAL_BODY, 'utf8');

    // install must FAIL LOUD (never clobber the real file) — the fail-safe mirrors install.sh L73.
    assert.throws(
      () => drv.runInstall(opts),
      /refusing to overwrite existing entry/i,
      'install must refuse to clobber a real non-symlink file at a command target (T-17-02-CLOBBER)'
    );
    assert.strictEqual(fs.readFileSync(realTarget, 'utf8'), REAL_BODY, 'the real file must be byte-identical after the refused install');
    assert.strictEqual(fs.lstatSync(realTarget).isSymbolicLink(), false, 'the real file must NOT have become a symlink');

    // remove must leave the real file untouched (it only reclaims symlinks into our bundle).
    drv.runRemove(Object.assign({}, opts, { reason: '17-02 fail-safe proof: real file survives remove' }));
    assert.strictEqual(fs.existsSync(realTarget), true, 'remove must NOT reclaim a real file at a command target (T-17-02-OVERREMOVE)');
    assert.strictEqual(fs.readFileSync(realTarget, 'utf8'), REAL_BODY, 'the real file must be byte-identical after remove');
  } finally {
    sb.dispose();
  }
  assertRealStateUnchanged(before);
});

test('partial delivery: a conflict at the last command leaves earlier symlinks reclaimed by remove', { skip: SKIP }, () => {
  // WR-02: plant a real file at the LAST bundled command name so names[0..N-2] are linked as symlinks
  // before the throw, then prove removeBundledCommands reclaims exactly those N-1 orphaned symlinks
  // and leaves the planted real file intact (T-17-02-OVERREMOVE + partial-delivery path coverage).
  const sb = makeCapSandbox(SOURCE_ROOT);
  try {
    const opts = sandboxOpts(sb);
    const names = bundledCommandNames();
    const last = names[names.length - 1];
    const realTarget = path.join(sb.commandsDir, last);
    fs.mkdirSync(sb.commandsDir, { recursive: true });
    fs.writeFileSync(realTarget, '# real file — planted at the last command position\n', 'utf8');

    // install throws at the last name (N-1 symlinks were already created before the throw).
    assert.throws(
      () => drv.runInstall(opts),
      /refusing to overwrite existing entry/i,
      'install must fail loud on the last-command conflict (T-17-02-CLOBBER)'
    );

    // N-1 symlinks are present as partial delivery.
    const partialCount = names.slice(0, names.length - 1).filter(
      (n) => fs.existsSync(path.join(sb.commandsDir, n))
    ).length;
    assert.strictEqual(partialCount, names.length - 1, 'N-1 commands must be partially delivered before the throw');

    // remove reclaims the N-1 partial symlinks; the planted real file must survive untouched.
    drv.runRemove(Object.assign({}, opts, { reason: 'WR-02 partial-delivery reclaim proof' }));
    for (const n of names.slice(0, names.length - 1)) {
      assert.ok(
        !fs.existsSync(path.join(sb.commandsDir, n)),
        n + ': partial symlink must be reclaimed by remove'
      );
    }
    assert.ok(fs.existsSync(realTarget), 'the planted real file must survive remove (T-17-02-OVERREMOVE)');
  } finally {
    sb.dispose();
  }
});

test('remove leaves a FOREIGN symlink (not into our bundle) at a command target untouched', { skip: SKIP }, () => {
  // T-17-02-OVERREMOVE: a symlink pointing somewhere OTHER than our bundle is not ours to reclaim.
  const sb = makeCapSandbox(SOURCE_ROOT);
  try {
    const opts = sandboxOpts(sb);
    const names = bundledCommandNames();
    // Install delivers the 5 bundle symlinks first.
    drv.runInstall(opts);
    // Replace one delivered link with a FOREIGN symlink (points outside our bundle).
    const foreignTarget = path.join(sb.commandsDir, names[0]);
    const foreignDest = path.join(sb.root, 'somewhere-else.md');
    fs.writeFileSync(foreignDest, 'foreign\n', 'utf8');
    fs.rmSync(foreignTarget, { force: true });
    fs.symlinkSync(foreignDest, foreignTarget);

    drv.runRemove(Object.assign({}, opts, { reason: '17-02 fail-safe proof: foreign symlink survives remove' }));
    assert.strictEqual(fs.existsSync(foreignTarget), true, 'remove must leave a foreign symlink untouched');
    assert.strictEqual(fs.readlinkSync(foreignTarget), foreignDest, 'the foreign symlink target must be unchanged');
  } finally {
    sb.dispose();
  }
});

// ───────────────────────── 21-01 skill-delivery primitives (TOG-02) ─────────────────────────
//
// The skill helpers are DIRECTORY-symlink mirrors of the command helpers (skills are <stem>/SKILL.md
// trees, not flat .md files). These tests prove the primitives IN ISOLATION (they are dead code until
// 21-02 wires them into the lifecycle). No LIVE gsd-core engine is needed — these are pure fs unit
// probes, so they run unconditionally (no SKIP).

/** The 2 bundled skill stems (data-driven from the REAL bundle skills/ dir). */
const EXPECTED_SKILL_STEMS = ['gsd-core-contribution', 'maintainer-review-sweep'];

test('claudeSkillsDir resolves ${CLAUDE_DIR:-~/.claude}/skills with skillsDir>claudeDir>CLAUDE_DIR precedence', () => {
  // Default: <homedir>/.claude/skills (no CLAUDE_DIR override in scope).
  const savedEnv = process.env.CLAUDE_DIR;
  try {
    delete process.env.CLAUDE_DIR;
    assert.strictEqual(
      drv.claudeSkillsDir({}),
      path.join(os.homedir(), '.claude', 'skills'),
      'default skills dir is <homedir>/.claude/skills'
    );
    // skillsDir explicit override wins outright (mirrors commandsDir).
    assert.strictEqual(drv.claudeSkillsDir({ skillsDir: '/x/y' }), '/x/y', 'skillsDir override wins outright');
    // claudeDir override => <claudeDir>/skills.
    assert.strictEqual(drv.claudeSkillsDir({ claudeDir: '/c' }), path.join('/c', 'skills'), 'claudeDir => <claudeDir>/skills');
    // CLAUDE_DIR env => <env>/skills, but skillsDir/claudeDir still win.
    process.env.CLAUDE_DIR = '/env';
    assert.strictEqual(drv.claudeSkillsDir({}), path.join('/env', 'skills'), 'CLAUDE_DIR env => <env>/skills');
    assert.strictEqual(drv.claudeSkillsDir({ claudeDir: '/c' }), path.join('/c', 'skills'), 'claudeDir beats CLAUDE_DIR env');
    assert.strictEqual(drv.claudeSkillsDir({ skillsDir: '/x/y' }), '/x/y', 'skillsDir beats CLAUDE_DIR env');
  } finally {
    if (savedEnv === undefined) delete process.env.CLAUDE_DIR;
    else process.env.CLAUDE_DIR = savedEnv;
  }
});

test('bundledSkillNames enumerates the 2 SKILL.md-bearing subdirs of the BUNDLE skills/ dir, sorted', () => {
  const names = drv.bundledSkillNames(drv.BUNDLE_CAP_DIR);
  assert.deepStrictEqual(
    names.slice().sort(),
    EXPECTED_SKILL_STEMS,
    'bundledSkillNames returns exactly the 2 bundle skill stems (T-17-02-REPOSOURCE: sourced from the bundle)'
  );
  // Returned already sorted.
  assert.deepStrictEqual(names, EXPECTED_SKILL_STEMS, 'bundledSkillNames returns the stems sorted');
});

test('bundledSkillNames throws DriverError (LOUD-on-miss) when the bundle has no skills/ dir', () => {
  const sb = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-noskills-'));
  try {
    assert.throws(
      () => drv.bundledSkillNames(sb),
      (err) => (err instanceof drv.DriverError) && /skills/.test(err.message),
      'a bundle with no skills/ dir must FAIL LOUD (mirrors bundledCommandNames ENOENT-throw)'
    );
  } finally {
    fs.rmSync(sb, { recursive: true, force: true });
  }
});

test('deliverBundledSkills creates idempotent DIRECTORY symlinks per stem; re-points a stale symlink', () => {
  const sb = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-deliver-'));
  try {
    const skillsDir = path.join(sb, 'skills');
    const r = drv.deliverBundledSkills({ bundleDir: drv.BUNDLE_CAP_DIR, skillsDir });
    assert.strictEqual(r.linked, 2, 'first deliver links both stems');
    assert.strictEqual(r.already, 0, 'first deliver has none already correct');
    assert.deepStrictEqual(r.names.slice().sort(), EXPECTED_SKILL_STEMS, 'names lists both stems');
    for (const stem of EXPECTED_SKILL_STEMS) {
      const target = path.join(skillsDir, stem);
      const st = fs.lstatSync(target);
      assert.ok(st.isSymbolicLink(), stem + ' target must be a symlink');
      assert.strictEqual(
        fs.readlinkSync(target),
        path.join(drv.BUNDLE_CAP_DIR, 'skills', stem),
        stem + ' symlink must point at the bundle source (absolute)'
      );
      // It is a DIRECTORY symlink — statSync (follows) sees a dir containing SKILL.md.
      assert.ok(fs.statSync(target).isDirectory(), stem + ' followed target must be a directory');
      assert.ok(fs.existsSync(path.join(target, 'SKILL.md')), stem + ' followed target must contain SKILL.md');
    }
    // Idempotent: a second run links nothing, counts both as already correct.
    const r2 = drv.deliverBundledSkills({ bundleDir: drv.BUNDLE_CAP_DIR, skillsDir });
    assert.strictEqual(r2.linked, 0, 'second deliver links nothing (idempotent)');
    assert.strictEqual(r2.already, 2, 'second deliver counts both already correct');

    // A stale symlink (points elsewhere) is re-pointed, not errored.
    const stem = EXPECTED_SKILL_STEMS[0];
    const target = path.join(skillsDir, stem);
    const elsewhere = path.join(sb, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.rmSync(target, { force: true });
    fs.symlinkSync(elsewhere, target, 'dir');
    const r3 = drv.deliverBundledSkills({ bundleDir: drv.BUNDLE_CAP_DIR, skillsDir });
    assert.strictEqual(r3.linked, 1, 're-pointing a stale symlink counts as linked');
    assert.strictEqual(r3.already, 1, 'the other stem stays already correct');
    assert.strictEqual(
      fs.readlinkSync(target),
      path.join(drv.BUNDLE_CAP_DIR, 'skills', stem),
      're-pointed symlink now points at the bundle source'
    );
  } finally {
    fs.rmSync(sb, { recursive: true, force: true });
  }
});

test('deliverBundledSkills NEVER clobbers a real (non-symlink) dir at a skill target (T-17-02-CLOBBER)', () => {
  const sb = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-clobber-'));
  try {
    const skillsDir = path.join(sb, 'skills');
    const stem = EXPECTED_SKILL_STEMS[0];
    const realTarget = path.join(skillsDir, stem);
    fs.mkdirSync(realTarget, { recursive: true });
    const REAL_BODY = '# a REAL user skill dir — must NEVER be clobbered\n';
    fs.writeFileSync(path.join(realTarget, 'SKILL.md'), REAL_BODY, 'utf8');

    assert.throws(
      () => drv.deliverBundledSkills({ bundleDir: drv.BUNDLE_CAP_DIR, skillsDir }),
      (err) => (err instanceof drv.DriverError) && /refusing to overwrite/i.test(err.message),
      'deliver must refuse to clobber a real dir at a skill target (T-17-02-CLOBBER)'
    );
    // The real dir's contents must be byte-intact and NOT a symlink.
    assert.strictEqual(fs.lstatSync(realTarget).isSymbolicLink(), false, 'the real dir must NOT have become a symlink');
    assert.strictEqual(fs.readFileSync(path.join(realTarget, 'SKILL.md'), 'utf8'), REAL_BODY, 'the real SKILL.md must be byte-intact');
  } finally {
    fs.rmSync(sb, { recursive: true, force: true });
  }
});

test('removeBundledSkills unlinks ONLY our-bundle links; the bundle SKILL.md is never recursed/deleted', () => {
  const sb = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-remove-'));
  try {
    const skillsDir = path.join(sb, 'skills');
    drv.deliverBundledSkills({ bundleDir: drv.BUNDLE_CAP_DIR, skillsDir });
    const rm = drv.removeBundledSkills({ bundleDir: drv.BUNDLE_CAP_DIR, skillsDir });
    assert.strictEqual(rm.removed, 2, 'remove unlinks both delivered links');
    for (const stem of EXPECTED_SKILL_STEMS) {
      assert.strictEqual(fs.existsSync(path.join(skillsDir, stem)), false, stem + ' link must be reclaimed');
      // CRITICAL: the unlink removed the LINK only — the bundle's real SKILL.md still exists.
      assert.ok(
        fs.existsSync(path.join(drv.BUNDLE_CAP_DIR, 'skills', stem, 'SKILL.md')),
        stem + ' bundle SKILL.md must survive (never recursed into / deleted via the followed target)'
      );
    }
  } finally {
    fs.rmSync(sb, { recursive: true, force: true });
  }
});

test('removeBundledSkills leaves a REAL dir at a skill target untouched (T-17-02-OVERREMOVE)', () => {
  const sb = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-rm-realdir-'));
  try {
    const skillsDir = path.join(sb, 'skills');
    const stem = EXPECTED_SKILL_STEMS[0];
    const realTarget = path.join(skillsDir, stem);
    fs.mkdirSync(realTarget, { recursive: true });
    const REAL_BODY = '# real skill dir at a target — remove must leave it\n';
    fs.writeFileSync(path.join(realTarget, 'SKILL.md'), REAL_BODY, 'utf8');

    const rm = drv.removeBundledSkills({ bundleDir: drv.BUNDLE_CAP_DIR, skillsDir });
    assert.strictEqual(rm.removed, 0, 'remove must reclaim nothing (a real dir is not ours)');
    assert.strictEqual(fs.existsSync(realTarget), true, 'the real dir must survive remove (T-17-02-OVERREMOVE)');
    assert.strictEqual(fs.readFileSync(path.join(realTarget, 'SKILL.md'), 'utf8'), REAL_BODY, 'real SKILL.md byte-intact');
  } finally {
    fs.rmSync(sb, { recursive: true, force: true });
  }
});

test('removeBundledSkills leaves a FOREIGN symlink (outside our bundle) untouched (T-17-02-OVERREMOVE)', () => {
  const sb = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-rm-foreign-'));
  try {
    const skillsDir = path.join(sb, 'skills');
    const stem = EXPECTED_SKILL_STEMS[0];
    const foreignTarget = path.join(skillsDir, stem);
    const foreignDest = path.join(sb, 'foreign-skill');
    fs.mkdirSync(foreignDest, { recursive: true });
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.symlinkSync(foreignDest, foreignTarget, 'dir');

    const rm = drv.removeBundledSkills({ bundleDir: drv.BUNDLE_CAP_DIR, skillsDir });
    assert.strictEqual(rm.removed, 0, 'a foreign symlink is not ours to reclaim');
    assert.strictEqual(fs.existsSync(foreignTarget), true, 'the foreign symlink must survive remove');
    assert.strictEqual(fs.readlinkSync(foreignTarget), foreignDest, 'the foreign symlink target must be unchanged');
  } finally {
    fs.rmSync(sb, { recursive: true, force: true });
  }
});

test('removeBundledSkills returns {removed:0} on a vanished bundle skills/ dir (ENOENT => nothing we own)', () => {
  const sb = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-rm-enoent-'));
  try {
    const skillsDir = path.join(sb, 'skills');
    // bundleDir has no skills/ dir => bundledSkillNames throws ENOENT => remove returns {removed:0}.
    const rm = drv.removeBundledSkills({ bundleDir: sb, skillsDir });
    assert.strictEqual(rm.removed, 0, 'a vanished bundle skills/ dir means nothing we own to reclaim');
    assert.deepStrictEqual(rm.names, [], 'names empty on the ENOENT path');
  } finally {
    fs.rmSync(sb, { recursive: true, force: true });
  }
});
