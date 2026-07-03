'use strict';

/**
 * bin/install-delivers-commands.test.cjs — the CAP-10 empirical LOCAL-install command-delivery proof.
 *
 * This is the verifier-reach=spec-reach proof for "a remote-style bundle install reproduces the LOCAL
 * slash-command experience": the 5 bundled `gsd-*.md` slash-commands MATERIALIZE in a sandbox runtime
 * commands dir from a bundle install (alongside the skills + hooks the existing proofs cover), and
 * `remove` accountably RECLAIMS exactly those links. It mirrors bin/install-delivers-skills.test.cjs:
 * a DISPOSABLE mkdtemp sandbox, the LIVE delivery engine (bin/contrib-capability.cjs
 * deliverBundledCommands / removeBundledCommands, and — for the end-to-end half — runInstall/runRemove
 * driving the LIVE gsd-core engine), assertions on the ON-DISK materialized result (never a mock),
 * cleanup in a finally.
 *
 * THREE LEVELS, each at the honest reachability bar (T-17-03-FALSEGREEN):
 *
 *   1. DELIVERY + RECLAIM (UNCONDITIONAL) — drives the REAL deliverBundledCommands / removeBundledCommands
 *      directly. These are pure node:fs over the BUNDLE (no live gsd-core checkout required), so this
 *      half runs ALWAYS. It asserts: each of the 5 `gsd-*.md` materializes at <sandbox>/.claude/commands/
 *      <name>.md as a SYMLINK resolving INTO the bundle, byte-identical to the canonical commands/<name>.md;
 *      a pre-seeded REAL non-symlink command file is NEVER clobbered by install AND NEVER reclaimed by
 *      remove; remove reclaims EXACTLY the 5 bundle links.
 *
 *   2. END-TO-END (SKIP-on-unreachable) — drives the full runInstall -> runRemove against a disposable
 *      sandbox gsd-core checkout (sentinel layout + symlinked LIVE engine) with a sandbox CLAUDE_DIR
 *      commands dir + sandbox GSD_HOME. This exercises the SAME composed LIVE engine a real
 *      `capability install` drives, proving the commands land ALONGSIDE the skills + hooks the existing
 *      proofs cover. When no LIVE gsd-core checkout is reachable it SKIPs-with-note (never a false green).
 *
 *   3. HONESTY (UNCONDITIONAL) — asserts the bundled manifest has NO `commands[]` CLI-router array
 *      (ADR-959: agent-facing slash-commands MUST NOT be conflated with first-party gsd-tools CLI
 *      subcommand routers), the 5 commands ARE prose-disclosed in `description`, and
 *      `node bin/build-capability.cjs --check` exits 0 (the bundle is self-contained incl. commands).
 *      These need no live engine, so they run even when the end-to-end half SKIPs.
 *
 * LOCAL + DISPOSABLE (privacy: publish is Phase 20 — T-17-03-NONHERMETIC): the source is the LOCAL
 * in-repo bundle, the runtime commands dir is a mkdtemp sandbox, NOTHING is written outside the sandbox,
 * and there is NO network/push path.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const drv = require('./contrib-capability.cjs');
const { requireLiveScript, resolveGsdCoreRoot } = require('../hooks/lib/resolve.cjs');

const CAP_ID = 'contribution-toolkit';
const REPO_ROOT = path.resolve(__dirname, '..');
const BUNDLE_DIR = path.join(REPO_ROOT, 'capabilities', CAP_ID);
const CANONICAL_COMMANDS_DIR = path.join(REPO_ROOT, 'commands');
const MANIFEST_PATH = path.join(BUNDLE_DIR, 'capability.json');
const ENGINE_LIB_REL = path.join('gsd-core', 'bin', 'lib');
const SETTINGS_REL = path.join('.claude', 'settings.json');

// The 5 agent-facing slash-commands the bundle ships + the install delivers, named explicitly so a
// silently-dropped command is CAUGHT (the actual asserted set is read data-driven from the bundle).
const EXPECTED_COMMANDS = [
  'gsd-submit',
  'gsd-review-sweep',
  'gsd-triage-assist',
  'gsd-release-preflight',
  'gsd-ruleset-drift',
];

// The 2 bundled skill stems the install/on delivers alongside the commands (21-03 full-surface e2e),
// named explicitly so a silently-dropped skill is CAUGHT in the end-to-end half too.
const EXPECTED_SKILL_STEMS = ['gsd-core-contribution', 'maintainer-review-sweep'];

// ──────────────────────────────── 1. DELIVERY + RECLAIM (unconditional) ────────────────────────────────
//
// Drives the REAL deliverBundledCommands / removeBundledCommands (pure node:fs over the BUNDLE — no live
// gsd-core checkout needed), so this load-bearing half runs ALWAYS. Asserts on the ON-DISK materialized
// symlinks, never a mocked return.

test('LOCAL bundle install materializes the 5 slash-commands as bundle symlinks (byte-identical) + remove reclaims exactly them', () => {
  // Data-driven: the asserted set IS the bundle's on-disk gsd-*.md set (a dropped command is caught here
  // AND by the explicit EXPECTED_COMMANDS cross-check below).
  const names = drv.bundledCommandNames(BUNDLE_DIR);
  assert.deepStrictEqual(
    names.slice().sort(),
    EXPECTED_COMMANDS.map((n) => n + '.md').sort(),
    'the bundle commands/ dir must ship EXACTLY the 5 disclosed gsd-*.md slash-commands (a dropped/extra ' +
      'command would mean a remote install does NOT reproduce the local slash-command experience)'
  );

  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-install-commands-'));
  try {
    const commandsDir = path.join(sandbox, '.claude', 'commands');

    // A pre-seeded REAL (non-symlink) command file that must SURVIVE install (never clobbered) and
    // remove (never reclaimed) — T-17-02-CLOBBER / T-17-02-OVERREMOVE.
    fs.mkdirSync(commandsDir, { recursive: true });
    const realKeep = path.join(commandsDir, 'gsd-REAL-keep.md');
    const realKeepBytes = '# a real user-authored command — must never be clobbered or reclaimed\n';
    fs.writeFileSync(realKeep, realKeepBytes, 'utf8');

    // ── DELIVER ── drive the REAL engine against the SANDBOX commands dir (nothing outside it).
    const delivered = drv.deliverBundledCommands({ bundleDir: BUNDLE_DIR, commandsDir });
    assert.strictEqual(
      delivered.names.length,
      EXPECTED_COMMANDS.length,
      'install must deliver exactly the 5 bundled slash-commands'
    );

    // ON-DISK assertions: each of the 5 commands materialized as a SYMLINK into the bundle, resolving
    // byte-identical to its canonical source (the local-parity symlink form, not a stray copy).
    for (const base of EXPECTED_COMMANDS) {
      const name = base + '.md';
      const target = path.join(commandsDir, name);
      const absSource = path.join(BUNDLE_DIR, 'commands', name);
      const canonical = path.join(CANONICAL_COMMANDS_DIR, name);

      const st = fs.lstatSync(target);
      assert.ok(
        st.isSymbolicLink(),
        name + ' must materialize as a SYMLINK at <sandbox>/.claude/commands/' + name +
          ' (local-parity form, mirrors install.sh ln -sfn — not a copy)'
      );
      assert.strictEqual(
        fs.readlinkSync(target),
        absSource,
        name + ' symlink must resolve INTO the bundle (<BUNDLE>/commands/' + name +
          ') — a remote-installed bundle is self-sufficient (T-17-02-REPOSOURCE)'
      );
      assert.ok(
        fs.readFileSync(target).equals(fs.readFileSync(canonical)),
        'delivered ' + name + ' must be byte-identical to the canonical commands/' + name
      );
    }

    // The pre-seeded REAL file survived install untouched (never became a symlink, bytes intact).
    assert.ok(!fs.lstatSync(realKeep).isSymbolicLink(), 'a pre-seeded REAL command file must NOT be clobbered by install');
    assert.strictEqual(fs.readFileSync(realKeep, 'utf8'), realKeepBytes, 'the pre-seeded REAL command file bytes must be intact after install');

    // ── RECLAIM ── remove reclaims EXACTLY the 5 bundle links; the REAL file survives.
    const reclaimed = drv.removeBundledCommands({ bundleDir: BUNDLE_DIR, commandsDir });
    assert.strictEqual(
      reclaimed.removed,
      EXPECTED_COMMANDS.length,
      'remove must reclaim EXACTLY the 5 delivered slash-command links (only links into our bundle)'
    );
    for (const base of EXPECTED_COMMANDS) {
      const target = path.join(commandsDir, base + '.md');
      assert.ok(!fs.existsSync(target), base + '.md link must be reclaimed by remove');
    }
    assert.ok(fs.existsSync(realKeep) && !fs.lstatSync(realKeep).isSymbolicLink(), 'the pre-seeded REAL command file must SURVIVE remove (never reclaimed — T-17-02-OVERREMOVE)');
    assert.strictEqual(fs.readFileSync(realKeep, 'utf8'), realKeepBytes, 'the pre-seeded REAL command file bytes must be intact after remove');
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

// ──────────────────────────── 2. END-TO-END install -> remove (SKIP-on-unreachable) ────────────────────────────
//
// Drives the FULL runInstall -> runRemove against a disposable sandbox gsd-core checkout, proving the
// 5 commands land ALONGSIDE the skills + hooks the existing proofs cover via the SAME composed LIVE
// engine. When the LIVE engine is unreachable this SKIPs-with-note (never a false green).

function realGsdCoreRootOrNull() {
  return drv.resolveGsdCoreCwd() || null;
}
const SOURCE_ROOT = realGsdCoreRootOrNull();
const E2E_SKIP_NOTE =
  'no LIVE gsd-core checkout reachable (set GSD_CORE_ROOT, or use ~/repos/gsd-core | ~/gsd-core) — ' +
  'the end-to-end runInstall/runRemove command-delivery half SKIPPED (env limitation; never a false ' +
  'green when the engine is unreachable; the delivery+reclaim and honesty halves still run)';
const E2E_SKIP = SOURCE_ROOT ? false : E2E_SKIP_NOTE;

/**
 * Build a DISPOSABLE mkdtemp sandbox that resolves to itself as a gsd-core root (sentinel layout),
 * SYMLINKS the LIVE engine lib (read-only require), pre-seeds a writable settings.json + config.json,
 * a sandbox GSD_HOME (consent/ledger), and a sandbox CLAUDE_DIR commands dir — so EVERY driver write
 * is confined to the sandbox and NOTHING touches the real gsd-core / ~/.claude (T-17-03-NONHERMETIC).
 */
function makeSandbox(sourceRoot) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-e2e-commands-'));
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'gsd-core', 'bin'), { recursive: true });
  // Post-RES-02, hasSentinel additionally requires a LIVE gsd-core identity script under scripts/
  // (D-05: a faithful checkout fixture still resolves) — an empty stub suffices (existence-only probe).
  fs.writeFileSync(path.join(root, 'scripts', 'issue-version-gate.cjs'), '// gsd-core identity stub (RES-02 sentinel)\n', 'utf8');
  fs.symlinkSync(path.join(sourceRoot, ENGINE_LIB_REL), path.join(root, ENGINE_LIB_REL), 'dir');

  const settingsPath = path.join(root, SETTINGS_REL);
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify({}, null, 2) + '\n', 'utf8');
  fs.mkdirSync(path.join(root, '.planning'), { recursive: true });
  fs.writeFileSync(path.join(root, '.planning', 'config.json'), JSON.stringify({}, null, 2) + '\n', 'utf8');

  const gsdHome = path.join(root, '.gsdhome');
  fs.mkdirSync(gsdHome, { recursive: true });
  const commandsDir = path.join(root, '.claude-runtime', 'commands');
  // 21-02: a sandbox skills dir too — runInstall/runRemove now deliver/reclaim skills, so inject
  // skillsDir to keep the e2e hermetic (never touch the real ~/.claude/skills; T-17-03-NONHERMETIC).
  const skillsDir = path.join(root, '.claude-runtime', 'skills');

  function dispose() {
    fs.rmSync(root, { recursive: true, force: true });
  }
  return { root, gsdHome, commandsDir, skillsDir, dispose };
}

test(
  'end-to-end: runInstall delivers the 5 commands + 2 skills (alongside the 13 hooks) fully ON + runRemove reclaims both',
  { skip: E2E_SKIP },
  () => {
    const sb = makeSandbox(SOURCE_ROOT);
    try {
      // Sanity: the sandbox resolves to ITSELF (never walks up to the real checkout) — TOCTOU guard.
      assert.strictEqual(resolveGsdCoreRoot(sb.root), sb.root, 'sandbox must resolve to itself as a gsd-core root');

      const opts = { liveRoot: sb.root, consentHome: sb.gsdHome, commandsDir: sb.commandsDir, skillsDir: sb.skillsDir };

      // runInstall composes the LIVE consent/ledger/shared-edit install THEN delivers the commands.
      const installed = drv.runInstall(opts);
      assert.ok(
        installed.delivered && installed.delivered.names.length === EXPECTED_COMMANDS.length,
        'runInstall must deliver the 5 slash-commands alongside the LIVE consent/ledger/shared-edit install'
      );

      // ON-DISK: the 5 commands materialized at the runtime commands dir as bundle symlinks.
      for (const base of EXPECTED_COMMANDS) {
        const target = path.join(sb.commandsDir, base + '.md');
        const st = fs.lstatSync(target);
        assert.ok(st.isSymbolicLink(), 'runInstall must materialize ' + base + '.md as a symlink in the runtime commands dir');
        assert.strictEqual(
          fs.readlinkSync(target),
          path.join(BUNDLE_DIR, 'commands', base + '.md'),
          base + '.md must resolve into the bundle (self-sufficient remote install)'
        );
      }

      // Co-existence proof: the commands land ALONGSIDE the marker-tagged hooks the existing proof
      // covers — a remote install reproduces the FULL local experience (commands + hooks together).
      const settings = JSON.parse(fs.readFileSync(path.join(sb.root, SETTINGS_REL), 'utf8'));
      const taggedHooks = Object.keys(settings.hooks || {}).reduce((n, ev) => {
        return n + (Array.isArray(settings.hooks[ev]) ? settings.hooks[ev].filter((e) => e && e._gsdCapability === CAP_ID).length : 0);
      }, 0);
      assert.strictEqual(taggedHooks, 13, 'the 5 commands must land ALONGSIDE the 13 marker-tagged hooks (full local-parity install)');

      // 21-03 full-surface co-existence: the 2 SKILLS also land at the sandbox skills dir as bundle
      // DIRECTORY symlinks on the SAME runInstall — a remote install reproduces the FULL local surface
      // (commands + hooks + skills together).
      assert.ok(
        installed.deliveredSkills && installed.deliveredSkills.names.length === EXPECTED_SKILL_STEMS.length,
        'runInstall must deliver the 2 skills alongside the 5 commands + 13 hooks (full-surface install)'
      );
      for (const stem of EXPECTED_SKILL_STEMS) {
        const target = path.join(sb.skillsDir, stem);
        const st = fs.lstatSync(target);
        assert.ok(st.isSymbolicLink(), 'runInstall must materialize ' + stem + ' as a dir symlink in the runtime skills dir');
        assert.strictEqual(
          fs.readlinkSync(target),
          path.join(BUNDLE_DIR, 'skills', stem),
          stem + ' must resolve into the bundle (self-sufficient remote install)'
        );
      }

      // 21-03: install lands FULLY ON — the enforcement flag is true after runInstall.
      const cfg = JSON.parse(fs.readFileSync(path.join(sb.root, '.planning', 'config.json'), 'utf8'));
      assert.strictEqual(
        cfg && cfg.workflow ? cfg.workflow.gsd_contrib_enforcement : undefined,
        true,
        'runInstall must set workflow.gsd_contrib_enforcement=true (install lands fully ON)'
      );

      // runRemove reclaims exactly the 5 command links AND the 2 skill links (accountable — under the
      // LIVE remove receipt).
      const removed = drv.runRemove(Object.assign({ reason: '21-03 end-to-end command+skill-reclaim proof' }, opts));
      assert.ok(
        removed.reclaimed && removed.reclaimed.removed === EXPECTED_COMMANDS.length,
        'runRemove must reclaim EXACTLY the 5 delivered slash-command links'
      );
      assert.ok(
        removed.reclaimedSkills && removed.reclaimedSkills.removed === EXPECTED_SKILL_STEMS.length,
        'runRemove must reclaim EXACTLY the 2 delivered skill links'
      );
      for (const base of EXPECTED_COMMANDS) {
        assert.ok(!fs.existsSync(path.join(sb.commandsDir, base + '.md')), base + '.md must be reclaimed by runRemove');
      }
      for (const stem of EXPECTED_SKILL_STEMS) {
        assert.ok(!fs.existsSync(path.join(sb.skillsDir, stem)), stem + ' skill link must be reclaimed by runRemove');
      }
    } finally {
      sb.dispose();
    }
  }
);

// ──────────────────────────────── 3. HONESTY (unconditional) ────────────────────────────────
//
// ADR-959 (gsd-core docs/adr/959-capability-command-contribution.md) + CONTEXT.md LOCKED honesty
// correction: the manifest `commands[]` field is a FIRST-PARTY gsd-tools CLI subcommand router array
// ({family, module, router}), a DIFFERENT artifact than the agent-facing slash-commands. Conflating
// them (adding a commands[] array for our slash-commands) would dishonestly make them terminal CLI
// subcommands, not the slash-commands users invoke. The 5 commands stay PROSE-disclosed in
// `description` + shipped in the bundle + delivered by the install engine. This assertion needs no
// live engine, so it runs even when the end-to-end half SKIPs.

test('HONESTY: the bundled manifest has NO commands[] CLI-router array (ADR-959) and prose-discloses the 5 commands', () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  assert.ok(
    !Object.prototype.hasOwnProperty.call(manifest, 'commands'),
    'the bundled manifest MUST NOT have a commands[] CLI-router array — ADR-959: agent-facing ' +
      'slash-commands MUST NOT be conflated with first-party gsd-tools CLI subcommand routers ' +
      '({family, module, router}); our 5 commands stay prose-disclosed + shipped + install-delivered ' +
      '(adding commands[] would make them terminal CLI subcommands, not the slash-commands users invoke)'
  );
  for (const base of EXPECTED_COMMANDS) {
    assert.ok(
      typeof manifest.description === 'string' && manifest.description.includes(base),
      'the manifest description must PROSE-disclose the slash-command "' + base + '" (ADR-959: ' +
        'prose-disclosed, never a commands[] CLI array)'
    );
  }
});

test('HONESTY: node bin/build-capability.cjs --check exits 0 (the bundle is self-contained incl. commands)', () => {
  const r = spawnSync(process.execPath, [path.join('bin', 'build-capability.cjs'), '--check'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  assert.strictEqual(
    r.status,
    0,
    'build --check must exit 0 — the bundle (hooks + skills + commands) must be in sync with its sources ' +
      '(a drift would mean the delivered commands are NOT the canonical ones).\nstdout:\n' +
      (r.stdout || '') + '\nstderr:\n' + (r.stderr || '')
  );
});
