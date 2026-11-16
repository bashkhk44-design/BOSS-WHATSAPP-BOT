'use strict';

const MAX_FILES = 50;
const MAX_TOTAL_BYTES = 1024 * 1024;

function parseJson(text) {
  const cleaned = String(text || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');

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
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY غير مضبوط.');
  }

  if (!project || !project.spec || !analysis?.text || !design?.text) {
    throw new Error('يلزم وجود المواصفات والتحليل والتصميم قبل البناء.');
  }

  const { GoogleGenAI } = await import('@google/genai');

  const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY
  });

  const model = process.env.GEMINI_MODEL || 'gemini-3.8-flash';

  const systemInstruction = `
أنت AI BUILDER في منصة BOSS BOT MASTER.

مهمتك تحويل مواصفات المشروع المعتمدة وتقرير المحلل ووثيقة المصمم إلى حزمة ملفات برمجية كاملة.

قواعد إلزامية:
- لا تخترع ميزات غير موجودة في المواصفات المعتمدة.
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
    designDocument: design.text
  });

  const response = await ai.interactions.create({
    model,
    input,
    system_instruction: systemInstruction
  }, {
    timeout_ms: 180000
  });

  if (!response.output_text || !response.output_text.trim()) {
    throw new Error('Gemini لم يُرجع ملفات البناء.');
  }

  let parsed;

  try {
    parsed = parseJson(response.output_text);
  } catch {
    throw new Error('AI BUILDER أعاد نتيجة ليست JSON صالحاً.');
  }

  const bundle = validateBundle(parsed);

  return {
    ...bundle,
    model,
    interactionId: response.id || null,
    generatedAt: new Date().toISOString()
  };
}

module.exports = {
  buildProject,
  validateBundle
};
