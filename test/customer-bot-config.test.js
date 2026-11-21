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
  const release = {
    id: '41',
    project_id: '12',
    release_version: 3,
    spec_version: 1,
    authorized_by: '99',
    artifact,
    artifact_sha256: sha256(stableJson(artifact))
  };
  release.authorization_sha256 = sha256(stableJson({
    releaseId: release.id,
    projectId: release.project_id,
    releaseVersion: release.release_version,
    specVersion: release.spec_version,
    artifactSha256: release.artifact_sha256,
    authorizedBy: release.authorized_by
  }));
  return release;
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

test('validates safe inline buttons and callback responses', () => {
  const input = validConfig();
  input.commands[0].buttons = [{
    text: 'View details',
    callbackData: 'catalog_details',
    responseText: 'These are the details.'
  }];
  const result = validateCustomerBotConfig(input);
  assert.deepEqual(result.commands[0].buttons, input.commands[0].buttons);
});

test('rejects duplicate or unsafe callback data and oversized button labels', () => {
  const duplicate = validConfig();
  duplicate.commands[0].buttons = [
    { text: 'One', callbackData: 'same', responseText: 'First' },
    { text: 'Two', callbackData: 'same', responseText: 'Second' }
  ];
  assert.throws(() => validateCustomerBotConfig(duplicate), /Duplicate Telegram callback data/);

  const unsafe = validConfig();
  unsafe.commands[0].buttons = [
    { text: 'Run', callbackData: 'run\\nrequire', responseText: 'No' }
  ];
  assert.throws(() => validateCustomerBotConfig(unsafe), /safe ASCII characters/);

  const oversized = validConfig();
  oversized.commands[0].buttons = [
    { text: 'x'.repeat(65), callbackData: 'long_label', responseText: 'No' }
  ];
  assert.throws(() => validateCustomerBotConfig(oversized), /64 UTF-8 bytes/);
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
  assert.match(query.sql, /a\.authorization_sha256/);
  assert.match(query.sql, /p\.client_id = \$2/);
});

test('fails closed when deployment authorization digest is invalid', async () => {
  const release = makeRelease();
  release.authorization_sha256 = '0'.repeat(64);
  await assert.rejects(
    loadApprovedCustomerBotConfig({
      pool: { async query() { return { rowCount: 1, rows: [release] }; } },
      record: { client_id: 8, project_id: 12 }
    }),
    /deployment authorization failed its integrity check/
  );
});

test('fails closed when an intact release artifact identifies another project', async () => {
  const release = makeRelease();
  release.artifact.report.project.id = '13';
  release.artifact_sha256 = sha256(stableJson(release.artifact));
  release.authorization_sha256 = sha256(stableJson({
    releaseId: release.id,
    projectId: release.project_id,
    releaseVersion: release.release_version,
    specVersion: release.spec_version,
    artifactSha256: release.artifact_sha256,
    authorizedBy: release.authorized_by
  }));
  await assert.rejects(
    loadApprovedCustomerBotConfig({
      pool: { async query() { return { rowCount: 1, rows: [release] }; } },
      record: { client_id: 8, project_id: 12 }
    }),
    /belongs to a different project/
  );
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

test('fails closed when a bot has only half of its project ownership assignment', async () => {
  await assert.rejects(
    loadApprovedCustomerBotConfig({
      pool: { async query() { throw new Error('query should not run'); } },
      record: { client_id: 8, project_id: null }
    }),
    /project assignment is incomplete or invalid/
  );
  await assert.rejects(
    loadApprovedCustomerBotConfig({
      pool: { async query() { throw new Error('query should not run'); } },
      record: { client_id: null, project_id: 12 }
    }),
    /project assignment is incomplete or invalid/
  );
});

test('does not load a release for a bot that is not assigned to a customer project', async () => {
  const config = await loadApprovedCustomerBotConfig({
    pool: { async query() { throw new Error('query should not run'); } },
    record: { id: 5, client_id: null, project_id: null }
  });
  assert.equal(config, null);
});
