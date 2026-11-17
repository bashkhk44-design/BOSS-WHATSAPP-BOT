'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { deriveTelegramWebhookSecret } = require('../telegram-webhook-secret');

test('webhook secret derivation is stable per bot and token without storing a separate secret', () => {
  const key = Buffer.alloc(32, 7);
  const first = deriveTelegramWebhookSecret(12, 'token-value', key);
  assert.equal(first, deriveTelegramWebhookSecret(12, 'token-value', key));
  assert.notEqual(first, deriveTelegramWebhookSecret(13, 'token-value', key));
  assert.notEqual(first, deriveTelegramWebhookSecret(12, 'different-token', key));
  assert.match(first, /^[a-f0-9]{64}$/);
});

test('webhook secret derivation rejects weak key material and invalid bot identifiers', () => {
  assert.throws(() => deriveTelegramWebhookSecret(1, 'token', Buffer.alloc(16)), /32-byte/);
  assert.throws(() => deriveTelegramWebhookSecret(0, 'token', Buffer.alloc(32)), /botId/);
});
