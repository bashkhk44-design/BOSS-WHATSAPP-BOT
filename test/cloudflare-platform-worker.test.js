'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const workerSource = fs.readFileSync(path.join(__dirname, '..', 'cloudflare', 'worker.mjs'), 'utf8');
const queueSource = fs.readFileSync(path.join(__dirname, '..', 'platform-queue.js'), 'utf8');

const env = {
  PLATFORM_BOT_WEBHOOK_MODE: 'enabled',
  MASTER_WEBHOOK_SECRET: 'master_edge_secret_abcdefghijklmnopqrstuvwxyz123456',
  INTAKE_WEBHOOK_SECRET: 'intake_edge_secret_abcdefghijklmnopqrstuvwxyz123456',
  TELEGRAM_BOT_TOKEN: 'master-telegram-token-' + 'm'.repeat(40),
  INTAKE_BOT_TOKEN: 'intake-telegram-token-' + 'i'.repeat(40),
  HYPERDRIVE: { connectionString: 'postgresql://staging-user:staging-password@staging.example.invalid/staging' },
  DB_CHECK_SECRET: 'staging_db_check_secret_abcdefghijklmnopqrstuvwxyz123456'
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
      if (sql === 'SELECT 1 AS db_check') return { rowCount: 1, rows: [{ db_check: 1 }] };
      return duplicate
        ? { rowCount: 0, rows: [] }
        : { rowCount: 1, rows: [{ id: 10, job_id: 20 }] };
    }
    async end() { state.ended += 1; }
  }
  return { FakeClient, state };
}

test('Cloudflare Worker authenticates platform identities and atomically enqueues with one short-lived Hyperdrive client', async () => {
  const { createPlatformWebhookHandler } = await import('../cloudflare/worker.mjs');
  const { FakeClient, state } = makeClientClass();
  const handler = createPlatformWebhookHandler({ ClientClass: FakeClient });

  const master = await handler(makeRequest('/telegram/platform/master'), env);
  assert.equal(master.status, 200);
  assert.deepEqual(await master.json(), { ok: true, duplicate: false, queued: true });
  assert.equal(state.constructed, 1);
  assert.equal(state.connected, 1);
  assert.equal(state.ended, 1);
  assert.equal(state.config.connectionString, env.HYPERDRIVE.connectionString);
  assert.equal(state.config.connectionTimeoutMillis, 5000);
  assert.equal(state.config.query_timeout, 10000);
  assert.equal(state.config.statement_timeout, 10000);
  assert.equal(state.queries[0].params[0], 'master');
  assert.match(state.queries[0].sql, /platform_bot_inbound_updates/);
  assert.match(state.queries[0].sql, /INSERT INTO platform_jobs/);

  const intake = await handler(makeRequest('/telegram/platform/intake', {
    secret: env.INTAKE_WEBHOOK_SECRET,
    body: JSON.stringify({ update_id: 78 })
  }), env);
  assert.equal(intake.status, 200);
  assert.equal(state.queries[1].params[0], 'intake');
  assert.equal(state.constructed, 2);
  assert.equal(state.ended, 2);
});

test('Cloudflare Worker rejects cross-identity secrets without opening a database client', async () => {
  const { createPlatformWebhookHandler } = await import('../cloudflare/worker.mjs');
  const { FakeClient, state } = makeClientClass();
  const handler = createPlatformWebhookHandler({ ClientClass: FakeClient });

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
  const handler = createPlatformWebhookHandler({ ClientClass: FakeClient });

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
  const handler = createPlatformWebhookHandler({ ClientClass: FakeClient });

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
  const handler = createPlatformWebhookHandler({ ClientClass: FakeClient });

  const response = await handler(makeRequest('/telegram/platform/master'), env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, duplicate: true, queued: false });
  assert.equal(state.ended, 1);
});

test('Cloudflare Worker returns generic database errors and closes failed clients', async () => {
  const { createPlatformWebhookHandler } = await import('../cloudflare/worker.mjs');
  const { FakeClient, state } = makeClientClass({ failQuery: true });
  const handler = createPlatformWebhookHandler({ ClientClass: FakeClient });
  const response = await handler(makeRequest('/telegram/platform/master'), env);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, error: 'temporarily_unavailable' });
  assert.equal(state.ended, 1);
});

test('Cloudflare Worker DB check authenticates and runs a read-only SELECT 1 probe', async () => {
  const { createPlatformWebhookHandler } = await import('../cloudflare/worker.mjs');
  const { FakeClient, state } = makeClientClass();
  const handler = createPlatformWebhookHandler({ ClientClass: FakeClient });
  const request = new Request('https://edge.example.invalid/db-check', {
    method: 'GET',
    headers: { 'x-boss-db-check-token': env.DB_CHECK_SECRET }
  });
  const response = await handler(request, env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, database: 'connected', probe: 1 });
  assert.equal(state.constructed, 1);
  assert.equal(state.connected, 1);
  assert.equal(state.ended, 1);
  assert.deepEqual(state.queries, [{ sql: 'SELECT 1 AS db_check', params: undefined }]);
  assert.equal(state.config.connectionString, env.HYPERDRIVE.connectionString);
});

test('Cloudflare Worker table counts endpoint authenticates and runs only the fixed read-only count query', async () => {
  const { createPlatformWebhookHandler } = await import('../cloudflare/worker.mjs');
  const state = { constructed: 0, connected: 0, ended: 0, queries: [] };
  class FakeClient {
    constructor(config) { state.constructed += 1; state.config = config; }
    async connect() { state.connected += 1; }
    async query(sql) {
      state.queries.push(sql);
      return { rows: [
        { table_name: 'client_projects', rows_count: '2' },
        { table_name: 'clients', rows_count: '1' },
        { table_name: 'project_ai_jobs', rows_count: '3' },
        { table_name: 'project_events', rows_count: '4' },
        { table_name: 'telegram_bots', rows_count: '2' }
      ] };
    }
    async end() { state.ended += 1; }
  }
  const handler = createPlatformWebhookHandler({ ClientClass: FakeClient });
  const request = new Request('https://edge.example.invalid/db-table-counts', {
    method: 'GET',
    headers: { 'x-boss-db-check-token': env.DB_CHECK_SECRET }
  });
  const response = await handler(request, env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    database: 'connected',
    counts: [
      { table_name: 'client_projects', rows_count: '2' },
      { table_name: 'clients', rows_count: '1' },
      { table_name: 'project_ai_jobs', rows_count: '3' },
      { table_name: 'project_events', rows_count: '4' },
      { table_name: 'telegram_bots', rows_count: '2' }
    ]
  });
  assert.equal(state.constructed, 1);
  assert.equal(state.connected, 1);
  assert.equal(state.ended, 1);
  assert.match(state.queries[0], /COUNT\(\*\).*FROM clients/s);
  for (const table of ['client_projects', 'telegram_bots', 'project_ai_jobs', 'project_events']) {
    assert.ok(state.queries[0].includes(table));
  }
  assert.doesNotMatch(state.queries[0], /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE)\b/i);
});

test('Cloudflare Worker DB check rejects missing or wrong secrets without opening a client', async () => {
  const { createPlatformWebhookHandler } = await import('../cloudflare/worker.mjs');
  const { FakeClient, state } = makeClientClass();
  const handler = createPlatformWebhookHandler({ ClientClass: FakeClient });
  const response = await handler(new Request('https://edge.example.invalid/db-check', {
    method: 'GET',
    headers: { 'x-boss-db-check-token': 'wrong-secret' }
  }), env);
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { ok: false, error: 'unauthorized' });
  assert.equal(state.constructed, 0);
});

test('Cloudflare Worker DB check fails closed and closes the client on database errors', async () => {
  const { createPlatformWebhookHandler } = await import('../cloudflare/worker.mjs');
  const { FakeClient, state } = makeClientClass({ failQuery: true });
  const handler = createPlatformWebhookHandler({ ClientClass: FakeClient });
  const response = await handler(new Request('https://edge.example.invalid/db-check', {
    method: 'GET',
    headers: { 'x-boss-db-check-token': env.DB_CHECK_SECRET }
  }), env);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, error: 'temporarily_unavailable' });
  assert.equal(state.ended, 1);
});

test('Cloudflare Worker health check does not open Hyperdrive connections', async () => {
  const { createPlatformWebhookHandler } = await import('../cloudflare/worker.mjs');
  const { FakeClient, state } = makeClientClass();
  const handler = createPlatformWebhookHandler({ ClientClass: FakeClient });
  const response = await handler(new Request('https://edge.example.invalid/healthz'), env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, service: 'platform-telegram-webhook-edge' });
  assert.equal(state.constructed, 0);
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
  const handler = createPlatformWebhookHandler({ ClientClass: FakeClient });

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
