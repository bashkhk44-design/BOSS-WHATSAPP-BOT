require('dotenv').config();

const fs = require('fs');
const path = require('path');
const readline = require('readline/promises');
const { stdin, stdout } = require('process');
const { startConnection, normalizePhone } = require('./whatsapp');

const DB_FILE = path.join(__dirname, 'data', 'database.json');
const AUTH_ROOT = path.join(__dirname, 'data', 'whatsapp');

function hasRegisteredSession(client) {
  try {
    const file = path.join(AUTH_ROOT, String(client.id), 'creds.json');
    const creds = JSON.parse(fs.readFileSync(file, 'utf8'));
    return creds.registered === true;
  } catch {
    return false;
  }
}

function uniqueClients(clients) {
  const selected = new Map();

  for (const client of clients) {
    let phone;
    try {
      phone = normalizePhone(client.phone);
    } catch {
      continue;
    }

    const previous = selected.get(phone);

    if (!previous || (!hasRegisteredSession(previous) && hasRegisteredSession(client))) {
      selected.set(phone, client);
    }
  }

  return [...selected.values()];
}

async function main() {
  const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  const clients = uniqueClients((db.clients || []).filter(c => c.active));

  if (!clients.length) {
    console.log('لا يوجد نشاط فعال برقم صالح للربط.');
    return;
  }

  console.log('===== BOSS BOT PAIRING =====');
  clients.forEach((client, index) => {
    console.log(`${index + 1}) ${client.businessName} - ${client.phone}`);
  });

  const rl = readline.createInterface({ input: stdin, output: stdout });
  const answer = await rl.question('اختر رقم النشاط: ');
  rl.close();

  const index = Number(answer) - 1;

  if (!Number.isInteger(index) || index < 0 || index >= clients.length) {
    console.log('اختيار غير صحيح.');
    return;
  }

  const client = clients[index];

  console.log('جاري تجهيز اتصال النشاط...');

  const result = await startConnection(client, { pairing: true });

  if (result?.pairingCode) {
    console.log('');
    console.log('================================');
    console.log('رمز ربط واتساب النشاط:');
    console.log(result.pairingCode);
    console.log('================================');
    console.log('افتح واتساب النشاط ثم الأجهزة المرتبطة.');
    console.log('اختر ربط جهاز، ثم الربط باستخدام رقم الهاتف.');
    console.log('أدخل الرمز الظاهر أعلاه.');
  } else if (result?.alreadyRegistered) {
    console.log('هذا النشاط لديه جلسة مسجلة مسبقاً. جاري الاتصال بها.');
  } else {
    console.log('لم يتم إصدار رمز. تحقق من حالة الاتصال.');
  }

  console.log('اترك Termux مفتوحاً حتى يكتمل الربط.');
}

main().catch(error => {
  console.error('PAIR ERROR:', error.message);
  process.exitCode = 1;
});
