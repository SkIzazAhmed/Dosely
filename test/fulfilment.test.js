'use strict';

/**
 * Pickup, patient messages and jobs (C9, C10, C11; edge cases 2, 12, 16).
 * Commit 6 "done when": full flow works end to end — request, partial dispense,
 * referral, pickup, FULFILLED.
 *
 * Real: stockIn, getAvailable, reserve, release. stock.dispense is still
 * Rachana's in-memory stub, so a recording stand-in is swapped in for it.
 * Patient phones (Izaz) aren't on main: patientPhone's stub is used.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { pool } = require('../src/db/pool');
const migrate = require('../src/db/migrate');
const seeds = require('../src/db/seed');
const stock = require('../src/modules/inventory/stock.service');
const notifications = require('../src/modules/notifications/notification.service');
const requests = require('../src/modules/requests/request.service');
const referrals = require('../src/modules/referrals/referral.service');
const messages = require('../src/modules/referrals/referral.messages');
const patientPhone = require('../src/modules/referrals/patientPhone');
const jobs = require('../src/jobs');
const { hashPassword } = require('../src/shared/password');
const { createApp } = require('../src/app');

const PASSWORD = process.env.SEED_PASSWORD || 'Dosely@123';
const uniq = () => crypto.randomBytes(4).toString('hex').toUpperCase();
let dbUp = false;
let server;
let base;
const tok = {};
const ctx = {};
const dispenseCalls = [];
const smsCalls = [];
const real = {};

async function api(method, path, { token, body, key, accept } = {}) {
  const headers = { 'content-type': 'application/json', 'idempotency-key': key ?? crypto.randomUUID() };
  if (token) headers.authorization = `Bearer ${token}`;
  if (accept) headers.accept = accept;
  const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let parsed = text;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* text/plain */ }
  return { status: res.status, body: parsed, headers: res.headers };
}

async function login(email) {
  const r = await api('POST', '/auth/login', { body: { email, password: PASSWORD } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.token;
}

async function newStaffUser(label) {
  const email = `ful.${label}.${uniq().toLowerCase()}@dosely.test`;
  const { rows: [u] } = await pool.query(
    `INSERT INTO users (role, full_name, email, password_hash) VALUES ('SHOPKEEPER', $1, $2, $3) RETURNING id`,
    [`Fulfil ${label}`, email, await hashPassword(PASSWORD)]
  );
  return { id: u.id, email };
}

async function newShop(staffUserId, name = 'Shop') {
  const code = `FL-${uniq()}`;
  const { rows: [s] } = await pool.query(
    `INSERT INTO shops (name, code, drug_licence_no, address, area, city, pincode)
     VALUES ($1, $2, $3, '7 MG Road', 'Indiranagar', 'Bengaluru', '560038') RETURNING id`,
    [`${name} ${code}`, code, `DL-${code}`]
  );
  await pool.query(`INSERT INTO shop_staff (shop_id, user_id, staff_role) VALUES ($1, $2, 'STAFF')`, [s.id, staffUserId]);
  return s.id;
}

async function putStock(shopId, quantity) {
  await stock.stockIn({
    shopId, medicineId: ctx.medicineId, batchNo: `FL${uniq()}`, expiryDate: '2099-12-31', mrp: 5, quantity,
    performedBy: ctx.origin.id,
  });
}

const availableAt = async (shopId) =>
  (await stock.getAvailable(ctx.medicineId, { shopIds: [shopId] })).reduce((n, r) => n + r.available, 0);

async function newPatient(phone) {
  const { rows: [p] } = await pool.query(`INSERT INTO patients (full_name) VALUES ($1) RETURNING id`, [`Patient ${uniq()}`]);
  patientPhone._setStubPhone(p.id, phone || null);
  return p.id;
}

test.before(async () => {
  try {
    await pool.query('SELECT 1');
    dbUp = true;
  } catch (err) {
    console.warn('[fulfilment.test] skipping:', err.message);
    return;
  }
  await migrate.up({ log: () => {} });
  await seeds.run({ log: () => {} });

  const { rows: [g] } = await pool.query(`INSERT INTO generics (name) VALUES ($1) RETURNING id`, [`FlGeneric ${uniq()}`]);
  ({ rows: [{ id: ctx.medicineId }] } = await pool.query(
    `INSERT INTO medicines (brand_name, generic_id, manufacturer, dosage_form, strength, base_unit)
     VALUES ($1, $2, 'Lab', 'TABLET', '5 mg', 'TABLET') RETURNING id`,
    [`FlBrand ${uniq()}`, g.id]
  ));
  ctx.origin = await newStaffUser('origin');
  ctx.target = await newStaffUser('target');
  ctx.originShop = await newShop(ctx.origin.id, 'Origin');

  real.dispense = stock.dispense;
  stock.dispense = async (input) => {
    dispenseCalls.push(input);
    const lines = input.reservation || [{ batchId: 1, batchNo: 'FAKE', expiryDate: '2099-12-31', quantity: input.quantity }];
    return { shopId: input.shopId, medicineId: input.medicineId, quantity: input.quantity, lines, replayed: false };
  };
  real.notifyPatient = notifications.notifyPatient;
  notifications.notifyPatient = async (patientId, payload, opts) => {
    smsCalls.push({ patientId, payload });
    return real.notifyPatient(patientId, payload, opts);
  };

  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  tok.doctor = await login('doctor@dosely.dev');
  tok.origin = await login(ctx.origin.email);
  tok.target = await login(ctx.target.email);
});

test.after(async () => {
  if (real.dispense) stock.dispense = real.dispense;
  if (real.notifyPatient) notifications.notifyPatient = real.notifyPatient;
  if (server) server.close();
  await pool.end();
});

const t = (name, fn) => test(name, async (c) => (dbUp ? fn(c) : c.skip('no database')));

async function targetShop(qty = 20) {
  const id = await newShop(ctx.target.id, 'Target');
  await putStock(id, qty);
  return id;
}

async function newRequest({ quantity = 10, patientId = null, prescriptionId = null, ack = true, shopId = ctx.originShop } = {}) {
  const r = await api('POST', '/requests', {
    token: tok.doctor,
    body: { shopId, medicineId: ctx.medicineId, quantity, patientId, prescriptionId },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  if (ack) assert.equal((await api('POST', `/requests/${r.body.id}/acknowledge`, { token: tok.origin })).status, 200);
  return r.body;
}

async function acceptedReferral(req, shop, qty) {
  const ref = await api('POST', `/requests/${req.id}/referrals`, { token: tok.origin, body: { toShopId: shop, quantity: qty } });
  assert.equal(ref.status, 201, JSON.stringify(ref.body));
  const a = await api('POST', `/referrals/${ref.body.id}/accept`, { token: tok.target });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  return a.body;
}

const fulfil = (id, body, token = tok.target, key) => api('POST', `/referrals/${id}/fulfil`, { token, body, key });
const getRequest = async (id) => (await api('GET', `/requests/${id}`, { token: tok.origin })).body;

// ---------------------------------------------------------------------------
// End to end
// ---------------------------------------------------------------------------

t('E2E: request → partial dispense → referral → accept (hold) → pickup → FULFILLED', async () => {
  // its own origin shop: the dispense stand-in doesn't take real stock away
  const origin = await newShop(ctx.origin.id, 'E2E Origin');
  await putStock(origin, 4);
  const shop = await targetShop(15);
  const patientId = await newPatient('+91 98450 12345');

  const req = await newRequest({ quantity: 10, patientId, shopId: origin });
  assert.equal(req.availableQtySnapshot, 4);
  assert.ok(req.alternatives.some((a) => a.shop.id === shop), 'target listed as an alternative');

  const d = await api('POST', `/requests/${req.id}/dispense`, { token: tok.origin, body: { quantity: 4 } });
  assert.equal(d.body.status, 'PARTIALLY_FULFILLED');

  const lookup = await api('GET', `/inventory/availability?medicine_id=${ctx.medicineId}&min_qty=6&near_shop_id=${origin}`, { token: tok.origin });
  assert.ok(lookup.body.items.some((i) => i.shop.id === shop));

  const ref = await acceptedReferral(req, shop, 6);
  assert.equal(ref.patientContact.method, 'SMS');
  assert.equal(await availableAt(shop), 9);
  assert.equal((await getRequest(req.id)).status, 'REFERRED');

  const f = await fulfil(ref.id, { requestNo: req.requestNo.toLowerCase(), phoneLast5: '12345' });
  assert.equal(f.status, 200, JSON.stringify(f.body));
  assert.equal(f.body.status, 'FULFILLED');
  assert.deepEqual(f.body.request, { id: req.id, status: 'FULFILLED', fulfilledQty: 10, unfulfilledQty: 0 });
  const call = dispenseCalls.at(-1);
  assert.equal(call.shopId, shop);
  assert.equal(call.referralId, ref.id);
  assert.deepEqual(call.reservation, ref.reservationLines);
  const done = await getRequest(req.id);
  assert.equal(done.status, 'FULFILLED');
  assert.ok(done.fulfilledAt);
});

// ---------------------------------------------------------------------------
// C9: verification at the target shop
// ---------------------------------------------------------------------------

t('C9: request number and last 5 phone digits must match; only target staff; replay is safe', async () => {
  const shop = await targetShop();
  const patientId = await newPatient('9845067890');
  const req = await newRequest({ quantity: 5, patientId });
  const ref = await acceptedReferral(req, shop, 5);

  for (const body of [
    { requestNo: 'REQ-2000-000001', phoneLast5: '67890' },
    { requestNo: req.requestNo, phoneLast5: '67891' },
    { requestNo: req.requestNo },
  ]) {
    const r = await fulfil(ref.id, body);
    assert.equal(r.status, 403, JSON.stringify(body));
    assert.equal(r.body.error.code, 'REFERRAL_VERIFICATION_FAILED');
    assert.equal(r.body.error.details.phoneRequired, true);
  }
  assert.equal((await fulfil(ref.id, { requestNo: req.requestNo, phoneLast5: '6789' })).status, 400);
  assert.equal((await fulfil(ref.id, { requestNo: req.requestNo, phoneLast5: '67890' }, tok.origin)).status, 403);

  const n = dispenseCalls.length;
  const key = crypto.randomUUID();
  const ok = await fulfil(ref.id, { requestNo: ` ${req.requestNo} `, phoneLast5: '67890' }, tok.target, key);
  assert.equal(ok.status, 200);
  const replay = await fulfil(ref.id, { requestNo: ` ${req.requestNo} `, phoneLast5: '67890' }, tok.target, key);
  assert.equal(replay.headers.get('idempotent-replayed'), 'true');
  assert.equal(dispenseCalls.length, n + 1);
  const again = await fulfil(ref.id, { requestNo: req.requestNo, phoneLast5: '67890' });
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'INVALID_TRANSITION');
});

t('C9: a slip patient (no usable phone) is verified by request number alone', async () => {
  const shop = await targetShop();
  const req = await newRequest({ quantity: 3, patientId: await newPatient(null) });
  const ref = await acceptedReferral(req, shop, 3);
  assert.equal(ref.patientContact.method, 'SLIP');
  const r = await fulfil(ref.id, { requestNo: req.requestNo });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.request.status, 'FULFILLED');
});

t('C9: picking up part of a request — PARTIALLY_FULFILLED when nothing else is live, REFERRED while another is', async () => {
  const [a, b] = [await targetShop(), await targetShop()];
  const req = await newRequest({ quantity: 10 });
  const r1 = await acceptedReferral(req, a, 4);
  const r2 = await acceptedReferral(req, b, 3);

  const f1 = await fulfil(r1.id, { requestNo: req.requestNo });
  assert.deepEqual(f1.body.request, { id: req.id, status: 'REFERRED', fulfilledQty: 4, unfulfilledQty: 6 });
  const f2 = await fulfil(r2.id, { requestNo: req.requestNo });
  assert.deepEqual(f2.body.request, { id: req.id, status: 'PARTIALLY_FULFILLED', fulfilledQty: 7, unfulfilledQty: 3 });
});

// ---------------------------------------------------------------------------
// C10: patient SMS after accept, batched per prescription; slip fallback
// ---------------------------------------------------------------------------

t('C10: referrals on one prescription accepted within 10 minutes go out as one SMS', async () => {
  const [a, b] = [await targetShop(), await targetShop()];
  const patientId = await newPatient('+919845011111');
  const rx = 700000000 + crypto.randomInt(1e8);
  const req1 = await newRequest({ quantity: 4, patientId, prescriptionId: rx });
  const req2 = await newRequest({ quantity: 4, patientId, prescriptionId: rx });

  const before = Date.now();
  const ref1 = await acceptedReferral(req1, a, 4);
  const ref2 = await acceptedReferral(req2, b, 4);
  assert.equal(ref1.patientContact.method, 'SMS');
  const mins = (new Date(ref2.patientContact.smsAfter) - before) / 60000;
  assert.ok(mins > 9.9 && mins < 10.1, String(mins));
  assert.equal(ref2.patientContact.smsAfter, ref1.patientContact.smsAfter, 'same batch, same send time');

  // nothing goes out before the window closes
  const early = await messages.sendDueBatches();
  assert.ok(!smsCalls.some((c) => c.patientId === patientId));
  assert.equal(typeof early.batches, 'number');

  await pool.query(
    `UPDATE patient_referral_messages SET queued_at = queued_at - interval '11 minutes' WHERE referral_id = ANY($1::bigint[])`,
    [[ref1.id, ref2.id]]
  );
  await messages.sendDueBatches();
  const sms = smsCalls.filter((c) => c.patientId === patientId);
  assert.equal(sms.length, 1);
  assert.deepEqual(sms[0].payload.channels, ['SMS']);
  assert.ok(sms[0].payload.body.length <= 160, sms[0].payload.body);
  assert.ok(sms[0].payload.body.includes(req1.requestNo) && sms[0].payload.body.includes(req2.requestNo), sms[0].payload.body);
  assert.deepEqual(sms[0].payload.data.referralIds.sort(), [ref1.id, ref2.id].sort());

  const { rows } = await pool.query(
    `SELECT status FROM patient_referral_messages WHERE referral_id = ANY($1::bigint[])`, [[ref1.id, ref2.id]]
  );
  assert.deepEqual(rows.map((r) => r.status), ['SENT', 'SENT']);
  await messages.sendDueBatches();
  assert.equal(smsCalls.filter((c) => c.patientId === patientId).length, 1, 'never sent twice');
});

t('C10: a referral cancelled before its batch goes out is skipped, not texted', async () => {
  const shop = await targetShop();
  const patientId = await newPatient('+919845022222');
  const req = await newRequest({ quantity: 2, patientId });
  const ref = await acceptedReferral(req, shop, 2);
  await api('POST', `/referrals/${ref.id}/cancel`, { token: tok.origin });
  await pool.query(`UPDATE patient_referral_messages SET queued_at = now() - interval '11 minutes' WHERE referral_id = $1`, [ref.id]);
  await messages.sendDueBatches();
  assert.ok(!smsCalls.some((c) => c.patientId === patientId));
  const { rows: [m] } = await pool.query('SELECT status FROM patient_referral_messages WHERE referral_id = $1', [ref.id]);
  assert.equal(m.status, 'SKIPPED');
});

t('C10: no usable phone (or no patient) → a printed slip with shop name, address and request number', async () => {
  const shop = await targetShop();
  const req = await newRequest({ quantity: 2 });
  const ref = await acceptedReferral(req, shop, 2);
  assert.equal(ref.patientContact.method, 'SLIP');
  const { slip } = ref.patientContact;
  assert.equal(slip.requestNo, req.requestNo);
  assert.equal(slip.shopName, ref.toShop.name);
  assert.match(slip.address, /7 MG Road, Indiranagar 560038/);
  assert.match(slip.text, new RegExp(req.requestNo));

  const json = await api('GET', `/referrals/${ref.id}/slip`, { token: tok.origin });
  assert.equal(json.status, 200);
  assert.equal(json.body.requestNo, req.requestNo);
  const text = await api('GET', `/referrals/${ref.id}/slip`, { token: tok.target, accept: 'text/plain' });
  assert.match(text.headers.get('content-type'), /text\/plain/);
  assert.match(text.body, /DOSELY REFERRAL SLIP/);
  assert.match(text.body, new RegExp(ref.toShop.name));
});

t('C10: SMS text stays within 160 characters for many shops', () => {
  const items = Array.from({ length: 6 }, (_, i) => ({
    request_no: `REQ-2026-00000${i}`, shop_name: `A Rather Long Pharmacy Name ${i}`, shop_area: 'Koramangala 5th Block',
  }));
  const body = messages.composeSms(items);
  assert.ok(body.length <= 160, `${body.length}: ${body}`);
  assert.match(body, /REQ-2026-000000/);
  assert.match(body, /\+\d more/);
  assert.ok(messages.composeSms(items.slice(0, 1)).includes('Show request no.'));
});

// ---------------------------------------------------------------------------
// C11: jobs
// ---------------------------------------------------------------------------

t('C11 / edge case 16: expireRequests marks SENT requests past expiry EXPIRED and leaves the rest', async () => {
  const sent = await newRequest({ ack: false });
  const fresh = await newRequest({ ack: false });
  const acked = await newRequest();
  await pool.query(
    `UPDATE stock_requests SET created_at = now() - interval '25 hours', expires_at = now() - interval '1 hour'
      WHERE id = ANY($1::bigint[])`,
    [[sent.id, acked.id]]
  );
  const out = await requests.expireDue();
  assert.ok(out.expired.includes(sent.id));
  assert.ok(!out.expired.includes(fresh.id) && !out.expired.includes(acked.id));
  assert.equal((await getRequest(sent.id)).status, 'EXPIRED');
  assert.equal((await getRequest(fresh.id)).status, 'SENT');
  assert.equal((await getRequest(acked.id)).status, 'ACKNOWLEDGED');
  // the shop can no longer acknowledge it
  assert.equal((await api('POST', `/requests/${sent.id}/acknowledge`, { token: tok.origin })).status, 409);
});

t('C11 / edge case 12: expireReferralHolds → NO_SHOW, stock released, request steps back', async () => {
  const shop = await targetShop(5);
  const req = await newRequest({ quantity: 5 });
  const ref = await acceptedReferral(req, shop, 5);
  assert.equal(await availableAt(shop), 0);
  await pool.query(
    `UPDATE referrals SET accepted_at = now() - interval '25 hours', hold_until = now() - interval '1 hour' WHERE id = $1`,
    [ref.id]
  );
  const out = await referrals.expireHolds();
  assert.ok(out.noShow.includes(ref.id));
  const after = (await api('GET', `/referrals/${ref.id}`, { token: tok.target })).body;
  assert.equal(after.status, 'NO_SHOW');
  assert.ok(after.noShowAt);
  assert.equal(await availableAt(shop), 5);
  assert.equal((await getRequest(req.id)).status, 'ACKNOWLEDGED');
  assert.equal((await fulfil(ref.id, { requestNo: req.requestNo })).status, 409);
  assert.ok(!(await referrals.expireHolds()).noShow.includes(ref.id));
});

t('C11: a PENDING referral unanswered for 2 hours reminds the origin shop once', async () => {
  const shop = await targetShop();
  const req = await newRequest();
  const ref = (await api('POST', `/requests/${req.id}/referrals`, { token: tok.origin, body: { toShopId: shop, quantity: 2 } })).body;
  const young = (await api('POST', `/requests/${(await newRequest()).id}/referrals`, { token: tok.origin, body: { toShopId: shop, quantity: 2 } })).body;
  await pool.query(`UPDATE referrals SET created_at = now() - interval '3 hours' WHERE id = $1`, [ref.id]);

  const first = await referrals.remindPending();
  assert.ok(first.reminded.includes(ref.id));
  assert.ok(!first.reminded.includes(young.id));
  assert.ok((await api('GET', `/referrals/${ref.id}`, { token: tok.target })).body.reminderSentAt);
  assert.ok(!(await referrals.remindPending()).reminded.includes(ref.id));
});

t('jobs: runOnce runs all four jobs under their advisory locks', async () => {
  const out = await jobs.runOnce({ log: () => {} });
  assert.deepEqual(Object.keys(out), ['expireRequests', 'expireReferralHolds', 'remindPendingReferrals', 'sendPatientReferralSms']);
  assert.ok(Array.isArray(out.expireRequests.expired));
  assert.equal(typeof out.sendPatientReferralSms.batches, 'number');
});
