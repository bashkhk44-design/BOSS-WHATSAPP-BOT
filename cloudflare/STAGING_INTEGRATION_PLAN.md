# Cloudflare staging integration

Status: an isolated staging deployment is approved and has a separate source branch. The staging source must remain separate from `main` and must never be treated as a production release.

## Approved staging source

- Branch: `cloudflare-webhook-prep`
- Verified commit: `282d79af227ed5114a0a994734afdc2b2d048ac5`
- Staging checks run #17: https://github.com/bashkhk44-design/BOSS-WHATSAPP-BOT/actions/runs/43973423849
- Staging Worker: `https://boss-bot-master-staging.bashkhk44.workers.dev`
- Hyperdrive binding ID in the staging branch: `cd5e3271174a425c914d3c25da64e816`
- GitHub Environment: `cloudflare-staging`

The workflow on `main` checks out only `cloudflare-webhook-prep`, deploys only the staging Worker, and checks `/healthz` and `/db-healthz`. It does not deploy the `main` application source.

## Separation from the main application

The current `main` branch has a newer durable queue architecture and separate Node workers for master/intake and customer bot updates. The Cloudflare staging branch is a separate integration candidate that was tested in isolation. Do not merge `cloudflare-webhook-prep` into `main` as part of this staging workflow.

Any future Cloudflare port of the current durable queue architecture must be reviewed and tested as a separate change. Do not silently replace the approved staging source with a different branch.

## Staging acceptance

1. Deploy the approved staging branch through the `cloudflare-staging` GitHub Environment.
2. Confirm `/healthz` and `/db-healthz` both return success.
3. Test master, intake, and customer webhook routes with staging-only bot credentials.
4. Verify duplicate update handling, retry behavior, and clean Worker lifecycle.
5. Confirm the Hyperdrive connection points only to the Neon staging database.

## Production boundary

No production Render service, production Neon database, production Telegram token or webhook, or production encryption key may be changed by this workflow. Production cutover requires a separate explicit approval.
