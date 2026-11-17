'use strict';

require('dotenv').config();

const { Pool } = require('pg');
const { deriveTelegramWebhookSecret } = require('./telegram-webhook-secret');
const { createTelegramWebhookServer } = require('./telegram-webhook-server');

function getWebhookSslConfig(env = process.env) {
  return env.DATABASE_SSL === 'disable' ? false : true;
}

function validateWebhookEnvironment(env = process.env) {
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  if (!env.DATABASE_URL.toLowerCase().startsWith('postgres://') &&
      !env.DATABASE_URL.toLowerCase().startsWith('postgresql://')) {
    throw new Error('DATABASE_URL must use the PostgreSQL protocol');
  }
  if (!/^[0-9a-fA-F]{64}$/.test(env.BOTS_ENCRYPTION_KEY || '')) {
    throw new Error('BOTS_ENCRYPTION_KEY must be a 32-byte hex key');
  }
  if (env.DATABASE_SSL !== undefined && !['require', 'disable'].includes(env.DATABASE_SSL)) {
    throw new Error('DATABASE_SSL must be either require or disable');
  }
  return true;
}

async function main() {
  validateWebhookEnvironment();

  const { decryptToken } = require('./db');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: getWebhookSslConfig(),
    max: Number(process.env.WEBHOOK_DB_POOL_MAX || 5),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
  });

  const encryptionKey = Buffer.from(process.env.BOTS_ENCRYPTION_KEY, 'hex');
  const server = createTelegramWebhookServer({
    pool,
    resolveSecret: async botId => {
      const result = await pool.query(
        'SELECT id, token_ciphertext, token_iv, token_auth_tag ' +
        'FROM telegram_bots WHERE id = $1 AND active = TRUE ' +
        'AND token_ciphertext IS NOT NULL LIMIT 1',
        [botId]
      );
      if (!result.rowCount) return null;
      const token = decryptToken(result.rows[0]);
      return deriveTelegramWebhookSecret(botId, token, encryptionKey);
    }
  });

  const port = Number(process.env.PORT || 8081);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', resolve);
  });
  console.log('BOSS Telegram webhook ingress listening on port ' + port);

  let closing = false;
  const shutdown = async signal => {
    if (closing) return;
    closing = true;
    console.log('Webhook ingress stopping: ' + signal);
    await new Promise(resolve => server.close(resolve));
    await pool.end();
  };
  process.once('SIGTERM', () => shutdown('SIGTERM').catch(error => {
    console.error('Webhook shutdown failed:', error.message);
    process.exitCode = 1;
  }));
  process.once('SIGINT', () => shutdown('SIGINT').catch(error => {
    console.error('Webhook shutdown failed:', error.message);
    process.exitCode = 1;
  }));
}

if (require.main === module) {
  main().catch(error => {
    console.error('WEBHOOK INGRESS STARTUP FAILED:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { main, validateWebhookEnvironment, getWebhookSslConfig };
