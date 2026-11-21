# Platform Telegram worker and webhook ingress

## Added Node entrypoints

- `npm run start:platform-webhook` accepts only `POST /telegram/platform/master` and `POST /telegram/platform/intake`, verifies a separate Telegram secret-token value for each identity, and atomically enqueues the update through `enqueuePlatformBotUpdate`.
- `npm run start:platform-worker` claims only `telegram.master.update` and `telegram.intake.update` jobs. It constructs the existing master and intake bot handlers in webhook mode and never starts long polling.
- Customer-bot updates remain on the existing `telegram.update` worker path and customer inbox.

## Required environment

Copy `.env.platform.example` to a private local environment file and populate it with staging-only values. Do not commit the populated file. The worker requires a PostgreSQL application URL, a separate direct PostgreSQL URL for its session-scoped Telegram advisory lock, a 32-byte hex encryption key, master bot token, administrator Telegram ID, and intake bot token. Both database URLs must target the same isolated staging database; do not use a pooler endpoint for `DATABASE_DIRECT_URL`. The ingress requires the database URL and two independent URL-safe webhook secrets (32-256 characters).

Set Telegram's `secret_token` for the master bot to `MASTER_WEBHOOK_SECRET` and for the intake bot to `INTAKE_WEBHOOK_SECRET`. Keep those values separate from bot tokens. Configure each Telegram webhook URL to its matching route only after both staging services are deployed and tested.

## Isolation and deployment boundary

- Master and intake updates use distinct queue job types and a separate platform-bot inbox.
- The platform worker registers no customer `telegram.update` handler.
- The webhook ingress never receives or logs bot tokens.
- The ingress and worker are separate processes/services; the worker must have no public ingress.
- Start with a disposable PostgreSQL database and staging Telegram bots. Set `DATABASE_DIRECT_URL` to the database's direct (non-pooler) endpoint so the advisory lock stays on one PostgreSQL session. Do not point these processes at production or call Telegram `setWebhook` until the full staging acceptance test is complete.
- This wiring does not deploy services, change Telegram webhook configuration, migrate production data, or alter production secrets.

## Verification still required

Run the unit and PostgreSQL integration workflows on the new branch, then test separate staging master/intake bots end-to-end, including duplicate delivery, retry, lease expiry, and clean shutdown. A green CI run is not proof that a live webhook or production deployment is active.


## Combined Render web host (staging only)

- `npm run start:platform-host` runs the platform queue worker and the Render HTTP health server in one process.
- The host starts the HTTP server first, then verifies the database schema through the Master runtime, acquires the Telegram advisory lock, initializes both no-polling webhook adapters, checks PostgreSQL connectivity, and starts the queue loop.
- `/livez` reports process liveness. Configure the Render health-check path as `/readyz`, which returns 503 until the platform runtime has completed startup and while shutdown is in progress.
- If the Master runtime reports advisory-lock loss, the host marks itself not ready and begins graceful shutdown.
- This is a staging candidate only. It must be paired with the Cloudflare HTTPS /readyz wake handshake documented below, isolated staging bot credentials, webhook registration tests, and end-to-end acceptance. Do not change the production Render start command or Cloudflare mode until those gates pass.


## Cloudflare-to-Render wake handshake (staging only)

- Configure the Cloudflare Worker variable `PLATFORM_WORKER_WAKE_URL` to the HTTPS Render service readiness endpoint, exactly `https://YOUR-SERVICE.onrender.com/readyz`.
- After the durable queue transaction commits, Cloudflare requests this endpoint with an 8-second timeout. It returns Telegram webhook success only when Render reports ready.
- If Render is asleep, the request wakes the web service but readiness remains 503 during startup. Telegram receives a retryable 503; the queue's unique update key makes redelivery safe. A later delivery retries the wake and is acknowledged only after the queue worker is healthy.
- The URL is restricted to HTTPS and the exact `/readyz` path. No wake secret is required because this is a read-only readiness probe; do not add a state-changing unauthenticated wake route.
- This handshake is not yet live-configured. Keep the Cloudflare webhook mode disabled until the Render staging host, staging-only bots/database, and Telegram delivery retry behavior have passed end-to-end acceptance.
