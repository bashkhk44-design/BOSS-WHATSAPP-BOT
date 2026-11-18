'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPlatformBotUpdateHandler } = require('../platform-bot-update-handler');

function makeJob(overrides = {}) {
  return {
    id: 91,
    job_type: 'telegram.master.update',
    payload: { botIdentity: 'master', updateId: 123 },
    ...overrides
  };
}

test('platform bot update handler claims, dispatches, and fences completion to its queue lease', async () => {
  const calls = [];
  let dispatched = false;
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes("SET state = 'processing'")) {
        return { rowCount: 1, rows: [{ payload: { update_id: 123, message: { text: '/start' } } }] };
      }
      if (sql.includes("SET state = 'processed'")) return { rowCount: 1, rows: [{ id: 8 }] };
      throw new Error('unexpected SQL');
    }
  };
  const handler = createPlatformBotUpdateHandler({
    pool,
    runtimes: {
      master: { async handleUpdate(update) { dispatched = true; assert.equal(update.update_id, 123); } },
      intake: { async handleUpdate() { assert.fail('master update must not reach intake'); } }
    }
  });

  const result = await handler(makeJob(), {
    workerId: 'platform-worker-a',
    leaseSeconds: 120,
    isLeaseLost: () => false
  });

  assert.equal(dispatched, true);
  assert.deepEqual(result, { processed: true, identity: 'master', updateId: 123 });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].params, ['master', 123, 'platform-worker-a', 91, 'telegram.master.update', 120]);
  assert.match(calls[1].sql, /job\.locked_by = \$3/);
  assert.match(calls[1].sql, /job\.status = 'processing'/);
});

test('platform bot update handler acknowledges already processed inbox records', async () => {
  let dispatchCalls = 0;
  const pool = {
    async query(sql) {
      if (sql.includes("SET state = 'processing'")) return { rowCount: 0, rows: [] };
      if (sql.includes('SELECT state FROM platform_bot_inbound_updates')) {
        return { rowCount: 1, rows: [{ state: 'processed' }] };
      }
      throw new Error('unexpected SQL');
    }
  };
  const handler = createPlatformBotUpdateHandler({
    pool,
    runtimes: { master: { async handleUpdate() { dispatchCalls += 1; } } }
  });
  const result = await handler(makeJob(), { workerId: 'worker-b' });
  assert.deepEqual(result, { duplicate: true, identity: 'master', updateId: 123 });
  assert.equal(dispatchCalls, 0);
});

test('platform bot update handler records retryable failure while the worker still owns both leases', async () => {
  const calls = [];
  const pool = {
    async query(sql) {
      calls.push(sql);
      if (sql.includes("SET state = 'processing'")) {
        return { rowCount: 1, rows: [{ payload: { update_id: 123 } }] };
      }
      if (sql.includes("SET state = 'processed'")) return { rowCount: 0, rows: [] };
      if (sql.includes("SET state = 'failed'")) return { rowCount: 1, rows: [] };
      throw new Error('unexpected SQL');
    }
  };
  const handler = createPlatformBotUpdateHandler({
    pool,
    runtimes: { master: { async handleUpdate() { throw new Error('temporary handler failure'); } } }
  });
  await assert.rejects(
    handler(makeJob(), { workerId: 'worker-c', isLeaseLost: () => false }),
    /temporary handler failure/
  );
  assert.ok(calls.some(sql => sql.includes("SET state = 'failed'")));
});

test('platform bot update handler rejects mismatched job identity and lost lease before dispatch', async () => {
  let queries = 0;
  let dispatchCalls = 0;
  const pool = { async query() { queries += 1; return { rowCount: 0, rows: [] }; } };
  const handler = createPlatformBotUpdateHandler({
    pool,
    runtimes: { master: { async handleUpdate() { dispatchCalls += 1; } } }
  });

  await assert.rejects(
    handler(makeJob({ job_type: 'telegram.intake.update' }), { workerId: 'worker-d' }),
    /Invalid platform Telegram update job/
  );
  await assert.rejects(
    handler(makeJob(), { workerId: 'worker-d', isLeaseLost: () => true }),
    /already leased or unavailable/
  );
  assert.equal(queries, 2);
  assert.equal(dispatchCalls, 0);
});
