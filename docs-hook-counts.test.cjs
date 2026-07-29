'use strict';

/**
 * docs-hook-counts.test.cjs — the DOC-COUNT DRIFT GUARD.
 *
 * WHY THIS EXISTS
 * The prose counts ("13 fail-closed PreToolUse gates", "15 hook scripts", "16 registrations")
 * drifted repeatedly and silently: a hook got wired, the tests were updated, and the docs kept
 * asserting the previous number. Nothing was red, so nothing surfaced. This test makes the docs
 * a VERIFIED surface: every count below is DERIVED AT RUNTIME from `settings.snippet.json` (the
 * canonical wired-set source `bin/build-capability.cjs` reads) and then asserted against the
 * documentation prose. Wire a hook and forget a doc => RED, naming the file and the claim.
 *
 * ─────────── WHAT IT COVERS (do not over-read this list) ───────────
 *   (1) Derivation self-consistency: registrations = Σ per-event; distinct scripts = registrations
 *       minus the multi-event duplicates.
 *   (2) The two deliberately-UNWIRED scripts (`doctor.cjs`, `preflight-shipped-paths.cjs`) exist on
 *       disk, are absent from the wired set, and are absent from README's gate-reference table.
 *   (3) README.md — every primary count claim, as a whitespace-normalized literal built from the
 *       derived numbers.
 *   (4) README.md gate-reference table — its rows enumerate EXACTLY the wired script set (set
 *       equality, both directions). This is the check that catches "new hook, undocumented".
 *   (5) docs/guides/overview.md + docs/guides/contributor-guide.md — their primary count claims.
 *   (6) capabilities/contribution-toolkit/README.md (the published-capability README) — its
 *       primary count claims, including the spelled-out "thirteen".
 *   (7) capability.json `hooks[]` parity with the snippet (registrations + per-event breakdown).
 *   (8) A GENERIC stale-number scan over the four covered doc files: any number sitting directly
 *       in front of a hook/gate noun must be one of the derived values.
 *
 * ─────────── WHAT IT DOES **NOT** COVER (honest limits) ───────────
 *   • `docs/adr/CTK-ADR-*.md` — frozen historical records. CTK-ADR-0004 says "ten of the twelve
 *     blocking gates", true when written. Deliberately NOT scanned.
 *   • `docs/superpowers/specs/*.md` — dated, point-in-time approved designs ("12 gates" was true
 *     on 2026-06-22). Deliberately NOT scanned.
 *   • `.planning/**` — historical execution log. Deliberately NOT scanned.
 *   • `hooks/*.cjs` and `hooks/lib/*.cjs` header comments. `hooks/tool-recorder.cjs` currently says
 *     "the twelve fail-closed gates" (now 13) — NOT scanned and NOT asserted here.
 *   • `bin/**` comments and CLI help text. Fixed by hand in the same commit, but not guarded.
 *   • Prose that describes a count WITHOUT a numeral ("every wired PreToolUse gate"). That phrasing
 *     is drift-proof by construction and needs no assertion — which is the point of preferring it.
 *   • The generic scan (8) is NOUN-SCOPED and therefore incomplete: it only sees a numeral placed
 *     immediately before a hook/gate noun (optionally through a whitelist of adjectives). A count
 *     smuggled in as "a dozen gates", "the gates number 12", or in a table cell separated from its
 *     noun is INVISIBLE to it. It also cannot tell 13-meant-15 apart when both are valid numbers
 *     somewhere in the doc — it validates membership, not per-site intent. The per-site literal
 *     assertions (3)(5)(6) are what pin intent, and they only cover the PRIMARY claims.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = __dirname;
const SNIPPET_PATH = path.join(REPO, 'settings.snippet.json');
const HOOKS_DIR = path.join(REPO, 'hooks');
const CAP_MANIFEST = path.join(REPO, 'capabilities', 'contribution-toolkit', 'capability.json');

const README = 'README.md';
const OVERVIEW = path.join('docs', 'guides', 'overview.md');
const CONTRIB_GUIDE = path.join('docs', 'guides', 'contributor-guide.md');
const CAP_README = path.join('capabilities', 'contribution-toolkit', 'README.md');

/** The scripts that live in hooks/ but are deliberately NOT wired (CLIs, not hooks). */
const DELIBERATELY_UNWIRED = ['doctor.cjs', 'preflight-shipped-paths.cjs'];

// ───────────────────────────── derivation ─────────────────────────────

/**
 * Derive the authoritative wired-set numbers from a harness settings block.
 *
 * Category rules (the ONLY place they are defined):
 *   - blocking / fail-closed  = every `PreToolUse` registration (each one can return `deny`)
 *   - advisory / fail-open    = every `UserPromptSubmit` registration (reminds, never denies)
 *   - observability / fail-open = every `PostToolUse` + `PostToolUseFailure` registration
 *
 * @param {object} snip parsed `{hooks:{<event>:[{matcher,hooks:[{command}]}]}}`
 */
function deriveCounts(snip) {
  const perEvent = Object.create(null);
  const perEventMatcher = Object.create(null);
  const scriptEvents = new Map(); // basename -> Set<event>
  let registrations = 0;

  for (const [event, groups] of Object.entries(snip.hooks)) {
    perEvent[event] = 0;
    for (const group of groups) {
      const key = `${event}|${group.matcher}`;
      perEventMatcher[key] = (perEventMatcher[key] || 0) + group.hooks.length;
      perEvent[event] += group.hooks.length;
      for (const h of group.hooks) {
        const m = String(h.command).match(/hooks[\\/]([A-Za-z0-9._-]+\.cjs)/);
        assert.ok(m, `every wired command must reference a hooks/<name>.cjs path: ${h.command}`);
        registrations += 1;
        if (!scriptEvents.has(m[1])) scriptEvents.set(m[1], new Set());
        scriptEvents.get(m[1]).add(event);
      }
    }
  }

  const pre = perEvent.PreToolUse || 0;
  const ups = perEvent.UserPromptSubmit || 0;
  const post = perEvent.PostToolUse || 0;
  const postFail = perEvent.PostToolUseFailure || 0;

  const observabilityScripts = new Set(
    [...scriptEvents.entries()]
      .filter(([, evs]) => evs.has('PostToolUse') || evs.has('PostToolUseFailure'))
      .map(([f]) => f)
  );

  return {
    registrations,
    scripts: new Set(scriptEvents.keys()),
    scriptCount: scriptEvents.size,
    perEvent,
    pre,
    bash: perEventMatcher['PreToolUse|Bash'] || 0,
    writeEdit: perEventMatcher['PreToolUse|Write|Edit'] || 0,
    ups,
    post,
    postFail,
    blocking: pre,
    advisory: ups,
    observabilityRegistrations: post + postFail,
    observabilityScripts: observabilityScripts.size,
    /** scripts wired on more than one event (why registrations > scriptCount) */
    multiEventScripts: [...scriptEvents.entries()].filter(([, evs]) => evs.size > 1).map(([f]) => f),
    /** Σ (events per script − 1) — the extra registrations the multi-event scripts contribute. */
    extraRegistrations: [...scriptEvents.values()].reduce((n, evs) => n + (evs.size - 1), 0),
  };
}

const SNIP = JSON.parse(fs.readFileSync(SNIPPET_PATH, 'utf8'));
const C = deriveCounts(SNIP);

/** Read a repo-relative doc and collapse all whitespace so assertions survive line-wrapping. */
function normalized(rel) {
  return fs.readFileSync(path.join(REPO, rel), 'utf8').replace(/\s+/g, ' ');
}

/**
 * Assert a doc contains every expected count claim. Failure names the file AND the claim, and
 * prints the derived numbers so the fix is mechanical.
 * @param {string} rel repo-relative doc path
 * @param {Array<[string,string]>} claims `[label, expectedNormalizedSubstring]`
 */
function assertClaims(rel, claims) {
  const text = normalized(rel);
  const missing = claims.filter(([, expected]) => !text.includes(expected));
  assert.deepEqual(
    missing.map(([label]) => label),
    [],
    `STALE HOOK COUNT in ${rel} — ${missing.length} claim(s) do not match the wired set derived ` +
      `from settings.snippet.json.\n` +
      missing.map(([label, expected]) => `  • [${label}] expected to find: ${expected}`).join('\n') +
      `\n\nDERIVED TRUTH: ${C.registrations} registrations across ${C.scriptCount} scripts — ` +
      `${C.pre} PreToolUse (${C.bash} Bash + ${C.writeEdit} Write|Edit, all fail-closed/blocking), ` +
      `${C.ups} UserPromptSubmit (advisory), ` +
      `${C.observabilityRegistrations} post-tool registrations from ` +
      `${C.observabilityScripts} observability script(s).\n` +
      `FIX ${rel} (do not "fix" this test unless settings.snippet.json genuinely changed).`
  );
}

// ───────────────────────────── (1) derivation sanity ─────────────────────────────

test('derived counts are self-consistent with settings.snippet.json', () => {
  const summed = Object.values(C.perEvent).reduce((a, b) => a + b, 0);
  assert.equal(C.registrations, summed, 'registrations must equal the sum of the per-event counts');
  assert.equal(
    C.registrations,
    C.pre + C.ups + C.post + C.postFail,
    'the four known events must account for every registration — a NEW event was added and this ' +
      'guard does not know its blocking/advisory/observability category yet'
  );
  assert.equal(
    C.registrations - C.scriptCount,
    C.extraRegistrations,
    `registrations (${C.registrations}) minus distinct scripts (${C.scriptCount}) must equal the ` +
      `extra registrations contributed by multi-event scripts ` +
      `(${JSON.stringify(C.multiEventScripts)})`
  );
  assert.equal(C.pre, C.bash + C.writeEdit, 'every PreToolUse registration is Bash or Write|Edit');
  assert.ok(C.registrations > 0 && C.scriptCount > 0, 'the snippet must wire something');
});

// ───────────────────────────── (2) the deliberately-unwired scripts ─────────────────────────────

test('doctor.cjs and preflight-shipped-paths.cjs exist but are NOT wired (and not documented as wired)', () => {
  const readmeTableScripts = gateTableScripts();
  for (const f of DELIBERATELY_UNWIRED) {
    assert.ok(fs.existsSync(path.join(HOOKS_DIR, f)), `hooks/${f} should exist on disk`);
    assert.ok(
      !C.scripts.has(f),
      `hooks/${f} is a CLI, not a hook — it must NOT appear in settings.snippet.json`
    );
    assert.ok(
      !readmeTableScripts.has(f),
      `hooks/${f} is deliberately unwired — it must NOT be listed in README.md's gate-reference table`
    );
  }
});

// ───────────────────────────── (4) README gate table == wired set ─────────────────────────────

/** Parse the `| `<name>.cjs` | <event> | ...` rows out of README.md's gate-reference table. */
function gateTableScripts() {
  const lines = fs.readFileSync(path.join(REPO, README), 'utf8').split('\n');
  const found = new Set();
  for (const line of lines) {
    const m = line.match(/^\|\s*`([A-Za-z0-9._-]+\.cjs)`\s*\|/);
    if (m) found.add(m[1]);
  }
  return found;
}

test('README.md gate-reference table enumerates EXACTLY the wired script set', () => {
  const documented = gateTableScripts();
  const undocumented = [...C.scripts].filter((f) => !documented.has(f)).sort();
  const phantom = [...documented].filter((f) => !C.scripts.has(f)).sort();
  assert.deepEqual(
    { undocumented, phantom },
    { undocumented: [], phantom: [] },
    `README.md gate-reference table is out of sync with settings.snippet.json.\n` +
      `  • WIRED BUT UNDOCUMENTED (add a table row): ${JSON.stringify(undocumented)}\n` +
      `  • DOCUMENTED BUT NOT WIRED (remove the row): ${JSON.stringify(phantom)}\n` +
      `The table must list all ${C.scriptCount} wired scripts — the blocking gates plus the ` +
      `non-blocking advisory/observability hooks.`
  );
  assert.equal(documented.size, C.scriptCount, `the table should have ${C.scriptCount} script rows`);
});

// ───────────────────────────── (3) README.md primary claims ─────────────────────────────

test('README.md primary hook-count claims match the derived wired set', () => {
  assertClaims(README, [
    [
      'headline registrations/scripts',
      `**${C.registrations} hook registrations across ${C.scriptCount} hook scripts**`,
    ],
    [
      'headline PreToolUse split',
      `**${C.pre} fail-closed \`PreToolUse\` gates** (${C.bash} on \`Bash\`, ${C.writeEdit} on \`Write\`/\`Edit\`)`,
    ],
    ['headline "only these block"', `Only the ${C.pre} \`PreToolUse\` gates block`],
    ['contributor-workflow blocking count', `**${C.pre} fail-closed \`PreToolUse\` gates**`],
    ['contributor-workflow wired-set size', `the wired set of ${C.registrations} registrations`],
    ['share-form bundle script count', `**${C.scriptCount} hook scripts** (the ${C.pre} fail-closed \`PreToolUse\` gates`],
    ['share-form bundle registration total', `= **${C.registrations} wired registrations**`],
    [
      'directory-layout capabilities row',
      `the bundled \`hooks/\` (${C.scriptCount} scripts / ${C.registrations} wired registrations)`,
    ],
    ['remote-install bundle contents', `the ${C.scriptCount} hook scripts + 2 skills + 5 commands`],
  ]);
});

// ───────────────────────────── (5) docs/guides ─────────────────────────────

test('docs/guides/overview.md primary hook-count claims match the derived wired set', () => {
  assertClaims(OVERVIEW, [
    [
      'enforcement-row headline',
      `**${C.registrations} harness-run hook registrations across ${C.scriptCount} hook scripts**`,
    ],
    [
      'enforcement-row breakdown',
      `${C.pre} fail-closed \`PreToolUse\` gates (${C.bash} on \`Bash\`, ${C.writeEdit} on \`Write\`/\`Edit\`) + ` +
        `${C.ups} advisory \`UserPromptSubmit\` reminder + ${C.observabilityScripts} observability recorder`,
    ],
    ['enforcement-row "only these block"', `Only the ${C.pre} \`PreToolUse\` gates block`],
    ['share-form row', `bundling the ${C.scriptCount} hook scripts + 2 skills + 5 commands`],
  ]);
});

test('docs/guides/contributor-guide.md keeps the install line count-free (drift-proof phrasing)', () => {
  const text = normalized(CONTRIB_GUIDE);
  assert.ok(
    text.includes('marker-tag every wired hook'),
    `docs/guides/contributor-guide.md should describe the install as marker-tagging "every wired ` +
      `hook" rather than naming a number — the count-free phrasing cannot drift. If you reintroduce ` +
      `a number there, add it to this guard.`
  );
});

// ───────────────────────────── (6) published-capability README ─────────────────────────────

const SPELLED = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen',
  'nineteen', 'twenty',
];

test('capabilities/contribution-toolkit/README.md primary hook-count claims match the derived wired set', () => {
  assert.ok(C.pre < SPELLED.length, `no spelled-out form for ${C.pre} — extend SPELLED`);
  assertClaims(CAP_README, [
    [
      'intro spelled-out gate count',
      `${SPELLED[C.pre]} fail-closed \`PreToolUse\` enforcement hooks`,
    ],
    [
      "what's-included gates row",
      `| \`PreToolUse\` gates (fail-closed — these block) | ${C.pre} |`,
    ],
    [
      "what's-included advisory row",
      `| \`UserPromptSubmit\` advisory (never denies) | ${C.ups} |`,
    ],
    [
      "what's-included observability row",
      `| \`PostToolUse\` + \`PostToolUseFailure\` observability (never denies) | ` +
        `${C.observabilityScripts} script / ${C.observabilityRegistrations} registrations |`,
    ],
    [
      'scripts-vs-registrations note',
      `That is **${C.scriptCount} hook scripts** producing **${C.registrations} \`hooks[]\` registrations**`,
    ],
    ['consent disclosure', `executable surfaces (the ${C.scriptCount} hook scripts)`],
    ['how-it-works gate count', `The ${C.pre} \`PreToolUse\` gates are written into \`settings.json\``],
    ['honesty-section gate count', `property of the ${C.pre} \`PreToolUse\` hooks`],
  ]);
});

test('capabilities/contribution-toolkit/README.md names every wired script', () => {
  const text = fs.readFileSync(path.join(REPO, CAP_README), 'utf8');
  const missing = [...C.scripts]
    .map((f) => f.replace(/\.cjs$/, ''))
    .filter((stem) => !text.includes('`' + stem + '`'))
    .sort();
  assert.deepEqual(
    missing,
    [],
    `capabilities/contribution-toolkit/README.md does not mention these wired scripts: ` +
      `${JSON.stringify(missing)}. The published README is what an adopter reads — every wired ` +
      `hook must be named there (blocking gates in the coverage table, non-blocking ones in the ` +
      `note beneath it).`
  );
});

// ───────────────────────────── (7) capability.json parity ─────────────────────────────

test('capability.json hooks[] matches the snippet registrations + per-event breakdown', () => {
  const manifest = JSON.parse(fs.readFileSync(CAP_MANIFEST, 'utf8'));
  const hooks = manifest.hooks || [];
  assert.equal(
    hooks.length,
    C.registrations,
    `capability.json declares ${hooks.length} hooks[] entries but settings.snippet.json wires ` +
      `${C.registrations}. Re-run: node bin/build-capability.cjs`
  );
  for (const [event, expected] of Object.entries(C.perEvent)) {
    const got = hooks.filter((h) => h.event === event).length;
    assert.equal(got, expected, `capability.json ${event} entries: got ${got}, snippet has ${expected}`);
  }
});

// ───────────────────────────── (8) generic stale-number scan ─────────────────────────────

const SCANNED_DOCS = [README, OVERVIEW, CONTRIB_GUIDE, CAP_README];

/**
 * Strip the constructs that look like "<number> <hook-noun>" but are not counts:
 * phase/wave/plan/tier identifiers, version strings, issue numbers, ADR ids.
 */
function stripNonCounts(line) {
  return line
    .replace(/\bPhase\s+\d+(?:\s*\/\s*\d+)?/gi, 'Phase')
    .replace(/\bWave\s+\d+(?:\s*-\s*\d+)?/gi, 'Wave')
    .replace(/\bTier-\d+/gi, 'Tier')
    .replace(/\bplan\s+\d+-\d+/gi, 'plan')
    .replace(/\bADR-\d+/gi, 'ADR')
    .replace(/\bv\d+(?:\.\d+)*/gi, 'vX')
    .replace(/#\d+/g, '#N')
    .replace(/\bL\d\b/g, 'L');
}

const ADJECTIVES =
  '(?:(?:fail-closed|fail-open|advisory|blocking|non-blocking|harness-run|wired|marker-tagged|' +
  'tagged|PreToolUse|UserPromptSubmit|PostToolUseFailure|PostToolUse|post-tool|observability|' +
  'bundled|enforcement|Bash|`[^`]+`)[ /+-]+)*';
const NOUNS = 'hook registrations?|hook entries|hook scripts|hooks?|gates?';
const SCAN_RE = new RegExp(
  '\\b(' + SPELLED.join('|') + '|\\d{1,3})\\s+' + ADJECTIVES + '(' + NOUNS + ')\\b',
  'gi'
);

function numeric(token) {
  const i = SPELLED.indexOf(String(token).toLowerCase());
  return i >= 0 ? i : Number(token);
}

test('no stale numeral sits in front of a hook/gate noun in the covered docs', () => {
  // Allowed values per noun, all derived. Documented so a failure explains itself.
  const nonBlocking = C.advisory + C.observabilityScripts;
  const allowed = {
    registrations: new Set([C.registrations]),
    scripts: new Set([C.scriptCount]),
    // "gates" may legitimately name the blocking total, the Bash subset, the Write|Edit subset,
    // or a single gate.
    gates: new Set([1, C.writeEdit, C.bash, C.pre]),
    // "hooks" is the ambiguous noun: it may mean the blocking gates, the distinct scripts, the
    // registration total, the non-blocking pair, or a single hook.
    hooks: new Set([1, nonBlocking, C.pre, C.scriptCount, C.registrations]),
  };
  const bucketFor = (noun) => {
    const n = noun.toLowerCase();
    if (n.startsWith('hook registration') || n.startsWith('hook entr')) return 'registrations';
    if (n.startsWith('hook script')) return 'scripts';
    if (n.startsWith('gate')) return 'gates';
    return 'hooks';
  };

  const offenders = [];
  for (const rel of SCANNED_DOCS) {
    fs.readFileSync(path.join(REPO, rel), 'utf8')
      .split('\n')
      .forEach((raw, idx) => {
        for (const m of stripNonCounts(raw).matchAll(SCAN_RE)) {
          const bucket = bucketFor(m[2]);
          const value = numeric(m[1]);
          if (!allowed[bucket].has(value)) {
            offenders.push(
              `${rel}:${idx + 1} — "${m[0].trim()}" claims ${value} ${bucket}; allowed: ` +
                `${[...allowed[bucket]].sort((a, b) => a - b).join(', ')}`
            );
          }
        }
      });
  }

  assert.deepEqual(
    offenders,
    [],
    `STALE HOOK/GATE COUNT(S) found by the generic scan:\n` +
      offenders.map((o) => '  • ' + o).join('\n') +
      `\n\nDERIVED TRUTH from settings.snippet.json: ${C.registrations} registrations across ` +
      `${C.scriptCount} scripts — ${C.pre} blocking PreToolUse gates (${C.bash} Bash + ` +
      `${C.writeEdit} Write|Edit), ${C.advisory} advisory UserPromptSubmit reminder, ` +
      `${C.observabilityScripts} observability recorder on ${C.observabilityRegistrations} post-tool events.`
  );
});
