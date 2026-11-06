'use strict';

/**
 * Commit 2 "done when": a seeded doctor, shopkeeper and admin can log in and
 * hit a role-protected route. Plus users, doctors and idempotency rules.
 * Needs PostgreSQL (DATABASE_URL); skipped when unreachable.
 * Creates users with random emails, so it's safe on a dev database.
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

const uniq = () => crypto.randomBytes(4).toString('hex');

async function api(method, path, { token, body, key } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (key) headers['idempotency-key'] = key;
  const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}

async function login(email, password = PASSWORD) {
  const r = await api('POST', '/auth/login', { body: { email, password } });
  assert.equal(r.status, 200, `login ${email}: ${JSON.stringify(r.body)}`);
  return r.body.token;
}

test.before(async () => {
  try {
    await pool.query('SELECT 1');
    dbUp = true;
  } catch (err) {
    console.warn('[auth.test] skipping:', err.message);
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

t('seeded admin, doctor and shopkeeper can log in; password hash never returned', async () => {
  for (const [email, role] of [['admin@dosely.dev', 'ADMIN'], ['doctor@dosely.dev', 'DOCTOR'], ['shopkeeper@dosely.dev', 'SHOPKEEPER']]) {
    const r = await api('POST', '/auth/login', { body: { email: email.toUpperCase(), password: PASSWORD } });
    assert.equal(r.status, 200);
    assert.equal(r.body.tokenType, 'Bearer');
    assert.equal(r.body.user.role, role);
    assert.ok(!JSON.stringify(r.body).includes('password'));
    const me = await api('GET', '/auth/me', { token: r.body.token });
    assert.equal(me.status, 200);
    assert.equal(me.body.user.email, email);
    if (role === 'DOCTOR') assert.equal(me.body.doctor.registrationNo, 'KMC-100245');
  }
});

t('role-protected route: only ADMIN can list users', async () => {
  const admin = await login('admin@dosely.dev');
  const doctor = await login('doctor@dosely.dev');
  const shop = await login('shopkeeper@dosely.dev');
  assert.equal((await api('GET', '/users', { token: admin })).status, 200);
  const d = await api('GET', '/users', { token: doctor });
  assert.equal(d.status, 403);
  assert.equal(d.body.error.code, 'FORBIDDEN');
  assert.equal((await api('GET', '/users', { token: shop })).status, 403);
});

t('login failures: wrong password, unknown email, no token, bad token', async () => {
  const wrong = await api('POST', '/auth/login', { body: { email: 'admin@dosely.dev', password: 'nope-nope' } });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.error.code, 'INVALID_CREDENTIALS');
  const unknown = await api('POST', '/auth/login', { body: { email: `ghost-${uniq()}@x.dev`, password: 'whatever1' } });
  assert.equal(unknown.body.error.code, 'INVALID_CREDENTIALS');
  assert.equal((await api('GET', '/auth/me')).body.error.code, 'UNAUTHENTICATED');
  assert.equal((await api('GET', '/auth/me', { token: 'abc.def.ghi' })).body.error.code, 'UNAUTHENTICATED');
  const invalid = await api('POST', '/auth/login', { body: { email: 'not-an-email' } });
  assert.equal(invalid.status, 400);
  assert.deepEqual(invalid.body.error.details.map((d) => d.field), ['email', 'password']);
});

t('admin creates a user (idempotent), email is unique case-insensitively, optional', async () => {
  const admin = await login('admin@dosely.dev');
  const email = `pharma-${uniq()}@dosely.dev`;
  const body = { role: 'SHOPKEEPER', fullName: 'Test Keeper', email, password: 'Secret123' };

  assert.equal((await api('POST', '/users', { token: admin, body })).body.error.code, 'IDEMPOTENCY_KEY_REQUIRED');

  const key = `k-${uniq()}`;
  const first = await api('POST', '/users', { token: admin, body, key });
  assert.equal(first.status, 201);
  assert.equal(first.body.email, email);
  assert.ok(!('passwordHash' in first.body) && !('password_hash' in first.body));

  const replay = await api('POST', '/users', { token: admin, body, key });
  assert.equal(replay.status, 201);
  assert.equal(replay.headers.get('idempotent-replayed'), 'true');
  assert.equal(replay.body.id, first.body.id);

  const reused = await api('POST', '/users', { token: admin, body: { ...body, fullName: 'Other' }, key });
  assert.equal(reused.status, 422);
  assert.equal(reused.body.error.code, 'IDEMPOTENCY_KEY_REUSED');

  const dup = await api('POST', '/users', { token: admin, body: { ...body, email: email.toUpperCase() }, key: `k-${uniq()}` });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'EMAIL_TAKEN');

  const noEmail = await api('POST', '/users', { token: admin, body: { role: 'SHOPKEEPER', fullName: 'No Email', password: 'Secret123' }, key: `k-${uniq()}` });
  assert.equal(noEmail.status, 201);
  assert.equal(noEmail.body.email, null);

  assert.equal((await login(email, 'Secret123')).length > 20, true);
});

t('deactivated users are locked out immediately, even with a live token', async () => {
  const admin = await login('admin@dosely.dev');
  const email = `temp-${uniq()}@dosely.dev`;
  const created = await api('POST', '/users', { token: admin, key: `k-${uniq()}`, body: { role: 'SHOPKEEPER', fullName: 'Temp', email, password: 'Secret123' } });
  const token = await login(email, 'Secret123');

  const del = await api('DELETE', `/users/${created.body.id}`, { token: admin });
  assert.equal(del.status, 200);
  assert.equal(del.body.isActive, false);
  assert.equal((await api('GET', '/auth/me', { token })).body.error.code, 'ACCOUNT_INACTIVE');
  assert.equal((await api('POST', '/auth/login', { body: { email, password: 'Secret123' } })).body.error.code, 'ACCOUNT_INACTIVE');

  const { rowCount } = await pool.query('SELECT 1 FROM users WHERE id = $1', [created.body.id]);
  assert.equal(rowCount, 1, 'row is deactivated, not deleted');
  assert.equal((await api('DELETE', `/users/${(await api('GET', '/auth/me', { token: admin })).body.user.id}`, { token: admin })).status, 409);
});

t('users can read/update themselves but not others; password change needs current password', async () => {
  const admin = await login('admin@dosely.dev');
  const email = `self-${uniq()}@dosely.dev`;
  const u = (await api('POST', '/users', { token: admin, key: `k-${uniq()}`, body: { role: 'DOCTOR', fullName: 'Self', email, password: 'Secret123' } })).body;
  const token = await login(email, 'Secret123');

  assert.equal((await api('GET', `/users/${u.id}`, { token })).status, 200);
  assert.equal((await api('GET', '/users/1', { token })).status, u.id === 1 ? 200 : 403);
  assert.equal((await api('PATCH', `/users/${u.id}`, { token, body: { role: 'ADMIN' } })).status, 400);

  const noCurrent = await api('PATCH', `/users/${u.id}`, { token, body: { password: 'NewSecret123' } });
  assert.equal(noCurrent.body.error.code, 'VALIDATION_ERROR');
  const badCurrent = await api('PATCH', `/users/${u.id}`, { token, body: { password: 'NewSecret123', currentPassword: 'wrong-one' } });
  assert.equal(badCurrent.body.error.code, 'INVALID_CREDENTIALS');
  const ok = await api('PATCH', `/users/${u.id}`, { token, body: { password: 'NewSecret123', currentPassword: 'Secret123', fullName: 'Self Renamed' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.fullName, 'Self Renamed');
  await login(email, 'NewSecret123');
});

t('doctors: one profile per DOCTOR user, unique registration number, role enforced', async () => {
  const admin = await login('admin@dosely.dev');
  const email = `doc-${uniq()}@dosely.dev`;
  await api('POST', '/users', { token: admin, key: `k-${uniq()}`, body: { role: 'DOCTOR', fullName: 'Dr New', email, password: 'Secret123' } });
  const token = await login(email, 'Secret123');

  const dupReg = await api('POST', '/doctors', { token, key: `k-${uniq()}`, body: { registrationNo: 'kmc-100245' } });
  assert.equal(dupReg.status, 409);
  assert.equal(dupReg.body.error.code, 'DOCTOR_REG_NO_TAKEN');

  const reg = `REG-${uniq()}`;
  const created = await api('POST', '/doctors', { token, key: `k-${uniq()}`, body: { registrationNo: reg, specialization: 'ENT' } });
  assert.equal(created.status, 201);
  assert.equal(created.body.canSendRequests, true);

  const again = await api('POST', '/doctors', { token, key: `k-${uniq()}`, body: { registrationNo: `REG-${uniq()}` } });
  assert.equal(again.body.error.code, 'DOCTOR_PROFILE_EXISTS');

  const shop = await login('shopkeeper@dosely.dev');
  assert.equal((await api('POST', '/doctors', { token: shop, key: `k-${uniq()}`, body: {} })).status, 403);

  const shopUser = (await api('GET', '/auth/me', { token: shop })).body.user;
  const wrongRole = await api('POST', '/doctors', { token: admin, key: `k-${uniq()}`, body: { userId: shopUser.id } });
  assert.equal(wrongRole.status, 400);

  const other = await login('doctor@dosely.dev');
  assert.equal((await api('PATCH', `/doctors/${created.body.id}`, { token: other, body: { clinicName: 'x' } })).status, 403);
  const mine = await api('PATCH', `/doctors/${created.body.id}`, { token, body: { clinicName: 'ENT Care' } });
  assert.equal(mine.body.clinicName, 'ENT Care');
});

t('assertCanSendRequests: no registration number → DOCTOR_REG_NO_REQUIRED', async () => {
  const doctors = require('../src/modules/doctors/doctors.service');
  const { rows: [noReg] } = await pool.query(`SELECT id FROM users WHERE email = 'doctor.noreg@dosely.dev'`);
  const { rows: [withReg] } = await pool.query(`SELECT id FROM users WHERE email = 'doctor@dosely.dev'`);
  await assert.rejects(doctors.assertCanSendRequests(noReg.id), (e) => e.code === 'DOCTOR_REG_NO_REQUIRED');
  assert.equal((await doctors.assertCanSendRequests(withReg.id)).registrationNo, 'KMC-100245');
  const me = await api('GET', '/doctors/me', { token: await login('doctor.noreg@dosely.dev') });
  assert.equal(me.body.canSendRequests, false);
});

t('seeds are idempotent', async () => {
  const before = (await pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n;
  await seeds.run({ log: () => {} });
  const after = (await pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n;
  assert.equal(after, before);
});
