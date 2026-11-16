'use strict';

/**
 * Stock alerts (B12, edge case 14): low stock, expiring soon, expired.
 *
 * Every alert is first recorded in STOCK_ALERTS under a period key; the
 * unique index means the same alert in the same period is recorded — and
 * sent — only once, however many times the jobs or dispenses ask:
 *   LOW_STOCK      once per shop + medicine per day   (India date)
 *   EXPIRY_ALERT   once per shop + batch per week     (ISO week)
 *   BATCH_EXPIRED  once per shop + batch
 * The notification goes out through notification.service in the same
 * transaction, so if the caller rolls back, neither the record nor the
 * notification survives. Its dedupeKey repeats the period key for the
 * real notification service's own dedupe.
 */

const { query } = require('../../db/pool');
const notifications = require('../notifications/notification.service');
const thresholds = require('./threshold.service');

const TODAY_SQL = `(now() AT TIME ZONE 'Asia/Kolkata')::date`;

/** Period keys in India time: '2026-11-14' (day) and '2026-W46' (ISO week). */
async function periodKeys(client) {
  const { rows: [r] } = await query(
    `SELECT to_char(${TODAY_SQL}, 'YYYY-MM-DD') AS day, to_char(${TODAY_SQL}, 'IYYY-"W"IW') AS week`,
    [],
    client
  );
  return r;
}

/**
 * Record an alert and notify the shop, unless it was already sent this period.
 * @returns {Promise<{raised: boolean, alertId?: number}>}
 */
async function raise({ type, shopId, medicineId, batchId = null, periodKey, title, body, details = {} }, { client } = {}) {
  const { rows } = await query(
    `INSERT INTO stock_alerts (alert_type, shop_id, medicine_id, batch_id, period_key, details)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (alert_type, shop_id, medicine_id, coalesce(batch_id, 0), period_key) DO NOTHING
     RETURNING id`,
    [type, shopId, medicineId, batchId, periodKey, JSON.stringify(details)],
    client
  );
  if (!rows[0]) return { raised: false };
  await notifications.notifyShop(shopId, {
    channels: ['IN_APP'],
    type,
    title,
    body,
    data: { shopId, medicineId, batchId, ...details },
    dedupeKey: `${type.toLowerCase()}:${shopId}:${batchId ?? medicineId}:${periodKey}`,
  }, { client });
  return { raised: true, alertId: rows[0].id };
}

/**
 * Low-stock check for one shop + medicine (used right after a dispense and
 * by lowStockScan). Does nothing without an active threshold.
 * @returns {Promise<{low: boolean, raised: boolean}>}
 */
async function checkLowStock(shopId, medicineId, { client } = {}) {
  const { rows: [t] } = await query(
    `SELECT t.min_quantity, m.brand_name, m.strength, s.is_active AS shop_active,
            ${thresholds.AVAILABLE_SQL('t.shop_id', 't.medicine_id')} AS available
       FROM stock_thresholds t
       JOIN medicines m ON m.id = t.medicine_id
       JOIN shops s ON s.id = t.shop_id
      WHERE t.shop_id = $1 AND t.medicine_id = $2 AND t.is_active`,
    [shopId, medicineId],
    client
  );
  if (!t || !t.shop_active || t.available >= t.min_quantity) return { low: false, raised: false };
  const { day } = await periodKeys(client);
  const r = await raise({
    type: 'LOW_STOCK',
    shopId,
    medicineId,
    periodKey: day,
    title: `Low stock: ${t.brand_name} ${t.strength}`,
    body: `Only ${t.available} left (reorder level ${t.min_quantity}).`,
    details: { available: t.available, minQuantity: t.min_quantity },
  }, { client });
  return { low: true, raised: r.raised };
}

module.exports = { periodKeys, raise, checkLowStock, TODAY_SQL };
