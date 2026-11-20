'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { enqueuePlatformJob, enqueueTelegramUpdate, enqueuePlatformBotUpdate, claimPlatformJob, normalizeJobTypes, recoverExpiredPlatformJobs } = require('../platform-queue');
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
  assert.match(call.sql, /NOT EXISTS/);
  assert.match(call.sql, /earlier.update_id < \(platform_jobs.payload->>'updateId'\)::bigint/);
  assert.deepEqual(call.params, ['worker-preflight', ['deployment.preflight']]);

  await assert.rejects(claimPlatformJob(pool, 'worker-unfiltered'), /jobTypes is required/);
  assert.match(call.sql, /job_type = ANY\(\$2::text\[\]\)/);
  assert.match(call.sql, /NOT EXISTS/);
  assert.match(call.sql, /earlier.state <> 'processed'/);
  assert.match(call.sql, /platform_jobs\.job_type NOT IN \('telegram\.master\.update', 'telegram\.intake\.update'\)/);
  assert.match(call.sql, /earlier\.bot_identity = platform_jobs\.payload->>'botIdentity'/);
  assert.match(call.sql, /earlier\.update_id < \(platform_jobs\.payload->>'updateId'\)::bigint/);
  assert.match(call.sql, /earlier_job\.status, 'queued'\) <> 'dead_letter'/);
  assert.deepEqual(normalizeJobTypes(['deployment.preflight', 'deployment.preflight']), ['deployment.preflight']);
  assert.throws(() => normalizeJobTypes([]), /1 to 50/);
  assert.throws(() => normalizeJobTypes(), /jobTypes is required/);
  assert.throws(() => normalizeJobTypes(null), /jobTypes is required/);
  await assert.rejects(recoverExpiredPlatformJobs(pool, 90), /jobTypes is required/);
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


test('queue worker keeps running and retries after a transient queue/database error', async () => {
  let recoveryCalls = 0;
  let claims = 0;
  const logged = [];
  const queueApi = {
    async recoverExpiredPlatformJobs() {
      recoveryCalls += 1;
      if (recoveryCalls === 1) throw new Error('temporary database disconnect');
      return [];
    },
    async claimPlatformJob() {
      claims += 1;
      return null;
    }
  };
  const worker = createQueueWorker({
    pool: { query() {} },
    workerId: 'reconnect-worker',
    handlers: { 'test.reconnect': async () => ({}) },
    queueApi,
    pollIntervalMs: 100,
    logger: { log() {}, warn() {}, error(message) { logged.push(message); } }
  });

  const running = worker.start();
  const deadline = Date.now() + 5000;
  while (claims < 1 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  await worker.stop();
  await running;

  assert.equal(recoveryCalls >= 2, true);
  assert.equal(claims >= 1, true);
  assert.ok(logged.some(message => /temporary database disconnect/.test(message)));
});


test('queue worker stop interrupts retry backoff immediately', async () => {
  let recoveryCalls = 0;
  const logged = [];
  const worker = createQueueWorker({
    pool: { query() {} },
    workerId: 'interruptible-stop-worker',
    handlers: { 'test.stop': async () => ({}) },
    queueApi: {
      async recoverExpiredPlatformJobs() {
        recoveryCalls += 1;
        throw new Error('database unavailable');
      },
      async claimPlatformJob() { return null; }
    },
    pollIntervalMs: 1000,
    logger: { log() {}, warn() {}, error(message) { logged.push(message); } }
  });

  const running = worker.start();
  const deadline = Date.now() + 2000;
  while (!logged.length && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(logged.length > 0, 'worker should enter retry backoff');
  const stopStartedAt = Date.now();
  await worker.stop();
  await running;
  assert.ok(Date.now() - stopStartedAt < 500, 'stop should wake retry sleep without waiting for its backoff');
  assert.equal(recoveryCalls, 1);
});


test('queue worker drains an active job before graceful stop resolves', async () => {
  let claimed = false;
  let handlerStarted = false;
  let releaseHandler;
  let completed = false;
  let renewals = 0;
  const handlerGate = new Promise(resolve => { releaseHandler = resolve; });
  const queueApi = {
    async recoverExpiredPlatformJobs() { return []; },
    async claimPlatformJob() {
      if (claimed) return null;
      claimed = true;
      return { id: 91, job_type: 'test.drain', attempts: 1 };
    },
    async renewPlatformJobLease(_pool, args) {
      assert.deepEqual(args, { jobId: 91, workerId: 'drain-worker' });
      renewals += 1;
      return true;
    },
    async completePlatformJob(_pool, args) {
      assert.equal(args.jobId, 91);
      completed = true;
    },
    async failPlatformJob() { assert.fail('active job should complete'); }
  };
  const worker = createQueueWorker({
    pool: { query() {} },
    workerId: 'drain-worker',
    handlers: {
      'test.drain': async () => {
        handlerStarted = true;
        await handlerGate;
        return { drained: true };
      }
    },
    queueApi,
    leaseSeconds: 10,
    leaseRenewalIntervalMs: 100,
    logger: { log() {}, warn() {}, error() {} }
  });

  const running = worker.start();
  const startDeadline = Date.now() + 2000;
  while (!handlerStarted && Date.now() < startDeadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(handlerStarted, true, 'worker should begin the claimed job');

  let stopResolved = false;
  const stopping = worker.stop().then(() => { stopResolved = true; });
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(stopResolved, false, 'stop must wait while the handler is still running');
  assert.equal(completed, false, 'job must not be completed before its handler finishes');

  releaseHandler();
  await stopping;
  await running;
  assert.equal(completed, true, 'active job should be completed before stop resolves');
  assert.ok(renewals >= 1, 'lease should remain renewed while the active job drains');
});


test('Telegram update queue rejects coerced or malformed update identifiers before database access', async () => {
  const pool = { async query() { assert.fail('invalid update must not reach database'); } };
  for (const update of [
    { update_id: '1234' },
    { update_id: 1.5 },
    { update_id: -1 },
    { update_id: Number.MAX_SAFE_INTEGER + 1 },
    [],
    null
  ]) {
    await assert.rejects(
      enqueueTelegramUpdate(pool, { botId: 7, update }),
      /Telegram update_id is required/
    );
  }
});


test('platform bot update enqueue creates inbox and durable job in one transaction and deduplicates retries', async () => {
  const calls = [];
  let inboxDuplicate = false;
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rowCount: 0, rows: [] };
      if (sql.includes('INSERT INTO platform_bot_inbound_updates')) {
        return inboxDuplicate ? { rowCount: 0, rows: [] } : { rowCount: 1, rows: [{ id: 51 }] };
      }
      if (sql.includes('INSERT INTO platform_jobs')) return { rowCount: 1, rows: [{ id: 61 }] };
      assert.fail('unexpected SQL: ' + sql);
    },
    release() {}
  };
  const pool = { async connect() { return client; } };

  const first = await enqueuePlatformBotUpdate(pool, {
    botIdentity: 'master',
    update: { update_id: 888, message: { text: '/start' } }
  });
  inboxDuplicate = true;
  const repeated = await enqueuePlatformBotUpdate(pool, {
    botIdentity: 'master',
    update: { update_id: 888, message: { text: '/start' } }
  });

  assert.deepEqual(first, { accepted: true, duplicate: false, id: 51, jobId: 61 });
  assert.deepEqual(repeated, { accepted: true, duplicate: true, id: null, jobId: null });
  assert.equal(calls[0].sql, 'BEGIN');
  assert.match(calls[1].sql, /INSERT INTO platform_bot_inbound_updates/);
  assert.match(calls[2].sql, /INSERT INTO platform_jobs/);
  assert.equal(calls[3].sql, 'COMMIT');
  assert.match(calls[1].sql, /ON CONFLICT \(bot_identity, update_id\) DO NOTHING/);
  assert.deepEqual(calls[1].params.slice(0, 2), ['master', 888]);
  assert.equal(calls[2].params[0], 'telegram.master.update');
  assert.equal(calls[4].sql, 'BEGIN');
  assert.equal(calls[6].sql, 'COMMIT');
});

test('platform bot enqueue links a new inbox row to an existing active idempotent queue job', async () => {
  const calls = [];
  const client = {
    async query(sql) {
      calls.push(sql);
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rowCount: 0, rows: [] };
      if (sql.includes('INSERT INTO platform_bot_inbound_updates')) return { rowCount: 1, rows: [{ id: 52 }] };
      if (sql.includes('INSERT INTO platform_jobs')) return { rowCount: 0, rows: [] };
      if (sql.includes('SELECT id, status, payload')) {
        return { rowCount: 1, rows: [{
          id: 62, status: 'queued',
          payload: { botIdentity: 'intake', updateId: 889 }
        }] };
      }
      assert.fail('unexpected SQL: ' + sql);
    },
    release() {}
  };
  const result = await enqueuePlatformBotUpdate({ connect: async () => client }, {
    botIdentity: 'intake',
    update: { update_id: 889, message: { text: '/start' } }
  });
  assert.deepEqual(result, { accepted: true, duplicate: false, id: 52, jobId: 62 });
  assert.deepEqual(calls, ['BEGIN', calls[1], calls[2], calls[3], 'COMMIT']);
  assert.match(calls[3], /FOR UPDATE/);
});

test('platform bot enqueue rolls back a new inbox row when its matching job is already terminal', async () => {
  const calls = [];
  const client = {
    async query(sql) {
      calls.push(sql);
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rowCount: 0, rows: [] };
      if (sql.includes('INSERT INTO platform_bot_inbound_updates')) return { rowCount: 1, rows: [{ id: 53 }] };
      if (sql.includes('INSERT INTO platform_jobs')) return { rowCount: 0, rows: [] };
      if (sql.includes('SELECT id, status, payload')) {
        return { rowCount: 1, rows: [{
          id: 63, status: 'completed',
          payload: { botIdentity: 'master', updateId: 890 }
        }] };
      }
      assert.fail('unexpected SQL: ' + sql);
    },
    release() {}
  };
  const result = await enqueuePlatformBotUpdate({ connect: async () => client }, {
    botIdentity: 'master',
    update: { update_id: 890, message: { text: '/already-done' } }
  });
  assert.deepEqual(result, { accepted: true, duplicate: true, id: null, jobId: 63 });
  assert.equal(calls.at(-1), 'ROLLBACK');
});

test('platform bot update enqueue rejects customer identities and malformed Telegram updates', async () => {
  const pool = { async query() { assert.fail('invalid update must not reach PostgreSQL'); } };
  await assert.rejects(
    enqueuePlatformBotUpdate(pool, { botIdentity: 'customer:9', update: { update_id: 1 } }),
    /botIdentity/
  );
  await assert.rejects(
    enqueuePlatformBotUpdate(pool, { botIdentity: 'intake', update: { update_id: -1 } }),
    /update_id/
  );
});
