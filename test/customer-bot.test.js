'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCustomerBot } = require('../customer-bot');

test('shared customer bot factory preserves polling /start and /help replies', async () => {
  const bot = createCustomerBot({ id: 17, name: 'Test Activity' }, '123456:TEST_TOKEN');
  bot.botInfo = {
    id: 123456,
    is_bot: true,
    first_name: 'Test Bot',
    username: 'test_bot'
  };
  const sent = [];

  bot.api.config.use(async (_previous, method, payload) => {
    sent.push({ method, payload });
    return {
      ok: true,
      result: {
        message_id: sent.length,
        date: 1700000000,
        chat: { id: 7001, type: 'private' },
        text: payload.text
      }
    };
  });

  const makeUpdate = (updateId, text) => ({
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1700000000,
      chat: { id: 7001, type: 'private' },
      from: { id: 7001, is_bot: false, first_name: 'Tester' },
      text
    }
  });

  await bot.handleUpdate(makeUpdate(1, '/start'));
  await bot.handleUpdate(makeUpdate(2, '/help'));

  assert.equal(sent.length, 2);
  assert.equal(sent[0].method, 'sendMessage');
  assert.match(sent[0].payload.text, /أهلاً بك في Test Activity/);
  assert.match(sent[0].payload.text, /سيتم إعداد خدماته قريباً/);
  assert.equal(sent[1].method, 'sendMessage');
  assert.match(sent[1].payload.text, /مساعدة Test Activity/);
  assert.match(sent[1].payload.text, /سيتم تفعيل خدمات هذا البوت/);
});
