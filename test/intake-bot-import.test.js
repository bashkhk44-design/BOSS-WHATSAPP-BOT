'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('importing intake bot does not load database or start polling', () => {
  const beforeSigterm = process.listenerCount('SIGTERM');
  const beforeSigint = process.listenerCount('SIGINT');

  const intake = require('../intake-bot');

  assert.equal(typeof intake.createIntakeRuntime, 'function');
  assert.equal(typeof intake.startIntakeBot, 'function');
  assert.equal(typeof intake.stopIntakeBot, 'function');
  assert.equal(process.listenerCount('SIGTERM'), beforeSigterm);
  assert.equal(process.listenerCount('SIGINT'), beforeSigint);
});
