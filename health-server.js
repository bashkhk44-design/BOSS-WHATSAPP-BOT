'use strict';

const http = require('node:http');

function createHealthServer(getRuntimeState) {
  return http.createServer((req, res) => {
    const pathname = (req.url || '').split('?')[0];
    const state = typeof getRuntimeState === 'function'
      ? getRuntimeState() || {}
      : {};
    const ready = state.runtimeReady === true && state.runtimeStopping !== true;

    // Liveness reports whether the HTTP process can answer, independent of Telegram startup.
    // Render can safely use /healthz without restarting a healthy process during bot recovery.
    if (pathname === '/livez' || pathname === '/healthz') {
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

    // Readiness is separate: callers can detect startup/recovery or graceful shutdown.
    if (pathname === '/health' || pathname === '/readyz') {
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
