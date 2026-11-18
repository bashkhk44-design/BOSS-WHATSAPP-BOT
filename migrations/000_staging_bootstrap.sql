-- Staging-only baseline bootstrap.
-- Creates the pre-existing application tables required by migration 001 and
-- the runtime schema verifier. Additive and safe to re-run; inserts no data.
BEGIN;

CREATE TABLE IF NOT EXISTS telegram_bots (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  username TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  token_ciphertext TEXT,
  token_iv TEXT,
  token_auth_tag TEXT,
  token_fingerprint TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS telegram_bots_token_fingerprint_idx
  ON telegram_bots(token_fingerprint)
  WHERE token_fingerprint IS NOT NULL;

CREATE TABLE IF NOT EXISTS clients (
  id BIGSERIAL PRIMARY KEY,
  telegram_user_id BIGINT NOT NULL UNIQUE,
  telegram_username TEXT,
  first_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS client_projects (
  id BIGSERIAL PRIMARY KEY,
  client_id BIGINT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  business_type TEXT,
  status TEXT NOT NULL DEFAULT 'collecting_requirements',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS client_projects_client_idx
  ON client_projects(client_id, created_at DESC);

CREATE TABLE IF NOT EXISTS client_conversations (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES client_projects(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('client', 'assistant', 'admin', 'system')),
  content TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS client_conversations_project_idx
  ON client_conversations(project_id, created_at);

CREATE TABLE IF NOT EXISTS project_specs (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES client_projects(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  spec JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_at TIMESTAMPTZ,
  UNIQUE (project_id, version)
);

CREATE TABLE IF NOT EXISTS project_events (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES client_projects(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS project_events_project_idx
  ON project_events(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS client_intake_sessions (
  telegram_user_id BIGINT PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES client_projects(id) ON DELETE CASCADE,
  step TEXT NOT NULL,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS project_secrets (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES client_projects(id) ON DELETE CASCADE,
  env_name TEXT NOT NULL,
  secret_ciphertext TEXT NOT NULL,
  secret_iv TEXT NOT NULL,
  secret_auth_tag TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, env_name),
  CHECK (env_name ~ '^[A-Z][A-Z0-9_]*$')
);
CREATE INDEX IF NOT EXISTS project_secrets_project_idx
  ON project_secrets(project_id);

CREATE TABLE IF NOT EXISTS project_ai_jobs (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES client_projects(id) ON DELETE CASCADE,
  spec_version INTEGER NOT NULL,
  job_type TEXT NOT NULL DEFAULT 'analysis',
  status TEXT NOT NULL DEFAULT 'queued',
  requested_by_admin TEXT NOT NULL,
  analysis JSONB,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, spec_version, job_type)
);

CREATE TABLE IF NOT EXISTS project_ai_job_attempts (
  id BIGSERIAL PRIMARY KEY,
  job_id BIGINT NOT NULL REFERENCES project_ai_jobs(id) ON DELETE CASCADE,
  attempt_no INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  result JSONB,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  UNIQUE (job_id, attempt_no)
);
CREATE INDEX IF NOT EXISTS project_ai_job_attempts_job_idx
  ON project_ai_job_attempts(job_id, attempt_no DESC);

CREATE TABLE IF NOT EXISTS project_build_approvals (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES client_projects(id) ON DELETE CASCADE,
  spec_version INTEGER NOT NULL,
  design_job_id BIGINT NOT NULL REFERENCES project_ai_jobs(id) ON DELETE CASCADE,
  construction_points JSONB NOT NULL DEFAULT '{}'::jsonb,
  construction_points_approved BOOLEAN NOT NULL DEFAULT FALSE,
  design_approved BOOLEAN NOT NULL DEFAULT FALSE,
  points_approved_by TEXT,
  design_approved_by TEXT,
  points_approved_at TIMESTAMPTZ,
  design_approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, spec_version, design_job_id)
);
CREATE INDEX IF NOT EXISTS project_build_approvals_project_idx
  ON project_build_approvals(project_id, spec_version);

CREATE TABLE IF NOT EXISTS project_release_candidates (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES client_projects(id) ON DELETE CASCADE,
  release_version INTEGER NOT NULL,
  spec_version INTEGER NOT NULL,
  design_job_id BIGINT NOT NULL REFERENCES project_ai_jobs(id),
  created_by TEXT NOT NULL,
  artifact JSONB NOT NULL,
  artifact_sha256 TEXT NOT NULL CHECK (artifact_sha256 ~ '^[a-f0-9]{64}$'),
  artifact_bytes INTEGER NOT NULL CHECK (artifact_bytes > 0),
  status TEXT NOT NULL CHECK (status IN ('awaiting_customer', 'awaiting_manager', 'approved', 'rejected')),
  customer_telegram_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, release_version)
);
CREATE INDEX IF NOT EXISTS project_release_project_idx
  ON project_release_candidates(project_id, release_version DESC);
CREATE UNIQUE INDEX IF NOT EXISTS project_release_one_open_per_project_idx
  ON project_release_candidates(project_id)
  WHERE status IN ('awaiting_customer', 'awaiting_manager');

CREATE TABLE IF NOT EXISTS project_release_approvals (
  id BIGSERIAL PRIMARY KEY,
  release_id BIGINT NOT NULL REFERENCES project_release_candidates(id) ON DELETE CASCADE,
  approver_role TEXT NOT NULL CHECK (approver_role IN ('customer', 'manager')),
  telegram_user_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (release_id, approver_role)
);

CREATE TABLE IF NOT EXISTS project_deployment_authorizations (
  id BIGSERIAL PRIMARY KEY,
  release_id BIGINT NOT NULL UNIQUE REFERENCES project_release_candidates(id) ON DELETE CASCADE,
  authorized_by TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('authorized')),
  authorization_sha256 TEXT NOT NULL CHECK (authorization_sha256 ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO schema_migrations(version, description)
VALUES ('000_staging_bootstrap', 'Create empty baseline application tables for isolated staging')
ON CONFLICT (version) DO NOTHING;

COMMIT;
