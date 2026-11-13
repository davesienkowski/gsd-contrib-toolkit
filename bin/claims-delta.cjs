#!/usr/bin/env node
'use strict';

/**
 * bin/claims-delta.cjs — flags the rule-shaped wording a fix round added, and (with --gate) refuses while a
 * flagged claim is unresolved (quick 261113-cde, PROPOSAL item 3; redesign FIX-PLAN-R3, approved by Dave).
 *
 *   node <gsd-contrib-toolkit>/bin/claims-delta.cjs <A..B | A...B> --dir DIR [--repo R]
 *        [--body-old F --body-new F | --no-body REASON] [--policy P --policy-reason TEXT]
 *        [--allow-unexamined REASON] [--gate]
 *
 * Exit 0 = report written (gate: clean of unresolved rule-shaped claims), 1 = gate refused or any doubt
 * (bad policy, bad resolutions, git failure, nothing examined, a binary or partly read file), 2 = usage.
 * ADVISORY AND MODEL-RUN: not a PreToolUse hook. It reads files and runs read-only git verbs with argv arrays
 * (no shell, no external diff or textconv drivers); it writes only DIR/CLAIMS-DELTA.md.
 *
 * MODEL (over-extract by construction): every added line of every readable file in the range, code included,
 * every added commit-message line (all parents) and every body-diff line is a candidate. The kind label
 * (comment, title, code, adr, doc, commit, body) is cosmetic and may be wrong without harm; it never decides
 * what is examined. A match is read over the line plus up to 2 unchanged lines each side (a sentence half
 * added and half unchanged is read whole), after leading markers, emphasis, code-span marks and tags are
 * blanked; a claim must overlap an added line.
 *
 * Resolved = a CLAIMS-RESOLUTIONS.json entry in DIR: kind oracle|generator with new_inputs >= minNewInputs,
 * a tracked non-empty evidence file (changed in the range or a test file) inside the repo and a command; or
 * kind not-a-claim with a 15+ char reason. A weakened rewrite needs no entry: the delta is recomputed.
 *
 * WHAT THIS DOES NOT PROVE: new_inputs is self-reported. Wording with no trigger word is unseen. A removed
 * qualifier (the reverse of the #5119 failure) is unseen. An unchanged half further than 2 lines away is
 * unseen. A merged base branch adds upstream text to the range (clear it with not-a-claim, "upstream text").
 * Only binary, too-large or partly parsed files are listed as unexamined.
 *
 * @module bin/claims-delta
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const SHIPPED_POLICY = path.join(__dirname, 'claims-delta.policy.json');
const REQUIRED_PATTERNS = ['quantifier', 'negated', 'definitional', 'scope-negation'];
const CONTEXT_LINES = 2;
const MAX_BUFFER = 64 * 1024 * 1024;
const NOT_COVERED = [
  'wording with no trigger word',
  'a removed qualifier (a deleted "unless" leaves the rest of the sentence absolute)',
  'an unchanged half of a sentence more than 2 lines from the added line',
  'upstream text pulled in by merging the base branch into the range (clear it with not-a-claim, reason "upstream text")',
];

class Usage extends Error {}
class Refuse extends Error {}

function parseArgs(argv) {
  const o = { gate: false };
  const valued = { '--allow-unexamined': 'allowUnexamined', '--dir': 'dir', '--repo': 'repo', '--body-old': 'bodyOld', '--body-new': 'bodyNew', '--no-body': 'noBody', '--policy': 'policy', '--policy-reason': 'policyReason' };
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
  const sides = rest[0].split(/\.\.\.?/);
  const SIDE = /^[A-Za-z0-9._/~^@{}:+][A-Za-z0-9._/~^@{}:+-]*$/;
  if (!/\.\./.test(rest[0]) || sides.length !== 2 || !sides.every((s) => SIDE.test(s))) throw new Usage('range must look like A..B or A...B, each side a revision that does not start with -');
  if (!o.dir || !fs.existsSync(o.dir) || !fs.statSync(o.dir).isDirectory()) throw new Usage('--dir must be an existing directory');
  if ((o.bodyOld === undefined) !== (o.bodyNew === undefined)) throw new Usage('--body-old and --body-new go together');
  o.range = rest[0];
  o.repo = path.resolve(o.repo || process.cwd());
  return o;
}

/** One read-only git call, argv array, no shell. Returns {ok, out, err, tooBig}. */
function gitRaw(repo, args) {
  const env = { ...process.env };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete env[k];
  const r = spawnSync('git', ['-C', repo, '-c', 'core.quotepath=false', ...args], { encoding: 'utf8', env, maxBuffer: MAX_BUFFER, stdio: ['ignore', 'pipe', 'pipe'] });
  const tooBig = !!(r.error && r.error.code === 'ENOBUFS');
  return { ok: r.status === 0 && !r.error, out: r.stdout || '', err: String((r.stderr || (r.error && r.error.message) || '')).trim().split('\n')[0], tooBig };
}

function git(repo, args) {
  const r = gitRaw(repo, args);
  if (!r.ok) throw new Refuse(`git ${args[0]} failed: ${r.err}`);
  return r.out;
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
    if (/[gy]/.test(p.flags || '')) throw new Refuse(`policy pattern ${p.id} sets a g or y flag (stateful matching)`);
    try { return { id: p.id, re: new RegExp(p.regex, `${p.flags || 'i'}g`) }; } catch (e) { throw new Refuse(`policy pattern ${p && p.id} invalid: ${e.message}`); }
  });
  const SAMPLES = { quantifier: 'It never fails.', negated: 'X is not a miss.', definitional: 'The key is a hash.', 'scope-negation': 'The file is unchanged.' };
  for (const id of REQUIRED_PATTERNS) {
    if (!patterns.some((p) => p.id === id && new RegExp(p.re.source, p.re.flags).test(SAMPLES[id]))) throw new Refuse(`policy pattern ${id} does not match its sample sentence "${SAMPLES[id]}"`);
  }
  const sha1 = crypto.createHash('sha1').update(raw).digest('hex');
  return { patterns, minNewInputs: pol.minNewInputs, max, info: { path: file, sha1, reason: o.policyReason || null, minNewInputs: pol.minNewInputs } };
}

const ascii = (s) => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
const norm = (s) => ascii(s).replace(/\s+/g, ' ').trim().toLowerCase();
const claimId = (s) => crypto.createHash('sha1').update(norm(s)).digest('hex').slice(0, 12);
const blank = (s) => ' '.repeat(s.length);

/**
 * Added lines per file from `git diff -U0`: [{file, lines: [{n, text}]}]. A hunk header's counts say how
 * many old and new lines follow, so a content line that starts with "++ " is never read as a file header.
 */
function parseDiff(text) {
  const files = [];
  let cur = null;
  let n = 0;
  let oldLeft = 0;
  let newLeft = 0;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (oldLeft > 0 || newLeft > 0) {
      if (line.startsWith('+')) {
        if (cur) cur.lines.push({ n, text: line.slice(1) });
        n += 1;
        newLeft -= 1;
      } else if (line.startsWith('-')) oldLeft -= 1;
      continue; // a "\ No newline at end of file" marker falls through here and is skipped
    }
    if (line.startsWith('+++ ')) {
      const p = line.slice(4).replace(/\t.*$/, '');
      cur = p === '/dev/null' ? null : { file: p.replace(/^b\//, ''), lines: [] };
      if (cur) files.push(cur);
    } else if (line.startsWith('@@')) {
      const m = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m) continue;
      oldLeft = m[1] === undefined ? 1 : Number(m[1]);
      n = Number(m[2]);
      newLeft = m[3] === undefined ? 1 : Number(m[3]);
    }
  }
  return files;
}

/** A cosmetic label for the kind of one line; a wrong label changes nothing about what is examined. */
function labelFor(file, text) {
  if (/\.md$/i.test(file)) return /(^|\/)adr\//i.test(file) ? 'adr' : 'doc';
  if (/\.(?:test|spec)\.|(^|\/)(?:tests?|__tests__)\//.test(file) && /\b(?:it|test|describe|t\.test)(?:\.\w+)*\s*\(\s*['"`]/.test(text)) return 'title';
  if (/^\s*(?:\/\/|\/\*|\*|#|--|;|%|<!--)/.test(text) || /\s\/\/\s|\/\*|\s#\s/.test(text)) return 'comment';
  return 'code';
}

/**
 * Match the policy patterns over regions of lines. Each region is a list of {n, text, added, kind}; consecutive
 * lines are joined with a space. Display text blanks only a leading run of non-letter, non-digit characters
 * (comment, quote, list markers); the match copy also blanks emphasis marks, code-span marks and tags, so
 * offsets agree. A claim is a match that overlaps an added line; its id is the matched lines' own text.
 */
function claimsFromRegion(region, pol, loc, defaultKind) {
  const disp = [];
  const starts = [];
  let pos = 0;
  const parts = region.map((l) => {
    const t = ascii(l.text.replace(/\r$/, '').replace(/\t/g, ' '));
    const d = t.replace(/^(?:[^\p{L}\p{N}]+)?(?:\d{1,3}[.)](?=\s))?/u, blank);
    starts.push(pos);
    pos += d.length + 1;
    disp.push(d);
    return d;
  });
  const D = parts.join(' ');
  const TAG = /<\/?[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z-]+(?:=(?:"[^"]*"|'[^']*'|[^\s>"']+))?)*\s*\/?>/g;
  const M = parts.map((d) => d.replace(/[*_`]/g, ' ').replace(TAG, blank)).join(' ');
  const lineAt = (off) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= off) lo = mid; else hi = mid - 1;
    }
    return lo;
  };
  const found = new Map();
  for (const p of pol.patterns) {
    const re = new RegExp(p.re.source, p.re.flags);
    let m;
    while ((m = re.exec(M)) !== null) {
      if (m[0].length === 0) { re.lastIndex += 1; continue; }
      const ls = lineAt(m.index);
      const le = lineAt(m.index + m[0].length - 1);
      let touched = false;
      for (let i = ls; i <= le; i += 1) if (region[i].added) touched = true;
      if (!touched) continue;
      const key = `${ls}-${le}`;
      let c = found.get(key);
      if (!c) {
        const lo = Math.max(0, ls - CONTEXT_LINES);
        const hi = Math.min(region.length - 1, le + CONTEXT_LINES);
        const wStart = starts[lo];
        let s = m.index;
        const lineStarts = new Set(starts.slice(lo + 1, ls + 1));
        while (s > wStart && !/[.!?]\s$/.test(D.slice(Math.max(0, s - 2), s))) {
          if (lineStarts.has(s) && /[.!?;:{}]\s*$/.test(disp[lineAt(s) - 1])) break;
          s -= 1;
        }
        const lineEnd = starts[le] + disp[le].length;
        let e = m.index + m[0].length;
        while (e < lineEnd && !/[.!?]/.test(D[e - 1])) e += 1;
        const text = D.slice(s, e).replace(/\s+/g, ' ').trim();
        const matched = disp.slice(ls, le + 1).join(' ');
        const first = region.slice(ls, le + 1).find((l) => l.added) || region[ls];
        c = { kind: first.kind || defaultKind, loc: `${loc}:${first.n}`, text, id: claimId(matched), flags: [] };
        found.set(key, c);
      }
      if (!c.flags.includes(p.id)) c.flags.push(p.id);
    }
  }
  return [...found.values()];
}

/** Split lines into paragraphs of non-blank lines, widened by CONTEXT_LINES around the added ones. */
function regionsFor(lines) {
  const regions = [];
  let i = 0;
  while (i < lines.length) {
    if (!lines[i].text.trim()) { i += 1; continue; }
    let j = i;
    while (j + 1 < lines.length && lines[j + 1].text.trim()) j += 1;
    let first = -1;
    let last = -1;
    for (let k = i; k <= j; k += 1) if (lines[k].added) { if (first < 0) first = k; last = k; }
    if (first >= 0) regions.push(lines.slice(Math.max(i, first - CONTEXT_LINES), Math.min(j, last + CONTEXT_LINES) + 1));
    i = j + 1;
  }
  return regions;
}

function collect(o, pol) {
  const claims = [];
  const files = [];
  const unexamined = [];
  const examined = { comment: 0, title: 0, adr: 0, doc: 0, code: 0, commit: 0, body: 0 };
  const [a0, b0] = o.range.includes('...') ? o.range.split('...') : o.range.split('..');
  const resolve = (rev) => git(o.repo, ['rev-parse', '--verify', '--end-of-options', `${rev}^{commit}`]).trim();
  const a = resolve(a0);
  const b = resolve(b0);
  const from = o.range.includes('...') ? git(o.repo, ['merge-base', a, b]).trim() : a;
  const DIFF = ['diff', '-U0', '--no-color', '--no-renames', '--no-ext-diff', '--no-textconv'];
  const numstat = new Map();
  for (const l of git(o.repo, ['diff', '--numstat', '--no-renames', '--diff-filter=d', '--no-ext-diff', '--no-textconv', from, b]).split('\n')) {
    const m = /^(-|\d+)\t(-|\d+)\t(.+)$/.exec(l);
    if (m) numstat.set(m[3], m[1] === '-' ? null : Number(m[1]));
  }
  const changed = [...numstat.keys()];
  for (const [f, added] of numstat) if (added === null) unexamined.push(`${f} (binary)`);

  let parsed = [];
  const whole = gitRaw(o.repo, [...DIFF, from, b]);
  if (whole.ok) parsed = parseDiff(whole.out);
  else if (whole.tooBig) {
    for (const [f, added] of numstat) {
      if (added === null || added === 0) continue;
      const one = gitRaw(o.repo, [...DIFF, from, b, '--', f]);
      if (one.ok) parsed.push(...parseDiff(one.out));
      else unexamined.push(`${f} (too large)`);
    }
  } else throw new Refuse(`git diff failed: ${whole.err}`);

  for (const f of parsed) {
    const expected = numstat.get(f.file);
    if (expected !== undefined && expected !== null && expected !== f.lines.length) unexamined.push(`${f.file} (partial: parsed ${f.lines.length} of ${expected} added lines)`);
    const addedAt = new Map(f.lines.map((l) => [l.n, l.text.replace(/\r$/, '')]));
    let lines = null;
    const show = gitRaw(o.repo, ['show', '--no-textconv', `${b}:${f.file}`]);
    if (show.ok) {
      const post = show.out.replace(/^﻿/, '').split(/\r?\n/);
      if ([...addedAt].every(([n, t]) => (post[n - 1] || '').replace(/^﻿/, '') === t.replace(/^﻿/, ''))) {
        lines = post.map((text, i) => ({ n: i + 1, text, added: addedAt.has(i + 1) }));
      }
    }
    if (!lines) lines = f.lines.map((l) => ({ n: l.n, text: l.text.replace(/\r$/, ''), added: true }));
    for (const l of lines) l.kind = labelFor(f.file, l.text);
    let flagged = 0;
    let exCount = 0;
    for (const l of lines) if (l.added && l.text.trim()) { examined[l.kind] += 1; exCount += 1; }
    for (const region of regionsFor(lines)) {
      for (const c of claimsFromRegion(region, pol, f.file, 'code')) { claims.push({ ...c, loc: c.loc }); flagged += 1; }
    }
    files.push({ file: f.file, added: f.lines.length, examined: exCount, flagged });
  }

  const log = git(o.repo, ['log', '--format=%h%x01%B%x00', `${from}..${b}`]);
  let nCommits = 0;
  for (const rec of log.split('\0')) {
    const [sha, msg] = rec.replace(/^\n/, '').split('\x01');
    if (!sha || msg === undefined) continue;
    nCommits += 1;
    const lines = msg.split('\n').map((text, i) => ({ n: i + 1, text: text.replace(/\r$/, ''), added: true, kind: 'commit' }));
    for (const l of lines) if (l.text.trim()) examined.commit += 1;
    for (const region of regionsFor(lines)) claims.push(...claimsFromRegion(region, pol, `commit ${sha}`, 'commit'));
  }
  if (o.bodyNew !== undefined) {
    let oldL;
    let newL;
    try {
      oldL = fs.readFileSync(o.bodyOld, 'utf8').split(/\r?\n/);
      newL = fs.readFileSync(o.bodyNew, 'utf8').split(/\r?\n/);
    } catch (e) { throw new Refuse(`body file unreadable: ${e.message}`); }
    const pool = new Map();
    for (const l of oldL) pool.set(l, (pool.get(l) || 0) + 1);
    const lines = newL.map((text, i) => {
      const had = pool.get(text) > 0;
      if (had) pool.set(text, pool.get(text) - 1);
      return { n: i + 1, text, added: !had, kind: 'body' };
    });
    for (const l of lines) if (l.added && l.text.trim()) examined.body += 1;
    for (const region of regionsFor(lines)) claims.push(...claimsFromRegion(region, pol, 'body', 'body'));
  }
  return { claims, files, unexamined, examined, changed, base: from, head: b, commits: nCommits };
}

function validateResolutions(o, pol, ids, changed) {
  const file = path.join(o.dir, 'CLAIMS-RESOLUTIONS.json');
  const problems = [];
  const good = new Map();
  if (!fs.existsSync(file)) return { problems, good, stale: [] };
  let arr;
  try { arr = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return { problems: [`resolutions unparseable: ${e.message}`], good, stale: [] }; }
  if (!Array.isArray(arr)) return { problems: ['resolutions must be a JSON array'], good, stale: [] };
  let realRoot;
  try { realRoot = fs.realpathSync(o.repo); } catch { realRoot = o.repo; }
  const seen = new Set();
  arr.forEach((e, i) => {
    const tag = `resolution #${i + 1}`;
    if (!e || typeof e !== 'object' || typeof e.id !== 'string') { problems.push(`${tag}: no id`); return; }
    if (seen.has(e.id)) { problems.push(`${tag}: duplicate id ${e.id}`); return; }
    seen.add(e.id);
    if (!['oracle', 'generator', 'not-a-claim'].includes(e.kind)) { problems.push(`${tag}: unknown kind ${JSON.stringify(e.kind)}`); return; }
    const allowed = e.kind === 'not-a-claim' ? ['id', 'kind', 'reason'] : ['id', 'kind', 'new_inputs', 'evidence', 'command'];
    const extra = Object.keys(e).filter((k) => !allowed.includes(k));
    if (extra.length) { problems.push(`${tag}: unknown field ${extra.join(',')}`); return; }
    if (e.kind === 'not-a-claim') {
      if (typeof e.reason !== 'string' || e.reason.trim().length < 15) { problems.push(`${tag}: not-a-claim needs a reason of 15+ characters`); return; }
    } else {
      if (!Number.isInteger(e.new_inputs) || e.new_inputs < pol.minNewInputs) { problems.push(`${tag}: new_inputs must be an integer >= ${pol.minNewInputs}`); return; }
      if (typeof e.command !== 'string' || !e.command.trim()) { problems.push(`${tag}: command is empty`); return; }
      const why = evidenceProblem(o.repo, realRoot, e.evidence, changed);
      if (why) { problems.push(`${tag}: evidence ${why}`); return; }
    }
    good.set(e.id, e);
  });
  return { problems, good, stale: [...seen].filter((id) => !ids.has(id)) };
}

function evidenceProblem(repo, realRoot, ev, changed) {
  if (typeof ev !== 'string' || !ev || path.isAbsolute(ev) || ev.split(/[\\/]/).includes('..')) return 'must be a repo-relative path without ..';
  if (!gitRaw(repo, ['ls-files', '--error-unmatch', '--', ev]).ok) return 'is not a git-tracked file';
  if (!changed.includes(ev) && !/\.test\./.test(ev)) return 'is neither changed in the range nor a *.test.* file';
  let real;
  try { real = fs.realpathSync(path.join(repo, ev)); } catch { return 'does not exist'; }
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return 'resolves outside the repo';
  if (!fs.statSync(real).isFile() || fs.statSync(real).size === 0) return 'is empty or not a file';
  return null;
}

function run(o) {
  const pol = loadPolicy(o);
  const { claims, files, unexamined, examined, changed, base, head, commits } = collect(o, pol);
  for (const c of claims) if (c.text.length > pol.max) c.flags.push('oversize');
  const ids = new Set(claims.map((c) => c.id));
  const { problems, good, stale } = validateResolutions(o, pol, ids, changed);
  const warnings = stale.map((id) => `stale-resolution ${id}`);
  for (const c of claims) {
    const r = good.get(c.id);
    c.status = r && r.kind === 'not-a-claim' ? 'dismissed' : r && !c.flags.includes('oversize') ? 'resolved' : 'unresolved';
  }
  const unresolved = [...new Set(claims.filter((c) => c.status === 'unresolved').map((c) => c.id))];
  const total = Object.values(examined).reduce((x, y) => x + y, 0);
  if (o.gate) {
    if (o.bodyNew === undefined && String(o.noBody || '').trim().length < 8) problems.push('gate needs --body-old/--body-new, or --no-body with a reason of 8+ characters');
    if (total === 0) problems.push('nothing was examined (no added line, commit message line or body line)');
    if (unexamined.length && String(o.allowUnexamined || '').trim().length < 8) problems.push(`unexamined files: ${unexamined.join(', ')}; read them by hand and pass --allow-unexamined "<reason of 8+ characters>"`);
  }
  const verdict = problems.length || (o.gate && unresolved.length) ? 'refused' : 'clean';
  const result = { verdict, gate: o.gate, range: o.range, base, head, commits, examined, files, unexamined_files: unexamined, allow_unexamined: o.allowUnexamined || null, policy: pol.info, no_body: o.noBody || null, self_reported: true, unresolved, problems, warnings, claims };
  writeReport(o, result);
  return result;
}

/** Overwrite the report with a refusal; used before a run (pending) and on every failure. */
function writeStub(dir, reason, onlyIfExists) {
  try {
    const out = path.join(dir, 'CLAIMS-DELTA.md');
    if (onlyIfExists && !fs.existsSync(out)) return;
    fs.writeFileSync(`${out}.tmp`, `# CLAIMS-DELTA\n\nREFUSED: ${reason}\n`);
    fs.renameSync(`${out}.tmp`, out);
  } catch { /* the exit code still refuses */ }
}

function writeReport(o, r) {
  const esc = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const lines = [
    '# CLAIMS-DELTA',
    '',
    `Range: \`${r.range}\` (base ${r.base}, head ${r.head}, ${r.commits} commit(s)). Verdict: **${r.verdict}** (${r.gate ? 'gate' : 'report'} mode).`,
    `Policy: \`${r.policy.path}\` sha1 ${r.policy.sha1}, minNewInputs ${r.policy.minNewInputs}${r.policy.reason ? `, reason: ${r.policy.reason}` : ''}.`,
    `Examined added lines: ${Object.entries(r.examined).map(([k, v]) => `${k} ${v}`).join(', ')}.${r.no_body ? ` No body supplied: ${r.no_body}.` : ''}`,
    `Unexamined files: ${r.unexamined_files.join(', ') || 'none'}${r.allow_unexamined ? `; allowed: ${r.allow_unexamined}` : ''}.`,
    '',
    'This reads every added line, flags rule-shaped wording, and judges nothing about truth. Not proven: `new_inputs` is self-reported; the gate checks that the evidence file is tracked, non-empty, inside the repo and changed in the range or a test file.',
    `Not covered: ${NOT_COVERED.join('; ')}.`,
    '',
  ];
  if (r.problems.length) lines.push('## Problems', '', ...r.problems.map((p) => `- ${p}`), '');
  if (r.warnings.length) lines.push('## Warnings', '', ...r.warnings.map((p) => `- ${p}`), '');
  const dis = r.claims.filter((c) => c.status === 'dismissed');
  if (dis.length) lines.push('## Reasoned dismissals', '', ...dis.map((c) => `- ${c.id} ${esc(c.text)}`), '');
  lines.push('## Files', '', '| file | added | examined | flagged |', '|---|---|---|---|');
  for (const f of r.files) lines.push(`| ${esc(f.file)} | ${f.added} | ${f.examined} | ${f.flagged} |`);
  lines.push('', '## Flagged claims', '', '| id | kind | where | flags | status | text |', '|---|---|---|---|---|---|');
  for (const c of r.claims) lines.push(`| ${c.id} | ${c.kind} | ${esc(c.loc)} | ${c.flags.join(',')} | ${c.status} | ${esc(c.text)} |`);
  const out = path.join(o.dir, 'CLAIMS-DELTA.md');
  fs.writeFileSync(`${out}.tmp`, lines.join('\n') + '\n');
  fs.renameSync(`${out}.tmp`, out);
}

function main(argv) {
  let o;
  try { o = parseArgs(argv); } catch (e) {
    if (e instanceof Usage) {
      const i = argv.indexOf('--dir');
      const eq = argv.find((x) => x.startsWith('--dir='));
      const rawDir = eq ? eq.slice(6) : i >= 0 ? argv[i + 1] : null;
      if (rawDir) writeStub(rawDir, `usage error: ${e.message}`, true);
      process.stderr.write(`claims-delta: ${e.message}\n`);
      return 2;
    }
    throw e;
  }
  writeStub(o.dir, 'run did not finish', false);
  try {
    const r = run(o);
    process.stdout.write(`${JSON.stringify(r)}\n`);
    if (r.verdict === 'refused') process.stderr.write(`claims-delta: refused: ${[...r.problems, ...(r.unresolved.length ? [`${r.unresolved.length} unresolved rule-shaped claim(s), see CLAIMS-DELTA.md`] : [])].join('; ')}\n`);
    return r.verdict === 'clean' || !o.gate ? 0 : 1;
  } catch (e) {
    const msg = e instanceof Refuse ? e.message : `internal error: ${e.stack}`;
    writeStub(o.dir, msg.split('\n')[0], false);
    process.stderr.write(`claims-delta: ${msg}\n`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { main, parseDiff, claimId };
