'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { enqueueTelegramUpdate } = require('../platform-queue');
const { createQueueWorker } = require('../queue-worker');
const queue = require('../platform-queue');
const { createCustomerWebhookUpdateHandler } = require('../customer-webhook-update-handler');

test('customer webhook update is durably queued, deduplicated, and dispatched to its own bot', { skip: !process.env.DATABASE_URL }, async (t) => {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'disable' ? false : { rejectUnauthorized: false },
    max: 3
  });
  let botId = null;
  t.after(async () => {
    if (botId !== null) {
      await pool.query('DELETE FROM platform_jobs WHERE bot_id = $1', [botId]);
      await pool.query('DELETE FROM telegram_bots WHERE id = $1', [botId]);
    }
    await pool.end();
  });

  const inserted = await pool.query(`
    INSERT INTO telegram_bots
      (name, username, active, token_ciphertext, token_iv, token_auth_tag, transport_mode)
    VALUES ('webhook integration fixture', 'webhook_fixture_bot', TRUE,
            'fixture-cipher', 'fixture-iv', 'fixture-tag', 'webhook')
    RETURNING id
  `);
  botId = Number(inserted.rows[0].id);
  const updateId = Date.now();
  const update = { update_id: updateId, message: { text: '/start' } };

  const first = await enqueueTelegramUpdate(pool, { botId, update });
  const duplicate = await enqueueTelegramUpdate(pool, { botId, update });
  assert.equal(first.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  assert.ok(first.jobId, 'the accepted update must have a durable queue job');

  const delivered = [];
  const handler = createCustomerWebhookUpdateHandler({
    pool,
    decryptToken(record) {
      assert.equal(Number(record.id), botId);
      return 'fixture-token';
    },
    createCustomerBot(record, token) {
      assert.equal(Number(record.id), botId);
      assert.equal(token, 'fixture-token');
      return { async handleUpdate(value) { delivered.push(value); } };
    },
    logger: { error() {} }
  });
  // Claim only the exact fixture job: the disposable database may contain
  // unrelated telegram.update rows created by other integration fixtures.
  const queueApi = {
    ...queue,
    async claimPlatformJob(database, workerId, jobTypes) {
      const result = await database.query(`
        UPDATE platform_jobs
        SET status = 'processing', attempts = attempts + 1,
            locked_by = $1, locked_at = NOW(), updated_at = NOW()
        WHERE id = $2 AND status IN ('queued','retrying')
          AND available_at <= NOW() AND attempts < max_attempts
          AND job_type = ANY($3::text[])
        RETURNING *
      `, [workerId, first.jobId, jobTypes]);
      return result.rows[0] || null;
    }
  };
  const worker = createQueueWorker({
    pool,
    handlers: { 'telegram.update': handler },
    pollIntervalMs: 100,
    leaseSeconds: 30,
    queueApi,
    logger: { log() {}, warn() {}, error() {} }
  });

  assert.equal(await worker.processOne(), true);
  assert.deepEqual(delivered, [update]);

  const inbox = await pool.query(
    'SELECT state, attempts FROM bot_inbound_updates WHERE bot_id = $1 AND update_id = $2',
    [botId, updateId]
  );
  const jobs = await pool.query(
    'SELECT status FROM platform_jobs WHERE bot_id = $1 AND job_type = $2',
    [botId, 'telegram.update']
  );
  assert.equal(inbox.rows[0].state, 'processed');
  assert.equal(Number(inbox.rows[0].attempts), 1);
  assert.equal(jobs.rows[0].status, 'completed');
});
