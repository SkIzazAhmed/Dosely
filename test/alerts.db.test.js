'use strict';

/**
 * Commit 6 "done when": jobs send alerts through notification.service
 * without duplicates. Thresholds (B11), expiryScan / lowStockScan and the
 * post-dispense low-stock check (B12), edge cases 3 and 14, seed data.
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
const notifications = require('../src/modules/notifications/notification.service');
const expiryScan = require('../src/jobs/expiryScan');
const lowStockScan = require('../src/jobs/lowStockScan');
const scheduler = require('../src/jobs/scheduler');
const f = require('./helpers/stockFixtures');

const PASSWORD = process.env.SEED_PASSWORD || 'Dosely@123';
const quiet = { log: () => {} };
let dbUp = false;
let server;
let base;
let admin;
let sent = [];
let realNotifyShop;

test.before(async () => {
  try {
    await pool.query('SELECT 1');
    dbUp = true;
  } catch (err) {
    console.warn('[alerts.db.test] skipping:', err.message);
    return;
  }
  await migrate.up(quiet);
  await seeds.run(quiet);
  admin = await f.adminId();
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  // Record what reaches notification.service (still validated by the real function).
  realNotifyShop = notifications.notifyShop;
  notifications.notifyShop = (shopId, payload, opts) => {
    sent.push({ shopId, ...payload });
    return realNotifyShop(shopId, payload, opts);
  };
});

test.after(async () => {
  if (realNotifyShop) notifications.notifyShop = realNotifyShop;
  if (server) server.close();
  await pool.end();
});

const t = (name, fn) => test(name, async (ctx) => (dbUp ? fn(ctx) : ctx.skip('no database')));
const sentTo = (shop, type) => sent.filter((n) => n.shopId === shop && (!type || n.type === type));
const alertRows = async (shop, type) => (await pool.query(
  'SELECT alert_type, batch_id, period_key FROM stock_alerts WHERE shop_id = $1 AND alert_type = $2 ORDER BY id', [shop, type]
)).rows;
const dispense = (shopId, medicineId, quantity, opts) =>
  stock.dispense({ shopId, medicineId, quantity, performedBy: admin, idempotencyKey: `a-${f.uniq()}` }, opts);
const setThreshold = (shop, med, min) => pool.query(
  'INSERT INTO stock_thresholds (shop_id, medicine_id, min_quantity) VALUES ($1, $2, $3)', [shop, med, min]
);

t('edge case 14: a dispense below the threshold alerts once per day, however many dispenses follow', async () => {
  const shop = await f.newShop();
  const med = await f.newMedicine();
  await f.putStock(shop, med.id, 20);
  await setThreshold(shop, med.id, 10);

  await dispense(shop, med.id, 5); // 15 left, not low
  assert.equal(sentTo(shop).length, 0);
  await dispense(shop, med.id, 6); // 9 left → low
  await dispense(shop, med.id, 1); // 8 left
  await dispense(shop, med.id, 1); // 7 left
  const lows = sentTo(shop, 'LOW_STOCK');
  assert.equal(lows.length, 1);
  assert.match(lows[0].body, /Only 9 left \(reorder level 10\)/);
  assert.deepEqual(lows[0].channels, ['IN_APP']);
  assert.equal((await alertRows(shop, 'LOW_STOCK')).length, 1);

  // the daily scan finds it low but has already alerted today
  await lowStockScan.run(quiet);
  assert.equal(sentTo(shop, 'LOW_STOCK').length, 1);
});

t('no threshold, no alert; a rolled-back dispense leaves no alert behind', async () => {
  const shop = await f.newShop();
  const med = await f.newMedicine();
  await f.putStock(shop, med.id, 5);
  await dispense(shop, med.id, 4);
  assert.equal((await alertRows(shop, 'LOW_STOCK')).length, 0);

  await setThreshold(shop, med.id, 3);
  await assert.rejects(withTransaction(async (client) => {
    await dispense(shop, med.id, 1, { client }); // would alert
    throw new Error('caller failed');
  }), /caller failed/);
  assert.equal((await alertRows(shop, 'LOW_STOCK')).length, 0);
});

t('lowStockScan: alerts each low shop + medicine once a day; ignores healthy stock and inactive shops', async () => {
  const [low, ok, closed] = [await f.newShop(), await f.newShop(), await f.newShop()];
  const med = await f.newMedicine();
  await f.putStock(low, med.id, 4);
  await f.putStock(ok, med.id, 40);
  await f.putExpiredStock(low, med.id, 500); // expired units don't count towards stock
  for (const s of [low, ok, closed]) await setThreshold(s, med.id, 10);
  await pool.query('UPDATE shops SET is_active = false WHERE id = $1', [closed]);

  await lowStockScan.run(quiet);
  await lowStockScan.run(quiet);
  assert.equal(sentTo(low, 'LOW_STOCK').length, 1);
  assert.equal(sentTo(ok).length, 0);
  assert.equal(sentTo(closed).length, 0);
  const [row] = await alertRows(low, 'LOW_STOCK');
  assert.match(row.period_key, /^\d{4}-\d{2}-\d{2}$/);
});

t('expiryScan: expiring within 90 days alerts once a week; expired batches flagged and alerted once', async () => {
  const shop = await f.newShop();
  const med = await f.newMedicine();
  const { batch: soon } = await f.putStock(shop, med.id, 8, { batchNo: 'SOON', expiryDays: 30 });
  await f.putStock(shop, med.id, 8, { batchNo: 'LATER', expiryDays: 120 });
  const old = await f.putExpiredStock(shop, med.id, 3, { batchNo: 'GONE', expiryDays: -2 });

  await expiryScan.run(quiet);
  await expiryScan.run(quiet);

  const exp = sentTo(shop, 'EXPIRY_ALERT');
  assert.equal(exp.length, 1);
  assert.equal(exp[0].data.batchId, soon.id);
  assert.match(exp[0].title, /^Expiring in 30 days/);
  assert.match((await alertRows(shop, 'EXPIRY_ALERT'))[0].period_key, /^\d{4}-W\d{2}$/);

  const gone = sentTo(shop, 'BATCH_EXPIRED');
  assert.equal(gone.length, 1);
  assert.equal(gone[0].data.batchId, old);
  assert.match(gone[0].body, /Write them off/);
  const { rows: [flag] } = await pool.query('SELECT expired_flagged_at FROM medicine_batches WHERE id = $1', [old]);
  assert.ok(flag.expired_flagged_at);

  // once written off, nothing more to say about it
  await stock.writeOff({ shopId: shop, batchId: old, reason: 'expired', performedBy: admin });
  await expiryScan.run(quiet);
  assert.equal(sentTo(shop, 'BATCH_EXPIRED').length, 1);
});

t('expiryScan: a new week means a new reminder (period key changes)', async () => {
  const shop = await f.newShop();
  const med = await f.newMedicine();
  const { batch } = await f.putStock(shop, med.id, 8, { batchNo: 'SOON', expiryDays: 10 });
  await expiryScan.run(quiet);
  // pretend last week's alert was the one on record
  await pool.query(`UPDATE stock_alerts SET period_key = '2000-W01' WHERE shop_id = $1 AND batch_id = $2`, [shop, batch.id]);
  await expiryScan.run(quiet);
  assert.equal(sentTo(shop, 'EXPIRY_ALERT').length, 2);
});

t('thresholds API: owner sets and removes; staff read; low filters on thresholds and inventory', async () => {
  const login = async (email) => (await fetch(`${base}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }),
  }).then((r) => r.json())).token;
  const [ownerTok, staffTok] = [await login('shopkeeper@dosely.dev'), await login('staff@dosely.dev')];
  const { rows: [jay] } = await pool.query(`SELECT id FROM shops WHERE code = 'DSL-JAY-01'`);
  const call = (method, path, tok, body) => fetch(`${base}/shops/${jay.id}${path}`, {
    method, headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const med = await f.newMedicine();
  await f.putStock(jay.id, med.id, 6);

  assert.equal((await call('PUT', `/thresholds/${med.id}`, staffTok, { minQuantity: 10 })).status, 403);
  const put = await call('PUT', `/thresholds/${med.id}`, ownerTok, { minQuantity: 10 });
  assert.equal(put.status, 200);
  const th = await put.json();
  assert.deepEqual([th.minQuantity, th.available, th.isLow], [10, 6, true]);
  assert.equal((await call('PUT', `/thresholds/${med.id}`, ownerTok, { minQuantity: 0 })).status, 400);
  assert.equal((await call('PUT', '/thresholds/2147483000', ownerTok, { minQuantity: 5 })).status, 404);

  const lowList = await (await call('GET', '/thresholds?low=true&limit=100', staffTok)).json();
  assert.ok(lowList.items.some((x) => x.medicine.id === med.id));
  const inv = await (await call('GET', `/inventory?low=true&medicineId=${med.id}`, staffTok)).json();
  assert.equal(inv.total, 1);

  await call('PUT', `/thresholds/${med.id}`, ownerTok, { minQuantity: 5 });
  const inv2 = await (await call('GET', `/inventory?low=true&medicineId=${med.id}`, staffTok)).json();
  assert.equal(inv2.total, 0);

  assert.equal((await call('DELETE', `/thresholds/${med.id}`, ownerTok)).status, 200);
  assert.equal((await call('DELETE', `/thresholds/${med.id}`, ownerTok)).status, 404);
});

t('seed data: re-running adds nothing; Dolo 650 is low at Jayanagar', async () => {
  const count = async () => (await pool.query(`SELECT count(*)::int AS n FROM stock_movements WHERE idempotency_key LIKE 'seed:%'`)).rows[0].n;
  const before = await count();
  await seeds.run(quiet);
  assert.equal(await count(), before);

  const { rows: [dolo] } = await pool.query(
    `SELECT t.min_quantity FROM stock_thresholds t JOIN medicines m ON m.id = t.medicine_id
       JOIN shops s ON s.id = t.shop_id WHERE s.code = 'DSL-JAY-01' AND m.brand_name = 'Dolo 650'`
  );
  assert.equal(dolo.min_quantity, 100);
  const { rows: [m] } = await pool.query(`SELECT id FROM medicines WHERE brand_name = 'Dolo 650'`);
  const { rows: [s] } = await pool.query(`SELECT id FROM shops WHERE code = 'DSL-JAY-01'`);
  const [avail] = await stock.getAvailable(m.id, { shopIds: [s.id] });
  assert.ok(avail.available < 100, 'seeded Dolo 650 is below its threshold at Jayanagar');
});

test('scheduler runs daily at 06:00 India time', () => {
  const at = (iso) => Date.parse(iso);
  assert.equal(scheduler.msUntilNextRun(at('2026-11-13T21:00:00Z')) / 3600000, 3.5);  // 02:30 IST → 06:00
  assert.equal(scheduler.msUntilNextRun(at('2026-11-14T00:30:00Z')) / 3600000, 24);   // exactly 06:00 IST → next day
  assert.equal(scheduler.msUntilNextRun(at('2026-11-14T02:30:00Z')) / 3600000, 22);   // 08:00 IST → next day
});
