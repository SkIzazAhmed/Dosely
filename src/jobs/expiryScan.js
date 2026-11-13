'use strict';

/**
 * expiryScan — daily job (B12, edge case 3).
 *
 * 1. EXPIRY_ALERT: for every active shop holding units of a batch that
 *    expires within `withinDays` (default 90), alert the shop — at most once
 *    per shop + batch per week.
 * 2. Expired batches: flag each newly expired batch (medicine_batches.
 *    expired_flagged_at) and tell every shop still holding units to write
 *    them off — once per shop + batch. Expired stock is already excluded from
 *    dispense, reserve and availability; this makes sure someone clears it.
 *
 * Run by hand: npm run job:expiry
 */

const { withTransaction } = require('../db/transaction');
const alerts = require('../modules/inventory/alert.service');

const TODAY = alerts.TODAY_SQL;

async function run({ withinDays = 90, log = console.log } = {}) {
  return withTransaction(async (client) => {
    const { week } = await alerts.periodKeys(client);
    const summary = { expiringRows: 0, expiryAlerts: 0, newlyExpiredBatches: 0, expiredRows: 0, expiredAlerts: 0 };

    // 1. expiring soon
    const { rows: soon } = await client.query(
      `SELECT i.shop_id, b.id AS batch_id, b.medicine_id, b.batch_no, b.expiry_date::text AS expiry_date,
              (b.expiry_date - ${TODAY}) AS days_left, i.quantity, m.brand_name, m.strength
         FROM inventory i
         JOIN medicine_batches b ON b.id = i.batch_id
         JOIN medicines m ON m.id = b.medicine_id
         JOIN shops s ON s.id = i.shop_id AND s.is_active
        WHERE i.quantity > 0 AND i.is_active
          AND b.expiry_date > ${TODAY} AND b.expiry_date <= ${TODAY} + $1::int
        ORDER BY i.shop_id, b.expiry_date, b.id`,
      [withinDays]
    );
    summary.expiringRows = soon.length;
    for (const r of soon) {
      const { raised } = await alerts.raise({
        type: 'EXPIRY_ALERT',
        shopId: r.shop_id,
        medicineId: r.medicine_id,
        batchId: r.batch_id,
        periodKey: week,
        title: `Expiring in ${r.days_left} days: ${r.brand_name} ${r.strength}`,
        body: `Batch ${r.batch_no} (${r.quantity} units) expires on ${r.expiry_date}.`,
        details: { batchNo: r.batch_no, expiryDate: r.expiry_date, daysLeft: r.days_left, quantity: r.quantity },
      }, { client });
      if (raised) summary.expiryAlerts += 1;
    }

    // 2. expired: flag batches, then ask shops holding units to write them off
    const { rowCount } = await client.query(
      `UPDATE medicine_batches SET expired_flagged_at = now()
        WHERE expiry_date <= ${TODAY} AND expired_flagged_at IS NULL`
    );
    summary.newlyExpiredBatches = rowCount;

    const { rows: expired } = await client.query(
      `SELECT i.shop_id, b.id AS batch_id, b.medicine_id, b.batch_no, b.expiry_date::text AS expiry_date,
              i.quantity, m.brand_name, m.strength
         FROM inventory i
         JOIN medicine_batches b ON b.id = i.batch_id
         JOIN medicines m ON m.id = b.medicine_id
         JOIN shops s ON s.id = i.shop_id AND s.is_active
        WHERE i.quantity > 0 AND i.is_active AND b.expiry_date <= ${TODAY}
        ORDER BY i.shop_id, b.id`
    );
    summary.expiredRows = expired.length;
    for (const r of expired) {
      const { raised } = await alerts.raise({
        type: 'BATCH_EXPIRED',
        shopId: r.shop_id,
        medicineId: r.medicine_id,
        batchId: r.batch_id,
        periodKey: 'once',
        title: `Expired: ${r.brand_name} ${r.strength}`,
        body: `Batch ${r.batch_no} expired on ${r.expiry_date}; ${r.quantity} units can't be sold. Write them off.`,
        details: { batchNo: r.batch_no, expiryDate: r.expiry_date, quantity: r.quantity },
      }, { client });
      if (raised) summary.expiredAlerts += 1;
    }

    log(`[expiryScan] ${JSON.stringify(summary)}`);
    return summary;
  });
}

module.exports = { run };

if (require.main === module) {
  const { pool } = require('../db/pool');
  run()
    .then(() => pool.end())
    .catch((err) => {
      console.error('[expiryScan] failed:', err);
      pool.end().finally(() => process.exit(1));
    });
}
