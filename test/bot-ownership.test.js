'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createBotOwnershipService } = require('../bot-ownership');

function makePool({ botExists = true, projectBelongsToClient = true } = {}) {
  const calls = [];
  let committed = false;
  let rolledBack = false;
  const client = {
    async query(sql, params = []) {
      const normalized = sql.trim().replace(/\\s+/g, ' ');
      calls.push({ sql: normalized, params });
      if (normalized === 'BEGIN') return { rows: [], rowCount: null };
      if (normalized === 'COMMIT') {
        committed = true;
        return { rows: [], rowCount: null };
      }
      if (normalized === 'ROLLBACK') {
        rolledBack = true;
        return { rows: [], rowCount: null };
      }
      if (normalized.startsWith('SELECT id FROM telegram_bots')) {
        return { rows: botExists ? [{ id: 10 }] : [], rowCount: botExists ? 1 : 0 };
      }
      if (normalized.startsWith('SELECT id FROM client_projects')) {
        return {
          rows: projectBelongsToClient ? [{ id: 30 }] : [],
          rowCount: projectBelongsToClient ? 1 : 0
        };
      }
      if (normalized.startsWith('UPDATE telegram_bots')) {
        return {
          rows: [{ id: 10, name: 'Trial bot', username: 'trial_bot', client_id: 20, project_id: 30 }],
          rowCount: 1
        };
      }
      throw new Error('Unexpected SQL: ' + normalized);
    },
    release() { calls.push({ sql: 'RELEASE', params: [] }); }
  };
  return {
    calls,
    get committed() { return committed; },
    get rolledBack() { return rolledBack; },
    async query() { throw new Error('Unexpected pool.query'); },
    async connect() { return client; }
  };
}

test('assigns a bot to a project owned by the selected client in one transaction', async () => {
  const pool = makePool();
  const service = createBotOwnershipService(pool);
  const result = await service.assignBotToProject({ botId: 10, clientId: 20, projectId: 30 });

  assert.equal(result.client_id, 20);
  assert.equal(result.project_id, 30);
  assert.equal(pool.committed, true);
  assert.equal(pool.rolledBack, false);
  assert.ok(pool.calls.some(call => call.sql.startsWith('SELECT id FROM client_projects WHERE id = $1 AND client_id = $2')));
});

test('rejects a project that belongs to another client and rolls back', async () => {
  const pool = makePool({ projectBelongsToClient: false });
  const service = createBotOwnershipService(pool);

  await assert.rejects(
    service.assignBotToProject({ botId: 10, clientId: 20, projectId: 99 }),
    error => error.code === 'PROJECT_NOT_OWNED_BY_CLIENT'
  );
  assert.equal(pool.committed, false);
  assert.equal(pool.rolledBack, true);
  assert.equal(pool.calls.some(call => call.sql.startsWith('UPDATE telegram_bots')), false);
});

test('rejects a missing bot and rolls back', async () => {
  const pool = makePool({ botExists: false });
  const service = createBotOwnershipService(pool);

  await assert.rejects(
    service.assignBotToProject({ botId: 404, clientId: 20, projectId: 30 }),
    error => error.code === 'BOT_NOT_FOUND'
  );
  assert.equal(pool.committed, false);
  assert.equal(pool.rolledBack, true);
});

test('rejects malformed identifiers before opening a transaction', async () => {
  const pool = makePool();
  const service = createBotOwnershipService(pool);

  await assert.rejects(
    service.assignBotToProject({ botId: 0, clientId: 20, projectId: 30 }),
    TypeError
  );
  assert.equal(pool.calls.length, 0);
});
