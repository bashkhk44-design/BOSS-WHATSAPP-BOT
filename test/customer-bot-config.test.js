'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validateCustomerBotConfig,
  loadApprovedCustomerBotConfig,
  stableJson,
  sha256
} = require('../customer-bot-config');

function validConfig() {
  return {
    schemaVersion: 1,
    welcomeText: 'Welcome to the shop',
    helpText: 'Use /catalog to view items',
    commands: [{ command: 'catalog', description: 'View catalog', text: 'Our catalog is being updated.' }]
  };
}

function makeRelease(config = validConfig()) {
  const artifact = {
    schemaVersion: 1,
    report: { project: { id: '12' } },
    bundle: {
      files: [{ path: 'boss-telegram.json', content: JSON.stringify(config) }]
    }
  };
  return {
    id: '41',
    release_version: 3,
    artifact,
    artifact_sha256: sha256(stableJson(artifact))
  };
}

test('validates a safe declarative Telegram command configuration', () => {
  const result = validateCustomerBotConfig(validConfig());
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.commands[0].command, 'catalog');
});

test('rejects executable or unknown configuration fields', () => {
  assert.throws(() => validateCustomerBotConfig({
    ...validConfig(),
    script: 'require("fs")'
  }), /Unsupported Telegram runtime config field/);
});

test('rejects duplicate and reserved Telegram commands', () => {
  assert.throws(() => validateCustomerBotConfig({
    ...validConfig(),
    commands: [
      { command: 'start', description: 'Start', text: 'No' }
    ]
  }), /reserved Telegram command/);
});

test('loads only a digest-verified approved release with manager authorization', async () => {
  const release = makeRelease();
  let query;
  const config = await loadApprovedCustomerBotConfig({
    pool: { async query(sql, params) { query = { sql, params }; return { rowCount: 1, rows: [release] }; } },
    record: { id: 5, client_id: 8, project_id: 12 }
  });

  assert.equal(config.releaseId, '41');
  assert.equal(config.releaseVersion, 3);
  assert.equal(config.commands[0].command, 'catalog');
  assert.deepEqual(query.params, [12, 8]);
  assert.match(query.sql, /r\.status = 'approved'/);
  assert.match(query.sql, /a\.status = 'authorized'/);
  assert.match(query.sql, /p\.client_id = \$2/);
});

test('fails closed when no authorized approved release exists', async () => {
  await assert.rejects(
    loadApprovedCustomerBotConfig({
      pool: { async query() { return { rowCount: 0, rows: [] }; } },
      record: { client_id: 8, project_id: 12 }
    }),
    /No approved and manager-authorized release/
  );
});

test('fails closed when stored release artifact digest does not match', async () => {
  const release = makeRelease();
  release.artifact_sha256 = '0'.repeat(64);
  await assert.rejects(
    loadApprovedCustomerBotConfig({
      pool: { async query() { return { rowCount: 1, rows: [release] }; } },
      record: { client_id: 8, project_id: 12 }
    }),
    /integrity check/
  );
});

test('does not load a release for a bot that is not assigned to a customer project', async () => {
  const config = await loadApprovedCustomerBotConfig({
    pool: { async query() { throw new Error('query should not run'); } },
    record: { id: 5, client_id: null, project_id: null }
  });
  assert.equal(config, null);
});
