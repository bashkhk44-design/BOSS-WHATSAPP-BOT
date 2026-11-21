'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const workerSource = fs.readFileSync(path.join(__dirname, '..', 'cloudflare', 'worker.mjs'), 'utf8');
const queueSource = fs.readFileSync(path.join(__dirname, '..', 'platform-queue.js'), 'utf8');

const env = {
  PLATFORM_BOT_WEBHOOK_MODE: 'enabled',
  PLATFORM_WORKER_WAKE_URL: 'https://staging-render.example.invalid/readyz',
  MASTER_WEBHOOK_SECRET: 'master_edge_secret_abcdefghijklmnopqrstuvwxyz123456',
  INTAKE_WEBHOOK_SECRET: 'intake_edge_secret_abcdefghijklmnopqrstuvwxyz123456',
  TELEGRAM_BOT_TOKEN: 'master-telegram-token-' + 'm'.repeat(40),
  INTAKE_BOT_TOKEN: 'intake-telegram-token-' + 'i'.repeat(40),
  HYPERDRIVE: { connectionString: 'postgresql://staging-user:staging-password@staging.example.invalid/staging' }
};

function makeRequest(pathname, {
  method = 'POST',
  secret = env.MASTER_WEBHOOK_SECRET,
  body = JSON.stringify({ update_id: 77, message: { text: '/start' } }),
  contentType = 'application/json',
  contentEncoding = null
} = {}) {
  return new Request('https://edge.example.invalid' + pathname, {
    method,
    headers: {
      'content-type': contentType,
      'x-telegram-bot-api-secret-token': secret,
      ...(contentEncoding ? { 'content-encoding': contentEncoding } : {})
    },
    body: method === 'GET' ? undefined : body
  });
}

function makeClientClass({ duplicate = false, failQuery = false } = {}) {
  const state = { constructed: 0, connected: 0, ended: 0, queries: [] };
  class FakeClient {
    constructor(config) {
      state.constructed += 1;
      state.config = config;
    }
    async connect() { state.connected += 1; }
    async query(sql, params) {
      state.queries.push({ sql, params });
      if (failQuery) throw new Error('database unavailable');
      if (/^\s*(BEGIN|COMMIT|ROLLBACK)\s*$/i.test(sql)) return { rowCount: 0, rows: [] };
      if (/^\s*SELECT\s+1\s+AS\s+probe/i.test(sql)) {
        return { rowCount: 1, rows: [{ probe: 1 }] };
      }
      if (sql.includes('INSERT INTO platform_bot_inbound_updates')) {
        return duplicate
          ? { rowCount: 0, rows: [] }
          : { rowCount: 1, rows: [{ id: 10 }] };
      }
      if (sql.includes('INSERT INTO platform_jobs')) {
        return { rowCount: 1, rows: [{ id: 20 }] };
      }
      throw new Error('unexpected SQL: ' + sql);
    }
    async end() { state.ended += 1; }
  }
  return { FakeClient, state };
}

test('Cloudflare Worker authenticates platform identities and atomically enqueues with one short-lived Hyperdrive client', async () => {
  const { createPlatformWebhookHandler } = await import('../cloudflare/worker.mjs');
  const { FakeClient, state } = makeClientClass();
  const handler = createPlatformWebhookHandler({ ClientClass: FakeClient, fetchImpl: async () => new Response('ok', { status: 200 }) });

  const master = await handler(makeRequest('/telegram/platform/master'), env);
  assert.equal(master.status, 200);
  assert.deepEqual(await master.json(), { ok: true, duplicate: false, queued: true, workerReady: true });
  assert.equal(state.constructed, 1);
  assert.equal(state.connected, 1);
  assert.equal(state.ended, 1);
  assert.equal(state.config.connectionString, env.HYPERDRIVE.connectionString);
  assert.equal(state.config.connectionTimeoutMillis, 5000);
  assert.equal(state.config.query_timeout, 10000);
  assert.equal(state.config.statement_timeout, 10000);
  assert.equal(state.queries[0].sql, 'BEGIN');
  assert.equal(state.queries[1].params[0], 'master');
  assert.match(state.queries[1].sql, /platform_bot_inbound_updates/);
  assert.match(state.queries[2].sql, /INSERT INTO platform_jobs/);
  assert.equal(state.queries[3].sql, 'COMMIT');

  const intake = await handler(makeRequest('/telegram/platform/intake', {
    secret: env.INTAKE_WEBHOOK_SECRET,
    body: JSON.stringify({ update_id: 78 })
  }), env);
  assert.equal(intake.status, 200);
  assert.equal(state.queries[5].params[0], 'intake');
  assert.equal(state.queries[4].sql, 'BEGIN');
  assert.equal(state.queries[7].sql, 'COMMIT');
  assert.equal(state.constructed, 2);
  assert.equal(state.ended, 2);
});

test('Cloudflare Worker rejects cross-identity secrets without opening a database client', async () => {
  const { createPlatformWebhookHandler } = await import('../cloudflare/worker.mjs');
  const { FakeClient, state } = makeClientClass();
  const handler = createPlatformWebhookHandler({ ClientClass: FakeClient, fetchImpl: async () => new Response('ok', { status: 200 }) });

  const response = await handler(makeRequest('/telegram/platform/master', {
    secret: env.INTAKE_WEBHOOK_SECRET
  }), env);
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { ok: false, error: 'unauthorized' });
  assert.equal(state.constructed, 0);
});

test('Cloudflare Worker validates route, mode, method, and content type before database access', async () => {
  const { createPlatformWebhookHandler } = await import('../cloudflare/worker.mjs');
  const { FakeClient, state } = makeClientClass();
  const handler = createPlatformWebhookHandler({ ClientClass: FakeClient, fetchImpl: async () => new Response('ok', { status: 200 }) });

  assert.equal((await handler(makeRequest('/telegram/platform/customer'), env)).status, 404);
  assert.equal((await handler(makeRequest('/telegram/platform/master', { method: 'GET' }), env)).status, 405);
  assert.equal((await handler(makeRequest('/telegram/platform/master', { contentType: 'text/plain' }), env)).status, 415);
  assert.equal((await handler(makeRequest('/telegram/platform/master', { contentEncoding: 'gzip' }), env)).status, 415);
  assert.equal((await handler(makeRequest('/telegram/platform/master'), {
    ...env,
    PLATFORM_BOT_WEBHOOK_MODE: 'disabled'
  })).status, 404);
  assert.equal(state.constructed, 0);
});

test('Cloudflare Worker rejects malformed JSON, invalid update IDs, and oversized bodies', async () => {
  const { createPlatformWebhookHandler } = await import('../cloudflare/worker.mjs');
  const { FakeClient, state } = makeClientClass();
  const handler = createPlatformWebhookHandler({ ClientClass: FakeClient, maxBodyBytes: 1024 });

  const invalidJson = await handler(makeRequest('/telegram/platform/master', { body: '{broken' }), env);
  assert.equal(invalidJson.status, 400);
  const invalidUpdate = await handler(makeRequest('/telegram/platform/master', {
    body: JSON.stringify({ update_id: '77' })
  }), env);
  assert.equal(invalidUpdate.status, 400);
  const tooLarge = await handler(makeRequest('/telegram/platform/master', {
    body: JSON.stringify({ update_id: 77, text: 'x'.repeat(2048) })
  }), env);
  assert.equal(tooLarge.status, 413);
  assert.equal(state.constructed, 0);
});

test('Cloudflare Worker fails closed when the Hyperdrive binding is missing', async () => {
  const { createPlatformWebhookHandler } = await import('../cloudflare/worker.mjs');
  const { FakeClient, state } = makeClientClass();
  const handler = createPlatformWebhookHandler({ ClientClass: FakeClient, fetchImpl: async () => new Response('ok', { status: 200 }) });

  const response = await handler(makeRequest('/telegram/platform/master'), {
    ...env,
    HYPERDRIVE: undefined
  });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, error: 'temporarily_unavailable' });
  assert.equal(state.constructed, 0);
});

test('Cloudflare Worker acknowledges duplicate delivery and always closes the Hyperdrive client', async () => {
  const { createPlatformWebhookHandler } = await import('../cloudflare/worker.mjs');
  const { FakeClient, state } = makeClientClass({ duplicate: true });
  const handler = createPlatformWebhookHandler({ ClientClass: FakeClient, fetchImpl: async () => new Response('ok', { status: 200 }) });

  const response = await handler(makeRequest('/telegram/platform/master'), env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, duplicate: true, queued: false, workerReady: true });
  assert.equal(state.ended, 1);
});

test('Cloudflare Worker returns generic database errors and closes failed clients', async () => {
  const { createPlatformWebhookHandler } = await import('../cloudflare/worker.mjs');
  const { FakeClient, state } = makeClientClass({ failQuery: true });
  const handler = createPlatformWebhookHandler({ ClientClass: FakeClient, fetchImpl: async () => new Response('ok', { status: 200 }) });
  const response = await handler(makeRequest('/telegram/platform/master'), env);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, error: 'temporarily_unavailable' });
  assert.equal(state.ended, 1);
});

test('Cloudflare Worker health check verifies PostgreSQL through Hyperdrive and closes the client', async () => {
  const { createPlatformWebhookHandler } = await import('../cloudflare/worker.mjs');
  const { FakeClient, state } = makeClientClass();
  const handler = createPlatformWebhookHandler({ ClientClass: FakeClient, fetchImpl: async () => new Response('ok', { status: 200 }) });
  const response = await handler(new Request('https://edge.example.invalid/healthz'), env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    service: 'platform-telegram-webhook-edge',
    database: 'reachable'
  });
  assert.equal(state.constructed, 1);
  assert.equal(state.connected, 1);
  assert.equal(state.ended, 1);
  assert.equal(state.queries.length, 1);
  assert.match(state.queries[0].sql, /SELECT 1 AS probe/);
});

test('Cloudflare Worker source boundary excludes Node hosts, bot runtimes, and pg pools', () => {
  for (const forbidden of [
    'node:http',
    './db',
    'telegram-master',
    'intake-bot',
    'worker.js',
    'new Pool',
    'process.env'
  ]) {
    assert.equal(workerSource.includes(forbidden), false, 'Worker source must not include ' + forbidden);
  }
  assert.equal(queueSource.includes('require('), false, 'the shared queue module must remain import-safe for Workers');
  assert.match(workerSource, /import \{ Client \} from 'pg'/);
  assert.match(workerSource, /HYPERDRIVE\?\.connectionString/);
});


test('Cloudflare configuration keeps Hyperdrive and Worker compatibility staging-only', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const stagingConfig = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'cloudflare', 'wrangler.staging.example.jsonc'), 'utf8'
  ));
  const bundleConfig = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'cloudflare', 'wrangler.bundle-test.jsonc'), 'utf8'
  ));

  const pgVersion = String(packageJson.dependencies.pg || '').replace(/^[^0-9]*/, '');
  const [major, minor, patch] = pgVersion.split('.').map(Number);
  assert.ok(
    major > 8 || (major === 8 && (minor > 16 || (minor === 16 && patch >= 3))),
    'pg must meet Hyperdrive minimum 8.16.3'
  );
  assert.ok(stagingConfig.compatibility_flags.includes('nodejs_compat'));
  assert.equal(stagingConfig.workers_dev, false);
  assert.equal(stagingConfig.hyperdrive[0].binding, 'HYPERDRIVE');
  assert.equal(stagingConfig.vars.PLATFORM_BOT_WEBHOOK_MODE, 'disabled');
  assert.equal(
    stagingConfig.hyperdrive[0].id,
    'REPLACE_WITH_VERIFIED_STAGING_HYPERDRIVE_ID',
    'a real Hyperdrive ID must not be committed in the example config'
  );
  assert.ok(bundleConfig.compatibility_flags.includes('nodejs_compat'));
  assert.equal(bundleConfig.vars.PLATFORM_BOT_WEBHOOK_MODE, 'disabled');
  assert.equal(bundleConfig.hyperdrive, undefined, 'bundle test must not connect to a database');
  assert.equal('MASTER_WEBHOOK_SECRET' in stagingConfig.vars, false);
  assert.equal('INTAKE_WEBHOOK_SECRET' in stagingConfig.vars, false);
});

test('Cloudflare Worker rejects reuse of either platform webhook secret as either bot token', async () => {
  const { createPlatformWebhookHandler } = await import('../cloudflare/worker.mjs');
  const { FakeClient, state } = makeClientClass();
  const handler = createPlatformWebhookHandler({ ClientClass: FakeClient, fetchImpl: async () => new Response('ok', { status: 200 }) });

  const cases = [
    ['MASTER_WEBHOOK_SECRET', 'TELEGRAM_BOT_TOKEN'],
    ['MASTER_WEBHOOK_SECRET', 'INTAKE_BOT_TOKEN'],
    ['INTAKE_WEBHOOK_SECRET', 'TELEGRAM_BOT_TOKEN'],
    ['INTAKE_WEBHOOK_SECRET', 'INTAKE_BOT_TOKEN']
  ];

  for (const [secretName, tokenName] of cases) {
    const invalidEnv = {
      ...env,
      [secretName]: env[tokenName]
    };
    const identity = secretName === 'MASTER_WEBHOOK_SECRET' ? 'master' : 'intake';
    const response = await handler(makeRequest('/telegram/platform/' + identity, {
      secret: invalidEnv[secretName]
    }), invalidEnv);
    assert.equal(response.status, 401, secretName + ' must not reuse ' + tokenName);
  }
  assert.equal(state.constructed, 0);
});

test('Cloudflare Worker refuses to acknowledge updates unless the Render worker is ready', async () => {
  const { createPlatformWebhookHandler } = await import('../cloudflare/worker.mjs');
  const { FakeClient, state } = makeClientClass();
  const handler = createPlatformWebhookHandler({
    ClientClass: FakeClient,
    fetchImpl: async () => new Response('not ready', { status: 503 })
  });
  const response = await handler(makeRequest('/telegram/platform/master'), env);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, error: 'worker_not_ready' });
  assert.equal(state.queries.at(-1).sql, 'COMMIT', 'the durable queue insert must commit before wake confirmation');
});

test('Cloudflare Worker rejects missing or unsafe Render readiness URLs before enqueue', async () => {
  const { createPlatformWebhookHandler } = await import('../cloudflare/worker.mjs');
  const { FakeClient, state } = makeClientClass();
  const handler = createPlatformWebhookHandler({
    ClientClass: FakeClient,
    fetchImpl: async () => new Response('ok')
  });
  for (const value of [undefined, 'http://example.com/readyz', 'https://example.com/other', 'https://user:pass@example.com/readyz']) {
    const response = await handler(makeRequest('/telegram/platform/master'), {
      ...env,
      PLATFORM_WORKER_WAKE_URL: value
    });
    assert.equal(response.status, 503);
  }
  assert.equal(state.constructed, 0);
});


test('Cloudflare retry after a failed Render wake reuses the committed inbox update without creating a duplicate job', async () => {
  const { createPlatformWebhookHandler } = await import('../cloudflare/worker.mjs');
  const { enqueuePlatformBotUpdate } = require('../platform-queue');
  const database = { updates: new Set(), jobs: new Set(), clients: 0, ended: 0 };
  class PersistentFakeClient {
    constructor() { database.clients += 1; }
    async connect() {}
    async query(sql, params) {
      if (/^\s*(BEGIN|COMMIT|ROLLBACK)\s*$/i.test(sql)) return { rowCount: 0, rows: [] };
      if (sql.includes('INSERT INTO platform_bot_inbound_updates')) {
        const key = params[0] + ':' + params[1];
        if (database.updates.has(key)) return { rowCount: 0, rows: [] };
        database.updates.add(key);
        return { rowCount: 1, rows: [{ id: database.updates.size }] };
      }
      if (sql.includes('INSERT INTO platform_jobs')) {
        const key = params[0] + ':' + params[1];
        if (database.jobs.has(key)) return { rowCount: 0, rows: [] };
        database.jobs.add(key);
        return { rowCount: 1, rows: [{ id: database.jobs.size }] };
      }
      throw new Error('unexpected SQL: ' + sql);
    }
    async end() { database.ended += 1; }
  }

  let wakeAttempts = 0;
  const handler = createPlatformWebhookHandler({
    ClientClass: PersistentFakeClient,
    enqueue: enqueuePlatformBotUpdate,
    fetchImpl: async () => {
      wakeAttempts += 1;
      return wakeAttempts === 1
        ? new Response('service waking', { status: 503 })
        : new Response('ready', { status: 200 });
    }
  });
  const request = () => makeRequest('/telegram/platform/master', {
    body: JSON.stringify({ update_id: 99001, message: { text: '/start' } })
  });

  const first = await handler(request(), env);
  assert.equal(first.status, 503);
  assert.deepEqual(await first.json(), { ok: false, error: 'worker_not_ready' });
  assert.deepEqual([...database.updates], ['master:99001']);
  assert.deepEqual([...database.jobs], ['telegram.master.update:99001']);

  const retry = await handler(request(), env);
  assert.equal(retry.status, 200);
  assert.deepEqual(await retry.json(), {
    ok: true, duplicate: true, queued: false, workerReady: true
  });
  assert.equal(wakeAttempts, 2);
  assert.equal(database.updates.size, 1, 'Telegram retry must not create a second inbox row');
  assert.equal(database.jobs.size, 1, 'Telegram retry must not create a second queue job');
  assert.equal(database.clients, 2);
  assert.equal(database.ended, 2);
});
