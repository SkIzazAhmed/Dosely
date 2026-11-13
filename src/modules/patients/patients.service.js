'use strict';

const { query } = require('../../db/pool');
const { AppError, fromPgError } = require('../../shared/errors');

const COLUMNS = 'id, full_name, date_of_birth, gender, created_by, is_active, created_at, updated_at';

function ageFrom(dob) {
  if (!dob) return null;
  const [y, m, d] = dob.split('-').map(Number);
  const now = new Date();
  let age = now.getUTCFullYear() - y;
  if (now.getUTCMonth() + 1 < m || (now.getUTCMonth() + 1 === m && now.getUTCDate() < d)) age -= 1;
  return age;
}

function toPublic(row) {
  if (!row) return null;
  return {
    id: row.id,
    fullName: row.full_name,
    dateOfBirth: row.date_of_birth, // 'YYYY-MM-DD' or null
    age: ageFrom(row.date_of_birth),
    gender: row.gender,
    createdBy: row.created_by,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** input: { fullName, dateOfBirth?, gender? } */
async function create({ fullName, dateOfBirth = null, gender = null }, createdBy, { client } = {}) {
  try {
    const { rows } = await query(
      `INSERT INTO patients (full_name, date_of_birth, gender, created_by) VALUES ($1, $2, $3, $4) RETURNING ${COLUMNS}`,
      [fullName, dateOfBirth, gender, createdBy],
      client
    );
    return toPublic(rows[0]);
  } catch (err) {
    throw fromPgError(err);
  }
}

async function getById(id, { client } = {}) {
  const { rows } = await query(`SELECT ${COLUMNS} FROM patients WHERE id = $1`, [id], client);
  return toPublic(rows[0]);
}

async function getByIdOrThrow(id, opts) {
  const p = await getById(id, opts);
  if (!p) throw AppError.notFound('Patient', id);
  return p;
}

/**
 * For Anushka's requests module: the patient must exist and be active.
 * Returns the patient or throws NOT_FOUND / PATIENT_INACTIVE.
 */
async function assertActive(id, { client } = {}) {
  const p = await getByIdOrThrow(id, { client });
  if (!p.isActive) throw new AppError('PATIENT_INACTIVE', undefined, { patientId: id });
  return p;
}

async function list({ search, phone, isActive, createdBy, limit = 20, offset = 0 } = {}) {
  const where = [];
  const params = [];
  if (isActive !== undefined) { params.push(isActive); where.push(`is_active = $${params.length}`); }
  if (createdBy) { params.push(createdBy); where.push(`created_by = $${params.length}`); }
  if (search) { params.push(`%${search}%`); where.push(`full_name ILIKE $${params.length}`); }
  if (phone) {
    // phone is already normalised to E.164 by the route (edge case 4: compare after normalisation)
    params.push(phone);
    where.push(`EXISTS (SELECT 1 FROM phone_numbers ph WHERE ph.owner_type = 'PATIENT' AND ph.patient_id = patients.id AND ph.e164 = $${params.length} AND ph.is_active)`);
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { rows: [{ total }] } = await query(`SELECT count(*)::int AS total FROM patients ${w}`, params);
  params.push(limit, offset);
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM patients ${w} ORDER BY id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return { items: rows.map(toPublic), total, limit, offset };
}

const COLUMN = { fullName: 'full_name', dateOfBirth: 'date_of_birth', gender: 'gender' };

async function update(id, patch) {
  const sets = [];
  const params = [id];
  for (const [k, col] of Object.entries(COLUMN)) {
    if (patch[k] !== undefined) { params.push(patch[k]); sets.push(`${col} = $${params.length}`); }
  }
  if (sets.length === 0) return getByIdOrThrow(id);
  try {
    const { rows } = await query(`UPDATE patients SET ${sets.join(', ')} WHERE id = $1 RETURNING ${COLUMNS}`, params);
    if (!rows[0]) throw AppError.notFound('Patient', id);
    return toPublic(rows[0]);
  } catch (err) {
    throw fromPgError(err);
  }
}

async function setActive(id, isActive) {
  const { rows } = await query(`UPDATE patients SET is_active = $2 WHERE id = $1 RETURNING ${COLUMNS}`, [id, isActive]);
  if (!rows[0]) throw AppError.notFound('Patient', id);
  return toPublic(rows[0]);
}

module.exports = { toPublic, create, getById, getByIdOrThrow, assertActive, list, update, setActive };
