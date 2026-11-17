'use strict';

const { randomUUID } = require('node:crypto');

const DEFAULT_CAPACITY = 25;
const DEFAULT_LEASE_SECONDS = 90;

async function claimNextBot(pool, workerId, leaseSeconds = DEFAULT_LEASE_SECONDS) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const candidate = await client.query(`
      SELECT b.id
      FROM telegram_bots b
      LEFT JOIN bot_runtime_status s ON s.bot_id = b.id
      WHERE b.active = TRUE
        AND b.token_ciphertext IS NOT NULL
        AND (
          s.bot_id IS NULL
          OR s.status IN ('unknown', 'stopped', 'error')
          OR s.last_heartbeat_at IS NULL
          OR s.last_heartbeat_at < NOW() - ($1::int * INTERVAL '1 second')
        )
      ORDER BY b.id ASC
      FOR UPDATE OF b SKIP LOCKED
      LIMIT 1
    `, [leaseSeconds]);
    if (!candidate.rowCount) {
      await client.query('COMMIT');
      return null;
    }
    const botId = String(candidate.rows[0].id);
    await client.query(`
      INSERT INTO bot_runtime_status
        (bot_id, status, worker_id, last_heartbeat_at, updated_at)
      VALUES ($1, 'starting', $2, NOW(), NOW())
      ON CONFLICT (bot_id) DO UPDATE SET
        status = 'starting',
        worker_id = EXCLUDED.worker_id,
        last_heartbeat_at = NOW(),
        last_error_code = NULL,
        last_error_message = NULL,
        updated_at = NOW()
    `, [botId, workerId]);
    await client.query('COMMIT');
    return botId;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
}

function createCustomerBotWorker({
  pool,
  runtime,
  workerId = randomUUID(),
  capacity = DEFAULT_CAPACITY,
  leaseSeconds = DEFAULT_LEASE_SECONDS,
  pollIntervalMs = 3000,
  logger = console
}) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('PostgreSQL pool is required');
  if (!runtime || typeof runtime.startBotById !== 'function') throw new TypeError('Bot runtime is required');
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 100) throw new RangeError('capacity must be between 1 and 100');
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 30) throw new RangeError('leaseSeconds must be at least 30 seconds');
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 500) throw new RangeError('pollIntervalMs must be at least 500ms');

  let stopping = false;
  let loopPromise = null;

  async function runOnce() {
    const snapshot = runtime.getRuntimeSnapshot();
    const owned = snapshot.filter(item => item.status !== 'stopped' && item.status !== 'error' && item.status !== 'conflict' && item.status !== 'unauthorized').length;
    if (owned >= capacity) return false;

    const botId = await claimNextBot(pool, workerId, leaseSeconds);
    if (!botId) return false;
    try {
      await runtime.startBotById(botId);
      logger.log('Customer bot assigned to worker ' + workerId + ': ' + botId);
      return true;
    } catch (error) {
      await pool.query(`
        UPDATE bot_runtime_status
        SET status = 'error', worker_id = $2,
            last_error_code = 'WORKER_START_FAILED',
            last_error_message = $3,
            last_heartbeat_at = NOW(), updated_at = NOW()
        WHERE bot_id = $1 AND worker_id = $2
      `, [botId, workerId, String(error.message || error).slice(0, 1000)]);
      logger.error('Could not start customer bot ' + botId + ': ' + error.message);
      return true;
    }
  }

  async function run() {
    while (!stopping) {
      try {
        const didWork = await runOnce();
        if (!didWork && !stopping) await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
      } catch (error) {
        logger.error('Customer bot worker loop error:', error.message);
        if (!stopping) await new Promise(resolve => setTimeout(resolve, Math.max(pollIntervalMs, 5000)));
      }
    }
  }

  return {
    workerId,
    runOnce,
    start() {
      if (loopPromise) return loopPromise;
      stopping = false;
      loopPromise = run().finally(() => { loopPromise = null; });
      return loopPromise;
    },
    async stop() {
      stopping = true;
      if (loopPromise) {
        // Wake a sleeping poll loop; its bounded delay is at most 5 seconds.
        await loopPromise;
      }
      await runtime.stopBotRuntime();
    }
  };
}

async function main() {
  if (process.env.CUSTOMER_BOT_WORKER_ENABLED !== 'YES') {
    throw new Error('Set CUSTOMER_BOT_WORKER_ENABLED=YES only on a dedicated test/worker service');
  }
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const { Pool } = require('pg');
  const { decryptToken } = require('./db');
  const { createCustomerBot } = require('./customer-bot');
  const { createBotRuntime } = require('./bot-runtime');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'disable' ? false : { rejectUnauthorized: false },
    max: Number(process.env.WORKER_DB_POOL_MAX || 3),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
  });
  const workerId = process.env.CUSTOMER_BOT_WORKER_ID || randomUUID();
  const runtime = createBotRuntime({
    pool,
    decryptToken,
    createCustomerBot,
    workerId,
    maxBots: Number(process.env.CUSTOMER_BOT_WORKER_CAPACITY || DEFAULT_CAPACITY)
  });
  const worker = createCustomerBotWorker({
    pool,
    runtime,
    workerId,
    capacity: Number(process.env.CUSTOMER_BOT_WORKER_CAPACITY || DEFAULT_CAPACITY),
    leaseSeconds: Number(process.env.CUSTOMER_BOT_LEASE_SECONDS || DEFAULT_LEASE_SECONDS),
    pollIntervalMs: Number(process.env.CUSTOMER_BOT_WORKER_POLL_MS || 3000)
  });
  let stopping = false;
  const shutdown = async signal => {
    if (stopping) return;
    stopping = true;
    console.log('Customer bot worker stopping:', signal);
    try { await worker.stop(); } finally { await pool.end(); }
  };
  process.once('SIGTERM', () => shutdown('SIGTERM').catch(error => {
    console.error('Worker shutdown error:', error.message);
    process.exitCode = 1;
  }));
  process.once('SIGINT', () => shutdown('SIGINT').catch(error => {
    console.error('Worker shutdown error:', error.message);
    process.exitCode = 1;
  }));
  console.log('Customer bot worker started:', workerId, 'capacity:', worker.capacity || process.env.CUSTOMER_BOT_WORKER_CAPACITY || DEFAULT_CAPACITY);
  await worker.start();
}

if (require.main === module) {
  main().catch(error => {
    console.error('CUSTOMER BOT WORKER STARTUP FAILED:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { claimNextBot, createCustomerBotWorker, main };
