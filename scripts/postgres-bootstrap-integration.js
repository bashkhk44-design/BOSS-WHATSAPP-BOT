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

    // Negative-path verification: an invalid/missing required index must fail schema validation.
    const indexDefinition = await db.pool.query(
      `SELECT pg_get_indexdef(index_meta.indexrelid) AS definition
       FROM pg_index index_meta
       JOIN pg_class index_row ON index_row.oid = index_meta.indexrelid
       WHERE index_row.relname = 'project_notification_outbox_ready_idx'`
    );
    if (!indexDefinition.rowCount) throw new Error('Expected verification-test index was not created.');
    await db.pool.query('DROP INDEX public.project_notification_outbox_ready_idx');
    let rejectedMissingIndex = false;
    try { await db.verifyDatabaseSchema(); } catch (error) {
      rejectedMissingIndex = /الفهارس/.test(error.message);
    }
    if (!rejectedMissingIndex) throw new Error('Schema verifier accepted a missing required index.');
    await db.pool.query(indexDefinition.rows[0].definition);

    // A CHECK constraint marked NOT VALID must also be rejected.
    const constraintDefinition = await db.pool.query(
      `SELECT table_row.relname AS table_name,
              pg_get_constraintdef(constraint_row.oid, true) AS definition
       FROM pg_constraint constraint_row
       JOIN pg_class table_row ON table_row.oid = constraint_row.conrelid
       WHERE constraint_row.conname = 'telegram_bots_update_transport_check'`
    );
    if (!constraintDefinition.rowCount) throw new Error('Expected verification-test constraint was not created.');
    const constraint = constraintDefinition.rows[0];
    await db.pool.query(`ALTER TABLE public.${constraint.table_name} DROP CONSTRAINT telegram_bots_update_transport_check`);
    await db.pool.query(`ALTER TABLE public.${constraint.table_name} ADD CONSTRAINT telegram_bots_update_transport_check ${constraint.definition} NOT VALID`);
    let rejectedUnvalidatedConstraint = false;
    try { await db.verifyDatabaseSchema(); } catch (error) {
      rejectedUnvalidatedConstraint = /القيود غير المعتمدة/.test(error.message);
    }
    if (!rejectedUnvalidatedConstraint) throw new Error('Schema verifier accepted an unvalidated required constraint.');
    await db.pool.query(`ALTER TABLE public.${constraint.table_name} DROP CONSTRAINT telegram_bots_update_transport_check`);
    await db.pool.query(`ALTER TABLE public.${constraint.table_name} ADD CONSTRAINT telegram_bots_update_transport_check ${constraint.definition}`);

    await db.verifyDatabaseSchema();
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
