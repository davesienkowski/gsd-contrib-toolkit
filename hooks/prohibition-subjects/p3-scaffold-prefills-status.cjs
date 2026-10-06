'use strict';

/**
 * VIOLATION SUBJECT (test-only) for 38-05 P3 / MEMEV-04 safety: the R8a-memtrace scaffold spec
 * pre-fills `status: 'unavailable'` as a constant. Re-exports ./real.cjs with ONLY the R8a entry of a
 * GATES copy changed (entry, spec and constants are frozen, so each is spread). Never wired, never
 * bundled.
 */

const real = require('./real.cjs');

const GATES = Object.freeze(
  real.reviewArtifact.GATES.map((g) =>
    g.id !== 'R8a-memtrace'
      ? g
      : Object.freeze(
          Object.assign({}, g, {
            spec: Object.freeze(
              Object.assign({}, g.spec, {
                constants: Object.freeze(Object.assign({}, g.spec.constants, { status: 'unavailable' })),
              })
            ),
          })
        )
  )
);

module.exports = Object.assign({}, real, {
  reviewArtifact: Object.assign({}, real.reviewArtifact, { GATES }),
});
