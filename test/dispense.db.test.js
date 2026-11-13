'use strict';

/**
 * Commit 4 "done when": two parallel dispenses of the last units — one
 * succeeds, one gets 409. Plus FEFO, idempotency, reservations (B8) and
 * owner adjustments / write-offs with version checks (B9), edge case 6.
 * Needs PostgreSQL (DATABASE_URL); skipped when unreachable.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../src/db/pool');
const migrate = require('../src/db/migrate');
const seeds = require('../src/db/seed');
const { createApp } = require('../src/app');
const stock = require('../src/modules/inventory/stock.service');
const f = require('./helpers/stockFixtures');

const PASSWORD = process.env.SEED_PASSWORD || 'Dosely@123';
let dbUp = false;
let admin;
let server;
let base;

test.before(async () => {
  try {
    await pool.query('SELECT 1');
    dbUp = true;
  } catch (err) {
    console.warn('[dispense.db.test] skipping:', err.message);
    return;
  }
  await migrate.up({ log: () => {} });
  await seeds.run({ log: () => {} });
  admin = await f.adminId();
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) server.close();
  await pool.end();
});

const t = (name, fn) => test(name, async (ctx) => (dbUp ? fn(ctx) : ctx.skip('no database')));
const key = () => `d-${f.uniq()}`;
const dispense = (shopId, medicineId, quantity, extra = {}) =>
  stock.dispense({ shopId, medicineId, quantity, performedBy: admin, idempotencyKey: key(), ...extra });

t('edge case 6: two parallel dispenses of the last units — one succeeds, one gets 409', async () => {
  const shop = await f.newShop();
  const med = await f.newMedicine();
  const { batch } = await f.putStock(shop, med.id, 5);
  const results = await Promise.allSettled([dispense(shop, med.id, 5), dispense(shop, med.id, 5)]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const lost = results.find((r) => r.status === 'rejected').reason;
  assert.equal(lost.code, 'INSUFFICIENT_STOCK');
  assert.equal(lost.status, 409);
  assert.deepEqual(await f.row(shop, batch.id), { quantity: 0, reserved: 0, version: 1 });
  assert.equal((await f.movements(shop, 'DISPENSE')).length, 1);
});

t('many small dispenses racing never oversell', async () => {
  const shop = await f.newShop();
  const med = await f.newMedicine();
  const { batch } = await f.putStock(shop, med.id, 7);
  const results = await Promise.allSettled(Array.from({ length: 12 }, () => dispense(shop, med.id, 1)));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 7);
  assert.ok(results.filter((r) => r.status === 'rejected').every((r) => r.reason.code === 'INSUFFICIENT_STOCK'));
  assert.equal((await f.row(shop, batch.id)).quantity, 0);
  const bal = (await f.movements(shop, 'DISPENSE')).map((m) => m.balance_after).sort((a, b) => a - b);
  assert.deepEqual(bal, [0, 1, 2, 3, 4, 5, 6]);
});

t('multi-batch dispenses racing each other do not deadlock', async () => {
  const shop = await f.newShop();
  const med = await f.newMedicine();
  await f.putStock(shop, med.id, 3, { batchNo: 'A', expiryDays: 100 });
  await f.putStock(shop, med.id, 3, { batchNo: 'B', expiryDays: 50 });
  await f.putStock(shop, med.id, 3, { batchNo: 'C', expiryDays: 200 });
  const results = await Promise.allSettled(Array.from({ length: 6 }, () => dispense(shop, med.id, 2)));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 4); // 9 units → 4 × 2, 1 left
  assert.equal((await stock.getAvailable(med.id, { shopIds: [shop] }))[0].available, 1);
});

t('FEFO: earliest expiry first, across batches, skipping expired and reserved units', async () => {
  const shop = await f.newShop();
  const med = await f.newMedicine();
  await f.putExpiredStock(shop, med.id, 50);
  await f.putStock(shop, med.id, 10, { batchNo: 'LATE', expiryDays: 300 });
  await f.putStock(shop, med.id, 4, { batchNo: 'SOON', expiryDays: 20 });
  await f.putStock(shop, med.id, 5, { batchNo: 'MID', expiryDays: 90 });
  await stock.reserve({ shopId: shop, medicineId: med.id, quantity: 3, referralId: 1, performedBy: admin }); // holds 3 of SOON

  const r = await dispense(shop, med.id, 8, { requestId: 42 });
  assert.deepEqual(r.lines.map((l) => [l.batchNo, l.quantity]), [['SOON', 1], ['MID', 5], ['LATE', 2]]);
  const mv = await f.movements(shop, 'DISPENSE');
  assert.equal(mv.length, 3);
  assert.ok(mv.every((m) => m.delta < 0));

  await assert.rejects(dispense(shop, med.id, 9), (e) => {
    assert.equal(e.code, 'INSUFFICIENT_STOCK');
    assert.equal(e.details.available, 8); // 8 LATE left; 3 reserved and 50 expired don't count
    return true;
  });
});

t('idempotency key: the same dispense twice (even racing) happens once; reusing it differently → 422', async () => {
  const shop = await f.newShop();
  const med = await f.newMedicine();
  await f.putStock(shop, med.id, 10, { batchNo: 'A', expiryDays: 30 });
  await f.putStock(shop, med.id, 10, { batchNo: 'B', expiryDays: 60 });
  const k = key();
  const runs = await Promise.all([1, 2, 3].map(() => dispense(shop, med.id, 12, { idempotencyKey: k })));
  assert.equal(runs.filter((r) => !r.replayed).length, 1);
  assert.deepEqual(runs[0].lines, runs[2].lines);
  assert.equal((await f.movements(shop, 'DISPENSE')).length, 2); // 10 from A + 2 from B, once
  assert.equal((await stock.getAvailable(med.id))[0].available, 8);

  await assert.rejects(dispense(shop, med.id, 3, { idempotencyKey: k }), (e) => e.code === 'IDEMPOTENCY_KEY_REUSED');
  await assert.rejects(
    stock.dispense({ shopId: shop, medicineId: med.id, quantity: 1, performedBy: admin }),
    (e) => e.code === 'VALIDATION_ERROR' && e.details[0].field === 'idempotencyKey'
  );
});

t('dispense with a reservation takes exactly the held units and clears the hold', async () => {
  const shop = await f.newShop();
  const med = await f.newMedicine();
  const { batch } = await f.putStock(shop, med.id, 6);
  const held = await stock.reserve({ shopId: shop, medicineId: med.id, quantity: 4, referralId: 77, performedBy: admin });

  // walk-in customers can't take held units
  await assert.rejects(dispense(shop, med.id, 3), (e) => e.code === 'INSUFFICIENT_STOCK');

  const r = await dispense(shop, med.id, 4, { referralId: 77, reservation: held.lines });
  assert.equal(r.lines[0].quantity, 4);
  assert.deepEqual(await f.row(shop, batch.id), { quantity: 2, reserved: 0, version: 2 });

  // the same hold can't be dispensed twice under a new key
  await assert.rejects(dispense(shop, med.id, 4, { reservation: held.lines }), (e) => e.code === 'INSUFFICIENT_STOCK');
  await assert.rejects(
    dispense(shop, med.id, 5, { reservation: held.lines }),
    (e) => e.code === 'VALIDATION_ERROR' && e.details[0].field === 'reservation'
  );
});

t('inactive shop cannot dispense', async () => {
  const shop = await f.newShop();
  const med = await f.newMedicine();
  await f.putStock(shop, med.id, 5);
  await pool.query('UPDATE shops SET is_active = false WHERE id = $1', [shop]);
  await assert.rejects(dispense(shop, med.id, 1), (e) => e.code === 'SHOP_INACTIVE');
});

t('B9 adjust: needs a reason and the version you read; can’t go below reserved', async () => {
  const shop = await f.newShop();
  const med = await f.newMedicine();
  const { batch, inventory } = await f.putStock(shop, med.id, 10);
  const base = { shopId: shop, batchId: batch.id, performedBy: admin };

  await assert.rejects(stock.adjust({ ...base, delta: -2, expectedVersion: inventory.version }), (e) => e.code === 'REASON_REQUIRED');
  await assert.rejects(stock.adjust({ ...base, delta: -2, reason: 'recount' }), (e) => e.code === 'VALIDATION_ERROR');

  const ok = await stock.adjust({ ...base, delta: -2, expectedVersion: inventory.version, reason: 'recount: 2 strips missing' });
  assert.deepEqual([ok.inventory.quantity, ok.inventory.version], [8, inventory.version + 1]);
  assert.deepEqual([ok.movement.type, ok.movement.delta, ok.movement.reason], ['ADJUSTMENT', -2, 'recount: 2 strips missing']);

  // someone else changed the row since we read version 0
  await assert.rejects(stock.adjust({ ...base, delta: 1, expectedVersion: inventory.version, reason: 'recount' }), (e) => {
    assert.equal(e.code, 'STALE_INVENTORY');
    assert.equal(e.details.currentVersion, inventory.version + 1);
    return true;
  });

  await stock.reserve({ shopId: shop, medicineId: med.id, quantity: 6, referralId: 5, performedBy: admin });
  const v = (await f.row(shop, batch.id)).version;
  await assert.rejects(stock.adjust({ ...base, delta: -3, expectedVersion: v, reason: 'recount' }), (e) => e.code === 'INSUFFICIENT_STOCK');
  await assert.rejects(stock.adjust({ ...base, shopId: await f.newShop(), delta: 1, expectedVersion: 0, reason: 'recount' }), (e) => e.code === 'NOT_FOUND');
});

t('B9 writeOff: all unreserved units by default, needs a reason, optional version check', async () => {
  const shop = await f.newShop();
  const med = await f.newMedicine();
  const { batch } = await f.putStock(shop, med.id, 10);
  await stock.reserve({ shopId: shop, medicineId: med.id, quantity: 4, referralId: 5, performedBy: admin });
  const base = { shopId: shop, batchId: batch.id, performedBy: admin };

  await assert.rejects(stock.writeOff({ ...base }), (e) => e.code === 'REASON_REQUIRED');
  await assert.rejects(stock.writeOff({ ...base, expectedVersion: 0, reason: 'water damage' }), (e) => e.code === 'STALE_INVENTORY');
  await assert.rejects(stock.writeOff({ ...base, quantity: 7, reason: 'water damage' }), (e) => e.code === 'INSUFFICIENT_STOCK');

  const r = await stock.writeOff({ ...base, reason: 'water damage' });
  assert.deepEqual([r.movement.type, r.movement.delta, r.inventory.quantity, r.inventory.reserved], ['EXPIRY_WRITE_OFF', -6, 4, 4]);
});

t('expired stock can be written off; idempotency key replays', async () => {
  const shop = await f.newShop();
  const med = await f.newMedicine();
  const oldBatch = await f.putExpiredStock(shop, med.id, 12);
  const k = key();
  const a = await stock.writeOff({ shopId: shop, batchId: oldBatch, reason: 'expired', performedBy: admin, idempotencyKey: k });
  const b = await stock.writeOff({ shopId: shop, batchId: oldBatch, reason: 'expired', performedBy: admin, idempotencyKey: k });
  assert.equal(b.replayed, true);
  assert.equal(b.movement.id, a.movement.id);
  assert.deepEqual(await f.row(shop, oldBatch), { quantity: 0, reserved: 0, version: 1 });
});

t('HTTP: staff dispense; only the owner adjusts or writes off', async () => {
  const login = async (email) => (await fetch(`${base}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }),
  }).then((r) => r.json())).token;
  const { rows: [jay] } = await pool.query(`SELECT id FROM shops WHERE code = 'DSL-JAY-01'`);
  const med = await f.newMedicine();
  const { batch, inventory } = await f.putStock(jay.id, med.id, 10);
  const [ownerTok, staffTok] = [await login('shopkeeper@dosely.dev'), await login('staff@dosely.dev')];
  const post = (tok, path, body) => fetch(`${base}/shops/${jay.id}/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}`, 'idempotency-key': key() },
    body: JSON.stringify(body),
  });

  const d = await post(staffTok, 'dispense', { medicineId: med.id, quantity: 3 });
  assert.equal(d.status, 201);
  assert.equal((await d.json()).lines[0].balanceAfter, 7);

  const adjBody = { batchId: batch.id, delta: -1, expectedVersion: inventory.version + 1, reason: 'recount' };
  const denied = await post(staffTok, 'adjustments', adjBody);
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).error.code, 'NOT_SHOP_OWNER');
  assert.equal((await post(ownerTok, 'adjustments', adjBody)).status, 201);

  const stale = await post(ownerTok, 'adjustments', adjBody);
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error.code, 'STALE_INVENTORY');

  assert.equal((await post(staffTok, 'write-offs', { batchId: batch.id, reason: 'damaged' })).status, 403);
  const w = await post(ownerTok, 'write-offs', { batchId: batch.id, quantity: 2, reason: 'damaged strip' });
  assert.equal(w.status, 201);
  assert.equal((await w.json()).inventory.quantity, 4);
});

t('same key racing on an adjustment replays instead of failing with STALE_INVENTORY', async () => {
  const shop = await f.newShop();
  const med = await f.newMedicine();
  const { batch, inventory } = await f.putStock(shop, med.id, 10);
  const input = { shopId: shop, batchId: batch.id, delta: 3, expectedVersion: inventory.version, reason: 'recount', performedBy: admin, idempotencyKey: key() };
  const runs = await Promise.all([1, 2, 3].map(() => stock.adjust(input)));
  assert.equal(runs.filter((r) => !r.replayed).length, 1);
  assert.equal((await f.row(shop, batch.id)).quantity, 13);
});
