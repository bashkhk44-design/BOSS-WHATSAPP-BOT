'use strict';

function createPlatformRuntimeLock({
  verifyDatabaseSchema,
  acquireLock,
  isLockHeld,
  releaseLock,
  setLockFailureHandler,
  recoverInterruptedJobs,
  initializeBot
}) {
  for (const [name, fn] of Object.entries({
    verifyDatabaseSchema, acquireLock, isLockHeld, releaseLock,
    setLockFailureHandler, recoverInterruptedJobs, initializeBot
  })) {
    if (typeof fn !== 'function') throw new TypeError(name + ' must be a function');
  }

  let ownsLock = false;
  let ready = false;
  let startPromise = null;
  let closePromise = null;
  let onLockFailureHandler = null;
  let lockFailureNotified = false;

  async function notifyLockFailure(error) {
    if (lockFailureNotified) return;
    lockFailureNotified = true;
    ready = false;
    if (typeof onLockFailureHandler === 'function') {
      await onLockFailureHandler(error);
    }
  }

  async function start({ onLockFailure } = {}) {
    if (startPromise) return startPromise;
    startPromise = (async () => {
      await verifyDatabaseSchema();
      const acquired = await acquireLock();
      if (!acquired) throw new Error('Another Telegram runtime already owns the platform lock');
      ownsLock = true;

      try {
        onLockFailureHandler = onLockFailure;
        lockFailureNotified = false;
        setLockFailureHandler(notifyLockFailure);
        await recoverInterruptedJobs();
        await initializeBot();
        if (!(await isLockHeld())) {
          throw new Error('Telegram runtime lock was lost during webhook startup');
        }
        ready = true;
        return true;
      } catch (error) {
        ready = false;
        setLockFailureHandler(null);
        onLockFailureHandler = null;
        if (ownsLock) {
          ownsLock = false;
          try {
            await releaseLock();
          } catch (releaseError) {
            error.lockReleaseError = releaseError;
          }
        }
        throw error;
      }
    })();
    return startPromise;
  }

  async function assertReady() {
    if (!ready) {
      throw new Error('Telegram webhook runtime is not ready or no longer owns the runtime lock');
    }

    let held = false;
    try {
      held = await isLockHeld();
    } catch (error) {
      await notifyLockFailure(error);
      throw error;
    }
    if (!held) {
      const error = new Error('Telegram runtime lock is no longer held');
      await notifyLockFailure(error);
      throw error;
    }
    return true;
  }

  async function close() {
    if (!closePromise) {
      closePromise = (async () => {
        ready = false;
        setLockFailureHandler(null);
        if (ownsLock) {
          ownsLock = false;
          await releaseLock();
        }
      })();
    }
    return closePromise;
  }

  return {
    start,
    assertReady,
    close,
    get ready() { return ready; },
    get ownsLock() { return ownsLock; }
  };
}

module.exports = { createPlatformRuntimeLock };
