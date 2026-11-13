'use strict';

/**
 * notification.service (A10) — Commit 5 "done when": other modules can call
 * notification.service and see in-app rows. Needs PostgreSQL.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { pool } = require('../src/db/pool');
const migrate = require('../src/db/migrate');
const seeds = require('../src/db/seed');
const { withTransaction } = require('../src/db/transaction');
const { createApp } = require('../src/app');
const notifications = require('../src/modules/notifications/notification.service');

const PASSWORD = process.env.SEED_PASSWORD || 'Dosely@123';
let dbUp = false;
let server;
let base;
const uniq = () => crypto.randomBytes(4).toString('hex');
const msg = (over = {}) => ({ type: 'LOW_STOCK', title: 'Low stock', body: `Paracetamol 500mg is low (${uniq()})`, ...over });

async function api(method, path, { token, body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function login(email) {
  const r = await api('POST', '/auth/login', { body: { email, password: PASSWORD } });
  assert.equal(r.status, 200);
  return { token: r.body.token, user: r.body.user };
}

const id = async (sql, params) => (await pool.query(sql, params)).rows[0].id;

test.before(async () => {
  try {
    await pool.query('SELECT 1');
    dbUp = true;
  } catch (err) {
    console.warn('[notifications.test] skipping:', err.message);
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

t('notifyShop fans out IN_APP to every active staff member and shows in their inbox', async () => {
  const jay = await id(`SELECT id FROM shops WHERE code = 'DSL-JAY-01'`);
  const owner = await login('shopkeeper@dosely.dev');
  const staff = await login('staff@dosely.dev');
  const m = msg({ data: { medicineId: 42 } });
  const res = await notifications.notifyShop(jay, { ...m, channels: ['IN_APP'] });
  assert.equal(res.deduped, false);
  const reached = res.notifications.map((n) => n.recipientUserId);
  assert.ok(reached.includes(owner.user.id) && reached.includes(staff.user.id));
  assert.ok(res.notifications.every((n) => n.channel === 'IN_APP' && n.status === 'SENT'));

  for (const who of [owner, staff]) {
    const inbox = (await api('GET', '/notifications?limit=10', { token: who.token })).body;
    const item = inbox.items.find((x) => x.body === m.body);
    assert.ok(item, 'in inbox');
    assert.deepEqual([item.type, item.isRead, item.data.medicineId, item.recipientType], ['LOW_STOCK', false, 42, 'SHOP']);
    assert.ok(inbox.unreadCount >= 1);
  }
  const doc = await login('doctor@dosely.dev');
  assert.ok(!(await api('GET', '/notifications?limit=50', { token: doc.token })).body.items.some((x) => x.body === m.body));
});

t('removed staff stop getting shop notifications (A7)', async () => {
  const shops = require('../src/modules/shops/shops.service');
  const mk = async (name) => (await pool.query(
    `INSERT INTO users (role, full_name, email, password_hash) VALUES ('SHOPKEEPER', $1, $2, 'x') RETURNING id`,
    [name, `${name.toLowerCase()}-${uniq()}@dosely.dev`])).rows[0].id;
  const ownerId = await mk('Owner');
  const leaverId = await mk('Leaver');
  const u = uniq().toUpperCase();
  const shop = await shops.create({ name: `Fanout ${u}`, code: `FO-${u}`, drugLicenceNo: `KA-FO-${u}`, address: '1 Test Road',
    area: 'Testpura', pincode: '560001' }, ownerId);
  await shops.addStaff(shop.id, leaverId, 'STAFF', ownerId);

  const before = await notifications.notifyShop(shop.id, { ...msg(), channels: ['IN_APP'] });
  assert.deepEqual(before.notifications.map((n) => n.recipientUserId).sort(), [ownerId, leaverId].sort());

  await shops.removeStaff(shop.id, leaverId);
  const after = await notifications.notifyShop(shop.id, { ...msg(), channels: ['IN_APP'] });
  assert.deepEqual(after.notifications.map((n) => n.recipientUserId), [ownerId]);
});

t('dedupe: the same key sends once; concurrent calls with one key create one set of rows', async () => {
  const jay = await id(`SELECT id FROM shops WHERE code = 'DSL-JAY-01'`);
  const dedupeKey = `low-stock:${jay}:42:${uniq()}`;
  const first = await notifications.notifyShop(jay, { ...msg(), channels: ['IN_APP'], dedupeKey });
  const again = await notifications.notifyShop(jay, { ...msg(), channels: ['IN_APP'], dedupeKey });
  assert.equal(first.deduped, false);
  assert.equal(again.deduped, true);
  assert.deepEqual(again.notifications.map((n) => n.id), first.notifications.map((n) => n.id));

  const key2 = `race:${uniq()}`;
  const results = await Promise.all(Array.from({ length: 5 }, () => notifications.notifyShop(jay, { ...msg(), channels: ['IN_APP'], dedupeKey: key2 })));
  assert.equal(results.filter((r) => !r.deduped).length, 1);
  const { rows: [{ n }] } = await pool.query('SELECT count(*)::int AS n FROM notifications WHERE dedupe_key = $1', [key2]);
  assert.equal(n, first.notifications.length);
});

t('inside a caller transaction: rolled back → no notification; committed → there', async () => {
  const doc = await login('doctor@dosely.dev');
  const body1 = `rolled back ${uniq()}`;
  await assert.rejects(withTransaction(async (client) => {
    await notifications.notifyUser(doc.user.id, { ...msg({ body: body1 }), channels: ['IN_APP'] }, { client });
    throw new Error('request failed');
  }), /request failed/);
  const body2 = `committed ${uniq()}`;
  await withTransaction((client) => notifications.notifyUser(doc.user.id, { ...msg({ body: body2 }), channels: ['IN_APP'] }, { client }));
  const { rows } = await pool.query('SELECT body FROM notifications WHERE body = ANY($1)', [[body1, body2]]);
  assert.deepEqual(rows.map((r) => r.body), [body2]);
});

t('SMS to patients: verified mobile → PENDING; edge case 9 (unverified) and 10 (no phone) → SKIPPED with a reason', async () => {
  const pid = (name) => id('SELECT id FROM patients WHERE full_name = $1 ORDER BY id LIMIT 1', [name]);
  const sms = { type: 'REFERRAL_ACCEPTED', title: 'Referral', body: 'Your medicine is ready at Jayanagar Health Pharmacy. Code R-1001' };

  const priya = await notifications.notifyPatient(await pid('Priya Nair'), sms);
  assert.equal(priya.notifications[0].status, 'PENDING');
  assert.ok(priya.notifications[0].phoneId);
  assert.deepEqual(priya.skipped, []);

  const sam = await notifications.notifyPatient(await pid('Sam Thomas'), sms);
  assert.deepEqual([sam.notifications[0].status, sam.notifications[0].skipReason], ['SKIPPED', 'NO_VERIFIED_MOBILE']);
  assert.equal(sam.skipped.length, 1);

  const meera = await notifications.notifyPatient(await pid('Meera Pillai'), sms);
  assert.deepEqual([meera.notifications[0].status, meera.notifications[0].skipReason], ['SKIPPED', 'NO_PHONE']);

  // Lakshmi's primary is a HOME landline; SMS goes to her verified mobile instead
  const lakshmi = await notifications.notifyPatient(await pid('Lakshmi Iyer'), sms);
  const { rows: [ph] } = await pool.query('SELECT e164 FROM phone_numbers WHERE id = $1', [lakshmi.notifications[0].phoneId]);
  assert.equal(ph.e164, '+919810000104');

  // EMAIL to a patient: nothing to send to
  const email = await notifications.notifyPatient(await pid('Priya Nair'), { ...sms, channels: ['EMAIL'] });
  assert.equal(email.notifications[0].skipReason, 'NO_EMAIL');
});

t('several channels at once: one row per channel per staff member', async () => {
  const kor = await id(`SELECT id FROM shops WHERE code = 'DSL-KOR-02'`);
  const res = await notifications.notifyShop(kor, { ...msg({ body: 'Short SMS-able body' }), channels: ['IN_APP', 'SMS', 'EMAIL', 'SMS'] });
  const byChannel = Object.groupBy(res.notifications, (n) => n.channel);
  assert.deepEqual(Object.keys(byChannel).sort(), ['EMAIL', 'IN_APP', 'SMS']);
  assert.equal(byChannel.SMS[0].status, 'PENDING');         // owner.kor@ has a verified mobile
  assert.equal(byChannel.EMAIL[0].status, 'PENDING');
});

t('unknown recipients are NOT_FOUND; SMS over 160 chars is refused', async () => {
  await assert.rejects(notifications.notifyShop(999999999, { ...msg(), channels: ['IN_APP'] }), (e) => e.code === 'NOT_FOUND');
  await assert.rejects(notifications.notifyPatient(999999999, msg()), (e) => e.code === 'NOT_FOUND');
  await assert.rejects(notifications.notifyUser(1, { ...msg({ body: 'x'.repeat(161) }), channels: ['SMS'] }), (e) => e.code === 'SMS_TOO_LONG');
});

t('inbox: unreadOnly, paging with before, mark one / all read, only your own', async () => {
  const doc = await login('doctor@dosely.dev');
  const sk = await login('shopkeeper@dosely.dev');
  const ids = [];
  for (let i = 0; i < 3; i += 1) {
    ids.push((await notifications.notifyUser(doc.user.id, { ...msg({ type: 'REQUEST_ACKNOWLEDGED', body: `page ${i} ${uniq()}` }), channels: ['IN_APP'] })).notifications[0].id);
  }
  const p1 = (await api('GET', '/notifications?limit=2', { token: doc.token })).body;
  assert.deepEqual(p1.items.map((x) => x.id), [ids[2], ids[1]]);
  const p2 = (await api('GET', `/notifications?limit=2&before=${p1.nextBefore}`, { token: doc.token })).body;
  assert.equal(p2.items[0].id, ids[0]);

  assert.equal((await api('POST', `/notifications/${ids[0]}/read`, { token: sk.token })).status, 404, 'not yours');
  const r = await api('POST', `/notifications/${ids[0]}/read`, { token: doc.token });
  assert.equal(r.status, 200);
  const again = await api('POST', `/notifications/${ids[0]}/read`, { token: doc.token });
  assert.equal(again.body.readAt, r.body.readAt, 'first read time kept');

  const unread = (await api('GET', '/notifications?unreadOnly=true&limit=100', { token: doc.token })).body;
  assert.ok(!unread.items.some((x) => x.id === ids[0]));
  assert.ok(unread.items.some((x) => x.id === ids[1]));

  const all = await api('POST', '/notifications/read-all', { token: doc.token });
  assert.ok(all.body.updated >= 2);
  assert.equal((await api('GET', '/notifications', { token: doc.token })).body.unreadCount, 0);
  assert.equal((await api('GET', '/notifications')).status, 401);
});
