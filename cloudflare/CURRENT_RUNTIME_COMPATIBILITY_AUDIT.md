# Cloudflare runtime compatibility audit

Status: the current `main` application runtime and the isolated Cloudflare staging candidate are separate code lines. The Cloudflare staging branch has its own successful staging checks and is approved only for the isolated staging Worker. It is not a production release and must not be merged wholesale into `main`.

## Current main application

- The current Node application uses explicit master/intake webhook-mode adapters and durable PostgreSQL queues.
- The Node platform worker handles `telegram.master.update` and `telegram.intake.update` jobs.
- Customer bot updates remain on the separate customer worker path.
- The current main application must not import Node HTTP servers, process-wide database pools, or polling runtimes into a Cloudflare Worker without a dedicated adapter and tests.

## Approved isolated staging candidate

- Source branch: `cloudflare-webhook-prep`
- Verified commit: `282d79af227ed5114a0a994734afdc2b2d048ac5`
- Staging checks run #17 succeeded: https://github.com/bashkhk44-design/BOSS-WHATSAPP-BOT/actions/runs/43973423849
- Hyperdrive binding: `cd5e3271174a425c914d3c25da64e816`
- Staging Worker: `https://boss-bot-master-staging.bashkhk44.workers.dev`

This branch is deployed only to the staging Worker by a workflow stored on `main`. The workflow must continue to check out that exact staging branch. Do not change it to deploy `main` or another branch without explicit review.

## Important compatibility boundary

The staging candidate uses the earlier webhook runtime design and has its own tests. It does not automatically prove that the newer durable queue architecture on `main` is Cloudflare-compatible. A future port of the current queue architecture must separately verify Hyperdrive connection behavior, request-scoped database clients, Telegram authentication, duplicate delivery, retry behavior, and the Node worker handoff.

## Production boundary

- No staging code is merged into production by the deployment workflow.
- No production Render, Neon, Telegram token, webhook, or encryption key is changed.
- Staging credentials and Hyperdrive configuration must remain staging-only.
- Production cutover requires a separate explicit approval.
