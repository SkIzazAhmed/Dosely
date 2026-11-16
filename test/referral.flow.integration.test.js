'use strict';

/**
 * Referral flow integration test (Anushka, Commit 7).
 *
 * The whole PRD flow through the HTTP API with every real service — stock
 * (stockIn, getAvailable, reserve, release, dispense), phones and
 * notifications — and the real jobs:
 *
 *   doctor sends a request → shop acknowledges → partial dispense at the shop
 *   → availability lookup → referral → target accepts (stock held)
 *   → patient SMS (batched) → pickup with verification → FULFILLED
 *
 * plus the no-show path: hold expires → NO_SHOW, stock released → refer to a
 * second shop → pickup.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, dbReachable, pool } = require('./support/requestFixtures');
const jobs = require('../src/jobs');

let w;
let dbUp = false;

test.before(async () => {
  dbUp = await dbReachable();
  if (!dbUp) return console.warn('[referral.flow.integration] skipping: no database');
  w = await setup('flow');
  w.origin = await w.staff('origin');
  w.targetStaff = await w.staff('target');
  w.originShop = await w.shop(w.origin, { name: 'Origin', lat: 12.925, lon: 77.5938 });
  w.near = await w.shop(w.targetStaff, { name: 'Near', lat: 12.934, lon: 77.5938, pincode: '560011', area: 'Basavanagudi' });
  w.far = await w.shop(w.targetStaff, { name: 'Far', lat: 12.99, lon: 77.5938, pincode: '560011', area: 'Basavanagudi' });
});

test.after(async () => {
  if (w) w.close();
  await pool.end();
});

const t = (name, fn) => test(name, async (c) => (dbUp ? fn(c) : c.skip('no database')));

async function movements(referralOrRequest, id) {
  const { rows } = await pool.query(
    `SELECT shop_id, delta, type FROM stock_movements WHERE ${referralOrRequest}_id = $1 ORDER BY id`,
    [id]
  );
  return rows.map((r) => ({ shopId: Number(r.shop_id), delta: r.delta, type: r.type }));
}

t('full flow: request → partial dispense → referral → accept → SMS → pickup → FULFILLED', async () => {
  const { api, doctor } = w;
  await w.putStock(w.originShop, 4);
  await w.putStock(w.near, 10);
  await w.putStock(w.far, 30);
  const patientId = await w.patient('+91 98450 70707');

  // 1. Doctor sends a request for 10; the shop has 4 → request with snapshot 4 and the top shops listed
  const created = await api('POST', '/requests', {
    token: doctor,
    body: { shopId: w.originShop, medicineId: w.medicineId, quantity: 10, urgency: 'URGENT', patientId, doctorNote: 'Start today' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const req = created.body;
  assert.equal(req.status, 'SENT');
  assert.equal(req.availableQtySnapshot, 4);
  assert.deepEqual(req.alternatives.map((a) => a.shop.id), [w.near, w.far]);
  const { rows: inbox } = await pool.query(
    `SELECT data FROM notifications WHERE recipient_type = 'SHOP' AND recipient_id = $1 AND type = 'REQUEST_CREATED'
      AND (data->>'requestId')::bigint = $2`,
    [w.originShop, req.id]
  );
  assert.ok(inbox.length >= 1, 'origin shop notified');
  assert.equal(inbox[0].data.alternatives.length, 2);

  // 2. Shop sees it in its inbox and acknowledges
  const list = await api('GET', `/requests?shopId=${w.originShop}&status=SENT`, { token: w.origin.token });
  assert.ok(list.body.items.some((g) => g.requests.some((r) => r.id === req.id)));
  assert.equal((await api('POST', `/requests/${req.id}/acknowledge`, { token: w.origin.token })).body.status, 'ACKNOWLEDGED');

  // 3. Shop dispenses what it has (real dispense) → PARTIALLY_FULFILLED, origin stock 0
  const d = await api('POST', `/requests/${req.id}/dispense`, { token: w.origin.token, body: { quantity: 4 } });
  assert.equal(d.status, 200, JSON.stringify(d.body));
  assert.equal(d.body.status, 'PARTIALLY_FULFILLED');
  assert.equal(d.body.unfulfilledQty, 6);
  assert.deepEqual(await w.onHand(w.originShop), { quantity: 0, reserved: 0 });

  // 4. Lookup for the remaining 6, nearest first
  const look = await api('GET', `/inventory/availability?medicine_id=${w.medicineId}&min_qty=6&near_shop_id=${w.originShop}`, { token: w.origin.token });
  assert.deepEqual(look.body.items.map((i) => i.shop.id), [w.near, w.far]);

  // 5. Refer 6 to the nearest shop → REFERRED
  const ref = await api('POST', `/requests/${req.id}/referrals`, { token: w.origin.token, body: { toShopId: w.near, quantity: 6 } });
  assert.equal(ref.status, 201, JSON.stringify(ref.body));
  assert.equal(ref.body.availableQtySeen, 10);
  assert.equal((await api('GET', `/requests/${req.id}`, { token: w.origin.token })).body.status, 'REFERRED');

  // 6. Target accepts → stock held (reserved, not removed)
  const acc = await api('POST', `/referrals/${ref.body.id}/accept`, { token: w.targetStaff.token });
  assert.equal(acc.status, 200, JSON.stringify(acc.body));
  assert.equal(acc.body.status, 'ACCEPTED');
  assert.equal(acc.body.patientContact.method, 'SMS');
  assert.deepEqual(await w.onHand(w.near), { quantity: 10, reserved: 6 });
  assert.equal(await w.available(w.near), 4);

  // 7. After the 10-minute window the SMS job sends one patient SMS (real notification row)
  await pool.query(`UPDATE patient_referral_messages SET queued_at = now() - interval '11 minutes' WHERE referral_id = $1`, [ref.body.id]);
  await jobs.runOnce({ log: () => {} });
  const { rows: sms } = await pool.query(
    `SELECT body, channel FROM notifications WHERE recipient_type = 'PATIENT' AND recipient_id = $1 AND type = 'REFERRAL_READY'`,
    [patientId]
  );
  assert.equal(sms.length, 1);
  assert.equal(sms[0].channel, 'SMS');
  assert.ok(sms[0].body.includes(req.requestNo) && sms[0].body.length <= 160, sms[0].body);

  // 8. Patient collects: wrong digits refused, right ones dispense the held units (real dispense)
  const wrong = await api('POST', `/referrals/${ref.body.id}/fulfil`, { token: w.targetStaff.token, body: { requestNo: req.requestNo, phoneLast5: '00000' } });
  assert.equal(wrong.status, 403);
  const pick = await api('POST', `/referrals/${ref.body.id}/fulfil`, { token: w.targetStaff.token, body: { requestNo: req.requestNo, phoneLast5: '70707' } });
  assert.equal(pick.status, 200, JSON.stringify(pick.body));
  assert.equal(pick.body.status, 'FULFILLED');
  assert.deepEqual(pick.body.request, { id: req.id, status: 'FULFILLED', fulfilledQty: 10, unfulfilledQty: 0 });
  assert.deepEqual(await w.onHand(w.near), { quantity: 4, reserved: 0 });

  // 9. The ledger shows both dispenses against the request; the referral's came from the target shop
  assert.deepEqual(await movements('request', req.id), [
    { shopId: w.originShop, delta: -4, type: 'DISPENSE' },
    { shopId: w.near, delta: -6, type: 'DISPENSE' },
  ]);
  assert.deepEqual(await movements('referral', ref.body.id), [{ shopId: w.near, delta: -6, type: 'DISPENSE' }]);

  // 10. Doctor's list shows it FULFILLED; nothing more can happen to it
  const mine = await api('GET', '/requests?mine&status=FULFILLED&limit=100', { token: doctor });
  assert.ok(mine.body.items.some((g) => g.requests.some((r) => r.id === req.id)));
  assert.equal((await api('POST', `/requests/${req.id}/cancel`, { token: doctor })).status, 409);
});

t('no-show path: hold expires → NO_SHOW, stock released → refer elsewhere → pickup → FULFILLED', async () => {
  const { api, doctor } = w;
  const a = await w.shop(w.targetStaff, { name: 'NoShowA' });
  const b = await w.shop(w.targetStaff, { name: 'NoShowB' });
  await w.putStock(a, 5);
  await w.putStock(b, 5);

  const req = (await api('POST', '/requests', { token: doctor, body: { shopId: w.originShop, medicineId: w.medicineId, quantity: 5 } })).body;
  await api('POST', `/requests/${req.id}/acknowledge`, { token: w.origin.token });

  const r1 = (await api('POST', `/requests/${req.id}/referrals`, { token: w.origin.token, body: { toShopId: a, quantity: 5 } })).body;
  const acc = await api('POST', `/referrals/${r1.id}/accept`, { token: w.targetStaff.token });
  assert.equal(acc.body.patientContact.method, 'SLIP'); // no patient on the request
  assert.deepEqual(await w.onHand(a), { quantity: 5, reserved: 5 });

  // the patient never comes; the hold job runs
  await pool.query(`UPDATE referrals SET accepted_at = now() - interval '25 hours', hold_until = now() - interval '1 hour' WHERE id = $1`, [r1.id]);
  const out = await jobs.runOnce({ log: () => {} });
  assert.ok(out.expireReferralHolds.noShow.includes(r1.id));
  assert.equal((await api('GET', `/referrals/${r1.id}`, { token: w.targetStaff.token })).body.status, 'NO_SHOW');
  assert.deepEqual(await w.onHand(a), { quantity: 5, reserved: 0 });
  assert.equal((await api('GET', `/requests/${req.id}`, { token: w.origin.token })).body.status, 'ACKNOWLEDGED');

  // origin refers to another shop; the patient collects there with the slip (request number only)
  const r2 = (await api('POST', `/requests/${req.id}/referrals`, { token: w.origin.token, body: { toShopId: b, quantity: 5 } })).body;
  await api('POST', `/referrals/${r2.id}/accept`, { token: w.targetStaff.token });
  const slip = await api('GET', `/referrals/${r2.id}/slip`, { token: w.origin.token, accept: 'text/plain' });
  assert.match(slip.body, new RegExp(req.requestNo));
  const pick = await api('POST', `/referrals/${r2.id}/fulfil`, { token: w.targetStaff.token, body: { requestNo: req.requestNo } });
  assert.equal(pick.status, 200, JSON.stringify(pick.body));
  assert.equal(pick.body.request.status, 'FULFILLED');
  assert.deepEqual(await w.onHand(b), { quantity: 0, reserved: 0 });
  assert.deepEqual(await w.onHand(a), { quantity: 5, reserved: 0 });
});
