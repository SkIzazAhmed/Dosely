'use strict';

/**
 * Referrals API (C7, C8; edge cases 8, 11, 13).
 * Commit 5 "done when": a referral can be accepted and stock is held at the target shop.
 * Needs PostgreSQL; skipped when unreachable. Uses its own shops, staff and
 * medicine, with real stock (stockIn, getAvailable, reserve, release are real).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { pool } = require('../src/db/pool');
const migrate = require('../src/db/migrate');
const seeds = require('../src/db/seed');
const stock = require('../src/modules/inventory/stock.service');
const { hashPassword } = require('../src/shared/password');
const { createApp } = require('../src/app');

const PASSWORD = process.env.SEED_PASSWORD || 'Dosely@123';
const uniq = () => crypto.randomBytes(4).toString('hex').toUpperCase();
let dbUp = false;
let server;
let base;
const tok = {};
const ctx = {};

async function api(method, path, { token, body, key } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  headers['idempotency-key'] = key ?? crypto.randomUUID();
  const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function login(email) {
  const r = await api('POST', '/auth/login', { body: { email, password: PASSWORD } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.token;
}

async function newStaffUser(label) {
  const email = `ref.${label}.${uniq().toLowerCase()}@dosely.test`;
  const { rows: [u] } = await pool.query(
    `INSERT INTO users (role, full_name, email, password_hash) VALUES ('SHOPKEEPER', $1, $2, $3) RETURNING id`,
    [`Referral ${label}`, email, await hashPassword(PASSWORD)]
  );
  return { id: u.id, email };
}

async function newShop(staffUserId, { isActive = true } = {}) {
  const code = `RF-${uniq()}`;
  const { rows: [s] } = await pool.query(
    `INSERT INTO shops (name, code, drug_licence_no, address, area, city, pincode, is_active)
     VALUES ($1, $2, $3, '2 Test Road', 'Jayanagar', 'Bengaluru', '560041', $4) RETURNING id`,
    [`Shop ${code}`, code, `DL-${code}`, isActive]
  );
  if (staffUserId) {
    await pool.query(`INSERT INTO shop_staff (shop_id, user_id, staff_role) VALUES ($1, $2, 'STAFF')`, [s.id, staffUserId]);
  }
  return s.id;
}

async function putStock(shopId, quantity) {
  await stock.stockIn({
    shopId, medicineId: ctx.medicineId, batchNo: `RF${uniq()}`, expiryDate: '2099-12-31', mrp: 4, quantity,
    performedBy: ctx.origin.id,
  });
}

const availableAt = async (shopId) =>
  (await stock.getAvailable(ctx.medicineId, { shopIds: [shopId] })).reduce((n, r) => n + r.available, 0);

test.before(async () => {
  try {
    await pool.query('SELECT 1');
    dbUp = true;
  } catch (err) {
    console.warn('[referrals.api.test] skipping:', err.message);
    return;
  }
  await migrate.up({ log: () => {} });
  await seeds.run({ log: () => {} });

  const { rows: [g] } = await pool.query(`INSERT INTO generics (name) VALUES ($1) RETURNING id`, [`RfGeneric ${uniq()}`]);
  ({ rows: [{ id: ctx.medicineId }] } = await pool.query(
    `INSERT INTO medicines (brand_name, generic_id, manufacturer, dosage_form, strength, base_unit)
     VALUES ($1, $2, 'Lab', 'TABLET', '10 mg', 'TABLET') RETURNING id`,
    [`RfBrand ${uniq()}`, g.id]
  ));

  ctx.origin = await newStaffUser('origin');
  ctx.target = await newStaffUser('target');
  ctx.outsider = await newStaffUser('outsider');
  ctx.originShop = await newShop(ctx.origin.id);
  await newShop(ctx.outsider.id);

  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  tok.doctor = await login('doctor@dosely.dev');
  tok.origin = await login(ctx.origin.email);
  tok.target = await login(ctx.target.email);
  tok.outsider = await login(ctx.outsider.email);
});

test.after(async () => {
  if (server) server.close();
  await pool.end();
});

const t = (name, fn) => test(name, async (c) => (dbUp ? fn(c) : c.skip('no database')));

/** A target shop staffed by ctx.target with `qty` units in stock. */
async function targetShop(qty = 20) {
  const id = await newShop(ctx.target.id);
  if (qty) await putStock(id, qty);
  return id;
}

/** A request at the origin shop (which has no stock), acknowledged unless ack: false. */
async function newRequest({ quantity = 10, ack = true, prescriptionId } = {}) {
  const r = await api('POST', '/requests', {
    token: tok.doctor,
    body: { shopId: ctx.originShop, medicineId: ctx.medicineId, quantity, prescriptionId },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  if (ack) assert.equal((await api('POST', `/requests/${r.body.id}/acknowledge`, { token: tok.origin })).status, 200);
  return r.body;
}

const refer = (requestId, toShopId, quantity, token = tok.origin) =>
  api('POST', `/requests/${requestId}/referrals`, { token, body: { toShopId, quantity } });
const getRequest = async (id) => (await api('GET', `/requests/${id}`, { token: tok.origin })).body;

t('C7: origin shop refers part of a request; the request moves to REFERRED', async () => {
  const shop = await targetShop(20);
  const req = await newRequest();
  const r = await refer(req.id, shop, 6);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.status, 'PENDING');
  assert.equal(r.body.quantity, 6);
  assert.equal(r.body.availableQtySeen, 20);
  assert.equal(r.body.requestNo, req.requestNo);
  assert.equal(r.body.toShop.id, shop);
  assert.equal((await getRequest(req.id)).status, 'REFERRED');

  const list = await api('GET', `/requests/${req.id}/referrals`, { token: tok.doctor });
  assert.deepEqual(list.body.items.map((x) => x.id), [r.body.id]);
});

t('C7: refused before acknowledge, to the same shop, to an inactive shop, and by non-origin staff', async () => {
  const shop = await targetShop(20);
  const sent = await newRequest({ ack: false });
  const early = await refer(sent.id, shop, 2);
  assert.equal(early.status, 409);
  assert.equal(early.body.error.code, 'INVALID_TRANSITION');

  const req = await newRequest();
  assert.equal((await refer(req.id, ctx.originShop, 2)).body.error.code, 'REFERRAL_SAME_SHOP');
  const inactive = await targetShop(20);
  await pool.query('UPDATE shops SET is_active = false WHERE id = $1', [inactive]);
  assert.equal((await refer(req.id, inactive, 2)).body.error.code, 'SHOP_INACTIVE');
  assert.equal((await refer(req.id, 999999999, 2)).status, 404);
  assert.equal((await refer(req.id, shop, 2, tok.target)).status, 403);
  assert.equal((await refer(req.id, shop, 2, tok.doctor)).status, 403);
});

t('edge case 8: a target that also lacks stock is refused, with what it has', async () => {
  const shop = await targetShop(3);
  const req = await newRequest();
  const r = await refer(req.id, shop, 4);
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'INSUFFICIENT_STOCK');
  assert.equal(r.body.error.details.available, 3);
  assert.equal((await getRequest(req.id)).status, 'ACKNOWLEDGED');
});

t('C7: no duplicate live referral to one shop; live qty ≤ unfulfilled; at most 3 per request', async () => {
  const [a, b, c, d] = [await targetShop(), await targetShop(), await targetShop(), await targetShop()];
  const req = await newRequest({ quantity: 10 });
  assert.equal((await refer(req.id, a, 4)).status, 201);
  const dup = await refer(req.id, a, 1);
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'REFERRAL_DUPLICATE');
  const tooMuch = await refer(req.id, b, 7);
  assert.equal(tooMuch.status, 409);
  assert.equal(tooMuch.body.error.code, 'REFERRAL_QTY_EXCEEDED');
  assert.equal((await refer(req.id, b, 3)).status, 201);
  assert.equal((await refer(req.id, c, 3)).status, 201);
  const fourth = await refer(req.id, d, 1);
  assert.equal(fourth.status, 409);
  assert.equal(fourth.body.error.code, 'REFERRAL_LIMIT_REACHED');
});

t('C8: target accepts → ACCEPTED, stock held for 24 h at the target shop', async () => {
  const shop = await targetShop(10);
  const req = await newRequest();
  const ref = (await refer(req.id, shop, 6)).body;
  assert.equal((await api('POST', `/referrals/${ref.id}/accept`, { token: tok.origin })).status, 403);

  const before = Date.now();
  const a = await api('POST', `/referrals/${ref.id}/accept`, { token: tok.target });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal(a.body.status, 'ACCEPTED');
  const hours = (new Date(a.body.holdUntil) - before) / 3.6e6;
  assert.ok(hours > 23.9 && hours < 24.1, String(hours));
  assert.equal(a.body.reservationLines.reduce((n, l) => n + l.quantity, 0), 6);
  assert.equal(await availableAt(shop), 4);
  assert.equal((await getRequest(req.id)).status, 'REFERRED');

  const again = await api('POST', `/referrals/${ref.id}/accept`, { token: tok.target });
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'INVALID_TRANSITION');
  assert.equal(await availableAt(shop), 4);
});

t('edge case 8: stock gone by the time the target accepts → 409, referral stays PENDING', async () => {
  const shop = await targetShop(5);
  const req = await newRequest();
  const ref = (await refer(req.id, shop, 5)).body;
  const other = await newRequest();
  const otherRef = (await refer(other.id, shop, 2)).body;
  assert.equal((await api('POST', `/referrals/${otherRef.id}/accept`, { token: tok.target })).status, 200);

  const a = await api('POST', `/referrals/${ref.id}/accept`, { token: tok.target });
  assert.equal(a.status, 409);
  assert.equal(a.body.error.code, 'INSUFFICIENT_STOCK');
  assert.equal(a.body.error.details.available, 3);
  assert.equal((await api('GET', `/referrals/${ref.id}`, { token: tok.target })).body.status, 'PENDING');
});

t('C8: reject needs a reason; the request steps back to ACKNOWLEDGED (nothing dispensed)', async () => {
  const shop = await targetShop();
  const req = await newRequest();
  const ref = (await refer(req.id, shop, 4)).body;
  const none = await api('POST', `/referrals/${ref.id}/reject`, { token: tok.target, body: {} });
  assert.equal(none.status, 400);
  assert.equal(none.body.error.code, 'REJECT_REASON_REQUIRED');
  assert.equal((await api('POST', `/referrals/${ref.id}/reject`, { token: tok.origin, body: { reason: 'x' } })).status, 403);

  const r = await api('POST', `/referrals/${ref.id}/reject`, { token: tok.target, body: { reason: 'Pharmacist on leave' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, 'REJECTED');
  assert.equal(r.body.rejectReason, 'Pharmacist on leave');
  assert.deepEqual(r.body.request, { id: req.id, status: 'ACKNOWLEDGED' });
  // and the same shop can be asked again
  assert.equal((await refer(req.id, shop, 4)).status, 201);
});

t('step back: with something already dispensed the request returns to PARTIALLY_FULFILLED', async () => {
  const [a, b] = [await targetShop(), await targetShop()];
  const req = await newRequest();
  await pool.query(`UPDATE stock_requests SET status = 'PARTIALLY_FULFILLED', fulfilled_qty = 3 WHERE id = $1`, [req.id]);
  const r1 = (await refer(req.id, a, 3)).body;
  const r2 = (await refer(req.id, b, 3)).body;
  const x = await api('POST', `/referrals/${r1.id}/reject`, { token: tok.target, body: { reason: 'No' } });
  assert.equal(x.body.request.status, 'REFERRED'); // r2 still live
  const y = await api('POST', `/referrals/${r2.id}/reject`, { token: tok.target, body: { reason: 'No' } });
  assert.equal(y.body.request.status, 'PARTIALLY_FULFILLED');
});

t('C8 / edge case 11: origin cancels an accepted referral → stock released, request steps back', async () => {
  const shop = await targetShop(8);
  const req = await newRequest();
  const ref = (await refer(req.id, shop, 5)).body;
  await api('POST', `/referrals/${ref.id}/accept`, { token: tok.target });
  assert.equal(await availableAt(shop), 3);

  assert.equal((await api('POST', `/referrals/${ref.id}/cancel`, { token: tok.target })).status, 403);
  const c = await api('POST', `/referrals/${ref.id}/cancel`, { token: tok.origin, body: { reason: 'Patient prefers to wait' } });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(c.body.status, 'CANCELLED');
  assert.equal(c.body.released, 5);
  assert.equal(c.body.request.status, 'ACKNOWLEDGED');
  assert.equal(await availableAt(shop), 8);
  assert.equal((await api('POST', `/referrals/${ref.id}/cancel`, { token: tok.origin })).status, 409);
});

t('edge case 11: the doctor cancelling the request releases an accepted referral’s hold', async () => {
  const shop = await targetShop(6);
  const req = await newRequest();
  const ref = (await refer(req.id, shop, 6)).body;
  await api('POST', `/referrals/${ref.id}/accept`, { token: tok.target });
  assert.equal(await availableAt(shop), 0);
  const c = await api('POST', `/requests/${req.id}/cancel`, { token: tok.doctor });
  assert.equal(c.status, 200);
  assert.deepEqual(c.body.cancelledReferrals, [ref.id]);
  assert.equal(await availableAt(shop), 6);
  assert.equal((await api('GET', `/referrals/${ref.id}`, { token: tok.target })).body.status, 'CANCELLED');
});

t('target inbox lists live referrals first; outsiders cannot read referrals', async () => {
  const shop = await targetShop();
  const req = await newRequest();
  const ref = (await refer(req.id, shop, 2)).body;
  const inbox = await api('GET', `/referrals?shopId=${shop}&status=PENDING`, { token: tok.target });
  assert.equal(inbox.status, 200);
  assert.deepEqual(inbox.body.items.map((x) => x.id), [ref.id]);
  assert.equal((await api('GET', `/referrals?shopId=${shop}`, { token: tok.outsider })).status, 403);
  assert.equal((await api('GET', `/referrals/${ref.id}`, { token: tok.origin })).status, 200);
  assert.equal((await api('GET', `/referrals/${ref.id}`, { token: tok.outsider })).status, 403);
  assert.equal((await api('GET', '/referrals', { token: tok.target })).status, 400);
});
