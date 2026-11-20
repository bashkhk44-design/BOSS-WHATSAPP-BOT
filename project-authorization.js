'use strict';

function assertAuthorizedManager(telegramUserId, configuredManagerId = process.env.TELEGRAM_ADMIN_ID) {
  if (!/^\\d+$/.test(String(telegramUserId || ''))) {
    throw new Error('معرّف المدير غير صالح.');
  }
  if (!configuredManagerId || String(telegramUserId) !== String(configuredManagerId)) {
    throw new Error('غير مصرح: هذه العملية متاحة للمدير الرئيسي فقط.');
  }
  return true;
}

function assertTelegramUserId(telegramUserId) {
  if (!/^\\d+$/.test(String(telegramUserId || ''))) {
    throw new Error('معرّف Telegram غير صالح.');
  }
  return true;
}

module.exports = { assertAuthorizedManager, assertTelegramUserId };
