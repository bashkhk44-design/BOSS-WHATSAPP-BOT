# Cloudflare staging integration

Status: Worker ingress source and Node platform-bot execution path are implemented. Staging deployment is still blocked because no verified staging Hyperdrive binding, Cloudflare secrets, staging bot credentials, or live end-to-end test have been supplied.

## Current architecture

1. Cloudflare Worker (`cloudflare/worker.mjs`) validates bounded Telegram webhook requests and authenticates each bot identity.
2. The Worker uses a per-request `pg.Client` through the `HYPERDRIVE` binding and durably enqueues the update.
3. Master and intake use separate identity-scoped inbox rows and job types: `telegram.master.update` and `telegram.intake.update`.
4. Customer bots use the existing customer inbox and `telegram.update` jobs.
5. Dedicated Node workers execute master/intake and customer bot updates. The edge Worker does not run bot handlers or AI/code-generation tasks.

## Current implementation

- Master and intake bot handlers expose webhook-mode adapters without starting long polling.
- Node has separate platform webhook ingress and platform worker entrypoints.
- Cloudflare Worker supports master, intake, and customer webhook routes, bounded request bodies, secret-token authentication, duplicate-safe durable enqueue, `/healthz`, and `/db-healthz`.
- Customer bot token decryption and the existing HMAC webhook-secret derivation use Web Crypto in the Worker.
- The Worker imports the queue SQL helper, not the Node database pool or Node HTTP server.
- Cloudflare's documented Hyperdrive pattern is used: `pg.Client` per request, not a process-wide `pg.Pool`.

## Required staging configuration (not yet populated)

GitHub Environment: `cloudflare-staging`

- A new empty Neon staging branch/database.
- A new Hyperdrive configuration connected only to that staging database.
- A local, untracked `cloudflare/wrangler.jsonc` copied from `cloudflare/wrangler.jsonc.example`, with the new staging Hyperdrive ID.
- `CLOUDFLARE_API_TOKEN` with access only to the staging Worker.
- `CLOUDFLARE_ACCOUNT_ID`.
- Staging-only `BOTS_ENCRYPTION_KEY`, `MASTER_WEBHOOK_SECRET`, and `INTAKE_WEBHOOK_SECRET`.
- Staging-only master/intake Telegram bot tokens for the Node worker.

Never copy production tokens, database URLs, encryption keys, or Cloudflare credentials into staging.

## Acceptance criteria before enabling deployment

- Wrangler bundle test proves the Worker does not bundle Node HTTP servers, `db.js`, `pg.Pool`, or Telegram polling runtimes.
- Hyperdrive connection test reaches only the dedicated Neon staging database.
- Staging migrations are applied and verified idempotently.
- Master, intake, and customer webhook routes pass end-to-end tests using separate staging bots.
- Duplicate update IDs are acknowledged without creating duplicate work.
- Retry, lease expiry, lease-loss fencing, and worker shutdown are verified.
- AI analysis/build/test and deployment preflight remain on isolated Node workers.
- A new deploy workflow targets only the `cloudflare-staging` GitHub Environment and the explicitly named staging Worker.

## Production boundary

The old `cloudflare-webhook-prep` branch is not a deployment source. Its old workflow was removed. No production Render, Neon, Telegram webhook, Cloudflare resource, or production encryption key has been changed. Production cutover remains a separate, explicitly approved operation.
