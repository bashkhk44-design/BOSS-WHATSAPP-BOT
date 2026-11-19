# Telegram platform-bot webhook design (staging only)

## Current status — 2026-11-18

The application-side webhook architecture and credential-free Cloudflare bundle validation are implemented on `audit-hardening`. The remaining blocker is external staging infrastructure: a newly created, empty Neon staging database and a newly created Hyperdrive binding verified to target only that database. No live Hyperdrive connection or Telegram staging end-to-end test has been performed.

No production Render, Neon, Telegram, or Cloudflare resource has been changed.

## Verified architecture

- Customer Telegram webhooks remain on the customer identity path and use the customer bot inbox and ownership checks.
- Master and intake are separate system identities. Migration `007_platform_bot_inbox` gives them a dedicated durable inbox; their update IDs are unique per identity.
- The platform queue atomically creates identity-scoped inbox rows and jobs. Master and intake use distinct job types and lease-fenced dispatch.
- `telegram-master.js` and `intake-bot.js` expose explicit webhook runtimes with `handleUpdate(update)`; their normal Node polling entry points remain separate.
- The opt-in Node platform worker and Node ingress have separate master/intake routes and independent webhook secrets. The default mode remains disabled.
- `cloudflare/worker.mjs` is an edge ingress for the master and intake platform routes. It validates bounded JSON requests, authenticates the identity-specific secret, and durably enqueues through Hyperdrive using a short-lived `pg.Client`. It does not execute bot handlers or AI/build/test jobs.
- AI analysis, code generation, project builds, tests, deployment preflight, and Telegram update handling remain in durable Node workers.

## Security boundaries

- Never represent master or intake as customer `telegram_bots` records.
- Never put bot tokens or webhook secrets in queue payloads or logs.
- Master and intake webhook secrets must be independent, URL-safe values and must not equal either bot API token.
- The Worker must use a dedicated empty staging database through a newly created staging-only Hyperdrive binding. Do not reuse the old prototype Hyperdrive ID.
- Do not put production tokens, production database credentials, or the production `BOTS_ENCRYPTION_KEY` in the Worker or staging environment.
- The Worker must not import Node host startup modules, `db.js`, or process-scoped `pg.Pool` instances. Its bounded `pg.Client` use is limited to Hyperdrive ingress.

## Validation completed

- PR 77: additive platform-bot inbox migration and disposable PostgreSQL identity/deduplication tests — merged.
- PR 78: injectable intake runtime and no-polling `handleUpdate` adapter — merged.
- PR 79: injectable master runtime and no-polling `handleUpdate` adapter — merged.
- PR 80: atomic platform inbox + queue-job enqueue, distinct master/intake job types, and lease-fenced dispatch — merged.
- PR 81: opt-in Node worker wiring for master and intake job types — merged; disabled by default.
- PR 83: separate Node ingress routes and independent master/intake webhook secrets — merged.
- PR 84: Cloudflare edge Worker for platform webhook ingress — merged.
- PR 85: stale Cloudflare deployment workflow disabled until the current runtime is safely staged — merged.
- PR 87: CI guards for Wrangler compatibility, `pg` minimum version, disabled staging config, placeholder Hyperdrive ID, and absence of committed webhook secrets — merged.
- PR 89: bounded PostgreSQL connection/query operations and rejection of compressed request bodies — merged.
- CI run `44211018849`: all four jobs passed. The Node 24 job completed `wrangler deploy --dry-run` using `cloudflare/wrangler.bundle-test.jsonc`; this proves the Worker bundles without deploying or connecting to a database.
- Disposable PostgreSQL migration, inbox, queue, and worker integration suites passed in the same CI run.

## Remaining acceptance gates

1. Create a new, empty Neon staging branch/database. This must be separate from production.
2. Create a new Cloudflare Hyperdrive configuration pointing only to that exact staging database. Do not reuse the historical prototype ID.
3. Verify the Hyperdrive target from the Cloudflare account before using its ID. Keep the ID and credentials out of Git.
4. Add staging-only GitHub Environment values and staging-only master/intake Telegram bot tokens and webhook secrets. Do not reuse production credentials.
5. Apply migrations only to the verified disposable staging database.
6. Run a live Hyperdrive database health/identity check, then staging-only Telegram webhook end-to-end tests with the Node queue worker.
7. Only after all gates pass, add a deployment workflow restricted to the GitHub `cloudflare-staging` environment and one explicitly named staging Worker.

## Explicitly out of scope

- No production Render changes.
- No production Neon migrations or database connections.
- No production Telegram webhook set/delete calls or token changes.
- No changes to `BOTS_ENCRYPTION_KEY`.
- No Cloudflare production deployment.
- No automatic promotion from staging to production.
- No staging resource creation or deployment without explicit authorization.

## Next step

The next meaningful step is staging infrastructure verification, not more application code. Until a dedicated empty Neon database and a new Hyperdrive binding exist and are verified, keep the Worker disabled and do not attempt a live connection.
