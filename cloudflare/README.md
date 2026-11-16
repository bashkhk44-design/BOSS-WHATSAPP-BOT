# Cloudflare Workers Migration Preparation

Status: PREPARATION ONLY — do not deploy this repository to Workers yet.

This branch is isolated from `audit-hardening`. The production Render service and its environment variables are not changed.

## Current runtime facts

- `host.js` starts a Node.js HTTP health server and then loads `telegram-master.js`.
- `telegram-master.js`, `intake-bot.js`, and `bot-runtime.js` use grammY long polling via `bot.start()`.
- `db.js` uses `pg` pools, a second direct PostgreSQL pool, and a PostgreSQL advisory lock held by a long-lived connection.
- The AI pipeline is invoked from Telegram handlers and must be checked for Node-only APIs before moving it to an isolate.
- The current service expects a continuously running process. A Worker is request/event driven and must not be treated as a drop-in replacement for this process.

## Why the default Cloudflare Git integration settings are unsafe

The default build command `npx wrangler deploy` does not convert the existing Node.js polling application into a Worker. Deploying the repository as-is would not start the current Telegram polling loops or preserve the current runtime-lock behavior.

## Required migration work

1. Keep Render as the production runtime until the replacement passes tests.
2. Convert each Telegram bot from long polling to authenticated Telegram webhooks. Validate the webhook secret token and reject malformed or oversized updates.
3. Introduce Worker-compatible request handlers using grammY's webhook adapter. Do not call `bot.start()` in a Worker.
4. Replace the long-lived PostgreSQL advisory-lock design with an event/request-safe coordination design. Review all database queries and connection lifetimes.
5. Configure Cloudflare Hyperdrive (or another explicitly supported database transport) for Neon PostgreSQL; do not place database credentials in source code.
6. Audit AI SDK usage, timeouts, retries, payload sizes, and execution limits.
7. Add idempotency and duplicate-update protection before enabling webhooks.
8. Test master, intake, and customer bot flows separately, including callbacks, media, retries, AI jobs, and failure recovery.
9. Use a separate Cloudflare Worker and separate webhook endpoints/secrets for staging. Do not change the production Telegram webhook URLs until a complete acceptance test passes.
10. Cut over one bot at a time with a documented rollback to Render.

## Compatibility boundary

Cloudflare Workers can host the webhook-facing parts after refactoring. They are not a drop-in host for the existing always-on Node.js process. Any feature that requires a persistent process, unsupported Node API, or long-lived database connection must be redesigned or remain on a suitable Node.js host.

## Safe next step

Implement a staging-only Worker adapter and compatibility tests on this branch. No production bot tokens, database URLs, encryption keys, or other secrets belong in this file or in Git.
