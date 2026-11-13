#!/usr/bin/env node
'use strict';

/**
 * bin/claims-delta.cjs — lists every sentence a fix round added, flags the rule-shaped ones, and
 * (with --gate) refuses while one is unresolved (quick 261113-cde, PROPOSAL item 3).
 *
 *   node bin/claims-delta.cjs <A..B | A...B> --dir DIR [--repo R] [--body-old F --body-new F | --no-body REASON]
 *                             [--policy P --policy-reason TEXT] [--gate]
 *
 * Exit 0 = report written (gate: clean of unresolved rule-shaped claims), 1 = gate refused or any doubt
 * (bad policy, bad resolutions, git failure, nothing examined), 2 = usage (nothing is written).
 * ADVISORY AND MODEL-RUN: this is not a PreToolUse hook. It reads files and runs read-only git verbs
 * with argv arrays (no shell); it writes only DIR/CLAIMS-DELTA.md.
 *
 * Sources: added code comments, test titles, ADR lines, other added markdown, commit messages in the
 * range, and PR body lines (new body minus old body). Rule-shaped = matches a pattern of
 * bin/claims-delta.policy.json (policy data, tunable). Resolved = a CLAIMS-RESOLUTIONS.json entry in
 * DIR: kind oracle|generator with new_inputs >= minNewInputs, a tracked non-empty evidence file inside
 * the repo and a command; or kind not-a-rule with a 15+ char reason. A weakened rewrite needs no
 * entry: the delta is recomputed, so a rewritten sentence is judged afresh.
 *
 * WHAT THIS DOES NOT PROVE: new_inputs is self-reported (the evidence file is checked to exist, not to
 * produce that many inputs, nor that none came from a review round). Wording with no trigger word is
 * unseen. Not covered: a test title on a line after its call, assert and Error messages, removed
 * qualifiers (the reverse of the #5119 failure), and a sentence wrapped in a fenced block.
 *
 * @module bin/claims-delta
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const SHIPPED_POLICY = path.join(__dirname, 'claims-delta.policy.json');
const REQUIRED_PATTERNS = ['quantifier', 'negated', 'definitional', 'scope-negation'];
const SLASH_EXT = new Set(['.js', '.cjs', '.mjs', '.ts', '.cts', '.mts', '.jsx', '.tsx']);
const HASH_EXT = new Set(['.sh', '.py', '.yml', '.yaml', '.rb', '.toml']);
const NOT_COVERED = [
  'a test title on a line after its call',
  'assert and Error messages',
  'removed qualifiers (a deleted "unless" leaves the rest of the sentence absolute)',
  'wording with no trigger word',
  'a sentence wrapped in a fenced block',
];

class Usage extends Error {}
class Refuse extends Error {}

function parseArgs(argv) {
  const o = { gate: false };
  const valued = { '--dir': 'dir', '--repo': 'repo', '--body-old': 'bodyOld', '--body-new': 'bodyNew', '--no-body': 'noBody', '--policy': 'policy', '--policy-reason': 'policyReason' };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--gate') o.gate = true;
    else if (valued[a]) {
      if (i + 1 >= argv.length) throw new Usage(`${a} needs a value`);
      o[valued[a]] = argv[(i += 1)];
    } else if (a.startsWith('-')) throw new Usage(`unknown argument ${a}`);
    else rest.push(a);
  }
  if (rest.length !== 1) throw new Usage('exactly one range (A..B or A...B) is required');
  if (!/^[^\s-][^\s]*?\.\.\.?[^\s]+$/.test(rest[0])) throw new Usage('range must look like A..B or A...B');
  if (!o.dir || !fs.existsSync(o.dir) || !fs.statSync(o.dir).isDirectory()) throw new Usage('--dir must be an existing directory');
  if ((o.bodyOld === undefined) !== (o.bodyNew === undefined)) throw new Usage('--body-old and --body-new go together');
  o.range = rest[0];
  o.repo = path.resolve(o.repo || process.cwd());
  return o;
}

function git(repo, args) {
  const env = { ...process.env };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete env[k];
  try {
    return execFileSync('git', ['-C', repo, '-c', 'core.quotepath=false', ...args], { encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    throw new Refuse(`git ${args[0]} failed: ${String(e.stderr || e.message).trim().split('\n')[0]}`);
  }
}

function loadPolicy(o) {
  const file = o.policy ? path.resolve(o.policy) : SHIPPED_POLICY;
  if (o.policy && String(o.policyReason || '').trim().length < 15) throw new Refuse('--policy needs --policy-reason of 15+ characters (a policy override is a logged, reasoned act)');
  let raw;
  let pol;
  try { raw = fs.readFileSync(file); pol = JSON.parse(raw.toString('utf8')); } catch (e) { throw new Refuse(`policy unreadable: ${e.message}`); }
  if (!pol || !Array.isArray(pol.patterns) || pol.patterns.length === 0) throw new Refuse('policy has no patterns');
  for (const id of REQUIRED_PATTERNS) if (!pol.patterns.some((p) => p && p.id === id)) throw new Refuse(`policy lacks required pattern ${id}`);
  if (!Number.isInteger(pol.minNewInputs) || pol.minNewInputs < 1) throw new Refuse('policy minNewInputs must be an integer >= 1');
  const max = Number.isInteger(pol.maxSentenceChars) && pol.maxSentenceChars > 0 ? pol.maxSentenceChars : 2000;
  const patterns = pol.patterns.map((p) => {
    try { return { id: p.id, re: new RegExp(p.regex, p.flags || 'i') }; } catch (e) { throw new Refuse(`policy pattern ${p && p.id} invalid: ${e.message}`); }
  });
  return { patterns, minNewInputs: pol.minNewInputs, max, info: { path: file, sha1: crypto.createHash('sha1').update(raw).digest('hex'), reason: o.policyReason || null, minNewInputs: pol.minNewInputs } };
}

const ascii = (s) => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
const norm = (s) => ascii(s).replace(/\s+/g, ' ').trim().toLowerCase();
const claimId = (s) => crypto.createHash('sha1').update(norm(s)).digest('hex').slice(0, 12);

/** Added lines per file from `git diff -U0`: [{file, lines: [{n, text}]}]. */
function parseDiff(text) {
  const files = [];
  let cur = null;
  let n = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('+++ ')) {
      const p = line.slice(4).replace(/\t.*$/, '');
      cur = p === '/dev/null' ? null : { file: p.replace(/^b\//, ''), lines: [] };
      if (cur) files.push(cur);
    } else if (line.startsWith('@@')) {
      const m = /\+(\d+)/.exec(line);
      n = m ? Number(m[1]) : 0;
    } else if (cur && line.startsWith('+') && !line.startsWith('+++')) {
      cur.lines.push({ n, text: line.slice(1) });
      n += 1;
    }
  }
  return files;
}

/** Join consecutive items into blocks; `start` opens a new block, a blank item closes one. */
function toBlocks(items) {
  const blocks = [];
  let cur = null;
  for (const it of items) {
    if (!it.text.trim()) { cur = null; continue; }
    if (!cur || it.start || it.n !== cur.last + 1) { cur = { n: it.n, parts: [], last: it.n }; blocks.push(cur); }
    cur.parts.push(it.text.trim());
    cur.last = it.n;
  }
  return blocks.map((b) => ({ n: b.n, text: b.parts.join(' ') }));
}

function proseItems(lines, counters) {
  const items = [];
  let fence = null;
  let held = [];
  for (const { n, text } of lines) {
    if (/^\s*(```|~~~)/.test(text)) {
      if (fence) { counters.fencedSkipped += held.length; held = []; fence = null; } else fence = true;
      continue;
    }
    if (fence) { held.push({ n, text }); continue; }
    items.push(prose(n, text));
  }
  for (const h of held) items.push(prose(h.n, h.text)); // an unterminated fence counts everything
  return items.filter(Boolean);
}

function prose(n, text) {
  if (/^\s*\|?[\s:|-]+\|?\s*$/.test(text) && /-/.test(text)) return null;
  const m = /^\s*(?:#{1,6}\s+|[-*+]\s+|\d+\.\s+|>\s*)?(.*)$/.exec(text);
  return { n, text: m[1], start: /^\s*(?:#{1,6}\s|[-*+]\s|\d+\.\s)/.test(text) };
}

function commentItems(file, lines) {
  const ext = path.extname(file).toLowerCase();
  const slash = SLASH_EXT.has(ext);
  const hash = HASH_EXT.has(ext);
  if (!slash && !hash) return [];
  const items = [];
  for (const { n, text } of lines) {
    let body = null;
    if (slash) {
      const m = /^\s*(?:\/\/+|\/\*+|\*(?!\/))\s?(.*?)(?:\*\/)?\s*$/.exec(text) || /\s\/\/\s(.*)$/.exec(text);
      if (m) body = m[1];
    } else {
      const m = /^\s*#(?!!)\s?(.*)$/.exec(text) || /\s#\s(.*)$/.exec(text);
      if (m) body = m[1];
    }
    if (body === null) continue;
    body = body.trim();
    items.push({ n, text: body.replace(/^[-*]\s+/, ''), start: /^[-*]\s+/.test(body) });
  }
  return items;
}

const TITLE_RE = /\b(?:it|test|describe|t\.test)(?:\.\w+)*\s*\(\s*(['"`])((?:\\.|(?!\1).)*)\1/;
function titles(file, lines) {
  if (!(/\.test\.|(^|\/)tests?\//.test(file))) return [];
  const out = [];
  for (const { n, text } of lines) {
    const m = TITLE_RE.exec(text);
    if (m) out.push({ n, text: m[2] });
  }
  return out;
}

function splitSentences(text) {
  return text.split(/(?<=[.!?])\s+(?=[A-Z`"'(\[])/).map((s) => s.trim()).filter(Boolean);
}

function collect(o) {
  const counters = { fencedSkipped: 0 };
  const claims = [];
  const add = (kind, loc, text, whole) => {
    for (const s of whole ? [text.trim()] : splitSentences(text)) if (s) claims.push({ kind, loc, text: s });
  };
  const [a, b] = o.range.includes('...') ? o.range.split('...') : o.range.split('..');
  const from = o.range.includes('...') ? git(o.repo, ['merge-base', a, b]).trim() : a;
  const diff = git(o.repo, ['diff', '-U0', '--no-color', '--no-renames', from, b]);
  for (const f of parseDiff(diff)) {
    const isMd = /\.md$/i.test(f.file);
    if (isMd) {
      const kind = /(^|\/)adr\//i.test(f.file) ? 'adr' : 'doc';
      for (const bl of toBlocks(proseItems(f.lines, counters))) add(kind, `${f.file}:${bl.n}`, bl.text);
      continue;
    }
    for (const bl of toBlocks(commentItems(f.file, f.lines))) add('comment', `${f.file}:${bl.n}`, bl.text);
    for (const t of titles(f.file, f.lines)) add('title', `${f.file}:${t.n}`, t.text, true);
  }
  const log = git(o.repo, ['log', '--format=%h%x01%B%x00', `${from}..${b}`]);
  for (const rec of log.split('\0')) {
    const [sha, msg] = rec.replace(/^\n/, '').split('\x01');
    if (!sha || !msg) continue;
    const items = msg.split('\n').map((text, i) => ({ n: i + 1, text }));
    for (const bl of toBlocks(items)) add('commit', `commit ${sha}`, bl.text);
  }
  if (o.bodyNew !== undefined) {
    let oldL;
    let newL;
    try { oldL = fs.readFileSync(o.bodyOld, 'utf8').split('\n'); newL = fs.readFileSync(o.bodyNew, 'utf8').split('\n'); } catch (e) { throw new Refuse(`body file unreadable: ${e.message}`); }
    const pool = new Map();
    for (const l of oldL) pool.set(l, (pool.get(l) || 0) + 1);
    const added = [];
    newL.forEach((text, i) => {
      if (pool.get(text) > 0) pool.set(text, pool.get(text) - 1);
      else added.push({ n: i + 1, text });
    });
    for (const bl of toBlocks(proseItems(added, counters))) add('body', `body:${bl.n}`, bl.text);
  }
  return { claims, counters };
}

function validateResolutions(o, pol, ids) {
  const file = path.join(o.dir, 'CLAIMS-RESOLUTIONS.json');
  const problems = [];
  const good = new Map();
  if (!fs.existsSync(file)) return { problems, good };
  let arr;
  try { arr = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return { problems: [`resolutions unparseable: ${e.message}`], good }; }
  if (!Array.isArray(arr)) return { problems: ['resolutions must be a JSON array'], good };
  let realRoot;
  try { realRoot = fs.realpathSync(o.repo); } catch { realRoot = o.repo; }
  const seen = new Set();
  arr.forEach((e, i) => {
    const tag = `resolution #${i + 1}`;
    if (!e || typeof e !== 'object' || typeof e.id !== 'string') { problems.push(`${tag}: no id`); return; }
    if (seen.has(e.id)) { problems.push(`${tag}: duplicate id ${e.id}`); return; }
    seen.add(e.id);
    const allowed = e.kind === 'not-a-rule' ? ['id', 'kind', 'reason'] : ['id', 'kind', 'new_inputs', 'evidence', 'command'];
    if (!['oracle', 'generator', 'not-a-rule'].includes(e.kind)) { problems.push(`${tag}: unknown kind ${JSON.stringify(e.kind)}`); return; }
    const extra = Object.keys(e).filter((k) => !allowed.includes(k));
    if (extra.length) { problems.push(`${tag}: unknown field ${extra.join(',')}`); return; }
    if (e.kind === 'not-a-rule') {
      if (typeof e.reason !== 'string' || e.reason.trim().length < 15) { problems.push(`${tag}: not-a-rule needs a reason of 15+ characters`); return; }
    } else {
      if (!Number.isInteger(e.new_inputs) || e.new_inputs < pol.minNewInputs) { problems.push(`${tag}: new_inputs must be an integer >= ${pol.minNewInputs}`); return; }
      if (typeof e.command !== 'string' || !e.command.trim()) { problems.push(`${tag}: command is empty`); return; }
      const why = evidenceProblem(o.repo, realRoot, e.evidence);
      if (why) { problems.push(`${tag}: evidence ${why}`); return; }
    }
    good.set(e.id, e);
  });
  return { problems, good, stale: [...seen].filter((id) => !ids.has(id)) };
}

function evidenceProblem(repo, realRoot, ev) {
  if (typeof ev !== 'string' || !ev || path.isAbsolute(ev) || ev.split(/[\\/]/).includes('..')) return 'must be a repo-relative path without ..';
  try { git(repo, ['ls-files', '--error-unmatch', '--', ev]); } catch { return 'is not a git-tracked file'; }
  let real;
  try { real = fs.realpathSync(path.join(repo, ev)); } catch { return 'does not exist'; }
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return 'resolves outside the repo';
  if (!fs.statSync(real).isFile() || fs.statSync(real).size === 0) return 'is empty or not a file';
  return null;
}

function run(o) {
  const pol = loadPolicy(o);
  const { claims, counters } = collect(o);
  for (const c of claims) {
    const t = ascii(c.text);
    c.id = claimId(c.text);
    c.flags = pol.patterns.filter((p) => p.re.test(t)).map((p) => p.id);
    if (c.text.length > pol.max) c.flags.push('oversize');
  }
  const examined = { comment: 0, title: 0, adr: 0, doc: 0, commit: 0, body: 0 };
  for (const c of claims) examined[c.kind] += 1;
  const total = claims.length;
  const ids = new Set(claims.map((c) => c.id));
  const { problems, good, stale = [] } = validateResolutions(o, pol, ids);
  const warnings = stale.map((id) => `stale-resolution ${id}`);
  for (const c of claims) {
    const r = c.flags.length ? good.get(c.id) : null;
    c.status = !c.flags.length ? 'plain' : c.flags.includes('oversize') ? 'unresolved' : r ? (r.kind === 'not-a-rule' ? 'dismissed' : 'resolved') : 'unresolved';
  }
  for (const id of good.keys()) if (ids.has(id) && !claims.some((c) => c.id === id && c.flags.length)) warnings.push(`unneeded-resolution ${id}`);
  const unresolved = [...new Set(claims.filter((c) => c.status === 'unresolved').map((c) => c.id))];
  if (o.gate) {
    if (o.bodyNew === undefined && String(o.noBody || '').trim().length < 8) problems.push('gate needs --body-old/--body-new, or --no-body with a reason of 8+ characters');
    if (total === 0) problems.push('nothing was examined (no added comment, title, ADR, doc, commit or body sentence)');
  }
  const verdict = problems.length || (o.gate && unresolved.length) ? 'refused' : 'clean';
  const result = { verdict, gate: o.gate, range: o.range, examined, fenced_skipped: counters.fencedSkipped, policy: pol.info, no_body: o.noBody || null, self_reported: true, unresolved, problems, warnings, claims };
  writeReport(o, result);
  return result;
}

function writeReport(o, r) {
  const esc = (s) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const lines = [
    '# CLAIMS-DELTA',
    '',
    `Range: \`${r.range}\`. Verdict: **${r.verdict}** (${r.gate ? 'gate' : 'report'} mode).`,
    `Policy: \`${r.policy.path}\` sha1 ${r.policy.sha1}, minNewInputs ${r.policy.minNewInputs}${r.policy.reason ? `, reason: ${r.policy.reason}` : ''}.`,
    `Examined: ${Object.entries(r.examined).map(([k, v]) => `${k} ${v}`).join(', ')}; fenced lines skipped ${r.fenced_skipped}.${r.no_body ? ` No body supplied: ${r.no_body}.` : ''}`,
    '',
    'Not proven: `new_inputs` is self-reported; the gate checks that the evidence file is tracked, non-empty and inside the repo, not that it produced that many inputs or that none came from a review round.',
    `Not covered: ${NOT_COVERED.join('; ')}.`,
    '',
  ];
  if (r.problems.length) lines.push('## Problems', '', ...r.problems.map((p) => `- ${p}`), '');
  if (r.warnings.length) lines.push('## Warnings', '', ...r.warnings.map((p) => `- ${p}`), '');
  const dis = r.claims.filter((c) => c.status === 'dismissed');
  if (dis.length) lines.push('## Reasoned dismissals', '', ...dis.map((c) => `- ${c.id} ${esc(c.text)}`), '');
  lines.push('## Sentences', '', '| id | kind | where | flags | status | sentence |', '|---|---|---|---|---|---|');
  for (const c of r.claims) lines.push(`| ${c.id} | ${c.kind} | ${esc(c.loc)} | ${c.flags.join(',') || '-'} | ${c.status} | ${esc(c.text)} |`);
  const out = path.join(o.dir, 'CLAIMS-DELTA.md');
  fs.writeFileSync(`${out}.tmp`, lines.join('\n') + '\n');
  fs.renameSync(`${out}.tmp`, out);
}

function main(argv) {
  let o;
  try { o = parseArgs(argv); } catch (e) {
    if (e instanceof Usage) { process.stderr.write(`claims-delta: ${e.message}\n`); return 2; }
    throw e;
  }
  try {
    const r = run(o);
    process.stdout.write(`${JSON.stringify(r)}\n`);
    if (r.verdict === 'refused') process.stderr.write(`claims-delta: refused: ${[...r.problems, ...(r.unresolved.length ? [`${r.unresolved.length} unresolved rule-shaped claim(s), see CLAIMS-DELTA.md`] : [])].join('; ')}\n`);
    return r.verdict === 'clean' || !o.gate ? 0 : 1;
  } catch (e) {
    if (e instanceof Refuse) { process.stderr.write(`claims-delta: ${e.message}\n`); return 1; }
    process.stderr.write(`claims-delta: internal error: ${e.stack}\n`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { main, parseDiff, splitSentences, claimId };
