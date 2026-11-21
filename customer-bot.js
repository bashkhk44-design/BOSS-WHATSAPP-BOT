'use strict';

const { Bot } = require('grammy');

function registerCustomerBotHandlers(clientBot, record) {
  const config = record.runtimeConfig || null;
  const welcomeText = config?.welcomeText ||
    ('أهلاً بك في ' + record.name + ' 👋\n\n' +
      'هذا البوت غير مربوط بإصدار معتمد بعد. يرجى مراجعة إدارة المنصة.');
  const helpText = config?.helpText ||
    ('مساعدة ' + record.name + '\n\n' +
      'لم يتم تفعيل وظائف هذا البوت بعد اعتماد الإصدار.');

  clientBot.command('start', async (ctx) => {
    await ctx.reply(welcomeText);
  });

  clientBot.command('help', async (ctx) => {
    await ctx.reply(helpText);
  });

  for (const item of config?.commands || []) {
    clientBot.command(item.command, async (ctx) => {
      await ctx.reply(item.text);
    });
  }

  clientBot.catch((err) => {
    console.error(
      'CUSTOMER BOT ' + record.id + ' UPDATE ERROR:',
      err.error_code || '',
      err.message || ''
    );
  });

  return clientBot;
}

// Customer projects run only validated declarative commands. Generated JavaScript
// is never required or evaluated inside the platform runtime process.
function createCustomerBot(record, token) {
  const clientBot = new Bot(token, { client: { timeoutSeconds: 45 } });
  return registerCustomerBotHandlers(clientBot, record);
}

module.exports = { createCustomerBot, registerCustomerBotHandlers };
