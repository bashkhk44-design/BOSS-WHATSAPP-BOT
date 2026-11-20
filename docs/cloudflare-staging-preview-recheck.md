# Cloudflare staging preview recheck

This documentation-only change is intended to trigger a fresh pull-request preview check after the Cloudflare dashboard deploy command was saved.

Expected staging preview command:

`npx wrangler preview --config cloudflare/wrangler.staging.jsonc`

Safety boundaries:
- Staging preview only.
- Do not deploy to production.
- Do not activate Telegram webhooks or polling.
- Do not run database migrations against a live database.
