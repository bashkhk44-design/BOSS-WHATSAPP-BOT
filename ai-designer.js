'use strict';

const { generateText } = require('./ai-router');

async function designProject({ project, analysis }) {
  if (!project || !project.spec || !analysis || !analysis.text) {
    throw new Error('يلزم وجود مواصفات معتمدة وتقرير تحليل مكتمل.');
  }

  const selectedPlatform = String(
    project.spec.platform || project.spec.channel || 'telegram'
  ).toLowerCase();

  const systemInstruction = `
أنت AI DESIGNER في منصة BOSS BOT MASTER.
تحول المواصفات المعتمدة وتقرير AI ANALYST إلى وثيقة تصميم قابلة للتنفيذ والاختبار قبل كتابة الكود.

قواعد إلزامية:
- اكتب بالعربية الواضحة والمنظمة.
- لا تكتب كوداً ولا تدّعِ أنك أنشأت أو نشرت بوتاً.
- لا تضف ميزات غير مطلوبة وكأن العميل وافق عليها.
- افصل بين المتطلبات المؤكدة والاقتراحات وما يحتاج موافقة.
- إذا وجدت تعارضاً بين التقرير والمواصفات، وضحه ولا تخترع حلاً.
- قناة المشروع المحددة حالياً هي: ${selectedPlatform}.
- صمم القناة المحددة فقط. إذا طلبت المواصفات قناة غير مفعّلة تقنياً، صمم تجربة منطقية لها وضع علامة واضحة "يتطلب تكامل القناة قبل التشغيل"، ولا تدّعِ أن التكامل موجود.
- لا تطلب مشاركة كلمات مرور أو رموز تحقق أو أسرار العملاء.
- اجعل التصميم قابلاً للتحويل إلى حالات واختبارات واضحة.

أخرج التصميم بهذه الأقسام:
1. رؤية التصميم وهدف البوت.
2. القناة المستهدفة وحدودها التقنية.
3. القائمة الرئيسية وأسماء الأزرار.
4. رحلة العميل خطوة بخطوة مع نصوص الرسائل.
5. تدفق كل ميزة وحالات الانتقال.
6. رحلة الإدارة والموظفين وصلاحيات كل دور.
7. حالات الخطأ والإلغاء والرجوع وإعادة المحاولة.
8. البيانات التي يجب جمعها والتحقق منها وتوقيت جمعها.
9. هيكل الشاشات والرسائل والقوائم.
10. قواعد الأمان والخصوصية وعزل العملاء.
11. اختبارات قبول التصميم.
12. النواقص والتبعيات التي تمنع التنفيذ.
13. ملخص التصميم وما يحتاج موافقة المدير.

`;

  const input = JSON.stringify({
    projectId: project.project_id,
    projectName: project.project_name,
    businessType: project.business_type,
    approvedSpecification: project.spec,
    analystReport: analysis.text
  });

  const response = await generateText({
    systemInstruction,
    input,
    stage: 'design',
    timeoutMs: 120000
  });

  return {
    text: response.text.trim().slice(0, 20000),
    model: response.model,
    provider: response.provider,
    interactionId: response.interactionId || null
  };
}

module.exports = { designProject };
