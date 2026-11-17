'use strict';

const { randomUUID } = require('node:crypto');
const queue = require('./platform-queue');

function createQueueWorker({
  pool,
  handlers,
  workerId = randomUUID(),
  pollIntervalMs = 1000,
  leaseSeconds = 120,
  logger = console,
  queueApi = queue
}) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('PostgreSQL pool is required');
  if (!handlers || typeof handlers !== 'object') throw new TypeError('A job handler map is required');
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 100) throw new RangeError('pollIntervalMs must be at least 100ms');
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 10) throw new RangeError('leaseSeconds must be at least 10 seconds');

  let stopping = false;
  let loopPromise = null;

  async function processOne() {
    const expired = await queueApi.recoverExpiredPlatformJobs(pool, leaseSeconds);
    if (expired.length) logger.warn(`Recovered expired jobs: ${expired.length}`);

    const job = await queueApi.claimPlatformJob(pool, workerId);
    if (!job) return false;

    const handler = handlers[job.job_type];
    if (typeof handler !== 'function') {
      await queueApi.failPlatformJob(pool, {
        jobId: job.id,
        workerId,
        error: new Error(`No handler registered for job type: ${job.job_type}`),
        retryDelaySeconds: 300
      });
      logger.error(`No handler for job type: ${job.job_type}`);
      return true;
    }

    try {
      const result = await handler(job);
      await queueApi.completePlatformJob(pool, {
        jobId: job.id,
        workerId,
        result: result === undefined ? {} : result
      });
      logger.log(`Job completed: ${job.id} (${job.job_type})`);
    } catch (error) {
      const attempts = Number(job.attempts) || 1;
      const delay = Math.min(300, 2 ** Math.min(attempts, 8));
      await queueApi.failPlatformJob(pool, {
        jobId: job.id,
        workerId,
        error,
        retryDelaySeconds: delay
      });
      logger.error(`Job failed: ${job.id} (${job.job_type}): ${error.message}`);
    }
    return true;
  }

  async function run() {
    while (!stopping) {
      const processed = await processOne();
      if (!processed && !stopping) {
        await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
      }
    }
  }

  return {
    workerId,
    processOne,
    start() {
      if (loopPromise) return loopPromise;
      stopping = false;
      loopPromise = run().catch(error => {
        logger.error('QUEUE WORKER STOPPED:', error.message);
        throw error;
      }).finally(() => {
        loopPromise = null;
      });
      return loopPromise;
    },
    async stop() {
      stopping = true;
      if (loopPromise) await loopPromise;
    }
  };
}

module.exports = { createQueueWorker };
