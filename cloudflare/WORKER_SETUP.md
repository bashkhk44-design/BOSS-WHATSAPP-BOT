# Cloudflare Telegram webhook Worker

This Worker is an edge-only ingress adapter. It validates Telegram webhook requests and durably enqueues updates; it does not run bot handlers or AI jobs.

## Routes

- `POST /telegram/platform/master` — platform master bot.
- `POST /telegram/platform/intake` — platform intake bot.
- `POST /telegram/customer/:botId` — one active customer bot whose database record has `transport_mode = 'webhook'`.

The customer route derives a per-bot Telegram secret-token value from the root `CUSTOMER_WEBHOOK_SECRET` using HMAC-SHA256 and the bot ID. The root secret must be 32-256 URL-safe characters and must not be a Telegram bot token. Keep it only as a Cloudflare Worker secret; never commit its value.

The Worker validates route identity, secret-token header, JSON content type, bounded body size, Telegram `update_id`, and active bot transport mode before enqueueing. It does not create Telegram bot clients or process updates.

## Database connection

The Worker uses `pg.Client` with `HYPERDRIVE.connectionString`. It creates one short-lived client per request and always calls `end()`; Hyperdrive owns the regional connection pool. Do not replace this with a process-wide `pg.Pool` in the Worker.

The repository pins `pg` at `^8.23.1`, above Cloudflare's documented minimum `8.16.3` for node-postgres with Hyperdrive. The Worker requires `nodejs_compat`. Do not disable TLS or set `rejectUnauthorized: false`.

## Staging-only setup

1. Create a dedicated Neon staging project/database (or branch only if its parent/source is verified not to contain production data).
2. Verify the Neon project, branch ancestry, database name, and origin hostname independently. A name containing `staging`, a branch named `production`, or a matching Hyperdrive hostname alone does not prove the database is empty or isolated.
3. Create a new Hyperdrive configuration pointing only to that verified staging database. Never reuse a production or prototype Hyperdrive ID.
4. Copy `wrangler.staging.example.jsonc` to a private local `wrangler.jsonc` and replace the Hyperdrive placeholder with the verified staging Hyperdrive ID.
5. Configure Worker secrets separately with `wrangler secret put MASTER_WEBHOOK_SECRET`, `wrangler secret put INTAKE_WEBHOOK_SECRET`, and `wrangler secret put CUSTOMER_WEBHOOK_SECRET`. Use independent random values; do not commit them or reuse Telegram bot tokens.
6. Keep `PLATFORM_BOT_WEBHOOK_MODE=disabled` and `CUSTOMER_BOT_WEBHOOK_MODE=disabled` until the dedicated Node queue worker, staging-only bot tokens, encryption key, database, and end-to-end tests are ready.
7. Keep `workers_dev=false` until a reviewed staging route is deliberately configured.

The edge Worker does not need Telegram bot tokens or the BOTS encryption key. Those remain in the isolated Node worker. No production credentials belong in the Worker environment.

## Processing boundary

The Worker only authenticates and enqueues. Platform and customer update handlers, Telegram API calls, AI analysis, design/build/test pipelines, and deployment preflight remain in Node queue workers. The customer webhook worker must use the same isolated staging database and staging encryption key as the customer bot records.

## Safety and current limitations

- The staging example contains a placeholder Hyperdrive ID and disabled modes; it is not ready to deploy.
- No live Hyperdrive connection or end-to-end Telegram test is implied by a Wrangler dry-run bundle.
- Do not deploy, register Telegram webhooks, or enable either mode until staging isolation and all end-to-end checks are independently verified.
- Production Render, Neon, Telegram tokens/webhooks, and `BOTS_ENCRYPTION_KEY` remain untouched until a separately approved cutover.
