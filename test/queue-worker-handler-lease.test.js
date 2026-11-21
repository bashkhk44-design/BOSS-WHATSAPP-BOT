'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createQueueWorker } = require('../queue-worker');

test('queue worker renews handler-specific lease with the durable job lease', async () => {
  const originalSetInterval = global.setInterval;
  const originalClearInterval = global.clearInterval;
  let heartbeat;
  let handlerLeaseRenewals = 0;
  let completed = 0;
  let finishHandler;
  global.setInterval = callback => {
    heartbeat = callback;
    return { unref() {} };
  };
  global.clearInterval = () => {};
  try {
    const queueApi = {
      async recoverExpiredPlatformJobs() { return []; },
      async claimPlatformJob() {
        return { id: 9001, job_type: 'telegram.update', attempts: 1 };
      },
      async renewPlatformJobLease() { return true; },
      async completePlatformJob() { completed += 1; },
      async failPlatformJob(_pool, args) { throw args.error; }
    };
    const handler = () => new Promise(resolve => { finishHandler = resolve; });
    handler.renewLease = async job => {
      assert.equal(job.id, 9001);
      handlerLeaseRenewals += 1;
      return true;
    };
    const worker = createQueueWorker({
      pool: { async query() {} },
      handlers: { 'telegram.update': handler },
      leaseSeconds: 30,
      queueApi,
      logger: { log() {}, warn() {}, error() {} }
    });

    const processing = worker.processOne();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(typeof heartbeat, 'function');
    heartbeat();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(handlerLeaseRenewals, 1);
    finishHandler({ processed: true });
    assert.equal(await processing, true);
    assert.equal(completed, 1);
  } finally {
    global.setInterval = originalSetInterval;
    global.clearInterval = originalClearInterval;
  }
});
