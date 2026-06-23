'use strict';

/**
 * hooks/lib/override.cjs — the GSD_CONTRIB_OVERRIDE parse + per-worktree logged
 * receipt writer (HARD-03 / edge-probe EP-5).
 *
 * Fail-closed (HARD-01) keeps a broken contribution physically impossible, but an
 * UN-escapable fail-closed bricks the workflow on a transient failure and gets the
 * toolkit disabled (red-team H-B). The escape valve is a DELIBERATE, LOGGED override:
 *
 *   GSD_CONTRIB_OVERRIDE=<reason>   (a REASON STRING, never a flag)
 *
 *   - A non-empty, non-whitespace value           → { override: true, reason }
 *   - Unset / empty / whitespace-only             → { override: false }
 *
 * The value is a REASON, not a boolean flag, and is entirely distinct from `--no-verify`
 * (which ENF-12 denies). Presence of `--no-verify` never sets the override; requiring a
 * non-empty reason forces the bypass to be intentional and accountable.
 *
 * The receipt is written PER-WORKTREE (keyed to the gsd-core worktree root) — this
 * project was BORN from a two-window concurrency bug (EP-5), so a single shared global
 * receipt is forbidden: two worktrees/sessions sharing one gsd-core must each write their
 * OWN receipt and never clobber each other. The write is APPEND-only (fs.appendFileSync,
 * O_APPEND) — never a read-modify-write that races under concurrency.
 *
 * @module hooks/lib/override
 */

const fs = require('node:fs');
const path = require('node:path');

const OVERRIDE_ENV = 'GSD_CONTRIB_OVERRIDE';
// Per-worktree receipt path, relative to the worktree root.
const RECEIPT_DIR = '.gsd-contrib';
const RECEIPT_FILE = 'override-receipts.log';

/**
 * Read GSD_CONTRIB_OVERRIDE and decide whether a deliberate override is in effect.
 *
 * @param {string} [worktreeRoot] accepted for symmetry with writeReceipt; the override
 *   DECISION itself is environment-driven (the receipt LOCATION is worktree-driven).
 * @returns {{override: boolean, reason?: string}}
 */
function checkOverride(worktreeRoot) {
  const raw = process.env[OVERRIDE_ENV];
  if (typeof raw !== 'string') {
    return { override: false };
  }
  const reason = raw.trim();
  if (reason.length === 0) {
    // Empty / whitespace-only is NOT an override — a bypass must carry a real reason.
    return { override: false };
  }
  return { override: true, reason };
}

/**
 * Resolve the per-worktree receipt file path. Keyed to the worktree root so distinct
 * worktrees never share (and never clobber) one receipt (EP-5).
 *
 * @param {string} worktreeRoot absolute path to the gsd-core worktree root.
 * @returns {string} absolute path to that worktree's receipt log.
 */
function receiptPathFor(worktreeRoot) {
  if (typeof worktreeRoot !== 'string' || worktreeRoot.trim().length === 0) {
    throw new TypeError('writeReceipt: worktreeRoot is required to key the per-worktree receipt');
  }
  return path.join(worktreeRoot, RECEIPT_DIR, RECEIPT_FILE);
}

/**
 * Append a timestamped receipt record for an honored override.
 *
 * Concurrency: uses fs.appendFileSync (O_APPEND), NOT a read-modify-write — so two
 * worktrees/sessions appending concurrently never clobber each other (EP-5). The path is
 * per-worktree, so even the file itself is not shared across worktrees.
 *
 * @param {string} worktreeRoot absolute gsd-core worktree root.
 * @param {{reason?: string, command?: string, action?: string, projectRoot?: string}} record
 *   `projectRoot` (optional): the realpath project root the receipt is accountable to. The receipt
 *   LOCATION is already per-worktree, but the capability off/remove receipt (Plan 12-02) also records
 *   the realpath(gsd-core) project root IN the record so the audit line is self-describing even if the
 *   log is copied out of the worktree. Omitted (override path) => the field is not added.
 */
function writeReceipt(worktreeRoot, record = {}) {
  const file = receiptPathFor(worktreeRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const command = record.command == null ? '' : String(record.command);
  const entry = {
    ts: new Date().toISOString(),
    reason: record.reason == null ? '' : String(record.reason),
    action: record.action == null ? '' : String(record.action),
    // Truncate the command so a giant body does not bloat the audit log.
    command: command.length > 500 ? command.slice(0, 500) + '…[truncated]' : command,
  };
  // Minimal generalization (Plan 12-02): record the accountable project root IN the entry when the
  // caller supplies it (off/remove). The override escape valve omits it, keeping its entry shape.
  if (record.projectRoot != null && String(record.projectRoot).length > 0) {
    entry.projectRoot = String(record.projectRoot);
  }
  // Append-only, newline-delimited JSON (jsonl): O_APPEND, no read-modify-write.
  fs.appendFileSync(file, JSON.stringify(entry) + '\n', { encoding: 'utf8' });
  return file;
}

module.exports = {
  OVERRIDE_ENV,
  RECEIPT_DIR,
  RECEIPT_FILE,
  checkOverride,
  writeReceipt,
  receiptPathFor,
};
