'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const { enqueueTelegramUpdate } = require('./platform-queue');

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(body));
}

function createTelegramWebhookServer({
  pool,
  resolveSecret,
  maxBodyBytes = 1024 * 1024,
  logger = console
}) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('PostgreSQL pool is required');
  if (typeof resolveSecret !== 'function') throw new TypeError('resolveSecret(botId) is required');
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1024) throw new RangeError('maxBodyBytes must be at least 1024');

  return http.createServer(async (req, res) => {
    const pathname = (req.url || '').split('?')[0];
    const match = pathname.match(/^\/telegram\/webhook\/(\d+)$/);

    if (!match) return sendJson(res, 404, { ok: false, error: 'not_found' });
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
    }

    const botId = Number(match[1]);
    if (!Number.isSafeInteger(botId) || botId < 1) {
      return sendJson(res, 404, { ok: false, error: 'not_found' });
    }

    try {
      const expectedSecret = await resolveSecret(botId);
      const suppliedSecret = req.headers['x-telegram-bot-api-secret-token'];
      if (!expectedSecret || !safeEqual(suppliedSecret, expectedSecret)) {
        return sendJson(res, 401, { ok: false, error: 'unauthorized' });
      }

      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > maxBodyBytes) {
          return sendJson(res, 413, { ok: false, error: 'payload_too_large' });
        }
        chunks.push(chunk);
      }

      let update;
      try {
        update = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch (_) {
        return sendJson(res, 400, { ok: false, error: 'invalid_json' });
      }

      // Telegram update_id is a JSON integer. Reject strings, fractions,
      // negative values, and non-object payloads before touching the queue.
      if (!update || typeof update !== 'object' || Array.isArray(update) ||
          !Number.isSafeInteger(update.update_id) || update.update_id < 0) {
        return sendJson(res, 400, { ok: false, error: 'invalid_update' });
      }

      const queued = await enqueueTelegramUpdate(pool, { botId, update });
      return sendJson(res, 200, {
        ok: true,
        duplicate: queued.duplicate,
        queued: !queued.duplicate
      });
    } catch (error) {
      logger.error('TELEGRAM WEBHOOK INGEST ERROR:', error.message);
      return sendJson(res, 503, { ok: false, error: 'temporarily_unavailable' });
    }
  });
}

module.exports = { createTelegramWebhookServer };
