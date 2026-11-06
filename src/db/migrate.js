'use strict';

/**
 * Minimal SQL migration runner.
 *
 *   npm run migrate          apply every pending file in db/migrations
 *   npm run migrate:status   list applied / pending
 *
 * Rules for the team:
 *   - File name: NNN_short_name.sql (e.g. 004_inventory.sql). Numbers are
 *     claimed in the team chat so two people never use the same one.
 *   - Never edit a migration after it is on main. Add a new one instead.
 *     The runner stores a checksum and refuses to continue if a file changed.
 *   - Each file runs in its own transaction. Note: `ALTER TYPE ... ADD VALUE`
 *     can't be used in the same transaction that uses the new value.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pool } = require('./pool');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const LOCK_ID = 727274; // arbitrary constant for pg_advisory_lock

function listFiles() {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{3,}_.+\.sql$/.test(f))
    .sort();
}

function checksum(sql) {
  return crypto.createHash('sha256').update(sql).digest('hex');
}

async function ensureTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        text PRIMARY KEY,
      checksum    text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )`);
}

async function applied(client) {
  const { rows } = await client.query('SELECT name, checksum FROM schema_migrations ORDER BY name');
  return new Map(rows.map((r) => [r.name, r.checksum]));
}

async function up({ log = console.log } = {}) {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    await ensureTable(client);
    const done = await applied(client);
    const ran = [];

    for (const file of listFiles()) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      const sum = checksum(sql);

      if (done.has(file)) {
        if (done.get(file) !== sum) {
          throw new Error(
            `Migration ${file} was changed after it was applied. ` +
              'Revert the edit and add a new migration instead.'
          );
        }
        continue;
      }

      log(`[migrate] applying ${file}`);
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [file, sum]);
        await client.query('COMMIT');
        ran.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        err.message = `Migration ${file} failed: ${err.message}`;
        throw err;
      }
    }

    log(ran.length ? `[migrate] applied ${ran.length} migration(s)` : '[migrate] database is up to date');
    return ran;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {});
    client.release();
  }
}

async function status({ log = console.log } = {}) {
  const client = await pool.connect();
  try {
    await ensureTable(client);
    const done = await applied(client);
    for (const file of listFiles()) log(`${done.has(file) ? '[x]' : '[ ]'} ${file}`);
  } finally {
    client.release();
  }
}

module.exports = { up, status };

if (require.main === module) {
  const cmd = process.argv[2] || 'up';
  const run = cmd === 'status' ? status : up;
  run()
    .then(() => pool.end())
    .catch(async (err) => {
      console.error(err.message);
      await pool.end();
      process.exit(1);
    });
}
