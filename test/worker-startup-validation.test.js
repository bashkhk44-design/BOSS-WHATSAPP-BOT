'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateWorkerEnvironment } = require('../worker');

const validEnvironment = {
  DATABASE_URL: 'postgresql://test_user:test_password@localhost:5432/boss_test',
  BOTS_ENCRYPTION_KEY: 'a'.repeat(64)
};

test('worker startup accepts a PostgreSQL URL and a 32-byte hex encryption key', () => {
  assert.equal(validateWorkerEnvironment(validEnvironment), true);
});

test('worker startup rejects a missing database URL', () => {
  assert.throws(
    () => validateWorkerEnvironment({ BOTS_ENCRYPTION_KEY: validEnvironment.BOTS_ENCRYPTION_KEY }),
    /DATABASE_URL is required/
  );
});

test('worker startup rejects non-PostgreSQL database URLs', () => {
  assert.throws(
    () => validateWorkerEnvironment({
      ...validEnvironment,
      DATABASE_URL: 'https://example.invalid/database'
    }),
    /PostgreSQL protocol/
  );
});

test('worker startup rejects missing, short, and malformed encryption keys', () => {
  for (const key of ['', 'a'.repeat(62), 'g'.repeat(64)]) {
    assert.throws(
      () => validateWorkerEnvironment({ ...validEnvironment, BOTS_ENCRYPTION_KEY: key }),
      /32-byte hex key/
    );
  }
});

test('worker startup accepts uppercase hexadecimal encryption keys', () => {
  assert.equal(
    validateWorkerEnvironment({ ...validEnvironment, BOTS_ENCRYPTION_KEY: 'A'.repeat(64) }),
    true
  );
});
