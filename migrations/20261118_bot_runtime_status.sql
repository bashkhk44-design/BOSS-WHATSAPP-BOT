BEGIN;

CREATE TABLE IF NOT EXISTS bot_runtime_status (
  bot_id BIGINT PRIMARY KEY REFERENCES telegram_bots(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'unknown'
    CHECK (status IN ('unknown', 'starting', 'running', 'retrying', 'error', 'conflict', 'unauthorized', 'stopped')),
  worker_id TEXT,
  last_started_at TIMESTAMPTZ,
  last_heartbeat_at TIMESTAMPTZ,
  last_error_code TEXT,
  last_error_message TEXT,
  restart_count INTEGER NOT NULL DEFAULT 0 CHECK (restart_count >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS bot_runtime_status_worker_heartbeat_idx
  ON bot_runtime_status(worker_id, last_heartbeat_at DESC);

CREATE INDEX IF NOT EXISTS bot_runtime_status_status_heartbeat_idx
  ON bot_runtime_status(status, last_heartbeat_at DESC);

CREATE TABLE IF NOT EXISTS bot_worker_status (
  worker_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'stopped'
    CHECK (status IN ('running', 'stopped')),
  capacity INTEGER NOT NULL DEFAULT 1 CHECK (capacity > 0),
  last_heartbeat_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  stopped_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS bot_worker_status_heartbeat_idx
  ON bot_worker_status(status, last_heartbeat_at DESC);

COMMIT;
