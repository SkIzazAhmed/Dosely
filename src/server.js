'use strict';

const config = require('./config');
const { createApp } = require('./app');
const db = require('./db/pool');

const app = createApp();
const server = app.listen(config.port, () => {
  console.log(`[server] listening on http://localhost:${config.port} (${config.env})`);
});

// Daily stock jobs (expiryScan, lowStockScan) — Rachana, B12
if (process.env.ENABLE_JOBS === 'true') require('./jobs/scheduler').start();

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] ${signal} received, shutting down`);
  server.close(async () => {
    await db.close().catch(() => {});
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
