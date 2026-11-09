'use strict';

const { Pool, types } = require('pg');
const config = require('../config');

// Return BIGINT/identity ids as JS numbers (safe up to 2^53, plenty for an MVP).
types.setTypeParser(20, (v) => Number.parseInt(v, 10));
// Return NUMERIC (e.g. latitude/longitude, prices) as numbers.
types.setTypeParser(1700, (v) => Number.parseFloat(v));
// Return DATE as 'YYYY-MM-DD' strings (no timezone shift), matching the
// team convention for dateOfBirth, expiryDate, etc. timestamptz stays a Date.
types.setTypeParser(1082, (v) => v);

const pool = new Pool({
  connectionString: config.db.connectionString,
  max: config.db.max,
});

pool.on('error', (err) => {
  // An idle client errored (e.g. DB restarted). Log; pg will drop the client.
  console.error('[db] idle client error:', err.message);
});

/** Run a single query on the pool (or a given client inside a transaction). */
function query(text, params, client = pool) {
  return client.query(text, params);
}

async function close() {
  await pool.end();
}

module.exports = { pool, query, close };
