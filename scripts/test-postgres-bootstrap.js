'use strict';

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required for the isolated PostgreSQL integration test');
  }

  const databaseUrl = new URL(process.env.DATABASE_URL);
  if (!['localhost', '127.0.0.1'].includes(databaseUrl.hostname) ||
      databaseUrl.pathname !== '/boss_bot_test' ||
      process.env.DATABASE_SSL !== 'disable') {
    throw new Error('Refusing integration test: only the isolated local boss_bot_test database with SSL disabled is allowed.');
  }

  const db = require('../db');
  const { createMigrationRunner, APPROVED_MIGRATION_FILES } = require('../migrations/runner');
  const { bootstrapDatabase } = require('./bootstrap-database');
  const migrationRunner = createMigrationRunner({ pool: db.pool });

  try {
    const bootstrap = await bootstrapDatabase({ db, migrationRunner });
    const secondRun = await migrationRunner.run();

    if (secondRun.applied.length !== 0 ||
        secondRun.skipped.length !== APPROVED_MIGRATION_FILES.length) {
      throw new Error('Migration idempotency check failed on the second bootstrap pass.');
    }

    const identity = await db.pool.query(
      'SELECT current_database() AS database_name, current_user AS database_role'
    );
    if (identity.rows[0]?.database_name !== 'boss_bot_test') {
      throw new Error('Integration test connected to an unexpected PostgreSQL database.');
    }

    console.log('PostgreSQL integration test passed:', JSON.stringify({
      verified: bootstrap.verified,
      migrationsApplied: bootstrap.migrations.applied.length,
      migrationsSkippedOnSecondRun: secondRun.skipped.length,
      database: 'boss_bot_test'
    }));
  } finally {
    await Promise.all([
      db.pool.end(),
      db.closeTelegramRuntimeLockPool()
    ]);
  }
}

main().catch((error) => {
  console.error('POSTGRES INTEGRATION TEST FAILED:', error.message);
  process.exitCode = 1;
});
