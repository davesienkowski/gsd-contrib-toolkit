#!/usr/bin/env node
'use strict';

/**
 * hooks/git-commit-convention.cjs — PreToolUse(Bash) conventional-commit PREFIX gate
 * (ENF-16 deny + ENF-22 ask, HARD-01 fail-closed, HARD-04 robust-parse).
 *
 * The threat: a deadline-pressured (or AI) contributor commits a test fix mislabeled
 * `docs:` (or a commit with no recognized type at all). The prefix is NOT a style nit
 * in gsd-core: the release / hotfix cherry-pick filter BUCKETS on the conventional-commit
 * prefix, so a wrong-or-missing prefix routes a change into the wrong release lane. This
 * gate stops the obviously-malformed prefix at the PreToolUse boundary, BEFORE the commit
 * is created. (N7 gap — prefix-correctness matters beyond style.)
 *
 * SCOPE (deliberately narrow): this gate judges only the obvious-violation PREFIX SHAPE —
 * a recognized type immediately followed by an optional `(scope)`, optional `!`, then `:`.
 * It does NOT judge whether the chosen type is the SEMANTICALLY correct one for the diff
 * (a `docs:` that should be `test:` passes the shape check) — that semantic judgment is
 * out of scope and belongs to human/CI review. The obvious-violation class this gate
 * DENIES is: a recognized type NOT immediately followed by `(`/`!`/`:`, OR no recognized
 * type prefix at all.
 *
 * HARD-02 / TOOLKIT-OWNED (read OWNED_NOTE below). STATUS UPDATE 2026-07-27: gsd-core now
 * DOES ship a shared matcher — scripts/release-notes/conventional-title.cjs, exporting
 * HEADER_RE / classifyBucket / evaluatePrTitle, already consumed live by this toolkit at
 * gh-pr-create.cjs:804 via requireLiveScript. The #1549 repoint mandated below is therefore
 * dischargeable and is the NEXT change to this gate. It is deliberately not done in the same
 * change as the RECOGNIZED_TYPES fix, because that matcher validates PR TITLES while this
 * gate judges COMMIT SUBJECTS (consumer: the release-sdk cherry-pick filter,
 * CONTRIBUTING.md:185), and its HEADER_RE accepts ANY /^[a-z]+/ type — adopting it verbatim
 * would silently turn this gate into shape-only and drop the recognized-type vocabulary.
 * The paragraph below describes the position as of the gate's authoring and is retained for
 * provenance:
 *
 * gsd-core exposed NO reusable shared
 * conventional-commit / type-validation matcher at authoring time (#1549). `classifyTitle` in
 * scripts/release-notes/format-github-release-notes.cjs only buckets feat/fix → categories
 * and cannot judge a docs/test mislabel; the discord-release-summary strip-regex is a
 * private formatting helper, not an exported policy matcher. Per HARD-02 we may NOT pretend
 * to "call the repo's script" for a matcher that does not exist. So the toolkit OWNS this
 * obvious-prefix check, replicates gsd-core's release/cherry-pick prefix POLICY locally,
 * names it as ours in the deny reason, and is MANDATED to repoint at the LIVE shared
 * matcher (via requireLiveScript + a doctor shape-check) once gsd-core extracts one (#1549)
 * — exactly the LINKED_ISSUE_RE / BRANCH_NAME_RE H-A pattern in gh-pr-create.cjs. The
 * recognized-type set is DECLARED in this file (no fenced block copied from gsd-core).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ENF-22 (quick task 260731-ih5) — THE SAME POLICY, ONE VERB WIDER, AT A LOWER
 * SEVERITY. Origin: `.planning/seeds/SEED-enf16-misses-git-merge-implicit-commit.md`.
 *
 * ENF-16 above is keyed to the `git commit` VERB. But a CLEANLY-mergeable
 * `git merge <ref>` commits ITSELF — no `git commit` is ever issued — so this gate was
 * never consulted, and on 2026-07-31 git's generated subject
 * `Merge remote-tracking branch 'origin/next' into fix/2570-…` landed on a gsd-core PR
 * branch: exactly the shape ENF-16 exists to stop. The seed records the inversion worth
 * remembering — a CONFLICTED merge is accidentally safe (it forces an explicit
 * `git commit -F <file>`, which ENF-16 DOES gate); only the CLEAN merge, which feels
 * lower-risk, evades. The general lesson: a gate keyed to a command NAME covers that
 * verb, not the OUTCOME.
 *
 * WHY `ask` AND NOT `deny` (CTK-ADR-0005 §Decision.2 — the epistemics are the point):
 * the two rules differ in what they KNOW.
 *   - ENF-16 judges a subject ASSERTED IN THE COMMAND. Conclusive → deny is admissible.
 *   - ENF-22 PREDICTS a subject that may never come into existence. A merge that
 *     fast-forwards creates no commit at all, and this gate is pure — it runs no git
 *     queries — so it cannot distinguish the two cases. Every fast-forwardable merge is
 *     a false positive BY CONSTRUCTION, so the FPR is structurally non-zero and
 *     unmeasured, and CTK-ADR-0005 makes deny inadmissible: "a signal with real recall
 *     but material noise belongs at `ask`."
 * The ADR's admissibility test for `ask` is also met: an ask reduces to allow on an
 * unattended run, so it must never carry a check unsafe to wave through. Waving this one
 * through yields a git-default merge subject — a changelog/cherry-pick routing defect
 * recoverable by `git commit --amend -F <file>`, itself POLICY-02-gated.
 *
 * SCOPE LOCK — Fix Option 2 ONLY. Nothing in this file parses, validates, or reasons
 * about a git-GENERATED merge subject (the seed's rejected Option 1). It advises the safe
 * form instead. An author-supplied `-m`/`-F` on a merge is NOT a generated subject — it is
 * asserted in the command exactly as for `git commit` — so it routes to the EXISTING
 * checkPrefix and stays in the conclusive class. Do not add generated-subject parsing here.
 *
 * NARROWS-NOT-WEAKENS (D6 ordering, asserted in the suite): the ENF-16 commit path runs
 * FIRST and its deny is returned unchanged. The merge path is reachable only when the
 * commit path produced no deny, so no ENF-16 deny that exists today can become an ask.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Architecture (inherited from Waves 1-2, never re-implemented here):
 *   - argv.parseCommand        → robust char-by-char parse, fail-closed on unparseable
 *   - classify.classifyAction  → `git commit` (and equivalent forms) → action:'commit'
 *   - failclosed.runGate       → a thrown error DENIES; only a logged override allows
 *   - resolve.resolveGsdCoreRoot→ a commit OUTSIDE a gsd-core checkout is not our concern
 *
 * Message resolution (the part this gate owns):
 *   -m / --message <subject>   → the FIRST -m/--message is the subject line (repeated -m
 *                                are body paragraphs; we judge the subject only)
 *   --message=<subject>        → inline form
 *   -F / --file <path>         → read the file from disk (subject = first line)
 *   -F - / --file -            → message arrives on the tool's STDIN, which a PreToolUse
 *                                hook CANNOT observe → fail closed DENY (HARD-04)
 *   (no -m and no -F)          → interactive editor commit, no asserted message to judge →
 *                                pass through as allow (never fail-closed on a legitimately
 *                                message-less commit, T-07-01-OVERBLOCK)
 *
 * @module hooks/git-commit-convention
 */

const path = require('node:path');
const { parseCommand } = require('./lib/argv.cjs');
const {
  classifyAction, findActionSegment, isNonGovernedCommand,
  // ENF-22: the merge path must trigger on the CF-05 all-segments chokepoint, not on
  // classifyAction().action — a chain collapses to its legacy action, so
  // `git merge x && git push` reports `push` and a first-result trigger misses the merge.
  hasGovernedSegment, resolveProgram, MERGE_SIDE_ACTIONS,
} = require('./lib/classify.cjs');
const { runGate, readHookInput, deny, allow, ask, emit, FailClosed, safeCommand } = require('./lib/failclosed.cjs');
const { resolveGsdCoreRoot, commandStartDir, ScriptResolveError } = require('./lib/resolve.cjs');

// FailClosed/safeCommand are the shared IN-03 helpers from failclosed.cjs (runGate's
// catch turns any throw into a DENY unless a logged override is present).

// `git commit` (ENF-16) and `git merge` (ENF-22) are gated. Every other action (push,
// pr-create, git reads, non-git) passes through as a no-op allow so the gate never
// over-blocks (T-07-01-OVERBLOCK).
//
// This set is consumed by isNonGovernedCommand, which scans ALL chained segments — so a
// merge hidden after a benign first segment keeps the gate on its resolve→gate path
// instead of short-circuiting to allow.
const MERGE_ACTION = 'merge';
const TRIGGER_ACTIONS = new Set(['commit', MERGE_ACTION]);

// TOOLKIT-OWNED recognized conventional-commit types. DECLARED here (no fenced block copied
// from gsd-core). This mirrors the type vocabulary gsd-core's release/cherry-pick filter
// buckets on; it is the toolkit's own replica pending the #1549 shared matcher.
//
// `enhance` and `feature` added 2026-07-27. Their absence made this gate STRICTER than
// gsd-core itself, denying commits the repo documents as correct:
//   - CONTRIBUTING.md:250-251 gives `enhance(#1549): add PR-title validator` verbatim as an
//     example, and origin/next carries 11 `enhance(` commits against 0 `enh(`.
//   - conventional-title.cjs FEATURE_RE is /^feat(?:ure)?\s*(?:\(|!|:)/i, so gsd-core accepts
//     the `feature` spelling too.
// Falling back to `feat(` when blocked is NOT a safe workaround: classifyBucket() buckets
// feat* as Feature, so an enhancement committed as `feat` is silently misfiled in the
// changelog. Longer alternatives are listed before their prefixes so the alternation in
// PREFIX_RE matches `feature` rather than stopping at `feat`.
const RECOGNIZED_TYPES = [
  'feature', 'feat', 'fix', 'docs', 'chore', 'ci', 'refactor', 'test', 'build', 'perf',
  'style', 'revert', 'enhance',
];

// The obvious-prefix SHAPE rule: a recognized type immediately followed by an optional
// `(scope)`, an optional `!`, then a `:`. Anything else (recognized type without the
// separator, or no recognized type at all) is the obvious-violation class → DENY.
const PREFIX_RE = new RegExp(
  '^(?:' + RECOGNIZED_TYPES.join('|') + ')(?:\\([^)]*\\))?!?:'
);

// TOOLKIT-OWNED note (mirror gh-pr-create.cjs OWNED_NOTE). Names this as the toolkit's own
// check and mandates the repoint at the LIVE shared matcher once #1549 extracts one.
const OWNED_NOTE =
  'This is the toolkit’s own conventional-commit PREFIX check (ENF-16) — a replica of ' +
  'gsd-core’s release / cherry-pick prefix policy, NOT a callable repo script. gsd-core NOW ' +
  'ships a shared PR-TITLE matcher (scripts/release-notes/conventional-title.cjs, exporting ' +
  'HEADER_RE / classifyBucket / evaluatePrTitle), so the #1549 repoint is finally ' +
  'dischargeable and is tracked as the next change to this gate — note it validates PR ' +
  'TITLES, while this gate judges COMMIT SUBJECTS, whose consumer is the release-sdk ' +
  'cherry-pick filter (CONTRIBUTING.md:185); the two policies overlap but are not identical, ' +
  'which is why the repoint is a deliberate change and not a drop-in. It judges PREFIX SHAPE ' +
  'only — choosing the semantically-correct type for the diff is out of scope.';


/**
 * Resolve the commit SUBJECT line from a parsed segment (TOOLKIT-OWNED resolution). Reads,
 * in order:
 *   1. the FIRST `-m` / `--message` / `--message=…` value (repeated -m are body paragraphs;
 *      the FIRST is the subject — never re-tokenize the raw string, scan structured tokens),
 *   2. else `-F` / `--file` / `--file=…` (read from disk via deps.readMessageFile; a
 *      `-`/stdin sentinel → throw FailClosed naming HARD-04),
 *   3. else null (no asserted message → caller allows: interactive editor commit).
 *
 * @param {Object} seg structured segment from argv.parseCommand
 * @param {(p:string)=>(string|null)} readMessageFile reads a commit-message file from disk
 * @returns {string|null} the subject line, or null when there is no asserted message
 */
function resolveCommitMessage(seg, readMessageFile) {
  // (1) -m / --message — scan the ORDERED structured tokens for the FIRST occurrence so a
  // multi-paragraph `-m subject -m body` correctly takes `subject` as the subject line.
  const tokens = Array.isArray(seg.tokens) ? seg.tokens : [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '-m' || t === '--message') {
      const v = tokens[i + 1];
      if (typeof v === 'string') return firstLine(v);
      // -m with no following value: malformed → fail closed.
      throw new FailClosed('git commit -m given without a message value — failing closed (HARD-04)');
    }
    if (typeof t === 'string' && t.startsWith('--message=')) {
      return firstLine(t.slice('--message='.length));
    }
    if (typeof t === 'string' && t.startsWith('-m') && t.length > 2) {
      // -msubject bundled short form.
      return firstLine(t.slice(2));
    }
  }

  // (2) -F / --file — read the message from disk; stdin sentinel fails closed.
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    let filePath = null;
    if (t === '-F' || t === '--file') {
      filePath = tokens[i + 1];
    } else if (typeof t === 'string' && t.startsWith('--file=')) {
      filePath = t.slice('--file='.length);
    } else if (typeof t === 'string' && t.startsWith('-F') && t.length > 2) {
      filePath = t.slice(2);
    }
    if (filePath == null) continue;
    if (filePath === '-') {
      throw new FailClosed(
        'commit message is read from stdin (git commit -F -), which a PreToolUse hook ' +
          'cannot observe — failing closed (HARD-04): cannot confirm the prefix convention'
      );
    }
    const content = readMessageFile(filePath);
    if (typeof content !== 'string') {
      throw new FailClosed('could not read commit message file ' + filePath + ' — failing closed');
    }
    return firstLine(content);
  }

  // (3) No asserted message — interactive editor commit. Nothing to judge → allow.
  return null;
}

/**
 * The first non-empty line of a message (the conventional-commit subject). Trims a leading
 * UTF-8 BOM and surrounding whitespace.
 *
 * WR-03 model: the subject boundary is the first REAL newline only (the `\n` control char).
 * A literal backslash-n in a single-quoted body (token `fix: a\nb`) is part of the subject,
 * NOT a boundary — and a double-quoted `-m "a\nb"` is collapsed by tokenize to `anb` (the
 * backslash is consumed) before this function ever sees it. Splitting on the literal two-char
 * `\\n` was a quoting-dependent divergence: it truncated single-quoted subjects (e.g. a regex
 * or path containing `\n`) while having no effect on the double-quoted form. Treating only the
 * real newline as the boundary makes both quoting forms judge the SAME subject and removes the
 * silent-truncation hazard.
 *
 * @param {string} s
 * @returns {string}
 */
function firstLine(s) {
  if (typeof s !== 'string') return '';
  const noBom = s.replace(/^﻿/, '');
  // Subject boundary = first REAL newline only (WR-03). Literal backslash-n is NOT a boundary.
  const idx = noBom.indexOf('\n');
  const line = idx === -1 ? noBom : noBom.slice(0, idx);
  return line.trim();
}

/**
 * Apply the TOOLKIT-OWNED obvious-prefix SHAPE rule to a commit subject. PASSES only when
 * the subject begins with a recognized type immediately followed by an optional `(scope)`,
 * an optional `!`, then `:`. Otherwise DENIES (recognized type without the separator, or no
 * recognized type at all). A null subject (no asserted message) is NOT this function's
 * concern — the caller short-circuits to allow before calling.
 *
 * @param {string} subject the commit subject line
 * @returns {{ok:boolean, reason?:string}}
 */
function checkPrefix(subject) {
  if (typeof subject !== 'string' || subject.length === 0) {
    // An empty subject with an asserted message flag is a malformed prefix → deny.
    return {
      ok: false,
      reason:
        'Commit subject is empty — it cannot carry a conventional-commit prefix. ' + OWNED_NOTE,
    };
  }
  if (PREFIX_RE.test(subject)) {
    return { ok: true };
  }
  return {
    ok: false,
    reason:
      'Commit subject `' +
      subject +
      '` has an OBVIOUSLY-malformed conventional-commit prefix: it must begin with a ' +
      'recognized type (' +
      RECOGNIZED_TYPES.join('|') +
      ') immediately followed by an optional `(scope)`, optional `!`, then `:` — e.g. ' +
      '`fix(core): …`, `feat!: …`, `docs: …`. ' +
      OWNED_NOTE,
  };
}

// ENF-22 exemption vocabulary (D5). Each entry is a form that provably cannot produce an
// UNASSERTED commit, so asking about it would be pure noise — and CTK-ADR-0005 §Decision.5
// makes noise a first-class budget: a prompt that fires on correct work trains the human to
// dismiss it, which destroys more value than the signal adds.
//
//   --squash   git implies --no-commit; it stages the result and REQUIRES a later
//              `git commit`, which ENF-16 already gates.
//   --ff-only  either fast-forwards (no commit at all) or exits with an error. It can
//              never create a merge commit.
//
// DELIBERATELY ABSENT, and both belong in the ask class:
//   --no-ff    FORCES a merge commit — the strongest case for asking, not an exemption.
//   --no-edit  accepts git's generated subject — the exact live defect the seed records.
const MERGE_NO_COMMIT_FLAGS = new Set(['--squash', '--ff-only']);

// Operation-control forms. They take no ref and conclude/discard an IN-PROGRESS merge, so
// they are outside the locked `git merge <ref>` trigger shape.
//
// RECORDED RESIDUAL (honest, not silently dropped): `--continue` DOES create a commit with
// git's generated subject when concluding a conflicted merge. It is a same-outcome,
// different-verb route this rule does not cover — the identical class of gap the seed
// records for `git merge` itself, one level down. Captured as a follow-up seed rather than
// expanded into here, because the locked scope is a bare `git merge <ref>`.
const MERGE_CONTROL_FLAGS = new Set(['--abort', '--quit', '--continue']);

/**
 * ENF-22: decide a `git merge` segment.
 *
 * Reads the ORDERED `seg.tokens` (the resilient source: argv folds a long flag and its
 * following token into one flags entry, so a ref appearing after `--no-commit` is not
 * reliably a positional), and resolves in this order:
 *
 *   1. an operation-control form (`--abort`/`--quit`/`--continue`)          → allow
 *   2. a flag that makes git skip the commit (`--squash`/`--ff-only`)       → allow
 *   3. `--no-commit` not overridden by a LATER `--commit` (git is last-wins)→ allow
 *   4. no ref argument at all (nothing to name in a remediation)            → allow
 *   5. an AUTHOR-asserted subject (`-m`/`--message`/`-F`/`--file`)          → CONCLUSIVE:
 *      hand it to the existing ENF-16 checkPrefix, verdict returned unchanged
 *   6. otherwise                                                            → PREDICTIVE: ask
 *
 * @param {Object} seg structured segment from argv.parseCommand
 * @param {(p:string)=>(string|null)} readMessageFile reads a merge-message file from disk
 * @returns {{permissionDecision:string, permissionDecisionReason?:string}}
 */
function gateMerge(seg, readMessageFile) {
  const tokens = Array.isArray(seg.tokens) ? seg.tokens : [];

  let sawNoCommit = false;
  for (const t of tokens) {
    if (typeof t !== 'string') continue;
    if (MERGE_CONTROL_FLAGS.has(t)) return allow();
    if (MERGE_NO_COMMIT_FLAGS.has(t)) return allow();
    // git resolves a repeated `--no-commit --commit` by LAST occurrence, so scan the
    // whole ordered list and let the last of the pair decide rather than returning early.
    //
    // TRAP — DO NOT "FIX" THIS BY ACCEPTING `-n`: on `git merge`, `-n` is `--no-stat`
    // (it suppresses the diffstat), NOT an abbreviation of `--no-commit`. It means
    // `--no-verify` on `git commit`, which is where the false intuition comes from.
    // Treating `-n` as an exemption would silently disarm ENF-22.
    if (t === '--no-commit') sawNoCommit = true;
    else if (t === '--commit') sawNoCommit = false;
  }
  if (sawNoCommit) return allow();

  // The ref: resolveProgram already strips git global-option VALUES (`-C <path>`,
  // `--git-dir <d>`, …) and wrapper builtins, so args[0] is the verb and the rest are the
  // merge's own non-flag arguments. No ref → git has nothing to merge that we could name
  // in a remediation (and it commonly errors on no configured upstream) → allow.
  const { args } = resolveProgram(seg);
  const refs = args.slice(1);
  if (refs.length === 0) return allow();

  // CONCLUSIVE class. An author-supplied message is asserted in the command exactly as it
  // is for `git commit`, so it is judgeable with certainty — reuse ENF-16's own resolution
  // and shape rule verbatim rather than inventing a second policy. This is NOT Option 1:
  // nothing here reads a git-GENERATED subject. (May throw FailClosed on `-F -` / a
  // valueless `-m`, which is the same HARD-04 discipline the commit path applies.)
  const subject = resolveCommitMessage(seg, readMessageFile);
  if (subject != null) {
    const verdict = checkPrefix(subject);
    return verdict.ok ? allow() : deny(verdict.reason);
  }

  // PREDICTIVE class → ask (CTK-ADR-0005 §Decision.2).
  return ask(
    'ENF-22: this `git merge` will COMMIT BY ITSELF if it does not fast-forward, and the ' +
      'subject of that commit is generated by git — not asserted by you — so it lands ' +
      'as `Merge remote-tracking branch \'…\' into …`. gsd-core BUCKETS the ' +
      'release / hotfix cherry-pick filter on the conventional-commit prefix, so that ' +
      'subject routes the change into the wrong release lane. ENF-16 never sees it: no ' +
      '`git commit` is ever issued.\n\n' +
      'Remediation — split the merge from the commit so the subject is yours:\n' +
      '  git merge <ref> --no-commit --no-ff\n' +
      '  git commit -F <message-file>\n' +
      'That follow-up `git commit` is itself gated by ENF-16, so the prefix is checked ' +
      'the way every other commit is, and it composes with HARD-04 message-file discipline.\n\n' +
      'This PROMPTS rather than BLOCKS because a merge that fast-forwards creates no ' +
      'commit at all, and this hook is pure — it runs no git queries — so it cannot tell ' +
      'the two cases apart. Approve if you know this one fast-forwards or you intend to ' +
      'amend the subject afterwards (`git commit --amend -F <file>`, itself POLICY-02-gated). ' +
      OWNED_NOTE
  );
}

/**
 * The pure gate decision with all impure dependencies injected (deps) so it is unit
 * testable without a real gsd-core checkout or filesystem. Wrapped by runGate at the
 * module entry so any throw → fail-closed DENY.
 *
 * @param {string} stdinString raw PreToolUse JSON on stdin
 * @param {Object} deps
 * @param {(p:string)=>(string|null)} deps.readMessageFile reads a commit-message file
 * @returns {{permissionDecision:string, permissionDecisionReason?:string}}
 */
function gate(stdinString, deps) {
  const input = readHookInput(stdinString); // throws on malformed → fail closed
  const command = (input.tool_input && input.tool_input.command) || '';

  const parsed = parseCommand(command);
  if (!parsed.ok) {
    // Unparseable → cannot confidently classify → fail closed (HARD-04).
    throw new FailClosed('unparseable command: ' + parsed.reason);
  }

  const action = classifyAction(parsed);
  if (action.failClosed) {
    throw new FailClosed('unclassifiable mutating call — failing closed (HARD-04)');
  }
  // ── D6 ORDERING RULE: the ENF-16 COMMIT PATH RUNS FIRST ────────────────────────
  // Its trigger is unchanged (classifyAction().action === 'commit', exactly as before
  // ENF-22) and its DENY is returned untouched. That is what makes narrows-not-weakens
  // provable rather than argued: the merge path below is unreachable for any command
  // this path denies, so no ENF-16 deny can decay into an ask (T-ih5-04).
  if (action.action === 'commit') {
    const seg = findActionSegment(parsed, 'commit');
    const subject = resolveCommitMessage(seg, deps.readMessageFile); // may throw FailClosed
    // A null subject is an interactive editor commit — nothing asserted to judge.
    if (subject != null) {
      const verdict = checkPrefix(subject);
      if (!verdict.ok) {
        return deny(verdict.reason);
      }
    }
    // No deny from the commit path → fall through; a chain may still carry a merge.
  }

  // ── ENF-22 MERGE PATH ──────────────────────────────────────────────────────────
  // Triggered on the CF-05 all-segments chokepoint, NOT on classifyAction().action: the
  // classifier collapses a chain to its legacy action by design, so `git merge x &&
  // git push` reports `push` and a first-result trigger would never see the merge.
  if (hasGovernedSegment(parsed, MERGE_SIDE_ACTIONS)) {
    return gateMerge(findActionSegment(parsed, MERGE_ACTION), deps.readMessageFile);
  }

  // Neither a commit nor a merge → not our concern → no-op allow.
  return allow();
}

/**
 * Injectable entry seam used by the test suite. Builds the runGate ctx (worktreeRoot for
 * the override receipt) and the file-reader dep, resolving the gsd-core root from the
 * command's OWN cwd; a commit OUTSIDE a gsd-core checkout returns allow (not our concern),
 * exactly like lint-ci-marker.cjs.
 *
 * @param {string} stdinString raw PreToolUse JSON
 * @param {Object} [deps]
 * @param {(p:string)=>(string|null)} [deps.readMessageFile]
 * @param {string} [deps.worktreeRoot]
 * @param {{checkOverride:Function, writeReceipt:Function}} [deps.overrideImpl]
 * @returns {{permissionDecision:string, permissionDecisionReason?:string}}
 */
function runCommitConventionGate(stdinString, deps = {}) {
  const ctx = {
    command: safeCommand(stdinString),
    action: 'commit',
    // OBS-02: read ONLY for session/tool ids in the verdict log; never logged verbatim.
    stdin: stdinString,
    worktreeRoot: deps.worktreeRoot,
    overrideImpl: deps.overrideImpl,
  };

  return runGate(() => {
    // RES-01 (D-07 uniformity): classify the governed action FIRST (pure parse→classify,
    // no filesystem) and short-circuit a confidently non-governed command to allow() BEFORE
    // resolveGsdCoreRoot walks the tree. A non-commit command no longer pays a filesystem
    // walk, and a missing LIVE script under a resolved root cannot collateral-deny it. The
    // shared isNonGovernedCommand narrows-not-weakens: unparseable/failClosed/`commit`
    // fall through to the unchanged resolve→gate path below (a governed commit still DENIES).
    if (isNonGovernedCommand(parseCommand(ctx.command), TRIGGER_ACTIONS)) return allow();

    const resolved = Object.assign({}, deps);

    // Resolve the gsd-core root from the command's OWN cwd (it may `cd` into a worktree).
    // A commit in a non-gsd-core checkout is not our concern → allow. An injected
    // worktreeRoot short-circuits the filesystem walk so the unit suite stays hermetic.
    if (!resolved.worktreeRoot) {
      try {
        resolved.worktreeRoot = resolveGsdCoreRoot(
          commandStartDir(parseCommand(ctx.command), process.cwd())
        );
      } catch (err) {
        if (err instanceof ScriptResolveError) return allow();
        throw err;
      }
    }
    ctx.worktreeRoot = ctx.worktreeRoot || resolved.worktreeRoot;

    if (!resolved.readMessageFile) {
      const fs = require('node:fs');
      resolved.readMessageFile = (p) => {
        try {
          return fs.readFileSync(path.resolve(p), 'utf8');
        } catch (_) {
          return null;
        }
      };
    }
    return gate(stdinString, resolved);
  }, ctx);
}


// CLI entry: read stdin, run the gate, emit the PreToolUse decision envelope.
function main() {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => {
    buf += c;
  });
  process.stdin.on('end', () => {
    emit(runCommitConventionGate(buf));
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  runCommitConventionGate, gate, resolveCommitMessage, checkPrefix, firstLine,
  // ENF-22: exported so the docs-hook-counts / capability surface checks and any future
  // caller can read the governed set by name rather than re-typing string literals.
  gateMerge, TRIGGER_ACTIONS,
};
