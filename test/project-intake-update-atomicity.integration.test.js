'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

const databaseUrl = process.env.DATABASE_URL;

function loadProjectDb(pool) {
  const dbPath = require.resolve('../db');
  const projectPath = require.resolve('../project-db');
  const previousDb = require.cache[dbPath];
  const previousProject = require.cache[projectPath];
  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: { pool, encryptSecret() {}, decryptSecret() {} }
  };
  delete require.cache[projectPath];
  const projectDb = require('../project-db');
  return {
    projectDb,
    restore() {
      delete require.cache[projectPath];
      delete require.cache[dbPath];
      if (previousDb) require.cache[dbPath] = previousDb;
      if (previousProject) require.cache[projectPath] = previousProject;
    }
  };
}

test('concurrent duplicate intake updates commit one session transition and one message', {
  skip: !databaseUrl ? 'DATABASE_URL is required for the disposable PostgreSQL concurrency test' : false
}, async () => {
  const { Pool } = require('pg');
  const adminPool = new Pool({
    connectionString: databaseUrl,
    ssl: databaseUrl.includes('localhost') || databaseUrl.includes('127.0.0.1')
      ? false
      : { rejectUnauthorized: false },
    max: 3
  });
  const schema = 'intake_atomic_' + randomUUID().replace(/-/g, '');
  const tenantPool = new Pool({
    connectionString: databaseUrl,
    ssl: databaseUrl.includes('localhost') || databaseUrl.includes('127.0.0.1')
      ? false
      : { rejectUnauthorized: false },
    options: '-c search_path=' + schema,
    max: 4
  });
  const loaded = loadProjectDb(tenantPool);

  try {
    await adminPool.query('CREATE SCHEMA ' + schema);
    await tenantPool.query(`
      CREATE TABLE clients (
        id BIGSERIAL PRIMARY KEY,
        telegram_user_id TEXT NOT NULL UNIQUE
      );
      CREATE TABLE client_projects (
        id BIGSERIAL PRIMARY KEY,
        client_id BIGINT NOT NULL REFERENCES clients(id),
        name TEXT NOT NULL,
        business_type TEXT,
        status TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE client_intake_sessions (
        telegram_user_id TEXT PRIMARY KEY,
        project_id BIGINT NOT NULL REFERENCES client_projects(id),
        step TEXT NOT NULL,
        data JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE client_conversations (
        id BIGSERIAL PRIMARY KEY,
        project_id BIGINT NOT NULL REFERENCES client_projects(id),
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb
      );
      CREATE TABLE project_intake_update_receipts (
        bot_identity TEXT NOT NULL,
        update_id TEXT NOT NULL,
        telegram_user_id BIGINT NOT NULL,
        project_id BIGINT NOT NULL REFERENCES client_projects(id) ON DELETE CASCADE,
        processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (bot_identity, update_id)
      );
    `);
    const client = await tenantPool.query(
      'INSERT INTO clients (telegram_user_id) VALUES ($1) RETURNING id',
      ['123456789']
    );
    const project = await tenantPool.query(
      `INSERT INTO client_projects (client_id, name, status)
       VALUES ($1, 'Original', 'collecting_requirements') RETURNING id`,
      [client.rows[0].id]
    );
    const projectId = String(project.rows[0].id);
    const telegramUserId = '123456789';
    const updateId = Math.floor(Date.now() / 10);

    const results = await Promise.all([
      loaded.projectDb.persistIntakeUpdate({
        updateId, telegramUserId, projectId, step: 'review',
        data: { projectName: 'Version A' },
        projectName: 'Version A',
        messages: [{ role: 'client', content: 'first delivery' }]
      }),
      loaded.projectDb.persistIntakeUpdate({
        updateId, telegramUserId, projectId, step: 'review',
        data: { projectName: 'Version B' },
        projectName: 'Version B',
        messages: [{ role: 'client', content: 'duplicate delivery' }]
      })
    ]);

    assert.equal(results.filter(result => result.processed).length, 1);
    assert.equal(results.filter(result => result.duplicate).length, 1);

    const state = await tenantPool.query(
      `SELECT p.name, s.data
       FROM client_projects p
       JOIN client_intake_sessions s ON s.project_id = p.id
       WHERE p.id = $1`,
      [projectId]
    );
    const messages = await tenantPool.query(
      'SELECT content FROM client_conversations WHERE project_id = $1',
      [projectId]
    );
    const receipts = await tenantPool.query(
      'SELECT update_id FROM project_intake_update_receipts WHERE project_id = $1',
      [projectId]
    );

    assert.equal(state.rowCount, 1);
    assert.equal(state.rows[0].name, state.rows[0].data.projectName);
    assert.equal(messages.rowCount, 1);
    assert.equal(receipts.rowCount, 1);
  } finally {
    loaded.restore();
    await tenantPool.end();
    await adminPool.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');
    await adminPool.end();
  }
});
