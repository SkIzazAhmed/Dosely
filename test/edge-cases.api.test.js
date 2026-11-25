'use strict';

/**
 * Commit 7: the PRD's edge cases for catalog and stock, end to end over the
 * HTTP API with real users, shops and notifications.
 *
 *   3  expired or near-expiry stock
 *   5  deleting a medicine with stock
 *   6  concurrent dispensing
 *   14 low-stock alert spam
 *   15 batch number with a different expiry or price
 *
 * Needs PostgreSQL (DATABASE_URL); skipped when unreachable.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../src/db/pool');
const migrate = require('../src/db/migrate');
const seeds = require('../src/db/seed');
const { createApp } = require('../src/app');
const stock = require('../src/modules/inventory/stock.service');
const expiryScan = require('../src/jobs/expiryScan');
const lowStockScan = require('../src/jobs/lowStockScan');
const f = require('./helpers/stockFixtures');

const PASSWORD = process.env.SEED_PASSWORD || 'Dosely@123';
const quiet = { log: () => {} };
let dbUp = false;
let server;
let base;
let jay;
const tok = {};

async function api(method, path, token, body, { key = true } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (key && method !== 'GET') headers['idempotency-key'] = typeof key === 'string' ? key : `e-${f.uniq()}`;
  const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

test.before(async () => {
  try {
    await pool.query('SELECT 1');
    dbUp = true;
  } catch (err) {
    console.warn('[edge-cases.api.test] skipping:', err.message);
    return;
  }
  await migrate.up(quiet);
  await seeds.run(quiet);
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  for (const [k, email] of [['admin', 'admin@dosely.dev'], ['owner', 'shopkeeper@dosely.dev'], ['staff', 'staff@dosely.dev']]) {
    tok[k] = (await api('POST', '/auth/login', null, { email, password: PASSWORD }, { key: false })).body.token;
  }
  jay = (await pool.query(`SELECT id FROM shops WHERE code = 'DSL-JAY-01'`)).rows[0].id;
});

test.after(async () => {
  if (server) server.close();
  await pool.end();
});

const t = (name, fn) => test(name, async (ctx) => (dbUp ? fn(ctx) : ctx.skip('no database')));

/** Admin creates a medicine over the API. */
async function medicine(extra = {}) {
  const r = await api('POST', '/medicines', tok.admin, {
    brandName: `Edge ${f.uniq()}`, genericName: `Edgeamol-${f.uniq()}`, manufacturer: 'Edge Labs',
    dosageForm: 'TABLET', strength: '10 mg', baseUnit: 'TABLET', ...extra,
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
}

const stockIn = (med, batchNo, expiryDate, mrp, quantity) =>
  api('POST', `/shops/${jay}/stock-in`, tok.staff, { medicineId: med.id, batchNo, expiryDate, mrp, quantity });

async function notificationsFor(type, medicineId) {
  const { rows: [r] } = await pool.query(
    `SELECT count(*)::int AS n FROM notifications WHERE type = $1 AND data->>'medicineId' = $2`,
    [type, String(medicineId)]
  );
  return r.n;
}

t('edge case 3: expired stock is refused, never sold, flagged and alerted; near-expiry is listed and alerted', async () => {
  const med = await medicine();
  // expired on arrival → refused
  const late = await stockIn(med, 'X0', f.days(0), 4, 10);
  assert.equal(late.status, 422);
  assert.equal(late.body.error.code, 'BATCH_EXPIRED');

  // stock that expired on the shelf, plus a near-expiry and a long-dated batch
  await f.putExpiredStock(jay, med.id, 50, { batchNo: 'SHELF', expiryDays: -3 });
  assert.equal((await stockIn(med, 'NEAR', f.days(20), 4, 5)).status, 201);
  assert.equal((await stockIn(med, 'FAR', f.days(400), 4, 5)).status, 201);

  // availability and dispense ignore the expired 50
  const av = await api('GET', `/medicines/${med.id}/availability?shopIds=${jay}`, tok.staff);
  assert.equal(av.body.items[0].available, 10);
  const d = await api('POST', `/shops/${jay}/dispense`, tok.staff, { medicineId: med.id, quantity: 6 });
  assert.equal(d.status, 201);
  assert.deepEqual(d.body.lines.map((l) => [l.batchNo, l.quantity]), [['NEAR', 5], ['FAR', 1]]);
  const tooMuch = await api('POST', `/shops/${jay}/dispense`, tok.staff, { medicineId: med.id, quantity: 5 });
  assert.equal(tooMuch.status, 409);
  assert.equal(tooMuch.body.error.details.available, 4);

  // lists
  assert.equal((await api('GET', `/shops/${jay}/inventory?medicineId=${med.id}&expired=true`, tok.staff)).body.items[0].batch.batchNo, 'SHELF');
  const nearStock = await stockIn(med, 'NEAR2', f.days(45), 4, 3);
  assert.equal(nearStock.status, 201);
  const expiring = await api('GET', `/shops/${jay}/inventory?medicineId=${med.id}&expiring=90`, tok.staff);
  assert.deepEqual(expiring.body.items.map((r) => r.batch.batchNo), ['NEAR2']);

  // the daily scan: one reminder for NEAR2, one write-off request for SHELF, each once
  await expiryScan.run(quiet);
  await expiryScan.run(quiet);
  assert.ok(await notificationsFor('EXPIRY_ALERT', med.id) > 0);
  const expiredMsgs = await notificationsFor('BATCH_EXPIRED', med.id);
  assert.ok(expiredMsgs > 0);
  await expiryScan.run(quiet);
  assert.equal(await notificationsFor('BATCH_EXPIRED', med.id), expiredMsgs);

  // the owner writes the expired units off
  const shelf = (await api('GET', `/shops/${jay}/inventory?medicineId=${med.id}&expired=true`, tok.owner)).body.items[0];
  const w = await api('POST', `/shops/${jay}/write-offs`, tok.owner, { batchId: shelf.batch.id, reason: 'expired on shelf' });
  assert.equal(w.status, 201);
  assert.equal(w.body.movement.delta, -50);
});

t('edge case 5: a medicine with stock cannot be deleted; deactivating keeps its stock and history', async () => {
  const bare = await medicine();
  assert.equal((await api('DELETE', `/medicines/${bare.id}`, tok.admin)).status, 200);

  const med = await medicine();
  assert.equal((await stockIn(med, 'K1', f.days(200), 6, 12)).status, 201);
  const del = await api('DELETE', `/medicines/${med.id}`, tok.admin);
  assert.equal(del.status, 409);
  assert.equal(del.body.error.code, 'MEDICINE_IN_USE');

  assert.equal((await api('POST', `/medicines/${med.id}/deactivate`, tok.admin)).body.isActive, false);
  const inv = await api('GET', `/shops/${jay}/inventory?medicineId=${med.id}`, tok.staff);
  assert.equal(inv.body.items[0].quantity, 12);
  const mv = await api('GET', `/shops/${jay}/movements?medicineId=${med.id}`, tok.staff);
  assert.equal(mv.body.total, 1);
  // no new stock for a deactivated medicine
  const more = await stockIn(med, 'K1', f.days(200), 6, 1);
  assert.equal(more.body.error.code, 'MEDICINE_INACTIVE');
});

t('edge case 6: two staff dispensing the last units at the same moment — one 201, one 409, never below 0', async () => {
  const med = await medicine();
  await stockIn(med, 'L1', f.days(100), 3, 4);
  await stockIn(med, 'L2', f.days(50), 3, 4);
  const send = (token) => api('POST', `/shops/${jay}/dispense`, token, { medicineId: med.id, quantity: 8 });
  const [a, b] = await Promise.all([send(tok.staff), send(tok.owner)]);
  assert.deepEqual([a.status, b.status].sort(), [201, 409]);
  assert.equal([a, b].find((r) => r.status === 409).body.error.code, 'INSUFFICIENT_STOCK');

  const rows = (await api('GET', `/shops/${jay}/inventory?medicineId=${med.id}&includeEmpty=true`, tok.staff)).body.items;
  assert.deepEqual(rows.map((r) => r.quantity), [0, 0]);
  const mv = await api('GET', `/shops/${jay}/movements?medicineId=${med.id}&type=DISPENSE`, tok.staff);
  assert.equal(mv.body.total, 2); // one dispense across two batches

  // a retried request (same Idempotency-Key) doesn't dispense twice
  await stockIn(med, 'L3', f.days(300), 3, 10);
  const k = `retry-${f.uniq()}`;
  const r1 = await api('POST', `/shops/${jay}/dispense`, tok.staff, { medicineId: med.id, quantity: 2 }, { key: k });
  const r2 = await api('POST', `/shops/${jay}/dispense`, tok.staff, { medicineId: med.id, quantity: 2 }, { key: k });
  assert.equal(r1.status, 201);
  assert.equal(r2.body.lines[0].movementId, r1.body.lines[0].movementId);
  assert.equal((await api('GET', `/medicines/${med.id}/availability?shopIds=${jay}`, tok.staff)).body.items[0].available, 8);
});

t('edge case 14: falling below the threshold alerts the shop once that day, however many dispenses and scans follow', async () => {
  const med = await medicine();
  await stockIn(med, 'T1', f.days(300), 2, 30);
  assert.equal((await api('PUT', `/shops/${jay}/thresholds/${med.id}`, tok.owner, { minQuantity: 20 }, { key: false })).status, 200);

  for (const q of [5, 4]) await api('POST', `/shops/${jay}/dispense`, tok.staff, { medicineId: med.id, quantity: q }); // 21 left
  assert.equal(await notificationsFor('LOW_STOCK', med.id), 0);

  await api('POST', `/shops/${jay}/dispense`, tok.staff, { medicineId: med.id, quantity: 3 }); // 18 → low
  const first = await notificationsFor('LOW_STOCK', med.id);
  assert.ok(first > 0, 'the shop staff were told');

  for (let i = 0; i < 5; i += 1) await api('POST', `/shops/${jay}/dispense`, tok.staff, { medicineId: med.id, quantity: 1 });
  await lowStockScan.run(quiet);
  await lowStockScan.run(quiet);
  assert.equal(await notificationsFor('LOW_STOCK', med.id), first);

  const th = await api('GET', `/shops/${jay}/thresholds?low=true&limit=100`, tok.staff);
  assert.equal(th.body.items.find((x) => x.medicine.id === med.id).available, 13);
});

t('edge case 15: a known batch number with a different expiry or price is refused; a true repeat adds stock', async () => {
  const med = await medicine();
  const first = await stockIn(med, 'b-77', f.days(250), 12.5, 10);
  assert.equal(first.status, 201);
  assert.equal(first.body.batch.batchNo, 'B-77');

  const otherExpiry = await stockIn(med, 'B-77', f.days(260), 12.5, 10);
  assert.equal(otherExpiry.status, 409);
  assert.equal(otherExpiry.body.error.code, 'BATCH_MISMATCH');
  assert.deepEqual(otherExpiry.body.error.details.known, { expiryDate: f.days(250), mrp: 12.5 });

  const otherPrice = await stockIn(med, ' b-77 ', f.days(250), 13, 10);
  assert.equal(otherPrice.body.error.code, 'BATCH_MISMATCH');

  const repeat = await stockIn(med, 'B-77', f.days(250), 12.5, 5);
  assert.equal(repeat.status, 201);
  assert.equal(repeat.body.batch.id, first.body.batch.id);
  assert.equal(repeat.body.inventory.quantity, 15);

  // the catalog route applies the same rule
  const dup = await api('POST', `/medicines/${med.id}/batches`, tok.admin, { batchNo: 'b-77', expiryDate: f.days(250), mrp: 12.5 });
  assert.equal(dup.body.error.code, 'BATCH_NO_TAKEN');
});

t('long idempotency keys built by callers (e.g. request dispense) are accepted', async () => {
  const med = await medicine();
  await stockIn(med, 'K', f.days(300), 2, 5);
  const key = `request:123456:dispense:${f.uniq()}${'k'.repeat(247)}`; // 279 characters, new each run
  const r = await stock.dispense({ shopId: jay, medicineId: med.id, quantity: 1, performedBy: await f.adminId(), idempotencyKey: key });
  assert.equal(r.lines[0].quantity, 1);
  await assert.rejects(
    stock.dispense({ shopId: jay, medicineId: med.id, quantity: 1, performedBy: await f.adminId(), idempotencyKey: 'k'.repeat(513) }),
    (e) => e.code === 'VALIDATION_ERROR'
  );
});
