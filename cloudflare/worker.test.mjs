import test from "node:test";
import assert from "node:assert/strict";
import worker from "./worker.mjs";

test("health endpoint reports staging mode without exposing secrets", async () => {
  const response = await worker.fetch(
    new Request("https://example.workers.dev/healthz"),
    {}
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.mode, "webhook-staging");
  assert.equal(body.configured, false);
  assert.equal(JSON.stringify(body).includes("TOKEN"), false);
});

test("unknown paths return 404", async () => {
  const response = await worker.fetch(
    new Request("https://example.workers.dev/not-a-route"),
    {}
  );

  assert.equal(response.status, 404);
});

test("webhook is disabled until staging secrets exist", async () => {
  const response = await worker.fetch(
    new Request("https://example.workers.dev/telegram/master", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ update_id: 1, message: { text: "/start" } })
    }),
    {}
  );
  const body = await response.json();

  assert.equal(response.status, 503);
  assert.equal(body.error, "worker_secrets_missing");
});

test("webhook rejects an invalid Telegram secret before loading database runtime", async () => {
  const response = await worker.fetch(
    new Request("https://example.workers.dev/telegram/master", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": "wrong-secret"
      },
      body: JSON.stringify({ update_id: 2, message: { text: "/start" } })
    }),
    {
      TELEGRAM_BOT_TOKEN: "staging-token",
      TELEGRAM_ADMIN_ID: "123456",
      MASTER_WEBHOOK_SECRET: "correct-secret",
      HYPERDRIVE: { connectionString: "postgres://staging" }
    }
  );
  const body = await response.json();

  assert.equal(response.status, 401);
  assert.equal(body.error, "invalid_webhook_secret");
});
