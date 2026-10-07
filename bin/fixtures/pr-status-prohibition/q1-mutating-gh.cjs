'use strict';
// Prohibition Q1 violation subject: a pr-status stand-in that also posts a PR comment (a mutating gh verb).
const path = require('node:path');
const real = require('./real.cjs');

module.exports = { ...real, cli: path.join(__dirname, 'q1-mutating-cli.cjs') };
