#!/usr/bin/env node
'use strict';

/**
 * bin/verdict-stats.cjs — OBS-03, the read side of the verdict log (ADVISORY).
 *
 * ADVISORY, MAINTAINER-INVOKED reader. Read-only: it opens the JSONL and prints; it never writes,
 * never rotates, and returns no verdict of its own.
 *
 * OBS-02 made every gate decision recordable. This answers the question the observability design
 * note names as L1 — *which of the blocking gates has ever denied anything real, and which has
 * never fired at all?* — which is the question a convention refresh or a gate audit starts from,
 * and which was previously answered by hand-reading source.
 *
 * ── WHY A "NEVER FIRED" COLUMN MATTERS MORE THAN A DENY COUNT ─────────────────────────────────
 * A gate that has never denied anything is not necessarily useless — it may be guarding a rare
 * event correctly. But it IS unproven in production, and that is worth seeing explicitly rather
 * than inferring from silence. This tool reports both, and deliberately does NOT rank gates or
 * emit a score.
 *
 * ── EXPLICITLY NOT A KPI DASHBOARD (Goodhart) ─────────────────────────────────────────────────
 * The moment "denies per gate" becomes a target, gates get tuned to produce denies. The output is
 * a flat census with no ranking, no "health" number, and no trend line. It is an input to a human
 * decision, not a metric to optimise.
 *
 * ── HONEST CAVEAT, PRINTED IN THE OUTPUT ──────────────────────────────────────────────────────
 * The log includes records written by the toolkit's own tests and by synthetic hook invocations
 * (development churn), which inflate counts and skew the mix. The header states the window and
 * says so, because a census presented without that caveat reads as production truth.
 *
 * @module bin/verdict-stats
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * The set of gate action names that COULD appear, DERIVED from the canonical hook sources rather
 * than hand-listed. A second hand-maintained list is exactly the drift defect bin/convention-drift
 * exists to catch — so this reads the one `action: '<name>'` literal each gate passes to runGate
 * (the same ctx literal that carries `command:`), which is the authoritative source.
 *
 * @param {object} [deps]
 * @returns {string[]} sorted gate action names.
 */
function discoverGateActions(deps = {}) {
  const readDir = deps.readDir || ((d) => fs.readdirSync(d));
  const readFile = deps.readFile || ((p) => fs.readFileSync(p, 'utf8'));
  const hooksDir = deps.hooksDir || path.join(__dirname, '..', 'hooks');
  const out = new Set();
  let names = [];
  try {
    names = readDir(hooksDir).filter((f) => f.endsWith('.cjs') && !f.endsWith('.test.cjs'));
  } catch (_) {
    return [];
  }
  const re = /command: safe(?:Command|FilePath)\(stdinString\),\s*(?:\/\/[^\n]*\n\s*)*action: '([a-z0-9-]+)'/g;
  for (const f of names) {
    let text = '';
    try {
      text = readFile(path.join(hooksDir, f));
    } catch (_) {
      continue;
    }
    let m;
    while ((m = re.exec(text)) !== null) out.add(m[1]);
  }
  return [...out].sort();
}

/** Resolve the log dir the same way tool-recorder does (GSD_CONTRIB_LOG_DIR, else ~/.gsd-contrib). */
function resolveLogDir(env = process.env) {
  const o = env.GSD_CONTRIB_LOG_DIR;
  if (typeof o === 'string' && o.trim().length > 0) return o.trim();
  return path.join(os.homedir(), '.gsd-contrib');
}

/**
 * Read gate-verdict records. Malformed lines are SKIPPED and counted, never silently dropped —
 * a reader that hides how much it could not parse is the same defect class this log exists to fix.
 *
 * @param {object} [deps]
 * @returns {{records:Array, skipped:number, files:string[]}}
 */
function readVerdicts(deps = {}) {
  const readFile = deps.readFile || ((p) => fs.readFileSync(p, 'utf8'));
  const exists = deps.exists || ((p) => fs.existsSync(p));
  const dir = deps.logDir || resolveLogDir(deps.env || process.env);
  const files = ['tool-log.1.jsonl', 'tool-log.jsonl']
    .map((f) => path.join(dir, f))
    .filter((p) => exists(p));

  const records = [];
  let skipped = 0;
  for (const f of files) {
    let text = '';
    try {
      text = readFile(f);
    } catch (_) {
      skipped += 1;
      continue;
    }
    for (const line of String(text).split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        if (r && r.source === 'pretooluse-gate') records.push(r);
      } catch (_) {
        skipped += 1;
      }
    }
  }
  return { records, skipped, files };
}

/**
 * Build the census. Pure.
 *
 * @param {Array} records
 * @param {string[]} [knownGates] every gate that COULD fire — so "never fired" is reported by
 *   absence from the log, not merely omitted from the table.
 * @returns {{perGate:Array, totals:object, window:{from:string|null,to:string|null}, sessions:number}}
 */
function buildCensus(records, knownGates) {
  if (!Array.isArray(knownGates)) knownGates = discoverGateActions();
  const per = new Map();
  for (const g of knownGates) per.set(g, { gate: g, allow: 0, deny: 0, ask: 0, total: 0, maxMs: 0 });

  let from = null;
  let to = null;
  const sessions = new Set();

  for (const r of records) {
    const g = r.gate || '(unknown)';
    if (!per.has(g)) per.set(g, { gate: g, allow: 0, deny: 0, ask: 0, total: 0, maxMs: 0 });
    const row = per.get(g);
    const d = r.decision === 'allow' || r.decision === 'ask' ? r.decision : 'deny';
    row[d] += 1;
    row.total += 1;
    if (typeof r.duration_ms === 'number' && r.duration_ms > row.maxMs) row.maxMs = r.duration_ms;
    if (typeof r.ts === 'string') {
      if (from === null || r.ts < from) from = r.ts;
      if (to === null || r.ts > to) to = r.ts;
    }
    if (r.session_id) sessions.add(r.session_id);
  }

  const perGate = [...per.values()].sort((a, b) => a.gate.localeCompare(b.gate));
  const totals = perGate.reduce(
    (acc, r) => {
      acc.allow += r.allow;
      acc.deny += r.deny;
      acc.ask += r.ask;
      acc.total += r.total;
      return acc;
    },
    { allow: 0, deny: 0, ask: 0, total: 0 }
  );
  return { perGate, totals, window: { from, to }, sessions: sessions.size };
}

/**
 * CLI. Exit 0 always — this is a reader, and "no data yet" is information, not a failure.
 *
 * @param {object} [deps]
 * @returns {number}
 */
function runCli(deps = {}) {
  const { records, skipped, files } = readVerdicts(deps);
  const c = buildCensus(records, deps.knownGates);
  const w = (s, n) => String(s).padEnd(n);

  process.stdout.write('verdict-stats — gate decision census (OBS-03, advisory, read-only)\n');
  if (files.length === 0) {
    process.stdout.write('  no verdict log found (' + resolveLogDir(deps.env || process.env) + ')\n');
    return 0;
  }
  process.stdout.write('  window : ' + (c.window.from || '—') + '  ->  ' + (c.window.to || '—') + '\n');
  process.stdout.write('  records: ' + c.totals.total + ' across ' + c.sessions + ' session(s)');
  process.stdout.write(skipped ? '  (' + skipped + ' unparseable, skipped)\n' : '\n');
  process.stdout.write(
    '  NOTE   : includes records from the toolkit\'s own tests and synthetic hook runs —\n' +
      '           development churn inflates counts. This is a census, NOT production truth,\n' +
      '           and deliberately carries no ranking or health score (Goodhart).\n\n'
  );

  process.stdout.write('  ' + w('gate', 26) + w('allow', 8) + w('deny', 7) + w('ask', 6) + w('slowest', 9) + '\n');
  process.stdout.write('  ' + '-'.repeat(56) + '\n');
  const never = [];
  for (const r of c.perGate) {
    if (r.total === 0) {
      never.push(r.gate);
      continue;
    }
    process.stdout.write(
      '  ' + w(r.gate, 26) + w(r.allow, 8) + w(r.deny, 7) + w(r.ask, 6) + w(r.maxMs + 'ms', 9) + '\n'
    );
  }
  process.stdout.write('\n  totals: ' + c.totals.allow + ' allow / ' + c.totals.deny + ' deny / ' + c.totals.ask + ' ask\n');

  if (never.length) {
    process.stdout.write(
      '\n  NEVER OBSERVED (' + never.length + '): ' + never.join(', ') + '\n' +
        '  A gate with no records is UNPROVEN in use, not necessarily useless — it may be\n' +
        '  guarding a rare event correctly. Worth seeing explicitly rather than inferring\n' +
        '  from silence.\n'
    );
  }
  return 0;
}

if (require.main === module && !process.env.NODE_TEST_CONTEXT) {
  process.exit(runCli());
}

module.exports = { readVerdicts, buildCensus, resolveLogDir, discoverGateActions, runCli };
