const { pool } = require('./db');

async function initProjectDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS clients (
      id BIGSERIAL PRIMARY KEY,
      telegram_user_id BIGINT NOT NULL UNIQUE,
      telegram_username TEXT,
      first_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS client_projects (
      id BIGSERIAL PRIMARY KEY,
      client_id BIGINT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      business_type TEXT,
      status TEXT NOT NULL DEFAULT 'collecting_requirements',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS client_conversations (
      id BIGSERIAL PRIMARY KEY,
      project_id BIGINT NOT NULL REFERENCES client_projects(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('client', 'assistant', 'admin', 'system')),
      content TEXT NOT NULL,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS project_specs (
      id BIGSERIAL PRIMARY KEY,
      project_id BIGINT NOT NULL REFERENCES client_projects(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      spec JSONB NOT NULL DEFAULT '{}'::jsonb,
      status TEXT NOT NULL DEFAULT 'draft',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      approved_at TIMESTAMPTZ,
      UNIQUE (project_id, version)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS project_events (
      id BIGSERIAL PRIMARY KEY,
      project_id BIGINT NOT NULL REFERENCES client_projects(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      details JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS client_projects_client_idx
    ON client_projects(client_id, created_at DESC)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS client_conversations_project_idx
    ON client_conversations(project_id, created_at)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS project_events_project_idx
    ON project_events(project_id, created_at DESC)
  `);

  console.log('BOSS project database tables ready');
}

module.exports = { initProjectDatabase };
