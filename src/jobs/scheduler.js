'use strict';

/**
 * Runs the daily stock jobs inside the server process (B12).
 * Both run once a day at 06:00 India time (expiryScan, then lowStockScan),
 * and once shortly after start-up. Turn on with ENABLE_JOBS=true.
 * Re-running is harmless: alerts are sent at most once per period.
 */

const expiryScan = require('./expiryScan');
const lowStockScan = require('./lowStockScan');

const DAY_MS = 24 * 60 * 60 * 1000;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** Milliseconds from `now` until the next 06:00 in India. */
function msUntilNextRun(now = Date.now(), hour = 6) {
  const ist = new Date(now + IST_OFFSET_MS);
  const next = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), hour) - IST_OFFSET_MS;
  return next > now ? next - now : next + DAY_MS - now;
}

async function runAll(log = console.log) {
  for (const [name, job] of [['expiryScan', expiryScan], ['lowStockScan', lowStockScan]]) {
    try {
      await job.run({ log });
    } catch (err) {
      log(`[scheduler] ${name} failed: ${err.message}`);
    }
  }
}

function start({ log = console.log } = {}) {
  const timers = [];
  timers.push(setTimeout(() => runAll(log), 10_000));
  timers.push(setTimeout(function tick() {
    runAll(log);
    timers.push(setTimeout(tick, msUntilNextRun()));
  }, msUntilNextRun()));
  timers.forEach((t) => t.unref());
  log(`[scheduler] stock jobs on; next daily run in ${Math.round(msUntilNextRun() / 60000)} min`);
  return { stop: () => timers.forEach(clearTimeout) };
}

module.exports = { start, runAll, msUntilNextRun };
