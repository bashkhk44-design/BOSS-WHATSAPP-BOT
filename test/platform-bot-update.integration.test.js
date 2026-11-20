'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const {
  enqueuePlatformBotUpdate,
  claimPlatformJob,
  completePlatformJob
} = require('../platform-queue');
const { createPlatformBotUpdateHandler } = require('../platform-bot-update-handler');

test('platform bot updates enqueue atomically, deduplicate per identity, and dispatch only to their own runtime', {
  skip: !process.env.DATABASE_URL ? 'DATABASE_URL is required for the disposable PostgreSQL integration test' : false
}, async () => {
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes('localhost') || process.env.DATABASE_URL.includes('127.0.0.1')
      ? false
      : { rejectUnauthorized: false },
    max: 5
  });
  const suffix = randomUUID();
  const updateId = Number(BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000)));
  const workerId = 'platform-inbox-ci-' + suffix;
  const keys = ['master', 'intake'].map(identity => 'telegram.' + identity + '.update:' + updateId);
  const inboxIds = [];
  const handled = { master: 0, intake: 0 };

  try {
    const master = await enqueuePlatformBotUpdate(pool, {
      botIdentity: 'master',
      update: { update_id: updateId, message: { text: '/start', marker: suffix } }
    });
    const masterDuplicate = await enqueuePlatformBotUpdate(pool, {
      botIdentity: 'master',
      update: { update_id: updateId, message: { text: '/duplicate' } }
    });
    const intake = await enqueuePlatformBotUpdate(pool, {
      botIdentity: 'intake',
      update: { update_id: updateId, message: { text: '/start', marker: suffix } }
    });
    assert.equal(master.duplicate, false);
    assert.equal(masterDuplicate.duplicate, true);
    assert.equal(intake.duplicate, false);
    assert.notEqual(String(master.id), String(intake.id));
    inboxIds.push(master.id, intake.id);

    const handler = createPlatformBotUpdateHandler({
      pool,
      leaseSeconds: 120,
      runtimes: {
        master: { async handleUpdate(update) { handled.master += 1; assert.equal(update.update_id, updateId); } },
        intake: { async handleUpdate(update) { handled.intake += 1; assert.equal(update.update_id, updateId); } }
      }
    });

    for (const identity of ['master', 'intake']) {
      const jobType = 'telegram.' + identity + '.update';
      const job = await claimPlatformJob(pool, workerId, [jobType]);
      assert.ok(job, 'expected queued ' + identity + ' update job');
      const result = await handler(job, {
        workerId,
        leaseSeconds: 120,
        isLeaseLost: () => false
      });
      assert.equal(result.processed, true);
      await completePlatformJob(pool, { jobId: job.id, workerId, result });
    }

    assert.deepEqual(handled, { master: 1, intake: 1 });
    const rows = await pool.query(
      'SELECT bot_identity, state FROM platform_bot_inbound_updates WHERE id = ANY($1::bigint[]) ORDER BY bot_identity',
      [inboxIds]
    );
    assert.deepEqual(rows.rows, [
      { bot_identity: 'intake', state: 'processed' },
      { bot_identity: 'master', state: 'processed' }
    ]);
    const jobs = await pool.query(
      'SELECT job_type, status FROM platform_jobs WHERE idempotency_key = ANY($1::text[]) ORDER BY job_type',
      [keys]
    );
    assert.deepEqual(jobs.rows, [
      { job_type: 'telegram.intake.update', status: 'completed' },
      { job_type: 'telegram.master.update', status: 'completed' }
    ]);
  } finally {
    await pool.query('DELETE FROM platform_jobs WHERE idempotency_key = ANY($1::text[])', [keys]);
    if (inboxIds.length) {
      await pool.query('DELETE FROM platform_bot_inbound_updates WHERE id = ANY($1::bigint[])', [inboxIds]);
    }
    await pool.end();
  }
});


test('platform bot queue preserves update order even when a newer update has higher priority', {
  skip: !process.env.DATABASE_URL ? 'DATABASE_URL is required for the disposable PostgreSQL integration test' : false
}, async () => {
  const { Pool } = require('pg');
  const { enqueuePlatformBotUpdate, claimPlatformJob, completePlatformJob } = require('../platform-queue');
  const databaseUrl = process.env.DATABASE_URL;
  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: databaseUrl.includes('localhost') || databaseUrl.includes('127.0.0.1')
      ? false
      : { rejectUnauthorized: false },
    max: 5
  });
  const suffix = randomUUID();
  const firstUpdateId = Number(BigInt(Date.now()) * 1000n);
  const secondUpdateId = firstUpdateId + 1;
  const workerId = 'platform-ordering-ci-' + suffix;
  const keys = [
    'telegram.master.update:' + firstUpdateId,
    'telegram.master.update:' + secondUpdateId
  ];
  const inboxIds = [];

  try {
    const first = await enqueuePlatformBotUpdate(pool, {
      botIdentity: 'master',
      update: { update_id: firstUpdateId, message: { text: 'first', marker: suffix } }
    });
    const second = await enqueuePlatformBotUpdate(pool, {
      botIdentity: 'master',
      update: { update_id: secondUpdateId, message: { text: 'second', marker: suffix } }
    });
    inboxIds.push(first.id, second.id);

    await pool.query(
      "UPDATE platform_jobs SET priority = 32767 WHERE idempotency_key = $1",
      [keys[1]]
    );

    const claimedFirst = await claimPlatformJob(pool, workerId, ['telegram.master.update']);
    assert.ok(claimedFirst, 'the earliest update should be claimable');
    assert.equal(claimedFirst.payload.updateId, firstUpdateId);

    await completePlatformJob(pool, {
      jobId: claimedFirst.id,
      workerId,
      result: { test: true }
    });

    const blockedSecond = await claimPlatformJob(pool, workerId + '-parallel', ['telegram.master.update']);
    assert.equal(blockedSecond, null, 'newer update must wait until earlier inbox row is processed');

    await pool.query(
      "UPDATE platform_bot_inbound_updates SET state = 'processed', processed_at = NOW() WHERE id = $1",
      [first.id]
    );

    const claimedSecond = await claimPlatformJob(pool, workerId + '-next', ['telegram.master.update']);
    assert.ok(claimedSecond, 'newer update becomes claimable after earlier inbox row is processed');
    assert.equal(claimedSecond.payload.updateId, secondUpdateId);
  } finally {
    await pool.query('DELETE FROM platform_jobs WHERE idempotency_key = ANY($1::text[])', [keys]);
    if (inboxIds.length) {
      await pool.query('DELETE FROM platform_bot_inbound_updates WHERE id = ANY($1::bigint[])', [inboxIds]);
    }
    await pool.end();
  }
});


test('platform bot inbox reconciliation reuses active jobs and does not persist rows for terminal jobs', {
  skip: !process.env.DATABASE_URL ? 'DATABASE_URL is required for the disposable PostgreSQL integration test' : false
}, async () => {
  const { Pool } = require('pg');
  const databaseUrl = process.env.DATABASE_URL;
  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: databaseUrl.includes('localhost') || databaseUrl.includes('127.0.0.1')
      ? false
      : { rejectUnauthorized: false },
    max: 3
  });
  const suffix = randomUUID();
  const activeUpdateId = Number(BigInt(Date.now()) * 1000n + 31n);
  const terminalUpdateId = activeUpdateId + 1;
  const activeKey = 'telegram.master.update:' + activeUpdateId;
  const terminalKey = 'telegram.intake.update:' + terminalUpdateId;
  const inboxIds = [];

  try {
    await pool.query(
      "INSERT INTO platform_jobs (job_type, idempotency_key, payload) VALUES ($1, $2, $3::jsonb)",
      ['telegram.master.update', activeKey, JSON.stringify({ botIdentity: 'master', updateId: activeUpdateId, marker: suffix })]
    );
    const linked = await enqueuePlatformBotUpdate(pool, {
      botIdentity: 'master',
      update: { update_id: activeUpdateId, message: { text: 'recover inbox', marker: suffix } }
    });
    assert.equal(linked.duplicate, false);
    assert.ok(linked.id);
    assert.ok(linked.jobId);
    const activeRow = await pool.query(
      'SELECT id FROM platform_bot_inbound_updates WHERE bot_identity = $1 AND update_id = $2',
      ['master', activeUpdateId]
    );
    assert.equal(String(activeRow.rows[0]?.id), String(linked.id));
    inboxIds.push(linked.id);

    await pool.query(
      "INSERT INTO platform_jobs (job_type, idempotency_key, payload, status) VALUES ($1, $2, $3::jsonb, 'completed')",
      ['telegram.intake.update', terminalKey, JSON.stringify({ botIdentity: 'intake', updateId: terminalUpdateId })]
    );
    const terminal = await enqueuePlatformBotUpdate(pool, {
      botIdentity: 'intake',
      update: { update_id: terminalUpdateId, message: { text: 'already completed' } }
    });
    assert.deepEqual(terminal, {
      accepted: true,
      duplicate: true,
      id: null,
      jobId: (await pool.query(
        'SELECT id FROM platform_jobs WHERE job_type = $1 AND idempotency_key = $2',
        ['telegram.intake.update', terminalKey]
      )).rows[0].id
    });
    const terminalInbox = await pool.query(
      'SELECT id FROM platform_bot_inbound_updates WHERE bot_identity = $1 AND update_id = $2',
      ['intake', terminalUpdateId]
    );
    assert.equal(terminalInbox.rowCount, 0);
  } finally {
    await pool.query(
      'DELETE FROM platform_jobs WHERE idempotency_key = ANY($1::text[])',
      [[activeKey, terminalKey]]
    );
    if (inboxIds.length) {
      await pool.query('DELETE FROM platform_bot_inbound_updates WHERE id = ANY($1::bigint[])', [inboxIds]);
    }
    await pool.end();
  }
});
