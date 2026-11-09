'use strict';

/**
 * Requests API (C1–C3, edge cases 1, 7, 13).
 * Commit 2 "done when": a doctor can send a request and the shop sees it in its inbox.
 * Needs PostgreSQL (DATABASE_URL); skipped when unreachable. Uses the seeded
 * demo users, a fresh medicine and a random shop id, so it's safe on a dev DB.
 * Stock comes from Rachana's in-memory stock.service stub.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { pool } = require('../src/db/pool');
const migrate = require('../src/db/migrate');
const seeds = require('../src/db/seed');
const stock = require('../src/modules/inventory/stock.service');
const { createApp } = require('../src/app');

const PASSWORD = process.env.SEED_PASSWORD || 'Dosely@123';
let dbUp = false;
let server;
let base;
const tok = {};
const ctx = {};

const uniq = () => crypto.randomBytes(4).toString('hex');

async function api(method, path, { token, body, key } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (key !== undefined) headers['idempotency-key'] = key;
  else if (method === 'POST') headers['idempotency-key'] = crypto.randomUUID();
  const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}

async function login(email) {
  const r = await api('POST', '/auth/login', { body: { email, password: PASSWORD } });
  assert.equal(r.status, 200, `login ${email}: ${JSON.stringify(r.body)}`);
  return r.body.token;
}

async function newMedicine(isActive = true) {
  const { rows: [g] } = await pool.query(`INSERT INTO generics (name) VALUES ($1) RETURNING id`, [`Generic ${uniq()}`]);
  const { rows: [m] } = await pool.query(
    `INSERT INTO medicines (brand_name, generic_id, manufacturer, dosage_form, strength, base_unit, is_active)
     VALUES ($1, $2, 'Test Labs', 'TABLET', '500 mg', 'TABLET', $3) RETURNING id`,
    [`Brand ${uniq()}`, g.id, isActive]
  );
  return m.id;
}

async function putStock(shopId, medicineId, quantity) {
  await stock.stockIn({
    shopId, medicineId, batchNo: `B${uniq()}`, expiryDate: '2099-12-31', mrp: 2.5, quantity, performedBy: 1,
  });
}

test.before(async () => {
  try {
    await pool.query('SELECT 1');
    dbUp = true;
  } catch (err) {
    console.warn('[requests.api.test] skipping:', err.message);
    return;
  }
  await migrate.up({ log: () => {} });
  await seeds.run({ log: () => {} });
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  tok.doctor = await login('doctor@dosely.dev');
  tok.noreg = await login('doctor.noreg@dosely.dev');
  tok.shop = await login('shopkeeper@dosely.dev');
  tok.admin = await login('admin@dosely.dev');
  ctx.shopId = 100000 + crypto.randomInt(800000);
  ctx.medicineId = await newMedicine();
  await putStock(ctx.shopId, ctx.medicineId, 3);
});

test.after(async () => {
  if (server) server.close();
  await pool.end();
});

const t = (name, fn) => test(name, async (c) => (dbUp ? fn(c) : c.skip('no database')));

const send = (body, token = tok.doctor, key) =>
  api('POST', '/requests', { token, key, body: { shopId: ctx.shopId, medicineId: ctx.medicineId, quantity: 10, ...body } });

t('C1/C2: doctor sends a request; snapshot, number, urgency and expiry are stored', async () => {
  const before = Date.now();
  const r = await send({ doctorNote: 'Patient needs 10 days' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.match(r.body.requestNo, /^REQ-\d{4}-\d{6}$/);
  assert.equal(r.body.status, 'SENT');
  assert.equal(r.body.urgency, 'ROUTINE');
  assert.equal(r.body.requestedQty, 10);
  assert.equal(r.body.availableQtySnapshot, 3);
  assert.equal(r.body.unfulfilledQty, 10);
  assert.equal(r.body.doctorNote, 'Patient needs 10 days');
  const hours = (new Date(r.body.expiresAt) - before) / 3.6e6;
  assert.ok(hours > 23.9 && hours < 24.1, `ROUTINE expires in 24 h, got ${hours}`);

  const urgent = await send({ urgency: 'URGENT' });
  assert.equal(urgent.status, 201);
  const h2 = (new Date(urgent.body.expiresAt) - before) / 3.6e6;
  assert.ok(h2 > 1.9 && h2 < 2.1, `URGENT expires in 2 h, got ${h2}`);
  assert.equal(Number(urgent.body.requestNo.slice(-6)), Number(r.body.requestNo.slice(-6)) + 1);
});

t('C1 / edge case 1: no request when the shop already has enough stock', async () => {
  for (const quantity of [1, 3]) {
    const r = await send({ quantity });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'REQUEST_NOT_SHORT');
    assert.equal(r.body.error.details.available, 3);
  }
});

t('edge case 7: a shop with zero stock can be sent a request (snapshot 0)', async () => {
  const r = await send({ shopId: ctx.shopId + 1, quantity: 1 });
  assert.equal(r.status, 201);
  assert.equal(r.body.availableQtySnapshot, 0);
});

t('C1: validation — quantity 1–10,000, note ≤ 500, urgency enum', async () => {
  for (const body of [{ quantity: 0 }, { quantity: 10001 }, { doctorNote: 'x'.repeat(501) }, { urgency: 'ASAP' }, { shopId: undefined }]) {
    const r = await send(body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.body.error.code, 'VALIDATION_ERROR');
  }
});

t('edge case 13: deactivated or unknown medicine is refused', async () => {
  const inactive = await newMedicine(false);
  const r = await send({ medicineId: inactive });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'MEDICINE_INACTIVE');
  const missing = await send({ medicineId: 999999999 });
  assert.equal(missing.status, 404);
});

t('only doctors with a registration number can send requests', async () => {
  const r = await send({}, tok.noreg);
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'DOCTOR_REG_NO_REQUIRED');
  const shop = await send({}, tok.shop);
  assert.equal(shop.status, 403);
});

t('same Idempotency-Key replays the request instead of creating a second one', async () => {
  const key = crypto.randomUUID();
  const a = await send({ quantity: 7 }, tok.doctor, key);
  const b = await send({ quantity: 7 }, tok.doctor, key);
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  assert.equal(b.headers.get('idempotent-replayed'), 'true');
  assert.equal(b.body.id, a.body.id);
});

t('C3: doctor list is newest first; shop inbox shows the request; shared prescriptions are grouped', async () => {
  const rx = 500000000 + crypto.randomInt(1e8);
  const a = await send({ prescriptionId: rx, quantity: 4 });
  const b = await send({ quantity: 5 });
  const c = await send({ prescriptionId: rx, quantity: 6 });
  assert.equal(c.status, 201);

  const mine = await api('GET', '/requests?mine&limit=3', { token: tok.doctor });
  assert.equal(mine.status, 200);
  assert.ok(mine.body.total >= 3);
  // newest first: c (and its group-mate a), then b
  assert.deepEqual(mine.body.items.map((g) => g.prescriptionId), [rx, null]);
  assert.deepEqual(mine.body.items[0].requests.map((r) => r.id), [c.body.id, a.body.id]);
  assert.equal(mine.body.items[1].requests[0].id, b.body.id);

  const inbox = await api('GET', `/requests?shopId=${ctx.shopId}&status=SENT&limit=100`, { token: tok.shop });
  assert.equal(inbox.status, 200);
  const ids = inbox.body.items.flatMap((g) => g.requests.map((r) => r.id));
  for (const r of [a, b, c]) assert.ok(ids.includes(r.body.id));
  assert.ok(inbox.body.items.every((g) => g.requests.every((r) => r.shopId === ctx.shopId && r.status === 'SENT')));

  const one = await api('GET', `/requests/${a.body.id}`, { token: tok.shop });
  assert.equal(one.status, 200);
  assert.equal(one.body.medicine.id, ctx.medicineId);
});

t('C3: inbox needs shopId; doctors cannot read the inbox or other doctors’ requests', async () => {
  const noShop = await api('GET', '/requests', { token: tok.shop });
  assert.equal(noShop.status, 400);
  const doc = await api('GET', `/requests?shopId=${ctx.shopId}`, { token: tok.doctor });
  assert.equal(doc.status, 403);
  const r = await send({ quantity: 8 });
  const other = await api('GET', `/requests/${r.body.id}`, { token: tok.noreg });
  assert.equal(other.status, 403);
  const admin = await api('GET', `/requests/${r.body.id}`, { token: tok.admin });
  assert.equal(admin.status, 200);
});

// ---------------------------------------------------------------------------
// Commit 3: acknowledge, close, cancel (C4, C5, edge cases 11, 16)
// ---------------------------------------------------------------------------

const act = (id, action, token, body) => api('POST', `/requests/${id}/${action}`, { token, body, key: crypto.randomUUID() });

t('C5: shop acknowledges a SENT request once; a second acknowledge is 409', async () => {
  const r = await send({ quantity: 9 });
  const ack = await act(r.body.id, 'acknowledge', tok.shop);
  assert.equal(ack.status, 200, JSON.stringify(ack.body));
  assert.equal(ack.body.status, 'ACKNOWLEDGED');
  assert.ok(ack.body.acknowledgedAt);
  const again = await act(r.body.id, 'acknowledge', tok.shop);
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'INVALID_TRANSITION');
  assert.equal(again.body.error.details.from, 'ACKNOWLEDGED');
});

t('C5: only the shop acknowledges/closes and only the sending doctor cancels', async () => {
  const r = await send({ quantity: 9 });
  assert.equal((await act(r.body.id, 'acknowledge', tok.doctor)).status, 403);
  assert.equal((await act(r.body.id, 'close', tok.doctor, { reason: 'x' })).status, 403);
  assert.equal((await act(r.body.id, 'cancel', tok.shop)).status, 403);
  assert.equal((await act(r.body.id, 'cancel', tok.noreg)).status, 403);
});

t('edge case 16: acknowledge after expiry, or after the expiry job ran, is 409', async () => {
  const r = await send({ urgency: 'URGENT' });
  await pool.query(
    `UPDATE stock_requests SET created_at = now() - interval '3 hours', expires_at = now() - interval '1 minute' WHERE id = $1`,
    [r.body.id]
  );
  const late = await act(r.body.id, 'acknowledge', tok.shop);
  assert.equal(late.status, 409);
  assert.equal(late.body.error.code, 'INVALID_TRANSITION');
  assert.match(late.body.error.details.reason, /expired/);

  await pool.query(`UPDATE stock_requests SET status = 'EXPIRED', expired_at = now() WHERE id = $1`, [r.body.id]);
  const gone = await act(r.body.id, 'acknowledge', tok.shop);
  assert.equal(gone.status, 409);
  assert.equal(gone.body.error.details.from, 'EXPIRED');
});

t('edge case 16: two acknowledges racing — exactly one wins', async () => {
  const r = await send({ quantity: 9 });
  const results = await Promise.all([1, 2, 3].map(() => act(r.body.id, 'acknowledge', tok.shop)));
  assert.deepEqual(results.map((x) => x.status).sort(), [200, 409, 409]);
});

t('C5: close needs a reason and works from ACKNOWLEDGED, not from SENT or a terminal status', async () => {
  const r = await send({ quantity: 9 });
  const fromSent = await act(r.body.id, 'close', tok.shop, { reason: 'Supplier delay' });
  assert.equal(fromSent.status, 409);
  await act(r.body.id, 'acknowledge', tok.shop);

  const noReason = await act(r.body.id, 'close', tok.shop, {});
  assert.equal(noReason.status, 400);
  assert.equal(noReason.body.error.code, 'CLOSE_REASON_REQUIRED');
  const blank = await act(r.body.id, 'close', tok.shop, { reason: '   ' });
  assert.equal(blank.body.error.code, 'CLOSE_REASON_REQUIRED');
  const long = await act(r.body.id, 'close', tok.shop, { reason: 'x'.repeat(501) });
  assert.equal(long.status, 400);

  const ok = await act(r.body.id, 'close', tok.shop, { reason: 'Supplier delay' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.status, 'CLOSED');
  assert.equal(ok.body.closeReason, 'Supplier delay');

  const cancel = await act(r.body.id, 'cancel', tok.doctor);
  assert.equal(cancel.status, 409);
  assert.equal(cancel.body.error.code, 'INVALID_TRANSITION');
});

t('C5: doctor cancels from SENT and from ACKNOWLEDGED', async () => {
  const a = await send({ quantity: 9 });
  const c1 = await act(a.body.id, 'cancel', tok.doctor, { reason: 'Patient found it elsewhere' });
  assert.equal(c1.status, 200);
  assert.equal(c1.body.status, 'CANCELLED');
  assert.equal(c1.body.cancelReason, 'Patient found it elsewhere');
  assert.deepEqual(c1.body.cancelledReferrals, []);

  const b = await send({ quantity: 9 });
  await act(b.body.id, 'acknowledge', tok.shop);
  const c2 = await act(b.body.id, 'cancel', tok.doctor);
  assert.equal(c2.status, 200);
  assert.equal(c2.body.status, 'CANCELLED');
});

t('edge case 11: cancel after a referral was accepted releases the held stock', async () => {
  const target = ctx.shopId + 2;
  await putStock(target, ctx.medicineId, 5);
  const before = await stock.getAvailable(ctx.medicineId, { shopIds: [target] });
  assert.equal(before[0].available, 5);

  const r = await send({ quantity: 9 });
  await act(r.body.id, 'acknowledge', tok.shop);
  const { rows: [{ id: staffId }] } = await pool.query(`SELECT id FROM users WHERE email = 'shopkeeper@dosely.dev'`);
  const { rows: [refRow] } = await pool.query(
    `INSERT INTO referrals (request_id, from_shop_id, to_shop_id, quantity, available_qty_seen, referred_by)
     VALUES ($1, $2, $3, 5, 5, $4) RETURNING id`,
    [r.body.id, ctx.shopId, target, staffId]
  );
  const { lines } = await stock.reserve({
    shopId: target, medicineId: ctx.medicineId, quantity: 5, referralId: refRow.id, performedBy: staffId,
  });
  await pool.query(
    `UPDATE referrals SET status = 'ACCEPTED', accepted_at = now(), hold_until = now() + interval '24 hours',
            reservation_lines = $2 WHERE id = $1`,
    [refRow.id, JSON.stringify(lines)]
  );
  await pool.query(`UPDATE stock_requests SET status = 'REFERRED' WHERE id = $1`, [r.body.id]);
  assert.equal((await stock.getAvailable(ctx.medicineId, { shopIds: [target] })).length, 0);

  const c = await act(r.body.id, 'cancel', tok.doctor);
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(c.body.status, 'CANCELLED');
  assert.deepEqual(c.body.cancelledReferrals, [refRow.id]);
  assert.deepEqual(c.body.released, [{ referralId: refRow.id, shopId: target, released: 5 }]);

  const { rows: [after] } = await pool.query('SELECT status, cancel_reason FROM referrals WHERE id = $1', [refRow.id]);
  assert.equal(after.status, 'CANCELLED');
  assert.equal((await stock.getAvailable(ctx.medicineId, { shopIds: [target] }))[0].available, 5);
});
