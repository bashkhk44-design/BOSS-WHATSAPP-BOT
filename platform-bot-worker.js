'use strict';

const { createPlatformBotUpdateHandler } = require('./platform-bot-update-handler');

function validatePlatformBotWorkerEnvironment(env = {}) {
  if (env.PLATFORM_BOT_WEBHOOK_MODE !== 'enabled') return false;
  const required = ['TELEGRAM_BOT_TOKEN', 'INTAKE_BOT_TOKEN', 'TELEGRAM_ADMIN_ID'];
  for (const name of required) {
    if (typeof env[name] !== 'string' || !env[name].trim()) {
      throw new Error(name + ' is required when PLATFORM_BOT_WEBHOOK_MODE=enabled');
    }
  }
  if (env.TELEGRAM_BOT_TOKEN === env.INTAKE_BOT_TOKEN) {
    throw new Error('Master and intake Telegram bots must use different tokens');
  }
  return true;
}

async function createPlatformBotWorker({
  pool,
  env = {},
  createMasterRuntime,
  createIntakeRuntime,
  leaseSeconds = 120
}) {
  if (!pool || typeof pool.query !== 'function') {
    throw new TypeError('PostgreSQL queue pool is required');
  }

  if (!validatePlatformBotWorkerEnvironment(env)) {
    return {
      enabled: false,
      handlers: {},
      async close() {}
    };
  }

  const masterFactory = createMasterRuntime ||
    require('./telegram-master').createMasterRuntime;
  const intakeFactory = createIntakeRuntime ||
    require('./intake-bot').createIntakeRuntime;

  const masterRuntime = masterFactory({
    env,
    token: env.TELEGRAM_BOT_TOKEN,
    adminId: env.TELEGRAM_ADMIN_ID
  });
  if (!masterRuntime || typeof masterRuntime.createWebhookRuntime !== 'function') {
    throw new TypeError('Master runtime factory must expose createWebhookRuntime()');
  }

  const masterWebhook = masterRuntime.createWebhookRuntime();
  const intakeRuntime = intakeFactory();
  if (!intakeRuntime || typeof intakeRuntime.createWebhookRuntime !== 'function') {
    await masterWebhook.stop();
    await masterRuntime.closeWebhookResources?.();
    throw new TypeError('Intake runtime factory must expose createWebhookRuntime()');
  }

  let intakeWebhook;
  try {
    intakeWebhook = await intakeRuntime.createWebhookRuntime({
      token: env.INTAKE_BOT_TOKEN,
      notifyAdmin: async ({ text, extra }) => {
        await masterRuntime.bot.api.sendMessage(env.TELEGRAM_ADMIN_ID, text, extra);
      }
    });
  } catch (error) {
    await masterWebhook.stop();
    await masterRuntime.closeWebhookResources?.();
    throw error;
  }

  const dispatch = createPlatformBotUpdateHandler({
    pool,
    leaseSeconds,
    runtimes: {
      master: masterWebhook,
      intake: intakeWebhook
    }
  });

  let closePromise = null;
  return {
    enabled: true,
    handlers: {
      'telegram.master.update': dispatch,
      'telegram.intake.update': dispatch
    },
    close() {
      if (!closePromise) {
        closePromise = (async () => {
          await intakeWebhook.stop();
          await masterWebhook.stop();
          await masterRuntime.closeWebhookResources?.();
        })();
      }
      return closePromise;
    }
  };
}

module.exports = {
  validatePlatformBotWorkerEnvironment,
  createPlatformBotWorker
};
