'use strict';

/**
 * SMS / EMAIL delivery (A11) — Commit 6 "done when": a failed SMS retries and
 * stops at 5 attempts; the number flips to unreachable after 3 failures.
 * Needs PostgreSQL. Uses the stub providers (nothing is really sent).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { pool } = require('../src/db/pool');
const migrate = require('../src/db/migrate');
const seeds = require('../src/db/seed');
const notifications = require('../src/modules/notifications/notification.service');
const phones = require('../src/modules/phones/phones.service');
const { deliverDue, backoffMs } = require('../src/modules/notifications/delivery');
const channels = require('../src/modules/notifications/channels');
const retryJob = require('../src/jobs/retryNotifications');

let dbUp = false;
const uniq = () => crypto.randomBytes(4).toString('hex');
const mobile = () => `+9198${String(crypto.randomInt(10000000, 99999999))}`;
const sms = (over = {}) => ({ type: 'REFERRAL_ACCEPTED', title: 'Referral', body: `Medicine ready. Code ${uniq()}`, ...over });

const row = async (id) => (await pool.query('SELECT * FROM notifications WHERE id = $1', [id])).rows[0];
/** Make a row due now (instead of waiting out the backoff). */
const dueNow = (id) => pool.query('UPDATE notifications SET next_attempt_at = now() WHERE id = $1', [id]);
const adminId = async () => (await pool.query(`SELECT id FROM users WHERE email = 'admin@dosely.dev'`)).rows[0].id;

/** A patient (added by the demo doctor) with one verified mobile. */
async function patientWithPhone(e164 = mobile()) {
  const { rows: [doc] } = await pool.query(`SELECT id FROM users WHERE email = 'doctor@dosely.dev'`);
  const { rows: [p] } = await pool.query(
    'INSERT INTO patients (full_name, created_by) VALUES ($1, $2) RETURNING id', [`Delivery ${uniq()}`, doc.id]);
  const { phone } = await phones.add('PATIENT', p.id, { number: e164 }, { verified: true, verifiedBy: await adminId() });
  return { patientId: p.id, phone, doctorId: doc.id };
}

test.before(async () => {
  try {
    await pool.query('SELECT 1');
    dbUp = true;
  } catch (err) {
    console.warn('[delivery.test] skipping:', err.message);
    return;
  }
  await migrate.up({ log: () => {} });
  await seeds.run({ log: () => {} });
});

test.beforeEach(() => {
  channels.stub.sms.reset();
  channels.stub.email.reset();
});

test.after(async () => {
  await pool.end();
});

const t = (name, fn) => test(name, async (ctx) => (dbUp ? fn(ctx) : ctx.skip('no database')));

t('SMS to a verified number is sent: PENDING → SENT, one attempt, recorded by the stub', async () => {
  const { patientId, phone } = await patientWithPhone();
  const body = `Your medicine is ready. Code ${uniq()}`;
  const r = await notifications.notifyPatient(patientId, sms({ body }));
  const id = r.notifications[0].id;
  assert.equal((await row(id)).status, 'PENDING');

  await deliverDue();
  const after = await row(id);
  assert.deepEqual([after.status, after.attempts, after.last_error], ['SENT', 1, null]);
  assert.ok(after.sent_at);
  assert.ok(channels.stub.sms.outbox.some((m) => m.to === phone.e164 && m.body === body));

  await deliverDue();
  assert.equal(channels.stub.sms.outbox.filter((m) => m.body === body).length, 1, 'never sent twice');
});

t('done when: a failing SMS retries with backoff, stops at 5 attempts; number UNREACHABLE after 3 failures + alert', async () => {
  const { rows: [jay] } = await pool.query(`SELECT id FROM shops WHERE code = 'DSL-JAY-01'`);
  const { patientId, phone } = await patientWithPhone();
  channels.stub.sms.setFailing(phone.e164, true);
  const r = await notifications.notifyPatient(patientId, sms({ data: { shopId: jay.id } }));
  const id = r.notifications[0].id;

  const seen = [];
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    await dueNow(id);
    const before = Date.now();
    await deliverDue();
    const n = await row(id);
    const ph = await phones.getById(phone.id);
    seen.push({ attempt, status: n.status, attempts: n.attempts, phoneStatus: ph.status, failures: ph.consecutiveFailures });
    if (attempt < 5) {
      // next try is scheduled base * 2^(attempt-1) later (30s, 60s, 120s, 240s)
      const delay = new Date(n.next_attempt_at).getTime() - before;
      assert.ok(Math.abs(delay - backoffMs(attempt)) < 2000, `attempt ${attempt}: delay ${delay}ms vs ${backoffMs(attempt)}ms`);
      assert.match(n.last_error, /failed/);
    }
  }

  assert.deepEqual(seen.map((s) => s.status), ['PENDING', 'PENDING', 'PENDING', 'PENDING', 'FAILED']);
  assert.deepEqual(seen.map((s) => s.attempts), [1, 2, 3, 4, 5]);
  assert.deepEqual(seen.map((s) => s.phoneStatus), ['VERIFIED', 'VERIFIED', 'UNREACHABLE', 'UNREACHABLE', 'UNREACHABLE']);
  assert.equal((await row(id)).next_attempt_at, null);

  // stops at 5: further passes don't touch it
  await dueNow(id);
  await pool.query(`UPDATE notifications SET status = 'FAILED' WHERE id = $1`, [id]);
  await deliverDue();
  assert.equal((await row(id)).attempts, 5);
  assert.equal(channels.stub.sms.outbox.filter((m) => m.to === phone.e164).length, 0);

  // P13 alert went to the shop named in the SMS data, exactly once
  const { rows: alerts } = await pool.query(
    `SELECT user_id FROM notifications WHERE type = 'PHONE_UNREACHABLE' AND (data->>'phoneId')::bigint = $1 AND channel = 'IN_APP'`, [phone.id]);
  const { rows: staff } = await pool.query(
    `SELECT user_id FROM shop_staff WHERE shop_id = $1 AND is_active ORDER BY user_id`, [jay.id]);
  assert.deepEqual(alerts.map((a) => a.user_id).sort(), staff.map((s) => s.user_id).sort());

  // new messages skip the unreachable number (P11) until it's re-verified
  const next = await notifications.notifyPatient(patientId, sms());
  assert.deepEqual([next.notifications[0].status, next.notifications[0].skipReason], ['SKIPPED', 'PHONE_UNREACHABLE']);
  await phones.verify(phone.id, await adminId());
  channels.stub.sms.setFailing(phone.e164, false);
  const again = await notifications.notifyPatient(patientId, sms());
  await deliverDue();
  assert.equal((await row(again.notifications[0].id)).status, 'SENT');
});

t('a success in between resets the failure streak, so the number stays reachable', async () => {
  const { patientId, phone } = await patientWithPhone();
  channels.stub.sms.setFailing(phone.e164, true);
  const a = (await notifications.notifyPatient(patientId, sms())).notifications[0].id;
  const b = (await notifications.notifyPatient(patientId, sms())).notifications[0].id;
  await deliverDue();                     // a and b fail → 2 failures
  channels.stub.sms.setFailing(phone.e164, false);
  await dueNow(a);
  await deliverDue();                     // a succeeds → streak reset
  channels.stub.sms.setFailing(phone.e164, true);
  await dueNow(b);
  await deliverDue();                     // b fails → 1 failure
  const ph = await phones.getById(phone.id);
  assert.deepEqual([ph.status, ph.consecutiveFailures], ['VERIFIED', 1]);
  assert.equal((await row(a)).status, 'SENT');
});

t('queued SMS to a removed number, or one whose digits changed (P12), is skipped, not sent', async () => {
  const { patientId, phone } = await patientWithPhone();
  const extra = (await phones.add('PATIENT', patientId, { number: mobile() }, { verified: true, verifiedBy: await adminId() })).phone;
  const first = (await notifications.notifyPatient(patientId, sms())).notifications[0];
  assert.equal(first.phoneId, phone.id);

  await phones.update(phone.id, { number: mobile() });                 // P12: now UNVERIFIED
  await deliverDue();
  assert.deepEqual([(await row(first.id)).status, (await row(first.id)).skip_reason], ['SKIPPED', 'NO_VERIFIED_MOBILE']);

  const second = (await notifications.notifyPatient(patientId, sms())).notifications[0];
  assert.equal(second.phoneId, extra.id, 'falls back to the other verified mobile');
  await phones.update(extra.id, { isPrimary: true });
  await phones.remove(phone.id);
  await phones.remove(extra.id);
  await deliverDue();
  assert.equal((await row(second.id)).skip_reason, 'PHONE_REMOVED');
  assert.equal(channels.stub.sms.outbox.length, 0);
});

t('EMAIL is sent with the title as subject; failures retry like SMS', async () => {
  const { rows: [doc] } = await pool.query(`SELECT id, email FROM users WHERE email = 'doctor@dosely.dev'`);
  const ok = (await notifications.notifyUser(doc.id, { type: 'REQUEST_ACKNOWLEDGED', title: `Ack ${uniq()}`, body: 'Your request was acknowledged.', channels: ['EMAIL'] })).notifications[0];
  await deliverDue();
  assert.equal((await row(ok.id)).status, 'SENT');
  const mail = channels.stub.email.outbox.find((m) => m.to === doc.email);
  assert.match(mail.subject, /^Ack /);

  channels.stub.email.setFailing(doc.email, true);
  const bad = (await notifications.notifyUser(doc.id, { type: 'REQUEST_ACKNOWLEDGED', title: 'Ack', body: 'x', channels: ['EMAIL'] })).notifications[0];
  await deliverDue();
  const r = await row(bad.id);
  assert.deepEqual([r.status, r.attempts], ['PENDING', 1]);
});

t('two workers at once never send the same message twice', async () => {
  const { patientId } = await patientWithPhone();
  const ids = [];
  for (let i = 0; i < 6; i += 1) ids.push((await notifications.notifyPatient(patientId, sms())).notifications[0].id);
  await Promise.all([deliverDue({ limit: 3 }), deliverDue({ limit: 3 }), deliverDue({ limit: 3 })]);
  const { rows } = await pool.query('SELECT status, attempts FROM notifications WHERE id = ANY($1)', [ids]);
  assert.ok(rows.every((r) => r.status === 'SENT' && r.attempts === 1));
  const bodies = channels.stub.sms.outbox.map((m) => m.body);
  assert.equal(new Set(bodies).size, bodies.length);
});

t('the job: runOnce delivers; start/stop runs passes without overlap', async () => {
  const { patientId } = await patientWithPhone();
  const id = (await notifications.notifyPatient(patientId, sms())).notifications[0].id;
  const s = await retryJob.runOnce();
  assert.ok(s.sent >= 1);
  assert.equal((await row(id)).status, 'SENT');

  const id2 = (await notifications.notifyPatient(patientId, sms())).notifications[0].id;
  const worker = retryJob.start({ intervalMs: 50 });
  for (let i = 0; i < 40 && (await row(id2)).status !== 'SENT'; i += 1) await new Promise((r) => setTimeout(r, 25));
  await worker.stop();
  assert.equal((await row(id2)).status, 'SENT');
});

t('backoff doubles and is capped', () => {
  assert.deepEqual([1, 2, 3, 4].map((a) => backoffMs(a, { base: 30_000, max: 1_800_000 })), [30_000, 60_000, 120_000, 240_000]);
  assert.equal(backoffMs(20, { base: 30_000, max: 1_800_000 }), 1_800_000);
});
