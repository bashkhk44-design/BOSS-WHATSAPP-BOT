'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  APPROVED_MIGRATION_FILES,
  createMigrationRunner,
  createMigrationPoolOptions,
  listMigrationFiles,
  extractMigrationBody
} = require('../migrations/runner');

function makePool({ locked = true, failLedger = false } = {}) {
  const applied = new Set();
  const calls = [];

  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });

      if (sql.includes('pg_try_advisory_lock')) {
        return { rows: [{ locked }], rowCount: 1 };
      }

      if (sql.includes('SELECT version FROM schema_migrations')) {
        const exists = applied.has(params[0]);
        return {
          rows: exists ? [{ version: params[0] }] : [],
          rowCount: exists ? 1 : 0
        };
      }

      if (sql.includes('INSERT INTO schema_migrations')) {
        if (failLedger) throw new Error('Simulated ledger failure');
        applied.add(params[0]);
        return { rows: [], rowCount: 1 };
      }

      return { rows: [], rowCount: 0 };
    },

    release() {
      calls.push({ released: true });
    }
  };

  return {
    pool: { async connect() { return client; } },
    applied,
    calls
  };
}

test('migration pool options verify PostgreSQL TLS by default and when required', () => {
  const connectionString = 'postgresql://test:test@localhost:5432/boss_test';

  assert.equal(
    createMigrationPoolOptions({ DATABASE_URL: connectionString }).ssl,
    true
  );
  assert.equal(
    createMigrationPoolOptions({
      DATABASE_URL: connectionString,
      DATABASE_SSL: 'require'
    }).ssl,
    true
  );
  assert.equal(
    createMigrationPoolOptions({
      DATABASE_URL: connectionString,
      DATABASE_SSL: 'disable'
    }).ssl,
    false
  );
  assert.throws(
    () => createMigrationPoolOptions({
      DATABASE_URL: connectionString,
      DATABASE_SSL: 'prefer'
    }),
    /DATABASE_SSL must be either require or disable/
  );
});

test('migration runner applies pending files once and skips recorded versions', async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'boss-migrations-')
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  fs.writeFileSync(
    path.join(directory, '001_test_foundation.sql'),
    '-- migration header comment\n-- safe fixture\nBEGIN; SELECT 1; COMMIT;'
  );

  const mock = makePool();
  const runner = createMigrationRunner({
    pool: mock.pool,
    migrationsDir: directory,
    approvedMigrationFiles: ['001_test_foundation.sql'],
    logger: { log() {}, error() {} }
  });

  const first = await runner.run();
  const second = await runner.run();

  assert.deepEqual(first.applied, ['001_test_foundation']);
  assert.deepEqual(second.skipped, ['001_test_foundation']);
  assert.equal(mock.applied.size, 1);

  assert.equal(
    mock.calls.filter((call) => call.sql === 'BEGIN').length,
    1
  );
  assert.equal(
    mock.calls.filter((call) => call.sql === 'COMMIT').length,
    1
  );
  assert.equal(
    mock.calls.filter((call) => call.sql === 'ROLLBACK').length,
    0
  );
  assert.equal(
    mock.calls.filter((call) => call.sql && call.sql.includes('SELECT 1;')).length,
    1
  );
  assert.equal(
    mock.calls.filter((call) => call.released).length,
    2
  );
});

test('migration runner rolls back when ledger registration fails', async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'boss-migrations-')
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  fs.writeFileSync(
    path.join(directory, '001_test_failure.sql'),
    'BEGIN; SELECT 1; COMMIT;'
  );

  const mock = makePool({ failLedger: true });
  const runner = createMigrationRunner({
    pool: mock.pool,
    migrationsDir: directory,
    approvedMigrationFiles: ['001_test_failure.sql'],
    logger: { log() {}, error() {} }
  });

  await assert.rejects(runner.run(), /Simulated ledger failure/);

  assert.equal(mock.applied.size, 0);
  assert.equal(
    mock.calls.filter((call) => call.sql === 'BEGIN').length,
    1
  );
  assert.equal(
    mock.calls.filter((call) => call.sql === 'ROLLBACK').length,
    1
  );
  assert.equal(
    mock.calls.filter((call) => call.sql === 'COMMIT').length,
    0
  );
  assert.equal(
    mock.calls.filter((call) => call.released).length,
    1
  );
});

test('migration runner refuses to proceed when another runner owns the lock', async () => {
  const mock = makePool({ locked: false });
  const runner = createMigrationRunner({
    pool: mock.pool,
    migrationsDir: os.tmpdir(),
    approvedMigrationFiles: [],
    logger: { log() {}, error() {} }
  });

  await assert.rejects(runner.run(), /already active/);
  assert.equal(mock.calls.filter((call) => call.released).length, 1);
});

test('migration discovery executes only the explicit reviewed allowlist in its declared order', (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'boss-migration-list-')
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const approved = [
    '001_foundation_database.sql',
    '002_distributed_bot_worker_indexes.sql',
    '20261119_bot_update_transport.sql'
  ];
  for (const name of [
    '20261118_bot_runtime_status.sql',
    '20261119_bot_update_transport.sql',
    '009_future_unreviewed.sql',
    '001_foundation_database.sql',
    '002_distributed_bot_worker_indexes.sql',
    '000_staging_bootstrap.sql',
    'notes.txt'
  ]) {
    fs.writeFileSync(path.join(directory, name), '');
  }

  assert.deepEqual(listMigrationFiles(directory, fs, approved), approved);
  assert.deepEqual(
    listMigrationFiles(directory, fs, ['20261119_bot_update_transport.sql', '001_foundation_database.sql']),
    ['20261119_bot_update_transport.sql', '001_foundation_database.sql']
  );
});

test('migration discovery fails closed when an approved migration file is missing', (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'boss-migration-missing-')
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, '001_foundation_database.sql'), '');

  assert.throws(
    () => listMigrationFiles(directory, fs, [
      '001_foundation_database.sql',
      '002_distributed_bot_worker_indexes.sql'
    ]),
    /Missing approved database migration files: 002_distributed_bot_worker_indexes\.sql/
  );
});

test('default migration allowlist contains all currently reviewed migrations', () => {
  assert.equal(APPROVED_MIGRATION_FILES.length, 10);
  assert.ok(APPROVED_MIGRATION_FILES.includes('20261118_bot_runtime_status.sql'));
  assert.ok(APPROVED_MIGRATION_FILES.includes('20261119_bot_inbound_update_lease_owner.sql'));
  assert.ok(APPROVED_MIGRATION_FILES.includes('20261119_bot_update_transport.sql'));
  assert.equal(APPROVED_MIGRATION_FILES.includes('000_staging_bootstrap.sql'), false);
});

test('migration SQL wrapper is extracted without nested transaction commands', () => {
  const body = extractMigrationBody(
    '-- header\nBEGIN;\nCREATE TABLE example (id INTEGER);\nCOMMIT;',
    '001_example.sql'
  );

  assert.match(body, /CREATE TABLE example/);
  assert.doesNotMatch(body, /^\s*BEGIN/i);
  assert.doesNotMatch(body, /COMMIT\s*;?\s*$/i);
});

test('foundation migration has balanced PL/pgSQL dollar delimiters and ownership checks', () => {
  const sql = fs.readFileSync(
    path.join(__dirname, '..', 'migrations', '001_foundation_database.sql'),
    'utf8'
  );

  assert.equal((sql.match(/DO \$\$/g) || []).length, 3);
  assert.equal((sql.match(/END \$\$;/g) || []).length, 3);
  assert.doesNotMatch(sql, /DO \$(?:\s|\n)/);

  for (const constraint of [
    'telegram_bots_project_requires_client',
    'platform_jobs_project_requires_client',
    'ai_usage_project_requires_client',
    'platform_audit_project_requires_client'
  ]) {
    assert.ok(sql.includes(constraint), `missing ownership constraint: ${constraint}`);
  }
});
