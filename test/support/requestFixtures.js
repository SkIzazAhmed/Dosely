'use strict';

/**
 * Shared setup for the requests/referrals integration and edge-case tests.
 * Everything is real: migrations, seed users, shops, staff, patients and
 * phones, stock (stockIn / reserve / release / dispense) and notifications.
 * Each suite gets its own medicine, shops and shopkeepers, so suites don't
 * see each other's stock.
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { pool } = require('../../src/db/pool');
const migrate = require('../../src/db/migrate');
const seeds = require('../../src/db/seed');
const stock = require('../../src/modules/inventory/stock.service');
const phones = require('../../src/modules/phones/phones.service');
const { hashPassword } = require('../../src/shared/password');
const { createApp } = require('../../src/app');

const PASSWORD = process.env.SEED_PASSWORD || 'Dosely@123';
const uniq = () => crypto.randomBytes(4).toString('hex').toUpperCase();

async function dbReachable() {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

/**
 * Start the app and build a world: one medicine, a doctor token, and helpers.
 * @returns {Promise<Object>} world
 */
async function setup(label) {
  await migrate.up({ log: () => {} });
  await seeds.run({ log: () => {} });

  const server = createApp().listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;

  async function api(method, path, { token, body, key, accept } = {}) {
    const headers = { 'content-type': 'application/json', 'idempotency-key': key ?? crypto.randomUUID() };
    if (token) headers.authorization = `Bearer ${token}`;
    if (accept) headers.accept = accept;
    const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let parsed = text;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* text/plain */ }
    return { status: res.status, body: parsed, headers: res.headers };
  }

  async function login(email) {
    const r = await api('POST', '/auth/login', { body: { email, password: PASSWORD } });
    assert.equal(r.status, 200, `login ${email}: ${JSON.stringify(r.body)}`);
    return r.body.token;
  }

  async function staff(name) {
    const email = `${label}.${name}.${uniq().toLowerCase()}@dosely.test`;
    const { rows: [u] } = await pool.query(
      `INSERT INTO users (role, full_name, email, password_hash) VALUES ('SHOPKEEPER', $1, $2, $3) RETURNING id`,
      [`${label} ${name}`, email, await hashPassword(PASSWORD)]
    );
    return { id: u.id, email, token: await login(email) };
  }

  async function shop(staffUser, { name = 'Shop', lat = null, lon = null, pincode = '560041', area = 'Jayanagar' } = {}) {
    const code = `${label.slice(0, 2).toUpperCase()}-${uniq()}`;
    const { rows: [s] } = await pool.query(
      `INSERT INTO shops (name, code, drug_licence_no, address, area, city, pincode, latitude, longitude)
       VALUES ($1, $2, $3, '12 Test Main Road', $4, 'Bengaluru', $5, $6, $7) RETURNING id, name`,
      [`${name} ${code}`, code, `DL-${code}`, area, pincode, lat, lon]
    );
    if (staffUser) {
      await pool.query(`INSERT INTO shop_staff (shop_id, user_id, staff_role) VALUES ($1, $2, 'STAFF')`, [s.id, staffUser.id]);
    }
    return s.id;
  }

  const { rows: [g] } = await pool.query(`INSERT INTO generics (name) VALUES ($1) RETURNING id`, [`${label} generic ${uniq()}`]);
  const { rows: [m] } = await pool.query(
    `INSERT INTO medicines (brand_name, generic_id, manufacturer, dosage_form, strength, base_unit)
     VALUES ($1, $2, 'Test Labs', 'TABLET', '500 mg', 'TABLET') RETURNING id`,
    [`${label} brand ${uniq()}`, g.id]
  );
  const medicineId = m.id;
  const { rows: [admin] } = await pool.query(`SELECT id FROM users WHERE email = 'admin@dosely.dev'`);

  async function putStock(shopId, quantity, { expiryDate = '2099-12-31', medicine = medicineId } = {}) {
    return stock.stockIn({
      shopId, medicineId: medicine, batchNo: `${label.slice(0, 3).toUpperCase()}${uniq()}`, expiryDate, mrp: 4.5,
      quantity, performedBy: admin.id,
    });
  }

  const available = async (shopId, medicine = medicineId) =>
    (await stock.getAvailable(medicine, { shopIds: [shopId] })).reduce((n, r) => n + r.available, 0);

  /** On-hand (quantity) and reserved units of the medicine at a shop, straight from inventory. */
  async function onHand(shopId) {
    const { rows: [r] } = await pool.query(
      `SELECT coalesce(sum(i.quantity), 0)::int AS quantity, coalesce(sum(i.reserved), 0)::int AS reserved
         FROM inventory i JOIN medicine_batches b ON b.id = i.batch_id
        WHERE i.shop_id = $1 AND b.medicine_id = $2`,
      [shopId, medicineId]
    );
    return r;
  }

  async function patient(phone, { verified = true } = {}) {
    const { rows: [p] } = await pool.query(`INSERT INTO patients (full_name) VALUES ($1) RETURNING id`, [`${label} patient ${uniq()}`]);
    if (phone) await phones.add('PATIENT', p.id, { number: phone }, { verified, verifiedBy: verified ? admin.id : null });
    return p.id;
  }

  const doctor = await login('doctor@dosely.dev');

  return {
    server, base, api, login, staff, shop, putStock, available, onHand, patient, medicineId, doctor, adminId: admin.id,
    close: () => server.close(),
  };
}

module.exports = { setup, dbReachable, uniq, pool };
