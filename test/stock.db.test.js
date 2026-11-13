'use strict';

/**
 * Commit 3 "done when": stock-in writes inventory and a movement row in one
 * transaction. Plus B4–B7, edge cases 3 and 15, and the ledger guards.
 * Needs PostgreSQL (DATABASE_URL); skipped when unreachable.
 * Creates its own shops and medicines with random names, so it's safe on a dev database.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { pool } = require('../src/db/pool');
const migrate = require('../src/db/migrate');
const seeds = require('../src/db/seed');
const { withTransaction } = require('../src/db/transaction');
const { createApp } = require('../src/app');
const stock = require('../src/modules/inventory/stock.service');
const medicines = require('../src/modules/medicines/medicine.service');

const PASSWORD = process.env.SEED_PASSWORD || 'Dosely@123';
let dbUp = false;
let server;
let base;
let adminId;

const uniq = () => crypto.randomBytes(4).toString('hex');
// Dates in India time, the same "today" the app uses for expiry.
const days = (n) => new Date(Date.now() + 5.5 * 3600000 + n * 86400000).toISOString().slice(0, 10);

/** A fresh active shop (inventory.shop_id references shops). */
async function newShop() {
  const code = `T-${uniq().toUpperCase()}`;
  const { rows: [s] } = await pool.query(
    `INSERT INTO shops (name, code, drug_licence_no, address, area, city, pincode)
     VALUES ($1, $2, $3, '12 Test Road', 'Testpura', 'Bengaluru', '560001') RETURNING id`,
    [`Test Shop ${code}`, code, `DL-${code}`]
  );
  return s.id;
}

test.before(async () => {
  try {
    await pool.query('SELECT 1');
    dbUp = true;
  } catch (err) {
    console.warn('[stock.db.test] skipping:', err.message);
    return;
  }
  await migrate.up({ log: () => {} });
  await seeds.run({ log: () => {} });
  adminId = (await pool.query(`SELECT id FROM users WHERE email = 'admin@dosely.dev'`)).rows[0].id;
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) server.close();
  await pool.end();
});

const t = (name, fn) => test(name, async (ctx) => (dbUp ? fn(ctx) : ctx.skip('no database')));

async function newMedicine() {
  return medicines.create({
    brandName: `Azee ${uniq()}`,
    genericName: `Azithromycin-${uniq()}`,
    manufacturer: 'Cipla',
    dosageForm: 'TABLET',
    strength: '500 mg',
    baseUnit: 'TABLET',
  });
}

function input(shop, med, extra = {}) {
  return {
    shopId: shop,
    medicineId: med.id,
    batchNo: 'AZ01',
    expiryDate: days(365),
    mrp: 23.5,
    quantity: 30,
    performedBy: adminId,
    ...extra,
  };
}

async function counts(shop) {
  const { rows: [r] } = await pool.query(
    `SELECT (SELECT count(*)::int FROM inventory WHERE shop_id = $1) AS inv,
            (SELECT coalesce(sum(quantity), 0)::int FROM inventory WHERE shop_id = $1) AS qty,
            (SELECT count(*)::int FROM stock_movements WHERE shop_id = $1) AS mov`,
    [shop]
  );
  return r;
}

t('stock-in writes inventory and a STOCK_IN movement together; a second stock-in reuses the batch', async () => {
  const shop = await newShop();
  const med = await newMedicine();
  const first = await stock.stockIn(input(shop, med, { batchNo: ' az01 ', manufactureDate: days(-30) }));
  assert.equal(first.batchCreated, true);
  assert.equal(first.batch.batchNo, 'AZ01');
  assert.deepEqual([first.inventory.quantity, first.inventory.reserved, first.inventory.version], [30, 0, 0]);
  assert.deepEqual([first.movement.type, first.movement.delta, first.movement.balanceAfter], ['STOCK_IN', 30, 30]);
  assert.equal(first.movement.inventoryId, first.inventory.id);

  const second = await stock.stockIn(input(shop, med, { quantity: 12 }));
  assert.equal(second.batchCreated, false);
  assert.equal(second.batch.id, first.batch.id);
  assert.deepEqual([second.inventory.quantity, second.inventory.version], [42, 1]);
  assert.equal(second.movement.balanceAfter, 42);
  assert.deepEqual(await counts(shop), { inv: 1, qty: 42, mov: 2 });
});

t('edge case 3: an expired batch (expiry today or earlier) → 422 BATCH_EXPIRED, nothing written', async () => {
  const shop = await newShop();
  const med = await newMedicine();
  for (const expiryDate of [days(0), days(-10)]) {
    await assert.rejects(stock.stockIn(input(shop, med, { batchNo: `OLD-${expiryDate}`, expiryDate })), (e) => {
      assert.equal(e.code, 'BATCH_EXPIRED');
      assert.equal(e.status, 422);
      return true;
    });
  }
  assert.deepEqual(await counts(shop), { inv: 0, qty: 0, mov: 0 });
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM medicine_batches WHERE medicine_id = $1', [med.id])).rows[0].n, 0);
});

t('edge case 15: a known batch number with a different expiry or MRP → 409 BATCH_MISMATCH, nothing written', async () => {
  const shop = await newShop();
  const med = await newMedicine();
  await stock.stockIn(input(shop, med));
  for (const extra of [{ expiryDate: days(400) }, { mrp: 24 }]) {
    await assert.rejects(stock.stockIn(input(shop, med, { batchNo: 'az01', ...extra })), (e) => {
      assert.equal(e.code, 'BATCH_MISMATCH');
      assert.equal(e.status, 409);
      assert.equal(e.details.known.mrp, 23.5);
      return true;
    });
  }
  assert.deepEqual(await counts(shop), { inv: 1, qty: 30, mov: 1 });
});

t('an inactive or unknown shop cannot receive stock', async () => {
  const shop = await newShop();
  const med = await newMedicine();
  await pool.query('UPDATE shops SET is_active = false WHERE id = $1', [shop]);
  await assert.rejects(stock.stockIn(input(shop, med)), (e) => e.code === 'SHOP_INACTIVE' && e.status === 409);
  await assert.rejects(stock.stockIn(input(2147483000, med)), (e) => e.code === 'NOT_FOUND');
  assert.deepEqual(await counts(shop), { inv: 0, qty: 0, mov: 0 });
});

t('a deactivated or unknown medicine cannot receive stock', async () => {
  const shop = await newShop();
  const med = await newMedicine();
  await medicines.setActive(med.id, false);
  await assert.rejects(stock.stockIn(input(shop, med)), (e) => e.code === 'MEDICINE_INACTIVE');
  await assert.rejects(stock.stockIn(input(shop, { id: 2147483000 })), (e) => e.code === 'NOT_FOUND');
});

t('validation lists every bad field', async () => {
  await assert.rejects(
    stock.stockIn({ shopId: 0, medicineId: 'x', quantity: 0, expiryDate: '2027-13-01', mrp: -1 }),
    (e) => {
      assert.equal(e.code, 'VALIDATION_ERROR');
      assert.deepEqual(e.details.map((d) => d.field), [
        'shopId', 'medicineId', 'performedBy', 'quantity', 'batchNo', 'expiryDate', 'mrp',
      ]);
      return true;
    }
  );
});

t('same idempotency key: replays the first result (even when racing); a different stock-in with it → 422', async () => {
  const shop = await newShop();
  const med = await newMedicine();
  const key = `si-${uniq()}`;
  const runs = await Promise.all([1, 2, 3, 4].map(() => stock.stockIn(input(shop, med, { idempotencyKey: key }))));
  assert.equal(runs.filter((r) => !r.replayed).length, 1);
  assert.equal(new Set(runs.map((r) => r.movement.id)).size, 1);
  assert.deepEqual(await counts(shop), { inv: 1, qty: 30, mov: 1 });

  await assert.rejects(
    stock.stockIn(input(shop, med, { idempotencyKey: key, quantity: 31 })),
    (e) => e.code === 'IDEMPOTENCY_KEY_REUSED'
  );
});

t('concurrent stock-ins of one batch never lose an update', async () => {
  const shop = await newShop();
  const med = await newMedicine();
  await Promise.all(Array.from({ length: 8 }, (_, i) => stock.stockIn(input(shop, med, { quantity: i + 1 }))));
  const c = await counts(shop);
  assert.deepEqual(c, { inv: 1, qty: 36, mov: 8 });
  const { rows } = await pool.query('SELECT balance_after FROM stock_movements WHERE shop_id = $1 ORDER BY balance_after', [shop]);
  assert.equal(rows.at(-1).balance_after, 36);
  assert.equal(new Set(rows.map((r) => r.balance_after)).size, 8); // every movement saw a distinct running balance
});

t('one transaction: if the movement insert fails, the inventory change is rolled back', async () => {
  const shop = await newShop();
  const med = await newMedicine();
  await stock.stockIn(input(shop, med));
  // performedBy that doesn't exist → the movement's FK fails after inventory was updated
  await assert.rejects(stock.stockIn(input(shop, med, { performedBy: 2147483000 })));
  assert.deepEqual(await counts(shop), { inv: 1, qty: 30, mov: 1 });
});

t('joins the caller transaction: rolling it back undoes the stock-in', async () => {
  const shop = await newShop();
  const med = await newMedicine();
  await assert.rejects(
    withTransaction(async (client) => {
      await stock.stockIn(input(shop, med), { client });
      throw new Error('caller failed');
    }),
    /caller failed/
  );
  assert.deepEqual(await counts(shop), { inv: 0, qty: 0, mov: 0 });
});

t('B6: inventory can only be written through stock.service', async () => {
  const shop = await newShop();
  const med = await newMedicine();
  const { inventory } = await stock.stockIn(input(shop, med));
  await assert.rejects(
    pool.query('UPDATE inventory SET quantity = 999 WHERE id = $1', [inventory.id]),
    /STOCK_WRITE_FORBIDDEN/
  );
  await assert.rejects(
    pool.query('INSERT INTO inventory (shop_id, batch_id, quantity) VALUES ($1, $2, 5)', [await newShop(), inventory.batchId]),
    /STOCK_WRITE_FORBIDDEN/
  );
  await assert.rejects(pool.query('DELETE FROM inventory WHERE id = $1', [inventory.id]), /DELETE_NOT_ALLOWED/);
});

t('B5: the ledger is append-only and the app role cannot update or delete it', async () => {
  const shop = await newShop();
  const med = await newMedicine();
  const { movement } = await stock.stockIn(input(shop, med));
  await assert.rejects(pool.query('UPDATE stock_movements SET delta = 1 WHERE id = $1', [movement.id]), /LEDGER_APPEND_ONLY/);
  await assert.rejects(pool.query('DELETE FROM stock_movements WHERE id = $1', [movement.id]), /LEDGER_APPEND_ONLY/);

  const { rows: [role] } = await pool.query(`SELECT 1 FROM pg_roles WHERE rolname = 'dosely_app'`);
  if (role) {
    const { rows: [p] } = await pool.query(`
      SELECT has_table_privilege('dosely_app', 'stock_movements', 'INSERT') AS ins,
             has_table_privilege('dosely_app', 'stock_movements', 'UPDATE') AS upd,
             has_table_privilege('dosely_app', 'stock_movements', 'DELETE') AS del`);
    assert.deepEqual(p, { ins: true, upd: false, del: false });
  }
});

t('ledger checks: delta sign must match the type; adjustments need a reason', async () => {
  const shop = await newShop();
  const med = await newMedicine();
  const { inventory } = await stock.stockIn(input(shop, med));
  const ins = `INSERT INTO stock_movements (type, shop_id, batch_id, inventory_id, delta, balance_after, reason, performed_by)
               VALUES ($1, $2, $3, $4, $5, 0, $6, $7)`;
  const args = (type, delta, reason = null) => [type, shop, inventory.batchId, inventory.id, delta, reason, adminId];
  await assert.rejects(pool.query(ins, args('DISPENSE', 5)), (e) => e.constraint === 'stock_movements_delta_sign');
  await assert.rejects(pool.query(ins, args('STOCK_IN', -5)), (e) => e.constraint === 'stock_movements_delta_sign');
  await assert.rejects(pool.query(ins, args('ADJUSTMENT', -1)), (e) => e.constraint === 'stock_movements_reason_required');
});

t('getAvailable: non-expired, unreserved units per shop, highest first', async () => {
  const med = await newMedicine();
  const [a, b] = [await newShop(), await newShop()];
  await stock.stockIn(input(a, med, { quantity: 5 }));
  await stock.stockIn(input(b, med, { quantity: 9 }));
  await stock.stockIn(input(b, med, { batchNo: 'AZ02', expiryDate: days(30), quantity: 1 }));

  // an old batch that has since expired, put in directly as if received last year
  await withTransaction(async (client) => {
    const { rows: [old] } = await client.query(
      `INSERT INTO medicine_batches (medicine_id, batch_no, expiry_date, mrp) VALUES ($1, 'AZ-OLD', $2, 20) RETURNING id`,
      [med.id, days(-1)]
    );
    await client.query(`SELECT set_config('dosely.stock_writer', 'on', true)`);
    await client.query('INSERT INTO inventory (shop_id, batch_id, quantity) VALUES ($1, $2, 100)', [a, old.id]);
  });

  const all = await stock.getAvailable(med.id);
  assert.deepEqual(all.map((r) => [r.shopId, r.available, r.nearestExpiry]), [[b, 10, days(30)], [a, 5, days(365)]]);
  assert.deepEqual((await stock.getAvailable(med.id, { shopIds: [a] })).map((r) => r.shopId), [a]);
  await pool.query('UPDATE shops SET is_active = false WHERE id = $1', [b]);
  assert.deepEqual((await stock.getAvailable(med.id)).map((r) => r.shopId), [a]);
  await assert.rejects(stock.getAvailable(med.id, { shopIds: ['1'] }), (e) => e.code === 'VALIDATION_ERROR');
});

t('HTTP: POST /shops/:shopId/stock-in needs an Idempotency-Key and replays it', async () => {
  const login = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@dosely.dev', password: PASSWORD }),
  }).then((r) => r.json());
  const med = await newMedicine();
  const shop = await newShop();
  const body = { medicineId: med.id, batchNo: 'H1', expiryDate: days(200), mrp: 10, quantity: 7 };
  const post = (key, b = body) => fetch(`${base}/shops/${shop}/stock-in`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${login.token}`, ...(key ? { 'idempotency-key': key } : {}) },
    body: JSON.stringify(b),
  });

  assert.equal((await (await post()).json()).error.code, 'IDEMPOTENCY_KEY_REQUIRED');
  const key = `h-${uniq()}`;
  const r1 = await post(key);
  assert.equal(r1.status, 201);
  const j1 = await r1.json();
  assert.equal(j1.inventory.quantity, 7);
  const r2 = await post(key);
  assert.equal(r2.headers.get('idempotent-replayed'), 'true');
  assert.equal((await r2.json()).movement.id, j1.movement.id);

  const expired = await post(`h-${uniq()}`, { ...body, batchNo: 'H0', expiryDate: days(-1) });
  assert.equal(expired.status, 422);
  assert.deepEqual(await counts(shop), { inv: 1, qty: 7, mov: 1 });
});

t('HTTP: shop staff can stock in at their own shop; other users get 403', async () => {
  const token = async (email) => (await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  }).then((r) => r.json())).token;
  const { rows: [jay] } = await pool.query(`SELECT id FROM shops WHERE code = 'DSL-JAY-01'`);
  const med = await newMedicine();
  const post = (tok, shop, batchNo) => fetch(`${base}/shops/${shop}/stock-in`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}`, 'idempotency-key': `s-${uniq()}` },
    body: JSON.stringify({ medicineId: med.id, batchNo, expiryDate: days(200), mrp: 10, quantity: 3 }),
  });

  assert.equal((await post(await token('shopkeeper@dosely.dev'), jay.id, 'S1')).status, 201); // OWNER
  assert.equal((await post(await token('staff@dosely.dev'), jay.id, 'S1')).status, 201);      // STAFF
  const doc = await post(await token('doctor@dosely.dev'), jay.id, 'S1');
  assert.equal(doc.status, 403);
  assert.equal((await doc.json()).error.code, 'NOT_SHOP_STAFF');
  const other = await post(await token('shopkeeper@dosely.dev'), await newShop(), 'S1');
  assert.equal(other.status, 403);
  assert.deepEqual(await stock.getAvailable(med.id, { shopIds: [jay.id] }), [
    { shopId: jay.id, medicineId: med.id, available: 6, nearestExpiry: days(200) },
  ]);
});

t('reserve holds stock FEFO across batches without a movement row; release gives it back, never below 0', async () => {
  const shop = await newShop();
  const med = await newMedicine();
  await stock.stockIn(input(shop, med, { batchNo: 'LATE', expiryDate: days(300), quantity: 10 }));
  await stock.stockIn(input(shop, med, { batchNo: 'SOON', expiryDate: days(40), quantity: 4 }));
  const before = await counts(shop);

  const r = await stock.reserve({ shopId: shop, medicineId: med.id, quantity: 6, referralId: 1, performedBy: adminId });
  assert.deepEqual(r.lines.map((l) => [l.batchNo, l.quantity]), [['SOON', 4], ['LATE', 2]]);
  assert.deepEqual(await counts(shop), before); // quantity unchanged, no movement
  assert.equal((await stock.getAvailable(med.id))[0].available, 8);

  await assert.rejects(
    stock.reserve({ shopId: shop, medicineId: med.id, quantity: 9, referralId: 2, performedBy: adminId }),
    (e) => e.code === 'INSUFFICIENT_STOCK' && e.details.available === 8
  );

  const rel = await stock.release({ shopId: shop, referralId: 1, lines: r.lines, performedBy: adminId });
  assert.equal(rel.released, 6);
  const again = await stock.release({ shopId: shop, referralId: 1, lines: r.lines, performedBy: adminId });
  assert.equal(again.released, 0);
  assert.equal((await stock.getAvailable(med.id))[0].available, 14);
});

t('two referrals racing for the last units: one reserve wins, the other gets 409', async () => {
  const shop = await newShop();
  const med = await newMedicine();
  await stock.stockIn(input(shop, med, { quantity: 5 }));
  const results = await Promise.allSettled([1, 2].map((ref) =>
    stock.reserve({ shopId: shop, medicineId: med.id, quantity: 5, referralId: ref, performedBy: adminId })));
  assert.equal(results.filter((x) => x.status === 'fulfilled').length, 1);
  assert.equal(results.find((x) => x.status === 'rejected').reason.code, 'INSUFFICIENT_STOCK');
  const { rows: [inv] } = await pool.query('SELECT quantity, reserved FROM inventory WHERE shop_id = $1', [shop]);
  assert.deepEqual(inv, { quantity: 5, reserved: 5 });
});

t('reserve joins the caller transaction and rolls back with it', async () => {
  const shop = await newShop();
  const med = await newMedicine();
  await stock.stockIn(input(shop, med, { quantity: 5 }));
  await assert.rejects(withTransaction(async (client) => {
    await stock.reserve({ shopId: shop, medicineId: med.id, quantity: 3, referralId: 9, performedBy: adminId }, { client });
    throw new Error('referral accept failed');
  }), /referral accept failed/);
  assert.equal((await stock.getAvailable(med.id))[0].available, 5);
});
