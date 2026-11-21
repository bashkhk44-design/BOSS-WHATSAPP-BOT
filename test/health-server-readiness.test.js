'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHealthServer } = require('../health-server');

async function request(server, path) {
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}${path}`);
  return { status: response.status, body: await response.json() };
}

test('health endpoints separate liveness from runtime readiness', async t => {
  let state = { runtimeReady: false, runtimeStopping: false };
  const server = createHealthServer(() => state);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));

  const live = await request(server, '/livez');
  const readyBefore = await request(server, '/readyz');
  assert.equal(live.status, 200);
  assert.equal(readyBefore.status, 503);

  state = { runtimeReady: true, runtimeStopping: false };
  const ready = await request(server, '/readyz');
  assert.equal(ready.status, 200);

  state = { runtimeReady: true, runtimeStopping: true };
  const stopping = await request(server, '/readyz');
  assert.equal(stopping.status, 503);
});
