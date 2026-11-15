require('dotenv').config();

const fs = require('fs');
const path = require('path');
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

function selectUniqueClients(clients) {
  const selected = new Map();

  for (const client of clients) {
    let phone;

    try {
      phone = normalizePhone(client.phone);
    } catch {
      console.log('تم تجاهل سجل برقم غير صالح:', client.businessName);
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
  const clients = selectUniqueClients((db.clients || []).filter(c => c.active));

  console.log('BOSS BOT MASTER - WHATSAPP ONLY');

  if (!clients.length) {
    console.log('لا يوجد نشاط فعال للاتصال.');
    return;
  }

  console.log('عدد أرقام الأنشطة الفريدة:', clients.length);

  for (const client of clients) {
    console.log('بدء اتصال:', client.businessName);
    await startConnection(client);
  }

  console.log('محرك واتساب يعمل. لا توجد واجهة موقع أو لوحة ويب.');
}

main().catch(error => {
  console.error('BOSS ENGINE ERROR:', error.message);
  process.exitCode = 1;
});
