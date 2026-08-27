const express = require('express');
const path = require('path');
const scheduler = require('./lib/scheduler');

const PORT = process.env.PORT || 9090;
const app = express();

app.disable('x-powered-by');

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; img-src 'self' data:"
  );
  next();
});

app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

app.get('/healthz', (req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

app.get('/events', (req, res) => {
  if (scheduler.atCapacity()) {
    res.status(503).set('Retry-After', '10').end();
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  scheduler.addClient(res);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Dashboard running at http://0.0.0.0:${PORT}`);
  scheduler.start();
});
