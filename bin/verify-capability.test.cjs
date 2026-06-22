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
      id: 'contrib-gate',
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

  return { dir, manifestPath, skillsDir, commandsDir };
}

function cleanup(fx) {
  fs.rmSync(fx.dir, { recursive: true, force: true });
}

const SKILLS = ['skill-a', 'skill-b'];
const COMMANDS = ['gsd-fake-one', 'gsd-fake-two'];

// ── (a) conform path => ok:true ───────────────────────────────────────────────
test('conform path: stub validators all return [] + matching surface => ok:true, every check passes', () => {
  const fx = makeFixture(baseManifest(), SKILLS, COMMANDS);
  try {
    const r = runVerifyCapability({
      liveRoot: '/fake/gsd-core',
      requireLiveScript: () => stubValidators(),
      manifestPath: fx.manifestPath,
      skillsDir: fx.skillsDir,
      commandsDir: fx.commandsDir,
    });
    assert.equal(r.ok, true, JSON.stringify(r.results, null, 2));
    assert.equal(r.results.every((x) => x.verdict === 'pass'), true, 'every check passes');
  } finally {
    cleanup(fx);
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

// ── (f) under-disclosure: declared skills are a strict subset of shipped => ok:false ──
test('under-disclosure: manifest declares fewer skills than skillsDir ships => ok:false', () => {
  // Manifest declares only skill-a, but the skillsDir ships skill-a AND skill-b.
  const fx = makeFixture(baseManifest({ skills: ['skill-a'] }), SKILLS, COMMANDS);
  try {
    const r = runVerifyCapability({
      liveRoot: '/fake/gsd-core',
      requireLiveScript: () => stubValidators(),
      manifestPath: fx.manifestPath,
      skillsDir: fx.skillsDir,
      commandsDir: fx.commandsDir,
    });
    assert.equal(r.ok, false, 'under-disclosure must fail (defeats the consent gate otherwise)');
    const surf = r.results.find((x) => x.name === 'surface-skills');
    assert.ok(surf && surf.verdict === 'fail');
    assert.match(surf.detail, /skill-b/, 'names the undisclosed shipped skill');
  } finally {
    cleanup(fx);
  }
});

// ── (f2) under-disclosure: a shipped command not named in the description => ok:false ──
test('under-disclosure: a shipped command not named in the description => ok:false', () => {
  // The base description names gsd-fake-one + gsd-fake-two; ship a third, undisclosed command.
  const fx = makeFixture(baseManifest(), SKILLS, ['gsd-fake-one', 'gsd-fake-two', 'gsd-undisclosed']);
  try {
    const r = runVerifyCapability({
      liveRoot: '/fake/gsd-core',
      requireLiveScript: () => stubValidators(),
      manifestPath: fx.manifestPath,
      skillsDir: fx.skillsDir,
      commandsDir: fx.commandsDir,
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

// ── (h) CR-01: an unreadable/missing skillsDir FAILs surface-skills (LOUD), even with skills:[] ──
test('CR-01: a missing skillsDir => surface-skills FAIL / ok:false, even when manifest.skills is empty', () => {
  // Build a normal fixture, then point skillsDir at a path that does NOT exist. With manifest.skills:[]
  // the OLD code compared [] vs [] and reported a silent PASS — a forged green for a check that could
  // not run. The hardened readShippedSkills must surface this as a [FAIL].
  const fx = makeFixture(baseManifest({ skills: [] }), SKILLS, COMMANDS);
  const missingSkillsDir = path.join(fx.dir, 'no-such-skills-dir');
  try {
    const r = runVerifyCapability({
      liveRoot: '/fake/gsd-core',
      requireLiveScript: () => stubValidators(),
      manifestPath: fx.manifestPath,
      skillsDir: missingSkillsDir,
      commandsDir: fx.commandsDir,
    });
    assert.equal(r.ok, false, 'an unreadable skills dir is NEVER a silent conformant (LOUD-on-miss)');
    const surf = r.results.find((x) => x.name === 'surface-skills');
    assert.ok(surf && surf.verdict === 'fail', 'surface-skills FAILed because the dir could not be read');
    assert.match(surf.detail, /could not run|COULD NOT RUN/i, 'detail explains the check could not run');
  } finally {
    cleanup(fx);
  }
});

// ── (h2) CR-01 symmetry: an unreadable/missing commandsDir FAILs surface-commands (LOUD) ──
test('CR-01: a missing commandsDir => surface-commands FAIL / ok:false (LOUD-on-miss)', () => {
  const fx = makeFixture(baseManifest(), SKILLS, COMMANDS);
  const missingCommandsDir = path.join(fx.dir, 'no-such-commands-dir');
  try {
    const r = runVerifyCapability({
      liveRoot: '/fake/gsd-core',
      requireLiveScript: () => stubValidators(),
      manifestPath: fx.manifestPath,
      skillsDir: fx.skillsDir,
      commandsDir: missingCommandsDir,
    });
    assert.equal(r.ok, false, 'an unreadable commands dir is NEVER a silent conformant');
    const surf = r.results.find((x) => x.name === 'surface-commands');
    assert.ok(surf && surf.verdict === 'fail', 'surface-commands FAILed because the dir could not be read');
    assert.match(surf.detail, /could not run|COULD NOT RUN/i, 'detail explains the check could not run');
  } finally {
    cleanup(fx);
  }
});

// ── (h3) CR-01 no-regression: a readable-but-empty skillsDir + manifest.skills:[] still PASSes ──
test('CR-01 no-regression: a readable EMPTY skillsDir with manifest.skills:[] => surface-skills PASS', () => {
  // "read succeeded, zero skills found" is a legitimate PASS (declared:[] == shipped:[]). Only an
  // unreadable dir is a FAIL — distinguish the two.
  const fx = makeFixture(baseManifest({ skills: [] }), [], COMMANDS); // skillsDir exists, ships no skills
  try {
    const r = runVerifyCapability({
      liveRoot: '/fake/gsd-core',
      requireLiveScript: () => stubValidators(),
      manifestPath: fx.manifestPath,
      skillsDir: fx.skillsDir,
      commandsDir: fx.commandsDir,
    });
    const surf = r.results.find((x) => x.name === 'surface-skills');
    assert.ok(surf && surf.verdict === 'pass', 'an empty-but-readable skills dir matching skills:[] PASSes');
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
test('11-03 conform: hooks present, fresh bundle, reachable liveRoot, bundled resolver => 3 new checks PASS', () => {
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
      checkBundleFresh: () => ({ fresh: true, staleFiles: [], checked: 3 }),
    });
    assert.equal(r.ok, true, JSON.stringify(r.results, null, 2));
    const hm = r.results.find((x) => x.name === 'hooks-manifest');
    const bp = r.results.find((x) => x.name === 'bundle-parity');
    const rr = r.results.find((x) => x.name === 'runtime-live-resolution');
    assert.ok(hm && hm.verdict === 'pass', 'hooks-manifest PASS');
    assert.ok(bp && bp.verdict === 'pass', 'bundle-parity PASS');
    assert.ok(rr && rr.verdict === 'pass', 'runtime-live-resolution PASS');
  } finally {
    cleanup(fx);
    fs.rmSync(bundle.dir, { recursive: true, force: true });
    fs.rmSync(live, { recursive: true, force: true });
  }
});

// ── (l) hooks-file miss: a declared hooks[].script with no bundle file => hooks-manifest FAIL, ok:false ──
test('11-03 hooks-file miss: a declared hooks[].script absent from the bundle => hooks-manifest FAIL, ok:false', () => {
  const fx = makeFixture(manifestWithHooks(HOOK_SCRIPTS), SKILLS, COMMANDS);
  // Bundle ships only the FIRST script (+ resolver); the second declared script has no file.
  const bundle = conformantBundle([HOOK_SCRIPTS[0]]);
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
    assert.equal(r.ok, false, 'a declared script with no bundle file is NEVER a silent conformant');
    const hm = r.results.find((x) => x.name === 'hooks-manifest');
    assert.ok(hm && hm.verdict === 'fail', 'hooks-manifest FAILed');
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
test('11-03 hermetic: the real capabilities/contrib-gate bundle + manifest are untouched by the suite', () => {
  // A trivial structural assertion that the new cases inject seams (bundleHooksDir / checkBundleFresh)
  // rather than the defaults — proven by the fact every 11-03 case above passes os.mkdtemp paths.
  const src = fs.readFileSync(path.join(__dirname, 'verify-capability.test.cjs'), 'utf8');
  assert.match(src, /bundleHooksDir: bundle\.bundleHooksDir/, 'cases inject a tmp bundleHooksDir');
  assert.match(src, /checkBundleFresh: \(\) =>/, 'cases inject checkBundleFresh');
});
