'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { enqueuePlatformJob, enqueueTelegramUpdate, claimPlatformJob, normalizeJobTypes, recoverExpiredPlatformJobs } = require('../platform-queue');
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


test('queue claims can be restricted to a validated set of registered job types', async () => {
  let call;
  const pool = {
    async query(sql, params) {
      call = { sql, params };
      return { rowCount: 0, rows: [] };
    }
  };
  assert.equal(await claimPlatformJob(pool, 'worker-preflight', ['deployment.preflight']), null);
  assert.match(call.sql, /job_type = ANY\(\$2::text\[\]\)/);
  assert.deepEqual(call.params, ['worker-preflight', ['deployment.preflight']]);
  assert.deepEqual(normalizeJobTypes(['deployment.preflight', 'deployment.preflight']), ['deployment.preflight']);
  assert.throws(() => normalizeJobTypes([]), /1 to 50/);
  assert.throws(() => normalizeJobTypes(['invalid type']), /invalid job type/);
});

test('expired lease recovery is restricted to the worker registered job types', async () => {
  let call;
  const pool = {
    async query(sql, params) {
      call = { sql, params };
      return { rowCount: 0, rows: [] };
    }
  };
  assert.deepEqual(
    await recoverExpiredPlatformJobs(pool, 90, ['deployment.preflight']),
    []
  );
  assert.match(call.sql, /job_type = ANY\(\$2::text\[\]\)/);
  assert.deepEqual(call.params, [90, ['deployment.preflight']]);
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
  let recoveredTypes;
  const queueApi = {
    async recoverExpiredPlatformJobs(_pool, _leaseSeconds, jobTypes) { recoveredTypes = jobTypes; return []; },
    async claimPlatformJob(_pool, workerId, jobTypes) {
      events.push(['claim', workerId, jobTypes]);
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
  assert.deepEqual(recoveredTypes, ['test.echo']);
  assert.deepEqual(events[0], ['claim', 'test-worker', ['test.echo']]);
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

test('lease renewal extends only the active job owned by the worker', async () => {
  const { renewPlatformJobLease } = require('../platform-queue');
  let call;
  const pool = {
    async query(sql, params) {
      call = { sql, params };
      return { rowCount: 1, rows: [{ id: 5 }] };
    }
  };
  assert.equal(await renewPlatformJobLease(pool, { jobId: 5, workerId: 'worker-1' }), true);
  assert.match(call.sql, /locked_at = NOW\(\)/);
  assert.match(call.sql, /locked_by = \$2 AND status = 'processing'/);
  assert.deepEqual(call.params, [5, 'worker-1']);
});

test('queue worker renews a long-running job lease until its handler finishes', async () => {
  let claimed = false;
  let renewals = 0;
  let completed = false;
  const queueApi = {
    async recoverExpiredPlatformJobs() { return []; },
    async claimPlatformJob() {
      if (claimed) return null;
      claimed = true;
      return { id: 22, job_type: 'test.slow', attempts: 1 };
    },
    async renewPlatformJobLease(_pool, args) {
      assert.deepEqual(args, { jobId: 22, workerId: 'heartbeat-worker' });
      renewals += 1;
      return true;
    },
    async completePlatformJob() { completed = true; },
    async failPlatformJob() { assert.fail('job should not fail'); }
  };
  const worker = createQueueWorker({
    pool: { query() {} },
    workerId: 'heartbeat-worker',
    handlers: { 'test.slow': async () => new Promise(resolve => setTimeout(() => resolve({ ok: true }), 280)) },
    queueApi,
    leaseSeconds: 10,
    leaseRenewalIntervalMs: 100,
    logger: { log() {}, warn() {}, error() {} }
  });
  assert.equal(await worker.processOne(), true);
  assert.ok(renewals >= 2);
  assert.equal(completed, true);
});

test('queue worker does not complete or fail a job after losing its lease', async () => {
  let claimed = false;
  let completed = false;
  let failed = false;
  const warnings = [];
  const queueApi = {
    async recoverExpiredPlatformJobs() { return []; },
    async claimPlatformJob() {
      if (claimed) return null;
      claimed = true;
      return { id: 23, job_type: 'test.lost', attempts: 1 };
    },
    async renewPlatformJobLease() { return false; },
    async completePlatformJob() { completed = true; },
    async failPlatformJob() { failed = true; }
  };
  const worker = createQueueWorker({
    pool: { query() {} },
    workerId: 'lost-lease-worker',
    handlers: { 'test.lost': async () => new Promise(resolve => setTimeout(() => resolve({ ok: true }), 180)) },
    queueApi,
    leaseSeconds: 10,
    leaseRenewalIntervalMs: 100,
    logger: { log() {}, warn(message) { warnings.push(message); }, error() {} }
  });
  assert.equal(await worker.processOne(), true);
  assert.equal(completed, false);
  assert.equal(failed, false);
  assert.ok(warnings.some(message => /lease lost/.test(message)));
});
