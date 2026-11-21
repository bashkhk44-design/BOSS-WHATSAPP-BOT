'use strict';

const { randomUUID } = require('node:crypto');

function createProjectNotificationDispatcher({
  getNotifyAdminHandler,
  claimNotifications,
  renewLease,
  completeNotification,
  retryNotification,
  sendNotification,
  logger = console,
  leaseSeconds = 120,
  heartbeatIntervalMs = 30000
}) {
  for (const [name, value] of Object.entries({
    getNotifyAdminHandler,
    claimNotifications,
    renewLease,
    completeNotification,
    retryNotification,
    sendNotification
  })) {
    if (typeof value !== 'function') {
      throw new TypeError(name + ' must be a function');
    }
  }
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 30) {
    throw new RangeError('leaseSeconds must be at least 30 seconds');
  }
  if (!Number.isInteger(heartbeatIntervalMs) ||
      heartbeatIntervalMs < 1000 ||
      heartbeatIntervalMs >= leaseSeconds * 1000) {
    throw new RangeError('heartbeatIntervalMs must be at least 1000ms and shorter than the lease');
  }

  let activeDispatch = null;

  async function dispatchOne(handler) {
    const workerId = 'intake-notifier:' + randomUUID();
    const jobs = await claimNotifications({ workerId, limit: 1, leaseSeconds });
    const job = jobs[0];
    if (!job) return null;

    let leaseLost = false;
    let heartbeatInFlight = null;
    const heartbeat = setInterval(() => {
      if (heartbeatInFlight || leaseLost) return;
      heartbeatInFlight = Promise.resolve()
        .then(() => renewLease({ id: job.id, workerId, leaseSeconds }))
        .then(renewed => {
          if (!renewed) {
            leaseLost = true;
            logger.warn('Project notification lease lost:', job.id);
          }
        })
        .catch(error => {
          leaseLost = true;
          logger.error('Project notification lease renewal failed:', error.message);
        })
        .finally(() => { heartbeatInFlight = null; });
    }, heartbeatIntervalMs);
    if (typeof heartbeat.unref === 'function') heartbeat.unref();

    try {
      await sendNotification(job, handler);
      clearInterval(heartbeat);
      if (heartbeatInFlight) await heartbeatInFlight;
      if (leaseLost) {
        logger.warn('Notification sent but lease ownership was lost before acknowledgement:', job.id);
        return false;
      }
      const completed = await completeNotification({ id: job.id, workerId });
      if (!completed) {
        logger.warn('Notification completion was rejected by the current lease owner:', job.id);
        return false;
      }
      return true;
    } catch (error) {
      clearInterval(heartbeat);
      if (heartbeatInFlight) await heartbeatInFlight;
      if (leaseLost) {
        logger.warn('Skipping notification retry because its lease is no longer owned:', job.id);
        return false;
      }
      try {
        await retryNotification({
          id: job.id,
          workerId,
          error: error.message,
          delaySeconds: Math.min(3600, 30 * (Number(job.attempts) || 1))
        });
      } catch (retryError) {
        logger.error('Could not schedule project notification retry:', retryError.message);
      }
      logger.error('PROJECT NOTIFICATION OUTBOX ERROR:', error.message);
      return false;
    } finally {
      clearInterval(heartbeat);
      if (heartbeatInFlight) await heartbeatInFlight;
    }
  }

  async function runDispatch() {
    const handler = getNotifyAdminHandler();
    if (typeof handler !== 'function') return 0;
    let sent = 0;
    // Claim one row at a time so each notification has its own fenced lease owner.
    // This preserves useful batch throughput without holding a large batch while
    // sequential Telegram sends consume the lease window.
    for (let index = 0; index < 10; index += 1) {
      const result = await dispatchOne(handler);
      if (result === null || result === false) break;
      sent += 1;
    }
    return sent;
  }

  function dispatch() {
    if (activeDispatch) return activeDispatch;
    activeDispatch = runDispatch().finally(() => { activeDispatch = null; });
    return activeDispatch;
  }

  async function waitForIdle() {
    if (activeDispatch) await activeDispatch;
  }

  return { dispatch, waitForIdle };
}

module.exports = { createProjectNotificationDispatcher };
