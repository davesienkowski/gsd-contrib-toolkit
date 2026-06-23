'use strict';

/**
 * bin/verify-capability.test.cjs — HERMETIC test of the SHARE-02 conformance check.
 *
 * Drives runVerifyCapability(opts) with INJECTED seams (requireLiveScript, manifestPath, liveRoot,
 * skillsDir, commandsDir) — NEVER the real gsd-core — so the verdict math is proven offline and
 * deterministically. Fixture files live in an os.mkdtemp dir; assertions are on the returned
 * {ok, results} shape, never on process exit (mirrors bin/verify-hooks.test.cjs).
 *
 * It proves:
 *   (a) conform path: a fake-but-conformant manifest + a stub validator module whose four exported
 *       functions all return [] + a matching shipped surface => ok:true, every check passes.
 *   (b) LOUD-on-miss: a stub requireLiveScript that THROWS ScriptResolveError => ok:false (HARD-02
 *       validator-unavailable), never ok:true.
 *   (c) LOUD-on-miss: liveRoot:null (no checkout) => ok:false (cannot-locate-checkout).
 *   (d) a stub module whose validateCapability is NOT a function (renamed/missing) => ok:false.
 *   (e) a stub validateCapability returning a NONEMPTY error array => ok:false (nonconformant).
 *   (f) a manifest declaring FEWER skills than the injected skillsDir lists => ok:false (under-disclosure).
 *   (g) a description with a capability-self "unbypassable" claim => ok:false (honesty).
 *
 * `bin/self-test.cjs` already runs `node --test` over the repo, which AUTO-DISCOVERS this file — no
 * new wiring is added.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runVerifyCapability } = require('./verify-capability.cjs');
const { ScriptResolveError } = require('../hooks/lib/resolve.cjs');

// ── Fixture helpers ──────────────────────────────────────────────────────────

// A minimal but well-formed manifest. The STUB validators don't inspect its fields (they return
// the injected verdict); the manifest's skills/description ARE inspected by the disclosure + honesty
// checks, so those fields are meaningful.
function baseManifest(over = {}) {
  return Object.assign(
    {
      id: 'contribution-toolkit',
      role: 'feature',
      version: '1.0.0',
      title: 'Fake',
      // NOTE: the honesty regex is anchored to a SINGLE sentence ([^.]* stops at a period). The
      // honest disclaimer keeps the capability-self claim and the personal-hooks claim in SEPARATE
      // sentences — exactly as the real 09-01 manifest does — so the anchored regex does not trip.
      description:
        'Ships skills and the gsd-fake-one and gsd-fake-two commands. This capability is advisory-only ' +
        'and does NOT reach the harness boundary. The SEPARATE personal Claude Code PreToolUse hooks ' +
        'remain the harness-wide enforcement layer and are unbypassable; that property belongs to those ' +
        'hooks, not to this capability.',
      skills: ['skill-a', 'skill-b'],
    },
    over
  );
}

// A stub validators module: each of the four exports returns the configured array (default []).
function stubValidators(over = {}) {
  const ok = () => [];
  return Object.assign(
    {
      validateCapability: ok,
      validateVersionEnvelope: ok,
      validateRuntimeCompat: ok,
      validateAgainstContract: ok,
    },
    over
  );
}

/**
 * Build a tmp fixture: a manifest.json + a skills/ tree (one folder w/ SKILL.md per skill name) +
 * commands/gsd-*.md files. Returns the seam paths to drive runVerifyCapability.
 *
 * @param {object} manifest the manifest object to JSON-write.
 * @param {string[]} shippedSkills skill folder names to materialize (each gets a SKILL.md).
 * @param {string[]} shippedCommands command names to materialize as gsd-*.md (e.g. 'gsd-fake-one').
 * @returns {{dir, manifestPath, skillsDir, commandsDir}}
 */
function makeFixture(manifest, shippedSkills, shippedCommands) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-verify-cap-'));
  const manifestPath = path.join(dir, 'capability.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  const skillsDir = path.join(dir, 'skills');
  fs.mkdirSync(skillsDir, { recursive: true });
  for (const s of shippedSkills) {
    fs.mkdirSync(path.join(skillsDir, s), { recursive: true });
    fs.writeFileSync(path.join(skillsDir, s, 'SKILL.md'), '# ' + s + '\n');
  }

  const commandsDir = path.join(dir, 'commands');
  fs.mkdirSync(commandsDir, { recursive: true });
  for (const c of shippedCommands) {
    fs.writeFileSync(path.join(commandsDir, c + '.md'), '# ' + c + '\n');
  }

  // 18-01 (CAP-11): the canonical surface check is BUNDLE-sourced, so the fixture also materializes a
  // sandbox BUNDLE skills/ + commands/ tree (mirroring the shipped sets) that the tests inject as
  // bundleSkillsDir / bundleCommandsDir. (The skillsDir/commandsDir repo seams remain for back-compat
  // callers; they no longer drive a surface verdict.)
  const bundleSkillsDir = path.join(dir, 'bundle', 'skills');
  fs.mkdirSync(bundleSkillsDir, { recursive: true });
  for (const s of shippedSkills) {
    fs.mkdirSync(path.join(bundleSkillsDir, s), { recursive: true });
    fs.writeFileSync(path.join(bundleSkillsDir, s, 'SKILL.md'), '# ' + s + '\n');
  }
  const bundleCommandsDir = path.join(dir, 'bundle', 'commands');
  fs.mkdirSync(bundleCommandsDir, { recursive: true });
  for (const c of shippedCommands) {
    fs.writeFileSync(path.join(bundleCommandsDir, c + '.md'), '# ' + c + '\n');
  }

  return { dir, manifestPath, skillsDir, commandsDir, bundleSkillsDir, bundleCommandsDir };
}

function cleanup(fx) {
  fs.rmSync(fx.dir, { recursive: true, force: true });
}

const SKILLS = ['skill-a', 'skill-b'];
const COMMANDS = ['gsd-fake-one', 'gsd-fake-two'];

// ── (a) conform path => ok:true ───────────────────────────────────────────────
test('conform path: stub validators all return [] + matching surface => ok:true, every check passes', () => {
  const fx = makeFixture(baseManifest(), SKILLS, COMMANDS);
  // WR-03: inject bundleHooksDir + checkBundleFresh so this case is FULLY hermetic — without these
  // seams the bundle-parity + runtime-live-resolution checks fell back to the REAL on-disk bundle
  // (and the real checkBundleFresh), making the test fail when the bundle had not been regenerated.
  // baseManifest() declares no hooks[], so a bundle shipping only the bundled resolver conforms.
  const bundle = conformantBundle([]);
  const live = makeLiveRoot();
  try {
    const r = runVerifyCapability({
      liveRoot: live,
      requireLiveScript: () => stubValidators(),
      manifestPath: fx.manifestPath,
      skillsDir: fx.skillsDir,
      commandsDir: fx.commandsDir,
      bundleSkillsDir: fx.bundleSkillsDir,
      bundleCommandsDir: fx.bundleCommandsDir,
      bundleHooksDir: bundle.bundleHooksDir,
      checkBundleFresh: () => ({ fresh: true, staleFiles: [], checked: 0 }),
    });
    assert.equal(r.ok, true, JSON.stringify(r.results, null, 2));
    assert.equal(r.results.every((x) => x.verdict === 'pass'), true, 'every check passes');
  } finally {
    cleanup(fx);
    fs.rmSync(bundle.dir, { recursive: true, force: true });
    fs.rmSync(live, { recursive: true, force: true });
  }
});

// ── (b) ScriptResolveError from requireLiveScript => ok:false (LOUD HARD-02) ───
test('LOUD-on-miss: requireLiveScript throws ScriptResolveError => ok:false (validator-unavailable)', () => {
  const fx = makeFixture(baseManifest(), SKILLS, COMMANDS);
  try {
    const r = runVerifyCapability({
      liveRoot: '/fake/gsd-core',
      requireLiveScript: () => {
        throw new ScriptResolveError('live script not found', { root: '/fake/gsd-core', attemptedPath: '/fake/x.cjs' });
      },
      manifestPath: fx.manifestPath,
      skillsDir: fx.skillsDir,
      commandsDir: fx.commandsDir,
    });
    assert.equal(r.ok, false, 'a ScriptResolveError must FAIL LOUD, never ok:true');
    const load = r.results.find((x) => x.name === 'live-validators-load');
    assert.ok(load && load.verdict === 'fail', 'the load check failed');
    assert.match(load.detail, /HARD-02/, 'the failure cites HARD-02 (no vendored fallback)');
  } finally {
    cleanup(fx);
  }
});

// ── (c) liveRoot:null => ok:false (cannot-locate-checkout) ────────────────────
test('LOUD-on-miss: liveRoot:null => ok:false (cannot locate gsd-core checkout)', () => {
  const r = runVerifyCapability({
    liveRoot: null,
    requireLiveScript: () => {
      throw new Error('requireLiveScript must NOT be called when there is no checkout');
    },
  });
  assert.equal(r.ok, false, 'no checkout is NEVER a silent conformant');
  const live = r.results.find((x) => x.name === 'live-checkout');
  assert.ok(live && live.verdict === 'fail');
  assert.match(live.detail, /GSD_CORE_ROOT/, 'tells the operator how to point at a checkout');
});

// ── (d) a missing/not-a-function validator export => ok:false ─────────────────
test('LOUD-on-miss: validateCapability not a function (renamed/missing) => ok:false', () => {
  const fx = makeFixture(baseManifest(), SKILLS, COMMANDS);
  try {
    const r = runVerifyCapability({
      liveRoot: '/fake/gsd-core',
      requireLiveScript: () => stubValidators({ validateCapability: undefined }),
      manifestPath: fx.manifestPath,
      skillsDir: fx.skillsDir,
      commandsDir: fx.commandsDir,
    });
    assert.equal(r.ok, false, 'a missing export must FAIL LOUD');
    const shape = r.results.find((x) => x.name === 'live-validators-shape');
    assert.ok(shape && shape.verdict === 'fail');
    assert.match(shape.detail, /validateCapability/, 'names the missing validator');
  } finally {
    cleanup(fx);
  }
});

// ── (e) a nonconformant manifest (validator returns errors) => ok:false ───────
test('a stub validateCapability returning a nonempty error array => ok:false (nonconformant)', () => {
  const fx = makeFixture(baseManifest(), SKILLS, COMMANDS);
  try {
    const r = runVerifyCapability({
      liveRoot: '/fake/gsd-core',
      requireLiveScript: () => stubValidators({ validateCapability: () => ['id must equal folder name'] }),
      manifestPath: fx.manifestPath,
      skillsDir: fx.skillsDir,
      commandsDir: fx.commandsDir,
    });
    assert.equal(r.ok, false, 'a nonempty LIVE error array fails the check');
    const vc = r.results.find((x) => x.name === 'validateCapability');
    assert.ok(vc && vc.verdict === 'fail');
    assert.match(vc.detail, /id must equal folder name/, 'surfaces the LIVE validator error verbatim');
  } finally {
    cleanup(fx);
  }
});

// ── (f) under-disclosure: declared skills are a strict subset of BUNDLE-shipped => ok:false ──
test('under-disclosure: manifest declares fewer skills than the bundle ships => ok:false', () => {
  // 18-01 (CAP-11): SHIPPED resolves from the BUNDLE. Manifest declares only skill-a, but the bundle
  // skills/ ships skill-a AND skill-b (shipped-not-declared) => FAIL.
  const fx = makeFixture(baseManifest({ skills: ['skill-a'] }), SKILLS, COMMANDS);
  try {
    const r = runVerifyCapability({
      liveRoot: '/fake/gsd-core',
      requireLiveScript: () => stubValidators(),
      manifestPath: fx.manifestPath,
      bundleSkillsDir: fx.bundleSkillsDir,
      bundleCommandsDir: fx.bundleCommandsDir,
    });
    assert.equal(r.ok, false, 'under-disclosure must fail (defeats the consent gate otherwise)');
    const surf = r.results.find((x) => x.name === 'surface-skills');
    assert.ok(surf && surf.verdict === 'fail');
    assert.match(surf.detail, /skill-b/, 'names the undisclosed shipped skill');
  } finally {
    cleanup(fx);
  }
});

// ── (f2) under-disclosure: a BUNDLE-shipped command not named in the description => ok:false ──
test('under-disclosure: a bundle-shipped command not named in the description => ok:false', () => {
  // The base description names gsd-fake-one + gsd-fake-two; the bundle ships a third, undisclosed command.
  const fx = makeFixture(baseManifest(), SKILLS, ['gsd-fake-one', 'gsd-fake-two', 'gsd-undisclosed']);
  try {
    const r = runVerifyCapability({
      liveRoot: '/fake/gsd-core',
      requireLiveScript: () => stubValidators(),
      manifestPath: fx.manifestPath,
      bundleSkillsDir: fx.bundleSkillsDir,
      bundleCommandsDir: fx.bundleCommandsDir,
    });
    assert.equal(r.ok, false, 'an undisclosed command fails the surface check');
    const surf = r.results.find((x) => x.name === 'surface-commands');
    assert.ok(surf && surf.verdict === 'fail');
    assert.match(surf.detail, /gsd-undisclosed/, 'names the undisclosed command');
  } finally {
    cleanup(fx);
  }
});

// ── (g) honesty: a capability-self "unbypassable" claim => ok:false ───────────
test('honesty: a description binding THIS capability to unbypassable => ok:false (oversell)', () => {
  const oversold = baseManifest({
    description:
      'Ships the gsd-fake-one and gsd-fake-two commands. This capability is unbypassable and fires at ' +
      'PreToolUse on every tool call.',
  });
  const fx = makeFixture(oversold, SKILLS, COMMANDS);
  try {
    const r = runVerifyCapability({
      liveRoot: '/fake/gsd-core',
      requireLiveScript: () => stubValidators(),
      manifestPath: fx.manifestPath,
      skillsDir: fx.skillsDir,
      commandsDir: fx.commandsDir,
    });
    assert.equal(r.ok, false, 'an oversold capability-self claim fails the honesty check');
    const h = r.results.find((x) => x.name === 'honesty');
    assert.ok(h && h.verdict === 'fail');
    assert.match(h.detail, /T-09-02-OVERSELL/, 'cites the anti-oversell threat');
  } finally {
    cleanup(fx);
  }
});

// ── (g2) honesty no-regression: the HONEST disclaimer (PreToolUse only about the personal hooks) passes ──
test('honesty no-regression: the honest disclaimer (PreToolUse only re the personal hooks) passes', () => {
  // baseManifest()'s description mentions "unbypassable"/"PreToolUse" ONLY about the SEPARATE personal
  // hooks — the anchored regex must NOT trip on it.
  const fx = makeFixture(baseManifest(), SKILLS, COMMANDS);
  try {
    const r = runVerifyCapability({
      liveRoot: '/fake/gsd-core',
      requireLiveScript: () => stubValidators(),
      manifestPath: fx.manifestPath,
      skillsDir: fx.skillsDir,
      commandsDir: fx.commandsDir,
    });
    const h = r.results.find((x) => x.name === 'honesty');
    assert.ok(h && h.verdict === 'pass', 'the honest disclaimer is not a false oversell');
  } finally {
    cleanup(fx);
  }
});

// ── (h) CR-01: an unreadable/missing BUNDLE skills dir FAILs surface-skills (LOUD), even with skills:[] ──
test('CR-01: a missing bundle skills dir => surface-skills FAIL / ok:false, even when manifest.skills is empty', () => {
  // 18-01 (CAP-11): LOUD-on-miss now applies to the BUNDLE surface dir. Point bundleSkillsDir at a path
  // that does NOT exist. With manifest.skills:[] a naive check would compare [] vs [] and forge a green;
  // readBundleSkills must surface this as a COULD-NOT-RUN [FAIL].
  const fx = makeFixture(baseManifest({ skills: [] }), SKILLS, COMMANDS);
  const missingBundleSkillsDir = path.join(fx.dir, 'no-such-bundle-skills-dir');
  try {
    const r = runVerifyCapability({
      liveRoot: '/fake/gsd-core',
      requireLiveScript: () => stubValidators(),
      manifestPath: fx.manifestPath,
      bundleSkillsDir: missingBundleSkillsDir,
      bundleCommandsDir: fx.bundleCommandsDir,
    });
    assert.equal(r.ok, false, 'an unreadable bundle skills dir is NEVER a silent conformant (LOUD-on-miss)');
    const surf = r.results.find((x) => x.name === 'surface-skills');
    assert.ok(surf && surf.verdict === 'fail', 'surface-skills FAILed because the bundle dir could not be read');
    assert.match(surf.detail, /could not run|COULD NOT RUN/i, 'detail explains the check could not run');
  } finally {
    cleanup(fx);
  }
});

// ── (h2) CR-01 symmetry: an unreadable/missing BUNDLE commands dir FAILs surface-commands (LOUD) ──
test('CR-01: a missing bundle commands dir => surface-commands FAIL / ok:false (LOUD-on-miss)', () => {
  const fx = makeFixture(baseManifest(), SKILLS, COMMANDS);
  const missingBundleCommandsDir = path.join(fx.dir, 'no-such-bundle-commands-dir');
  try {
    const r = runVerifyCapability({
      liveRoot: '/fake/gsd-core',
      requireLiveScript: () => stubValidators(),
      manifestPath: fx.manifestPath,
      bundleSkillsDir: fx.bundleSkillsDir,
      bundleCommandsDir: missingBundleCommandsDir,
    });
    assert.equal(r.ok, false, 'an unreadable bundle commands dir is NEVER a silent conformant');
    const surf = r.results.find((x) => x.name === 'surface-commands');
    assert.ok(surf && surf.verdict === 'fail', 'surface-commands FAILed because the bundle dir could not be read');
    assert.match(surf.detail, /could not run|COULD NOT RUN/i, 'detail explains the check could not run');
  } finally {
    cleanup(fx);
  }
});

// ── (h3) CR-01 no-regression: a readable-but-empty BUNDLE skills dir + manifest.skills:[] still PASSes ──
test('CR-01 no-regression: a readable EMPTY bundle skills dir with manifest.skills:[] => surface-skills PASS', () => {
  // "read succeeded, zero skills found" is a legitimate PASS (declared:[] == shipped:[]). Only an
  // unreadable dir is a FAIL — distinguish the two.
  const fx = makeFixture(baseManifest({ skills: [] }), [], COMMANDS); // bundle skills dir exists, ships none
  try {
    const r = runVerifyCapability({
      liveRoot: '/fake/gsd-core',
      requireLiveScript: () => stubValidators(),
      manifestPath: fx.manifestPath,
      bundleSkillsDir: fx.bundleSkillsDir,
      bundleCommandsDir: fx.bundleCommandsDir,
    });
    const surf = r.results.find((x) => x.name === 'surface-skills');
    assert.ok(surf && surf.verdict === 'pass', 'an empty-but-readable bundle skills dir matching skills:[] PASSes');
  } finally {
    cleanup(fx);
  }
});

// ── (i) WR-01: an honest in-sentence disclaimer PASSes; a genuine oversell FAILs ──
test('WR-01: honest in-sentence disclaimer ("adds no PreToolUse hooks") => honesty PASS', () => {
  // The OLD regex tripped on mere co-presence; the negation-aware check must release this.
  const honest = baseManifest({
    description:
      'Ships the gsd-fake-one and gsd-fake-two commands. This capability adds no PreToolUse hooks and ' +
      'explicitly avoids unbypassable enforcement; it is advisory-only.',
  });
  const fx = makeFixture(honest, SKILLS, COMMANDS);
  try {
    const r = runVerifyCapability({
      liveRoot: '/fake/gsd-core',
      requireLiveScript: () => stubValidators(),
      manifestPath: fx.manifestPath,
      skillsDir: fx.skillsDir,
      commandsDir: fx.commandsDir,
    });
    const h = r.results.find((x) => x.name === 'honesty');
    assert.ok(h && h.verdict === 'pass', 'an honest in-sentence disclaimer is not a false oversell');
  } finally {
    cleanup(fx);
  }
});

test('WR-01: a genuine in-sentence oversell ("this capability is unbypassable") => honesty FAIL', () => {
  const oversold = baseManifest({
    description:
      'Ships the gsd-fake-one and gsd-fake-two commands. This capability is unbypassable and enforces at ' +
      'the PreToolUse boundary on every tool call.',
  });
  const fx = makeFixture(oversold, SKILLS, COMMANDS);
  try {
    const r = runVerifyCapability({
      liveRoot: '/fake/gsd-core',
      requireLiveScript: () => stubValidators(),
      manifestPath: fx.manifestPath,
      skillsDir: fx.skillsDir,
      commandsDir: fx.commandsDir,
    });
    assert.equal(r.ok, false, 'a genuine oversell still FAILs');
    const h = r.results.find((x) => x.name === 'honesty');
    assert.ok(h && h.verdict === 'fail', 'the positively-asserted unbypassable claim is caught');
  } finally {
    cleanup(fx);
  }
});

// ── (i2) WR-01 unit: isOversold negation-awareness across honest/oversell phrasings ──
test('WR-01 unit: isOversold releases honest negations and catches positive assertions', () => {
  const { isOversold } = require('./verify-capability.cjs');
  // Honest negating disclaimers — must NOT be flagged.
  assert.equal(isOversold('This capability adds no PreToolUse hooks.'), false);
  assert.equal(isOversold('This capability does not install any PreToolUse hooks.'), false);
  assert.equal(isOversold('This capability explicitly avoids unbypassable enforcement.'), false);
  assert.equal(isOversold('This capability is not unbypassable.'), false);
  // Genuine oversells — must be flagged.
  assert.equal(isOversold('This capability is unbypassable.'), true);
  assert.equal(isOversold('This capability enforces at the PreToolUse boundary.'), true);
  assert.equal(isOversold('This capability reaches PreToolUse.'), true);
  // WR-04: gerund form "reaching" must also be caught as an oversell.
  assert.equal(isOversold('This capability cannot avoid reaching PreToolUse.'), true,
    '"cannot avoid reaching PreToolUse" is a genuine oversell — gerund form must be caught');
});

// ── (i3) WR-02: a negator on an UNRELATED predicate must NOT release a genuine oversell ──
test('WR-02: a negator negating an unrelated predicate does not evade the oversell check', () => {
  const { isOversold } = require('./verify-capability.cjs');
  // The OLD blanket negator pattern matched "not" anywhere between subject and claim, so a "not"
  // attached to an UNRELATED predicate ("advisory" / "help") falsely RELEASED a real oversell. The
  // tightened negator must only release when it actually negates the enforcement predicate.
  assert.equal(isOversold('This capability is not advisory, and is unbypassable.'), true);
  assert.equal(isOversold('This capability does not help you, but it is unbypassable.'), true);
});

// ── (i4) WR-04: gerund form "reaching" is caught by the oversell check ──
test('WR-04: gerund form "reaching" is caught by the oversell check', () => {
  const { isOversold } = require('./verify-capability.cjs');
  // The OLD oversell pattern used reaches? (matching reach/reaches) but missed the gerund form.
  // "This capability cannot avoid reaching PreToolUse" is semantically an oversell (it DOES reach
  // PreToolUse — "cannot avoid X" = does X). The updated OVERSELL_RE includes "reaching" so this
  // is caught. Note: "cannot avoid reaching" fires the oversell pattern; "avoid" + "reaching" do NOT
  // match as a negation pair in NEGATOR_RE (negators require a conjugated verb form like reach/reaches,
  // not the gerund), so the oversell is correctly preserved.
  assert.equal(isOversold('This capability cannot avoid reaching PreToolUse.'), true,
    '"cannot avoid reaching PreToolUse" is a genuine oversell');
  assert.equal(isOversold('This capability is currently reaching the PreToolUse boundary.'), true,
    '"reaching the PreToolUse boundary" is a genuine oversell');
  // Confirm the pre-existing non-gerund forms still work correctly.
  assert.equal(isOversold('This capability reaches PreToolUse.'), true, 'reaches still caught');
  assert.equal(isOversold('This capability does not reach PreToolUse.'), false, 'negated reach still released');
  // Honest phrasing using gerund context (avoids explicitly named): not caught.
  assert.equal(isOversold('This capability explicitly avoids unbypassable enforcement.'), false,
    '"avoids unbypassable enforcement" is an honest disclaimer');
});

// ── (i5) WR-01 denylist: readDescribedCommandSet NON_COMMAND_NOUNS denylist unit test ──
test('WR-01 denylist unit: readDescribedCommandSet does not extract gsd-core/gsd-loop as declared commands', () => {
  const { readDescribedCommandSet } = require('./verify-capability.cjs');
  // NON_COMMAND_NOUNS: gsd-core and gsd-loop must NEVER be extracted as declared toolkit commands,
  // even when they appear immediately before the word "command(s)" in natural prose.
  assert.deepEqual(readDescribedCommandSet('These gsd-core commands are reused by the toolkit.'), [],
    '"gsd-core commands" must not extract gsd-core as a declared command');
  assert.deepEqual(readDescribedCommandSet('Extends gsd-core commands with contribution-specific logic.'), [],
    '"Extends gsd-core commands" must not extract gsd-core');
  assert.deepEqual(readDescribedCommandSet('gsd-loop command is not blocked.'), [],
    '"gsd-loop command" must not extract gsd-loop as a declared command');
  assert.deepEqual(readDescribedCommandSet('Wraps gsd-core commands and the gsd-loop command pipeline.'), [],
    'both gsd-core and gsd-loop prose must be filtered');
  // A REAL phantom command (gsd-phantom) must still be caught — denylist must not weaken detection.
  assert.deepEqual(readDescribedCommandSet('Ships gsd-fake-one and gsd-fake-two commands. Also gsd-phantom command.'),
    ['gsd-fake-one', 'gsd-fake-two', 'gsd-phantom'],
    'real phantom commands are still extracted');
  // Pattern (a) (parenthetical enumeration) must also filter NON_COMMAND_NOUNS.
  assert.deepEqual(readDescribedCommandSet('commands (gsd-core, gsd-fake-one)'), ['gsd-fake-one'],
    'NON_COMMAND_NOUNS are filtered from parenthetical enumerations too');
});

// ── (i6) WR-01 denylist integration: prose mentioning "gsd-core commands" does NOT false-FAIL ──
test('WR-01 denylist integration: description with "gsd-core commands" prose does not false-FAIL surface-commands', () => {
  // The manifest description contains "gsd-core commands" — a natural phrase that pattern (b) would
  // previously extract as a declared command (gsd-core), causing a false declared-not-shipped FAIL
  // since gsd-core.md doesn't exist in the bundle's commands/ dir. The NON_COMMAND_NOUNS denylist
  // must suppress this false FAIL while still catching a real phantom (gsd-phantom).
  const descWithCoreProse = baseManifest({
    description:
      'Extends gsd-core commands with contribution-specific gates. Ships the gsd-fake-one and ' +
      'gsd-fake-two commands. This capability is advisory-only and does NOT reach the harness boundary. ' +
      'The SEPARATE personal Claude Code PreToolUse hooks remain the harness-wide enforcement layer ' +
      'and are unbypassable; that property belongs to those hooks, not to this capability.',
  });
  const fx = makeFixture(descWithCoreProse, SKILLS, COMMANDS);
  try {
    const r = runVerifyCapability({
      liveRoot: '/fake/gsd-core',
      requireLiveScript: () => stubValidators(),
      manifestPath: fx.manifestPath,
      bundleSkillsDir: fx.bundleSkillsDir,
      bundleCommandsDir: fx.bundleCommandsDir,
      checkBundleFresh: () => ({ fresh: true, staleFiles: [], checked: 0 }),
    });
    const surf = r.results.find((x) => x.name === 'surface-commands');
    assert.ok(surf && surf.verdict === 'pass',
      '"gsd-core commands" in prose must NOT produce a false-FAIL surface-commands: ' + (surf && surf.detail));
  } finally {
    cleanup(fx);
  }
});

test('WR-01 denylist integration: description with "gsd-core commands" prose AND a real phantom gsd-phantom still FAILs', () => {
  // The denylist filters gsd-core/gsd-loop but must NOT weaken detection of a genuinely phantom command.
  const descWithPhantom = baseManifest({
    description:
      'Extends gsd-core commands. Ships the gsd-fake-one, gsd-fake-two, and gsd-phantom commands. ' +
      'This capability is advisory-only and does NOT reach the harness boundary.',
  });
  // The bundle ships only gsd-fake-one + gsd-fake-two; gsd-phantom is declared but not shipped.
  const fx = makeFixture(descWithPhantom, SKILLS, COMMANDS);
  try {
    const r = runVerifyCapability({
      liveRoot: '/fake/gsd-core',
      requireLiveScript: () => stubValidators(),
      manifestPath: fx.manifestPath,
      bundleSkillsDir: fx.bundleSkillsDir,
      bundleCommandsDir: fx.bundleCommandsDir,
      checkBundleFresh: () => ({ fresh: true, staleFiles: [], checked: 0 }),
    });
    assert.equal(r.ok, false, 'a real phantom command must still cause a FAIL');
    const surf = r.results.find((x) => x.name === 'surface-commands');
    assert.ok(surf && surf.verdict === 'fail', 'surface-commands FAILed for the phantom');
    assert.match(surf.detail, /gsd-phantom/, 'names the phantom command — not gsd-core');
    assert.doesNotMatch(surf.detail, /gsd-core/, 'gsd-core must NOT appear as a false declared phantom');
  } finally {
    cleanup(fx);
  }
});

// ── (j) WR-02: a LIVE validator that THROWS yields a clean [FAIL] + ok:false (no uncaught exception) ──
test('WR-02: a throwing LIVE validator => clean [FAIL] for that validator, ok:false, no uncaught throw', () => {
  const fx = makeFixture(baseManifest(), SKILLS, COMMANDS);
  try {
    // runVerifyCapability must NOT propagate the throw — it returns {ok:false} with a [FAIL] line.
    const r = runVerifyCapability({
      liveRoot: '/fake/gsd-core',
      requireLiveScript: () =>
        stubValidators({
          validateRuntimeCompat: () => {
            throw new Error('boom: validator API drift');
          },
        }),
      manifestPath: fx.manifestPath,
      skillsDir: fx.skillsDir,
      commandsDir: fx.commandsDir,
    });
    assert.equal(r.ok, false, 'a thrown validator FAILs LOUD, never ok:true');
    const vc = r.results.find((x) => x.name === 'validateRuntimeCompat');
    assert.ok(vc && vc.verdict === 'fail', 'the throwing validator produced a [FAIL] line');
    assert.match(vc.detail, /THREW|boom: validator API drift/, 'the failure names the throw');
  } finally {
    cleanup(fx);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Plan 11-03: hooks[] file presence, bundle⇄source parity, runtime LIVE-resolution
// ─────────────────────────────────────────────────────────────────────────────

// A manifest carrying a hooks[] (the bundle-conformance subject). Each entry is {event, script};
// the script is a safe relative path under hooks/ (schema-safety is asserted by the LIVE
// validateCapability check — these cases drive the NEW toolkit-owned disk/parity/runtime checks).
function manifestWithHooks(scripts) {
  return baseManifest({
    hooks: scripts.map((s) => ({ event: 'PreToolUse', script: s })),
  });
}

/**
 * Build a tmp bundle hooks/ tree: one file per relative path (POSIX). Materializes parent dirs.
 * Returns the absolute bundle hooks/ dir to inject as `bundleHooksDir`.
 *
 * @param {object} files map of relPath => fileBytes (string). e.g. {'hooks/gh-edit.cjs':'...', 'lib/resolve.cjs':'...'}
 * @returns {{dir:string, bundleHooksDir:string}}
 */
function makeBundle(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-verify-bundle-'));
  const bundleHooksDir = path.join(dir, 'hooks');
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(bundleHooksDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  return { dir, bundleHooksDir };
}

// A liveRoot fixture with the gsd-core sentinel layout (scripts/ + gsd-core/bin/lib/) so the
// runtime-live-resolution check can confirm reachability WITHOUT touching the real gsd-core.
function makeLiveRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-verify-live-'));
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'gsd-core', 'bin', 'lib'), { recursive: true });
  return dir;
}

// A bundle that ships every hooks[].script file declared in the manifest PLUS lib/resolve.cjs
// (the bundled resolver the runtime check asserts). The default conformant bundle.
function conformantBundle(scripts) {
  const files = {};
  for (const s of scripts) files[s.replace(/^hooks\//, '')] = '// ' + s + '\n';
  files['lib/resolve.cjs'] = "module.exports = require('../../../hooks/lib/resolve.cjs');\n";
  return makeBundle(files);
}

const HOOK_SCRIPTS = ['hooks/gh-edit.cjs', 'hooks/gh-pr-create.cjs'];

// ── (k) conform: hooks files present + fresh bundle + reachable live + bundled resolver => all PASS ──
// 18-01 (CAP-11): the hooks file-presence check is now the bidirectional `surface-hooks` membership leg.
test('11-03 conform: hooks present, fresh bundle, reachable liveRoot, bundled resolver => 3 new checks PASS', () => {
  const fx = makeFixture(manifestWithHooks(HOOK_SCRIPTS), SKILLS, COMMANDS);
  const bundle = conformantBundle(HOOK_SCRIPTS);
  const live = makeLiveRoot();
  try {
    const r = runVerifyCapability({
      liveRoot: live,
      requireLiveScript: () => stubValidators(),
      manifestPath: fx.manifestPath,
      bundleSkillsDir: fx.bundleSkillsDir,
      bundleCommandsDir: fx.bundleCommandsDir,
      bundleHooksDir: bundle.bundleHooksDir,
      checkBundleFresh: () => ({ fresh: true, staleFiles: [], checked: 3 }),
    });
    assert.equal(r.ok, true, JSON.stringify(r.results, null, 2));
    const hm = r.results.find((x) => x.name === 'surface-hooks');
    const bp = r.results.find((x) => x.name === 'bundle-parity');
    const rr = r.results.find((x) => x.name === 'runtime-live-resolution');
    assert.ok(hm && hm.verdict === 'pass', 'surface-hooks PASS');
    assert.ok(bp && bp.verdict === 'pass', 'bundle-parity PASS');
    assert.ok(rr && rr.verdict === 'pass', 'runtime-live-resolution PASS');
  } finally {
    cleanup(fx);
    fs.rmSync(bundle.dir, { recursive: true, force: true });
    fs.rmSync(live, { recursive: true, force: true });
  }
});

// ── (l) hooks-file miss: a declared hooks[].script with no bundle file => surface-hooks FAIL, ok:false ──
test('11-03 hooks-file miss: a declared hooks[].script absent from the bundle => surface-hooks FAIL, ok:false', () => {
  const fx = makeFixture(manifestWithHooks(HOOK_SCRIPTS), SKILLS, COMMANDS);
  // Bundle ships only the FIRST script (+ resolver); the second declared script has no file
  // (declared-not-shipped).
  const bundle = conformantBundle([HOOK_SCRIPTS[0]]);
  const live = makeLiveRoot();
  try {
    const r = runVerifyCapability({
      liveRoot: live,
      requireLiveScript: () => stubValidators(),
      manifestPath: fx.manifestPath,
      bundleSkillsDir: fx.bundleSkillsDir,
      bundleCommandsDir: fx.bundleCommandsDir,
      bundleHooksDir: bundle.bundleHooksDir,
      checkBundleFresh: () => ({ fresh: true, staleFiles: [], checked: 2 }),
    });
    assert.equal(r.ok, false, 'a declared script with no bundle file is NEVER a silent conformant');
    const hm = r.results.find((x) => x.name === 'surface-hooks');
    assert.ok(hm && hm.verdict === 'fail', 'surface-hooks FAILed');
    assert.match(hm.detail, /gh-pr-create\.cjs/, 'names the missing script path');
  } finally {
    cleanup(fx);
    fs.rmSync(bundle.dir, { recursive: true, force: true });
    fs.rmSync(live, { recursive: true, force: true });
  }
});

// ── (m) parity miss: an injected stale checkBundleFresh => bundle-parity FAIL, ok:false ──
test('11-03 parity miss: an injected stale checkBundleFresh (staleFiles entry) => bundle-parity FAIL, ok:false', () => {
  const fx = makeFixture(manifestWithHooks(HOOK_SCRIPTS), SKILLS, COMMANDS);
  const bundle = conformantBundle(HOOK_SCRIPTS);
  const live = makeLiveRoot();
  try {
    const r = runVerifyCapability({
      liveRoot: live,
      requireLiveScript: () => stubValidators(),
      manifestPath: fx.manifestPath,
      skillsDir: fx.skillsDir,
      commandsDir: fx.commandsDir,
      bundleHooksDir: bundle.bundleHooksDir,
      checkBundleFresh: () => ({
        fresh: false,
        staleFiles: [{ path: 'gh-edit.cjs', reason: 'differs from canonical source' }],
        checked: 2,
      }),
    });
    assert.equal(r.ok, false, 'a stale bundle is NEVER reported conformant (equivalent to build --check exit 1)');
    const bp = r.results.find((x) => x.name === 'bundle-parity');
    assert.ok(bp && bp.verdict === 'fail', 'bundle-parity FAILed');
    assert.match(bp.detail, /gh-edit\.cjs/, 'names the stale path');
  } finally {
    cleanup(fx);
    fs.rmSync(bundle.dir, { recursive: true, force: true });
    fs.rmSync(live, { recursive: true, force: true });
  }
});

// ── (n) runtime miss: liveRoot reachable but bundled resolve.cjs absent => runtime-live-resolution FAIL ──
test('11-03 runtime miss: an absent bundled resolve.cjs => runtime-live-resolution FAIL, ok:false', () => {
  const fx = makeFixture(manifestWithHooks(HOOK_SCRIPTS), SKILLS, COMMANDS);
  // Bundle ships the scripts but NOT lib/resolve.cjs.
  const files = {};
  for (const s of HOOK_SCRIPTS) files[s.replace(/^hooks\//, '')] = '// ' + s + '\n';
  const bundle = makeBundle(files);
  const live = makeLiveRoot();
  try {
    const r = runVerifyCapability({
      liveRoot: live,
      requireLiveScript: () => stubValidators(),
      manifestPath: fx.manifestPath,
      skillsDir: fx.skillsDir,
      commandsDir: fx.commandsDir,
      bundleHooksDir: bundle.bundleHooksDir,
      checkBundleFresh: () => ({ fresh: true, staleFiles: [], checked: 2 }),
    });
    assert.equal(r.ok, false, 'an absent bundled resolver is NEVER a silent conformant (reuse-LIVE broken)');
    const rr = r.results.find((x) => x.name === 'runtime-live-resolution');
    assert.ok(rr && rr.verdict === 'fail', 'runtime-live-resolution FAILed');
    assert.match(rr.detail, /resolve\.cjs/, 'names the missing bundled resolver');
  } finally {
    cleanup(fx);
    fs.rmSync(bundle.dir, { recursive: true, force: true });
    fs.rmSync(live, { recursive: true, force: true });
  }
});

// ── (n2) runtime miss: bundled resolver present but liveRoot:null => runtime-live-resolution FAIL ──
test('11-03 runtime miss: liveRoot:null (no reachable checkout) => runtime-live-resolution FAIL, ok:false', () => {
  // NOTE: liveRoot:null short-circuits at the live-checkout LOUD-fail before the new checks run, so
  // ok:false is already guaranteed. This case proves the unreachable-checkout intent end to end: with
  // no checkout the bundled gates could not call LIVE scripts, so conformance is NEVER reported.
  const r = runVerifyCapability({
    liveRoot: null,
    requireLiveScript: () => {
      throw new Error('requireLiveScript must NOT be called when there is no checkout');
    },
  });
  assert.equal(r.ok, false, 'no reachable LIVE checkout is NEVER a silent conformant');
  const lc = r.results.find((x) => x.name === 'live-checkout');
  assert.ok(lc && lc.verdict === 'fail', 'the live-checkout LOUD fail fires');
});

// ── (o) hermetic guarantee: the real bundle/manifest are never mutated by these cases ──
test('11-03 hermetic: the real capabilities/contribution-toolkit bundle + manifest are untouched by the suite', () => {
  // A trivial structural assertion that the new cases inject seams (bundleHooksDir / checkBundleFresh)
  // rather than the defaults — proven by the fact every 11-03 case above passes os.mkdtemp paths.
  const src = fs.readFileSync(path.join(__dirname, 'verify-capability.test.cjs'), 'utf8');
  assert.match(src, /bundleHooksDir: bundle\.bundleHooksDir/, 'cases inject a tmp bundleHooksDir');
  assert.match(src, /checkBundleFresh: \(\) =>/, 'cases inject checkBundleFresh');
});

// ─────────────────────────────────────────────────────────────────────────────
// Plan 18-01 (CAP-11): unified BUNDLE-sourced tri-surface declared==shipped check.
// Task 1 RED: the three new bundle surface readers exist and are LOUD-on-miss.
// ─────────────────────────────────────────────────────────────────────────────
test('18-01 unit: readBundleSkills/readBundleCommands/readBundleHooks are exported LOUD-on-miss readers', () => {
  const m = require('./verify-capability.cjs');
  assert.equal(typeof m.readBundleSkills, 'function', 'readBundleSkills exported');
  assert.equal(typeof m.readBundleCommands, 'function', 'readBundleCommands exported');
  assert.equal(typeof m.readBundleHooks, 'function', 'readBundleHooks exported');

  // LOUD-on-miss: an unreadable/missing dir yields {ok:false, error}, never a forged empty-set green.
  const missing = path.join(os.tmpdir(), 'gsd-no-such-bundle-' + Date.now());
  assert.equal(m.readBundleSkills(missing).ok, false, 'missing skills dir => ok:false');
  assert.equal(m.readBundleCommands(missing).ok, false, 'missing commands dir => ok:false');
  assert.equal(m.readBundleHooks(missing).ok, false, 'missing hooks dir => ok:false');

  // Readable dir: returns the sorted shipped set.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-bundle-read-'));
  try {
    fs.mkdirSync(path.join(dir, 'skills', 'beta'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'skills', 'beta', 'SKILL.md'), '# beta\n');
    fs.mkdirSync(path.join(dir, 'skills', 'alpha'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'skills', 'alpha', 'SKILL.md'), '# alpha\n');
    // A subdir WITHOUT SKILL.md is not a skill surface entry.
    fs.mkdirSync(path.join(dir, 'skills', 'not-a-skill'), { recursive: true });
    const sk = m.readBundleSkills(path.join(dir, 'skills'));
    assert.deepEqual(sk, { ok: true, skills: ['alpha', 'beta'] }, 'sorted SKILL.md-bearing subdirs');

    fs.mkdirSync(path.join(dir, 'commands'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'commands', 'gsd-two.md'), '# two\n');
    fs.writeFileSync(path.join(dir, 'commands', 'gsd-one.md'), '# one\n');
    fs.writeFileSync(path.join(dir, 'commands', 'README.md'), '# not a gsd command\n');
    const cm = m.readBundleCommands(path.join(dir, 'commands'));
    assert.deepEqual(cm, { ok: true, commands: ['gsd-one', 'gsd-two'] }, 'sorted gsd-*.md stems');

    fs.mkdirSync(path.join(dir, 'hooks', 'lib'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'hooks', 'b.cjs'), '// b\n');
    fs.writeFileSync(path.join(dir, 'hooks', 'a.cjs'), '// a\n');
    fs.writeFileSync(path.join(dir, 'hooks', 'lib', 'resolve.cjs'), '// resolver, not a hook\n');
    const hk = m.readBundleHooks(path.join(dir, 'hooks'));
    assert.deepEqual(hk, { ok: true, hooks: ['a.cjs', 'b.cjs'] }, 'top-level *.cjs only, excludes lib/');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Plan 18-01 (CAP-11) Task 2: the HERMETIC 6-cell deliberate-mismatch matrix.
//
// For EACH of the 3 surfaces (skills, commands, hooks) x EACH of the 2 directions
// (declare-without-ship, ship-without-declare) we build a COMPLETE tri-surface bundle in an
// os.mkdtemp sandbox, introduce ONE mismatch on the COPY, and assert the verifier returns a FAIL
// (r.ok === false + the offending surface verdict === 'fail', naming the offending entry). Every cell
// operates ONLY on the sandbox via the injected bundleSkillsDir/bundleCommandsDir/bundleHooksDir seams
// and rm's the sandbox in a finally — the real capabilities/contribution-toolkit is NEVER touched
// (T-18-04-MUTATE). A conformant baseline (ok:true) precedes the mismatch cells, and a structural
// hermetic-guarantee assertion proves the cells inject sandbox seams rather than defaults.
// ─────────────────────────────────────────────────────────────────────────────

// The conformant tri-surface declared sets.
const TRI_SKILLS = ['skill-x', 'skill-y'];
const TRI_COMMANDS = ['gsd-alpha', 'gsd-beta'];
const TRI_HOOKS = ['hooks/one.cjs', 'hooks/two.cjs'];

/**
 * Build a COMPLETE conformant tri-surface bundle + matching manifest + makeLiveRoot in an os.mkdtemp
 * sandbox. The returned `seams` plug straight into runVerifyCapability; `mutate(fns)` lets a cell
 * deliberately diverge ONE surface on the COPY before running. Nothing here touches the real bundle.
 *
 * @param {object} [over] manifest overrides (e.g. an extra declared skill/command/hook for a cell).
 * @returns {{dir, live, seams, paths, cleanup}}
 */
function makeTriBundle(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-tri-bundle-'));
  const bundleDir = path.join(dir, 'bundle');
  const bundleSkillsDir = path.join(bundleDir, 'skills');
  const bundleCommandsDir = path.join(bundleDir, 'commands');
  const bundleHooksDir = path.join(bundleDir, 'hooks');

  // skills/<stem>/SKILL.md
  for (const s of TRI_SKILLS) {
    fs.mkdirSync(path.join(bundleSkillsDir, s), { recursive: true });
    fs.writeFileSync(path.join(bundleSkillsDir, s, 'SKILL.md'), '# ' + s + '\n');
  }
  // commands/gsd-*.md
  fs.mkdirSync(bundleCommandsDir, { recursive: true });
  for (const c of TRI_COMMANDS) fs.writeFileSync(path.join(bundleCommandsDir, c + '.md'), '# ' + c + '\n');
  // hooks/*.cjs + hooks/lib/resolve.cjs (the bundled resolver the runtime check asserts)
  fs.mkdirSync(path.join(bundleHooksDir, 'lib'), { recursive: true });
  for (const h of TRI_HOOKS) fs.writeFileSync(path.join(bundleHooksDir, h.replace(/^hooks\//, '')), '// ' + h + '\n');
  fs.writeFileSync(path.join(bundleHooksDir, 'lib', 'resolve.cjs'), "module.exports = require('../../../hooks/lib/resolve.cjs');\n");

  // A matching manifest: declares the same tri-surface sets, and a description that NAMES the commands.
  const manifest = baseManifest(
    Object.assign(
      {
        skills: TRI_SKILLS.slice(),
        hooks: TRI_HOOKS.map((s) => ({ event: 'PreToolUse', script: s })),
        description:
          'Ships skills and the ' + TRI_COMMANDS.join(' and ') + ' commands. This capability is ' +
          'advisory-only and does NOT reach the harness boundary.',
      },
      over
    )
  );
  const manifestPath = path.join(dir, 'capability.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  const live = makeLiveRoot();
  const seams = {
    liveRoot: live,
    requireLiveScript: () => stubValidators(),
    manifestPath,
    bundleSkillsDir,
    bundleCommandsDir,
    bundleHooksDir,
    checkBundleFresh: () => ({ fresh: true, staleFiles: [], checked: TRI_HOOKS.length }),
  };
  const cleanup = () => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(live, { recursive: true, force: true });
  };
  return { dir, live, seams, paths: { bundleSkillsDir, bundleCommandsDir, bundleHooksDir, manifestPath }, cleanup };
}

// ── baseline: a conformant tri-surface sandbox bundle => ok:true (every surface PASS) ──
test('18-01 tri-surface baseline: a conformant sandbox bundle (declared == shipped, all 3 surfaces) => ok:true', () => {
  const fx = makeTriBundle();
  try {
    const r = runVerifyCapability(fx.seams);
    assert.equal(r.ok, true, JSON.stringify(r.results, null, 2));
    for (const name of ['surface-skills', 'surface-commands', 'surface-hooks']) {
      const s = r.results.find((x) => x.name === name);
      assert.ok(s && s.verdict === 'pass', name + ' PASS in the conformant baseline');
    }
  } finally {
    fx.cleanup();
  }
});

// ── cell 1: skills declare-without-ship => surface-skills FAIL ──
test('18-01 tri-surface cell 1 (skills declare-without-ship): manifest declares a skill with no bundle dir => FAIL', () => {
  // Declare an extra skill in the manifest; do NOT create its bundle skills/<stem>/ dir.
  const fx = makeTriBundle({ skills: TRI_SKILLS.concat('skill-phantom') });
  try {
    const r = runVerifyCapability(fx.seams);
    assert.equal(r.ok, false, 'a declared skill with no bundle dir is NEVER a silent conformant');
    const s = r.results.find((x) => x.name === 'surface-skills');
    assert.ok(s && s.verdict === 'fail', 'surface-skills FAILed');
    assert.match(s.detail, /skill-phantom/, 'names the declared-not-shipped skill');
  } finally {
    fx.cleanup();
  }
});

// ── cell 2: skills ship-without-declare => surface-skills FAIL ──
test('18-01 tri-surface cell 2 (skills ship-without-declare): a stray bundle skill not declared => FAIL', () => {
  const fx = makeTriBundle();
  // Write a stray bundle skills/ghost/SKILL.md NOT in manifest.skills[].
  fs.mkdirSync(path.join(fx.paths.bundleSkillsDir, 'ghost'), { recursive: true });
  fs.writeFileSync(path.join(fx.paths.bundleSkillsDir, 'ghost', 'SKILL.md'), '# ghost\n');
  try {
    const r = runVerifyCapability(fx.seams);
    assert.equal(r.ok, false, 'a shipped skill not declared is NEVER a silent conformant');
    const s = r.results.find((x) => x.name === 'surface-skills');
    assert.ok(s && s.verdict === 'fail', 'surface-skills FAILed');
    assert.match(s.detail, /ghost/, 'names the shipped-not-declared skill');
  } finally {
    fx.cleanup();
  }
});

// ── cell 3: commands declare-without-ship => surface-commands FAIL ──
test('18-01 tri-surface cell 3 (commands declare-without-ship): description names a command with no bundle file => FAIL', () => {
  // Name a gsd-phantom command in the description; do NOT create bundle commands/gsd-phantom.md.
  const fx = makeTriBundle({
    description:
      'Ships skills and the ' + TRI_COMMANDS.concat('gsd-phantom').join(' and ') + ' commands. This ' +
      'capability is advisory-only and does NOT reach the harness boundary.',
  });
  try {
    const r = runVerifyCapability(fx.seams);
    assert.equal(r.ok, false, 'a described command with no bundle file is NEVER a silent conformant');
    const s = r.results.find((x) => x.name === 'surface-commands');
    assert.ok(s && s.verdict === 'fail', 'surface-commands FAILed');
    assert.match(s.detail, /gsd-phantom/, 'names the declared-not-shipped command');
  } finally {
    fx.cleanup();
  }
});

// ── cell 4: commands ship-without-declare => surface-commands FAIL ──
test('18-01 tri-surface cell 4 (commands ship-without-declare): a stray bundle command not described => FAIL', () => {
  const fx = makeTriBundle();
  // Write a stray bundle commands/gsd-ghost.md NOT named in the description.
  fs.writeFileSync(path.join(fx.paths.bundleCommandsDir, 'gsd-ghost.md'), '# ghost\n');
  try {
    const r = runVerifyCapability(fx.seams);
    assert.equal(r.ok, false, 'a shipped command not described is NEVER a silent conformant');
    const s = r.results.find((x) => x.name === 'surface-commands');
    assert.ok(s && s.verdict === 'fail', 'surface-commands FAILed');
    assert.match(s.detail, /gsd-ghost/, 'names the shipped-not-declared command');
  } finally {
    fx.cleanup();
  }
});

// ── cell 5: hooks declare-without-ship => surface-hooks FAIL ──
test('18-01 tri-surface cell 5 (hooks declare-without-ship): a hooks[].script with no bundle file => FAIL', () => {
  // Declare an extra hooks[].script (hooks/ghost.cjs); do NOT create bundle hooks/ghost.cjs.
  const fx = makeTriBundle({
    hooks: TRI_HOOKS.concat('hooks/ghost.cjs').map((s) => ({ event: 'PreToolUse', script: s })),
  });
  try {
    const r = runVerifyCapability(fx.seams);
    assert.equal(r.ok, false, 'a declared hook with no bundle file is NEVER a silent conformant');
    const s = r.results.find((x) => x.name === 'surface-hooks');
    assert.ok(s && s.verdict === 'fail', 'surface-hooks FAILed');
    assert.match(s.detail, /ghost\.cjs/, 'names the declared-not-shipped hook');
  } finally {
    fx.cleanup();
  }
});

// ── cell 6: hooks ship-without-declare => surface-hooks FAIL (the NEW reverse direction) ──
test('18-01 tri-surface cell 6 (hooks ship-without-declare): a stray bundle hook not declared => FAIL', () => {
  const fx = makeTriBundle();
  // Write a stray bundle hooks/ghost.cjs NOT declared in hooks[].
  fs.writeFileSync(path.join(fx.paths.bundleHooksDir, 'ghost.cjs'), '// ghost\n');
  try {
    const r = runVerifyCapability(fx.seams);
    assert.equal(r.ok, false, 'a shipped hook not declared is NEVER a silent conformant (the NEW reverse leg)');
    const s = r.results.find((x) => x.name === 'surface-hooks');
    assert.ok(s && s.verdict === 'fail', 'surface-hooks FAILed');
    assert.match(s.detail, /ghost\.cjs/, 'names the shipped-not-declared hook');
  } finally {
    fx.cleanup();
  }
});

// ── hermetic guarantee: the 18-01 cells inject sandbox seams (never the real bundle) ──
test('18-01 tri-surface hermetic: the cells inject os.mkdtemp bundle seams, never the real bundle/manifest', () => {
  const src = fs.readFileSync(path.join(__dirname, 'verify-capability.test.cjs'), 'utf8');
  // Structural proof the matrix is sandbox-sourced: makeTriBundle uses os.mkdtempSync and every cell
  // drives runVerifyCapability(fx.seams) where seams carry sandbox bundleSkills/Commands/Hooks dirs.
  assert.match(src, /function makeTriBundle/, 'the tri-surface fixture builder exists');
  assert.match(src, /mkdtempSync\(path\.join\(os\.tmpdir\(\), 'gsd-tri-bundle-'\)\)/, 'the fixture is an os.mkdtemp sandbox');
  assert.match(src, /runVerifyCapability\(fx\.seams\)/, 'cells drive the verifier via the sandbox seams');
  assert.match(src, /bundleSkillsDir,\n\s*bundleCommandsDir,\n\s*bundleHooksDir,/, 'seams carry all 3 sandbox bundle dirs');
  // And the real bundle path must NOT appear as a hard-coded mutation target anywhere in the matrix.
  assert.doesNotMatch(src, /writeFileSync\([^)]*capabilities[\\/]+contribution-toolkit/, 'no cell writes into the real bundle');
});
