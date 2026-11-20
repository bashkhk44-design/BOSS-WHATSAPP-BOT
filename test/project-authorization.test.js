'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  configureManagerIdentity,
  assertAuthorizedManager,
  assertTelegramUserId
} = require('../project-authorization');

test('manager service authorization accepts only the configured manager identity', () => {
  configureManagerIdentity('7001');
  assert.equal(assertAuthorizedManager('7001'), true);
  assert.throws(() => assertAuthorizedManager('7002'), /غير مصرح/);
});

test('manager authorization rejects missing and malformed Telegram identities', () => {
  configureManagerIdentity('7001');
  assert.throws(() => assertAuthorizedManager(''), /غير صالح/);
  assert.throws(() => assertAuthorizedManager('7x01'), /غير صالح/);
});

test('customer identity validation requires a numeric Telegram ID', () => {
  assert.equal(assertTelegramUserId('8002'), true);
  assert.throws(() => assertTelegramUserId(''), /غير صالح/);
  assert.throws(() => assertTelegramUserId('80x2'), /غير صالح/);
});
