'use strict';
/**
 * docs-links.test.cjs — the DOC-LINK DRIFT GUARD.
 *
 * Sibling of `docs-hook-counts.test.cjs`. That one pins doc *claims* against the wired hook set;
 * this one pins doc *links* against the filesystem.
 *
 * WHY THIS EXISTS: on 2026-07-31 a sweep found **18 broken links** across the tracked markdown —
 * all pre-existing, none caught by anything. Two failure classes, both invisible locally on a
 * case-insensitive filesystem and both fatal on GitHub:
 *
 *   (1) CASE DRIFT — `docs/reuse-and-methodology.md` linking a file that is really
 *       `docs/REUSE-AND-METHODOLOGY.md`. Resolves on macOS, 404s on github.com.
 *   (2) BUNDLE-RELATIVE DRIFT — `capabilities/contribution-toolkit/README.md` linking `docs/foo.md`
 *       relative to itself. The bundle only carries docs that are LINKED FROM A PROJECTED SKILL
 *       (see build-capability.cjs `readLinkedDocs`), so most of `docs/` is absent from the bundle
 *       and those links dangle for every remote installer.
 *
 * WHAT IS CHECKED (offline only — no network, so CI stays deterministic):
 *   - every markdown file link resolves to a real path, case-sensitively;
 *   - every `#anchor` (bare, or `file.md#anchor`) matches a real heading, using GitHub's slug rules.
 *
 * WHAT IS NOT CHECKED: external `http(s)://` targets. Those need the network and would make CI
 * flaky and offline-hostile; verify them by hand when adding one.
 *
 * SLUG NOTE (this bit is easy to get wrong and produces silent FALSE PASSES/FAILURES): GitHub
 * replaces EACH whitespace character with a hyphen, not each RUN. A heading like
 * `## Authoring hand-off (sweep → contribution)` strips `(`, `)` and `→`, leaving two adjacent
 * spaces, and therefore anchors as `...sweep--contribution` with a DOUBLE hyphen. Collapsing runs
 * with /\s+/ reports 10 healthy links as broken.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = __dirname;

/** Tracked markdown files (git is the source of truth for "shipped"). */
function trackedMarkdown() {
  return execFileSync('git', ['-C', REPO_ROOT, 'ls-files', '*.md'], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
}

/** GitHub heading text -> anchor slug. See SLUG NOTE above. */
function slug(heading) {
  return heading
    .replace(/`/g, '')
    .replace(/\*\*|\*|__|_/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s/g, '-');
}

const anchorCache = new Map();
/** All anchors a markdown file exposes: ATX headings + explicit <a name|id>. */
function anchorsOf(absPath) {
  if (anchorCache.has(absPath)) return anchorCache.get(absPath);
  const set = new Set();
  let txt = '';
  try {
    txt = fs.readFileSync(absPath, 'utf8');
  } catch {
    anchorCache.set(absPath, set);
    return set;
  }
  let inFence = false;
  for (const line of txt.split('\n')) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const h = /^#{1,6}\s+(.*?)\s*$/.exec(line);
    if (h) set.add(slug(h[1]));
    const a = /<a\s+(?:name|id)=["']([^"']+)["']/gi;
    let am;
    while ((am = a.exec(line))) set.add(am[1].toLowerCase());
  }
  anchorCache.set(absPath, set);
  return set;
}

/** Markdown link targets in a file, with fenced code stripped (examples are not links). */
function linksOf(rel) {
  const abs = path.join(REPO_ROOT, rel);
  const out = [];
  let inFence = false;
  fs.readFileSync(abs, 'utf8')
    .split('\n')
    .forEach((raw, i) => {
      if (/^\s*```/.test(raw)) {
        inFence = !inFence;
        return;
      }
      if (inFence) return;
      const re = /\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
      let m;
      while ((m = re.exec(raw))) out.push({ target: m[2], loc: `${rel}:${i + 1}` });
    });
  return out;
}

test('every relative markdown link resolves to a real path (case-sensitively)', () => {
  const broken = [];
  for (const rel of trackedMarkdown()) {
    const abs = path.join(REPO_ROOT, rel);
    for (const { target, loc } of linksOf(rel)) {
      if (/^(https?:|mailto:|tel:)/i.test(target) || target.startsWith('#')) continue;
      const filePart = target.split('#')[0];
      if (!filePart) continue;
      const resolved = path.resolve(path.dirname(abs), filePart);
      if (!fs.existsSync(resolved)) {
        broken.push(`${loc}  [${target}]  -> missing ${path.relative(REPO_ROOT, resolved)}`);
        continue;
      }
      // fs.existsSync is case-INSENSITIVE on macOS/Windows; compare the real dirent name so a
      // case-drifted link fails here rather than on github.com.
      const dir = path.dirname(resolved);
      const base = path.basename(resolved);
      if (fs.existsSync(dir) && !fs.readdirSync(dir).includes(base)) {
        broken.push(`${loc}  [${target}]  -> case mismatch; no dirent named "${base}"`);
      }
    }
  }
  assert.deepEqual(broken, [], `broken relative links:\n  ${broken.join('\n  ')}`);
});

test('every #anchor link points at a real heading', () => {
  const broken = [];
  for (const rel of trackedMarkdown()) {
    const abs = path.join(REPO_ROOT, rel);
    for (const { target, loc } of linksOf(rel)) {
      if (/^(https?:|mailto:|tel:)/i.test(target)) continue;
      const [filePart, anchor] = target.split('#');
      if (!anchor) continue;
      const targetAbs = filePart ? path.resolve(path.dirname(abs), filePart) : abs;
      if (!fs.existsSync(targetAbs)) continue; // path failure is the other test's job
      if (!/\.md$/i.test(targetAbs)) continue;
      if (!anchorsOf(targetAbs).has(anchor.toLowerCase())) {
        broken.push(`${loc}  [${target}]  -> no heading anchors to #${anchor}`);
      }
    }
  }
  assert.deepEqual(broken, [], `broken anchors:\n  ${broken.join('\n  ')}`);
});
