# Cloudflare runtime compatibility audit

Status: source audit only. No Worker is deployed and no staging database, Telegram bot, webhook, or secret is configured by this change.

## Audit baseline

This review compares the older `cloudflare-webhook-prep` prototype with the current `audit-hardening` runtime at the time this document was written. The older Worker must not be copied or deployed as-is.

## Blocking incompatibilities found

### 1. Master bot module starts polling during import

The current `telegram-master.js`:
- exits the process when `TELEGRAM_BOT_TOKEN` or `TELEGRAM_ADMIN_ID` is missing;
- creates the grammY bot at module scope;
- installs SIGTERM/SIGINT handlers at module scope;
- calls its `start()` routine at module scope, which initializes the database, takes a PostgreSQL advisory runtime lock, starts customer/intake services, and begins long polling.

The old Worker dynamically imports this module and expects to obtain an exported bot and initializer. That is not a safe or valid webhook contract for the current source. A Worker import must not trigger polling, process exit, or process-wide shutdown hooks.

### 2. Current database module is process-pool based

The current `db.js` creates the main `pg.Pool` and direct advisory-lock `pg.Pool` as soon as it is imported. It requires a valid `DATABASE_URL` and uses the shared strict PostgreSQL TLS configuration.

The older prototype's Worker-specific `pg.Client` adapter and disabled advisory-lock pool existed only on the diverged old branch. They are not present in current `audit-hardening`. Do not reintroduce the old branch's `rejectUnauthorized: false` TLS configuration.

A Cloudflare-compatible database layer must be explicitly designed around Hyperdrive, bounded connections, transaction lifetime, and the current SSL policy. It must not mutate shared global connection settings between requests.

### 3. Intake bot still starts polling

The current `intake-bot.js` exports `startIntakeBot` without the old prototype's webhook-mode option. The old Worker's call with a third `{ webhook: true }` argument is therefore not proof that current intake handlers can run in webhook mode.

### 4. Customer runtime is polling-oriented

The current `bot-runtime.js` starts customer bots using grammY polling. A Worker route cannot safely assume that importing the existing runtime exposes a webhook-ready customer bot factory without a deliberate refactor and tests.

### 5. Old deployment configuration is not trusted

The old `wrangler.toml` contains a Hyperdrive ID copied from the prototype branch. Its current ownership, target database, and staging-only status have not been independently verified. It must not be reused. The new staging config must bind a newly verified Hyperdrive configuration that points only to a dedicated empty Neon staging project.

## Required implementation sequence

1. Extract bot construction and handler registration into side-effect-free factories. Keep polling startup in explicit Node entrypoints only.
2. Add an explicit webhook mode for master, intake, and customer bots. Verify that importing modules never starts polling, acquires runtime locks, exits the process, or installs global shutdown handlers.
3. Design the Cloudflare database adapter for Hyperdrive using the current PostgreSQL TLS policy. Add tests for query, transaction, connection cleanup, and failure paths.
4. Keep long-running AI analysis/build/test and deployment preflight work in the existing durable queue and isolated Node workers. Webhook requests should acknowledge quickly after durable acceptance.
5. Add strict webhook authentication, content-type and body-size validation, safe update-ID validation, idempotency, and concurrency-safe claims. Reuse current security helpers where possible rather than copying the old prototype's weaker logic.
6. Add Cloudflare runtime/bundle tests and end-to-end tests using only staging credentials and a dedicated empty staging database.
7. Only after all gates pass, add a GitHub Actions deploy workflow scoped to the `cloudflare-staging` GitHub Environment and the named staging Worker.

## Explicitly not done

- No code from `cloudflare-webhook-prep` has been copied into the current runtime.
- No `wrangler.toml` or Hyperdrive ID has been added to the current branch.
- No Cloudflare API token, account ID, Telegram token, webhook secret, database URL, or encryption key has been requested, stored, or committed.
- No database migration or schema initializer has been run.
- No Telegram `setWebhook` call has been made.
- Render and production Neon remain untouched.

## Acceptance gate

The integration is not ready for deployment until the implementation sequence above is completed and the dedicated staging resources are independently verified. A successful Node CI run alone does not establish Cloudflare runtime compatibility.
