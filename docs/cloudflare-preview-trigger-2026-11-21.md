# Cloudflare staging preview trigger

This documentation-only commit requests a fresh automatic preview build for PR #127 after the Cloudflare preview command was saved.

Expected preview command:

`npx wrangler preview --config cloudflare/wrangler.staging.jsonc`

Safety boundaries:
- Preview build only; do not use the Production deploy command.
- `PLATFORM_BOT_WEBHOOK_MODE` remains disabled.
- Do not activate Telegram webhooks or polling.
- Do not run database migrations or connect to a live database.
- Do not merge this pull request as part of this check.
