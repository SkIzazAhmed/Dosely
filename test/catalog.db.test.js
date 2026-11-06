'use strict';

/**
 * Catalog tables from migration 010 (B1, B3, edge case 5).
 * Needs PostgreSQL in DATABASE_URL; skipped when it isn't reachable.
 * Every test runs in a transaction that is rolled back, so nothing is left behind.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../src/db/pool');
const migrate = require('../src/db/migrate');
const { fromPgError } = require('../src/shared/errors');

let dbUp = false;

test.before(async () => {
  try {
    await pool.query('SELECT 1');
    dbUp = true;
    await migrate.up({ log: () => {} });
  } catch (err) {
    console.warn('[catalog.db.test] skipping DB tests:', err.message);
  }
});

test.after(() => pool.end());

/** Run fn(client) inside a transaction that is always rolled back. */
async function scratch(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await fn(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

/** Expect a query to fail; returns the pg error. Uses a savepoint so the transaction stays usable. */
async function fails(client, sql, params) {
  await client.query('SAVEPOINT f');
  try {
    await client.query(sql, params);
  } catch (err) {
    await client.query('ROLLBACK TO SAVEPOINT f');
    return err;
  }
  throw new Error(`expected failure: ${sql}`);
}

async function seedMedicine(client) {
  const g = await client.query(`INSERT INTO generics (name) VALUES ('Paracetamol') RETURNING id`);
  const m = await client.query(
    `INSERT INTO medicines (brand_name, generic_id, manufacturer, dosage_form, strength, base_unit)
     VALUES ('Dolo 650', $1, 'Micro Labs', 'TABLET', '650 mg', 'TABLET') RETURNING *`,
    [g.rows[0].id]
  );
  return { genericId: g.rows[0].id, medicine: m.rows[0] };
}

test('generic names are unique ignoring case and spaces', async (t) => {
  if (!dbUp) return t.skip('no database');
  await scratch(async (c) => {
    await c.query(`INSERT INTO generics (name) VALUES ('Amoxicillin')`);
    const err = await fails(c, `INSERT INTO generics (name) VALUES (' amoxicillin ')`);
    assert.equal(err.code, '23505');
    assert.equal(fromPgError(err, { generics_name_lower_key: 'GENERIC_NAME_TAKEN' }).code, 'GENERIC_NAME_TAKEN');
  });
});

test('medicines default to prescription required and are unique on brand+manufacturer+form+strength', async (t) => {
  if (!dbUp) return t.skip('no database');
  await scratch(async (c) => {
    const { genericId, medicine } = await seedMedicine(c);
    assert.equal(medicine.prescription_required, true);
    const err = await fails(
      c,
      `INSERT INTO medicines (brand_name, generic_id, manufacturer, dosage_form, strength, base_unit)
       VALUES ('DOLO 650', $1, 'micro labs', 'TABLET', '650mg', 'TABLET')`,
      [genericId]
    );
    assert.equal(err.constraint, 'medicines_identity_key');
    // a different form is a different medicine
    await c.query(
      `INSERT INTO medicines (brand_name, generic_id, manufacturer, dosage_form, strength, base_unit)
       VALUES ('Dolo 650', $1, 'Micro Labs', 'SYRUP', '650 mg', 'ML')`,
      [genericId]
    );
  });
});

test('batches: unique per medicine, MRP > 0, manufacture date before expiry', async (t) => {
  if (!dbUp) return t.skip('no database');
  await scratch(async (c) => {
    const { medicine } = await seedMedicine(c);
    const ins = `INSERT INTO medicine_batches (medicine_id, batch_no, manufacture_date, expiry_date, mrp)
                 VALUES ($1, $2, $3, $4, $5)`;
    await c.query(ins, [medicine.id, 'DL2401', '2026-01-01', '2028-01-01', 2.1]);
    assert.equal((await fails(c, ins, [medicine.id, 'dl2401', null, '2028-01-01', 2.1])).constraint,
      'medicine_batches_medicine_batch_no_key');
    assert.equal((await fails(c, ins, [medicine.id, 'X1', null, '2028-01-01', 0])).constraint,
      'medicine_batches_mrp_positive');
    assert.equal((await fails(c, ins, [medicine.id, 'X2', '2028-02-01', '2028-01-01', 1])).constraint,
      'medicine_batches_dates_order');
  });
});

test('a medicine without batches can be deleted; with a batch the delete maps to MEDICINE_IN_USE', async (t) => {
  if (!dbUp) return t.skip('no database');
  await scratch(async (c) => {
    const { medicine, genericId } = await seedMedicine(c);
    const other = await c.query(
      `INSERT INTO medicines (brand_name, generic_id, manufacturer, dosage_form, strength, base_unit)
       VALUES ('Calpol', $1, 'GSK', 'TABLET', '500 mg', 'TABLET') RETURNING id`,
      [genericId]
    );
    await c.query('DELETE FROM medicines WHERE id = $1', [other.rows[0].id]);

    await c.query(
      `INSERT INTO medicine_batches (medicine_id, batch_no, expiry_date, mrp) VALUES ($1, 'B1', '2028-01-01', 2)`,
      [medicine.id]
    );
    const err = await fails(c, 'DELETE FROM medicines WHERE id = $1', [medicine.id]);
    const mapped = fromPgError(err, { medicine_batches_medicine_id_fkey: 'MEDICINE_IN_USE' });
    assert.equal(mapped.code, 'MEDICINE_IN_USE');
    assert.equal(mapped.status, 409);
  });
});

test('batches and generics cannot be hard-deleted (deactivate instead)', async (t) => {
  if (!dbUp) return t.skip('no database');
  await scratch(async (c) => {
    const { medicine, genericId } = await seedMedicine(c);
    const b = await c.query(
      `INSERT INTO medicine_batches (medicine_id, batch_no, expiry_date, mrp) VALUES ($1, 'B1', '2028-01-01', 2) RETURNING id`,
      [medicine.id]
    );
    for (const [tbl, id] of [['medicine_batches', b.rows[0].id], ['generics', genericId]]) {
      const err = await fails(c, `DELETE FROM ${tbl} WHERE id = $1`, [id]);
      assert.equal(fromPgError(err).code, 'DELETE_NOT_ALLOWED', tbl);
    }
  });
});
