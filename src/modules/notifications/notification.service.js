'use strict';

/**
 * notification.service — the one service every module calls (A10, F6).
 * Same signatures as the Nov 4 stubs; now backed by the notifications table.
 *
 *   notify({ recipientType, recipientId, channels, type, title, body, data?, dedupeKey? }, { client? })
 *   notifyShop(shopId, payload, opts)      every active staff member (removed staff get nothing)
 *   notifyUser(userId, payload, opts)
 *   notifyPatient(patientId, payload, opts) SMS by default; patients have no IN_APP inbox
 *   listInbox(userId, { unreadOnly, limit, before })
 *   markRead(notificationId, userId) / markAllRead(userId)
 *
 * Rows per channel and person:
 *   IN_APP  SENT straight away (it's in the inbox)
 *   SMS     PENDING → delivered by the retryNotifications job (Commit 6), or
 *           SKIPPED with skipReason NO_PHONE / NO_VERIFIED_MOBILE / PHONE_UNREACHABLE
 *           (edge cases 9 and 10: tell the patient in person / print the slip)
 *   EMAIL   PENDING, or SKIPPED with NO_EMAIL
 *
 * Dedupe: a dedupeKey that was already used returns { deduped: true } and the
 * existing rows, and creates nothing. Concurrent calls with one key are serialised.
 *
 * Pass { client } when you're inside a transaction: the notification is then
 * only created if your transaction commits.
 */

const { query } = require('../../db/pool');
const { withTransaction } = require('../../db/transaction');
const { AppError } = require('../../shared/errors');
const { NotificationChannel, NotificationRecipientType } = require('../../shared/enums');
const phones = require('../phones/phones.service');
const shops = require('../shops/shops.service');
const { maskPhone } = require('../phones/phone.validator');

const SMS_MAX = 160;
const MAX_ATTEMPTS = 5;
const TYPE_RE = /^[A-Z][A-Z0-9_]{1,59}$/;

/**
 * @typedef {'IN_APP'|'SMS'|'EMAIL'} Channel
 * @typedef {'USER'|'PATIENT'|'SHOP'} RecipientType
 *
 * @typedef {Object} NotifyInput
 * @property {RecipientType} recipientType  USER, PATIENT or SHOP
 * @property {number}        recipientId    users.id / patients.id / shops.id
 * @property {Channel[]}     channels       e.g. ['IN_APP', 'SMS']
 * @property {string}        type           event name, e.g. 'LOW_STOCK', 'REQUEST_CREATED', 'REFERRAL_SENT'
 * @property {string}        title          short heading (in-app / email subject)
 * @property {string}        body           message text; SMS body must be <= 160 chars
 * @property {Object}       [data]          extra JSON for the client (ids, links). For patient SMS, include
 *                                          shopId and/or doctorUserId so the right person is alerted if the
 *                                          number turns out to be unreachable (P13).
 * @property {string}       [dedupeKey]     same key twice = sent once, e.g. `low-stock:${shopId}:${itemId}:${date}`
 *
 * @typedef {Object} NotifyResult
 * @property {boolean} deduped
 * @property {Array<{id:number, channel:Channel, recipientUserId:(number|null), status:string,
 *                   phoneId:(number|null), skipReason:(string|null)}>} notifications
 * @property {Array} skipped  the SKIPPED rows, for showing "inform the patient in person"
 */

function validateNotify(input) {
  const errors = [];
  if (!input || typeof input !== 'object') throw AppError.validation([{ field: 'input', issue: 'required' }]);
  if (!NotificationRecipientType[input.recipientType]) errors.push({ field: 'recipientType', issue: 'must be USER, PATIENT or SHOP' });
  if (!Number.isInteger(input.recipientId) || input.recipientId <= 0) errors.push({ field: 'recipientId', issue: 'must be a positive integer' });
  if (!Array.isArray(input.channels) || input.channels.length === 0 || input.channels.some((c) => !NotificationChannel[c])) {
    errors.push({ field: 'channels', issue: 'must be a non-empty array of IN_APP, SMS, EMAIL' });
  }
  if (!input.type || typeof input.type !== 'string') errors.push({ field: 'type', issue: 'required' });
  else if (!TYPE_RE.test(input.type)) errors.push({ field: 'type', issue: 'UPPER_SNAKE_CASE, e.g. LOW_STOCK' });
  if (!input.title || typeof input.title !== 'string') errors.push({ field: 'title', issue: 'required' });
  if (!input.body || typeof input.body !== 'string') errors.push({ field: 'body', issue: 'required' });
  if (input.recipientType === 'PATIENT' && Array.isArray(input.channels) && input.channels.includes('IN_APP')) {
    errors.push({ field: 'channels', issue: 'patients have no login, so IN_APP is not allowed' });
  }
  if (input.data !== undefined && (input.data === null || typeof input.data !== 'object' || Array.isArray(input.data))) {
    errors.push({ field: 'data', issue: 'must be an object' });
  }
  if (input.dedupeKey !== undefined && (typeof input.dedupeKey !== 'string' || input.dedupeKey.length < 1 || input.dedupeKey.length > 200)) {
    errors.push({ field: 'dedupeKey', issue: 'must be a string of 1–200 characters' });
  }
  if (errors.length) throw AppError.validation(errors);
  if (input.channels.includes('SMS') && input.body.length > SMS_MAX) {
    throw new AppError('SMS_TOO_LONG', undefined, { length: input.body.length, max: SMS_MAX });
  }
}

function resultRow(r) {
  return {
    id: r.id,
    channel: r.channel,
    recipientUserId: r.user_id,
    status: r.status,
    phoneId: r.phone_id,
    skipReason: r.skip_reason,
  };
}

function result(rows, deduped) {
  const notifications = rows.map(resultRow);
  return { deduped, notifications, skipped: notifications.filter((n) => n.status === 'SKIPPED') };
}

/** Who this notification reaches: [{ kind: 'user', user } | { kind: 'patient', patientId }] */
async function resolveTargets(client, input) {
  if (input.recipientType === 'USER') {
    const { rows } = await client.query('SELECT id, email, is_active FROM users WHERE id = $1', [input.recipientId]);
    if (!rows[0]) throw AppError.notFound('User', input.recipientId);
    return [{ kind: 'user', user: rows[0] }];
  }
  if (input.recipientType === 'SHOP') {
    const { rowCount } = await client.query('SELECT 1 FROM shops WHERE id = $1', [input.recipientId]);
    if (!rowCount) throw AppError.notFound('Shop', input.recipientId);
    const staffIds = await shops.listActiveStaffUserIds(input.recipientId, { client }); // removed staff excluded (A7)
    if (staffIds.length === 0) return [];
    const { rows } = await client.query('SELECT id, email, is_active FROM users WHERE id = ANY($1) ORDER BY id', [staffIds]);
    return rows.map((user) => ({ kind: 'user', user }));
  }
  const { rowCount } = await client.query('SELECT 1 FROM patients WHERE id = $1', [input.recipientId]);
  if (!rowCount) throw AppError.notFound('Patient', input.recipientId);
  return [{ kind: 'patient', patientId: input.recipientId }];
}

/** Destination and starting status for one target on one channel. */
async function plan(client, channel, target) {
  const base = { user_id: null, phone_id: null, email: null, status: 'PENDING', skip_reason: null };
  if (target.kind === 'user') {
    const u = target.user;
    base.user_id = u.id;
    if (!u.is_active) return { ...base, status: 'SKIPPED', skip_reason: 'USER_INACTIVE', target_key: `user:${u.id}` };
    if (channel === 'IN_APP') return { ...base, status: 'SENT', target_key: `user:${u.id}` };
    if (channel === 'EMAIL') {
      return u.email
        ? { ...base, email: u.email, target_key: `user:${u.id}` }
        : { ...base, status: 'SKIPPED', skip_reason: 'NO_EMAIL', target_key: `user:${u.id}` };
    }
    const pick = await phones.pickSmsPhone('USER', u.id, { client });
    return pick.phone
      ? { ...base, phone_id: pick.phone.id, target_key: `user:${u.id}` }
      : { ...base, status: 'SKIPPED', skip_reason: pick.reason, target_key: `user:${u.id}` };
  }
  // patient
  const key = `patient:${target.patientId}`;
  if (channel === 'EMAIL') return { ...base, status: 'SKIPPED', skip_reason: 'NO_EMAIL', target_key: key };
  const pick = await phones.pickSmsPhone('PATIENT', target.patientId, { client });   // P11, edge cases 9 & 10
  return pick.phone
    ? { ...base, phone_id: pick.phone.id, target_key: key }
    : { ...base, status: 'SKIPPED', skip_reason: pick.reason, target_key: key };
}

/**
 * Send a notification to a user, a patient or a shop (all active staff).
 * @param {NotifyInput} input
 * @param {{client?: import('pg').PoolClient}} [opts]
 * @returns {Promise<NotifyResult>}
 */
async function notify(input, opts = {}) {
  validateNotify(input);
  const channels = [...new Set(input.channels)];
  const data = input.data || {};

  return withTransaction(async (client) => {
    if (input.dedupeKey) {
      // Serialise callers using the same key, then check for an earlier send.
      await client.query("SELECT pg_advisory_xact_lock(hashtext('notification:' || $1))", [input.dedupeKey]);
      const { rows } = await client.query('SELECT * FROM notifications WHERE dedupe_key = $1 ORDER BY id', [input.dedupeKey]);
      if (rows.length) return result(rows, true);
    }

    const targets = await resolveTargets(client, input);
    const created = [];
    for (const target of targets) {
      for (const channel of channels) {
        const p = await plan(client, channel, target);
        const now = p.status === 'SENT';
        const { rows: [row] } = await client.query(
          `INSERT INTO notifications
             (recipient_type, recipient_id, channel, user_id, phone_id, email, target_key, type, title, body, data,
              dedupe_key, status, skip_reason, max_attempts, next_attempt_at, sent_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
                   CASE WHEN $16::boolean THEN now() END, CASE WHEN $17::boolean THEN now() END)
           RETURNING *`,
          [input.recipientType, input.recipientId, channel, p.user_id, p.phone_id, p.email, p.target_key,
            input.type, input.title, input.body, JSON.stringify(data), input.dedupeKey || null,
            p.status, p.skip_reason, MAX_ATTEMPTS, p.status === 'PENDING', now]
        );
        created.push(row);
      }
    }
    return result(created, false);
  }, { client: opts.client });
}

/** Notify every active staff member of a shop. */
function notifyShop(shopId, payload, opts) {
  return notify({ ...payload, recipientType: 'SHOP', recipientId: shopId }, opts);
}

/** Notify one user. */
function notifyUser(userId, payload, opts) {
  return notify({ ...payload, recipientType: 'USER', recipientId: userId }, opts);
}

/** SMS a patient on their best usable number (edge cases 9, 10). */
function notifyPatient(patientId, payload, opts) {
  return notify({ ...payload, channels: payload.channels || ['SMS'], recipientType: 'PATIENT', recipientId: patientId }, opts);
}

function inboxItem(r) {
  return {
    id: r.id,
    type: r.type,
    title: r.title,
    body: r.body,
    data: r.data,
    recipientType: r.recipient_type,
    recipientId: r.recipient_id,
    isRead: r.read_at !== null,
    readAt: r.read_at,
    createdAt: r.created_at,
  };
}

/**
 * In-app inbox for the logged-in user (GET /notifications), newest first.
 * @param {number} userId
 * @param {{unreadOnly?: boolean, limit?: number, before?: number}} [q] before = id cursor for the next page
 * @returns {Promise<{items: Array<Object>, unreadCount: number, nextBefore: (number|null)}>}
 */
async function listInbox(userId, { unreadOnly = false, limit = 20, before } = {}) {
  const params = [userId];
  let where = "user_id = $1 AND channel = 'IN_APP'";
  if (unreadOnly) where += ' AND read_at IS NULL';
  if (before) { params.push(before); where += ` AND id < $${params.length}`; }
  params.push(limit + 1);
  const { rows } = await query(`SELECT * FROM notifications WHERE ${where} ORDER BY id DESC LIMIT $${params.length}`, params);
  const page = rows.slice(0, limit);
  const { rows: [{ n }] } = await query(
    "SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND channel = 'IN_APP' AND read_at IS NULL",
    [userId]
  );
  return { items: page.map(inboxItem), unreadCount: n, nextBefore: rows.length > limit ? page[page.length - 1].id : null };
}

/**
 * Mark one in-app notification read (POST /notifications/:id/read).
 * Only the recipient may mark it; otherwise NOT_FOUND. Marking twice keeps the first time.
 * @returns {Promise<{id:number, readAt:string}>}
 */
async function markRead(notificationId, userId) {
  const { rows } = await query(
    `UPDATE notifications SET read_at = COALESCE(read_at, now())
      WHERE id = $1 AND user_id = $2 AND channel = 'IN_APP'
      RETURNING id, read_at`,
    [notificationId, userId]
  );
  if (!rows[0]) throw AppError.notFound('Notification', notificationId);
  return { id: rows[0].id, readAt: rows[0].read_at };
}

/** Mark every unread in-app notification read. Returns { updated }. */
async function markAllRead(userId) {
  const { rowCount } = await query(
    "UPDATE notifications SET read_at = now() WHERE user_id = $1 AND channel = 'IN_APP' AND read_at IS NULL",
    [userId]
  );
  return { updated: rowCount };
}

/**
 * P13: after the 3rd failed SMS in a row a number turns UNREACHABLE — alert
 * whoever needs to fix it:
 *   shop number     the shop (all active staff)
 *   user number     that user
 *   patient number  the shop and/or doctor named in the failed SMS's data
 *                   (data.shopId, data.doctorUserId), else whoever added the patient
 * @param {object} phone  phones.toPublic shape
 * @param {object} [context]  data of the SMS that failed
 */
async function alertPhoneUnreachable(phone, context = {}, opts = {}) {
  const payload = {
    channels: ['IN_APP'],
    type: 'PHONE_UNREACHABLE',
    title: 'Phone number unreachable',
    body: `SMS to ${maskPhone(phone.e164)} failed ${phones.UNREACHABLE_AFTER} times in a row. Check the number with the ${phone.ownerType.toLowerCase()} and update or re-verify it.`,
    data: { phoneId: phone.id, ownerType: phone.ownerType, ownerId: phone.ownerId },
    dedupeKey: `phone-unreachable:${phone.id}:${new Date(phone.unreachableAt || Date.now()).toISOString()}`,
  };
  const sends = [];
  if (phone.ownerType === 'SHOP') sends.push(['SHOP', phone.ownerId]);
  else if (phone.ownerType === 'USER') sends.push(['USER', phone.ownerId]);
  else {
    if (Number.isInteger(context.shopId)) sends.push(['SHOP', context.shopId]);
    if (Number.isInteger(context.doctorUserId)) sends.push(['USER', context.doctorUserId]);
    if (sends.length === 0) {
      const { rows } = await query('SELECT created_by FROM patients WHERE id = $1', [phone.ownerId], opts.client);
      if (rows[0] && rows[0].created_by) sends.push(['USER', rows[0].created_by]);
    }
  }
  const results = [];
  for (const [recipientType, recipientId] of sends) {
    results.push(await notify({ ...payload, recipientType, recipientId, dedupeKey: `${payload.dedupeKey}:${recipientType}:${recipientId}` }, opts));
  }
  return results;
}

module.exports = {
  SMS_MAX,
  MAX_ATTEMPTS,
  notify,
  notifyShop,
  notifyUser,
  notifyPatient,
  listInbox,
  markRead,
  markAllRead,
  alertPhoneUnreachable,
  _validateNotify: validateNotify,
};
