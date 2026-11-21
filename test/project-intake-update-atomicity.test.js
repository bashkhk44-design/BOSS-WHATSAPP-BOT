'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

function loadProjectDb(handler) {
  const dbPath = require.resolve('../db');
  const projectPath = require.resolve('../project-db');
  const previousDb = require.cache[dbPath];
  const previousProject = require.cache[projectPath];
  const queries = [];
  const client = {
    async query(sql, params) {
      queries.push({ sql: String(sql), params });
      return handler(String(sql), params, queries.length);
    },
    release() {}
  };
  const pool = { async connect() { return client; } };
  require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true,
    exports: { pool, encryptSecret() {}, decryptSecret() {} }
  };
  delete require.cache[projectPath];
  const projectDb = require('../project-db');
  return {
    projectDb, queries,
    restore() {
      delete require.cache[projectPath];
      delete require.cache[dbPath];
      if (previousDb) require.cache[dbPath] = previousDb;
      if (previousProject) require.cache[projectPath] = previousProject;
    }
  };
}

test('intake update commits receipt, session and conversation messages in one transaction', async () => {
  const loaded = loadProjectDb(async (sql) => {
    if (sql === 'BEGIN' || sql === 'COMMIT') return { rowCount: 0, rows: [] };
    if (sql.includes('SELECT p.id')) return { rowCount: 1, rows: [{ id: '55' }] };
    if (sql.includes('INSERT INTO project_intake_update_receipts')) return { rowCount: 1, rows: [{ update_id: '900' }] };
    if (sql.includes('INSERT INTO client_intake_sessions')) return { rowCount: 1, rows: [] };
    if (sql.includes('INSERT INTO client_conversations')) return { rowCount: 1, rows: [] };
    assert.fail('unexpected SQL: ' + sql);
  });
  try {
    const result = await loaded.projectDb.persistIntakeUpdate({
      updateId: 900, telegramUserId: '123', projectId: '55',
      step: 'features', data: { answer: 'catalog' },
      messages: [{ role: 'client', content: 'I need a catalog' }, { role: 'assistant', content: 'What features?' }]
    });
    assert.deepEqual(result, { processed: true, duplicate: false });
    const sql = loaded.queries.map(q => q.sql);
    assert.equal(sql[0], 'BEGIN');
    assert.ok(sql.some(q => q.includes('INSERT INTO project_intake_update_receipts')));
    assert.ok(sql.some(q => q.includes('INSERT INTO client_intake_sessions')));
    assert.equal(sql.filter(q => q.includes('INSERT INTO client_conversations')).length, 2);
    assert.equal(sql.at(-1), 'COMMIT');
  } finally {
    loaded.restore();
  }
});

test('duplicate Telegram update is ignored without changing session or messages', async () => {
  const loaded = loadProjectDb(async (sql) => {
    if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rowCount: 0, rows: [] };
    if (sql.includes('SELECT p.id')) return { rowCount: 1, rows: [{ id: '55' }] };
    if (sql.includes('INSERT INTO project_intake_update_receipts')) return { rowCount: 0, rows: [] };
    assert.fail('duplicate update must not write session or messages: ' + sql);
  });
  try {
    const result = await loaded.projectDb.persistIntakeUpdate({
      updateId: 900, telegramUserId: '123', projectId: '55',
      step: 'features', data: { answer: 'duplicate' },
      messages: [{ role: 'client', content: 'duplicate' }]
    });
    assert.deepEqual(result, { processed: false, duplicate: true });
    assert.equal(loaded.queries.at(-1).sql, 'ROLLBACK');
  } finally {
    loaded.restore();
  }
});

test('intake update rolls back receipt and session when conversation persistence fails', async () => {
  const loaded = loadProjectDb(async (sql) => {
    if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rowCount: 0, rows: [] };
    if (sql.includes('SELECT p.id')) return { rowCount: 1, rows: [{ id: '55' }] };
    if (sql.includes('INSERT INTO project_intake_update_receipts')) return { rowCount: 1, rows: [{ update_id: '900' }] };
    if (sql.includes('INSERT INTO client_intake_sessions')) return { rowCount: 1, rows: [] };
    if (sql.includes('INSERT INTO client_conversations')) throw new Error('simulated database interruption');
    assert.fail('unexpected SQL: ' + sql);
  });
  try {
    await assert.rejects(loaded.projectDb.persistIntakeUpdate({
      updateId: 900, telegramUserId: '123', projectId: '55',
      step: 'features', data: { answer: 'catalog' },
      messages: [{ role: 'client', content: 'catalog' }]
    }), /simulated database interruption/);
    assert.equal(loaded.queries.at(-1).sql, 'ROLLBACK');
  } finally {
    loaded.restore();
  }
});

test('intake update refuses project IDs not owned by the Telegram user', async () => {
  const loaded = loadProjectDb(async (sql) => {
    if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rowCount: 0, rows: [] };
    if (sql.includes('SELECT p.id')) return { rowCount: 0, rows: [] };
    assert.fail('ownership failure must stop all writes: ' + sql);
  });
  try {
    await assert.rejects(loaded.projectDb.persistIntakeUpdate({
      updateId: 901, telegramUserId: '123', projectId: '55',
      step: 'features', data: {}, messages: []
    }), /لا يخص هذا العميل/);
    assert.equal(loaded.queries.at(-1).sql, 'ROLLBACK');
  } finally {
    loaded.restore();
  }
});

test('project name and business type changes share the intake transaction and receipt', async () => {
  const loaded = loadProjectDb(async (sql) => {
    if (sql === 'BEGIN' || sql === 'COMMIT') return { rowCount: 0, rows: [] };
    if (sql.includes('SELECT p.id')) return { rowCount: 1, rows: [{ id: '55' }] };
    if (sql.includes('INSERT INTO project_intake_update_receipts')) return { rowCount: 1, rows: [{ update_id: '902' }] };
    if (sql.includes('UPDATE client_projects')) return { rowCount: 1, rows: [{ id: '55' }] };
    if (sql.includes('INSERT INTO client_intake_sessions')) return { rowCount: 1, rows: [] };
    if (sql.includes('INSERT INTO client_conversations')) return { rowCount: 1, rows: [] };
    assert.fail('unexpected SQL: ' + sql);
  });
  try {
    const result = await loaded.projectDb.persistIntakeUpdate({
      updateId: 902, telegramUserId: '123', projectId: '55',
      step: 'review', data: { projectName: 'New name', businessType: 'store' },
      projectName: 'New name', businessType: 'store',
      messages: [{ role: 'client', content: 'Updated business details' }]
    });
    assert.deepEqual(result, { processed: true, duplicate: false });
    const sql = loaded.queries.map(q => q.sql);
    const receiptAt = sql.findIndex(q => q.includes('INSERT INTO project_intake_update_receipts'));
    const projectAt = sql.findIndex(q => q.includes('UPDATE client_projects'));
    const sessionAt = sql.findIndex(q => q.includes('INSERT INTO client_intake_sessions'));
    const messageAt = sql.findIndex(q => q.includes('INSERT INTO client_conversations'));
    assert.ok(receiptAt > 0 && projectAt > receiptAt && sessionAt > projectAt && messageAt > sessionAt);
    assert.equal(sql.at(-1), 'COMMIT');
  } finally {
    loaded.restore();
  }
});
