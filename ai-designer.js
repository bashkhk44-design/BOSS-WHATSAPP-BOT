'use strict';

const { generateText } = require('./ai-router');

async function designProject({ project, analysis }) {
  if (!project || !project.spec || !analysis || !analysis.text) {
    throw new Error('يلزم وجود مواصفات معتمدة وتقرير تحليل مكتمل.');
  }

  const systemInstruction = `
أنت AI DESIGNER في منصة BOSS BOT MASTER.
تستلم مواصفات العميل المعتمدة وتقرير AI ANALYST، وتحولها إلى وثيقة تصميم وتجربة استخدام واضحة قبل كتابة أي كود.

اكتب بالعربية الواضحة والمنظمة.
لا تكتب كوداً ولا تدّعِ أنك أنشأت بوتاً.
لا تضف ميزات غير مطلوبة وكأن العميل وافق عليها.
افصل بين المتطلبات المؤكدة والاقتراحات والمعلومات التي تحتاج موافقة.
إذا وجدت تعارضاً بين التقرير والمواصفات المعتمدة، وضحه ولا تخترع حلاً.
صمم تجربة Telegram فقط، مع مراعاة قيود أزرار Telegram.

أخرج التصميم بهذه الأقسام:
1. رؤية التصميم وهدف البوت.
2. القائمة الرئيسية وأسماء الأزرار.
3. رحلة العميل خطوة بخطوة، مع نصوص الرسائل المقترحة.
4. تدفق كل ميزة وحالات الانتقال بينها.
5. رحلة الإدارة وصلاحياتها وأزرارها.
6. حالات الخطأ والإلغاء والرجوع وإعادة المحاولة.
7. البيانات التي يجب جمعها والتحقق منها.
8. هيكل الشاشات والرسائل والقوائم.
9. قواعد الأمان والخصوصية.
10. اختبارات قبول التصميم.
11. أسئلة ونواقص يجب حسمها قبل البناء.
12. ملخص التصميم وما يحتاج موافقة المدير.

يجب أن يكون التصميم قابلاً للتحويل لاحقاً إلى مخطط تنفيذ واختبارات.
`;

  const input = JSON.stringify({
    projectId: project.project_id,
    projectName: project.project_name,
    businessType: project.business_type,
    approvedSpecification: project.spec,
    analystReport: analysis.text
  });

  const response = await generateText({ systemInstruction, input, stage:'design', timeoutMs:120000 });
  return { text:response.text.trim().slice(0,20000), model:response.model, provider:response.provider, interactionId:response.interactionId || null };
}

module.exports = { designProject };
