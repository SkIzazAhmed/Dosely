'use strict';

const config = require('./config');
const { createApp } = require('./app');
const db = require('./db/pool');
const jobs = require('./jobs');
const retryNotifications = require('./jobs/retryNotifications');

const app = createApp();
const server = app.listen(config.port, () => {
  console.log(`[server] listening on http://localhost:${config.port} (${config.env})`);
});

// Request + referral jobs (expiry, holds, reminders, patient SMS); JOBS_DISABLED=true turns them off
const jobRunner = process.env.JOBS_DISABLED === 'true' ? null : jobs.start();

// Deliver SMS / EMAIL notifications in-process unless NOTIFY_WORKER=off (A11)
const notifyWorker = config.notifications.worker ? retryNotifications.start() : null;
if (notifyWorker) console.log('[server] notification delivery job running (NOTIFY_WORKER=off to disable)');

// Daily stock jobs (expiryScan, lowStockScan) — Rachana, B12
const stockJobs = process.env.ENABLE_JOBS === 'true' ? require('./jobs/scheduler').start() : null;

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] ${signal} received, shutting down`);
  if (jobRunner) jobRunner.stop();
  server.close(async () => {
    if (notifyWorker) await notifyWorker.stop();
    if (stockJobs) stockJobs.stop();
    await db.close().catch(() => {});
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
