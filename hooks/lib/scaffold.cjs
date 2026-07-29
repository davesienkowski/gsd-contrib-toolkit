'use strict';

/**
 * hooks/lib/scaffold.cjs — the ENF-20 obligation-scaffolding CONTRACT.
 *
 * WHY THIS EXISTS. The artifact gates (ENF-19, `protocol-artifact.cjs`) make an
 * evidence-free protocol step enforceable by demanding a file. Their cost is friction: the
 * first time an agent meets one it does not know the required shape, so the denial reads as
 * an obstacle rather than an instruction. This module removes exactly that friction — the
 * gate can deposit the skeleton it wants — and removes nothing else.
 *
 * THE LINE THIS MODULE MUST NEVER CROSS. CTK-ADR-0004 §Consequences is explicit that the
 * gates check artifact SHAPE, not honesty, and that their whole value is converting a skip
 * "from free and silent into deliberate and recorded". If the toolkit filled the artifact in,
 * skipping would become free, silent AND automatic: the gate would stop meaning "prove you
 * did the step" and start meaning "the gate does the step for you".
 *
 *   >>> SCAFFOLD OBLIGATIONS, NEVER EVIDENCE. <<<
 *
 * So every substantive field arrives as an unfilled sentinel, and `hasUnfilledPlaceholders`
 * is the check a gate runs IN ADDITION to its own shape assertions. A freshly scaffolded
 * artifact must FAIL the gate that wrote it — that property is asserted directly in
 * `scaffold.test.cjs`, and `scaffold()` re-checks it at runtime before returning, so a future
 * refactor cannot quietly start emitting a self-satisfying skeleton.
 *
 * DIVISION OF LABOUR with the gate:
 *   - this module answers "is any obligation still unmet on its face?" (the sentinel scan);
 *   - the GATE keeps its own assertions on top (`nonEmpty`, `equals`, `every`, live checks).
 *   Neither substitutes for the other: a placeholder string is `nonEmpty`, so shape checks
 *   alone would pass an untouched scaffold; and a filled-in lie passes both, which is the
 *   honesty limit CTK-ADR-0004 already records and this module does not pretend to close.
 *
 * FORMAT. The skeleton is emitted as VALID JSON. That is deliberate: the ENF-19 reader
 * `JSON.parse`s the artifact and fails closed on a malformed one, so a JSONC skeleton with
 * `//` comments would produce "this is not valid JSON" instead of the actionable "fill in the
 * placeholders". The per-field guidance therefore rides on the same LINE as its placeholder,
 * after the sentinel, rather than in a comment the parser would reject.
 *
 * This is a PURE-ish building block in the shape of `lib/marker.cjs`: the only I/O is through
 * an injected `deps.fs`, and it imports no gate machinery (no runGate/deny/allow). It is a
 * contract, not a gate.
 *
 * @module hooks/lib/scaffold
 */

const nodePath = require('node:path');

/** The opening delimiter of a field-named placeholder. */
const PLACEHOLDER_OPEN = '<<<FILL:';

/** The closing delimiter. Never required for DETECTION — see PLACEHOLDER_RE. */
const PLACEHOLDER_CLOSE = '>>>';

/** The bare, field-less sentinel, for callers that have no field name to name. */
const PLACEHOLDER = '<<<FILL>>>';

/**
 * The detection pattern, and the most security-relevant line in the file.
 *
 * It keys on the OPENING marker and tolerates delimiter erosion (`<FILL`, `<<FILL`,
 * `<<<FILL`), and it deliberately does NOT require the closing `>>>`. That is the
 * FAIL-CLOSED reading of a partially-edited placeholder: an agent that truncates a value, or
 * deletes the closing delimiter while leaving the marker, is still carrying an unmet
 * obligation and must still be denied.
 *
 * It does NOT key on `>>>` alone: a lone `>>>` is entirely plausible inside genuine OBSERVED
 * output (a Python REPL transcript, a quoted mail thread), and a false positive there would
 * make a correctly-filled artifact undeniably deniable.
 *
 * DOCUMENTED LIMIT: deleting the substring `FILL` itself is not detectable — at that point
 * the sentinel is gone and what remains is merely a bad value, which is the gate's own shape
 * assertions' job. There is no reading of "the marker is absent" that distinguishes it from
 * "the field was filled".
 *
 * Kept NON-GLOBAL on purpose: a `/g` regex carries `lastIndex` across `.test()` calls, so a
 * shared global pattern would answer differently on identical input. `findPlaceholders`
 * builds its own global copy per call.
 */
const PLACEHOLDER_RE = /<{1,3}FILL/;

/** Meta keys the skeleton carries for the human/agent reader. Prefixed so gates ignore them. */
const META_KEYS = Object.freeze(['_artifact', '_step', '_howto']);

/**
 * The fixed instruction block. MUST NOT contain the raw sentinel: it survives into the filled
 * artifact, so a sentinel here would make a fully-filled artifact read as unfilled forever.
 * (`scaffold.test.cjs` pins this by filling every field and asserting the result is clean.)
 */
const HOWTO =
  'Replace every FILL placeholder below with an OBSERVED value — what you actually ran and ' +
  'what it actually printed, not what you expected. This skeleton cannot satisfy the gate ' +
  'that wrote it: while any placeholder remains, the gate still denies.';

/**
 * The placeholder for a named field.
 *
 * @param {string} field the field name or dotted path (named so a denial can point at a line).
 * @returns {string}
 */
function placeholderFor(field) {
  const name = String(field === undefined || field === null ? '' : field).trim();
  if (!name) return PLACEHOLDER;
  return PLACEHOLDER_OPEN + name + PLACEHOLDER_CLOSE;
}

/**
 * Every placeholder marker occurrence in a text.
 *
 * @param {string} text
 * @returns {string[]} the matched markers (possibly empty).
 */
function findPlaceholders(text) {
  if (typeof text !== 'string') return [];
  const global = new RegExp(PLACEHOLDER_RE.source, 'g');
  return text.match(global) || [];
}

/**
 * Does this artifact text still carry an unmet obligation? THE check a gate calls.
 *
 * Fails CLOSED on anything that is not a non-empty string: a missing, unreadable or empty
 * artifact is not a filled one, and a gate must never read `false` ("nothing left to fill")
 * out of an absent value.
 *
 * @param {*} text raw artifact text.
 * @returns {boolean} true when the artifact is (or must be treated as) unfilled.
 */
function hasUnfilledPlaceholders(text) {
  if (typeof text !== 'string') return true;
  if (text.trim().length === 0) return true;
  return PLACEHOLDER_RE.test(text);
}

// ── spec validation ─────────────────────────────────────────────────────────

/**
 * A spec contract bug. Thrown, never returned: a malformed spec is a bug in the GATE TABLE,
 * not a condition a contributor can fix, and it must be loud rather than degrade into a
 * skeleton that might be self-satisfying. (Same posture as ENF-19's
 * "contract bug: assertion has no predicate" throw.)
 */
class ScaffoldContractError extends Error {
  constructor(message) {
    super('ENF-20 scaffold contract bug: ' + message);
    this.name = 'ScaffoldContractError';
  }
}

/**
 * Validate a spec, hard, before anything is rendered.
 *
 * @param {*} spec
 * @returns {{title:string, step:string, what:string, constants:Object, fields:Object[]}}
 * @throws {ScaffoldContractError}
 */
function validateSpec(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new ScaffoldContractError('spec must be an object');
  }

  const title = String(spec.title || spec.file || spec.id || '').trim();
  if (!title) {
    throw new ScaffoldContractError('spec needs a title (or `file`/`id`) naming the artifact');
  }

  const step = String(spec.step || '').trim();
  if (!step) {
    throw new ScaffoldContractError('spec needs a `step` naming the protocol step it belongs to');
  }

  const fields = spec.fields;
  if (!Array.isArray(fields) || fields.length === 0) {
    throw new ScaffoldContractError(
      'spec.fields must list at least one field — a skeleton with no placeholders would be ' +
        'self-satisfying, which is the one thing a scaffold may never be'
    );
  }

  const seen = new Set();
  for (const f of fields) {
    if (!f || typeof f !== 'object') {
      throw new ScaffoldContractError('each spec.fields entry must be an object');
    }
    const p = String(f.path || '').trim();
    if (!p) throw new ScaffoldContractError('each spec.fields entry needs a `path`');
    if (seen.has(p)) throw new ScaffoldContractError('duplicate field path `' + p + '`');
    seen.add(p);
    if (!String(f.observed || '').trim()) {
      throw new ScaffoldContractError(
        'field `' + p + '` needs `observed` — one line saying what an OBSERVED value looks ' +
          'like. A placeholder with no guidance recreates the friction this exists to remove.'
      );
    }
    // The whole point: a field may describe an obligation, never carry evidence.
    if (Object.prototype.hasOwnProperty.call(f, 'value') ||
        Object.prototype.hasOwnProperty.call(f, 'default')) {
      throw new ScaffoldContractError(
        'field `' + p + '` carries a `value`/`default`. A scaffold supplies OBLIGATIONS, never ' +
          'EVIDENCE — a pre-filled field is the toolkit doing the step for the agent.'
      );
    }
  }

  const constants = spec.constants && typeof spec.constants === 'object' ? spec.constants : {};
  for (const k of Object.keys(constants)) {
    const v = constants[k];
    if (typeof v === 'boolean') {
      throw new ScaffoldContractError(
        'constant `' + k + '` is a boolean. A boolean is the shape of a CLAIM (`reproduced: ' +
          'true`), never of a format — declare it as a field so the agent must assert it.'
      );
    }
    if (v !== null && typeof v !== 'string' && typeof v !== 'number') {
      throw new ScaffoldContractError(
        'constant `' + k + '` must be a string, number or null (format only)'
      );
    }
    if (seen.has(k)) {
      throw new ScaffoldContractError(
        'constant `' + k + '` collides with the declared field `' + k + '` — a constant would ' +
          'pre-fill it'
      );
    }
    if (META_KEYS.indexOf(k) !== -1) {
      throw new ScaffoldContractError('constant `' + k + '` collides with a reserved meta key');
    }
  }

  return { title, step, what: String(spec.what || '').trim(), constants, fields };
}

// ── rendering ───────────────────────────────────────────────────────────────

/**
 * Assign a dotted path into a plain object/array tree, creating containers as needed.
 *
 * A numeric segment means an ARRAY index. Indices must be assigned densely (append-only):
 * a gap would leave a JSON hole, which `JSON.stringify` renders as `null` — a value that
 * looks pre-filled and that no placeholder scan can flag. So a gap is a contract bug.
 *
 * @param {Object} root
 * @param {string} dotted
 * @param {*} value
 * @throws {ScaffoldContractError}
 */
function setPath(root, dotted, value) {
  const parts = String(dotted).split('.');
  let cur = root;

  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    const last = i === parts.length - 1;
    const isIndex = /^\d+$/.test(part);
    const nextIsIndex = !last && /^\d+$/.test(parts[i + 1]);

    if (isIndex) {
      if (!Array.isArray(cur)) {
        throw new ScaffoldContractError(
          'path `' + dotted + '` uses index `' + part + '` where the container is not a list'
        );
      }
      const idx = Number(part);
      if (idx > cur.length) {
        throw new ScaffoldContractError(
          'path `' + dotted + '` skips to index ' + idx + ' with only ' + cur.length +
            ' entrie(s) declared. Array indices must be dense — a gap serializes as a `null` ' +
            'that looks like a filled value.'
        );
      }
      if (last) {
        cur[idx] = value;
        return;
      }
      if (cur[idx] === undefined) cur[idx] = nextIsIndex ? [] : {};
      cur = cur[idx];
      continue;
    }

    if (Array.isArray(cur)) {
      throw new ScaffoldContractError(
        'path `' + dotted + '` uses key `' + part + '` where the container is a list'
      );
    }
    if (last) {
      cur[part] = value;
      return;
    }
    if (cur[part] === undefined) cur[part] = nextIsIndex ? [] : {};
    cur = cur[part];
  }
}

/**
 * Render the skeleton text for an artifact spec.
 *
 * Deterministic by construction: no timestamps, no ids, no randomness, and field order
 * follows spec order — so the output is diffable and testable, and two hook processes that
 * scaffold the same spec produce byte-identical files.
 *
 * @param {Object} spec
 * @param {string} spec.title the artifact's name (or `file`/`id`).
 * @param {string} spec.step the protocol step this artifact belongs to.
 * @param {string} [spec.what] one clause saying what the artifact records.
 * @param {Object} [spec.constants] FORMAT-only constants (e.g. `{schema: 1}`). Never evidence.
 * @param {Array<{path:string, observed:string}>} spec.fields the required fields, in order.
 * @returns {string} JSON text, newline-terminated.
 * @throws {ScaffoldContractError} on a malformed spec, or if the result could satisfy its gate.
 */
function scaffold(spec) {
  const s = validateSpec(spec);

  const doc = {};
  doc._artifact = s.what ? s.title + ' — ' + s.what : s.title;
  doc._step = s.step;
  doc._howto = HOWTO;

  for (const k of Object.keys(s.constants)) doc[k] = s.constants[k];

  for (const f of s.fields) {
    const p = String(f.path).trim();
    // The guidance rides on the placeholder's own line, after the sentinel — JSON has no
    // comments, and a JSONC skeleton would fail the reader before the placeholder check.
    setPath(doc, p, placeholderFor(p) + ' — ' + String(f.observed).trim());
  }

  const text = JSON.stringify(doc, null, 2) + '\n';

  // ── the runtime anti-cheat invariant ──────────────────────────────────────
  // Belt and braces over the test suite: if any refactor of the rendering above ever drops a
  // placeholder, this throws instead of shipping a skeleton that satisfies its own gate.
  for (const f of s.fields) {
    if (text.indexOf(placeholderFor(String(f.path).trim())) === -1) {
      throw new ScaffoldContractError(
        'rendered skeleton lost the placeholder for `' + f.path + '` — refusing to emit a ' +
          'partially self-satisfying artifact'
      );
    }
  }
  if (!hasUnfilledPlaceholders(text)) {
    throw new ScaffoldContractError(
      'rendered skeleton contains NO unfilled placeholder, so it would satisfy the gate that ' +
        'wrote it. Refusing to emit it (CTK-ADR-0004 §Consequences).'
    );
  }

  return text;
}

// ── writing ─────────────────────────────────────────────────────────────────

/**
 * Write the skeleton for `spec` at `filePath`, but ONLY when nothing is there.
 *
 * NEVER overwrites. Ten minutes of real work sitting in a half-finished artifact must not be
 * destroyed by a gate that happened to fire again, so the create is exclusive (`flag: 'wx'`,
 * i.e. `O_CREAT|O_EXCL`) and the kernel — not the `existsSync` pre-check — is what decides.
 * The pre-check exists only to report the friendly `exists` reason; two concurrent hook
 * processes can both pass it, and the loser gets `EEXIST` and reports `race`.
 *
 * HONEST LIMIT on atomicity: `O_EXCL` makes the CREATE atomic, and the payload is a single
 * sub-page write, but a reader that interleaves perfectly could still see a short file. Its
 * worst case is a JSON parse error in a gate that already fails closed — never a silent pass.
 *
 * I/O failures are RETURNED, not thrown: the caller is a gate that is already denying, and it
 * needs to describe what it did. A malformed SPEC still throws — that is a contract bug.
 *
 * @param {string} filePath absolute path to write.
 * @param {Object} spec see `scaffold`.
 * @param {Object} [deps]
 * @param {{existsSync:Function, mkdirSync:Function, writeFileSync:Function}} [deps.fs]
 * @returns {{written:boolean, path:string, bytes?:number, reason?:string, error?:string}}
 * @throws {ScaffoldContractError} on a bad path or a bad spec.
 */
function writeScaffoldIfAbsent(filePath, spec, deps = {}) {
  if (typeof filePath !== 'string' || filePath.trim().length === 0) {
    throw new ScaffoldContractError('writeScaffoldIfAbsent needs a non-empty path');
  }
  const fsImpl = deps.fs || require('node:fs');
  const text = scaffold(spec); // contract bugs throw here, before any I/O

  if (fsImpl.existsSync(filePath)) {
    return { written: false, path: filePath, reason: 'exists' };
  }

  try {
    fsImpl.mkdirSync(nodePath.dirname(filePath), { recursive: true });
  } catch (err) {
    return {
      written: false,
      path: filePath,
      reason: 'mkdir-failed',
      error: (err && err.message) || 'mkdir failure',
    };
  }

  try {
    fsImpl.writeFileSync(filePath, text, { encoding: 'utf8', flag: 'wx', mode: 0o644 });
  } catch (err) {
    // EEXIST from O_EXCL means another hook process created it between the pre-check and
    // now. That is a SUCCESS for the invariant (the artifact exists and was not clobbered).
    if (err && err.code === 'EEXIST') {
      return { written: false, path: filePath, reason: 'race' };
    }
    return {
      written: false,
      path: filePath,
      reason: 'write-failed',
      error: (err && err.message) || 'write failure',
    };
  }

  return { written: true, path: filePath, bytes: Buffer.byteLength(text, 'utf8') };
}

module.exports = {
  PLACEHOLDER,
  PLACEHOLDER_OPEN,
  PLACEHOLDER_CLOSE,
  PLACEHOLDER_RE,
  META_KEYS,
  HOWTO,
  ScaffoldContractError,
  placeholderFor,
  findPlaceholders,
  hasUnfilledPlaceholders,
  validateSpec,
  setPath,
  scaffold,
  writeScaffoldIfAbsent,
};
