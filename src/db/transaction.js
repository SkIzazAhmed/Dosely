'use strict';

const { pool } = require('./pool');

/**
 * Run fn(client) inside BEGIN/COMMIT. Rolls back on any thrown error and
 * re-throws it. Always pass `client` to every query inside fn.
 *
 *   const shop = await withTransaction(async (client) => {
 *     const { rows } = await client.query('INSERT INTO shops ... RETURNING *', [...]);
 *     await client.query('INSERT INTO shop_staff ...', [...]);
 *     return rows[0];
 *   });
 *
 * Nesting: if you already have a client from an outer withTransaction,
 * pass it as `opts.client` and the inner call uses a SAVEPOINT instead.
 */
async function withTransaction(fn, opts = {}) {
  if (opts.client) {
    const sp = `sp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    await opts.client.query(`SAVEPOINT ${sp}`);
    try {
      const result = await fn(opts.client);
      await opts.client.query(`RELEASE SAVEPOINT ${sp}`);
      return result;
    } catch (err) {
      await opts.client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
      throw err;
    }
  }

  const client = await pool.connect();
  try {
    await client.query(opts.isolationLevel ? `BEGIN ISOLATION LEVEL ${opts.isolationLevel}` : 'BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('[db] rollback failed:', rollbackErr.message);
    }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { withTransaction };
