require('dotenv').config();

const { Bot, Keyboard } = require('grammy');
const { pool, initDatabase } = require('./db');

const token = process.env.TELEGRAM_BOT_TOKEN;
const adminId = process.env.TELEGRAM_ADMIN_ID;

if (!token || !adminId) {
  console.error('إعدادات Telegram ناقصة');
  process.exit(1);
}

const bot = new Bot(token);

function isAdmin(ctx) {
  return ctx.from && String(ctx.from.id) === String(adminId);
}

async function getBots() {
  const result = await pool.query(
    'SELECT id, name, username, active FROM telegram_bots ORDER BY id DESC'
  );
  return result.rows;
}

function menu() {
  return new Keyboard()
    .text('🤖 البوتات').text('➕ إضافة بوت').row()
    .text('📊 الإحصائيات').text('⚙️ الإعدادات').row()
    .text('🏠 الرئيسية')
    .resized();
}

async function showBots(ctx) {
  const bots = await getBots();

  if (!bots.length) {
    return ctx.reply('🤖 لا توجد بوتات مسجلة حالياً.');
  }

  const lines = bots.map((b, i) =>
    `${i + 1}. ${b.name || 'بدون اسم'}\nالحساب: ${b.username ? '@' + b.username : 'غير معروف'}\nالحالة: ${b.active ? '🟢 فعال' : '🔴 متوقف'}`
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

  if (text === '🏠 الرئيسية' || text === '/menu') {
    return ctx.reply('👑 القائمة الرئيسية', { reply_markup: menu() });
  }

  if (text === '🤖 البوتات') {
    return showBots(ctx);
  }

  if (text === '➕ إضافة بوت') {
    return ctx.reply(
      '➕ إضافة بوت نشاط جديد\n\n' +
      '1. أنشئ البوت من @BotFather.\n' +
      '2. سنضيف الرمز بطريقة مخفية وآمنة.\n' +
      '3. بعد تسجيله سيظهر هنا ويمكن إدارته من تلغرام.\n\n' +
      'لا ترسل Token داخل هذه المحادثة حفاظاً على أمانه.'
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
      'وضع الإدارة: المدير الرئيسي فقط\n' +
      'محرك واتساب: منفصل عن تلغرام'
    );
  }

  return ctx.reply('اختر أحد أزرار القائمة.', { reply_markup: menu() });
});

bot.catch((err) => {
  console.error('Telegram error:', err.message);
});

async function start() {
  await initDatabase();
  bot.start({
    onStart: (info) => console.log(`BOSS BOT MASTER يعمل: @${info.username}`)
  });
}

start().catch((err) => {
  console.error('فشل تشغيل قاعدة البيانات أو البوت:', err.message);
  process.exit(1);
});
