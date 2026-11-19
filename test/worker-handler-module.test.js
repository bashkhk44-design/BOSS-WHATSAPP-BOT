'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeWorkerHandlers } = require('../worker');

const baseHandler = async () => {};
const extraHandler = async () => {};
const existing = { 'telegram.update': baseHandler };

test('accepts valid additional handlers from a direct export', () => {
  const result = mergeWorkerHandlers(existing, {
    'custom.task.run': extraHandler
  });

  assert.equal(result['telegram.update'], baseHandler);
  assert.equal(result['custom.task.run'], extraHandler);
  assert.equal(Object.hasOwn(existing, 'custom.task.run'), false);
});

test('accepts valid additional handlers from a handlers export', () => {
  const result = mergeWorkerHandlers(existing, {
    handlers: { 'custom.task.run': extraHandler }
  });

  assert.equal(result['custom.task.run'], extraHandler);
});

test('rejects attempts to replace an existing handler', () => {
  assert.throws(
    () => mergeWorkerHandlers(existing, {
      'telegram.update': extraHandler
    }),
    /cannot replace existing job type/
  );
});

test('rejects invalid job type names', () => {
  assert.throws(
    () => mergeWorkerHandlers(existing, {
      'INVALID TYPE': extraHandler
    }),
    /invalid job type/
  );
});

test('rejects non-function handler values', () => {
  assert.throws(
    () => mergeWorkerHandlers(existing, {
      'custom.task.run': 'not-a-function'
    }),
    /must be a function/
  );
});

test('rejects missing, invalid, and empty custom handler exports', () => {
  for (const value of [null, undefined, [], {}, { handlers: null }, { handlers: {} }]) {
    assert.throws(() => mergeWorkerHandlers(existing, value));
  }
});
