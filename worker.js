'use strict';

require('dotenv').config();

const path = require('node:path');
const { Pool } = require('pg');
const { createQueueWorker } = require('./queue-worker');

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  if (!process.env.JOB_HANDLERS_MODULE) {
    throw new Error('JOB_HANDLERS_MODULE must point to a module exporting a job handler map; refusing to consume jobs without handlers');
  }

  const handlersPath = path.isAbsolute(process.env.JOB_HANDLERS_MODULE)
    ? process.env.JOB_HANDLERS_MODULE
    : path.resolve(process.cwd(), process.env.JOB_HANDLERS_MODULE);
  const loaded = require(handlersPath);
  const handlers = loaded.handlers || loaded;

  if (!handlers || typeof handlers !== 'object' || !Object.keys(handlers).length) {
    throw new Error('The configured job handler module exports no handlers; worker will not start');
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: Number(process.env.WORKER_DB_POOL_MAX || 2),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
  });

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
    console.log(`Queue worker stopping: ${signal}`);
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

  console.log(`Queue worker started: ${worker.workerId}`);
  await worker.start();
}

if (require.main === module) {
  main().catch(error => {
    console.error('QUEUE WORKER STARTUP FAILED:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { main };
