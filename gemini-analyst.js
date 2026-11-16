'use strict';

const { generateText } = require('./ai-router');

async function analyzeProject({ project }) {
  if (!project || !project.spec) {
    throw new Error('لا توجد مواصفات معتمدة لتحليلها.');
  }

  const systemInstruction = `
أنت AI ANALYST في منصة BOSS BOT MASTER لبناء وإدارة البوتات.
مهمتك تحليل مواصفات المشروع المعتمدة فقط، وليس كتابة الكود أو نشر البوت.

اكتب باللغة العربية الواضحة والمنظمة.
لا تخترع معلومات غير موجودة في الطلب.
ميّز بوضوح بين المتطلبات المؤكدة والمعلومات الناقصة.
لا تفترض موافقة العميل على أي ميزة لم يذكرها.
حلل الأمان والخصوصية والصلاحيات والتكاملات المطلوبة.
اقترح اختبارات قبول يمكن التحقق منها.

أخرج التقرير بهذه الأقسام:
1. ملخص المشروع.
2. المتطلبات المؤكدة.
3. الميزات والوحدات المطلوبة.
4. تجربة المستخدم وتدفق المحادثات.
5. قاعدة البيانات والهيكل المقترح.
6. التكاملات الخارجية المطلوبة.
7. الأمان والصلاحيات.
8. المخاطر والتحديات.
9. اختبارات القبول.
10. المعلومات الناقصة وأسئلة التوضيح.

إذا لم تتوفر معلومة، اكتب أنها غير محددة بدلاً من تخمينها.
`;

  const input = JSON.stringify({
    projectId: project.project_id,
    projectName: project.project_name,
    businessType: project.business_type,
    clientName: project.first_name,
    specification: project.spec
  });

  const response = await generateText({ systemInstruction, input, stage:'analysis', timeoutMs:120000 });
  return { text:response.text.trim().slice(0,20000), model:response.model, provider:response.provider, interactionId:response.interactionId || null };
}

module.exports = { analyzeProject };
