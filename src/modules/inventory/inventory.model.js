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

module.exports = { toPublic, enableStockWrites, disableStockWrites, getByShopBatch, addQuantity };
