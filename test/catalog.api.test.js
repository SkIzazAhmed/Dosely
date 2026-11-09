'use strict';

/**
 * Commit 2 "done when": an admin can create a medicine with batches and
 * search returns it. Plus B1–B3 rules and edge case 5 over HTTP.
 * Needs PostgreSQL (DATABASE_URL); skipped when unreachable.
 * Uses random names, so it's safe on a dev database.
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
let admin;
let doctor;

const uniq = () => crypto.randomBytes(4).toString('hex');
const key = () => `k-${uniq()}`;
const days = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

async function api(method, path, { token, body, idem } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (idem) headers['idempotency-key'] = idem;
  const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}

async function login(email) {
  const r = await api('POST', '/auth/login', { body: { email, password: PASSWORD } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.token;
}

test.before(async () => {
  try {
    await pool.query('SELECT 1');
    dbUp = true;
  } catch (err) {
    console.warn('[catalog.api.test] skipping:', err.message);
    return;
  }
  await migrate.up({ log: () => {} });
  await seeds.run({ log: () => {} });
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  admin = await login('admin@dosely.dev');
  doctor = await login('doctor@dosely.dev');
});

test.after(async () => {
  if (server) server.close();
  await pool.end();
});

const t = (name, fn) => test(name, async (ctx) => (dbUp ? fn(ctx) : ctx.skip('no database')));

function medicineBody(extra = {}) {
  return {
    brandName: `Dolo ${uniq()}`,
    genericName: `Paracetamol-${uniq()}`,
    manufacturer: 'Micro Labs',
    dosageForm: 'TABLET',
    strength: '650 mg',
    baseUnit: 'TABLET',
    ...extra,
  };
}

t('admin creates a medicine with batches; search finds it by brand, generic and manufacturer', async () => {
  const body = medicineBody({
    batches: [
      { batchNo: 'dl2401 ', manufactureDate: days(-60), expiryDate: days(400), mrp: 2.1 },
      { batchNo: 'DL2402', expiryDate: days(200), mrp: '2.25' },
    ],
  });
  const r = await api('POST', '/medicines', { token: admin, body, idem: key() });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.prescriptionRequired, true);
  assert.equal(r.body.generic.name, body.genericName);
  assert.deepEqual(r.body.batches.map((b) => [b.batchNo, b.mrp]), [['DL2401', 2.1], ['DL2402', 2.25]]);

  for (const q of [body.brandName.toLowerCase(), body.genericName.toUpperCase()]) {
    const s = await api('GET', `/medicines?q=${encodeURIComponent(q)}`, { token: doctor });
    assert.equal(s.status, 200);
    assert.deepEqual(s.body.items.map((m) => m.id), [r.body.id], q);
  }

  const one = await api('GET', `/medicines/${r.body.id}`, { token: doctor });
  assert.deepEqual(one.body.batches.map((b) => b.batchNo), ['DL2402', 'DL2401']); // earliest expiry first
});

t('only admins create or edit; everyone logged in can search', async () => {
  const r = await api('POST', '/medicines', { token: doctor, body: medicineBody(), idem: key() });
  assert.equal(r.status, 403);
  assert.equal((await api('GET', '/medicines')).status, 401);
  assert.equal((await api('GET', '/medicines?q=x', { token: doctor })).status, 200);
});

t('validation lists every bad field, including batches', async () => {
  const r = await api('POST', '/medicines', {
    token: admin,
    idem: key(),
    body: medicineBody({
      dosageForm: 'PILL',
      batches: [
        { batchNo: 'A1', expiryDate: '2027-02-30', mrp: 0 },
        { batchNo: 'B1', manufactureDate: days(500), expiryDate: days(400), mrp: 1.234 },
      ],
    }),
  });
  assert.equal(r.status, 400);
  assert.deepEqual(r.body.error.details.map((d) => d.field), ['dosageForm']);

  const r2 = await api('POST', '/medicines', {
    token: admin,
    idem: key(),
    body: medicineBody({
      batches: [
        { batchNo: 'A1', expiryDate: '2027-02-30', mrp: 0 },
        { batchNo: 'B1', manufactureDate: days(500), expiryDate: days(400), mrp: 1.234 },
        { batchNo: 'C1', expiryDate: days(400), mrp: 1 },
        { batchNo: 'c1 ', expiryDate: days(400), mrp: 1 },
      ],
    }),
  });
  assert.equal(r2.status, 400);
  assert.deepEqual(r2.body.error.details.map((d) => d.field), [
    'batches[0].expiryDate', 'batches[0].mrp', 'batches[1].manufactureDate', 'batches[1].mrp', 'batches[3].batchNo',
  ]);
});

t('duplicates: same brand+manufacturer+form+strength → MEDICINE_DUPLICATE; generic names ignore case', async () => {
  const body = medicineBody();
  assert.equal((await api('POST', '/medicines', { token: admin, body, idem: key() })).status, 201);
  const dup = await api('POST', '/medicines', {
    token: admin,
    idem: key(),
    body: { ...body, brandName: ` ${body.brandName.toUpperCase()} `, strength: '650mg', genericName: body.genericName.toLowerCase() },
  });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'MEDICINE_DUPLICATE');

  const g = await api('POST', '/generics', { token: admin, idem: key(), body: { name: body.genericName.toUpperCase() } });
  assert.equal(g.status, 409);
  assert.equal(g.body.error.code, 'GENERIC_NAME_TAKEN');
});

t('batches: expired → 422 BATCH_EXPIRED, repeated number → 409 BATCH_NO_TAKEN', async () => {
  const m = (await api('POST', '/medicines', { token: admin, body: medicineBody(), idem: key() })).body;
  const expired = await api('POST', `/medicines/${m.id}/batches`, {
    token: admin, idem: key(), body: { batchNo: 'OLD1', expiryDate: days(0), mrp: 5 },
  });
  assert.equal(expired.status, 422);
  assert.equal(expired.body.error.code, 'BATCH_EXPIRED');

  const ok = await api('POST', `/medicines/${m.id}/batches`, { token: admin, idem: key(), body: { batchNo: 'N1', expiryDate: days(90), mrp: 5 } });
  assert.equal(ok.status, 201);
  const again = await api('POST', `/medicines/${m.id}/batches`, { token: admin, idem: key(), body: { batchNo: 'n1', expiryDate: days(90), mrp: 5 } });
  assert.equal(again.body.error.code, 'BATCH_NO_TAKEN');
});

t('edit: admin can rename; base unit is locked once batches exist', async () => {
  const m = (await api('POST', '/medicines', {
    token: admin, idem: key(), body: medicineBody({ batches: [{ batchNo: 'X1', expiryDate: days(300), mrp: 3 }] }),
  })).body;
  const renamed = await api('PATCH', `/medicines/${m.id}`, { token: admin, body: { brandName: `${m.brandName} Plus`, prescriptionRequired: false } });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.prescriptionRequired, false);
  const unit = await api('PATCH', `/medicines/${m.id}`, { token: admin, body: { baseUnit: 'ML' } });
  assert.equal(unit.status, 409);
  assert.equal(unit.body.error.code, 'MEDICINE_IN_USE');
  assert.equal((await api('PATCH', `/medicines/${m.id}`, { token: doctor, body: { brandName: 'x' } })).status, 403);
});

t('edge case 5: delete works without batches, MEDICINE_IN_USE with one; deactivate hides it from non-admins', async () => {
  const bare = (await api('POST', '/medicines', { token: admin, body: medicineBody(), idem: key() })).body;
  const del = await api('DELETE', `/medicines/${bare.id}`, { token: admin });
  assert.equal(del.status, 200);
  assert.equal((await api('GET', `/medicines/${bare.id}`, { token: admin })).status, 404);

  const used = (await api('POST', '/medicines', {
    token: admin, idem: key(), body: medicineBody({ batches: [{ batchNo: 'U1', expiryDate: days(300), mrp: 3 }] }),
  })).body;
  const blocked = await api('DELETE', `/medicines/${used.id}`, { token: admin });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error.code, 'MEDICINE_IN_USE');

  const off = await api('POST', `/medicines/${used.id}/deactivate`, { token: admin });
  assert.equal(off.body.isActive, false);
  assert.equal((await api('GET', `/medicines/${used.id}`, { token: doctor })).status, 404);
  const s = await api('GET', `/medicines?q=${encodeURIComponent(used.brandName)}`, { token: doctor });
  assert.equal(s.body.total, 0);
  const sa = await api('GET', `/medicines?q=${encodeURIComponent(used.brandName)}`, { token: admin });
  assert.equal(sa.body.total, 1);
  const addBatch = await api('POST', `/medicines/${used.id}/batches`, { token: admin, idem: key(), body: { batchNo: 'U2', expiryDate: days(300), mrp: 3 } });
  assert.equal(addBatch.body.error.code, 'MEDICINE_INACTIVE');
  assert.equal((await api('POST', `/medicines/${used.id}/activate`, { token: admin })).body.isActive, true);
});
