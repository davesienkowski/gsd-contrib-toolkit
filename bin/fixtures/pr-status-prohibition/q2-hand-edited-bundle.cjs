'use strict';
// Prohibition Q2 violation subject: a bundle skill file edited by hand so it no longer matches its source.
const real = require('./real.cjs');

module.exports = {
  ...real,
  bundlePairs: () => [{ name: 'maintainer-review-sweep/re-review.md', canonical: 'step 1\n', bundle: 'step 1\nhand edit in the bundle\n' }],
};
