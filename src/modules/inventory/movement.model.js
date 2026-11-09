'use strict';

/**
 * STOCK_MOVEMENTS data access (B5). The ledger is append-only: the database
 * rejects UPDATE, DELETE and TRUNCATE, so there are only insert and read helpers.
 */

const { query } = require('../../db/pool');

const COLUMNS = `id, type, shop_id, batch_id, inventory_id, delta, balance_after, reason, performed_by,
                 request_id, referral_id, idempotency_key, created_at`;

function toPublic(row) {
  if (!row) return null;
  return {
    id: row.id,
    type: row.type,
    shopId: row.shop_id,
    batchId: row.batch_id,
    inventoryId: row.inventory_id,
    delta: row.delta,
    balanceAfter: row.balance_after,
    reason: row.reason,
    performedBy: row.performed_by,
    requestId: row.request_id,
    referralId: row.referral_id,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
  };
}

/**
 * @param {Object} m  { type, shopId, batchId, inventoryId, delta, balanceAfter, reason?,
 *                      performedBy, requestId?, referralId?, idempotencyKey? }
 */
async function insert(m, { client }) {
  const { rows } = await query(
    `INSERT INTO stock_movements
       (type, shop_id, batch_id, inventory_id, delta, balance_after, reason, performed_by,
        request_id, referral_id, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING ${COLUMNS}`,
    [
      m.type, m.shopId, m.batchId, m.inventoryId, m.delta, m.balanceAfter, m.reason ?? null,
      m.performedBy, m.requestId ?? null, m.referralId ?? null, m.idempotencyKey ?? null,
    ],
    client
  );
  return toPublic(rows[0]);
}

/** Rows written earlier under the same idempotency key (one per batch). */
async function findByIdempotencyKey(shopId, type, key, { client } = {}) {
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM stock_movements
      WHERE shop_id = $1 AND type = $2 AND idempotency_key = $3
      ORDER BY id`,
    [shopId, type, key],
    client
  );
  return rows.map(toPublic);
}

async function listForShop(shopId, { batchId, limit = 50, offset = 0, client } = {}) {
  const params = [shopId];
  let w = 'shop_id = $1';
  if (batchId) { params.push(batchId); w += ` AND batch_id = $${params.length}`; }
  params.push(limit, offset);
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM stock_movements WHERE ${w}
      ORDER BY id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
    client
  );
  return rows.map(toPublic);
}

module.exports = { toPublic, insert, findByIdempotencyKey, listForShop };
