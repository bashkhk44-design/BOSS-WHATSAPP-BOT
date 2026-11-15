'use strict';

const { pool } = require('./db');

async function initProjectAiJobsDatabase() {
  await pool.query(`
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
    )
  `);
}

async function createProjectAiJob({ projectId, adminTelegramId }) {
  const result = await pool.query(`
    INSERT INTO project_ai_jobs
      (project_id, spec_version, job_type, status, requested_by_admin)
    SELECT
      p.id, s.version, 'analysis', 'queued', $2
    FROM client_projects p
    JOIN LATERAL (
      SELECT version
      FROM project_specs
      WHERE project_id = p.id AND status = 'approved'
      ORDER BY version DESC
      LIMIT 1
    ) s ON TRUE
    WHERE p.id = $1 AND p.status = 'spec_approved'
    ON CONFLICT (project_id, spec_version, job_type)
    DO UPDATE SET
      status = 'queued',
      error = NULL,
      analysis = NULL,
      started_at = NULL,
      completed_at = NULL,
      requested_by_admin = EXCLUDED.requested_by_admin,
      updated_at = NOW()
    WHERE project_ai_jobs.status = 'failed'
    RETURNING *
  `, [projectId, String(adminTelegramId)]);

  if (result.rows[0]) return result.rows[0];

  const existing = await pool.query(`
    SELECT j.*
    FROM project_ai_jobs j
    JOIN client_projects p
      ON p.id = j.project_id
     AND p.status = 'spec_approved'
    JOIN LATERAL (
      SELECT version
      FROM project_specs
      WHERE project_id = p.id
        AND status = 'approved'
      ORDER BY version DESC
      LIMIT 1
    ) s ON s.version = j.spec_version
    WHERE j.project_id = $1
      AND j.job_type = 'analysis'
    ORDER BY j.id DESC
    LIMIT 1
  `, [projectId]);

  if (existing.rows[0]) return existing.rows[0];

  throw new Error('المشروع غير معتمد أو لا توجد مواصفات معتمدة');
}

async function markProjectAiJobRunning(jobId) {
  const result = await pool.query(`
    UPDATE project_ai_jobs
    SET status = 'running',
        started_at = NOW(),
        completed_at = NULL,
        updated_at = NOW(),
        error = NULL
    WHERE id = $1 AND status = 'queued'
    RETURNING *
  `, [jobId]);

  return result.rows[0] || null;
}

async function completeProjectAiJob(jobId, analysis) {
  const result = await pool.query(`
    UPDATE project_ai_jobs
    SET status = 'completed',
        analysis = $2::jsonb,
        error = NULL,
        completed_at = NOW(),
        updated_at = NOW()
    WHERE id = $1 AND status = 'running'
    RETURNING *
  `, [jobId, JSON.stringify(analysis)]);

  return result.rows[0] || null;
}

async function failProjectAiJob(jobId, error) {
  const result = await pool.query(`
    UPDATE project_ai_jobs
    SET status = 'failed',
        error = $2,
        updated_at = NOW()
    WHERE id = $1
      AND status = 'running'
    RETURNING *
  `, [jobId, String(error).slice(0, 3000)]);

  return result.rows[0] || null;
}

async function recoverInterruptedProjectAiJobs() {
  const result = await pool.query(`
    UPDATE project_ai_jobs
    SET status = 'failed',
        error = 'توقف التحليل بسبب إعادة تشغيل الخدمة. يمكنك إعادة المحاولة.',
        updated_at = NOW()
    WHERE status = 'running'
    RETURNING id
  `);

  return result.rowCount || 0;
}

module.exports = {
  initProjectAiJobsDatabase,
  createProjectAiJob,
  markProjectAiJobRunning,
  completeProjectAiJob,
  failProjectAiJob,
  recoverInterruptedProjectAiJobs
};
