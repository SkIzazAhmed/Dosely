'use strict';

/**
 * Patient messages for accepted referrals (C10).
 *
 * - Only after ACCEPTED: accept() calls queueForAccepted().
 * - Batched per prescription within 10 minutes: one SMS per (patient, batch)
 *   once the batch's first message is BATCH_MINUTES old (sendDueBatches job).
 * - No usable phone (or no patient on the request): a printed slip with the
 *   shop name, address and request number instead (slipFor / GET /referrals/:id/slip).
 */

const { query } = require('../../db/pool');
const { withTransaction } = require('../../db/transaction');
const notifications = require('../notifications/notification.service');
const patientPhone = require('./patientPhone');

const BATCH_MINUTES = 10;

const batchKey = (request) => (request.prescriptionId ? `rx:${request.prescriptionId}` : `req:${request.id}`);

/** What the shop prints when the patient can't get an SMS. */
function slipFor(ref, request) {
  const shop = ref.toShop;
  const lines = [
    'DOSELY REFERRAL SLIP',
    `Request no: ${ref.requestNo}`,
    `Collect: ${ref.quantity} x ${[ref.medicine.brandName, ref.medicine.strength].filter(Boolean).join(' ')}`,
    `At: ${shop.name}`,
    `    ${shop.address}, ${shop.area} ${shop.pincode}`,
  ];
  if (ref.holdUntil) {
    lines.push(`Held until: ${new Date(ref.holdUntil).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`);
  }
  lines.push('Show this slip at the shop.');
  return {
    requestNo: ref.requestNo,
    shopName: shop.name,
    address: `${shop.address}, ${shop.area} ${shop.pincode}`,
    quantity: ref.quantity,
    medicine: ref.medicine,
    holdUntil: ref.holdUntil,
    patientId: request ? request.patientId : ref.patientId,
    text: lines.join('\n'),
  };
}

/**
 * Called inside accept()'s transaction, after the referral is ACCEPTED.
 * @returns {Promise<{method:'SMS', smsAfter:string} | {method:'SLIP', slip:Object}>}
 */
async function queueForAccepted(client, ref, request) {
  const phone = await patientPhone.getUsablePhone(request.patientId, { client });
  const method = phone ? 'SMS' : 'SLIP';
  const key = batchKey(request);
  await client.query(
    `INSERT INTO patient_referral_messages (referral_id, request_id, patient_id, batch_key, method, status)
     VALUES ($1, $2, $3, $4, $5::patient_message_method, $6::patient_message_status)
     ON CONFLICT (referral_id) DO NOTHING`,
    [ref.id, request.id, request.patientId, key, method, method === 'SMS' ? 'QUEUED' : 'SLIP']
  );
  if (method === 'SLIP') return { method, slip: slipFor(ref, request) };

  // The batch goes out BATCH_MINUTES after its first queued message.
  const { rows: [b] } = await client.query(
    `SELECT min(queued_at) + make_interval(mins => $3) AS send_after
       FROM patient_referral_messages
      WHERE patient_id = $1 AND batch_key = $2 AND status = 'QUEUED'`,
    [request.patientId, key, BATCH_MINUTES]
  );
  return { method, smsAfter: b.send_after };
}

const SMS_MAX = notifications.SMS_MAX || 160;

/** One SMS for every referral in a batch, kept within 160 characters. */
function composeSms(items) {
  const head = 'Dosely: medicine held for you. ';
  const tail = ' Show request no. at the shop.';
  const parts = items.map((i) => `${i.request_no} at ${i.shop_name}, ${i.shop_area}`);
  let body = `${head}${parts.join('; ')}.${tail}`;
  // too long: drop the tail, then list fewer shops with "+N more"
  if (body.length > SMS_MAX) body = `${head}${parts.join('; ')}.`;
  for (let n = parts.length - 1; body.length > SMS_MAX && n >= 1; n--) {
    body = `${head}${parts.slice(0, n).join('; ')} +${parts.length - n} more.`;
  }
  return body.length > SMS_MAX ? `${body.slice(0, SMS_MAX - 1)}…` : body;
}

/**
 * Job: send every batch whose first message is at least BATCH_MINUTES old.
 * Messages whose referral is no longer ACCEPTED are SKIPPED.
 * Batches whose SMS notification.service skipped (phone no longer usable) become slips.
 * @returns {Promise<{batches:number, sent:number, skipped:number, slips?:number}>}
 */
async function sendDueBatches() {
  const { rows: due } = await query(
    `SELECT patient_id, batch_key
       FROM patient_referral_messages
      WHERE status = 'QUEUED'
      GROUP BY patient_id, batch_key
     HAVING min(queued_at) <= now() - make_interval(mins => $1)`,
    [BATCH_MINUTES]
  );
  const out = { batches: 0, sent: 0, skipped: 0 };
  for (const { patient_id: patientId, batch_key: key } of due) {
    await withTransaction(async (client) => {
      const { rows } = await client.query(
        `SELECT m.id, m.referral_id, f.status AS referral_status, f.from_shop_id, r.request_no,
                ts.name AS shop_name, ts.area AS shop_area, d.user_id AS doctor_user_id
           FROM patient_referral_messages m
           JOIN referrals f ON f.id = m.referral_id
           JOIN stock_requests r ON r.id = m.request_id
           JOIN shops ts ON ts.id = f.to_shop_id
           LEFT JOIN doctors d ON d.id = r.doctor_id
          WHERE m.patient_id = $1 AND m.batch_key = $2 AND m.status = 'QUEUED'
          ORDER BY m.queued_at, m.id
          FOR UPDATE OF m SKIP LOCKED`,
        [patientId, key]
      );
      const live = rows.filter((r) => r.referral_status === 'ACCEPTED');
      const dead = rows.filter((r) => r.referral_status !== 'ACCEPTED');
      if (dead.length) {
        await client.query(`UPDATE patient_referral_messages SET status = 'SKIPPED' WHERE id = ANY($1::bigint[])`, [
          dead.map((r) => r.id),
        ]);
        out.skipped += dead.length;
      }
      if (!live.length) return;

      const result = await notifications.notifyPatient(
        patientId,
        {
          channels: ['SMS'],
          type: 'REFERRAL_READY',
          title: 'Medicine held for you',
          body: composeSms(live),
          // shopId / doctorUserId: who gets the P13 alert if this number turns out unreachable
          data: {
            referralIds: live.map((r) => r.referral_id),
            batchKey: key,
            shopId: Number(live[0].from_shop_id),
            doctorUserId: live[0].doctor_user_id == null ? undefined : Number(live[0].doctor_user_id),
          },
          dedupeKey: `referral-sms:${live.map((r) => r.id).join(',')}`,
        },
        { client }
      );
      const notificationIds = JSON.stringify((result.notifications || []).map((n) => n.id));

      // F4.9 / edge cases 9, 10: the phone stopped being usable after accept (unverified,
      // unreachable or removed) — notification.service skipped the SMS. Switch these to the
      // printed slip and tell the origin shop(s) to inform the patient in person.
      if (result.skipped && result.skipped.length) {
        await client.query(
          `UPDATE patient_referral_messages SET method = 'SLIP', status = 'SLIP', notification_ids = $2::jsonb
            WHERE id = ANY($1::bigint[])`,
          [live.map((r) => r.id), notificationIds]
        );
        const reason = result.skipped[0].skipReason;
        for (const shopId of [...new Set(live.map((r) => Number(r.from_shop_id)))]) {
          const mine = live.filter((r) => Number(r.from_shop_id) === shopId);
          await notifications.notifyShop(shopId, {
            channels: ['IN_APP'],
            type: 'REFERRAL_SMS_FAILED',
            title: 'Patient SMS not sent — print the slip',
            body: `The patient's phone can't receive SMS (${reason}). Inform them in person and print the referral slip for ${mine.map((r) => r.request_no).join(', ')}.`,
            data: { referralIds: mine.map((r) => r.referral_id), skipReason: reason },
            dedupeKey: `referral-sms-failed:${mine.map((r) => r.id).join(',')}`,
          }, { client });
        }
        out.batches += 1;
        out.slips = (out.slips || 0) + live.length;
        return;
      }

      await client.query(
        `UPDATE patient_referral_messages SET status = 'SENT', sent_at = now(), notification_ids = $2::jsonb
          WHERE id = ANY($1::bigint[])`,
        [live.map((r) => r.id), notificationIds]
      );
      out.batches += 1;
      out.sent += live.length;
    });
  }
  return out;
}

module.exports = { BATCH_MINUTES, batchKey, slipFor, queueForAccepted, composeSms, sendDueBatches };
