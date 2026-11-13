'use strict';

/**
 * STOCK_THRESHOLDS (B11): per shop + medicine reorder level.
 * A medicine is low at a shop when its non-expired, unreserved units are
 * below min_quantity.
 */

const { query } = require('../../db/pool');
const { AppError, fromPgError } = require('../../shared/errors');

const TODAY_SQL = `(now() AT TIME ZONE 'Asia/Kolkata')::date`;

/** SQL: available (non-expired, unreserved) units of medicine `m` at shop `s`. */
const AVAILABLE_SQL = (shopCol, medCol) => `
  coalesce((SELECT sum(i.quantity - i.reserved)
              FROM inventory i JOIN medicine_batches b ON b.id = i.batch_id
             WHERE i.shop_id = ${shopCol} AND b.medicine_id = ${medCol}
               AND b.expiry_date > ${TODAY_SQL} AND b.is_active AND i.is_active), 0)::int`;

function toPublic(r) {
  return {
    id: r.id,
    shopId: r.shop_id,
    medicine: { id: r.medicine_id, brandName: r.brand_name, strength: r.strength },
    minQuantity: r.min_quantity,
    available: r.available,
    isLow: r.available < r.min_quantity,
    updatedAt: r.updated_at,
  };
}

const SELECT = `
  SELECT t.id, t.shop_id, t.medicine_id, t.min_quantity, t.updated_at, m.brand_name, m.strength,
         ${AVAILABLE_SQL('t.shop_id', 't.medicine_id')} AS available
    FROM stock_thresholds t
    JOIN medicines m ON m.id = t.medicine_id`;

/** Thresholds of a shop with current availability; `low: true` keeps only the low ones. */
async function list(shopId, { low = false, limit = 50, offset = 0 } = {}) {
  const inner = `${SELECT} WHERE t.shop_id = $1 AND t.is_active`;
  const filtered = `SELECT * FROM (${inner}) x${low ? ' WHERE x.available < x.min_quantity' : ''}`;
  const { rows: [{ total }] } = await query(`SELECT count(*)::int AS total FROM (${filtered}) y`, [shopId]);
  const { rows } = await query(
    `${filtered} ORDER BY (x.available < x.min_quantity) DESC, lower(x.brand_name), x.id LIMIT $2 OFFSET $3`,
    [shopId, limit, offset]
  );
  return { items: rows.map(toPublic), total, limit, offset };
}

async function get(shopId, medicineId, { client } = {}) {
  const { rows } = await query(`${SELECT} WHERE t.shop_id = $1 AND t.medicine_id = $2 AND t.is_active`, [shopId, medicineId], client);
  return rows[0] ? toPublic(rows[0]) : null;
}

/** Create or change a threshold (shop OWNER). */
async function set(shopId, medicineId, minQuantity, setBy) {
  try {
    await query(
      `INSERT INTO stock_thresholds (shop_id, medicine_id, min_quantity, set_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (shop_id, medicine_id)
       DO UPDATE SET min_quantity = EXCLUDED.min_quantity, set_by = EXCLUDED.set_by, is_active = true`,
      [shopId, medicineId, minQuantity, setBy]
    );
  } catch (err) {
    const e = fromPgError(err);
    if (err.code === '23503') throw AppError.notFound(err.constraint && err.constraint.includes('medicine') ? 'Medicine' : 'Shop', medicineId);
    throw e;
  }
  return get(shopId, medicineId);
}

async function remove(shopId, medicineId) {
  const { rowCount } = await query('DELETE FROM stock_thresholds WHERE shop_id = $1 AND medicine_id = $2', [shopId, medicineId]);
  if (!rowCount) throw AppError.notFound('Threshold', { shopId, medicineId });
  return { shopId, medicineId, deleted: true };
}

module.exports = { AVAILABLE_SQL, list, get, set, remove };
