const { Bot, InlineKeyboard } = require('grammy');

const {
  createClientProject,
  setProjectBusinessType,
  updateClientProjectStatus,
  addConversationMessage,
  getIntakeSession,
  saveIntakeSession,
  deleteIntakeSession,
  approveProjectSpec
} = require('./project-db');

let intakeBot = null;
let pollingPromise = null;

const TYPES = [
  ['restaurant', '🍽️ مطعم'],
  ['store', '🛍️ متجر'],
  ['games', '🎮 ألعاب ومسابقات'],
  ['booking', '📅 حجوزات'],
  ['services', '🛠️ خدمات'],
  ['support', '💬 خدمة عملاء'],
  ['payments', '💳 مدفوعات'],
  ['other', '✨ نشاط آخر']
];

const PLATFORMS = [
  ['telegram', 'تيليغرام'],
  ['whatsapp', 'واتساب'],
  ['both', 'الاثنان']
];

async function saveMessage(userId, projectId, role, content) {
  await addConversationMessage({
    telegramUserId: userId,
    projectId,
    role,
    content
  });
}

async function replySaved(ctx, session, text, extra = {}) {
  await saveMessage(
    ctx.from.id,
    session.project_id,
    'assistant',
    text
  );

  return ctx.reply(text, extra);
}

function typeKeyboard() {
  const keyboard = new InlineKeyboard();

  TYPES.forEach(([key, label], index) => {
    keyboard.text(label, `type:${key}`);
    if (index % 2 === 1) keyboard.row();
  });

  return keyboard;
}

function platformKeyboard() {
  const keyboard = new InlineKeyboard();

  PLATFORMS.forEach(([key, label]) => {
    keyboard.text(label, `platform:${key}`).row();
  });

  return keyboard;
}

function reviewKeyboard() {
  return new InlineKeyboard()
    .text('✅ اعتماد المواصفات', 'review:approve')
    .row()
    .text('✏️ إضافة تعديل', 'review:edit')
    .row()
    .text('❌ إلغاء الطلب', 'review:cancel');
}

function typeName(key) {
  return TYPES.find(item => item[0] === key)?.[1] || key;
}

function platformName(key) {
  return PLATFORMS.find(item => item[0] === key)?.[1] || key;
}

function buildSummary(data) {
  return [
    '📋 ملخص مشروعك في BOSS BOT MASTER',
    '',
    `📌 اسم المشروع: ${data.projectName || 'غير محدد'}`,
    `🏢 نوع النشاط: ${typeName(data.businessType)}`,
    `📱 المنصة: ${platformName(data.platform)}`,
    '',
    `📝 فكرة المشروع:\n${data.description || 'غير محدد'}`,
    '',
    `⚙️ الميزات المطلوبة:\n${data.features || 'غير محدد'}`,
    '',
    `🔘 الأزرار والقوائم:\n${data.buttons || 'غير محدد'}`,
    '',
    `💳 الدفع:\n${data.payments || 'غير محدد'}`,
    '',
    `🌐 اللغات والتصميم:\n${data.languagesDesign || 'غير محدد'}`,
    '',
    `➕ إضافات أخرى:\n${data.extra || 'لا يوجد'}`,
    '',
    'راجع التفاصيل جيداً. لن نعتمد المواصفات إلا بعد موافقتك.'
  ].join('\n');
}

async function askNext(ctx, session) {
  const prompts = {
    description:
      '📝 اشرح لنا فكرة مشروعك: ماذا تريد أن يقدم البوت للعملاء؟',

    features:
      '⚙️ ما الميزات والوظائف التي تريدها؟ اذكر كل ما يخطر ببالك.',

    buttons:
      '🔘 ما الأزرار والقوائم التي تريد ظهورها للعميل؟',

    payments:
      '💳 هل تريد نظام دفع أو تحويلات؟ اشرح الطريقة المطلوبة، أو اكتب: لا يوجد.',

    languagesDesign:
      '🎨 ما اللغات والألوان والتصميم الذي تفضله؟ اذكر التفاصيل أو اكتب: لا يوجد.',

    extra:
      '➕ هل هناك شروط أو تفاصيل إضافية؟ اكتبها أو أرسل: لا يوجد.'
  };

  if (session.step === 'review') {
    const summary = buildSummary(session.data);
    await replySaved(ctx, session, summary, {
      reply_markup: reviewKeyboard()
    });
    return;
  }

  const prompt = prompts[session.step];

  if (prompt) {
    await replySaved(ctx, session, prompt);
  }
}

async function beginProject(ctx) {
  const userId = ctx.from.id;

  await deleteIntakeSession(userId);

  await ctx.reply(
    '🚀 لنبدأ إنشاء مشروعك الجديد.\n\nما اسم المشروع أو النشاط الذي تريد إنشاء بوت له؟'
  );
}

async function startIntakeBot() {
  const token = process.env.INTAKE_BOT_TOKEN;

  if (!token) {
    console.log('Intake bot disabled: INTAKE_BOT_TOKEN is not configured');
    return null;
  }

  if (intakeBot) return intakeBot;

  intakeBot = new Bot(token);

  intakeBot.command('start', async (ctx) => {
    const session = await getIntakeSession(ctx.from.id);

    if (session) {
      await ctx.reply(
        'أهلاً بعودتك إلى BOSS BOT MASTER 👋\nوجدنا طلبك السابق وسنكمل من حيث توقفت.'
      );

      await askNext(ctx, session);
      return;
    }

    const keyboard = new InlineKeyboard()
      .text('🚀 ابدأ مشروعك', 'start:new')
      .row()
      .text('📚 خدماتنا', 'start:services');

    await ctx.reply(
      '👑 أهلاً بك في BOSS BOT MASTER\n\n' +
      'منصتك لتصميم وتطوير وإدارة البوتات المخصصة للأنشطة التجارية والخدمية.\n\n' +
      'نساعدك على تحويل فكرتك إلى مشروع منظم، مع جمع المتطلبات ومراجعتها واعتمادها قبل البدء بالتنفيذ.\n\n' +
      'اختر ما تريد:',
      { reply_markup: keyboard }
    );
  });

  intakeBot.command('new', beginProject);

  intakeBot.command('services', async (ctx) => {
    await ctx.reply(
      '📚 خدمات BOSS BOT MASTER\n\n' +
      '🎮 بوتات الألعاب والمسابقات والنقاط والترتيب.\n' +
      '🍽️ بوتات المطاعم والطلبات والمنيو.\n' +
      '🛍️ بوتات المتاجر والمنتجات والمبيعات.\n' +
      '📅 بوتات الحجوزات والمواعيد.\n' +
      '🛠️ بوتات الخدمات وإدارة العملاء.\n' +
      '💬 بوتات الدعم وخدمة العملاء.\n' +
      '💳 تكاملات الدفع المناسبة عند توفر مزود معتمد.\n' +
      '🌐 دعم تعدد اللغات والعملات حسب متطلبات المشروع.\n\n' +
      'يمر كل مشروع بجمع المتطلبات ومراجعتها واعتمادها، ثم مراحل التصميم والبناء والاختبار والتسليم بحسب الإمكانيات والتكاملات المفعّلة.'
    );
  });

  intakeBot.callbackQuery('start:services', async (ctx) => {
    await ctx.answerCallbackQuery();

    await ctx.reply(
      '📚 خدماتنا تشمل:\n\n' +
      '🎮 الألعاب والمسابقات\n' +
      '🍽️ المطاعم والطلبات\n' +
      '🛍️ المتاجر والمبيعات\n' +
      '📅 الحجوزات\n' +
      '🛠️ الخدمات\n' +
      '💬 خدمة العملاء\n' +
      '💳 تكاملات الدفع\n\n' +
      'يمكنك بدء طلبك من زر ابدأ مشروعك.'
    );
  });

  intakeBot.callbackQuery('start:new', async (ctx) => {
    await ctx.answerCallbackQuery();
    await beginProject(ctx);
  });

  intakeBot.callbackQuery(/^type:(.+)$/, async (ctx) => {
    const session = await getIntakeSession(ctx.from.id);

    if (!session || session.step !== 'business_type') {
      await ctx.answerCallbackQuery({
        text: 'انتهت هذه الخطوة. أرسل /start للمتابعة.'
      });
      return;
    }

    const businessType = ctx.match[1];
    const data = { ...session.data, businessType };

      await setProjectBusinessType({
        telegramUserId: ctx.from.id,
        projectId: session.project_id,
        businessType
      });

    await saveIntakeSession({
      telegramUserId: ctx.from.id,
      projectId: session.project_id,
      step: 'platform',
      data
    });

    await saveMessage(
      ctx.from.id,
      session.project_id,
      'client',
      `نوع النشاط: ${typeName(businessType)}`
    );

    await ctx.answerCallbackQuery();
    await ctx.reply('📱 على أي منصة تريد تشغيل البوت؟', {
      reply_markup: platformKeyboard()
    });
  });

  intakeBot.callbackQuery(/^platform:(.+)$/, async (ctx) => {
    const session = await getIntakeSession(ctx.from.id);

    if (!session || session.step !== 'platform') {
      await ctx.answerCallbackQuery({
        text: 'انتهت هذه الخطوة. أرسل /start للمتابعة.'
      });
      return;
    }

    const platform = ctx.match[1];
    const data = { ...session.data, platform };

    await saveIntakeSession({
      telegramUserId: ctx.from.id,
      projectId: session.project_id,
      step: 'description',
      data
    });

    await saveMessage(
      ctx.from.id,
      session.project_id,
      'client',
      `المنصة: ${platformName(platform)}`
    );

    await ctx.answerCallbackQuery();

    const nextSession = {
      ...session,
      step: 'description',
      data
    };

    await askNext(ctx, nextSession);
  });

  intakeBot.callbackQuery('review:approve', async (ctx) => {
    const session = await getIntakeSession(ctx.from.id);

    if (!session || session.step !== 'review') {
      await ctx.answerCallbackQuery({
        text: 'لا يوجد طلب جاهز للاعتماد.'
      });
      return;
    }

    try {
      const result = await approveProjectSpec({
        telegramUserId: ctx.from.id,
        projectId: session.project_id,
        spec: session.data
      });

      await ctx.answerCallbackQuery({
        text: 'تم اعتماد المواصفات'
      });

      await ctx.reply(
        `✅ تم اعتماد مواصفات مشروعك بنجاح.\n\nرقم المشروع: ${session.project_id}\nنسخة المواصفات: ${result.version}\n\nتم حفظ الطلب للمراجعة والانتقال إلى مراحل التطوير وفق خطة النظام.`
      );
    } catch (error) {
      console.error('Project approval error:', error.message);
      await ctx.answerCallbackQuery({
        text: 'تعذر اعتماد الطلب، حاول لاحقاً.',
        show_alert: true
      });
    }
  });

  intakeBot.callbackQuery('review:edit', async (ctx) => {
    const session = await getIntakeSession(ctx.from.id);

    if (!session || session.step !== 'review') {
      await ctx.answerCallbackQuery();
      return;
    }

    await saveIntakeSession({
      telegramUserId: ctx.from.id,
      projectId: session.project_id,
      step: 'correction',
      data: session.data
    });

    await ctx.answerCallbackQuery();

    await ctx.reply(
      '✏️ اكتب التعديل الذي تريد إضافته أو تصحيحه في مواصفات المشروع.'
    );
  });

  intakeBot.callbackQuery('review:cancel', async (ctx) => {
    const session = await getIntakeSession(ctx.from.id);

    if (session) {
      await updateClientProjectStatus({
        telegramUserId: ctx.from.id,
        projectId: session.project_id,
        status: 'cancelled'
      });
    }

    await deleteIntakeSession(ctx.from.id);
    await ctx.answerCallbackQuery({
      text: 'تم إلغاء جلسة الاستقبال.'
    });

    await ctx.reply(
      'تم إلغاء جلسة الطلب. إذا أردت البدء من جديد أرسل /new.'
    );
  });

  intakeBot.on('message:text', async (ctx) => {
    const text = ctx.message.text.trim();

    if (!text || text.startsWith('/')) return;

    const userId = ctx.from.id;
    let session = await getIntakeSession(userId);

    if (!session) {
      const project = await createClientProject({
        telegramUserId: userId,
        telegramUsername: ctx.from.username || null,
        firstName: ctx.from.first_name || null,
        name: text
      });

      const data = { projectName: text };

      await saveIntakeSession({
        telegramUserId: userId,
        projectId: project.id,
        step: 'business_type',
        data
      });

      session = {
        project_id: project.id,
        step: 'business_type',
        data
      };

      await saveMessage(userId, project.id, 'client', text);

      await replySaved(
        ctx,
        session,
        '🏢 ما نوع النشاط الذي تريد إنشاء البوت له؟',
        { reply_markup: typeKeyboard() }
      );

      return;
    }

    if (session.step === 'business_type' || session.step === 'platform') {
      await ctx.reply('يرجى اختيار أحد الأزرار الظاهرة أمامك.');
      return;
    }

    await saveMessage(userId, session.project_id, 'client', text);

    if (session.step === 'correction') {
      const data = {
        ...session.data,
        extra: [session.data.extra, 'تعديل العميل: ' + text]
          .filter(Boolean)
          .join('\n')
      };

      await saveIntakeSession({
        telegramUserId: userId,
        projectId: session.project_id,
        step: 'review',
        data
      });

      session = { ...session, step: 'review', data };
      await askNext(ctx, session);
      return;
    }

    const nextSteps = {
      description: 'features',
      features: 'buttons',
      buttons: 'payments',
      payments: 'languagesDesign',
      languagesDesign: 'extra',
      extra: 'review'
    };

    const fields = {
      description: 'description',
      features: 'features',
      buttons: 'buttons',
      payments: 'payments',
      languagesDesign: 'languagesDesign',
      extra: 'extra'
    };

    const nextStep = nextSteps[session.step];

    if (!nextStep) {
      await ctx.reply('أرسل /start للعودة إلى طلبك.');
      return;
    }

    const data = {
      ...session.data,
      [fields[session.step]]: text
    };

    await saveIntakeSession({
      telegramUserId: userId,
      projectId: session.project_id,
      step: nextStep,
      data
    });

    session = {
      ...session,
      step: nextStep,
      data
    };

    await askNext(ctx, session);
  });

  intakeBot.catch((err) => {
    console.error('Intake bot error:', err.message);
  });

  pollingPromise = intakeBot.start({
    onStart: (info) => {
      console.log(`BOSS CLIENT INTAKE BOT يعمل: @${info.username}`);
    }
  });

  pollingPromise.catch((err) => {
    console.error('INTAKE BOT POLLING ERROR:', err.message);
  });

  return intakeBot;
}

async function stopIntakeBot() {
  if (!intakeBot) return;

  try {
    await intakeBot.stop();
  } catch (error) {
    console.error('INTAKE BOT STOP ERROR:', error.message);
  }

  intakeBot = null;
  pollingPromise = null;
}

module.exports = {
  startIntakeBot,
  stopIntakeBot
};
