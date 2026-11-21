const { Pool } = require('pg');
const crypto = require('crypto');
const { getPostgresSslConfig } = require('./postgres-ssl');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL غير مضبوط في متغيرات البيئة');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: getPostgresSslConfig(),
  max: 3,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

const lockPool = new Pool({
  connectionString: process.env.DATABASE_DIRECT_URL || process.env.DATABASE_URL,
  ssl: getPostgresSslConfig(),
  max: 1,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

pool.on('error', (err) => {
  console.error('POSTGRES IDLE CLIENT ERROR:', err.message);
});

lockPool.on('error', (err) => {
  console.error('POSTGRES LOCK POOL ERROR:', err.message);
});

function getEncryptionKey() {
  const value = process.env.BOTS_ENCRYPTION_KEY || '';

  if (!/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error('BOTS_ENCRYPTION_KEY غير مضبوط بشكل صحيح في Render');
  }

  return Buffer.from(value, 'hex');
}

function encryptToken(token) {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);

  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(token, 'utf8', 'base64');
  encrypted += cipher.final('base64');

  return {
    ciphertext: encrypted,
    iv: iv.toString('hex'),
    authTag: cipher.getAuthTag().toString('hex'),
    fingerprint: crypto
      .createHmac('sha256', key)
      .update(token)
      .digest('hex')
  };
}

function decryptToken(record) {
  const key = getEncryptionKey();

  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(record.token_iv, 'hex')
  );

  decipher.setAuthTag(Buffer.from(record.token_auth_tag, 'hex'));

  let decrypted = decipher.update(
    record.token_ciphertext,
    'base64',
    'utf8'
  );

  decrypted += decipher.final('utf8');
  return decrypted;
}


function encryptSecret(value) {
  if (typeof value !== 'string' || !value.length) {
    throw new Error('قيمة السر يجب أن تكون نصاً غير فارغ.');
  }

  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  const ciphertext = Buffer.concat([
    cipher.update(value, 'utf8'),
    cipher.final()
  ]).toString('base64');

  return {
    ciphertext,
    iv: iv.toString('hex'),
    authTag: cipher.getAuthTag().toString('hex')
  };
}

function decryptSecret(record) {
  if (
    !record ||
    !record.secret_ciphertext ||
    !record.secret_iv ||
    !record.secret_auth_tag
  ) {
    throw new Error('بيانات السر المشفر غير مكتملة.');
  }

  const key = getEncryptionKey();
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(record.secret_iv, 'hex')
  );

  decipher.setAuthTag(Buffer.from(record.secret_auth_tag, 'hex'));

  const decrypted = Buffer.concat([
    decipher.update(record.secret_ciphertext, 'base64'),
    decipher.final()
  ]);

  return decrypted.toString('utf8');
}

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS telegram_bots (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      username TEXT,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    ALTER TABLE telegram_bots
    ADD COLUMN IF NOT EXISTS token_ciphertext TEXT,
    ADD COLUMN IF NOT EXISTS token_iv TEXT,
    ADD COLUMN IF NOT EXISTS token_auth_tag TEXT,
    ADD COLUMN IF NOT EXISTS token_fingerprint TEXT
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS
    telegram_bots_token_fingerprint_idx
    ON telegram_bots(token_fingerprint)
    WHERE token_fingerprint IS NOT NULL
  `);

  console.log('Neon PostgreSQL connected; telegram_bots table ready');

  const { initProjectDatabase } = require('./project-db');
  await initProjectDatabase();
}

async function verifyDatabaseSchema() {
  const { APPROVED_MIGRATION_FILES } = require('./migrations/runner');
  const requiredTables = [
    'schema_migrations',
    'telegram_bots',
    'clients',
    'client_projects',
    'client_conversations',
    'project_specs',
    'project_events',
    'client_intake_sessions',
    'project_secrets',
    'project_ai_jobs',
    'project_ai_job_attempts',
    'project_build_approvals',
    'project_release_candidates',
    'project_release_approvals',
    'project_deployment_authorizations',
    'bot_runtime_status',
    'bot_inbound_updates',
    'platform_jobs',
    'ai_usage',
    'platform_audit_logs',
    'bot_runtime_commands',
    'bot_worker_status',
    'bot_auto_remediation_attempts',
    'platform_bot_inbound_updates',
    'project_notification_outbox',
    'project_intake_update_receipts'
  ];

  const tablesResult = await pool.query(
    `SELECT table_name,
            to_regclass('public.' || table_name) IS NOT NULL AS exists
     FROM unnest($1::text[]) AS required(table_name)`,
    [requiredTables]
  );
  const missingTables = tablesResult.rows
    .filter((row) => !row.exists)
    .map((row) => row.table_name);

  const requiredColumns = [
    ['telegram_bots', 'client_id'],
    ['telegram_bots', 'project_id'],
    ['telegram_bots', 'update_transport'],
    ['bot_runtime_commands', 'claimed_by'],
    ['bot_runtime_commands', 'claimed_at'],
    ['bot_runtime_commands', 'auto_remediation_attempt_id'],
    ['bot_inbound_updates', 'locked_by'],
    ['project_notification_outbox', 'dedupe_key'],
    ['project_notification_outbox', 'state'],
    ['project_intake_update_receipts', 'bot_identity'],
    ['project_intake_update_receipts', 'update_id'],
    ['project_intake_update_receipts', 'project_id']
  ];
  const columnsResult = await pool.query(
    `SELECT required.table_name, required.column_name
     FROM unnest($1::text[], $2::text[]) AS required(table_name, column_name)
     LEFT JOIN information_schema.columns actual
       ON actual.table_schema = 'public'
      AND actual.table_name = required.table_name
      AND actual.column_name = required.column_name
     WHERE actual.column_name IS NULL`,
    [
      requiredColumns.map(([table]) => table),
      requiredColumns.map(([, column]) => column)
    ]
  );
  const missingColumns = columnsResult.rows.map(
    (row) => row.table_name + '.' + row.column_name
  );

  const requiredIndexes = [
    'client_projects_id_client_id_uq',
    'telegram_bots_client_idx',
    'telegram_bots_project_idx',
    'bot_runtime_status_health_idx',
    'bot_inbound_updates_claim_idx',
    'platform_jobs_claim_idx',
    'platform_jobs_client_idx',
    'ai_usage_client_created_idx',
    'ai_usage_bot_created_idx',
    'platform_audit_client_created_idx',
    'platform_audit_bot_created_idx',
    'bot_runtime_status_lease_idx',
    'telegram_bots_active_runtime_idx',
    'bot_runtime_commands_claim_idx',
    'bot_runtime_commands_recovery_idx',
    'bot_worker_status_heartbeat_idx',
    'bot_auto_remediation_one_pending_idx',
    'bot_auto_remediation_history_idx',
    'platform_bot_inbound_claim_idx',
    'platform_bot_inbound_identity_received_idx',
    'bot_runtime_status_worker_heartbeat_idx',
    'bot_runtime_status_status_heartbeat_idx',
    'bot_inbound_updates_pending_order_idx',
    'telegram_bots_active_transport_idx',
    'project_intake_update_receipts_project_idx',
    'project_notification_outbox_ready_idx'
  ];
  const expectedIndexes = {
    client_projects_id_client_id_uq: { table: 'client_projects', columns: ['id', 'client_id'], unique: true, predicate: null },
    telegram_bots_client_idx: { table: 'telegram_bots', columns: ['client_id'], unique: false, predicate: 'client_idisnotnull' },
    telegram_bots_project_idx: { table: 'telegram_bots', columns: ['project_id'], unique: false, predicate: 'project_idisnotnull' },
    bot_runtime_status_health_idx: { table: 'bot_runtime_status', columns: ['status', 'last_heartbeat_at'], unique: false, predicate: null },
    bot_inbound_updates_claim_idx: { table: 'bot_inbound_updates', columns: ['state', 'available_at', 'id'], unique: false, predicate: null },
    platform_jobs_claim_idx: { table: 'platform_jobs', columns: ['status', 'priority DESC', 'available_at', 'id'], unique: false, predicate: null },
    platform_jobs_client_idx: { table: 'platform_jobs', columns: ['client_id', 'created_at DESC'], unique: false, predicate: null },
    ai_usage_client_created_idx: { table: 'ai_usage', columns: ['client_id', 'created_at DESC'], unique: false, predicate: null },
    ai_usage_bot_created_idx: { table: 'ai_usage', columns: ['bot_id', 'created_at DESC'], unique: false, predicate: null },
    platform_audit_client_created_idx: { table: 'platform_audit_logs', columns: ['client_id', 'created_at DESC'], unique: false, predicate: null },
    platform_audit_bot_created_idx: { table: 'platform_audit_logs', columns: ['bot_id', 'created_at DESC'], unique: false, predicate: null },
    bot_runtime_status_lease_idx: { table: 'bot_runtime_status', columns: ['status', 'last_heartbeat_at', 'bot_id'], unique: false, predicate: null },
    telegram_bots_active_runtime_idx: { table: 'telegram_bots', columns: ['id'], unique: false, predicate: 'active=true' },
    bot_runtime_commands_claim_idx: { table: 'bot_runtime_commands', columns: ['status', 'target_worker_id', 'id'], unique: false, predicate: null },
    bot_runtime_commands_recovery_idx: { table: 'bot_runtime_commands', columns: ['status', 'claimed_at', 'id'], unique: false, predicate: null },
    bot_worker_status_heartbeat_idx: { table: 'bot_worker_status', columns: ['status', 'last_heartbeat_at'], unique: false, predicate: null },
    bot_auto_remediation_one_pending_idx: { table: 'bot_auto_remediation_attempts', columns: ['bot_id'], unique: true, predicate: "status=anyarray['queued','processing']" },
    bot_auto_remediation_history_idx: { table: 'bot_auto_remediation_attempts', columns: ['bot_id', 'requested_at DESC'], unique: false, predicate: null },
    platform_bot_inbound_claim_idx: { table: 'platform_bot_inbound_updates', columns: ['state', 'available_at', 'id'], unique: false, predicate: null },
    platform_bot_inbound_identity_received_idx: { table: 'platform_bot_inbound_updates', columns: ['bot_identity', 'received_at DESC'], unique: false, predicate: null },
    bot_runtime_status_worker_heartbeat_idx: { table: 'bot_runtime_status', columns: ['worker_id', 'last_heartbeat_at DESC'], unique: false, predicate: null },
    bot_runtime_status_status_heartbeat_idx: { table: 'bot_runtime_status', columns: ['status', 'last_heartbeat_at DESC'], unique: false, predicate: null },
    bot_inbound_updates_pending_order_idx: { table: 'bot_inbound_updates', columns: ['bot_id', 'update_id'], unique: false, predicate: "state<>'processed'" },
    telegram_bots_active_transport_idx: { table: 'telegram_bots', columns: ['update_transport', 'id'], unique: false, predicate: 'active=true' },
    project_intake_update_receipts_project_idx: { table: 'project_intake_update_receipts', columns: ['project_id', 'processed_at DESC'], unique: false, predicate: null },
    project_notification_outbox_ready_idx: { table: 'project_notification_outbox', columns: ['available_at', 'id'], unique: false, predicate: "state=anyarray['pending','processing']" }
  };
  const normalizeCatalogSql = (value) => String(value || '')
    .toLowerCase()
    .replace(/"([a-z_][a-z0-9_]*)"/g, '$1')
    .replace(/::[a-z_][a-z0-9_]*(?:\[\])?/g, '')
    .replace(/\bpublic\./g, '')
    .replace(/\s+/g, '')
    // PostgreSQL may render DESC's default NULLS FIRST explicitly in per-key definitions.
    // Treat that spelling as equivalent to the implicit default; NULLS LAST remains distinct.
    .replace(/descnullsfirst/g, 'desc')
    .replace(/[()]/g, '');
  const indexRowsResult = await pool.query(
    `SELECT index_row.relname AS indexname,
            table_row.relname AS tablename,
            access_method.amname AS access_method,
            index_meta.indisvalid AS is_valid,
            index_meta.indisready AS is_ready,
            index_meta.indisunique AS is_unique,
            ARRAY(
              SELECT pg_get_indexdef(index_meta.indexrelid, position, true)
              FROM generate_series(1, index_meta.indnkeyatts) AS position
              ORDER BY position
            ) AS key_columns,
            pg_get_expr(index_meta.indpred, index_meta.indrelid, true) AS predicate
     FROM pg_class table_row
     JOIN pg_namespace table_namespace ON table_namespace.oid = table_row.relnamespace
     JOIN pg_index index_meta ON index_meta.indrelid = table_row.oid
     JOIN pg_class index_row ON index_row.oid = index_meta.indexrelid
     JOIN pg_am access_method ON access_method.oid = index_row.relam
     WHERE table_namespace.nspname = 'public'
       AND index_row.relname = ANY($1::text[])`,
    [requiredIndexes]
  );
  const indexRows = new Map(indexRowsResult.rows.map((row) => [row.indexname, row]));
  const missingIndexes = requiredIndexes.filter((name) => {
    const row = indexRows.get(name);
    return !row || !row.is_valid || !row.is_ready;
  });
  const invalidIndexes = requiredIndexes.filter((name) => {
    const row = indexRows.get(name);
    const expected = expectedIndexes[name];
    if (!row || !expected) return false;
    const actualColumns = Array.isArray(row.key_columns) ? row.key_columns : [];
    const columnsMatch = actualColumns.length === expected.columns.length &&
      actualColumns.every((column, index) =>
        normalizeCatalogSql(column) === normalizeCatalogSql(expected.columns[index])
      );
    const predicateMatch = expected.predicate === null
      ? row.predicate === null
      : normalizeCatalogSql(row.predicate) === normalizeCatalogSql(expected.predicate);
    return row.tablename !== expected.table ||
      row.access_method !== 'btree' ||
      row.is_unique !== expected.unique ||
      !columnsMatch ||
      !predicateMatch;
  });

  const requiredConstraints = [
    'telegram_bots_client_id_fk',
    'telegram_bots_project_client_fk',
    'platform_jobs_project_client_fk',
    'telegram_bots_project_requires_client',
    'platform_jobs_project_requires_client',
    'ai_usage_project_requires_client',
    'platform_audit_project_requires_client',
    'telegram_bots_update_transport_check'
  ];
  const expectedConstraints = {
    telegram_bots_client_id_fk: { table: 'telegram_bots', type: 'f', definition: 'FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE RESTRICT' },
    telegram_bots_project_client_fk: { table: 'telegram_bots', type: 'f', definition: 'FOREIGN KEY (project_id, client_id) REFERENCES client_projects(id, client_id) ON DELETE RESTRICT' },
    platform_jobs_project_client_fk: { table: 'platform_jobs', type: 'f', definition: 'FOREIGN KEY (project_id, client_id) REFERENCES client_projects(id, client_id) ON DELETE RESTRICT' },
    telegram_bots_project_requires_client: { table: 'telegram_bots', type: 'c', definition: 'CHECK (project_id IS NULL OR client_id IS NOT NULL)' },
    platform_jobs_project_requires_client: { table: 'platform_jobs', type: 'c', definition: 'CHECK (project_id IS NULL OR client_id IS NOT NULL)' },
    ai_usage_project_requires_client: { table: 'ai_usage', type: 'c', definition: 'CHECK (project_id IS NULL OR client_id IS NOT NULL)' },
    platform_audit_project_requires_client: { table: 'platform_audit_logs', type: 'c', definition: 'CHECK (project_id IS NULL OR client_id IS NOT NULL)' },
    telegram_bots_update_transport_check: { table: 'telegram_bots', type: 'c', definition: "CHECK (update_transport = ANY (ARRAY['polling'::text, 'webhook'::text]))" }
  };
  const constraintsResult = await pool.query(
    `SELECT constraint_row.conname,
            table_row.relname AS tablename,
            constraint_row.contype AS constraint_type,
            constraint_row.convalidated AS is_validated,
            pg_get_constraintdef(constraint_row.oid, true) AS definition
     FROM pg_constraint constraint_row
     JOIN pg_namespace namespace_row
       ON namespace_row.oid = constraint_row.connamespace
     JOIN pg_class table_row ON table_row.oid = constraint_row.conrelid
     WHERE namespace_row.nspname = 'public'
       AND constraint_row.conname = ANY($1::text[])`,
    [requiredConstraints]
  );
  const constraintRows = new Map(constraintsResult.rows.map((row) => [row.conname, row]));
  const missingConstraints = requiredConstraints.filter((name) => !constraintRows.has(name));
  const invalidConstraints = requiredConstraints.filter((name) => {
    const row = constraintRows.get(name);
    const expected = expectedConstraints[name];
    return row && expected && (
      !row.is_validated ||
      row.tablename !== expected.table ||
      row.constraint_type !== expected.type ||
      normalizeCatalogSql(row.definition) !== normalizeCatalogSql(expected.definition)
    );
  });

  const requiredVersions = APPROVED_MIGRATION_FILES.map(
    (filename) => filename.replace(/\.sql$/i, '')
  );
  const ledgerResult = await pool.query(
    'SELECT version FROM schema_migrations WHERE version = ANY($1::text[])',
    [requiredVersions]
  );
  const foundVersions = new Set(ledgerResult.rows.map((row) => row.version));
  const missingVersions = requiredVersions.filter(
    (version) => !foundVersions.has(version)
  );

  const failures = [];
  if (missingTables.length) failures.push('الجداول: ' + missingTables.join(', '));
  if (missingColumns.length) failures.push('الأعمدة: ' + missingColumns.join(', '));
  if (missingIndexes.length) failures.push('الفهارس: ' + missingIndexes.join(', '));
  if (missingConstraints.length) failures.push('القيود الناقصة: ' + missingConstraints.join(', '));
  if (invalidIndexes.length) {
    const details = invalidIndexes.map((name) => {
      const row = indexRows.get(name);
      const expected = expectedIndexes[name];
      return name + ' actual=' + JSON.stringify({
        table: row?.tablename,
        method: row?.access_method,
        unique: row?.is_unique,
        columns: row?.key_columns,
        predicate: row?.predicate
      }) + ' expected=' + JSON.stringify(expected);
    });
    failures.push('تعريف الفهارس أو التفرد غير الصحيح: ' + details.join(' | '));
  }
  if (invalidConstraints.length) failures.push('القيود غير المعتمدة أو غير الموثقة: ' + invalidConstraints.join(', '));
  if (missingVersions.length) failures.push('سجل الترحيلات: ' + missingVersions.join(', '));

  if (failures.length) {
    throw new Error(
      'قاعدة البيانات غير مكتملة بعد التهيئة. العناصر الناقصة: ' +
      failures.join(' | ')
    );
  }

  return true;
}

async function insertTelegramBot({ name, username, token }) {
  const encrypted = encryptToken(token);

  const result = await pool.query(
    `INSERT INTO telegram_bots
      (name, username, active, token_ciphertext,
       token_iv, token_auth_tag, token_fingerprint)
     VALUES ($1, $2, TRUE, $3, $4, $5, $6)
     RETURNING id, name, username, active, created_at`,
    [
      name,
      username,
      encrypted.ciphertext,
      encrypted.iv,
      encrypted.authTag,
      encrypted.fingerprint
    ]
  );

  return result.rows[0];
}


async function getActiveTelegramBots() {
  const result = await pool.query(`
    SELECT id, name, username, token_ciphertext,
           token_iv, token_auth_tag
    FROM telegram_bots
    WHERE active = TRUE
      AND token_ciphertext IS NOT NULL
    ORDER BY id ASC
  `);

  return result.rows.map(record => ({
    ...record,
    token: decryptToken(record)
  }));
}


let runtimeLockClient = null;
let runtimeLockFailureHandler = null;
let runtimeLockFailureClient = null;
let runtimeLockFailureError = null;
let lockPoolEndPromise = null;

function setRuntimeLockFailureHandler(handler) {
  if (handler !== null && typeof handler !== 'function') {
    throw new TypeError('Runtime lock failure handler must be a function or null');
  }
  runtimeLockFailureHandler = handler;
}

function notifyRuntimeLockFailure(client, err) {
  if (runtimeLockClient !== client || runtimeLockFailureClient === client) return;

  runtimeLockFailureClient = client;
  runtimeLockClient = null;
  const error = err instanceof Error
    ? err
    : new Error(String(err || 'Telegram runtime lock connection lost'));
  runtimeLockFailureError = error;

  console.error('TELEGRAM RUNTIME LOCK FAILURE:', error.message);

  try {
    client.release(error);
  } catch (_) {}

  if (runtimeLockFailureHandler) {
    Promise.resolve()
      .then(() => runtimeLockFailureHandler(error))
      .catch(handlerError => {
        console.error('RUNTIME LOCK FAILURE HANDLER ERROR:', handlerError.message);
      });
  }
}

function closeLockPool() {
  if (!lockPoolEndPromise) {
    lockPoolEndPromise = lockPool.end();
  }
  return lockPoolEndPromise;
}

async function acquireTelegramRuntimeLock() {
  if (runtimeLockClient) {
    const stillHeld = await isTelegramRuntimeLockHeld();
    if (stillHeld) return true;

    const staleClient = runtimeLockClient;
    if (staleClient) {
      runtimeLockClient = null;
      try {
        staleClient.release();
      } catch (_) {}
    }
  }

  const client = await lockPool.connect();

  try {
    const result = await client.query(
      'SELECT pg_try_advisory_lock($1, $2) AS locked',
      [20261115, 1]
    );

    if (!result.rows[0].locked) {
      client.release();
      return false;
    }

    runtimeLockClient = client;
    runtimeLockFailureClient = null;
    runtimeLockFailureError = null;

    client.on('error', (err) => {
      notifyRuntimeLockFailure(client, err);
    });

    client.on('end', () => {
      notifyRuntimeLockFailure(
        client,
        new Error('Telegram runtime lock connection ended')
      );
    });

    console.log('Telegram runtime lock acquired using direct connection');
    return true;
  } catch (err) {
    client.release(err);
    throw err;
  }
}

async function isTelegramRuntimeLockHeld() {
  const client = runtimeLockClient;

  if (!client || runtimeLockFailureClient === client) {
    return false;
  }

  try {
    const result = await client.query(
      `SELECT EXISTS (
        SELECT 1
        FROM pg_locks
        WHERE locktype = 'advisory'
          AND pid = pg_backend_pid()
          AND classid = 20261115::oid
          AND objid = 1::oid
          AND objsubid = 2
      ) AS locked`
    );

    return runtimeLockClient === client
      && runtimeLockFailureClient !== client
      && result.rows[0]?.locked === true;
  } catch (err) {
    notifyRuntimeLockFailure(client, err);
    return false;
  }
}

async function releaseTelegramRuntimeLock() {
  const client = runtimeLockClient;
  runtimeLockClient = null;

  let releaseError = runtimeLockFailureError;

  try {
    if (client && !releaseError) {
      await client.query(
        'SELECT pg_advisory_unlock($1, $2)',
        [20261115, 1]
      );
      console.log('Telegram runtime lock released');
    }
  } catch (err) {
    releaseError = err;
    console.error('RUNTIME LOCK UNLOCK ERROR:', err.message);
  } finally {
    if (client) {
      try {
        client.release(releaseError || undefined);
      } catch (err) {
        console.error('RUNTIME LOCK CLIENT RELEASE ERROR:', err.message);
      }
    }

    await closeLockPool();
  }
}

const { createBotOwnershipService } = require('./bot-ownership');
const botOwnership = createBotOwnershipService(pool);

module.exports = {
  pool,
  initDatabase,
  verifyDatabaseSchema,
  insertTelegramBot,
  getBotAssignmentClients: botOwnership.listClients,
  getBotAssignmentProjects: botOwnership.listProjects,
  assignTelegramBotToProject: botOwnership.assignBotToProject,
  getActiveTelegramBots,
  decryptToken,
  encryptSecret,
  decryptSecret,
  acquireTelegramRuntimeLock,
  isTelegramRuntimeLockHeld,
  releaseTelegramRuntimeLock,
  closeTelegramRuntimeLockPool: closeLockPool,
  setRuntimeLockFailureHandler
};
