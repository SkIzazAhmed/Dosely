'use strict';

/**
 * Availability lookup (C6): GET /inventory/availability and availability.service.
 * Needs PostgreSQL; skipped when unreachable. Uses its own medicine and shops,
 * with real stock received through stock.stockIn.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { pool } = require('../src/db/pool');
const migrate = require('../src/db/migrate');
const seeds = require('../src/db/seed');
const stock = require('../src/modules/inventory/stock.service');
const availability = require('../src/modules/inventory/availability.service');
const { createApp } = require('../src/app');

const PASSWORD = process.env.SEED_PASSWORD || 'Dosely@123';
const uniq = () => crypto.randomBytes(4).toString('hex').toUpperCase();
let dbUp = false;
let server;
let base;
let token;
const shops = {};
let medicineId;

async function newShop(name, { lat = null, lon = null, pincode = '560041', area = 'Jayanagar', isActive = true } = {}) {
  const code = `AV-${uniq()}`;
  const { rows: [s] } = await pool.query(
    `INSERT INTO shops (name, code, drug_licence_no, address, area, city, pincode, latitude, longitude)
     VALUES ($1, $2, $3, '1 Test Road', $4, 'Bengaluru', $5, $6, $7) RETURNING id`,
    [`${name} ${code}`, code, `DL-${code}`, area, pincode, lat, lon]
  );
  return s.id;
}

async function putStock(shopId, quantity) {
  const { rows: [u] } = await pool.query(`SELECT id FROM users WHERE email = 'admin@dosely.dev'`);
  await stock.stockIn({
    shopId, medicineId, batchNo: `AV${uniq()}`, expiryDate: '2099-12-31', mrp: 3, quantity, performedBy: u.id,
  });
}

test.before(async () => {
  try {
    await pool.query('SELECT 1');
    dbUp = true;
  } catch (err) {
    console.warn('[availability.test] skipping:', err.message);
    return;
  }
  await migrate.up({ log: () => {} });
  await seeds.run({ log: () => {} });

  const { rows: [g] } = await pool.query(`INSERT INTO generics (name) VALUES ($1) RETURNING id`, [`AvGeneric ${uniq()}`]);
  ({ rows: [{ id: medicineId }] } = await pool.query(
    `INSERT INTO medicines (brand_name, generic_id, manufacturer, dosage_form, strength, base_unit)
     VALUES ($1, $2, 'Lab', 'TABLET', '250 mg', 'TABLET') RETURNING id`,
    [`AvBrand ${uniq()}`, g.id]
  ));

  // Origin in Jayanagar 560041 at (12.9250, 77.5938)
  shops.origin = await newShop('Origin', { lat: 12.925, lon: 77.5938 });
  shops.near = await newShop('Near', { lat: 12.934, lon: 77.5938, pincode: '560011', area: 'Basavanagudi' }); // ~1 km
  shops.far = await newShop('Far', { lat: 13.025, lon: 77.5938, pincode: '560011', area: 'Basavanagudi' }); // ~11 km
  shops.samePin = await newShop('SamePin', { pincode: '560041', area: 'Other' }); // no coords
  shops.sameArea = await newShop('SameArea', { pincode: '560099', area: 'jayanagar ' }); // no coords, area match ignores case
  shops.other = await newShop('Other', { pincode: '560099', area: 'Elsewhere' }); // no coords
  shops.low = await newShop('Low', { lat: 12.926, lon: 77.5938 }); // closest, but too little
  shops.inactive = await newShop('Inactive', { lat: 12.9251, lon: 77.5938 });

  for (const k of ['origin', 'near', 'far', 'samePin', 'sameArea', 'other', 'inactive']) await putStock(shops[k], 20);
  await putStock(shops.low, 3);
  await pool.query('UPDATE shops SET is_active = false WHERE id = $1', [shops.inactive]);

  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'doctor@dosely.dev', password: PASSWORD }),
  });
  token = (await r.json()).token;
});

test.after(async () => {
  if (server) server.close();
  await pool.end();
});

const t = (name, fn) => test(name, async (c) => (dbUp ? fn(c) : c.skip('no database')));

t('distanceKm: haversine in km, null without coordinates', () => {
  const d = availability.distanceKm({ latitude: 12.925, longitude: 77.5938 }, { latitude: 12.934, longitude: 77.5938 });
  assert.ok(d > 0.9 && d < 1.1, String(d));
  assert.equal(availability.distanceKm({ latitude: null }, { latitude: 1, longitude: 1 }), null);
  assert.equal(availability.distanceKm(null, { latitude: 1, longitude: 1 }), null);
});

t('C6: ranked by distance, then same pincode, then same area; origin, inactive and short shops left out', async () => {
  const items = await availability.lookup({ medicineId, minQty: 5, nearShopId: shops.origin });
  assert.deepEqual(
    items.map((i) => i.shop.id),
    [shops.near, shops.far, shops.samePin, shops.sameArea, shops.other]
  );
  const [near, far, samePin, sameArea, other] = items;
  assert.ok(near.distanceKm < far.distanceKm);
  assert.equal(samePin.distanceKm, null);
  assert.equal(samePin.samePincode, true);
  assert.equal(sameArea.sameArea, true);
  assert.equal(other.samePincode || other.sameArea, false);
  assert.equal(near.available, 20);
});

t('C6: min_qty is the need — a shop with less is left out, with enough it is first', async () => {
  const items = await availability.lookup({ medicineId, minQty: 3, nearShopId: shops.origin });
  assert.equal(items[0].shop.id, shops.low);
  assert.equal((await availability.lookup({ medicineId, minQty: 21, nearShopId: shops.origin })).length, 0);
});

t('C6: without an origin shop, most available first; limit applies', async () => {
  const items = await availability.lookup({ medicineId, minQty: 1, limit: 3 });
  assert.equal(items.length, 3);
  assert.ok(items.every((i) => i.distanceKm === null && !i.samePincode));
  assert.ok(items[0].available >= items[2].available);
});

t('GET /inventory/availability validates and returns ranked items', async () => {
  const get = (qs) => fetch(`${base}/inventory/availability?${qs}`, { headers: { authorization: `Bearer ${token}` } });
  const ok = await get(`medicine_id=${medicineId}&min_qty=5&near_shop_id=${shops.origin}&limit=2`);
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.deepEqual(body.items.map((i) => i.shop.id), [shops.near, shops.far]);
  assert.equal((await get('min_qty=5')).status, 400);
  assert.equal((await get(`medicine_id=${medicineId}&min_qty=0`)).status, 400);
  assert.equal((await get('medicine_id=999999999')).status, 404);
  const anon = await fetch(`${base}/inventory/availability?medicine_id=${medicineId}`);
  assert.equal(anon.status, 401);
});
