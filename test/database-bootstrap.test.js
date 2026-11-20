'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { bootstrapDatabase } = require('../scripts/bootstrap-database');

function dependencies({ failAt = null } = {}) {
  const calls = [];
  const db = {
    async initDatabase() {
      calls.push('init');
      if (failAt === 'init') throw new Error('init failed');
    },
    async verifyDatabaseSchema() {
      calls.push('verify');
      if (failAt === 'verify') throw new Error('verify failed');
      return true;
    }
  };
  const migrationRunner = {
    async run() {
      calls.push('migrate');
      if (failAt === 'migrate') throw new Error('migration failed');
      return { applied: ['001_foundation_database'], skipped: [] };
    }
  };
  return { db, migrationRunner, calls };
}

test('database bootstrap initializes prerequisites, migrates, then verifies', async () => {
  const deps = dependencies();
  const result = await bootstrapDatabase(deps);
  assert.deepEqual(deps.calls, ['init', 'migrate', 'verify']);
  assert.equal(result.verified, true);
  assert.deepEqual(result.migrations.applied, ['001_foundation_database']);
});

test('database bootstrap stops if prerequisite initialization fails', async () => {
  const deps = dependencies({ failAt: 'init' });
  await assert.rejects(bootstrapDatabase(deps), /init failed/);
  assert.deepEqual(deps.calls, ['init']);
});

test('database bootstrap stops if migrations fail and does not report verified', async () => {
  const deps = dependencies({ failAt: 'migrate' });
  await assert.rejects(bootstrapDatabase(deps), /migration failed/);
  assert.deepEqual(deps.calls, ['init', 'migrate']);
});

test('database bootstrap propagates final schema verification failures', async () => {
  const deps = dependencies({ failAt: 'verify' });
  await assert.rejects(bootstrapDatabase(deps), /verify failed/);
  assert.deepEqual(deps.calls, ['init', 'migrate', 'verify']);
});
