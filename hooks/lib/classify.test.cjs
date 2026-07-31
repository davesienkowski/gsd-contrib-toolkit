'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { parseCommand } = require('./argv.cjs');
const {
  classifyAction, findActionSegment, isNonGovernedCommand, hasGovernedSegment,
  hasFailClosedSegment, resolveProgram,
  // ENF-20 (T1): the review-side action vocabulary + the PR-comment collapse contract.
  REVIEW_SIDE_ACTIONS, LEGACY_MUTATION_ACTIONS, PR_COMMENT_EQUIVALENT_ACTIONS,
  // ENF-22 (260731-ih5): the third-tier action vocabulary.
  MERGE_SIDE_ACTIONS,
} = require('./classify.cjs');

const cls = (cmd) => classifyAction(parseCommand(cmd));

// ---------------------------------------------------------------------------
// Native gh routes
// ---------------------------------------------------------------------------

test('gh issue create → issue-create / native', () => {
  assert.deepStrictEqual(cls('gh issue create --title x'), {
    action: 'issue-create',
    route: 'native',
  });
});

test('gh pr create → pr-create / native', () => {
  assert.deepStrictEqual(cls('gh pr create --title x'), {
    action: 'pr-create',
    route: 'native',
  });
});

test('gh issue edit → issue-edit / native', () => {
  assert.deepStrictEqual(cls('gh issue edit 12 --body y'), {
    action: 'issue-edit',
    route: 'native',
  });
});

test('gh pr edit → pr-edit / native', () => {
  assert.deepStrictEqual(cls('gh pr edit 12 --body y'), {
    action: 'pr-edit',
    route: 'native',
  });
});

test('git commit → commit', () => {
  assert.strictEqual(cls('git commit -m x').action, 'commit');
});

test('git push → push', () => {
  assert.strictEqual(cls('git push origin main').action, 'push');
});

// ---------------------------------------------------------------------------
// gh api synonym routes (ENF-15 / EP-1)
// ---------------------------------------------------------------------------

test('gh api -X POST repos/.../issues → issue-create / gh-api', () => {
  assert.deepStrictEqual(cls('gh api -X POST repos/OWNER/REPO/issues -f title=x'), {
    action: 'issue-create',
    route: 'gh-api',
  });
});

test('gh api -X POST repos/.../pulls → pr-create / gh-api', () => {
  assert.deepStrictEqual(cls('gh api -X POST repos/o/r/pulls -f title=x'), {
    action: 'pr-create',
    route: 'gh-api',
  });
});

test('gh api --method POST long-form → issue-create / gh-api', () => {
  assert.deepStrictEqual(cls('gh api --method POST repos/o/r/issues'), {
    action: 'issue-create',
    route: 'gh-api',
  });
});

test('gh api method is case-insensitive (post)', () => {
  assert.deepStrictEqual(cls('gh api -X post repos/o/r/issues'), {
    action: 'issue-create',
    route: 'gh-api',
  });
});

test('gh api path without /repos prefix still recognized', () => {
  assert.deepStrictEqual(cls('gh api -X POST /repos/o/r/issues'), {
    action: 'issue-create',
    route: 'gh-api',
  });
});

test('gh api -X PATCH .../issues/N → issue-edit / gh-api', () => {
  assert.deepStrictEqual(cls('gh api -X PATCH repos/o/r/issues/42'), {
    action: 'issue-edit',
    route: 'gh-api',
  });
});

test('gh api -X PATCH .../pulls/N → pr-edit / gh-api', () => {
  assert.deepStrictEqual(cls('gh api -X PATCH repos/o/r/pulls/42'), {
    action: 'pr-edit',
    route: 'gh-api',
  });
});

test('gh api POST inferred from -f field without explicit method', () => {
  assert.deepStrictEqual(cls('gh api repos/o/r/issues -f title=x'), {
    action: 'issue-create',
    route: 'gh-api',
  });
});

// ---------------------------------------------------------------------------
// curl synonym routes (ENF-15 / EP-1)
// ---------------------------------------------------------------------------

test('curl POST to api.github.com issues → issue-create / curl', () => {
  assert.deepStrictEqual(
    cls('curl -X POST https://api.github.com/repos/o/r/issues -d {}'),
    { action: 'issue-create', route: 'curl' }
  );
});

test('curl POST to api.github.com pulls → pr-create / curl', () => {
  assert.deepStrictEqual(
    cls('curl -X POST https://api.github.com/repos/o/r/pulls'),
    { action: 'pr-create', route: 'curl' }
  );
});

test('curl -XPOST bundled method → issue-create / curl', () => {
  assert.deepStrictEqual(
    cls('curl -XPOST https://api.github.com/repos/o/r/issues'),
    { action: 'issue-create', route: 'curl' }
  );
});

test('curl with -d implying POST → issue-create / curl', () => {
  assert.deepStrictEqual(
    cls('curl https://api.github.com/repos/o/r/issues -d @body.json'),
    { action: 'issue-create', route: 'curl' }
  );
});

test('curl PATCH to issues/N → issue-edit / curl', () => {
  assert.deepStrictEqual(
    cls('curl -X PATCH https://api.github.com/repos/o/r/issues/7'),
    { action: 'issue-edit', route: 'curl' }
  );
});

// ---------------------------------------------------------------------------
// FAIL CLOSED on unclassifiable mutating synonym
// ---------------------------------------------------------------------------

test('gh api POST to github issues with unmappable path → failClosed', () => {
  const r = cls('gh api -X POST repos/o/r/issues/weird/path/segments');
  assert.strictEqual(r.failClosed, true);
  assert.strictEqual(r.action, 'unknown');
});

test('curl POST to api.github.com issues with unmappable path → failClosed', () => {
  const r = cls('curl -X POST https://api.github.com/repos/o/r/issues/weird/extra');
  assert.strictEqual(r.failClosed, true);
  assert.strictEqual(r.action, 'unknown');
});

test('curl POST to api.github.com non-issues/pulls endpoint → other (out of THIS gate scope)', () => {
  const r = cls('curl -X POST https://api.github.com/repos/o/r/labels');
  assert.strictEqual(r.action, 'other');
  assert.notStrictEqual(r.failClosed, true);
});

// ---------------------------------------------------------------------------
// Member SUB-resource metadata (labels / assignees / reviewers) → other (G1)
//
// Governing applies to create (collection POST) + body/title edit (bare-member
// PATCH/PUT) ONLY. A mutating call to a member SUB-resource (OWNER/REPO/issues/N/
// labels, .../pulls/N/requested_reviewers, .../issues/N/assignees) is benign
// metadata — it cannot create or change an issue/PR title/body — so it must pass
// through as 'other', NEVER fail closed. The numeric member id distinguishes these
// from the genuinely-unmappable paths (non-numeric member) that MUST stay failClosed.
// ---------------------------------------------------------------------------

test('gh api POST .../issues/N/labels → other (add labels, not governed) [G1]', () => {
  const r = cls('gh api -X POST repos/o/r/issues/123/labels -f labels[]=bug');
  assert.strictEqual(r.action, 'other', JSON.stringify(r));
  assert.notStrictEqual(r.failClosed, true);
});

test('gh api PUT .../issues/N/labels → other (replace labels) [G1]', () => {
  const r = cls('gh api -X PUT repos/o/r/issues/123/labels -f labels[]=bug');
  assert.strictEqual(r.action, 'other', JSON.stringify(r));
  assert.notStrictEqual(r.failClosed, true);
});

test('gh api POST .../pulls/N/requested_reviewers → other (request reviewers) [G1]', () => {
  const r = cls('gh api -X POST repos/o/r/pulls/123/requested_reviewers -f reviewers[]=octocat');
  assert.strictEqual(r.action, 'other', JSON.stringify(r));
  assert.notStrictEqual(r.failClosed, true);
});

test('gh api POST .../issues/N/assignees → other (add assignees) [G1]', () => {
  const r = cls('gh api -X POST repos/o/r/issues/123/assignees -f assignees[]=octocat');
  assert.strictEqual(r.action, 'other', JSON.stringify(r));
  assert.notStrictEqual(r.failClosed, true);
});

test('gh api POST without /repos prefix .../issues/N/labels → other [G1]', () => {
  const r = cls('gh api -X POST /repos/o/r/issues/123/labels');
  assert.strictEqual(r.action, 'other', JSON.stringify(r));
  assert.notStrictEqual(r.failClosed, true);
});

test('curl POST to api.github.com .../pulls/N/requested_reviewers → other [G1]', () => {
  const r = cls('curl -X POST https://api.github.com/repos/o/r/pulls/123/requested_reviewers -d {}');
  assert.strictEqual(r.action, 'other', JSON.stringify(r));
  assert.notStrictEqual(r.failClosed, true);
});

// Regression guard: the sub-resource relaxation must NOT weaken EP-1. A mutating
// POST to a member that is NOT a clean numeric id (issues/weird/...) is still an
// unmappable github mutation and MUST fail closed.
test('gh api POST .../issues/<non-numeric>/... still failClosed [G1 guard]', () => {
  const r = cls('gh api -X POST repos/o/r/issues/weird/labels');
  assert.strictEqual(r.failClosed, true, JSON.stringify(r));
  assert.strictEqual(r.action, 'unknown');
});

// Regression guard: a POST to a BARE member id (not a sub-resource) is a
// mutating-but-mismatched call (you create at the collection, not the member) and
// stays failClosed — the relaxation only covers member sub-resources.
test('gh api POST .../issues/N (bare member, no sub) still failClosed [G1 guard]', () => {
  const r = cls('gh api -X POST repos/o/r/issues/123');
  assert.strictEqual(r.failClosed, true, JSON.stringify(r));
  assert.strictEqual(r.action, 'unknown');
});

// ---------------------------------------------------------------------------
// Read-only / unrelated → other (must ALLOW, not fail-closed)
// ---------------------------------------------------------------------------

test('gh repo view → other (not failClosed)', () => {
  const r = cls('gh repo view o/r');
  assert.strictEqual(r.action, 'other');
  assert.notStrictEqual(r.failClosed, true);
});

test('git status → other (not failClosed)', () => {
  const r = cls('git status');
  assert.strictEqual(r.action, 'other');
  assert.notStrictEqual(r.failClosed, true);
});

test('read-only gh api GET on issues → other (not failClosed)', () => {
  const r = cls('gh api repos/o/r/issues');
  assert.strictEqual(r.action, 'other');
  assert.notStrictEqual(r.failClosed, true);
});

test('gh api GET with -X GET explicit → other', () => {
  const r = cls('gh api -X GET repos/o/r/issues/3');
  assert.strictEqual(r.action, 'other');
  assert.notStrictEqual(r.failClosed, true);
});

test('curl GET (no method, no data) to api.github.com → other', () => {
  const r = cls('curl https://api.github.com/repos/o/r/issues');
  assert.strictEqual(r.action, 'other');
  assert.notStrictEqual(r.failClosed, true);
});

test('curl POST to a non-github host → other (out of scope)', () => {
  const r = cls('curl -X POST https://example.com/repos/o/r/issues');
  assert.strictEqual(r.action, 'other');
  assert.notStrictEqual(r.failClosed, true);
});

// ---------------------------------------------------------------------------
// Heredoc body must not derail classification (G3 end-to-end)
// ---------------------------------------------------------------------------

test('gh pr create --body-file - <<EOF (heredoc body) → pr-create [G3]', () => {
  const r = cls("gh pr create --title x --body-file - <<EOF\nit's fine; really\nEOF");
  assert.strictEqual(r.action, 'pr-create', JSON.stringify(r));
  assert.notStrictEqual(r.failClosed, true);
});

// ---------------------------------------------------------------------------
// Parser fail-closed propagation
// ---------------------------------------------------------------------------

test('unparseable command (ok:false parse) → failClosed', () => {
  const r = classifyAction(parseCommand('gh issue create --title "unterminated'));
  assert.strictEqual(r.failClosed, true);
  assert.strictEqual(r.action, 'unknown');
});

test('classifyAction tolerates a null/garbage parse → failClosed', () => {
  assert.strictEqual(classifyAction(null).failClosed, true);
  assert.strictEqual(classifyAction({}).failClosed, true);
});

// ---------------------------------------------------------------------------
// Multi-segment: any mutating segment classifies the whole command
// ---------------------------------------------------------------------------

test('chained: read-only ; gh issue create → issue-create', () => {
  const r = cls('git status ; gh issue create --title x');
  assert.strictEqual(r.action, 'issue-create');
});

test('chained synonym: echo hi && gh api -X POST repos/o/r/pulls → pr-create', () => {
  const r = cls('echo hi && gh api -X POST repos/o/r/pulls');
  assert.strictEqual(r.action, 'pr-create');
  assert.strictEqual(r.route, 'gh-api');
});

// Locks F-02: a chain whose segments are ALL non-actionable falls through to
// other (allow), never failClosed. This is the no-actionable-segment branch the
// removed dead ternary (`sawOther ? OTHER : OTHER`) covered — both arms returned
// OTHER, so collapsing to a single OTHER must preserve exactly this behavior.
test('chained: all read-only segments → other (not failClosed) [F-02]', () => {
  const r = cls('git status && gh repo view o/r ; echo done');
  assert.strictEqual(r.action, 'other');
  assert.notStrictEqual(r.failClosed, true);
});

// ---------------------------------------------------------------------------
// CR-01: git/gh global options must not push the verb out of reach
//
// `git -C <path>`, `git --no-pager`, `git -c key=val`, `git --git-dir <d>` are all
// legitimate, common forms of a commit/push. The classifier resolved the verb as
// subcommands[0] only; with a leading global option the verb lands in positionals
// (or is swallowed as a boolean global's "value") → action:'other' → silent allow.
// ---------------------------------------------------------------------------

test('CR-01: git -C /path commit → commit', () => {
  assert.strictEqual(cls('git -C /some/path commit --no-verify -m x').action, 'commit');
});

test('CR-01: git --no-pager commit → commit', () => {
  assert.strictEqual(cls('git --no-pager commit -m "docs fix thing"').action, 'commit');
});

test('CR-01: git -c key=val commit → commit', () => {
  assert.strictEqual(cls('git -c user.name=x commit -m y').action, 'commit');
});

test('CR-01: git --git-dir <d> commit → commit', () => {
  assert.strictEqual(cls('git --git-dir /tmp/x commit -m y').action, 'commit');
});

test('CR-01: git -C /p push → push', () => {
  assert.strictEqual(cls('git -C /p push origin HEAD').action, 'push');
});

test('CR-01: git --paginate push → push', () => {
  assert.strictEqual(cls('git --paginate push origin main').action, 'push');
});

test('CR-01: gh --repo o/r pr create → pr-create (verb past global option)', () => {
  const r = cls('gh --repo o/r pr create --title x');
  assert.strictEqual(r.action, 'pr-create');
});

// ---------------------------------------------------------------------------
// CR-02 (end-to-end): env-prefixed mutation classifies to its gated action
// ---------------------------------------------------------------------------

test('CR-02: GIT_DIR=/x git commit → commit', () => {
  assert.strictEqual(cls('GIT_DIR=/x git commit -m bad').action, 'commit');
});

test('CR-02: A=1 git push → push', () => {
  assert.strictEqual(cls('A=1 git push origin main').action, 'push');
});

// ---------------------------------------------------------------------------
// CR-03: path-qualified / wrapper-prefixed forms
//
// `/usr/bin/git`, `./git`, `command git`, `env git`, `/usr/bin/gh` are all the same
// mutation; an exact-string `program === 'git'` match missed every one of them.
// basename-normalize the program and advance past command/env/exec/sudo/nice.
// An UNRECOGNIZED wrapper around a mutating git/gh verb fails CLOSED (conservative).
// ---------------------------------------------------------------------------

test('CR-03: /usr/bin/git commit → commit', () => {
  assert.strictEqual(cls('/usr/bin/git commit -m bad').action, 'commit');
});

test('CR-03: ./git commit → commit', () => {
  assert.strictEqual(cls('./git commit -m bad').action, 'commit');
});

test('CR-03: command git commit → commit', () => {
  assert.strictEqual(cls('command git commit -m bad').action, 'commit');
});

test('CR-03: env git commit → commit', () => {
  assert.strictEqual(cls('env git commit -m bad').action, 'commit');
});

test('CR-03: sudo git push → push', () => {
  assert.strictEqual(cls('sudo git push origin main').action, 'push');
});

test('CR-03: /usr/bin/gh pr create → pr-create', () => {
  assert.strictEqual(cls('/usr/bin/gh pr create --title x').action, 'pr-create');
});

test('CR-03: command gh issue create → issue-create', () => {
  assert.strictEqual(cls('command gh issue create --title x').action, 'issue-create');
});

test('CR-03: a plain unrecognized program stays other (no git/gh underneath)', () => {
  const r = cls('command ls -la');
  assert.strictEqual(r.action, 'other');
  assert.notStrictEqual(r.failClosed, true);
});

test('CR-03 fail-closed: path-qualified UNMAPPABLE github mutation → failClosed', () => {
  const r = cls('/usr/bin/gh api -X POST repos/o/r/issues/weird');
  assert.strictEqual(r.failClosed, true, JSON.stringify(r));
  assert.strictEqual(r.action, 'unknown');
});

// ---------------------------------------------------------------------------
// CR-04: gh api / curl body-flag synonyms imply POST → create
//
// `gh api … --raw-field body=x` and `curl … --data-raw/--data-binary/--data-urlencode`
// are PR/issue-create synonyms. hasWriteBody only covered data/field/-d/-f/-F, so
// these long-flag forms fell through to no-method → other → silent allow.
// ---------------------------------------------------------------------------

test('CR-04: gh api --raw-field pulls → pr-create', () => {
  assert.deepStrictEqual(cls('gh api repos/o/r/pulls --raw-field body=x --raw-field base=next'), {
    action: 'pr-create',
    route: 'gh-api',
  });
});

test('CR-04: gh api --raw-field issues → issue-create', () => {
  assert.deepStrictEqual(cls('gh api repos/o/r/issues --raw-field title=x'), {
    action: 'issue-create',
    route: 'gh-api',
  });
});

test('CR-04: gh api --field issues → issue-create', () => {
  assert.deepStrictEqual(cls('gh api repos/o/r/issues --field title=x'), {
    action: 'issue-create',
    route: 'gh-api',
  });
});

test('CR-04: curl --data-raw pulls → pr-create', () => {
  assert.deepStrictEqual(cls('curl https://api.github.com/repos/o/r/pulls --data-raw {}'), {
    action: 'pr-create',
    route: 'curl',
  });
});

test('CR-04: curl --data-binary pulls → pr-create', () => {
  assert.deepStrictEqual(cls('curl https://api.github.com/repos/o/r/pulls --data-binary {}'), {
    action: 'pr-create',
    route: 'curl',
  });
});

test('CR-04: curl --data-urlencode pulls → pr-create', () => {
  assert.deepStrictEqual(cls('curl https://api.github.com/repos/o/r/pulls --data-urlencode k=v'), {
    action: 'pr-create',
    route: 'curl',
  });
});

// ---------------------------------------------------------------------------
// NO OVER-BLOCK regression (these MUST stay action:'other', NOT fail-closed)
// ---------------------------------------------------------------------------

test('no-over-block: git status stays other', () => {
  const r = cls('git status');
  assert.strictEqual(r.action, 'other');
  assert.notStrictEqual(r.failClosed, true);
});

test('no-over-block: git add . stays other (non-commit/push verb)', () => {
  const r = cls('git add .');
  assert.strictEqual(r.action, 'other');
  assert.notStrictEqual(r.failClosed, true);
});

test('no-over-block: git -C /p status stays other (global option, read-only verb)', () => {
  const r = cls('git -C /p status');
  assert.strictEqual(r.action, 'other');
  assert.notStrictEqual(r.failClosed, true);
});

test('no-over-block: gh repo view stays other', () => {
  const r = cls('gh repo view o/r');
  assert.strictEqual(r.action, 'other');
  assert.notStrictEqual(r.failClosed, true);
});

test('no-over-block: gh api GET issues stays other', () => {
  const r = cls('gh api repos/o/r/issues');
  assert.strictEqual(r.action, 'other');
  assert.notStrictEqual(r.failClosed, true);
});

test('no-over-block: curl GET to github stays other', () => {
  const r = cls('curl https://api.github.com/repos/o/r/issues');
  assert.strictEqual(r.action, 'other');
  assert.notStrictEqual(r.failClosed, true);
});

test('no-over-block: curl POST to non-github host stays other', () => {
  const r = cls('curl -X POST https://example.com/repos/o/r/issues --data-binary {}');
  assert.strictEqual(r.action, 'other');
  assert.notStrictEqual(r.failClosed, true);
});

test('no-over-block: /usr/bin/git status stays other (path-qualified read-only)', () => {
  const r = cls('/usr/bin/git status');
  assert.strictEqual(r.action, 'other');
  assert.notStrictEqual(r.failClosed, true);
});

// ---------------------------------------------------------------------------
// IN-03: action-parameterized findActionSegment (hoisted from the 4 gates)
// ---------------------------------------------------------------------------

test('findActionSegment returns the pr-create segment in a chain (target pr-create)', () => {
  const parsed = parseCommand('git status && gh pr create --title x --body y');
  const seg = findActionSegment(parsed, 'pr-create');
  assert.strictEqual(classifyAction({ ok: true, segments: [seg] }).action, 'pr-create');
});

test('findActionSegment returns the issue-create segment in a chain (target issue-create)', () => {
  const parsed = parseCommand('echo hi && gh issue create --title x --body y');
  const seg = findActionSegment(parsed, 'issue-create');
  assert.strictEqual(classifyAction({ ok: true, segments: [seg] }).action, 'issue-create');
});

test('findActionSegment returns the commit segment in a chain (target commit)', () => {
  const parsed = parseCommand('git add -A && git commit -m "feat: x"');
  const seg = findActionSegment(parsed, 'commit');
  assert.strictEqual(classifyAction({ ok: true, segments: [seg] }).action, 'commit');
});

test('findActionSegment is action-targeted: same chain selects different segments per target', () => {
  const parsed = parseCommand('git commit -m "x" && gh issue create --title t');
  const commitSeg = findActionSegment(parsed, 'commit');
  const issueSeg = findActionSegment(parsed, 'issue-create');
  assert.strictEqual(classifyAction({ ok: true, segments: [commitSeg] }).action, 'commit');
  assert.strictEqual(classifyAction({ ok: true, segments: [issueSeg] }).action, 'issue-create');
});

test('findActionSegment falls back to segs[0] when no segment matches the target', () => {
  const parsed = parseCommand('gh issue create --title t');
  // target the wrong action → no match → first (only) segment returned
  const seg = findActionSegment(parsed, 'pr-create');
  assert.strictEqual(seg, parsed.segments && parsed.segments.length > 0 ? parsed.segments[0] : parsed);
});

test('findActionSegment on a single-segment parse returns that segment regardless of target', () => {
  const parsed = parseCommand('git status');
  const seg = findActionSegment(parsed, 'commit');
  const expected = parsed.segments && parsed.segments.length > 0 ? parsed.segments[0] : parsed;
  assert.strictEqual(seg, expected);
});

// ---------------------------------------------------------------------------
// RES-01: isNonGovernedCommand — the action-first short-circuit guard
//
// Returns true ONLY when a command is CONFIDENTLY a non-governed action, so a
// gate may short-circuit to allow() BEFORE resolving/requiring its LIVE script.
// In every other case (parse not ok, classifyAction.failClosed, or the action IS
// governed) it returns false → the caller falls through to its unchanged
// resolve→requireLiveScript→gate path (preserving HARD-04, ENF-15, HARD-02).
// Pure: no filesystem access.
// ---------------------------------------------------------------------------

test('isNonGovernedCommand: confidently non-governed (git status) → true', () => {
  assert.strictEqual(
    isNonGovernedCommand(parseCommand('git status'), ['issue-create']),
    true
  );
});

test('isNonGovernedCommand: governed native action (gh issue create) → false', () => {
  assert.strictEqual(
    isNonGovernedCommand(parseCommand('gh issue create --title x'), ['issue-create']),
    false
  );
});

test('isNonGovernedCommand: unparseable (ok:false parse) → false (HARD-04 fall-through)', () => {
  assert.strictEqual(
    isNonGovernedCommand(parseCommand('gh issue create --title "unterminated'), ['issue-create']),
    false
  );
});

test('isNonGovernedCommand: unclassifiable mutating gh-api synonym (failClosed) → false (ENF-15 fall-through)', () => {
  assert.strictEqual(
    isNonGovernedCommand(parseCommand('gh api -X POST repos/o/r/issues/weird/path'), ['issue-create']),
    false
  );
});

test('isNonGovernedCommand: governed gh-api synonym create → false (do NOT short-circuit)', () => {
  assert.strictEqual(
    isNonGovernedCommand(parseCommand('gh api -X POST repos/o/r/issues -f title=x'), ['issue-create']),
    false
  );
});

test('isNonGovernedCommand: accepts a Set of governed actions (gh-edit two-action set)', () => {
  const editSet = new Set(['issue-edit', 'pr-edit']);
  // governed → false
  assert.strictEqual(isNonGovernedCommand(parseCommand('gh issue edit 12 --body y'), editSet), false);
  assert.strictEqual(isNonGovernedCommand(parseCommand('gh pr edit 12 --body y'), editSet), false);
  // non-governed → true
  assert.strictEqual(isNonGovernedCommand(parseCommand('git status'), editSet), true);
});

test('isNonGovernedCommand: an action governed by a DIFFERENT gate is non-governed here → true', () => {
  // gh issue create is governed by the issue gate but NOT by the pr-create gate,
  // so from the pr gate's perspective it is a non-governed command.
  assert.strictEqual(
    isNonGovernedCommand(parseCommand('gh issue create --title x'), ['pr-create']),
    true
  );
});

test('isNonGovernedCommand: null/garbage parse → false (fail-through)', () => {
  assert.strictEqual(isNonGovernedCommand(null, ['issue-create']), false);
  assert.strictEqual(isNonGovernedCommand({}, ['issue-create']), false);
});

// ---------------------------------------------------------------------------
// CF-05: hasGovernedSegment — the any-governed-segment multi-segment predicate
//
// classifyAction returns the FIRST actionable segment, so `git commit && git push`
// collapses to `commit` and a governed push in a LATER segment escapes a first-segment
// trigger. hasGovernedSegment scans ALL segments and returns true iff ANY segment
// classifies to a governed action. It is the shared chokepoint that both push-governing
// gates (scan-gate, lint-ci-marker) trigger on, and the narrows-not-weakens basis for
// isNonGovernedCommand (short-circuit ALLOW only when NO segment is governed).
// Pure: no filesystem access. Mirrors CHD-02's all-segments detectGit.
// ---------------------------------------------------------------------------

test('hasGovernedSegment: git commit && git push, governed {push} → true (later segment governed)', () => {
  assert.strictEqual(
    hasGovernedSegment(parseCommand('git commit -m x && git push'), new Set(['push'])),
    true
  );
});

test('hasGovernedSegment: git status && ls, governed {push} → false (no governed segment)', () => {
  assert.strictEqual(
    hasGovernedSegment(parseCommand('git status && ls'), new Set(['push'])),
    false
  );
});

test('hasGovernedSegment: echo hi && git log, governed {push,pr-create} → false (read-only chain)', () => {
  assert.strictEqual(
    hasGovernedSegment(parseCommand('echo hi && git log'), new Set(['push', 'pr-create'])),
    false
  );
});

test('hasGovernedSegment: single governed segment (git push) → true', () => {
  assert.strictEqual(hasGovernedSegment(parseCommand('git push origin main'), new Set(['push'])), true);
});

test('hasGovernedSegment: accepts an array of governed actions (mirrors normalization)', () => {
  assert.strictEqual(hasGovernedSegment(parseCommand('git commit -m x && git push'), ['push']), true);
  assert.strictEqual(hasGovernedSegment(parseCommand('git status && ls'), ['push']), false);
});

test('hasGovernedSegment: non-ok / absent parse → false', () => {
  assert.strictEqual(hasGovernedSegment({ ok: false }, ['push']), false);
  assert.strictEqual(hasGovernedSegment(null, ['push']), false);
});

// ---------------------------------------------------------------------------
// CF-07 (← CR-01): hasFailClosedSegment — the any-segment failClosed scan, the ENF-15
// analog of hasGovernedSegment.
//
// classifyAction returns the FIRST actionable segment, so a `failClosed` synonym placed
// AFTER a benign actionable segment (`gh pr create <valid> && gh api -X POST
// repos/.../issues/weird`) is masked from the gate's `if (action.failClosed)` guard and
// slips ENF-15. hasFailClosedSegment scans EVERY segment and returns true iff ANY segment
// classifies failClosed — so the create/edit gates can run it FIRST (before the governed
// check) and never let a trailing failClosed synonym escape. Pure: no filesystem access.
// ---------------------------------------------------------------------------

test('hasFailClosedSegment: pr-create <valid> && gh api POST issues/weird → true (trailing failClosed unmasked)', () => {
  assert.strictEqual(
    hasFailClosedSegment(
      parseCommand('gh pr create --title t --body b && gh api -X POST repos/open-gsd/gsd-core/issues/weird')
    ),
    true
  );
});

test('hasFailClosedSegment: git commit && gh pr create → false (no failClosed segment)', () => {
  assert.strictEqual(
    hasFailClosedSegment(parseCommand('git commit -m x && gh pr create --title t --body b')),
    false
  );
});

test('hasFailClosedSegment: git status && ls → false (read-only chain)', () => {
  assert.strictEqual(hasFailClosedSegment(parseCommand('git status && ls')), false);
});

test('hasFailClosedSegment: non-ok / absent parse → false (caller owns HARD-04)', () => {
  assert.strictEqual(hasFailClosedSegment({ ok: false }), false);
  assert.strictEqual(hasFailClosedSegment(null), false);
});

// ---------------------------------------------------------------------------
// CF-05: isNonGovernedCommand is now multi-segment aware — it may allow-short-circuit
// ONLY when NO segment is governed (D-03 narrows-not-weakens). The RED baseline below
// FAILS on the pre-CF-05 first-segment code (which returns true because the first
// action `commit` is non-governed for a push gate), while every prior row still holds.
// ---------------------------------------------------------------------------

test('isNonGovernedCommand: git commit && git push, {push} → false (later segment governed — RED baseline)', () => {
  assert.strictEqual(
    isNonGovernedCommand(parseCommand('git commit -m x && git push'), new Set(['push'])),
    false
  );
});

test('isNonGovernedCommand: git status && ls, {push} → true (no governed segment still ALLOWS)', () => {
  assert.strictEqual(
    isNonGovernedCommand(parseCommand('git status && ls'), ['push']),
    true
  );
});

test('isNonGovernedCommand: echo hi && git log, {push} → true (read-only chain still ALLOWS)', () => {
  assert.strictEqual(
    isNonGovernedCommand(parseCommand('echo hi && git log'), ['push']),
    true
  );
});

test('isNonGovernedCommand: git status, {push} → true (narrows-not-weakens, unchanged)', () => {
  assert.strictEqual(isNonGovernedCommand(parseCommand('git status'), ['push']), true);
});

test('isNonGovernedCommand: git push, {push} → false (governed single segment, unchanged)', () => {
  assert.strictEqual(isNonGovernedCommand(parseCommand('git push'), ['push']), false);
});

test('isNonGovernedCommand: {ok:false}, {push} → false (HARD-04, unchanged)', () => {
  assert.strictEqual(isNonGovernedCommand({ ok: false }, ['push']), false);
});

// ---------------------------------------------------------------------------
// CF-08 (← CR-02): value-taking wrapper flags must not resolve the program to the
// flag's VALUE.
//
// The SHARED resolveProgram (consumed by containment.detectGit and classifySegment)
// learned from CF-04 to skip BOOLEAN wrapper flags only: its wrapper loop advanced
// past any '-'-prefixed token but never consumed a value-taking wrapper flag's VALUE
// token. So a value flag resolved the program to that value: sudo -u user git → prog
// 'user', nice -n 10 git → '10', env -u VAR git → 'VAR'. Wrapped git/gh then slipped
// ENF-06/07 containment and ENF-15 classification (CF-REVIEW CR-02, file
// .planning/phases/31-enforcement-bypass-closure/CF-REVIEW.md:117-165).
//
// The fix teaches the loop a per-wrapper WRAPPER_VALUE_FLAGS allow-list (D-06 — skip
// the flag AND its value token) and, per D-07, emits an ambiguous signal when a value
// flag consumes the token stream leaving no program (env -S '<packed cmd>') so callers
// fail closed rather than trust the leftover value token as the program.
//
// RED-before-GREEN (D-08): every value-flag resolution below, the wrapped gh-api
// classification, and the env -S ambiguous failClosed FAIL on the un-fixed source
// (which resolves to the flag value / classifies wrapped forms as other). The
// outcome-level narrows-not-weakens guardrails (classifyAction 'other', bare-wrapper
// 'push') pass both before and after.
// ---------------------------------------------------------------------------

const prog0 = (cmd) => resolveProgram(parseCommand(cmd).segments[0]);

// -- value-flag resolution: the wrapped program must survive the value token (RED) --

test('CF-08: resolveProgram sudo -u user git push → prog git (not the -u value "user")', () => {
  assert.strictEqual(prog0('sudo -u user git push origin main').prog, 'git');
});

test('CF-08: resolveProgram nice -n 10 git push → prog git (not the -n value "10")', () => {
  assert.strictEqual(prog0('nice -n 10 git push origin main').prog, 'git');
});

test('CF-08: resolveProgram env -u VAR git add → prog git (not the -u value "VAR")', () => {
  assert.strictEqual(prog0('env -u VAR git add .planning/x').prog, 'git');
});

// value-flag consumption is program-agnostic — it also corrects non-governed wrappers
// so the resolved program is the real command (the outcome stays non-governed below).

test('CF-08: resolveProgram sudo -u user ls → prog ls (value flag consumed, not "user")', () => {
  assert.strictEqual(prog0('sudo -u user ls').prog, 'ls');
});

test('CF-08: resolveProgram nice -n 10 grep foo → prog grep (value flag consumed, not "10")', () => {
  assert.strictEqual(prog0('nice -n 10 grep foo').prog, 'grep');
});

// -- wrapped mutating gh-api reaches ENF-15 classification (RED) --

test('CF-08: nice -n 10 gh api -X POST .../issues -f title=x → issue-create (ENF-15 reached)', () => {
  const r = cls('nice -n 10 gh api -X POST repos/open-gsd/gsd-core/issues -f title=x');
  assert.strictEqual(r.action, 'issue-create', JSON.stringify(r));
});

// -- D-07 ambiguous: an unresolvable value-flag wrapper form fails closed (RED) --

test('CF-08 D-07: env -S "<packed cmd>" → failClosed (unresolvable wrapper fails closed)', () => {
  const r = cls("env -S 'git push origin main'");
  assert.strictEqual(r.failClosed, true, JSON.stringify(r));
  assert.strictEqual(r.action, 'unknown');
});

// -- narrows-not-weakens guardrails: outcome unchanged before AND after --

test('CF-08 narrows-not-weakens: classifyAction sudo -u user ls → other, not failClosed', () => {
  const r = cls('sudo -u user ls');
  assert.strictEqual(r.action, 'other', JSON.stringify(r));
  assert.notStrictEqual(r.failClosed, true);
});

test('CF-08 regression: bare-wrapper sudo git push (CF-04, no value flag) still → push', () => {
  assert.strictEqual(cls('sudo git push origin main').action, 'push');
});

// ===========================================================================
// ENF-20 (T1): the REVIEW-SIDE actions — pr-review, pr-merge, issue-close,
// issue-comment, pr-comment.
//
// The enforcement inversion this closes: the toolkit gates AUTHORING (13 gates,
// 19 ENF codes) and gates ADJUDICATING not at all — approving, merging, closing
// and commenting are outward-facing and effectively irreversible, and every one
// of them classified as action:'other' (a silent allow at every gate).
//
// Rigour parity with ENF-15: each new action is recognized via its NATIVE gh verb
// AND its `gh api` / `curl` REST synonym (-X/--method POST, PUT, PATCH), because a
// synonym route that maps to 'other' bypasses the gate just as effectively as no
// gate at all.
//
// BLAST RADIUS (all 13 wired hooks consume classifyAction). Two invariants are
// asserted below and are non-negotiable:
//   (a) the SIX pre-existing actions classify byte-identically;
//   (b) an existing gate that governs e.g. ['issue-create'] does NOT start firing
//       because 'issue-comment' now exists.
// ===========================================================================

// ---------------------------------------------------------------------------
// Native gh review-side verbs
// ---------------------------------------------------------------------------

test('ENF-20: gh pr review → pr-review / native', () => {
  assert.deepStrictEqual(cls('gh pr review 42'), { action: 'pr-review', route: 'native' });
});

test('ENF-20: gh pr review --approve → pr-review (flag form)', () => {
  assert.deepStrictEqual(cls('gh pr review 42 --approve'), { action: 'pr-review', route: 'native' });
});

test('ENF-20: gh pr review --request-changes → pr-review (flag form)', () => {
  assert.deepStrictEqual(cls('gh pr review 42 --request-changes --body "needs work"'), {
    action: 'pr-review', route: 'native',
  });
});

test('ENF-20: gh pr review --comment → pr-review (flag form)', () => {
  assert.deepStrictEqual(cls('gh pr review 42 --comment --body x'), {
    action: 'pr-review', route: 'native',
  });
});

test('ENF-20: gh pr review --approve BEFORE the number → pr-review (flag ordering)', () => {
  assert.deepStrictEqual(cls('gh pr review --approve 42'), { action: 'pr-review', route: 'native' });
});

test('ENF-20: gh pr merge → pr-merge / native', () => {
  assert.deepStrictEqual(cls('gh pr merge 42 --squash --delete-branch'), {
    action: 'pr-merge', route: 'native',
  });
});

test('ENF-20: gh pr merge --admin → pr-merge (admin bypass form still classified)', () => {
  assert.deepStrictEqual(cls('gh pr merge --admin 42'), { action: 'pr-merge', route: 'native' });
});

test('ENF-20: gh issue close → issue-close / native', () => {
  assert.deepStrictEqual(cls('gh issue close 42'), { action: 'issue-close', route: 'native' });
});

test('ENF-20: gh issue close --reason → issue-close', () => {
  assert.deepStrictEqual(cls('gh issue close 42 --reason "not planned"'), {
    action: 'issue-close', route: 'native',
  });
});

test('ENF-20: gh issue comment → issue-comment / native', () => {
  assert.deepStrictEqual(cls('gh issue comment 42 --body x'), {
    action: 'issue-comment', route: 'native',
  });
});

test('ENF-20: gh pr comment → pr-comment / native', () => {
  assert.deepStrictEqual(cls('gh pr comment 42 --body x'), {
    action: 'pr-comment', route: 'native',
  });
});

// ---------------------------------------------------------------------------
// Wrapper / env / path / global-option forms of the review-side verbs.
// The SAME bypass surface ENF-15 + CF-08 closed for create/edit applies here —
// `sudo gh pr merge`, `nice -n 10 gh pr review`, `/usr/bin/gh pr merge`,
// `A=1 gh issue close`, `gh --repo o/r pr review` are the same mutation.
// ---------------------------------------------------------------------------

test('ENF-20: sudo gh pr merge → pr-merge (wrapper prefix)', () => {
  assert.strictEqual(cls('sudo gh pr merge 42 --squash').action, 'pr-merge');
});

test('ENF-20: nice -n 10 gh pr review --approve → pr-review (value-flag wrapper, CF-08)', () => {
  assert.strictEqual(cls('nice -n 10 gh pr review 42 --approve').action, 'pr-review');
});

test('ENF-20: /usr/bin/gh pr merge → pr-merge (path-qualified, CR-03)', () => {
  assert.strictEqual(cls('/usr/bin/gh pr merge 42').action, 'pr-merge');
});

test('ENF-20: A=1 gh issue close → issue-close (env-assignment prefix, CR-02)', () => {
  assert.strictEqual(cls('A=1 gh issue close 42').action, 'issue-close');
});

test('ENF-20: gh --repo o/r pr review --approve → pr-review (global option, CR-01)', () => {
  assert.strictEqual(cls('gh --repo o/r pr review 42 --approve').action, 'pr-review');
});

// ---------------------------------------------------------------------------
// REST synonyms — gh api
//
// POST /repos/{o}/{r}/pulls/{n}/reviews        → pr-review
// POST /repos/{o}/{r}/pulls/{n}/reviews/{id}/events   → pr-review (submit a pending review)
// PUT  /repos/{o}/{r}/pulls/{n}/reviews/{id}/dismissals → pr-review (dismissal)
// PUT|POST /repos/{o}/{r}/pulls/{n}/merge      → pr-merge
// POST /repos/{o}/{r}/issues/{n}/comments      → issue-comment
// POST /repos/{o}/{r}/pulls/{n}/comments       → pr-comment (review comments)
// ---------------------------------------------------------------------------

test('ENF-20: gh api -X POST .../pulls/N/reviews → pr-review / gh-api', () => {
  assert.deepStrictEqual(cls('gh api -X POST repos/o/r/pulls/42/reviews -f event=APPROVE'), {
    action: 'pr-review', route: 'gh-api',
  });
});

test('ENF-20: gh api --method POST .../pulls/N/reviews → pr-review / gh-api (long form)', () => {
  assert.deepStrictEqual(cls('gh api --method POST repos/o/r/pulls/42/reviews -f event=APPROVE'), {
    action: 'pr-review', route: 'gh-api',
  });
});

test('ENF-20: gh api -XPOST bundled .../pulls/N/reviews → pr-review / gh-api', () => {
  assert.deepStrictEqual(cls('gh api -XPOST repos/o/r/pulls/42/reviews'), {
    action: 'pr-review', route: 'gh-api',
  });
});

test('ENF-20: gh api POST inferred from -f alone .../pulls/N/reviews → pr-review', () => {
  assert.deepStrictEqual(cls('gh api repos/o/r/pulls/42/reviews -f event=APPROVE'), {
    action: 'pr-review', route: 'gh-api',
  });
});

test('ENF-20: gh api POST .../pulls/N/reviews/ID/events → pr-review (pending-review submit)', () => {
  assert.deepStrictEqual(cls('gh api -X POST repos/o/r/pulls/42/reviews/9/events -f event=APPROVE'), {
    action: 'pr-review', route: 'gh-api',
  });
});

test('ENF-20: gh api PUT .../pulls/N/reviews/ID/dismissals → pr-review (dismissal)', () => {
  assert.deepStrictEqual(cls('gh api -X PUT repos/o/r/pulls/42/reviews/9/dismissals -f message=x'), {
    action: 'pr-review', route: 'gh-api',
  });
});

test('ENF-20: gh api -X PUT .../pulls/N/merge → pr-merge / gh-api (canonical merge verb)', () => {
  assert.deepStrictEqual(cls('gh api -X PUT repos/o/r/pulls/42/merge'), {
    action: 'pr-merge', route: 'gh-api',
  });
});

test('ENF-20: gh api -X POST .../pulls/N/merge → pr-merge / gh-api (POST form too)', () => {
  assert.deepStrictEqual(cls('gh api -X POST repos/o/r/pulls/42/merge'), {
    action: 'pr-merge', route: 'gh-api',
  });
});

test('ENF-20: gh api -X POST .../issues/N/comments → issue-comment / gh-api', () => {
  assert.deepStrictEqual(cls('gh api -X POST repos/o/r/issues/42/comments -f body=x'), {
    action: 'issue-comment', route: 'gh-api',
  });
});

test('ENF-20: gh api -X POST .../pulls/N/comments → pr-comment / gh-api (review comments)', () => {
  assert.deepStrictEqual(cls('gh api -X POST repos/o/r/pulls/42/comments -f body=x'), {
    action: 'pr-comment', route: 'gh-api',
  });
});

test('ENF-20: gh api PATCH .../issues/comments/ID (repo-level comment edit) stays failClosed', () => {
  // Non-numeric member ('comments') → unmappable mutating github path → EP-1 deny.
  // Byte-identical to today; recorded so a future relaxation cannot silently open it.
  const r = cls('gh api -X PATCH repos/o/r/issues/comments/9 -f body=x');
  assert.strictEqual(r.failClosed, true, JSON.stringify(r));
});

// ---------------------------------------------------------------------------
// REST synonyms — the issue-CLOSE form: PATCH .../issues/{n} with state=closed.
//
// This is the ONE input class whose classification MOVES (issue-edit → issue-close),
// and it is mandated by the task. The blast radius is deliberately minimized by an
// EDIT-WINS precedence rule: when the same PATCH also carries a title/body field it
// is still a body/title edit, so `gh-edit` (which governs {issue-edit, pr-edit})
// keeps firing on it. Only a PURE state-change PATCH diverts to issue-close.
// ---------------------------------------------------------------------------

test('ENF-20: gh api PATCH .../issues/N -f state=closed → issue-close / gh-api', () => {
  assert.deepStrictEqual(cls('gh api -X PATCH repos/o/r/issues/42 -f state=closed'), {
    action: 'issue-close', route: 'gh-api',
  });
});

test('ENF-20: gh api PATCH .../issues/N --field state=closed → issue-close (long field form)', () => {
  assert.deepStrictEqual(cls('gh api -X PATCH repos/o/r/issues/42 --field state=closed'), {
    action: 'issue-close', route: 'gh-api',
  });
});

test('ENF-20: gh api PATCH .../issues/N --raw-field state=closed → issue-close', () => {
  assert.deepStrictEqual(cls('gh api -X PATCH repos/o/r/issues/42 --raw-field state=closed'), {
    action: 'issue-close', route: 'gh-api',
  });
});

test('ENF-20: gh api PATCH .../issues/N -fstate=closed (bundled short) → issue-close', () => {
  assert.deepStrictEqual(cls('gh api -X PATCH repos/o/r/issues/42 -fstate=closed'), {
    action: 'issue-close', route: 'gh-api',
  });
});

test('ENF-20: gh api PATCH .../issues/N -F state=closed → issue-close', () => {
  assert.deepStrictEqual(cls('gh api -X PATCH repos/o/r/issues/42 -F state=closed'), {
    action: 'issue-close', route: 'gh-api',
  });
});

test('ENF-20 EDIT WINS: PATCH .../issues/N with state=closed AND body → issue-edit (gh-edit keeps firing)', () => {
  assert.deepStrictEqual(cls('gh api -X PATCH repos/o/r/issues/42 -f state=closed -f body=hi'), {
    action: 'issue-edit', route: 'gh-api',
  });
});

test('ENF-20 EDIT WINS: PATCH .../issues/N with state=closed AND title → issue-edit', () => {
  assert.deepStrictEqual(cls('gh api -X PATCH repos/o/r/issues/42 -f title=t -f state=closed'), {
    action: 'issue-edit', route: 'gh-api',
  });
});

test('ENF-20: PATCH .../issues/N -f state=open → issue-edit (reopen is NOT a close)', () => {
  assert.deepStrictEqual(cls('gh api -X PATCH repos/o/r/issues/42 -f state=open'), {
    action: 'issue-edit', route: 'gh-api',
  });
});

test('ENF-20: PATCH .../pulls/N -f state=closed → pr-edit (pr-close is NOT in scope)', () => {
  // issue-close is the only close action T1 adds; the PR form stays exactly as today.
  assert.deepStrictEqual(cls('gh api -X PATCH repos/o/r/pulls/42 -f state=closed'), {
    action: 'pr-edit', route: 'gh-api',
  });
});

// ---------------------------------------------------------------------------
// REST synonyms — curl
// ---------------------------------------------------------------------------

test('ENF-20: curl POST api.github.com .../pulls/N/reviews → pr-review / curl', () => {
  assert.deepStrictEqual(
    cls('curl -X POST https://api.github.com/repos/o/r/pulls/42/reviews -d {}'),
    { action: 'pr-review', route: 'curl' }
  );
});

test('ENF-20: curl PUT api.github.com .../pulls/N/merge → pr-merge / curl', () => {
  assert.deepStrictEqual(
    cls('curl -X PUT https://api.github.com/repos/o/r/pulls/42/merge -d {}'),
    { action: 'pr-merge', route: 'curl' }
  );
});

test('ENF-20: curl POST api.github.com .../issues/N/comments → issue-comment / curl', () => {
  assert.deepStrictEqual(
    cls('curl -X POST https://api.github.com/repos/o/r/issues/42/comments -d {}'),
    { action: 'issue-comment', route: 'curl' }
  );
});

test('ENF-20: curl --data-raw .../pulls/N/reviews (inferred POST) → pr-review / curl', () => {
  assert.deepStrictEqual(
    cls('curl https://api.github.com/repos/o/r/pulls/42/reviews --data-raw {}'),
    { action: 'pr-review', route: 'curl' }
  );
});

test('ENF-20: curl PATCH .../issues/N with a JSON state:closed body → issue-close / curl', () => {
  assert.deepStrictEqual(
    cls('curl -X PATCH https://api.github.com/repos/o/r/issues/42 -d \'{"state":"closed"}\''),
    { action: 'issue-close', route: 'curl' }
  );
});

test('ENF-20: curl PATCH .../issues/N with JSON state:closed AND body → issue-edit (edit wins)', () => {
  assert.deepStrictEqual(
    cls('curl -X PATCH https://api.github.com/repos/o/r/issues/42 -d \'{"state":"closed","body":"x"}\''),
    { action: 'issue-edit', route: 'curl' }
  );
});

test('ENF-20 no-over-block: curl POST to a NON-github host .../pulls/N/reviews → other', () => {
  const r = cls('curl -X POST https://example.com/repos/o/r/pulls/42/reviews -d {}');
  assert.strictEqual(r.action, 'other');
  assert.notStrictEqual(r.failClosed, true);
});

// ---------------------------------------------------------------------------
// NO OVER-BLOCK: read-only review-side surfaces stay 'other', never failClosed.
// A false deny on `gh pr view` / a GET of the reviews list is exactly the H-B
// trust erosion that gets the toolkit switched off.
// ---------------------------------------------------------------------------

test('ENF-20 no-over-block: gh api GET .../pulls/N/reviews stays other', () => {
  const r = cls('gh api repos/o/r/pulls/42/reviews');
  assert.strictEqual(r.action, 'other');
  assert.notStrictEqual(r.failClosed, true);
});

test('ENF-20 no-over-block: gh pr view / gh pr checks / gh pr diff stay other', () => {
  for (const cmd of ['gh pr view 42', 'gh pr checks 42', 'gh pr diff 42', 'gh issue view 42']) {
    const r = cls(cmd);
    assert.strictEqual(r.action, 'other', `${cmd} → ${JSON.stringify(r)}`);
    assert.notStrictEqual(r.failClosed, true);
  }
});

test('ENF-20 no-over-block: gh pr close / gh issue reopen stay other (NOT in the five)', () => {
  // Deliberately out of T1 scope; recorded so the boundary is explicit rather than
  // an accident, and so a later widening is a visible test change.
  for (const cmd of ['gh pr close 42', 'gh issue reopen 42', 'gh pr ready 42']) {
    const r = cls(cmd);
    assert.strictEqual(r.action, 'other', `${cmd} → ${JSON.stringify(r)}`);
    assert.notStrictEqual(r.failClosed, true);
  }
});

test('ENF-20 no-over-block: existing G1 sub-resources are UNCHANGED (labels/assignees/reviewers)', () => {
  for (const cmd of [
    'gh api -X POST repos/o/r/issues/123/labels -f labels[]=bug',
    'gh api -X PUT repos/o/r/issues/123/labels -f labels[]=bug',
    'gh api -X POST repos/o/r/pulls/123/requested_reviewers -f reviewers[]=octocat',
    'gh api -X POST repos/o/r/issues/123/assignees -f assignees[]=octocat',
    'curl -X POST https://api.github.com/repos/o/r/pulls/123/requested_reviewers -d {}',
  ]) {
    const r = cls(cmd);
    assert.strictEqual(r.action, 'other', `${cmd} → ${JSON.stringify(r)}`);
    assert.notStrictEqual(r.failClosed, true);
  }
});

// ---------------------------------------------------------------------------
// THE SIX PRE-EXISTING ACTIONS ARE BYTE-IDENTICAL (invariant (a)).
// The exhaustive proof is the 436-command before/after corpus diff recorded in
// scratchpad/; these rows lock the load-bearing ones into the suite permanently.
// ---------------------------------------------------------------------------

test('ENF-20 invariant (a): the six pre-existing actions classify byte-identically', () => {
  const expected = [
    ['git commit -m x', { action: 'commit' }],
    ['git push origin main', { action: 'push' }],
    ['gh issue create --title x', { action: 'issue-create', route: 'native' }],
    ['gh pr create --title x', { action: 'pr-create', route: 'native' }],
    ['gh issue edit 12 --body y', { action: 'issue-edit', route: 'native' }],
    ['gh pr edit 12 --body y', { action: 'pr-edit', route: 'native' }],
    ['gh api -X POST repos/o/r/issues -f title=x', { action: 'issue-create', route: 'gh-api' }],
    ['gh api -X POST repos/o/r/pulls -f title=x', { action: 'pr-create', route: 'gh-api' }],
    ['gh api -X PATCH repos/o/r/issues/42', { action: 'issue-edit', route: 'gh-api' }],
    ['gh api -X PATCH repos/o/r/pulls/42', { action: 'pr-edit', route: 'gh-api' }],
    ['gh api -X PATCH repos/o/r/issues/42 -f body=hi', { action: 'issue-edit', route: 'gh-api' }],
    ['curl -X POST https://api.github.com/repos/o/r/issues -d {}', { action: 'issue-create', route: 'curl' }],
    ['curl -X PATCH https://api.github.com/repos/o/r/issues/7', { action: 'issue-edit', route: 'curl' }],
    ['git status', { action: 'other' }],
    ['gh repo view o/r', { action: 'other' }],
  ];
  for (const [cmd, want] of expected) {
    assert.deepStrictEqual(cls(cmd), want, cmd);
  }
});

test('ENF-20 invariant (a): the failClosed corpus is byte-identical', () => {
  for (const cmd of [
    'gh api -X POST repos/o/r/issues/weird/path/segments',
    'gh api -X POST repos/o/r/issues/weird/labels',
    'gh api -X POST repos/o/r/issues/123',
    'gh api -X POST repos/o/r/pulls/123',
    'gh api -X POST repos/o/r/pulls/comments/issues',
    '/usr/bin/gh api -X POST repos/o/r/issues/weird',
    "env -S 'git push origin main'",
    'gh issue create --title "unterminated',
  ]) {
    const r = cls(cmd);
    assert.strictEqual(r.failClosed, true, `${cmd} → ${JSON.stringify(r)}`);
    assert.strictEqual(r.action, 'unknown', cmd);
  }
});

// ---------------------------------------------------------------------------
// CHAIN PRECEDENCE — the mechanism that makes invariant (a) STRUCTURAL, not lucky.
//
// classifyAction returns ONE result for a whole chain. Before ENF-20 the only
// actionable results were the six + failClosed, so a chain collapsed to its first
// legacy-actionable segment. Six wired gates read that single result directly
// (issue-dedupe, freshness, git-commit-convention, policy-invariants, lint-ci-marker,
// protocol-artifact). If a NEW review-side action could win the aggregation, then
// `gh issue comment … && gh issue create …` would collapse to 'issue-comment' and
// issue-dedupe / protocol-artifact would ALLOW a create they deny today — the
// classifier extension would have MANUFACTURED A BYPASS in six gates.
//
// So classifyAction resolves in two passes: legacy actions + failClosed FIRST, the
// review-side actions only when no legacy segment exists (i.e. exactly where the old
// code returned 'other'). That makes byte-identity provable by construction.
//
// The correct pattern for a T3 gate that governs a review-side action is therefore
// hasGovernedSegment(parsed, ['pr-merge']) — the CF-05 all-segments chokepoint — NOT
// classifyAction(parsed).action. Asserted below so T3 inherits the rule.
// ---------------------------------------------------------------------------

test('ENF-20 chain precedence: gh pr comment && gh pr create → pr-create (legacy wins)', () => {
  const r = cls('gh pr comment 1 --body x && gh pr create --title t --body b');
  assert.strictEqual(r.action, 'pr-create', JSON.stringify(r));
});

test('ENF-20 chain precedence: gh issue comment && gh issue create → issue-create (issue-dedupe unbroken)', () => {
  const r = cls('gh issue comment 1 --body x && gh issue create --title t');
  assert.strictEqual(r.action, 'issue-create', JSON.stringify(r));
});

test('ENF-20 chain precedence: gh pr merge && git push → push (scan-gate/lint-ci unbroken)', () => {
  assert.strictEqual(cls('gh pr merge 1 --squash && git push origin main').action, 'push');
});

test('ENF-20 chain precedence: gh issue close && git commit → commit (freshness unbroken)', () => {
  assert.strictEqual(cls('gh issue close 1 && git commit -m x').action, 'commit');
});

test('ENF-20 chain precedence: failClosed still beats a review-side action anywhere in the chain', () => {
  const r = cls('gh pr review 1 --approve && gh api -X POST repos/o/r/issues/weird');
  assert.strictEqual(r.failClosed, true, JSON.stringify(r));
  assert.strictEqual(r.action, 'unknown');
});

test('ENF-20 chain precedence: a review-side action still wins over plain read-only segments', () => {
  assert.strictEqual(cls('git status && gh pr merge 1 --squash').action, 'pr-merge');
  assert.strictEqual(cls('echo hi ; gh pr review 1 --approve').action, 'pr-review');
});

test('ENF-20: hasGovernedSegment is the correct T3 trigger — it sees a masked review action', () => {
  const parsed = parseCommand('gh pr merge 1 --squash && git push origin main');
  // classifyAction collapses to the legacy 'push' (byte-identity), so a T3 gate MUST
  // use the all-segments chokepoint to see the merge.
  assert.strictEqual(classifyAction(parsed).action, 'push');
  assert.strictEqual(hasGovernedSegment(parsed, ['pr-merge']), true);
  assert.strictEqual(hasGovernedSegment(parsed, ['pr-review']), false);
});

test('ENF-20: findActionSegment resolves a review-side target segment', () => {
  const parsed = parseCommand('git status && gh pr review 42 --approve');
  const seg = findActionSegment(parsed, 'pr-review');
  assert.strictEqual(classifyAction({ ok: true, segments: [seg] }).action, 'pr-review');
});

// ---------------------------------------------------------------------------
// ENF-22 (quick task 260731-ih5): the `merge` verb, and the THIRD aggregation tier.
//
// Origin: SEED-enf16-misses-git-merge-implicit-commit. A CLEANLY-mergeable
// `git merge <ref>` commits ITSELF — no `git commit` is ever issued — so ENF-16 was
// never consulted and git's generated subject landed on a gsd-core PR branch. Making
// the gate reachable at all starts here: `git merge` classified as `other`, and no
// gate can reach an `other`.
//
// The hazard this section locks down is NOT the new verb — it is the aggregation.
// classifyAction's PASS 2 returned the FIRST non-null result of ANY kind, so a `merge`
// segment standing before a review-side segment (`git merge x && gh pr merge 1`) would
// DISPLACE `pr-merge` and silently disarm ENF-20's review-artifact gate: exactly the
// "MANUFACTURED A BYPASS" failure the module's own comment warns about. PASS 2 is
// therefore narrowed to REVIEW_SIDE_ACTIONS and a PASS 3 catches everything else.
// Byte-identity argument: every non-null classifySegment result today is legacy,
// review-side, or failClosed, so the PASS 2 narrowing is a no-op on the existing
// corpus and PASS 3 is reachable only where the old code returned `other`.
//
// The classifier stays a PURE VERB classifier — no flag semantics live here. Whether a
// given merge invocation will actually create a commit (`--no-commit`, `--squash`,
// `--ff-only`, …) is the GATE's judgement, in git-commit-convention.cjs.
// ---------------------------------------------------------------------------

test('ENF-22: git merge origin/next --no-edit → merge (the seed’s exact failing command)', () => {
  assert.deepStrictEqual(cls('git merge origin/next --no-edit'), { action: 'merge' });
});

test('ENF-22: git merge x alone → merge', () => {
  assert.strictEqual(cls('git merge x').action, 'merge');
});

test('ENF-22: the four CR-01/CR-03 bypass forms classify merge (parity with commit)', () => {
  for (const cmd of [
    'sudo git merge origin/next',
    '/usr/bin/git merge origin/next',
    'GIT_DIR=/x git merge origin/next',
    'git -C /tmp merge origin/next',
  ]) {
    assert.strictEqual(cls(cmd).action, 'merge', cmd);
  }
});

test('ENF-22: hasGovernedSegment is the correct trigger — a merge masked by a later push', () => {
  const parsed = parseCommand('git merge x && git push origin main');
  // classifyAction still collapses the chain to the LEGACY action (byte-identity), so the
  // gate MUST use the CF-05 all-segments chokepoint to see the merge.
  assert.strictEqual(classifyAction(parsed).action, 'push');
  assert.strictEqual(hasGovernedSegment(parsed, ['merge']), true);
});

test('ENF-22 T-ih5-01: a merge segment must NOT displace a review-side action (ENF-20 stays armed)', () => {
  // Without the third aggregation tier this collapses to `merge` and review-artifact
  // (governed on pr-merge) short-circuits to allow — a manufactured bypass.
  assert.strictEqual(cls('git merge x && gh pr merge 1 --squash').action, 'pr-merge');
  assert.strictEqual(
    hasGovernedSegment(parseCommand('git merge x && gh pr merge 1 --squash'), ['pr-merge']),
    true
  );
});

test('ENF-22 regression-preserve: a merge segment does not displace a legacy action', () => {
  assert.strictEqual(cls('git merge x && git commit -m y').action, 'commit');
  assert.strictEqual(cls('git merge x && git push origin main').action, 'push');
});

test('ENF-22 regression-preserve: failClosed still beats a merge segment anywhere in the chain', () => {
  const r = cls('git merge x && gh api -X POST repos/o/r/issues/weird');
  assert.strictEqual(r.failClosed, true, JSON.stringify(r));
  assert.strictEqual(r.action, 'unknown');
});

test('ENF-22 regression-preserve: non-merge git verbs still classify other', () => {
  assert.strictEqual(cls('git status').action, 'other');
  assert.strictEqual(cls('git add .').action, 'other');
});

test('ENF-22: `merge` is neither a legacy nor a review-side action (the third tier’s reason)', () => {
  assert.strictEqual(LEGACY_MUTATION_ACTIONS.has('merge'), false);
  assert.strictEqual(REVIEW_SIDE_ACTIONS.has('merge'), false);
  assert.deepStrictEqual([...MERGE_SIDE_ACTIONS], ['merge']);
});

test('ENF-22: findActionSegment resolves the merge segment out of a chain', () => {
  const parsed = parseCommand('git status && git merge origin/next --no-edit');
  const seg = findActionSegment(parsed, 'merge');
  assert.strictEqual(classifyAction({ ok: true, segments: [seg] }).action, 'merge');
});

// ---------------------------------------------------------------------------
// INVARIANT (b): no EXISTING gate starts firing on a new action.
//
// Every wired gate decides "is this mine?" through one of: classifyAction().action,
// hasGovernedSegment(set), or isNonGovernedCommand(set) — each keyed to an explicit
// action-name set. These rows assert, per gate set, that every new action is
// non-governed → the gate short-circuits to allow(). The spawn proofs further down
// confirm it at the real entrypoint.
// ---------------------------------------------------------------------------

const NEW_ACTION_COMMANDS = [
  'gh pr review 42 --approve',
  'gh pr merge 42 --squash',
  'gh issue close 42',
  'gh issue comment 42 --body x',
  'gh pr comment 42 --body x',
  'gh api -X POST repos/o/r/pulls/42/reviews -f event=APPROVE',
  'gh api -X PUT repos/o/r/pulls/42/merge',
  'gh api -X POST repos/o/r/issues/42/comments -f body=x',
  'gh api -X PATCH repos/o/r/issues/42 -f state=closed',
];

// Exactly the governed sets the wired gates declare today (harvested from the gates).
const EXISTING_GATE_SETS = {
  'gh-issue-create': ['issue-create'],
  'gh-pr-create': ['pr-create'],
  'gh-edit': ['issue-edit', 'pr-edit'],
  'git-commit-convention': ['commit'],
  'githooks-seal': ['commit', 'push'],
  'scan-gate': ['push'],
  'lint-ci-marker': ['push', 'pr-create'],
  'policy-invariants': ['commit', 'pr-create'],
  'protocol-artifact': ['issue-create', 'pr-create', 'push'],
  'tool-recorder': ['issue-create', 'pr-create', 'issue-edit', 'pr-edit', 'commit', 'push'],
};

test('ENF-20 invariant (b): every new action is NON-GOVERNED for every existing gate set', () => {
  for (const cmd of NEW_ACTION_COMMANDS) {
    const parsed = parseCommand(cmd);
    assert.strictEqual(parsed.ok, true, cmd);
    assert.strictEqual(hasFailClosedSegment(parsed), false, `${cmd} must not fail closed`);
    for (const [gate, actions] of Object.entries(EXISTING_GATE_SETS)) {
      assert.strictEqual(
        hasGovernedSegment(parsed, actions), false,
        `${gate} must NOT be governed by: ${cmd}`
      );
      assert.strictEqual(
        isNonGovernedCommand(parsed, actions), true,
        `${gate} must short-circuit to allow for: ${cmd}`
      );
    }
  }
});

test('ENF-20 invariant (b): issue-comment existing does not make an issue-create gate fire', () => {
  const parsed = parseCommand('gh issue comment 7 --body "not a create"');
  assert.strictEqual(classifyAction(parsed).action, 'issue-comment');
  assert.strictEqual(hasGovernedSegment(parsed, ['issue-create']), false);
  assert.strictEqual(isNonGovernedCommand(parsed, ['issue-create']), true);
});

test('ENF-20 invariant (b): the review-side and legacy vocabularies are DISJOINT', () => {
  for (const a of REVIEW_SIDE_ACTIONS) {
    assert.strictEqual(LEGACY_MUTATION_ACTIONS.has(a), false, `${a} must not be a legacy action`);
  }
  assert.deepStrictEqual(
    [...LEGACY_MUTATION_ACTIONS].sort(),
    ['commit', 'issue-create', 'issue-edit', 'pr-create', 'pr-edit', 'push']
  );
  assert.deepStrictEqual(
    [...REVIEW_SIDE_ACTIONS].sort(),
    ['issue-close', 'issue-comment', 'pr-comment', 'pr-merge', 'pr-review']
  );
});

// ---------------------------------------------------------------------------
// pr-comment vs issue-comment — the disambiguation contract.
//
// GitHub's REST API posts a PR *conversation* comment to the ISSUES endpoint
// (POST /repos/{o}/{r}/issues/{n}/comments); the pulls endpoint
// (POST /repos/{o}/{r}/pulls/{n}/comments) is for inline REVIEW comments. Issue and
// PR numbers share ONE namespace, so `/issues/42/comments` cannot be resolved to
// "issue 42" vs "PR 42" from the command string — that needs a network lookup, and
// this module is PURE by contract (no I/O, no env).
//
// So the classifier reports what the command NAMES, never a guess:
//   - the command names `pulls`  → pr-comment
//   - the command names `issues` → issue-comment
// and the ambiguity is handed to the gate (which may do I/O) as an explicit
// contract: PR_COMMENT_EQUIVALENT_ACTIONS. A T3 gate that governs PR comments MUST
// govern BOTH names, or `gh api POST /issues/<pr#>/comments` is a one-line bypass.
// Collapsing the two into a single action was rejected: `gh issue comment` on a real
// issue is not a PR event, and merging them would make every issue comment trip a
// PR-review gate (over-block).
// ---------------------------------------------------------------------------

test('ENF-20 disambiguation: the pulls endpoint is unambiguously pr-comment', () => {
  assert.strictEqual(cls('gh api -X POST repos/o/r/pulls/42/comments -f body=x').action, 'pr-comment');
  assert.strictEqual(cls('gh pr comment 42 --body x').action, 'pr-comment');
});

test('ENF-20 disambiguation: the issues endpoint reports issue-comment (PR comments post here too)', () => {
  assert.strictEqual(cls('gh api -X POST repos/o/r/issues/42/comments -f body=x').action, 'issue-comment');
  assert.strictEqual(cls('gh issue comment 42 --body x').action, 'issue-comment');
});

test('ENF-20 disambiguation: PR_COMMENT_EQUIVALENT_ACTIONS names BOTH routes (T3 must govern both)', () => {
  assert.deepStrictEqual([...PR_COMMENT_EQUIVALENT_ACTIONS].sort(), ['issue-comment', 'pr-comment']);
  // The contract is load-bearing: governing both catches the issues-endpoint route.
  const viaIssuesEndpoint = parseCommand('gh api -X POST repos/open-gsd/gsd-core/issues/1738/comments -f body=CLEAR');
  assert.strictEqual(hasGovernedSegment(viaIssuesEndpoint, PR_COMMENT_EQUIVALENT_ACTIONS), true);
  // …and governing pr-comment ALONE does not (this is the bypass the contract closes).
  assert.strictEqual(hasGovernedSegment(viaIssuesEndpoint, ['pr-comment']), false);
});

test('ENF-20 purity: classify.cjs performs no I/O and reads no env (contract)', () => {
  const raw = require('node:fs').readFileSync(require('node:path').join(__dirname, 'classify.cjs'), 'utf8');
  // Strip block + line comments so the docblock's own prose ("Pure: no I/O, no
  // process.env") is not mistaken for a violation. The assertion is about CODE.
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.strictEqual(/node:fs|require\(['"]fs['"]\)/.test(code), false, 'must not require fs');
  assert.strictEqual(/process\.env/.test(code), false, 'must not read process.env');
  assert.strictEqual(/child_process/.test(code), false, 'must not spawn');
});

// ---------------------------------------------------------------------------
// INVARIANT (b) AT THE REAL ENTRYPOINT — spawn proofs.
//
// The unit rows above prove the PREDICATES say "not mine". These rows spawn the
// REAL `node hooks/<gate>.cjs` with a new-action command on stdin and assert the
// emitted permissionDecision is 'allow'. The four gates the task names explicitly
// are covered: gh-issue-create, gh-pr-create, containment, scan-gate (plus gh-edit,
// which is the gate the issue-close reclassification could plausibly disturb).
//
// The spawn runs in a hermetic SANDBOX carrying the gsd-core sentinel layout, so the
// gates resolve their LIVE scripts from a temp copy and the real checkout is never
// written to (and never even resolved). A PAIRED CONTROL asserts the same spawn in
// the same sandbox can still produce a DENY — otherwise an 'allow' here would be
// vacuous (the gate allowing because its environment is broken, not because the
// command is non-governed). crash != allow is enforced by proof-harness.
// ---------------------------------------------------------------------------

const nodePath = require('node:path');
const nodeFs = require('node:fs');
const { spawnHook } = require('./proof-harness.cjs');
const { makeSandbox } = require('./sandbox.cjs');
const { resolveGsdCoreRoot } = require('./resolve.cjs');

const HOOKS_DIR = nodePath.join(__dirname, '..');
const bashPayload = (command) => JSON.stringify({ tool_name: 'Bash', tool_input: { command } });

// Resolve a gsd-core checkout to COPY FROM (read-only). When none is reachable the
// spawn proofs skip with a note rather than fail on a missing EXTERNAL checkout.
function findSourceRoot() {
  let resolved = null;
  try {
    // resolveGsdCoreRoot THROWS (ScriptResolveError) when no checkout is reachable —
    // that is a "no sandbox source" signal here, not a test failure.
    resolved = resolveGsdCoreRoot(process.cwd());
  } catch (_) {
    resolved = null;
  }
  const candidates = [
    process.env.GSD_CORE_ROOT,
    resolved,
    nodePath.join(require('node:os').homedir(), 'repos', 'gsd-core'),
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (
        nodeFs.statSync(nodePath.join(c, 'scripts')).isDirectory() &&
        nodeFs.statSync(nodePath.join(c, 'gsd-core', 'bin', 'lib')).isDirectory()
      ) return c;
    } catch (_) { /* next candidate */ }
  }
  return null;
}

const SOURCE_ROOT = findSourceRoot();

// gate → [a new-action command that must ALLOW, a control command that must DENY]
const SPAWN_CASES = [
  ['gh-issue-create', 'gh issue comment 42 --body "a comment, not a create"', 'gh issue create --title "unterminated'],
  ['gh-pr-create', 'gh pr review 42 --approve', 'gh pr create --title "unterminated'],
  ['containment', 'gh pr merge 42 --squash', 'git add .planning/STATE.md'],
  ['scan-gate', 'gh api -X POST repos/o/r/pulls/42/reviews -f event=APPROVE', 'git push origin "unterminated'],
  ['gh-edit', 'gh api -X PATCH repos/o/r/issues/42 -f state=closed', 'gh issue edit 7 --body "unterminated'],
];

for (const [gate, allowCmd, denyCmd] of SPAWN_CASES) {
  test(`ENF-20 invariant (b) spawn: ${gate} ALLOWS a new-action command`, (t) => {
    if (!SOURCE_ROOT) {
      t.skip('no gsd-core checkout reachable to build the sandbox from');
      return;
    }
    const sb = makeSandbox({ sourceRoot: SOURCE_ROOT });
    try {
      const control = spawnHook(nodePath.join(HOOKS_DIR, `${gate}.cjs`), {
        stdin: bashPayload(denyCmd), cwd: sb.root,
      });
      assert.strictEqual(
        control.decision, 'deny',
        `CONTROL: ${gate} must still DENY ${JSON.stringify(denyCmd)} in this sandbox, else the ` +
        `allow below is vacuous — got ${control.decision} (${control.reason}) ${control.rawStderr}`
      );

      const res = spawnHook(nodePath.join(HOOKS_DIR, `${gate}.cjs`), {
        stdin: bashPayload(allowCmd), cwd: sb.root,
      });
      assert.strictEqual(res.conclusive, true, `${gate}: ${res.reason} ${res.rawStderr}`);
      assert.strictEqual(
        res.decision, 'allow',
        `${gate} must NOT fire on ${JSON.stringify(allowCmd)} — got ${res.decision}: ${res.rawStdout}`
      );
    } finally {
      sb.dispose();
    }
  });
}
