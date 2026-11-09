'use strict';

/**
 * Demo shops, staff and patients (Commit 3). Runs after 001_demo_users.js.
 * Idempotent: shops are matched by code, staff by (shop, user), patients by
 * (name, date of birth) — running `npm run seed` again adds nothing.
 *
 * Shops (all in Bengaluru, so distance/area lookups have something to work with):
 *   DSL-JAY-01  Jayanagar     OWNER shopkeeper@  STAFF staff@
 *   DSL-KOR-02  Koramangala   OWNER owner.kor@
 *   DSL-IND-03  Indiranagar   OWNER owner.ind@   (no coordinates)
 *   DSL-WHF-04  Whitefield    OWNER owner.kor@   INACTIVE — can't receive requests
 */

const { hashPassword } = require('../../shared/password');

const EXTRA_SHOPKEEPERS = [
  { fullName: 'Kiran Rao', email: 'owner.kor@dosely.dev' },
  { fullName: 'Farah Khan', email: 'owner.ind@dosely.dev' },
];

const SHOPS = [
  {
    name: 'Jayanagar Health Pharmacy', code: 'DSL-JAY-01', drugLicenceNo: 'KA-BNG-20B-100101',
    address: '12, 11th Main Road, 4th Block', area: 'Jayanagar', city: 'Bengaluru', pincode: '560011',
    latitude: 12.925007, longitude: 77.593803, isActive: true,
    staff: [['shopkeeper@dosely.dev', 'OWNER'], ['staff@dosely.dev', 'STAFF']],
  },
  {
    name: 'Koramangala MedPlus Point', code: 'DSL-KOR-02', drugLicenceNo: 'KA-BNG-20B-100202',
    address: '80 Feet Road, 6th Block', area: 'Koramangala', city: 'Bengaluru', pincode: '560095',
    latitude: 12.935242, longitude: 77.624480, isActive: true,
    staff: [['owner.kor@dosely.dev', 'OWNER']],
  },
  {
    name: 'Indiranagar Care Chemists', code: 'DSL-IND-03', drugLicenceNo: 'KA-BNG-20B-100303',
    address: '100 Feet Road, HAL 2nd Stage', area: 'Indiranagar', city: 'Bengaluru', pincode: '560038',
    latitude: null, longitude: null, isActive: true,
    staff: [['owner.ind@dosely.dev', 'OWNER']],
  },
  {
    name: 'Whitefield Night Pharmacy', code: 'DSL-WHF-04', drugLicenceNo: 'KA-BNG-20B-100404',
    address: 'ITPL Main Road, near Hope Farm', area: 'Whitefield', city: 'Bengaluru', pincode: '560066',
    latitude: 12.969800, longitude: 77.749900, isActive: false,
    staff: [['owner.kor@dosely.dev', 'OWNER']],
  },
];

// Created by the demo doctor. Some have no DOB/gender (both optional, A8).
// Phone numbers come in Commit 4; Meera Pillai stays phone-less for edge case 10.
const PATIENTS = [
  { fullName: 'Arjun Mehta', dateOfBirth: '1988-03-14', gender: 'MALE' },
  { fullName: 'Priya Nair', dateOfBirth: '1995-07-02', gender: 'FEMALE' },
  { fullName: 'Rohan Das', dateOfBirth: '2016-11-20', gender: 'MALE' },
  { fullName: 'Lakshmi Iyer', dateOfBirth: '1951-01-30', gender: 'FEMALE' },
  { fullName: 'Sam Thomas', dateOfBirth: null, gender: null },
  { fullName: 'Meera Pillai', dateOfBirth: '1979-09-09', gender: 'UNDISCLOSED' },
];

async function userId(client, email) {
  const { rows } = await client.query('SELECT id FROM users WHERE lower(email) = lower($1)', [email]);
  if (!rows[0]) throw new Error(`seed 002: user ${email} missing — run 001_demo_users first`);
  return rows[0].id;
}

async function seed(client) {
  const hash = await hashPassword(process.env.SEED_PASSWORD || 'Dosely@123');
  for (const u of EXTRA_SHOPKEEPERS) {
    await client.query(
      `INSERT INTO users (role, full_name, email, password_hash)
       SELECT 'SHOPKEEPER', $1, $2, $3
        WHERE NOT EXISTS (SELECT 1 FROM users WHERE lower(email) = lower($2))`,
      [u.fullName, u.email, hash]
    );
  }

  for (const s of SHOPS) {
    let { rows: [shop] } = await client.query('SELECT id FROM shops WHERE code = $1', [s.code]);
    if (!shop) {
      ({ rows: [shop] } = await client.query(
        `INSERT INTO shops (name, code, drug_licence_no, address, area, city, pincode, latitude, longitude, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [s.name, s.code, s.drugLicenceNo, s.address, s.area, s.city, s.pincode, s.latitude, s.longitude, s.isActive]
      ));
    }
    for (const [email, role] of s.staff) {
      const uid = await userId(client, email);
      await client.query(
        `INSERT INTO shop_staff (shop_id, user_id, staff_role, added_by) VALUES ($1, $2, $3, $2)
         ON CONFLICT (shop_id, user_id) DO NOTHING`,
        [shop.id, uid, role]
      );
    }
  }

  const doctorId = await userId(client, 'doctor@dosely.dev');
  for (const p of PATIENTS) {
    await client.query(
      `INSERT INTO patients (full_name, date_of_birth, gender, created_by)
       SELECT $1, $2::date, $3::gender, $4
        WHERE NOT EXISTS (
          SELECT 1 FROM patients WHERE full_name = $1 AND date_of_birth IS NOT DISTINCT FROM $2::date)`,
      [p.fullName, p.dateOfBirth, p.gender, doctorId]
    );
  }
}

module.exports = { seed, SHOPS, PATIENTS, EXTRA_SHOPKEEPERS };
