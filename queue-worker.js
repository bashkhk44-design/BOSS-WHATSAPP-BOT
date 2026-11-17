'use strict';

const { randomUUID } = require('node:crypto');
const queue = require('./platform-queue');

function createQueueWorker({
  pool,
  handlers,
  workerId = randomUUID(),
  pollIntervalMs = 1000,
  leaseSeconds = 120,
  leaseRenewalIntervalMs,
  logger = console,
  queueApi = queue
}) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('PostgreSQL pool is required');
  if (!handlers || typeof handlers !== 'object' || Object.keys(handlers).length < 1) throw new TypeError('A non-empty job handler map is required');
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 100) throw new RangeError('pollIntervalMs must be at least 100ms');
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 10) throw new RangeError('leaseSeconds must be at least 10 seconds');
  const heartbeatIntervalMs = leaseRenewalIntervalMs === undefined
    ? Math.max(1000, Math.floor(leaseSeconds * 1000 / 3))
    : leaseRenewalIntervalMs;
  if (!Number.isInteger(heartbeatIntervalMs) || heartbeatIntervalMs < 100) throw new RangeError('leaseRenewalIntervalMs must be at least 100ms');

  let stopping = false;
  let loopPromise = null;

  async function processOne() {
    const expired = await queueApi.recoverExpiredPlatformJobs(pool, leaseSeconds, Object.keys(handlers));
    if (expired.length) logger.warn(`Recovered expired jobs: ${expired.length}`);

    const job = await queueApi.claimPlatformJob(pool, workerId, Object.keys(handlers));
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

    let leaseLost = false;
    let heartbeatInFlight = null;
    let heartbeatTimer = null;
    const renewLease = typeof queueApi.renewPlatformJobLease === 'function';
    if (renewLease) {
      heartbeatTimer = setInterval(() => {
        if (heartbeatInFlight || leaseLost) return;
        heartbeatInFlight = queueApi.renewPlatformJobLease(pool, { jobId: job.id, workerId })
          .then(renewed => {
            if (!renewed) {
              leaseLost = true;
              logger.warn(`Job lease lost during execution: ${job.id}`);
            }
          })
          .catch(error => {
            leaseLost = true;
            logger.error(`Job lease heartbeat failed: ${job.id}: ${error.message}`);
          })
          .finally(() => { heartbeatInFlight = null; });
      }, heartbeatIntervalMs);
      if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();
    }

    try {
      const result = await handler(job);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (heartbeatInFlight) await heartbeatInFlight;
      if (leaseLost) {
        logger.warn(`Skipping completion after lease loss: ${job.id}`);
        return true;
      }
      await queueApi.completePlatformJob(pool, {
        jobId: job.id,
        workerId,
        result: result === undefined ? {} : result
      });
      logger.log(`Job completed: ${job.id} (${job.job_type})`);
    } catch (error) {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (heartbeatInFlight) await heartbeatInFlight;
      if (leaseLost) {
        logger.warn(`Not recording failure after lease loss: ${job.id}`);
        return true;
      }
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
