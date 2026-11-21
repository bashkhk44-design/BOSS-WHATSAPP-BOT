'use strict';

require('dotenv').config();

const { createQueueWorker } = require('./queue-worker');
const { createPlatformBotUpdateHandler } = require('./platform-bot-update-handler');
const { JOB_TYPES } = require('./platform-bot-update-handler');

function validatePlatformWorkerEnvironment(env = process.env) {
  const { validateWorkerEnvironment } = require('./worker');
  validateWorkerEnvironment(env);
  for (const name of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_ADMIN_ID', 'INTAKE_BOT_TOKEN']) {
    if (typeof env[name] !== 'string' || !env[name].trim()) {
      throw new Error(name + ' is required for the platform Telegram worker');
    }
  }
  if (!/^\d+$/.test(env.TELEGRAM_ADMIN_ID)) {
    throw new Error('TELEGRAM_ADMIN_ID must be a numeric Telegram user ID');
  }
  const { validatePlatformBotWorkerEnvironment } = require('./platform-bot-worker');
  if (!validatePlatformBotWorkerEnvironment(env)) {
    throw new Error('PLATFORM_BOT_WEBHOOK_MODE=enabled is required to start the platform worker');
  }
  return true;
}

async function verifyPlatformWorkerSchema(pool) {
  if (!pool || typeof pool.query !== 'function') {
    throw new TypeError('PostgreSQL pool is required to verify platform worker schema');
  }
  await pool.query(`
    SELECT id, job_type, status, attempts, max_attempts, available_at,
           locked_by, locked_at, payload
    FROM platform_jobs
    LIMIT 0
  `);
  await pool.query(`
    SELECT bot_identity, update_id, payload, state, attempts,
           locked_by, locked_at
    FROM platform_bot_inbound_updates
    LIMIT 0
  `);
  return true;
}

function createPlatformWorker({
  pool,
  runtimes,
  pollIntervalMs = 1000,
  leaseSeconds = 120,
  workerId,
  logger = console,
  queueApi
}) {
  const handleUpdate = createPlatformBotUpdateHandler({ pool, runtimes, leaseSeconds });
  const options = {
    pool,
    handlers: {
      [JOB_TYPES.master]: handleUpdate,
      [JOB_TYPES.intake]: handleUpdate
    },
    pollIntervalMs,
    leaseSeconds,
    logger
  };
  if (workerId) options.workerId = workerId;
  if (queueApi) options.queueApi = queueApi;
  return createQueueWorker(options);
}

async function closePlatformWorkerResources({
  worker,
  master,
  masterWebhook,
  intakeWebhook,
  pool
} = {}) {
  const failures = [];
  if (worker && typeof worker.stop === 'function') {
    try { await worker.stop(); } catch (error) { failures.push(error); }
  }

  const stops = await Promise.allSettled([
    masterWebhook && typeof masterWebhook.stop === 'function'
      ? masterWebhook.stop()
      : Promise.resolve(),
    intakeWebhook && typeof intakeWebhook.stop === 'function'
      ? intakeWebhook.stop()
      : Promise.resolve()
  ]);
  for (const result of stops) {
    if (result.status === 'rejected') failures.push(result.reason);
  }

  if (master && typeof master.closeWebhookResources === 'function') {
    try {
      // The master runtime owns the same shared db pool used by this entrypoint.
      await master.closeWebhookResources();
    } catch (error) {
      failures.push(error);
    }
  } else if (pool && typeof pool.end === 'function') {
    try { await pool.end(); } catch (error) { failures.push(error); }
  }

  if (failures.length) {
    throw new AggregateError(failures, 'One or more platform worker resources failed to close');
  }
}

async function main() {
  validatePlatformWorkerEnvironment();
  const db = require('./db');
  const { createMasterRuntime } = require('./telegram-master');
  const { createIntakeRuntime } = require('./intake-bot');

  let master = null;
  let masterWebhook = null;
  let intakeWebhook = null;
  let worker = null;
  let closePromise = null;

  const close = () => {
    if (!closePromise) {
      process.emit('boss:runtime-stopping', 'PLATFORM_WORKER_SHUTDOWN');
      closePromise = closePlatformWorkerResources({
        worker,
        master,
        masterWebhook,
        intakeWebhook,
        pool: db.pool
      });
    }
    return closePromise;
  };

  try {
    master = createMasterRuntime({
      token: process.env.TELEGRAM_BOT_TOKEN,
      adminId: process.env.TELEGRAM_ADMIN_ID
    });
    masterWebhook = await master.createWebhookRuntime({
      onLockFailure: async error => {
        console.error('PLATFORM TELEGRAM RUNTIME LOCK LOST:', error.message);
        process.exitCode = 1;
        await close();
      }
    });

    const intake = createIntakeRuntime();
    intakeWebhook = await intake.createWebhookRuntime({
      token: process.env.INTAKE_BOT_TOKEN
    });

    const leaseSeconds = Number(process.env.QUEUE_LEASE_SECONDS || 120);
    worker = createPlatformWorker({
      pool: db.pool,
      runtimes: { master: masterWebhook, intake: intakeWebhook },
      pollIntervalMs: Number(process.env.QUEUE_POLL_INTERVAL_MS || 1000),
      leaseSeconds
    });

    let stopping = false;
    const shutdown = async signal => {
      if (stopping) return;
      stopping = true;
      console.log('Platform Telegram worker stopping: ' + signal);
      await close();
    };
    process.once('SIGTERM', () => shutdown('SIGTERM').catch(error => {
      console.error('Platform worker shutdown failed:', error.message);
      process.exitCode = 1;
    }));
    process.once('SIGINT', () => shutdown('SIGINT').catch(error => {
      console.error('Platform worker shutdown failed:', error.message);
      process.exitCode = 1;
    }));

    // Verify the actual queue tables/columns as well as basic database connectivity
    // before advertising readiness; a missing migration must fail startup, not spin forever.
    await verifyPlatformWorkerSchema(db.pool);
    await db.pool.query('SELECT 1');
    console.log('Platform Telegram worker started: ' + worker.workerId);
    const workerLoop = worker.start();
    process.emit('boss:runtime-ready');
    await workerLoop;
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      error.cleanupError = cleanupError;
    }
    throw error;
  }
}
if (require.main === module) {
  main().catch(error => {
    console.error('PLATFORM TELEGRAM WORKER STARTUP FAILED:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { validatePlatformWorkerEnvironment, verifyPlatformWorkerSchema, createPlatformWorker, closePlatformWorkerResources, main };
