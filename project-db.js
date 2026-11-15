const { pool } = require('./db');
const projectAiJobs = require('./project-ai-jobs');

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
    CREATE TABLE IF NOT EXISTS client_intake_sessions (
      telegram_user_id BIGINT PRIMARY KEY,
      project_id BIGINT NOT NULL REFERENCES client_projects(id) ON DELETE CASCADE,
      step TEXT NOT NULL,
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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

  await projectAiJobs.initProjectAiJobsDatabase();

  console.log('BOSS project database tables ready');
}

async function createClientProject({
  telegramUserId,
  telegramUsername = null,
  firstName = null,
  name,
  businessType = null
}) {
  if (!telegramUserId || !name?.trim()) {
    throw new Error('رقم العميل واسم المشروع مطلوبان');
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const savedClient = await client.query(`
      INSERT INTO clients
        (telegram_user_id, telegram_username, first_name)
      VALUES ($1, $2, $3)
      ON CONFLICT (telegram_user_id)
      DO UPDATE SET
        telegram_username = COALESCE(EXCLUDED.telegram_username, clients.telegram_username),
        first_name = COALESCE(EXCLUDED.first_name, clients.first_name)
      RETURNING id
    `, [String(telegramUserId), telegramUsername, firstName]);

    const project = await client.query(`
      INSERT INTO client_projects (client_id, name, business_type)
      VALUES ($1, $2, $3)
      RETURNING *
    `, [savedClient.rows[0].id, name.trim(), businessType]);

    await client.query('COMMIT');
    return project.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function addConversationMessage({
  telegramUserId,
  projectId,
  role,
  content,
  metadata = {}
}) {
  const result = await pool.query(`
    INSERT INTO client_conversations
      (project_id, role, content, metadata)
    SELECT p.id, $3, $4, $5::jsonb
    FROM client_projects p
    JOIN clients c ON c.id = p.client_id
    WHERE p.id = $1 AND c.telegram_user_id = $2
    RETURNING *
  `, [
    projectId,
    String(telegramUserId),
    role,
    content,
    JSON.stringify(metadata)
  ]);

  if (!result.rowCount) {
    throw new Error('المشروع غير موجود أو لا يخص هذا العميل');
  }

  return result.rows[0];
}

async function setProjectBusinessType({ telegramUserId, projectId, businessType }) {
  const result = await pool.query(`
    UPDATE client_projects p
    SET business_type = $3, updated_at = NOW()
    FROM clients c
    WHERE p.client_id = c.id
      AND p.id = $1
      AND c.telegram_user_id = $2
    RETURNING p.*
  `, [projectId, String(telegramUserId), businessType]);

  if (!result.rowCount) {
    throw new Error('المشروع غير موجود أو لا يخص هذا العميل');
  }

  return result.rows[0];
}

async function updateClientProjectStatus({ telegramUserId, projectId, status }) {
  const result = await pool.query(`
    UPDATE client_projects p
    SET status = $3, updated_at = NOW()
    FROM clients c
    WHERE p.client_id = c.id
      AND p.id = $1
      AND c.telegram_user_id = $2
    RETURNING p.*
  `, [projectId, String(telegramUserId), status]);

  if (!result.rowCount) {
    throw new Error('المشروع غير موجود أو لا يخص هذا العميل');
  }

  return result.rows[0];
}

async function getClientProjects(telegramUserId) {
  const result = await pool.query(`
    SELECT p.*
    FROM client_projects p
    JOIN clients c ON c.id = p.client_id
    WHERE c.telegram_user_id = $1
    ORDER BY p.created_at DESC
  `, [String(telegramUserId)]);

  return result.rows;
}

async function getProjectConversation(telegramUserId, projectId) {
  const result = await pool.query(`
    SELECT m.*
    FROM client_conversations m
    JOIN client_projects p ON p.id = m.project_id
    JOIN clients c ON c.id = p.client_id
    WHERE c.telegram_user_id = $1 AND p.id = $2
    ORDER BY m.created_at ASC
  `, [String(telegramUserId), projectId]);

  return result.rows;
}

async function saveProjectSpec({
  telegramUserId,
  projectId,
  spec,
  status = 'draft'
}) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const owned = await client.query(`
      SELECT p.id
      FROM client_projects p
      JOIN clients c ON c.id = p.client_id
      WHERE p.id = $1 AND c.telegram_user_id = $2
      FOR UPDATE OF p
    `, [projectId, String(telegramUserId)]);

    if (!owned.rowCount) {
      throw new Error('المشروع غير موجود أو لا يخص هذا العميل');
    }

    const result = await client.query(`
      INSERT INTO project_specs (project_id, version, spec, status)
      VALUES (
        $1,
        COALESCE((SELECT MAX(version) FROM project_specs WHERE project_id = $1), 0) + 1,
        $2::jsonb,
        $3
      )
      RETURNING *
    `, [projectId, JSON.stringify(spec), status]);

    await client.query('COMMIT');
    return result.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function logProjectEvent({
  telegramUserId,
  projectId,
  eventType,
  details = {}
}) {
  const result = await pool.query(`
    INSERT INTO project_events (project_id, event_type, details)
    SELECT p.id, $3, $4::jsonb
    FROM client_projects p
    JOIN clients c ON c.id = p.client_id
    WHERE p.id = $1 AND c.telegram_user_id = $2
    RETURNING *
  `, [
    projectId,
    String(telegramUserId),
    eventType,
    JSON.stringify(details)
  ]);

  if (!result.rowCount) {
    throw new Error('المشروع غير موجود أو لا يخص هذا العميل');
  }

  return result.rows[0];
}

async function getIntakeSession(telegramUserId) {
  const result = await pool.query(`
    SELECT project_id, step, data, updated_at
    FROM client_intake_sessions
    WHERE telegram_user_id = $1
  `, [String(telegramUserId)]);

  return result.rows[0] || null;
}

async function saveIntakeSession({
  telegramUserId,
  projectId,
  step,
  data = {}
}) {
  if (!telegramUserId || !projectId || !step) {
    throw new Error('بيانات جلسة العميل غير مكتملة');
  }

  const result = await pool.query(`
    INSERT INTO client_intake_sessions
      (telegram_user_id, project_id, step, data)
    VALUES ($1, $2, $3, $4::jsonb)
    ON CONFLICT (telegram_user_id)
    DO UPDATE SET
      project_id = EXCLUDED.project_id,
      step = EXCLUDED.step,
      data = EXCLUDED.data,
      updated_at = NOW()
    RETURNING *
  `, [
    String(telegramUserId),
    projectId,
    step,
    JSON.stringify(data)
  ]);

  return result.rows[0];
}

async function deleteIntakeSession(telegramUserId) {
  await pool.query(
    'DELETE FROM client_intake_sessions WHERE telegram_user_id = $1',
    [String(telegramUserId)]
  );
}

async function approveProjectSpec({
  telegramUserId,
  projectId,
  spec
}) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const owned = await client.query(`
      SELECT p.id
      FROM client_projects p
      JOIN clients c ON c.id = p.client_id
      WHERE p.id = $1 AND c.telegram_user_id = $2
      FOR UPDATE OF p
    `, [projectId, String(telegramUserId)]);

    if (!owned.rowCount) {
      throw new Error('المشروع غير موجود أو لا يخص هذا العميل');
    }

    const versionResult = await client.query(`
      SELECT COALESCE(MAX(version), 0) + 1 AS version
      FROM project_specs
      WHERE project_id = $1
    `, [projectId]);

    const version = Number(versionResult.rows[0].version);

    const saved = await client.query(`
      INSERT INTO project_specs
        (project_id, version, spec, status, approved_at)
      VALUES ($1, $2, $3::jsonb, 'approved', NOW())
      RETURNING *
    `, [projectId, version, JSON.stringify(spec)]);

    await client.query(`
      UPDATE client_projects
      SET status = 'spec_approved', updated_at = NOW()
      WHERE id = $1
    `, [projectId]);

    await client.query(`
      INSERT INTO project_events (project_id, event_type, details)
      VALUES ($1, 'spec_approved', $2::jsonb)
    `, [projectId, JSON.stringify({ version })]);

    await client.query(`
      DELETE FROM client_intake_sessions
      WHERE telegram_user_id = $1 AND project_id = $2
    `, [String(telegramUserId), projectId]);

    await client.query('COMMIT');
    return saved.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}


module.exports = {
  initProjectDatabase,
  createClientProject,
  setProjectBusinessType,
  updateClientProjectStatus,
  addConversationMessage,
  getClientProjects,
  getProjectConversation,
  saveProjectSpec,
  logProjectEvent,
  getIntakeSession,
  saveIntakeSession,
  deleteIntakeSession,
  approveProjectSpec,
  ...projectAiJobs
};
