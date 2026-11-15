const { Bot } = require('grammy');
const { pool, decryptToken } = require('./db');

const runningBots = new Map();
let runtimeStopping = false;

function waitForRetry(ms, state) {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(state.retryTimer);
      state.retryTimer = null;
      state.wakeRetry = null;
      resolve();
    };

    state.retryTimer = setTimeout(finish, ms);
    state.wakeRetry = finish;
  });
}

function createCustomerBot(record, token, state) {
  const clientBot = new Bot(token, { client: { timeoutSeconds: 45 } });

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

  return clientBot;
}

async function runCustomerBot(record, state) {
  let token;

  try {
    token = decryptToken(record);
  } catch (err) {
    state.status = 'error';
    console.error(
      `CUSTOMER BOT ${record.id} TOKEN DECRYPTION FAILED:`,
      err.message
    );
    return;
  }

  while (!runtimeStopping && !state.stopRequested) {
    const startedAt = Date.now();
    let clientBot = null;

    try {
      clientBot = createCustomerBot(record, token, state);
      state.bot = clientBot;
      state.status = 'starting';

      await clientBot.start({
        onStart: (info) => {
          state.status = 'running';
          console.log(
            `Customer bot ${record.id} running: @${info.username}`
          );
        }
      });

      if (runtimeStopping || state.stopRequested) break;

      throw new Error('Polling loop ended unexpectedly');

    } catch (err) {
      state.bot = null;

      if (runtimeStopping || state.stopRequested) break;

      const errorCode = Number(err.error_code || 0);

      if (errorCode === 409 || errorCode === 401) {
        state.status = errorCode === 409 ? 'conflict' : 'unauthorized';

        console.error(
          `CUSTOMER BOT ${record.id} STOPPED:`,
          errorCode,
          err.message || ''
        );

        break;
      }

      if (Date.now() - startedAt >= 300000) {
        state.retryCount = 0;
      }

      state.retryCount += 1;

      const retryAfter = Number(err.parameters?.retry_after || 0);

      const delay = retryAfter > 0
        ? retryAfter * 1000 + 1000
        : Math.min(
            60000,
            2000 * Math.pow(2, Math.min(state.retryCount - 1, 5))
          ) + Math.floor(Math.random() * 1000);

      state.status = 'retrying';

      console.error(
        `CUSTOMER BOT ${record.id} RETRY ${state.retryCount} IN ${Math.ceil(delay / 1000)}s:`,
        errorCode,
        err.message || ''
      );

      await waitForRetry(delay, state);
    }
  }

  state.bot = null;

  if (state.status !== 'conflict' && state.status !== 'unauthorized' && state.status !== 'error') {
    state.status = 'stopped';
  }

  console.log(`CUSTOMER BOT ${record.id} runtime ended: ${state.status}`);
}

async function startBotRuntime() {
  runtimeStopping = false;

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
    const id = String(record.id);

    if (runningBots.has(id)) continue;

    const state = {
      bot: null,
      task: null,
      status: 'starting',
      retryCount: 0,
      stopRequested: false,
      retryTimer: null,
      wakeRetry: null
    };

    runningBots.set(id, state);

    state.task = runCustomerBot(record, state).catch((err) => {
      state.status = 'error';
      console.error(`CUSTOMER BOT ${id} RUNTIME FAILURE:`, err.message);
    });
  }
}

async function stopBotRuntime() {
  runtimeStopping = true;

  const states = Array.from(runningBots.values());

  for (const state of states) {
    state.stopRequested = true;
    if (state.wakeRetry) state.wakeRetry();
  }

  await Promise.allSettled(
    states.map(async (state) => {
      if (state.bot) {
        try {
          await state.bot.stop();
        } catch (err) {
          console.error('CUSTOMER BOT STOP ERROR:', err.message);
        }
      }

      if (state.task) {
        await state.task;
      }
    })
  );

  runningBots.clear();
}

function getRunningBotCount() {
  return Array.from(runningBots.values())
    .filter((state) => state.status === 'running')
    .length;
}

module.exports = {
  startBotRuntime,
  stopBotRuntime,
  getRunningBotCount
};
