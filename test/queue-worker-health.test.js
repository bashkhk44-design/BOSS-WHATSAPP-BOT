'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createQueueWorker } = require('../queue-worker');

test('queue worker reports unhealthy database loops and recovers readiness after a successful poll', async () => {
  const states = [];
  let attempts = 0;
  let resolveRecovered;
  const recovered = new Promise(resolve => { resolveRecovered = resolve; });
  const worker = createQueueWorker({
    pool: { query: async () => ({ rows: [] }) },
    handlers: { 'telegram.master.update': async () => {} },
    pollIntervalMs: 100,
    leaseSeconds: 30,
    queueApi: {
      async recoverExpiredPlatformJobs() { return []; },
      async claimPlatformJob() {
        attempts += 1;
        if (attempts === 1) throw new Error('temporary database failure');
        return null;
      }
    },
    logger: { log() {}, warn() {}, error() {} },
    onHealthChange(healthy, error) {
      states.push({ healthy, message: error?.message || null });
      if (healthy) resolveRecovered();
    }
  });

  const done = worker.start();
  try {
    await Promise.race([
      recovered,
      new Promise((_, reject) => setTimeout(() => reject(new Error('worker did not recover readiness')), 3000))
    ]);
    assert.deepEqual(states[0], { healthy: false, message: 'temporary database failure' });
    assert.equal(states.at(-1).healthy, true);
  } finally {
    await worker.stop();
    await done;
  }
});
