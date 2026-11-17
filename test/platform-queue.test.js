'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { enqueuePlatformJob, enqueueTelegramUpdate } = require('../platform-queue');
const { createQueueWorker } = require('../queue-worker');

test('job enqueue uses a stable idempotency key and returns existing job on conflict', async () => {
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('INSERT INTO platform_jobs')) return { rowCount: 0, rows: [] };
      return { rowCount: 1, rows: [{ id: 9, job_type: 'build', idempotency_key: 'project:9:v1' }] };
    }
  };

  const result = await enqueuePlatformJob(pool, {
    jobType: 'build',
    idempotencyKey: 'project:9:v1',
    payload: { projectId: 9 }
  });

  assert.equal(result.created, false);
  assert.equal(result.job.id, 9);
  assert.match(calls[0].sql, /ON CONFLICT \(job_type, idempotency_key\) DO NOTHING/);
  assert.deepEqual(calls[1].params, ['build', 'project:9:v1']);
});

test('job enqueue rejects invalid attempts and unserializable payloads', async () => {
  const pool = { async query() { throw new Error('must not query'); } };
  await assert.rejects(enqueuePlatformJob(pool, { jobType: 'build', maxAttempts: 0 }), /maxAttempts/);
  const circular = {};
  circular.self = circular;
  await assert.rejects(enqueuePlatformJob(pool, { jobType: 'build', payload: circular }), /JSON serializable/);
});

test('Telegram update ingestion acknowledges duplicate updates without inserting twice', async () => {
  let inserted = true;
  const pool = {
    async query(sql, params) {
      assert.match(sql, /ON CONFLICT \(bot_id, update_id\) DO NOTHING/);
      assert.equal(params[0], 7);
      assert.equal(params[1], 1234);
      return inserted
        ? { rowCount: 1, rows: [{ id: 44 }] }
        : { rowCount: 0, rows: [] };
    }
  };

  const first = await enqueueTelegramUpdate(pool, { botId: 7, update: { update_id: 1234, message: {} } });
  inserted = false;
  const second = await enqueueTelegramUpdate(pool, { botId: 7, update: { update_id: 1234, message: {} } });

  assert.deepEqual(first, { accepted: true, duplicate: false, id: 44, jobId: null });
  assert.deepEqual(second, { accepted: true, duplicate: true, id: null, jobId: null });
});

test('queue worker dispatches claimed jobs and records completion', async () => {
  const events = [];
  let claimed = false;
  const queueApi = {
    async recoverExpiredPlatformJobs() { return []; },
    async claimPlatformJob(_pool, workerId) {
      events.push(['claim', workerId]);
      if (claimed) return null;
      claimed = true;
      return { id: 3, job_type: 'test.echo', attempts: 1, payload: { ok: true } };
    },
    async completePlatformJob(_pool, args) { events.push(['complete', args.jobId, args.result]); },
    async failPlatformJob() { assert.fail('job should not fail'); }
  };
  const worker = createQueueWorker({
    pool: { query() {} },
    workerId: 'test-worker',
    handlers: { 'test.echo': async job => ({ echoed: job.payload.ok }) },
    queueApi,
    logger: { log() {}, warn() {}, error() {} }
  });

  assert.equal(await worker.processOne(), true);
  assert.equal(await worker.processOne(), false);
  assert.deepEqual(events[1], ['complete', 3, { echoed: true }]);
});

test('queue worker records handler failures for retry/dead-letter policy', async () => {
  let failure;
  const queueApi = {
    async recoverExpiredPlatformJobs() { return []; },
    async claimPlatformJob() { return { id: 8, job_type: 'test.fail', attempts: 2 }; },
    async completePlatformJob() { assert.fail('job should fail'); },
    async failPlatformJob(_pool, args) { failure = args; }
  };
  const worker = createQueueWorker({
    pool: { query() {} },
    workerId: 'worker-b',
    handlers: { 'test.fail': async () => { throw new Error('expected failure'); } },
    queueApi,
    logger: { log() {}, warn() {}, error() {} }
  });

  assert.equal(await worker.processOne(), true);
  assert.equal(failure.jobId, 8);
  assert.equal(failure.workerId, 'worker-b');
  assert.match(failure.error.message, /expected failure/);
  assert.equal(failure.retryDelaySeconds, 4);
});
