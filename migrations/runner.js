'use strict';

const fs = require('node:fs');
const path = require('node:path');

const LOCK_KEY_1 = 20261117;
const LOCK_KEY_2 = 1;

// Only reviewed migrations are executable. Add a new migration here only
// after reviewing its SQL and updating the migration tests.
const APPROVED_MIGRATION_FILES = Object.freeze([
  '001_foundation_database.sql',
  '002_distributed_bot_worker_indexes.sql',
  '003_bot_runtime_commands.sql',
  '004_manager_command_recovery.sql',
  '005_worker_health_heartbeats.sql',
  '006_auto_remediation_audit.sql',
  '007_platform_bot_inbox.sql',
  '20261118_bot_runtime_status.sql',
  '20261119_bot_inbound_update_lease_owner.sql',
  '20261119_bot_update_transport.sql'
]);

function listMigrationFiles(directory, fsApi = fs, approvedFiles = APPROVED_MIGRATION_FILES) {
  if (!Array.isArray(approvedFiles) || approvedFiles.some(name => typeof name !== 'string' || !/^\d+_[a-z0-9_-]+\.sql$/i.test(name))) {
    throw new TypeError('Approved migration files must be an array of numbered SQL filenames');
  }

  const available = new Set(fsApi.readdirSync(directory));
  const missing = approvedFiles.filter(name => !available.has(name));
  if (missing.length) {
    throw new Error('Missing approved database migration files: ' + missing.join(', '));
  }

  return [...approvedFiles];
}

function extractMigrationBody(sql, filename) {
  const start = sql.match(/^\s*(?:--[^\r\n]*(?:\r?\n|$)\s*)*BEGIN\s*;/i);
  const end = /\bCOMMIT\s*;\s*$/i;

  if (!start || !end.test(sql)) {
    throw new Error(
      `Migration ${filename} must contain a transaction beginning with BEGIN and ending with COMMIT`
    );
  }

  const body = sql.slice(start[0].length).replace(end, '').trim();

  if (!body) {
    throw new Error(`Migration ${filename} has an empty body`);
  }

  return body;
}

function createMigrationRunner({
  pool,
  migrationsDir = __dirname,
  fsApi = fs,
  logger = console,
  approvedMigrationFiles = APPROVED_MIGRATION_FILES
}) {
  if (!pool || typeof pool.connect !== 'function') {
    throw new TypeError('A PostgreSQL pool is required');
  }

  return {
    async run() {
      const client = await pool.connect();
      let lockAcquired = false;
      const applied = [];
      const skipped = [];

      try {
        const lock = await client.query(
          'SELECT pg_try_advisory_lock($1, $2) AS locked',
          [LOCK_KEY_1, LOCK_KEY_2]
        );

        lockAcquired = lock.rows[0]?.locked === true;

        if (!lockAcquired) {
          throw new Error('Another migration runner is already active');
        }

        await client.query(`
          CREATE TABLE IF NOT EXISTS schema_migrations (
            version TEXT PRIMARY KEY,
            description TEXT NOT NULL,
            applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `);

        for (const filename of listMigrationFiles(migrationsDir, fsApi, approvedMigrationFiles)) {
          const version = filename.replace(/\.sql$/i, '');

          const existing = await client.query(
            'SELECT version FROM schema_migrations WHERE version = $1',
            [version]
          );

          if (existing.rowCount > 0) {
            skipped.push(version);
            continue;
          }

          const sql = fsApi.readFileSync(
            path.join(migrationsDir, filename),
            'utf8'
          );
          const body = extractMigrationBody(sql, filename);

          try {
            await client.query('BEGIN');
            await client.query(body);

            await client.query(
              `INSERT INTO schema_migrations(version, description)
               VALUES ($1, $2)`,
              [version, `Applied migration file ${filename}`]
            );

            await client.query('COMMIT');

            applied.push(version);
            logger.log(`Migration applied: ${version}`);
          } catch (error) {
            try {
              await client.query('ROLLBACK');
            } catch (_) {}

            throw new Error(
              `Migration ${version} failed: ${error.message}`,
              { cause: error }
            );
          }
        }

        return { applied, skipped };
      } finally {
        if (lockAcquired) {
          try {
            await client.query(
              'SELECT pg_advisory_unlock($1, $2)',
              [LOCK_KEY_1, LOCK_KEY_2]
            );
          } catch (error) {
            logger.error(
              'Could not release migration advisory lock:',
              error.message
            );
          }
        }

        client.release();
      }
    }
  };
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required to run database migrations');
  }

  const { Pool } = require('pg');

  const databaseUrl = new URL(process.env.DATABASE_URL);
  const verifyTls = process.env.DATABASE_SSL_REJECT_UNAUTHORIZED === 'true';

  if (verifyTls) {
    const sslMode = databaseUrl.searchParams.get('sslmode');
    if (sslMode !== 'require' && sslMode !== 'verify-full') {
      throw new Error('Verified TLS requires sslmode=require or sslmode=verify-full');
    }
    // pg-connection-string maps sslmode=require to rejectUnauthorized:false.
    // Remove sslmode so the explicit certificate-verifying TLS options win.
    databaseUrl.searchParams.delete('sslmode');
  }

  const pool = new Pool({
    connectionString: databaseUrl.toString(),
    ssl: process.env.DATABASE_SSL === 'disable'
      ? false
      : verifyTls
        ? { rejectUnauthorized: true, servername: databaseUrl.hostname }
        : { rejectUnauthorized: false },
    max: 1,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 10000
  });

  try {
    const runner = createMigrationRunner({ pool });
    const result = await runner.run();
    console.log('Database migrations complete:', JSON.stringify(result));
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('DATABASE MIGRATION FAILED:', error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  APPROVED_MIGRATION_FILES,
  createMigrationRunner,
  listMigrationFiles,
  extractMigrationBody
};
