# Cloudflare runtime compatibility audit

Status: this branch contains Cloudflare edge-ingress code for platform and customer Telegram webhooks plus a dedicated Node customer webhook queue worker. The source is not proof of a live deployment. A Wrangler dry-run bundle does not test a live Hyperdrive connection or Telegram delivery.

## Current implementation

### Cloudflare edge adapter

- `cloudflare/worker.mjs` handles `POST /telegram/platform/master`, `POST /telegram/platform/intake`, and `POST /telegram/customer/:botId`.
- Platform routes use independent master/intake webhook secrets.
- The customer route is disabled unless `CUSTOMER_BOT_WEBHOOK_MODE=enabled`; it requires `CUSTOMER_WEBHOOK_SECRET`, derives a per-bot HMAC-SHA256 secret, validates the Telegram secret-token header, and checks that the bot is active with `transport_mode='webhook'`.
- The Worker validates content type, request encoding, bounded body size, JSON, and Telegram update ID before enqueueing.
- It uses `pg.Client` with `HYPERDRIVE.connectionString` and closes the client after each request. It does not import customer bot runtimes or Node queue workers.

### Node processing boundary

- The Worker only enqueues. `customer-webhook-worker.js` processes durable customer updates in Node through the existing grammY customer bot handlers.
- The customer webhook worker is separately gated by `CUSTOMER_WEBHOOK_WORKER_ENABLED=YES` and requires a dedicated database connection and staging encryption key.
- Existing polling workers claim only active customer bots in `polling` mode. Webhook dispatch selects only active bots in `webhook` mode.
- Migration `008_customer_bot_transport_mode` defaults existing records to `polling`, preserving the current transport until explicitly changed.

## Hyperdrive and staging requirements

- `cloudflare/wrangler.staging.example.jsonc` is a template with a placeholder Hyperdrive ID and both webhook modes disabled.
- Configure `MASTER_WEBHOOK_SECRET`, `INTAKE_WEBHOOK_SECRET`, and `CUSTOMER_WEBHOOK_SECRET` as Cloudflare secrets; do not put secret values in source control.
- A hostname match between Hyperdrive and Neon proves the configured origin endpoint, but not that the Neon project/branch is empty or isolated from production.
- Verify Neon project identity, branch ancestry, database name, and data contents before enabling any staging runtime.
- A dry-run bundle test has no live Hyperdrive binding and is not a live database or end-to-end test.

## Explicitly not done

- No claim is made that a live Cloudflare Worker is deployed or that a route is registered for this staging transport.
- No production database migration, Telegram `setWebhook`, or production credential change is authorized by this branch.
- No production Render, Neon, tokens, secrets, or `BOTS_ENCRYPTION_KEY` changes.
- No production cutover. Keep Render and existing polling bots running until staging end-to-end tests pass and cutover is separately approved.
