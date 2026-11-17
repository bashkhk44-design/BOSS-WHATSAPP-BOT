'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateWebhookEnvironment, getWebhookSslConfig } = require('../webhook');

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

test('webhook startup accepts supported database SSL modes', () => {
  for (const mode of ['require', 'disable']) {
    assert.equal(
      validateWebhookEnvironment({ ...validEnvironment, DATABASE_SSL: mode }),
      true
    );
  }
  assert.equal(validateWebhookEnvironment(validEnvironment), true);
});

test('webhook startup rejects unknown database SSL modes', () => {
  for (const mode of ['disabled', 'false', 'verify-full', '']) {
    assert.throws(
      () => validateWebhookEnvironment({ ...validEnvironment, DATABASE_SSL: mode }),
      /DATABASE_SSL must be either require or disable/
    );
  }
});

test('webhook PostgreSQL connections verify TLS certificates by default and when required', () => {
  assert.equal(getWebhookSslConfig({}), true);
  assert.equal(getWebhookSslConfig({ DATABASE_SSL: 'require' }), true);
});

test('webhook PostgreSQL TLS can only be disabled through explicit configuration', () => {
  assert.equal(getWebhookSslConfig({ DATABASE_SSL: 'disable' }), false);
});
