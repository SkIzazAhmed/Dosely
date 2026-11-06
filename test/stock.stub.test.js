'use strict';

/**
 * Contract tests for the stock.service stub (Commit 1). The real service
 * (Nov 8–12) must pass the same shape checks.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const stock = require('../src/modules/inventory/stock.service');

const days = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const SHOP = 1;
const MED = 10;
const USER = 5;
let k = 0;
const key = () => `test-${++k}`;

function stockIn(batchNo, expiryDays, quantity, extra = {}) {
  return stock.stockIn({
    shopId: SHOP, medicineId: MED, batchNo, expiryDate: days(expiryDays), mrp: 2.5, quantity,
    performedBy: USER, idempotencyKey: key(), ...extra,
  });
}

test.beforeEach(() => stock._resetStub());

test('exports every agreed function', () => {
  for (const fn of ['stockIn', 'dispense', 'adjust', 'writeOff', 'reserve', 'release', 'getAvailable']) {
    assert.equal(typeof stock[fn], 'function', fn);
  }
});

test('stockIn returns batch, inventory and a STOCK_IN movement', async () => {
  const r = await stockIn('b1', 100, 30);
  assert.equal(r.batch.batchNo, 'B1');
  assert.deepEqual(
    { q: r.inventory.quantity, res: r.inventory.reserved, v: r.inventory.version },
    { q: 30, res: 0, v: 1 }
  );
  assert.equal(r.movement.type, 'STOCK_IN');
  assert.equal(r.movement.delta, 30);
  assert.equal(r.movement.balanceAfter, 30);
  assert.equal(r.replayed, false);
});

test('stockIn rejects expired batches (422) and mismatched batches (409)', async () => {
  await assert.rejects(stockIn('OLD', -1, 5), (e) => e.code === 'BATCH_EXPIRED' && e.status === 422);
  await stockIn('B1', 100, 5);
  await assert.rejects(stockIn('b1', 120, 5), (e) => e.code === 'BATCH_MISMATCH' && e.status === 409);
  await assert.rejects(stockIn('B1', 100, 5, { mrp: 3 }), (e) => e.code === 'BATCH_MISMATCH');
});

test('dispense is FEFO across batches and skips expired stock', async () => {
  await stockIn('LATE', 300, 10);
  await stockIn('SOON', 30, 4);
  const r = await stock.dispense({ shopId: SHOP, medicineId: MED, quantity: 6, performedBy: USER, idempotencyKey: key() });
  assert.deepEqual(r.lines.map((l) => [l.batchNo, l.quantity]), [['SOON', 4], ['LATE', 2]]);
  assert.ok(r.lines.every((l) => Number.isInteger(l.movementId)));
});

test('dispense more than available → INSUFFICIENT_STOCK; same key twice dispenses once', async () => {
  await stockIn('B1', 100, 3);
  await assert.rejects(
    stock.dispense({ shopId: SHOP, medicineId: MED, quantity: 4, performedBy: USER, idempotencyKey: key() }),
    (e) => e.code === 'INSUFFICIENT_STOCK' && e.details.available === 3
  );
  const input = { shopId: SHOP, medicineId: MED, quantity: 2, performedBy: USER, idempotencyKey: 'same' };
  const a = await stock.dispense(input);
  const b = await stock.dispense(input);
  assert.equal(b.replayed, true);
  assert.deepEqual(b.lines, a.lines);
  assert.deepEqual(await stock.getAvailable(MED), [{ shopId: SHOP, medicineId: MED, available: 1, nearestExpiry: days(100) }]);
});

test('dispense requires an idempotency key', async () => {
  await assert.rejects(
    stock.dispense({ shopId: SHOP, medicineId: MED, quantity: 1, performedBy: USER }),
    (e) => e.code === 'VALIDATION_ERROR' && e.details.some((d) => d.field === 'idempotencyKey')
  );
});

test('reserve holds stock; dispense with the reservation consumes it; release gives it back', async () => {
  await stockIn('B1', 100, 10);
  const r = await stock.reserve({ shopId: SHOP, medicineId: MED, quantity: 4, referralId: 77, performedBy: USER });
  assert.deepEqual(r.lines.map((l) => l.quantity), [4]);
  assert.equal((await stock.getAvailable(MED))[0].available, 6);

  await stock.dispense({
    shopId: SHOP, medicineId: MED, quantity: 3, performedBy: USER, idempotencyKey: key(),
    referralId: 77, reservation: [{ ...r.lines[0], quantity: 3 }],
  });
  const rel = await stock.release({ shopId: SHOP, referralId: 77, lines: r.lines, performedBy: USER });
  assert.equal(rel.released, 1);
  assert.equal((await stock.getAvailable(MED))[0].available, 7);
});

test('adjust needs a reason and the current version', async () => {
  const { inventory } = await stockIn('B1', 100, 10);
  const base = { shopId: SHOP, batchId: inventory.batchId, delta: -2, performedBy: USER };
  await assert.rejects(stock.adjust({ ...base, expectedVersion: 1 }), (e) => e.code === 'REASON_REQUIRED');
  await assert.rejects(stock.adjust({ ...base, expectedVersion: 0, reason: 'count fix' }), (e) => e.code === 'STALE_INVENTORY');
  const r = await stock.adjust({ ...base, expectedVersion: 1, reason: 'count fix' });
  assert.equal(r.inventory.quantity, 8);
  assert.equal(r.movement.type, 'ADJUSTMENT');
});

test('writeOff removes unreserved units with an EXPIRY_WRITE_OFF movement', async () => {
  const { inventory } = await stockIn('B1', 100, 10);
  const r = await stock.writeOff({ shopId: SHOP, batchId: inventory.batchId, reason: 'damaged strip', performedBy: USER });
  assert.equal(r.movement.type, 'EXPIRY_WRITE_OFF');
  assert.equal(r.movement.delta, -10);
  assert.equal(r.inventory.quantity, 0);
});

test('getAvailable lists shops with stock, filtered by shopIds', async () => {
  await stockIn('B1', 100, 5);
  await stock.stockIn({ shopId: 2, medicineId: MED, batchNo: 'B1', expiryDate: days(100), mrp: 2.5, quantity: 9, performedBy: USER });
  assert.deepEqual((await stock.getAvailable(MED)).map((r) => [r.shopId, r.available]), [[2, 9], [1, 5]]);
  assert.deepEqual((await stock.getAvailable(MED, { shopIds: [1] })).map((r) => r.shopId), [1]);
  assert.deepEqual(await stock.getAvailable(999), []);
});
