'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createProjectNotificationDispatcher } = require('../project-notification-dispatcher');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function createHarness(overrides = {}) {
  const calls = {
    claims: [],
    renewals: [],
    completions: [],
    retries: [],
    sends: []
  };
  let claimAvailable = true;
  const defaults = {
    getNotifyAdminHandler: () => async () => {},
    claimNotifications: async options => {
      calls.claims.push(options);
      if (!claimAvailable) return [];
      claimAvailable = false;
      return [{ id: '77', event_type: 'project_approved', payload: {}, attempts: 1 }];
    },
    renewLease: async options => {
      calls.renewals.push(options);
      return true;
    },
    completeNotification: async options => {
      calls.completions.push(options);
      return true;
    },
    retryNotification: async options => {
      calls.retries.push(options);
      return { state: 'pending' };
    },
    sendNotification: async (job, handler) => {
      calls.sends.push({ job, handler });
    },
    logger: { warn() {}, error() {} },
    leaseSeconds: 30,
    heartbeatIntervalMs: 1000
  };
  return {
    calls,
    dispatcher: createProjectNotificationDispatcher({ ...defaults, ...overrides })
  };
}

test('overlapping polling ticks share one in-flight dispatch and claim one notification', async () => {
  const sending = deferred();
  const { calls, dispatcher } = createHarness({
    sendNotification: async () => sending.promise
  });

  const first = dispatcher.dispatch();
  const second = dispatcher.dispatch();
  assert.equal(first, second, 'concurrent dispatch calls must share the same promise');

  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.claims.length, 1);
  assert.equal(calls.claims[0].limit, 1);
  sending.resolve();
  assert.equal(await first, 1);
  assert.equal(calls.completions.length, 1);
  assert.equal(calls.claims.length, 2, 'the dispatcher checks for the next item after completing one');
  assert.equal(calls.retries.length, 0);
});

test('each claim uses a unique owner and renews the lease during a slow send', async () => {
  const sending = deferred();
  const { calls, dispatcher } = createHarness({
    sendNotification: async () => sending.promise
  });

  const dispatch = dispatcher.dispatch();
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.ok(calls.renewals.length >= 1, 'the lease must be renewed while Telegram send is pending');
  assert.equal(calls.renewals[0].workerId, calls.claims[0].workerId);
  sending.resolve();
  assert.equal(await dispatch, 1);
  assert.equal(calls.completions[0].workerId, calls.claims[0].workerId);
});

test('a lost lease prevents stale completion and retry writes', async () => {
  const sending = deferred();
  const { calls, dispatcher } = createHarness({
    renewLease: async () => false,
    sendNotification: async () => sending.promise
  });

  const dispatch = dispatcher.dispatch();
  await new Promise(resolve => setTimeout(resolve, 1100));
  sending.resolve();
  assert.equal(await dispatch, 0);
  assert.equal(calls.completions.length, 0);
  assert.equal(calls.retries.length, 0);
});

test('send failures retry only while the worker still owns the lease', async () => {
  const { calls, dispatcher } = createHarness({
    sendNotification: async () => { throw new Error('telegram unavailable'); }
  });

  assert.equal(await dispatcher.dispatch(), 0);
  assert.equal(calls.retries.length, 1);
  assert.equal(calls.retries[0].id, '77');
  assert.equal(calls.retries[0].workerId, calls.claims[0].workerId);
});

test('dispatcher does not claim work when the admin sender is unavailable', async () => {
  const { calls, dispatcher } = createHarness({
    getNotifyAdminHandler: () => null
  });

  assert.equal(await dispatcher.dispatch(), 0);
  assert.equal(calls.claims.length, 0);
});


test('sequential queue draining gives every claimed notification a distinct owner', async () => {
  const claims = [];
  const completions = [];
  let nextId = 1;
  const dispatcher = createProjectNotificationDispatcher({
    getNotifyAdminHandler: () => async () => {},
    claimNotifications: async options => {
      claims.push(options);
      if (nextId > 2) return [];
      const id = String(nextId++);
      return [{ id, event_type: 'project_approved', payload: {}, attempts: 1 }];
    },
    renewLease: async () => true,
    completeNotification: async options => {
      completions.push(options);
      return true;
    },
    retryNotification: async () => null,
    sendNotification: async () => {},
    logger: { warn() {}, error() {} },
    leaseSeconds: 30,
    heartbeatIntervalMs: 1000
  });

  assert.equal(await dispatcher.dispatch(), 2);
  assert.equal(claims.length, 3, 'two jobs plus one empty-queue check');
  assert.ok(claims.every(claim => claim.limit === 1));
  assert.notEqual(claims[0].workerId, claims[1].workerId);
  assert.equal(completions.length, 2);
});
