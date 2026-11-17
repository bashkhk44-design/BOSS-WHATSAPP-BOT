'use strict';

const { createCustomerBot } = require('./customer-bot');

function createTelegramUpdateHandler({
  pool,
  decryptToken,
  botFactory,
  leaseSeconds = 120
}) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('PostgreSQL pool is required');
  if (typeof decryptToken !== 'function') throw new TypeError('decryptToken(record) is required');
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 10) throw new RangeError('leaseSeconds must be at least 10');

  // The webhook worker and existing polling runtime share exactly the same
  // command handlers, so moving transport does not change customer behavior.
  const makeBot = botFactory || createCustomerBot;

  return async function handleTelegramUpdate(job) {
    const botId = Number(job.payload?.botId);
    const updateId = Number(job.payload?.updateId);
    if (!Number.isSafeInteger(botId) || botId < 1 || !Number.isSafeInteger(updateId) || updateId < 0) {
      throw new Error('Invalid Telegram update job payload');
    }

    const claimed = await pool.query(`
      UPDATE bot_inbound_updates AS inbound
      SET state = 'processing',
          attempts = attempts + 1,
          locked_at = NOW(),
          last_error = NULL
      FROM telegram_bots AS bot
      WHERE inbound.bot_id = $1
        AND inbound.update_id = $2
        AND bot.id = inbound.bot_id
        AND (
          inbound.state IN ('queued', 'failed')
          OR (
            inbound.state = 'processing'
            AND inbound.locked_at < NOW() - make_interval(secs => $3::int)
          )
        )
      RETURNING inbound.payload, bot.id, bot.name,
                bot.token_ciphertext, bot.token_iv, bot.token_auth_tag
    `, [botId, updateId, leaseSeconds]);

    if (!claimed.rowCount) {
      const current = await pool.query(
        'SELECT state FROM bot_inbound_updates WHERE bot_id = $1 AND update_id = $2',
        [botId, updateId]
      );
      if (current.rows[0]?.state === 'processed') return { duplicate: true };
      throw new Error('Telegram update is already leased or no longer available');
    }

    const record = claimed.rows[0];
    try {
      const token = decryptToken(record);
      const bot = makeBot(record, token);
      await bot.handleUpdate(record.payload);

      const saved = await pool.query(`
        UPDATE bot_inbound_updates
        SET state = 'processed',
            processed_at = NOW(),
            locked_at = NULL,
            last_error = NULL
        WHERE bot_id = $1 AND update_id = $2 AND state = 'processing'
      `, [botId, updateId]);
      if (!saved.rowCount) throw new Error('Telegram update lease was lost before completion');
      return { processed: true, botId, updateId };
    } catch (error) {
      await pool.query(`
        UPDATE bot_inbound_updates
        SET state = 'failed',
            locked_at = NULL,
            last_error = LEFT($3, 4000)
        WHERE bot_id = $1 AND update_id = $2 AND state = 'processing'
      `, [botId, updateId, String(error.message || error)]);
      throw error;
    }
  };
}

module.exports = { createTelegramUpdateHandler };
