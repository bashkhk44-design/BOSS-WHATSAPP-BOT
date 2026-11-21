-- Durable, retryable notification outbox for intake and project events.
BEGIN;

CREATE TABLE IF NOT EXISTS project_notification_outbox (
  id BIGSERIAL PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'processing', 'sent', 'dead')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_by TEXT,
  locked_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS project_intake_update_receipts (
  bot_identity TEXT NOT NULL CHECK (bot_identity IN ('master', 'intake')),
  update_id TEXT NOT NULL,
  telegram_user_id BIGINT NOT NULL,
  project_id BIGINT NOT NULL REFERENCES client_projects(id) ON DELETE CASCADE,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (bot_identity, update_id)
);

CREATE INDEX IF NOT EXISTS project_intake_update_receipts_project_idx
  ON project_intake_update_receipts (project_id, processed_at DESC);

CREATE INDEX IF NOT EXISTS project_notification_outbox_ready_idx
  ON project_notification_outbox (available_at, id)
  WHERE state IN ('pending', 'processing');

COMMIT;
