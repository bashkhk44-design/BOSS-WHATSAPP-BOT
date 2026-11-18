'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMigrationRunner, listMigrationFiles } = require('../migrations/runner');

function makePool({ locked = true } = {}) {
  const applied = new Set();
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked }], rowCount: 1 };
      if (sql.includes('SELECT version FROM schema_migrations')) {
        const exists = applied.has(params[0]);
        return { rows: exists ? [{ version: params[0] }] : [], rowCount: exists ? 1 : 0 };
      }
      if (sql.includes('INSERT INTO schema_migrations')) {
        applied.add(params[0]);
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release() { calls.push({ released: true }); }
  };
  return { pool: { async connect() { return client; } }, applied, calls };
}

test('migration runner applies pending files once and skips recorded versions', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-migrations-'));
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
  assert.equal(mock.calls.filter((call) => call.sql && call.sql.includes('BEGIN; SELECT 1; COMMIT;')).length, 1);
  assert.equal(mock.calls.filter((call) => call.released).length, 2);
});

test('migration runner refuses to proceed when another runner owns the lock', async () => {
  const mock = makePool({ locked: false });
  const runner = createMigrationRunner({
    pool: mock.pool,
    migrationsDir: os.tmpdir(),
    logger: { log() {}, error() {} }
  });

  await assert.rejects(runner.run(), /already active/);
  assert.equal(mock.calls.filter((call) => call.released).length, 1);
});

test('migration discovery includes only reviewed migration files', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-migration-list-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const name of ['20261118_bot_runtime_status.sql', 'notes.txt', '001_foundation_database.sql', '009_future_unreviewed.sql']) {
    fs.writeFileSync(path.join(directory, name), '');
  }
  assert.deepEqual(listMigrationFiles(directory), ['001_foundation_database.sql']);
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
