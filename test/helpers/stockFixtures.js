'use strict';

/**
 * Shared fixtures for stock tests: fresh shops and medicines with random
 * names, so tests are independent and safe to re-run on a dev database.
 */

const crypto = require('node:crypto');
const { pool } = require('../../src/db/pool');
const { withTransaction } = require('../../src/db/transaction');
const medicines = require('../../src/modules/medicines/medicine.service');
const stock = require('../../src/modules/inventory/stock.service');

const uniq = () => crypto.randomBytes(4).toString('hex');
const days = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

async function adminId() {
  return (await pool.query(`SELECT id FROM users WHERE email = 'admin@dosely.dev'`)).rows[0].id;
}

async function newShop() {
  const code = `T-${uniq().toUpperCase()}`;
  const { rows: [s] } = await pool.query(
    `INSERT INTO shops (name, code, drug_licence_no, address, area, city, pincode)
     VALUES ($1, $2, $3, '12 Test Road', 'Testpura', 'Bengaluru', '560001') RETURNING id`,
    [`Test Shop ${code}`, code, `DL-${code}`]
  );
  return s.id;
}

/** Make `userId` staff of `shopId` with the given role. */
async function addStaff(shopId, userId, role = 'STAFF') {
  await pool.query(
    `INSERT INTO shop_staff (shop_id, user_id, staff_role) VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING`,
    [shopId, userId, role]
  );
}

async function newMedicine(extra = {}) {
  return medicines.create({
    brandName: `Pan ${uniq()}`,
    genericName: `Pantoprazole-${uniq()}`,
    manufacturer: 'Alkem',
    dosageForm: 'TABLET',
    strength: '40 mg',
    baseUnit: 'TABLET',
    ...extra,
  });
}

/** Stock-in helper: put `quantity` of batch `batchNo` (expiring in `expiryDays`) into a shop. */
async function putStock(shopId, medicineId, quantity, { batchNo = 'P1', expiryDays = 365, mrp = 9.5, performedBy } = {}) {
  return stock.stockIn({
    shopId, medicineId, batchNo, expiryDate: days(expiryDays), mrp, quantity,
    performedBy: performedBy || (await adminId()),
  });
}

/** Insert a batch that has already expired, with stock, as if received long ago. */
async function putExpiredStock(shopId, medicineId, quantity, { batchNo = 'OLD', expiryDays = -1 } = {}) {
  return withTransaction(async (client) => {
    const { rows: [b] } = await client.query(
      `INSERT INTO medicine_batches (medicine_id, batch_no, expiry_date, mrp) VALUES ($1, $2, $3, 5) RETURNING id`,
      [medicineId, batchNo, days(expiryDays)]
    );
    await client.query(`SELECT set_config('dosely.stock_writer', 'on', true)`);
    await client.query('INSERT INTO inventory (shop_id, batch_id, quantity) VALUES ($1, $2, $3)', [shopId, b.id, quantity]);
    return b.id;
  });
}

async function row(shopId, batchId) {
  const { rows } = await pool.query(
    'SELECT quantity, reserved, version FROM inventory WHERE shop_id = $1 AND batch_id = $2',
    [shopId, batchId]
  );
  return rows[0];
}

async function movements(shopId, type) {
  const { rows } = await pool.query(
    `SELECT type, batch_id, delta, balance_after, reason FROM stock_movements
      WHERE shop_id = $1 ${type ? 'AND type = $2' : ''} ORDER BY id`,
    type ? [shopId, type] : [shopId]
  );
  return rows;
}

module.exports = { uniq, days, adminId, newShop, addStaff, newMedicine, putStock, putExpiredStock, row, movements };
