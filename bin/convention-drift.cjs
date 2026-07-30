#!/usr/bin/env node
'use strict';

/**
 * bin/convention-drift.cjs — CONV-01, the replicated-convention drift detector (ADVISORY).
 *
 * ADVISORY, MAINTAINER-INVOKED doer — NOT a PreToolUse deny gate. It returns NO
 * `permissionDecision`, is NOT registered in settings.snippet.json, and mutates nothing. It
 * mirrors the boundary and run-all/aggregate/exit-nonzero shape of its siblings
 * `bin/ruleset-drift.cjs`, `bin/release-preflight.cjs`, and `hooks/doctor.cjs`.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────────────────────────
 * The toolkit's governing rule is: CALL gsd-core's live scripts, never fork the policy. Most gates
 * honor that. A handful of things cannot be called and are therefore REPLICATED as local
 * constants — branch-name prefixes, the exempt lists, the POLICY-02 npm script names. Those
 * replicas are the toolkit's blind spot, logged as weakness H-A: `doctor.cjs` shape-checks live
 * SCRIPTS and `ruleset-drift.cjs` checks branch-protection RULESETS, but until now **nothing
 * checked the replicated CONVENTIONS**. A silent upstream change to any of them makes a gate
 * either over-block (a false deny against work that upstream accepts) or under-block.
 *
 * That is not hypothetical: measured 2026-07-30, the toolkit's 11 branch prefixes and both exempt
 * lists were byte-identical to `branch-naming.yml` — in sync, but by hand, with no mechanism
 * keeping them there.
 *
 * ── WHAT IT DOES *NOT* DO ─────────────────────────────────────────────────────────────────────
 * It is OFFLINE-first and reads only files in the two checkouts. It deliberately does not call
 * `gh api .../labels`: a detector that needs the network fails for a reason unrelated to drift,
 * and this repo has already been bitten by a check that could not run reporting a verdict anyway.
 * Label-convention drift stays a manual review item until it can be checked without a live call.
 *
 * ── SEVERITY IS NOT DRIFT ─────────────────────────────────────────────────────────────────────
 * Where the toolkit is deliberately STRICTER than upstream, that is a recorded narrowing, not
 * drift, and is reported as `[NOTE]` rather than `[FAIL]`. The branch rule is the live example:
 * upstream `branch-naming.yml` emits `core.warning` (non-blocking) while the toolkit DENIES. That
 * is intentional — the contribution skill mandates `fix/<issue#>-slug`, so for this pipeline a
 * non-conventional branch is a process error, and upstream only warns because it cannot hard-block
 * external contributors. The detector's job is to make sure the LIST stays in sync, not to erase
 * the deliberate difference in severity.
 *
 * @module bin/convention-drift
 */

const fs = require('node:fs');
const path = require('node:path');

const { resolveGsdCoreRoot } = require('../hooks/lib/resolve.cjs');
const resolveLib = require('../hooks/lib/resolve.cjs');
const { POLICY_CHECKS } = require('../hooks/policy-invariants.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const BRANCH_WORKFLOW = '.github/workflows/branch-naming.yml';

/**
 * Extract a JS string-array literal named `name` from a source text. `branch-naming.yml` embeds
 * its policy as an inline `actions/github-script` body, so the array is JS inside YAML — parsing
 * the YAML would just hand back the script as one string. Reading the literal directly is the
 * honest way to compare it, and a miss returns null (reported as a LOUD failure, never a silent
 * "in sync").
 *
 * @param {string} text
 * @param {string} name
 * @returns {string[]|null}
 */
function extractArrayLiteral(text, name) {
  const re = new RegExp(name + '\\s*=\\s*\\[([\\s\\S]*?)\\]');
  const m = re.exec(String(text || ''));
  if (!m) return null;
  const items = [];
  const itemRe = /'([^']*)'|"([^"]*)"/g;
  let it;
  while ((it = itemRe.exec(m[1])) !== null) items.push(it[1] !== undefined ? it[1] : it[2]);
  return items;
}

/** Set-equality for two string lists, order-insensitive. */
function sameSet(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  const A = new Set(a);
  const B = new Set(b);
  if (A.size !== B.size) return false;
  for (const v of A) if (!B.has(v)) return false;
  return true;
}

/** Format a symmetric difference for a human-readable detail line. */
function diffDetail(localList, liveList) {
  const L = new Set(localList || []);
  const R = new Set(liveList || []);
  const onlyLocal = [...L].filter((v) => !R.has(v));
  const onlyLive = [...R].filter((v) => !L.has(v));
  const parts = [];
  if (onlyLocal.length) parts.push('only in toolkit: ' + onlyLocal.join(', '));
  if (onlyLive.length) parts.push('only upstream: ' + onlyLive.join(', '));
  return parts.join(' | ') || 'sets differ';
}

/**
 * CHECK 1–3 — the branch-naming replicas: prefixes, exact exemptions, prefix exemptions.
 *
 * @param {string} root gsd-core root.
 * @param {object} [deps]
 * @returns {Array<{check:string, ok:boolean, note?:boolean, detail:string}>}
 */
function checkBranchReplicas(root, deps = {}) {
  const readFile = deps.readFile || ((p) => fs.readFileSync(p, 'utf8'));
  const local = deps.localConstants || resolveLib;
  const wfPath = path.join(root, BRANCH_WORKFLOW);
  let text;
  try {
    text = readFile(wfPath);
  } catch (err) {
    return [
      {
        check: 'branch-naming replicas',
        ok: false,
        detail:
          'LOUD failure: could not read the LIVE ' +
          BRANCH_WORKFLOW +
          ' (' +
          ((err && err.message) || String(err)) +
          ') — a replica that cannot be compared is NEVER reported in sync',
      },
    ];
  }

  const pairs = [
    ['branch prefixes', local.UPSTREAM_BRANCH_PREFIXES, extractArrayLiteral(text, 'validPrefixes')],
    ['branch exempt (exact)', local.BRANCH_EXEMPT_EXACT, extractArrayLiteral(text, 'alwaysValid')],
  ];

  const out = pairs.map(([label, mine, live]) => {
    if (live === null) {
      return {
        check: label,
        ok: false,
        detail: 'LOUD failure: could not locate the upstream literal in ' + BRANCH_WORKFLOW +
          ' — it may have been restructured; re-check by hand rather than trusting this run',
      };
    }
    return sameSet(mine, live)
      ? { check: label, ok: true, detail: 'in sync (' + live.length + ' entries)' }
      : { check: label, ok: false, detail: 'DRIFT — ' + diffDetail(mine, live) };
  });

  // The prefix-exemption list is expressed as `startsWith(...)` calls upstream, not an array, so
  // it is checked by membership rather than by literal extraction.
  const exemptPrefixes = local.BRANCH_EXEMPT_PREFIXES || [];
  const missing = exemptPrefixes.filter((p) => !text.includes("startsWith('" + p + "')"));
  out.push(
    missing.length === 0
      ? {
          check: 'branch exempt (prefix)',
          ok: true,
          detail: 'in sync (' + exemptPrefixes.length + ' entries present upstream)',
        }
      : {
          check: 'branch exempt (prefix)',
          ok: false,
          detail: 'DRIFT — the toolkit exempts prefixes upstream no longer does: ' + missing.join(', '),
        }
  );

  // Severity is a RECORDED narrowing, not drift — reported so it stays a conscious choice.
  out.push({
    check: 'branch severity',
    ok: true,
    note: true,
    detail: text.includes('core.warning')
      ? 'upstream WARNS (core.warning); the toolkit DENIES — a deliberate narrowing (the ' +
        'contribution skill mandates fix/<issue#>-slug). Not drift; recorded so it stays conscious.'
      : 'upstream no longer uses core.warning — the severity relationship changed; re-read ' +
        BRANCH_WORKFLOW + ' and decide deliberately',
  });

  return out;
}

/**
 * CHECK 4 — the POLICY-02 npm script names still exist in gsd-core's package.json.
 *
 * `policy-invariants.cjs` runs these BY NAME. A renamed script upstream turns every governed
 * commit/pr-create into a fail-closed deny naming a script nobody can find — a self-inflicted
 * outage the moment upstream renames something. This is the cheapest possible early warning.
 *
 * @param {string} root
 * @param {object} [deps]
 * @returns {{check:string, ok:boolean, detail:string}}
 */
function checkPolicyScriptNames(root, deps = {}) {
  const readFile = deps.readFile || ((p) => fs.readFileSync(p, 'utf8'));
  const names = (deps.policyChecks || POLICY_CHECKS).map((c) => c.name);
  try {
    const pkg = JSON.parse(readFile(path.join(root, 'package.json')));
    const scripts = (pkg && pkg.scripts) || {};
    const missing = names.filter((n) => !Object.prototype.hasOwnProperty.call(scripts, n));
    return missing.length === 0
      ? { check: 'POLICY-02 script names', ok: true, detail: 'all ' + names.length + ' present in gsd-core package.json' }
      : {
          check: 'POLICY-02 script names',
          ok: false,
          detail:
            'DRIFT — policy-invariants calls npm script(s) that no longer exist upstream: ' +
            missing.join(', ') +
            ' (every governed commit/pr-create would fail closed)',
        };
  } catch (err) {
    return {
      check: 'POLICY-02 script names',
      ok: false,
      detail: 'LOUD failure: could not read gsd-core package.json — ' + ((err && err.message) || String(err)),
    };
  }
}

/**
 * CHECK 5 — capability VERSION ROT (the backlog's #8).
 *
 * `build-capability.cjs` stamps `deps.version || manifest.version`, so rebuilding without an
 * explicit `--version` re-stamps the EXISTING version onto NEW content. Two different bundles can
 * therefore both call themselves the same version.
 *
 * Measured 2026-07-30, this is not hypothetical: the manifest read `2.1.3` while the repo had
 * shipped through tag `v2.7`. Reported as a NOTE rather than a failure — for a private toolkit
 * nothing consumes the version yet, so this is a "know before you publish" signal, not a red.
 *
 * @param {object} [deps]
 * @returns {{check:string, ok:boolean, note?:boolean, detail:string}}
 */
function checkVersionRot(deps = {}) {
  const readFile = deps.readFile || ((p) => fs.readFileSync(p, 'utf8'));
  const listTags = deps.listTags || defaultListTags;
  try {
    const manifest = JSON.parse(
      readFile(path.join(REPO_ROOT, 'capabilities', 'contribution-toolkit', 'capability.json'))
    );
    const version = String(manifest.version || '');
    const tags = listTags();
    if (!tags.length) {
      return { check: 'capability version', ok: true, note: true, detail: 'no tags yet — nothing to compare' };
    }
    const latest = tags[tags.length - 1];
    const normalized = latest.replace(/^v/, '');
    if (version === normalized || version.startsWith(normalized)) {
      return { check: 'capability version', ok: true, detail: 'manifest ' + version + ' matches latest tag ' + latest };
    }
    return {
      check: 'capability version',
      ok: true,
      note: true,
      detail:
        'manifest version ' + version + ' predates the latest tag ' + latest +
        ' — build-capability re-stamps `deps.version || manifest.version`, so rebuilds since then ' +
        'shipped NEW content under the SAME version. Pass an explicit --version before publishing.',
    };
  } catch (err) {
    return { check: 'capability version', ok: false, detail: 'LOUD failure: ' + ((err && err.message) || String(err)) };
  }
}

/** Default git tag lister (sorted by version). Returns [] when git is unavailable. */
function defaultListTags() {
  try {
    const { execFileSync } = require('node:child_process');
    const out = execFileSync('git', ['tag', '--sort=v:refname'], { cwd: REPO_ROOT, encoding: 'utf8' });
    return String(out).split('\n').map((s) => s.trim()).filter(Boolean);
  } catch (_) {
    return [];
  }
}

/**
 * Run every check. NO fail-fast — the maintainer sees the whole picture (D-06), and a check that
 * could not run is a FAILURE, never a silent pass.
 *
 * @param {object} [deps]
 * @returns {{ok:boolean, results:Array, error?:string}}
 */
function runConventionDrift(deps = {}) {
  let root = deps.gsdCoreRoot;
  if (!root) {
    const resolveRoot = deps.resolveRoot || ((d) => resolveGsdCoreRoot(d));
    try {
      root = resolveRoot(process.cwd());
    } catch (err) {
      return {
        ok: false,
        results: [],
        error:
          'could not resolve a gsd-core checkout (run from inside one, or set GSD_CORE_ROOT): ' +
          ((err && err.message) || String(err)),
      };
    }
  }
  const results = [
    ...checkBranchReplicas(root, deps),
    checkPolicyScriptNames(root, deps),
    checkVersionRot(deps),
  ];
  return { ok: results.every((r) => r.ok), results, root };
}

/**
 * CLI: print one line per check, exit 0 iff every check passed. Notes never fail the run.
 *
 * @param {object} [deps]
 * @returns {number}
 */
function runCli(deps = {}) {
  const r = runConventionDrift(deps);
  process.stdout.write('convention-drift — the toolkit\'s REPLICATED conventions vs LIVE gsd-core (CONV-01, advisory)\n');
  if (r.error) {
    process.stderr.write('  [FAIL] ' + r.error + '\n');
    return 1;
  }
  process.stdout.write('  gsd-core: ' + r.root + '\n\n');
  for (const c of r.results) {
    const tag = c.note ? 'NOTE' : c.ok ? 'PASS' : 'FAIL';
    process.stdout.write('  [' + tag + '] ' + c.check + '\n         ' + c.detail + '\n');
  }
  const fails = r.results.filter((c) => !c.ok).length;
  process.stdout.write(
    '\n' +
      (fails === 0
        ? 'No convention drift detected. (Replicas are compared, not assumed — a replica that could not be read FAILS.)\n'
        : fails + ' replicated convention(s) DRIFTED from upstream — a gate may now over- or under-block.\n')
  );
  return fails === 0 ? 0 : 1;
}

if (require.main === module && !process.env.NODE_TEST_CONTEXT) {
  process.exit(runCli());
}

module.exports = {
  runConventionDrift,
  runCli,
  checkBranchReplicas,
  checkPolicyScriptNames,
  checkVersionRot,
  extractArrayLiteral,
  sameSet,
  BRANCH_WORKFLOW,
};
