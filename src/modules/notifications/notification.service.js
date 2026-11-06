'use strict';

/**
 * notification.service — INTERFACE STUBS (Commit 1, Nov 4).
 *
 * Rachana (low-stock alerts) and Anushka (request + referral alerts) code
 * against these signatures from today. The real implementation lands in
 * Commit 5 (Nov 12: in-app, fan-out, dedupe) and Commit 6 (Nov 14: SMS/email,
 * retries). Signatures below are the contract — agree on them Nov 4 and
 * don't change them without telling the team.
 *
 * Until Nov 12 the stubs validate input, log, and return a fake result
 * with the same shape the real service will return.
 */

const { AppError } = require('../../shared/errors');
const { NotificationChannel, NotificationRecipientType } = require('../../shared/enums');

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
 * @property {Object}       [data]          extra JSON for the client (ids, links)
 * @property {string}       [dedupeKey]     same key twice = sent once, e.g. `low-stock:${shopId}:${itemId}:${date}`
 *
 * @typedef {Object} NotifyResult
 * @property {boolean} deduped              true if dedupeKey was already used (nothing new created)
 * @property {Array<{id:number, channel:Channel, recipientUserId:(number|null), status:string}>} notifications
 *           one row per (channel x recipient). A SHOP fans out to every active staff member.
 */

const SMS_MAX = 160;

function validateNotify(input) {
  const errors = [];
  if (!input || typeof input !== 'object') throw AppError.validation([{ field: 'input', issue: 'required' }]);
  if (!NotificationRecipientType[input.recipientType]) errors.push({ field: 'recipientType', issue: 'must be USER, PATIENT or SHOP' });
  if (!Number.isInteger(input.recipientId) || input.recipientId <= 0) errors.push({ field: 'recipientId', issue: 'must be a positive integer' });
  if (!Array.isArray(input.channels) || input.channels.length === 0 || input.channels.some((c) => !NotificationChannel[c])) {
    errors.push({ field: 'channels', issue: 'must be a non-empty array of IN_APP, SMS, EMAIL' });
  }
  if (!input.type || typeof input.type !== 'string') errors.push({ field: 'type', issue: 'required' });
  if (!input.title || typeof input.title !== 'string') errors.push({ field: 'title', issue: 'required' });
  if (!input.body || typeof input.body !== 'string') errors.push({ field: 'body', issue: 'required' });
  if (input.recipientType === 'PATIENT' && Array.isArray(input.channels) && input.channels.includes('IN_APP')) {
    errors.push({ field: 'channels', issue: 'patients have no login, so IN_APP is not allowed' });
  }
  if (errors.length) throw AppError.validation(errors);
  if (input.channels.includes('SMS') && input.body.length > SMS_MAX) {
    throw new AppError('SMS_TOO_LONG', undefined, { length: input.body.length, max: SMS_MAX });
  }
}

let fakeId = 0;

/**
 * Send a notification to a user, a patient or a shop (all active staff).
 * @param {NotifyInput} input
 * @param {{client?: import('pg').PoolClient}} [opts] pass your transaction client
 *        so the notification is only created if your transaction commits.
 * @returns {Promise<NotifyResult>}
 */
async function notify(input, opts = {}) { // eslint-disable-line no-unused-vars
  validateNotify(input);
  console.log('[notification.service STUB] notify', JSON.stringify(input));
  return {
    deduped: false,
    notifications: input.channels.map((channel) => ({
      id: ++fakeId,
      channel,
      recipientUserId: input.recipientType === 'USER' ? input.recipientId : null,
      status: 'PENDING',
    })),
  };
}

/** Shortcut: notify every active staff member of a shop. */
function notifyShop(shopId, payload, opts) {
  return notify({ ...payload, recipientType: 'SHOP', recipientId: shopId }, opts);
}

/** Shortcut: notify one user. */
function notifyUser(userId, payload, opts) {
  return notify({ ...payload, recipientType: 'USER', recipientId: userId }, opts);
}

/** Shortcut: SMS a patient on their primary usable phone (edge cases 9, 10). */
function notifyPatient(patientId, payload, opts) {
  return notify({ ...payload, channels: payload.channels || ['SMS'], recipientType: 'PATIENT', recipientId: patientId }, opts);
}

/**
 * In-app inbox for the logged-in user (GET /notifications).
 * @param {number} userId
 * @param {{unreadOnly?: boolean, limit?: number, before?: number}} [query]
 * @returns {Promise<{items: Array<Object>, unreadCount: number}>}
 */
async function listInbox(userId, query = {}) { // eslint-disable-line no-unused-vars
  return { items: [], unreadCount: 0 };
}

/**
 * Mark one in-app notification read (POST /notifications/:id/read).
 * Only the recipient may mark it; otherwise NOT_FOUND.
 * @returns {Promise<{id:number, readAt:string}>}
 */
async function markRead(notificationId, userId) { // eslint-disable-line no-unused-vars
  return { id: notificationId, readAt: new Date().toISOString() };
}

module.exports = {
  SMS_MAX,
  notify,
  notifyShop,
  notifyUser,
  notifyPatient,
  listInbox,
  markRead,
  _validateNotify: validateNotify,
};
