#!/usr/bin/env node
'use strict';

/**
 * hooks/protocol-reminder.cjs — UserPromptSubmit P0–P6 contribution-protocol reminder
 * (ENF-08). This is the ONE advisory, FAIL-OPEN hook in the suite.
 *
 * Why fail-open (and why that is correct here):
 *   Every OTHER hook in this toolkit is an ENFORCEMENT gate and FAILS CLOSED (HARD-01): a
 *   parse failure / missing live script / unauth gh → DENY. This hook is NOT enforcement.
 *   PROJECT.md's honesty constraint: "Hooks lock OUTCOMES, not steps; 'always create todos
 *   first' stays MODEL-driven." A hook cannot force the model to create todos — so ENF-08 is
 *   a *reminder*, the honest model-driven layer. HARD-01's own clause says enforcement fails
 *   closed but automation / non-enforcement FAILS OPEN. A fail-CLOSED reminder would block
 *   EVERY prompt the moment this file had a bug — unacceptable for an advisory layer. So:
 *   any internal error → emit nothing, exit cleanly, NEVER block the prompt.
 *
 * What it does:
 *   UserPromptSubmit reads the user's prompt from stdin. If the prompt looks like a gsd-core
 *   CONTRIBUTION (file an issue / open a PR / contribute to gsd-core / gh issue|pr create /
 *   submit a bug …) it injects the P0–P6 contribution-protocol reminder as ADDITIONAL
 *   CONTEXT (UserPromptSubmit's `additionalContext` shape) — NOT a permissionDecision (this
 *   event has no allow/deny). An unrelated prompt injects nothing.
 *
 * The P0–P6 steps mirror the gsd-core-contribution skill's Execution Protocol (the canonical
 * source). Wording is Claude's discretion per 03-CONTEXT.md; the contract is only that it
 * enumerates P0 through P6.
 *
 * @module hooks/protocol-reminder
 */

/**
 * Signal set: phrases/patterns that mark a prompt as a gsd-core contribution intent.
 * Kept reasonably broad (issue / PR / contribute / gh issue|pr create / file a bug / submit)
 * but NOT "everything" — a generic "refactor this" must not trip it.
 */
const CONTRIBUTION_SIGNALS = [
  /\bfile (?:an? )?(?:issue|bug)\b/i,
  /\bopen (?:a )?(?:pr|pull request|issue)\b/i,
  /\b(?:create|submit|raise|report) (?:an? )?(?:issue|pr|pull request|bug)\b/i,
  /\bcontribut(?:e|ing|ion)\b/i,
  /\bgh (?:issue|pr) (?:create|edit)\b/i,
  /\bgsd-?core\b.*\b(?:issue|pr|pull request|contribut|bug|fix|patch)\b/i,
  /\b(?:issue|pr|pull request|contribut|bug|fix|patch)\b.*\bgsd-?core\b/i,
  /\bupstream\b.*\b(?:issue|pr|pull request|bug|fix|contribut)\b/i,
];

/**
 * Does this prompt look like a gsd-core contribution?
 * @param {*} prompt the user's prompt text
 * @returns {boolean}
 */
function isContributionPrompt(prompt) {
  if (typeof prompt !== 'string' || prompt.length === 0) return false;
  return CONTRIBUTION_SIGNALS.some((re) => re.test(prompt));
}

/**
 * The P0–P6 contribution-protocol reminder text (mirrors the gsd-core-contribution skill's
 * Execution Protocol). Enumerates all seven gates the contribution pipeline must clear.
 * @returns {string}
 */
function buildReminder() {
  return [
    'gsd-core contribution detected — follow the P0–P6 contribution protocol (the',
    'gsd-core-contribution skill is the source of truth; create it as tool-tracked todos BEFORE',
    'any other tool call). This is an ADVISORY reminder, not a gate:',
    '',
    '  P0  Ground in the canon: read CONTRIBUTING.md + the matching issue/PR templates + the',
    '      governing ADR(s) + CONTEXT.md. Do a POLICY-03 ADR/CONTEXT awareness sweep first.',
    '  P1  Verify the finding (trust-but-verify): reproduce the mechanism LIVE on src/*.cts —',
    '      a probe or a failing test. No repro → WITHDRAW.',
    '  P2  Adversarial law pass (skills-from-the-artificer): apply each firing law to the diff;',
    '      run POLICY-01 policy conformance (open + QUOTE the relevant ADRs) before filing.',
    '  P3  TDD the fix in a worktree off origin/next (rewire hooks, link node_modules,',
    '      build:lib): write the regression test FIRST and watch it FAIL, then GREEN. Run the',
    '      FULL relevant suites + `npm run lint:ci` + the QA-matrix-by-surface checklist.',
    '  P4  File the issue: body = template shape + `### GSD Version` + a user-impact statement +',
    '      cross-links. Run the version-gate on the EXACT body (must be valid-version), create',
    '      with labels, then remove `needs-triage` via REST.',
    '  P5  Open the PR: branch fix/<issue#>-slug off next; fix-template body + `Fixes #<issue#>`.',
    '      Run pr-template-policy on the EXACT body (valid:true). Add the `area:` label + changeset.',
    '  P6  Confirm CI is green on the LATEST commit: read the real check-runs on the head SHA.',
    '',
    'HARD GATE rule: a `[GATE]` step needs pasted command output proving its pass condition;',
    'do not advance a phase with an unmet gate. Skipping/reordering = stop and restart the phase.',
  ].join('\n');
}

/**
 * Pure evaluation: given the raw stdin string, decide what (if anything) to inject.
 *
 * FAIL OPEN: any malformed/non-string/uninteresting input → return null (inject nothing).
 * This function NEVER throws and NEVER returns a permissionDecision (UserPromptSubmit has no
 * allow/deny — it only contributes additional context).
 *
 * @param {*} stdinString raw JSON from the harness on stdin
 * @returns {{hookSpecificOutput: {hookEventName: 'UserPromptSubmit', additionalContext: string}} | null}
 */
function evaluatePrompt(stdinString) {
  try {
    if (typeof stdinString !== 'string' || stdinString.trim() === '') return null;
    const parsed = JSON.parse(stdinString);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const prompt = parsed.prompt;
    if (!isContributionPrompt(prompt)) return null;
    return {
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: buildReminder(),
      },
    };
  } catch (_) {
    // Advisory hook: ANY error fails OPEN — emit nothing, never block the prompt.
    return null;
  }
}

/**
 * Emit the UserPromptSubmit output and exit cleanly. On no-injection, emit nothing.
 * Always exit 0 — this hook never blocks a prompt.
 * @param {object|null} out result of evaluatePrompt
 */
function emit(out) {
  try {
    if (out) {
      process.stdout.write(JSON.stringify(out) + '\n');
    }
  } catch (_) {
    // Even a write failure must not block — swallow and exit clean.
  }
  process.exitCode = 0;
}

function main() {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => {
    buf += c;
  });
  process.stdin.on('end', () => {
    // Wrapped again at the boundary so a truly catastrophic failure still fails open.
    let out = null;
    try {
      out = evaluatePrompt(buf);
    } catch (_) {
      out = null;
    }
    emit(out);
  });
  process.stdin.on('error', () => emit(null));
}

if (require.main === module) {
  main();
}

module.exports = { isContributionPrompt, buildReminder, evaluatePrompt, emit };
