'use strict';

let configuredManagerId = process.env.TELEGRAM_ADMIN_ID;

function configureManagerIdentity(managerTelegramId) {
  if (managerTelegramId && !/^\d+$/.test(String(managerTelegramId))) {
    throw new Error('إعداد معرّف المدير الرئيسي غير صالح.');
  }
  if (managerTelegramId) configuredManagerId = String(managerTelegramId);
}

function assertAuthorizedManager(telegramUserId, managerId = configuredManagerId || process.env.TELEGRAM_ADMIN_ID) {
  if (!/^\d+$/.test(String(telegramUserId || ''))) {
    throw new Error('معرّف المدير غير صالح.');
  }
  if (!managerId || String(telegramUserId) !== String(managerId)) {
    throw new Error('غير مصرح: هذه العملية متاحة للمدير الرئيسي فقط.');
  }
  return true;
}

function assertTelegramUserId(telegramUserId) {
  if (!/^\d+$/.test(String(telegramUserId || ''))) {
    throw new Error('معرّف Telegram غير صالح.');
  }
  return true;
}

module.exports = { configureManagerIdentity, assertAuthorizedManager, assertTelegramUserId };
