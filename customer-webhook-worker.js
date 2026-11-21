'use strict';

require('dotenv').config();

const { createQueueWorker } = require('./queue-worker');
const { createCustomerWebhookUpdateHandler } = require('./customer-webhook-update-handler');

function createCustomerWebhookWorker({ pool, decryptToken, createCustomerBot, pollIntervalMs = 500, leaseSeconds = 120, workerId, logger = console, queueApi }) {
  const handler = createCustomerWebhookUpdateHandler({ pool, decryptToken, createCustomerBot, logger });
  const options = {
    pool,
    handlers: { 'telegram.update': handler },
    pollIntervalMs,
    leaseSeconds,
    logger
  };
  if (workerId) options.workerId = workerId;
  if (queueApi) options.queueApi = queueApi;
  return createQueueWorker(options);
}

async function main() {
  if (process.env.CUSTOMER_WEBHOOK_WORKER_ENABLED !== 'YES') {
    throw new Error('Set CUSTOMER_WEBHOOK_WORKER_ENABLED=YES only on a dedicated staging/worker service');
  }
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const { Pool } = require('pg');
  const { getPostgresSslConfig } = require('./postgres-ssl');
  const { decryptToken } = require('./db');
  const { createCustomerBot } = require('./customer-bot');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: getPostgresSslConfig(),
    max: Number(process.env.CUSTOMER_WEBHOOK_DB_POOL_MAX || 3),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
  });
  const worker = createCustomerWebhookWorker({
    pool, decryptToken, createCustomerBot,
    pollIntervalMs: Number(process.env.CUSTOMER_WEBHOOK_POLL_MS || 500),
    leaseSeconds: Number(process.env.CUSTOMER_WEBHOOK_LEASE_SECONDS || 120),
    workerId: process.env.CUSTOMER_WEBHOOK_WORKER_ID
  });
  let stopping = false;
  const shutdown = async signal => {
    if (stopping) return;
    stopping = true;
    console.log('Customer webhook worker stopping:', signal);
    try { await worker.stop(); } finally { await pool.end(); }
  };
  process.once('SIGTERM', () => shutdown('SIGTERM').catch(error => {
    console.error('Customer webhook worker shutdown failed:', error.message);
    process.exitCode = 1;
  }));
  process.once('SIGINT', () => shutdown('SIGINT').catch(error => {
    console.error('Customer webhook worker shutdown failed:', error.message);
    process.exitCode = 1;
  }));
  console.log('Customer webhook worker started:', worker.workerId);
  await worker.start();
}

if (require.main === module) {
  main().catch(error => {
    console.error('CUSTOMER WEBHOOK WORKER STARTUP FAILED:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { createCustomerWebhookWorker, main };
