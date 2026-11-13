'use strict';

/**
 * Phone numbers through the API: rules P4–P10 (Commit 4), plus phone login,
 * patient search by phone and the seeded numbers. Needs PostgreSQL.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { pool } = require('../src/db/pool');
const migrate = require('../src/db/migrate');
const seeds = require('../src/db/seed');
const { createApp } = require('../src/app');

const PASSWORD = process.env.SEED_PASSWORD || 'Dosely@123';
let dbUp = false;
let server;
let base;
const uniq = () => crypto.randomBytes(3).toString('hex');
// Random valid Indian mobile, so tests never collide with each other or the seeds
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

async function newPatient(token, name = `Patient ${uniq()}`) {
  const r = await api('POST', '/patients', { token, body: { fullName: name } });
  assert.equal(r.status, 201);
  return r.body;
}

test.before(async () => {
  try {
    await pool.query('SELECT 1');
    dbUp = true;
  } catch (err) {
    console.warn('[phones.test] skipping:', err.message);
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

t('P1–P3 through the API: stored normalised; bad format 422; landline needs HOME/WORK/SHOP', async () => {
  const doc = await login('doctor@dosely.dev');
  const p = await newPatient(doc.token);
  const path = `/patients/${p.id}/phones`;

  const r = await api('POST', path, { token: doc.token, body: { number: '098100 11122' } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.e164, '+919810011122');
  assert.equal(r.body.kind, 'MOBILE');

  assert.equal((await api('POST', path, { token: doc.token, body: { number: '12345' } })).body.error.code, 'PHONE_INVALID_FORMAT');
  const land = await api('POST', path, { token: doc.token, body: { number: '080-4123 4567' } });
  assert.equal(land.status, 422);
  assert.equal(land.body.error.code, 'PHONE_NOT_MOBILE');
  const home = await api('POST', path, { token: doc.token, body: { number: '080-4123 4567', label: 'HOME' } });
  assert.equal(home.status, 201);
  assert.equal(home.body.kind, 'LANDLINE');
  assert.equal(home.body.smsCapable, false);
  assert.equal((await api('PATCH', `${path}/${home.body.id}`, { token: doc.token, body: { label: 'MOBILE' } })).body.error.code, 'PHONE_NOT_MOBILE');
});

t('P4 + edge case 4: the same number twice on one owner is rejected after normalisation', async () => {
  const doc = await login('doctor@dosely.dev');
  const p = await newPatient(doc.token);
  const n = mobile();
  assert.equal((await api('POST', `/patients/${p.id}/phones`, { token: doc.token, body: { number: n } })).status, 201);
  const dup = await api('POST', `/patients/${p.id}/phones`, { token: doc.token, body: { number: `0${n.slice(0, 5)} ${n.slice(5)}` } });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'PHONE_DUPLICATE_FOR_OWNER');
});

t('P5: same number on two patients is allowed, with a masked-name warning', async () => {
  const doc = await login('doctor@dosely.dev');
  const a = await newPatient(doc.token, 'Kavya Sharma');
  const b = await newPatient(doc.token, 'Dev Sharma');
  const n = mobile();
  const first = await api('POST', `/patients/${a.id}/phones`, { token: doc.token, body: { number: n } });
  assert.deepEqual(first.body.warnings, []);
  const second = await api('POST', `/patients/${b.id}/phones`, { token: doc.token, body: { number: n } });
  assert.equal(second.status, 201);
  assert.equal(second.body.warnings[0].code, 'PHONE_SHARED_WITH_PATIENT');
  assert.ok(second.body.warnings[0].patients.includes('K**** S*****'));
  assert.ok(!JSON.stringify(second.body).includes('Kavya'));
});

t('P6: a number verified for one user cannot be added to another user', async () => {
  const admin = (await login('admin@dosely.dev')).token;
  const email = `p6-${uniq()}@dosely.dev`;
  const u = (await api('POST', '/users', { token: admin, body: { role: 'DOCTOR', fullName: 'P6 Doc', email, password: 'Secret123' } })).body;
  const me = await login(email, 'Secret123');
  // +919900000001 is the seeded doctor's verified number
  const taken = await api('POST', `/users/${u.id}/phones`, { token: me.token, body: { number: '99000 00001' } });
  assert.equal(taken.status, 409);
  assert.equal(taken.body.error.code, 'PHONE_TAKEN');
  // ...but a patient can share it (patients aren't login identities)
  const doc = await login('doctor@dosely.dev');
  const p = await newPatient(doc.token);
  assert.equal((await api('POST', `/patients/${p.id}/phones`, { token: doc.token, body: { number: '+919900000001' } })).status, 201);
});

t('P7: at most 5 active numbers; removing one frees a slot', async () => {
  const doc = await login('doctor@dosely.dev');
  const p = await newPatient(doc.token);
  const path = `/patients/${p.id}/phones`;
  const ids = [];
  for (let i = 0; i < 5; i += 1) {
    const r = await api('POST', path, { token: doc.token, body: { number: mobile() } });
    assert.equal(r.status, 201);
    ids.push(r.body.id);
  }
  const sixth = await api('POST', path, { token: doc.token, body: { number: mobile() } });
  assert.equal(sixth.status, 422);
  assert.equal(sixth.body.error.code, 'PHONE_LIMIT');
  assert.equal((await api('DELETE', `${path}/${ids[4]}`, { token: doc.token })).status, 200);
  assert.equal((await api('POST', path, { token: doc.token, body: { number: mobile() } })).status, 201);
});

t('P8/P9: first number is primary; setting a new primary unsets the old one', async () => {
  const doc = await login('doctor@dosely.dev');
  const p = await newPatient(doc.token);
  const path = `/patients/${p.id}/phones`;
  const a = (await api('POST', path, { token: doc.token, body: { number: mobile() } })).body;
  const b = (await api('POST', path, { token: doc.token, body: { number: mobile() } })).body;
  assert.equal(a.isPrimary, true);
  assert.equal(b.isPrimary, false);

  assert.equal((await api('PATCH', `${path}/${b.id}`, { token: doc.token, body: { isPrimary: true } })).body.isPrimary, true);
  const list = (await api('GET', path, { token: doc.token })).body.items;
  assert.deepEqual(list.map((x) => [x.id, x.isPrimary]), [[b.id, true], [a.id, false]]);

  // Adding with isPrimary: true switches in one go
  const c = (await api('POST', path, { token: doc.token, body: { number: mobile(), isPrimary: true } })).body;
  assert.equal(c.isPrimary, true);
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM phone_numbers WHERE owner_type = 'PATIENT' AND owner_id = $1 AND is_primary AND is_active`, [p.id]);
  assert.equal(rows[0].n, 1);

  // Unsetting the primary directly isn't allowed — pick a new one instead
  assert.equal((await api('PATCH', `${path}/${c.id}`, { token: doc.token, body: { isPrimary: false } })).body.error.code, 'PHONE_PRIMARY_REQUIRED');
});

t('P9 under concurrency: parallel "make primary" calls leave exactly one primary', async () => {
  const doc = await login('doctor@dosely.dev');
  const p = await newPatient(doc.token);
  const path = `/patients/${p.id}/phones`;
  const ids = [];
  for (let i = 0; i < 4; i += 1) ids.push((await api('POST', path, { token: doc.token, body: { number: mobile() } })).body.id);
  const results = await Promise.all(ids.map((id) => api('PATCH', `${path}/${id}`, { token: doc.token, body: { isPrimary: true } })));
  assert.ok(results.every((r) => r.status === 200));
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM phone_numbers WHERE owner_type = 'PATIENT' AND owner_id = $1 AND is_primary AND is_active`, [p.id]);
  assert.equal(rows[0].n, 1);
});

t('P10: primary cannot be removed while other numbers exist; the last one can', async () => {
  const doc = await login('doctor@dosely.dev');
  const p = await newPatient(doc.token);
  const path = `/patients/${p.id}/phones`;
  const a = (await api('POST', path, { token: doc.token, body: { number: mobile() } })).body;
  const b = (await api('POST', path, { token: doc.token, body: { number: mobile() } })).body;

  const blocked = await api('DELETE', `${path}/${a.id}`, { token: doc.token });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error.code, 'PHONE_PRIMARY_REQUIRED');

  assert.equal((await api('DELETE', `${path}/${b.id}`, { token: doc.token })).body.isActive, false);
  const last = await api('DELETE', `${path}/${a.id}`, { token: doc.token });
  assert.equal(last.status, 200);
  assert.equal(last.body.isPrimary, false);
  assert.deepEqual((await api('GET', path, { token: doc.token })).body.items, []);
  assert.equal((await api('GET', `${path}?includeRemoved=true`, { token: doc.token })).body.items.length, 2);
  const { rowCount } = await pool.query('SELECT 1 FROM phone_numbers WHERE id = $1', [a.id]);
  assert.equal(rowCount, 1, 'deactivated, not deleted');
});

t('access: users manage only their own numbers; shop numbers need the OWNER; patients need a staff role', async () => {
  const doc = await login('doctor@dosely.dev');
  const other = await login('shopkeeper@dosely.dev');
  assert.equal((await api('GET', `/users/${doc.user.id}/phones`, { token: other.token })).status, 403);
  assert.equal((await api('GET', `/users/${doc.user.id}/phones`, { token: doc.token })).body.items[0].e164, '+919900000001');

  const { rows: [jay] } = await pool.query(`SELECT id FROM shops WHERE code = 'DSL-JAY-01'`);
  const shopPhones = await api('GET', `/shops/${jay.id}/phones`, { token: doc.token });
  assert.deepEqual(shopPhones.body.items.map((x) => [x.e164, x.label, x.isPrimary]),
    [['+918026630000', 'SHOP', true], ['+919810000201', 'MOBILE', false]]);
  assert.equal((await api('POST', `/shops/${jay.id}/phones`, { token: doc.token, body: { number: mobile() } })).status, 403);
  const staff = await login('staff@dosely.dev');
  assert.equal((await api('POST', `/shops/${jay.id}/phones`, { token: staff.token, body: { number: mobile() } })).body.error.code, 'NOT_SHOP_OWNER');

  // a phone id that belongs to a different owner is 404 on this owner's path
  const docPhoneId = (await api('GET', `/users/${doc.user.id}/phones`, { token: doc.token })).body.items[0].id;
  assert.equal((await api('PATCH', `/shops/${jay.id}/phones/${docPhoneId}`, { token: other.token, body: { label: 'WORK' } })).status, 404);

  // inactive patients can't get new numbers
  const p = await newPatient(doc.token);
  await api('DELETE', `/patients/${p.id}`, { token: doc.token });
  assert.equal((await api('POST', `/patients/${p.id}/phones`, { token: doc.token, body: { number: mobile() } })).body.error.code, 'PATIENT_INACTIVE');
});

t('login by verified phone; unverified or unknown phone fails like a wrong password', async () => {
  const ok = await api('POST', '/auth/login', { idem: false, body: { phone: '099000 00001', password: PASSWORD } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.user.email, 'doctor@dosely.dev');
  for (const phone of ['+919810000105', '9999999999', 'not-a-phone']) {
    const r = await api('POST', '/auth/login', { idem: false, body: { phone, password: PASSWORD } });
    assert.equal(r.body.error.code, 'INVALID_CREDENTIALS', phone);
  }
  assert.equal((await api('POST', '/auth/login', { idem: false, body: { password: PASSWORD } })).body.error.code, 'VALIDATION_ERROR');
});

t('patient search by phone matches after normalisation; seeded shared number finds both patients', async () => {
  const doc = await login('doctor@dosely.dev');
  const r = await api('GET', `/patients?phone=${encodeURIComponent('098100 00102')}`, { token: doc.token });
  const names = r.body.items.map((x) => x.fullName);
  assert.ok(names.includes('Priya Nair') && names.includes('Rohan Das'), names.join());
  assert.equal((await api('GET', '/patients?phone=123', { token: doc.token })).body.error.code, 'PHONE_INVALID_FORMAT');
});

t('seeds: Meera Pillai has no phone (edge case 10); Sam Thomas only an unverified one (edge case 9); rerun adds nothing', async () => {
  const count = async () => (await pool.query('SELECT count(*)::int AS n FROM phone_numbers')).rows[0].n;
  const { rows: meera } = await pool.query(
    `SELECT ph.id FROM phone_numbers ph JOIN patients p ON p.id = ph.patient_id WHERE p.full_name = 'Meera Pillai'`);
  assert.equal(meera.length, 0);
  const { rows: sam } = await pool.query(
    `SELECT ph.status FROM phone_numbers ph JOIN patients p ON p.id = ph.patient_id WHERE p.full_name = 'Sam Thomas'`);
  assert.deepEqual(sam.map((x) => x.status), ['UNVERIFIED']);
  const before = await count();
  await seeds.run({ log: () => {} });
  assert.equal(await count(), before);
});
