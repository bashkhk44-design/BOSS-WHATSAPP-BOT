'use strict';

// One-time schema initializer for a brand-new, EMPTY Neon staging database.
// This script refuses to run without an explicit staging confirmation and
// refuses to initialize a database that already has public tables.

const REQUIRED_CONFIRMATION = 'CREATE_SCHEMA_IN_EMPTY_NEON_STAGING_DATABASE';

async function main() {
  if (process.env.BOSS_STAGING_DATABASE_CONFIRM !== REQUIRED_CONFIRMATION) {
    throw new Error('Refusing to run: set BOSS_STAGING_DATABASE_CONFIRM to the exact staging-only confirmation value.');
  }

  if (process.env.BOSS_STAGING_DATABASE_LABEL !== 'boss-bot-staging') {
    throw new Error('Refusing to run: BOSS_STAGING_DATABASE_LABEL must equal boss-bot-staging.');
  }

  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is missing.');
  }

  const parsed = new URL(process.env.DATABASE_URL);
  if (!parsed.hostname.endsWith('.neon.tech')) {
    throw new Error('Refusing to run: DATABASE_URL must point to a Neon host.');
  }

  const { pool, initDatabase } = require('../db');

  try {
    const identity = await pool.query(
      'SELECT current_database() AS database_name, current_user AS database_user'
    );

    const existing = await pool.query(`
      SELECT tablename
      FROM pg_catalog.pg_tables
      WHERE schemaname = 'public'
      ORDER BY tablename
    `);

    if (existing.rowCount > 0) {
      throw new Error(
        'Refusing to initialize a non-empty database. Found public tables: ' +
        existing.rows.map(row => row.tablename).join(', ')
      );
    }

    console.log('Verified empty Neon database:', identity.rows[0].database_name);
    console.log('Initializing BOSS BOT MASTER staging schema...');
    await initDatabase();
    console.log('Staging schema initialized successfully.');
  } finally {
    await pool.end();
  }
}

main().catch(error => {
  console.error('STAGING DATABASE INITIALIZATION FAILED:', error.message);
  process.exitCode = 1;
});
