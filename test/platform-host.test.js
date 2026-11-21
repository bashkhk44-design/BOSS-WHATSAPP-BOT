'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createHealthServer } = require('../health-server');

test('platform host readiness endpoint stays unavailable until the worker is ready', async () => {
  let state = { runtimeReady: false, runtimeStopping: false };
  const server = createHealthServer(() => state);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const get = path => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: address.port, path }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(body) }));
    }).on('error', reject);
  });

  try {
    assert.equal((await get('/healthz')).status, 200);
    assert.equal((await get('/readyz')).status, 503);
    state = { runtimeReady: true, runtimeStopping: false };
    assert.deepEqual(await get('/readyz'), {
      status: 200,
      body: { status: 'ok', service: 'BOSS BOT MASTER' }
    });
    state = { runtimeReady: true, runtimeStopping: true };
    assert.equal((await get('/readyz')).status, 503);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
