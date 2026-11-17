'use strict';

const http = require('http');

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

const server = http.createServer((req, res) => {
  const pathname = (req.url || '').split('?')[0];

  const ready = runtimeReady && !runtimeStopping;

  // Render's health check should measure process liveness, not Telegram/DB readiness.
  // Temporary provider or database outages must not trigger a platform restart loop.
  if (pathname === '/healthz' || pathname === '/livez') {
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    return res.end(JSON.stringify({
      status: 'ok',
      runtimeReady: ready,
      service: 'BOSS BOT MASTER'
    }));
  }

  if (pathname === '/health' || pathname === '/readyz') {
    res.writeHead(ready ? 200 : 503, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    return res.end(JSON.stringify({
      status: ready ? 'ok' : 'not_ready',
      service: 'BOSS BOT MASTER'
    }));
  }

  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8'
  });
  res.end('BOSS BOT MASTER is running');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`BOSS BOT MASTER health server running on port ${PORT}`);
});

server.on('error', (err) => {
  console.error('HEALTH SERVER ERROR:', err.message);
  process.exitCode = 1;
});

require('./telegram-master');
