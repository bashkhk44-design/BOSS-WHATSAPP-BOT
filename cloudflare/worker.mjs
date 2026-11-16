import { Bot, webhookCallback } from "grammy";

const MAX_UPDATE_BYTES = 1024 * 1024;
let cachedToken = null;
let cachedSecret = null;
let cachedHandler = null;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function getMasterWebhookHandler(env) {
  if (!env.MASTER_BOT_TOKEN || !env.MASTER_WEBHOOK_SECRET) {
    throw new Error("MASTER_BOT_TOKEN and MASTER_WEBHOOK_SECRET must be configured as Worker secrets.");
  }

  if (cachedHandler && cachedToken === env.MASTER_BOT_TOKEN && cachedSecret === env.MASTER_WEBHOOK_SECRET) {
    return cachedHandler;
  }

  const bot = new Bot(env.MASTER_BOT_TOKEN);
  // Staging smoke-test only. Production handlers depend on Node polling,
  // PostgreSQL pools, and a long-lived advisory lock, so they are not imported.
  const safe = bot.errorBoundary((err) => {
    console.error("STAGING TELEGRAM UPDATE ERROR:", err.error?.message || "unknown error");
  });

  safe.command("start", async (ctx) => {
    await ctx.reply(
      "BOSS BOT MASTER — Cloudflare staging webhook is connected.\n\n" +
      "This is a migration test endpoint; production features remain on Render."
    );
  });

  safe.command("health", async (ctx) => {
    await ctx.reply("Cloudflare staging webhook is receiving Telegram updates.");
  });

  cachedToken = env.MASTER_BOT_TOKEN;
  cachedSecret = env.MASTER_WEBHOOK_SECRET;
  cachedHandler = webhookCallback(bot, "cloudflare-mod", {
    secretToken: env.MASTER_WEBHOOK_SECRET
  });

  return cachedHandler;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/healthz" && request.method === "GET") {
      return json({
        ok: true,
        service: "BOSS BOT MASTER Cloudflare staging",
        mode: "webhook-staging",
        configured: Boolean(env.MASTER_BOT_TOKEN && env.MASTER_WEBHOOK_SECRET)
      });
    }

    if (url.pathname !== "/telegram/master") {
      return json({ ok: false, error: "not_found" }, 404);
    }

    if (request.method !== "POST") {
      return json({ ok: false, error: "method_not_allowed" }, 405);
    }

    const contentLength = Number(request.headers.get("content-length") || 0);
    if (contentLength > MAX_UPDATE_BYTES) {
      return json({ ok: false, error: "payload_too_large" }, 413);
    }

    if (!env.MASTER_BOT_TOKEN || !env.MASTER_WEBHOOK_SECRET) {
      return json({
        ok: false,
        error: "worker_secrets_missing",
        required: ["MASTER_BOT_TOKEN", "MASTER_WEBHOOK_SECRET"]
      }, 503);
    }

    try {
      const handler = getMasterWebhookHandler(env);
      return await handler(request);
    } catch (error) {
      console.error("STAGING WEBHOOK FAILURE:", error?.message || "unknown error");
      return json({ ok: false, error: "webhook_processing_failed" }, 500);
    }
  }
};
