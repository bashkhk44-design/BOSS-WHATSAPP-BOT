# Cloudflare staging deployment is paused

## Why deployment is disabled

The previous GitHub Actions workflow checked out the old `cloudflare-webhook-prep` branch and deployed it directly. That branch diverged from the current Telegram platform architecture and has not passed the current runtime, database, or webhook acceptance gates. Deploying it could restore obsolete code and bypass the current security and queue design.

The old workflow has therefore been removed from the active workflow directory. No Cloudflare deployment, Telegram webhook change, production database migration, or production secret change was performed.

## What is already available

- The current Node runtime has separate customer-bot and platform-bot queue paths.
- Master and intake bot handlers expose webhook-mode adapters for Node.
- The new platform webhook ingress validates separate master/intake Telegram secret-token headers and durably enqueues updates.
- The full GitHub Actions suite passed on the merged application PR.

## What must happen before Cloudflare deployment

1. Port the current webhook routes to a Cloudflare Worker entrypoint; do not import Node HTTP server, `pg.Pool`, or Node host startup modules into the Worker bundle.
2. Implement and test a Hyperdrive database adapter that preserves the current PostgreSQL TLS and transaction rules.
3. Keep AI analysis, code generation, builds, tests, and deployment preflight in the existing isolated Node workers.
4. Create a dedicated empty Neon staging branch/database and a newly verified staging-only Hyperdrive binding.
5. Configure a restricted GitHub Environment named `cloudflare-staging` with staging-only Cloudflare credentials, bot tokens, webhook secrets, and encryption material.
6. Run bundle compatibility tests, database adapter tests, and end-to-end tests with separate staging master/intake/customer bots.
7. Only then restore a staging-only deployment workflow that deploys the current reviewed branch and exact staging Worker.

## Production boundary

Do not copy production Telegram tokens, production database URLs, production encryption keys, or production Cloudflare credentials into staging. Production cutover remains a separate, explicitly approved operation.
