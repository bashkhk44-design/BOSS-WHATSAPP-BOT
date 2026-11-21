'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startPlatformHost } = require('../platform-host');

function fakeDatabase({ failQuery = false } = {}) {
  const calls = { query: 0, poolEnd: 0, lockPoolEnd: 0 };
  return {
    calls,
    pool: {
      async query(sql) {
        calls.query += 1;
        assert.equal(sql, 'SELECT 1');
        if (failQuery) throw new Error('staging database unavailable');
        return { rows: [{ '?column?': 1 }] };
      },
      async end() { calls.poolEnd += 1; }
    },
    async closeTelegramRuntimeLockPool() { calls.lockPoolEnd += 1; }
  };
}

test('disabled staging mode starts health-only without Telegram credentials or runtimes', async () => {
  const db = fakeDatabase();
  const readyEvents = [];
  const onReady = () => readyEvents.push(true);
  process.on('boss:runtime-ready', onReady);

  try {
    const runtime = await startPlatformHost({
      env: {
        PLATFORM_BOT_WEBHOOK_MODE: 'disabled',
        DATABASE_URL: 'postgresql://staging:test@localhost/staging'
      },
      db,
      logger: { log() {}, error() {} }
    });

    assert.equal(runtime.mode, 'health-only');
    assert.equal(runtime.ready, false, 'database connectivity alone must not signal webhook runtime readiness');
    assert.equal(db.calls.query, 1);
    assert.deepEqual(readyEvents, [], 'health-only mode must not emit the runtime-ready event');
    await runtime.stop();
    assert.equal(runtime.ready, false);
    assert.equal(db.calls.poolEnd, 1);
    assert.equal(db.calls.lockPoolEnd, 1);
  } finally {
    process.removeListener('boss:runtime-ready', onReady);
  }
});

test('disabled staging mode fails closed when the database cannot be reached', async () => {
  const db = fakeDatabase({ failQuery: true });
  await assert.rejects(
    startPlatformHost({
      env: {
        PLATFORM_BOT_WEBHOOK_MODE: 'disabled',
        DATABASE_URL: 'postgresql://staging:test@localhost/staging'
      },
      db,
      logger: { log() {}, error() {} }
    }),
    /staging database unavailable/
  );
  assert.equal(db.calls.poolEnd, 1);
  assert.equal(db.calls.lockPoolEnd, 1);
});

test('unknown platform mode is rejected instead of activating a runtime', async () => {
  await assert.rejects(
    startPlatformHost({
      env: {
        PLATFORM_BOT_WEBHOOK_MODE: 'maybe',
        DATABASE_URL: 'postgresql://staging:test@localhost/staging'
      },
      db: fakeDatabase(),
      logger: { log() {}, error() {} }
    }),
    /must be enabled or disabled/
  );
});


test('staging Telegram webhook registration targets both identities with independent secrets', async () => {
  const { registerPlatformTelegramWebhooks } = require('../platform-host');
  const calls = [];
  const env = {
    PLATFORM_WEBHOOK_BASE_URL: 'https://boss-bot-platform-ingress-staging.bashkhk44.workers.dev',
    TELEGRAM_BOT_TOKEN: 'master-test-token',
    INTAKE_BOT_TOKEN: 'intake-test-token',
    MASTER_WEBHOOK_SECRET: 'M'.repeat(40),
    INTAKE_WEBHOOK_SECRET: 'I'.repeat(40)
  };
  const fetchImpl = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return { ok: true, async json() { return { ok: true, result: true }; } };
  };

  const registered = await registerPlatformTelegramWebhooks({ env, fetchImpl });
  assert.deepEqual(registered, ['master', 'intake']);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://api.telegram.org/botmaster-test-token/setWebhook');
  assert.equal(calls[0].body.url, env.PLATFORM_WEBHOOK_BASE_URL + '/telegram/platform/master');
  assert.equal(calls[0].body.secret_token, env.MASTER_WEBHOOK_SECRET);
  assert.equal(calls[0].body.drop_pending_updates, false);
  assert.equal(calls[1].body.url, env.PLATFORM_WEBHOOK_BASE_URL + '/telegram/platform/intake');
  assert.equal(calls[1].body.secret_token, env.INTAKE_WEBHOOK_SECRET);
});

test('staging Telegram webhook registration rolls back the first bot if the second fails', async () => {
  const { registerPlatformTelegramWebhooks } = require('../platform-host');
  const calls = [];
  const env = {
    PLATFORM_WEBHOOK_BASE_URL: 'https://boss-bot-platform-ingress-staging.bashkhk44.workers.dev',
    TELEGRAM_BOT_TOKEN: 'master-test-token',
    INTAKE_BOT_TOKEN: 'intake-test-token',
    MASTER_WEBHOOK_SECRET: 'M'.repeat(40),
    INTAKE_WEBHOOK_SECRET: 'I'.repeat(40)
  };
  const fetchImpl = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    if (url.endsWith('/botintake-test-token/setWebhook')) {
      return { ok: true, async json() { return { ok: false, description: 'test failure' }; } };
    }
    return { ok: true, async json() { return { ok: true, result: true }; } };
  };

  await assert.rejects(
    registerPlatformTelegramWebhooks({ env, fetchImpl }),
    /Telegram setWebhook failed/
  );
  assert.equal(calls.length, 3);
  assert.ok(calls[2].url.endsWith('/botmaster-test-token/deleteWebhook'));
  assert.equal(calls[2].body.drop_pending_updates, false);
});

test('staging Telegram webhook registration rejects a non-HTTPS or path-bearing origin', async () => {
  const { registerPlatformTelegramWebhooks } = require('../platform-host');
  await assert.rejects(
    registerPlatformTelegramWebhooks({
      env: {
        PLATFORM_WEBHOOK_BASE_URL: 'http://example.com/not-staging',
        TELEGRAM_BOT_TOKEN: 'master-test-token',
        INTAKE_BOT_TOKEN: 'intake-test-token',
        MASTER_WEBHOOK_SECRET: 'M'.repeat(40),
        INTAKE_WEBHOOK_SECRET: 'I'.repeat(40)
      },
      fetchImpl: async () => { throw new Error('fetch must not be called'); }
    }),
    /must be an HTTPS origin/
  );
});
