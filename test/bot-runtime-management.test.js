'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createBotRuntime } = require('../bot-runtime');

function fixturePool(records) {
  const statuses = new Map();
  return {
    statuses,
    async query(sql, params = []) {
      if (sql.includes('FROM telegram_bots') && sql.includes('WHERE active = TRUE')) {
        return { rowCount: records.filter(row => row.active).length, rows: records.filter(row => row.active) };
      }
      if (sql.includes('FROM telegram_bots') && sql.includes('WHERE id = $1')) {
        const row = records.find(item => String(item.id) === String(params[0]) && item.active);
        return { rowCount: row ? 1 : 0, rows: row ? [row] : [] };
      }
      if (sql.includes('INSERT INTO bot_runtime_status')) {
        statuses.set(String(params[0]), { status: params[1], error: params[4] });
        return { rowCount: 1, rows: [] };
      }
      throw new Error('Unexpected SQL in test: ' + sql.slice(0, 80));
    }
  };
}

function fixtureBotFactory() {
  const started = [];
  const stopped = [];
  return {
    started,
    stopped,
    create(record) {
      let finish;
      return {
        async start({ onStart }) {
          started.push(String(record.id));
          onStart({ username: record.username });
          await new Promise(resolve => { finish = resolve; });
        },
        async stop() {
          stopped.push(String(record.id));
          if (finish) finish();
        }
      };
    }
  };
}

test('starts one bot on demand, does not duplicate it, and stops it independently', async () => {
  const records = [{ id: 1, name: 'One', username: 'one_bot', active: true, token_ciphertext: 'x' }];
  const pool = fixturePool(records);
  const bots = fixtureBotFactory();
  const runtime = createBotRuntime({
    pool,
    decryptToken: () => 'token',
    createCustomerBot: record => bots.create(record),
    logger: { log() {}, error() {} },
    heartbeatIntervalMs: 100000
  });

  await runtime.startBotById(1);
  await new Promise(resolve => setImmediate(resolve));
  await runtime.startBotById(1);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(bots.started, ['1']);
  assert.equal(runtime.getBotRuntimeStatus(1), 'running');

  await runtime.stopBotById(1);
  assert.equal(runtime.getBotRuntimeStatus(1), 'stopped');
  assert.deepEqual(bots.stopped, ['1']);
});

test('enforces configured maximum active bot capacity', async () => {
  const records = [1, 2].map(id => ({
    id, name: 'Bot ' + id, username: 'bot_' + id, active: true, token_ciphertext: 'x'
  }));
  const pool = fixturePool(records);
  const bots = fixtureBotFactory();
  const runtime = createBotRuntime({
    pool,
    decryptToken: () => 'token',
    createCustomerBot: record => bots.create(record),
    logger: { log() {}, error() {} },
    maxBots: 1,
    heartbeatIntervalMs: 100000
  });

  const result = await runtime.startBotRuntime();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(result, { found: 2, started: 1, capacity: 1 });
  assert.deepEqual(bots.started, ['1']);
  await assert.rejects(runtime.startBotById(2), /Maximum active customer bots reached/);
  await runtime.stopBotRuntime();
});

test('returns not_loaded for bots absent from this runtime', () => {
  const runtime = createBotRuntime({
    pool: fixturePool([]),
    decryptToken: () => 'token',
    createCustomerBot: () => ({}),
    logger: { log() {}, error() {} }
  });
  assert.equal(runtime.getBotRuntimeStatus(99), 'not_loaded');
});
