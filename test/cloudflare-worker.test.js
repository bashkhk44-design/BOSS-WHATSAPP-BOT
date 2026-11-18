'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = globalThis.crypto;
const {
  createWorkerHandler,
  deriveCustomerWebhookSecret,
  parseRoute
} = require('../cloudflare/worker.mjs');

const encryptionKey = 'ab'.repeat(32);
const platformSecrets = {
  MASTER_WEBHOOK_SECRET: 'M'.repeat(43),
  INTAKE_WEBHOOK_SECRET: 'I'.repeat(43)
};

function bytesToHex(bytes) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

function bytesToBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function encryptToken(token) {
  const keyBytes = Uint8Array.from(encryptionKey.match(/.{2}/g), part => Number.parseInt(part, 16));
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(token)
  ));
  const ciphertext = encrypted.slice(0, -16);
  const authTag = encrypted.slice(-16);
  return {
    token_ciphertext: bytesToBase64(ciphertext),
    token_iv: bytesToHex(iv),
    token_auth_tag: bytesToHex(authTag)
  };
}

function fakeClientFactory({ rows = [], rowCount = 0, calls = [] } = {}) {
  return class FakeClient {
    constructor(options) { this.options = options; }
    async connect() { calls.push(['connect']); }
    async query(sql, params) {
      calls.push(['query', sql, params]);
      if (sql.includes('FROM telegram_bots')) return { rows, rowCount };
      return { rows: [{ ok: 1 }], rowCount: 1 };
    }
    async end() { calls.push(['end']); }
  };
}

function makeRequest(path, { method = 'POST', secret, body = { update_id: 10 }, headers = {} } = {}) {
  const requestHeaders = { 'content-type': 'application/json', ...headers };
  if (secret) requestHeaders['x-telegram-bot-api-secret-token'] = secret;
  return new Request('https://worker.example' + path, {
    method,
    headers: requestHeaders,
    body: method === 'GET' ? undefined : JSON.stringify(body)
  });
}

test('Cloudflare Worker routes only known webhook identities and numeric customer IDs', () => {
  assert.deepEqual(parseRoute('/telegram/platform/master'), { kind: 'platform', identity: 'master' });
  assert.deepEqual(parseRoute('/telegram/platform/intake'), { kind: 'platform', identity: 'intake' });
  assert.deepEqual(parseRoute('/telegram/webhook/42'), { kind: 'customer', botId: 42 });
  assert.equal(parseRoute('/telegram/webhook/0'), null);
  assert.equal(parseRoute('/telegram/platform/customer'), null);
});

test('Cloudflare Worker health endpoints do not expose configuration', async () => {
  const handler = createWorkerHandler({ ClientCtor: fakeClientFactory() });
  const response = await handler(new Request('https://worker.example/healthz'), {});
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, service: 'boss-telegram-webhook' });
});

test('Cloudflare Worker authenticates master and intake independently before enqueue', async () => {
  const calls = [];
  const queueApi = {
    async enqueuePlatformBotUpdate(_client, args) {
      calls.push(args);
      return { duplicate: false };
    },
    async enqueueTelegramUpdate() { throw new Error('customer route must not be used'); }
  };
  const handler = createWorkerHandler({
    ClientCtor: fakeClientFactory({ calls }),
    queueApi,
    logger: { error() {} }
  });
  const env = { HYPERDRIVE: { connectionString: 'postgresql://staging' }, ...platformSecrets };

  for (const identity of ['master', 'intake']) {
    const secret = platformSecrets[identity === 'master' ? 'MASTER_WEBHOOK_SECRET' : 'INTAKE_WEBHOOK_SECRET'];
    const response = await handler(makeRequest('/telegram/platform/' + identity, { secret }), env);
    assert.equal(response.status, 200);
  }
  assert.deepEqual(calls.map(item => item.botIdentity), ['master', 'intake']);

  const wrong = await handler(makeRequest('/telegram/platform/intake', {
    secret: platformSecrets.MASTER_WEBHOOK_SECRET
  }), env);
  assert.equal(wrong.status, 401);
});

test('Cloudflare Worker decrypts customer tokens and preserves the existing derived webhook secret', async () => {
  const token = '123456:staging-customer-token';
  const encrypted = await encryptToken(token);
  const expectedSecret = await deriveCustomerWebhookSecret(42, token, encryptionKey, crypto);
  const calls = [];
  const queueApi = {
    async enqueueTelegramUpdate(_client, args) {
      calls.push(args);
      return { duplicate: false };
    },
    async enqueuePlatformBotUpdate() { throw new Error('platform route must not be used'); }
  };
  const handler = createWorkerHandler({
    ClientCtor: fakeClientFactory({ rows: [{ id: 42, ...encrypted }], rowCount: 1, calls }),
    queueApi,
    logger: { error() {} }
  });
  const env = {
    HYPERDRIVE: { connectionString: 'postgresql://staging' },
    BOTS_ENCRYPTION_KEY: encryptionKey
  };
  const response = await handler(makeRequest('/telegram/webhook/42', {
    secret: expectedSecret,
    body: { update_id: 91, message: { text: '/start' } }
  }), env);
  assert.equal(response.status, 200);
  assert.deepEqual(calls[0], { botId: 42, update: { update_id: 91, message: { text: '/start' } } });
});

test('Cloudflare Worker rejects oversized, malformed, and unauthenticated requests', async () => {
  const handler = createWorkerHandler({
    ClientCtor: fakeClientFactory(),
    queueApi: { enqueuePlatformBotUpdate: async () => { throw new Error('must not enqueue'); } },
    logger: { error() {} }
  });
  const env = { HYPERDRIVE: { connectionString: 'postgresql://staging' }, ...platformSecrets };
  const unauthorized = await handler(makeRequest('/telegram/platform/master'), env);
  assert.equal(unauthorized.status, 401);

  const badJson = new Request('https://worker.example/telegram/platform/master', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-telegram-bot-api-secret-token': platformSecrets.MASTER_WEBHOOK_SECRET
    },
    body: '{'
  });
  assert.equal((await handler(badJson, env)).status, 400);

  const oversized = new Request('https://worker.example/telegram/platform/master', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-telegram-bot-api-secret-token': platformSecrets.MASTER_WEBHOOK_SECRET,
      'content-length': String(1024 * 1024 + 1)
    },
    body: JSON.stringify({ update_id: 1 })
  });
  assert.equal((await handler(oversized, env)).status, 413);
});
