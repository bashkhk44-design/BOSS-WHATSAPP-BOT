'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { validateBundle } = require('./ai-builder');

function validateManifest(manifest, packageData) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('boss-manifest.json يجب أن يحتوي كائناً صالحاً.');
  }

  const allowedKeys = new Set([
    'version',
    'requiredEnv',
    'optionalEnv',
    'startScript',
    'healthCheck'
  ]);

  for (const key of Object.keys(manifest)) {
    if (!allowedKeys.has(key)) {
      throw new Error('حقل غير مسموح في manifest: ' + key);
    }
  }

  if (manifest.version !== 1) {
    throw new Error('إصدار manifest غير مدعوم؛ المطلوب version: 1.');
  }

  for (const field of ['requiredEnv', 'optionalEnv']) {
    if (!Array.isArray(manifest[field])) {
      throw new Error(field + ' يجب أن تكون قائمة أسماء متغيرات.');
    }

    if (manifest[field].length > 100) {
      throw new Error('عدد متغيرات البيئة كبير جداً.');
    }

    for (const name of manifest[field]) {
      if (typeof name !== 'string' ||
          !/^[A-Z][A-Z0-9_]{0,99}$/.test(name)) {
        throw new Error('اسم متغير بيئة غير صالح في ' + field + '.');
      }
    }

    if (new Set(manifest[field]).size !== manifest[field].length) {
      throw new Error('يوجد اسم متغير مكرر في ' + field + '.');
    }
  }

  const overlap = manifest.requiredEnv.filter(name =>
    manifest.optionalEnv.includes(name)
  );

  if (overlap.length) {
    throw new Error('متغير موجود في requiredEnv وoptionalEnv معاً: ' + overlap[0]);
  }

  if (typeof manifest.startScript !== 'string' ||
      !/^[a-zA-Z0-9:_-]{1,60}$/.test(manifest.startScript)) {
    throw new Error('startScript يجب أن يكون اسم أمر صالحاً من package.json.');
  }

  if (!packageData.scripts ||
      typeof packageData.scripts[manifest.startScript] !== 'string' ||
      !packageData.scripts[manifest.startScript].trim()) {
    throw new Error('أمر startScript غير موجود في package.json scripts.');
  }

  if (manifest.healthCheck !== undefined &&
      (typeof manifest.healthCheck !== 'string' ||
       !/^\/[a-zA-Z0-9/_-]*$/.test(manifest.healthCheck) ||
       manifest.healthCheck.includes('..'))) {
    throw new Error('healthCheck يجب أن يكون مساراً داخلياً صالحاً.');
  }

  return {
    version: 1,
    requiredEnv: [...manifest.requiredEnv],
    optionalEnv: [...manifest.optionalEnv],
    startScript: manifest.startScript,
    healthCheck: manifest.healthCheck || null
  };
}


function scanForEmbeddedSecrets(files) {
  const patterns = [
    { name: 'PEM_PRIVATE_KEY', regex: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
    { name: 'GOOGLE_API_KEY', regex: /\bAIza[0-9A-Za-z_-]{30,}\b/ },
    { name: 'TELEGRAM_BOT_TOKEN', regex: /\b\d{7,12}:[A-Za-z0-9_-]{30,}\b/ },
    { name: 'AWS_ACCESS_KEY', regex: /\bAKIA[0-9A-Z]{16}\b/ },
    { name: 'GITHUB_TOKEN', regex: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
    { name: 'SLACK_TOKEN', regex: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/ },
    { name: 'STRIPE_SECRET_KEY', regex: /\bsk_(?:live|test)_[A-Za-z0-9]{20,}\b/ },
    { name: 'OPENAI_API_KEY', regex: /\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}\b/ }
  ];

  const findings = [];

  for (const file of files) {
    const content = String(file.content || '');

    for (const pattern of patterns) {
      if (pattern.regex.test(content)) {
        findings.push({
          path: file.path,
          type: pattern.name
        });
      }
    }
  }

  return findings;
}

async function testProjectBundle({ bundle }) {
  const checks = [];
  const add = (name, passed, details = '') => {
    checks.push({ name, passed, details });
  };

  let validated;

  try {
    validated = validateBundle(bundle);
    add('bundle-validation', true);
  } catch (error) {
    add('bundle-validation', false, error.message);
    return {
      passed: false,
      checks,
      summary: 'فشل التحقق من حزمة المشروع.'
    };
  }

  const secretFindings = scanForEmbeddedSecrets(validated.files);
  add(
    'embedded-secrets',
    secretFindings.length === 0,
    secretFindings.map(item => item.path + ' [' + item.type + ']').join('; ')
  );

  if (secretFindings.length > 0) {
    return {
      passed: false,
      checks,
      manifest: null,
      summary: 'تم إيقاف الاختبار بسبب وجود بيانات اعتماد مضمّنة داخل ملفات المشروع.'
    };
  }

  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'boss-bot-test-')
  );

  try {
    for (const file of validated.files) {
      const destination = path.join(tempDir, file.path);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, file.content, 'utf8');
    }

    let packageData;

    try {
      packageData = JSON.parse(
        fs.readFileSync(path.join(tempDir, 'package.json'), 'utf8')
      );

      if (!packageData || typeof packageData !== 'object' ||
          Array.isArray(packageData)) {
        throw new Error('package.json يجب أن يحتوي كائناً صالحاً.');
      }

      add('package-json', true);
    } catch (error) {
      add('package-json', false, error.message);
      return {
        passed: false,
        checks,
        summary: 'ملف package.json غير صالح.'
      };
    }

    let manifest;

    try {
      const manifestFile = validated.files.find(
        file => file.path === 'boss-manifest.json'
      );

      if (!manifestFile) {
        throw new Error('الحزمة لا تحتوي على boss-manifest.json.');
      }

      const parsed = JSON.parse(manifestFile.content);
      manifest = validateManifest(parsed, packageData);
      add('boss-manifest', true);
      add('manifest-environment-names', true);
      add('manifest-start-script', true);
    } catch (error) {
      add('boss-manifest', false, error.message);
    }

    const javascriptFiles = validated.files.filter(file =>
      /\.(?:js|cjs|mjs)$/.test(file.path)
    );

    let syntaxPassed = true;

    for (const file of javascriptFiles) {
      const fullPath = path.join(tempDir, file.path);
      const result = spawnSync(
        process.execPath,
        ['--check', fullPath],
        {
          encoding: 'utf8',
          timeout: 15000
        }
      );

      if (result.error || result.status !== 0) {
        syntaxPassed = false;
        add(
          'javascript:' + file.path,
          false,
          (result.stderr || result.error?.message || 'فشل الفحص').slice(0, 2000)
        );
      } else {
        add('javascript:' + file.path, true);
      }
    }

    if (javascriptFiles.length === 0) {
      add('javascript-files', false, 'لا توجد ملفات JavaScript للفحص.');
      syntaxPassed = false;
    }

    const jsonFiles = validated.files.filter(file =>
      file.path.endsWith('.json')
    );

    let jsonPassed = true;

    for (const file of jsonFiles) {
      try {
        JSON.parse(file.content);
        add('json:' + file.path, true);
      } catch (error) {
        jsonPassed = false;
        add('json:' + file.path, false, error.message);
      }
    }

    const passed = syntaxPassed && jsonPassed &&
      checks.every(check => check.passed);

    return {
      passed,
      checks,
      manifest: manifest || null,
      summary: passed
        ? 'نجحت الاختبارات الأساسية وملف manifest.'
        : 'فشلت بعض الاختبارات؛ يجب إصلاح الأخطاء وإعادة الاختبار.'
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

module.exports = {
  testProjectBundle,
  validateManifest,
  scanForEmbeddedSecrets
};
