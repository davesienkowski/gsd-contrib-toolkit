'use strict';

/**
 * hooks/lib/worktree-add-detect.cjs — STUB (37-01 fail-first). Replaced by the tracer form.
 *
 * @module hooks/lib/worktree-add-detect
 */

const WORKTREE_ADD_WORD = /\bworktree\s+add\b/;

function findWorktreeAdds() {
  return [];
}

function classifyBase() {
  return 'other';
}

module.exports = { findWorktreeAdds, classifyBase, WORKTREE_ADD_WORD };
