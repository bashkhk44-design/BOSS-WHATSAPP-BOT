'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  assertAuthorizedManager,
  assertTelegramUserId
} = require('../project-authorization');

test('manager service authorization accepts only the configured manager identity', () => {
  assert.equal(assertAuthorizedManager('7001', '7001'), true);
  assert.throws(() => assertAuthorizedManager('7002', '7001'), /غير مصرح/);
  assert.throws(() => assertAuthorizedManager('7001', ''), /غير مصرح/);
});

test('manager authorization rejects missing and malformed Telegram identities', () => {
  assert.throws(() => assertAuthorizedManager('', '7001'), /غير صالح/);
  assert.throws(() => assertAuthorizedManager('7x01', '7x01'), /غير صالح/);
});

test('customer identity validation requires a numeric Telegram ID', () => {
  assert.equal(assertTelegramUserId('8002'), true);
  assert.throws(() => assertTelegramUserId(''), /غير صالح/);
  assert.throws(() => assertTelegramUserId('80x2'), /غير صالح/);
});
