const { Bot } = require('grammy');
const { pool, decryptToken } = require('./db');

const runningBots = new Map();

async function startBotRuntime() {
  const result = await pool.query(`
    SELECT id, name, username, token_ciphertext,
           token_iv, token_auth_tag
    FROM telegram_bots
    WHERE active = TRUE
      AND token_ciphertext IS NOT NULL
    ORDER BY id ASC
  `);

  console.log(`Customer bots found: ${result.rows.length}`);

  for (const record of result.rows) {
    if (runningBots.has(String(record.id))) continue;

    try {
      const token = decryptToken(record);
      const clientBot = new Bot(token);

      clientBot.command('start', async (ctx) => {
        await ctx.reply(
          `أهلاً بك في ${record.name} 👋\n\n` +
          'هذا بوت النشاط، وسيتم إعداد خدماته قريباً.'
        );
      });

      clientBot.command('help', async (ctx) => {
        await ctx.reply(
          `مساعدة ${record.name}\n\n` +
          'سيتم تفعيل خدمات هذا البوت بعد إعداد مواصفاته.'
        );
      });

      clientBot.catch((err) => {
        console.error(
          `CUSTOMER BOT ${record.id} UPDATE ERROR:`,
          err.error_code || '',
          err.message || ''
        );
      });

      runningBots.set(String(record.id), clientBot);

      clientBot.start({
        onStart: (info) => {
          console.log(
            `Customer bot ${record.id} running: @${info.username}`
          );
        }
      }).catch((err) => {
        runningBots.delete(String(record.id));
        console.error(
          `CUSTOMER BOT ${record.id} POLLING ERROR:`,
          err.error_code || '',
          err.message || ''
        );
      });

    } catch (_) {
      console.error(`Customer bot ${record.id}: startup failed`);
      runningBots.delete(String(record.id));
    }
  }
}

function getRunningBotCount() {
  return runningBots.size;
}

module.exports = {
  startBotRuntime,
  getRunningBotCount
};
