'use strict';

function createBotOwnershipService(pool) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
    throw new TypeError('A PostgreSQL pool is required');
  }

  async function listClients({ limit = 8, offset = 0 } = {}) {
    const safeLimit = Math.min(20, Math.max(1, Number(limit) || 8));
    const safeOffset = Math.max(0, Number(offset) || 0);
    const result = await pool.query(`
      SELECT id,
             COALESCE(NULLIF(first_name, ''), NULLIF(telegram_username, ''), telegram_user_id::text) AS display_name,
             telegram_username
      FROM clients
      ORDER BY id DESC
      LIMIT $1 OFFSET $2
    `, [safeLimit, safeOffset]);
    return result.rows;
  }

  async function listProjects({ clientId, limit = 8, offset = 0 } = {}) {
    if (!/^\d+$/.test(String(clientId || ''))) {
      throw new TypeError('A valid client ID is required');
    }
    const safeLimit = Math.min(20, Math.max(1, Number(limit) || 8));
    const safeOffset = Math.max(0, Number(offset) || 0);
    const result = await pool.query(`
      SELECT id, client_id, name, business_type, status
      FROM client_projects
      WHERE client_id = $1
      ORDER BY id DESC
      LIMIT $2 OFFSET $3
    `, [clientId, safeLimit, safeOffset]);
    return result.rows;
  }

  async function assignBotToProject({ botId, clientId, projectId } = {}) {
    for (const [name, value] of Object.entries({ botId, clientId, projectId })) {
      if (!/^\d+$/.test(String(value || '')) || Number(value) <= 0) {
        throw new TypeError('Invalid ' + name);
      }
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const bot = await client.query(
        'SELECT id FROM telegram_bots WHERE id = $1 FOR UPDATE',
        [botId]
      );
      if (!bot.rowCount) {
        const error = new Error('BOT_NOT_FOUND');
        error.code = 'BOT_NOT_FOUND';
        throw error;
      }

      const project = await client.query(
        'SELECT id FROM client_projects WHERE id = $1 AND client_id = $2',
        [projectId, clientId]
      );
      if (!project.rowCount) {
        const error = new Error('PROJECT_NOT_OWNED_BY_CLIENT');
        error.code = 'PROJECT_NOT_OWNED_BY_CLIENT';
        throw error;
      }

      const updated = await client.query(`
        UPDATE telegram_bots
        SET client_id = $2, project_id = $3
        WHERE id = $1
        RETURNING id, name, username, client_id, project_id
      `, [botId, clientId, projectId]);

      await client.query('COMMIT');
      return updated.rows[0];
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw error;
    } finally {
      client.release();
    }
  }

  return { listClients, listProjects, assignBotToProject };
}

module.exports = { createBotOwnershipService };
