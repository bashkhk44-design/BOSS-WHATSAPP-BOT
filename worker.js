'use strict';

require('dotenv').config();

const path = require('node:path');
const { Pool } = require('pg');
const { decryptToken } = require('./db');
const { createQueueWorker } = require('./queue-worker');
const { createTelegramUpdateHandler } = require('./telegram-update-handler');

function validateWorkerEnvironment(env = process.env) {
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  if (!/^postgres(?:ql)?:\/\/$/i.test(env.DATABASE_URL.split('?')[0].replace(/\/[^/]*$/, '/'))) {
    if (!/^postgres(?:ql)?:\/\//i.test(env.DATABASE_URL)) {
      throw new Error('DATABASE_URL must use the PostgreSQL protocol');
    }
  }
  if (!/^[0-9a-fA-F]{64}$/.test(env.BOTS_ENCRYPTION_KEY || '')) {
    throw new Error('BOTS_ENCRYPTION_KEY must be a 32-byte hex key');
  }
  return true;
}

async function main() {
  validateWorkerEnvironment();

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'disable' ? false : { rejectUnauthorized: false },
    max: Number(process.env.WORKER_DB_POOL_MAX || 2),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
  });

  const handlers = {
    'telegram.update': createTelegramUpdateHandler({ pool, decryptToken })
  };

  if (process.env.JOB_HANDLERS_MODULE) {
    const handlersPath = path.isAbsolute(process.env.JOB_HANDLERS_MODULE)
      ? process.env.JOB_HANDLERS_MODULE
      : path.resolve(process.cwd(), process.env.JOB_HANDLERS_MODULE);
    const loaded = require(handlersPath);
    Object.assign(handlers, loaded.handlers || loaded);
  }

  const worker = createQueueWorker({
    pool,
    handlers,
    pollIntervalMs: Number(process.env.QUEUE_POLL_INTERVAL_MS || 1000),
    leaseSeconds: Number(process.env.QUEUE_LEASE_SECONDS || 120)
  });

  let shuttingDown = false;
  const shutdown = async signal => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(\`Queue worker stopping: \${signal}\`);
    await worker.stop();
    await pool.end();
  };

  process.once('SIGTERM', () => shutdown('SIGTERM').catch(err => {
    console.error('Worker shutdown failed:', err.message);
    process.exitCode = 1;
  }));
  process.once('SIGINT', () => shutdown('SIGINT').catch(err => {
    console.error('Worker shutdown failed:', err.message);
    process.exitCode = 1;
  }));

  console.log(\`Queue worker started: \${worker.workerId}\`);
  await worker.start();
}

if (require.main === module) {
  main().catch(error => {
    console.error('QUEUE WORKER STARTUP FAILED:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { main, validateWorkerEnvironment };
