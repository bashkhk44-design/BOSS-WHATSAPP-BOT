# Approved Cloudflare staging deployment

The `cloudflare-webhook-prep` branch is approved only for the isolated staging Worker. Its latest recorded CI run #17 succeeded. The workflow in `main` deploys that branch to `boss-bot-master-staging.bashkhk44.workers.dev` and verifies `/healthz` plus `/db-healthz`.

This workflow does not merge staging source into `main` and must not change production Render, Neon, Telegram bots, webhooks, or encryption keys.

See `STAGING_INTEGRATION_PLAN.md` for the branch, commit, Hyperdrive binding, and acceptance boundary.
