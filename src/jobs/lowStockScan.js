'use strict';

/**
 * lowStockScan — daily job (B12, edge case 14).
 *
 * For every active threshold at an active shop whose medicine has fewer
 * non-expired, unreserved units than min_quantity, alert the shop — at most
 * once per shop + medicine per day. A dispense that drops stock below the
 * threshold alerts straight away (stock.service), and this scan then sends
 * nothing more that day.
 *
 * Run by hand: npm run job:low-stock
 */

const { withTransaction } = require('../db/transaction');
const alerts = require('../modules/inventory/alert.service');
const thresholds = require('../modules/inventory/threshold.service');

async function run({ log = console.log } = {}) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT x.shop_id, x.medicine_id FROM (
         SELECT t.shop_id, t.medicine_id, t.min_quantity,
                ${thresholds.AVAILABLE_SQL('t.shop_id', 't.medicine_id')} AS available
           FROM stock_thresholds t
           JOIN shops s ON s.id = t.shop_id AND s.is_active
           JOIN medicines m ON m.id = t.medicine_id AND m.is_active
          WHERE t.is_active
       ) x
       WHERE x.available < x.min_quantity
       ORDER BY x.shop_id, x.medicine_id`
    );
    const summary = { low: rows.length, alerts: 0 };
    for (const r of rows) {
      const { raised } = await alerts.checkLowStock(r.shop_id, r.medicine_id, { client });
      if (raised) summary.alerts += 1;
    }
    log(`[lowStockScan] ${JSON.stringify(summary)}`);
    return summary;
  });
}

module.exports = { run };

if (require.main === module) {
  const { pool } = require('../db/pool');
  run()
    .then(() => pool.end())
    .catch((err) => {
      console.error('[lowStockScan] failed:', err);
      pool.end().finally(() => process.exit(1));
    });
}
