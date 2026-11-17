'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateWebhookEnvironment } = require('../webhook');

const validEnvironment = {
  DATABASE_URL: 'postgresql://test_user:test_password@localhost:5432/boss_test',
  BOTS_ENCRYPTION_KEY: 'b'.repeat(64)
};

test('webhook startup accepts PostgreSQL and a 32-byte hex encryption key', () => {
  assert.equal(validateWebhookEnvironment(validEnvironment), true);
});

test('webhook startup rejects a missing database URL', () => {
  assert.throws(
    () => validateWebhookEnvironment({ BOTS_ENCRYPTION_KEY: validEnvironment.BOTS_ENCRYPTION_KEY }),
    /DATABASE_URL is required/
  );
});

test('webhook startup rejects non-PostgreSQL database URLs', () => {
  assert.throws(
    () => validateWebhookEnvironment({
      ...validEnvironment,
      DATABASE_URL: 'https://example.invalid/database'
    }),
    /PostgreSQL protocol/
  );
});

test('webhook startup rejects missing, short, and malformed encryption keys', () => {
  for (const key of ['', 'b'.repeat(62), 'z'.repeat(64)]) {
    assert.throws(
      () => validateWebhookEnvironment({ ...validEnvironment, BOTS_ENCRYPTION_KEY: key }),
      /32-byte hex key/
    );
  }
});

test('webhook startup accepts uppercase hexadecimal encryption keys', () => {
  assert.equal(
    validateWebhookEnvironment({ ...validEnvironment, BOTS_ENCRYPTION_KEY: 'B'.repeat(64) }),
    true
  );
});
