'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCustomerWebhookUpdateHandler } = require('../customer-webhook-update-handler');

test('customer update dispatcher routes only to the bot bound to the durable job', async () => {
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (/SELECT u\.id AS inbox_id/.test(sql)) {
        return { rowCount: 1, rows: [{
          inbox_id: 9, payload: { update_id: 101, message: { text: '/start' } },
          id: 12, name: 'Customer 12', username: 'customer12',
          token_ciphertext: 'cipher', token_iv: 'iv', token_auth_tag: 'tag'
        }] };
      }
      return { rowCount: 1, rows: [] };
    }
  };
  const handled = [];
  const handler = createCustomerWebhookUpdateHandler({
    pool,
    decryptToken: record => { assert.equal(record.id, 12); return 'test-token'; },
    createCustomerBot: (record, token, options) => {
      assert.equal(options.propagateErrors, true);
      return { async handleUpdate(update) { handled.push({ botId: record.id, token, update }); } };
    },
    logger: { error() {} }
  });

  const result = await handler({ bot_id: 12, payload: { botId: 12, updateId: 101 } });
  assert.deepEqual(result, { botId: 12, updateId: 101, processed: true });
  assert.equal(handled.length, 1);
  assert.equal(handled[0].botId, 12);
  assert.equal(handled[0].token, 'test-token');
  assert.equal(handled[0].update.update_id, 101);
  assert.match(calls[0].sql, /u\.bot_id = \$1 AND u\.update_id = \$2\s+AND b\.active = TRUE/);
  assert.match(calls[1].sql, /state = 'processing'/);
  assert.match(calls[2].sql, /state = 'processed'/);
});

test('customer update dispatcher rejects mismatched bot identities before database access', async () => {
  const handler = createCustomerWebhookUpdateHandler({
    pool: { async query() { assert.fail('mismatched job must not access database'); } },
    decryptToken() { assert.fail('must not decrypt another bot token'); },
    createCustomerBot() { assert.fail('must not create another bot'); }
  });
  await assert.rejects(
    handler({ bot_id: 12, payload: { botId: 13, updateId: 101 } }),
    /identity is invalid/
  );
});

test('customer update dispatcher records failed delivery and rethrows for queue retry', async () => {
  const updates = [];
  const pool = {
    async query(sql) {
      updates.push(sql);
      if (/SELECT u\.id AS inbox_id/.test(sql)) return { rowCount: 1, rows: [{
        inbox_id: 10, payload: { update_id: 202 }, id: 14, name: 'Customer 14',
        token_ciphertext: 'cipher', token_iv: 'iv', token_auth_tag: 'tag'
      }] };
      return { rowCount: 1, rows: [] };
    }
  };
  const handler = createCustomerWebhookUpdateHandler({
    pool,
    decryptToken: () => 'token',
    createCustomerBot: () => ({ async handleUpdate() { throw new Error('Telegram unavailable'); } }),
    logger: { error() {} }
  });
  await assert.rejects(
    handler({ bot_id: 14, payload: { botId: 14, updateId: 202 } }),
    /Telegram unavailable/
  );
  assert.match(updates[2], /state = 'failed'/);
});

test('customer update dispatcher does not run a Telegram update already marked processed', async () => {
  let calls = 0;
  const handler = createCustomerWebhookUpdateHandler({
    pool: {
      async query(sql) {
        calls += 1;
        if (/SELECT u\.id AS inbox_id/.test(sql)) {
          return { rowCount: 1, rows: [{
            inbox_id: 22, payload: { update_id: 303 }, id: 15, name: 'Customer 15',
            username: 'customer15', token_ciphertext: 'cipher', token_iv: 'iv', token_auth_tag: 'tag'
          }] };
        }
        if (/UPDATE bot_inbound_updates/.test(sql)) return { rowCount: 0, rows: [] };
        if (/SELECT state FROM bot_inbound_updates/.test(sql)) {
          return { rowCount: 1, rows: [{ state: 'processed' }] };
        }
        assert.fail('unexpected database query');
      }
    },
    decryptToken() { assert.fail('processed updates must not decrypt tokens'); },
    createCustomerBot() { assert.fail('processed updates must not be dispatched'); }
  });
  const result = await handler({ bot_id: 15, payload: { botId: 15, updateId: 303 } });
  assert.deepEqual(result, { botId: 15, updateId: 303, processed: true, duplicate: true });
  assert.equal(calls, 3);
});

test('customer update dispatcher renews its inbox lease while processing', async () => {
  let querySeen = '';
  const handler = createCustomerWebhookUpdateHandler({
    pool: { async query(sql, params) {
      querySeen = sql;
      assert.deepEqual(params, [21, 404]);
      return { rowCount: 1, rows: [{ renewed: true }] };
    } },
    decryptToken() { return 'unused'; },
    createCustomerBot() { return { async handleUpdate() {} }; }
  });
  const renewed = await handler.renewLease({
    bot_id: 21, payload: { botId: 21, updateId: 404 }
  });
  assert.equal(renewed, true);
  assert.match(querySeen, /SET locked_at = NOW\(\)/);
  assert.match(querySeen, /state = 'processing'/);
});
