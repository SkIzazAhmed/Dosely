'use strict';

/**
 * Edge cases owned by requests + referrals (Anushka, Commit 7):
 *   1  insufficient stock          8  target that also lacks stock
 *   2  partial fulfilment         11  cancel after accept
 *   7  zero-stock shop            12  patient no-show
 *  13  deactivated shop or medicine
 *  16  expiry racing an acknowledge
 *
 * All real services (stock, phones, notifications, jobs) through the HTTP API.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, dbReachable, pool } = require('./support/requestFixtures');
const requests = require('../src/modules/requests/request.service');
const referrals = require('../src/modules/referrals/referral.service');
const messages = require('../src/modules/referrals/referral.messages');

let w;
let dbUp = false;

test.before(async () => {
  dbUp = await dbReachable();
  if (!dbUp) return console.warn('[requests.edgecases] skipping: no database');
  w = await setup('edge');
  w.origin = await w.staff('origin');
  w.targetStaff = await w.staff('target');
});

test.after(async () => {
  if (w) w.close();
  await pool.end();
});

const t = (name, fn) => test(name, async (c) => (dbUp ? fn(c) : c.skip('no database')));

// --- helpers -----------------------------------------------------------------

const originShop = () => w.shop(w.origin, { name: 'Origin' });
const targetShop = async (qty) => {
  const id = await w.shop(w.targetStaff, { name: 'Target' });
  if (qty) await w.putStock(id, qty);
  return id;
};
const send = (shopId, quantity, extra = {}) =>
  w.api('POST', '/requests', { token: w.doctor, body: { shopId, medicineId: w.medicineId, quantity, ...extra } });
const as = (who) => (who === 'doctor' ? w.doctor : who === 'target' ? w.targetStaff.token : w.origin.token);
const post = (path, who, body) => w.api('POST', path, { token: as(who), body });
const getReq = async (id) => (await w.api('GET', `/requests/${id}`, { token: w.origin.token })).body;
const getRef = async (id) => (await w.api('GET', `/referrals/${id}`, { token: w.targetStaff.token })).body;

async function ackedRequest(shopId, quantity, extra) {
  const r = await send(shopId, quantity, extra);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal((await post(`/requests/${r.body.id}/acknowledge`, 'origin')).status, 200);
  return r.body;
}

async function acceptedReferral(requestId, toShopId, quantity) {
  const ref = await post(`/requests/${requestId}/referrals`, 'origin', { toShopId, quantity });
  assert.equal(ref.status, 201, JSON.stringify(ref.body));
  const acc = await post(`/referrals/${ref.body.id}/accept`, 'target');
  assert.equal(acc.status, 200, JSON.stringify(acc.body));
  return acc.body;
}

// --- 1 -----------------------------------------------------------------------

t('edge case 1: insufficient stock — a request only when the shop is short; snapshot is what it had', async () => {
  const shop = await originShop();
  await w.putStock(shop, 6);
  for (const q of [1, 6]) {
    const r = await send(shop, q);
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'REQUEST_NOT_SHORT');
    assert.equal(r.body.error.details.available, 6);
  }
  const ok = await send(shop, 7);
  assert.equal(ok.status, 201);
  assert.equal(ok.body.availableQtySnapshot, 6);

  // units held for someone else's referral don't count as available
  await pool.query(`INSERT INTO shop_staff (shop_id, user_id, staff_role) VALUES ($1, $2, 'STAFF')`, [shop, w.targetStaff.id]);
  const other = await ackedRequest(await originShop(), 4);
  await acceptedReferral(other.id, shop, 4);
  const after = await send(shop, 3);
  assert.equal(after.status, 201, 'only 2 left unreserved');
  assert.equal(after.body.availableQtySnapshot, 2);
});

// --- 2 -----------------------------------------------------------------------

t('edge case 2: partial fulfilment — part at the shop, part by referral, the rest closed', async () => {
  const shop = await originShop();
  await w.putStock(shop, 3);
  const target = await targetShop(4);
  const req = await ackedRequest(shop, 10);

  const d = await post(`/requests/${req.id}/dispense`, 'origin', { quantity: 3 });
  assert.equal(d.body.status, 'PARTIALLY_FULFILLED');
  const over = await post(`/requests/${req.id}/dispense`, 'origin', { quantity: 8 });
  assert.equal(over.status, 400, 'never more than the unfulfilled 7');

  const ref = await acceptedReferral(req.id, target, 4);
  const pick = await post(`/referrals/${ref.id}/fulfil`, 'target', { requestNo: req.requestNo });
  assert.deepEqual(pick.body.request, { id: req.id, status: 'PARTIALLY_FULFILLED', fulfilledQty: 7, unfulfilledQty: 3 });

  const closed = await post(`/requests/${req.id}/close`, 'origin', { reason: 'Remaining 3 not available nearby' });
  assert.equal(closed.status, 200);
  assert.equal(closed.body.status, 'CLOSED');
  assert.equal(closed.body.fulfilledQty, 7);
});

// --- 7 -----------------------------------------------------------------------

t('edge case 7: zero-stock shop — request has snapshot 0, it can’t dispense, and it isn’t offered as a source', async () => {
  const empty = await originShop();
  const req = await ackedRequest(empty, 5);
  assert.equal(req.availableQtySnapshot, 0);

  const d = await post(`/requests/${req.id}/dispense`, 'origin', { quantity: 1 });
  assert.equal(d.status, 409);
  assert.equal(d.body.error.code, 'INSUFFICIENT_STOCK');
  const now = await getReq(req.id);
  assert.equal(now.status, 'ACKNOWLEDGED');
  assert.equal(now.fulfilledQty, 0);

  const look = await w.api('GET', `/inventory/availability?medicine_id=${w.medicineId}&min_qty=1`, { token: w.doctor });
  assert.ok(!look.body.items.some((i) => i.shop.id === empty));
  const ref = await post(`/requests/${(await ackedRequest(await originShop(), 2)).id}/referrals`, 'origin', { toShopId: empty, quantity: 1 });
  assert.equal(ref.status, 409);
  assert.equal(ref.body.error.code, 'INSUFFICIENT_STOCK');
});

// --- 8 -----------------------------------------------------------------------

t('edge case 8: target that also lacks stock — refused at referral, and at accept if the stock went meanwhile', async () => {
  const req = await ackedRequest(await originShop(), 8);
  const thin = await targetShop(2);
  const r = await post(`/requests/${req.id}/referrals`, 'origin', { toShopId: thin, quantity: 5 });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'INSUFFICIENT_STOCK');
  assert.equal(r.body.error.details.available, 2);
  assert.equal((await getReq(req.id)).status, 'ACKNOWLEDGED');

  // enough at lookup time, gone by accept time
  const target = await targetShop(5);
  const ref = (await post(`/requests/${req.id}/referrals`, 'origin', { toShopId: target, quantity: 5 })).body;
  const rival = await ackedRequest(await originShop(), 3);
  await acceptedReferral(rival.id, target, 3);
  const acc = await post(`/referrals/${ref.id}/accept`, 'target');
  assert.equal(acc.status, 409);
  assert.equal(acc.body.error.code, 'INSUFFICIENT_STOCK');
  assert.equal(acc.body.error.details.available, 2);
  assert.equal((await getRef(ref.id)).status, 'PENDING');

  // the target rejects; the request steps back so the shop can refer elsewhere
  const rej = await post(`/referrals/${ref.id}/reject`, 'target', { reason: 'Only 2 left' });
  assert.equal(rej.body.request.status, 'ACKNOWLEDGED');
  const elsewhere = await targetShop(8);
  assert.equal((await post(`/requests/${req.id}/referrals`, 'origin', { toShopId: elsewhere, quantity: 8 })).status, 201);
});

// --- 11 ----------------------------------------------------------------------

t('edge case 11: cancel after accept — doctor or origin shop cancels, held stock goes back', async () => {
  // doctor cancels the whole request
  const t1 = await targetShop(6);
  const req1 = await ackedRequest(await originShop(), 6);
  const ref1 = await acceptedReferral(req1.id, t1, 6);
  assert.deepEqual(await w.onHand(t1), { quantity: 6, reserved: 6 });
  const c1 = await post(`/requests/${req1.id}/cancel`, 'doctor', { reason: 'Changed prescription' });
  assert.equal(c1.status, 200);
  assert.deepEqual(c1.body.cancelledReferrals, [ref1.id]);
  assert.deepEqual(await w.onHand(t1), { quantity: 6, reserved: 0 });
  assert.equal((await getRef(ref1.id)).status, 'CANCELLED');
  assert.equal((await post(`/referrals/${ref1.id}/fulfil`, 'target', { requestNo: req1.requestNo })).status, 409);

  // origin cancels one referral; the request stays open
  const t2 = await targetShop(4);
  const req2 = await ackedRequest(await originShop(), 4);
  const ref2 = await acceptedReferral(req2.id, t2, 4);
  const c2 = await post(`/referrals/${ref2.id}/cancel`, 'origin', { reason: 'Patient will wait for restock' });
  assert.equal(c2.body.released, 4);
  assert.equal(c2.body.request.status, 'ACKNOWLEDGED');
  assert.deepEqual(await w.onHand(t2), { quantity: 4, reserved: 0 });
});

// --- 12 ----------------------------------------------------------------------

t('edge case 12: patient no-show — hold expires, stock released, request steps back, no SMS sent late', async () => {
  const shop = await originShop();
  await w.putStock(shop, 2);
  const target = await targetShop(5);
  const patientId = await w.patient('+919845012012');
  const req = await ackedRequest(shop, 7, { patientId });
  await post(`/requests/${req.id}/dispense`, 'origin', { quantity: 2 });
  const ref = await acceptedReferral(req.id, target, 5);
  assert.equal(ref.patientContact.method, 'SMS');

  await pool.query(
    `UPDATE referrals SET accepted_at = now() - interval '25 hours', hold_until = now() - interval '1 minute' WHERE id = $1`,
    [ref.id]
  );
  const out = await referrals.expireHolds();
  assert.ok(out.noShow.includes(ref.id));
  const after = await getRef(ref.id);
  assert.equal(after.status, 'NO_SHOW');
  assert.deepEqual(await w.onHand(target), { quantity: 5, reserved: 0 });
  assert.equal((await getReq(req.id)).status, 'PARTIALLY_FULFILLED', 'back to partial: 2 were dispensed');

  // the patient turns up after the no-show: refused
  const late = await post(`/referrals/${ref.id}/fulfil`, 'target', { requestNo: req.requestNo, phoneLast5: '12012' });
  assert.equal(late.status, 409);

  // the queued SMS for that referral is skipped, not sent
  await pool.query(`UPDATE patient_referral_messages SET queued_at = now() - interval '11 minutes' WHERE referral_id = $1`, [ref.id]);
  await messages.sendDueBatches();
  const { rows: [m] } = await pool.query('SELECT status FROM patient_referral_messages WHERE referral_id = $1', [ref.id]);
  assert.equal(m.status, 'SKIPPED');
  const { rows: sent } = await pool.query(
    `SELECT 1 FROM notifications WHERE recipient_type = 'PATIENT' AND recipient_id = $1 AND type = 'REFERRAL_READY'`, [patientId]
  );
  assert.equal(sent.length, 0);
});

// --- 13 ----------------------------------------------------------------------

t('edge case 13: deactivated shop or medicine — refused everywhere it matters', async () => {
  // deactivated origin shop
  const closedShop = await originShop();
  await pool.query('UPDATE shops SET is_active = false WHERE id = $1', [closedShop]);
  assert.equal((await send(closedShop, 3)).body.error.code, 'SHOP_INACTIVE');

  // deactivated target: not offered, can't be referred to
  const req = await ackedRequest(await originShop(), 4);
  const gone = await targetShop(10);
  await pool.query('UPDATE shops SET is_active = false WHERE id = $1', [gone]);
  const look = await w.api('GET', `/inventory/availability?medicine_id=${w.medicineId}&min_qty=1`, { token: w.doctor });
  assert.ok(!look.body.items.some((i) => i.shop.id === gone));
  assert.equal((await post(`/requests/${req.id}/referrals`, 'origin', { toShopId: gone, quantity: 4 })).body.error.code, 'SHOP_INACTIVE');

  // target deactivated after accepting: pickup is refused, nothing dispensed, the hold stays for the no-show job
  const later = await targetShop(4);
  const ref = await acceptedReferral(req.id, later, 4);
  await pool.query('UPDATE shops SET is_active = false WHERE id = $1', [later]);
  const pick = await post(`/referrals/${ref.id}/fulfil`, 'target', { requestNo: req.requestNo });
  assert.equal(pick.status, 409);
  assert.equal(pick.body.error.code, 'SHOP_INACTIVE');
  assert.equal((await getRef(ref.id)).status, 'ACCEPTED');
  assert.equal((await getReq(req.id)).fulfilledQty, 0);
  // ...and the no-show job still releases the hold at the deactivated shop
  await pool.query(`UPDATE referrals SET accepted_at = now() - interval '25 hours', hold_until = now() - interval '1 minute' WHERE id = $1`, [ref.id]);
  assert.ok((await referrals.expireHolds()).noShow.includes(ref.id));
  assert.deepEqual(await w.onHand(later), { quantity: 4, reserved: 0 });

  // deactivated medicine: no new requests, no lookup
  const { rows: [g] } = await pool.query(`INSERT INTO generics (name) VALUES ('edge13 generic ' || gen_random_uuid()) RETURNING id`);
  const { rows: [m] } = await pool.query(
    `INSERT INTO medicines (brand_name, generic_id, manufacturer, dosage_form, strength, base_unit, is_active)
     VALUES ('edge13 ' || gen_random_uuid(), $1, 'Lab', 'TABLET', '1 mg', 'TABLET', false) RETURNING id`,
    [g.id]
  );
  const r = await w.api('POST', '/requests', { token: w.doctor, body: { shopId: await originShop(), medicineId: m.id, quantity: 1 } });
  assert.equal(r.body.error.code, 'MEDICINE_INACTIVE');
  const l = await w.api('GET', `/inventory/availability?medicine_id=${m.id}`, { token: w.doctor });
  assert.equal(l.body.error.code, 'MEDICINE_INACTIVE');
});

// --- 16 ----------------------------------------------------------------------

t('edge case 16: expiry racing an acknowledge — exactly one wins, every time', async () => {
  const shop = await originShop();
  for (let i = 0; i < 8; i++) {
    const req = (await send(shop, 2, { urgency: 'URGENT' })).body;
    // expire right about now, then fire the shop's acknowledge and the expiry job together
    await pool.query(
      `UPDATE stock_requests SET created_at = now() - interval '2 hours', expires_at = now() + interval '40 milliseconds' WHERE id = $1`,
      [req.id]
    );
    await new Promise((r) => setTimeout(r, 40));
    const [ack, job] = await Promise.all([post(`/requests/${req.id}/acknowledge`, 'origin'), requests.expireDue()]);
    const final = (await getReq(req.id)).status;
    if (ack.status === 200) {
      assert.equal(final, 'ACKNOWLEDGED');
      assert.ok(!job.expired.includes(req.id));
    } else {
      assert.equal(ack.status, 409);
      assert.equal(ack.body.error.code, 'INVALID_TRANSITION');
      assert.equal(final, 'EXPIRED');
      // the job may have run just before or just after the failed acknowledge
      if (!job.expired.includes(req.id)) assert.ok((await requests.expireDue()).expired.includes(req.id));
    }
  }
  // and the deterministic ends: already past expiry → acknowledge always loses
  const past = (await send(shop, 2)).body;
  await pool.query(`UPDATE stock_requests SET created_at = now() - interval '2 days', expires_at = now() - interval '1 second' WHERE id = $1`, [past.id]);
  assert.equal((await post(`/requests/${past.id}/acknowledge`, 'origin')).status, 409);
  assert.ok((await requests.expireDue()).expired.includes(past.id));
});
