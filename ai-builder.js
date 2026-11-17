'use strict';

const { generateText } = require('./ai-router');

const MAX_FILES = 50;
const MAX_TOTAL_BYTES = 1024 * 1024;

function parseJson(text) {
  const cleaned = String(text || '')
    .trim()
    .replace(/^\x60{3}(?:json)?\s*/i, '')
    .replace(/\s*\x60{3}$/, '');

  return JSON.parse(cleaned);
}

function validateBundle(bundle) {
  if (!bundle || !Array.isArray(bundle.files)) {
    throw new Error('AI BUILDER لم يُرجع قائمة ملفات صالحة.');
  }

  if (bundle.files.length === 0 || bundle.files.length > MAX_FILES) {
    throw new Error('عدد الملفات الناتجة غير صالح.');
  }

  const seen = new Set();
  let totalBytes = 0;

  for (const file of bundle.files) {
    if (!file || typeof file.path !== 'string' ||
        typeof file.content !== 'string') {
      throw new Error('يوجد ملف ناقص الاسم أو المحتوى.');
    }

    const filePath = file.path.trim();

    if (
      !filePath ||
      filePath.startsWith('/') ||
      filePath.includes('\\') ||
      filePath.split('/').some(part =>
        !part || part === '.' || part === '..'
      ) ||
      /^[a-zA-Z]:/.test(filePath)
    ) {
      throw new Error('مسار ملف غير آمن: ' + filePath);
    }

    const firstPart = filePath.split('/')[0];

    if (
      ['.git', 'node_modules', '.env'].includes(firstPart) ||
      filePath.endsWith('.env') ||
      filePath.includes('/.env')
    ) {
      throw new Error('تم رفض مسار ملف حساس: ' + filePath);
    }

    if (seen.has(filePath)) {
      throw new Error('مسار ملف مكرر: ' + filePath);
    }

    seen.add(filePath);
    totalBytes += Buffer.byteLength(file.content, 'utf8');

    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new Error('حجم الحزمة تجاوز الحد المسموح.');
    }
  }

  if (!seen.has('package.json')) {
    throw new Error('الحزمة لا تحتوي على package.json.');
  }

  return {
    files: bundle.files,
    summary: String(bundle.summary || '').slice(0, 5000),
    notes: Array.isArray(bundle.notes)
      ? bundle.notes.map(String).slice(0, 30)
      : []
  };
}

async function buildProject({ project, analysis, design }) {
  if (!project || !project.spec || !analysis?.text || !design?.text) {
    throw new Error('يلزم وجود المواصفات والتحليل والتصميم قبل البناء.');
  }

  const systemInstruction = `
أنت AI BUILDER في منصة BOSS BOT MASTER.

مهمتك تحويل مواصفات المشروع المعتمدة وتقرير المحلل ووثيقة المصمم إلى حزمة ملفات برمجية كاملة.

قواعد إلزامية:
- لا تخترع ميزات غير موجودة في المواصفات المعتمدة أو وثيقة التصميم الموثقة.
- designArtifact هو المرجع المنظم للتدفقات والحالات والرسائل والأزرار واختبارات القبول.
- لا تنفذ أي عنصر لا يحمل مرجعاً إلى متطلب معتمد داخل designArtifact.sourceRequirements.
- لا تضع مفاتيح API أو كلمات مرور أو أسراراً داخل الملفات.
- استخدم متغيرات البيئة للإعدادات السرية.
- لا تدّعِ أن المشروع اختُبر أو نُشر.
- أنشئ كوداً منظماً وقابلاً للاختبار والصيانة.
- لا تنشئ ملفات .env أو node_modules أو .git.
- أدرج package.json صالحاً مع scripts وdependencies اللازمة.
- أنشئ ملف boss-manifest.json في جذر المشروع.
- يجب أن يكون manifest بصيغة JSON وبالشكل التالي:
  {
    "version": 1,
    "requiredEnv": ["DATABASE_URL"],
    "optionalEnv": ["GEMINI_API_KEY"],
    "startScript": "start",
    "healthCheck": "/health"
  }
- requiredEnv وoptionalEnv تحتويان أسماء متغيرات البيئة فقط، لا تضع أي قيم أو أسرار فعلية.
- startScript هو اسم أمر موجود فعلياً في package.json scripts.
- healthCheck اختياري، ويجب أن يكون مساراً داخلياً يبدأ بـ /.
- لا تضف حقولاً أخرى إلى boss-manifest.json.
- لا تستخدم مسارات مطلقة أو مسارات تتجاوز مجلد المشروع.
- إذا كانت هناك معلومات ناقصة تمنع البناء الآمن، اذكرها في notes ولا تخمّنها.
- أخرج JSON صالحاً فقط، دون Markdown أو شروحات خارجه.

شكل الإخراج المطلوب:
{
  "summary": "ملخص البناء",
  "notes": ["ملاحظات أو معلومات ناقصة"],
  "files": [
    {
      "path": "package.json",
      "content": "محتوى الملف كاملاً"
    }
  ]
}
`;

  const input = JSON.stringify({
    project: {
      id: project.project_id,
      name: project.project_name,
      businessType: project.business_type,
      specification: project.spec
    },
    analystReport: analysis.text,
    designDocument: design.text,
    designArtifact: design.artifact || null
  });

  const response = await generateText({ systemInstruction, input, stage:'build', timeoutMs:180000 });
  let parsed;
  try { parsed = parseJson(response.text); }
  catch { throw new Error('AI BUILDER أعاد نتيجة ليست JSON صالحاً من ' + response.provider + '.'); }

  const bundle = validateBundle(parsed);

  return {
    ...bundle,
    model:response.model,
    provider:response.provider,
    interactionId:response.interactionId || null,
    generatedAt: new Date().toISOString()
  };
}

module.exports = {
  buildProject,
  validateBundle
};
