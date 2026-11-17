'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('importing telegram master exposes a factory without starting runtime', () => {
  const beforeSigterm = process.listenerCount('SIGTERM');
  const beforeSigint = process.listenerCount('SIGINT');
  const beforeReady = process.listenerCount('boss:runtime-ready');

  const master = require('../telegram-master');

  assert.equal(typeof master.createMasterRuntime, 'function');
  assert.equal(process.listenerCount('SIGTERM'), beforeSigterm);
  assert.equal(process.listenerCount('SIGINT'), beforeSigint);
  assert.equal(process.listenerCount('boss:runtime-ready'), beforeReady);
});
