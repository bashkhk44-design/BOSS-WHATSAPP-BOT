'use strict';

function createCustomerWebhookUpdateHandler({ pool, decryptToken, createCustomerBot, logger = console }) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('PostgreSQL pool is required');
  if (typeof decryptToken !== 'function') throw new TypeError('decryptToken is required');
  if (typeof createCustomerBot !== 'function') throw new TypeError('createCustomerBot is required');

  const handleCustomerUpdate = async function handleCustomerUpdate(job, { leaseSeconds = 120 } = {}) {
    const botId = Number(job?.bot_id);
    const updateId = Number(job?.payload?.updateId);
    if (!Number.isSafeInteger(botId) || botId < 1 ||
        !Number.isSafeInteger(updateId) || updateId < 0 ||
        Number(job?.payload?.botId) !== botId) {
      throw new Error('Customer Telegram job identity is invalid');
    }
    if (!Number.isInteger(leaseSeconds) || leaseSeconds < 10) {
      throw new RangeError('A valid customer update lease is required');
    }

    const result = await pool.query(`
      SELECT u.id AS inbox_id, u.payload, b.id, b.name, b.username,
             b.token_ciphertext, b.token_iv, b.token_auth_tag
      FROM bot_inbound_updates u
      JOIN telegram_bots b ON b.id = u.bot_id
      WHERE u.bot_id = $1 AND u.update_id = $2
        AND b.active = TRUE AND b.transport_mode = 'webhook'
      LIMIT 1
    `, [botId, updateId]);
    if (!result.rowCount) throw new Error('Customer update or active bot was not found');

    const row = result.rows[0];
    const update = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
    if (!update || Number(update.update_id) !== updateId) {
      throw new Error('Stored Telegram update does not match its queue job');
    }

    // Atomically acquire the inbox row. This prevents concurrent/retried queue
    // deliveries from invoking the same update while its lease is still valid.
    const claimed = await pool.query(`
      UPDATE bot_inbound_updates
      SET state = 'processing', attempts = attempts + 1,
          locked_at = NOW(), last_error = NULL
      WHERE id = $1
        AND (
          state IN ('queued','failed')
          OR (state = 'processing' AND
              (locked_at IS NULL OR locked_at < NOW() - make_interval(secs => $2::int)))
        )
      RETURNING id
    `, [row.inbox_id, leaseSeconds]);

    if (!claimed.rowCount) {
      const current = await pool.query(
        'SELECT state FROM bot_inbound_updates WHERE id = $1',
        [row.inbox_id]
      );
      if (current.rows[0]?.state === 'processed') {
        return { botId, updateId, processed: true, duplicate: true };
      }
      throw new Error('Customer update is already being processed or is unavailable');
    }

    try {
      const token = decryptToken(row);
      const bot = createCustomerBot(row, token, { propagateErrors: true });
      if (!bot || typeof bot.handleUpdate !== 'function') {
        throw new Error('Customer bot adapter does not expose handleUpdate');
      }
      await bot.handleUpdate(update);
      await pool.query(`
        UPDATE bot_inbound_updates
        SET state = 'processed', processed_at = NOW(), locked_at = NULL, last_error = NULL
        WHERE id = $1 AND state = 'processing'
      `, [row.inbox_id]);
      return { botId, updateId, processed: true };
    } catch (error) {
      await pool.query(`
        UPDATE bot_inbound_updates
        SET state = 'failed', locked_at = NULL, last_error = LEFT($2, 4000)
        WHERE id = $1 AND state = 'processing'
      `, [row.inbox_id, String(error?.message || error)]);
      logger.error('CUSTOMER UPDATE FAILED bot=' + botId + ' update=' + updateId + ': ' + (error?.message || error));
      throw error;
    }
  };

  // Keep the inbox lease alive alongside the platform_jobs lease. Without this,
  // a long Telegram update could be reclaimed by another worker while still running.
  handleCustomerUpdate.renewLease = async function renewInboxLease(job) {
    const botId = Number(job?.bot_id);
    const updateId = Number(job?.payload?.updateId);
    if (!Number.isSafeInteger(botId) || botId < 1 ||
        !Number.isSafeInteger(updateId) || updateId < 0 ||
        Number(job?.payload?.botId) !== botId) return false;
    const renewed = await pool.query(`
      UPDATE bot_inbound_updates
      SET locked_at = NOW()
      WHERE bot_id = $1 AND update_id = $2 AND state = 'processing'
      RETURNING id
    `, [botId, updateId]);
    return renewed.rowCount > 0;
  };

  return handleCustomerUpdate;
}

module.exports = { createCustomerWebhookUpdateHandler };
