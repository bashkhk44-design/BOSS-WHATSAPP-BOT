# Cloudflare runtime compatibility audit

Status: revised 2026-11-18. The current Node runtime now exposes explicit webhook-mode adapters for master and intake bots, and a separate Cloudflare Worker ingress source has been added. The older findings below describe the earlier baseline and are historical where marked. No Cloudflare Worker has been deployed and no staging database, Telegram bot, webhook, or secret has been configured by this change.

## Current status

- `telegram-master.js` now exports a factory; importing it does not start polling. Its explicit `createWebhookRuntime()` adapter handles updates without acquiring the Node polling lock or starting long polling.
- `intake-bot.js` now has an explicit webhook mode that registers the existing handlers and exposes `handleUpdate` without calling grammY `.start()`.
- Node has a dedicated platform queue worker for `telegram.master.update` and `telegram.intake.update`, plus a separate authenticated platform webhook ingress.
- `cloudflare/worker.mjs` is a lightweight edge ingress for master, intake, and customer webhook routes. It uses Hyperdrive and a per-request `pg.Client`; it does not import `db.js`, Node HTTP servers, or Telegram bot runtime modules.
- Customer token decryption and the existing token-derived webhook HMAC are implemented with Web Crypto in the Worker.
- AI analysis, code generation, builds, tests, deployment preflight, and bot update execution remain in durable Node workers.
- The active Cloudflare deployment workflow is intentionally disabled until a new staging Hyperdrive binding and all end-to-end gates are verified.

## Historical blockers found in the earlier implementation (superseded in part)

### 1. Master bot module startup

The old Cloudflare prototype expected to import the master module and receive an already-created bot. That was unsafe because the earlier module started polling and process-wide lifecycle work during import. The current factory-based implementation supersedes this behavior: Worker ingress does not import the master runtime at all; the separate Node worker constructs the bot in webhook mode.

### 2. Database connection model

The current Node `db.js` still creates process-scoped `pg.Pool` instances and must not be imported into the Worker. The edge Worker instead uses Cloudflare Hyperdrive with a new `pg.Client` per request. This follows Cloudflare's documented Hyperdrive pattern and keeps Node database pools out of the edge bundle.

### 3. Intake bot transport

The old prototype assumed intake supported webhook mode when it did not. The current `intake-bot.js` now explicitly supports webhook mode and exposes `handleUpdate` without starting polling. The Cloudflare Worker only enqueues updates; the Node platform worker executes them.

### 4. Customer bot transport

Customer bot updates are accepted by the Cloudflare Worker through the existing customer webhook identity. The Worker resolves the active customer bot record, decrypts its token using Web Crypto, derives the same HMAC secret as the Node ingress, and enqueues `telegram.update`. Customer bot execution remains in the Node customer worker.

### 5. Old deployment configuration is not trusted

The old `cloudflare-webhook-prep` branch and its Hyperdrive ID remain untrusted. The old deployment workflow that checked out that branch has been removed. Do not restore it or reuse its Hyperdrive ID.

## Required staging configuration

1. Create a new, empty Neon staging branch/database.
2. Create a new Hyperdrive configuration pointing only to that staging database.
3. Copy `cloudflare/wrangler.jsonc.example` to an untracked `cloudflare/wrangler.jsonc` and insert the new staging-only Hyperdrive ID.
4. Configure staging-only Worker secrets: `BOTS_ENCRYPTION_KEY`, `MASTER_WEBHOOK_SECRET`, and `INTAKE_WEBHOOK_SECRET`.
5. Configure the Node platform worker with staging-only master/intake bot tokens and the staging encryption key.
6. Apply the reviewed migrations to the staging database.
7. Run a real Wrangler bundle/deploy dry-run, Hyperdrive health check, and end-to-end webhook tests with staging bots.
8. Only then restore a staging-only deploy workflow scoped to the `cloudflare-staging` GitHub Environment.

## Explicitly not done

- No Cloudflare deployment.
- No Hyperdrive configuration or ID created or verified.
- No Cloudflare API token, account ID, Telegram token, webhook secret, database URL, or encryption key requested, stored, or committed.
- No database migration or schema initializer run against production.
- No Telegram `setWebhook` call made.
- Render and production Neon remain untouched.

## Acceptance gate

A successful Node CI run is not proof of Cloudflare compatibility or a live webhook. Staging deployment remains blocked until the new Worker bundle, Hyperdrive connection, migrations, separate bot identities, duplicate delivery, retry, and lease recovery all pass against disposable staging resources.
