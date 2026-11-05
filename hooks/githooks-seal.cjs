#!/usr/bin/env node
'use strict';

/**
 * hooks/githooks-seal.cjs — PreToolUse(Bash) .githooks seal
 * (ENF-12 --no-verify flag-not-text + ENF-13 core.hooksPath=.githooks, HARD-01/04).
 *
 * Sealing the repo's own `.githooks` layer is higher-ROI than net-new gates (red-team
 * "what held up"): a fresh gsd-core worktree leaves `core.hooksPath` UNSET, so the repo's
 * pre-commit/pre-push gates are silently INERT — a contributor commits/pushes red without
 * ever running a single local gate. And `git commit --no-verify` / `-n` skips the hooks
 * even when they ARE wired. This gate denies both:
 *
 *   ENF-12 — a commit/push carrying the REAL `--no-verify` / `-n` argv flag → DENY.
 *            Crucially this consults the STRUCTURED flag space (hooks/lib/flags.hasFlag),
 *            never the raw command string and never the `-m` message value: so
 *            `git commit -m "never use --no-verify"` is NOT denied for the flag (the
 *            EP-3 false-positive boundary, threat T-03-04-FP — a false deny here gets the
 *            toolkit disabled). --no-verify is distinct from the GSD_CONTRIB_OVERRIDE
 *            valve (HARD-03), which this gate honors only for a thrown error; it does not lift this deny.
 *
 *   ENF-13 - a commit/push whose effective `core.hooksPath` in the resolved gsd-core worktree
 *            is not `.githooks` -> DENY (threat T-03-04-INERT), read from the LIVE git config
 *            (not a vendored guess). One exception: a session hooks dispatcher set through
 *            env config, which runs the hooks the repo's own value names. The commit/push is
 *            allowed when the effective value differs from the read with the env count key
 *            voided, passes dispatcherShape, the voided repo value is exactly `.githooks`, and
 *            the value passes a delegation canary (runDispatcherCanary, which states what that
 *            does and does not show). The check order in gate() is load-bearing: the canary
 *            executes a file named by a config value, so it runs last and only for a value
 *            that came from the hook's own env keys. The hook's reads run in the hook's env,
 *            so they do not see an override typed in the command itself. typedHooksPathOverride
 *            reads the command text for that: it denies a typed override, a repo option, a form it
 *            cannot read, an env config key name and a chained config write, before any read. It
 *            stops typed forms and is no seal against a workaround: CTK-ADR-0016 lists what stays open.
 *
 * Scope: only `commit` / `push` actions are gated; every other command (git reads, non-git)
 * passes through as a no-op allow, so the seal never over-blocks. HARD-01/04: the whole
 * decision runs inside runGate, so an unparseable command or a config-read failure FAILS
 * CLOSED (deny) — escapable only by a deliberate, logged GSD_CONTRIB_OVERRIDE.
 *
 * @module hooks/githooks-seal
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseCommand, parseCommandForGates, parseHeredocOperator, findHeredocBodyEnd } = require('./lib/argv.cjs');
const { classifyAction, isNonGovernedCommand, resolveProgram } = require('./lib/classify.cjs');
const { hasFlag } = require('./lib/flags.cjs');
const { runGate, readHookInput, deny, allow, emit, FailClosed, safeCommand } = require('./lib/failclosed.cjs');
const { resolveRootForCommand } = require('./lib/resolve.cjs');

// FailClosed/safeCommand: shared IN-03 helpers from failclosed.cjs.

const SEALED_ACTIONS = new Set(['commit', 'push']);
const REQUIRED_HOOKS_PATH = '.githooks';
const NO_VERIFY_FLAGS = ['--no-verify', '-n'];

const DISPATCHER_BASENAME = 'githooks-dispatch';
const CANARY_DIR_PREFIX = 'githooks-seal-canary-';
const CANARY_MARKER = 'canary-ran';
const CANARY_EXIT = 37;
const CANARY_TIMEOUT_MS = 5000;
// A relative marker, so no character of TMPDIR ever reaches a shell.
const CANARY_HOOK = `#!/bin/sh\n: > ${CANARY_MARKER}\nexit ${CANARY_EXIT}\n`;
// What a git hook's environment would point somewhere else. The config keys stay, so what runs
// in the canary is the dispatcher's own voiding of them.
const CANARY_ENV_DROP = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_PREFIX',
  'GIT_NAMESPACE',
  'GIT_CEILING_DIRECTORIES',
];

/**
 * A config value as git printed it, minus one trailing newline and no other change: `.githooks `
 * and `.GITHOOKS` must not compare equal to `.githooks`. A non-string (null, unset) reads as ''.
 *
 * @param {*} value
 * @returns {string}
 */
function stripOneNewline(value) {
  if (typeof value !== 'string') return '';
  return value.endsWith('\n') ? value.slice(0, -1) : value;
}

/**
 * The chained segments that ARE the sealed git action (commit/push).
 *
 * ENF-12 must consult ONLY these. `hasFlag` reports a flag's presence across the WHOLE
 * command's flag space, so scanning `parsed` directly makes any neighbor in the chain
 * that legitimately carries `-n` — `grep -n`, `sed -n`, `tail -n`, `sort -n` — read as a
 * `git commit -n`. Those are ubiquitous next to a commit, so the gate denied a large class
 * of correct commands.
 *
 * This is the SAME false-positive class the flag-not-text rule (EP-3) already closed, on a
 * second axis: that one was flag-vs-message-TEXT, this one is my-segment-vs-a-NEIGHBOR's.
 * Both end in the trust-eroding false deny that gets the toolkit switched off (red-team
 * H-B), which is the failure mode this module's own docstring calls load-bearing.
 *
 * Narrowing here must not weaken the seal, so this returns EVERY sealed segment rather
 * than the first: `git commit -m x && git push --no-verify` must still deny on the push.
 * (classify.findActionSegment is unsuitable — it returns one segment and falls back to
 * segs[0], which can be a non-git neighbor.) Mirrors the segment fan-out shape of
 * classify.hasGovernedSegment.
 *
 * PURE: reads only argv/classify output.
 *
 * @param {Object} parsed result of argv.parseCommand
 * @returns {Object[]} the segments classifying to a SEALED_ACTIONS action (possibly empty)
 */
function sealedSegments(parsed) {
  const segs = Array.isArray(parsed.segments) && parsed.segments.length > 0
    ? parsed.segments
    : [parsed];
  return segs.filter((seg) => {
    const r = classifyAction({ ok: true, segments: [seg] });
    return r && SEALED_ACTIONS.has(r.action);
  });
}

// --- The typed scan. Pure: no filesystem, no git, no env. ------------------------------------

// What each kind of hit tells the reader to do. Text D covers the accepted false denies too, so each
// of these has to be a way forward that works for them.
const ADVICE_REMOVE = 'Remove it from the command.';
const ADVICE_LITERAL =
  'Spell the option out in the command. A secret config value goes through `--config-env=<key>=<ENVVAR>`, ' +
  'since command lines can be read by other processes; `-c <key>="$VALUE"` is for a value that is not secret. ' +
  'This gate allows both for a key that does not name hooks config.';
const ADVICE_LITERAL_KEY =
  ADVICE_LITERAL + ' A key that needs other characters goes through `git config`, in its own Bash call.';
const ADVICE_OWN_CALL = 'Run that command in its own Bash call.';
const ADVICE_LET_HOOKS_RUN = 'Remove it and let the local gates run.';

const SEALING_WORDS = new Set(['commit', 'push']);
const ENV_KEY_NAME = /\bGIT_CONFIG_(?:COUNT|PARAMETERS|(?:KEY|VALUE)_\d+)\b/;
// A name built at run time: GIT_CONFIG_VALUE_$n is a real key to the shell and no literal name above.
const ENV_KEY_BUILT = /\bGIT_CONFIG_[A-Z0-9_]*[$`{(]/;
const REPO_ASSIGNMENT = /^(GIT_DIR|GIT_WORK_TREE|GIT_COMMON_DIR)=/;
const PLAIN_KEY = /^[A-Za-z0-9._:/@+%,-]+$/;
const SHELL_SYNTAX = /[$`{(]/;
const INCLUDE_IF_PATH = /^includeif\..*\.path$/;
// git's own options that consume the next word, read on git 2.43.0 (--super-prefix for older git). A value
// is never read for syntax: the parser drops quotes, so "$WT" and $WT are one token, and an unquoted value
// that word-splits into options is allowed (CTK-ADR-0016 names that family).
const OPTION_WITH_VALUE = new Set([
  '-C',
  '-c',
  '--config-env',
  '--namespace',
  '--attr-source',
  '--shallow-file',
  '--git-dir',
  '--work-tree',
  '--super-prefix',
]);
const CONFIG_READ_OPTIONS = new Set(['--get', '--get-all', '--get-regexp', '--get-urlmatch', '--list', '-l']);
const CONFIG_UNSET_WORDS = new Set(['--unset', '--unset-all', 'unset']);
const REDIRECT = /^(?:\d*|&)(?:>>|>&|<&|>\||<>|>|<)/;
// git 2.43, measured on both subcommands: --no-v, --no-ve and --no-ver are ambiguous with --no-verbose
// and git exits 129 with nothing run; --no-veri is the shortest spelling that skips the hook.
const NO_VERIFY_LONG = '--no-verify';
const NO_VERIFY_SHORTEST = '--no-veri';
// git commit's short options that take a value: required, then optional (attached only).
const COMMIT_SHORT_VALUE = 'mFcCt';
const COMMIT_SHORT_OPTIONAL_VALUE = 'uS';
// A hash that starts a word follows one of these, unescaped and unquoted.
const SHELL_METACHAR = /[ \t\n;&|()<>]/;
// A comment line holding one of these stays as tokens: see maskShellText.
const COMMENT_KEEP = /['"`;&|(){}]/;
const GIT_WORD = /^(?:.*\/)?git$/;
const SHELL_WORD = /^(?:.*\/)?(?:ba|da|k|z)?sh$/;
const SHELL_COMMAND_OPTION = /^-[A-Za-z]*c[A-Za-z]*$/;
const PAYLOAD_MAX_DEPTH = 3;
const UNREADABLE_VIEW = { unreadable: true, tokens: [], sealed: true };
// Programs that only read their words. Their segment skips the key rule only when no token holds shell
// syntax or a redirect, since either can assign in the current shell or write what a later line sources.
const READ_ONLY_PROGRAM = new Set(['echo', 'grep', 'rg', 'head', 'tail', 'cat', 'wc', 'ls', 'gh', 'unset']);
const REDIRECT_CHAR = /[<>]/;
const CONFIG_KEY_GLOB = /[*?[]/;

/**
 * The raw command as the scan reads it, in three steps that track bash:
 *
 *   A heredoc operator and its body go, keeping the newline that ended the introducing line. The splitter
 *   hands a body to the LAST segment of a chained introducing line, so `git commit -F- <<'EOF' && git log`
 *   would scan the message as tokens of the log segment. The operator goes too: left in place, the parse
 *   would read the next command line as its body.
 *   A backslash-newline leaves no characters, outside single quotes, as bash removes it.
 *   A comment goes through its newline (the newline stays), checked before the heredoc operator, so
 *   `# <<EOF` does not hide the next line.
 *
 * A comment goes only when its text on that line holds none of COMMENT_KEEP and no unquoted `${` is open.
 * This walker's quote state is flat, so it can call a hash a comment where bash is inside a nested quote,
 * a substitution or an expansion. Then a hidden command needs a closing delimiter or a separator, on that
 * line (COMMENT_KEEP) or, for `${`, on a later one (the depth). Removed text therefore moves no quote
 * state and hides no separator. A kept comment reads as ordinary tokens, which can false deny; CTK-ADR-0016
 * names that and the forms this reading leaves open.
 *
 * Quote and escape state track splitSegmentsWithOps, the same check order as gsd-test-detect's mask.
 * A here-string has no body. parseHeredocOperator refuses `<<<` at its first `<`, but the walk would
 * then read `<< word` at the second one, so the parser hides the lines after a here-string; here its
 * operator is blanked and its word stays an ordinary token, so the scan still reads those lines.
 *
 * @param {string} str a command that parsed
 * @returns {string}
 */
function maskShellText(str) {
  let out = '';
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  let wordStart = true;
  let braceDepth = 0;
  const pending = [];
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\' && !inSingle) {
      if (str[i + 1] === '\n') {
        i += 1;
        continue;
      }
      out += ch;
      escaped = true;
      wordStart = false;
      continue;
    }
    if (inSingle) {
      out += ch;
      if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      out += ch;
      if (ch === '"') inDouble = false;
      continue;
    }
    if (ch === '#' && wordStart && braceDepth === 0) {
      const newline = str.indexOf('\n', i);
      const end = newline === -1 ? str.length : newline;
      if (!COMMENT_KEEP.test(str.slice(i, end))) {
        i = end - 1;
        continue;
      }
    }
    wordStart = SHELL_METACHAR.test(ch);
    if (ch === '$' && str[i + 1] === '{') braceDepth += 1;
    else if (ch === '}' && braceDepth > 0) braceDepth -= 1;
    if (str.startsWith('<<<', i)) {
      out += '   ';
      i += 2;
      continue;
    }
    const hd = parseHeredocOperator(str, i);
    if (hd) {
      pending.push(hd);
      i = hd.end - 1;
      continue;
    }
    if (ch === '\n' && pending.length > 0) {
      out += ch;
      let bodyStart = i + 1;
      for (const h of pending) bodyStart = findHeredocBodyEnd(str, bodyStart, h.delim, h.dash);
      pending.length = 0;
      i = bodyStart - 1;
      continue;
    }
    if (ch === "'") inSingle = true;
    else if (ch === '"') inDouble = true;
    out += ch;
  }
  return out;
}

/**
 * Read a token as a `git commit` short-option cluster, left to right. Everything from the first
 * value-taking letter on is its value, so `-anm x` skips the hook and `-mn` is the message "n".
 *
 * @param {string} token
 * @returns {{skipsHook:boolean, takesNext:boolean}} takesNext: the next token is the value
 */
function readCommitCluster(token) {
  if (/^-[A-Za-z]+$/.test(token)) {
    for (let i = 1; i < token.length; i++) {
      const letter = token[i];
      if (letter === 'n') return { skipsHook: true, takesNext: false };
      if (COMMIT_SHORT_VALUE.includes(letter)) return { skipsHook: false, takesNext: i === token.length - 1 };
      if (COMMIT_SHORT_OPTIONAL_VALUE.includes(letter)) break;
    }
  }
  return { skipsHook: false, takesNext: false };
}

/** A prefix fused onto a word by the parser, gone: `(git`, `$(git`, `x=$(git`. A token with whitespace is a quoted value. */
function dropFused(token) {
  return /\s/.test(token) ? token : token.replace(/^.*[(`]/, '');
}

/** The sealing word in a token, with what bash would split off it gone: `commit)`, `commit>/dev/null`. */
function sealingWord(token) {
  const word = token.replace(/[)`<>].*$/, '');
  return SEALING_WORDS.has(word) ? word : null;
}

/**
 * One segment as the scan sees it. Its git: the resolved program, else the first token that is the word
 * git, which is what closes a compound form without a list of them. Sealed: a sealing word follows that git.
 * resolvedGit says whether the words after it are git's own: only then do the rules that read git's
 * option list apply, since a located git may be another program's argument (`grep -c git $f push`).
 */
function scanView(tokens) {
  const { prog, index: programAt } = resolveProgram({ tokens });
  const resolvedGit = prog === 'git';
  const index = resolvedGit ? programAt : tokens.findIndex((token) => GIT_WORD.test(dropFused(token)));
  const isGit = index !== -1;
  let first = -1;
  let last = -1;
  if (isGit) {
    for (let i = index + 1; i < tokens.length; i++) {
      if (sealingWord(tokens[i])) {
        if (first === -1) first = i;
        last = i;
      }
    }
  }
  return { tokens, index, isGit, resolvedGit, prog, programAt, first, last, sealed: last !== -1 };
}

/** The literal text a segment hands a shell: `eval`'s words, or the value of a shell's -c. Null when it has none. */
function payloadOf(view) {
  if (view.resolvedGit) return null;
  const words = view.tokens.map(dropFused);
  const at = words.findIndex((word) => word === 'eval' || SHELL_WORD.test(word));
  if (at === -1) return null;
  if (words[at] === 'eval') return view.tokens.slice(at + 1).join(' ');
  const option = words.findIndex((word, i) => i > at && SHELL_COMMAND_OPTION.test(word));
  if (option === -1) return null;
  return view.tokens[view.tokens[option + 1] === '--' ? option + 2 : option + 1] || null;
}

function holdsGitAndSealing(text) {
  return /(^|[\s(`/])git(\s|$)/.test(text) && /(^|\s)(commit|push)([\s)`<>]|$)/.test(text);
}

/**
 * The views of a text and of each literal payload in it, read to a bound of PAYLOAD_MAX_DEPTH. A payload
 * built from a variable reads as that variable: denying it would deny an ordinary `eval "$(ssh-agent)"`.
 * A payload that does not parse, or is past the bound, counts only if it holds git and a sealing word.
 *
 * @returns {Object[]|null} null: the text itself does not parse. Text that masks to nothing has no views.
 */
function viewsOf(text, depth) {
  const masked = maskShellText(text);
  if (masked.trim() === '') return [];
  const fine = parseCommand(masked, { cwdSeparators: true });
  if (!fine.ok) return null;
  const views = [];
  for (const seg of fine.segments) {
    const view = scanView(seg.tokens);
    views.push(view);
    const payload = payloadOf(view);
    if (payload === null) continue;
    const inner = depth < PAYLOAD_MAX_DEPTH ? viewsOf(payload, depth + 1) : null;
    if (inner) views.push(...inner);
    else if (holdsGitAndSealing(payload)) views.push(UNREADABLE_VIEW);
  }
  return views;
}

/** Does the key name something that moves core.hooksPath or brings config in. ASCII case-insensitive, as git's. */
function namesHooksConfig(key) {
  const lower = key.toLowerCase();
  return lower === 'core.hookspath' || lower === 'include.path' || INCLUDE_IF_PATH.test(lower);
}

/** The key of -c or --config-env. Its value is left alone: it cannot change the key before the first `=`. */
function configOptionHit(option, value) {
  const eq = value.indexOf('=');
  const key = eq === -1 ? value : value.slice(0, eq);
  if (namesHooksConfig(key)) {
    const harmless = option === '-c' && key.toLowerCase() === 'core.hookspath' && eq !== -1 && value.slice(eq + 1) === REQUIRED_HOOKS_PATH;
    if (harmless) return null;
    return { form: option + ' naming ' + key, advice: ADVICE_REMOVE };
  }
  if (!PLAIN_KEY.test(key)) {
    return { form: option + ' with a key this gate cannot read (' + key + ')', advice: ADVICE_LITERAL_KEY };
  }
  return null;
}

/**
 * The named rules read every token from after the program up to the last sealing word, with no walk, so
 * a value that shifts or breaks a walk cannot open one of these forms. What follows that word is never read.
 */
function namedOptionHit(view) {
  const { tokens, index, last } = view;
  for (let i = index + 1; i < last; i++) {
    const token = tokens[i];
    if (token === '-c' || token === '--config-env') {
      if (i + 1 < tokens.length) {
        const hit = configOptionHit(token, tokens[i + 1]);
        if (hit) return hit;
        i += 1;
      }
      continue;
    }
    if (token.startsWith('--config-env=')) {
      const hit = configOptionHit('--config-env', token.slice('--config-env='.length));
      if (hit) return hit;
      continue;
    }
    if (/^--(?:git-dir|work-tree)(?:=|$)/.test(token)) {
      return { form: 'the repo option ' + token, advice: ADVICE_REMOVE };
    }
  }
  return null;
}

/**
 * git's option list as git reads it, on the redirect-free tokens: an option holding shell syntax up to its
 * `=`, else the first bare word that is no option's value, the subcommand. Anything past that word is
 * never read here, so `git log "$B"..HEAD -- commit` allows. A wrong stop opens no named form; it opens a
 * shape that needs an expansion or a brace after it, which CTK-ADR-0016 names.
 *
 * @returns {{syntaxOption:(string|undefined), word:(string|undefined), rest:(string[]|undefined)}}
 */
function readOptionList(view) {
  const tokens = withoutRedirects(view.tokens.slice(view.index + 1));
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (OPTION_WITH_VALUE.has(token)) {
      i += 1;
      continue;
    }
    if (!token.startsWith('-')) return { word: token, rest: tokens.slice(i + 1) };
    const name = token.startsWith('--') && token.includes('=') ? token.slice(0, token.indexOf('=')) : token;
    if (SHELL_SYNTAX.test(name)) return { syntaxOption: token };
  }
  return {};
}

/** A named form first, then, only on a resolved git, shell syntax in git's own option list or its subcommand word. */
function regionHit(view) {
  const named = namedOptionHit(view);
  if (named || !view.resolvedGit) return named;
  const { syntaxOption, word } = readOptionList(view);
  const shown = syntaxOption || (word && SHELL_SYNTAX.test(word) ? word : null);
  return shown ? { form: 'shell syntax in the git options (' + shown + ')', advice: ADVICE_LITERAL } : null;
}

function keyNameHit(token) {
  const match = ENV_KEY_NAME.exec(token) || ENV_KEY_BUILT.exec(token);
  return match ? { form: 'the env config key name ' + match[0], advice: ADVICE_OWN_CALL } : null;
}

function isKeyName(token) {
  const match = ENV_KEY_NAME.exec(token);
  return match !== null && match[0] === token;
}

/**
 * The first token of a segment that names an env key where that can take effect.
 *
 * On a resolved git: a token before the program, unless it is the plain value of an unset; and a key name
 * in the region when the region holds shell syntax, since arithmetic or an expansion there assigns before
 * git starts. A message after the last sealing word is never read, so a heredoc message stays untouched.
 * On anything else, every token, unless the program only reads and the segment holds no syntax or redirect.
 * This fails closed on a program the list does not name, which a list of setters would not.
 */
function envKeyHit(view) {
  const { tokens, resolvedGit, index, last, prog, programAt } = view;
  let scanned;
  if (resolvedGit) {
    scanned = tokens.slice(0, index).filter((token, i) => {
      const before = tokens[i - 1];
      const unsets = isKeyName(token) && (before === '-u' || before === '--unset');
      return !unsets && !(token.startsWith('--unset=') && isKeyName(token.slice('--unset='.length)));
    }).map((token) => token.replace(/^-[A-Za-z]/, '')); // An attached short option leaves no word boundary: -SNAME.
    const region = last === -1 ? [] : tokens.slice(index + 1, last + 1);
    if (region.some((token) => SHELL_SYNTAX.test(token))) scanned = scanned.concat(region);
  } else {
    const onlyReads = READ_ONLY_PROGRAM.has(prog) && !tokens.some((token) => SHELL_SYNTAX.test(token) || REDIRECT_CHAR.test(token));
    scanned = onlyReads ? tokens.slice(0, programAt) : tokens;
  }
  for (const token of scanned) {
    const hit = keyNameHit(token);
    if (hit) return hit;
  }
  return null;
}

/** Drop redirects, and the separate target of a redirect operator standing alone. */
function withoutRedirects(tokens) {
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const match = REDIRECT.exec(tokens[i]);
    if (!match) out.push(tokens[i]);
    else if (match[0].length === tokens[i].length) i += 1;
  }
  return out;
}

/** A `git config` that writes the key beside a sealed segment: the read runs before the write. */
function configWriteHit(view) {
  if (!view.isGit) return null;
  const at = view.tokens.indexOf('config', view.index + 1);
  if (at === -1) return null;
  const rest = withoutRedirects(view.tokens.slice(at + 1));
  if (rest.some((token) => CONFIG_READ_OPTIONS.has(token.split('=')[0]))) return null;
  // A glob in the key position can name the key, and only git's own subcommand reads it as one.
  const own = view.resolvedGit ? readOptionList(view) : {};
  const globbed = own.word === 'config' && own.rest.find((token) => !token.startsWith('-'));
  if (globbed && CONFIG_KEY_GLOB.test(globbed)) return { form: 'a config write of ' + globbed, advice: ADVICE_OWN_CALL };
  const unsets = rest.some((token) => CONFIG_UNSET_WORDS.has(token));
  for (let i = 0; i < rest.length; i++) {
    if (!namesHooksConfig(rest[i])) continue;
    const value = rest[i + 1];
    // A named key with nothing after it prints the value and changes nothing.
    if (!unsets && value === undefined) return null;
    if (!unsets && rest[i].toLowerCase() === 'core.hookspath' && value === REQUIRED_HOOKS_PATH) return null;
    return { form: 'a config write of ' + rest[i], advice: ADVICE_OWN_CALL };
  }
  return null;
}

/**
 * A spelling that skips the hook and that ENF-12's exact flag lookup missed, after the first sealing
 * word: an abbreviation of --no-verify, or a commit short cluster holding n before any value-taking
 * letter. The full --no-verify and -n are read too: ENF-12 denies them first when it can see them, so
 * they only reach this on a token it cannot, such as one a continuation newline mangled.
 * The cluster rule waits for a bare commit word: on push, -n is a dry run.
 */
function noVerifySpellingHit(view) {
  const { tokens, first } = view;
  let afterCommit = false;
  for (let i = first; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '--') break;
    if (sealingWord(token) === 'commit') afterCommit = true;
    if (token.startsWith(NO_VERIFY_SHORTEST) && NO_VERIFY_LONG.startsWith(token)) {
      return { form: 'the hook-skipping spelling ' + token, advice: ADVICE_LET_HOOKS_RUN };
    }
    if (!afterCommit) continue;
    const cluster = readCommitCluster(token);
    if (cluster.skipsHook) return { form: 'the hook-skipping spelling ' + token, advice: ADVICE_LET_HOOKS_RUN };
    if (cluster.takesNext) i += 1;
  }
  return null;
}

/**
 * The one pure pass over a parsed command. It reads the newline split of the masked text: the default
 * parse keeps an unquoted newline inside one segment, so a neighbor line would widen a commit's region.
 * ENF-12 keeps reading parsed.segments, unchanged. A masked text that does not parse is refused when it
 * holds git and a sealing word; it never falls back to a body-bearing parse.
 *
 * @param {Object} parsed result of argv.parseCommandForGates
 * @returns {{override:(Object|null), noVerifySpelling:(Object|null)}}
 */
function scanCommand(parsed) {
  const nothing = { override: null, noVerifySpelling: null };
  if (!parsed || !parsed.ok) return nothing;
  const cannotRead = { form: 'text this gate cannot read', advice: ADVICE_OWN_CALL };
  const views = viewsOf(parsed.raw, 0);
  if (!views) return holdsGitAndSealing(parsed.raw) ? { override: cannotRead, noVerifySpelling: null } : nothing;
  const sealedViews = views.filter((view) => view.sealed);
  if (sealedViews.length === 0) return nothing;
  let override = null;
  for (const view of views) {
    if (view.unreadable) override = cannotRead;
    if (!override) override = envKeyHit(view);
    if (!override && view.sealed) {
      const assignment = view.tokens.slice(0, view.index).map(dropFused).find((token) => REPO_ASSIGNMENT.test(token));
      if (assignment) override = { form: 'a leading ' + assignment.split('=')[0] + ' assignment', advice: ADVICE_REMOVE };
    }
    if (!override && view.sealed) override = regionHit(view);
    if (!override) override = configWriteHit(view);
    if (override) break;
  }
  let noVerifySpelling = null;
  for (const view of sealedViews.filter((sealed) => sealed.resolvedGit)) {
    noVerifySpelling = noVerifySpellingHit(view);
    if (noVerifySpelling) break;
  }
  return { override, noVerifySpelling };
}

/**
 * A form typed in the command that the hook's own config reads cannot see, or that the gate cannot
 * read: a short string naming it, or null. A non-ok parse returns null (the fail-closed path owns it).
 *
 * @param {Object} parsed result of argv.parseCommandForGates
 * @returns {string|null}
 */
function typedHooksPathOverride(parsed) {
  const { override } = scanCommand(parsed);
  return override ? override.form : null;
}

// --- The deny texts, one per branch. Only text A says INERT, in the state where it is true. ---

function shownValue(value) {
  return value ? '`' + value + '`' : 'UNSET';
}

/** Text A: the repo-scope state, the one where `git config` is the fix. */
function repoValueDeny(hooksPath) {
  return deny(
    'This worktree\'s `core.hooksPath` is ' +
      shownValue(hooksPath) +
      ', so the repo\'s `.githooks` gates (pre-commit / pre-push) are silently INERT. ' +
      'Set it before committing/pushing: `git config core.hooksPath .githooks`. (ENF-13)'
  );
}

/** Text B: a dispatcher's shape with the wrong repo value. No canary ran, so it does not say this one delegates. */
function repoValueBehindDispatcherDeny(hooksPath, repoHooksPath) {
  return deny(
    'A dispatcher-shaped value (' + shownValue(hooksPath) + ') is in force for `core.hooksPath`. ' +
      'A delegating dispatcher runs the hooks the repo\'s own value names, and that value is ' +
      shownValue(repoHooksPath) +
      ', so the repo\'s `.githooks` gates do not run. ' +
      '`git config core.hooksPath .githooks` in this worktree writes the value the delegate reads. ' +
      'The effective value stays the dispatcher, and that is expected. ' +
      'If a session gate stops an agent\'s write, a human runs it in their own terminal. (ENF-13)'
  );
}

/** Text C: the effective value comes from where repo config cannot reach it. */
function effectiveValueDeny(hooksPath, detail) {
  return deny(
    'The effective `core.hooksPath` is ' +
      shownValue(hooksPath) +
      ' and comes from env or command config, which outranks repo config, ' +
      'so `git config core.hooksPath .githooks` cannot fix it. Remove the override. ' +
      detail +
      ' (ENF-13)'
  );
}

/**
 * Text D: a form typed in the command. No config value is at fault, so `git config` is not the fix.
 * It covers the accepted false denies too, so it says the gate does not tell harmless uses apart.
 */
function typedFormDeny(hit) {
  return deny(
    'This command has ' + hit.form + ' beside a commit or push. This form can run them without the ' +
      'repo\'s `.githooks` gates, and this gate does not tell harmless uses apart, so it denies. ' +
      '`git config core.hooksPath .githooks` is not the fix. ' +
      hit.advice +
      ' (ENF-13)'
  );
}

function canaryResultText(canary) {
  if (!canary) return 'no canary ran';
  const how = canary.signal
    ? 'signal ' + canary.signal
    : canary.status !== null && canary.status !== undefined
      ? 'exit ' + canary.status
      : 'error ' + canary.error;
  return 'marker ' + (canary.marker ? 'yes' : 'no') + ', ' + how;
}

/**
 * The pure gate decision with the impure git-config read injected.
 *
 * @param {string} stdinString raw PreToolUse JSON
 * @param {Object} deps
 * @param {() => (string|null)} deps.readHooksPath reads the effective core.hooksPath for the
 *   resolved gsd-core worktree (the value or null). MAY THROW -> fail closed.
 * @param {() => (string|null)} [deps.readRepoHooksPath] the same read with the env count key
 *   voided. MAY THROW -> fail closed. Absent: repo reads as equal to effective, so a caller
 *   injecting only readHooksPath can never reach the dispatcher allow.
 * @param {() => (string|null)} [deps.readHooksPathScope] the scope of the effective value, read only
 *   on the deny path of branch (c). A throw is a deny that names it. Absent: text A.
 * @param {(value:string) => {passed:boolean}} [deps.passesCanary] runs the delegation canary on
 *   the effective value. MAY THROW on a setup failure -> fail closed. Absent: deny.
 * @returns {{permissionDecision:string, permissionDecisionReason?:string}}
 */
function gate(stdinString, deps) {
  const input = readHookInput(stdinString);
  const command = (input.tool_input && input.tool_input.command) || '';

  const parsed = parseCommandForGates(command);
  if (!parsed.ok) throw new FailClosed('unparseable command: ' + parsed.reason);

  const scan = scanCommand(parsed);

  const action = classifyAction(parsed);
  // Only commit/push are sealed. Anything else (git reads, non-git) -> no-op allow, unless the typed
  // scan saw a sealed git segment that classifies other (space-form --config-env, say).
  if (!action || !SEALED_ACTIONS.has(action.action)) return scan.override ? typedFormDeny(scan.override) : allow();

  // (1) ENF-12 — the REAL --no-verify / -n flag (structured argv, never -m message text)
  // and never a CHAINED NEIGHBOUR's flag: scoped to the sealed git segment(s) only.
  const sealed = sealedSegments(parsed);
  if (sealed.some((seg) => hasFlag({ ok: true, segments: [seg] }, NO_VERIFY_FLAGS))) {
    return deny(
      '`--no-verify` / `-n` bypasses the repo\'s `.githooks` gates (pre-commit / pre-push). ' +
        'Remove it and let the local gates run. ' +
        '`GSD_CONTRIB_OVERRIDE` does not lift this deny: this gate honors it only for a thrown gate ' +
        'error. Turning the toolkit off is a human operator\'s decision, not a way past this deny: ' +
        '`node bin/contrib-capability.cjs off --reason "<why>"`, run from the toolkit checkout, strips ' +
        'the toolkit\'s gates from that gsd-core checkout and writes a receipt. (ENF-12)'
    );
  }

  // (2) ENF-13. A form typed in the command denies before any read: the reads below run in the
  // hook's env and cannot see it.
  if (scan.override) return typedFormDeny(scan.override);

  // (3) This order is load-bearing: the canary executes a file named by a config value, so it stays
  // last and never runs for a repo-scope value, a shape failure or a wrong repo value.

  // (a) The effective value is .githooks: the repo's own gates run. Reads may throw -> fail closed
  // (HARD-01).
  const hooksPath = stripOneNewline(deps.readHooksPath());
  if (hooksPath === REQUIRED_HOOKS_PATH) return allow();

  // (b) The voided read happens before anything looks at the value.
  const repoHooksPath = deps.readRepoHooksPath ? stripOneNewline(deps.readRepoHooksPath()) : hooksPath;

  // (c) Voiding the count key changed nothing, so the value did not come from the count keys.
  // The scope read runs here only, so a clean run pays nothing, and its failure is already a deny.
  if (repoHooksPath === hooksPath) {
    if (!deps.readHooksPathScope) return repoValueDeny(hooksPath);
    let scope;
    try {
      scope = deps.readHooksPathScope();
    } catch (err) {
      return effectiveValueDeny(
        hooksPath,
        'That reading is not confirmed: the scope read failed (' + (err && err.message) + ').'
      );
    }
    if (scope !== 'command') return repoValueDeny(hooksPath);
    return effectiveValueDeny(
      hooksPath,
      'Voiding the env count key does not change it' + (hooksPath ? '.' : ', and an empty env value reads as UNSET.')
    );
  }

  // (d) The value came from the hook's env keys and does not have a dispatcher's shape.
  const shape = dispatcherShape(hooksPath);
  if (!shape.genuine) {
    return effectiveValueDeny(hooksPath, 'It does not have a hooks dispatcher\'s shape (' + shape.why + ').');
  }

  // (e) A dispatcher runs the hooks the repo's own value names; that value must be .githooks.
  if (repoHooksPath !== REQUIRED_HOOKS_PATH) return repoValueBehindDispatcherDeny(hooksPath, repoHooksPath);

  // A spelling that skips the hook and that ENF-12 cannot see. Here only, on the dispatcher path, so a
  // dispatcher allow is the only verdict it can change; with an effective .githooks these stay allowed.
  if (scan.noVerifySpelling) return typedFormDeny(scan.noVerifySpelling);

  // (f) The value must pass the delegation canary. No canary wired means no allow.
  const canary = deps.passesCanary ? deps.passesCanary(hooksPath) : null;
  if (!canary || !canary.passed) {
    return effectiveValueDeny(
      hooksPath,
      'It did not pass the delegation canary (' + canaryResultText(canary) + '). A noexec TMPDIR makes the canary fail.'
    );
  }

  // (g)
  return allow();
}

/**
 * Injectable entry seam. Defaults readHooksPath to a live read of `core.hooksPath` from
 * the RESOLVED gsd-core worktree's git config (that worktree, not a global).
 *
 * @param {string} stdinString raw PreToolUse JSON
 * @param {Object} [deps]
 * @param {() => (string|null)} [deps.readHooksPath]
 * @param {() => (string|null)} [deps.readRepoHooksPath]
 * @param {() => (string|null)} [deps.readHooksPathScope]
 * @param {(value:string) => {passed:boolean}} [deps.passesCanary]
 * @param {Object} [deps.env] env for the live reads and the canary; defaults to process.env
 * @param {string} [deps.worktreeRoot]
 * @param {{checkOverride:Function, writeReceipt:Function}} [deps.overrideImpl]
 * @returns {{permissionDecision:string, permissionDecisionReason?:string}}
 */
function runGithooksGate(stdinString, deps = {}) {
  const ctx = {
    command: safeCommand(stdinString),
    action: 'githooks-seal',
    // OBS-02: read ONLY for session/tool ids in the verdict log; never logged verbatim.
    stdin: stdinString,
    worktreeRoot: deps.worktreeRoot,
    overrideImpl: deps.overrideImpl,
  };

  return runGate(() => {
    // RES-01 (D-07 uniformity): classify the governed action FIRST (pure parse→classify,
    // no filesystem) and short-circuit a confidently non-governed command to allow() BEFORE
    // resolveRootForCommand walks the tree — a non-commit/non-push command no longer pays a
    // filesystem walk. The governed set is SEALED_ACTIONS (commit/push); isNonGovernedCommand
    // narrows-not-weakens: unparseable/failClosed/commit/push fall through to the unchanged
    // resolve->gate path below (a governed commit/push still runs the ENF-12/ENF-13 seal). A typed
    // hit on a sealed git segment that classifies other reaches root resolution; no root still allows.
    const parsedForShortCircuit = parseCommandForGates(ctx.command);
    if (isNonGovernedCommand(parsedForShortCircuit, SEALED_ACTIONS) && typedHooksPathOverride(parsedForShortCircuit) === null) {
      return allow();
    }

    const resolved = Object.assign({}, deps);
    if (!resolved.readHooksPath) {
      const root = resolved.worktreeRoot || resolveRootForCommand(ctx.command, process.cwd());
      if (!root) return allow();
      ctx.worktreeRoot = ctx.worktreeRoot || root;
      const env = resolved.env || process.env;
      resolved.readHooksPath = () => readHooksPathLive(root, env);
      resolved.readRepoHooksPath = resolved.readRepoHooksPath || (() => readRepoHooksPathLive(root, env));
      resolved.readHooksPathScope = resolved.readHooksPathScope || (() => readHooksPathScopeLive(root, env));
      resolved.passesCanary = resolved.passesCanary || ((value) => runDispatcherCanary(value, { env }));
    }
    return gate(stdinString, resolved);
  }, ctx);
}

/**
 * Live read of `git config --get core.hooksPath` for a specific worktree. Returns the value
 * minus one trailing newline with no trim, or null when the key is unset or empty. THROWS on a
 * real git failure (not the "unset" exit code 1) so runGate fails closed (HARD-01).
 *
 * @param {string} root absolute gsd-core worktree root
 * @param {Object} [env] the child's environment; defaults to process.env
 * @returns {string|null}
 */
function readHooksPathLive(root, env = process.env) {
  const res = spawnSync('git', ['-C', root, 'config', '--get', 'core.hooksPath'], {
    encoding: 'utf8',
    env,
  });
  if (res.error) {
    throw new FailClosed('could not read core.hooksPath: ' + res.error.message);
  }
  // git config --get exits 1 when the key is simply not set — that is "unset", not an error.
  if (res.status === 1) return null;
  if (res.status !== 0) {
    throw new FailClosed(
      'git config --get core.hooksPath failed (exit ' + res.status + '): ' + (res.stderr || '')
    );
  }
  const out = stripOneNewline(String(res.stdout || ''));
  return out.length > 0 ? out : null;
}

/**
 * The repo value a delegating dispatcher reads: the same read with only the env count key
 * voided, the way the dispatcher's delegate voids it. GIT_CONFIG_PARAMETERS is never voided, so
 * a value from there stays equal to the effective read and cannot reach the canary.
 *
 * @param {string} root absolute gsd-core worktree root
 * @param {Object} [env] the hook's environment; defaults to process.env
 * @returns {string|null}
 */
function readRepoHooksPathLive(root, env = process.env) {
  const voided = Object.assign({}, env);
  delete voided.GIT_CONFIG_COUNT;
  return readHooksPathLive(root, voided);
}

/**
 * The scope git reports for the effective value: `command` for env or command config, `local`,
 * `global` and so on. Null when the key is unset. Output is `scope<TAB>value`. THROWS on a spawn error
 * or a status other than 0 or 1; gate() catches that in the branch, where it is already a deny.
 *
 * @param {string} root absolute gsd-core worktree root
 * @param {Object} [env] the hook's environment; defaults to process.env
 * @returns {string|null}
 */
function readHooksPathScopeLive(root, env = process.env) {
  const res = spawnSync('git', ['-C', root, 'config', '--show-scope', '--get', 'core.hooksPath'], {
    encoding: 'utf8',
    env,
  });
  if (res.error) throw new FailClosed('could not read the core.hooksPath scope: ' + res.error.message);
  if (res.status === 1) return null;
  if (res.status !== 0) {
    throw new FailClosed('git config --show-scope failed (exit ' + res.status + '): ' + (res.stderr || ''));
  }
  const out = String(res.stdout || '');
  const tab = out.indexOf('\t');
  return tab === -1 ? out.trim() : out.slice(0, tab);
}

/**
 * Does this value have a hooks dispatcher's shape: an absolute path to a directory named exactly
 * githooks-dispatch, holding a regular _delegate.sh and executable regular pre-commit and pre-push.
 *
 * Never throws. Every fs error (ENOENT, ENOTDIR, EACCES, ELOOP, any other) is about the value, not
 * a failed read, so it is a returned not-genuine: a throw would let the override valve lift a
 * directory nothing tested. Reads metadata only and executes nothing.
 *
 * @param {*} value the effective core.hooksPath
 * @returns {{genuine:boolean, why:string}}
 */
function dispatcherShape(value) {
  const notGenuine = (why) => ({ genuine: false, why });
  if (typeof value !== 'string' || value.length === 0) return notGenuine('no value');
  if (!path.isAbsolute(value)) return notGenuine('not an absolute path');
  if (path.basename(value) !== DISPATCHER_BASENAME) {
    return notGenuine('basename is not ' + DISPATCHER_BASENAME);
  }
  try {
    if (!fs.statSync(value).isDirectory()) return notGenuine('not a directory');
    if (!fs.statSync(path.join(value, '_delegate.sh')).isFile()) {
      return notGenuine('_delegate.sh is not a regular file');
    }
    for (const name of ['pre-commit', 'pre-push']) {
      const stat = fs.statSync(path.join(value, name));
      if (!stat.isFile()) return notGenuine(name + ' is not a regular file');
      if ((stat.mode & 0o111) === 0) return notGenuine(name + ' is not executable');
    }
  } catch (err) {
    return notGenuine((err && err.code) || 'stat failed');
  }
  return { genuine: true, why: 'shape matches' };
}

/** The canary's throwaway repo, in tmp: a repo value of .githooks and a hook that marks and fails. */
function writeCanaryRepo(tmp, env) {
  const init = spawnSync('git', ['init', '-q'], {
    cwd: tmp,
    env,
    stdio: 'ignore',
    timeout: CANARY_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  });
  if (init.error) throw init.error;
  if (init.status !== 0) {
    throw new Error('git init failed (exit ' + init.status + ', signal ' + init.signal + ')');
  }
  fs.appendFileSync(path.join(tmp, '.git', 'config'), '[core]\n\thooksPath = ' + REQUIRED_HOOKS_PATH + '\n');
  const hook = path.join(tmp, REQUIRED_HOOKS_PATH, 'pre-commit');
  fs.mkdirSync(path.dirname(hook));
  fs.writeFileSync(hook, CANARY_HOOK);
  fs.chmodSync(hook, 0o755);
}

/**
 * Run `<value>/pre-commit` in a throwaway repo whose own pre-commit writes a marker and exits 37.
 * Passes only when the marker exists and the exit status is exactly 37: the repo hook ran, and its
 * failure blocks.
 *
 * What passing shows is one thing: this file ran a hook in one throwaway repo and passed its failing
 * exit through. Everything else stays open, by decision:
 *   - A faithful functional copy of the dispatcher passes. It does delegate, so the gates run, and
 *     no identity is available without a personal path.
 *   - A forged dispatcher that detects the canary (by its temp path, say) passes. Having one in
 *     force for a session takes a change to the hook's env, which also controls every gate's env.
 *   - An honest but wrong dispatcher that behaves only in an empty non-linked repo, or that hardcodes
 *     ./.githooks, passes.
 *   - Only pre-commit runs. pre-push is checked as an executable file only: running it would run
 *     another repo's push policy inside this gate, so a dispatcher whose pre-push does not delegate
 *     passes this seal on a push.
 *
 * A setup failure (mkdtemp, git init, writing the fixture) throws FailClosed, which a logged override
 * can lift like any other gate fault. Anything from spawning the value file (ENOENT, EACCES, ETIMEDOUT,
 * a signal) is a returned failure and never a throw, so the valve cannot lift a value that failed.
 * The kill is SIGKILL because a stub that traps TERM would hold spawnSync past the bound, and a hook
 * that times out does not block the tool call. stdio is ignored, so the gate's stdout stays its own
 * and no grandchild holding a pipe can keep it waiting.
 *
 * Parallel runs use separate mkdtemp directories. An interrupted run can leave one behind; a later
 * run never reads it.
 *
 * @param {string} value a value that passed dispatcherShape
 * @param {Object} [opts]
 * @param {Object} [opts.env] the hook's environment; defaults to process.env
 * @param {number} [opts.timeoutMs] bound on the value file's run; defaults to 5000
 * @returns {{passed:boolean, marker:boolean, status:(number|null), signal:(string|null), error:(string|null)}}
 */
function runDispatcherCanary(value, opts = {}) {
  const env = Object.assign({}, opts.env || process.env);
  for (const key of CANARY_ENV_DROP) delete env[key];
  const timeout = opts.timeoutMs === undefined ? CANARY_TIMEOUT_MS : opts.timeoutMs;
  let tmp = null;
  try {
    try {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), CANARY_DIR_PREFIX));
      writeCanaryRepo(tmp, env);
    } catch (err) {
      throw new FailClosed('could not set up the delegation canary: ' + err.message);
    }
    let res;
    try {
      res = spawnSync(path.join(value, 'pre-commit'), [], {
        cwd: tmp,
        env,
        stdio: 'ignore',
        timeout,
        killSignal: 'SIGKILL',
      });
    } catch (err) {
      res = { error: err, status: null, signal: null };
    }
    const marker = fs.existsSync(path.join(tmp, CANARY_MARKER));
    return {
      passed: marker && res.status === CANARY_EXIT,
      marker,
      status: res.status,
      signal: res.signal,
      error: res.error ? res.error.code || res.error.message : null,
    };
  } finally {
    if (tmp) {
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
      } catch (_) {
        /* a removal failure must not flip a verdict */
      }
    }
  }
}


function main() {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => {
    buf += c;
  });
  process.stdin.on('end', () => {
    emit(runGithooksGate(buf));
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  runGithooksGate,
  gate,
  readHooksPathLive,
  readRepoHooksPathLive,
  readHooksPathScopeLive,
  dispatcherShape,
  runDispatcherCanary,
  typedHooksPathOverride,
  maskShellText,
  REQUIRED_HOOKS_PATH,
  NO_VERIFY_FLAGS,
};
