#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail

cd "$(dirname "$0")/.."

ENV_FILE=".env.worker.local"
if [ ! -f "$ENV_FILE" ]; then
  echo "ملف $ENV_FILE غير موجود."
  echo "انسخ .env.worker.example إلى .env.worker.local ثم أضف بيانات قاعدة الاختبار ومفتاح التشفير."
  exit 1
fi

set -a
# shellcheck disable=SC1090
. "./$ENV_FILE"
set +a

if [ "${BOSS_WORKER_MODE:-}" != "termux-test" ] || [ "${BOSS_TEST_DATABASE:-}" != "YES" ]; then
  echo "رفض التشغيل: يجب ضبط BOSS_WORKER_MODE=termux-test و BOSS_TEST_DATABASE=YES."
  exit 1
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL مفقود."
  exit 1
fi

if ! printf '%s' "${BOTS_ENCRYPTION_KEY:-}" | grep -Eq '^[0-9a-fA-F]{64}$'; then
  echo "BOTS_ENCRYPTION_KEY يجب أن يكون 64 خانة hex (32 بايت)."
  exit 1
fi

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "يلزم Node.js 22 أو أحدث. الإصدار الحالي: $(node --version 2>/dev/null || echo غير مثبت)"
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "تثبيت الحزم..."
  npm ci
fi

echo "فحص اتصال قاعدة الاختبار دون تعديل المخطط..."
node - <<'NODE'
const { Pool } = require('pg');
(async () => {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'disable' ? false : { rejectUnauthorized: false },
    max: 1,
    connectionTimeoutMillis: 10000
  });
  try {
    const result = await pool.query('SELECT current_database() AS database, NOW() AS checked_at');
    console.log('اتصال PostgreSQL ناجح. قاعدة البيانات:', result.rows[0].database);
  } finally {
    await pool.end();
  }
})().catch(error => {
  console.error('فشل اتصال قاعدة البيانات:', error.message);
  process.exitCode = 1;
});
NODE

echo "بدء عامل الاختبار. أوقفه عبر CTRL+C."
npm run start:worker
