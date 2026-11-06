'use strict';

/**
 * Demo logins (Commit 2). Safe to run again: existing emails are skipped.
 * Password for all demo users: SEED_PASSWORD from .env, default "Dosely@123".
 * Shops, staff and patients are seeded in Commit 3 (Nov 8).
 */

const { hashPassword } = require('../../shared/password');

const DEMO_USERS = [
  { role: 'ADMIN', fullName: 'Demo Admin', email: 'admin@dosely.dev' },
  {
    role: 'DOCTOR', fullName: 'Dr. Ananya Rao', email: 'doctor@dosely.dev',
    doctor: { registrationNo: 'KMC-100245', specialization: 'General Medicine', qualification: 'MBBS, MD', clinicName: 'Rao Clinic' },
  },
  {
    // A doctor without a registration number: can log in, cannot send requests (A5)
    role: 'DOCTOR', fullName: 'Dr. Vikram Shah', email: 'doctor.noreg@dosely.dev',
    doctor: { registrationNo: null, specialization: 'Paediatrics', qualification: 'MBBS', clinicName: null },
  },
  { role: 'SHOPKEEPER', fullName: 'Ravi Kumar', email: 'shopkeeper@dosely.dev' },
  { role: 'SHOPKEEPER', fullName: 'Meena Iyer', email: 'staff@dosely.dev' },
];

async function seed(client) {
  const password = process.env.SEED_PASSWORD || 'Dosely@123';
  const hash = await hashPassword(password);

  for (const u of DEMO_USERS) {
    let { rows: [user] } = await client.query('SELECT id FROM users WHERE lower(email) = lower($1)', [u.email]);
    if (!user) {
      ({ rows: [user] } = await client.query(
        'INSERT INTO users (role, full_name, email, password_hash) VALUES ($1, $2, $3, $4) RETURNING id',
        [u.role, u.fullName, u.email, hash]
      ));
    }
    if (u.doctor) {
      await client.query(
        `INSERT INTO doctors (user_id, registration_no, specialization, qualification, clinic_name)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (user_id) DO NOTHING`,
        [user.id, u.doctor.registrationNo, u.doctor.specialization, u.doctor.qualification, u.doctor.clinicName]
      );
    }
  }
}

module.exports = { seed, DEMO_USERS };
