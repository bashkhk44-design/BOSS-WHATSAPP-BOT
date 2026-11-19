'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTelegramUpdateHandler } = require('../telegram-update-handler');

test('Telegram update handler claims, dispatches, and marks an update processed', async () => {
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('UPDATE bot_inbound_updates AS inbound')) {
        return {
          rowCount: 1,
          rows: [{
            payload: { update_id: 77, message: { text: '/start' } },
            id: 5,
            name: 'Test bot',
            token_ciphertext: 'encrypted'
          }]
        };
      }
      if (sql.includes("SET state = 'processed'")) return { rowCount: 1, rows: [] };
      throw new Error('unexpected SQL');
    }
  };
  let handled = false;
  const order = [];
  const handler = createTelegramUpdateHandler({
    pool,
    decryptToken: record => record.token_ciphertext === 'encrypted' ? 'test-token' : '',
    botFactory: (record, token) => ({
      async init() { order.push('init'); },
      async handleUpdate(update) {
        order.push('handle');
        assert.equal(record.name, 'Test bot');
        assert.equal(token, 'test-token');
        assert.equal(update.update_id, 77);
        handled = true;
      }
    })
  });

  const result = await handler({ payload: { botId: 5, updateId: 77 } });
  assert.equal(handled, true);
  assert.deepEqual(order, ['init', 'handle']);
  assert.deepEqual(result, { processed: true, botId: 5, updateId: 77 });
  assert.equal(calls.length, 2);
});

test('Telegram update handler leaves failed updates retryable', async () => {
  const calls = [];
  const pool = {
    async query(sql) {
      calls.push(sql);
      if (sql.includes('UPDATE bot_inbound_updates AS inbound')) {
        return { rowCount: 1, rows: [{ payload: { update_id: 78 }, id: 6, name: 'Fail bot' }] };
      }
      if (sql.includes("SET state = 'failed'")) return { rowCount: 1, rows: [] };
      throw new Error('unexpected SQL');
    }
  };
  const handler = createTelegramUpdateHandler({
    pool,
    decryptToken: () => 'test-token',
    botFactory: () => ({ async init() {}, async handleUpdate() { throw new Error('Telegram API unavailable'); } })
  });

  await assert.rejects(
    handler({ payload: { botId: 6, updateId: 78 } }),
    /Telegram API unavailable/
  );
  assert.ok(calls.some(sql => sql.includes("SET state = 'failed'")));
});


test('Telegram update handler reuses one initialized bot instance for subsequent updates', async () => {
  let initCalls = 0;
  let factoryCalls = 0;
  let handledUpdates = 0;
  const pool = {
    async query(sql) {
      if (sql.includes('UPDATE bot_inbound_updates AS inbound')) {
        return {
          rowCount: 1,
          rows: [{
            payload: { update_id: 90 + handledUpdates },
            id: 12,
            name: 'Reusable bot',
            token_ciphertext: 'encrypted'
          }]
        };
      }
      if (sql.includes("SET state = 'processed'")) return { rowCount: 1, rows: [] };
      throw new Error('unexpected SQL');
    }
  };
  const handler = createTelegramUpdateHandler({
    pool,
    decryptToken: () => 'stable-test-token',
    botFactory: () => {
      factoryCalls += 1;
      return {
        async init() { initCalls += 1; },
        async handleUpdate() { handledUpdates += 1; }
      };
    }
  });

  await handler({ payload: { botId: 12, updateId: 90 } });
  await handler({ payload: { botId: 12, updateId: 91 } });

  assert.equal(factoryCalls, 1);
  assert.equal(initCalls, 1);
  assert.equal(handledUpdates, 2);
});


test('Telegram update handler shares one in-flight initialization across concurrent updates', async () => {
  let factoryCalls = 0;
  let initCalls = 0;
  let handledUpdates = 0;
  let releaseInit;
  const initGate = new Promise(resolve => { releaseInit = resolve; });
  const pool = {
    async query(sql, params) {
      if (sql.includes('UPDATE bot_inbound_updates AS inbound')) {
        return {
          rowCount: 1,
          rows: [{
            payload: { update_id: params[1] },
            id: 21,
            name: 'Concurrent bot',
            token_ciphertext: 'encrypted'
          }]
        };
      }
      if (sql.includes("SET state = 'processed'")) return { rowCount: 1, rows: [] };
      throw new Error('unexpected SQL');
    }
  };
  const handler = createTelegramUpdateHandler({
    pool,
    decryptToken: () => 'concurrent-test-token',
    botFactory: () => {
      factoryCalls += 1;
      return {
        async init() { initCalls += 1; await initGate; },
        async handleUpdate() { handledUpdates += 1; }
      };
    }
  });

  const first = handler({ payload: { botId: 21, updateId: 101 } });
  const second = handler({ payload: { botId: 21, updateId: 102 } });
  await new Promise(resolve => setImmediate(resolve));
  releaseInit();
  await Promise.all([first, second]);

  assert.equal(factoryCalls, 1);
  assert.equal(initCalls, 1);
  assert.equal(handledUpdates, 2);
});

test('Telegram update handler evicts a bot whose initialization fails so a retry can recover', async () => {
  let factoryCalls = 0;
  let initCalls = 0;
  const pool = {
    async query(sql, params) {
      if (sql.includes('UPDATE bot_inbound_updates AS inbound')) {
        return {
          rowCount: 1,
          rows: [{
            payload: { update_id: params[1] },
            id: 22,
            name: 'Recovering bot',
            token_ciphertext: 'encrypted'
          }]
        };
      }
      if (sql.includes("SET state = 'failed'")) return { rowCount: 1, rows: [] };
      if (sql.includes("SET state = 'processed'")) return { rowCount: 1, rows: [] };
      throw new Error('unexpected SQL');
    }
  };
  const handler = createTelegramUpdateHandler({
    pool,
    decryptToken: () => 'recovering-test-token',
    botFactory: () => {
      factoryCalls += 1;
      const currentAttempt = factoryCalls;
      return {
        async init() {
          initCalls += 1;
          if (currentAttempt === 1) throw new Error('temporary getMe failure');
        },
        async handleUpdate() {}
      };
    }
  });

  await assert.rejects(
    handler({ payload: { botId: 22, updateId: 201 } }),
    /temporary getMe failure/
  );
  const recovered = await handler({ payload: { botId: 22, updateId: 202 } });

  assert.deepEqual(recovered, { processed: true, botId: 22, updateId: 202 });
  assert.equal(factoryCalls, 2);
  assert.equal(initCalls, 2);
});
