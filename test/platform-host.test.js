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

test('staging Telegram webhook registration rolls back every attempted bot after an ambiguous network failure', async () => {
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
      // Simulate Telegram accepting the request but the response being lost.
      throw new Error('simulated network timeout after request delivery');
    }
    return { ok: true, async json() { return { ok: true, result: true }; } };
  };

  await assert.rejects(
    registerPlatformTelegramWebhooks({ env, fetchImpl }),
    /simulated network timeout/
  );
  assert.equal(calls.length, 4);
  assert.ok(calls[2].url.endsWith('/botintake-test-token/deleteWebhook'));
  assert.ok(calls[3].url.endsWith('/botmaster-test-token/deleteWebhook'));
  assert.equal(calls[2].body.drop_pending_updates, false);
  assert.equal(calls[3].body.drop_pending_updates, false);
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


test('webhook registration readiness gate waits for the queue worker ready signal', async () => {
  const { waitForPlatformWorkerReady } = require('../platform-host');
  let signalReady;
  let registrationStarted = false;
  const workerReady = new Promise(resolve => { signalReady = resolve; });
  const registration = (async () => {
    await waitForPlatformWorkerReady(workerReady, 500);
    registrationStarted = true;
  })();

  await new Promise(resolve => setImmediate(resolve));
  assert.equal(registrationStarted, false, 'webhook registration must not start before worker readiness');
  signalReady();
  await registration;
  assert.equal(registrationStarted, true, 'webhook registration may proceed after worker readiness');
});

test('webhook registration readiness gate fails closed when the queue worker never becomes ready', async () => {
  const { waitForPlatformWorkerReady } = require('../platform-host');
  let registrationStarted = false;
  const workerReady = new Promise(() => {});
  await assert.rejects(
    (async () => {
      await waitForPlatformWorkerReady(workerReady, 20);
      registrationStarted = true;
    })(),
    /did not become ready before webhook registration/
  );
  assert.equal(registrationStarted, false, 'webhook registration must remain blocked after readiness timeout');
});

test('webhook registration rolls back all attempted targets if the runtime lock is lost after registration', async () => {
  const { registerPlatformTelegramWebhooks } = require('../platform-host');
  const calls = [];
  let checks = 0;
  await assert.rejects(
    registerPlatformTelegramWebhooks({
      env: {
        PLATFORM_WEBHOOK_BASE_URL: 'https://staging.example.invalid',
        TELEGRAM_BOT_TOKEN: 'master-test-token',
        INTAKE_BOT_TOKEN: 'intake-test-token',
        MASTER_WEBHOOK_SECRET: 'M'.repeat(40),
        INTAKE_WEBHOOK_SECRET: 'I'.repeat(40)
      },
      assertReady: async () => {
        checks += 1;
        if (checks === 3) throw new Error('Telegram runtime lock was lost');
      },
      fetchImpl: async (url) => {
        const method = url.split('/').pop();
        calls.push(method);
        return new Response(JSON.stringify({ ok: true, result: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
    }),
    /runtime lock was lost/
  );
  assert.deepEqual(calls, ['setWebhook', 'setWebhook', 'deleteWebhook', 'deleteWebhook']);
});

test('webhook registration does not contact Telegram when the runtime is unsafe before the first request', async () => {
  const { registerPlatformTelegramWebhooks } = require('../platform-host');
  let requests = 0;
  await assert.rejects(
    registerPlatformTelegramWebhooks({
      env: {
        PLATFORM_WEBHOOK_BASE_URL: 'https://staging.example.invalid',
        TELEGRAM_BOT_TOKEN: 'master-test-token',
        INTAKE_BOT_TOKEN: 'intake-test-token',
        MASTER_WEBHOOK_SECRET: 'M'.repeat(40),
        INTAKE_WEBHOOK_SECRET: 'I'.repeat(40)
      },
      assertReady: async () => { throw new Error('runtime is not ready'); },
      fetchImpl: async () => { requests += 1; return new Response('{}'); }
    }),
    /runtime is not ready/
  );
  assert.equal(requests, 0);
});

test('platform host refuses to start when shutdown has already cancelled startup', async () => {
  const db = fakeDatabase();
  const controller = new AbortController();
  controller.abort(new Error('shutdown requested'));
  await assert.rejects(
    startPlatformHost({
      env: {
        PLATFORM_BOT_WEBHOOK_MODE: 'disabled',
        DATABASE_URL: 'postgresql://staging:test@localhost/staging'
      },
      db,
      signal: controller.signal,
      logger: { log() {}, error() {} }
    }),
    /shutdown requested/
  );
  assert.equal(db.calls.query, 0, 'cancelled startup must not open database resources');
});

test('webhook readiness wait is cancelled immediately when shutdown is requested', async () => {
  const { waitForPlatformWorkerReady } = require('../platform-host');
  const controller = new AbortController();
  const workerReady = new Promise(() => {});
  const waiting = waitForPlatformWorkerReady(workerReady, 10000, controller.signal);
  controller.abort(new Error('shutdown during worker readiness'));
  await assert.rejects(waiting, /shutdown during worker readiness/);
});

test('health-only startup aborts if shutdown arrives while the database probe is pending', async () => {
  const controller = new AbortController();
  let finishProbe;
  const calls = { poolEnd: 0, lockPoolEnd: 0 };
  const db = {
    pool: {
      query() {
        return new Promise(resolve => { finishProbe = resolve; });
      },
      async end() { calls.poolEnd += 1; }
    },
    async closeTelegramRuntimeLockPool() { calls.lockPoolEnd += 1; }
  };

  const startup = startPlatformHost({
    env: {
      PLATFORM_BOT_WEBHOOK_MODE: 'disabled',
      DATABASE_URL: 'postgresql://staging:test@localhost/staging'
    },
    db,
    signal: controller.signal,
    logger: { log() {}, error() {} }
  });

  await new Promise(resolve => setImmediate(resolve));
  controller.abort(new Error('shutdown during database probe'));
  finishProbe({ rows: [{ '?column?': 1 }] });

  await assert.rejects(startup, /shutdown during database probe/);
  assert.equal(calls.poolEnd, 1);
  assert.equal(calls.lockPoolEnd, 1);
});

test('health-only startup checks cancellation before opening the database connection', async () => {
  const controller = new AbortController();
  controller.abort(new Error('shutdown before database probe'));
  const db = fakeDatabase();

  await assert.rejects(
    startPlatformHost({
      env: {
        PLATFORM_BOT_WEBHOOK_MODE: 'disabled',
        DATABASE_URL: 'postgresql://staging:test@localhost/staging'
      },
      db,
      signal: controller.signal,
      logger: { log() {}, error() {} }
    }),
    /shutdown before database probe/
  );
  assert.equal(db.calls.query, 0);
  assert.equal(db.calls.poolEnd, 0);
});
