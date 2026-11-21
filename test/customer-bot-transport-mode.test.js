'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { claimNextBot } = require('../customer-bot-worker');

test('polling runtime never claims bots assigned to webhook transport', async () => {
  const statements = [];
  const client = {
    async query(sql, params) {
      statements.push({ sql, params });
      if (sql === 'BEGIN' || sql === 'COMMIT') return { rowCount: 0, rows: [] };
      if (/SELECT b\.id/.test(sql)) return { rowCount: 0, rows: [] };
      return { rowCount: 1, rows: [] };
    },
    release() {}
  };
  const pool = { async connect() { return client; } };
  const claimed = await claimNextBot(pool, 'poller-test', 90);
  assert.equal(claimed, null);
  const selection = statements.find(x => /SELECT b\.id/.test(x.sql));
  assert.ok(selection);
  assert.match(selection.sql, /b\.transport_mode = 'polling'/);
});
