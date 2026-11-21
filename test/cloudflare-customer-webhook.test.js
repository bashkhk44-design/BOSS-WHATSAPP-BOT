'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('Cloudflare customer webhook authenticates per bot and enqueues only for an active bot', async () => {
  const { createPlatformWebhookHandler, deriveCustomerWebhookSecret } = await import('../cloudflare/worker.mjs');
  const root = 'customer-root-secret-which-is-long-enough-for-staging';
  const secret12 = await deriveCustomerWebhookSecret(root, '12');
  const secret13 = await deriveCustomerWebhookSecret(root, '13');
  assert.notEqual(secret12, secret13);

  const queries = [];
  class FakeClient {
    constructor() {}
    async connect() {}
    async query(sql, params) {
      queries.push({ sql, params });
      return { rowCount: 1, rows: [{ id: 12 }] };
    }
    async end() {}
  }
  const enqueued = [];
  const handler = createPlatformWebhookHandler({
    ClientClass: FakeClient,
    enqueueCustomer: async (client, args) => {
      enqueued.push(args);
      return { duplicate: false };
    }
  });
  const env = {
    CUSTOMER_BOT_WEBHOOK_MODE: 'enabled',
    CUSTOMER_WEBHOOK_SECRET: root,
    HYPERDRIVE: { connectionString: 'postgresql://test:test@example.invalid/staging' }
  };
  const request = (botId, token) => new Request('https://edge.invalid/telegram/customer/' + botId, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-telegram-bot-api-secret-token': token
    },
    body: JSON.stringify({ update_id: 55, message: { text: '/start' } })
  });

  const accepted = await handler(request(12, secret12), env);
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), { ok: true, duplicate: false, queued: true });
  assert.deepEqual(enqueued, [{ botId: 12, update: { update_id: 55, message: { text: '/start' } } }]);
  assert.match(queries[0].sql, /telegram_bots WHERE id = \$1 AND active = TRUE/);

  const crossed = await handler(request(12, secret13), env);
  assert.equal(crossed.status, 401);
  assert.equal(enqueued.length, 1);
});

test('Cloudflare customer webhook is disabled by default and rejects unknown bot IDs', async () => {
  const { createPlatformWebhookHandler, deriveCustomerWebhookSecret } = await import('../cloudflare/worker.mjs');
  const root = 'customer-root-secret-which-is-long-enough-for-staging';
  const secret = await deriveCustomerWebhookSecret(root, '404');
  class FakeClient {
    async connect() {}
    async query() { return { rowCount: 0, rows: [] }; }
    async end() {}
  }
  const handler = createPlatformWebhookHandler({
    ClientClass: FakeClient,
    enqueueCustomer: async () => { assert.fail('unknown bot must not enqueue'); }
  });
  const request = new Request('https://edge.invalid/telegram/customer/404', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret },
    body: JSON.stringify({ update_id: 1 })
  });
  const disabled = await handler(request, { CUSTOMER_BOT_WEBHOOK_MODE: 'disabled' });
  assert.equal(disabled.status, 404);
  const unknown = await handler(request, {
    CUSTOMER_BOT_WEBHOOK_MODE: 'enabled',
    CUSTOMER_WEBHOOK_SECRET: root,
    HYPERDRIVE: { connectionString: 'postgresql://test:test@example.invalid/staging' }
  });
  assert.equal(unknown.status, 404);
  assert.deepEqual(await unknown.json(), { ok: false, error: 'bot_not_found' });
});
