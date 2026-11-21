'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  APPROVED_MIGRATION_FILES,
  APPROVED_MIGRATION_CHECKSUMS,
  assertApprovedMigrationChecksum,
  createMigrationRunner,
  getMigrationChecksum
} = require('./runner');

const TEST_FILE = '001_test_migration.sql';
const TEST_SQL = 'BEGIN;\nSELECT 1;\nCOMMIT;\n';
const TEST_CHECKSUM = getMigrationChecksum(TEST_SQL);

function createHarness({ existingRow = false, existingChecksum = null, existingChecksumMissing = false } = {}) {
  const statements = [];
  const warnings = [];
  let released = false;

  const client = {
    async query(sql, params = []) {
      const statement = String(sql).trim();
      statements.push({ statement, params });

      if (statement.startsWith('SELECT pg_try_advisory_lock')) {
        return { rows: [{ locked: true }], rowCount: 1 };
      }
      if (statement.startsWith('SELECT version, checksum FROM schema_migrations')) {
        return existingRow
          ? { rows: [existingChecksumMissing
              ? { version: TEST_FILE.replace(/\.sql$/i, '') }
              : { version: TEST_FILE.replace(/\.sql$/i, ''), checksum: existingChecksum }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {
      released = true;
    }
  };

  const pool = { async connect() { return client; } };
  const fsApi = {
    readdirSync() { return [TEST_FILE]; },
    readFileSync() { return TEST_SQL; }
  };
  const logger = {
    log() {},
    warn(message) { warnings.push(message); },
    error() {}
  };

  return {
    runner: createMigrationRunner({
      pool,
      migrationsDir: '/virtual/migrations',
      fsApi,
      logger,
      approvedMigrationFiles: [TEST_FILE],
      approvedMigrationChecksums: { [TEST_FILE]: TEST_CHECKSUM }
    }),
    statements,
    warnings,
    wasReleased: () => released
  };
}

test('SHA-256 helper returns the standard digest', () => {
  assert.equal(
    getMigrationChecksum('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
  );
});

test('reviewed migration manifest covers every approved migration', () => {
  assert.deepEqual(Object.keys(APPROVED_MIGRATION_CHECKSUMS), [...APPROVED_MIGRATION_FILES]);
  for (const filename of APPROVED_MIGRATION_FILES) {
    assert.match(APPROVED_MIGRATION_CHECKSUMS[filename], /^[a-f0-9]{64}$/);
  }
});

test('approved source checksum rejects an edited migration file', () => {
  assert.throws(
    () => assertApprovedMigrationChecksum(TEST_FILE, TEST_SQL, { [TEST_FILE]: '0'.repeat(64) }),
    /checksum mismatch/i
  );
});

test('legacy ledger rows without checksums are visible and safely skipped', async () => {
  const harness = createHarness({ existingRow: true, existingChecksum: null });
  const result = await harness.runner.run();

  assert.deepEqual(result.applied, []);
  assert.deepEqual(result.skipped, [TEST_FILE.replace(/\.sql$/i, '')]);
  assert.deepEqual(result.legacyChecksumRows, [TEST_FILE.replace(/\.sql$/i, '')]);
  assert.equal(harness.warnings.length, 1);
  assert.match(harness.warnings[0], /no recorded database checksum/i);
  assert.equal(harness.wasReleased(), true);
});

test('a recorded database checksum mismatch stops the migration run', async () => {
  const harness = createHarness({
    existingRow: true,
    existingChecksum: 'f'.repeat(64)
  });

  await assert.rejects(harness.runner.run(), /valid checksum matching the reviewed SQL/i);
  assert.equal(harness.wasReleased(), true);
  assert.equal(
    harness.statements.some(({ statement }) => statement === 'COMMIT'),
    false
  );
});

test('an empty recorded checksum is rejected instead of treated as a legacy row', async () => {
  const harness = createHarness({
    existingRow: true,
    existingChecksum: ''
  });

  await assert.rejects(harness.runner.run(), /valid checksum matching the reviewed SQL/i);
  assert.deepEqual(harness.warnings, []);
  assert.equal(harness.wasReleased(), true);
  assert.equal(
    harness.statements.some(({ statement }) => statement === 'COMMIT'),
    false
  );
});


test('a recorded ledger row with a missing checksum field is rejected', async () => {
  const harness = createHarness({
    existingRow: true,
    existingChecksumMissing: true
  });

  await assert.rejects(harness.runner.run(), /valid checksum matching the reviewed SQL/i);
  assert.deepEqual(harness.warnings, []);
  assert.equal(harness.wasReleased(), true);
  assert.equal(
    harness.statements.some(({ statement }) => statement === 'COMMIT'),
    false
  );
});

test('new migrations persist their SHA-256 checksum in the ledger', async () => {
  const harness = createHarness();
  const result = await harness.runner.run();

  assert.deepEqual(result.applied, [TEST_FILE.replace(/\.sql$/i, '')]);
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(result.legacyChecksumRows, []);

  const insert = harness.statements.find(({ statement }) =>
    statement.startsWith('INSERT INTO schema_migrations')
  );
  assert.ok(insert);
  assert.equal(insert.params[2], TEST_CHECKSUM);
  assert.equal(harness.wasReleased(), true);
});
