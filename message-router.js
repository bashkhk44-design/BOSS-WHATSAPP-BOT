const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, 'data', 'database.json');

function normalizePhone(value) {
  return String(value || '').replace(/\D/g, '').replace(/:\d+$/, '');
}

function readDB() {
  const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  if (!Array.isArray(db.clients)) db.clients = [];
  if (!Array.isArray(db.orders)) db.orders = [];
  if (!Number.isInteger(db.nextOrderId)) db.nextOrderId = 1000;
  return db;
}

function saveDB(db) {
  const temp = DB_FILE + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(db, null, 2));
  fs.renameSync(temp, DB_FILE);
}

function getText(message) {
  const m = message.message || {};
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    ''
  ).trim();
}

function money(value) {
  return Number(value).toLocaleString('en-US');
}

function findOrder(db, id, clientId) {
  return db.orders.find(o =>
    String(o.id) === String(id) && o.clientId === clientId
  );
}

async function handleMessage(socket, client, message, state) {
  if (!message || message.key?.fromMe) return;

  const jid = message.key?.remoteJid || '';
  if (!jid || jid === 'status@broadcast' || jid.endsWith('@g.us')) return;

  const sender = message.key?.participant || jid;
  const senderPhone = normalizePhone(sender.split('@')[0].split(':')[0]);
  const adminPhone = normalizePhone(process.env.ADMIN_WHATSAPP);

  if (!senderPhone) return;

  const text = getText(message);
  if (!text) return;

  const command = text.trim();
  const lower = command.toLowerCase();
  const isAdmin = !!adminPhone && senderPhone === adminPhone;

  let db;
  try {
    db = readDB();
  } catch (error) {
    console.error('Database read error:', error.message);
    return socket.sendMessage(jid, {
      text: 'حدث خطأ في قراءة بيانات النظام. أبلغ المدير.'
    });
  }

  const currentClient = db.clients.find(c => c.id === client.id);
  if (!currentClient || !currentClient.active) {
    return socket.sendMessage(jid, {
      text: 'هذا النشاط متوقف حالياً.'
    });
  }

  const isOwner =
    !!currentClient.ownerPhone &&
    normalizePhone(currentClient.ownerPhone) === senderPhone;

  // المدير الرئيسي
  if (isAdmin) {
    if (['/help', 'مساعدة', 'اوامر', 'أوامر'].includes(lower)) {
      return socket.sendMessage(jid, {
        text:
`👑 BOSS BOT MASTER

أوامر المدير:
/help - المساعدة
/clients - العملاء
/status - حالة البوت
/setowner رقم_العميل رقم_المالك
/whoami - التحقق من الصلاحية

مثال تعيين مالك:
 /setowner 1 9639XXXXXXXX`
      });
    }

    if (lower === '/whoami') {
      return socket.sendMessage(jid, {
        text: '✅ أنت المدير الرئيسي للنظام.'
      });
    }

    if (lower === '/clients') {
      const list = db.clients.map((c, i) =>
        `${i + 1}. ${c.businessName}\n` +
        `المعرّف: ${c.id.slice(0, 8)}\n` +
        `الحالة: ${c.active ? 'فعال' : 'موقوف'}\n` +
        `المالك: ${c.ownerPhone ? 'مُعيّن' : 'غير مُعيّن'}`
      ).join('\n\n');

      return socket.sendMessage(jid, {
        text: `📋 العملاء المسجلون:\n\n${list || 'لا يوجد عملاء.'}`
      });
    }

    if (lower.startsWith('/setowner ')) {
      const parts = command.split(/\s+/);
      const index = Number(parts[1]) - 1;
      const ownerPhone = normalizePhone(parts[2]);

      if (
        !Number.isInteger(index) ||
        index < 0 ||
        index >= db.clients.length ||
        ownerPhone.length < 8 ||
        ownerPhone.length > 15
      ) {
        return socket.sendMessage(jid, {
          text: 'صيغة الأمر غير صحيحة.\nمثال:\n/setowner 1 9639XXXXXXXX'
        });
      }

      db.clients[index].ownerPhone = ownerPhone;
      saveDB(db);

      return socket.sendMessage(jid, {
        text:
`✅ تم تعيين صاحب النشاط.

النشاط: ${db.clients[index].businessName}
رقم الحساب: ${index + 1}

أصبح بإمكان صاحب هذا الرقم إدارة نشاطه من واتساب.`
      });
    }

    if (lower === '/status') {
      return socket.sendMessage(jid, {
        text:
`📡 حالة النظام
النشاط: ${currentClient.businessName}
رقم النشاط: ${currentClient.phone}
الاتصال: ${state.status}
عدد الطلبات: ${db.orders.filter(o => o.clientId === client.id).length}`
      });
    }

    return socket.sendMessage(jid, {
      text: 'أمر غير معروف. أرسل /help.'
    });
  }

  // صاحب النشاط
  if (isOwner) {
    if (['/help', 'مساعدة', 'اوامر', 'أوامر'].includes(lower)) {
      return socket.sendMessage(jid, {
        text:
`🏪 إدارة ${currentClient.businessName}

/ menu - عرض القائمة
/add اسم الطبق|السعر - إضافة طبق
/remove رقم - حذف طبق
/orders - الطلبات
/accept رقم - قبول طلب
/reject رقم - رفض طلب
/pause - إيقاف استقبال الطلبات
/resume - تشغيل استقبال الطلبات
/stats - الإحصائيات

أرسل الأمر كما هو موضح.`
          .replace('/ menu', '/menu')
      });
    }

    if (lower === '/menu' || lower === 'قائمتي') {
      const menu = currentClient.menu || [];
      const list = menu.map((item, i) =>
        `${i + 1}. ${item.name} — ${money(item.price)}`
      ).join('\n');

      return socket.sendMessage(jid, {
        text: `🍽️ قائمة ${currentClient.businessName}\n\n${list || 'القائمة فارغة.'}`
      });
    }

    if (lower.startsWith('/add ')) {
      const data = command.slice(5).split('|');
      const name = (data[0] || '').trim();
      const price = Number((data[1] || '').trim());

      if (!name || !Number.isFinite(price) || price <= 0) {
        return socket.sendMessage(jid, {
          text: 'استخدم الصيغة:\n/add شاورما دجاج|25000'
        });
      }

      if (!Array.isArray(currentClient.menu)) currentClient.menu = [];

      currentClient.menu.push({
        name,
        price,
        createdAt: new Date().toISOString()
      });

      saveDB(db);

      return socket.sendMessage(jid, {
        text: `✅ تمت إضافة ${name} بسعر ${money(price)}.`
      });
    }

    if (lower.startsWith('/remove ')) {
      const index = Number(command.split(/\s+/)[1]) - 1;
      const menu = currentClient.menu || [];

      if (!Number.isInteger(index) || index < 0 || index >= menu.length) {
        return socket.sendMessage(jid, {
          text: 'رقم الطبق غير صحيح. أرسل /menu أولاً.'
        });
      }

      const removed = menu.splice(index, 1)[0];
      saveDB(db);

      return socket.sendMessage(jid, {
        text: `🗑️ تم حذف ${removed.name}.`
      });
    }

    if (lower === '/pause') {
      currentClient.acceptingOrders = false;
      saveDB(db);
      return socket.sendMessage(jid, {
        text: '⏸️ تم إيقاف استقبال الطلبات.'
      });
    }

    if (lower === '/resume') {
      currentClient.acceptingOrders = true;
      saveDB(db);
      return socket.sendMessage(jid, {
        text: '▶️ تم تشغيل استقبال الطلبات.'
      });
    }

    if (lower === '/orders') {
      const orders = db.orders.filter(o =>
        o.clientId === client.id && o.status === 'pending'
      );

      const list = orders.map(o =>
        `طلب #${o.id}\n` +
        `الزبون: ${o.customerPhone}\n` +
        `${o.items.map(x => `${x.name} × ${x.quantity}`).join('\n')}\n` +
        `الإجمالي: ${money(o.total)}`
      ).join('\n\n');

      return socket.sendMessage(jid, {
        text: `📦 الطلبات الجديدة:\n\n${list || 'لا توجد طلبات جديدة.'}`
      });
    }

    if (lower.startsWith('/accept ') || lower.startsWith('/reject ')) {
      const parts = command.split(/\s+/);
      const order = findOrder(db, parts[1], client.id);

      if (!order || order.status !== 'pending') {
        return socket.sendMessage(jid, {
          text: 'الطلب غير موجود أو تمت معالجته مسبقاً.'
        });
      }

      order.status = lower.startsWith('/accept ') ? 'accepted' : 'rejected';
      order.updatedAt = new Date().toISOString();
      saveDB(db);

      const statusText = order.status === 'accepted' ? 'تم قبول طلبك ✅' : 'نعتذر، تم رفض طلبك ❌';

      await socket.sendMessage(order.customerJid, {
        text: `${statusText}\nرقم الطلب: #${order.id}`
      });

      return socket.sendMessage(jid, {
        text: `تم تحديث الطلب #${order.id}.`
      });
    }

    if (lower === '/stats') {
      const orders = db.orders.filter(o => o.clientId === client.id);
      const accepted = orders.filter(o => o.status === 'accepted');
      const revenue = accepted.reduce((sum, o) => sum + o.total, 0);

      return socket.sendMessage(jid, {
        text:
`📊 إحصائيات ${currentClient.businessName}

إجمالي الطلبات: ${orders.length}
طلبات قيد الانتظار: ${orders.filter(o => o.status === 'pending').length}
طلبات مقبولة: ${accepted.length}
طلبات مرفوضة: ${orders.filter(o => o.status === 'rejected').length}
إجمالي قيمة الطلبات المقبولة: ${money(revenue)}`
      });
    }

    return socket.sendMessage(jid, {
      text: 'لم أفهم الأمر. أرسل /help.'
    });
  }

  // الزبائن
  if (lower === '/menu' || lower === 'قائمة' || lower === 'القائمة' || lower === 'منيو') {
    const menu = currentClient.menu || [];
    const list = menu.map((item, i) =>
      `${i + 1}. ${item.name} — ${money(item.price)}`
    ).join('\n');

    return socket.sendMessage(jid, {
      text:
`🍽️ أهلاً بك في ${currentClient.businessName}

${list || 'القائمة غير متاحة حالياً.'}

لطلب طبق أرسل:
 /order رقم_الطبق الكمية

مثال: /order 1 2
ولمتابعة طلباتك أرسل /myorders`
    });
  }

  if (lower.startsWith('/order ') || lower.startsWith('طلب ')) {
    if (currentClient.acceptingOrders === false) {
      return socket.sendMessage(jid, {
        text: 'نعتذر، استقبال الطلبات متوقف حالياً.'
      });
    }

    const parts = command.replace(/^طلب\s+/i, '/order ').split(/\s+/);
    const itemIndex = Number(parts[1]) - 1;
    const quantity = Number(parts[2] || 1);
    const menu = currentClient.menu || [];

    if (
      !Number.isInteger(itemIndex) ||
      itemIndex < 0 ||
      itemIndex >= menu.length ||
      !Number.isInteger(quantity) ||
      quantity < 1 ||
      quantity > 50
    ) {
      return socket.sendMessage(jid, {
        text: 'صيغة الطلب غير صحيحة.\nأرسل قائمة ثم مثال:\n/order 1 2'
      });
    }

    const item = menu[itemIndex];
    const id = db.nextOrderId++;

    const order = {
      id,
      clientId: client.id,
      customerPhone: senderPhone,
      customerJid: jid,
      items: [{
        name: item.name,
        price: item.price,
        quantity
      }],
      total: item.price * quantity,
      status: 'pending',
      createdAt: new Date().toISOString()
    };

    db.orders.push(order);
    saveDB(db);

    await socket.sendMessage(jid, {
      text:
`✅ تم استلام طلبك!

رقم الطلب: #${id}
${item.name} × ${quantity}
الإجمالي: ${money(order.total)}

حالة الطلب: بانتظار تأكيد المطعم.
للمتابعة أرسل /myorders`
    });

    if (currentClient.ownerPhone) {
      const ownerJid = currentClient.ownerPhone + '@s.whatsapp.net';
      await socket.sendMessage(ownerJid, {
        text:
`🔔 طلب جديد!

رقم الطلب: #${id}
الزبون: ${senderPhone}
${item.name} × ${quantity}
الإجمالي: ${money(order.total)}

للقبول: /accept ${id}
للرفض: /reject ${id}`
      });
    }

    return;
  }

  if (lower === '/myorders' || lower === 'طلباتي') {
    const orders = db.orders
      .filter(o => o.clientId === client.id && o.customerPhone === senderPhone)
      .slice(-10)
      .reverse();

    const labels = {
      pending: 'قيد الانتظار',
      accepted: 'مقبول',
      rejected: 'مرفوض'
    };

    const list = orders.map(o =>
      `#${o.id} — ${labels[o.status] || o.status} — ${money(o.total)}`
    ).join('\n');

    return socket.sendMessage(jid, {
      text: `📦 طلباتك:\n\n${list || 'لا توجد طلبات مسجلة.'}`
    });
  }

  return socket.sendMessage(jid, {
    text:
`أهلاً بك في ${currentClient.businessName} 👋

لعرض الأطباق والأسعار أرسل:
قائمة`
  });
}

module.exports = { handleMessage };
