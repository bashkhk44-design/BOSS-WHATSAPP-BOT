# Cloudflare Worker webhook ingress (staging)

## Scope

`worker.mjs` is a lightweight edge ingress only. It handles:

- `POST /telegram/platform/master`
- `POST /telegram/platform/intake`
- `POST /telegram/webhook/:botId` for customer bots
- `GET /healthz` and `GET /db-healthz`

It validates Telegram's secret-token header, bounds and parses the request body, then durably enqueues the update using the existing platform queue functions. It does not execute bot handlers, start polling, run AI generation, build projects, or deploy customer projects. Those jobs remain on the Node workers.

## Database connection

The Worker uses Cloudflare Hyperdrive and a new `pg.Client` per request. It deliberately does not import `db.js`, create a process-wide `pg.Pool`, or import Node HTTP servers or Telegram bot runtimes. Cloudflare's current Hyperdrive guidance recommends node-postgres `pg@8.16.3+`, a per-request Client, and Node.js compatibility for database drivers. The repository currently pins a compatible `pg` version in its package manifest.

## Configuration

1. Create a new, empty Neon staging branch/database. Do not reuse the production database.
2. Create a new Hyperdrive configuration pointing only to that staging database.
3. Copy `wrangler.jsonc.example` to `wrangler.jsonc` and replace the placeholder Hyperdrive ID with the newly created staging-only ID.
4. Add the Worker secrets `BOTS_ENCRYPTION_KEY`, `MASTER_WEBHOOK_SECRET`, and `INTAKE_WEBHOOK_SECRET`. Use staging bot tokens and the matching staging key only in the Node platform worker, not in the edge ingress.
5. Apply the repository migrations to the staging database through the reviewed staging migration process.
6. Bundle-test and deploy only to the named staging Worker.
7. Set Telegram webhooks to the staging Worker routes only after the database health check and the separate Node queue worker are ready.

## Security

- The master and intake webhook secrets must be separate, random URL-safe values.
- Customer bot webhook authentication preserves the existing token-derived HMAC contract. The Worker decrypts the encrypted token using Web Crypto and derives the expected HMAC without logging token material.
- Updates are acknowledged only after the durable inbox and queue job are inserted.
- Duplicate update IDs remain idempotent per bot identity.
- No secret values are stored in queue payloads or committed to Git.
- Do not enable production routing from this staging Worker.

## Validation status

The Worker has focused Node/Web Crypto tests. A successful Node test run is not a substitute for a real Wrangler bundle test, Hyperdrive connection test, staging Telegram webhook test, or production approval. The deployment workflow remains disabled until a verified staging Hyperdrive ID and staging credentials exist.
