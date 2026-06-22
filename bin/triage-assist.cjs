#!/usr/bin/env node
'use strict';

/**
 * bin/triage-assist.cjs — OWN-01 maintainer triage assist (ADVISORY, not a deny gate).
 *
 * Given an incoming gsd-core issue (number/title/body/labels) this CLI:
 *   1. resolves + calls LIVE `scripts/issue-dedupe.cjs` (`scoreCandidates`) against the
 *      open-issue candidate list to surface a likely-duplicate signal (#numbers + score);
 *   2. resolves + calls LIVE `scripts/issue-version-gate.cjs` (`evaluateVersionGate`) to
 *      surface a missing/invalid version finding for bug reports;
 *   3. suggests ONE canonical triage role read ONLY from LIVE `docs/agents/triage-labels.md`
 *      (the 5-role table) + the LIVE script output — NO toolkit-side heuristic role logic
 *      (D-07 / HARD-02); and
 *   4. prints the EXACT `gh` remediation command STRINGS (apply the role label, strip
 *      `needs-triage`) for the maintainer to run.
 *
 * ADVISORY boundary (mirrors hooks/preflight-shipped-paths.cjs): it returns NO permission
 * verdict (no allow/deny), is NOT registered in settings.snippet.json, and is NOT a PreToolUse
 * gate. It NEVER mutates GitHub by default — any mutation (label apply / needs-triage strip)
 * is reachable ONLY behind an explicit `--apply` flag, parsed via the shared structured-argv
 * flags helper (never a raw-string match), behind an injectable `mutate` seam.
 *
 * FAILS LOUD: a missing/unloadable LIVE dedupe script, version-gate script, or triage-labels
 * source returns an explicit `error` (and writes to stderr) — NEVER a false
 * no-duplicate/clean/role-suggested verdict (HARD-02). All subprocess calls use no-shell
 * `execFileSync` with explicit argv arrays — attacker-influenced issue content is passed as
 * DATA to the LIVE pure functions, never interpolated into a shell (T-08-01-INJ).
 *
 * @module bin/triage-assist
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { resolveGsdCoreRoot, requireLiveScript } = require('../hooks/lib/resolve.cjs');

const DEDUPE_REL = 'scripts/issue-dedupe.cjs';
const VERSION_GATE_REL = 'scripts/issue-version-gate.cjs';
const TRIAGE_LABELS_REL = 'docs/agents/triage-labels.md';

// The repo string the remediation `gh` commands target (open-gsd/gsd-core).
const REPO = 'open-gsd/gsd-core';
// The auto-applied label every new issue carries; removed on any state transition
// (per LIVE triage-labels.md). The strip is SURFACED, never auto-run without --apply.
const NEEDS_TRIAGE_LABEL = 'needs-triage';

/**
 * Parse the canonical triage roles from the LIVE `docs/agents/triage-labels.md`
 * markdown table. The roles live in the first column as `\`role\`` backtick-wrapped
 * tokens. This reads the LIVE source verbatim — it does NOT compute or invent any
 * role (D-07). Returns the roles in table order.
 *
 * @param {string} markdown raw contents of triage-labels.md
 * @returns {string[]} canonical role names (e.g. ['needs-triage','needs-info',...])
 */
function parseRolesFromTriageLabels(markdown) {
  if (typeof markdown !== 'string' || markdown.length === 0) return [];
  const roles = [];
  const seen = new Set();
  for (const line of markdown.split(/\r?\n/)) {
    // Only consider table rows: `| `role` | ... |`
    const m = /^\s*\|\s*`([a-z][a-z0-9-]*)`\s*\|/.exec(line);
    if (!m) continue;
    const role = m[1];
    if (seen.has(role)) continue;
    seen.add(role);
    roles.push(role);
  }
  return roles;
}

/**
 * Default LIVE-script loaders — require() the LIVE module via the resolver. ANY
 * failure throws a ScriptResolveError (no vendored fallback) which the orchestrator
 * catches and surfaces LOUD.
 *
 * @param {string} root absolute gsd-core root.
 */
function defaultLoadDedupe(root) {
  return requireLiveScript(root, DEDUPE_REL);
}
function defaultLoadVersionGate(root) {
  return requireLiveScript(root, VERSION_GATE_REL);
}

/**
 * Default LIVE role-source reader — read the LIVE triage-labels.md from the resolved
 * root. A miss throws (ENOENT) → surfaced LOUD, never a guessed role.
 *
 * @param {string} root absolute gsd-core root.
 * @returns {string} raw markdown
 */
function defaultReadRoleSource(root) {
  return fs.readFileSync(path.join(root, TRIAGE_LABELS_REL), 'utf8');
}

/**
 * Default candidate fetcher — list OPEN issues via no-shell `gh` for the dedupe scorer.
 * Issue content is NEVER interpolated into a shell: explicit argv array, no `shell:true`
 * (T-08-01-INJ). Returns [{number,title}].
 *
 * @param {string} root absolute gsd-core root (cwd for the gh call).
 * @returns {{number:number,title:string}[]}
 */
function defaultFetchCandidates(root) {
  const raw = execFileSync(
    'gh',
    ['issue', 'list', '--repo', REPO, '--state', 'open', '--limit', '200', '--json', 'number,title'],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  );
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [];
}

/**
 * Default mutate seam — apply the chosen role label + strip `needs-triage` via no-shell
 * `gh`. Reachable ONLY with --apply. Explicit argv, no shell interpolation.
 *
 * @param {{root:string, issueNumber:number, applyLabel:string}} args
 */
function defaultMutate({ root, issueNumber, applyLabel }) {
  execFileSync(
    'gh',
    ['issue', 'edit', String(issueNumber), '--repo', REPO, '--add-label', applyLabel, '--remove-label', NEEDS_TRIAGE_LABEL],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  );
}

/**
 * Map the LIVE script output → ONE canonical role drawn from the LIVE-sourced role
 * set. This is NOT a heuristic role classifier: it only ROUTES to a role that already
 * exists in the LIVE triage-labels.md table, using the LIVE script verdicts as the
 * routing key (D-07). If a routed role is not in the LIVE set, it is dropped (never
 * invented). A bug missing a version → the "waiting on reporter" role (needs-info);
 * a likely duplicate → 'possible-duplicate' when the LIVE table carries it; otherwise
 * the first canonical role ('needs-triage') as the explicit "still needs a human call".
 *
 * @param {object} ctx
 * @param {string[]} ctx.roles canonical roles from the LIVE source (table order)
 * @param {{action:string,reason:string}} ctx.versionGate LIVE evaluateVersionGate result
 * @param {{likelyDuplicate:boolean}} ctx.dedupe
 * @returns {string|null} a role from `roles`, or null if none applies
 */
function routeRole({ roles, versionGate, dedupe }) {
  const has = (r) => roles.includes(r);
  // A bug auto-closed for a missing/invalid version routes to the reporter-waiting role.
  if (versionGate && versionGate.action === 'close') {
    if (has('needs-info')) return 'needs-info';
  }
  // A likely-duplicate routes to the LIVE duplicate role when the table carries it.
  if (dedupe && dedupe.likelyDuplicate && has('possible-duplicate')) {
    return 'possible-duplicate';
  }
  // Otherwise the issue still needs a human triage call — surface the canonical
  // needs-triage role (first in the table) explicitly, never an invented value.
  if (has('needs-triage')) return 'needs-triage';
  return roles.length > 0 ? roles[0] : null;
}

/**
 * Build the exact `gh` remediation command STRINGS the maintainer can run. These are
 * SURFACED strings, not executed (mutation runs only via --apply through the seam).
 *
 * @param {{issueNumber:number, applyLabel:string}} args
 * @returns {string[]}
 */
function buildRemediation({ issueNumber, applyLabel }) {
  return [
    `gh issue edit ${issueNumber} --repo ${REPO} --add-label '${applyLabel}'`,
    `gh issue edit ${issueNumber} --repo ${REPO} --remove-label '${NEEDS_TRIAGE_LABEL}'`,
  ];
}

/**
 * The advisory orchestrator. Resolves the gsd-core root, loads BOTH LIVE scripts +
 * the LIVE role source, runs the dedupe + version-gate, routes a canonical role, and
 * surfaces the `gh` remediation. On ANY resolve/load/read failure it returns an
 * explicit `error` and NO clean/role verdict (LOUD on miss). Mutation runs only when
 * `apply` is set, through the injectable `mutate` seam.
 *
 * All impure operations are injectable seams for hermetic tests.
 *
 * @param {object} [deps]
 * @param {string} [deps.gsdCoreRoot] absolute gsd-core root (default: resolved from cwd).
 * @param {{number:number,title:string,body:string,labels:Array}} [deps.issue] the issue input.
 * @param {(root:string)=>object} [deps.loadDedupe] LIVE issue-dedupe loader.
 * @param {(root:string)=>object} [deps.loadVersionGate] LIVE issue-version-gate loader.
 * @param {(root:string)=>Array} [deps.fetchCandidates] open-issue candidate fetcher.
 * @param {(root:string)=>string} [deps.readRoleSource] LIVE triage-labels.md reader.
 * @param {(args:object)=>void} [deps.mutate] the GitHub mutate seam (only fired with apply).
 * @param {boolean} [deps.apply] whether to perform the mutation (default false).
 * @returns {object} structured advisory result (or {error} on a LOUD miss).
 */
function runTriageAssist(deps = {}) {
  let root = deps.gsdCoreRoot;
  try {
    if (!root) root = resolveGsdCoreRoot(process.cwd());
  } catch (err) {
    return { error: 'could not resolve gsd-core root: ' + (err && err.message) };
  }

  const issue = deps.issue || {};
  const loadDedupe = deps.loadDedupe || defaultLoadDedupe;
  const loadVersionGate = deps.loadVersionGate || defaultLoadVersionGate;
  const fetchCandidates = deps.fetchCandidates || defaultFetchCandidates;
  const readRoleSource = deps.readRoleSource || defaultReadRoleSource;
  const mutate = deps.mutate || defaultMutate;
  const apply = deps.apply === true;

  // --- LIVE dedupe (LOUD on miss) ---
  let dedupeMod;
  try {
    dedupeMod = loadDedupe(root);
  } catch (err) {
    return { error: 'LIVE issue-dedupe.cjs failed to load: ' + ((err && err.message) || 'unknown') };
  }

  // --- LIVE version-gate (LOUD on miss) ---
  let versionGateMod;
  try {
    versionGateMod = loadVersionGate(root);
  } catch (err) {
    return { error: 'LIVE issue-version-gate.cjs failed to load: ' + ((err && err.message) || 'unknown') };
  }

  // --- LIVE role source (LOUD on miss — never a guessed role) ---
  let roles;
  try {
    roles = parseRolesFromTriageLabels(readRoleSource(root));
  } catch (err) {
    return { error: 'LIVE docs/agents/triage-labels.md could not be read: ' + ((err && err.message) || 'unknown') };
  }
  if (!Array.isArray(roles) || roles.length === 0) {
    return { error: 'LIVE docs/agents/triage-labels.md yielded no canonical roles (fail LOUD, never a guessed role)' };
  }

  // --- candidate list for dedupe (LOUD on miss) ---
  let candidates;
  try {
    candidates = fetchCandidates(root);
  } catch (err) {
    return { error: 'could not fetch the open-issue candidate list: ' + ((err && err.message) || 'unknown') };
  }

  // --- run LIVE dedupe (pure) ---
  let scored;
  try {
    const threshold = dedupeMod.DEFAULT_THRESHOLD != null ? dedupeMod.DEFAULT_THRESHOLD : 0.6;
    scored = dedupeMod.scoreCandidates(issue.title, candidates, {
      threshold,
      excludeNumber: issue.number,
    });
  } catch (err) {
    return { error: 'LIVE scoreCandidates threw: ' + ((err && err.message) || 'unknown') };
  }
  const dedupe = {
    likelyDuplicate: Array.isArray(scored) && scored.length > 0,
    candidates: Array.isArray(scored) ? scored : [],
  };

  // --- run LIVE version-gate (pure) ---
  let versionGate;
  try {
    versionGate = versionGateMod.evaluateVersionGate({ labels: issue.labels, body: issue.body });
  } catch (err) {
    return { error: 'LIVE evaluateVersionGate threw: ' + ((err && err.message) || 'unknown') };
  }

  // --- route ONE canonical role from the LIVE-sourced set ---
  const suggestedRole = routeRole({ roles, versionGate, dedupe });

  // --- surface the gh remediation strings (never executed by default) ---
  const remediation = buildRemediation({ issueNumber: issue.number, applyLabel: suggestedRole });

  // --- mutation: reachable ONLY with --apply, through the injectable seam ---
  let mutated = false;
  if (apply) {
    try {
      mutate({ root, issueNumber: issue.number, applyLabel: suggestedRole });
    } catch (err) {
      // A gh failure (auth/network/bad issue number) must surface as the clean
      // LOUD error path, never a raw stack trace (WR-02).
      return { error: '--apply mutation failed (gh error): ' + ((err && err.message) || String(err)) };
    }
    mutated = true;
  }

  return {
    root,
    issue: { number: issue.number, title: issue.title },
    dedupe,
    versionGate,
    suggestedRole,
    roleSource: roles,
    remediation,
    mutated,
    apply,
  };
}

/**
 * CLI surface: run the advisory assist, print the findings to stdout, write a LOUD
 * error to stderr on a LIVE-script miss (never a false clean), and return an exit
 * code. There is NO permission verdict returned — this is advisory, not a gate.
 *
 * @param {object} [deps] same seams as runTriageAssist, plus:
 * @param {(s:string)=>void} [deps.write] stdout writer.
 * @param {(s:string)=>void} [deps.writeErr] stderr writer.
 * @returns {number} exit code (0 on a clean advisory run, 1 on a LOUD miss).
 */
function runCli(deps = {}) {
  const write = deps.write || ((s) => process.stdout.write(s));
  const writeErr = deps.writeErr || ((s) => process.stderr.write(s));

  // Detect --apply from the ALREADY-tokenized process.argv when not explicitly
  // injected. `process.argv` elements are discrete shell tokens, so `--apply`
  // is present ONLY when the user actually typed it as a standalone flag — a
  // positional argument whose text merely contains `--apply` does NOT re-tokenize
  // into a real flag (the prior join-then-parseCommand idiom false-positived
  // here, defeating the mutation guard — CR-01).
  let apply = deps.apply;
  if (apply === undefined) {
    apply = process.argv.slice(2).includes('--apply');
  }

  const r = runTriageAssist(Object.assign({}, deps, { apply }));

  if (r.error) {
    writeErr(
      '⚠ triage-assist: could NOT produce a triage verdict (advisory fails LOUD, NOT clean): ' +
        r.error +
        '\n'
    );
    return 1;
  }

  write('triage-assist — advisory LIVE-backed first triage (no GitHub mutation without --apply)\n');
  write('  issue: #' + r.issue.number + ' — ' + r.issue.title + '\n\n');

  if (r.dedupe.likelyDuplicate) {
    write('  ⚠ likely duplicate (LIVE issue-dedupe.cjs):\n');
    for (const c of r.dedupe.candidates) {
      write('      #' + c.number + ' — ' + c.title + ' (' + Math.round(c.score * 100) + '%)\n');
    }
  } else {
    write('  ✓ no open issue scored at/above the LIVE dedupe threshold.\n');
  }

  // Guard the LIVE version-gate result: if the LIVE script returned null/undefined
  // or a shape without `action` (shape drift WITHOUT throwing), render a safe line
  // rather than crashing with a raw TypeError (WR-01).
  const vg = r.versionGate;
  write(
    '  version-gate (LIVE issue-version-gate.cjs): ' +
      (vg ? (vg.action || '?') + ' — ' + (vg.reason || '(no reason)') : 'no result returned') +
      '\n'
  );
  write('  suggested role (from LIVE docs/agents/triage-labels.md): ' + r.suggestedRole + '\n\n');

  write('  remediation — run these to apply the role + strip ' + NEEDS_TRIAGE_LABEL + ' (NOT auto-run):\n');
  for (const cmd of r.remediation) {
    write('      ' + cmd + '\n');
  }
  if (r.mutated) {
    write('\n  --apply: the role label was applied and ' + NEEDS_TRIAGE_LABEL + ' stripped.\n');
  } else {
    write('\n  (advisory only — pass --apply to perform the label apply / strip.)\n');
  }

  return 0;
}

if (require.main === module) {
  process.exit(runCli());
}

module.exports = {
  runTriageAssist,
  runCli,
  parseRolesFromTriageLabels,
  routeRole,
  buildRemediation,
  DEDUPE_REL,
  VERSION_GATE_REL,
  TRIAGE_LABELS_REL,
  NEEDS_TRIAGE_LABEL,
  REPO,
};
