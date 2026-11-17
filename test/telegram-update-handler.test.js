'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTelegramUpdateHandler } = require('../telegram-update-handler');

test('Telegram update handler claims, dispatches, and marks an update processed', async () => {
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('UPDATE bot_inbound_updates AS update')) {
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
  const handler = createTelegramUpdateHandler({
    pool,
    decryptToken: record => record.token_ciphertext === 'encrypted' ? 'test-token' : '',
    botFactory: (record, token) => ({
      async handleUpdate(update) {
        assert.equal(record.name, 'Test bot');
        assert.equal(token, 'test-token');
        assert.equal(update.update_id, 77);
        handled = true;
      }
    })
  });

  const result = await handler({ payload: { botId: 5, updateId: 77 } });
  assert.equal(handled, true);
  assert.deepEqual(result, { processed: true, botId: 5, updateId: 77 });
  assert.equal(calls.length, 2);
});

test('Telegram update handler leaves failed updates retryable', async () => {
  const calls = [];
  const pool = {
    async query(sql) {
      calls.push(sql);
      if (sql.includes('UPDATE bot_inbound_updates AS update')) {
        return { rowCount: 1, rows: [{ payload: { update_id: 78 }, id: 6, name: 'Fail bot' }] };
      }
      if (sql.includes("SET state = 'failed'")) return { rowCount: 1, rows: [] };
      throw new Error('unexpected SQL');
    }
  };
  const handler = createTelegramUpdateHandler({
    pool,
    decryptToken: () => 'test-token',
    botFactory: () => ({ async handleUpdate() { throw new Error('Telegram API unavailable'); } })
  });

  await assert.rejects(
    handler({ payload: { botId: 6, updateId: 78 } }),
    /Telegram API unavailable/
  );
  assert.ok(calls.some(sql => sql.includes("SET state = 'failed'")));
});
