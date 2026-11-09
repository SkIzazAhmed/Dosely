'use strict';

/**
 * Commit 3 "done when": Rachana and Anushka can use real shops and patients
 * from seeds. Plus rules A6 (shops), A7 (staff), A8 (patients).
 * Needs PostgreSQL; skipped when unreachable. Uses random codes/emails.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { pool } = require('../src/db/pool');
const migrate = require('../src/db/migrate');
const seeds = require('../src/db/seed');
const { createApp } = require('../src/app');
const shopsService = require('../src/modules/shops/shops.service');
const patientsService = require('../src/modules/patients/patients.service');

const PASSWORD = process.env.SEED_PASSWORD || 'Dosely@123';
let dbUp = false;
let server;
let base;
const uniq = () => crypto.randomBytes(3).toString('hex').toUpperCase();
const key = () => `k-${crypto.randomUUID()}`;

async function api(method, path, { token, body, idem = method === 'POST' } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (idem) headers['idempotency-key'] = key();
  const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function login(email, password = PASSWORD) {
  const r = await api('POST', '/auth/login', { body: { email, password }, idem: false });
  assert.equal(r.status, 200, `login ${email}: ${JSON.stringify(r.body)}`);
  return { token: r.body.token, user: r.body.user };
}

async function newShopkeeper(admin) {
  const email = `sk-${uniq().toLowerCase()}@dosely.dev`;
  const r = await api('POST', '/users', { token: admin, body: { role: 'SHOPKEEPER', fullName: 'Keeper', email, password: 'Secret123' } });
  assert.equal(r.status, 201);
  return login(email, 'Secret123');
}

function shopBody(over = {}) {
  const u = uniq();
  return {
    name: `Test Pharmacy ${u}`, code: `t-${u}`, drugLicenceNo: `KA-T-${u}`, address: '1 Test Road, Block A',
    area: 'Testpura', city: 'Bengaluru', pincode: '560001', latitude: 12.97, longitude: 77.59, ...over,
  };
}

test.before(async () => {
  try {
    await pool.query('SELECT 1');
    dbUp = true;
  } catch (err) {
    console.warn('[shops.patients.test] skipping:', err.message);
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

// ---------------------------------------------------------------------------
// Seeds — what Rachana and Anushka build on
// ---------------------------------------------------------------------------

t('seeds: 4 shops with owners/staff, 6 patients, and running seed again adds nothing', async () => {
  const count = async (sql, params) => (await pool.query(sql, params)).rows[0].n;
  const { PATIENTS } = require('../src/db/seeds/002_shops_staff_patients');
  const seededPatients = () => count(
    `SELECT count(*)::int n FROM patients p JOIN users u ON u.id = p.created_by
      WHERE u.email = 'doctor@dosely.dev' AND p.full_name = ANY($1)`, [PATIENTS.map((x) => x.fullName)]);
  const before = {
    shops: await count(`SELECT count(*)::int n FROM shops WHERE code LIKE 'DSL-%'`),
    staff: await count(`SELECT count(*)::int n FROM shop_staff ss JOIN shops s ON s.id = ss.shop_id WHERE s.code LIKE 'DSL-%'`),
    patients: await seededPatients(),
  };
  assert.deepEqual(before, { shops: 4, staff: 5, patients: 6 });
  await seeds.run({ log: () => {} });
  assert.equal(await count(`SELECT count(*)::int n FROM shops WHERE code LIKE 'DSL-%'`), 4);
  assert.equal(await seededPatients(), 6);
});

t('seeded shopkeeper is OWNER of Jayanagar, staff@ is STAFF; mine=true lists their shops', async () => {
  const owner = await login('shopkeeper@dosely.dev');
  const mine = await api('GET', '/shops?mine=true', { token: owner.token });
  assert.equal(mine.status, 200);
  assert.deepEqual(mine.body.items.map((s) => s.code), ['DSL-JAY-01']);
  const shop = await api('GET', `/shops/${mine.body.items[0].id}`, { token: owner.token });
  assert.equal(shop.body.myRole, 'OWNER');

  const staff = await login('staff@dosely.dev');
  const st = await api('GET', `/shops/${shop.body.id}`, { token: staff.token });
  assert.equal(st.body.myRole, 'STAFF');
  const list = await api('GET', `/shops/${shop.body.id}/staff`, { token: staff.token });
  assert.deepEqual(list.body.items.map((s) => [s.email, s.staffRole]), [['shopkeeper@dosely.dev', 'OWNER'], ['staff@dosely.dev', 'STAFF']]);
});

t('doctors can browse shops by area/pincode; inactive Whitefield shop cannot receive requests', async () => {
  const doc = await login('doctor@dosely.dev');
  const byArea = await api('GET', '/shops?area=koramangala', { token: doc.token });
  assert.deepEqual(byArea.body.items.map((s) => s.code), ['DSL-KOR-02']);
  const active = await api('GET', '/shops?isActive=true&search=DSL-', { token: doc.token });
  assert.ok(!active.body.items.some((s) => s.code === 'DSL-WHF-04'));

  const { rows: [whf] } = await pool.query(`SELECT id FROM shops WHERE code = 'DSL-WHF-04'`);
  const { rows: [jay] } = await pool.query(`SELECT id FROM shops WHERE code = 'DSL-JAY-01'`);
  await assert.rejects(shopsService.assertCanReceiveRequests(whf.id), (e) => e.code === 'SHOP_INACTIVE');
  assert.equal((await shopsService.assertCanReceiveRequests(jay.id)).code, 'DSL-JAY-01');
  await assert.rejects(shopsService.assertCanReceiveRequests(999999999), (e) => e.code === 'NOT_FOUND');
});

// ---------------------------------------------------------------------------
// A6 — shops
// ---------------------------------------------------------------------------

t('shopkeeper creates a shop and becomes OWNER; code is uppercased', async () => {
  const admin = (await login('admin@dosely.dev')).token;
  const sk = await newShopkeeper(admin);
  const body = shopBody();
  const r = await api('POST', '/shops', { token: sk.token, body });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.code, body.code.toUpperCase());
  assert.equal(r.body.latitude, 12.97);
  const staff = await shopsService.listStaff(r.body.id);
  assert.deepEqual(staff.map((s) => [s.userId, s.staffRole]), [[sk.user.id, 'OWNER']]);
});

t('shop validation: unique code and licence, 6-digit pincode, lat/long both or neither', async () => {
  const admin = (await login('admin@dosely.dev')).token;
  const sk = await newShopkeeper(admin);
  const first = shopBody();
  assert.equal((await api('POST', '/shops', { token: sk.token, body: first })).status, 201);

  const dupCode = await api('POST', '/shops', { token: sk.token, body: shopBody({ code: first.code.toLowerCase() }) });
  assert.equal(dupCode.body.error.code, 'SHOP_CODE_TAKEN');
  const dupLicence = await api('POST', '/shops', { token: sk.token, body: shopBody({ drugLicenceNo: ` ${first.drugLicenceNo.toLowerCase()} ` }) });
  assert.equal(dupLicence.body.error.code, 'DRUG_LICENCE_TAKEN');

  for (const pincode of ['56001', '5600011', '060001', 'ABCDEF']) {
    const r = await api('POST', '/shops', { token: sk.token, body: shopBody({ pincode }) });
    assert.equal(r.body.error.code, 'INVALID_PINCODE', pincode);
  }
  const onlyLat = await api('POST', '/shops', { token: sk.token, body: shopBody({ longitude: null }) });
  assert.equal(onlyLat.body.error.code, 'INVALID_COORDINATES');
  const neither = await api('POST', '/shops', { token: sk.token, body: shopBody({ latitude: null, longitude: null }) });
  assert.equal(neither.status, 201);
  assert.equal(neither.body.latitude, null);

  // PATCH clearing just one coordinate is rejected against the stored value
  const half = await api('PATCH', `/shops/${neither.body.id}`, { token: sk.token, body: { latitude: 12.9 } });
  assert.equal(half.body.error.code, 'INVALID_COORDINATES');
  const both = await api('PATCH', `/shops/${neither.body.id}`, { token: sk.token, body: { latitude: 12.9, longitude: 77.6 } });
  assert.equal(both.status, 200);
  assert.equal(both.body.longitude, 77.6);
});

t('only OWNER or ADMIN edits/deactivates a shop; doctors and other shopkeepers cannot', async () => {
  const admin = (await login('admin@dosely.dev')).token;
  const owner = await newShopkeeper(admin);
  const other = await newShopkeeper(admin);
  const shop = (await api('POST', '/shops', { token: owner.token, body: shopBody() })).body;
  const doc = (await login('doctor@dosely.dev')).token;

  assert.equal((await api('POST', '/shops', { token: doc, body: shopBody() })).status, 403);
  assert.equal((await api('PATCH', `/shops/${shop.id}`, { token: other.token, body: { name: 'Hijack' } })).body.error.code, 'NOT_SHOP_STAFF');
  assert.equal((await api('PATCH', `/shops/${shop.id}`, { token: owner.token, body: { name: 'Renamed Pharmacy' } })).body.name, 'Renamed Pharmacy');

  const off = await api('DELETE', `/shops/${shop.id}`, { token: owner.token });
  assert.equal(off.body.isActive, false);
  await assert.rejects(shopsService.assertCanReceiveRequests(shop.id), (e) => e.code === 'SHOP_INACTIVE');
  assert.equal((await api('POST', `/shops/${shop.id}/activate`, { token: admin })).body.isActive, true);
  const { rowCount } = await pool.query('SELECT 1 FROM shops WHERE id = $1', [shop.id]);
  assert.equal(rowCount, 1);

  // ADMIN creating a shop must name a SHOPKEEPER owner
  const noOwner = await api('POST', '/shops', { token: admin, body: shopBody() });
  assert.equal(noOwner.body.error.code, 'VALIDATION_ERROR');
  const docId = (await login('doctor@dosely.dev')).user.id;
  const docOwner = await api('POST', '/shops', { token: admin, body: shopBody({ ownerUserId: docId }) });
  assert.equal(docOwner.body.error.code, 'SHOPKEEPER_ROLE_REQUIRED');
  const okAdmin = await api('POST', '/shops', { token: admin, body: shopBody({ ownerUserId: other.user.id }) });
  assert.equal(okAdmin.status, 201);
});

// ---------------------------------------------------------------------------
// A7 — staff
// ---------------------------------------------------------------------------

t('staff: only OWNER adds/changes/removes; last OWNER is protected; removed staff lose access', async () => {
  const admin = (await login('admin@dosely.dev')).token;
  const owner = await newShopkeeper(admin);
  const s1 = await newShopkeeper(admin);
  const s2 = await newShopkeeper(admin);
  const shop = (await api('POST', '/shops', { token: owner.token, body: shopBody() })).body;
  const path = `/shops/${shop.id}/staff`;

  const added = await api('POST', path, { token: owner.token, body: { userId: s1.user.id } });
  assert.equal(added.status, 201);
  assert.equal(added.body.staffRole, 'STAFF');
  assert.equal((await api('POST', path, { token: owner.token, body: { userId: s1.user.id } })).body.error.code, 'STAFF_ALREADY_EXISTS');

  // STAFF can view but not edit staff
  assert.equal((await api('GET', path, { token: s1.token })).status, 200);
  assert.equal((await api('POST', path, { token: s1.token, body: { userId: s2.user.id } })).body.error.code, 'NOT_SHOP_OWNER');

  // Only SHOPKEEPER users can be staff
  const docId = (await login('doctor@dosely.dev')).user.id;
  assert.equal((await api('POST', path, { token: owner.token, body: { userId: docId } })).body.error.code, 'SHOPKEEPER_ROLE_REQUIRED');

  // Last OWNER can't step down or be removed
  assert.equal((await api('PATCH', `${path}/${owner.user.id}`, { token: owner.token, body: { staffRole: 'STAFF' } })).body.error.code, 'LAST_OWNER');
  assert.equal((await api('DELETE', `${path}/${owner.user.id}`, { token: owner.token })).body.error.code, 'LAST_OWNER');

  // Promote s1, then the original owner can step down
  assert.equal((await api('PATCH', `${path}/${s1.user.id}`, { token: owner.token, body: { staffRole: 'OWNER' } })).body.staffRole, 'OWNER');
  assert.equal((await api('PATCH', `${path}/${owner.user.id}`, { token: owner.token, body: { staffRole: 'STAFF' } })).body.staffRole, 'STAFF');

  // Removed staff: no access, no notifications
  await api('POST', path, { token: s1.token, body: { userId: s2.user.id } });
  assert.deepEqual((await shopsService.listActiveStaffUserIds(shop.id)).sort(), [owner.user.id, s1.user.id, s2.user.id].sort());
  const removed = await api('DELETE', `${path}/${s2.user.id}`, { token: s1.token });
  assert.equal(removed.body.isActive, false);
  assert.equal((await api('GET', path, { token: s2.token })).body.error.code, 'NOT_SHOP_STAFF');
  assert.ok(!(await shopsService.listActiveStaffUserIds(shop.id)).includes(s2.user.id));
  const history = await api('GET', `${path}?includeRemoved=true`, { token: s1.token });
  assert.equal(history.body.items.length, 3);

  // Re-adding a removed member re-activates them
  const back = await api('POST', path, { token: s1.token, body: { userId: s2.user.id, staffRole: 'STAFF' } });
  assert.equal(back.status, 201);
  assert.equal(back.body.isActive, true);

  // Deactivated users drop out of notification fan-out too
  await api('DELETE', `/users/${s2.user.id}`, { token: admin });
  assert.ok(!(await shopsService.listActiveStaffUserIds(shop.id)).includes(s2.user.id));
});

// ---------------------------------------------------------------------------
// A8 — patients
// ---------------------------------------------------------------------------

t('patients: name required, DOB/gender optional, DOB as YYYY-MM-DD with age', async () => {
  const doc = await login('doctor@dosely.dev');
  const r = await api('POST', '/patients', { token: doc.token, body: { fullName: '  Asha Verma ', dateOfBirth: '2000-02-29', gender: 'FEMALE' } });
  assert.equal(r.status, 201);
  assert.equal(r.body.fullName, 'Asha Verma');
  assert.equal(r.body.dateOfBirth, '2000-02-29');
  assert.ok(r.body.age >= 26);
  assert.equal(r.body.createdBy, doc.user.id);

  const minimal = await api('POST', '/patients', { token: doc.token, body: { fullName: 'Just A Name' } });
  assert.equal(minimal.status, 201);
  assert.equal(minimal.body.dateOfBirth, null);
  assert.equal(minimal.body.gender, null);

  const bad = await api('POST', '/patients', { token: doc.token, body: { dateOfBirth: '2999-01-01', gender: 'X' } });
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.body.error.details.map((d) => d.field), ['fullName', 'dateOfBirth', 'gender']);
  const notReal = await api('POST', '/patients', { token: doc.token, body: { fullName: 'A', dateOfBirth: '2001-02-29' } });
  assert.equal(notReal.body.error.details[0].issue, 'is not a real date');
});

t('patients: shopkeepers can add/search; only creator or ADMIN deactivates; assertActive', async () => {
  const doc = await login('doctor@dosely.dev');
  const sk = await login('shopkeeper@dosely.dev');
  const name = `Walk-in ${uniq()}`;
  const p = (await api('POST', '/patients', { token: sk.token, body: { fullName: name } })).body;

  const found = await api('GET', `/patients?search=${encodeURIComponent(name.slice(0, 10))}`, { token: doc.token });
  assert.ok(found.body.items.some((x) => x.id === p.id));
  assert.equal((await api('PATCH', `/patients/${p.id}`, { token: doc.token, body: { gender: 'MALE' } })).body.gender, 'MALE');

  assert.equal((await api('DELETE', `/patients/${p.id}`, { token: doc.token })).status, 403);
  const off = await api('DELETE', `/patients/${p.id}`, { token: sk.token });
  assert.equal(off.body.isActive, false);
  await assert.rejects(patientsService.assertActive(p.id), (e) => e.code === 'PATIENT_INACTIVE');
  assert.equal((await api('PATCH', `/patients/${p.id}`, { token: sk.token, body: { fullName: 'x' } })).body.error.code, 'PATIENT_INACTIVE');
  await assert.rejects(patientsService.assertActive(999999999), (e) => e.code === 'NOT_FOUND');

  const admin = (await login('admin@dosely.dev')).token;
  assert.equal((await api('POST', `/patients/${p.id}/activate`, { token: admin })).body.isActive, true);
  assert.equal((await api('GET', '/patients/abc', { token: doc.token })).status, 404);
});
