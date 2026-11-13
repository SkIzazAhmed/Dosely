'use strict';

/**
 * Delivery of PENDING SMS / EMAIL notifications (A11, F6.3, P13).
 *
 *   - Picks due rows with FOR UPDATE SKIP LOCKED, so two workers never send
 *     the same message twice.
 *   - Each pick counts as an attempt. On failure the row is retried with
 *     exponential backoff (30s, 1m, 2m, 4m by default); after 5 attempts it's FAILED.
 *   - SMS failures also count against the phone number (P13): the 3rd failure
 *     in a row marks it UNREACHABLE and alerts the shop or doctor. A message that
 *     is already queued keeps its remaining attempts; new messages skip that number.
 *   - A queued SMS whose number was removed or had its digits changed (P12) is
 *     SKIPPED rather than sent to the wrong place.
 */

const { pool, query } = require('../../db/pool');
const config = require('../../config');
const phones = require('../phones/phones.service');
const notifications = require('./notification.service');
const channels = require('./channels');

/** Delay before retry number `attempt` (1-based count of attempts already made). */
function backoffMs(attempt, { base = config.notifications.backoffBaseMs, max = config.notifications.backoffMaxMs } = {}) {
  return Math.min(base * 2 ** Math.max(0, attempt - 1), max);
}

/** Claim up to `limit` due rows: attempts + 1, and a short lease so a crashed worker's rows come back. */
async function claimDue(limit) {
  const { rows } = await query(
    `UPDATE notifications n
        SET attempts = n.attempts + 1,
            next_attempt_at = now() + interval '5 minutes'
      WHERE n.id IN (
        SELECT id FROM notifications
         WHERE status = 'PENDING' AND channel IN ('SMS', 'EMAIL') AND next_attempt_at <= now()
         ORDER BY next_attempt_at, id
         LIMIT $1
         FOR UPDATE SKIP LOCKED)
      RETURNING n.*`,
    [limit]
  );
  return rows;
}

async function markSent(row) {
  await query(
    `UPDATE notifications SET status = 'SENT', sent_at = now(), next_attempt_at = NULL, last_error = NULL WHERE id = $1`,
    [row.id]
  );
}

async function markSkipped(row, reason) {
  await query(
    `UPDATE notifications SET status = 'SKIPPED', skip_reason = $2, next_attempt_at = NULL WHERE id = $1`,
    [row.id, reason]
  );
}

/** Retry later, or FAILED when out of attempts. Returns 'retried' | 'failed'. */
async function markFailure(row, err) {
  const outOfAttempts = row.attempts >= row.max_attempts || (err && err.permanent);
  if (outOfAttempts) {
    await query(
      `UPDATE notifications SET status = 'FAILED', next_attempt_at = NULL, last_error = $2 WHERE id = $1`,
      [row.id, String(err.message).slice(0, 500)]
    );
    return 'failed';
  }
  await query(
    `UPDATE notifications SET next_attempt_at = now() + make_interval(secs => $2::double precision / 1000), last_error = $3 WHERE id = $1`,
    [row.id, backoffMs(row.attempts), String(err.message).slice(0, 500)]
  );
  return 'retried';
}

async function deliverSms(row) {
  const { rows: [phone] } = await query('SELECT id, e164, kind, status, is_active FROM phone_numbers WHERE id = $1', [row.phone_id]);
  if (!phone || !phone.is_active) return { skipped: 'PHONE_REMOVED' };
  if (phone.kind !== 'MOBILE') return { skipped: 'NO_VERIFIED_MOBILE' };
  if (phone.status === 'UNVERIFIED') return { skipped: 'NO_VERIFIED_MOBILE' }; // digits changed since queueing (P12)
  await channels.sms.send({ to: phone.e164, body: row.body });
  return { sent: true };
}

async function deliverEmail(row) {
  if (!row.email) return { skipped: 'NO_EMAIL' };
  await channels.email.send({ to: row.email, subject: row.title, body: row.body });
  return { sent: true };
}

/** P13: count the failure against the number; alert on the 3rd in a row. */
async function phoneFailed(row) {
  const { phone, becameUnreachable } = await phones.recordDeliveryFailure(row.phone_id);
  if (becameUnreachable) {
    try {
      await notifications.alertPhoneUnreachable(phone, row.data || {});
    } catch (err) {
      console.error('[delivery] could not send PHONE_UNREACHABLE alert:', err.message);
    }
  }
  return becameUnreachable;
}

async function deliverOne(row) {
  try {
    const out = row.channel === 'SMS' ? await deliverSms(row) : await deliverEmail(row);
    if (out.skipped) {
      await markSkipped(row, out.skipped);
      return 'skipped';
    }
    await markSent(row);
    if (row.channel === 'SMS') await phones.recordDeliverySuccess(row.phone_id);
    return 'sent';
  } catch (err) {
    if (err.name !== 'DeliveryError') console.error(`[delivery] notification ${row.id}:`, err.message);
    const outcome = await markFailure(row, err);
    if (row.channel === 'SMS' && row.phone_id) await phoneFailed(row);
    return outcome;
  }
}

/**
 * Send everything that's due. Returns counts: { claimed, sent, retried, failed, skipped }.
 */
async function deliverDue({ limit = 100 } = {}) {
  const rows = await claimDue(limit);
  const summary = { claimed: rows.length, sent: 0, retried: 0, failed: 0, skipped: 0 };
  for (const row of rows) summary[await deliverOne(row)] += 1;
  return summary;
}

module.exports = { deliverDue, backoffMs, _pool: pool };
