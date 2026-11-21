'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const LOCK_KEY_1 = 20261117;
const LOCK_KEY_2 = 1;

// Immutable SHA-256 baseline for the reviewed migration SQL at
// c1712db1d761389d0021f1a42844731468500e33. Existing ledger rows predate
// checksum storage; this pins their reviewed source files without pretending
// the historical database application recorded a checksum.
const APPROVED_MIGRATION_CHECKSUMS = Object.freeze({
  '001_foundation_database.sql': '5a47542cfbb66e814308072f842a182f837d9b1a9747060b6517788764c8724f',
  '002_distributed_bot_worker_indexes.sql': 'b2d6ca25efa36c9dc74cf78028548fec7ea2f6e1d8f49412c52d244dee46e87e',
  '003_bot_runtime_commands.sql': '4ff5d6a92662018fdb2d0fad1b047df3ccc86095ab5ca8f32aa4783a41224e01',
  '004_manager_command_recovery.sql': '9b6b11d4a624a8d1ce46bf65fd6b0b76cf3d2eef7bdb91f9bc7f114e1caf29d1',
  '005_worker_health_heartbeats.sql': 'ccdbcd7ebc8aaeb66ce924d06fa2d00ac89232025292a675872a80c180c2a947',
  '006_auto_remediation_audit.sql': 'e586d2edff10d8dc398775b56ae6475cd2aa1d7e5ceea21736f8570b621a9927',
  '007_platform_bot_inbox.sql': 'c3cb9414370e9e3b467b763bc43d2c3d90d026552082fe7553af8acbdffe3277',
  '20261118_bot_runtime_status.sql': 'cea92604a46b20c84d5a0c9e2dda1a008f5433f9adff394239db0ef176ae2009',
  '20261119_bot_inbound_update_lease_owner.sql': '70e69f5bc3f2bd2eb59356631dbb67a77246961aeaead587b21359dd5a8a17cf',
  '20261119_bot_update_transport.sql': '1c57cfc0efa0375708a5b62fcfa86d4be7bb2604436f00d0ce3bb8b084e688da',
  '20261121_project_notification_outbox.sql': 'deea9c9b3835bd632c5a7fad3ad815414cef0984bafdab02f409e2a0fdb19685'
});

// Add a migration only after reviewing its SQL, adding its SHA-256 above,
// and updating the migration tests.
const APPROVED_MIGRATION_FILES = Object.freeze(Object.keys(APPROVED_MIGRATION_CHECKSUMS));

function getMigrationChecksum(sql) {
  if (typeof sql !== 'string') {
    throw new TypeError('Migration SQL must be a string');
  }
  return crypto.createHash('sha256').update(sql, 'utf8').digest('hex');
}

function assertApprovedMigrationChecksum(filename, sql, checksumManifest = APPROVED_MIGRATION_CHECKSUMS) {
  const expected = checksumManifest[filename];
  if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/i.test(expected)) {
    throw new Error('Migration ' + filename + ' has no valid approved SHA-256 checksum');
  }

  const actual = getMigrationChecksum(sql);
  if (actual !== expected.toLowerCase()) {
    throw new Error(
      'Migration checksum mismatch for ' + filename + ': source SQL differs from the reviewed baseline'
    );
  }
  return actual;
}

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
      'Migration ' + filename + ' must contain a transaction beginning with BEGIN and ending with COMMIT'
    );
  }

  const body = sql.slice(start[0].length).replace(end, '').trim();

  if (!body) {
    throw new Error('Migration ' + filename + ' has an empty body');
  }

  return body;
}

function createMigrationRunner({
  pool,
  migrationsDir = __dirname,
  fsApi = fs,
  logger = console,
  approvedMigrationFiles = APPROVED_MIGRATION_FILES,
  approvedMigrationChecksums = APPROVED_MIGRATION_CHECKSUMS
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
      const legacyChecksumRows = [];

      try {
        const lock = await client.query(
          'SELECT pg_try_advisory_lock($1, $2) AS locked',
          [LOCK_KEY_1, LOCK_KEY_2]
        );

        lockAcquired = lock.rows[0]?.locked === true;

        if (!lockAcquired) {
          throw new Error('Another migration runner is already active');
        }

        await client.query(
          'CREATE TABLE IF NOT EXISTS schema_migrations (' +
          'version TEXT PRIMARY KEY, ' +
          'description TEXT NOT NULL, ' +
          'applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), ' +
          'checksum TEXT)'
        );
        // Upgrade existing ledgers additively. Historical rows remain NULL and
        // are explicitly reported; they are never silently assigned a checksum.
        await client.query(
          'ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum TEXT'
        );

        for (const filename of listMigrationFiles(migrationsDir, fsApi, approvedMigrationFiles)) {
          const version = filename.replace(/\.sql$/i, '');
          const sql = fsApi.readFileSync(
            path.join(migrationsDir, filename),
            'utf8'
          );
          const checksum = assertApprovedMigrationChecksum(
            filename,
            sql,
            approvedMigrationChecksums
          );

          const existing = await client.query(
            'SELECT version, checksum FROM schema_migrations WHERE version = $1',
            [version]
          );

          if (existing.rowCount > 0) {
            const recordedChecksum = existing.rows[0].checksum;
            if (recordedChecksum && recordedChecksum !== checksum) {
              throw new Error(
                'Migration checksum mismatch for ' + version +
                ': database ledger does not match the reviewed SQL'
              );
            }
            if (!recordedChecksum) {
              legacyChecksumRows.push(version);
              logger.warn(
                'Legacy migration has no recorded database checksum; reviewed source baseline verified: ' + version
              );
            }
            skipped.push(version);
            continue;
          }

          const body = extractMigrationBody(sql, filename);

          try {
            await client.query('BEGIN');
            await client.query(body);

            await client.query(
              'INSERT INTO schema_migrations(version, description, checksum) VALUES ($1, $2, $3)',
              [version, 'Applied migration file ' + filename, checksum]
            );

            await client.query('COMMIT');

            applied.push(version);
            logger.log('Migration applied: ' + version);
          } catch (error) {
            try {
              await client.query('ROLLBACK');
            } catch (_) {}

            throw new Error(
              'Migration ' + version + ' failed: ' + error.message,
              { cause: error }
            );
          }
        }

        return { applied, skipped, legacyChecksumRows };
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
  APPROVED_MIGRATION_CHECKSUMS,
  assertApprovedMigrationChecksum,
  createMigrationRunner,
  getMigrationChecksum,
  listMigrationFiles,
  extractMigrationBody
};
