'use strict';

require('dotenv').config();

async function bootstrapDatabase({ db, migrationRunner }) {
  if (!db || typeof db.initDatabase !== 'function' ||
      typeof db.verifyDatabaseSchema !== 'function') {
    throw new TypeError('Database initialization and verification functions are required');
  }
  if (!migrationRunner || typeof migrationRunner.run !== 'function') {
    throw new TypeError('A migration runner is required');
  }

  // The reviewed migrations depend on prerequisite tables created by initDatabase().
  await db.initDatabase();
  const migrations = await migrationRunner.run();
  await db.verifyDatabaseSchema();

  return { migrations, verified: true };
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required for explicit database bootstrap');
  }

  const db = require('../db');
  const { createMigrationRunner } = require('../migrations/runner');
  const migrationRunner = createMigrationRunner({ pool: db.pool });

  try {
    const result = await bootstrapDatabase({ db, migrationRunner });
    console.log('BOSS database bootstrap complete:', JSON.stringify(result));
  } finally {
    await db.pool.end();
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error('BOSS DATABASE BOOTSTRAP FAILED:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { bootstrapDatabase, main };
