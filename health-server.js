'use strict';

const http = require('node:http');

function createHealthServer(getRuntimeState) {
  return http.createServer((req, res) => {
    const pathname = (req.url || '').split('?')[0];
    const state = typeof getRuntimeState === 'function'
      ? getRuntimeState() || {}
      : {};
    const ready = state.runtimeReady === true && state.runtimeStopping !== true;

    // Liveness only answers whether the Node process can serve HTTP.
    if (pathname === '/livez') {
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      return res.end(JSON.stringify({
        status: 'ok',
        service: 'BOSS BOT MASTER'
      }));
    }

    // Render should use /healthz: an HTTP 503 tells it the Telegram runtime
    // has not started (or is shutting down), instead of falsely reporting healthy.
    if (pathname === '/healthz' || pathname === '/health' || pathname === '/readyz') {
      res.writeHead(ready ? 200 : 503, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      return res.end(JSON.stringify({
        status: ready ? 'ok' : 'not_ready',
        runtimeReady: ready,
        service: 'BOSS BOT MASTER'
      }));
    }

    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    res.end('BOSS BOT MASTER is running');
  });
}

module.exports = { createHealthServer };
