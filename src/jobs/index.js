'use strict';

/**
 * Background jobs for requests and referrals (C10, C11).
 *
 *   start()    run every job on its interval (src/server.js calls this unless JOBS_DISABLED=true)
 *   runOnce()  run every job once, in order — `npm run jobs:once`
 *
 * Each run takes a PostgreSQL advisory lock named after the job, so with
 * several app instances only one runs a given job at a time; a run still in
 * progress is never started again on the same instance.
 */

const crypto = require('node:crypto');
const { pool } = require('../db/pool');

const JOBS = [
  require('./expireRequests'),
  require('./expireReferralHolds'),
  require('./remindPendingReferrals'),
  require('./sendPatientReferralSms'),
];

const lockId = (name) => crypto.createHash('sha1').update(`dosely-job:${name}`).digest().readInt32BE(0);

async function runJob(job, { log = console.log } = {}) {
  const client = await pool.connect();
  try {
    const { rows: [{ ok }] } = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [lockId(job.name)]);
    if (!ok) return { skipped: true };
    try {
      const result = await job.run();
      const did = Object.values(result || {}).some((v) => (Array.isArray(v) ? v.length : v));
      if (did) log(`[jobs] ${job.name}`, JSON.stringify(result));
      return result;
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [lockId(job.name)]);
    }
  } finally {
    client.release();
  }
}

async function runOnce(opts) {
  const out = {};
  for (const job of JOBS) out[job.name] = await runJob(job, opts);
  return out;
}

function start({ log = console.log } = {}) {
  const timers = JOBS.map((job) => {
    let running = false;
    const tick = async () => {
      if (running) return;
      running = true;
      try {
        await runJob(job, { log });
      } catch (err) {
        console.error(`[jobs] ${job.name} failed:`, err.message);
      } finally {
        running = false;
      }
    };
    const timer = setInterval(tick, job.everyMs);
    timer.unref();
    return timer;
  });
  log(`[jobs] started: ${JOBS.map((j) => `${j.name} every ${j.everyMs / 60_000} min`).join(', ')}`);
  return { stop: () => timers.forEach(clearInterval) };
}

module.exports = { JOBS, runJob, runOnce, start };

if (require.main === module && process.argv.includes('--once')) {
  runOnce()
    .then((out) => console.log(JSON.stringify(out, null, 2)))
    .catch((err) => { console.error(err); process.exitCode = 1; })
    .finally(() => pool.end());
}
