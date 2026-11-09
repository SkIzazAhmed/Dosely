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

module.exports = {
  create,
  getById,
  getByIdOrThrow,
  getForUser,
  listForDoctor,
  listForShop,
  actorFor,
  availableAt,
};
