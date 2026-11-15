require('dotenv').config();
const { Bot, Keyboard } = require('grammy');
const fs = require('fs');
const path = require('path');

const token = process.env.TELEGRAM_BOT_TOKEN;
const adminId = process.env.TELEGRAM_ADMIN_ID;
const DB = path.join(__dirname, 'data', 'telegram-bots.json');

if (!token || !adminId) {
  console.error('إعدادات Telegram ناقصة');
  process.exit(1);
}

const bot = new Bot(token);

function isAdmin(ctx) {
  return ctx.from && String(ctx.from.id) === String(adminId);
}

function readDB() {
  try {
    const data = JSON.parse(fs.readFileSync(DB, 'utf8'));
    return { bots: Array.isArray(data.bots) ? data.bots : [] };
  } catch {
    return { bots: [] };
  }
}

function menu() {
  return new Keyboard()
    .text('🤖 البوتات').text('➕ إضافة بوت').row()
    .text('📊 الإحصائيات').text('⚙️ الإعدادات').row()
    .text('🏠 الرئيسية')
    .resized();
}

bot.command('start', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('⛔ غير مصرح لك.');
  await ctx.reply(
    '👑 BOSS BOT MASTER\n\nأهلاً بك في مركز إدارة جميع البوتات.',
    { reply_markup: menu() }
  );
});

bot.command('id', async (ctx) => {
  await ctx.reply(`Telegram ID: ${ctx.from.id}`);
});

bot.command('bots', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('⛔ غير مصرح لك.');
  const bots = readDB().bots;
  if (!bots.length) return ctx.reply('🤖 لا توجد بوتات مسجلة حتى الآن.');
  const lines = bots.map((b, i) =>
    `${i + 1}. ${b.name || 'بدون اسم'}\nالحساب: ${b.username ? '@' + b.username : 'غير معروف'}\nالحالة: ${b.active ? '🟢 فعال' : '🔴 متوقف'}`
  );
  await ctx.reply('🤖 قائمة البوتات:\n\n' + lines.join('\n\n'));
});

bot.command('stats', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('⛔ غير مصرح لك.');
  const bots = readDB().bots;
  const active = bots.filter(b => b.active).length;
  await ctx.reply(
    `📊 إحصائيات النظام\n\n` +
    `إجمالي البوتات: ${bots.length}\n` +
    `البوتات الفعالة: ${active}\n` +
    `البوتات المتوقفة: ${bots.length - active}`
  );
});

bot.on('message:text', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('⛔ غير مصرح لك باستخدام لوحة الإدارة.');

  const text = ctx.message.text;

  if (text === '🏠 الرئيسية' || text === '/menu') {
    return ctx.reply('👑 القائمة الرئيسية', { reply_markup: menu() });
  }

  if (text === '🤖 البوتات') {
    const bots = readDB().bots;
    if (!bots.length) {
      return ctx.reply(
        '🤖 لا توجد بوتات مسجلة حالياً.\n\nسنضيف أول بوت نشاط بعد تجهيز التسجيل الآمن.',
        { reply_markup: menu() }
      );
    }
    const lines = bots.map((b, i) =>
      `${i + 1}. ${b.name || 'بدون اسم'} — ${b.username ? '@' + b.username : 'غير معروف'} — ${b.active ? '🟢 فعال' : '🔴 متوقف'}`
    );
    return ctx.reply('🤖 البوتات المسجلة:\n\n' + lines.join('\n'));
  }

  if (text === '➕ إضافة بوت') {
    return ctx.reply(
      '➕ إضافة بوت نشاط جديد\n\n' +
      '1. أنشئ البوت من @BotFather.\n' +
      '2. سنضيف الرمز من Termux بطريقة مخفية وآمنة.\n' +
      '3. بعد تسجيله سيظهر هنا ويمكن إدارته من تلغرام.\n\n' +
      'لا ترسل Token داخل هذه المحادثة حفاظاً على أمانه.'
    );
  }

  if (text === '📊 الإحصائيات') {
    const bots = readDB().bots;
    const active = bots.filter(b => b.active).length;
    return ctx.reply(
      `📊 إحصائيات BOSS BOT MASTER\n\n` +
      `إجمالي البوتات: ${bots.length}\n` +
      `الفعالة: ${active}\n` +
      `المتوقفة: ${bots.length - active}`
    );
  }

  if (text === '⚙️ الإعدادات') {
    return ctx.reply(
      '⚙️ إعدادات النظام\n\n' +
      `معرّف المدير: ${adminId}\n` +
      `قاعدة البيانات: محلية وآمنة\n` +
      `وضع الإدارة: المدير الرئيسي فقط\n` +
      `محرك واتساب: منفصل عن تلغرام`
    );
  }

  return ctx.reply('اختر أحد أزرار القائمة.', { reply_markup: menu() });
});

bot.catch((err) => console.error('Telegram error:', err.message));

bot.start({
  onStart: (info) => console.log(`BOSS BOT MASTER يعمل: @${info.username}`)
});
