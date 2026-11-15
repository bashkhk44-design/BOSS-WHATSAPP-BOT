require('dotenv').config();

const { Bot, Keyboard } = require('grammy');
const {
  pool,
  initDatabase,
  insertTelegramBot,
  acquireTelegramRuntimeLock,
  releaseTelegramRuntimeLock
} = require('./db');

const { startBotRuntime, stopBotRuntime } = require('./bot-runtime');
const { startIntakeBot, stopIntakeBot } = require('./intake-bot');

const token = process.env.TELEGRAM_BOT_TOKEN;
const adminId = process.env.TELEGRAM_ADMIN_ID;

if (!token || !adminId) {
  console.error('إعدادات Telegram ناقصة');
  process.exit(1);
}

const bot = new Bot(token);
const pendingAdds = new Map();

function isAdmin(ctx) {
  return ctx.from && String(ctx.from.id) === String(adminId);
}

function menu() {
  return new Keyboard()
    .text('🤖 البوتات').text('➕ إضافة بوت').row()
    .text('📊 الإحصائيات').text('⚙️ الإعدادات').row()
    .text('🏠 الرئيسية')
    .resized();
}

async function getBots() {
  const result = await pool.query(
    'SELECT id, name, username, active FROM telegram_bots ORDER BY id DESC'
  );
  return result.rows;
}

async function showBots(ctx) {
  const bots = await getBots();

  if (!bots.length) {
    return ctx.reply('🤖 لا توجد بوتات مسجلة حالياً.');
  }

  const lines = bots.map((b, i) =>
    `${i + 1}. ${b.name}\nالحساب: ${b.username ? '@' + b.username : 'غير معروف'}\nالحالة: ${b.active ? '🟢 فعال' : '🔴 متوقف'}`
  );

  return ctx.reply('🤖 قائمة البوتات:\n\n' + lines.join('\n\n'));
}

async function showStats(ctx) {
  const bots = await getBots();
  const active = bots.filter(b => b.active).length;

  return ctx.reply(
    `📊 إحصائيات BOSS BOT MASTER\n\n` +
    `إجمالي البوتات: ${bots.length}\n` +
    `الفعالة: ${active}\n` +
    `المتوقفة: ${bots.length - active}`
  );
}

bot.command('start', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('⛔ غير مصرح لك.');

  return ctx.reply(
    '👑 BOSS BOT MASTER\n\nأهلاً بك في مركز إدارة جميع البوتات.',
    { reply_markup: menu() }
  );
});

bot.command('id', async (ctx) => {
  await ctx.reply(`Telegram ID: ${ctx.from.id}`);
});

bot.command('cancel', async (ctx) => {
  if (!isAdmin(ctx)) return;
  pendingAdds.delete(ctx.from.id);
  await ctx.reply('تم إلغاء عملية إضافة البوت.', {
    reply_markup: menu()
  });
});

bot.command('bots', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('⛔ غير مصرح لك.');
  await showBots(ctx);
});

bot.command('stats', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('⛔ غير مصرح لك.');
  await showStats(ctx);
});

bot.on('message:text', async (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.reply('⛔ غير مصرح لك باستخدام لوحة الإدارة.');
  }

  const text = ctx.message.text;
  const userId = ctx.from.id;
  const pending = pendingAdds.get(userId);

  if (pending) {
    if (text === 'إلغاء' || text === 'الغاء') {
      pendingAdds.delete(userId);
      return ctx.reply('تم إلغاء الإضافة.', {
        reply_markup: menu()
      });
    }

    if (pending.step === 'name') {
      const name = text.trim();

      if (name.length < 2 || name.length > 80) {
        return ctx.reply('اكتب اسماً بين حرفين و80 حرفاً.');
      }

      pendingAdds.set(userId, {
        step: 'token',
        name
      });

      return ctx.reply(
        '🔐 أرسل Token البوت الآن برسالة واحدة.\n\n' +
        'سيحاول النظام حذف رسالة الرمز فور استلامها.\n' +
        'لا ترسل أي رمز إلا في المحادثة الخاصة مع بوت المدير.'
      );
    }

    if (pending.step === 'token') {
      const newToken = text.trim();

      // محاولة حذف رسالة الرمز فوراً
      try {
        await ctx.deleteMessage();
      } catch (_) {
        // لا نسجل الرمز في السجلات
      }

      if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(newToken)) {
        pendingAdds.delete(userId);
        return ctx.reply(
          '❌ صيغة Token غير صحيحة. ابدأ الإضافة من جديد.',
          { reply_markup: menu() }
        );
      }

      try {
        const candidate = new Bot(newToken);
        const me = await candidate.api.getMe();

        const saved = await insertTelegramBot({
          name: pending.name,
          username: me.username || null,
          token: newToken
        });

        pendingAdds.delete(userId);

        return ctx.reply(
          `✅ تمت إضافة البوت بنجاح!\n\n` +
          `الاسم: ${saved.name}\n` +
          `الحساب: @${me.username}\n` +
          `رقم التسجيل: ${saved.id}\n` +
          `الحالة: 🟢 مسجل في قاعدة البيانات\n\n` +
          'تم حفظ الرمز بصورة مشفرة.',
          { reply_markup: menu() }
        );

      } catch (err) {
        pendingAdds.delete(userId);

        if (err.code === '23505') {
          return ctx.reply(
            '⚠️ هذا البوت مسجل مسبقاً.',
            { reply_markup: menu() }
          );
        }

        if (err.error_code || err.description) {
          return ctx.reply(
            '❌ تعذر التحقق من Token. تأكد من صحته ومن BotFather، ثم أعد المحاولة.',
            { reply_markup: menu() }
          );
        }

        console.error('Bot registration failed:', err.code || 'unknown');

        return ctx.reply(
          '❌ تعذر حفظ البوت. تحقق من إعدادات التشفير وقاعدة البيانات.',
          { reply_markup: menu() }
        );
      }
    }
  }

  if (text === '🏠 الرئيسية' || text === '/menu') {
    return ctx.reply('👑 القائمة الرئيسية', {
      reply_markup: menu()
    });
  }

  if (text === '🤖 البوتات') {
    return showBots(ctx);
  }

  if (text === '➕ إضافة بوت') {
    pendingAdds.set(userId, { step: 'name' });

    return ctx.reply(
      '➕ إضافة بوت جديد\n\n' +
      'أرسل اسم البوت الذي تريد تسجيله.\n\n' +
      'للإلغاء أرسل: إلغاء'
    );
  }

  if (text === '📊 الإحصائيات') {
    return showStats(ctx);
  }

  if (text === '⚙️ الإعدادات') {
    return ctx.reply(
      '⚙️ إعدادات النظام\n\n' +
      `معرّف المدير: ${adminId}\n` +
      'قاعدة البيانات: Neon PostgreSQL\n' +
      'تشفير رموز البوتات: AES-256-GCM\n' +
      'وضع الإدارة: المدير الرئيسي فقط\n' +
      'محرك واتساب: منفصل عن تلغرام'
    );
  }

  return ctx.reply('اختر أحد أزرار القائمة.', {
    reply_markup: menu()
  });
});

bot.catch((err) => {
  console.error('Telegram error:', err.message);
});

async function start() {
  await initDatabase();

  const locked = await acquireTelegramRuntimeLock();

  if (!locked) {
    throw new Error('هناك نسخة أخرى تشغّل بوتات تلغرام بالفعل؛ تم منع التشغيل المكرر');
  }

  await startBotRuntime();
  await startIntakeBot();

  bot.start({
    onStart: (info) =>
      console.log(`BOSS BOT MASTER يعمل: @${info.username}`)
  }).catch(async (err) => {
    console.error(
      'MASTER POLLING ERROR:',
      err.error_code || '',
      err.message || ''
    );

    await shutdown('MASTER_POLLING_ERROR', 1);
  });
}

let shuttingDown = false;

async function shutdown(signal, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log('Shutting down Telegram runtime:', signal);

  try {
    await stopIntakeBot();
  } catch (err) {
    console.error('INTAKE BOT STOP ERROR:', err.message);
  }

  try {
    await bot.stop();
  } catch (err) {
    console.error('MASTER BOT STOP ERROR:', err.message);
  }

  try {
    await stopBotRuntime();
  } catch (err) {
    console.error('CUSTOMER BOTS STOP ERROR:', err.message);
  }

  try {
    await releaseTelegramRuntimeLock();
  } catch (err) {
    console.error('RUNTIME LOCK RELEASE ERROR:', err.message);
  }

  try {
    await pool.end();
  } catch (err) {
    console.error('DATABASE SHUTDOWN ERROR:', err.message);
  }

  process.exit(exitCode);
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));

start().catch(async (err) => {
  console.error(
    'فشل تشغيل قاعدة البيانات أو البوت:',
    err.message
  );

  await shutdown('STARTUP_ERROR', 1);
});
