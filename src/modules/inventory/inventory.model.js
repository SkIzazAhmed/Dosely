'use strict';

/**
 * INVENTORY data access (B4). Only stock.service may call the write helpers,
 * and only inside a transaction that has called enableStockWrites(client):
 * the database rejects any other write (trigger inventory_require_stock_service).
 */

const { query } = require('../../db/pool');

const COLUMNS = 'id, shop_id, batch_id, quantity, reserved, version, is_active, created_at, updated_at';

function toPublic(row) {
  if (!row) return null;
  return {
    id: row.id,
    shopId: row.shop_id,
    batchId: row.batch_id,
    quantity: row.quantity,
    reserved: row.reserved,
    available: row.quantity - row.reserved,
    version: row.version,
    updatedAt: row.updated_at,
  };
}

/** Allow inventory writes for the rest of this transaction (B6). */
async function enableStockWrites(client) {
  await client.query(`SELECT set_config('dosely.stock_writer', 'on', true)`);
}

/** Turn writes off again, so the caller's own statements after a nested stock call stay guarded. */
async function disableStockWrites(client) {
  await client.query(`SELECT set_config('dosely.stock_writer', 'off', true)`);
}

async function getByShopBatch(shopId, batchId, { client } = {}) {
  const { rows } = await query(`SELECT ${COLUMNS} FROM inventory WHERE shop_id = $1 AND batch_id = $2`, [shopId, batchId], client);
  return toPublic(rows[0]);
}

/**
 * Add units to a shop's batch in one atomic statement: creates the row on the
 * first stock-in, otherwise increments it (concurrent stock-ins can't lose
 * an update). Returns the row after the change.
 */
async function addQuantity(shopId, batchId, qty, { client }) {
  const { rows } = await query(
    `INSERT INTO inventory (shop_id, batch_id, quantity)
     VALUES ($1, $2, $3)
     ON CONFLICT (shop_id, batch_id) DO UPDATE SET quantity = inventory.quantity + EXCLUDED.quantity
     RETURNING ${COLUMNS}`,
    [shopId, batchId, qty],
    client
  );
  return toPublic(rows[0]);
}

const TODAY_SQL = `(now() AT TIME ZONE 'Asia/Kolkata')::date`;

/**
 * Stock list for a shop: one row per batch (B11 view). Earliest expiry first.
 * @param {number} shopId
 * @param {Object} f
 * @param {number}  [f.medicineId]
 * @param {string}  [f.q]              brand or generic name contains
 * @param {number}  [f.expiring]       only non-expired batches expiring within N days
 * @param {boolean} [f.expired]        only expired batches that still hold units (to write off)
 * @param {boolean} [f.includeEmpty]   include rows at quantity 0 (default false)
 * @param {string}  [f.extraWhere]     extra SQL condition on alias i / b / m (used by the low-stock filter)
 */
async function listForShop(shopId, f = {}, { limit = 50, offset = 0 } = {}) {
  const where = ['i.shop_id = $1', 'i.is_active'];
  const params = [shopId];
  const add = (sql, v) => { params.push(v); where.push(sql.replaceAll('$?', `$${params.length}`)); };

  if (f.medicineId) add('b.medicine_id = $?', f.medicineId);
  if (f.q) {
    add(`(m.brand_name ILIKE $? OR g.name ILIKE $?)`, `%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  }
  if (f.expiring) {
    add(`b.expiry_date > ${TODAY_SQL} AND b.expiry_date <= ${TODAY_SQL} + $?::int`, f.expiring);
  }
  if (f.expired) where.push(`b.expiry_date <= ${TODAY_SQL}`);
  if (!f.includeEmpty || f.expired) where.push('i.quantity > 0');
  if (f.extraWhere) where.push(f.extraWhere);

  const from = `
    FROM inventory i
    JOIN medicine_batches b ON b.id = i.batch_id
    JOIN medicines m ON m.id = b.medicine_id
    JOIN generics g ON g.id = m.generic_id
   WHERE ${where.join(' AND ')}`;

  const { rows: [{ total }] } = await query(`SELECT count(*)::int AS total ${from}`, params);
  params.push(limit, offset);
  const { rows } = await query(
    `SELECT i.id, i.batch_id, i.quantity, i.reserved, i.version, i.updated_at,
            b.batch_no, b.expiry_date::text AS expiry_date, b.mrp,
            (b.expiry_date <= ${TODAY_SQL}) AS is_expired,
            (b.expiry_date - ${TODAY_SQL}) AS days_to_expiry,
            m.id AS medicine_id, m.brand_name, m.strength, m.dosage_form, m.base_unit, g.name AS generic_name
       ${from}
      ORDER BY b.expiry_date, m.brand_name, b.id
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return {
    items: rows.map((r) => ({
      inventoryId: r.id,
      medicine: {
        id: r.medicine_id, brandName: r.brand_name, genericName: r.generic_name,
        strength: r.strength, dosageForm: r.dosage_form, baseUnit: r.base_unit,
      },
      batch: {
        id: r.batch_id, batchNo: r.batch_no, expiryDate: r.expiry_date, mrp: r.mrp,
        isExpired: r.is_expired, daysToExpiry: r.days_to_expiry,
      },
      quantity: r.quantity,
      reserved: r.reserved,
      available: r.is_expired ? 0 : r.quantity - r.reserved,
      version: r.version,
      updatedAt: r.updated_at,
    })),
    total,
    limit,
    offset,
  };
}

module.exports = { toPublic, enableStockWrites, disableStockWrites, getByShopBatch, addQuantity, listForShop };
