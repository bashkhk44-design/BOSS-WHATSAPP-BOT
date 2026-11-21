'use strict';

const { createHealthServer } = require('./health-server');

const PORT = Number(process.env.PORT || 8080);
let runtimeReady = false;
let runtimeStopping = false;
let serverClosePromise = null;

const server = createHealthServer(() => ({ runtimeReady, runtimeStopping }));

process.on('boss:runtime-ready', () => {
  runtimeReady = true;
  runtimeStopping = false;
  console.log('Platform worker health status: READY');
});

process.on('boss:runtime-stopping', signal => {
  runtimeReady = false;
  runtimeStopping = true;
  console.log('Platform worker health status: STOPPING', signal || '');
  if (!serverClosePromise && server.listening) {
    serverClosePromise = new Promise(resolve => server.close(resolve));
  }
});

async function listen() {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, '0.0.0.0', resolve);
  });
  console.log('BOSS platform worker health server listening on port ' + PORT);
}

async function main() {
  await listen();
  try {
    const { main: startPlatformWorker } = require('./platform-worker');
    await startPlatformWorker();
  } finally {
    runtimeReady = false;
    runtimeStopping = true;
    if (!serverClosePromise && server.listening) {
      serverClosePromise = new Promise(resolve => server.close(resolve));
    }
    if (serverClosePromise) await serverClosePromise;
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error('PLATFORM HOST STARTUP FAILED:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { main, listen };
