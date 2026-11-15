const http = require('http');

const PORT = Number(process.env.PORT || 8080);

http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      status: 'ok',
      service: 'BOSS BOT MASTER'
    }));
  }

  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('BOSS BOT MASTER is running');
}).listen(PORT, '0.0.0.0', () => {
  console.log(`BOSS BOT MASTER health server running on port ${PORT}`);
});

require('./telegram-master');
