# Telegram platform-bot webhook design (staging only)

## Status

Design/audit only. This document does not enable webhook delivery, change Telegram webhook configuration, alter production data, or deploy a Worker.

## Current verified architecture

- `telegram-webhook-server.js` accepts only `POST /telegram/webhook/:botId`, validates Telegram's secret-token header, validates the JSON update and strict non-negative `update_id`, then calls `enqueueTelegramUpdate`.
- `enqueueTelegramUpdate` stores updates in `bot_inbound_updates` and creates idempotent `telegram.update` platform jobs.
- `migrations/001_foundation_database.sql` defines `bot_inbound_updates.bot_id` as a foreign key to `telegram_bots(id)`. This is a customer-bot identity model.
- `worker.js` registers `telegram.update` with `createTelegramUpdateHandler`.
- `telegram-update-handler.js` loads the encrypted customer bot record, decrypts its token and creates a customer bot through `createCustomerBot`; it does not dispatch master or intake bot updates.
- `telegram-master.js` preserves its Node polling lifecycle but now accepts injected dependencies/environment and exposes `createWebhookRuntime().handleUpdate(update)` without starting polling.
- `intake-bot.js` preserves its Node polling entry points and now exposes an injected `createWebhookRuntime()` that registers the same handlers without calling grammY `.start()`.
- Customer bot updates already use `createCustomerBot(...).handleUpdate(update)` through the durable customer queue worker.
- Migration `007_platform_bot_inbox` adds a dedicated inbox for `master` and `intake`; these identities remain separate from customer bot records.
- The platform queue now has an atomic identity-scoped enqueue API and a lease-fenced handler factory; the production worker and ingress are not wired to these new job types yet.

## Non-negotiable design boundary

Do not route the master or intake bot through a customer `telegram_bots` row just to reuse the existing webhook endpoint. Those are distinct system identities with different authorization, lifecycle, and secret ownership. Do not put their tokens in customer bot records or weaken the existing customer ownership checks.

## Required implementation

### 1. Explicit bot identity and transport registry

Introduce a typed internal identity for each Telegram endpoint:
- `customer:<numeric-id>`
- `master`
- `intake`

The webhook ingress must resolve a route to an explicitly registered identity and its secret resolver. Unknown identities must return 404; missing or incorrect secrets must return 401. The registry must not reveal whether a secret exists.

For platform bots, store only non-secret routing metadata in the database. Resolve token material from the dedicated runtime secret provider; never store plaintext tokens in the queue payload or logs. The webhook secret must be independently derived/managed per bot identity and must not be the bot token itself.

### 2. Durable update inbox and idempotency

The existing customer inbox has a customer foreign key and cannot represent master/intake identities safely. Add a separate platform-bot inbox (or a rigorously typed shared inbox with a constrained identity key) with:
- identity type and stable identity key;
- Telegram `update_id` uniqueness per identity;
- JSON payload and bounded size;
- explicit queued/processing/processed/failed/dead-letter states;
- lease ownership and recovery fields;
- a unique job idempotency key.

Keep enqueue and job creation atomic. Duplicate delivery must be acknowledged without scheduling a second execution. Do not change or backfill customer inbox rows.

### 3. Handler factories without polling side effects

For master and intake bots, separate:
- constructing the grammY Bot and registering handlers;
- accepting one update via `bot.handleUpdate(update)`;
- starting/stopping long polling (Node-only transport).

Importing modules must not create a database pool, acquire the Telegram runtime lock, start timers, register process signal handlers, start polling, or make network requests.

Factories must accept explicit dependencies (API token, persistence adapter, notification sender, logger). A Cloudflare adapter must not import `pg`, `db.js`, or Node-only host startup modules.

### 4. Queue dispatch

Use distinct registered job types, for example:
- `telegram.customer.update`
- `telegram.master.update`
- `telegram.intake.update`

Do not dispatch system-bot updates through `createCustomerBot`. Each handler must validate the job identity against the inbox row and its lease before processing and before marking completion. A stale worker must not complete or fail an update after losing its lease.

### 5. Cloudflare boundary

The Cloudflare Worker should perform only bounded HTTP validation, secret verification, and durable enqueue through a verified staging-only data path. Long-running AI analysis, code generation, builds, tests, deployment preflight, and all other heavy work remain in durable Node workers.

The Worker must not receive production tokens, production database credentials, or the production encryption key. Use a dedicated empty staging Neon branch/database and a staging-only key. Verify the Hyperdrive binding points to that exact staging database before any connection test.

## Acceptance gates

1. Unit tests for identity parsing, secret isolation, unknown routes, invalid JSON, payload limits, and duplicate update IDs.
2. Import tests prove master/intake modules have no polling, signal, lock, DB-pool, timer, or network side effects.
3. Handler tests prove each identity dispatches only to its own handler and cannot cross-call customer bot creation.
4. PostgreSQL integration tests use disposable staging/test databases only and prove atomic inbox+job enqueue, lease renewal, lease-loss fencing, retry, and dead-letter behavior.
5. Cloudflare bundle test proves no unsupported Node server, `pg.Pool`, or production runtime modules are bundled into the edge Worker.
6. End-to-end test uses separate staging master/intake bot tokens and a dedicated staging database. Never point test webhooks at production bots.
7. Only after all gates pass may a staging-only deployment workflow be proposed. Workflow must target the GitHub `cloudflare-staging` environment and one explicitly named staging Worker.

## Explicitly out of scope

- No production Render changes.
- No production Neon migrations or database connections.
- No production Telegram webhook set/delete calls or token changes.
- No changes to `BOTS_ENCRYPTION_KEY`.
- No Cloudflare production deployment.
- No automatic promotion from staging to production.

## Implementation progress

- PR 77: additive platform-bot inbox migration and disposable PostgreSQL identity/deduplication tests — merged.
- PR 78: injectable intake runtime and no-polling `handleUpdate` adapter — merged.
- PR 79: injectable master runtime and no-polling `handleUpdate` adapter — merged.
- PR 80: atomic platform inbox + queue-job enqueue, distinct master/intake job types, and worker-lease-fenced dispatch handler with unit and PostgreSQL integration tests — merged.
- PR 81: opt-in Node worker wiring for the two system job types. It requires `PLATFORM_BOT_WEBHOOK_MODE=enabled` plus distinct master/intake tokens and an admin ID; the default remains disabled — merged.
- PR 83: separate Node ingress routes and independent master/intake webhook secrets — merged.
- Current Cloudflare Worker source in `cloudflare/worker.mjs` validates platform webhook requests and enqueues via Hyperdrive using a short-lived `pg.Client`. It has unit/source-boundary tests, but no real Wrangler bundle or live Hyperdrive test yet.
- None of these changes configures Telegram webhooks or changes production tokens.

## Next coding slice

Add a real Wrangler dry-run/bundle test, then verify a newly created Hyperdrive binding points only to the dedicated empty Neon staging database. After explicit staging setup, run end-to-end tests with staging-only tokens/secrets and the Node queue worker. Add a deploy workflow scoped to `cloudflare-staging` only after those gates pass. Do not change production webhooks, tokens, databases, or deployments.
