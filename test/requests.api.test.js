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
