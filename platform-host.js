'use strict';

require('dotenv').config();

const { createHealthServer } = require('./health-server');
const {
  validatePlatformWorkerEnvironment,
  createPlatformWorker,
  closePlatformWorkerResources
} = require('./platform-worker');

async function startPlatformHost({ env = process.env, logger = console } = {}) {
  validatePlatformWorkerEnvironment(env);
  const db = require('./db');
  const { createMasterRuntime } = require('./telegram-master');
  const { createIntakeRuntime } = require('./intake-bot');

  let master = null;
  let masterWebhook = null;
  let intakeWebhook = null;
  let worker = null;
  let closePromise = null;
  let stopping = false;
  let ready = false;

  const close = () => {
    if (!closePromise) {
      stopping = true;
      ready = false;
      process.emit('boss:runtime-stopping', 'platform-host');
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

  const onLockLost = error => {
    ready = false;
    logger.error('Telegram runtime lock lost; platform host is stopping:', error?.message || 'unknown error');
    void close().catch(closeError => {
      logger.error('Platform host lock-loss cleanup failed:', closeError.message);
      process.exitCode = 1;
    });
  };

  try {
    master = createMasterRuntime({
      env,
      token: env.TELEGRAM_BOT_TOKEN,
      adminId: env.TELEGRAM_ADMIN_ID
    });
    masterWebhook = await master.createWebhookRuntime();

    const intake = createIntakeRuntime();
    intakeWebhook = await intake.createWebhookRuntime({
      token: env.INTAKE_BOT_TOKEN,
      notifyAdmin: async ({ text, extra }) => {
        await master.bot.api.sendMessage(env.TELEGRAM_ADMIN_ID, text, extra);
      }
    });

    await db.pool.query('SELECT 1');
    worker = createPlatformWorker({
      pool: db.pool,
      runtimes: { master: masterWebhook, intake: intakeWebhook },
      pollIntervalMs: Number(env.QUEUE_POLL_INTERVAL_MS || 1000),
      leaseSeconds: Number(env.QUEUE_LEASE_SECONDS || 120),
      logger
    });

    process.on('boss:runtime-lock-lost', onLockLost);
    const done = worker.start();
    ready = true;
    process.emit('boss:runtime-ready');
    logger.log('BOSS platform webhook host READY; queue worker:', worker.workerId);

    return {
      workerId: worker.workerId,
      get ready() { return ready && !stopping; },
      done,
      async stop() {
        process.removeListener('boss:runtime-lock-lost', onLockLost);
        await close();
      }
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      error.cleanupError = cleanupError;
    }
    throw error;
  }
}

async function main() {
  let runtime = null;
  let runtimeReady = false;
  let runtimeStopping = false;
  let shutdownStarted = false;
  let server;

  const port = Number(process.env.PORT || 8080);
  server = createHealthServer(() => ({ runtimeReady, runtimeStopping }));
  server.listen(port, '0.0.0.0', () => {
    console.log('BOSS platform health server listening on port ' + port);
  });
  server.on('error', error => {
    console.error('BOSS platform health server error:', error.message);
    process.exitCode = 1;
  });

  const onReady = () => { runtimeReady = true; runtimeStopping = false; };
  const onStopping = () => { runtimeReady = false; runtimeStopping = true; };
  process.on('boss:runtime-ready', onReady);
  process.on('boss:runtime-stopping', onStopping);

  const shutdown = async signal => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    console.log('BOSS platform host stopping:', signal);
    onStopping();
    try {
      await runtime?.stop();
    } finally {
      process.removeListener('boss:runtime-ready', onReady);
      process.removeListener('boss:runtime-stopping', onStopping);
      process.removeListener('boss:runtime-lock-lost', onLockLost);
      await new Promise(resolve => server.close(resolve));
    }
  };

  const onLockLost = error => shutdown('LOCK_LOST').catch(shutdownError => {
    console.error('BOSS platform host lock-loss shutdown failed:', shutdownError.message);
    process.exitCode = 1;
  });
  process.on('boss:runtime-lock-lost', onLockLost);

  process.once('SIGTERM', () => shutdown('SIGTERM').catch(error => {
    console.error('BOSS platform host shutdown failed:', error.message);
    process.exitCode = 1;
  }));
  process.once('SIGINT', () => shutdown('SIGINT').catch(error => {
    console.error('BOSS platform host shutdown failed:', error.message);
    process.exitCode = 1;
  }));

  try {
    runtime = await startPlatformHost();
    if (runtime.ready) onReady();
    await runtime.done;
  } catch (error) {
    onStopping();
    console.error('BOSS PLATFORM HOST STARTUP FAILED:', error.message);
    process.exitCode = 1;
    try { await runtime?.stop(); } catch (cleanupError) {
      console.error('BOSS platform cleanup failed:', cleanupError.message);
    }
    server.close();
  }
}

if (require.main === module) {
  main();
}

module.exports = { startPlatformHost, main };
