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

  async function start({ onLockFailure } = {}) {
    if (startPromise) return startPromise;
    startPromise = (async () => {
      await verifyDatabaseSchema();
      const acquired = await acquireLock();
      if (!acquired) throw new Error('Another Telegram runtime already owns the platform lock');
      ownsLock = true;

      try {
        setLockFailureHandler(async error => {
          ready = false;
          if (typeof onLockFailure === 'function') await onLockFailure(error);
        });
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
    if (!ready || !(await isLockHeld())) {
      ready = false;
      throw new Error('Telegram webhook runtime is not ready or no longer owns the runtime lock');
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
