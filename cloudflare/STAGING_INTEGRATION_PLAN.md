# Cloudflare staging integration

Status: customer webhook source, durable Node dispatch worker, and automated tests are present on this branch. Deployment and runtime activation remain disabled. The repository does not contain a live Hyperdrive ID, Cloudflare secrets, Telegram webhook registration, or production cutover.

## Deployment design

1. GitHub Actions runs quality and PostgreSQL integration checks on the staging branch and pull requests.
2. `cloudflare/worker.mjs` supports platform master/intake routes and the customer route `POST /telegram/customer/:botId`.
3. The customer route requires `CUSTOMER_BOT_WEBHOOK_MODE=enabled`, a root `CUSTOMER_WEBHOOK_SECRET`, a matching active bot row with `transport_mode='webhook'`, and a verified Hyperdrive database.
4. Cloudflare deployment must use a dedicated Neon staging project/database (or a branch whose ancestry and data isolation are verified) and a restricted GitHub Environment named `cloudflare-staging`.
5. Cloudflare credentials, three independent webhook secrets, Telegram staging tokens, and the staging encryption key must be stored as secrets, never committed.
6. Production Render, production Neon, production Telegram bot tokens/webhooks, and `BOTS_ENCRYPTION_KEY` remain untouched until a separately approved cutover.

## Staging configuration (not populated in the repository)

GitHub Environment: `cloudflare-staging`

- `CLOUDFLARE_API_TOKEN` — staging Worker-scoped secret.
- `CLOUDFLARE_ACCOUNT_ID` — account identifier.
- `MASTER_WEBHOOK_SECRET` — independent platform master secret.
- `INTAKE_WEBHOOK_SECRET` — independent platform intake secret.
- `CUSTOMER_WEBHOOK_SECRET` — root secret used to derive per-customer-bot webhook secrets.
- Staging-only Telegram bot tokens and a staging encryption key for the Node workers.
- Hyperdrive binding connected only to the independently verified staging database.

Never copy production credentials into this environment. Keep both webhook modes disabled until the complete staging acceptance criteria pass.

## Runtime boundaries

- Cloudflare Worker authenticates requests and durably enqueues updates only.
- `customer-webhook-worker.js` is a dedicated Node queue worker for customer webhook updates. It requires `CUSTOMER_WEBHOOK_WORKER_ENABLED=YES` and a staging-only `DATABASE_URL`, decryption key, and bot records.
- Existing customer polling claims only rows with `transport_mode='polling'`; webhook dispatch handles only `transport_mode='webhook'`. Existing records default to polling.
- A queue integration test on disposable PostgreSQL is not a live connection to the user's Neon database.

## Acceptance criteria before enabling deployment

- Worker dependency-boundary tests and a Wrangler dry-run bundle pass.
- The Hyperdrive origin hostname, Neon project, branch ancestry, and database name are verified to be staging-only; the database is confirmed free of production data.
- The staging Node customer webhook worker connects to the same isolated staging database with staging-only credentials.
- Master, intake, and customer webhook authentication/enqueue/dispatch paths pass end-to-end tests with dedicated staging bot tokens.
- Retry, lease recovery, deduplication, cross-bot isolation, and duplicate side-effect behavior are reviewed.
- Deployment is restricted to the `cloudflare-staging` environment and requires approval.
- Production cutover remains a separate, explicitly approved operation.
