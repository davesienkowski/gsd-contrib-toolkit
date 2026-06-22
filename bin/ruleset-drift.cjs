#!/usr/bin/env node
'use strict';

/**
 * bin/ruleset-drift.cjs — OWN-03 ruleset/branch-protection governance assist (ADVISORY).
 *
 * ADVISORY, MAINTAINER-INVOKED doer — NOT a PreToolUse deny gate. It returns NO
 * `permissionDecision` / allow / deny verdict and is NOT registered in settings.snippet.json
 * (mirrors hooks/preflight-shipped-paths.cjs + the sibling bin/triage-assist.cjs /
 * bin/release-preflight.cjs advisory boundary). It is the `bin/` doer the thin
 * `/gsd-ruleset-drift` command runs (D-01/D-02).
 *
 * It surfaces DRIFT between the DECLARED ruleset state and the LIVE state, READ-ONLY by default:
 *   - DECLARED: the `<root>/.github/rulesets/*.json` files (the 3 declared rulesets:
 *     main-protection, release-branches, tag-immutability) — each parsed for name / enforcement /
 *     target / the set of `rules` types. This is the declared source-of-truth.
 *   - LIVE: `gh api repos/<repo>/rulesets` (the LIST has name + enforcement) plus a per-id
 *     `gh api repos/<repo>/rulesets/<id>` detail fetch to recover each live ruleset's `rules`.
 *     `sync-rulesets.sh` has NO native --check/dry-run (it ALWAYS gh-api PUT/POSTs each ruleset),
 *     so the drift read is done HERE via gh api — that script is the `--apply` remediation only.
 *
 * The two are diffed by `name` on `enforcement` + the `rules` type set; declared-only and
 * live-only rulesets are flagged as `presence` drift. The result is a `drift` array of
 * `{ name, field, declared, live }` rows. Read-only: NO mutation happens by default.
 *
 * The LIVE `sync-rulesets.sh` (ruleset enforcement) and `setup-branch-protection.sh` (branch
 * protection) are the NAMED remediation — surfaced as command STRINGS by default and run ONLY
 * behind an explicit `--apply` flag (parsed via the shared structured-argv flags helper), through
 * an injectable seam the test proves is never called without the flag (D-05/D-08). This CLI MUST
 * NOT reimplement the ruleset/branch-protection apply policy — the LIVE shell scripts own it
 * (HARD-02).
 *
 * FAILS LOUD (HARD-02): a failed DECLARED read (missing dir / bad JSON) OR a failed LIVE `gh api`
 * read returns an explicit `error` and reports NO empty-drift / in-sync verdict — never a false
 * "no drift". All subprocess calls use no-shell `execFileSync` with explicit argv arrays; the
 * repo slug is a known constant (overridable), never interpolated into a shell string
 * (T-08-03-INJ).
 *
 * Pure node builtins (node:fs, node:path, node:child_process) + the LIVE resolver + gh — installs
 * NOTHING. Touches settings.snippet.json NOT AT ALL.
 *
 * @module bin/ruleset-drift
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { resolveGsdCoreRoot } = require('../hooks/lib/resolve.cjs');
const { parseCommand } = require('../hooks/lib/argv.cjs');
const { hasFlag } = require('../hooks/lib/flags.cjs');

// The declared ruleset source-of-truth, relative to the gsd-core root.
const RULESETS_DIR_REL = path.join('.github', 'rulesets');
// The repo string the live `gh api` read + remediation target (open-gsd/gsd-core).
const REPO = 'open-gsd/gsd-core';
// The LIVE remediation scripts (the named apply path — never reimplemented here, HARD-02).
const SYNC_RULESETS_REL = 'scripts/sync-rulesets.sh';
const SETUP_BRANCH_PROTECTION_REL = 'scripts/setup-branch-protection.sh';

/**
 * Normalize one ruleset object (declared JSON or live gh-api payload) to the comparable
 * shape: { name, target, enforcement, rules }. `rules` is reduced to the SORTED set of
 * `.type` strings (the comparable surface; parameter-level diffs are out of scope for the
 * top-level governance drift report).
 *
 * @param {object} rs a declared or live ruleset object.
 * @returns {{name:string, target:string, enforcement:string, rules:string[]}}
 */
function normalizeRuleset(rs) {
  const ruleTypes = Array.isArray(rs && rs.rules)
    ? rs.rules
        .map((r) => (typeof r === 'string' ? r : r && r.type))
        .filter((t) => typeof t === 'string')
        .slice()
        .sort()
    : [];
  return {
    name: rs && rs.name,
    target: (rs && rs.target) || null,
    enforcement: (rs && rs.enforcement) || null,
    rules: ruleTypes,
  };
}

/**
 * Pure diff of DECLARED vs LIVE ruleset sets. Matches by `name`; flags:
 *   - presence: a declared ruleset absent live (live:null) or a live ruleset undeclared
 *     (declared:null);
 *   - enforcement: a name present on both whose enforcement differs;
 *   - rules: a name present on both whose `rules` type set differs.
 * Returns an array of `{ name, field, declared, live }` rows (empty when fully in sync).
 *
 * @param {object[]} declared declared rulesets (raw or normalized).
 * @param {object[]} live live rulesets (raw or normalized).
 * @returns {{name:string, field:string, declared:*, live:*}[]}
 */
function diffRulesets(declared, live) {
  const drift = [];
  const dById = new Map();
  const lById = new Map();
  for (const rs of declared || []) {
    const n = normalizeRuleset(rs);
    if (n.name) dById.set(n.name, n);
  }
  for (const rs of live || []) {
    const n = normalizeRuleset(rs);
    if (n.name) lById.set(n.name, n);
  }

  // Declared-side walk: presence (declared-only), enforcement, rules.
  for (const [name, d] of dById) {
    const l = lById.get(name);
    if (!l) {
      drift.push({ name, field: 'presence', declared: 'declared (' + (d.enforcement || '?') + ')', live: null });
      continue;
    }
    if (d.enforcement !== l.enforcement) {
      drift.push({ name, field: 'enforcement', declared: d.enforcement, live: l.enforcement });
    }
    const dRules = d.rules.join(',');
    const lRules = l.rules.join(',');
    if (dRules !== lRules) {
      drift.push({ name, field: 'rules', declared: dRules || '(none)', live: lRules || '(none)' });
    }
  }

  // Live-side walk: presence (live-only / undeclared).
  for (const [name, l] of lById) {
    if (!dById.has(name)) {
      drift.push({ name, field: 'presence', declared: null, live: 'live (' + (l.enforcement || '?') + ')' });
    }
  }

  return drift;
}

/**
 * Default DECLARED reader: parse every `<root>/.github/rulesets/*.json` file. A missing
 * directory, an unreadable file, or invalid JSON THROWS — the caller turns the throw into a
 * LOUD `error`, never a false "no drift" (HARD-02).
 *
 * @param {string} root absolute gsd-core root.
 * @returns {object[]} parsed declared ruleset objects.
 */
function defaultReadDeclared(root) {
  const dir = path.join(root, RULESETS_DIR_REL);
  const entries = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  if (entries.length === 0) {
    throw new Error('no declared ruleset *.json files found under ' + dir);
  }
  return entries.map((f) => {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    return JSON.parse(text);
  });
}

/**
 * Default LIVE reader: `gh api repos/<repo>/rulesets` (the list carries name + enforcement),
 * then a per-id `gh api repos/<repo>/rulesets/<id>` detail fetch to recover each ruleset's
 * `rules` (the list endpoint omits them). No shell; explicit argv arrays; the repo slug is a
 * known constant, never interpolated into a command string (T-08-03-INJ). ANY gh failure
 * THROWS → the caller surfaces it LOUD, never a false clean.
 *
 * @param {string} root absolute gsd-core root (cwd for the gh call).
 * @param {string} [repo] repo slug (default open-gsd/gsd-core).
 * @returns {object[]} live ruleset objects (each with `rules`).
 */
function defaultFetchLive(root, repo = REPO) {
  const ghJson = (args) => {
    const raw = execFileSync('gh', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return JSON.parse(raw);
  };
  const list = ghJson(['api', 'repos/' + repo + '/rulesets']);
  const arr = Array.isArray(list) ? list : [];
  // The list omits `rules`; fetch each ruleset's detail by id to recover them.
  return arr.map((rs) => {
    if (rs && rs.id != null) {
      try {
        const detail = ghJson(['api', 'repos/' + repo + '/rulesets/' + rs.id]);
        return Object.assign({}, rs, { rules: detail && detail.rules });
      } catch (err) {
        // A detail-fetch failure is still LOUD: re-throw so the read is not falsely clean.
        throw new Error('gh api rulesets/' + rs.id + ' detail read failed: ' + ((err && err.message) || String(err)));
      }
    }
    return rs;
  });
}

/**
 * Default APPLY seam — run the LIVE remediation scripts via no-shell execFileSync. Reachable
 * ONLY with --apply. It does NOT reimplement the apply policy: it invokes the LIVE
 * sync-rulesets.sh (ruleset enforcement) + setup-branch-protection.sh (branch protection)
 * exactly (HARD-02). Explicit argv, no shell interpolation.
 *
 * @param {{root:string}} args
 */
function defaultApplyRemediation({ root }) {
  execFileSync('bash', [path.join(root, SYNC_RULESETS_REL)], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  execFileSync('bash', [path.join(root, SETUP_BRANCH_PROTECTION_REL)], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * Build the exact LIVE remediation command STRINGS (surfaced, not executed without --apply).
 * These name the LIVE scripts — the toolkit never reimplements their apply logic (HARD-02).
 *
 * @returns {string[]}
 */
function buildRemediation() {
  return [
    'bash scripts/sync-rulesets.sh                    # sync ruleset enforcement (declared -> live)',
    'DRY_RUN=1 bash scripts/setup-branch-protection.sh # preview branch-protection payloads (no apply)',
    'bash scripts/setup-branch-protection.sh           # apply branch protection (main + next)',
  ];
}

/**
 * The advisory orchestrator. Resolves the gsd-core root, reads the DECLARED + LIVE ruleset
 * state, diffs them, and surfaces the LIVE remediation. On ANY resolve / declared-read /
 * live-read failure it returns an explicit `error` and NO drift / in-sync verdict (LOUD on
 * miss). The LIVE remediation runs ONLY when `apply` is set, through the injectable
 * `applyRemediation` seam — and only when there is drift to remediate.
 *
 * All impure operations are injectable seams for hermetic tests.
 *
 * @param {object} [deps]
 * @param {string} [deps.gsdCoreRoot] absolute gsd-core root (default: resolved from cwd).
 * @param {(startDir:string)=>string} [deps.resolveRoot] injectable resolver.
 * @param {(root:string)=>object[]} [deps.readDeclared] DECLARED .github/rulesets reader.
 * @param {(root:string,repo:string)=>object[]} [deps.fetchLive] LIVE gh-api ruleset reader.
 * @param {(args:object)=>void} [deps.applyRemediation] the LIVE remediation seam (only with apply).
 * @param {boolean} [deps.apply] whether to run the LIVE remediation (default false).
 * @param {string} [deps.repo] repo slug (default open-gsd/gsd-core).
 * @returns {{root?:string, drift?:object[], inSync?:boolean, remediation?:string[], applied?:boolean, apply?:boolean, error?:string}}
 */
function runRulesetDrift(deps = {}) {
  let root = deps.gsdCoreRoot;
  if (!root) {
    const resolveRoot = deps.resolveRoot || ((d) => resolveGsdCoreRoot(d));
    try {
      root = resolveRoot(process.cwd());
    } catch (err) {
      return {
        error: 'could not resolve gsd-core root (run from inside a gsd-core checkout): ' + ((err && err.message) || String(err)),
      };
    }
  }

  const readDeclared = deps.readDeclared || defaultReadDeclared;
  const fetchLive = deps.fetchLive || defaultFetchLive;
  const applyRemediation = deps.applyRemediation || defaultApplyRemediation;
  const apply = deps.apply === true;
  const repo = deps.repo || REPO;

  // --- DECLARED read (LOUD on miss — never a false no-drift) ---
  let declared;
  try {
    declared = readDeclared(root);
  } catch (err) {
    return { error: 'could not read DECLARED .github/rulesets/ state: ' + ((err && err.message) || String(err)) };
  }

  // --- LIVE read via gh api (LOUD on miss — never a false in-sync) ---
  let live;
  try {
    live = fetchLive(root, repo);
  } catch (err) {
    return { error: 'could not read LIVE ruleset state via gh api: ' + ((err && err.message) || String(err)) };
  }

  const drift = diffRulesets(declared, live);
  const inSync = drift.length === 0;
  const remediation = buildRemediation();

  // --- remediation: reachable ONLY with --apply AND only when there is drift ---
  let applied = false;
  if (apply && !inSync) {
    applyRemediation({ root, repo, drift });
    applied = true;
  }

  return { root, drift, inSync, remediation, applied, apply };
}

/**
 * CLI surface: run the advisory drift report, print the declared-vs-live diff to stdout, write
 * a LOUD error to stderr on a failed read (never a false clean), and return an exit code. There
 * is NO permission verdict returned — this is advisory, not a gate.
 *
 * @param {object} [deps] same seams as runRulesetDrift, plus:
 * @param {(s:string)=>void} [deps.write] stdout writer.
 * @param {(s:string)=>void} [deps.writeErr] stderr writer.
 * @returns {number} exit code (0 on a clean advisory run, 1 on a LOUD miss).
 */
function runCli(deps = {}) {
  const write = deps.write || ((s) => process.stdout.write(s));
  const writeErr = deps.writeErr || ((s) => process.stderr.write(s));

  // Parse --apply from process.argv via the SHARED structured-argv flags helper
  // (never a raw-string match) when not explicitly injected.
  let apply = deps.apply;
  if (apply === undefined) {
    const parsed = parseCommand(['ruleset-drift'].concat(process.argv.slice(2)).join(' '));
    apply = hasFlag(parsed, ['--apply']);
  }

  const r = runRulesetDrift(Object.assign({}, deps, { apply }));

  if (r.error) {
    writeErr(
      '⚠ ruleset-drift: could NOT compute declared-vs-live drift (advisory fails LOUD, NOT "no drift"): ' +
        r.error +
        '\n'
    );
    return 1;
  }

  write('ruleset-drift — advisory declared (.github/rulesets/) vs live branch-protection drift (read-only)\n\n');

  if (r.inSync) {
    write('  ✓ declared rulesets are in sync with the live state — no drift.\n');
    if (r.apply) {
      write('  (--apply: nothing to remediate — no drift.)\n');
    }
    return 0;
  }

  write('  ⚠ drift detected (declared vs live):\n');
  for (const d of r.drift) {
    write(
      '      [' + d.name + '] ' + d.field + ': declared=' + JSON.stringify(d.declared) + ' live=' + JSON.stringify(d.live) + '\n'
    );
  }
  write('\n  remediation — the LIVE gsd-core scripts (NOT reimplemented here, run from the gsd-core root):\n');
  for (const cmd of r.remediation) {
    write('      ' + cmd + '\n');
  }
  if (r.applied) {
    write('\n  --apply: the LIVE remediation scripts were invoked (sync-rulesets.sh + setup-branch-protection.sh).\n');
  } else {
    write('\n  (advisory only — pass --apply to run the LIVE remediation scripts above.)\n');
  }

  // Advisory: a clean read that surfaced drift is still a successful advisory run (exit 0).
  // Only a FAILED read (LOUD error above) exits nonzero.
  return 0;
}

if (require.main === module) {
  process.exit(runCli());
}

module.exports = {
  runRulesetDrift,
  runCli,
  diffRulesets,
  normalizeRuleset,
  buildRemediation,
  defaultReadDeclared,
  defaultFetchLive,
  RULESETS_DIR_REL,
  SYNC_RULESETS_REL,
  SETUP_BRANCH_PROTECTION_REL,
  REPO,
};
