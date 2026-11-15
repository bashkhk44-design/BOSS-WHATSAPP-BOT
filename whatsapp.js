const fs = require('fs');
const path = require('path');
const { handleMessage } = require('./message-router');

const authRoot = path.join(__dirname, 'data', 'whatsapp');
fs.mkdirSync(authRoot, { recursive: true });

const sockets = new Map();
const states = new Map();
const starting = new Map();

let baileysPromise;

function getBaileys() {
  if (!baileysPromise) baileysPromise = import('@whiskeysockets/baileys');
  return baileysPromise;
}

function normalizePhone(value) {
  let digits = String(value || '').replace(/\D/g, '');

  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('0')) digits = '963' + digits.slice(1);
  else if (digits.length === 9 && digits.startsWith('9')) digits = '963' + digits;

  if (digits.length < 10 || digits.length > 15) {
    throw new Error('رقم الهاتف غير صالح. استخدم الرقم الدولي أو الرقم المحلي السوري.');
  }

  return digits;
}

function getState(id) {
  if (!states.has(id)) {
    states.set(id, {
      status: 'disconnected',
      phone: null,
      error: null
    });
  }
  return states.get(id);
}

async function startConnection(client, options = {}) {
  const id = String(client.id);

  if (starting.has(id)) return starting.get(id);

  const current = sockets.get(id);
  if (current) {
    const state = getState(id);
    if (state.status === 'connected' || state.status === 'connecting') {
      return;
    }
  }

  const task = (async () => {
    const state = getState(id);
    state.status = 'connecting';
    state.error = null;

    try {
      const baileys = await getBaileys();
      const makeWASocket = baileys.default;
      const { useMultiFileAuthState, fetchLatestBaileysVersion } = baileys;
      const { version } = await fetchLatestBaileysVersion();
      console.log('WhatsApp protocol version:', version.join('.'));

      const authDir = path.join(authRoot, id);
      fs.mkdirSync(authDir, { recursive: true });

      const { state: authState, saveCreds } =
        await useMultiFileAuthState(authDir);

      const socket = makeWASocket({
        auth: authState,
        printQRInTerminal: false,
        syncFullHistory: false,
        markOnlineOnConnect: false
      });

      sockets.set(id, socket);

      socket.ev.on('creds.update', saveCreds);

      socket.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify' || sockets.get(id) !== socket) return;

        for (const message of messages || []) {
          try {
            await handleMessage(socket, client, message, state);
          } catch (error) {
            console.error('BOSS message handler error:', error.message);
          }
        }
      });

      socket.ev.on('connection.update', update => {
        if (sockets.get(id) !== socket) return;

        if (update.connection === 'open') {
          state.status = 'connected';
          state.error = null;
          state.phone = socket.user?.id?.split(':')[0] || null;
          console.log('تم اتصال واتساب النشاط:', client.businessName);
        }

        if (update.connection === 'close') {
          const disconnectError = update.lastDisconnect?.error;
          const code = disconnectError?.output?.statusCode;
          console.log('===== BOSS DISCONNECT DIAGNOSTICS =====');
          console.log('HTTP STATUS:', code ?? 'unknown');
          console.log('ERROR NAME:', disconnectError?.name ?? 'unknown');
          console.log('ERROR MESSAGE:', disconnectError?.message ?? 'unknown');
          console.log('ERROR DATA:', JSON.stringify(disconnectError?.data ?? null));
          console.log('DISCONNECT REASON:', baileys.DisconnectReason[code] ?? 'unknown');
          console.log('=======================================');
          state.phone = null;
          state.status = code === baileys.DisconnectReason.loggedOut
            ? 'logged_out'
            : 'disconnected';

          if (sockets.get(id) === socket) sockets.delete(id);

          console.log('انقطع اتصال النشاط:', client.businessName, 'الحالة:', state.status);
        }
      });

      if (options.pairing && !authState.creds.registered) {
        if (typeof socket.requestPairingCode !== 'function') {
          throw new Error('نسخة Baileys الحالية لا توفر طلب رمز الاقتران.');
        }

        await new Promise(resolve => setTimeout(resolve, 2500));

        const phoneNumber = normalizePhone(client.phone);
        const code = await socket.requestPairingCode(phoneNumber);

        return { pairingCode: code };
      }

      return { alreadyRegistered: !!authState.creds.registered };
    } catch (error) {
      state.status = 'error';
      state.error = 'تعذر بدء الاتصال أو طلب رمز الاقتران.';
      sockets.delete(id);
      console.error('BOSS CONNECTION ERROR:', error.message);
      throw error;
    }
  })();

  starting.set(id, task);

  try {
    return await task;
  } finally {
    starting.delete(id);
  }
}

module.exports = {
  startConnection,
  normalizePhone
};
