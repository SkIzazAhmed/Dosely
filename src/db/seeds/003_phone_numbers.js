'use strict';

/**
 * Demo phone numbers (Commit 4). Runs after 001 and 002. Idempotent: an
 * owner's number is only inserted if that owner doesn't already have it.
 * Numbers are made up; the +91 98100 / 99000 ranges are just for the demo.
 *
 *   Users     doctor@, shopkeeper@, staff@, owner.kor@, owner.ind@ — verified mobiles
 *             (log in with { phone, password })
 *   Shops     DSL-JAY-01 landline (SHOP) + mobile; DSL-KOR-02 mobile
 *   Patients  Arjun, Priya — verified mobiles
 *             Rohan Das — shares Priya's number (P5: families share phones)
 *             Lakshmi Iyer — HOME landline (primary) + verified mobile
 *             Sam Thomas — UNVERIFIED mobile (edge case 9: no SMS until verified)
 *             Meera Pillai — no phone at all (edge case 10)
 */

const ADMIN_EMAIL = 'admin@dosely.dev';

const USER_PHONES = [
  ['doctor@dosely.dev', '+919900000001'],
  ['shopkeeper@dosely.dev', '+919900000002'],
  ['staff@dosely.dev', '+919900000003'],
  ['owner.kor@dosely.dev', '+919900000004'],
  ['owner.ind@dosely.dev', '+919900000005'],
];

const SHOP_PHONES = [
  ['DSL-JAY-01', '+918026630000', 'LANDLINE', 'SHOP', true],
  ['DSL-JAY-01', '+919810000201', 'MOBILE', 'MOBILE', true],
  ['DSL-KOR-02', '+919810000202', 'MOBILE', 'SHOP', true],
];

// [patient name, e164, kind, label, verified]
const PATIENT_PHONES = [
  ['Arjun Mehta', '+919810000101', 'MOBILE', 'MOBILE', true],
  ['Priya Nair', '+919810000102', 'MOBILE', 'MOBILE', true],
  ['Rohan Das', '+919810000102', 'MOBILE', 'MOBILE', true],
  ['Lakshmi Iyer', '+918022334455', 'LANDLINE', 'HOME', true],
  ['Lakshmi Iyer', '+919810000104', 'MOBILE', 'MOBILE', true],
  ['Sam Thomas', '+919810000105', 'MOBILE', 'MOBILE', false],
];

async function one(client, sql, params, what) {
  const { rows } = await client.query(sql, params);
  if (!rows[0]) throw new Error(`seed 003: ${what} missing — run earlier seeds first`);
  return rows[0].id;
}

async function addPhone(client, ownerType, column, ownerId, e164, kind, label, verified, adminId) {
  const { rows: [{ n }] } = await client.query(
    `SELECT count(*)::int AS n FROM phone_numbers WHERE owner_type = $1 AND owner_id = $2 AND is_active`,
    [ownerType, ownerId]
  );
  await client.query(
    `INSERT INTO phone_numbers (owner_type, ${column}, e164, kind, label, is_primary, status, verified_at, verified_by)
     SELECT $1, $2, $3, $4::phone_type, $5::phone_label, $6, $7::phone_status, $8::timestamptz, $9
      WHERE NOT EXISTS (
        SELECT 1 FROM phone_numbers WHERE owner_type = $1 AND owner_id = $2 AND e164 = $3 AND is_active)`,
    [ownerType, ownerId, e164, kind, label, n === 0, verified ? 'VERIFIED' : 'UNVERIFIED',
      verified ? new Date().toISOString() : null, verified ? adminId : null]
  );
}

async function seed(client) {
  const adminId = await one(client, 'SELECT id FROM users WHERE email = $1', [ADMIN_EMAIL], ADMIN_EMAIL);

  for (const [email, e164] of USER_PHONES) {
    const id = await one(client, 'SELECT id FROM users WHERE lower(email) = lower($1)', [email], email);
    await addPhone(client, 'USER', 'user_id', id, e164, 'MOBILE', 'MOBILE', true, adminId);
  }
  for (const [code, e164, kind, label, verified] of SHOP_PHONES) {
    const id = await one(client, 'SELECT id FROM shops WHERE code = $1', [code], code);
    await addPhone(client, 'SHOP', 'shop_id', id, e164, kind, label, verified, adminId);
  }
  for (const [name, e164, kind, label, verified] of PATIENT_PHONES) {
    const id = await one(client, 'SELECT id FROM patients WHERE full_name = $1 ORDER BY id LIMIT 1', [name], name);
    await addPhone(client, 'PATIENT', 'patient_id', id, e164, kind, label, verified, adminId);
  }
}

module.exports = { seed, USER_PHONES, SHOP_PHONES, PATIENT_PHONES };
