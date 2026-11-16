'use strict';

/**
 * Edge cases owned by Izaz (main PRD), end to end:
 *
 *   4   Duplicate phone numbers — compared after normalisation, so
 *       "098765 43210" and "+919876543210" match. See P4–P6.
 *   9   Invalid or unverified phone — bad formats rejected at input; no SMS to
 *       an unverified or unreachable number; staff tell the patient in person
 *       or print the slip.
 *   10  Patient has no phone — allowed; handover uses request number + name,
 *       and the printed slip is mandatory.
 *
 * Goes through the HTTP API, notification.service, the delivery job and
 * Anushka's referral phone lookup (patientPhone.getUsablePhone), so a change
 * in any of them that breaks these cases fails here. Needs PostgreSQL.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { pool } = require('../src/db/pool');
const migrate = require('../src/db/migrate');
const seeds = require('../src/db/seed');
const { createApp } = require('../src/app');
const notifications = require('../src/modules/notifications/notification.service');
const phones = require('../src/modules/phones/phones.service');
const { deliverDue } = require('../src/modules/notifications/delivery');
const channels = require('../src/modules/notifications/channels');
const patientPhone = require('../src/modules/referrals/patientPhone');

const PASSWORD = process.env.SEED_PASSWORD || 'Dosely@123';
let dbUp = false;
let server;
let base;
const uniq = () => crypto.randomBytes(4).toString('hex');
/** Random Indian mobile as 10 digits, e.g. "98xxxxxxxx" */
const digits10 = () => `98${String(crypto.randomInt(10000000, 99999999))}`;
const sms = () => ({ type: 'REFERRAL_READY', title: 'Medicine held', body: `Dosely: medicine held for you. R-${uniq()}` });

async function api(method, path, { token, body, idem = method === 'POST' } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (idem) headers['idempotency-key'] = `k-${crypto.randomUUID()}`;
  const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function login(email, password = PASSWORD) {
  const r = await api('POST', '/auth/login', { body: { email, password }, idem: false });
  assert.equal(r.status, 200, `login ${email}`);
  return { token: r.body.token, user: r.body.user };
}

async function newPatient(token, fullName = `Edge ${uniq()}`) {
  const r = await api('POST', '/patients', { token, body: { fullName } });
  assert.equal(r.status, 201);
  return r.body;
}

const row = async (id) => (await pool.query('SELECT * FROM notifications WHERE id = $1', [id])).rows[0];

test.before(async () => {
  try {
    await pool.query('SELECT 1');
    dbUp = true;
  } catch (err) {
    console.warn('[edge-cases.izaz.test] skipping:', err.message);
    return;
  }
  await migrate.up({ log: () => {} });
  await seeds.run({ log: () => {} });
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

test.beforeEach(() => {
  channels.stub.sms.reset();
});

test.after(async () => {
  if (server) server.close();
  await pool.end();
});

const t = (name, fn) => test(name, async (ctx) => (dbUp ? fn(ctx) : ctx.skip('no database')));

// ---------------------------------------------------------------------------
// Edge case 4 — duplicate phone numbers
// ---------------------------------------------------------------------------

t('EC4: every way of writing one number is the same number for one owner', async () => {
  const doc = await login('doctor@dosely.dev');
  const p = await newPatient(doc.token);
  const d = digits10();
  const spellings = [`0${d.slice(0, 5)} ${d.slice(5)}`, `+91${d}`, `91${d}`, `(${d.slice(0, 5)})-${d.slice(5)}`, `+91 ${d.slice(0, 5)}.${d.slice(5)}`];

  const first = await api('POST', `/patients/${p.id}/phones`, { token: doc.token, body: { number: d } });
  assert.equal(first.status, 201);
  for (const s of spellings) {
    const r = await api('POST', `/patients/${p.id}/phones`, { token: doc.token, body: { number: s } });
    assert.equal(r.status, 409, s);
    assert.equal(r.body.error.code, 'PHONE_DUPLICATE_FOR_OWNER', s);
  }
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM phone_numbers WHERE owner_type = 'PATIENT' AND owner_id = $1`, [p.id]);
  assert.equal(rows[0].n, 1);
});

t('EC4: editing a number to another spelling of one the owner already has is a duplicate too', async () => {
  const doc = await login('doctor@dosely.dev');
  const p = await newPatient(doc.token);
  const a = digits10();
  await api('POST', `/patients/${p.id}/phones`, { token: doc.token, body: { number: a } });
  const b = (await api('POST', `/patients/${p.id}/phones`, { token: doc.token, body: { number: digits10() } })).body;
  const r = await api('PATCH', `/patients/${p.id}/phones/${b.id}`, { token: doc.token, body: { number: `0${a}` } });
  assert.equal(r.body.error.code, 'PHONE_DUPLICATE_FOR_OWNER');
});

t('EC4 / P5: two patients may share one number however it is written, with a masked warning', async () => {
  const doc = await login('doctor@dosely.dev');
  const mum = await newPatient(doc.token, 'Sunita Rao');
  const kid = await newPatient(doc.token, 'Aarav Rao');
  const d = digits10();
  await api('POST', `/patients/${mum.id}/phones`, { token: doc.token, body: { number: d } });
  const r = await api('POST', `/patients/${kid.id}/phones`, { token: doc.token, body: { number: `+91 ${d}` } });
  assert.equal(r.status, 201);
  assert.equal(r.body.warnings[0].code, 'PHONE_SHARED_WITH_PATIENT');
  assert.deepEqual(r.body.warnings[0].patients, ['S***** R**']);

  // searching by any spelling finds both
  const found = await api('GET', `/patients?phone=${encodeURIComponent(`0${d}`)}`, { token: doc.token });
  assert.deepEqual(found.body.items.map((x) => x.id).sort(), [mum.id, kid.id].sort());
});

t('EC4 / P6: a verified user number in another spelling is still taken; phone login accepts any spelling', async () => {
  const admin = (await login('admin@dosely.dev')).token;
  const email = `ec4-${uniq()}@dosely.dev`;
  const u = (await api('POST', '/users', { token: admin, body: { role: 'SHOPKEEPER', fullName: 'EC4', email, password: 'Secret123' } })).body;
  const me = await login(email, 'Secret123');
  for (const spelling of ['099000 00002', '+91 99000-00002', '919900000002']) {
    const r = await api('POST', `/users/${u.id}/phones`, { token: me.token, body: { number: spelling } });
    assert.equal(r.body.error.code, 'PHONE_TAKEN', spelling);
  }
  for (const spelling of ['9900000002', '+91 99000 00002', '(099000) 00002']) {
    const r = await api('POST', '/auth/login', { idem: false, body: { phone: spelling, password: PASSWORD } });
    assert.equal(r.body.user.email, 'shopkeeper@dosely.dev', spelling);
  }
});

// ---------------------------------------------------------------------------
// Edge case 9 — invalid or unverified phone
// ---------------------------------------------------------------------------

t('EC9: bad formats are rejected at every input (add, edit, search) with 422 PHONE_INVALID_FORMAT', async () => {
  const doc = await login('doctor@dosely.dev');
  const p = await newPatient(doc.token);
  const good = (await api('POST', `/patients/${p.id}/phones`, { token: doc.token, body: { number: digits10() } })).body;
  for (const bad of ['12345', 'call me', '+91 02345 67890', '98765432101', '0000000000']) {
    const add = await api('POST', `/patients/${p.id}/phones`, { token: doc.token, body: { number: bad } });
    assert.deepEqual([add.status, add.body.error.code], [422, 'PHONE_INVALID_FORMAT'], `add ${bad}`);
    const edit = await api('PATCH', `/patients/${p.id}/phones/${good.id}`, { token: doc.token, body: { number: bad } });
    assert.equal(edit.body.error.code, 'PHONE_INVALID_FORMAT', `edit ${bad}`);
    const search = await api('GET', `/patients?phone=${encodeURIComponent(bad)}`, { token: doc.token });
    assert.equal(search.body.error.code, 'PHONE_INVALID_FORMAT', `search ${bad}`);
  }
  // the good number is untouched
  assert.equal((await phones.getById(good.id)).e164, good.e164);
});

t('EC9: no SMS to an unverified number — skipped with a reason, nothing reaches the gateway', async () => {
  const doc = await login('doctor@dosely.dev');
  const p = await newPatient(doc.token);
  const ph = (await api('POST', `/patients/${p.id}/phones`, { token: doc.token, body: { number: digits10() } })).body;

  const msg = sms();
  const r = await notifications.notifyPatient(p.id, { ...msg, data: { doctorUserId: doc.user.id } });
  assert.deepEqual([r.notifications[0].status, r.notifications[0].skipReason], ['SKIPPED', 'NO_VERIFIED_MOBILE']);
  assert.equal(r.skipped.length, 1);
  await deliverDue();
  assert.ok(!channels.stub.sms.outbox.some((m) => m.to === ph.e164 || m.body === msg.body));

  // Anushka's referral flow sees "no usable phone" → slip
  assert.equal(await patientPhone.getUsablePhone(p.id), null);
});

t('EC9: a landline is never used for SMS, even when it is the verified primary', async () => {
  const doc = await login('doctor@dosely.dev');
  const sk = await login('shopkeeper@dosely.dev');
  const p = await newPatient(doc.token);
  const land = (await api('POST', `/patients/${p.id}/phones`, { token: doc.token, body: { number: '080 4123 9876', label: 'HOME' } })).body;
  await api('POST', `/phones/${land.id}/verify`, { token: sk.token });
  assert.equal((await phones.getById(land.id)).isPrimary, true);
  const r = await notifications.notifyPatient(p.id, sms());
  assert.equal(r.notifications[0].skipReason, 'NO_VERIFIED_MOBILE');
  assert.equal(await patientPhone.getUsablePhone(p.id), null);
});

t('EC9: once staff verify the number, SMS goes out — and stops again when it turns unreachable', async () => {
  const doc = await login('doctor@dosely.dev');
  const sk = await login('shopkeeper@dosely.dev');
  const p = await newPatient(doc.token);
  const ph = (await api('POST', `/patients/${p.id}/phones`, { token: doc.token, body: { number: digits10() } })).body;
  assert.equal((await api('POST', `/phones/${ph.id}/verify`, { token: sk.token })).body.status, 'VERIFIED');

  const ok = await notifications.notifyPatient(p.id, sms());
  await deliverDue();
  assert.equal((await row(ok.notifications[0].id)).status, 'SENT');
  assert.equal(channels.stub.sms.outbox.filter((m) => m.to === ph.e164).length, 1);
  assert.equal((await patientPhone.getUsablePhone(p.id)).number, ph.e164);

  // three failures in a row → unreachable → treated like unverified again
  channels.stub.sms.setFailing(ph.e164, true);
  for (let i = 0; i < 3; i += 1) {
    const n = await notifications.notifyPatient(p.id, sms());
    await deliverDue();
    assert.equal((await row(n.notifications[0].id)).last_error !== null, true);
  }
  assert.equal((await phones.getById(ph.id)).status, 'UNREACHABLE');
  const after = await notifications.notifyPatient(p.id, sms());
  assert.equal(after.notifications[0].skipReason, 'PHONE_UNREACHABLE');
  assert.equal(await patientPhone.getUsablePhone(p.id), null);
});

// ---------------------------------------------------------------------------
// Edge case 10 — patient has no phone
// ---------------------------------------------------------------------------

t('EC10: a patient can be created and used with no phone at all', async () => {
  const doc = await login('doctor@dosely.dev');
  const p = await newPatient(doc.token, `No Phone ${uniq()}`);
  assert.deepEqual((await api('GET', `/patients/${p.id}/phones`, { token: doc.token })).body.items, []);
  assert.equal((await api('GET', `/patients/${p.id}`, { token: doc.token })).body.isActive, true);
  const found = await api('GET', `/patients?search=${encodeURIComponent(p.fullName)}`, { token: doc.token });
  assert.deepEqual(found.body.items.map((x) => x.id), [p.id]);
});

t('EC10: SMS to a patient with no phone is SKIPPED (NO_PHONE), nothing queued, referral flow falls back to the slip', async () => {
  const { rows: [meera] } = await pool.query(`SELECT id FROM patients WHERE full_name = 'Meera Pillai' ORDER BY id LIMIT 1`);
  const msg = sms();
  const r = await notifications.notifyPatient(meera.id, msg);
  assert.deepEqual([r.notifications[0].status, r.notifications[0].skipReason, r.notifications[0].phoneId], ['SKIPPED', 'NO_PHONE', null]);
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM notifications WHERE recipient_type = 'PATIENT' AND recipient_id = $1 AND status = 'PENDING'`, [meera.id]);
  assert.equal(rows[0].n, 0);
  await deliverDue();
  assert.ok(!channels.stub.sms.outbox.some((m) => m.body === msg.body));
  assert.equal(await patientPhone.getUsablePhone(meera.id), null);
});

t('EC10: removing a patient\'s last number puts them back in the no-phone case', async () => {
  const doc = await login('doctor@dosely.dev');
  const sk = await login('shopkeeper@dosely.dev');
  const p = await newPatient(doc.token);
  const ph = (await api('POST', `/patients/${p.id}/phones`, { token: doc.token, body: { number: digits10() } })).body;
  await api('POST', `/phones/${ph.id}/verify`, { token: sk.token });
  assert.ok(await patientPhone.getUsablePhone(p.id));
  assert.equal((await api('DELETE', `/patients/${p.id}/phones/${ph.id}`, { token: doc.token })).status, 200);
  assert.equal((await notifications.notifyPatient(p.id, sms())).notifications[0].skipReason, 'NO_PHONE');
  assert.equal(await patientPhone.getUsablePhone(p.id), null);
});
