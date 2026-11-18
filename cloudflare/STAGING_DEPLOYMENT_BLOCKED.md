# Cloudflare staging deployment

## Approved deployment boundary

The approved workflow is stored on `main`, but checks out and deploys only the separate `cloudflare-webhook-prep` branch to the staging Worker:

`https://boss-bot-master-staging.bashkhk44.workers.dev`

The staging source is not merged into `main`. Do not deploy it to production and do not change Render, production Neon, or production Telegram webhooks.

## Staging source and checks

- Staging branch: `cloudflare-webhook-prep`
- Last verified staging source commit: `282d79af227ed5114a0a994734afdc2b2d048ac5`
- Cloudflare staging checks run #17 succeeded: https://github.com/bashkhk44-design/BOSS-WHATSAPP-BOT/actions/runs/43973423849
- The branch contains its own `wrangler.toml` with a Hyperdrive binding intended for the Neon staging database.
- The earlier deploy-only workflow run succeeded. The restored workflow now also checks `/healthz` and `/db-healthz`; those checks must complete successfully to confirm the live staging Worker and database connection.

## Workflow behavior

- Trigger: manual dispatch, or a change to this workflow file on `main`.
- GitHub Environment: `cloudflare-staging`.
- It checks out only `cloudflare-webhook-prep`.
- It deploys only the staging Worker.
- It verifies Worker health and the staging database endpoint after deployment.

## Production safety

No staging source code is merged into `main` by this workflow. Do not copy staging credentials into production or point the staging Hyperdrive binding at production. Production cutover requires a separate explicit review and approval.
