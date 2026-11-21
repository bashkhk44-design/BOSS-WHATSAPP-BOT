'use strict';

const { Bot } = require('grammy');

function registerCustomerBotHandlers(clientBot, record, { propagateErrors = false } = {}) {
  clientBot.command('start', async (ctx) => {
    await ctx.reply(
      'أهلاً بك في ' + record.name + ' 👋\n\n' +
      'هذا بوت النشاط، وسيتم إعداد خدماته قريباً.'
    );
  });

  clientBot.command('help', async (ctx) => {
    await ctx.reply(
      'مساعدة ' + record.name + '\n\n' +
      'سيتم تفعيل خدمات هذا البوت بعد إعداد مواصفاته.'
    );
  });

  clientBot.catch((err) => {
    console.error(
      'CUSTOMER BOT ' + record.id + ' UPDATE ERROR:',
      err.error_code || '',
      err.message || ''
    );
    // Polling keeps its historical log-and-continue behavior. Durable webhook
    // delivery must rethrow so the queue can retry failed Telegram API calls.
    if (propagateErrors) throw err;
  });

  return clientBot;
}

// Single source of truth for both polling and durable-queue transports.
function createCustomerBot(record, token, options = {}) {
  const clientBot = new Bot(token, { client: { timeoutSeconds: 45 } });
  return registerCustomerBotHandlers(clientBot, record, options);
}

module.exports = { createCustomerBot, registerCustomerBotHandlers };
