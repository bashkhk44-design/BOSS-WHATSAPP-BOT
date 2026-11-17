'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createHealthServer } = require('../health-server');

function getJson(port, pathname) {
  return new Promise((resolve, reject) => {
    const request = http.get({
      host: '127.0.0.1',
      port,
      path: pathname
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        try {
          resolve({ status: response.statusCode, body: JSON.parse(body) });
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on('error', reject);
  });
}

test('Render liveness remains healthy while Telegram runtime is recovering', async (t) => {
  let runtimeState = { runtimeReady: false, runtimeStopping: false };
  const server = createHealthServer(() => runtimeState);

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;

  const live = await getJson(port, '/healthz');
  assert.equal(live.status, 200);
  assert.equal(live.body.status, 'ok');
  assert.equal(live.body.runtimeReady, false);

  const ready = await getJson(port, '/readyz');
  assert.equal(ready.status, 503);
  assert.equal(ready.body.status, 'not_ready');

  runtimeState = { runtimeReady: true, runtimeStopping: false };
  const recovered = await getJson(port, '/readyz');
  assert.equal(recovered.status, 200);
  assert.equal(recovered.body.status, 'ok');
});

test('readiness becomes unavailable during graceful shutdown without exposing secrets', async (t) => {
  const server = createHealthServer(() => ({
    runtimeReady: true,
    runtimeStopping: true,
    token: 'must-not-be-exposed'
  }));

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;

  const ready = await getJson(port, '/health');
  assert.equal(ready.status, 503);
  assert.equal(ready.body.status, 'not_ready');
  assert.equal(JSON.stringify(ready.body).includes('must-not-be-exposed'), false);
});
