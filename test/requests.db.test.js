'use strict';

/**
 * Migrations 020, 021: STOCK_REQUESTS and REFERRALS checks (C1, C2, C7, C8) and foreign keys.
 * Needs PostgreSQL in DATABASE_URL; skipped when it isn't reachable.
 * Every test runs in a transaction that is rolled back.
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
    console.warn('[requests.db.test] skipping DB tests:', err.message);
  }
});

test.after(() => pool.end());

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

// Five fresh shops per test (created inside the rolled-back transaction).
let SHOP_A, SHOP_B, SHOP_C, SHOP_D, SHOP_E;

async function fixtures(c) {
  const shops = [];
  for (let i = 0; i < 5; i++) {
    const code = `DB-${Date.now().toString(36).toUpperCase()}${i}${Math.floor(Math.random() * 1e4)}`;
    const { rows: [s] } = await c.query(
      `INSERT INTO shops (name, code, drug_licence_no, address, area, pincode)
       VALUES ($1, $2, $3, '1 Test Road', 'Jayanagar', '560041') RETURNING id`,
      [`Shop ${code}`, code, `DL-${code}`]
    );
    shops.push(s.id);
  }
  [SHOP_A, SHOP_B, SHOP_C, SHOP_D, SHOP_E] = shops;
  const u = await c.query(
    `INSERT INTO users (role, full_name, password_hash) VALUES ('DOCTOR', 'Dr Test', 'x') RETURNING id`
  );
  const d = await c.query(`INSERT INTO doctors (user_id, registration_no) VALUES ($1, $2) RETURNING id`, [
    u.rows[0].id,
    `T-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
  ]);
  const staff = await c.query(
    `INSERT INTO users (role, full_name, password_hash) VALUES ('SHOPKEEPER', 'Staff', 'x') RETURNING id`
  );
  const g = await c.query(`INSERT INTO generics (name) VALUES ($1) RETURNING id`, [`Gen-${Date.now()}-${Math.random()}`]);
  const m = await c.query(
    `INSERT INTO medicines (brand_name, generic_id, manufacturer, dosage_form, strength, base_unit)
     VALUES ('ReqTest', $1, 'Lab', 'TABLET', '500 mg', 'TABLET') RETURNING id`,
    [g.rows[0].id]
  );
  return { doctorId: d.rows[0].id, staffId: staff.rows[0].id, medicineId: m.rows[0].id };
}

async function insertRequest(c, f, over = {}) {
  const v = { requested: 10, snapshot: 2, urgency: 'ROUTINE', hours: 24, note: null, ...over };
  const { rows } = await c.query(
    `INSERT INTO stock_requests (request_no, doctor_id, shop_id, medicine_id, requested_qty,
                                 available_qty_snapshot, urgency, doctor_note, expires_at)
     VALUES (next_request_no(), $1, $2, $3, $4, $5, $6, $7, now() + make_interval(hours => $8))
     RETURNING *`,
    [f.doctorId, SHOP_A, f.medicineId, v.requested, v.snapshot, v.urgency, v.note, v.hours]
  );
  return rows[0];
}

async function insertReferral(c, f, requestId, toShop, quantity, seen = quantity) {
  const { rows } = await c.query(
    `INSERT INTO referrals (request_id, from_shop_id, to_shop_id, quantity, available_qty_seen, referred_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [requestId, SHOP_A, toShop, quantity, seen, f.staffId]
  );
  return rows[0];
}

test('request numbers are REQ-YYYY-NNNNNN and increase', async (t) => {
  if (!dbUp) return t.skip('no database');
  await scratch(async (c) => {
    const f = await fixtures(c);
    const a = await insertRequest(c, f);
    const b = await insertRequest(c, f);
    assert.match(a.request_no, /^REQ-\d{4}-\d{6}$/);
    assert.equal(Number(b.request_no.slice(-6)), Number(a.request_no.slice(-6)) + 1);
    assert.equal(a.status, 'SENT');
    assert.equal(a.fulfilled_qty, 0);
    const next = await c.query(`SELECT next_request_no('2031-03-01T00:00:00Z') AS n`);
    assert.equal(next.rows[0].n, 'REQ-2031-000001');
  });
});

test('C1: quantity 1–10,000, note ≤ 500 chars, only when the shop is short', async (t) => {
  if (!dbUp) return t.skip('no database');
  await scratch(async (c) => {
    const f = await fixtures(c);
    const cases = [
      [{ requested: 0, snapshot: 0 }, 'stock_requests_requested_qty_range'],
      [{ requested: 10001, snapshot: 0 }, 'stock_requests_requested_qty_range'],
      [{ requested: 5, snapshot: 5 }, 'stock_requests_shop_is_short'],
      [{ requested: 5, snapshot: -1 }, 'stock_requests_snapshot_non_negative'],
      [{ note: 'x'.repeat(501) }, 'stock_requests_doctor_note_length'],
      [{ hours: 0 }, 'stock_requests_expiry_after_create'],
    ];
    for (const [over, constraint] of cases) {
      await c.query('SAVEPOINT f');
      try {
        await insertRequest(c, f, over);
        assert.fail(`expected ${constraint}`);
      } catch (err) {
        await c.query('ROLLBACK TO SAVEPOINT f');
        assert.equal(err.code, '23514', constraint);
        assert.equal(err.constraint, constraint);
      }
    }
    const ok = await insertRequest(c, f, { requested: 10000, snapshot: 9999, note: 'x'.repeat(500), urgency: 'URGENT', hours: 2 });
    assert.equal(ok.urgency, 'URGENT');
  });
});

test('status checks: FULFILLED needs full qty, PARTIALLY_FULFILLED some, CLOSED a reason', async (t) => {
  if (!dbUp) return t.skip('no database');
  await scratch(async (c) => {
    const f = await fixtures(c);
    const r = await insertRequest(c, f);
    const upd = (sql) => fails(c, `UPDATE stock_requests SET ${sql} WHERE id = ${r.id}`);
    assert.equal((await upd(`status = 'FULFILLED', fulfilled_qty = 9`)).constraint, 'stock_requests_fulfilled_means_full');
    assert.equal((await upd(`status = 'PARTIALLY_FULFILLED'`)).constraint, 'stock_requests_partial_means_some');
    assert.equal((await upd(`status = 'CLOSED'`)).constraint, 'stock_requests_closed_needs_reason');
    assert.equal((await upd(`fulfilled_qty = 11`)).constraint, 'stock_requests_fulfilled_qty_range');
    assert.equal((await upd(`status = 'NOPE'`)).code, '22P02');
    await c.query(`UPDATE stock_requests SET status = 'PARTIALLY_FULFILLED', fulfilled_qty = 4 WHERE id = $1`, [r.id]);
  });
});

test('requests and referrals cannot be hard-deleted', async (t) => {
  if (!dbUp) return t.skip('no database');
  await scratch(async (c) => {
    const f = await fixtures(c);
    const r = await insertRequest(c, f);
    await insertReferral(c, f, r.id, SHOP_B, 3);
    const e1 = await fails(c, `DELETE FROM referrals WHERE request_id = $1`, [r.id]);
    assert.equal(fromPgError(e1).code, 'DELETE_NOT_ALLOWED');
    const e2 = await fails(c, `DELETE FROM stock_requests WHERE id = $1`, [r.id]);
    assert.equal(fromPgError(e2).code, 'DELETE_NOT_ALLOWED');
  });
});

test('C7: no duplicate live referral to one shop; a new one is fine after the old one ends', async (t) => {
  if (!dbUp) return t.skip('no database');
  await scratch(async (c) => {
    const f = await fixtures(c);
    const r = await insertRequest(c, f);
    const first = await insertReferral(c, f, r.id, SHOP_B, 3);
    const err = await fails(
      c,
      `INSERT INTO referrals (request_id, from_shop_id, to_shop_id, quantity, available_qty_seen, referred_by)
       VALUES ($1, $2, $3, 2, 2, $4)`,
      [r.id, SHOP_A, SHOP_B, f.staffId]
    );
    assert.equal(fromPgError(err, { referrals_live_target_key: 'REFERRAL_DUPLICATE' }).code, 'REFERRAL_DUPLICATE');
    await c.query(`UPDATE referrals SET status = 'REJECTED', reject_reason = 'no stock' WHERE id = $1`, [first.id]);
    await insertReferral(c, f, r.id, SHOP_B, 2);
  });
});

test('C7: at most 3 referrals per request', async (t) => {
  if (!dbUp) return t.skip('no database');
  await scratch(async (c) => {
    const f = await fixtures(c);
    const r = await insertRequest(c, f, { requested: 20, snapshot: 0 });
    await insertReferral(c, f, r.id, SHOP_B, 2);
    await insertReferral(c, f, r.id, SHOP_C, 2);
    await insertReferral(c, f, r.id, SHOP_D, 2);
    const err = await fails(
      c,
      `INSERT INTO referrals (request_id, from_shop_id, to_shop_id, quantity, available_qty_seen, referred_by)
       VALUES ($1, $2, $3, 1, 1, $4)`,
      [r.id, SHOP_A, SHOP_E, f.staffId]
    );
    assert.equal(fromPgError(err).code, 'REFERRAL_LIMIT_REACHED');
  });
});

test('C7: live referred quantity ≤ what is unfulfilled', async (t) => {
  if (!dbUp) return t.skip('no database');
  await scratch(async (c) => {
    const f = await fixtures(c);
    const r = await insertRequest(c, f, { requested: 10, snapshot: 0 });
    await c.query(`UPDATE stock_requests SET status = 'PARTIALLY_FULFILLED', fulfilled_qty = 4 WHERE id = $1`, [r.id]);
    await insertReferral(c, f, r.id, SHOP_B, 4);
    const err = await fails(
      c,
      `INSERT INTO referrals (request_id, from_shop_id, to_shop_id, quantity, available_qty_seen, referred_by)
       VALUES ($1, $2, $3, 3, 3, $4)`,
      [r.id, SHOP_A, SHOP_C, f.staffId]
    );
    assert.equal(fromPgError(err).code, 'REFERRAL_QTY_EXCEEDED');
    await insertReferral(c, f, r.id, SHOP_C, 2); // 4 + 2 = 6 unfulfilled: ok
  });
});

test('C7/C8: referral checks — shops differ, seen qty, reject reason, accept hold', async (t) => {
  if (!dbUp) return t.skip('no database');
  await scratch(async (c) => {
    const f = await fixtures(c);
    const r = await insertRequest(c, f);
    const same = await fails(
      c,
      `INSERT INTO referrals (request_id, from_shop_id, to_shop_id, quantity, available_qty_seen, referred_by)
       VALUES ($1, $2, $2, 1, 1, $3)`,
      [r.id, SHOP_A, f.staffId]
    );
    assert.equal(same.constraint, 'referrals_shops_differ');
    const seen = await fails(
      c,
      `INSERT INTO referrals (request_id, from_shop_id, to_shop_id, quantity, available_qty_seen, referred_by)
       VALUES ($1, $2, $3, 5, 4, $4)`,
      [r.id, SHOP_A, SHOP_B, f.staffId]
    );
    assert.equal(seen.constraint, 'referrals_seen_covers_quantity');

    const ref = await insertReferral(c, f, r.id, SHOP_B, 3);
    assert.equal(ref.status, 'PENDING');
    const upd = (sql) => fails(c, `UPDATE referrals SET ${sql} WHERE id = ${ref.id}`);
    assert.equal((await upd(`status = 'REJECTED'`)).constraint, 'referrals_rejected_needs_reason');
    assert.equal((await upd(`status = 'REJECTED', reject_reason = '  '`)).constraint, 'referrals_rejected_needs_reason');
    assert.equal((await upd(`status = 'ACCEPTED', accepted_at = now()`)).constraint, 'referrals_accepted_has_hold');
    await c.query(
      `UPDATE referrals SET status = 'ACCEPTED', accepted_at = now(), hold_until = now() + interval '24 hours'
       WHERE id = $1`,
      [ref.id]
    );
  });
});

test('021: shop and patient ids must exist', async (t) => {
  if (!dbUp) return t.skip('no database');
  await scratch(async (c) => {
    const f = await fixtures(c);
    const r = await insertRequest(c, f);
    const badShop = await fails(c, `UPDATE stock_requests SET shop_id = 999999999 WHERE id = $1`, [r.id]);
    assert.equal(badShop.constraint, 'stock_requests_shop_id_fkey');
    const badPatient = await fails(c, `UPDATE stock_requests SET patient_id = 999999999 WHERE id = $1`, [r.id]);
    assert.equal(badPatient.constraint, 'stock_requests_patient_id_fkey');
    const badTarget = await fails(
      c,
      `INSERT INTO referrals (request_id, from_shop_id, to_shop_id, quantity, available_qty_seen, referred_by)
       VALUES ($1, $2, 999999999, 1, 1, $3)`,
      [r.id, SHOP_A, f.staffId]
    );
    assert.equal(badTarget.constraint, 'referrals_to_shop_id_fkey');
  });
});
