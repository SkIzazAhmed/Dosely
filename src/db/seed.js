'use strict';

/**
 * Seed runner: executes every db/seeds/*.js in name order.
 * Each seed file exports `async function seed(client)` and must be
 * idempotent (use ON CONFLICT DO NOTHING / upserts) so `npm run seed`
 * can be run again safely. All seeds run in one transaction.
 *
 * Demo users, shops, staff and patients land in Commit 3 (Nov 8).
 */

const fs = require('node:fs');
const path = require('node:path');
const { pool } = require('./pool');
const { withTransaction } = require('./transaction');

const SEEDS_DIR = path.join(__dirname, 'seeds');

async function run({ log = console.log } = {}) {
  const files = fs.readdirSync(SEEDS_DIR).filter((f) => f.endsWith('.js')).sort();
  if (files.length === 0) {
    log('[seed] no seed files yet');
    return [];
  }
  await withTransaction(async (client) => {
    for (const file of files) {
      log(`[seed] running ${file}`);
      const mod = require(path.join(SEEDS_DIR, file));
      const fn = typeof mod === 'function' ? mod : mod.seed;
      if (typeof fn !== 'function') throw new Error(`Seed ${file} must export seed(client)`);
      await fn(client);
    }
  });
  log(`[seed] ran ${files.length} seed file(s)`);
  return files;
}

module.exports = { run };

if (require.main === module) {
  run()
    .then(() => pool.end())
    .catch(async (err) => {
      console.error('[seed] failed:', err.message);
      await pool.end();
      process.exit(1);
    });
}
