import { webhookCallback } from "grammy";

const MAX_UPDATE_BYTES = 1024 * 1024;
let runtimePromise = null;
let masterWebhook = null;
let intakeWebhook = null;
let databaseReady = false;
const customerWebhookCache = new Map();

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders
    }
  });
}

async function initializeRuntime(env) {
  if (!env.HYPERDRIVE?.connectionString) {
    throw new Error("Cloudflare Hyperdrive binding HYPERDRIVE is not configured.");
  }
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_ADMIN_ID) {
    throw new Error("TELEGRAM_BOT_TOKEN and TELEGRAM_ADMIN_ID Worker secrets are required.");
  }
  if (!env.MASTER_WEBHOOK_SECRET) {
    throw new Error("MASTER_WEBHOOK_SECRET Worker secret is required.");
  }

  // Populate the legacy Node-style configuration before loading modules that
  // create their PostgreSQL pool or register Telegram handlers.
  process.env.BOSS_WEBHOOK_MODE = "true";
  process.env.DATABASE_URL = env.HYPERDRIVE.connectionString;
  process.env.TELEGRAM_BOT_TOKEN = env.TELEGRAM_BOT_TOKEN;
  process.env.TELEGRAM_ADMIN_ID = String(env.TELEGRAM_ADMIN_ID);
  process.env.BOTS_ENCRYPTION_KEY = env.BOTS_ENCRYPTION_KEY || "";
  process.env.GEMINI_API_KEY = env.GEMINI_API_KEY || "";
  process.env.GEMINI_MODEL = env.GEMINI_MODEL || "gemini-3.8-flash";
  process.env.GEMINI_FREE_MODEL = env.GEMINI_FREE_MODEL || "gemini-3.8-flash";
  process.env.GROQ_API_KEY = env.GROQ_API_KEY || "";
  process.env.AI_ENABLE_GROQ_FREE = env.AI_ENABLE_GROQ_FREE || "false";
  process.env.OPENROUTER_API_KEY = env.OPENROUTER_API_KEY || "";
  process.env.OPENROUTER_SITE_URL = env.OPENROUTER_SITE_URL || "https://boss-whatsapp-bot.workers.dev";

  const masterModule = await import("../telegram-master.js");
  const master = masterModule.default || masterModule;
  const runtimeModule = await import("../bot-runtime.js");
  const runtime = runtimeModule.default || runtimeModule;
  const dbModule = await import("../db.js");
  const db = dbModule.default || dbModule;

  await master.initDatabase();

  await master.pool.query(`
    CREATE TABLE IF NOT EXISTS telegram_webhook_updates (
      bot_key TEXT NOT NULL,
      update_id BIGINT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('processing', 'done', 'failed')),
      attempts INTEGER NOT NULL DEFAULT 1,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (bot_key, update_id)
    )
  `);

  masterWebhook = webhookCallback(master.bot, "cloudflare-mod", {
    secretToken: env.MASTER_WEBHOOK_SECRET
  });

  if (env.INTAKE_BOT_TOKEN && env.INTAKE_WEBHOOK_SECRET) {
    process.env.INTAKE_BOT_TOKEN = env.INTAKE_BOT_TOKEN;
    const intakeModule = await import("../intake-bot.js");
    const intake = intakeModule.default || intakeModule;

    const intakeBot = await intake.startIntakeBot(
      async ({ text, extra }) => {
        await master.bot.api.sendMessage(master.adminId, text, extra);
      },
      null,
      { webhook: true }
    );

    if (intakeBot) {
      intakeWebhook = webhookCallback(intakeBot, "cloudflare-mod", {
        secretToken: env.INTAKE_WEBHOOK_SECRET
      });
    }
  }

  databaseReady = true;
  return { master, runtime, db };
}

async function getRuntime(env) {
  if (!runtimePromise) {
    runtimePromise = initializeRuntime(env).catch((error) => {
      runtimePromise = null;
      throw error;
    });
  }
  return runtimePromise;
}

async function getCustomerWebhook(master, runtime, db, env, customerId) {
  if (!env.CUSTOMER_WEBHOOK_SECRET || !env.BOTS_ENCRYPTION_KEY) {
    throw new Error("CUSTOMER_WEBHOOK_SECRET and BOTS_ENCRYPTION_KEY are required.");
  }

  const result = await master.pool.query(`
    SELECT id, name, username, active, token_ciphertext,
           token_iv, token_auth_tag, token_fingerprint
    FROM telegram_bots
    WHERE id = $1 AND active = TRUE
      AND token_ciphertext IS NOT NULL
    LIMIT 1
  `, [customerId]);

  const record = result.rows[0];
  if (!record) return null;

  const cacheKey = String(record.id) + ":" + String(record.token_fingerprint || "");
  const cached = customerWebhookCache.get(String(customerId));
  if (cached && cached.cacheKey === cacheKey) return cached.handler;

  const token = db.decryptToken(record);
  const bot = runtime.createCustomerBot(record, token, {});
  const handler = webhookCallback(bot, "cloudflare-mod", {
    secretToken: env.CUSTOMER_WEBHOOK_SECRET
  });

  customerWebhookCache.set(String(customerId), { cacheKey, handler });
  return handler;
}

async function dispatchIdempotently(master, botKey, request, handler) {
  let update;
  try {
    const rawBody = await request.clone().text();
    if (new TextEncoder().encode(rawBody).byteLength > MAX_UPDATE_BYTES) {
      return json({ ok: false, error: "payload_too_large" }, 413);
    }
    update = JSON.parse(rawBody);
  } catch (_) {
    return json({ ok: false, error: "invalid_json" }, 400);
  }

  if (!Number.isSafeInteger(update?.update_id) || update.update_id < 0) {
    return json({ ok: false, error: "invalid_update_id" }, 400);
  }

  const claim = await master.pool.query(`
    INSERT INTO telegram_webhook_updates (bot_key, update_id, status)
    VALUES ($1, $2, 'processing')
    ON CONFLICT (bot_key, update_id)
    DO UPDATE SET
      status = 'processing',
      attempts = telegram_webhook_updates.attempts + 1,
      updated_at = NOW()
    WHERE telegram_webhook_updates.status = 'failed'
       OR telegram_webhook_updates.updated_at < NOW() - INTERVAL '2 minutes'
    RETURNING update_id
  `, [botKey, update.update_id]);

  if (!claim.rowCount) {
    const existing = await master.pool.query(
      "SELECT status FROM telegram_webhook_updates WHERE bot_key = $1 AND update_id = $2",
      [botKey, update.update_id]
    );

    if (existing.rows[0]?.status === "done") {
      return json({ ok: true, duplicate: true });
    }

    return json(
      { ok: false, error: "update_already_processing" },
      503,
      { "retry-after": "3" }
    );
  }

  try {
    const response = await handler(request);
    if (!response || !response.ok) {
      throw new Error("Telegram webhook handler returned a non-success response.");
    }

    await master.pool.query(
      "UPDATE telegram_webhook_updates SET status = 'done', updated_at = NOW() WHERE bot_key = $1 AND update_id = $2",
      [botKey, update.update_id]
    );
    return response;
  } catch (error) {
    await master.pool.query(
      "UPDATE telegram_webhook_updates SET status = 'failed', updated_at = NOW() WHERE bot_key = $1 AND update_id = $2",
      [botKey, update.update_id]
    );
    throw error;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/healthz" && request.method === "GET") {
      return json({
        ok: true,
        service: "BOSS BOT MASTER Cloudflare staging",
        mode: "telegram-webhooks",
        hyperdriveConfigured: Boolean(env.HYPERDRIVE?.connectionString),
        masterConfigured: Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_ADMIN_ID && env.MASTER_WEBHOOK_SECRET),
        intakeConfigured: Boolean(env.INTAKE_BOT_TOKEN && env.INTAKE_WEBHOOK_SECRET),
        runtimeInitialized: databaseReady
      });
    }

    if (url.pathname === "/db-healthz" && request.method === "GET") {
      if (!env.HYPERDRIVE?.connectionString) {
        return json({ ok: false, error: "hyperdrive_not_configured" }, 503);
      }

      let client;
      try {
        const pgModule = await import("pg");
        const Client = pgModule.Client || pgModule.default?.Client;
        if (!Client) throw new Error("node-postgres Client export is unavailable");

        client = new Client({
          connectionString: env.HYPERDRIVE.connectionString
        });
        await client.connect();

        const result = await client.query(`
          SELECT current_database() AS database_name,
                 current_user AS database_user,
                 current_setting('server_version') AS server_version
        `);

        return json({
          ok: true,
          connected: true,
          database: result.rows[0].database_name,
          serverVersion: result.rows[0].server_version
        });
      } catch (error) {
        console.error("STAGING DATABASE HEALTH CHECK FAILED:", error?.message || "unknown error");
        return json({ ok: false, connected: false, error: "database_connection_failed" }, 503);
      } finally {
        if (client) {
          try { await client.end(); } catch (_) {}
        }
      }
    }

    const isMaster = url.pathname === "/telegram/master";
    const isIntake = url.pathname === "/telegram/intake";
    const customerMatch = url.pathname.match(/^\/telegram\/customer\/(\d+)$/);
    const isCustomer = Boolean(customerMatch);
    const customerId = isCustomer ? Number(customerMatch[1]) : null;

    if (!isMaster && !isIntake && !isCustomer) {
      return json({ ok: false, error: "not_found" }, 404);
    }
    if (request.method !== "POST") {
      return json({ ok: false, error: "method_not_allowed" }, 405);
    }

    if (
      !env.TELEGRAM_BOT_TOKEN ||
      !env.TELEGRAM_ADMIN_ID ||
      !env.MASTER_WEBHOOK_SECRET
    ) {
      return json({
        ok: false,
        error: "worker_secrets_missing",
        required: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_ADMIN_ID", "MASTER_WEBHOOK_SECRET"]
      }, 503);
    }

    if (!env.HYPERDRIVE?.connectionString) {
      return json({
        ok: false,
        error: "hyperdrive_not_configured",
        required: ["HYPERDRIVE binding to a Neon staging branch"]
      }, 503);
    }

    if (isIntake && (!env.INTAKE_BOT_TOKEN || !env.INTAKE_WEBHOOK_SECRET)) {
      return json({
        ok: false,
        error: "intake_secrets_missing",
        required: ["INTAKE_BOT_TOKEN", "INTAKE_WEBHOOK_SECRET"]
      }, 503);
    }

    if (isCustomer && (!env.CUSTOMER_WEBHOOK_SECRET || !env.BOTS_ENCRYPTION_KEY)) {
      return json({
        ok: false,
        error: "customer_webhook_secrets_missing",
        required: ["CUSTOMER_WEBHOOK_SECRET", "BOTS_ENCRYPTION_KEY"]
      }, 503);
    }

    const expectedSecret = isMaster
      ? env.MASTER_WEBHOOK_SECRET
      : isIntake
        ? env.INTAKE_WEBHOOK_SECRET
        : env.CUSTOMER_WEBHOOK_SECRET;

    if (
      !expectedSecret ||
      request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== expectedSecret
    ) {
      return json({ ok: false, error: "invalid_webhook_secret" }, 401);
    }

    const contentLength = Number(request.headers.get("content-length") || 0);
    if (contentLength > MAX_UPDATE_BYTES) {
      return json({ ok: false, error: "payload_too_large" }, 413);
    }

    try {
      const { master, runtime, db } = await getRuntime(env);

      if (isIntake && !intakeWebhook) {
        return json({
          ok: false,
          error: "intake_webhook_not_configured",
          required: ["INTAKE_BOT_TOKEN", "INTAKE_WEBHOOK_SECRET"]
        }, 503);
      }

      if (isCustomer) {
        const customerHandler = await getCustomerWebhook(
          master, runtime, db, env, customerId
        );
        if (!customerHandler) {
          return json({ ok: false, error: "customer_bot_not_active" }, 404);
        }
        return await dispatchIdempotently(
          master,
          "customer:" + customerId,
          request,
          customerHandler
        );
      }

      return await dispatchIdempotently(
        master,
        isMaster ? "master" : "intake",
        request,
        isMaster ? masterWebhook : intakeWebhook
      );
    } catch (error) {
      console.error("CLOUDFLARE TELEGRAM WEBHOOK ERROR:", error?.message || "unknown error");
      return json({ ok: false, error: "webhook_processing_failed" }, 500);
    }
  }
};
