'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validatePlatformWorkerEnvironment } = require('../platform-worker');

function validEnv(overrides = {}) {
  return {
    PLATFORM_BOT_WEBHOOK_MODE: 'enabled',
    DATABASE_URL: 'postgresql://app:secret@db.example.test/app',
    DATABASE_DIRECT_URL: 'postgresql://app:secret@db-direct.example.test/app',
    BOTS_ENCRYPTION_KEY: 'a'.repeat(64),
    TELEGRAM_BOT_TOKEN: 'master-token',
    TELEGRAM_ADMIN_ID: '12345',
    INTAKE_BOT_TOKEN: 'intake-token',
    ...overrides
  };
}

test('platform worker requires a PostgreSQL direct URL for its session-scoped advisory lock', () => {
  assert.throws(
    () => validatePlatformWorkerEnvironment(validEnv({ DATABASE_DIRECT_URL: '' })),
    /DATABASE_DIRECT_URL is required/
  );
  assert.throws(
    () => validatePlatformWorkerEnvironment(validEnv({ DATABASE_DIRECT_URL: 'https://db.example.test' })),
    /DATABASE_DIRECT_URL is required/
  );
  assert.equal(validatePlatformWorkerEnvironment(validEnv()), true);
});
