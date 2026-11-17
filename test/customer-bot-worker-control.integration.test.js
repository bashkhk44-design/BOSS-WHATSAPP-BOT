'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { createCustomerBotWorker } = require('../customer-bot-worker');

const databaseUrl = process.env.DATABASE_URL;
const enabled = Boolean(databaseUrl && process.env.DATABASE_SSL === 'disable');

test('worker consumes a manager start command through the durable command table', { skip: !enabled }, async () => {
  const pool = new Pool({ connectionString: databaseUrl, ssl: false, max: 2 });
  const workerId = 'manager-control-integration';
  let started = 0;
  try {
    const bot = await pool.query(`
      INSERT INTO telegram_bots (name, username, active, token_ciphertext)
      VALUES ('control fixture', 'control_fixture_bot', TRUE, 'test-ciphertext')
      RETURNING id
    `);
    const botId = bot.rows[0].id;
    await pool.query(`
      INSERT INTO bot_runtime_commands (bot_id, action, status, requested_by)
      VALUES ($1, 'start', 'queued', 'integration-test')
    `, [botId]);

    const runtime = {
      getRuntimeSnapshot: () => [],
      async startBotById(id) { assert.equal(String(id), String(botId)); started += 1; },
      async stopBotById() {},
      async stopBotRuntime() {}
    };
    const worker = createCustomerBotWorker({
      pool, runtime, workerId, capacity: 2, leaseSeconds: 90,
      pollIntervalMs: 500, logger: { log() {}, error() {} }
    });

    assert.equal(await worker.runOnce(), true);
    assert.equal(started, 1);
    const result = await pool.query(
      'SELECT status FROM bot_runtime_commands WHERE bot_id = $1',
      [botId]
    );
    assert.equal(result.rows[0].status, 'completed');
    const status = await pool.query(
      'SELECT worker_id, status FROM bot_runtime_status WHERE bot_id = $1',
      [botId]
    );
    assert.equal(status.rows[0].worker_id, workerId);
    assert.equal(status.rows[0].status, 'starting');
  } finally {
    await pool.query("DELETE FROM telegram_bots WHERE name = 'control fixture'");
    await pool.end();
  }
});

test('worker reclaims a manager command abandoned by a crashed worker', { skip: !enabled }, async () => {
  const pool = new Pool({ connectionString: databaseUrl, ssl: false, max: 2 });
  const workerId = 'manager-command-recovery';
  let started = 0;
  try {
    const bot = await pool.query(`
      INSERT INTO telegram_bots (name, username, active, token_ciphertext)
      VALUES ('recovery fixture', 'recovery_fixture_bot', TRUE, 'test-ciphertext')
      RETURNING id
    `);
    const botId = bot.rows[0].id;
    await pool.query(`
      INSERT INTO bot_runtime_commands
        (bot_id, action, status, requested_by, claimed_by, claimed_at)
      VALUES ($1, 'start', 'processing', 'integration-test', 'dead-worker', NOW() - INTERVAL '3 minutes')
    `, [botId]);
    const runtime = {
      getRuntimeSnapshot: () => [],
      async startBotById(id) { assert.equal(String(id), String(botId)); started += 1; },
      async stopBotById() {},
      async stopBotRuntime() {}
    };
    const worker = createCustomerBotWorker({
      pool, runtime, workerId, capacity: 2, leaseSeconds: 30,
      pollIntervalMs: 500, logger: { log() {}, error() {} }
    });
    assert.equal(await worker.runOnce(), true);
    assert.equal(started, 1);
    const result = await pool.query(
      'SELECT status, claimed_by, attempts FROM bot_runtime_commands WHERE bot_id = $1',
      [botId]
    );
    assert.equal(result.rows[0].status, 'completed');
    assert.equal(result.rows[0].claimed_by, workerId);
    assert.equal(Number(result.rows[0].attempts), 1);
  } finally {
    await pool.query("DELETE FROM telegram_bots WHERE name = 'recovery fixture'");
    await pool.end();
  }
});
