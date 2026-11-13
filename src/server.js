'use strict';

const config = require('./config');
const { createApp } = require('./app');
const db = require('./db/pool');
const jobs = require('./jobs');

const app = createApp();
const server = app.listen(config.port, () => {
  console.log(`[server] listening on http://localhost:${config.port} (${config.env})`);
});

// Request + referral jobs (expiry, holds, reminders, patient SMS); JOBS_DISABLED=true turns them off
const jobRunner = process.env.JOBS_DISABLED === 'true' ? null : jobs.start();

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] ${signal} received, shutting down`);
  if (jobRunner) jobRunner.stop();
  server.close(async () => {
    await db.close().catch(() => {});
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
