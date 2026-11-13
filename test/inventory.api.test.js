'use strict';

/**
 * Commit 5: inventory list with expiring / expired filters and versions,
 * the STALE_INVENTORY round trip over HTTP, movement history, the
 * availability route (B10), and a referral-accept-style reserve that
 * commits or rolls back with the caller's transaction.
 * Needs PostgreSQL (DATABASE_URL); skipped when unreachable.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../src/db/pool');
const migrate = require('../src/db/migrate');
const seeds = require('../src/db/seed');
const { withTransaction } = require('../src/db/transaction');
const { createApp } = require('../src/app');
const stock = require('../src/modules/inventory/stock.service');
const f = require('./helpers/stockFixtures');

const PASSWORD = process.env.SEED_PASSWORD || 'Dosely@123';
let dbUp = false;
let server;
let base;
let tok = {};
let jay;

async function api(method, path, { token, body, idem } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (idem !== false && method !== 'GET') headers['idempotency-key'] = `i-${f.uniq()}`;
  const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

test.before(async () => {
  try {
    await pool.query('SELECT 1');
    dbUp = true;
  } catch (err) {
    console.warn('[inventory.api.test] skipping:', err.message);
    return;
  }
  await migrate.up({ log: () => {} });
  await seeds.run({ log: () => {} });
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  for (const [k, email] of [['owner', 'shopkeeper@dosely.dev'], ['staff', 'staff@dosely.dev'], ['otherOwner', 'owner.kor@dosely.dev'], ['doctor', 'doctor@dosely.dev']]) {
    tok[k] = (await api('POST', '/auth/login', { body: { email, password: PASSWORD }, idem: false })).body.token;
  }
  jay = (await pool.query(`SELECT id FROM shops WHERE code = 'DSL-JAY-01'`)).rows[0].id;
});

test.after(async () => {
  if (server) server.close();
  await pool.end();
});

const t = (name, fn) => test(name, async (ctx) => (dbUp ? fn(ctx) : ctx.skip('no database')));

t('inventory list: one row per batch, earliest expiry first, with version; expiring / expired filters', async () => {
  const med = await f.newMedicine();
  await f.putStock(jay, med.id, 10, { batchNo: 'FAR', expiryDays: 300 });
  await f.putStock(jay, med.id, 4, { batchNo: 'NEAR', expiryDays: 30 });
  await f.putExpiredStock(jay, med.id, 7, { batchNo: 'GONE' });
  const { batch: empty } = await f.putStock(jay, med.id, 2, { batchNo: 'EMPTY', expiryDays: 200 });
  await stock.writeOff({ shopId: jay, batchId: empty.id, reason: 'damaged', performedBy: await f.adminId() });

  const all = await api('GET', `/shops/${jay}/inventory?medicineId=${med.id}`, { token: tok.staff });
  assert.equal(all.status, 200);
  assert.deepEqual(all.body.items.map((r) => [r.batch.batchNo, r.quantity, r.available]), [
    ['GONE', 7, 0], ['NEAR', 4, 4], ['FAR', 10, 10], // EMPTY (0 units) hidden
  ]);
  assert.ok(all.body.items.every((r) => Number.isInteger(r.version)));
  assert.equal(all.body.items[0].batch.isExpired, true);

  const withEmpty = await api('GET', `/shops/${jay}/inventory?medicineId=${med.id}&includeEmpty=true`, { token: tok.staff });
  assert.equal(withEmpty.body.total, 4);

  const expiring = await api('GET', `/shops/${jay}/inventory?medicineId=${med.id}&expiring=90`, { token: tok.staff });
  assert.deepEqual(expiring.body.items.map((r) => [r.batch.batchNo, r.batch.daysToExpiry]), [['NEAR', 30]]);

  const expired = await api('GET', `/shops/${jay}/inventory?medicineId=${med.id}&expired=true`, { token: tok.staff });
  assert.deepEqual(expired.body.items.map((r) => r.batch.batchNo), ['GONE']);

  const byName = await api('GET', `/shops/${jay}/inventory?q=${encodeURIComponent(med.generic.name)}`, { token: tok.staff });
  assert.equal(byName.body.total, 3);
});

t('STALE_INVENTORY round trip: read version → adjust → adjusting again with the old version is refused', async () => {
  const med = await f.newMedicine();
  await f.putStock(jay, med.id, 10);
  const [row] = (await api('GET', `/shops/${jay}/inventory?medicineId=${med.id}`, { token: tok.owner })).body.items;

  const body = { batchId: row.batch.id, delta: -1, expectedVersion: row.version, reason: 'recount' };
  const first = await api('POST', `/shops/${jay}/adjustments`, { token: tok.owner, body });
  assert.equal(first.status, 201);
  const second = await api('POST', `/shops/${jay}/adjustments`, { token: tok.owner, body: { ...body, delta: -2 } });
  assert.equal(second.status, 409);
  assert.equal(second.body.error.code, 'STALE_INVENTORY');
  assert.equal(second.body.error.details.currentVersion, row.version + 1);

  const [fresh] = (await api('GET', `/shops/${jay}/inventory?medicineId=${med.id}`, { token: tok.owner })).body.items;
  assert.equal(fresh.quantity, 9);
  const third = await api('POST', `/shops/${jay}/adjustments`, { token: tok.owner, body: { ...body, delta: -2, expectedVersion: fresh.version } });
  assert.equal(third.status, 201);
  assert.equal(third.body.inventory.quantity, 7);
});

t('movement history: newest first, filter by type, with batch and medicine names', async () => {
  const med = await f.newMedicine();
  await f.putStock(jay, med.id, 10);
  await api('POST', `/shops/${jay}/dispense`, { token: tok.staff, body: { medicineId: med.id, quantity: 3 } });
  const r = await api('GET', `/shops/${jay}/movements?medicineId=${med.id}`, { token: tok.staff });
  assert.deepEqual(r.body.items.map((m) => [m.type, m.delta, m.balanceAfter]), [['DISPENSE', -3, 7], ['STOCK_IN', 10, 10]]);
  assert.equal(r.body.items[0].medicine.brandName, med.brandName);
  const onlyIn = await api('GET', `/shops/${jay}/movements?medicineId=${med.id}&type=STOCK_IN`, { token: tok.staff });
  assert.equal(onlyIn.body.total, 1);
});

t('another shop’s staff and non-staff cannot read a shop’s stock', async () => {
  assert.equal((await api('GET', `/shops/${jay}/inventory`, { token: tok.otherOwner })).status, 403);
  assert.equal((await api('GET', `/shops/${jay}/movements`, { token: tok.doctor })).status, 403);
});

t('availability route (B10): units per active shop, for any logged-in user', async () => {
  const med = await f.newMedicine();
  const other = await f.newShop();
  await f.putStock(jay, med.id, 6);
  await f.putStock(other, med.id, 9);
  const r = await api('GET', `/medicines/${med.id}/availability`, { token: tok.doctor });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.items.map((x) => [x.shopId, x.available]), [[other, 9], [jay, 6]]);
  const one = await api('GET', `/medicines/${med.id}/availability?shopIds=${jay}`, { token: tok.doctor });
  assert.deepEqual(one.body.items.map((x) => x.shopId), [jay]);
  assert.equal((await api('GET', `/medicines/${med.id}/availability?shopIds=a,b`, { token: tok.doctor })).status, 400);
});

t('referral accept pattern: reserve inside the caller transaction commits or rolls back with it', async () => {
  const med = await f.newMedicine();
  const shop = await f.newShop();
  await f.putStock(shop, med.id, 5);
  const admin = await f.adminId();

  const lines = await withTransaction(async (client) => {
    const r = await stock.reserve({ shopId: shop, medicineId: med.id, quantity: 3, referralId: 11, performedBy: admin }, { client });
    return r.lines;
  });
  assert.equal((await stock.getAvailable(med.id))[0].available, 2);

  await assert.rejects(withTransaction(async (client) => {
    await stock.reserve({ shopId: shop, medicineId: med.id, quantity: 2, referralId: 12, performedBy: admin }, { client });
    throw new Error('accept failed after reserving');
  }), /accept failed/);
  assert.equal((await stock.getAvailable(med.id))[0].available, 2);

  await stock.release({ shopId: shop, referralId: 11, lines, performedBy: admin });
  assert.equal((await stock.getAvailable(med.id))[0].available, 5);
});
