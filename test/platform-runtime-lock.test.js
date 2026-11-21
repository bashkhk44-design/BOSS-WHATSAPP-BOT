'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPlatformRuntimeLock } = require('../platform-runtime-lock');

function setup(overrides = {}) {
  const events = [];
  let failureHandler = null;
  const runtime = createPlatformRuntimeLock({
    async verifyDatabaseSchema() { events.push('schema'); },
    async acquireLock() { events.push('acquire'); return true; },
    async isLockHeld() { events.push('check-lock'); return true; },
    async releaseLock() { events.push('release'); },
    setLockFailureHandler(handler) { events.push(handler ? 'set-handler' : 'clear-handler'); failureHandler = handler; },
    async recoverInterruptedJobs() { events.push('recover'); },
    async initializeBot() { events.push('init-bot'); },
    ...overrides
  });
  return { runtime, events, get failureHandler() { return failureHandler; } };
}

test('webhook runtime verifies schema and acquires the singleton lock before recovery and bot initialization', async () => {
  const { runtime, events } = setup();
  await runtime.start();
  assert.deepEqual(events, [
    'schema', 'acquire', 'set-handler', 'recover', 'init-bot', 'check-lock'
  ]);
  assert.equal(runtime.ready, true);
  assert.equal(runtime.ownsLock, true);
});

test('webhook runtime fails closed when another runtime owns the lock', async () => {
  const { runtime, events } = setup({ async acquireLock() { events.push('acquire'); return false; } });
  await assert.rejects(runtime.start(), /already owns/);
  assert.deepEqual(events, ['schema', 'acquire']);
  assert.equal(runtime.ready, false);
  assert.equal(runtime.ownsLock, false);
});

test('schema verification failure happens before lock acquisition', async () => {
  const { runtime, events } = setup({
    async verifyDatabaseSchema() { events.push('schema'); throw new Error('schema unavailable'); }
  });
  await assert.rejects(runtime.start(), /schema unavailable/);
  assert.deepEqual(events, ['schema']);
});

test('startup releases only the lock it successfully acquired when bot initialization fails', async () => {
  const { runtime, events } = setup({
    async initializeBot() { events.push('init-bot'); throw new Error('Telegram init failed'); }
  });
  await assert.rejects(runtime.start(), /Telegram init failed/);
  assert.deepEqual(events, [
    'schema', 'acquire', 'set-handler', 'recover', 'init-bot', 'clear-handler', 'release'
  ]);
  assert.equal(runtime.ownsLock, false);
});

test('lost runtime lock marks webhook runtime unready and notifies the fail-closed handler', async () => {
  let lockHeld = true;
  let notified = null;
  const state = setup({
    async isLockHeld() { return lockHeld; }
  });
  await state.runtime.start({ onLockFailure: async error => { notified = error.message; } });
  lockHeld = false;
  await assert.rejects(state.runtime.assertReady(), /no longer owns/);
  assert.equal(state.runtime.ready, false);
  assert.equal(notified, null);
  // Simulate the database driver's asynchronous lock-loss notification.
  await state.failureHandler(new Error('lock connection lost'));
  assert.equal(notified, 'lock connection lost');
});

test('close clears the failure handler and releases an owned lock once', async () => {
  const { runtime, events } = setup();
  await runtime.start();
  await runtime.close();
  await runtime.close();
  assert.equal(runtime.ready, false);
  assert.equal(runtime.ownsLock, false);
  assert.equal(events.filter(item => item === 'release').length, 1);
  assert.equal(events.at(-1), 'clear-handler');
});
