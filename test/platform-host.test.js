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
