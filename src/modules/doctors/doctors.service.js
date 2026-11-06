'use strict';

const { query } = require('../../db/pool');
const { AppError, fromPgError } = require('../../shared/errors');

const PG_MAP = {
  doctors_user_id_key: 'DOCTOR_PROFILE_EXISTS',
  doctors_registration_no_key: 'DOCTOR_REG_NO_TAKEN',
};

const SELECT = `
  SELECT d.id, d.user_id, d.registration_no, d.specialization, d.qualification, d.clinic_name,
         d.is_active, d.created_at, d.updated_at,
         u.full_name, u.email, u.is_active AS user_is_active
    FROM doctors d
    JOIN users u ON u.id = d.user_id`;

function toPublic(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    fullName: row.full_name,
    email: row.email,
    registrationNo: row.registration_no,
    specialization: row.specialization,
    qualification: row.qualification,
    clinicName: row.clinic_name,
    canSendRequests: Boolean(row.is_active && row.user_is_active && row.registration_no),
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapError(err) {
  if (err && err.code === 'P0001' && String(err.message).startsWith('DOCTOR_ROLE_REQUIRED')) {
    return new AppError('VALIDATION_ERROR', 'Doctor profiles can only be created for DOCTOR users', [
      { field: 'userId', issue: 'user must have role DOCTOR' },
    ]);
  }
  return fromPgError(err, PG_MAP);
}

async function create(userId, { registrationNo = null, specialization = null, qualification = null, clinicName = null }, { client } = {}) {
  try {
    const { rows: [{ id }] } = await query(
      `INSERT INTO doctors (user_id, registration_no, specialization, qualification, clinic_name)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [userId, registrationNo, specialization, qualification, clinicName],
      client
    );
    return getById(id, { client });
  } catch (err) {
    throw mapError(err);
  }
}

async function getById(id, { client } = {}) {
  const { rows } = await query(`${SELECT} WHERE d.id = $1`, [id], client);
  return toPublic(rows[0]);
}

async function getByIdOrThrow(id, opts) {
  const d = await getById(id, opts);
  if (!d) throw AppError.notFound('Doctor', id);
  return d;
}

async function getByUserId(userId, { client } = {}) {
  const { rows } = await query(`${SELECT} WHERE d.user_id = $1`, [userId], client);
  return toPublic(rows[0]);
}

async function list({ search, isActive, limit = 20, offset = 0 } = {}) {
  const where = [];
  const params = [];
  if (isActive !== undefined) { params.push(isActive); where.push(`d.is_active = $${params.length}`); }
  if (search) {
    params.push(`%${search}%`);
    where.push(`(u.full_name ILIKE $${params.length} OR d.registration_no ILIKE $${params.length} OR d.specialization ILIKE $${params.length})`);
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { rows: [{ total }] } = await query(
    `SELECT count(*)::int AS total FROM doctors d JOIN users u ON u.id = d.user_id ${w}`,
    params
  );
  params.push(limit, offset);
  const { rows } = await query(`${SELECT} ${w} ORDER BY d.id LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  return { items: rows.map(toPublic), total, limit, offset };
}

const COLUMN = { registrationNo: 'registration_no', specialization: 'specialization', qualification: 'qualification', clinicName: 'clinic_name' };

async function update(id, patch, { client } = {}) {
  const sets = [];
  const params = [id];
  for (const [k, col] of Object.entries(COLUMN)) {
    if (patch[k] !== undefined) { params.push(patch[k]); sets.push(`${col} = $${params.length}`); }
  }
  if (sets.length === 0) return getByIdOrThrow(id, { client });
  try {
    const { rowCount } = await query(`UPDATE doctors SET ${sets.join(', ')} WHERE id = $1`, params, client);
    if (!rowCount) throw AppError.notFound('Doctor', id);
    return getById(id, { client });
  } catch (err) {
    throw mapError(err);
  }
}

async function setActive(id, isActive, { client } = {}) {
  const { rowCount } = await query('UPDATE doctors SET is_active = $2 WHERE id = $1', [id, isActive], client);
  if (!rowCount) throw AppError.notFound('Doctor', id);
  return getById(id, { client });
}

/**
 * For Anushka's request module (A5): call before a doctor sends a request.
 * Returns the doctor profile, or throws:
 *   FORBIDDEN               user is not a DOCTOR / has no active profile
 *   DOCTOR_REG_NO_REQUIRED  profile has no registration number
 */
async function assertCanSendRequests(userId, { client } = {}) {
  const doctor = await getByUserId(userId, { client });
  if (!doctor || !doctor.isActive) throw new AppError('FORBIDDEN', 'An active doctor profile is required to send requests');
  if (!doctor.registrationNo) throw new AppError('DOCTOR_REG_NO_REQUIRED');
  return doctor;
}

module.exports = { toPublic, create, getById, getByIdOrThrow, getByUserId, list, update, setActive, assertCanSendRequests };
