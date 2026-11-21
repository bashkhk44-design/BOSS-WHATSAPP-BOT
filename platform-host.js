'use strict';

require('dotenv').config();

const { createHealthServer } = require('./health-server');
const {
  validatePlatformWorkerEnvironment,
  createPlatformWorker,
  closePlatformWorkerResources
} = require('./platform-worker');

function validateWebhookBaseUrl(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('PLATFORM_WEBHOOK_BASE_URL is required when Telegram webhooks are enabled');
  }
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash ||
      url.username || url.password) {
    throw new Error('PLATFORM_WEBHOOK_BASE_URL must be an HTTPS origin without path, query, or credentials');
  }
  return url.origin;
}

async function callTelegramWebhookMethod(token, method, payload, fetchImpl = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetchImpl('https://api.telegram.org/bot' + token + '/' + method, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload || {}),
      signal: controller.signal
    });
    let result;
    try { result = await response.json(); } catch (_) {
      throw new Error('Telegram ' + method + ' returned an unreadable response');
    }
    if (!response.ok || result?.ok !== true) {
      throw new Error('Telegram ' + method + ' failed: ' + String(result?.description || response.status));
    }
    return result.result;
  } finally {
    clearTimeout(timer);
  }
}

async function registerPlatformTelegramWebhooks({ env, fetchImpl = fetch }) {
  const baseUrl = validateWebhookBaseUrl(env.PLATFORM_WEBHOOK_BASE_URL);
  const targets = [
    {
      identity: 'master',
      token: env.TELEGRAM_BOT_TOKEN,
      secret: env.MASTER_WEBHOOK_SECRET
    },
    {
      identity: 'intake',
      token: env.INTAKE_BOT_TOKEN,
      secret: env.INTAKE_WEBHOOK_SECRET
    }
  ];
  for (const target of targets) {
    if (typeof target.token !== 'string' || !target.token.trim()) {
      throw new Error('A Telegram bot token is required for ' + target.identity + ' webhook registration');
    }
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(target.secret || '')) {
      throw new Error('A valid webhook secret is required for ' + target.identity);
    }
  }
  if (targets[0].token === targets[1].token || targets[0].secret === targets[1].secret) {
    throw new Error('Master and intake webhook credentials must be distinct');
  }
  if (targets.some(target => target.secret === target.token) ||
      targets.some(target => targets.some(other => target.secret === other.token))) {
    throw new Error('Telegram webhook secrets must be independent from bot API tokens');
  }

  const registered = [];
  try {
    for (const target of targets) {
      await callTelegramWebhookMethod(target.token, 'setWebhook', {
        url: baseUrl + '/telegram/platform/' + target.identity,
        secret_token: target.secret,
        drop_pending_updates: false
      }, fetchImpl);
      registered.push(target);
    }
  } catch (error) {
    for (const target of registered.reverse()) {
      try {
        await callTelegramWebhookMethod(target.token, 'deleteWebhook', {
          drop_pending_updates: false
        }, fetchImpl);
      } catch (rollbackError) {
        error.rollbackError = rollbackError;
      }
    }
    throw error;
  }
  return registered.map(target => target.identity);
}

async function waitForPlatformWorkerReady(readyPromise, timeoutMs = 30000) {
  let timer;
  try {
    await Promise.race([
      readyPromise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Platform queue worker did not become ready before webhook registration')), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function startHealthOnlyRuntime({ env = process.env, logger = console, db } = {}) {
  if (typeof env.DATABASE_URL !== 'string' ||
      !/^postgres(?:ql)?:\/\//i.test(env.DATABASE_URL)) {
    throw new Error('DATABASE_URL must use the PostgreSQL protocol');
  }

  const database = db || require('./db');
  let stopped = false;
  let stopPromise = null;
  let resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });

  try {
    await database.pool.query('SELECT 1');
    logger.log('BOSS staging health-only mode connected to PostgreSQL; Telegram runtimes are disabled and runtime readiness remains false.');
  } catch (error) {
    const cleanup = [];
    if (database.pool && typeof database.pool.end === 'function') {
      cleanup.push(Promise.resolve().then(() => database.pool.end()));
    }
    if (typeof database.closeTelegramRuntimeLockPool === 'function') {
      cleanup.push(Promise.resolve().then(() => database.closeTelegramRuntimeLockPool()));
    }
    await Promise.allSettled(cleanup);
    throw error;
  }

  return {
    mode: 'health-only',
    get ready() { return false; },
    done,
    stop() {
      if (!stopPromise) {
        stopped = true;
        process.emit('boss:runtime-stopping', 'platform-health-only');
        stopPromise = (async () => {
          const results = await Promise.allSettled([
            database.pool && typeof database.pool.end === 'function'
              ? database.pool.end()
              : Promise.resolve(),
            typeof database.closeTelegramRuntimeLockPool === 'function'
              ? database.closeTelegramRuntimeLockPool()
              : Promise.resolve()
          ]);
          resolveDone();
          const failures = results.filter(result => result.status === 'rejected');
          if (failures.length) {
            throw new AggregateError(failures.map(result => result.reason), 'Health-only database cleanup failed');
          }
        })();
      }
      return stopPromise;
    }
  };
}

async function startPlatformHost({ env = process.env, logger = console, db: injectedDb } = {}) {
  const mode = env.PLATFORM_BOT_WEBHOOK_MODE || 'disabled';
  if (mode === 'disabled') {
    return startHealthOnlyRuntime({ env, logger, db: injectedDb });
  }
  if (mode !== 'enabled') {
    throw new Error('PLATFORM_BOT_WEBHOOK_MODE must be enabled or disabled');
  }

  validatePlatformWorkerEnvironment(env);
  const db = injectedDb || require('./db');
  const { createMasterRuntime } = require('./telegram-master');
  const { createIntakeRuntime } = require('./intake-bot');

  let master = null;
  let masterWebhook = null;
  let intakeWebhook = null;
  let worker = null;
  let closePromise = null;
  let stopping = false;
  let ready = false;
  let resolveWorkerReady;
  const workerReady = new Promise(resolve => { resolveWorkerReady = resolve; });

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

  process.on('boss:runtime-lock-lost', onLockLost);

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
      logger,
      onHealthChange(isHealthy, error) {
        if (stopping) return;
        if (isHealthy) {
          if (!ready) {
            ready = true;
            resolveWorkerReady();
            process.emit('boss:runtime-ready');
          }
        } else {
          ready = false;
          process.emit('boss:runtime-not-ready', error);
          logger.error('Platform queue worker is unhealthy:', error?.message || 'unknown error');
        }
      }
    });

    await worker.processOne();
    if (!(await db.isTelegramRuntimeLockHeld())) {
      throw new Error('Telegram runtime lock was lost before queue worker startup');
    }

    const done = worker.start();
    await waitForPlatformWorkerReady(workerReady, Number(env.PLATFORM_WEBHOOK_READY_TIMEOUT_MS || 30000));
    const registeredWebhooks = await registerPlatformTelegramWebhooks({ env });
    logger.log('BOSS platform webhook host started; Telegram webhooks registered:', registeredWebhooks.join(', '), worker.workerId);

    return {
      mode: 'webhook',
      workerId: worker.workerId,
      get ready() { return ready && !stopping; },
      done,
      async stop() {
        process.removeListener('boss:runtime-lock-lost', onLockLost);
        await close();
      }
    };
  } catch (error) {
    process.removeListener('boss:runtime-lock-lost', onLockLost);
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
  const onNotReady = () => { runtimeReady = false; };
  const onStopping = () => { runtimeReady = false; runtimeStopping = true; };
  process.on('boss:runtime-ready', onReady);
  process.on('boss:runtime-not-ready', onNotReady);
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
      process.removeListener('boss:runtime-not-ready', onNotReady);
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

module.exports = {
  validateWebhookBaseUrl,
  callTelegramWebhookMethod,
  registerPlatformTelegramWebhooks,
  waitForPlatformWorkerReady,
  startHealthOnlyRuntime,
  startPlatformHost,
  main
};
