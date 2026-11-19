'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  APPROVED_MIGRATION_FILES,
  listMigrationFiles
} = require('./runner');

test('migration runner returns only the seven reviewed migrations in order', () => {
  const availableFiles = [
    '20261118_bot_runtime_status.sql',
    '009_future_unreviewed.sql',
    '007_platform_bot_inbox.sql',
    '001_foundation_database.sql',
    '006_auto_remediation_audit.sql',
    '005_worker_health_heartbeats.sql',
    '004_manager_command_recovery.sql',
    '003_bot_runtime_commands.sql',
    '002_distributed_bot_worker_indexes.sql',
    '000_staging_bootstrap.sql',
    'README.md'
  ];

  const result = listMigrationFiles('/virtual/migrations', {
    readdirSync: () => availableFiles
  });

  assert.deepEqual(result, APPROVED_MIGRATION_FILES);
  assert.equal(result.includes('20261118_bot_runtime_status.sql'), false);
  assert.equal(result.includes('000_staging_bootstrap.sql'), false);
  assert.equal(result.includes('009_future_unreviewed.sql'), false);
});

test('migration runner does not invent missing allowlisted files', () => {
  const result = listMigrationFiles('/virtual/migrations', {
    readdirSync: () => [
      '001_foundation_database.sql',
      '003_bot_runtime_commands.sql',
      '20261118_bot_runtime_status.sql'
    ]
  });

  assert.deepEqual(result, [
    '001_foundation_database.sql',
    '003_bot_runtime_commands.sql'
  ]);
});
