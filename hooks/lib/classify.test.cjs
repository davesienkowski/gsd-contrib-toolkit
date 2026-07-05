'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { parseCommand } = require('./argv.cjs');
const { classifyAction, findActionSegment, isNonGovernedCommand, hasGovernedSegment, resolveProgram } = require('./classify.cjs');

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
