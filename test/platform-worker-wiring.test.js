'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validatePlatformWorkerEnvironment,
  createPlatformWorker,
  closePlatformWorkerResources
} = require('../platform-worker');

const validEnv = {
  DATABASE_URL: 'postgresql://test:test@localhost:5432/boss_test',
  BOTS_ENCRYPTION_KEY: 'a'.repeat(64),
  TELEGRAM_BOT_TOKEN: 'master-test-token',
  TELEGRAM_ADMIN_ID: '10001',
  INTAKE_BOT_TOKEN: 'intake-test-token',
  PLATFORM_BOT_WEBHOOK_MODE: 'enabled'
};

test('platform worker requires both system bot tokens and a master administrator ID', () => {
  assert.equal(validatePlatformWorkerEnvironment(validEnv), true);
  assert.throws(() => validatePlatformWorkerEnvironment({ ...validEnv, TELEGRAM_ADMIN_ID: 'admin' }), /numeric Telegram user ID/);
  for (const name of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_ADMIN_ID', 'INTAKE_BOT_TOKEN']) {
    const env = { ...validEnv };
    delete env[name];
    assert.throws(() => validatePlatformWorkerEnvironment(env), new RegExp(name));
  }
});

test('platform worker refuses missing or disabled webhook mode', () => {
  assert.throws(
    () => validatePlatformWorkerEnvironment({ ...validEnv, PLATFORM_BOT_WEBHOOK_MODE: undefined }),
    /PLATFORM_BOT_WEBHOOK_MODE=enabled/
  );
  assert.throws(
    () => validatePlatformWorkerEnvironment({ ...validEnv, PLATFORM_BOT_WEBHOOK_MODE: 'disabled' }),
    /PLATFORM_BOT_WEBHOOK_MODE=enabled/
  );
  assert.throws(
    () => validatePlatformWorkerEnvironment({ ...validEnv, INTAKE_BOT_TOKEN: 'master-test-token' }),
    /different tokens/
  );
});

test('platform worker claims only master and intake update job types', async () => {
  const seen = [];
  const queueApi = {
    async recoverExpiredPlatformJobs(_pool, _lease, types) { seen.push(['recover', types]); return []; },
    async claimPlatformJob(_pool, _worker, types) { seen.push(['claim', types]); return null; }
  };
  const worker = createPlatformWorker({
    pool: { query: async () => ({ rows: [], rowCount: 0 }) },
    runtimes: {
      master: { handleUpdate: async () => {} },
      intake: { handleUpdate: async () => {} }
    },
    queueApi,
    logger: { log() {}, warn() {}, error() {} }
  });
  await worker.processOne();
  assert.deepEqual(seen.map(item => item[0]), ['recover', 'claim']);
  for (const [, types] of seen) {
    assert.deepEqual(types.sort(), ['telegram.intake.update', 'telegram.master.update']);
    assert.equal(types.includes('telegram.update'), false);
  }
});


test('platform worker cleanup stops the worker and runtimes before closing the shared master database pool', async () => {
  const events = [];
  await closePlatformWorkerResources({
    worker: { async stop() { events.push('worker'); } },
    master: { async closeWebhookResources() { events.push('master-resources'); } },
    masterWebhook: { async stop() { events.push('master-webhook'); } },
    intakeWebhook: { async stop() { events.push('intake-webhook'); } },
    pool: { async end() { events.push('pool'); } }
  });

  assert.deepEqual(events, [
    'worker',
    'master-webhook',
    'intake-webhook',
    'master-resources'
  ]);
});

test('platform worker cleanup attempts every resource even when one stop operation fails', async () => {
  const events = [];
  await assert.rejects(
    closePlatformWorkerResources({
      worker: { async stop() { events.push('worker'); throw new Error('worker stop failed'); } },
      master: { async closeWebhookResources() { events.push('master-resources'); } },
      masterWebhook: { async stop() { events.push('master-webhook'); throw new Error('master stop failed'); } },
      intakeWebhook: { async stop() { events.push('intake-webhook'); } }
    }),
    /One or more platform worker resources failed to close/
  );

  assert.deepEqual(events, [
    'worker',
    'master-webhook',
    'intake-webhook',
    'master-resources'
  ]);
});
