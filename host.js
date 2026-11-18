'use strict';

const { createHealthServer } = require('./health-server');

const PORT = Number(process.env.PORT || 8080);

let runtimeReady = false;
let runtimeStopping = false;

process.on('boss:runtime-ready', () => {
  runtimeReady = true;
  runtimeStopping = false;
  console.log('Health status: READY');
});

process.on('boss:runtime-stopping', (signal) => {
  runtimeReady = false;
  runtimeStopping = true;
  console.log('Health status: STOPPING', signal || '');
});

const server = createHealthServer(() => ({ runtimeReady, runtimeStopping }));

server.listen(PORT, '0.0.0.0', () => {
  console.log(`BOSS BOT MASTER health server running on port ${PORT}`);
});

server.on('error', (err) => {
  console.error('HEALTH SERVER ERROR:', err.message);
  process.exitCode = 1;
});

async function boot() {
  const { pool } = require('./db');
  const { createMigrationRunner } = require('./migrations/runner');

  try {
    const migrationRunner = createMigrationRunner({ pool });
    const migrationResult = await migrationRunner.run();
    console.log('Database migrations complete:', JSON.stringify(migrationResult));

    const { createMasterRuntime } = require('./telegram-master');
    const telegramRuntime = createMasterRuntime();
    await telegramRuntime.start();
  } catch (error) {
    console.error('HOST STARTUP FAILED:', error.message);
    runtimeReady = false;
    server.close(() => {
      void pool.end().finally(() => process.exit(1));
    });
  }
}

void boot();
