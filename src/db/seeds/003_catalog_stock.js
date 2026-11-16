'use strict';

/**
 * Demo catalog and stock (Rachana, Commit 6). Runs after 002_shops_staff_patients.js.
 * Idempotent: generics and medicines are matched by their unique keys, and
 * every stock-in carries an idempotency key, so `npm run seed` again adds nothing.
 *
 * Stock goes in through stock.service.stockIn (the only writer of stock), so
 * every unit has a STOCK_IN movement behind it.
 *
 * What the demo shows:
 *   - several batches per medicine, so dispense is visibly earliest-expiry first
 *   - batches expiring within 90 days (expiryScan alerts), at Jayanagar and Koramangala
 *   - thresholds where Dolo 650 and Azithral 500 are low at Jayanagar
 * Batches whose expiry date has passed by the time you seed are skipped.
 */

const stock = require('../../modules/inventory/stock.service');

const MEDICINES = [
  // [brand, generic, manufacturer, form, strength, baseUnit, prescriptionRequired]
  ['Dolo 650', 'Paracetamol', 'Micro Labs', 'TABLET', '650 mg', 'TABLET', false],
  ['Crocin Advance', 'Paracetamol', 'GSK', 'TABLET', '500 mg', 'TABLET', false],
  ['Azithral 500', 'Azithromycin', 'Alembic', 'TABLET', '500 mg', 'TABLET', true],
  ['Augmentin 625 Duo', 'Amoxicillin + Clavulanic Acid', 'GSK', 'TABLET', '625 mg', 'TABLET', true],
  ['Pan 40', 'Pantoprazole', 'Alkem', 'TABLET', '40 mg', 'TABLET', true],
  ['Glycomet 500', 'Metformin', 'USV', 'TABLET', '500 mg', 'TABLET', true],
  ['Telma 40', 'Telmisartan', 'Glenmark', 'TABLET', '40 mg', 'TABLET', true],
  ['Allegra 120', 'Fexofenadine', 'Sanofi', 'TABLET', '120 mg', 'TABLET', true],
  ['Thyronorm 50', 'Levothyroxine', 'Abbott', 'TABLET', '50 mcg', 'TABLET', true],
  ['Ascoril LS', 'Ambroxol + Levosalbutamol + Guaifenesin', 'Glenmark', 'SYRUP', '100 ml', 'BOTTLE', true],
];

// [shop code, brand, batch no, manufacture date, expiry date, MRP per base unit (INR), quantity]
const STOCK = [
  ['DSL-JAY-01', 'Dolo 650', 'DL26A11', '2026-01-10', '2027-01-31', 2.04, 40],
  ['DSL-JAY-01', 'Dolo 650', 'DL26F07', '2026-06-02', '2028-05-31', 2.04, 20],
  ['DSL-JAY-01', 'Crocin Advance', 'CA26C03', '2026-03-15', '2029-02-28', 1.86, 150],
  ['DSL-JAY-01', 'Azithral 500', 'AZ26B20', '2026-02-20', '2028-01-31', 23.57, 15],
  ['DSL-JAY-01', 'Augmentin 625 Duo', 'AU26D14', '2026-04-14', '2027-03-31', 22.38, 42],
  ['DSL-JAY-01', 'Pan 40', 'PN26E02', '2026-05-02', '2028-04-30', 15.52, 120],
  ['DSL-JAY-01', 'Glycomet 500', 'GM26A30', '2026-01-30', '2028-12-31', 2.13, 300],
  ['DSL-JAY-01', 'Telma 40', 'TL25K18', '2025-11-18', '2026-12-31', 10.42, 30],
  ['DSL-JAY-01', 'Telma 40', 'TL26G09', '2026-07-09', '2029-06-30', 10.42, 90],
  ['DSL-JAY-01', 'Thyronorm 50', 'TN26B11', '2026-02-11', '2027-11-30', 1.74, 200],
  ['DSL-JAY-01', 'Ascoril LS', 'AS26C27', '2026-03-27', '2028-02-29', 128.0, 12],

  ['DSL-KOR-02', 'Dolo 650', 'DL26F07', '2026-06-02', '2028-05-31', 2.04, 200],
  ['DSL-KOR-02', 'Azithral 500', 'AZ26B20', '2026-02-20', '2028-01-31', 23.57, 60],
  ['DSL-KOR-02', 'Allegra 120', 'AL25L05', '2025-12-05', '2027-01-15', 21.9, 30],
  ['DSL-KOR-02', 'Pan 40', 'PN26E02', '2026-05-02', '2028-04-30', 15.52, 45],
  ['DSL-KOR-02', 'Augmentin 625 Duo', 'AU26D14', '2026-04-14', '2027-03-31', 22.38, 20],

  ['DSL-IND-03', 'Dolo 650', 'DL26A11', '2026-01-10', '2027-01-31', 2.04, 80],
  ['DSL-IND-03', 'Crocin Advance', 'CA26C03', '2026-03-15', '2029-02-28', 1.86, 60],
  ['DSL-IND-03', 'Glycomet 500', 'GM26A30', '2026-01-30', '2028-12-31', 2.13, 100],
];

// [shop code, brand, min quantity]
const THRESHOLDS = [
  ['DSL-JAY-01', 'Dolo 650', 100], // 60 in stock → low
  ['DSL-JAY-01', 'Azithral 500', 20], // 15 in stock → low
  ['DSL-JAY-01', 'Pan 40', 30],
  ['DSL-JAY-01', 'Glycomet 500', 50],
  ['DSL-KOR-02', 'Dolo 650', 50],
  ['DSL-KOR-02', 'Allegra 120', 10],
];

async function seed(client) {
  const { rows: [admin] } = await client.query(`SELECT id FROM users WHERE email = 'admin@dosely.dev'`);
  if (!admin) throw new Error('003_catalog_stock needs the admin user from 001_demo_users');

  const genericIds = new Map();
  for (const name of new Set(MEDICINES.map((m) => m[1]))) {
    await client.query(
      `INSERT INTO generics (name) VALUES ($1) ON CONFLICT (lower(btrim(name))) DO NOTHING`,
      [name]
    );
    const { rows: [g] } = await client.query('SELECT id FROM generics WHERE lower(btrim(name)) = lower($1)', [name]);
    genericIds.set(name, g.id);
  }

  const medicineIds = new Map();
  for (const [brand, generic, manufacturer, form, strength, unit, rx] of MEDICINES) {
    await client.query(
      `INSERT INTO medicines (brand_name, generic_id, manufacturer, dosage_form, strength, base_unit, prescription_required)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (lower(btrim(brand_name)), lower(btrim(manufacturer)), dosage_form,
                    lower(regexp_replace(strength, '\\s+', '', 'g'))) DO NOTHING`,
      [brand, genericIds.get(generic), manufacturer, form, strength, unit, rx]
    );
    const { rows: [m] } = await client.query(
      `SELECT id FROM medicines WHERE lower(brand_name) = lower($1) AND lower(manufacturer) = lower($2)`,
      [brand, manufacturer]
    );
    medicineIds.set(brand, m.id);
  }

  const shopIds = new Map();
  const { rows: shops } = await client.query(`SELECT id, code FROM shops WHERE code = ANY($1)`, [[...new Set(STOCK.map((s) => s[0]))]]);
  for (const s of shops) shopIds.set(s.code, s.id);

  let received = 0;
  let skipped = 0;
  for (const [code, brand, batchNo, mfg, expiry, mrp, quantity] of STOCK) {
    if (!shopIds.has(code)) { skipped += 1; continue; }
    try {
      const r = await stock.stockIn({
        shopId: shopIds.get(code),
        medicineId: medicineIds.get(brand),
        batchNo,
        manufactureDate: mfg,
        expiryDate: expiry,
        mrp,
        quantity,
        performedBy: admin.id,
        reason: 'Demo seed: opening stock',
        idempotencyKey: `seed:${code}:${batchNo}`,
      }, { client });
      if (!r.replayed) received += 1;
    } catch (err) {
      if (err.code !== 'BATCH_EXPIRED') throw err;
      skipped += 1; // the demo date has passed; nothing to receive
    }
  }

  for (const [code, brand, min] of THRESHOLDS) {
    if (!shopIds.has(code)) continue;
    await client.query(
      `INSERT INTO stock_thresholds (shop_id, medicine_id, min_quantity, set_by)
       VALUES ($1, $2, $3, $4) ON CONFLICT (shop_id, medicine_id) DO NOTHING`,
      [shopIds.get(code), medicineIds.get(brand), min, admin.id]
    );
  }

  return { medicines: medicineIds.size, stockIns: received, skipped };
}

module.exports = { seed };
