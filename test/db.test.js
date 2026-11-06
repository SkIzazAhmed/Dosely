'use strict';

/**
 * Integration tests: need a reachable PostgreSQL in DATABASE_URL.
 * Use a throwaway database — these create and drop a scratch table.
 * Skipped automatically when the database is not reachable.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../src/db/pool');
const { withTransaction } = require('../src/db/transaction');
const migrate = require('../src/db/migrate');
const { createApp } = require('../src/app');
const { fromPgError } = require('../src/shared/errors');

let dbUp = false;

test.before(async () => {
  try {
    await pool.query('SELECT 1');
    dbUp = true;
    await migrate.up({ log: () => {} });
    await pool.query(`
      DROP TABLE IF EXISTS _conv_test;
      CREATE TABLE _conv_test (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        name text NOT NULL,
        role user_role NOT NULL,
        is_active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      SELECT apply_conventions('_conv_test');`);
  } catch (err) {
    console.warn('[db.test] skipping DB tests:', err.message);
  }
});

test.after(async () => {
  if (dbUp) await pool.query('DROP TABLE IF EXISTS _conv_test');
  await pool.end();
});

test('migrations are idempotent (second run applies nothing)', async (t) => {
  if (!dbUp) return t.skip('no database');
  assert.deepEqual(await migrate.up({ log: () => {} }), []);
});

test('all enums from migration 001 exist', async (t) => {
  if (!dbUp) return t.skip('no database');
  const { rows } = await pool.query(`SELECT typname FROM pg_type WHERE typtype = 'e' ORDER BY typname`);
  const names = rows.map((r) => r.typname);
  for (const e of ['gender', 'notification_channel', 'notification_recipient_type', 'notification_status',
    'phone_owner_type', 'phone_status', 'phone_type', 'staff_role', 'user_role']) {
    assert.ok(names.includes(e), `missing enum ${e}`);
  }
});

test('updated_at trigger bumps on update', async (t) => {
  if (!dbUp) return t.skip('no database');
  const { rows: [r] } = await pool.query(
    `INSERT INTO _conv_test (name, role, created_at, updated_at)
     VALUES ('a', 'ADMIN', now() - interval '1 hour', now() - interval '1 hour') RETURNING *`);
  const { rows: [u] } = await pool.query(`UPDATE _conv_test SET name = 'b' WHERE id = $1 RETURNING *`, [r.id]);
  assert.ok(u.updated_at > r.updated_at);
  assert.equal(u.created_at.getTime(), r.created_at.getTime());
});

test('hard deletes are blocked and map to DELETE_NOT_ALLOWED', async (t) => {
  if (!dbUp) return t.skip('no database');
  const { rows: [r] } = await pool.query(`INSERT INTO _conv_test (name, role) VALUES ('c', 'DOCTOR') RETURNING id`);
  await assert.rejects(pool.query('DELETE FROM _conv_test WHERE id = $1', [r.id]), (err) => {
    assert.equal(fromPgError(err).code, 'DELETE_NOT_ALLOWED');
    return true;
  });
});

test('withTransaction rolls back on error', async (t) => {
  if (!dbUp) return t.skip('no database');
  await assert.rejects(
    withTransaction(async (c) => {
      await c.query(`INSERT INTO _conv_test (name, role) VALUES ('rollback-me', 'ADMIN')`);
      throw new Error('boom');
    }),
    /boom/
  );
  const { rowCount } = await pool.query(`SELECT 1 FROM _conv_test WHERE name = 'rollback-me'`);
  assert.equal(rowCount, 0);
});

test('nested withTransaction uses a savepoint', async (t) => {
  if (!dbUp) return t.skip('no database');
  await withTransaction(async (c) => {
    await c.query(`INSERT INTO _conv_test (name, role) VALUES ('outer', 'ADMIN')`);
    await assert.rejects(
      withTransaction(async (c2) => {
        await c2.query(`INSERT INTO _conv_test (name, role) VALUES ('inner', 'ADMIN')`);
        throw new Error('inner fails');
      }, { client: c })
    );
  });
  const { rows } = await pool.query(`SELECT name FROM _conv_test WHERE name IN ('outer','inner')`);
  assert.deepEqual(rows.map((r) => r.name), ['outer']);
});

test('HTTP: /health is ok and unknown routes use the error format', async (t) => {
  if (!dbUp) return t.skip('no database');
  const server = createApp().listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const h = await fetch(`${base}/health`);
    assert.equal(h.status, 200);
    assert.deepEqual(await h.json(), { status: 'ok', db: 'up' });

    const nf = await fetch(`${base}/nope`);
    assert.equal(nf.status, 404);
    const body = await nf.json();
    assert.equal(body.error.code, 'ROUTE_NOT_FOUND');
    assert.ok('details' in body.error);

    const bad = await fetch(`${base}/health`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' });
    assert.equal((await bad.json()).error.code, 'BAD_REQUEST');
  } finally {
    server.close();
  }
});
