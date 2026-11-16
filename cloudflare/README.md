# Cloudflare Workers Migration Preparation

Status: STAGING SCAFFOLD ONLY — not production-ready and do not connect production bot tokens.

This work is isolated on branch `cloudflare-webhook-prep`. The Render production service, its environment variables, Telegram polling sessions, and Neon database have not been changed.

## What is implemented

- Root `wrangler.toml` points Wrangler to `cloudflare/worker.mjs`.
- A Cloudflare Module Worker exposes `GET /healthz`.
- A staging-only grammY webhook endpoint is available at `POST /telegram/master`.
- grammY's `cloudflare-mod` adapter validates Telegram's webhook secret token.
- The endpoint rejects non-POST requests, unknown paths, oversized declared payloads, and missing Worker secrets.
- The staging bot only responds to `/start` and `/health`. This verifies the webhook transport; it does not yet implement the BOSS BOT MASTER product features.
- Basic tests cover health, unknown paths, and disabled webhook configuration.

## Required staging secrets

Use a brand-new Telegram test bot, not any bot currently running on Render.

Set these as Cloudflare Worker secrets (never as plain vars and never in Git):

- `MASTER_BOT_TOKEN`
- `MASTER_WEBHOOK_SECRET`

The webhook secret should be a random 1–256 character string using only letters, digits, underscore, and hyphen. Do not set the Telegram webhook yet until a separate staging Worker has been deployed and its health endpoint has been checked.

## Local checks

- `npm test`
- `npm run cloudflare:dev`

Wrangler must be available through npx and dependencies must be installed.

## Important limitations — work still required

1. This is a transport smoke-test, not a port of the existing master bot commands or AI workflow.
2. The intake bot and customer bots are not yet migrated.
3. Persistent update idempotency / duplicate-update protection is not implemented yet.
4. The existing PostgreSQL pools and long-lived advisory lock in `db.js` are not Worker-compatible as-is. Neon access needs a reviewed Hyperdrive or other supported design.
5. The AI analyst, designer, builder, fixer, project pipeline, approvals, and customer intake state machine still need to be moved behind Worker-compatible handlers and storage.
6. Each existing bot needs a separate migration and acceptance test. Do not point existing production Telegram bots at this staging Worker.
7. Do not merge this branch into `audit-hardening` or deploy it as production until all above items are completed and verified.

## Production safety

Render remains the only production runtime for now. Do not stop it, change its environment variables, rotate its bot tokens, or call Telegram `setWebhook` for a production bot as part of this staging work.
