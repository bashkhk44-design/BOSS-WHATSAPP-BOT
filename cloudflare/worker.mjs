import { Client } from "pg";
import queue from "../platform-queue.js";

const { enqueueTelegramUpdate, enqueuePlatformBotUpdate } = queue;
const encoder = new TextEncoder();
const MAX_BODY_BYTES = 1024 * 1024;

function json(status, body) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" }
  });
}

function hexToBytes(value) {
  if (typeof value !== "string" || !/^[0-9a-fA-F]+$/.test(value) || value.length % 2 !== 0) {
    throw new Error("Invalid hexadecimal key material");
  }
  const bytes = new Uint8Array(value.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToHex(bytes) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

function safeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  if (a.length === 0 || a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i += 1) difference |= a[i] ^ b[i];
  return difference === 0;
}

async function readBoundedBody(request, maximumBytes = MAX_BODY_BYTES) {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^\d+$/.test(declaredLength)) {
      const error = new Error("Invalid Content-Length");
      error.status = 400;
      throw error;
    }
    if (Number(declaredLength) > maximumBytes) {
      const error = new Error("Payload too large");
      error.status = 413;
      throw error;
    }
  }

  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumBytes) {
        await reader.cancel();
        const error = new Error("Payload too large");
        error.status = 413;
        throw error;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function decryptCustomerToken(record, encryptionKeyHex, cryptoApi = globalThis.crypto) {
  const keyBytes = hexToBytes(encryptionKeyHex);
  if (keyBytes.byteLength !== 32) throw new Error("BOTS_ENCRYPTION_KEY must be 32 bytes");
  const key = await cryptoApi.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);
  const iv = hexToBytes(record.token_iv);
  const ciphertext = base64ToBytes(record.token_ciphertext);
  const authTag = hexToBytes(record.token_auth_tag);
  if (iv.byteLength !== 12 || authTag.byteLength !== 16) throw new Error("Invalid encrypted bot token");
  const combined = new Uint8Array(ciphertext.byteLength + authTag.byteLength);
  combined.set(ciphertext, 0);
  combined.set(authTag, ciphertext.byteLength);
  const plaintext = await cryptoApi.subtle.decrypt({ name: "AES-GCM", iv }, key, combined);
  return new TextDecoder().decode(plaintext);
}

async function deriveCustomerWebhookSecret(botId, token, encryptionKeyHex, cryptoApi = globalThis.crypto) {
  const keyBytes = hexToBytes(encryptionKeyHex);
  if (keyBytes.byteLength !== 32) throw new Error("BOTS_ENCRYPTION_KEY must be 32 bytes");
  const key = await cryptoApi.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const message = encoder.encode("BOSS-BOT-MASTER-TELEGRAM-WEBHOOK-V1:" + String(botId) + ":" + token);
  const signature = await cryptoApi.subtle.sign("HMAC", key, message);
  return bytesToHex(new Uint8Array(signature));
}

function parseRoute(pathname) {
  const platform = pathname.match(/^\/telegram\/platform\/(master|intake)$/);
  if (platform) return { kind: "platform", identity: platform[1] };
  const customer = pathname.match(/^\/telegram\/webhook\/(\d+)$/);
  if (customer) {
    const botId = Number(customer[1]);
    if (Number.isSafeInteger(botId) && botId > 0) return { kind: "customer", botId };
  }
  return null;
}

function parseUpdate(bytes) {
  let update;
  try {
    update = JSON.parse(new TextDecoder().decode(bytes));
  } catch (_) {
    const error = new Error("Invalid JSON");
    error.status = 400;
    throw error;
  }
  if (!update || typeof update !== "object" || Array.isArray(update) ||
      !Number.isSafeInteger(update.update_id) || update.update_id < 0) {
    const error = new Error("Invalid Telegram update");
    error.status = 400;
    throw error;
  }
  return update;
}

export function createWorkerHandler({
  ClientCtor = Client,
  queueApi = { enqueueTelegramUpdate, enqueuePlatformBotUpdate },
  cryptoApi = globalThis.crypto,
  logger = console
} = {}) {
  return async function fetchHandler(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/healthz" && request.method === "GET") {
      return json(200, { ok: true, service: "boss-telegram-webhook" });
    }
    if (url.pathname === "/db-healthz" && request.method === "GET") {
      let healthClient;
      try {
        if (!env.HYPERDRIVE?.connectionString) return json(503, { ok: false });
        healthClient = new ClientCtor({ connectionString: env.HYPERDRIVE.connectionString });
        await healthClient.connect();
        await healthClient.query("SELECT 1");
        return json(200, { ok: true, database: "reachable" });
      } catch (error) {
        logger.error("CLOUDFLARE STAGING DATABASE HEALTH CHECK FAILED:", error.message);
        return json(503, { ok: false, database: "unavailable" });
      } finally {
        if (healthClient) await healthClient.end().catch(() => {});
      }
    }

    const route = parseRoute(url.pathname);
    if (!route) return json(404, { ok: false, error: "not_found" });
    if (request.method !== "POST") {
      return new Response(JSON.stringify({ ok: false, error: "method_not_allowed" }), {
        status: 405,
        headers: { "Content-Type": "application/json; charset=utf-8", "Allow": "POST", "Cache-Control": "no-store" }
      });
    }

    const contentType = (request.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
    if (contentType !== "application/json") return json(415, { ok: false, error: "unsupported_media_type" });

    let client;
    try {
      const update = parseUpdate(await readBoundedBody(request));
      if (!env.HYPERDRIVE?.connectionString) throw new Error("HYPERDRIVE binding is missing");

      if (route.kind === "platform") {
        const secretName = route.identity === "master" ? "MASTER_WEBHOOK_SECRET" : "INTAKE_WEBHOOK_SECRET";
        const expected = env[secretName];
        const otherSecret = env[route.identity === "master" ? "INTAKE_WEBHOOK_SECRET" : "MASTER_WEBHOOK_SECRET"];
        if (!/^[A-Za-z0-9_-]{32,256}$/.test(expected || "") ||
            expected === otherSecret ||
            !safeEqual(request.headers.get("x-telegram-bot-api-secret-token"), expected)) {
          return json(401, { ok: false, error: "unauthorized" });
        }
      } else {
        client = new ClientCtor({ connectionString: env.HYPERDRIVE.connectionString });
        await client.connect();
        const bot = await client.query(
          "SELECT id, token_ciphertext, token_iv, token_auth_tag FROM telegram_bots WHERE id = $1 AND active = TRUE AND token_ciphertext IS NOT NULL LIMIT 1",
          [route.botId]
        );
        if (!bot.rowCount) return json(401, { ok: false, error: "unauthorized" });
        const token = await decryptCustomerToken(bot.rows[0], env.BOTS_ENCRYPTION_KEY, cryptoApi);
        const expected = await deriveCustomerWebhookSecret(route.botId, token, env.BOTS_ENCRYPTION_KEY, cryptoApi);
        if (!safeEqual(request.headers.get("x-telegram-bot-api-secret-token"), expected)) {
          return json(401, { ok: false, error: "unauthorized" });
        }
      }

      if (!client) {
        client = new ClientCtor({ connectionString: env.HYPERDRIVE.connectionString });
        await client.connect();
      }

      const queued = route.kind === "platform"
        ? await queueApi.enqueuePlatformBotUpdate(client, { botIdentity: route.identity, update })
        : await queueApi.enqueueTelegramUpdate(client, { botId: route.botId, update });

      return json(200, {
        ok: true,
        duplicate: queued.duplicate,
        queued: !queued.duplicate
      });
    } catch (error) {
      if (error.status) return json(error.status, { ok: false, error: error.status === 413 ? "payload_too_large" : "invalid_request" });
      logger.error("CLOUDFLARE TELEGRAM WEBHOOK INGEST ERROR:", error.message);
      return json(503, { ok: false, error: "temporarily_unavailable" });
    } finally {
      if (client) await client.end().catch(() => {});
    }
  };
}

const handler = createWorkerHandler();

export default {
  fetch(request, env, ctx) {
    return handler(request, env, ctx);
  }
};

export { decryptCustomerToken, deriveCustomerWebhookSecret, parseRoute, readBoundedBody, safeEqual };
