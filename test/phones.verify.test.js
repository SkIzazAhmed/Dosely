'use strict';

/** Rules P11–P13 and verification by staff confirmation (Commit 5). Needs PostgreSQL. */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { pool } = require('../src/db/pool');
const migrate = require('../src/db/migrate');
const seeds = require('../src/db/seed');
const { createApp } = require('../src/app');
const phones = require('../src/modules/phones/phones.service');
const notifications = require('../src/modules/notifications/notification.service');

const PASSWORD = process.env.SEED_PASSWORD || 'Dosely@123';
let dbUp = false;
let server;
let base;
const uniq = () => crypto.randomBytes(3).toString('hex');
const mobile = () => `98${String(crypto.randomInt(10000000, 99999999))}`;

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
  assert.equal(r.status, 200, `login ${email}: ${JSON.stringify(r.body)}`);
  return { token: r.body.token, user: r.body.user };
}

async function newUser(adminToken, role) {
  const email = `${role.toLowerCase()}-${uniq()}@dosely.dev`;
  const r = await api('POST', '/users', { token: adminToken, body: { role, fullName: `${role} ${uniq()}`, email, password: 'Secret123' } });
  assert.equal(r.status, 201);
  return login(email, 'Secret123');
}

test.before(async () => {
  try {
    await pool.query('SELECT 1');
    dbUp = true;
  } catch (err) {
    console.warn('[phones.verify.test] skipping:', err.message);
    return;
  }
  await migrate.up({ log: () => {} });
  await seeds.run({ log: () => {} });
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) server.close();
  await pool.end();
});

const t = (name, fn) => test(name, async (ctx) => (dbUp ? fn(ctx) : ctx.skip('no database')));

t('verify: staff confirmation sets VERIFIED with who and when', async () => {
  const doc = await login('doctor@dosely.dev');
  const sk = await login('shopkeeper@dosely.dev');
  const p = (await api('POST', '/patients', { token: doc.token, body: { fullName: `V ${uniq()}` } })).body;
  const ph = (await api('POST', `/patients/${p.id}/phones`, { token: doc.token, body: { number: mobile() } })).body;
  assert.equal(ph.status, 'UNVERIFIED');
  assert.equal(ph.smsCapable, false);

  const v = await api('POST', `/phones/${ph.id}/verify`, { token: sk.token });
  assert.equal(v.status, 200);
  assert.equal(v.body.status, 'VERIFIED');
  assert.equal(v.body.verifiedBy, sk.user.id);
  assert.ok(v.body.verifiedAt);
  assert.equal(v.body.smsCapable, true);
  assert.equal((await api('POST', '/phones/999999999/verify', { token: sk.token })).status, 404);
});

t('verify permissions: no self-confirmation; shop OWNER confirms their staff; doctors only patients', async () => {
  const admin = (await login('admin@dosely.dev')).token;
  const owner = await newUser(admin, 'SHOPKEEPER');
  const newbie = await newUser(admin, 'SHOPKEEPER');
  const u = uniq().toUpperCase();
  const shop = (await api('POST', '/shops', { token: owner.token, body: {
    name: `Verify ${u}`, code: `VF-${u}`, drugLicenceNo: `KA-VF-${u}`, address: '2 Test Road', area: 'Testpura', pincode: '560001' } })).body;
  assert.equal((await api('POST', `/shops/${shop.id}/staff`, { token: owner.token, body: { userId: newbie.user.id } })).status, 201);

  const ph = (await api('POST', `/users/${newbie.user.id}/phones`, { token: newbie.token, body: { number: mobile() } })).body;
  assert.equal((await api('POST', `/phones/${ph.id}/verify`, { token: newbie.token })).status, 403, 'not their own');
  const doc = await login('doctor@dosely.dev');
  assert.equal((await api('POST', `/phones/${ph.id}/verify`, { token: doc.token })).status, 403, 'doctors confirm patients only');
  const otherOwner = await login('owner.ind@dosely.dev');
  assert.equal((await api('POST', `/phones/${ph.id}/verify`, { token: otherOwner.token })).status, 403, 'owner of a different shop');
  assert.equal((await api('POST', `/phones/${ph.id}/verify`, { token: owner.token })).body.status, 'VERIFIED');

  // shop numbers: that shop's staff (any role) can confirm
  const shopPh = (await api('POST', `/shops/${shop.id}/phones`, { token: owner.token, body: { number: mobile() } })).body;
  assert.equal((await api('POST', `/phones/${shopPh.id}/verify`, { token: newbie.token })).body.status, 'VERIFIED');
  assert.equal((await api('POST', `/phones/${shopPh.id}/verify`, { token: otherOwner.token })).status, 403);
});

t('P11: a user cannot switch primary to an unverified number; patients can', async () => {
  const admin = (await login('admin@dosely.dev')).token;
  const u = await newUser(admin, 'DOCTOR');
  const path = `/users/${u.user.id}/phones`;
  const first = (await api('POST', path, { token: u.token, body: { number: mobile() } })).body;   // P8: primary, unverified
  assert.equal(first.isPrimary, true);
  await api('POST', `/phones/${first.id}/verify`, { token: admin });
  const second = (await api('POST', path, { token: u.token, body: { number: mobile() } })).body;

  const blocked = await api('PATCH', `${path}/${second.id}`, { token: u.token, body: { isPrimary: true } });
  assert.equal(blocked.status, 422);
  assert.equal(blocked.body.error.code, 'PHONE_NOT_VERIFIED');
  assert.equal((await api('POST', path, { token: u.token, body: { number: mobile(), isPrimary: true } })).body.error.code, 'PHONE_NOT_VERIFIED');

  await api('POST', `/phones/${second.id}/verify`, { token: admin });
  assert.equal((await api('PATCH', `${path}/${second.id}`, { token: u.token, body: { isPrimary: true } })).body.isPrimary, true);

  // patients may have an unverified primary
  const doc = await login('doctor@dosely.dev');
  const p = (await api('POST', '/patients', { token: doc.token, body: { fullName: `P11 ${uniq()}` } })).body;
  await api('POST', `/patients/${p.id}/phones`, { token: doc.token, body: { number: mobile() } });
  const b = (await api('POST', `/patients/${p.id}/phones`, { token: doc.token, body: { number: mobile(), isPrimary: true } })).body;
  assert.equal(b.isPrimary, true);
  assert.equal(b.status, 'UNVERIFIED');
});

t('P12: editing the digits resets verification and failure tracking; same digits keep it', async () => {
  const doc = await login('doctor@dosely.dev');
  const admin = (await login('admin@dosely.dev')).token;
  const p = (await api('POST', '/patients', { token: doc.token, body: { fullName: `P12 ${uniq()}` } })).body;
  const path = `/patients/${p.id}/phones`;
  const n = mobile();
  const ph = (await api('POST', path, { token: doc.token, body: { number: n } })).body;
  await api('POST', `/phones/${ph.id}/verify`, { token: admin });
  await phones.recordDeliveryFailure(ph.id);

  const same = await api('PATCH', `${path}/${ph.id}`, { token: doc.token, body: { number: `0${n}` } });
  assert.equal(same.body.status, 'VERIFIED', 'same number written differently is not an edit');

  const changed = await api('PATCH', `${path}/${ph.id}`, { token: doc.token, body: { number: mobile() } });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.status, 'UNVERIFIED');
  assert.equal(changed.body.verifiedAt, null);
  assert.equal(changed.body.verifiedBy, null);
  assert.equal(changed.body.consecutiveFailures, 0);
  assert.equal(changed.body.isPrimary, true, 'still the primary');

  // P4 and P3 still apply to edits
  const other = (await api('POST', path, { token: doc.token, body: { number: mobile() } })).body;
  assert.equal((await api('PATCH', `${path}/${other.id}`, { token: doc.token, body: { number: changed.body.e164 } })).body.error.code, 'PHONE_DUPLICATE_FOR_OWNER');
  assert.equal((await api('PATCH', `${path}/${other.id}`, { token: doc.token, body: { number: '080 4111 2222' } })).body.error.code, 'PHONE_NOT_MOBILE');
  assert.equal((await api('PATCH', `${path}/${other.id}`, { token: doc.token, body: { number: '080 4111 2222', label: 'WORK' } })).body.kind, 'LANDLINE');
});

t("P11/P12: a user's verified primary can't have its digits changed while they have other numbers", async () => {
  const admin = (await login('admin@dosely.dev')).token;
  const u = await newUser(admin, 'SHOPKEEPER');
  const path = `/users/${u.user.id}/phones`;
  const a = (await api('POST', path, { token: u.token, body: { number: mobile() } })).body;
  await api('POST', `/phones/${a.id}/verify`, { token: admin });
  await api('POST', path, { token: u.token, body: { number: mobile() } });
  const r = await api('PATCH', `${path}/${a.id}`, { token: u.token, body: { number: mobile() } });
  assert.equal(r.body.error.code, 'PHONE_NOT_VERIFIED');
});

t('P6 on verify: two users with the same unverified number — only the first to verify keeps it', async () => {
  const admin = (await login('admin@dosely.dev')).token;
  const u1 = await newUser(admin, 'DOCTOR');
  const u2 = await newUser(admin, 'DOCTOR');
  const n = mobile();
  const a = (await api('POST', `/users/${u1.user.id}/phones`, { token: u1.token, body: { number: n } })).body;
  const b = (await api('POST', `/users/${u2.user.id}/phones`, { token: u2.token, body: { number: n } })).body;
  assert.equal((await api('POST', `/phones/${a.id}/verify`, { token: admin })).body.status, 'VERIFIED');
  const second = await api('POST', `/phones/${b.id}/verify`, { token: admin });
  assert.equal(second.status, 409);
  assert.equal(second.body.error.code, 'PHONE_TAKEN');
});

t('P13: 3 consecutive failures mark a verified number UNREACHABLE; success resets; re-verify clears', async () => {
  const doc = await login('doctor@dosely.dev');
  const admin = (await login('admin@dosely.dev')).token;
  const p = (await api('POST', '/patients', { token: doc.token, body: { fullName: `P13 ${uniq()}` } })).body;
  const ph = (await api('POST', `/patients/${p.id}/phones`, { token: doc.token, body: { number: mobile() } })).body;
  await api('POST', `/phones/${ph.id}/verify`, { token: admin });

  await phones.recordDeliveryFailure(ph.id);
  await phones.recordDeliveryFailure(ph.id);
  assert.equal((await phones.recordDeliverySuccess(ph.id)).consecutiveFailures, 0, 'a success breaks the streak');

  const r1 = await phones.recordDeliveryFailure(ph.id);
  const r2 = await phones.recordDeliveryFailure(ph.id);
  const r3 = await phones.recordDeliveryFailure(ph.id);
  assert.deepEqual([r1.becameUnreachable, r2.becameUnreachable, r3.becameUnreachable], [false, false, true]);
  assert.equal(r3.phone.status, 'UNREACHABLE');
  assert.ok(r3.phone.unreachableAt);
  assert.equal((await phones.recordDeliveryFailure(ph.id)).becameUnreachable, false, 'only flips once');
  assert.equal((await phones.pickSmsPhone('PATIENT', p.id)).reason, 'PHONE_UNREACHABLE');

  const again = await api('POST', `/phones/${ph.id}/verify`, { token: admin });
  assert.equal(again.body.status, 'VERIFIED');
  assert.equal(again.body.consecutiveFailures, 0);
  assert.equal(again.body.unreachableAt, null);
});

t('P13 alert: the shop named in the SMS data (or the patient\'s doctor) gets an in-app alert', async () => {
  const doc = await login('doctor@dosely.dev');
  const admin = (await login('admin@dosely.dev')).token;
  const { rows: [jay] } = await pool.query(`SELECT id FROM shops WHERE code = 'DSL-JAY-01'`);
  const p = (await api('POST', '/patients', { token: doc.token, body: { fullName: `Alert ${uniq()}` } })).body;
  const ph = (await api('POST', `/patients/${p.id}/phones`, { token: doc.token, body: { number: mobile() } })).body;
  await api('POST', `/phones/${ph.id}/verify`, { token: admin });
  let last;
  for (let i = 0; i < 3; i += 1) last = await phones.recordDeliveryFailure(ph.id);

  await notifications.alertPhoneUnreachable(last.phone, { shopId: jay.id });
  const owner = await login('shopkeeper@dosely.dev');
  const inbox = (await api('GET', '/notifications?unreadOnly=true&limit=5', { token: owner.token })).body;
  const alert = inbox.items.find((x) => x.type === 'PHONE_UNREACHABLE' && x.data.phoneId === ph.id);
  assert.ok(alert, 'owner sees the alert');
  assert.match(alert.body, /failed 3 times/);
  assert.ok(!alert.body.includes(ph.e164.slice(3)), 'number is masked');

  // no shop in context → the doctor who added the patient
  await notifications.alertPhoneUnreachable(last.phone, {});
  const docInbox = (await api('GET', '/notifications?limit=5', { token: doc.token })).body;
  assert.ok(docInbox.items.some((x) => x.type === 'PHONE_UNREACHABLE' && x.data.phoneId === ph.id));
});
