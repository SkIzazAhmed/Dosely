'use strict';

/**
 * MEDICINE_BATCHES (B3, B7).
 *
 * A batch is identified by (medicine, batch number). Its expiry date and MRP
 * never change once created: if the same batch number shows up again with a
 * different expiry or MRP, that's 409 BATCH_MISMATCH (edge case 15).
 *
 * "Expired" means expiry_date <= today in India (Asia/Kolkata): a batch can't
 * be received or sold on its expiry date.
 *
 * Only catalog admins (via routes) and stock.service call this module.
 */

const { query } = require('../../db/pool');
const { AppError, fromPgError } = require('../../shared/errors');

const PG_MAP = {
  medicine_batches_medicine_batch_no_key: 'BATCH_NO_TAKEN',
  medicine_batches_medicine_id_fkey: 'NOT_FOUND',
};

/** Today's date in India, as SQL. Used everywhere expiry is compared. */
const TODAY_SQL = `(now() AT TIME ZONE 'Asia/Kolkata')::date`;

const SELECT = `
  SELECT b.id, b.medicine_id, b.batch_no, b.manufacture_date::text AS manufacture_date,
         b.expiry_date::text AS expiry_date, b.mrp, b.is_active, b.created_at, b.updated_at,
         (b.expiry_date <= ${TODAY_SQL}) AS is_expired
    FROM medicine_batches b`;

function toPublic(row) {
  if (!row) return null;
  return {
    id: row.id,
    medicineId: row.medicine_id,
    batchNo: row.batch_no,
    manufactureDate: row.manufacture_date,
    expiryDate: row.expiry_date,
    mrp: row.mrp,
    isExpired: row.is_expired,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isRealDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Batch numbers are stored trimmed and upper-cased so "dl2401 " and "DL2401" are one batch. */
const normalizeBatchNo = (s) => s.trim().toUpperCase();

/**
 * Validate { batchNo, manufactureDate?, expiryDate, mrp } (B3).
 * Returns the cleaned object or throws VALIDATION_ERROR listing every bad field.
 * `prefix` is prepended to field names (e.g. 'batches[0].').
 */
function validateBatch(input, { prefix = '' } = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const errors = [];
  const f = (name) => `${prefix}${name}`;

  if (typeof src.batchNo !== 'string' || src.batchNo.trim() === '') errors.push({ field: f('batchNo'), issue: 'required' });
  else if (src.batchNo.trim().length > 50) errors.push({ field: f('batchNo'), issue: 'must be at most 50 characters' });

  if (src.expiryDate === undefined || src.expiryDate === null) errors.push({ field: f('expiryDate'), issue: 'required' });
  else if (!isRealDate(src.expiryDate)) errors.push({ field: f('expiryDate'), issue: 'must be a date YYYY-MM-DD' });

  const mfg = src.manufactureDate ?? null;
  if (mfg !== null && !isRealDate(mfg)) errors.push({ field: f('manufactureDate'), issue: 'must be a date YYYY-MM-DD' });
  else if (mfg !== null && isRealDate(src.expiryDate) && mfg >= src.expiryDate) {
    errors.push({ field: f('manufactureDate'), issue: 'must be before expiryDate' });
  }

  const mrp = typeof src.mrp === 'string' && /^\d+(\.\d{1,2})?$/.test(src.mrp) ? Number(src.mrp) : src.mrp;
  if (mrp === undefined || mrp === null) errors.push({ field: f('mrp'), issue: 'required' });
  else if (typeof mrp !== 'number' || !Number.isFinite(mrp) || mrp <= 0 || Math.round(mrp * 100) !== mrp * 100 || mrp > 9999999999) {
    errors.push({ field: f('mrp'), issue: 'must be an amount in INR > 0 with at most 2 decimals' });
  }

  if (errors.length) throw AppError.validation(errors);
  return {
    batchNo: normalizeBatchNo(src.batchNo),
    manufactureDate: mfg,
    expiryDate: src.expiryDate,
    mrp,
  };
}

async function isExpiredDate(expiryDate, client) {
  const { rows } = await query(`SELECT ($1::date <= ${TODAY_SQL}) AS expired`, [expiryDate], client);
  return rows[0].expired;
}

async function getById(id, { client } = {}) {
  const { rows } = await query(`${SELECT} WHERE b.id = $1`, [id], client);
  return toPublic(rows[0]);
}

async function findByNo(medicineId, batchNo, { client, forUpdate = false } = {}) {
  const { rows } = await query(
    `${SELECT} WHERE b.medicine_id = $1 AND upper(btrim(b.batch_no)) = $2${forUpdate ? ' FOR UPDATE' : ''}`,
    [medicineId, normalizeBatchNo(batchNo)],
    client
  );
  return toPublic(rows[0]);
}

/**
 * Create a batch for a medicine (admin catalog route).
 * Throws BATCH_EXPIRED (422) for an expired batch, BATCH_NO_TAKEN (409) when
 * the number exists for this medicine.
 */
async function create(medicineId, input, { client } = {}) {
  const b = validateBatch(input);
  if (await isExpiredDate(b.expiryDate, client)) {
    throw new AppError('BATCH_EXPIRED', undefined, { batchNo: b.batchNo, expiryDate: b.expiryDate });
  }
  try {
    const { rows: [{ id }] } = await query(
      `INSERT INTO medicine_batches (medicine_id, batch_no, manufacture_date, expiry_date, mrp)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [medicineId, b.batchNo, b.manufactureDate, b.expiryDate, b.mrp],
      client
    );
    return getById(id, { client });
  } catch (err) {
    const mapped = fromPgError(err, PG_MAP);
    if (mapped.code === 'NOT_FOUND') throw AppError.notFound('Medicine', medicineId);
    throw mapped;
  }
}

/**
 * For stock-in (B7, edge case 15): return the existing batch when the number
 * is known and expiry + MRP match, create it when it's new, or throw
 * BATCH_MISMATCH when it's known with a different expiry or MRP.
 * Safe under concurrency: a racing insert of the same number is retried as a lookup.
 * Caller has already validated input and rejected expired batches.
 */
async function findOrCreateForStockIn(medicineId, b, { client }) {
  const check = (found) => {
    if (found.expiryDate !== b.expiryDate || Number(found.mrp) !== Number(b.mrp)) {
      throw new AppError('BATCH_MISMATCH', undefined, {
        batchId: found.id,
        batchNo: found.batchNo,
        known: { expiryDate: found.expiryDate, mrp: found.mrp },
        sent: { expiryDate: b.expiryDate, mrp: b.mrp },
      });
    }
    return { batch: found, created: false };
  };

  const existing = await findByNo(medicineId, b.batchNo, { client });
  if (existing) return check(existing);

  const { rows } = await query(
    `INSERT INTO medicine_batches (medicine_id, batch_no, manufacture_date, expiry_date, mrp)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (medicine_id, upper(btrim(batch_no))) DO NOTHING
     RETURNING id`,
    [medicineId, b.batchNo, b.manufactureDate, b.expiryDate, b.mrp],
    client
  );
  if (rows[0]) return { batch: await getById(rows[0].id, { client }), created: true };
  return check(await findByNo(medicineId, b.batchNo, { client }));
}

async function listForMedicine(medicineId, { includeExpired = false, includeInactive = false, client } = {}) {
  const where = ['b.medicine_id = $1'];
  if (!includeExpired) where.push(`b.expiry_date > ${TODAY_SQL}`);
  if (!includeInactive) where.push('b.is_active');
  const { rows } = await query(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY b.expiry_date, b.id`, [medicineId], client);
  return rows.map(toPublic);
}

module.exports = {
  TODAY_SQL,
  validateBatch,
  normalizeBatchNo,
  isExpiredDate,
  getById,
  findByNo,
  create,
  findOrCreateForStockIn,
  listForMedicine,
};
