'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { registerCustomerBotHandlers } = require('../customer-bot');

test('shared customer bot factory preserves polling /start and /help replies', async () => {
  const handlers = new Map();
  let errorHandler;
  const bot = {
    command(name, handler) {
      handlers.set(name, handler);
      return this;
    },
    catch(handler) {
      errorHandler = handler;
      return this;
    }
  };
  const replies = [];

  registerCustomerBotHandlers(bot, { id: 17, name: 'Test Activity' });

  assert.equal(typeof errorHandler, 'function');
  assert.equal(handlers.size, 2);

  await handlers.get('start')({
    reply: async text => replies.push(text)
  });
  await handlers.get('help')({
    reply: async text => replies.push(text)
  });

  assert.equal(replies.length, 2);
  assert.match(replies[0], /أهلاً بك في Test Activity/);
  assert.match(replies[0], /غير مربوط بإصدار معتمد/);
  assert.match(replies[1], /مساعدة Test Activity/);
  assert.match(replies[1], /لم يتم تفعيل وظائف هذا البوت/);
});


test('registers declarative commands, inline buttons, and safe callback replies', async () => {
  const handlers = new Map();
  const callbacks = new Map();
  const bot = {
    command(name, handler) { handlers.set(name, handler); return this; },
    callbackQuery(data, handler) { callbacks.set(data, handler); return this; },
    catch() { return this; }
  };
  const replies = [];
  let answered = 0;
  registerCustomerBotHandlers(bot, {
    id: 18,
    name: 'Configured Activity',
    runtimeConfig: {
      welcomeText: 'Welcome',
      helpText: 'Help text',
      commands: [{
        command: 'catalog',
        text: 'Catalog response',
        buttons: [{
          text: 'View details',
          callbackData: 'catalog_details',
          responseText: 'Catalog details'
        }]
      }]
    }
  });

  assert.deepEqual([...handlers.keys()], ['start', 'help', 'catalog']);
  assert.deepEqual([...callbacks.keys()], ['catalog_details']);
  await handlers.get('catalog')({
    reply: async (text, options) => replies.push({ text, options })
  });
  assert.equal(replies[0].text, 'Catalog response');
  assert.deepEqual(replies[0].options.reply_markup.inline_keyboard, [[{
    text: 'View details',
    callback_data: 'catalog_details'
  }]]);

  await callbacks.get('catalog_details')({
    answerCallbackQuery: async () => { answered += 1; },
    reply: async text => replies.push({ text })
  });
  assert.equal(answered, 1);
  assert.deepEqual(replies[1], { text: 'Catalog details' });
});
