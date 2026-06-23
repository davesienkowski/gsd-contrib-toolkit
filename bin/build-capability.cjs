#!/usr/bin/env node
'use strict';

/**
 * bin/build-capability.cjs — the bundle GENERATOR + `--check` staleness gate (CAP-02, design §4).
 *
 * The top-level `hooks/` tree is the single DEV SOURCE OF TRUTH. The capability bundle
 * (`capabilities/contribution-toolkit/hooks/`) is a GENERATED ARTIFACT — never a hand-maintained second
 * copy. This command assembles that bundle byte-for-byte from canonical `hooks/`, stamps the
 * manifest `version`, and provides a read-only `--check` drift gate:
 *
 *   node bin/build-capability.cjs           # BUILD: regenerate the bundle + stamp version, exit 0
 *   node bin/build-capability.cjs --check   # CHECK: exit 1 if the bundle is stale vs source, 0 if fresh
 *
 * THE WIRED SET IS DATA-DRIVEN (never a hardcoded list): the canonical script basenames are read
 * from `settings.snippet.json` (the canonical 13 wired scripts — 12 PreToolUse gates + the
 * protocol-reminder advisory). The whole `hooks/lib/` tree is shipped too, so each bundled gate's
 * relative `require('./lib/...')` resolves INSIDE the bundle. The copy is VERBATIM — the bundled
 * gates still resolve + call the LIVE gsd-core scripts at runtime via hooks/lib/resolve.cjs, so
 * reuse-LIVE is preserved (design §10).
 *
 * THE LOAD-BEARING INVARIANTS:
 *   - Build COPIES canonical hooks; it NEVER reimplements or vendors gsd-core policy/gate logic.
 *   - Every generated write is CONFINED under capabilities/contribution-toolkit/hooks/ — any resolved
 *     target escaping that root is rejected before writing (T-11-01-01 path-traversal guard).
 *   - The version stamp is a parse→set→write of the EXISTING manifest: only `version` changes,
 *     the rest of the manifest is preserved verbatim (T-11-01-02).
 *   - `--check` is READ-ONLY: it compares bundle bytes to canonical source byte-for-byte and FAILS
 *     (exit 1, naming each stale path) on any difference — it never silently auto-fixes (T-11-01-03).
 *   - A canonical source file missing at build time is a LOUD nonzero error, never a silent
 *     partial bundle (T-11-01-04 fail-loud, not fail-open).
 *
 * No shell: pure node:fs reads/writes (carries the no-shell discipline of the hook layer).
 *
 * @module bin/build-capability
 */

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const CANONICAL_HOOKS_DIR = path.join(REPO_ROOT, 'hooks');
const CANONICAL_LIB_DIR = path.join(CANONICAL_HOOKS_DIR, 'lib');
const SNIPPET_PATH = path.join(REPO_ROOT, 'settings.snippet.json');
const BUNDLE_DIR = path.join(REPO_ROOT, 'capabilities', 'contribution-toolkit');
const BUNDLE_HOOKS_DIR = path.join(BUNDLE_DIR, 'hooks');
const MANIFEST_PATH = path.join(BUNDLE_DIR, 'capability.json');

// The canonical skill source tree (the single DEV SOURCE OF TRUTH for the shipped skills — the same
// dir verify-capability.cjs reads for surface disclosure) and its bundle mirror. The bundle skills/
// tree is GENERATED here, byte-for-byte, from CANONICAL_SKILLS_DIR — never hand-edited (CAP-09).
const CANONICAL_SKILLS_DIR = path.join(REPO_ROOT, 'skills');
const BUNDLE_SKILLS_DIR = path.join(BUNDLE_DIR, 'skills');

// The canonical command source dir (the single DEV SOURCE OF TRUTH for the shipped agent-facing
// slash-commands — the same dir verify-capability.cjs reads for surface disclosure) and its bundle
// mirror. The bundle commands/ tree is GENERATED here, byte-for-byte, from CANONICAL_COMMANDS_DIR —
// never hand-edited (CAP-10). Unlike skills (a per-stem DIRECTORY subtree), commands are FLAT single
// `.md` files: one `<stem>.md` per disclosed command.
//
// ADR-959 HONESTY BOUNDARY: the commands are shipped as plain bundle FILES only. The manifest must
// NOT gain a `commands[]` `{family, module, router}` CLI array — that field denotes first-party
// gsd-tools CLI subcommand routers, a DIFFERENT artifact than agent-facing slash-commands. This
// generator ships the `.md`s; it does not touch the manifest beyond the existing version stamp.
const CANONICAL_COMMANDS_DIR = path.join(REPO_ROOT, 'commands');
const BUNDLE_COMMANDS_DIR = path.join(BUNDLE_DIR, 'commands');

// The disclosed command set is DATA-DRIVEN from disk: the basenames of every `gsd-*.md` under the
// canonical commands/ dir. This is the EXACT filter verify-capability.cjs's readShippedCommands uses,
// so the bundled set provably equals the disclosed/verified set (T-17-01-HARDCODE) — never a
// hardcoded literal of the 5 names.
const COMMAND_NAME_RE = /^gsd-.*\.md$/;

const SEMVER_RE = /^\d+\.\d+\.\d+/;

/**
 * Read the canonical wired script set from settings.snippet.json — the basenames of every
 * `hooks/<name>.cjs` referenced in any hook `command`. Data-driven so the bundle stays in sync if
 * the wired set changes (the action mandates deriving this from the snippet, not a hardcoded list).
 *
 * @param {object} [deps]
 * @param {string} [deps.snippetPath] path to settings.snippet.json.
 * @param {(p:string) => string} [deps.readFile] injectable file reader.
 * @returns {string[]} sorted unique basenames (e.g. 'gh-issue-create.cjs').
 */
function readCanonicalScriptSet(deps = {}) {
  const snippetPath = deps.snippetPath || SNIPPET_PATH;
  const readFile = deps.readFile || ((p) => fs.readFileSync(p, 'utf8'));
  const snippet = JSON.parse(readFile(snippetPath));
  const names = new Set();
  const walk = (node) => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node && typeof node === 'object') {
      for (const key of Object.keys(node)) {
        const val = node[key];
        if (key === 'command' && typeof val === 'string') {
          const matches = val.match(/hooks\/([A-Za-z0-9._-]+\.cjs)/g) || [];
          for (const m of matches) names.add(m.replace(/^hooks\//, ''));
        } else {
          walk(val);
        }
      }
    }
  };
  walk(snippet);
  return [...names].sort();
}

/**
 * Recursively list every file under a directory, returned as paths RELATIVE to that directory
 * (POSIX-joined). Used to enumerate the canonical hooks/lib/ tree for verbatim copy.
 *
 * @param {string} absDir absolute directory root.
 * @returns {string[]} sorted relative POSIX paths.
 */
function listFilesRel(absDir) {
  const out = [];
  const walk = (dir, prefix) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      const rel = prefix ? prefix + '/' + ent.name : ent.name;
      if (ent.isDirectory()) {
        walk(full, rel);
      } else if (ent.isFile()) {
        out.push(rel);
      }
    }
  };
  walk(absDir, '');
  out.sort();
  return out;
}

/**
 * Compute the complete planned bundle file list (relative to the bundle hooks/ dir) from a given
 * canonical source: the wired script basenames PLUS every file under hooks/lib/ (prefixed `lib/`).
 * This is the single definition of "what the bundle must contain" used by BOTH build and check.
 *
 * @param {object} [deps]
 * @param {string} [deps.sourceHooksDir] canonical hooks/ dir (defaults to repo hooks/).
 * @param {string[]} [deps.scriptSet] canonical script basenames (defaults to snippet-derived).
 * @returns {string[]} sorted relative POSIX paths the bundle hooks/ must contain.
 */
function plannedBundleFiles(deps = {}) {
  const sourceHooksDir = deps.sourceHooksDir || CANONICAL_HOOKS_DIR;
  const scriptSet = deps.scriptSet || readCanonicalScriptSet();
  const libDir = path.join(sourceHooksDir, 'lib');
  const libFiles = fs.existsSync(libDir) ? listFilesRel(libDir).map((r) => 'lib/' + r) : [];
  return [...scriptSet, ...libFiles].sort();
}

/**
 * Read the DECLARED skill set from the capability manifest — the `skills[]` array verbatim. This is
 * the skills analogue of readCanonicalScriptSet: the bundled skill set is DATA-DRIVEN from the
 * manifest (NOT a hardcoded list), so a change to `skills[]` drives BOTH what the build copies AND
 * what `--check` enforces. Tolerant of an absent/non-array `skills` field (returns []), and returns
 * the sorted unique stems.
 *
 * @param {object} [deps]
 * @param {string} [deps.manifestPath] path to capability.json.
 * @param {(p:string) => string} [deps.readFile] injectable file reader.
 * @returns {string[]} sorted unique skill stems (one per declared skill).
 */
function readDeclaredSkillSet(deps = {}) {
  const manifestPath = deps.manifestPath || MANIFEST_PATH;
  const readFile = deps.readFile || ((p) => fs.readFileSync(p, 'utf8'));
  const manifest = JSON.parse(readFile(manifestPath));
  const declared = Array.isArray(manifest.skills) ? manifest.skills : [];
  const stems = new Set();
  for (const s of declared) {
    if (typeof s === 'string' && s.length > 0) stems.add(s);
  }
  return [...stems].sort();
}

/**
 * Compute the planned bundle skill file list (relative to the bundle skills/ dir) from the DECLARED
 * skill set: for each declared stem, every file under skills/<stem>/** prefixed `<stem>/...`. The
 * single definition of "which skill files the bundle must contain" used by BOTH build and check.
 *
 * A declared stem whose canonical source dir is ABSENT (or not a directory) is recorded in
 * `missingSources` so the build can fail LOUD (never a silent skip / partial bundle) — it is NOT
 * silently dropped from the planned set.
 *
 * @param {object} [deps]
 * @param {string} [deps.sourceSkillsDir] canonical skills/ dir (defaults to repo skills/).
 * @param {string[]} [deps.skillSet] declared skill stems (defaults to manifest-derived).
 * @param {string} [deps.manifestPath] manifest for the default skillSet.
 * @returns {{files:string[], missingSources:string[]}} sorted relative POSIX paths + missing stems.
 */
function plannedSkillFiles(deps = {}) {
  const sourceSkillsDir = deps.sourceSkillsDir || CANONICAL_SKILLS_DIR;
  const skillSet = deps.skillSet || readDeclaredSkillSet({ manifestPath: deps.manifestPath });
  const files = [];
  const missingSources = [];
  for (const stem of skillSet) {
    // WR-01: Reject any stem that is not a plain single-segment directory name — a traversal stem
    // (containing '/', '\', or '..') would cause listFilesRel to walk an arbitrary filesystem path
    // and readFileSync to read arbitrary file contents. The write side is blocked by confineUnder,
    // but the read side needs its own guard. Throw LOUD so a compromised manifest is noticed
    // immediately rather than silently reading unexpected files from disk.
    if (stem.includes('/') || stem.includes('\\') || path.isAbsolute(stem)) {
      throw new Error(
        `build-capability: refusing to read skill source for unsafe stem name: ${JSON.stringify(stem)}`
      );
    }
    const stemDir = path.join(sourceSkillsDir, stem);
    if (!fs.existsSync(stemDir) || !fs.statSync(stemDir).isDirectory()) {
      missingSources.push(stem);
      continue;
    }
    for (const rel of listFilesRel(stemDir)) files.push(stem + '/' + rel);
  }
  files.sort();
  return { files, missingSources };
}

/**
 * Read the DISCLOSED command set from DISK — the basenames (sans `.md`) of every `gsd-*.md` under the
 * canonical commands/ dir. This is the command analogue of readDeclaredSkillSet, but DATA-DRIVEN from
 * DISK (not the manifest): the bundled command set follows what is actually disclosed on disk, never a
 * hardcoded list, so adding/removing a `commands/gsd-*.md` changes the bundled set. Uses the SAME
 * `/^gsd-.*\.md$/` filter as verify-capability.cjs readShippedCommands, so the bundled set provably
 * equals the disclosed/verified set (T-17-01-HARDCODE).
 *
 * Matches the skills discipline: a readable dir is REQUIRED — an unreadable/missing commands dir is a
 * LOUD throw (never a silent "zero commands", which would forge an empty bundle). The missing-SOURCE
 * (a declared command whose `.md` is absent) discipline is handled in plannedCommandFiles/build.
 *
 * @param {object} [deps]
 * @param {string} [deps.commandsDir] canonical commands/ dir (defaults to repo commands/).
 * @param {(p:string, opts:object) => fs.Dirent[]} [deps.readdir] injectable dir reader.
 * @returns {string[]} sorted unique command stems (filename sans .md), one per disclosed command.
 */
function readDisclosedCommandSet(deps = {}) {
  const commandsDir = deps.commandsDir || CANONICAL_COMMANDS_DIR;
  const readdir = deps.readdir || ((p, opts) => fs.readdirSync(p, opts));
  const entries = readdir(commandsDir, { withFileTypes: true });
  const stems = new Set();
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    if (COMMAND_NAME_RE.test(ent.name)) stems.add(ent.name.replace(/\.md$/, ''));
  }
  return [...stems].sort();
}

/**
 * Compute the planned bundle command file list (relative to the bundle commands/ dir) from the
 * DISCLOSED command set: one FLAT `<stem>.md` entry per command stem. Commands are flat single `.md`
 * files (unlike skills' per-stem directory subtree), so this does NOT recurse a per-command dir — it
 * maps each safe stem to `<stem>.md`. The single definition of "which command files the bundle must
 * contain" used by BOTH build and check.
 *
 * A disclosed stem whose canonical source `<stem>.md` is ABSENT is recorded in `missingSources` so the
 * build can fail LOUD (never a silent skip / partial bundle), mirroring plannedSkillFiles.
 *
 * @param {object} [deps]
 * @param {string} [deps.sourceCommandsDir] canonical commands/ dir (defaults to repo commands/).
 * @param {string[]} [deps.commandSet] disclosed command stems (defaults to disk-derived).
 * @returns {{files:string[], missingSources:string[]}} sorted relative POSIX paths + missing stems.
 */
function plannedCommandFiles(deps = {}) {
  const sourceCommandsDir = deps.sourceCommandsDir || CANONICAL_COMMANDS_DIR;
  const commandSet = deps.commandSet || readDisclosedCommandSet({ commandsDir: sourceCommandsDir });
  const files = [];
  const missingSources = [];
  for (const stem of commandSet) {
    // WR-01: Reject any stem that is not a plain single-segment name — a traversal stem (containing
    // '/', '\', or absolute) would cause path.join/readFileSync to read arbitrary file contents. The
    // write side is blocked by confineUnder, but the read side needs its own guard. Throw LOUD so a
    // tampered command name is noticed immediately rather than silently reading unexpected files.
    if (stem.includes('/') || stem.includes('\\') || path.isAbsolute(stem)) {
      throw new Error(
        `build-capability: refusing to read command source for unsafe stem name: ${JSON.stringify(stem)}`
      );
    }
    const srcFile = path.join(sourceCommandsDir, stem + '.md');
    if (!fs.existsSync(srcFile) || !fs.statSync(srcFile).isFile()) {
      missingSources.push(stem);
      continue;
    }
    files.push(stem + '.md');
  }
  files.sort();
  return { files, missingSources };
}

/**
 * Guard: assert a resolved target stays under the confinement root. Rejects any path that escapes
 * (via `..` or absolute) the bundle hooks/ root BEFORE a write happens (T-11-01-01).
 *
 * @param {string} rootDir absolute confinement root.
 * @param {string} rel relative target path.
 * @returns {string} the resolved absolute target (guaranteed under rootDir).
 * @throws {Error} when the resolved target escapes rootDir.
 */
function confineUnder(rootDir, rel) {
  const resolvedRoot = path.resolve(rootDir);
  const target = path.resolve(resolvedRoot, rel);
  // The target must be STRICTLY under resolvedRoot — the root itself is NOT a valid file target.
  // When rel is '', '.', or any value resolving to resolvedRoot, this rejects it (WR-01): the
  // confinement contract is "guaranteed UNDER rootDir", and the directory itself is never a write target.
  if (!target.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`build-capability: refusing to write outside the bundle root: ${rel}`);
  }
  return target;
}

/**
 * buildCapability — regenerate the bundle hooks/ tree from canonical source + stamp the manifest
 * version. Copies each wired script and the whole hooks/lib/ tree byte-for-byte into the bundle
 * hooks/ dir, then writes the manifest `version` (parse→set→write, preserving every other field).
 *
 * A missing canonical source file is a LOUD throw, never a silent partial bundle (T-11-01-04).
 *
 * @param {object} [deps] injectable seams (default to the real repo paths).
 * @param {string} [deps.sourceHooksDir] canonical hooks/ dir.
 * @param {string} [deps.bundleHooksDir] target bundle hooks/ dir.
 * @param {string} [deps.sourceSkillsDir] canonical skills/ dir.
 * @param {string} [deps.bundleSkillsDir] target bundle skills/ dir.
 * @param {string} [deps.sourceCommandsDir] canonical commands/ dir.
 * @param {string} [deps.bundleCommandsDir] target bundle commands/ dir.
 * @param {string} [deps.manifestPath] manifest to stamp.
 * @param {string} [deps.snippetPath] settings.snippet.json (for the wired set).
 * @param {string} [deps.version] version string to stamp (defaults to the manifest's current version).
 * @returns {{files:string[], version:string}} the copied relative paths + the stamped version.
 */
function buildCapability(deps = {}) {
  const sourceHooksDir = deps.sourceHooksDir || CANONICAL_HOOKS_DIR;
  const bundleHooksDir = deps.bundleHooksDir || BUNDLE_HOOKS_DIR;
  const sourceSkillsDir = deps.sourceSkillsDir || CANONICAL_SKILLS_DIR;
  const bundleSkillsDir = deps.bundleSkillsDir || BUNDLE_SKILLS_DIR;
  const sourceCommandsDir = deps.sourceCommandsDir || CANONICAL_COMMANDS_DIR;
  const bundleCommandsDir = deps.bundleCommandsDir || BUNDLE_COMMANDS_DIR;
  const manifestPath = deps.manifestPath || MANIFEST_PATH;
  const snippetPath = deps.snippetPath || SNIPPET_PATH;

  const scriptSet = readCanonicalScriptSet({ snippetPath });
  const planned = plannedBundleFiles({ sourceHooksDir, scriptSet });

  // Plan the skills tree DATA-DRIVEN from the manifest skills[] (the bundled set follows the
  // declaration, never a hardcoded list).
  const skillSet = readDeclaredSkillSet({ manifestPath });
  const skillsPlan = plannedSkillFiles({ sourceSkillsDir, skillSet });

  // Plan the commands tree DATA-DRIVEN from the disclosed command set on DISK (commands/gsd-*.md) —
  // the bundled set follows what is disclosed, never a hardcoded list (CAP-10 data-driven mandate).
  // (deps.commandSet is an injectable seam for hermetic tests — production always derives from disk.)
  const commandSet = deps.commandSet || readDisclosedCommandSet({ commandsDir: sourceCommandsDir });
  const commandsPlan = plannedCommandFiles({ sourceCommandsDir, commandSet });

  // Verify EVERY canonical source exists FIRST (fail-loud before any partial write).
  // (1) hooks: each planned hook file must be a regular file.
  const missing = [];
  for (const rel of planned) {
    const src = path.join(sourceHooksDir, rel);
    if (!fs.existsSync(src) || !fs.statSync(src).isFile()) missing.push(rel);
  }
  if (missing.length > 0) {
    throw new Error(
      'build-capability: missing canonical source file(s) — cannot build a partial bundle:\n  ' +
        missing.join('\n  ')
    );
  }
  // (2) skills: a DECLARED skill whose canonical source dir is ABSENT is a LOUD throw (no partial
  // bundle), mirroring the hooks missing-source check. Then each planned skill file must be a
  // regular file too (a stem dir present but a planned member missing is still fail-loud).
  if (skillsPlan.missingSources.length > 0) {
    throw new Error(
      'build-capability: missing canonical skill source dir(s) — cannot build a partial bundle:\n  ' +
        skillsPlan.missingSources.map((s) => 'skills/' + s).join('\n  ')
    );
  }
  const missingSkillFiles = [];
  for (const rel of skillsPlan.files) {
    const src = path.join(sourceSkillsDir, rel);
    if (!fs.existsSync(src) || !fs.statSync(src).isFile()) missingSkillFiles.push(rel);
  }
  if (missingSkillFiles.length > 0) {
    throw new Error(
      'build-capability: missing canonical skill source file(s) — cannot build a partial bundle:\n  ' +
        missingSkillFiles.map((r) => 'skills/' + r).join('\n  ')
    );
  }
  // (3) commands: a DISCLOSED command whose canonical source `.md` is ABSENT is a LOUD throw (no
  // partial bundle), mirroring the hooks + skills missing-source checks. This throw is checked
  // alongside the hooks/skills checks BEFORE any write of ANY tree, so a missing command source can
  // never leave a half-written bundle (T-17-01-PARTIAL).
  if (commandsPlan.missingSources.length > 0) {
    throw new Error(
      'build-capability: missing canonical command source file(s) — cannot build a partial bundle:\n  ' +
        commandsPlan.missingSources.map((s) => 'commands/' + s + '.md').join('\n  ')
    );
  }

  // Copy verbatim into the confined bundle hooks/ dir.
  fs.mkdirSync(bundleHooksDir, { recursive: true });
  for (const rel of planned) {
    const src = path.join(sourceHooksDir, rel);
    const dst = confineUnder(bundleHooksDir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, fs.readFileSync(src)); // Buffer copy — byte-for-byte, no transform.
  }

  // Copy the planned skill files verbatim into the confined bundle skills/ dir (same machinery as
  // hooks: Buffer copy, byte-for-byte, every write confined under the skills root).
  if (skillsPlan.files.length > 0) {
    fs.mkdirSync(bundleSkillsDir, { recursive: true });
    for (const rel of skillsPlan.files) {
      const src = path.join(sourceSkillsDir, rel);
      const dst = confineUnder(bundleSkillsDir, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.writeFileSync(dst, fs.readFileSync(src)); // Buffer copy — byte-for-byte, no transform.
    }
  }

  // Copy the planned command files verbatim into the confined bundle commands/ dir (same machinery as
  // hooks + skills: Buffer copy, byte-for-byte, every write confined under the commands root). Commands
  // are FLAT `<stem>.md` files — no per-command subtree.
  if (commandsPlan.files.length > 0) {
    fs.mkdirSync(bundleCommandsDir, { recursive: true });
    for (const rel of commandsPlan.files) {
      const src = path.join(sourceCommandsDir, rel);
      const dst = confineUnder(bundleCommandsDir, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.writeFileSync(dst, fs.readFileSync(src)); // Buffer copy — byte-for-byte, no transform.
    }
  }

  // Stamp the manifest version: parse→set→write, preserving every other field verbatim.
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const version = deps.version || manifest.version;
  if (!SEMVER_RE.test(String(version || ''))) {
    throw new Error(`build-capability: cannot stamp a non-semver version: ${JSON.stringify(version)}`);
  }
  manifest.version = version;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  // The returned file count covers ALL THREE bundled trees: hooks rel-paths as-is, skill rel-paths
  // prefixed `skills/`, and command rel-paths prefixed `commands/` so they are namespace-unambiguous.
  const allFiles = [
    ...planned,
    ...skillsPlan.files.map((r) => 'skills/' + r),
    ...commandsPlan.files.map((r) => 'commands/' + r),
  ].sort();
  return { files: allFiles, version };
}

/**
 * checkBundleFresh — READ-ONLY drift comparison. The bundle is FRESH iff (1) every planned file
 * exists in the bundle hooks/ dir AND is byte-identical to its canonical source, AND (2) the bundle
 * dir contains NO file absent from the planned set. Any missing, differing, OR EXTRA file makes the
 * bundle STALE (named in staleFiles). Never writes anything (T-11-01-03).
 *
 * WR-04: the extra-file half makes the integrity guarantee SYMMETRIC — previously `--check` was blind
 * to a file planted in the bundle dir (e.g. a malicious extra hook script), since it only verified the
 * planned set was present+identical and never enumerated what was ACTUALLY there. This closes the
 * "never an augmented bundle" gap on the check path to mirror the "never a partial bundle" build
 * invariant. verify-capability's bundle-parity check REUSES this single function, so both gates share
 * the SAME staleness truth (design §4) — including extra-file rejection.
 *
 * The skills tree is covered with the SAME staleness truth: each planned skill file is reported
 * 'canonical source missing' / 'missing from bundle' / 'differs from canonical source', and any file
 * under <bundleDir>/skills/ NOT in the planned skills set is reported 'extra file in bundle (not in
 * planned set)' (the symmetric WR-04 half). Skills stale paths are reported with a `skills/` prefix so
 * the CLI names them unambiguously vs `hooks/` paths.
 *
 * @param {object} [deps] injectable seams.
 * @param {string} [deps.sourceHooksDir] canonical hooks/ dir.
 * @param {string} [deps.bundleHooksDir] bundle hooks/ dir to compare.
 * @param {string} [deps.sourceSkillsDir] canonical skills/ dir.
 * @param {string} [deps.bundleSkillsDir] bundle skills/ dir to compare.
 * @param {string} [deps.sourceCommandsDir] canonical commands/ dir.
 * @param {string} [deps.bundleCommandsDir] bundle commands/ dir to compare.
 * @param {string} [deps.manifestPath] manifest (for the declared skills set).
 * @param {string} [deps.snippetPath] settings.snippet.json (for the wired set).
 * @returns {{fresh:boolean, staleFiles:{path:string, reason:string}[], checked:number}}
 */
function checkBundleFresh(deps = {}) {
  const sourceHooksDir = deps.sourceHooksDir || CANONICAL_HOOKS_DIR;
  const bundleHooksDir = deps.bundleHooksDir || BUNDLE_HOOKS_DIR;
  const sourceSkillsDir = deps.sourceSkillsDir || CANONICAL_SKILLS_DIR;
  const bundleSkillsDir = deps.bundleSkillsDir || BUNDLE_SKILLS_DIR;
  const sourceCommandsDir = deps.sourceCommandsDir || CANONICAL_COMMANDS_DIR;
  const bundleCommandsDir = deps.bundleCommandsDir || BUNDLE_COMMANDS_DIR;
  const manifestPath = deps.manifestPath || MANIFEST_PATH;
  const snippetPath = deps.snippetPath || SNIPPET_PATH;

  const scriptSet = readCanonicalScriptSet({ snippetPath });
  const planned = plannedBundleFiles({ sourceHooksDir, scriptSet });

  const staleFiles = [];
  for (const rel of planned) {
    const src = path.join(sourceHooksDir, rel);
    const bundled = path.join(bundleHooksDir, rel);
    if (!fs.existsSync(src) || !fs.statSync(src).isFile()) {
      staleFiles.push({ path: rel, reason: 'canonical source missing' });
      continue;
    }
    if (!fs.existsSync(bundled) || !fs.statSync(bundled).isFile()) {
      staleFiles.push({ path: rel, reason: 'missing from bundle' });
      continue;
    }
    const srcBytes = fs.readFileSync(src);
    const bundledBytes = fs.readFileSync(bundled);
    if (!srcBytes.equals(bundledBytes)) {
      staleFiles.push({ path: rel, reason: 'differs from canonical source' });
    }
  }

  // WR-04: enumerate the ACTUAL bundle dir and reject any file NOT in the planned set. This is the
  // symmetric "never an augmented bundle" half of the integrity guarantee. (If the bundle dir does
  // not exist yet, every planned file already reported 'missing from bundle' above — nothing extra.)
  if (fs.existsSync(bundleHooksDir)) {
    const plannedSet = new Set(planned);
    for (const bundled of listFilesRel(bundleHooksDir)) {
      if (!plannedSet.has(bundled)) {
        staleFiles.push({ path: bundled, reason: 'extra file in bundle (not in planned set)' });
      }
    }
  }

  // ── Skills tree drift (DATA-DRIVEN from manifest skills[]) ──
  // A declared stem whose canonical source dir is absent surfaces as 'canonical source missing'
  // (plannedSkillFiles records it in missingSources rather than emitting planned files for it).
  const skillSet = readDeclaredSkillSet({ manifestPath });
  const skillsPlan = plannedSkillFiles({ sourceSkillsDir, skillSet });
  for (const stem of skillsPlan.missingSources) {
    staleFiles.push({ path: 'skills/' + stem, reason: 'canonical source missing' });
  }
  const plannedSkillRel = new Set(skillsPlan.files); // bundle-skills-relative (no `skills/` prefix)
  for (const rel of skillsPlan.files) {
    const src = path.join(sourceSkillsDir, rel);
    const bundled = path.join(bundleSkillsDir, rel);
    // (canonical source presence already implied by being in skillsPlan.files; re-check for safety)
    if (!fs.existsSync(src) || !fs.statSync(src).isFile()) {
      staleFiles.push({ path: 'skills/' + rel, reason: 'canonical source missing' });
      continue;
    }
    if (!fs.existsSync(bundled) || !fs.statSync(bundled).isFile()) {
      staleFiles.push({ path: 'skills/' + rel, reason: 'missing from bundle' });
      continue;
    }
    if (!fs.readFileSync(src).equals(fs.readFileSync(bundled))) {
      staleFiles.push({ path: 'skills/' + rel, reason: 'differs from canonical source' });
    }
  }
  // Symmetric extra-file half — walk <bundleDir>/skills ONLY (never the whole bundle: fragments/ and
  // hooks/ are not managed here), report any bundled skill file not in the planned skills set.
  if (fs.existsSync(bundleSkillsDir)) {
    for (const bundled of listFilesRel(bundleSkillsDir)) {
      if (!plannedSkillRel.has(bundled)) {
        staleFiles.push({ path: 'skills/' + bundled, reason: 'extra file in bundle (not in planned set)' });
      }
    }
  }

  // ── Commands tree drift (DATA-DRIVEN from disclosed commands/gsd-*.md on disk) ──
  // A disclosed command whose canonical source `.md` is absent surfaces as 'canonical source missing'
  // (plannedCommandFiles records it in missingSources rather than emitting a planned file for it).
  // (deps.commandSet is an injectable seam for hermetic tests — production always derives from disk.)
  const commandSet = deps.commandSet || readDisclosedCommandSet({ commandsDir: sourceCommandsDir });
  const commandsPlan = plannedCommandFiles({ sourceCommandsDir, commandSet });
  for (const stem of commandsPlan.missingSources) {
    staleFiles.push({ path: 'commands/' + stem + '.md', reason: 'canonical source missing' });
  }
  const plannedCommandRel = new Set(commandsPlan.files); // bundle-commands-relative (no `commands/` prefix)
  for (const rel of commandsPlan.files) {
    const src = path.join(sourceCommandsDir, rel);
    const bundled = path.join(bundleCommandsDir, rel);
    if (!fs.existsSync(src) || !fs.statSync(src).isFile()) {
      staleFiles.push({ path: 'commands/' + rel, reason: 'canonical source missing' });
      continue;
    }
    if (!fs.existsSync(bundled) || !fs.statSync(bundled).isFile()) {
      staleFiles.push({ path: 'commands/' + rel, reason: 'missing from bundle' });
      continue;
    }
    if (!fs.readFileSync(src).equals(fs.readFileSync(bundled))) {
      staleFiles.push({ path: 'commands/' + rel, reason: 'differs from canonical source' });
    }
  }
  // Symmetric extra-file half — walk <bundleDir>/commands ONLY, report any bundled command file not in
  // the planned commands set (the WR-04 "never an augmented bundle" half for commands).
  if (fs.existsSync(bundleCommandsDir)) {
    for (const bundled of listFilesRel(bundleCommandsDir)) {
      if (!plannedCommandRel.has(bundled)) {
        staleFiles.push({ path: 'commands/' + bundled, reason: 'extra file in bundle (not in planned set)' });
      }
    }
  }

  return {
    fresh: staleFiles.length === 0,
    staleFiles,
    checked: planned.length + skillsPlan.files.length + commandsPlan.files.length,
  };
}

/**
 * CLI: with no flag, BUILD (regenerate + stamp) and exit 0 (throws bubble to a nonzero exit).
 * With `--check`, run the read-only drift gate: exit 1 (naming each stale path) when stale, 0 fresh.
 *
 * @param {string[]} [argv] process args after node + script (defaults to process.argv.slice(2)).
 * @returns {number} process exit code.
 */
function runCli(argv = process.argv.slice(2)) {
  const isCheck = argv.includes('--check');

  if (isCheck) {
    const result = checkBundleFresh();
    if (result.fresh) {
      process.stdout.write(
        '[PASS] build-capability --check — bundle in sync (' + result.checked + ' file(s) match canonical source)\n'
      );
      return 0;
    }
    process.stdout.write('[FAIL] build-capability --check — bundle is STALE vs canonical source:\n');
    for (const s of result.staleFiles) {
      // Skills + commands stale paths already carry their `skills/` / `commands/` namespace prefix
      // (set in checkBundleFresh); hooks stale paths are bundle-hooks-relative and get the `hooks/`
      // prefix here. This keeps the printed path namespace-correct so a stale skill prints `skills/...`
      // and a stale command prints `commands/...`, never `hooks/skills/...` / `hooks/commands/...`.
      const printed =
        s.path.startsWith('skills/') || s.path.startsWith('commands/') ? s.path : 'hooks/' + s.path;
      process.stdout.write('         ' + printed + ' — ' + s.reason + '\n');
    }
    process.stdout.write('       Run `node bin/build-capability.cjs` to regenerate the bundle.\n');
    return 1;
  }

  const result = buildCapability();
  process.stdout.write(
    '[PASS] build-capability — generated ' +
      result.files.length +
      ' bundle file(s) from canonical hooks/, stamped version ' +
      result.version +
      '\n'
  );
  return 0;
}

if (require.main === module) {
  try {
    process.exit(runCli());
  } catch (err) {
    process.stderr.write('[FAIL] build-capability — ' + (err && err.message ? err.message : String(err)) + '\n');
    process.exit(1);
  }
}

module.exports = {
  buildCapability,
  checkBundleFresh,
  readCanonicalScriptSet,
  readDeclaredSkillSet,
  readDisclosedCommandSet,
  plannedBundleFiles,
  plannedSkillFiles,
  plannedCommandFiles,
  confineUnder,
  runCli,
  SEMVER_RE,
  // Exported so verify-capability.cjs's bundle-commands reader REUSES the EXACT disclosed-command
  // filter rather than inventing a second regex that could drift (18-01 / CAP-11).
  COMMAND_NAME_RE,
};
