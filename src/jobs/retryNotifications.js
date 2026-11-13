'use strict';

/**
 * retryNotifications job (A11): sends PENDING SMS / EMAIL notifications and
 * retries failures with backoff, up to 5 attempts.
 *
 * Runs inside the API process by default (NOTIFY_WORKER=on). To run it as its
 * own process instead, set NOTIFY_WORKER=off for the API and run:
 *
 *   npm run jobs:notifications          keep running (every NOTIFY_WORKER_INTERVAL_MS)
 *   npm run jobs:notifications -- --once  one pass, then exit
 *
 * Several workers can run at once: rows are claimed with SKIP LOCKED.
 */

const config = require('../config');
const { deliverDue } = require('../modules/notifications/delivery');

const quiet = Boolean(process.env.NODE_TEST_CONTEXT);

function log(summary) {
  if (!quiet && summary.claimed > 0) {
    console.log(`[retryNotifications] sent ${summary.sent}, retrying ${summary.retried}, failed ${summary.failed}, skipped ${summary.skipped}`);
  }
}

async function runOnce(opts) {
  const summary = await deliverDue(opts);
  log(summary);
  return summary;
}

/** Start the loop. Returns { stop() }. A pass never overlaps the previous one. */
function start({ intervalMs = config.notifications.workerIntervalMs } = {}) {
  let running = false;
  let stopped = false;
  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      await runOnce();
    } catch (err) {
      console.error('[retryNotifications] pass failed:', err.message);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  tick();
  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      while (running) await new Promise((r) => setTimeout(r, 20)); // let the current pass finish
    },
  };
}

module.exports = { runOnce, start };

if (require.main === module) {
  const { pool } = require('../db/pool');
  if (process.argv.includes('--once')) {
    runOnce()
      .then((s) => {
        console.log('[retryNotifications]', JSON.stringify(s));
        return pool.end();
      })
      .catch(async (err) => {
        console.error(err.message);
        await pool.end();
        process.exit(1);
      });
  } else {
    const worker = start();
    console.log(`[retryNotifications] running every ${config.notifications.workerIntervalMs} ms`);
    const shutdown = async () => {
      await worker.stop();
      await pool.end();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    setInterval(() => {}, 1 << 30); // keep the process alive (the worker timer is unref'd)
  }
}
