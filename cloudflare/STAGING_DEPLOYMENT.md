# Cloudflare staging deployment status

Status: deployment is intentionally disabled pending integration and external staging setup.

The legacy deployment workflow that targeted `cloudflare-webhook-prep` was removed from `main` in PR #93 because its source, Hyperdrive binding, and target database were not independently verified. The old Worker URL and Hyperdrive ID are historical references only and must not be reused.

The current replacement candidate is being reconciled in `integration/cloudflare-staging-reconcile`. It uses a new Cloudflare edge adapter and a credential-free Wrangler bundle check. It is not deployed and has no live Hyperdrive binding.

Before any staging deployment:
1. Merge the reconciled code only after all CI jobs pass on the integration branch.
2. Create a new empty Neon staging database/branch.
3. Create a new Hyperdrive configuration and verify its origin is only that staging database.
4. Configure staging-only secrets and a separate test Telegram bot.
5. Add a deployment workflow scoped only to the `cloudflare-staging` GitHub Environment and the explicitly named staging Worker.
6. Run staging end-to-end webhook, queue, retry, and worker handoff tests.

No production database, Render service, Telegram token, webhook, or encryption key may be used or changed during this process.
