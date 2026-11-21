'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

function loadProjectDb(queryHandler) {
  const dbPath = require.resolve('../db');
  const projectPath = require.resolve('../project-db');
  const previousDb = require.cache[dbPath];
  const previousProject = require.cache[projectPath];
  const queries = [];
  const pool = {
    async query(sql, params) {
      queries.push({ sql: String(sql), params });
      return queryHandler(String(sql), params, queries.length);
    }
  };
  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: { pool, encryptSecret() {}, decryptSecret() {} }
  };
  delete require.cache[projectPath];
  const projectDb = require('../project-db');
  return {
    projectDb,
    queries,
    restore() {
      delete require.cache[projectPath];
      delete require.cache[dbPath];
      if (previousDb) require.cache[dbPath] = previousDb;
      if (previousProject) require.cache[projectPath] = previousProject;
    }
  };
}

test('outbox enqueue is idempotent for the same dedupe key', async () => {
  const loaded = loadProjectDb(async (sql) => {
    if (sql.includes('INSERT INTO project_notification_outbox')) {
      return { rowCount: 0, rows: [] };
    }
    if (sql.includes('SELECT id, dedupe_key, state')) {
      return { rowCount: 1, rows: [{ id: '9', dedupe_key: 'approval:42', state: 'pending' }] };
    }
    assert.fail('unexpected SQL: ' + sql);
  });
  try {
    const result = await loaded.projectDb.enqueueProjectNotification({
      dedupeKey: 'approval:42',
      eventType: 'project_approved',
      payload: { projectId: 42 }
    });
    assert.deepEqual(result, { id: '9', dedupe_key: 'approval:42', state: 'pending' });
    assert.match(loaded.queries[0].sql, /ON CONFLICT \(dedupe_key\) DO NOTHING/);
  } finally {
    loaded.restore();
  }
});

test('outbox claim uses SKIP LOCKED and reclaims expired processing leases', async () => {
  const loaded = loadProjectDb(async (sql, params) => {
    assert.match(sql, /FOR UPDATE SKIP LOCKED/);
    assert.match(sql, /state = 'processing' AND locked_at < NOW\(\)/);
    assert.equal(params[0], 'worker-A');
    assert.equal(params[1], 5);
    assert.equal(params[2], 90);
    return { rowCount: 1, rows: [{ id: '11', state: 'processing', locked_by: 'worker-A' }] };
  });
  try {
    const rows = await loaded.projectDb.claimProjectNotifications({
      workerId: 'worker-A', limit: 5, leaseSeconds: 90
    });
    assert.equal(rows[0].locked_by, 'worker-A');
  } finally {
    loaded.restore();
  }
});

test('outbox lease renewal is fenced by notification id and worker owner', async () => {
  const loaded = loadProjectDb(async (sql, params) => {
    assert.match(sql, /SET locked_at = NOW\(\), updated_at = NOW\(\)/);
    assert.match(sql, /WHERE id = \$1 AND state = 'processing' AND locked_by = \$2/);
    assert.deepEqual(params, ['11', 'worker-A']);
    return { rowCount: 1, rows: [{ id: '11' }] };
  });
  try {
    const renewed = await loaded.projectDb.renewProjectNotificationLease({
      id: '11', workerId: 'worker-A'
    });
    assert.equal(renewed, true);
  } finally {
    loaded.restore();
  }
});

test('outbox completion is fenced by the worker lease owner', async () => {
  const loaded = loadProjectDb(async (sql, params) => {
    assert.match(sql, /state = 'processing' AND locked_by = \$2/);
    assert.deepEqual(params, ['11', 'worker-A']);
    return { rowCount: 0, rows: [] };
  });
  try {
    const completed = await loaded.projectDb.completeProjectNotification({
      id: '11', workerId: 'worker-A'
    });
    assert.equal(completed, false);
  } finally {
    loaded.restore();
  }
});

test('outbox retry moves exhausted notifications to dead state', async () => {
  const loaded = loadProjectDb(async (sql, params) => {
    assert.match(sql, /attempts >= \$5 THEN 'dead'/);
    assert.equal(params[0], '11');
    assert.equal(params[1], 'worker-A');
    assert.equal(params[4], 3);
    return { rowCount: 1, rows: [{ id: '11', state: 'dead', attempts: 3 }] };
  });
  try {
    const result = await loaded.projectDb.retryProjectNotification({
      id: '11', workerId: 'worker-A', error: 'network down', maxAttempts: 3
    });
    assert.equal(result.state, 'dead');
  } finally {
    loaded.restore();
  }
});

test('outbox rejects invalid identifiers before touching the database', async () => {
  const loaded = loadProjectDb(async () => assert.fail('database must not be called'));
  try {
    await assert.rejects(
      loaded.projectDb.enqueueProjectNotification({ dedupeKey: '', eventType: 'notice', payload: {} }),
      /مفتاح منع التكرار/
    );
    await assert.rejects(
      loaded.projectDb.claimProjectNotifications({ workerId: '' }),
      /معرّف عامل الإشعارات/
    );
  } finally {
    loaded.restore();
  }
});
