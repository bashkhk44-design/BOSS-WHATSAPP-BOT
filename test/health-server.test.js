'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createHealthServer } = require('../health-server');

async function request(server, path) {
  const address = server.address();
  return new Promise((resolve, reject) => {
    const req = http.get({
      hostname: '127.0.0.1',
      port: address.port,
      path
    }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    });
    req.on('error', reject);
  });
}

test('readiness endpoints fail until Telegram runtime is ready, while liveness stays healthy', async () => {
  let runtimeReady = false;
  let runtimeStopping = false;
  const server = createHealthServer(() => ({ runtimeReady, runtimeStopping }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

  try {
    assert.equal((await request(server, '/healthz')).status, 503);
    assert.equal((await request(server, '/readyz')).status, 503);
    assert.equal((await request(server, '/livez')).status, 200);

    runtimeReady = true;
    assert.equal((await request(server, '/healthz')).status, 200);
    assert.equal((await request(server, '/health')).status, 200);

    runtimeStopping = true;
    assert.equal((await request(server, '/healthz')).status, 503);
    assert.equal((await request(server, '/livez')).status, 200);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
