require('dotenv').config();

const { Bot, Keyboard, InlineKeyboard } = require('grammy');
const {
  pool,
  initDatabase,
  insertTelegramBot,
  acquireTelegramRuntimeLock,
  isTelegramRuntimeLockHeld,
  releaseTelegramRuntimeLock,
  setRuntimeLockFailureHandler
} = require('./db');

const { startBotRuntime, stopBotRuntime, getRunningBotCount } = require('./bot-runtime');
const {
  createProjectAiJob,
  getLatestCompletedProjectAiJob,
  markProjectAiJobRunning,
  completeProjectAiJob,
  failProjectAiJob,
  recoverInterruptedProjectAiJobs,
  getProjectApprovalState,
  approveProjectMilestone
} = require('./project-db');
const { startIntakeBot, stopIntakeBot } = require('./intake-bot');
const { analyzeProject } = require('./gemini-analyst');
const { designProject } = require('./ai-designer');
const { runProjectPipeline } = require('./project-pipeline');
const { getGeminiModel } = require('./ai-router');

const token = process.env.TELEGRAM_BOT_TOKEN;
const adminId = process.env.TELEGRAM_ADMIN_ID;

if (!token || !adminId) {
  console.error('إعدادات Telegram ناقصة');
  process.exit(1);
}

const bot = new Bot(token, { client: { timeoutSeconds: 45 } });
const pendingAdds = new Map();

function isAdmin(ctx) {
  return ctx.from && String(ctx.from.id) === String(adminId);
}

function designKeyboard(projectId) {
  return new InlineKeyboard().text('🎨 بدء AI DESIGNER', `project:design:${projectId}`);
}

function projectApprovalKeyboard(projectId, designJobId, approvals) {
  const pointsApproved = approvals?.construction_points_approved === true;
  const designApproved = approvals?.design_approved === true;
  const keyboard = new InlineKeyboard()
    .text((pointsApproved ? '✅ ' : '⬜ ') + 'اعتماد نقاط البناء', `project:approve:points:${projectId}:${designJobId}`)
    .row()
    .text((designApproved ? '✅ ' : '⬜ ') + 'اعتماد التصميم', `project:approve:design:${projectId}:${designJobId}`);

  if (pointsApproved && designApproved) {
    keyboard.row().text('🚀 تنفيذ المشروع بالكامل', `project:pipeline:${projectId}`);
  }
  return keyboard;
}

async function sendProjectApprovalPanel(ctx, projectId, designJob) {
  const approvals = await getProjectApprovalState({
    projectId,
    specVersion: designJob.spec_version,
    designJobId: designJob.id
  });

  await ctx.reply(
    '📋 اعتماد المشروع قبل التنفيذ\n\n' +
    '1. نقاط البناء: ' + (approvals?.construction_points_approved ? '✅ معتمدة' : '⏳ بانتظار اعتمادك') + '\n' +
    '2. وثيقة التصميم: ' + (approvals?.design_approved ? '✅ معتمدة' : '⏳ بانتظار اعتمادك') + '\n\n' +
    'لن يبدأ التنفيذ الكامل إلا بعد اعتماد النقطتين.',
    { reply_markup: projectApprovalKeyboard(projectId, designJob.id, approvals) }
  );
}

async function showProjects(ctx) {
  const result = await pool.query(`
    SELECT
      p.id, p.name, p.business_type, p.status,
      c.first_name, c.telegram_username, c.telegram_user_id
    FROM client_projects p
    JOIN clients c ON c.id = p.client_id
    ORDER BY p.created_at DESC
    LIMIT 50
  `);

  if (!result.rows.length) {
    return ctx.reply('📁 لا توجد مشاريع مسجلة حالياً.');
  }

  const { InlineKeyboard } = require('grammy');
  const labels = {
    collecting_requirements: 'يجمع المتطلبات',
    spec_approved: 'المواصفات معتمدة',
    completed: 'مكتمل',
    cancelled: 'ملغى'
  };

  await ctx.reply(`📁 مشاريع العملاء (آخر ${result.rows.length} مشروع):`);

  for (const p of result.rows) {
    const client = p.first_name || p.telegram_username || p.telegram_user_id;
    const status = labels[p.status] || p.status;
    const message =
      `📁 مشروع رقم ${p.id}\n` +
      `الاسم: ${p.name}\n` +
      `العميل: ${client}\n` +
      `النشاط: ${p.business_type || 'غير محدد'}\n` +
      `الحالة: ${status}`;

    if (p.status === 'spec_approved') {
      const keyboard = new InlineKeyboard()
        .text('🧠 AI ANALYST', `project:ai:${p.id}`)
        .text('🎨 AI DESIGNER', `project:design:${p.id}`)
        .row()
        .text('🚀 تنفيذ المشروع بالكامل', `project:pipeline:${p.id}`);
      await ctx.reply(message, { reply_markup: keyboard });
    } else {
      await ctx.reply(message);
    }
  }
}


function menu() {
  return new Keyboard()
    .text('🤖 البوتات').text('📁 المشاريع').row()
    .text('➕ إضافة بوت').text('📊 الإحصائيات').row()
    .text('⚙️ الإعدادات').text('🏠 الرئيسية')
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


async function getApprovedProjectForAnalysis(projectId) {
  const result = await pool.query(`
    SELECT
      p.id AS project_id,
      p.name AS project_name,
      p.business_type,
      p.status,
      c.telegram_user_id,
      c.telegram_username,
      c.first_name,
      s.version AS spec_version,
      s.spec
    FROM client_projects p
    JOIN clients c ON c.id = p.client_id
    JOIN LATERAL (
      SELECT version, spec
      FROM project_specs
      WHERE project_id = p.id AND status = 'approved'
      ORDER BY version DESC
      LIMIT 1
    ) s ON TRUE
    WHERE p.id = $1 AND p.status = 'spec_approved'
  `, [projectId]);

  return result.rows[0] || null;
}

bot.callbackQuery(/^project:ai:(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.answerCallbackQuery({ text: 'غير مصرح لك.' });
  }

  const projectId = Number(ctx.match[1]);

  await ctx.answerCallbackQuery({
    text: 'جارٍ تجهيز تحليل المشروع...'
  });

  try {
    const project = await getApprovedProjectForAnalysis(projectId);

    if (!project) {
      return ctx.reply(
        'تعذر العثور على المشروع أو لا توجد مواصفات معتمدة له.'
      );
    }

    const job = await createProjectAiJob({
      projectId,
      adminTelegramId: ctx.from.id
    });

    if (job.status === 'completed') {
      const previousText = job.analysis && job.analysis.text;

      if (previousText) {
        await ctx.reply('هذا الإصدار محلل مسبقاً. التقرير المحفوظ:');
        for (let i = 0; i < previousText.length; i += 3500) {
          await ctx.reply(previousText.slice(i, i + 3500));
        }
        await ctx.reply('التحليل محفوظ. يمكنك الآن إنشاء تصميم المشروع:', {
          reply_markup: designKeyboard(projectId)
        });
      } else {
        await ctx.reply('هذا الإصدار محلل مسبقاً، لكن لا يوجد نص تقرير محفوظ.');
      }
      return;
    }

    if (job.status === 'running') {
      return ctx.reply('⏳ تحليل هذا المشروع قيد التنفيذ بالفعل.');
    }

    const claimed = await markProjectAiJobRunning(job.id);

    if (!claimed) {
      return ctx.reply('⏳ المهمة قيد المعالجة أو تغيرت حالتها. تحقق من قائمة المهام.');
    }

    await ctx.reply(
      `🤖 بدأ AI ANALYST تحليل المشروع رقم ${projectId}.\n` +
      'سأرسل التقرير عند انتهاء التحليل.'
    );

    let analysis;

    try {
      analysis = await analyzeProject({ project });

      const saved = await completeProjectAiJob(job.id, analysis);

      if (!saved) {
        throw new Error('تعذر حفظ نتيجة التحليل في قاعدة البيانات.');
      }
    } catch (error) {
      try {
        await failProjectAiJob(job.id, error.message);
      } catch (dbError) {
        console.error('AI JOB FAILURE SAVE ERROR:', dbError.message);
      }

      console.error('GEMINI ANALYSIS ERROR:', error.message);

      await ctx.reply(
        '❌ تعذر إكمال تحليل Gemini أو حفظ نتيجته.\n' +
        'تم تسجيل فشل المهمة إن أمكن. تحقق من إعدادات Gemini وسجلات Render.'
      );
      return;
    }

    try {
      await ctx.reply(
        `✅ اكتمل تحليل المشروع رقم ${projectId}.\n` +
        `النموذج: ${analysis.model}\n` +
        'التقرير:'
      );

      for (let i = 0; i < analysis.text.length; i += 3500) {
        await ctx.reply(analysis.text.slice(i, i + 3500));
      }
      await ctx.reply('اكتمل التحليل. الخطوة التالية هي تصميم تجربة البوت:', {
        reply_markup: designKeyboard(projectId)
      });
    } catch (deliveryError) {
      console.error('AI REPORT DELIVERY ERROR:', deliveryError.message);

      try {
        await ctx.reply(
          '✅ التحليل اكتمل وحُفظ بنجاح، لكن تعذر إرسال التقرير كاملاً. ' +
          'يمكنك طلب التحليل مرة أخرى لاستعادة التقرير المحفوظ.'
        );
      } catch (noticeError) {
        console.error('AI DELIVERY NOTICE ERROR:', noticeError.message);
      }
    }
  } catch (error) {
    console.error('PROJECT AI HANDLER ERROR:', error.message);
    await ctx.reply(
      '❌ تعذر تجهيز مهمة التحليل. تحقق من قاعدة البيانات وحالة اعتماد المشروع.'
    );
  }
});


bot.callbackQuery(/^project:design:(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.answerCallbackQuery({ text: 'غير مصرح لك.' });
  }

  const projectId = Number(ctx.match[1]);
  await ctx.answerCallbackQuery({ text: 'جارٍ تجهيز التصميم...' });

  try {
    const project = await getApprovedProjectForAnalysis(projectId);
    if (!project) {
      return ctx.reply('تعذر العثور على مشروع معتمد.');
    }

    const analysisJob = await getLatestCompletedProjectAiJob({
      projectId,
      jobType: 'analysis'
    });

    if (!analysisJob || !analysisJob.analysis || !analysisJob.analysis.text) {
      return ctx.reply('يجب إكمال AI ANALYST أولاً قبل بدء التصميم.');
    }

    const job = await createProjectAiJob({
      projectId,
      adminTelegramId: ctx.from.id,
      jobType: 'design'
    });

    if (job.status === 'completed' && job.analysis?.text) {
      await ctx.reply('🎨 التصميم محفوظ مسبقاً:');
      for (let i = 0; i < job.analysis.text.length; i += 3500) {
        await ctx.reply(job.analysis.text.slice(i, i + 3500));
      }
      await sendProjectApprovalPanel(ctx, projectId, job);
      return;
    }

    if (job.status === 'running') {
      return ctx.reply('⏳ تصميم هذا المشروع قيد التنفيذ بالفعل.');
    }

    const claimed = await markProjectAiJobRunning(job.id);
    if (!claimed) {
      return ctx.reply('المهمة قيد المعالجة أو تغيرت حالتها. حاول التحقق لاحقاً.');
    }

    await ctx.reply('🎨 بدأ AI DESIGNER إعداد تجربة المشروع. سأرسل وثيقة التصميم عند اكتمالها.');

    let design;
    try {
      design = await designProject({
        project,
        analysis: analysisJob.analysis
      });

      const saved = await completeProjectAiJob(job.id, design);
      if (!saved) {
        throw new Error('تعذر حفظ وثيقة التصميم في قاعدة البيانات.');
      }
    } catch (error) {
      try {
        await failProjectAiJob(job.id, error.message);
      } catch (dbError) {
        console.error('DESIGN JOB FAILURE SAVE ERROR:', dbError.message);
      }

      console.error('AI DESIGNER ERROR:', error.message);
      await ctx.reply('❌ تعذر إكمال التصميم أو حفظه. تحقق من سجلات Render.');
      return;
    }

    await ctx.reply(
      `✅ اكتمل تصميم المشروع رقم ${projectId}.\nالنموذج: ${design.model}\nوثيقة التصميم:`
    );

    for (let i = 0; i < design.text.length; i += 3500) {
      await ctx.reply(design.text.slice(i, i + 3500));
    }
    await sendProjectApprovalPanel(ctx, projectId, job);
  } catch (error) {
    console.error('PROJECT DESIGN HANDLER ERROR:', error.message);
    await ctx.reply('❌ تعذر تجهيز مهمة التصميم. تحقق من قاعدة البيانات وحالة التحليل.');
  }
});




bot.callbackQuery(/^project:approve:(points|design):(\d+):(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.answerCallbackQuery({ text: 'غير مصرح لك.' });
  }

  const approvalType = ctx.match[1] === 'points' ? 'construction_points' : 'design';
  const projectId = Number(ctx.match[2]);
  const designJobId = Number(ctx.match[3]);

  await ctx.answerCallbackQuery({ text: 'جارٍ حفظ الاعتماد...' });

  try {
    const approved = await approveProjectMilestone({
      projectId,
      designJobId,
      approvalType,
      adminTelegramId: ctx.from.id
    });

    const pointsApproved = approved.construction_points_approved === true;
    const designApproved = approved.design_approved === true;

    await ctx.reply(
      '✅ تم حفظ الاعتماد في قاعدة البيانات.\n\n' +
      'نقاط البناء: ' + (pointsApproved ? '✅ معتمدة' : '⏳ بانتظار الاعتماد') + '\n' +
      'التصميم: ' + (designApproved ? '✅ معتمد' : '⏳ بانتظار الاعتماد') + '\n\n' +
      (pointsApproved && designApproved
        ? 'اكتمل الاعتمادان. أصبح بإمكانك بدء التنفيذ الكامل.'
        : 'اعتمد النقطة المتبقية لإتاحة التنفيذ الكامل.'),
      { reply_markup: projectApprovalKeyboard(projectId, designJobId, approved) }
    );
  } catch (error) {
    console.error('PROJECT APPROVAL ERROR:', error.message);
    await ctx.reply('❌ لم يتم حفظ الاعتماد: ' + String(error.message || error).slice(0, 1000));
  }
});

bot.callbackQuery(/^project:pipeline:(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.answerCallbackQuery({ text: 'غير مصرح لك.' });
  }

  const projectId = Number(ctx.match[1]);
  await ctx.answerCallbackQuery({ text: 'جارٍ التحقق من الاعتمادات...' });

  try {
    const project = await getApprovedProjectForAnalysis(projectId);

    if (!project) {
      return ctx.reply('تعذر العثور على مشروع ذي مواصفات معتمدة.');
    }

    await ctx.reply('🚀 بدأ التنفيذ الكامل للمشروع رقم ' + projectId);

    const result = await runProjectPipeline({
      project,
      adminTelegramId: ctx.from.id,
      onProgress: async (message) => {
        await ctx.reply('⚙️ ' + message);
      }
    });

    if (!result.completed) {
      return ctx.reply(
        '❌ توقف التنفيذ قبل النشر.\n' + result.summary
      );
    }

    await ctx.reply(
      '✅ اكتمل البناء والاختبار للمشروع رقم ' + projectId +
      '\n' + result.summary +
      '\nحالة النشر: لم يُنشر بعد، وينتظر ربط الاستضافة وموافقة المدير.'
    );
  } catch (error) {
    console.error('PROJECT PIPELINE ERROR:', error);
    await ctx.reply(
      '❌ تعذر إكمال التنفيذ: ' +
      String(error.message || error).slice(0, 2000)
    );
  }
});

function settingsKeyboard() {
  return new InlineKeyboard()
    .text('🧠 Gemini', 'settings:gemini')
    .text('🗄️ قاعدة البيانات', 'settings:database')
    .row()
    .text('🔐 الأمان والتشفير', 'settings:security')
    .text('🤖 حالة البوتات', 'settings:services')
    .row()
    .text('🔄 تحديث المركز', 'settings:main');
}

async function showSettingsResult(ctx, message) {
  try {
    await ctx.editMessageText(message, {
      reply_markup: settingsKeyboard()
    });
  } catch (_) {
    await ctx.reply(message, {
      reply_markup: settingsKeyboard()
    });
  }
}

bot.callbackQuery(/^settings:(main|database|security|services|gemini|gemini:test)$/, async (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.answerCallbackQuery({ text: 'غير مصرح لك.' });
  }

  const section = ctx.match[1];
  await ctx.answerCallbackQuery(
    section === 'gemini:test'
      ? { text: 'بدأ اختبار اتصال Gemini...' }
      : {}
  );

  if (section === 'main') {
    return showSettingsResult(
      ctx,
      '⚙️ مركز إعدادات BOSS BOT MASTER\nاختر القسم الذي تريد فحصه:'
    );
  }

  if (section === 'database') {
    try {
      const result = await pool.query('SELECT NOW() AS server_time');
      return showSettingsResult(
        ctx,
        '🗄️ فحص قاعدة البيانات\n\n' +
        'الحالة: ✅ الاتصال ناجح\n' +
        'الخادم: Neon PostgreSQL\n' +
        'وقت استجابة الخادم: ' +
        new Date(result.rows[0].server_time).toLocaleString('en-GB', { timeZone: 'UTC' }) +
        ' UTC'
      );
    } catch (error) {
      console.error('SETTINGS DATABASE CHECK:', error.message);
      return showSettingsResult(
        ctx,
        '🗄️ فحص قاعدة البيانات\n\n❌ تعذر الاتصال بقاعدة البيانات. راجع إعداد DATABASE_URL وسجلات Render.'
      );
    }
  }

  if (section === 'security') {
    const encryptionReady = /^[0-9a-fA-F]{64}$/.test(
      process.env.BOTS_ENCRYPTION_KEY || ''
    );
    const adminReady = /^\d+$/.test(String(adminId || ''));

    return showSettingsResult(
      ctx,
      '🔐 فحص الأمان\n\n' +
      'معرّف المدير: ' + (adminReady ? '✅ مضبوط' : '❌ غير صالح') + '\n' +
      'مفتاح تشفير AES-256: ' + (encryptionReady ? '✅ التنسيق صحيح' : '❌ غير مضبوط أو تنسيقه غير صحيح') + '\n' +
      'حماية الرموز: AES-256-GCM\n' +
      'عرض المفاتيح السرية: ممنوع'
    );
  }

  if (section === 'services') {
    let runningCount = 0;
    try {
      runningCount = getRunningBotCount();
    } catch (_) {}

    return showSettingsResult(
      ctx,
      '🤖 حالة الخدمات\n\n' +
      'بوت المدير: ✅ يعمل (تم استقبال هذا الطلب)\n' +
      'بوتات العملاء العاملة: ' + runningCount + '\n' +
      'رمز بوت الاستقبال: ' +
      (process.env.INTAKE_BOT_TOKEN ? '✅ مضبوط' : '⚠️ غير مضبوط') + '\n' +
      'المنصة: Telegram فقط'
    );
  }

  if (section === 'gemini') {
    const configured = Boolean(process.env.GEMINI_API_KEY);
    const model = process.env.GEMINI_MODEL || process.env.GEMINI_FREE_MODEL || 'gemini-3.8-flash';

    const keyboard = new InlineKeyboard()
      .text('🧪 اختبار اتصال Gemini', 'settings:gemini:test')
      .row()
      .text('⬅️ العودة للإعدادات', 'settings:main');

    return ctx.editMessageText(
      '🧠 إعدادات Gemini\n\n' +
      'مفتاح API: ' + (configured ? '✅ موجود (مخفي)' : '❌ غير مضبوط') + '\n' +
      'النموذج: ' + model + '\n\n' +
      'يمكنك اختبار الاتصال الفعلي بالضغط على الزر.\n' +
      'لن يتم عرض المفتاح السري.',
      { reply_markup: keyboard }
    );
  }

  if (section === 'gemini:test') {
    if (!process.env.GEMINI_API_KEY) {
      return showSettingsResult(ctx, '❌ لا يوجد GEMINI_API_KEY مضبوط في إعدادات Render.');
    }

    await showSettingsResult(
      ctx,
      '🧠 اختبار Gemini\n\n⏳ جارٍ الاتصال بخدمة Google Gemini...\nقد يستغرق الاختبار حتى دقيقتين.'
    );

    try {
      const { GoogleGenAI } = await import('@google/genai');
      const ai = new GoogleGenAI({
        apiKey: process.env.GEMINI_API_KEY
      });
      const model = getGeminiModel();

      const response = await ai.interactions.create({
        model,
        input: 'Reply with OK.',
        system_instruction: 'You are a connectivity test. Reply briefly.'
      }, {
        timeout_ms: 120000
      });

      if (!response.output_text || !response.output_text.trim()) {
        throw new Error('Gemini returned an empty response');
      }

      return showSettingsResult(
        ctx,
        '🧠 اختبار Gemini\n\n✅ اتصال API ناجح واستلمنا رداً من النموذج.\nالنموذج: ' + model
      );
    } catch (error) {
      console.error('SETTINGS GEMINI TEST:', error.name, error.message, error.status || '');
      return showSettingsResult(
        ctx,
        '🧠 اختبار Gemini\n\n❌ فشل اختبار الاتصال. تحقق من المفتاح واسم النموذج وحالة الخدمة في إعدادات Render.'
      );
    }
  }
});

bot.on('message:text', async (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.reply('⛔ غير مصرح لك باستخدام لوحة الإدارة.');
  }

  const text = ctx.message.text;
  const userId = ctx.from.id;

  const menuCommands = [
    '🏠 الرئيسية', '/menu',
    '🤖 البوتات', '📁 المشاريع',
    '➕ إضافة بوت', '📊 الإحصائيات',
    '⚙️ الإعدادات'
  ];

  // أزرار القائمة لها الأولوية دائماً على حالة الإضافة المعلقة.
  if (menuCommands.includes(text)) {
    pendingAdds.delete(userId);
  } else {
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

        pendingAdds.set(userId, { step: 'token', name });

        return ctx.reply(
          '🔐 أرسل Token البوت الآن برسالة واحدة.\n\n' +
          'سيحاول النظام حذف رسالة الرمز فور استلامها.\n' +
          'لا ترسل أي رمز إلا في المحادثة الخاصة مع بوت المدير.'
        );
      }

      if (pending.step === 'token') {
        const newToken = text.trim();

        try {
          await ctx.deleteMessage();
        } catch (_) {}

        if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(newToken)) {
          pendingAdds.delete(userId);
          return ctx.reply(
            '❌ صيغة Token غير صحيحة. ابدأ الإضافة من جديد.',
            { reply_markup: menu() }
          );
        }

        try {
          const candidate = new Bot(newToken, {
            client: { timeoutSeconds: 45 }
          });
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
            return ctx.reply('⚠️ هذا البوت مسجل مسبقاً.', {
              reply_markup: menu()
            });
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
  }

  // معالجة أزرار القائمة الرئيسية بعد إنهاء حالة الانتظار.
  if (text === '🏠 الرئيسية' || text === '/menu') {
    return ctx.reply('👑 القائمة الرئيسية', {
      reply_markup: menu()
    });
  }

  if (text === '🤖 البوتات') return showBots(ctx);
  if (text === '📁 المشاريع') return showProjects(ctx);

  if (text === '➕ إضافة بوت') {
    pendingAdds.set(userId, { step: 'name' });
    return ctx.reply(
      '➕ إضافة بوت جديد\n\n' +
      'أرسل اسم البوت الذي تريد تسجيله.\n\n' +
      'للإلغاء أرسل: إلغاء'
    );
  }

  if (text === '📊 الإحصائيات') return showStats(ctx);

  if (text === '⚙️ الإعدادات') {
    return ctx.reply(
      '⚙️ مركز إعدادات BOSS BOT MASTER\nاختر القسم الذي تريد فحصه:',
      { reply_markup: settingsKeyboard() }
    );
  }

  return ctx.reply('اختر أحد أزرار القائمة.', {
    reply_markup: menu()
  });
});

bot.catch((err) => {
  console.error('Telegram error:', err.message);
});


let shuttingDown = false;
let runtimeRecoveryPromise = null;
let runtimeRecoveryRequested = false;
let masterPollingPromise = null;
let stoppingForRecovery = false;

function recoveryDelay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function stopTelegramServicesForRecovery() {
  stoppingForRecovery = true;

  try {
    try {
      await stopIntakeBot();
    } catch (err) {
      console.error('RECOVERY INTAKE STOP ERROR:', err.message);
    }

    try {
      await bot.stop();
    } catch (err) {
      console.error('RECOVERY MASTER STOP ERROR:', err.message);
    }

    const currentPolling = masterPollingPromise;
    if (currentPolling) {
      try {
        await currentPolling;
      } catch (err) {
        console.error('RECOVERY MASTER POLLING WAIT ERROR:', err.message);
      }
    }

    try {
      await stopBotRuntime();
    } catch (err) {
      console.error('RECOVERY CUSTOMER BOTS STOP ERROR:', err.message);
    }
  } finally {
    stoppingForRecovery = false;
  }
}

let startupInProgress = false;

function startMasterPolling() {
  return new Promise((resolve, reject) => {
    let started = false;

    const polling = bot.start({
      onStart: (info) => {
        started = true;
        console.log('BOSS BOT MASTER يعمل: @' + info.username);
        resolve();
      }
    }).then(() => {
      if (!started) {
        reject(new Error('Master polling stopped before startup completed'));
      } else if (!shuttingDown && !stoppingForRecovery) {
        void shutdown('MASTER_POLLING_STOPPED_UNEXPECTEDLY', 1);
      }
    }).catch((err) => {
      if (!started) {
        reject(err);
        return;
      }

      if (!shuttingDown && !stoppingForRecovery) {
        console.error('MASTER POLLING ERROR:', err.message);
        void shutdown('MASTER_POLLING_ERROR', 1);
      }
    }).finally(() => {
      if (masterPollingPromise === polling) {
        masterPollingPromise = null;
      }
    });

    masterPollingPromise = polling;
  });
}

async function runtimeLockIsSafe() {
  if (shuttingDown || runtimeRecoveryRequested) return false;

  const held = await isTelegramRuntimeLockHeld();

  return held && !shuttingDown && !runtimeRecoveryRequested;
}

async function startTelegramServices() {
  if (!(await runtimeLockIsSafe())) {
    throw new Error('Runtime lock lost before Telegram services startup');
  }

  await startBotRuntime();

  if (!(await runtimeLockIsSafe())) {
    throw new Error('Runtime lock lost after customer bots startup');
  }

  await startIntakeBot(
    async ({ text, extra }) => {
      await bot.api.sendMessage(adminId, text, extra);
    },
    (fatalError) => shutdown(
      'INTAKE_BOT_FAILURE: ' + fatalError.message,
      1
    )
  );

  if (!(await runtimeLockIsSafe())) {
    throw new Error('Runtime lock lost after intake bot startup');
  }

  await startMasterPolling();

  if (!(await runtimeLockIsSafe())) {
    throw new Error('Runtime lock lost after master bot startup');
  }
}

async function recoverRuntimeAfterLockLoss(err) {
  if (shuttingDown) return;
  if (runtimeRecoveryPromise) return runtimeRecoveryPromise;

  console.error(
    'WARNING: Telegram runtime lock was lost. Stopping Telegram services and attempting safe lock recovery.',
    err?.message || err || ''
  );

  runtimeRecoveryRequested = true;

  // During initial startup, the startup loop already owns recovery.
  if (startupInProgress) return;

  runtimeRecoveryPromise = (async () => {
    await stopTelegramServicesForRecovery();

    while (!shuttingDown) {
      try {
        const locked = await acquireTelegramRuntimeLock();

        if (!locked) {
          console.log('Runtime lock is held by another instance; retrying recovery in 5 seconds.');
          await recoveryDelay(5000);
          continue;
        }

        runtimeRecoveryRequested = false;

        if (!(await isTelegramRuntimeLockHeld())) {
          runtimeRecoveryRequested = true;
          await stopTelegramServicesForRecovery();
          await recoveryDelay(5000);
          continue;
        }

        const recoveredJobs = await recoverInterruptedProjectAiJobs();
        console.log('Recovered ' + recoveredJobs + ' interrupted AI job(s) after lock loss');

        await startTelegramServices();

        if (!(await runtimeLockIsSafe())) {
          throw new Error('Runtime lock was lost while restarting Telegram services');
        }

        process.emit('boss:runtime-ready');
        console.log('Telegram runtime recovered successfully without exiting the service.');
        return;
      } catch (recoveryError) {
        console.error('RUNTIME LOCK RECOVERY ATTEMPT FAILED:', recoveryError.message);
        runtimeRecoveryRequested = true;
        await stopTelegramServicesForRecovery();

        if (!shuttingDown) {
          await recoveryDelay(5000);
        }
      }
    }
  })().finally(() => {
    runtimeRecoveryPromise = null;
  });

  return runtimeRecoveryPromise;
}

async function start() {
  startupInProgress = true;
  setRuntimeLockFailureHandler(recoverRuntimeAfterLockLoss);

  try {
    await initDatabase();

    let locked = false;
    const lockDeadline = Date.now() + 600000;

    while (!locked && Date.now() < lockDeadline && !shuttingDown) {
      runtimeRecoveryRequested = false;

      try {
        locked = await acquireTelegramRuntimeLock();
      } catch (lockError) {
        console.error('INITIAL RUNTIME LOCK ERROR:', lockError.message);
        await recoveryDelay(5000);
        continue;
      }

      if (runtimeRecoveryRequested) {
        await stopTelegramServicesForRecovery();
        continue;
      }

      if (!locked) {
        console.log('نسخة أخرى تشغّل بوتات تلغرام؛ إعادة المحاولة بعد 5 ثوانٍ');
        await recoveryDelay(5000);
        continue;
      }

      try {
        if (!(await runtimeLockIsSafe())) {
          await stopTelegramServicesForRecovery();
          continue;
        }

        const recoveredJobs = await recoverInterruptedProjectAiJobs();
        console.log('Recovered ' + recoveredJobs + ' interrupted AI job(s)');

        await startTelegramServices();

        if (!(await runtimeLockIsSafe())) {
          await stopTelegramServicesForRecovery();
          continue;
        }

        startupInProgress = false;
        process.emit('boss:runtime-ready');
        console.log('اكتمل التشغيل الأولي لخدمات Telegram.');
        return;

      } catch (startupError) {
        await stopTelegramServicesForRecovery();

        if (runtimeRecoveryRequested || !(await isTelegramRuntimeLockHeld())) {
          console.error('إعادة محاولة التشغيل بعد فقدان القفل:', startupError.message);
          continue;
        }

        throw startupError;
      }
    }

    throw new Error('انتهت مهلة انتظار قفل تشغيل بوتات تلغرام بعد 10 دقائق');

  } finally {
    startupInProgress = false;
  }
}

async function shutdown(signal, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.emit('boss:runtime-stopping', signal);

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
