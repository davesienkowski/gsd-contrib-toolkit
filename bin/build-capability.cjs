#!/usr/bin/env node
'use strict';

/**
 * bin/build-capability.cjs — the bundle GENERATOR + `--check` staleness gate (CAP-02, design §4).
 *
 * The top-level `hooks/` tree is the single DEV SOURCE OF TRUTH. The capability bundle
 * (`capabilities/contribution-gate/hooks/`) is a GENERATED ARTIFACT — never a hand-maintained second
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
 *   - Every generated write is CONFINED under capabilities/contribution-gate/hooks/ — any resolved
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
const BUNDLE_DIR = path.join(REPO_ROOT, 'capabilities', 'contribution-gate');
const BUNDLE_HOOKS_DIR = path.join(BUNDLE_DIR, 'hooks');
const MANIFEST_PATH = path.join(BUNDLE_DIR, 'capability.json');

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
 * @param {string} [deps.manifestPath] manifest to stamp.
 * @param {string} [deps.snippetPath] settings.snippet.json (for the wired set).
 * @param {string} [deps.version] version string to stamp (defaults to the manifest's current version).
 * @returns {{files:string[], version:string}} the copied relative paths + the stamped version.
 */
function buildCapability(deps = {}) {
  const sourceHooksDir = deps.sourceHooksDir || CANONICAL_HOOKS_DIR;
  const bundleHooksDir = deps.bundleHooksDir || BUNDLE_HOOKS_DIR;
  const manifestPath = deps.manifestPath || MANIFEST_PATH;
  const snippetPath = deps.snippetPath || SNIPPET_PATH;

  const scriptSet = readCanonicalScriptSet({ snippetPath });
  const planned = plannedBundleFiles({ sourceHooksDir, scriptSet });

  // Verify EVERY canonical source exists FIRST (fail-loud before any partial write).
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

  // Copy verbatim into the confined bundle hooks/ dir.
  fs.mkdirSync(bundleHooksDir, { recursive: true });
  for (const rel of planned) {
    const src = path.join(sourceHooksDir, rel);
    const dst = confineUnder(bundleHooksDir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, fs.readFileSync(src)); // Buffer copy — byte-for-byte, no transform.
  }

  // Stamp the manifest version: parse→set→write, preserving every other field verbatim.
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const version = deps.version || manifest.version;
  if (!SEMVER_RE.test(String(version || ''))) {
    throw new Error(`build-capability: cannot stamp a non-semver version: ${JSON.stringify(version)}`);
  }
  manifest.version = version;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  return { files: planned, version };
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
 * @param {object} [deps] injectable seams.
 * @param {string} [deps.sourceHooksDir] canonical hooks/ dir.
 * @param {string} [deps.bundleHooksDir] bundle hooks/ dir to compare.
 * @param {string} [deps.snippetPath] settings.snippet.json (for the wired set).
 * @returns {{fresh:boolean, staleFiles:{path:string, reason:string}[], checked:number}}
 */
function checkBundleFresh(deps = {}) {
  const sourceHooksDir = deps.sourceHooksDir || CANONICAL_HOOKS_DIR;
  const bundleHooksDir = deps.bundleHooksDir || BUNDLE_HOOKS_DIR;
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

  return { fresh: staleFiles.length === 0, staleFiles, checked: planned.length };
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
      process.stdout.write('         hooks/' + s.path + ' — ' + s.reason + '\n');
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
  plannedBundleFiles,
  confineUnder,
  runCli,
  SEMVER_RE,
};
