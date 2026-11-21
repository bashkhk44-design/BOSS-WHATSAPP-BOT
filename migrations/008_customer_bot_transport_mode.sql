-- Explicitly separate polling and webhook transport per customer bot.
-- Existing bots remain on polling; no live bot is switched by this migration.
BEGIN;

ALTER TABLE telegram_bots
  ADD COLUMN IF NOT EXISTS transport_mode TEXT NOT NULL DEFAULT 'polling';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'telegram_bots_transport_mode_check'
      AND conrelid = 'telegram_bots'::regclass
  ) THEN
    ALTER TABLE telegram_bots
      ADD CONSTRAINT telegram_bots_transport_mode_check
      CHECK (transport_mode IN ('polling', 'webhook'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS telegram_bots_active_transport_idx
  ON telegram_bots(transport_mode, id)
  WHERE active = TRUE;

INSERT INTO schema_migrations(version, description)
VALUES ('008_customer_bot_transport_mode', 'Add explicit per-bot polling or webhook transport mode; preserve polling default')
ON CONFLICT (version) DO NOTHING;

COMMIT;
