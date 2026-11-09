'use strict';

/**
 * Stock requests (C1–C3): a doctor asks one shop for one medicine the shop
 * doesn't have enough of.
 */

const { query } = require('../../db/pool');
const { withTransaction } = require('../../db/transaction');
const { AppError, fromPgError } = require('../../shared/errors');
const doctors = require('../doctors/doctors.service');
const stock = require('../inventory/stock.service');
const shopAccess = require('./shopAccess');
const state = require('./request.state');
const referralState = require('../referrals/referral.state');
const { URGENCY_HOURS, SELECT, STATUS_ORDER, toPublic, groupByPrescription } = require('./request.model');

async function getById(id, { client, forUpdate = false } = {}) {
  if (forUpdate) {
    // lock only the request row; the joins in SELECT are read-only
    const { rows } = await query('SELECT id FROM stock_requests WHERE id = $1 FOR UPDATE', [id], client);
    if (!rows.length) return null;
  }
  const { rows } = await query(`${SELECT} WHERE r.id = $1`, [id], client);
  return toPublic(rows[0]);
}

async function getByIdOrThrow(id, opts) {
  const r = await getById(id, opts);
  if (!r) throw AppError.notFound('Request', id);
  return r;
}

async function assertMedicineActive(medicineId, { client } = {}) {
  const { rows: [m] } = await query('SELECT id, is_active FROM medicines WHERE id = $1', [medicineId], client);
  if (!m) throw AppError.notFound('Medicine', medicineId);
  if (!m.is_active) throw new AppError('MEDICINE_INACTIVE', undefined, { medicineId });
}

/** Non-expired, unreserved units of `medicineId` at `shopId` right now. */
async function availableAt(shopId, medicineId, { client } = {}) {
  const rows = await stock.getAvailable(medicineId, { shopIds: [shopId] }, { client });
  return rows.reduce((n, r) => n + r.available, 0);
}

/**
 * C1, C2: create a request. Only allowed when the shop is short: quantity is
 * more than what it has available (edge cases 1, 7). The available quantity
 * at that moment is stored as a snapshot.
 *
 * @param {number} doctorUserId  users.id of the logged-in doctor
 * @param {Object} input  { shopId, medicineId, quantity, urgency?, doctorNote?, patientId?, prescriptionId? }
 */
async function create(doctorUserId, input) {
  return withTransaction(async (client) => {
    const doctor = await doctors.assertCanSendRequests(doctorUserId, { client });
    await shopAccess.assertShopActive(input.shopId, { client });
    await assertMedicineActive(input.medicineId, { client });

    const available = await availableAt(input.shopId, input.medicineId, { client });
    if (input.quantity <= available) {
      throw new AppError('REQUEST_NOT_SHORT', undefined, {
        shopId: input.shopId, medicineId: input.medicineId, requested: input.quantity, available,
      });
    }

    const urgency = input.urgency || 'ROUTINE';
    try {
      const { rows: [{ id }] } = await client.query(
        `INSERT INTO stock_requests
           (request_no, doctor_id, shop_id, patient_id, prescription_id, medicine_id,
            requested_qty, available_qty_snapshot, urgency, doctor_note, expires_at)
         VALUES (next_request_no(), $1, $2, $3, $4, $5, $6, $7, $8, $9, now() + make_interval(hours => $10))
         RETURNING id`,
        [
          doctor.id, input.shopId, input.patientId ?? null, input.prescriptionId ?? null, input.medicineId,
          input.quantity, available, urgency, input.doctorNote ?? null, URGENCY_HOURS[urgency],
        ]
      );
      return getById(id, { client });
    } catch (err) {
      throw fromPgError(err);
    }
  });
}

async function list(where, params, order, { status, limit = 20, offset = 0 }) {
  if (status) {
    params.push(status);
    where.push(`r.status = $${params.length}`);
  }
  const w = `WHERE ${where.join(' AND ')}`;
  const { rows: [{ total }] } = await query(`SELECT count(*)::int AS total FROM stock_requests r ${w}`, params);
  params.push(limit, offset);
  const { rows } = await query(
    `${SELECT} ${w} ORDER BY ${order} LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return { items: groupByPrescription(rows.map(toPublic)), total, limit, offset };
}

/** C3: the doctor's own requests, newest first, grouped by prescription. */
async function listForDoctor(doctorUserId, filters = {}) {
  const doctor = await doctors.getByUserId(doctorUserId);
  if (!doctor) throw AppError.notFound('Doctor profile');
  return list(['r.doctor_id = $1'], [doctor.id], 'r.created_at DESC, r.id DESC', filters);
}

/** C3: a shop's inbox, by status (open work first), newest first within a status. */
async function listForShop(shopId, filters = {}) {
  return list(['r.shop_id = $1'], [shopId], `${STATUS_ORDER}, r.created_at DESC, r.id DESC`, filters);
}

/**
 * Who is looking at a request: 'DOCTOR' (the sender), 'SHOP' (staff of the
 * shop it was sent to) or 'ADMIN'. Throws FORBIDDEN / NOT_SHOP_STAFF otherwise.
 */
async function actorFor(user, request, { client } = {}) {
  if (user.role === 'ADMIN') return 'ADMIN';
  if (user.role === 'DOCTOR') {
    const doctor = await doctors.getByUserId(user.id, { client });
    if (!doctor || doctor.id !== request.doctor.id) throw new AppError('FORBIDDEN', 'Not your request');
    return 'DOCTOR';
  }
  await shopAccess.assertStaff(user, request.shopId, { client });
  return 'SHOP';
}

async function getForUser(user, id) {
  const request = await getByIdOrThrow(id);
  await actorFor(user, request);
  return request;
}


// ---------------------------------------------------------------------------
// Status changes (C4, C5)
// ---------------------------------------------------------------------------

/**
 * Resolve the caller to the actor a move needs. ADMIN may act for the shop or
 * the doctor; everyone else must be the real thing (actorFor throws otherwise).
 */
async function actAs(user, request, needed, { client } = {}) {
  const actor = await actorFor(user, request, { client });
  if (actor === 'ADMIN') return needed;
  if (actor !== needed) {
    throw new AppError('FORBIDDEN', needed === 'DOCTOR' ? 'Only the doctor who sent the request can do this' : 'Only staff of the request’s shop can do this');
  }
  return actor;
}

async function liveReferralCount(requestId, { client } = {}) {
  const { rows: [{ n }] } = await query(
    `SELECT count(*)::int AS n FROM referrals WHERE request_id = $1 AND status IN ('PENDING', 'ACCEPTED')`,
    [requestId],
    client
  );
  return n;
}

/**
 * C5: acknowledge — only from SENT and before expiry. The UPDATE is conditional
 * on status = 'SENT' AND expires_at > now(), so it can't race the
 * expireRequests job (edge case 16): whichever commits first wins, the other
 * gets 409 INVALID_TRANSITION.
 */
async function acknowledge(user, id) {
  const request = await getByIdOrThrow(id);
  const actor = await actAs(user, request, 'SHOP');
  state.assertTransition(request.status, 'ACKNOWLEDGED', actor, { request });

  const { rowCount } = await query(
    `UPDATE stock_requests
        SET status = 'ACKNOWLEDGED', acknowledged_at = now(), acknowledged_by = $2
      WHERE id = $1 AND status = 'SENT' AND expires_at > now()`,
    [id, user.id]
  );
  if (rowCount === 0) {
    // lost the race (expired or acknowledged meanwhile): report against the current row
    const now = await getByIdOrThrow(id);
    state.assertTransition(now.status, 'ACKNOWLEDGED', actor, { request: now });
    throw new AppError('INVALID_TRANSITION', `Cannot move request from ${now.status} to ACKNOWLEDGED`, {
      entity: 'stock_request', from: now.status, to: 'ACKNOWLEDGED', actor, reason: 'request has expired',
    });
  }
  return getById(id);
}

/** C5: the shop closes an open request with a reason. */
async function close(user, id, reason) {
  return withTransaction(async (client) => {
    const request = await getByIdOrThrow(id, { client, forUpdate: true });
    const actor = await actAs(user, request, 'SHOP', { client });
    state.assertTransition(request.status, 'CLOSED', actor, {
      request, reason, liveReferrals: await liveReferralCount(id, { client }),
    });
    await client.query(
      `UPDATE stock_requests
          SET status = 'CLOSED', closed_at = now(), closed_by = $2, close_reason = $3
        WHERE id = $1`,
      [id, user.id, reason.trim()]
    );
    return getById(id, { client });
  });
}

/**
 * C5 / edge case 11: the doctor cancels. Every live referral is cancelled too,
 * and stock held for an ACCEPTED referral is released at the target shop.
 */
async function cancel(user, id, reason = null) {
  return withTransaction(async (client) => {
    const request = await getByIdOrThrow(id, { client, forUpdate: true });
    const actor = await actAs(user, request, 'DOCTOR', { client });
    state.assertTransition(request.status, 'CANCELLED', actor, { request });

    const { rows: live } = await client.query(
      `SELECT * FROM referrals WHERE request_id = $1 AND status IN ('PENDING', 'ACCEPTED') ORDER BY id FOR UPDATE`,
      [id]
    );
    const released = [];
    for (const ref of live) {
      referralState.assertTransition(ref.status, 'CANCELLED', 'DOCTOR', { referral: ref });
      if (ref.status === 'ACCEPTED' && Array.isArray(ref.reservation_lines) && ref.reservation_lines.length) {
        const r = await stock.release(
          { shopId: ref.to_shop_id, referralId: ref.id, lines: ref.reservation_lines, performedBy: user.id },
          { client }
        );
        released.push({ referralId: ref.id, shopId: ref.to_shop_id, released: r.released });
      }
      await client.query(
        `UPDATE referrals SET status = 'CANCELLED', cancelled_at = now(), cancel_reason = 'Request cancelled by doctor'
          WHERE id = $1`,
        [ref.id]
      );
    }

    await client.query(
      `UPDATE stock_requests SET status = 'CANCELLED', cancelled_at = now(), cancel_reason = $2 WHERE id = $1`,
      [id, reason]
    );
    const updated = await getById(id, { client });
    return { ...updated, cancelledReferrals: live.map((r) => r.id), released };
  });
}

module.exports = {
  acknowledge,
  close,
  cancel,
  liveReferralCount,
  create,
  getById,
  getByIdOrThrow,
  getForUser,
  listForDoctor,
  listForShop,
  actorFor,
  availableAt,
};
